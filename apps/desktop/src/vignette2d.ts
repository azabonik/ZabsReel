// The no-WebGL2 fallback's VIGNETTE: a radial-gradient canvas pass with
// FFmpeg's own falloff (vignetteFactor), used by preview.tsx when the GL
// pipeline can't run (and by scripts/parity-page.ts to time that path).

import { vignetteFactor } from "@aive/core/effects";

/**
 * A radial gradient that darkens like FFmpeg's vignette: black at alpha
 * 1 − Π cos(angle·d)⁴ for the normalised distance d from (cx,cy), d = 1 at
 * `radius` (the canvas-space frame's corner). Stacked vignettes multiply.
 */
export function vignetteGradient(g: CanvasRenderingContext2D, cx: number, cy: number, radius: number, angles: number[]): CanvasGradient {
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, radius));
  const N = 16;
  for (let i = 0; i <= N; i++) {
    const d = i / N;
    let f = 1;
    for (const a of angles) f *= vignetteFactor(d, a);
    grad.addColorStop(d, `rgba(0,0,0,${(1 - f).toFixed(4)})`);
  }
  return grad;
}

// Scratch canvas for the vignette pass (grow-only, reused by every layer).
let vigCanvas: HTMLCanvasElement | null = null;

/**
 * Draw a layer's source rect at w×h through `filter`, then darken it with the
 * vignette gradient (`source-atop`, so transparent letterbox bars and keyed
 * areas stay transparent — as the export's alpha-preserving vignette). Returns
 * the scratch canvas (valid until the next call) or null if it can't run.
 */
export function vignetteLayer(
  src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number,
  filter: string, w: number, h: number, radius: number, angles: number[],
): HTMLCanvasElement | null {
  if (!vigCanvas) vigCanvas = document.createElement("canvas");
  const c = vigCanvas;
  if (c.width < w) c.width = w;
  if (c.height < h) c.height = h;
  const g = c.getContext("2d");
  if (!g) return null;
  g.save();
  try {
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    g.clearRect(0, 0, w, h);
    g.filter = filter && filter !== "none" ? filter : "none";
    g.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    g.filter = "none";
    g.globalCompositeOperation = "source-atop";
    g.fillStyle = vignetteGradient(g, w / 2, h / 2, radius, angles);
    g.fillRect(0, 0, w, h);
    return c;
  } catch {
    // A tainted / not-yet-decodable frame: a tainted canvas stays tainted, start fresh.
    vigCanvas = null;
    return null;
  } finally {
    g.restore();
  }
}
