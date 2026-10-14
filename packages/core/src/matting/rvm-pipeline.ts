import { rm } from "../io/gatedfs.js";
import type { Readable, Writable } from "node:stream";
import { FFMPEG_BIN, FfmpegError, ffmpegStderrDetail, spawnFfmpegStream } from "../ffmpeg/executor.js";

/**
 * The remove_background frame pipeline: decoder ffmpeg → raw RGB frames →
 * Robust Video Matting (onnxruntime-node) per frame → the encoder ffmpeg's
 * stdin → a lossless gray MATTE (FFV1 .mkv) with the span's audio remuxed.
 *
 * It normally runs in a worker thread (rvm-worker.ts), because an ORT run is
 * synchronous on the thread that calls it (~0.1 s per 1080p frame on CPU) and
 * would hold up every RPC of the core while a clip is matted. rvm.ts falls
 * back to running it on the calling thread when a worker can't start.
 *
 * RVM is RECURRENT: each frame's hidden state (r1o..r4o) is fed back as the
 * next frame's r1i..r4i, which keeps the matte temporally stable, so frames go
 * through strictly in order and the state starts from zeros per run.
 */

export interface PipelineOptions {
  /** Source media file. */
  input: string;
  /** Seek offset into the source, seconds. */
  sourceIn: number;
  /** Length of the span to process, seconds. */
  span: number;
  /** Source DISPLAY dimensions (post-rotation, as probed). */
  srcW: number;
  srcH: number;
  /** Frame rate to process and bake at (the asset's own fps). */
  fps: number;
  /** Remux the source's first audio stream (same span) into the output. */
  withAudio: boolean;
  /** Output .mkv: the matte (FFV1 gray) + the span's audio (FLAC). Deleted on error/cancel. */
  outPath: string;
  /** Processing long-edge cap: larger sources are matted at the capped size and the matte is scaled up. */
  maxLongEdge: number;
  /** Verified RVM model file (unused with `stubMatte`). */
  modelPath: string;
  /** Tests: a deterministic stand-in matte (a soft luma key of each frame) instead of RVM. */
  stubMatte?: boolean;
  /** Tests: with `stubMatte`, block the thread this long on each frame (rvm.ts MatteOptions.stubStallMs). */
  stubStallMs?: number;
}

export interface PipelineStats {
  /** Frames matted and written. */
  frames: number;
  /** Output (matte) frame size. */
  width: number;
  height: number;
  /** Size RVM ran at. */
  procWidth: number;
  procHeight: number;
  /** True when the source exceeded the cap (the matte was scaled up to the source size). */
  downscaled: boolean;
  /** Wall-clock seconds for the whole matte + encode. */
  seconds: number;
}

export interface PipelineHooks {
  /** 0..1 as frames are processed (frames done / expected frames). */
  onProgress?: (fraction: number) => void;
  /** The model is loaded; ffmpeg starts next. */
  onReady?: () => void;
  /** PIDs of the decoder and encoder (so a stuck worker's children can still be killed). */
  onPids?: (pids: number[]) => void;
}

/** RVM's recommended downsample_ratio for a processed long edge. */
function downsampleRatio(longEdge: number): number {
  if (longEdge >= 1700) return 0.25;
  if (longEdge >= 1100) return 0.375;
  return 0.5;
}

/** Round down to an even size (yuv420 needs even dimensions); never upscales. */
function evenFloor(n: number): number {
  return Math.max(2, 2 * Math.floor(n / 2));
}

/**
 * Reassembles exact-size frames from a rawvideo byte stream (pipe chunks never
 * line up with frame boundaries) and keeps a short read-ahead queue, so the
 * decoder keeps working while a frame is in inference. The stream is paused
 * while the queue is full.
 */
class FrameReader {
  private readonly queue: Buffer[] = [];
  private cur: Buffer;
  private filled = 0;
  private ended = false;
  private error: Error | null = null;
  private waiter: (() => void) | null = null;

  constructor(
    private readonly stream: Readable,
    private readonly frameBytes: number,
    private readonly maxQueued = 3,
  ) {
    this.cur = Buffer.allocUnsafe(frameBytes);
    stream.on("data", (chunk: Buffer) => this.push(chunk));
    stream.on("end", () => this.finish());
    stream.on("close", () => this.finish());
    stream.on("error", (err: Error) => {
      this.error = err;
      this.finish();
    });
  }

  private push(chunk: Buffer): void {
    let off = 0;
    while (off < chunk.length) {
      const n = Math.min(this.frameBytes - this.filled, chunk.length - off);
      chunk.copy(this.cur, this.filled, off, off + n);
      this.filled += n;
      off += n;
      if (this.filled === this.frameBytes) {
        this.queue.push(this.cur);
        this.cur = Buffer.allocUnsafe(this.frameBytes);
        this.filled = 0;
      }
    }
    if (this.queue.length >= this.maxQueued) this.stream.pause();
    this.wake();
  }

