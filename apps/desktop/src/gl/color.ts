// The colour grade (ColorAdjust → eq, ColorGrade → colorbalance / hue /
// curves, LUT → lut3d) as WebGL2 passes for the live preview. PURE (no DOM):
// the parameter math mirrors packages/core ffmpeg/graph.ts (colorGradeSteps,
// the eq and lut3d steps) and FFmpeg 4.4's own arithmetic (vf_eq.c,
// vf_colorbalance.c, vf_hue.c, vf_curves.c, vf_lut3d.c), so the preview
// computes the export's 8-bit values. scripts/smoke-composite.ts checks the
// parameters against the filter strings graph.ts builds; scripts/parity-gl.mts
// checks the pixels against FFmpeg.

import type { ColorAdjust, ColorGrade, RGBWheel } from "../types";

// ---- shaders: POINT ops (see packages/core effects/glsl.ts for the contract) ----
// Each declares its own table sampler (the runtime binds the step's `aux` /
// `lut` texture to every sampler a body declares besides the prelude's).

/**
 * eq on yuv444p: three 256-entry tables (Y, U, V in r/g/b of the step's aux
 * texture), built by eqTables() from vf_eq.c's fixed-point process / gamma LUT.
 */
export const GLSL_EQ = `
uniform sampler2D u_eq_tab;
float eq_tab(int i, int c) { return floor(texelFetch(u_eq_tab, ivec2(i, 0), 0)[c] * 255.0 + 0.5); }
vec4 op_eq(vec4 c, ivec2 p, int dom) {
  return vec4(eq_tab(int(c.x), 0), eq_tab(int(c.y), 1), eq_tab(int(c.z), 2), c.a);
}
`;

/** A per-channel 256-entry RGB table (curves) from the step's aux texture. */
export const GLSL_TABLE_RGB = `
uniform sampler2D u_curves_tab;
float curves_tab(int i, int c) { return floor(texelFetch(u_curves_tab, ivec2(i, 0), 0)[c] * 255.0 + 0.5); }
vec4 op_curves(vec4 c, ivec2 p, int dom) {
  return vec4(curves_tab(int(c.r), 0), curves_tab(int(c.g), 1), curves_tab(int(c.b), 2), c.a);
}
`;

/** colorbalance (preserve lightness off): vf_colorbalance.c get_component in float, lrintf back. */
export const GLSL_COLORBALANCE = `
uniform vec3 u_cb_s;
uniform vec3 u_cb_m;
uniform vec3 u_cb_h;
float cb_comp(float v, float l, float s, float m, float h) {
  s *= clamp((0.333 - l) * 4.0 + 0.5, 0.0, 1.0) * 0.7;
  m *= clamp((l - 0.333) * 4.0 + 0.5, 0.0, 1.0) * clamp((1.0 - l - 0.333) * 4.0 + 0.5, 0.0, 1.0) * 0.7;
  h *= clamp((l + 0.333 - 1.0) * 4.0 + 0.5, 0.0, 1.0) * 0.7;
  v += s;
  v += m;
  v += h;
  return clamp(v, 0.0, 1.0);
}
vec4 op_cb(vec4 c, ivec2 p, int dom) {
  vec3 v = c.rgb / 255.0;
  float l = max(max(v.r, v.g), v.b) + min(min(v.r, v.g), v.b);
  vec3 o = vec3(cb_comp(v.r, l, u_cb_s.r, u_cb_m.r, u_cb_h.r), cb_comp(v.g, l, u_cb_s.g, u_cb_m.g, u_cb_h.g), cb_comp(v.b, l, u_cb_s.b, u_cb_m.b, u_cb_h.b));
  return vec4(clamp(roundEven(o * 255.0), 0.0, 255.0), c.a);
}
`;

/** hue=h on yuva444p: vf_hue.c's Q16 rotation of (U, V) (u_cs = cos, sin). */
export const GLSL_HUE = `
uniform ivec2 u_hue_cs;
vec4 op_hue(vec4 c, ivec2 p, int dom) {
  int u = int(c.y) - 128, v = int(c.z) - 128;
  int nu = (u_hue_cs.x * u - u_hue_cs.y * v + 32768 + (128 << 16)) >> 16;
  int nv = (u_hue_cs.y * u + u_hue_cs.x * v + 32768 + (128 << 16)) >> 16;
  return vec4(c.x, clamp(float(nu), 0.0, 255.0), clamp(float(nv), 0.0, 255.0), c.a);
}
`;

