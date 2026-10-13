/**
 * GLSL ES 3.00 fragment-shader bodies for the effect registry's WebGL preview
 * (`EffectDef.preview.gl`). PURE strings, no imports, so the registry stays
 * importable by the renderer as `@aive/core/effects`.
 *
 * Every body is a port of the FFmpeg 4.4 filter its registry builder emits
 * (libavfilter/vf_*.c, release/4.4), down to the integer rounding, so the live
 * preview computes the same 8-bit values as the export wherever that is
 * possible. A program is "#version 300 es" + the renderer's #defines +
 * GL_PRELUDE + bodies + GL_MAIN. Two kinds of body:
 *
 *  - a HOST pass defines `vec4 fx(ivec2 p)`: the output pixel for texel `p`
 *    (row 0 = the picture's top row), reading its inputs with the helpers;
 *  - a POINT op (EffectGLPass.point) defines `vec4 op_<name>(vec4 c, ivec2 p,
 *    int dom)`: a function of one pixel value `c` (already in the op's domain
 *    `dom`) and its position. Every identifier a point body declares carries
 *    its own prefix, so the renderer can FUSE a run of point ops into the
 *    pass before them (fewer full-frame passes) with no renaming.
 *
 * The contract the renderer (apps/desktop/src/gl/) implements:
 *  - Values are 8-bit LEVELS (0..255 floats holding integers), straight
 *    (not premultiplied) alpha, in a colour DOMAIN: 0 = RGB, 1 = YUV =
 *    BT.601 limited range in r/g/b (what FFmpeg's yuv444p / yuva444p hold).
 *    `px(q)` reads the host input converted to the host's domain, `pxo(q)` the
 *    effect's input (before its first pass), `fpx(q)` a FLOAT intermediate raw
 *    and `hpx(q)` the per-layer history texture. Reads clamp to the edge.
 *  - Domains and output modes are compile-time #defines (IN_DOM, ORIG_DOM,
 *    DOM, END_DOM, OUT_RGB, FLOAT_OUT, FINAL, IN_FLOAT, HISTORY), so a
 *    program only runs the conversions it needs.
 *  - Every pass writes RGBA8 (the 8-bit requantisation between FFmpeg
 *    filters) unless it is a float pass, which writes raw floats; fused ops
 *    are clamped to 8 bits where that write would have been. Floats are
 *    stored bit for bit in RGBA32UI targets (floatBitsToUint), which core
 *    WebGL2 can render to without EXT_color_buffer_float; IN_FLOAT = 1 when
 *    u_in is such a target, HISTORY = 1 for a pass that reads u_hist.
 *  - `u_k` = processing pixels per canvas (export) pixel, `u_canvas` = the
 *    canvas size in export pixels, `u_seed` = the timeline frame number.
 */

/** Shared declarations and helpers, prepended to every body. */
export const GL_PRELUDE = `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
precision highp usampler2D;
#if IN_FLOAT == 1
uniform usampler2D u_in;
#else
uniform sampler2D u_in;
#endif
uniform sampler2D u_orig;
#if HISTORY == 1
uniform usampler2D u_hist;
#endif
uniform ivec2 u_size;
uniform float u_k;
uniform vec2 u_canvas;
uniform float u_seed;
#if FLOAT_OUT == 1
out uvec4 o_color;
#else
out vec4 o_color;
#endif
ivec2 SZ;

// swscale's RGB <-> BT.601 limited-range YUV for 8-bit RGBA <-> yuv444p, in its
// own fixed point (libswscale input.c rgb32ToY/UV with the default-colourspace
// coefficients; output.c yuv2rgb_write_full with yuv2rgb.c's table init).
// Bit-exact with FFmpeg 4.4 for all 2^24 colours, both ways. Out-of-gamut YUV
// (after an extreme eq) overflows yuv2rgb's 32-bit sum; FFmpeg's unsigned
// wrap + av_clip_uintp2 and highp int's two's-complement wrap + clamp agree
// (parity-gl.mts "eq extreme" cases).
vec3 rgb2yuv(vec3 c) {
  ivec3 q = ivec3(c);
  int y = (8414 * q.r + 16519 * q.g + 3208 * q.b + (16 << 15) + 256) >> 9;
  int u = (-4865 * q.r - 9528 * q.g + 14392 * q.b + (128 << 15) + 256) >> 9;
  int v = (14392 * q.r - 12061 * q.g - 2332 * q.b + (128 << 15) + 256) >> 9;
  return vec3((ivec3(y, u, v) + 32) >> 6);
}
vec3 yuv2rgb(vec3 c) {
  ivec3 q = ivec3(c);
  int y = ((q.x << 9) - 8192) * 9539 + (1 << 21);
  int u = (q.y - 128) << 9;
  int v = (q.z - 128) << 9;
  ivec3 o = ivec3(y + v * 13075, y - v * 6660 - u * 3209, y + u * 16525);
  return vec3(clamp(o, 0, (1 << 30) - 1) >> 22);
}
vec4 conv(vec4 c, int from, int to) {
  if (from == to) return c;
  return vec4(to == 1 ? rgb2yuv(c.rgb) : yuv2rgb(c.rgb), c.a);
}
vec4 raw(sampler2D s, ivec2 q) { return texelFetch(s, clamp(q, ivec2(0), SZ - 1), 0); }
vec4 lv(vec4 c) { return floor(c * 255.0 + 0.5); }
#if IN_FLOAT == 1
vec4 fpx(ivec2 q) { return uintBitsToFloat(texelFetch(u_in, clamp(q, ivec2(0), SZ - 1), 0)); }
vec4 px(ivec2 q) { return conv(fpx(q), IN_DOM, DOM); }
#else
vec4 px(ivec2 q) { return conv(lv(raw(u_in, q)), IN_DOM, DOM); }
vec4 fpx(ivec2 q) { return raw(u_in, q); }
#endif
vec4 pxo(ivec2 q) { return conv(lv(raw(u_orig, q)), ORIG_DOM, DOM); }
#if HISTORY == 1
vec4 hpx(ivec2 q) { return uintBitsToFloat(texelFetch(u_hist, clamp(q, ivec2(0), SZ - 1), 0)); }
#endif
// C's (int) conversion then av_clip_uint8.
float tr8(float v) { return clamp(trunc(v), 0.0, 255.0); }
vec3 tr8(vec3 v) { return clamp(trunc(v), 0.0, 255.0); }
// vf_premultiply.c premultiply8 / unpremultiply8 on the colour, alpha kept.
vec4 premul8(vec4 c) {
  int a = int(c.a);
  ivec3 m = ivec3(c.rgb);
  return vec4(vec3((m * (((a >> 1) & 1) + a) + 128) >> 8), c.a);
}
vec4 unpremul8(vec4 c) {
  int a = int(c.a);
  if (a <= 0 || a >= 255) return c;
  return vec4(min(vec3(ivec3(c.rgb) * 255 / a), vec3(255.0)), c.a);
}
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// Uniform [0,1) per (x, y, z).
float hash3(ivec3 q) {
  return float(pcg(uint(q.x) ^ pcg(uint(q.y) ^ pcg(uint(q.z)))) >> 8u) / 16777216.0;
}
`;

