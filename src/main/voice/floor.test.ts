// The speech floor: one speaker, human priority, no stale queue, no backlog.
//
// Run: node --experimental-strip-types --test src/main/voice/floor.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SpeechIntent } from '../contracts.ts'
import type { HaltReason, SpeechReason } from '../../shared/voice.ts'
import { SpeechFloor, splitForSpeech, type SpeechFloorItem, type SpeechResult } from './floor.ts'

interface Recorder {
  begins: Array<{ generationId: string; agentId: string; text: string }>
  halts: Array<{ generationId: string; reason: HaltReason }>
  completed: Array<{ agentId: string; result: SpeechResult }>
  dropped: Array<{ agentId: string; result: SpeechResult; detail: string }>
  queues: string[][]
}

function createFloor(clock: { value: number; advance(ms: number): void }) {
  const rec: Recorder = { begins: [], halts: [], completed: [], dropped: [], queues: [] }
  let seq = 0
  const floor = new SpeechFloor({
    now: () => clock.value,
    nextGenerationId: () => `gen-${(seq += 1)}`,
    hooks: {
      now: () => clock.value,
      beginPart: (item: SpeechFloorItem, generationId: string, text: string) => {
        rec.begins.push({ generationId, agentId: item.intent.agentId, text })
      },
      haltPart: (_item: SpeechFloorItem, generationId: string, reason: HaltReason) => {
        rec.halts.push({ generationId, reason })
      },
      complete: (item: SpeechFloorItem, result: SpeechResult) => {
        rec.completed.push({ agentId: item.intent.agentId, result })
      },
      drop: (item: SpeechFloorItem, result: SpeechResult, detail: string) => {
        rec.dropped.push({ agentId: item.intent.agentId, result, detail })
      },
      queueChanged: (agentIds: string[]) => {
        rec.queues.push([...agentIds])
      }
    }
  })
  return { floor, rec }
}

function clockOf(start = 1_000) {
  const clock = {
    value: start,
    advance(ms: number): void {
      clock.value += ms
    }
  }
  return clock
}

function intent(input: {
  agentId: string
  reason: SpeechReason
  text?: string
  revision?: number
  expiresAt?: number
  roomId?: string
}): SpeechIntent {
  return {
    id: `intent-${input.agentId}-${input.reason}`,
    roomId: input.roomId ?? 'room-1',
    agentId: input.agentId,
    text: input.text ?? 'Maya here. The build passed.',
    reason: input.reason,
    decisionRevision: input.revision ?? 1,
    messageId: null,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {})
  }
}

/** Completes whatever part is currently playing, the honest way. */
function finishCurrent(floor: SpeechFloor, generationId: string): void {
  assert.equal(floor.onSynthesisEnded(generationId), true, 'synthesis EOF must be accepted')
  assert.equal(floor.onPlaybackDrained(generationId), true, 'the drain must complete the part')
}

test('one agent speaks at a time and a direct answer wins the floor', async () => {
  const clock = clockOf()
  const { floor, rec } = createFloor(clock)
  floor.setActiveRoom('room-1')

  const status = floor.enqueue(intent({ agentId: 'sam', reason: 'status' }))
  assert.deepEqual(rec.begins.map((entry) => entry.agentId), ['sam'], 'the only item starts')

  const ack = floor.enqueue(intent({ agentId: 'alex', reason: 'ack' }))
  assert.equal(rec.begins.length, 1, 'one speaker at a time: the ack waits')

  // A direct answer outranks volunteered chatter that is already speaking.
  const answer = floor.enqueue(intent({ agentId: 'maya', reason: 'answer' }))
  assert.deepEqual(rec.begins.map((entry) => entry.agentId), ['sam', 'maya'])
  assert.equal((await status.handle.done).state, 'interrupted')
  assert.deepEqual(floor.queuedAgentIds(), ['alex'])

  const generationId = answer.handle.generationId
  // Real playback reports the first audible frame; without it the floor is right
  // to refuse to claim the utterance was heard.
  floor.onFirstAudible(generationId)
  finishCurrent(floor, generationId)
  assert.equal((await answer.handle.done).state, 'played')

  assert.equal(rec.begins.length, 3)
  assert.equal(rec.begins[2]?.agentId, 'alex', 'the queued ack gets the floor afterwards')
  assert.equal(rec.begins[2]?.generationId, ack.handle.generationId)
  assert.equal(rec.completed[0]?.agentId, 'maya')
})

