// Tiny shared state between the inspector's Mask group (maskpanel.tsx) and the
// preview's on-canvas mask handle (preview.tsx): which clip's mask can be
// dragged right now, how to commit a drop (ONE set_clip_mask on release), and
// the live position while dragging (drawn instead of the stored mask, so the
// preview follows the pointer without an RPC per move).

export interface MaskEditTarget {
  clipId: string;
  /** Commit a new mask centre (fractions of the clip's picture). */
  commit: (x: number, y: number) => void;
}

let target: MaskEditTarget | null = null;
let drag: { clipId: string; x: number; y: number } | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function setMaskEditTarget(t: MaskEditTarget | null): void {
  if (target?.clipId === t?.clipId && target?.commit === t?.commit) return;
  target = t;
  if (!t) drag = null;
  notify();
}

export function maskEditTarget(): MaskEditTarget | null {
  return target;
}

/** Subscribe to target changes; returns the unsubscribe. */
export function onMaskEditChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The in-progress drag position for a clip's mask, if any. */
export function maskDragFor(clipId: string): { x: number; y: number } | null {
  return drag && drag.clipId === clipId ? { x: drag.x, y: drag.y } : null;
}

export function setMaskDrag(d: { clipId: string; x: number; y: number } | null): void {
  drag = d;
}
