/**
 * The AUDIO-effect REGISTRY: the single source of truth for every per-clip
 * audio effect `apply_audio_effect` accepts (the audio twin of the visual
 * registry in ./registry.ts). One entry per type holds its label, category, the
 * one-line description the AI reads, the param schema (ranges + defaults), the
 * FFmpeg filter builder, and how the live preview plays it. Everything else is
 * generated from here: the rpc enum, validation and tool description, the
 * export filtergraph (graph.ts), the Web Audio preview chain and the
 * inspector's controls (apps/desktop).
 *
 * PURE on purpose — no `node:` imports, no engine imports, no DOM types — so
 * the desktop renderer can import it as `@aive/core/audio-effects`. The live
 * preview is described as plain data ({@link AudioNodeSpec}); the renderer
 * turns it into Web Audio nodes (apps/desktop/src/audiograph.ts).
 *
 * Stored effects are `{ id, type, params?, enabled? }`: every control lives in
 * `params` (there is no top-level `amount`). A param absent from a stored
 * effect means "its default", and every value is clamped to its range when the
 * filter is built.
 *
 * Where it runs (graph.ts): in each clip's audio chain AFTER the bleep mute
 * envelope and BEFORE atempo, on audio resampled to {@link AUDIO_FX_RATE}. So
 * effects see source-time audio — a clip's speed never changes an EQ, an echo
 * time or a voice pitch — and bleep sound effects (their own layers) are never
 * processed.
 *
 * Adding an effect = one entry in AUDIO_EFFECT_TYPE_IDS + one in DEFS below.
 */

import { clipFootprintFrames, hasSpeedRamp, type SpeedRamp } from "../speed.js";

export { VOICE_WORKLET_PROCESSOR, VOICE_WORKLET_SOURCE, voiceWorkletLatency, type VoiceWorkletOptions } from "./voiceworklet.js";

/** Every audio effect type, in a stable order (the rpc enum and the AI description follow it). */
export const AUDIO_EFFECT_TYPE_IDS = [
  "enhance_voice",
  "noise_reduction", "highpass", "lowpass", "de_esser", "gate", "declick",
  "eq_presence", "eq_warmth", "eq_custom", "bass_boost",
  "compressor", "limiter", "normalize",
  "pitch", "chipmunk", "deep", "robot", "echo", "reverb", "telephone", "megaphone", "underwater",
] as const;
export type AudioEffectType = (typeof AUDIO_EFFECT_TYPE_IDS)[number];

/** Inspector groups, in menu order. */
export const AUDIO_EFFECT_CATEGORIES = ["Enhance", "Cleanup", "Tone", "Dynamics", "Voice changer"] as const;
export type AudioEffectCategory = (typeof AUDIO_EFFECT_CATEGORIES)[number];

/** Sample rate the effect chain runs at (graph.ts resamples to it first). */
export const AUDIO_FX_RATE = 48000;

/** One numeric control (the same shape as the visual registry's EffectParam). A 0..1 param with step 1 is an on/off switch. */
export interface AudioEffectParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
}

/** The stored audio effect shape (structurally types.ts AudioEffect, minus the id). */
export interface AudioEffectInput {
  /** The stored effect's id (keys its measured loudness; see AudioFfmpegContext.loudness). */
  id?: string;
  type: string;
  params?: Record<string, number>;
  /** false = bypassed (skipped in export AND preview). Absent = on. */
  enabled?: boolean;
}

/** What an FFmpeg builder gets besides the effect. */
export interface AudioFfmpegContext {
  /**
   * True when FFmpeg has no `rubberband` filter: pitch effects fall back to
   * asetrate + atempo (same pitch and duration, slightly lower quality).
   */
  pitchFallback?: boolean;
  /**
   * Measured integrated loudness (LUFS) of the audio ENTERING each effect's
   * loudness stage, by effect id
   * (audio/fx.ts measures it at render time). With it, normalisation is an
   * exact linear gain + peak limiter; without it, single-pass loudnorm.
   */
  loudness?: Readonly<Record<string, number>>;
  /** Measuring: the effect id whose loudness stage emits {@link LOUDNESS_PROBE} (see audioMeasureSteps). */
  measure?: string;
  /** How the rendering FFmpeg's filters behave where versions differ (audio/fx.ts probes it). */
  caps?: AudioFilterCaps;
}

/**
 * Audio-filter behaviour of the FFmpeg build that renders, where releases
 * differ (audio/fx.ts resolveAudioFx fills it in; all unset = FFmpeg 4.4).
 */
export interface AudioFilterCaps {
  /**
   * afftdn is the FFmpeg ≥ 5 rewrite: its output is {@link AFFTDN_V2_DELAY}
   * samples late, its noise floor sits on another scale and its noise
   * tracking barely reduces anything (see denoiseSteps).
   */
  afftdnV2?: boolean;
  /** afftfilt is the FFmpeg ≥ 5.1 rewrite (hasAfftfiltV2): the robot rebuilds 4.4's maths (robotSteps). */
  afftfiltV2?: boolean;
  /** anlmdn crashes this FFmpeg (9.0): heavy noise reduction skips that pass. */
  noAnlmdn?: boolean;
}

/**
 * Output delay of FFmpeg ≥ 5's afftdn at {@link AUDIO_FX_RATE}, in samples: its
 * window is 3 hops of rate/80 and the output lags the input by two hops
 * (af_afftdn.c), 25 ms. FFmpeg 4.4's afftdn had none (it dropped those samples
 * from the end instead).
 */
export const AFFTDN_V2_DELAY = 2 * Math.floor(AUDIO_FX_RATE / 80);

/** Placeholder step where a measured effect's loudness stage begins (never reaches FFmpeg). */
export const LOUDNESS_PROBE = "@loudness";

/**
 * One Web Audio node of a live-preview chain, as plain data (the renderer
 * builds the real node). Chains are linear: each spec's output feeds the next.
 */
export type AudioNodeSpec =
  /** BiquadFilterNode (RBJ cookbook — the same maths as FFmpeg's biquads). */
  | { kind: "biquad"; type: "lowpass" | "highpass" | "lowshelf" | "highshelf" | "peaking"; frequency: number; Q?: number; gain?: number }
  /** DynamicsCompressorNode (threshold/knee dB, attack/release seconds). */
  | { kind: "compressor"; threshold: number; knee: number; ratio: number; attack: number; release: number }
  /** GainNode (linear). */
  | { kind: "gain"; gain: number }
  /** WaveShaperNode with the curve tanh(drive·x)/tanh(drive) — the same soft clip the export applies (softClip). */
  | { kind: "shaper"; drive: number }
  /** Multi-tap delay = FFmpeg aecho exactly: y = dry·x + Σ gain_i·x(t − delay_i) (seconds). */
  | { kind: "taps"; dry: number; taps: { delay: number; gain: number }[] }
  /** Sine-modulated delay = FFmpeg vibrato: delay sweeps 0..depth seconds at `rate` Hz. */
  | { kind: "vibrato"; rate: number; depth: number }
  /** AudioWorklet (voiceworklet.ts): phase-vocoder pitch shift by `ratio`, length unchanged. */
  | { kind: "pitch"; ratio: number }
  /** AudioWorklet (voiceworklet.ts): the export's afftfilt robotisation, window `win` samples at 48 kHz. */
  | { kind: "robot"; win: number };

/** Node kinds that run in the voice AudioWorklet (unavailable → those effects are render-only). */
export const WORKLET_NODE_KINDS: readonly AudioNodeSpec["kind"][] = ["pitch", "robot"];

