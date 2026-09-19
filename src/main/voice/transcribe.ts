// Utterance segmentation and the local transcription queue.
//
// Ported from tools/voice-lab/src/server/session.ts (the utterance window logic)
// and tools/voice-lab/src/modules/transcribe-queue.ts, with two deliberate fixes:
//
//  1. A continuous utterance longer than MAX_SEGMENT_SAMPLES is now *segmented*:
//     the finished segment is finalized and a fresh segment continues the same
//     breath. The voice lab called `onSpeechEnd()` and returned, which dropped
//     everything the human said after the cut until VAD happened to fire again —
//     and VAD does not fire while the human keeps talking.
//  2. Exactly one final per utterance id: a segment id is added to a finalized
//     set, so a re-entrant flush cannot produce a second message for the same
//     utterance. Partials never produce a message; they only update live text.
//
// No parameter properties / enums: loaded by `node --experimental-strip-types --test`.

import { CAPTURE_SAMPLE_RATE } from '../../shared/voice.ts'

export interface UtteranceSegment {
  roomId: string
  utteranceId: string
  /** Segment that this one continues, when a long utterance was cut. */
  continuesFrom: string | null
  pcm: Float32Array
  isFinal: boolean
  startedAt: number
  endedAt: number | null
  /** Continuation hint from the previous segment's text, for the local model. */
  initialPrompt: string | null
}

export interface UtteranceSegmenterOptions {
  roomId: string
  now: () => number
  /** MAX_SEGMENT_SAMPLES from shared/voice.ts. */
  maxSegmentSamples: number
  minFinalSamples: number
  minPartialSamples: number
  partialIntervalMs: number
  /** Frames of audio kept before speech onset. */
  prerollFrames: number
  /** Unique per utterance, e.g. `utt-4`. */
  nextUtteranceId: () => string
  onFinal(segment: UtteranceSegment): void
  onPartial(segment: UtteranceSegment): void
}

interface ActiveSegment {
  id: string
  continuesFrom: string | null
  chunks: Float32Array[]
  samples: number
  startedAt: number
  lastPartialAt: number
}

export class UtteranceSegmenter {
  private readonly options: UtteranceSegmenterOptions
  private preroll: Float32Array[] = []
  private active: ActiveSegment | null = null
  private readonly finalized = new Set<string>()
  private lastFinalText: string | null = null
  private lastFinalId: string | null = null
  private segmentIndex = 0

  constructor(options: UtteranceSegmenterOptions) {
    this.options = options
  }

  get inUtterance(): boolean {
    return this.active !== null
  }

  get currentUtteranceId(): string | null {
    return this.active?.id ?? null
  }

  /** VAD speech start. Seeds the segment with the pre-roll so the first word survives. */
  begin(at: number): void {
    if (this.active) return
    const prerollSamples = this.prerollSamples()
    this.segmentIndex = 1
    this.active = {
      id: this.options.nextUtteranceId(),
      continuesFrom: null,
      chunks: [...this.preroll],
      samples: prerollSamples,
      startedAt: prerollSamples > 0 ? at - (prerollSamples / CAPTURE_SAMPLE_RATE) * 1000 : at,
      // Measured from the start of this segment: seeding this with 0 made the
      // very first frame look like an interval had already elapsed, so a partial
      // was requested from silence before the human had really said anything.
      lastPartialAt: at
    }
    this.lastFinalId = null
    this.preroll = []
  }

  /** Every microphone frame, in order. Never drops audio while an utterance is open. */
  pushFrame(pcm: Float32Array, at: number): void {
    const active = this.active
    if (!active) {
      this.preroll.push(pcm)
      while (this.preroll.length > this.options.prerollFrames) this.preroll.shift()
      return
    }

    active.chunks.push(pcm)
    active.samples += pcm.length

    if (active.samples >= this.options.maxSegmentSamples) {
      // The utterance is longer than one segment. Finalize what we have and keep
      // going: capture is never stopped and no audio is discarded.
      this.finalize(at)
      this.beginContinuation(at)
      return
    }

    if (
      at - active.lastPartialAt >= this.options.partialIntervalMs &&
      active.samples >= this.options.minPartialSamples
    ) {
      active.lastPartialAt = at
      this.options.onPartial({
        roomId: this.options.roomId,
        utteranceId: active.id,
        continuesFrom: active.continuesFrom,
        pcm: this.concat(active.chunks),
        isFinal: false,
        startedAt: active.startedAt,
        endedAt: null,
        initialPrompt: null
      })
    }
  }

  /** VAD speech end. Finalizes the open segment, if it is long enough to be speech. */
  end(at: number): UtteranceSegment | null {
    const active = this.active
    this.preroll = []
    if (!active) return null
    const segment = this.finalize(at)
    this.active = null
    this.segmentIndex = 0
    return segment
  }

