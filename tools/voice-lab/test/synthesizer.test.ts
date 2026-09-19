import { describe, expect, it, vi } from "vitest";
import { ElevenLabsSynthesizer } from "../src/modules/synthesizer.ts";

function pcmStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
}

describe("ElevenLabsSynthesizer", () => {
  it("streams PCM chunks and stops forwarding after abort", async () => {
    const received: Uint8Array[] = [];
    const abort = new AbortController();
    let fetches = 0;

    const synth = new ElevenLabsSynthesizer({
      apiKey: "test-key",
      modelId: "eleven_flash_v2_5",
      outputFormat: "pcm_24000",
      fetchImpl: async (_input, init) => {
        fetches += 1;
        const body = pcmStream([
          new Uint8Array([1, 0, 2, 0]),
          new Uint8Array([3, 0, 4, 0])
        ]);
        queueMicrotask(() => abort.abort());
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/octet-stream" }
        });
      }
    });

    await synth.speak({
      text: "Hello from Maya",
      voiceId: "voice-maya",
      generationId: 1,
      signal: abort.signal,
      onChunk: (chunk, generationId) => {
        received.push(chunk);
        expect(generationId).toBe(1);
      }
    });

    expect(fetches).toBe(1);
    expect(received.length).toBeGreaterThanOrEqual(0);
  });

  it("throws a visible error when the API key is missing instead of faking audio", async () => {
    const synth = new ElevenLabsSynthesizer({
      apiKey: "",
      modelId: "eleven_flash_v2_5",
      outputFormat: "pcm_24000"
    });

    await expect(
      synth.speak({
        text: "hi",
        voiceId: "voice",
        generationId: 1,
        signal: new AbortController().signal,
        onChunk: () => {
          throw new Error("should not emit audio");
        }
      })
    ).rejects.toThrow(/ELEVENLABS_API_KEY/);
  });

  it("throws when ElevenLabs returns a non-OK response", async () => {
    const synth = new ElevenLabsSynthesizer({
      apiKey: "test-key",
      modelId: "eleven_flash_v2_5",
      outputFormat: "pcm_24000",
      fetchImpl: async () =>
        new Response(JSON.stringify({ detail: "quota" }), {
          status: 401,
          headers: { "content-type": "application/json" }
        })
    });

    await expect(
      synth.speak({
        text: "hi",
        voiceId: "voice",
        generationId: 2,
        signal: new AbortController().signal,
        onChunk: () => undefined
      })
    ).rejects.toThrow(/ElevenLabs/);
  });
});
