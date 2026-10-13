/**
 * MATTE-BACKED CUTOUTS (remove_background). The baked file of a cutout holds
 * only the person's MATTE — lossless FFV1 gray, one frame per frame of the
 * cutout's span — plus the span's audio. The colour is the ORIGINAL footage,
 * read again and alphamerged wherever the cutout's pixels are needed (export
 * and preview renders, the preview proxy, freeze frame, reverse, smooth slow
 * motion, thumbnails). Older cutouts are colour+alpha FFV1 yuva420p files with
 * no `cutout` record and keep rendering as ordinary alpha video.
 *
 * Pure filter/argument builders (no process spawning): graph.ts imports this,
 * and graph.ts is shared with the renderer's tests.
 */

import { colorTagArgs, keepCodingOpts, SWS_RESIZE, tagFramesStep, type SourceColor } from "./colorspace.js";

/** Where a matte-backed cutout's colour comes from (MediaAsset.cutout). */
export interface CutoutColor {
  /** The original footage (absolute path). */
  colorPath: string;
  /** Source seconds (as `-ss` counts them) of the colour frame that matte frame 0 belongs to. */
  colorStart: number;
}

/** What a render / bake needs to merge a cutout: colour source, matte frame rate and size. */
export interface CutoutMerge {
  colorPath: string;
  colorStart: number;
  /** Frame rate of the matte (the cutout asset's fps). */
  fps: number;
  /** Matte (= cutout) size; the colour is scaled to it when the source size was odd. */
  width: number;
  height: number;
  /** The colour source's range as the export reads it (SourceColor.range): the merge keeps the YUV in it. */
  range: "tv" | "pc";
}

/**
 * Seek the colour this much BEFORE the exact time: `-ss` keeps frames at or
 * after the time, and a time printed with 6 decimals can land a hair after a
 * frame's own timestamp (NTSC rates), which would skip it.
 */
const SEEK_EPSILON = 1e-4;

/** Input args for the colour of a cutout from cutout-asset second `sec` (optionally `span` seconds long). */
export function cutoutColorInputArgs(c: Pick<CutoutMerge, "colorPath" | "colorStart">, sec: number, span?: number): string[] {
  const ss = Math.max(0, c.colorStart + sec - SEEK_EPSILON);
  return ["-ss", ss.toFixed(6), ...(span !== undefined ? ["-t", span.toFixed(6)] : []), "-i", c.colorPath];
}

/** `v` when it is a finite number, else `fallback`. */
function finiteOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Filter chain that merges a colour stream and its matte stream into one
 * yuva420p stream labelled `out` (labels are given with their brackets).
 *
 * The colour's YUV goes through unchanged (a 4:2:0 8-bit source bit for bit;
 * only an odd-size source is resized, by one pixel): the reads after the
 * merge take it with the colour source's own matrix and range, as they read
 * the clip without its background removed. The range is explicit both ways —
 * left to itself, FFmpeg 4.4's swscale squeezes full range (yuvj420p, or
 * tagged pc) into limited on the way to yuva420p, which the full-range read
 * then washes out (20 levels); FFmpeg 7+ keeps it.
 *
 * Pairing is by TIME with half a frame of tolerance: the matte is moved half a
 * frame earlier, so each colour frame takes the matte frame that belongs to it
 * even though Matroska stores the matte's timestamps in whole milliseconds.
 * The merged stream keeps the COLOUR's own timestamps, so speed changes pick
 * exactly the frames the clip showed before its background was removed. A
 * colour frame that has no matte yet (it would only happen if the two seeks
 * disagreed) gets alpha 0 from the extra transparent matte frame in front,
 * never an opaque background.
 */
export function cutoutMergeFilter(colorLabel: string, matteLabel: string, out: string, m: Pick<CutoutMerge, "fps" | "width" | "height" | "range">): string {
  const tag = out.replace(/[[\]]/g, "");
  // Asset numbers from a loaded project: never text in the graph (safepath.ts coerces them on load too).
  m = { ...m, width: finiteOr(m.width, 0), height: finiteOr(m.height, 0), fps: finiteOr(m.fps, 0) };
  const half = (0.5 / (m.fps > 0 ? m.fps : 30)).toFixed(6);
  const frame = (1 / (m.fps > 0 ? m.fps : 30)).toFixed(6);
  return (
    `${colorLabel}scale=${m.width}:${m.height}:flags=${SWS_RESIZE}:in_range=${m.range}:out_range=${m.range},format=yuva420p[${tag}c];` +
    `${matteLabel}format=gray,tpad=start=1:color=black,setpts=PTS-(${frame}+${half})/TB[${tag}m];` +
    `[${tag}c][${tag}m]alphamerge${out}`
  );
}

/** What {@link alphaProxyArgs} encodes: video with transparency, or a matte-backed cutout (`merge`). */
export interface AlphaProxySource {
  /** The asset's file (a cutout's: its matte, with the span's audio). */
  path: string;
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
  /** How the export reads the picture's YUV (a cutout's: its colour source's). */
  color: SourceColor;
  merge?: CutoutMerge;
}

/**
 * ffmpeg arguments of a browser-playable VP8+alpha .webm preview of `a`, its
 * long edge at most `longEdge`, WITH audio (preview sound comes from the same
 * element). The YUV keeps the matrix the export reads the picture with,
 * limited range, and says so in complete tags — frames and stream (Chromium
 * ignores a partial set) — so the preview's decoder reads the proxy as the
 * export reads the source, as the H.264 proxies (engine generateProxy).
 * Untagged, the proxy fell under the size guess: a cutout of BT.601-tagged HD
 * or BT.709-tagged SD footage showed other colours than its export.
 * Constrained quality (CRF 12, at most 2 Mb/s for the colour) measured ~40%
 * smaller than the fixed 3 Mb/s used before at about the same speed (colour
 * ~46 dB, alpha ~51 dB PSNR). VP9 was ~60% smaller but encoded ~5x slower,
 * which would add half the matting time again to every remove_background.
 */
export function alphaProxyArgs(a: AlphaProxySource, outPath: string, longEdge: number): string[] {
  const size = Math.max(a.width, a.height) > longEdge ? (a.width >= a.height ? `${longEdge}:-2` : `-2:${longEdge}`) : "iw:ih";
  const coded = { matrix: a.color.matrix, range: "tv" } as const;
  const vf = `scale=${size}${keepCodingOpts(a.color)},format=yuva420p,${tagFramesStep(coded)}`;
  const args = ["-hide_banner", "-y", "-i", a.path];
  if (a.merge) {
    args.push(...cutoutColorInputArgs(a.merge, 0, a.duration));
    args.push("-filter_complex", `${cutoutMergeFilter("[1:v]", "[0:v]", "[m]", a.merge)};[m]${vf}[v]`, "-map", "[v]");
    if (a.hasAudio) args.push("-map", "0:a:0");
  } else {
    args.push("-vf", vf);
  }
  args.push("-c:v", "libvpx", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-crf", "12", "-b:v", "2M", "-deadline", "realtime", "-cpu-used", "5", ...colorTagArgs(coded));
  if (a.hasAudio) args.push("-c:a", "libopus", "-b:a", "128k", "-ar", "48000");
  else args.push("-an");
  args.push("-progress", "pipe:1", "-nostats", outPath);
  return args;
}
