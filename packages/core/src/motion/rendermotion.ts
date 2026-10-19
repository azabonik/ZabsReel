import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { PRODUCT_NAME } from "../brand.js";
import { adaptFfmpegArgs, FfmpegError, ffmpegStderrDetail, runTool, spawnFfmpegStream } from "../ffmpeg/executor.js";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "../io/gatedfs.js";
import { graphicModule, type GraphicStart } from "./graphicmodule.js";
import { AUDIO_CAPS, GraphicAudio, mixGraphicAudio, mixLimitMs, type AudioCaps, type AudioStats } from "./motionaudio.js";
import { GRAPHIC_CODES, MotionRenderError, type GraphicCode } from "./motionerror.js";
import { MEDIA_CAPS, MotionMedia, parseMediaRequest, requireOnline, type MediaCaps, type MediaReply, type MediaStats, type MotionAsset } from "./motionmedia.js";
import { graphicPreviewProxy, tagGraphicColor } from "./render.js";
import { rendererBinary, type RendererBinary } from "./rendererbinary.js";

/**
 * The core's side of ZabsReel's own motion renderer (MOTION-PLAN D2): it
 * starts one renderer process per render (rendererbinary.ts picks the
 * executable; main.cjs dispatches to @aive/motion's motion-renderer.cjs),
 * sends it the page's table, asks for each frame, and pipes the frames into
 * FFmpeg (executor.ts). The pipes and their formats are described at the top
 * of motion-renderer.cjs. The graphic's TSX is compiled here, and its imports
 * checked, before the renderer starts (graphicmodule.ts); the page runs it on
 * the clean-room runtime (MOTION-PLAN D5). The graphic's library media and
 * fonts reach the page only as the core's answers to its requests, on fd 4
 * (motionmedia.ts; MOTION-PLAN D4). Its sound comes back as cues with each
 * frame; once the video is encoded the core mixes them (motionaudio.ts; D4
 * E3): into a standalone card's .mp4, or for an overlay into a .wav of its
 * own that the caller places as a linked audio clip.
 *
 * Everything a render writes stays in its motion/<id> folder (workDir) until
 * the whole render has succeeded; only then are the files moved into baked/,
 * all of them or none. Every failure (abort, a limit, a crash, an FFmpeg
 * error) kills the renderer by its PID and removes workDir. Each render's
 * workDir holds owner.json with the core's PID, and the next core start
 * removes the folders of cores that are gone ({@link sweepMotionScratch}).
 */

/**
 * The renderer's environment, D2's allowlist and nothing else: these
 * variables of the core's (PATH, SystemRoot, windir, LANG, LC_ALL, HOME,
 * USERPROFILE, DISPLAY, WAYLAND_DISPLAY, XDG_RUNTIME_DIR), TEMP/TMP/TMPDIR and
 * XDG_CACHE_HOME in the render's folder (Chromium's fontconfig writes its
 * font cache there, not in HOME), and GSETTINGS_BACKEND=memory (GTK's
 * settings stay in memory instead of dconf's files in HOME). Never AIVE_*,
 * ELECTRON_* or NODE_OPTIONS.
 */
