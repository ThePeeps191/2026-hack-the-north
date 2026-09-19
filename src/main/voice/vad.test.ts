// Ported from tools/voice-lab/test/vad-engine.test.ts and
// tools/voice-lab/test/interrupt-policy.test.ts, plus the defect-5 case: the VAD
// must forget the previous capture session, including the model's recurrent state.
//
// Run: node --experimental-strip-types --test src/main/voice/vad.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BargeInPolicy, VoiceActivityDetector, type VadInferencer } from './vad.ts'

interface CountingInferencer extends VadInferencer {
  frames: number
  resets: number
  readonly seen: number[]
}

function countingInferencer(basic: number | (() => number)): CountingInferencer {
  const state: CountingInferencer = {
    frames: 0,
    resets: 0,
    seen: [],
    async infer(frame: Float32Array): Promise<number> {
      state.frames += 1
      state.seen.push(frame.length)
      return typeof basic === 'function' ? basic() : basic
    },
    reset(): void {
      state.resets += 1
    }
  }
  return state
}

function engine(infer: VadInferencer, overrides?: { minSpeechFrames?: number; minSilenceFrames?: number }) {
  return new VoiceActivityDetector({
    frameSamples: 512,
    minSpeechFrames: overrides?.minSpeechFrames ?? 3,
    minSilenceFrames: overrides?.minSilenceFrames ?? 4,
    positiveThreshold: 0.5,
    negativeThreshold: 0.35,
    infer
  })
}

test('speech starts only after enough voiced frames and ends after enough silence', async () => {
  let probability = 0.9
  const infer = countingInferencer(() => probability)
  const vad = engine(infer)
  const events: string[] = []
  vad.on('speech-start', () => events.push('start'))
  vad.on('speech-end', () => events.push('end'))

  for (let i = 0; i < 3; i += 1) await vad.push(new Float32Array(512).fill(0.2))
  assert.deepEqual(events, ['start'])
  assert.equal(vad.speaking, true)

  probability = 0.1
  for (let i = 0; i < 4; i += 1) await vad.push(new Float32Array(512))
  assert.deepEqual(events, ['start', 'end'])
  assert.equal(vad.speaking, false)
})

test('buffers leftover samples across pushes smaller than one frame', async () => {
  const infer = countingInferencer(0.1)
  const vad = engine(infer)

  await vad.push(new Float32Array(200))
  await vad.push(new Float32Array(200))
  assert.deepEqual(infer.seen, [])
  await vad.push(new Float32Array(112))
  assert.deepEqual(infer.seen, [512])
})

test('defect 5: reset() clears counters and the recurrent inference stream', async () => {
  let probability = 0.9
  const infer = countingInferencer(() => probability)
  const vad = engine(infer)
  const events: string[] = []
  vad.on('speech-start', () => events.push('start'))

  for (let i = 0; i < 4; i += 1) await vad.push(new Float32Array(512).fill(0.2))
  assert.deepEqual(events, ['start'])
  assert.equal(vad.speaking, true)

  // Between capture sessions: leave a partial frame in the framer as well.
  await vad.push(new Float32Array(200))
  const framesBeforeReset = infer.frames
  vad.reset()

  assert.equal(infer.resets, 1, 'reset must reach the ONNX recurrent state')
  assert.equal(vad.speaking, false)
  assert.deepEqual(events, ['start'])

  // The leftover 200 samples must be gone: 312 more are still under one frame.
  await vad.push(new Float32Array(312))
  assert.equal(infer.frames, framesBeforeReset, 'framing state must be cleared too')

  // A second session still detects speech from silence.
  for (let i = 0; i < 3; i += 1) await vad.push(new Float32Array(512).fill(0.2))
  assert.deepEqual(events, ['start', 'start'], 'a second join must detect speech again')
})

test('barge-in needs sustained audio above the playback threshold', () => {
  const policy = new BargeInPolicy({ minSpeechMs: 160, bargeInThreshold: 0.65, frameMs: 32 })

  for (let i = 0; i < 4; i += 1) {
    assert.equal(policy.observe({ probability: 0.9, playbackActive: true }), false)
  }
  assert.equal(policy.observe({ probability: 0.9, playbackActive: true }), true)
})

test('barge-in ignores a brief spike, quiet speech, and silence without playback', () => {
  const policy = new BargeInPolicy({ minSpeechMs: 160, bargeInThreshold: 0.65, frameMs: 32 })

  assert.equal(policy.observe({ probability: 0.99, playbackActive: true }), false)
  assert.equal(policy.observe({ probability: 0.1, playbackActive: true }), false)
  assert.equal(policy.observe({ probability: 0.99, playbackActive: false }), false)
  assert.equal(policy.observe({ probability: 0.6, playbackActive: true }), false)

  let fired = false
  for (let i = 0; i < 5; i += 1) {
    fired = policy.observe({ probability: 0.99, playbackActive: true })
  }
  assert.equal(fired, true, 'five 32 ms frames above the threshold must interrupt')
})
