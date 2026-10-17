// interpolate() (SPEC section 4).

import { Easing, hasTail } from "./easing";
import type { EasingFunction } from "./easing";
import { describeValue, misuse } from "./errors";
import { checkInput, checkKeyframes, posterizeInput, readEasings, readPosterize, segmentAt } from "./ranges";

export type ExtrapolateType = "extend" | "clamp" | "wrap" | "identity";
export type InterpolateOutputType = "font-weight" | "scale" | "translate" | "rotate" | "transform-origin";
export type InterpolateOutput = "linear" | "perceptual-scale";

export interface InterpolateOptions {
  extrapolateLeft?: ExtrapolateType;
  extrapolateRight?: ExtrapolateType;
  easing?: EasingFunction | readonly EasingFunction[];
  output?: InterpolateOutput;
  outputType?: InterpolateOutputType;
  posterize?: number;
}

const WHERE = "interpolate()";
const EXTRAPOLATE: readonly ExtrapolateType[] = ["extend", "clamp", "wrap", "identity"];
const OUTPUT_TYPES: readonly InterpolateOutputType[] = ["font-weight", "scale", "translate", "rotate", "transform-origin"];

interface Settings {
  left: ExtrapolateType;
  right: ExtrapolateType;
  easings: EasingFunction[];
  perceptual: boolean;
  outputType: InterpolateOutputType | undefined;
  posterize: number | null;
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T, name: string): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw misuse(`${WHERE}: ${name} must be one of ${allowed.map((a) => `"${a}"`).join(", ")}, but got ${describeValue(value)}.`);
  }
  return value as T;
}

function readSettings(options: unknown, segments: number): Settings {
  if (options === undefined || options === null) options = {};
  if (typeof options !== "object") throw misuse(`${WHERE}: the options must be an object.`);
  const o = options as Record<string, unknown>;
  const output = pick(o.output, ["linear", "perceptual-scale"] as const, "linear", "output");
  return {
    left: pick(o.extrapolateLeft, EXTRAPOLATE, "extend", "extrapolateLeft"),
    right: pick(o.extrapolateRight, EXTRAPOLATE, "extend", "extrapolateRight"),
    easings: readEasings(o.easing, segments, WHERE),
    perceptual: output === "perceptual-scale",
    outputType: o.outputType === undefined ? undefined : pick(o.outputType, OUTPUT_TYPES, "scale", "outputType"),
    posterize: readPosterize(o.posterize, WHERE),
  };
}

// ---- How the output range is interpolated. ----

interface NumericPlan {
  kind: "numeric";
  /** Each keyframe as a vector of numbers. */
  points: number[][];
  finish(vector: number[]): unknown;
  /** Whether output: "perceptual-scale" may apply. */
  scaleLike: boolean;
  /** Plain number outputs, the only ones extrapolate "identity" works with. */
  plain: boolean;
}

interface DiscretePlan {
  kind: "discrete";
  values: readonly unknown[];
}

type Plan = NumericPlan | DiscretePlan;

function requireStep1(s: Settings, what: string): void {
  if (!s.easings.every((e) => e === Easing.step1)) {
    throw misuse(
      `${WHERE}: ${what} cannot blend between keyframes, so every segment needs easing: Easing.step1 (each keyframe's value then holds until the next keyframe).`,
    );
  }
}

const LENGTH_UNITS = new Set([
  "px", "%", "em", "rem", "ex", "ch", "vw", "vh", "vmin", "vmax", "svw", "svh", "lvw", "lvh", "dvw", "dvh",
  "cqw", "cqh", "cqi", "cqb", "cqmin", "cqmax", "cm", "mm", "q", "in", "pt", "pc",
]);
const ANGLE_UNITS = new Set(["deg", "rad", "grad", "turn"]);
const X_KEYWORDS: Record<string, number> = { left: 0, center: 50, right: 100 };
const Y_KEYWORDS: Record<string, number> = { top: 0, center: 50, bottom: 100 };
const NUMBER_WITH_UNIT = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/i;

type CssType = "scale" | "translate" | "rotate" | "transform-origin";

interface Component {
  value: number;
  /** null for a bare 0 that takes the unit the other keyframes use. */
  unit: string | null;
}

function parseNumber(text: string): { value: number; unit: string } | null {
  const m = NUMBER_WITH_UNIT.exec(text);
  if (!m) return null;
  return { value: Number(m[1]), unit: m[2].toLowerCase() };
}