export const RENDERER_ENV = ["PATH", "SystemRoot", "windir", "LANG", "LC_ALL", "HOME", "USERPROFILE", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"] as const;
/** The longest graphic: 600 s at 60 fps. */
export const MAX_MOTION_FRAMES = 36_000;
const OWNER = "owner.json";
/** Longest control line the renderer may send. */
const MAX_LINE = 1024 * 1024;

export { GRAPHIC_CODES, MotionRenderError, type GraphicCode, type MotionErrorCode } from "./motionerror.js";

/** Why the renderer can't run (D7); "start-failed" is any other failed start. */
export type RendererUnavailableReason = "no-binary" | "no-display" | "sandbox-unavailable" | "start-failed";

/**
 * What add_graphic says when ZabsReel's renderer can't run here (D7):
 * `reason` is get_state's graphicsReason, and what the agent can do.
 */
export function rendererUnavailableMessage(reason: RendererUnavailableReason, detail: string): string {
  return `${PRODUCT_NAME}'s graphics renderer can't start here (${reason}: ${detail}). Graphics can't be made with it on this computer now; tell the user. They can choose the Remotion add-on as the graphics renderer in the ${PRODUCT_NAME} window (Help → Graphics add-on…).`;
}

/** graphic_renderer_unavailable with its reason (D7): the renderer has no binary, or could not start. */
export class RendererUnavailableError extends MotionRenderError {
  constructor(
    readonly reason: RendererUnavailableReason,
    readonly detail: string,
  ) {
    super("graphic_renderer_unavailable", rendererUnavailableMessage(reason, detail));
    this.name = "RendererUnavailableError";
  }
}

/** The renderer's limits (D2); tests pass shorter ones. */
export interface MotionLimits {
  /** One frame, and the page's first load. */
  frameMs: number;
  /** The whole render: 120 s + 1 s per frame. */
  totalMs: number;
  /** The audio mix (and a standalone card's mux): 60 s + 2 x the graphic's length. */
  mixMs: number;
}

/** The largest props a graphic takes: their JSON text in UTF-8 (D5). */
export const MAX_GRAPHIC_PROPS_BYTES = 256 * 1024;

export interface RenderMotionOptions {
  /**
   * The graphic: TSX that default-exports a React component, and its props
   * (JSON only, at most {@link MAX_GRAPHIC_PROPS_BYTES}). The core compiles it
   * into the page's module.js. Exactly one of `graphic` and `module`.
   */
  graphic?: { source: string; props?: Record<string, unknown> };
  /**
   * Tests: a hand-written page script as module.js instead of a graphic (it
   * calls zrMotion.onFrame(fn) itself), or a function that writes it from
   * the render's start data (its asset handles).
   */
  module?: string | ((start: GraphicStart) => string);
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  /** true: an overlay, ProRes 4444 with alpha (.mov); false: a standalone card, opaque H.264 (.mp4). */
  alpha: boolean;
  /** The render's own folder, <dataDir>/motion/<id>: made here and removed when the render ends. */
  workDir: string;
  /** The result in <dataDir>/baked, written only once the whole render succeeded. */
  outPath: string;
  /** Overlay only: the .webm preview proxy in baked/ (best-effort, as today). */
  previewPath?: string;
  /**
   * Overlay only: where its sound goes in baked/ when it has any (a 48 kHz
   * stereo .wav). Default: outPath's name with "-audio.wav" for its
   * extension (baked/<id>-graphic-audio.wav for baked/<id>-graphic.mov).
   */
  audioPath?: string;
  /**
   * The graphic's assets: asset id -> the core's own record (a library
   * MediaAsset, or a font file). The page learns each one's kind and sizes
   * under a random per-render handle, never its path or name, and the core
   * answers the page's requests for it (motionmedia.ts).
   */
  assets?: Readonly<Record<string, MotionAsset>>;
  /**
   * G4 for an asset the page asks for: throws MediaOfflineError (media_offline)
   * when its file may not or can't be opened. Default: motionmedia.ts
   * requireOnline; the engine passes its own check.
   */
  requireMedia?: (asset: MotionAsset) => void;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  /**
   * Tests: the binary rule's answer, the limits, the page's heap (MB), table
   * entries replaced or added, the frames to render in this order (default
   * 0..durationInFrames-1; the encode gets them in that order), the
   * environment, and the renderer's messages, frame bytes (as they arrive on
   * fd 3), PID and exit.
   */
  binary?: RendererBinary;
  limits?: Partial<MotionLimits>;
  /** Tests: D4's media caps (motionmedia.ts MEDIA_CAPS) and audio caps (motionaudio.ts AUDIO_CAPS), and the media counters when the render ends, failed or not. */
  caps?: Partial<MediaCaps>;
  audioCaps?: Partial<AudioCaps>;
  onMedia?: (stats: MediaStats) => void;
  heapMb?: number;
  entries?: Record<string, string>;
  frames?: number[];
  env?: NodeJS.ProcessEnv;
  onMessage?: (msg: RendererMessage) => void;
  onFrameData?: (chunk: Buffer) => void;
  onSpawn?: (pid: number) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/** A control line from the renderer. */
export interface RendererMessage {
  type?: string;
  [key: string]: unknown;
}

export interface RenderMotionResult {
  outPath: string;
  previewPath?: string;
  /** Milliseconds from the renderer's start to the last frame. */
  framesMs: number;
  /** What its media requests did. */
  media: MediaStats;
  /** Overlay only: its sound in baked/, when it has any (a standalone card's is in outPath). */
  audioPath?: string;
  /** What its audio cues did. */
  audio: AudioStats;
}

/**
 * motion-renderer.cjs's MIN_WINDOW: its window is never smaller (Windows keeps one at least
 * 32x31), and a smaller graphic is captured from the window's top-left corner.
 */
export const RENDERER_MIN_WINDOW = 64;

/** The renderer's environment for a render in `scratch` (see {@link RENDERER_ENV}). */
export function rendererEnv(scratch: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of RENDERER_ENV) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  const tmp = join(scratch, "tmp");
  out.TEMP = out.TMP = out.TMPDIR = out.XDG_CACHE_HOME = tmp;
  out.GSETTINGS_BACKEND = "memory";
  return out;
}

/**
 * The renderer's arguments after the binary rule's: the core's PID, the
 * render's folder, the heap, and on Linux Chromium's headless platform (no
 * display needed; slice 1 measured X11 failing without one) with a screen
 * large enough for the page's window: at least RENDERER_MIN_WINDOW a side,
 * since the headless screen also bounds the window.
 */
export function rendererArgs(scratch: string, width: number, height: number, extra: string[] = []): string[] {
  const screen = `${Math.max(width, RENDERER_MIN_WINDOW)},${Math.max(height, RENDERER_MIN_WINDOW)}`;
  const linux = process.platform === "linux" ? ["--ozone-platform=headless", `--ozone-override-screen-size=${screen}`] : [];
  return [`--zr-parent-pid=${process.pid}`, `--zr-scratch=${scratch}`, "--mute-audio", ...linux, ...extra];
}

/** The folder of @aive/motion: renderer/ (the page and its scripts), vendor/ (React), dist/ (the runtime), cleanroom/runtime/exports.json. */
function motionDir(): string {
  return dirname(createRequire(import.meta.url).resolve("@aive/motion/package.json"));
}

/** The runtime's export list (the names a graphic may take from remotion or @aive/motion). */
async function runtimeExports(): Promise<ReadonlySet<string>> {
  const json = JSON.parse(await readFile(join(motionDir(), "cleanroom", "runtime", "exports.json"), "utf8")) as { exports: string[] };
  return new Set(json.exports);
}

const TEXT = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8" };

/** The zrmotion table: path -> { type, body (base64) }; page.html loads the scripts in this order. */
async function pageTable(o: RenderMotionOptions, module: string): Promise<{ path: string; type: string; body: string }[]> {
  const dir = motionDir();
  const read = async (...p: string[]) => {
    try {
      return await readFile(join(dir, ...p), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && p[0] === "dist") throw new Error(`${p.join("/")} of @aive/motion is missing: run npm run build`);
      throw err;
    }
  };
  const files: Record<string, string> = {
    "page.html": await read("renderer", "page.html"),
    "guard.js": await read("renderer", "guard.js"),
    "react.production.min.js": await read("vendor", "react-18.3.1", "react.production.min.js"),
    "react-dom.production.min.js": await read("vendor", "react-18.3.1", "react-dom.production.min.js"),
    "loader.js": await read("renderer", "loader.js"),
    "zr-runtime.js": await read("dist", "zr-runtime.js"),
    "host.js": await read("renderer", "host.js"),
    "module.js": module,
    ...o.entries,
  };
  return Object.entries(files).map(([path, text]) => ({
    path,
    type: path.endsWith(".html") ? TEXT.html : TEXT.js,
    body: Buffer.from(text, "utf8").toString("base64"),
  }));
}

/**
 * FFmpeg's encode of the raw frames on its stdin: an overlay unpremultiplied
 * then ProRes 4444 with alpha, a standalone card H.264; both with FFmpeg's
 * default RGB to YUV (BT.601, limited range, untagged), as render.ts's
 * Remotion files are (FFMPEG_DEFAULT_CODING).
 */
export function encodeArgs(o: Pick<RenderMotionOptions, "width" | "height" | "fps" | "alpha">, out: string): string[] {
  const input = ["-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${o.width}x${o.height}`, "-framerate", String(o.fps), "-i", "pipe:0"];
  const codec = o.alpha
    ? ["-vf", "unpremultiply=inplace=1", "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"]
    : ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart"];
  return ["-hide_banner", "-loglevel", "error", "-y", ...input, ...codec, "-an", out];
}

/** renderMotion's input bounds (D2, F10), checked before anything is started or written; exported for the smoke's boundary rows. */
export function checkOptions(o: RenderMotionOptions): void {
  const int = (v: number, max: number) => Number.isInteger(v) && v >= 1 && v <= max;
  if (!int(o.width, 8192) || !int(o.height, 8192)) throw new RangeError(`A graphic is 1 to 8192 pixels on each side (${o.width}x${o.height}).`);
  if (!int(o.durationInFrames, MAX_MOTION_FRAMES)) throw new RangeError(`A graphic is 1 to ${MAX_MOTION_FRAMES} frames long (${o.durationInFrames}).`);
  if (!(o.fps > 0 && o.fps <= 240)) throw new RangeError(`A graphic's frame rate is above 0 and at most 240 (${o.fps}).`);
  if ((o.graphic === undefined) === (o.module === undefined)) throw new TypeError("renderMotion needs a graphic or (tests) a module, and not both.");
  if (o.frames && !(o.frames.length > 0 && o.frames.every((n) => Number.isInteger(n) && n >= 0 && n < o.durationInFrames))) throw new RangeError(`Frames to render are whole numbers from 0 to ${o.durationInFrames - 1}.`);
  if (o.graphic) {
    if (typeof o.graphic.source !== "string") throw new TypeError("A graphic's code is TSX text.");
    const props = o.graphic.props ?? {};
    let json: string | undefined;
    try {
      json = typeof props === "object" && props !== null && !Array.isArray(props) ? JSON.stringify(props) : undefined;
    } catch {
      json = undefined;
    }
    if (json === undefined) throw new TypeError("A graphic's props are one JSON object.");
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > MAX_GRAPHIC_PROPS_BYTES) throw new RangeError(`A graphic's props are at most ${MAX_GRAPHIC_PROPS_BYTES / 1024} KB of JSON (${Math.ceil(bytes / 1024)} KB). Pass less data, or move large data out of the props.`);
  }
}

/** The renderer's limits for `o` (D2): 30 s per frame, 120 s + 1 s per frame in all. */
function limitsOf(o: RenderMotionOptions): MotionLimits {
  return { frameMs: 30_000, totalMs: 120_000 + 1000 * o.durationInFrames, mixMs: mixLimitMs(o.durationInFrames, o.fps), ...o.limits };
}

/**
 * module.js for `o`: the hand-written module of a test, or the graphic
 * compiled, its imports checked (graphicmodule.ts), with the page's asset
 * table. A refused graphic throws here, before anything is started or
 * written.
 */
async function pageModule(o: RenderMotionOptions, limits: MotionLimits, assets: GraphicStart["assets"]): Promise<string> {
  const props = JSON.parse(JSON.stringify(o.graphic?.props ?? {})) as Record<string, unknown>;
  const start: GraphicStart = {
    composition: { id: "Graphic", width: o.width, height: o.height, fps: o.fps, durationInFrames: o.durationInFrames, props },
    assets,
    // Below the core's own frame limit, so the runtime's message (it names the open delayRender labels) comes first.
    frameTimeoutMs: Math.max(Math.round(limits.frameMs / 2), limits.frameMs - 2000),
  };
  if (!o.graphic) return typeof o.module === "function" ? o.module(start) : (o.module as string);
  const built = graphicModule(o.graphic.source, start, await runtimeExports());
  if (!built.ok) throw new MotionRenderError(built.code, built.message);
  return built.module;
}

/**
 * Render `o.module`'s frames with ZabsReel's renderer and encode them to
 * `o.outPath` (and the overlay's preview to `o.previewPath`). Rejects with a
 * {@link MotionRenderError} (or FFmpeg's error) after removing everything it
 * wrote; baked/ then holds nothing of this render.
 */
export async function renderMotion(o: RenderMotionOptions): Promise<RenderMotionResult> {
  checkOptions(o);
  const limits = limitsOf(o);
  const requireMedia = o.requireMedia ?? requireOnline;
  const media = new MotionMedia(o.assets ?? {}, { width: o.width, height: o.height, caps: { ...MEDIA_CAPS, ...o.caps }, requireMedia });
  const audio = new GraphicAudio((handle) => media.source(handle), { fps: o.fps, caps: { ...AUDIO_CAPS, ...o.audioCaps }, requireMedia });
  const module = await pageModule(o, limits, media.page);
  const encoded = join(o.workDir, o.alpha ? "out.mov" : "out.mp4");
  const preview = join(o.workDir, "graphic.webm");
  const audioPath = o.audioPath ?? `${o.outPath.replace(/\.[^./\\]*$/, "")}-audio.wav`;
  try {
    // owner.json before anything else goes in: a core killed before it leaves an empty folder (sweepMotionScratch).
    await mkdir(o.workDir, { recursive: true });
    await writeFile(join(o.workDir, OWNER), JSON.stringify({ pid: process.pid }), "utf8");
    await mkdir(join(o.workDir, "tmp"), { recursive: true });
    const framesMs = await renderFrames(o, encoded, module, limits, media, audio);
    if (!o.alpha) await tagGraphicColor(encoded, o.signal);
    // The sound (D4 E3): mixed inside workDir; a standalone card's goes into its .mp4, an overlay's stays a .wav.
    const ranges = audio.ranges();
    let video = encoded;
    let wav: string | undefined;
    if (ranges.length > 0) {
      const mixed = join(o.workDir, "graphic-audio.wav");
      const muxed = join(o.workDir, "out-mux.mp4");
      try {
        await mixGraphicAudio({
          ranges,
          pathOf: (handle) => media.source(handle)!.asset.path,
          fps: o.fps,
          durationInFrames: o.durationInFrames,
          wav: mixed,
          mux: o.alpha ? undefined : { video: encoded, out: muxed },
          workDir: o.workDir,
          limitMs: limits.mixMs,
          signal: o.signal,
        });
      } catch (err) {
        if (o.signal?.aborted) throw canceled();
        throw err;
      }
      if (o.alpha) wav = mixed;
      else video = muxed;
    }
    let previewMade = false;
    if (o.alpha && o.previewPath) {
      try {
        await graphicPreviewProxy(encoded, preview);
        previewMade = true;
      } catch {
        // Best-effort, as today: a failed proxy only means no live preview.
      }
    }
    if (o.signal?.aborted) throw canceled();
    await moveAll([
      [video, o.outPath],
      ...(wav ? [[wav, audioPath] as const] : []),
      ...(previewMade && o.previewPath ? [[preview, o.previewPath] as const] : []),
    ]);
    return { outPath: o.outPath, previewPath: previewMade ? o.previewPath : undefined, audioPath: wav ? audioPath : undefined, framesMs, media: { ...media.stats }, audio: { ...audio.stats } };
  } finally {
    await media.close();
    o.onMedia?.({ ...media.stats });
    await rm(o.workDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}

const canceled = () => new MotionRenderError("graphic_render_canceled", "Motion-graphic render canceled");

/** Move every [from, to] (rename, or copy then remove across disks); on any failure remove the ones already moved, so `to` holds all or none. */
async function moveAll(moves: (readonly [string, string])[]): Promise<void> {
  const done: string[] = [];
  try {
    for (const [from, to] of moves) {
      try {
        await rename(from, to);
        done.push(to);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        await copyFile(from, to);
        // `to` is written now: a failing rm(from) below must still take it back out.
        done.push(to);
        await rm(from, { force: true });
      }
    }
  } catch (err) {
    for (const to of done) await rm(to, { force: true }).catch(() => {});
    throw err;
  }
}

/** Calls `onLine` for each newline-terminated line of `stream`; `onOverflow` when one passes {@link MAX_LINE}. */
function readLines(stream: Readable, onLine: (line: string) => void, onOverflow: () => void): void {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
    if (buf.length > MAX_LINE) {
      buf = "";
      onOverflow();
    }
  });
}

/** Resolves when `stream` has ended (at once if it has, or there is none). */
function ended(stream: Readable | null | undefined): Promise<void> {
  if (!stream || stream.readableEnded || stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once("end", () => resolve());
    stream.once("close", () => resolve());
  });
}

