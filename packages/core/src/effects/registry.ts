/**
 * The visual-effect REGISTRY: the single source of truth for every effect type
 * `apply_effect` accepts. One entry per type holds its label, category, the
 * one-line description the AI reads, the param schema (ranges + defaults), the
 * optional key colour, the FFmpeg filter builder, and how the live preview
 * shows it. Everything else is generated from here: the rpc enum, validation
 * and tool description, the export filtergraph (graph.ts), the CSS / WebGL /
 * canvas preview and the inspector's controls (apps/desktop).
 *
 * PURE on purpose — no `node:` imports, no engine imports, no runtime imports
 * (only ./glsl.ts, the shader source strings) — so the desktop renderer can
 * import it as `@aive/core/effects`.
 *
 * Stored effects keep the legacy shape `{ id, type, amount?, color?, params?,
 * enabled? }`: the primary strength stays under `amount`, every other param
 * lives in `params`. A param that is absent from a stored effect means "its
 * default", and every value is clamped to its range when the filter is built,
 * so old projects render exactly as before. (Vignette is the exception: the
 * old export ignored its amount, so loading a pre-v4 project drops it — see
 * migrateProject in engine.ts.)
 *
 * Adding an effect = one entry in EFFECT_TYPE_IDS + one in DEFS below.
 */

import {
  GLSL_BLUR_ANTI, GLSL_BLUR_CAUSAL, GLSL_CAS, GLSL_COLORHOLD, GLSL_DENOISE, GLSL_DESATURATE, GLSL_EDGE_DETECT,
  GLSL_EDGE_GAUSS, GLSL_EXPOSURE, GLSL_KEY_CHROMA, GLSL_KEY_COLOR, GLSL_KEY_LUMA, GLSL_LAGFUN, GLSL_LAGOUT, GLSL_LENS,
  GLSL_LUT256, GLSL_MIXER, GLSL_NEGATE, GLSL_NOISE, GLSL_PIXELATE, GLSL_RGBSHIFT, GLSL_SCREEN, GLSL_UNSHARP_H, GLSL_UNSHARP_V,
  GLSL_VIBRANCE, GLSL_VIGNETTE,
} from "./glsl.js";

export { GL_MAIN, GL_PRELUDE, GLSL_COPY } from "./glsl.js";

/** Every effect type, in a stable order (the rpc enum and the AI description follow it). */
export const EFFECT_TYPE_IDS = [
  "blur", "sharpen", "detail", "denoise", "sepia", "grayscale",
  "vignette", "edges", "posterize", "pixelate", "chromakey",
  "colorkey", "lumakey",
  "exposure", "vibrance", "invert", "colorhold",
  "grain", "glow", "rgbsplit", "lens", "trails",
] as const;
export type EffectType = (typeof EFFECT_TYPE_IDS)[number];

/** Inspector groups, in menu order. */
export const EFFECT_CATEGORIES = ["Blur & sharpen", "Repair", "Look", "Stylize", "Key"] as const;
export type EffectCategory = (typeof EFFECT_CATEGORIES)[number];

/** One numeric control. `key: "amount"` is the effect's primary strength (stored at the top level). */
export interface EffectParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
}

/** The key colour an effect takes. */
export interface EffectColorSpec {
  /** Default colour as "0xRRGGBB"; null = the effect stores no colour (only "auto" is accepted). */
  default: string | null;
  /** Whether color "auto" (sample the clip's frame border) is accepted. */
  auto: boolean;
  /** For an effect without a stored colour: the param that "auto" sets from the border brightness. */
  autoParam?: string;
}

/** How the live preview shows an effect. */
export interface EffectPreview {
  /**
   * CSS filter fragment (the 2D canvas `ctx.filter` colour proxy, used when
   * WebGL2 is unavailable). `scale` = preview pixels per canvas pixel (the
   * compositor buffer is capped at 1280 on the long edge), for effects
   * measured in canvas pixels such as blur.
   */
  css?: (e: EffectInput, scale: number) => string;
  /** How close the CSS proxy is to the FFmpeg export — shown to people and the AI as the effect's caveat. */
  note?: string;
  /** A key (multiplies alpha): previewed by its `gl` pass; nothing without WebGL2. */
  key?: true;
  /** Shown by a named 2D canvas pass in the no-WebGL2 fallback. */
  pass?: "vignette";
  /** The WebGL2 preview (apps/desktop/src/gl/): a port of the FFmpeg builder's filters. */
  gl?: EffectGL;
}

/**
 * How close an effect's live preview is to the FFmpeg export (measured by
 * apps/desktop/scripts/parity-gl.mts at 1:1): "exact" = within a few levels
 * of the same 8-bit math, "close" = same look with a known small difference,
 * "approx" = an approximation (the inspector marks it ≈).
 */
export type GLFidelity = "exact" | "close" | "approx";

/** What a GL uniform builder gets besides the effect. */
export interface GLUniformContext {
  /** Processing pixels per canvas (export) pixel — pixel-sized params scale by it. */
  k: number;
  /** Processing size of the layer's canvas-space frame (px). */
  w: number;
  h: number;
  /** Canvas (export) size (px). */
  cw: number;
  ch: number;
}

/** Uniform values by GLSL name; the renderer picks the setter from the declared type. */
export type GLUniforms = Record<string, number | readonly number[]>;

/** One fragment-shader pass. `frag` is a body from ./glsl.ts (see its header for the contract). */
export interface EffectGLPass {
  frag: string;
  /**
   * The colour domain the pass works in, mirroring the pixel format FFmpeg
   * negotiates for the filter: "rgb", "yuv" (BT.601 limited, yuv444p) or
   * "any" (keeps whatever the input is in, like a filter that takes both).
   */
  domain?: "rgb" | "yuv" | "any";
  /** Convert to RGB on write (the builder's trailing `format=rgba`). */
  out?: "rgb";
  /** Writes raw floats (an intermediate of a multi-pass filter). */
  float?: true;
  /** Reads the per-layer history (`hpx`) and becomes the new history (temporal effects). */
  history?: true;
  /**
   * A per-pixel op: the body defines `op_<name>(c, p, dom)` instead of `fx`,
   * and the renderer may fuse it into the pass before it.
   */
  point?: true;
  uniforms?: (e: EffectInput, g: GLUniformContext) => GLUniforms;
}

/** An effect's WebGL2 preview: pure data (shader bodies + uniform builders). */
export interface EffectGL {
  fidelity: GLFidelity;
  /** What differs from the export (shown with the effect in the inspector). */
  note: string;
  passes: readonly EffectGLPass[];
  /** Keeps state across frames (a per-layer history texture). */
  history?: true;
  /** False = the builder emits nothing for these params (skip the effect). Default: active. */
  active?: (e: EffectInput, g: GLUniformContext) => boolean;
}

/** The stored effect shape (structurally the same as types.ts VisualEffect, minus the id). */
export interface EffectInput {
  type: string;
  amount?: number;
  color?: string;
  params?: Record<string, number>;
  /** false = bypassed (skipped in export AND preview). Absent = on. */
  enabled?: boolean;
}