/** The entry point, appended after the body. */
export const GL_MAIN = `
void main() {
  SZ = u_size;
  ivec2 fc = ivec2(gl_FragCoord.xy);
#if FINAL == 1
  ivec2 p = ivec2(fc.x, SZ.y - 1 - fc.y);
#else
  ivec2 p = fc;
#endif
  vec4 c = fx(p);
#if FLOAT_OUT == 1
  o_color = floatBitsToUint(c);
#else
  c = clamp(c, 0.0, 255.0);
#if (OUT_RGB == 1 || FINAL != 0) && END_DOM == 1
  c.rgb = yuv2rgb(c.rgb);
#endif
  c /= 255.0;
#if FINAL == 1
  o_color = vec4(c.rgb * c.a, c.a);
#else
  o_color = c;
#endif
#endif
}
`;

/** Copy (domain conversion / output pass). */
export const GLSL_COPY = `
vec4 fx(ivec2 p) { return px(p); }
`;

/**
 * gblur (steps=1) is Alvarez–Mazorra's recursive filter: per row a causal
 * pass y[m] = x[m] + nu·y[m-1] (y[0] = x[0]/(1-nu)), then an anticausal pass
 * z[n] = y[n] + nu·z[n+1] (z[w-1] = y[w-1]/(1-nu)), rows then columns, then
 * × postscale, clipped and TRUNCATED to 8 bits. These are the same sums as
 * truncated FIR kernels (nu^k), including FFmpeg's edge terms, in float; the
 * tail past u_taps is folded into one edge-style term.
 * u_axis 0 = along x, 1 = along y; u_src 0 = 8-bit levels (premultiplied when
 * u_premul = 1, glow), 1 = float intermediate.
 */
export const GLSL_BLUR_CAUSAL = `
uniform float u_nu;
uniform float u_bscale;
uniform int u_taps;
uniform int u_axis;
uniform int u_src;
uniform int u_premul;
vec4 src(ivec2 q) {
  if (u_src == 1) return fpx(q);
  vec4 c = px(q);
  return u_premul == 1 ? premul8(c) : c;
}
vec4 fx(ivec2 p) {
  ivec2 d = u_axis == 0 ? ivec2(1, 0) : ivec2(0, 1);
  int m = u_axis == 0 ? p.x : p.y;
  int n = min(m, u_taps);
  vec4 acc = vec4(0.0);
  float w = 1.0;
  for (int k = 0; k < n; k++) { acc += w * src(p - d * k); w *= u_nu; }
  // FFmpeg's edge term (nu^m · x[0] / (1 − nu)) — or, past the taps, the same
  // closed form for the cut-off tail, which keeps flat areas exactly flat.
  acc += w * u_bscale * src(p - d * n);
  return acc;
}
`;

export const GLSL_BLUR_ANTI = `
uniform float u_nu;
uniform float u_bscale;
uniform int u_taps;
uniform int u_axis;
uniform int u_last;
uniform float u_postscale;
vec4 fx(ivec2 p) {
  ivec2 d = u_axis == 0 ? ivec2(1, 0) : ivec2(0, 1);
  int len = u_axis == 0 ? SZ.x : SZ.y;
  int m = u_axis == 0 ? p.x : p.y;
  int L = len - 1 - m;
  int n = min(L, u_taps);
  vec4 acc = vec4(0.0);
  float w = 1.0;
  for (int j = 0; j < n; j++) { acc += w * fpx(p + d * j); w *= u_nu; }
  acc += w * u_bscale * fpx(p + d * n);
  // + 1/1000: a flat area sums to its value give or take float rounding; FFmpeg
  // truncates the exact value.
  if (u_last == 1) return floor(clamp(acc * u_postscale + 0.001, 0.0, 255.0));
  return acc;
}
`;

/**
 * unsharp=5:5:amount:5:5:0 on yuv444p: luma minus a 5×5 binomial blur
 * ([1 4 6 4 1]², /256 rounded), × amount (Q16, arithmetic shift); chroma
 * untouched. Edges replicate (vf_unsharp.c). Separable here — the row sums
 * are integers below 2^12, exact in the float intermediate.
 * Pass 1: the horizontal [1 4 6 4 1] sum of the luma, in r.
 */
