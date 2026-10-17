import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { PRODUCT_NAME } from "../brand.js";
import { adaptFfmpegArgs, FfmpegError, ffmpegStderrDetail, runTool, spawnFfmpegStream } from "../ffmpeg/executor.js";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "../io/gatedfs.js";
import { graphicPreviewProxy, tagGraphicColor } from "./render.js";
import { rendererBinary, type RendererBinary } from "./rendererbinary.js";

/**
 * The core's side of ZabsReel's own motion renderer (MOTION-PLAN D2): it
 * starts one renderer process per render (rendererbinary.ts picks the
 * executable; main.cjs dispatches to @aive/motion's motion-renderer.cjs),
 * sends it the page's table, asks for each frame, and pipes the frames into
 * FFmpeg (executor.ts). The pipes and their formats are described at the top
 * of motion-renderer.cjs.
 *
 * Everything a render writes stays in its motion/<id> folder (workDir) until
 * the whole render has succeeded; only then are the files moved into baked/,
 * all of them or none. Every failure (abort, a limit, a crash, an FFmpeg
 * error) kills the renderer by its PID and removes workDir. Each render's
 * workDir holds owner.json with the core's PID, and the next core start
 * removes the folders of cores that are gone ({@link sweepMotionScratch}).
 */

/**
 * The renderer's environment: these variables of the core's, TEMP/TMP/TMPDIR
 * in the render's folder, and GSETTINGS_BACKEND=memory (GTK's settings stay in
 * memory instead of dconf's files in HOME). Never AIVE_*, ELECTRON_* or
 * NODE_OPTIONS.
 */
export const RENDERER_ENV = ["PATH", "SystemRoot", "windir", "LANG", "LC_ALL", "HOME", "USERPROFILE", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"] as const;
/** The longest graphic: 600 s at 60 fps. */
export const MAX_MOTION_FRAMES = 36_000;
const OWNER = "owner.json";
/** Longest control line the renderer may send. */
const MAX_LINE = 1024 * 1024;

export type MotionErrorCode =
  | "graphic_renderer_unavailable"
  | "graphic_frame_timeout"
  | "graphic_render_timeout"
  | "graphic_render_crashed"
  | "graphic_render_canceled";

/** A render that ended without a result; `code` is what add_graphic reports. */
export class MotionRenderError extends Error {
  constructor(
    readonly code: MotionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MotionRenderError";
  }
}

/** Why the renderer can't run (D7); "start-failed" is any other failed start. */
export type RendererUnavailableReason = "no-binary" | "no-display" | "sandbox-unavailable" | "start-failed";

/** The renderer's limits (D2); tests pass shorter ones. */
export interface MotionLimits {
  /** One frame, and the page's first load. */
  frameMs: number;
  /** The whole render: 120 s + 1 s per frame. */
  totalMs: number;
}

export interface RenderMotionOptions {
  /** The page's module (module.js in the table). Until the runtime lands it is plain JS that calls zrMotion.onFrame(fn). */
  module: string;
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
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  /**
   * Tests: the binary rule's answer, the limits, the page's heap (MB), table
   * entries replaced or added, the environment, and the renderer's messages,
   * frame bytes (as they arrive on fd 3), PID and exit.
   */
  binary?: RendererBinary;
  limits?: Partial<MotionLimits>;
  heapMb?: number;
  entries?: Record<string, string>;
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
}

/** The renderer's environment for a render in `scratch` (see {@link RENDERER_ENV}). */
export function rendererEnv(scratch: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of RENDERER_ENV) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  const tmp = join(scratch, "tmp");
  out.TEMP = out.TMP = out.TMPDIR = tmp;
  out.GSETTINGS_BACKEND = "memory";
  return out;
}

/**
 * The renderer's arguments after the binary rule's: the core's PID, the
 * render's folder, the heap, and on Linux Chromium's headless platform (no
 * display needed; slice 1 measured X11 failing without one) with a screen
 * large enough for the page.
 */
export function rendererArgs(scratch: string, width: number, height: number, extra: string[] = []): string[] {
  const linux = process.platform === "linux" ? ["--ozone-platform=headless", `--ozone-override-screen-size=${width},${height}`] : [];
  return [`--zr-parent-pid=${process.pid}`, `--zr-scratch=${scratch}`, "--mute-audio", ...linux, ...extra];
}

/** The renderer folder of @aive/motion (page.html, guard.js, loader.js). */
function rendererDir(): string {
  return join(dirname(createRequire(import.meta.url).resolve("@aive/motion/package.json")), "renderer");
}

const TEXT = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8" };

