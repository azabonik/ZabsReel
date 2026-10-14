/**
 * Waveform peaks for the timeline (GET /peaks in server.ts). The renderer used
 * to fetch and decodeAudioData the WHOLE media file to draw a waveform: a
 * detached-audio clip of a 10-min 1080p video (1.1 GB) cost +2259 MB of
 * renderer memory and a 659 ms main-thread stall, six 10-min audio assets
 * +3281 MB. Here FFmpeg streams the first audio stream as 44.1 kHz float PCM
 * and the core folds it into max-abs buckets as it arrives, never holding the
 * PCM (that 10-min video: 0.62 s cold, about 50 MB for FFmpeg). The renderer
 * fetches 4 × buckets bytes: +11-15 MB and no frame longer than 19 ms for the
 * same video or six 10-min assets at once.
 *
 * The maths is apps/desktop/src/waveform.ts toPeaks: channel 0 (what
 * getChannelData(0) reads), floor(samples / buckets) samples a bucket, the
 * max |sample| in each, normalised to the loudest bucket. Measured against
 * the renderer's decode: AAC identical, 16-bit wav within 0.00003 (one 16-bit
 * step), mp3 within 0.021 (the two mp3 decoders skip different priming).
 *
 * Results are cached as raw Float32 (little-endian, as FFmpeg's f32le and
 * every platform SynthCut ships on; the renderer reads a Float32Array) under
 * <dataDir>/cache/peaks/<sha256(path, size, mtime, buckets)>.f32, written to a
 * temp name and renamed into place. pruneDataDir (gc.ts) only prunes
 * cache/segments, and the storage report counts cache/ as cache, never as
 * project media.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { FFMPEG_BIN, ffmpegArgsLocalOnly, runFfprobe } from "../ffmpeg/executor.js";

/** Buckets when the request names none (the renderer's DEFAULT_BUCKETS). */
export const PEAKS_BUCKETS_DEFAULT = 1600;
export const PEAKS_BUCKETS_MIN = 16;
export const PEAKS_BUCKETS_MAX = 8192;
/** The rate the PCM is read at (the renderer's AudioContext rate the peaks were matched against). */
const SAMPLE_RATE = 44100;
/** Peak jobs running at once; more wait their turn (each is one FFmpeg decode, about 50 MB). */
const RUNNING_MAX = 2;

export interface PeaksQuery {
  path: string;
  buckets: number;
}

/** The query from a /peaks URL, or an error message. */
export function parsePeaksQuery(q: URLSearchParams): PeaksQuery | string {
  const path = q.get("path");
  if (!path) return "Missing 'path'";
  const raw = q.get("buckets");
  const buckets = raw === null ? PEAKS_BUCKETS_DEFAULT : Number(raw);
  if (raw === "" || !Number.isInteger(buckets) || buckets < PEAKS_BUCKETS_MIN || buckets > PEAKS_BUCKETS_MAX) {
    return `'buckets' must be an integer in ${PEAKS_BUCKETS_MIN}..${PEAKS_BUCKETS_MAX}`;
  }
  return { path, buckets };
}

/** A media file without an audio stream (or one FFmpeg can't decode): no peaks. */
export class NoAudioError extends Error {}

let running = 0;
const waiting: (() => void)[] = [];
const inflight = new Map<string, Promise<Buffer>>();
let computed = 0;

/** How many peak arrays were computed (not read from the cache) in this process. */
export function peaksComputedCount(): number {
  return computed;
}

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= RUNNING_MAX) await new Promise<void>((r) => waiting.push(r));
  else running++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

/**
 * `buckets` peaks of `path` as Float32 bytes, from the cache or
 * computed (at most RUNNING_MAX at once; one job per cache key). The caller
 * has checked that the core may read `path`.
 */
export async function peaksFor(path: string, buckets: number, dataDir: string): Promise<Buffer> {
  const info = await stat(path);
  const key = createHash("sha256").update(JSON.stringify([path, info.size, info.mtimeMs, buckets])).digest("hex");
  const dir = join(dataDir, "cache", "peaks");
  const file = join(dir, `${key}.f32`);
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = (async () => {
    try {
      const hit = await readFile(file);
      if (hit.length === buckets * 4) return hit;
    } catch {
      /* not cached yet */
    }
    const peaks = await slot(() => computePeaks(path, buckets));
    computed++;
    const out = Buffer.from(peaks.buffer, peaks.byteOffset, peaks.byteLength);
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      await writeFile(tmp, out);
      await rename(tmp, file);
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
    }
    return out;
  })();
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

/** Channel 0 of the first audio stream folded into `buckets` normalised max-abs peaks. */
async function computePeaks(path: string, buckets: number): Promise<Float32Array> {
  let probe: { streams?: { channels?: number; duration?: string }[]; format?: { duration?: string } };
  try {
    probe = JSON.parse(await runFfprobe(["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels,duration:format=duration", "-of", "json", path]));
  } catch {
    throw new NoAudioError("The file could not be probed");
  }
  const stream = probe.streams?.[0];
  const channels = Number(stream?.channels);
  const dur = Number(stream?.duration ?? probe.format?.duration);
  if (!stream || !Number.isInteger(channels) || channels < 1 || channels > 64) throw new NoAudioError("No audio stream");
  if (!(dur > 0)) throw new NoAudioError("The audio stream has no duration");
  // The sample count the renderer's decode would hold, from the duration (it
  // decides the bucket size before the PCM arrives).
  const n = Math.round(dur * SAMPLE_RATE);
  const size = Math.max(1, Math.floor(n / buckets));
  const out = new Float32Array(buckets);
  // Interleaved PCM at the stream's own channel count; every channels-th
  // sample is channel 0. -ar resamples without a filtergraph.
  const args = [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-i", path, "-map", "0:a:0",
    "-ac", String(channels), "-ar", String(SAMPLE_RATE), "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1",
  ];
  const child = execa(FFMPEG_BIN, ffmpegArgsLocalOnly(args), { stdin: "ignore", stderr: "ignore", buffer: false, reject: false });
  const frameBytes = channels * 4;
  let carry: Buffer = Buffer.alloc(0);
  let idx = 0;
  child.stdout!.on("data", (chunk: Buffer) => {
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const whole = buf.length - (buf.length % frameBytes);
    // Copied into an aligned Float32Array: half the time of readFloatLE per
    // sample (86 vs 186 ms for 10 min of stereo).
    const f = new Float32Array(whole / 4);
    new Uint8Array(f.buffer).set(buf.subarray(0, whole));
    for (let k = 0; k < f.length; k += channels, idx++) {
      const b = Math.floor(idx / size);
      if (b >= buckets) continue;
      const a = Math.abs(f[k]);
      if (a > out[b]) out[b] = a;
    }
    carry = Buffer.from(buf.subarray(whole));
  });
  const done = await child;
  if (done.exitCode !== 0 || idx === 0) throw new NoAudioError("The audio could not be decoded");
  let max = 1e-6;
  for (let i = 0; i < buckets; i++) if (out[i] > max) max = out[i];
  const norm = max > 0 ? 1 / max : 1;
  for (let i = 0; i < buckets; i++) out[i] = Math.min(1, out[i] * norm);
  return out;
}
