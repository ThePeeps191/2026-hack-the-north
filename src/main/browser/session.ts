import type { Browser, BrowserContext, Page, Response } from 'playwright-core'
import type {
  BrowserActionInput,
  BrowserActionResult,
  BrowserObservation,
  BrowserSessionRecord,
  HuddleBus
} from '../contracts.ts'
import type { NetworkEntry, ScreenshotResult } from '../../shared/api.ts'
import type { Artifact } from '../../shared/types.ts'
import { HuddleError } from '../huddle-error.ts'
import { messageOf, oneLine, shortId, timestampForFilename } from './narrow.ts'
import { NetworkRecorder } from './network.ts'
import {
  DRAW_COUNTERS_SCRIPT,
  METRICS_SCRIPT,
  OBSERVE_SCRIPT,
  TUNNEL_BYPASS_HEADER,
  TUNNEL_REMINDER_SCRIPT,
  VITE_BLOCKED_HOST_SCRIPT,
  looksLikeTunnelUrl,
  tunnelContinueLabel,
  canvasStatsScript,
  drawInstrumentScript,
  planStrokes,
  pngSize,
  readCanvasStats,
  readDrawCounters,
  readDrawProbe,
  readObservation,
  readViewport,
  summarizeObservation,
  toObservation,
  trimText,
  type ViewportSize
} from './page-scripts.ts'
import { checkRemoteTarget } from './targets.ts'

/**
 * One real, live Browserbase session, driven through Playwright's CDP client.
 *
 * The session owns the connection, the page Huddle is driving, the network
 * recorder and the session record that the room sees. Everything it reports is
 * something the remote browser actually did; a failure is returned as
 * `{ ok: false }` (or thrown as a `HuddleError`) rather than smoothed over.
 */

export type BrowserActionKind = BrowserActionInput['action']

export interface ArtifactWriteInput {
  roomId: string
  agentId: string | null
  taskId: string | null
  kind: Artifact['kind']
  title: string
  filename: string
  data: Buffer | string
  mime: string
}

export interface RemoteRelease {
  /** The status Browserbase reported last, or null when it could not be asked. */
  status: string | null
  /** One truthful sentence about what Browserbase said. */
  detail: string
}

export interface LiveSessionDeps {
  bus: HuddleBus
  writeArtifact: (input: ArtifactWriteInput) => Promise<Artifact>
  /** Publish a changed session record to the room. */
  publish: (record: BrowserSessionRecord) => void
  /** The connection went away without Huddle asking for it. */
  disconnected: (session: LiveSession, reason: string) => void
  /** Ask Browserbase to end the session and report what it says afterwards. */
  release: (remoteId: string) => Promise<RemoteRelease>
}

export interface LiveSessionInit {
  deps: LiveSessionDeps
  /** The record as it stands when the connection succeeded. */
  record: BrowserSessionRecord
  browser: Browser
  context: BrowserContext
  page: Page
  network: NetworkRecorder
  viewport: ViewportSize
  region: string
  /** Which of the agent's sessions this is; 'default' unless a caller asked for a second one. */
  label: string
}

const GOTO_TIMEOUT_MS = 45_000
const LOAD_STATE_TIMEOUT_MS = 10_000
const ACTION_TIMEOUT_MS = 15_000
const SCREENSHOT_TIMEOUT_MS = 30_000
const MAX_WAIT_MS = 20_000
const MAX_OBSERVATION_CHARS = 4000
const EVALUATE_PREVIEW_CHARS = 3000

function previewValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(trimText(value, EVALUATE_PREVIEW_CHARS))
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  try {
    const json = JSON.stringify(value)
    if (typeof json === 'string') return trimText(json, EVALUATE_PREVIEW_CHARS)
  } catch {
    return '(the value contained a cycle and could not be serialised)'
  }
  return trimText(String(value), EVALUATE_PREVIEW_CHARS)
}