export const GLSL_UNSHARP_H = `
const int B5[5] = int[5](1, 4, 6, 4, 1);
// Just the luma of a neighbour (a third of rgb2yuv's work on an RGB input).
int lumaAt(ivec2 q) {
  vec4 c = lv(raw(u_in, q));
#if IN_DOM == 1
  return int(c.x);
#else
  ivec3 v = ivec3(c.rgb);
  return (((8414 * v.r + 16519 * v.g + 3208 * v.b + (16 << 15) + 256) >> 9) + 32) >> 6;
#endif
}
vec4 fx(ivec2 p) {
  int sum = 0;
  for (int dx = -2; dx <= 2; dx++) sum += B5[dx + 2] * lumaAt(p + ivec2(dx, 0));
  return vec4(float(sum), 0.0, 0.0, 0.0);
}
`;

/** unsharp pass 2: the vertical sum of the row sums, then the sharpen on the step input's luma. */
export const GLSL_UNSHARP_V = `
uniform int u_amount;
const int B5[5] = int[5](1, 4, 6, 4, 1);
vec4 fx(ivec2 p) {
  vec4 c = pxo(p);
  if (u_amount == 0) return c;
  int sum = 0;
  for (int dy = -2; dy <= 2; dy++) sum += B5[dy + 2] * int(fpx(p + ivec2(0, dy)).r);
  int y = int(c.x);
  int res = y + (((y - ((sum + 128) >> 8)) * u_amount) >> 16);
  return vec4(clamp(float(res), 0.0, 255.0), c.yzw);
}
`;

/** cas (contrast adaptive sharpening), per colour plane, alpha untouched (vf_cas.c cas_slice8). */
export const GLSL_CAS = `
uniform float u_strength;
vec4 fx(ivec2 p) {
  vec4 e4 = px(p);
  vec3 a = px(p + ivec2(-1, -1)).rgb, b = px(p + ivec2(0, -1)).rgb, c = px(p + ivec2(1, -1)).rgb;
  vec3 d = px(p + ivec2(-1, 0)).rgb, e = e4.rgb, f = px(p + ivec2(1, 0)).rgb;
  vec3 g = px(p + ivec2(-1, 1)).rgb, h = px(p + ivec2(0, 1)).rgb, i = px(p + ivec2(1, 1)).rgb;
  vec3 mn = min(min(min(d, e), min(f, b)), h);
  vec3 mn2 = min(min(min(mn, a), min(c, g)), i);
  mn += mn2;
  vec3 mx = max(max(max(d, e), max(f, b)), h);
  vec3 mx2 = max(max(max(mx, a), max(c, g)), i);
  mx += mx2;
  vec3 safe = max(mx, vec3(1.0));
  vec3 amp = sqrt(clamp(min(mn, 511.0 - mx) / safe, 0.0, 1.0));
  vec3 weight = amp / u_strength;
  vec3 r = tr8(((b + d + f + h) * weight + e) / (1.0 + 4.0 * weight));
  r = mix(r, e, vec3(equal(mx, vec3(0.0))));
  return vec4(r, e4.a);
}
`;

/**
 * hqdn3d (vf_hqdn3d.c, 8-bit) on yuv444p, in its 16-bit fixed point: a value
 * v is LOADed as (v << 8) + 127 and lowpass(prev, cur) = cur + coef[(prev −
 * cur) >> 4], the coefficient tables built by precalc_coefs (registry
 * hqdn3dCoefs, bound as u_dn_tab: 128×128 RGBA8, row block 0 spatial / 64
 * temporal, int16 luma in r/g and chroma in b/a). Spatially it is a causal
 * recursion along each row (H) and then down each column over H (V); a pass
 * can't run a whole-row recursion per pixel, so each pixel restarts it
 * DN_K pixels / rows back from the raw value — the weights fade within a few
 * steps (DN_K = 12: within a level or two of the full recursion). Then the
 * temporal step lowpasses V against the previous frame's state (the history;
 * on a clip's first frame, the frame's own LOADed values), and the output is
 * that state >> 8. Three passes: H (float), V + temporal (the history), out.
 */
const GLSL_DN_COMMON = `
uniform sampler2D u_dn_tab;
const int DN_K = 12;
int dn_coef(int t, int c, int d) {
  int i = clamp(d, -4096, 4095) + 4096;
  vec4 v = floor(texelFetch(u_dn_tab, ivec2(i & 127, (i >> 7) + 64 * t), 0) * 255.0 + 0.5);
  int r = c == 0 ? int(v.x) + 256 * int(v.y) : int(v.z) + 256 * int(v.w);
  return r >= 32768 ? r - 65536 : r;
}
// lowpass on Y (luma table) and U, V (chroma table); t 0 = spatial, 1 = temporal.
ivec3 dn_lp(ivec3 prev, ivec3 cur, int t) {
  ivec3 d = (prev - cur) >> 4;
  return cur + ivec3(dn_coef(t, 0, d.x), dn_coef(t, 1, d.y), dn_coef(t, 1, d.z));
}
ivec3 dn_load(vec3 c) { return (ivec3(c) << 8) + 127; }
`;

/** hqdn3d pass 1: the row recursion H (16-bit values, float out). Row 0 starts with lowpass(LOAD(0), LOAD(0)), as FFmpeg's first line does. */
export const GLSL_DN_H = `${GLSL_DN_COMMON}
vec4 fx(ivec2 p) {
  int x0 = max(0, p.x - DN_K);
  ivec3 s = dn_load(px(ivec2(x0, p.y)).rgb);
  if (x0 == 0 && p.y == 0) s = dn_lp(s, s, 0);
  for (int k = 1; k <= DN_K; k++) {
    int x = x0 + k;
    if (x > p.x) break;
    s = dn_lp(s, dn_load(px(ivec2(x, p.y)).rgb), 0);
  }
  return vec4(vec3(s), 0.0);
}
`;