/** How the live preview plays an effect. */
export interface AudioPreview {
  /** The Web Audio chain for this effect (may be empty = audible no-op). */
  webaudio: (e: AudioEffectInput) => AudioNodeSpec[];
  /**
   * Set when the chain is only PART of the effect (e.g. the macro's EQ and
   * compressor, not its noise reduction): says what only the render has. The
   * UI still shows the "Render exact" badge.
   */
  partial?: string;
  /**
   * Set when the chain plays the whole effect but not sample-for-sample like
   * the export (a different pitch shifter): says how it differs. The UI shows a
   * quieter "Approx." mark.
   */
  approx?: string;
}

/** What the live preview can run: `worklet` = the voice AudioWorklet loaded (or loadable). */
export interface AudioPreviewEnv {
  worklet: boolean;
}

/** How faithfully the live preview plays an effect: the inspector's mark. */
export type AudioPreviewFidelity = "live" | "approx" | "partial" | "render";

export interface AudioEffectDef {
  type: AudioEffectType;
  label: string;
  category: AudioEffectCategory;
  /** One line for the AI (what it does and when to use it). */
  description: string;
  /** Ordered controls (all stored in `params`). */
  params: AudioEffectParam[];
  /** FFmpeg audio filter steps (joined with "," into the clip's audio chain). */
  ffmpeg: (e: AudioEffectInput, ctx: AudioFfmpegContext) => string[];
  /** Live Web Audio preview, or "export-only" (the UI shows a "Render exact" badge). */
  preview: AudioPreview | "export-only";
}

// ---- helpers ------------------------------------------------------------------

/** FFmpeg number formatting (6 decimals, like graph.ts). */
const num = (n: number): string => (Number.isFinite(n) ? n.toFixed(6) : "0");
const clampN = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
/** dB → linear amplitude. */
export const dbToGain = (db: number): number => Math.pow(10, db / 20);

/**
 * A param's effective value: the stored value (or the default when absent),
 * clamped to the param's range. `fallback` is returned for a param the effect
 * doesn't declare.
 */
export function audioParamValue(e: AudioEffectInput, key: string, fallback = 0): number {
  const p = DEF_MAP.get(e.type)?.params.find((q) => q.key === key);
  if (!p) return fallback;
  const v = e.params?.[key];
  return clampN(typeof v === "number" && Number.isFinite(v) ? v : p.default, p.min, p.max);
}

const P = (key: string, label: string, min: number, max: number, step: number, def: number, unit?: string): AudioEffectParam => ({
  key, label, min, max, step, default: def, ...(unit ? { unit } : {}),
});
/** An on/off switch param (0 = off, 1 = on). */
const SWITCH = (key: string, label: string, def: 0 | 1): AudioEffectParam => P(key, label, 0, 1, 1, def);

/** Is a param an on/off switch (the UI renders a checkbox)? */
export function isSwitchParam(p: AudioEffectParam): boolean {
  return p.min === 0 && p.max === 1 && p.step === 1;
}

// Builders shared by several entries (FFmpeg + Web Audio side by side, so the
// preview runs the same filter maths as the export).

/** 4th-order (two cascaded 2-pole, Q 0.707) high- or low-pass. */
function pass2(kind: "highpass" | "lowpass", f: number): string[] {
  const s = `${kind}=f=${num(f)}:poles=2:t=q:w=0.707107`;
  return [s, s];
}
function pass2Web(kind: "highpass" | "lowpass", f: number): AudioNodeSpec[] {
  const s: AudioNodeSpec = { kind: "biquad", type: kind, frequency: f, Q: Math.SQRT1_2 };
  return [s, { ...s }];
}
/** Peaking EQ (RBJ, Q). */
const peq = (f: number, q: number, g: number): string => `equalizer=f=${num(f)}:t=q:w=${num(q)}:g=${num(g)}`;
const peqWeb = (f: number, q: number, g: number): AudioNodeSpec => ({ kind: "biquad", type: "peaking", frequency: f, Q: q, gain: g });
/** Shelves with slope S = 1 — the fixed slope of Web Audio's shelves. */
const shelf = (kind: "lowshelf" | "highshelf", f: number, g: number): string => `${kind}=f=${num(f)}:t=s:w=1:g=${num(g)}`;
const shelfWeb = (kind: "lowshelf" | "highshelf", f: number, g: number): AudioNodeSpec => ({ kind: "biquad", type: kind, frequency: f, gain: g });

/**
 * Soft clip y = tanh(k·x)/tanh(k) (unity small-signal slope ≈ k/tanh(k)); k → 0 is linear.
 * Built as gain k → asoftclip tanh (param 1: y = tanh(x)) → gain 1/tanh(k), so the drive
 * can exceed asoftclip's param range (max 3). Not aeval: ffmpeg 4.4 can't negotiate a
 * channel layout through aeval c=same after enhance_voice + a bleep ("Cannot select
 * channel layout"), and pinning the layout with aformat broke 4.0/5.1 sources instead.
 */
function softClip(drive: number): string[] {
  const k = Math.max(0.01, drive);
  return [`volume=${num(k)}`, "asoftclip=type=tanh", `volume=${num(1 / Math.tanh(k))}`];
}

/**
 * Pitch shift by `semitones`, keeping duration. rubberband (formants shifted —
 * the classic cartoon character) when available; otherwise resample-shift:
 * asetrate raises/lowers pitch AND tempo, atempo restores the tempo.
 */
function pitchSteps(semitones: number, ctx: AudioFfmpegContext): string[] {
  if (Math.abs(semitones) < 1e-3) return [];
  const r = Math.pow(2, clampN(semitones, -12, 12) / 12);
  if (!ctx.pitchFallback) return [`rubberband=pitch=${num(r)}:transients=crisp:pitchq=quality`];
  return [`asetrate=${Math.round(AUDIO_FX_RATE * r)}`, `aresample=${AUDIO_FX_RATE}`, `atempo=${num(1 / r)}`];
}
/** The live preview of pitchSteps: the worklet's pitch shifter (same ratio, same no-op at 0). */
function pitchWeb(semitones: number): AudioNodeSpec[] {
  if (Math.abs(semitones) < 1e-3) return [];
  return [{ kind: "pitch", ratio: Math.pow(2, clampN(semitones, -12, 12) / 12) }];
}
const PITCH_APPROX = "a simpler pitch shifter than the export's rubberband (transients smear a little)";
/** Robot window sizes (samples at 48 kHz) per tone 0 low · 1 mid · 2 high. */
const robotWin = (e: AudioEffectInput): number => [2048, 1024, 512][Math.round(audioParamValue(e, "tone"))] ?? 1024;

const robotTapCache = new Map<number, Array<[number, number]>>();
/**
 * DFT taps h_0..h_2 of FFmpeg's float symmetric-Hann LUT (window_func.h), divided
 * by W, as [re, im] (h_{−m} = conj h_m). A rectangular-window spectrum convolved
 * with them is the Hann-windowed one (robotV2Real); 5 taps leave a −65 dB floor.
 */
export function robotTaps(W: number): Array<[number, number]> {
  let t = robotTapCache.get(W);
  if (!t) {
    t = [0, 1, 2].map((m) => {
      let re = 0;
      let im = 0;
      for (let n = 0; n < W; n++) {
        const w = Math.fround(0.5 * (1 - Math.cos((2 * Math.PI * n) / (W - 1))));
        re += w * Math.cos((2 * Math.PI * m * n) / W);
        im -= w * Math.sin((2 * Math.PI * m * n) / W);
      }
      return [re / W, im / W] as [number, number];
    });
    robotTapCache.set(W, t);
  }
  return t;
}
const tap = (x: number): string => x.toPrecision(12);

/**
 * afftfilt real= for FFmpeg ≥ 5.1 with win_func=rect: |Σ_m h_m X_{b−m}| = 4.4's
 * |FFT(hann·x)|_b, with the 3 frames that start before the stream gated off
 * (`pts` is the newest hop's). real()/imag() read the unmodified spectrum. Bins
 * 2..nb−2 read each neighbour once into st/ld registers; only the 4 edge bins
 * take the Hermitian-mirrored reads (X_{−j} = conj X_j, X_{nb+j} = conj X_{nb−j}),
 * and av_expr's if() evaluates only the branch it takes. Never contains `|`
 * (afftfilt splits per-channel expressions on it).
 */
