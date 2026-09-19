import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { STATE_VERSION } from '../shared/types.ts'
import { migrateToCurrent, normalizeMessage, normalizeStage } from './migrate.ts'

describe('migrateToCurrent', () => {
  test('refuses anything that is not a versioned object', () => {
    assert.equal(migrateToCurrent(null).ok, false)
    assert.equal(migrateToCurrent('nope').ok, false)
    const noVersion = migrateToCurrent({ rooms: [] })
    assert.equal(noVersion.ok, false)
    if (!noVersion.ok) assert.match(noVersion.reason, /no schema version/i)
  })

  test('refuses a newer schema instead of guessing at it', () => {
    const outcome = migrateToCurrent({ version: 99, rooms: [] })
    assert.equal(outcome.ok, false)
    if (!outcome.ok) assert.match(outcome.reason, /newer version/i)
  })

  test('refuses a state file with no rooms array', () => {
    const outcome = migrateToCurrent({ version: STATE_VERSION })
    assert.equal(outcome.ok, false)
    if (!outcome.ok) assert.match(outcome.reason, /no rooms array/i)
  })

  test('migrates a v1 room: description becomes the goal, workspace is dropped', () => {
    const outcome = migrateToCurrent({
      version: 1,
      rooms: [
        {
          id: 'r1',
          name: 'Sketch night',
          description: 'Ship the drawing game',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-02T00:00:00.000Z',
          workspace: { kind: 'agent', focus: 'files' }
        }
      ],
      agents: [
        {
          id: 'a1',
          roomId: 'r1',
          presetId: 'sam',
          name: 'Sam',
          role: 'qa',
          workState: 'not_connected',
          speechState: 'not_connected'
        }
      ],
      selectedRoomId: 'r1',
      lastSeq: 3
    })

    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.fromVersion, 1)
    assert.equal(outcome.state.version, STATE_VERSION)
    assert.equal(outcome.state.rooms[0].goal, 'Ship the drawing game')
    assert.deepEqual(outcome.state.rooms[0].stage.mode, { kind: 'gallery' })
    assert.equal(outcome.state.rooms[0].project, null)
    assert.equal(outcome.state.agents[0].workState, 'offline')
    assert.equal(outcome.state.agents[0].speechState, 'silent')
    assert.equal(outcome.state.agents[0].connected, false)
    assert.equal(outcome.state.selectedRoomId, 'r1')
    assert.ok(outcome.notes.some((note) => /schema v1/i.test(note)))
  })

  test('drops malformed records without losing the good ones', () => {
    const outcome = migrateToCurrent({
      version: STATE_VERSION,
      rooms: [
        { id: 'r1', name: 'Good' },
        { name: 'no id' }
      ],
      agents: [{ id: 'a1', roomId: 'r1', presetId: 'maya' }, { id: 'a2' }],
      messages: [
        { id: 'm1', roomId: 'r1', body: 'kept' },
        { id: 'm2', roomId: 'ghost-room', body: 'orphaned' }
      ],
      selectedRoomId: 'r1',
      lastSeq: 1
    })

    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.state.rooms.length, 1)
    assert.equal(outcome.state.agents.length, 1)
    // A message whose room is gone is dropped rather than shown nowhere.
    assert.equal(outcome.state.messages.length, 1)
    assert.equal(outcome.state.messages[0].body, 'kept')
    assert.ok(outcome.notes.some((note) => /malformed/i.test(note)))
  })

  test('a persisted running process is not trusted after a restart', () => {
    const outcome = migrateToCurrent({
      version: STATE_VERSION,
      rooms: [{ id: 'r1', name: 'Room' }],
      jobs: [
        {
          id: 'j1',
          roomId: 'r1',
          status: 'running',
          label: 'dev',
          command: 'npm run dev'
        }
      ],
      browserSessions: [
        { id: 'b1', roomId: 'r1', status: 'live', agentId: 'a1', provider: 'browserbase' }
      ],
      selectedRoomId: 'r1',
      lastSeq: 0
    })

    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.state.jobs[0].status, 'unknown')
    assert.equal(outcome.state.browserSessions[0].status, 'closed')
    assert.match(outcome.state.browserSessions[0].detail, /restart/i)
  })
})

describe('normalizers', () => {
  test('an unknown stage mode falls back to the gallery', () => {
    assert.deepEqual(normalizeStage({ mode: { kind: 'nonsense' } }).mode, { kind: 'gallery' })
    assert.deepEqual(normalizeStage('nope').mode, { kind: 'gallery' })
    assert.equal(normalizeStage({ follow: false }).follow, false)
  })

  test('a valid share stage survives a reload', () => {
    const stage = normalizeStage({
      mode: { kind: 'share', owner: { kind: 'agent', agentId: 'a1' }, surface: 'terminal' },
      follow: false
    })
    assert.deepEqual(stage.mode, {
      kind: 'share',
      owner: { kind: 'agent', agentId: 'a1' },
      surface: 'terminal'
    })
    assert.equal(stage.follow, false)
    assert.equal(stage.pendingHint, null)
  })

  test('speech that was mid-flight when Huddle exited is not marked played', () => {
    const message = normalizeMessage(
      {
        id: 'm1',
        roomId: 'r1',
        body: 'on it',
        spoken: { generationId: 'g1', state: 'speaking', playedChars: 4 }
      },
      new Date().toISOString()
    )
    assert.ok(message)
    assert.equal(message?.spoken?.state, 'cancelled')
    assert.equal(message?.spoken?.playedChars, 4)
  })
})
