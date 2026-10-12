/**
 * The live preview's AudioWorklet for the voice changer effects that plain Web
 * Audio nodes can't play: PITCH (pitch / chipmunk / deep) and ROBOT. The
 * renderer (apps/desktop/src/audiograph.ts) loads {@link VOICE_WORKLET_SOURCE}
 * with audioWorklet.addModule() from a Blob URL, so it needs no file of its
 * own (no file:// module fetch in Electron, nothing for a CSP to resolve) and
 * builds one AudioWorkletNode per "pitch"/"robot" AudioNodeSpec (audio.ts),
 * passing the spec as processorOptions.
 *
 * Both effects are short-time Fourier transforms, latency = fft size − 128
 * samples (the render quantum), constant for the node's life:
 *
 *  - robot: the export's own maths — FFmpeg 4.4 afftfilt
 *    real='hypot(re,im)':imag='0' with win_size N, overlap 0.75: symmetric
 *    Hann analysis window (no synthesis window), every bin's phase zeroed, the
 *    inverse FFT scaled by 1/(N/2), overlap-added, ×(1 − overlap). Frames lie
 *    on the same hop grid, so after the first N samples the output equals the
 *    render's (delayed by the latency). Runs at the effect rate (48 kHz) when
 *    the context does; at another rate N is scaled to the nearest power of two.
 *  - pitch: a peak-locked phase vocoder (N 2048 at 48 kHz, 4× overlap,
 *    periodic Hann analysis + synthesis): each spectral peak's true frequency
 *    comes from its phase advance; the peak and the bins around it move by a
 *    whole number of bins to frequency × ratio, keeping their shape, level and
 *    relative phase. Pitch AND formants move and the length is unchanged, like
 *    the export's rubberband (a simpler shifter: transients smear a little).
 *
 * PURE data — no imports, no DOM types. The source is plain ES2020 JavaScript
 * in a string, never transpiled or minified by a bundler.
 */

/** The name the processor registers under. */
export const VOICE_WORKLET_PROCESSOR = "synthcut-voicefx";

/** processorOptions for one node (the "pitch" / "robot" AudioNodeSpec). */
export type VoiceWorkletOptions = { kind: "pitch"; ratio: number } | { kind: "robot"; win: number };

/** Samples of latency a node adds at a given fft size (the output starts this much later). */
export const voiceWorkletLatency = (fftSize: number): number => fftSize - 128;

/** FFT size the pitch shifter uses at 48 kHz (scaled with the context rate). */
export const PITCH_FFT_48K = 2048;

/** The effect rate the robot's window sizes are given in (AUDIO_FX_RATE). */
const REF_RATE = 48000;