  /** Capture is stopping (leave, room change). Keeps the human's last words. */
  flush(at: number): UtteranceSegment | null {
    const active = this.active
    this.preroll = []
    if (!active) return null
    const segment = this.finalize(at)
    this.active = null
    this.segmentIndex = 0
    return segment
  }

  /** Forgets in-flight audio without emitting anything (mute, room teardown). */
  reset(): void {
    this.preroll = []
    this.active = null
    this.segmentIndex = 0
  }

  /** The final text of a cut segment, used to prime the continuation. */
  noteFinalText(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    this.lastFinalText = trimmed.length > 220 ? trimmed.slice(-220) : trimmed
  }

  /** Starts the next chunk of one continuous breath after a length cut. */
  private beginContinuation(at: number): void {
    const previous = this.lastFinalId
    this.segmentIndex += 1
    const base = previous ?? this.options.nextUtteranceId()
    this.active = {
      id: `${base}-c${this.segmentIndex}`,
      continuesFrom: previous,
      chunks: [],
      samples: 0,
      startedAt: at,
      // Same rule as `begin`: the interval runs from the start of this segment.
      lastPartialAt: at
    }
  }

  private finalize(at: number): UtteranceSegment | null {
    const active = this.active
    if (!active) return null
    if (this.finalized.has(active.id)) return null
    this.finalized.add(active.id)
    this.lastFinalId = active.id
    this.segmentIndex = Math.max(1, this.segmentIndex)
    if (active.samples < this.options.minFinalSamples) return null
    const segment: UtteranceSegment = {
      roomId: this.options.roomId,
      utteranceId: active.id,
      continuesFrom: active.continuesFrom,
      pcm: this.concat(active.chunks),
      isFinal: true,
      startedAt: active.startedAt,
      endedAt: at,
      initialPrompt: active.continuesFrom ? this.lastFinalText : null
    }
    this.options.onFinal(segment)
    return segment
  }

  private concat(chunks: readonly Float32Array[]): Float32Array {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const out = new Float32Array(total)
    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }

  private prerollSamples(): number {
    return this.preroll.reduce((sum, chunk) => sum + chunk.length, 0)
  }
}

/* ------------------------------------------------------------------ *
 * Local transcription queue
 * ------------------------------------------------------------------ */

export interface TranscribeJob {
  utteranceId: string
  pcm: Float32Array
  isFinal: boolean
  initialPrompt?: string
}

export type TranscribeFn = (job: TranscribeJob) => Promise<string>

interface QueuedJob {
  job: TranscribeJob
  resolve: (value: string | null) => void
  reject: (error: unknown) => void
  stale: boolean
}

/**
 * Ported from the voice lab's `TranscribeQueue`: a newer partial for the same
 * utterance supersedes an older one, finals always run. The local model can only
 * transcribe one window at a time, so this is the one place work is serialised —
 * never the microphone path.
 */
export class TranscribeQueue {
  private pending: QueuedJob[] = []
  private inFlight: QueuedJob | null = null
  private running = false
  private disposed = false
  private readonly transcribe: TranscribeFn

  constructor(transcribe: TranscribeFn) {
    this.transcribe = transcribe
  }

  enqueue(job: TranscribeJob): Promise<string | null> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        resolve(null)
        return
      }
      if (!job.isFinal) {
        this.pending = this.pending.filter((queued) => {
          if (!queued.job.isFinal && queued.job.utteranceId === job.utteranceId) {
            queued.resolve(null)
            return false
          }
          return true
        })
        if (
          this.inFlight &&
          !this.inFlight.job.isFinal &&
          this.inFlight.job.utteranceId === job.utteranceId
        ) {
          this.inFlight.stale = true
        }
      }
      this.pending.push({ job, resolve, reject, stale: false })
      void this.kick()
    })
  }

  /** Drops queued work without waiting for it (leave, room change). */
  clear(): void {
    for (const queued of this.pending) queued.resolve(null)
    this.pending = []
    if (this.inFlight && !this.inFlight.job.isFinal) this.inFlight.stale = true
  }

  dispose(): void {
    this.disposed = true
    this.clear()
  }

  async drain(): Promise<void> {
    while (this.running || this.pending.length > 0) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  private async kick(): Promise<void> {
    if (this.running || this.disposed) return
    const queued = this.pending.shift()
    if (!queued) return

    this.running = true
    this.inFlight = queued
    try {
      const text = await this.transcribe(queued.job)
      queued.resolve(queued.stale ? null : text)
    } catch (error) {
      queued.reject(error)
    } finally {
      this.running = false
      this.inFlight = null
      void this.kick()
    }
  }
}
