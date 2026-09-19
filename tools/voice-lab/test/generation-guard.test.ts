import { describe, expect, it } from "vitest";
import { GenerationGuard } from "../src/modules/generation-guard.ts";

describe("GenerationGuard", () => {
  it("accepts chunks from the current generation only", () => {
    const guard = new GenerationGuard();
    const first = guard.begin();
    expect(guard.accepts(first)).toBe(true);
    expect(first).toBeGreaterThan(0);
  });

  it("rejects late chunks after stop so cancelled playback cannot restart", () => {
    const guard = new GenerationGuard();
    const generation = guard.begin();
    guard.stop();

    expect(guard.accepts(generation)).toBe(false);
    expect(guard.isPlaying()).toBe(false);
  });

  it("rejects leftover chunks from a previous speak after a new speak starts", () => {
    const guard = new GenerationGuard();
    const previous = guard.begin();
    const current = guard.begin();

    expect(guard.accepts(previous)).toBe(false);
    expect(guard.accepts(current)).toBe(true);
  });
});
