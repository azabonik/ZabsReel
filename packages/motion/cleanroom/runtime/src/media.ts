// Media timing (SPEC sections 18-21 with BRIEF section 6.3-6.4): which part of a source plays at a
// frame, its volume, and the audio-source bookkeeping shared by video and audio.

import React from "react";
import type { AppRuntime, AudioSourceEntry, Timeline } from "./context";
import { graphicError, misuse } from "./errors";
import type { AudioCue } from "./hostTypes";
import { fuzzyFloor, snap } from "./timing";
import { duration, finiteNumber, oneOf, positiveRate } from "./validate";

const EPS = 1e-9;

export type LoopVolumeCurveBehavior = "repeat" | "extend";

export interface MediaTiming {
  from: number;
  trimBefore: number;
  /** Media-local frames played from trimBefore; Infinity for no limit. */
  durationInFrames: number;
  playbackRate: number;
  loop: boolean;
  volumeCurve: LoopVolumeCurveBehavior;
}

export interface RawMediaTiming {
  from?: unknown;
  trimBefore?: unknown;
  trimAfter?: unknown;
  startFrom?: unknown;
  endAt?: unknown;
  durationInFrames?: unknown;
  playbackRate?: unknown;
  loop?: unknown;
  loopVolumeCurveBehavior?: unknown;
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

export function readMediaTiming(props: RawMediaTiming, where: string, allowLoop: boolean): MediaTiming {
  const oldNames = present(props.startFrom) || present(props.endAt);
  const newNames = present(props.trimBefore) || present(props.trimAfter);
  if (oldNames && newNames) {
    throw misuse(
      `${where}: startFrom/endAt are the old names of trimBefore/trimAfter and cannot be mixed with them. Use trimBefore and durationInFrames.`,
    );
  }
  const trimBefore = finiteNumber(present(props.trimBefore) ? props.trimBefore : props.startFrom, 0, where, "trimBefore");
  const trimAfterRaw = present(props.trimAfter) ? props.trimAfter : props.endAt;
  let durationInFrames = duration(props.durationInFrames, where);
  if (present(trimAfterRaw)) {
    if (present(props.durationInFrames)) {
      throw misuse(`${where}: give either durationInFrames or trimAfter, not both. durationInFrames is preferred.`);
    }
    const trimAfter = finiteNumber(trimAfterRaw, 0, where, "trimAfter");
    if (trimAfter <= trimBefore) {
      throw misuse(`${where}: trimAfter (${trimAfter}) must be greater than trimBefore (${trimBefore}).`);
    }
    durationInFrames = trimAfter - trimBefore;
  }
  const loop = allowLoop && props.loop === true;
  if (allowLoop && present(props.loop) && typeof props.loop !== "boolean") {
    throw misuse(`${where}: loop must be true or false.`);
  }
  return {
    from: finiteNumber(props.from, 0, where, "from"),
    trimBefore,
    durationInFrames,
    playbackRate: positiveRate(props.playbackRate, where),
    loop,
    volumeCurve: oneOf(props.loopVolumeCurveBehavior, ["repeat", "extend"] as const, "repeat", where, "loopVolumeCurveBehavior"),
  };
}

export interface MediaPosition {
  /** Media-local frame (composition fps): trimBefore plus the elapsed, rate-scaled time. */
  localFrame: number;
  /** The frame passed to a volume callback. */
  volumeFrame: number;
}

/**
 * Where a media element is at the parent's frame, or null when it is not mounted.
 * `sourceLength` is the source's length in media-local frames (used for `loop` without a
 * durationInFrames).
 */
export function mediaPosition(parent: Timeline, t: MediaTiming, sourceLength: number, where: string): MediaPosition | null {
  const sinceStart = parent.frame - t.from;
  if (sinceStart < -EPS) return null;
  const elapsed = Math.max(0, sinceStart) * t.playbackRate;
  const extended = parent.unloopedFrame - t.from;
  if (t.loop) {
    const cycle = Number.isFinite(t.durationInFrames) ? t.durationInFrames : sourceLength - t.trimBefore;
    if (!(cycle > 0)) {
      throw misuse(
        `${where}: loop has nothing to repeat, because trimBefore is at or past the end of the source. Lower trimBefore or set durationInFrames.`,
      );
    }
    const iteration = fuzzyFloor(elapsed / cycle);
    const localFrame = t.trimBefore + Math.max(0, elapsed - iteration * cycle);
    const volumeFrame = t.volumeCurve === "extend" ? extended : sinceStart - (iteration * cycle) / t.playbackRate;
    return { localFrame: snap(localFrame), volumeFrame: snap(volumeFrame) };
  }
  if (elapsed >= t.durationInFrames - EPS) return null;
  return {
    localFrame: snap(t.trimBefore + elapsed),
    volumeFrame: snap(t.volumeCurve === "extend" ? extended : sinceStart),
  };
}

export function assertNonNegativeTime(localFrame: number, where: string, id: string): void {
  if (localFrame < 0) {
    throw graphicError(
      "graphic_media_time",
      `${where} for the asset "${id}" would play from before the start of the source at this frame (${localFrame} frames). Use a trimBefore of 0 or more.`,
    );
  }
}

/** The source frame to show: floor(seconds * asset fps), clamped to the source's frames. */
export function sourceFrameAt(seconds: number, assetFps: number, frameCount: number): number {
  const frame = fuzzyFloor(seconds * assetFps);
  return Math.min(Math.max(0, frameCount - 1), Math.max(0, frame));
}

export function clampVolume(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(4, Math.max(0, value));
}

export function evaluateVolume(volume: unknown, volumeFrame: number, where: string): number {
  if (volume === undefined || volume === null) return 1;
  if (typeof volume === "number") return clampVolume(volume);
  if (typeof volume === "function") {
    const value: unknown = volume(volumeFrame);
    return clampVolume(typeof value === "number" ? value : NaN);
  }
  throw misuse(`${where}: volume must be a number or a function of the frame.`);
}

/** A key that stays the same while the component stays mounted. */
export function useSourceKey(runtime: AppRuntime): string {
  const [key] = React.useState(() => runtime.nextSourceKey());
  return key;
}

/** Publishes this component's cue (or null) after every commit. */
export function useAudioSource(
  runtime: AppRuntime,
  key: string,
  cue: AudioCue | null,
  anchor: React.RefObject<Element | null>,
): void {
  const entry = React.useRef<AudioSourceEntry | null>(null);
  if (entry.current === null) entry.current = { key, anchor: null, cue: null };
  const current = entry.current;
  React.useLayoutEffect(() => runtime.registerAudioSource(current), [runtime, current]);
  React.useLayoutEffect(() => {
    current.cue = cue;
    current.anchor = anchor.current;
  });
}

/** Sets a ref of any kind. */
export function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as React.MutableRefObject<T | null>).current = value;
}

/** True if the user sized the element (then the runtime sets no size attributes). */
export function userSized(props: { width?: unknown; height?: unknown; style?: React.CSSProperties }): boolean {
  return (
    props.width !== undefined ||
    props.height !== undefined ||
    props.style?.width !== undefined ||
    props.style?.height !== undefined
  );
}
