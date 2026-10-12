// The eyedropper's KEY BYPASS for the live preview. Keys (colorkey /
// chromakey / lumakey) preview through the WebGL2 effect pipeline (gl/,
// shaders in the effect registry); while the inspector's eyedropper is open,
// the clip being picked from previews UNKEYED, so you pick the real
// background colour instead of the track below. (The key shaders that lived
// here moved into the pipeline: packages/core effects/glsl.ts GLSL_KEY_*.)

let bypassClip: string | null = null;
const bypassListeners = new Set<() => void>();

export function setKeyBypass(clipId: string | null): void {
  if (bypassClip === clipId) return;
  bypassClip = clipId;
  bypassListeners.forEach((l) => l());
}

export function isKeyBypassed(clipId: string): boolean {
  return bypassClip === clipId;
}

export function onKeyBypassChange(listener: () => void): () => void {
  bypassListeners.add(listener);
  return () => {
    bypassListeners.delete(listener);
  };
}
