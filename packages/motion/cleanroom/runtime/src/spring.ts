// spring() and measureSpring() (SPEC sections 6 and 7).
//
// The model is this runtime's own: the closed-form solution of a mass-spring-damper released at
// rest from `from`, with the damping ratio capped at 1 (critical damping). Overdamped settings
// therefore behave like a critically damped spring, which settles quickly instead of creeping
// towards the target. With this model measureSpring({fps: 30, config: {damping: 200}}) is 23, the
// value SPEC section 7 documents. The time rules below (64 ms per frame at most, stretching by a
// whole number of frames, `to` after a stretched spring ends) follow the values the parity
// rounds observed (NOTES.md section 5.13).

import { describeValue, misuse } from "./errors";

export interface SpringConfig {
  mass: number;
  damping: number;
  stiffness: number;
  overshootClamping: boolean;
}

export interface SpringOptions {
  frame: number;
  fps: number;
  config?: Partial<SpringConfig>;
  from?: number;
  to?: number;
  reverse?: boolean;
  durationInFrames?: number;
  durationRestThreshold?: number;
  delay?: number;
}

export interface MeasureSpringOptions {
  fps: number;
  config?: Partial<SpringConfig>;
  threshold?: number;
  /** Deprecated; does not change the result. */
  from?: number;
  /** Deprecated; does not change the result. */
  to?: number;
}

/** The rest threshold used where none is given (measureSpring's documented default). */
export const DEFAULT_REST_THRESHOLD = 0.005;

/** A frame never advances the spring by more than this many seconds, however low the fps. */
export const MAX_SECONDS_PER_FRAME = 0.064;

export function secondsPerFrame(fps: number): number {
  return Math.min(1 / fps, MAX_SECONDS_PER_FRAME);
}

export interface SpringPhysics {
  /** Natural angular frequency, rad/s. */
  omega: number;
  /** Damping ratio, capped at 1. */
  zeta: number;
  overshootClamping: boolean;
}

function check(cond: boolean, where: string, message: string): void {
  if (!cond) throw misuse(`${where}: ${message}`);
}

function finiteOr(value: unknown, fallback: number, where: string, name: string): number {
  if (value === undefined) return fallback;
  check(typeof value === "number" && Number.isFinite(value), where, `${name} must be a finite number, but got ${describeValue(value)}.`);
  return value as number;
}

/** Any number is accepted; out-of-range values give whatever the formulas give (NaN, a still spring). */
function numberOr(value: unknown, fallback: number, where: string, name: string): number {
  if (value === undefined) return fallback;
  check(typeof value === "number", where, `${name} must be a number, but got ${describeValue(value)}.`);
  return value as number;
}

export function readSpringPhysics(config: unknown, where: string): SpringPhysics {
  if (config === undefined || config === null) config = {};
  check(typeof config === "object", where, "config must be an object.");
  const c = config as Partial<Record<keyof SpringConfig, unknown>>;
  const mass = numberOr(c.mass, 1, where, "config.mass");
  const damping = numberOr(c.damping, 10, where, "config.damping");
  const stiffness = numberOr(c.stiffness, 100, where, "config.stiffness");
  const clamping = c.overshootClamping ?? false;
  check(typeof clamping === "boolean", where, "config.overshootClamping must be true or false.");
  return {
    omega: Math.sqrt(stiffness / mass),
    zeta: Math.min(1, damping / (2 * Math.sqrt(stiffness * mass))),
    overshootClamping: clamping as boolean,
  };
}

/** Signed distance to the target, as a share of the full distance: -1 at t <= 0, then towards 0. */
export function springDisplacement(p: SpringPhysics, t: number): number {
  if (t <= 0) return -1;
  const { omega, zeta } = p;
  if (zeta >= 1) return -(1 + omega * t) * Math.exp(-omega * t);
  const decay = zeta * omega;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  return -Math.exp(-decay * t) * (Math.cos(wd * t) + (decay / wd) * Math.sin(wd * t));
}

