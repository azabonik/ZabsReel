// The live preview's WebGL2 effect pipeline. ONE shared offscreen WebGL2
// context serves every layer: the layer's frame (a <video>, an <img>, or the
// composite canvas for an adjustment layer) is uploaded as a texture, placed
// into its canvas-space frame (crop + letterbox fit, transparent padding — the
// stream the export's filters see) at the processing size, run through the
// plan's passes (plan.ts) with pooled RGBA8 / float ping-pong targets, and the
// last pass writes premultiplied RGBA straight into the shared canvas for
// preview.tsx to draw with the layer's mask / blend / transform / opacity.
// Float intermediates (blur sums, temporal histories) are stored bit for bit
// in RGBA32UI targets (floatBitsToUint), which core WebGL2 renders to without
// EXT_color_buffer_float — so every pass, keys included, runs on any WebGL2.
//
// Passes are FUSED: a run of per-pixel ops (colour grade, exposure, keys,
// vignette …) is compiled into the pass before it — the placement, or the
// last pass of a neighbourhood effect — with the 8-bit clamp and the colour-
// domain conversion between them that the separate passes had, so the math is
// unchanged and a typical look costs one full-frame pass. Domains and output
// modes are compile-time #defines, so a program runs only the conversions it
// needs (software GL executes both sides of a uniform-dependent branch).
//
// Needs only WebGL2; without it, or while the context is lost, glReady() is
// false and the preview falls back to its CSS / Canvas2D proxies. A lost
// context is rebuilt lazily after `webglcontextrestored`; listeners
// (onGLChange) repaint.
//
// Steady playback allocates no GPU resources per frame: programs are cached by
// source, render targets pooled by size, plans cached by the look object
// (plan.ts) and their fused groups cached on the plan, uniform values
// precomputed in the plan. GPU memory is freed explicitly, never left to the
// garbage collector: a step's table texture (eq / curves / denoise) is one
// texture per layer and step, re-filled in place when a slider drag brings a
// new table; LUTs are LRU-bounded; unused sources, histories, tables and
// pooled targets are deleted after a while.

import { GL_MAIN, GL_PRELUDE, GLSL_COPY } from "@aive/core/effects";
import type { PlannedPass, PlannedStep } from "./plan";
import { parseCube, type CubeLut } from "./color";

