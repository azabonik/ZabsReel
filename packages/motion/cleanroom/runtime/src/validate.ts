// Prop and argument checks shared by the components. They throw graphic_api_misuse.

import { describeValue, misuse } from "./errors";

function bad(where: string, name: string, wanted: string, value: unknown): never {
  throw misuse(`${where}: ${name} must be ${wanted}, but got ${describeValue(value)}.`);
}

function given(value: unknown): boolean {
  return value !== undefined && value !== null;
}

export function finiteNumber(value: unknown, fallback: number, where: string, name: string): number {
  if (!given(value)) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) bad(where, name, "a finite number", value);
  return value;
}

export function positiveRate(value: unknown, where: string, name = "playbackRate"): number {
  if (!given(value)) return 1;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    bad(where, name, "a positive, finite number", value);
  }
  return value;
}

/** A duration: zero or more frames, or Infinity. Missing means Infinity. */
export function duration(value: unknown, where: string, name = "durationInFrames"): number {
  if (!given(value)) return Infinity;
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    bad(where, name, "zero or a positive number of frames (or Infinity)", value);
  }
  return value;
}

export function optionalBoolean(value: unknown, fallback: boolean, where: string, name: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") bad(where, name, "true or false", value);
  return value;
}

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  where: string,
  name: string,
): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    bad(where, name, `one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}`, value);
  }
  return value as T;
}
