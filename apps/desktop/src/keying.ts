// The live-preview KEY plan: a PURE function from a clip's effects to what the
// WebGL keying pass (glkey.ts) needs — which keys to run, with graph.ts's
// defaults and clamps, and how the CSS colour proxy splits around them. No DOM,
// so composite.ts stays unit-testable in plain Node.
//
// Export order is colour → effects (in list order) → transform, so the CSS
// proxy for colour plus every effect BEFORE the first key is drawn first
// (`pre`); the keys run on that; effects after the first key are drawn on the
// keyed result (`post`). Effects sitting between two keys are approximated as
// "after" — the keys themselves always run in order.

import type { ClipEffects, VisualEffect } from "./types";
import { colorFilter } from "./playback";

export const KEY_EFFECT_TYPES = ["colorkey", "chromakey", "lumakey"] as const;
export type KeyKind = (typeof KEY_EFFECT_TYPES)[number];

export function isKeyEffect(type: string): type is KeyKind {
  return (KEY_EFFECT_TYPES as readonly string[]).includes(type);
}

/** Per-key parameter defaults — keep in sync with graph.ts keyStep(). */
export const KEY_DEFAULTS: Record<KeyKind, Record<string, number>> = {
  colorkey: { similarity: 0.08, blend: 0.04 },
  chromakey: { similarity: 0.18, blend: 0.1, despill: 0 },
  lumakey: { threshold: 0, tolerance: 0.1, softness: 0.05 },
};

/** Default key colour when none is stored (graph.ts falls back the same way). */
export const KEY_DEFAULT_COLOR: Record<KeyKind, string> = {
  colorkey: "0x808080",
  chromakey: "0x00FF00",
  lumakey: "",
};

/** The keys the preview shader runs per clip (extra keys are export-only). */
export const MAX_KEYS = 4;

/** One key, normalised for the shader. Colours are 0..255. */
export interface KeySpec {
  kind: KeyKind;
  rgb: [number, number, number];
  similarity: number;
  blend: number;
  /** chromakey despill amount 0..1, and the screen it applies to (null = neither). */
  despill: number;
  screen: "green" | "blue" | null;
  threshold: number;
  tolerance: number;
  softness: number;
}

export interface KeyPlan {
  /** CSS filter for colour + effects before the first key ("none" when empty). */
  pre: string;
  keys: KeySpec[];
  /** CSS filter for the effects after the first key ("none" when empty). */
  post: string;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const KEY_COLOR_NAMES: Record<string, string> = {
  green: "00FF00", blue: "0000FF", black: "000000", white: "FFFFFF", gray: "808080", grey: "808080", red: "FF0000",
};

/**
 * Normalise a key colour (0xRRGGBB / #RRGGBB / RRGGBB, optional alpha byte, or
 * a basic name) to "0xRRGGBB" — the same rule as graph.ts, so preview and
 * export agree on what an odd value means. Unparseable → `fallback`.
 */
export function keyColorHex(c: string | undefined, fallback: string): string {
  const s = (c ?? "").trim().toLowerCase();
  const m = /^(?:0x|#)?([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s);
  if (m) return `0x${m[1].toUpperCase()}`;
  const named = KEY_COLOR_NAMES[s];
  return named ? `0x${named}` : fallback;
}

export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace(/^0x|^#/i, ""), 16) || 0;
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Which despill screen a key colour is: clearly green- or blue-dominant (as graph.ts). */
export function spillScreen([r, g, b]: [number, number, number]): "green" | "blue" | null {
  if (g >= 80 && g - Math.max(r, b) >= 40) return "green";
  if (b >= 80 && b - Math.max(r, g) >= 40) return "blue";
  return null;
}

function keySpec(f: VisualEffect & { type: KeyKind }): KeySpec {
  const p = { ...KEY_DEFAULTS[f.type], ...f.params };
  const rgb = hexToRgb(keyColorHex(f.color, KEY_DEFAULT_COLOR[f.type] || "0x000000"));
  return {
    kind: f.type,
    rgb,
    similarity: clamp(p.similarity ?? 0.1, 0.01, 1),
    blend: clamp(p.blend ?? 0, 0, 1),
    despill: f.type === "chromakey" ? clamp(p.despill ?? 0, 0, 1) : 0,
    screen: f.type === "chromakey" ? spillScreen(rgb) : null,
    threshold: clamp(p.threshold ?? 0, 0, 1),
    tolerance: clamp(p.tolerance ?? 0.1, 0, 1),
    softness: clamp(p.softness ?? 0.05, 0, 1),
  };
}

/** The key plan for a clip, or undefined when it has no key effect. */
export function keyPlan(fx: ClipEffects | undefined): KeyPlan | undefined {
  const filters = fx?.filters ?? [];
  const first = filters.findIndex((f) => isKeyEffect(f.type));
  if (first < 0) return undefined;
  const after = filters.slice(first);
  const keys = after.filter((f): f is VisualEffect & { type: KeyKind } => isKeyEffect(f.type)).slice(0, MAX_KEYS).map(keySpec);
  return {
    pre: colorFilter(fx?.color, fx?.grade, filters.slice(0, first)),
    keys,
    post: colorFilter(undefined, undefined, after.filter((f) => !isKeyEffect(f.type))),
  };
}
