/**
 * Smoke: source colour interpretation and the export's colour encoding
 * (ffmpeg/colorspace.ts). Synthesises its own H.264 fixtures — flat colour
 * patches (100% / 75% bars, skin, sky, darks, greys) coded with a known
 * matrix and range, tagged or not — and checks, with real FFmpeg:
 *
 *  1. the reading rules (export = players; Chromium's own, measured), and the
 *     preview correction is null exactly where Chromium already agrees;
 *  2. probeAsset records each stream's colour description (and a JPEG file,
 *     which FFmpeg's image2 demuxer gives one frame's duration, is a still);
 *  3. an export reads every source as players do and writes BT.709 limited
 *     range with all four tags: untagged HD (read as BT.709), BT.709-tagged
 *     HD, untagged HD VP9 (BT.601, as libvpx and Chromium read it),
 *     BT.601-tagged SD on its own canvas and pillarboxed on an HD canvas,
 *     full range, RGB and JPEG stills, all within a few levels of the true
 *     colours (at 6361c07:
 *     untagged HD 38 levels off, every BT.709 clip 41 — read back as players
 *     read an untagged HD file);
 *  3b. a plain clip at the canvas size exports its own 4:2:0 samples (no
 *     double chroma filtering at hard colour edges), and a crop with an odd
 *     offset or size cuts the decoded picture exactly;
 *  3c. a reverse, smooth slow-motion or stabilize bake (FFV1 cutouts too) is
 *     read as the clip it replaces (untagged, an HD bake was read as BT.709);
 *  3d. a motion graphic (Remotion's untagged BT.601) is retagged so, and an
 *     overlay's VP8 preview proxy is tagged so (untagged HD reads as BT.709);
 *  4. a project saved before assets carried colour info still exports right
 *     (the engine probes the file again), and the colour probed again reaches
 *     the asset (not as an edit): the preview corrects a partially tagged
 *     file and it gets its tagged proxy, as on import;
 *  5. the preview render (segments) and get_frame carry the same encoding;
 *  6. a freeze frame, a thumbnail and key-colour detection read the clip as
 *     the export does (at 6361c07 they decoded untagged HD as BT.601);
 *  7. preview proxies keep the source's reading with complete tags (a
 *     downscaled copy of untagged HD would otherwise be read as SD), and a
 *     file whose incomplete tags Chromium ignores gets one on import, as does
 *     untagged VP9 (Chromium 149+ reads it as BT.709, the export as BT.601);
 *  8. without AIVE_REMOTION_ADDON and without an installed graphics add-on,
 *     add_graphic refuses with graphics_addon_missing (3d's graphics are
 *     fixtures; graphics-addon-env.mjs defaults the variable otherwise).
 *
 * Run: npx tsx packages/core/scripts/smoke-colorspace.ts   (no arguments)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorEngine } from "../src/engine.js";
import { dispatch, RpcError } from "../src/rpc.js";
import { useDevAddon, useRemotionRenderer, withoutDevAddon } from "./graphics-addon-env.mjs";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { detectKeyColor } from "../src/media/keycolor.js";
import { graphicPreviewProxy, tagGraphicColor } from "../src/motion/render.js";
import {
  chromiumSourceColor, colorFixAffine, inputColorOpts, keepsChromaSamples, needsTaggedProxy, OUTPUT_YUV_STEP, previewColorFix, resolveSourceColor, SWS_CONVERT, SWS_RESIZE, type ProbedColor, type SourceColor,
} from "../src/ffmpeg/colorspace.js";

const dir = mkdtempSync(join(tmpdir(), "zedmix-colorspace-"));
let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};

const PATCH: [number, number, number][] = [
  [255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 255, 255], [255, 0, 255], [255, 255, 0], [255, 255, 255], [0, 0, 0],
  [191, 0, 0], [0, 191, 0], [0, 0, 191], [0, 191, 191], [191, 0, 191], [191, 191, 0], [191, 191, 191], [128, 128, 128],
  [224, 172, 105], [141, 85, 36], [100, 150, 220], [60, 120, 40], [255, 128, 0], [128, 0, 200], [0, 128, 128], [255, 105, 180],
  [40, 20, 10], [10, 30, 60], [16, 16, 16], [32, 32, 32], [64, 64, 64], [200, 40, 30], [192, 192, 192], [235, 235, 235],
];
const ff = (args: string[], input?: Buffer) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { input, maxBuffer: 1 << 28 });

/** A W×H PNG of the 8×4 patch grid. */
function patternPng(w: number, h: number): string {
  const b = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.set(PATCH[Math.floor((y * 4) / h) * 8 + Math.floor((x * 8) / w)], (y * w + x) * 3);
  const png = join(dir, `pat${w}x${h}.png`);
  ff(["-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-i", "-", "-frames:v", "1", png], b);
  return png;
}

