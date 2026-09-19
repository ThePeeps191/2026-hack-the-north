import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSileroVadSession, SileroVadEngine } from "../src/modules/vad-engine.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wav = path.join(root, "tmp", "jfk.wav");
const python = path.join(root, ".venv", "Scripts", "python.exe");

function runPython(code) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-c", code], { cwd: root });
    const chunks = [];
    const err = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(Buffer.concat(err).toString() || `exit ${code}`));
    });
  });
}

const pcmBuf = await runPython(`
import sys
import av
import numpy as np
container = av.open(r"${wav.replaceAll("\\", "/")}")
stream = container.streams.audio[0]
resampler = av.AudioResampler(format="flt", layout="mono", rate=16000)
chunks = []
for frame in container.decode(stream):
    for converted in resampler.resample(frame):
        chunks.append(converted.to_ndarray().reshape(-1).astype("float32"))
pcm = np.concatenate(chunks)
sys.stdout.buffer.write(pcm.tobytes())
`);

const pcm = new Float32Array(pcmBuf.buffer, pcmBuf.byteOffset, Math.floor(pcmBuf.byteLength / 4));
console.log(`pcm samples=${pcm.length} sec=${(pcm.length / 16000).toFixed(2)}`);

const { createInferencer } = await loadSileroVadSession(path.join(root, "models", "silero_vad.onnx"));
const vad = new SileroVadEngine({
  frameSamples: 512,
  minSpeechFrames: 3,
  minSilenceFrames: 8,
  positiveThreshold: 0.5,
  negativeThreshold: 0.35,
  infer: createInferencer()
});
let starts = 0;
let ends = 0;
vad.on("speech-start", () => {
  starts += 1;
});
vad.on("speech-end", () => {
  ends += 1;
});
for (let i = 0; i + 512 <= pcm.length; i += 512) {
  await vad.push(pcm.subarray(i, i + 512));
}
console.log(`vad starts=${starts} ends=${ends} speaking=${vad.speaking}`);
if (starts < 1) {
  throw new Error("Silero VAD did not detect speech in JFK sample");
}
console.log("VAD ok");
