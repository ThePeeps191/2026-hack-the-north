import { describe, expect, it } from "vitest";
import { TranscriptLog } from "../src/modules/transcript-log.ts";

describe("TranscriptLog", () => {
  it("replaces provisional text for the same utterance instead of appending", () => {
    const log = new TranscriptLog();
    log.applyPartial("u1", "fix the");
    log.applyPartial("u1", "fix the button");
    log.applyPartial("u1", "fix the button color");

    expect(log.snapshot()).toEqual({
      finals: [],
      provisional: { utteranceId: "u1", text: "fix the button color" }
    });
    expect(log.displayLines()).toEqual([
      { kind: "provisional", utteranceId: "u1", text: "fix the button color" }
    ]);
  });

  it("commits a final utterance and clears matching provisional text", () => {
    const log = new TranscriptLog();
    log.applyPartial("u1", "hey Maya");
    log.applyFinal("u1", "hey Maya, open App.tsx");

    expect(log.snapshot()).toEqual({
      finals: [{ utteranceId: "u1", text: "hey Maya, open App.tsx" }],
      provisional: null
    });
  });

  it("revises an already-final utterance in place without duplicating it", () => {
    const log = new TranscriptLog();
    log.applyFinal("u1", "open app tsx");
    log.applyFinal("u1", "open App.tsx");

    expect(log.snapshot().finals).toEqual([
      { utteranceId: "u1", text: "open App.tsx" }
    ]);
    expect(log.displayLines()).toHaveLength(1);
  });

  it("keeps a new utterance's provisional separate from previous finals", () => {
    const log = new TranscriptLog();
    log.applyFinal("u1", "stop playback");
    log.applyPartial("u2", "now ask Alex");

    expect(log.displayLines()).toEqual([
      { kind: "final", utteranceId: "u1", text: "stop playback" },
      { kind: "provisional", utteranceId: "u2", text: "now ask Alex" }
    ]);
  });
});
