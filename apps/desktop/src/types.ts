// Renderer-side mirror of the core project model (kept minimal & decoupled so
// the renderer bundle never pulls in Node-only core code).
import type { Keyframes, Transform } from "./keyframes";
import type { BlendMode, ClipMask } from "@aive/core/compositing";
import { clipFootprintFrames, type SpeedRamp } from "@aive/core/speed";
import type { ProbedColor } from "@aive/core/colorspace";

export type { BlendMode, ClipMask, MaskShape } from "@aive/core/compositing";
export type { RampAudio, RampPreset, SpeedRamp, SpeedRampPoint } from "@aive/core/speed";

export type { EaseKind, Keyframe, KeyframeProperty, Keyframes, Transform } from "./keyframes";

export interface MediaFolder {
  id: string;
  name: string;
  createdAt: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface AssetTranscript {
  segments: TranscriptSegment[];
  model?: string;
  language?: string;
}

export interface MediaAsset {
  id: string;
  path: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** True for a still image (png/jpg/…): looped to fill its clip; drawn from an <img>. */
  isImage?: boolean;
  videoCodec?: string;
  audioCodec?: string;
  /** The video stream's probed colour description (core ffmpeg/colorspace.ts). */
  color?: ProbedColor;
  addedAt: number;
  proxyPath?: string;
  /** The preview proxy's probed colour description (core ffmpeg/colorspace.ts). */
  proxyColor?: ProbedColor;
  /** Browser-playable preview proxy (alpha .webm) for motion-graphic overlays. */
  previewPath?: string;
  folderId?: string;
  /** Present only in .aive files; live state carries transcriptIndexed instead. */
  transcript?: AssetTranscript;
  /** True when the asset's transcript is indexed (the live-state marker). */
  transcriptIndexed?: boolean;
  /** Why the background proxy transcode failed, if it did. */
  proxyError?: string;
  /** Present once visually indexed (shape mirrors core; not needed in detail by the UI). */
  visualSig?: { samples: unknown[]; bins: number };
  /** Set on the synthesized bleep sound effect assets (one per sound). */
  builtinSfx?: BleepSound;
  /** Set on an asset baked by reverse_clip: the original span it reverses. */
  reversedFrom?: { assetId: string; sourceInFrame: number; sourceOutFrame: number };
  /** Set on a matte-backed remove_background cutout: its colour source (core types.ts). */
  cutout?: { colorPath: string; colorStart: number; colorAssetId?: string; colorTags?: ProbedColor; colorCodec?: string };
}

export interface ColorAdjust {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  gamma?: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RGBWheel {
  r?: number;
  g?: number;
  b?: number;
}

export interface ColorGrade {
  temperature?: number;
  tint?: number;
  hue?: number;
  lift?: RGBWheel;
  gamma?: RGBWheel;
  gain?: RGBWheel;
  curve?: string;
  curveR?: string;
  curveG?: string;
  curveB?: string;
}

/** Mirrors core's VisualEffect; the vocabulary + params live in `@aive/core/effects`. */
export interface VisualEffect {
  id: string;
  type: string;
  amount?: number;
  color?: string;
  params?: Record<string, number>;
  /** false = bypassed (skipped in export and preview). Absent = on. */
  enabled?: boolean;
}

/** Mirrors core's AudioEffect; the vocabulary + params live in `@aive/core/audio-effects`. */
export interface AudioEffect {
  id: string;
  type: string;
  params?: Record<string, number>;
  /** false = bypassed (skipped in export and preview). Absent = on. */
  enabled?: boolean;
}

/** A spoken-word search hit from search_transcript. */
export interface TranscriptHit {
  assetId: string;
  assetName: string;
  start: number;
  end: number;
  text: string;
  score: number;
}

/** A visual-search result from search_visual. */
export interface VisualHit {
  assetId: string;
  name: string;
  score: number;
  atSeconds: number;
}

/** Result of inspect_color — numeric scopes + rendered scope image paths. */
export interface ColorInspection {
  stats: {
    luma: { min: number; avg: number; max: number; contrast: number };
    saturation: { avg: number; max: number };
    hue: { avg: number };
    rgb: { r: number; g: number; b: number };
    notes: string[];
  };
  scopes: { histogram: string; waveform: string; vectorscope: string };
}

/** Built-in bleep sounds (mirrors core). */
export type BleepSound = "beep" | "quack" | "squeak" | "boing" | "honk";

/** A bleep on a clip: a muted window in SOURCE (asset) seconds + the sound played there. */
export interface Bleep {
  id: string;
  start: number;
  end: number;
  sound?: BleepSound;
  /** Custom sound asset (overrides `sound`). */
  sfxAssetId?: string;
  /** SFX gain (default 0.8). */
  volume?: number;
  /** Silence the original under the window (default true). */
  mute?: boolean;
  word?: string;
}

export interface ClipEffects {
  /** Bleeps censoring this clip (source seconds; follow the clip through every edit). */
  bleeps?: Bleep[];
  /** Audio effects (source time, after bleep mutes, before speed; never on bleep sounds). */
  audioFilters?: AudioEffect[];
  /** Constant speed (0.25..4); exclusive with `speedRamp`. */
  speed?: number;
  /** Curve speed (points in asset seconds; the mapping is `@aive/core/speed`, shared with the export). */
  speedRamp?: SpeedRamp;
  volume?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  color?: ColorAdjust;
  grade?: ColorGrade;
  lut?: string;
  filters?: VisualEffect[];
  crop?: CropRect;
  transform?: Transform;
  opacity?: number;
  /** How the picture composites onto the tracks below (absent = normal). */
  blendMode?: BlendMode;
  /** Shape mask in the clip's own picture space (follows the transform). */
  mask?: ClipMask;
}

export type TransitionType =
  | "fade" | "dissolve" | "wipeleft" | "wiperight" | "wipeup" | "wipedown"
  | "slideleft" | "slideright" | "circleopen" | "circleclose"
  | "fadeblack" | "fadewhite" | "radial" | "smoothleft" | "smoothright";

export interface Transition {
  type: TransitionType;
  /** Overlap duration in frames. */
  durationFrames: number;
}

export type OverlayPosition =
  | "top" | "center" | "bottom" | "topleft" | "topright" | "bottomleft" | "bottomright";

/** Free-form text style shared by overlays and captions (mirrors the core). */
export interface TextStyle {
  position?: string;
  x?: number;
  y?: number;
  font?: string;
  fontSize?: number;
  color?: string;
  outlineColor?: string;
  outlineWidth?: number;
  shadowColor?: string;
  shadowX?: number;
  shadowY?: number;
  box?: boolean;
  boxColor?: string;
  boxBorderW?: number;
}

export type TextAnimProperty = "x" | "y" | "opacity";

export interface TextOverlay extends TextStyle {
  id: string;
  text: string;
  startFrame?: number;
  endFrame?: number;
  keyframes?: Partial<Record<TextAnimProperty, import("./keyframes").Keyframe[]>>;
}

export interface CaptionCue {
  startFrame: number;
  endFrame: number;
  text: string;
}

export interface Captions {
  cues: CaptionCue[];
  style?: TextStyle;
  model?: string;
  language?: string;
}

export interface GraphicOverlay {
  id: string;
  assetId: string;
  startFrame?: number;
  endFrame?: number;
  opacity?: number;
  code?: string;
  props?: Record<string, unknown>;
}

export interface Clip {
  id: string;
  /** Source asset — absent for adjustment layers. */
  assetId?: string;
  /** True = adjustment layer: its grade/effects apply to all video below it. */
  adjustment?: boolean;
  startFrame: number;
  sourceInFrame: number;
  sourceOutFrame: number;
  effects?: ClipEffects;
  transition?: Transition;
  overlays?: TextOverlay[];
  captions?: Captions;
  graphics?: GraphicOverlay[];
  keyframes?: Keyframes;
  audioOffsetFrames?: number;
  linkGroupId?: string;
}

export interface MusicSettings {
  assetId: string;
  volume: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  duck?: boolean;
}

export interface Track {
  id: string;
  kind: "video" | "audio";
  index: number;
  name?: string;
  muted?: boolean;
  volume?: number;
  hidden?: boolean;
  locked?: boolean;
  height?: number;
  clips: Clip[];
}

/** A named timeline marker (frame flag with optional annotation). */
export interface Marker {
  frame: number;
  name?: string;
  color?: string;
  note?: string;
}

export interface Project {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  assets: MediaAsset[];
  folders?: MediaFolder[];
  tracks: Track[];
  music?: MusicSettings;
  /** Timeline-wide NAMED markers (persisted; snap targets + annotations). */
  markers?: Marker[];
  revision: number;
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
}

/** One frame = 1/fps seconds. Helpers for the renderer's seconds<->frames work. */
export function framesToSeconds(frames: number, fps: number): number {
  return frames / fps;
}
export function secondsToFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}
/** Timeline footprint in frames — the SAME function as core's (speed + speed ramps, `@aive/core/speed`). */
export function clipDurationFrames(clip: Clip, fps: number): number {
  return clipFootprintFrames(clip, fps);
}

/** A long-running core job (core jobs.ts): broadcast as `{type:"job"}` on every change and listed by list_jobs. */
export interface JobInfo {
  id: string;
  type: string;
  /** e.g. "Remove background clip.mp4". */
  label: string;
  status: "running" | "done" | "error" | "canceled";
  /** 0..1; stays 0 for work that can't report progress. */
  fraction: number;
  startedAt: number;
}

declare global {
  interface Window {
    aive?: {
      platform: string;
      pickFiles: () => Promise<string[]>;
      pickSavePath: (ext?: string) => Promise<string | null>;
      openProject: () => Promise<string | null>;
      saveProjectAs: (defaultName: string) => Promise<string | null>;
      onMenu: (cb: (action: string) => void) => void;
      reportProjectState: (state: { dirty: boolean; hasPath: boolean }) => void;
      reportSaveFailed?: () => void;
      getMcpConfig: () => Promise<{ available: boolean; packaged: boolean; mcpEntry: string | null; json: string }>;
    };
  }
}