/** hqdn3d pass 2 (the history): the column recursion over H, then the temporal lowpass against the previous state (u_reset: the input's own LOADed values). */
export const GLSL_DN_VT = `${GLSL_DN_COMMON}
uniform int u_reset;
vec4 fx(ivec2 p) {
  int y0 = max(0, p.y - DN_K);
  ivec3 v = ivec3(fpx(ivec2(p.x, y0)).rgb);
  for (int k = 1; k <= DN_K; k++) {
    int y = y0 + k;
    if (y > p.y) break;
    v = dn_lp(v, ivec3(fpx(ivec2(p.x, y)).rgb), 0);
  }
  ivec3 prev = u_reset == 1 ? dn_load(pxo(p).rgb) : ivec3(hpx(p).rgb);
  return vec4(vec3(dn_lp(prev, v, 1)), 0.0);
}
`;

/** hqdn3d pass 3: STORE (state >> 8), the step input's alpha (alphaSafe merges the original alpha back). */
export const GLSL_DN_OUT = `
vec4 fx(ivec2 p) { return vec4(vec3(ivec3(fpx(p).rgb) >> 8), pxo(p).a); }
`;

/** colorchannelmixer with a 3×3 matrix: each product lrint'ed (its LUTs), summed, clipped. Alpha kept. */
export const GLSL_MIXER = `
uniform vec3 u_mix_r;
uniform vec3 u_mix_g;
uniform vec3 u_mix_b;
vec4 op_mix(vec4 c, ivec2 p, int dom) {
  vec3 o = vec3(dot(roundEven(c.rgb * u_mix_r), vec3(1.0)), dot(roundEven(c.rgb * u_mix_g), vec3(1.0)), dot(roundEven(c.rgb * u_mix_b), vec3(1.0)));
  return vec4(clamp(o, 0.0, 255.0), c.a);
}
`;

/** hue=s=0 on yuva444p: U and V collapse to 128 (its fixed-point rotation with sin = cos = 0). */
export const GLSL_DESATURATE = `
vec4 op_desat(vec4 c, ivec2 p, int dom) { return vec4(c.x, 128.0, 128.0, c.a); }
`;

/**
 * vignette (natural, aspect 1, centre w/2 h/2) on rgb24: factor
 * cos(angle·d)^4 with d = hypot of the TRUNCATED integer offsets / hypot(w/2,
 * h/2), 0 past 1, in canvas pixels. FFmpeg adds a [0,1) dither before
 * truncating; the preview rounds (the same mean, at most 1 level apart).
 */
export const GLSL_VIGNETTE = `
uniform float u_vig_angle;
vec4 op_vig(vec4 c, ivec2 p, int dom) {
  vec2 q = (vec2(p) + 0.5) / u_k - 0.5;
  vec2 off = trunc(q - u_canvas * 0.5);
  float dn = length(off) / length(u_canvas * 0.5);
  float f = 0.0;
  if (dn <= 1.0) { float k = cos(u_vig_angle * dn); f = (k * k) * (k * k); }
  return vec4(floor(c.rgb * f + 0.5), c.a);
}
`;

/**
 * edgedetect pass 1: the fixed 5×5 Gaussian (sigma 1.4, /159 truncated) per
 * plane of gbrp; a 2-pixel border is copied (vf_edgedetect.c gaussian_blur).
 */
export const GLSL_EDGE_GAUSS = `
const int G5[25] = int[25](2, 4, 5, 4, 2,  4, 9, 12, 9, 4,  5, 12, 15, 12, 5,  4, 9, 12, 9, 4,  2, 4, 5, 4, 2);
vec4 fx(ivec2 p) {
  vec4 c = px(p);
  if (p.x < 2 || p.y < 2 || p.x >= SZ.x - 2 || p.y >= SZ.y - 2) return c;
  ivec3 s = ivec3(0);
  for (int dy = -2; dy <= 2; dy++)
    for (int dx = -2; dx <= 2; dx++)
      s += G5[(dy + 2) * 5 + dx + 2] * ivec3(px(p + ivec2(dx, dy)).rgb);
  return vec4(vec3(s / 159), c.a);
}
`;

/**
 * edgedetect pass 2 (float out): per plane of the blurred frame, the Sobel
 * magnitude |gx| + |gy| and its rounded direction (0..3) packed as mag·4 +
 * dir; off the frame's inner area (a 1-pixel border) mag 0 and dir 3, as
 * vf_edgedetect.c leaves them.
 */
export const GLSL_EDGE_SOBEL = `
bool inside(ivec2 q) { return q.x >= 1 && q.y >= 1 && q.x <= SZ.x - 2 && q.y <= SZ.y - 2; }
ivec3 G(ivec2 q) { return ivec3(px(q).rgb); }
vec4 fx(ivec2 p) {
  if (!inside(p)) return vec4(3.0, 3.0, 3.0, 0.0);
  ivec3 a = G(p + ivec2(-1, -1)), b = G(p + ivec2(0, -1)), c = G(p + ivec2(1, -1));
  ivec3 d = G(p + ivec2(-1, 0)), f = G(p + ivec2(1, 0));
  ivec3 g = G(p + ivec2(-1, 1)), h = G(p + ivec2(0, 1)), i = G(p + ivec2(1, 1));
  ivec3 gx = -a + c - 2 * d + 2 * f - g + i;
  ivec3 gy = -a + g - 2 * b + 2 * h - c + i;
  ivec3 mag = abs(gx) + abs(gy);
  ivec3 dir;
  for (int k = 0; k < 3; k++) {
    int X = gx[k], Y = gy[k], r = 3;
    if (X != 0) {
      if (X < 0) { X = -X; Y = -Y; }
      Y *= 65536;
      int t1 = 27146 * X, t3 = 158218 * X;
      if (Y > -t3 && Y < -t1) r = 0;
      else if (Y > -t1 && Y < t1) r = 2;
      else if (Y > t1 && Y < t3) r = 1;
    }
    dir[k] = r;
  }
  return vec4(vec3(mag * 4 + dir), 0.0);
}
`;

