import { join } from "node:path";
import {
  fitPictureRect,
  normalizeMask,
  sanitizeMask,
  isBlendMode,
  runBlendModes,
  type BlendMode,
  type ClipMask,
  type PictureRect,
} from "./effects/compositing.js";
import { previewCanvas } from "./ffmpeg/graph.js";
import { ensureMaskFile, maskFileName, type MaskRenderSpec } from "./ffmpeg/mask.js";
import type { Canvas, Clip, MediaAsset, Project, ResolvedRenderClip, Track } from "./types.js";

/**
 * Engine-side helpers for blend modes and shape masks (the engine methods stay
 * thin wrappers): edit validation for set_clip_blend_mode / set_clip_mask, and
 * the render-time staging that rasterizes each clip's mask at the render
 * canvas (ffmpeg/mask.ts) so graph.ts can multiply it into the clip's alpha.
 */

/** The render canvas size graph.ts uses (x264 needs even dimensions). */
export function renderDims(canvas: Canvas): { W: number; H: number } {
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  return { W: even(canvas.width), H: even(canvas.height) };
}

/** The (cropped) source size a clip's picture is fitted from, or null without a picture. */
function sourceSize(clip: Clip, asset: MediaAsset | undefined): { w: number; h: number } | null {
  if (!asset?.hasVideo || !(asset.width > 0) || !(asset.height > 0)) return null;
  const crop = clip.effects?.crop;
  if (crop && crop.width > 0 && crop.height > 0) return { w: Math.round(crop.width), h: Math.round(crop.height) };
  return { w: asset.width, h: asset.height };
}

/** The clip's picture rect in a W×H canvas (adjustment layers: the whole canvas). */
export function clipPictureRect(clip: Clip, asset: MediaAsset | undefined, W: number, H: number): PictureRect | null {
  if (clip.adjustment) return { x: 0, y: 0, w: W, h: H };
  const src = sourceSize(clip, asset);
  return src ? fitPictureRect(src.w, src.h, W, H) : null;
}

/** The raster spec of a clip's mask at `canvas`, or undefined without a (valid) mask or picture. */
export function clipMaskSpec(clip: Clip, asset: MediaAsset | undefined, canvas: Canvas): MaskRenderSpec | undefined {
  const mask = sanitizeMask(clip.effects?.mask);
  if (!mask) return undefined;
  const { W, H } = renderDims(canvas);
  const rect = clipPictureRect(clip, asset, W, H);
  if (!rect || rect.w <= 0 || rect.h <= 0) return undefined;
  return { mask, W, H, rect };
}

/**
 * Rasterize (or reuse) a clip's mask at the render canvas and return the PNG
 * path, or undefined when the clip has no (valid) mask or no picture.
 */
export async function stageClipMask(
  dataDir: string,
  clip: Clip,
  asset: MediaAsset | undefined,
  canvas: Canvas,
): Promise<string | undefined> {
  const spec = clipMaskSpec(clip, asset, canvas);
  return spec ? ensureMaskFile(join(dataDir, "masks"), spec) : undefined;
}

/**
 * File names of every mask PNG the given project states (live project plus
 * undo/redo snapshots) can ask for at their export or preview canvas.
 * Used by gc.ts to prune masks nothing references any more.
 */
export function referencedMaskNames(projects: Project[]): Set<string> {
  const names = new Set<string>();
  for (const project of projects) {
    // Each snapshot's OWN canvas (it may differ across undo steps): export size + preview size.
    const full: Canvas = { width: project.width, height: project.height, fps: project.fps };
    const canvases = [full, previewCanvas(full)];
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (!clip.effects?.mask) continue;
        for (const canvas of canvases) {
          const spec = clipMaskSpec(clip, assetOf(project, clip), canvas);
          if (spec) names.add(maskFileName(spec));
        }
      }
    }
  }
  return names;
}

/** A clip's stored blend mode if it is a real, non-normal mode. */
export function effectiveBlendMode(clip: Clip): BlendMode | undefined {
  const m = clip.effects?.blendMode;
  return isBlendMode(m) && m !== "normal" ? m : undefined;
}

/**
 * Give every member of a video transition run its run's EFFECTIVE blend mode
 * (the first clip's: graph.ts composites a run as one stream with it), so each
 * member's segment-cache key carries the mode it actually renders with. A
 * segment that only covers a follower then re-renders when the lead's mode
 * changes. Call on the finished stageRender list; groups exactly like graph.ts
 * (per track: video-visible picture clips, stable-sorted by start, joined on a
 * transition).
 */
