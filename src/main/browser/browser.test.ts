import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { BrowserContext } from 'playwright-core'
import type { PreviewInfo } from '../../shared/api.ts'
import type { BrowserSessionRecord, WorkspaceRecord } from '../../shared/types.ts'
import { DEFAULT_SETTINGS } from '../../shared/types.ts'
import { createFakeBus } from '../exec/fake-bus.ts'
import { HuddleError } from '../huddle-error.ts'
import { createBrowserHost } from './index.ts'
import { requireCredentials } from './credentials.ts'
import { NetworkRecorder } from './network.ts'
import {
  isTunnelReminderPage,
  isViteBlockedHostPage,
  looksLikeTunnelUrl,
  planStrokes,
  pngSize,
  readObservation,
  summarizeObservation,
  toObservation,
  TUNNEL_REMINDER_SCRIPT,
  tunnelContinueLabel
} from './page-scripts.ts'
import { checkRemoteTarget } from './targets.ts'

/**
 * What these tests can and cannot prove.
 *
 * Everything below runs without the network: URL policy, the PNG reader, stroke
 * geometry, observation parsing, the network recorder's body bounding, the
 * credential refusals, and the rule that `openSession` refuses rather than
 * publishing a record that looks live. The live Browserbase behaviour is checked
 * separately by `node --experimental-strip-types src/main/browser/verify.ts`,
 * because no unit test may claim a remote browser was driven.
 */

// A fake key means the credential checks pass while nothing can reach a provider,
// and a scratch app root keeps the repository's real .env out of these tests.
process.env.HUDDLE_APP_ROOT = mkdtempSync(join(tmpdir(), 'huddle-browser-root-'))
process.env.HUDDLE_DATA_ROOT = mkdtempSync(join(tmpdir(), 'huddle-browser-data-'))
process.env.BROWSERBASE_API_KEY = 'bb_test_only'
process.env.BROWSERBASE_PROJECT_ID = 'project_test_only'

const ROOM_ID = 'room-1'
const AGENT_ID = 'agent-1'

