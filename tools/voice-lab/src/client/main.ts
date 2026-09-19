import { PlaybackSession, shouldHaltPlaybackSink } from "../modules/playback-session.ts";
import { TimingTracker } from "../modules/timing.ts";
import { TranscriptLog } from "../modules/transcript-log.ts";
import {
  Pcm16Assembler,
  decodeAudioFrame,
  float32ToPcm16,
  pcm16ToFloat32,
  resampleLinear
} from "../modules/audio-util.ts";
import type { ServerMessage, TimingSnapshot, VoiceInfo } from "../shared/protocol.ts";
import { SAMPLE_RATE_CAPTURE, SAMPLE_RATE_TTS } from "../shared/protocol.ts";

const statusEl = document.querySelector("#status") as HTMLParagraphElement;
const sttEl = document.querySelector("#stt-info") as HTMLParagraphElement;
const transcriptEl = document.querySelector("#transcript") as HTMLDivElement;
const levelEl = document.querySelector("#level") as HTMLDivElement;
const vadPill = document.querySelector("#vad-pill") as HTMLSpanElement;
const micStart = document.querySelector("#mic-start") as HTMLButtonElement;
const micStop = document.querySelector("#mic-stop") as HTMLButtonElement;
const speakBtn = document.querySelector("#speak") as HTMLButtonElement;
const stopBtn = document.querySelector("#stop") as HTMLButtonElement;
const speakText = document.querySelector("#speak-text") as HTMLTextAreaElement;
const voiceSelect = document.querySelector("#voice") as HTMLSelectElement;
const tInterrupt = document.querySelector("#t-interrupt") as HTMLElement;
const tFinal = document.querySelector("#t-final") as HTMLElement;
const tAudible = document.querySelector("#t-audible") as HTMLElement;

const log = new TranscriptLog();
const timing = new TimingTracker();
let socket: WebSocket | null = null;
let capture: { stream: MediaStream; node: AudioWorkletNode } | null = null;
let voices: VoiceInfo[] = [];

const audioContext = new AudioContext();
const sources: AudioBufferSourceNode[] = [];
const pcmAssembler = new Pcm16Assembler();
let nextPlayTime = 0;
let playGeneration = 0;
let activeSources = 0;

function stopSink(): void {
  for (const source of sources) {
    try {
      source.stop();
    } catch {
      // already stopped
    }
  }
  sources.length = 0;
  nextPlayTime = 0;
  activeSources = 0;
  pcmAssembler.reset();
}

function noteSourceEnded(generationId: number): void {
  if (playGeneration !== generationId) return;
  activeSources = Math.max(0, activeSources - 1);
  if (activeSources > 0 || !playback.isActive()) return;
  stopBtn.disabled = true;
  socket?.send(JSON.stringify({ type: "playback.complete", generationId }));
}

const playback = new PlaybackSession({
  now: () => performance.now(),
  stopSink,
  play: (pcm) => {
    const sampleRate = audioContext.sampleRate || SAMPLE_RATE_TTS;
    const samples = resampleLinear(pcm, SAMPLE_RATE_TTS, sampleRate);
    const buffer = audioContext.createBuffer(1, Math.max(1, samples.length), sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    const now = audioContext.currentTime;
    if (nextPlayTime < now + 0.03) nextPlayTime = now + 0.03;
    const generationId = playback.current();
    source.onended = () => noteSourceEnded(generationId);
    source.start(nextPlayTime);
    nextPlayTime += buffer.duration;
    sources.push(source);
    activeSources += 1;
  }
});

function setStatus(state: "loading" | "ready" | "error", text: string): void {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
}

function renderTranscript(): void {
  const lines = log.displayLines();
  if (lines.length === 0) {
    transcriptEl.innerHTML = `<p class="muted">Listening. Provisional text stays italic until an utterance finalizes.</p>`;
    return;
  }
  transcriptEl.innerHTML = lines
    .map(
      (line) =>
        `<p class="${line.kind}">${escapeHtml(line.text)}</p>`
    )
    .join("");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatMs(value: number | null): string {
  return value == null ? "—" : `${value} ms`;
}

function renderTiming(snapshot: TimingSnapshot): void {
  tInterrupt.textContent = formatMs(snapshot.interruptionMs);
  tFinal.textContent = formatMs(snapshot.finalTranscriptMs);
  tAudible.textContent = formatMs(snapshot.firstAudibleMs);
}

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

function connect(): void {
  setStatus("loading", "Connecting to local voice helper…");
  socket = new WebSocket(wsUrl());
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => {
    setStatus("loading", "Connected. Waiting for local models…");
  });
  socket.addEventListener("close", () => {
    setStatus("error", "Disconnected from the local helper.");
    micStart.disabled = true;
    speakBtn.disabled = true;
  });
  socket.addEventListener("error", () => {
    setStatus("error", "WebSocket error. Is the voice-lab server running?");
  });
  socket.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) {
      handleAudio(event.data);
      return;
    }
    const message = JSON.parse(String(event.data)) as ServerMessage;
    handleMessage(message);
  });
}

