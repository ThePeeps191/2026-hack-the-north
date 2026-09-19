import { describe, expect, it } from "vitest";
import { TimingTracker } from "../src/modules/timing.ts";

describe("TimingTracker", () => {
  it("measures interruption as playback-stop minus local VAD speech start", () => {
    const timing = new TimingTracker(() => 1_000);
    timing.markVadSpeechStart();
    timing.setNow(() => 1_042);
    timing.markPlaybackStopped("interrupted");

    expect(timing.snapshot().interruptionMs).toBe(42);
  });

  it("measures final-transcript availability from speech end", () => {
    const timing = new TimingTracker(() => 2_000);
    timing.markSpeechEnd();
    timing.setNow(() => 2_310);
    timing.markFinalTranscript();

    expect(timing.snapshot().finalTranscriptMs).toBe(310);
  });

  it("measures first audible synthesized speech from speak request", () => {
    const timing = new TimingTracker(() => 5_000);
    timing.markSpeakRequested();
    timing.setNow(() => 5_180);
    timing.markFirstAudible();

    expect(timing.snapshot().firstAudibleMs).toBe(180);
  });

  it("does not keep first-audible timing from a cancelled generation", () => {
    const timing = new TimingTracker(() => 8_000);
    timing.markSpeakRequested();
    timing.markPlaybackStopped("stopped");
    timing.setNow(() => 8_500);
    timing.markFirstAudible();

    expect(timing.snapshot().firstAudibleMs).toBeNull();
  });
});
