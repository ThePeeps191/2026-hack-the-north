import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import type {
  BrowserActionInput,
  BrowserActionResult,
  BrowserHost,
  BrowserHostDeps,
  BrowserObservation,
  CreateBrowserHost,
  NetworkCapture
} from '../contracts.ts'
import type { PreviewInfo, ScreenshotResult } from '../../shared/api.ts'
import type { BrowserSessionRecord } from '../../shared/types.ts'
import { HuddleError } from '../huddle-error.ts'
import { clientFor, originLabel, peekCredentials, requireCredentials } from './credentials.ts'
import { asNumber, asRecord, asString, delay, messageOf, oneLine, shortId } from './narrow.ts'
import { NetworkRecorder } from './network.ts'
import { LiveSession, type RemoteRelease } from './session.ts'
import { checkRemoteTarget, describePreviewReachability } from './targets.ts'

/**
 * The browser host: real Browserbase sessions driven by Playwright over CDP.
 *
 * Rules this file exists to keep:
 *  - A session record is only ever `live` when a real remote browser is attached
 *    to it. Missing credentials or an unreachable preview refuse the attempt with
 *    a concrete fix instead of producing a record that looks live.
 *  - The remote browser runs in Browserbase's cloud. It cannot reach this
 *    laptop's localhost, so Huddle uses the preview's public URL or an explicit
 *    public URL, and says so when neither exists.
 *  - Closing is real: the CDP connection is dropped and Browserbase is asked to
 *    end the session, then polled until it confirms. Nothing is leaked, including
 *    sessions left over from a previous run of Huddle.
 *  - The page never receives Huddle's preload API, a filesystem path or a secret.
 */

const SESSION_VIEWPORT = { width: 1440, height: 900 }
const CDP_CONNECT_TIMEOUT_MS = 90_000
const MAX_LIVE_SESSIONS = 3
const HISTORY_LIMIT = 24

/**
 * The slice of the Browserbase SDK this file uses. Declaring it here keeps the
 * SDK's own types in `credentials.ts`, where the client is built, and still
 * checks that a real client satisfies it.
 */
interface BrowserbaseLike {
  sessions: {
    create(params: {
      projectId: string
      browserSettings: { viewport: { width: number; height: number } }
      userMetadata: Record<string, string>
    }): Promise<{ id: string; status: string; region: string; connectUrl: string }>
    update(id: string, body: { status: 'REQUEST_RELEASE' }): Promise<{ status: string }>
    retrieve(id: string): Promise<{ status: string }>
    debug(id: string): Promise<{ debuggerUrl?: string; debuggerFullscreenUrl?: string }>
  }
}

interface ProviderErrorShape {
  code: string
  message: string
  detail: string
  fix?: string
}

function describeProviderError(error: unknown): ProviderErrorShape {
  const record = asRecord(error)
  const status = asNumber(record?.status)
  const name = asString(record?.name, 'Error')
  const raw = oneLine(messageOf(error), 400)
  const withStatus = status === null ? raw : `HTTP ${String(status)}: ${raw}`

  if (status === 401 || status === 403) {
    return {
      code: 'browserbase_auth',
      message: `Browserbase rejected the credentials (${withStatus}).`,
      detail: `Browserbase rejected the credentials (${withStatus}).`,
      fix: 'Paste a current BROWSERBASE_API_KEY from the Browserbase dashboard into Settings → Secrets, then try again.'
    }
  }
  if (status === 402) {
    return {
      code: 'browserbase_billing',
      message: `Browserbase refused to start a browser (${withStatus}).`,
      detail: `Browserbase refused to start a browser (${withStatus}).`,
      fix: 'Check the Browserbase plan and usage; a session cannot start without available browser minutes.'
    }
  }
  if (status === 429) {
    return {
      code: 'browserbase_rate_limited',
      message: `Browserbase is at its concurrent session limit (${withStatus}).`,
      detail: `Browserbase is at its concurrent session limit (${withStatus}).`,
      fix: 'Close a remote session from its Browser surface, wait a few seconds, then try again.'
    }
  }
  if (status !== null && status >= 500) {
    return {
      code: 'browserbase_unavailable',
      message: `Browserbase failed on its side (${withStatus}).`,
      detail: `Browserbase failed on its side (${withStatus}).`,
      fix: 'This is a provider failure rather than a Huddle one. Try again in a moment.'
    }
  }
  return {
    code: 'browserbase_error',
    message: `Opening the remote browser failed (${name}: ${withStatus}).`,
    detail: `Opening the remote browser failed (${name}: ${withStatus}).`,
    fix: 'Check the Browserbase status page and the credentials in Settings → Secrets.'
  }
}

