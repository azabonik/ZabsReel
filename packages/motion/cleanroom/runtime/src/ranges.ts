// Checks and helpers shared by interpolate() and interpolateColors().

import type { EasingFunction } from "./easing";
import { describeValue, misuse } from "./errors";

/** Any number is accepted; NaN and infinities go through the arithmetic (NaN in, NaN out). */
export function checkInput(input: unknown, where: string): number {
  if (typeof input !== "number") {
    throw misuse(`${where}: the input must be a number (usually the frame), but got ${describeValue(input)}.`);
  }
  return input;
}

/** Checks both ranges and returns the input keyframes. */
export function checkKeyframes(inputRange: unknown, outputRange: unknown, where: string): number[] {
  if (!Array.isArray(inputRange) || !Array.isArray(outputRange)) {
    throw misuse(`${where}: inputRange and outputRange must both be arrays.`);
  }
  if (inputRange.length === 0 || inputRange.length !== outputRange.length) {
    throw misuse(
      `${where}: inputRange and outputRange must have the same length, at least 1 (got ${inputRange.length} and ${outputRange.length}).`,
    );
  }
  inputRange.forEach((x: unknown, i) => {
    if (typeof x !== "number" || !Number.isFinite(x)) {
      throw misuse(`${where}: inputRange must hold finite numbers, but entry ${i} is ${describeValue(x)}.`);
    }
    if (i > 0 && !(x > inputRange[i - 1])) {
      throw misuse(
        `${where}: inputRange must be strictly increasing, but ${String(x)} follows ${String(inputRange[i - 1])}.`,
      );
    }
  });
  return inputRange as number[];
}

const linear: EasingFunction = (t) => t;

/** One easing per segment. */
export function readEasings(easing: unknown, segments: number, where: string): EasingFunction[] {
  if (easing === undefined || easing === null) return new Array<EasingFunction>(segments).fill(linear);
  if (typeof easing === "function") return new Array<EasingFunction>(segments).fill(easing as EasingFunction);
  if (Array.isArray(easing)) {
    if (easing.length !== segments) {
      throw misuse(
        `${where}: an easing array needs one function per segment, so ${segments} here (inputRange length minus 1), but it has ${easing.length}.`,
      );
    }
    easing.forEach((e: unknown, i) => {
      if (typeof e !== "function") throw misuse(`${where}: easing[${i}] must be a function, but got ${describeValue(e)}.`);
    });
    return easing as EasingFunction[];
  }
  throw misuse(`${where}: easing must be a function or an array of functions, but got ${describeValue(easing)}.`);
}

export function readPosterize(value: unknown, where: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw misuse(`${where}: posterize must be a positive, finite number, but got ${describeValue(value)}.`);
  }
  return value;
}

/** Rounds the input down to a multiple of `step`: floor(x / step) * step, as computed in floating point. */
export function posterizeInput(x: number, step: number | null): number {
  if (step === null) return x;
  return Math.floor(x / step) * step;
}

/**
 * Index of the segment for x: the first one whose end is >= x, so an input exactly on an interior
 * keyframe belongs to the segment that ends there (progress 1). Clamped to the first and last
 * segments outside the range.
 */
export function segmentAt(xs: readonly number[], x: number): number {
  const last = xs.length - 2;
  for (let i = 0; i < last; i++) {
    if (x <= xs[i + 1]) return i;
  }
  return Math.max(0, last);
}