/** The last `max` characters of what `stream` wrote. */
function tail(stream: Readable | null | undefined, max = 8192): () => string {
  let text = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    text = (text + chunk).slice(-max);
  });
  return () => text;
}

type Spawned = ReturnType<typeof runTool>;

/**
 * Resolves when `child` has exited (at once if it already has), or never
 * started: a failed start (EACCES, ENOENT) emits "error" and no "exit", and
 * leaves no PID.
 */
function exited(child: Spawned): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

const startFailed = (err: Error) => new RendererUnavailableError("start-failed", err.message);

/** Start the renderer for the binary rule's command, with only the allowlisted environment and five pipes. */
function spawnRenderer(bin: Extract<RendererBinary, { ok: true }>, args: string[], scratch: string, env?: NodeJS.ProcessEnv): Spawned {
  return runTool(bin.command, [...bin.args, ...args], {
    env: rendererEnv(scratch, env),
    extendEnv: false,
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    buffer: false,
    reject: false,
    windowsHide: true,
  });
}

/** A failed frame the page reported: its code if the page may report it (else graphic_component_error), and its message. */
function pageFailure(msg: RendererMessage): MotionRenderError {
  const code = (GRAPHIC_CODES as readonly unknown[]).includes(msg.code) ? (msg.code as GraphicCode) : "graphic_component_error";
  return new MotionRenderError(code, `The graphic failed at frame ${String(msg.n)}: ${String(msg.message)}`);
}