/**
 * edgedetect pass 3 (mode=colormix, low 20, high 50): non-maximum suppression
 * along each pixel's direction (clipped to 255), then 4.4's double threshold
 * — keep a value > high, or (off the frame border) > low with an 8-neighbour
 * > high, one step, no recursion — and the mix (edge + input) >> 1, the input
 * being the step's (before the Gaussian).
 */
export const GLSL_EDGE_NMS = `
bool inside(ivec2 q) { return q.x >= 1 && q.y >= 1 && q.x <= SZ.x - 2 && q.y <= SZ.y - 2; }
ivec3 MD(ivec2 q) { return ivec3(fpx(q).rgb); }
// The suppressed magnitude at q.
ivec3 nms(ivec2 q) {
  ivec3 o = ivec3(0);
  if (!inside(q)) return o;
  ivec3 md = MD(q);
  ivec3 v = md >> 2;
  ivec3 d = md & 3;
  for (int c = 0; c < 3; c++) {
    ivec2 a, b;
    if (d[c] == 0) { a = ivec2(-1, 1); b = ivec2(1, -1); }
    else if (d[c] == 1) { a = ivec2(-1, -1); b = ivec2(1, 1); }
    else if (d[c] == 2) { a = ivec2(-1, 0); b = ivec2(1, 0); }
    else { a = ivec2(0, -1); b = ivec2(0, 1); }
    if (v[c] > (MD(q + a)[c] >> 2) && v[c] > (MD(q + b)[c] >> 2)) o[c] = min(v[c], 255);
  }
  return o;
}
vec4 fx(ivec2 p) {
  vec4 o = pxo(p);
  ivec3 edge = ivec3(0);
  if (inside(p)) {
    ivec3 n0 = nms(p);
    ivec3 strong = ivec3(0);
    for (int dy = -1; dy <= 1; dy++)
      for (int dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) continue;
        strong = max(strong, ivec3(greaterThan(nms(p + ivec2(dx, dy)), ivec3(50))));
      }
    for (int c = 0; c < 3; c++) {
      if (n0[c] > 50 || (n0[c] > 20 && strong[c] == 1)) edge[c] = n0[c];
    }
  }
  return vec4(vec3((edge + ivec3(o.rgb)) >> 1), o.a);
}
`;

/** A 256-entry per-value table (u_lut, 4 entries per vec4), the same for r/g/b — lutrgb (posterize). */
export const GLSL_LUT256 = `
uniform vec4 u_lut256[64];
float lut256_at(float v) { int i = int(v); return u_lut256[i >> 2][i & 3]; }
vec4 op_lut256(vec4 c, ivec2 p, int dom) { return vec4(lut256_at(c.r), lut256_at(c.g), lut256_at(c.b), c.a); }
`;

/**
 * pixelate: scale=w2:h2:flags=neighbor then back to the canvas size, both
 * through swscale's RGB path, reproduced bit for bit: point sampling picks
 * src = (i·inc + inc/2) >> 16 per axis (inc = ((src<<16) + dst/2) / dst);
 * RGB goes to 14-bit YUV, and on the way DOWN the chroma is read at half
 * width from pixel PAIRS (rgb32ToUV_half) on its own grid (u_cinc1), then
 * yuv2rgb_write_full brings it back; the way up converts the small image
 * again (full chroma). A YUV input (after eq) is point-sampled per plane.
 */
export const GLSL_PIXELATE = `
uniform ivec2 u_inc1;
uniform ivec2 u_inc2;
uniform int u_cinc1;
ivec3 yuv14(vec3 c) {
  ivec3 q = ivec3(c);
  return ivec3((8414 * q.r + 16519 * q.g + 3208 * q.b + (16 << 15) + 256) >> 9,
               (-4865 * q.r - 9528 * q.g + 14392 * q.b + (128 << 15) + 256) >> 9,
               (14392 * q.r - 12061 * q.g - 2332 * q.b + (128 << 15) + 256) >> 9);
}
ivec2 uv14half(vec3 a, vec3 b) {
  ivec3 q = ivec3(a) + ivec3(b);
  return ivec2((-4865 * q.r - 9528 * q.g + 14392 * q.b + (256 << 15) + 512) >> 10,
               (14392 * q.r - 12061 * q.g - 2332 * q.b + (256 << 15) + 512) >> 10);
}
// yuv2rgb_write_full on swscale's 15-bit intermediates.
vec3 rgb15(ivec3 c) {
  int y = (c.x * 4 - 8192) * 9539 + (1 << 21);
  int u = (c.y - (128 << 7)) * 4;
  int v = (c.z - (128 << 7)) * 4;
  ivec3 o = ivec3(y + v * 13075, y - v * 6660 - u * 3209, y + u * 16525);
  return vec3(clamp(o, 0, (1 << 30) - 1) >> 22);
}
vec4 fx(ivec2 p) {
  ivec2 s = (p * u_inc2 + (u_inc2 >> 1)) >> 16;
  ivec2 l = min((s * u_inc1 + (u_inc1 >> 1)) >> 16, SZ - 1);
  vec4 c = px(l);
  if (DOM == 1) return c;
  int ci = (s.x * u_cinc1 + (u_cinc1 >> 1)) >> 16;
  vec3 c0 = px(ivec2(min(2 * ci, SZ.x - 1), l.y)).rgb;
  vec3 c1 = px(ivec2(min(2 * ci + 1, SZ.x - 1), l.y)).rgb;
  vec3 small = rgb15(ivec3(yuv14(c.rgb).x, uv14half(c0, c1)) * 2);
  return vec4(rgb15(yuv14(small) * 2), c.a);
}
`;