/**
 * lut3d (interp=tetrahedral, its default) on packed RGB: u_lut3 holds the
 * .cube table (x = red, y = green, z = blue); 8-bit in × (1/255) × scale ×
 * (size − 1), the six-tetrahedra interpolation of vf_lut3d.c, truncated out.
 */
export const GLSL_LUT3D = `
uniform highp sampler3D u_lut3d_cube;
uniform vec3 u_lut3d_scale;
uniform float u_lut3d_max;
vec3 lut3d_at(int r, int g, int b) { return texelFetch(u_lut3d_cube, ivec3(r, g, b), 0).rgb; }
vec4 op_lut3d(vec4 c, ivec2 p, int dom) {
  vec3 s = clamp(c.rgb * (1.0 / 255.0) * u_lut3d_scale, 0.0, u_lut3d_max);
  ivec3 pv = ivec3(s);
  ivec3 nx = min(pv + 1, ivec3(int(u_lut3d_max)));
  vec3 d = s - vec3(pv);
  vec3 c000 = lut3d_at(pv.x, pv.y, pv.z), c111 = lut3d_at(nx.x, nx.y, nx.z), o;
  if (d.r > d.g) {
    if (d.g > d.b) {
      vec3 c100 = lut3d_at(nx.x, pv.y, pv.z), c110 = lut3d_at(nx.x, nx.y, pv.z);
      o = (1.0 - d.r) * c000 + (d.r - d.g) * c100 + (d.g - d.b) * c110 + d.b * c111;
    } else if (d.r > d.b) {
      vec3 c100 = lut3d_at(nx.x, pv.y, pv.z), c101 = lut3d_at(nx.x, pv.y, nx.z);
      o = (1.0 - d.r) * c000 + (d.r - d.b) * c100 + (d.b - d.g) * c101 + d.g * c111;
    } else {
      vec3 c001 = lut3d_at(pv.x, pv.y, nx.z), c101 = lut3d_at(nx.x, pv.y, nx.z);
      o = (1.0 - d.b) * c000 + (d.b - d.r) * c001 + (d.r - d.g) * c101 + d.g * c111;
    }
  } else {
    if (d.b > d.g) {
      vec3 c001 = lut3d_at(pv.x, pv.y, nx.z), c011 = lut3d_at(pv.x, nx.y, nx.z);
      o = (1.0 - d.b) * c000 + (d.b - d.g) * c001 + (d.g - d.r) * c011 + d.r * c111;
    } else if (d.b > d.r) {
      vec3 c010 = lut3d_at(pv.x, nx.y, pv.z), c011 = lut3d_at(pv.x, nx.y, nx.z);
      o = (1.0 - d.g) * c000 + (d.g - d.b) * c010 + (d.b - d.r) * c011 + d.r * c111;
    } else {
      vec3 c010 = lut3d_at(pv.x, nx.y, pv.z), c110 = lut3d_at(nx.x, nx.y, pv.z);
      o = (1.0 - d.g) * c000 + (d.g - d.r) * c010 + (d.r - d.b) * c110 + d.b * c111;
    }
  }
  return vec4(tr8(o * 255.0), c.a);
}
`;

/**
 * The source-colour correction (first op of a layer whose file Chromium reads
 * with another matrix or range than the export: @aive/core/colorspace
 * previewColorFix): an affine RGB → RGB map in 8-bit levels, one row per
 * channel ([m0, m1, m2, offset]), rounded and clamped like a pass write.
 */
export const GLSL_SRCFIX = `
uniform vec4 u_srcfix_r;
uniform vec4 u_srcfix_g;
uniform vec4 u_srcfix_b;
vec4 op_srcfix(vec4 c, ivec2 p, int dom) {
  vec3 o = vec3(dot(u_srcfix_r.xyz, c.rgb), dot(u_srcfix_g.xyz, c.rgb), dot(u_srcfix_b.xyz, c.rgb)) + vec3(u_srcfix_r.w, u_srcfix_g.w, u_srcfix_b.w);
  return vec4(clamp(floor(o + 0.5), 0.0, 255.0), c.a);
}
`;

// ---- parameter math -------------------------------------------------------------

