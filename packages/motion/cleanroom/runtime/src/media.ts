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
  /** The parent frame from which the element is mounted (it does not shift the source). */
  from: number;
  trimBefore: number;
  /** Media-local frames played from trimBefore (the loop length with `loop`); Infinity for no limit. */
  durationInFrames: number;
  /** Parent frames the element stays mounted for, from the parent's frame 0 (trimAfter); Infinity for no limit. */
  parentLength: number;
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
  const durationInFrames = duration(props.durationInFrames, where);
  const loop = allowLoop && props.loop === true;
  if (allowLoop && present(props.loop) && typeof props.loop !== "boolean") {
    throw misuse(`${where}: loop must be true or false.`);
  }
  let trimmedLength = Infinity;
  if (present(trimAfterRaw)) {
    if (present(props.durationInFrames)) {
      throw misuse(`${where}: give either durationInFrames or trimAfter, not both. durationInFrames is preferred.`);
    }
    const trimAfter = finiteNumber(trimAfterRaw, 0, where, "trimAfter");
    if (trimAfter <= trimBefore) {
      throw misuse(`${where}: trimAfter (${trimAfter}) must be greater than trimBefore (${trimBefore}).`);
    }
    trimmedLength = trimAfter - trimBefore;
  }
  return {
    from: finiteNumber(props.from, 0, where, "from"),
    trimBefore,
    // With loop, the trimBefore..trimAfter range is what repeats (media-local frames).
    durationInFrames: loop && Number.isFinite(trimmedLength) ? trimmedLength : durationInFrames,
    // Without loop, trimAfter ends the element after trimAfter - trimBefore parent frames, whatever
    // the playbackRate (round 2's rows: notes/fit/r2-media-rules.js, part 3).
    parentLength: loop ? Infinity : trimmedLength,
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
 * The media's timeline starts at the parent's frame 0; `from` only keeps the element unmounted
 * before that parent frame and does not shift the source (round 2's rows:
 * notes/fit/r2-media-rules.js, part 2). `sourceLength` is the source's length in media-local frames
 * (used for `loop` without a durationInFrames).
 */
export function mediaPosition(parent: Timeline, t: MediaTiming, sourceLength: number, where: string): MediaPosition | null {
  const f = parent.frame;
  if (f < t.from - EPS) return null;
  const elapsed = f * t.playbackRate;
  const extended = parent.unloopedFrame;
  if (t.loop) {
    const cycle = Number.isFinite(t.durationInFrames) ? t.durationInFrames : sourceLength - t.trimBefore;
    if (!(cycle > 0)) {
      throw misuse(
        `${where}: loop has nothing to repeat, because trimBefore is at or past the end of the source. Lower trimBefore or set durationInFrames.`,
      );
    }
    const iteration = fuzzyFloor(Math.max(0, elapsed) / cycle);
    const localFrame = t.trimBefore + elapsed - iteration * cycle;
    const volumeFrame = t.volumeCurve === "extend" ? extended : f - (iteration * cycle) / t.playbackRate;
    return { localFrame: snap(localFrame), volumeFrame: snap(volumeFrame) };
  }
  if (elapsed >= t.durationInFrames - EPS) return null;
  if (f >= t.parentLength - EPS) return null;
  return {
    localFrame: snap(t.trimBefore + elapsed),
    volumeFrame: snap(t.volumeCurve === "extend" ? extended : f),
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

/**
 * The source frame to show: the nearest one to seconds * asset fps, ties going up, then clamped to
 * the source's frames (round 2's rows: notes/fit/r2-media-rules.js, part 1).
 */
export function sourceFrameAt(seconds: number, assetFps: number, frameCount: number): number {
  const frame = fuzzyFloor(seconds * assetFps + 0.5);
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
