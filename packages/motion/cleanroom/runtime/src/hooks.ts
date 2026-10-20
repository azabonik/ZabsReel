// The public hooks and the internal context accessors.

import React from "react";
import { misuse } from "./errors";
import { RuntimeContext, TimelineContext } from "./context";
import type { AppRuntime, LoopInfo, Timeline, UseDelayRenderResult } from "./context";

/** What useVideoConfig() returns (SPEC section 3, BRIEF section 4). */
export interface VideoConfig {
  id: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  props: Readonly<Record<string, unknown>>;
  defaultProps: Readonly<Record<string, unknown>>;
  defaultCodec: null;
  defaultSampleRate: number;
}

/** ZedMix mixes audio at 48 kHz. */
export const DEFAULT_SAMPLE_RATE = 48000;

function outsideApp(what: string): Error {
  return misuse(
    `${what} can only be used inside a graphic that ZedMix is rendering. Call it from the graphic's component or its children.`,
  );
}

export function useRuntime(what: string): AppRuntime {
  const runtime = React.useContext(RuntimeContext);
  if (!runtime) throw outsideApp(what);
  return runtime;
}

export function useTimeline(what: string): Timeline {
  const timeline = React.useContext(TimelineContext);
  if (!timeline) throw outsideApp(what);
  return timeline;
}

export function useCurrentFrame(): number {
  return useTimeline("useCurrentFrame()").frame;
}

export function useVideoConfig(): VideoConfig {
  const runtime = useRuntime("useVideoConfig()");
  const timeline = useTimeline("useVideoConfig()");
  const { composition } = runtime;
  const { width, height, durationInFrames } = timeline;
  return React.useMemo(
    () => ({
      id: composition.id,
      width,
      height,
      fps: composition.fps,
      durationInFrames,
      props: composition.props,
      defaultProps: composition.props,
      defaultCodec: null,
      defaultSampleRate: DEFAULT_SAMPLE_RATE,
    }),
    [composition, width, height, durationInFrames],
  );
}

export function useDelayRender(): UseDelayRenderResult {
  return useRuntime("useDelayRender()").delayApi;
}

/** Keeps a Timeline's identity while its fields are unchanged, so consumers skip re-renders. */
export function useStableTimeline(t: Timeline | null): Timeline | null {
  return React.useMemo(
    () => t,
    // The deps are the field values: the object is replaced only when one of them changes.
    [t?.frame, t?.unloopedFrame, t?.durationInFrames, t?.width, t?.height, t?.frozen, t?.renderSeq],
  );
}

export function useStableLoop(loop: LoopInfo | null): LoopInfo | null {
  return React.useMemo(() => loop, [loop?.durationInFrames, loop?.iteration]);
}
