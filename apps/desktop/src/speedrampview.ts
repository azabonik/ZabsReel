// The speed-curve editor's x-range (speedramp.tsx), kept pure so it can be
// tested in Node (scripts/smoke-composite.ts).
//
// A ramp's points are anchored in ASSET seconds, so a trim or a split leaves
// some of them outside the clip's used source range — yet the nearest ones on
// each side still shape the curve at the clip's ends. The editor therefore
// shows the clip's range WIDENED to the points outside it (shaded as "outside
// the clip"), so they can be seen, dragged and deleted. Each side grows by at
// most `maxSpans` × the clip's span, so the clip keeps a usable share of the
// width; a point further out sits on the edge as a ghost marker (still
// selectable, draggable into view and deletable).

import type { SpeedRampPoint } from "@aive/core/speed";

export interface CurveView {
  /** Asset seconds at the editor's left / right edge. */
  lo: number;
  hi: number;
}

/** Where a point is drawn: inside the clip, outside it (shaded part), or as a ghost on the left / right edge. */
export type PointPlace = "in" | "out" | "ghost-lo" | "ghost-hi";

/** The editor's x-range for a curve over the clip's used source range [srcIn, srcOut]. */
export function curveView(points: readonly SpeedRampPoint[], srcIn: number, srcOut: number, maxSpans = 1.5): CurveView {
  const span = Math.max(1e-3, srcOut - srcIn);
  const ext = maxSpans * span;
  let lo = srcIn;
  let hi = srcOut;
  for (const p of points) {
    if (p.src < lo) lo = p.src;
    if (p.src > hi) hi = p.src;
  }
  return { lo: Math.max(lo, srcIn - ext), hi: Math.min(hi, srcOut + ext) };
}

/** Where `p` is drawn in `view` (1 µs of slack at the clip's edges). */
export function pointPlace(p: SpeedRampPoint, view: CurveView, srcIn: number, srcOut: number): PointPlace {
  if (p.src < view.lo - 1e-6) return "ghost-lo";
  if (p.src > view.hi + 1e-6) return "ghost-hi";
  return p.src >= srcIn - 1e-6 && p.src <= srcOut + 1e-6 ? "in" : "out";
}