/**
 * Writes `reply` to the renderer's fd 4 as one record: request id, status and
 * length (u32, big-endian), then the bytes (motion-renderer.cjs reads it).
 */
function writeReply(out: Writable, id: number, reply: MediaReply): void {
  const head = Buffer.alloc(12);
  head.writeUInt32BE(id, 0);
  head.writeUInt32BE(reply.status, 4);
  head.writeUInt32BE(reply.body.length, 8);
  out.write(head);
  if (reply.body.length > 0) out.write(reply.body);
}

/**
 * The renderer and FFmpeg for one render: frames 0..N-1 (or `o.frames`) into
 * `encoded`, each frame's audio cues into `audio`. Returns the milliseconds
 * the frames took.
 */
async function renderFrames(o: RenderMotionOptions, encoded: string, module: string, limits: MotionLimits, media: MotionMedia, audio: GraphicAudio): Promise<number> {
  const bin = o.binary ?? rendererBinary();
  if (!bin.ok) throw new RendererUnavailableError(bin.reason, bin.detail);
  const order = o.frames ?? Array.from({ length: o.durationInFrames }, (_, n) => n);
  const frameSize = o.width * o.height * 4;
  const total = frameSize * order.length;
  const table = await pageTable(o, module);
  const heap = o.heapMb === undefined ? [] : [`--zr-heap-mb=${o.heapMb}`];

  // FFmpeg's arguments before the renderer starts, and a failed FFmpeg start kills it: no renderer outlives a throw here.
  const ffArgs = await adaptFfmpegArgs(encodeArgs(o, encoded));
  const started = Date.now();
  const child = spawnRenderer(bin, rendererArgs(o.workDir, o.width, o.height, heap), o.workDir, o.env);
  if (child.pid !== undefined) o.onSpawn?.(child.pid);
  const encoder = () => spawnFfmpegStream(ffArgs, { stdin: "pipe", stdout: "ignore", stderr: "pipe", buffer: { stderr: true }, reject: false });
  let ff: ReturnType<typeof encoder>;
  try {
    ff = encoder();
  } catch (err) {
    child.kill("SIGKILL");
    await exited(child);
    throw err;
  }

  let failure: Error | null = null;
  let finished = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const kill = () => {
    child.kill("SIGKILL");
    ff.kill("SIGKILL");
  };
  const failWith = (err: Error) => {
    if (failure || finished) return;
    failure = err;
    kill();
    notify();
  };
  let reported: RendererMessage | null = null;
  const stderr = tail(child.stderr);
  child.once("error", (err: Error) => failWith(startFailed(err)));

  // Media requests: answered on fd 4, or the named error ends the render.
  const replies = child.stdio[4] as Writable;
  replies.on("error", () => {}); // its exit reports it
  const answer = (msg: RendererMessage) => {
    const req = parseMediaRequest(msg);
    if (!req) return failWith(new MotionRenderError("graphic_render_crashed", "The graphics renderer sent an unreadable media request."));
    media.answer(req).then(
      (reply) => {
        if (!failure) writeReply(replies, req.id, reply);
      },
      (err: Error) => failWith(err),
    );
  };

  // Control out.
  let ready = false;
  /** How many frames of `order` the renderer has finished, in order. */
  let done = 0;
  readLines(
    child.stdout as Readable,
    (line) => {
      let msg: RendererMessage;
      try {
        msg = JSON.parse(line) as RendererMessage;
      } catch {
        o.onMessage?.({ type: "text", text: line.slice(0, 2000) });
        return;
      }
      o.onMessage?.(msg);
      if (msg.type === "ready") ready = true;
      else if (msg.type === "frame" && msg.n === order[done]) {
        try {
          audio.add(msg.n, msg.cues);
          done++;
        } catch (err) {
          failWith(err as Error);
        }
      }
      else if (msg.type === "frame-error") failWith(pageFailure(msg));
      else if (msg.type === "media") answer(msg);
      else if (msg.type === "error") reported = msg;
      notify();
    },
    () => failWith(new MotionRenderError("graphic_render_crashed", "The graphics renderer sent a control line longer than 1 MB.")),
  );

  // Frames: fd 3 into FFmpeg's stdin, never more bytes than the frames asked for.
  let received = 0;
  const frames = child.stdio[3] as Readable;
  const ffIn = ff.stdin as Writable;
  ffIn.on("error", () => {}); // FFmpeg's own exit reports it
  frames.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > total) return failWith(new MotionRenderError("graphic_render_crashed", "The graphics renderer sent more frame data than asked for."));
    o.onFrameData?.(chunk);
    if (!ffIn.write(chunk)) {
      frames.pause();
      ffIn.once("drain", () => frames.resume());
    }
    notify();
  });

  // After the exit, the rest of its stderr (a page's out-of-memory report is there), for at most 300 ms.
  const stderrEnd = new Promise<void>((resolve) => {
    child.stderr?.once("end", resolve);
    child.once("exit", () => setTimeout(resolve, 300));
  });
  child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    o.onExit?.(code, signal);
    void stderrEnd.then(() => {
      const r = reported as RendererMessage | null;
      const why = r ? `${String(r.code)}: ${String(r.message)}` : `exit ${code ?? signal}; ${stderr().trim().split("\n").slice(-3).join(" | ")}`;
      const outOfMemory = /\boom\b/.test(String(r?.message)) || /V8 javascript OOM|Reached heap limit/.test(stderr());
      // A renderer that never got its page up because Chromium can't run here (D7): the reason its stderr names.
      const reason = ready ? "start-failed" : unavailableReason(stderr());
      if (reason !== "start-failed") return failWith(new RendererUnavailableError(reason, why));
      failWith(
        new MotionRenderError(
          "graphic_render_crashed",
          outOfMemory
            ? `The graphic ran out of memory (its page may use ${o.heapMb ?? 2048} MB). Make it simpler (fewer or smaller elements) and try again.`
            : `The graphics renderer stopped before the graphic was finished (${why}).`,
        ),
      );
    });
  });
  const ffDone = ff.then((r) => {
    if (r.exitCode !== 0 && !finished) failWith(new FfmpegError(`ffmpeg failed: ${ffmpegStderrDetail(String(r.stderr ?? ""))}`, "ffmpeg (graphic encode)", String(r.stderr ?? "")));
    return r;
  });
  const onAbort = () => failWith(canceled());
  if (o.signal?.aborted) onAbort();
  o.signal?.addEventListener("abort", onAbort, { once: true });
  const totalTimer = setTimeout(
    () => failWith(new MotionRenderError("graphic_render_timeout", `The graphic took longer than ${Math.round(limits.totalMs / 1000)} s to render. Make it shorter or simpler and try again.`)),
    limits.totalMs,
  );

  const until = async (cond: () => boolean, ms: number, timeout: () => Error) => {
    const deadline = Date.now() + ms;
    while (!failure && !cond()) {
      const left = deadline - Date.now();
      if (left <= 0) failWith(timeout());
      else {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, left);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
      }
    }
    if (failure) throw failure;
  };
  const send = (msg: object) => (child.stdin as Writable).write(`${JSON.stringify(msg)}\n`);
  (child.stdin as Writable).on("error", () => {}); // its exit reports it

  try {
    send({ type: "start", width: o.width, height: o.height, fps: o.fps, durationInFrames: o.durationInFrames, alpha: o.alpha, table });
    await until(() => ready, limits.frameMs, () => new MotionRenderError("graphic_frame_timeout", `The graphic's page did not load within ${Math.round(limits.frameMs / 1000)} s.`));
    for (const [i, n] of order.entries()) {
      send({ type: "frame", n });
      await until(
        () => done > i && received >= (i + 1) * frameSize,
        limits.frameMs,
        () => new MotionRenderError("graphic_frame_timeout", `Frame ${n} of the graphic took longer than ${Math.round(limits.frameMs / 1000)} s to draw. Make the graphic simpler and try again.`),
      );
      o.onProgress?.((i + 1) / order.length);
    }
    const framesMs = Date.now() - started;
    finished = true;
    clearTimeout(totalTimer);
    ffIn.end();
    // EOF on its control pipe ends the renderer; it has no more work.
    (child.stdin as Writable).end();
    const r = await ffDone;
    if (r.exitCode !== 0) throw new FfmpegError(`ffmpeg failed: ${ffmpegStderrDetail(String(r.stderr ?? ""))}`, "ffmpeg (graphic encode)", String(r.stderr ?? ""));
    const quit = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited(child);
    clearTimeout(quit);
    return framesMs;
  } catch (err) {
    finished = true;
    kill();
    throw err;
  } finally {
    clearTimeout(totalTimer);
    o.signal?.removeEventListener("abort", onAbort);
    await Promise.all([exited(child), ffDone.catch(() => {}), media.close()]);
  }
}