/** What a filter builder gets besides the effect. */
export interface FfmpegContext {
  /** Output canvas size (the effect runs on the canvas-space RGBA stream). */
  W: number;
  H: number;
  /** Unique within the whole filter_complex — prefix it for any sub-graph labels. */
  tag: string;
}

export interface EffectDef {
  type: EffectType;
  label: string;
  category: EffectCategory;
  /** One line for the AI (what it does and when to use it). */
  description: string;
  /** Ordered controls; the primary strength (if any) has key "amount". */
  params: EffectParam[];
  color?: EffectColorSpec;
  /** FFmpeg filter steps (joined with "," into the clip chain; may contain a `;` sub-graph). */
  ffmpeg: (e: EffectInput, ctx: FfmpegContext) => string[];
  /** Live preview (CSS / canvas fallback and/or WebGL2), or "export-only" (the UI shows a "Render exact" badge). */
  preview: EffectPreview | "export-only";
}

// ---- helpers ------------------------------------------------------------------

/** FFmpeg number formatting — the same 6-decimal form graph.ts uses everywhere. */
const num = (n: number): string => (Number.isFinite(n) ? n.toFixed(6) : "0");
const clampN = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
/** CSS number: at most 4 decimals, no trailing zeros. */
const fmtCss = (n: number): string => String(Math.round(n * 10000) / 10000);

/** A few colour names the AI tends to use for key colours; everything else must be hex. */
export const KEY_COLOR_NAMES: Readonly<Record<string, string>> = {
  green: "00FF00", blue: "0000FF", black: "000000", white: "FFFFFF", gray: "808080", grey: "808080", red: "FF0000",
};

