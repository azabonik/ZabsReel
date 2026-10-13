// WebGL2 preview vs FFmpeg export PARITY (run manually; documented in
// docs/TESTING.md). For every registry effect at its default and one
// non-default setting, plus the colour grade (eq, colorbalance, hue, curves, a
// generated .cube LUT) and a few stacks (YUV chains, keys between effects, a
// pillarboxed alpha frame), it renders a synthetic test pattern
//   - through the live preview's real GL pipeline (src/gl/, bundled with
//     esbuild into a page in your own headless Chromium), and
//   - through the EXPORT's own per-clip filter chain: graph.ts
//     buildRenderCommand for the same clip, with only the final 4:2:0
//     composite swapped for a lossless RGBA tap (get_frame / Render exact go
//     through H.264 4:2:0, whose chroma subsampling alone would swamp the
//     few-level differences this measures),
// and reports max / mean / p99 of the per-channel difference (alpha, and
// colour premultiplied by alpha — what you see). Thresholds by the registry's
// fidelity class: exact = max ≤ 3 and mean ≤ 1; close = p99 ≤ 8; approx =
// reported only. Film grain is random, so it compares the noise statistics.
// A second table runs the REAL export (the whole graph, 4:2:0) on a yuv420p
// clip, which the tap can't show: which pixel format FFmpeg gives a filter
// depends on the filters after it.
//
//   npx tsx apps/desktop/scripts/parity-gl.mts            # parity table
//   npx tsx apps/desktop/scripts/parity-gl.mts --bench    # + fps of the GL path vs the CSS fallback
//   npx tsx apps/desktop/scripts/parity-gl.mts --only blur,glow --dump
//   npx tsx apps/desktop/scripts/parity-gl.mts --only 420     # the real-export table only
//   npx tsx apps/desktop/scripts/parity-gl.mts --only temporal,mediapool   # trails / warm-up / LUT cache; the <video> pool
//
// The shaders model FFmpeg 4.4; AIVE_FFMPEG runs the export side on another
// build (docs/TESTING.md lists the known per-version differences).
// Needs FFmpeg on PATH, core built (npm run build), and playwright-core +
// a Chromium: PLAYWRIGHT_CORE=<dir of playwright-core> and
// PLAYWRIGHT_CHROMIUM=<chrome binary> override the search (npx caches,
// ~/.cache/ms-playwright). Headless Chromium runs WebGL2 on SwiftShader.

import { build } from "esbuild";
import { execa } from "execa";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildRenderCommand, EXPORT_PROFILE } from "../../../packages/core/src/ffmpeg/graph.js";
import { FFMPEG_BIN, adaptFfmpegArgs } from "../../../packages/core/src/ffmpeg/executor.js";
import { EFFECTS, effectGL, type GLFidelity } from "@aive/core/effects";
import type { LayerLook } from "../src/gl/plan";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const BENCH = args.includes("--bench");
const DUMP = args.includes("--dump");
const ONLY = (() => {
  const i = args.indexOf("--only");
  return i >= 0 ? new Set(args[i + 1].split(",")) : null;
})();
const FPS = 30;
const W = 320;
const H = 180;
const dir = mkdtempSync(join(tmpdir(), "synthcut-parity-"));

// ---- locating playwright-core and Chromium ---------------------------------------

function candidates(): string[] {
  const out: string[] = [];
  if (process.env.PLAYWRIGHT_CORE) out.push(process.env.PLAYWRIGHT_CORE);
  out.push(resolve(HERE, "../../../node_modules/playwright-core"));
  const npx = join(homedir(), ".npm", "_npx");
  if (existsSync(npx)) for (const d of readdirSync(npx)) out.push(join(npx, d, "node_modules", "playwright-core"));
  return out.filter((c) => existsSync(join(c, "package.json")));
}

async function loadPlaywright(): Promise<typeof import("playwright-core")> {
  for (const c of candidates()) {
    try {
      return (await import(pathToFileURL(join(c, "index.mjs")).href)) as typeof import("playwright-core");
    } catch {
      /* try the next one */
    }
  }
  throw new Error("playwright-core not found — set PLAYWRIGHT_CORE to its directory");
}