/** A block of statements is wrapped so `page.evaluate` gets an expression. */
function normalizeExpression(expression: string): string {
  const trimmed = expression.trim()
  const looksLikeFunction =
    trimmed.startsWith('(') || trimmed.startsWith('function') || trimmed.includes('=>')
  if (looksLikeFunction) return trimmed
  if (trimmed.includes(';') || /\breturn\b/.test(trimmed)) return `(() => { ${trimmed} })()`
  return trimmed
}

export class LiveSession {
  readonly id: string
  /** `default`, or the caller's label for an extra session in a multi-user flow. */
  readonly label: string
  readonly network: NetworkRecorder

  private readonly deps: LiveSessionDeps
  private readonly browser: Browser
  private readonly context: BrowserContext
  private readonly region: string
  private readonly fallbackViewport: ViewportSize
  private readonly refs = new Map<string, string>()
  private recordValue: BrowserSessionRecord
  private pageValue: Page
  private closedFlag = false
  private tabs = 1
  private tunnelHandled = false

  constructor(init: LiveSessionInit) {
    this.id = init.record.id
    this.label = init.label
    this.deps = init.deps
    this.browser = init.browser
    this.context = init.context
    this.pageValue = init.page
    this.network = init.network
    this.region = init.region
    this.fallbackViewport = init.viewport
    this.recordValue = init.record
    this.network.attach(init.context)
    this.watch()
  }

  get record(): BrowserSessionRecord {
    return this.recordValue
  }

  get isClosed(): boolean {
    return this.closedFlag
  }

  /* ------------------------------------------------------------------ *
   * Connection watching
   * ------------------------------------------------------------------ */

  private watch(): void {
    this.pageValue.on('close', () => {
      if (this.closedFlag) return
      const survivor = this.otherPage()
      if (survivor !== null) {
        this.tabs += 1
        this.pageValue = survivor
        this.syncRecord(
          {
            currentUrl: survivor.url(),
            detail: this.detail(`The tab Huddle was driving closed; now following tab ${String(this.tabs)}.`)
          },
          true
        )
        return
      }
      this.deps.disconnected(this, 'the tab Huddle was driving was closed')
    })

    this.context.on('page', (page: Page) => {
      if (this.closedFlag) return
      this.tabs += 1
      this.pageValue = page
      this.syncRecord(
        {
          currentUrl: page.url(),
          detail: this.detail(`A new tab opened; following it as tab ${String(this.tabs)}.`)
        },
        true
      )
    })

    this.context.on('close', () => {
      if (this.closedFlag) return
      this.deps.disconnected(this, 'the remote browser context closed')
    })

    this.browser.on('disconnected', () => {
      if (this.closedFlag) return
      this.deps.disconnected(this, 'the CDP connection to Browserbase dropped')
    })
  }

  private otherPage(): Page | null {
    for (const page of this.context.pages()) {
      if (page !== this.pageValue && !page.isClosed()) return page
    }
    return null
  }

  /* ------------------------------------------------------------------ *
   * The record the room sees
   * ------------------------------------------------------------------ */

  private detail(suffix: string): string {
    const parts = [
      `Live Browserbase session ${shortId(this.recordValue.remoteId)} in ${this.region} at ` +
        `${String(this.fallbackViewport.width)}×${String(this.fallbackViewport.height)}.`
    ]
    if (suffix.length > 0) parts.push(suffix)
    const captured = this.network.count()
    if (captured > 0) parts.push(`${String(captured)} response(s) captured for evidence.`)
    return parts.join(' ')
  }

  private syncRecord(patch: Partial<BrowserSessionRecord>, force = false): void {
    const previous = this.recordValue
    const next: BrowserSessionRecord = { ...previous, ...patch }
    this.recordValue = next
    const changed =
      force ||
      next.status !== previous.status ||
      next.currentUrl !== previous.currentUrl ||
      next.title !== previous.title ||
      next.detail !== previous.detail ||
      next.liveViewUrl !== previous.liveViewUrl ||
      next.error !== previous.error ||
      next.endedAt !== previous.endedAt
    if (changed) this.deps.publish(next)
  }

  /** Set the record's status and detail explicitly (no inference). */
  markStatus(status: BrowserSessionRecord['status'], detail: string, error: string | null): void {
    if (this.closedFlag) return
    this.syncRecord({ status, detail, error }, true)
  }

