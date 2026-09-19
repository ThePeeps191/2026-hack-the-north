// The room speech floor: who is audible right now, and what is worth saying.
//
// Ported in spirit from the voice lab's `GenerationGuard` + `PlaybackSession`
// pair (one generation at a time, late chunks dropped) but rebuilt as an actual
// scheduler, because a room with three agents and one human needs priority, not
// a queue of everything they ever generated.
//
// Rules enforced here (each one has a unit test):
//  - one AI speaker at a time, never two generations audible together
//  - speech state follows the client (`firstAudible` / `drained`), never the
//    moment tokens or audio arrived in the main process
//  - a speech is complete only when synthesis reached EOF *and* playback drained
//  - the human outranks every agent: starting to talk halts the current speaker
//    and no new agent speech starts until the human stops
//  - direct answers win: `answer` (100) beats `ack` (40) and `status` (10)
//  - stale queued speech is dropped (expired, superseded revision, or simply old)
//  - no speech in a room that is not the active room, and nothing at all while deafened
//  - aging prevents starvation of low priority speech under a stream of answers
//  - stop-speaking / deafen never touches execution: this file only stops audio
//
// No parameter properties / enums: loaded by `node --experimental-strip-types --test`.

import type { SpeechIntent } from '../contracts.ts'
import type { HaltReason, SpeechReason } from '../../shared/voice.ts'
import { SPEECH_PRIORITY } from '../../shared/voice.ts'

export type SpeechOutcome = 'played' | 'interrupted' | 'cancelled' | 'unheard' | 'error'

export interface SpeechResult {
  state: SpeechOutcome
  playedChars: number | null
}

export interface SpeechFloorItem {
  intent: SpeechIntent
  seq: number
  enqueuedAt: number
  /** Short turns: the intent is spoken as several bounded parts, in order. */
  parts: string[]
  partIndex: number
  generationId: string | null
  synthesisEnded: boolean
  drained: boolean
  audible: boolean
  settled: boolean
  partsPlayed: number
  /**
   * Fraction of the current part the renderer reported as played, set by the
   * host from `playback.halted { playedMs }` against the audio it streamed.
   */
  playedFraction: number | null
  /** Resolves the `SpeechHandle` this item was queued with. */
  promise: Promise<SpeechResult>
  settle(result: SpeechResult): void
}

export interface FloorHooks {
  now(): number
  /** Start audio for `item.parts[item.partIndex]`; the host owns synthesis. */
  beginPart(item: SpeechFloorItem, generationId: string, text: string): void
  /** Stop audio for a part that is in flight. */
  haltPart(item: SpeechFloorItem, generationId: string, reason: HaltReason): void
  /** The item is over. The host updates message + agent speech state from this. */
  complete(item: SpeechFloorItem, result: SpeechResult): void
  /** An item was dropped without ever being audible. */
  drop(item: SpeechFloorItem, result: SpeechResult, detail: string): void
  /** Agent ids waiting for the floor, for the UI. */
  queueChanged(agentIds: string[]): void
}

export interface SpeechFloorOptions {
  now: () => number
  hooks: FloorHooks
  /** Called for every part; must be unique per process run. */
  nextGenerationId: () => string
  /** Priority gained per `agingStepMs` spent waiting, so nothing starves. */
  agingStepMs?: number
  agingBonusCap?: number
  /** Queued speech older than this is no longer worth saying. */
  staleAfterMs?: number
  maxQueued?: number
  partMaxChars?: number
  maxParts?: number
  /** Chatter that is dropped as soon as the human starts talking. */
  droppedOnHumanSpeech?: readonly SpeechReason[]
}

const DEFAULT_OPTIONS = {
  agingStepMs: 1500,
  agingBonusCap: 45,
  staleAfterMs: 30_000,
  maxQueued: 8,
  partMaxChars: 320,
  maxParts: 4
} as const

const CHATTY: readonly SpeechReason[] = ['status', 'peer']

/**
 * Splits long text into speakable parts. Nothing is ever dropped: the tail is
 * merged into the last part so a long answer is still said in full, just in
 * bounded turns.
 */
