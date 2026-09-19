// Playback generation bookkeeping (renderer-side module) exercised in Node.
//
// This test lives under src/main/voice/ on purpose: the renderer bundle must not
// contain Node imports, and tsconfig.web.json has no Node types, so a test file
// inside src/renderer/src/ would break `tsc -p tsconfig.web.json`. The module
// under test (src/renderer/src/voice/generation.ts) is pure and DOM-free.
//
// Run: node --experimental-strip-types --test src/main/voice/playback-gate.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlaybackGate, playedMsFor } from '../../renderer/src/voice/generation.ts'

function begin(gate: PlaybackGate, generationId: string, now = 0) {
  return gate.begin({
    generationId,
    agentId: 'agent-maya',
    text: 'Build passed.',
    messageId: 'message-1',
    sampleRate: 24_000,
    now
  })
}

test('defect 4: chunks from an interrupted generation can never restart playback', () => {
  const gate = new PlaybackGate()
  begin(gate, 'gen-1')
  assert.equal(gate.accepts('gen-1'), true)
  assert.equal(gate.accepts('gen-2'), false, 'a generation that was never announced is dropped')

  const halted = gate.halt('gen-1', 'bargeIn')
  assert.equal(halted?.generationId, 'gen-1')
  assert.equal(gate.accepts('gen-1'), false, 'late chunks are dropped after the halt')
  assert.equal(gate.current(), null)

  begin(gate, 'gen-2')
  assert.equal(gate.accepts('gen-1'), false, 'the old generation stays dead')
  assert.equal(gate.accepts('gen-2'), true)

  // A new generation replaces whatever was in flight.
  begin(gate, 'gen-3')
  assert.equal(gate.accepts('gen-2'), false, 'only one generation may be audible')
  assert.equal(gate.accepts('gen-3'), true)
})

test('defect 3: a drained buffer completes only after synthesis reached EOF', () => {
  const gate = new PlaybackGate()
  begin(gate, 'gen-1')
  const booked = gate.noteScheduled('gen-1', 2_400)
  assert.deepEqual(booked, { firstAudible: true })

  assert.equal(gate.sourceEnded('gen-1'), 'waiting', 'EOF has not arrived yet')
  assert.equal(gate.markSynthesisEnded('gen-1'), true)
  assert.equal(gate.sourceEnded('gen-1'), 'drained', 'EOF plus the last source ended')
})

test('defect 3: EOF with an empty buffer only drains audio that was audible', () => {
  const silent = new PlaybackGate()
  begin(silent, 'gen-1')
  silent.markSynthesisEnded('gen-1')
  assert.equal(
    silent.synthesisEndedWithEmptyBuffer('gen-1'),
    false,
    'a generation that never sounded must not be reported as drained'
  )

  const short = new PlaybackGate()
  begin(short, 'gen-9')
  assert.deepEqual(short.noteScheduled('gen-9', 4_800), { firstAudible: true })
  assert.equal(short.sourceEnded('gen-9'), 'waiting')
  assert.equal(short.markSynthesisEnded('gen-9'), true)
  assert.equal(
    short.synthesisEndedWithEmptyBuffer('gen-9'),
    true,
    'EOF may arrive after the buffer already drained'
  )
  short.markDrainedReported('gen-9')
  assert.equal(short.synthesisEndedWithEmptyBuffer('gen-9'), false, 'drained is reported once')
})

test('scheduling is counted per generation and a stale generation cannot schedule', () => {
  const gate = new PlaybackGate()
  const generation = begin(gate, 'gen-1')
  assert.deepEqual(gate.noteScheduled('gen-1', 1_200), { firstAudible: true })
  assert.deepEqual(gate.noteScheduled('gen-1', 1_200), { firstAudible: false })
  assert.equal(gate.noteScheduled('gen-2', 1_200), null, 'another generation cannot schedule')
  assert.equal(generation.pendingSources, 2)

  gate.haltActive('deafen')
  assert.equal(gate.noteScheduled('gen-1', 1_200), null, 'halted generations cannot schedule')
  assert.equal(gate.current(), null)
})

test('playedMsFor never claims more than was scheduled', () => {
  const gate = new PlaybackGate()
  const generation = begin(gate, 'gen-1', 1_000)
  gate.noteScheduled('gen-1', 24_000) // one second at 24 kHz

  assert.equal(playedMsFor(generation, 24_000, 1_500), 500)
  assert.equal(playedMsFor(generation, 24_000, 9_000), 1_000)
})