  private assertOpen(): void {
    if (this.closedFlag) {
      throw new HuddleError(
        'browser_session_closed',
        `Browser session ${shortId(this.recordValue.remoteId)} is closed, so there is no remote page to act on.`,
        'Open a new session from the Browser surface.'
      )
    }
  }

  private pageUrl(): string {
    try {
      return this.pageValue.url()
    } catch {
      return this.recordValue.currentUrl ?? ''
    }
  }

  private async pageTitle(): Promise<string> {
    try {
      return await this.pageValue.title()
    } catch {
      return this.recordValue.title ?? ''
    }
  }

  /** Re-read the real page state into the record. Safe to call at any time. */
  async refresh(): Promise<void> {
    if (this.closedFlag) return
    const url = this.pageUrl()
    const title = await this.pageTitle()
    this.syncRecord({ currentUrl: url, title, detail: this.detail('') })
  }

  /* ------------------------------------------------------------------ *
   * Observation
   * ------------------------------------------------------------------ */

  private async accessibilitySummary(): Promise<string> {
    try {
      return await this.pageValue.locator('body').ariaSnapshot({ timeout: 4000, mode: 'ai' })
    } catch {
      return ''
    }
  }

  async observe(): Promise<BrowserObservation> {
    this.assertOpen()
    const value: unknown = await this.pageValue.evaluate(OBSERVE_SCRIPT)
    const raw = readObservation(value)
    this.refs.clear()
    for (const element of raw.elements) this.refs.set(element.ref, element.selector)
    const accessibility = await this.accessibilitySummary()
    const text = summarizeObservation(raw, accessibility, MAX_OBSERVATION_CHARS)
    const url = raw.url.length > 0 ? raw.url : this.pageUrl()
    this.syncRecord({ currentUrl: url, title: raw.title, detail: this.detail('') })
    return toObservation(raw, url, text)
  }

  private async safeObserve(): Promise<BrowserObservation | null> {
    try {
      return await this.observe()
    } catch {
      return null
    }
  }

  /* ------------------------------------------------------------------ *
   * Actions
   * ------------------------------------------------------------------ */

  async act(action: BrowserActionKind): Promise<BrowserActionResult> {
    this.assertOpen()
    switch (action.kind) {
      case 'navigate':
        return await this.navigate(action.url)
      case 'click':
        return await this.click(action.selector)
      case 'type':
        return await this.type(action.selector, action.text, action.submit === true)
      case 'press':
        return await this.press(action.key)
      case 'select':
        return await this.select(action.selector, action.value)
      case 'waitFor':
        return await this.waitFor(action.selector, action.ms)
      case 'evaluate':
        return await this.evaluate(action.expression)
      case 'draw':
        return await this.draw(action.selector, action.strokes)
      default:
        return { ok: false, detail: 'That browser action is not supported.', observation: null }
    }
  }

  /** `e3` (or `ref=e3`) resolves to the selector the last observation reported. */
  private resolveSelector(input: string): string {
    const trimmed = input.trim()
    const match = /^(?:ref=)?(e\d{1,3})$/.exec(trimmed)
    if (match !== null) {
      const found = this.refs.get(match[1])
      if (found !== undefined) return found
      throw new HuddleError(
        'browser_ref_unknown',
        `There is no element ${match[1]} in the last observation of this session.`,
        'Observe the page again and use a ref or a CSS selector from that observation.'
      )
    }
    if (trimmed.length === 0) {
      throw new HuddleError('browser_selector_missing', 'No selector was given for that action.')
    }
    return trimmed
  }

  private labelFor(input: string, selector: string): string {
    return input.trim() === selector ? selector : `${input.trim()} → ${selector}`
  }

  private async run(label: string, body: () => Promise<string>): Promise<BrowserActionResult> {
    try {
      const detail = await body()
      await this.refresh().catch(() => undefined)
      return { ok: true, detail, observation: await this.safeObserve() }
    } catch (error) {
      await this.refresh().catch(() => undefined)
      return {
        ok: false,
        detail: `${label} failed: ${oneLine(messageOf(error), 400)}`,
        observation: await this.safeObserve()
      }
    }
  }

