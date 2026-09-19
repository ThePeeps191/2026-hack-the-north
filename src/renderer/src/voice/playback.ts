// Web Audio playback for agent speech, driven by ./generation.ts.
//
// Ported from tools/voice-lab/src/client/main.ts (the AudioBufferSourceNode
// scheduler, the zero-gain sanity, and the PCM16 assembler) with these fixes:
//
//  - chunks are dropped unless their generation is the active one (defect 4)
//  - playback reports truth back to the main process: firstAudible, drained,
//    halted — and `drained` is only claimed once synthesis has also ended
//    (defect 3), so an empty buffer cannot end an utterance early
//  - `speech.cancel` halts the sink immediately, even mid-stream (defect 2)
//  - deafening clears the pending buffer instead of building a backlog (defect 10)
//
// The AudioContext is created at PLAYBACK_SAMPLE_RATE (24 kHz); if the device
// refuses that rate, chunks are linearly resampled instead of being played at
// the wrong pitch.

import type { AudioChunkMessage, HaltReason, PlaybackClientEvent } from '../../../shared/voice.ts'
import { PLAYBACK_SAMPLE_RATE } from '../../../shared/voice.ts'
import { PlaybackGate, playedMsFor, type ActiveGeneration } from './generation.ts'
import { Pcm16Assembler, pcm16ToFloat32, resampleLinear } from './pcm.ts'

export interface PlaybackReport {
  generationId: string
  agentId: string
  text: string
  messageId: string | null
  playedMs: number
}

export interface PlaybackCallbacks {
  report(event: PlaybackClientEvent): void
  onAudible(info: PlaybackReport): void
  onDrained(info: PlaybackReport): void
  onHalted(info: PlaybackReport & { reason: HaltReason }): void
  onError(info: PlaybackReport & { message: string }): void
}

export interface PlaybackOptions {
  callbacks: PlaybackCallbacks
  createContext: (sampleRate: number) => AudioContext
  now: () => number
}

export class VoicePlayback {
  private readonly options: PlaybackOptions
  private readonly gate = new PlaybackGate()
  private readonly assembler = new Pcm16Assembler()
  private context: AudioContext | null = null
  private gain: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private readonly levelSamples = new Float32Array(256)
  private sources = new Set<AudioBufferSourceNode>()
  private nextPlayTime = 0
  private deafened = false

  constructor(options: PlaybackOptions) {
    this.options = options
  }

  activeGeneration(): ActiveGeneration | null {
    return this.gate.current()
  }

  isPlaying(): boolean {
    return this.gate.current() !== null
  }

  /** RMS of the output graph, never inferred from queued speech or tokens. */
  outputLevel(): number {
    if (!this.analyser || this.deafened || this.context?.state !== 'running' || this.sources.size === 0) return 0
    this.analyser.getFloatTimeDomainData(this.levelSamples)
    let sum = 0
    for (const sample of this.levelSamples) sum += sample * sample
    return Math.min(1, Math.sqrt(sum / this.levelSamples.length))
  }

  /** `speech.begin`: the main process announced a generation. */
  begin(input: {
    generationId: string
    agentId: string
    text: string
    messageId: string | null
    sampleRate: number
  }): void {
    const context = this.ensureContext()
    this.stopSources()
    this.assembler.reset()
    this.gate.begin({
      generationId: input.generationId,
      agentId: input.agentId,
      text: input.text,
      messageId: input.messageId,
      sampleRate: input.sampleRate,
      now: this.options.now()
    })
    this.nextPlayTime = 0
    if (context && context.state === 'suspended') {
      void context.resume().catch(() => undefined)
    }
  }

  /** A PCM chunk from the main process. Anything stale is dropped, not played. */
  push(chunk: AudioChunkMessage): void {
    if (this.deafened) {
      this.gate.noteDropped()
      return
    }
    if (!this.gate.accepts(chunk.generationId)) {
      this.gate.noteDropped()
      return
    }
    const context = this.ensureContext()
    if (!context) return
    const aligned = this.assembler.push(new Uint8Array(chunk.pcm))
    if (aligned.byteLength < 2) return
    const samples = pcm16ToFloat32(aligned)
    const generation = this.gate.current()
    if (!generation) return
    const scheduled = this.schedule(generation, samples, context)
    if (!scheduled) return
    if (scheduled.firstAudible) {
      this.options.callbacks.report({
        type: 'playback.firstAudible',
        generationId: generation.generationId,
        at: this.options.now()
      })
      this.options.callbacks.onAudible(this.reportFor(generation))
    }
  }

  /** `speech.synthesisEnded`: EOF. Completion still waits for the buffer to drain. */
  synthesisEnded(generationId: string): void {
    if (!this.gate.markSynthesisEnded(generationId)) return
    if (this.gate.synthesisEndedWithEmptyBuffer(generationId)) {
      this.reportDrained(generationId)
    }
  }

