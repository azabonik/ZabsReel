// Coded errors. Every error the runtime raises carries one of these codes.

export type GraphicErrorCode =
  | "graphic_api_unsupported"
  | "graphic_api_misuse"
  | "graphic_asset_unknown"
  | "graphic_asset_kind"
  | "graphic_media_ref"
  | "graphic_media_failed"
  | "graphic_media_time"
  | "graphic_media_per_frame"
  | "graphic_audio_cues_cap"
  | "graphic_font_cap"
  | "graphic_frame_timeout"
  | "graphic_render_cancelled";

export type GraphicError = Error & { code: GraphicErrorCode };

export function graphicError(code: GraphicErrorCode, message: string, cause?: unknown): GraphicError {
  const error = (cause === undefined ? new Error(message) : new Error(message, { cause })) as GraphicError;
  error.code = code;
  return error;
}

export function misuse(message: string): GraphicError {
  return graphicError("graphic_api_misuse", message);
}

/** True for Error objects, including ones made in another realm. */
export function isError(value: unknown): value is Error {
  return value instanceof Error || Object.prototype.toString.call(value) === "[object Error]";
}

/**
 * User code may throw anything. Errors pass through untouched; any other value is wrapped in a
 * plain Error (no code, since the problem is the user's, not the runtime's) that keeps the value
 * as its cause.
 */
export function toError(value: unknown): Error {
  if (isError(value)) return value;
  return new Error(`The graphic threw a value that is not an Error: ${describeValue(value)}`, {
    cause: value,
  });
}

/** Short, single-line description of a value for error messages. */
export function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "function") return "a function";
  if (typeof value === "symbol") return value.toString();
  if (value === undefined) return "undefined";
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** The fixed message for names the module object does not provide (BRIEF section 5). */
export function unsupportedNameMessage(name: string): string {
  return `${name} is not available in ZabsReel's built-in graphics renderer. Use the names listed in the graphics guide, or choose the Remotion add-on as the graphics renderer in Help → Graphics add-on….`;
}