function splitParts(value: string): string[] {
  const parts = value.trim().split(/\s+/);
  if (parts[0] === "" || parts.length > 3) {
    throw misuse(`${WHERE}: ${JSON.stringify(value)} must have one to three space-separated components.`);
  }
  return parts;
}

function isKeyword(part: string): boolean {
  const p = part.toLowerCase();
  return p in X_KEYWORDS || p in Y_KEYWORDS;
}

/** The CSS value types one keyframe string could be. */
function typesOf(value: string): Set<CssType> {
  const parts = splitParts(value);
  const out = new Set<CssType>();
  const nums = parts.map(parseNumber);
  const bareZero = (i: number) => nums[i] !== null && nums[i]!.value === 0 && nums[i]!.unit === "";
  if (nums.every((n) => n !== null && n.unit === "")) out.add("scale");
  if (nums.every((n, i) => n !== null && (LENGTH_UNITS.has(n.unit) || bareZero(i)))) out.add("translate");
  if (nums.every((n, i) => n !== null && (ANGLE_UNITS.has(n.unit) || bareZero(i)))) out.add("rotate");
  const originOk = parts.every((part, i) => {
    if (i < 2 && isKeyword(part)) return true;
    const n = nums[i];
    if (n === null) return false;
    if (i === 2) return (LENGTH_UNITS.has(n.unit) && n.unit !== "%") || bareZero(i);
    return LENGTH_UNITS.has(n.unit) || bareZero(i);
  });
  if (originOk) out.add("transform-origin");
  return out;
}

const CSS_TYPE_PREFERENCE: readonly CssType[] = ["scale", "translate", "rotate", "transform-origin"];

/** The first type, in preference order, that every keyframe can be. */
function detectCssType(values: readonly string[]): CssType | null {
  const perValue = values.map(typesOf);
  return CSS_TYPE_PREFERENCE.find((t) => perValue.every((types) => types.has(t))) ?? null;
}

function lengthComponent(part: string, allowPercent: boolean, value: string): Component {
  const n = parseNumber(part);
  if (n && n.value === 0 && n.unit === "") return { value: 0, unit: null };
  if (!n || !LENGTH_UNITS.has(n.unit) || (!allowPercent && n.unit === "%")) {
    throw misuse(`${WHERE}: ${JSON.stringify(value)} has the component ${JSON.stringify(part)}, which is not a valid length here.`);
  }
  return { value: n.value, unit: n.unit };
}

function parseOrigin(value: string): Component[] {
  const parts = splitParts(value);
  const lower = parts.map((p) => p.toLowerCase());
  const bad = () => misuse(`${WHERE}: ${JSON.stringify(value)} is not a valid transform-origin value.`);
  if (parts.length === 1) {
    const p = lower[0];
    if (p === "top" || p === "bottom") return [{ value: 50, unit: "%" }, { value: Y_KEYWORDS[p], unit: "%" }];
    if (p in X_KEYWORDS) return [{ value: X_KEYWORDS[p], unit: "%" }, { value: 50, unit: "%" }];
    return [lengthComponent(parts[0], true, value), { value: 50, unit: "%" }];
  }
  let [a, b] = [parts[0], parts[1]];
  let [la, lb] = [lower[0], lower[1]];
  // "top left" is the same as "left top": a vertical keyword first, or a horizontal one second.
  if (la === "top" || la === "bottom" || lb === "left" || lb === "right") {
    [a, b] = [b, a];
    [la, lb] = [lb, la];
  }
  let x: Component;
  if (isKeyword(a)) {
    if (!(la in X_KEYWORDS)) throw bad();
    x = { value: X_KEYWORDS[la], unit: "%" };
  } else x = lengthComponent(a, true, value);
  let y: Component;
  if (isKeyword(b)) {
    if (!(lb in Y_KEYWORDS)) throw bad();
    y = { value: Y_KEYWORDS[lb], unit: "%" };
  } else y = lengthComponent(b, true, value);
  const out = [x, y];
  if (parts.length === 3) out.push(lengthComponent(parts[2], false, value));
  return out;
}