  /** `speech.cancel`: stop now, even while synthesis is still streaming. */
  halt(generationId: string, reason: HaltReason): void {
    const generation = this.gate.current()
    if (!generation || generation.generationId !== generationId) {
      // Already halted: never restart audio for a stale generation.
      return
    }
    const playedMs = playedMsFor(generation, this.playbackRate(), this.options.now())
    this.gate.halt(generationId, reason)
    this.stopSources()
    this.assembler.reset()
    this.options.callbacks.report({ type: 'playback.halted', generationId, playedMs, reason })
    this.options.callbacks.onHalted({ ...this.reportFor(generation), playedMs, reason })
  }

  /** Local teardown (leave, room change, dispose). */
  stopAll(reason: HaltReason): void {
    const generation = this.gate.current()
    if (!generation) {
      this.stopSources()
      return
    }
    this.halt(generation.generationId, reason)
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened
    if (!this.gain) return
    this.gain.gain.value = deafened ? 0 : 1
    if (deafened) {
      // Nothing is buffered while deafened, so undeafening cannot release a backlog.
      this.stopAll('deafen')
    }
  }

  dispose(): void {
    this.stopSources()
    this.gate.reset()
    const context = this.context
    this.context = null
    this.gain = null
    this.analyser = null
    if (context) void context.close().catch(() => undefined)
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private reportFor(generation: ActiveGeneration): PlaybackReport {
    return {
      generationId: generation.generationId,
      agentId: generation.agentId,
      text: generation.text,
      messageId: generation.messageId,
      playedMs: playedMsFor(generation, this.playbackRate(), this.options.now())
    }
  }

  private playbackRate(): number {
    return this.context?.sampleRate ?? PLAYBACK_SAMPLE_RATE
  }

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context
    try {
      const context = this.options.createContext(PLAYBACK_SAMPLE_RATE)
      const gain = context.createGain()
      const analyser = context.createAnalyser()
      analyser.fftSize = this.levelSamples.length
      gain.gain.value = this.deafened ? 0 : 1
      gain.connect(analyser)
      analyser.connect(context.destination)
      this.context = context
      this.gain = gain
      this.analyser = analyser
      return context
    } catch (error) {
      const generation = this.gate.current()
      const message = error instanceof Error ? error.message : String(error)
      if (generation) {
        this.options.callbacks.report({
          type: 'playback.error',
          generationId: generation.generationId,
          message
        })
        this.options.callbacks.onError({ ...this.reportFor(generation), message })
      }
      return null
    }
  }

  private schedule(
    generation: ActiveGeneration,
    samples: Float32Array,
    context: AudioContext
  ): { firstAudible: boolean } | null {
    const gain = this.gain
    if (!gain) return null
    const rate = context.sampleRate
    const rendered = rate === PLAYBACK_SAMPLE_RATE ? samples : resampleLinear(samples, PLAYBACK_SAMPLE_RATE, rate)
    const buffer = context.createBuffer(1, Math.max(1, rendered.length), rate)
    buffer.getChannelData(0).set(rendered)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(gain)

    const booked = this.gate.noteScheduled(generation.generationId, rendered.length)
    if (!booked) return null

    const now = context.currentTime
    if (this.nextPlayTime < now + 0.02) this.nextPlayTime = now + 0.02
    const startAt = this.nextPlayTime
    this.nextPlayTime += buffer.duration
    source.onended = () => {
      this.sources.delete(source)
      const result = this.gate.sourceEnded(generation.generationId)
      if (result === 'drained') this.reportDrained(generation.generationId)
    }
    try {
      source.start(startAt)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.options.callbacks.report({
        type: 'playback.error',
        generationId: generation.generationId,
        message
      })
      this.options.callbacks.onError({ ...this.reportFor(generation), message })
      return null
    }
    this.sources.add(source)
    return { firstAudible: booked.firstAudible }
  }

  private reportDrained(generationId: string): void {
    const generation = this.gate.current()
    if (!generation || generation.generationId !== generationId) return
    if (generation.drainedReported) return
    if (!generation.synthesisEnded) return
    this.gate.markDrainedReported(generationId)
    const playedMs = playedMsFor(generation, this.playbackRate(), this.options.now())
    this.options.callbacks.report({ type: 'playback.drained', generationId, playedMs })
    this.options.callbacks.onDrained({ ...this.reportFor(generation), playedMs })
    this.gate.halt(generationId, 'stale')
    this.assembler.reset()
  }

  private stopSources(): void {
    for (const source of this.sources) {
      try {
        source.onended = null
        source.stop()
      } catch {
        // Already stopped or never started.
      }
    }
    this.sources.clear()
    this.nextPlayTime = 0
  }
}
