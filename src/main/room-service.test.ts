import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { EventLog } from './event-log.ts'
import { JsonSnapshotStore } from './json-store.ts'
import { RoomService } from './room-service.ts'

async function openService(): Promise<{
  service: RoomService
  filePath: string
  dir: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'huddle-room-'))
  const filePath = join(dir, 'huddle-state.json')
  const service = await RoomService.open(new JsonSnapshotStore(filePath), {
    log: new EventLog(join(dir, 'events.jsonl'))
  })
  return { service, filePath, dir }
}

async function withRoom(): Promise<{
  service: RoomService
  filePath: string
  dir: string
  room: Awaited<ReturnType<RoomService['createRoom']>>
}> {
  const opened = await openService()
  const room = await opened.service.createRoom({ name: 'Test', agentCount: 3 })
  return { ...opened, room }
}

describe('RoomService startup', () => {
  test('a first launch is empty until the human creates a room', async () => {
    const { service, filePath } = await openService()
    const snapshot = service.snapshot()

    assert.equal(snapshot.rooms.length, 0)
    assert.equal(snapshot.selectedRoomId, null)
    assert.equal(snapshot.agents.length, 0)
    assert.equal(snapshot.messages.length, 0)
    assert.equal(snapshot.call.connection, 'disconnected')

    const stored = JSON.parse(await readFile(filePath, 'utf8')) as { rooms: unknown[] }
    assert.equal(stored.rooms.length, 0)
  })

  test('creating and switching rooms keeps messages in the correct room', async () => {
    const { service } = await openService()
    const first = await service.createRoom({ name: 'First room', agentCount: 2 })
    await service.sendHumanMessage({
      roomId: first.id,
      body: 'hello from first',
      clientRequestId: 'req-first'
    })

    const second = await service.createRoom({ name: 'Second room', agentCount: 4 })
    await service.sendHumanMessage({
      roomId: second.id,
      body: 'hello from second',
      clientRequestId: 'req-second'
    })

    await service.selectRoom(first.id)
    const snapshot = service.snapshot()
    assert.equal(snapshot.selectedRoomId, first.id)
    assert.equal(snapshot.rooms.length, 2)
    assert.equal(snapshot.messages.filter((m) => m.roomId === first.id).length, 1)
    assert.equal(snapshot.messages.filter((m) => m.roomId === second.id).length, 1)
    assert.equal(snapshot.agents.filter((agent) => agent.roomId === first.id).length, 2)
    assert.equal(snapshot.agents.filter((agent) => agent.roomId === second.id).length, 4)
  })

  test('renaming a room, setting its goal and adding an agent persist across reload', async () => {
    const { service, filePath, dir } = await openService()
    const room = await service.createRoom({ name: 'Start', agentCount: 1 })
    await service.updateRoom({ id: room.id, name: 'Harbor', goal: 'Ship the sketch game' })
    await service.addAgent({ roomId: room.id, presetId: 'rio' })

    const reloaded = await RoomService.open(new JsonSnapshotStore(filePath), {
      log: new EventLog(join(dir, 'events.jsonl'))
    })
    const snapshot = reloaded.snapshot()
    assert.equal(snapshot.rooms[0].name, 'Harbor')
    assert.equal(snapshot.rooms[0].goal, 'Ship the sketch game')
    assert.equal(snapshot.agents.length, 2)
    assert.ok(snapshot.agents.some((agent) => agent.presetId === 'rio'))
  })

  test('a missing file with seeding disabled yields an empty, valid store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'huddle-empty-'))
    const service = await RoomService.open(new JsonSnapshotStore(join(dir, 'state.json')), {
      log: new EventLog(join(dir, 'events.jsonl')),
      seed: false
    })
    const snapshot = service.snapshot()
    assert.equal(snapshot.rooms.length, 0)
    assert.equal(snapshot.selectedRoomId, null)
    assert.equal(snapshot.version, 2)
  })
})

