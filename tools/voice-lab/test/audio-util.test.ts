import { describe, expect, it } from "vitest";
import {
  Pcm16Assembler,
  decodeAudioFrame,
  encodeAudioFrame,
  pcm16ToFloat32,
  resampleLinear,
  rmsLevel
} from "../src/modules/audio-util.ts";

describe("audio utilities", () => {
  it("resamples 48 kHz capture down to 16 kHz without changing duration", () => {
    const input = new Float32Array(480);
    for (let i = 0; i < input.length; i += 1) {
      input[i] = Math.sin((2 * Math.PI * i) / 48);
    }
    const output = resampleLinear(input, 48000, 16000);
    expect(output.length).toBe(160);
  });

  it("converts little-endian PCM16 to float32 in -1..1", () => {
    const bytes = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80]);
    const floats = pcm16ToFloat32(bytes);
    expect(floats[0]).toBe(0);
    expect(floats[1]).toBeCloseTo(1, 2);
    expect(floats[2]).toBeCloseTo(-1, 2);
  });

  it("reports a quiet RMS for silence and a higher RMS for a tone", () => {
    expect(rmsLevel(new Float32Array(160))).toBe(0);
    expect(rmsLevel(new Float32Array(160).fill(0.5))).toBeGreaterThan(0.4);
  });

  it("keeps a generation id on binary audio frames", () => {
    const framed = encodeAudioFrame(9, new Uint8Array([1, 2, 3, 4]));
    expect(decodeAudioFrame(framed)).toEqual({
      generationId: 9,
      pcm16: new Uint8Array([1, 2, 3, 4])
    });
  });

  it("reassembles PCM16 samples split across odd-sized network chunks", () => {
    const assembler = new Pcm16Assembler();
    expect(assembler.push(new Uint8Array([0x00]))).toEqual(new Uint8Array([]));
    expect(assembler.push(new Uint8Array([0x00, 0xff, 0x7f, 0x00]))).toEqual(
      new Uint8Array([0x00, 0x00, 0xff, 0x7f])
    );
    expect(assembler.push(new Uint8Array([0x80]))).toEqual(new Uint8Array([0x00, 0x80]));
  });
});


