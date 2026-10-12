// The WebGL2 preview's per-layer PASS PLAN: a PURE function from a clip's
// (or adjustment layer's) look — colour, grade, LUT, effect stack — to the
// ordered fragment-shader passes the runtime (runtime.ts) executes. The order
// is the export's (packages/core ffmpeg/graph.ts): eq → colorbalance → hue →
// curves → lut3d → every enabled effect in stack order (keys included, each
// multiplying alpha; vignette as its own pass), so bypass, reordering and
// keys between effects preview exactly where the render applies them. The
// mask, blend mode, transform and opacity stay on the Canvas2D side, after.
//
// Every pass carries its uniforms already computed (for one processing size
// and scale), so a cached plan runs without per-frame allocation.

import {
  effectByType, isEnabled, isKeyType,
  type EffectGLPass, type GLFidelity, type GLUniformContext, type GLUniforms,
} from "@aive/core/effects";
import type { ColorAdjust, ColorGrade, VisualEffect } from "../types";
import {
  GLSL_COLORBALANCE, GLSL_EQ, GLSL_HUE, GLSL_LUT3D, GLSL_TABLE_RGB,
  balanceParams, curvesTables, eqTables, hueParams,
} from "./color";

/** The look the GL plan reads (a subset of ClipEffects). */
export interface LayerLook {
  color?: ColorAdjust;
  grade?: ColorGrade;
  lut?: string;
  filters?: VisualEffect[];
}

export interface PlannedPass {
  frag: string;
  domain: "rgb" | "yuv" | "any";
  out?: "rgb";
  float?: true;
  history?: true;
  /** A per-pixel op (`op_<name>`), fused into the pass before it by the runtime. */
  point?: true;
  uniforms: GLUniforms;
}

export interface PlannedStep {
  /** "eq" | "colorbalance" | "hue" | "curves" | "lut3d" | an effect type. */
  kind: string;
  /** Stable within the layer (history key): "color:…" or "fx:<index>:<type>". */
  id: string;
  fidelity: GLFidelity;
  passes: PlannedPass[];
  /** A key (multiplies alpha). */
  key?: true;
  /** Keeps a history texture across frames. */
  history?: true;
  /** A 256×1 RGBA table bound to u_aux (eq, curves). */
  aux?: Uint8Array;
  /** A .cube path bound to u_lut3 (lut3d). */
  lut?: string;
}

export interface PlanOptions {
  /** Leave the keys out (the inspector's eyedropper previews the clip unkeyed). */
  skipKeys?: boolean;
}

function pass(p: EffectGLPass, uniforms: GLUniforms): PlannedPass {
  return {
    frag: p.frag,
    domain: p.domain ?? "rgb",
    ...(p.out ? { out: p.out } : {}),
    ...(p.float ? { float: true as const } : {}),
    ...(p.history ? { history: true as const } : {}),
    ...(p.point ? { point: true as const } : {}),
    uniforms,
  };
}

/** The colour-grade steps graph.ts emits for `color` / `grade` / `lut`, in its order. */
export function colorSteps(look: LayerLook): PlannedStep[] {
  const out: PlannedStep[] = [];
  if (look.color) {
    // graph.ts wraps eq in alphaSafe, which ends in format=rgba: the value leaves eq as clipped RGB.
    out.push({ kind: "eq", id: "color:eq", fidelity: "exact", aux: eqTables(look.color), passes: [{ frag: GLSL_EQ, point: true, domain: "yuv", out: "rgb", uniforms: {} }] });
  }
  if (look.grade) {
    const cb = balanceParams(look.grade);
    if (cb) {
      out.push({
        kind: "colorbalance", id: "color:balance", fidelity: "exact",
        passes: [{ frag: GLSL_COLORBALANCE, point: true, domain: "rgb", uniforms: { u_cb_s: cb.s, u_cb_m: cb.m, u_cb_h: cb.h } }],
      });
    }
    const hue = hueParams(look.grade);
    if (hue) out.push({ kind: "hue", id: "color:hue", fidelity: "exact", passes: [{ frag: GLSL_HUE, point: true, domain: "yuv", uniforms: { u_hue_cs: hue } }] });
    const curves = curvesTables(look.grade);
    if (curves) {
      out.push({ kind: "curves", id: "color:curves", fidelity: "exact", aux: curves, passes: [{ frag: GLSL_TABLE_RGB, point: true, domain: "rgb", uniforms: {} }] });
    }
  }
  if (look.lut) {
    out.push({ kind: "lut3d", id: "color:lut", fidelity: "exact", lut: look.lut, passes: [{ frag: GLSL_LUT3D, point: true, domain: "rgb", uniforms: {} }] });
  }
  return out;
}

/** The enabled effects with a GL preview, in stack order. Effects without one are skipped (they show only in the render). */
export function effectSteps(filters: readonly VisualEffect[] | undefined, g: GLUniformContext, opts: PlanOptions = {}): PlannedStep[] {
  const out: PlannedStep[] = [];
  for (const [i, f] of (filters ?? []).entries()) {
    if (!isEnabled(f)) continue;
    const d = effectByType(f.type);
    const p = d?.preview;
    const gl = p && p !== "export-only" ? p.gl : undefined;
    if (!gl) continue;
    const key = isKeyType(f.type);
    if (key && opts.skipKeys) continue;
    if (gl.active && !gl.active(f, g)) continue;
    out.push({
      kind: f.type,
      id: `fx:${i}:${f.type}`,
      fidelity: gl.fidelity,
      ...(key ? { key: true as const } : {}),
      ...(gl.history ? { history: true as const } : {}),
      passes: gl.passes.map((ps) => pass(ps, ps.uniforms ? ps.uniforms(f, g) : {})),
    });
  }
  return out;
}

/** The whole layer: colour grade then the effect stack. Empty = nothing for the GL path to do. */
export function planLayer(look: LayerLook | undefined, g: GLUniformContext, opts: PlanOptions = {}): PlannedStep[] {
  if (!look) return [];
  return [...colorSteps(look), ...effectSteps(look.filters, g, opts)];
}

/** Total fragment passes in a plan (each a full-frame draw). */
export function passCount(steps: readonly PlannedStep[]): number {
  return steps.reduce((n, s) => n + s.passes.length, 0);
}

/**
 * The plan for a layer, cached on its look object (state updates replace it)
 * and the processing geometry, so steady playback builds nothing per frame.
 */
interface CacheEntry extends GLUniformContext {
  skip: boolean;
  steps: PlannedStep[];
}
const cache = new WeakMap<object, CacheEntry>();
export function cachedPlan(look: LayerLook | undefined, g: GLUniformContext, opts: PlanOptions = {}): PlannedStep[] {
  if (!look) return [];
  const skip = !!opts.skipKeys;
  const hit = cache.get(look);
  if (hit && hit.k === g.k && hit.w === g.w && hit.h === g.h && hit.cw === g.cw && hit.ch === g.ch && hit.skip === skip) return hit.steps;
  const steps = planLayer(look, g, opts);
  cache.set(look, { k: g.k, w: g.w, h: g.h, cw: g.cw, ch: g.ch, skip, steps });
  return steps;
}