  private async navigate(input: string): Promise<BrowserActionResult> {
    const check = checkRemoteTarget(input)
    if (!check.ok) {
      return {
        ok: false,
        detail: `${check.detail} ${check.fix}`,
        observation: await this.safeObserve()
      }
    }
    const target = check.url
    return await this.run(`Navigation to ${target}`, async () => {
      if (looksLikeTunnelUrl(target)) {
        await this.context.setExtraHTTPHeaders({ ...TUNNEL_BYPASS_HEADER })
      }
      const response: Response | null = await this.pageValue.goto(target, {
        waitUntil: 'domcontentloaded',
        timeout: GOTO_TIMEOUT_MS
      })
      await this.pageValue.waitForLoadState('load', { timeout: LOAD_STATE_TIMEOUT_MS }).catch(() => undefined)
      const status = response === null ? null : response.status()
      const tunnelNote = await this.handleTunnelReminder()
      const hostNote = await this.describeViteBlockedHost()
      const prefix = [tunnelNote, hostNote].filter((item): item is string => item !== null).join(' ')
      const lead = prefix.length > 0 ? `${prefix} ` : ''
      if (status !== null && status >= 400) {
        return `${lead}Navigated to ${target}; the server answered HTTP ${String(status)}.`
      }
      return status === null
        ? `${lead}Navigated to ${target}.`
        : `${lead}Navigated to ${target} (HTTP ${String(status)}).`
    })
  }

  /**
   * localtunnel answers a real browser with a reminder page unless the request
   * carries its bypass header. Detecting that page is the difference between
   * "the app loaded" and "a tunnel notice loaded and nothing was tested".
   */
  private async handleTunnelReminder(): Promise<string | null> {
    if (this.tunnelHandled) return null
    this.tunnelHandled = true
    if (!(await this.pageLooksLikeTunnelReminder())) return null
    const notes: string[] = [
      'The tunnel answered with its own reminder page first.'
    ]
    try {
      await this.context.setExtraHTTPHeaders({ ...TUNNEL_BYPASS_HEADER })
      await this.pageValue.reload({ waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS })
      notes.push('Huddle asked it to bypass that and reloaded the page.')
    } catch (error) {
      return `The tunnel answered with its own reminder page, and the reload after asking it to bypass that failed (${oneLine(messageOf(error), 160)}).`
    }
    if (!(await this.pageLooksLikeTunnelReminder())) return notes.join(' ')
    const clicked = await this.clickTunnelContinue()
    if (clicked) {
      notes.push('The bypass header was not enough, so Huddle pressed Continue on the reminder.')
      await this.pageValue.waitForLoadState('load', { timeout: LOAD_STATE_TIMEOUT_MS }).catch(() => undefined)
    }
    if (await this.pageLooksLikeTunnelReminder()) {
      notes.push('The reminder is still showing, so the project app was not reached.')
    }
    return notes.join(' ')
  }

  private async pageLooksLikeTunnelReminder(): Promise<boolean> {
    try {
      return (await this.pageValue.evaluate(TUNNEL_REMINDER_SCRIPT)) === true
    } catch {
      return false
    }
  }

  private async describeViteBlockedHost(): Promise<string | null> {
    try {
      const blocked = (await this.pageValue.evaluate(VITE_BLOCKED_HOST_SCRIPT)) === true
      if (!blocked) return null
      return (
        'Vite refused the tunneled Host header (allowedHosts). Add server.allowedHosts: true ' +
        'to the project vite config, then restart the preview.'
      )
    } catch {
      return null
    }
  }

  private async clickTunnelContinue(): Promise<boolean> {
    const locators = this.pageValue.locator('button, a, input[type="submit"]')
    const count = await locators.count().catch(() => 0)
    for (let index = 0; index < count; index += 1) {
      const candidate = locators.nth(index)
      const label =
        (await candidate.innerText().catch(() => '')) ||
        (await candidate.getAttribute('value').catch(() => '')) ||
        ''
      if (!tunnelContinueLabel(label)) continue
      try {
        await candidate.click({ timeout: ACTION_TIMEOUT_MS })
        return true
      } catch {
        return false
      }
    }
    return false
  }