/** Parse a key colour (0xRRGGBB / #RRGGBB / RRGGBB, optional alpha byte, or a basic name) to "0xRRGGBB", or null. */
export function parseKeyColor(c: string | undefined): string | null {
  const s = (c ?? "").trim().toLowerCase();
  const m = /^(?:0x|#)?([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s);
  if (m) return `0x${m[1].toUpperCase()}`;
  const named = KEY_COLOR_NAMES[s];
  return named ? `0x${named}` : null;
}

/**
 * Normalise a key colour to FFmpeg's "0xRRGGBB". Anything unparseable —
 * including a stray "auto" the engine didn't resolve — becomes `fallback`, so
 * the graph never breaks and preview and export agree on odd values.
 */
export function keyColorHex(c: string | undefined, fallback: string): string {
  return parseKeyColor(c) ?? fallback;
}

/**
 * Preview pixels per canvas pixel when the project is rendered into the
 * compositor buffer (long edge capped at 1280): the default for CSS proxies
 * of pixel-sized effects when the caller doesn't know the project size.
 */
export const PREVIEW_MAX_LONG_EDGE = 1280;
export const DEFAULT_PREVIEW_SCALE = PREVIEW_MAX_LONG_EDGE / 1920;
export function previewScaleFor(width: number, height: number): number {
  const long = Math.max(width, height);
  return long > PREVIEW_MAX_LONG_EDGE ? PREVIEW_MAX_LONG_EDGE / long : 1;
}

export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace(/^0x|^#/i, ""), 16) || 0;
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Which despill screen (if any) a key colour is: clearly green- or blue-dominant. */
export function spillScreen([r, g, b]: [number, number, number]): "green" | "blue" | null {
  if (g >= 80 && g - Math.max(r, b) >= 40) return "green";
  if (b >= 80 && b - Math.max(r, g) >= 40) return "blue";
  return null;
}

/** The stored (unclamped) value of a param: `amount` lives at the top level, the rest in `params`. */
function rawParam(e: EffectInput, key: string): number | undefined {
  const v = key === "amount" ? e.amount : e.params?.[key];
  return typeof v === "number" ? v : undefined;
}

/**
 * A param's effective value: the stored value (or the default when absent),
 * clamped to the param's range. `fallback` is returned for a param the effect
 * doesn't declare.
 */
export function paramValue(e: EffectInput, key: string, fallback = 0): number {
  const p = DEF_MAP.get(e.type)?.params.find((q) => q.key === key);
  if (!p) return fallback;
  return clampN(rawParam(e, key) ?? p.default, p.min, p.max);
}

/** Vignette lens angle (radians) for an effect: amount 1 = FFmpeg's default PI/5, clamped to the filter's [0, PI/2]. */
export function vignetteAngle(e: EffectInput): number {
  return clampN((paramValue(e, "amount", 1) * Math.PI) / 5, 0, Math.PI / 2);
}

/**
 * FFmpeg's vignette brightness factor at a normalised distance from the centre
 * (0 = centre, 1 = the canvas corner): cos(angle·d)⁴, 0 past the corner. The
 * preview draws the same curve, so preview and export darken alike.
 */
export function vignetteFactor(dnorm: number, angle: number): number {
  if (dnorm > 1) return 0;
  const c = Math.cos(angle * dnorm);
  return c * c * (c * c);
}

/**
 * Run a plain filter chain on the colour of an RGBA stream and put the ORIGINAL
 * alpha back. Several FFmpeg filters have no alpha-capable pixel format
 * (unsharp, hqdn3d, edgedetect, vignette, lagfun; noise also dirties alpha), so
 * on their own they turn transparent letterbox padding, keyed areas and
 * cutouts opaque. `steps` must be a linear chain (no `;` sub-graph); `tag` is a
 * label prefix, unique in the whole filter_complex. `alphaSteps` (optional)
 * runs on the extracted alpha plane too, for a temporal filter such as lagfun
 * whose trail should carry its own coverage. Returns ONE step (empty in, empty out).
 */
export function alphaSafe(steps: string[], tag: string, alphaSteps: string[] = [], premultiplied = false): string[] {
  if (steps.length === 0) return [];
  const [a, b, v, m] = [`${tag}a`, `${tag}b`, `${tag}v`, `${tag}m`];
  const alpha = ["alphaextract", ...alphaSteps].join(",");
  // premultiplied: the spatial / temporal step sees colour x alpha, so the RGB hidden
  // under alpha = 0 (a keyed-out screen, a cutout's old background) cannot bleed into
  // the visible subject. Colour is divided by the (lagged) alpha again at the end.
  const pre = premultiplied ? "premultiply=inplace=1," : "";
  const un = premultiplied ? "unpremultiply=inplace=1," : "";
  return [
    `format=rgba,split[${a}][${b}];[${a}]${pre}${steps.join(",")}[${v}];[${b}]${alpha}[${m}];[${v}][${m}]alphamerge,${un}format=rgba`,
  ];
}

/**
 * Exposure's black point, kept below 2^-EV. FFmpeg computes (in - black) / (2^-EV - black),
 * so a black at or above 2^-EV divides by zero (all black) or by a negative number (inverted).
 */
export function exposureBlack(e: EffectInput): number {
  return Math.min(paramValue(e, "black"), 2 ** -paramValue(e, "amount") - 0.05);
}

/**
 * One key (colorkey / chromakey / lumakey) as a self-contained sub-graph step.
 * FFmpeg's keyers REWRITE alpha — colorkey/chromakey set it on every pixel,
 * lumakey inside its band — which would turn the transparent letterbox padding
 * (or a source's own alpha) opaque again. So the key runs on a split copy and
 * its alpha is MULTIPLIED into the original's (blend's c3 = the alpha plane).
 * The colour comes from the untouched original, or from the keyed copy when it
 * was despilled. `label` must be unique in the whole filter_complex.
 */
function keyStep(f: EffectInput, label: string): string {
  let key: string;
  let keyedColour = false;
  const p = (k: string) => num(paramValue(f, k));
  if (f.type === "lumakey") {
    // Reset alpha first: lumakey leaves out-of-band alpha alone, and multiplying
    // the original alpha in twice would darken semi-transparent sources.
    key = `lutrgb=a=maxval,lumakey=threshold=${p("threshold")}:tolerance=${p("tolerance")}:softness=${p("softness")}`;
  } else if (f.type === "colorkey") {
    key = `colorkey=${keyColorHex(f.color, "0x808080")}:${p("similarity")}:${p("blend")}`;
  } else {
    const color = keyColorHex(f.color, "0x00FF00");
    key = `chromakey=${color}:${p("similarity")}:${p("blend")}`;
    const despill = paramValue(f, "despill");
    const screen = despill > 0 ? spillScreen(hexToRgb(color)) : null;
    if (screen) {
      // Pull the screen colour out of edges/reflections: the spill channel is
      // limited toward the average of the other two, scaled by `despill`.
      const d = num(-despill);
      const scales = screen === "green" ? `red=0:green=${d}:blue=0` : `red=0:green=0:blue=${d}`;
      key += `,despill=type=${screen}:mix=0.5:expand=0:${scales}:brightness=0`;
      keyedColour = true;
    }
  }
  const [a, b, k] = [`${label}a`, `${label}b`, `${label}k`];
  const top = keyedColour ? `[${k}][${b}]` : `[${b}][${k}]`;
  // RGBA into the split: a grade before the key (eq) outputs alpha-less YUV, and
  // blend would then settle on a format with no alpha plane to multiply.
  return `format=rgba,split[${a}][${b}];[${a}]${key},format=rgba[${k}];${top}blend=c3_mode=multiply,format=rgba`;
}

const amountParam = (label: string, min: number, max: number, step: number, def: number, unit?: string): EffectParam => ({
  key: "amount", label, min, max, step, default: def, ...(unit ? { unit } : {}),
});

const KEY_SIMILARITY: EffectParam = { key: "similarity", label: "Similarity", min: 0.01, max: 1, step: 0.01, default: 0.08 };
const KEY_BLEND: EffectParam = { key: "blend", label: "Blend (soft edge)", min: 0, max: 1, step: 0.01, default: 0.04 };

// ---- WebGL preview helpers (FFmpeg 4.4 parameter math; shaders in ./glsl.ts) ------

const f32 = Math.fround;
/** A param as FFmpeg reads it from the builder's 6-decimal string (a double option). */
const opt = (e: EffectInput, key: string): number => Number(num(paramValue(e, key)));
/** The same for a float (AV_OPT_TYPE_FLOAT) option. */
const optf = (e: EffectInput, key: string): number => f32(opt(e, key));

/**
 * gblur's (steps = 1) recursion constants for a sigma in PROCESSING pixels
 * (vf_gblur.c set_params, in its float/double mix), or null for sigma <= 0
 * (gblur passes the frame through). `taps` = the FIR length after which
 * nu^taps < 1/2000, i.e. the omitted tail is under a quarter level.
 */
export function gblurParams(sigma: number): { nu: number; bscale: number; postscale: number; taps: number } | null {
  const s = f32(sigma);
  if (!(s > 0)) return null;
  const lambda = f32(s * s) / 2;
  const dnu = (1 + 2 * lambda - Math.sqrt(1 + 4 * lambda)) / (2 * lambda);
  const post = f32(dnu / lambda);
  const nu = f32(dnu);
  const taps = nu <= 0 ? 1 : Math.min(1024, Math.max(1, Math.ceil(Math.log(1 / 2000) / Math.log(nu))));
  return { nu, bscale: f32(1 / (1 - dnu)), postscale: f32(post * post), taps };
}

/**
 * gblur as four passes (rows causal + anticausal, then columns), float in
 * between and 8-bit (truncated) out. `premul` = premultiply the 8-bit input
 * first (glow's blurred copy).
 */
function blurPasses(sigma: (e: EffectInput, g: GLUniformContext) => number, premul: boolean): EffectGLPass[] {
  const common = (e: EffectInput, g: GLUniformContext) => {
    const b = gblurParams(sigma(e, g)) ?? { nu: 0, bscale: 1, postscale: 1, taps: 1 };
    return { u_nu: b.nu, u_bscale: b.bscale, u_taps: b.taps, u_postscale: b.postscale };
  };
  return [
    { frag: GLSL_BLUR_CAUSAL, domain: premul ? "rgb" : "any", float: true,
      uniforms: (e, g) => ({ ...common(e, g), u_axis: 0, u_src: 0, u_premul: premul ? 1 : 0 }) },
    { frag: GLSL_BLUR_ANTI, domain: "any", float: true, uniforms: (e, g) => ({ ...common(e, g), u_axis: 0, u_last: 0 }) },
    { frag: GLSL_BLUR_CAUSAL, domain: "any", float: true, uniforms: (e, g) => ({ ...common(e, g), u_axis: 1, u_src: 1, u_premul: 0 }) },
    { frag: GLSL_BLUR_ANTI, domain: "any", uniforms: (e, g) => ({ ...common(e, g), u_axis: 1, u_last: 1 }) },
  ];
}

// FFmpeg chromakey's own full-range RGB→U/V macro for the KEY colour (vf_chromakey.c).
const FIX10 = (x: number) => Math.round(x * 1024);
const keyU = (r: number, g: number, b: number) => ((-FIX10(0.16874) * r - FIX10(0.33126) * g + FIX10(0.5) * b + 511) >> 10) + 128;
const keyV = (r: number, g: number, b: number) => ((FIX10(0.5) * r - FIX10(0.41869) * g - FIX10(0.08131) * b + 511) >> 10) + 128;
const clip8 = (n: number) => Math.min(255, Math.max(0, Math.trunc(n)));

/** The rgbsplit offsets in canvas pixels (the builder's rounding). */
function rgbsplitOffset(e: EffectInput): [number, number] {
  const r = paramValue(e, "amount");
  const a = (paramValue(e, "angle") * Math.PI) / 180;
  return [Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a))];
}

