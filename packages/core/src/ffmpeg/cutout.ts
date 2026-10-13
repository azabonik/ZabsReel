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

/**
 * Filter chain that merges a colour stream and its matte stream into one
 * yuva420p stream labelled `out` (labels are given with their brackets).
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
export function cutoutMergeFilter(colorLabel: string, matteLabel: string, out: string, m: Pick<CutoutMerge, "fps" | "width" | "height">): string {
  const tag = out.replace(/[[\]]/g, "");
  const half = (0.5 / (m.fps > 0 ? m.fps : 30)).toFixed(6);
  const frame = (1 / (m.fps > 0 ? m.fps : 30)).toFixed(6);
  return (
    `${colorLabel}scale=${m.width}:${m.height},format=yuva420p[${tag}c];` +
    `${matteLabel}format=gray,tpad=start=1:color=black,setpts=PTS-(${frame}+${half})/TB[${tag}m];` +
    `[${tag}c][${tag}m]alphamerge${out}`
  );
}
