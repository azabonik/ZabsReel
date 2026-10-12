/**
 * BLEND MODES and SHAPE MASKS: the single source of truth shared by the FFmpeg
 * export (ffmpeg/graph.ts + ffmpeg/mask.ts) and the live Canvas2D preview
 * (apps/desktop maskdraw.ts / preview.tsx), so both draw the same thing.
 *
 * PURE on purpose (like effects/registry.ts): no `node:` imports, no engine
 * imports, so the desktop renderer can import it as `@aive/core/compositing`.
 *
 * ## Blend modes
 * Only modes that BOTH FFmpeg 4.4 and Canvas2D `globalCompositeOperation`
 * support. The preview draws a layer with the canvas operation; the export
 * composites it as  out = base + α·(B(base, layer) − base)  (W3C "source-over
 * with blending" onto an opaque backdrop, α = the layer's alpha × opacity ×
 * fades × mask), except `add`, whose canvas operation "lighter" is Porter-Duff
 * plus: out = min(1, base + α·layer). Only the clip's PICTURE blends: its own
 * text overlays, captions and motion graphics composite normally on top (the
 * preview draws them that way; graph.ts emitBlendDecorations).
 *
 * B(base, layer) in FFmpeg: the native `blend` filter where its 8-bit formula
 * is within 2 levels of the W3C formula for every one of the 65,536 input
 * pairs (base is always the FIRST input), and an exact `lut2` table where it
 * is not. Measured max |FFmpeg − W3C| over all pairs (FFmpeg 4.4.2):
 *   multiply 1, screen 1, overlay 2, darken 0, lighten 0, hard-light 2,
 *   difference 0, exclusion 1, add 0 (all native blend);
 *   soft-light 32 (FFmpeg's softlight is a different curve), color-dodge 255
 *   and color-burn 255 (FFmpeg ignores the base=0 / base=255 special cases)
 *   — those three use lut2 with the W3C formula instead: max 0.
 * Chrome's canvas (headless, 8-bit) is within 2 levels of the W3C formulas for
 * every mode at α = 1 and α = 0.5 (`lighter` = min(1, base + α·layer), exactly).
 *
 * ## Masks
 * A mask is defined in the CLIP's own picture space — the source after crop,
 * fitted to the canvas — so it moves, scales, rotates and flips with the
 * clip's transform. x/y = the shape's centre as a fraction of the picture's
 * width/height, w/h = its size as a fraction of the picture's width/height,
 * rotation = degrees clockwise (in picture pixels, so a rotated rectangle stays
 * a rectangle), feather = the width of the soft edge (10%→90%) as a fraction of
 * the picture's SHORT side (a Gaussian blur of the hard shape), roundness = the
 * rectangle's corner radius as a fraction of its half short side, invert =
 * keep the outside instead. Shapes:
 *   rect    — a (rounded) rectangle w × h
 *   ellipse — an ellipse w × h (w = h·picH/picW draws a circle)
 *   linear  — a half-plane: the line through (x, y) at `rotation`; keeps the
 *             side ABOVE the line at rotation 0 (rotate 180° or invert for the other side)
 *   mirror  — a band of thickness h (fraction of the picture height) through
 *             (x, y) at `rotation`
 * The mask MULTIPLIES the clip's alpha (keys, cutouts and transparent padding
 * stay transparent) and nothing outside the picture rectangle ever shows.
 */

// ---- blend modes ---------------------------------------------------------------

/** Every blend mode, in menu order (the rpc enum and the AI description follow it). */
export const BLEND_MODES = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge",
  "color-burn", "hard-light", "soft-light", "difference", "exclusion", "add",
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

/** How the export computes B(base, layer) for one mode. */
export type BlendFfmpeg =
  | { kind: "normal" }
  /** Native `blend=all_mode=<mode>` with the base as the FIRST input. */
  | { kind: "blend"; mode: string }
  /** `lut2` with this expression for c0..c2 (x = base, y = layer, 0..255). */
  | { kind: "lut2"; expr: string }
  /** Porter-Duff plus: premultiply the layer, add, and keep the sum wherever the layer has any alpha (canvas "lighter"). */
  | { kind: "add" };

export interface BlendModeDef {
  mode: BlendMode;
  label: string;
  /** The Canvas2D globalCompositeOperation the preview draws the layer with. */
  canvas: string;
  /** One line for the AI / tooltip. */
  description: string;
  ffmpeg: BlendFfmpeg;
}

// W3C formulas in lut2's 0..255 domain (x = base, y = layer), rounded and clamped.
const LUT2_SOFT_LIGHT =
  "clip(floor(255*if(lte(y,127.5),(x/255)-(1-2*y/255)*(x/255)*(1-x/255),(x/255)+(2*y/255-1)*(if(lte(x,63.75),((16*x/255-12)*x/255+4)*x/255,sqrt(x/255))-x/255))+0.5),0,255)";
