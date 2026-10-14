/**
 * Blend modes + shape masks smoke test. Synthesizes all of its media (lossless
 * PNG stills and an FFV1 yuva420p clip — no downloads) and exports LOSSLESSLY
 * (x264 CRF 0) on a 640×360 canvas, so pixel checks see the compositing math,
 * not codec noise:
 *
 *   a. BLEND MODES: a gray-band V2 still over a colour-band V1 still, one V2
 *      clip per mode (plus four at opacity 0.6). Every flat cell of every mode
 *      must match the W3C formula applied to the DECODED V1-alone / V2-alone
 *      exports (±2-level input slack propagated through the formula, +3 levels),
 *      add = min(1, base + α·layer) like the canvas's "lighter". The max
 *      deviation per mode is printed. "normal" set then reset must be
 *      byte-identical (framemd5) to an export that never had a blend mode, and
 *      graph.ts must build the same args for blendMode "normal" and none.
 *   b. MASKS on an upper-track clip: ellipse / rect (+roundness) / linear /
 *      mirror, invert (letterbox padding stays transparent), a feathered
 *      linear edge sampled across the band against the Gaussian profile, the
 *      mask following a transform (scale 0.5 + position) and a rotation, a
 *      mask on a keyed clip (multiplies, doesn't un-key), on an FFV1 yuva420p
 *      alpha source (remove_background-style cutout), on an adjustment layer,
 *      blend + mask together, segment-cache invalidation when the mask
 *      changes, undo, validation/clamping and transition runs.
 *   d. BLEND EDGE CASES: `add` leaves frames before the layer byte-identical
 *      (and the picture outside the layer untouched); a multiply clip's white
 *      text stays white (only the picture blends); a follower-only segment
 *      re-renders when the run lead's mode is cleared.
 *
 * Run: npx tsx packages/core/scripts/smoke-masks.ts
 */
import { execa } from "execa";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readdirSync } from "node:fs";
import { EditorEngine } from "../src/engine.js";
import { dispatch } from "../src/rpc.js";
import { FFMPEG_BIN } from "../src/ffmpeg/executor.js";
import { buildRenderCommand, EXPORT_PROFILE } from "../src/ffmpeg/graph.js";
import { rasterizeMask, maskFileName } from "../src/ffmpeg/mask.js";
import { BLEND_MODES, fitPictureRect, normalizeMask, type BlendMode } from "../src/effects/compositing.js";
import type { ResolvedRenderClip } from "../src/types.js";

const FPS = 30;
const W = 640;
const H = 360;
type RGB = [number, number, number];

let failures = 0;
function check(cond: boolean, name: string, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function ff(args: string[], input?: Buffer): Promise<Buffer> {
  const { stdout } = await execa(FFMPEG_BIN, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    reject: true,
    encoding: "buffer",
    input,
  });
  return stdout as unknown as Buffer;
}

/** Write an RGBA still (PNG) from a per-pixel function. */
async function still(out: string, w: number, h: number, fill: (x: number, y: number) => [number, number, number, number?]) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fill(x, y);
      buf.set([r, g, b, a ?? 255], (y * w + x) * 4);
    }
  }
  await ff(["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-i", "-", "-frames:v", "1", out], buf);
}

