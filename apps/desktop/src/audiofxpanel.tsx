// The ClipInspector's "Audio" group for clips that carry sound: CapCut-style
// one-click voice tools on top (Enhance voice, Reduce noise, Normalize
// loudness, a single "Voice effect" slot), then the full audio effect stack
// rendered generically from the registry (`@aive/core/audio-effects`) — add,
// bypass, reorder, remove, every param as a slider (0|1 params as a checkbox).
// Rows whose effect the live preview can't (fully) play carry a "Render exact"
// badge; ones it plays whole but not sample-for-sample (pitch via the voice
// AudioWorklet) a quieter "Approx." mark — "Render exact" where the worklet
// can't load, for robot too. Edits go to the clip that carries the sound (a linked detached-audio
// clip when this one is silenced) — the same clip the core picks.

import { useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import {
  AUDIO_EFFECTS, AUDIO_EFFECT_CATEGORIES, audioEffectByType, audioParamValue, audioPreviewFidelity,
  isAudioEffectEnabled, isSwitchParam, type AudioEffectDef,
} from "@aive/core/audio-effects";
import { subscribeVoiceWorklet, voiceWorkletAvailable } from "./workletstatus";
import type { AudioEffect, Clip, Project } from "./types";
import type { RangeProps } from "./keyfx";
import { VOICE_PRESETS, audioCarrier, firstOfType, toggleOn, voiceSlot } from "./audiofx";
import { ArrowDown, ArrowUp, Eye, EyeOff, Waveform, X } from "./icons";
import "./audiofx.css";

/** Fire one audio rpc (App's run(): busy state + error banner). */
export type AudioRpc = (label: string, method: string, params: Record<string, unknown>) => void;

const GROUPS = AUDIO_EFFECT_CATEGORIES.map((category) => ({
  category,
  effects: AUDIO_EFFECTS.filter((e) => e.category === category),
})).filter((g) => g.effects.length > 0);

/** The effect's stored params limited to what its registry entry declares (so an update never trips validation). */
function storedParams(def: AudioEffectDef, f: AudioEffect): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of def.params) if (f.params?.[p.key] !== undefined) out[p.key] = f.params[p.key];
  return out;
}

function RenderBadge({ type }: { type: string }) {
  const worklet = useSyncExternalStore(subscribeVoiceWorklet, voiceWorkletAvailable);
  const def = audioEffectByType(type);
  const fidelity = audioPreviewFidelity(type, { worklet });
  if (!def || fidelity === "live") return null;
  if (fidelity === "approx" && def.preview !== "export-only") {
    return (
      <span className="eff-badge eff-badge-soft" title={`Live preview is approximate — ${def.preview.approx ?? ""}. Render exact plays the export.`}>
        Approx.
      </span>
    );
  }
  const partial = fidelity === "partial" && def.preview !== "export-only" ? def.preview.partial : undefined;
  const noWorklet = !worklet && def.preview !== "export-only" && !partial;
  return (
    <span className="eff-badge" title={partial
      ? `The live preview plays part of it — its ${partial} are heard in Render exact / export`
      : noWorklet
        ? "This browser can't run the live voice effect (no AudioWorklet: open the app from localhost or the desktop app) — use Render exact above the preview (or export) to hear it"
        : "No live preview for this effect — use Render exact above the preview (or export) to hear it"}>
      Render exact
    </span>
  );
}

/** One param control: a checkbox for 0|1 switches, a slider otherwise. */
function ParamControl({ def, f, k, Range, disabled, onCommit }: {
  def: AudioEffectDef; f: AudioEffect; k: string; Range: ComponentType<RangeProps>; disabled: boolean;
  onCommit: (v: number) => void;
}) {
  const p = def.params.find((q) => q.key === k)!;
  const v = audioParamValue(f, p.key);
  if (isSwitchParam(p)) {
    return (
      <label className="check-row">
        <input type="checkbox" checked={v >= 0.5} disabled={disabled} onChange={(e) => onCommit(e.target.checked ? 1 : 0)} />
        {p.label}
      </label>
    );
  }
  return <Range label={p.label} unit={p.unit} min={p.min} max={p.max} step={p.step} def={p.default} value={v} onCommit={onCommit} />;
}