const LUT2_COLOR_DODGE = "if(eq(x,0),0,if(eq(y,255),255,clip(floor(255*min(1,(x/255)/(1-y/255))+0.5),0,255)))";
const LUT2_COLOR_BURN = "if(eq(x,255),255,if(eq(y,0),0,clip(floor(255*(1-min(1,(1-x/255)/(y/255)))+0.5),0,255)))";

const BLEND_DEFS: { [K in BlendMode]: Omit<BlendModeDef, "mode"> } = {
  normal: { label: "Normal", canvas: "source-over", description: "Plain layering (the default).", ffmpeg: { kind: "normal" } },
  multiply: { label: "Multiply", canvas: "multiply", description: "Darkens: white disappears, black stays — shadows, paper/grunge textures, ink.", ffmpeg: { kind: "blend", mode: "multiply" } },
  screen: { label: "Screen", canvas: "screen", description: "Lightens: black disappears — light leaks, flares, fire/sparks/smoke shot on black.", ffmpeg: { kind: "blend", mode: "screen" } },
  overlay: { label: "Overlay", canvas: "overlay", description: "Contrast blend keyed on the base — textures that keep the base's lights and darks.", ffmpeg: { kind: "blend", mode: "overlay" } },
  darken: { label: "Darken", canvas: "darken", description: "Keeps the darker of the two per channel.", ffmpeg: { kind: "blend", mode: "darken" } },
  lighten: { label: "Lighten", canvas: "lighten", description: "Keeps the lighter of the two per channel.", ffmpeg: { kind: "blend", mode: "lighten" } },
  "color-dodge": { label: "Color dodge", canvas: "color-dodge", description: "Strong brightening of the base by the layer — glows.", ffmpeg: { kind: "lut2", expr: LUT2_COLOR_DODGE } },
  "color-burn": { label: "Color burn", canvas: "color-burn", description: "Strong darkening / saturating of the base by the layer.", ffmpeg: { kind: "lut2", expr: LUT2_COLOR_BURN } },
  "hard-light": { label: "Hard light", canvas: "hard-light", description: "Overlay keyed on the layer — punchy texture/light.", ffmpeg: { kind: "blend", mode: "hardlight" } },
  "soft-light": { label: "Soft light", canvas: "soft-light", description: "Gentle overlay — subtle textures and tints.", ffmpeg: { kind: "lut2", expr: LUT2_SOFT_LIGHT } },
  difference: { label: "Difference", canvas: "difference", description: "Absolute difference — psychedelic/inverted looks, alignment checks.", ffmpeg: { kind: "blend", mode: "difference" } },
  exclusion: { label: "Exclusion", canvas: "exclusion", description: "A softer difference.", ffmpeg: { kind: "blend", mode: "exclusion" } },
  add: { label: "Add", canvas: "lighter", description: "Adds light (linear dodge) — bright light leaks, flares, glows on black.", ffmpeg: { kind: "add" } },
};

export const BLEND_MODE_DEFS: readonly BlendModeDef[] = BLEND_MODES.map((mode) => ({ mode, ...BLEND_DEFS[mode] }));

export function isBlendMode(v: unknown): v is BlendMode {
  return typeof v === "string" && (BLEND_MODES as readonly string[]).includes(v);
}

export function blendModeDef(mode: BlendMode | undefined): BlendModeDef {
  return { mode: mode ?? "normal", ...BLEND_DEFS[mode && isBlendMode(mode) ? mode : "normal"] };
}

/** The canvas operation for a mode ("source-over" for normal / absent / unknown). */
export function canvasBlendOp(mode: BlendMode | undefined): string {
  return blendModeDef(mode).canvas;
}

/** One line per mode for the AI tool description. */
export function describeBlendModesForAI(): string {
  return BLEND_MODE_DEFS.map((d) => `${d.mode} (${d.description})`).join("; ");
}

/**
 * The blend mode each clip of ONE track's transition run composites with.
 * The export renders a transition-joined run (clips joined by `transition`,
 * xfade) as one stream, so the whole run uses its FIRST clip's mode; the
 * preview mirrors that. `clips` must be the track's VIDEO-visible clips sorted
 * by start (a clip with a transition joins the run before it — graph.ts
 * groupRuns). Returns one entry per clip, in order.
 */
