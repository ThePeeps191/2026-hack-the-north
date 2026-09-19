// Honest voice timing measurements.
//
// Ported from tools/voice-lab/src/modules/timing.ts (same shape: mark an event,
// read the delta later) and mapped onto the four `TimingLabel`s that
// shared/types.ts already defines, so the UI can show where the milliseconds go:
//
//   endpointing          vadSpeechStartToPlaybackHalt
//                        (local VAD -> agent audio actually stopped, i.e. barge-in)
//   endpointing + STT    utteranceEndToFinalTranscript
//                        (VAD speech end -> final text available locally)
//   server dispatch      finalTranscriptToFirstAudioChunkPlayed, detail 'phase=dispatch'
//                        (final text -> main process handed speech to the floor)
//   client receipt       finalTranscriptToFirstAudioChunkPlayed, detail 'phase=audible'
//                        (sink dispatch -> renderer reported first audible frame)
//
// Samples go out through `bus.recordTimings` (which also broadcasts
// `voice.timing`) and are kept in a small local ring for `VoiceHost.timings()`.
//
// No parameter properties / enums: loaded by `node --experimental-strip-types --test`.

import type { TimingSample } from '../../shared/types.ts'

export type TimingSink = (samples: TimingSample[]) => void

const MAX_RETAINED = 200
/** How long a finalized human utterance can still be the question being answered. */
const DISPATCH_WINDOW_MS = 45_000

export class VoiceTimings {
  private readonly record: TimingSink
  private readonly now: () => number
  private readonly retained: TimingSample[] = []
  private vadSpeechStartAt: number | null = null
  private readonly pendingUtterances = new Map<string, number>()
  private lastEndpointAt: number | null = null
  private lastDispatchAt: number | null = null
  private lastDispatchUtterance: string | null = null

  constructor(record: TimingSink, now: () => number) {
    this.record = record
    this.now = now
  }

  /** Local VAD says the human started talking. */
  markVadSpeechStart(at: number): void {
    if (this.vadSpeechStartAt === null) this.vadSpeechStartAt = at
  }

  /** Agent audio actually stopped. Records barge-in latency when we know when speech began. */
  markPlaybackHalted(at: number, reason: string): void {
    const startedAt = this.vadSpeechStartAt
    this.vadSpeechStartAt = null
    if (startedAt === null) return
    if (reason !== 'bargeIn' && reason !== 'deafen' && reason !== 'stopSpeaking') return
    this.push('vadSpeechStartToPlaybackHalt', at - startedAt, `reason=${reason}`)
  }

  /** VAD speech end (endpointing started). */
  markUtteranceEnd(utteranceId: string, at: number): void {
    this.pendingUtterances.set(utteranceId, at)
    this.lastEndpointAt = at
  }

  /** Final transcript for that utterance exists. */
  markFinalTranscript(utteranceId: string, at: number): void {
    const endedAt = this.pendingUtterances.get(utteranceId)
    this.pendingUtterances.delete(utteranceId)
    if (endedAt === undefined) return
    this.push('utteranceEndToFinalTranscript', at - endedAt, `utterance=${utteranceId}`)
  }

  /**
   * The host handed a speech generation to the floor for that final transcript.
   * Records the server-dispatch hop, measured from the human's endpoint.
   */
  markSpeechDispatched(utteranceId: string | null, at: number): void {
    const baseline = this.lastEndpointAt
    this.lastDispatchAt = at
    this.lastDispatchUtterance = utteranceId
    if (baseline === null) return
    if (at - baseline > DISPATCH_WINDOW_MS) return
    this.push(
      'finalTranscriptToFirstAudioChunkPlayed',
      at - baseline,
      `phase=dispatch utterance=${utteranceId ?? 'none'}`
    )
  }

  /** Renderer reported the first audible frame. `phase=audible` is the client hop. */
  markFirstAudible(at: number, generationId: string): void {
    const dispatchedAt = this.lastDispatchAt
    const utterance = this.lastDispatchUtterance
    this.lastDispatchAt = null
    this.lastDispatchUtterance = null
    if (dispatchedAt === null) return
    if (at - dispatchedAt > DISPATCH_WINDOW_MS) return
    this.push(
      'finalTranscriptToFirstAudioChunkPlayed',
      at - dispatchedAt,
      `phase=audible generation=${generationId} utterance=${utterance ?? 'none'}`
    )
  }

  snapshot(): TimingSample[] {
    return this.retained.map((sample) => ({ ...sample }))
  }

  private push(label: TimingSample['label'], ms: number, detail?: string): void {
    if (!Number.isFinite(ms) || ms < 0) return
    const sample: TimingSample = {
      label,
      ms: Math.round(ms),
      at: new Date(this.now()).toISOString(),
      ...(detail ? { detail } : {})
    }
    this.retained.push(sample)
    if (this.retained.length > MAX_RETAINED) {
      this.retained.splice(0, this.retained.length - MAX_RETAINED)
    }
    try {
      this.record([sample])
    } catch {
      // A failing bus must never break audio.
    }
  }
}