function previewFix(preview: PreviewInfo): string {
  if (preview.mode === 'off') {
    return 'Set Settings → Preview mode to "tunnel", then start the preview again.'
  }
  if (preview.state === 'starting') {
    return 'Wait until the dev server answers, then open the session again.'
  }
  if (preview.state === 'failed') {
    return 'Read the Terminal output for the dev server, fix the failure, then start the preview again.'
  }
  return 'Start the preview from the Browser surface, or pass a public URL explicitly.'
}

class BrowserHostImpl implements BrowserHost {
  private readonly deps: BrowserHostDeps
  private readonly live = new Map<string, LiveSession>()
  private readonly history = new Map<string, LiveSession>()
  private disposed = false

  constructor(deps: BrowserHostDeps) {
    this.deps = deps
  }

  /* ------------------------------------------------------------------ *
   * Opening and closing
   * ------------------------------------------------------------------ */

  async openSession(input: {
    roomId: string
    agentId: string
    url?: string
    label?: string
  }): Promise<BrowserSessionRecord> {
    if (this.disposed) {
      throw new HuddleError('browser_disposed', 'Huddle is shutting down, so it will not open a new remote browser.')
    }

    const settings = this.deps.settings()
    // Throws with a concrete fix when disabled, or when either credential is missing.
    const credentials = requireCredentials(settings)
    const label = (input.label ?? '').trim() || 'default'

    const reuse = this.findLive(input.roomId, input.agentId, label)
    if (reuse !== null) return reuse.record

    if (this.live.size >= MAX_LIVE_SESSIONS) {
      throw new HuddleError(
        'browser_session_limit',
        `Huddle is already holding ${String(this.live.size)} remote browser sessions, which is the limit for this machine.`,
        'Close one from its Browser surface, then open this session again.'
      )
    }

    const target = await this.resolveTarget(input.roomId, input.agentId, input.url)

    const record: BrowserSessionRecord = {
      id: this.deps.bus.newId(),
      roomId: input.roomId,
      agentId: input.agentId,
      provider: 'browserbase',
      remoteId: null,
      liveViewUrl: null,
      status: 'starting',
      currentUrl: target.url,
      title: null,
      startedAt: this.deps.bus.now(),
      endedAt: null,
      error: null,
      detail: `Creating a real Browserbase session (key from ${originLabel(credentials.origin)}). ${target.detail}`
    }
    this.publish(record)

    const client: BrowserbaseLike = clientFor(credentials)
    let created: { id: string; status: string; region: string; connectUrl: string }
    try {
      created = await client.sessions.create({
        projectId: credentials.projectId,
        browserSettings: {
          viewport: { width: SESSION_VIEWPORT.width, height: SESSION_VIEWPORT.height }
        },
        userMetadata: {
          huddleRoomId: input.roomId,
          huddleAgentId: input.agentId,
          huddleLabel: label
        }
      })
    } catch (error) {
      throw this.failStart(record, 'Browserbase could not create the session.', error)
    }

    const started: BrowserSessionRecord = {
      ...record,
      remoteId: created.id,
      detail:
        `Remote session ${shortId(created.id)} is ${created.status} in ${created.region}; ` +
        'opening the CDP connection from this machine.'
    }
    this.publish(started)

    let browser: Browser
    try {
      browser = await chromium.connectOverCDP(created.connectUrl, { timeout: CDP_CONNECT_TIMEOUT_MS })
    } catch (error) {
      // A session we created but could not drive must not be left running.
      const release = await this.releaseRemote(created.id, client)
      throw this.failStart(
        started,
        `Huddle created remote session ${shortId(created.id)} but could not connect to it over CDP. ${release.detail}`,
        error
      )
    }

    const context: BrowserContext = browser.contexts()[0] ?? (await browser.newContext())
    const page: Page = context.pages()[0] ?? (await context.newPage())
    const network = new NetworkRecorder()
    const liveViewUrl = await this.liveViewUrl(created.id, client)

    const session = new LiveSession({
      deps: {
        bus: this.deps.bus,
        writeArtifact: (artifactInput) => this.deps.exec.writeArtifact(artifactInput),
        publish: (next) => this.publish(next),
        disconnected: (lost, reason) => this.handleDisconnect(lost, reason),
        release: (remoteId) => this.releaseRemote(remoteId, client)
      },
      record: {
        ...started,
        status: 'live',
        liveViewUrl,
        detail:
          `Live Browserbase session ${shortId(created.id)} in ${created.region} at ` +
          `${String(SESSION_VIEWPORT.width)}×${String(SESSION_VIEWPORT.height)}. ${target.detail}`
      },
      browser,
      context,
      page,
      network,
      viewport: SESSION_VIEWPORT,
      region: created.region,
      label
    })

    this.live.set(session.id, session)

    if (liveViewUrl === null) {
      this.deps.bus.notice(
        input.roomId,
        'warn',
        'The remote browser is live, but Browserbase did not return a live-view URL for it.',
        'Huddle still drives and screenshots the session; only the "watch it live" link is missing.'
      )
    }

    // The first navigation is what turns "a browser is open" into "the app was
    // actually loaded", so its outcome is folded into the record.
    const navigation = await session.act({ kind: 'navigate', url: target.url })
    if (!navigation.ok) {
      session.markStatus(
        'live',
        `Live Browserbase session ${shortId(created.id)} in ${created.region}, but the first navigation did not succeed.`,
        navigation.detail
      )
      this.deps.bus.notice(
        input.roomId,
        'warn',
        `The remote browser is live but could not load ${target.url}.`,
        navigation.detail
      )
      return session.record
    }

    session.markStatus(
      'live',
      `Live Browserbase session ${shortId(created.id)} in ${created.region} at ` +
        `${String(SESSION_VIEWPORT.width)}×${String(SESSION_VIEWPORT.height)}. ${navigation.detail}`,
      null
    )
    return session.record
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.live.get(sessionId)
    if (session === undefined) {
      if (this.history.has(sessionId)) return
      throw new HuddleError(
        'browser_session_unknown',
        'Huddle has no browser session with that id.',
        'Open a session from the Browser surface; sessions do not survive a restart.'
      )
    }
    this.live.delete(sessionId)
    this.remember(session)
    this.deps.bus.upsertBrowserSession({
      ...session.record,
      status: 'closed',
      endedAt: this.deps.bus.now(),
      detail: 'Closing the remote session and asking Browserbase to end it.'
    })
    await session.close('user')
  }