export const VOICE_WORKLET_SOURCE = String.raw`
"use strict";
const TAU = Math.PI * 2;
const REF_RATE = ${REF_RATE};
const PITCH_FFT_48K = ${PITCH_FFT_48K};

/** Power of two nearest to x (at least 64). */
function pow2(x) {
  return Math.max(64, Math.pow(2, Math.round(Math.log2(Math.max(1, x)))));
}

/** Tables for an iterative radix-2 complex FFT of size n. */
function fftTables(n) {
  const levels = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0, x = i; b < levels; b++, x >>= 1) r = (r << 1) | (x & 1);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((TAU * i) / n);
    sin[i] = Math.sin((TAU * i) / n);
  }
  return { n: n, rev: rev, cos: cos, sin: sin };
}

/** In place. Forward: X_k = sum x_n e^(-2 pi i k n / N); inverse: unnormalised (+ sign). */
function fft(t, re, im, inverse) {
  const n = t.n;
  const rev = t.rev;
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let x = re[i]; re[i] = re[j]; re[j] = x;
      x = im[i]; im[i] = im[j]; im[j] = x;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = t.cos[k];
        const wi = inverse ? t.sin[k] : -t.sin[k];
        const a = i + j;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

/**
 * One channel of a streaming STFT: frames of n samples every hop samples on a
 * fixed grid, overlap-added; frame(re, im) turns the windowed input (re, im
 * zero) into the frame to add (re), and emit(acc, i) gives output sample i.
 */
function Stream(n, hop, frame, emitScale) {
  this.n = n;
  this.hop = hop;
  this.frame = frame;
  this.emitScale = emitScale;
  this.inBuf = new Float32Array(n);
  this.fill = 0;
  this.acc = new Float64Array(n);
  this.re = new Float64Array(n);
  this.im = new Float64Array(n);
  this.q = new Float32Array(hop + 256);
  this.qLen = 0;
}
Stream.prototype.push = function (x) {
  const n = this.n;
  const hop = this.hop;
  this.inBuf[n - hop + this.fill] = x;
  if (++this.fill < hop) return;
  this.fill = 0;
  const re = this.re;
  const im = this.im;
  for (let i = 0; i < n; i++) { re[i] = this.inBuf[i]; im[i] = 0; }
  this.frame(re, im);
  const acc = this.acc;
  for (let i = 0; i < n; i++) acc[i] += re[i];
  if (this.qLen + hop > this.q.length) {
    const bigger = new Float32Array(this.qLen + hop + 256);
    bigger.set(this.q.subarray(0, this.qLen));
    this.q = bigger;
  }
  for (let i = 0; i < hop; i++) this.q[this.qLen + i] = acc[i] * this.emitScale;
  this.qLen += hop;
  acc.copyWithin(0, hop);
  acc.fill(0, n - hop);
  this.inBuf.copyWithin(0, hop);
};
Stream.prototype.pull = function (out) {
  const m = Math.min(out.length, this.qLen);
  for (let i = 0; i < m; i++) out[i] = this.q[i];
  for (let i = m; i < out.length; i++) out[i] = 0;
  this.q.copyWithin(0, m, this.qLen);
  this.qLen -= m;
};

/** FFmpeg 4.4 afftfilt real='hypot(re,im)':imag='0', overlap 0.75 (see voiceworklet.ts). */
function robotStream(n) {
  const t = fftTables(n);
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 * (1 - Math.cos((TAU * i) / (n - 1)));
  const half = n / 2;
  const f = 1 / half;
  return new Stream(n, n / 4, function (re, im) {
    for (let i = 0; i < n; i++) re[i] *= win[i];
    fft(t, re, im, false);
    for (let k = 0; k <= half; k++) { re[k] = Math.hypot(re[k], im[k]); im[k] = 0; }
    for (let k = half + 1, x = half - 1; k < n; k++, x--) { re[k] = re[x]; im[k] = 0; }
    fft(t, re, im, true);
    for (let i = 0; i < n; i++) re[i] *= f;
  }, 0.25);
}

/**
 * Phase-vocoder pitch shift by ratio (length unchanged), peak-locked
 * (Laroche & Dolson): every spectral peak takes the bins around it (up to the
 * midpoint to the next peak) along, shifted by a whole number of bins so the
 * lobe keeps its shape and level; the peak's phase advances at its true
 * frequency x ratio and the bins around it keep their phase relative to it.
 */
function pitchStream(n, ratio) {
  const t = fftTables(n);
  const osamp = 4;
  const hop = n / osamp;
  const half = n / 2;
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 * (1 - Math.cos((TAU * i) / n));
  const expct = (TAU * hop) / n;
  const lastPh = new Float64Array(half + 1);
  const synPh = new Float64Array(half + 1);
  const prevSynPh = new Float64Array(half + 1);
  const mag = new Float64Array(half + 1);
  const ph = new Float64Array(half + 1);
  const frq = new Float64Array(half + 1);
  const outRe = new Float64Array(half + 1);
  const outIm = new Float64Array(half + 1);
  const peaks = new Int32Array(half + 1);
  // Periodic Hann applied twice, 4x overlap: the windows' squares sum to 1.5.
  const scale = 1 / (n * 1.5);
  return new Stream(n, hop, function (re, im) {
    for (let i = 0; i < n; i++) re[i] *= win[i];
    fft(t, re, im, false);
    let top = 0;
    for (let k = 0; k <= half; k++) {
      const p = Math.atan2(im[k], re[k]);
      let d = p - lastPh[k] - k * expct;
      lastPh[k] = p;
      d -= TAU * Math.round(d / TAU);
      mag[k] = Math.hypot(re[k], im[k]);
      ph[k] = p;
      frq[k] = k + (d * osamp) / TAU;
      if (mag[k] > top) top = mag[k];
    }
    let np = 0;
    const floor = top * 1e-6;
    for (let k = 1; k < half; k++) {
      if (mag[k] > floor && mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) peaks[np++] = k;
    }
    outRe.fill(0);
    outIm.fill(0);
    prevSynPh.set(synPh);
    for (let i = 0; i < np; i++) {
      const p = peaks[i];
      const lo = i === 0 ? 0 : ((peaks[i - 1] + p) >> 1) + 1;
      const hi = i === np - 1 ? half : (p + peaks[i + 1]) >> 1;
      const f = frq[p] * ratio;
      const shift = Math.round(f - p);
      const q = p + shift;
      if (q < 0 || q > half) continue;
      // The peak's new phase: last frame's phase at its new bin, advanced at its new frequency.
      let peakPh = prevSynPh[q] + expct * f;
      peakPh -= TAU * Math.round(peakPh / TAU);
      for (let k = lo; k <= hi; k++) {
        const j = k + shift;
        if (j < 0 || j > half) continue;
        const a = peakPh + ph[k] - ph[p];
        outRe[j] += mag[k] * Math.cos(a);
        outIm[j] += mag[k] * Math.sin(a);
      }
    }
    for (let k = 0; k <= half; k++) {
      re[k] = outRe[k];
      im[k] = outIm[k];
      synPh[k] = Math.atan2(outIm[k], outRe[k]);
    }
    im[0] = 0;
    im[half] = 0;
    for (let k = half + 1; k < n; k++) { re[k] = re[n - k]; im[k] = -im[n - k]; }
    fft(t, re, im, true);
    for (let i = 0; i < n; i++) re[i] *= win[i] * scale;
  }, 1);
}

class SynthCutVoiceFx extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const rate = typeof sampleRate === "number" ? sampleRate : REF_RATE;
    this.make = o.kind === "robot"
      ? (function (n) { return function () { return robotStream(n); }; })(pow2(((Number(o.win) || 1024) * rate) / REF_RATE))
      : (function (n, ratio) { return function () { return pitchStream(n, ratio); }; })(pow2((PITCH_FFT_48K * rate) / REF_RATE), Number(o.ratio) || 1);
    this.streams = [];
    this.alive = true;
    this.port.onmessage = (e) => { if (e.data === "stop") this.alive = false; };
  }
  process(inputs, outputs) {
    if (!this.alive) return false;
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    for (let c = 0; c < output.length; c++) {
      if (!this.streams[c]) this.streams[c] = this.make();
      const s = this.streams[c];
      const x = input.length ? input[Math.min(c, input.length - 1)] : null;
      const y = output[c];
      for (let i = 0; i < y.length; i++) s.push(x ? x[i] : 0);
      s.pull(y);
    }
    return true;
  }
}

registerProcessor(${JSON.stringify(VOICE_WORKLET_PROCESSOR)}, SynthCutVoiceFx);
`;