const VERT = `#version 300 es
void main() {
  // One full-viewport triangle from gl_VertexID — no vertex buffers.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * Pass 0: the source's crop rect resampled (bilinear) into the picture rect
 * of the canvas-space frame; transparent outside it (the export's pad).
 */
const GLSL_PLACE = `
uniform vec4 u_rect;
uniform vec4 u_crop;
uniform vec2 u_srcSize;
vec4 fx(ivec2 p) {
  vec2 c = vec2(p) + 0.5;
  if (c.x < u_rect.x || c.y < u_rect.y || c.x >= u_rect.x + u_rect.z || c.y >= u_rect.y + u_rect.w) return vec4(0.0);
  vec2 s = u_crop.xy + (c - u_rect.xy) / u_rect.zw * u_crop.zw;
  return floor(texture(u_in, s / u_srcSize) * 255.0 + 0.5);
}`;

const COPY_PASS: PlannedPass = { frag: GLSL_COPY, domain: "any", uniforms: {} };
const PLACE_PASS: PlannedPass = { frag: GLSL_PLACE, domain: "rgb", uniforms: {} };
/** Point ops fused into one pass at most (keeps programs small). */
const MAX_FUSED = 8;
/** First texture unit for the tables point ops declare (0–2: u_in, u_orig, u_hist). */
const TABLE_UNIT0 = 4;
/**
 * Unit used while CREATING textures, so a new texture never replaces one
 * already bound for the draw being set up (tables are created lazily).
 */
const SCRATCH_UNIT = 15;

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
  float: boolean;
}

interface UniformInfo {
  loc: WebGLUniformLocation;
  type: number;
}

interface Prog {
  prog: WebGLProgram;
  uni: Map<string, UniformInfo>;
  /** Table sampler uniform → texture unit. */
  units: Map<string, number>;
}

/** One pass of the plan, with its resolved colour domains. */
interface Elem {
  pass: PlannedPass;
  step: PlannedStep | null;
  /** The domain it works in, and the one it leaves the value in (after `out`). */
  dom: number;
  outDom: number;
  /** For a point op: its function name (`op_…`). */
  op?: string;
  /** Table samplers its body declares. */
  tables2D: string[];
  tables3D: string[];
  /** The host is the first / last pass of a multi-pass step (u_orig bookkeeping). */
  stepFirst: boolean;
  stepLast: boolean;
}

/** One draw: a host pass that reads textures plus the point ops fused after it. */
interface Group {
  host: Elem;
  ops: Elem[];
  /** Domain of the texture the host reads (u_in) and of its step's input (u_orig). */
  inDom: number;
  origDom: number;
  /** Domain of what the group writes. */
  endDom: number;
  float: boolean;
  history: boolean;
  /** u_in is a float (RGBA32UI) target: the group before wrote float or history. */
  inFloat: boolean;
  place: boolean;
  /** Generated source per output mode (0 = texture, 1 = canvas, 2 = readback). */
  sources: (string | undefined)[];
}

interface Hist {
  a: Target;
  b: Target;
  /** The clock (source frame, or timeline frame) of the state in b. */
  frame: number;
  steps: number;
  reset: boolean;
  lastRun: number;
  /** The steps before it when it was built (PlannedStep.histSig): a reorder upstream starts it over. */
  sig: string;
  /** The look's settings it was built with (PlannedStep.histParams). */
  params: string;
  /**
   * The first frame of the unbroken run that built the state in b: every
   * frame from here to `frame` went in once, with these settings. The state
   * is the export's when this reaches back to where the export's starts.
   */
  since: number;
  /** b was computed from a frame the video element had not finished seeking to. */
  dirty: boolean;
}

/** A step's table texture, one per layer and step (B10: re-filled in place, deleted when unused). */
interface AuxTex {
  tex: WebGLTexture;
  data: Uint8Array;
  w: number;
  h: number;
  lastRun: number;
}

interface LutEntry {
  state: "loading" | "ready" | "error";
  cube?: CubeLut;
  tex?: WebGLTexture;
  /** Context generation the texture belongs to. */
  gen?: number;
  /** The file's validator when it was read (the core's /file ETag: size + mtime), if the core sent one. */
  etag?: string | null;
  /**
   * Set when the last read failed: that version's validator (null when the
   * response had none). It is read again only once the file changes again
   * (no validator: at most every lutRecheckMs).
   */
  failedEtag?: string | null;
  /** Why the preview's table is not the file's: no table ("error"), or an older one kept ("ready"). */
  problem?: string;
  /** When the file was last checked for a change (ms), and whether a check is running. */
  checked: number;
  checking?: boolean;
  /** Bytes the parsed table holds (the texture holds as many again). */
  bytes: number;
  /** runSerial of the last frame that used it (never evicted from under a frame). */
  lastRun: number;
}

/** An uploaded source frame, kept per element so an unchanged frame is not uploaded again. */
interface SrcTex {
  tex: WebGLTexture;
  w: number;
  h: number;
  /** The element's media time and source when uploaded (time NaN = always re-upload, e.g. a canvas). */
  time: number;
  url: string;
  lastRun: number;
}

interface State {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  vs: WebGLShader;
  progs: Map<string, Prog | null>;
  pool: Map<number, Target[]>;
  srcs: Map<unknown, SrcTex>;
  aux: Map<string, AuxTex>;
  hist: Map<string, Hist>;
  /** The history resampling program (a size change keeps the trail), compiled on first use. */
  resample: { prog: WebGLProgram; src: WebGLUniformLocation | null; srcSize: WebGLUniformLocation | null; dstSize: WebGLUniformLocation | null } | null;
  readTarget: Target | null;
  /** Processing-size cap (≤ 4096). */
  maxTex: number;
  /** The GPU's MAX_TEXTURE_SIZE: a larger source can't be uploaded as is. */
  hwMaxTex: number;
  gen: number;
}

let state: State | null = null;
let canvasEl: HTMLCanvasElement | null = null;
let ctxEl: WebGL2RenderingContext | null = null;
/** Set once WebGL2 is known to be missing here. */
let unavailable = false;
let lost = false;
let generation = 0;
let runSerial = 0;
const listeners = new Set<() => void>();
const luts = new Map<string, LutEntry>();
let fileUrl: ((path: string) => string) | null = null;

/**
 * How the runtime turns a LUT path into a fetchable URL (the core's /file
 * route). A new resolver (a new session token after a core restart) retries
 * the LUTs that failed.
 */
export function setFileUrl(fn: (path: string) => string): void {
  fileUrl = fn;
  for (const [path, e] of luts) if (e.state === "error") luts.delete(path);
  notify(); // a frame drawn before this may have left a LUT out
}

/** Called when the pipeline's availability changes or a LUT finishes loading (repaint). */
export function onGLChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify(): void {
  listeners.forEach((l) => l());
}

/** A per-viewer opt-out (localStorage "synthcut.preview.gl" = "off"): the CSS preview, e.g. to compare. */
function optedOut(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("synthcut.preview.gl") === "off";
  } catch {
    return false;
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    if (!gl.isContextLost()) console.warn("[gl] shader compile failed:", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function setup(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement): State | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  if (!vs) return null;
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  generation++;
  return {
    gl, canvas, vs,
    progs: new Map(),
    pool: new Map(),
    srcs: new Map(),
    aux: new Map(),
    hist: new Map(),
    resample: null,
    readTarget: null,
    maxTex: Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number),
    hwMaxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    gen: generation,
  };
}

function ensure(): State | null {
  if (unavailable || lost) return null;
  if (state) return state;
  if (typeof document === "undefined") return null;
  if (!canvasEl) {
    canvasEl = document.createElement("canvas");
    canvasEl.width = canvasEl.height = 1;
    ctxEl = canvasEl.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!ctxEl) {
      unavailable = true;
      return null;
    }
    canvasEl.addEventListener("webglcontextlost", (e) => {
      e.preventDefault(); // allow a restore
      lost = true;
      state = null;
      notify();
    });
    canvasEl.addEventListener("webglcontextrestored", () => {
      lost = false;
      state = null; // rebuilt lazily on the next frame
      notify();
    });
  }
  if (ctxEl!.isContextLost()) return null;
  state = setup(ctxEl!, canvasEl);
  if (!state && !ctxEl!.isContextLost()) unavailable = true;
  return state;
}

/** True when the GL pipeline can run now (WebGL2, context not lost, not opted out). */
export function glReady(): boolean {
  return !optedOut() && !!ensure();
}

// ---- programs: grouping, generated sources, compilation -------------------------------

const OP_RE = /vec4\s+(op_\w+)\s*\(/;
const TABLE_RE = /uniform\s+(?:highp\s+)?sampler(2D|3D)\s+(\w+)\s*;/g;

function tablesOf(frag: string): { d2: string[]; d3: string[] } {
  const d2: string[] = [];
  const d3: string[] = [];
  for (const m of frag.matchAll(TABLE_RE)) (m[1] === "2D" ? d2 : d3).push(m[2]);
  return { d2, d3 };
}

function elem(pass: PlannedPass, step: PlannedStep | null, inDom: number, first: boolean, last: boolean): Elem {
  const dom = pass.domain === "rgb" ? 0 : pass.domain === "yuv" ? 1 : inDom;
  const t = tablesOf(pass.frag);
  const op = pass.point ? OP_RE.exec(pass.frag)?.[1] : undefined;
  return { pass, step, dom, outDom: pass.out === "rgb" ? 0 : dom, ...(op ? { op } : {}), tables2D: t.d2, tables3D: t.d3, stepFirst: first, stepLast: last };
}

/**
 * Split the runnable steps into draws. A host (the placement, a neighbourhood
 * pass, a float or history pass) starts a group; the point ops after it join
 * it until the next host, a repeated op body (its uniforms would collide), or
 * MAX_FUSED. Point ops of a multi-pass step stay hosts (their step's later
 * passes read its input). Domains are resolved here, once per plan.
 */
function buildGroups(steps: readonly PlannedStep[]): Group[] {
  const groups: Group[] = [];
  let dom = 0;
  let stepInDom = 0;
  const open = (host: Elem, inDom: number, origDom: number, place = false): Group => {
    const prev = groups[groups.length - 1];
    const g: Group = {
      host, ops: [], inDom, origDom, endDom: host.outDom,
      float: !!host.pass.float, history: !!host.pass.history, inFloat: !!prev && (prev.float || prev.history), place, sources: [],
    };
    groups.push(g);
    return g;
  };
  let cur = open(elem(PLACE_PASS, null, 0, true, true), 0, 0, true);
  dom = 0;
  for (const step of steps) {
    stepInDom = dom;
    const multi = step.passes.length > 1;
    for (let i = 0; i < step.passes.length; i++) {
      const pass = step.passes[i];
      const e = elem(pass, step, dom, i === 0, i === step.passes.length - 1);
      const fusable = !!e.op && !multi && !cur.float && !cur.history && cur.ops.length < MAX_FUSED &&
        cur.host.pass.frag !== pass.frag && !cur.ops.some((o) => o.pass.frag === pass.frag);
      if (fusable) {
        cur.ops.push(e);
        cur.endDom = e.outDom;
      } else if (e.op) {
        // A point op that can't join: a copy pass hosts it.
        cur = open(elem(COPY_PASS, null, dom, true, true), dom, dom);
        cur.ops.push(e);
        cur.endDom = e.outDom;
      } else {
        cur = open(e, dom, i === 0 ? dom : stepInDom);
      }
      dom = e.outDom;
    }
  }
  return groups;
}

/** The fragment source of a group for an output mode (0 texture, 1 canvas, 2 readback). */
function groupSource(g: Group, final: number): string {
  const hit = g.sources[final];
  if (hit) return hit;
  const fused = g.ops.length > 0;
  const defines = [
    `#define IN_DOM ${g.inDom}`,
    `#define ORIG_DOM ${g.origDom}`,
    `#define DOM ${g.host.dom}`,
    `#define END_DOM ${fused ? g.endDom : g.host.dom}`,
    `#define OUT_RGB ${!fused && g.host.pass.out === "rgb" ? 1 : 0}`,
    `#define FLOAT_OUT ${g.float || g.history ? 1 : 0}`,
    `#define FINAL ${final}`,
    `#define IN_FLOAT ${g.inFloat ? 1 : 0}`,
    `#define HISTORY ${g.history ? 1 : 0}`,
  ].join("\n");
  let body: string;
  if (!fused) {
    body = g.host.pass.frag;
  } else {
    const host = g.host.pass.frag.replace(/vec4\s+fx\s*\(\s*ivec2\s+p\s*\)/, "vec4 hostfx(ivec2 p)");
    const lines = [
      "vec4 fx(ivec2 p) {",
      "  vec4 c = clamp(hostfx(p), 0.0, 255.0);",
      `  c = conv(c, ${g.host.dom}, ${g.host.outDom});`,
    ];
    let d = g.host.outDom;
    for (const o of g.ops) {
      lines.push(`  c = clamp(${o.op}(conv(c, ${d}, ${o.dom}), p, ${o.dom}), 0.0, 255.0);`);
      if (o.outDom !== o.dom) lines.push(`  c = conv(c, ${o.dom}, ${o.outDom});`);
      d = o.outDom;
    }
    lines.push("  return c;", "}");
    body = [host, ...g.ops.map((o) => o.pass.frag), lines.join("\n")].join("\n");
  }
  const src = `#version 300 es\n${defines}\n${GL_PRELUDE}\n${body}\n${GL_MAIN}`;
  g.sources[final] = src;
  return src;
}

