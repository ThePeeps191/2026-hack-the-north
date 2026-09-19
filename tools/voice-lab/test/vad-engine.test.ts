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
      infer: async () => {
        calls += 1;
        return calls <= 3 ? 0.9 : 0.1;
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
      infer: async (frame) => {
        probs.push(frame.length);
        return 0.1;
      }
    });

    await vad.push(new Float32Array(200));
    await vad.push(new Float32Array(200));
    expect(probs).toEqual([]);
    await vad.push(new Float32Array(112));
    expect(probs).toEqual([512]);
  });
});
