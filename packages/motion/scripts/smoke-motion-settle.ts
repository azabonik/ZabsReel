/**
 * ZabsReel's own motion renderer captures a frame of library media only once
 * the requested source frame is painted (finding ZR-MEDIA-SETTLE, slice 4f).
 * The renderer runs for real, muted, with fresh HOME and data folders, in a
 * private network namespace; the fixtures are FIXTURES.md's (parity-lib.ts,
 * made with FFmpeg's lavfi sources), probed as an import does.
 *
 *  D1. settle — the worst cases of the media parity set (video-plain,
 *               offthread-endat, offthread-60fps, offthread-style,
 *               img-transparency; packages/motion/parity/media/compositions,
 *               as they are), and offthread-rate-half, whose source
 *               positions fall between and on the halves of source frames
 *               (so the source-frame rounding counts), each rendered
 *               RENDERS times at once, every
 *               frame of it. Rendering them at once is the point: the late
 *               frames came under load (the parity harness renders three
 *               pipelines at once), never in a lone render. Every frame:
 *               - is byte-identical in all the renders (a frame that is not
 *                 is reported with the 64 px tiles it differs in);
 *               - shows the requested source frame: each area where the case
 *                 draws library media, in 8x8 block means, is nearer to
 *                 FFmpeg's own decode of that source frame (drawn there the
 *                 same way: size, fit, crop, grey) than to the source frames
 *                 up to 2 before or after it and to the background, and
 *                 within TOLERANCE levels of it. Where the case shows no
 *                 media (offthread-endat from frame 75) the background is
 *                 the expected picture and the last source frames are the
 *                 others.
 *               No renderer is left. Without motion-renderer.cjs's wait for
 *               the drawn frame (drawn()) every video case fails here, and
 *               img-transparency in some runs (measured): blank and previous
 *               source frames and parts of frames; without its
 *               disable-partial-raster, ring seams in offthread-style that
 *               differ from render to render.
 *
 *  D2. first frames — frame 0 alone (a render's first picture of its media,
 *               where a not-yet-decoded image could be left out), of
 *               video-plain and img-transparency: RENDERS renders at once,
 *               ROUNDS rounds of them per case; every frame 0 byte-identical
 *               and showing its media as in D1. Without the renderer
 *               main's drawn() many showed the background only, or part of
 *               the video (measured: 291 of 300 in one run).
 * Linux only (it reads /proc and runs Linux's Electron). Needs `npm run
 * build` (dist/zr-runtime.js) and FFmpeg with libx264.
 * Run: npx tsx packages/motion/scripts/smoke-motion-settle.ts [--only=D1,D2] [--renders=5] [--rounds=60]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeAsset } from "../../core/src/ffmpeg/ffprobe.js";
import { renderMotion } from "../../core/src/motion/rendermotion.js";
import type { MediaAsset } from "../../core/src/types.js";
import { FIXTURES, type Fixture, generateFixtures, parseHeader, REPO } from "./parity-lib.js";
import { check, failureCount, fresh, gone, LINUX, reexecInNetns } from "./smoke-lib.js";

const CASES = join(REPO, "packages", "motion", "parity", "media", "compositions");
/** Block size of the comparison: an 8x8 block's mean takes out the browser's and FFmpeg's different scaling filters. */
const BLOCK = 8;
/** Mean difference (levels, over every block and channel) allowed between an area and FFmpeg's picture of the source frame it should show. */
const TOLERANCE = 3;
/** How far around the requested source frame the other candidates go. */
const NEAR = 2;
/** The fixtures' reading of BT.709 limited range (what the core's decode reads them as), at their own size. */
const READ = "scale=in_color_matrix=bt709:in_range=tv:flags=neighbor+accurate_rnd+full_chroma_int+full_chroma_inp";
/** CSS filter: grayscale(1) (Filter Effects: the luminance matrix on sRGB values). */
const GREY = "colorchannelmixer=rr=0.2126:rg=0.7152:rb=0.0722:gr=0.2126:gg=0.7152:gb=0.0722:br=0.2126:bg=0.7152:bb=0.0722";

type Rgb = [number, number, number];
/** An area of the canvas and what it shows at frame n. */
interface Area {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** FFmpeg filters from the source's reading to the area's pixels (scale, crop, grey). */
  draw: string;
  asset: string;
  /** The source frame the area shows at frame n (still images: 0), or its background colour where it shows none. */
  at: (n: number) => number | Rgb;
  /** The background behind the media at frame n. */
  background: (n: number) => Rgb;
}
interface Case {
  file: string;
  areas: Area[];
}