function chromiumPath(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const cache = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? "", "ms-playwright")
    : process.platform === "darwin" ? join(homedir(), "Library", "Caches", "ms-playwright") : join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  const dirs = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const d of dirs) {
    for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-win/chrome.exe", "chrome-win64/chrome.exe",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
      const p = join(cache, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

// ---- test patterns ----------------------------------------------------------------

const hash = (x: number, y: number, s = 0) => {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** A frame with ramps, saturated bars, a green screen, black, texture and hard edges. */
function pattern(w: number, h: number, shift = 0): Buffer {
  const b = Buffer.alloc(w * h * 4);
  const bars: [number, number, number][] = [
    [255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 255, 255], [255, 0, 255], [255, 255, 0], [255, 255, 255], [0, 0, 0], [128, 128, 128], [200, 40, 30],
  ];
  for (let y = 0; y < h; y++) {
    for (let x0 = 0; x0 < w; x0++) {
      const x = (x0 + shift) % w;
      let c: [number, number, number];
      const u = x / (w - 1);
      if (y < h * 0.25) {
        // R, G, B and grey ramps
        const band = Math.floor((y / (h * 0.25)) * 4);
        const v = Math.round(u * 255);
        c = band === 0 ? [v, 30, 60] : band === 1 ? [40, v, 90] : band === 2 ? [70, 20, v] : [v, v, v];
      } else if (y < h * 0.45) {
        c = bars[Math.min(bars.length - 1, Math.floor(u * bars.length))];
      } else if (y < h * 0.7) {
        if (u < 0.3) {
          // green screen with a little noise and a red disc on it
          const n = Math.round((hash(x, y) - 0.5) * 16);
          const d = Math.hypot(x - w * 0.15, y - h * 0.57);
          c = d < h * 0.07 ? [220, 30 + n, 40] : [20 + n, 230 + n / 2, 30 - n];
        } else if (u < 0.5) {
          // black background with a white box (luma key)
          c = x % 40 > 10 && x % 40 < 30 && y > h * 0.5 && y < h * 0.65 ? [250, 250, 250] : [Math.round(hash(x, y, 1) * 12), 0, 0];
        } else {
          // smooth colour field with texture
          const t = hash(x, y, 2);
          c = [Math.round(128 + 100 * Math.sin(x / 9) * t), Math.round(120 + 90 * Math.cos(y / 7)), Math.round(255 * t)];
        }
      } else {
        // hard edges: a checkerboard of mid tones and diagonal stripes
        const check = ((Math.floor(x / 12) + Math.floor(y / 12)) & 1) === 1;
        const stripe = ((x + y) >> 3) & 1;
        c = check ? [200, 160, 90] : stripe ? [30, 60, 140] : [240, 230, 220];
      }
      const i = (y * w + x0) * 4;
      b[i] = Math.max(0, Math.min(255, c[0]));
      b[i + 1] = Math.max(0, Math.min(255, c[1]));
      b[i + 2] = Math.max(0, Math.min(255, c[2]));
      b[i + 3] = 255;
    }
  }
  return b;
}

async function writePng(path: string, rgba: Buffer, w: number, h: number): Promise<void> {
  await execa(FFMPEG_BIN, ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-i", "-", "-frames:v", "1", path], { input: rgba });
}

/**
 * A W×H RGBA frame through the export's last steps — overlaid onto the black
 * base (the overlay's yuv420p, with FFmpeg's default conversions), then
 * format=yuv420p — and back to RGBA: what the export shows of that frame.
 */
async function through420(rgba: Uint8Array): Promise<Uint8Array> {
  const graph = `color=c=black:s=${W}x${H}:r=${FPS}:d=1,format=rgba[b];[0:v]format=rgba,setpts=PTS-STARTPTS[c];` +
    "[b][c]overlay=0:0:eof_action=pass[o];[o]format=yuv420p[v]";
  const { stdout } = await execa(FFMPEG_BIN, ["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`,
    "-framerate", String(FPS), "-i", "-", "-filter_complex", graph, "-map", "[v]", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
  { input: Buffer.from(rgba), encoding: "buffer" });
  return new Uint8Array(Buffer.from(stdout as unknown as Uint8Array).subarray(0, W * H * 4));
}

/** A 17³ .cube with a non-trivial look (channel cross-talk + a toe), red fastest; `v` > 0 varies it. */
function makeCube(v = 0): string {
  const n = 17;
  const lines = ['TITLE "parity"', `LUT_3D_SIZE ${n}`, "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const [R, G, B] = [r / (n - 1), g / (n - 1), b / (n - 1)];
        const o = [0.85 * R + 0.15 * G, Math.pow(G, 1.25 + 0.05 * v), 0.1 + 0.8 * B * (0.6 + 0.4 * R) - 0.01 * v].map((x) => Math.min(1, Math.max(0, x)));
        lines.push(o.map((v) => v.toFixed(6)).join(" "));
      }
    }
  }
  return lines.join("\n") + "\n";
}

// ---- the export's own chain --------------------------------------------------------

async function ffmpegRef(look: LayerLook, input: { png: string; w: number; h: number } | { seq: string; frames: number }, speed?: number): Promise<Buffer> {
  const isSeq = "seq" in input;
  const clip = {
    path: isSeq ? join(dir, "seq.png") : input.png, trackIndex: 0, showVideo: true, startSec: 0, sourceIn: 0,
    sourceSpan: 1, isImage: true, outDuration: 1, hasAudio: false, muted: false, effects: { ...look, ...(speed ? { speed } : {}) },
  };
  const cmd = buildRenderCommand([clip as never], { width: W, height: H, fps: FPS }, join(dir, "unused.mp4"), EXPORT_PROFILE, undefined, undefined, { videoOnly: true });
  const at = cmd.args.indexOf("-filter_complex");
  const fc = cmd.args[at + 1];
  const cut = fc.indexOf(";color=c=black:s=");
  const clipChain = fc.slice(0, cut);
  const label = /\[([^\]]+)\]$/.exec(clipChain)?.[0];
  if (!label) throw new Error(`no clip label in ${clipChain}`);
  const chain = clipChain.slice(0, -label.length) + ",format=rgba[parity]";
  const inArgs = isSeq ? ["-framerate", String(FPS), "-start_number", "1", "-i", input.seq] : cmd.args.slice(1, at);
  const frames = isSeq ? input.frames : 1;
  // adaptFfmpegArgs: the graph as the app's executor hands it to this FFmpeg (8.1+ alpha modes).
  const { stdout } = await execa(FFMPEG_BIN, await adaptFfmpegArgs(["-hide_banner", "-loglevel", "error", ...inArgs, "-filter_complex", chain, "-map", "[parity]",
    "-frames:v", String(frames), "-f", "rawvideo", "-pix_fmt", "rgba", "-"]), { cwd: dir, encoding: "buffer" });
  const buf = Buffer.from(stdout as unknown as Uint8Array);
  return buf.subarray(buf.length - W * H * 4);
}

// ---- comparison ----------------------------------------------------------------------

interface Stats { max: number; mean: number; p99: number; maxAt: string }

function compare(a: Uint8Array, b: Uint8Array): Stats {
  const hist = new Array<number>(256).fill(0);
  let sum = 0;
  let n = 0;
  let max = 0;
  let maxAt = "";
  for (let i = 0; i < W * H; i++) {
    const aa = a[i * 4 + 3];
    const ba = b[i * 4 + 3];
    for (let c = 0; c < 4; c++) {
      const d = c === 3 ? Math.abs(aa - ba) : Math.abs((a[i * 4 + c] * aa) / 255 - (b[i * 4 + c] * ba) / 255);
      const r = Math.round(d);
      hist[Math.min(255, r)]++;
      sum += d;
      n++;
      if (d > max) {
        max = d;
        maxAt = `(${i % W},${Math.floor(i / W)}) ch${c} ffmpeg ${[...a.subarray(i * 4, i * 4 + 4)]} gl ${[...b.subarray(i * 4, i * 4 + 4)]}`;
      }
    }
  }
  let acc = 0;
  let p99 = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= n * 0.99) { p99 = v; break; }
  }
  return { max: Math.round(max * 10) / 10, mean: Math.round((sum / n) * 1000) / 1000, p99, maxAt };
}

/** Grain: per-channel mean and standard deviation of (out − in) where the input is mid-range (no clipping). */
function noiseStats(src: Uint8Array, out: Uint8Array): { mean: number; std: number } {
  let s = 0, s2 = 0, n = 0;
  for (let i = 0; i < W * H; i++) {
    for (let c = 0; c < 3; c++) {
      const v = src[i * 4 + c];
      if (v < 40 || v > 215) continue;
      const d = out[i * 4 + c] - v;
      s += d;
      s2 += d * d;
      n++;
    }
  }
  const mean = s / n;
  return { mean, std: Math.sqrt(s2 / n - mean * mean) };
}

// ---- cases ------------------------------------------------------------------------------

interface Case {
  name: string;
  /** Registry effect type (fidelity class from its gl entry) or "color". */
  type: string;
  look: LayerLook;
  /** Pillarboxed source (alpha padding). */
  pillar?: boolean;
  /** Two frames (temporal effects): A then A shifted. */
  temporal?: boolean;
  noise?: boolean;
  fidelity?: GLFidelity;
}

const fx = (type: string, extra: Record<string, unknown> = {}) => ({ id: `${type}`, type, ...extra });
const NON_DEFAULT: Record<string, Record<string, unknown>> = {
  blur: { amount: 30 },
  sharpen: { amount: 3 },
  detail: { amount: 1 },
  denoise: { amount: 15 },
  vignette: { amount: 2 },
  posterize: { amount: 3 },
  pixelate: { amount: 7 },
  chromakey: { color: "0x00FF00", params: { similarity: 0.3, blend: 0.2, despill: 0.6 } },
  colorkey: { color: "0xFF0000", params: { similarity: 0.2, blend: 0.1 } },
  lumakey: { params: { threshold: 1, tolerance: 0.2, softness: 0.2 } },
  exposure: { amount: -1, params: { black: 0.05 } },
  vibrance: { amount: -1.2 },
  colorhold: { color: "0x00FF00", params: { similarity: 0.4, blend: 0.2 } },
  grain: { amount: 60 },
  glow: { amount: 1, params: { radius: 30 } },
  rgbsplit: { amount: 15, params: { angle: 45 } },
  lens: { amount: -0.4, params: { k2: 0.3 } },
  trails: { amount: 0.97 },
};
const DEFAULT_EXTRA: Record<string, Record<string, unknown>> = {
  chromakey: { color: "0x00FF00" },
  colorkey: { color: "0x808080" },
};