function parseComponents(value: string, type: CssType): Component[] {
  if (type === "transform-origin") return parseOrigin(value);
  return splitParts(value).map((part) => {
    const n = parseNumber(part);
    if (n && type !== "scale" && n.value === 0 && n.unit === "") return { value: 0, unit: null };
    const ok =
      n !== null &&
      (type === "scale" ? n.unit === "" : type === "rotate" ? ANGLE_UNITS.has(n.unit) : LENGTH_UNITS.has(n.unit));
    if (!ok) {
      const wanted =
        type === "scale" ? "unitless numbers" : type === "rotate" ? "angles (deg, rad, grad or turn)" : "lengths or percentages";
      throw misuse(`${WHERE}: ${JSON.stringify(value)} is not a valid ${type} value; its components must be ${wanted}.`);
    }
    return { value: n!.value, unit: n!.unit };
  });
}

const DEFAULT_UNIT: Record<CssType, string> = { scale: "", translate: "px", rotate: "deg", "transform-origin": "px" };

function formatNumber(x: number): string {
  const r = Math.round(x * 1e6) / 1e6;
  return String(r === 0 ? 0 : r);
}

function cssPlan(values: readonly string[], type: CssType): NumericPlan {
  const parsed = values.map((v) => parseComponents(v, type));
  const count = Math.max(...parsed.map((c) => c.length));
  const units: string[] = [];
  for (let j = 0; j < count; j++) {
    const seen = new Set(parsed.map((c) => c[j]?.unit).filter((u): u is string => typeof u === "string"));
    // A missing transform-origin x or y would default to 50%, which fixes that unit.
    if (type === "transform-origin" && j < 2 && parsed.some((c) => c[j] === undefined)) seen.add("%");
    if (seen.size > 1) {
      throw misuse(
        `${WHERE}: component ${j + 1} uses different units across keyframes (${[...seen].join(", ")}); use the same unit in every keyframe.`,
      );
    }
    units.push(seen.size === 1 ? [...seen][0] : DEFAULT_UNIT[type]);
  }
  const fallback = (j: number) => (type === "scale" ? 1 : type === "transform-origin" && j < 2 ? 50 : 0);
  const points = parsed.map((comps) => Array.from({ length: count }, (_, j) => (comps[j] ? comps[j].value : fallback(j))));
  return {
    kind: "numeric",
    points,
    scaleLike: type === "scale",
    plain: false,
    finish: (vector) => vector.map((v, j) => `${formatNumber(v)}${units[j]}`).join(" "),
  };
}

const FONT_WEIGHT_KEYWORDS: Record<string, number> = { normal: 400, bold: 700 };

function fontWeight(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const key = value.trim().toLowerCase();
    if (key in FONT_WEIGHT_KEYWORDS) return FONT_WEIGHT_KEYWORDS[key];
    const n = parseNumber(key);
    if (n && n.unit === "") return n.value;
  }
  throw misuse(`${WHERE}: ${describeValue(value)} is not a font weight; use a number such as 400, or "normal" or "bold".`);
}

function makePlan(values: readonly unknown[], s: Settings): Plan {
  const { outputType } = s;
  if (outputType === "font-weight") {
    return {
      kind: "numeric",
      points: values.map((v) => [fontWeight(v)]),
      scaleLike: false,
      plain: false,
      finish: (v) => v[0],
    };
  }
  if (values.every((v) => typeof v === "number")) {
    values.forEach((v) => {
      if (!Number.isFinite(v)) throw misuse(`${WHERE}: outputRange must hold finite numbers, but got ${String(v)}.`);
    });
    if (outputType !== undefined && outputType !== "scale") {
      throw misuse(`${WHERE}: outputType "${outputType}" needs strings with CSS units, such as "10px" or "45deg".`);
    }
    return { kind: "numeric", points: values.map((v) => [v as number]), scaleLike: true, plain: true, finish: (v) => v[0] };
  }
  if (values.every((v) => typeof v === "boolean")) {
    if (outputType !== undefined) throw misuse(`${WHERE}: outputType does not apply to boolean outputs.`);
    requireStep1(s, "Boolean outputs");
    return { kind: "discrete", values };
  }
  if (values.every((v) => Array.isArray(v))) {
    const tuples = values as readonly unknown[][];
    const size = tuples[0].length;
    if (size === 0 || tuples.some((t) => t.length !== size)) {
      throw misuse(`${WHERE}: numeric tuples must all have the same, non-zero length.`);
    }
    if (tuples.some((t) => t.some((n) => typeof n !== "number" || !Number.isFinite(n)))) {
      throw misuse(`${WHERE}: numeric tuples must hold only finite numbers.`);
    }
    if (outputType !== undefined) throw misuse(`${WHERE}: outputType does not apply to numeric tuples.`);
    return {
      kind: "numeric",
      points: tuples.map((t) => [...(t as number[])]),
      scaleLike: true,
      plain: false,
      finish: (v) => v.slice(),
    };
  }
  if (values.every((v) => typeof v === "string")) {
    const strings = values as readonly string[];
    if (outputType !== undefined) return cssPlan(strings, outputType);
    if (s.easings.every((e) => e === Easing.step1)) return { kind: "discrete", values };
    const type = detectCssType(strings);
    if (type === null) {
      throw misuse(
        `${WHERE}: the strings ${describeValue(values)} are not CSS transform values of one kind. For strings that switch at each keyframe, pass easing: Easing.step1; for colours, use interpolateColors().`,
      );
    }
    return cssPlan(strings, type);
  }
  throw misuse(`${WHERE}: outputRange must hold only numbers, only strings, only booleans, or only numeric tuples.`);
}

