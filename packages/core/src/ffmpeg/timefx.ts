import { mkdir, rm, writeFile } from "../io/gatedfs.js";
import { join } from "node:path";
import { runFfmpeg, runFfprobe } from "./executor.js";
import type { FrameClock } from "../speed.js";
import { colorTagArgs, inputColorOpts, keepCodingOpts, SWS_CONVERT, tagFramesStep, type SourceColor } from "./colorspace.js";
import { cutoutColorInputArgs, cutoutMergeFilter, type CutoutMerge } from "./cutout.js";

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
  /** True only when ffprobe reported a known alpha-free pixel format (isAlphaFreePixFmt). */
  opaque?: boolean;
}

/**
 * Pixel formats known to carry no alpha: planar/semi-planar/packed YUV without an
 * A plane, gray, RGB/BGR/GBR without A, and the padded (X/0) layouts. An allowlist,
 * unlike hasAlpha's list of alpha formats: a format missing here (pal8, uyva, vuya,
 * ayuv*, yaf*, bayer, one a later FFmpeg adds) is never taken for opaque.
 */
const ALPHA_FREE_PIX_FMT =
  /^(yuvj?\d|nv\d|p\d{3}|gray|mono[wb]$|(rgb|bgr)(24|48|565|555|444|8|4|f16|f32|96)|(0rgb|rgb0|0bgr|bgr0)$|gbrp|x2(rgb|bgr)10|y2\d\d|xv\d\d|v30x|vuyx|vyu444|uyvy422|yuyv422|yvyu422|uyyvyy411|xyz12)/;

/** True when an ffmpeg pix_fmt name is a known alpha-free format (ALPHA_FREE_PIX_FMT). */
export function isAlphaFreePixFmt(pixFmt: string): boolean {
  return ALPHA_FREE_PIX_FMT.test(pixFmt);
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
    const hasAlpha = /^(yuva|gbrap|rgba|bgra|argb|abgr|ya\d)/.test(pixFmt);
    return { width: st.width ?? 0, height: st.height ?? 0, pixFmt, hasAlpha, opaque: !!st.pix_fmt && isAlphaFreePixFmt(st.pix_fmt) };
  } catch {
    return undefined;
  }
}

/**
 * The first video stream's timebase and frame rate (speed.ts FrameClock), so a
 * constant-speed freeze_frame can model FFmpeg's integer timestamps exactly.
 */
