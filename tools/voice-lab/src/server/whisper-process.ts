import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { VoiceLabConfig } from "./config.ts";
import type { SttInfo } from "../shared/protocol.ts";

type Pending = {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
};

export class FasterWhisperProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private info: SttInfo | null = null;
  private readyPromise: Promise<void> | null = null;

  constructor(private readonly config: VoiceLabConfig) {
    super();
  }

  get sttInfo(): SttInfo | null {
    return this.info;
  }

  async start(): Promise<SttInfo> {
    if (this.readyPromise) {
      await this.readyPromise;
      if (!this.info) throw new Error("local Whisper worker failed to start");
      return this.info;
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const child = spawn(this.config.pythonBin, ["-u", this.config.workerScript], {
        cwd: path.dirname(this.config.workerScript),
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          WHISPER_MODEL: this.config.whisperModel,
          WHISPER_DEVICE: this.config.whisperDevice,
          WHISPER_COMPUTE_TYPE: this.config.whisperComputeType,
          WHISPER_CPU_THREADS: this.config.whisperCpuThreads,
          MKL_DISABLE_FAST_MM: "1",
          KMP_DUPLICATE_LIB_OK: "TRUE",
          OMP_NUM_THREADS: this.config.whisperCpuThreads,
          MKL_NUM_THREADS: this.config.whisperCpuThreads
        },
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.child = child;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        if (!this.info) reject(error);
        if (this.listenerCount("error") > 0) this.emit("error", error);
      };

      child.on("error", (error) => {
        fail(
          new Error(
            `Could not start local Whisper worker with ${this.config.pythonBin}: ${error.message}. Run npm run setup.`
          )
        );
      });

      child.on("exit", (code, signal) => {
        const error = new Error(`local Whisper worker exited (code=${code}, signal=${signal})`);
        for (const [, pending] of this.pending) pending.reject(error);
        this.pending.clear();
        if (!this.info) fail(error);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text) this.emit("log", text);
      });

      const resolveReady = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      child.stdout.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        let newline = this.buffer.indexOf("\n");
        while (newline >= 0) {
          const line = this.buffer.slice(0, newline).trim();
          this.buffer = this.buffer.slice(newline + 1);
          if (line) this.handleLine(line, resolveReady, fail);
          newline = this.buffer.indexOf("\n");
        }
      });
    });

    await this.readyPromise;
    if (!this.info) throw new Error("local Whisper worker started without a ready event");
    return this.info;
  }

  async transcribe(pcm: Float32Array, isFinal: boolean): Promise<string> {
    if (!this.child?.stdin.writable) {
      throw new Error("local Whisper worker is not running");
    }
    const id = String(this.nextId++);
    const payload = {
      id,
      pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64"),
      isFinal,
      sampleRate: 16000
    };
    const result = new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(JSON.stringify(payload) + "\n");
    return result;
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.write(JSON.stringify({ cmd: "shutdown" }) + "\n");
    } catch {
      // ignore
    }
    const closed = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(resolve, 1500);
    });
    child.kill();
    await closed;
  }

  private handleLine(
    line: string,
    resolveReady: () => void,
    fail: (error: Error) => void
  ): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emit("log", line);
      return;
    }

    if (message.event === "ready") {
      this.info = {
        engine: "faster-whisper",
        model: String(message.model ?? this.config.whisperModel),
        device: String(message.device ?? this.config.whisperDevice),
        computeType: String(message.computeType ?? this.config.whisperComputeType)
      };
      resolveReady();
      return;
    }
    if (message.event === "error" && !this.info) {
      fail(new Error(String(message.message ?? "Whisper worker error")));
      return;
    }
    if (typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(String(message.text ?? ""));
      else pending.reject(new Error(String(message.error ?? "transcription failed")));
    }
  }
}