describe('messages', () => {
  test('retrying the same clientRequestId does not create a duplicate', async () => {
    const { service, room } = await withRoom()
    const roomId = room.id
    const first = await service.sendHumanMessage({ roomId, body: 'same', clientRequestId: 'dup-1' })
    const second = await service.sendHumanMessage({ roomId, body: 'same', clientRequestId: 'dup-1' })
    assert.equal(first.id, second.id)
    assert.equal(service.snapshot().messages.length, 1)
  })

  test('the same utterance can never become two messages', async () => {
    const { service, room } = await withRoom()
    const roomId = room.id
    const first = await service.sendHumanMessage({
      roomId,
      body: 'make voting anonymous',
      clientRequestId: 'voice:utt-1',
      utteranceId: 'utt-1'
    })
    // A retry with a different client request id but the same utterance id is
    // still the same utterance.
    const second = await service.sendHumanMessage({
      roomId,
      body: 'make voting anonymous',
      clientRequestId: 'voice:utt-1-retry',
      utteranceId: 'utt-1'
    })
    assert.equal(first.id, second.id)
    assert.equal(service.snapshot().messages.length, 1)
    assert.equal(service.snapshot().messages[0].utteranceId, 'utt-1')
  })

  test('rapid distinct submissions persist every message once', async () => {
    const { service, room } = await withRoom()
    const roomId = room.id
    const bodies = ['one', 'two', 'three', 'four', 'five']
    const results = await Promise.all(
      bodies.map((body, index) =>
        service.sendHumanMessage({ roomId, body, clientRequestId: `rapid-${index}` })
      )
    )
    assert.equal(new Set(results.map((message) => message.id)).size, bodies.length)
    assert.equal(service.snapshot().messages.filter((m) => m.roomId === roomId).length, bodies.length)
  })

  test('empty messages and unknown rooms are refused', async () => {
    const { service, room } = await withRoom()
    const roomId = room.id
    await assert.rejects(
      () => service.sendHumanMessage({ roomId, body: '   ', clientRequestId: 'blank' }),
      /nothing to send/i
    )
    await assert.rejects(
      () => service.sendHumanMessage({ roomId: 'nope', body: 'hi', clientRequestId: 'x' }),
      /no longer exists/i
    )
  })

  test('a message addressed to an agent keeps only real recipients', async () => {
    const { service, room } = await withRoom()
    const roomId = room.id
    const alex = service.getAgents(roomId).find((agent) => agent.presetId === 'alex')
    assert.ok(alex)
    const message = await service.sendHumanMessage({
      roomId,
      body: 'Alex, take the backend',
      clientRequestId: 'target-1',
      to: [alex.id, 'ghost-agent']
    })
    assert.deepEqual(message.to, [alex.id])
  })
})

