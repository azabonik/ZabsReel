// <Freeze> (SPEC section 15).

import React from "react";
import { TimelineContext } from "./context";
import { describeValue, misuse } from "./errors";
import { useStableTimeline, useTimeline } from "./hooks";
import { mapFreeze } from "./timing";

export interface FreezeProps {
  /** The frame the children see while frozen. */
  frame: number;
  /** false turns freezing off; a function decides per frame (it gets the parent's frame). */
  active?: boolean | ((frame: number) => boolean);
  children?: React.ReactNode;
}

export function Freeze({ frame, active, children }: FreezeProps) {
  const parent = useTimeline("<Freeze>");
  if (typeof frame !== "number" || !Number.isFinite(frame)) {
    throw misuse(`<Freeze>: frame is required and must be a finite number, but got ${describeValue(frame)}.`);
  }
  let frozen: boolean;
  if (active === undefined || active === null) frozen = true;
  else if (typeof active === "boolean") frozen = active;
  else if (typeof active === "function") frozen = Boolean(active(parent.frame));
  else throw misuse(`<Freeze>: active must be true, false or a function of the frame.`);
  const timeline = useStableTimeline(frozen ? mapFreeze(parent, frame) : parent);
  return <TimelineContext.Provider value={timeline}>{children}</TimelineContext.Provider>;
}
