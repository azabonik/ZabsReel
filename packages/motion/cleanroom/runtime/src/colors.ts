// interpolateColors() (SPEC section 5) and the colour parser behind it. Every colour is converted
// to non-premultiplied sRGB; interpolation happens there.

import type { EasingFunction } from "./easing";
import { describeValue, misuse } from "./errors";
import { checkInput, checkKeyframes, posterizeInput, readEasings, readPosterize, segmentAt } from "./ranges";

export interface InterpolateColorsOptions {
  easing?: EasingFunction | readonly EasingFunction[];
  posterize?: number;
}

/** Channels r, g, b on 0..255 (out-of-gamut values allowed until formatting), alpha 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = {
  aliceblue: "f0f8ff", antiquewhite: "faebd7", aqua: "00ffff", aquamarine: "7fffd4", azure: "f0ffff",
  beige: "f5f5dc", bisque: "ffe4c4", black: "000000", blanchedalmond: "ffebcd", blue: "0000ff",
  blueviolet: "8a2be2", brown: "a52a2a", burlywood: "deb887", cadetblue: "5f9ea0", chartreuse: "7fff00",
  chocolate: "d2691e", coral: "ff7f50", cornflowerblue: "6495ed", cornsilk: "fff8dc", crimson: "dc143c",
  cyan: "00ffff", darkblue: "00008b", darkcyan: "008b8b", darkgoldenrod: "b8860b", darkgray: "a9a9a9",
  darkgreen: "006400", darkgrey: "a9a9a9", darkkhaki: "bdb76b", darkmagenta: "8b008b", darkolivegreen: "556b2f",
  darkorange: "ff8c00", darkorchid: "9932cc", darkred: "8b0000", darksalmon: "e9967a", darkseagreen: "8fbc8f",
  darkslateblue: "483d8b", darkslategray: "2f4f4f", darkslategrey: "2f4f4f", darkturquoise: "00ced1",
  darkviolet: "9400d3", deeppink: "ff1493", deepskyblue: "00bfff", dimgray: "696969", dimgrey: "696969",
  dodgerblue: "1e90ff", firebrick: "b22222", floralwhite: "fffaf0", forestgreen: "228b22", fuchsia: "ff00ff",
  gainsboro: "dcdcdc", ghostwhite: "f8f8ff", gold: "ffd700", goldenrod: "daa520", gray: "808080",
  green: "008000", greenyellow: "adff2f", grey: "808080", honeydew: "f0fff0", hotpink: "ff69b4",
  indianred: "cd5c5c", indigo: "4b0082", ivory: "fffff0", khaki: "f0e68c", lavender: "e6e6fa",
  lavenderblush: "fff0f5", lawngreen: "7cfc00", lemonchiffon: "fffacd", lightblue: "add8e6", lightcoral: "f08080",
  lightcyan: "e0ffff", lightgoldenrodyellow: "fafad2", lightgray: "d3d3d3", lightgreen: "90ee90",
  lightgrey: "d3d3d3", lightpink: "ffb6c1", lightsalmon: "ffa07a", lightseagreen: "20b2aa",
  lightskyblue: "87cefa", lightslategray: "778899", lightslategrey: "778899", lightsteelblue: "b0c4de",
  lightyellow: "ffffe0", lime: "00ff00", limegreen: "32cd32", linen: "faf0e6", magenta: "ff00ff",
  maroon: "800000", mediumaquamarine: "66cdaa", mediumblue: "0000cd", mediumorchid: "ba55d3",
  mediumpurple: "9370db", mediumseagreen: "3cb371", mediumslateblue: "7b68ee", mediumspringgreen: "00fa9a",
  mediumturquoise: "48d1cc", mediumvioletred: "c71585", midnightblue: "191970", mintcream: "f5fffa",
  mistyrose: "ffe4e1", moccasin: "ffe4b5", navajowhite: "ffdead", navy: "000080", oldlace: "fdf5e6",
  olive: "808000", olivedrab: "6b8e23", orange: "ffa500", orangered: "ff4500", orchid: "da70d6",
  palegoldenrod: "eee8aa", palegreen: "98fb98", paleturquoise: "afeeee", palevioletred: "db7093",
  papayawhip: "ffefd5", peachpuff: "ffdab9", peru: "cd853f", pink: "ffc0cb", plum: "dda0dd",
  powderblue: "b0e0e6", purple: "800080", rebeccapurple: "663399", red: "ff0000", rosybrown: "bc8f8f",
  royalblue: "4169e1", saddlebrown: "8b4513", salmon: "fa8072", sandybrown: "f4a460", seagreen: "2e8b57",
  seashell: "fff5ee", sienna: "a0522d", silver: "c0c0c0", skyblue: "87ceeb", slateblue: "6a5acd",
  slategray: "708090", slategrey: "708090", snow: "fffafa", springgreen: "00ff7f", steelblue: "4682b4",
  tan: "d2b48c", teal: "008080", thistle: "d8bfd8", tomato: "ff6347", turquoise: "40e0d0", violet: "ee82ee",
  wheat: "f5deb3", white: "ffffff", whitesmoke: "f5f5f5", yellow: "ffff00", yellowgreen: "9acd32",
};

function fromHex(hex: string): Rgba | null {
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  let digits = hex;
  if (hex.length === 3 || hex.length === 4) digits = [...hex].map((c) => c + c).join("");
  if (digits.length !== 6 && digits.length !== 8) return null;
  const n = (i: number) => parseInt(digits.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: digits.length === 8 ? n(6) / 255 : 1 };
}

interface Arg {
  value: number;
  percent: boolean;
  /** Angle unit, for hues. */
  unit: string;
}

