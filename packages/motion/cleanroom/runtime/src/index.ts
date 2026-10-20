// The public API: exactly the names in runtime/exports.json, plus types.
//
// These exports do not depend on a host. The delay functions and loadFont below always throw:
// graphics get working, host-bound versions from the module object (createModuleObject) or
// from useDelayRender().

import { graphicError } from "./errors";
import type { DelayRenderOptions, LoadFontOptions, LoadFontResult } from "./session";

export { AbsoluteFill } from "./AbsoluteFill";
export { asset, staticFile } from "./assets";
export { Html5Audio, Html5Audio as Audio } from "./Audio";
export { interpolateColors } from "./colors";
export { Easing } from "./easing";
export { Freeze } from "./Freeze";
export { useCurrentFrame, useDelayRender, useVideoConfig } from "./hooks";
export { Img } from "./Img";
export { interpolate } from "./interpolate";
export { Loop } from "./Loop";
export { random } from "./random";
export { Sequence } from "./Sequence";
export { Series } from "./Series";
export { measureSpring, spring } from "./spring";
export { Html5Video, Html5Video as Video, OffthreadVideo } from "./Video";

export type { AbsoluteFillProps } from "./AbsoluteFill";
export type { AssetRef } from "./assets";
export type { Html5AudioProps, Html5AudioProps as AudioProps } from "./Audio";
export type { InterpolateColorsOptions } from "./colors";
export type { LoopInfo, UseDelayRenderResult } from "./context";
export type { CropProps } from "./crop";
export type { EasingFunction, EasingSpringConfig } from "./easing";
export type { GraphicError, GraphicErrorCode } from "./errors";
export type { FreezeProps } from "./Freeze";
export type { VideoConfig } from "./hooks";
export type { ImgProps, MediaSource } from "./Img";
export type { ExtrapolateType, InterpolateOptions, InterpolateOutput, InterpolateOutputType } from "./interpolate";
export type { LoopProps } from "./Loop";
export type { LoopVolumeCurveBehavior } from "./media";
export type { RandomSeed } from "./random";
export type { SequenceLayout, SequenceProps } from "./Sequence";
export type { SeriesProps, SeriesSequenceProps } from "./Series";
export type { DelayRenderOptions, LoadFontOptions, LoadFontResult } from "./session";
export type { MeasureSpringOptions, SpringConfig, SpringOptions } from "./spring";
export type {
  Html5VideoProps,
  Html5VideoProps as VideoProps,
  OffthreadVideoProps,
  VideoPropsBase,
} from "./Video";

/** Handle returned by delayRender(). */
export type DelayRenderHandle = number;

function needsHost(name: string): never {
  throw graphicError(
    "graphic_api_unsupported",
    `${name} only works inside a graphic that ZedMix renders: import it from "remotion" in the graphic's code, or use useDelayRender() in a component.`,
  );
}

export function delayRender(label?: string, options?: DelayRenderOptions): DelayRenderHandle {
  void label;
  void options;
  return needsHost("delayRender()");
}

export function continueRender(handle: DelayRenderHandle): void {
  void handle;
  needsHost("continueRender()");
}

export function cancelRender(reason: unknown): never {
  void reason;
  return needsHost("cancelRender()");
}

export function loadFont(ref: unknown, options?: LoadFontOptions): LoadFontResult {
  void ref;
  void options;
  return needsHost("loadFont()");
}