test('the human outranks every agent and nothing starts while they talk', async () => {
  const clock = clockOf()
  const { floor, rec } = createFloor(clock)
  floor.setActiveRoom('room-1')

  const first = floor.enqueue(intent({ agentId: 'maya', reason: 'answer' }))
  floor.onFirstAudible(first.handle.generationId)

  floor.humanSpeechStart()
  assert.deepEqual(rec.halts, [{ generationId: first.handle.generationId, reason: 'bargeIn' }])
  assert.equal((await first.handle.done).state, 'interrupted')

  const second = floor.enqueue(intent({ agentId: 'alex', reason: 'answer' }))
  assert.equal(rec.begins.length, 1, 'no agent may start while the human is speaking')

  floor.humanSpeechEnd()
  assert.equal(rec.begins.length, 2, 'the queued answer starts once the human stops')
  assert.equal(rec.begins[1]?.generationId, second.handle.generationId)
})

test('deafening drops the queue and leaves no backlog behind', async () => {
  const clock = clockOf()
  const { floor, rec } = createFloor(clock)
  floor.setActiveRoom('room-1')

  const speaking = floor.enqueue(intent({ agentId: 'maya', reason: 'answer' }))
  floor.onFirstAudible(speaking.handle.generationId)
  const queuedA = floor.enqueue(intent({ agentId: 'alex', reason: 'result' }))
  const queuedB = floor.enqueue(intent({ agentId: 'sam', reason: 'ack' }))

  floor.setDeafened(true)
  assert.deepEqual(rec.halts, [{ generationId: speaking.handle.generationId, reason: 'deafen' }])
  assert.equal((await speaking.handle.done).state, 'interrupted')
  assert.equal((await queuedA.handle.done).state, 'unheard')
  assert.equal((await queuedB.handle.done).state, 'unheard')
  assert.deepEqual(floor.queuedAgentIds(), [])
  const beginsWhileDeafened = rec.begins.length

  const whileDeafened = floor.enqueue(intent({ agentId: 'alex', reason: 'answer' }))
  assert.equal((await whileDeafened.handle.done).state, 'unheard')

  floor.setDeafened(false)
  assert.equal(rec.begins.length, beginsWhileDeafened, 'undeafening must not release a backlog')

  const afterUndeafening = floor.enqueue(intent({ agentId: 'sam', reason: 'answer' }))
  assert.equal(rec.begins.length, beginsWhileDeafened + 1, 'new speech is allowed again')
  assert.equal(rec.begins[rec.begins.length - 1]?.generationId, afterUndeafening.handle.generationId)
})

test('defect 3: completion needs synthesis EOF and a drained buffer in either order', async () => {
  const clock = clockOf()
  const { floor, rec } = createFloor(clock)
  floor.setActiveRoom('room-1')

  const first = floor.enqueue(intent({ agentId: 'maya', reason: 'answer' }))
  const generationId = first.handle.generationId
  floor.onFirstAudible(generationId)

  // Draining an empty buffer must not end the utterance: synthesis is still open.
  assert.equal(floor.onPlaybackDrained(generationId), false)
  assert.equal(rec.completed.length, 0)
  assert.equal(rec.dropped.length, 0)

  // EOF alone is not completion either.
  assert.equal(floor.onSynthesisEnded(generationId), true)
  assert.equal(rec.completed.length, 1, 'EOF plus an already drained buffer completes')
  assert.equal((await first.handle.done).state, 'played')

  const second = floor.enqueue(intent({ agentId: 'alex', reason: 'answer' }))
  floor.onFirstAudible(second.handle.generationId)
  floor.onSynthesisEnded(second.handle.generationId)
  assert.equal(rec.completed.length, 1, 'EOF without a drain is not completion')
  floor.onPlaybackDrained(second.handle.generationId)
  assert.equal((await second.handle.done).state, 'played')
})

test('audio that was never audible is never claimed as played', async () => {
  const clock = clockOf()
  const { floor, rec } = createFloor(clock)
  floor.setActiveRoom('room-1')

  const { handle } = floor.enqueue(intent({ agentId: 'maya', reason: 'answer' }))
  const generationId = handle.generationId
  floor.onSynthesisEnded(generationId)
  floor.onPlaybackDrained(generationId)

  const result = await handle.done
  assert.equal(result.state, 'error')
  assert.equal(result.playedChars, null)
  assert.equal(rec.completed.length, 0)
  assert.equal(rec.dropped[0]?.result.state, 'error')
})

