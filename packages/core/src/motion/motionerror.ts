/**
 * The named errors of ZedMix's own motion renderer (MOTION-PLAN D4's
 * table): rendermotion.ts and motionmedia.ts end a render with them, and
 * add_graphic reports their code.
 */

/**
 * The codes a graphic's failed frame carries from the page: the runtime's
 * (cleanroom/runtime/src/errors.ts; graphic_render_cancelled is the graphic's
 * own cancelRender(), not the job's abort, graphic_render_canceled), and
 * graphic_component_error for an error that has none (the component's own
 * throw). Any other code the page reports becomes graphic_component_error.
 */
export const GRAPHIC_CODES = [
  "graphic_api_unsupported",
  "graphic_api_misuse",
  "graphic_asset_unknown",
  "graphic_asset_kind",
  "graphic_media_ref",
  "graphic_media_failed",
  "graphic_media_time",
  "graphic_media_per_frame",
  "graphic_audio_cues_cap",
  "graphic_font_cap",
  "graphic_frame_timeout",
  "graphic_render_cancelled",
  "graphic_component_error",
] as const;
export type GraphicCode = (typeof GRAPHIC_CODES)[number];

export type MotionErrorCode =
  | "graphic_renderer_unavailable"
  | "graphic_frame_timeout"
  | "graphic_render_timeout"
  | "graphic_render_crashed"
  | "graphic_render_canceled"
  | "graphic_compile_error"
  | "graphic_media_decodes_cap"
  | "graphic_decode_timeout"
  | "graphic_mix_timeout"
  | GraphicCode;

/** A render that ended without a result; `code` is what add_graphic reports. */
export class MotionRenderError extends Error {
  constructor(
    readonly code: MotionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MotionRenderError";
  }
}