/** posterize's lutrgb table: (int) of round(v/255·L)/L·255 in doubles, like av_expr. */
export function posterizeTable(e: EffectInput): number[] {
  const L = Math.max(1, Math.round(paramValue(e, "amount")) - 1);
  const out: number[] = [];
  for (let v = 0; v < 256; v++) out.push(clip8(Math.round((v / 255) * L) / L * 255));
  return out;
}

/** hqdn3d's range exponent for a strength (vf_hqdn3d.c precalc_coefs). */
const hqdnGamma = (strength: number) => Math.log(0.25) / Math.log(1 - Math.min(strength, 252) / 255 - 0.00001);

// ---- the registry -------------------------------------------------------------

const DEFS: { [K in EffectType]: Omit<EffectDef, "type"> } = {
  blur: {
    label: "Blur",
    category: "Blur & sharpen",
    description: "Gaussian blur (amount = sigma).",
    params: [amountParam("Amount", 0, 100, 1, 8)],
    ffmpeg: (e) => [`gblur=sigma=${num(paramValue(e, "amount"))}`],
    // CSS blur(r) is a Gaussian with standard deviation r px, the same quantity as
    // gblur's sigma, so the proxy is blur(sigma × preview scale) over the whole range.
    preview: {
      css: (e, scale) => `blur(${fmtCss(paramValue(e, "amount") * scale)}px)`,
      note: "Close: both are Gaussians (CSS radius = sigma), scaled to the preview resolution; edges differ slightly (CSS fades, gblur clamps).",
      gl: {
        fidelity: "exact",
        note: "gblur's recursive filter (its exponential kernel and edge terms), at the preview resolution.",
        passes: blurPasses((e, g) => opt(e, "amount") * g.k, false),
        active: (e) => opt(e, "amount") > 0,
      },
    },
  },
  sharpen: {
    label: "Sharpen",
    category: "Blur & sharpen",
    description: "Unsharp-mask sharpening.",
    params: [amountParam("Amount", 0, 5, 0.1, 1)],
    ffmpeg: (e, ctx) => alphaSafe([`unsharp=5:5:${num(paramValue(e, "amount"))}:5:5:0`], `sharp${ctx.tag}`),
    preview: {
      gl: {
        fidelity: "exact",
        note: "unsharp's 5×5 luma kernel in its fixed-point math; the kernel is in preview pixels, so a scaled-down preview sharpens a wider area.",
        passes: [
          { frag: GLSL_UNSHARP_H, domain: "yuv", float: true },
          { frag: GLSL_UNSHARP_V, domain: "yuv", out: "rgb", uniforms: (e) => ({ u_amount: Math.trunc(optf(e, "amount") * 65536) }) },
        ],
      },
    },
  },
  detail: {
    label: "Detail",
    category: "Blur & sharpen",
    description: "Contrast-adaptive micro-sharpening: subtle local detail without halos.",
    params: [amountParam("Amount", 0, 1, 0.05, 0.5)],
    ffmpeg: (e) => [`cas=strength=${num(paramValue(e, "amount"))}`],
    preview: {
      gl: {
        fidelity: "exact",
        note: "cas's 3×3 contrast-adaptive math per channel; the 3×3 window is in preview pixels.",
        passes: [{ frag: GLSL_CAS, domain: "any", uniforms: (e) => ({ u_strength: -f32(16 + f32(f32(f32(4.01) - 16) * optf(e, "amount"))) }) }],
      },
    },
  },
  denoise: {
    label: "Denoise",
    category: "Repair",
    description: "Spatio-temporal noise reduction for grainy or low-light footage.",
    params: [amountParam("Amount", 0, 30, 1, 4)],
    ffmpeg: (e, ctx) => alphaSafe([`hqdn3d=${num(paramValue(e, "amount"))}`], `dn${ctx.tag}`),
    preview: {
      gl: {
        fidelity: "approx",
        note: "Approximation: hqdn3d's edge-preserving weight as a small spatial filter; its recursive and temporal smoothing only show in the render.",
        passes: [0, 1].map((axis): EffectGLPass => ({
          frag: GLSL_DENOISE, domain: "yuv", ...(axis === 1 ? { out: "rgb" as const } : {}),
          uniforms: (e) => {
            const luma = opt(e, "amount") || 4; // hqdn3d=0 means its default 4
            return { u_axis: axis, u_radius: Math.min(8, Math.max(2, Math.round(2 + luma / 3))), u_gamma: [hqdnGamma(luma), hqdnGamma((3 * luma) / 4)] };
          },
        })),
      },
    },
  },
  sepia: {
    label: "Sepia",
    category: "Stylize",
    description: "Warm brown vintage tone.",
    params: [],
    ffmpeg: () => ["colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131"],
    preview: {
      css: () => "sepia(0.85)",
      note: "Close: the export applies the full sepia matrix; the preview blends 85% toward it, so it is a touch weaker.",
      gl: {
        fidelity: "exact",
        note: "The same colorchannelmixer matrix with its per-product rounding.",
        passes: [{ frag: GLSL_MIXER, point: true, domain: "rgb", uniforms: () => ({ u_mix_r: [0.393, 0.769, 0.189], u_mix_g: [0.349, 0.686, 0.168], u_mix_b: [0.272, 0.534, 0.131] }) }],
      },
    },
  },
  grayscale: {
    label: "Black & white",
    category: "Stylize",
    description: "Full desaturation to black and white.",
    params: [],
    ffmpeg: () => ["hue=s=0"],
    preview: {
      css: () => "grayscale(1)",
      note: "Close: both fully desaturate; CSS weights the channels with Rec.709 luma, the export keeps the YUV (BT.601) luma, so some colours differ by a few levels.",
      gl: {
        fidelity: "exact",
        note: "hue=s=0 on the YUV (BT.601) values: luma kept, chroma neutral.",
        passes: [{ frag: GLSL_DESATURATE, point: true, domain: "yuv" }],
      },
    },
  },
  vignette: {
    label: "Vignette",
    category: "Stylize",
    description: "Darkens toward the corners like a lens (amount 1 = classic, 0 = none, 2.5 = black corners).",
    params: [amountParam("Strength", 0, 2.5, 0.05, 1)],
    ffmpeg: (e, ctx) => {
      const angle = vignetteAngle(e);
      if (angle <= 0) return [];
      // vignette has no alpha-capable pixel format: darken a split copy and merge
      // the original alpha back.
      return alphaSafe([`vignette=angle=${num(angle)}`], `vig${ctx.tag}`);
    },
    preview: {
      pass: "vignette",
      gl: {
        fidelity: "exact",
        note: "FFmpeg's cos⁴ falloff over the canvas with its integer offsets; it rounds where FFmpeg dithers (±1 level).",
        passes: [{ frag: GLSL_VIGNETTE, point: true, domain: "rgb", out: "rgb", uniforms: (e) => ({ u_vig_angle: Number(num(vignetteAngle(e))) }) }],
        active: (e) => vignetteAngle(e) > 0,
      },
    },
  },
  edges: {
    label: "Edges",
    category: "Stylize",
    description: "Edge-detect / sketch look.",
    params: [],
    ffmpeg: (_e, ctx) => alphaSafe(["edgedetect=mode=colormix"], `edge${ctx.tag}`),
    preview: {
      gl: {
        fidelity: "exact",
        note: "edgedetect's Gaussian, Sobel, non-maximum suppression and its one-step double threshold; the fixed kernels are in preview pixels.",
        passes: [{ frag: GLSL_EDGE_GAUSS, domain: "rgb" }, { frag: GLSL_EDGE_DETECT, domain: "rgb", out: "rgb" }],
      },
    },
  },
  posterize: {
    label: "Posterize",
    category: "Stylize",
    description: "Reduces each channel to a few flat colour levels (amount = levels).",
    params: [amountParam("Levels", 2, 32, 1, 6)],
    ffmpeg: (e) => {
      const L = Math.max(1, Math.round(paramValue(e, "amount")) - 1);
      const x = `round(val/255*${L})/${L}*255`;
      return [`lutrgb=r='${x}':g='${x}':b='${x}'`];
    },
    preview: {
      gl: {
        fidelity: "exact",
        note: "The same lutrgb table.",
        passes: [{ frag: GLSL_LUT256, point: true, domain: "rgb", uniforms: (e) => ({ u_lut256: posterizeTable(e) }) }],
      },
    },
  },
  pixelate: {
    label: "Pixelate",
    category: "Stylize",
    description: "Mosaic blocks (amount = block size factor).",
    params: [amountParam("Block size", 2, 100, 1, 16)],
    ffmpeg: (e, ctx) => {
      const b = num(paramValue(e, "amount"));
      return [`scale=max(2\\,iw/${b}):max(2\\,ih/${b}):flags=neighbor`, `scale=${ctx.W}:${ctx.H}:flags=neighbor`];
    },
    preview: {
      gl: {
        fidelity: "exact",
        note: "swscale's point sampling and its RGB→YUV→RGB path (block colour from a pixel pair, as FFmpeg does).",
        passes: [{
          frag: GLSL_PIXELATE, domain: "any",
          uniforms: (e, g) => {
            const b = opt(e, "amount");
            const w2 = Math.trunc(Math.max(2, g.cw / b));
            const h2 = Math.trunc(Math.max(2, g.ch / b));
            const inc = (src: number, dst: number) => Math.floor((src * 65536 + (dst >> 1)) / dst);
            return { u_inc1: [inc(g.w, w2), inc(g.h, h2)], u_inc2: [inc(w2, g.w), inc(h2, g.h)], u_cinc1: inc(Math.ceil(g.w / 2), w2) };
          },
        }],
      },
    },
  },
  chromakey: {
    label: "Chroma key (green/blue screen)",
    category: "Key",
    description:
      "KEY for saturated GREEN/BLUE screen footage (distance in chroma only); despill > 0 removes green/blue spill from edges. " +
      "Never chromakey a gray/white/black screen: all neutrals share gray's chroma, so it would also erase every white, black and gray area.",
    params: [
      { ...KEY_SIMILARITY, default: 0.18 },
      { ...KEY_BLEND, default: 0.1 },
      { key: "despill", label: "Despill", min: 0, max: 1, step: 0.05, default: 0 },
    ],
    color: { default: "0x00FF00", auto: true },
    ffmpeg: (e, ctx) => [keyStep(e, `key${ctx.tag}`)],
    preview: {
      key: true,
      gl: {
        fidelity: "close",
        note: "chromakey's 3×3 chroma distance on BT.601 YUV and the despill math, the key alpha multiplying the clip's; FFmpeg's left-edge pixels at its thread-slice starts (they depend on the CPU count) can differ.",
        passes: [{
          frag: GLSL_KEY_CHROMA, domain: "rgb", out: "rgb",
          uniforms: (e) => {
            const rgb = hexToRgb(keyColorHex(e.color, "0x00FF00"));
            const despill = paramValue(e, "despill");
            const screen = despill > 0 ? spillScreen(rgb) : null;
            return {
              u_key: [keyU(...rgb), keyV(...rgb)],
              u_sb: [optf(e, "similarity"), optf(e, "blend")],
              u_spill: [screen ? optf(e, "despill") : 0, screen === "green" ? 1 : screen === "blue" ? 2 : 0],
            };
          },
        }],
      },
    },
  },
  colorkey: {
    label: "Color key (any flat color)",
    category: "Key",
    description:
      "KEY for GRAY / neutral / white / black or ANY flat-colour screen, and for graphics overlays with white/black/gray details (RGB distance).",
    params: [KEY_SIMILARITY, KEY_BLEND],
    color: { default: "0x808080", auto: true },
    ffmpeg: (e, ctx) => [keyStep(e, `key${ctx.tag}`)],
    preview: {
      key: true,
      gl: {
        fidelity: "exact",
        note: "colorkey's RGB distance and ramp; the key alpha multiplies the clip's.",
        passes: [{
          frag: GLSL_KEY_COLOR, point: true, domain: "rgb", out: "rgb",
          uniforms: (e) => ({ u_ckey_key: hexToRgb(keyColorHex(e.color, "0x808080")), u_ckey_sb: [optf(e, "similarity"), optf(e, "blend")] }),
        }],
      },
    },
  },
  lumakey: {
    label: "Luma key (black/white background)",
    category: "Key",
    description: "KEY by brightness for a pure black or white background (threshold 0 = black … 1 = white); color 'auto' sets the threshold.",
    params: [
      { key: "threshold", label: "Threshold (0 black · 1 white)", min: 0, max: 1, step: 0.01, default: 0 },
      { key: "tolerance", label: "Tolerance", min: 0, max: 1, step: 0.01, default: 0.1 },
      { key: "softness", label: "Softness", min: 0, max: 1, step: 0.01, default: 0.05 },
    ],
    color: { default: null, auto: true, autoParam: "threshold" },
    ffmpeg: (e, ctx) => [keyStep(e, `key${ctx.tag}`)],
    preview: {
      key: true,
      gl: {
        fidelity: "exact",
        note: "lumakey's band on BT.601 luma with its integer ramp; the key alpha multiplies the clip's.",
        passes: [{
          frag: GLSL_KEY_LUMA, point: true, domain: "rgb", out: "rgb",
          uniforms: (e) => {
            const [t, tol, soft] = [opt(e, "threshold"), opt(e, "tolerance"), opt(e, "softness")];
            return { u_lkey_band: [clip8((t - tol) * 255), clip8((t + tol) * 255), Math.trunc(soft * 255)] };
          },
        }],
      },
    },
  },

  // ---- LOOK: grades with a live CSS-filter preview -------------------------------
  exposure: {
    label: "Exposure",
    category: "Look",
    description: "Camera-style exposure: amount = EV stops (+1 doubles the light, -1 halves it), params.black lifts (+) or crushes (-) the black point.",
    params: [amountParam("Exposure", -3, 3, 0.05, 0.5, " EV"), { key: "black", label: "Black level", min: -1, max: 1, step: 0.01, default: 0 }],
    // FFmpeg: out = (in - black) / (2^-EV - black), on the encoded values. The black point is
    // kept below 2^-EV (a black at or above it divides by zero / goes negative).
    ffmpeg: (e) => [`exposure=exposure=${num(paramValue(e, "amount"))}:black=${num(exposureBlack(e))}`],
    preview: {
      css: (e) => {
        const b = exposureBlack(e);
        const k = 1 / (2 ** -paramValue(e, "amount") - b);
        if (b === 0) return `brightness(${fmtCss(k)})`;
        // Target k·(x − b). CSS clamps to 0..1 after EVERY filter function, so each stage must stay in range.
        if (b < 0) {
          // contrast(c) then brightness(m): c = 1 / (1 − 2b) < 1 keeps the middle stage inside 0..1,
          // and m·c = k with a shift of −k·b gives k·(x − b).
          const c = 1 / (1 - 2 * b);
          return `contrast(${fmtCss(c)}) brightness(${fmtCss(k / c)})`;
        }
        // b > 0: brightness(m) then contrast(c) with c = 1 + 2kb and m = k / c. Any x the first stage
        // clips already lands at white in the export too.
        const c = 1 + 2 * k * b;
        return `brightness(${fmtCss(k / c)}) contrast(${fmtCss(c)})`;
      },
      note: "Near exact: the same linear scale-and-offset on the encoded values (CSS brightness = x·2^EV); only the clipping of extreme values can differ.",
      gl: {
        fidelity: "exact",
        note: "exposure's (x − black)·scale in float, rounded back to 8 bits (FFmpeg dithers that rounding: ±1 level).",
        passes: [{
          frag: GLSL_EXPOSURE, point: true, domain: "rgb",
          uniforms: (e) => {
            const ev = optf(e, "amount");
            const black = f32(Number(num(exposureBlack(e))));
            return { u_expo_black: black, u_expo_scale: f32(1 / f32(f32(2 ** -ev) - black)) };
          },
        }],
      },
    },
  },
  vibrance: {
    label: "Vibrance",
    category: "Look",
    description: "Smart saturation: boosts dull colours more than already-saturated ones (so skin and bright colours don't blow out). Negative mutes. Use apply_color/color_grade for plain saturation.",
    params: [amountParam("Vibrance", -2, 2, 0.05, 0.8)],
    ffmpeg: (e) => [`vibrance=intensity=${num(paramValue(e, "amount"))}`],
    preview: {
      css: (e) => {
        const i = paramValue(e, "amount");
        return `saturate(${fmtCss(Math.max(0, i >= 0 ? 1 + 0.75 * i : 1 + 0.8 * i))})`;
      },
      note: "Approximate: CSS saturate boosts every colour equally, so already-saturated colours look stronger than in the export, and below -1.25 FFmpeg overshoots past grey.",
      gl: {
        fidelity: "exact",
        note: "vibrance's per-channel push from its weighted luma, with FFmpeg's default coefficients.",
        passes: [{
          frag: GLSL_VIBRANCE, point: true, domain: "rgb",
          uniforms: (e) => {
            const i = optf(e, "amount");
            return { u_vib_intensity: i, u_vib_sign: -(i > 0 ? 1 : -1) };
          },
        }],
      },
    },
  },
  invert: {
    label: "Invert",
    category: "Look",
    description: "Negative: inverts every colour (alpha is untouched).",
    params: [],
    ffmpeg: () => ["negate"],
    preview: {
      css: () => "invert(1)",
      note: "Exact.",
      gl: { fidelity: "exact", note: "negate (in YUV after a YUV-only grade, as FFmpeg does).", passes: [{ frag: GLSL_NEGATE, point: true, domain: "any" }] },
    },
  },
  colorhold: {
    label: "Keep one color",
    category: "Look",
    description:
      "Color pop: keeps ONE colour (params.similarity = how far from it still counts, blend = soft edge) and turns everything else black & white. " +
      "color = the colour to keep as hex (no 'auto'); sample it from the frame with get_frame / the eyedropper.",
    params: [
      { key: "similarity", label: "Similarity", min: 0.01, max: 1, step: 0.01, default: 0.3 },
      { key: "blend", label: "Blend (soft edge)", min: 0, max: 1, step: 0.01, default: 0.1 },
    ],
    color: { default: "0xFF0000", auto: false },
    ffmpeg: (e) => [
      `colorhold=color=${keyColorHex(e.color, "0xFF0000")}:similarity=${num(paramValue(e, "similarity"))}:blend=${num(paramValue(e, "blend"))}`,
    ],
    preview: {
      gl: {
        fidelity: "exact",
        note: "colorhold's RGB distance ramp and its fixed-point mix toward grey.",
        passes: [{
          frag: GLSL_COLORHOLD, point: true, domain: "rgb",
          uniforms: (e) => ({ u_hold_key: hexToRgb(keyColorHex(e.color, "0xFF0000")), u_hold_sb: [optf(e, "similarity"), optf(e, "blend")] }),
        }],
      },
    },
  },

  // ---- STYLE: previewed by WebGL2 only (no CSS proxy) --------------------------------
  // Every control below is stored as `amount` + `params` with the keys and units
  // declared here; pixel quantities are CANVAS pixels (the project resolution),
  // so a preview multiplies them by its buffer scale.
  grain: {
    label: "Film grain",
    category: "Stylize",
    description: "Animated film grain / noise on every frame (amount = strength 0..100; 20 = subtle, 60+ = heavy).",
    params: [amountParam("Amount", 0, 100, 1, 20)],
    // t+u = a fresh uniform noise pattern every frame. Fixed seed: the same export twice gives the same grain.
    ffmpeg: (e, ctx) => {
      const n = Math.round(paramValue(e, "amount"));
      return n <= 0 ? [] : alphaSafe([`noise=all_seed=7:alls=${n}:allf=t+u`], `gr${ctx.tag}`);
    },
    preview: {
      gl: {
        fidelity: "close",
        note: "The same uniform per-channel noise, new every frame, its colour averaged over 2×2 pixels as the export's 4:2:0 output does; FFmpeg's own random table differs pixel for pixel.",
        passes: [{ frag: GLSL_NOISE, point: true, domain: "rgb", out: "rgb", uniforms: (e) => ({ u_noise_strength: Math.round(paramValue(e, "amount")) }) }],
        active: (e) => Math.round(paramValue(e, "amount")) > 0,
      },
    },
  },
  glow: {
    label: "Glow",
    category: "Stylize",
    description: "Soft bloom: a blurred copy is screened over the picture, so bright areas bleed light (amount = strength 0..1, params.radius = blur in px).",
    params: [amountParam("Strength", 0, 1, 0.05, 0.6), { key: "radius", label: "Radius", min: 1, max: 100, step: 1, default: 12, unit: "px" }],
    ffmpeg: (e, ctx) => {
      const strength = paramValue(e, "amount");
      if (strength <= 0) return [];
      const l = `gl${ctx.tag}`;
      // Screen the blurred (premultiplied: colour hidden under alpha 0 does not bleed in) copy over the colours, then put the ORIGINAL alpha back with alphamerge.
      // (blend's c3_opacity=0 does not keep alpha in FFmpeg 4.4: the blurred alpha leaked into
      // letterbox padding and darkened the track below.)
      return [
        `format=rgba,split=3[${l}a][${l}b][${l}m];[${l}a]premultiply=inplace=1,gblur=sigma=${num(paramValue(e, "radius"))}[${l}c];` +
          `[${l}b][${l}c]blend=all_mode=screen:all_opacity=${num(strength)}[${l}v];[${l}m]alphaextract[${l}x];[${l}v][${l}x]alphamerge,format=rgba`,
      ];
    },
    preview: {
      gl: {
        fidelity: "exact",
        note: "The premultiplied gblur copy screened over the picture at the same opacity, original alpha kept.",
        passes: [
          ...blurPasses((e, g) => opt(e, "radius") * g.k, true),
          { frag: GLSL_SCREEN, domain: "rgb", out: "rgb", uniforms: (e) => ({ u_opacity: opt(e, "amount") }) },
        ],
        active: (e) => paramValue(e, "amount") > 0,
      },
    },
  },
  rgbsplit: {
    label: "RGB split",
    category: "Stylize",
    description: "Chromatic-aberration / glitch look: red and blue are pushed apart along an angle (amount = offset in px, params.angle = direction in degrees, 0 = horizontal).",
    params: [amountParam("Offset", 0, 50, 1, 6, "px"), { key: "angle", label: "Angle", min: 0, max: 360, step: 5, default: 0, unit: "°" }],
    ffmpeg: (e) => {
      const r = paramValue(e, "amount");
      const a = (paramValue(e, "angle") * Math.PI) / 180;
      const [dx, dy] = [Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a))];
      if (dx === 0 && dy === 0) return [];
      // Red one way, blue the other, green stays; alpha is not shifted.
      // Premultiplied, so colour hidden under alpha 0 (a keyed-out screen) is not pulled into the edge.
      return [`format=rgba,premultiply=inplace=1,rgbashift=rh=${dx}:rv=${dy}:bh=${-dx}:bv=${-dy},unpremultiply=inplace=1,format=rgba`];
    },
    preview: {
      gl: {
        fidelity: "exact",
        note: "The same premultiplied channel shift (edges smeared), the offset scaled to the preview.",
        passes: [{
          frag: GLSL_RGBSHIFT, domain: "rgb", out: "rgb",
          uniforms: (e, g) => {
            const [dx, dy] = rgbsplitOffset(e);
            return { u_shift: [Math.round(dx * g.k), Math.round(dy * g.k)] };
          },
        }],
        active: (e) => rgbsplitOffset(e).some((v) => v !== 0),
      },
    },
  },
  lens: {
    label: "Lens distortion",
    category: "Stylize",
    description: "Barrel / pincushion warp around the centre (amount = k1 -1..1: positive = barrel / fisheye bulge with transparent corners, negative = pincushion; params.k2 adds a stronger edge term).",
    params: [amountParam("Distortion", -1, 1, 0.05, 0.3), { key: "k2", label: "Edge curve (k2)", min: -1, max: 1, step: 0.05, default: 0 }],
    // Unmapped pixels are transparent (lenscorrection's default fc black@0), so the track below shows at the corners.
    ffmpeg: (e) => {
      const [k1, k2] = [paramValue(e, "amount"), paramValue(e, "k2")];
      return k1 === 0 && k2 === 0 ? [] : [`lenscorrection=cx=0.5:cy=0.5:k1=${num(k1)}:k2=${num(k2)}:i=bilinear`];
    },
    preview: {
      gl: {
        fidelity: "exact",
        note: "lenscorrection's radial mapping and bilinear sampling; unmapped corners stay transparent.",
        passes: [{
          frag: GLSL_LENS, domain: "any",
          uniforms: (e) => ({ u_k1: Math.trunc(opt(e, "amount") * 2 ** 24) / 2 ** 24, u_k2: Math.trunc(opt(e, "k2") * 2 ** 24) / 2 ** 24 }),
        }],
        active: (e) => paramValue(e, "amount") !== 0 || paramValue(e, "k2") !== 0,
      },
    },
  },
  trails: {
    label: "Trails",
    category: "Stylize",
    description: "Ghosting / light trails: bright moving things leave a fading echo (amount = decay 0.8..0.99; higher = longer trail). Restarts at each clip's own start (on an adjustment layer it builds up from the start of the timeline, like the export).",
    params: [amountParam("Decay", 0.8, 0.99, 0.01, 0.9)],
    ffmpeg: (e, ctx) => {
      const lag = `lagfun=decay=${num(paramValue(e, "amount"))}`;
      return alphaSafe([lag], `tr${ctx.tag}`, [lag], true);
    },
    preview: {
      gl: {
        fidelity: "close",
        note: "lagfun's premultiplied max-decay per frame; the preview's trail builds up from where playback started, the render's from the clip start.",
        history: true,
        passes: [
          { frag: GLSL_LAGFUN, domain: "rgb", float: true, history: true, uniforms: (e) => ({ u_decay: optf(e, "amount") }) },
          { frag: GLSL_LAGOUT, domain: "rgb", out: "rgb" },
        ],
      },
    },
  },
};

