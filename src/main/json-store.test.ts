import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { JsonSnapshotStore } from './json-store.ts'
import type { PersistedState } from '../shared/types.ts'

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'huddle-store-'))
  return join(dir, 'huddle-state.json')
}

function emptyState(): PersistedState {
  return {
    version: 1,
    rooms: [],
    agents: [],
    messages: [],
    selectedRoomId: null,
    events: [],
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
      assert.equal(result.data.version, 1)
    }

    const raw = await readFile(filePath, 'utf8')
    assert.equal(JSON.parse(raw).lastSeq, 4)
  })

  test('corrupt state is copied aside and reported without deleting the original bytes', async () => {
    const filePath = await tempFile()
    const original = '{ this is not json'
    await writeFile(filePath, original, 'utf8')

    const store = new JsonSnapshotStore(filePath)
    const result = await store.read()
    assert.equal(result.kind, 'corrupt')
    if (result.kind !== 'corrupt') {
      return
    }

    const leftover = await readFile(filePath, 'utf8')
    assert.equal(leftover, original)

    const backup = await readFile(result.backupPath, 'utf8')
    assert.equal(backup, original)
    assert.match(result.backupPath, /\.corrupt-/)
  })

  test('unsupported version is treated as corrupt', async () => {
    const filePath = await tempFile()
    await writeFile(filePath, JSON.stringify({ version: 99, rooms: [] }), 'utf8')
    const store = new JsonSnapshotStore(filePath)
    const result = await store.read()
    assert.equal(result.kind, 'corrupt')
  })
})
