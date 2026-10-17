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
  assert.equal(c("rgb(255 0 0 / 50%)"), "rgba(255, 0, 0, 0.5)");
  assert.equal(c("rgb(100%, 0%, 0%)"), "rgba(255, 0, 0, 1)");
  assert.equal(c("rgba(255 255 255 0.25)"), "rgba(255, 255, 255, 0.25)");
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
  near("lab(54.29 80.8 69.89)", [255, 0, 0]);
  near("lab(100% 0 0)", [255, 255, 255]);
  near("lch(54.29 106.84 40.85)", [255, 0, 0]);
  near("oklab(0.628 0.2249 0.1258)", [255, 0, 0]);
  near("oklch(0.628 0.2577 29.23)", [255, 0, 0]);
  near("oklch(100% 0 0)", [255, 255, 255]);
  near("oklch(0 0 0)", [0, 0, 0]);
  assert.equal(parseColor("oklch(0.7 0.1 200 / 0.25)")?.a, 0.25);
  assert.match(interpolateColors(0.5, [0, 1], ["oklch(0.628 0.2577 29.23)", "lab(100 0 0)"]), /^rgba\(\d+, \d+, \d+, 1\)$/);
});

test("recorded choice: channels are clamped and rounded; alpha is rounded to 3 decimals", () => {
  assert.equal(interpolateColors(0, [0], ["rgb(300, -5, 127.5)"]), "rgba(255, 0, 128, 1)");
  assert.equal(interpolateColors(1 / 3, [0, 1], ["rgba(0,0,0,0)", "rgba(0,0,0,1)"]), "rgba(0, 0, 0, 0.333)");
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
  throwsCode(() => interpolateColors(Number.NaN, [0, 1], ["red", "blue"]), "graphic_api_misuse");
});
