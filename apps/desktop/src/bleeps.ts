// Renderer-side mirror of packages/core/src/audio/bleeps.ts — the SAME bleep
// expansion the FFmpeg export uses, so the live preview plays each sound effect
// where the export will and the timeline chips sit where the bleeps land. Kept
// decoupled (no core import) like the rest of the desktop model mirror; keep the
// two in sync (scripts/smoke-composite.ts compares them on the same inputs).

import type { Bleep, BleepSound } from "./types";

export const BLEEP_DEFAULT_VOLUME = 0.8;
export const BLEEP_MIN_WINDOW = 0.04;
export const BLEEP_DEFAULT_SOUND: BleepSound = "beep";
/** Must match MUTE_RAMP_SEC in mutes.ts / core audio/mutes.ts. */
const MUTE_RAMP_SEC = 0.01;
/** Natural length of each built-in sound, seconds (core audio/sfx.ts sfxDuration). */
const SFX_SECONDS: Record<BleepSound, number> = { beep: 3, quack: 0.3, squeak: 0.35, boing: 0.5, honk: 0.35 };

const EPS = 1e-6;

export interface BleepClip {
  startFrame: number;
  sourceInFrame: number;
  sourceOutFrame: number;
  audioOffsetFrames?: number;
  effects?: { speed?: number; bleeps?: readonly Bleep[] };
}

export interface BleepLayer {
  bleepId: string;
  word?: string;
  srcStart: number;
  srcEnd: number;
  start: number;
  windowEnd: number;
  sfxDuration: number;
  sound: BleepSound;
  sfxAssetId?: string;
  volume: number;
  mute: boolean;
}

/** Expand a clip's visible bleeps into timeline layers (see the core original). */
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
    const natural = l.sfxAssetId ? customDuration?.(l.sfxAssetId) ?? 0 : SFX_SECONDS[l.sound];
    let len = !l.sfxAssetId && l.sound === "beep" ? Math.min(natural, l.windowEnd - l.start) : natural;
    const next = layers[i + 1];
    if (next) len = Math.min(len, next.start - l.start);
    len = Math.min(len, clipEnd - l.start);
    l.sfxDuration = len > 1e-3 ? len : 0;
  });
  return layers;
}

/** Source-time mute windows of a clip's bleeps (sorted, merged) — see the core original. */
export function bleepMuteSpans(clip: BleepClip, fps: number): Array<{ start: number; end: number }> {
  const bleeps = clip.effects?.bleeps;
  if (!bleeps?.length) return [];
  const lo = clip.sourceInFrame / fps - MUTE_RAMP_SEC;
  const hi = clip.sourceOutFrame / fps + MUTE_RAMP_SEC;
  const spans = bleeps
    .filter((b) => b.mute !== false && b.end > lo && b.start < hi)
    .map((b) => ({ start: b.start, end: b.end }))
    .sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** Small glyph per sound for the timeline chips (legible at ~10px). */
export function bleepGlyph(layer: { sound: BleepSound; sfxAssetId?: string }): string {
  if (layer.sfxAssetId) return "♫";
  switch (layer.sound) {
    case "beep": return "♪";
    case "quack": return "🦆";
    case "squeak": return "✧";
    case "boing": return "∿";
    case "honk": return "📯";
  }
}

/** Display name of a sound. */
export const BLEEP_SOUND_LABELS: Record<BleepSound, string> = {
  beep: "Beep",
  quack: "Duck quack",
  squeak: "Squeaky toy",
  boing: "Boing",
  honk: "Clown horn",
};
