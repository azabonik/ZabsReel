import { createHash } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  maskBlurGrid,
  maskGeometry,
  maskSignedDistance,
  type ClipMask,
  type PictureRect,
} from "../effects/compositing.js";

/**
 * Shape-mask rasterizer for the EXPORT. A clip's mask is rendered ONCE per
 * (shape params, canvas size, picture rect) to an 8-bit grayscale PNG under
 * <dataDir>/masks/ (white = keep), named by a hash of everything that defines
 * its pixels — so the file name alone keys the segment cache. graph.ts feeds it
 * as a still input and MULTIPLIES it into the clip's alpha.
 *
 * Pixels: anti-aliased hard shape (coverage from the signed distance), blurred
 * with a separable Gaussian for the feather (on a margin around the picture so
 * the blur sees the shape beyond the picture's edge; on a coarser grid for wide
 * feathers, then bilinear-upsampled — the same grid the preview uses, see
 * maskBlurGrid), inverted if asked, and finally CLIPPED to the picture rect:
 * the canvas outside the clip's own picture (letterbox padding) is always 0.
 * Pure JS math → deterministic output.
 */

/** Bump when the rasterizer's pixels change (part of every mask file name). */
const MASK_RENDER_VERSION = 1;

export interface MaskRenderSpec {
  mask: ClipMask;
  /** Canvas size (the per-clip stream is W×H). */
  W: number;
  H: number;
  /** The clip's fitted picture inside the canvas. */
  rect: PictureRect;
}

/** Deterministic file name for a mask render (hash of version + params + geometry). */
export function maskFileName(spec: MaskRenderSpec): string {
  const m = spec.mask;
  const payload = JSON.stringify({
    v: MASK_RENDER_VERSION,
    m: [m.shape, m.x, m.y, m.w, m.h, m.rotation, m.feather, m.roundness, m.invert ? 1 : 0],
    c: [spec.W, spec.H],
    r: [spec.rect.x, spec.rect.y, spec.rect.w, spec.rect.h],
  });
  return `mask-${createHash("sha1").update(payload).digest("hex").slice(0, 24)}.png`;
}

/** Separable Gaussian blur in place (clamp-to-edge), kernel radius ceil(3σ). */
function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const rad = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * rad + 1);
  let sum = 0;
  for (let i = -rad; i <= rad; i++) sum += k[i + rad] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -rad; i <= rad; i++) {
        const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i;
        acc += src[row + xx] * k[i + rad];
      }
      tmp[row + x] = acc;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -rad; i <= rad; i++) {
        const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
        acc += tmp[yy * w + x] * k[i + rad];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

const cover = (d: number): number => (d <= -0.5 ? 1 : d >= 0.5 ? 0 : 0.5 - d);

/** Rasterize a mask to W×H 8-bit gray (row-major), 255 = keep. */
export function rasterizeMask(spec: MaskRenderSpec): Uint8Array {
  const { W, H, rect } = spec;
  const out = new Uint8Array(W * H);
  const pw = rect.w;
  const ph = rect.h;
  if (pw <= 0 || ph <= 0) return out;
  const g = maskGeometry(spec.mask, pw, ph);
  const grid = maskBlurGrid(g.sigma);
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(W, rect.x + pw);
  const y1 = Math.min(H, rect.y + ph);

  let sample: (px: number, py: number) => number;
  if (grid.gridSigma <= 0) {
    // Hard shape: anti-aliased coverage straight from the signed distance.
    sample = (px, py) => cover(maskSignedDistance(g, px, py));
  } else {
    const s = grid.scale;
    const M = grid.margin;
    const gw = Math.max(2, Math.ceil((pw + 2 * M) * s));
    const gh = Math.max(2, Math.ceil((ph + 2 * M) * s));
    const hard = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++) {
      const py = -M + (j + 0.5) / s;
      for (let i = 0; i < gw; i++) {
        const px = -M + (i + 0.5) / s;
        // Coverage at the grid's resolution (distance measured in grid pixels).
        hard[j * gw + i] = cover(maskSignedDistance(g, px, py) * s);
      }
    }
    const blurred = gaussianBlur(hard, gw, gh, grid.gridSigma);
    sample = (px, py) => {
      const gx = Math.min(gw - 1, Math.max(0, (px + M) * s - 0.5));
      const gy = Math.min(gh - 1, Math.max(0, (py + M) * s - 0.5));
      const ix = Math.min(gw - 2, Math.floor(gx));
      const iy = Math.min(gh - 2, Math.floor(gy));
      const fx = gx - ix;
      const fy = gy - iy;
      const p = iy * gw + ix;
      const top = blurred[p] * (1 - fx) + blurred[p + 1] * fx;
      const bot = blurred[p + gw] * (1 - fx) + blurred[p + gw + 1] * fx;
      return top * (1 - fy) + bot * fy;
    };
  }

  for (let y = y0; y < y1; y++) {
    const py = y - rect.y + 0.5;
    for (let x = x0; x < x1; x++) {
      let v = sample(x - rect.x + 0.5, py);
      if (g.invert) v = 1 - v;
      out[y * W + x] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
  return out;
}

// ---- minimal PNG encoder (8-bit grayscale) --------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

/** Encode W×H 8-bit gray pixels as a PNG (color type 0, filter 0 per row). */
export function encodeGrayPng(w: number, h: number, px: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    raw.set(px.subarray(y * w, y * w + w), y * (w + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/**
 * Ensure the mask PNG for `spec` exists under `dir` (content-addressed by its
 * name, so an existing file is reused as-is) and return its absolute path.
 */
export async function ensureMaskFile(dir: string, spec: MaskRenderSpec): Promise<string> {
  const path = join(dir, maskFileName(spec));
  try {
    if ((await stat(path)).size > 0) return path;
  } catch {
    /* missing → render it */
  }
  await mkdir(dir, { recursive: true });
  const png = encodeGrayPng(spec.W, spec.H, rasterizeMask(spec));
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, png);
  await rename(tmp, path);
  return path;
}
