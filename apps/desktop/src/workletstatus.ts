// Whether the live preview can run the voice AudioWorklet (pitch / chipmunk /
// deep / robot). No DOM — audiofx.ts (the compositor's plans) and the
// inspector read it; audiograph.ts sets it when it loads the module.
//
//   unknown  not tried yet (no user gesture yet): counted as available, so the
//            inspector doesn't flash "Render exact" before the first click
//   loading  addModule in flight (available; chains play dry until ready)
//   ready    loaded into the preview's AudioContext
//   failed   no AudioWorklet here (an insecure http:// origin, an old engine)
//            or the module failed to load: pitch and robot are render-only

export type VoiceWorkletState = "unknown" | "loading" | "ready" | "failed";

/** AudioWorklet exists in this environment (secure context + the API). */
function supported(): boolean {
  const g = globalThis as { AudioWorkletNode?: unknown; isSecureContext?: boolean };
  return typeof g.AudioWorkletNode === "function" && g.isSecureContext !== false;
}

let state: VoiceWorkletState = supported() ? "unknown" : "failed";
const listeners = new Set<() => void>();

export function voiceWorkletState(): VoiceWorkletState {
  return state;
}

/** Can the preview play worklet effects (now, or once it has loaded)? */
export function voiceWorkletAvailable(): boolean {
  return state !== "failed";
}

export function setVoiceWorkletState(next: VoiceWorkletState): void {
  if (next === state) return;
  state = next;
  for (const f of listeners) f();
}

/** useSyncExternalStore-style subscription; returns the unsubscribe. */
export function subscribeVoiceWorklet(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}