describe('durability', () => {
  test('a change that cannot be written is rolled back and reported', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'huddle-fail-'))
    const store = new JsonSnapshotStore(join(dir, 'state.json'))
    const service = await RoomService.open(store, { log: new EventLog(join(dir, 'events.jsonl')) })
    const roomCount = service.snapshot().rooms.length

    // A store that cannot write stands in for a full disk or a locked file.
    const original = store.write.bind(store)
    store.write = async () => {
      throw new Error('disk full')
    }

    await assert.rejects(() => service.createRoom({ name: 'Doomed' }), /could not be saved/i)
    assert.equal(service.snapshot().rooms.length, roomCount)
    assert.match(service.lastPersistError() ?? '', /disk full/)

    store.write = original
    const recovered = await service.createRoom({ name: 'Fine' })
    assert.equal(recovered.name, 'Fine')
    assert.equal(service.lastPersistError(), null)
  })

  test('interrupted work is surfaced as resumable instead of being retried', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'huddle-resume-'))
    const filePath = join(dir, 'state.json')
    const first = await RoomService.open(new JsonSnapshotStore(filePath), {
      log: new EventLog(join(dir, 'events.jsonl'))
    })
    const room = await first.createRoom({ name: 'Resume', agentCount: 1 })
    const agent = first.getAgents(room.id)[0]
    first.upsertJob({
      id: 'job-1',
      roomId: room.id,
      agentId: agent.id,
      workspaceId: 'ws-1',
      label: 'dev server',
      command: 'npm run dev',
      cwd: room.id,
      status: 'running',
      exitCode: null,
      pid: 4242,
      startedAt: new Date().toISOString(),
      endedAt: null,
      lastObservedAt: new Date().toISOString(),
      truncated: false,
      port: 5173
    })
    await first.flush()
    await first.dispose()

    const second = await RoomService.open(new JsonSnapshotStore(filePath), {
      log: new EventLog(join(dir, 'events.jsonl'))
    })
    const resumable = second.snapshot().resumable
    assert.equal(resumable.length, 1)
    assert.equal(resumable[0].kind, 'job')
    assert.equal(resumable[0].state, 'unknown')
    assert.match(resumable[0].detail, /not restarted automatically/i)
    second.dismissResumable(resumable[0].id)
    assert.equal(second.snapshot().resumable.length, 0)
  })
})

describe('decisions', () => {
  test('a decision opens a revision and marks earlier tasks stale', async () => {
    const { service, room } = await withRoom()
    const agent = service.getAgents(room.id)[0]
    const now = new Date().toISOString()

    service.upsertTask({
      id: 'task-1',
      roomId: room.id,
      title: 'Make voting public',
      detail: 'show voter names in the gallery',
      ownerAgentId: agent.id,
      createdBy: { type: 'human' },
      status: 'in_progress',
      dependsOn: [],
      acceptance: ['names visible in the vote gallery'],
      decisionRevision: 0,
      staleSince: null,
      staleReason: null,
      blockedReason: null,
      evidence: [],
      createdAt: now,
      updatedAt: now
    })

    const decision = await service.recordDecision(
      {
        roomId: room.id,
        title: 'Voting must be anonymous',
        statement: 'Voter identity must never reach the client.',
        rationale: 'Privacy requirement changed.'
      },
      { type: 'human' }
    )

    assert.equal(decision.revision, 1)
    assert.equal(service.getRoom(room.id)?.decisionRevision, 1)
    const task = service.getTask('task-1')
    assert.ok(task?.staleSince)
    assert.match(task.staleReason ?? '', /revision 1/)
    assert.deepEqual(decision.affectedTaskIds, ['task-1'])
    // The decision is also durable room memory.
    assert.equal(service.getMemories(room.id).length, 1)
  })
})

