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
 *
 * ## Ramp frames (anchored rounding)
 * Frame decisions use the curve's OWN timeline G (∫ ds / v from its first
 * point — a fixed origin that trims, splits and bake re-bases keep), not the
 * clip's: asset second s starts playing in curve slot
 *   slot(s) = floor(G(s) · fps + 0.5 + phase + RAMP_TIE_EPS)
 * and a clip plays slots [slot(in), slot(out)), so its footprint is
 * slot(out) − slot(in) frames and the two halves of a split add up to the
 * whole EXACTLY (they share slot(cut)). Output frame n of the clip shows the
 * last source frame k with slot(k) − slot(in) ≤ n; the export's setpts
 * computes the same slot (rampSetptsExpr), so the model is exact.
 * RAMP_TIE_EPS keeps the decision off exact half-frame ties (a flat 2x curve
 * has them at every other frame), where FFmpeg's and JavaScript's float
 * rounding could disagree. `phase` (0..1 frame, absent = 0) only exists so a
 * reverse can keep the clip's footprint (setRampPhaseFor).
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

/**
 * How a speed change (set_clip_speed, set_speed_ramp, clear_speed_ramp,
 * clear_clip_effects) moves the rest of the timeline (engine.changeSpeed):
 * "track" (default) = the clips after it on its own track and on its linked
 * partners' tracks; "all" = also every other track and the markers, from the
 * clip's old end; "none" = in place, nothing moves.
 */
export const SPEED_RIPPLE_MODES = ["track", "all", "none"] as const;
export type SpeedRipple = (typeof SPEED_RIPPLE_MODES)[number];

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
  /**
   * Rounding phase of the curve's frame slots, in frames [0, 1) (absent = 0;
   * see "Ramp frames"). Set only by an edit that re-bases the curve and must
   * keep the clip's footprint (reverse mirrors it); a new curve drops it.
   */
  phase?: number;
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

// ---- ramp frames (anchored rounding) ----------------------------------------

/**
 * How far past an exact half-frame a ramp's frame decision sits, in frames
 * (see "Ramp frames"): keeps it off exact ties — a flat 2x curve has one at
 * every other source frame — where FFmpeg's and JavaScript's float rounding
 * could pick different sides. Far above float error (~1e-9 frames even for an
 * hour of asset at 0.1x), far below any real timing.
 */
export const RAMP_TIE_EPS = 1e-6;

/** A ramp's rounding phase in [0, 1) frames (absent / invalid = 0). */
export function rampPhase(ramp: SpeedRamp | undefined): number {
  const p = ramp?.phase;
  return typeof p === "number" && Number.isFinite(p) ? p - Math.floor(p) : 0;
}

/** The curve slot (project frames on the curve's own timeline) in which asset second `s` starts to play. */
export function curveSlot(c: SpeedCurve, s: number, fps: number, phase = 0): number {
  return Math.floor(curveG(c, s) * fps + 0.5 + phase + RAMP_TIE_EPS);
}

/**
 * A ramped clip's frames: the ONE rounding the footprint, splits and cuts,
 * the export's setpts (rampSetptsExpr), freeze_frame and the preview share.
 */
export interface RampFrameModel {
  curve: SpeedCurve;
  phase: number;
  /** Curve slot of the clip's source-in = its local frame 0. */
  anchor: number;
  /** Footprint in project frames (>= 1). */
  frames: number;
  /** Clip-local frame in which an asset second starts playing (slot − anchor; outside the trim it extrapolates). */
  localAt(srcSec: number): number;
  /** The first asset second that plays in clip-local frame `n` (continuous; inverse of localAt). */
  sourceAtFrameStart(n: number): number;
  /** The source frame (project frames, inside the trim) the export shows at clip-local frame `n`. */
  shownAt(n: number): number;
  /**
   * Asset second for clip-local timeline second `t`, CONTINUOUS and centred on
   * the export's frames (at the middle of local frame n it reaches the start
   * of the source frame the export holds through n) — for live playback.
   */
  sourceAt(t: number): number;
}

/** The frame model of a clip with a speed ramp (see "Ramp frames"). */
export function rampFrameModel(clip: SpeedClip, fps: number): RampFrameModel {
  const ramp = clip.effects!.speedRamp!;
  const curve = buildSpeedCurve(ramp.points);
  const phase = rampPhase(ramp);
  const inF = clip.sourceInFrame;
  const last = Math.max(inF, clip.sourceOutFrame - 1);
  const anchor = curveSlot(curve, inF / fps, fps, phase);
  const frames = Math.max(1, curveSlot(curve, clip.sourceOutFrame / fps, fps, phase) - anchor);
  const localAt = (s: number) => curveSlot(curve, s, fps, phase) - anchor;
  // slot(s) >= anchor + n  ⟺  G(s)·fps >= anchor + n − 0.5 − phase − EPS
  const sourceAtFrameStart = (n: number) => curveInvG(curve, (anchor + n - 0.5 - phase - RAMP_TIE_EPS) / fps);
  const shownAt = (n: number) => {
    // The last frame k with localAt(k) <= n: estimate through the inverse, then settle on the exact slots.
    let k = clamp(Math.ceil(sourceAtFrameStart(n + 1) * fps - 1e-9) - 1, inF, last);
    while (k > inF && localAt(k / fps) > n) k--;
    while (k < last && localAt((k + 1) / fps) <= n) k++;
    return k;
  };
  return {
    curve,
    phase,
    anchor,
    frames,
    localAt,
    sourceAtFrameStart,
    shownAt,
    sourceAt: (t) => curveInvG(curve, (anchor + t * fps - phase) / fps),
  };
}

