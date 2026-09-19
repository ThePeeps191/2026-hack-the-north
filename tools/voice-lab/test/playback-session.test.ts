import { describe, expect, it } from "vitest";
import { PlaybackSession } from "../src/modules/playback-session.ts";

describe("PlaybackSession", () => {
  it("forwards current-generation PCM and reports the first accepted chunk", () => {
    const played: Float32Array[] = [];
    const session = new PlaybackSession({
      now: () => 10,
      play: (pcm) => {
        played.push(pcm);
      }
    });

    const generation = session.begin();
    const first = session.push(generation, new Float32Array([0.1, 0.2]));
    const second = session.push(generation, new Float32Array([0.3]));

    expect(first).toEqual({ accepted: true, firstAudible: true });
    expect(second).toEqual({ accepted: true, firstAudible: false });
    expect(played).toHaveLength(2);
    expect(session.isActive()).toBe(true);
  });

  it("drops late chunks after stop and clears the buffer", () => {
    const played: Float32Array[] = [];
    const session = new PlaybackSession({
      now: () => 10,
      play: (pcm) => {
        played.push(pcm);
      }
    });

    const generation = session.begin();
    session.stop();
    const late = session.push(generation, new Float32Array([1, 1, 1]));

    expect(late).toEqual({ accepted: false, firstAudible: false });
    expect(played).toHaveLength(0);
    expect(session.isActive()).toBe(false);
  });
});
