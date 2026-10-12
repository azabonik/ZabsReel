import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runFfmpeg, runFfprobe } from "./executor.js";

/**
 * Time-effect bakes: chunked frame-exact REVERSE and SMOOTH SLOW MOTION
 * (frame interpolation). Pure FFmpeg orchestration — the engine owns the
 * project/asset bookkeeping.
 */

/** Longest segment (seconds) reversed in one go: `reverse`/`areverse` buffer ALL their input. */
export const REVERSE_CHUNK_SECONDS = 2;

/**
 * Budget (bytes) for the DECODED frames one reverse chunk buffers. Measured peak
 * RSS of a 4K60 8-bit source (12.4 MB per frame): 120 frames 5.8 GB, 33 frames
 * 2.9 GB, 16 frames 1.8 GB (the encoder adds a fixed share on top). 200 MB of
 * raw frames keeps a 4K chunk near 1.8 GB and 1080p chunks at the full 2 s.
 */
export const REVERSE_BUFFER_BUDGET_BYTES = 200 * 1024 * 1024;
const MIN_CHUNK_FRAMES = 8;

export interface VideoFormat {
  width: number;
  height: number;
  pixFmt: string;
  /** True when the pixel format carries an alpha plane. */
  hasAlpha: boolean;
}

/** Approximate bytes per pixel of an ffmpeg pix_fmt name (subsampling, bit depth, alpha). */
export function bytesPerPixel(pixFmt: string): number {
  const f = pixFmt.toLowerCase();
  const deep = /(9|10|12|14|16)(le|be)?$/.test(f) || /^p0(10|12|16)/.test(f) ? 2 : 1;
  let samples = 1.5; // 4:2:0 and the other subsampled planar formats
  if (/^(rgba|bgra|argb|abgr)/.test(f)) samples = 4;
  else if (/^(rgb|bgr|gbr)/.test(f) || /444/.test(f)) samples = 3;
  else if (/422/.test(f)) samples = 2;
  else if (/^(gray|y8|y16)/.test(f)) samples = 1;
  if (/^(yuva|gbrap)/.test(f)) samples += 1;
  return samples * deep;
}

/** Frames per reverse chunk: <= 2 s, and small enough that the decoded frames fit the RAM budget. */
export function reverseChunkFrames(fps: number, fmt?: Pick<VideoFormat, "width" | "height" | "pixFmt">): number {
  const cap = Math.max(1, Math.round(REVERSE_CHUNK_SECONDS * fps));
  if (!fmt || !(fmt.width > 0) || !(fmt.height > 0)) return cap;
  const frameBytes = fmt.width * fmt.height * bytesPerPixel(fmt.pixFmt || "yuv420p");
  const byBudget = Math.floor(REVERSE_BUFFER_BUDGET_BYTES / frameBytes);
  return Math.min(cap, Math.max(Math.min(MIN_CHUNK_FRAMES, cap), byBudget));
}

