/**
 * Per-clip AUDIO effects smoke test (no downloads). Synthesizes speech-like test
 * audio — a harmonic voice with sweeping vowel formants and a syllable rhythm,
 * normal / loud / quiet phrases separated by silent gaps, a pink-noise floor, a
 * 40 Hz rumble and "s" bursts — then EXPORTS short clips per effect and
 * measures them with FFmpeg decodes (RMS in windows, Goertzel tones, FFT band
 * energy, dominant frequency) and ebur128 (LUFS):
 *   - the registry: every effect's FFmpeg chain runs, keeps the onset (no A/V
 *     latency) and the clip's length; validation (clamp + adjusted, unknown
 *     params rejected, switches rounded);
 *   - noise_reduction lowers the gap floor, highpass removes a 40 Hz rumble,
 *     eq_presence lifts the 4 kHz band, de_esser tames the s-bursts, the
 *     compressor narrows loud vs quiet, normalize hits its LUFS target ±1,
 *     pitch +12 doubles the frequency without changing the length (rubberband
 *     AND the asetrate fallback), echo tails stop at the clip's end;
 *   - enhance_voice lowers the floor AND evens the level without clipping
 *     (peak < −0.5 dBFS);
 *   - bypassed effects are skipped; speed 2 keeps the pitch effect and halves
 *     the length; bleep mutes still silence the words (and the bleep SFX is
 *     not processed) with an audio effect present;
 *   - linked detached audio gets the effect, also through either half of a
 *     split linked pair; remove/reorder/undo;
 *   - telephone/megaphone export on mono, stereo, quad and 5.1 sources, also
 *     after enhance_voice with a bleep; exports at speed 0.5–3 (± effects,
 *     ± bleep) finish; video-only staging skips the loudness pass;
 *   - the segment cache key ignores audio effects while the segmented
 *     preview's audio pass has them.
 *
 * Run: npx tsx packages/core/scripts/smoke-voice.ts
 */
import { execa } from "execa";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EditorEngine } from "../src/engine.js";
import { methods } from "../src/rpc.js";
import { FFMPEG_BIN, runFfmpegCaptureStderr } from "../src/ffmpeg/executor.js";
import { planSegments, segmentKey } from "../src/ffmpeg/segments.js";
import { PREVIEW_PROFILE, previewCanvas } from "../src/ffmpeg/graph.js";
import {
  AUDIO_EFFECTS, audioEffectFilterSteps, audioPreviewPlan, validateAudioEffect,
} from "../src/effects/audio.js";
import type { AssetTranscript, Clip, ResolvedRenderClip, TranscriptWord } from "../src/types.js";

const SR = 48000;
const FPS = 30;

let failures = 0;
function check(cond: unknown, msg: string): void {
  if (cond) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.error(`  FAIL ${msg}`);
  }
}
const db = (x: number) => 20 * Math.log10(Math.max(1e-9, x));
const f1 = (n: number) => n.toFixed(1);

// ---- synthesis --------------------------------------------------------------

/** Mono float samples → 16-bit PCM WAV. */
function writeWav(path: string, x: Float32Array): void {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + x.length * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  writeFileSync(path, b);
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pink noise (Paul Kellet's filter), unit-ish RMS → scaled to `rmsDb`. */
function pink(n: number, rmsDb: number, seed = 1): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    const v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    out[i] = v;
    sum += v * v;
  }
  const g = Math.pow(10, rmsDb / 20) / Math.sqrt(sum / n);
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

/**
 * A speech-like voice: a 40-harmonic source on an intoning ~125 Hz pitch,
 * shaped by three sweeping vowel formants, gated by a 4 Hz syllable rhythm.
 * Returns unit-RMS-over-active-time samples for [t0, t1).
 */
function voice(n: number, phrases: Array<{ t0: number; t1: number; db: number }>): Float32Array {
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const ph = phrases.find((p) => t >= p.t0 && t < p.t1);
    const f0 = 125 + 15 * Math.sin(2 * Math.PI * 0.5 * t) + 8 * Math.sin(2 * Math.PI * 3.1 * t);
    phase += (2 * Math.PI * f0) / SR;
    if (!ph) continue;
    const F1 = 600 + 250 * Math.sin(2 * Math.PI * 1.7 * t);
    const F2 = 1500 + 600 * Math.sin(2 * Math.PI * 1.1 * t + 1);
    const F3 = 2600;
    let v = 0;
    for (let k = 1; k <= 40; k++) {
      const f = k * f0;
      if (f > 9000) break;
      const g = (F: number, bw: number) => Math.exp(-0.5 * ((f - F) / bw) ** 2);
      const a = (g(F1, 110) + 0.6 * g(F2, 160) + 0.3 * g(F3, 220) + 0.015) / Math.pow(k, 0.3);
      v += a * Math.sin(k * phase);
    }
    // Syllables: 4 Hz rhythm with soft on/off ramps at the phrase edges.
    const syl = 0.35 + 0.65 * Math.pow(0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * (t - ph.t0)), 0.7);
    const edge = Math.min(1, (t - ph.t0) / 0.05, (ph.t1 - t) / 0.05);
    out[i] = v * syl * edge * Math.pow(10, ph.db / 20) * 0.09;
  }
  return out;
}

/** High-passed noise bursts ("s" sounds): 80 ms at each time. */
function sBursts(n: number, times: number[], peakDb: number): Float32Array {
  const out = new Float32Array(n);
  const r = rng(7);
  let prev = 0;
  let prev2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const w = r() * 2 - 1;
    // Crude 2nd-difference high-pass (≈ +12 dB/oct) → energy around 6–12 kHz.
    const hp = w - 2 * prev + prev2;
    prev2 = prev;
    prev = w;
    const at = times.find((s) => t >= s && t < s + 0.08);
    if (at === undefined) continue;
    const env = Math.sin((Math.PI * (t - at)) / 0.08);
    out[i] = hp * 0.25 * env * Math.pow(10, peakDb / 20);
  }
  return out;
}