/**
 * The rounding phase that gives a ramped clip `frames` frames, or undefined
 * when its curve cannot (the footprint of a curve window is always the floor
 * or the ceiling of its continuous length — any phase picks one of the two).
 * Prefers the clip's current phase. For an edit that re-bases a curve and
 * must keep the clip's length (reverse mirrors the curve).
 */
export function rampPhaseFor(clip: SpeedClip, frames: number, fps: number): number | undefined {
  const ramp = clip.effects?.speedRamp;
  if (!ramp?.points?.length) return undefined;
  const curve = buildSpeedCurve(ramp.points);
  const a = curveG(curve, clip.sourceInFrame / fps) * fps + 0.5 + RAMP_TIE_EPS;
  const b = curveG(curve, clip.sourceOutFrame / fps) * fps + 0.5 + RAMP_TIE_EPS;
  const count = (p: number) => Math.max(1, Math.floor(b + p) - Math.floor(a + p));
  const cur = rampPhase(ramp);
  if (count(cur) === frames) return cur;
  // floor(a + p) / floor(b + p) step where p crosses 1 − frac(a) / 1 − frac(b): try the middle of each interval.
  const fr = (x: number) => x - Math.floor(x);
  const cuts = [0, fr(1 - fr(a)), fr(1 - fr(b)), 1].sort((x, y) => x - y);
  for (let i = 1; i < cuts.length; i++) {
    if (cuts[i] - cuts[i - 1] < 1e-6) continue;
    const p = r6((cuts[i - 1] + cuts[i]) / 2);
    if (count(p) === frames) return p;
  }
  return undefined;
}

/**
 * Timeline footprint of a clip in project frames. Constant speed: EXACTLY the
 * pre-ramp formula, max(1, round((out − in) / speed)). Ramp: the anchored
 * slots, max(1, slot(out) − slot(in)) — additive over splits.
 */
export function clipFootprintFrames(clip: SpeedClip, fps: number): number {
  if (!hasSpeedRamp(clip)) {
    const speed = clip.effects?.speed ?? 1;
    return Math.max(1, Math.round((clip.sourceOutFrame - clip.sourceInFrame) / speed));
  }
  return rampFrameModel(clip, fps).frames;
}

/**
 * Source frame (project frames) at a clip-local TIMELINE frame — where a split
 * or cut lands in the source. Constant: in + round(local · speed), as before.
 * Ramp: the source frame whose start is nearest local frame `localFrame`.
 */
export function sourceFrameAtLocalFrame(clip: SpeedClip, localFrame: number, fps: number): number {
  if (!hasSpeedRamp(clip)) return clip.sourceInFrame + Math.round(localFrame * (clip.effects?.speed ?? 1));
  return Math.round(rampFrameModel(clip, fps).sourceAtFrameStart(localFrame) * fps);
}

/**
 * Clip-local TIMELINE frame at which an asset second plays (locate, transcript
 * cuts, captions). Constant: round(((s − in) / speed) · fps), as before. Ramp:
 * the anchored slot, so a piece ending at source frame S is exactly
 * localFrameAtSource(S) frames long.
 */
export function localFrameAtSource(clip: SpeedClip, srcSec: number, fps: number): number {
  if (!hasSpeedRamp(clip)) return Math.round(((srcSec - clip.sourceInFrame / fps) / (clip.effects?.speed ?? 1)) * fps);
  return rampFrameModel(clip, fps).localAt(srcSec);
}

/**
 * A source video stream's clock, for modelling FFmpeg's integer timestamps:
 * its timebase (`tbNum` / `tbDen` seconds per tick) and frame rate
 * (`rateNum` / `rateDen` frames per second).
 */
export interface FrameClock {
  tbNum: number;
  tbDen: number;
  rateNum: number;
  rateDen: number;
}

/** An FFmpeg rate option string (what graph.ts writes for `fps=`) as av_parse_video_rate reads it: an exact decimal ratio. */
function rateRatio(fps: number): [bigint, bigint] {
  const str = String(fps);
  if (!/^\d+(\.\d+)?$/.test(str)) return [BigInt(Math.round(fps * 1000)), 1000n];
  const [i, f = ""] = str.split(".");
  return [BigInt(i + f), 10n ** BigInt(f.length)];
}