const ARG = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg|rad|grad|turn)?$/i;

function parseArg(text: string): Arg | null {
  if (text.toLowerCase() === "none") return { value: 0, percent: false, unit: "" };
  const m = ARG.exec(text);
  if (!m) return null;
  const unit = (m[2] ?? "").toLowerCase();
  return { value: Number(m[1]), percent: unit === "%", unit: unit === "%" ? "" : unit };
}

function hueDegrees(arg: Arg): number {
  if (arg.percent) return NaN;
  switch (arg.unit) {
    case "rad":
      return (arg.value * 180) / Math.PI;
    case "grad":
      return arg.value * 0.9;
    case "turn":
      return arg.value * 360;
    default:
      return arg.value;
  }
}

/** A number, or a percentage of `full`. */
function scaled(arg: Arg, full: number): number {
  if (arg.unit !== "") return NaN;
  return arg.percent ? (arg.value / 100) * full : arg.value;
}

function alphaOf(arg: Arg | undefined): number {
  if (!arg) return 1;
  return Math.min(1, Math.max(0, scaled(arg, 1)));
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const chroma = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    return l - chroma * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

function hwbToRgb(h: number, w: number, b: number): [number, number, number] {
  if (w + b >= 1) {
    const gray = w / (w + b);
    return [gray, gray, gray];
  }
  return hslToRgb(h, 1, 0.5).map((c) => c * (1 - w - b) + w) as [number, number, number];
}

function encodeSrgb(linear: number): number {
  const a = Math.abs(linear);
  const v = a <= 0.0031308 ? 12.92 * a : 1.055 * a ** (1 / 2.4) - 0.055;
  return Math.sign(linear) * v;
}

function multiply(m: readonly number[][], v: readonly number[]): [number, number, number] {
  return [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]) as [number, number, number];
}

// CSS Color 4 conversion matrices.
const D50_TO_D65 = [
  [0.9554734527042182, -0.023098536874261423, 0.0632593086610217],
  [-0.028369706963208136, 1.0099954580058226, 0.021041398966943008],
  [0.012314001688319899, -0.020507696433477912, 1.3303659366080753],
];
const XYZ_D65_TO_LINEAR_SRGB = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];
const D50_WHITE = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];

function labToRgb(l: number, a: number, b: number): [number, number, number] {
  const kappa = 24389 / 27;
  const epsilon = 216 / 24389;
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const x = fx ** 3 > epsilon ? fx ** 3 : (116 * fx - 16) / kappa;
  const y = l > kappa * epsilon ? fy ** 3 : l / kappa;
  const z = fz ** 3 > epsilon ? fz ** 3 : (116 * fz - 16) / kappa;
  const d65 = multiply(D50_TO_D65, [x * D50_WHITE[0], y * D50_WHITE[1], z * D50_WHITE[2]]);
  return multiply(XYZ_D65_TO_LINEAR_SRGB, d65).map(encodeSrgb) as [number, number, number];
}

function oklabToRgb(l: number, a: number, b: number): [number, number, number] {
  const lp = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mp = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sp = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp,
    -1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp,
    -0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp,
  ].map(encodeSrgb) as [number, number, number];
}

function polar(chroma: number, hue: number): [number, number] {
  const rad = (hue * Math.PI) / 180;
  return [chroma * Math.cos(rad), chroma * Math.sin(rad)];
}

function fromUnit([r, g, b]: [number, number, number], a: number): Rgba {
  return { r: r * 255, g: g * 255, b: b * 255, a };
}

