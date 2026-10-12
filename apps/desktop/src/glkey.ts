// Live preview of KEYS (colorkey / chromakey / lumakey) on the GPU. One shared
// offscreen WebGL2 canvas serves every keyed layer: the layer's visible source
// region is drawn — through the CSS colour proxy for what runs before the key —
// onto a small 2D staging canvas at the size it will appear on screen, uploaded
// as a texture, keyed by a fragment shader that reproduces FFmpeg's math, and
// handed back for preview.tsx to draw with the layer's usual transform /
// opacity (+ any effects after the key). FFmpeg export stays the ground truth.
//
// Shader math (FFmpeg 4.4, verified against the filters):
//  - colorkey: diff = sqrt(Σ(c−k)² / 3) on 0..1 RGB.
//  - chromakey: diff = mean over a 3×3 neighbourhood of sqrt((du²+dv²) / 2) /
//    255, where the PIXEL's U/V are limited-range BT.601 (what swscale feeds the
//    filter) and the KEY's U/V are full-range BT.601 (the filter's own macro).
//  - both: alpha = blend > 0.0001 ? clamp((diff − similarity) / blend) : diff > similarity.
//  - lumakey: limited-range BT.601 luma Y (0..255) against black = (threshold −
//    tolerance)·255 and white = (threshold + tolerance)·255: Y in [black, white]
//    → transparent, within `softness`·255 of the band → ramped, else untouched.
//  - despill (chromakey): spill = max(G − (R+B)/2, 0), G −= spill·despill (blue
//    screens: the same on B).
// Every key MULTIPLIES into the source alpha, as the export does.
//
// No WebGL2 (or a lost context) → keyFrame() returns null and the layer draws
// unkeyed, exactly as before this pass existed.

import type { KeyPlan } from "./keying";
import { MAX_KEYS } from "./keying";

const VERT = `#version 300 es
void main() {
  // One full-viewport triangle from gl_VertexID — no vertex buffers.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_src;
uniform ivec2 u_size;
uniform int u_count;
uniform int u_kind[${MAX_KEYS}];
uniform vec3 u_key[${MAX_KEYS}];
uniform vec4 u_param[${MAX_KEYS}];
out vec4 outColor;

vec4 tap(ivec2 p) {
  return texelFetch(u_src, clamp(p, ivec2(0), u_size - 1), 0);
}

// Limited-range BT.601 U/V (0..255) of an RGB pixel.
vec2 uvOf(vec3 c) {
  vec3 s = c * 255.0 * (224.0 / 255.0);
  return floor(vec2(128.0 - 0.16874 * s.r - 0.33126 * s.g + 0.5 * s.b,
                    128.0 + 0.5 * s.r - 0.41869 * s.g - 0.08131 * s.b) + 0.5);
}

float ramp(float diff, float sim, float blend) {
  return blend > 0.0001 ? clamp((diff - sim) / blend, 0.0, 1.0) : (diff > sim ? 1.0 : 0.0);
}

void main() {
  // Texture row 0 is the image's top row; GL's y runs bottom-up.
  ivec2 p = ivec2(int(gl_FragCoord.x), u_size.y - 1 - int(gl_FragCoord.y));
  vec4 src = tap(p);
  vec3 rgb = src.rgb;
  float a = src.a;
  for (int i = 0; i < ${MAX_KEYS}; i++) {
    if (i >= u_count) break;
    int kind = u_kind[i];
    vec3 k = u_key[i];
    vec4 q = u_param[i];
    if (kind == 1) {
      // colorkey: k = key RGB 0..1; q = (similarity, blend)
      vec3 d = rgb - k;
      a *= ramp(sqrt(dot(d, d) / 3.0), q.x, q.y);
    } else if (kind == 2) {
      // chromakey: k.xy = key U/V (full range); q = (similarity, blend, despill, screen 1=green 2=blue)
      float diff = 0.0;
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          vec2 d = uvOf(tap(p + ivec2(dx, dy)).rgb) - k.xy;
          diff += sqrt(dot(d, d) / (255.0 * 255.0 * 2.0));
        }
      }
      a *= ramp(diff / 9.0, q.x, q.y);
      if (q.z > 0.0 && q.w > 0.5) {
        if (q.w < 1.5) rgb.g -= max(rgb.g - 0.5 * (rgb.r + rgb.b), 0.0) * q.z;
        else rgb.b -= max(rgb.b - 0.5 * (rgb.r + rgb.g), 0.0) * q.z;
      }
    } else if (kind == 3) {
      // lumakey: k = (black, white, softness) in 0..255
      float y = floor(16.0 + 65.481 * rgb.r + 128.553 * rgb.g + 24.966 * rgb.b + 0.5);
      float so = max(k.z, 1.0);
      if (y >= k.x && y <= k.y) a = 0.0;
      else if (y > k.x - k.z && y < k.y + k.z) {
        a *= y < k.x ? (255.0 - floor((y - k.x + k.z) * 255.0 / so)) / 255.0 : floor((y - k.y) * 255.0 / so) / 255.0;
      }
    }
  }
  outColor = vec4(rgb * a, a); // premultiplied, as the default context composites
}`;

