// The ClipInspector's Speed area: Normal | Curve (CapCut-style curve speed).
// Normal shows the constant Speed slider (passed in). Curve shows the preset
// chips (Montage, Hero, Bullet, Jump cut, Flash in, Flash out, Custom), a small
// SVG curve editor over the clip's used SOURCE range (log speed axis
// 0.1x–10x), the resulting clip duration and the audio mode. The curve math is
// `@aive/core/speed` — the same code the export retimes with — so the editor,
// the timeline and the render agree. Every gesture commits ONE set_speed_ramp
// (one undo step) on release.
//
// Editor gestures: drag a point (both axes; it stays between its neighbours),
// double-click empty space to add a point, click a point then Delete /
// Backspace to remove it.

import {
  useEffect, useMemo, useRef, useState,
  type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from "react";
import {
  RAMP_MAX_POINTS, RAMP_MAX_SPEED, RAMP_MIN_SPEED, RAMP_PRESETS, RAMP_PRESET_DEFS,
  buildSpeedCurve, clipFootprintFrames, curveSpeedAt,
  type RampAudio, type RampPreset, type SpeedRampPoint,
} from "@aive/core/speed";
import type { Clip } from "./types";
import "./speedramp.css";

export interface SpeedRampParams {
  preset?: RampPreset;
  points?: SpeedRampPoint[];
  audio?: RampAudio;
}

// viewBox geometry (the SVG scales to the inspector width).
const W = 300;
const H = 132;
const PAD_L = 36;
const PAD_R = 8;
const PAD_T = 8;
const PAD_B = 8;
const GRID = [0.1, 0.25, 0.5, 1, 2, 4, 10];
const LOG_MIN = Math.log10(RAMP_MIN_SPEED);
const LOG_SPAN = Math.log10(RAMP_MAX_SPEED) - LOG_MIN;
/** Closest two points may come, in source seconds (core merges points < 1 ms apart). */
const MIN_GAP = 0.002;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const fmtX = (v: number) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1).replace(/\.0$/, "") : v.toFixed(2).replace(/0$/, ""));

