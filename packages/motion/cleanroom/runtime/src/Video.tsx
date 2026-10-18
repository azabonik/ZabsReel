// <Html5Video> and <OffthreadVideo> (SPEC sections 19-20 with BRIEF section 6.3). Both render
// the current source frame as an <img>; there is no <video> element and no decoder.

import React from "react";
import { resolveMediaSource } from "./assets";
import type { MediaSource } from "./Img";
import { graphicError } from "./errors";
import type { AudioCue } from "./hostTypes";
import { useRuntime, useTimeline } from "./hooks";
import { MediaImage } from "./MediaImage";
import {
  assertNonNegativeTime,
  assignRef,
  evaluateVolume,
  mediaPosition,
  readMediaTiming,
  sourceFrameAt,
  useAudioSource,
  userSized,
  useSourceKey,
} from "./media";
import type { LoopVolumeCurveBehavior } from "./media";
import { optionalBoolean } from "./validate";

/** Props both video components share. Native <video> attributes not listed here are dropped. */
export interface VideoPropsBase
  extends Omit<React.VideoHTMLAttributes<HTMLVideoElement>, "src" | "onError" | "crossOrigin" | "loop" | "muted" | "width" | "height"> {
  src: MediaSource;
  width?: number | string;
  height?: number | string;
  style?: React.CSSProperties;
  className?: string;
  id?: string;
  /** A number, or a function of the frame (counted from the media's start). Default 1. */
  volume?: number | ((frame: number) => number);
  muted?: boolean;
  playbackRate?: number;
  /** Media-local frames (composition fps) cut from the start. */
  trimBefore?: number;
  /** Deprecated: the media-local frame where playback stops. Prefer durationInFrames. */
  trimAfter?: number;
  /** Old name of trimBefore. */
  startFrom?: number;
  /** Old name of trimAfter. */
  endAt?: number;
  durationInFrames?: number;
  /** Where the media starts on its parent's timeline (default 0). */
  from?: number;
  loopVolumeCurveBehavior?: LoopVolumeCurveBehavior;
  onError?: (event: React.SyntheticEvent<HTMLImageElement, Event>) => void;
  /** Called once per frame with the <img> element that shows the frame. */
  onVideoFrame?: (frame: CanvasImageSource, timestamp?: number, metadata?: unknown) => void;
  /** Accepted and ignored. */
  onAutoPlayError?: (...args: unknown[]) => void;
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

export interface Html5VideoProps extends VideoPropsBase {
  /** Repeats the trimBefore/durationInFrames range (or the rest of the source). */
  loop?: boolean;
}

export interface OffthreadVideoProps extends VideoPropsBase {
  /** Accepted and ignored. */
  transparent?: boolean;
  /** Accepted and ignored. */
  toneMapped?: boolean;
  /** Removed from SPEC's API; accepted and ignored. */
  imageFormat?: "jpeg" | "png";
  /** OffthreadVideo has no loop prop; as a native <video> attribute it is dropped. */
  loop?: boolean;
}

/** The attributes that reach the <img> (BRIEF section 6.3). */
function forwardedAttributes(props: Record<string, unknown>): React.ImgHTMLAttributes<HTMLImageElement> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (
      key === "width" ||
      key === "height" ||
      key === "style" ||
      key === "className" ||
      key === "id" ||
      key.startsWith("aria-") ||
      key.startsWith("data-")
    ) {
      out[key] = value;
    }
  }
  return out as React.ImgHTMLAttributes<HTMLImageElement>;
}

function VideoBody({
  props,
  forwardedRef,
  where,
  allowLoop,
}: {
  props: VideoPropsBase & { loop?: boolean };
  forwardedRef: React.ForwardedRef<HTMLImageElement>;
  where: string;
  allowLoop: boolean;
}) {
  const runtime = useRuntime(where);
  const timeline = useTimeline(where);
  const sourceKey = useSourceKey(runtime);
  const image = React.useRef<HTMLImageElement | null>(null);
  const setImage = React.useCallback(
    (node: HTMLImageElement | null) => {
      image.current = node;
      assignRef(forwardedRef, node);
    },
    [forwardedRef],
  );

  const timing = readMediaTiming(props, where, allowLoop);
  const source = resolveMediaSource(props.src, "video", runtime.host.assets, where);
  if (source.kind !== "asset") throw new Error("unreachable: video sources are always assets");
  const { id, info } = source;
  const compFps = runtime.composition.fps;
  const assetFps = info.fps ?? compFps;
  const frameCount = info.frameCount ?? 1;
  const position = mediaPosition(timeline, timing, (frameCount / assetFps) * compFps, where);
  const muted = optionalBoolean(props.muted, false, where, "muted");

  let cue: AudioCue | null = null;
  let url: string | null = null;
  let sourceFrame = 0;
  if (position) {
    assertNonNegativeTime(position.localFrame, where, id);
    const seconds = position.localFrame / compFps;
    sourceFrame = sourceFrameAt(seconds, assetFps, frameCount);
    url = runtime.host.mediaUrl(info.handle, { w: info.width ?? 0, h: info.height ?? 0 }, sourceFrame);
    // A frozen video is paused, so it is silent; a video without sound never adds a cue.
    if (info.hasAudio === true && !muted && !timeline.frozen) {
      cue = {
        sourceKey,
        handle: info.handle,
        sourceTime: seconds,
        volume: evaluateVolume(props.volume, position.volumeFrame, where),
      };
    }
  }
  useAudioSource(runtime, sourceKey, cue, image);
  if (url === null) return null;

  const imgProps = forwardedAttributes(props as unknown as Record<string, unknown>);
  if (!userSized(props) && typeof info.width === "number" && typeof info.height === "number") {
    imgProps.width = info.width;
    imgProps.height = info.height;
  }
  // A frame in a box of another shape is letterboxed, as a video element shows it, unless the
  // style says otherwise (round 2's frame images: notes/fit/r2-media-rules.js, part 4).
  imgProps.style = { objectFit: "contain", ...imgProps.style };
  const { onVideoFrame } = props;
  return (
    <MediaImage
      url={url}
      label={`loading frame ${sourceFrame} of video "${id}"`}
      where={where}
      imgProps={imgProps}
      forwardedRef={setImage}
      onUserError={props.onError}
      onFrameReady={onVideoFrame ? (img) => onVideoFrame(img) : undefined}
      failure={() =>
        graphicError(
          "graphic_media_failed",
          `Frame ${sourceFrame} of the video "${id}" could not be loaded. Check the asset in the project library, or use another video.`,
        )
      }
    />
  );
}

export const Html5Video = React.forwardRef<HTMLImageElement, Html5VideoProps>(function Html5Video(props, ref) {
  return <VideoBody props={props} forwardedRef={ref} where="<Html5Video>" allowLoop={true} />;
});

export const OffthreadVideo = React.forwardRef<HTMLImageElement, OffthreadVideoProps>(function OffthreadVideo(props, ref) {
  return <VideoBody props={props} forwardedRef={ref} where="<OffthreadVideo>" allowLoop={false} />;
});
