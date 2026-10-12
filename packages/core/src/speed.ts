/**
 * CLIP SPEED → TIME MAPPING: the single source of truth for how a clip's
 * source (asset) time maps onto its timeline time, shared by the engine, the
 * FFmpeg graph builder and the desktop renderer (`@aive/core/speed`) — so the
 * export, the live preview, the timeline and every source↔timeline edit agree.
 *
 * PURE on purpose (like effects/registry.ts): no `node:` imports, no engine
 * imports.
 *
 * ## Constant speed
 * `effects.speed` (0.25..4): timeline = source / speed. Every helper here takes
 * the OLD formula verbatim for a clip without a ramp (no logs or exps), so a
 * constant-speed clip's footprint, cuts and render are exactly what they were.
 *
 * ## Curve speed (speed ramps, CapCut-style)
 * `effects.speedRamp.points` = [{src, speed}] with `src` in ASSET seconds (like
 * bleeps), so trims and splits just window the curve: each half of a split
 * keeps the same anchored points. Speed is piecewise LINEAR in source time
 * between points and CONSTANT beyond the first / last point. A ramp replaces
 * `effects.speed` (setting one clears the other — engine.setClipEffects /
 * setSpeedRamp).
 *
 * With speed v(s), the timeline time of source time s (relative to the clip's
 * source-in) is  τ(s) = ∫ ds / v(s).  On a linear piece v = v0 + b·(s − s0):
 *   ∫ ds / (v0 + b·u) = ln(1 + b·u / v0) / b      (u / v0 when b ≈ 0)
 * and its inverse, for a timeline offset h:
 *   u = v0 · (e^(b·h) − 1) / b                    (v0 · h when b ≈ 0).
 * The clip's footprint is round(τ(sourceOut) · fps) frames.
 */

/** Slowest / fastest speed a ramp point may have. */
export const RAMP_MIN_SPEED = 0.1;
export const RAMP_MAX_SPEED = 10;
/** Most points a ramp may have. */
export const RAMP_MAX_POINTS = 32;

export const RAMP_PRESETS = ["montage", "hero", "bullet", "jump_cut", "flash_in", "flash_out"] as const;
export type RampPreset = (typeof RAMP_PRESETS)[number];

/** What a ramped clip's own audio does: time-stretched (pitch kept) or silent. */
export const RAMP_AUDIO_MODES = ["stretch", "mute"] as const;
export type RampAudio = (typeof RAMP_AUDIO_MODES)[number];

/** One control point of a speed curve. */
export interface SpeedRampPoint {
  /** ASSET seconds (source time, like bleeps). */
  src: number;
  /** Speed at that source time, 0.1..10 (1 = normal). */
  speed: number;
}

/** A clip's speed curve (`effects.speedRamp`). */
export interface SpeedRamp {
  /** Sorted by `src`, at least one point. */
  points: SpeedRampPoint[];
  /** The preset that generated the points (absent = custom). */
  preset?: RampPreset;
  /** The clip's own audio: "stretch" (default, pitch kept) or "mute". */
  audio?: RampAudio;
}

/**
 * The presets, as [u, speed] pairs with u = 0..1 across the clip's CURRENT
 * used source range when the preset is applied (stored as asset seconds).
 */
