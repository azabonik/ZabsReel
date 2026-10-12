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
 * at all — so the desktop renderer can import it as `@aive/core/effects`.
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
   * CSS filter fragment (the 2D canvas `ctx.filter` colour proxy). `scale` =
   * preview pixels per canvas pixel (the compositor buffer is capped at 1280 on
   * the long edge), for effects measured in canvas pixels such as blur.
   */
  css?: (e: EffectInput, scale: number) => string;
  /** How close the CSS proxy is to the FFmpeg export — shown to people and the AI as the effect's caveat. */
  note?: string;
  /** Shown by the WebGL key pass (apps/desktop/src/glkey.ts). */
  key?: true;
  /** Shown by a named 2D canvas pass that the renderer draws over the layer. */
  pass?: "vignette";
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
  /** Live preview, or "export-only" (the UI shows a "Render exact" badge). */
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
    },
  },
  sharpen: {
    label: "Sharpen",
    category: "Blur & sharpen",
    description: "Unsharp-mask sharpening.",
    params: [amountParam("Amount", 0, 5, 0.1, 1)],
    ffmpeg: (e, ctx) => alphaSafe([`unsharp=5:5:${num(paramValue(e, "amount"))}:5:5:0`], `sharp${ctx.tag}`),
    preview: "export-only",
  },
  detail: {
    label: "Detail",
    category: "Blur & sharpen",
    description: "Contrast-adaptive micro-sharpening: subtle local detail without halos.",
    params: [amountParam("Amount", 0, 1, 0.05, 0.5)],
    ffmpeg: (e) => [`cas=strength=${num(paramValue(e, "amount"))}`],
    preview: "export-only",
  },
  denoise: {
    label: "Denoise",
    category: "Repair",
    description: "Spatio-temporal noise reduction for grainy or low-light footage.",
    params: [amountParam("Amount", 0, 30, 1, 4)],
    ffmpeg: (e, ctx) => alphaSafe([`hqdn3d=${num(paramValue(e, "amount"))}`], `dn${ctx.tag}`),
    preview: "export-only",
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
    preview: { pass: "vignette" },
  },
  edges: {
    label: "Edges",
    category: "Stylize",
    description: "Edge-detect / sketch look.",
    params: [],
    ffmpeg: (_e, ctx) => alphaSafe(["edgedetect=mode=colormix"], `edge${ctx.tag}`),
    preview: "export-only",
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
    preview: "export-only",
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
    preview: "export-only",
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
    preview: { key: true },
  },
  colorkey: {
    label: "Color key (any flat color)",
    category: "Key",
    description:
      "KEY for GRAY / neutral / white / black or ANY flat-colour screen, and for graphics overlays with white/black/gray details (RGB distance).",
    params: [KEY_SIMILARITY, KEY_BLEND],
    color: { default: "0x808080", auto: true },
    ffmpeg: (e, ctx) => [keyStep(e, `key${ctx.tag}`)],
    preview: { key: true },
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
    preview: { key: true },
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
    },
  },
  invert: {
    label: "Invert",
    category: "Look",
    description: "Negative: inverts every colour (alpha is untouched).",
    params: [],
    ffmpeg: () => ["negate"],
    preview: { css: () => "invert(1)", note: "Exact." },
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
    preview: "export-only",
  },

  // ---- STYLE: export-only for now (the WebGL preview stage consumes the same shape) ---
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
    preview: "export-only",
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
    preview: "export-only",
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
    preview: "export-only",
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
    preview: "export-only",
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
    preview: "export-only",
  },
};

/** Every effect, in EFFECT_TYPE_IDS order. */
export const EFFECTS: readonly EffectDef[] = EFFECT_TYPE_IDS.map((type) => ({ type, ...DEFS[type] }));

const DEF_MAP = new Map<string, EffectDef>(EFFECTS.map((d) => [d.type, d]));

export function effectByType(type: string): EffectDef | undefined {
  return DEF_MAP.get(type);
}

/** True when the effect has no live preview (only the FFmpeg render shows it). */
export function exactOnly(type: string): boolean {
  return DEF_MAP.get(type)?.preview === "export-only";
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
