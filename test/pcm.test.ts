import { describe, expect, test } from 'vitest';
import { downsample, floatTo16BitPcm, rms } from '../src/shared/pcm';

describe('downsample', () => {
  test('returns input untouched when rates match', () => {
    const input = Float32Array.of(0.1, 0.2, 0.3);
    expect(downsample(input, 16000, 16000)).toBe(input);
  });

  test('halves length at a 2:1 ratio and keeps a constant signal constant', () => {
    const input = new Float32Array(1000).fill(0.5);
    const out = downsample(input, 32000, 16000);
    expect(out.length).toBe(500);
    expect(out[10]).toBeCloseTo(0.5, 6);
  });

  test('48k->16k gives ~1/3 length and averages windows', () => {
    // Ramp 0,1,2,...,5; averaging groups of 3 -> [1, 4]
    const out = downsample(Float32Array.of(0, 1, 2, 3, 4, 5), 48000, 16000);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(4, 6);
  });

  test('rejects upsampling', () => {
    expect(() => downsample(new Float32Array(4), 16000, 48000)).toThrow();
  });

  // 44.1 kHz is the other rate Windows hands us, and its ratio to 16 kHz is
  // 2.75625 — windows land on fractional boundaries and vary between 2 and 3
  // samples wide.
  test('handles a non-integer 44.1k->16k ratio without dropping or stretching the signal', () => {
    const input = new Float32Array(4410).fill(0.5);
    const out = downsample(input, 44100, 16000);
    expect(out.length).toBe(1600); // 100 ms in -> 100 ms out
    for (const s of out) expect(s).toBeCloseTo(0.5, 6);
  });

  test('never emits an empty window as a zero sample on a fractional ratio', () => {
    // Every output sample must average at least one real input sample; a zero
    // here would be an audible click rather than signal.
    const input = new Float32Array(441).fill(1);
    const out = downsample(input, 44100, 16000);
    expect(out.length).toBeGreaterThan(0);
    for (const s of out) expect(s).toBeCloseTo(1, 6);
  });

  // The point of box averaging: content above the output Nyquist must be
  // attenuated, not folded down into the speech band as a phantom tone.
  test('cancels a signal at the input Nyquist instead of aliasing it down', () => {
    // +1,-1,... at 32 kHz is a 16 kHz tone, far above the 8 kHz output Nyquist.
    // Naive decimation (every 2nd sample) would alias it to full-scale DC.
    const input = Float32Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? 1 : -1));
    const out = downsample(input, 32000, 16000);
    expect(out.length).toBe(32);
    for (const s of out) expect(Math.abs(s)).toBeLessThan(1e-6);
  });

  test('attenuates an out-of-band tone to 1/3 scale at 48k->16k', () => {
    const input = Float32Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 1 : -1));
    const out = downsample(input, 48000, 16000);
    for (const s of out) expect(Math.abs(s)).toBeCloseTo(1 / 3, 6);
  });

  test('does not mutate its input', () => {
    const input = Float32Array.of(0, 1, 2, 3, 4, 5);
    const before = Array.from(input);
    downsample(input, 48000, 16000);
    expect(Array.from(input)).toEqual(before);
  });
});

describe('floatTo16BitPcm', () => {
  test('maps full-scale values to int16 extremes and clamps overflow', () => {
    const out = floatTo16BitPcm(Float32Array.of(-1, 1, 0, -2, 2));
    expect(out[0]).toBe(-0x8000);
    expect(out[1]).toBe(0x7fff);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(-0x8000);
    expect(out[4]).toBe(0x7fff);
  });

  test('clamping never wraps around to the opposite rail', () => {
    // The asymmetric scale (0x8000 negative / 0x7fff positive) is what keeps
    // +1 from becoming 32768 and wrapping to -32768.
    for (const v of [1, 1.0001, 5, -1, -1.0001, -5, Infinity, -Infinity]) {
      const s = floatTo16BitPcm(Float32Array.of(v))[0]!;
      expect(s).toBeGreaterThanOrEqual(-0x8000);
      expect(s).toBeLessThanOrEqual(0x7fff);
      expect(Math.sign(s)).toBe(Math.sign(v));
    }
  });

  test('maps NaN to silence rather than a garbage sample', () => {
    expect(floatTo16BitPcm(Float32Array.of(NaN))[0]).toBe(0);
  });

  // Pins the rounding mode on purpose. Int16Array assignment truncates toward
  // zero, so 0.5 * 0x7fff = 16383.5 lands on 16383 where round-to-nearest would
  // give 16384. src/renderer/public/pcm-worklet.js — the copy that actually
  // encodes captured audio — does the identical arithmetic, and the two are
  // required to stay in sync. The bias is under 1 LSB (~90 dB below full
  // scale); if it is ever "fixed", both files have to move together.
  test('truncates toward zero, matching the capture worklet', () => {
    expect(floatTo16BitPcm(Float32Array.of(0.5))[0]).toBe(16383);
    expect(floatTo16BitPcm(Float32Array.of(0.99999))[0]).toBe(32766);
    expect(floatTo16BitPcm(Float32Array.of(-0.5))[0]).toBe(-16384); // exact, no truncation
  });

  test('emits little-endian bytes, which is what Deepgram linear16 expects', () => {
    // Int16Array uses platform byte order; every target this ships to (x64 and
    // arm64 Windows) is little-endian. This fails loudly on a big-endian host
    // rather than sending Deepgram byte-swapped noise.
    const bytes = new Uint8Array(floatTo16BitPcm(Float32Array.of(1)).buffer);
    expect(Array.from(bytes)).toEqual([0xff, 0x7f]); // 0x7fff, low byte first
  });

  test('preserves frame length', () => {
    expect(floatTo16BitPcm(new Float32Array(2048)).length).toBe(2048);
    expect(floatTo16BitPcm(new Float32Array(0)).length).toBe(0);
  });
});

describe('rms', () => {
  test('is zero for silence and matches a known signal', () => {
    expect(rms(new Float32Array(100))).toBe(0);
    expect(rms(Float32Array.of(0.5, -0.5, 0.5, -0.5))).toBeCloseTo(0.5, 6);
  });

  test('is zero for an empty frame', () => {
    expect(rms(new Float32Array(0))).toBe(0);
  });

  test('is 1 for a full-scale square wave and never negative', () => {
    expect(rms(Float32Array.of(1, -1, 1, -1))).toBeCloseTo(1, 6);
    expect(rms(Float32Array.of(-0.3, -0.3))).toBeCloseTo(0.3, 6);
  });
});