interface GL {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  prog: WebGLProgram;
  tex: WebGLTexture;
  size: WebGLUniformLocation | null;
  count: WebGLUniformLocation | null;
  kind: WebGLUniformLocation | null;
  key: WebGLUniformLocation | null;
  param: WebGLUniformLocation | null;
  texW: number;
  texH: number;
  maxTex: number;
}

let glState: GL | null = null;
let glCanvas: HTMLCanvasElement | null = null;
let glCtx: WebGL2RenderingContext | null = null;
/** Set once WebGL2 is known to be unusable here (no context / shader failure). */
let unavailable = false;
let stage: HTMLCanvasElement | null = null;
let stageCtx: CanvasRenderingContext2D | null = null;

// Uniform scratch, reused every frame (no per-frame allocation).
const uKind = new Int32Array(MAX_KEYS);
const uKey = new Float32Array(MAX_KEYS * 3);
const uParam = new Float32Array(MAX_KEYS * 4);
/** The region of the GL canvas holding the last keyed frame (reused object). */
const result = { canvas: null as unknown as HTMLCanvasElement, x: 0, y: 0, w: 0, h: 0 };

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    console.warn("[keying] shader compile failed:", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

/** Program + texture for a (fresh or restored) context. */
function setup(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement): GL | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  const tex = gl.createTexture();
  if (!vs || !fs || !prog || !tex) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    if (!gl.isContextLost()) console.warn("[keying] program link failed:", gl.getProgramInfoLog(prog));
    return null;
  }
  gl.useProgram(prog);
  gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.disable(gl.BLEND);
  return {
    gl, canvas, prog, tex,
    size: gl.getUniformLocation(prog, "u_size"),
    count: gl.getUniformLocation(prog, "u_count"),
    kind: gl.getUniformLocation(prog, "u_kind"),
    key: gl.getUniformLocation(prog, "u_key"),
    param: gl.getUniformLocation(prog, "u_param"),
    texW: 0,
    texH: 0,
    maxTex: Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number),
  };
}

function ensureGL(): GL | null {
  if (unavailable) return null;
  if (glCtx?.isContextLost()) return null; // wait for webglcontextrestored
  if (glState) return glState;
  if (!glCanvas) {
    glCanvas = document.createElement("canvas");
    glCanvas.width = glCanvas.height = 1;
    glCtx = glCanvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!glCtx) {
      unavailable = true;
      return null;
    }
    glCanvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault(); // allow a restore
      glState = null;
    });
    glCanvas.addEventListener("webglcontextrestored", () => {
      glState = null; // rebuilt lazily on the next keyed frame
    });
  }
  glState = setup(glCtx!, glCanvas);
  if (!glState && !glCtx!.isContextLost()) unavailable = true;
  return glState;
}

// FFmpeg chromakey's own full-range RGB→U/V macro for the KEY colour.
const FIX = (x: number) => Math.round(x * 1024);
const keyU = (r: number, g: number, b: number) => ((-FIX(0.16874) * r - FIX(0.33126) * g + FIX(0.5) * b + 511) >> 10) + 128;
const keyV = (r: number, g: number, b: number) => ((FIX(0.5) * r - FIX(0.41869) * g - FIX(0.08131) * b + 511) >> 10) + 128;
const clip8 = (n: number) => Math.min(255, Math.max(0, Math.trunc(n)));