function program(s: State, src: string): Prog | null {
  const hit = s.progs.get(src);
  if (hit !== undefined) return hit;
  const { gl } = s;
  const fs = compile(gl, gl.FRAGMENT_SHADER, src);
  let out: Prog | null = null;
  const prog = fs ? gl.createProgram() : null;
  if (fs && prog) {
    gl.attachShader(prog, s.vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const uni = new Map<string, UniformInfo>();
      const units = new Map<string, number>();
      const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
      gl.useProgram(prog);
      let next = TABLE_UNIT0;
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(prog, i);
        if (!info) continue;
        const name = info.name.replace(/\[0\]$/, "");
        const loc = gl.getUniformLocation(prog, info.name);
        if (!loc) continue;
        uni.set(name, { loc, type: info.type });
        const fixed = name === "u_in" ? 0 : name === "u_orig" ? 1 : name === "u_hist" ? 2 : -1;
        if (fixed >= 0) gl.uniform1i(loc, fixed);
        else if (info.type === gl.SAMPLER_2D || info.type === gl.SAMPLER_3D) {
          units.set(name, next);
          gl.uniform1i(loc, next++);
        }
      }
      out = { prog, uni, units };
    } else if (!gl.isContextLost()) {
      console.warn("[gl] program link failed:", gl.getProgramInfoLog(prog));
    }
  }
  if (fs) gl.deleteShader(fs);
  s.progs.set(src, out);
  return out;
}

/** The fused groups of a plan (for the steps that can run now), cached on the plan. */
const groupCache = new WeakMap<readonly PlannedStep[], { key: string; groups: Group[] }>();
function groupsFor(all: readonly PlannedStep[], runnable: readonly PlannedStep[]): Group[] {
  const key = runnable.length === all.length ? "*" : runnable.map((s) => s.id).join("|");
  const hit = groupCache.get(all);
  if (hit && hit.key === key) return hit.groups;
  const groups = buildGroups(runnable);
  groupCache.set(all, { key, groups });
  return groups;
}

/** Fused draws a plan takes (the placement included) — for tests and the bench. */
export function drawCount(steps: readonly PlannedStep[]): number {
  return buildGroups(steps).length;
}

// ---- render targets ----------------------------------------------------------------------

function makeTarget(s: State, w: number, h: number, float: boolean): Target | null {
  const { gl } = s;
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!tex || !fbo) return null;
  gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // Floats live bit for bit in RGBA32UI (renderable in core WebGL2; RGBA32F would need EXT_color_buffer_float).
  gl.texStorage2D(gl.TEXTURE_2D, 1, float ? gl.RGBA32UI : gl.RGBA8, w, h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    return null;
  }
  return { tex, fbo, w, h, float };
}

function dropTarget(s: State, t: Target): void {
  s.gl.deleteFramebuffer(t.fbo);
  s.gl.deleteTexture(t.tex);
}

const poolKey = (w: number, h: number, float: boolean) => (float ? -1 : 1) * (w * 8192 + h);

/** Pool keys used since the last trim. */
const usedSizes = new Set<number>();

function acquire(s: State, w: number, h: number, float: boolean): Target | null {
  const k = poolKey(w, h, float);
  usedSizes.add(k);
  const t = s.pool.get(k)?.pop();
  return t ?? makeTarget(s, w, h, float);
}

function release(s: State, t: Target): void {
  const k = poolKey(t.w, t.h, t.float);
  let list = s.pool.get(k);
  if (!list) s.pool.set(k, (list = []));
  if (list.length < 4) list.push(t);
  else dropTarget(s, t);
}

/** Free pooled targets of sizes no layer used lately (an animated zoom, a resized window). */
function trimPool(s: State): void {
  for (const [k, list] of s.pool) {
    if (usedSizes.has(k)) continue;
    for (const t of list) dropTarget(s, t);
    s.pool.delete(k);
  }
  usedSizes.clear();
}

/**
 * The step's table as a texture. One texture per (layer, step) slot: a new
 * table for the slot (a slider drag re-plans the look every frame) is written
 * into the same texture, so no texture is left behind for the GC to free.
 */
function auxTexture(s: State, slot: string, data: Uint8Array, width: number): WebGLTexture | null {
  const { gl } = s;
  const w = width;
  const h = Math.max(1, data.length / 4 / width);
  let e = s.aux.get(slot);
  if (e && e.data === data) {
    e.lastRun = runSerial;
    return e.tex;
  }
  if (e && (e.w !== w || e.h !== h)) {
    gl.deleteTexture(e.tex);
    s.aux.delete(slot);
    e = undefined;
  }
  gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
  if (!e) {
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    e = { tex, data, w, h, lastRun: runSerial };
    s.aux.set(slot, e);
  } else {
    gl.bindTexture(gl.TEXTURE_2D, e.tex);
  }
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
  e.data = data;
  e.lastRun = runSerial;
  return e.tex;
}