function handleAudio(buffer: ArrayBuffer): void {
  const { generationId, pcm16 } = decodeAudioFrame(new Uint8Array(buffer));
  const aligned = pcmAssembler.push(pcm16);
  if (aligned.byteLength < 2) return;
  const pcm = pcm16ToFloat32(aligned);
  const result = playback.push(generationId, pcm);
  if (result.firstAudible) {
    timing.markFirstAudible();
    renderTiming(timing.snapshot());
    stopBtn.disabled = false;
  }
}

function handleMessage(message: ServerMessage): void {
  if (message.type === "hello") {
    setStatus(message.status, message.detail);
    if (message.stt) {
      sttEl.textContent = `${message.stt.engine} · ${message.stt.model} · ${message.stt.device}/${message.stt.computeType}`;
    }
    micStart.disabled = message.status !== "ready";
    speakBtn.disabled = message.status !== "ready";
    return;
  }
  if (message.type === "error") {
    if (message.fatal) setStatus("error", message.message);
    else statusEl.textContent = message.message;
    return;
  }
  if (message.type === "voices") {
    voices = message.voices;
    voiceSelect.innerHTML = voices
      .map((voice) => `<option value="${voice.id}">${escapeHtml(voice.label)} — ${escapeHtml(voice.name)}</option>`)
      .join("");
    return;
  }
  if (message.type === "level") {
    const pct = Math.min(100, Math.round(message.rms * 280));
    levelEl.style.width = `${pct}%`;
    return;
  }
  if (message.type === "vad") {
    vadPill.textContent = message.speaking ? "speech" : "quiet";
    vadPill.classList.toggle("hot", message.speaking);
    return;
  }
  if (message.type === "transcript") {
    if (message.isFinal) log.applyFinal(message.utteranceId, message.text);
    else log.applyPartial(message.utteranceId, message.text);
    renderTranscript();
    return;
  }
  if (message.type === "playback") {
    if (message.state === "starting") {
      void audioContext.resume();
      pcmAssembler.reset();
      playGeneration = message.generationId;
      activeSources = 0;
      playback.attach(message.generationId);
      stopBtn.disabled = false;
    }
    if (shouldHaltPlaybackSink(message.state)) {
      playback.stop();
      stopBtn.disabled = true;
    }
    return;
  }
  if (message.type === "timing") {
    const current = timing.snapshot();
    renderTiming({
      interruptionMs: message.timing.interruptionMs ?? current.interruptionMs,
      finalTranscriptMs: message.timing.finalTranscriptMs ?? current.finalTranscriptMs,
      firstAudibleMs: current.firstAudibleMs ?? message.timing.firstAudibleMs
    });
  }
}

async function startMic(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
    await audioContext.resume();
    await audioContext.audioWorklet.addModule("/capture-processor.js");
    const source = audioContext.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(audioContext, "capture-processor");
    const mute = audioContext.createGain();
    mute.gain.value = 0;
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const resampled = resampleLinear(event.data, audioContext.sampleRate, SAMPLE_RATE_CAPTURE);
      socket.send(float32ToPcm16(resampled));
    };
    source.connect(node);
    node.connect(mute);
    mute.connect(audioContext.destination);
    capture = { stream, node };
    socket?.send(JSON.stringify({ type: "mic.start" }));
    micStart.disabled = true;
    micStop.disabled = false;
    setStatus("ready", "Microphone on. Audio stays on this machine.");
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : String(error));
  }
}

function stopMic(): void {
  socket?.send(JSON.stringify({ type: "mic.stop" }));
  capture?.stream.getTracks().forEach((track) => track.stop());
  capture?.node.disconnect();
  capture = null;
  micStart.disabled = false;
  micStop.disabled = true;
  levelEl.style.width = "0%";
}

function speak(): void {
  const text = speakText.value.trim();
  const voiceId = voiceSelect.value;
  if (!text) {
    setStatus("error", "Type some text for the agent to speak.");
    return;
  }
  timing.markSpeakRequested();
  renderTiming(timing.snapshot());
  socket?.send(JSON.stringify({ type: "speak", text, voiceId }));
  stopBtn.disabled = false;
}

function stopPlayback(): void {
  playback.stop();
  socket?.send(JSON.stringify({ type: "stopPlayback" }));
  stopBtn.disabled = true;
}

micStart.addEventListener("click", () => void startMic());
micStop.addEventListener("click", () => stopMic());
speakBtn.addEventListener("click", () => speak());
stopBtn.addEventListener("click", () => stopPlayback());

speakText.value =
  "Maya here. I can open App.tsx, check the TypeScript types, and leave a note for Alex and Sam.";

connect();