function singleValue(value: unknown, s: Settings): unknown {
  if (s.outputType === "font-weight") return fontWeight(value);
  if (Array.isArray(value)) return value.slice();
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  throw misuse(`${WHERE}: outputRange must hold numbers, strings, booleans or numeric tuples, but got ${describeValue(value)}.`);
}

const toScaleSpace = (v: number) => Math.sign(v) * v * v;
const fromScaleSpace = (a: number) => Math.sign(a) * Math.sqrt(Math.abs(a));

export function interpolate(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly string[],
  options: InterpolateOptions & { outputType: "font-weight" },
): number;
export function interpolate(input: number, inputRange: readonly number[], outputRange: readonly number[], options?: InterpolateOptions): number;
export function interpolate(input: number, inputRange: readonly number[], outputRange: readonly string[], options?: InterpolateOptions): string;
export function interpolate(input: number, inputRange: readonly number[], outputRange: readonly boolean[], options?: InterpolateOptions): boolean;
export function interpolate(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly (readonly number[])[],
  options?: InterpolateOptions,
): number[];
export function interpolate(input: number, inputRange: readonly number[], outputRange: readonly unknown[], options?: InterpolateOptions): unknown {
  const x0 = checkInput(input, WHERE);
  const xs = checkKeyframes(inputRange, outputRange, WHERE);
  const s = readSettings(options, xs.length - 1);
  if (xs.length === 1) return singleValue(outputRange[0], s);
  const plan = makePlan(outputRange, s);
  if (s.perceptual && (plan.kind === "discrete" || !plan.scaleLike)) {
    throw misuse(`${WHERE}: output: "perceptual-scale" only works with numbers, numeric tuples and scale values.`);
  }
  if ((s.left === "identity" || s.right === "identity") && (plan.kind === "discrete" || !plan.plain)) {
    throw misuse(`${WHERE}: extrapolate "identity" returns the input number, so it only works with plain number outputs.`);
  }

  let x = posterizeInput(x0, s.posterize);
  const first = xs[0];
  const last = xs[xs.length - 1];
  const side = x < first ? s.left : x > last ? s.right : null;
  if (side === "identity") return x;
  if (side === "clamp") x = x < first ? first : last;
  if (side === "wrap") {
    const span = last - first;
    let offset = (x - first) - span * Math.floor((x - first) / span);
    if (offset >= span) offset = 0;
    x = first + offset;
  }

  const i = segmentAt(xs, x);
  const progress = (at: number, seg: number) => (at - xs[seg]) / (xs[seg + 1] - xs[seg]);
  const eased = s.easings[i](progress(x, i));
  if (plan.kind === "discrete") return plan.values[eased >= 1 ? i + 1 : i];

  const points = s.perceptual ? plan.points.map((p) => p.map(toScaleSpace)) : plan.points;
  const a = points[i];
  const b = points[i + 1];
  const vector = a.map((v, k) => v + eased * (b[k] - v));
  // Springs with allowTail keep moving after their own segment ends.
  for (let j = 0; j < i; j++) {
    const easing = s.easings[j];
    if (!hasTail(easing)) continue;
    const rest = easing(progress(x, j)) - 1;
    for (let k = 0; k < vector.length; k++) vector[k] += rest * (points[j + 1][k] - points[j][k]);
  }
  return plan.finish(s.perceptual ? vector.map(fromScaleSpace) : vector);
}