export function runBlendModes(
  clips: readonly { transition?: unknown; effects?: { blendMode?: BlendMode } }[],
): BlendMode[] {
  const out: BlendMode[] = [];
  let lead: BlendMode = "normal";
  clips.forEach((c, i) => {
    if (i === 0 || !c.transition) lead = c.effects?.blendMode ?? "normal";
    out.push(lead);
  });
  return out;
}

// ---- masks ---------------------------------------------------------------------

export const MASK_SHAPES = ["rect", "ellipse", "linear", "mirror"] as const;
export type MaskShape = (typeof MASK_SHAPES)[number];

export interface ClipMask {
  shape: MaskShape;
  /** Centre, fractions of the clip's picture width / height. */
  x: number;
  y: number;
  /** Size, fractions of the picture width / height (linear ignores both, mirror uses h). */
  w: number;
  h: number;
  /** Degrees clockwise. */
  rotation: number;
  /** Soft-edge width (10%→90%) as a fraction of the picture's short side. */
  feather: number;
  /** Rect corner radius as a fraction of its half short side. */
  roundness: number;
  invert: boolean;
}

export type MaskNumKey = "x" | "y" | "w" | "h" | "rotation" | "feather" | "roundness";

export interface MaskParamSpec {
  key: MaskNumKey;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
  /** Shapes this control applies to. */
  shapes: readonly MaskShape[];
}

const ALL: readonly MaskShape[] = MASK_SHAPES;
export const MASK_PARAMS: readonly MaskParamSpec[] = [
  { key: "x", label: "Center X", min: -0.5, max: 1.5, step: 0.01, default: 0.5, shapes: ALL },
  { key: "y", label: "Center Y", min: -0.5, max: 1.5, step: 0.01, default: 0.5, shapes: ALL },
  { key: "w", label: "Width", min: 0.01, max: 2, step: 0.01, default: 0.5, shapes: ["rect", "ellipse"] },
  { key: "h", label: "Height", min: 0.01, max: 2, step: 0.01, default: 0.5, shapes: ["rect", "ellipse", "mirror"] },
  { key: "rotation", label: "Rotation", min: -180, max: 180, step: 1, default: 0, unit: "°", shapes: ALL },
  { key: "feather", label: "Feather", min: 0, max: 1, step: 0.01, default: 0, shapes: ALL },
  { key: "roundness", label: "Roundness", min: 0, max: 1, step: 0.01, default: 0, shapes: ["rect"] },
];

export function isMaskShape(v: unknown): v is MaskShape {
  return typeof v === "string" && (MASK_SHAPES as readonly string[]).includes(v);
}

