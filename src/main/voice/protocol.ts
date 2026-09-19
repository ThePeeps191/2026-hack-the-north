// Line protocol between the Electron main process (`src/main/voice/**`) and the
// standalone voice helper (`src/main/voice-helper.ts`, run under system Node).
//
// Ported and extended from tools/voice-lab/src/shared/protocol.ts, which spoke a
// WebSocket protocol to the lab UI. The lab's message kinds map onto this one:
//   lab `mic.start` / `mic.stop`  -> here the main process owns session state and
//                                   only sends `vad.reset` / `vad.frame`
//   lab `speak`                   -> `tts.speak`
//   lab `stopPlayback`            -> `tts.cancel`
//   lab binary audio frames       -> `tts.chunk` (base64 PCM on stdout)
//
// Every message is a single line of JSON. Audio is base64 inside that JSON so a
// frame can never be split or reordered by the pipe. No secret ever appears in a
// helper -> main message, and helper log lines are redacted before they are
// reported.
//
// This file is deliberately free of class parameter properties and enums so that
// Node's `--experimental-strip-types` can load it directly in unit tests.

export const HELPER_PROTOCOL_VERSION = 1

/** ElevenLabs voice shaping, taken from `Agent.voice` in shared/types.ts. */
export interface HelperVoiceSettings {
  voiceId: string
  speed: number
  stability: number
  similarityBoost: number
}

/** Everything the helper needs. Passed once, on `init`, from the main process. */
export interface HelperInitConfig {
  protocol: number
  /** Repo root in development, resources dir in a packaged build. */
  appRoot: string
  pythonBin: string
  workerScript: string
  sileroModelPath: string
  whisperModel: string
  whisperDevice: string
  whisperComputeType: string
  whisperCpuThreads: string
  /** Empty string means "no ElevenLabs key": synthesis is unavailable, not faked. */
  elevenLabsApiKey: string
  elevenLabsModel: string
  vadSampleRate: number
  /** Local model file for STT is managed by the python worker, not here. */
  saveRawAudio: boolean
}

export type HelperCapState = 'ready' | 'starting' | 'unavailable' | 'error' | 'disabled'

export interface HelperCap {
  state: HelperCapState
  detail: string
  fix: string | null
}

export interface HelperCaps {
  vad: HelperCap
  stt: HelperCap
  tts: HelperCap
}

export function startingCaps(): HelperCaps {
  return {
    vad: { state: 'starting', detail: 'Loading local Silero VAD', fix: null },
    stt: { state: 'starting', detail: 'Starting local faster-whisper', fix: null },
    tts: { state: 'starting', detail: 'Waiting for the voice helper', fix: null }
  }
}

/* ------------------------------------------------------------------ *
 * main -> helper
 * ------------------------------------------------------------------ */

export type HelperRequest =
  | { t: 'init'; id: number; config: HelperInitConfig }
  | { t: 'shutdown'; id: number }
  | { t: 'vad.reset'; id: number }
  /** One 512-sample frame at 16 kHz, float32, base64. */
  | { t: 'vad.frame'; id: number; pcm: string }
  | {
      t: 'stt.transcribe'
      id: number
      utteranceId: string
      pcm: string
      isFinal: boolean
      initialPrompt?: string
    }
  | {
      t: 'tts.speak'
      id: number
      generationId: string
      text: string
      voice: HelperVoiceSettings
    }
  | { t: 'tts.cancel'; id: number; generationId: string; reason: string }

/* ------------------------------------------------------------------ *
 * helper -> main
 * ------------------------------------------------------------------ */

export type HelperEvent =
  | { t: 'ready'; protocol: number; pid: number; node: string }
  | { t: 'caps'; caps: HelperCaps }
  | { t: 'ack'; id: number }
  | { t: 'vad.prob'; id: number; p: number }
  | { t: 'stt.text'; id: number; text: string }
  | { t: 'tts.chunk'; generationId: string; seq: number; pcm: string }
  | { t: 'tts.ended'; id: number; generationId: string; chars: number; bytes: number }
  | { t: 'tts.cancelled'; id: number; generationId: string }
  | { t: 'error'; id: number; code: string; message: string; fix?: string }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  | { t: 'fatal'; message: string; fix?: string }

export function isHelperEvent(value: unknown): value is HelperEvent {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.t === 'string'
}

/** Parses one line of helper output. Never throws on malformed input. */
export function parseHelperLine(line: string): HelperEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isHelperEvent(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function encodeHelperRequest(request: HelperRequest): string {
  return `${JSON.stringify(request)}\n`
}
