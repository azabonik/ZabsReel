// <Img> (SPEC section 17 with BRIEF sections 6.1, 6.2 and 6.6).

import React from "react";
import type { AssetRef } from "./assets";
import { resolveMediaSource } from "./assets";
import { cropClipPath } from "./crop";
import type { CropProps } from "./crop";
import { graphicError } from "./errors";
import { useRuntime, useTimeline } from "./hooks";
import { MediaImage } from "./MediaImage";
import { userSized } from "./media";
import { mapSequence } from "./timing";
import { readSequenceTiming } from "./timingProps";
import { optionalBoolean } from "./validate";

export type MediaSource = AssetRef | string;

export interface ImgProps
  extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src" | "onError" | "crossOrigin" | "hidden">,
    CropProps {
  src: MediaSource;
  onError?: (event: React.SyntheticEvent<HTMLImageElement, Event>) => void;
  onImageError?: (error: Error) => void;
  from?: number;
  durationInFrames?: number;
  /** Accepted; a still image has no timeline to trim, so it has no visible effect. */
  trimBefore?: number;
  hidden?: boolean;
  /** Accepted and ignored. */
  maxRetries?: number;
  /** Accepted and ignored. */
  crossOrigin?: "anonymous" | "use-credentials";
  /** Accepted and ignored. */
  pauseWhenLoading?: boolean;
  /** Accepted and ignored. */
  delayRenderTimeoutInMilliseconds?: number;
  /** Accepted and ignored. */
  delayRenderRetries?: number;
  /** Accepted and ignored. */
  name?: string;
  /** Accepted and ignored. */
  showInTimeline?: boolean;
  /** Accepted and ignored (ZabsReel never premounts). */
  premountFor?: number;
  /** Accepted and ignored (ZabsReel never postmounts). */
  postmountFor?: number;
  /** Accepted and ignored. */
  styleWhilePremounted?: React.CSSProperties;
  /** Accepted and ignored. */
  styleWhilePostmounted?: React.CSSProperties;
  /** Accepted and ignored: images always render as a native <img>. */
  effects?: readonly unknown[];
}

const WHERE = "<Img>";

export const Img = React.forwardRef<HTMLImageElement, ImgProps>(function Img(props, ref) {
  const {
    src, onError, onImageError, onLoad, from, durationInFrames, trimBefore, hidden,
    maxRetries, crossOrigin, pauseWhenLoading, delayRenderTimeoutInMilliseconds, delayRenderRetries,
    name, showInTimeline, premountFor, postmountFor, styleWhilePremounted, styleWhilePostmounted, effects,
    cropLeft, cropRight, cropTop, cropBottom,
    // These could make the browser load something other than the host's URL, or never load it.
    srcSet, sizes, loading,
    ...imgProps
  } = props;
  const runtime = useRuntime(WHERE);
  const parent = useTimeline(WHERE);
  const timing = readSequenceTiming({ from, durationInFrames, trimBefore }, WHERE);
  const isHidden = optionalBoolean(hidden, false, WHERE, "hidden");
  if (isHidden || mapSequence(parent, timing) === null) return null;

  const source = resolveMediaSource(src, "image", runtime.host.assets, WHERE);
  const finalProps: React.ImgHTMLAttributes<HTMLImageElement> = { ...imgProps };
  let url: string;
  let label: string;
  let failure: () => ReturnType<typeof graphicError>;
  if (source.kind === "data") {
    url = source.url;
    label = "loading a data: image";
    failure = () =>
      graphicError("graphic_media_failed", "A data: image in <Img> could not be loaded. Check that the data URL holds a valid image.");
  } else {
    const { id, info } = source;
    url = runtime.host.mediaUrl(info.handle, { w: info.width ?? 0, h: info.height ?? 0 });
    label = `loading image "${id}"`;
    failure = () =>
      graphicError(
        "graphic_media_failed",
        `The image "${id}" could not be loaded. Check the asset in the project library, or use another image.`,
      );
    if (!userSized(props) && typeof info.width === "number" && typeof info.height === "number") {
      finalProps.width = info.width;
      finalProps.height = info.height;
    }
  }
  const clipPath = cropClipPath({ cropLeft, cropRight, cropTop, cropBottom }, imgProps.style, WHERE);
  if (clipPath) finalProps.style = { ...imgProps.style, clipPath };

  return (
    <MediaImage
      url={url}
      label={label}
      where={WHERE}
      imgProps={finalProps}
      forwardedRef={ref}
      onUserLoad={onLoad}
      onUserError={onError}
      onImageError={onImageError}
      failure={failure}
    />
  );
});
