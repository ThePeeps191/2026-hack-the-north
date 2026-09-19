// PCM helpers for the voice path.
//
// Ported from tools/voice-lab/src/modules/audio-util.ts (same function bodies,
// same names) and extended with the base64 helpers the helper line protocol
// needs, plus duration math for honest playback measurements.
//
// No parameter properties / enums here: this file is loaded by
// `node --experimental-strip-types --test`.

import { CAPTURE_SAMPLE_RATE } from '../../shared/voice.ts'

export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice()
  if (input.length === 0) return new Float32Array(0)
  const ratio = fromRate / toRate
  const outLength = Math.max(1, Math.round(input.length / ratio))
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i += 1) {
    const src = i * ratio
    const i0 = Math.min(input.length - 1, Math.floor(src))
    const i1 = Math.min(input.length - 1, i0 + 1)
    const frac = src - i0
    const a = input[i0] ?? 0
    const b = input[i1] ?? 0
    out[i] = a * (1 - frac) + b * frac
  }
  return out
}

/** Reads int16 little-endian bytes as floats in [-1, 1). */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = Math.floor(bytes.byteLength / 2)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getInt16(i * 2, true) / 32768
  }
  return out
}

export function float32ToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(i * 2, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true)
  }
  return out
}

export function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (const sample of samples) {
    sum += sample * sample
  }
  return Math.sqrt(sum / samples.length)
}

export function concatFloat32(chunks: readonly Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** Milliseconds of audio in `samples` at `sampleRate`. */
export function samplesToMs(samples: number, sampleRate: number): number {
  return sampleRate > 0 ? (samples / sampleRate) * 1000 : 0
}

export function msToSamples(ms: number, sampleRate: number): number {
  return Math.max(0, Math.round((ms / 1000) * sampleRate))
}

export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(out).set(bytes)
  return out
}

/** int16 mono bytes -> float32 at CAPTURE_SAMPLE_RATE, for the VAD and the segmenter. */
export function captureBytesToFloat32(bytes: Uint8Array): Float32Array {
  return pcm16ToFloat32(bytes)
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

export function base64ToBytes(text: string): Uint8Array {
  const buffer = Buffer.from(text, 'base64')
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

export function float32ToBase64(samples: Float32Array): string {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64')
}

export function base64ToFloat32(text: string): Float32Array {
  const buffer = Buffer.from(text, 'base64')
  // Copy into a fresh ArrayBuffer: a pooled Buffer offset is not guaranteed to
  // be 4-byte aligned, and a Float32Array view would throw on odd offsets.
  const copy = new Uint8Array(buffer.byteLength)
  copy.set(buffer)
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4))
}

/**
 * Keeps int16 sample alignment across chunk boundaries.
 *
 * Ported from the voice lab: a stream chunk may end on an odd byte, which would
 * otherwise shift every following sample by one byte.
 */
export class Pcm16Assembler {
  private leftover: number | null = null

  push(bytes: Uint8Array): Uint8Array {
    const pieces: number[] = []
    let offset = 0
    if (this.leftover != null && bytes.length > 0) {
      pieces.push(this.leftover, bytes[0] ?? 0)
      this.leftover = null
      offset = 1
    }
    const remaining = bytes.length - offset
    const even = remaining & ~1
    for (let i = 0; i < even; i += 1) {
      pieces.push(bytes[offset + i] ?? 0)
    }
    if ((remaining & 1) === 1) {
      this.leftover = bytes[offset + even] ?? 0
    }
    return Uint8Array.from(pieces)
  }

  reset(): void {
    this.leftover = null
  }
}

/** One VAD frame, so the framer and the engine agree on the frame size. */
export function frameSamplesMs(frameSamples: number): number {
  return samplesToMs(frameSamples, CAPTURE_SAMPLE_RATE)
}
