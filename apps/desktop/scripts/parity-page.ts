// In-page entry for scripts/parity-gl.mts (bundled with esbuild, loaded in a
// headless Chromium): runs the live preview's real WebGL2 pipeline
// (src/gl/runtime.ts + plan.ts) on raw RGBA test frames and hands back the
// straight RGBA result, plus a timing loop for the performance numbers.

import { drawCount, glRenderer, loseContextForTest, provideLut, runLayer, type LayerJob } from "../src/gl/runtime";
import { cachedPlan, planLayer, passCount, type LayerLook } from "../src/gl/plan";
import { parseCube } from "../src/gl/color";
import { colorFilter, vignetteAngles } from "../src/playback";
import { vignetteLayer } from "../src/vignette2d";

interface RunArgs {
  /** Source frame, straight RGBA, base64. */
  rgba: string;
  srcW: number;
  srcH: number;
  /** Canvas (export) size; the frame is placed fit + padded like the export. */
  cw: number;
  ch: number;
  look: LayerLook;
  frame: number;
  layerId: string;
  /** .cube files the look references: path → text. */
  luts?: Record<string, string>;
}

const b64ToBytes = (b64: string): Uint8ClampedArray => {
  const bin = atob(b64);
  const out = new Uint8ClampedArray(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const bytesToB64 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

/** The export's fit: scale=W:H:force_original_aspect_ratio=decrease (av_rescale rounding), pad centred. */
function fit(srcW: number, srcH: number, cw: number, ch: number) {
  const w = Math.min(cw, Math.round((ch * srcW) / srcH));
  const h = Math.min(ch, Math.round((cw * srcH) / srcW));
  return { x: Math.trunc((cw - w) / 2), y: Math.trunc((ch - h) / 2), w, h };
}

function job(a: RunArgs, img: ImageData): LayerJob {
  const g = { k: 1, w: a.cw, h: a.ch, cw: a.cw, ch: a.ch };
  return {
    source: img, srcW: a.srcW, srcH: a.srcH, dynamic: true,
    crop: { x: 0, y: 0, w: a.srcW, h: a.srcH },
    w: a.cw, h: a.ch, pic: fit(a.srcW, a.srcH, a.cw, a.ch),
    steps: planLayer(a.look, g), k: 1, cw: a.cw, ch: a.ch, frame: a.frame, layerId: a.layerId,
  };
}

function loadLuts(luts?: Record<string, string>) {
  for (const [path, text] of Object.entries(luts ?? {})) {
    const cube = parseCube(text);
    if (cube) provideLut(path, cube);
  }
}

const api = {
  renderer: () => glRenderer(),
  run(a: RunArgs): string | null {
    loadLuts(a.luts);
    const img = new ImageData(b64ToBytes(a.rgba), a.srcW, a.srcH);
    const out = runLayer(job(a, img), true);
    return out ? bytesToB64(out) : null;
  },
  passes(a: RunArgs): { passes: number; draws: number } {
    const steps = planLayer(a.look, { k: 1, w: a.cw, h: a.ch, cw: a.cw, ch: a.ch });
    return { passes: passCount(steps), draws: drawCount(steps) };
  },
  /**
   * A still wider than the GPU's MAX_TEXTURE_SIZE (left part orange, a blue
   * strip at the right end) through a sepia look, cropped to each part in
   * turn, next to a small source of the same orange: the centre pixels (it
   * must not come out black, and a new crop of the same still must show).
   */
  oversize(): { maxTexture: number; small: number[]; bigLeft: number[]; bigRight: number[]; bigLeftAgain: number[] } | null {
    const probe = document.createElement("canvas").getContext("webgl2");
    if (!probe) return null;
    const maxTexture = probe.getParameter(probe.MAX_TEXTURE_SIZE) as number;
    const canvasOf = (w: number, h: number) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d")!;
      g.fillStyle = "rgb(200,100,50)";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "rgb(40,90,200)";
      g.fillRect(w - 1000, 0, 1000, h);
      return c;
    };
    const look: LayerLook = { filters: [{ id: "s", type: "sepia" } as never] };
    const centre = (src: HTMLCanvasElement, crop: { x: number; y: number; w: number; h: number }, layerId: string) => {
      const W = 320;
      const H = Math.round((W * crop.h) / crop.w);
      const g = { k: 1, w: W, h: H, cw: W, ch: H };
      const out = runLayer({
        source: src, srcW: src.width, srcH: src.height, dynamic: false, crop, w: W, h: H, pic: { x: 0, y: 0, w: W, h: H },
        steps: planLayer(look, g), k: 1, cw: W, ch: H, frame: 0, layerId,
      }, true);
      if (!out) return [-1, -1, -1, -1];
      const i = ((H >> 1) * W + (W >> 1)) * 4;
      return [...out.subarray(i, i + 4)];
    };
    const small = canvasOf(1600 + 1000, 400);
    const big = canvasOf(maxTexture + 1808, 400);
    const left = { x: 0, y: 0, w: 1600, h: 400 };
    const right = { x: big.width - 1000, y: 0, w: 1000, h: 400 };
    return {
      maxTexture,
      small: centre(small, left, "small"),
      bigLeft: centre(big, left, "big"),
      bigRight: centre(big, right, "big"),
      bigLeftAgain: centre(big, left, "big"),
    };
  },
  /** Lose the context, try a run (must fail → the preview's CSS fallback), restore, run again. */
  async contextLoss(a: RunArgs): Promise<{ whileLost: boolean; after: string | null }> {
    const h = loseContextForTest();
    if (!h) return { whileLost: false, after: null };
    h.lose();
    await new Promise((r) => setTimeout(r, 50));
    const whileLost = runLayer(job(a, new ImageData(b64ToBytes(a.rgba), a.srcW, a.srcH)), true) === null;
    h.restore();
    await new Promise((r) => setTimeout(r, 200));
    return { whileLost, after: api.run(a) };
  },
  /**
   * Time `frames` composites of `layers` layers (each a canvas source drawn
   * through the GL path and then onto a 2D canvas, like preview.tsx) against
   * the same layers drawn the way the preview did before the GL pipeline
   * (the CSS filter proxy + the canvas vignette pass; effects without a CSS
   * proxy simply didn't show). Returns ms per frame, best of three runs.
   */
  bench(a: { w: number; h: number; q?: number; layers: { look: LayerLook }[]; frames: number }): { gl: number; css: number; passes: number; draws: number } {
    const src = document.createElement("canvas");
    src.width = a.w;
    src.height = a.h;
    const sg = src.getContext("2d")!;
    const out = document.createElement("canvas");
    out.width = a.w;
    out.height = a.h;
    const og = out.getContext("2d")!;
    const paint = (f: number) => {
      // A moving gradient, so every frame is a fresh upload.
      const grad = sg.createLinearGradient(f % a.w, 0, a.w, a.h);
      grad.addColorStop(0, "#c33");
      grad.addColorStop(0.5, "#3c6");
      grad.addColorStop(1, "#36c");
      sg.fillStyle = grad;
      sg.fillRect(0, 0, a.w, a.h);
      sg.fillStyle = "#fff";
      sg.fillRect((f * 7) % a.w, 40, 60, 60);
    };
    // q < 1: the looks run at a reduced processing size (the preview's software-GL playback mode).
    const q = a.q ?? 1;
    const pw = Math.round(a.w * q);
    const ph = Math.round(a.h * q);
    const g = { k: q, w: pw, h: ph, cw: a.w, ch: a.h };
    const finish = () => og.getImageData(0, 0, 1, 1); // force the GPU/raster work to complete
    let passes = 0;
    let draws = 0;
    for (const l of a.layers) {
      passes += passCount(cachedPlan(l.look, g));
      draws += drawCount(cachedPlan(l.look, g)) + 0;
    }
    const time = (fn: (f: number) => void) => {
      for (let f = 0; f < 3; f++) fn(f); // warm up (shader compiles, pools)
      finish();
      let best = Infinity;
      for (let trial = 0; trial < 3; trial++) {
        const t0 = performance.now();
        for (let f = 0; f < a.frames; f++) fn(f);
        finish();
        best = Math.min(best, (performance.now() - t0) / a.frames);
      }
      return best;
    };
    const glMs = time((f) => {
      paint(f);
      og.fillStyle = "#000";
      og.fillRect(0, 0, a.w, a.h);
      for (const [i, l] of a.layers.entries()) {
        const r = runLayer({
          source: src, srcW: a.w, srcH: a.h, dynamic: true, crop: { x: 0, y: 0, w: a.w, h: a.h },
          w: pw, h: ph, pic: { x: 0, y: 0, w: pw, h: ph }, steps: cachedPlan(l.look, g), k: q, cw: a.w, ch: a.h,
          frame: f, layerId: `bench${i}`,
        });
        if (r) {
          og.globalAlpha = i === 0 ? 1 : 0.7;
          og.drawImage(r.canvas, r.x, r.y, r.w, r.h, 0, 0, a.w, a.h);
          og.globalAlpha = 1;
        }
      }
    });
    const old = a.layers.map((l) => ({ css: colorFilter(l.look.color, l.look.grade, l.look.filters, 1), vig: vignetteAngles(l.look.filters) }));
    const cssMs = time((f) => {
      paint(f);
      og.fillStyle = "#000";
      og.fillRect(0, 0, a.w, a.h);
      for (const [i, l] of old.entries()) {
        let from: CanvasImageSource = src;
        let filter = l.css;
        if (l.vig.length) {
          const v = vignetteLayer(src, 0, 0, a.w, a.h, filter, a.w, a.h, Math.hypot(a.w / 2, a.h / 2), l.vig);
          if (v) {
            from = v;
            filter = "none";
          }
        }
        og.filter = filter;
        og.globalAlpha = i === 0 ? 1 : 0.7;
        og.drawImage(from, 0, 0, a.w, a.h, 0, 0, a.w, a.h);
        og.filter = "none";
        og.globalAlpha = 1;
      }
    });
    return { gl: glMs, css: cssMs, passes, draws };
  },
};

(window as unknown as { parity: typeof api }).parity = api;
