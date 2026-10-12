// Inspector controls for blend modes and shape masks (CapCut-style), generated
// from the shared `@aive/core/compositing` vocabulary: a "Blend" select (shown
// next to Opacity) and a "Mask" group with shape buttons, the sliders that
// apply to the chosen shape, and an Invert toggle. Every change is ONE RPC
// (set_clip_blend_mode / set_clip_mask) = one undo step. While a mask exists
// the preview shows a handle to drag its centre (maskedit.ts).

import { useEffect, useRef } from "react";
import type { ComponentType } from "react";
import { BLEND_MODE_DEFS, MASK_PARAMS, MASK_SHAPES, runBlendModes, sanitizeMask, type BlendMode, type MaskShape } from "@aive/core/compositing";
import type { Clip, Project } from "./types";
import type { RangeProps } from "./keyfx";
import { setMaskEditTarget } from "./maskedit";
import { Frame } from "./icons";

const SHAPE_LABELS: Record<MaskShape, string> = {
  rect: "Rectangle",
  ellipse: "Ellipse",
  linear: "Linear",
  mirror: "Mirror",
};

/** Button captions (the full name is the tooltip / accessible name). */
const SHAPE_SHORT: Record<MaskShape, string> = { rect: "Rect", ellipse: "Ellipse", linear: "Linear", mirror: "Mirror" };

/** Small glyph per shape for the segmented buttons. */
function ShapeGlyph({ shape }: { shape: MaskShape | "none" }) {
  const p = { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, "aria-hidden": true } as const;
  switch (shape) {
    case "rect": return <svg {...p}><rect x="2.5" y="4" width="11" height="8" rx="1" /></svg>;
    case "ellipse": return <svg {...p}><ellipse cx="8" cy="8" rx="5.5" ry="4.5" /></svg>;
    case "linear": return <svg {...p}><path d="M2 9.5h12" /><path d="M2 6.5h12" strokeOpacity="0.35" strokeDasharray="1.5 1.5" /></svg>;
    case "mirror": return <svg {...p}><path d="M2 5.5h12M2 10.5h12" /></svg>;
    default: return <svg {...p}><path d="M3.5 12.5l9-9" /><circle cx="8" cy="8" r="5.5" /></svg>;
  }
}

/** The Blend select. */
/**
 * The mode a clip actually renders with: a transition-joined run composites as
 * ONE stream with its FIRST clip's mode (export + preview), so a follower shows
 * its lead's mode even if its own stored field differs.
 */
export function effectiveBlendModeOf(project: Project | null, clip: Clip): BlendMode {
  const track = project?.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
  if (!project || !track) return clip.effects?.blendMode ?? "normal";
  const hasVideo = new Set(project.assets.filter((a) => a.hasVideo).map((a) => a.id));
  const pics = track.clips
    .filter((c) => !c.adjustment && !!c.assetId && hasVideo.has(c.assetId))
    .sort((a, b) => a.startFrame - b.startFrame);
  const i = pics.findIndex((c) => c.id === clip.id);
  return i < 0 ? clip.effects?.blendMode ?? "normal" : runBlendModes(pics)[i];
}

export function BlendSelect({ value, disabled, onChange }: {
  value: BlendMode | undefined; disabled: boolean; onChange: (mode: BlendMode) => void;
}) {
  return (
    <div className="field">
      <label>Blend</label>
      <select
        value={value ?? "normal"}
        disabled={disabled}
        aria-label="Blend mode"
        title={BLEND_MODE_DEFS.find((d) => d.mode === (value ?? "normal"))?.description}
        onChange={(e) => onChange(e.target.value as BlendMode)}
      >
        {BLEND_MODE_DEFS.map((d) => (
          <option key={d.mode} value={d.mode} title={d.description}>{d.label}</option>
        ))}
      </select>
    </div>
  );
}

/** A set_clip_mask patch (shape null removes the mask). */
export type MaskPatch = Record<string, number | boolean | string | null>;

/** The Mask group. */
export function MaskGroup({ clip, disabled, Range, onMask }: {
  clip: Clip;
  disabled: boolean;
  Range: ComponentType<RangeProps>;
  onMask: (clipId: string, patch: MaskPatch) => void;
}) {
  const mask = sanitizeMask(clip.effects?.mask);
  const onMaskRef = useRef(onMask);
  onMaskRef.current = onMask;

  // While this clip has a mask and the group is on screen, the preview offers
  // a draggable centre handle; one RPC on release.
  const hasMask = !!mask;
  useEffect(() => {
    if (!hasMask) return;
    const commit = (x: number, y: number) =>
      onMaskRef.current(clip.id, { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)) });
    setMaskEditTarget({ clipId: clip.id, commit });
    return () => setMaskEditTarget(null);
  }, [clip.id, hasMask]);

  const params = mask ? MASK_PARAMS.filter((p) => p.shapes.includes(mask.shape)) : [];
  return (
    <div className="group">
      <div className="group-title"><Frame size={13} /> Mask</div>
      <div className="seg mask-shapes" role="radiogroup" aria-label="Mask shape">
        {(["none", ...MASK_SHAPES] as const).map((s) => {
          const active = (mask?.shape ?? "none") === s;
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={active}
              className={`seg-btn ${active ? "active" : ""}`}
              disabled={disabled}
              title={s === "none" ? "No mask" : SHAPE_LABELS[s]}
              aria-label={s === "none" ? "No mask" : SHAPE_LABELS[s]}
              onClick={() => {
                if (active) return;
                onMask(clip.id, { shape: s === "none" ? null : s });
              }}
            >
              <ShapeGlyph shape={s} />
              <span className="mask-shape-label">{s === "none" ? "None" : SHAPE_SHORT[s]}</span>
            </button>
          );
        })}
      </div>
      {mask && (
        <>
          {params.map((p) => (
            <Range
              key={`${p.key}-${mask.shape}`}
              label={p.key === "rotation" ? "Mask rotation" : p.label}
              unit={p.unit}
              min={p.min}
              max={p.max}
              step={p.step}
              def={p.default}
              value={mask[p.key]}
              onCommit={(v) => onMask(clip.id, { [p.key]: v })}
            />
          ))}
          <label className="check-row">
            <input type="checkbox" checked={mask.invert} disabled={disabled}
              onChange={(e) => onMask(clip.id, { invert: e.target.checked })} />
            Invert (keep the outside)
          </label>
          <span className="field-hint">
            The mask lives in the clip's own picture, so it follows position, scale and rotation. Drag the
            ✛ handle on the preview to move it.
          </span>
        </>
      )}
    </div>
  );
}