function robotV2Real(W: number): string {
  const [[h0], [h1r, h1i], [h2r, h2i]] = robotTaps(W);
  const fast =
    "st(0,real(b-1,ch));st(1,real(b+1,ch));st(2,imag(b-1,ch));st(3,imag(b+1,ch));" +
    "st(4,real(b-2,ch));st(5,real(b+2,ch));st(6,imag(b-2,ch));st(7,imag(b+2,ch));" +
    `hypot(${tap(h0)}*re+${tap(h1r)}*(ld(0)+ld(1))+${tap(h1i)}*(ld(3)-ld(2))+${tap(h2r)}*(ld(4)+ld(5))+${tap(h2i)}*(ld(7)-ld(6)),` +
    `${tap(h0)}*im+${tap(h1r)}*(ld(2)+ld(3))+${tap(h1i)}*(ld(0)-ld(1))+${tap(h2r)}*(ld(6)+ld(7))+${tap(h2i)}*(ld(4)-ld(5)))`;
  const X = (m: number) => {
    const j = `(b-(${m}))`;
    const k = `(nb-abs(nb-abs${j}))`;
    return { re: `real(${k},ch)`, im: `(1-2*(lt(${j},0)+gt(${j},nb)))*imag(${k},ch)` };
  };
  const taps: Array<[number, number, number]> = [[-2, h2r, -h2i], [-1, h1r, -h1i], [0, h0, 0], [1, h1r, h1i], [2, h2r, h2i]];
  const re = taps.map(([m, hr, hi]) => `${tap(hr)}*${X(m).re}-(${tap(hi)})*${X(m).im}`).join("+");
  const im = taps.map(([m, hr, hi]) => `${tap(hr)}*${X(m).im}+(${tap(hi)})*${X(m).re}`).join("+");
  return `if(between(b,2,nb-2),${fast},hypot(${re},${im}))*gte(pts,${(3 * W) / 4})`;
}

/**
 * The robot at window W (overlap 0.75, hop W/4): every bin keeps its magnitude
 * and loses its phase — FFmpeg 4.4's afftfilt sound, which the live worklet
 * plays too. FFmpeg ≥ 5.1 (caps.afftfiltV2) rewrote afftfilt: sqrt-Hann
 * analysis AND synthesis windows (the synthesis window is 0 exactly where the
 * buzz pulse sits: quieter, duller, isolated transients gone), W − hop samples
 * late, the last 0.75·W samples never flushed. There it runs with
 * win_func=rect (a constant window: 4.4's per-frame scale) and rebuilds 4.4's
 * Hann spectrum in the expression (robotV2Real); the input is padded by the
 * latency D = 3·hop and D samples are trimmed off the front. 4.4 rounds its
 * output up to a whole hop, so the input's last frame is padded to one first
 * (an input that is not hop-aligned, like after normalize, keeps that tail). asettb/asetpts=N
 * give the pts gate sample timestamps whatever the caller's (the loudness
 * measurement runs after `-ss`). Matches 4.4 within −65 dB at 0.0 dB level.
 */
function robotSteps(W: number, caps: AudioFilterCaps = {}): string[] {
  if (!caps.afftfiltV2) return [`afftfilt=real='hypot(re,im)':imag='0':win_size=${W}:overlap=0.75`];
  const D = (3 * W) / 4;
  return [
    `asetnsamples=n=${W / 4}:p=1`, "asettb=1/sr", "asetpts=N", `apad=pad_len=${D}`,
    `afftfilt=win_func=rect:overlap=0.75:win_size=${W}:real='${robotV2Real(W)}':imag='0'`,
    `atrim=start_sample=${D}`, "asetpts=PTS-STARTPTS",
  ];
}

/**
 * Silence fed through vibrato first and cut from its output (samples at
 * {@link AUDIO_FX_RATE}): ≥ its 5 ms delay line (af_vibrato.c, rate·0.005).
 */
const VIBRATO_PRIME = 480;

/**
 * vibrato at `f` Hz, depth `d`. FFmpeg (4.4 – 9.0) allocates vibrato's delay
 * line without clearing it and reads it before writing, so the first 5 ms of
 * output were leftover heap memory — random clicks, up to ±inf (smoke-voice
 * caught a peak of +40 dBFS). Priming the line with silence and trimming that
 * part off leaves exactly the output of a cleared line, at the same timing.
 */
function vibratoSteps(f: number, d: number): string[] {
  return [`adelay=delays=${VIBRATO_PRIME}S:all=1`, `vibrato=f=${f}:d=${num(d)}`, `atrim=start_sample=${VIBRATO_PRIME}`, "asetpts=PTS-STARTPTS"];
}

/**
 * aecho taps (delays ms, decays) with energy-normalised output: in_gain 1,
 * out_gain = 1/√(1+Σdecay²), so adding echo doesn't make the clip clip.
 */
function echoTaps(delaysMs: number[], decays: number[]): { dry: number; taps: { delay: number; gain: number }[]; out: number } {
  const out = 1 / Math.sqrt(1 + decays.reduce((s, d) => s + d * d, 0));
  return { dry: out, out, taps: delaysMs.map((d, i) => ({ delay: d / 1000, gain: out * decays[i] })) };
}
function aechoStep(delaysMs: number[], decays: number[]): string {
  const { out } = echoTaps(delaysMs, decays);
  const ds = delaysMs.map((d) => d.toFixed(3)).join("|");
  const dc = decays.map((d) => d.toFixed(6)).join("|");
  return `aecho=in_gain=1:out_gain=${num(out)}:delays=${ds}:decays=${dc}`;
}
function tapsWeb(delaysMs: number[], decays: number[]): AudioNodeSpec {
  const { dry, taps } = echoTaps(delaysMs, decays);
  return { kind: "taps", dry, taps };
}

/** Echo repeats: delay·i at decay^i, until the repeat is under −34 dB (max 6). */
function echoPattern(e: AudioEffectInput): { delays: number[]; decays: number[] } {
  const delay = audioParamValue(e, "delay");
  const decay = audioParamValue(e, "decay");
  const delays: number[] = [];
  const decays: number[] = [];
  for (let i = 1; i <= 6; i++) {
    const g = Math.pow(decay, i);
    if (g < 0.02) break;
    delays.push(delay * i);
    decays.push(g);
  }
  return { delays, decays };
}

/** Room reflections: 10 early taps (prime-ish spacings) scaled by size, decaying exponentially. */
const REVERB_BASE_MS = [11, 19, 29, 37, 47, 59, 71, 83, 101, 127];
function reverbPattern(e: AudioEffectInput): { delays: number[]; decays: number[] } {
  const room = audioParamValue(e, "room");
  const mix = audioParamValue(e, "mix");
  const scale = 0.6 + 1.6 * room;
  const tail = 0.55 + 0.35 * room; // per-tap decay of the reflection train
  const delays = REVERB_BASE_MS.map((d) => d * scale);
  const decays = REVERB_BASE_MS.map((_, i) => mix * 0.75 * Math.pow(tail, i * 0.6));
  return { delays, decays };
}

/**
 * Web Audio's DynamicsCompressorNode adds its own makeup gain, (1/g)^0.6 where
 * g is the curve's gain at 0 dBFS. This undoes it so the preview level follows
 * the export (FFmpeg's acompressor adds none).
 */
function compressorMakeupCompensation(thresholdDb: number, ratio: number): AudioNodeSpec {
  const fullRangeDb = thresholdDb * (1 - 1 / ratio); // output level of a 0 dBFS input, ≤ 0
  return { kind: "gain", gain: dbToGain(0.6 * fullRangeDb) };
}