  private async click(input: string): Promise<BrowserActionResult> {
    const selector = this.resolveSelector(input)
    return await this.run(`Click on ${selector}`, async () => {
      await this.pageValue.locator(selector).first().click({ timeout: ACTION_TIMEOUT_MS })
      return `Clicked ${this.labelFor(input, selector)} with a real mouse press in the remote browser.`
    })
  }

  private async type(input: string, text: string, submit: boolean): Promise<BrowserActionResult> {
    const selector = this.resolveSelector(input)
    return await this.run(`Typing into ${selector}`, async () => {
      const locator = this.pageValue.locator(selector).first()
      let how = 'filled'
      try {
        await locator.fill(text, { timeout: ACTION_TIMEOUT_MS })
      } catch {
        // Contenteditable and canvas-backed fields reject fill(); type for real.
        await locator.click({ timeout: ACTION_TIMEOUT_MS })
        await this.pageValue.keyboard.type(text, { delay: 15 })
        how = 'typed character by character'
      }
      if (submit) await this.pageValue.keyboard.press('Enter')
      return `${how} ${String(text.length)} character(s) into ${this.labelFor(input, selector)}${submit ? ', then pressed Enter' : ''}.`
    })
  }

  private async press(input: string): Promise<BrowserActionResult> {
    return await this.run(`Pressing ${input}`, async () => {
      await this.pageValue.keyboard.press(input)
      return `Pressed ${input} in the remote page.`
    })
  }

  private async select(input: string, value: string): Promise<BrowserActionResult> {
    const selector = this.resolveSelector(input)
    return await this.run(`Selecting "${value}" in ${selector}`, async () => {
      const chosen = await this.pageValue.locator(selector).first().selectOption(value, {
        timeout: ACTION_TIMEOUT_MS
      })
      return `Selected ${JSON.stringify(chosen)} in ${this.labelFor(input, selector)}.`
    })
  }

  private async waitFor(input: string | undefined, ms: number | undefined): Promise<BrowserActionResult> {
    return await this.run('Waiting', async () => {
      const notes: string[] = []
      const selectorText = (input ?? '').trim()
      if (selectorText.length > 0) {
        const selector = this.resolveSelector(selectorText)
        await this.pageValue.locator(selector).first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
        notes.push(`${selector} became visible`)
      }
      if (typeof ms === 'number' && ms > 0) {
        const bounded = Math.min(Math.trunc(ms), MAX_WAIT_MS)
        await this.pageValue.waitForTimeout(bounded)
        notes.push(`waited ${String(bounded)} ms`)
      }
      if (notes.length === 0) throw new Error('neither a selector nor a duration was given')
      return `Waited: ${notes.join(' and ')}.`
    })
  }

  private async evaluate(expression: string): Promise<BrowserActionResult> {
    const trimmed = expression.trim()
    if (trimmed.length === 0) {
      return { ok: false, detail: 'No expression was given to evaluate.', observation: await this.safeObserve() }
    }
    return await this.run('Evaluating the expression', async () => {
      const value: unknown = await this.pageValue.evaluate(normalizeExpression(trimmed))
      return `Evaluated in the remote page. Result: ${previewValue(value)}`
    })
  }