function evictAux(s: State): void {
  for (const [slot, e] of s.aux) {
    if (runSerial - e.lastRun > 300) {
      s.gl.deleteTexture(e.tex);
      s.aux.delete(slot);
    }
  }
}

// ---- LUTs ------------------------------------------------------------------------------------

/** LUTs kept (parsed + as a 3D texture), least recently used dropped first: at most this many … */
const LUT_MAX = 8;
/**
 * … and this many bytes of tables (a 65³ LUT is 3.3 MB, as much again on the
 * GPU). A single table above it is never loaded (the preview leaves the LUT
 * out and says so; the export still applies it); the LUTs recent frames use
 * are kept even when together they pass it.
 */
let lutMaxBytes = 64 << 20;
/** How often a LUT in use is checked for a change on disk (a HEAD to the core's /file: its ETag). */
let lutRecheckMs = 2000;

const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Delete a LUT's texture now (when it belongs to the live context; a lost context took it already). */
function dropLutTexture(e: LutEntry): void {
  if (e.tex && state && e.gen === state.gen) state.gl.deleteTexture(e.tex);
  e.tex = undefined;
  e.gen = undefined;
}

/** Keep the cache within LUT_MAX / lutMaxBytes, oldest first, sparing LUTs a recent run used. */
function enforceLutBudget(): void {
  let count = luts.size;
  let bytes = 0;
  for (const e of luts.values()) bytes += e.bytes;
  for (const [path, e] of luts) {
    if (count <= LUT_MAX && bytes <= lutMaxBytes) break;
    if (e.state === "loading" || runSerial - e.lastRun < 16) continue;
    dropLutTexture(e);
    luts.delete(path);
    count--;
    bytes -= e.bytes;
  }
}

function evictLuts(_s: State): void {
  enforceLutBudget();
}

/** (Re)read the .cube; a reload keeps showing the old table until the new one parses. */
function readLut(path: string, e: LutEntry): void {
  if (!fileUrl) return;
  e.checking = true;
  let etag: string | null = null;
  // Repaint when the outcome differs (a table read, or a new failure): not on every retry of the same one.
  let changed = true;
  fetch(fileUrl(path), { cache: "no-store" })
    .then((r) => {
      etag = r.headers.get("etag");
      return r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`));
    })
    .then((text) => {
      // The table's size before parsing it: one over the budget is never allocated.
      const size = Number(/^LUT_3D_SIZE\s+(\d+)/m.exec(text)?.[1]);
      if (size > 0 && size ** 3 * 12 > lutMaxBytes) {
        const mb = (n: number) => (n >= 2 ** 20 ? `${Math.round(n / 2 ** 20)} MB` : `${Math.ceil(n / 1024)} kB`);
        throw new Error(`its ${size}³ table needs ${mb(size ** 3 * 12)}, over the preview's ${mb(lutMaxBytes)} for LUTs`);
      }
      const cube = parseCube(text);
      if (!cube) throw new Error("not a 3D .cube LUT lut3d can read");
      if (luts.get(path) !== e) return; // evicted meanwhile
      dropLutTexture(e);
      e.cube = cube;
      e.etag = etag;
      e.failedEtag = undefined;
      e.problem = undefined;
      e.bytes = cube.data.byteLength;
      e.state = "ready";
      enforceLutBudget();
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      // Remember the version that failed: it is not fetched again until the file changes.
      e.failedEtag = etag;
      changed = e.state === "loading" || msg !== e.problem;
      if (e.state !== "ready") e.state = "error";
      if (changed) console.warn(`[gl] LUT preview ${e.state === "ready" ? "keeps the previous table" : "unavailable"} for ${path}:`, msg);
      e.problem = msg;
    })
    .finally(() => {
      e.checking = false;
      e.checked = nowMs();
      if (changed) notify();
    });
}

/**
 * A LUT in use: at most every lutRecheckMs, ask the core whether the file
 * changed (HEAD → ETag = size + mtime) and re-read it if so — a .cube
 * rewritten at the same path (a regraded LUT) shows without a restart. The
 * version compared is the last one read, or the one that failed to read: a
 * broken rewrite is read once, and a fixed one recovers (a LUT whose first
 * read failed too). A failed read with no validator is retried on the throttle.
 */
function revalidateLut(path: string, e: LutEntry): void {
  if (!fileUrl || e.state === "loading" || e.checking) return;
  const failed = e.failedEtag !== undefined;
  const seen = failed ? e.failedEtag : e.etag;
  if (!seen && !failed) return; // read fine, but the core sent no validator to compare
  const t = nowMs();
  if (t - e.checked < lutRecheckMs) return;
  e.checked = t;
  if (!seen) {
    readLut(path, e);
    return;
  }
  e.checking = true;
  fetch(fileUrl(path), { method: "HEAD", cache: "no-store" })
    .then((r) => {
      const tag = r.ok ? r.headers.get("etag") : null;
      if (tag && tag !== seen && luts.get(path) === e) readLut(path, e);
      else e.checking = false;
    })
    .catch(() => {
      e.checking = false;
    });
}

let lutTimer: ReturnType<typeof setInterval> | null = null;

/**
 * While a LUT is on screen (or left out of it after a failed read), re-check
 * it on a timer too: a paused preview draws nothing, so a .cube rewritten then
 * would otherwise show only at the next step or scrub. A change re-reads it,
 * and the read's notify() repaints. The timer stops once no recent frame uses
 * a LUT.
 */
function watchLuts(): void {
  if (lutTimer || typeof setInterval === "undefined") return;
  lutTimer = setInterval(() => {
    let inUse = false;
    for (const [path, e] of luts) {
      if (e.state === "loading" || runSerial - e.lastRun >= 16) continue;
      inUse = true;
      if (typeof document === "undefined" || !document.hidden) revalidateLut(path, e);
    }
    if (!inUse && lutTimer) {
      clearInterval(lutTimer);
      lutTimer = null;
    }
  }, Math.max(250, lutRecheckMs));
}

/** The LUT's state; starts loading it through the /file route, and keeps an eye on the file while it is used. */
export function lutStatus(path: string): LutEntry["state"] {
  let e = luts.get(path);
  if (!e) {
    // No resolver yet (the first frame can draw before the preview installs
    // it): report "loading" and try again next frame, nothing cached.
    if (!fileUrl) return "loading";
    e = { state: "loading", checked: 0, bytes: 0, lastRun: runSerial };
    luts.set(path, e);
    readLut(path, e);
    return e.state;
  }
  // Most recently used last (Map order = the LRU order).
  luts.delete(path);
  luts.set(path, e);
  e.lastRun = runSerial;
  revalidateLut(path, e);
  watchLuts();
  return e.state;
}

