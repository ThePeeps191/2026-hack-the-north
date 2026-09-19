/**
 * Speech integration.
 *
 * The written message and the spoken message are deliberately different
 * strings: the written one carries files, exit codes and evidence, the spoken
 * one is one or two conversational sentences. Both are derived from the same
 * real turn, so the spoken form never introduces a claim the written form does
 * not contain.
 *
 * Timing samples emitted by the voice host tell the truth about playback; the
 * runtime never marks speech as played on its own.
 */

import type { Message, MessageKind, SpokenInfo, SpokenState } from '../../shared/types.ts'
import type { SpeechReason } from '../../shared/voice.ts'
import type { HuddleBus, SpeechHandle, SpeechIntent, VoiceHost } from '../contracts.ts'
import { redact } from '../config/secrets.ts'
import { HuddleError } from '../huddle-error.ts'

/** Longest spoken form we will queue; keeps one turn short on a call. */
export const MAX_SPOKEN_CHARS = 280

/** Said when the written body carries no speakable prose (code or evidence only). */
export const DETAIL_IN_TRANSCRIPT = 'The details are in the transcript.'

/** Strip everything that reads badly out loud. */
function toSpeakableText(written: string): string {
  let text = written.replace(/```[\s\S]*?```/g, ' ')
  text = text.replace(/`([^`]*)`/g, '$1')
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/^\s{0,3}#{1,6}\s*/gm, '')
  text = text.replace(/^\s{0,3}[-*+]\s+/gm, '')
  text = text.replace(/^\s{0,3}\d+[.)]\s+/gm, '')
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/__([^_]+)__/g, '$1')
  text = text.replace(/(^|\s)[*_](\S[^*_]*)[*_]/g, '$1$2')
  text = text.replace(/\|/g, ' ')
  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/\n{2,}/g, '. ')
  text = text.replace(/\n/g, ' ')
  return text.trim()
}

function splitSentences(text: string): string[] {
  const matches = text.match(/[^.!?]+[.!?]*/g)
  if (!matches) return text ? [text] : []
  return matches.map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0)
}

/**
 * Sentences that read like a list of evidence are not read out loud. Two kinds
 * are handled: whole evidence lines ("Files: …", "Command: …", "exit 0") are
 * dropped, and file paths inside otherwise normal sentences are softened, so
 * "I built the panel in src/Vote.tsx." is spoken as "I built the panel in the
 * file.".
 */
const EVIDENCE_LABEL = /(^|\s)(files?|commands?|acceptance|evidence|diff|artifacts?|paths?|checks?|exit code)\s*:/i
const PATH_TOKEN = /\b[\w.@-]*[/\\][\w./\\@-]*/g
const FILE_TOKEN = /\b[\w-]+\.(tsx?|jsx?|mjs|cjs|css|scss|json|jsonl|md|txt|html|yml|yaml|toml|lock|py|sh|ps1)\b/gi

function isEvidenceLine(sentence: string): boolean {
  if (EVIDENCE_LABEL.test(sentence)) return true
  if (/\bexit(ed|s)?\s*[-]?\d/i.test(sentence)) return true
  if (/^\s*(npm|pnpm|yarn|npx|git|node|tsc|python)\b/i.test(sentence)) return true
  return false
}

function softenEvidence(sentence: string): string {
  return sentence.replace(PATH_TOKEN, 'the file').replace(FILE_TOKEN, 'that file').replace(/\s+/g, ' ').trim()
}

/**
 * Spoken form: the leading one or two spoken sentences, without code, paths or
 * evidence lists. Fragments are dropped rather than read out.
 */
export function spokenForm(written: string, maxChars: number = MAX_SPOKEN_CHARS): string {
  if (!written.trim()) return ''
  const speakable = toSpeakableText(written)
  if (!speakable) {
    // The whole body was code or a fence. Never read code out loud, and never
    // answer with silence either: say what is actually true about the turn.
    return DETAIL_IN_TRANSCRIPT
  }

  // Soften paths and file names *before* splitting into sentences: the
  // sentence splitter treats the dot in "README.md" as a full stop, so doing it
  // afterwards reads the name out as "README. md".
  const sentences = splitSentences(softenEvidence(speakable))
  const chosen: string[] = []
  for (const raw of sentences) {
    if (chosen.length >= 2) break
    if (isEvidenceLine(raw)) continue
    const sentence = raw.replace(/\s+/g, ' ').trim()
    const words = sentence.split(/\s+/).filter((word) => word.length > 0)
    // A one- or two-word fragment ("Done.", "Tests pass.") is not worth a
    // sentence of audio on its own.
    if (words.length < 3) continue
    chosen.push(sentence)
  }

  let spoken = chosen.join(' ').trim()
  if (!spoken) {
    // Everything speakable was an evidence list. Say something true and short
    // instead of reading paths and exit codes out loud.
    return sentences.length > 0 || written.includes('```') ? DETAIL_IN_TRANSCRIPT : ''
  }
  if (spoken.length > maxChars) {
    const clipped = spoken.slice(0, maxChars)
    const lastStop = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('! '), clipped.lastIndexOf('? '))
    spoken = lastStop > 40 ? clipped.slice(0, lastStop + 1) : `${clipped.trimEnd()}...`
  }
  return spoken
}