export function splitForSpeech(text: string, maxChars = 320, maxParts = 4): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  if (clean.length <= maxChars) return [clean]

  const pieces: string[] = []
  let rest = clean
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    let cut = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('? '),
      window.lastIndexOf('! '),
      window.lastIndexOf('; ')
    )
    if (cut < maxChars * 0.4) cut = window.lastIndexOf(' ')
    if (cut <= 0) cut = maxChars - 1
    else cut += 1
    const piece = rest.slice(0, cut).trim()
    if (piece) pieces.push(piece)
    rest = rest.slice(cut).trim()
  }
  if (rest) pieces.push(rest)
  if (pieces.length <= maxParts) return pieces

  const head = pieces.slice(0, maxParts - 1)
  const tail = pieces.slice(maxParts - 1).join(' ')
  return [...head, tail]
}

export class SpeechFloor {
  private readonly options: Required<Omit<SpeechFloorOptions, 'hooks' | 'now' | 'nextGenerationId'>> & {
    now: () => number
    hooks: FloorHooks
    nextGenerationId: () => string
  }
  private queue: SpeechFloorItem[] = []
  private current: SpeechFloorItem | null = null
  private seq = 0
  private activeRoomId: string | null = null
  private deafened = false
  private humanSpeaking = false
  private decisionRevision = 0

