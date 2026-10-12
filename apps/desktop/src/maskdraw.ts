// Live preview of SHAPE MASKS (and the staging that lets a blend mode respect
// them). The geometry, feather σ and blur grid all come from the shared
// `@aive/core/compositing` module the export rasterizer (core ffmpeg/mask.ts)
// uses, so the preview draws the same mask:
//
//   1. the layer (after crop, colour filter, key, vignette) is drawn into a
//      staging canvas at its picture size;
//   2. a cached MASK canvas holds the shape — a Path2D filled white and, for a
//      feather, blurred with ctx.filter on the same margin + coarse grid as the
//      export (so the blur sees the shape beyond the picture's edge) — and is
//      composited onto the staging canvas with 'destination-in' ('destination-
//      out' to invert): the mask MULTIPLIES the layer's alpha;
//   3. preview.tsx draws the staging canvas through the clip's transform with
//      globalAlpha and the blend mode's globalCompositeOperation.
//
// Mask canvases are cached by (params, size) in a small LRU and the staging
// canvas is grow-only, so steady playback allocates nothing per frame.

import { maskBlurGrid, maskGeometry, type ClipMask, type MaskGeometry } from "@aive/core/compositing";
import type { ActiveClip } from "./composite";

interface MaskEntry {
  canvas: HTMLCanvasElement;
  /** Grid pixels per picture pixel, and the margin (picture px) around the picture. */
  scale: number;
  margin: number;
}

const MAX_CACHED = 8;
const maskCache = new Map<string, MaskEntry>();

/** Cache key: the shape's params (invert is applied at composite time) + size. */
function maskKey(m: ClipMask, w: number, h: number): string {
  return [m.shape, m.x, m.y, m.w, m.h, m.rotation, m.feather, m.roundness, w, h].join("|");
}

/** Trace the HARD shape (picture pixels, origin top-left) — same geometry as maskSignedDistance. */
function traceShape(g: CanvasRenderingContext2D, geo: MaskGeometry, w: number, h: number, margin: number): void {
  g.translate(geo.cx, geo.cy);
  g.rotate(geo.angle);
  g.beginPath();
  // Long enough to cover the picture plus the blur margin at any angle.
  const L = Math.hypot(w, h) + Math.hypot(geo.cx, geo.cy) + 2 * margin + 16;
  switch (geo.shape) {
    case "linear":
      g.rect(-L, -L, 2 * L, L); // keeps local v <= 0 (above the line at rotation 0)
      break;
    case "mirror":
      g.rect(-L, -geo.b, 2 * L, 2 * geo.b);
      break;
    case "rect": {
      const { a, b } = geo;
      const r = Math.min(geo.r, a, b);
      if (r <= 0.01) {
        g.rect(-a, -b, 2 * a, 2 * b);
      } else {
        g.moveTo(-a + r, -b);
        g.lineTo(a - r, -b);
        g.arc(a - r, -b + r, r, -Math.PI / 2, 0);
        g.lineTo(a, b - r);
        g.arc(a - r, b - r, r, 0, Math.PI / 2);
        g.lineTo(-a + r, b);
        g.arc(-a + r, b - r, r, Math.PI / 2, Math.PI);
        g.lineTo(-a, -b + r);
        g.arc(-a + r, -b + r, r, Math.PI, (3 * Math.PI) / 2);
        g.closePath();
      }
      break;
    }
    case "ellipse":
    default:
      if (geo.a > 0 && geo.b > 0) g.ellipse(0, 0, geo.a, geo.b, 0, 0, Math.PI * 2);
      break;
  }
  g.fill();
}

/** The mask (white = keep, before invert) for a w×h picture, cached. */
export function maskCanvasFor(m: ClipMask, w: number, h: number): MaskEntry | null {
  const key = maskKey(m, w, h);
  const hit = maskCache.get(key);
  if (hit) {
    // LRU: re-insert as the newest.
    maskCache.delete(key);
    maskCache.set(key, hit);
    return hit;
  }
  const geo = maskGeometry(m, w, h);
  const grid = maskBlurGrid(geo.sigma);
  const s = grid.scale;
  const M = grid.margin;
  const cw = Math.max(2, Math.ceil((w + 2 * M) * s));
  const ch = Math.max(2, Math.ceil((h + 2 * M) * s));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.fillStyle = "#fff";
  // Grid pixel i covers picture x ∈ [−M + i/s, −M + (i+1)/s): canvas = s·(x + M).
  g.setTransform(s, 0, 0, s, M * s, M * s);
  // ctx.filter lengths are in canvas (grid) pixels — the export blurs the
  // same hard shape with σ = gridSigma on the same grid.
  g.filter = grid.gridSigma > 0 ? `blur(${grid.gridSigma.toFixed(3)}px)` : "none";
  traceShape(g, geo, w, h, M);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.filter = "none";
  const entry: MaskEntry = { canvas, scale: s, margin: M };
  maskCache.set(key, entry);
  while (maskCache.size > MAX_CACHED) maskCache.delete(maskCache.keys().next().value as string);
  return entry;
}

