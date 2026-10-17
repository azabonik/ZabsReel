// <AbsoluteFill> (SPEC section 11) and the fill <div> that Sequence, Series and Loop reuse.

import React from "react";
import { TimelineContext } from "./context";
import { useStableTimeline, useTimeline } from "./hooks";
import { mapSequence } from "./timing";
import { readSequenceTiming } from "./timingProps";
import { optionalBoolean } from "./validate";

const FILL_DEFAULTS: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
};

type FillKey = keyof typeof FILL_DEFAULTS;

const DISPLAY_CLASSES = new Set([
  "block", "inline-block", "inline", "flex", "inline-flex", "grid", "inline-grid", "hidden",
  "contents", "table", "flow-root", "list-item",
]);

/**
 * The default styles that a Tailwind class in `className` sets too. A variant prefix (`md:`,
 * `hover:` and so on) does not matter: `md:flex-row` counts like `flex-row`. Classes are matched
 * as written otherwise (an important marker such as `flex-row!` is not recognised), and position
 * classes (`relative`, `absolute`, ...) do not drop the default position.
 */
export function fillDefaultsOverriddenBy(className: string | undefined): Set<FillKey> {
  const dropped = new Set<FillKey>();
  if (!className) return dropped;
  for (const token of className.split(/\s+/)) {
    if (token === "") continue;
    // The utility after the last variant prefix, without a negative-value dash (`-top-2`).
    const cls = token.slice(token.lastIndexOf(":") + 1).replace(/^-/, "");
    if (DISPLAY_CLASSES.has(cls)) dropped.add("display");
    if (/^flex-(row|col)(-reverse)?$/.test(cls)) dropped.add("flexDirection");
    if (/^inset-x-/.test(cls)) {
      dropped.add("left");
      dropped.add("right");
    } else if (/^inset-y-/.test(cls)) {
      dropped.add("top");
      dropped.add("bottom");
    } else if (/^inset-/.test(cls)) {
      for (const side of ["top", "right", "bottom", "left"] as const) dropped.add(side);
    }
    for (const side of ["top", "right", "bottom", "left"] as const) {
      if (cls.startsWith(`${side}-`)) dropped.add(side);
    }
    if (/^(w|size)-/.test(cls)) dropped.add("width");
    if (/^(h|size)-/.test(cls)) dropped.add("height");
  }
  return dropped;
}

export function fillStyle(className: string | undefined, style: React.CSSProperties | undefined): React.CSSProperties {
  const dropped = fillDefaultsOverriddenBy(className);
  const base: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(FILL_DEFAULTS)) {
    if (!dropped.has(key as FillKey)) base[key] = value;
  }
  return { ...(base as React.CSSProperties), ...style };
}

/** A plain fill <div>: the default styles, then the caller's style on top. */
export const FillDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function FillDiv({ className, style, ...rest }, ref) {
    return <div ref={ref} className={className} style={fillStyle(className, style)} {...rest} />;
  },
);

export interface AbsoluteFillTimingProps {
  from?: number;
  durationInFrames?: number;
  trimBefore?: number;
  playbackRate?: number;
  freeze?: number | null;
  hidden?: boolean;
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
}

export type AbsoluteFillProps = Omit<React.HTMLAttributes<HTMLDivElement>, "hidden"> & AbsoluteFillTimingProps;

export const AbsoluteFill = React.forwardRef<HTMLDivElement, AbsoluteFillProps>(function AbsoluteFill(props, ref) {
  const {
    from, durationInFrames, trimBefore, playbackRate, freeze, hidden,
    name, showInTimeline, premountFor, postmountFor, styleWhilePremounted, styleWhilePostmounted,
    ...divProps
  } = props;
  const timed =
    from !== undefined ||
    durationInFrames !== undefined ||
    trimBefore !== undefined ||
    playbackRate !== undefined ||
    (freeze !== undefined && freeze !== null) ||
    hidden !== undefined;
  if (!timed) return <FillDiv ref={ref} {...divProps} />;
  return (
    <TimedFill
      forwardedRef={ref}
      timing={{ from, durationInFrames, trimBefore, playbackRate, freeze, hidden }}
      divProps={divProps}
    />
  );
});

interface TimedFillProps {
  forwardedRef: React.ForwardedRef<HTMLDivElement>;
  timing: Pick<AbsoluteFillTimingProps, "from" | "durationInFrames" | "trimBefore" | "playbackRate" | "freeze" | "hidden">;
  divProps: React.HTMLAttributes<HTMLDivElement>;
}

/** An AbsoluteFill with timing props: a Sequence whose container is the fill <div> itself. */
function TimedFill({ forwardedRef, timing, divProps }: TimedFillProps) {
  const parent = useTimeline("<AbsoluteFill> with timing props");
  const spec = readSequenceTiming(timing, "<AbsoluteFill>");
  const hidden = optionalBoolean(timing.hidden, false, "<AbsoluteFill>", "hidden");
  const mapped = hidden ? null : mapSequence(parent, spec);
  const timeline = useStableTimeline(mapped ? mapped.timeline : null);
  if (!timeline) return null;
  const { children, ...rest } = divProps;
  return (
    <FillDiv ref={forwardedRef} {...rest}>
      <TimelineContext.Provider value={timeline}>{children}</TimelineContext.Provider>
    </FillDiv>
  );
}
