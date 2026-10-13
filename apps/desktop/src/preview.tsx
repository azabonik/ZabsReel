// Real-time preview compositor. Instead of one <video> playing the base track,
// this draws EVERY video track per frame onto a <canvas> in true z-order (higher
// Track.index on top), with opacity/fades, crop and a color proxy — and mixes
// audio from all tracks plus the music bed. It's the "modern feel": live
// layering while you scrub, no FFmpeg render needed. The exact, frame-accurate
// composite still lives behind "Render exact" / Export (FFmpeg is ground truth).
//
// How it works: composite.ts is a PURE (model, playhead) -> draw plan; a
// MediaPool of hidden <video> decoders supplies the pixels/audio; this component
// owns the master clock (RAF) and rasterizes the plan with Canvas2D. Text and
// captions stay DOM overlays on top of the canvas. Each layer's LOOK — colour
// grade, curves, LUT and the effect stack, keys included, in the export's
// order — runs through the WebGL2 pipeline (gl/: ports of the FFmpeg filters,
// so the preview matches the export), and the 2D code then applies the mask,
// blend mode, transform and opacity. Without WebGL2 (or while the context is
// lost) the look falls back to CSS filter proxies and a canvas vignette pass.

import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from "react";
import type { CSSProperties } from "react";
import type { CoreApi } from "./api";
import type { MediaAsset, MusicSettings, Project, TextStyle } from "./types";
import {
  HOLD_MS, holdLastFrame, segmentAt, stepFrames, totalDuration,
  type PlayerHandle, type PlaybackStore, type Segment,
} from "./playback";
import { activeLayersAt, timelineDurationSec, type ActiveClip } from "./composite";
import { MediaPool } from "./mediapool";
import { AudioRouter } from "./audiograph";
import { isKeyBypassed, onKeyBypassChange } from "./glkey";
import { vignetteGradient, vignetteLayer } from "./vignette2d";
import { glReady, glSoftware, onGLChange, runLayer, setFileUrl } from "./gl/runtime";
import { cachedPlan, type LayerLook } from "./gl/plan";
import { PlaybackGovernor } from "./gl/governor";
import { canvasBlendOp, type ClipMask } from "@aive/core/compositing";
import { canvasToMask, layerXform, maskStageSize, maskToCanvas, stageMasked, type LayerXform } from "./maskdraw";
import { maskDragFor, maskEditTarget, onMaskEditChange, setMaskDrag } from "./maskedit";
import { Film, Play, Waveform } from "./icons";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

const POS_STYLE: Record<string, CSSProperties> = {
  top: { top: "7%", left: 0, right: 0, justifyContent: "center" },
  center: { top: "50%", left: 0, right: 0, justifyContent: "center", transform: "translateY(-50%)" },
  bottom: { bottom: "9%", left: 0, right: 0, justifyContent: "center" },
  topleft: { top: "7%", left: "6%", justifyContent: "flex-start" },
  topright: { top: "7%", right: "6%", justifyContent: "flex-end" },
  bottomleft: { bottom: "9%", left: "6%", justifyContent: "flex-start" },
  bottomright: { bottom: "9%", right: "6%", justifyContent: "flex-end" },
};

// FFmpeg colors (#RRGGBB[AA], a name, or name@alpha) → a CSS-safe color. The
// preview approximates `name@alpha` by dropping the alpha.
function cssColor(c: string | undefined, fallback: string): string {
  if (!c) return fallback;
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c)) return c;
  const at = c.indexOf("@");
  return at >= 0 ? c.slice(0, at) || fallback : c;
}

// Render a styled text line over the canvas — the live proxy for the FFmpeg
// drawtext burn-in. Honors the full open style (font, color, outline, shadow,
// box, keyword position or free x/y).
function textBlock(
  key: string,
  text: string,
  style: TextStyle | undefined,
  defaultBox: boolean,
  canvasH: number,
  anim?: { x?: number; y?: number; opacity?: number },
) {
  const s = style ?? {};
  // Animated x/y (canvas fractions) override the static placement this frame.
  const ax = anim?.x ?? s.x;
  const ay = anim?.y ?? s.y;
  const pos: CSSProperties =
    ax !== undefined || ay !== undefined
      ? { left: `${(ax ?? 0.5) * 100}%`, top: `${(ay ?? 0.5) * 100}%`, transform: "translate(-50%, -50%)", justifyContent: "center" }
      : POS_STYLE[s.position ?? "bottom"] ?? POS_STYLE.bottom;

  const box = s.box ?? defaultBox;
  const shadows = ["0 2px 8px rgba(0,0,0,0.55)"];
  if ((s.shadowX ?? 0) !== 0 || (s.shadowY ?? 0) !== 0) {
    shadows.unshift(`${s.shadowX ?? 2}px ${s.shadowY ?? 2}px 2px ${cssColor(s.shadowColor, "#000")}`);
  }
  const container: CSSProperties = {
    ...pos,
    ...(anim?.opacity !== undefined ? { opacity: Math.min(1, Math.max(0, anim.opacity)) } : {}),
    color: cssColor(s.color, "#fff"),
    fontFamily: s.font ? `"${s.font}", inherit` : undefined,
    // Size text as the SAME fraction of the displayed canvas height that the
    // FFmpeg export uses (fontSize px ÷ project canvas height). `cqh` resolves
    // against the .pv-overlays container (= the stage/canvas height), so the
    // preview matches the export instead of using window-relative `vh` (which
    // made text balloon and wrap on small preview panels).
    fontSize: `clamp(8px, ${(((s.fontSize ?? 42) / canvasH) * 100).toFixed(3)}cqh, 400px)`,
    textShadow: shadows.join(", "),
    ...(s.outlineWidth && s.outlineWidth > 0
      ? { WebkitTextStroke: `${Math.min(s.outlineWidth, 6)}px ${cssColor(s.outlineColor, "#000")}` }
      : {}),
  };
  return (
    <div key={key} className="pv-text" style={container}>
      <span
        className={box ? "pv-text-box" : ""}
        style={box ? { background: cssColor(s.boxColor, "rgba(0,0,0,0.62)") } : undefined}
      >
        {text}
      </span>
    </div>
  );
}