/**
 * Why the preview does not show this LUT as the file on disk has it, or null:
 * left out (state "error"), or an older table kept because the file's newer
 * content failed to read. The export reads the file itself.
 */
export function lutProblem(path: string): { state: "error" | "stale"; reason: string } | null {
  const e = luts.get(path);
  if (!e?.problem || e.state === "loading") return null;
  return { state: e.state === "ready" ? "stale" : "error", reason: e.problem };
}

/** Register an already-parsed LUT (the parity page has no /file route). */
export function provideLut(path: string, cube: CubeLut): void {
  const old = luts.get(path);
  if (old) dropLutTexture(old);
  luts.set(path, { state: "ready", cube, checked: 0, bytes: cube.data.byteLength, lastRun: runSerial });
  enforceLutBudget();
}

/** Test hook: the LUT cache (paths oldest first, bytes), the change-check interval and the table budget. */
export function lutCacheForTest(recheckMs?: number, maxBytes?: number): { paths: string[]; bytes: number; textures: number } {
  if (maxBytes !== undefined) lutMaxBytes = maxBytes;
  if (recheckMs !== undefined && recheckMs !== lutRecheckMs) {
    lutRecheckMs = recheckMs;
    if (lutTimer) {
      clearInterval(lutTimer);
      lutTimer = null;
      watchLuts();
    }
  }
  let bytes = 0;
  let textures = 0;
  for (const e of luts.values()) {
    bytes += e.bytes;
    if (e.tex) textures++;
  }
  return { paths: [...luts.keys()], bytes, textures };
}

function lutTexture(s: State, path: string): { tex: WebGLTexture; cube: CubeLut } | null {
  const e = luts.get(path);
  if (!e || e.state !== "ready" || !e.cube) return null;
  if (e.tex && e.gen === s.gen) return { tex: e.tex, cube: e.cube };
  const { gl } = s;
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
  gl.bindTexture(gl.TEXTURE_3D, tex);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const n = e.cube.size;
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, n, n, n, 0, gl.RGB, gl.FLOAT, e.cube.data);
  e.tex = tex;
  e.gen = s.gen;
  return { tex, cube: e.cube };
}

// ---- running a layer -------------------------------------------------------------------------

/** A layer to process. Sizes in pixels. */
export interface LayerJob {
  /** The frame: a <video>, an <img> or a canvas. */
  source: TexImageSource;
  srcW: number;
  srcH: number;
  /**
   * The source's pixels change over time (a video: re-uploaded when its
   * currentTime moves; a canvas: every run). False = a still, uploaded once.
   */
  dynamic: boolean;
  /** The source rect to show (crop), in source pixels. */
  crop: { x: number; y: number; w: number; h: number };
  /** Processing size of the canvas-space frame. */
  w: number;
  h: number;
  /** The picture's rect inside it (fit + padding), processing pixels. */
  pic: { x: number; y: number; w: number; h: number };
  steps: readonly PlannedStep[];
  /** Processing pixels per canvas (export) pixel. */
  k: number;
  /** Canvas (export) size. */
  cw: number;
  ch: number;
  /** Timeline frame number (grain seed; the history clock of a layer without a source clock). */
  frame: number;
  /**
   * The source frame shown (a video clip): temporal effects (trails, denoise)
   * advance per SOURCE frame, as the export's lagfun / hqdn3d run before the
   * clip's speed change — a repeated frame (slow motion) is no step, a frame
   * at 2× speed two. Absent (stills, adjustment layers): the timeline frame.
   */
  srcFrame?: number;
  /** Source frames per timeline frame (|speed| × source fps / project fps), for the seek test; default 1. */
  srcStep?: number;
  /** Stable layer id for history and table textures. */
  layerId: string;
}

/** Where the processed layer is: a sub-rect of the shared GL canvas (valid until the next run — draw it now). */
export interface GLResult {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  w: number;
  h: number;
}

const result: GLResult = { canvas: null as unknown as HTMLCanvasElement, x: 0, y: 0, w: 0, h: 0 };

/** Timeline frames a history keeps accumulating across (a slow machine skips some); a bigger jump is a seek. */
const MAX_FRAME_GAP = 15;

