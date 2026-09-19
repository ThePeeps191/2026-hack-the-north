// Local voice-activity detection.
//
// Ported from tools/voice-lab/src/modules/vad-engine.ts and
// tools/voice-lab/src/modules/interrupt-policy.ts, with two deliberate fixes:
//
//  1. `reset()` now also resets the inference stream (Silero's LSTM state and
//     its 64-sample context window), not just the counters. Without that a
//     second join mis-detects: the model carries the previous session's state.
//  2. The engine can be fed a dynamic positive threshold, so barge-in can be
//     made stricter while agent audio is playing back (echo outside headphones).
//
// The ONNX session itself lives in the helper process (`voice/helper/vad-session.ts`);
// this file owns the frame counters and the policy, which is what the main
// process must be able to unit test without any native dependency.
//
// No parameter properties / enums: loaded by `node --experimental-strip-types --test`.

import { concatFloat32 } from './pcm.ts'

export type VadEvent = 'speech-start' | 'speech-end'

/** The ONNX side of the engine. `reset` clears recurrent state (Silero h/c/state). */
export interface VadInferencer {
  infer(frame: Float32Array): Promise<number>
  reset(): void
}

export interface SileroVadOptions {
  /** 512 samples at 16 kHz. */
  frameSamples: number
  minSpeechFrames: number
  minSilenceFrames: number
  positiveThreshold: number
  negativeThreshold: number
  infer: VadInferencer
}

type Listener = (probability: number) => void

export class VoiceActivityDetector {
  private leftover: Float32Array = new Float32Array(0)
  private voiced = 0
  private silent = 0
  private inSpeech = false
  private positiveThreshold: number
  private readonly listeners = new Map<VadEvent, Listener[]>()
  private readonly opts: SileroVadOptions

  constructor(opts: SileroVadOptions) {
    this.opts = opts
    this.positiveThreshold = opts.positiveThreshold
  }

  on(event: VadEvent, listener: Listener): () => void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return () => {
      const next = (this.listeners.get(event) ?? []).filter((item) => item !== listener)
      this.listeners.set(event, next)
    }
  }

  /** Pushes any number of samples; frames internally. Returns the last probability. */
  async push(samples: Float32Array): Promise<number | null> {
    this.leftover = concatFloat32(
      this.leftover.length === 0 ? [samples] : [this.leftover, samples]
    )
    let last: number | null = null
    while (this.leftover.length >= this.opts.frameSamples) {
      const frame = this.leftover.subarray(0, this.opts.frameSamples)
      this.leftover = this.leftover.subarray(this.opts.frameSamples).slice()
      last = await this.opts.infer.infer(frame)
      this.handleProbability(last)
    }
    return last
  }

  /**
   * Between capture sessions. Clears counters *and* the model's recurrent state,
   * so joining a second room starts from silence instead of the last utterance.
   */
  reset(): void {
    this.leftover = new Float32Array(0)
    this.voiced = 0
    this.silent = 0
    this.inSpeech = false
    this.positiveThreshold = this.opts.positiveThreshold
    this.opts.infer.reset()
  }

  setPositiveThreshold(threshold: number): void {
    this.positiveThreshold = threshold
  }

  setMinSilenceFrames(frames: number): void {
    this.opts.minSilenceFrames = Math.max(1, frames)
  }

  get speaking(): boolean {
    return this.inSpeech
  }

  get threshold(): number {
    return this.positiveThreshold
  }

  private handleProbability(probability: number): void {
    if (!this.inSpeech) {
      if (probability >= this.positiveThreshold) {
        this.voiced += 1
        if (this.voiced >= this.opts.minSpeechFrames) {
          this.inSpeech = true
          this.voiced = 0
          this.silent = 0
          this.emit('speech-start', probability)
        }
      } else {
        this.voiced = 0
      }
      return
    }

    if (probability < this.opts.negativeThreshold) {
      this.silent += 1
      if (this.silent >= this.opts.minSilenceFrames) {
        this.inSpeech = false
        this.silent = 0
        this.voiced = 0
        this.emit('speech-end', probability)
      }
    } else {
      this.silent = 0
    }
  }

  private emit(event: VadEvent, probability: number): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(probability)
    }
  }
}

export interface BargeInPolicyOptions {
  /** Consecutive above-threshold audio required before the human wins the floor. */
  minSpeechMs: number
  /** Threshold while agent audio is playing (settings.voice.bargeInThreshold). */
  bargeInThreshold: number
  /** Width of one VAD frame, 32 ms at 16 kHz. */
  frameMs: number
}

/**
 * Ported from the voice lab's `InterruptPolicy`.
 *
 * Local VAD decides this, never a transcript: the human's speech stops agent
 * audio while transcription is still running. The threshold is higher during
 * playback so loudspeaker echo cannot interrupt an agent that is talking.
 */
export class BargeInPolicy {
  private consecutiveMs = 0
  private readonly opts: BargeInPolicyOptions

  constructor(opts: BargeInPolicyOptions) {
    this.opts = opts
  }

  observe(input: { probability: number; playbackActive: boolean }): boolean {
    if (!input.playbackActive) {
      this.consecutiveMs = 0
      return false
    }
    if (input.probability >= this.opts.bargeInThreshold) {
      this.consecutiveMs += this.opts.frameMs
      return this.consecutiveMs >= this.opts.minSpeechMs
    }
    this.consecutiveMs = 0
    return false
  }

  reset(): void {
    this.consecutiveMs = 0
  }
}