export function SpeedPanel(props: {
  clip: Clip;
  fps: number;
  disabled: boolean;
  /** The clip has its own sound (shows the Audio select). */
  hasAudio: boolean;
  /** The constant-speed control, shown in Normal mode. */
  normal: ReactNode;
  onRamp: (clipId: string, params: SpeedRampParams) => void;
  onClearRamp: (clipId: string) => void;
}) {
  const { clip, fps, disabled } = props;
  const ramp = clip.effects?.speedRamp;
  const ramped = !!ramp?.points?.length;
  const [mode, setMode] = useState<"normal" | "curve">(ramped ? "curve" : "normal");
  // Follow the clip: selecting another clip (or undo) shows its own mode.
  useEffect(() => setMode(ramped ? "curve" : "normal"), [clip.id, ramped]);

  const srcIn = clip.sourceInFrame / fps;
  const srcOut = clip.sourceOutFrame / fps;

  const pickNormal = () => {
    setMode("normal");
    if (ramped) props.onClearRamp(clip.id);
  };
  const pickCustom = () => {
    if (ramped) {
      // Keep the current shape, drop the preset label (it becomes "Custom").
      if (ramp!.preset) props.onRamp(clip.id, { points: ramp!.points });
      return;
    }
    const mid = (srcIn + srcOut) / 2;
    props.onRamp(clip.id, { points: [{ src: srcIn, speed: 1 }, { src: mid, speed: 1 }, { src: srcOut, speed: 1 }] });
  };

  return (
    <div className="sr-panel">
      <div className="sr-head">
        <span className="sr-label">Speed</span>
        <div className="seg" role="tablist" aria-label="Speed mode">
          <button type="button" role="tab" aria-selected={mode === "normal"} className={`seg-btn ${mode === "normal" ? "active" : ""}`} disabled={disabled} onClick={pickNormal}>
            Normal
          </button>
          <button type="button" role="tab" aria-selected={mode === "curve"} className={`seg-btn ${mode === "curve" ? "active" : ""}`} disabled={disabled} onClick={() => setMode("curve")}>
            Curve
          </button>
        </div>
      </div>

      {mode === "normal" && props.normal}

      {mode === "curve" && (
        <>
          <div className="sr-chips" role="group" aria-label="Curve presets">
            {RAMP_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className={`sr-chip ${ramp?.preset === p ? "on" : ""}`}
                disabled={disabled}
                title={RAMP_PRESET_DEFS[p].description}
                onClick={() => props.onRamp(clip.id, { preset: p })}
              >
                {RAMP_PRESET_DEFS[p].label}
              </button>
            ))}
            <button type="button" className={`sr-chip ${ramped && !ramp?.preset ? "on" : ""}`} disabled={disabled} title="Shape your own curve in the editor" onClick={pickCustom}>
              Custom
            </button>
          </div>
          {ramped ? (
            <CurveEditor
              key={clip.id}
              clip={clip}
              fps={fps}
              disabled={disabled}
              onCommit={(points) => props.onRamp(clip.id, { points })}
            />
          ) : (
            <span className="field-hint">Pick a preset, or Custom to draw your own curve.</span>
          )}
          {ramped && props.hasAudio && (
            <div className="sr-audio">
              <label htmlFor={`sr-audio-${clip.id}`}>Audio</label>
              <select
                id={`sr-audio-${clip.id}`}
                value={ramp?.audio ?? "stretch"}
                disabled={disabled}
                onChange={(e) => props.onRamp(clip.id, { audio: e.target.value as RampAudio })}
              >
                <option value="stretch">Stretch (keep pitch)</option>
                <option value="mute">Mute</option>
              </select>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CurveEditor(props: { clip: Clip; fps: number; disabled: boolean; onCommit: (points: SpeedRampPoint[]) => void }) {
  const { clip, fps, disabled } = props;
  const stored = clip.effects?.speedRamp?.points ?? [];
  const [draft, setDraft] = useState<SpeedRampPoint[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ index: number; moved: boolean } | null>(null);
  // A new stored curve (the commit landed, undo, another edit) replaces the local draft.
  const storedKey = JSON.stringify(stored);
  useEffect(() => {
    if (!dragRef.current) setDraft(null);
  }, [storedKey]);

  const points = draft ?? stored;
  const srcIn = clip.sourceInFrame / fps;
  const srcOut = Math.max(srcIn + 1e-3, clip.sourceOutFrame / fps);
  const span = srcOut - srcIn;

  const xOf = (s: number) => PAD_L + ((s - srcIn) / span) * (W - PAD_L - PAD_R);
  const yOf = (v: number) => PAD_T + (1 - (Math.log10(clamp(v, RAMP_MIN_SPEED, RAMP_MAX_SPEED)) - LOG_MIN) / LOG_SPAN) * (H - PAD_T - PAD_B);
  const sOf = (x: number) => srcIn + ((x - PAD_L) / (W - PAD_L - PAD_R)) * span;
  const vOf = (y: number) => 10 ** (LOG_MIN + (1 - (y - PAD_T) / (H - PAD_T - PAD_B)) * LOG_SPAN);

  const path = useMemo(() => {
    if (!points.length) return "";
    const c = buildSpeedCurve(points);
    const n = 120;
    let d = "";
    for (let i = 0; i <= n; i++) {
      const s = srcIn + (span * i) / n;
      d += `${i ? "L" : "M"}${xOf(s).toFixed(2)},${yOf(curveSpeedAt(c, s)).toFixed(2)}`;
    }
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, srcIn, span]);

  const durationSec = clipFootprintFrames({ ...clip, effects: { ...clip.effects, speedRamp: { ...clip.effects?.speedRamp, points } } }, fps) / fps;

  const toView = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  const onPointDown = (index: number) => (e: ReactPointerEvent) => {
    if (disabled || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    svgRef.current?.focus();
    setSelected(index);
    dragRef.current = { index, moved: false };
    svgRef.current?.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const { x, y } = toView(e);
    const base = draft ?? stored;
    const prev = base[d.index - 1];
    const next = base[d.index + 1];
    const lo = Math.max(srcIn, prev ? prev.src + MIN_GAP : -Infinity);
    const hi = Math.min(srcOut, next ? next.src - MIN_GAP : Infinity);
    const src = lo <= hi ? clamp(sOf(x), lo, hi) : base[d.index].src;
    const speed = Math.round(clamp(vOf(y), RAMP_MIN_SPEED, RAMP_MAX_SPEED) * 100) / 100;
    d.moved = true;
    setDraft(base.map((p, i) => (i === d.index ? { src, speed } : p)));
  };
  const onUp = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
    if (d?.moved && draft) props.onCommit(draft);
  };
  const onDoubleClick = (e: ReactMouseEvent) => {
    if (disabled || points.length >= RAMP_MAX_POINTS) return;
    const { x, y } = toView(e);
    if (x < PAD_L || x > W - PAD_R) return;
    const src = clamp(sOf(x), srcIn, srcOut);
    if (points.some((p) => Math.abs(p.src - src) < MIN_GAP * 2)) return;
    const speed = Math.round(clamp(vOf(y), RAMP_MIN_SPEED, RAMP_MAX_SPEED) * 100) / 100;
    const next = [...points, { src, speed }].sort((a, b) => a.src - b.src);
    setDraft(next);
    setSelected(next.findIndex((p) => p.src === src));
    props.onCommit(next);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      // Never let the editor's Delete reach the app's "delete clip" shortcut,
      // even with no point selected (the SVG keeps focus after a click).
      e.preventDefault();
      e.stopPropagation();
      if (selected === null || disabled || points.length <= 1) return;
      const next = points.filter((_, i) => i !== selected);
      setSelected(null);
      setDraft(next);
      props.onCommit(next);
    }
  };

  return (
    <div className="sr-editor">
      <svg
        ref={svgRef}
        className="sr-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="application"
        aria-label="Speed curve editor: drag points, double-click to add, select and press Delete to remove"
        tabIndex={0}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onPointerDown={() => setSelected(null)}
      >
        {GRID.map((v) => (
          <g key={v}>
            <line className={`sr-grid ${v === 1 ? "one" : ""}`} x1={PAD_L} x2={W - PAD_R} y1={yOf(v)} y2={yOf(v)} />
            <text className="sr-tick" x={PAD_L - 8} y={yOf(v) + 3}>{fmtX(v)}x</text>
          </g>
        ))}
        <path className="sr-curve" d={path} />
        {points.map((p, i) =>
          p.src >= srcIn - 1e-6 && p.src <= srcOut + 1e-6 ? (
            <circle
              key={i}
              className={`sr-pt ${selected === i ? "sel" : ""}`}
              cx={xOf(p.src)}
              cy={yOf(p.speed)}
              r={selected === i ? 6 : 4.5}
              onPointerDown={onPointDown(i)}
            >
              <title>{`${fmtX(p.speed)}x at ${p.src.toFixed(2)} s`}</title>
            </circle>
          ) : null,
        )}
      </svg>
      <div className="sr-meta">
        <span>Duration {durationSec.toFixed(2)} s</span>
        <span className="sr-dim">(1x: {span.toFixed(2)} s)</span>
      </div>
    </div>
  );
}
