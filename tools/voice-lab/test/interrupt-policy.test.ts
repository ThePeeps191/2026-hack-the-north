import { describe, expect, it } from "vitest";
import { InterruptPolicy } from "../src/modules/interrupt-policy.ts";

describe("InterruptPolicy", () => {
  it("does not interrupt until consecutive local VAD speech crosses the hangover", () => {
    const policy = new InterruptPolicy({
      minSpeechMs: 180,
      speechThreshold: 0.5,
      playbackSpeechThreshold: 0.65,
      frameMs: 32
    });

    expect(policy.observe({ probability: 0.9, playbackActive: true })).toBe(false);
    expect(policy.observe({ probability: 0.9, playbackActive: true })).toBe(false);
    expect(policy.observe({ probability: 0.9, playbackActive: true })).toBe(false);
    expect(policy.observe({ probability: 0.9, playbackActive: true })).toBe(false);
    expect(policy.observe({ probability: 0.9, playbackActive: true })).toBe(false);
    expect(policy.observe({ probability: 0.9, playbackActive: true })).toBe(true);
  });

  it("does not treat a brief spike as barge-in", () => {
    const policy = new InterruptPolicy({
      minSpeechMs: 180,
      speechThreshold: 0.5,
      playbackSpeechThreshold: 0.65,
      frameMs: 32
    });

    expect(policy.observe({ probability: 0.99, playbackActive: true })).toBe(false);
    expect(policy.observe({ probability: 0.1, playbackActive: true })).toBe(false);
  });

  it("never interrupts when playback is already stopped", () => {
    const policy = new InterruptPolicy({
      minSpeechMs: 32,
      speechThreshold: 0.5,
      playbackSpeechThreshold: 0.65,
      frameMs: 32
    });

    expect(policy.observe({ probability: 0.99, playbackActive: false })).toBe(false);
  });

  it("uses a higher threshold while the agent is speaking to reduce echo self-triggers", () => {
    const policy = new InterruptPolicy({
      minSpeechMs: 32,
      speechThreshold: 0.5,
      playbackSpeechThreshold: 0.8,
      frameMs: 32
    });

    expect(policy.observe({ probability: 0.7, playbackActive: true })).toBe(false);
    expect(policy.observe({ probability: 0.85, playbackActive: true })).toBe(true);
  });
});