/**
 * A setparams step that gives the frames exactly the tags of `tags` (the rest
 * unknown): FFmpeg 7+ encoders take their colour tags from the frames, over
 * the -colorspace / … options, and its scale tags what it converts.
 */
function framesTagged(tags: readonly string[]): string {
  const v = (opt: string) => (tags.includes(opt) ? tags[tags.indexOf(opt) + 1] : "unknown");
  return `setparams=colorspace=${v("-colorspace")}:color_primaries=${v("-color_primaries")}:color_trc=${v("-color_trc")}:range=${v("-color_range")}`;
}

/**
 * The encoders a fixture can be made with: H.264 .mp4, lossless VP9 .webm, a
 * cutout's FFV1 yuva420p .mkv or an overlay graphic's ProRes 4444 .mov (both
 * with opaque alpha).
 */
const CODECS: Record<string, { ext: string; args: string[]; pix?: string }> = {
  h264: { ext: "mp4", args: ["-c:v", "libx264", "-crf", "4"] },
  vp9: { ext: "webm", args: ["-c:v", "libvpx-vp9", "-lossless", "1", "-deadline", "realtime", "-cpu-used", "8"] },
  ffv1: { ext: "mkv", args: ["-c:v", "ffv1"], pix: "yuva420p" },
  prores: { ext: "mov", args: ["-c:v", "prores_ks", "-profile:v", "4444"], pix: "yuva444p10le" },
};

/** Encode the pattern coded with `matrix` / `range`, with the given tag options (and only those, on any FFmpeg). */
function fixture(name: string, w: number, h: number, matrix: string, range: "tv" | "pc", tags: string[], codec: "h264" | "vp9" | "ffv1" | "prores" = "h264"): string {
  const out = join(dir, `${name}.${CODECS[codec].ext}`);
  const pix = CODECS[codec].pix ?? (range === "pc" ? "yuvj420p" : "yuv420p");
  ff(["-y", "-loop", "1", "-framerate", "30", "-i", patternPng(w, h), "-t", "0.6",
    "-vf", `scale=out_color_matrix=${matrix}:out_range=${range}:flags=lanczos+accurate_rnd+full_chroma_int,format=${pix},${framesTagged(tags)}`,
    ...CODECS[codec].args, "-pix_fmt", pix, ...tags, out]);
  return out;
}
const ALL709 = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];
const ALL601 = ["-colorspace", "smpte170m", "-color_primaries", "smpte170m", "-color_trc", "smpte170m"];

/** Patch-centre colours of a decoded frame (6×6 averages), inside `rect` (default: the whole frame). */
function patches(file: string, vf: string, rect?: { x: number; y: number; w: number; h: number }, at = 0.3): number[][] {
  const [W, H] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file])
    .toString().trim().split(",").map(Number);
  const isStill = /\.(png|jpe?g)$/i.test(file);
  const buf = ff([...(isStill ? [] : ["-ss", String(at)]), "-i", file, "-frames:v", "1", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const r = rect ?? { x: 0, y: 0, w: W, h: H };
  const out: number[][] = [];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 8; col++) {
    const cx = r.x + Math.floor(((col + 0.5) * r.w) / 8), cy = r.y + Math.floor(((row + 0.5) * r.h) / 4);
    const acc = [0, 0, 0];
    for (let y = cy - 3; y < cy + 3; y++) for (let x = cx - 3; x < cx + 3; x++) for (let c = 0; c < 3; c++) acc[c] += buf[(y * W + x) * 3 + c];
    out.push(acc.map((v) => v / 36));
  }
  return out;
}
const asRead = (c: SourceColor) => `scale=in_color_matrix=${c.matrix}:in_range=${c.range}:flags=bilinear+accurate_rnd+full_chroma_int,format=rgb24`;
const AS_709 = asRead({ matrix: "bt709", range: "tv" });
/** Max per-channel error of patch colours against the true pattern. */
const maxErr = (got: number[][]) => Math.round(Math.max(...got.flatMap((p, i) => p.map((v, c) => Math.abs(v - PATCH[i][c])))) * 10) / 10;
const tagsOf = (file: string) => execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
  "stream=color_space,color_range,color_primaries,color_transfer", "-of", "default=nw=1", file]).toString().trim().replace(/\n/g, " ");
const tagged709 = (file: string) => {
  const t = tagsOf(file);
  return /color_range=tv/.test(t) && /color_space=bt709/.test(t) && /color_transfer=bt709/.test(t) && /color_primaries=bt709/.test(t);
};