/**
 * colorkey: alpha_k = clip((diff − similarity) / blend)·255 truncated, diff =
 * sqrt(Σ(c−k)² / (255²·3)) on 8-bit RGB; the key alpha MULTIPLIES the
 * source alpha (blend c3_mode=multiply: a·k/255 truncated). Colour untouched.
 */
export const GLSL_KEY_COLOR = `
uniform vec3 u_ckey_key;
uniform vec2 u_ckey_sb;
float ckey_ramp(float diff) {
  return u_ckey_sb.y > 0.0001 ? trunc(clamp((diff - u_ckey_sb.x) / u_ckey_sb.y, 0.0, 1.0) * 255.0) : (diff > u_ckey_sb.x ? 255.0 : 0.0);
}
vec4 op_ckey(vec4 c, ivec2 p, int dom) {
  vec3 d = c.rgb - u_ckey_key;
  float k = ckey_ramp(sqrt(dot(d, d) / (255.0 * 255.0 * 3.0)));
  return vec4(c.rgb, floor(c.a * k / 255.0));
}
`;

/**
 * chromakey on yuva444p: diff = mean over the 3×3 neighbourhood of
 * sqrt((du² + dv²) / (255²·2)), pixel U/V from the RGB→YUV conversion, key
 * U/V from the filter's own full-range macro (u_key). The export gives the
 * keyed frame a 1-px edge-smeared border first (registry keyStep), so border
 * taps clamp to the edge, as px() reads do. Despill (u_spill.x = amount, .y =
 * 1 green / 2 blue) runs on the keyed copy, whose colour went through
 * yuva444p, and then supplies the colour (despill mix 0.5, expand 0).
 */
export const GLSL_KEY_CHROMA = `
uniform vec2 u_key;
uniform vec2 u_sb;
uniform vec2 u_spill;
float ramp(float diff) {
  return u_sb.y > 0.0001 ? trunc(clamp((diff - u_sb.x) / u_sb.y, 0.0, 1.0) * 255.0) : (diff > u_sb.x ? 255.0 : 0.0);
}
vec4 fx(ivec2 p) {
  vec4 c = px(p);
  float diff = 0.0;
  for (int dy = -1; dy <= 1; dy++)
    for (int dx = -1; dx <= 1; dx++) {
      vec2 d = rgb2yuv(px(p + ivec2(dx, dy)).rgb).yz - u_key;
      diff += sqrt(dot(d, d) / (255.0 * 255.0 * 2.0));
    }
  float k = ramp(diff / 9.0);
  vec3 rgb = c.rgb;
  if (u_spill.x > 0.0 && u_spill.y > 0.5) {
    vec3 f = yuv2rgb(rgb2yuv(c.rgb)) / 255.0;
    float spill = u_spill.y < 1.5 ? max(f.g - (f.r * 0.5 + f.b * 0.5), 0.0) : max(f.b - (f.r * 0.5 + f.g * 0.5), 0.0);
    if (u_spill.y < 1.5) f.g = max(f.g - spill * u_spill.x, 0.0);
    else f.b = max(f.b - spill * u_spill.x, 0.0);
    rgb = tr8(f * 255.0);
  }
  return vec4(rgb, floor(c.a * k / 255.0));
}
`;

/**
 * lumakey on yuva444p luma (after lutrgb=a=maxval): Y in [black, white] →
 * 0; within softness of the band → ramped with integer division; else 255.
 * u_band = (black, white, softness), all 0..255 integers.
 */
export const GLSL_KEY_LUMA = `
uniform vec3 u_lkey_band;
vec4 op_lkey(vec4 c, ivec2 p, int dom) {
  int y = int(rgb2yuv(c.rgb).x);
  int b = int(u_lkey_band.x), w = int(u_lkey_band.y), so = int(u_lkey_band.z);
  int k = 255;
  if (y >= b && y <= w) k = 0;
  else if (y > b - so && y < w + so) k = y < b ? 255 - (y - b + so) * 255 / so : (y - w) * 255 / so;
  return vec4(c.rgb, floor(c.a * float(k) / 255.0));
}
`;

/**
 * exposure on gbrapf32: (x/255 − black) · scale, back to 8 bits rounded.
 * (swscale's float → 8-bit conversion adds an ordered dither, so FFmpeg's
 * values sit within ±1 of this, by pixel position.)
 */
export const GLSL_EXPOSURE = `
uniform float u_expo_black;
uniform float u_expo_scale;
vec4 op_expo(vec4 c, ivec2 p, int dom) {
  vec3 v = (c.rgb / 255.0 - u_expo_black) * u_expo_scale;
  return vec4(floor(clamp(v, 0.0, 1.0) * 255.0 + 0.5), c.a);
}
`;

/**
 * vibrance (vf_vibrance.c, default luma coefficients and balance, alternate
 * off): each channel is pushed from the weighted luma by
 * 1 + I·(1 − sign·saturation), sign = −sign(I); truncated.
 */
export const GLSL_VIBRANCE = `
uniform float u_vib_intensity;
uniform float u_vib_sign;
vec4 op_vib(vec4 c, ivec2 p, int dom) {
  vec3 v = c.rgb / 255.0;
  float sat = max(max(v.r, v.g), v.b) - min(min(v.r, v.g), v.b);
  float luma = v.g * 0.715158 + v.r * 0.072186 + v.b * 0.212656;
  float k = 1.0 + u_vib_intensity * (1.0 - u_vib_sign * sat);
  v = luma + (v - luma) * k;
  return vec4(tr8(v * 255.0), c.a);
}
`;

/**
 * negate (lut negval): RGB 255 − v; on YUV clip(min + max − v) with the
 * limited ranges (Y 16..235, U/V 16..240). Alpha untouched.
 */