/** Decode one frame (RGB24) at `t` seconds. */
async function frame(file: string, t: number): Promise<Buffer> {
  return ff(["-ss", t.toFixed(4), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
}

/** Mean RGB of a (2r+1)² block centred on (x, y). */
function px(buf: Buffer, x: number, y: number, r = 2): RGB {
  const acc = [0, 0, 0];
  let n = 0;
  for (let yy = y - r; yy <= y + r; yy++) {
    for (let xx = x - r; xx <= x + r; xx++) {
      const i = (yy * W + xx) * 3;
      acc[0] += buf[i];
      acc[1] += buf[i + 1];
      acc[2] += buf[i + 2];
      n++;
    }
  }
  return acc.map((v) => Math.round(v / n)) as RGB;
}

const near = (a: RGB, b: RGB, tol: number) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const fmt = (p: RGB) => `rgb(${p.join(",")})`;

const RED: RGB = [255, 0, 0];
const BLUE: RGB = [0, 0, 255];
const LOSSLESS = { quality: 0 } as const;

async function exportAt(engine: EditorEngine, dir: string, name: string): Promise<string> {
  const out = join(dir, `${name}.mp4`);
  await engine.exportVideo(out, LOSSLESS);
  return out;
}

async function framemd5(file: string): Promise<string> {
  const out = await ff(["-i", file, "-map", "0:v", "-f", "framemd5", "-"]);
  // execa hands back a Uint8Array: decode it as text (one line per frame).
  return Buffer.from(out)
    .toString("utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .join("\n");
}

function clipById(engine: EditorEngine, id: string) {
  return engine.getProject().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
}

// ---- W3C reference formulas (0..1) ------------------------------------------------
const W3C: Record<Exclude<BlendMode, "normal" | "add">, (b: number, s: number) => number> = {
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  overlay: (b, s) => (b <= 0.5 ? s * 2 * b : 1 - (1 - s) * (1 - (2 * b - 1))),
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  "color-dodge": (b, s) => (b === 0 ? 0 : s === 1 ? 1 : Math.min(1, b / (1 - s))),
  "color-burn": (b, s) => (b === 1 ? 1 : s === 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  "hard-light": (b, s) => (s <= 0.5 ? b * 2 * s : 1 - (1 - b) * (1 - (2 * s - 1))),
  "soft-light": (b, s) => {
    if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
    return b + (2 * s - 1) * (d - b);
  },
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
};

/** Composited value (0..255) of one channel for a mode at layer alpha `a`. */
function composite(mode: BlendMode, b255: number, s255: number, a: number): number {
  const b = Math.min(255, Math.max(0, b255)) / 255;
  const s = Math.min(255, Math.max(0, s255)) / 255;
  if (mode === "normal") return 255 * ((1 - a) * b + a * s);
  if (mode === "add") return 255 * Math.min(1, b + a * s);
  const B = Math.min(1, Math.max(0, W3C[mode](b, s)));
  return 255 * ((1 - a) * b + a * B);
}

/** [min, max] of the composite over ±slack levels of input error. */
function refRange(mode: BlendMode, b: number, s: number, a: number, slack = 2): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let db = -slack; db <= slack; db++) {
    for (let ds = -slack; ds <= slack; ds++) {
      const v = composite(mode, b + db, s + ds, a);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  return [lo, hi];
}

// Base colours (V1 vertical bands) and layer grays (V2 horizontal bands).
const BASES: RGB[] = [
  [230, 40, 40], [40, 200, 60], [40, 60, 220], [240, 220, 60],
  [128, 128, 128], [20, 20, 20], [250, 250, 250], [200, 120, 180],
];
const GRAYS = [0, 40, 100, 160, 210, 255];
const BW = W / BASES.length; // 80
const GH = H / GRAYS.length; // 60

async function blendModes(dir: string) {
  console.log("a. blend modes (gray bands on V2 over colour bands on V1, lossless)...");
  const v1 = join(dir, "bands-color.png");
  const v2 = join(dir, "bands-gray.png");
  await still(v1, W, H, (x) => BASES[Math.floor(x / BW)]);
  await still(v2, W, H, (_x, y) => {
    const g = GRAYS[Math.floor(y / GH)];
    return [g, g, g];
  });

  const SEG = 8; // frames per V2 clip (18 clips stay inside a still's default 5 s)
  const cases: { mode: BlendMode; opacity: number }[] = [
    ...BLEND_MODES.map((mode) => ({ mode, opacity: 1 })),
    ...(["screen", "add", "soft-light", "color-dodge", "multiply"] as BlendMode[]).map((mode) => ({ mode, opacity: 0.6 })),
  ];
  const engine = new EditorEngine(join(dir, "blend"));
  engine.setProjectSettings({ width: W, height: H, fps: FPS, name: "blend" });
  const a1 = await engine.importVideo(v1);
  const a2 = await engine.importVideo(v2);
  check(!!a1.isImage && !!a2.isImage, "band stills import as image clips");
  engine.addClip(a1.id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: SEG * cases.length });
  const v2t = engine.addTrack("video", { name: "V2" });
  const ids: string[] = [];
  cases.forEach((_c, k) => {
    const clip = engine.addClip(a2.id, { trackIndex: v2t.index, startFrame: k * SEG, sourceInFrame: 0, sourceOutFrame: SEG });
    ids.push(clip.id);
  });
  for (let k = 0; k < cases.length; k++) {
    await dispatch(engine, "set_clip_blend_mode", { clipId: ids[k], mode: cases[k].mode });
    if (cases[k].opacity !== 1) await dispatch(engine, "set_clip_transform", { clipId: ids[k], opacity: cases[k].opacity });
  }
  check(clipById(engine, ids[0]).effects?.blendMode === undefined, "mode 'normal' is stored as no field");
  check(clipById(engine, ids[1]).effects?.blendMode === "multiply", "mode stored on the clip");
  const blended = await exportAt(engine, dir, "blended");

  // References: each layer alone through the same pipeline.
  const baseEng = new EditorEngine(join(dir, "base-only"));
  baseEng.setProjectSettings({ width: W, height: H, fps: FPS, name: "base" });
  baseEng.addClip((await baseEng.importVideo(v1)).id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: SEG });
  const baseFrame = await frame(await exportAt(baseEng, dir, "base-only"), 0.2);
  const layEng = new EditorEngine(join(dir, "layer-only"));
  layEng.setProjectSettings({ width: W, height: H, fps: FPS, name: "layer" });
  layEng.addClip((await layEng.importVideo(v2)).id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: SEG });
  const layerFrame = await frame(await exportAt(layEng, dir, "layer-only"), 0.2);

  const table: string[] = [];
  for (let k = 0; k < cases.length; k++) {
    const { mode, opacity } = cases[k];
    const f = await frame(blended, (k * SEG + SEG / 2) / FPS);
    let worst = 0; // max |export − formula(decoded inputs)|
    let outOfRange = 0;
    let worstDetail = "";
    let differsFromNormal = false;
    for (let i = 0; i < BASES.length; i++) {
      for (let j = 0; j < GRAYS.length; j++) {
        const cx = Math.round(i * BW + BW / 2);
        const cy = Math.round(j * GH + GH / 2);
        const got = px(f, cx, cy, 6);
        const b = px(baseFrame, cx, cy, 6);
        const s = px(layerFrame, cx, cy, 6);
        for (let c = 0; c < 3; c++) {
          const ref = composite(mode, b[c], s[c], opacity);
          const [lo, hi] = refRange(mode, b[c], s[c], opacity);
          const dev = Math.abs(got[c] - ref);
          if (dev > worst) {
            worst = dev;
            worstDetail = `base ${b[c]} layer ${s[c]} → ${got[c]} vs ${ref.toFixed(1)}`;
          }
          if (got[c] < lo - 3 || got[c] > hi + 3) outOfRange++;
          if (Math.abs(composite("normal", b[c], s[c], opacity) - ref) > 20 && Math.abs(got[c] - ref) < 6) differsFromNormal = true;
        }
      }
    }
    const label = `${mode}${opacity !== 1 ? ` @${opacity}` : ""}`;
    table.push(`${label.padEnd(18)} max dev ${worst.toFixed(1).padStart(5)}  (${worstDetail})`);
    check(outOfRange === 0, `${label}: all 48 cells match the reference formula`, `${outOfRange} channel(s) out of range; worst ${worstDetail}`);
    if (mode !== "normal") check(differsFromNormal, `${label}: visibly differs from normal layering`);
  }
  console.log("   export vs W3C formula on the decoded inputs (levels):");
  for (const line of table) console.log(`     ${line}`);

  // Normal stays byte-identical: an export that never had a blend mode vs one
  // that went multiply → normal.
  const plain = new EditorEngine(join(dir, "plain"));
  plain.setProjectSettings({ width: W, height: H, fps: FPS, name: "plain" });
  const p1 = await plain.importVideo(v1);
  const p2 = await plain.importVideo(v2);
  plain.addClip(p1.id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: SEG });
  const pt = plain.addTrack("video", { name: "V2" });
  const pc = plain.addClip(p2.id, { trackIndex: pt.index, startFrame: 0, sourceInFrame: 0, sourceOutFrame: SEG });
  await dispatch(plain, "set_clip_transform", { clipId: pc.id, opacity: 0.7 });
  const md5a = await framemd5(await exportAt(plain, dir, "plain-a"));
  await dispatch(plain, "set_clip_blend_mode", { clipId: pc.id, mode: "multiply" });
  const md5m = await framemd5(await exportAt(plain, dir, "plain-m"));
  await dispatch(plain, "set_clip_blend_mode", { clipId: pc.id, mode: "normal" });
  check(clipById(plain, pc.id).effects?.blendMode === undefined, "back to normal removes the field");
  const md5b = await framemd5(await exportAt(plain, dir, "plain-b"));
  check(md5a === md5b, "normal is byte-identical (framemd5) to an export that never had a blend mode");
  check(md5a !== md5m, "multiply changes the frames");

  // graph.ts: an explicit "normal" builds exactly the no-blend command.
  const rc = (blendMode?: BlendMode): ResolvedRenderClip[] => [
    { path: v1, trackIndex: 0, showVideo: true, startSec: 0, sourceIn: 0, sourceSpan: 1, isImage: true, outDuration: 1, hasAudio: false, muted: false },
    { path: v2, trackIndex: 1, showVideo: true, startSec: 0, sourceIn: 0, sourceSpan: 1, isImage: true, outDuration: 1, hasAudio: false, muted: false, effects: blendMode ? { blendMode } : {} },
  ];
  const argsNone = buildRenderCommand(rc(), { width: W, height: H, fps: FPS }, "/x.mp4", EXPORT_PROFILE).args;
  const argsNormal = buildRenderCommand(rc("normal"), { width: W, height: H, fps: FPS }, "/x.mp4", EXPORT_PROFILE).args;
  check(JSON.stringify(argsNone) === JSON.stringify(argsNormal), "graph.ts: blendMode 'normal' builds the same args as none");
}