/** All of an effect's params; each commit sends the full set (an update replaces params). */
function EffectParams({ f, Range, disabled, only, onApply }: {
  f: AudioEffect; Range: ComponentType<RangeProps>; disabled: boolean; only?: string[];
  onApply: (params: Record<string, number>) => void;
}) {
  const def = audioEffectByType(f.type);
  if (!def) return null;
  return (
    <>
      {def.params.filter((p) => !only || only.includes(p.key)).map((p) => (
        <ParamControl key={p.key} def={def} f={f} k={p.key} Range={Range} disabled={disabled}
          onCommit={(v) => onApply({ ...storedParams(def, f), [p.key]: v })} />
      ))}
    </>
  );
}

/** A one-click toggle row: checkbox + label (+ badge), and its controls when on. */
function ToggleRow({ label, title, on, type, disabled, onToggle, children }: {
  label: string; title: string; on: boolean; type: string; disabled: boolean;
  onToggle: (on: boolean) => void; children?: ReactNode;
}) {
  return (
    <div className="afx-toggle">
      <div className="afx-toggle-head">
        <label className="check-row" title={title}>
          <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onToggle(e.target.checked)} />
          {label}
        </label>
        {on && <RenderBadge type={type} />}
      </div>
      {on && children}
    </div>
  );
}