  private finish(): void {
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  /** The next complete frame, or null at end of stream (a trailing partial frame is dropped). */
  async next(): Promise<Buffer | null> {
    for (;;) {
      const frame = this.queue.shift();
      if (frame) {
        if (this.queue.length < this.maxQueued) this.stream.resume();
        return frame;
      }
      if (this.error) throw this.error;
      if (this.ended) return null;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

/** Resolve once `buf` is flushed to the pipe — this is the backpressure on the encoder. */
function writeFrame(stdin: Writable, buf: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stdin.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

/** Errors that only mean "the other end of the pipe went away". */
function isPipeError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END" || code === "ECONNRESET";
}

function ffmpegFailure(err: unknown, role: string, args: string[]): Error {
  const e = err as { stderr?: unknown; shortMessage?: string; message?: string };
  const stderr = typeof e.stderr === "string" ? e.stderr : "";
  const detail = ffmpegStderrDetail(stderr);
  return new FfmpegError(
    `Background removal ${role} failed: ${detail || e.shortMessage || e.message || "unknown error"}`,
    `${FFMPEG_BIN} ${args.join(" ")}`,
    stderr,
  );
}

const INV255 = 1 / 255;

/** One RGB frame (w×h×3 bytes) in, one gray matte frame (w×h bytes) out. */
type Matter = (rgb: Buffer) => Promise<Buffer>;

type OrtModule = typeof import("onnxruntime-node");
type OrtSession = import("onnxruntime-node").InferenceSession;

/** The RVM session of this thread (created once per model file; retried if creation failed). */
let session: { path: string; promise: Promise<{ ort: OrtModule; session: OrtSession }> } | null = null;

function rvmSession(modelPath: string): Promise<{ ort: OrtModule; session: OrtSession }> {
  if (!session || session.path !== modelPath) {
    const promise = import("onnxruntime-node").then(async (mod) => {
      const ort = ((mod as { default?: OrtModule }).default ?? mod) as OrtModule;
      return { ort, session: await ort.InferenceSession.create(modelPath) };
    });
    const entry = { path: modelPath, promise };
    session = entry;
    promise.catch(() => {
      if (session === entry) session = null;
    });
  }
  return session.promise;
}

/**
 * The RVM outputs the pipeline reads: the alpha and the recurrent state. Not the foreground `fgr`, a
 * 1x3xHxW float tensor (24.9 MB per 1080p frame): copying it out and collecting it cost ~13% of a
 * job's throughput (9.7 -> 11.0 fps measured, identical mattes).
 */
const FETCHES = ["pha", "r1o", "r2o", "r3o", "r4o"];

async function rvmMatter(modelPath: string, w: number, h: number): Promise<Matter> {
  const { ort, session: s } = await rvmSession(modelPath);
  const n = w * h;
  const src = new Float32Array(3 * n);
  const srcTensor = new ort.Tensor("float32", src, [1, 3, h, w]);
  const ratio = new ort.Tensor("float32", new Float32Array([downsampleRatio(Math.max(w, h))]), [1]);
  const zero = () => new ort.Tensor("float32", new Float32Array(1), [1, 1, 1, 1]);
  let rec: Record<"r1i" | "r2i" | "r3i" | "r4i", import("onnxruntime-node").Tensor> = { r1i: zero(), r2i: zero(), r3i: zero(), r4i: zero() };
  return async (rgb) => {
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      src[i] = rgb[j] * INV255;
      src[n + i] = rgb[j + 1] * INV255;
      src[2 * n + i] = rgb[j + 2] * INV255;
    }
    const out = await s.run({ src: srcTensor, ...rec, downsample_ratio: ratio }, FETCHES);
    rec = { r1i: out.r1o, r2i: out.r2o, r3i: out.r3o, r4i: out.r4o };
    const pha = out.pha.data as Float32Array;
    const alpha = Buffer.allocUnsafe(n);
    const px = new Uint8ClampedArray(alpha.buffer, alpha.byteOffset, n);
    for (let i = 0; i < n; i++) px[i] = pha[i] * 255;
    return alpha;
  };
}

/** Tests: a soft luma key (deterministic, follows the picture frame by frame, with partial alpha at edges). */
function stubMatter(w: number, h: number, stallMs = 0): Matter {
  const n = w * h;
  return async (rgb) => {
    if (stallMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
    const alpha = Buffer.allocUnsafe(n);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const y = (77 * rgb[j] + 150 * rgb[j + 1] + 29 * rgb[j + 2]) >> 8;
      alpha[i] = y <= 64 ? 0 : y >= 160 ? 255 : ((y - 64) * 255) / 96;
    }
    return alpha;
  };
}

/**
 * Matte a span of a video and bake the matte to `o.outPath`. Streams frames
 * through two ffmpeg processes (never holding the clip in memory), honours
 * encoder backpressure, and stops promptly on `signal` (both processes
 * killed, partial output deleted).
 *
 * The decoder converts to RGB at the processing size (the source size, or the
 * capped size for large sources); the encoder scales a capped matte back up to
 * the source size (bilinear) so it lines up with the full-resolution colour.
 */
export async function runMattePipeline(o: PipelineOptions, signal: AbortSignal, hooks: PipelineHooks = {}): Promise<PipelineStats> {
  const t0 = Date.now();
  const canceled = () => new Error("Background removal canceled");
  const cap = o.maxLongEdge;
  const longEdge = Math.max(o.srcW, o.srcH);
  const downscaled = longEdge > cap;
  const outW = evenFloor(o.srcW);
  const outH = evenFloor(o.srcH);
  const w = downscaled ? evenFloor(Math.round((o.srcW * cap) / longEdge)) : outW;
  const h = downscaled ? evenFloor(Math.round((o.srcH * cap) / longEdge)) : outH;
  const rate = String(Math.round(o.fps * 1e6) / 1e6);
  const ss = o.sourceIn.toFixed(6);
  const span = o.span.toFixed(6);
  const expected = Math.max(1, Math.round(o.span * o.fps));

  const matter = o.stubMatte ? stubMatter(w, h, o.stubStallMs) : await rvmMatter(o.modelPath, w, h);
  hooks.onReady?.();
  // Let a cancel that arrived during the model load be delivered before any ffmpeg starts
  // (rvm.ts answers such a cancel at once and expects no output from this run).
  await new Promise<void>((r) => setImmediate(r));
  if (signal.aborted) throw canceled();

  // Decode at the asset's own fps to a fixed-size RGB stream (BT.709, as RVM was trained on).
  const decArgs = [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-ss", ss, "-t", span, "-i", o.input,
    "-map", "0:v:0",
    "-vf", `fps=${rate},scale=${w}:${h}:in_color_matrix=bt709,format=rgb24`,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ];
  const encArgs = ["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${w}x${h}`, "-r", rate, "-i", "pipe:0"];
  if (o.withAudio) encArgs.push("-ss", ss, "-t", span, "-i", o.input);
  encArgs.push("-map", "0:v:0");
  if (o.withAudio) encArgs.push("-map", "1:a:0");
  if (downscaled) encArgs.push("-vf", `scale=${outW}:${outH}:flags=bilinear,format=gray`);
  // FFV1 is lossless; -g 1 makes every frame a keyframe so trimmed clips seek instantly.
  encArgs.push("-c:v", "ffv1", "-level", "3", "-slices", "16", "-g", "1", "-pix_fmt", "gray");
  // FLAC, not AAC: AAC's encoder delay would make Matroska start the VIDEO ~23 ms late, more than
  // a 60 fps frame, and a seek in the matte would then land a frame away from the same seek in the
  // colour. FLAC has no delay (and keeps the audio lossless).
  if (o.withAudio) encArgs.push("-c:a", "flac");
  else encArgs.push("-an");
  encArgs.push("-y", o.outPath);

  // Both are only ever stopped to throw their output away, so SIGKILL: an ffmpeg blocked
  // writing to a pipe nobody reads any more ignores SIGTERM (until execa's 5 s force-kill).
  const decoder = spawnFfmpegStream(decArgs, {
    reject: true,
    stdin: "ignore",
    buffer: { stdout: false, stderr: true },
    cancelSignal: signal,
    killSignal: "SIGKILL",
  });
  const encoder = spawnFfmpegStream(encArgs, {
    reject: true,
    stdout: "ignore",
    buffer: { stderr: true },
    cancelSignal: signal,
    killSignal: "SIGKILL",
  });
  // Failures are inspected below once both have settled; never leave them unhandled.
  decoder.catch(() => {});
  encoder.catch(() => {});
  hooks.onPids?.([decoder.pid, encoder.pid].filter((p): p is number => typeof p === "number"));
  const stdin = encoder.stdin!;
  stdin.on("error", () => {}); // EPIPE surfaces via the write callback + the encoder's exit

  const reader = new FrameReader(decoder.stdout!, w * h * 3);
  let frames = 0;
  let pending: Promise<void> | null = null;
  let failure: unknown = null;
  try {
    for (;;) {
      if (signal.aborted) break;
      const rgb = await reader.next();
      if (!rgb || signal.aborted) break;
      const alpha = await matter(rgb);
      // Keep one write in flight: the encoder compresses frame N while RVM runs N+1.
      if (pending) await pending;
      pending = writeFrame(stdin, alpha);
      pending.catch(() => {});
      frames++;
      hooks.onProgress?.(Math.min(0.99, frames / expected));
    }
    if (pending) await pending;
  } catch (err) {
    failure = err;
  }

  try {
    if (failure || signal.aborted) {
      decoder.kill();
      encoder.kill();
    }
    stdin.end();
    const [dec, enc] = await Promise.allSettled([decoder, encoder]);
    if (signal.aborted) throw canceled();
    if (failure && !isPipeError(failure)) throw failure;
    if (enc.status === "rejected") throw ffmpegFailure(enc.reason, "encoder", encArgs);
    if (dec.status === "rejected") throw ffmpegFailure(dec.reason, "decoder", decArgs);
    if (failure) throw failure;
    if (frames === 0) throw new Error("Background removal decoded no video frames from the clip's source span");
  } catch (err) {
    await rm(o.outPath, { force: true });
    throw err;
  }

  hooks.onProgress?.(1);
  return { frames, width: outW, height: outH, procWidth: w, procHeight: h, downscaled, seconds: (Date.now() - t0) / 1000 };
}
