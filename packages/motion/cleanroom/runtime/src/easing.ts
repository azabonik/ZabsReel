// Easing functions (SPEC section 8). Where SPEC gives no formula, the formulas are this runtime's
// own choices (see NOTES.md).

import { describeValue, misuse } from "./errors";
import { DEFAULT_REST_THRESHOLD, readSpringPhysics, settleFrame, springDisplacement } from "./spring";

/** Easing.spring measures its physics over this many frames (at as many frames per second). */
const EASING_SPAN_FRAMES = 30;

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

/** Any number, including 0, negative and non-finite values (the formula then decides). */
function numberParam(value: unknown, where: string, name: string): number {
  if (typeof value !== "number") {
    throw misuse(`${where}: ${name} must be a number, but got ${describeValue(value)}.`);
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
  // Outside 0..1 the curve holds its end values (0 before, 1 after).
  if (x1 === y1 && x2 === y2) return (t) => clamp01(t);
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
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
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
  // The spring runs over a span of 30 frames at 30 fps, stretched like spring({durationInFrames: 30}):
  // its whole-frame settle length (for `rest`) is scaled onto the span, so progress 1 is the frame
  // from which it stays within `rest` of its end.
  const settle = settleFrame(physics, 1 / EASING_SPAN_FRAMES, rest);
  if (settle === Infinity) {
    throw misuse(`${where}: this spring has no damping, so it never settles. Give it some damping.`);
  }
  const span = settle / EASING_SPAN_FRAMES; // seconds of the natural curve per unit of progress
  const allowTail = config.allowTail === true;
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
    numberParam(n, "Easing.poly()", "n");
    return (t) => t ** n;
  },
  sin: ((t) => 1 - Math.cos((t * Math.PI) / 2)) as EasingFunction,
  circle: ((t) => {
    const c = clamp01(t);
    return 1 - Math.sqrt(1 - c * c);
  }) as EasingFunction,
  exp: ((t) => 2 ** (10 * (t - 1))) as EasingFunction,
  elastic(bounciness = 1): EasingFunction {
    numberParam(bounciness, "Easing.elastic()", "bounciness");
    // A cubed quarter-cosine envelope (1 at t = 0, 0 at t = 1) times an oscillation of
    // `bounciness` half-turns per unit of time.
    const omega = bounciness * Math.PI;
    return (t) => 1 - Math.cos((t * Math.PI) / 2) ** 3 * Math.cos(omega * t);
  },
  back(s = 1.70158): EasingFunction {
    finiteParam(s, "Easing.back()", "s");
    // A cubic that dips below 0 before rising to 1; larger s dips further.
    return (t) => t * t * t - s * t * t * (1 - t);
  },
  bounce: ((t) => bounceOut(t)) as EasingFunction,
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