export interface SpokenSplit {
  written: string
  spoken: string
}

/** The written/spoken pair for one agent turn. */
export function splitSpoken(written: string, maxChars: number = MAX_SPOKEN_CHARS): SpokenSplit {
  return { written, spoken: spokenForm(written, maxChars) }
}

export function speechReasonFor(kind: MessageKind, fallback: SpeechReason = 'status'): SpeechReason {
  switch (kind) {
    case 'answer':
      return 'answer'
    case 'question':
      return 'clarify'
    case 'result':
      return 'result'
    case 'handoff':
      return 'peer'
    case 'chat':
      return 'explain'
    default:
      return fallback
  }
}

export interface SpeakRequest {
  roomId: string
  agentId: string
  /** The written message body; the spoken form is derived from it. */
  written: string
  reason: SpeechReason
  decisionRevision: number
  messageId: string | null
  /** Optional deadline after which the line is no longer worth saying. */
  expiresAt?: number
  /** Override the derived spoken form (used for short acknowledgements). */
  spokenOverride?: string
}

function toSpokenState(state: 'played' | 'interrupted' | 'cancelled' | 'unheard' | 'error'): SpokenState {
  return state === 'error' ? 'unheard' : state
}

/**
 * Request speech for a message the room has already recorded.
 *
 * Waiting on `handle.done` is how the message's `spoken` field becomes truth
 * about playback rather than an optimistic guess.
 */
export function requestSpeech(voice: VoiceHost, bus: HuddleBus, request: SpeakRequest): SpeechHandle | null {
  const text = request.spokenOverride?.trim() || spokenForm(request.written)
  if (!text) return null

  const intent: SpeechIntent = {
    id: bus.newId(),
    roomId: request.roomId,
    agentId: request.agentId,
    text: redact(text),
    reason: request.reason,
    decisionRevision: request.decisionRevision,
    messageId: request.messageId
  }
  if (request.expiresAt !== undefined) intent.expiresAt = request.expiresAt

  let handle: SpeechHandle
  try {
    handle = voice.speak(intent)
  } catch (error) {
    bus.notice(
      request.roomId,
      'warn',
      error instanceof HuddleError
        ? `${error.message} The agent's reply is in the transcript.`
        : 'Speech could not be requested; the written reply is still in the transcript.',
      error instanceof HuddleError && error.fix ? error.fix : 'Check the ElevenLabs key and voice in Settings.'
    )
    return null
  }

  if (request.messageId) {
    bus.updateMessage(request.messageId, {
      spoken: { generationId: handle.generationId, state: 'queued', playedChars: null }
    })
  }

  void handle.done
    .then((outcome) => {
      if (!request.messageId) return
      const spoken: SpokenInfo = {
        generationId: handle.generationId,
        state: toSpokenState(outcome.state),
        playedChars: outcome.playedChars
      }
      bus.updateMessage(request.messageId, { spoken })
    })
    .catch(() => {
      if (!request.messageId) return
      bus.updateMessage(request.messageId, {
        spoken: { generationId: handle.generationId, state: 'unheard', playedChars: null }
      })
    })

  return handle
}

/**
 * A decision revision landed: queued speech that predates it is no longer worth
 * saying. Work is never cancelled by this.
 */
export function invalidateSpeechBefore(voice: VoiceHost, bus: HuddleBus, roomId: string, revision: number): void {
  try {
    voice.invalidateSpeechBefore(roomId, revision)
  } catch {
    // A voice host that is not running has nothing queued to drop.
  }
  bus.notice(
    roomId,
    'info',
    `Requirement change recorded (revision ${revision}). Queued speech from before it was dropped.`
  )
}

/** True when the message carries audio that is still queued or speaking. */
export function isSpeechPending(message: Message): boolean {
  const state = message.spoken?.state
  return state === 'queued' || state === 'speaking'
}