/** A fresh engine: solid BLUE still on V1, `overlay` on V2 (1 s). */
async function masked(dir: string, name: string, overlay: string, blue: string) {
  const engine = new EditorEngine(join(dir, name));
  engine.setProjectSettings({ width: W, height: H, fps: FPS, name });
  const aBlue = await engine.importVideo(blue);
  const aOver = await engine.importVideo(overlay);
  engine.addClip(aBlue.id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: FPS });
  const v2 = engine.addTrack("video", { name: "V2" });
  const over = engine.addClip(aOver.id, { trackIndex: v2.index, startFrame: 0, sourceInFrame: 0, sourceOutFrame: aOver.isImage ? FPS : undefined });
  return { engine, overId: over.id };
}

/** Normal CDF. */
function phi(z: number): number {
  // Abramowitz–Stegun 7.1.26 erf approximation (|err| < 1.5e-7).
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

async function masks(dir: string) {
  console.log("b. shape masks on an upper-track clip...");
  const blue = join(dir, "blue.png");
  await still(blue, W, H, () => BLUE);
  // A SQUARE red picture: pillarboxed to 360×360 at x=140 in the 640×360 canvas.
  const redSq = join(dir, "red-square.png");
  await still(redSq, 480, 480, () => RED);
  const rect = fitPictureRect(480, 480, W, H);
  check(rect.x === 140 && rect.w === 360 && rect.h === 360, "square picture fits at x=140, 360×360", JSON.stringify(rect));
  const C: [number, number] = [320, 180];

  const { engine, overId } = await masked(dir, "masks", redSq, blue);
  const t = 0.5;
  const shot = async (name: string) => frame(await exportAt(engine, dir, name), t);
  const expect = (f: Buffer, x: number, y: number, want: RGB, label: string, tol = 12) => {
    const got = px(f, x, y, 1);
    check(near(got, want, tol), `${label}: ${fmt(got)} ≈ ${fmt(want)}`);
  };

  // Ellipse (circle on the square picture): radius 0.25 × 360 = 90 px.
  let r = (await dispatch(engine, "set_clip_mask", { clipId: overId, shape: "ellipse" })) as { mask: { w: number; h: number } };
  check(Math.abs(r.mask.w - 0.5) < 1e-6 && Math.abs(r.mask.h - 0.5) < 1e-6, "a new ellipse defaults to a centred circle half the short side", JSON.stringify(r.mask));
  const ellipseFile = await exportAt(engine, dir, "ellipse");
  let f = await frame(ellipseFile, t);
  expect(f, C[0], C[1], RED, "ellipse: centre shows V2");
  expect(f, C[0] + 70, C[1], RED, "ellipse: inside the radius");
  expect(f, C[0] + 110, C[1], BLUE, "ellipse: outside shows V1");
  expect(f, C[0] + 75, C[1] + 75, BLUE, "ellipse: the picture's corner is outside the circle");
  // The edge is anti-aliased: along the 45° diagonal some pixel is partly covered. Read in
  // the luma, which the 4:2:0 export keeps per pixel (a pixel's decoded red also carries its
  // 2×2 block's averaged colour, so it says more about the chroma filter than the mask).
  const luma = await ff(["-ss", t.toFixed(4), "-i", ellipseFile, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  const yIn = luma[C[1] * W + C[0]], yOut = luma[C[1] * W + C[0] + 110];
  const yLo = Math.min(yIn, yOut), ySpan = Math.abs(yIn - yOut);
  const diag = [60, 61, 62, 63, 64, 65, 66, 67].map((o) => luma[(C[1] + o) * W + C[0] + o]);
  check(ySpan > 10 && diag.some((v) => v > yLo + ySpan * 0.1 && v < yLo + ySpan * 0.9),
    `ellipse: the edge is anti-aliased (luma along the diagonal: ${diag.join(",")}; red inside ${yIn}, blue outside ${yOut})`);

  await dispatch(engine, "set_clip_mask", { clipId: overId, invert: true });
  f = await shot("ellipse-inv");
  expect(f, C[0], C[1], BLUE, "invert: centre shows V1");
  expect(f, C[0] + 120, C[1], RED, "invert: outside the circle shows V2");
  expect(f, 60, C[1], BLUE, "invert: the letterbox padding stays transparent");

  // Rounded rectangle.
  await dispatch(engine, "set_clip_mask", { clipId: overId, shape: "rect", invert: false, w: 0.6, h: 0.4, roundness: 0 });
  f = await shot("rect");
  expect(f, C[0] + 100, C[1] + 65, RED, "rect: near the corner, inside");
  expect(f, C[0] + 120, C[1], BLUE, "rect: right of it");
  expect(f, C[0], C[1] + 80, BLUE, "rect: below it");
  await dispatch(engine, "set_clip_mask", { clipId: overId, roundness: 1 });
  f = await shot("rect-round");
  expect(f, C[0] + 100, C[1] + 65, BLUE, "roundness 1: the corner is cut off");
  expect(f, C[0] + 100, C[1], RED, "roundness 1: the side is still inside");

  // Linear: keeps the side above the line at rotation 0; rotation 90 keeps the right.
  await dispatch(engine, "set_clip_mask", { clipId: overId, shape: "linear", roundness: 0, rotation: 0 });
  f = await shot("linear");
  expect(f, C[0], C[1] - 60, RED, "linear: above the line shows V2");
  expect(f, C[0], C[1] + 60, BLUE, "linear: below the line shows V1");
  await dispatch(engine, "set_clip_mask", { clipId: overId, rotation: 90 });
  f = await shot("linear-90");
  expect(f, C[0] + 60, C[1], RED, "linear @90°: the right side shows V2");
  expect(f, C[0] - 60, C[1], BLUE, "linear @90°: the left side shows V1");

  // Feathered linear: the band follows the Gaussian edge profile.
  await dispatch(engine, "set_clip_mask", { clipId: overId, rotation: 0, feather: 0.3 });
  f = await shot("linear-feather");
  const sigma = (0.3 * 360) / 2.5631;
  let prev = 256;
  let graded = true;
  for (const d of [-60, -30, -10, 0, 10, 30, 60]) {
    const got = px(f, C[0], C[1] + d, 1)[0];
    const want = 255 * phi(-(d + 0.5) / sigma);
    if (Math.abs(got - want) > 8) graded = false;
    if (got > prev + 2) graded = false;
    prev = got;
    console.log(`     feather profile d=${String(d).padStart(3)}px: red ${got} (Gaussian ${want.toFixed(1)})`);
  }
  check(graded, "feathered edge is graded like a Gaussian (±8 levels, monotonic)");

  // Mirror band.
  await dispatch(engine, "set_clip_mask", { clipId: overId, shape: "mirror", feather: 0, h: 0.25 });
  f = await shot("mirror");
  expect(f, C[0], C[1], RED, "mirror: inside the band");
  expect(f, C[0], C[1] - 65, BLUE, "mirror: above the band");
  expect(f, C[0], C[1] + 65, BLUE, "mirror: below the band");

  // The mask follows the transform: scale 0.5 + move right by a quarter canvas.
  await dispatch(engine, "set_clip_mask", { clipId: overId, shape: "ellipse", w: 0.5, h: 0.5 });
  await dispatch(engine, "set_clip_transform", { clipId: overId, scale: 0.5, x: 0.25 });
  f = await shot("follow");
  const P: [number, number] = [C[0] + 160, C[1]];
  expect(f, P[0], P[1], RED, "transformed: the circle moved with the picture");
  expect(f, P[0] + 35, P[1], RED, "transformed: inside the halved radius (45 px)");
  expect(f, P[0] + 60, P[1], BLUE, "transformed: outside the halved radius, inside the picture");
  expect(f, C[0], C[1], BLUE, "transformed: nothing left at the old centre");
  // The slow per-pixel transform path (animated scale/opacity) applies the mask
  // the same way: force it and compare.
  process.env.AIVE_TRANSFORM_GEQ = "1";
  const fGeq = await shot("follow-geq");
  delete process.env.AIVE_TRANSFORM_GEQ;
  let geqSame = true;
  for (const [x, y] of [[P[0], P[1]], [P[0] + 35, P[1]], [P[0] + 60, P[1]], [C[0], C[1]], [P[0], P[1] + 40]] as const) {
    if (!near(px(f, x, y, 1), px(fGeq, x, y, 1), 24)) geqSame = false;
  }
  check(geqSame, "the geq transform path masks like the fast path");

  // Rotation: a wide rect mask + clip rotation 90° = a vertical band; the same
  // as the mask's own rotation 90°.
  await dispatch(engine, "set_clip_transform", { clipId: overId, scale: 1, x: 0, rotation: 90 });
  await dispatch(engine, "set_clip_mask", { clipId: overId, shape: "rect", w: 0.8, h: 0.2, rotation: 0 });
  const fRotClip = await shot("rot-clip");
  expect(fRotClip, C[0], C[1] - 120, RED, "clip rotated 90°: the band is vertical (above centre)");
  expect(fRotClip, C[0] + 60, C[1], BLUE, "clip rotated 90°: beside the band");
  await dispatch(engine, "set_clip_transform", { clipId: overId, rotation: 0 });
  await dispatch(engine, "set_clip_mask", { clipId: overId, rotation: 90 });
  const fRotMask = await shot("rot-mask");
  expect(fRotMask, C[0], C[1] - 120, RED, "mask rotated 90°: the same vertical band");
  let same = true;
  for (const [x, y] of [[320, 60], [320, 300], [380, 180], [260, 180], [340, 100]] as const) {
    if (!near(px(fRotClip, x, y, 1), px(fRotMask, x, y, 1), 6)) same = false;
  }
  check(same, "clip rotation 90° and mask rotation 90° give the same picture (square clip)");

  // Blend + mask: screen inside a circle (red screen blue = magenta).
  await dispatch(engine, "set_clip_mask", { clipId: overId, shape: "ellipse", w: 0.5, h: 0.5, rotation: 0 });
  await dispatch(engine, "set_clip_blend_mode", { clipId: overId, mode: "screen" });
  f = await shot("blend-mask");
  expect(f, C[0], C[1], [255, 0, 255], "screen + mask: magenta inside the circle");
  expect(f, C[0] + 120, C[1], BLUE, "screen + mask: untouched V1 outside");

  // Cache: the segment key covers the mask (render_frame's segment path).
  console.log("   segment cache...");
  const before = { ...engine.renderStats };
  const g1 = await engine.renderFrame(t);
  const p1 = px(await ff(["-i", g1, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]), C[0] + 70, C[1], 0);
  await dispatch(engine, "set_clip_mask", { clipId: overId, w: 0.2, h: 0.2 });
  const g2 = await engine.renderFrame(t);
  const p2 = px(await ff(["-i", g2, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]), C[0] + 70, C[1], 0);
  check(engine.renderStats.segmentRenders === before.segmentRenders + 2, "a mask change re-renders the segment", JSON.stringify(engine.renderStats));
  check(p1[0] > 200 && p2[0] < 60, `the re-render shows the new mask (${fmt(p1)} → ${fmt(p2)})`);
  await dispatch(engine, "set_clip_mask", { clipId: overId, w: 0.5, h: 0.5 });
  await engine.renderFrame(t);
  check(engine.renderStats.segmentCacheHits === before.segmentCacheHits + 1, "restoring the mask hits the cache", JSON.stringify(engine.renderStats));
  const maskFiles = readdirSync(join(dir, "masks", "masks")).filter((n) => n.endsWith(".png"));
  check(maskFiles.length >= 2 && maskFiles.every((n) => /^mask-[0-9a-f]{24}\.png$/.test(n)), `masks are hash-named PNGs in <dataDir>/masks (${maskFiles.length})`);

  // Undo: one step each.
  const fxBefore = JSON.stringify(clipById(engine, overId).effects);
  await dispatch(engine, "set_clip_mask", { clipId: overId, shape: null });
  check(clipById(engine, overId).effects?.mask === undefined, "shape null removes the mask");
  engine.undo();
  check(JSON.stringify(clipById(engine, overId).effects) === fxBefore, "undo restores the mask (one step)");
  await dispatch(engine, "set_clip_blend_mode", { clipId: overId, mode: "multiply" });
  engine.undo();
  check(clipById(engine, overId).effects?.blendMode === "screen", "undo restores the blend mode (one step)");

  // Validation / clamping.
  r = (await dispatch(engine, "set_clip_mask", { clipId: overId, feather: 5, w: -1, rotation: 270 })) as never;
  const m = (r as unknown as { mask: { feather: number; w: number; rotation: number } }).mask;
  check(m.feather === 1 && m.w === 0.01 && m.rotation === -90, "values are clamped / wrapped", JSON.stringify(m));
  const adj = engine.addAdjustmentClip({ startFrame: 0, durationFrames: FPS });
  let threw = "";
  try {
    await dispatch(engine, "set_clip_blend_mode", { clipId: adj.id, mode: "screen" });
  } catch (e) {
    threw = String(e);
  }
  check(/ADJUSTMENT/.test(threw), "a blend mode on an adjustment layer is refused with a teaching error", threw.slice(0, 120));
  threw = "";
  try {
    await dispatch(engine, "set_clip_blend_mode", { clipId: overId, mode: "glow" });
  } catch (e) {
    threw = String(e);
  }
  check(threw !== "", "an unknown blend mode is rejected by the schema");
}

async function keyedAndAlpha(dir: string) {
  console.log("c. masks on a keyed clip, an alpha (FFV1 yuva420p) clip and an adjustment layer...");
  const blue = join(dir, "blue.png");
  const t = 0.5;
  const expect = (f: Buffer, x: number, y: number, want: RGB, label: string, tol = 14) => {
    const got = px(f, x, y, 1);
    check(near(got, want, tol), `${label}: ${fmt(got)} ≈ ${fmt(want)}`);
  };

  // Green screen with a red box (200..440 × 100..260) keyed, then a left-half mask.
  const green = join(dir, "green-box.png");
  await still(green, W, H, (x, y) => (x >= 200 && x < 440 && y >= 100 && y < 260 ? RED : [0, 255, 0]));
  const K = await masked(dir, "keyed", green, blue);
  await dispatch(K.engine, "apply_effect", { clipId: K.overId, type: "colorkey", color: "0x00FF00" });
  await dispatch(K.engine, "set_clip_mask", { clipId: K.overId, shape: "rect", x: 0.25, y: 0.5, w: 0.5, h: 1 });
  let f = await frame(await exportAt(K.engine, dir, "keyed"), t);
  expect(f, 260, 180, RED, "keyed + mask: box inside the mask shows");
  expect(f, 100, 50, BLUE, "keyed + mask: keyed green inside the mask stays transparent (multiplied, not overwritten)");
  expect(f, 400, 180, BLUE, "keyed + mask: box outside the mask is hidden");

  // FFV1 yuva420p cutout: a red disc (r=120) on transparency, like remove_background's output.
  const cut = join(dir, "cutout.mkv");
  await ff([
    "-f", "lavfi", "-i", `color=c=red:s=${W}x${H}:r=${FPS}:d=1,format=rgba,geq=r='255':g='0':b='0':a='if(lte(hypot(X-320,Y-180),120),255,0)'`,
    "-c:v", "ffv1", "-pix_fmt", "yuva420p", cut,
  ]);
  const A = await masked(dir, "alpha", cut, blue);
  await dispatch(A.engine, "set_clip_mask", { clipId: A.overId, shape: "linear", y: 0.5 });
  f = await frame(await exportAt(A.engine, dir, "alpha"), t);
  expect(f, 320, 120, RED, "alpha source + mask: disc above the line shows");
  expect(f, 320, 240, BLUE, "alpha source + mask: disc below the line is masked");
  expect(f, 40, 40, BLUE, "alpha source + mask: transparent area above the line stays transparent");
  await dispatch(A.engine, "set_clip_mask", { clipId: A.overId, invert: true });
  f = await frame(await exportAt(A.engine, dir, "alpha-inv"), t);
  expect(f, 320, 240, RED, "alpha source + inverted mask: disc below the line shows");
  expect(f, 40, 320, BLUE, "alpha source + inverted mask: transparency kept below the line");

  // Adjustment layer: black & white limited to the left half.
  const bands = join(dir, "bands-color.png");
  const J = new EditorEngine(join(dir, "adjust"));
  J.setProjectSettings({ width: W, height: H, fps: FPS, name: "adjust" });
  J.addClip((await J.importVideo(bands)).id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: FPS });
  J.addTrack("video", { name: "V2" });
  const adj = J.addAdjustmentClip({ startFrame: 0, durationFrames: FPS });
  await dispatch(J, "apply_effect", { clipId: adj.id, type: "grayscale" });
  await dispatch(J, "set_clip_mask", { clipId: adj.id, shape: "rect", x: 0.25, y: 0.5, w: 0.5, h: 1 });
  f = await frame(await exportAt(J, dir, "adjust"), t);
  const left = px(f, 40, 180, 2); // red band, inside the mask → gray
  const right = px(f, 600, 180, 2); // last band (200,120,180), outside → colour
  check(Math.max(...left) - Math.min(...left) < 12, `adjustment mask: inside is black & white (${fmt(left)})`);
  check(Math.max(...right) - Math.min(...right) > 40, `adjustment mask: outside keeps its colour (${fmt(right)})`);

  // Transition run: setting the mode on the incoming clip changes the whole run.
  const T = await masked(dir, "run", join(dir, "red-square.png"), blue);
  const v2Index = T.engine.getProject().tracks.find((tr) => tr.clips.some((c) => c.id === T.overId))!.index;
  const second = T.engine.addClip(T.engine.getProject().assets[1].id, { trackIndex: v2Index, startFrame: FPS - 10, sourceInFrame: 0, sourceOutFrame: FPS });
  T.engine.setTransition(second.id, "fade", 10);
  const res = (await dispatch(T.engine, "set_clip_blend_mode", { clipId: second.id, mode: "multiply" })) as { clipIds: string[] };
  check(res.clipIds.length === 2 && clipById(T.engine, T.overId).effects?.blendMode === "multiply", "a transition run shares one blend mode", JSON.stringify(res.clipIds));

  // Determinism: the rasterizer is pure (same bytes twice), names hash the inputs.
  const spec = { mask: normalizeMask({ shape: "ellipse", feather: 0.2, w: 0.4, h: 0.3, rotation: 30 }), W, H, rect: { x: 0, y: 0, w: W, h: H } };
  check(Buffer.from(rasterizeMask(spec)).equals(Buffer.from(rasterizeMask(spec))), "mask rasterizer is deterministic");
  check(maskFileName(spec) !== maskFileName({ ...spec, W: 1280, H: 720, rect: { x: 0, y: 0, w: 1280, h: 720 } }), "mask file names differ per render canvas");
}

/**
 * d. Blend edge cases: `add` leaves the picture untouched outside the layer
 * (no RGB round trip of the whole stack), a blended clip's own text stays
 * unblended (as the preview draws it), and a follower-only segment re-renders
 * when its run lead's mode changes (segment-cache key).
 */
async function blendEdges(dir: string) {
  console.log("d. blend edge cases (add outside the layer, text on a blended clip, run mode in the cache key)...");
  const bands = join(dir, "bands-color.png");
  const gray = join(dir, "gray-pip.png");
  await still(gray, W, H, () => [64, 64, 64]);
  // A small gray PiP in the LAST 10 frames only, top-left, over colour bands.
  const pip = async (mode?: BlendMode) => {
    const e = new EditorEngine(join(dir, `add-${mode ?? "none"}`));
    e.setProjectSettings({ width: W, height: H, fps: FPS, name: "add" });
    e.addClip((await e.importVideo(bands)).id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: FPS });
    const v2 = e.addTrack("video", { name: "V2" });
    const p = e.addClip((await e.importVideo(gray)).id, { trackIndex: v2.index, startFrame: FPS - 10, sourceInFrame: 0, sourceOutFrame: 10 });
    await dispatch(e, "set_clip_transform", { clipId: p.id, scale: 0.2, x: -0.4, y: -0.4 });
    if (mode) await dispatch(e, "set_clip_blend_mode", { clipId: p.id, mode });
    return exportAt(e, dir, `add-${mode ?? "none"}`);
  };
  const plainFile = await pip();
  const addFile = await pip("add");
  const md5Plain = (await framemd5(plainFile)).split("\n");
  const md5Add = (await framemd5(addFile)).split("\n");
  const before = FPS - 10;
  check(
    md5Plain.slice(0, before).join() === md5Add.slice(0, before).join() && md5Plain.length === md5Add.length,
    `add: the ${before} frames before the layer are byte-identical to an export without it`,
  );
  const fp = await frame(plainFile, (FPS - 4) / FPS);
  const fa = await frame(addFile, (FPS - 4) / FPS);
  let outside = 0;
  for (let y = 120; y < H; y += 8) for (let x = 0; x < W; x += 8) if (!near(px(fp, x + 3, y + 3, 1), px(fa, x + 3, y + 3, 1), 0)) outside++;
  check(outside === 0, "add: inside the window, the picture outside the PiP is untouched", `${outside} blocks differ`);
  const inPip = px(fa, 64, 36, 3);
  const wantPip = BASES[0].map((b) => Math.round(composite("add", b, 64, 1))) as RGB;
  check(near(inPip, wantPip, 4), `add: inside the PiP the layer adds light (${fmt(BASES[0])} + 64 → ${fmt(inPip)} ≈ ${fmt(wantPip)})`);

  // Text on a MULTIPLY clip: white text stays white (only the picture blends).
  const blue = join(dir, "blue.png");
  const white = join(dir, "white.png");
  await still(white, W, H, () => [255, 255, 255]);
  const T = await masked(dir, "text-blend", white, blue);
  T.engine.addTextOverlay(T.overId, { text: "HELLO WORLD", position: "center", fontSize: 72, color: "white", outlineWidth: 0, shadowY: 0 } as never);
  await dispatch(T.engine, "set_clip_blend_mode", { clipId: T.overId, mode: "multiply" });
  const ft = await frame(await exportAt(T.engine, dir, "text-blend"), 0.5);
  let brightest: RGB = [0, 0, 0];
  for (let y = 150; y < 210; y++) for (let x = 160; x < 480; x++) {
    const p = px(ft, x, y, 0);
    if (p[0] + p[1] + p[2] > brightest[0] + brightest[1] + brightest[2]) brightest = p;
  }
  check(brightest.every((v) => v >= 245), `multiply clip: its white text stays white (${fmt(brightest)})`);
  check(near(px(ft, 20, 20, 2), BLUE, 12), `multiply clip: white × blue picture = blue (${fmt(px(ft, 20, 20, 2))})`);

  // Run mode in the segment cache: a frame covered only by the FOLLOWER must
  // re-render when the LEAD's mode changes (clear_clip_effects on the lead).
  const red = join(dir, "red.png");
  await still(red, W, H, () => RED);
  const R = new EditorEngine(join(dir, "run-cache"));
  R.setProjectSettings({ width: W, height: H, fps: FPS, name: "run-cache" });
  const rb = await R.importVideo(blue);
  const rr = await R.importVideo(red);
  R.addClip(rb.id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: 5 * FPS });
  const rv2 = R.addTrack("video", { name: "V2" });
  const lead = R.addClip(rr.id, { trackIndex: rv2.index, startFrame: 0, sourceInFrame: 0, sourceOutFrame: 2 * FPS });
  const follower = R.addClip(rr.id, { trackIndex: rv2.index, startFrame: 2 * FPS - 10, sourceInFrame: 0, sourceOutFrame: 70 });
  R.setTransition(follower.id, "fade", 10);
  await dispatch(R, "set_clip_blend_mode", { clipId: lead.id, mode: "screen" });
  const shotAt = async (t: number) => px(await ff(["-i", await R.renderFrame(t), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]), 320, 180, 0);
  const s1 = await shotAt(3);
  check(near(s1, [255, 0, 255], 8), `run: screen red over blue = magenta under the follower (${fmt(s1)})`);
  await dispatch(R, "clear_clip_effects", { clipId: lead.id });
  const statsBefore = { ...R.renderStats };
  const s2 = await shotAt(3);
  check(R.renderStats.segmentRenders === statsBefore.segmentRenders + 1, "run: clearing the lead's mode re-renders the follower's segment", JSON.stringify(R.renderStats));
  check(near(s2, RED, 8), `run: the follower now composites normal, like the lead (${fmt(s2)})`);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "synthcut-masks-"));
  console.log(`work dir: ${dir}`);
  await blendModes(dir);
  await masks(dir);
  await keyedAndAlpha(dir);
  await blendEdges(dir);
  if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nall blend-mode / mask checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