  getSession(sessionId: string): BrowserSessionRecord | null {
    const session = this.live.get(sessionId) ?? this.history.get(sessionId)
    return session === undefined ? null : session.record
  }

  /* ------------------------------------------------------------------ *
   * Driving the session
   * ------------------------------------------------------------------ */

  async act(input: BrowserActionInput): Promise<BrowserActionResult> {
    const session = this.requireLive(input.sessionId)
    return await session.act(input.action)
  }

  async observe(sessionId: string): Promise<BrowserObservation> {
    return await this.requireLive(sessionId).observe()
  }

  async screenshot(sessionId: string, opts?: { fullPage?: boolean }): Promise<ScreenshotResult> {
    return await this.requireLive(sessionId).screenshot(opts ?? {})
  }

  async network(sessionId: string, filter?: string): Promise<NetworkCapture[]> {
    // Captured payloads stay readable after a session closes: they are evidence.
    const session = this.live.get(sessionId) ?? this.history.get(sessionId)
    if (session === undefined) {
      throw new HuddleError(
        'browser_session_unknown',
        'Huddle has no browser session with that id, so it has no captured responses for it.',
        'Open a session from the Browser surface.'
      )
    }
    return session.networkEntries(filter)
  }

  /* ------------------------------------------------------------------ *
   * Restart, teardown
   * ------------------------------------------------------------------ */

  /**
   * A restart cannot keep a remote browser, and it must not leak one either.
   * Every persisted session that was still `starting` or `live` is checked with
   * Browserbase, released if it is somehow still running, and written back as
   * `closed` (confirmed) or `failed` (unconfirmed). Never as `live`.
   */
  async reconcile(sessions: BrowserSessionRecord[]): Promise<void> {
    const credentials = peekCredentials()
    const enabled = this.deps.settings().browserbaseEnabled

    for (const persisted of sessions) {
      if (persisted.status !== 'starting' && persisted.status !== 'live') continue
      const outcome = await this.reconcileOne(persisted, credentials, enabled)
      this.publish(outcome)
      if (persisted.roomId.length > 0) {
        this.deps.bus.notice(
          persisted.roomId,
          outcome.status === 'closed' ? 'info' : 'warn',
          outcome.detail,
          outcome.status === 'closed'
            ? undefined
            : 'Open a new session from the Browser surface when a teammate needs one.'
        )
      }
    }
  }

