// Playback engine primitives shared by the preview player and the timeline.
//
// The playhead moves ~60×/second. To keep that from re-rendering the whole app
// (library, inspector, asset list…), playhead/playing/duration live in a tiny
// external store. Only the components that actually draw the playhead — the
// timeline cursor and the transport clock — subscribe to it. The preview player
// owns the <video> element and is the clock that writes into the store; commands
// flow back to it through an imperative ref (see PlayerHandle).

import { useSyncExternalStore } from "react";
import { DEFAULT_PREVIEW_SCALE, effectByType, isEnabled, vignetteAngle } from "@aive/core/effects";
import { clipFootprintFrames, clipTimeMap, hasSpeedRamp, rampFrameModel, sourceFrameShownAt, type ClipTimeMap, type RampFrameModel } from "@aive/core/speed";
import type { Clip, MediaAsset, ColorAdjust, ColorGrade, VisualEffect } from "./types";
import { isOffline } from "./types";

export interface PlaybackState {
  playhead: number;
  playing: boolean;
  duration: number;
}

export interface PlaybackStore {
  get: () => PlaybackState;
  set: (patch: Partial<PlaybackState>) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createPlaybackStore(): PlaybackStore {
  let state: PlaybackState = { playhead: 0, playing: false, duration: 0 };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (patch) => {
      // Skip notify if nothing actually changed (avoids redundant renders).
      const changed =
        (patch.playhead !== undefined && patch.playhead !== state.playhead) ||
        (patch.playing !== undefined && patch.playing !== state.playing) ||
        (patch.duration !== undefined && patch.duration !== state.duration);
      if (!changed) return;
      state = { ...state, ...patch };
      listeners.forEach((l) => l());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Subscribe to one derived slice of the store (primitive results only). */
export function usePlaybackValue<T>(store: PlaybackStore, select: (s: PlaybackState) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.get()),
    () => select(store.get()),
  );
}

/** Imperative API the timeline / transport use to drive the preview player. */
export interface PlayerHandle {
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (time: number) => void;
  /** Nudge by whole frames (± direction × count). */
  step: (frames: number) => void;
  /** Jump to the start of the previous / next clip. */
  jumpClip: (dir: -1 | 1) => void;
}

/**
 * A clip flattened onto the timeline: where it sits (start/end in timeline
 * seconds) and which slice of its source it shows. `tlDur` is the clip's
 * footprint (whole frames, as the engine and the export count it), so a clip
 * ends on the same frame in the preview as in the export.
 */
export interface Segment {
  clip: Clip;
  asset?: MediaAsset;
  index: number;
  start: number;
  end: number;
  tlDur: number;
  /** Constant speed; for a speed-ramped clip its AVERAGE (use `map` / rateAt for the curve). */
  speed: number;
  /**
   * Present for a SPEED-RAMPED clip: the shared source↔timeline map
   * (`@aive/core/speed`, the same code the export retimes with).
   */
  map?: ClipTimeMap;
  /** A speed-ramped clip's frame model (`@aive/core/speed` "Ramp frames"): the export's exact frames. */
  frames?: RampFrameModel;
  srcIn: number;
  srcOut: number;
  path?: string;
  /** Project fps, carried so consumers can convert the clip's frame fields. */
  fps: number;
}

/**
 * Flatten a track's clips into timeline segments (in seconds) using each clip's
 * ABSOLUTE frame position. Source trims and start are converted from frames at
 * the boundary; `tlDur` accounts for speed.
 */
export function buildSegments(clips: Clip[], assetById: Map<string, MediaAsset>, fps: number): Segment[] {
  return clips.map((clip, index) => {
    const srcIn = clip.sourceInFrame / fps;
    const srcOut = clip.sourceOutFrame / fps;
    const start = clip.startFrame / fps;
    const asset = clip.assetId ? assetById.get(clip.assetId) : undefined; // adjustment layers have no source
    // Preview prefers a low-res proxy; export uses the original. An offline asset (its server not
    // allowed yet) has no path, so the pool, the preview and the waveform never ask for its file.
    const path = !asset || isOffline(asset) ? undefined : asset.proxyPath ?? asset.path;
    // The footprint, in whole frames as the engine and the export count it (not the continuous source / speed).
    const fpFrames = clipFootprintFrames(clip, fps);
    const tlDur = Math.max(0.01, fpFrames / fps);
    // End exactly where a butted next clip starts: start + tlDur can be an ulp past (endFrame)/fps, and both clips were then active there.
    const end = fpFrames / fps >= 0.01 ? (clip.startFrame + fpFrames) / fps : start + tlDur;
    if (hasSpeedRamp(clip) && !clip.adjustment) {
      const map = clipTimeMap(clip, fps);
      const frames = rampFrameModel(clip, fps);
      return { clip, asset, index, start, end, tlDur, speed: (srcOut - srcIn) / tlDur, map, frames, srcIn, srcOut, path, fps };
    }
    const speed = clip.effects?.speed ?? 1;
    return { clip, asset, index, start, end, tlDur, speed, srcIn, srcOut, path, fps };
  });
}

export function totalDuration(segments: Segment[]): number {
  return segments.length ? segments[segments.length - 1].end : 0;
}

/**
 * The playhead `frames` frames from `time`. On the frame grid (within float noise) it steps from the frame
 * number, not by adding frames / fps: 120 steps of 1/30 s reach 3.9999999999999996, a hair before frame 120,
 * which still showed the previous clip's last frame at a cut.
 */
export function stepFrames(time: number, frames: number, fps: number): number {
  const g = time * fps;
  const n = Math.round(g);
  return (Math.abs(g - n) < 1e-4 ? n + frames : g + frames) / fps;
}

/** Which segment is under a given timeline time (clamped to the last clip). */
export function segmentAt(segments: Segment[], time: number): Segment | undefined {
  if (!segments.length) return undefined;
  for (const s of segments) {
    if (time >= s.start && time < s.end) return s;
  }
  return segments[segments.length - 1];
}

/**
 * Source time inside a segment for a given timeline time, for LIVE playback: a
 * ramp maps through its curve, centred on the export's frames
 * (RampFrameModel.sourceAt); constant speed is linear. Never past the clip's
 * last source frame (a footprint rounded up runs a hair past source / speed).
 */
export function sourceTimeFor(seg: Segment, time: number): number {
  const local = Math.max(0, time - seg.start);
  const s = seg.frames ? seg.frames.sourceAt(local) : seg.srcIn + local * seg.speed;
  return Math.min(Math.max(seg.srcIn, s), Math.max(seg.srcIn, seg.srcOut - 0.5 / seg.fps));
}

/**
 * Source time for a STILL frame (paused / scrubbing): the middle of the very
 * source frame the export shows at that timeline frame (speed.ts
 * sourceFrameShownAt — a ramp's frame model, or FFmpeg's pick at a constant
 * speed), so a paused preview shows the exported frame.
 */
export function exactSourceTimeFor(seg: Segment, time: number): number {
  if (!seg.clip.assetId || seg.asset?.isImage) return sourceTimeFor(seg, time);
  const n = Math.max(0, Math.floor((time - seg.start) * seg.fps + 1e-6));
  return (sourceFrameShownAt(seg.clip, n, seg.fps) + 0.5) / seg.fps;
}

/** Playback rate of a segment's source at a source time: its constant speed, or the curve's speed there. */
export function rateAt(seg: Segment, srcTime: number): number {
  return seg.map ? seg.map.speedAt(srcTime) : seg.speed;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * The CSS-filter FALLBACK for a look, used when WebGL2 is unavailable (the
 * live preview normally runs the look through the WebGL2 pipeline in gl/,
 * which matches the export). Not pixel-identical to the FFmpeg export: we map
 * what CSS can express — brightness / contrast / saturation, hue rotation,
 * warm/cool tint, and each effect's CSS builder from the effect registry
 * (`@aive/core/effects`). Curves, LUTs, colour wheels, keys and the GL-only
 * effects don't show here; the vignette uses a canvas pass (vignetteAngles).
 * Bypassed effects are skipped.
 */
export function colorFilter(
  color?: ColorAdjust,
  grade?: ColorGrade,
  filters?: VisualEffect[],
  /** Preview pixels per canvas pixel, for pixel-sized effects (blur). */
  scale: number = DEFAULT_PREVIEW_SCALE,
): string {
  const parts: string[] = [];
  if (color) {
    if (color.brightness !== undefined && color.brightness !== 0) parts.push(`brightness(${clamp(1 + color.brightness, 0, 4)})`);
    if (color.contrast !== undefined && color.contrast !== 1) parts.push(`contrast(${clamp(color.contrast, 0, 4)})`);
    if (color.saturation !== undefined && color.saturation !== 1) parts.push(`saturate(${clamp(color.saturation, 0, 4)})`);
  }
  if (grade) {
    if (grade.hue) parts.push(`hue-rotate(${grade.hue}deg)`);
    // Warm temperature reads as a slight sepia; cool as a hue nudge toward blue.
    if (grade.temperature && grade.temperature > 0) parts.push(`sepia(${clamp(grade.temperature * 0.5, 0, 1)})`);
    else if (grade.temperature && grade.temperature < 0) parts.push(`hue-rotate(${grade.temperature * 20}deg)`);
  }
  for (const f of filters ?? []) {
    if (!isEnabled(f)) continue;
    const preview = effectByType(f.type)?.preview;
    const css = preview && preview !== "export-only" ? preview.css?.(f, scale) : undefined;
    if (css) parts.push(css);
  }
  return parts.length ? parts.join(" ") : "none";
}

/**
 * Lens angles (radians) of the clip's enabled vignettes, for the no-WebGL2
 * fallback's canvas vignette pass (vignette2d.ts) — the same cos⁴ falloff
 * FFmpeg's vignette applies over the canvas-space frame. Empty when there are none.
 */
export function vignetteAngles(filters?: VisualEffect[]): number[] {
  const out: number[] = [];
  for (const f of filters ?? []) {
    if (!isEnabled(f)) continue;
    const preview = effectByType(f.type)?.preview;
    if (preview && preview !== "export-only" && preview.pass === "vignette") {
      const a = vignetteAngle(f);
      if (a > 0) out.push(a);
    }
  }
  return out;
}

/** Opacity from fade-in / fade-out within a segment at the given timeline time. */
export function fadeOpacity(seg: Segment, time: number): number {
  const fx = seg.clip.effects;
  if (!fx) return 1;
  const fadeIn = fx.fadeInFrames ? fx.fadeInFrames / seg.fps : 0;
  const fadeOut = fx.fadeOutFrames ? fx.fadeOutFrames / seg.fps : 0;
  const into = time - seg.start;
  const left = seg.end - time;
  let o = 1;
  if (fadeIn && into < fadeIn) o = Math.min(o, Math.max(0, into / fadeIn));
  if (fadeOut && left < fadeOut) o = Math.min(o, Math.max(0, left / fadeOut));
  return o;
}

/** M:SS, optionally with centiseconds (M:SS.cs) for the transport read-out. */
export function fmtTime(seconds: number, withCs = false): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const base = `${m}:${String(s).padStart(2, "0")}`;
  if (!withCs) return base;
  const cs = Math.floor((seconds - Math.floor(seconds)) * 100);
  return `${base}.${String(cs).padStart(2, "0")}`;
}

/** Nice ruler tick spacing (seconds) for a given pixels-per-second zoom. */
export function tickInterval(pxPerSec: number): number {
  const targetPx = 84; // aim for a label roughly every ~84px
  const raw = targetPx / pxPerSec;
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of steps) if (s >= raw) return s;
  return 600;
}

/** How long (ms) the canvas keeps the last frame while a layer's decoder has none (a seek, a load). */
export const HOLD_MS = 250;

/**
 * Whether the preview keeps the frame already on the canvas instead of painting a new one: a layer has no decoded
 * frame (`late`), the canvas shows a frame of the current size (`painted`), and the hold started less than HOLD_MS
 * ago (`holdStart` is 0 before it starts). Past HOLD_MS it paints, black where a frame is still missing.
 */
export function holdLastFrame(late: boolean, painted: boolean, holdStart: number, now: number): boolean {
  return late && painted && (!holdStart || now - holdStart < HOLD_MS);
}

/**
 * A slider keeps its own value while dragged and resyncs when the project changes. A refused or failed commit
 * (a locked track, say: run() resolves null) leaves the project as it was, so nothing would resync it and the
 * slider would stay on the rejected value: `revert` puts it back.
 */
export function revertIfRefused(r: unknown, revert: () => void): void {
  if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).then((res) => { if (res === null) revert(); }, revert);
}