/** Multiply a w×h layer already drawn at (0,0) of `g` by the mask (inverted with destination-out). */
export function applyMask(g: CanvasRenderingContext2D, m: ClipMask, w: number, h: number): boolean {
  const e = maskCanvasFor(m, w, h);
  if (!e) return false;
  g.save();
  g.globalAlpha = 1;
  g.filter = "none";
  g.globalCompositeOperation = m.invert ? "destination-out" : "destination-in";
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(e.canvas, 0, 0, e.canvas.width, e.canvas.height, -e.margin, -e.margin, e.canvas.width / e.scale, e.canvas.height / e.scale);
  g.restore();
  return true;
}

// Grow-only staging canvas (one masked layer at a time: staged, then drawn).
let stage: HTMLCanvasElement | null = null;

/**
 * Draw `src`'s (sx,sy,sw,sh) through `filter` into the staging canvas at w×h,
 * run `before` (e.g. an adjustment's vignette) and apply the mask. Returns the
 * staging canvas (valid until the next call; the layer is its top-left w×h)
 * or null when it can't run (a tainted / undecodable frame).
 */
export function stageMasked(
  src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number,
  filter: string, w: number, h: number, mask: ClipMask,
  before?: (g: CanvasRenderingContext2D) => void,
): HTMLCanvasElement | null {
  if (w < 1 || h < 1) return null;
  if (!stage) stage = document.createElement("canvas");
  const c = stage;
  if (c.width < w) c.width = w;
  if (c.height < h) c.height = h;
  const g = c.getContext("2d");
  if (!g) return null;
  g.save();
  try {
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    // Clear a little past the layer so a shrunk layer leaves no stale edge.
    g.clearRect(0, 0, Math.min(c.width, w + 2), Math.min(c.height, h + 2));
    g.filter = filter && filter !== "none" ? filter : "none";
    g.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    g.filter = "none";
    before?.(g);
    // Only the layer's own rect: the mask's margin must not reach stale pixels.
    g.beginPath();
    g.rect(0, 0, w, h);
    g.clip();
    applyMask(g, mask, w, h);
    return c;
  } catch {
    stage = null; // a tainted canvas stays tainted — start fresh next time
    return null;
  } finally {
    g.restore();
  }
}

/**
 * Staging size for a masked layer of picture size dw×dh drawn at `scale`:
 * the scale rounded UP to a power of two (so an animated zoom re-uses a couple
 * of cached masks instead of rebuilding one every frame), never past the
 * source's own resolution or 4096.
 */
export function maskStageSize(dw: number, dh: number, scale: number, srcW: number, srcH: number): { w: number; h: number } {
  const s = Math.abs(scale) || 1;
  const q = Math.min(8, Math.pow(2, Math.ceil(Math.log2(Math.max(1 / 8, s)))));
  const k = Math.min(q, srcW > 0 ? srcW / dw : q, srcH > 0 ? srcH / dh : q, 4096 / Math.max(dw, dh));
  return { w: Math.max(1, Math.round(dw * Math.max(k, 1 / 8))), h: Math.max(1, Math.round(dh * Math.max(k, 1 / 8))) };
}

/**
 * Where a layer's picture sits on the compositor canvas (drawLayer's
 * geometry), for the mask handle: picture size dw×dh, centre translate, and
 * the rotation/scale/flip. Adjustment layers are the whole canvas, untransformed.
 */
export interface LayerXform { dw: number; dh: number; tx: number; ty: number; rot: number; sx: number; sy: number }

export function layerXform(c: ActiveClip, W: number, H: number): LayerXform | null {
  if (c.adjust) return { dw: W, dh: H, tx: W / 2, ty: H / 2, rot: 0, sx: 1, sy: 1 };
  const d = c.draw;
  if (!d) return null;
  const sw = d.crop?.width ?? d.assetWidth;
  const sh = d.crop?.height ?? d.assetHeight;
  if (!(sw > 0) || !(sh > 0)) return null;
  const fit = Math.min(W / sw, H / sh);
  const t = d.transform;
  return {
    dw: sw * fit, dh: sh * fit, tx: W / 2 + t.x * W, ty: H / 2 + t.y * H,
    rot: ((t.rotation || 0) * Math.PI) / 180,
    sx: (t.flipH ? -1 : 1) * (t.scale || 1), sy: (t.flipV ? -1 : 1) * (t.scale || 1),
  };
}

/** Mask centre (picture fractions) → canvas pixels. */
export function maskToCanvas(f: LayerXform, mx: number, my: number): [number, number] {
  const lx = (mx - 0.5) * f.dw * f.sx;
  const ly = (my - 0.5) * f.dh * f.sy;
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  return [f.tx + lx * c - ly * s, f.ty + lx * s + ly * c];
}

/** Canvas pixels → mask centre (picture fractions): the inverse of maskToCanvas. */
export function canvasToMask(f: LayerXform, X: number, Y: number): [number, number] {
  const px = X - f.tx;
  const py = Y - f.ty;
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  const lx = px * c + py * s;
  const ly = -px * s + py * c;
  return [lx / (f.sx || 1) / f.dw + 0.5, ly / (f.sy || 1) / f.dh + 0.5];
}