/** Compositor drawing-buffer size: project aspect, long edge capped for speed. */
function bufferSize(project: Project | null, maxLongEdge = 1280): { w: number; h: number } {
  if (!project) return { w: 1280, h: 720 };
  const longEdge = Math.max(project.width, project.height);
  const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
  return { w: Math.max(2, Math.round(project.width * scale)), h: Math.max(2, Math.round(project.height * scale)) };
}

/** What the GL path needs besides the layer's draw plan. */
interface GLDraw {
  /** Project (export) canvas size. */
  cw: number;
  ch: number;
  /** Timeline frame number (grain, trails). */
  frame: number;
  layerId: string;
  /** Leave the keys out (the eyedropper picks from the unkeyed frame). */
  skipKeys: boolean;
  /**
   * Divisor of the looks' processing resolution: 1 when paused or on a GPU;
   * while playing on a software renderer, the PlaybackGovernor's (2, or 4
   * when frames still come too slowly) to keep the frame rate.
   */
  div: number;
}

/** Processing-size cap of the GL path (its targets are pooled by size). */
const GL_MAX_EDGE = 4096;

/**
 * Run the layer's look through the WebGL2 pipeline. It processes the layer's
 * whole canvas-space frame (the fitted picture plus transparent padding — what
 * the export's filters see) at the buffer size × a power-of-two bucket of the
 * zoom, never above the source's own resolution. Returns what to draw — the
 * frame (or, masked, the staged picture) and where it goes in the layer's
 * transformed space — or null to fall back to the CSS path.
 */
function lookThroughGL(
  el: HTMLVideoElement | HTMLImageElement, d: NonNullable<ActiveClip["draw"]>, W: number, H: number, g: GLDraw,
  iw: number, ih: number, sx: number, sy: number, sw: number, sh: number,
): { src: CanvasImageSource; r: [number, number, number, number]; dst: [number, number, number, number] } | null {
  if (!d.look || !glReady()) return null;
  const fitB = Math.min(W / sw, H / sh); // buffer px per source px
  const s = Math.abs(d.transform.scale) || 1;
  let q = Math.min(8, 2 ** Math.ceil(Math.log2(Math.max(1 / 8, s))));
  q = Math.min(q, Math.max(1, 1 / fitB), GL_MAX_EDGE / Math.max(W, H));
  if (g.div > 1) q = Math.max(1 / 8, q / g.div);
  const PW = Math.max(1, Math.round(W * q));
  const PH = Math.max(1, Math.round(H * q));
  const k = PW / g.cw;
  const steps = cachedPlan(d.look, { k, w: PW, h: PH, cw: g.cw, ch: g.ch }, { skipKeys: g.skipKeys });
  if (!steps.length) return null;
  // The export's fit (scale … force_original_aspect_ratio=decrease, pad centred), in canvas px.
  const fw = Math.min(g.cw, Math.round((g.ch * sw) / sh));
  const fh = Math.min(g.ch, Math.round((g.cw * sh) / sw));
  const pic = { x: Math.trunc((g.cw - fw) / 2) * k, y: Math.trunc((g.ch - fh) / 2) * k, w: fw * k, h: fh * k };
  const res = runLayer({
    source: el, srcW: iw, srcH: ih, dynamic: el instanceof HTMLVideoElement,
    crop: { x: sx, y: sy, w: sw, h: sh }, w: PW, h: PH, pic, steps, k, cw: g.cw, ch: g.ch,
    frame: g.frame, layerId: g.layerId,
  });
  if (!res) return null;
  if (d.mask) {
    // The mask lives in the picture: stage just the picture rect and mask it.
    const dw = pic.w / q;
    const dh = pic.h / q;
    const full = maskStageSize(dw, dh, d.transform.scale, sw, sh);
    // At a playback resolution the picture has no more detail than the GL
    // result: stage it at that size (the 2D mask work drops with it).
    const m = g.div > 1
      ? { w: Math.max(1, Math.min(full.w, Math.round(pic.w))), h: Math.max(1, Math.min(full.h, Math.round(pic.h))) }
      : full;
    const staged = stageMasked(res.canvas, res.x + pic.x, res.y + pic.y, pic.w, pic.h, "none", m.w, m.h, d.mask);
    if (!staged) return null;
    return { src: staged, r: [0, 0, m.w, m.h], dst: [-W / 2 + pic.x / q, -H / 2 + pic.y / q, dw, dh] };
  }
  return { src: res.canvas, r: [res.x, res.y, res.w, res.h], dst: [-W / 2, -H / 2, W, H] };
}