async function exportOf(src: string, w: number, h: number, edit?: (e: EditorEngine, clipId: string) => Promise<void> | void): Promise<{ out: string; engine: EditorEngine; clipId: string; assetId: string }> {
  const engine = new EditorEngine(mkdtempSync(join(dir, "data-")));
  engine.setProjectSettings({ width: w, height: h, fps: 30 });
  const asset = await engine.importVideo(src);
  const clip = engine.appendClip(asset.id);
  if (edit) await edit(engine, clip.id);
  const out = join(dir, `export-${Math.random().toString(36).slice(2, 8)}.mp4`);
  await engine.exportVideo(out);
  return { out, engine, clipId: clip.id, assetId: asset.id };
}

async function main() {
  // ---- 1. rules ------------------------------------------------------------------------
  console.log("1. reading rules (export = players; Chromium as measured on 143)...");
  const c = (space?: string, range?: string, prim?: string, trc?: string): ProbedColor => ({ space, range, primaries: prim, transfer: trc });
  const same = (a: SourceColor, m: string, r: string) => a.matrix === m && a.range === r;
  check(same(resolveSourceColor(c(), 1080), "bt709", "tv") && same(resolveSourceColor(c(), 720), "bt709", "tv"), "untagged HD (≥ 720 lines) → BT.709 limited");
  check(same(resolveSourceColor(c(), 480), "bt601", "tv"), "untagged SD → BT.601");
  check(same(resolveSourceColor(c("bt709"), 480), "bt709", "tv") && same(resolveSourceColor(c("smpte170m"), 1080), "bt601", "tv"), "a matrix tag wins over the size guess");
  check(same(resolveSourceColor(c(undefined, "pc"), 1080), "bt601", "pc"), "full range without a matrix → JPEG's BT.601 full");
  check(same(resolveSourceColor(c("bt470bg", "pc"), 1080), "bt601", "pc"), "full range honoured with its matrix");
  check(same(resolveSourceColor(c(), 1080, "vp9"), "bt601", "tv"), "untagged VP9 → BT.601 (libvpx / Chromium)");
  check(same(chromiumSourceColor(c(), 1080, "vp9"), "bt601", "tv") && same(chromiumSourceColor(c(), 1080, "vp9", 148), "bt601", "tv") &&
    same(chromiumSourceColor(c(), 360, "vp9", 149), "bt709", "tv"), "Chromium reads untagged VP9 as BT.601 up to 148 (Electron 42), BT.709 from 149 (parity-gl measures it)");
  check(same(resolveSourceColor({ codedHeight: 1080 }, 1920), "bt709", "tv") && same(resolveSourceColor({ codedHeight: 480 }, 854), "bt601", "tv"),
    "the guess uses the CODED height (a rotated clip's own)");
  check(same(chromiumSourceColor(c("smpte170m"), 1080), "bt709", "tv") && same(chromiumSourceColor(c("bt470bg", "pc"), 1080), "bt709", "tv"),
    "Chromium ignores an incomplete description (matrix and range)");
  check(same(chromiumSourceColor(c("bt709", "pc", "bt709", "bt709"), 1080), "bt709", "pc"), "Chromium honours a complete one, full range included");
  check(keepsChromaSamples(undefined) && keepsChromaSamples({ filters: [{ type: "blur" }, { type: "chromakey", enabled: false }], transform: { scale: 0.6 } }),
    "a clip read at its own size keeps its chroma samples, effects / a bypassed key / a downscale included");
  check(!keepsChromaSamples({ filters: [{ type: "chromakey" }] }) && !keepsChromaSamples({ filters: [{ type: "lumakey" }] }) &&
    !keepsChromaSamples({ transform: { scale: 1.5 } }) && !keepsChromaSamples({ keyframes: { scale: [{}] } }),
    "…but a key or a zoom (static scale > 1, any keyframed scale) reads them interpolated");
  check(colorFixAffine({ matrix: "bt709", range: "tv" }, { matrix: "bt709", range: "tv" }) === null, "no correction between equal readings");
  const fix = colorFixAffine({ matrix: "bt709", range: "tv" }, { matrix: "bt601", range: "tv" })!;
  // Grey stays grey under any matrix change.
  const grey = fix.map((r) => r[0] * 128 + r[1] * 128 + r[2] * 128 + r[3]);
  check(grey.every((v) => Math.abs(v - 128) < 1e-6), "the correction keeps neutral grey");
  const asset = (color: ProbedColor, h = 720) => ({ color, width: Math.round((h * 16) / 9), height: h });
  check(previewColorFix(asset({ codedHeight: 720 }), false) === null && previewColorFix(asset({ ...c("bt709", "tv", "bt709", "bt709"), codedHeight: 720 }), false) === null,
    "preview correction: none for untagged / completely tagged files");
  check(previewColorFix(asset({ ...c("smpte170m", "tv"), codedHeight: 720 }), false) !== null, "preview correction: present for a partially tagged file");
  check(previewColorFix({ ...asset({ ...c("smpte170m", "tv"), codedHeight: 720 }), proxyColor: { ...c("smpte170m", "tv", "smpte170m", "smpte170m"), codedHeight: 360 } }, true) === null,
    "…and none for its completely tagged proxy");

  // ---- fixtures ---------------------------------------------------------------------------
  const untagHD = fixture("untagged-hd", 1280, 720, "bt709", "tv", []);
  const tag709 = fixture("bt709-hd", 1280, 720, "bt709", "tv", [...ALL709, "-color_range", "tv"]);
  const tag601HD = fixture("bt601-hd", 1280, 720, "bt601", "tv", [...ALL601, "-color_range", "tv"]);
  const sd601 = fixture("bt601-sd", 720, 480, "bt601", "tv", [...ALL601, "-color_range", "tv"]);
  const full709 = fixture("full-bt709", 1280, 720, "bt709", "pc", [...ALL709, "-color_range", "pc"]);
  const partial = fixture("partial-601-hd", 1280, 720, "bt601", "tv", ["-colorspace", "smpte170m"]);
  // Untagged VP9 is BT.601 at any size (libvpx's default; Chromium reads it so): an HD one would be BT.709 by size.
  const vp9HD = fixture("untagged-vp9-hd", 1280, 720, "bt601", "tv", [], "vp9");
  // Stills: an RGB PNG (no matrix at all) and a JPEG (BT.601 full range, as every image decoder reads it).
  const png = patternPng(1280, 720);
  const jpg = join(dir, "still.jpg");
  ff(["-y", "-i", png, "-q:v", "1", jpg]);

  // ---- 2. probe ---------------------------------------------------------------------------
  console.log("2. probeAsset records the colour description...");
  const pu = await probeAsset(untagHD);
  const pt = await probeAsset(tag709);
  const pf = await probeAsset(full709);
  check(!!pu.color && pu.color.space === undefined && pu.color.codedHeight === 720, `untagged: no matrix, coded height 720 (${JSON.stringify(pu.color)})`);
  check(pt.color?.space === "bt709" && pt.color.primaries === "bt709" && pt.color.transfer === "bt709" && pt.color.range === "tv", `BT.709: all four (${JSON.stringify(pt.color)})`);
  check(pf.color?.range === "pc", "full range recorded");
  const pv9 = await probeAsset(vp9HD);
  check(pv9.videoCodec === "vp9" && !!pv9.color && pv9.color.space === undefined && pv9.color.range !== "pc",
    `untagged VP9: codec vp9, no matrix (${pv9.videoCodec} ${JSON.stringify(pv9.color)})`);
  const pj = await probeAsset(jpg);
  check(pj.isImage === true && pj.duration === 5, `a JPEG file is a still (image2 reports one frame's duration): isImage ${pj.isImage}, ${pj.duration} s`);

  // ---- 3. exports -------------------------------------------------------------------------
  console.log("3. exports read sources like players and write tagged BT.709...");
  for (const [name, src, w, h, rect] of [
    ["untagged HD", untagHD, 1280, 720, undefined],
    ["BT.709-tagged HD", tag709, 1280, 720, undefined],
    ["BT.601-tagged HD", tag601HD, 1280, 720, undefined],
    ["untagged HD VP9 (read as BT.601)", vp9HD, 1280, 720, undefined],
    ["BT.601-tagged SD on its own canvas", sd601, 720, 480, undefined],
    ["BT.601-tagged SD pillarboxed on an HD canvas", sd601, 1280, 720, { x: 100, y: 0, w: 1080, h: 720 }],
    ["full range BT.709", full709, 1280, 720, undefined],
    ["RGB still (PNG)", png, 1280, 720, undefined],
    ["JPEG still", jpg, 1280, 720, undefined],
  ] as const) {
    const { out } = await exportOf(src, w, h);
    const err = maxErr(patches(out, AS_709, rect));
    check(tagged709(out), `${name}: export tagged BT.709 / limited, all four (${tagsOf(out)})`);
    check(err <= 4, `${name}: patches within 4 levels of the true colours, read as tagged (max ${err})`);
  }

  // ---- 3b. a plain clip keeps its 4:2:0 samples ------------------------------------------
  console.log("3b. a plain BT.709 clip at the canvas size exports its own YUV (no double chroma filtering)...");
  {
    // Lossless in and out, so the planes compare directly. testsrc has hard saturated colour
    // edges at odd positions: bilinear in + bicubic out (the first ws-color build) left the
    // chroma p99 19 / mean 0.57 levels off (max 88), this source's own samples come back.
    const planes = (file: string) => ff(["-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"]);
    const planeDiff = (a: Buffer, b: Buffer, from: number, to: number) => {
      const hist = new Float64Array(256);
      let max = 0, sum = 0;
      for (let i = from; i < to; i++) { const d = Math.abs(a[i] - b[i]); hist[d]++; sum += d; if (d > max) max = d; }
      let acc = 0, p99 = 0;
      for (let d = 0; d < 256; d++) { acc += hist[d]; if (acc >= (to - from) * 0.99) { p99 = d; break; } }
      return { max, p99, mean: Math.round((sum / (to - from)) * 1000) / 1000 };
    };
    const W = 1280, H = 720, Y = W * H;
    // The third clip carries an effect stack that changes nothing (invert twice): a clip with
    // effects keeps its chroma samples too (colorspace.ts keepsChromaSamples; read interpolated,
    // what its effects change would come out of a double-filtered colour edge).
    const invertTwice = { filters: [{ id: "i1", type: "invert" }, { id: "i2", type: "invert" }] };
    for (const [name, lavfi, limit, effects] of [
      ["testsrc (hard colour edges at odd positions)", "testsrc=size=1280x720:rate=30", { p99: 2, mean: 0.2 }, undefined],
      ["patch grid (edges on the 2×2 grid)", "", { p99: 0, mean: 0.01, max: 2 }, undefined],
      ["testsrc with effects that change nothing (invert twice)", "testsrc=size=1280x720:rate=30", { p99: 2, mean: 0.2 }, invertTwice],
    ] as const) {
      const src = join(dir, `plain-${lavfi ? "testsrc" : "grid"}.mp4`);
      ff(["-y", ...(lavfi ? ["-f", "lavfi", "-i", lavfi] : ["-loop", "1", "-framerate", "30", "-i", patternPng(W, H)]), "-t", "0.4",
        "-vf", `scale=out_color_matrix=bt709:out_range=tv:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p,${framesTagged([...ALL709, "-color_range", "tv"])}`,
        "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", ...ALL709, "-color_range", "tv", src]);
      const engine = new EditorEngine(mkdtempSync(join(dir, "data-")));
      engine.setProjectSettings({ width: W, height: H, fps: 30 });
      const clip = engine.appendClip((await engine.importVideo(src)).id);
      if (effects) engine.setClipEffects(clip.id, { filters: effects.filters.map((f) => ({ ...f })) });
      const lossless = join(dir, `plain-${lavfi ? "testsrc" : "grid"}${effects ? "-fx" : ""}-lossless.mp4`);
      await engine.exportVideo(lossless, { quality: 0 });
      const a = planes(src), b = planes(lossless);
      const yd = planeDiff(a, b, 0, Y), cd = planeDiff(a, b, Y, a.length);
      const lim = limit as { p99: number; mean: number; max?: number };
      const ok = (d: { max: number; p99: number; mean: number }) => d.p99 <= lim.p99 && d.mean <= lim.mean && (lim.max === undefined || d.max <= lim.max);
      check(ok(yd) && ok(cd), `${name}: export planes = source planes (Y ${JSON.stringify(yd)}, U/V ${JSON.stringify(cd)})`);
    }

    // A crop with an odd offset / odd size cuts the decoded picture exactly, as the preview
    // crops Chromium's decode: against the source read whole, cropped in RGBA and sent through
    // the same output step. (A crop of the 4:2:0 picture itself shifted the chroma half a pixel
    // and stretched it over an odd width: U/V p99 13-17, max 71-90 levels here.)
    const src = join(dir, "plain-testsrc.mp4");
    const cw = 640, ch = 360;
    // The third runs off the right edge: FFmpeg's crop moved it in (x 780), and so does the read.
    for (const [crop, at] of [
      [{ x: 3, y: 5, width: 640, height: 360 }, undefined],
      [{ x: 2, y: 4, width: 639, height: 359 }, undefined],
      [{ x: 1001, y: 3, width: 500, height: 281 }, { x: 780, y: 3 }],
    ] as const) {
      const engine = new EditorEngine(mkdtempSync(join(dir, "data-")));
      engine.setProjectSettings({ width: cw, height: ch, fps: 30 });
      const clip = engine.appendClip((await engine.importVideo(src)).id);
      engine.setClipEffects(clip.id, { crop });
      const out = join(dir, `crop-${crop.x}-${crop.width}.mp4`);
      await engine.exportVideo(out, { quality: 0 });
      const ref = ff(["-i", src, "-frames:v", "1", "-vf",
        `scale=flags=${SWS_CONVERT}${inputColorOpts({ matrix: "bt709", range: "tv" })},format=rgba,crop=${crop.width}:${crop.height}:${(at ?? crop).x}:${(at ?? crop).y}:exact=1,` +
        `scale=${cw}:${ch}:force_original_aspect_ratio=decrease:flags=${SWS_RESIZE},format=rgba,pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,${OUTPUT_YUV_STEP}`,
        "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"]);
      const got = planes(out);
      const yd = planeDiff(ref, got, 0, cw * ch), cd = planeDiff(ref, got, cw * ch, ref.length);
      check(yd.p99 <= 1 && cd.p99 <= 1 && cd.mean <= 0.1,
        `crop ${crop.width}×${crop.height} at ${crop.x},${crop.y}: the source's own pixels (Y ${JSON.stringify(yd)}, U/V ${JSON.stringify(cd)})`);
    }
  }

  // ---- 3c. time-effect and stabilize bakes keep the source's reading ---------------------
  console.log("3c. reverse, smooth slow motion and stabilize bakes are read as the clip they replace...");
  {
    // A bake re-encodes the source's YUV; untagged at HD, the bake was read as BT.709 by size —
    // up to ≈ 40 levels off for a source read as BT.601 (tagged so, or untagged VP9). A cutout's
    // FFV1 bakes alike (tagged BT.601 here: an untagged FFV1 source is read by size, as its bake).
    const cut601 = fixture("cutout-601-hd", 1280, 720, "bt601", "tv", [...ALL601, "-color_range", "tv"], "ffv1");
    const bakes: [string, (e: EditorEngine, id: string) => Promise<unknown>, boolean][] = [
      ["reverse", (e, id) => e.reverseClip(id), true],
      ["smooth slow motion", (e, id) => { e.setClipEffects(id, { speed: 0.5 }); return e.smoothSlowMotion(id, "blend"); }, true],
      ["stabilize", (e, id) => e.stabilizeClip(id), false],
    ];
    for (const [srcName, src, alpha] of [["untagged HD VP9", vp9HD, false], ["BT.601-tagged HD", tag601HD, false], ["BT.601-tagged HD cutout (FFV1 + alpha)", cut601, true]] as const) {
      for (const [bake, run, alphaToo] of bakes) {
        if (alpha && !alphaToo) continue;
        const { out, engine, clipId } = await exportOf(src, 1280, 720, async (e, id) => { await run(e, id); });
        const baked = engine.getAsset(engine.getProject().tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!.assetId!);
        const err = maxErr(patches(out, AS_709));
        check(baked.path !== src && err <= 4, `${srcName}, ${bake}: the bake exports within 4 levels of the true colours (max ${err}; bake tags: ${tagsOf(baked.path)})`);
      }
    }
  }

  // ---- 3d. motion graphics ----------------------------------------------------------------
  console.log("3d. motion graphics: Remotion's untagged BT.601 is tagged so...");
  {
    // What Remotion writes (colorSpace "default"): BT.601 limited, untagged — HD here, which
    // the untagged guess would read as BT.709 (≈ 39 levels off).
    const card = fixture("remotion-card", 1280, 720, "bt601", "tv", []);
    await tagGraphicColor(card);
    const t = tagsOf(card);
    check(/color_space=smpte170m/.test(t) && /color_primaries=smpte170m/.test(t) && /color_transfer=smpte170m/.test(t) && /color_range=tv/.test(t),
      `a standalone graphic is retagged BT.601 / limited, all four (${t})`);
    const { out } = await exportOf(card, 1280, 720);
    const err = maxErr(patches(out, AS_709));
    check(err <= 4, `…and exports within 4 levels of the true colours (max ${err})`);
    const mov = fixture("remotion-overlay", 1280, 720, "bt601", "tv", [], "prores");
    const webm = join(dir, "remotion-overlay.webm");
    await graphicPreviewProxy(mov, webm);
    const tw = tagsOf(webm);
    check(/color_space=smpte170m/.test(tw) && /color_primaries=smpte170m/.test(tw) && /color_transfer=smpte170m/.test(tw) && /color_range=tv/.test(tw),
      `an overlay graphic's VP8 preview proxy is tagged BT.601 / limited, all four (${tw})`);
    const pa = await probeAsset(webm);
    const errW = maxErr(patches(webm, asRead(chromiumSourceColor(pa.color, pa.height, pa.videoCodec))));
    check(errW <= 8, `…so Chromium's reading of it shows the true colours (max ${errW})`);
  }

  // ---- 4. a project from before assets carried colour info -------------------------------
  console.log("4. an asset saved without colour info is probed again...");
  {
    const engine = new EditorEngine(mkdtempSync(join(dir, "data-")));
    engine.setProjectSettings({ width: 1280, height: 720, fps: 30 });
    const a = await engine.importVideo(tag601HD);
    engine.appendClip(a.id);
    const file = join(dir, "old.aive");
    await engine.save(file);
    const json = JSON.parse(readFileSync(file, "utf8"));
    for (const as of json.assets) delete as.color;
    writeFileSync(file, JSON.stringify(json));
    const fresh = new EditorEngine(mkdtempSync(join(dir, "data-")));
    await fresh.load(file);
    check(fresh.getProject().assets.every((x) => !x.color), "the loaded asset has no colour info");
    const out = join(dir, "old-export.mp4");
    await fresh.exportVideo(out);
    // Without the probe, the untagged rule would read this HD file as BT.709 (≈ 39 levels off).
    const err = maxErr(patches(out, AS_709));
    check(err <= 4, `BT.601-tagged HD from an old project exports right (max ${err})`);
  }
  {
    // A partially tagged file (Chromium ignores its tags) in an old project: the colour the
    // engine probes again reaches the asset — not as an edit — so the preview corrects it,
    // and it gets the completely tagged proxy import would have made.
    const engine = new EditorEngine(mkdtempSync(join(dir, "data-")));
    engine.setProjectSettings({ width: 1280, height: 720, fps: 30 });
    engine.appendClip((await engine.importVideo(partial)).id);
    const file = join(dir, "old-partial.aive");
    await engine.save(file);
    const json = JSON.parse(readFileSync(file, "utf8"));
    for (const as of json.assets) { delete as.color; delete as.proxyPath; delete as.proxyColor; delete as.proxyError; }
    writeFileSync(file, JSON.stringify(json));
    const fresh = new EditorEngine(mkdtempSync(join(dir, "data-")));
    let dirtyAtColour: boolean | undefined;
    fresh.on("change", () => {
      if (dirtyAtColour === undefined && fresh.getProject().assets[0]?.color) dirtyAtColour = fresh.isDirty();
    });
    await fresh.load(file);
    const id = fresh.getProject().assets[0].id;
    check(!fresh.getAsset(id).color && previewColorFix(fresh.getAsset(id), false) === null, "loaded without colour info: no preview correction yet");
    let p = fresh.getAsset(id);
    for (let i = 0; i < 300 && !(p.color && (p.proxyPath || p.proxyError)); i++) {
      await new Promise((r) => setTimeout(r, 100));
      p = fresh.getAsset(id);
    }
    check(p.color?.space === "smpte170m" && previewColorFix(p, false) !== null,
      `the colour probed again is recorded on the asset, so the preview corrects it (${JSON.stringify(p.color)})`);
    check(!!p.proxyPath && previewColorFix(p, true) === null, `…and it gets a completely tagged proxy (${p.proxyPath ? tagsOf(p.proxyPath) : p.proxyError ?? "none"})`);
    // The proxy is the only undo step (as on import); undoing it keeps the colour.
    const undone = fresh.undo();
    check(dirtyAtColour === false && undone && !!fresh.getAsset(id).color && !fresh.undo(),
      `…the colour is not an edit: still saved, no undo step of its own (saved when recorded: ${dirtyAtColour === false})`);
  }

  // ---- 5. preview render + get_frame ----------------------------------------------------
  console.log("5. preview render and get_frame...");
  {
    const engine = new EditorEngine(mkdtempSync(join(dir, "data-")));
    engine.setProjectSettings({ width: 1280, height: 720, fps: 30 });
    const a = await engine.importVideo(untagHD);
    engine.appendClip(a.id);
    const pv = await engine.renderPreview();
    check(tagged709(pv.path), `preview render tagged BT.709 (${tagsOf(pv.path)})`);
    const errPv = maxErr(patches(pv.path, AS_709));
    check(errPv <= 6, `preview render patches (max ${errPv})`);
    const frame = await engine.renderFrame(0.3);
    const errF = maxErr(patches(frame, "format=rgb24"));
    check(errF <= 6, `get_frame PNG patches (max ${errF})`);
  }

  // ---- 6. freeze frame, thumbnail, key colour --------------------------------------------
  console.log("6. freeze frame, thumbnail and key detection read the clip as the export does...");
  {
    const engine = new EditorEngine(mkdtempSync(join(dir, "data-")));
    engine.setProjectSettings({ width: 1280, height: 720, fps: 30 });
    const a = await engine.importVideo(untagHD);
    const clip = engine.appendClip(a.id);
    const fz = await engine.freezeFrame(clip.id, 0.2, 0.5);
    const still = engine.getAsset(fz.assetId);
    const errStill = maxErr(patches(still.path, "format=rgb24"));
    check(errStill <= 3, `freeze-frame still of untagged HD (max ${errStill}; FFmpeg's BT.601 default: ≈ 32)`);
    const thumb = await engine.generateThumbnail(a.id, 0.2);
    // JPEG: every viewer reads BT.601 full range.
    const errThumb = maxErr(patches(thumb, asRead({ matrix: "bt601", range: "pc" })));
    check(errThumb <= 8, `thumbnail JPEG read as JPEG (max ${errThumb})`);
  }
  {
    // A green screen: the border colour is what the key compares against.
    const w = 1280, h = 720;
    const b = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const inner = x > w * 0.3 && x < w * 0.7 && y > h * 0.3 && y < h * 0.7;
      b.set(inner ? [200, 60, 50] : [30, 200, 60], (y * w + x) * 3);
    }
    const png = join(dir, "green.png");
    ff(["-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-i", "-", "-frames:v", "1", png], b);
    const green = join(dir, "green.mp4");
    ff(["-y", "-loop", "1", "-framerate", "30", "-i", png, "-t", "0.4", "-vf", "scale=out_color_matrix=bt709:out_range=tv:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p",
      "-c:v", "libx264", "-crf", "4", "-pix_fmt", "yuv420p", green]);
    const det = await detectKeyColor(green, [0.1], undefined, resolveSourceColor((await probeAsset(green)).color, 720));
    const hex = det.color.replace(/^0x/i, "");
    const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const off = Math.max(...rgb.map((v, i) => Math.abs(v - [30, 200, 60][i])));
    check(off <= 3, `key colour of an untagged HD green screen ${det.color} vs true 0x1EC83C (max ${off})`);
  }

  // ---- 7. proxies --------------------------------------------------------------------------
  console.log("7. preview proxies...");
  {
    // 1920×800 untagged: HD (BT.709) — its 1280-wide proxy is 534 lines, which a decoder would guess as SD.
    const wide = fixture("wide-untagged", 1920, 800, "bt709", "tv", []);
    const engine = new EditorEngine(mkdtempSync(join(dir, "data-")));
    const a = await engine.importVideo(wide);
    const px = await engine.generateProxy(a.id);
    check(!!px.proxyPath && tagged709(px.proxyPath), `proxy of untagged 1920×800 tagged BT.709 completely (${px.proxyPath ? tagsOf(px.proxyPath) : "none"})`);
    check(px.proxyColor?.space === "bt709" && previewColorFix(px, true) === null, "proxy colour recorded; the preview needs no correction for it");
    const err = maxErr(patches(px.proxyPath!, AS_709));
    check(err <= 8, `proxy patches read as tagged (max ${err})`);
  }
  {
    const engine = new EditorEngine(mkdtempSync(join(dir, "data-")));
    const a = await engine.importVideo(partial);
    check(previewColorFix(a, false) !== null, "a partially tagged file needs the preview correction…");
    let p = engine.getAsset(a.id);
    for (let i = 0; i < 300 && !p.proxyPath && !p.proxyError; i++) {
      await new Promise((r) => setTimeout(r, 100));
      p = engine.getAsset(a.id);
    }
    check(!!p.proxyPath && previewColorFix(p, true) === null, `…so import makes it a completely tagged proxy (${p.proxyPath ? tagsOf(p.proxyPath) : p.proxyError ?? "none"})`);
  }
  {
    // Untagged VP9: Electron's Chromium (148) reads it as the export does, the web shell's 149+ doesn't.
    const engine = new EditorEngine(mkdtempSync(join(dir, "data-")));
    const a = await engine.importVideo(vp9HD);
    check(previewColorFix(a, false, 148) === null && previewColorFix(a, false, 149) !== null && needsTaggedProxy(a),
      "untagged VP9 needs no correction on Chromium 148, one on 149…");
    let p = engine.getAsset(a.id);
    for (let i = 0; i < 300 && !p.proxyPath && !p.proxyError; i++) {
      await new Promise((r) => setTimeout(r, 100));
      p = engine.getAsset(a.id);
    }
    check(!!p.proxyPath && previewColorFix(p, true) === null && p.proxyColor?.space === "smpte170m",
      `…so import makes it a completely tagged proxy, read alike by every version (${p.proxyPath ? tagsOf(p.proxyPath) : p.proxyError ?? "none"})`);
    check(!needsTaggedProxy(await probeAsset(untagHD)), "untagged H.264 HD gets none (every version reads it as the export does)");
  }

  // MUTATION: give resolveGraphicsAddon a fallback to ZedMix's own node_modules (addon/resolve.ts) → this row fails.
  console.log("8. no graphics add-on: add_graphic refuses...");
  {
    useDevAddon();
    // The add-on path: the user chose the Remotion add-on (ZedMix's own renderer, the default, needs none).
    const engine = new EditorEngine(useRemotionRenderer(mkdtempSync(join(dir, "data-"))));
    const refused = await withoutDevAddon(() => dispatch(engine, "add_graphic", { template: "title", durationSeconds: 1 }).then(() => "added", (e: unknown) => (e instanceof RpcError ? e.code : String(e))));
    check(refused === "graphics_addon_missing", `without AIVE_REMOTION_ADDON and an installed add-on: graphics_addon_missing (${refused})`);
  }

  console.log(failures === 0 ? "\nCOLORSPACE SMOKE TEST PASSED" : `\nCOLORSPACE SMOKE TEST FAILED (${failures})`);
  if (failures === 0) rmSync(dir, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("COLORSPACE SMOKE TEST FAILED:", err);
  process.exit(1);
});