function cases(): Case[] {
  const out: Case[] = [];
  for (const e of EFFECTS) {
    const temporal = e.type === "trails";
    const noise = e.type === "grain";
    out.push({ name: `${e.type} (default)`, type: e.type, look: { filters: [fx(e.type, DEFAULT_EXTRA[e.type]) as never] }, temporal, noise });
    if (NON_DEFAULT[e.type]) {
      out.push({ name: `${e.type} ${JSON.stringify(NON_DEFAULT[e.type]).replace(/"/g, "")}`, type: e.type, look: { filters: [fx(e.type, NON_DEFAULT[e.type]) as never] }, temporal, noise });
    }
  }
  // Lens zoom-to-fill (default on): strong barrel, mixed signs (the binding ray is not the corner), and fill off.
  out.push(
    { name: "lens fill off {amount:0.3,params:{fill:0}} (transparent corners)", type: "lens", look: { filters: [fx("lens", { amount: 0.3, params: { fill: 0 } }) as never] } },
    { name: "lens {amount:1,params:{k2:0.5}} (zoom to fill)", type: "lens", look: { filters: [fx("lens", { amount: 1, params: { k2: 0.5 } }) as never] } },
    { name: "lens {amount:0.8,params:{k2:-0.6}} (zoom to fill)", type: "lens", look: { filters: [fx("lens", { amount: 0.8, params: { k2: -0.6 } }) as never] } },
    // Strong warps: lenscorrection's int64 fixed point decides which source pixel a few positions land on.
    { name: "lens {amount:1,params:{k2:0.5,fill:0}} (strong, fill off)", type: "lens", look: { filters: [fx("lens", { amount: 1, params: { k2: 0.5, fill: 0 } }) as never] } },
    { name: "lens {amount:0.5,params:{fill:0}}", type: "lens", look: { filters: [fx("lens", { amount: 0.5, params: { fill: 0 } }) as never] } },
  );
  // hqdn3d's temporal half: the second frame, smoothed against the first's state.
  out.push(
    { name: "denoise (default), 2nd frame (temporal)", type: "denoise", look: { filters: [fx("denoise") as never] }, temporal: true },
    { name: "denoise {amount:15}, 2nd frame (temporal)", type: "denoise", look: { filters: [fx("denoise", { amount: 15 }) as never] }, temporal: true },
  );
  const C = (name: string, look: LayerLook, extra: Partial<Case> = {}): Case => ({ name, type: "color", look, fidelity: "exact", ...extra });
  out.push(
    C("eq brightness/contrast/saturation", { color: { brightness: 0.1, contrast: 1.3, saturation: 1.5 } }),
    C("eq gamma + contrast", { color: { gamma: 1.6, contrast: 0.8 } }),
    // vf_eq.c clips each parameter through av_clipf (float): at these values
    // the float rounding moves process_c's integer brightness by one step.
    C("eq brightness 0.35 (float-rounded parameter)", { color: { brightness: 0.35 } }),
    C("eq brightness −0.15, saturation 1.3", { color: { brightness: -0.15, saturation: 1.3 } }),
    // Out-of-gamut YUV (Y/U/V up to 255): swscale's yuv2rgb sum overflows 32 bits and clips to 0.
    C("eq extreme: contrast 2.5, saturation 3", { color: { contrast: 2.5, saturation: 3 } }),
    C("eq extreme: brightness 0.5, saturation 3", { color: { brightness: 0.5, saturation: 3 } }),
    C("colorbalance wheels + white balance", { grade: { lift: { r: 0.1, b: -0.1 }, gamma: { g: 0.05 }, gain: { b: 0.2 }, temperature: 0.3, tint: -0.2 } }),
    C("hue rotation 40°", { grade: { hue: 40 } }),
    C("curves master S-curve", { grade: { curve: "0/0 0.25/0.18 0.75/0.85 1/1" } }),
    C("curves per channel", { grade: { curveR: "0/0 0.5/0.6 1/1", curveB: "0/0.1 1/0.9", curve: "0/0 0.5/0.45 1/1" } }),
    C("LUT 17³ (tetrahedral)", { lut: "parity.cube" }),
    C("full grade: eq + wheels + hue + curve + LUT", {
      color: { contrast: 1.1, saturation: 1.2 }, grade: { gain: { r: 0.1 }, hue: -15, curve: "0/0.05 0.5/0.5 1/0.95" }, lut: "parity.cube",
    }),
    C("fused: eq + curves (two table samplers)", { color: { contrast: 1.2 }, grade: { curve: "0/0.05 0.5/0.5 1/0.95" } }),
    C("fused: curves + LUT (2D + 3D tables)", { grade: { curve: "0/0.05 0.5/0.5 1/0.95" }, lut: "parity.cube" }),
    C("fused: eq + colorbalance + hue", { color: { saturation: 1.2 }, grade: { gain: { r: 0.1 }, hue: -15 } }),
    C("fused: vibrance, colorhold, sepia, invert, exposure", {
      filters: [fx("vibrance") as never, fx("colorhold") as never, fx("sepia") as never, fx("invert") as never, fx("exposure") as never],
    }),
    // FFmpeg's vignette adds a random [0,1) dither before truncating (the
    // preview rounds): ±1 level, which colorhold's steep ramp then amplifies.
    C("vignette → colorhold (FFmpeg's vignette dither, amplified)", { filters: [fx("vignette") as never, fx("colorhold") as never] }, { fidelity: "close" }),
    // FFmpeg converts exposure's float output to 8 bits with an ordered dither
    // (±1 level by position), which a following vibrance amplifies.
    C("exposure → vibrance (FFmpeg dithers exposure's float output)", { filters: [fx("exposure") as never, fx("vibrance") as never] }, { fidelity: "close" }),
    C("stack: eq → grayscale (YUV chain)", { color: { brightness: 0.05 }, filters: [fx("grayscale") as never] }),
    C("stack: eq → blur (blur in YUV)", { color: { contrast: 1.2 }, filters: [fx("blur", { amount: 4 }) as never] }),
    C("stack: colorkey → blur → vignette (key mid-stack)", {
      filters: [fx("colorkey", { color: "0x808080", params: { similarity: 0.15, blend: 0.1 } }) as never, fx("blur", { amount: 3 }) as never, fx("vignette") as never],
    }),
    C("stack: bypassed blur, sepia, invert", { filters: [fx("blur", { amount: 9, enabled: false }) as never, fx("sepia") as never, fx("invert") as never] }),
    C("pillarboxed: chromakey + glow (alpha padding)", { filters: [fx("chromakey", { color: "0x00FF00" }) as never, fx("glow") as never] }, { pillar: true }),
    C("pillarboxed: blur 6 + lens", { filters: [fx("blur", { amount: 6 }) as never, fx("lens") as never] }, { pillar: true }),
    C("pillarboxed: edges → denoise (the padding's borders)", { filters: [fx("edges") as never, fx("denoise") as never] }, { pillar: true, fidelity: "close" }),
  );
  return out.filter((c) => !ONLY || ONLY.has(c.type) || ONLY.has(c.name));
}

/** Cases for the real-export (4:2:0) section: the effects whose FFmpeg filters take any pixel format, plus a few stacks. */
function cases420(): (Case & { adjust?: boolean })[] {
  const E = (name: string, type: string, extra: Record<string, unknown> = {}, more: Partial<Case> & { adjust?: boolean } = {}) =>
    ({ name, type, look: { filters: [fx(type, extra) as never] }, ...more });
  return [
    E("420: blur 8", "blur", { amount: 8 }),
    E("420: blur 30", "blur", { amount: 30 }),
    E("420: detail 1", "detail", { amount: 1 }),
    E("420: lens −0.4 / k2 0.3", "lens", { amount: -0.4, params: { k2: 0.3 } }),
    E("420: lens 0.5 (zoom to fill)", "lens", { amount: 0.5 }),
    E("420: grayscale", "grayscale"),
    E("420: invert", "invert"),
    E("420: sharpen 3", "sharpen", { amount: 3 }),
    E("420: glow 30", "glow", { amount: 1, params: { radius: 30 } }),
    E("420: pixelate 7", "pixelate", { amount: 7 }),
    E("420: grain 20", "grain", { amount: 20 }, { noise: true }),
    E("420: grain 60", "grain", { amount: 60 }, { noise: true }),
    { name: "420: blur 8 → sepia", type: "blur", look: { filters: [fx("blur", { amount: 8 }) as never, fx("sepia") as never] } },
    { name: "420: eq → blur 8", type: "color", fidelity: "exact", look: { color: { contrast: 1.2 }, filters: [fx("blur", { amount: 8 }) as never] } },
    E("420: adjustment layer: blur 8", "blur", { amount: 8 }, { adjust: true }),
    E("420: adjustment layer: detail 1", "detail", { amount: 1 }, { adjust: true }),
  ];
}

function threshold(f: GLFidelity, s: Stats): boolean {
  if (f === "exact") return s.max <= 3 && s.mean <= 1;
  if (f === "close") return s.p99 <= 8;
  return true;
}

// ---- main ---------------------------------------------------------------------------------