/**
 * Draw one video layer: crop → letterbox-contain fit → look → mask → 2D
 * transform (scale, rotate, flip, translate about the canvas centre), blend
 * mode and alpha. The transform mirrors the FFmpeg geq bake so preview and
 * export agree. The look runs through the WebGL2 pipeline (lookThroughGL);
 * without it, through the CSS colour proxy and the canvas vignette pass (keys
 * and the GL-only effects then show only in the render). Returns true when the
 * look ran through WebGL2.
 */
function drawLayer(ctx: CanvasRenderingContext2D, el: HTMLVideoElement | HTMLImageElement, d: NonNullable<ActiveClip["draw"]>, W: number, H: number, g: GLDraw): boolean {
  // Intrinsic source dimensions: <video> exposes videoWidth, <img> naturalWidth.
  const iw = (el as HTMLVideoElement).videoWidth || (el as HTMLImageElement).naturalWidth;
  const ih = (el as HTMLVideoElement).videoHeight || (el as HTMLImageElement).naturalHeight;
  const sx = d.crop?.x ?? 0;
  const sy = d.crop?.y ?? 0;
  const sw = d.crop?.width ?? iw;
  const sh = d.crop?.height ?? ih;
  if (sw <= 0 || sh <= 0) return false;
  const fit = Math.min(W / sw, H / sh);
  const dw = sw * fit;
  const dh = sh * fit;
  const t = d.transform;

  let src: CanvasImageSource = el;
  let [rx, ry, rw, rh] = [sx, sy, sw, sh];
  let [px, py, pw, ph] = [-dw / 2, -dh / 2, dw, dh];
  let filter = d.colorFilter;
  const gl = lookThroughGL(el, d, W, H, g, iw, ih, sx, sy, sw, sh);
  if (gl) {
    src = gl.src;
    [rx, ry, rw, rh] = gl.r;
    [px, py, pw, ph] = gl.dst;
    filter = "none";
  } else {
    // CSS fallback. FFmpeg vignettes the canvas-space frame (after fit +
    // padding), so the falloff is centred on the layer and reaches d = 1 at the
    // CANVAS corner: that corner's distance in the pass's pixels, for a pass
    // `w` pixels wide.
    const vigRadius = (w: number) => Math.hypot(W / 2, H / 2) * (w / dw);
    if (d.vignette?.length) {
      const s = Math.abs(t.scale) || 1;
      const vw = Math.max(1, Math.min(4096, Math.ceil(dw * s)));
      const vh = Math.max(1, Math.min(4096, Math.ceil(dh * s)));
      const v = vignetteLayer(src, rx, ry, rw, rh, filter, vw, vh, vigRadius(vw), d.vignette);
      if (v) {
        src = v;
        [rx, ry, rw, rh] = [0, 0, vw, vh];
        filter = "none";
      }
    }
    // Shape mask (maskdraw.ts): stage the finished layer at its picture size and
    // multiply its alpha by the mask, BEFORE the transform — so it follows the clip.
    if (d.mask) {
      const m = maskStageSize(dw, dh, t.scale, sw, sh);
      const staged = stageMasked(src, rx, ry, rw, rh, filter, m.w, m.h, d.mask);
      if (staged) {
        src = staged;
        [rx, ry, rw, rh] = [0, 0, m.w, m.h];
        filter = "none";
      }
    }
  }

  ctx.save();
  ctx.filter = filter && filter !== "none" ? filter : "none";
  ctx.globalAlpha = clamp01(d.opacity);
  // Blend mode (W3C source-over with blending; "lighter" for add) — restored by ctx.restore().
  if (d.blend) ctx.globalCompositeOperation = canvasBlendOp(d.blend) as GlobalCompositeOperation;
  ctx.translate(W / 2 + t.x * W, H / 2 + t.y * H);
  if (t.rotation) ctx.rotate((t.rotation * Math.PI) / 180);
  ctx.scale((t.flipH ? -1 : 1) * t.scale, (t.flipV ? -1 : 1) * t.scale);
  try {
    ctx.drawImage(src, rx, ry, rw, rh, px, py, pw, ph);
  } catch {
    /* element not yet decodable this frame — skip, next frame paints it */
  }
  ctx.restore();
  return !!gl;
}

/** DOM-facing snapshot of the current frame (only changes when overlays/badge change). */
interface FrameInfo {
  textClips: { clipId: string; overlays: ActiveClip["overlays"]; caption?: ActiveClip["caption"] }[];
  topName?: string;
  audioOnly: boolean;
  graded: boolean;
  drawCount: number;
  /** The draggable mask-centre handle (percent of the stage), when the Mask group targets a visible layer. */
  maskHandle?: { clipId: string; x: number; y: number };
}

const EMPTY_FRAME: FrameInfo = { textClips: [], audioOnly: false, graded: false, drawCount: 0 };

/** Stable signature so we only re-render the React overlay subtree when it changes. */
function frameSig(f: FrameInfo): string {
  return JSON.stringify(f);
}

