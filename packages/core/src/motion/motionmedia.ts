import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { PRODUCT_NAME } from "../brand.js";
import { inputColorOpts, inputScaleFlags, resolveSourceColor } from "../ffmpeg/colorspace.js";
import { ffmpegStderrDetail, ffmpegVersion, NOT_MEDIA_TEXT, notMediaFrom, spawnFfmpegStream } from "../ffmpeg/executor.js";
import { passthroughFlag } from "../ffmpeg/version.js";
import { MediaOfflineError } from "../hosttrust.js";
import { readFile, stat } from "../io/gatedfs.js";
import { isOffline, type MediaAsset } from "../types.js";
import { MotionRenderError } from "./motionerror.js";

/**
 * Library video, images and fonts for ZabsReel's own motion renderer, on
 * demand (MOTION-PLAN D4 E1, E2, E4; D-ONDEMAND, D-CAPS-2).
 *
 * The render's caller gives the graphic's asset table as the core keeps it
 * (asset id -> MediaAsset, or a font file). The page gets each usable asset
 * under a random per-render handle with its kind and sizes only (the
 * runtime's AssetInfo); its path and name stay here. An asset of no kind the
 * runtime knows (no video or audio stream, sizes missing) is left out, so the
 * page reports it as graphic_asset_unknown.
 *
 * The page asks for zrmotion://media/<handle>?t=&w=&h= (a video's source
 * frame t, or an image) and zrmotion://app/font/<handle>; the renderer main
 * forwards each as a request line, and the core answers it here: the handle
 * and kind checked, every cap of D4's table checked before the work it
 * bounds, the asset's offline state checked (the caller's requireMedia), a
 * frame decoded by executor.ts's FFmpeg to PNG on its stdout (the export's
 * reading of the source's colour, ffmpeg/colorspace.ts) or the font file
 * read. No decoded frame is written to a file: answers live in an in-memory
 * LRU, and requests for consecutive frames of one video and box read one
 * running FFmpeg decode. A breach throws the named error, and the render ends.
 */

/** A library font file (MOTION-PLAN E4); like a MediaAsset's, its path stays in the core. */
export interface MotionFontAsset {
  kind: "font";
  path: string;
  name: string;
  missing?: boolean;
  awaitingServer?: string;
  pathCheckFailed?: string;
}

/** An asset of the graphic's table as its caller keeps it. */
export type MotionAsset = MediaAsset | MotionFontAsset;

/**
 * What the page learns of an asset: the runtime's AssetInfo
 * (cleanroom/runtime/src/host.ts), with its host guarantees (a video always
 * has fps, frameCount, durationSeconds and hasAudio; an image its size; an
 * audio file its duration). No path, name or folder.
 */
export interface PageAsset {
  handle: string;
  kind: "video" | "image" | "audio" | "font";
  width?: number;
  height?: number;
  durationSeconds?: number;
  fps?: number;
  frameCount?: number;
  hasAudio?: boolean;
}

/** D4's caps; tests pass smaller ones. */
export interface MediaCaps {
  /** Media requests (video frames and images) per composition frame. */
  perFrame: number;
  /** FFmpeg frame decodes per render (LRU hits do not count). */
  decodes: number;
  /** The in-memory LRU of answered frames, in PNG bytes. */
  lruBytes: number;
  /** FFmpeg processes at once (the next decode waits). */
  concurrent: number;
  /** Distinct fonts per render. */
  fonts: number;
  /** Bytes of one font file. */
  fontBytes: number;
  /** One media or font request, from its arrival to its answer. */
  requestMs: number;
}

export const MEDIA_CAPS: Readonly<MediaCaps> = {
  perFrame: 8,
  decodes: 40_000,
  lruBytes: 256 * 1024 * 1024,
  concurrent: 8,
  fonts: 16,
  fontBytes: 32 * 1024 * 1024,
  requestMs: 20_000,
};

