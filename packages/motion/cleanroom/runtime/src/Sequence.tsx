// <Sequence> (SPEC section 12).

import React from "react";
import { FillDiv } from "./AbsoluteFill";
import { LoopContext, TimelineContext } from "./context";
import { cropClipPath, hasCrop } from "./crop";
import type { CropProps } from "./crop";
import { misuse } from "./errors";
import { useStableLoop, useStableTimeline, useTimeline } from "./hooks";
import { mapSequence } from "./timing";
import { readSequenceTiming } from "./timingProps";
import { oneOf, optionalBoolean } from "./validate";

export type SequenceLayout = "absolute-fill" | "none";

export interface SequenceProps extends CropProps {
  children?: React.ReactNode;
  from?: number;
  durationInFrames?: number;
  trimBefore?: number;
  loop?: boolean;
  playbackRate?: number;
  freeze?: number | null;
  hidden?: boolean;
  width?: number;
  height?: number;
  layout?: SequenceLayout;
  style?: React.CSSProperties;
  className?: string;
  /** Accepted and ignored. */
  name?: string;
  /** Accepted and ignored. */
  showInTimeline?: boolean;
  /** Accepted and ignored (ZedMix never premounts). */
  premountFor?: number;
  /** Accepted and ignored (ZedMix never postmounts). */
  postmountFor?: number;
  /** Accepted and ignored. */
  styleWhilePremounted?: React.CSSProperties;
  /** Accepted and ignored. */
  styleWhilePostmounted?: React.CSSProperties;
  /** Deprecated in SPEC; accepted and ignored. */
  outlineRef?: unknown;
}

function sizeProp(value: unknown, where: string, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw misuse(`${where}: ${name} must be a positive number of pixels.`);
  }
  return value;
}

/** The body of <Sequence>, shared with <Series> and its scenes (`where` names the caller). */
export function SequenceBody({
  props,
  forwardedRef,
  where,
}: {
  props: SequenceProps;
  forwardedRef: React.ForwardedRef<HTMLDivElement>;
  where: string;
}) {
  const parent = useTimeline(where);
  const timing = readSequenceTiming(props, where);
  const hidden = optionalBoolean(props.hidden, false, where, "hidden");
  const layout = oneOf(props.layout, ["absolute-fill", "none"] as const, "absolute-fill", where, "layout");
  if (layout === "none") {
    if (props.style !== undefined || props.className !== undefined) {
      throw misuse(`${where}: style and className need a container, so they cannot be used with layout="none".`);
    }
    if (hasCrop(props)) {
      throw misuse(`${where}: the crop props need layout="absolute-fill" (the default).`);
    }
    if (forwardedRef) {
      throw misuse(`${where}: a ref needs a container element, so it cannot be used with layout="none".`);
    }
  }
  const width = sizeProp(props.width, where, "width");
  const height = sizeProp(props.height, where, "height");
  const mapped = hidden ? null : mapSequence(parent, timing);
  const timeline = useStableTimeline(
    mapped ? { ...mapped.timeline, width: width ?? parent.width, height: height ?? parent.height } : null,
  );
  const loop = useStableLoop(mapped ? mapped.loop : null);
  if (!timeline) return null;

  let content = <TimelineContext.Provider value={timeline}>{props.children}</TimelineContext.Provider>;
  if (loop) content = <LoopContext.Provider value={loop}>{content}</LoopContext.Provider>;
  if (layout === "none") return content;

  const style: React.CSSProperties = { ...props.style };
  if (width !== undefined) style.width = width;
  if (height !== undefined) style.height = height;
  if (props.style?.width !== undefined) style.width = props.style.width;
  if (props.style?.height !== undefined) style.height = props.style.height;
  const clipPath = cropClipPath(props, props.style, where);
  if (clipPath) style.clipPath = clipPath;
  return (
    <FillDiv ref={forwardedRef} className={props.className} style={style}>
      {content}
    </FillDiv>
  );
}

export const Sequence = React.forwardRef<HTMLDivElement, SequenceProps>(function Sequence(props, ref) {
  return <SequenceBody props={props} forwardedRef={ref} where="<Sequence>" />;
});