/** Probe the first video stream's size and pixel format (alpha-aware). */
export async function probeVideoFormat(file: string): Promise<VideoFormat | undefined> {
  try {
    const out = await runFfprobe(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,pix_fmt", "-of", "json", file]);
    const st = (JSON.parse(out) as { streams?: { width?: number; height?: number; pix_fmt?: string }[] }).streams?.[0];
    if (!st) return undefined;
    const pixFmt = st.pix_fmt ?? "yuv420p";
    return { width: st.width ?? 0, height: st.height ?? 0, pixFmt, hasAlpha: /^(yuva|gbrap|rgba|bgra|argb|abgr|ya\d)/.test(pixFmt) };
  } catch {
    return undefined;
  }
}

/** An ffmpeg rate expression; keeps NTSC rates exact (29.97 -> 30000/1001). */
export function rateExpr(fps: number): string {
  for (const base of [24, 30, 48, 60, 120]) {
    if (Math.abs(fps - (base * 1000) / 1001) < 0.005) return `${base * 1000}/1001`;
  }
  return String(Math.round(fps * 1000) / 1000);
}

export interface ReverseBakeOptions {
  input: string;
  hasVideo: boolean;
  /** Reverse the audio (only meaningful when the input has audio). */
  reverseAudio: boolean;
  /** Frame grid of the SOURCE (asset fps for video; project fps for audio-only). */
  gridFps: number;
  /** Start of the span in source seconds (snapped to the grid internally). */
  startSec: number;
  /** Length of the span in source seconds. */
  spanSec: number;
  /** Final output (.mp4, or .m4a for audio-only; .mkv when `alpha`). */
  outPath: string;
  /** Source has an alpha channel: chunks are FFV1 yuva420p and the output is Matroska so the cutout survives. */
  alpha?: boolean;
  /** Source size / pixel format, used to size chunks by a RAM budget. */
  format?: Pick<VideoFormat, "width" | "height" | "pixFmt">;
  /** Scratch directory (created, and always removed). */
  workDir: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/**
 * Bake a reversed copy of a span without holding it in RAM: cut the span into
 * <= 2 s chunks that tile the timeline half-open (each chunk starts half a frame
 * before its first frame, so a frame's timestamp can never land on a boundary),
 * reverse + encode each chunk once (H.264 CRF 18, or lossless FFV1 yuva420p for sources with alpha; audio as PCM), then stitch the
 * chunks in reverse order with the concat demuxer (stream copy for video) and
 * encode the audio to AAC 192k in the same mux. Returns the number of video
 * frames written (0 for audio-only).
 */
export async function bakeReversed(o: ReverseBakeOptions): Promise<{ frames: number }> {
  const fps = o.gridFps;
  const k0 = Math.round(o.startSec * fps);
  const total = Math.max(1, Math.round(o.spanSec * fps));
  const chunkFrames = o.hasVideo ? reverseChunkFrames(fps, o.format) : Math.max(1, Math.round(REVERSE_CHUNK_SECONDS * fps));
  const rate = rateExpr(fps);
  const withAudio = o.reverseAudio;

  await rm(o.workDir, { recursive: true, force: true });
  await mkdir(o.workDir, { recursive: true });
  try {
    const chunks: { a: number; n: number }[] = [];
    for (let a = 0; a < total; a += chunkFrames) chunks.push({ a, n: Math.min(chunkFrames, total - a) });

    const vNames: string[] = [];
    const aNames: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const { a, n } = chunks[i];
      const base = i / chunks.length;
      const span = 0.9 / chunks.length;
      if (o.hasVideo) {
        const ss = Math.max(0, (k0 + a - 0.5) / fps);
        const name = `v${i}.mkv`;
        await runFfmpeg(
          [
            "-hide_banner", "-y",
            "-ss", ss.toFixed(6), "-t", (n / fps).toFixed(6), "-i", o.input,
            "-an", "-sn",
            // Pad to EXACTLY n frames (clone the last one) before reversing: a stream shorter
            // than the span would otherwise put its missing frames FIRST in the reversed
            // file and shift every later frame against the mirrored audio.
            "-vf", `tpad=stop_mode=clone:stop=${n},trim=end_frame=${n},reverse,setpts=N/(${rate})/TB`,
            "-r", rate,
            ...(o.alpha
              ? ["-c:v", "ffv1", "-pix_fmt", "yuva420p"]
              : ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"]),
            "-progress", "pipe:1", "-nostats",
            name,
          ],
          { cwd: o.workDir, signal: o.signal, totalDuration: n / fps, onProgress: (f) => o.onProgress?.(base + span * f * (withAudio ? 0.8 : 1)) },
        );
        vNames.push(name);
      }
      if (withAudio) {
        const ss = Math.max(0, (k0 + a) / fps);
        const name = `a${i}.wav`;
        await runFfmpeg(
          [
            "-hide_banner", "-y",
            "-ss", ss.toFixed(6), "-t", (n / fps).toFixed(6), "-i", o.input,
            "-vn", "-sn",
            // Exactly n/fps seconds of samples (silence-pad a short stream) before reversing.
            "-af", `aresample=48000,apad,atrim=end_sample=${Math.round((n / fps) * 48000)},areverse`,
            "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le",
            name,
          ],
          { cwd: o.workDir, signal: o.signal },
        );
        aNames.push(name);
        o.onProgress?.(base + span);
      }
    }

    const args: string[] = ["-hide_banner", "-y"];
    let inputs = 0;
    if (o.hasVideo) {
      await writeFile(join(o.workDir, "v.txt"), [...vNames].reverse().map((n) => `file '${n}'`).join("\n") + "\n");
      args.push("-f", "concat", "-safe", "0", "-i", "v.txt");
      inputs++;
    }
    if (withAudio) {
      await writeFile(join(o.workDir, "a.txt"), [...aNames].reverse().map((n) => `file '${n}'`).join("\n") + "\n");
      args.push("-f", "concat", "-safe", "0", "-i", "a.txt");
      inputs++;
    }
    if (o.hasVideo) args.push("-map", "0:v:0", "-c:v", "copy");
    else args.push("-vn");
    if (withAudio) args.push("-map", `${inputs - 1}:a:0`, "-c:a", "aac", "-b:a", "192k");
    else args.push("-an");
    if (!o.alpha) args.push("-movflags", "+faststart");
    args.push("-progress", "pipe:1", "-nostats", o.outPath);
    await runFfmpeg(args, {
      cwd: o.workDir,
      signal: o.signal,
      totalDuration: o.spanSec,
      onProgress: (f) => o.onProgress?.(0.9 + f * 0.1),
    });
    return { frames: o.hasVideo ? total : 0 };
  } finally {
    await rm(o.workDir, { recursive: true, force: true });
  }
}

/** atempo filters (each stage is limited to 0.5..2.0 on FFmpeg 4.x) for a speed < 1. */
export function atempoChain(speed: number): string {
  const parts: string[] = [];
  let s = speed;
  while (s < 0.5 - 1e-9) {
    parts.push("atempo=0.5");
    s /= 0.5;
  }
  parts.push(`atempo=${s.toFixed(6)}`);
  return parts.join(",");
}

export interface SmoothSlowOptions {
  input: string;
  hasAudio: boolean;
  projectFps: number;
  /** Clip speed, < 1. */
  speed: number;
  mode: "blend" | "optical-flow";
  startSec: number;
  spanSec: number;
  /** Exact number of project-fps frames to write (= the clip's timeline footprint). */
  outFrames: number;
  /** Output path (.mp4; .mkv when `alpha`). */
  outPath: string;
  /**
   * Source has an alpha channel (a remove_background cutout): the bake is FFV1
   * yuva420p in Matroska and always blends (minterpolate has no alpha support).
   */
  alpha?: boolean;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/**
 * Bake a span slowed by `speed` WITH interpolated in-between frames, so it plays
 * at the project frame rate without stutter. The source is interpolated up to
 * projectFps / speed frames per source-second and those frames are then stamped
 * at the project rate; audio is slowed with a pitch-preserving atempo chain. The
 * output is exactly `outFrames` frames long.
 */
export async function bakeSmoothSlow(o: SmoothSlowOptions): Promise<void> {
  const pfps = rateExpr(o.projectFps);
  const target = o.projectFps / o.speed;
  const interp =
    o.mode === "optical-flow" && !o.alpha
      ? `minterpolate=fps=${target.toFixed(6)}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`
      : `framerate=fps=${target.toFixed(6)}`;
  const outDur = o.outFrames / o.projectFps;
  const tail = `setpts=N/(${pfps})/TB,fps=${pfps},tpad=stop_mode=clone:stop=4`;
  const args = ["-hide_banner", "-y", "-ss", o.startSec.toFixed(6), "-t", o.spanSec.toFixed(6), "-i", o.input];
  if (o.alpha) {
    // The interpolation filters drop the alpha plane: blend colour and alpha separately, then merge them back.
    args.push(
      "-filter_complex",
      `[0:v]format=yuva420p,split[c0][a0];[c0]format=yuv420p,${interp}[c1];[a0]alphaextract,${interp}[a1];[c1][a1]alphamerge,${tail},format=yuva420p[v]`,
      "-map", "[v]", "-frames:v", String(o.outFrames), "-c:v", "ffv1", "-pix_fmt", "yuva420p",
    );
    if (o.hasAudio) args.push("-map", "0:a:0");
  } else {
    args.push("-vf", `${interp},${tail}`, "-frames:v", String(o.outFrames), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p");
  }
  if (o.hasAudio) args.push("-af", atempoChain(o.speed), "-c:a", "aac", "-b:a", "192k");
  else args.push("-an");
  if (!o.alpha) args.push("-movflags", "+faststart");
  args.push("-t", outDur.toFixed(6), "-progress", "pipe:1", "-nostats", o.outPath);
  await runFfmpeg(args, { signal: o.signal, totalDuration: outDur, onProgress: o.onProgress });
}

/** Grab one frame as a lossless PNG. */
export async function grabFrame(input: string, atSec: number, outPath: string, signal?: AbortSignal): Promise<void> {
  await runFfmpeg(
    ["-hide_banner", "-y", "-ss", Math.max(0, atSec).toFixed(6), "-i", input, "-an", "-sn", "-frames:v", "1", "-c:v", "png", outPath],
    { signal },
  );
}