const clampN = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const f32 = Math.fround;
/** graph.ts's 6-decimal number format. */
const num6 = (n: number): string => (Number.isFinite(n) ? n.toFixed(6) : "0");

/** True when the clip's eq step exists (graph.ts emits eq whenever `color` is set). */
export function hasEq(c: ColorAdjust | undefined): c is ColorAdjust {
  return !!c;
}

/** One vf_eq.c parameter set → its 256-entry table (process_c or the gamma LUT), or null = copy. */
function eqTable(contrast: number, brightness: number, gamma: number): Uint8Array | null {
  if (contrast === 1 && brightness === 0 && gamma === 1) return null;
  const t = new Uint8Array(256);
  if (gamma === 1 && Math.abs(contrast) < 7.9) {
    const C = Math.trunc(contrast * 256 * 16);
    const B = Math.trunc((Math.trunc(100 * brightness + 100) * 511) / 200) - 128 - Math.trunc(C / 32);
    for (let v = 0; v < 256; v++) {
      const pel = ((v * C) >> 12) + B;
      t[v] = pel < 0 ? 0 : pel > 255 ? 255 : pel;
    }
    return t;
  }
  const g = 1 / gamma;
  for (let i = 0; i < 256; i++) {
    let v = contrast * (i / 255 - 0.5) + 0.5 + brightness;
    if (v <= 0) t[i] = 0;
    else {
      v = Math.pow(v, g); // gamma_weight 1: v·0 + pow(v, g)·1
      t[i] = v >= 1 ? 255 : Math.trunc(256 * v);
    }
  }
  return t;
}

/** vf_eq.c's av_clipf: the double option clamped IN FLOAT, so the stored value is float-rounded. */
const clipf = (v: number, lo: number, hi: number): number => {
  const a = f32(v);
  return a < f32(lo) ? f32(lo) : a > f32(hi) ? f32(hi) : a;
};

/**
 * The eq step's Y / U / V tables (r / g / b of a 256×1 RGBA texture), from
 * the values graph.ts writes (`eq=brightness=…:contrast=…:saturation=…:gamma=…`,
 * plain JS number strings) clamped like vf_eq.c — through av_clipf, so each
 * parameter is rounded to float first (brightness 0.35 → 0.3499999940…, and
 * process_c's (int)(100·b + 100) gives 134, not 135). U and V use the
 * saturation as their contrast with brightness 0 (and gamma 1, since
 * gamma_r/g/b are 1).
 */
export function eqTables(c: ColorAdjust): Uint8Array {
  const brightness = clipf(Number(String(c.brightness ?? 0)), -1, 1);
  const contrast = clipf(Number(String(c.contrast ?? 1)), -1000, 1000);
  const saturation = clipf(Number(String(c.saturation ?? 1)), 0, 3);
  const gamma = clipf(Number(String(c.gamma ?? 1)), 0.1, 10);
  const y = eqTable(contrast, brightness, gamma);
  const uv = eqTable(saturation, 0, 1);
  const out = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) {
    out[i * 4] = y ? y[i] : i;
    out[i * 4 + 1] = uv ? uv[i] : i;
    out[i * 4 + 2] = uv ? uv[i] : i;
    out[i * 4 + 3] = 255;
  }
  return out;
}

export interface BalanceParams {
  /** Shadows / midtones / highlights, each [r, g, b], as FFmpeg's float options. */
  s: [number, number, number];
  m: [number, number, number];
  h: [number, number, number];
}

/**
 * graph.ts colorGradeSteps' colorbalance: lift / gamma / gain wheels with the
 * white balance folded into every range (warm = +red −blue, tint = −green,
 * × 0.3), clamped to ±1; null when every value is within 1e-4 of 0 (no step).
 */
export function balanceParams(grade: ColorGrade): BalanceParams | null {
  const temp = grade.temperature ?? 0;
  const tint = grade.tint ?? 0;
  const wheel = (w: RGBWheel | undefined) => ({ r: w?.r ?? 0, g: w?.g ?? 0, b: w?.b ?? 0 });
  const lift = wheel(grade.lift);
  const mid = wheel(grade.gamma);
  const gain = wheel(grade.gain);
  const wbR = temp * 0.3;
  const wbB = -temp * 0.3;
  const wbG = -tint * 0.3;
  const vals = [
    lift.r + wbR, lift.g + wbG, lift.b + wbB,
    mid.r + wbR, mid.g + wbG, mid.b + wbB,
    gain.r + wbR, gain.g + wbG, gain.b + wbB,
  ].map((v) => clampN(v, -1, 1));
  if (!vals.some((v) => Math.abs(v) > 1e-4)) return null;
  const o = vals.map((v) => f32(Number(num6(v))));
  return { s: [o[0], o[1], o[2]], m: [o[3], o[4], o[5]], h: [o[6], o[7], o[8]] };
}

