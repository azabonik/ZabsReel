/**
 * ZabsReel's own motion renderer: library media and fonts on demand (slice
 * 4b; MOTION-PLAN D4 E1, E2, E4 and its caps table, D8 "Media"). Every row
 * renders through the real renderer, muted, with fresh HOME and data folders,
 * in a private network namespace; the fixtures are made here with FFmpeg's
 * lavfi sources (nothing is downloaded).
 *
 *  M1. table     — the page's asset table: each usable asset's kind and sizes
 *                  under a 32-hex handle that changes every render, and no
 *                  path, file name or folder in it or in any line the
 *                  renderer sends; an asset with no stream or no size is left
 *                  out, so a graphic that uses it fails with
 *                  graphic_asset_unknown, and a video given to <Img> with
 *                  graphic_asset_kind; a media URL not of the routes' form
 *                  (another query key, a word, a repeated key, no size, a
 *                  handle not of the core's form, another host, a font URL
 *                  with a query) fails in the page without a request.
 *  M2. frames    — the frames the page shows are FFmpeg's own decode of those
 *                  source frames (untagged HD read as BT.709, as the export
 *                  reads it): frames 0,1,3,70,71,4,5,40,41,2 of a 1280x720
 *                  video: the next frames and a jump of at most 2 s forward
 *                  read a running decode, a jump past 2 s or backwards starts
 *                  another (3 FFmpeg processes); a source frame at or past
 *                  the frame count answers the last frame. A video whose
 *                  audio outlasts it (the table's frame count passes its last
 *                  frame): frames played across its end, and a first request
 *                  past it (1 s and 10 s after the end, and in a 0.1 fps
 *                  video), answer the real last frame. A video whose frame
 *                  rate changes and one that starts 0.5 s after its file (its
 *                  audio) does, each played in order past its end and asked
 *                  for out of order (each a fresh seek): every frame is
 *                  FFmpeg's fps filter at the asset's fps over the whole
 *                  file, and the decode ends at the frame count.
 *  M3. dependent — an image larger than the canvas comes back fitted to it,
 *                  and that natural size places the next image the component
 *                  loads: both show where the size says.
 *  M4. caps      — one row each of D4's table: 8 media requests in a frame
 *                  pass and a 9th is graphic_media_per_frame; a box is scaled
 *                  down to fit the canvas (same factor, at least 1x1); a
 *                  source time below 0 or not whole is graphic_media_time; a
 *                  decode past the decode cap is graphic_media_decodes_cap
 *                  while LRU hits do not count; past 256 MB of PNG the LRU
 *                  drops its oldest answers and the render succeeds; at most
 *                  8 decodes run at once (the next waits) and at most 8
 *                  FFmpeg processes live; 16 fonts load and a 17th, or a font
 *                  file over 32 MB (never read), is graphic_font_cap, while a
 *                  handle that is no font takes no font slot; a
 *                  request past its time is graphic_decode_timeout; the
 *                  default caps are D4's numbers. Every breach leaves no
 *                  renderer, no motion/<id> and nothing in baked/.
 *  M5. offline   — an asset on a server not allowed refuses the render with
 *                  media_offline when the page asks for it; a playlist
 *                  renamed .mp4 (forged probe data, naming .invalid hosts) is
 *                  refused by FFmpeg's format allowlist: graphic_media_failed,
 *                  no picture. The core's file calls, the commands it starts
 *                  and FFmpeg's own system calls (strace) name no zr-evil host.
 *  M6. files     — a render with a video, an image and a font writes nothing
 *                  outside motion/<id> but its output (watched folders, the
 *                  core's file calls), and no decoded frame file at all
 *                  (FFmpeg's decodes open nothing for writing: strace).
 *  M7. fonts     — a library font renders: its glyph pixels differ from the
 *                  fallback font's.
 *  M8. measure   — a 60 s, 30 fps graphic with one full-canvas 1920x1080
 *                  library video: 1,800 decodes from one FFmpeg process,
 *                  within the caps (its time is printed).
 *  M9. hardening — records of real files whose numbers are no sane ones (fps
 *                  NaN, 0 or over 1000; a duration under one frame, so frame
 *                  count 0; a frame count that is no number; a duration NaN;
 *                  a size not whole; an image or audio file with no size or
 *                  duration) are left out of the table, while 1000 fps and
 *                  one frame are kept; a graphic that uses the fps-NaN, the
 *                  frame-count-0 or the 1001 fps record fails with
 *                  graphic_asset_unknown and starts no decode. The search for
 *                  a video's real end (a request past it) counts each of its
 *                  decodes toward the decode cap: a 0.1 fps video and a
 *                  1,000,000 s record of a 4 s file answer their last frame
 *                  with as many decodes as FFmpeg processes, and with a lower
 *                  cap end graphic_media_decodes_cap; a record that claims
 *                  2^33 s ends graphic_media_failed after 16 search passes;
 *                  a close that comes as a pass starts lets no later pass
 *                  start (graphic_render_canceled). Each leaves no renderer,
 *                  no FFmpeg and nothing in baked/.
 *
 * Linux only (it reads /proc and runs Linux's Electron). Needs `npm run
 * build` (dist/zr-runtime.js), FFmpeg and strace (M5, M6). Ports: none.
 * Run: npx tsx packages/motion/scripts/smoke-motion-media.ts [--only=M1,M4]
 */
import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, watch, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FFMPEG_BIN } from "../../core/src/ffmpeg/executor.js";
import { probeAsset } from "../../core/src/ffmpeg/ffprobe.js";
import type { GraphicStart } from "../../core/src/motion/graphicmodule.js";
import { MAX_ASSET_FPS, MEDIA_CAPS, MotionMedia, requireOnline, SEARCH_PASSES, type MediaStats, type MotionAsset } from "../../core/src/motion/motionmedia.js";
import { renderMotion, type RendererMessage, type RenderMotionOptions } from "../../core/src/motion/rendermotion.js";
import type { MediaAsset } from "../../core/src/types.js";
import { fpsMode, selectFrames } from "./parity-lib.js";
import { check, failureCount, fresh, gone, leftNothing, LINUX, reexecInNetns, type Fresh } from "./smoke-lib.js";

const EVIL = "zr-evil";

// ---- what the core touches ---------------------------------------------------------