interface Props {
  segments: Segment[];
  project: Project | null;
  assetById: Map<string, MediaAsset>;
  music?: MusicSettings;
  musicAsset?: MediaAsset;
  api: CoreApi;
  store: PlaybackStore;
  onSelectClip: (clipId: string) => void;
}

/** How far ahead (s) of a cut the next clip's decoder is bound and parked on its first frame. */
const PREROLL_SEC = 0.5;

export const PreviewPlayer = forwardRef<PlayerHandle, Props>(function PreviewPlayer(
  { segments, project, assetById, music, musicAsset, api, store, onSelectClip },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const musicRef = useRef<HTMLAudioElement>(null);
  const poolRef = useRef<MediaPool | null>(null);
  // Web Audio route for clips with live audio effects (audiograph.ts).
  const routerRef = useRef<AudioRouter | null>(null);

  const rafRef = useRef(0);
  const redrawRef = useRef(0);
  const lastNow = useRef(0);
  const playingRef = useRef(false);
  // On a software WebGL renderer: the looks' resolution while playing — half,
  // a quarter when frames still come too slowly (gl/governor.ts). A GPU stays at full.
  const governorRef = useRef(new PlaybackGovernor(() => (glSoftware() ? 2 : 1), () => (glSoftware() ? 4 : 1)));
  const glRanRef = useRef(false); // the last frame ran a WebGL look
  // A layer's decoder has no frame yet: since when the canvas holds the last frame instead (0 = not holding),
  // and the canvas size last painted (a resize clears the canvas, so there is nothing to hold).
  const holdRef = useRef(0);
  const paintedRef = useRef("");
  const phRef = useRef(0);
  const drawFnRef = useRef<() => void>(() => {});
  // Still images can't go through the <video> pool — cache one <img> per path and
  // repaint once it loads (so an image clip shows in the preview, not just export).
  const imgCacheRef = useRef(new Map<string, HTMLImageElement>());
  // Offscreen buffer for ADJUSTMENT layers: the composite below is drawn here,
  // then painted back through ctx.filter (mirrors the FFmpeg split→filter→overlay).
  const adjCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sigRef = useRef("");
  // The mask-handle target's on-canvas geometry this frame (for pointer → mask mapping).
  const maskXformRef = useRef<{ clipId: string; xf: LayerXform } | null>(null);
  const [maskDragging, setMaskDragging] = useState(false);

  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState<FrameInfo>(EMPTY_FRAME);

  const fps = project?.fps ?? 30;
  const aspect = project ? `${project.width} / ${project.height}` : "16 / 9";
  const canvasH = project?.height ?? 1080;
  const buf = useMemo(() => bufferSize(project), [project]);

  const projectRef = useRef(project);
  projectRef.current = project;
  const assetsRef = useRef(assetById);
  assetsRef.current = assetById;
  const musicRefData = useRef<{ music?: MusicSettings; asset?: MediaAsset }>({ music, asset: musicAsset });
  musicRefData.current = { music, asset: musicAsset };

  // Master end stop: the furthest extent across ALL tracks (not just the base).
  const total = useMemo(() => Math.max(timelineDurationSec(project), totalDuration(segments)), [project, segments]);
  const totalRef = useRef(total);
  totalRef.current = total;

  const hasClips = segments.length > 0;

  const writePh = useCallback(
    (v: number) => {
      phRef.current = v;
      store.set({ playhead: v });
    },
    [store],
  );

  useEffect(() => {
    store.set({ duration: total });
  }, [total, store]);

  // ----- the per-frame compositor ------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const pool = poolRef.current;
    if (!canvas || !pool) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;

    const project = projectRef.current;
    const plan = activeLayersAt(project, assetsRef.current, phRef.current, { exactFrames: !playingRef.current });
    const router = routerRef.current;
    const cw = project?.width ?? W;
    const ch = project?.height ?? H;
    const frameNo = Math.round(phRef.current * (project?.fps ?? 30));
    // The GL path's per-layer context; keys are left out while the inspector's eyedropper picks from the clip.
    const div = playingRef.current ? governorRef.current.div : 1;
    const glFor = (c: ActiveClip): GLDraw => ({ cw, ch, frame: frameNo, layerId: c.clipId, skipKeys: isKeyBypassed(c.clipId), div });
    glRanRef.current = false;
    pool.beginFrame();
    // Draw a clip's active motion graphics full-frame over it (alpha .webm proxy,
    // drawImage preserves transparency) so graphics preview live, in clip z-order.
    const paintGraphics = (gs: ActiveClip["graphics"]) => {
      for (const g of gs) {
        const gel = pool.acquire(`gfx:${g.key}`, g.path);
        const groute = !!router?.route(gel, undefined); // a reused decoder may be routed: keep it silent
        pool.sync(gel, { srcTime: g.srcTime, playing: playingRef.current, rate: 1, volume: 0, muted: true, routed: groute });
        if (groute) router!.setGain(gel, 0);
        if (gel.readyState >= 2 && gel.videoWidth > 0) {
          ctx.save();
          ctx.globalAlpha = clamp01(g.opacity);
          try { ctx.drawImage(gel, 0, 0, W, H); } catch { /* not decodable this frame */ }
          ctx.restore();
        }
      }
    };
    // ADJUSTMENT layer: repaint the composite drawn SO FAR through its color
    // filter (lower layers only — higher tracks draw after, unaffected).
    const applyAdjust = (filter: string, vignette?: number[], mask?: ClipMask, look?: LayerLook, layerId = "") => {
      // WebGL2: the adjustment's look runs on the composite so far (the
      // export's split → filter → [mask] → overlay); its result is drawn over
      // the composite, so anything it makes transparent shows the original.
      if (look && glReady()) {
        // A reduced resolution while playing, if the governor chose one (see GLDraw.div).
        const PW = Math.max(1, Math.round(W / div));
        const PH = Math.max(1, Math.round(H / div));
        const k = PW / cw;
        const steps = cachedPlan(look, { k, w: PW, h: PH, cw, ch });
        if (!steps.length) return;
        const res = runLayer({
          source: canvas, srcW: W, srcH: H, dynamic: true, crop: { x: 0, y: 0, w: W, h: H }, w: PW, h: PH,
          pic: { x: 0, y: 0, w: PW, h: PH }, steps, k, cw, ch, frame: frameNo, layerId,
        });
        if (res) {
          const out = mask ? stageMasked(res.canvas, res.x, res.y, res.w, res.h, "none", W, H, mask) : res.canvas;
          if (out) {
            ctx.save();
            ctx.globalAlpha = 1;
            ctx.filter = "none";
            if (mask) ctx.drawImage(out, 0, 0, W, H, 0, 0, W, H);
            else ctx.drawImage(out, res.x, res.y, res.w, res.h, 0, 0, W, H);
            ctx.restore();
            glRanRef.current = true;
            return;
          }
        }
      }
      if (mask) {
        // A masked adjustment: grade a copy of the composite so far, keep it
        // only inside the mask, and lay it back over the untouched composite
        // (the export's split → filter → mask → overlay).
        let off = adjCanvasRef.current;
        if (!off) adjCanvasRef.current = off = document.createElement("canvas");
        if (off.width !== W) off.width = W;
        if (off.height !== H) off.height = H;
        const octx = off.getContext("2d");
        if (!octx) return;
        octx.clearRect(0, 0, W, H);
        octx.drawImage(canvas, 0, 0);
        const staged = stageMasked(off, 0, 0, W, H, filter, W, H, mask, vignette?.length
          ? (g) => {
              g.globalCompositeOperation = "source-atop";
              g.fillStyle = vignetteGradient(g, W / 2, H / 2, Math.hypot(W / 2, H / 2), vignette);
              g.fillRect(0, 0, W, H);
              g.globalCompositeOperation = "source-over";
            }
          : undefined);
        if (staged) {
          ctx.save();
          ctx.globalAlpha = 1;
          ctx.filter = "none";
          ctx.drawImage(staged, 0, 0, W, H, 0, 0, W, H);
          ctx.restore();
        }
        return;
      }
      if (filter && filter !== "none") {
        let off = adjCanvasRef.current;
        if (!off) adjCanvasRef.current = off = document.createElement("canvas");
        if (off.width !== W) off.width = W;
        if (off.height !== H) off.height = H;
        const octx = off.getContext("2d");
        if (octx) {
          octx.clearRect(0, 0, W, H);
          octx.drawImage(canvas, 0, 0);
          ctx.save();
          ctx.globalAlpha = 1;
          ctx.filter = filter;
          ctx.clearRect(0, 0, W, H);
          ctx.drawImage(off, 0, 0);
          ctx.restore();
        }
      }
      if (vignette?.length) {
        // The composite is opaque, so a plain black gradient darkens it like
        // FFmpeg's vignette over the whole canvas (after the colour proxy, as
        // the export runs colour → effects).
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.filter = "none";
        ctx.fillStyle = vignetteGradient(ctx, W / 2, H / 2, Math.hypot(W / 2, H / 2), vignette);
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
    };

    // A mask being dragged on the preview draws at the pointer (one RPC on release).
    for (const c of plan.clips) {
      const drag = maskDragFor(c.clipId);
      if (!drag) continue;
      if (c.draw?.mask) c.draw = { ...c.draw, mask: { ...c.draw.mask, ...drag } };
      if (c.adjust?.mask) c.adjust = { ...c.adjust, mask: { ...c.adjust.mask, ...drag } };
    }

    // Drive every clip's decoder before painting, so a layer with no frame yet (a seek in flight, a clip just
    // reached) is known before the canvas is cleared.
    const els = new Map<ActiveClip, HTMLVideoElement>();
    for (const c of plan.clips) {
      if (c.adjust || !c.path || c.isImage) continue;
      const el = pool.acquire(c.clipId, c.path);
      // Live audio effects play through Web Audio; the route's gain then
      // carries the volume (fades, keyframes, bleep mutes, inaudible = 0).
      const routed = !!router?.route(el, c.audio?.fx);
      // A bleep about to sound is bound + parked at 0 but kept paused.
      const playing = playingRef.current && !c.bleep?.preroll;
      if (playing) pool.resumeNear(el, c.srcTime, c.rate);
      pool.sync(el, {
        srcTime: c.srcTime,
        playing,
        rate: c.rate,
        follow: c.ramped,
        volume: c.audio?.volume ?? 0,
        muted: !c.audio,
        routed,
      });
      if (routed) router!.setGain(el, c.audio?.volume ?? 0);
      els.set(c, el);
    }
    // Playing toward a cut: bind the clips that start within PREROLL_SEC and park them, paused, on their first
    // frame, so the cut shows that frame on time instead of waiting for a decoder to load and seek there.
    if (playingRef.current && project) {
      let next = Infinity;
      for (const tr of project.tracks) {
        for (const cl of tr.clips) {
          const s = cl.startFrame / project.fps;
          if (s > phRef.current && s < next) next = s;
        }
      }
      if (next - phRef.current <= PREROLL_SEC) {
        for (const c of activeLayersAt(project, assetsRef.current, next).clips) {
          if (c.adjust || !c.path || c.isImage || plan.clips.some((p) => p.clipId === c.clipId)) continue;
          const el = pool.acquire(c.clipId, c.path);
          const routed = !!router?.route(el, c.audio?.fx);
          pool.sync(el, { srcTime: c.srcTime, playing: false, rate: c.rate, follow: c.ramped, volume: 0, muted: true, routed });
          if (routed) router!.setGain(el, 0);
        }
      }
    }
    // A layer with no decoded frame would paint black: hold the last frame instead, for up to HOLD_MS.
    const late = [...els].some(([c, el]) => !!c.draw && !(el.readyState >= 2 && el.videoWidth > 0));
    const now = performance.now();
    if (!late) holdRef.current = 0;
    else if (holdLastFrame(late, paintedRef.current === `${W}x${H}`, holdRef.current, now)) {
      if (!holdRef.current) {
        holdRef.current = now;
        // Paused, a seek that never lands sends no event: paint what there is when the hold runs out.
        if (!playingRef.current) window.setTimeout(() => drawFnRef.current(), HOLD_MS + 20);
      }
      for (const c of plan.clips) for (const g of c.graphics) pool.acquire(`gfx:${g.key}`, g.path); // keep them playing
      pool.endFrame();
      return;
    }
    paintedRef.current = `${W}x${H}`;
    ctx.globalAlpha = 1;
    ctx.filter = "none";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);

    for (const c of plan.clips) {
      if (c.adjust) {
        applyAdjust(c.adjust.colorFilter, c.adjust.vignette, c.adjust.mask, c.adjust.look, c.clipId);
        continue;
      }
      if (!c.path) continue;
      if (c.isImage) {
        // Still image: draw from the <img> cache (no audio, no decoder pool).
        if (!c.draw) continue;
        const cache = imgCacheRef.current;
        let img = cache.get(c.path);
        if (!img) {
          img = new Image();
          img.crossOrigin = "anonymous"; // CORS-clean, so the key pass can upload it
          img.onload = () => { if (!playingRef.current) requestAnimationFrame(() => drawFnRef.current()); };
          img.src = api.fileUrl(c.path);
          cache.set(c.path, img);
        }
        if (img.complete && img.naturalWidth > 0 && drawLayer(ctx, img, c.draw, W, H, glFor(c))) glRanRef.current = true;
        paintGraphics(c.graphics);
        continue;
      }
      const el = els.get(c)!;
      if (c.draw && el.readyState >= 2 && el.videoWidth > 0 && drawLayer(ctx, el, c.draw, W, H, glFor(c))) glRanRef.current = true;
      paintGraphics(c.graphics);
    }
    pool.endFrame();

    // ----- DOM overlay / badge snapshot (only setState when it changes) ------
    const drawClips = plan.clips.filter((c) => c.draw);
    // Mask handle for the inspector's target clip, if it is on screen now.
    let maskHandle: FrameInfo["maskHandle"];
    const target = maskEditTarget();
    const tc = target ? plan.clips.find((c) => c.clipId === target.clipId && (c.draw?.mask || c.adjust?.mask)) : undefined;
    const tx = tc ? layerXform(tc, W, H) : null;
    maskXformRef.current = tc && tx ? { clipId: tc.clipId, xf: tx } : null;
    if (tc && tx) {
      const m = (tc.draw?.mask ?? tc.adjust?.mask)!;
      const [hx, hy] = maskToCanvas(tx, m.x, m.y);
      const r2 = (n: number) => Math.round(n * 100) / 100;
      maskHandle = { clipId: tc.clipId, x: r2((hx / W) * 100), y: r2((hy / H) * 100) };
    }
    const top = drawClips[drawClips.length - 1];
    const audible = plan.clips.find((c) => c.audio);
    const info: FrameInfo = {
      textClips: drawClips
        .filter((c) => c.overlays.length > 0 || c.caption)
        .map((c) => ({ clipId: c.clipId, overlays: c.overlays, caption: c.caption })),
      topName: top?.assetName ?? audible?.assetName,
      audioOnly: drawClips.length === 0 && !!audible,
      graded: !!top && (top.draw!.colorFilter !== "none" || !!top.draw!.vignette),
      drawCount: drawClips.length,
      ...(maskHandle ? { maskHandle } : {}),
    };
    const sig = frameSig(info);
    if (sig !== sigRef.current) {
      sigRef.current = sig;
      setFrame(info);
    }
  }, []);
  drawFnRef.current = draw;

  // A one-shot redraw used while paused (scrubbing / a decoder finishing a seek).
  const scheduleRedraw = useCallback(() => {
    if (playingRef.current) return; // the RAF loop already redraws continuously
    if (redrawRef.current) return;
    redrawRef.current = requestAnimationFrame(() => {
      redrawRef.current = 0;
      drawFnRef.current();
    });
  }, []);

  // Build the decoder pool once (after the host div mounts).
  useEffect(() => {
    if (!hostRef.current) return;
    const pool = new MediaPool(hostRef.current, (p) => api.fileUrl(p), () => scheduleRedraw());
    poolRef.current = pool;
    // Same lifetime as the pool: a routed element only ever sounds through its router.
    const router = new AudioRouter();
    routerRef.current = router;
    return () => {
      pool.destroy();
      poolRef.current = null;
      router.dispose();
      routerRef.current = null;
    };
  }, [api, scheduleRedraw]);

  // ----- music bed ----------------------------------------------------------
  const syncMusic = useCallback((play: boolean) => {
    const a = musicRef.current;
    const { music: m, asset } = musicRefData.current;
    if (!a) return;
    if (!m || !asset) {
      a.pause();
      return;
    }
    a.loop = true;
    a.volume = clamp01(m.volume);
    const dur = asset.duration > 0 ? asset.duration : 0;
    const want = dur > 0 ? phRef.current % dur : phRef.current;
    if (Math.abs(a.currentTime - want) > 0.25) {
      try { a.currentTime = want; } catch { /* not ready yet */ }
    }
    if (play) void a.play().catch(() => {});
    else a.pause();
  }, []);

  // ----- transport ----------------------------------------------------------
  const stopRaf = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  };

  const tick = useCallback(
    (now: number) => {
      const dt = lastNow.current ? (now - lastNow.current) / 1000 : 0;
      lastNow.current = now;
      let ph = phRef.current + dt; // timeline runs at 1× wall-time; clip speed only samples the source
      const tot = totalRef.current;
      if (ph >= tot) {
        ph = tot;
        phRef.current = ph;
        store.set({ playhead: ph });
        drawFnRef.current();
        // Reached the end — stop.
        playingRef.current = false;
        setPlaying(false);
        store.set({ playing: false });
        poolRef.current?.pauseAll();
        syncMusic(false);
        stopRaf();
        if (glRanRef.current && governorRef.current.div > 1) scheduleRedraw(); // the end frame in full resolution
        return;
      }
      phRef.current = ph;
      store.set({ playhead: ph });
      drawFnRef.current();
      governorRef.current.frame(dt * 1000, glRanRef.current);
      rafRef.current = requestAnimationFrame(tick);
    },
    [store, syncMusic, scheduleRedraw],
  );

  const doPlay = useCallback(() => {
    if (!hasClips) return;
    routerRef.current?.unlock(); // a user gesture: let live audio effects start
    if (phRef.current >= totalRef.current - 0.02) writePh(0); // restart if parked at the end
    playingRef.current = true;
    governorRef.current.start(projectRef.current);
    setPlaying(true);
    store.set({ playing: true });
    lastNow.current = 0;
    syncMusic(true);
    stopRaf();
    rafRef.current = requestAnimationFrame(tick);
  }, [hasClips, writePh, store, tick, syncMusic]);

  const doPause = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    store.set({ playing: false });
    poolRef.current?.pauseAll();
    syncMusic(false);
    stopRaf();
    // The last frame may have run its looks at a playback resolution: redraw it in full.
    if (glRanRef.current && governorRef.current.div > 1) scheduleRedraw();
  }, [store, syncMusic, scheduleRedraw]);

  const doSeek = useCallback(
    (time: number) => {
      const clamped = Math.min(totalRef.current, Math.max(0, time));
      writePh(clamped);
      if (playingRef.current) syncMusic(true);
      else syncMusic(false);
      drawFnRef.current();
      scheduleRedraw();
    },
    [writePh, syncMusic, scheduleRedraw],
  );

  useImperativeHandle(
    ref,
    (): PlayerHandle => ({
      play: doPlay,
      pause: doPause,
      toggle: () => (playingRef.current ? doPause() : doPlay()),
      seek: doSeek,
      step: (frames) => doSeek(stepFrames(phRef.current, frames, fps)),
      jumpClip: (dir) => {
        const segs = segments;
        if (!segs.length) return;
        const cur = segmentAt(segs, phRef.current);
        if (!cur) return;
        if (dir < 0) {
          const target = phRef.current - cur.start > 0.4 ? cur : segs[Math.max(0, cur.index - 1)];
          doSeek(target.start);
        } else {
          const next = segs[Math.min(segs.length - 1, cur.index + 1)];
          doSeek(cur.index === segs.length - 1 ? totalRef.current : next.start);
        }
      },
    }),
    [doPlay, doPause, doSeek, fps, segments],
  );

  // The edit changed under us (AI edit, trim, reorder…). Clamp the playhead to
  // the new duration and repaint, preserving play state.
  useEffect(() => {
    const clamped = Math.min(total, Math.max(0, phRef.current));
    writePh(clamped);
    if (playingRef.current) syncMusic(true);
    drawFnRef.current();
    scheduleRedraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, total]);

  // The inspector's Mask group opened/closed (mask handle) — repaint.
  useEffect(() => onMaskEditChange(() => {
    drawFnRef.current();
    scheduleRedraw();
  }), [scheduleRedraw]);

  // A committed mask drag arrives as a project change: drop the live override.
  useEffect(() => {
    setMaskDrag(null);
  }, [project]);

  // The GL pipeline fetches LUTs through the core's /file route; repaint when
  // one arrives or the context is lost / restored.
  useEffect(() => {
    const off = onGLChange(() => {
      drawFnRef.current();
      scheduleRedraw();
    });
    setFileUrl((p) => api.fileUrl(p)); // repaints through the listener above
    return off;
  }, [api, scheduleRedraw]);

  // The eyedropper toggled a clip's key preview off/on — repaint.
  useEffect(() => onKeyBypassChange(() => {
    drawFnRef.current();
    scheduleRedraw();
  }), [scheduleRedraw]);

  // Repaint once when the drawing buffer (project resolution) changes.
  useEffect(() => {
    drawFnRef.current();
    scheduleRedraw();
  }, [buf.w, buf.h, scheduleRedraw]);

  useEffect(
    () => () => {
      stopRaf();
      if (redrawRef.current) cancelAnimationFrame(redrawRef.current);
    },
    [],
  );

  return (
    <div className="pv">
      <div className="pv-stage" style={{ aspectRatio: aspect } as CSSProperties}>
        <canvas
          ref={canvasRef}
          className="pv-video"
          width={buf.w}
          height={buf.h}
          onClick={() => {
            if (hasClips) (playingRef.current ? doPause() : doPlay());
            const seg = segmentAt(segments, phRef.current);
            if (seg) onSelectClip(seg.clip.id);
          }}
        />

        {/* Mask centre handle (Mask group open + the layer on screen): drag to move. */}
        {frame.maskHandle && (
          <div
            className={`pv-mask-handle${maskDragging ? " dragging" : ""}`}
            style={{ left: `${frame.maskHandle.x}%`, top: `${frame.maskHandle.y}%` }}
            role="slider"
            aria-label="Mask centre (drag to move)"
            aria-valuetext={`${frame.maskHandle.x.toFixed(0)}%, ${frame.maskHandle.y.toFixed(0)}%`}
            title="Drag to move the mask"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              setMaskDragging(true);
            }}
            onPointerMove={(e) => {
              if (!maskDragging) return;
              const stage = e.currentTarget.parentElement;
              const g = maskXformRef.current;
              const canvas = canvasRef.current;
              if (!stage || !g || !canvas) return;
              const r = stage.getBoundingClientRect();
              const X = ((e.clientX - r.left) / r.width) * canvas.width;
              const Y = ((e.clientY - r.top) / r.height) * canvas.height;
              const [mx, my] = canvasToMask(g.xf, X, Y);
              setMaskDrag({ clipId: g.clipId, x: Math.min(1.5, Math.max(-0.5, mx)), y: Math.min(1.5, Math.max(-0.5, my)) });
              drawFnRef.current();
            }}
            onPointerUp={(e) => {
              if (!maskDragging) return;
              setMaskDragging(false);
              e.currentTarget.releasePointerCapture(e.pointerId);
              const t = maskEditTarget();
              const d = t ? maskDragFor(t.clipId) : null;
              if (t && d) t.commit(d.x, d.y);
            }}
            onPointerCancel={() => {
              setMaskDragging(false);
              setMaskDrag(null);
              drawFnRef.current();
            }}
          />
        )}

        {/* Hidden decoder pool host (off-screen, kept in the DOM so it decodes). */}
        <div ref={hostRef} className="pv-pool" aria-hidden="true" />

        {/* Looping background-music bed. */}
        <audio
          ref={musicRef}
          src={musicAsset ? api.fileUrl(musicAsset.path) : undefined}
          preload="auto"
        />

        {!hasClips && (
          <div className="pv-empty">
            <span className="pv-empty-icon"><Play size={26} /></span>
            <span className="pv-empty-title">Nothing on the timeline yet</span>
            <span className="pv-empty-sub">
              Add a clip from the library, or ask your AI client to build the edit —
              it plays here instantly, no render needed.
            </span>
          </div>
        )}

        {hasClips && frame.audioOnly && (
          <div className="pv-audioonly">
            <Waveform size={26} />
            <span>{frame.topName ?? "Audio"}</span>
          </div>
        )}

        {/* Live burned-in proxies (text + captions) for every visible layer. */}
        {hasClips && frame.textClips.length > 0 && (
          <div className="pv-overlays" aria-hidden="true">
            {frame.textClips.map((c) => (
              <div key={c.clipId} style={{ position: "absolute", inset: 0 }}>
                {c.overlays.map((o) => textBlock(`${c.clipId}-${o.id}`, o.text, o, o.box ?? false, canvasH, o.anim))}
                {c.caption && textBlock(`${c.clipId}-cue`, c.caption.text, { color: "#ffe14d", ...c.caption.style }, true, canvasH)}
              </div>
            ))}
          </div>
        )}
      </div>

      {hasClips && frame.drawCount > 0 && (
        <div className="pv-badge">
          <Film size={12} />
          <span className="pv-badge-name">{frame.topName ?? "Clip"}</span>
          <span className="pv-badge-idx">
            {frame.drawCount} layer{frame.drawCount === 1 ? "" : "s"}
          </span>
          {!playing && frame.graded && <span className="pv-badge-tag">graded</span>}
        </div>
      )}
    </div>
  );
});
