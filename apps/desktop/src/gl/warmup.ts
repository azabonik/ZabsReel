// Paused-frame WARM-UP for the WebGL preview's temporal effects (trails,
// denoise). The export runs lagfun / hqdn3d over every source frame from the
// clip's first one, so a paused frame there carries the whole trail. The live
// preview builds its history only from the frames it draws: after a seek, a
// jump back, skipped frames while playing or a reorder upstream, the paused
// frame would show no trail, or a wrong one.
//
// So once the playhead settles on such a frame, the source frames before it
// (back to the clip's first, or as far back as can still show: runtime.ts
// warmWindow, at most WARM_MAX_FRAMES) are decoded by the core (GET /frames,
// packages/core ffmpeg/frames.ts — far faster than seeking a <video> frame by
// frame) and run through the layer's own plan into a side history, which then
// replaces the layer's, and the frame is drawn again. Moving the playhead,
// changing the look or starting playback abandons a warm-up in progress.

import type { PlannedStep } from "./plan";
import { adoptHistory, dropHistory, historyGap, runLayer, type LayerJob } from "./runtime";

/** What a warm-up needs besides the paused frame's job. */
export interface WarmSource {
  /** The clip's media file (what the preview plays). */
  path: string;
  /** Its frame rate (the preview's source-frame clock). */
  srcFps: number;
  /** The clip's first source frame: the export's history starts there. */
  first: number;
}

interface Task {
  key: string;
  timer: ReturnType<typeof setTimeout> | null;
  ctrl: AbortController | null;
}

/** Quiet time after the last paused frame before a warm-up starts (a scrub warms only where it stops). */
const DEBOUNCE_MS = 180;
/** Most frame bytes one warm-up decodes and uploads (90 frames at 1280×720 is 332 MB). */
let warmMaxBytes = 360 << 20;

const tasks = new Map<string, Task>();
/** Per layer, the last key that failed or could only be warmed in part: not tried again until something changes. */
const settled = new Map<string, string>();
const keys = new WeakMap<readonly PlannedStep[], string>();
let framesUrl: ((path: string, q: Record<string, string | number>) => string) | null = null;
let repaint: (() => void) | null = null;

/** Install the core's /frames URL builder and the preview's repaint (null to stop). */
export function setWarmup(url: typeof framesUrl, onDone: (() => void) | null): void {
  framesUrl = url;
  repaint = onDone;
  if (!url) cancelWarmups();
}

/** Abandon every pending and running warm-up (playback started: the history builds as it plays). */
export function cancelWarmups(): void {
  for (const id of [...tasks.keys()]) cancel(id);
}

function cancel(layerId: string): void {
  const t = tasks.get(layerId);
  if (!t) return;
  if (t.timer) clearTimeout(t.timer);
  t.ctrl?.abort();
  tasks.delete(layerId);
}

/**
 * What a warm-up's result depends on: the steps up to the last temporal one
 * (their order and settings). By content — every project update re-plans the
 * look, and that alone must not restart a warm-up in flight.
 */
function lookKey(steps: readonly PlannedStep[]): string {
  let key = keys.get(steps);
  if (key === undefined) {
    key = steps.filter((s) => s.history).map((s) => `${s.id}<${s.histSig}>${s.histParams}`).join("#");
    keys.set(steps, key);
  }
  return key;
}

/**
 * Call after drawing a PAUSED video frame through runLayer(job): when the
 * layer's temporal steps lack frames the export has, schedule a warm-up
 * (debounced); when they don't, drop any warm-up for the layer.
 */
export function warmIfNeeded(job: LayerJob, src: WarmSource): void {
  const clock = job.srcFrame;
  if (clock === undefined || !framesUrl) return;
  const from = historyGap(job.layerId, job.steps, clock, src.first);
  if (from === null) {
    cancel(job.layerId);
    return;
  }
  const { pic, crop } = job;
  const key = [src.path, clock, from, job.w, job.h, pic.x, pic.y, pic.w, pic.h, crop.x, crop.y, crop.w, crop.h, lookKey(job.steps)].join("|");
  if (tasks.get(job.layerId)?.key === key || settled.get(job.layerId) === key) return;
  cancel(job.layerId);
  const task: Task = { key, timer: null, ctrl: null };
  task.timer = setTimeout(() => {
    task.timer = null;
    void run(job, src, from, task);
  }, DEBOUNCE_MS);
  tasks.set(job.layerId, task);
}

async function run(job: LayerJob, src: WarmSource, need: number, task: Task): Promise<void> {
  const layerId = job.layerId;
  const clock = job.srcFrame!;
  const pw = Math.max(1, Math.round(job.pic.w));
  const ph = Math.max(1, Math.round(job.pic.h));
  // At most warmMaxBytes of frames (a fixed-kernel look on a 4K canvas runs at 4K): the most recent ones.
  const from = Math.max(need, clock - Math.max(1, Math.floor(warmMaxBytes / (pw * ph * 4))));
  const count = clock - from;
  const c = job.crop;
  const url = framesUrl?.(src.path, {
    from, count, fps: src.srcFps, w: pw, h: ph,
    crop: [c.x, c.y, c.w, c.h].map((v) => Math.max(0, Math.round(v))).join(","),
  });
  if (!url) return;
  const ctrl = new AbortController();
  task.ctrl = ctrl;
  const live = () => tasks.get(layerId) === task;
  // The frames run under a side id, so the paused frame keeps drawing from the layer's own history meanwhile.
  const warmId = `${layerId}\u0001warm`;
  dropHistory(warmId);
  let f = from;
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const img = new ImageData(pw, ph);
    const size = pw * ph * 4;
    const base: LayerJob = { ...job, source: img, srcW: pw, srcH: ph, dynamic: true, crop: { x: 0, y: 0, w: pw, h: ph }, layerId: warmId };
    let filled = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!live()) return;
      for (let off = 0; off < value.length; ) {
        const n = Math.min(size - filled, value.length - off);
        img.data.set(value.subarray(off, off + n), filled);
        filled += n;
        off += n;
        if (filled < size) continue;
        filled = 0;
        if (!runLayer({ ...base, srcFrame: f, frame: job.frame - (clock - f) })) throw new Error("the GL pass failed");
        f++;
      }
    }
    if (!live()) return;
    if (f !== clock) throw new Error(`${f - from} of ${count} frames decoded`);
    adoptHistory(warmId, layerId);
    tasks.delete(layerId);
    if (from > need) settled.set(layerId, task.key); // in part: the frames before stay missing
    else settled.delete(layerId);
    repaint?.();
  } catch (err) {
    if (ctrl.signal.aborted || !live()) return;
    settled.set(layerId, task.key);
    tasks.delete(layerId);
    console.warn("[gl] trail / denoise warm-up failed:", err instanceof Error ? err.message : err);
  } finally {
    dropHistory(warmId);
  }
}

/**
 * Test hook (parity-gl): the layers with a warm-up pending or running and the
 * layers whose last key settled; `maxBytes` sets the byte cap, `reset` forgets
 * every settled key.
 */
export function warmupForTest(o: { maxBytes?: number; reset?: boolean } = {}): { pending: string[]; settled: string[] } {
  if (o.maxBytes !== undefined) warmMaxBytes = o.maxBytes;
  if (o.reset) settled.clear();
  return { pending: [...tasks.keys()], settled: [...settled.keys()] };
}
