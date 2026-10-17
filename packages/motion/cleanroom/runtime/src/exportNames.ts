// The public names, in JavaScript's default sort order. Must match runtime/exports.json.

export const EXPORT_NAMES = [
  "AbsoluteFill",
  "Audio",
  "Easing",
  "Freeze",
  "Html5Audio",
  "Html5Video",
  "Img",
  "Loop",
  "OffthreadVideo",
  "Sequence",
  "Series",
  "Video",
  "asset",
  "cancelRender",
  "continueRender",
  "delayRender",
  "interpolate",
  "interpolateColors",
  "loadFont",
  "measureSpring",
  "random",
  "spring",
  "staticFile",
  "useCurrentFrame",
  "useDelayRender",
  "useVideoConfig",
] as const;

export type ExportName = (typeof EXPORT_NAMES)[number];