/** Every effect, in EFFECT_TYPE_IDS order. */
export const EFFECTS: readonly EffectDef[] = EFFECT_TYPE_IDS.map((type) => ({ type, ...DEFS[type] }));

const DEF_MAP = new Map<string, EffectDef>(EFFECTS.map((d) => [d.type, d]));

export function effectByType(type: string): EffectDef | undefined {
  return DEF_MAP.get(type);
}

/** True when the effect has no live preview at all, with or without WebGL2 (only the FFmpeg render shows it). */
export function exactOnly(type: string): boolean {
  const p = DEF_MAP.get(type)?.preview;
  return !p || p === "export-only" || (!p.css && !p.key && !p.pass && !p.gl);
}

/** The effect's WebGL2 preview, if it has one. */
export function effectGL(type: string): EffectGL | undefined {
  const p = DEF_MAP.get(type)?.preview;
  return p && p !== "export-only" ? p.gl : undefined;
}

/**
 * How close the live preview of an effect is to the export: its GL fidelity
 * when WebGL2 runs (`gl`), else the CSS / canvas fallback ("close"; keys and
 * GL-only effects have none). "none" = only the render shows it.
 */
export function previewFidelity(type: string, gl = true): GLFidelity | "none" {
  const p = DEF_MAP.get(type)?.preview;
  if (!p || p === "export-only") return "none";
  if (gl && p.gl) return p.gl.fidelity;
  if (p.css || p.pass) return p.css && p.note === "Exact." ? "exact" : "close";
  return "none";
}

