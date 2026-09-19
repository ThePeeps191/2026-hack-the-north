/**
 * Live verification run for the browser host — real Browserbase, real CDP.
 *
 * It is a script, not a test double: every step below drives the same
 * `createBrowserHost` the app uses, against the real provider, and prints raw
 * output. Run it from the repo root:
 *
 *   node --experimental-strip-types src/main/browser/verify.ts
 *
 * and for the unconfigured path (no key, no project id, no .env in sight):
 *
 *   node --experimental-strip-types src/main/browser/verify.ts --unconfigured
 *
 * It creates at most two paid sessions and closes both. Screenshots are written
 * under <data root>/browser-verify so the PNG bytes can be inspected by hand.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Artifact, BrowserSessionRecord, WorkspaceRecord } from '../../shared/types.ts'
import { DEFAULT_SETTINGS } from '../../shared/types.ts'
import { createFakeBus } from '../exec/fake-bus.ts'
import { secretOrigin } from '../config/secrets.ts'
import { dataRoot } from '../paths.ts'
import { clientFor, peekCredentials } from './credentials.ts'
import { HuddleError } from '../huddle-error.ts'
import { createBrowserHost } from './index.ts'
import { pngSize } from './page-scripts.ts'

const RUN_UNCONFIGURED = process.argv.includes('--unconfigured')

if (RUN_UNCONFIGURED) {
  // Point Huddle's secret store at a directory that has no .env, so the run
  // really is unconfigured rather than pretending by hiding a real key.
  const emptyRoot = join(process.cwd(), '.data', 'verify-unconfigured-root')
  mkdirSync(emptyRoot, { recursive: true })
  process.env.HUDDLE_APP_ROOT = emptyRoot
  process.env.HUDDLE_DATA_ROOT = join(process.cwd(), '.data', 'verify-unconfigured-data')
  process.env.BROWSERBASE_API_KEY = ''
  process.env.BROWSERBASE_PROJECT_ID = ''
}

const ROOM_ID = 'verify-room'
const AGENT_ID = 'verify-agent'
const PublicPage = 'https://example.com'

function line(label: string, text: string): void {
  console.log(`${label} ${text}`)
}

function step(name: string, ok: boolean, detail: string): void {
  console.log(`\n=== ${ok ? 'OK  ' : 'FAIL'} · ${name} ===`)
  console.log(detail)
}

function describeThrown(error: unknown): string {
  if (error instanceof HuddleError) {
    return [
      `code: ${error.code}`,
      `message: ${error.message}`,
      `fix: ${error.fix ?? '(none)'}`
    ].join('\n')
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

async function main(): Promise<void> {
  console.log('Huddle browser host — live verification')
  line('data root is', dataRoot())
  line('app root is', process.env.HUDDLE_APP_ROOT ?? '(default: cwd)')
  line('BROWSERBASE_API_KEY origin:', secretOrigin('BROWSERBASE_API_KEY'))
  line('BROWSERBASE_PROJECT_ID origin:', secretOrigin('BROWSERBASE_PROJECT_ID'))

  const artifacts = join(dataRoot(), 'browser-verify')
  mkdirSync(artifacts, { recursive: true })

  const bus = createFakeBus()
  const records: BrowserSessionRecord[] = []
  bus.upsertBrowserSession = (record: BrowserSessionRecord): void => {
    records.push(record)
    console.log(`  [bus] browser.upserted ${record.status} · ${record.detail}`)
  }
  bus.notice = (roomId: string, level: 'info' | 'warn' | 'error', text: string, fix?: string): void => {
    console.log(`  [notice] ${level} · ${text}${fix !== undefined ? ` — ${fix}` : ''}`)
  }

  const workspace: WorkspaceRecord = {
    id: 'verify-workspace',
    roomId: ROOM_ID,
    agentId: null,
    kind: 'team',
    label: 'Team project',
    rootPath: process.cwd(),
    branch: null,
    baseBranch: null,
    isWorktree: false,
    devPort: null,
    devJobId: null,
    createdAt: new Date().toISOString(),
    lastVerifiedRevision: null
  }
  bus.workspaces.set(workspace.id, workspace)

  const preview: { publicUrl: string | null; state: 'starting' | 'ready' | 'failed' | 'off' } = {
    publicUrl: null,
    state: 'failed'
  }

  const exec = {
    artifactDir: (_roomId: string): string => artifacts,
    getPreview: (_roomId: string, _workspaceId: string) =>
      preview.publicUrl === null && preview.state === 'off'
        ? null
        : {
            roomId: ROOM_ID,
            workspaceId: workspace.id,
            publicUrl: preview.publicUrl,
            localUrl: 'http://127.0.0.1:5173',
            mode: 'lan' as const,
            state: preview.state,
            detail: 'Verification stub: the LAN preview is not reachable from the cloud by design.'
          },
    writeArtifact: async (input: {
      roomId: string
      agentId: string | null
      taskId: string | null
      kind: Artifact['kind']
      title: string
      filename: string
      data: Buffer | string
      mime: string
    }): Promise<Artifact> => {
      const target = join(artifacts, input.filename)
      const buffer = typeof input.data === 'string' ? Buffer.from(input.data, 'utf8') : input.data
      writeFileSync(target, buffer)
      const artifact: Artifact = {
        id: `artifact-${String(records.length)}-${input.filename}`,
        roomId: input.roomId,
        agentId: input.agentId,
        taskId: input.taskId,
        kind: input.kind,
        title: input.title,
        path: target,
        mime: input.mime,
        bytes: buffer.byteLength,
        createdAt: new Date().toISOString()
      }
      bus.addArtifact(artifact)
      return artifact
    }
  }

  const host = createBrowserHost({ bus, exec, settings: () => DEFAULT_SETTINGS })

  /* ------------------------------------------------------------------ *
   * The unconfigured path
   * ------------------------------------------------------------------ */

  if (RUN_UNCONFIGURED) {
    try {
      await host.openSession({ roomId: ROOM_ID, agentId: AGENT_ID, url: PublicPage })
      step('openSession with no credentials', false, 'It resolved. That is a fake session and must not happen.')
    } catch (error) {
      const text = describeThrown(error)
      const good =
        error instanceof HuddleError &&
        error.code === 'browserbase_unconfigured' &&
        error.message.includes('BROWSERBASE_API_KEY') &&
        error.fix !== null
      step('openSession with no credentials refuses with a fix', good, text)
    }
    console.log(`\nrecords published during the refusal: ${String(records.length)}`)
    await host.dispose()
    console.log('done')
    return
  }

  /* ------------------------------------------------------------------ *
   * Live run
   * ------------------------------------------------------------------ */

  const credentials = peekCredentials()
  if (credentials === null) {
    console.log('\nNo credentials in this shell. Re-run with --unconfigured to check that path.')
    process.exitCode = 2
    return
  }

  console.log('\n--- 1. a local URL is refused before anything is typed into a remote browser ---')
  // A session is needed to test `act`, so this uses the preview refusal instead:
  // no URL was passed and the stub preview exposes no public address.
  try {
    await host.openSession({ roomId: ROOM_ID, agentId: AGENT_ID })
    step('openSession with an unreachable preview', false, 'It resolved; a session was created anyway.')
  } catch (error) {
    const good = error instanceof HuddleError && error.code === 'preview_unreachable' && error.fix !== null
    step('openSession with an unreachable preview refuses with a fix', good, describeThrown(error))
  }

  console.log('\n--- 2. open a real session on a public page ---')
  let session: BrowserSessionRecord | null = null
  try {
    session = await host.openSession({ roomId: ROOM_ID, agentId: AGENT_ID, url: PublicPage })
  } catch (error) {
    step('openSession created a live session', false, describeThrown(error))
    await host.dispose()
    process.exitCode = 1
    return
  }
  if (session === null) {
    step('openSession created a live session', false, 'It returned nothing.')
    await host.dispose()
    process.exitCode = 1
    return
  }
  const opened: BrowserSessionRecord = session
  const sessionId = opened.id
  step(
    'openSession created a live session',
    opened.status === 'live' && opened.remoteId !== null,
    [
      `id: ${opened.id}`,
      `remoteId: ${opened.remoteId ?? '(none)'}`,
      `status: ${opened.status}`,
      `currentUrl: ${opened.currentUrl ?? '(none)'}`,
      `title: ${opened.title ?? '(none)'}`,
      `liveViewUrl: ${opened.liveViewUrl ?? '(none)'}`,
      `detail: ${opened.detail}`
    ].join('\n')
  )

  console.log('\n--- 3. a localhost target is refused with an explanation ---')
  const localResult = await host.act({ sessionId, action: { kind: 'navigate', url: 'http://localhost:5173' } })
  step(
    'navigate to localhost is refused',
    !localResult.ok && localResult.detail.includes('localhost'),
    localResult.detail
  )

  console.log('\n--- 4. observe the real page ---')
  const observation = await host.observe(sessionId)
  step(
    'observe returned text and interactive refs',
    observation.elements.length > 0,
    [
      `url: ${observation.url}`,
      `title: ${observation.title}`,
      `text (${String(observation.text.length)} chars, first 400):`,
      observation.text.slice(0, 400),
      `elements (${String(observation.elements.length)}):`,
      ...observation.elements.map(
        (element) => `  ${element.ref} · ${element.role} · "${element.name}" · ${element.selector}`
      )
    ].join('\n')
  )

  console.log('\n--- 5. real mouse strokes (example.com has no canvas, so the pixel check says so) ---')
  const drawResult = await host.act({ sessionId, action: { kind: 'draw', selector: 'h1', strokes: 2 } })
  step('draw sent real strokes and counted the events that landed', drawResult.ok, drawResult.detail)

  console.log('\n--- 6. click a real link and read the URL it produced ---')
  const linkSelector =
    observation.elements.find((element) => element.role === 'link')?.selector ?? 'a'
  const clickResult = await host.act({ sessionId, action: { kind: 'click', selector: linkSelector } })
  step(
    'click changed the page',
    clickResult.ok,
    `${clickResult.detail}\nurl after the click: ${clickResult.observation?.url ?? '(no observation)'}`
  )

  console.log('\n--- 7. screenshot -> artifact on disk ---')
  const screenshot = await host.screenshot(sessionId)
  const artifactPath = screenshot.artifact.path
  const saved = artifactPath !== null && existsSync(artifactPath) ? readFileSync(artifactPath) : Buffer.alloc(0)
  const onDisk = artifactPath === null ? 0 : statSync(artifactPath).size
  step(
    'screenshot wrote real PNG bytes',
    screenshot.artifact.bytes !== null && screenshot.artifact.bytes > 0,
    [
      `artifact path: ${artifactPath ?? '(none)'}`,
      `artifact bytes: ${String(screenshot.artifact.bytes)}`,
      `file size on disk: ${String(onDisk)}`,
      `png header size: ${JSON.stringify(pngSize(saved))}`,
      `reported viewport: ${String(screenshot.viewport.width)}×${String(screenshot.viewport.height)}`,
      `url: ${screenshot.url}`,
      `data URL: ${String(screenshot.dataUrl.length)} characters, starts with ${screenshot.dataUrl.slice(0, 22)}`
    ].join('\n')
  )

  console.log('\n--- 8. network payloads captured from the session ---')
  const captures = await host.network(sessionId)
  step(
    'network captured real responses with bodies',
    captures.length > 0,
    [
      `${String(captures.length)} response(s) captured`,
      ...captures.slice(0, 3).map(
        (entry) =>
          `  ${String(entry.status)} ${entry.method} ${entry.url}\n    body: ${entry.body.replace(/\s+/g, ' ').slice(0, 200)}`
      )
    ].join('\n')
  )

  console.log('\n--- 9. close the session and confirm it ended at Browserbase ---')
  await host.closeSession(sessionId)
  const closed = host.getSession(sessionId)
  let remoteStatus = '(not checked)'
  if (opened.remoteId !== null) {
    try {
      const remote = await clientFor(credentials).sessions.retrieve(opened.remoteId)
      remoteStatus = `${remote.status}${remote.endedAt === undefined ? '' : ` at ${remote.endedAt}`}`
    } catch (error) {
      remoteStatus = `could not be retrieved: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  step(
    'closeSession marked the record closed and Browserbase agrees',
    closed !== null && closed.status === 'closed' && !remoteStatus.startsWith('RUNNING'),
    [
      `record status: ${closed === null ? '(missing)' : closed.status}`,
      `record detail: ${closed === null ? '(missing)' : closed.detail}`,
      `record endedAt: ${closed === null ? '(missing)' : (closed.endedAt ?? '(none)')}`,
      `Browserbase reports: ${remoteStatus}`
    ].join('\n')
  )

  console.log('\n--- 10. reconcile never resurrects a session ---')
  await host.reconcile([{ ...(closed ?? opened), status: 'live' }])
  const reconciled = records[records.length - 1]
  step(
    'reconcile wrote back a terminal status',
    reconciled.status === 'closed' || reconciled.status === 'failed',
    `status: ${reconciled.status}\ndetail: ${reconciled.detail}`
  )

  await host.dispose()
  console.log(`\nupserts published during this run: ${String(records.length)}`)
  console.log('done')
}

main().catch((error: unknown) => {
  console.error('verification run failed:', describeThrown(error))
  process.exitCode = 1
})