/** A request line from the renderer main (motion-renderer.cjs): `frame` is the composition frame it came in (-1 before the first). */
export interface MediaRequest {
  id: number;
  route: "media" | "font";
  handle: string;
  t?: number;
  w?: number;
  h?: number;
  frame: number;
}

/** The answer on fd 4: 200 with the PNG or font bytes, or 404 (an unknown handle, a handle of another kind, a query that names nothing). */
export interface MediaReply {
  status: number;
  body: Buffer;
}

/** What a render's media did. */
export interface MediaStats {
  requests: number;
  /** Requests FFmpeg answered (LRU misses). */
  decodes: number;
  lruHits: number;
  lruBytes: number;
  lruPeakBytes: number;
  evictions: number;
  /** FFmpeg processes started. */
  spawns: number;
  /** Most decodes running at once, and how many requests waited for one to end. */
  peakDecoding: number;
  waited: number;
  /** Most FFmpeg processes alive at once (running or idle). */
  peakProcesses: number;
  fonts: number;
}

const NOT_FOUND: MediaReply = { status: 404, body: Buffer.alloc(0) };

/** A request line's fields, checked, or null. */
export function parseMediaRequest(msg: Record<string, unknown>): MediaRequest | null {
  const num = (v: unknown) => v === undefined || (typeof v === "number" && Number.isFinite(v));
  const { id, route, handle, t, w, h, frame } = msg;
  if (!Number.isInteger(id) || (id as number) < 0 || (id as number) > 0xffffffff) return null;
  if ((route !== "media" && route !== "font") || typeof handle !== "string" || handle.length > 64) return null;
  if (!num(t) || !num(w) || !num(h) || !Number.isInteger(frame)) return null;
  return { id: id as number, route, handle, t: t as number | undefined, w: w as number | undefined, h: h as number | undefined, frame: frame as number };
}

/** The page's view of `a` under `handle`, or null when the runtime has no kind for it. */
function pageAsset(a: MotionAsset, handle: string): PageAsset | null {
  if ("kind" in a) return a.kind === "font" ? { handle, kind: "font" } : null;
  const pos = (v: number) => Number.isFinite(v) && v > 0;
  const sized = Number.isInteger(a.width) && Number.isInteger(a.height) && a.width > 0 && a.height > 0;
  if (a.hasVideo && a.isImage) return sized ? { handle, kind: "image", width: a.width, height: a.height } : null;
  if (a.hasVideo) {
    if (!sized || !pos(a.fps) || !pos(a.duration)) return null;
    // A MediaAsset has no frame count: its duration at its frame rate. The video stream can end sooner (its audio
    // runs longer); a decode that reaches its end tells the real count (Entry.frames), and later frames answer the last.
    const frameCount = Math.max(1, Math.round(a.duration * a.fps));
    return { handle, kind: "video", width: a.width, height: a.height, durationSeconds: a.duration, fps: a.fps, frameCount, hasAudio: a.hasAudio };
  }
  return a.hasAudio && pos(a.duration) ? { handle, kind: "audio", durationSeconds: a.duration } : null;
}

/** G4's default: an offline asset (missing, on a server not allowed, a folder not checked) is refused with media_offline. */
export function requireOnline(a: MotionAsset): void {
  if (!isOffline(a)) return;
  const why = a.awaitingServer
    ? `its file is on the network computer \\\\${a.awaitingServer}, which the user has not allowed yet`
    : a.pathCheckFailed
      ? `${PRODUCT_NAME} couldn't check its folder (${a.pathCheckFailed}), so it did not open it`
      : "its file was not found";
  throw new MediaOfflineError(`Asset "${a.name}" is offline: ${why}.`, a.awaitingServer ? [a.awaitingServer] : []);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/**
 * The chunks a picture keeps. FFmpeg tags its PNG with the source's colour
 * (cHRM, gAMA, cICP), which Chromium would apply; the export draws the
 * decoded RGB as it is, so they (and every other ancillary chunk) go.
 */
const KEEP = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
const MAX_CHUNK = 64 * 1024 * 1024;

/** FIFO bytes taken in exact counts, without joining the whole stream. */
class ByteQueue {
  private parts: Buffer[] = [];
  length = 0;
  push(b: Buffer): void {
    this.parts.push(b);
    this.length += b.length;
  }
  take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    for (let o = 0; o < n; ) {
      const p = this.parts[0];
      const k = Math.min(p.length, n - o);
      p.copy(out, o, 0, k);
      if (k === p.length) this.parts.shift();
      else this.parts[0] = p.subarray(k);
      o += k;
    }
    this.length -= n;
    return out;
  }
}