export const RAMP_PRESET_DEFS: Record<RampPreset, { label: string; description: string; shape: ReadonlyArray<readonly [number, number]> }> = {
  montage: {
    label: "Montage",
    description: "Rhythmic fast/slow pulses: 1x → 3x → 0.5x → 3x → 0.5x → 1x.",
    shape: [[0, 1], [0.2, 3], [0.4, 0.5], [0.6, 3], [0.8, 0.5], [1, 1]],
  },
  hero: {
    label: "Hero",
    description: "Fast (3x), a slow-motion hero beat in the middle (0.3x for the middle 10%), fast again.",
    shape: [[0, 3], [0.35, 3], [0.45, 0.3], [0.55, 0.3], [0.65, 3], [1, 3]],
  },
  bullet: {
    label: "Bullet",
    description: "Real time, then bullet time (0.15x) through the middle, back to real time.",
    shape: [[0, 1], [0.3, 1], [0.45, 0.15], [0.55, 0.15], [0.7, 1], [1, 1]],
  },
  jump_cut: {
    label: "Jump cut",
    description: "Real time with a sudden 8x jump through the middle 20%.",
    shape: [[0, 1], [0.4, 1], [0.5, 8], [0.6, 1], [1, 1]],
  },
  flash_in: {
    label: "Flash in",
    description: "Starts very fast (8x) and lands on real time by 30%.",
    shape: [[0, 8], [0.3, 1], [1, 1]],
  },
  flash_out: {
    label: "Flash out",
    description: "Real time until 70%, then accelerates to 8x at the end.",
    shape: [[0, 1], [0.7, 1], [1, 8]],
  },
};

