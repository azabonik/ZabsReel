// <Html5Audio> (SPEC section 21 with BRIEF section 6.4). Nothing plays in the page: the component
// reports a cue per frame and renders a hidden, empty <audio> element that marks its place in
// the tree (cues come out in tree order).

import React from "react";
import { resolveMediaSource } from "./assets";
import type { MediaSource } from "./Img";
import type { AudioCue } from "./hostTypes";
import { useRuntime, useTimeline } from "./hooks";
import {
  assertNonNegativeTime,
  evaluateVolume,
  mediaPosition,
  readMediaTiming,
  useAudioSource,
  useSourceKey,
} from "./media";
import type { LoopVolumeCurveBehavior } from "./media";
import { optionalBoolean } from "./validate";

export interface Html5AudioProps {
  src: MediaSource;
  /** A number, or a function of the frame (counted from the media's start). Default 1. */
  volume?: number | ((frame: number) => number);
  /** May change from frame to frame. */
  muted?: boolean;
  loop?: boolean;
  playbackRate?: number;
  trimBefore?: number;
  /** Deprecated: the media-local frame where playback stops. Prefer durationInFrames. */
  trimAfter?: number;
  /** Old name of trimBefore. */
  startFrom?: number;
  /** Old name of trimAfter. */
  endAt?: number;
  durationInFrames?: number;
  /** Where the audio starts on its parent's timeline (default 0). */
  from?: number;
  loopVolumeCurveBehavior?: LoopVolumeCurveBehavior;
  /** Accepted; never called, because audio does not play in the page. */
  onError?: (...args: unknown[]) => void;
  /** Accepted and ignored. */
  crossOrigin?: "anonymous" | "use-credentials";
  /** Accepted and ignored. */
  preservePitch?: boolean;
  /** Accepted and ignored. */
  toneFrequency?: number;
  /** Accepted and ignored. */
  audioStreamIndex?: number;
  /** Accepted and ignored. */
  acceptableTimeShiftInSeconds?: number;
  /** Accepted and ignored. */
  pauseWhenBuffering?: boolean;
  /** Accepted and ignored. */
  name?: string;
  /** Accepted and ignored. */
  showInTimeline?: boolean;
  /** Accepted and ignored. */
  delayRenderTimeoutInMilliseconds?: number;
  /** Accepted and ignored. */
  delayRenderRetries?: number;
  /** Accepted and ignored: the volume is passed to the host whatever this says. */
  useWebAudioApi?: boolean;
  /** Accepted and ignored. */
  allowAmplificationDuringRender?: boolean;
}

const WHERE = "<Html5Audio>";

function AudioBody({ props }: { props: Html5AudioProps }) {
  const runtime = useRuntime(WHERE);
  const timeline = useTimeline(WHERE);
  const sourceKey = useSourceKey(runtime);
  const anchor = React.useRef<HTMLAudioElement | null>(null);

  const timing = readMediaTiming(props, WHERE, true);
  const source = resolveMediaSource(props.src, "audio", runtime.host.assets, WHERE);
  if (source.kind !== "asset") throw new Error("unreachable: audio sources are always assets");
  const { id, info } = source;
  const compFps = runtime.composition.fps;
  const position = mediaPosition(timeline, timing, (info.durationSeconds ?? 0) * compFps, WHERE);
  const muted = optionalBoolean(props.muted, false, WHERE, "muted");

  let cue: AudioCue | null = null;
  if (position) {
    assertNonNegativeTime(position.localFrame, WHERE, id);
    // Inside a <Freeze>, audio is rendered muted.
    if (!muted && !timeline.frozen) {
      cue = {
        sourceKey,
        handle: info.handle,
        sourceTime: position.localFrame / compFps,
        volume: evaluateVolume(props.volume, position.volumeFrame, WHERE),
      };
    }
  }
  useAudioSource(runtime, sourceKey, cue, anchor);
  if (!position) return null;
  return <audio ref={anchor} hidden />;
}

export const Html5Audio = React.forwardRef<HTMLAudioElement, Html5AudioProps>(function Html5Audio(props, ref) {
  void ref; // The marker element is internal, so refs are not attached to it.
  return <AudioBody props={props} />;
});
