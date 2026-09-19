// Local VAD: Silero ONNX via onnxruntime-node, framed at 512 samples.
//
// Two fixes over the first version of this file:
//
//  1. `reset()` now also clears the inference stream (the LSTM state and the
//     64-sample context window), not just the counters. Sharing that state across
//     capture sessions made a second join mis-detect speech.
//  2. The class no longer uses constructor parameter properties, so plain Node
//     (`node --experimental-strip-types`) can import this file — which is what
//     scripts/verify-live.ts does.

import type { InferenceSession, Tensor } from "onnxruntime-node";
import { concatFloat32 } from "./audio-util.ts";

export type VadEvent = "speech-start" | "speech-end";

/** The ONNX side of the engine. `reset` clears the model's recurrent state. */
export type VadInferencer = {
  infer: (frame: Float32Array) => Promise<number>;
  reset: () => void;
};

export type SileroVadOptions = {
  frameSamples: number;
  minSpeechFrames: number;
  minSilenceFrames: number;
  positiveThreshold: number;
  negativeThreshold: number;
  infer: VadInferencer;
};

type Listener = (probability: number) => void;

export class SileroVadEngine {
  private leftover: Float32Array = new Float32Array(0);
  private voiced = 0;
  private silent = 0;
  private inSpeech = false;
  private readonly listeners = new Map<VadEvent, Listener[]>();
  private readonly opts: SileroVadOptions;

  constructor(opts: SileroVadOptions) {
    this.opts = opts;
  }

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
    this.leftover = concatFloat32(
      this.leftover.length === 0 ? [samples] : [this.leftover, samples]
    );
    let last: number | null = null;
    while (this.leftover.length >= this.opts.frameSamples) {
      const frame = this.leftover.subarray(0, this.opts.frameSamples);
      this.leftover = this.leftover.subarray(this.opts.frameSamples).slice();
      last = await this.opts.infer.infer(frame);
      this.handleProbability(last);
    }
    return last;
  }

  /** Between capture sessions: counters *and* model state. */
  reset(): void {
    this.leftover = new Float32Array(0);
    this.voiced = 0;
    this.silent = 0;
    this.inSpeech = false;
    this.opts.infer.reset();
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
          this.emit("speech-start", probability);
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
        this.emit("speech-end", probability);
      }
    } else {
      this.silent = 0;
    }
  }

  private emit(event: VadEvent, probability: number): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(probability);
    }
  }
}

export type SileroVadSession = {
  createInferencer: () => VadInferencer;
  inputNames: readonly string[];
  outputNames: readonly string[];
};

export async function loadSileroVadSession(modelPath: string): Promise<SileroVadSession> {
  const ort = await import("onnxruntime-node");
  const session: InferenceSession = await ort.InferenceSession.create(modelPath);
  const inputNames = session.inputNames;
  const outputNames = session.outputNames;
  const usesState = inputNames.includes("state");
  const usesHc = inputNames.includes("h") && inputNames.includes("c");

  return {
    inputNames,
    outputNames,
    createInferencer: (): VadInferencer => {
      let state = new Float32Array(2 * 1 * 128);
      let h = new Float32Array(2 * 1 * 64);
      let c = new Float32Array(2 * 1 * 64);
      // The official Silero streaming graph prepends 64 samples of context at 16 kHz.
      let context = new Float32Array(64);
      let chain: Promise<unknown> = Promise.resolve();

      const reset = (): void => {
        state = new Float32Array(2 * 1 * 128);
        h = new Float32Array(2 * 1 * 64);
        c = new Float32Array(2 * 1 * 64);
        context = new Float32Array(64);
      };

      const inferOnce = async (frame: Float32Array): Promise<number> => {
        const window = new Float32Array(context.length + frame.length);
        window.set(context, 0);
        window.set(frame, context.length);
        context = window.slice(window.length - context.length);

        const feeds: Record<string, Tensor> = {
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
        const outputName = outputNames[0];
        if (!outputName) {
          throw new Error("Silero VAD ONNX model did not expose an output tensor");
        }
        const output = result[outputName];
        if (!output) {
          throw new Error("Silero VAD ONNX inference returned no speech probability");
        }
        const probability = Number(output.data[0] ?? 0);

        if (usesState) {
          const next = result.stateN ?? result.state ?? result.onnx_state;
          if (next && next.data instanceof Float32Array) state = Float32Array.from(next.data);
        }
        if (usesHc) {
          const nextH = result.hn ?? result.h;
          const nextC = result.cn ?? result.c;
          if (nextH && nextH.data instanceof Float32Array) h = Float32Array.from(nextH.data);
          if (nextC && nextC.data instanceof Float32Array) c = Float32Array.from(nextC.data);
        }
        return probability;
      };

      return {
        reset,
        infer: (frame: Float32Array): Promise<number> => {
          // One frame at a time: the graph is stateful.
          const next = chain.then(() => inferOnce(frame));
          chain = next.catch(() => undefined);
          return next;
        }
      };
    }
  };
}