/** Assumed noise floor (dBFS RMS) when none was measured. */
export const DEFAULT_NOISE_FLOOR = -60;

/**
 * Spectral noise reduction (afftdn) for a clip whose noise sits at `floorDb`
 * (dBFS RMS — engine-measured from the clip's quietest moments, stored in the
 * effect's `floor` param). afftdn reduces what lies below its own `nf`, which
 * behaves like noise level + ~25 dB whatever the absolute level, so `nf` is
 * set relative to the measured floor: amount 0..1 → +22..+32 dB and nr
 * 12..36 dB. nf only reaches −20 dB, so a louder floor is attenuated into
 * range first and restored after. `heavy` adds a second spectral pass on the
 * residue plus a non-local-means pass (anlmdn) for non-stationary hiss.
 *
 * FFmpeg ≥ 5 (caps.afftdnV2) rewrote afftdn: its noise tracking (tn) reduces a
 * steady floor by only ~3 dB whatever nf says, so the measured floor is used
 * as is (no tn) with nf `v2Offset` + 10·amount dB above it — 17 here (5 dB
 * lower than 4.4's +22: on smoke-voice's speech that matches 4.4's reduction
 * within ~1.5 dB at every amount) — and each pass is trimmed by its
 * {@link AFFTDN_V2_DELAY} so the sound stays in sync.
 */
function denoiseSteps(floorDb: number, amount: number, heavy: boolean, caps: AudioFilterCaps = {}, v2Offset = 17): string[] {
  if (amount <= 0) return [];
  const v2 = !!caps.afftdnV2;
  let nf = floorDb + (v2 ? v2Offset : 22) + 10 * amount;
  const nr = 12 + 24 * amount;
  const pre = nf > -20 ? -20 - nf : 0; // dB, ≤ 0
  nf = clampN(nf + pre, -80, -20);
  const afftdn = (floor: number) =>
    v2 ? [`afftdn=nr=${num(nr)}:nf=${num(floor)}`, `atrim=start_sample=${AFFTDN_V2_DELAY}`, "asetpts=PTS-STARTPTS"] : [`afftdn=nr=${num(nr)}:nf=${num(floor)}:tn=1`];
  const out: string[] = [];
  if (pre < 0) out.push(`volume=${num(pre)}dB`);
  out.push(...afftdn(nf));
  if (heavy) {
    out.push(...afftdn(clampN(nf - 12, -80, -20)));
    if (!caps.noAnlmdn) out.push(`anlmdn=s=${num(clampN(2 * dbToGain(floorDb + pre - 12), 0.00001, 10))}:p=0.002:r=0.006:m=11`);
  }
  if (pre < 0) out.push(`volume=${num(-pre)}dB`);
  return out;
}

/** deesser: amount 0..1 → intensity 0.45..0.85, gain floor m 0.9..0.2 (FFmpeg's `m` is the LEAST gain: lower = stronger). */
function deessStep(amount: number, freq = 0.5): string {
  return `deesser=i=${num(0.45 + 0.4 * amount)}:m=${num(0.9 - 0.7 * amount)}:f=${num(freq)}:s=o`;
}

/**
 * Look-ahead peak limiter at `ceilingDb`. alimiter delays its output by its
 * 5 ms look-ahead; the trim takes that back out so the sound stays in sync
 * with the picture (graph.ts pads the clip back to length afterwards).
 */
function limiterSteps(ceilingDb: number, releaseMs = 50, driveDb = 0): string[] {
  const drive = driveDb > 0 ? `level_in=${num(dbToGain(driveDb))}:` : "";
  return [
    `alimiter=${drive}limit=${num(dbToGain(ceilingDb))}:attack=5:release=${num(releaseMs)}:level=0`,
    "atrim=start=0.005", "asetpts=PTS-STARTPTS",
  ];
}

/** Peak ceiling of the loudness stage (dBFS, sample peak — leaves room for codec overshoot). */
const LOUDNESS_CEILING_DB = -1.5;

/**
 * Bring the audio to `target` LUFS. Measured (ctx.loudness has this effect):
 * an exact linear gain (capped at +24 dB) and a look-ahead peak limiter at
 * −1.5 dBFS — no pumping, lands on target. Unmeasured: single-pass loudnorm
 * (dynamic; within a couple of LU on speech). Loudness is measured on the
 * clip's own channels: the mix keeps a mono clip mono, or spreads it to stereo
 * at −3 dB per side — the same loudness either way.
 */
function loudnessStage(e: AudioEffectInput, ctx: AudioFfmpegContext, target: number): string[] {
  if (ctx.measure !== undefined && ctx.measure === e.id) return [LOUDNESS_PROBE];
  const limiter = limiterSteps(LOUDNESS_CEILING_DB);
  const measured = e.id !== undefined ? ctx.loudness?.[e.id] : undefined;
  if (measured !== undefined) {
    if (measured <= -69) return limiter; // silence: nothing to normalise
    return [`volume=${num(clampN(target - measured, -40, 24))}dB`, ...limiter];
  }
  return [`loudnorm=I=${num(target)}:TP=${num(LOUDNESS_CEILING_DB)}:LRA=11`, `aresample=${AUDIO_FX_RATE}`];
}

/** Phrase leveller (dynaudnorm): evens loud vs quiet passages over ~4 s windows, at most `maxGain`× up. */
function levellerStep(maxGain: number): string {
  return `dynaudnorm=f=250:g=15:p=0.9:m=${num(maxGain)}:s=0`;
}

// ---- enhance_voice: the macro --------------------------------------------------

/**
 * The tuned "make my voice sound good" chain for strength s (0..1):
 * rumble cut → spectral noise reduction (relative to the measured floor) →
 * de-esser → warmth + presence EQ → phrase leveller → gentle compressor →
 * −16 LUFS (measured linear gain + −1.5 dBFS limiter). With normalize off the
 * leveller and gain are skipped and a −1 dBFS limiter guards against clipping.
 * Tuned on synthetic speech (smoke-voice): the gap floor drops ≥ 10 dB, a
 * 24 dB loud/quiet swing shrinks by ≥ 10 dB, no clipping.
 */
function enhanceSteps(e: AudioEffectInput, ctx: AudioFfmpegContext): string[] {
  const s = audioParamValue(e, "strength");
  const denoise = audioParamValue(e, "denoise") >= 0.5;
  const normalize = audioParamValue(e, "normalize") >= 0.5;
  const out: string[] = [...pass2("highpass", 75)];
  // FFmpeg ≥ 5: nf only +6 dB over the floor (see denoiseSteps). Behind the rumble cut
  // and in front of the leveller, +17 cleaned the gaps ~8 dB more than 4.4 and left the
  // quiet phrases quieter (loud vs quiet evened 2 dB less); +6 matches 4.4's result.
  if (denoise && s > 0) out.push(...denoiseSteps(audioParamValue(e, "floor"), 0.35 + 0.55 * s, false, ctx.caps, 6));
  if (s > 0) out.push(deessStep(0.2 + 0.4 * s));
  out.push(peq(200, 0.8, 1.5 * s), peq(4500, 1, 3 * s));
  if (normalize && s > 0) out.push(levellerStep(1 + 4 * s));
  const thr = -18 - 6 * s;
  out.push(`acompressor=threshold=${num(dbToGain(thr))}:ratio=${num(1.5 + 2 * s)}:attack=15:release=250:knee=2.828427:detection=rms`);
  if (normalize) out.push(...loudnessStage(e, ctx, -16));
  else out.push(...limiterSteps(-1));
  return out;
}
function enhanceWeb(e: AudioEffectInput): AudioNodeSpec[] {
  const s = audioParamValue(e, "strength");
  const thr = -18 - 6 * s;
  const ratio = 1.5 + 2 * s;
  return [
    ...pass2Web("highpass", 75),
    peqWeb(200, 0.8, 1.5 * s),
    peqWeb(4500, 1, 3 * s),
    { kind: "compressor", threshold: thr, knee: 9, ratio, attack: 0.015, release: 0.25 },
    compressorMakeupCompensation(thr, ratio),
  ];
}