export const GLSL_NEGATE = `
vec4 op_neg(vec4 c, ivec2 p, int dom) {
  if (dom == 1) return vec4(clamp(251.0 - c.x, 16.0, 235.0), clamp(256.0 - c.yz, 16.0, 240.0), c.a);
  return vec4(255.0 - c.rgb, c.a);
}
`;

/**
 * colorhold: t = colorkey's ramp (0 = the kept colour), and where t > 0 the
 * pixel moves toward its integer grey (r+g+b)/3: (a·t + c·(255−t) + 127) >> 8.
 */
export const GLSL_COLORHOLD = `
uniform vec3 u_hold_key;
uniform vec2 u_hold_sb;
vec4 op_hold(vec4 c, ivec2 p, int dom) {
  vec3 d = c.rgb - u_hold_key;
  float diff = sqrt(dot(d, d) / (255.0 * 255.0 * 3.0));
  int t = u_hold_sb.y > 0.0001 ? int(trunc(clamp((diff - u_hold_sb.x) / u_hold_sb.y, 0.0, 1.0) * 255.0)) : (diff > u_hold_sb.x ? 255 : 0);
  if (t <= 0) return c;
  ivec3 m = ivec3(c.rgb);
  int a = (m.r + m.g + m.b) / 3;
  return vec4(vec3((a * t + m * (255 - t) + 127) >> 8), c.a);
}
`;

/**
 * noise=alls=N:allf=t+u: every colour value gets an integer offset uniform in
 * [−N/2, N − 1 − N/2], fresh each frame (u_seed). FFmpeg draws it from a fixed
 * LFG table with random per-line shifts; the preview draws the same
 * distribution from a hash, so the grain matches in strength and character,
 * not pixel for pixel. The export then ends in 4:2:0, which averages the
 * grain's COLOUR over each 2×2 block while its luma stays per pixel; the
 * preview does the same to its noise (the block's mean noise plus this
 * pixel's own BT.601 luma deviation), so the grain is as strong and as
 * colourful as in the render.
 */
export const GLSL_NOISE = `
uniform int u_noise_strength;
vec3 noise_at(ivec2 q, int s) {
  vec3 n;
  for (int i = 0; i < 3; i++) n[i] = float(min(int(hash3(ivec3(q, int(u_seed) * 4 + i)) * float(s)), s - 1) - s / 2);
  return n;
}
vec4 op_noise(vec4 c, ivec2 p, int dom) {
  int s = u_noise_strength;
  ivec2 b = (p >> 1) << 1;
  vec3 n00 = noise_at(b, s), n10 = noise_at(b + ivec2(1, 0), s);
  vec3 n01 = noise_at(b + ivec2(0, 1), s), n11 = noise_at(b + ivec2(1, 1), s);
  vec3 mean = (n00 + n10 + n01 + n11) * 0.25;
  ivec2 o = p - b;
  vec3 own = o.y == 0 ? (o.x == 0 ? n00 : n10) : (o.x == 0 ? n01 : n11);
  vec3 n = mean + dot(own - mean, vec3(0.299, 0.587, 0.114));
  return vec4(clamp(floor(c.rgb + n + 0.5), 0.0, 255.0), c.a);
}
`;

/**
 * glow's last step: blend=all_mode=screen:all_opacity on 8-bit planes — top =
 * the original (u_orig), bottom = its premultiplied blur (u_in):
 * top + (255 − (255−A)(255−B)/255 − top)·opacity, truncated — then alphamerge
 * puts the original alpha back.
 */
export const GLSL_SCREEN = `
uniform float u_opacity;
vec4 fx(ivec2 p) {
  vec4 a = pxo(p);
  vec4 b = px(p);
  ivec3 A = ivec3(a.rgb), B = ivec3(b.rgb);
  vec3 s = vec3(255 - (255 - A) * (255 - B) / 255);
  return vec4(tr8(a.rgb + (s - a.rgb) * u_opacity), a.a);
}
`;

/**
 * rgbsplit: premultiply → rgbashift (red from (x−dx, y−dy), blue from
 * (x+dx, y+dy), edges smeared, alpha not shifted) → unpremultiply.
 */
export const GLSL_RGBSHIFT = `
uniform ivec2 u_shift;
vec4 fx(ivec2 p) {
  vec4 c = premul8(px(p));
  c.r = premul8(px(p - u_shift)).r;
  c.b = premul8(px(p + u_shift)).b;
  return unpremul8(c);
}
`;

/**
 * lenscorrection (i=bilinear, fc=black@0) on gbrap, in its own fixed point
 * (vf_lenscorrection.c calc_correction + the bilinear slice): centre (int)(w/2),
 * (int)(h/2); r2 = (off²·r2inv + 2^31) >> 32 with r2inv = 2^62 / (w² + h²)
 * (u_r2inv, hi/lo), r4 = (r2² + 2^27) >> 28, radius_mult = (r2·k1 + r4·k2 +
 * 2^27 + 2^52) >> 28 with k = (int)(k·2^24) — int64 math, emulated here on
 * 32-bit halves (a float version lands on the neighbouring source pixel now
 * and then); the source is centre + ((rm·off + 2^23) >> 24), blended toward
 * +1 by the low 24 bits (FFmpeg's own half-pixel quirk, mirrored for a
 * negative offset); outside the frame → transparent. Every plane, alpha
 * included. With zoom-to-fill (u_lens_fill = 1) the zoom pass after it only
 * reads pixels that map inside the frame (registry lensFillScale keeps a
 * margin); the rest are clamped instead of cleared, so a preview at a smaller
 * processing size can't show a stray transparent corner pixel either.
 */
