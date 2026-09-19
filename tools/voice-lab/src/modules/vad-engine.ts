import { concatFloat32 } from "./audio-util.ts";

export type VadEvent = "speech-start" | "speech-end";

export type SileroVadOptions = {
  frameSamples: number;
  minSpeechFrames: number;
  minSilenceFrames: number;
  positiveThreshold: number;
  negativeThreshold: number;
  infer: (frame: Float32Array) => Promise<number>;
};

type Listener = () => void;

export class SileroVadEngine {
  private leftover: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private voiced = 0;
  private silent = 0;
  private inSpeech = false;
  private readonly listeners = new Map<VadEvent, Listener[]>();

  constructor(private readonly opts: SileroVadOptions) {}

  on(event: VadEvent, listener: Listener): () => void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return () => {
      const next = (this.listeners.get(event) ?? []).filter((item) => item !== listener);
      this.listeners.set(event, next);
    };
  }

  async push(samples: Float32Array): Promise<number | null> {
    this.leftover = concatFloat32(this.leftover.length === 0 ? [samples] : [this.leftover, samples]);
    let last: number | null = null;
    while (this.leftover.length >= this.opts.frameSamples) {
      const frame = this.leftover.subarray(0, this.opts.frameSamples);
      this.leftover = this.leftover.subarray(this.opts.frameSamples).slice();
      last = await this.opts.infer(frame);
      this.handleProbability(last);
    }
    return last;
  }

  reset(): void {
    this.leftover = new Float32Array(0);
    this.voiced = 0;
    this.silent = 0;
    this.inSpeech = false;
  }

  get speaking(): boolean {
    return this.inSpeech;
  }

  private handleProbability(probability: number): void {
    if (!this.inSpeech) {
      if (probability >= this.opts.positiveThreshold) {
        this.voiced += 1;
        if (this.voiced >= this.opts.minSpeechFrames) {
          this.inSpeech = true;
          this.voiced = 0;
          this.silent = 0;
          this.emit("speech-start");
        }
      } else {
        this.voiced = 0;
      }
      return;
    }

    if (probability < this.opts.negativeThreshold) {
      this.silent += 1;
      if (this.silent >= this.opts.minSilenceFrames) {
        this.inSpeech = false;
        this.silent = 0;
        this.voiced = 0;
        this.emit("speech-end");
      }
    } else {
      this.silent = 0;
    }
  }

  private emit(event: VadEvent): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }
}

export async function loadSileroVadSession(modelPath: string): Promise<{
  createInferencer: () => (frame: Float32Array) => Promise<number>;
}> {
  const ort = await import("onnxruntime-node");
  const session = await ort.InferenceSession.create(modelPath);
  const inputNames = session.inputNames;
  const usesState = inputNames.includes("state");
  const usesHc = inputNames.includes("h") && inputNames.includes("c");

  return {
    createInferencer: () => {
      let state = new Float32Array(2 * 1 * 128);
      let h = new Float32Array(2 * 1 * 64);
      let c = new Float32Array(2 * 1 * 64);
      // Official Silero ONNX streaming prepends 64 samples of context at 16 kHz.
      let context = new Float32Array(64);

      return async (frame: Float32Array) => {
        const window = new Float32Array(context.length + frame.length);
        window.set(context, 0);
        window.set(frame, context.length);
        context = window.slice(window.length - context.length);
        const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {
          input: new ort.Tensor("float32", window, [1, window.length])
        };
        if (inputNames.includes("sr")) {
          feeds.sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
        }
        if (usesState) {
          feeds.state = new ort.Tensor("float32", state, [2, 1, 128]);
        }
        if (usesHc) {
          feeds.h = new ort.Tensor("float32", h, [2, 1, 64]);
          feeds.c = new ort.Tensor("float32", c, [2, 1, 64]);
        }

        const result = await session.run(feeds);
        const outputName = session.outputNames[0];
        if (!outputName) {
          throw new Error("Silero VAD ONNX model did not expose an output tensor");
        }
        const output = result[outputName];
        if (!output) {
          throw new Error("Silero VAD ONNX inference returned no speech probability");
        }
        const probability = Number(output.data[0] ?? 0);

        if (usesState) {
          const next = result.state ?? result.onnx_state ?? result.stateN;
          if (next?.data) state = Float32Array.from(next.data as Float32Array);
        }
        if (usesHc) {
          if (result.hn?.data) h = Float32Array.from(result.hn.data as Float32Array);
          if (result.cn?.data) c = Float32Array.from(result.cn.data as Float32Array);
          if (result.h?.data) h = Float32Array.from(result.h.data as Float32Array);
          if (result.c?.data) c = Float32Array.from(result.c.data as Float32Array);
        }
        return probability;
      };
    }
  };
}