/** The core's file calls (fs/promises, which gatedfs looks up per call): "<name> <path>[ <path>]". */
const touched: string[] = [];
/** The commands the core started: [file, ...args]. */
const spawned: string[][] = [];
/** The PIDs of the FFmpeg processes the core started. */
const ffmpegPids: number[] = [];
/** When set, runs as each media decode (an FFmpeg writing PNGs to its stdout) is about to start. */
let beforeDecode: (() => void) | null = null;
/** When set, each FFmpeg the core starts runs under strace, logging to `${tracePrefix}.<n>`. */
let tracePrefix: string | null = null;
let traced = 0;
{
  const load = createRequire(import.meta.url);
  const fsp = load("node:fs/promises") as Record<string, unknown>;
  for (const name of Object.keys(fsp)) {
    const real = fsp[name];
    if (typeof real !== "function" || name === "constants") continue;
    fsp[name] = function (this: unknown, ...args: unknown[]) {
      const paths = (["rename", "copyFile", "link", "symlink", "cp"].includes(name) ? args.slice(0, 2) : args.slice(0, 1)).map(String);
      touched.push(`${name} ${paths.join(" ")}`);
      return (real as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
  const cp = load("node:child_process") as { spawn: (file: string, args: string[], opts: Record<string, unknown>) => ChildProcess };
  const realSpawn = cp.spawn;
  cp.spawn = (file, args = [], opts = {}) => {
    spawned.push([file, ...args]);
    if (file === FFMPEG_BIN && args.includes("image2pipe")) beforeDecode?.();
    if (!tracePrefix || file !== FFMPEG_BIN) {
      const child = realSpawn(file, args, opts);
      if (file === FFMPEG_BIN && child.pid) ffmpegPids.push(child.pid);
      return child;
    }
    // In its own process group: a kill reaches strace and FFmpeg (strace 5.16 has no --kill-on-exit).
    const child = realSpawn("strace", ["-f", "-qq", "-e", "trace=%file,%network", "-o", `${tracePrefix}.${++traced}`, file, ...args], { ...opts, detached: true });
    const kill = child.kill.bind(child);
    child.kill = (signal?: NodeJS.Signals | number) => {
      try {
        process.kill(-(child.pid as number), signal ?? "SIGTERM");
        return true;
      } catch {
        return kill(signal);
      }
    };
    return child;
  };
  syncBuiltinESMExports();
}

/** strace's lines for each FFmpeg started while `prefix` was set: one array per process tree, its execve first. */
function traces(prefix: string): string[][] {
  const dir = join(prefix, "..");
  return readdirSync(dir)
    .filter((n) => n.startsWith(`${basename(prefix)}.`))
    .map((n) => readFileSync(join(dir, n), "utf8").split("\n"));
}
/** A media decode's trace (FFmpeg writing PNGs to its stdout), not the encode's. */
const isDecode = (lines: string[]) => lines[0]?.includes('"image2pipe"') === true;

// ---- fixtures ------------------------------------------------------------------------

interface Fixtures {
  dir: string;
  /** 1280x720, 30 fps, 4 s testsrc2, H.264 with no colour tags (untagged HD). */
  hd: string;
  /** 160x90, 30 fps, 4 s testsrc2, H.264. */
  small: string;
  /** The same 4 s of video with 5 s of AAC audio, 2 s of video with 12 s of audio, and 40 s at 0.1 fps with 60 s: the container outlasts the video stream. */
  tail: string;
  gap: string;
  slow: string;
  /** 2 s at 30 fps, then every 6th frame for 2 s (the frame rate changes: 70 pictures, 18.261 fps on average). */
  vfr: string;
  /** Matroska: 3 s of 30 fps video from 0.5 s, 4 s of audio from 0 (the video starts after its file does). */
  late: string;
  /** 400x200 PNG; 16x16 red PNG. */
  big: string;
  red: string;
  /** 1920x1080, 30 fps, 4 s of one still of RGB noise (lossless H.264 RGB): every frame's PNG is ~6 MB. */
  noise: string;
  /** A monospace TrueType font from the system (not the fallback), and a file of 32 MB + 1 byte. */
  mono: string | null;
  hugeFont: string;
}

function ffmpeg(args: string[]): void {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`fixture: ffmpeg ${args.join(" ")}: ${r.stderr}`);
}

function fixtures(work: string): Fixtures {
  const dir = join(work, "fixtures");
  mkdirSync(dir, { recursive: true });
  const at = (n: string) => join(dir, n);
  const src = (size: string, d = 4) => ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30:duration=${d}`];
  ffmpeg([...src("1280x720"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-preset", "veryfast", at("hd.mp4")]);
  ffmpeg([...src("160x90"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", at("small.mp4")]);
  const longAudio = (v: number, a: number, out: string, rate = 30) =>
    ffmpeg(["-f", "lavfi", "-i", `testsrc2=size=160x90:rate=${rate}:duration=${v}`, "-f", "lavfi", "-i", `sine=duration=${a}`, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", at(out)]);
  longAudio(4, 5, "tail.mp4");
  longAudio(2, 12, "gap.mp4");
  longAudio(40, 60, "slow.mp4", 0.1);
  ffmpeg([...src("160x90"), "-vf", "select='lt(n,60)+not(mod(n,6))'", ...fpsMode("vfr"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", at("vfr.mp4")]);
  ffmpeg(["-itsoffset", "0.5", ...src("160x90", 3), "-f", "lavfi", "-i", "sine=duration=4", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", at("late.mkv")]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=400x200", "-frames:v", "1", at("big.png")]);
  ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=16x16", "-frames:v", "1", at("red.png")]);
  ffmpeg(["-f", "lavfi", "-i", "nullsrc=s=1920x1080,format=gbrp,geq=r='random(1)*255':g='random(2)*255':b='random(3)*255'", "-frames:v", "1", at("noise.png")]);
  ffmpeg(["-loop", "1", "-i", at("noise.png"), "-t", "4", "-r", "30", "-c:v", "libx264rgb", "-qp", "0", "-preset", "ultrafast", at("noise.mp4")]);
  const fonts = ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf"];
  const font = fonts.find((p) => existsSync(p)) ?? null;
  let mono: string | null = null;
  if (font) {
    mono = at("mono.ttf");
    writeFileSync(mono, readFileSync(font));
  }
  const hugeFont = at("huge.ttf");
  writeFileSync(hugeFont, "");
  truncateSync(hugeFont, MEDIA_CAPS.fontBytes + 1);
  return { dir, hd: at("hd.mp4"), small: at("small.mp4"), tail: at("tail.mp4"), gap: at("gap.mp4"), slow: at("slow.mp4"), vfr: at("vfr.mp4"), late: at("late.mkv"), big: at("big.png"), red: at("red.png"), noise: at("noise.mp4"), mono, hugeFont };
}

const font = (path: string): MotionAsset => ({ kind: "font", path, name: basename(path) });

// ---- rendering ---------------------------------------------------------------------

interface Run {
  frames: Buffer[];
  messages: RendererMessage[];
  pids: number[];
  error?: Error & { code?: string; hosts?: string[] };
  media?: MediaStats;
  start?: GraphicStart;
  ms: number;
}

/**
 * renderMotion with the run's messages, renderer PID and media counters
 * recorded, and its frames when `keep` (the frames of a long or large
 * render are not kept). `o` has a graphic, or a module written from the
 * start data.
 */
async function render(
  f: Fresh,
  id: string,
  o: Partial<RenderMotionOptions> & { width: number; height: number } & ({ graphic: NonNullable<RenderMotionOptions["graphic"]> } | { page: (start: GraphicStart) => string }),
  keep = true,
): Promise<Run> {
  const chunks: Buffer[] = [];
  const run: Run = { frames: [], messages: [], pids: [], ms: 0 };
  const { page, ...rest } = o as typeof o & { page?: (start: GraphicStart) => string };
  const t0 = Date.now();
  try {
    await renderMotion({
      fps: 30,
      durationInFrames: 1,
      alpha: false,
      workDir: join(f.data, "motion", id),
      outPath: join(f.data, "baked", `${id}-graphic.mp4`),
      env: f.env,
      onFrameData: keep ? (c) => chunks.push(Buffer.from(c)) : undefined,
      onMessage: (m) => run.messages.push(m),
      onSpawn: (pid) => run.pids.push(pid),
      onMedia: (s) => (run.media = s),
      ...(page
        ? {
            module: (start: GraphicStart) => {
              run.start = start;
              return page(start);
            },
          }
        : {}),
      ...rest,
    });
  } catch (err) {
    run.error = err as Run["error"];
  }
  run.ms = Date.now() - t0;
  const size = o.width * o.height * 4;
  const all = Buffer.concat(chunks);
  for (let i = 0; i + size <= all.length; i += size) run.frames.push(all.subarray(i, i + size));
  return run;
}

/** The render failed with `code`. */
function failedWith(run: Run, code: string, what: string, msg?: RegExp) {
  check(run.error?.code === code && (!msg || msg.test(run.error.message)), `${what}: ${code} (${run.error ? `${run.error.code}: ${run.error.message}` : "it rendered"})`);
}

/** FFmpeg's own RGBA decode of `file`'s frames `which` (in that order), read with `vf` before format=rgba; `pre` (an fps filter) numbers the frames. */
function reference(file: string, which: number[], w: number, h: number, vf: string, pre = ""): Map<number, Buffer> {
  const sorted = [...new Set(which)].sort((a, b) => a - b);
  const select = selectFrames(sorted);
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-an", "-vf", `${pre ? `${pre},` : ""}${select},${vf},format=rgba`, ...fpsMode("passthrough"), "-f", "rawvideo", "pipe:1"], { maxBuffer: 1 << 30 });
  const out = new Map<number, Buffer>();
  sorted.forEach((n, i) => out.set(n, r.stdout.subarray(i * w * h * 4, (i + 1) * w * h * 4)));
  return out;
}

/** The largest per-channel difference between a captured frame (B,G,R,A) and an RGBA picture, over the box (0,0,w,h) of a canvas `cw` wide. */
function maxDiff(bgra: Buffer, rgba: Buffer, w: number, h: number, cw = w): number {
  if (rgba.length !== w * h * 4) return 255;
  let max = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * cw + x) * 4;
      const j = (y * w + x) * 4;
      max = Math.max(max, Math.abs(bgra[i + 2] - rgba[j]), Math.abs(bgra[i + 1] - rgba[j + 1]), Math.abs(bgra[i] - rgba[j + 2]));
    }
  }
  return max;
}

/** The page's own log lines that start with `tag `, parsed. */
function logged(run: Run, tag: string): unknown[] {
  return run.messages
    .filter((m) => m.type === "log" && String(m.text).startsWith(`${tag} `))
    .map((m) => JSON.parse(String(m.text).slice(tag.length + 1)) as unknown);
}

/**
 * A hand-written page (no runtime): `body` runs for each frame with `A` (the
 * start data's assets), `n`, `load(url)` (an <img> appended to #root at its
 * natural size, resolving to its natural size or null) and `log(tag, value)`.
 */
const handPage = (body: string) => (start: GraphicStart) => `
const A = ${JSON.stringify(start.assets)};
const root = document.getElementById("root");
root.style.cssText = "position:absolute;left:0;top:0;line-height:0";
function load(url, show) {
  return new Promise((resolve) => {
    const i = new Image();
    i.style.cssText = "display:block;position:absolute;left:0;top:0";
    i.onload = () => resolve({ w: i.naturalWidth, h: i.naturalHeight });
    i.onerror = () => resolve(null);
    i.src = url;
    if (show) root.appendChild(i);
  });
}
const media = (a, q) => "zrmotion://media/" + a.handle + "?" + q;
const log = (tag, v) => zrMotionHost.log(tag + " " + JSON.stringify(v));
zrMotion.onFrame(async (n) => { ${body} });
`;

const VIDEO_TSX = (id: string, extra = "") => `import { AbsoluteFill, OffthreadVideo, asset } from "remotion";
export default function G() {
  return <AbsoluteFill style={{ background: "#000" }}><OffthreadVideo src={asset("${id}")} style={{ position: "absolute", left: 0, top: 0 }} />${extra}</AbsoluteFill>;
}`;

/** The reading of untagged HD the export uses (BT.709, limited range), at its own size, written out here. */
const HD_READ = "scale=in_color_matrix=bt709:in_range=tv:flags=neighbor+accurate_rnd+full_chroma_int+full_chroma_inp";

// ---- M1: the table -------------------------------------------------------------------

async function m1(work: string, fx: Fixtures, lib: Record<string, MediaAsset>) {
  console.log("M1. the page's asset table...");
  const assets: Record<string, MotionAsset> = {
    vid: lib.small,
    img: lib.big,
    ...(fx.mono ? { mono: font(fx.mono) } : {}),
    // Audio only (an audio asset of the library), and two the runtime has no kind for.
    aud: { ...lib.small, hasVideo: false, hasAudio: true, isImage: undefined },
    nostreams: { ...lib.small, hasVideo: false, hasAudio: false },
    nosize: { ...lib.small, width: 0, height: 0 },
  };
  const f = fresh(work, "table");
  const page = handPage(`log("ASSETS", Object.keys(A));`);
  const a = await render(f, "table-a", { page, width: 64, height: 32, assets });
  const b = await render(f, "table-b", { page, width: 64, height: 32, assets });
  const ta = a.start?.assets ?? {};
  const tb = b.start?.assets ?? {};
  const hex = /^[0-9a-f]{32}$/;
  const v = ta.vid;
  check(
    !a.error && v?.kind === "video" && v.width === 160 && v.height === 90 && v.fps === 30 && v.frameCount === 120 && v.durationSeconds === lib.small.duration && v.hasAudio === false && hex.test(v.handle),
    `a video carries its handle, size, fps, frame count, duration and hasAudio (${a.error?.message ?? JSON.stringify(v)})`,
  );
  check(same(ta.img, { handle: ta.img?.handle, kind: "image", width: 400, height: 200 }) && same(ta.aud, { handle: ta.aud?.handle, kind: "audio", durationSeconds: lib.small.duration }), `an image carries its size, an audio file its duration (${JSON.stringify([ta.img, ta.aud])})`);
  if (fx.mono) check(same(ta.mono, { handle: ta.mono?.handle, kind: "font" }), `a font carries only its handle (${JSON.stringify(ta.mono)})`);
  check(!("nostreams" in ta) && !("nosize" in ta) && same(logged(a, "ASSETS")[0], Object.keys(ta)), `an asset with no stream or no size is not in the table (${JSON.stringify(Object.keys(ta))})`);
  const handles = (t: GraphicStart["assets"]) => Object.values(t).map((x) => x.handle);
  check(handles(ta).every((h) => hex.test(h)) && new Set(handles(ta)).size === handles(ta).length && handles(ta).every((h) => !handles(tb).includes(h)) && same(Object.keys(ta), Object.keys(tb)),
    `handles are 32 hex characters, distinct, and new each render (${JSON.stringify(handles(ta))} / ${JSON.stringify(handles(tb))})`);
  const text = JSON.stringify([a.start, b.start, a.messages, b.messages]);
  const leaks = [fx.dir, ...Object.values(fx).filter((p): p is string => typeof p === "string").map((p) => basename(p)), "fixtures"].filter((s) => text.includes(s));
  check(leaks.length === 0, `no path, file name or folder in the start data or the renderer's lines (${JSON.stringify(leaks)})`);
  await leftNothing(b, f, "table-b", "table");

  // The renderer forwards only its routes' own form: anything else is a 404 the core never sees.
  const bad = [
    'media(A.img, "w=10&h=10&x=1")', 'media(A.img, "w=ten&h=10")', 'media(A.img, "w=10&w=11&h=10")', 'media(A.img, "w=10")',
    '"zrmotion://media/" + A.img.handle.toUpperCase() + "?w=10&h=10"', '"zrmotion://media/" + A.img.handle + "x?w=10&h=10"',
    '"zrmotion://app/media/" + A.img.handle + "?w=10&h=10"', '"zrmotion://font/" + A.mono.handle', '"zrmotion://app/font/" + A.mono.handle + "?w=1"',
  ];
  const routes = await render(f, "routes", { page: handPage(`log("BAD", await Promise.all([${bad.join(", ")}].map((u) => load(u))));`), width: 64, height: 32, assets });
  check(!routes.error && same(logged(routes, "BAD")[0], bad.map(() => null)) && !routes.messages.some((m) => m.type === "media"),
    `an unknown query key, a word, a repeated key, a missing size, a handle not of the core's form, another host and a font URL with a query all fail without a request to the core (${routes.error?.message ?? JSON.stringify(logged(routes, "BAD"))})`);

  const unknown = await render(f, "unknown", { graphic: { source: `import { Img, asset } from "remotion";\nexport default () => <Img src={asset("nostreams")} />;` }, width: 64, height: 32, assets });
  failedWith(unknown, "graphic_asset_unknown", "an asset left out of the table", /nostreams/);
  await leftNothing(unknown, f, "unknown", "unknown asset");
  const kind = await render(f, "kind", { graphic: { source: `import { Img, asset } from "remotion";\nexport default () => <Img src={asset("vid")} />;` }, width: 64, height: 32, assets });
  failedWith(kind, "graphic_asset_kind", "a video given to <Img>", /vid/);
  await leftNothing(kind, f, "kind", "wrong kind");
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- M2: frames ----------------------------------------------------------------------

async function m2(work: string, fx: Fixtures, lib: Record<string, MediaAsset>) {
  console.log("M2. the page shows FFmpeg's decode of the source frames...");
  const f = fresh(work, "frames");
  const order = [0, 1, 3, 70, 71, 4, 5, 40, 41, 2];
  const run = await render(f, "hd", { graphic: { source: VIDEO_TSX("hd") }, width: 1280, height: 720, durationInFrames: 120, frames: order, assets: { hd: lib.hd } });
  const ref = reference(fx.hd, order, 1280, 720, HD_READ);
  const diffs = order.map((n, i) => (run.frames[i] ? maxDiff(run.frames[i], ref.get(n) as Buffer, 1280, 720) : 255));
  check(!run.error && run.frames.length === order.length && diffs.every((d) => d <= 1), `frames ${order.join(",")} equal FFmpeg's decode of those source frames, BT.709 for untagged HD, within 1 level (${run.error?.message ?? `max ${JSON.stringify(diffs)}`})`);
  check(run.media?.decodes === 10 && run.media.spawns === 3, `the next frames and a jump of at most 2 s read a running decode; past 2 s or backwards start another: 3 FFmpeg processes for 10 frames (${JSON.stringify(run.media)})`);
  await leftNothing(run, f, "hd", "HD frames");

  // Past the frame count: the last frame (a hand-written page asks the core directly).
  const last = await render(f, "last", { page: handPage(`log("SIZE", await load(media(A.vid, "t=170&w=160&h=90"), true));`), width: 160, height: 90, assets: { vid: lib.small } });
  const lastRef = reference(fx.small, [119], 160, 90, HD_READ.replace("bt709", "bt601")).get(119) as Buffer;
  const d = last.frames[0] ? maxDiff(last.frames[0], lastRef, 160, 90) : 255;
  check(!last.error && d <= 1 && same(logged(last, "SIZE")[0], { w: 160, h: 90 }), `source frame 170 of a 120-frame video answers frame 119 (${last.error?.message ?? `max ${d}`})`);
  await leftNothing(last, f, "last", "past the frame count");

  // A video whose audio outlasts it: the table's frame count (the container's) passes the real last frame, 119.
  const SD_READ = HD_READ.replace("bt709", "bt601");
  const count = Math.round(lib.tail.duration * lib.tail.fps);
  const tailRef = reference(fx.tail, [116, 117, 118, 119], 160, 90, SD_READ);
  const seq = [116, 117, 118, 119, 120, 121, 122, 123];
  const want = seq.map((n) => tailRef.get(Math.min(n, 119)) as Buffer);
  const equal = (run: Run, refs: Buffer[]) => run.frames.length === refs.length && refs.every((r, i) => maxDiff(run.frames[i], r, 160, 90) <= 1);
  check(count > 120, `the 4 s video with 5 s of audio has a frame count past its last frame (${count})`);
  // The decode that reaches the end gives the real count: 121..123 are the LRU's frame 119, one FFmpeg process in all.
  const across = await render(f, "across", { graphic: { source: VIDEO_TSX("tail") }, width: 160, height: 90, durationInFrames: count, frames: seq, assets: { tail: lib.tail } });
  check(!across.error && equal(across, want) && across.media?.spawns === 1 && across.media.decodes === 5 && across.media.lruHits === 3,
    `frames ${seq.join(",")} of it play across its end: 120-123 show frame 119, from one decode (${across.error?.message ?? JSON.stringify(across.media)})`);
  await leftNothing(across, f, "across", "across the end");
  // With no LRU, the decode that ended answers its last frame again: still one FFmpeg process.
  const noLru = await render(f, "across-nolru", { graphic: { source: VIDEO_TSX("tail") }, width: 160, height: 90, durationInFrames: count, frames: seq, caps: { lruBytes: 1 }, assets: { tail: lib.tail } });
  check(!noLru.error && equal(noLru, want) && noLru.media?.spawns === 1 && noLru.media.decodes === 8,
    `with no LRU, the ended decode answers frames 121-123 itself (${noLru.error?.message ?? JSON.stringify(noLru.media)})`);
  // A first request past the real end (a fresh seek finds no picture) answers the real last frame.
  const past = [
    ["tail", count - 1, 119, "4 s video with 5 s"],
    ["tail", 400, 119, "4 s video with 5 s"],
    ["gap", Math.round(lib.gap.duration * lib.gap.fps) - 1, 59, "2 s video with 12 s"],
    // 0.1 fps: 2 s is no whole frame, so the search starts 1 frame back.
    ["slow", Math.round(lib.slow.duration * lib.slow.fps) - 1, 3, "40 s, 0.1 fps video with 60 s"],
  ] as const;
  for (const [asset, t, lastFrame, what] of past) {
    const run = await render(f, `past-${asset}-${t}`, { page: handPage(`log("SIZE", await load(media(A.v, "t=${t}&w=160&h=90"), true));`), width: 160, height: 90, assets: { v: lib[asset] } });
    const ref = reference(fx[asset], [lastFrame], 160, 90, SD_READ).get(lastFrame) as Buffer;
    check(!run.error && equal(run, [ref]) && same(logged(run, "SIZE")[0], { w: 160, h: 90 }),
      `a first request for source frame ${t} of the ${what} of audio answers its last frame, ${lastFrame} (${run.error?.message ?? JSON.stringify(run.media)})`);
    await leftNothing(run, f, `past-${asset}-${t}`, "past the real end");
  }

  // Source frame k is the picture shown at k / fps: FFmpeg's fps filter at the asset's fps over the whole file, from the
  // file's start (its first picture until the video starts, as FFmpeg's constant-rate output shows it), whatever the
  // order of the requests. Each frame's page asks the core directly for source frame `T[n]`.
  const byTime = (asset: "vfr" | "late", T: number[], o: Partial<RenderMotionOptions> = {}) => {
    const page = handPage(`const T = ${JSON.stringify(T)}; root.replaceChildren(); await load(media(A.v, "t=" + T[n] + "&w=160&h=90"), true);`);
    return render(f, `bytime-${asset}-${T[0]}-${T.length}`, { page, width: 160, height: 90, durationInFrames: T.length, assets: { v: lib[asset] }, ...o });
  };
  // `n`: the video's real frame count.
  const conform = (asset: "vfr" | "late", n: number, T: number[]) => {
    const ref = reference(fx[asset], T.map((t) => Math.min(t, n - 1)), 160, 90, SD_READ, `fps=${lib[asset].fps}:start_time=0`);
    return T.map((t) => ref.get(Math.min(t, n - 1)) as Buffer);
  };
  const offBy = (run: Run, refs: Buffer[]) => refs.flatMap((r, i) => (run.frames[i] && maxDiff(run.frames[i], r, 160, 90) <= 1 ? [] : [i]));
  const upTo = (n: number) => Array.from({ length: n }, (_, k) => k);
  // Played in order, two frames past its real end: one decode, which ends at frame n - 1; frame n is decoded only when
  // the table's count passes it, and later frames are the LRU's frame n - 1.
  const played = async (asset: "vfr" | "late", n: number, what: string) => {
    const T = upTo(n + 2);
    const run = await byTime(asset, T);
    const bad = offBy(run, conform(asset, n, T));
    const decodes = n + (Math.round(lib[asset].duration * lib[asset].fps) > n ? 1 : 0);
    check(!run.error && run.frames.length === T.length && bad.length === 0 && run.media?.spawns === 1 && run.media.decodes === decodes && run.media.lruHits === T.length - decodes,
      `${what}: its frames 0-${n + 1} played in order are its fps filter's at ${lib[asset].fps} fps, from one decode that ends at its ${n} frames (${run.error?.message ?? `frames off: ${JSON.stringify(bad)}, ${JSON.stringify(run.media)}`})`);
    await leftNothing(run, f, `bytime-${asset}-0-${T.length}`, what);
  };
  // Backwards and far apart, with no LRU: every request is a fresh seek (one FFmpeg process each).
  const jumped = async (asset: "vfr" | "late", n: number, T: number[], what: string) => {
    const run = await byTime(asset, T, { caps: { lruBytes: 1 } });
    const bad = offBy(run, conform(asset, n, T));
    check(!run.error && run.frames.length === T.length && bad.length === 0 && run.media?.spawns === T.length,
      `${what}: its frames ${T.join(",")}, each a fresh seek, are the same frames of its fps filter (${run.error?.message ?? `frames off: ${JSON.stringify(bad.map((i) => T[i]))}, ${JSON.stringify(run.media)}`})`);
    await leftNothing(run, f, `bytime-${asset}-${T[0]}-${T.length}`, what);
  };
  const vfrCount = Math.round(lib.vfr.duration * lib.vfr.fps);
  check(vfrCount > 70 && lib.vfr.fps !== 30, `the variable-rate video averages ${lib.vfr.fps} fps: ${vfrCount} frames from its 70 pictures`);
  await played("vfr", vfrCount, "a video whose frame rate changes");
  await jumped("vfr", vfrCount, [74, 69, 66, 61, 58, 50, 45, 37, 33, 23, 10, 5, 1], "a video whose frame rate changes");
  // 0.5 s late (plus the audio encoder's delay): its first picture until it starts, then its 90 pictures. Its real
  // frame count is its last picture's end at its fps, from the file's start (106 here; 105 with FFmpeg 8.1+); the
  // table's count is its 4 s of audio's. From the file's start, as the core's decode (-copyts -start_at_zero) and the
  // fps filter over the whole file count: FFmpeg 6.1 - 8.0 write the AAC audio from -0.023 s and start the file there,
  // so packet times are not times from the file's start. 4.4 writes the audio from 0 (and the video from 0.523 s);
  // 8.1+ start the file at 0.
  const packets = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0", fx.late], { encoding: "utf8" });
  const fileStart = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0", fx.late], { encoding: "utf8" }).stdout.trim());
  const lateEnd = Math.max(...packets.stdout.trim().split("\n").map((l) => l.split(",").map(Number)).map(([pts, d]) => pts + d)) - fileStart;
  const lateReal = Math.round(lateEnd * lib.late.fps);
  const lateCount = Math.round(lib.late.duration * lib.late.fps);
  check(lateReal > 90 && lateCount > lateReal, `the video that starts 0.5 s after its file: ${lateReal} frames from its 90 pictures, and a frame count past them (${lateCount})`);
  await played("late", lateReal, "a video that starts 0.5 s after its file");
  await jumped("late", lateReal, [lateReal - 6, 40, 16, 8, 0], "a video that starts 0.5 s after its file");
}

// ---- M3: a request that depends on loaded media ----------------------------------------

const DEPENDENT_TSX = `import { useState } from "react";
import { AbsoluteFill, Img, asset, delayRender, continueRender } from "remotion";
export default function G() {
  const [hold] = useState(() => delayRender("measure"));
  const [size, setSize] = useState(null);
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Img src={asset("big")} style={{ position: "absolute", left: 0, top: 0, width: 32, height: 16 }}
        onLoad={(e) => { setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }); continueRender(hold); }} />
      {size ? <Img src={asset("red")} style={{ position: "absolute", left: 0, top: size.h, width: size.w, height: 4 }} /> : null}
    </AbsoluteFill>
  );
}`;

async function m3(work: string, _fx: Fixtures, lib: Record<string, MediaAsset>) {
  console.log("M3. a component whose request depends on loaded media...");
  const f = fresh(work, "dependent");
  const run = await render(f, "dep", { graphic: { source: DEPENDENT_TSX }, width: 160, height: 90, assets: { big: lib.big, red: lib.red } });
  const fr = run.frames[0];
  // The 400x200 image fits the 160x90 canvas at 160x80: the red strip is at rows 80..83 and as wide as the canvas.
  const red = (x: number, y: number) => !!fr && fr[(y * 160 + x) * 4 + 2] > 200 && fr[(y * 160 + x) * 4 + 1] < 40 && fr[(y * 160 + x) * 4] < 40;
  const strip = [0, 80, 159].every((x) => [80, 83].every((y) => red(x, y)));
  const clear = [79, 84].every((y) => [0, 80, 159].every((x) => !red(x, y)));
  check(!run.error && strip && clear, `the image's fitted natural size (160x80) placed the next image: a red strip at rows 80-83, 160 wide (${run.error?.message ?? `strip ${strip}, outside clear ${clear}`})`);
  await leftNothing(run, f, "dep", "dependent media");
}

// ---- M4: the caps --------------------------------------------------------------------

async function m4(work: string, fx: Fixtures, lib: Record<string, MediaAsset>) {
  console.log("M4. D4's caps, one row each...");
  check(same(MEDIA_CAPS, { perFrame: 8, decodes: 40_000, lruBytes: 256 * 1024 * 1024, concurrent: 8, fonts: 16, fontBytes: 32 * 1024 * 1024, requestMs: 20_000 }), `the default caps are D4's (${JSON.stringify(MEDIA_CAPS)})`);
  const f = fresh(work, "caps");

  // Requests per frame: 8 pass, a 9th fails.
  const boxes = (k: number) => `await Promise.all(Array.from({ length: ${k} }, (_, i) => load(media(A.img, "w=" + (10 + i) + "&h=10"))));`;
  const eight = await render(f, "eight", { page: handPage(boxes(8)), width: 64, height: 32, assets: { img: lib.big } });
  check(!eight.error && eight.media?.decodes === 8, `8 media requests in one frame pass (${eight.error?.message ?? JSON.stringify(eight.media)})`);
  const nine = await render(f, "nine", { page: handPage(boxes(9)), width: 64, height: 32, assets: { img: lib.big } });
  failedWith(nine, "graphic_media_per_frame", "a 9th media request in one frame", /more than 8/);
  await leftNothing(nine, f, "nine", "per-frame cap");

  // The box: scaled down to fit, the same factor on both sides, at least 1x1.
  const box = await render(f, "box", {
    page: handPage(`log("BOX", [await load(media(A.img, "w=4000&h=2000")), await load(media(A.img, "w=0&h=0")), await load(media(A.img, "w=50&h=10")), await load(media(A.img, "w=64&h=640"))]);`),
    width: 64,
    height: 32,
    assets: { img: lib.big },
  });
  check(!box.error && same(logged(box, "BOX")[0], [{ w: 64, h: 32 }, { w: 1, h: 1 }, { w: 50, h: 10 }, { w: 3, h: 32 }]), `boxes 4000x2000, 0x0, 50x10 and 64x640 on a 64x32 canvas come back 64x32, 1x1, 50x10 and 3x32 (${box.error?.message ?? JSON.stringify(logged(box, "BOX"))})`);

  // The source time: below 0, or not a whole number.
  for (const [t, what] of [["-1", "below 0"], ["1.5", "not a whole number"]]) {
    const run = await render(f, `time${t}`, { page: handPage(`await load(media(A.vid, "t=${t}&w=160&h=90"));`), width: 160, height: 90, assets: { vid: lib.small } });
    failedWith(run, "graphic_media_time", `source frame ${t} (${what})`, /whole number, 0 or more/);
    await leftNothing(run, f, `time${t}`, `source frame ${t}`);
  }

  // Decodes: past the cap fails; LRU hits do not count.
  const over = await render(f, "decodes", { graphic: { source: VIDEO_TSX("vid") }, width: 160, height: 90, durationInFrames: 4, caps: { decodes: 3 }, assets: { vid: lib.small } });
  failedWith(over, "graphic_media_decodes_cap", "a 4th decode with a cap of 3");
  await leftNothing(over, f, "decodes", "decode cap");
  const again = await render(f, "lru-hits", { graphic: { source: VIDEO_TSX("vid") }, width: 160, height: 90, durationInFrames: 3, frames: [0, 1, 2, 1, 0, 2, 1], caps: { decodes: 3 }, assets: { vid: lib.small } });
  check(!again.error && again.media?.decodes === 3 && again.media.lruHits === 4, `frames 0,1,2,1,0,2,1 with a cap of 3: the repeats are LRU hits, not decodes (${again.error?.message ?? JSON.stringify(again.media)})`);

  // The LRU: past 256 MB the oldest answers go, and the render succeeds.
  const png = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", fx.noise, "-frames:v", "1", "-vf", "format=rgba", "-f", "image2pipe", "-c:v", "png", "pipe:1"], { maxBuffer: 1 << 26 }).stdout.length;
  const count = Math.min(119, Math.ceil((MEDIA_CAPS.lruBytes * 1.15) / png));
  const fill = await render(f, "lru", { graphic: { source: VIDEO_TSX("noise") }, width: 1920, height: 1080, durationInFrames: 120, frames: [...Array.from({ length: count }, (_, n) => n), 0], assets: { noise: lib.noise } }, false);
  const m = fill.media;
  check(
    !fill.error && !!m && m.lruPeakBytes <= MEDIA_CAPS.lruBytes && m.lruPeakBytes > MEDIA_CAPS.lruBytes * 0.9 && m.evictions > 0 && m.decodes === count + 1 && m.lruHits === 0,
    `${count} frames of ~${(png / 1024 / 1024).toFixed(1)} MB PNG, then frame 0 again: the LRU stays within 256 MB (peak ${m ? (m.lruPeakBytes / 1024 / 1024).toFixed(1) : "-"} MB), drops its oldest (${m?.evictions} dropped; frame 0 decoded again) and the render succeeds (${fill.error?.message ?? `${fill.ms} ms`})`,
  );

  // At most 8 decodes at once (the next waits), at most 8 FFmpeg processes. The second
  // frame's source frames are over 2 s past the first's, so each needs a new decode.
  const spread = (from: number, step: number) => `Array.from({ length: 8 }, (_, i) => load(media(A.noise, "t=" + (${from} + i * ${step}) + "&w=1920&h=1080")))`;
  const busy = await render(f, "busy", {
    page: handPage(`if (n === 0) { window.first = ${spread(0, 7)}; await new Promise((r) => setTimeout(r, 100)); } else { await Promise.all([...window.first, ...${spread(112, 1)}]); }`),
    width: 1920, height: 1080, durationInFrames: 2, assets: { noise: lib.noise },
  }, false);
  const bm = busy.media;
  check(!busy.error && bm?.decodes === 16 && bm.peakDecoding === 8 && bm.waited > 0 && bm.peakProcesses <= 8, `16 decodes over two frames: 8 at most at once, the rest waited, at most 8 FFmpeg processes (${busy.error?.message ?? JSON.stringify(bm)})`);

  // Fonts: 16 load, a 17th fails; a file over 32 MB fails before it is read.
  if (fx.mono) {
    const monoFont = font(fx.mono);
    const many: Record<string, MotionAsset> = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, monoFont]));
    const faces = (k: number) => `if (n === 0) { const r = await Promise.all(Object.keys(A).slice(0, ${k}).map((id) => new FontFace(id, "url(zrmotion://app/font/" + A[id].handle + ")").load().then(() => 1, () => 0))); log("FONTS", r.reduce((a, b) => a + b, 0)); }`;
    const sixteen = await render(f, "fonts16", { page: handPage(faces(16)), width: 64, height: 32, assets: many });
    check(!sixteen.error && logged(sixteen, "FONTS")[0] === 16 && sixteen.media?.fonts === 16, `16 fonts load (${sixteen.error?.message ?? JSON.stringify(logged(sixteen, "FONTS"))})`);
    const seventeen = await render(f, "fonts17", { page: handPage(faces(17)), width: 64, height: 32, assets: many });
    failedWith(seventeen, "graphic_font_cap", "a 17th font", /more than 16 fonts/);
    await leftNothing(seventeen, f, "fonts17", "font count cap");
    // A handle that is no font of the table (unknown, or an image's) is a 404 and takes no font slot.
    const strays = `if (n === 0) { log("STRAY", await Promise.all(["${"0".repeat(32)}", A.img.handle].map((h) => new FontFace("s", "url(zrmotion://app/font/" + h + ")").load().then(() => 1, () => 0)))); }`;
    const stray = await render(f, "fonts-stray", { page: handPage(`${strays} ${faces(16)}`), width: 64, height: 32, assets: { ...many, img: lib.big } });
    check(!stray.error && same(logged(stray, "STRAY")[0], [0, 0]) && logged(stray, "FONTS")[0] === 16 && stray.media?.fonts === 16,
      `an unknown handle and an image's handle on the font route fail and take no font slot: 16 fonts still load (${stray.error?.message ?? JSON.stringify([logged(stray, "STRAY"), logged(stray, "FONTS")])})`);
  } else {
    check(false, "a monospace font for the font rows (DejaVuSansMono or LiberationMono) is installed");
  }
  const before = touched.length;
  const huge = await render(f, "hugefont", { page: handPage(`await new FontFace("x", "url(zrmotion://app/font/" + A.huge.handle + ")").load();`), width: 64, height: 32, assets: { huge: font(fx.hugeFont) } });
  failedWith(huge, "graphic_font_cap", "a font file of 32 MB + 1 byte", /at most 32 MB/);
  const reads = touched.slice(before).filter((t) => t.includes(fx.hugeFont));
  check(reads.length > 0 && reads.every((t) => t.startsWith("stat ")), `the oversized font is measured, never read (${JSON.stringify(reads)})`);
  await leftNothing(huge, f, "hugefont", "font size cap");

  // One request past its time.
  const late = await render(f, "late", { graphic: { source: VIDEO_TSX("vid") }, width: 160, height: 90, caps: { requestMs: 1 }, assets: { vid: lib.small } });
  failedWith(late, "graphic_decode_timeout", "a request past its time", /took longer than/);
  await leftNothing(late, f, "late", "request timeout");
}