const hex = (s: string): Rgb => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)) as Rgb;
/** Every settle case runs at this composition rate (prepared() checks the headers). */
const FPS = 30;
/** The source frame the runtime shows of video `id` at media-local frame f (NOTES.md 5.5): the nearest to f / FPS seconds on the source's own grid, ties up, clamped to its frames. */
function nearest(id: string, f: number): number {
  const v = FIXTURES.find((x) => x.id === id)!;
  return Math.min(Math.max(Math.floor((f / FPS) * v.fps! + 0.5 + 1e-9), 0), v.fps! * v.seconds! - 1);
}

/** Where each case draws library media (its source sets the boxes; insets keep the areas clear of edges, rings and other layers). Video frames are contained in their box unless the case sets objectFit (NOTES.md 5.6). */
const SETTLE_CASES: Case[] = [
  // <Video> of vid_a (1920x1080, 30 fps) at its own size over the whole canvas: source frame n.
  { file: "video-plain.tsx", areas: [{ name: "video", x: 0, y: 0, w: 1920, h: 1080, draw: "", asset: "vid_a", at: (n) => nearest("vid_a", n), background: () => hex("#1b2836") }] },
  // endAt 75: source frame n on frames 0..74, the background from 75.
  { file: "offthread-endat.tsx", areas: [{ name: "video", x: 0, y: 0, w: 1920, h: 1080, draw: "", asset: "vid_a", at: (n) => (n < 75 ? nearest("vid_a", n) : hex("#2b1b36")), background: () => hex("#2b1b36") }] },
  // playbackRate 0.5: source position n/2, so every odd frame is a tie and goes up (frame 59 shows source frame 30; NOTES.md 5.5 lists the reference's 29 there as an outlier).
  { file: "offthread-rate-half.tsx", areas: [{ name: "video", x: 0, y: 0, w: 1920, h: 1080, draw: "", asset: "vid_a", at: (n) => nearest("vid_a", n * 0.5), background: () => hex("#1b3628") }] },
  // vid_c (640x360, 60 fps) at the canvas's own shape: source frame 2n, its last (179) once it ends at frame 90.
  { file: "offthread-60fps.tsx", areas: [{ name: "video", x: 0, y: 0, w: 1920, h: 1080, draw: "scale=1920:1080:flags=bilinear", asset: "vid_c", at: (n) => nearest("vid_c", n), background: () => hex("#1b2836") }] },
  {
    file: "offthread-style.tsx",
    areas: [
      // vid_a contained (the default fit) in an 800x800 box at (60,140): 800x450 from y 315, inside its 10 px ring; source frame n.
      { name: "ring box", x: 80, y: 320, w: 760, h: 440, draw: "scale=800:450:flags=bilinear,crop=760:440:20:5", asset: "vid_a", at: (n) => nearest("vid_a", n), background: () => hex("#ff2d6f") },
      // vid_c contained (objectFit: contain) in an 800x800 box at (1000,140): 800x450 from y 315, grey; source frame 2n.
      { name: "grey box", x: 1000, y: 320, w: 800, h: 440, draw: `scale=800:450:flags=bilinear,crop=800:440:0:5,${GREY}`, asset: "vid_c", at: (n) => nearest("vid_c", n), background: () => hex("#3355ff") },
    ],
  },
  // img_a (800x600) drawn 533x400 at (1040,610) over the animated panel, left of where img_c passes.
  {
    file: "img-transparency.tsx",
    areas: [{ name: "img_a", x: 1040, y: 616, w: 296, h: 392, draw: "scale=533:400:flags=bilinear,crop=296:392:0:6", asset: "img_a", at: () => 0, background: (n) => [255 - n * 2, 60 + n, n * 2] }],
  },
];

