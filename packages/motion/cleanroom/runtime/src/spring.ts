// spring() and measureSpring() (SPEC sections 6 and 7).
//
// The model is this runtime's own: the closed-form solution of a mass-spring-damper released at
// rest from `from`, with the damping ratio capped at 1 (critical damping). Overdamped settings
// therefore behave like a critically damped spring, which settles quickly instead of creeping
// towards the target. With this model measureSpring({fps: 30, config: {damping: 200}}) is 23, the
// value SPEC section 7 documents.

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

export function readSpringPhysics(config: unknown, where: string): SpringPhysics {
  if (config === undefined || config === null) config = {};
  check(typeof config === "object", where, "config must be an object.");
  const c = config as Partial<Record<keyof SpringConfig, unknown>>;
  const mass = finiteOr(c.mass, 1, where, "config.mass");
  const damping = finiteOr(c.damping, 10, where, "config.damping");
  const stiffness = finiteOr(c.stiffness, 100, where, "config.stiffness");
  check(mass > 0, where, "config.mass must be greater than 0.");
  check(stiffness > 0, where, "config.stiffness must be greater than 0.");
  check(damping >= 0, where, "config.damping must be 0 or more.");
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
 * after it, the spring stays within the threshold. Infinity for an undamped spring.
 */
export function springSettleTime(p: SpringPhysics, threshold: number): number {
  if (threshold >= 1) return 0;
  const { omega, zeta } = p;
  const outside = (t: number) => Math.abs(springDisplacement(p, t)) >= threshold;
  if (zeta >= 1) {
    // The critically damped curve approaches the target monotonically.
    let hi = 1 / omega;
    while (outside(hi)) hi *= 2;
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

/** Smallest whole frame from which every later frame is within `threshold` of the target. */
export function settleFrame(p: SpringPhysics, fps: number, threshold: number): number {
  const t = springSettleTime(p, threshold);
  if (!Number.isFinite(t)) return Infinity;
  let frame = Math.floor(t * fps + 1e-9);
  while (frame >= 0 && Math.abs(springDisplacement(p, frame / fps)) <= threshold) frame--;
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
  return settleFrame(physics, fps, threshold);
}

export function spring(options: SpringOptions): number {
  const where = "spring()";
  check(typeof options === "object" && options !== null, where, "pass an options object such as { frame, fps }.");
  const { frame } = options;
  check(typeof frame === "number" && Number.isFinite(frame), where, `frame must be a finite number, but got ${describeValue(frame)}.`);
  const fps = positive(options.fps, where, "fps");
  const from = finiteOr(options.from, 0, where, "from");
  const to = finiteOr(options.to, 1, where, "to");
  const delay = finiteOr(options.delay, 0, where, "delay");
  const reverse = options.reverse ?? false;
  check(typeof reverse === "boolean", where, "reverse must be true or false.");
  const physics = readSpringPhysics(options.config, where);

  // Seconds of the natural curve per frame, and the curve's length in frames (for reverse).
  let secondsPerFrame = 1 / fps;
  let length = 0;
  if (options.durationInFrames !== undefined) {
    const stretchTo = positive(options.durationInFrames, where, "durationInFrames");
    const rest = options.durationRestThreshold ?? DEFAULT_REST_THRESHOLD;
    check(
      typeof rest === "number" && rest > 0 && rest < 1,
      where,
      `durationRestThreshold must be a number between 0 and 1, but got ${describeValue(rest)}.`,
    );
    const natural = springSettleTime(physics, rest);
    check(Number.isFinite(natural), where, "this spring has no damping, so it never settles and cannot be stretched to a duration.");
    secondsPerFrame = natural / stretchTo;
    length = stretchTo;
  } else if (reverse) {
    length = settleFrame(physics, fps, DEFAULT_REST_THRESHOLD);
    check(Number.isFinite(length), where, "this spring has no damping, so it never ends and cannot be reversed.");
  }

  // Stretch, then reverse, then delay (SPEC section 6, "Order of operations").
  let position = frame - delay;
  if (reverse) position = length - position;
  const u = position <= 0 ? -1 : springDisplacement(physics, position * secondsPerFrame);
  let value = from + (to - from) * (1 + u);
  if (physics.overshootClamping && (to >= from ? value > to : value < to)) value = to;
  return value;
}
