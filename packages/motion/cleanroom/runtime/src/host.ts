// The host interface (BRIEF sections 4 and 5). Not part of exports.json.

export interface AssetInfo {
  handle: string;                 // opaque, per render; never a path
  kind: "video" | "image" | "audio" | "font";
  width?: number;                 // image, video: always present (pixels)
  height?: number;                // image, video: always present
  durationSeconds?: number;       // video, audio: always present
  fps?: number;                   // video: always present
  frameCount?: number;            // video: always present; source frames 0..frameCount-1
  hasAudio?: boolean;             // video: always present
}

export interface CompositionInput {
  id: string;                     // "Graphic"
  width: number; height: number;  // canvas, CSS pixels
  fps: number;
  durationInFrames: number;
  props: Readonly<Record<string, unknown>>; // JSON values only
}

export interface AudioCue {
  sourceKey: string;              // stable while the source stays mounted; distinct among sources mounted together
  handle: string;                 // the asset's handle (an audio asset, or a video asset with hasAudio)
  sourceTime: number;             // seconds into the source that should be heard at this frame
  volume: number;                 // 0..4 after clamping; NaN -> 0
}

export interface MotionHost {
  composition: CompositionInput;
  assets: Readonly<Record<string, AssetInfo>>;  // asset id -> info
  /** URL for an image asset, or one source frame of a video asset. Same arguments, same URL. */
  mediaUrl(handle: string, box: { w: number; h: number }, sourceFrame?: number): string;
  /** URL for a font asset's file. */
  fontUrl(handle: string): string;
  log(text: string): void;
  frameTimeoutMs?: number;        // default 30000 (tests pass a small value)
}

export interface FrameResult { cues: AudioCue[] }

export interface MotionApp {
  renderFrame(n: number): Promise<FrameResult>;
  unmount(): void;
}

// createModuleObject(host: MotionHost): object                       (section 5)
// createMotionApp(host, Component, container): MotionApp              (section 4)
export { createModuleObject } from "./moduleObject";
export { createMotionApp } from "./app";
