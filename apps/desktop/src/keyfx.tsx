// Inspector controls for the KEY effects (colorkey / chromakey / lumakey): a key
// colour swatch, "Auto" (detect the background from the frame border), an
// eyedropper (any on-screen pixel; Chromium/Electron only), and each key's
// sliders. What a key has — colour or not, whether "auto" works, which param
// "auto" sets, the sliders' labels/ranges/defaults — comes from the effect
// registry (`@aive/core/effects`). Every change re-applies the effect IN PLACE
// (apply_effect with its effectId), so the live preview (glkey.ts) and the
// export follow along. The effect's name, bypass, reorder and remove controls
// are the stack row's (effectstack.tsx).

import { useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import { effectByType } from "@aive/core/effects";
import type { VisualEffect } from "./types";
import { KEY_DEFAULTS, KEY_DEFAULT_COLOR, hexToRgb, isKeyEffect, keyColorHex, type KeyKind } from "./keying";
import { setKeyBypass } from "./glkey";

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
  const def = effectByType(kind);
  const spec = def?.color;
  const hasColor = !!spec?.default;
  // The param "auto" / the eyedropper set when the key stores no colour (lumakey: threshold).
  const autoParam = spec?.autoParam ?? "threshold";
  const color = keyColorHex(effect.color, KEY_DEFAULT_COLOR[kind] || "0x000000");
  // Only the params the registry declares: a stray key stored by an older build
  // would otherwise be re-sent and rejected by apply_effect's validation.
  const params: Record<string, number> = { ...KEY_DEFAULTS[kind] };
  for (const k of Object.keys(params)) if (typeof effect.params?.[k] === "number") params[k] = effect.params[k];
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
    else commit({ params: { ...params, [autoParam]: lumaOf(d.color) } });
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
      else commit({ params: { ...params, [autoParam]: lumaOf(hex) } });
    } catch {
      /* picker cancelled (Esc) */
    } finally {
      setKeyBypass(null);
    }
  };

  const name = def?.label ?? kind;
  return (
    <div className="key-fx">
      <div className="key-fx-head">
        {hasColor && (
          <label className="swatch" title="Key colour">
            <input ref={swatchRef} type="color" value={swatch} disabled={disabled}
              onChange={(e) => setSwatch(e.target.value)} aria-label={`${name} colour`} />
            {color}
          </label>
        )}
        <span className="key-fx-actions">
          {spec?.auto && (
            <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => void auto()}
              title={hasColor ? "Detect the background colour from the frame border" : `Set the ${autoParam} from the frame border's brightness`}>
              Auto
            </button>
          )}
          {ED && (
            <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => void pick()}
              title={hasColor ? "Pick the key colour from anywhere on screen" : "Pick the brightness to key from anywhere on screen"}>
              Pick
            </button>
          )}
        </span>
      </div>
      {hint && <span className="field-hint">{hint}</span>}
      {(def?.params ?? []).map((p) => (
        <Range key={p.key} label={p.label} min={p.min} max={p.max} step={p.step} def={p.default} unit={p.unit}
          value={params[p.key] ?? p.default}
          onCommit={(v) => commit({ params: { ...params, [p.key]: v } })} />
      ))}
    </div>
  );
}