const mix = (...parts: Float32Array[]): Float32Array => {
  const out = new Float32Array(parts[0].length);
  for (const p of parts) for (let i = 0; i < out.length; i++) out[i] += p[i];
  return out;
};
const sine = (n: number, freq: number, ampDb: number, from = 0, to = n / SR): Float32Array => {
  const out = new Float32Array(n);
  const a = Math.pow(10, ampDb / 20);
  for (let i = Math.floor(from * SR); i < Math.min(n, Math.floor(to * SR)); i++) out[i] = a * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
};

/** Mux a WAV with a tiny gray picture into a lossless-audio .mkv the engine imports. */
async function makeClip(dir: string, name: string, x: Float32Array): Promise<string> {
  const wav = join(dir, `${name}.wav`);
  writeWav(wav, x);
  const out = join(dir, `${name}.mkv`);
  const dur = (x.length / SR).toFixed(3);
  await execa(FFMPEG_BIN, [
    "-hide_banner", "-y", "-f", "lavfi", "-i", `color=c=gray:s=160x90:r=${FPS}:d=${dur}`, "-i", wav,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest", out,
  ]);
  return out;
}

// ---- measurement ------------------------------------------------------------

const decodeCache = new Map<string, Float32Array>();
/** Whole-file mono 48 kHz float decode (cached). */
async function decode(file: string): Promise<Float32Array> {
  const hit = decodeCache.get(file);
  if (hit) return hit;
  const { stdout } = await execa(FFMPEG_BIN, ["-hide_banner", "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], {
    encoding: "buffer",
  });
  const b = Buffer.from(stdout as unknown as Uint8Array);
  const x = new Float32Array(b.length / 4);
  for (let i = 0; i < x.length; i++) x[i] = b.readFloatLE(i * 4);
  decodeCache.set(file, x);
  return x;
}
const slice = (x: Float32Array, t0: number, t1: number) => x.subarray(Math.max(0, Math.floor(t0 * SR)), Math.min(x.length, Math.floor(t1 * SR)));
function rmsDb(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return db(Math.sqrt(s / Math.max(1, x.length)));
}
function peakDb(x: Float32Array): number {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return db(p);
}
/** Amplitude of a pure tone (Goertzel / DFT bin). */
function toneAmp(x: Float32Array, freq: number): number {
  const w = (2 * Math.PI * freq) / SR;
  let re = 0;
  let im = 0;
  for (let i = 0; i < x.length; i++) {
    re += x[i] * Math.cos(w * i);
    im -= x[i] * Math.sin(w * i);
  }
  return (2 * Math.hypot(re, im)) / Math.max(1, x.length);
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const ai = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
      }
    }
  }
}
/** Average Hann-windowed power spectrum (N = 4096) of a window. */
function spectrum(x: Float32Array, N = 4096): Float64Array {
  const pow = new Float64Array(N / 2);
  let frames = 0;
  for (let off = 0; off + N <= x.length; off += N / 2) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[off + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    fft(re, im);
    for (let k = 0; k < N / 2; k++) pow[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  for (let k = 0; k < N / 2; k++) pow[k] /= Math.max(1, frames);
  return pow;
}
function bandDb(x: Float32Array, lo: number, hi: number): number {
  let N = 4096;
  while (N > 256 && N > x.length) N >>= 1; // short windows (an 80 ms "s") get a shorter FFT
  const p = spectrum(x, N);
  let s = 0;
  for (let k = Math.ceil((lo * N) / SR); k <= Math.floor((hi * N) / SR); k++) s += p[k];
  return 10 * Math.log10(Math.max(1e-20, s));
}
function dominantHz(x: Float32Array): number {
  const N = 8192;
  const p = spectrum(x, N);
  let best = 1;
  for (let k = 2; k < N / 2 - 1; k++) if (p[k] > p[best]) best = k;
  const [a, b, c] = [p[best - 1], p[best], p[best + 1]].map((v) => Math.log(v + 1e-30));
  const d = (a - c) / (2 * (a - 2 * b + c));
  return ((best + (Number.isFinite(d) ? d : 0)) * SR) / N;
}
/** Lag (seconds) of `y` behind `x` that best aligns them, searched within ±maxSec over [t0, t1). */
function lagSec(x: Float32Array, y: Float32Array, t0: number, t1: number, maxSec = 0.025): number {
  const a = Math.floor(t0 * SR);
  const n = Math.floor((t1 - t0) * SR);
  const L = Math.floor(maxSec * SR);
  let best = 0;
  let bestV = -Infinity;
  for (let lag = -L; lag <= L; lag++) {
    let v = 0;
    for (let i = 0; i < n; i++) v += x[a + i] * (y[a + i + lag] ?? 0);
    if (v > bestV) {
      bestV = v;
      best = lag;
    }
  }
  return best / SR;
}
/** First time |x| crosses `frac` of the file's peak. */
function onsetSec(x: Float32Array, frac = 0.25): number {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= p * frac) return i / SR;
  return NaN;
}
/** Run filter steps straight over a WAV (exact PCM, no codec) → samples. */
async function filtered(wav: string, steps: string[]): Promise<Float32Array> {
  const { stdout } = await execa(FFMPEG_BIN, ["-hide_banner", "-v", "error", "-i", wav, "-af", ["aresample=48000", ...steps].join(","), "-ac", "1", "-f", "f32le", "-"], {
    encoding: "buffer",
  });
  const b = Buffer.from(stdout as unknown as Uint8Array);
  const x = new Float32Array(b.length / 4);
  for (let i = 0; i < x.length; i++) x[i] = b.readFloatLE(i * 4);
  return x;
}
async function lufs(file: string): Promise<number> {
  const stderr = await runFfmpegCaptureStderr(["-hide_banner", "-i", file, "-vn", "-af", "ebur128", "-f", "null", "-"]);
  const m = [...stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)];
  return m.length ? Number(m[m.length - 1][1]) : NaN;
}
async function durationSec(file: string): Promise<number> {
  const { stdout } = await execa("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "csv=p=0", file]);
  return Number(stdout.trim());
}

// ---- the test ---------------------------------------------------------------

/** Test-voice layout (seconds). */
const NORMAL = { t0: 1, t1: 4.5, db: 0 };
const LOUD = { t0: 6, t1: 8, db: 12 };
const QUIET = { t0: 9.5, t1: 11.5, db: -12 };
const GAPS: Array<[number, number]> = [[0.2, 0.8], [4.75, 5.75], [8.25, 9.25]];
const S_TIMES = [2.05, 3.05, 4.05];

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "synthcut-voice-"));
  console.log(`work dir ${dir}`);

  // ---- registry (pure) --------------------------------------------------------
  console.log("registry");
  const v1 = validateAudioEffect({ type: "eq_presence", params: { gain: 40 } });
  check(v1.params?.gain === 12 && v1.adjusted.length === 1, `clamps gain 40 → 12 and reports it (${v1.adjusted[0]})`);
  let threw = "";
  try { validateAudioEffect({ type: "echo", params: { feedback: 0.5 } }); } catch (e) { threw = String(e); }
  check(/Unknown param "feedback" for echo\. Valid params: delay/.test(threw), "rejects an unknown param with the valid list");
  threw = "";
  try { validateAudioEffect({ type: "autotune" }); } catch (e) { threw = String(e); }
  check(/Unknown audio effect type "autotune"/.test(threw), "rejects an unknown type");
  const v2 = validateAudioEffect({ type: "enhance_voice", params: { denoise: 0.3 } });
  check(v2.params?.denoise === 0 && v2.adjusted.length === 1, "rounds a switch param to 0|1");
  check(audioEffectFilterSteps([{ type: "echo", enabled: false }]).length === 0, "bypassed effects build no filter");
  const pv = audioPreviewPlan([{ type: "highpass" }, { type: "noise_reduction" }, { type: "echo", enabled: false }, { type: "enhance_voice" }]);
  check(pv.nodes.length > 0 && pv.renderOnly.join() === "noise_reduction,enhance_voice", `preview plan: live nodes + render-only list (${pv.renderOnly.join()})`);
  const pp = audioPreviewPlan([{ type: "pitch", params: { semitones: 12 } }]);
  const pn = pp.nodes[0];
  check(pp.nodes.length === 1 && pn?.kind === "pitch" && Math.abs(pn.ratio - 2) < 1e-12 && pp.worklet && pp.approx.join() === "pitch" && pp.renderOnly.length === 0,
    "pitch previews live through the voice worklet (ratio 2 at +12 st, marked approximate)");
  const noW = audioPreviewPlan([{ type: "pitch" }, { type: "robot" }], { worklet: false });
  check(noW.nodes.length === 0 && noW.renderOnly.join() === "pitch,robot", "without the AudioWorklet pitch and robot are render-only");

  // ---- media --------------------------------------------------------------------
  console.log("synthesizing test media");
  const N = 12 * SR;
  const voiceSig = mix(
    voice(N, [NORMAL, LOUD, QUIET]),
    pink(N, -50, 3),
    sBursts(N, S_TIMES, -10),
  );
  const voicePath = await makeClip(dir, "voice", voiceSig);
  const rumblePath = await makeClip(dir, "rumble", mix(sine(4 * SR, 40, -16), sine(4 * SR, 1000, -20)));
  const noisePath = await makeClip(dir, "noise", pink(4 * SR, -20, 5));
  const tonePath = await makeClip(dir, "tone", sine(4 * SR, 440, -12, 1, 4)); // silence, then 440 Hz from t = 1

  const paths = { voice: voicePath, rumble: rumblePath, noise: noisePath, tone: tonePath };
  const newEngine = (): EditorEngine => {
    const e = new EditorEngine(dir);
    e.setProjectSettings({ width: 160, height: 90, fps: FPS, name: "voice-smoke" });
    return e;
  };
  let engine = newEngine();
  // Drive the tools exactly like the server: schema-validate, then run the handler.
  const call = async <T = unknown>(name: keyof typeof methods, params: Record<string, unknown> = {}): Promise<T> => {
    const m = methods[name];
    const parsed = (m.schema as { parse: (x: unknown) => unknown }).parse(params);
    return (await m.handler(engine, parsed as never)) as T;
  };
  const allClips = () => engine.getProject().tracks.flatMap((t) => t.clips);
  const cur = (id: string): Clip => allClips().find((c) => c.id === id)!;

  let outN = 0;
  /** Fresh project holding just one clip of `asset` with `filters` (and optional speed) → exported file. */
  const solo = async (
    asset: keyof typeof paths,
    filters: Array<{ type: string; params?: Record<string, number>; enabled?: boolean }>,
    opts: { speed?: number } = {},
  ): Promise<string> => {
    engine = newEngine();
    const a = await engine.importVideo(paths[asset]);
    const c = engine.addClip(a.id, { startFrame: 0 });
    for (const f of filters) await call("apply_audio_effect", { clipId: c.id, type: f.type, params: f.params, enabled: f.enabled });
    if (opts.speed) engine.setClipEffects(c.id, { speed: opts.speed });
    const out = join(dir, `out${++outN}.mp4`);
    await engine.exportVideo(out);
    return out;
  };

  // ---- every effect: runs, adds no latency, keeps the length ----------------------
  // Tone onset (silence → 440 Hz at t = 1 s) for every type; plus, for every
  // type that keeps the waveform's timing (not the pitch shifters / robot),
  // the cross-correlation lag against the dry voice — an envelope change can
  // move a threshold onset, only a real delay moves the correlation peak.
  console.log("every effect runs, adds no latency, keeps the length");
  const dry = await solo("tone", []);
  const dryOnset = onsetSec(await decode(dry));
  const dryDur = await durationSec(dry);
  const dryVoice = await solo("voice", []);
  const xv = await decode(dryVoice);
  const RETIMES = new Set(["pitch", "chipmunk", "deep", "robot"]);
  for (const d of AUDIO_EFFECTS) {
    const t0 = Date.now();
    const out = await solo("tone", [{ type: d.type }]);
    const on = onsetSec(await decode(out), d.type === "robot" ? 0.15 : 0.25);
    const dur = await durationSec(out);
    let lagNote = "";
    let lagOk = true;
    if (!RETIMES.has(d.type)) {
      const lag = lagSec(xv, await decode(await solo("voice", [{ type: d.type }])), 1.5, 2.5);
      lagOk = Math.abs(lag) <= 0.006;
      lagNote = `, voice lag ${f1(lag * 1000)} ms`;
    }
    check(
      Math.abs(on - dryOnset) <= 0.025 && Math.abs(dur - dryDur) <= 0.05 && lagOk,
      `${d.type}: onset ${f1((on - dryOnset) * 1000)} ms${lagNote}, length ${dur.toFixed(2)} s (dry ${dryDur.toFixed(2)}) [${Date.now() - t0} ms]`,
    );
  }

  // ---- every option string FFmpeg can be handed: each param at its min and max ------
  // (defaults alone leave branches untested: eq_custom's shelves, the denoiser's
  // pre-attenuation for loud floors and its heavy pass, robot tones, leveller…)
  console.log("every effect at its param extremes (PCM, FFmpeg accepts it, length kept)");
  const voiceWav = join(dir, "voice.wav");
  const wavLen = (await filtered(voiceWav, [])).length;
  for (const d of AUDIO_EFFECTS) {
    for (const end of ["min", "max"] as const) {
      const params = Object.fromEntries(d.params.map((p) => [p.key, p[end]]));
      if (d.type === "noise_reduction" || d.type === "enhance_voice") params.floor = end === "min" ? -90 : -25; // quiet / loud floor branches
      let ok = false;
      let note = "";
      try {
        const steps = audioEffectFilterSteps([{ id: "x", type: d.type, params }]);
        const y = await filtered(voiceWav, steps);
        // Never shorter (echo/reverb tails may run longer — graph.ts trims those to the clip).
        ok = y.length >= wavLen - 0.05 * SR && y.every(Number.isFinite);
        note = `${(y.length / SR).toFixed(2)} s`;
      } catch (e) {
        note = String(e).slice(0, 200);
      }
      check(ok, `${d.type} @ ${end} ${JSON.stringify(params)}: ${note}`);
    }
  }
  check(audioEffectFilterSteps([{ type: "eq_custom", params: { low: 3, mid: -2, high: 4 } }]).length === 3, "eq_custom emits its three bands when non-zero");

  // ---- cleanup ---------------------------------------------------------------------
  console.log("cleanup");
  const gapDb = (x: Float32Array) => Math.max(...GAPS.map(([a, b]) => rmsDb(slice(x, a, b))));
  const dryFloor = gapDb(xv);
  check(peakDb(xv) < -1, `test voice: peak ${f1(peakDb(xv))} dBFS, floor ${f1(dryFloor)} dB, loud−quiet ${f1(rmsDb(slice(xv, 6.2, 7.8)) - rmsDb(slice(xv, 9.7, 11.3)))} dB`);
  const nrPath = await solo("voice", [{ type: "noise_reduction" }]);
  const nrFx = cur(allClips()[0].id).effects!.audioFilters![0];
  check(Math.abs((nrFx.params?.floor ?? 0) - -50) <= 3, `noise_reduction measured the clip's noise floor (${nrFx.params?.floor} dBFS, synthesized at −50)`);
  const nr = await decode(nrPath);
  const nrFloor = gapDb(nr);
  check(dryFloor - nrFloor >= 10, `noise_reduction lowers the gap floor ${f1(dryFloor)} → ${f1(nrFloor)} dB (≥ 10 dB)`);
  const speechDelta = rmsDb(slice(nr, 1.2, 4.3)) - rmsDb(slice(xv, 1.2, 4.3));
  check(Math.abs(speechDelta) <= 1.5, `…while the speech level holds (${f1(speechDelta)} dB)`);
  const quietDelta = rmsDb(slice(nr, QUIET.t0 + 0.2, QUIET.t1 - 0.2)) - rmsDb(slice(xv, QUIET.t0 + 0.2, QUIET.t1 - 0.2));
  check(quietDelta >= -3, `…and quiet speech (only ~12 dB above the noise) loses at most 3 dB (${f1(quietDelta)} dB)`);

  const xr = await decode(await solo("rumble", []));
  const hp = await decode(await solo("rumble", [{ type: "highpass", params: { frequency: 80 } }]));
  const r40 = db(toneAmp(slice(hp, 0.5, 3.5), 40)) - db(toneAmp(slice(xr, 0.5, 3.5), 40));
  const r1k = db(toneAmp(slice(hp, 0.5, 3.5), 1000)) - db(toneAmp(slice(xr, 0.5, 3.5), 1000));
  check(r40 <= -20 && Math.abs(r1k) <= 0.5, `highpass 80 Hz: 40 Hz rumble ${f1(r40)} dB (≤ −20), 1 kHz ${f1(r1k)} dB`);

  const sDry = Math.max(...S_TIMES.map((s) => bandDb(slice(xv, s, s + 0.08), 5000, 12000)));
  const ds = await decode(await solo("voice", [{ type: "de_esser", params: { amount: 0.5 } }]));
  const sDs = Math.max(...S_TIMES.map((s) => bandDb(slice(ds, s, s + 0.08), 5000, 12000)));
  check(sDry - sDs >= 3, `de_esser tames the s-bursts by ${f1(sDry - sDs)} dB (≥ 3)`);

  // ---- tone -----------------------------------------------------------------------
  console.log("tone");
  const xn = await decode(await solo("noise", []));
  const pres = await decode(await solo("noise", [{ type: "eq_presence", params: { gain: 6, frequency: 4000 } }]));
  const b4k = bandDb(slice(pres, 0.5, 3.5), 3700, 4300) - bandDb(slice(xn, 0.5, 3.5), 3700, 4300);
  const b500 = bandDb(slice(pres, 0.5, 3.5), 400, 600) - bandDb(slice(xn, 0.5, 3.5), 400, 600);
  check(b4k >= 4.5 && Math.abs(b500) <= 0.5, `eq_presence +6 dB @4k: 4 kHz band ${f1(b4k)} dB, 500 Hz ${f1(b500)} dB`);
  const bass = await decode(await solo("noise", [{ type: "bass_boost", params: { gain: 6, frequency: 100 } }]));
  const b60 = bandDb(slice(bass, 0.5, 3.5), 40, 70) - bandDb(slice(xn, 0.5, 3.5), 40, 70);
  check(b60 >= 4.5, `bass_boost +6 dB: 40–70 Hz band ${f1(b60)} dB`);

  // ---- dynamics ---------------------------------------------------------------------
  console.log("dynamics");
  const spread = (x: Float32Array) => rmsDb(slice(x, LOUD.t0 + 0.2, LOUD.t1 - 0.2)) - rmsDb(slice(x, QUIET.t0 + 0.2, QUIET.t1 - 0.2));
  const drySpread = spread(xv);
  const comp = await decode(await solo("voice", [{ type: "compressor", params: { threshold: -30, ratio: 6, makeup: 6 } }]));
  check(drySpread - spread(comp) >= 6, `compressor narrows loud vs quiet ${f1(drySpread)} → ${f1(spread(comp))} dB (≥ 6 dB less)`);
  const limFx = [{ type: "limiter", params: { ceiling: -6, drive: 6 } }];
  const limPcm = await filtered(join(dir, "voice.wav"), audioEffectFilterSteps(limFx));
  check(peakDb(limPcm) <= -5.9, `limiter holds a −6 dB ceiling with +6 dB drive (PCM peak ${f1(peakDb(limPcm))} dBFS)`);
  const lim = await decode(await solo("voice", limFx));
  const limGain = rmsDb(slice(lim, NORMAL.t0 + 0.2, NORMAL.t1 - 0.2)) - rmsDb(slice(xv, NORMAL.t0 + 0.2, NORMAL.t1 - 0.2));
  check(peakDb(lim) <= -3.5 && limGain >= 3, `…and in the AAC export (peak ${f1(peakDb(lim))} dBFS incl. codec overshoot, speech +${f1(limGain)} dB)`);
  for (const target of [-16, -23]) {
    const out = await solo("voice", [{ type: "normalize", params: { target } }]);
    const L = await lufs(out);
    check(Math.abs(L - target) <= 1, `normalize to ${target} LUFS → ${f1(L)} LUFS (±1)`);
  }

  // ---- voice changer ------------------------------------------------------------------
  console.log("voice changer");
  const xt = await decode(dry);
  check(Math.abs(dominantHz(slice(xt, 1.2, 3.8)) - 440) < 3, `dry tone is 440 Hz (${f1(dominantHz(slice(xt, 1.2, 3.8)))})`);
  for (const fallback of [false, true]) {
    if (fallback) process.env.AIVE_NO_RUBBERBAND = "1";
    const out = await solo("tone", [{ type: "pitch", params: { semitones: 12 } }]);
    const x = await decode(out);
    const hz = dominantHz(slice(x, 1.2, 3.8));
    const dur = await durationSec(out);
    check(Math.abs(hz - 880) < 6 && Math.abs(dur - dryDur) <= 0.05, `pitch +12${fallback ? " (asetrate fallback)" : " (rubberband)"}: ${f1(hz)} Hz, ${dur.toFixed(2)} s`);
    const deep = await decode(await solo("tone", [{ type: "deep", params: { semitones: -5 } }]));
    const want = 440 * Math.pow(2, -5 / 12);
    check(Math.abs(dominantHz(slice(deep, 1.2, 3.8)) - want) < 4, `deep −5${fallback ? " (fallback)" : ""}: ${f1(dominantHz(slice(deep, 1.2, 3.8)))} Hz (want ${f1(want)})`);
    delete process.env.AIVE_NO_RUBBERBAND;
  }
  const fast = await solo("tone", [{ type: "pitch", params: { semitones: 12 } }], { speed: 2 });
  const xf = await decode(fast);
  const fastDur = await durationSec(fast);
  check(Math.abs(dominantHz(slice(xf, 0.6, 1.9)) - 880) < 6 && Math.abs(fastDur - dryDur / 2) <= 0.06,
    `speed 2 keeps pitch +12 (${f1(dominantHz(slice(xf, 0.6, 1.9)))} Hz) and halves the length (${fastDur.toFixed(2)} s)`);
  const fastEq = await decode(await solo("noise", [{ type: "eq_presence", params: { gain: 6, frequency: 4000 } }], { speed: 2 }));
  const fastB4k = bandDb(slice(fastEq, 0.3, 1.7), 3700, 4300) - bandDb(slice(fastEq, 0.3, 1.7), 1700, 2300);
  const slowB4k = bandDb(slice(pres, 0.5, 3.5), 3700, 4300) - bandDb(slice(pres, 0.5, 3.5), 1700, 2300);
  check(Math.abs(fastB4k - slowB4k) <= 1.5, `speed 2 leaves the EQ at 4 kHz (tilt ${f1(fastB4k)} vs ${f1(slowB4k)} dB)`);

  const byp = await decode(await solo("tone", [{ type: "pitch", params: { semitones: 12 }, enabled: false }]));
  check(Math.abs(dominantHz(slice(byp, 1.2, 3.8)) - 440) < 3, "a bypassed effect is skipped (still 440 Hz)");

  const echoed = await decode(await solo("tone", [{ type: "echo", params: { delay: 500, decay: 0.8 } }]));
  check(Math.abs(echoed.length / SR - dryDur) <= 0.05, `echo tail is cut at the clip's end (${(echoed.length / SR).toFixed(2)} s)`);

  // ---- enhance_voice --------------------------------------------------------------------
  console.log("enhance_voice");
  for (const strength of [0.4, 0.7, 1]) {
    engine = newEngine();
    const a = await engine.importVideo(paths.voice);
    const c = engine.addClip(a.id, { startFrame: 0 });
    await call("enhance_voice", { clipId: c.id, strength });
    const out = join(dir, `enh${strength}.mp4`);
    await engine.exportVideo(out);
    const x = await decode(out);
    const floor = gapDb(x);
    const sp = spread(x);
    const speech = rmsDb(slice(x, NORMAL.t0 + 0.2, NORMAL.t1 - 0.2));
    const pk = peakDb(x);
    const L = await lufs(out);
    console.log(`     strength ${strength}: floor ${f1(dryFloor)} → ${f1(floor)} dB, loud−quiet ${f1(drySpread)} → ${f1(sp)} dB, speech ${f1(speech)} dBFS, peak ${f1(pk)} dBFS, ${f1(L)} LUFS`);
    check((speech - floor) - (rmsDb(slice(xv, NORMAL.t0 + 0.2, NORMAL.t1 - 0.2)) - dryFloor) >= 6, `enhance ${strength}: speech-to-floor ratio improves ≥ 6 dB`);
    check(drySpread - sp >= 8, `enhance ${strength}: evens loud vs quiet by ≥ 8 dB`);
    check(pk < -0.5, `enhance ${strength}: no clipping (peak ${f1(pk)} < −0.5 dBFS)`);
    check(Math.abs(L - -16) <= 1, `enhance ${strength}: −16 LUFS ±1 (${f1(L)})`);
  }

  // ---- engine: linked audio, remove / reorder / undo ------------------------------------
  console.log("engine");
  engine = newEngine();
  const toneAsset = await engine.importVideo(paths.tone);
  const vClip = engine.addClip(toneAsset.id, { startFrame: 0 });
  const rev0 = engine.getProject().revision;
  const r1 = await call<{ effectId: string; clipId: string; adjusted?: string[] }>("apply_audio_effect", { clipId: vClip.id, type: "echo", params: { delay: 5000 } });
  check(r1.clipId === vClip.id && !!r1.adjusted?.length && cur(vClip.id).effects?.audioFilters?.[0].params?.delay === 1000, "apply_audio_effect clamps and stores on the clip");
  const r2 = await call<{ effectId: string }>("apply_audio_effect", { clipId: vClip.id, type: "noise_reduction" });
  const r3 = await call<{ effectId: string }>("enhance_voice", { clipId: vClip.id, strength: 0.5 });
  const order = () => (cur(vClip.id).effects?.audioFilters ?? []).map((f) => f.type).join(",");
  check(order() === "enhance_voice,noise_reduction,echo", `new effects slot in at signal-chain position (${order()})`);
  check(engine.getProject().revision === rev0 + 3, "one undo step per call");
  await call("enhance_voice", { clipId: vClip.id, normalize: false });
  const ev = cur(vClip.id).effects!.audioFilters!.find((f) => f.id === r3.effectId)!;
  check(ev.params?.strength === 0.5 && ev.params?.normalize === 0 && ev.params?.denoise === 1, "enhance_voice updates in place, keeping omitted options");
  await call("reorder_audio_effect", { clipId: vClip.id, effectId: r1.effectId, toIndex: 0 });
  check(order() === "echo,enhance_voice,noise_reduction", `reorder_audio_effect (${order()})`);
  await call("apply_audio_effect", { clipId: vClip.id, type: "echo", effectId: r1.effectId, enabled: false });
  const e1 = cur(vClip.id).effects!.audioFilters![0];
  check(e1.enabled === false && e1.params?.delay === 1000, "a bare enabled:false bypasses and keeps the params");
  await call("remove_audio_effect", { clipId: vClip.id, effectId: r2.effectId });
  check(order() === "echo,enhance_voice", "remove_audio_effect");
  engine.undo();
  check(order() === "echo,enhance_voice,noise_reduction", "undo restores the removed effect");
  for (let i = 0; i < 6; i++) engine.undo();
  check(!cur(vClip.id).effects?.audioFilters, "undo back to no audio effects");
  threw = "";
  try { await call("remove_audio_effect", { clipId: vClip.id, effectId: "afx_nope" }); } catch (e) { threw = String(e); }
  check(/not found on clip/.test(threw), "unknown effectId → teaching error");

  // Linked detached audio: the effect lands on the clip that carries the sound.
  const aTrack = engine.addTrack("audio");
  const aClip = engine.addClip(toneAsset.id, { trackIndex: aTrack.index, startFrame: 0 });
  engine.linkClips([vClip.id, aClip.id]);
  engine.setClipEffects(vClip.id, { volume: 0 });
  const rl = await call<{ clipId: string; note?: string; effectId: string }>("apply_audio_effect", { clipId: vClip.id, type: "pitch", params: { semitones: 12 } });
  check(rl.clipId === aClip.id && /linked clip/.test(rl.note ?? "") && !cur(vClip.id).effects?.audioFilters, `linked audio: applied to ${rl.clipId} with a note`);
  const lout = join(dir, "linked.mp4");
  await engine.exportVideo(lout);
  check(Math.abs(dominantHz(slice(await decode(lout), 1.2, 3.8)) - 880) < 6, "linked audio clip exports pitched");
  await call("remove_audio_effect", { clipId: vClip.id, effectId: rl.effectId });
  check(!cur(aClip.id).effects?.audioFilters, "remove via the video clip finds the linked effect");

  // After a split all four halves share one link group (and the audio halves
  // share the effect ids): edits through a video half reach ITS audio half.
  const tel = await call<{ clipId: string; effectId: string }>("apply_audio_effect", { clipId: vClip.id, type: "telephone" });
  const halves = engine.splitClip(vClip.id, 60);
  const audioHalf = (start: number) => engine.getProject().tracks.find((t) => t.index === aTrack.index && t.kind === "audio")!.clips.find((c) => c.startFrame === start)!;
  const aLeft = audioHalf(0).id;
  const aRight = audioHalf(60).id;
  const types = (id: string) => (cur(id).effects?.audioFilters ?? []).map((f) => f.type).join(",");
  check(tel.clipId === aClip.id && types(aLeft) === "telephone" && types(aRight) === "telephone", "split: both audio halves keep the telephone effect");
  await call("remove_audio_effect", { clipId: halves.right, effectId: tel.effectId });
  check(types(aRight) === "" && types(aLeft) === "telephone", `split: remove via the RIGHT video half removes the right audio half's copy (left ${types(aLeft)}, right ${types(aRight) || "none"})`);
  const viaRight = await call<{ clipId: string }>("apply_audio_effect", { clipId: halves.right, type: "echo" });
  check(viaRight.clipId === aRight, `split: apply via the right video half lands on the right audio half (${viaRight.clipId})`);
  const enhRight = await call<{ clipId: string }>("enhance_voice", { clipId: halves.right });
  const enhLeft = await call<{ clipId: string }>("enhance_voice", { clipId: halves.left });
  check(enhRight.clipId === aRight && enhLeft.clipId === aLeft, "split: enhance_voice via each video half goes to its own audio half");
  check(types(aLeft) === "enhance_voice,telephone" && types(aRight) === "enhance_voice,echo", `split: stacks stay per half (left ${types(aLeft)}; right ${types(aRight)})`);

  // Adjustment layers are refused.
  const adj = engine.addAdjustmentClip({ startFrame: 0, durationFrames: 30 });
  threw = "";
  try { await call("apply_audio_effect", { clipId: adj.id, type: "echo" }); } catch (e) { threw = String(e); }
  check(/adjustment layer/.test(threw), "adjustment layers are refused with a teaching error");

  // ---- channel layouts + speed: the export negotiates and finishes ----------------------
  // The soft clip (telephone/megaphone) must negotiate any channel layout, also
  // after enhance_voice and with a bleep's mix; effect chains in front of
  // atempo must not stall the export graph. Every export has a deadline.
  console.log("channel layouts + speed (the export negotiates and finishes)");
  const layoutClip = async (layout: string): Promise<string> => {
    const out = join(dir, `tone_${layout.replace(".", "_")}.mkv`);
    await execa(FFMPEG_BIN, [
      "-hide_banner", "-y", "-f", "lavfi", "-i", `color=c=gray:s=160x90:r=${FPS}:d=4`, "-f", "lavfi", "-i", `sine=f=440:d=4:sample_rate=${SR}`,
      "-af", `volume=2,aformat=channel_layouts=${layout}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest", out,
    ]);
    return out;
  };
  /** One clip of `media`, `setup` applied, exported within `ms` (a stalled graph is canceled and reported). */
  const exportWithin = async (media: string, setup: (clipId: string) => Promise<void>, ms = 60000): Promise<{ out?: string; err?: string }> => {
    engine = newEngine();
    const a = await engine.importVideo(media);
    const c = engine.addClip(a.id, { startFrame: 0 });
    await setup(c.id);
    const out = join(dir, `out${++outN}.mp4`);
    const { job, promise } = engine.startExportJob(out);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; engine.jobs.cancel(job.id); }, ms);
    try {
      await promise;
      return { out };
    } catch (e) {
      return { err: timedOut ? `stalled (canceled after ${ms / 1000} s)` : String(e).split("\n").find((l) => /Cannot|Error|failed/i.test(l))?.slice(0, 160) ?? String(e) };
    } finally {
      clearTimeout(timer);
    }
  };
  const channels = async (file: string): Promise<number> =>
    Number((await execa("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", file])).stdout.trim());
  const layouts: Array<[string, number]> = [["mono", 1], ["stereo", 2], ["quad", 4], ["5.1", 6]];
  for (const [layout, nch] of layouts) {
    const media = await layoutClip(layout);
    for (const type of ["telephone", "megaphone"]) {
      const r = await exportWithin(media, async (id) => { await call("apply_audio_effect", { clipId: id, type }); });
      const ch = r.out ? await channels(r.out) : 0;
      const lvl = r.out ? rmsDb(slice(await decode(r.out), 0.5, 3.5)) : -999;
      check(!!r.out && ch === nch && lvl > -30, `${layout} ${type}: exports (${r.err ?? `${ch} ch, ${f1(lvl)} dBFS`})`);
    }
    const combo = await exportWithin(media, async (id) => {
      await call("enhance_voice", { clipId: id });
      await call("apply_audio_effect", { clipId: id, type: "telephone" });
      await call("add_bleep", { clipId: id, start: 1, end: 1.5 });
    });
    check(!!combo.out, `${layout} enhance_voice + telephone + bleep: exports (${combo.err ?? "ok"})`);
  }

  // Speed: atempo after an effect chain made FFmpeg 4.4's amix stall at the end
  // of the export (it never finished) — also for a plain clip at speed 3.
  const monoTone = await layoutClip("mono");
  const speedCases: Array<[string, number, boolean]> = [
    ["none", 3, false], ["none", 3, true], ["robot", 1.5, false], ["robot", 0.5, true], ["declick", 2, false],
    ["noise_reduction", 2, true], ["highpass", 3, false], ["echo", 3, false], ["megaphone", 1.5, false], ["enhance_voice", 2, true],
  ];
  for (const [type, speed, bleep] of speedCases) {
    const r = await exportWithin(monoTone, async (id) => {
      if (type !== "none") await call("apply_audio_effect", { clipId: id, type });
      if (bleep) await call("add_bleep", { clipId: id, start: 1, end: 1.5 });
      engine.setClipEffects(id, { speed });
    }, 30000);
    const dur = r.out ? await durationSec(r.out) : 0;
    check(!!r.out && Math.abs(dur - 4 / speed) <= 0.06, `${type}${bleep ? " + bleep" : ""} at speed ${speed}: export finishes (${r.err ?? `${dur.toFixed(2)} s`})`);
  }

  // Video-only renders (get_frame, segments) skip the loudness measurement.
  engine = newEngine();
  const lAsset = await engine.importVideo(paths.voice);
  const lClip = engine.addClip(lAsset.id, { startFrame: 0 });
  await call("enhance_voice", { clipId: lClip.id });
  type Staged = { clips: ResolvedRenderClip[] };
  const stageWith = (o?: { audio?: boolean }) =>
    (engine as unknown as { stageRender(c: EditorEngine["canvas"], o?: { audio?: boolean }): Promise<Staged> }).stageRender(engine.canvas, o);
  const vOnly = await stageWith({ audio: false });
  const withAudio = await stageWith();
  const segKeys = (s: Staged) => planSegments(s.clips, 12).map((g) => segmentKey(s.clips, g, previewCanvas({ width: 160, height: 90, fps: FPS }), PREVIEW_PROFILE, {}, null)).join();
  check(!vOnly.clips[0].effects?.loudness && !!vOnly.clips[0].effects?.audioFilters?.length && !!withAudio.clips[0].effects?.loudness,
    "video-only staging skips the loudness measurement (export/preview staging measures)");
  check(segKeys(vOnly) === segKeys(withAudio), "segment keys are the same with or without the measurement");

  // ---- bleeps still mute with an audio effect present -------------------------------------
  console.log("bleeps + audio effects");
  engine = newEngine();
  const bleepSrc = await makeClip(dir, "bleepsrc", sine(6 * SR, 440, -12));
  const bAsset = await engine.importVideo(bleepSrc);
  const bClip = engine.addClip(bAsset.id, { startFrame: 0 });
  const WORDS: TranscriptWord[] = [
    { text: "hello", start: 0.5, end: 0.8 },
    { text: "fucking", start: 1.0, end: 1.4 },
    { text: "class", start: 2.0, end: 2.3 },
    { text: "s**t", start: 3.0, end: 3.3 },
  ];
  const transcript: AssetTranscript = { segments: [{ start: 0, end: 6, text: WORDS.map((x) => x.text).join(" ") }], words: WORDS, model: "fake", language: "en" };
  (engine as unknown as { setCachedTranscript(id: string, t: AssetTranscript): void }).setCachedTranscript(bAsset.id, transcript);
  await call("bleep_words", { clipIds: [bClip.id] });
  await call("apply_audio_effect", { clipId: bClip.id, type: "pitch", params: { semitones: 12 } });
  const bout = join(dir, "bleeped.mp4");
  await engine.exportVideo(bout);
  const xb = await decode(bout);
  for (const [a, b] of [[0.94, 1.48], [2.94, 3.38]] as Array<[number, number]>) {
    const w = slice(xb, a + 0.05, b - 0.05);
    const t880 = toneAmp(w, 880);
    const t1k = toneAmp(w, 1000);
    check(t880 < 0.01 && t1k > 0.1, `bleep ${a}–${b}: pitched voice muted (${t880.toFixed(4)}), SFX unprocessed at 1 kHz (${t1k.toFixed(3)})`);
  }
  check(Math.abs(dominantHz(slice(xb, 1.6, 2.8)) - 880) < 6 && rmsDb(slice(xb, 1.6, 2.8)) > -20, `outside the bleeps the voice is pitched to 880 Hz (${f1(dominantHz(slice(xb, 1.6, 2.8)))})`);

  // ---- segment cache + preview -----------------------------------------------------------
  console.log("segment cache + preview audio pass");
  const stage = () => (engine as unknown as { stageRender(): Promise<{ clips: ResolvedRenderClip[] }> }).stageRender();
  const keys = async () => {
    const { clips } = await stage();
    const canvas = previewCanvas({ width: 160, height: 90, fps: FPS });
    const segs = planSegments(clips, 6);
    return segs.map((s) => segmentKey(clips, s, canvas, PREVIEW_PROFILE, {}, null)).join();
  };
  const k0 = await keys();
  const fxId = (cur(bClip.id).effects!.audioFilters![0]).id;
  await call("apply_audio_effect", { clipId: bClip.id, type: "pitch", effectId: fxId, params: { semitones: -12 } });
  check((await keys()) === k0, "segment keys ignore audio-effect edits (no video re-render)");
  const prev = await engine.renderPreview();
  const xp = await decode(prev.path);
  check(Math.abs(dominantHz(slice(xp, 1.6, 2.8)) - 220) < 4, `segmented preview's audio pass has the edit (${f1(dominantHz(slice(xp, 1.6, 2.8)))} Hz)`);

  console.log(failures === 0 ? "\nVOICE SMOKE TEST PASSED" : `\nVOICE SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("VOICE SMOKE TEST FAILED:", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  process.exit(1);
});