/** Block means (RGB, rounded) of the area (x,y,w,h) of a B,G,R,A canvas `cw` wide. */
function blocks(px: Buffer, x0: number, y0: number, w: number, h: number, cw: number): Uint8Array {
  const bw = w / BLOCK;
  const bh = h / BLOCK;
  const out = new Uint8Array(bw * bh * 3);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0 + by * BLOCK; y < y0 + (by + 1) * BLOCK; y++) {
        for (let i = (y * cw + x0 + bx * BLOCK) * 4, end = i + BLOCK * 4; i < end; i += 4) {
          r += px[i + 2];
          g += px[i + 1];
          b += px[i];
        }
      }
      const o = (by * bw + bx) * 3;
      out[o] = Math.round(r / (BLOCK * BLOCK));
      out[o + 1] = Math.round(g / (BLOCK * BLOCK));
      out[o + 2] = Math.round(b / (BLOCK * BLOCK));
    }
  }
  return out;
}

const solid = (w: number, h: number, c: Rgb): Uint8Array => {
  const out = new Uint8Array((w / BLOCK) * (h / BLOCK) * 3);
  for (let i = 0; i < out.length; i++) out[i] = c[i % 3];
  return out;
};

/** Mean absolute difference, in levels, over every block and channel. */
function mad(a: Uint8Array, b: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** FFmpeg's decode of every frame of `file` (or its one picture), read as the core reads it and drawn as `draw` says, in block means (FFmpeg's area scaling by BLOCK). */
function sourceBlocks(file: string, area: Area): Uint8Array[] {
  const vf = [READ, area.draw, `scale=${area.w / BLOCK}:${area.h / BLOCK}:flags=area`, "format=rgb24"].filter(Boolean).join(",");
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-an", "-vf", vf, "-vsync", "0", "-f", "rawvideo", "pipe:1"], { maxBuffer: 1 << 30 });
  const size = (area.w / BLOCK) * (area.h / BLOCK) * 3;
  if (r.status !== 0 || r.stdout.length === 0 || r.stdout.length % size !== 0) throw new Error(`FFmpeg could not decode ${file} for ${area.name}: ${String(r.stderr).trim()}`);
  const out: Uint8Array[] = [];
  for (let i = 0; i < r.stdout.length; i += size) out.push(new Uint8Array(r.stdout.subarray(i, i + size)));
  return out;
}

/** The area's verdict for frame n: "" when it shows what it should, else what it shows instead. */
function judge(area: Area, source: Uint8Array[], shown: Uint8Array, n: number): string {
  const want = area.at(n);
  const bg = solid(area.w, area.h, area.background(n));
  const others = new Map<string, Uint8Array>();
  let expected: Uint8Array;
  if (Array.isArray(want)) {
    expected = solid(area.w, area.h, want);
    // The other candidates: the source frame shown last (which should be gone) and the ones before it.
    let k = n - 1;
    while (k >= 0 && typeof area.at(k) !== "number") k--;
    const last = k >= 0 ? (area.at(k) as number) : -1;
    for (let d = 0; d <= NEAR; d++) if (source[last - d]) others.set(`source frame ${last - d}`, source[last - d]);
  } else {
    if (!source[want]) throw new Error(`${area.name}: the source has no frame ${want}`);
    expected = source[want];
    for (let d = -NEAR; d <= NEAR; d++) if (d !== 0 && source[want + d]) others.set(`source frame ${want + d}`, source[want + d]);
    others.set("the background", bg);
  }
  const e = mad(shown, expected);
  let nearest = "";
  let best = e;
  for (const [name, b] of others) {
    const m = mad(shown, b);
    if (m <= best) {
      best = m;
      nearest = name;
    }
  }
  if (!nearest && e <= TOLERANCE) return "";
  return `${area.name} ${nearest ? `nearer to ${nearest} (${best.toFixed(2)})` : "not near anything"} than to ${Array.isArray(want) ? "the background" : `source frame ${want}`} (${e.toFixed(2)})`;
}

interface Seen {
  ok: boolean;
  error?: string;
  hashes: string[];
  /** Each frame's tile checksums, to say where the renders differ. */
  tiles: Uint32Array[];
  wrong: string[];
  pids: number[];
}