function workspace(): WorkspaceRecord {
  return {
    id: 'workspace-1',
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
}

function lanPreview(): PreviewInfo {
  return {
    roomId: ROOM_ID,
    workspaceId: 'workspace-1',
    publicUrl: 'http://192.168.1.5:5173',
    localUrl: 'http://localhost:5173',
    mode: 'lan',
    state: 'ready',
    detail: 'Serving from http://localhost:5173, reachable on your network.'
  }
}

function errorCode(run: () => unknown): string | null {
  try {
    run()
    return null
  } catch (error) {
    return error instanceof HuddleError ? error.code : `not-huddle: ${String(error)}`
  }
}

async function asyncErrorCode(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (error) {
    return error instanceof HuddleError ? error.code : `not-huddle: ${String(error)}`
  }
}

interface Harness {
  host: ReturnType<typeof createBrowserHost>
  records: BrowserSessionRecord[]
  notices: Array<{ level: string; text: string; fix: string | undefined }>
}

function harness(preview: PreviewInfo | null, enabled = true): Harness {
  const bus = createFakeBus()
  bus.workspaces.set(workspace().id, workspace())
  const records: BrowserSessionRecord[] = []
  const notices: Array<{ level: string; text: string; fix: string | undefined }> = []
  bus.upsertBrowserSession = (record: BrowserSessionRecord): void => {
    records.push(record)
  }
  bus.notice = (
    _roomId: string,
    level: 'info' | 'warn' | 'error',
    text: string,
    fix?: string
  ): void => {
    notices.push({ level, text, fix })
  }
  const host = createBrowserHost({
    bus,
    exec: {
      artifactDir: (): string => join(process.cwd(), '.data', 'browser-test-artifacts'),
      getPreview: (): PreviewInfo | null => preview,
      writeArtifact: async (input) => ({
        id: 'artifact-1',
        roomId: input.roomId,
        agentId: input.agentId,
        taskId: input.taskId,
        kind: input.kind,
        title: input.title,
        path: null,
        mime: input.mime,
        bytes: typeof input.data === 'string' ? input.data.length : input.data.byteLength,
        createdAt: new Date().toISOString()
      })
    },
    settings: () => ({ ...DEFAULT_SETTINGS, browserbaseEnabled: enabled })
  })
  return { host, records, notices }
}

function persistedLive(): BrowserSessionRecord {
  return {
    id: 'session-persisted',
    roomId: ROOM_ID,
    agentId: AGENT_ID,
    provider: 'browserbase',
    remoteId: 'remote-persisted',
    liveViewUrl: null,
    status: 'live',
    currentUrl: 'https://example.com/',
    title: 'Example',
    startedAt: new Date().toISOString(),
    endedAt: null,
    error: null,
    detail: 'was live before the restart'
  }
}

describe('remote URL policy', () => {
  test('accepts a public https URL and normalises it', () => {
    const check = checkRemoteTarget('https://example.com')
    assert.equal(check.ok, true)
    assert.equal(check.ok ? check.url : '', 'https://example.com/')
  })

  test('refuses this laptop and says why, with a next step', () => {
    for (const url of [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://0.0.0.0:3000',
      'http://[::1]:3000'
    ]) {
      const check = checkRemoteTarget(url)
      assert.equal(check.ok, false, `${url} should be refused`)
      if (!check.ok) {
        assert.match(check.detail, /Browserbase/)
        assert.ok(check.fix.length > 0)
      }
    }
  })

  test('refuses private network addresses', () => {
    for (const url of ['http://192.168.1.5:5173', 'http://10.0.0.9', 'http://172.20.1.1', 'http://box.local']) {
      const check = checkRemoteTarget(url)
      assert.equal(check.ok, false, `${url} should be refused`)
      if (!check.ok) assert.match(check.detail, /private|only resolves inside this network/)
    }
  })

  test('refuses anything that is not an absolute http(s) page', () => {
    const relative = checkRemoteTarget('/index.html')
    assert.equal(relative.ok, false)
    const file = checkRemoteTarget('file:///C:/Windows/System32/drivers/etc/hosts')
    assert.equal(file.ok, false)
    if (!file.ok) assert.match(file.detail, /http\(s\)/)
    const empty = checkRemoteTarget('   ')
    assert.equal(empty.ok, false)
  })
})

describe('credentials', () => {
  test('a disabled capability is refused before any session exists', () => {
    const code = errorCode(() =>
      requireCredentials({ ...DEFAULT_SETTINGS, browserbaseEnabled: false })
    )
    assert.equal(code, 'browserbase_disabled')
  })

  test('the configured key is read from the environment, not from the dotenv file', () => {
    const credentials = requireCredentials({ ...DEFAULT_SETTINGS })
    assert.equal(credentials.apiKey, 'bb_test_only')
    assert.equal(credentials.projectId, 'project_test_only')
    assert.equal(credentials.origin, 'env')
  })
})

describe('PNG reading', () => {
  test('reads real IHDR dimensions', () => {
    const header = Buffer.alloc(24)
    header.writeUInt32BE(0x89504e47, 0)
    header.writeUInt32BE(0x0d0a1a0a, 4)
    header.write('IHDR', 12, 4, 'ascii')
    header.writeUInt32BE(1440, 16)
    header.writeUInt32BE(900, 20)
    assert.deepEqual(pngSize(header), { width: 1440, height: 900 })
  })

  test('refuses bytes that are not a PNG', () => {
    assert.equal(pngSize(Buffer.from('this is not a png image, it is just text')), null)
    assert.equal(pngSize(Buffer.alloc(4)), null)
  })
})

describe('stroke geometry', () => {
  const box = { x: 100, y: 50, width: 200, height: 100 }

  test('every stroke point stays inside the element box', () => {
    const plans = planStrokes(box, 3)
    assert.equal(plans.length, 3)
    for (const stroke of plans) {
      for (const point of stroke.points) {
        assert.ok(point.x >= box.x && point.x <= box.x + box.width, `x ${String(point.x)}`)
        assert.ok(point.y >= box.y && point.y <= box.y + box.height, `y ${String(point.y)}`)
      }
    }
  })

  test('the number of strokes is bounded', () => {
    assert.equal(planStrokes(box, 0).length, 1)
    assert.equal(planStrokes(box, 99).length, 12)
  })
})

describe('observation parsing', () => {
  test('keeps only elements that can actually be acted on', () => {
    const parsed = readObservation({
      url: 'https://example.com/',
      title: 'Example',
      text: 'hello',
      elements: [
        { ref: 'e1', role: 'link', name: 'More information', selector: 'a' },
        { ref: 'e2', role: 'button', name: 'no selector', selector: '' }
      ],
      interactiveCount: 2,
      elementCount: 7
    })
    assert.equal(parsed.elements.length, 1)
    assert.equal(parsed.elements[0].selector, 'a')
    assert.equal(parsed.iframeCount, 0)
  })

  test('never reports more than the contract shape', () => {
    const parsed = readObservation({ elements: [{ ref: 'e1', role: 'link', name: 'x', selector: 'a' }] })
    const observation = toObservation(parsed, 'about:blank', 'text')
    assert.deepEqual(Object.keys(observation.elements[0]).sort(), ['name', 'ref', 'role', 'selector'])
    assert.equal(observation.url, 'about:blank')
  })

  test('the text summary is bounded and mentions real iframes', () => {
    const parsed = readObservation({
      url: 'https://example.com/',
      title: 't',
      text: 'x'.repeat(9000),
      elements: [],
      interactiveCount: 0,
      elementCount: 3,
      iframeCount: 2
    })
    const text = summarizeObservation(parsed, '', 4000)
    assert.ok(text.length <= 4200, `summary was ${String(text.length)} characters`)
    assert.match(text, /iframe\(s\) are present/)
  })
})

describe('network capture', () => {
  interface FakeResponse {
    url: () => string
    status: () => number
    request: () => { method: () => string }
    headers: () => Record<string, string>
    text: () => Promise<string>
  }

  function response(init: {
    url: string
    method: string
    status: number
    contentType: string
    body: string
    length?: string
  }): FakeResponse {
    return {
      url: () => init.url,
      status: () => init.status,
      request: () => ({ method: () => init.method }),
      headers: () => ({
        'content-type': init.contentType,
        'content-length': init.length ?? String(init.body.length)
      }),
      text: async () => init.body
    }
  }

  async function record(responses: FakeResponse[]): Promise<NetworkRecorder> {
    const recorder = new NetworkRecorder()
    const listeners: Array<(item: unknown) => void> = []
    const fakePage = {
      on: (event: string, listener: (item: unknown) => void): void => {
        if (event === 'response') listeners.push(listener)
      }
    }
    const fakeContext = {
      pages: () => [fakePage],
      on: (): void => undefined
    }
    // A real BrowserContext cannot be built in a unit test; the recorder only
    // uses `pages()` and `on('page')`, both of which the fake provides.
    recorder.attach(fakeContext as unknown as BrowserContext)
    for (const item of responses) {
      for (const listener of listeners) listener(item)
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20)
    })
    return recorder
  }

  test('captures a JSON payload with its real body', async () => {
    const recorder = await record([
      response({
        url: 'https://app.test/api/votes',
        method: 'GET',
        status: 200,
        contentType: 'application/json',
        body: '{"votes":[{"id":1}]}'
      })
    ])
    const entries = recorder.list()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].status, 200)
    assert.equal(entries[0].method, 'GET')
    assert.equal(entries[0].body, '{"votes":[{"id":1}]}')
    assert.equal(recorder.list('votes').length, 1)
    assert.equal(recorder.list('nothing-matches').length, 0)
  })

  test('records binary responses by type and length instead of dropping them', async () => {
    const recorder = await record([
      response({
        url: 'https://app.test/logo.png',
        method: 'GET',
        status: 200,
        contentType: 'image/png',
        body: 'binary',
        length: '2048'
      })
    ])
    const entries = recorder.list()
    assert.equal(entries.length, 1)
    assert.match(entries[0].body, /\[not read: image\/png/)
    assert.match(entries[0].body, /2048/)
  })

  test('marks a body that had to be truncated', async () => {
    const recorder = await record([
      response({
        url: 'https://app.test/api/big',
        method: 'GET',
        status: 200,
        contentType: 'application/json',
        body: 'x'.repeat(9000)
      })
    ])
    const body = recorder.list()[0].body
    assert.ok(body.length < 9000)
    assert.match(body, /\[body truncated/)
  })

  test('a 204 has no body and is still recorded', async () => {
    const recorder = await record([
      response({
        url: 'https://app.test/api/ping',
        method: 'POST',
        status: 204,
        contentType: 'application/json',
        body: 'ignored'
      })
    ])
    assert.equal(recorder.list()[0].body, '')
  })
})