/** True for the keys (previewed by the WebGL key pass). */
export function isKeyType(type: string): boolean {
  const p = DEF_MAP.get(type)?.preview;
  return !!p && p !== "export-only" && p.key === true;
}

/** Bypassed effects (enabled: false) are skipped in export and preview. */
export function isEnabled(e: { enabled?: boolean }): boolean {
  return e.enabled !== false;
}

/** The default stored fields for a new effect of `type`: {amount?, params?, color?}. */
export function defaultsFor(type: string): { amount?: number; params?: Record<string, number>; color?: string } {
  const d = DEF_MAP.get(type);
  if (!d) return {};
  const out: { amount?: number; params?: Record<string, number>; color?: string } = {};
  for (const p of d.params) {
    if (p.key === "amount") out.amount = p.default;
    else (out.params ??= {})[p.key] = p.default;
  }
  if (d.color?.default) out.color = d.color.default;
  return out;
}

/**
 * The FFmpeg steps for a clip's (or adjustment layer's) effect stack, in order.
 * Bypassed and unknown types are skipped (the rpc layer validates the
 * vocabulary). Labels use the effect's ORIGINAL index, so bypassing one effect
 * doesn't rename the others' sub-graphs. `tag` must be unique per stack.
 */
export function effectFilterSteps(filters: readonly EffectInput[], W: number, H: number, tag = "fx"): string[] {
  const out: string[] = [];
  for (const [i, f] of filters.entries()) {
    if (!isEnabled(f)) continue;
    const d = DEF_MAP.get(f.type);
    if (!d) continue;
    out.push(...d.ffmpeg(f, { W, H, tag: `${tag}_${i}` }));
  }
  return out;
}