async function main() {
  const bundle = join(dir, "page.js");
  await build({ entryPoints: [join(HERE, "parity-page.ts")], bundle: true, format: "iife", outfile: bundle, logLevel: "error", target: "es2022" });
  writeFileSync(join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><title>parity</title><script src="page.js"></script>`);

  const full = pattern(W, H);
  const pillarW = 240;
  const pillar = pattern(pillarW, H);
  await writePng(join(dir, "full.png"), full, W, H);
  await writePng(join(dir, "pillar.png"), pillar, pillarW, H);
  await writePng(join(dir, "f1.png"), full, W, H);
  const shifted = pattern(W, H, 9);
  await writePng(join(dir, "f2.png"), shifted, W, H);
  // A third frame: the export chain's fps filter holds back the last input frame at EOF.
  await writePng(join(dir, "f3.png"), shifted, W, H);
  const cube = makeCube();
  writeFileSync(join(dir, "parity.cube"), cube);

  let failures = 0;
  const pw = await loadPlaywright();
  const exe = chromiumPath();
  // Media plays without a click, through a fake audio sink (a real-time clock: WSL's sound server runs slow).
  const browser = await pw.chromium.launch({
    ...(exe ? { executablePath: exe } : {}),
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--allow-file-access-from-files",
      "--autoplay-policy=no-user-gesture-required", "--disable-audio-output"],
  });
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "warning" || m.type() === "error") console.log(`  [page] ${m.text()}`); });
  await page.goto(pathToFileURL(join(dir, "index.html")).href);
  const renderer = await page.evaluate(() => (window as unknown as { parity: { renderer: () => string | null } }).parity.renderer());
  console.log(`WebGL2 renderer: ${renderer ?? "UNAVAILABLE"}\nChromium ${browser.version()}, FFmpeg chain from graph.ts, ${W}×${H}, work dir ${dir}\n`);
  if (!renderer) throw new Error("WebGL2 unavailable in this Chromium (the pipeline needs nothing else)");
  // Every run below happens with EXT_color_buffer_float hidden (parity-page.ts):
  // the pipeline stores its float intermediates in RGBA32UI, core WebGL2.
  const floatBlocked = await page.evaluate(() => (window as unknown as { parity: { floatBlocked: () => boolean } }).parity.floatBlocked());
  console.log(`EXT_color_buffer_float hidden for the whole run: ${floatBlocked ? "yes (RGBA32F targets are incomplete)" : "NO — the block failed"}\n`);
  if (!floatBlocked) failures++;

  type Run = {
    rgba: string; srcW: number; srcH: number; cw: number; ch: number; look: LayerLook; frame: number; layerId: string; luts?: Record<string, string>;
    srcFrame?: number; srcStep?: number; pw?: number; ph?: number;
  };
  const glRun = async (r: Run): Promise<Uint8Array> => {
    const b64 = await page.evaluate((a) => (window as unknown as { parity: { run: (a: unknown) => string | null } }).parity.run(a), r);
    if (!b64) throw new Error("GL run failed");
    return new Uint8Array(Buffer.from(b64, "base64"));
  };
  const passesOf = async (r: Run) => {
    const n = await page.evaluate((a) => (window as unknown as { parity: { passes: (a: unknown) => { passes: number; draws: number } } }).parity.passes(a), r);
    return `${n.passes} passes / ${n.draws} draws`;
  };

  const rows: string[] = [];
  let serial = 0;
  for (const c of cases()) {
    const fidelity: GLFidelity = c.fidelity ?? effectGL(c.type)?.fidelity ?? "approx";
    const src = c.pillar ? pillar : full;
    const srcW = c.pillar ? pillarW : W;
    const base: Run = { rgba: src.toString("base64"), srcW, srcH: H, cw: W, ch: H, look: c.look, frame: 0, layerId: `case${serial++}`, luts: { "parity.cube": cube } };
    let ref: Uint8Array;
    let gl: Uint8Array;
    try {
      if (c.temporal) {
        ref = await ffmpegRef(c.look, { seq: "f%d.png", frames: 2 }); // the 2nd output frame: B over A's trail
        await glRun(base);
        gl = await glRun({ ...base, rgba: shifted.toString("base64"), frame: 1 });
      } else {
        ref = await ffmpegRef(c.look, { png: join(dir, c.pillar ? "pillar.png" : "full.png"), w: srcW, h: H });
        gl = await glRun(base);
      }
    } catch (err) {
      failures++;
      rows.push(`| ${c.name} | ${fidelity} | — | — | — | ERROR: ${(err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 120)} |`);
      continue;
    }
    const passes = await passesOf(base);
    if (c.noise) {
      // Placed frame = the source (full frame), so (out − source) is the grain.
      // The export's 4:2:0 output averages the grain's colour (the preview
      // models that), so FFmpeg's side is compared as the export shows it.
      const f = noiseStats(await through420(full), await through420(ref));
      const g = noiseStats(full, gl);
      const ok = Math.abs(f.std - g.std) <= 1 && Math.abs(f.mean - g.mean) <= 0.5;
      if (!ok) failures++;
      rows.push(`| ${c.name} | ${fidelity} | σ ffmpeg ${f.std.toFixed(2)} / gl ${g.std.toFixed(2)} | μ ${f.mean.toFixed(2)} / ${g.mean.toFixed(2)} | — | ${ok ? "ok (statistics)" : "FAIL"} · ${passes} |`);
      continue;
    }
    const s = compare(ref, gl);
    const ok = threshold(fidelity, s);
    if (!ok) failures++;
    rows.push(`| ${c.name} | ${fidelity} | ${s.max} | ${s.mean} | ${s.p99} | ${ok ? "ok" : "FAIL"} · ${passes}${ok ? "" : ` · worst ${s.maxAt}`} |`);
    if (DUMP && (!ok || ONLY)) {
      const stem = join(dir, c.name.replace(/[^a-z0-9]+/gi, "_"));
      await writePng(`${stem}.ffmpeg.png`, Buffer.from(ref), W, H);
      await writePng(`${stem}.gl.png`, Buffer.from(gl), W, H);
      const d = Buffer.alloc(W * H * 4);
      for (let i = 0; i < W * H * 4; i++) d[i] = (i & 3) === 3 ? 255 : Math.min(255, Math.abs(ref[i] - gl[i]) * 16);
      await writePng(`${stem}.diff16.png`, d, W, H);
    }
  }
  console.log("| case | fidelity | max | mean | p99 | result |\n|---|---|---|---|---|---|");
  console.log(rows.join("\n"));

  // The REAL export on 4:2:0 footage. The table above taps each clip chain
  // losslessly in RGBA; the export (and Render exact) instead composites in
  // yuv420p, and FFmpeg picks each filter's pixel format from what FOLLOWS it
  // — so a filter can end up on subsampled chroma the tap never shows. Here a
  // yuv420p clip goes through the whole graph (clip chain, overlay onto the
  // base, format=yuv420p) and is decoded back to RGB; the preview of the same
  // decoded frame goes through the same final 4:2:0 steps (through420), so
  // what remains is how each effect was computed. Thresholds: exact = max ≤ 8
  // (4:2:0 rounding at hard edges) and mean ≤ 1; close = p99 ≤ 8. Grain
  // compares the noise statistics of the export with the preview AS SHOWN
  // (the preview models the 4:2:0 colour of the grain itself).
  const sel420 = cases420().filter((c) => !ONLY || ONLY.has("420") || ONLY.has(c.type) || ONLY.has(c.name));
  if (sel420.length) {
    const src420 = join(dir, "src420.mkv");
    await execa(FFMPEG_BIN, ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", String(FPS), "-i", join(dir, "full.png"),
      "-t", "1.2", "-pix_fmt", "yuv420p", "-c:v", "ffv1", src420]);
    const dec = await execa(FFMPEG_BIN, ["-hide_banner", "-loglevel", "error", "-i", src420, "-filter_complex", "[0:v]format=rgba[o]", "-map", "[o]",
      "-frames:v", "1", "-f", "rawvideo", "-"], { encoding: "buffer" });
    const decoded = Buffer.from(dec.stdout as unknown as Uint8Array).subarray(0, W * H * 4);
    const exportFrame = async (look: LayerLook, adjust: boolean): Promise<Uint8Array> => {
      const base = { path: src420, trackIndex: 0, showVideo: true, startSec: 0, sourceIn: 0, sourceSpan: 1, isImage: false, outDuration: 1, hasAudio: false, muted: false };
      const clips = adjust
        ? [base, { ...base, path: "", adjustment: true, trackIndex: 1, effects: { ...look } }]
        : [{ ...base, effects: { ...look } }];
      const cmd = buildRenderCommand(clips as never, { width: W, height: H, fps: FPS }, join(dir, "unused.mp4"), EXPORT_PROFILE, undefined, undefined, { videoOnly: true });
      const at = cmd.args.indexOf("-filter_complex");
      const { stdout } = await execa(FFMPEG_BIN, await adaptFfmpegArgs(["-hide_banner", "-loglevel", "error", ...cmd.args.slice(1, at), "-filter_complex", cmd.args[at + 1],
        "-map", "[outv]", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]), { cwd: dir, encoding: "buffer" });
      return new Uint8Array(Buffer.from(stdout as unknown as Uint8Array).subarray(0, W * H * 4));
    };
    const glOf = (look: LayerLook, input: Uint8Array = decoded) =>
      glRun({ rgba: Buffer.from(input).toString("base64"), srcW: W, srcH: H, cw: W, ch: H, look, frame: 0, layerId: `r420-${serial++}`, luts: { "parity.cube": cube } });
    const floorRef = await exportFrame({}, false);
    const floorGl = await glOf({});
    const floor = compare(floorRef, await through420(floorGl));
    const rows420: string[] = [`| 420: no effect | — | ${floor.max} | ${floor.mean} | ${floor.p99} | reported (the plain clip's 4:2:0 conversion differs slightly) |`];
    for (const c of sel420) {
      const fidelity: GLFidelity = c.fidelity ?? effectGL(c.type)?.fidelity ?? "approx";
      let ref: Uint8Array;
      let gl: Uint8Array;
      try {
        ref = await exportFrame(c.look, !!c.adjust);
        // An adjustment layer filters the export's composite, which is yuv420p
        // (every overlay is): the preview gets that composite as its input here.
        gl = await glOf(c.look, c.adjust ? floorRef : decoded);
      } catch (err) {
        failures++;
        rows420.push(`| ${c.name} | ${fidelity} | — | — | — | ERROR: ${(err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 120)} |`);
        continue;
      }
      if (c.noise) {
        // The grain = output − the same frame without it, on each side. The
        // export's grain-free frame takes the same route out (an effect stack
        // that changes nothing: invert twice), so only the grain differs.
        const f = noiseStats(await exportFrame({ filters: [fx("invert") as never, fx("invert") as never] }, false), ref);
        const g = noiseStats(floorGl, gl);
        const ok = Math.abs(f.std - g.std) <= 1 && Math.abs(f.mean - g.mean) <= 0.5;
        if (!ok) failures++;
        rows420.push(`| ${c.name} | ${fidelity} | σ export ${f.std.toFixed(2)} / gl ${g.std.toFixed(2)} | μ ${f.mean.toFixed(2)} / ${g.mean.toFixed(2)} | — | ${ok ? "ok (statistics)" : "FAIL"} |`);
        continue;
      }
      const s = compare(ref, await through420(gl));
      const ok = fidelity === "exact" ? s.max <= 8 && s.mean <= 1 : fidelity === "close" ? s.p99 <= 8 : true;
      if (!ok) failures++;
      rows420.push(`| ${c.name} | ${fidelity} | ${s.max} | ${s.mean} | ${s.p99} | ${ok ? "ok" : `FAIL · worst ${s.maxAt}`} |`);
    }
    console.log("\nThe real export on 4:2:0 footage (full graph → yuv420p → RGB) vs the preview of the decoded frame (through the same 4:2:0 output):");
    console.log("| case | fidelity | max | mean | p99 | result |\n|---|---|---|---|---|---|");
    console.log(rows420.join("\n"));
  }

  // Context loss: the pipeline must refuse to run while lost (the preview then
  // uses its CSS fallback) and render the same bytes again after the restore.
  if (!ONLY) {
    const look: LayerLook = { color: { contrast: 1.2 }, filters: [fx("sepia") as never, fx("vignette") as never] };
    const r: Run = { rgba: full.toString("base64"), srcW: W, srcH: H, cw: W, ch: H, look, frame: 0, layerId: "ctx" };
    const before = await glRun(r);
    const res = await page.evaluate((a) => (window as unknown as { parity: { contextLoss: (a: unknown) => Promise<{ whileLost: boolean; after: string | null }> } }).parity.contextLoss(a), r);
    const after = res.after ? new Uint8Array(Buffer.from(res.after, "base64")) : null;
    const same = !!after && after.length === before.length && after.every((v, i) => v === before[i]);
    if (!res.whileLost || !same) failures++;
    console.log(`\ncontext loss: ${res.whileLost ? "refuses while lost (CSS fallback)" : "FAIL: still ran while lost"}; after restore ${same ? "identical output" : "FAIL: output differs / no output"}`);

    // A still larger than MAX_TEXTURE_SIZE can't be uploaded as is: the
    // pipeline draws its crop through a scaled 2D canvas (it used to come out
    // as an opaque black layer).
    type Over = { maxTexture: number; small: number[]; bigLeft: number[]; bigRight: number[]; bigLeftAgain: number[] } | null;
    const ov = await page.evaluate(() => (window as unknown as { parity: { oversize: () => Over } }).parity.oversize());
    const eq4 = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
    const okOver = !!ov && ov.small[3] === 255 && eq4(ov.bigLeft, ov.small) && eq4(ov.bigLeftAgain, ov.small) &&
      ov.bigRight[3] === 255 && !eq4(ov.bigRight, ov.small) && ov.bigRight[2] > 0;
    if (!okOver) failures++;
    console.log(`oversized still (${ov ? `${ov.maxTexture + 1808}×400 > MAX_TEXTURE_SIZE ${ov.maxTexture}` : "no WebGL2"}): ` +
      `${okOver ? "renders like a small source, a new crop shows" : "FAIL"} — small ${ov?.small} / big ${ov?.bigLeft} / big, other crop ${ov?.bigRight} / big again ${ov?.bigLeftAgain}`);
  }

  // Temporal effects' clock and GPU memory. The export runs lagfun / hqdn3d per
  // SOURCE frame (before the speed change), so the preview's history steps by
  // the source frame shown; it is keyed by the effect's own id (a reorder keeps
  // it) and resampled when the processing size changes; tables and LUTs are
  // freed explicitly.
  if (!ONLY || ONLY.has("temporal")) {
    const K = Buffer.alloc(W * H * 4);
    for (let i = 3; i < K.length; i += 4) K[i] = 255; // opaque black
    // sA: the pattern, then black frames whose pixel (0,0) is 20 × their source index (a marker the
    // trail keeps as its running max), so the export's output says which source frame it shows.
    const marked = (j: number) => {
      const b = Buffer.from(K);
      b.fill(20 * j, 0, 3);
      return b;
    };
    for (const [name, frames] of [["sA", [full, ...Array.from({ length: 9 }, (_, j) => marked(j + 1))]], ["sB", [full, K, K, K, K]]] as const) {
      for (const [i, f] of frames.entries()) await writePng(join(dir, `${name}${i + 1}.png`), f, W, H);
    }
    const trails = (extra: Record<string, unknown> = {}) => ({ filters: [fx("trails", { id: "tr", amount: 0.9, ...extra }) as never] });
    const b64 = (b: Buffer) => b.toString("base64");
    const runs = async (layerId: string, seq: Partial<Run>[]): Promise<Uint8Array> => {
      let out: Uint8Array | null = null;
      for (const r of seq) out = await glRun({ rgba: b64(full), srcW: W, srcH: H, cw: W, ch: H, look: trails(), frame: 0, layerId, ...r } as Run);
      return out!;
    };
    const rowsT: string[] = [];
    const judge = (name: string, ref: Uint8Array, gl: Uint8Array) => {
      const st = compare(ref, gl);
      const ok = threshold("exact", st);
      if (!ok) failures++;
      rowsT.push(`| ${name} | ${st.max} | ${st.mean} | ${ok ? "ok" : `FAIL · worst ${st.maxAt}`} |`);
    };
    // 2× speed: by timeline frame 3 the export's lagfun has run on every source frame up to the
    // one it shows (5 or 6: FFmpeg's fps filter breaks the half-frame tie), so the pattern has
    // decayed that many times; the preview, given that source frame, decays as often.
    const ref2 = await ffmpegRef(trails(), { seq: "sA%d.png", frames: 4 }, 2);
    const shown = Math.round(ref2[0] / 20);
    judge(`trails at 2× speed (timeline frame 3 shows source frame ${shown}: ${shown} decays)`, ref2,
      await runs("t-speed2", [{ frame: 0, srcFrame: 0, srcStep: 2 }, { frame: 3, srcFrame: shown, srcStep: 2, rgba: b64(marked(shown)) }]));
    // 1/3 speed: timeline frames 0–2 hold source 0, 3–4 source 1 (black): one decay, however long it is held.
    judge("trails at 1/3 speed (a held source frame doesn't decay)",
      await ffmpegRef(trails(), { seq: "sB%d.png", frames: 5 }, 1 / 3),
      await runs("t-slow", [0, 1, 2, 3, 4].map((f) => ({ frame: f, srcFrame: Math.floor(f / 3), srcStep: 1 / 3, rgba: b64(f < 3 ? full : K) }))));
    // Reordering (a bypassed effect moves ahead of trails) keeps the trail: it is keyed by the effect's id.
    const refAC = await ffmpegRef(trails(), { seq: "f%d.png", frames: 2 });
    const before: LayerLook = { filters: [fx("trails", { id: "tr", amount: 0.9 }) as never, fx("colorkey", { id: "ck", enabled: false }) as never] };
    const after: LayerLook = { filters: [fx("colorkey", { id: "ck", enabled: false }) as never, fx("trails", { id: "tr", amount: 0.9 }) as never] };
    judge("trails survive a reorder of the stack (history keyed by the effect id)",
      refAC, await runs("t-reorder", [{ frame: 0, look: before }, { frame: 1, look: after, rgba: b64(shifted) }]));
    // A paused frame whose history lacks earlier frames is rebuilt from them by the real gl/warmup.ts
    // (debounced, from frames the core decodes: here a mocked /frames route in the page). historyGap
    // says from where, the side history is adopted and a repaint asked, and the frame matches the export.
    type WarmLog = { requests: { path: string; from: number; count: number; aborted: boolean }[]; repaints: number; pending: string[]; settled: string[] };
    const call = <T,>(fn: string, ...a: unknown[]) =>
      page.evaluate(([f, x]) => (window as unknown as { parity: Record<string, (...v: unknown[]) => unknown> }).parity[f as string](...(x as unknown[])), [fn, a] as const) as Promise<T>;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const log = () => call<WarmLog>("warmLog");
    const asked = async (path: string) => (await log()).requests.filter((r) => r.path === path);
    const until = async (ok: (l: WarmLog) => boolean, ms = 4000) => {
      for (let t = 0; t < ms; t += 50) {
        const l = await log();
        if (ok(l)) return l;
        await sleep(50);
      }
      return log();
    };
    const run = (r: Partial<Run>) => ({ rgba: b64(full), srcW: W, srcH: H, cw: W, ch: H, look: trails(), frame: 0, layerId: "?", ...r });
    const draw = (r: Partial<Run>) => call<{ gap: number | null; out: string | null }>("warmDraw", { ...run({ srcFrame: r.frame, srcStep: 1, ...r }), path: r.layerId, first: 0 });
    // The paused frame drawn like the preview does (runLayer, then warmIfNeeded); once the warm-up
    // asks for a repaint (or gives up), drawn again.
    type WarmOut = { gap: number | null; gapAfter: number | null; before: string | null; out: string | null };
    const warm = async (live: Partial<Run>, frames: Buffer[], mode = "ok"): Promise<WarmOut> => {
      await call("warmFrames", live.layerId, frames.map(b64), mode);
      const rep0 = (await log()).repaints;
      const first = await draw(live);
      await sleep(250);
      await until((l) => l.repaints > rep0 || !l.pending.includes(live.layerId!));
      const again = await draw(live);
      return { gap: first.gap, gapAfter: again.gap, before: first.out, out: again.out };
    };
    const judgeWarm = (name: string, ref: Uint8Array, r: WarmOut, gap: number) => {
      if (r.gap !== gap || r.gapAfter !== null || !r.out) {
        failures++;
        rowsT.push(`| ${name} | — | — | FAIL · historyGap ${r.gap} (want ${gap}), after the warm-up ${r.gapAfter} (want null) |`);
        return;
      }
      judge(name, ref, new Uint8Array(Buffer.from(r.out, "base64")));
    };
    const row = (name: string, ok: boolean, why: string) => {
      if (!ok) failures++;
      rowsT.push(`| ${name} | — | — | ${ok ? "ok" : `FAIL · ${why}`} |`);
    };
    judgeWarm("trails paused after a seek: frame 0 warmed, then the export's trail",
      refAC, await warm({ layerId: "t-seek", frame: 1, rgba: b64(shifted) }, [full]), 0);
    // An ENABLED effect moved ahead of trails: the history was built from another input (an invert
    // that came after it) — it starts over at once (not a dark stale trail), then the warm-up rebuilds it.
    const invFirst: LayerLook = { filters: [fx("invert", { id: "iv" }) as never, fx("trails", { id: "tr", amount: 0.9 }) as never] };
    const trailsFirst: LayerLook = { filters: [fx("trails", { id: "tr", amount: 0.9 }) as never, fx("invert", { id: "iv" }) as never] };
    await runs("t-reinv", [{ frame: 0, look: trailsFirst }]);
    const re = await warm({ layerId: "t-reinv", frame: 1, look: invFirst, rgba: b64(shifted) }, [full]);
    if (re.before) judge("trails after invert moves ahead of it: restarted at once (the new input only)",
      await ffmpegRef(invFirst, { png: join(dir, "f2.png"), w: W, h: H }), new Uint8Array(Buffer.from(re.before, "base64")));
    judgeWarm("… and rebuilt by the warm-up: the export's trail", await ffmpegRef(invFirst, { seq: "f%d.png", frames: 2 }), re, 0);
    const cont = await call<number | null>("warmGap", run({ layerId: "t-cont", frame: 1, rgba: b64(shifted) }), 0);
    if (cont !== 0) row("a lone paused frame needs a warm-up", false, `historyGap ${cont}`);
    await runs("t-step", [{ frame: 0 }, { frame: 1, rgba: b64(shifted) }]);
    const stepped = await call<number | null>("warmGap", run({ layerId: "t-step", frame: 1, rgba: b64(shifted) }), 0);
    row(`frames drawn one by one from the clip's first need no warm-up (historyGap ${stepped})`, stepped === null, "a warm-up asked for");
    // A scrub: paused frames 2 then 1 within the debounce make one decode, for where it stopped.
    await call("warmFrames", "w-scrub", [full, shifted, K].map(b64), "ok");
    const rep0 = (await log()).repaints;
    await draw({ layerId: "w-scrub", frame: 2, rgba: b64(K) });
    await sleep(50);
    await draw({ layerId: "w-scrub", frame: 1, rgba: b64(shifted) });
    await sleep(250);
    await until((l) => l.repaints > rep0 || !l.pending.includes("w-scrub"));
    const scrub = await asked("w-scrub");
    row("a scrub (frames 2, 1 within 180 ms) warms once, where it stops", scrub.length === 1 && scrub[0].from === 0 && scrub[0].count === 1,
      `decodes asked: ${JSON.stringify(scrub)}`);
    const scrubbed = await draw({ layerId: "w-scrub", frame: 1, rgba: b64(shifted) });
    if (scrubbed.out) judge("… and the frame it stops on shows the export's trail", refAC, new Uint8Array(Buffer.from(scrubbed.out, "base64")));
    // A failed decode is not retried for the same frame and look; a new look tries again.
    await warm({ layerId: "w-fail", frame: 1, rgba: b64(shifted) }, [full], "fail");
    await draw({ layerId: "w-fail", frame: 1, rgba: b64(shifted) });
    await sleep(400);
    const failedOnce = (await asked("w-fail")).length;
    await draw({ layerId: "w-fail", frame: 1, rgba: b64(shifted), look: trails({ amount: 0.8 }) });
    await sleep(250);
    await until((l) => !l.pending.includes("w-fail"));
    const failedTwice = (await asked("w-fail")).length;
    row("a failed warm-up is not retried for the same frame, and is for a new look", failedOnce === 1 && failedTwice === 2,
      `${failedOnce} decode(s) for the same key, ${failedTwice} after the look changed`);
    // Playback starting (cancelWarmups) aborts a decode in flight; nothing is adopted.
    await call("warmFrames", "w-cancel", [full, shifted, K].map(b64), "hang");
    const repC = (await log()).repaints;
    await draw({ layerId: "w-cancel", frame: 2, rgba: b64(K) });
    await until((l) => l.requests.some((r) => r.path === "w-cancel"));
    await sleep(100);
    await call("warmCancel");
    await sleep(100);
    const lc1 = await log();
    const cancelReq = lc1.requests.filter((r) => r.path === "w-cancel");
    const gapC = await call<number | null>("warmGap", run({ layerId: "w-cancel", frame: 2, srcFrame: 2, srcStep: 1, rgba: b64(K) }), 0);
    row("cancelWarmups aborts the decode in flight and adopts nothing",
      cancelReq.length === 1 && cancelReq[0].aborted && !lc1.pending.includes("w-cancel") && lc1.repaints === repC && gapC === 0,
      `aborted ${cancelReq.map((r) => r.aborted)}, pending ${lc1.pending}, repaints +${lc1.repaints - repC}, historyGap ${gapC}`);
    // A body one frame short: no adopt, no repaint, and the same frame isn't asked for again.
    const repS = (await log()).repaints;
    const short = await warm({ layerId: "w-short", frame: 2, rgba: b64(K) }, [full, shifted, K], "short");
    await sleep(400);
    const ls = await log();
    const shortReq = ls.requests.filter((r) => r.path === "w-short");
    row("a decode one frame short is not adopted and not retried", short.gapAfter === 0 && shortReq.length === 1 && ls.settled.includes("w-short") && ls.repaints === repS,
      `historyGap after ${short.gapAfter}, ${shortReq.length} decode(s), settled ${ls.settled.includes("w-short")}, repaints +${ls.repaints - repS}`);
    // Over the byte cap (here two frames) only the most recent frames are decoded: adopted, then settled.
    await call("warmMaxBytes", 2 * W * H * 4);
    const part = await warm({ layerId: "w-part", frame: 4, rgba: b64(K) }, [full, shifted, K, full, shifted]);
    await draw({ layerId: "w-part", frame: 4, rgba: b64(K) });
    await sleep(400);
    await call("warmMaxBytes", 360 << 20);
    const partReq = await asked("w-part");
    row("over the byte cap: the last frames warmed once (frames 2–3 of 0–3), not retried",
      partReq.length === 1 && partReq[0].from === 2 && partReq[0].count === 2 && part.gapAfter === 0 && (await log()).settled.includes("w-part"),
      `decodes ${JSON.stringify(partReq)}, historyGap after ${part.gapAfter}`);
    // The warmed frames run at their own timeline frames (grain's seed), so the result is what
    // drawing those frames one by one gives.
    const grainy: LayerLook = { filters: [fx("grain", { id: "gr" }) as never, fx("trails", { id: "tr", amount: 0.9 }) as never] };
    const gw = await warm({ layerId: "w-grain", frame: 9, srcFrame: 2, look: grainy, rgba: b64(K) }, [full, shifted, K]);
    const gref = await runs("w-grain-ref", [0, 1, 2].map((f) => ({ frame: 7 + f, srcFrame: f, srcStep: 1, look: grainy, rgba: b64([full, shifted, K][f]) })));
    const gout = gw.out ? new Uint8Array(Buffer.from(gw.out, "base64")) : null;
    row("warmed frames keep their timeline frame (grain + trails = drawn one by one)", !!gout && gw.gapAfter === null && compare(gref, gout).max === 0,
      gout ? `max diff ${compare(gref, gout).max}, historyGap after ${gw.gapAfter}` : "no output");
    // A processing-size change (pause after scaled playback, a zoom) resamples the trail instead of dropping it.
    const box = Buffer.from(K);
    for (let y = 40; y < 100; y++) for (let x = 40; x < 120; x++) box.fill(255, (y * W + x) * 4, (y * W + x) * 4 + 4);
    const half = await runs("t-resize", [{ frame: 0, rgba: b64(box) }, { frame: 1, rgba: b64(K), pw: W / 2, ph: H / 2 }]);
    let sum = 0;
    let n = 0;
    for (let y = 25; y < 45; y++) for (let x = 25; x < 55; x++, n++) sum += half[(y * (W / 2) + x) * 4];
    const okResize = Math.abs(sum / n - 0.9 * 255) <= 8;
    if (!okResize) failures++;
    rowsT.push(`| trails kept across a processing-size change (320×180 → 160×90): box area ${(sum / n).toFixed(1)}, want ≈ ${(0.9 * 255).toFixed(1)} | — | — | ${okResize ? "ok" : "FAIL"} |`);
    console.log("\nTemporal clock (trails): | case | max | mean | result |\n|---|---|---|---|");
    console.log(rowsT.join("\n"));

    // eq / curves tables during a slider drag: 50 new tables for one layer, no new textures.
    const ch = await page.evaluate((a) => (window as unknown as { parity: { churn: (a: unknown, n: number) => { first: number; last: number } } }).parity.churn(a, 50),
      { rgba: b64(full), srcW: W, srcH: H, cw: W, ch: H, look: {}, frame: 0, layerId: "churn" });
    const okChurn = ch.last === ch.first;
    if (!okChurn) failures++;
    console.log(`\neq + curves tables, 50 new tables on one layer: live GL textures ${ch.first} → ${ch.last} ${okChurn ? "(ok: refilled in place)" : "FAIL: a texture per table, freed only by GC"}`);

    // LUTs: a .cube rewritten in place (new ETag) shows; 12 LUTs leave ≤ 8 cached.
    const lc = await page.evaluate(([a, c]) => (window as unknown as { parity: { lutCache: (a: unknown, c: unknown) => Promise<{
      before: string | null; after: string | null; idle: string | null; idleRepaints: number; ref: string | null; cached: number; textures: number; live: number[];
      broken: { gets: number; problem: string | null; out: string | null; fixed: string | null; fixedProblem: string | null };
      late: { first: string; gets: number; problem: string | null; recovered: string; out: string | null };
      idleFix: { problem: string | null; repaints: number };
      missing: { first: string; recovered: string };
      budget: { state: string; problem: string | null };
    }> } }).parity.lutCache(a, c),
    [{ rgba: b64(full), srcW: W, srcH: H, cw: W, ch: H, look: {}, frame: 0, layerId: "lutc" },
      { a: makeCube(), b: makeCube(1), many: Array.from({ length: 12 }, (_, i) => makeCube(2 + i)) }] as const);
    const okRewrite = !!lc.before && !!lc.after && lc.after === lc.ref && lc.after !== lc.before;
    const growth = lc.live[lc.live.length - 1] - lc.live[0];
    const okLru = lc.cached <= 8 && lc.textures <= 8 && growth <= 8;
    if (!okRewrite) failures++;
    if (!okLru) failures++;
    const okIdle = lc.idleRepaints > 0 && !!lc.idle && lc.idle === lc.before;
    if (!okIdle) failures++;
    console.log(`LUT rewritten in place: ${okRewrite ? "the preview switches to the new table (ok)" : "FAIL: still the old table"}`);
    console.log(`LUT rewritten while nothing draws (paused): ${okIdle ? "noticed, repaint asked, new table shown (ok)" : `FAIL (${lc.idleRepaints} repaints, ${lc.idle === lc.before ? "new" : "old"} table)`}`);
    console.log(`12 LUTs used in turn: ${lc.cached} cached, ${lc.textures} textures, live GL textures +${growth} ${okLru ? "(ok: LRU ≤ 8)" : "FAIL"}`);
    // A rewrite that fails to parse: read once over ~16 re-checks, the previous table kept and reported stale; a fix shows.
    const b = lc.broken;
    const okBroken = b.gets === 1 && !!b.problem?.startsWith("stale:") && b.out === lc.after && b.fixed === lc.before && b.fixedProblem === null;
    if (!okBroken) failures++;
    console.log(`LUT rewritten with content that doesn't parse: ${okBroken ? "read once, previous table kept and reported stale, the fixed file shows (ok)"
      : `FAIL (${b.gets} GETs, problem ${b.problem}, ${b.out === lc.after ? "previous" : "other"} table, after the fix ${b.fixed === lc.before ? "new table" : "not the new table"} / ${b.fixedProblem})`}`);
    const l = lc.late;
    const okLate = l.first === "error" && l.gets === 0 && !!l.problem?.startsWith("error:") && l.recovered === "ready" && l.out === lc.before;
    if (!okLate) failures++;
    console.log(`LUT whose first read failed, then fixed on disk: ${okLate ? "not re-read while unchanged, recovers without a restart (ok)"
      : `FAIL (first ${l.first}, ${l.gets} more GETs while unchanged, problem ${l.problem}, then ${l.recovered})`}`);
    const okIdleFix = lc.idleFix.problem === null && lc.idleFix.repaints > 0;
    if (!okIdleFix) failures++;
    console.log(`… fixed while nothing draws (paused): ${okIdleFix ? "noticed, repaint asked (ok)" : `FAIL (${lc.idleFix.problem}, ${lc.idleFix.repaints} repaints)`}`);
    const okMissing = lc.missing.first === "error" && lc.missing.recovered === "ready";
    if (!okMissing) failures++;
    console.log(`LUT file missing at first, then written: ${okMissing ? "recovers (ok)" : `FAIL (${lc.missing.first} → ${lc.missing.recovered})`}`);
    const okBudget = lc.budget.state === "error" && !!lc.budget.problem?.includes("over the preview's");
    if (!okBudget) failures++;
    console.log(`LUT over the byte budget: ${okBudget ? `refused before parsing, reported (ok: ${lc.budget.problem})` : `FAIL (${lc.budget.state}, ${lc.budget.problem})`}`);
  }

  // The preview's decoder pool (src/mediapool.ts) on a real <video>: a paused frame at n / fps
  // shows frame n (Chromium seeks in whole microseconds: without the pool's nudge some land on
  // n - 1), and playback of a clip with sound settles after a seek or two instead of seeking
  // again while the element starts (seek thrash: a frozen picture).
  if (!ONLY || ONLY.has("mediapool")) {
    await execa("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=1280x720:r=30:d=6",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-vf", "geq=lum='16+mod(N,36)*6':cb=128:cr=128",
      "-c:v", "libx264", "-preset", "veryfast", "-g", "150", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart",
      "-y", join(dir, "counter.mp4")]);
    const ns = [1, 2, 4, 5, 7, 8, 10, 11, 13, 14, 16, 17, 19, 20, 22, 23, 25, 26, 28, 29];
    type PoolOut = { paused: { n: number; shown: number }[]; seeks: number[]; readyState: number; currentTime: number; playing: boolean };
    const mp = await page.evaluate((a) => (window as unknown as { parity: { mediaPool: (a: unknown) => Promise<PoolOut> } }).parity.mediaPool(a),
      { url: pathToFileURL(join(dir, "counter.mp4")).href, fps: FPS, ns, playAt: 2.5, playMs: 2500 });
    const wrong = mp.paused.filter((p) => p.shown !== p.n);
    const okPaused = mp.paused.length === ns.length && wrong.length === 0;
    if (!okPaused) failures++;
    console.log(`\nMediaPool, paused at n/30 for ${ns.length} n: ${okPaused ? "shows frame n (ok)" : `FAIL: ${wrong.map((p) => `${p.n} → ${p.shown}`).join(", ")}`}`);
    // Each seek lands ~100 ms late here (keyframe decode + the audio restarting): the pool learns
    // that lead within a seek or two and then plays on (a stall on a loaded machine may cost a
    // resync or two more); without the landing guard it never learns it and re-seeks every
    // ~100 ms for as long as it plays (about 10 in the last second).
    const late = mp.seeks.filter((t) => t > 1500).length;
    const okPlay = mp.seeks.length <= 6 && late <= 1 && mp.readyState >= 2 && mp.playing && mp.currentTime > 4.5;
    if (!okPlay) failures++;
    console.log(`MediaPool, 2.5 s of playback with sound from 2.5 s: seeks at ${mp.seeks.join(", ")} ms (${late} in the last second), readyState ${mp.readyState}, ` +
      `at ${mp.currentTime.toFixed(2)} s ${okPlay ? "(ok: settles, plays on)" : "FAIL (want ≤ 6 seeks, ≤ 1 in the last second, readyState ≥ 2, playing past 4.5 s)"}`);
  }

  if (BENCH) {
    type Bench = { gl: number; css: number; passes: number; draws: number };
    const bench = (layers: { look: LayerLook }[], w = 1280, h = 720, q = 1) =>
      page.evaluate((a) => (window as unknown as { parity: { bench: (a: unknown) => Bench } }).parity.bench(a), { w, h, q, layers, frames: 20 });
    if (args.includes("--diag")) {
      const inv = (n: number) => ({ look: { filters: Array.from({ length: n }, () => fx("invert") as never) } });
      console.log("\nDiagnostics (2 layers): | size | look | GL passes | GL ms | CSS ms |");
      for (const [w, h] of [[1280, 720], [640, 360]]) {
        for (const [name, l] of [["empty (place + output)", { look: {} }], ["1 invert", inv(1)], ["3 inverts", inv(3)], ["6 inverts", inv(6)]] as const) {
          const r = await bench([l, l], w, h);
          console.log(`| ${w}×${h} | ${name} | ${r.passes} → ${r.draws} | ${r.gl.toFixed(1)} | ${r.css.toFixed(1)} |`);
        }
      }
    }
    const sets: [string, { look: LayerLook }[]][] = [
      ["2 layers × [exposure, vignette, vibrance]", [
        { look: { filters: [fx("exposure") as never, fx("vignette") as never, fx("vibrance") as never] } },
        { look: { filters: [fx("exposure") as never, fx("vignette") as never, fx("vibrance") as never] } },
      ]],
      ["2 layers × [sepia, sharpen, rgbsplit]", [
        { look: { filters: [fx("sepia") as never, fx("sharpen") as never, fx("rgbsplit") as never] } },
        { look: { filters: [fx("sepia") as never, fx("sharpen") as never, fx("rgbsplit") as never] } },
      ]],
      ["2 layers × [blur 8, sepia, vignette]", [
        { look: { filters: [fx("blur") as never, fx("sepia") as never, fx("vignette") as never] } },
        { look: { filters: [fx("blur") as never, fx("sepia") as never, fx("vignette") as never] } },
      ]],
      ["heavy: [blur 8, glow, grain] + [chromakey]", [
        { look: { filters: [fx("blur") as never, fx("glow") as never, fx("grain") as never] } },
        { look: { filters: [fx("chromakey", { color: "0x00FF00" }) as never] } },
      ]],
    ];
    // Fixed-size kernels run at the export's resolution (k = 1) instead of the 1280-wide buffer's (k = 2/3 for 1080p).
    console.log("\nFixed-size-kernel looks on a 1920×1080 canvas, 1 layer: | look | k = 2/3 (1280×720) ms | k = 1 (1920×1080) ms | cost |\n|---|---|---|---|");
    for (const t of ["sharpen", "detail", "edges", "chromakey", "denoise"]) {
      const layer = [{ look: { filters: [fx(t, DEFAULT_EXTRA[t]) as never] } }];
      const scaled = await bench(layer, 1920, 1080, 2 / 3);
      const full1 = await bench(layer, 1920, 1080, 1);
      console.log(`| ${t} | ${scaled.gl.toFixed(1)} | ${full1.gl.toFixed(1)} | ×${(full1.gl / scaled.gl).toFixed(2)} |`);
    }
    console.log("\nPerformance, 1280×720 compositor, 20 frames, this Chromium's WebGL2 (" + renderer + "):");
    console.log("| layers | GL passes → draws | GL ms/frame (fps) | GL, half-res looks (software playback) | GL, quarter-res looks (slow software playback) | before: CSS proxy + canvas vignette, ms (fps) |\n|---|---|---|---|---|---|");
    for (const [name, layers] of sets) {
      const r = await bench(layers);
      const half = await bench(layers, 1280, 720, 0.5);
      const quarter = await bench(layers, 1280, 720, 0.25);
      const f = (ms: number) => `${ms.toFixed(1)} (${(1000 / ms).toFixed(1)})`;
      console.log(`| ${name} | ${r.passes} → ${r.draws} | ${f(r.gl)} | ${f(half.gl)} | ${f(quarter.gl)} | ${f(r.css)} |`);
    }
  }

  await browser.close();
  if (!DUMP) rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? "\nPARITY PASSED" : `\nPARITY: ${failures} case(s) outside their fidelity threshold`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
