export type SynthesizerOptions = {
  apiKey: string;
  modelId: string;
  outputFormat: "pcm_24000";
  fetchImpl?: typeof fetch;
};

export type SpeakRequest = {
  text: string;
  voiceId: string;
  generationId: number;
  signal: AbortSignal;
  onChunk: (chunk: Uint8Array, generationId: number) => void;
};

export class ElevenLabsSynthesizer {
  constructor(private readonly opts: SynthesizerOptions) {}

  async speak(request: SpeakRequest): Promise<void> {
    if (!this.opts.apiKey.trim()) {
      throw new Error(
        "ELEVENLABS_API_KEY is not set. Copy .env.example to .env and add a key. Microphone audio still stays local."
      );
    }

    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(request.voiceId)}/stream?output_format=${this.opts.outputFormat}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "xi-api-key": this.opts.apiKey,
          "Content-Type": "application/json",
          Accept: "application/octet-stream"
        },
        body: JSON.stringify({
          text: request.text,
          model_id: this.opts.modelId
        }),
        signal: request.signal
      });
    } catch (error) {
      if (request.signal.aborted) return;
      throw error;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`ElevenLabs streaming failed (${response.status}): ${body || response.statusText}`);
    }

    if (!response.body) return;
    const reader = response.body.getReader();
    try {
      while (!request.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        if (request.signal.aborted) break;
        if (value && value.byteLength > 0) {
          request.onChunk(value, request.generationId);
        }
      }
    } catch (error) {
      if (request.signal.aborted) return;
      throw error;
    } finally {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }
  }
}