  /**
   * Real mouse strokes across an element, for the Sketch Night drawing board.
   *
   * The strokes are moved with CDP mouse input, so the page receives genuine
   * pointer events. Huddle counts the events that reached the element's box and
   * samples the canvas' own pixels before and after, so "it drew" is backed by
   * evidence instead of an assumption.
   */
  private async draw(input: string, strokes: number): Promise<BrowserActionResult> {
    const selector = this.resolveSelector(input)
    const label = this.labelFor(input, selector)
    const locator = this.pageValue.locator(selector).first()
    const box = await locator.boundingBox().catch(() => null)
    if (box === null) {
      return {
        ok: false,
        detail: `${label} has no visible box in the remote page, so there is nothing to draw on.`,
        observation: await this.safeObserve()
      }
    }
    if (box.width < 8 || box.height < 8) {
      return {
        ok: false,
        detail: `${label} is only ${String(Math.round(box.width))}×${String(Math.round(box.height))} px, too small to stroke.`,
        observation: await this.safeObserve()
      }
    }

    const probe = readDrawProbe(await this.pageValue.evaluate(drawInstrumentScript(selector)))
    if (!probe.found) {
      return {
        ok: false,
        detail: `${label} is not in the remote page any more, so nothing was drawn.`,
        observation: await this.safeObserve()
      }
    }
    if (probe.offscreen) {
      return {
        ok: false,
        detail: `${label} is in the DOM but not visible, so mouse strokes would not reach it.`,
        observation: await this.safeObserve()
      }
    }
    if (!probe.topIsTarget && !probe.topContainsTarget) {
      return {
        ok: false,
        detail:
          `A <${probe.topTag.length > 0 ? probe.topTag : 'unknown'}> sits on top of ${label}, ` +
          'so mouse strokes would land on that element instead of the drawing surface.',
        observation: await this.safeObserve()
      }
    }

    const before = readCanvasStats(await this.pageValue.evaluate(canvasStatsScript(selector)))
    const plans = planStrokes(box, strokes)
    for (const stroke of plans) {
      await this.pageValue.mouse.move(stroke.start.x, stroke.start.y)
      await this.pageValue.mouse.down()
      for (const point of stroke.points) {
        await this.pageValue.mouse.move(point.x, point.y)
        await this.pageValue.waitForTimeout(10)
      }
      await this.pageValue.mouse.up()
      await this.pageValue.waitForTimeout(50)
    }
    const counters = readDrawCounters(await this.pageValue.evaluate(DRAW_COUNTERS_SCRIPT))
    const after = readCanvasStats(await this.pageValue.evaluate(canvasStatsScript(selector)))
    await this.refresh().catch(() => undefined)

    const delivered = counters.down > 0 && counters.move > 0 && counters.up > 0
    const parts = [
      `Sent ${String(plans.length)} real mouse stroke(s) across ${label} ` +
        `(${String(Math.round(box.width))}×${String(Math.round(box.height))} px box).`,
      `Events that reached the box: ${String(counters.down)} pointerdown, ${String(counters.move)} pointermove, ` +
        `${String(counters.up)} pointerup` +
        (counters.targetTag.length > 0 ? `, delivered to <${counters.targetTag}>` : '') +
        '.'
    ]
    if (after.canvas && before.readable && after.readable) {
      const changed = after.checksum !== before.checksum || after.painted !== before.painted
      parts.push(
        `Canvas pixels: ${String(before.painted)} → ${String(after.painted)} painted of ` +
          `${String(after.sampled)} sampled points; ` +
          (changed
            ? 'the sampled pixels changed, so the canvas was actually drawn on.'
            : 'the sampled pixels did not change, so this canvas was not the surface that was painted.')
      )
      if (!delivered) {
        parts.push('The strokes never reached the element, so nothing was drawn.')
        return { ok: false, detail: parts.join(' '), observation: await this.safeObserve() }
      }
      if (!changed) {
        parts.push('Huddle will not report a drawing it cannot see.')
        return { ok: false, detail: parts.join(' '), observation: await this.safeObserve() }
      }
      return { ok: true, detail: parts.join(' '), observation: await this.safeObserve() }
    }

    parts.push(
      after.canvas
        ? `Canvas pixels could not be sampled (${after.note.length > 0 ? after.note : before.note}).`
        : `${label} is not a canvas, so there is no pixel evidence to check.`
    )
    if (!delivered) {
      parts.push('The strokes never reached the element, so nothing was drawn.')
      return { ok: false, detail: parts.join(' '), observation: await this.safeObserve() }
    }
    return { ok: true, detail: parts.join(' '), observation: await this.safeObserve() }
  }

  /* ------------------------------------------------------------------ *
   * Screenshots and network
   * ------------------------------------------------------------------ */

