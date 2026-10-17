// The crop props (cropLeft, cropRight, cropTop, cropBottom) as a CSS clip-path.

import type React from "react";
import { misuse } from "./errors";

export interface CropProps {
  cropLeft?: number;
  cropRight?: number;
  cropTop?: number;
  cropBottom?: number;
}

export function hasCrop(props: CropProps): boolean {
  return (
    props.cropLeft !== undefined ||
    props.cropRight !== undefined ||
    props.cropTop !== undefined ||
    props.cropBottom !== undefined
  );
}

function ratio(value: unknown, where: string, name: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw misuse(`${where}: ${name} must be a number from 0 to 1 (the share of the size to cut away).`);
  }
  return Math.min(1, Math.max(0, value));
}

/** Two opposite crops that together exceed the whole size meet in the middle of their overlap. */
function settle(start: number, end: number): [number, number] {
  if (start + end <= 1) return [start, end];
  const meet = (start + (1 - end)) / 2;
  return [meet, 1 - meet];
}

function cssLength(value: unknown): string {
  return typeof value === "number" ? `${value}px` : String(value);
}

function isSingleValue(value: unknown): boolean {
  return typeof value === "number" || (typeof value === "string" && !/\s/.test(value.trim()));
}

/** Inline corner radii, for the `round` part of inset(). Radii from CSS classes are not seen. */
function roundPart(style: React.CSSProperties | undefined): string {
  if (!style) return "";
  const all = style.borderRadius;
  const corners = [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ];
  if (corners.every((c) => c === undefined)) return all === undefined ? "" : ` round ${cssLength(all)}`;
  const fallback = all !== undefined && isSingleValue(all) ? all : 0;
  return ` round ${corners.map((c) => cssLength(c ?? fallback)).join(" ")}`;
}

function percent(x: number): string {
  return `${Math.round(x * 1e6) / 1e4}%`;
}

/** The clip-path for the crop props, or undefined when nothing is cropped. */
export function cropClipPath(props: CropProps, style: React.CSSProperties | undefined, where: string): string | undefined {
  if (!hasCrop(props)) return undefined;
  const [left, right] = settle(ratio(props.cropLeft, where, "cropLeft"), ratio(props.cropRight, where, "cropRight"));
  const [top, bottom] = settle(ratio(props.cropTop, where, "cropTop"), ratio(props.cropBottom, where, "cropBottom"));
  if (left === 0 && right === 0 && top === 0 && bottom === 0) return undefined;
  return `inset(${percent(top)} ${percent(right)} ${percent(bottom)} ${percent(left)}${roundPart(style)})`;
}