export type ProbeResult = { ok: true; report: RendererMessage } | { ok: false; reason: RendererUnavailableReason; detail: string };

/** The reason a failed start's stderr names. */
export function unavailableReason(stderr: string): RendererUnavailableReason {
  if (/no usable sandbox|SUID sandbox helper|Failed to move to new namespace/i.test(stderr)) return "sandbox-unavailable";
  if (/missing x server|\$DISPLAY|cannot open display|platform failed to initialize/i.test(stderr)) return "no-display";
  return "start-failed";
}

/**
 * D7's start probe: the renderer, started as a render's is, opens its
 * offscreen window, renders one 64x64 frame and prints {"probe":"ok",...}
 * (with the process's own report: visible windows, loaded modules, its
 * environment's names). Runs in <dataDir>/motion/probe-<core pid>, removed
 * afterwards.
 */
export async function probeMotionRenderer(
  dataDir: string,
  opts: { binary?: RendererBinary; env?: NodeJS.ProcessEnv; timeoutMs?: number; onSpawn?: (pid: number) => void } = {},
): Promise<ProbeResult> {
  const bin = opts.binary ?? rendererBinary();
  if (!bin.ok) return { ok: false, reason: bin.reason, detail: bin.detail };
  const dir = join(dataDir, "motion", `probe-${process.pid}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, OWNER), JSON.stringify({ pid: process.pid }), "utf8");
    await mkdir(join(dir, "tmp"), { recursive: true });
    // 64x64: motion-renderer.cjs's PROBE_SIZE (Windows keeps a window at least 32x31).
    const child = spawnRenderer(bin, rendererArgs(dir, 64, 64, ["--probe"]), dir, opts.env);
    if (child.pid !== undefined) opts.onSpawn?.(child.pid);
    const stderr = tail(child.stderr);
    let report: RendererMessage | null = null;
    let reported: RendererMessage | null = null;
    readLines(
      child.stdout as Readable,
      (line) => {
        try {
          const msg = JSON.parse(line) as RendererMessage;
          if (msg.probe === "ok") report = msg;
          else if (msg.type === "error") reported = msg;
        } catch {
          /* not a control line */
        }
      },
      () => child.kill("SIGKILL"),
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 30_000);
    await exited(child);
    clearTimeout(timer);
    // Its last lines can come after the exit: wait for stdout and stderr to end, for at most 300 ms.
    await Promise.race([Promise.all([child.stdout, child.stderr].map(ended)), new Promise((resolve) => setTimeout(resolve, 300))]);
    (child.stdin as Writable).destroy();
    if (report) return { ok: true, report };
    if (child.pid === undefined) return { ok: false, reason: "start-failed", detail: (await child).message ?? "the renderer did not start" };
    const text = stderr();
    // The renderer's own error line (fail() in motion-renderer.cjs) first: the stderr tail is often only Chromium's noise.
    const r = reported as RendererMessage | null;
    const why = r ? `${String(r.code)}: ${String(r.message)}; ` : "";
    return { ok: false, reason: unavailableReason(text), detail: `${why}exit ${child.exitCode ?? child.signalCode}; ${text.trim().split("\n").slice(-3).join(" | ")}` };
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * At core start: remove every <dataDir>/motion/<id> whose owner.json names a
 * core that is no longer running (a render or probe cut short by a crash),
 * and every folder with no usable owner.json that holds nothing else than an
 * empty tmp/ or an owner.json that does not parse (a core killed before or
 * while it wrote owner.json). Any other folder without owner.json is left
 * alone: the Remotion path's work folders have none, and hold its files.
 */
export async function sweepMotionScratch(dataDir: string): Promise<string[]> {
  const root = join(dataDir, "motion");
  const removed: string[] = [];
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const dir = join(root, name);
    let text: string | undefined;
    let pid: unknown;
    try {
      text = await readFile(join(dir, OWNER), "utf8");
      pid = (JSON.parse(text) as { pid?: unknown }).pid;
    } catch {
      if (await onlyStartedRender(dir, text !== undefined)) {
        await rm(dir, { recursive: true, force: true, maxRetries: 5 });
        removed.push(dir);
      }
      continue;
    }
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid === process.pid || alive(pid)) continue;
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    removed.push(dir);
  }
  return removed;
}

/** `dir` (no usable owner.json) holds at most an empty tmp/ and, when `ownerRead` (it was read but did not parse), owner.json. */
async function onlyStartedRender(dir: string, ownerRead: boolean): Promise<boolean> {
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === OWNER && ownerRead && entry.isFile()) continue;
      if (entry.name === "tmp" && entry.isDirectory() && (await readdir(join(dir, "tmp"))).length === 0) continue;
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