/** FFmpeg's image2pipe PNG stream, one picture at a time (at most two read ahead: the stream pauses, and so does FFmpeg). */
class PngReader {
  private q = new ByteQueue();
  private head: Buffer | null = null;
  private kept: Buffer[] | null = null;
  private pictures: Buffer[] = [];
  private ended = false;
  private wake: (() => void) | null = null;
  error: Error | null = null;

  constructor(private stream: Readable) {
    stream.on("data", (chunk: Buffer) => {
      this.q.push(chunk);
      try {
        this.parse();
      } catch (err) {
        this.error = err as Error;
        stream.destroy();
        this.end();
        return;
      }
      if (this.pictures.length >= 2) stream.pause();
      this.notify();
    });
    stream.once("end", () => this.end());
    stream.once("close", () => this.end());
    stream.once("error", () => this.end());
  }

  private end(): void {
    this.ended = true;
    this.notify();
  }

  private notify(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  private parse(): void {
    for (;;) {
      if (!this.kept) {
        if (this.q.length < 8) return;
        const sig = this.q.take(8);
        if (!sig.equals(PNG_SIGNATURE)) throw new Error("FFmpeg's output is not a PNG stream");
        this.kept = [sig];
      }
      if (!this.head) {
        if (this.q.length < 8) return;
        this.head = this.q.take(8);
      }
      const len = this.head.readUInt32BE(0);
      if (len > MAX_CHUNK) throw new Error("a PNG chunk is too large");
      if (this.q.length < len + 4) return;
      const body = this.q.take(len + 4);
      const type = this.head.toString("latin1", 4, 8);
      if (KEEP.has(type)) this.kept.push(this.head, body);
      this.head = null;
      if (type === "IEND") {
        this.pictures.push(Buffer.concat(this.kept));
        this.kept = null;
      }
    }
  }

  /** The next picture, or null when the stream has ended. */
  async read(): Promise<Buffer | null> {
    while (this.pictures.length === 0 && !this.ended) await new Promise<void>((resolve) => (this.wake = resolve));
    const p = this.pictures.shift() ?? null;
    if (this.pictures.length < 2 && !this.ended) this.stream.resume();
    return p;
  }
}

type Decoder = ReturnType<typeof spawnFfmpegStream<{ stdin: "ignore"; stdout: "pipe"; stderr: "pipe"; buffer: { stdout: false; stderr: true }; reject: false }>>;

/** One running FFmpeg decode of a video (or an image) at one box: its pictures in order, frame `next` first. */
class FrameStream {
  last: Buffer | null = null;
  busy = false;
  done = false;
  /** The decode ended by itself, with no error, after at least one picture: `last` is the video's last frame, next - 1. */
  ended = false;
  private killed = false;
  used = 0;
  private reader: PngReader;

  constructor(
    readonly key: string,
    public next: number,
    readonly child: Decoder,
  ) {
    this.reader = new PngReader(child.stdout as Readable);
  }

  /** Frame t (next - 1 <= t): read up to it; a stream that ends first answers its last picture (the source's last frame). */
  async frameAt(t: number): Promise<Buffer | null> {
    while (this.next <= t && !this.done) {
      const png = await this.reader.read();
      if (!png) {
        this.done = true;
        this.ended = this.last !== null && (await this.clean());
        break;
      }
      this.last = png;
      this.next++;
    }
    return this.last;
  }