/** The zrmotion table: path -> { type, body (base64) }. */
async function pageTable(o: RenderMotionOptions): Promise<{ path: string; type: string; body: string }[]> {
  const dir = rendererDir();
  const files: Record<string, string> = {
    "page.html": await readFile(join(dir, "page.html"), "utf8"),
    "guard.js": await readFile(join(dir, "guard.js"), "utf8"),
    "loader.js": await readFile(join(dir, "loader.js"), "utf8"),
    "module.js": o.module,
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

function checkOptions(o: RenderMotionOptions): void {
  const int = (v: number, max: number) => Number.isInteger(v) && v >= 1 && v <= max;
  if (!int(o.width, 8192) || !int(o.height, 8192)) throw new RangeError(`A graphic is 1 to 8192 pixels on each side (${o.width}x${o.height}).`);
  if (!int(o.durationInFrames, MAX_MOTION_FRAMES)) throw new RangeError(`A graphic is 1 to ${MAX_MOTION_FRAMES} frames long (${o.durationInFrames}).`);
  if (!(o.fps > 0 && o.fps <= 240)) throw new RangeError(`A graphic's frame rate is above 0 and at most 240 (${o.fps}).`);
}

/**
 * Render `o.module`'s frames with ZabsReel's renderer and encode them to
 * `o.outPath` (and the overlay's preview to `o.previewPath`). Rejects with a
 * {@link MotionRenderError} (or FFmpeg's error) after removing everything it
 * wrote; baked/ then holds nothing of this render.
 */
export async function renderMotion(o: RenderMotionOptions): Promise<RenderMotionResult> {
  checkOptions(o);
  const encoded = join(o.workDir, o.alpha ? "out.mov" : "out.mp4");
  const preview = join(o.workDir, "graphic.webm");
  try {
    await mkdir(join(o.workDir, "tmp"), { recursive: true });
    await writeFile(join(o.workDir, OWNER), JSON.stringify({ pid: process.pid }), "utf8");
    const framesMs = await renderFrames(o, encoded);
    if (!o.alpha) await tagGraphicColor(encoded, o.signal);
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
    await moveAll([[encoded, o.outPath], ...(previewMade && o.previewPath ? [[preview, o.previewPath] as const] : [])]);
    return { outPath: o.outPath, previewPath: previewMade ? o.previewPath : undefined, framesMs };
  } finally {
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
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        await copyFile(from, to);
        await rm(from, { force: true });
      }
      done.push(to);
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

const startFailed = (err: Error) => new MotionRenderError("graphic_renderer_unavailable", `${PRODUCT_NAME}'s graphics renderer can't start here (start-failed: ${err.message}).`);

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

/** The renderer and FFmpeg for one render: frames 0..N-1 into `encoded`. Returns the milliseconds the frames took. */
async function renderFrames(o: RenderMotionOptions, encoded: string): Promise<number> {
  const bin = o.binary ?? rendererBinary();
  if (!bin.ok) throw new MotionRenderError("graphic_renderer_unavailable", `${PRODUCT_NAME}'s graphics renderer can't start here (${bin.reason}: ${bin.detail}).`);
  const limits: MotionLimits = { frameMs: 30_000, totalMs: 120_000 + 1000 * o.durationInFrames, ...o.limits };
  const frameSize = o.width * o.height * 4;
  const total = frameSize * o.durationInFrames;
  const table = await pageTable(o);
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

  // Control out.
  let ready = false;
  let lastFrame = -1;
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
      else if (msg.type === "frame" && msg.n === lastFrame + 1) lastFrame = msg.n;
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
    for (let n = 0; n < o.durationInFrames; n++) {
      send({ type: "frame", n });
      await until(
        () => lastFrame >= n && received >= (n + 1) * frameSize,
        limits.frameMs,
        () => new MotionRenderError("graphic_frame_timeout", `Frame ${n} of the graphic took longer than ${Math.round(limits.frameMs / 1000)} s to draw. Make the graphic simpler and try again.`),
      );
      o.onProgress?.((n + 1) / o.durationInFrames);
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
    await Promise.all([exited(child), ffDone.catch(() => {})]);
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
 * offscreen window, renders one 16x16 frame and prints {"probe":"ok",...}
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
    await mkdir(join(dir, "tmp"), { recursive: true });
    await writeFile(join(dir, OWNER), JSON.stringify({ pid: process.pid }), "utf8");
    const child = spawnRenderer(bin, rendererArgs(dir, 16, 16, ["--probe"]), dir, opts.env);
    if (child.pid !== undefined) opts.onSpawn?.(child.pid);
    const stderr = tail(child.stderr);
    let report: RendererMessage | null = null;
    readLines(
      child.stdout as Readable,
      (line) => {
        try {
          const msg = JSON.parse(line) as RendererMessage;
          if (msg.probe === "ok") report = msg;
        } catch {
          /* not a control line */
        }
      },
      () => child.kill("SIGKILL"),
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 30_000);
    await exited(child);
    clearTimeout(timer);
    (child.stdin as Writable).destroy();
    if (report) return { ok: true, report };
    if (child.pid === undefined) return { ok: false, reason: "start-failed", detail: (await child).message ?? "the renderer did not start" };
    const text = stderr();
    return { ok: false, reason: unavailableReason(text), detail: `exit ${child.exitCode ?? child.signalCode}; ${text.trim().split("\n").slice(-3).join(" | ")}` };
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
 * core that is no longer running (a render or probe cut short by a crash).
 * Folders without owner.json (the Remotion path's) are left alone.
 */
export async function sweepMotionScratch(dataDir: string): Promise<string[]> {
  const root = join(dataDir, "motion");
  const removed: string[] = [];
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const dir = join(root, name);
    let pid: unknown;
    try {
      pid = (JSON.parse(await readFile(join(dir, OWNER), "utf8")) as { pid?: unknown }).pid;
    } catch {
      continue;
    }
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid === process.pid || alive(pid)) continue;
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    removed.push(dir);
  }
  return removed;
}
