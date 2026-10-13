// The processing scale each layer's look last ran at in the WebGL preview
// (k = processing pixels per export pixel), published by preview.tsx so the
// inspector can mark a fixed-kernel effect (registry EffectGL.kernel: sharpen,
// detail, edges, chromakey, denoise) "≈" while its layer is processed below the
// export's resolution — scaled playback on a software renderer, or a canvas
// larger than the GL size cap. A paused frame runs those layers at k = 1.

const scales = new Map<string, number>();
const listeners = new Set<() => void>();

/** Record the scale a layer ran at; listeners hear only real changes (play / pause, a resize). */
export function noteLayerScale(layerId: string, k: number): void {
  const prev = scales.get(layerId);
  if (prev !== undefined && Math.abs(prev - k) < 1e-3) return;
  scales.set(layerId, k);
  for (const l of listeners) l();
}

/** The scale the layer last ran at, or undefined when it hasn't run through WebGL. */
export function layerScale(layerId: string): number | undefined {
  return scales.get(layerId);
}

export function onLayerScaleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
