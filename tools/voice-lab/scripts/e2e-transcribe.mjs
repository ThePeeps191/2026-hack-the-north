import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wav = path.join(root, "tmp", "jfk16.wav");
const python = path.join(root, ".venv", "Scripts", "python.exe");

const pcm16 = await new Promise((resolve, reject) => {
  const child = spawn(python, [
    "-c",
    `import av, sys, numpy as np
c=av.open(r"${wav.replaceAll("\\", "/")}")
s=c.streams.audio[0]
r=av.AudioResampler(format="s16", layout="mono", rate=16000)
chunks=[]
for frame in c.decode(s):
  for f in r.resample(frame):
    chunks.append(f.to_ndarray().reshape(-1).astype("<i2"))
sys.stdout.buffer.write(np.concatenate(chunks).tobytes())`
  ]);
  const chunks = [];
  const err = [];
  child.stdout.on("data", (d) => chunks.push(d));
  child.stderr.on("data", (d) => err.push(d));
  child.on("exit", (code) => {
    if (code === 0) resolve(Buffer.concat(chunks));
    else reject(new Error(Buffer.concat(err).toString() || `exit ${code}`));
  });
});

const ws = new WebSocket("ws://127.0.0.1:8787/ws");
const transcripts = [];
const t0 = Date.now();

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout waiting for transcript")), 60000);
  ws.on("open", () => undefined);
  ws.on("error", reject);
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString());
    if (msg.type === "hello") console.log("hello", msg.status, msg.detail);
    if (msg.type === "hello" && msg.status === "ready") {
      ws.send(JSON.stringify({ type: "mic.start" }));
      const frame = 512 * 2;
      for (let i = 0; i + frame <= pcm16.length; i += frame) {
        ws.send(pcm16.subarray(i, i + frame), { binary: true });
      }
      setTimeout(() => {
        ws.send(JSON.stringify({ type: "mic.stop" }));
        setTimeout(() => {
          clearTimeout(timer);
          ws.close();
          resolve();
        }, 8000);
      }, 400);
    }
    if (msg.type === "transcript") {
      transcripts.push(msg);
      console.log(`${msg.isFinal ? "FINAL" : "partial"} ${Date.now() - t0}ms: ${msg.text}`);
    }
    if (msg.type === "error") {
      clearTimeout(timer);
      reject(new Error(msg.message));
    }
  });
});

const finalText = transcripts
  .filter((item) => item.isFinal)
  .map((item) => item.text)
  .join(" ");
if (!/americans/i.test(finalText) || !/country/i.test(finalText)) {
  throw new Error(`Unexpected transcript: ${finalText || "(empty)"}`);
}
console.log("E2E ok");
