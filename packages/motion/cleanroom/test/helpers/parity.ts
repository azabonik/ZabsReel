// Replaying parity rows (expressions over the public API) against this runtime.
import { Easing, interpolate, interpolateColors, measureSpring, random, spring } from "../../runtime/src/index";

const API = { interpolate, interpolateColors, spring, measureSpring, Easing, random };

export function evaluate(expr: string, vars: Record<string, number>): unknown {
  const names = [...Object.keys(API), ...Object.keys(vars)];
  const values = [...Object.values(API), ...Object.values(vars)];
  try {
    const value: unknown = new Function(...names, `return (${expr});`)(...values);
    return typeof value === "number" && Number.isNaN(value) ? "NaN" : value;
  } catch {
    return "throws";
  }
}

/** The reports' tolerance: 1e-4 relative for numbers, 1 per colour channel, 0.005 alpha. */
export function matches(expected: unknown, actual: unknown): boolean {
  if (expected === "throws" || actual === "throws") return expected === actual;
  if (typeof expected === "number") {
    return typeof actual === "number" && Math.abs(expected - actual) <= 1e-4 * Math.max(1, Math.abs(expected));
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((v, i) => matches(v, actual[i]));
  }
  if (typeof expected === "string" && typeof actual === "string") {
    const ce = /^rgba\((.*)\)$/.exec(expected);
    const ca = /^rgba\((.*)\)$/.exec(actual);
    if (ce && ca) {
      const a = ce[1].split(",").map(Number);
      const b = ca[1].split(",").map(Number);
      return a.length === b.length && a.every((v, i) => (Number.isNaN(v) ? Number.isNaN(b[i]) : Math.abs(v - b[i]) <= (i === 3 ? 0.005 : 1)));
    }
    const pe = expected.split(/\s+/);
    const pa = actual.split(/\s+/);
    return (
      pe.length === pa.length &&
      pe.every((token, i) => {
        const ne = /^(-?[\d.]+(?:e[+-]?\d+)?)([a-z%]*)$/i.exec(token);
        const na = /^(-?[\d.]+(?:e[+-]?\d+)?)([a-z%]*)$/i.exec(pa[i]);
        if (ne && na) return ne[2] === na[2] && matches(Number(ne[1]), Number(na[1]));
        return token === pa[i];
      })
    );
  }
  return expected === actual;
}
