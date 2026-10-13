import { basename } from "node:path";
import { runFfprobe } from "./executor.js";
import { newId } from "../ids.js";
import type { MediaAsset } from "../types.js";
import type { ProbedColor } from "./colorspace.js";

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
  tags?: { rotate?: string };
  color_space?: string;
  color_range?: string;
  color_primaries?: string;
  color_transfer?: string;
}

interface FfprobeFormat {
  duration?: string;
  format_name?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

/** ffprobe codec names for still-image formats (looped when placed on the timeline). */
const IMAGE_CODECS = new Set(["png", "mjpeg", "jpeg", "bmp", "webp", "gif", "tiff", "ppm", "pgm"]);
/** Default on-timeline length (seconds) given to a still image when imported. */
const DEFAULT_IMAGE_DURATION = 5;

/** Parse an ffmpeg rational like "30000/1001" into a float, or 0 on failure. */
function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split("/").map(Number);
  if (!den || !Number.isFinite(num) || !Number.isFinite(den)) return Number(rate) || 0;
  return num / den;
}

/**
 * Rotation (degrees) a player must apply to display the stream, from the
 * Display Matrix side data (phone/WhatsApp portrait video) or the legacy
 * `rotate` tag. FFmpeg auto-rotates on decode, so every downstream frame is
 * already upright — the probe must report DISPLAY dimensions to match.
 */
function streamRotation(video: FfprobeStream): number {
  const sd = video.side_data_list?.find((s) => typeof s.rotation === "number");
  const raw = sd?.rotation ?? Number(video.tags?.rotate ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return ((Math.round(raw) % 360) + 360) % 360;
}

/** The stream's colour description (values ffprobe knows) + its coded height, for colorspace.ts. */
export function probedColor(video: FfprobeStream): ProbedColor {
  const keep = (v: string | undefined) => (v && v !== "unknown" ? v : undefined);
  const c: ProbedColor = {
    space: keep(video.color_space),
    range: keep(video.color_range),
    primaries: keep(video.color_primaries),
    transfer: keep(video.color_transfer),
    codedHeight: video.height,
  };
  for (const k of Object.keys(c) as (keyof ProbedColor)[]) if (c[k] === undefined) delete c[k];
  return c;
}

/**
 * Probe a media file and build a MediaAsset. Throws if the file has no
 * decodable video or audio stream.
 */
export async function probeAsset(path: string): Promise<MediaAsset> {
  const stdout = await runFfprobe([
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    path,
  ]);

  let data: FfprobeOutput;
  try {
    data = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new Error(`Could not parse ffprobe output for ${path}`);
  }

  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");

  if (!video && !audio) {
    throw new Error(`No video or audio streams found in ${path}`);
  }

  const formatDuration = data.format?.duration ? Number(data.format.duration) : 0;
  const streamDuration = video?.duration ? Number(video.duration) : audio?.duration ? Number(audio.duration) : 0;
  let duration = formatDuration || streamDuration || 0;

  // A still image (png/jpg/webp/…) has a video stream but no real duration. Treat
  // it as a looping source with a sensible default length so it can be placed on
  // the timeline and trimmed/extended like any clip (the graph loops the frame).
  // FFmpeg's image2 demuxer (a .jpg/.bmp/.tif file) reports one frame's duration
  // (0.04 s) where png_pipe & co report none: a single-image container is a still either way.
  const stillContainer = /(^|,)(image2|[a-z0-9]+_pipe)(,|$)/.test(data.format?.format_name ?? "");
  const isImage = Boolean(video && !audio) && IMAGE_CODECS.has(video!.codec_name ?? "") &&
    (!Number.isFinite(duration) || duration <= 0 || stillContainer);
  if (isImage) duration = DEFAULT_IMAGE_DURATION;

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine a valid duration for ${path}`);
  }

  const fps = video ? parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || 30 : 30;

  // Portrait phone footage stores landscape pixels + a rotation side data entry.
  // Decoders auto-rotate, so swap to display dimensions for 90°/270° streams.
  const rotation = video ? streamRotation(video) : 0;
  const swapDims = rotation === 90 || rotation === 270;
  const displayWidth = swapDims ? video?.height ?? 0 : video?.width ?? 0;
  const displayHeight = swapDims ? video?.width ?? 0 : video?.height ?? 0;

  return {
    id: newId("asset"),
    path,
    name: basename(path),
    duration,
    width: displayWidth,
    height: displayHeight,
    fps: isImage ? 30 : Math.round(fps * 1000) / 1000,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    isImage: isImage || undefined,
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    ...(video ? { color: probedColor(video) } : {}),
    addedAt: Date.now(),
  };
}