/** The clip fields the mapping reads (structurally core's and the renderer's Clip). */
export interface SpeedClip {
  sourceInFrame: number;
  sourceOutFrame: number;
  effects?: { speed?: number; speedRamp?: SpeedRamp } | undefined;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Clamp a ramp speed into 0.1..10. */
export function clampRampSpeed(v: number): number {
  return clamp(Number.isFinite(v) ? v : 1, RAMP_MIN_SPEED, RAMP_MAX_SPEED);
}

/** True when the clip plays a speed curve (`effects.speedRamp` with points). */
export function hasSpeedRamp(clip: SpeedClip): boolean {
  return (clip.effects?.speedRamp?.points?.length ?? 0) > 0;
}

/**
 * Validate + canonicalize ramp points: sorted by src, speeds clamped to
 * 0.1..10, values rounded to 1e-6, points closer than 1 ms merged (the later
 * wins). Throws on an empty list, too many points or a non-finite src.
 */
export function normalizeRampPoints(points: readonly SpeedRampPoint[]): SpeedRampPoint[] {
  if (!points.length) throw new Error("A speed ramp needs at least one point.");
  if (points.length > RAMP_MAX_POINTS) throw new Error(`A speed ramp has at most ${RAMP_MAX_POINTS} points (got ${points.length}).`);
  for (const p of points) {
    if (!Number.isFinite(p.src) || !Number.isFinite(p.speed)) throw new Error("Speed ramp points need finite src and speed values.");
  }
  const sorted = [...points].map((p) => ({ src: r6(p.src), speed: r6(clampRampSpeed(p.speed)) })).sort((a, b) => a.src - b.src);
  const out: SpeedRampPoint[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && p.src - last.src < 1e-3) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/** A preset's points across the asset-second range [srcIn, srcOut]. */
export function presetRampPoints(preset: RampPreset, srcIn: number, srcOut: number): SpeedRampPoint[] {
  const def = RAMP_PRESET_DEFS[preset];
  if (!def) throw new Error(`Unknown speed ramp preset "${preset}". Use one of: ${RAMP_PRESETS.join(", ")}.`);
  const span = Math.max(0, srcOut - srcIn);
  return normalizeRampPoints(def.shape.map(([u, speed]) => ({ src: srcIn + u * span, speed })));
}

/** Map normalized points (src 0..1 of [srcIn, srcOut]) to asset seconds. */
export function denormalizeRampPoints(points: readonly SpeedRampPoint[], srcIn: number, srcOut: number): SpeedRampPoint[] {
  return points.map((p) => ({ src: srcIn + clamp(p.src, 0, 1) * (srcOut - srcIn), speed: p.speed }));
}

// ---- the curve ---------------------------------------------------------------

/**
 * A speed curve with precomputed knots: speed `vs[k]` at source `xs[k]`
 * (seconds), and `gs[k]` = ∫ from xs[0] to xs[k] of ds / v(s) (timeline
 * seconds). `bs[k]` = slope of segment k (between knot k and k+1).
 */
export interface SpeedCurve {
  xs: number[];
  vs: number[];
  bs: number[];
  gs: number[];
}

/** ∫_0^d du / (v0 + b·u), for v0 + b·u > 0 on [0, d]. */
function segIntegral(v0: number, b: number, d: number): number {
  const r = (b * d) / v0;
  if (Math.abs(r) < 1e-12) return d / v0;
  return (d / v0) * (Math.log1p(r) / r);
}

/** Inverse of {@link segIntegral}: the source offset u reached after timeline offset h. */
function segInverse(v0: number, b: number, h: number): number {
  const q = b * h;
  if (Math.abs(q) < 1e-12) return v0 * h;
  return v0 * h * (Math.expm1(q) / q);
}

/** Build a curve from (normalized) ramp points. */
export function buildSpeedCurve(points: readonly SpeedRampPoint[]): SpeedCurve {
  const pts = [...points].filter((p) => Number.isFinite(p.src) && Number.isFinite(p.speed)).sort((a, b) => a.src - b.src);
  if (!pts.length) pts.push({ src: 0, speed: 1 });
  const xs: number[] = [];
  const vs: number[] = [];
  for (const p of pts) {
    if (xs.length && p.src - xs[xs.length - 1] < 1e-9) {
      vs[vs.length - 1] = clampRampSpeed(p.speed);
      continue;
    }
    xs.push(p.src);
    vs.push(clampRampSpeed(p.speed));
  }
  const bs: number[] = [];
  const gs: number[] = [0];
  for (let k = 0; k + 1 < xs.length; k++) {
    const d = xs[k + 1] - xs[k];
    const b = (vs[k + 1] - vs[k]) / d;
    bs.push(b);
    gs.push(gs[k] + segIntegral(vs[k], b, d));
  }
  return { xs, vs, bs, gs };
}

/** Speed at source second `s`. */
export function curveSpeedAt(c: SpeedCurve, s: number): number {
  const n = c.xs.length;
  if (s <= c.xs[0]) return c.vs[0];
  if (s >= c.xs[n - 1]) return c.vs[n - 1];
  const k = segIndex(c.xs, s);
  return c.vs[k] + c.bs[k] * (s - c.xs[k]);
}

/** Index k of the segment [xs[k], xs[k+1]) containing s (xs[0] <= s < xs[n-1]). */
function segIndex(xs: number[], s: number): number {
  let lo = 0;
  let hi = xs.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xs[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** G(s) = ∫ from xs[0] to s of du / v(u) (negative before the first knot). */
export function curveG(c: SpeedCurve, s: number): number {
  const n = c.xs.length;
  if (s <= c.xs[0]) return (s - c.xs[0]) / c.vs[0];
  if (s >= c.xs[n - 1]) return c.gs[n - 1] + (s - c.xs[n - 1]) / c.vs[n - 1];
  const k = segIndex(c.xs, s);
  return c.gs[k] + segIntegral(c.vs[k], c.bs[k], s - c.xs[k]);
}

/** Inverse of {@link curveG}: the source second at which G reaches `g`. */
export function curveInvG(c: SpeedCurve, g: number): number {
  const n = c.xs.length;
  if (g <= 0) return c.xs[0] + g * c.vs[0];
  if (g >= c.gs[n - 1]) return c.xs[n - 1] + (g - c.gs[n - 1]) * c.vs[n - 1];
  let lo = 0;
  let hi = n - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c.gs[mid] <= g) lo = mid;
    else hi = mid - 1;
  }
  const u = segInverse(c.vs[lo], c.bs[lo], g - c.gs[lo]);
  return Math.min(c.xs[lo + 1], c.xs[lo] + u);
}

// ---- per-clip time map -------------------------------------------------------

/** How one clip maps source ↔ timeline (seconds). Local = from the clip's start. */
export interface ClipTimeMap {
  ramped: boolean;
  /** Used source range, asset seconds. */
  srcIn: number;
  srcOut: number;
  /** Timeline seconds the used range plays for (continuous; frames = round(duration·fps)). */
  duration: number;
  /** Speed at an asset second. */
  speedAt(src: number): number;
  /** Local timeline seconds at which an asset second plays (extrapolates outside the range). */
  timelineAt(src: number): number;
  /** Asset second shown at a local timeline second (extrapolates outside the range). */
  sourceAt(local: number): number;
}

/** A constant-speed clip's speed (`effects.speed`, default 1). */
export function constantSpeed(clip: SpeedClip): number {
  const s = clip.effects?.speed;
  return s && s > 0 ? s : 1;
}

/** The source ↔ timeline map of a clip (ramp or constant speed). */
export function clipTimeMap(clip: SpeedClip, fps: number): ClipTimeMap {
  const srcIn = clip.sourceInFrame / fps;
  const srcOut = clip.sourceOutFrame / fps;
  const ramp = clip.effects?.speedRamp;
  if (!ramp?.points?.length) {
    const speed = constantSpeed(clip);
    return {
      ramped: false,
      srcIn,
      srcOut,
      duration: (srcOut - srcIn) / speed,
      speedAt: () => speed,
      timelineAt: (s) => (s - srcIn) / speed,
      sourceAt: (t) => srcIn + t * speed,
    };
  }
  const c = buildSpeedCurve(ramp.points);
  const g0 = curveG(c, srcIn);
  return {
    ramped: true,
    srcIn,
    srcOut,
    duration: curveG(c, srcOut) - g0,
    speedAt: (s) => curveSpeedAt(c, s),
    timelineAt: (s) => curveG(c, s) - g0,
    sourceAt: (t) => curveInvG(c, t + g0),
  };
}

/**
 * Timeline footprint of a clip in project frames. Constant speed: EXACTLY the
 * pre-ramp formula, max(1, round((out − in) / speed)). Ramp: max(1,
 * round(τ(out) · fps)).
 */
export function clipFootprintFrames(clip: SpeedClip, fps: number): number {
  if (!hasSpeedRamp(clip)) {
    const speed = clip.effects?.speed ?? 1;
    return Math.max(1, Math.round((clip.sourceOutFrame - clip.sourceInFrame) / speed));
  }
  return Math.max(1, Math.round(clipTimeMap(clip, fps).duration * fps));
}

/**
 * Source frame (project frames) at a clip-local TIMELINE frame — where a split
 * or cut lands in the source. Constant: in + round(local · speed), as before.
 */
export function sourceFrameAtLocalFrame(clip: SpeedClip, localFrame: number, fps: number): number {
  if (!hasSpeedRamp(clip)) return clip.sourceInFrame + Math.round(localFrame * (clip.effects?.speed ?? 1));
  return Math.round(clipTimeMap(clip, fps).sourceAt(localFrame / fps) * fps);
}

/**
 * Clip-local TIMELINE frame at which an asset second plays (locate, transcript
 * cuts, captions). Constant: round(((s − in) / speed) · fps), as before.
 */
export function localFrameAtSource(clip: SpeedClip, srcSec: number, fps: number): number {
  if (!hasSpeedRamp(clip)) return Math.round(((srcSec - clip.sourceInFrame / fps) / (clip.effects?.speed ?? 1)) * fps);
  return Math.round(clipTimeMap(clip, fps).timelineAt(srcSec) * fps);
}

/**
 * The source frame (project frames, inside the trim) the RENDERER shows at
 * clip-local output frame `localFrame` of a ramped clip. Model of the export
 * chain (setpts retime → fps filter): output frame n shows the latest source
 * frame k whose retimed timestamp rounds to <= n, i.e. the largest k with
 * τ(k / fps) < (n + 0.5) / fps  ⟺  k < σ((n + 0.5) / fps) · fps. Assumes the
 * source frame rate is the project's (as freeze_frame does for constant speed).
 */
export function sourceFrameShownAt(clip: SpeedClip, localFrame: number, fps: number): number {
  const map = clipTimeMap(clip, fps);
  const x = (map.sourceAt((localFrame + 0.5) / fps) - map.srcIn) * fps;
  const k = Math.ceil(x - 1e-6) - 1;
  const last = Math.max(clip.sourceInFrame, clip.sourceOutFrame - 1);
  return clamp(clip.sourceInFrame + k, clip.sourceInFrame, last);
}

/** Average speed of a clip over its used range (source span / timeline span) — e.g. for OTIO. */
export function averageSpeed(clip: SpeedClip, fps: number): number {
  const map = clipTimeMap(clip, fps);
  return map.duration > 0 ? (map.srcOut - map.srcIn) / map.duration : constantSpeed(clip);
}

/** Re-base a ramp's points through a source-time map (a bake re-points the clip; reverse mirrors). */
export function mapRampPoints(ramp: SpeedRamp, mapSec: (src: number) => number): SpeedRamp {
  const points = ramp.points.map((p) => ({ src: r6(mapSec(p.src)), speed: p.speed })).sort((a, b) => a.src - b.src);
  return { ...ramp, points };
}

// ---- FFmpeg ------------------------------------------------------------------

/** Plain decimal (no exponent) for an FFmpeg expression. */
function fnum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const s = n.toFixed(12).replace(/\.?0+$/, "");
  return s === "-0" || s === "" ? "0" : s;
}

/**
 * setpts expression (to be single-quoted) that retimes a ramped clip's video:
 * input X = (PTS−STARTPTS)·TB = source seconds since the clip's source-in →
 * output PTS = τ(X) / TB. Nested if() over the curve's segments that touch
 * [0, span], each the closed form above (log for a sloped piece, linear for a
 * flat one), with constant extension beyond the first / last point.
 */
export function rampSetptsExpr(ramp: SpeedRamp, sourceIn: number, sourceSpan: number): string {
  const c = buildSpeedCurve(ramp.points);
  const g0 = curveG(c, sourceIn);
  const X = "(PTS-STARTPTS)*TB";
  const n = c.xs.length;
  // Pieces in clip-relative source seconds: [lo, hi) with an expression each.
  const pieces: { hi: number; expr: string }[] = [];
  const lin = (x0: number, t0: number, v: number) => `(${fnum(t0)}+(${X}-(${fnum(x0)}))/${fnum(v)})`;
  // Before the first knot.
  pieces.push({ hi: c.xs[0] - sourceIn, expr: lin(c.xs[0] - sourceIn, c.gs[0] - g0, c.vs[0]) });
  for (let k = 0; k + 1 < n; k++) {
    const x0 = c.xs[k] - sourceIn;
    const t0 = c.gs[k] - g0;
    const v0 = c.vs[k];
    const b = c.bs[k];
    const d = c.xs[k + 1] - c.xs[k];
    const expr = Math.abs((b * d) / v0) < 1e-12 ? lin(x0, t0, v0) : `(${fnum(t0)}+log(1+${fnum(b / v0)}*(${X}-(${fnum(x0)})))/${fnum(b)})`;
    pieces.push({ hi: c.xs[k + 1] - sourceIn, expr });
  }
  pieces.push({ hi: Infinity, expr: lin(c.xs[n - 1] - sourceIn, c.gs[n - 1] - g0, c.vs[n - 1]) });
  // Only pieces that intersect [0, span] (a tiny margin) matter.
  const lo = -1e-3;
  const hi = sourceSpan + 1e-3;
  const used: { hi: number; expr: string }[] = [];
  let start = -Infinity;
  for (const p of pieces) {
    if (p.hi > lo && start < hi) used.push(p);
    start = p.hi;
  }
  let expr = used[used.length - 1].expr;
  for (let i = used.length - 2; i >= 0; i--) expr = `if(lt(${X},${fnum(used[i].hi)}),${used[i].expr},${expr})`;
  return `${expr}/TB`;
}

/** One constant-tempo chunk of a ramped clip's audio (sample counts at `rate`). */
export interface RampAudioChunk {
  /** Source samples [srcStart, srcEnd) since the clip's source-in. */
  srcStart: number;
  srcEnd: number;
  /** Output samples [outStart, outEnd) since the clip's timeline start. */
  outStart: number;
  outEnd: number;
  /** atempo factor = source samples / output samples (exact chunk duration). */
  tempo: number;
}

/**
 * Split a ramped clip's audio into constant-tempo chunks for the export's
 * "stretch" mode. Boundaries: the curve's knots, then each sloped piece is
 * cut into equal timeline lengths D of at most `maxChunkSec`, short enough
 * that playing a chunk at ONE tempo strays from the curve by at most
 * `maxDriftSec` mid-chunk (a chord of the source(τ) curve: drift ≈ D²·|b|/8
 * timeline seconds for a slope b = dspeed/dsource), while each join costs a
 * small crossfade — so no more chunks than needed. A flat piece stays one
 * chunk. Every boundary is an integer sample in BOTH domains (source rounded,
 * output = round(τ·rate)), so the chunks' tempos make the cumulative audio
 * length match the video mapping to the sample at every boundary. At most
 * `maxChunks` chunks.
 */
export function rampAudioChunks(
  ramp: SpeedRamp,
  sourceIn: number,
  sourceSpan: number,
  rate = 48000,
  maxChunkSec = 0.25,
  maxChunks = 240,
  maxDriftSec = 0.006,
): RampAudioChunk[] {
  const c = buildSpeedCurve(ramp.points);
  const g0 = curveG(c, sourceIn);
  const tl = (x: number) => curveG(c, sourceIn + x) - g0; // relative source s → relative timeline
  const sx = (t: number) => curveInvG(c, t + g0) - sourceIn;
  // Knot boundaries inside (0, span).
  const knots = [0, ...c.xs.map((x) => x - sourceIn).filter((x) => x > 1e-6 && x < sourceSpan - 1e-6), sourceSpan];
  const pieces = knots.slice(1).map((b, i) => {
    const a = knots[i];
    const va = curveSpeedAt(c, sourceIn + a);
    const vb = curveSpeedAt(c, sourceIn + b);
    const slope = Math.abs(vb - va) / Math.max(1e-9, b - a);
    const dur = tl(b) - tl(a);
    const dMax = Math.min(maxChunkSec, Math.sqrt((8 * maxDriftSec) / Math.max(1e-9, slope)));
    const want = Math.abs(vb - va) < 1e-6 * Math.max(va, vb) ? 1 : Math.max(1, Math.ceil(dur / dMax));
    return { a, b, want };
  });
  const total = pieces.reduce((n, p) => n + p.want, 0);
  const scale = total > maxChunks ? maxChunks / total : 1;
  const bounds: number[] = [0];
  for (const p of pieces) {
    const n = Math.max(1, Math.floor(p.want * scale));
    const ta = tl(p.a);
    const tb = tl(p.b);
    for (let i = 1; i < n; i++) bounds.push(sx(ta + ((tb - ta) * i) / n));
    bounds.push(p.b);
  }
  const spanSamples = Math.round(sourceSpan * rate);
  const chunks: RampAudioChunk[] = [];
  let prevSrc = 0;
  let prevOut = 0;
  for (let i = 1; i < bounds.length; i++) {
    const srcEnd = i === bounds.length - 1 ? spanSamples : Math.min(spanSamples, Math.round(bounds[i] * rate));
    const outEnd = Math.round(tl(srcEnd / rate) * rate);
    if (srcEnd - prevSrc < 64 || outEnd - prevOut < 16) {
      // Too short to time-stretch on its own: fold into the next chunk (or the previous one at the end).
      if (i < bounds.length - 1) continue;
      const last = chunks.pop();
      if (last) {
        prevSrc = last.srcStart;
        prevOut = last.outStart;
      }
    }
    chunks.push({ srcStart: prevSrc, srcEnd, outStart: prevOut, outEnd, tempo: (srcEnd - prevSrc) / Math.max(1, outEnd - prevOut) });
    prevSrc = srcEnd;
    prevOut = outEnd;
  }
  return chunks.filter((ch) => ch.srcEnd > ch.srcStart && ch.outEnd > ch.outStart);
}