export function applyRunBlendModes(clips: ResolvedRenderClip[]): void {
  const byTrack = new Map<number, ResolvedRenderClip[]>();
  for (const c of clips) {
    if (c.adjustment || c.sfx || !c.showVideo) continue;
    const list = byTrack.get(c.trackIndex) ?? [];
    list.push(c);
    byTrack.set(c.trackIndex, list);
  }
  for (const list of byTrack.values()) {
    list.sort((a, b) => a.startSec - b.startSec);
    const modes = runBlendModes(list);
    list.forEach((c, i) => {
      if (modes[i] !== "normal") c.effects = { ...(c.effects ?? {}), blendMode: modes[i] };
      else if (c.effects?.blendMode) c.effects = { ...c.effects, blendMode: undefined };
    });
  }
}

function locate(project: Project, clipId: string): { track: Track; clip: Clip } {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  throw new Error(`No clip with id "${clipId}"`);
}

const assetOf = (project: Project, clip: Clip): MediaAsset | undefined =>
  clip.assetId ? project.assets.find((a) => a.id === clip.assetId) : undefined;

/** Teaching error unless the clip has a picture on a video track. */
function requirePicture(project: Project, track: Track, clip: Clip, what: string): void {
  if (track.kind !== "video") {
    throw new Error(`Clip "${clip.id}" is on an AUDIO track — ${what} only applies to pictures on video tracks.`);
  }
  if (!clip.adjustment && !assetOf(project, clip)?.hasVideo) {
    throw new Error(`Clip "${clip.id}" has no picture (audio-only media) — ${what} only applies to video and image clips.`);
  }
}

/**
 * The clips a set_clip_blend_mode on `clipId` changes: the clip's whole
 * transition run on its track (clips joined by a transition render as ONE
 * stream, so they share one mode — graph.ts / compositing.ts runBlendModes).
 * Throws a teaching error for adjustment layers and clips without a picture.
 */
export function blendModeTargets(project: Project, clipId: string): Clip[] {
  const { track, clip } = locate(project, clipId);
  if (clip.adjustment) {
    throw new Error(
      `Clip "${clip.id}" is an ADJUSTMENT layer — blend modes apply to footage/image/overlay clips. To limit where an adjustment applies, give it a shape mask (set_clip_mask); to blend a look, put the footage itself on a higher track with set_clip_blend_mode.`,
    );
  }
  requirePicture(project, track, clip, "a blend mode");
  // The track's picture clips in start order, grouped like graph.ts groupRuns.
  const pics = track.clips
    .filter((c) => !c.adjustment && assetOf(project, c)?.hasVideo)
    .sort((a, b) => a.startFrame - b.startFrame);
  const runs: Clip[][] = [];
  for (const c of pics) {
    if (c.transition && runs.length) runs[runs.length - 1].push(c);
    else runs.push([c]);
  }
  return runs.find((r) => r.includes(clip)) ?? [clip];
}

/** Store a mode on a clip (normal = field removed, so the normal render path is untouched). */
export function writeBlendMode(clip: Clip, mode: BlendMode): void {
  if (mode === "normal") {
    if (clip.effects) {
      delete clip.effects.blendMode;
      if (Object.keys(clip.effects).length === 0) delete clip.effects;
    }
    return;
  }
  (clip.effects ??= {}).blendMode = mode;
}

/** set_clip_mask params (all optional; shape null = remove the mask). */
export interface MaskRequest {
  shape?: ClipMask["shape"] | null;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rotation?: number;
  feather?: number;
  roundness?: number;
  invert?: boolean;
}

/**
 * The mask a set_clip_mask request produces (undefined = remove), merged onto
 * the clip's current mask and clamped. Defaults size a new rect/ellipse as a
 * centred square/circle half the picture's short side (needs the picture's
 * aspect in the project canvas). Throws a teaching error for audio clips.
 */
export function nextClipMask(project: Project, clipId: string, req: MaskRequest): ClipMask | undefined {
  const { track, clip } = locate(project, clipId);
  requirePicture(project, track, clip, "a mask");
  if (req.shape === null) return undefined;
  const current = sanitizeMask(clip.effects?.mask);
  const rect = clipPictureRect(clip, assetOf(project, clip), project.width, project.height);
  const aspect = rect && rect.h > 0 ? rect.w / rect.h : undefined;
  const { shape, ...rest } = req;
  return normalizeMask({ ...rest, ...(shape ? { shape } : {}) }, current, aspect);
}

/** Store (or clear) a clip's mask. */
export function writeClipMask(clip: Clip, mask: ClipMask | undefined): void {
  if (!mask) {
    if (clip.effects) {
      delete clip.effects.mask;
      if (Object.keys(clip.effects).length === 0) delete clip.effects;
    }
    return;
  }
  (clip.effects ??= {}).mask = mask;
}