test('stale queued speech is dropped: revision, expiry and age', async () => {
  const clock = clockOf()
  const { floor, rec } = createFloor(clock)
  floor.setActiveRoom('room-1')

  const speaking = floor.enqueue(intent({ agentId: 'maya', reason: 'answer', revision: 3 }))
  const oldRevision = floor.enqueue(intent({ agentId: 'alex', reason: 'result', revision: 2 }))
  const expiring = floor.enqueue(
    intent({ agentId: 'sam', reason: 'status', revision: 3, expiresAt: clock.value + 500 })
  )

  floor.invalidateSpeechBefore('room-1', 3)
  assert.equal((await oldRevision.handle.done).state, 'unheard')

  clock.advance(1_000)
  finishCurrent(floor, speaking.handle.generationId)
  assert.equal((await expiring.handle.done).state, 'unheard', 'an expired intent is not worth saying')
  assert.equal(rec.begins.length, 1)

  // Age alone is enough once the room has moved on.
  const long = floor.enqueue(intent({ agentId: 'alex', reason: 'result', revision: 3 }))
  const queued = floor.enqueue(intent({ agentId: 'sam', reason: 'status', revision: 3 }))
  clock.advance(31_000)
  const blocked = rec.begins.length
  finishCurrent(floor, long.handle.generationId)
  assert.equal((await queued.handle.done).state, 'unheard')
  assert.equal(rec.begins.length, blocked, 'nothing stale is spoken after the pause')
})

test('aging keeps low-priority speech from starving behind answers', async () => {
  const clock = clockOf()
  const { floor } = createFloor(clock)
  floor.setActiveRoom('room-1')

  const speaking = floor.enqueue(intent({ agentId: 'maya', reason: 'answer' }))
  floor.onFirstAudible(speaking.handle.generationId)
  const status = floor.enqueue(intent({ agentId: 'sam', reason: 'status' }))
  clock.advance(20_000)
  const freshAck = floor.enqueue(intent({ agentId: 'alex', reason: 'ack' }))

  finishCurrent(floor, speaking.handle.generationId)
  assert.equal(floor.currentItem()?.intent.agentId, 'sam', 'the aged status wins after 20 s')
  const statusGeneration = floor.currentItem()?.generationId ?? ''

  floor.onFirstAudible(statusGeneration)
  finishCurrent(floor, statusGeneration)
  assert.equal((await status.handle.done).state, 'played')
  assert.equal(floor.currentItem()?.intent.agentId, 'alex', 'the fresh ack is next')
  assert.equal(freshAck.handle.generationId, floor.currentItem()?.generationId)
})

test('long answers are spoken in bounded parts and stop mid-way when asked', async () => {
  const clock = clockOf()
  const { floor, rec } = createFloor(clock)
  floor.setActiveRoom('room-1')

  const long = `${'First sentence about the build. '.repeat(20)}Final sentence.`
  const handle = floor.enqueue(intent({ agentId: 'maya', reason: 'answer', text: long }))
  const item = floor.currentItem()
  assert.ok(item)
  assert.ok(item.parts.length > 1, 'long text must be split into short turns')
  assert.ok(item.parts.length <= 4, 'the split is bounded')

  floor.onFirstAudible(handle.handle.generationId)
  finishCurrent(floor, handle.handle.generationId)
  assert.equal(rec.begins.length, 2, 'the next part continues the same speech')
  assert.equal(rec.begins[1]?.agentId, 'maya')
  assert.equal(rec.begins[1]?.text, item.parts[1])

  floor.stopSpeaking('stopSpeaking', 'current')
  const result = await handle.handle.done
  assert.equal(result.state, 'cancelled')
  assert.equal(rec.begins.length, 2, 'stop-speaking must not start another part')
})

test('speech is refused in a room that is not active', async () => {
  const clock = clockOf()
  const { floor, rec } = createFloor(clock)

  const beforeJoin = floor.enqueue(intent({ agentId: 'maya', reason: 'answer' }))
  assert.equal((await beforeJoin.handle.done).state, 'cancelled')

  floor.setActiveRoom('room-1')
  const otherRoom = floor.enqueue(intent({ agentId: 'alex', reason: 'answer', roomId: 'room-2' }))
  assert.equal((await otherRoom.handle.done).state, 'cancelled')
  assert.equal(rec.begins.length, 0)

  const active = floor.enqueue(intent({ agentId: 'sam', reason: 'answer' }))
  assert.equal(rec.begins.length, 1)
  floor.setActiveRoom('room-2')
  assert.equal((await active.handle.done).state, 'cancelled', 'a room change cancels the speaker')
  assert.equal(rec.halts[0]?.reason, 'roomChange')
})

test('splitForSpeech never loses text', () => {
  const text = `${'Sentence one about the interface. '.repeat(30)}`
  const parts = splitForSpeech(text, 320, 4)
  assert.ok(parts.length <= 4)
  const rejoined = parts.join(' ')
  assert.ok(rejoined.length >= text.trim().length - 4, 'nothing but whitespace may be lost')
  assert.deepEqual(splitForSpeech('   ', 320, 4), [])
})