  private async viewportSize(): Promise<ViewportSize> {
    const size = this.pageValue.viewportSize()
    if (size !== null && size.width > 0 && size.height > 0) {
      return { width: Math.round(size.width), height: Math.round(size.height) }
    }
    try {
      const measured = readViewport(await this.pageValue.evaluate(METRICS_SCRIPT))
      if (measured !== null) return measured
    } catch {
      // Fall through to the viewport the session was created with.
    }
    return this.fallbackViewport
  }

  async screenshot(input: { fullPage?: boolean } = {}): Promise<ScreenshotResult> {
    this.assertOpen()
    const fullPage = input.fullPage === true
    const buffer = await this.pageValue.screenshot({
      type: 'png',
      fullPage,
      timeout: SCREENSHOT_TIMEOUT_MS
    })
    const image = pngSize(buffer) ?? this.fallbackViewport
    const viewport = await this.viewportSize()
    const url = this.pageUrl()
    const title = await this.pageTitle()
    const where = title.length > 0 ? title : url
    const artifact = await this.deps.writeArtifact({
      roomId: this.recordValue.roomId,
      agentId: this.recordValue.agentId,
      taskId: null,
      kind: 'screenshot',
      title: `Remote screen ${String(image.width)}×${String(image.height)} — ${oneLine(where, 120)}`,
      filename: `browser-${shortId(this.recordValue.remoteId)}-${timestampForFilename(new Date())}.png`,
      data: buffer,
      mime: 'image/png'
    })
    this.syncRecord(
      {
        currentUrl: url,
        title,
        detail: this.detail(
          `Captured a ${String(image.width)}×${String(image.height)} PNG ` +
            `(${String(artifact.bytes ?? buffer.byteLength)} bytes) from the live page.`
        )
      },
      true
    )
    return {
      artifact,
      viewport,
      url,
      dataUrl: `data:image/png;base64,${buffer.toString('base64')}`
    }
  }

  /** Captured responses stay readable after the session closes: they are evidence. */
  networkEntries(filter?: string): NetworkEntry[] {
    return this.network.list(filter)
  }

  /* ------------------------------------------------------------------ *
   * Ending the session
   * ------------------------------------------------------------------ */

  async close(kind: 'user' | 'room' | 'host'): Promise<void> {
    if (this.closedFlag) return
    this.closedFlag = true
    this.refs.clear()
    try {
      await this.browser.close()
    } catch {
      // The transport may already be gone; the release below is what matters.
    }
    const remoteId = this.recordValue.remoteId
    const release =
      remoteId === null
        ? {
            status: null,
            detail: 'No remote session id was recorded, so there was nothing to release at Browserbase.'
          }
        : await this.deps.release(remoteId)
    const reason =
      kind === 'user'
        ? 'Closed from the Browser surface.'
        : kind === 'room'
          ? 'Closed because the room was removed.'
          : 'Closed because Huddle is shutting down.'
    this.syncRecord(
      {
        status: 'closed',
        endedAt: this.deps.bus.now(),
        detail:
          `${reason} ${release.detail} ` +
          `${String(this.network.count())} captured response(s) remain readable as evidence.`
      },
      true
    )
  }

  /**
   * The connection dropped without Huddle asking. The session is not presumed to
   * have survived: it is closed locally and Browserbase is asked to end it, so a
   * paid browser is never left running behind Huddle's back.
   */
  async handleRemoteLoss(reason: string): Promise<void> {
    if (this.closedFlag) return
    this.closedFlag = true
    this.refs.clear()
    const remoteId = this.recordValue.remoteId
    const release = remoteId === null ? null : await this.deps.release(remoteId).catch(() => null)
    const releaseDetail =
      release === null
        ? 'No remote session id was recorded, so Browserbase was told nothing.'
        : release.detail
    this.syncRecord(
      {
        status: 'failed',
        error: `The remote browser disconnected: ${reason}.`,
        endedAt: this.deps.bus.now(),
        detail: `The remote browser disconnected (${reason}). Huddle did not keep a session it cannot reach. ${releaseDetail}`
      },
      true
    )
  }
}
