export type VoiceInfo = {
  id: string;
  name: string;
  label: string;
};

export type SttInfo = {
  engine: "faster-whisper";
  model: string;
  device: string;
  computeType: string;
};

export type TimingSnapshot = {
  interruptionMs: number | null;
  finalTranscriptMs: number | null;
  firstAudibleMs: number | null;
};

export type ClientMessage =
  | { type: "mic.start" }
  | { type: "mic.stop" }
  | { type: "speak"; text: string; voiceId: string }
  | { type: "stopPlayback" };

export type ServerMessage =
  | { type: "hello"; status: "loading" | "ready" | "error"; detail: string; stt?: SttInfo }
  | { type: "level"; rms: number }
  | { type: "vad"; speaking: boolean; probability: number }
  | {
      type: "transcript";
      utteranceId: string;
      text: string;
      isFinal: boolean;
    }
  | {
      type: "playback";
      state: "starting" | "audible" | "stopped" | "interrupted" | "ended";
      generationId: number;
    }
  | { type: "timing"; timing: TimingSnapshot }
  | { type: "voices"; voices: VoiceInfo[] }
  | { type: "error"; message: string; fatal?: boolean };

export const SAMPLE_RATE_CAPTURE = 16000;
export const SAMPLE_RATE_TTS = 24000;
export const VAD_FRAME_SAMPLES = 512;
export const PARTIAL_INTERVAL_MS = 900;
export const MIN_PARTIAL_SAMPLES = 9600;
export const MIN_FINAL_SAMPLES = 4800;
export const PREROLL_FRAMES = 10;
export const MAX_UTTERANCE_SAMPLES = 16000 * 25;
