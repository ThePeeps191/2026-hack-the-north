import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { DEFAULT_SETTINGS, STATE_VERSION, type PersistedState } from '../shared/types.ts'
import { JsonSnapshotStore } from './json-store.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'huddle-store-'))
}

async function tempFile(): Promise<string> {
  return join(await tempDir(), 'huddle-state.json')
}

function emptyState(): PersistedState {
  return {
    version: STATE_VERSION,
    rooms: [],
    agents: [],
    messages: [],
    tasks: [],
    decisions: [],
    toolRuns: [],
    jobs: [],
    browserSessions: [],
    artifacts: [],
    workspaces: [],
    integrations: [],
    memories: [],
    settings: structuredClone(DEFAULT_SETTINGS),
    selectedRoomId: null,
    lastSeq: 0
  }
}

describe('JsonSnapshotStore', () => {
  test('missing file is a first launch, not an error', async () => {
    const store = new JsonSnapshotStore(await tempFile())
    const result = await store.read()
    assert.equal(result.kind, 'missing')
  })

  test('writes a snapshot atomically and reads it back', async () => {
    const filePath = await tempFile()
    const store = new JsonSnapshotStore(filePath)
    const state = emptyState()
    state.lastSeq = 4
    await store.write(state)

    const result = await store.read()
    assert.equal(result.kind, 'ok')
    if (result.kind === 'ok') {
      assert.equal(result.data.lastSeq, 4)
      assert.equal(result.data.version, STATE_VERSION)
      assert.equal(result.migratedFrom, null)
    }

    const raw = await readFile(filePath, 'utf8')
    assert.equal(JSON.parse(raw).lastSeq, 4)
  })

  test('corrupt state is copied aside without deleting the original bytes', async () => {
    const filePath = await tempFile()
    const original = '{ this is not json'
    await writeFile(filePath, original, 'utf8')

    const store = new JsonSnapshotStore(filePath)
    const result = await store.read()
    assert.equal(result.kind, 'corrupt')
    if (result.kind !== 'corrupt') return

    assert.equal(await readFile(filePath, 'utf8'), original)
    assert.ok(result.backupPath)
    const backup = await readFile(result.backupPath, 'utf8')
    assert.equal(backup, original)
    assert.match(result.backupPath, /\.corrupt-/)
  })

  test('an unsupported future version is reported as unreadable, not silently reset', async () => {
    const filePath = await tempFile()
    await writeFile(filePath, JSON.stringify({ version: 99, rooms: [] }), 'utf8')
    const store = new JsonSnapshotStore(filePath)
    const result = await store.read()
    assert.equal(result.kind, 'corrupt')
    if (result.kind === 'corrupt') {
      assert.match(result.reason, /newer version/i)
    }
  })

  test('a valid v1 snapshot is migrated, not treated as corruption', async () => {
    const dir = await tempDir()
    const filePath = join(dir, 'huddle-state.json')
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        rooms: [
          {
            id: 'room-1',
            name: 'Old room',
            description: 'Make the canvas nicer',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            workspace: { kind: 'team', focus: 'code' }
          }
        ],
        agents: [
          {
            id: 'agent-1',
            roomId: 'room-1',
            presetId: 'maya',
            name: 'Maya',
            role: 'frontend',
            workState: 'not_connected',
            speechState: 'not_connected'
          }
        ],
        messages: [
          {
            id: 'm-1',
            roomId: 'room-1',
            author: { type: 'human' },
            body: 'hello',
            createdAt: '2025-01-01T00:00:10.000Z',
            clientRequestId: 'v1-1'
          }
        ],
        selectedRoomId: 'room-1',
        lastSeq: 12
      }),
      'utf8'
    )

    const store = new JsonSnapshotStore(filePath)
    const result = await store.read()
    assert.equal(result.kind, 'ok')
    if (result.kind !== 'ok') return

    assert.equal(result.migratedFrom, 1)
    assert.equal(result.data.version, STATE_VERSION)
    assert.equal(result.data.rooms[0].goal, 'Make the canvas nicer')
    assert.deepEqual(result.data.rooms[0].stage.mode, { kind: 'gallery' })
    assert.equal(result.data.rooms[0].joined, false)
    assert.equal(result.data.agents[0].workState, 'offline')
    assert.equal(result.data.agents[0].speechState, 'silent')
    assert.equal(result.data.messages[0].body, 'hello')
    assert.equal(result.data.messages[0].kind, 'chat')
    assert.equal(result.data.lastSeq, 12)
    assert.equal(result.data.selectedRoomId, 'room-1')

    // The pre-migration file is kept beside the migrated one.
    const files = await readdir(dir)
    assert.ok(files.some((name) => /\.v1-.*\.bak$/.test(name)), `expected a v1 backup in ${files.join(', ')}`)
  })

  test('a write that cannot complete leaves the previous file intact', async () => {
    const filePath = await tempFile()
    const store = new JsonSnapshotStore(filePath)
    const state = emptyState()
    state.lastSeq = 7
    await store.write(state)
    const before = await readFile(filePath, 'utf8')

    // A circular structure cannot be serialised, so the write fails before the
    // destination is touched. The previous file must still be the good one.
    const broken = emptyState() as PersistedState & { self?: unknown }
    broken.self = broken
    await assert.rejects(() => store.write(broken), /circular/i)
    assert.equal(await readFile(filePath, 'utf8'), before)
  })

  test('invalid JSON shape is refused instead of guessed at', async () => {
    const filePath = await tempFile()
    await writeFile(filePath, JSON.stringify({ hello: 'world' }), 'utf8')
    const store = new JsonSnapshotStore(filePath)
    const result = await store.read()
    assert.equal(result.kind, 'corrupt')
    if (result.kind === 'corrupt') {
      assert.match(result.reason, /version/i)
    }
  })
})
