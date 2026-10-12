// The compositor's "brain": a PURE function from (project, playhead) to a draw
// plan. No DOM, no <video> — just which clips are visible/audible right now,
// in what z-order, at what source time, and with what opacity / crop / color.
// preview.tsx turns this plan into pixels (Canvas2D) and audio (a <video> pool);
// this module is unit-testable in plain Node (see scripts/smoke-composite.ts).
//
// Everything here mirrors the FFmpeg compositor in packages/core ffmpeg/graph.ts
// "within reason": higher video Track.index composites on top, clips sit at
// absolute positions (gaps draw nothing, overlaps with a transition cross-fade),
// fades ramp alpha, crop selects a source region, color is a CSS-filter proxy,
// keys run as a WebGL pass (keying.ts plans it, glkey.ts draws it).

import type { CropRect, MediaAsset, Project, TextOverlay, TextStyle } from "./types";
import { clipDurationFrames } from "./types";
import {
  buildSegments, colorFilter, fadeOpacity, rateAt, sourceTimeFor, vignetteAngles, type Segment,
} from "./playback";
import { muteGainAt } from "./mutes";
import { bleepMuteSpans, expandBleeps, type BleepLayer } from "./bleeps";
import { effectiveTransform, effectiveValue, sampleTrack, type EffectiveTransform } from "./keyframes";
import { previewScaleFor } from "@aive/core/effects";
import { keyPlan, type KeyPlan } from "./keying";
import { runBlendModes, sanitizeMask, type BlendMode, type ClipMask } from "@aive/core/compositing";
import { audioFxField } from "./audiofx";
import type { AudioPreviewPlan } from "@aive/core/audio-effects";

/** A text overlay plus its sampled animation (position/opacity) at the current frame. */
export type RenderOverlay = TextOverlay & { anim?: { x?: number; y?: number; opacity?: number } };

/** A motion graphic active this frame: its browser-playable proxy + the source
 *  time to show and its opacity. Drawn full-frame over its clip (alpha preserved). */
export interface RenderGraphic {
  /** Stable key for the decoder pool (the graphic overlay id). */
  key: string;
  /** Path to the browser-playable alpha .webm proxy. */
  path: string;
  /** Source time (seconds) into the graphic clip. */
  srcTime: number;
  opacity: number;
}

/**
 * Total timeline length in seconds: the furthest clip end across EVERY track
 * (video + audio), honoring positive audio slips. Music loops and never extends
 * the timeline. This is the master-clock end stop for playback.
 */
export function timelineDurationSec(project: Project | null): number {
  if (!project) return 0;
  const fps = project.fps;
  let endFrames = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const end = clip.startFrame + clipDurationFrames(clip, fps);
      endFrames = Math.max(endFrames, end);
      const slip = clip.audioOffsetFrames && clip.audioOffsetFrames > 0 ? clip.audioOffsetFrames : 0;
      if (slip) endFrames = Math.max(endFrames, end + slip);
    }
  }
  return endFrames / fps;
}

/** A clip that is live at the current playhead — drawable and/or audible. */
export interface ActiveClip {
  clipId: string;
  trackIndex: number;
  trackKind: "video" | "audio";
  /** Source asset display name (for the preview badge). */
  assetName?: string;
  path?: string;
  /** True if the source is a still image (drawn from an <img>, not the video pool). */
  isImage?: boolean;
  /** Source time (seconds) to show / hear. */
  srcTime: number;
  /** Playback rate = clip speed (a speed ramp's speed at `srcTime`, re-sampled every frame). */
  rate: number;
  /**
   * The clip plays a speed ramp: its rate changes continuously, so the decoder
   * follows it with a soft rate correction instead of only seeking (mediapool.ts).
   */
  ramped?: boolean;
  /** Combined fade + transition gain in [0,1], shared by alpha and volume. */
  gain: number;
  /** Present when this clip should be DRAWN (video track + asset has video). */
  draw?: {
    /** Final alpha = fade/transition gain × animated transform opacity. */
    opacity: number;
    crop?: CropRect;
    /** CSS filter string (color proxy), or "none". */
    colorFilter: string;
    /** Intrinsic source dimensions, for letterbox-contain fit. */
    assetWidth: number;
    assetHeight: number;
    /** Effective 2D transform at this frame (geometry only; opacity is in `opacity`). */
    transform: EffectiveTransform;
    /** Live key pass (colorkey/chromakey/lumakey) for the WebGL preview — see glkey.ts. */
    key?: KeyPlan;
    /**
     * Enabled vignettes' lens angles (radians) for the canvas vignette pass;
     * absent when none. These are ALL of them, for an unkeyed draw; a live key
     * splits them around the first key (`key.preVignette` / `key.postVignette`).
     */
    vignette?: number[];
    /**
     * Blend mode the layer composites with (absent = normal). A transition run
     * uses its FIRST clip's mode, as the export (compositing.ts runBlendModes).
     */
    blend?: BlendMode;
    /** Shape mask in the clip's own picture space (maskdraw.ts draws it). */
    mask?: ClipMask;
  };
  /**
   * Present when this clip should be HEARD (asset has audio + track not muted).
   * `fx` = its audio effects' Web Audio plan (audiograph.ts plays it).
   */
  audio?: { volume: number; fx?: AudioPreviewPlan };
  /** Text overlays active at this instant (drawable clips only), with sampled animation. */
  overlays: RenderOverlay[];
  /** Motion graphics active at this instant (drawable clips only) — drawn over the clip. */
  graphics: RenderGraphic[];
  /** Active caption cue at this instant (drawable clips only). */
  caption?: { text: string; style?: TextStyle };
  /**
   * Bleep sound effect layer (expanded from its parent clip's bleeps): play from
   * `srcTime` at rate 1 — the SFX keeps its pitch whatever the clip speed.
   * `preroll` = starts within the next moment: bind + park the decoder at 0 but
   * keep it paused, so the sound starts on time.
   */
  bleep?: { parentClipId: string; bleepId: string; preroll?: boolean };
  /**
   * Present for an ADJUSTMENT layer active at this instant: its CSS color-proxy
   * filter, to be applied to the composite of every layer below (the renderer
   * draws lower layers to an offscreen canvas, then draws that through
   * ctx.filter). Mirrors the FFmpeg bake in graph.ts (split→filter→overlay).
   */
  adjust?: { colorFilter: string; vignette?: number[]; mask?: ClipMask };
}

