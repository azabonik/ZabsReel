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
] as const;
export type EffectType = (typeof EFFECT_TYPE_IDS)[number];

/** Inspector groups, in menu order. */
export const EFFECT_CATEGORIES = ["Blur & sharpen", "Repair", "Stylize", "Key"] as const;
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
  /** CSS filter fragment (the 2D canvas `ctx.filter` colour proxy). */
  css?: (e: EffectInput) => string;
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
    // The CSS blur radius tops out lower than the export's sigma (a proxy).
    preview: { css: (e) => `blur(${clampN(e.amount ?? 8, 0, 50) / 5}px)` },
  },
  sharpen: {
    label: "Sharpen",
    category: "Blur & sharpen",
    description: "Unsharp-mask sharpening.",
    params: [amountParam("Amount", 0, 5, 0.1, 1)],
    ffmpeg: (e) => [`unsharp=5:5:${num(paramValue(e, "amount"))}:5:5:0`],
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
    ffmpeg: (e) => [`hqdn3d=${num(paramValue(e, "amount"))}`],
    preview: "export-only",
  },
  sepia: {
    label: "Sepia",
    category: "Stylize",
    description: "Warm brown vintage tone.",
    params: [],
    ffmpeg: () => ["colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131"],
    preview: { css: () => "sepia(0.85)" },
  },
  grayscale: {
    label: "Black & white",
    category: "Stylize",
    description: "Full desaturation to black and white.",
    params: [],
    ffmpeg: () => ["hue=s=0"],
    preview: { css: () => "grayscale(1)" },
  },
  vignette: {
    label: "Vignette",
    category: "Stylize",
    description: "Darkens toward the corners like a lens (amount 1 = classic, 0 = none, 2.5 = black corners).",
    params: [amountParam("Strength", 0, 2.5, 0.05, 1)],
    ffmpeg: (e, ctx) => {
      const angle = vignetteAngle(e);
      if (angle <= 0) return [];
      // vignette has no alpha-capable pixel format, so on its own it would turn
      // transparent letterbox padding / keyed areas opaque: darken a split copy
      // and merge the original alpha back.
      const l = `vig${ctx.tag}`;
      return [
        `format=rgba,split[${l}a][${l}b];[${l}a]vignette=angle=${num(angle)}[${l}v];` +
          `[${l}b]alphaextract[${l}m];[${l}v][${l}m]alphamerge,format=rgba`,
      ];
    },
    preview: { pass: "vignette" },
  },
  edges: {
    label: "Edges",
    category: "Stylize",
    description: "Edge-detect / sketch look.",
    params: [],
    ffmpeg: () => ["edgedetect=mode=colormix"],
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

  if (req.color !== undefined) {
    const spec = d.color;
    const isAuto = req.color.trim().toLowerCase() === "auto";
    if (!spec) throw new Error(`${d.type} takes no color (only the keys do: chromakey, colorkey, lumakey).`);
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
          `Invalid key color "${req.color}". Use hex like "0x00FF00" or "#00ff00", one of ${Object.keys(KEY_COLOR_NAMES).join("/")}, or "auto".`,
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
          ? `color = key colour (default ${d.color.default}${d.color.auto ? ", or 'auto'" : ""})`
          : `color 'auto' only (sets ${d.color.autoParam})`,
      );
    }
    if (!amountP && !others.length && !d.color) parts.push("no controls");
    return `- ${d.type}: ${d.description} ${parts.join("; ")}.`;
  }).join("\n");
}
