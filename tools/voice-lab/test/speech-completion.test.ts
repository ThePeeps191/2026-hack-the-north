// Defect 3, lab side: playback is only complete when synthesis reached EOF *and*
// the output buffer drained.
//
// Ported from the main port's src/main/voice/floor.ts behaviour so both agree.

import { describe, expect, it } from "vitest";
import { SpeechCompletion } from "../src/modules/speech-completion.ts";

describe("SpeechCompletion", () => {
  it("does not complete from a drained buffer alone", () => {
    const completion = new SpeechCompletion();
    completion.markDrained();
    expect(completion.canReportDrained).toBe(false);
    expect(completion.complete).toBe(false);
  });

  it("completes when synthesis ended and the buffer drained, in either order", () => {
    const first = new SpeechCompletion();
    first.markDrained();
    first.markSynthesisEnded();
    expect(first.complete).toBe(true);

    const second = new SpeechCompletion();
    second.markSynthesisEnded();
    expect(second.canReportDrained).toBe(true);
    expect(second.complete).toBe(false);
    second.markDrained();
    expect(second.complete).toBe(true);
  });

  it("keeps EOF and drain state per generation and resets between them", () => {
    const completion = new SpeechCompletion();
    completion.markSynthesisEnded();
    completion.reset();
    expect(completion.sawSynthesisEnd).toBe(false);
    expect(completion.complete).toBe(false);
  });
});