export const GLSL_LENS = `
uniform uvec2 u_r2inv;
uniform int u_k1i;
uniform int u_k2i;
uniform int u_lens_fill;
// 32×32 → 64-bit unsigned product (hi, lo) on 16-bit limbs.
uvec2 lens_mul(uint a, uint b) {
  uint a0 = a & 0xFFFFu, a1 = a >> 16, b0 = b & 0xFFFFu, b1 = b >> 16;
  uint p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;
  uint mid = p01 + p10;
  uint midc = mid < p01 ? 1u : 0u;
  uint lo = p00 + (mid << 16);
  uint loc = lo < p00 ? 1u : 0u;
  return uvec2(p11 + (mid >> 16) + (midc << 16) + loc, lo);
}
uvec2 lens_add(uvec2 a, uvec2 b) {
  uint lo = a.y + b.y;
  return uvec2(a.x + b.x + (lo < a.y ? 1u : 0u), lo);
}
// unsigned × signed → two's-complement 64-bit.
uvec2 lens_smul(uint a, int k) {
  uvec2 m = lens_mul(a, uint(abs(k)));
  return k < 0 ? lens_add(uvec2(~m.x, ~m.y), uvec2(0u, 1u)) : m;
}
// (rm·o + 2^23): its >> 24 (x) and & (2^24 − 1) (y), for |o| <= 2048 and |rm| < 2^27.
ivec2 lens_pos(int rm, int o) {
  int a = (rm >> 12) * o;
  int b = ((a & 4095) << 12) + (rm & 4095) * o + (1 << 23);
  return ivec2((a >> 12) + (b >> 24), b & 0xFFFFFF);
}
vec4 fx(ivec2 p) {
  ivec2 ctr = SZ / 2;
  ivec2 off = p - ctr;
  uint off2 = uint(off.x * off.x + off.y * off.y);
  uvec2 t = lens_mul(off2, u_r2inv.y);
  uint tl = t.y + 0x80000000u;
  uint r2 = t.x + off2 * u_r2inv.x + (tl < t.y ? 1u : 0u);
  uvec2 q = lens_mul(r2, r2);
  uint ql = q.y + (1u << 27);
  uint r4 = (ql >> 28) | ((q.x + (ql < q.y ? 1u : 0u)) << 4);
  uvec2 sum = lens_add(lens_add(lens_smul(r2, u_k1i), lens_smul(r4, u_k2i)), uvec2(1u << 20, 1u << 27));
  int rm = int((sum.y >> 28) | (sum.x << 4));
  ivec2 px_ = lens_pos(rm, off.x), py_ = lens_pos(rm, off.y);
  ivec2 qq = ctr + ivec2(px_.x, py_.x);
  // FFmpeg's fraction for a negative offset: max − ((rm·(−o) + 2^23) & max).
  int du = off.x >= 0 ? px_.y : 0xFFFFFF - lens_pos(rm, -off.x).y;
  int dv = off.y >= 0 ? py_.y : 0xFFFFFF - lens_pos(rm, -off.y).y;
  if (qq.x < 0 || qq.y < 0 || qq.x > SZ.x - 1 || qq.y > SZ.y - 1) {
    if (u_lens_fill == 0) return DOM == 1 ? vec4(16.0, 128.0, 128.0, 0.0) : vec4(0.0);
    qq = clamp(qq, ivec2(0), SZ - 1);
  }
  ivec2 n = min(qq + 1, SZ - 1);
  const float MX = 16777215.0 / 16777216.0;
  float fu = float(du) / 16777216.0, fv = float(dv) / 16777216.0;
  vec4 s = (MX - fu) * (MX - fv) * px(qq) + fu * (MX - fv) * px(ivec2(n.x, qq.y))
         + (MX - fu) * fv * px(ivec2(qq.x, n.y)) + fu * fv * px(n);
  return floor(s + 0.5);
}
`;

/**
 * lens zoom-to-fill: perspective (linear, sense source) with an axis-aligned
 * source rect centred on the lens centre, i.e. a zoom by 256/u_zoom. Its
 * per-pixel source position in 1/256 px is u = x·S + ctr·(256 − S) — exact
 * integers, the rect being chosen so (registry lensZoomFilter) — then
 * resample_linear's Q8 bilinear with one rounding at the end, edges clamped.
 * Every plane, alpha included.
 */
export const GLSL_LENS_ZOOM = `
uniform int u_zoom;
uniform ivec2 u_zoom_off;
vec4 fx(ivec2 p) {
  ivec2 u = p * u_zoom + u_zoom_off;
  ivec2 i = u >> 8;
  ivec2 f = u & 255;
  ivec4 a = ivec4(px(i)), b = ivec4(px(i + ivec2(1, 0))), c = ivec4(px(i + ivec2(0, 1))), d = ivec4(px(i + ivec2(1, 1)));
  ivec4 sum = (256 - f.y) * ((256 - f.x) * a + f.x * b) + f.y * ((256 - f.x) * c + f.x * d);
  return vec4((sum + 32768) >> 16);
}
`;

/**
 * trails step 1 (writes the history, float): premultiply, then lagfun on every
 * plane including alpha: h = max(x, h_prev · decay^n) for n project frames
 * since the last update (u_steps; u_reset = 1 starts over — both set by the
 * pipeline from the playhead).
 */
export const GLSL_LAGFUN = `
uniform float u_decay;
uniform int u_reset;
uniform float u_steps;
vec4 fx(ivec2 p) {
  vec4 c = premul8(px(p));
  if (u_reset == 1) return c;
  return max(c, hpx(p) * pow(u_decay, u_steps));
}
`;

/** trails step 2: lrintf of the history, then unpremultiply by the lagged alpha. */
export const GLSL_LAGOUT = `
vec4 fx(ivec2 p) { return unpremul8(roundEven(fpx(p))); }
`;
