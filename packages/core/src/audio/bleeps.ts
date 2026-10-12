/**
 * Bleep expansion: the SINGLE source of truth for where a clip's bleeps land.
 *
 * A bleep ({@link Bleep}) belongs to the clip it censors and is stored in the
 * clip's SOURCE time (asset seconds), so it follows the clip through every edit
 * (move, ripple, trim, split, speed, duplicate, delete) with no bookkeeping.
 * At render time {@link expandBleeps} turns the clip's bleeps into
 * timeline-positioned sound-effect layers, and {@link bleepMuteSpans} gives the
 * source-time windows the original audio is silenced under.
 *
 * The same math is mirrored in apps/desktop/src/bleeps.ts for the live preview
 * and the timeline chips — keep the two in sync (smoke-composite compares them).
 */
import type { Bleep, BleepSound } from "../types.js";
import { MUTE_RAMP_SEC, type SourceMute } from "./mutes.js";
import { sfxDuration } from "./sfx.js";

/** Default SFX gain of a bleep. */
export const BLEEP_DEFAULT_VOLUME = 0.8;
/** Shortest muted window a bleep may have, in seconds. */
export const BLEEP_MIN_WINDOW = 0.04;
/** Default built-in sound. */
export const BLEEP_DEFAULT_SOUND: BleepSound = "beep";

const EPS = 1e-6;

/** The clip fields expansion needs (a core or desktop Clip satisfies this). */
export interface BleepClip {
  startFrame: number;
  sourceInFrame: number;
  sourceOutFrame: number;
  audioOffsetFrames?: number;
  effects?: { speed?: number; bleeps?: readonly Bleep[] };
}

/** One bleep resolved onto the timeline. */
export interface BleepLayer {
  bleepId: string;
  word?: string;
  /** Visible muted window, clipped to the clip's used source range (asset seconds). */
  srcStart: number;
  srcEnd: number;
  /** Timeline seconds where the window starts / ends (audio slip included). */
  start: number;
  windowEnd: number;
  /**
   * Seconds of sound effect to play from `start`, at NORMAL speed and pitch
   * (never atempo'd). A beep lasts the window; other sounds play their natural
   * length, cut at the next bleep on the clip and at the clip's end. 0 = silent.
   */
  sfxDuration: number;
  /** Built-in sound (ignored when `sfxAssetId` is set). */
  sound: BleepSound;
  /** Custom sound asset, overrides `sound`. */
  sfxAssetId?: string;
  /** SFX gain. */
  volume: number;
  /** Silence the original audio under the window. */
  mute: boolean;
}

/**
 * Expand a clip's bleeps into timeline layers. Only bleeps intersecting the
 * clip's used source range are returned, clipped to it, sorted by time.
 * `customDuration` gives a custom sound asset's length in seconds (undefined =
 * asset missing → the layer still mutes but plays no sound).
 */
export function expandBleeps(
  clip: BleepClip,
  fps: number,
  customDuration?: (assetId: string) => number | undefined,
): BleepLayer[] {
  const bleeps = clip.effects?.bleeps;
  if (!bleeps?.length) return [];
  const speed = clip.effects?.speed && clip.effects.speed > 0 ? clip.effects.speed : 1;
  const srcIn = clip.sourceInFrame / fps;
  const srcOut = clip.sourceOutFrame / fps;
  const audioStart = (clip.startFrame + (clip.audioOffsetFrames ?? 0)) / fps;
  const clipEnd = audioStart + (srcOut - srcIn) / speed;

  const visible = bleeps
    .filter((b) => b.end > srcIn + EPS && b.start < srcOut - EPS)
    .map((b) => ({ b, s: Math.max(b.start, srcIn), e: Math.min(b.end, srcOut) }))
    .sort((x, y) => x.s - y.s || (x.b.id < y.b.id ? -1 : x.b.id > y.b.id ? 1 : 0));

  const layers: BleepLayer[] = visible.map(({ b, s, e }) => {
    const sound = b.sound ?? BLEEP_DEFAULT_SOUND;
    return {
      bleepId: b.id,
      word: b.word,
      srcStart: s,
      srcEnd: e,
      start: audioStart + (s - srcIn) / speed,
      windowEnd: audioStart + (e - srcIn) / speed,
      sfxDuration: 0,
      sound,
      sfxAssetId: b.sfxAssetId,
      volume: b.volume ?? BLEEP_DEFAULT_VOLUME,
      mute: b.mute !== false,
    };
  });

  layers.forEach((l, i) => {
    const natural = l.sfxAssetId ? customDuration?.(l.sfxAssetId) ?? 0 : sfxDuration(l.sound);
    let len = !l.sfxAssetId && l.sound === "beep" ? Math.min(natural, l.windowEnd - l.start) : natural;
    const next = layers[i + 1];
    if (next) len = Math.min(len, next.start - l.start);
    len = Math.min(len, clipEnd - l.start);
    l.sfxDuration = len > 1e-3 ? len : 0;
  });
  return layers;
}

/**
 * Source-time windows (asset seconds) the original audio is silenced under:
 * every bleep with `mute !== false` near the clip's used range, sorted and
 * merged so the envelope's product form equals its min form.
 */
export function bleepMuteSpans(clip: BleepClip, fps: number): SourceMute[] {
  const bleeps = clip.effects?.bleeps;
  if (!bleeps?.length) return [];
  const lo = clip.sourceInFrame / fps - MUTE_RAMP_SEC;
  const hi = clip.sourceOutFrame / fps + MUTE_RAMP_SEC;
  const spans = bleeps
    .filter((b) => b.mute !== false && b.end > lo && b.start < hi)
    .map((b) => ({ start: b.start, end: b.end }))
    .sort((a, b) => a.start - b.start);
  const out: SourceMute[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}
