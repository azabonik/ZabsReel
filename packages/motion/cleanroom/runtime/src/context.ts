// React contexts shared by the components. The app (app.tsx) provides them.

import React from "react";
import type { AudioCue, CompositionInput, MotionHost } from "./hostTypes";
import type { DelayRenderOptions, Session } from "./session";

/** What a subtree sees of time. */
export interface Timeline {
  /** The value useCurrentFrame() returns. */
  frame: number;
  /**
   * The same mapping with every loop's wrap-around left out. Only used for the volume callback
   * with loopVolumeCurveBehavior="extend".
   */
  unloopedFrame: number;
  /** The value useVideoConfig().durationInFrames reports. */
  durationInFrames: number;
  width: number;
  height: number;
  /** Inside an active <Freeze>, or a Sequence with `freeze`: video holds, audio is silent. */
  frozen: boolean;
  /** Changes on every renderFrame() call, so per-frame work reruns even when a frame repeats. */
  renderSeq: number;
}

/** What Loop.useLoop() returns. */
export interface LoopInfo {
  durationInFrames: number;
  iteration: number;
}

export interface UseDelayRenderResult {
  delayRender: (label?: string, options?: DelayRenderOptions) => number;
  continueRender: (handle: number) => void;
  cancelRender: (reason: unknown) => never;
}

/** One audible source (audio element or video with sound), as of its last commit. */
export interface AudioSourceEntry {
  readonly key: string;
  /** The DOM element that marks the source's position in the tree. */
  anchor: Element | null;
  cue: AudioCue | null;
}

/** The app-level services components use. */
export interface AppRuntime {
  readonly session: Session;
  readonly host: MotionHost;
  readonly composition: CompositionInput;
  readonly delayApi: UseDelayRenderResult;
  /** Counts a mounted media <img>; returns the function that uncounts it. */
  registerMediaElement(): () => void;
  registerAudioSource(entry: AudioSourceEntry): () => void;
  nextSourceKey(): string;
  /** Fails the current (or next) frame with the given error or thrown value. */
  fail(error: unknown): void;
}

export const RuntimeContext = React.createContext<AppRuntime | null>(null);
export const TimelineContext = React.createContext<Timeline | null>(null);
export const LoopContext = React.createContext<LoopInfo | null>(null);
