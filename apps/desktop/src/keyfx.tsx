// Inspector controls for the KEY effects (colorkey / chromakey / lumakey): a key
// colour swatch, "Auto" (detect the background from the frame border), an
// eyedropper (any on-screen pixel; Chromium/Electron only), and each key's
// sliders. Every change re-applies the effect IN PLACE (apply_effect with its
// effectId), so the live preview (glkey.ts) and the export follow along.

import { useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import type { VisualEffect } from "./types";
import { KEY_DEFAULTS, KEY_DEFAULT_COLOR, hexToRgb, isKeyEffect, keyColorHex, type KeyKind } from "./keying";
import { setKeyBypass } from "./glkey";

/** Friendly names for the Add-effect menu (other effects show their type). */
export const EFFECT_LABELS: Record<string, string> = {
  colorkey: "Color key (any color — gray/white/black screens)",
  chromakey: "Chroma key (green/blue screen)",
  lumakey: "Luma key (black/white background)",
};

const SHORT_NAMES: Record<KeyKind, string> = { colorkey: "Color key", chromakey: "Chroma key", lumakey: "Luma key" };

/** [param, label, min, max, step] per key, in display order. */
const SLIDERS: Record<KeyKind, [string, string, number, number, number][]> = {
  colorkey: [["similarity", "Similarity", 0.01, 1, 0.01], ["blend", "Blend (soft edge)", 0, 1, 0.01]],
  chromakey: [
    ["similarity", "Similarity", 0.01, 1, 0.01],
    ["blend", "Blend (soft edge)", 0, 1, 0.01],
    ["despill", "Despill", 0, 1, 0.05],
  ],
  lumakey: [
    ["threshold", "Threshold (0 black · 1 white)", 0, 1, 0.01],
    ["tolerance", "Tolerance", 0, 1, 0.01],
    ["softness", "Softness", 0, 1, 0.01],
  ],
};

export interface KeyPatch {
  color?: string;
  params?: Record<string, number>;
}

export interface KeyDetection {
  color: string;
  confidence: number;
}

/** The props of App's RangeField, injected so the key rows match every other slider. */
export interface RangeProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  def: number;
  unit?: string;
  onCommit: (v: number) => void;
}

/** FFmpeg lumakey's luma scale: limited-range BT.601 Y / 255 (black ≈ 0.063). */
function lumaOf(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return Math.round(((16 + (65.481 * r + 128.553 * g + 24.966 * b) / 255) / 255) * 100) / 100;
}

type EyeDropperCtor = new () => { open: () => Promise<{ sRGBHex: string }> };
const eyeDropper = (): EyeDropperCtor | undefined =>
  typeof window !== "undefined" && "EyeDropper" in window
    ? (window as unknown as { EyeDropper: EyeDropperCtor }).EyeDropper
    : undefined;

export function KeyEffectControls({ clipId, effect, disabled, Range, onApply, onDetect }: {
  clipId: string;
  effect: VisualEffect;
  disabled: boolean;
  Range: ComponentType<RangeProps>;
  onApply: (clipId: string, type: string, patch: KeyPatch, effectId?: string) => void;
  onDetect: (clipId: string) => Promise<KeyDetection | null>;
}) {
  const kind: KeyKind = isKeyEffect(effect.type) ? effect.type : "colorkey";
  const hasColor = kind !== "lumakey";
  const color = keyColorHex(effect.color, KEY_DEFAULT_COLOR[kind] || "0x000000");
  const params = { ...KEY_DEFAULTS[kind], ...effect.params };
  const [swatch, setSwatch] = useState(`#${color.slice(2).toLowerCase()}`);
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => setSwatch(`#${color.slice(2).toLowerCase()}`), [color]);

  const commit = (patch: KeyPatch) =>
    onApply(clipId, kind, { color: hasColor ? patch.color ?? color : undefined, params: patch.params ?? params }, effect.id);

  // <input type="color"> fires `input` while dragging in the picker and `change`
  // once on close; React's onChange is the former, so commit on the native one.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const swatchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = swatchRef.current;
    if (!el) return;
    const onChange = () => commitRef.current({ color: keyColorHex(el.value, color) });
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, [color]);

  const auto = async () => {
    const d = await onDetect(clipId);
    if (!d) return;
    const pct = Math.round(d.confidence * 100);
    setHint(
      d.confidence < 0.6
        ? `The border isn't one flat colour (${pct}% match) — pick the background with the eyedropper instead.`
        : `Detected ${d.color} on ${pct}% of the frame border.`,
    );
    if (hasColor) commit({ color: d.color });
    else commit({ params: { ...params, threshold: lumaOf(d.color) } });
  };

  const ED = eyeDropper();
  const pick = async () => {
    if (!ED) return;
    // Preview this clip UNKEYED while picking, so the click lands on its real
    // background rather than on the track that the key reveals.
    setKeyBypass(clipId);
    try {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const { sRGBHex } = await new ED().open();
      const hex = keyColorHex(sRGBHex, color);
      setHint(null);
      if (hasColor) commit({ color: hex });
      else commit({ params: { ...params, threshold: lumaOf(hex) } });
    } catch {
      /* picker cancelled (Esc) */
    } finally {
      setKeyBypass(null);
    }
  };

  return (
    <div className="key-fx">
      <div className="key-fx-head">
        <span className="eff-name">{SHORT_NAMES[kind]}</span>
        {hasColor && (
          <label className="swatch" title="Key colour">
            <input ref={swatchRef} type="color" value={swatch} disabled={disabled}
              onChange={(e) => setSwatch(e.target.value)} aria-label={`${SHORT_NAMES[kind]} colour`} />
            {color}
          </label>
        )}
        <span className="key-fx-actions">
          <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => void auto()}
            title={hasColor ? "Detect the background colour from the frame border" : "Set the threshold from the frame border's brightness"}>
            Auto
          </button>
          {ED && (
            <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => void pick()}
              title={hasColor ? "Pick the key colour from anywhere on screen" : "Pick the brightness to key from anywhere on screen"}>
              Pick
            </button>
          )}
        </span>
      </div>
      {hint && <span className="field-hint">{hint}</span>}
      {SLIDERS[kind].map(([k, label, min, max, step]) => (
        <Range key={k} label={label} min={min} max={max} step={step} def={KEY_DEFAULTS[kind][k] ?? 0}
          value={params[k] ?? KEY_DEFAULTS[kind][k] ?? 0}
          onCommit={(v) => commit({ params: { ...params, [k]: v } })} />
      ))}
    </div>
  );
}
