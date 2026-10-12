import { mkdir, access, rename, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execa } from "execa";
import ort from "onnxruntime-node";
import { FFMPEG_BIN, FfmpegError, ffmpegStderrDetail } from "../ffmpeg/executor.js";

/**
 * AI background removal for PEOPLE with Robust Video Matting (RVM, GPL-3.0 —
 * the MobileNetV3 fp32 ONNX export) via onnxruntime-node: a CapCut-style auto
 * cutout with no green screen. RVM is a human-matting model; it is not meant
 * for products, animals or objects.
 *
 * RVM is RECURRENT: each frame's hidden state (r1o..r4o) is fed back as the
 * next frame's r1i..r4i, which is what keeps the matte temporally stable. So
 * frames go through strictly in order and the state starts from zeros per run.
 *
 * Pipeline: decoder ffmpeg → raw RGB frames on stdout → ORT per frame → the
 * encoder ffmpeg's stdin → FFV1 yuva420p .mkv (lossless, with alpha), with the
 * source audio remuxed. Runs fully locally; the model (~15 MB) is downloaded
 * once, verified (size + SHA-256) and cached with the other ONNX models.
 */

const MODEL_FILE = "rvm_mobilenetv3_fp32.onnx";
const MODEL_URL =
  "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/" + MODEL_FILE;
const MODEL_BYTES = 14_975_696;
const MODEL_SHA256 = "88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828";

/** Frames are processed at the source resolution, capped at this long edge. */
export const RVM_MAX_LONG_EDGE = 1920;