const clampN = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Wrap degrees into (-180, 180]. */
export function wrapDegrees(d: number): number {
  let r = ((d % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return r;
}

/**
 * A complete, clamped mask from a partial request: fields not given come from
 * `prev` (the clip's current mask), else the defaults. `w`/`h` default to a
 * centred square / circle half the picture's short side when the picture
 * aspect (`picAspect` = width / height) is known.
 */
export function normalizeMask(req: Partial<ClipMask> & { shape?: MaskShape }, prev?: ClipMask, picAspect?: number): ClipMask {
  const shape = isMaskShape(req.shape) ? req.shape : prev?.shape ?? "ellipse";
  const aspect = finite(picAspect) && picAspect > 0 ? picAspect : 1;
  const defaults: ClipMask = {
    shape,
    x: 0.5,
    y: 0.5,
    // Half the short side, square in pixels.
    w: aspect >= 1 ? 0.5 / aspect : 0.5,
    h: aspect >= 1 ? 0.5 : 0.5 * aspect,
    rotation: 0,
    feather: 0,
    roundness: 0,
    invert: false,
  };
  const out = { ...defaults, ...(prev ?? {}), shape } as ClipMask;
  for (const p of MASK_PARAMS) {
    const v = req[p.key];
    if (finite(v)) out[p.key] = v;
    out[p.key] = p.key === "rotation" ? wrapDegrees(finite(out[p.key]) ? out[p.key] : 0) : clampN(finite(out[p.key]) ? out[p.key] : p.default, p.min, p.max);
  }
  if (typeof req.invert === "boolean") out.invert = req.invert;
  out.invert = !!out.invert;
  // Stable 6-decimal values (cache keys, file names, JSON round trips).
  for (const p of MASK_PARAMS) out[p.key] = Number(out[p.key].toFixed(6));
  return out;
}

/** Validate a stored mask (old/hand-edited projects): a normalized copy, or undefined. */
export function sanitizeMask(m: unknown): ClipMask | undefined {
  if (!m || typeof m !== "object" || !isMaskShape((m as ClipMask).shape)) return undefined;
  return normalizeMask(m as ClipMask, m as ClipMask);
}

/** A clip picture's placement inside the W×H canvas, in canvas pixels. */
export interface PictureRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where FFmpeg puts a srcW×srcH picture in a W×H canvas: graph.ts's
 * `scale=W:H:force_original_aspect_ratio=decrease` (av_rescale rounds to
 * nearest) + `pad=W:H:(ow-iw)/2:(oh-ih)/2` (truncated). Verified against
 * FFmpeg 4.4 for odd aspects.
 */
export function fitPictureRect(srcW: number, srcH: number, W: number, H: number): PictureRect {
  const sw = Math.max(1, Math.round(srcW));
  const sh = Math.max(1, Math.round(srcH));
  const w = Math.min(W, Math.round((H * sw) / sh));
  const h = Math.min(H, Math.round((W * sh) / sw));
  return { x: Math.floor((W - w) / 2), y: Math.floor((H - h) / 2), w, h };
}

/** A Gaussian edge's 10%→90% width is 2.5631·σ. */
const EDGE_WIDTH_PER_SIGMA = 2.5631;

/** The feather's Gaussian σ in pixels for a pw×ph picture. */
export function maskSigmaPx(mask: ClipMask, pw: number, ph: number): number {
  return (clampN(mask.feather, 0, 1) * Math.min(pw, ph)) / EDGE_WIDTH_PER_SIGMA;
}

/** A mask resolved to pixel geometry for a pw×ph picture (origin = the picture's top-left). */
export interface MaskGeometry {
  shape: MaskShape;
  /** Centre, picture pixels. */
  cx: number;
  cy: number;
  /** Half width / half height (mirror: b = half the band thickness). */
  a: number;
  b: number;
  /** Rect corner radius, pixels. */
  r: number;
  /** Rotation, radians clockwise, and its cos/sin. */
  angle: number;
  cos: number;
  sin: number;
  /** Feather Gaussian σ, pixels. */
  sigma: number;
  invert: boolean;
}

export function maskGeometry(mask: ClipMask, pw: number, ph: number): MaskGeometry {
  const a = Math.max(0, (mask.w * pw) / 2);
  const b = Math.max(0, (mask.h * ph) / 2);
  const angle = (wrapDegrees(mask.rotation) * Math.PI) / 180;
  return {
    shape: mask.shape,
    cx: mask.x * pw,
    cy: mask.y * ph,
    a,
    b,
    r: clampN(mask.roundness, 0, 1) * Math.min(a, b),
    angle,
    cos: Math.cos(angle),
    sin: Math.sin(angle),
    sigma: maskSigmaPx(mask, pw, ph),
    invert: !!mask.invert,
  };
}

/**
 * Signed distance (pixels, negative inside) from picture point (px, py) to the
 * HARD shape's edge — exact for rect / linear / mirror, a close first-order
 * estimate for the ellipse (good near the edge, which is all anti-aliasing
 * needs). The canvas preview draws the same shape as a Path2D.
 */
export function maskSignedDistance(g: MaskGeometry, px: number, py: number): number {
  const dx = px - g.cx;
  const dy = py - g.cy;
  // Into the shape's local frame (inverse of a clockwise rotation in y-down space).
  const u = dx * g.cos + dy * g.sin;
  const v = -dx * g.sin + dy * g.cos;
  switch (g.shape) {
    case "linear":
      return v; // keeps v <= 0: the side above the line at rotation 0
    case "mirror":
      return Math.abs(v) - g.b;
    case "rect": {
      const qx = Math.abs(u) - (g.a - g.r);
      const qy = Math.abs(v) - (g.b - g.r);
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - g.r;
    }
    case "ellipse":
    default: {
      if (g.a <= 1e-9 || g.b <= 1e-9) return 1e9;
      const k0 = Math.hypot(u / g.a, v / g.b);
      const k1 = Math.hypot(u / (g.a * g.a), v / (g.b * g.b));
      if (k1 <= 1e-12) return -Math.min(g.a, g.b);
      return (k0 * (k0 - 1)) / k1;
    }
  }
}

/**
 * The grid the feathered mask is computed on, shared by the export rasterizer
 * and the preview so both blur the same hard shape the same way: a margin of
 * 3σ + 2 px around the picture (so the blur sees the shape beyond the picture's
 * edge), and — for a wide feather — a coarser grid (σ ≈ 4 grid pixels), then
 * bilinear-upsampled. `scale` = grid pixels per picture pixel.
 */
export function maskBlurGrid(sigma: number): { margin: number; scale: number; gridSigma: number } {
  if (sigma < 0.3) return { margin: 0, scale: 1, gridSigma: 0 };
  const scale = sigma > 4 ? 4 / sigma : 1;
  return { margin: Math.ceil(3 * sigma) + 2, scale, gridSigma: sigma * scale };
}
