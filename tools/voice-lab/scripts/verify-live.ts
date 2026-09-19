// Live voice probe for Huddle.
//
//   node tools/voice-lab/scripts/verify-live.ts
//
// It answers four questions with real output instead of assumptions:
//
//   1. Is the Silero VAD model on disk and does onnxruntime-node load it?
//   2. Does the ElevenLabs key work, and which of the preset voice ids exist?
//   3. Does synthesis actually stream PCM (chunk count, bytes, seconds of audio)?
//   4. Can the local faster-whisper worker transcribe that same audio?
//
// Nothing here needs a microphone. The synthesized speech is round-tripped
// through local VAD and local STT, which is exactly the path a spoken utterance
// takes — minus the capture device.
//
// The key comes from the same resolver the app uses (src/main/config/secrets.ts:
// environment, then .env), so this probe cannot accidentally use a different key
// than Huddle itself.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getSecret } from "../../../src/main/config/secrets.ts";
import { float32ToPcm16, resampleLinear } from "../src/modules/audio-util.ts";
import { SileroVadEngine, loadSileroVadSession } from "../src/modules/vad-engine.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const labRoot = path.resolve(here, "..");
const repoRoot = path.resolve(labRoot, "..", "..");
process.env.HUDDLE_APP_ROOT ??= repoRoot;

const CAPTURE_RATE = 16_000;
const PLAYBACK_RATE = 24_000;
const VAD_FRAME_SAMPLES = 512;