// ---- validation (rpc) ---------------------------------------------------------

const fmtN = (n: number) => String(Math.round(n * 1000) / 1000);
const describeParam = (p: EffectParam) => `${p.key} ${fmtN(p.min)}..${fmtN(p.max)} (default ${fmtN(p.default)}${p.unit ?? ""})`;

/** A request to add/update an effect, before validation. */
export interface EffectRequest {
  type: string;
  amount?: number;
  color?: string;
  params?: Record<string, number>;
}

/** A validated request: values clamped, colour normalised, plus notes on anything adjusted. */
export interface ValidatedEffect {
  amount?: number;
  color?: string;
  params?: Record<string, number>;
  adjusted: string[];
}

/**
 * Validate an effect request against the registry: unknown params, an amount
 * or colour the effect doesn't take, and unparseable colours are rejected with
 * an error that teaches the valid shape; numbers are clamped to their range
 * (each clamp is reported in `adjusted`). Colours are normalised to 0xRRGGBB;
 * "auto" is passed through for effects that accept it.
 */
export function validateEffect(req: EffectRequest): ValidatedEffect {
  const d = DEF_MAP.get(req.type);
  if (!d) throw new Error(`Unknown effect type "${req.type}". Valid types: ${EFFECT_TYPE_IDS.join(", ")}.`);
  const adjusted: string[] = [];
  const clampTo = (p: EffectParam, v: number): number => {
    const c = clampN(v, p.min, p.max);
    if (c !== v) adjusted.push(`${p.key} ${v} → ${fmtN(c)} (${d.type} ${p.key} is ${fmtN(p.min)}..${fmtN(p.max)})`);
    return c;
  };
  const amountP = d.params.find((p) => p.key === "amount");
  const others = d.params.filter((p) => p.key !== "amount");
  const out: ValidatedEffect = { adjusted };

  if (req.amount !== undefined) {
    if (!amountP) {
      throw new Error(
        `${d.type} takes no amount` +
          (others.length ? ` — its controls are params {${others.map(describeParam).join(", ")}}.` : " (it has no adjustable strength)."),
      );
    }
    out.amount = clampTo(amountP, req.amount);
  }

  if (req.params !== undefined) {
    const keys = Object.keys(req.params);
    if (keys.includes("amount")) {
      throw new Error(`Pass ${d.type}'s strength as the top-level "amount" field, not params.amount.`);
    }
    const unknown = keys.filter((k) => !others.some((p) => p.key === k));
    if (unknown.length) {
      const valid = others.length ? `Valid params: ${others.map(describeParam).join(", ")}.` : `${d.type} takes no params.`;
      throw new Error(`Unknown param${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")} for ${d.type}. ${valid}`);
    }
    if (keys.length) {
      out.params = {};
      for (const p of others) {
        const v = req.params[p.key];
        if (v !== undefined) out.params[p.key] = clampTo(p, v);
      }
    }
  }

  if (d.type === "exposure" && out.amount !== undefined && out.params?.black !== undefined) {
    const maxBlack = 2 ** -out.amount - 0.05;
    if (out.params.black > maxBlack) {
      adjusted.push(`black ${fmtN(out.params.black)} → ${fmtN(maxBlack)} (exposure black must stay below 2^-EV = ${fmtN(2 ** -out.amount)} at ${fmtN(out.amount)} EV)`);
      out.params.black = maxBlack;
    }
  }

  if (req.color !== undefined) {
    const spec = d.color;
    const isAuto = req.color.trim().toLowerCase() === "auto";
    if (!spec) throw new Error(`${d.type} takes no color (only ${EFFECTS.filter((x) => x.color).map((x) => x.type).join(", ")} do).`);
    if (isAuto) {
      if (!spec.auto) throw new Error(`${d.type} does not support color "auto".`);
      out.color = "auto";
    } else if (spec.default === null) {
      throw new Error(
        `${d.type} takes no key colour — set params.${spec.autoParam ?? "threshold"}, or pass color "auto" to set it from the frame border.`,
      );
    } else {
      const hex = parseKeyColor(req.color);
      if (!hex) {
        throw new Error(
          `Invalid color "${req.color}". Use hex like "0x00FF00" or "#00ff00", one of ${Object.keys(KEY_COLOR_NAMES).join("/")}${spec.auto ? ', or "auto"' : ""}.`,
        );
      }
      out.color = hex;
    }
  }
  return out;
}

// ---- AI description -------------------------------------------------------------

/** One line per effect for the apply_effect tool description: what it is, its controls, ranges and defaults. */
export function describeEffectsForAI(): string {
  return EFFECTS.map((d) => {
    const parts: string[] = [];
    const amountP = d.params.find((p) => p.key === "amount");
    const others = d.params.filter((p) => p.key !== "amount");
    if (amountP) parts.push(`amount ${fmtN(amountP.min)}..${fmtN(amountP.max)} (default ${fmtN(amountP.default)})`);
    if (others.length) parts.push(`params {${others.map(describeParam).join(", ")}}`);
    if (d.color) {
      parts.push(
        d.color.default
          ? d.color.auto
            ? `color = key colour (default ${d.color.default}, or 'auto')`
            : `color = hex colour (default ${d.color.default}; 'auto' not accepted)`
          : `color 'auto' only (sets ${d.color.autoParam})`,
      );
    }
    if (!amountP && !others.length && !d.color) parts.push("no controls");
    return `- ${d.type}: ${d.description} ${parts.join("; ")}.`;
  }).join("\n");
}
