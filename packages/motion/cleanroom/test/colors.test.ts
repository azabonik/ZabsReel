import assert from "node:assert/strict";
import test from "node:test";
import { Easing, interpolateColors } from "../runtime/src/index";
import { parseColor } from "../runtime/src/colors";
import { throwsCode } from "./helpers/host";

test("documented examples at frame 10 of [0, 20]", () => {
  const at10 = (from: string, to: string) => interpolateColors(10, [0, 20], [from, to]);
  assert.equal(at10("red", "yellow"), "rgba(255, 128, 0, 1)");
  assert.equal(at10("rgb(255, 0, 0)", "rgb(255, 255, 0)"), "rgba(255, 128, 0, 1)");
  assert.equal(at10("rgba(255, 0, 0, 1)", "rgba(255, 255, 0, 0)"), "rgba(255, 128, 0, 0.5)");
  assert.equal(at10("hsl(0, 100%, 50%)", "hsl(60, 100%, 50%)"), "rgba(255, 128, 0, 1)");
  assert.equal(at10("hsla(0, 100%, 50%, 1)", "hsla(60, 100%, 50%, 1)"), "rgba(255, 128, 0, 1)");
  assert.equal(at10("#ff0000", "#ffff00"), "rgba(255, 128, 0, 1)");
});

test("a single colour range returns that colour as an rgba string", () => {
  assert.equal(interpolateColors(99, [0], ["white"]), "rgba(255, 255, 255, 1)");
  assert.equal(interpolateColors(0, [5], ["#00000080"]), "rgba(0, 0, 0, 0.502)");
});

test("easing (single and per segment) and posterize", () => {
  assert.equal(interpolateColors(5, [0, 10], ["black", "white"], { easing: Easing.in(Easing.quad) }), "rgba(64, 64, 64, 1)");
  const perSegment = { easing: [Easing.in(Easing.quad), Easing.out(Easing.quad)] };
  assert.equal(interpolateColors(15, [0, 10, 20], ["black", "white", "black"], perSegment), "rgba(64, 64, 64, 1)");
  const at = (f: number) => interpolateColors(f, [0, 30], ["black", "white"], { posterize: 3 });
  assert.equal(at(1), at(0));
  assert.equal(at(2), at(0));
  assert.equal(at(4), at(3));
  assert.notEqual(at(3), at(0));
  throwsCode(() => interpolateColors(1, [0, 1], ["red", "blue"], { posterize: 0 }), "graphic_api_misuse");
  throwsCode(() => interpolateColors(1, [0, 1, 2], ["red", "blue", "red"], { easing: [Easing.quad] }), "graphic_api_misuse");
});

test("recorded choice: inputs outside the range hold the end colours", () => {
  assert.equal(interpolateColors(-10, [0, 10], ["red", "blue"]), "rgba(255, 0, 0, 1)");
  assert.equal(interpolateColors(50, [0, 10], ["red", "blue"]), "rgba(0, 0, 255, 1)");
});

test("recorded choice: interpolation happens per channel in non-premultiplied sRGB", () => {
  assert.equal(interpolateColors(0.5, [0, 1], ["rgba(255, 0, 0, 1)", "rgba(0, 0, 255, 0)"]), "rgba(128, 0, 128, 0.5)");
  assert.equal(interpolateColors(0.5, [0, 1], ["hsl(0, 100%, 50%)", "hsl(120, 100%, 50%)"]), "rgba(128, 128, 0, 1)");
});

test("recorded choice: hex forms, transparent, names and space syntax are accepted", () => {
  const c = (s: string) => interpolateColors(0, [0], [s]);
  assert.equal(c("#f00"), "rgba(255, 0, 0, 1)");
  assert.equal(c("#f008"), "rgba(255, 0, 0, 0.533)");
  assert.equal(c("#FF000080"), "rgba(255, 0, 0, 0.502)");
  assert.equal(c("transparent"), "rgba(0, 0, 0, 0)");
  assert.equal(c("RebeccaPurple"), "rgba(102, 51, 153, 1)");
  assert.equal(c("rgb(255 0 0 / 50%)"), "rgba(255, 0, 0, 0.502)", "alpha is stored in 8 bits: 128/255");
  assert.equal(c("rgb(100%, 0%, 0%)"), "rgba(255, 0, 0, 1)");
  assert.equal(c("rgba(255 255 255 0.25)"), "rgba(255, 255, 255, 0.251)");
  assert.equal(c("hsl(0.5turn 100% 50%)"), "rgba(0, 255, 255, 1)");
  assert.equal(c("hsl(200grad 100% 50%)"), "rgba(0, 255, 255, 1)");
  assert.equal(c("hsl(3.14159265rad 100% 50%)"), "rgba(0, 255, 255, 1)");
  assert.equal(c("hsl(none 0% 50%)"), "rgba(128, 128, 128, 1)");
});