// ---- the registry -------------------------------------------------------------

const DEFS: { [K in AudioEffectType]: Omit<AudioEffectDef, "type"> } = {
  enhance_voice: {
    label: "Enhance voice",
    category: "Enhance",
    description:
      "ONE-CLICK voice polish for dialogue/voice-over: rumble cut, noise reduction, de-ess, warmth + presence EQ, gentle compression and loudness normalisation (−16 LUFS). " +
      "strength 0..1 scales it; denoise/normalize 0|1 switch those stages off; floor = the clip's noise level (measured automatically when omitted).",
    params: [
      P("strength", "Strength", 0, 1, 0.05, 0.7), SWITCH("denoise", "Reduce noise", 1), SWITCH("normalize", "Normalize loudness", 1),
      P("floor", "Noise floor (measured)", -90, -20, 1, DEFAULT_NOISE_FLOOR, " dBFS"),
    ],
    ffmpeg: (e, ctx) => enhanceSteps(e, ctx),
    preview: { webaudio: enhanceWeb, partial: "noise reduction, de-essing and loudness normalisation" },
  },
  noise_reduction: {
    label: "Reduce noise",
    category: "Cleanup",
    description:
      "Spectral noise reduction for steady hiss/hum/fan/room noise (FFmpeg afftdn, tuned to the clip's noise floor). amount 0..1 = how hard; " +
      "floor = the clip's noise level in dBFS, MEASURED from its quietest moments when omitted (lower it if speech turns watery); heavy 1 adds a second spectral pass plus a non-local-means pass for very noisy audio (FFmpeg 9.0 has a broken non-local-means filter, so there heavy is the second pass only).",
    params: [P("amount", "Amount", 0, 1, 0.05, 0.5), P("floor", "Noise floor (measured)", -90, -20, 1, DEFAULT_NOISE_FLOOR, " dBFS"), SWITCH("heavy", "Extra pass", 0)],
    ffmpeg: (e, ctx) => denoiseSteps(audioParamValue(e, "floor"), audioParamValue(e, "amount"), audioParamValue(e, "heavy") >= 0.5, ctx.caps),
    preview: "export-only",
  },
  highpass: {
    label: "Rumble cut (high-pass)",
    category: "Cleanup",
    description: "Removes low rumble, wind and handling noise below the cutoff (24 dB/oct). 80 Hz suits most voices.",
    params: [P("frequency", "Cutoff", 20, 500, 5, 80, " Hz")],
    ffmpeg: (e) => pass2("highpass", audioParamValue(e, "frequency")),
    preview: { webaudio: (e) => pass2Web("highpass", audioParamValue(e, "frequency")) },
  },
  lowpass: {
    label: "High cut (low-pass)",
    category: "Cleanup",
    description: "Removes hiss and harshness above the cutoff (24 dB/oct).",
    params: [P("frequency", "Cutoff", 1000, 20000, 100, 8000, " Hz")],
    ffmpeg: (e) => pass2("lowpass", audioParamValue(e, "frequency")),
    preview: { webaudio: (e) => pass2Web("lowpass", audioParamValue(e, "frequency")) },
  },
  de_esser: {
    label: "De-esser",
    category: "Cleanup",
    description: "Tames harsh 's'/'sh' sibilance (FFmpeg deesser). amount 0..1; frequency 0..1 = split point (higher = only the brightest hiss).",
    params: [P("amount", "Amount", 0, 1, 0.05, 0.5), P("frequency", "Frequency", 0, 1, 0.05, 0.5)],
    ffmpeg: (e) => {
      const a = audioParamValue(e, "amount");
      return a > 0 ? [deessStep(a, audioParamValue(e, "frequency"))] : [];
    },
    preview: "export-only",
  },
  gate: {
    label: "Noise gate",
    category: "Cleanup",
    description: "Turns the audio down between phrases, below the threshold (FFmpeg agate). reduction = how far (dB); attack/release in ms.",
    params: [
      P("threshold", "Threshold", -80, -10, 1, -45, " dB"),
      P("reduction", "Reduction", 0, 60, 1, 24, " dB"),
      P("attack", "Attack", 0.1, 100, 0.1, 5, " ms"),
      P("release", "Release", 10, 2000, 10, 150, " ms"),
    ],
    ffmpeg: (e) => {
      const red = audioParamValue(e, "reduction");
      if (red <= 0) return [];
      return [
        `agate=threshold=${num(dbToGain(audioParamValue(e, "threshold")))}:range=${num(dbToGain(-red))}:ratio=10` +
          `:attack=${num(audioParamValue(e, "attack"))}:release=${num(audioParamValue(e, "release"))}:detection=rms`,
      ];
    },
    preview: "export-only",
  },
  declick: {
    label: "De-click",
    category: "Cleanup",
    // adeclick's run time explodes below threshold 2 (1.5 is ~50× slower, 1.25
    // never finishes on speech), so the range stops at its default.
    description: "Removes clicks, pops and crackle (FFmpeg adeclick). threshold 2..10: lower catches more.",
    params: [P("threshold", "Threshold (lower = more)", 2, 10, 0.5, 2)],
    ffmpeg: (e) => [`adeclick=w=55:o=75:a=2:t=${num(audioParamValue(e, "threshold"))}:b=2`],
    preview: "export-only",
  },
  eq_presence: {
    label: "Presence (clarity)",
    category: "Tone",
    description: "Peaking EQ around 3–5 kHz: + makes a voice clearer and more forward, − softens harshness.",
    params: [P("gain", "Gain", -12, 12, 0.5, 4, " dB"), P("frequency", "Frequency", 2000, 8000, 100, 4000, " Hz")],
    ffmpeg: (e) => [peq(audioParamValue(e, "frequency"), 1, audioParamValue(e, "gain"))],
    preview: { webaudio: (e) => [peqWeb(audioParamValue(e, "frequency"), 1, audioParamValue(e, "gain"))] },
  },
  eq_warmth: {
    label: "Warmth (body)",
    category: "Tone",
    description: "Peaking EQ around 150–250 Hz: + adds body/warmth to a thin voice, − removes boominess/mud.",
    params: [P("gain", "Gain", -12, 12, 0.5, 3, " dB"), P("frequency", "Frequency", 100, 400, 10, 200, " Hz")],
    ffmpeg: (e) => [peq(audioParamValue(e, "frequency"), 0.7, audioParamValue(e, "gain"))],
    preview: { webaudio: (e) => [peqWeb(audioParamValue(e, "frequency"), 0.7, audioParamValue(e, "gain"))] },
  },
  eq_custom: {
    label: "EQ (3-band)",
    category: "Tone",
    description: "Three-band EQ: low shelf at 100 Hz, mid peak at 1 kHz, high shelf at 8 kHz (gains in dB).",
    params: [P("low", "Low", -12, 12, 0.5, 0, " dB"), P("mid", "Mid", -12, 12, 0.5, 0, " dB"), P("high", "High", -12, 12, 0.5, 0, " dB")],
    ffmpeg: (e) => {
      const [lo, mid, hi] = ["low", "mid", "high"].map((k) => audioParamValue(e, k));
      const out: string[] = [];
      if (lo !== 0) out.push(shelf("lowshelf", 100, lo));
      if (mid !== 0) out.push(peq(1000, 0.7, mid));
      if (hi !== 0) out.push(shelf("highshelf", 8000, hi));
      return out;
    },
    preview: {
      webaudio: (e) => {
        const [lo, mid, hi] = ["low", "mid", "high"].map((k) => audioParamValue(e, k));
        const out: AudioNodeSpec[] = [];
        if (lo !== 0) out.push(shelfWeb("lowshelf", 100, lo));
        if (mid !== 0) out.push(peqWeb(1000, 0.7, mid));
        if (hi !== 0) out.push(shelfWeb("highshelf", 8000, hi));
        return out;
      },
    },
  },
  bass_boost: {
    label: "Bass boost",
    category: "Tone",
    description: "Low-shelf boost below the frequency: a fuller, deeper sound.",
    params: [P("gain", "Gain", 0, 18, 0.5, 6, " dB"), P("frequency", "Frequency", 40, 250, 5, 100, " Hz")],
    ffmpeg: (e) => {
      const g = audioParamValue(e, "gain");
      return g > 0 ? [shelf("lowshelf", audioParamValue(e, "frequency"), g)] : [];
    },
    preview: {
      webaudio: (e) => {
        const g = audioParamValue(e, "gain");
        return g > 0 ? [shelfWeb("lowshelf", audioParamValue(e, "frequency"), g)] : [];
      },
    },
  },
  compressor: {
    label: "Compressor",
    category: "Dynamics",
    description: "Evens out loud and quiet parts (FFmpeg acompressor). threshold dB, ratio, attack/release ms, makeup dB to win back level.",
    params: [
      P("threshold", "Threshold", -60, 0, 1, -20, " dB"),
      P("ratio", "Ratio", 1, 20, 0.5, 4, ":1"),
      P("attack", "Attack", 0.1, 200, 0.1, 10, " ms"),
      P("release", "Release", 10, 2000, 10, 150, " ms"),
      P("makeup", "Makeup", 0, 24, 0.5, 0, " dB"),
    ],
    ffmpeg: (e) => [
      `acompressor=threshold=${num(dbToGain(audioParamValue(e, "threshold")))}:ratio=${num(audioParamValue(e, "ratio"))}` +
        `:attack=${num(audioParamValue(e, "attack"))}:release=${num(audioParamValue(e, "release"))}` +
        `:makeup=${num(dbToGain(audioParamValue(e, "makeup")))}:knee=2.828427:detection=rms`,
    ],
    preview: {
      webaudio: (e) => {
        const thr = audioParamValue(e, "threshold");
        const ratio = audioParamValue(e, "ratio");
        return [
          {
            kind: "compressor", threshold: thr, knee: 9, ratio,
            attack: audioParamValue(e, "attack") / 1000, release: Math.min(1, audioParamValue(e, "release") / 1000),
          },
          compressorMakeupCompensation(thr, ratio),
          { kind: "gain", gain: dbToGain(audioParamValue(e, "makeup")) },
        ];
      },
    },
  },
  limiter: {
    label: "Limiter",
    category: "Dynamics",
    description: "Brick-wall peak limiter (FFmpeg alimiter): no peak above the ceiling (dBFS). drive pushes the level into it for a louder, denser sound.",
    params: [P("ceiling", "Ceiling", -12, 0, 0.5, -1, " dB"), P("drive", "Drive", 0, 24, 0.5, 0, " dB"), P("release", "Release", 1, 1000, 1, 50, " ms")],
    ffmpeg: (e) => limiterSteps(audioParamValue(e, "ceiling"), audioParamValue(e, "release"), audioParamValue(e, "drive")),
    preview: {
      webaudio: (e) => {
        const thr = audioParamValue(e, "ceiling");
        return [
          { kind: "gain", gain: dbToGain(audioParamValue(e, "drive")) },
          { kind: "compressor", threshold: thr, knee: 0, ratio: 20, attack: 0.003, release: Math.min(1, audioParamValue(e, "release") / 1000) },
          compressorMakeupCompensation(thr, 20),
        ];
      },
    },
  },
  normalize: {
    label: "Normalize loudness",
    category: "Dynamics",
    description:
      "Sets the clip to a target integrated loudness in LUFS (measured at render time, then an exact gain + −1.5 dBFS peak limiter): −16 for online video/podcasts, −14 for social, −23 broadcast. " +
      "even 0..1 first evens out loud vs quiet passages (phrase leveller) — for speech recorded at varying distances.",
    params: [P("target", "Target", -30, -10, 0.5, -16, " LUFS"), P("even", "Even out passages", 0, 1, 0.05, 0)],
    ffmpeg: (e, ctx) => {
      const even = audioParamValue(e, "even");
      return [...(even > 0 ? [levellerStep(1 + 5 * even)] : []), ...loudnessStage(e, ctx, audioParamValue(e, "target"))];
    },
    preview: "export-only",
  },
  pitch: {
    label: "Custom pitch",
    category: "Voice changer",
    description: "Shifts the voice pitch in semitones (+12 = an octave up) without changing its speed or length.",
    params: [P("semitones", "Pitch", -12, 12, 0.5, 4, " st")],
    ffmpeg: (e, ctx) => pitchSteps(audioParamValue(e, "semitones"), ctx),
    preview: { webaudio: (e) => pitchWeb(audioParamValue(e, "semitones")), approx: PITCH_APPROX },
  },
  chipmunk: {
    label: "Chipmunk",
    category: "Voice changer",
    description: "High, squeaky cartoon voice (pitch up, formants shifted).",
    params: [P("semitones", "Pitch", 3, 12, 0.5, 8, " st")],
    ffmpeg: (e, ctx) => pitchSteps(audioParamValue(e, "semitones"), ctx),
    preview: { webaudio: (e) => pitchWeb(audioParamValue(e, "semitones")), approx: PITCH_APPROX },
  },
  deep: {
    label: "Deep voice",
    category: "Voice changer",
    description: "Low, heavy monster/villain voice (pitch down, formants shifted).",
    params: [P("semitones", "Pitch", -12, -2, 0.5, -5, " st")],
    ffmpeg: (e, ctx) => pitchSteps(audioParamValue(e, "semitones"), ctx),
    preview: { webaudio: (e) => pitchWeb(audioParamValue(e, "semitones")), approx: PITCH_APPROX },
  },
  robot: {
    label: "Robot",
    category: "Voice changer",
    description: "Monotone metallic robot voice (phase-vocoder robotisation). tone 0 low · 1 mid · 2 high buzz.",
    params: [P("tone", "Tone", 0, 2, 1, 1)],
    // Zeroing every bin's phase each hop re-synthesises the voice as a buzz at
    // rate/hop (≈ 94 / 188 / 375 Hz) that keeps the words' spectral shape.
    ffmpeg: (e, ctx) => robotSteps(robotWin(e), ctx.caps),
    // The same afftfilt maths in the worklet: sample-exact against FFmpeg 4.4/5.0,
    // and against 5.1+ through robotSteps' rebuild (within −65 dB).
    preview: { webaudio: (e) => [{ kind: "robot", win: robotWin(e) }] },
  },
  echo: {
    label: "Echo",
    category: "Voice changer",
    description: "Repeating echo: delay between repeats (ms) and decay 0..0.9 (how loud each repeat is vs the last).",
    params: [P("delay", "Delay", 50, 1000, 10, 300, " ms"), P("decay", "Decay", 0.05, 0.9, 0.05, 0.4)],
    ffmpeg: (e) => {
      const { delays, decays } = echoPattern(e);
      return delays.length ? [aechoStep(delays, decays)] : [];
    },
    preview: {
      webaudio: (e) => {
        const { delays, decays } = echoPattern(e);
        return delays.length ? [tapsWeb(delays, decays)] : [];
      },
    },
  },
  reverb: {
    label: "Reverb (room)",
    category: "Voice changer",
    description: "Room-like reflections: room 0..1 = size, mix 0..1 = how much of the room you hear.",
    params: [P("room", "Room size", 0, 1, 0.05, 0.5), P("mix", "Mix", 0, 1, 0.05, 0.35)],
    ffmpeg: (e) => {
      if (audioParamValue(e, "mix") <= 0) return [];
      const { delays, decays } = reverbPattern(e);
      return [aechoStep(delays, decays)];
    },
    preview: {
      webaudio: (e) => {
        if (audioParamValue(e, "mix") <= 0) return [];
        const { delays, decays } = reverbPattern(e);
        return [tapsWeb(delays, decays)];
      },
    },
  },
  telephone: {
    label: "Telephone",
    category: "Voice changer",
    description: "Phone-call voice: 300–3400 Hz band, nasal mid bump and a little grit (0..1 distortion).",
    params: [P("grit", "Grit", 0, 1, 0.05, 0.3)],
    ffmpeg: (e) => [...pass2("highpass", 300), ...pass2("lowpass", 3400), peq(1700, 1, 5), ...softClip(0.5 + 4 * audioParamValue(e, "grit")), "volume=0.8"],
    preview: {
      webaudio: (e) => [
        ...pass2Web("highpass", 300), ...pass2Web("lowpass", 3400), peqWeb(1700, 1, 5),
        { kind: "shaper", drive: 0.5 + 4 * audioParamValue(e, "grit") }, { kind: "gain", gain: 0.8 },
      ],
    },
  },
  megaphone: {
    label: "Megaphone",
    category: "Voice changer",
    description: "Loudhailer / bullhorn voice: narrow 500–4000 Hz horn band, honky 2 kHz peak and hard drive (grit 0..1).",
    params: [P("grit", "Grit", 0, 1, 0.05, 0.6)],
    ffmpeg: (e) => [...pass2("highpass", 500), ...pass2("lowpass", 4000), peq(2000, 1.2, 8), ...softClip(2 + 8 * audioParamValue(e, "grit")), "volume=0.7"],
    preview: {
      webaudio: (e) => [
        ...pass2Web("highpass", 500), ...pass2Web("lowpass", 4000), peqWeb(2000, 1.2, 8),
        { kind: "shaper", drive: 2 + 8 * audioParamValue(e, "grit") }, { kind: "gain", gain: 0.7 },
      ],
    },
  },
  underwater: {
    label: "Underwater",
    category: "Voice changer",
    description: "Muffled, wobbling underwater sound: muffle = low-pass cutoff (Hz), wobble 0..1 = pitch wobble depth.",
    params: [P("muffle", "Muffle", 200, 1500, 10, 500, " Hz"), P("wobble", "Wobble", 0, 1, 0.05, 0.5)],
    ffmpeg: (e) => {
      const w = audioParamValue(e, "wobble");
      const out = [...pass2("lowpass", audioParamValue(e, "muffle")), "volume=1.4"];
      if (w > 0) out.push(...vibratoSteps(1.6, w));
      return out;
    },
    preview: {
      webaudio: (e) => {
        const w = audioParamValue(e, "wobble");
        const out: AudioNodeSpec[] = [...pass2Web("lowpass", audioParamValue(e, "muffle")), { kind: "gain", gain: 1.4 }];
        // FFmpeg vibrato sweeps a 5 ms delay line: 0..d·5 ms, sinusoidally.
        if (w > 0) out.push({ kind: "vibrato", rate: 1.6, depth: w * 0.005 });
        return out;
      },
    },
  },
};