  /** Why the decode gave no picture: FFmpeg's own words. */
  async failure(): Promise<string> {
    const r = await this.child;
    const stderr = String(r.stderr ?? "");
    if (notMediaFrom(stderr)) return NOT_MEDIA_TEXT;
    return this.reader.error?.message ?? (ffmpegStderrDetail(stderr) || `FFmpeg exited with ${r.exitCode ?? r.signal}`);
  }

  /** FFmpeg ended by itself with no error: a decode that gave no picture was seeked past the video's end. */
  async clean(): Promise<boolean> {
    const r = await this.child;
    const stderr = String(r.stderr ?? "");
    return !this.killed && !this.reader.error && r.exitCode === 0 && !notMediaFrom(stderr) && !ffmpegStderrDetail(stderr);
  }

  kill(): void {
    this.done = true;
    this.killed = true;
    this.child.kill("SIGKILL");
    // A paused stdout never ends, and the child's promise waits for it.
    this.child.stdout?.destroy();
  }
}

interface Entry {
  id: string;
  asset: MotionAsset;
  info: PageAsset;
  /** A video's real frame count, once a decode reached its end. */
  frames?: number;
}

/** One render's media: the page's asset table and the answers to its requests. */
export class MotionMedia {
  /** asset id -> what the page learns of it (GraphicStart.assets). */
  readonly page: Record<string, PageAsset> = {};
  readonly stats: MediaStats = {
    requests: 0, decodes: 0, lruHits: 0, lruBytes: 0, lruPeakBytes: 0, evictions: 0,
    spawns: 0, peakDecoding: 0, waited: 0, peakProcesses: 0, fonts: 0,
  };
  private byHandle = new Map<string, Entry>();
  private perFrame = new Map<number, number>();
  private fonts = new Set<string>();
  /** (handle, t, w, h) -> PNG, least recently used first. */
  private lru = new Map<string, Buffer>();
  private streams: FrameStream[] = [];
  private oneShots = new Set<Decoder>();
  private decoding = 0;
  private waiting: (() => void)[] = [];
  private clock = 0;
  private abort = new AbortController();
  /** FFmpeg's flag that passes the filtered frames through as they are, set by the first decode. */
  private passthrough: string[] = [];

  constructor(
    assets: Readonly<Record<string, MotionAsset>>,
    private o: { width: number; height: number; caps: MediaCaps; requireMedia: (asset: MotionAsset) => void },
  ) {
    for (const [id, asset] of Object.entries(assets)) {
      // A handle names nothing: random, per render, never derived from the path.
      const handle = randomBytes(16).toString("hex");
      const info = id === "__proto__" ? null : pageAsset(asset, handle);
      if (!info) continue;
      this.page[id] = info;
      this.byHandle.set(handle, { id, asset, info });
    }
  }

