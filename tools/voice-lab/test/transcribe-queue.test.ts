import { describe, expect, it } from "vitest";
import { TranscribeQueue } from "../src/modules/transcribe-queue.ts";

describe("TranscribeQueue", () => {
  it("drops stale partials when a newer partial for the same utterance arrives", async () => {
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const queue = new TranscribeQueue(async (job) => {
      if (job.textHint === "slow") await gate;
      seen.push(job.textHint ?? job.utteranceId);
      return `out:${job.textHint ?? job.utteranceId}`;
    });

    const first = queue.enqueue({
      utteranceId: "u1",
      pcm: new Float32Array(16),
      isFinal: false,
      textHint: "slow"
    });
    const second = queue.enqueue({
      utteranceId: "u1",
      pcm: new Float32Array(16),
      isFinal: false,
      textHint: "latest"
    });

    release();
    const firstResult = await first;
    const secondResult = await second;

    expect(firstResult).toBeNull();
    expect(secondResult).toBe("out:latest");
    expect(seen).toEqual(["slow", "latest"]);
  });

  it("always runs a final even if a partial is in flight", async () => {
    const seen: Array<{ hint?: string; isFinal: boolean }> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const queue = new TranscribeQueue(async (job) => {
      if (!job.isFinal) await gate;
      seen.push({ hint: job.textHint, isFinal: job.isFinal });
      return job.textHint ?? "final";
    });

    const partial = queue.enqueue({
      utteranceId: "u1",
      pcm: new Float32Array(8),
      isFinal: false,
      textHint: "partial"
    });
    const finalJob = queue.enqueue({
      utteranceId: "u1",
      pcm: new Float32Array(8),
      isFinal: true,
      textHint: "final"
    });

    release();
    expect(await partial).toBe("partial");
    expect(await finalJob).toBe("final");
    expect(seen.map((item) => item.isFinal)).toEqual([false, true]);
  });
});
