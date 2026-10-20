// <Loop> and Loop.useLoop() (SPEC section 14).

import React from "react";
import { FillDiv } from "./AbsoluteFill";
import { LoopContext, TimelineContext } from "./context";
import type { LoopInfo } from "./context";
import { misuse } from "./errors";
import { useStableLoop, useStableTimeline, useTimeline } from "./hooks";
import { mapLoop } from "./timing";
import { oneOf, positiveRate } from "./validate";

export interface LoopProps {
  /** Length of one iteration, in parent-timeline frames. */
  durationInFrames: number;
  /** Number of iterations. Default Infinity. */
  times?: number;
  layout?: "absolute-fill" | "none";
  style?: React.CSSProperties;
  className?: string;
  playbackRate?: number;
  children?: React.ReactNode;
  /** Accepted and ignored. */
  name?: string;
  /** Accepted and ignored (ZedMix never premounts). */
  premountFor?: number;
  /** Accepted and ignored (ZedMix never postmounts). */
  postmountFor?: number;
  /** Accepted and ignored. */
  styleWhilePremounted?: React.CSSProperties;
  /** Accepted and ignored. */
  styleWhilePostmounted?: React.CSSProperties;
}

const WHERE = "<Loop>";

const LoopImpl = React.forwardRef<HTMLDivElement, LoopProps>(function Loop(props, ref) {
  const parent = useTimeline(WHERE);
  const d = props.durationInFrames as unknown;
  if (typeof d !== "number" || !Number.isFinite(d) || d <= 0) {
    throw misuse(`${WHERE}: durationInFrames is required and must be a positive, finite number of frames.`);
  }
  const times = props.times ?? Infinity;
  if (typeof times !== "number" || !(times === Infinity || (Number.isInteger(times) && times >= 0))) {
    throw misuse(`${WHERE}: times must be a whole number of repetitions (0 or more), or Infinity.`);
  }
  const rate = positiveRate(props.playbackRate, WHERE);
  const layout = oneOf(props.layout, ["absolute-fill", "none"] as const, "absolute-fill", WHERE, "layout");
  if (layout === "none" && (props.style !== undefined || props.className !== undefined)) {
    throw misuse(`${WHERE}: style and className need a container, so they cannot be used with layout="none".`);
  }
  if (layout === "none" && ref) {
    throw misuse(`${WHERE}: a ref needs a container element, so it cannot be used with layout="none".`);
  }
  const mapped = mapLoop(parent, d, times, rate);
  const timeline = useStableTimeline(mapped ? mapped.timeline : null);
  const loop = useStableLoop(mapped ? mapped.loop : null);
  if (!timeline || !loop) return null;
  const content = (
    <LoopContext.Provider value={loop}>
      <TimelineContext.Provider value={timeline}>{props.children}</TimelineContext.Provider>
    </LoopContext.Provider>
  );
  if (layout === "none") return content;
  return (
    <FillDiv ref={ref} className={props.className} style={props.style}>
      {content}
    </FillDiv>
  );
});

/** The enclosing loop's length and zero-based iteration, or null outside any loop. */
function useLoop(): LoopInfo | null {
  return React.useContext(LoopContext);
}

export const Loop = Object.assign(LoopImpl, { useLoop });