describe('refusals instead of fake sessions', () => {
  test('no preview means no session, and no record is published', async () => {
    const { host, records } = harness(null)
    const code = await asyncErrorCode(() => host.openSession({ roomId: ROOM_ID, agentId: AGENT_ID }))
    assert.equal(code, 'preview_unreachable')
    assert.equal(records.length, 0)
    await host.dispose()
  })

  test('a LAN-only preview is refused with the tunnel next step', async () => {
    const { host, records } = harness(lanPreview())
    const code = await asyncErrorCode(() => host.openSession({ roomId: ROOM_ID, agentId: AGENT_ID }))
    assert.equal(code, 'preview_unreachable')
    assert.equal(records.length, 0)
    await host.dispose()
  })

  test('an explicit localhost URL is refused before anything is typed into a browser', async () => {
    const { host, records } = harness(lanPreview())
    const code = await asyncErrorCode(() =>
      host.openSession({ roomId: ROOM_ID, agentId: AGENT_ID, url: 'http://localhost:5173' })
    )
    assert.equal(code, 'remote_url_unreachable')
    assert.equal(records.length, 0)
    await host.dispose()
  })

  test('unknown session ids are named, not invented', async () => {
    const { host } = harness(lanPreview())
    assert.equal(host.getSession('nope'), null)
    assert.equal(await asyncErrorCode(() => host.closeSession('nope')), 'browser_session_unknown')
    assert.equal(await asyncErrorCode(() => host.observe('nope')), 'browser_session_unknown')
    assert.equal(await asyncErrorCode(() => host.network('nope')), 'browser_session_unknown')
    assert.equal(
      await asyncErrorCode(() => host.act({ sessionId: 'nope', action: { kind: 'press', key: 'Enter' } })),
      'browser_session_unknown'
    )
    await host.dispose()
  })

  test('a disabled host refuses to open a session', async () => {
    const { host, records } = harness(lanPreview(), false)
    const code = await asyncErrorCode(() => host.openSession({ roomId: ROOM_ID, agentId: AGENT_ID }))
    assert.equal(code, 'browserbase_disabled')
    assert.equal(records.length, 0)
    await host.dispose()
  })
})

