// Easing functions (SPEC section 8). Where SPEC gives no formula, the formulas are this runtime's
// own choices (see NOTES.md).

import { describeValue, misuse } from "./errors";
import { DEFAULT_REST_THRESHOLD, readSpringPhysics, springDisplacement, springSettleTime } from "./spring";

export type EasingFunction = (t: number) => number;

export interface EasingSpringConfig {
  damping?: number;
  mass?: number;
  stiffness?: number;
  overshootClamping?: boolean;
  durationRestThreshold?: number;
  allowTail?: boolean;
}

/** Easing.spring functions created with allowTail: interpolate() lets them run past their segment. */
const tailEasings = new WeakSet<EasingFunction>();

export function hasTail(easing: EasingFunction): boolean {
  return tailEasings.has(easing);
}

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

function finiteParam(value: unknown, where: string, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw misuse(`${where}: ${name} must be a finite number, but got ${describeValue(value)}.`);
  }
  return value;
}

function checkEasing(easing: unknown, where: string): EasingFunction {
  if (typeof easing !== "function") {
    throw misuse(`${where} needs an easing function such as Easing.quad, but got ${describeValue(easing)}.`);
  }
  return easing as EasingFunction;
}

const linear: EasingFunction = (t) => t;

/** A cubic Bezier timing curve from (0, 0) to (1, 1), like CSS cubic-bezier(). */
function bezier(x1: number, y1: number, x2: number, y2: number): EasingFunction {
  const where = "Easing.bezier()";
  for (const [value, name] of [[x1, "x1"], [y1, "y1"], [x2, "x2"], [y2, "y2"]] as const) finiteParam(value, where, name);
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
    throw misuse(`${where}: x1 and x2 must be between 0 and 1, since time cannot run backwards.`);
  }
  if (x1 === y1 && x2 === y2) return linear;
  // Each axis as the polynomial ((a s + b) s + c) s over the curve parameter s in [0, 1].
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const xAt = (s: number) => ((ax * s + bx) * s + cx) * s;
  const yAt = (s: number) => ((ay * s + by) * s + cy) * s;
  const dxAt = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  const paramFor = (x: number): number => {
    let s = x;
    for (let i = 0; i < 8; i++) {
      const error = xAt(s) - x;
      if (Math.abs(error) < 1e-9) return s;
      const slope = dxAt(s);
      if (Math.abs(slope) < 1e-7) break;
      const next = s - error / slope;
      if (next < 0 || next > 1) break;
      s = next;
    }
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 60; i++) {
      s = (lo + hi) / 2;
      if (xAt(s) < x) lo = s;
      else hi = s;
    }
    return (lo + hi) / 2;
  };
  // Outside 0..1 the curve continues along its end tangents.
  const startSlope = cx > 0 ? cy / cx : x2 > 0 ? y2 / x2 : 1;
  const endSlope = x2 < 1 ? (1 - y2) / (1 - x2) : x1 < 1 ? (1 - y1) / (1 - x1) : 1;
  return (t) => {
    if (t <= 0) return t * startSlope;
    if (t >= 1) return 1 + (t - 1) * endSlope;
    return yAt(paramFor(t));
  };
}

/** Ball-drop bounce: a fall, then three bounces that each keep half the speed. */
function bounceOut(t: number): number {
  const restitution = 0.5;
  const bounces = 3;
  let total = 1;
  for (let k = 1; k <= bounces; k++) total += 2 * restitution ** k;
  const fall = 1 / total;
  t = clamp01(t);
  if (t < fall) return (t / fall) ** 2;
  let start = fall;
  for (let k = 1; k <= bounces; k++) {
    const width = 2 * fall * restitution ** k;
    if (t < start + width || k === bounces) {
      const half = width / 2;
      const offset = (t - start - half) / half;
      const height = restitution ** (2 * k);
      return 1 - height * Math.max(0, 1 - offset * offset);
    }
    start += width;
  }
  return 1;
}

function springEasing(config: EasingSpringConfig = {}): EasingFunction {
  const where = "Easing.spring()";
  if (typeof config !== "object" || config === null) throw misuse(`${where}: config must be an object.`);
  const physics = readSpringPhysics(config, where);
  const rest = config.durationRestThreshold ?? DEFAULT_REST_THRESHOLD;
  if (typeof rest !== "number" || !(rest > 0 && rest < 1)) {
    throw misuse(`${where}: durationRestThreshold must be a number between 0 and 1, but got ${describeValue(rest)}.`);
  }
  const span = springSettleTime(physics, rest);
  if (!Number.isFinite(span)) {
    throw misuse(`${where}: this spring has no damping, so it never settles. Give it some damping.`);
  }
  const allowTail = config.allowTail === true;
  // The spring is stretched so that it comes within `rest` of its end exactly at progress 1.
  const easing: EasingFunction = (t) => {
    if (t <= 0) return 0;
    if (!allowTail && t >= 1) return 1;
    const value = 1 + springDisplacement(physics, t * span);
    return physics.overshootClamping && value > 1 ? 1 : value;
  };
  if (allowTail) tailEasings.add(easing);
  return easing;
}

const step0: EasingFunction = (n) => (n > 0 ? 1 : 0);
const step1: EasingFunction = (n) => (n >= 1 ? 1 : 0);

export const Easing = {
  step0,
  step1,
  linear,
  ease: bezier(0.42, 0, 1, 1),
  quad: ((t) => t * t) as EasingFunction,
  cubic: ((t) => t * t * t) as EasingFunction,
  poly(n: number): EasingFunction {
    finiteParam(n, "Easing.poly()", "n");
    if (n <= 0) throw misuse("Easing.poly(): n must be greater than 0.");
    return (t) => t ** n;
  },
  sin: ((t) => 1 - Math.cos((t * Math.PI) / 2)) as EasingFunction,
  circle: ((t) => {
    const c = clamp01(t);
    return 1 - Math.sqrt(1 - c * c);
  }) as EasingFunction,
  exp: ((t) => (t <= 0 ? 0 : 2 ** (10 * (t - 1)))) as EasingFunction,
  elastic(bounciness = 1): EasingFunction {
    finiteParam(bounciness, "Easing.elastic()", "bounciness");
    if (bounciness < 0) throw misuse("Easing.elastic(): bounciness must be 0 or more.");
    // The cosine is negative (past the target) about `bounciness` times; the envelope shrinks
    // the swings to nothing at t = 1, where the cosine is zero.
    const omega = (bounciness + 0.5) * Math.PI;
    return (t) => {
      const c = clamp01(t);
      return 1 - (1 - c) ** 2 * Math.cos(omega * c);
    };
  },
  back(s = 1.5): EasingFunction {
    finiteParam(s, "Easing.back()", "s");
    // A cubic that dips below 0 before rising to 1; larger s dips further.
    return (t) => t * t * t - s * t * t * (1 - t);
  },
  bounce: ((t) => 1 - bounceOut(1 - t)) as EasingFunction,
  bezier,
  in(easing: EasingFunction): EasingFunction {
    return checkEasing(easing, "Easing.in()");
  },
  out(easing: EasingFunction): EasingFunction {
    const e = checkEasing(easing, "Easing.out()");
    return (t) => 1 - e(1 - t);
  },
  inOut(easing: EasingFunction): EasingFunction {
    const e = checkEasing(easing, "Easing.inOut()");
    return (t) => (t < 0.5 ? e(2 * t) / 2 : 1 - e(2 * (1 - t)) / 2);
  },
  spring: springEasing,
};