/** hue=h=deg: vf_hue.c's lrint(cos/sin(h)·65536·saturation 1), h from the float option; null = no step. */
export function hueParams(grade: ColorGrade): [number, number] | null {
  if (grade.hue === undefined || !(Math.abs(grade.hue) > 1e-4)) return null;
  const deg = f32(Number(num6(clampN(grade.hue, -360, 360))));
  const h = (deg * Math.PI) / 180;
  return [Math.round(Math.cos(h) * 65536), Math.round(Math.sin(h) * 65536)];
}

/** graph.ts safeCurve: only digits, dot, slash and space survive, whitespace collapsed. */
export function safeCurve(pts: string): string {
  return pts.replace(/[^0-9./\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** av_strtod on the curve alphabet: the longest float prefix after whitespace. */
function strtod(s: string, i: number): [number, number] {
  let j = i;
  while (j < s.length && /\s/.test(s[j])) j++;
  const m = /^[+-]?(\d+\.?\d*|\.\d+)?/.exec(s.slice(j));
  const text = m?.[0] ?? "";
  if (!text || !/\d/.test(text)) return [0, i];
  return [Number(text), j + text.length];
}

/**
 * vf_curves.c parse_points_str (8-bit): "x/y x/y …" → key points, or null when
 * FFmpeg would refuse the string (a value outside [0,1], or x not strictly
 * increasing on the 255 grid).
 */
export function parseCurvePoints(str: string): { x: number; y: number }[] | null {
  const pts: { x: number; y: number }[] = [];
  let i = 0;
  while (i < str.length) {
    let x: number;
    let y: number;
    [x, i] = strtod(str, i);
    if (i < str.length) i++;
    [y, i] = strtod(str, i);
    if (i < str.length) i++;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    const last = pts[pts.length - 1];
    if (last && Math.trunc(last.x * 255) >= Math.trunc(x * 255)) return null;
    pts.push({ x, y });
  }
  return pts;
}

/** vf_curves.c interpolate (8-bit): natural cubic spline through the points → a 256-entry table. */
export function curveTable(points: { x: number; y: number }[]): Uint8Array {
  const y = new Uint8Array(256);
  const scale = 255;
  const clip = (v: number) => clampN(Math.trunc(v), 0, 255);
  const n = points.length;
  if (n === 0) {
    for (let i = 0; i < 256; i++) y[i] = i;
    return y;
  }
  if (n === 1) {
    for (let i = 0; i < 256; i++) y[i] = clip(points[0].y * scale);
    return y;
  }
  const h: number[] = [];
  for (let i = 0; i < n - 1; i++) h.push(points[i + 1].x - points[i].x);
  const r = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const [yp, yc, yn] = [points[i - 1].y, points[i].y, points[i + 1].y];
    r[i] = 6 * ((yn - yc) / h[i] - (yc - yp) / h[i - 1]);
  }
  const BD = 0, MD = 1, AD = 2;
  const matrix = Array.from({ length: n }, () => [0, 0, 0]);
  matrix[0][MD] = matrix[n - 1][MD] = 1;
  for (let i = 1; i < n - 1; i++) {
    matrix[i][BD] = h[i - 1];
    matrix[i][MD] = 2 * (h[i - 1] + h[i]);
    matrix[i][AD] = h[i];
  }
  for (let i = 1; i < n; i++) {
    const den = matrix[i][MD] - matrix[i][BD] * matrix[i - 1][AD];
    const k = den ? 1 / den : 1;
    matrix[i][AD] *= k;
    r[i] = (r[i] - matrix[i][BD] * r[i - 1]) * k;
  }
  for (let i = n - 2; i >= 0; i--) r[i] = r[i] - matrix[i][AD] * r[i + 1];

  for (let i = 0; i < Math.trunc(points[0].x * scale); i++) y[i] = clip(points[0].y * scale);
  for (let i = 0; i < n - 1; i++) {
    const yc = points[i].y;
    const yn = points[i + 1].y;
    const a = yc;
    const b = (yn - yc) / h[i] - (h[i] * r[i]) / 2 - (h[i] * (r[i + 1] - r[i])) / 6;
    const c = r[i] / 2;
    const d = (r[i + 1] - r[i]) / (6 * h[i]);
    const xs = Math.trunc(points[i].x * scale);
    const xe = Math.trunc(points[i + 1].x * scale);
    for (let x = xs; x <= xe; x++) {
      const xx = (x - xs) * (1 / scale);
      y[x] = clip((a + b * xx + c * xx * xx + d * xx * xx * xx) * scale);
    }
  }
  for (let i = Math.trunc(points[n - 1].x * scale); i < 256; i++) y[i] = clip(points[n - 1].y * scale);
  return y;
}

/**
 * The curves steps graph.ts emits — `curves=all='…'` then `curves=r=…:g=…:b=…`
 * — folded into ONE per-channel table (r / g / b of a 256×1 RGBA texture);
 * null when there is no curve step (or FFmpeg would reject the points).
 */
export function curvesTables(grade: ColorGrade): Uint8Array | null {
  const parse = (s: string | undefined) => {
    const c = s ? safeCurve(s) : "";
    return c ? parseCurvePoints(c) : undefined;
  };
  const all = parse(grade.curve);
  const chans = [parse(grade.curveR), parse(grade.curveG), parse(grade.curveB)];
  if (all === null || chans.some((c) => c === null)) return null;
  if (!all && chans.every((c) => !c)) return null;
  const allT = all ? curveTable(all) : null;
  const chT = chans.map((c) => (c ? curveTable(c) : null));
  const out = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) {
    for (let ch = 0; ch < 3; ch++) {
      const v = allT ? allT[i] : i;
      out[i * 4 + ch] = chT[ch] ? chT[ch]![v] : v;
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}

export interface CubeLut {
  size: number;
  /** size³ RGB triples, red fastest (x = red, y = green, z = blue). */
  data: Float32Array;
  /** lut3d's input scale per channel: clip(1 / (DOMAIN_MAX − DOMAIN_MIN), 0, 1). */
  scale: [number, number, number];
}

/**
 * Parse a .cube like FFmpeg 4.4's lut3d (parse_cube): lines before
 * LUT_3D_SIZE are ignored, then size³ "r g b" lines (comments, blanks, TITLE
 * and DOMAIN_MIN/MAX lines between them are skipped / read). Values are
 * floats. Null for a file lut3d would reject (no 3D size, size outside 2..256,
 * a short or malformed table).
 */
export function parseCube(text: string): CubeLut | null {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i].startsWith("LUT_3D_SIZE")) i++;
  if (i >= lines.length) return null;
  const size = parseInt(lines[i].slice(12).trim(), 10);
  if (!Number.isFinite(size) || size < 2 || size > 256) return null;
  i++;
  const min = [0, 0, 0];
  const max = [1, 1, 1];
  const n = size * size * size;
  const data = new Float32Array(n * 3);
  const skip = (l: string) => {
    const t = l.trimStart();
    return t === "" || t.startsWith("#");
  };
  for (let e = 0; e < n; e++) {
    for (;;) {
      if (i >= lines.length) return null;
      const l = lines[i++];
      if (l.startsWith("DOMAIN_")) {
        const vals = l.startsWith("DOMAIN_MIN ") ? min : l.startsWith("DOMAIN_MAX ") ? max : null;
        if (!vals) return null;
        const v = l.slice(11).trim().split(/\s+/).map(Number);
        if (v.length < 3 || v.slice(0, 3).some((x) => !Number.isFinite(x))) return null;
        vals[0] = f32(v[0]);
        vals[1] = f32(v[1]);
        vals[2] = f32(v[2]);
        continue;
      }
      if (l.startsWith("TITLE") || skip(l)) continue;
      const v = l.trim().split(/\s+/).map((s) => parseFloat(s));
      if (v.length < 3 || v.slice(0, 3).some((x) => !Number.isFinite(x))) return null;
      data[e * 3] = v[0];
      data[e * 3 + 1] = v[1];
      data[e * 3 + 2] = v[2];
      break;
    }
  }
  const sc = (k: number) => f32(clampN(1 / (max[k] - min[k]), 0, 1));
  return { size, data, scale: [sc(0), sc(1), sc(2)] };
}