/**
 * The source frame (project frames, inside the trim) the RENDERER shows at
 * clip-local output frame `localFrame`. A ramp: exactly the export's choice
 * (RampFrameModel.shownAt — the last source frame whose slot has begun; the
 * stream's timebase does not matter, see rampSetptsExpr). Constant speed: the
 * fps filter's pick after setpts=(PTS-STARTPTS)/speed — the last frame k whose
 * retimed timestamp, truncated to the stream's integer timebase by setpts,
 * rounds (half away from zero) to <= n. With the source's `clock` that is
 * FFmpeg's exact integer arithmetic; without it, a timebase step that splits a
 * frame evenly (every mp4 / mov / mkv / webm at 24, 25, 30, 50, 60 fps) — a
 * 29.97 fps stream on a 1/30000 or 1/90000 timebase breaks exact half-frame
 * ties (2x, 4x) the other way. Assumes the source frame rate is the project's.
 */
export function sourceFrameShownAt(clip: SpeedClip, localFrame: number, fps: number, clock?: FrameClock): number {
  if (hasSpeedRamp(clip)) return rampFrameModel(clip, fps).shownAt(localFrame);
  const speed = constantSpeed(clip);
  const last = Math.max(clip.sourceInFrame, clip.sourceOutFrame - 1);
  if (!clock) {
    // j / speed rounds (half away from zero) to <= n  ⟺  j / speed < n + 0.5.
    const j = Math.ceil((localFrame + 0.5) * speed - 1e-9) - 1;
    return clamp(clip.sourceInFrame + j, clip.sourceInFrame, last);
  }
  // Frame j's timestamp is j·step ticks; setpts truncates (j·step)/speed (a double, as FFmpeg computes it)
  // to an integer; fps rescales that to 1/fps with AV_ROUND_NEAR_INF — exact integer maths.
  const step = (clock.tbDen * clock.rateDen) / (clock.tbNum * clock.rateNum);
  const [fN, fD] = rateRatio(fps);
  const tbN = BigInt(clock.tbNum);
  const tbD = BigInt(clock.tbDen);
  const slot = (j: number): number => {
    const t = BigInt(Math.trunc(Math.round(j * step) / speed));
    const num = t * tbN * fN;
    const den = tbD * fD;
    return Number((2n * num + den) / (2n * den)); // round half up (t >= 0)
  };
  let lo = 0;
  let hi = last - clip.sourceInFrame;
  if (slot(lo) > localFrame) return clip.sourceInFrame;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (slot(mid) <= localFrame) lo = mid;
    else hi = mid - 1;
  }
  return clip.sourceInFrame + lo;
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
 * the clip-local frame slot(sourceIn + X) − slot(sourceIn) of the shared frame
 * model ("Ramp frames"), so the export shows exactly RampFrameModel.shownAt.
 * G is a nested if() over the curve's segments that touch [0, span], each the
 * closed form above (log for a sloped piece, linear for a flat one), with
 * constant extension beyond the first / last point. The frame is decided by
 * floor() in double precision BEFORE setpts truncates to the stream's integer
 * timebase, and is output a quarter frame into its slot, so neither that
 * truncation nor the fps filter's rounding can move it; several source frames
 * in one slot share its timestamp and the fps filter keeps the last one.
 */
export function rampSetptsExpr(ramp: SpeedRamp, sourceIn: number, sourceSpan: number, fps: number): string {
  const c = buildSpeedCurve(ramp.points);
  const phase = rampPhase(ramp);
  const anchor = curveSlot(c, sourceIn, fps, phase);
  const X = "(PTS-STARTPTS)*TB";
  const n = c.xs.length;
  // Pieces in clip-relative source seconds: [lo, hi) with an expression of G (the curve's own timeline) each.
  const pieces: { hi: number; expr: string }[] = [];
  const lin = (x0: number, t0: number, v: number) => `(${fnum(t0)}+(${X}-(${fnum(x0)}))/${fnum(v)})`;
  // Before the first knot.
  pieces.push({ hi: c.xs[0] - sourceIn, expr: lin(c.xs[0] - sourceIn, c.gs[0], c.vs[0]) });
  for (let k = 0; k + 1 < n; k++) {
    const x0 = c.xs[k] - sourceIn;
    const t0 = c.gs[k];
    const v0 = c.vs[k];
    const b = c.bs[k];
    const d = c.xs[k + 1] - c.xs[k];
    const expr = Math.abs((b * d) / v0) < 1e-12 ? lin(x0, t0, v0) : `(${fnum(t0)}+log(1+${fnum(b / v0)}*(${X}-(${fnum(x0)})))/${fnum(b)})`;
    pieces.push({ hi: c.xs[k + 1] - sourceIn, expr });
  }
  pieces.push({ hi: Infinity, expr: lin(c.xs[n - 1] - sourceIn, c.gs[n - 1], c.vs[n - 1]) });
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
  const f = fnum(fps);
  return `(max(floor(${expr}*${f}+${fnum(0.5 + phase + RAMP_TIE_EPS)})-(${anchor}),0)+0.25)/${f}/TB`;
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
