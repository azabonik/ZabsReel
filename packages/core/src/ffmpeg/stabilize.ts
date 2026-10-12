/**
 * Stabilization options → the two vidstab filter strings (pass 1 detect, pass 2
 * transform). Pure, so the mapping can be checked without running FFmpeg.
 * Option names and ranges match FFmpeg 4.4's vidstabdetect / vidstabtransform.
 */

export interface StabilizeOptions {
  /** How shaky / fast the camera is, 1..10 (vidstabdetect shakiness). Default 6. */
  shakiness?: number;
  /** Detection accuracy 1..15 (vidstabdetect accuracy). Default 15. vidstab raises it to ≥ shakiness/2. */
  accuracy?: number;
  /** Camera-path smoothing window in frames, 1..100 (vidstabtransform smoothing). Default 30. */
  smoothing?: number;
  /**
   * "auto" (default) = optimal static zoom that hides the borders — what
   * stabilize_clip always did before it took options; "none" = no zoom (the
   * moving borders show); a number = fixed zoom percent.
   */
  zoom?: "none" | "auto" | number;
  /** How the moving borders are filled: "keep" (from nearby frames, default) or "black". */
  crop?: "keep" | "black";
}

export const STABILIZE_DEFAULTS = { shakiness: 6, accuracy: 15, smoothing: 30, zoom: "auto", crop: "keep" } as const;

const clampInt = (n: number | undefined, lo: number, hi: number, def: number): number =>
  Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n as number))) : def;

/** The vidstabdetect options (without `result=`) and the vidstabtransform options (without `input=`). */
export function stabilizeFilters(opts: StabilizeOptions = {}): { detect: string; transform: string } {
  const shakiness = clampInt(opts.shakiness, 1, 10, STABILIZE_DEFAULTS.shakiness);
  // vidstab itself raises accuracy below shakiness/2 (with a log line); do it
  // here so the filter string says what actually runs.
  const accuracy = Math.max(clampInt(opts.accuracy, 1, 15, STABILIZE_DEFAULTS.accuracy), Math.ceil(shakiness / 2));
  const smoothing = clampInt(opts.smoothing, 1, 100, STABILIZE_DEFAULTS.smoothing);
  const zoom = opts.zoom ?? STABILIZE_DEFAULTS.zoom;
  // optzoom defaults to 1 (auto) in vidstabtransform, so "none" and a fixed
  // percent must switch it off explicitly. The no-option default is exactly the
  // old fixed `smoothing=30:zoom=0` (optzoom 1, crop keep).
  const zoomOpts =
    zoom === "auto"
      ? "optzoom=1"
      : `optzoom=0:zoom=${typeof zoom === "number" && Number.isFinite(zoom) ? Math.max(-100, Math.min(100, zoom)) : 0}`;
  const crop = opts.crop === "black" ? "black" : "keep";
  return {
    detect: `vidstabdetect=shakiness=${shakiness}:accuracy=${accuracy}`,
    transform: `smoothing=${smoothing}:${zoomOpts}:crop=${crop}`,
  };
}
