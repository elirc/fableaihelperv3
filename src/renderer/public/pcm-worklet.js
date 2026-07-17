// AudioWorklet processor: captures mono audio, downsamples to 16 kHz,
// converts to Int16, and posts ~128 ms frames (2048 samples) to the main
// thread along with an RMS level for the input meter.
//
// This mirrors the pure helpers in src/shared/pcm.ts (downsample /
// floatTo16BitPcm / rms) — worklet modules can't import bundled code, so the
// logic is duplicated here. Keep the two in sync.

const TARGET_RATE = 16000;
const FRAME_OUT = 2048; // output samples per posted frame (~128 ms)

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE; // `sampleRate` is the AudioContext rate
    this.frameIn = Math.round(FRAME_OUT * this.ratio);
    this.buf = new Float32Array(this.frameIn);
    this.filled = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let offset = 0;
    while (offset < ch.length) {
      const take = Math.min(ch.length - offset, this.frameIn - this.filled);
      this.buf.set(ch.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.frameIn) {
        this.emitFrame();
        this.filled = 0;
      }
    }
    return true;
  }

  emitFrame() {
    const input = this.buf;
    const mono = this.ratio === 1 ? input : this.downsample(input);
    const pcm = new Int16Array(mono.length);
    let sumSq = 0;
    for (let i = 0; i < mono.length; i++) {
      const s = Math.max(-1, Math.min(1, mono[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      sumSq += s * s;
    }
    const rms = mono.length ? Math.sqrt(sumSq / mono.length) : 0;
    this.port.postMessage({ pcm: pcm.buffer, rms }, [pcm.buffer]);
  }

  // Box averaging over each output window — cheap anti-alias filter.
  downsample(input) {
    const outLen = Math.floor(input.length / this.ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * this.ratio);
      const end = Math.min(Math.floor((i + 1) * this.ratio), input.length);
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      out[i] = end > start ? sum / (end - start) : 0;
    }
    return out;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