/** Every audio effect, in AUDIO_EFFECT_TYPE_IDS order. */
export const AUDIO_EFFECTS: readonly AudioEffectDef[] = AUDIO_EFFECT_TYPE_IDS.map((type) => ({ type, ...DEFS[type] }));

const DEF_MAP = new Map<string, AudioEffectDef>(AUDIO_EFFECTS.map((d) => [d.type, d]));

export function audioEffectByType(type: string): AudioEffectDef | undefined {
  return DEF_MAP.get(type);
}

/** The voice-changer presets (the inspector's single "Voice effect" slot). */
export const VOICE_CHANGER_TYPES: readonly AudioEffectType[] = AUDIO_EFFECTS.filter((d) => d.category === "Voice changer").map((d) => d.type);

/** True when an (enabled) effect ends in a loudness stage the engine measures for (normalize, enhance_voice with normalize on). */
export function hasLoudnessStage(e: AudioEffectInput): boolean {
  if (!isAudioEffectEnabled(e)) return false;
  if (e.type === "normalize") return true;
  return e.type === "enhance_voice" && audioParamValue(e, "normalize") >= 0.5;
}

/**
 * The FFmpeg steps that feed effect `effectId`'s loudness stage: every earlier
 * enabled effect in full, then that effect's own steps up to the stage. The
 * engine measures their output to set the stage's gain. Null if the effect has
 * no loudness stage.
 */