const RESAMPLE_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D u_src;
uniform ivec2 u_srcSize;
uniform ivec2 u_dstSize;
out uvec4 o_color;
vec4 at(ivec2 q) { return uintBitsToFloat(texelFetch(u_src, clamp(q, ivec2(0), u_srcSize - 1), 0)); }
void main() {
  vec2 c = gl_FragCoord.xy * vec2(u_srcSize) / vec2(u_dstSize) - 0.5;
  ivec2 i = ivec2(floor(c));
  vec2 f = c - floor(c);
  vec4 v = mix(mix(at(i), at(i + ivec2(1, 0)), f.x), mix(at(i + ivec2(0, 1)), at(i + ivec2(1, 1)), f.x), f.y);
  o_color = floatBitsToUint(v);
}`;

/** Bilinear copy of a float (history) target into one of another size. */
function resampleInto(s: State, from: Target, to: Target): boolean {
  const { gl } = s;
  if (!s.resample) {
    const fs = compile(gl, gl.FRAGMENT_SHADER, RESAMPLE_FS);
    const prog = fs ? gl.createProgram() : null;
    if (!fs || !prog) return false;
    gl.attachShader(prog, s.vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
    s.resample = { prog, src: gl.getUniformLocation(prog, "u_src"), srcSize: gl.getUniformLocation(prog, "u_srcSize"), dstSize: gl.getUniformLocation(prog, "u_dstSize") };
  }
  const r = s.resample;
  gl.useProgram(r.prog);
  gl.uniform1i(r.src, 0);
  gl.uniform2i(r.srcSize, from.w, from.h);
  gl.uniform2i(r.dstSize, to.w, to.h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, to.fbo);
  gl.viewport(0, 0, to.w, to.h);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, from.tex);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return true;
}

function history(s: State, id: string, w: number, h: number, frame: number, maxGap: number, step: PlannedStep, settled: boolean): Hist | null {
  const sig = step.histSig ?? "";
  const params = step.histParams ?? "";
  let st = s.hist.get(id);
  if (st && (st.a.w !== w || st.a.h !== h)) {
    // A new processing size (playback resolution, a zoom bucket): the state is
    // resampled into it, so pausing or zooming doesn't wipe a trail.
    const a = makeTarget(s, w, h, true);
    const b = makeTarget(s, w, h, true);
    const ok = !!a && !!b && resampleInto(s, st.a, a) && resampleInto(s, st.b, b);
    dropTarget(s, st.a);
    dropTarget(s, st.b);
    if (ok) {
      st.a = a!;
      st.b = b!;
    } else {
      if (a) dropTarget(s, a);
      if (b) dropTarget(s, b);
      s.hist.delete(id);
      st = undefined;
    }
  }
  if (!st) {
    const a = makeTarget(s, w, h, true);
    const b = makeTarget(s, w, h, true);
    if (!a || !b) return null;
    st = { a, b, frame, steps: 1, reset: true, lastRun: runSerial, sig, params, since: frame, dirty: !settled };
    s.hist.set(id, st);
    return st;
  }
  st.lastRun = runSerial;
  if (st.sig !== sig) {
    // Other effects before it, or another order: the state was built from
    // another input (trails after an invert that now comes after it) — start over.
    st.sig = sig;
    st.reset = true;
    st.steps = 1;
  } else if (frame === st.frame) {
    // The same frame again: recompute B from the same A (new settings keep the
    // trail on screen, but it is no longer what the export has).
    if (st.params !== params) st.since = frame;
    st.params = params;
    st.dirty = !settled;
    return st;
  } else if (frame > st.frame && frame - st.frame <= maxGap) {
    // Playing (or stepping) forward: last frame's result is the new history —
    // still the export's only if no frame was skipped, every frame was the
    // right one and the settings didn't change.
    if (frame - st.frame > 1 || st.dirty || st.params !== params) st.since = frame;
    [st.a, st.b] = [st.b, st.a];
    st.steps = frame - st.frame;
    st.reset = false;
    st.params = params;
    st.frame = frame;
    st.dirty = !settled;
    return st;
  } else {
    // A seek, a jump back or a long gap: start over, like the export at a clip start.
    st.reset = true;
    st.steps = 1;
  }
  st.params = params;
  st.frame = frame;
  st.since = frame;
  st.dirty = !settled;
  return st;
}

/** Source frames a paused warm-up re-runs at most (warmup.ts): 3 s at 30 fps. */
export const WARM_MAX_FRAMES = 90;

/**
 * How far back a history step's state reaches: trails' lagfun keeps a frame
 * until decay^n × 255 rounds away (59 frames at the default 0.9); hqdn3d's
 * temporal smoothing settles well within 30.
 */
function warmWindow(step: PlannedStep): number {
  if (step.kind === "trails") {
    const d = step.passes[0]?.uniforms.u_decay;
    const decay = typeof d === "number" ? d : 0.9;
    if (decay > 0 && decay < 1) return Math.min(WARM_MAX_FRAMES, Math.ceil(Math.log(0.5 / 255) / Math.log(decay)));
    return WARM_MAX_FRAMES;
  }
  return 30;
}

/**
 * After a paused frame of a video layer: the source frame its temporal
 * steps (trails, denoise) would have to be re-run from to show what the
 * export does — whose histories run from the clip's first frame — or null
 * when they already do (or the layer has none, or a seek is still landing).
 * `first` = the clip's first source frame.
 */
export function historyGap(layerId: string, steps: readonly PlannedStep[], clock: number, first: number): number | null {
  const s = state;
  if (!s) return null;
  let from: number | null = null;
  for (const step of steps) {
    if (!step.history) continue;
    const need = Math.max(first, clock - warmWindow(step));
    const h = s.hist.get(`${layerId}|${step.id}`);
    if (h && h.frame === clock && h.dirty) return null; // the redraw after the seek decides
    if (h && h.frame === clock && h.since <= need) continue;
    from = from === null ? need : Math.min(from, need);
  }
  return from !== null && from < clock ? from : null;
}

/** Move one layer id's histories to another (a finished warm-up becomes the layer's own), replacing what was there. */
export function adoptHistory(fromLayer: string, toLayer: string): void {
  const s = state;
  if (!s) return;
  const pre = `${fromLayer}|`;
  for (const [key, st] of [...s.hist]) {
    if (!key.startsWith(pre)) continue;
    s.hist.delete(key);
    const dst = `${toLayer}|${key.slice(pre.length)}`;
    const old = s.hist.get(dst);
    if (old) {
      dropTarget(s, old.a);
      dropTarget(s, old.b);
    }
    st.lastRun = runSerial;
    s.hist.set(dst, st);
  }
}

/** Free a layer id's histories now (an abandoned warm-up). */
export function dropHistory(layer: string): void {
  const s = state;
  if (!s) return;
  const pre = `${layer}|`;
  for (const [key, st] of [...s.hist]) {
    if (!key.startsWith(pre)) continue;
    dropTarget(s, st.a);
    dropTarget(s, st.b);
    s.hist.delete(key);
  }
}

/** Test hook: a layer's history bookkeeping per step id. */
export function historyForTest(layerId: string): Record<string, { frame: number; since: number; reset: boolean; dirty: boolean }> {
  const out: Record<string, { frame: number; since: number; reset: boolean; dirty: boolean }> = {};
  const pre = `${layerId}|`;
  for (const [key, st] of state?.hist ?? []) {
    if (key.startsWith(pre)) out[key.slice(pre.length)] = { frame: st.frame, since: st.since, reset: st.reset, dirty: st.dirty };
  }
  return out;
}

function evictHistory(s: State): void {
  for (const [id, st] of s.hist) {
    if (runSerial - st.lastRun > 600) {
      dropTarget(s, st.a);
      dropTarget(s, st.b);
      s.hist.delete(id);
    }
  }
}

function setUniform(gl: WebGL2RenderingContext, u: UniformInfo, v: number | readonly number[]): void {
  const arr = typeof v === "number" ? null : (v as number[]);
  switch (u.type) {
    case gl.FLOAT: gl.uniform1f(u.loc, arr ? arr[0] : (v as number)); break;
    case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, arr!); break;
    case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, arr!); break;
    case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, arr!); break;
    case gl.INT: case gl.BOOL: gl.uniform1i(u.loc, arr ? arr[0] : (v as number)); break;
    case gl.INT_VEC2: gl.uniform2iv(u.loc, arr!); break;
    case gl.INT_VEC3: gl.uniform3iv(u.loc, arr!); break;
    case gl.INT_VEC4: gl.uniform4iv(u.loc, arr!); break;
    case gl.UNSIGNED_INT: gl.uniform1ui(u.loc, arr ? arr[0] : (v as number)); break;
    case gl.UNSIGNED_INT_VEC2: gl.uniform2uiv(u.loc, arr!); break;
    default: break;
  }
}

function setPassUniforms(gl: WebGL2RenderingContext, p: Prog, e: Elem): void {
  const u = e.pass.uniforms;
  for (const name in u) {
    const info = p.uni.get(name);
    if (info) setUniform(gl, info, u[name]);
  }
}

/** Bind the step's table textures to the units of the samplers its body declares. */
function bindTables(s: State, p: Prog, e: Elem, layerId: string): void {
  const { gl } = s;
  const step = e.step;
  if (!step) return;
  if (e.tables2D.length && step.aux) {
    const tex = auxTexture(s, `${layerId}|${step.id}`, step.aux, step.auxWidth ?? step.aux.length / 4);
    for (const name of e.tables2D) {
      const unit = p.units.get(name);
      if (unit === undefined) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    }
  }
  if (e.tables3D.length && step.lut) {
    const lut = lutTexture(s, step.lut);
    if (!lut) return;
    for (const name of e.tables3D) {
      const unit = p.units.get(name);
      if (unit === undefined) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_3D, lut.tex);
    }
    const n = lut.cube.size - 1;
    const sc = p.uni.get("u_lut3d_scale");
    if (sc) gl.uniform3f(sc.loc, Math.fround(lut.cube.scale[0] * n), Math.fround(lut.cube.scale[1] * n), Math.fround(lut.cube.scale[2] * n));
    const mx = p.uni.get("u_lut3d_max");
    if (mx) gl.uniform1f(mx.loc, n);
  }
}

/** A source's crop rect drawn small enough to upload (see fitSource), kept per element. */
interface Prescaled {
  canvas: HTMLCanvasElement;
  /** Crop rect + size it holds. */
  key: string;
}
const prescaled = new WeakMap<object, Prescaled>();

/**
 * A source larger than the GPU's MAX_TEXTURE_SIZE (a 45–61 MP still on a
 * software renderer's 8192, a long panorama on a GPU's 16384) can't be
 * uploaded: texImage2D fails without throwing and the layer would come out
 * black. Its crop rect is drawn through a 2D canvas instead, scaled to fit
 * the processing cap (more is never sampled), once for a still and again
 * whenever the crop changes, every run for a changing source. Returns the
 * job with that canvas as its source, or null (CSS fallback).
 */
function fitSource(s: State, job: LayerJob): LayerJob | null {
  if (typeof document === "undefined" || (typeof ImageData !== "undefined" && job.source instanceof ImageData)) return null;
  const lim = Math.min(s.hwMaxTex, s.maxTex);
  const { x, y, w, h } = job.crop;
  const sc = Math.min(1, lim / w, lim / h);
  const cw = Math.max(1, Math.min(lim, Math.round(w * sc)));
  const ch = Math.max(1, Math.min(lim, Math.round(h * sc)));
  const key = `${x},${y},${w},${h},${cw},${ch}`;
  let e = prescaled.get(job.source);
  if (!e) {
    e = { canvas: document.createElement("canvas"), key: "" };
    prescaled.set(job.source, e);
  }
  if (e.key !== key || job.dynamic) {
    const c = e.canvas;
    if (c.width !== cw || c.height !== ch) {
      c.width = cw;
      c.height = ch;
    }
    const g = c.getContext("2d");
    if (!g) return null;
    g.globalCompositeOperation = "copy";
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(job.source as CanvasImageSource, x, y, w, h, 0, 0, cw, ch);
    e.key = key;
    const st = s.srcs.get(c);
    if (st) st.w = -1; // new pixels: upload again
  }
  return { ...job, source: e.canvas, srcW: cw, srcH: ch, crop: { x: 0, y: 0, w: cw, h: ch } };
}

/** The job's frame as a texture: uploaded only when the element, its size or its media time changed. */
function sourceTexture(s: State, job: LayerJob): WebGLTexture | null {
  const { gl } = s;
  // A video's frame is keyed by its source + media time; mid-seek (the frame
  // about to change under the same time) and canvases always re-upload.
  const el = job.source as { currentTime?: number; currentSrc?: string; seeking?: boolean };
  const isMedia = typeof el.currentTime === "number" && !el.seeking;
  const time = !job.dynamic ? 0 : isMedia ? el.currentTime! : NaN;
  const url = job.dynamic && isMedia ? el.currentSrc ?? "" : "";
  let st = s.srcs.get(job.source);
  if (!st) {
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    st = { tex, w: -1, h: -1, time: NaN, url: "", lastRun: runSerial };
    s.srcs.set(job.source, st);
  }
  st.lastRun = runSerial;
  // NaN never equals itself, so a canvas (no media time) is uploaded every run.
  if (st.w !== job.srcW || st.h !== job.srcH || st.time !== time || st.url !== url) {
    gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, st.tex);
    // A failed upload doesn't throw: on a new size (where one can fail — the
    // check costs a GPU round trip, so not on every video frame) look for the
    // error, and leave the entry unrecorded so the next run tries again.
    const resized = st.w !== job.srcW || st.h !== job.srcH;
    if (resized) for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++) { /* drain earlier errors */ }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, job.source);
    if (resized && gl.getError() !== gl.NO_ERROR) {
      st.w = st.h = -1;
      return null;
    }
    st.w = job.srcW;
    st.h = job.srcH;
    st.time = time;
    st.url = url;
  }
  return st.tex;
}

function evictSources(s: State): void {
  for (const [el, st] of s.srcs) {
    if (runSerial - st.lastRun > 300) {
      s.gl.deleteTexture(st.tex);
      s.srcs.delete(el);
    }
  }
}

/** Pooled targets the current run holds (released as soon as nothing reads them). */
const held = new Set<Target>();

/**
 * Run the layer through its plan. Returns the region of the shared GL canvas
 * holding the premultiplied result, or null when the pass can't run (no
 * WebGL2 / lost context / an undecodable or tainted frame) — the caller then
 * uses its 2D fallback. With `readback`, returns the straight RGBA bytes
 * instead (rows top-down) — the parity and bench scripts use it.
 */
export function runLayer(job: LayerJob): GLResult | null;
export function runLayer(job: LayerJob, readback: true): Uint8Array | null;
export function runLayer(job: LayerJob, readback = false): GLResult | Uint8Array | null {
  if (!readback && optedOut()) return null;
  const s = ensure();
  if (!s) return null;
  const { gl } = s;
  const W = Math.round(job.w);
  const H = Math.round(job.h);
  if (W < 1 || H < 1 || W > s.maxTex || H > s.maxTex) return null;
  if (!(job.pic.w > 0) || !(job.pic.h > 0) || !(job.crop.w > 0) || !(job.crop.h > 0)) return null;
  runSerial++;
  const take = (float: boolean): Target | null => {
    const t = acquire(s, W, H, float);
    if (t) held.add(t);
    return t;
  };
  const drop = (t: Target | null) => {
    if (t && held.delete(t)) release(s, t);
  };
  try {
    // 1. Upload the frame — unless this element's frame is already uploaded
    // (a still, a paused video): each element keeps its own texture. A source
    // the GPU can't hold goes through a scaled 2D canvas first.
    const src = job.srcW > s.hwMaxTex || job.srcH > s.hwMaxTex ? fitSource(s, job) : job;
    if (!src) return null;
    const srcTex = sourceTexture(s, src);
    if (!srcTex) return null;
    // A video still seeking shows its previous frame: a history built on it is marked (Hist.dirty).
    const settled = !(job.dynamic && (job.source as { seeking?: boolean }).seeking === true);

    // 2. The steps that can run now (a LUT still loading is left out for the moment) → fused draws.
    let runnable: readonly PlannedStep[] = job.steps;
    for (const st of job.steps) {
      if (st.lut && (lutStatus(st.lut) !== "ready" || !lutTexture(s, st.lut))) {
        runnable = job.steps.filter((x) => !x.lut || (lutStatus(x.lut) === "ready" && !!lutTexture(s, x.lut)));
        break;
      }
    }
    const groups = groupsFor(job.steps, runnable);
    const last = groups[groups.length - 1];
    const lastIsFinal = !last.float && !last.history;

    // The final draw writes premultiplied RGBA into the shared canvas (or, for
    // a readback, straight RGBA into a target that is then read).
    let finalTarget: Target | null = null;
    if (readback) {
      if (!s.readTarget || s.readTarget.w !== W || s.readTarget.h !== H) {
        if (s.readTarget) dropTarget(s, s.readTarget);
        s.readTarget = makeTarget(s, W, H, false);
        if (!s.readTarget) return null;
      }
      finalTarget = s.readTarget;
    } else {
      if (s.canvas.width < W) s.canvas.width = W;
      if (s.canvas.height < H) s.canvas.height = H;
    }
    const finalMode = readback ? 2 : 1;

    const bindIO = (input: WebGLTexture, orig: WebGLTexture | null, hist: WebGLTexture | null, target: Target | null) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.viewport(0, 0, W, H);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, input);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, orig);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, hist);
    };
    const common = (p: Prog) => {
      const u = p.uni.get("u_size");
      if (u) gl.uniform2i(u.loc, W, H);
      const k = p.uni.get("u_k");
      if (k) gl.uniform1f(k.loc, job.k);
      const c = p.uni.get("u_canvas");
      if (c) gl.uniform2f(c.loc, job.cw, job.ch);
      const seed = p.uni.get("u_seed");
      if (seed) gl.uniform1f(seed.loc, job.frame);
    };

    // 3. The draws: each reads the previous result (u_in) and its step's input (u_orig).
    let cur: Target | null = null;
    let stepIn: Target | null = null;
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const isFinal = gi === groups.length - 1 && lastIsFinal;
      const p = program(s, groupSource(g, isFinal ? finalMode : 0));
      if (!p) return null;
      let hist: Hist | null = null;
      let target: Target | null;
      if (g.history) {
        const clock = job.srcFrame ?? job.frame;
        const step = g.host.step!;
        hist = history(s, `${job.layerId}|${step.id}`, W, H, clock, MAX_FRAME_GAP * Math.max(1, job.srcStep ?? 1), step, settled);
        if (!hist) return null;
        target = hist.b;
      } else if (isFinal) {
        target = finalTarget;
      } else {
        target = take(g.float);
        if (!target) return null;
      }
      if (g.host.stepFirst && !g.host.stepLast) stepIn = cur; // a multi-pass step begins: keep its input
      const orig = g.host.stepFirst ? cur : stepIn;
      gl.useProgram(p.prog);
      common(p);
      if (g.place) {
        const rect = p.uni.get("u_rect");
        if (rect) gl.uniform4f(rect.loc, job.pic.x, job.pic.y, job.pic.w, job.pic.h);
        const crop = p.uni.get("u_crop");
        if (crop) gl.uniform4f(crop.loc, src.crop.x, src.crop.y, src.crop.w, src.crop.h);
        const ss = p.uni.get("u_srcSize");
        if (ss) gl.uniform2f(ss.loc, src.srcW, src.srcH);
      }
      if (hist) {
        const r = p.uni.get("u_reset");
        if (r) gl.uniform1i(r.loc, hist.reset ? 1 : 0);
        const st = p.uni.get("u_steps");
        if (st) gl.uniform1f(st.loc, hist.steps);
      }
      setPassUniforms(gl, p, g.host);
      bindTables(s, p, g.host, job.layerId);
      for (const o of g.ops) {
        setPassUniforms(gl, p, o);
        bindTables(s, p, o, job.layerId);
      }
      bindIO(g.place ? srcTex : cur!.tex, orig ? orig.tex : null, hist ? hist.a.tex : null, target);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (isFinal) break;
      // The previous result is no longer needed (unless it is a running step's input).
      if (cur !== stepIn) drop(cur);
      if (g.host.stepLast && stepIn) {
        if (stepIn !== cur) drop(stepIn);
        stepIn = null;
      }
      cur = target;
    }

    // 4. An output draw when the plan ended on a float / history target.
    if (!lastIsFinal) {
      const copy: Group = {
        host: elem(COPY_PASS, null, last.endDom, true, true), ops: [], inDom: last.endDom, origDom: last.endDom,
        endDom: last.endDom, float: false, history: false, inFloat: true, place: false, sources: [],
      };
      const p = program(s, groupSource(copy, finalMode));
      if (!p) return null;
      gl.useProgram(p.prog);
      common(p);
      bindIO(cur!.tex, null, null, finalTarget);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    if (runSerial % 120 === 0) {
      trimPool(s);
      evictHistory(s);
      evictSources(s);
      evictAux(s);
      evictLuts(s);
    }
    if (readback) {
      const bytes = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.readTarget!.fbo);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return bytes;
    }
    result.canvas = s.canvas;
    result.x = 0;
    result.y = s.canvas.height - H; // the default framebuffer's origin is bottom-left
    result.w = W;
    result.h = H;
    return result;
  } catch (err) {
    // A tainted / not-yet-decodable frame (SecurityError / InvalidStateError).
    if (!(err instanceof DOMException)) console.warn("[gl] layer pass failed:", err);
    for (const el of [job.source, prescaled.get(job.source)?.canvas]) {
      const st = el && s.srcs.get(el);
      if (st) st.time = NaN; // upload again next time
    }
    return null;
  } finally {
    for (const t of held) release(s, t);
    held.clear();
  }
}

let software: boolean | null = null;
/**
 * True when WebGL runs on a CPU rasterizer (SwiftShader, llvmpipe, WARP …):
 * the preview then processes looks at half resolution while PLAYING.
 */
export function glSoftware(): boolean {
  if (software !== null) return software;
  const r = glRenderer();
  if (r === null) return false;
  software = /swiftshader|llvmpipe|softpipe|software|basic render|warp/i.test(r);
  return software;
}

/** Debug / bench: the GL renderer string, or null. */
export function glRenderer(): string | null {
  const s = ensure();
  if (!s) return null;
  const dbg = s.gl.getExtension("WEBGL_debug_renderer_info");
  return String(s.gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : s.gl.RENDERER));
}

/** Test hook: force the context loss / restore path (WEBGL_lose_context). */
export function loseContextForTest(): { lose: () => void; restore: () => void } | null {
  const s = ensure();
  const ext = s?.gl.getExtension("WEBGL_lose_context");
  return ext ? { lose: () => ext.loseContext(), restore: () => ext.restoreContext() } : null;
}