/** One render of `source`; each frame is hashed and judged as it arrives (no frame is kept). */
async function renderJudged(work: string, name: string, source: string, h: ReturnType<typeof parseHeader>, lib: Record<string, MediaAsset>, judgeFrame: (frame: Buffer, n: number) => string[], frames?: number[]): Promise<Seen> {
  const f = fresh(work, name);
  const { w, h: height } = h.sizes[0];
  const size = w * height * 4;
  const seen: Seen = { ok: true, hashes: [], tiles: [], wrong: [], pids: [] };
  let pending: Buffer[] = [];
  let have = 0;
  try {
    await renderMotion({
      graphic: { source, props: {} },
      width: w,
      height,
      fps: h.fps,
      durationInFrames: h.durationInFrames,
      alpha: false,
      frames,
      workDir: join(f.data, "motion", "settle"),
      outPath: join(f.data, "baked", "settle-graphic.mp4"),
      env: f.env,
      assets: lib,
      onSpawn: (pid) => seen.pids.push(pid),
      onFrameData: (chunk) => {
        pending.push(Buffer.from(chunk));
        have += chunk.length;
        while (have >= size) {
          const all = Buffer.concat(pending);
          const frame = all.subarray(0, size);
          const n = frames ? frames[seen.hashes.length] : seen.hashes.length;
          seen.hashes.push(createHash("sha256").update(frame).digest("hex"));
          seen.tiles.push(tileSums(frame, w, height));
          for (const v of judgeFrame(frame, n)) seen.wrong.push(`frame ${n}: ${v}`);
          pending = all.length > size ? [all.subarray(size)] : [];
          have -= size;
        }
      },
    });
  } catch (err) {
    seen.ok = false;
    seen.error = `${(err as { code?: string }).code ?? ""} ${(err as Error).message}`;
  }
  return seen;
}

const TILE = 64;
/** A checksum of each TILE x TILE tile of a B,G,R,A frame w x h, rows of tiles first. */
function tileSums(px: Buffer, w: number, h: number): Uint32Array {
  const tw = Math.ceil(w / TILE);
  const out = new Uint32Array(tw * Math.ceil(h / TILE));
  for (let y = 0; y < h; y++) {
    const row = Math.floor(y / TILE) * tw;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const t = row + Math.floor(x / TILE);
      out[t] = (Math.imul(out[t], 31) + ((px[i] << 16) | (px[i + 1] << 8) | px[i + 2])) >>> 0;
    }
  }
  return out;
}

/** Where the renders' frame differs from the first render's: the box (canvas pixels, whole tiles) of the tiles that differ. */
function where(sums: Uint32Array[], cw: number): string {
  const tw = Math.ceil(cw / TILE);
  let box = [Infinity, Infinity, -1, -1];
  for (const t of sums.slice(1)) {
    for (let i = 0; i < t.length; i++) {
      if (t[i] === sums[0][i]) continue;
      const [x, y] = [(i % tw) * TILE, Math.floor(i / tw) * TILE];
      box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x + TILE), Math.max(box[3], y + TILE)];
    }
  }
  return `in (${box[0]},${box[1]})-(${box[2]},${box[3]})`;
}

/** A case's source, header and frame judge (FFmpeg's pictures of its areas made once). */
function prepared(c: Case, fixtures: Fixture[]) {
  const source = readFileSync(join(CASES, c.file), "utf8");
  const h = parseHeader(source);
  if (h.fps !== FPS) throw new Error(`${c.file} runs at ${h.fps} fps, not ${FPS}`);
  const pictures = c.areas.map((a) => sourceBlocks(fixtures.find((x) => x.id === a.asset)!.file, a));
  const judgeFrame = (frame: Buffer, n: number) => c.areas.map((a, i) => judge(a, pictures[i], blocks(frame, a.x, a.y, a.w, a.h, h.sizes[0].w), n)).filter(Boolean);
  return { source, h, judgeFrame };
}

async function d1(work: string, fixtures: Fixture[], lib: Record<string, MediaAsset>, renders: number) {
  console.log(`D1. the worst media cases, ${renders} renders of each at once: every frame identical and showing its source frame...`);
  for (const c of SETTLE_CASES) {
    const { source, h, judgeFrame } = prepared(c, fixtures);
    const t0 = Date.now();
    const runs = await Promise.all(Array.from({ length: renders }, (_, r) => renderJudged(work, `${c.file.replace(/\.tsx$/, "")}-${r}`, source, h, lib, judgeFrame)));
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    check(runs.every((r) => r.ok && r.hashes.length === h.durationInFrames), `${c.file}: ${renders} renders of ${h.durationInFrames} frames at once (${s} s) (${runs.map((r) => r.error ?? r.hashes.length).join(", ")})`);
    const split = Array.from({ length: h.durationInFrames }, (_, n) => n).filter((n) => new Set(runs.map((r) => r.hashes[n])).size !== 1);
    check(split.length === 0, `${c.file}: every frame byte-identical in all ${renders} renders (frames that differ: ${split.map((n) => `${n} ${where(runs.map((r) => r.tiles[n]), h.sizes[0].w)}`).join(", ") || "none"})`);
    const wrong = runs.flatMap((r, i) => r.wrong.map((v) => `render ${i} ${v}`));
    check(wrong.length === 0, `${c.file}: every frame shows its requested source frame in ${c.areas.map((a) => a.name).join(" and ")} (${wrong.length} wrong${wrong.length ? `: ${wrong.slice(0, 6).join("; ")}` : ""})`);
    const left = await gone(runs.flatMap((r) => r.pids), 3000);
    check(runs.every((r) => r.pids.length > 0) && left.length === 0, `${c.file}: no renderer left (${JSON.stringify(left)})`);
  }
}