function fillUniforms(plan: KeyPlan): number {
  const n = Math.min(plan.keys.length, MAX_KEYS);
  for (let i = 0; i < n; i++) {
    const k = plan.keys[i];
    const [r, g, b] = k.rgb;
    if (k.kind === "colorkey") {
      uKind[i] = 1;
      uKey[i * 3] = r / 255; uKey[i * 3 + 1] = g / 255; uKey[i * 3 + 2] = b / 255;
    } else if (k.kind === "chromakey") {
      uKind[i] = 2;
      uKey[i * 3] = keyU(r, g, b); uKey[i * 3 + 1] = keyV(r, g, b); uKey[i * 3 + 2] = 0;
    } else {
      uKind[i] = 3;
      uKey[i * 3] = clip8((k.threshold - k.tolerance) * 255);
      uKey[i * 3 + 1] = clip8((k.threshold + k.tolerance) * 255);
      uKey[i * 3 + 2] = Math.trunc(k.softness * 255);
    }
    uParam[i * 4] = k.similarity;
    uParam[i * 4 + 1] = k.blend;
    uParam[i * 4 + 2] = k.despill;
    uParam[i * 4 + 3] = k.screen === "green" ? 1 : k.screen === "blue" ? 2 : 0;
  }
  return n;
}

/**
 * Key one layer's frame. Draws the source rect (sx,sy,sw,sh) of `src` at w×h
 * through `plan.pre`, keys it, and returns the GL canvas + the sub-rect holding
 * the result (valid until the next call — draw it immediately). Returns null if
 * the pass can't run (no WebGL2, lost context, frame not uploadable), in which
 * case the caller draws the layer unkeyed.
 */
export function keyFrame(
  src: CanvasImageSource,
  sx: number, sy: number, sw: number, sh: number,
  w: number, h: number,
  plan: KeyPlan,
): typeof result | null {
  if (!plan.keys.length || w < 1 || h < 1) return null;
  const s = ensureGL();
  if (!s) return null;
  const { gl, canvas } = s;
  try {
    w = Math.min(Math.round(w), s.maxTex);
    h = Math.min(Math.round(h), s.maxTex);

    // 1. Stage: crop + scale + the pre-key colour proxy, at the drawn size.
    // Both canvases only ever GROW, so animating the layer doesn't reallocate.
    if (!stage) {
      stage = document.createElement("canvas");
      stageCtx = stage.getContext("2d");
    }
    if (!stageCtx) return null;
    if (stage.width < w) stage.width = w;
    if (stage.height < h) stage.height = h;
    stageCtx.globalAlpha = 1;
    stageCtx.clearRect(0, 0, w, h);
    stageCtx.filter = plan.pre && plan.pre !== "none" ? plan.pre : "none";
    stageCtx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    stageCtx.filter = "none";

    // 2. Upload (texSubImage2D while the staging size is unchanged).
    gl.bindTexture(gl.TEXTURE_2D, s.tex);
    if (s.texW !== stage.width || s.texH !== stage.height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, stage);
      s.texW = stage.width;
      s.texH = stage.height;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, stage);
    }

    // 3. Key into the bottom-left w×h of the (grow-only) GL canvas.
    if (canvas.width < w) canvas.width = w;
    if (canvas.height < h) canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.useProgram(s.prog);
    gl.uniform2i(s.size, w, h);
    gl.uniform1i(s.count, fillUniforms(plan));
    gl.uniform1iv(s.kind, uKind);
    gl.uniform3fv(s.key, uKey);
    gl.uniform4fv(s.param, uParam);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    result.canvas = canvas;
    result.x = 0;
    result.y = canvas.height - h; // GL's origin is bottom-left
    result.w = w;
    result.h = h;
    return result;
  } catch {
    // A tainted / not-yet-decodable frame (SecurityError / InvalidStateError).
    // A tainted staging canvas stays tainted forever — start a fresh one.
    stage = null;
    stageCtx = null;
    return null;
  }
}

// ---- eyedropper bypass ------------------------------------------------------
// While the inspector's eyedropper is open, the clip being picked from previews
// UNKEYED, so you pick the real background colour instead of the track below.
let bypassClip: string | null = null;
const bypassListeners = new Set<() => void>();

export function setKeyBypass(clipId: string | null): void {
  if (bypassClip === clipId) return;
  bypassClip = clipId;
  bypassListeners.forEach((l) => l());
}

export function isKeyBypassed(clipId: string): boolean {
  return bypassClip === clipId;
}

export function onKeyBypassChange(listener: () => void): () => void {
  bypassListeners.add(listener);
  return () => {
    bypassListeners.delete(listener);
  };
}