  /**
   * The answer to `req`. Throws the named error that ends the render: a cap
   * breached, a source time that is no frame, an offline asset
   * (MediaOfflineError), a decode or font read that failed or took longer
   * than caps.requestMs.
   */
  async answer(req: MediaRequest): Promise<MediaReply> {
    this.stats.requests++;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(this.timeoutError(req)), this.o.caps.requestMs);
    });
    const work = req.route === "font" ? this.font(req) : this.media(req);
    work.catch(() => {}); // a late failure after the timeout has no one to tell
    try {
      return await Promise.race([work, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stop every decode and font read. */
  async close(): Promise<void> {
    this.abort.abort();
    const children = [...this.streams.map((s) => s.child), ...this.oneShots];
    for (const s of this.streams) s.kill();
    for (const c of this.oneShots) {
      c.kill("SIGKILL");
      c.stdout?.destroy();
    }
    this.streams = [];
    await Promise.all(children.map((c) => c.catch(() => {})));
  }

  private timeoutError(req: MediaRequest): MotionRenderError {
    const e = this.byHandle.get(req.handle);
    const what = !e ? "media" : req.route === "font" ? `the font "${e.id}"` : e.info.kind === "video" ? `frame ${req.t} of the video "${e.id}"` : `the image "${e.id}"`;
    return new MotionRenderError(
      "graphic_decode_timeout",
      `Reading ${what} took longer than ${Math.round(this.o.caps.requestMs / 1000)} s. Use a smaller or more common file (for example H.264 video), or show it smaller.`,
    );
  }

  /** The box scaled down, the same factor on both sides, to fit the canvas; whole pixels, at least 1. */
  private fit(w: number, h: number): { w: number; h: number } {
    const bw = Math.max(1, Math.round(w));
    const bh = Math.max(1, Math.round(h));
    const s = Math.min(1, this.o.width / bw, this.o.height / bh);
    return { w: Math.min(this.o.width, Math.max(1, Math.round(bw * s))), h: Math.min(this.o.height, Math.max(1, Math.round(bh * s))) };
  }

  private async media(req: MediaRequest): Promise<MediaReply> {
    const { caps } = this.o;
    // Every request counts, a known handle or not: no page gets past the cap with requests that name nothing.
    const n = (this.perFrame.get(req.frame) ?? 0) + 1;
    this.perFrame.set(req.frame, n);
    if (n > caps.perFrame) {
      throw new MotionRenderError(
        "graphic_media_per_frame",
        `Frame ${req.frame} of the graphic asked for more than ${caps.perFrame} images and video frames. Show at most ${caps.perFrame} at a time, for example by giving them shorter, non-overlapping Sequences.`,
      );
    }
    const e = this.byHandle.get(req.handle);
    if (!e || (e.info.kind !== "video" && e.info.kind !== "image") || req.w === undefined || req.h === undefined) return NOT_FOUND;
    const box = this.fit(req.w, req.h);
    let t = -1;
    if (e.info.kind === "video") {
      if (req.t === undefined || !Number.isInteger(req.t) || req.t < 0) {
        throw new MotionRenderError(
          "graphic_media_time",
          `The graphic asked for source frame ${req.t ?? "(none)"} of the video "${e.id}": a source frame is a whole number, 0 or more. Use a trimBefore of 0 or more.`,
        );
      }
      t = Math.min(req.t, (e.frames ?? (e.info.frameCount as number)) - 1);
    } else if (req.t !== undefined) {
      return NOT_FOUND;
    }
    this.o.requireMedia(e.asset);
    const key = `${req.handle}:${t}:${box.w}x${box.h}`;
    const hit = this.lru.get(key);
    if (hit) {
      this.lru.delete(key);
      this.lru.set(key, hit);
      this.stats.lruHits++;
      return { status: 200, body: hit };
    }
    if (this.stats.decodes >= caps.decodes) {
      throw new MotionRenderError(
        "graphic_media_decodes_cap",
        `The graphic needed more than ${caps.decodes.toLocaleString("en-US")} video frames and images decoded. Make it shorter, or show fewer different frames (a frame shown again is not decoded again).`,
      );
    }
    this.stats.decodes++;
    // A constant frame rate output would repeat or drop pictures after a seek: the decode's frames go out as the fps filter gives them.
    if (!this.passthrough.length) {
      const v = await ffmpegVersion().catch((err: Error) => {
        throw new MotionRenderError("graphic_media_failed", `FFmpeg's version could not be read (${err.message}), so no frame was decoded. Check the FFmpeg ${PRODUCT_NAME} uses.`);
      });
      this.passthrough = passthroughFlag(v);
    }
    await this.slot();
    let png: Buffer;
    try {
      png = await this.decode(e, t, box);
    } finally {
      this.release();
    }
    this.remember(key, png);
    return { status: 200, body: png };
  }

  /** Wait for one of caps.concurrent decode slots; a freed slot passes straight to the first waiter. */
  private async slot(): Promise<void> {
    if (this.decoding < this.o.caps.concurrent) this.decoding++;
    else {
      this.stats.waited++;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.stats.peakDecoding = Math.max(this.stats.peakDecoding, this.decoding);
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.decoding--;
  }

  /** Make room for one more FFmpeg process: at most caps.concurrent alive, the least recently used idle stream goes. */
  private room(): void {
    this.streams = this.streams.filter((s) => !s.done);
    while (this.streams.length + this.oneShots.size >= this.o.caps.concurrent) {
      const idle = this.streams.filter((s) => !s.busy).sort((a, b) => a.used - b.used)[0];
      if (!idle) break;
      idle.kill();
      this.streams = this.streams.filter((s) => s !== idle);
    }
  }

  private spawn(e: Entry, from: number, box: { w: number; h: number }): Decoder {
    if (this.abort.signal.aborted) throw new MotionRenderError("graphic_render_canceled", "Motion-graphic render canceled");
    this.room();
    const a = e.asset as MediaAsset;
    const color = resolveSourceColor(a.color, a.height, a.videoCodec);
    const video = e.info.kind === "video";
    const fps = e.info.fps as number;
    // Source frame k of a video is the picture shown at k / fps on the file's own time grid (-copyts -start_at_zero:
    // FFmpeg's times from the file's start, as an fps filter over the whole file reads them; its first picture before
    // it begins), so a running decode and a fresh seek give a variable-rate source the same picture. -noaccurate_seek
    // starts at the keyframe before the time, which keeps the picture shown at it; trim cuts at frame `from` exactly.
    const conform = video ? `fps=${fps}:start_time=0,trim=start_pts=${from},` : "";
    const vf = `${conform}scale=${box.w}:${box.h}:flags=${inputScaleFlags({ w: a.width, h: a.height }, box.w, box.h, true)}${inputColorOpts(color)},format=rgba`;
    const seek = video ? ["-copyts", "-start_at_zero", ...(from > 0 ? ["-noaccurate_seek", "-ss", ((from - 0.5) / fps).toFixed(6)] : [])] : [];
    const one = e.info.kind === "image" ? ["-frames:v", "1"] : [];
    const args = [
      "-hide_banner", "-nostdin", "-loglevel", "error", ...seek, "-i", a.path,
      "-map", "0:v:0", "-an", "-sn", "-dn", ...one, "-vf", vf, ...this.passthrough, "-f", "image2pipe", "-c:v", "png", "pipe:1",
    ];
    const child = spawnFfmpegStream(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe", buffer: { stdout: false, stderr: true }, reject: false });
    this.stats.spawns++;
    this.stats.peakProcesses = Math.max(this.stats.peakProcesses, this.streams.length + this.oneShots.size + 1);
    return child;
  }

  /** Frame t of a video (from a running decode when it is at most 2 s ahead of it), or the image, at `box`. */
  private async decode(e: Entry, t: number, box: { w: number; h: number }, past = true): Promise<Buffer> {
    const image = e.info.kind === "image";
    const reach = Math.round(2 * (e.info.fps as number));
    let s: FrameStream;
    if (image) {
      const child = this.spawn(e, 0, box);
      this.oneShots.add(child);
      s = new FrameStream("", 0, child);
    } else {
      s = this.stream(e, t, box, reach);
    }
    try {
      const png = await this.read(e, s, image ? 0 : t);
      if (png) return png;
      // Seeked past the video's end (its container runs longer, for example its audio): answer its real last frame.
      if (!image && past && t > 0 && (await s.clean())) {
        const frames = await this.realFrames(e, t, reach);
        if (frames) return await this.decode(e, frames - 1, box, false);
      }
      const why = await s.failure();
      throw new MotionRenderError(
        "graphic_media_failed",
        `${image ? `The image "${e.id}"` : `Frame ${t} of the video "${e.id}"`} could not be read (${why}). Check the asset in the project library, or use another one.`,
      );
    } finally {
      if (image) {
        s.kill();
        this.oneShots.delete(s.child);
      }
    }
  }

  /** The running decode of e at `box` that reaches frame t, or a new one from t. A decode that ended answers only its last frame (and later ones). */
  private stream(e: Entry, t: number, box: { w: number; h: number }, reach: number): FrameStream {
    const key = `${e.info.handle}:${box.w}x${box.h}`;
    const found = this.streams.find(
      (x) => !x.busy && x.key === key && t >= x.next - 1 && (x.ended || (!x.done && t <= x.next + reach && (t >= x.next || x.last))),
    );
    if (found) return found;
    const s = new FrameStream(key, t, this.spawn(e, t, box));
    this.streams.push(s);
    return s;
  }

  /** Frame t of `s`; a video's decode that reaches the video's end records its real frame count. */
  private async read(e: Entry, s: FrameStream, t: number): Promise<Buffer | null> {
    s.busy = true;
    try {
      return await s.frameAt(t);
    } finally {
      s.busy = false;
      s.used = ++this.clock;
      if (s.ended) e.frames = Math.min(e.frames ?? s.next, s.next);
    }
  }

  /**
   * The real frame count of a video with no frame t: decodes at 1x1 (cheap)
   * from further back each time (2 s, 8 s, 32 s ... before t, then from 0)
   * until one reaches the end. Null when none gives a picture.
   */
  private async realFrames(e: Entry, t: number, reach: number): Promise<number | null> {
    // At least one frame back: a video under 0.25 fps reaches 0 frames in 2 s.
    for (let back = Math.max(1, reach); ; back *= 4) {
      const from = Math.max(0, t - back);
      const s = this.stream(e, from, { w: 1, h: 1 }, reach);
      await this.read(e, s, t);
      if (s.ended) return s.next;
      if (s.last || from === 0 || !(await s.clean())) return null;
    }
  }

  /** Keep `png` for `key`; past caps.lruBytes the least recently used answers go (no error). */
  private remember(key: string, png: Buffer): void {
    const old = this.lru.get(key);
    if (old) {
      this.lru.delete(key);
      this.stats.lruBytes -= old.length;
    }
    if (png.length > this.o.caps.lruBytes) return;
    this.lru.set(key, png);
    this.stats.lruBytes += png.length;
    for (const [k, v] of this.lru) {
      if (this.stats.lruBytes <= this.o.caps.lruBytes) break;
      this.lru.delete(k);
      this.stats.lruBytes -= v.length;
      this.stats.evictions++;
    }
    this.stats.lruPeakBytes = Math.max(this.stats.lruPeakBytes, this.stats.lruBytes);
  }

  private async font(req: MediaRequest): Promise<MediaReply> {
    const { caps } = this.o;
    const e = this.byHandle.get(req.handle);
    if (!e || e.info.kind !== "font" || req.t !== undefined || req.w !== undefined || req.h !== undefined) return NOT_FOUND;
    // Only a font of the table takes one of the render's font slots.
    if (!this.fonts.has(req.handle)) {
      if (this.fonts.size >= caps.fonts) {
        throw new MotionRenderError("graphic_font_cap", `The graphic loads more than ${caps.fonts} fonts. Use at most ${caps.fonts} different fonts in one graphic.`);
      }
      this.fonts.add(req.handle);
      this.stats.fonts = this.fonts.size;
    }
    this.o.requireMedia(e.asset);
    const tooBig = (bytes: number) =>
      new MotionRenderError(
        "graphic_font_cap",
        `The font "${e.id}" is ${(bytes / 1024 / 1024).toFixed(1)} MB; a graphic's font file may be at most ${caps.fontBytes / 1024 / 1024} MB. Use a smaller font file (one weight, or a subset).`,
      );
    let body: Buffer;
    try {
      const size = (await stat(e.asset.path)).size;
      if (size > caps.fontBytes) throw tooBig(size);
      body = await readFile(e.asset.path, { signal: this.abort.signal });
    } catch (err) {
      if (err instanceof MotionRenderError) throw err;
      throw new MotionRenderError("graphic_media_failed", `The font "${e.id}" could not be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Check the asset in the project library, or pick another font.`);
    }
    if (body.length > caps.fontBytes) throw tooBig(body.length);
    return { status: 200, body };
  }
}