export function audioMeasureSteps(filters: readonly AudioEffectInput[], effectId: string, ctx: AudioFfmpegContext = {}): string[] | null {
  const out: string[] = [];
  for (const f of filters) {
    if (!isAudioEffectEnabled(f)) continue;
    const d = DEF_MAP.get(f.type);
    if (!d) continue;
    const steps = d.ffmpeg(f, { ...ctx, measure: effectId });
    if (f.id !== effectId) {
      out.push(...steps);
      continue;
    }
    const at = steps.indexOf(LOUDNESS_PROBE);
    return at < 0 ? null : [...out, ...steps.slice(0, at)];
  }
  return null;
}

/** Types whose `floor` param is the clip's measured noise level (the engine fills it in when omitted). */
export const NOISE_FLOOR_TYPES: readonly AudioEffectType[] = ["noise_reduction", "enhance_voice"];

/** Does this preview need the voice AudioWorklet? */
function needsWorklet(d: AudioEffectDef, e: AudioEffectInput): boolean {
  return d.preview !== "export-only" && d.preview.webaudio(e).some((n) => WORKLET_NODE_KINDS.includes(n.kind));
}

/**
 * The inspector's mark for an effect: "live" (the preview plays it like the
 * export), "approx" (plays all of it, not sample-for-sample), "partial" (plays
 * part of it) or "render" (only the render plays it — also a worklet effect
 * where the voice AudioWorklet is unavailable).
 */
export function audioPreviewFidelity(type: string, env: AudioPreviewEnv = { worklet: true }): AudioPreviewFidelity {
  const d = DEF_MAP.get(type);
  if (!d || d.preview === "export-only") return "render";
  if (!env.worklet && needsWorklet(d, { type })) return "render";
  if (d.preview.partial) return "partial";
  return d.preview.approx ? "approx" : "live";
}

/** True when the effect has no live preview at all (only the FFmpeg render plays it). */
export function audioExactOnly(type: string, env: AudioPreviewEnv = { worklet: true }): boolean {
  return audioPreviewFidelity(type, env) === "render";
}

/** True when the render differs from the live preview (no preview, or only part of it previews). */
export function audioNeedsRender(type: string, env: AudioPreviewEnv = { worklet: true }): boolean {
  const f = audioPreviewFidelity(type, env);
  return f === "render" || f === "partial";
}

/** Bypassed effects (enabled: false) are skipped in export and preview. */
export function isAudioEffectEnabled(e: { enabled?: boolean }): boolean {
  return e.enabled !== false;
}

/** The default params of a new effect of `type`. */
export function audioDefaultsFor(type: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of DEF_MAP.get(type)?.params ?? []) out[p.key] = p.default;
  return out;
}

/**
 * The FFmpeg steps for a clip's audio effect stack, in order. Bypassed and
 * unknown types are skipped (the rpc layer validates the vocabulary). The
 * caller runs them on {@link AUDIO_FX_RATE} audio.
 */