/** The full set of layers to render for one frame, drawables in bottom→top order. */
export interface FramePlan {
  clips: ActiveClip[];
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** `{ vignette: angles }` when the clip has an enabled vignette, else nothing (keeps plans lean). */
function vignetteField(filters: Parameters<typeof vignetteAngles>[0]): { vignette?: number[] } {
  const angles = vignetteAngles(filters);
  return angles.length ? { vignette: angles } : {};
}

/** `{ mask }` for a valid stored mask, else nothing. */
function maskField(m: unknown): { mask?: ClipMask } {
  const mask = sanitizeMask(m);
  return mask ? { mask } : {};
}

/** `{ blend }` for a non-normal mode, else nothing (normal plans stay as before). */
function blendField(mode: BlendMode | undefined): { blend?: BlendMode } {
  return mode && mode !== "normal" ? { blend: mode } : {};
}

/**
 * Each picture clip's effective blend mode on one video track: transition-
 * joined clips share their run's FIRST clip's mode, like the export's runs.
 */
function trackBlendModes(sorted: Project["tracks"][number]["clips"], assetById: Map<string, MediaAsset>): Map<string, BlendMode> {
  const pics = sorted.filter((c) => !c.adjustment && !!(c.assetId && assetById.get(c.assetId)?.hasVideo));
  const modes = runBlendModes(pics);
  return new Map(pics.map((c, i) => [c.id, modes[i]]));
}

/**
 * Per-track gain for an active segment at time `t`: its own fade ramp, optionally
 * multiplied by a cross-fade with a transition-overlapping neighbour on the same
 * track. `active` is every segment of the track live at `t` (1, or 2 during an
 * overlap). This is the preview proxy for FFmpeg xfade/acrossfade — non-dissolve
 * transition types still preview as a dissolve; the FFmpeg render is the truth.
 */
function segmentGain(seg: Segment, active: Segment[], t: number): number {
  let gain = fadeOpacity(seg, t);

  // Incoming side: this segment carries a transition and overlaps an earlier one.
  if (seg.clip.transition) {
    const prev = active.find((p) => p !== seg && p.start < seg.start && p.end > seg.start);
    if (prev) {
      const ovEnd = Math.min(prev.end, seg.end);
      if (t < ovEnd && ovEnd > seg.start) gain *= clamp01((t - seg.start) / (ovEnd - seg.start));
    }
  }

  // Outgoing side: a later segment with a transition overlaps the tail of this one.
  const later = active.find((p) => p !== seg && p.clip.transition && p.start > seg.start && p.start < seg.end);
  if (later) {
    const ovEnd = Math.min(seg.end, later.end);
    if (t >= later.start && ovEnd > later.start) gain *= clamp01(1 - (t - later.start) / (ovEnd - later.start));
  }

  return gain;
}

/** Overlays whose clip-local frame window contains `localFrames`, with sampled animation. */
function activeOverlays(overlays: TextOverlay[] | undefined, localFrames: number): RenderOverlay[] {
  if (!overlays?.length) return [];
  const out: RenderOverlay[] = [];
  for (const o of overlays) {
    if (localFrames < (o.startFrame ?? 0) || localFrames > (o.endFrame ?? Infinity)) continue;
    const kf = o.keyframes;
    if (!kf) { out.push(o); continue; }
    // Sample animated x/y/opacity at the current clip-local frame (round so the
    // DOM snapshot signature is stable between identical frames).
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const anim: RenderOverlay["anim"] = {};
    if (kf.x?.length) anim.x = r3(sampleTrack(kf.x, localFrames));
    if (kf.y?.length) anim.y = r3(sampleTrack(kf.y, localFrames));
    if (kf.opacity?.length) anim.opacity = r3(sampleTrack(kf.opacity, localFrames));
    out.push({ ...o, anim });
  }
  return out;
}

/**
 * Build the draw/audio plan for the project at `playheadSec`. Video tracks are
 * walked in ascending `index` (bottom first), so the returned `clips` are
 * already in back-to-front draw order; audio-only tracks are appended.
 */
export function activeLayersAt(
  project: Project | null,
  assetById: Map<string, MediaAsset>,
  playheadSec: number,
): FramePlan {
  const out: ActiveClip[] = [];
  if (!project) return { clips: out };
  const fps = project.fps;
  const pvScale = previewScaleFor(project.width, project.height);
  const t = playheadSec;

  const tracks = [...project.tracks].sort((a, b) => {
    // Video tracks first (bottom→top by index), then audio tracks.
    if (a.kind !== b.kind) return a.kind === "video" ? -1 : 1;
    return a.index - b.index;
  });

  for (const track of tracks) {
    const sorted = [...track.clips].sort((a, b) => a.startFrame - b.startFrame);
    const segments = buildSegments(sorted, assetById, fps);
    const active = segments.filter((s) => t >= s.start && t < s.end);
    if (active.length === 0) continue;
    const blendOf = track.kind === "video" ? trackBlendModes(sorted, assetById) : undefined;

    for (const seg of active) {
      const asset = seg.asset;
      const gain = segmentGain(seg, active, t);
      const srcTime = sourceTimeFor(seg, t);

      // ADJUSTMENT layer: no source — contribute its color-proxy filter so the
      // renderer applies it to the composite of everything below.
      if (seg.clip.adjustment && track.kind === "video" && !track.hidden) {
        out.push({
          clipId: seg.clip.id,
          trackIndex: track.index,
          trackKind: track.kind,
          assetName: "Adjustment",
          srcTime: 0,
          rate: 1,
          gain,
          overlays: [],
          graphics: [],
          adjust: {
            colorFilter: colorFilter(seg.clip.effects?.color, seg.clip.effects?.grade, seg.clip.effects?.filters, pvScale),
            ...vignetteField(seg.clip.effects?.filters),
            ...maskField(seg.clip.effects?.mask),
          },
        });
        continue;
      }

      // A hidden video track still contributes audio — only its drawing is
      // suppressed (mirrors the engine's separate hidden/muted flags).
      const drawable = track.kind === "video" && !track.hidden && !!asset?.hasVideo;
      const audible = !!asset?.hasAudio && !track.muted;
      if (!drawable && !audible) continue;

      // Source-relative frames into the clip (overlay / caption windows below). NOTE: the export
      // treats those windows as clip-local TIMELINE frames; the two agree at speed 1 only
      // (pre-existing preview approximation, kept as-is for constant speed).
      const localFrames = seg.map ? Math.max(0, srcTime - seg.srcIn) * fps : Math.max(0, (t - seg.start) * seg.speed) * fps;
      // Keyframes/transform are indexed by clip-local TIMELINE frames (post-speed
      // output time), matching the engine's f2s(frame)→T bake.
      const localTL = Math.max(0, (t - seg.start) * fps);
      const cues = seg.clip.captions?.cues ?? [];
      const cue = drawable
        ? cues.find((c) => localFrames >= c.startFrame && localFrames <= c.endFrame)
        : undefined;

      // Motion graphics active this frame. Their show-window is clip-local
      // OUTPUT frames (= localTL, matching the export's f2s(startFrame)). Only
      // graphics with a browser-playable proxy (previewPath) can preview.
      const graphics: RenderGraphic[] = [];
      if (drawable) {
        for (const g of seg.clip.graphics ?? []) {
          const gs = g.startFrame ?? 0;
          const ge = g.endFrame ?? Infinity;
          if (localTL < gs || localTL > ge) continue;
          const gAsset = assetById.get(g.assetId);
          const gpath = gAsset?.previewPath;
          if (!gpath) continue;
          const dur = gAsset?.duration ?? 0;
          let st = (localTL - gs) / fps;
          if (dur > 0) st = Math.min(dur - 1e-3, Math.max(0, st));
          graphics.push({ key: g.id, path: gpath, srcTime: st, opacity: clamp01(g.opacity ?? 1) });
        }
      }

      const tf = drawable
        ? effectiveTransform(seg.clip.effects?.transform, seg.clip.keyframes, seg.clip.effects?.opacity, localTL)
        : undefined;
      const vol = effectiveValue("volume", seg.clip.keyframes?.volume, seg.clip.effects?.volume, localTL);

      out.push({
        clipId: seg.clip.id,
        trackIndex: track.index,
        trackKind: track.kind,
        assetName: asset?.name,
        path: seg.path,
        isImage: asset?.isImage,
        srcTime,
        rate: rateAt(seg, srcTime),
        ...(seg.map ? { ramped: true } : {}),
        gain,
        draw: drawable
          ? {
              opacity: gain * (tf?.opacity ?? 1),
              crop: seg.clip.effects?.crop,
              colorFilter: colorFilter(seg.clip.effects?.color, seg.clip.effects?.grade, seg.clip.effects?.filters, pvScale),
              assetWidth: asset!.width,
              assetHeight: asset!.height,
              transform: tf!,
              key: keyPlan(seg.clip.effects, pvScale),
              ...vignetteField(seg.clip.effects?.filters),
              ...blendField(blendOf?.get(seg.clip.id)),
              ...maskField(seg.clip.effects?.mask),
            }
          : undefined,
        // A ramp with audio "mute" plays its picture silently (as the export).
        audio: audible && !(seg.map && seg.clip.effects?.speedRamp?.audio === "mute")
          ? { volume: clamp01(vol) * gain * muteGainAt(bleepMuteSpans(seg.clip, fps), srcTime), ...audioFxField(seg.clip.effects?.audioFilters) }
          : undefined,
        overlays: drawable ? activeOverlays(seg.clip.overlays, localFrames) : [],
        graphics,
        caption: cue ? { text: cue.text, style: seg.clip.captions?.style } : undefined,
      });
    }
  }

  // Bleep sound effects: derived from every clip's bleeps (so they sit wherever
  // the clip is now), independent of the parent segment being under the playhead
  // (an audio slip can move them past the picture's edges).
  for (const b of bleepLayersOf(project)) {
    if (t >= b.layer.start - BLEEP_PREROLL_SEC && t < b.layer.start + b.layer.sfxDuration) {
      const preroll = t < b.layer.start;
      out.push({
        clipId: `bleep:${b.clipId}:${b.layer.bleepId}`,
        trackIndex: b.trackIndex,
        trackKind: "audio",
        assetName: "Bleep",
        path: b.path,
        srcTime: preroll ? 0 : t - b.layer.start,
        rate: 1,
        gain: 1,
        audio: preroll ? undefined : { volume: clamp01(b.layer.volume) },
        overlays: [],
        graphics: [],
        bleep: { parentClipId: b.clipId, bleepId: b.layer.bleepId, preroll },
      });
    }
  }

  return { clips: out };
}

/** How early a bleep's decoder is bound and parked at 0 before it sounds. */
const BLEEP_PREROLL_SEC = 0.6;

/** An audible bleep layer resolved to the file the preview plays. */
export interface PlacedBleep {
  clipId: string;
  trackIndex: number;
  layer: BleepLayer;
  path: string;
}

const bleepCache = new WeakMap<Project, PlacedBleep[]>();

/**
 * Every audible bleep sound effect in the project, mirroring the engine's
 * stageRender: unmuted tracks, clips with audio that aren't silenced (volume
 * 0), a playable sound file (built-in SFX asset or the custom asset). Cached
 * per project object (state updates replace it).
 */
export function bleepLayersOf(project: Project): PlacedBleep[] {
  const hit = bleepCache.get(project);
  if (hit) return hit;
  const out: PlacedBleep[] = [];
  const assets = new Map(project.assets.map((a) => [a.id, a]));
  const builtin = new Map(project.assets.filter((a) => a.builtinSfx).map((a) => [a.builtinSfx!, a]));
  const customDuration = (id: string) => {
    const a = assets.get(id);
    return a?.hasAudio ? a.duration : undefined;
  };
  for (const track of project.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (!clip.effects?.bleeps?.length || clip.effects.volume === 0 || clip.effects.speedRamp?.audio === "mute") continue;
      const asset = clip.assetId ? assets.get(clip.assetId) : undefined;
      if (!asset?.hasAudio) continue;
      for (const layer of expandBleeps(clip, project.fps, customDuration)) {
        if (layer.sfxDuration <= 0) continue;
        const sfx = layer.sfxAssetId ? assets.get(layer.sfxAssetId) : builtin.get(layer.sound);
        if (!sfx?.hasAudio) continue;
        out.push({ clipId: clip.id, trackIndex: track.index, layer, path: sfx.path });
      }
    }
  }
  bleepCache.set(project, out);
  return out;
}