describe('restart reconciliation', () => {
  test('a persisted live session with no provider id is failed, not resurrected', async () => {
    const { host, records } = harness(lanPreview())
    await host.reconcile([{ ...persistedLive(), remoteId: null }])
    const last = records[records.length - 1]
    assert.equal(last.status, 'failed')
    assert.match(last.detail, /Nothing is attached to it now/)
    assert.ok(last.endedAt !== null)
    await host.dispose()
  })

  test('with Browserbase switched off the record is failed with a truthful reason', async () => {
    const { host, records, notices } = harness(lanPreview(), false)
    await host.reconcile([persistedLive()])
    const last = records[records.length - 1]
    assert.equal(last.status, 'failed')
    assert.match(last.detail, /did not check/)
    assert.equal(notices.length, 1)
    assert.equal(notices[0].level, 'warn')
    await host.dispose()
  })
})

describe('tunnel reminder detection', () => {
  test('recognises the current localtunnel interstitial title', () => {
    assert.equal(
      isTunnelReminderPage({
        title: 'Tunnel website ahead!',
        text: 'This website is served via a tunnel. Continue to visit the site.',
        markup: '<html><head><title>Tunnel website ahead!</title></head></html>'
      }),
      true
    )
  })

  test('recognises the older tunnel password reminder', () => {
    assert.equal(
      isTunnelReminderPage({
        title: 'localtunnel',
        text: 'Tunnel Password. This is a reminder page.',
        markup: '<meta name="bypass-tunnel-reminder">'
      }),
      true
    )
  })

  test('does not treat a real app page as a tunnel notice', () => {
    assert.equal(
      isTunnelReminderPage({
        title: 'Sketch Night',
        text: 'Draw a sketch. Vote anonymously.',
        markup: '<div id="root">Sketch Night</div>'
      }),
      false
    )
  })

  test('recognises a Vite blocked-host refusal', () => {
    assert.equal(
      isViteBlockedHostPage({
        title: '',
        text: 'Blocked request. This host ("abc.loca.lt") is not allowed.\nTo allow this host, add "abc.loca.lt" to server.allowedHosts in vite.config.js.',
        markup: ''
      }),
      true
    )
    assert.equal(
      isViteBlockedHostPage({
        title: 'Sketch Night',
        text: 'Draw a sketch.',
        markup: ''
      }),
      false
    )
  })

  test('matches public tunnel hostnames and continue-button labels', () => {
    assert.equal(looksLikeTunnelUrl('https://huddle-room.loca.lt'), true)
    assert.equal(looksLikeTunnelUrl('https://demo.localtunnel.me/'), true)
    assert.equal(looksLikeTunnelUrl('https://example.com/app'), false)
    assert.equal(tunnelContinueLabel('Continue'), true)
    assert.equal(tunnelContinueLabel('Click Continue'), true)
    assert.equal(tunnelContinueLabel('Vote'), false)
  })

  test('the in-page detector still matches the current interstitial title', () => {
    assert.match(TUNNEL_REMINDER_SCRIPT, /tunnel website ahead/)
  })
})
