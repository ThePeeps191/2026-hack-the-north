import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = path.join(root, "models");
const vadPath = path.join(modelsDir, "silero_vad.onnx");
const python = process.env.VOICE_LAB_PYTHON ?? "python";
const venvPython =
  process.platform === "win32"
    ? path.join(root, ".venv", "Scripts", "python.exe")
    : path.join(root, ".venv", "bin", "python");


const VAD_URLS = [
  "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx",
  "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.22/dist/silero_vad_v5.onnx",
  "https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx"
];

function run(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", cwd: root, shell: false, ...opts });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function download(url, dest) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength < 50_000) {
    throw new Error(`GET ${url} returned only ${bytes.byteLength} bytes`);
  }
  fs.writeFileSync(dest, bytes);
  console.log(`Saved ${path.relative(root, dest)} (${bytes.byteLength} bytes) from ${url}`);
}

async function ensureVad() {
  fs.mkdirSync(modelsDir, { recursive: true });
  if (fs.existsSync(vadPath) && fs.statSync(vadPath).size > 50_000) {
    console.log(`Silero VAD already present at ${path.relative(root, vadPath)}`);
    return;
  }
  let lastError;
  for (const url of VAD_URLS) {
    try {
      await download(url, vadPath);
      return;
    } catch (error) {
      lastError = error;
      console.warn(String(error));
    }
  }
  throw lastError ?? new Error("Could not download Silero VAD");
}

async function warmupWhisper() {
  console.log("Warming faster-whisper so the model is cached locally…");
  await new Promise((resolve, reject) => {
    const child = spawn(venvPython, ["-u", path.join(root, "python", "transcribe_worker.py")], {
      cwd: root,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "inherit"]
    });
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out waiting for Whisper to load. Check the Python output above."));
    }, 10 * 60 * 1000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) {
          idx = buffer.indexOf("\n");
          continue;
        }
        try {
          const message = JSON.parse(line);
          if (message.event === "ready") {
            console.log(`Whisper ready: ${message.model} ${message.device}/${message.computeType}`);
            child.stdin.write(JSON.stringify({ cmd: "shutdown" }) + "\n");
            clearTimeout(timer);
            child.kill();
            resolve();
            return;
          }
          if (message.event === "error") {
            clearTimeout(timer);
            reject(new Error(message.message ?? "Whisper failed"));
            child.kill();
            return;
          }
        } catch {
          console.log(line);
        }
        idx = buffer.indexOf("\n");
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main() {
  console.log("Creating Python virtualenv for faster-whisper…");
  if (!fs.existsSync(venvPython)) {
    await run(python, ["-m", "venv", ".venv"]);
  }
  await run(venvPython, ["-m", "pip", "install", "-r", path.join("python", "requirements.txt")]);
  await ensureVad();
  if (!fs.existsSync(path.join(root, ".env"))) {
    fs.copyFileSync(path.join(root, ".env.example"), path.join(root, ".env"));
    console.log("Wrote .env from .env.example. Add ELEVENLABS_API_KEY to enable Speak.");
  }
  await warmupWhisper();
  console.log("\nSetup complete. Next:\n  copy .env.example to .env if needed\n  npm run dev\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
