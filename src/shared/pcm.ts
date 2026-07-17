// Pure PCM helpers. The audio worklet (src/renderer/public/pcm-worklet.js)
// carries its own copy of this logic because worklet modules can't import
// bundled code — keep the two in sync.

/**
 * Downsample mono Float32 samples to a lower rate using box averaging over
 * each output window (cheap anti-alias). Returns the input untouched when the
 * rates already match.
 */
export function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  if (fromRate < toRate) throw new Error(`cannot upsample ${fromRate} -> ${toRate}`);
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** Convert Float32 samples in [-1, 1] to 16-bit signed PCM (little-endian platform order). */
export function floatTo16BitPcm(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Root-mean-square level of a frame, for the input level meter. */
export function rms(input: Float32Array): number {
  if (input.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < input.length; i++) sum += input[i]! * input[i]!;
  return Math.sqrt(sum / input.length);
}
