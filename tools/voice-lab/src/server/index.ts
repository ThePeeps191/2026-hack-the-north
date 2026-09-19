import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { loadConfig, ROOT } from "./config.ts";
import { FasterWhisperProcess } from "./whisper-process.ts";
import { loadSileroVadSession, SileroVadEngine } from "../modules/vad-engine.ts";
import { ElevenLabsSynthesizer } from "../modules/synthesizer.ts";
import { VoiceSession } from "./session.ts";
import { loadVoices } from "./voices.ts";
import { VAD_FRAME_SAMPLES } from "../shared/protocol.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml"
};

async function main(): Promise<void> {
  const config = loadConfig();
  const transcriber = new FasterWhisperProcess(config);
  transcriber.on("log", (line: string) => {
    console.error(`[whisper] ${line}`);
  });
  transcriber.on("error", (error: Error) => {
    console.error(`[whisper] ${error.message}`);
  });

  let stt;
  try {
    stt = await transcriber.start();
    console.log(`Loaded ${stt.engine} model ${stt.model} on ${stt.device}/${stt.computeType}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    throw error;
  }

  if (!fs.existsSync(config.sileroModelPath)) {
    throw new Error(
      `Silero VAD model missing at ${config.sileroModelPath}. Run npm run setup inside tools/voice-lab.`
    );
  }

  const vadSession = await loadSileroVadSession(config.sileroModelPath);
  const synthesizer = new ElevenLabsSynthesizer({
    apiKey: config.elevenLabsApiKey,
    modelId: config.elevenLabsModel,
    outputFormat: "pcm_24000"
  });
  const voices = await loadVoices(config);

  const staticDir = path.join(ROOT, "dist", "client");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${config.host}:${config.port}`);
    if (url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": config.clientOrigin });
      res.end(
        JSON.stringify({
          ok: true,
          stt,
          vad: path.basename(config.sileroModelPath),
          elevenLabs: Boolean(config.elevenLabsApiKey.trim())
        })
      );
      return;
    }
    if (url.pathname === "/api/voices") {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": config.clientOrigin });
      res.end(JSON.stringify({ voices }));
      return;
    }
    if (!fs.existsSync(staticDir)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Voice lab UI is served by Vite in dev. Run npm run dev.");
      return;
    }
    const relative = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.normalize(path.join(staticDir, relative));
    if (!filePath.startsWith(staticDir)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(filePath, (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket: WebSocket) => {
    const vad = new SileroVadEngine({
      frameSamples: VAD_FRAME_SAMPLES,
      minSpeechFrames: 3,
      minSilenceFrames: 25,
      positiveThreshold: 0.5,
      negativeThreshold: 0.35,
      infer: vadSession.createInferencer()
    });
    const session = new VoiceSession(socket, { vad, transcriber, synthesizer, voices, stt });
    session.start();
    // No global serialising queue (defect 1): the session keeps microphone frames
    // in order on their own chain and handles control synchronously, so an
    // in-flight synthesis can never delay a mic frame or a stop command.
    socket.on("message", (data, isBinary) => {
      const raw = Array.isArray(data) ? Buffer.concat(data) : data;
      void session.handleMessage(raw as Buffer, isBinary).catch((error: unknown) => {
        console.error(error);
      });
    });
    socket.on("close", () => {
      void session.dispose();
    });
    socket.on("error", () => {
      void session.dispose();
    });
  });

  server.listen(config.port, config.host, () => {
    console.log(`Voice lab server http://${config.host}:${config.port}`);
    if (!config.elevenLabsApiKey.trim()) {
      console.warn("ELEVENLABS_API_KEY is empty. Local mic/STT/VAD still work; Speak will error.");
    }
  });

  const shutdown = async () => {
    wss.close();
    server.close();
    await transcriber.dispose();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