describe('rooms, agents and events', () => {
  test('rooms are capped at ten agents', async () => {
    const { service } = await openService()
    const room = await service.createRoom({ name: 'Full', agentCount: 10 })
    await assert.rejects(() => service.addAgent({ roomId: room.id, presetId: 'rio' }), /at most 10/i)
    assert.equal(service.getAgents(room.id).length, 10)
  })

  test('removing an agent releases its unfinished tasks', async () => {
    const { service, room } = await withRoom()
    const sam = service.getAgents(room.id).find((agent) => agent.presetId === 'sam')
    assert.ok(sam)
    service.upsertTask({
      id: 'task-qa',
      roomId: room.id,
      title: 'Check the vote payload',
      detail: '',
      ownerAgentId: sam.id,
      createdBy: { type: 'human' },
      status: 'in_progress',
      dependsOn: [],
      acceptance: [],
      decisionRevision: 0,
      staleSince: null,
      staleReason: null,
      blockedReason: null,
      evidence: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })

    await service.removeAgent(sam.id)
    const task = service.getTask('task-qa')
    assert.equal(task?.ownerAgentId, null)
    assert.equal(task?.status, 'proposed')
    assert.match(task?.blockedReason ?? '', /left the room/i)
  })

  test('only one room is joined at a time', async () => {
    const { service } = await openService()
    const first = (await service.createRoom({ name: 'One', agentCount: 1 })).id
    const second = await service.createRoom({ name: 'Other', agentCount: 1 })
    await service.setJoined(first, true)
    await service.setJoined(second.id, true)
    assert.equal(service.getRoom(first)?.joined, false)
    assert.equal(service.getRoom(second.id)?.joined, true)
  })

  test('events have ids and increasing sequence numbers', async () => {
    const { service } = await openService()
    const seen: number[] = []
    const stop = service.subscribe((event) => seen.push(event.seq))
    const room = await service.createRoom({ name: 'Observed' })
    await service.updateRoom({ id: room.id, name: 'Observed now' })
    stop()
    assert.ok(seen.length >= 2)
    for (let index = 1; index < seen.length; index += 1) {
      assert.ok(seen[index] > seen[index - 1])
    }
    assert.ok(service.snapshot().events.every((event) => event.id && event.seq > 0))
  })

  test('ephemeral events never reach the durable snapshot', async () => {
    const { service, filePath, room } = await withRoom()
    const roomId = room.id
    await new Promise((resolve) => setTimeout(resolve, 50))
    const before = await readFile(filePath, 'utf8')

    // A heartbeat of levels, job output and partial transcripts is streamed to
    // the UI but must never cause a write or change what is on disk.
    for (let index = 0; index < 25; index += 1) {
      service.emit(roomId, { type: 'voice.level', level: index / 25 })
    }
    service.emit(roomId, { type: 'job.output', jobId: 'j1', chunk: 'tick', stream: 'stdout' })
    service.emit(roomId, {
      type: 'voice.transcript',
      transcript: { utteranceId: 'u1', roomId, text: 'partial', isFinal: false, updatedAt: '' }
    })

    await new Promise((resolve) => setTimeout(resolve, 500))

    const beforeState = JSON.parse(before) as { rooms: unknown; agents: unknown; messages: unknown; jobs: unknown }
    const afterState = JSON.parse(await readFile(filePath, 'utf8')) as {
      rooms: unknown
      agents: unknown
      messages: unknown
      jobs: unknown
    }
    assert.deepEqual(afterState.rooms, beforeState.rooms)
    assert.deepEqual(afterState.agents, beforeState.agents)
    assert.deepEqual(afterState.messages, beforeState.messages)
    assert.deepEqual(afterState.jobs, beforeState.jobs)
    assert.ok(service.snapshot().events.length >= 27)
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

describe('corrupt state', () => {
  test('is preserved beside the original and surfaced as recovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'huddle-corrupt-'))
    const filePath = join(dir, 'huddle-state.json')
    await writeFile(filePath, '{ nope', 'utf8')

    const service = await RoomService.open(new JsonSnapshotStore(filePath), {
      log: new EventLog(join(dir, 'events.jsonl'))
    })
    const snapshot = service.snapshot()
    assert.ok(snapshot.recovery)
    assert.match(snapshot.recovery?.backupPath ?? '', /\.corrupt-/)
    assert.match(snapshot.recovery?.message ?? '', /could not read/i)
    assert.equal(snapshot.rooms.length, 0)
    assert.equal(await readFile(snapshot.recovery!.backupPath, 'utf8'), '{ nope')
  })

  test('a future schema is refused rather than guessed at', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'huddle-future-'))
    const filePath = join(dir, 'huddle-state.json')
    await writeFile(filePath, JSON.stringify({ version: 99, rooms: [] }), 'utf8')
    const service = await RoomService.open(new JsonSnapshotStore(filePath), {
      log: new EventLog(join(dir, 'events.jsonl'))
    })
    assert.match(service.snapshot().recovery?.message ?? '', /could not read/i)
    assert.match(service.snapshot().recovery?.message ?? '', /newer version/i)
  })
})
