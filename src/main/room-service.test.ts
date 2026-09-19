import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { JsonSnapshotStore } from './json-store.ts'
import { RoomService } from './room-service.ts'

async function openService(): Promise<{ service: RoomService; filePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'huddle-room-'))
  const filePath = join(dir, 'huddle-state.json')
  const service = await RoomService.open(new JsonSnapshotStore(filePath))
  return { service, filePath }
}

describe('RoomService', () => {
  test('a clean launch creates exactly one default room with Maya', async () => {
    const { service } = await openService()
    const snap = service.getSnapshot()
    assert.equal(snap.rooms.length, 1)
    assert.equal(snap.rooms[0].name, 'New project')
    assert.equal(snap.agents.length, 1)
    assert.equal(snap.agents[0].name, 'Maya')
    assert.equal(snap.agents[0].presetId, 'maya')
    assert.equal(snap.agents[0].workState, 'not_connected')
    assert.equal(snap.agents[0].speechState, 'not_connected')
    assert.equal(snap.selectedRoomId, snap.rooms[0].id)
    assert.equal(snap.messages.length, 0)
  })

  test('creating and switching rooms keeps messages in the correct room', async () => {
    const { service } = await openService()
    const first = service.getSnapshot().rooms[0]
    await service.sendMessage({
      roomId: first.id,
      body: 'hello from first',
      clientRequestId: 'req-first'
    })

    const second = await service.createRoom({ name: 'Second room' })
    await service.sendMessage({
      roomId: second.id,
      body: 'hello from second',
      clientRequestId: 'req-second'
    })

    await service.selectRoom(first.id)
    const snap = service.getSnapshot()
    assert.equal(snap.selectedRoomId, first.id)
    assert.equal(snap.rooms.length, 2)
    const firstMessages = snap.messages.filter((message) => message.roomId === first.id)
    const secondMessages = snap.messages.filter((message) => message.roomId === second.id)
    assert.equal(firstMessages.length, 1)
    assert.equal(firstMessages[0].body, 'hello from first')
    assert.equal(secondMessages.length, 1)
    assert.equal(secondMessages[0].body, 'hello from second')
  })

  test('renaming a room and adding an agent persist across reload', async () => {
    const { service, filePath } = await openService()
    const room = service.getSnapshot().rooms[0]
    await service.updateRoom({
      id: room.id,
      name: 'Harbor',
      description: 'Desktop shell for Huddle'
    })
    await service.addAgent({ roomId: room.id, presetId: 'alex' })

    const reloaded = await RoomService.open(new JsonSnapshotStore(filePath))
    const snap = reloaded.getSnapshot()
    assert.equal(snap.rooms[0].name, 'Harbor')
    assert.equal(snap.rooms[0].description, 'Desktop shell for Huddle')
    assert.equal(snap.agents.length, 2)
    assert.ok(snap.agents.some((agent) => agent.presetId === 'alex'))
  })

  test('retrying the same clientRequestId does not create a duplicate message', async () => {
    const { service } = await openService()
    const roomId = service.getSnapshot().rooms[0].id
    const first = await service.sendMessage({
      roomId,
      body: 'same submit',
      clientRequestId: 'dup-1'
    })
    const second = await service.sendMessage({
      roomId,
      body: 'same submit',
      clientRequestId: 'dup-1'
    })
    assert.equal(first.id, second.id)
    assert.equal(service.getSnapshot().messages.length, 1)
  })

  test('rapid distinct submissions persist every message once', async () => {
    const { service } = await openService()
    const roomId = service.getSnapshot().rooms[0].id
    const bodies = ['one', 'two', 'three', 'four', 'five']
    const results = await Promise.all(
      bodies.map((body, index) =>
        service.sendMessage({
          roomId,
          body,
          clientRequestId: `rapid-${index}`
        })
      )
    )
    const ids = new Set(results.map((message) => message.id))
    assert.equal(ids.size, bodies.length)
    const stored = service.getSnapshot().messages.filter((message) => message.roomId === roomId)
    assert.equal(stored.length, bodies.length)
  })

  test('rooms are capped at four agents', async () => {
    const { service } = await openService()
    const roomId = service.getSnapshot().rooms[0].id
    await service.addAgent({ roomId, presetId: 'alex' })
    await service.addAgent({ roomId, presetId: 'sam' })
    await service.addAgent({ roomId, presetId: 'maya' })
    await assert.rejects(
      () => service.addAgent({ roomId, presetId: 'alex' }),
      /four agents/i
    )
    assert.equal(service.getSnapshot().agents.filter((agent) => agent.roomId === roomId).length, 4)
  })

  test('events have ids and increasing sequence numbers', async () => {
    const { service } = await openService()
    const seen: number[] = []
    const stop = service.subscribe((event) => {
      seen.push(event.seq)
    })
    const room = await service.createRoom({ name: 'Observed' })
    await service.updateRoom({ id: room.id, name: 'Observed now' })
    stop()
    assert.ok(seen.length >= 2)
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(seen[i] > seen[i - 1])
    }
    const events = service.getSnapshot().events
    assert.ok(events.every((event) => event.id && event.seq > 0))
  })

  test('corrupt state is preserved and surfaced as recovery, then a fresh default room is created', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'huddle-corrupt-'))
    const filePath = join(dir, 'huddle-state.json')
    await writeFile(filePath, '{ nope', 'utf8')
    const service = await RoomService.open(new JsonSnapshotStore(filePath))
    const snap = service.getSnapshot()
    assert.ok(snap.recovery)
    assert.match(snap.recovery?.backupPath ?? '', /\.corrupt-/)
    assert.equal(snap.rooms.length, 1)
    assert.equal(snap.rooms[0].name, 'New project')
    const backup = await readFile(snap.recovery!.backupPath, 'utf8')
    assert.equal(backup, '{ nope')
  })

  test('subscribe cleanup prevents further events', async () => {
    const { service } = await openService()
    let count = 0
    const stop = service.subscribe(() => {
      count += 1
    })
    stop()
    await service.createRoom({ name: 'Ignored' })
    assert.equal(count, 0)
  })
})
