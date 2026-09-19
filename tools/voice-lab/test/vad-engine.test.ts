import { describe, expect, it } from "vitest";
import { SileroVadEngine } from "../src/modules/vad-engine.ts";

describe("SileroVadEngine", () => {
  it("emits speech start only after enough voiced frames", async () => {
    const events: string[] = [];
    let calls = 0;
    const vad = new SileroVadEngine({
      frameSamples: 512,
      minSpeechFrames: 3,
      minSilenceFrames: 4,
      positiveThreshold: 0.5,
      negativeThreshold: 0.35,
      infer: {
        infer: async () => {
          calls += 1;
          return calls <= 3 ? 0.9 : 0.1;
        },
        reset: () => undefined
      }
    });
    vad.on("speech-start", () => events.push("start"));
    vad.on("speech-end", () => events.push("end"));

    const frame = new Float32Array(512).fill(0.2);
    for (let i = 0; i < 3; i += 1) {
      await vad.push(frame);
    }
    expect(events).toEqual(["start"]);

    for (let i = 0; i < 4; i += 1) {
      await vad.push(new Float32Array(512));
    }
    expect(events).toEqual(["start", "end"]);
  });

  it("buffers leftover samples across pushes smaller than one frame", async () => {
    const probs: number[] = [];
    const vad = new SileroVadEngine({
      frameSamples: 512,
      minSpeechFrames: 1,
      minSilenceFrames: 1,
      positiveThreshold: 0.5,
      negativeThreshold: 0.35,
      infer: {
        infer: async (frame) => {
          probs.push(frame.length);
          return 0.1;
        },
        reset: () => undefined
      }
    });

    await vad.push(new Float32Array(200));
    await vad.push(new Float32Array(200));
    expect(probs).toEqual([]);
    await vad.push(new Float32Array(112));
    expect(probs).toEqual([512]);
  });

  it("reset clears counters, framing and the model's recurrent state (defect 5)", async () => {
    let resets = 0;
    let frames = 0;
    const vad = new SileroVadEngine({
      frameSamples: 512,
      minSpeechFrames: 1,
      minSilenceFrames: 1,
      positiveThreshold: 0.5,
      negativeThreshold: 0.35,
      infer: {
        infer: async () => {
          frames += 1;
          return 0.9;
        },
        reset: () => {
          resets += 1;
        }
      }
    });

    await vad.push(new Float32Array(512));
    expect(vad.speaking).toBe(true);
    await vad.push(new Float32Array(200));

    vad.reset();
    expect(resets).toBe(1);
    expect(vad.speaking).toBe(false);

    // The partially framed audio must be gone as well.
    const framesAfterReset = frames;
    await vad.push(new Float32Array(112));
    expect(frames).toBe(framesAfterReset);

    // A second capture session detects speech again instead of inheriting state.
    await vad.push(new Float32Array(512));
    expect(vad.speaking).toBe(true);
    expect(frames).toBe(framesAfterReset + 1);
  });
});