  constructor(options: SpeechFloorOptions) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      hooks: options.hooks,
      now: options.now,
      nextGenerationId: options.nextGenerationId,
      partMaxChars: options.partMaxChars ?? DEFAULT_OPTIONS.partMaxChars,
      maxParts: options.maxParts ?? DEFAULT_OPTIONS.maxParts,
      droppedOnHumanSpeech: options.droppedOnHumanSpeech ?? CHATTY
    }
  }

  /* ---------------------------------------------------------------- *
   * Room lifecycle
   * ---------------------------------------------------------------- */

  get roomId(): string | null {
    return this.activeRoomId
  }

  setActiveRoom(roomId: string | null): void {
    if (this.activeRoomId === roomId) return
    if (this.current) {
      const item = this.current
      const generationId = item.generationId
      this.current = null
      if (generationId) this.safeHalt(item, generationId, 'roomChange')
      this.finish(item, this.resultFor(item, 'cancelled'))
    }
    this.dropAll('cancelled', 'roomChanged')
    this.activeRoomId = roomId
    this.humanSpeaking = false
    this.decisionRevision = 0
    this.emitQueue()
  }

  setDeafened(deafened: boolean): void {
    if (this.deafened === deafened) return
    this.deafened = deafened
    if (!deafened) return
    // Nothing is queued while deafened, so undeafening does not release a backlog.
    if (this.current) {
      const item = this.current
      const generationId = item.generationId
      const result = this.resultFor(item, item.audible ? 'interrupted' : 'unheard')
      this.current = null
      if (generationId) this.safeHalt(item, generationId, 'deafen')
      this.finish(item, result)
    }
    this.dropAll('unheard', 'deafened')
  }

  isDeafened(): boolean {
    return this.deafened
  }

  invalidateSpeechBefore(roomId: string, decisionRevision: number): void {
    if (this.activeRoomId !== roomId) return
    if (decisionRevision > this.decisionRevision) this.decisionRevision = decisionRevision
    const stale = this.queue.filter((item) => item.intent.decisionRevision < this.decisionRevision)
    if (stale.length === 0) return
    this.queue = this.queue.filter((item) => !stale.includes(item))
    for (const item of stale) {
      this.finish(item, this.resultFor(item, 'unheard'), 'staleDecision')
    }
    this.emitQueue()
  }

  /* ---------------------------------------------------------------- *
   * Queueing
   * ---------------------------------------------------------------- */

  enqueue(intent: SpeechIntent): { handle: { generationId: string; done: Promise<SpeechResult> } } {
    const now = this.options.now()
    const item = this.createItem(intent, now)

    if (this.activeRoomId === null || intent.roomId !== this.activeRoomId) {
      this.finish(item, this.resultFor(item, 'cancelled'), 'inactiveRoom')
      return { handle: { generationId: item.generationId ?? '', done: item.promise } }
    }
    if (this.deafened) {
      this.finish(item, this.resultFor(item, 'unheard'), 'deafened')
      return { handle: { generationId: item.generationId ?? '', done: item.promise } }
    }
    if (item.parts.length === 0) {
      this.finish(item, this.resultFor(item, 'unheard'), 'emptyText')
      return { handle: { generationId: item.generationId ?? '', done: item.promise } }
    }

    if (intent.decisionRevision > this.decisionRevision) {
      this.decisionRevision = intent.decisionRevision
    }
    // A new direct answer makes the same agent's pending chatter pointless, and
    // it also wins the floor if low-priority chatter is already speaking.
    if (intent.reason === 'answer' || intent.reason === 'clarify') {
      const superseded = this.queue.filter(
        (queued) => queued.intent.agentId === intent.agentId && this.options.droppedOnHumanSpeech.includes(queued.intent.reason)
      )
      if (superseded.length > 0) {
        this.queue = this.queue.filter((queued) => !superseded.includes(queued))
        for (const item2 of superseded) {
          this.finish(item2, this.resultFor(item2, 'unheard'), 'supersededByAnswer')
        }
      }
      const current = this.current
      if (current && this.options.droppedOnHumanSpeech.includes(current.intent.reason)) {
        const generationId = current.generationId
        this.current = null
        if (generationId) this.safeHalt(current, generationId, 'stopSpeaking')
        this.finish(current, this.resultFor(current, 'interrupted'))
      }
    }

    const stale = this.queue.filter((queued) => queued.intent.decisionRevision < this.decisionRevision)
    if (stale.length > 0) {
      this.queue = this.queue.filter((queued) => !stale.includes(queued))
      for (const item2 of stale) {
        this.finish(item2, this.resultFor(item2, 'unheard'), 'staleDecision')
      }
    }

    this.queue.push(item)
    this.trimQueue()
    this.emitQueue()
    this.pump()
    return { handle: { generationId: item.generationId ?? '', done: item.promise } }
  }

  stopSpeaking(reason: HaltReason, scope: 'current' | 'all'): void {
    if (this.current) {
      const item = this.current
      const generationId = item.generationId
      this.current = null
      if (generationId) this.safeHalt(item, generationId, reason)
      this.finish(item, this.resultFor(item, 'cancelled'))
    }
    if (scope === 'all') this.dropAll('cancelled', reason)
    else this.emitQueue()
    this.pump()
  }

  /* ---------------------------------------------------------------- *
   * Human speech
   * ---------------------------------------------------------------- */

  humanSpeechStart(): void {
    this.humanSpeaking = true
    if (this.current) {
      const item = this.current
      const generationId = item.generationId
      this.current = null
      if (generationId) this.safeHalt(item, generationId, 'bargeIn')
      this.finish(item, this.resultFor(item, 'interrupted'))
    }
    const chatter = this.queue.filter((item) => this.options.droppedOnHumanSpeech.includes(item.intent.reason))
    if (chatter.length > 0) {
      this.queue = this.queue.filter((item) => !chatter.includes(item))
      for (const item of chatter) {
        this.finish(item, this.resultFor(item, 'unheard'), 'humanSpeaking')
      }
    }
    this.emitQueue()
  }

  humanSpeechEnd(): void {
    this.humanSpeaking = false
    this.pump()
  }

  isHumanSpeaking(): boolean {
    return this.humanSpeaking
  }

  /* ---------------------------------------------------------------- *
   * Client playback reports
   * ---------------------------------------------------------------- */

  onFirstAudible(generationId: string): boolean {
    const item = this.current
    if (!item || item.generationId !== generationId) return false
    item.audible = true
    return true
  }

  onSynthesisEnded(generationId: string): boolean {
    const item = this.current
    if (!item || item.generationId !== generationId) return false
    item.synthesisEnded = true
    // Both orders are valid: a short line can drain before its stream closes.
    if (item.drained) this.completePart(item)
    return true
  }

  /**
   * The renderer's buffer drained. Completion needs synthesis EOF as well: an
   * empty buffer at the start of an utterance must not end it.
   */
  onPlaybackDrained(generationId: string): boolean {
    const item = this.current
    if (!item || item.generationId !== generationId) return false
    item.drained = true
    if (!item.synthesisEnded) return false
    this.completePart(item)
    return true
  }

  onPlaybackHalted(generationId: string, reason: HaltReason): void {
    const item = this.current
    if (!item || item.generationId !== generationId) return
    this.current = null
    this.finish(item, this.resultFor(item, reason === 'bargeIn' ? 'interrupted' : 'cancelled'))
    this.pump()
  }

  onPlaybackError(generationId: string): void {
    const item = this.current
    if (!item || item.generationId !== generationId) return
    this.current = null
    this.finish(item, this.resultFor(item, 'error'))
    this.pump()
  }

  /**
   * Synthesis failed. We never pretend audio played: the item ends as an error
   * and any remaining parts are dropped.
   */
  onSynthesisFailed(generationId: string): void {
    const item = this.current
    if (!item || item.generationId !== generationId) return
    this.current = null
    this.finish(item, this.resultFor(item, 'error'))
    this.pump()
  }

  /* ---------------------------------------------------------------- *
   * Introspection
   * ---------------------------------------------------------------- */

  isSpeaking(): boolean {
    return this.current !== null
  }

  isAudible(): boolean {
    return this.current !== null && this.current.audible
  }

  currentItem(): SpeechFloorItem | null {
    return this.current
  }

  queuedAgentIds(): string[] {
    const seen: string[] = []
    for (const item of this.queue) {
      if (!seen.includes(item.intent.agentId)) seen.push(item.intent.agentId)
    }
    return seen
  }

  queuedItems(): SpeechFloorItem[] {
    return [...this.queue]
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private createItem(intent: SpeechIntent, now: number): SpeechFloorItem {
    this.seq += 1
    let settle: (result: SpeechResult) => void = () => undefined
    const promise = new Promise<SpeechResult>((resolve) => {
      settle = resolve
    })
    return {
      intent,
      seq: this.seq,
      enqueuedAt: now,
      parts: splitForSpeech(intent.text, this.options.partMaxChars, this.options.maxParts),
      partIndex: 0,
      // Pre-allocated so the SpeechHandle always carries the id the first part
      // will actually use; later parts get fresh ids.
      generationId: this.options.nextGenerationId(),
      synthesisEnded: false,
      drained: false,
      audible: false,
      settled: false,
      partsPlayed: 0,
      playedFraction: null,
      promise,
      settle
    }
  }

  private resultFor(item: SpeechFloorItem, state: SpeechOutcome): SpeechResult {
    if (state === 'played') {
      return { state, playedChars: item.intent.text.length }
    }
    return { state, playedChars: this.estimatePlayedChars(item) }
  }

  /**
   * Character estimate for interrupted speech, derived from how much of the
   * synthesized audio the client reported as played. Null when we have nothing
   * to measure, rather than an invented number.
   */
  private estimatePlayedChars(item: SpeechFloorItem): number | null {
    const measured = item.playedFraction
    if (measured === null) return null
    const partChars = item.parts.slice(0, item.partIndex + 1).join(' ').length
    return Math.max(0, Math.min(item.intent.text.length, Math.round(partChars * measured)))
  }

  private finish(item: SpeechFloorItem, result: SpeechResult, detail?: string): void {
    if (item.settled) return
    item.settled = true
    item.settle(result)
    try {
      if (result.state === 'played') this.options.hooks.complete(item, result)
      else this.options.hooks.drop(item, result, detail ?? result.state)
    } catch {
      // UI bookkeeping must never break the floor.
    }
  }

  private safeHalt(item: SpeechFloorItem, generationId: string, reason: HaltReason): void {
    try {
      this.options.hooks.haltPart(item, generationId, reason)
    } catch {
      // ignore
    }
  }

  private completePart(item: SpeechFloorItem): void {
    if (this.current !== item) return
    item.partsPlayed += 1
    if (!item.audible) {
      // Nothing was heard, so nothing is claimed: a drained buffer without a
      // single audible frame is a failure, not a played sentence.
      this.current = null
      this.finish(item, this.resultFor(item, 'error'))
      this.pump()
      return
    }
    if (item.partIndex + 1 < item.parts.length) {
      item.partIndex += 1
      this.startPart(item)
      return
    }
    this.current = null
    this.finish(item, this.resultFor(item, 'played'))
    this.pump()
  }

  private startPart(item: SpeechFloorItem, reuseGenerationId = false): void {
    const generationId =
      reuseGenerationId && item.generationId ? item.generationId : this.options.nextGenerationId()
    item.generationId = generationId
    item.synthesisEnded = false
    item.drained = false
    item.audible = false
    item.playedFraction = null
    try {
      this.options.hooks.beginPart(item, generationId, item.parts[item.partIndex] ?? '')
    } catch {
      this.current = null
      this.finish(item, this.resultFor(item, 'error'))
    }
  }

  private pump(): void {
    if (this.current || this.deafened || this.activeRoomId === null) return
    if (this.queue.length === 0) {
      this.emitQueue()
      return
    }
    this.pruneStale()
    if (this.humanSpeaking) {
      this.emitQueue()
      return
    }
    const item = this.pickNext()
    if (!item) {
      this.emitQueue()
      return
    }
    this.queue = this.queue.filter((queued) => queued !== item)
    this.current = item
    this.emitQueue()
    this.startPart(item, true)
  }

  private pruneStale(): void {
    const now = this.options.now()
    const expired = this.queue.filter(
      (item) =>
        (item.intent.expiresAt !== undefined && item.intent.expiresAt <= now) ||
        now - item.enqueuedAt > this.options.staleAfterMs
    )
    if (expired.length === 0) return
    this.queue = this.queue.filter((item) => !expired.includes(item))
    for (const item of expired) {
      this.finish(item, this.resultFor(item, 'unheard'), 'stale')
    }
  }

  private trimQueue(): void {
    while (this.queue.length > this.options.maxQueued) {
      let worst = this.queue[0]
      for (const item of this.queue) {
        if (this.effectivePriority(item) < this.effectivePriority(worst)) worst = item
      }
      this.queue = this.queue.filter((item) => item !== worst)
      this.finish(worst, this.resultFor(worst, 'unheard'), 'queueFull')
    }
  }

  private pickNext(): SpeechFloorItem | null {
    let best: SpeechFloorItem | null = null
    for (const item of this.queue) {
      if (!best) {
        best = item
        continue
      }
      const score = this.effectivePriority(item)
      const bestScore = this.effectivePriority(best)
      if (score > bestScore) best = item
      else if (score === bestScore && item.enqueuedAt < best.enqueuedAt) best = item
      else if (score === bestScore && item.enqueuedAt === best.enqueuedAt && item.seq < best.seq) best = item
    }
    return best
  }

  private effectivePriority(item: SpeechFloorItem): number {
    const base = SPEECH_PRIORITY[item.intent.reason] ?? 0
    const waited = Math.max(0, this.options.now() - item.enqueuedAt)
    const bonus = Math.floor(waited / this.options.agingStepMs) * 5
    return base + Math.min(this.options.agingBonusCap, bonus)
  }

  private dropAll(state: SpeechOutcome, detail: string): void {
    if (this.queue.length === 0) {
      this.emitQueue()
      return
    }
    const dropped = this.queue
    this.queue = []
    for (const item of dropped) {
      this.finish(item, this.resultFor(item, state), detail)
    }
    this.emitQueue()
  }

  private emitQueue(): void {
    try {
      this.options.hooks.queueChanged(this.queuedAgentIds())
    } catch {
      // ignore
    }
  }
}