/** Splits a function's arguments, in comma syntax or space syntax with an optional "/ alpha". */
function splitArgs(body: string): { main: string[]; alpha: string | undefined } | null {
  const text = body.trim();
  if (text.includes(",")) {
    const parts = text.split(",").map((p) => p.trim());
    if (parts.length < 3 || parts.length > 4 || parts.some((p) => p === "")) return null;
    return { main: parts.slice(0, 3), alpha: parts[3] };
  }
  const [mainText, alphaText, extra] = text.split("/");
  if (extra !== undefined) return null;
  const main = mainText.trim().split(/\s+/);
  if (main.length === 4 && alphaText === undefined) return { main: main.slice(0, 3), alpha: main[3] };
  if (main.length !== 3) return null;
  const alpha = alphaText?.trim();
  if (alpha === "") return null;
  return { main, alpha };
}

function fromFunction(name: string, body: string): Rgba | null {
  const split = splitArgs(body);
  if (!split) return null;
  const args = split.main.map(parseArg);
  if (args.some((a) => a === null)) return null;
  const [p, q, r] = args as Arg[];
  let alphaArg: Arg | undefined;
  if (split.alpha !== undefined) {
    const parsed = parseArg(split.alpha);
    if (!parsed) return null;
    alphaArg = parsed;
  }
  const alpha = alphaOf(alphaArg);
  let rgba: Rgba;
  switch (name) {
    case "rgb":
    case "rgba":
      rgba = { r: scaled(p, 255), g: scaled(q, 255), b: scaled(r, 255), a: alpha };
      break;
    case "hsl":
    case "hsla":
      rgba = fromUnit(hslToRgb(hueDegrees(p), scaled(q, 100) / 100, scaled(r, 100) / 100), alpha);
      break;
    case "hwb":
      rgba = fromUnit(hwbToRgb(hueDegrees(p), scaled(q, 100) / 100, scaled(r, 100) / 100), alpha);
      break;
    case "lab":
      rgba = fromUnit(labToRgb(scaled(p, 100), scaled(q, 125), scaled(r, 125)), alpha);
      break;
    case "lch": {
      const [a, b] = polar(scaled(q, 150), hueDegrees(r));
      rgba = fromUnit(labToRgb(scaled(p, 100), a, b), alpha);
      break;
    }
    case "oklab":
      rgba = fromUnit(oklabToRgb(scaled(p, 1), scaled(q, 0.4), scaled(r, 0.4)), alpha);
      break;
    case "oklch": {
      const [a, b] = polar(scaled(q, 0.4), hueDegrees(r));
      rgba = fromUnit(oklabToRgb(scaled(p, 1), a, b), alpha);
      break;
    }
    default:
      return null;
  }
  if ([rgba.r, rgba.g, rgba.b, rgba.a].some((c) => !Number.isFinite(c))) return null;
  return rgba;
}

/** Parses a CSS colour, or returns null if this parser does not understand it. */
export function parseColor(text: string): Rgba | null {
  const value = text.trim().toLowerCase();
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (value in NAMED) return fromHex(NAMED[value]);
  if (value.startsWith("#")) return fromHex(value.slice(1));
  const m = /^([a-z]+)\((.*)\)$/s.exec(value);
  if (!m) return null;
  return fromFunction(m[1], m[2]);
}

function channel(v: number): number {
  return Math.round(Math.min(255, Math.max(0, v)));
}

export function formatRgba(c: Rgba): string {
  const alpha = Math.round(Math.min(1, Math.max(0, c.a)) * 1000) / 1000;
  return `rgba(${channel(c.r)}, ${channel(c.g)}, ${channel(c.b)}, ${alpha})`;
}

const WHERE = "interpolateColors()";

export function interpolateColors(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly string[],
  options?: InterpolateColorsOptions,
): string {
  const x0 = checkInput(input, WHERE);
  const xs = checkKeyframes(inputRange, outputRange, WHERE);
  const colors = (outputRange as readonly unknown[]).map((c) => {
    const parsed = typeof c === "string" ? parseColor(c) : null;
    if (!parsed) {
      throw misuse(
        `${WHERE}: ${describeValue(c)} is not a colour it understands. Use a CSS colour name, a hex colour, or rgb(), hsl(), hwb(), lab(), lch(), oklab() or oklch().`,
      );
    }
    return parsed;
  });
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    throw misuse(`${WHERE}: the options must be an object.`);
  }
  const easings = readEasings(options?.easing, xs.length - 1, WHERE);
  const step = readPosterize(options?.posterize, WHERE);
  if (xs.length === 1) return formatRgba(colors[0]);
  // There are no extrapolation options: inputs outside the range hold the end colours.
  const x = Math.min(xs[xs.length - 1], Math.max(xs[0], posterizeInput(x0, step)));
  const i = segmentAt(xs, x);
  const e = easings[i]((x - xs[i]) / (xs[i + 1] - xs[i]));
  const a = colors[i];
  const b = colors[i + 1];
  const mix = (p: number, q: number) => p + e * (q - p);
  return formatRgba({ r: mix(a.r, b.r), g: mix(a.g, b.g), b: mix(a.b, b.b), a: mix(a.a, b.a) });
}