  private async reconcileOne(
    persisted: BrowserSessionRecord,
    credentials: ReturnType<typeof peekCredentials>,
    enabled: boolean
  ): Promise<BrowserSessionRecord> {
    const base: BrowserSessionRecord = {
      ...persisted,
      endedAt: this.deps.bus.now(),
      error: null
    }

    if (credentials === null || !enabled) {
      const why =
        credentials === null
          ? 'Huddle has no Browserbase credentials, so it cannot check'
          : 'Remote browser sessions are turned off in Settings, so Huddle did not check'
      return {
        ...base,
        status: 'failed',
        detail: `${why} whether this session survived the restart. Nothing is attached to it now, and it is not reported as live.`
      }
    }

    if (persisted.remoteId === null) {
      return {
        ...base,
        status: 'failed',
        detail:
          'Huddle restarted before the provider session id was recorded, so this session cannot be checked or released. ' +
          'Nothing is attached to it now.'
      }
    }

    const client: BrowserbaseLike = clientFor(credentials)
    try {
      const remote = await client.sessions.retrieve(persisted.remoteId)
      if (remote.status === 'RUNNING' || remote.status === 'PENDING') {
        const release = await this.releaseRemote(persisted.remoteId, client)
        return {
          ...base,
          status: 'closed',
          detail:
            `Huddle restarted while Browserbase still had this session ${remote.status}. ` +
            `It has been released: ${release.detail}`
        }
      }
      return {
        ...base,
        status: 'closed',
        detail: `Huddle restarted. Browserbase reports the session as ${remote.status}, so nothing is left running.`
      }
    } catch (error) {
      const message = oneLine(messageOf(error), 240)
      return {
        ...base,
        status: 'failed',
        error: `Huddle could not confirm this session with Browserbase after a restart: ${message}`,
        detail:
          `Huddle restarted and could not confirm this session with Browserbase (${message}). ` +
          'Nothing is attached to it now, and it is not reported as live.'
      }
    }
  }

