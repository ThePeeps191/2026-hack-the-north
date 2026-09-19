import type { WebSocket } from "ws";
import {
  MAX_UTTERANCE_SAMPLES,
  MIN_FINAL_SAMPLES,
  MIN_PARTIAL_SAMPLES,
  PARTIAL_INTERVAL_MS,
  PREROLL_FRAMES,
  SAMPLE_RATE_CAPTURE,
  VAD_FRAME_SAMPLES,
  type ClientMessage,
  type ServerMessage,
  type SttInfo,
  type VoiceInfo
} from "../shared/protocol.ts";
import { concatFloat32, encodeAudioFrame, pcm16ToFloat32, rmsLevel } from "../modules/audio-util.ts";
import { InterruptPolicy } from "../modules/interrupt-policy.ts";
import { TimingTracker } from "../modules/timing.ts";
import { TranscribeQueue } from "../modules/transcribe-queue.ts";
import { SileroVadEngine } from "../modules/vad-engine.ts";
import { GenerationGuard } from "../modules/generation-guard.ts";
import { ElevenLabsSynthesizer } from "../modules/synthesizer.ts";
import type { FasterWhisperProcess } from "./whisper-process.ts";

export class VoiceSession {
  private closed = false;
  private micOn = false;
  private lastLevelSent = 0;
  private utteranceSeq = 0;
  private currentUtteranceId: string | null = null;
  private utteranceChunks: Float32Array[] = [];
  private utteranceSamples = 0;
  private preroll: Float32Array[] = [];
  private lastPartialAt = 0;
  private speakAbort: AbortController | null = null;
  private readonly guard = new GenerationGuard();
  private readonly timing = new TimingTracker();
  private readonly interrupt = new InterruptPolicy({
    minSpeechMs: 180,
    speechThreshold: 0.5,
    playbackSpeechThreshold: 0.65,
    frameMs: Math.round((VAD_FRAME_SAMPLES / SAMPLE_RATE_CAPTURE) * 1000)
  });
  private readonly queue: TranscribeQueue;
  private unbindVad: Array<() => void> = [];

  constructor(
    private readonly socket: WebSocket,
    private readonly deps: {
      vad: SileroVadEngine;
      transcriber: FasterWhisperProcess;
      synthesizer: ElevenLabsSynthesizer;
      voices: VoiceInfo[];
      stt: SttInfo;
    }
  ) {
    this.queue = new TranscribeQueue(async (job) => this.deps.transcriber.transcribe(job.pcm, job.isFinal));
    this.unbindVad.push(
      this.deps.vad.on("speech-start", () => {
        void this.onSpeechStart();
      })
    );
    this.unbindVad.push(
      this.deps.vad.on("speech-end", () => {
        void this.onSpeechEnd();
      })
    );
  }

  start(): void {
    this.send({
      type: "hello",
      status: "ready",
      detail: `Local ${this.deps.stt.engine} ${this.deps.stt.model} (${this.deps.stt.device}/${this.deps.stt.computeType})`,
      stt: this.deps.stt
    });
    this.send({ type: "voices", voices: this.deps.voices });
  }

  async handleMessage(raw: Buffer | string, isBinary: boolean): Promise<void> {
    if (this.closed) return;
    if (isBinary) {
      await this.handleAudio(raw instanceof Buffer ? raw : Buffer.from(raw));
      return;
    }
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    let message: ClientMessage;
    try {
      message = JSON.parse(text) as ClientMessage;
    } catch {
      this.send({ type: "error", message: "Malformed control message" });
      return;
    }
    await this.handleControl(message);
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.micOn = false;
    this.stopPlayback("stopped");
    for (const unbind of this.unbindVad) unbind();
    this.unbindVad = [];
    this.deps.vad.reset();
  }

  private async handleControl(message: ClientMessage): Promise<void> {
    if (message.type === "mic.start") {
      this.micOn = true;
      this.deps.vad.reset();
      this.preroll = [];
      return;
    }
    if (message.type === "mic.stop") {
      this.micOn = false;
      if (this.currentUtteranceId) await this.onSpeechEnd();
      this.deps.vad.reset();
      return;
    }
    if (message.type === "stopPlayback") {
      this.stopPlayback("stopped");
      this.send({ type: "timing", timing: this.timing.snapshot() });
      return;
    }
    if (message.type === "speak") {
      await this.speak(message.text, message.voiceId);
    }
  }