function modelsDir(): string {
  return process.env.AIVE_MODELS_DIR || join(homedir(), ".aive", "models");
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(p: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(p)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** True when `p` is exactly the published model (size, then SHA-256). */
async function isVerifiedModel(p: string): Promise<boolean> {
  try {
    if ((await stat(p)).size !== MODEL_BYTES) return false;
  } catch {
    return false;
  }
  return (await sha256File(p)) === MODEL_SHA256;
}

async function downloadModel(dest: string): Promise<string> {
  await mkdir(modelsDir(), { recursive: true });
  process.stderr.write(`[matte] downloading Robust Video Matting model (15 MB) …\n`);
  const res = await fetch(MODEL_URL, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download the RVM model (${res.status} ${res.statusText})`);
  }
  const tmp = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
    const size = (await stat(tmp)).size;
    if (size !== MODEL_BYTES) {
      throw new Error(`RVM model download is ${size} bytes, expected ${MODEL_BYTES}. Retry, or set AIVE_RVM_MODEL to a verified copy.`);
    }
    const digest = await sha256File(tmp);
    if (digest !== MODEL_SHA256) {
      throw new Error(`RVM model checksum mismatch (sha256 ${digest}, expected ${MODEL_SHA256}). Retry, or set AIVE_RVM_MODEL to a verified copy.`);
    }
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return dest;
}

/** Cached copy already checked this process (hashing on every call is wasteful). */
let verifiedPath: string | null = null;
/** One shared download, so concurrent callers never race on the same `.part` file. */
let downloading: Promise<string> | null = null;

/**
 * Ensure the RVM ONNX model is present locally; download on first use. The
 * download is verified against the published size + SHA-256 (deleted and
 * rejected on a mismatch); a cached copy that fails the check is replaced.
 * AIVE_RVM_MODEL points at a specific file instead (packaged builds set it to
 * the bundled copy; tests use it to run offline).
 */
export async function ensureRvmModel(): Promise<string> {
  if (process.env.AIVE_RVM_MODEL) {
    if (!(await exists(process.env.AIVE_RVM_MODEL))) {
      throw new Error(`AIVE_RVM_MODEL points at a missing file: ${process.env.AIVE_RVM_MODEL}`);
    }
    return process.env.AIVE_RVM_MODEL;
  }
  const dest = join(modelsDir(), MODEL_FILE);
  if (verifiedPath === dest) return dest;
  if (await exists(dest)) {
    if (await isVerifiedModel(dest)) {
      verifiedPath = dest;
      return dest;
    }
    process.stderr.write(`[matte] cached RVM model failed verification; downloading it again\n`);
    await rm(dest, { force: true });
  }
  if (!downloading) {
    downloading = downloadModel(dest).finally(() => {
      downloading = null;
    });
  }
  const path = await downloading;
  verifiedPath = path;
  return path;
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;

/** The process-wide RVM session (created once; retried if creation failed). */
function rvmSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    const p = ensureRvmModel().then((path) => ort.InferenceSession.create(path));
    sessionPromise = p;
    p.catch(() => {
      if (sessionPromise === p) sessionPromise = null;
    });
  }
  return sessionPromise;
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

/** Alpha-0 pixels at least one block (BLOCK = 1 << BLOCK_SHIFT px) from any visible pixel are flattened. */
const BLOCK_SHIFT = 4;
const BLOCK = 1 << BLOCK_SHIFT;
const INV255 = 1 / 255;

/** 0..255 byte from a float, clamped and rounded. */
function toByte(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0;
}

/**
 * Build one RGBA cutout frame. Opaque interior keeps the source pixels; toward
 * the edge (alpha < 1) it blends to RVM's foreground estimate `fgr`, which has
 * the old background colour removed from hair and edges. Fully transparent
 * blocks well away from the subject are flattened to black: invisible, but the
 * lossless FFV1 output then spends almost no bits on the removed background.
 * Runs once per frame on ~2 M pixels, so it writes each pixel as one 32-bit
 * word (little-endian → bytes R,G,B,A — every platform Node ships on).
 */
function cutoutFrame(rgb: Buffer, fgr: Float32Array, pha: Float32Array, w: number, h: number): Buffer {
  const n = w * h;
  const out = Buffer.allocUnsafe(n * 4);
  const px = new Uint32Array(out.buffer, out.byteOffset, n);
  const bw = (w + BLOCK - 1) >> BLOCK_SHIFT;
  const bh = (h + BLOCK - 1) >> BLOCK_SHIFT;
  const visible = new Uint8Array(bw * bh);
  for (let y = 0, i = 0; y < h; y++) {
    const brow = (y >> BLOCK_SHIFT) * bw;
    for (let x = 0; x < w; x++, i++) {
      const a = pha[i];
      const s = i * 3;
      if (a >= 0.998) {
        px[i] = rgb[s] | (rgb[s + 1] << 8) | (rgb[s + 2] << 16) | (255 << 24);
        visible[brow + (x >> BLOCK_SHIFT)] = 1;
        continue;
      }
      // Weight of the foreground estimate: 0 when opaque, 1 at alpha ≤ 0.9.
      const k = a >= 0.9 ? (1 - a) * 10 : 1;
      const alpha = toByte(a * 255);
      px[i] =
        toByte(rgb[s] + (fgr[i] * 255 - rgb[s]) * k) |
        (toByte(rgb[s + 1] + (fgr[n + i] * 255 - rgb[s + 1]) * k) << 8) |
        (toByte(rgb[s + 2] + (fgr[2 * n + i] * 255 - rgb[s + 2]) * k) << 16) |
        (alpha << 24);
      if (alpha !== 0) visible[brow + (x >> BLOCK_SHIFT)] = 1;
    }
  }
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let near = 0;
      for (let dy = -1; dy <= 1 && !near; dy++) {
        const yy = by + dy;
        if (yy < 0 || yy >= bh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = bx + dx;
          if (xx >= 0 && xx < bw && visible[yy * bw + xx]) {
            near = 1;
            break;
          }
        }
      }
      if (near) continue;
      const y1 = Math.min(h, (by + 1) * BLOCK);
      const x0 = bx * BLOCK;
      const x1 = Math.min(w, x0 + BLOCK);
      for (let y = by * BLOCK; y < y1; y++) out.fill(0, (y * w + x0) * 4, (y * w + x1) * 4);
    }
  }
  return out;
}

/** One gray (alpha-only) frame from RVM's `pha`, for the downscaled path. */
function alphaFrame(pha: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(pha.length);
  const px = new Uint8ClampedArray(out.buffer, out.byteOffset, out.length);
  for (let i = 0; i < pha.length; i++) px[i] = pha[i] * 255;
  return out;
}

export interface MatteOptions {
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
  /** Output path — an .mkv (FFV1 yuva420p + AAC). Deleted on error/cancel. */
  outPath: string;
  signal: AbortSignal;
  /** 0..1 as frames are processed (frames done / expected frames). */
  onProgress?: (fraction: number) => void;
  /**
   * Internal: processing long-edge cap (default {@link RVM_MAX_LONG_EDGE}).
   * Larger sources are matted at the capped size and only the alpha is scaled
   * back up and merged with the full-resolution source. Tests lower it to
   * exercise that path on small media.
   */
  maxLongEdge?: number;
}

export interface MatteStats {
  /** Frames matted and written. */
  frames: number;
  /** Output (baked) frame size. */
  width: number;
  height: number;
  /** Size RVM ran at. */
  procWidth: number;
  procHeight: number;
  /** True when the source exceeded the cap (alpha upscaled + merged with the full-res source). */
  downscaled: boolean;
  /** Wall-clock seconds for the whole matte + encode. */
  seconds: number;
}

/**
 * Matte a span of a video with RVM and bake a transparent cutout to
 * `opts.outPath`. Streams frames through two ffmpeg processes (never holding
 * the clip in memory), honours encoder backpressure, and stops promptly on
 * `opts.signal` (both processes killed, partial output deleted).
 *
 * - Native path (source long edge ≤ cap, the common case): RGBA frames built
 *   from RVM's foreground + alpha are encoded directly.
 * - Downscaled path (source larger than the cap): only the alpha is written;
 *   the encoder scales it to the source size and alphamerges it with the
 *   full-resolution source (opened again with the same seek/span/fps), so
 *   colour stays full resolution.
 */
export async function matteVideo(opts: MatteOptions): Promise<MatteStats> {
  const t0 = Date.now();
  const canceled = () => new Error("Background removal canceled");
  const cap = opts.maxLongEdge ?? RVM_MAX_LONG_EDGE;
  const longEdge = Math.max(opts.srcW, opts.srcH);
  const downscaled = longEdge > cap;
  const outW = evenFloor(opts.srcW);
  const outH = evenFloor(opts.srcH);
  const w = downscaled ? evenFloor(Math.round((opts.srcW * cap) / longEdge)) : outW;
  const h = downscaled ? evenFloor(Math.round((opts.srcH * cap) / longEdge)) : outH;
  const rate = String(Math.round(opts.fps * 1e6) / 1e6);
  const ss = opts.sourceIn.toFixed(6);
  const span = opts.span.toFixed(6);
  const expected = Math.max(1, Math.round(opts.span * opts.fps));

  const session = await rvmSession();
  if (opts.signal.aborted) throw canceled();

  // Decode at the asset's own fps to a fixed-size RGB stream. YCbCr→RGB here and
  // RGB→YCbCr in the encoder both use BT.709, so opaque pixels round-trip to the
  // source's own YUV values whatever its (often untagged) matrix was.
  const decArgs = [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-ss", ss, "-t", span, "-i", opts.input,
    "-map", "0:v:0",
    "-vf", `fps=${rate},scale=${w}:${h}:in_color_matrix=bt709,format=rgb24`,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ];
  const encArgs = ["-hide_banner", "-loglevel", "error"];
  if (downscaled) {
    encArgs.push(
      "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${w}x${h}`, "-r", rate, "-i", "pipe:0",
      "-ss", ss, "-t", span, "-i", opts.input,
      "-filter_complex",
      // Same fps= as the decoder so frame N of the source pairs with alpha frame N.
      `[1:v]fps=${rate},setpts=PTS-STARTPTS,scale=${outW}:${outH},format=yuva420p[base];` +
        `[0:v]setpts=PTS-STARTPTS,scale=${outW}:${outH}:flags=bilinear,format=gray[alpha];` +
        `[base][alpha]alphamerge[v]`,
      "-map", "[v]",
    );
    if (opts.withAudio) encArgs.push("-map", "1:a:0");
  } else {
    encArgs.push("-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-r", rate, "-i", "pipe:0");
    if (opts.withAudio) encArgs.push("-ss", ss, "-t", span, "-i", opts.input);
    encArgs.push("-map", "0:v:0");
    if (opts.withAudio) encArgs.push("-map", "1:a:0");
    encArgs.push("-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuva420p");
  }
  // FFV1 is lossless and keeps alpha; -g 1 makes every frame a keyframe so
  // trimmed clips seek instantly in export/preview renders.
  encArgs.push("-c:v", "ffv1", "-level", "3", "-slices", "16", "-g", "1", "-pix_fmt", "yuva420p");
  if (opts.withAudio) encArgs.push("-c:a", "aac", "-b:a", "192k");
  else encArgs.push("-an");
  encArgs.push("-y", opts.outPath);

  const decoder = execa(FFMPEG_BIN, decArgs, {
    reject: true,
    stdin: "ignore",
    buffer: { stdout: false, stderr: true },
    cancelSignal: opts.signal,
  });
  const encoder = execa(FFMPEG_BIN, encArgs, {
    reject: true,
    stdout: "ignore",
    buffer: { stderr: true },
    cancelSignal: opts.signal,
  });
  // Failures are inspected below once both have settled; never leave them unhandled.
  decoder.catch(() => {});
  encoder.catch(() => {});
  const stdin = encoder.stdin!;
  stdin.on("error", () => {}); // EPIPE surfaces via the write callback + the encoder's exit

  const n = w * h;
  const src = new Float32Array(3 * n);
  const srcTensor = new ort.Tensor("float32", src, [1, 3, h, w]);
  const ratio = new ort.Tensor("float32", new Float32Array([downsampleRatio(Math.max(w, h))]), [1]);
  const zero = () => new ort.Tensor("float32", new Float32Array(1), [1, 1, 1, 1]);
  let rec: Record<"r1i" | "r2i" | "r3i" | "r4i", ort.Tensor> = { r1i: zero(), r2i: zero(), r3i: zero(), r4i: zero() };

  const reader = new FrameReader(decoder.stdout!, n * 3);
  let frames = 0;
  let pending: Promise<void> | null = null;
  let failure: unknown = null;
  try {
    for (;;) {
      if (opts.signal.aborted) break;
      const rgb = await reader.next();
      if (!rgb || opts.signal.aborted) break;
      for (let i = 0, j = 0; i < n; i++, j += 3) {
        src[i] = rgb[j] * INV255;
        src[n + i] = rgb[j + 1] * INV255;
        src[2 * n + i] = rgb[j + 2] * INV255;
      }
      const out = await session.run({ src: srcTensor, ...rec, downsample_ratio: ratio });
      rec = { r1i: out.r1o, r2i: out.r2o, r3i: out.r3o, r4i: out.r4o };
      const pha = out.pha.data as Float32Array;
      const frame = downscaled ? alphaFrame(pha) : cutoutFrame(rgb, out.fgr.data as Float32Array, pha, w, h);
      // Keep one write in flight: the encoder compresses frame N while RVM runs N+1.
      if (pending) await pending;
      pending = writeFrame(stdin, frame);
      pending.catch(() => {});
      frames++;
      opts.onProgress?.(Math.min(0.99, frames / expected));
    }
    if (pending) await pending;
  } catch (err) {
    failure = err;
  }

  try {
    if (failure || opts.signal.aborted) {
      decoder.kill();
      encoder.kill();
    }
    stdin.end();
    const [dec, enc] = await Promise.allSettled([decoder, encoder]);
    if (opts.signal.aborted) throw canceled();
    if (failure && !isPipeError(failure)) throw failure;
    if (enc.status === "rejected") throw ffmpegFailure(enc.reason, "encoder", encArgs);
    if (dec.status === "rejected") throw ffmpegFailure(dec.reason, "decoder", decArgs);
    if (failure) throw failure;
    if (frames === 0) throw new Error("Background removal decoded no video frames from the clip's source span");
  } catch (err) {
    await rm(opts.outPath, { force: true });
    throw err;
  }

  opts.onProgress?.(1);
  return { frames, width: outW, height: outH, procWidth: w, procHeight: h, downscaled, seconds: (Date.now() - t0) / 1000 };
}