export async function probeFrameClock(file: string): Promise<FrameClock | undefined> {
  try {
    const out = await runFfprobe(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=time_base,r_frame_rate", "-of", "json", file]);
    const st = (JSON.parse(out) as { streams?: { time_base?: string; r_frame_rate?: string }[] }).streams?.[0];
    const ratio = (r?: string) => (r ?? "").split("/").map(Number);
    const [tbNum, tbDen] = ratio(st?.time_base);
    const [rateNum, rateDen] = ratio(st?.r_frame_rate);
    if (![tbNum, tbDen, rateNum, rateDen].every((n) => Number.isInteger(n) && n > 0)) return undefined;
    return { tbNum, tbDen, rateNum, rateDen };
  } catch {
    return undefined;
  }
}

/**
 * The steps that end a bake's video: the source's YUV kept as the export reads
 * it (`color`, colorspace.ts), limited range in `pixFmt`, frames tagged
 * completely. Untagged, an HD bake would be read by its size (BT.709) —
 * unlike its source when that is read as BT.601 (tagged so, or untagged VP9).
 */
function keepColorSteps(color: SourceColor, pixFmt: string): string {
  return `scale=iw:ih${keepCodingOpts(color)},format=${pixFmt},${tagFramesStep({ matrix: color.matrix, range: "tv" })}`;
}

/** Encoder options that tag a bake as {@link keepColorSteps} codes it. */
function keepColorArgs(color: SourceColor): string[] {
  return colorTagArgs({ matrix: color.matrix, range: "tv" });
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
  /** How the export reads the source's YUV: the bake keeps it, tagged so (colorspace.ts). */
  color: SourceColor;
  /** Source size / pixel format, used to size chunks by a RAM budget. */
  format?: Pick<VideoFormat, "width" | "height" | "pixFmt">;
  /** `input` is a matte-backed cutout's matte: merge it with this colour first (requires `alpha`). */
  cutout?: CutoutMerge;
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
        // Pad to EXACTLY n frames (clone the last one) before reversing: a stream shorter
        // than the span would otherwise put its missing frames FIRST in the reversed
        // file and shift every later frame against the mirrored audio.
        const vf = `tpad=stop_mode=clone:stop=${n},trim=end_frame=${n},reverse,setpts=N/(${rate})/TB,${keepColorSteps(o.color, o.alpha ? "yuva420p" : "yuv420p")}`;
        await runFfmpeg(
          [
            "-hide_banner", "-y",
            "-ss", ss.toFixed(6), "-t", (n / fps).toFixed(6), "-i", o.input,
            ...(o.cutout
              ? [...cutoutColorInputArgs(o.cutout, ss, n / fps), "-filter_complex", `${cutoutMergeFilter("[1:v]", "[0:v]", "[m]", o.cutout)};[m]${vf}[v]`, "-map", "[v]"]
              : []),
            "-an", "-sn",
            ...(o.cutout ? [] : ["-vf", vf]),
            "-r", rate,
            ...(o.alpha
              ? ["-c:v", "ffv1", "-pix_fmt", "yuva420p"]
              : ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"]),
            ...keepColorArgs(o.color),
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

/** Source frames the interpolators are given past a smooth-slow span (and cloned after the input). */
const INTERP_LOOKAHEAD_FRAMES = 4;

/** "a/b" or a plain decimal as an exact integer ratio [num, den]. */
function ratio(r: string): [number, number] {
  const [a, b] = r.split("/");
  if (b !== undefined) return [Number(a), Number(b)];
  const [i, f = ""] = a.split(".");
  const den = 10 ** f.length;
  const num = Number(i + f);
  const g = (x: number, y: number): number => (y ? g(y, x % y) : x);
  const d = g(num, den) || 1;
  return [num / d, den / d];
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
  /** The source's frame rate (default: the project's). */
  sourceFps?: number;
  /** Seconds of the source that exist after the span (its duration − span end; default 0 = the span ends the file). */
  availableAfterSec?: number;
  /** Output path (.mp4; .mkv when `alpha`). */
  outPath: string;
  /**
   * Source has an alpha channel (a remove_background cutout): the bake is FFV1
   * yuva420p in Matroska and always blends (minterpolate has no alpha support).
   */
  alpha?: boolean;
  /** How the export reads the source's YUV: the bake keeps it, tagged so (colorspace.ts). */
  color: SourceColor;
  /** `input` is a matte-backed cutout's matte: merge it with this colour first (requires `alpha`). */
  cutout?: CutoutMerge;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/**
 * Bake a span slowed by `speed` WITH interpolated in-between frames, so it plays
 * at the project frame rate without stutter. The source is interpolated up to
 * projectFps / speed frames per source-second and those frames are then stamped
 * at the project rate; audio is slowed with a pitch-preserving atempo chain. The
 * output is exactly `outFrames` frames long, every one of them new: the last
 * output frames sit between the span's last source frame and the one after it,
 * so the interpolator is given a few source frames past the span (when the file
 * has them). A span that ends the file has no frame after it: its frames are
 * spread so the last output frame lands on the last source frame instead
 * (motion up to (1 / speed − 1) output frames slower at the very end — 1 frame
 * at 0.5x, 3 at 0.25x — rather than a held frame).
 */
export async function bakeSmoothSlow(o: SmoothSlowOptions): Promise<void> {
  const pfps = rateExpr(o.projectFps);
  const srcFps = o.sourceFps && o.sourceFps > 0 ? o.sourceFps : o.projectFps;
  // Source frames past the span the interpolators need to reach the span's end (minterpolate stops a few
  // frames before the end of its input, framerate one frame).
  const extraSec = Math.min(Math.max(0, o.availableAfterSec ?? 0), INTERP_LOOKAHEAD_FRAMES / srcFps);
  const atEnd = extraSec < (INTERP_LOOKAHEAD_FRAMES - 0.5) / srcFps;
  const spanFrames = Math.max(2, Math.round(o.spanSec * srcFps));
  // The interpolation rate as an exact ratio (framerate fails on a long decimal): the project rate slowed by
  // `speed`, or — for a span that ends the file — the rate that puts its last source frame on the last output frame.
  const [sN, sD] = ratio(rateExpr(srcFps));
  const [pN, pD] = ratio(pfps);
  const [vN, vD] = ratio(String(o.speed));
  const target = atEnd ? `${(Math.max(2, o.outFrames) - 1) * sN}/${(spanFrames - 1) * sD}` : `${pN * vD}/${pD * vN}`;
  // Cloned frames after the input let the interpolators run up to its real last frame (they come after the
  // frames written; the trim at the end of the chain cuts them).
  const interp = `tpad=stop_mode=clone:stop=${INTERP_LOOKAHEAD_FRAMES},${
    o.mode === "optical-flow" && !o.alpha
      ? `minterpolate=fps=${target}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`
      : `framerate=fps=${target}`
  }`;
  const outDur = o.outFrames / o.projectFps;
  // Pin the count: setpts stamps every interpolated frame at the project rate; a clone pad only guards a short
  // read and is cut off by the trim. The cap is in the graph, not -frames:v: on FFmpeg 4.4, -frames:v ends
  // every stream of the output when the video count is reached, which cut the audio short (19.78 s of a
  // 20 s bake, 19.94 s on 8.1).
  const tail = `setpts=N/(${pfps})/TB,fps=${pfps},tpad=stop_mode=clone:stop=4`;
  const cap = `trim=end_frame=${o.outFrames}`;
  const readSec = o.spanSec + (atEnd ? 0 : extraSec);
  const args = ["-hide_banner", "-y", "-ss", o.startSec.toFixed(6), "-t", readSec.toFixed(6), "-i", o.input];
  if (o.cutout) args.push(...cutoutColorInputArgs(o.cutout, o.startSec, readSec));
  if (o.alpha) {
    // The interpolation filters drop the alpha plane: blend colour and alpha separately, then merge them back.
    args.push(
      "-filter_complex",
      `${o.cutout ? `${cutoutMergeFilter("[1:v]", "[0:v]", "[m]", o.cutout)};[m]` : "[0:v]"}format=yuva420p,split[c0][a0];[c0]format=yuv420p,${interp}[c1];[a0]alphaextract,${interp}[a1];[c1][a1]alphamerge,${tail},${keepColorSteps(o.color, "yuva420p")},${cap}[v]`,
      "-map", "[v]", "-c:v", "ffv1", "-pix_fmt", "yuva420p", ...keepColorArgs(o.color),
    );
    if (o.hasAudio) args.push("-map", "0:a:0");
  } else {
    args.push(
      "-vf", `${interp},${tail},${keepColorSteps(o.color, "yuv420p")},${cap}`,
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", ...keepColorArgs(o.color),
    );
  }
  if (o.hasAudio) args.push("-af", `atrim=0:${o.spanSec.toFixed(6)},${atempoChain(o.speed)}`, "-c:a", "aac", "-b:a", "192k");
  else args.push("-an");
  if (!o.alpha) args.push("-movflags", "+faststart");
  args.push("-t", outDur.toFixed(6), "-progress", "pipe:1", "-nostats", o.outPath);
  await runFfmpeg(args, { signal: o.signal, totalDuration: outDur, onProgress: o.onProgress });
}

/**
 * Grab one frame as a lossless PNG. `color`: read the YUV as the export reads
 * the clip (colorspace.ts), so the still matches the clip around it. A
 * matte-backed cutout's `input` is its matte: pass `cutout` to merge its colour.
 */
export async function grabFrame(input: string, atSec: number, outPath: string, signal?: AbortSignal, color?: SourceColor, cutout?: CutoutMerge): Promise<void> {
  const ss = Math.max(0, atSec);
  const read = color ? `scale=flags=${SWS_CONVERT}${inputColorOpts(color)},format=pix_fmts=rgb24|rgba` : "";
  const pic = cutout
    ? [...cutoutColorInputArgs(cutout, ss), "-filter_complex", `${cutoutMergeFilter("[1:v]", "[0:v]", read ? "[m]" : "[v]", cutout)}${read ? `;[m]${read}[v]` : ""}`, "-map", "[v]"]
    : read ? ["-vf", read] : [];
  await runFfmpeg(
    ["-hide_banner", "-y", "-ss", ss.toFixed(6), "-i", input, ...pic, "-an", "-sn", "-frames:v", "1", "-c:v", "png", outPath],
    { signal },
  );
}