  async disposeRoom(roomId: string): Promise<void> {
    const closing: LiveSession[] = []
    for (const session of this.live.values()) {
      if (session.record.roomId === roomId) closing.push(session)
    }
    for (const session of closing) {
      this.live.delete(session.id)
      this.remember(session)
      await session.close('room').catch(() => undefined)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const closing = [...this.live.values()]
    this.live.clear()
    for (const session of closing) {
      this.remember(session)
      await session.close('host').catch(() => undefined)
    }
    this.history.clear()
  }

  /* ------------------------------------------------------------------ *
   * Internals
   * ------------------------------------------------------------------ */

  private publish(record: BrowserSessionRecord): void {
    this.deps.bus.upsertBrowserSession(record)
  }

  private remember(session: LiveSession): void {
    this.history.set(session.id, session)
    if (this.history.size <= HISTORY_LIMIT) return
    const stale = [...this.history.keys()].slice(0, this.history.size - HISTORY_LIMIT)
    for (const id of stale) this.history.delete(id)
  }

  private requireLive(sessionId: string): LiveSession {
    const session = this.live.get(sessionId)
    if (session !== undefined) return session
    if (this.history.has(sessionId)) {
      throw new HuddleError(
        'browser_session_closed',
        'That browser session is closed, so there is no remote page to act on.',
        'Open a new session from the Browser surface.'
      )
    }
    throw new HuddleError(
      'browser_session_unknown',
      'Huddle has no browser session with that id.',
      'Open a session from the Browser surface; sessions do not survive a restart.'
    )
  }

  private findLive(roomId: string, agentId: string, label: string): LiveSession | null {
    for (const session of this.live.values()) {
      const record = session.record
      if (record.roomId === roomId && record.agentId === agentId && session.label === label) return session
    }
    return null
  }

  private handleDisconnect(session: LiveSession, reason: string): void {
    if (!this.live.delete(session.id)) return
    this.remember(session)
    const record = session.record
    this.deps.bus.notice(
      record.roomId,
      'warn',
      `The remote browser disconnected (${reason}).`,
      'Anything that needed it should be re-checked; open a new session from the Browser surface.'
    )
    void session.handleRemoteLoss(reason).catch((error: unknown) => {
      // The record is already truthful; this only reports a failed confirmation.
      this.deps.bus.notice(
        record.roomId,
        'warn',
        'Huddle could not confirm the release of the remote session.',
        oneLine(messageOf(error), 240)
      )
    })
  }

  /**
   * Ask Browserbase to end a session and find out what it says afterwards.
   * Never throws: the caller still has to write a truthful record.
   */
  private async releaseRemote(remoteId: string, client: BrowserbaseLike): Promise<RemoteRelease> {
    try {
      const released = await client.sessions.update(remoteId, { status: 'REQUEST_RELEASE' })
      let status = released.status
      let attempts = 0
      while ((status === 'RUNNING' || status === 'PENDING') && attempts < 6) {
        await delay(1500)
        attempts += 1
        try {
          const fetched = await client.sessions.retrieve(remoteId)
          status = fetched.status
        } catch (error) {
          return {
            status,
            detail: `Browserbase accepted the release but could not be polled for the final state (${oneLine(messageOf(error), 200)}).`
          }
        }
      }
      if (status === 'RUNNING' || status === 'PENDING') {
        return { status, detail: `Browserbase still reports the session as ${status} after it was asked to release.` }
      }
      return { status, detail: `Browserbase confirms the session ended as ${status}.` }
    } catch (error) {
      return {
        status: null,
        detail: `Browserbase could not be reached to confirm the release (${oneLine(messageOf(error), 200)}).`
      }
    }
  }

  private async liveViewUrl(remoteId: string, client: BrowserbaseLike): Promise<string | null> {
    try {
      const urls = await client.sessions.debug(remoteId)
      const fullscreen = urls.debuggerFullscreenUrl
      if (typeof fullscreen === 'string' && fullscreen.length > 0) return fullscreen
      const framed = urls.debuggerUrl
      if (typeof framed === 'string' && framed.length > 0) return framed
      return null
    } catch {
      return null
    }
  }

  /**
   * Where the remote browser should open. Huddle never guesses: it uses the
   * project's reachable preview URL, or an explicit public URL, and refuses with
   * an explanation when neither exists.
   */
  private async resolveTarget(
    roomId: string,
    agentId: string,
    url?: string
  ): Promise<{ url: string; detail: string }> {
    const explicit = (url ?? '').trim()
    if (explicit.length > 0) {
      const check = checkRemoteTarget(explicit)
      if (!check.ok) throw new HuddleError('remote_url_unreachable', check.detail, check.fix)
      return { url: check.url, detail: `Opened on the URL it was asked for: ${check.url}` }
    }

    const workspaces = this.deps.bus.getWorkspaces(roomId)
    const workspace =
      workspaces.find((item) => item.kind === 'team') ??
      workspaces.find((item) => item.agentId === agentId) ??
      workspaces[0] ??
      null
    if (workspace === null) {
      const fix =
        'Bind a project folder or create the demo project, start the preview from the Browser surface, then open the session again.'
      throw new HuddleError(
        'preview_unreachable',
        `This room has no workspace yet, so there is no running app for a remote browser to check. Next: ${fix}`,
        fix
      )
    }

    const preview = this.deps.exec.getPreview(roomId, workspace.id)
    if (preview === null) {
      const fix = 'Start the preview from the Browser surface (Start preview), then open the session again.'
      throw new HuddleError(
        'preview_unreachable',
        `No preview has been started for ${workspace.label}, and a browser in Browserbase's cloud cannot reach this laptop's localhost. Next: ${fix}`,
        fix
      )
    }

    const publicUrl = (preview.publicUrl ?? '').trim()
    if (publicUrl.length === 0) {
      const fix = previewFix(preview)
      throw new HuddleError(
        'preview_unreachable',
        `${describePreviewReachability(preview.mode, preview.state)} ${oneLine(preview.detail, 300)} Next: ${fix}`,
        fix
      )
    }

    const check = checkRemoteTarget(publicUrl)
    if (!check.ok) {
      throw new HuddleError(
        'preview_unreachable',
        `${check.detail} ${describePreviewReachability(preview.mode, preview.state)} Next: ${check.fix}`,
        check.fix
      )
    }

    return {
      url: check.url,
      detail: `Opened on the project preview ${check.url} (${preview.mode} mode, ${preview.state}).`
    }
  }

  private failStart(record: BrowserSessionRecord, what: string, error: unknown): HuddleError {
    const shape = describeProviderError(error)
    const detail = `${what} ${shape.detail}`
    this.publish({
      ...record,
      status: 'failed',
      endedAt: this.deps.bus.now(),
      error: shape.message,
      detail
    })
    return new HuddleError(shape.code, shape.message, shape.fix)
  }
}

export const createBrowserHost: CreateBrowserHost = (deps: BrowserHostDeps): BrowserHost =>
  new BrowserHostImpl(deps)