function bisect(lo: number, hi: number, outside: (t: number) => boolean): number {
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (outside(mid)) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The last time (seconds) at which the spring is `threshold` or more away from its target;
 * after it, the spring stays within the threshold. Infinity for an undamped spring, NaN when
 * the config makes the curve undefined.
 */
export function springSettleTime(p: SpringPhysics, threshold: number): number {
  if (threshold >= 1) return 0;
  const { omega, zeta } = p;
  // A spring without stiffness never moves; a config that makes the curve NaN has no settle time.
  if (omega === 0) return Infinity;
  if (!(omega > 0) || !Number.isFinite(omega) || Number.isNaN(zeta)) return Number.NaN;
  const outside = (t: number) => Math.abs(springDisplacement(p, t)) >= threshold;
  if (zeta >= 1) {
    // The critically damped curve approaches the target monotonically.
    let hi = 1 / omega;
    while (outside(hi) && hi < 1e12) hi *= 2;
    return bisect(0, hi, outside);
  }
  if (zeta <= 0) return Infinity;
  // The underdamped curve peaks (in distance from the target) at t_k = k * pi / wd, with
  // distance exp(-decay * t_k). The last peak at or over the threshold is followed by a single
  // crossing of the threshold before the next, smaller peak.
  const decay = zeta * omega;
  const halfPeriod = Math.PI / (omega * Math.sqrt(1 - zeta * zeta));
  const k = Math.floor(Math.log(1 / threshold) / (decay * halfPeriod));
  return bisect(k * halfPeriod, (k + 1) * halfPeriod, outside);
}

/**
 * Smallest whole frame from which every later frame is within `threshold` of the target, with
 * frames `dt` seconds apart.
 */
export function settleFrame(p: SpringPhysics, dt: number, threshold: number): number {
  const t = springSettleTime(p, threshold);
  if (!Number.isFinite(t)) return t;
  let frame = Math.floor(t / dt + 1e-9);
  while (frame >= 0 && Math.abs(springDisplacement(p, frame * dt)) <= threshold) frame--;
  return frame + 1;
}

function positive(value: unknown, where: string, name: string): number {
  check(
    typeof value === "number" && Number.isFinite(value) && value > 0,
    where,
    `${name} must be a positive, finite number, but got ${describeValue(value)}.`,
  );
  return value as number;
}

export function measureSpring(options: MeasureSpringOptions): number {
  const where = "measureSpring()";
  check(typeof options === "object" && options !== null, where, "pass an options object such as { fps, config }.");
  const fps = positive(options.fps, where, "fps");
  const threshold = options.threshold === undefined ? DEFAULT_REST_THRESHOLD : positive(options.threshold, where, "threshold");
  const physics = readSpringPhysics(options.config, where);
  return settleFrame(physics, secondsPerFrame(fps), threshold);
}

/** The double next to `to` on the side of `from`. */
function justShortOf(to: number, from: number): number {
  const bits = new DataView(new ArrayBuffer(8));
  if (to === 0) return from > 0 ? Number.MIN_VALUE : -Number.MIN_VALUE;
  bits.setFloat64(0, to);
  const raw = bits.getBigUint64(0);
  // Moving towards zero decrements the magnitude bits; moving away increments them.
  const towardZero = (from < to) === (to > 0);
  bits.setBigUint64(0, towardZero ? raw - 1n : raw + 1n);
  return bits.getFloat64(0);
}

export function spring(options: SpringOptions): number {
  const where = "spring()";
  check(typeof options === "object" && options !== null, where, "pass an options object such as { frame, fps }.");
  const { frame } = options;
  check(typeof frame === "number" && Number.isFinite(frame), where, `frame must be a finite number, but got ${describeValue(frame)}.`);
  const fps = positive(options.fps, where, "fps");
  const from = finiteOr(options.from, 0, where, "from");
  const to = finiteOr(options.to, 1, where, "to");
  const delay = numberOr(options.delay, 0, where, "delay");
  const reverse = options.reverse ?? false;
  check(typeof reverse === "boolean", where, "reverse must be true or false.");
  const physics = readSpringPhysics(options.config, where);
  const dt = secondsPerFrame(fps);

  // Natural frames per requested frame, and the curve's length in requested frames (for reverse).
  let scale = 1;
  let length = 0;
  let stretchedTo: number | null = null;
  if (options.durationInFrames !== undefined) {
    stretchedTo = positive(options.durationInFrames, where, "durationInFrames");
    const rest = numberOr(options.durationRestThreshold, DEFAULT_REST_THRESHOLD, where, "durationRestThreshold");
    check(rest > 0, where, `durationRestThreshold must be greater than 0, but got ${describeValue(rest)}.`);
    const natural = settleFrame(physics, dt, rest);
    check(natural !== Infinity, where, "this spring has no damping, so it never settles and cannot be stretched to a duration.");
    scale = natural / stretchedTo;
    length = stretchedTo;
  } else if (reverse) {
    length = settleFrame(physics, dt, DEFAULT_REST_THRESHOLD);
    check(length !== Infinity, where, "this spring has no damping, so it never ends and cannot be reversed.");
  }

  // Stretch, then reverse, then delay (SPEC section 6, "Order of operations").
  let position = frame - delay;
  if (reverse) position = length - position;
  // A stretched spring is over after its duration: from then on it is exactly `to`.
  if (stretchedTo !== null && position > stretchedTo) return to;
  // Before the start (including a NaN delay) the spring holds its starting value.
  const u = position > 0 ? springDisplacement(physics, position * scale * dt) : -1;
  let value = from + (to - from) * (1 + u);
  if (physics.overshootClamping && (to >= from ? value > to : value < to)) return to;
  // An unstretched spring approaches `to` without reaching it, even when the remaining distance is
  // below floating-point precision.
  if (stretchedTo === null && value === to && from !== to && position > 0) value = justShortOf(to, from);
  return value;
}