/** The five preset voice ids from src/shared/presets.ts. */
const PRESET_VOICES: Array<{ id: string; name: string; agent: string }> = [
  { id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura", agent: "Maya" },
  { id: "cjVigY5qzO86Huf0OWal", name: "Eric", agent: "Alex" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", agent: "Sam" },
  { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie", agent: "Rio" },
  { id: "SAz9YHcvj6GT2YYXdXww", name: "River", agent: "Nova" }
];

const PROBE_TEXT =
  "Maya here. The build passed, and I pushed the branch for review.";

const results: Array<{ step: string; ok: boolean; detail: string }> = [];

function record(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}: ${detail}`);
}

function ensureDir(target: string): void {
  fs.mkdirSync(target, { recursive: true });
}

/* ------------------------------------------------------------------ *
 * 1. Local VAD model + onnxruntime
 * ------------------------------------------------------------------ */

async function probeVadModel(): Promise<{ session: Awaited<ReturnType<typeof loadSileroVadSession>> | null }> {
  const modelPath = path.join(labRoot, "models", "silero_vad.onnx");
  if (!fs.existsSync(modelPath)) {
    record("silero model", false, `missing at ${modelPath} — run "npm run setup" in tools/voice-lab`);
    return { session: null };
  }
  const bytes = fs.statSync(modelPath).size;
  try {
    const session = await loadSileroVadSession(modelPath);
    record(
      "silero model",
      true,
      `${bytes} bytes, inputs=[${session.inputNames.join(", ")}], outputs=[${session.outputNames.join(", ")}]`
    );
    return { session };
  } catch (error) {
    record("silero model", false, `onnxruntime-node could not load it: ${String(error)}`);
    return { session: null };
  }
}

/* ------------------------------------------------------------------ *
 * 2. ElevenLabs voices
 * ------------------------------------------------------------------ */

async function probeVoices(apiKey: string): Promise<void> {
  const response = await fetch("https://api.elevenlabs.io/v1/voices?page_size=100", {
    headers: { "xi-api-key": apiKey }
  });
  if (!response.ok) {
    record("elevenlabs voices", false, `GET /v1/voices -> ${response.status} ${response.statusText}`);
    return;
  }
  const body = (await response.json()) as { voices?: Array<{ voice_id?: string; name?: string }> };
  const voices = body.voices ?? [];
  const ids = new Set(voices.map((voice) => voice.voice_id ?? ""));
  const valid: string[] = [];
  const missing: string[] = [];
  for (const preset of PRESET_VOICES) {
    if (ids.has(preset.id)) valid.push(`${preset.name} (${preset.agent})`);
    else missing.push(`${preset.name} (${preset.agent}) ${preset.id}`);
  }
  console.log(`       account has ${voices.length} voices: ${voices.slice(0, 12).map((voice) => voice.name).join(", ")}${voices.length > 12 ? ", …" : ""}`);
  record(
    "elevenlabs voices",
    missing.length === 0,
    missing.length === 0
      ? `all 5 preset voice ids are valid: ${valid.join("; ")}`
      : `valid: ${valid.join("; ") || "none"} | MISSING: ${missing.join("; ")}`
  );
}

/* ------------------------------------------------------------------ *
 * 3. Streaming synthesis
 * ------------------------------------------------------------------ */

async function probeSynthesis(apiKey: string): Promise<{ pcm24: Uint8Array | null; chars: number }> {
  const voiceId = PRESET_VOICES[0]?.id ?? "FGY2WhTYpPnrIDTdsKH5";
  const started = Date.now();
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/octet-stream"
      },
      body: JSON.stringify({
        text: PROBE_TEXT,
        model_id: "eleven_flash_v2_5",
        voice_settings: { stability: 0.4, similarity_boost: 0.75, use_speaker_boost: true, speed: 1.05 }
      })
    }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    record("elevenlabs stream", false, `${response.status} ${response.statusText} ${detail.slice(0, 200)}`);
    return { pcm24: null, chars: PROBE_TEXT.length };
  }
  if (!response.body) {
    record("elevenlabs stream", false, "response had no body to stream");
    return { pcm24: null, chars: PROBE_TEXT.length };
  }

  const pieces: Uint8Array[] = [];
  let chunks = 0;
  let firstChunkMs = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    chunks += 1;
    if (chunks === 1) firstChunkMs = Date.now() - started;
    pieces.push(value);
  }

  const total = pieces.reduce((sum, piece) => sum + piece.byteLength, 0);
  const pcm24 = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    pcm24.set(piece, offset);
    offset += piece.byteLength;
  }
  const seconds = total / 2 / PLAYBACK_RATE;
  record(
    "elevenlabs stream",
    chunks > 0 && total > 1_000,
    `${chunks} streaming chunks, ${total} bytes, ${seconds.toFixed(2)}s of 24 kHz PCM, first chunk after ${firstChunkMs} ms`
  );

  const tmp = path.join(labRoot, "tmp");
  ensureDir(tmp);
  fs.writeFileSync(path.join(tmp, "probe-24k.pcm"), pcm24);
  console.log(`       wrote ${path.relative(repoRoot, path.join(tmp, "probe-24k.pcm"))}`);
  return { pcm24, chars: PROBE_TEXT.length };
}

/* ------------------------------------------------------------------ *
 * 4. Local VAD + local transcription of that audio
 * ------------------------------------------------------------------ */

function pcm16ToWav(pcm16: Int16Array, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataBytes = pcm16.byteLength;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.from(pcm16.buffer, pcm16.byteOffset, dataBytes)]);
}

async function probeLocalSpeech(
  pcm24: Uint8Array,
  session: Awaited<ReturnType<typeof loadSileroVadSession>> | null
): Promise<void> {
  // int16 -> float32 at 24 kHz, then linear resample to the 16 kHz capture rate.
  const view = new DataView(pcm24.buffer, pcm24.byteOffset, pcm24.byteLength);
  const count24 = Math.floor(pcm24.byteLength / 2);
  const float24 = new Float32Array(count24);
  for (let i = 0; i < count24; i += 1) {
    float24[i] = view.getInt16(i * 2, true) / 32768;
  }
  const float16 = resampleLinear(float24, PLAYBACK_RATE, CAPTURE_RATE);
  const pcm16 = float32ToPcm16(float16);

  const tmp = path.join(labRoot, "tmp");
  ensureDir(tmp);
  const wavPath = path.join(tmp, "probe-16k.wav");
  fs.writeFileSync(wavPath, pcm16ToWav(pcm16, CAPTURE_RATE));
  console.log(`       wrote ${path.relative(repoRoot, wavPath)} (${float16.length} samples at 16 kHz)`);

  // VAD
  if (session) {
    const vad = new SileroVadEngine({
      frameSamples: VAD_FRAME_SAMPLES,
      minSpeechFrames: 2,
      minSilenceFrames: 8,
      positiveThreshold: 0.5,
      negativeThreshold: 0.35,
      infer: session.createInferencer()
    });
    let starts = 0;
    let ends = 0;
    let peak = 0;
    vad.on("speech-start", () => {
      starts += 1;
    });
    vad.on("speech-end", () => {
      ends += 1;
    });
    for (let i = 0; i + VAD_FRAME_SAMPLES <= float16.length; i += VAD_FRAME_SAMPLES) {
      const probability = await vad.push(float16.subarray(i, i + VAD_FRAME_SAMPLES));
      if (probability != null && probability > peak) peak = probability;
    }
    record(
      "local VAD on real speech",
      starts > 0,
      `${starts} speech-start / ${ends} speech-end, peak probability ${peak.toFixed(3)}`
    );
  }

  // Local transcription through the python worker (model stays resident).
  const pythonCandidates = [
    path.join(labRoot, ".venv", "Scripts", "python.exe"),
    path.join(labRoot, ".venv", "bin", "python")
  ];
  const pythonBin = process.env.HUDDLE_PYTHON ?? pythonCandidates.find((candidate) => fs.existsSync(candidate)) ?? "python";
  const workerScript = path.join(labRoot, "python", "transcribe_worker.py");
  if (!fs.existsSync(pythonBin)) {
    record("local transcription", false, `no python interpreter at ${pythonBin}`);
    return;
  }

  const transcript = await new Promise<string>((resolve, reject) => {
    const child = spawn(pythonBin, ["-u", workerScript], {
      cwd: labRoot,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        WHISPER_MODEL: process.env.WHISPER_MODEL ?? "base.en",
        WHISPER_DEVICE: "cpu",
        WHISPER_COMPUTE_TYPE: "int8",
        WHISPER_CPU_THREADS: process.env.WHISPER_CPU_THREADS ?? "2"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let buffer = "";
    let sent = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timed out after 300 s"));
    }, 300_000);
    const finish = (fn: () => void): void => {
      clearTimeout(timer);
      try {
        child.stdin.write(`${JSON.stringify({ cmd: "shutdown" })}\n`);
      } catch {
        // ignore
      }
      child.kill();
      fn();
    };
    child.on("error", (error) => finish(() => reject(error)));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.log(`       [whisper] ${text.split("\n").slice(-1)[0]}`);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          try {
            const message = JSON.parse(line) as {
              event?: string;
              id?: string;
              ok?: boolean;
              text?: string;
              error?: string;
              model?: string;
            };
            if (message.event === "loading") {
              console.log(`       [whisper] loading ${message.model ?? "model"}…`);
            } else if (message.event === "ready") {
              console.log(`       [whisper] ready (${message.model ?? "model"})`);
              if (!sent) {
                sent = true;
                const pcmBuffer = Buffer.from(
                  float16.buffer,
                  float16.byteOffset,
                  float16.byteLength
                );
                child.stdin.write(
                  `${JSON.stringify({
                    id: "probe",
                    pcm: pcmBuffer.toString("base64"),
                    isFinal: true,
                    sampleRate: CAPTURE_RATE
                  })}\n`
                );
              }
            } else if (message.event === "error") {
              finish(() => reject(new Error(message.error ?? "worker error")));
              return;
            } else if (message.id === "probe") {
              if (message.ok) finish(() => resolve(String(message.text ?? "")));
              else finish(() => reject(new Error(message.error ?? "transcription failed")));
              return;
            }
          } catch {
            console.log(`       [whisper] ${line}`);
          }
        }
        index = buffer.indexOf("\n");
      }
    });
  }).catch((error: unknown) => {
    record("local transcription", false, `${String(error)}`);
    return "";
  });

  if (transcript) {
    console.log(`       transcript: "${transcript}"`);
    const words = PROBE_TEXT.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/);
    const heard = transcript.toLowerCase();
    const matched = words.filter((word) => word.length > 3 && heard.includes(word)).length;
    record(
      "local transcription",
      matched >= 2,
      `${matched}/${words.filter((word) => word.length > 3).length} content words matched the spoken line`
    );
  }
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("Huddle voice live probe");
  console.log(`repo root: ${repoRoot}`);
  console.log(`lab root:  ${labRoot}`);
  const key = getSecret("ELEVENLABS_API_KEY");
  console.log(`elevenlabs key: ${key ? `present (${key.length} chars, resolved by secrets.ts)` : "absent"}`);
  console.log("");

  const { session } = await probeVadModel();

  if (!key.trim()) {
    record("elevenlabs voices", false, "no ELEVENLABS_API_KEY found in the environment or .env");
    record("elevenlabs stream", false, "skipped: no key");
    record("local transcription", false, "skipped: nothing was synthesized to transcribe");
  } else {
    await probeVoices(key);
    const { pcm24 } = await probeSynthesis(key);
    if (pcm24 && pcm24.byteLength > 1_000) {
      await probeLocalSpeech(pcm24, session);
    } else {
      record("local transcription", false, "skipped: synthesis produced no audio");
    }
  }

  console.log("");
  console.log("summary");
  for (const result of results) {
    console.log(`  ${result.ok ? "ok  " : "FAIL"} ${result.step}`);
  }
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    console.log(`\n${failed.length} probe(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nall probes passed.");
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