  private async handleAudio(buffer: Buffer): Promise<void> {
    if (!this.micOn) return;
    const pcm = pcm16ToFloat32(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
    const now = Date.now();
    if (now - this.lastLevelSent > 50) {
      this.lastLevelSent = now;
      this.send({ type: "level", rms: rmsLevel(pcm) });
    }

    const probability = await this.deps.vad.push(pcm);
    if (probability != null) {
      this.send({ type: "vad", speaking: this.deps.vad.speaking, probability });
      if (
        this.interrupt.observe({
          probability,
          playbackActive: this.guard.isPlaying()
        })
      ) {
        this.stopPlayback("interrupted");
        this.send({ type: "timing", timing: this.timing.snapshot() });
      }
    }

    const frame = pcm;
    if (this.currentUtteranceId) {
      this.utteranceChunks.push(frame);
      this.utteranceSamples += frame.length;
      if (this.utteranceSamples > MAX_UTTERANCE_SAMPLES) {
        await this.onSpeechEnd();
        return;
      }
      if (
        now - this.lastPartialAt >= PARTIAL_INTERVAL_MS &&
        this.utteranceSamples >= MIN_PARTIAL_SAMPLES
      ) {
        this.lastPartialAt = now;
        this.enqueueTranscript(this.currentUtteranceId, concatFloat32(this.utteranceChunks), false);
      }
    } else {
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
    }
  }

  private async onSpeechStart(): Promise<void> {
    if (!this.micOn) return;
    this.timing.markVadSpeechStart();
    this.currentUtteranceId = `utt-${++this.utteranceSeq}`;
    this.utteranceChunks = [...this.preroll];
    this.utteranceSamples = this.utteranceChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    this.preroll = [];
    this.lastPartialAt = 0;
    if (this.guard.isPlaying()) {
      this.stopPlayback("interrupted");
      this.send({ type: "timing", timing: this.timing.snapshot() });
    }
  }

  private async onSpeechEnd(): Promise<void> {
    const utteranceId = this.currentUtteranceId;
    const chunks = this.utteranceChunks;
    this.currentUtteranceId = null;
    this.utteranceChunks = [];
    this.utteranceSamples = 0;
    this.preroll = [];
    if (!utteranceId) return;
    this.timing.markSpeechEnd();
    const pcm = concatFloat32(chunks);
    if (pcm.length < MIN_FINAL_SAMPLES) return;
    this.enqueueTranscript(utteranceId, pcm, true);
  }

  private enqueueTranscript(utteranceId: string, pcm: Float32Array, isFinal: boolean): void {
    void this.queue
      .enqueue({ utteranceId, pcm, isFinal })
      .then((text) => {
        if (this.closed || text == null || !text.trim()) return;
        this.send({
          type: "transcript",
          utteranceId,
          text: text.trim(),
          isFinal
        });
        if (isFinal) {
          this.timing.markFinalTranscript();
          this.send({ type: "timing", timing: this.timing.snapshot() });
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.send({ type: "error", message: `Transcription failed: ${message}` });
      });
  }

  private async speak(text: string, voiceId: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      this.send({ type: "error", message: "Type some text for the agent to speak." });
      return;
    }
    this.stopPlayback("stopped");
    const generationId = this.guard.begin();
    this.timing.markSpeakRequested();
    this.speakAbort = new AbortController();
    this.send({ type: "playback", state: "starting", generationId });
    let first = true;
    try {
      await this.deps.synthesizer.speak({
        text: trimmed,
        voiceId,
        generationId,
        signal: this.speakAbort.signal,
        onChunk: (chunk, id) => {
          if (!this.guard.accepts(id)) return;
          if (first) {
            first = false;
            this.send({ type: "playback", state: "audible", generationId: id });
          }
          if (this.socket.readyState === 1) {
            this.socket.send(encodeAudioFrame(id, chunk), { binary: true });
          }
        }
      });
      if (this.guard.accepts(generationId)) {
        this.guard.stop();
        this.send({ type: "playback", state: "ended", generationId });
      }
    } catch (error) {
      if (this.speakAbort?.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.send({ type: "error", message });
      this.stopPlayback("stopped");
    }
  }

  private stopPlayback(reason: "stopped" | "interrupted"): void {
    const generationId = this.guard.current();
    const wasPlaying = this.guard.isPlaying();
    this.speakAbort?.abort();
    this.speakAbort = null;
    this.guard.stop();
    this.interrupt.reset();
    if (wasPlaying) {
      this.timing.markPlaybackStopped(reason);
      this.send({ type: "playback", state: reason, generationId });
    }
  }

  private send(message: ServerMessage): void {
    if (this.socket.readyState !== 1) return;
    this.socket.send(JSON.stringify(message));
  }
}
