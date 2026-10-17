// The <img> element behind <Img> and both video components. It holds a delay until its URL has
// loaded, reports failures, and counts toward the per-frame media cap.

import React from "react";
import type { GraphicError } from "./errors";
import { useRuntime, useTimeline } from "./hooks";
import { assignRef } from "./media";

export interface MediaImageProps {
  url: string;
  /** Delay label, shown in timeout messages. */
  label: string;
  where: string;
  imgProps: React.ImgHTMLAttributes<HTMLImageElement>;
  forwardedRef?: React.Ref<HTMLImageElement>;
  onUserLoad?: React.ReactEventHandler<HTMLImageElement>;
  onUserError?: (event: React.SyntheticEvent<HTMLImageElement, Event>) => void;
  onImageError?: (error: Error) => void;
  /** Called once per renderFrame() after commit and load (onVideoFrame). */
  onFrameReady?: (image: HTMLImageElement) => void;
  failure: () => GraphicError;
}

interface LoadState {
  loadedUrl: string | null;
  committedUrl: string | null;
  delay: number | null;
  notifiedSeq: number;
}

export function MediaImage(p: MediaImageProps) {
  const runtime = useRuntime(p.where);
  const timeline = useTimeline(p.where);
  const element = React.useRef<HTMLImageElement | null>(null);
  const stateRef = React.useRef<LoadState | null>(null);
  if (stateRef.current === null) {
    stateRef.current = { loadedUrl: null, committedUrl: null, delay: null, notifiedSeq: -1 };
  }
  const state = stateRef.current;
  const { forwardedRef } = p;
  const setElement = React.useCallback(
    (node: HTMLImageElement | null) => {
      element.current = node;
      assignRef(forwardedRef, node);
    },
    [forwardedRef],
  );

  const notifyFrame = () => {
    const image = element.current;
    if (!p.onFrameReady || !image || state.notifiedSeq === timeline.renderSeq) return;
    state.notifiedSeq = timeline.renderSeq;
    try {
      p.onFrameReady(image);
    } catch (error) {
      runtime.fail(error);
    }
  };

  React.useLayoutEffect(() => runtime.registerMediaElement(), [runtime]);

  React.useLayoutEffect(() => {
    state.committedUrl = p.url;
    const image = element.current;
    if (
      state.loadedUrl !== p.url &&
      image &&
      image.complete &&
      image.naturalWidth > 0 &&
      image.getAttribute("src") === p.url
    ) {
      state.loadedUrl = p.url;
    }
    if (state.loadedUrl === p.url) return undefined;
    const handle = runtime.session.openDelay(p.label);
    state.delay = handle;
    return () => {
      runtime.session.closeDelay(handle);
      if (state.delay === handle) state.delay = null;
    };
    // The label is read when the delay opens; a new label alone does not need a new delay.
  }, [runtime, state, p.url]);

  React.useLayoutEffect(() => {
    if (state.loadedUrl !== null && state.loadedUrl === state.committedUrl) notifyFrame();
  });

  const handleLoad = (event: React.SyntheticEvent<HTMLImageElement, Event>) => {
    if (event.currentTarget.getAttribute("src") !== p.url) return;
    state.loadedUrl = p.url;
    if (state.committedUrl === p.url) notifyFrame();
    if (state.delay !== null) {
      runtime.session.closeDelay(state.delay);
      state.delay = null;
    }
    if (p.onUserLoad) {
      try {
        p.onUserLoad(event);
      } catch (error) {
        runtime.fail(error);
      }
    }
  };

  const handleError = (event: React.SyntheticEvent<HTMLImageElement, Event>) => {
    if (event.currentTarget.getAttribute("src") !== p.url) return;
    const failure = p.failure();
    try {
      p.onUserError?.(event);
      p.onImageError?.(failure);
    } catch (error) {
      runtime.fail(error);
      return;
    }
    runtime.fail(failure);
  };

  return <img {...p.imgProps} ref={setElement} src={p.url} onLoad={handleLoad} onError={handleError} />;
}