export function audioEffectFilterSteps(filters: readonly AudioEffectInput[] | undefined, ctx: AudioFfmpegContext = {}): string[] {
  const out: string[] = [];
  for (const f of filters ?? []) {
    if (!isAudioEffectEnabled(f)) continue;
    const d = DEF_MAP.get(f.type);
    if (d) out.push(...d.ffmpeg(f, ctx));
  }
  return out;
}

/** The live-preview plan for a clip's audio effect stack. */
export interface AudioPreviewPlan {
  /** Web Audio chain, in order (empty = play dry). */
  nodes: AudioNodeSpec[];
  /** Stable signature of `nodes`: the renderer rebuilds a chain only when it changes. */
  sig: string;
  /** Enabled effects the preview can't (fully) play — the render is exact. */
  renderOnly: string[];
  /** Enabled effects the preview plays whole but not sample-for-sample (pitch shifter). */
  approx: string[];
  /** True when `nodes` holds voice-AudioWorklet nodes (pitch / robot). */
  worklet: boolean;
}

const EMPTY_PLAN: AudioPreviewPlan = { nodes: [], sig: "", renderOnly: [], approx: [], worklet: false };

/**
 * Build the preview plan (pure — unit-tested by apps/desktop/scripts/smoke-composite.ts).
 * Without the voice AudioWorklet (`env.worklet` false) pitch and robot are render-only.
 */
export function audioPreviewPlan(filters: readonly AudioEffectInput[] | undefined, env: AudioPreviewEnv = { worklet: true }): AudioPreviewPlan {
  if (!filters?.length) return EMPTY_PLAN;
  const nodes: AudioNodeSpec[] = [];
  const renderOnly: string[] = [];
  const approx: string[] = [];
  for (const f of filters) {
    if (!isAudioEffectEnabled(f)) continue;
    const d = DEF_MAP.get(f.type);
    if (!d) continue;
    if (d.preview === "export-only" || (!env.worklet && needsWorklet(d, f))) {
      renderOnly.push(f.type);
      continue;
    }
    if (d.preview.partial) renderOnly.push(f.type);
    else if (d.preview.approx) approx.push(f.type);
    nodes.push(...d.preview.webaudio(f));
  }
  if (!nodes.length && !renderOnly.length) return EMPTY_PLAN;
  return {
    nodes, sig: nodes.length ? JSON.stringify(nodes) : "", renderOnly, approx,
    worklet: nodes.some((n) => WORKLET_NODE_KINDS.includes(n.kind)),
  };
}

// ---- linked audio: which clip carries a clip's sound ------------------------------

/** The clip fields {@link linkedSoundPartners} reads (structurally core's and the renderer's Clip). */
export interface LinkedSoundClip {
  id: string;
  assetId?: string;
  linkGroupId?: string;
  startFrame: number;
  sourceInFrame: number;
  sourceOutFrame: number;
  audioOffsetFrames?: number;
  effects?: { speed?: number; speedRamp?: SpeedRamp };
}

const spanOverlap = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * Timeline frames where a clip's sound plays: its start (+ J/L audio offset)
 * for its timeline length (a speed ramp's length needs `fps`; without it the
 * ramp is ranked by its constant-speed span).
 */
function soundSpan(c: LinkedSoundClip, fps?: number): [number, number] {
  const s = c.startFrame + (c.audioOffsetFrames ?? 0);
  if (fps && hasSpeedRamp(c)) return [s, s + clipFootprintFrames(c, fps)];
  return [s, s + Math.max(1, Math.round((c.sourceOutFrame - c.sourceInFrame) / (c.effects?.speed ?? 1)))];
}

/**
 * The linked clips that can carry `clip`'s sound (same link group, same
 * asset, not `clip` itself), best first: the most SOURCE overlap (the same
 * moments of the recording), then the most timeline overlap, then `group`
 * order. Splitting a linked pair keeps all four halves in ONE group with the
 * same audio effect ids, so the first linked clip can be the other half's
 * audio; only partners that overlap `clip` are returned while any does
 * (non-overlapping ones only when none does). The engine (audioCarrier,
 * audioEffectOwner) and the inspector (apps/desktop audiofx.ts) both use it;
 * the caller checks audibility.
 */
export function linkedSoundPartners<C extends LinkedSoundClip>(clip: LinkedSoundClip, group: readonly C[], fps?: number): C[] {
  if (!clip.linkGroupId) return [];
  const [t0, t1] = soundSpan(clip, fps);
  const scored = group
    .filter((m) => m.id !== clip.id && m.linkGroupId === clip.linkGroupId && m.assetId === clip.assetId)
    .map((m, i) => {
      const [m0, m1] = soundSpan(m, fps);
      return { m, i, src: spanOverlap(clip.sourceInFrame, clip.sourceOutFrame, m.sourceInFrame, m.sourceOutFrame), tl: spanOverlap(t0, t1, m0, m1) };
    });
  const overlapping = scored.filter((s) => s.src > 0 || s.tl > 0);
  return (overlapping.length ? overlapping : scored).sort((a, b) => b.src - a.src || b.tl - a.tl || a.i - b.i).map((s) => s.m);
}

// ---- validation (rpc) ---------------------------------------------------------

const fmtN = (n: number) => String(Math.round(n * 1000) / 1000);
const describeParam = (p: AudioEffectParam) =>
  isSwitchParam(p) ? `${p.key} 0|1 (default ${p.default})` : `${p.key} ${fmtN(p.min)}..${fmtN(p.max)} (default ${fmtN(p.default)}${p.unit ?? ""})`;

/** A validated request: values clamped (switches rounded), plus notes on anything adjusted. */
export interface ValidatedAudioEffect {
  params?: Record<string, number>;
  adjusted: string[];
}

/**
 * Validate an audio effect request against the registry: an unknown type or
 * param is rejected with an error that teaches the valid shape; numbers are
 * clamped to their range and switches rounded to 0|1 (each change reported
 * in `adjusted`).
 */
export function validateAudioEffect(req: { type: string; params?: Record<string, number> }): ValidatedAudioEffect {
  const d = DEF_MAP.get(req.type);
  if (!d) throw new Error(`Unknown audio effect type "${req.type}". Valid types: ${AUDIO_EFFECT_TYPE_IDS.join(", ")}.`);
  const adjusted: string[] = [];
  if (req.params === undefined) return { adjusted };
  const keys = Object.keys(req.params);
  const unknown = keys.filter((k) => !d.params.some((p) => p.key === k));
  if (unknown.length) {
    const valid = d.params.length ? `Valid params: ${d.params.map(describeParam).join(", ")}.` : `${d.type} takes no params.`;
    throw new Error(`Unknown param${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")} for ${d.type}. ${valid}`);
  }
  if (!keys.length) return { adjusted };
  const params: Record<string, number> = {};
  for (const p of d.params) {
    const v = req.params[p.key];
    if (v === undefined) continue;
    let c = clampN(v, p.min, p.max);
    if (isSwitchParam(p)) c = c >= 0.5 ? 1 : 0;
    if (c !== v) adjusted.push(`${p.key} ${v} → ${fmtN(c)} (${d.type} ${p.key} is ${isSwitchParam(p) ? "0|1" : `${fmtN(p.min)}..${fmtN(p.max)}`})`);
    params[p.key] = c;
  }
  return { params, adjusted };
}

// ---- AI description -------------------------------------------------------------

/** One line per audio effect for the apply_audio_effect tool description. */
export function describeAudioEffectsForAI(): string {
  return AUDIO_EFFECTS.map((d) => {
    const ctl = d.params.length ? `params {${d.params.map(describeParam).join(", ")}}` : "no controls";
    const pv = d.preview === "export-only" ? " [render-only]" : d.preview.approx ? " [live preview approximate]" : "";
    return `- ${d.type} (${d.category}): ${d.description} ${ctl}.${pv}`;
  }).join("\n");
}
