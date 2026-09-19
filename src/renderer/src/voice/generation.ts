// Per-generation playback bookkeeping, with no Web Audio in it.
//
// Ported from tools/voice-lab/src/modules/generation-guard.ts and
// playback-session.ts, and made strict about the two things the lab got wrong:
//
//  - a chunk is played only if its `generationId` is the *active* generation, so
//    late chunks from an interrupted generation can never restart audio
//  - a generation completes only when synthesis reached EOF **and** the output
//    buffer drained; an empty buffer at the start does not end an utterance
//
// The Web Audio scheduler in ./playback.ts drives this; the unit test in
// ./generation.test.ts exercises it directly in Node.

import type { HaltReason } from '../../../shared/voice.ts'

export interface ActiveGeneration {
  generationId: string
  agentId: string
  text: string
  messageId: string | null
  sampleRate: number
  /** Server said synthesis finished (EOF), not that playback is over. */
  synthesisEnded: boolean
  /** First chunk for this generation was scheduled on the output device. */
  firstAudible: boolean
  /** Sources created for this generation that have not ended yet. */
  pendingSources: number
  scheduledSamples: number
  startedAt: number
  drainedReported: boolean
  /** Set when playback was stopped locally: every later chunk is dropped. */
  halted: HaltReason | null
  droppedChunks: number
}

export interface BeginGenerationInput {
  generationId: string
  agentId: string
  text: string
  messageId: string | null
  sampleRate: number
  now: number
}

export type SourceEndResult = 'drained' | 'waiting' | 'stale'

export class PlaybackGate {
  private active: ActiveGeneration | null = null

  current(): ActiveGeneration | null {
    return this.active
  }

  activeGenerationId(): string | null {
    return this.active?.generationId ?? null
  }

  /**
   * Starts a new generation. Any generation already in flight is dropped, so an
   * overlap can never produce two audible agents.
   */
  begin(input: BeginGenerationInput): ActiveGeneration {
    const previous = this.active
    if (previous) previous.halted = 'stale'
    const generation: ActiveGeneration = {
      generationId: input.generationId,
      agentId: input.agentId,
      text: input.text,
      messageId: input.messageId,
      sampleRate: input.sampleRate,
      synthesisEnded: false,
      firstAudible: false,
      pendingSources: 0,
      scheduledSamples: 0,
      startedAt: input.now,
      drainedReported: false,
      halted: null,
      droppedChunks: 0
    }
    this.active = generation
    return generation
  }

  /** Defect 4: only the active, un-halted generation may schedule audio. */
  accepts(generationId: string): boolean {
    const active = this.active
    if (!active || active.halted !== null) return false
    return active.generationId === generationId
  }

  /** Counts a dropped chunk so the UI can report honest numbers if needed. */
  noteDropped(): void {
    const active = this.active
    if (active && active.halted === null) active.droppedChunks += 1
  }

  noteScheduled(generationId: string, samples: number): { firstAudible: boolean } | null {
    const active = this.active
    if (!active || active.generationId !== generationId || active.halted !== null) return null
    active.scheduledSamples += samples
    active.pendingSources += 1
    const firstAudible = !active.firstAudible
    active.firstAudible = true
    return { firstAudible }
  }

  markSynthesisEnded(generationId: string): boolean {
    const active = this.active
    if (!active || active.generationId !== generationId) return false
    active.synthesisEnded = true
    return true
  }

  /**
   * A scheduled source finished. `drained` means "the last audio for this
   * generation has now been heard" — which still is not completion unless
   * synthesis already ended.
   */
  sourceEnded(generationId: string): SourceEndResult {
    const active = this.active
    if (!active || active.generationId !== generationId || active.halted !== null) return 'stale'
    active.pendingSources = Math.max(0, active.pendingSources - 1)
    if (active.pendingSources > 0) return 'waiting'
    return active.synthesisEnded ? 'drained' : 'waiting'
  }

  /** Synthesis EOF arrived after the buffer was already empty. */
  synthesisEndedWithEmptyBuffer(generationId: string): boolean {
    const active = this.active
    if (!active || active.generationId !== generationId) return false
    if (active.halted !== null) return false
    return active.firstAudible && active.pendingSources === 0 && !active.drainedReported
  }

  markDrainedReported(generationId: string): void {
    const active = this.active
    if (active && active.generationId === generationId) active.drainedReported = true
  }

  /** Stopping playback invalidates the generation: later chunks are dropped. */
  halt(generationId: string, reason: HaltReason): ActiveGeneration | null {
    const active = this.active
    if (!active || active.generationId !== generationId) return null
    active.halted = reason
    active.pendingSources = 0
    this.active = null
    return active
  }

  /** Stops whatever is playing, for a room change or teardown. */
  haltActive(reason: HaltReason): ActiveGeneration | null {
    const active = this.active
    if (!active) return null
    return this.halt(active.generationId, reason)
  }

  reset(): void {
    if (this.active) this.active.halted = 'stale'
    this.active = null
  }
}

/** Played milliseconds for a generation, from the scheduled audio and the clock. */
export function playedMsFor(generation: ActiveGeneration, sampleRate: number, now: number): number {
  const scheduled = sampleRate > 0 ? (generation.scheduledSamples / sampleRate) * 1000 : 0
  const elapsed = Math.max(0, now - generation.startedAt)
  return Math.max(0, Math.min(scheduled, elapsed))
}
