// Voice transport contract between the renderer (capture + playback) and the
// main process (VAD, local transcription, ElevenLabs synthesis, floor control).
//
// Microphone audio is captured in the renderer and processed locally in the main
// process. It is never sent to a cloud speech-to-text service.

export const CAPTURE_SAMPLE_RATE = 16000
export const PLAYBACK_SAMPLE_RATE = 24000
/** Silero frame size at 16 kHz (32 ms). */
export const VAD_FRAME_SAMPLES = 512
/** How often a provisional transcript is recomputed while the human speaks. */
export const PARTIAL_INTERVAL_MS = 900
export const MIN_PARTIAL_SAMPLES = 9600
export const MIN_FINAL_SAMPLES = 4800
/** Frames of audio kept before speech onset so the first word is not clipped. */
export const PREROLL_FRAMES = 12
/**
 * Continuous speech longer than this is cut into a segment and transcription
 * continues on a fresh segment. Capture is never dropped.
 */
export const MAX_SEGMENT_SAMPLES = CAPTURE_SAMPLE_RATE * 22

/** Renderer reports of what the audio hardware actually did. */
export type PlaybackClientEvent =
  /** First PCM frame for this generation was scheduled on the output device. */
  | { type: 'playback.firstAudible'; generationId: string; at: number }
  /** Output queue drained AND synthesis had already ended. */
  | { type: 'playback.drained'; generationId: string; playedMs: number }
  /** Playback was halted locally (barge-in, deafen, stop). */
  | { type: 'playback.halted'; generationId: string; playedMs: number; reason: HaltReason }
  | { type: 'playback.error'; generationId: string; message: string }

export type HaltReason = 'bargeIn' | 'stopSpeaking' | 'deafen' | 'roomChange' | 'stale' | 'leave'

/** Main-process instructions to the renderer's audio sink. */
export type PlaybackServerEvent =
  | {
      type: 'speech.begin'
      generationId: string
      agentId: string
      roomId: string
      messageId: string | null
      /** Full text, so captions can render ahead of audio if useful. */
      text: string
      sampleRate: number
    }
  /** Synthesis finished cleanly. Playback completes when the buffer also drains. */
  | { type: 'speech.synthesisEnded'; generationId: string; totalChars: number }
  | { type: 'speech.cancel'; generationId: string; reason: HaltReason }
  | { type: 'speech.error'; generationId: string; message: string; fix?: string }

export interface AudioChunkMessage {
  generationId: string
  /** Int16 little-endian PCM at PLAYBACK_SAMPLE_RATE. */
  pcm: ArrayBuffer
  /** Monotonic per generation, so a late chunk can be recognised and dropped. */
  seq: number
}

export interface MicFrameMessage {
  /** Int16 little-endian PCM at CAPTURE_SAMPLE_RATE, mono. */
  pcm: ArrayBuffer
  /** Renderer clock at capture time, for honest endpointing measurements. */
  capturedAt: number
}

export interface AudioDeviceInfo {
  deviceId: string
  label: string
  kind: 'audioinput' | 'audiooutput'
}

/** Why a piece of speech was requested. Drives floor priority. */
export type SpeechReason =
  /** Direct answer to something the human just asked. Highest priority. */
  | 'answer'
  /** A clarifying question the agent needs answered to continue. */
  | 'clarify'
  /** Acknowledging an assignment. Short, and only once. */
  | 'ack'
  /** Reporting a verified result. */
  | 'result'
  /** Explaining something on request. */
  | 'explain'
  /** Talking to another agent, audibly. */
  | 'peer'
  /** Volunteered status. Lowest priority, dropped first when stale. */
  | 'status'

export const SPEECH_PRIORITY: Record<SpeechReason, number> = {
  answer: 100,
  clarify: 80,
  result: 60,
  explain: 55,
  ack: 40,
  peer: 30,
  status: 10
}