// ---- M5: offline and playlist ----------------------------------------------------------

const HAS_STRACE = spawnSync("strace", ["-V"]).status === 0;

async function m5(work: string, fx: Fixtures, lib: Record<string, MediaAsset>) {
  console.log("M5. an offline asset and a playlist-type asset...");
  if (!HAS_STRACE) return check(false, "strace is installed (M5 traces FFmpeg)");
  const f = fresh(work, "offline");
  const t0 = touched.length;
  const s0 = spawned.length;
  const off = { ...lib.small, path: "\\\\zr-evil-1.invalid\\s\\a.mp4", name: "a.mp4", awaitingServer: "zr-evil-1.invalid" };
  const run = await render(f, "offline", { graphic: { source: VIDEO_TSX("off") }, width: 160, height: 90, assets: { off } });
  check(run.error?.code === "media_offline" && same(run.error.hosts, ["zr-evil-1.invalid"]) && /offline/.test(run.error.message), `a video on a server not allowed: media_offline naming the server (${run.error ? `${run.error.code}: ${run.error.message}` : "it rendered"})`);
  check(run.messages.some((m) => m.type === "media"), "the refusal came when the page asked for it");
  await leftNothing(run, f, "offline", "offline asset");

  const playlist = join(fx.dir, "playlist.mp4");
  writeFileSync(playlist, "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n\\\\zr-evil-1.invalid\\s\\b.ts\n#EXTINF:1,\nhttp://zr-evil-2.invalid/c.ts\n#EXT-X-ENDLIST\n");
  const forged = { ...lib.small, path: playlist, name: "playlist.mp4" };
  const trace = join(work, "trace-playlist");
  tracePrefix = trace;
  const pl = await render(f, "playlist", { graphic: { source: VIDEO_TSX("pl") }, width: 160, height: 90, assets: { pl: forged } });
  tracePrefix = null;
  failedWith(pl, "graphic_media_failed", "a playlist renamed .mp4", /can't open this kind of file/);
  const lines = traces(trace).flat();
  check(lines.some((l) => l.includes(playlist)) && !lines.some((l) => l.includes(EVIL)), `FFmpeg opened the playlist and nothing it names (${lines.length} traced calls; ${JSON.stringify(lines.filter((l) => l.includes(EVIL)).slice(0, 3))})`);
  await leftNothing(pl, f, "playlist", "playlist asset");
  const evil = [...touched.slice(t0), ...spawned.slice(s0).map((a) => a.join(" "))].filter((t) => t.includes(EVIL));
  check(evil.length === 0, `no file call or command of the core named a zr-evil host (${JSON.stringify(evil.slice(0, 3))})`);
}

// ---- M6: files -----------------------------------------------------------------------

const MIXED_TSX = `import { AbsoluteFill, OffthreadVideo, Img, asset, loadFont, useCurrentFrame } from "remotion";
const { fontFamily } = loadFont(asset("mono"));
export default function G() {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <OffthreadVideo src={asset("vid")} style={{ position: "absolute", left: 0, top: 0 }} />
      <Img src={asset("img")} style={{ position: "absolute", left: 160, top: 0, width: 100, height: 50 }} />
      <div style={{ position: "absolute", left: 0, top: 100, color: "#fff", fontFamily, fontSize: 30 }}>Wg {f}</div>
    </AbsoluteFill>
  );
}`;

async function m6(work: string, fx: Fixtures, lib: Record<string, MediaAsset>) {
  console.log("M6. no file outside motion/<id> and no decoded frame file...");
  if (!fx.mono) return check(false, "a monospace font for M6 is installed");
  if (!HAS_STRACE) return check(false, "strace is installed (M6 traces FFmpeg)");
  const f = fresh(work, "files");
  const id = "files";
  const events: string[] = [];
  const watcher = watch(f.dir, { recursive: true }, (_e, name) => name && events.push(String(name).split("\\").join("/")));
  const t0 = touched.length;
  const trace = join(work, "trace-files");
  tracePrefix = trace;
  const run = await render(f, id, { graphic: { source: MIXED_TSX }, width: 320, height: 180, durationInFrames: 30, assets: { vid: lib.small, img: lib.big, mono: font(fx.mono) } });
  tracePrefix = null;
  await new Promise((r) => setTimeout(r, 200));
  watcher.close();
  const motion = `data/motion/${id}`;
  const out = `data/baked/${id}-graphic.mp4`;
  check(!run.error && run.media?.decodes === 31 && run.media.fonts === 1, `a video, an image and a font render (${run.error?.message ?? JSON.stringify(run.media)})`);
  const outside = [...new Set(events)].filter((p) => p !== "data/motion" && !p.startsWith(`${motion}/`) && p !== motion && p !== out);
  check(events.length > 0 && outside.length === 0, `the watched folders saw writes only in motion/${id} and the output (${events.length} events; outside: ${JSON.stringify(outside.slice(0, 5))})`);
  const frameFiles = [...new Set(events)].filter((p) => /\.(png|rgba|raw|bmp|jpe?g)$/i.test(p));
  check(frameFiles.length === 0, `no decoded frame file was written (${JSON.stringify(frameFiles.slice(0, 5))})`);
  const WRITES = /^(writeFile|appendFile|mkdir|mkdtemp|rename|copyFile|cp|truncate|link|symlink|open|utimes|chmod|rm) /;
  const workDir = join(f.data, "motion", id);
  const ours = touched.slice(t0).filter((t) => WRITES.test(t));
  const stray = ours.filter((t) => t.split(" ").slice(1).some((p) => !p.startsWith(workDir) && p !== join(f.data, "baked", `${id}-graphic.mp4`) && !p.startsWith(fx.dir) && !p.includes("/packages/motion/")));
  check(ours.length > 0 && stray.length === 0, `the core's file calls wrote only in motion/${id} and the output (${ours.length} calls; stray ${JSON.stringify(stray.slice(0, 3))})`);
  const decodes = traces(trace).filter(isDecode);
  const writes = decodes.flat().filter((l) => /open(at)?\(.*O_(WRONLY|RDWR|CREAT)/.test(l));
  check(decodes.length === 2 && writes.length === 0, `FFmpeg's decodes (${decodes.length} traced) opened no file for writing (${JSON.stringify(writes.slice(0, 3))})`);
  await leftNothing(run, f, id, "files");
}

// ---- M7: fonts -----------------------------------------------------------------------

const FONT_TSX = `import { AbsoluteFill, asset, loadFont } from "remotion";
const { fontFamily } = loadFont(asset("mono"));
const line = { position: "absolute", left: 4, fontSize: 40, color: "#fff", whiteSpace: "nowrap" };
export default function G() {
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <div style={{ ...line, top: 0, fontFamily }}>Wil 1 g</div>
      <div style={{ ...line, top: 60 }}>Wil 1 g</div>
    </AbsoluteFill>
  );
}`;

async function m7(work: string, fx: Fixtures) {
  console.log("M7. a library font renders...");
  if (!fx.mono) return check(false, "a monospace font for M7 is installed");
  const f = fresh(work, "fonts");
  const run = await render(f, "font", { graphic: { source: FONT_TSX }, width: 320, height: 120, assets: { mono: font(fx.mono) } });
  const fr = run.frames[0];
  // The two lines' pixels: the library font's (rows 0..59) against the fallback's (rows 60..119).
  let ink = 0;
  let differ = 0;
  for (let y = 0; fr && y < 60; y++) {
    for (let x = 0; x < 320; x++) {
      const a = fr[(y * 320 + x) * 4 + 1];
      const b = fr[((y + 60) * 320 + x) * 4 + 1];
      if (a > 128) ink++;
      if (Math.abs(a - b) > 64) differ++;
    }
  }
  check(!run.error && ink > 200 && differ > 200, `the library font's glyphs differ from the fallback's (${run.error?.message ?? `${ink} inked pixels, ${differ} differ`})`);
  await leftNothing(run, f, "font", "library font");
}

// ---- M8: measure ---------------------------------------------------------------------

async function m8(work: string, fx: Fixtures) {
  console.log("M8. measure: a 60 s, 30 fps graphic with one full-canvas 1920x1080 video...");
  const clip = join(fx.dir, "clip60.mp4");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=60", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "60", "-preset", "veryfast", clip]);
  const f = fresh(work, "measure");
  const asset = await probeAsset(clip);
  const run = await render(f, "measure", { graphic: { source: VIDEO_TSX("clip") }, width: 1920, height: 1080, durationInFrames: 1800, assets: { clip: asset } }, false);
  const total = 120_000 + 1000 * 1800;
  check(!run.error && run.media?.decodes === 1800 && run.media.spawns === 1 && run.ms < total, `1,800 frames, 1,800 decodes from one FFmpeg process, within the caps (${run.error?.message ?? `${run.ms} ms of ${total}; ${JSON.stringify(run.media)}`})`);
  console.log(`       measure: ${run.ms} ms in all, ${(run.ms / 1800).toFixed(1)} ms per 1920x1080 frame with its decode, capture and H.264 encode`);
  await leftNothing(run, f, "measure", "measure");
}

// ---- M9: hardening -------------------------------------------------------------------

/** The media decodes the core has started (FFmpeg writing PNGs to its stdout). */
const decodesStarted = () => spawned.filter((a) => a[0] === FFMPEG_BIN && a.includes("image2pipe")).length;

async function m9(work: string, _fx: Fixtures, lib: Record<string, MediaAsset>) {
  console.log("M9. asset records checked, the frame-count search bounded...");
  const f = fresh(work, "hardening");
  const audio = { ...lib.small, hasVideo: false, hasAudio: true, isImage: undefined };
  // Records of real files with numbers no probe of a real file gives (forged or misread): none reaches the page.
  const refused: Record<string, MotionAsset> = {
    fpsNaN: { ...lib.small, fps: NaN },
    fpsZero: { ...lib.small, fps: 0 },
    fpsHigh: { ...lib.small, fps: MAX_ASSET_FPS + 1 },
    // 0.01 s at 30 fps is no whole frame: frame count 0.
    noFrame: { ...lib.small, duration: 0.01 },
    // Its duration at its fps is Infinity.
    endless: { ...lib.small, duration: Number.MAX_VALUE },
    durNaN: { ...lib.small, duration: NaN },
    halfPixel: { ...lib.small, width: 160.5 },
    imgNaN: { ...lib.big, height: NaN },
    audNaN: { ...audio, duration: NaN },
    audInf: { ...audio, duration: Infinity },
  };
  const kept: Record<string, MotionAsset> = { fpsMax: { ...lib.small, fps: MAX_ASSET_FPS }, oneFrame: { ...lib.small, duration: 1 / 30 } };
  const table = await render(f, "records", { page: handPage(`log("ASSETS", Object.keys(A));`), width: 64, height: 32, assets: { ...refused, ...kept } });
  const ta = table.start?.assets ?? {};
  check(!table.error && same(Object.keys(ta), Object.keys(kept)) && same(logged(table, "ASSETS")[0], Object.keys(kept)),
    `records with fps NaN, 0 or ${MAX_ASSET_FPS + 1}, frame count 0 or no number, duration NaN, a size not whole, an image with no height and audio of NaN or Infinity seconds are left out of the table (${table.error?.message ?? JSON.stringify(Object.keys(ta))})`);
  check(ta.fpsMax?.fps === MAX_ASSET_FPS && ta.oneFrame?.frameCount === 1, `a video at ${MAX_ASSET_FPS} fps and one of one frame are kept (${JSON.stringify([ta.fpsMax, ta.oneFrame])})`);
  await leftNothing(table, f, "records", "asset records");
  for (const id of ["fpsNaN", "noFrame", "fpsHigh"]) {
    const d0 = decodesStarted();
    const run = await render(f, `refused-${id}`, { graphic: { source: VIDEO_TSX(id) }, width: 160, height: 90, assets: refused });
    failedWith(run, "graphic_asset_unknown", `a graphic that uses the record ${id}`, new RegExp(id));
    check(decodesStarted() === d0 && run.ms < 30_000, `the record ${id}: no decode started, and the render ended in ${run.ms} ms`);
    await leftNothing(run, f, `refused-${id}`, `the record ${id}`);
  }

  // A request past a video's real end searches for it (realFrames): each of the search's decodes counts toward the cap.
  const past = (id: string, asset: MediaAsset, t: number, caps?: RenderMotionOptions["caps"]) =>
    render(f, id, { page: handPage(`log("SIZE", await load(media(A.v, "t=${t}&w=160&h=90"), true));`), width: 160, height: 90, assets: { v: asset }, caps });
  /** After a render: no FFmpeg the core started since `p0` is left. */
  const noFfmpeg = async (p0: number, what: string) => {
    const left = await gone(ffmpegPids.slice(p0), 2000);
    check(ffmpegPids.length > p0 && left.length === 0, `${what}: no FFmpeg process left (${ffmpegPids.length - p0} started, left ${JSON.stringify(left)})`);
  };
  // The real 0.1 fps video (4 frames, 60 s of audio), frame 5: the first decode, 2 search passes, the last frame's decode.
  const slowT = Math.round(lib.slow.duration * lib.slow.fps) - 1;
  let p0 = ffmpegPids.length;
  const slow = await past("slow-search", lib.slow, slowT);
  check(!slow.error && same(logged(slow, "SIZE")[0], { w: 160, h: 90 }) && slow.media?.decodes === 4 && slow.media.spawns === 4,
    `frame ${slowT} of the 0.1 fps video with 4 frames: its last frame, 4 decodes counted for 4 FFmpeg processes (${slow.error?.message ?? JSON.stringify(slow.media)})`);
  await leftNothing(slow, f, "slow-search", "0.1 fps search");
  await noFfmpeg(p0, "0.1 fps search");
  p0 = ffmpegPids.length;
  const slowCap = await past("slow-cap", lib.slow, slowT, { decodes: 3 });
  failedWith(slowCap, "graphic_media_decodes_cap", "the 0.1 fps video's search with a cap of 3 decodes");
  check(slowCap.media?.spawns === 3, `the search stopped at the cap: 3 FFmpeg processes (${JSON.stringify(slowCap.media)})`);
  await leftNothing(slowCap, f, "slow-cap", "0.1 fps search at the cap");
  await noFfmpeg(p0, "0.1 fps search at the cap");

  // The 4 s file under a record of 1,000,000 s at 1 fps: 11 passes (2 s ... 2 * 4^10 s back) reach frame 0.
  const long = { ...lib.small, fps: 1, duration: 1e6 };
  p0 = ffmpegPids.length;
  const longRun = await past("long-search", long, 999_999);
  check(!longRun.error && same(logged(longRun, "SIZE")[0], { w: 160, h: 90 }) && longRun.media?.decodes === 13 && longRun.media.spawns === 13,
    `frame 999999 of a 1,000,000 s record of a 4 s file: its last frame, 13 decodes counted (the first, 11 search passes, the last frame's) for 13 FFmpeg processes (${longRun.error?.message ?? JSON.stringify(longRun.media)})`);
  await leftNothing(longRun, f, "long-search", "long search");
  await noFfmpeg(p0, "long search");
  p0 = ffmpegPids.length;
  const longCap = await past("long-cap", long, 999_999, { decodes: 5 });
  failedWith(longCap, "graphic_media_decodes_cap", "the long search with a cap of 5 decodes");
  check(longCap.media?.spawns === 5, `the long search stopped at the cap: 5 FFmpeg processes (${JSON.stringify(longCap.media)})`);
  await leftNothing(longCap, f, "long-cap", "long search at the cap");
  await noFfmpeg(p0, "long search at the cap");
  // 2^33 s at 1 fps: 16 passes reach 2 * 4^15 s back, not frame 0; the search ends there.
  p0 = ffmpegPids.length;
  const huge = await past("huge-search", { ...lib.small, fps: 1, duration: 2 ** 33 }, 2 ** 33 - 1);
  failedWith(huge, "graphic_media_failed", "a record of 2^33 s of a 4 s file", /ends long before/);
  check(huge.media?.decodes === 1 + SEARCH_PASSES && huge.media.spawns === 1 + SEARCH_PASSES, `it stopped after ${SEARCH_PASSES} search passes: ${1 + SEARCH_PASSES} decodes counted for as many FFmpeg processes (${JSON.stringify(huge.media)})`);
  await leftNothing(huge, f, "huge-search", "pass cap");
  await noFfmpeg(p0, "pass cap");

  // A close (the render ends) as the search's 3rd pass starts its decode: no pass after it starts one.
  const mm = new MotionMedia({ v: long }, { width: 160, height: 90, caps: { ...MEDIA_CAPS }, requireMedia: requireOnline });
  const d0 = decodesStarted();
  p0 = ffmpegPids.length;
  let closed: Promise<void> | undefined;
  beforeDecode = () => {
    if (decodesStarted() - d0 === 4) closed = mm.close();
  };
  let err: (Error & { code?: string }) | undefined;
  try {
    await mm.answer({ id: 1, route: "media", handle: mm.page.v.handle, t: 999_999, w: 160, h: 90, frame: 0 });
  } catch (e) {
    err = e as typeof err;
  } finally {
    beforeDecode = null;
  }
  await closed;
  check(!!closed && err?.code === "graphic_render_canceled" && decodesStarted() - d0 === 4,
    `a close as the 3rd search pass starts: graphic_render_canceled, and no decode after it (${err ? `${err.code}: ${err.message}` : "it answered"}; ${decodesStarted() - d0} decodes started)`);
  await noFfmpeg(p0, "close during the search");
}

// ---- main ----------------------------------------------------------------------------

let summarized = false;

async function main() {
  const args = process.argv.slice(2);
  reexecInNetns(fileURLToPath(import.meta.url), args, "10.99.0.1");
  const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
  const part = (name: string) => !only || only.includes(name);
  if (!LINUX) {
    console.log("  skip M1-M9: they read /proc and run Linux's Electron");
  } else {
    const work = mkdtempSync(join(tmpdir(), "zr-motion-media-"));
    try {
      const fx = fixtures(work);
      const lib: Record<string, MediaAsset> = {};
      for (const [k, p] of Object.entries({ hd: fx.hd, small: fx.small, tail: fx.tail, gap: fx.gap, slow: fx.slow, vfr: fx.vfr, late: fx.late, big: fx.big, red: fx.red, noise: fx.noise })) lib[k] = await probeAsset(p);
      if (part("M1")) await m1(work, fx, lib);
      if (part("M2")) await m2(work, fx, lib);
      if (part("M3")) await m3(work, fx, lib);
      if (part("M4")) await m4(work, fx, lib);
      if (part("M5")) await m5(work, fx, lib);
      if (part("M6")) await m6(work, fx, lib);
      if (part("M7")) await m7(work, fx);
      if (part("M8")) await m8(work, fx);
      if (part("M9")) await m9(work, fx, lib);
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 5 });
    }
  }
  summarized = true;
  const failures = failureCount();
  console.log(failures === 0 ? "\nALL MOTION MEDIA CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
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