test("modern colour functions convert to sRGB (hwb, lab, lch, oklab, oklch)", () => {
  const near = (s: string, rgb: [number, number, number], tol = 2) => {
    const p = parseColor(s);
    assert.ok(p, s);
    for (const [i, key] of (["r", "g", "b"] as const).entries()) {
      assert.ok(Math.abs(p[key] - rgb[i]) <= tol, `${s}: ${key} ${p[key]} vs ${rgb[i]}`);
    }
  };
  near("hwb(0 0% 0%)", [255, 0, 0]);
  near("hwb(120 0% 50%)", [0, 128, 0], 1);
  near("hwb(0 60% 60%)", [128, 128, 128], 1);
  near("lab(100% 0 0)", [255, 255, 255], 0.5);
  near("lab(0 0 0)", [0, 0, 0], 0.5);
  near("oklab(0.628 0.2249 0.1258)", [255, 0, 0]);
  near("oklch(0.628 0.2577 29.23)", [255, 0, 0]);
  near("oklch(100% 0 0)", [255, 255, 255]);
  near("oklch(0 0 0)", [0, 0, 0]);
  assert.equal(parseColor("oklch(0.7 0.1 200 / 0.25)")?.a, 0.25);
  assert.match(interpolateColors(0.5, [0, 1], ["oklch(0.628 0.2577 29.23)", "lab(100 0 0)"]), /^rgba\(\d+, \d+, \d+, 1\)$/);
});

test("parity r1 color-016/065, recorded choice: keyframe colours are clipped and rounded to 8 bits (alpha too) before interpolating", () => {
  assert.equal(interpolateColors(0, [0], ["rgb(300, -5, 127.5)"]), "rgba(255, 0, 128, 1)");
  assert.equal(interpolateColors(1 / 3, [0, 1], ["rgba(0,0,0,0)", "rgba(0,0,0,1)"]), "rgba(0, 0, 0, 0.333)");
  const ok = (f: number) => interpolateColors(f, [0, 20], ["oklch(0.63 0.26 29)", "oklch(0.45 0.31 264)"]);
  assert.equal(ok(1), "rgba(242, 0, 14, 1)");
  assert.equal(ok(11), "rgba(115, 3, 140, 1)");
  assert.equal(ok(18), "rgba(26, 5, 228, 1)");
  assert.equal(interpolateColors(0, [0, 1], ["lch(50 40 300 / 25%)", "white"]), "rgba(121, 110, 178, 0.251)");
});

test("parity r1 color-020/021/024, recorded choice: lab() and lch() are read against the D65 white point", () => {
  assert.equal(interpolateColors(0, [0, 1], ["lab(50 40 -20)", "white"]), "rgba(169, 92, 154, 1)");
  assert.equal(interpolateColors(0, [0, 1], ["lch(50 40 300)", "white"]), "rgba(121, 110, 178, 1)");
  const mix = (f: number) => interpolateColors(f, [0, 10], ["lab(30 60 40)", "lch(80 50 200)"]);
  assert.equal(mix(0), "rgba(154, 0, 11, 1)");
  assert.equal(mix(5), "rgba(77, 111, 120, 1)");
  assert.equal(mix(9), "rgba(15, 200, 207, 1)");
});

test("parity r1 ease-087, recorded choice: the result is rounded but not clamped, so overshooting easings can leave 0..255", () => {
  const f = (frame: number) =>
    interpolateColors(frame, [0, 20, 40], ["red", "green", "blue"], { easing: [Easing.spring({ allowTail: true }), Easing.linear] });
  assert.equal(f(2), "rgba(177, 39, 0, 1)");
  assert.equal(f(7), "rgba(-39, 147, 0, 1)");
  assert.equal(f(12), "rgba(-7, 131, 0, 1)");
});

test("parity r1 color-051: at an interior keyframe the segment that ends there applies", () => {
  assert.equal(
    interpolateColors(20, [0, 20, 40], ["red", "green", "blue"], { easing: () => 0.5 }),
    "rgba(128, 64, 0, 1)",
  );
});

test("parity r1 color-054, recorded choice: a NaN input gives NaN channels, except channels equal at both ends", () => {
  assert.equal(interpolateColors(Number.NaN, [0, 20], ["red", "blue"]), "rgba(NaN, 0, NaN, 1)");
});

test("unparseable colours and bad ranges throw graphic_api_misuse", () => {
  for (const bad of ["currentColor", "notacolor", "#12", "rgb(1, 2)", "hsl(10%, 50%, 50%)", "rgb(1 2 3 / 4 / 5)", ""]) {
    const error = throwsCode(() => interpolateColors(0, [0, 1], [bad, "red"]), "graphic_api_misuse");
    assert.ok(error.message.includes(JSON.stringify(bad)));
  }
  throwsCode(() => interpolateColors(0, [0, 1], [3 as unknown as string, "red"]), "graphic_api_misuse");
  throwsCode(() => interpolateColors(0, [0, 1], ["red"]), "graphic_api_misuse");
  throwsCode(() => interpolateColors(0, [], []), "graphic_api_misuse");
  throwsCode(() => interpolateColors(0, [1, 0], ["red", "blue"]), "graphic_api_misuse");
  throwsCode(() => interpolateColors("1" as unknown as number, [0, 1], ["red", "blue"]), "graphic_api_misuse");
});
