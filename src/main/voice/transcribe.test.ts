// Utterance segmentation and the transcription queue.
//
// Ported from tools/voice-lab/test/transcribe-queue.test.ts, extended with the
// defect-6 cases: a continuous utterance longer than MAX_SEGMENT_SAMPLES is cut
// into segments that all get transcribed (nothing is silently dropped and
// capture never stops), and exactly one final per utterance id.
//
// Run: node --experimental-strip-types --test src/main/voice/transcribe.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TranscribeQueue, UtteranceSegmenter, type UtteranceSegment } from './transcribe.ts'

interface Harness {
  segmenter: UtteranceSegmenter
  finals: UtteranceSegment[]
  partials: UtteranceSegment[]
}

function harness(overrides?: {
  maxSegmentSamples?: number
  minFinalSamples?: number
  minPartialSamples?: number
  partialIntervalMs?: number
  prerollFrames?: number
}): Harness {
  const finals: UtteranceSegment[] = []
  const partials: UtteranceSegment[] = []
  let seq = 0
  const segmenter = new UtteranceSegmenter({
    roomId: 'room-1',
    now: () => Date.now(),
    maxSegmentSamples: overrides?.maxSegmentSamples ?? 2048,
    minFinalSamples: overrides?.minFinalSamples ?? 512,
    minPartialSamples: overrides?.minPartialSamples ?? 1024,
    partialIntervalMs: overrides?.partialIntervalMs ?? 900,
    prerollFrames: overrides?.prerollFrames ?? 2,
    nextUtteranceId: () => `utt-${(seq += 1)}`,
    onFinal: (segment) => finals.push(segment),
    onPartial: (segment) => partials.push(segment)
  })
  return { segmenter, finals, partials }
}

test('partials appear on the cadence and never as finals', () => {
  const h = harness({ maxSegmentSamples: 1_000_000 })
  h.segmenter.begin(0)
  for (let i = 0; i < 4; i += 1) {
    h.segmenter.pushFrame(new Float32Array(512), 1_000 + i * 400)
  }

  assert.equal(h.finals.length, 0)
  assert.ok(h.partials.length >= 1, 'a partial should be produced while speaking')
  assert.equal(h.partials[0]?.isFinal, false)
  assert.equal(h.partials[0]?.utteranceId, 'utt-1')

  const ended = h.segmenter.end(3_000)
  assert.ok(ended)
  assert.equal(h.finals.length, 1)
  assert.equal(h.finals[0]?.isFinal, true)
})

test('defect 6: a long utterance is segmented and the continuation is not dropped', () => {
  const h = harness({ maxSegmentSamples: 2048, minFinalSamples: 512 })
  h.segmenter.begin(0)

  const frames = 8
  for (let i = 0; i < frames; i += 1) {
    h.segmenter.pushFrame(new Float32Array(512).fill(0.1), i * 32)
  }

  // 2048 samples is one full segment: it is finalized and a continuation opens.
  assert.ok(h.finals.length >= 1, 'the first segment must be finalized')
  assert.equal(h.segmenter.inUtterance, true, 'capture keeps the utterance open')
  const first = h.finals[0]
  assert.ok(first)
  assert.equal(first.utteranceId, 'utt-1')

  h.segmenter.end(9_000)
  assert.equal(h.finals.length, 2, 'the continuation must also be transcribed')
  const second = h.finals[1]
  assert.ok(second)
  assert.notEqual(second.utteranceId, first.utteranceId, 'each segment needs its own id')
  assert.equal(second.continuesFrom, first.utteranceId)

  const totalSamples =
    h.finals.reduce((sum, segment) => sum + segment.pcm.length, 0) +
    h.partials.reduce((sum, segment) => sum + segment.pcm.length, 0)
  assert.ok(totalSamples >= frames * 512, 'no audio may be discarded at the cut')
})

test('a continuation is primed with the previous segment text', () => {
  const h = harness({ maxSegmentSamples: 1024, minFinalSamples: 256 })
  h.segmenter.begin(0)
  h.segmenter.pushFrame(new Float32Array(512), 0)
  h.segmenter.pushFrame(new Float32Array(512), 32)
  h.segmenter.noteFinalText('we need to check the build first')
  h.segmenter.pushFrame(new Float32Array(512), 64)
  h.segmenter.end(96)

  const continuation = h.finals[1]
  assert.ok(continuation)
  assert.equal(continuation.initialPrompt, 'we need to check the build first')
})

test('exactly one final per utterance id, and short audio is not a message', () => {
  const h = harness({ minFinalSamples: 1024 })
  h.segmenter.begin(0)
  h.segmenter.pushFrame(new Float32Array(256), 0)
  assert.equal(h.segmenter.end(100), null, 'too short to be speech')
  assert.equal(h.finals.length, 0)

  h.segmenter.begin(200)
  h.segmenter.pushFrame(new Float32Array(1024), 200)
  const first = h.segmenter.end(400)
  assert.ok(first)
  h.segmenter.end(500)
  h.segmenter.flush(600)
  assert.equal(h.finals.length, 1, 'a repeated end/flush must not duplicate the utterance')
})

test('pre-roll keeps the first word of an utterance', () => {
  const h = harness({ prerollFrames: 3, minFinalSamples: 256 })
  h.segmenter.pushFrame(new Float32Array(512).fill(1), 0)
  h.segmenter.pushFrame(new Float32Array(512).fill(1), 32)
  h.segmenter.begin(64)
  h.segmenter.pushFrame(new Float32Array(512).fill(1), 64)
  const ended = h.segmenter.end(96)
  assert.ok(ended)
  assert.equal(ended.pcm.length, 1536, 'two pre-roll frames plus the frame after onset')
})

test('the transcription queue drops superseded partials and always runs finals', async () => {
  const seen: string[] = []
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })

  const queue = new TranscribeQueue(async (job) => {
    if (!job.isFinal) await gate
    seen.push(job.isFinal ? `final:${job.utteranceId}` : `partial:${job.utteranceId}:${job.pcm.length}`)
    return job.isFinal ? 'final text' : 'partial text'
  })

  const partial = queue.enqueue({ utteranceId: 'u1', pcm: new Float32Array(8), isFinal: false })
  const newer = queue.enqueue({ utteranceId: 'u1', pcm: new Float32Array(16), isFinal: false })
  const final = queue.enqueue({ utteranceId: 'u1', pcm: new Float32Array(32), isFinal: true })
  release()

  assert.equal(await partial, null, 'a partial that a newer one replaced is dropped')
  assert.equal(await newer, 'partial text')
  assert.equal(await final, 'final text')
  assert.deepEqual(seen, ['partial:u1:8', 'partial:u1:16', 'final:u1'])
})
