// The live-preview KEY plan: a PURE function from a clip's effects to what the
// WebGL keying pass (glkey.ts) needs — which keys to run, with the effect
// registry's defaults and clamps (`@aive/core/effects`, shared with the export),
// and how the CSS colour proxy splits around them. Bypassed effects are left
// out. No DOM, so composite.ts stays unit-testable in plain Node.
//
// Export order is colour → effects (in list order) → transform, so the CSS
// proxy for colour plus every effect BEFORE the first key is drawn first
// (`pre`); the keys run on that; effects after the first key are drawn on the
// keyed result (`post`). The vignette canvas pass splits the same way
// (`preVignette` / `postVignette`): a vignette before the key darkens the frame
// the key sees, so its dark edge stays opaque, as in the export. Effects
// sitting between two keys are approximated as "after" — the keys themselves
// always run in order.

import type { ClipEffects, VisualEffect } from "./types";
import { colorFilter, vignetteAngles } from "./playback";
import {
  EFFECTS, defaultsFor, effectByType, hexToRgb, isEnabled, isKeyType, keyColorHex, paramValue, spillScreen,
} from "@aive/core/effects";

export { hexToRgb, keyColorHex, spillScreen };

/** The key kinds the shader implements (glkey.ts); which effects ARE keys comes from the registry. */
export type KeyKind = "colorkey" | "chromakey" | "lumakey";

/** The registry's key effects (preview.key), in registry order. */
export const KEY_EFFECT_TYPES = EFFECTS.filter((e) => isKeyType(e.type)).map((e) => e.type) as KeyKind[];

export function isKeyEffect(type: string): type is KeyKind {
  return isKeyType(type);
}

/** Per-key parameter defaults, from the effect registry (the export uses the same). */
export const KEY_DEFAULTS = Object.fromEntries(
  KEY_EFFECT_TYPES.map((t) => [t, defaultsFor(t).params ?? {}]),
) as Record<KeyKind, Record<string, number>>;

/** Default key colour when none is stored ("" = the key takes no colour), from the registry. */
export const KEY_DEFAULT_COLOR = Object.fromEntries(
  KEY_EFFECT_TYPES.map((t) => [t, effectByType(t)?.color?.default ?? ""]),
) as Record<KeyKind, string>;

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
  /** Lens angles of the vignettes before the first key — drawn before keying; absent when none. */
  preVignette?: number[];
  keys: KeySpec[];
  /** CSS filter for the effects after the first key ("none" when empty). */
  post: string;
  /** Lens angles of the vignettes after the first key — drawn on the keyed result; absent when none. */
  postVignette?: number[];
}

function keySpec(f: VisualEffect & { type: KeyKind }): KeySpec {
  const rgb = hexToRgb(keyColorHex(f.color, KEY_DEFAULT_COLOR[f.type] || "0x000000"));
  // paramValue applies the registry default + range clamp, exactly as the
  // export's filter builder does; a param the key doesn't have gets the fallback.
  const v = (k: string, fallback: number) => paramValue(f, k, fallback);
  return {
    kind: f.type,
    rgb,
    similarity: v("similarity", 0.1),
    blend: v("blend", 0),
    despill: f.type === "chromakey" ? v("despill", 0) : 0,
    screen: f.type === "chromakey" ? spillScreen(rgb) : null,
    threshold: v("threshold", 0),
    tolerance: v("tolerance", 0.1),
    softness: v("softness", 0.05),
  };
}

/** The key plan for a clip, or undefined when it has no (enabled) key effect. Bypassed effects are left out. */
export function keyPlan(fx: ClipEffects | undefined, scale?: number): KeyPlan | undefined {
  const filters = (fx?.filters ?? []).filter(isEnabled);
  const first = filters.findIndex((f) => isKeyEffect(f.type));
  if (first < 0) return undefined;
  const after = filters.slice(first);
  const keys = after.filter((f): f is VisualEffect & { type: KeyKind } => isKeyEffect(f.type)).slice(0, MAX_KEYS).map(keySpec);
  const preVignette = vignetteAngles(filters.slice(0, first));
  const postVignette = vignetteAngles(after);
  return {
    pre: colorFilter(fx?.color, fx?.grade, filters.slice(0, first), scale),
    ...(preVignette.length ? { preVignette } : {}),
    keys,
    post: colorFilter(undefined, undefined, after.filter((f) => !isKeyEffect(f.type)), scale),
    ...(postVignette.length ? { postVignette } : {}),
  };
}
