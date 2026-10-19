import { basename } from "node:path";
import { NOT_MEDIA_TEXT, NotMediaError, runFfprobe } from "./executor.js";
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
  disposition?: { attached_pic?: number };
  color_space?: string;
  color_range?: string;
  color_primaries?: string;
  color_transfer?: string;
}

interface FfprobeFormat {
  duration?: string;
  start_time?: string;
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
/** The end-of-file read starts this many seconds before the recorded end (FFmpeg seeks back to a keyframe from there). */
const TAIL_SECONDS = 1;
/** The most video packets the end-of-file read takes: a file with no keyframe near its end is not read to the end. */
const TAIL_PACKETS = 2000;
/** The least a video's end must pass the recorded duration by to count, whatever its frame rate claims. */
const MIN_TAIL = 0.001;

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
 * Where the first video stream's last picture ends, in seconds from the file's
 * start, or 0 when it can't be read. Some files record a shorter length than
 * their pictures run (an MP4 whose track says 3.5 s while its last picture
 * ends at 3.833 s): from FFmpeg 6.1 the format duration is that recorded
 * length, so the pictures after it could not be reached. Only the end of the
 * file is read: the packets from a keyframe before `duration - TAIL_SECONDS`,
 * at most {@link TAIL_PACKETS} of them, timestamps only (no decode).
 * Packet times count from the stream's own zero, so the file's start time
 * (an MPEG-TS often starts at 1.4 s) is taken off.
 */
async function videoEnd(path: string, start: number, duration: number): Promise<number> {
  try {
    const from = Math.max(0, start + duration - TAIL_SECONDS);
    const out = JSON.parse(
      await runFfprobe([
        "-v", "error", "-select_streams", "v:0",
        "-read_intervals", `${from.toFixed(6)}%+#${TAIL_PACKETS}`,
        "-show_entries", "packet=pts_time,duration_time", "-of", "json", path,
      ]),
    ) as { packets?: { pts_time?: string; duration_time?: string }[] };
    let end = 0;
    for (const p of out.packets ?? []) {
      const pts = Number(p.pts_time);
      if (p.pts_time === undefined || !Number.isFinite(pts)) continue;
      const d = Number(p.duration_time);
      end = Math.max(end, pts + (Number.isFinite(d) && d > 0 ? d : 0) - start);
    }
    return Math.round(end * 1e6) / 1e6; // ffprobe prints microseconds
  } catch {
    return 0;
  }
}

/**
 * Probe a media file and build a MediaAsset. Throws if the file has no
 * decodable video or audio stream, and a {@link NotMediaError} naming the file
 * when FFmpeg refuses its format (a playlist, manifest or list file). A
 * video's duration is the later of the recorded one and where its last
 * picture ends ({@link videoEnd}).
 */
export async function probeAsset(path: string): Promise<MediaAsset> {
  let stdout: string;
  try {
    // -v error, not quiet: a format refusal must reach stderr (executor.ts notMediaFrom).
    stdout = await runFfprobe(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
  } catch (err) {
    if (err instanceof NotMediaError) throw new NotMediaError(`Can't import "${basename(path)}": ${NOT_MEDIA_TEXT}`, err.command, err.stderr);
    throw err;
  }

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

  // A video's pictures may run past the recorded length (videoEnd): then its end, never a shorter duration. Not for
  // a still or an audio file's cover art (one picture, no end of its own). Less than a frame past it is the
  // container's rounding (an audio codec's delay; a WebM with Opus records 4.008 s for 4.014 s), not a picture
  // the frame count misses, so the duration stays as it was.
  if (video && !isImage && video.disposition?.attached_pic !== 1) {
    const start = Number(data.format?.start_time);
    const end = await videoEnd(path, Number.isFinite(start) ? start : 0, duration);
    if (end - duration >= Math.max(MIN_TAIL, 1 / fps)) duration = end;
  }

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
