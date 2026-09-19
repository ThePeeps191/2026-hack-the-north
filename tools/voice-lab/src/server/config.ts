import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");

dotenv.config({ path: path.join(ROOT, ".env") });

export type VoiceLabConfig = {
  host: string;
  port: number;
  clientOrigin: string;
  elevenLabsApiKey: string;
  elevenLabsModel: string;
  whisperModel: string;
  whisperDevice: string;
  whisperComputeType: string;
  whisperCpuThreads: string;
  pythonBin: string;
  workerScript: string;
  sileroModelPath: string;
};

function firstExisting(paths: string[]): string | null {
  for (const candidate of paths) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function loadConfig(): VoiceLabConfig {
  const venvPython = firstExisting([
    path.join(ROOT, ".venv", "Scripts", "python.exe"),
    path.join(ROOT, ".venv", "bin", "python")
  ]);

  return {
    host: process.env.VOICE_LAB_HOST ?? "127.0.0.1",
    port: Number(process.env.VOICE_LAB_PORT ?? 8787),
    clientOrigin: process.env.CLIENT_ORIGIN ?? "http://127.0.0.1:5173",
    elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? "",
    elevenLabsModel: process.env.ELEVENLABS_MODEL ?? "eleven_flash_v2_5",
    whisperModel: process.env.WHISPER_MODEL ?? "base.en",
    whisperDevice: process.env.WHISPER_DEVICE ?? "cpu",
    whisperComputeType: process.env.WHISPER_COMPUTE_TYPE ?? "int8",
    whisperCpuThreads: process.env.WHISPER_CPU_THREADS ?? "2",
    pythonBin: process.env.VOICE_LAB_PYTHON ?? venvPython ?? "python",
    workerScript: path.join(ROOT, "python", "transcribe_worker.py"),
    sileroModelPath: path.resolve(ROOT, process.env.SILERO_VAD_MODEL ?? "models/silero_vad.onnx")
  };
}

export const PRESET_VOICES = [
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", label: "Maya" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam", label: "Alex" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George", label: "Sam" }
] as const;
