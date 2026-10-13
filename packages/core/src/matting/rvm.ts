import { mkdir, access, rename, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Worker } from "node:worker_threads";
import { FfmpegError } from "../ffmpeg/executor.js";
import { runMattePipeline, type PipelineOptions, type PipelineStats } from "./rvm-pipeline.js";
import type { MainToWorker, WorkerToMain } from "./rvm-worker.js";

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
 * Pipeline (rvm-pipeline.ts, run in a worker thread by rvm-worker.ts):
 * decoder ffmpeg → raw RGB frames → ORT per frame → the encoder ffmpeg's stdin
 * → the person's MATTE as a lossless FFV1 gray .mkv, with the span's audio
 * remuxed. The colour is not stored: the cutout asset points back at the
 * original footage, and renders alphamerge the two (ffmpeg/cutout.ts). Runs
 * fully locally; the model (~15 MB) is downloaded once, verified (size +
 * SHA-256) and cached with the other ONNX models.
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
  /** Output path — an .mkv: the matte (FFV1 gray) + the span's audio (FLAC). Deleted on error/cancel. */
  outPath: string;
  signal: AbortSignal;
  /** 0..1 as frames are processed (frames done / expected frames). */
  onProgress?: (fraction: number) => void;
  /**
   * Internal: processing long-edge cap (default {@link RVM_MAX_LONG_EDGE}).
   * Larger sources are matted at the capped size and only the matte is scaled
   * back up to the source size. Tests lower it to exercise that path on small
   * media.
   */
  maxLongEdge?: number;
  /**
   * Internal (tests): a deterministic stand-in matte (a soft luma key of each
   * frame) instead of RVM, so the whole pipeline runs without the model.
   */
  stubMatte?: boolean;
}

export interface MatteStats extends PipelineStats {
  /** Where inference ran: a worker thread (normal) or the calling thread (fallback / AIVE_RVM_INLINE=1). */
  runner: "worker" | "inline";
}

/** How long a canceled worker gets to stop its ffmpeg children and clean up before it is terminated. */
const CANCEL_GRACE_MS = 5000;

/** The worker entry next to this module (.ts when running from source under tsx, .js from dist). */
function workerUrl(): URL {
  return new URL(import.meta.url.endsWith(".ts") ? "./rvm-worker.ts" : "./rvm-worker.js", import.meta.url);
}

function fromWorkerError(e: { name: string; message: string; command?: string; stderr?: string }): Error {
  if (e.name === "FfmpegError") return new FfmpegError(e.message, e.command ?? "", e.stderr ?? "");
  const err = new Error(e.message);
  err.name = e.name;
  return err;
}

function killAll(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

type WorkerOutcome = { kind: "done"; stats: PipelineStats } | { kind: "unavailable"; reason: string };

/**
 * Run the pipeline in a worker thread. Resolves `unavailable` only when the
 * worker failed before the model was loaded (no ORT in a worker on this
 * platform), so the caller can fall back to the calling thread; every later
 * failure rejects. Cancel asks the worker to stop (it kills its ffmpeg
 * children and deletes the partial output); a worker that doesn't answer in
 * time is terminated and its children killed here.
 */
function runInWorker(data: PipelineOptions, opts: MatteOptions): Promise<WorkerOutcome> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(workerUrl(), { workerData: data });
    } catch (err) {
      resolve({ kind: "unavailable", reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    let ready = false;
    let settled = false;
    let pids: number[] = [];
    let graceTimer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      opts.signal.removeEventListener("abort", onAbort);
      void worker.terminate().catch(() => {});
      fn();
    };
    const onAbort = () => {
      worker.postMessage({ type: "cancel" } satisfies MainToWorker);
      graceTimer = setTimeout(() => {
        killAll(pids);
        void rm(data.outPath, { force: true }).catch(() => {});
        finish(() => reject(new Error("Background removal canceled")));
      }, CANCEL_GRACE_MS);
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (m: WorkerToMain) => {
      if (m.type === "ready") ready = true;
      else if (m.type === "pids") pids = m.pids;
      else if (m.type === "progress") opts.onProgress?.(m.fraction);
      else if (m.type === "done") finish(() => resolve({ kind: "done", stats: m.stats }));
      else if (m.type === "error") {
        const err = opts.signal.aborted ? new Error("Background removal canceled") : fromWorkerError(m.error);
        if (!ready && !opts.signal.aborted && !(err instanceof FfmpegError)) finish(() => resolve({ kind: "unavailable", reason: err.message }));
        else finish(() => reject(err));
      }
    });
    worker.on("error", (err) => {
      if (!ready && !opts.signal.aborted) finish(() => resolve({ kind: "unavailable", reason: err.message }));
      else {
        killAll(pids);
        void rm(data.outPath, { force: true }).catch(() => {});
        finish(() => reject(opts.signal.aborted ? new Error("Background removal canceled") : err));
      }
    });
    worker.on("exit", (code) => {
      if (settled) return;
      killAll(pids);
      void rm(data.outPath, { force: true }).catch(() => {});
      if (!ready && !opts.signal.aborted) finish(() => resolve({ kind: "unavailable", reason: `worker exited with code ${code}` }));
      else finish(() => reject(opts.signal.aborted ? new Error("Background removal canceled") : new Error(`Background removal worker stopped unexpectedly (exit code ${code})`)));
    });
  });
}

/**
 * Matte a span of a video with RVM and bake the person's MATTE to
 * `opts.outPath` (lossless FFV1 gray, one frame per frame of the span at the
 * source size, plus the span's audio). Inference runs in a worker thread so
 * the core stays responsive; it stops promptly on `opts.signal` (ffmpeg
 * children killed, partial output deleted). Sources over the cap are matted
 * at the capped size and the matte is scaled up to the source size.
 */
export async function matteVideo(opts: MatteOptions): Promise<MatteStats> {
  const modelPath = opts.stubMatte ? "" : await ensureRvmModel();
  if (opts.signal.aborted) throw new Error("Background removal canceled");
  const data: PipelineOptions = {
    input: opts.input,
    sourceIn: opts.sourceIn,
    span: opts.span,
    srcW: opts.srcW,
    srcH: opts.srcH,
    fps: opts.fps,
    withAudio: opts.withAudio,
    outPath: opts.outPath,
    maxLongEdge: opts.maxLongEdge ?? RVM_MAX_LONG_EDGE,
    modelPath,
    ...(opts.stubMatte ? { stubMatte: true } : {}),
  };
  if (process.env.AIVE_RVM_INLINE !== "1") {
    const outcome = await runInWorker(data, opts);
    if (outcome.kind === "done") return { ...outcome.stats, runner: "worker" };
    process.stderr.write(`[matte] worker thread unavailable (${outcome.reason}); matting on the main thread\n`);
    if (opts.signal.aborted) throw new Error("Background removal canceled");
  }
  const stats = await runMattePipeline(data, opts.signal, { onProgress: opts.onProgress });
  return { ...stats, runner: "inline" };
}
