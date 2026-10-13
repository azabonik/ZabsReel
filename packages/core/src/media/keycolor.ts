import { runFfmpegStdoutBuffer } from "../ffmpeg/executor.js";
import { inputColorOpts, SWS_CONVERT, type SourceColor } from "../ffmpeg/colorspace.js";
import type { CropRect } from "../types.js";

/**
 * Key-colour auto-detection for chromakey / colorkey (`color: "auto"`). A
 * screen or flat graphics background almost always reaches the frame edges,
 * while the subject sits inside — so we sample the OUTER RING of a couple of
 * frames, find the dominant colour there and report how much of the ring it
 * covers (the confidence). Pure FFmpeg + arithmetic, no model, no network.
 *
 * The engine resolves "auto" to a concrete hex at apply time, so the export
 * stays deterministic and the UI can show (and let you tweak) the colour.
 */

/** Analysis grid. Area-scaled so each cell averages away codec noise. */
const GRID = 192;
/** Border ring depth as a fraction of each edge (≈4 cells of the grid). */
const RING = 0.02;
/** A ring pixel "matches" within this colorkey-style RGB distance (0..1). */
const MATCH_DIST = 0.06;

export interface KeyColorDetection {
  /** The detected key colour as an FFmpeg hex, e.g. "0x808080". */
  color: string;
  /** Share (0..1) of border pixels close to `color`: ~1 = a flat screen, low = busy edges. */
  confidence: number;
  /** The same colour as 0..255 channels. */
  rgb: { r: number; g: number; b: number };
}

/** One frame of `path` at `t` (seconds), optionally cropped, as a GRID×GRID rgb24 buffer. */
async function grabGrid(path: string, t: number, crop?: CropRect, color?: SourceColor): Promise<Buffer> {
  const vf: string[] = [];
  if (crop && crop.width > 0 && crop.height > 0) {
    vf.push(`crop=${Math.round(crop.width)}:${Math.round(crop.height)}:${Math.round(crop.x)}:${Math.round(crop.y)}`);
  }
  // Convert to RGBA BEFORE resizing, exactly like the render graph does: a
  // combined resize+convert in one swscale pass skips the limited→full range
  // expansion on untagged YUV (flat 0x808080 would read back as 0x7E7E7E and
  // no longer match what the key sees on export).
  // `color`: read the YUV as the export does (colorspace.ts), so the key matches what it keys.
  if (color) vf.push(`scale=flags=${SWS_CONVERT}${inputColorOpts(color)}`);
  vf.push("format=rgba", `scale=${GRID}:${GRID}:flags=area`);
  return runFfmpegStdoutBuffer([
    "-hide_banner",
    "-ss",
    Math.max(0, t).toFixed(3),
    "-i",
    path,
    "-frames:v",
    "1",
    "-vf",
    vf.join(","),
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();

/** Median of a 256-bin histogram holding `n` samples. */
function histMedian(hist: Uint32Array, n: number): number {
  const half = (n + 1) / 2;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= half) return v;
  }
  return 255;
}

/**
 * Pick the key colour from the border rings of `frames` (each a `w`×`h` rgb24
 * buffer). The dominant 4-bit-per-channel bucket wins (robust to a subject
 * touching one edge), then the per-channel MEDIAN of the pixels in and next to
 * that bucket gives the exact colour (robust to noise and bucket boundaries).
 */
export function analyzeBorder(frames: Buffer[], w: number, h: number, ring = RING): KeyColorDetection {
  const depthX = Math.max(1, Math.round(w * ring));
  const depthY = Math.max(1, Math.round(h * ring));
  const ringPx: number[] = []; // packed 0xRRGGBB
  for (const buf of frames) {
    if (buf.length < w * h * 3) continue;
    for (let y = 0; y < h; y++) {
      const edgeRow = y < depthY || y >= h - depthY;
      for (let x = 0; x < w; x++) {
        if (!edgeRow && x >= depthX && x < w - depthX) continue;
        const o = (y * w + x) * 3;
        ringPx.push((buf[o] << 16) | (buf[o + 1] << 8) | buf[o + 2]);
      }
    }
  }
  if (ringPx.length === 0) throw new Error("Couldn't read a frame to detect the key color from");

  // 1. Dominant coarse bucket.
  const buckets = new Uint32Array(4096);
  for (const p of ringPx) buckets[((p >> 20) << 8) | (((p >> 12) & 0xf) << 4) | ((p >> 4) & 0xf)]++;
  let best = 0;
  for (let i = 1; i < 4096; i++) if (buckets[i] > buckets[best]) best = i;
  const br = best >> 8;
  const bg = (best >> 4) & 0xf;
  const bb = best & 0xf;

  // 2. Per-channel median of pixels in that bucket or a neighbouring one.
  const hr = new Uint32Array(256);
  const hg = new Uint32Array(256);
  const hb = new Uint32Array(256);
  let n = 0;
  for (const p of ringPx) {
    const r = p >> 16;
    const g = (p >> 8) & 0xff;
    const b = p & 0xff;
    if (Math.abs((r >> 4) - br) > 1 || Math.abs((g >> 4) - bg) > 1 || Math.abs((b >> 4) - bb) > 1) continue;
    hr[r]++;
    hg[g]++;
    hb[b]++;
    n++;
  }
  const rgb = { r: histMedian(hr, n), g: histMedian(hg, n), b: histMedian(hb, n) };

  // 3. Confidence: share of the whole ring within MATCH_DIST (colorkey metric).
  const lim = MATCH_DIST * MATCH_DIST * 255 * 255 * 3;
  let close = 0;
  for (const p of ringPx) {
    const dr = (p >> 16) - rgb.r;
    const dg = ((p >> 8) & 0xff) - rgb.g;
    const db = (p & 0xff) - rgb.b;
    if (dr * dr + dg * dg + db * db <= lim) close++;
  }
  return {
    color: `0x${hex2(rgb.r)}${hex2(rgb.g)}${hex2(rgb.b)}`,
    confidence: Math.round((close / ringPx.length) * 1000) / 1000,
    rgb,
  };
}

/**
 * Detect the key (background) colour of `path` from frames at `times`
 * (seconds), after an optional source crop — the region the key will see.
 */
export async function detectKeyColor(path: string, times: number[], crop?: CropRect, color?: SourceColor): Promise<KeyColorDetection> {
  const frames = await Promise.all(times.map((t) => grabGrid(path, t, crop, color).catch(() => Buffer.alloc(0))));
  return analyzeBorder(frames, GRID, GRID);
}
