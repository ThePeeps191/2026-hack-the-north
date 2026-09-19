export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate) return input.slice();
  if (input.length === 0) return new Float32Array();
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const src = i * ratio;
    const i0 = Math.min(input.length - 1, Math.floor(src));
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = src - i0;
    const a = input[i0] ?? 0;
    const b = input[i1] ?? 0;
    out[i] = a * (1 - frac) + b * frac;
  }
  return out;
}

export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

export function float32ToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true);
  }
  return out;
}

export function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

export function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function encodeAudioFrame(generationId: number, pcm16: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + pcm16.byteLength);
  new DataView(out.buffer).setUint32(0, generationId, true);
  out.set(pcm16, 4);
  return out;
}

export function decodeAudioFrame(bytes: Uint8Array): { generationId: number; pcm16: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    generationId: view.getUint32(0, true),
    pcm16: bytes.subarray(4)
  };
}

export class Pcm16Assembler {
  private leftover: number | null = null;

  push(bytes: Uint8Array): Uint8Array {
    const pieces: number[] = [];
    let offset = 0;
    if (this.leftover != null && bytes.length > 0) {
      pieces.push(this.leftover, bytes[0] ?? 0);
      this.leftover = null;
      offset = 1;
    }
    const remaining = bytes.length - offset;
    const even = remaining & ~1;
    for (let i = 0; i < even; i += 1) {
      pieces.push(bytes[offset + i] ?? 0);
    }
    if ((remaining & 1) === 1) {
      this.leftover = bytes[offset + even] ?? 0;
    }
    return Uint8Array.from(pieces);
  }

  reset(): void {
    this.leftover = null;
  }
}
