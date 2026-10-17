// The shared timing model (SPEC section 10) as pure functions over a parent Timeline.

import type { LoopInfo, Timeline } from "./context";

/** Tolerance for floating-point noise in frame arithmetic. */
const EPS = 1e-9;

/** Rounds values that are within EPS of an integer, so 2.9999999999999996 reads as 3. */
export function snap(x: number): number {
  const r = Math.round(x);
  if (Math.abs(x - r) < EPS) return r === 0 ? 0 : r;
  return x;
}

export function fuzzyFloor(x: number): number {
  return Math.floor(x + EPS);
}

export interface SequenceTiming {
  from: number;
  trimBefore: number;
  /** Child-timeline frames shown, from trimBefore. Infinity for no limit. */
  durationInFrames: number;
  playbackRate: number;
  loop: boolean;
  /** A child-timeline frame to hold, or null. */
  freeze: number | null;
}

export interface Mapped {
  timeline: Timeline;
  loop: LoopInfo | null;
}

/**
 * Sequence mapping: child = trimBefore + (frame - from) * rate, wrapped modulo durationInFrames
 * with `loop`. Returns null when the parent frame is outside the Sequence's active range.
 */
export function mapSequence(parent: Timeline, t: SequenceTiming): Mapped | null {
  const sinceStart = parent.frame - t.from;
  if (sinceStart < -EPS) return null;
  const elapsed = Math.max(0, sinceStart) * t.playbackRate;
  let frame: number;
  let loop: LoopInfo | null = null;
  if (t.loop) {
    const iteration = fuzzyFloor(elapsed / t.durationInFrames);
    frame = t.trimBefore + Math.max(0, elapsed - iteration * t.durationInFrames);
    loop = { durationInFrames: t.durationInFrames, iteration };
  } else {
    if (elapsed >= t.durationInFrames - EPS) return null;
    frame = t.trimBefore + elapsed;
  }
  let unloopedFrame = t.trimBefore + (parent.unloopedFrame - t.from) * t.playbackRate;
  const durationInFrames = Number.isFinite(t.durationInFrames)
    ? t.trimBefore + t.durationInFrames
    : t.trimBefore + Math.max(0, parent.durationInFrames - t.from) * t.playbackRate;
  let frozen = parent.frozen;
  if (t.freeze !== null) {
    frame = t.freeze;
    unloopedFrame = t.freeze;
    frozen = true;
  }
  return {
    timeline: {
      ...parent,
      frame: snap(frame),
      unloopedFrame: snap(unloopedFrame),
      durationInFrames: snap(durationInFrames),
      frozen,
    },
    loop,
  };
}

/**
 * <Loop> mapping: iterations of `durationInFrames` parent frames starting at the parent's frame 0;
 * inside an iteration the child sees (frame - iteration * durationInFrames) * rate.
 */
export function mapLoop(parent: Timeline, durationInFrames: number, times: number, rate: number): Mapped | null {
  const f = parent.frame;
  if (f < -EPS) return null;
  const iteration = fuzzyFloor(Math.max(0, f) / durationInFrames);
  if (iteration >= times) return null;
  const frame = Math.max(0, f - iteration * durationInFrames) * rate;
  return {
    timeline: {
      ...parent,
      frame: snap(frame),
      unloopedFrame: snap(parent.unloopedFrame * rate),
      durationInFrames: snap(durationInFrames * rate),
    },
    loop: { durationInFrames, iteration },
  };
}

/** <Freeze> mapping: the children see `frame`. */
export function mapFreeze(parent: Timeline, frame: number): Timeline {
  return { ...parent, frame, unloopedFrame: frame, frozen: true };
}
