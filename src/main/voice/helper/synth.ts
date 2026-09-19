// ElevenLabs streaming synthesis, inside the helper process.
//
// Ported from tools/voice-lab/src/modules/synthesizer.ts (same streaming reader
// and abort handling) and extended with the per-agent voice settings from
// `Agent.voice`: `speed`, `stability`, `similarityBoost`.
//
// The API key never leaves this process: it is passed in once on `init` over the
// private stdio pipe, is never written to stdout/stderr, and errors are reported
// without echoing the request headers.

import type { HelperVoiceSettings } from '../protocol.ts'

export type PcmOutputFormat = 'pcm_24000'

export interface SynthesizerOptions {
  apiKey: string
  modelId: string
  outputFormat: PcmOutputFormat
  fetchImpl?: typeof fetch
}

export interface SpeakRequest {
  text: string
  voice: HelperVoiceSettings
  signal: AbortSignal
  onChunk(chunk: Uint8Array): void
}

export interface SpeakResult {
  chars: number
  bytes: number
}

export class ElevenLabsSynthesizer {
  private readonly options: SynthesizerOptions

  constructor(options: SynthesizerOptions) {
    this.options = options
  }

  get hasKey(): boolean {
    return this.options.apiKey.trim().length > 0
  }

  async speak(request: SpeakRequest): Promise<SpeakResult> {
    if (!this.hasKey) {
      throw new Error(
        'ELEVENLABS_API_KEY is not set, so agent speech cannot be synthesized. Typed chat still works.'
      )
    }

    const fetchImpl = this.options.fetchImpl ?? fetch
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      request.voice.voiceId
    )}/stream?output_format=${this.options.outputFormat}`
    const body = {
      text: request.text,
      model_id: this.options.modelId,
      voice_settings: {
        stability: request.voice.stability,
        similarity_boost: request.voice.similarityBoost,
        use_speaker_boost: true,
        speed: request.voice.speed
      }
    }

    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'xi-api-key': this.options.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/octet-stream'
        },
        body: JSON.stringify(body),
        signal: request.signal
      })
    } catch (error) {
      if (request.signal.aborted) return { chars: 0, bytes: 0 }
      throw error
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const fix =
        response.status === 401
          ? 'Check ELEVENLABS_API_KEY in Settings.'
          : response.status === 404
            ? 'That voice id does not exist on this ElevenLabs account; pick another in Settings.'
            : undefined
      throw new ElevenLabsError(
        `ElevenLabs synthesis failed (${response.status} ${response.statusText})${
          detail ? `: ${sanitize(detail)}` : ''
        }`,
        fix ?? null
      )
    }

    let bytes = 0
    if (response.body) {
      const reader = response.body.getReader()
      try {
        while (!request.signal.aborted) {
          const { done, value } = await reader.read()
          if (done) break
          if (request.signal.aborted) break
          if (value && value.byteLength > 0) {
            bytes += value.byteLength
            request.onChunk(value)
          }
        }
      } catch (error) {
        if (!request.signal.aborted) throw error
      } finally {
        try {
          await reader.cancel()
        } catch {
          // Stream already closed.
        }
      }
    }

    return { chars: request.text.length, bytes }
  }
}

export class ElevenLabsError extends Error {
  readonly fix: string | null

  constructor(message: string, fix: string | null) {
    super(message)
    this.name = 'ElevenLabsError'
    this.fix = fix
  }
}

/** Bounded, single-line error detail. The key is never part of an API response. */
function sanitize(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > 300 ? `${single.slice(0, 300)}…` : single
}