/** D2's cases: a 1080p video over the whole canvas, and images. */
const FIRST_CASES = ["video-plain.tsx", "img-transparency.tsx"];

async function d2(work: string, fixtures: Fixture[], lib: Record<string, MediaAsset>, renders: number, rounds: number) {
  console.log(`D2. first frames: frame 0 alone, ${renders} renders at once, ${rounds} rounds per case: every one identical and showing its media...`);
  for (const name of FIRST_CASES) {
    const { source, h, judgeFrame } = prepared(SETTLE_CASES.find((c) => c.file === name)!, fixtures);
    const t0 = Date.now();
    const runs: Seen[] = [];
    for (let round = 0; round < rounds; round++) {
      runs.push(...(await Promise.all(Array.from({ length: renders }, (_, r) => renderJudged(work, `first-${name.replace(/\.tsx$/, "")}-${round}-${r}`, source, h, lib, judgeFrame, [0])))));
    }
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    check(runs.every((r) => r.ok && r.hashes.length === 1), `${name}: ${runs.length} renders of frame 0 (${s} s) (${runs.filter((r) => !r.ok).map((r) => r.error).slice(0, 3).join("; ") || "all rendered"})`);
    const odd = runs.map((_r, i) => i).filter((i) => runs[i].hashes[0] !== runs[0].hashes[0]);
    check(odd.length === 0, `${name}: frame 0 byte-identical in all ${runs.length} renders (${odd.length} differ${odd.length ? `: renders ${odd.slice(0, 8).join(", ")} ${where([runs[0].tiles[0], ...odd.map((i) => runs[i].tiles[0])], h.sizes[0].w)}` : ""})`);
    const wrong = runs.flatMap((r, i) => r.wrong.map((v) => `render ${i} ${v}`));
    check(wrong.length === 0, `${name}: frame 0 shows its media in every render (${wrong.length} wrong${wrong.length ? `: ${wrong.slice(0, 4).join("; ")}` : ""})`);
    const left = await gone(runs.flatMap((r) => r.pids), 3000);
    check(left.length === 0, `${name}: no renderer left (${JSON.stringify(left)})`);
  }
}

let summarized = false;

async function main() {
  const args = process.argv.slice(2);
  reexecInNetns(fileURLToPath(import.meta.url), args, "10.99.0.1");
  const renders = Number(args.find((a) => a.startsWith("--renders="))?.slice(10) ?? 5);
  const rounds = Number(args.find((a) => a.startsWith("--rounds="))?.slice(9) ?? 60);
  const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
  const part = (name: string) => !only || only.includes(name);
  if (!LINUX) {
    console.log("  skip D1-D2: they read /proc and run Linux's Electron");
  } else {
    const work = mkdtempSync(join(tmpdir(), "zr-motion-settle-"));
    try {
      const fixtures = generateFixtures(join(work, "fixtures"));
      const lib: Record<string, MediaAsset> = {};
      for (const fx of fixtures) lib[fx.id] = await probeAsset(fx.file);
      if (part("D1")) await d1(work, fixtures, lib, renders);
      if (part("D2")) await d2(work, fixtures, lib, renders, rounds);
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 5 });
    }
  }
  summarized = true;
  const failures = failureCount();
  console.log(failures === 0 ? "\nALL MOTION SETTLE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// The event loop drained before the summary (a promise that never settles): a failure, never exit 0.
process.on("beforeExit", () => {
  if (summarized) return;
  console.log("\nthe smoke ended before its summary");
  process.exit(1);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
