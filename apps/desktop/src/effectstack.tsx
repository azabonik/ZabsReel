// The ClipInspector's Effects group, generated from the effect registry
// (`@aive/core/effects`): an "Add effect" menu grouped by category, and one row
// per stacked effect with its registry params as sliders (plus a colour swatch
// for effects that take a colour), a bypass toggle, up/down reorder and remove.
// Keys keep their richer controls (keyfx.tsx: Auto, Pick). Rows whose effect
// has no live preview here (no WebGL2 path, or WebGL2 unavailable and no CSS
// proxy) carry a "Render exact" badge — only the FFmpeg render shows them; an
// approximate live preview carries a softer "≈".

import { useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import { EFFECTS, EFFECT_CATEGORIES, defaultsFor, effectByType, effectGL, isEnabled, keyColorHex, previewFidelity, type EffectDef } from "@aive/core/effects";
import { glReady } from "./gl/runtime";
import type { VisualEffect } from "./types";
import { KeyEffectControls, type KeyDetection, type KeyPatch, type RangeProps } from "./keyfx";
import { isKeyEffect } from "./keying";
import { ArrowDown, ArrowUp, Eye, EyeOff, X } from "./icons";

/** An apply_effect request (validated + clamped by the core). */
export interface EffectRequest {
  type: string;
  amount?: number;
  color?: string;
  params?: Record<string, number>;
  enabled?: boolean;
}

const GROUPS = EFFECT_CATEGORIES.map((category) => ({
  category,
  effects: EFFECTS.filter((e) => e.category === category),
})).filter((g) => g.effects.length > 0);

/**
 * The effect's stored values, limited to what its registry entry declares, so
 * an update never trips validation on a stray field from an old project.
 */
function storedRequest(def: EffectDef, f: VisualEffect): EffectRequest {
  const req: EffectRequest = { type: f.type };
  if (def.params.some((p) => p.key === "amount") && f.amount !== undefined) req.amount = f.amount;
  const params: Record<string, number> = {};
  for (const p of def.params) if (p.key !== "amount" && f.params?.[p.key] !== undefined) params[p.key] = f.params[p.key];
  if (Object.keys(params).length) req.params = params;
  if (def.color?.default && f.color) req.color = f.color;
  return req;
}

/** A colour swatch for a non-key effect with a colour param (commits on picker close). */
function ColorSwatch({ value, label, disabled, onCommit }: {
  value: string; label: string; disabled: boolean; onCommit: (hex: string) => void;
}) {
  const [swatch, setSwatch] = useState(`#${value.slice(2).toLowerCase()}`);
  useEffect(() => setSwatch(`#${value.slice(2).toLowerCase()}`), [value]);
  const ref = useRef<HTMLInputElement>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onChange = () => commitRef.current(keyColorHex(el.value, value));
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, [value]);
  // The browser/Electron EyeDropper samples any pixel on screen (e.g. the colour to
  // keep, straight from the preview). Hidden where unsupported.
  const ED = typeof window !== "undefined" && "EyeDropper" in window
    ? (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper
    : undefined;
  const pick = async () => {
    if (!ED) return;
    try {
      const { sRGBHex } = await new ED().open();
      commitRef.current(keyColorHex(sRGBHex, value));
    } catch {
      /* picker cancelled (Esc) */
    }
  };
  return (
    <>
      <label className="swatch" title={label}>
        <input ref={ref} type="color" value={swatch} disabled={disabled}
          onChange={(e) => setSwatch(e.target.value)} aria-label={label} />
        {value}
      </label>
      {ED && (
        <button type="button" className="btn btn-sm" disabled={disabled} onClick={pick}
          title="Pick the colour from anywhere on screen (the preview, for instance)">
          Pick
        </button>
      )}
    </>
  );
}

/** How the live preview shows an effect on this machine (WebGL2 or the CSS fallback). */
function fidelityOf(type: string) {
  return previewFidelity(type, glReady());
}

export function EffectStack({ clipId, filters, disabled, Range, onApply, onRemove, onReorder, onApplyKey, onDetectKey }: {
  clipId: string;
  filters: VisualEffect[];
  disabled: boolean;
  Range: ComponentType<RangeProps>;
  onApply: (clipId: string, req: EffectRequest, effectId?: string) => void;
  onRemove: (clipId: string, effectId: string) => void;
  onReorder: (clipId: string, effectId: string, toIndex: number) => void;
  onApplyKey: (clipId: string, type: string, patch: KeyPatch, effectId?: string) => void;
  onDetectKey: (clipId: string) => Promise<KeyDetection | null>;
}) {
  const add = (type: string) => {
    if (!type) return;
    // Keys start from the detected background colour so the first result already works.
    if (isKeyEffect(type)) onApplyKey(clipId, type, { color: "auto" });
    else {
      const d = defaultsFor(type);
      onApply(clipId, { type, ...(d.amount !== undefined ? { amount: d.amount } : {}), ...(d.color ? { color: d.color } : {}) });
    }
  };

  return (
    <>
      <div className="field eff-add">
        <label>Add effect</label>
        <select value="" disabled={disabled} onChange={(e) => add(e.target.value)} aria-label="Add effect">
          <option value="">Choose…</option>
          {GROUPS.map((g) => (
            <optgroup key={g.category} label={g.category}>
              {g.effects.map((e) => <option key={e.type} value={e.type} title={e.description}>{e.label}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      {filters.length === 0 ? (
        <span className="field-hint">Stack exposure, blur, glow, grain, vignette, keys and more — applied in order after color, live in the preview. Put a keyed clip on the track above.</span>
      ) : (
        <div className="eff-list">
          {filters.map((f, i) => {
            const def = effectByType(f.type);
            const on = isEnabled(f);
            const label = def?.label ?? f.type;
            return (
              <div className={`eff-row ${on ? "" : "eff-off"}`} key={f.id}>
                <div className="eff-head">
                  <span className="eff-name" title={def?.description}>{label}</span>
                  {def && fidelityOf(f.type) === "none" && (
                    <span className="eff-badge" title="No live preview for this effect here — use Render exact above the preview to see it">
                      Render exact
                    </span>
                  )}
                  {def && fidelityOf(f.type) === "approx" && (
                    <span className="eff-badge eff-badge-soft" title={`Live preview is approximate — ${effectGL(f.type)?.note ?? ""} Render exact shows the export.`}>
                      ≈
                    </span>
                  )}
                  <span className="eff-actions">
                    <button type="button" className="icon-btn" disabled={disabled || !def}
                      aria-pressed={!on} aria-label={on ? `Bypass ${label}` : `Turn ${label} back on`}
                      title={on ? "Bypass (keep the settings, skip the effect)" : "Bypassed — click to turn back on"}
                      onClick={() => onApply(clipId, { type: f.type, enabled: !on }, f.id)}>
                      {on ? <Eye size={13} /> : <EyeOff size={13} />}
                    </button>
                    <button type="button" className="icon-btn" disabled={disabled || i === 0}
                      aria-label={`Move ${label} up`} title="Move up (earlier in the stack)"
                      onClick={() => onReorder(clipId, f.id, i - 1)}>
                      <ArrowUp size={13} />
                    </button>
                    <button type="button" className="icon-btn" disabled={disabled || i === filters.length - 1}
                      aria-label={`Move ${label} down`} title="Move down (later in the stack)"
                      onClick={() => onReorder(clipId, f.id, i + 1)}>
                      <ArrowDown size={13} />
                    </button>
                    <button type="button" className="icon-btn" disabled={disabled}
                      aria-label={`Remove ${label}`} title="Remove" onClick={() => onRemove(clipId, f.id)}>
                      <X size={13} />
                    </button>
                  </span>
                </div>
                {def && (
                  <div className="eff-body">
                    {isKeyEffect(f.type) ? (
                      <KeyEffectControls clipId={clipId} effect={f} disabled={disabled} Range={Range}
                        onApply={onApplyKey} onDetect={onDetectKey} />
                    ) : (
                      <>
                        {def.color?.default && (
                          <ColorSwatch value={keyColorHex(f.color, def.color.default)} label={`${label} colour`} disabled={disabled}
                            onCommit={(hex) => onApply(clipId, { ...storedRequest(def, f), color: hex }, f.id)} />
                        )}
                        {def.params.map((p) => {
                          const stored = p.key === "amount" ? f.amount : f.params?.[p.key];
                          return (
                            <Range key={p.key} label={p.label} unit={p.unit} min={p.min} max={p.max} step={p.step} def={p.default}
                              value={stored ?? p.default}
                              onCommit={(v) => {
                                const req = storedRequest(def, f);
                                if (p.key === "amount") req.amount = v;
                                else req.params = { ...req.params, [p.key]: v };
                                onApply(clipId, req, f.id);
                              }} />
                          );
                        })}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