export function AudioEffectsGroup({ clip, project, disabled, Range, rpc }: {
  clip: Clip;
  project: Project | null;
  disabled: boolean;
  Range: ComponentType<RangeProps>;
  rpc: AudioRpc;
}) {
  const carrier = audioCarrier(project, clip);
  const clipId = carrier.id;
  const filters = carrier.effects?.audioFilters ?? [];
  const enh = firstOfType(filters, "enhance_voice");
  const nr = firstOfType(filters, "noise_reduction");
  const norm = firstOfType(filters, "normalize");
  const voice = voiceSlot(filters);

  const apply = (label: string, type: string, params?: Record<string, number>, effectId?: string, enabled?: boolean) =>
    rpc(label, "apply_audio_effect", {
      clipId, type, ...(params ? { params } : {}), ...(effectId ? { effectId } : {}), ...(enabled !== undefined ? { enabled } : {}),
    });
  const remove = (effectId: string) => rpc("Remove audio effect", "remove_audio_effect", { clipId, effectId });
  /** Toggle on: re-enable a bypassed one, else add it; off: remove it. */
  const toggle = (label: string, type: string, existing: AudioEffect | undefined, on: boolean, params?: Record<string, number>) => {
    if (!on) {
      if (existing) remove(existing.id);
    } else if (existing) apply(label, type, undefined, existing.id, true);
    else apply(label, type, params);
  };

  return (
    <div className="group">
      <div className="group-title"><Waveform size={13} /> Audio</div>
      {carrier.id !== clip.id && (
        <span className="field-hint">Edits the linked audio clip — it carries this clip&apos;s sound.</span>
      )}

      <ToggleRow label="Enhance voice" type="enhance_voice" on={toggleOn(enh)} disabled={disabled}
        title="One click: rumble cut, noise reduction, de-ess, warmth + presence EQ, levelling and −16 LUFS"
        onToggle={(on) => (on ? rpc("Enhance voice", "enhance_voice", { clipId }) : enh && remove(enh.id))}>
        {enh && (
          <Range label="Strength" min={0} max={1} step={0.05} def={0.7} value={audioParamValue(enh, "strength")}
            onCommit={(v) => rpc("Enhance voice", "enhance_voice", { clipId, strength: v })} />
        )}
      </ToggleRow>

      <ToggleRow label="Reduce noise" type="noise_reduction" on={toggleOn(nr)} disabled={disabled}
        title="Spectral noise reduction, set from this clip's own measured noise floor"
        onToggle={(on) => toggle("Reduce noise", "noise_reduction", nr, on)}>
        {nr && (
          <EffectParams f={nr} Range={Range} disabled={disabled} only={["amount"]}
            onApply={(params) => apply("Reduce noise", "noise_reduction", params, nr.id)} />
        )}
      </ToggleRow>

      <ToggleRow label="Normalize loudness" type="normalize" on={toggleOn(norm)} disabled={disabled}
        title="Measured at render time, then set to the target loudness (−16 LUFS suits online video)"
        onToggle={(on) => toggle("Normalize loudness", "normalize", norm, on, { target: -16 })}>
        {norm && (
          <EffectParams f={norm} Range={Range} disabled={disabled} only={["target"]}
            onApply={(params) => apply("Normalize loudness", "normalize", params, norm.id)} />
        )}
      </ToggleRow>

      <div className="field afx-voice">
        <label>Voice effect {voice && isAudioEffectEnabled(voice) && <RenderBadge type={voice.type} />}</label>
        <select value={voice?.type ?? ""} disabled={disabled} aria-label="Voice effect"
          onChange={(e) => {
            const type = e.target.value;
            if (!type) {
              if (voice) remove(voice.id);
            } else if (voice) apply("Voice effect", type, undefined, voice.id, true); // replace the slot in place (defaults)
            else apply("Voice effect", type);
          }}>
          <option value="">None</option>
          {VOICE_PRESETS.map((v) => <option key={v.type} value={v.type}>{v.label}</option>)}
        </select>
      </div>
      {voice && (
        <EffectParams f={voice} Range={Range} disabled={disabled}
          onApply={(params) => apply("Voice effect", voice.type, params, voice.id)} />
      )}

      <div className="sub-title">All audio effects</div>
      <div className="field eff-add">
        <select value="" disabled={disabled} aria-label="Add audio effect"
          onChange={(e) => {
            const type = e.target.value;
            if (type === "enhance_voice") rpc("Enhance voice", "enhance_voice", { clipId });
            else if (type) apply("Audio effect", type);
          }}>
          <option value="">Add audio effect…</option>
          {GROUPS.map((g) => (
            <optgroup key={g.category} label={g.category}>
              {g.effects.map((e) => <option key={e.type} value={e.type} title={e.description}>{e.label}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      {filters.length === 0 ? (
        <span className="field-hint">
          Effects run on the clip&apos;s own sound in order — before speed changes, after bleeps. The preview plays EQ, filters,
          compressor, echo, telephone-style, pitch and robot voices live (pitch approximately); noise reduction and normalize need Render exact.
        </span>
      ) : (
        <div className="eff-list">
          {filters.map((f, i) => {
            const def = audioEffectByType(f.type);
            const on = isAudioEffectEnabled(f);
            const label = def?.label ?? f.type;
            return (
              <div className={`eff-row ${on ? "" : "eff-off"}`} key={f.id}>
                <div className="eff-head">
                  <span className="eff-name" title={def?.description}>{label}</span>
                  {def && <RenderBadge type={f.type} />}
                  <span className="eff-actions">
                    <button type="button" className="icon-btn" disabled={disabled || !def}
                      aria-pressed={!on} aria-label={on ? `Bypass ${label}` : `Turn ${label} back on`}
                      title={on ? "Bypass (keep the settings, skip the effect)" : "Bypassed — click to turn back on"}
                      onClick={() => apply(on ? "Bypass" : "Enable", f.type, undefined, f.id, !on)}>
                      {on ? <Eye size={13} /> : <EyeOff size={13} />}
                    </button>
                    <button type="button" className="icon-btn" disabled={disabled || i === 0}
                      aria-label={`Move ${label} up`} title="Move up (earlier in the chain)"
                      onClick={() => rpc("Reorder audio effect", "reorder_audio_effect", { clipId, effectId: f.id, toIndex: i - 1 })}>
                      <ArrowUp size={13} />
                    </button>
                    <button type="button" className="icon-btn" disabled={disabled || i === filters.length - 1}
                      aria-label={`Move ${label} down`} title="Move down (later in the chain)"
                      onClick={() => rpc("Reorder audio effect", "reorder_audio_effect", { clipId, effectId: f.id, toIndex: i + 1 })}>
                      <ArrowDown size={13} />
                    </button>
                    <button type="button" className="icon-btn" disabled={disabled}
                      aria-label={`Remove ${label}`} title="Remove" onClick={() => remove(f.id)}>
                      <X size={13} />
                    </button>
                  </span>
                </div>
                {def && (
                  <div className="eff-body">
                    <EffectParams f={f} Range={Range} disabled={disabled}
                      onApply={(params) => apply(label, f.type, params, f.id)} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
