// <Series> and <Series.Sequence> (SPEC section 13).

import React from "react";
import { misuse } from "./errors";
import { SequenceBody } from "./Sequence";
import type { SequenceProps } from "./Sequence";
import { finiteNumber, positiveRate } from "./validate";

export interface SeriesSequenceProps extends Omit<SequenceProps, "from" | "loop" | "durationInFrames"> {
  /** Length of the scene in child-timeline frames. Infinity is allowed on the last scene only. */
  durationInFrames: number;
  /** Moves this scene and every later one; negative values overlap the previous scene. */
  offset?: number;
}

export type SeriesProps = SequenceProps;

function SeriesSequence(props: SeriesSequenceProps): React.ReactElement | null {
  void props;
  throw misuse("<Series.Sequence> only works as a direct child of <Series>. Wrap your scenes in <Series>.");
}

function describeChild(child: unknown): string {
  if (typeof child === "string" || typeof child === "number") return `the text ${JSON.stringify(String(child))}`;
  if (React.isValidElement(child)) {
    const type = child.type as unknown;
    if (typeof type === "string") return `a <${type}> element`;
    const name = (type as { displayName?: string; name?: string }).displayName ?? (type as { name?: string }).name;
    return name ? `a <${name}> element` : "an element of another component";
  }
  return "something that is not an element";
}

/** Children of <Series>, with fragments opened up and null, undefined and booleans dropped. */
function flatten(children: React.ReactNode, out: unknown[]): unknown[] {
  for (const child of React.Children.toArray(children)) {
    if (React.isValidElement(child) && child.type === React.Fragment) {
      flatten((child.props as { children?: React.ReactNode }).children, out);
    } else {
      out.push(child);
    }
  }
  return out;
}

function buildScenes(children: React.ReactNode): React.ReactElement[] {
  const items = flatten(children, []);
  const scenes: React.ReactElement[] = [];
  let start = 0;
  items.forEach((child, index) => {
    const where = `<Series.Sequence> #${index + 1}`;
    if (!React.isValidElement(child) || child.type !== SeriesSequence) {
      throw misuse(`<Series> accepts only <Series.Sequence> children, but child #${index + 1} is ${describeChild(child)}.`);
    }
    const { offset, from, loop, ...props } = child.props as SeriesSequenceProps & { from?: unknown; loop?: unknown };
    if (from !== undefined) {
      throw misuse(`${where}: from is not supported on a scene; use offset to move it.`);
    }
    if (loop !== undefined) {
      throw misuse(`${where}: loop is not supported on a scene; put a looping <Sequence> inside the scene instead.`);
    }
    const isLast = index === items.length - 1;
    const d = props.durationInFrames as unknown;
    const valid =
      typeof d === "number" && ((Number.isInteger(d) && d > 0) || (d === Infinity && isLast));
    if (!valid) {
      throw misuse(
        `${where}: durationInFrames must be a positive whole number of frames${isLast ? " (or Infinity, since this is the last scene)" : ""}, but got ${String(d)}.`,
      );
    }
    const shift = finiteNumber(offset, 0, where, "offset");
    const rate = positiveRate(props.playbackRate, where);
    const sceneStart = start + shift;
    const ref = (child as unknown as { ref?: React.ForwardedRef<HTMLDivElement> }).ref ?? null;
    scenes.push(
      <SequenceBody
        key={child.key ?? index}
        props={{ ...props, from: sceneStart, durationInFrames: d as number }}
        forwardedRef={ref}
        where={where}
      />,
    );
    start = sceneStart + (d as number) / rate;
  });
  return scenes;
}

const SeriesImpl = React.forwardRef<HTMLDivElement, SeriesProps>(function Series(props, ref) {
  const { children, layout, ...rest } = props;
  const scenes = buildScenes(children);
  return (
    <SequenceBody props={{ ...rest, layout: layout ?? "none", children: scenes }} forwardedRef={ref} where="<Series>" />
  );
});

export const Series = Object.assign(SeriesImpl, { Sequence: SeriesSequence });
