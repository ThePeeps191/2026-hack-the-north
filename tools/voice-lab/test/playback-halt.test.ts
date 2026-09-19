import { describe, expect, it } from "vitest";
import { shouldHaltPlaybackSink } from "../src/modules/playback-session.ts";

describe("shouldHaltPlaybackSink", () => {
  it("does not halt when the synthesis stream has only finished downloading", () => {
    expect(shouldHaltPlaybackSink("ended")).toBe(false);
    expect(shouldHaltPlaybackSink("starting")).toBe(false);
    expect(shouldHaltPlaybackSink("audible")).toBe(false);
  });

  it("halts immediately on user stop or barge-in", () => {
    expect(shouldHaltPlaybackSink("stopped")).toBe(true);
    expect(shouldHaltPlaybackSink("interrupted")).toBe(true);
  });
});
