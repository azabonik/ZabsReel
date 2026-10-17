import assert from "node:assert/strict";
import test from "node:test";
import { Easing, interpolate } from "../runtime/src/index";
import { throwsCode } from "./helpers/host";

const close = (actual: number, expected: number, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} is not close to ${expected}`);

test("documented examples: fade-in, fade in and out, spring mapping, no clamping", () => {
  assert.equal(interpolate(10, [0, 20], [0, 1]), 0.5);
  const d = 100;
  const fade = (f: number) => interpolate(f, [0, 20, d - 20, d], [0, 1, 1, 0]);
  assert.equal(fade(10), 0.5);
  assert.equal(fade(50), 1);
  assert.equal(fade(d - 10), 0.5);
  assert.equal(fade(d), 0);
  assert.equal(interpolate(0.5, [0, 1], [0, 200]), 100);
  assert.equal(interpolate(40, [0, 20], [0, 1]), 2);
  assert.equal(interpolate(0.5, [1, 2], [1, 2]), 0.5, "additive: [1, 2] at progress 0.5 is 1.5 only inside the range");
  assert.equal(interpolate(1.5, [1, 2], [1, 2]), 1.5);
});

test("extrapolation: the documented table for input 1.5 over [0, 1] -> [0, 2]", () => {
  assert.equal(interpolate(1.5, [0, 1], [0, 2], { extrapolateRight: "extend" }), 3);
  assert.equal(interpolate(1.5, [0, 1], [0, 2], { extrapolateRight: "clamp" }), 2);
  assert.equal(interpolate(1.5, [0, 1], [0, 2], { extrapolateRight: "identity" }), 1.5);
  assert.equal(interpolate(1.5, [0, 1], [0, 2], { extrapolateRight: "wrap" }), 1);
});

test("clamping both sides keeps results inside the output range", () => {
  const opts = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  assert.equal(interpolate(-5, [0, 10], [0, 1], opts), 0);
  assert.equal(interpolate(50, [0, 10], [0, 1], opts), 1);
  assert.equal(interpolate(-5, [0, 10], [1, 0], opts), 1);
});

test("recorded choice: extend uses the first or last segment's slope", () => {
  assert.equal(interpolate(30, [0, 10, 20], [0, 10, 30]), 50);
  assert.equal(interpolate(-10, [0, 10, 20], [0, 10, 30]), -10);
});

test("recorded choice: extend applies the end segment's easing to progress outside 0..1", () => {
  assert.equal(interpolate(15, [0, 10], [0, 100], { easing: Easing.quad }), 225);
});

test("recorded choice: wrap repeats the range on both sides", () => {
  assert.equal(interpolate(-0.5, [0, 1], [0, 2], { extrapolateLeft: "wrap" }), 1);
  assert.equal(interpolate(2.25, [0, 1], [0, 4], { extrapolateRight: "wrap" }), 1);
  assert.equal(interpolate(25, [10, 20], [0, 10], { extrapolateRight: "wrap" }), 5);
});

test("recorded choice: identity returns the input, and works only with plain number outputs", () => {
  assert.equal(interpolate(-7, [0, 1], [0, 2], { extrapolateLeft: "identity" }), -7);
  throwsCode(() => interpolate(2, [0, 1], ["0px", "1px"], { extrapolateRight: "identity" }), "graphic_api_misuse");
  throwsCode(() => interpolate(2, [0, 1], [[0], [1]], { extrapolateRight: "identity" }), "graphic_api_misuse");
});

test("recorded choice: at an interior keyframe the segment that starts there applies", () => {
  const easing = [() => 0.5, () => 0];
  assert.equal(interpolate(10, [0, 10, 20], [0, 10, 0], { easing }), 10);
});

test("easing: one function for every segment, or one per segment", () => {
  assert.equal(interpolate(5, [0, 10], [0, 100], { easing: Easing.quad }), 25);
  const perSegment = { easing: [Easing.quad, Easing.linear] };
  assert.equal(interpolate(5, [0, 10, 20], [0, 100, 200], perSegment), 25);
  assert.equal(interpolate(15, [0, 10, 20], [0, 100, 200], perSegment), 150);
  throwsCode(() => interpolate(5, [0, 10, 20], [0, 1, 2], { easing: [Easing.quad] }), "graphic_api_misuse");
  throwsCode(() => interpolate(5, [0, 10], [0, 1], { easing: [3 as unknown as () => number] }), "graphic_api_misuse");
  throwsCode(() => interpolate(5, [0, 10], [0, 1], { easing: "ease" as unknown as () => number }), "graphic_api_misuse");
  assert.equal(interpolate(5, [3], [9], { easing: [] }), 9, "an empty array for a single keyframe");
});

test("single-value ranges give their value for any input", () => {
  assert.equal(interpolate(-1000, [5], [42]), 42);
  assert.equal(interpolate(1000, [5], ["hello"]), "hello");
  assert.equal(interpolate(3, [5], [true]), true);
  const tuple = [1, 2];
  const out = interpolate(3, [5], [tuple]);
  assert.deepEqual(out, [1, 2]);
  assert.notEqual(out, tuple);
});

test("perceptual-scale: the documented examples at progress 0.5", () => {
  const opts = { output: "perceptual-scale" } as const;
  close(interpolate(0.5, [0, 1], [0, 1], opts), Math.sqrt(0.5));
  close(interpolate(0.5, [0, 1], [1, 2], opts), Math.sqrt(2.5));
  close(interpolate(0.5, [0, 1], [0, -1], opts), -Math.sqrt(0.5));
  assert.equal(interpolate(1, [0, 1], [1, 2], opts), 2);
});

test("recorded choice: perceptual-scale works for tuples and scale strings, and is refused elsewhere", () => {
  const opts = { output: "perceptual-scale" } as const;
  const [a, b] = interpolate(0.5, [0, 1], [[0, 1], [1, 2]], opts);
  close(a, Math.sqrt(0.5));
  close(b, Math.sqrt(2.5));
  assert.equal(interpolate(0.5, [0, 1], ["0", "1"], opts), String(Math.round(Math.sqrt(0.5) * 1e6) / 1e6));
  throwsCode(() => interpolate(0.5, [0, 1], ["0px", "10px"], opts), "graphic_api_misuse");
  throwsCode(() => interpolate(0.5, [0, 1], [false, true], { ...opts, easing: Easing.step1 }), "graphic_api_misuse");
  throwsCode(() => interpolate(0.5, [0, 1], ["a", "b"], { ...opts, easing: Easing.step1 }), "graphic_api_misuse");
});

test("posterize: with 3, frames 0-2 use frame 0's value and frames 3-5 frame 3's", () => {
  const at = (f: number) => interpolate(f, [0, 30], [0, 30], { posterize: 3 });
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(at), [0, 0, 0, 3, 3, 3, 6]);
});

test("recorded choice: posterize uses floor(input / n) * n, also for fractional n and negative input", () => {
  close(interpolate(0.3, [0, 1], [0, 1], { posterize: 0.1 }), 0.3);
  close(interpolate(0.25, [0, 1], [0, 1], { posterize: 0.1 }), 0.2);
  assert.equal(interpolate(-1, [-10, 10], [-10, 10], { posterize: 3 }), -3);
});

test("posterize must be positive and finite", () => {
  for (const bad of [0, -1, Infinity, Number.NaN]) {
    throwsCode(() => interpolate(1, [0, 1], [0, 1], { posterize: bad }), "graphic_api_misuse");
  }
});

test("CSS transform strings: the documented example ranges", () => {
  assert.equal(interpolate(0.5, [0, 1], ["1", "2 3"]), "1.5 2");
  assert.equal(interpolate(0.5, [0, 1], ["0px 0px", "100px 50px"]), "50px 25px");
  assert.equal(interpolate(0.5, [0, 1], ["0deg", "90deg"]), "45deg");
  assert.equal(interpolate(0.5, [0, 1], ["left top", "right bottom"]), "50% 50%");
});

test("recorded choice: CSS value formatting, defaults for missing components, bare zeros and keyword order", () => {
  assert.equal(interpolate(1 / 3, [0, 1], ["0px", "1px"]), "0.333333px");
  assert.equal(interpolate(0.5, [0, 1], ["10px", "30px 20px"]), "20px 10px", "translate's missing y is 0");
  assert.equal(interpolate(0.5, [0, 1], ["0", "100px"]), "50px", "a bare 0 takes the other unit");
  assert.equal(interpolate(0.5, [0, 1], ["0", "1turn"]), "0.5turn");
  assert.equal(interpolate(0.5, [0, 1], ["top left", "right bottom"]), "50% 50%");
  assert.equal(interpolate(0.5, [0, 1], ["center", "right top 10px"]), "75% 25% 5px");
  assert.equal(interpolate(0.5, [0, 1], ["2", "4"]), "3", "unitless strings are scale values");
  assert.equal(interpolate(0.5, [0, 1], ["10px 20px", "30px 40px"], { outputType: "transform-origin" }), "20px 30px");
});

test("CSS transform strings: one value type per call and the same unit per component", () => {
  throwsCode(() => interpolate(0.5, [0, 1], ["0px", "90deg"]), "graphic_api_misuse");
  throwsCode(() => interpolate(0.5, [0, 1], ["0px", "10em"]), "graphic_api_misuse");
  throwsCode(() => interpolate(0.5, [0, 1], ["1px 2px 3px 4px", "0px"]), "graphic_api_misuse");
  throwsCode(() => interpolate(0.5, [0, 1], ["left top 10%", "right"], { outputType: "transform-origin" }), "graphic_api_misuse");
  throwsCode(() => interpolate(0.5, [0, 1], ["10px", "20px 30px"], { outputType: "transform-origin" }), "graphic_api_misuse");
});

test("outputType checks the value type", () => {
  assert.equal(interpolate(0.5, [0, 1], ["0px", "10px"], { outputType: "translate" }), "5px");
  assert.equal(interpolate(0.5, [0, 1], [1, 3], { outputType: "scale" }), 2);
  throwsCode(() => interpolate(0.5, [0, 1], ["1", "2"], { outputType: "translate" }), "graphic_api_misuse");
  throwsCode(() => interpolate(0.5, [0, 1], ["10px", "20px"], { outputType: "rotate" }), "graphic_api_misuse");
  throwsCode(() => interpolate(0.5, [0, 1], ["10px", "20px"], { outputType: "scale" }), "graphic_api_misuse");
  throwsCode(() => interpolate(0.5, [0, 1], [0, 90], { outputType: "rotate" }), "graphic_api_misuse");
  throwsCode(() => interpolate(0.5, [0, 1], [0, 1], { outputType: "skew" as "scale" }), "graphic_api_misuse");
});

test("recorded choice: font-weight accepts numbers, numeric strings, normal and bold, and returns a number", () => {
  assert.equal(interpolate(0.5, [0, 1], ["normal", "bold"], { outputType: "font-weight" }), 550);
  assert.equal(interpolate(0.5, [0, 1], ["100", 900] as unknown as string[], { outputType: "font-weight" }), 500);
  assert.equal(interpolate(0, [0], ["bold"], { outputType: "font-weight" }), 700);
  throwsCode(() => interpolate(0.5, [0, 1], ["normal", "bold"]), "graphic_api_misuse");
  throwsCode(() => interpolate(0.5, [0, 1], ["thin", "bold"], { outputType: "font-weight" }), "graphic_api_misuse");
});

test("discrete strings need Easing.step1 and hold each keyframe's value until the next keyframe", () => {
  const at = (f: number) => interpolate(f, [0, 10, 20], ["a", "b", "c"], { easing: Easing.step1 });
  assert.deepEqual([0, 5, 9].map(at), ["a", "a", "a"]);
  assert.deepEqual([11, 15, 19].map(at), ["b", "b", "b"]);
  // recorded choice: at an interior keyframe its own value applies
  assert.equal(at(10), "b");
  assert.equal(at(20), "c");
  assert.equal(at(99), "c");
  assert.equal(at(-5), "a");
  const perSegment = interpolate(5, [0, 10, 20], ["a", "b", "c"], { easing: [Easing.step1, Easing.step1] });
  assert.equal(perSegment, "a");
  throwsCode(() => interpolate(5, [0, 10], ["hello", "world"]), "graphic_api_misuse");
  throwsCode(() => interpolate(5, [0, 10, 20], ["a", "b", "c"], { easing: [Easing.step1, Easing.linear] }), "graphic_api_misuse");
});

test("booleans: only booleans, Easing.step1 on every segment; the value flips at a keyframe", () => {
  const at = (f: number) => interpolate(f, [0, 10], [false, true], { easing: Easing.step1 });
  assert.deepEqual([0, 9, 10, 20].map(at), [false, false, true, true]);
  throwsCode(() => interpolate(5, [0, 10], [false, true]), "graphic_api_misuse");
  throwsCode(() => interpolate(5, [0, 10], [false, 1] as unknown as boolean[], { easing: Easing.step1 }), "graphic_api_misuse");
});

test("numeric tuples: every tuple the same length; the result is a new array", () => {
  const range = [
    [0, 0],
    [10, 20],
  ];
  const out = interpolate(0.5, [0, 1], range);
  assert.deepEqual(out, [5, 10]);
  assert.ok(Array.isArray(out));
  assert.deepEqual(interpolate(1, [0, 1], range), [10, 20]);
  assert.notEqual(interpolate(1, [0, 1], range), range[1]);
  throwsCode(() => interpolate(0.5, [0, 1], [[0, 0], [1]]), "graphic_api_misuse");
  throwsCode(() => interpolate(0.5, [0, 1], [[], []]), "graphic_api_misuse");
});

test("range rules: same length, at least one value, strictly increasing finite input keyframes", () => {
  throwsCode(() => interpolate(1, [0, 1], [0]), "graphic_api_misuse");
  throwsCode(() => interpolate(1, [], []), "graphic_api_misuse");
  throwsCode(() => interpolate(1, [0, 0], [0, 1]), "graphic_api_misuse");
  throwsCode(() => interpolate(1, [1, 0], [0, 1]), "graphic_api_misuse");
  throwsCode(() => interpolate(1, [0, Infinity], [0, 1]), "graphic_api_misuse");
  throwsCode(() => interpolate(1, [0, Number.NaN], [0, 1]), "graphic_api_misuse");
  throwsCode(() => interpolate(1, "01" as unknown as number[], [0, 1]), "graphic_api_misuse");
  throwsCode(() => interpolate(1, [0, 1], [0, Number.NaN]), "graphic_api_misuse");
  throwsCode(() => interpolate(1, [0, 1], [0, "1px"] as unknown as number[]), "graphic_api_misuse");
});

test("recorded choice: the input must be a finite number", () => {
  for (const bad of [Number.NaN, Infinity, undefined, "3"]) {
    throwsCode(() => interpolate(bad as number, [0, 1], [0, 1]), "graphic_api_misuse");
  }
});

test("invalid extrapolation and output options throw graphic_api_misuse", () => {
  throwsCode(() => interpolate(1, [0, 1], [0, 1], { extrapolateLeft: "mirror" as "clamp" }), "graphic_api_misuse");
  throwsCode(() => interpolate(1, [0, 1], [0, 1], { output: "log" as "linear" }), "graphic_api_misuse");
  throwsCode(() => interpolate(1, [0, 1], [0, 1], "clamp" as unknown as object), "graphic_api_misuse");
});

test("recorded choice: Easing.spring with allowTail keeps moving into the next segment, continuously", () => {
  const cfg = { allowTail: true, damping: 200, durationRestThreshold: 0.03 };
  const tail = Easing.spring(cfg);
  const plain = Easing.spring({ damping: 200, durationRestThreshold: 0.03 });
  const withTail = interpolate(45, [0, 30, 60], [0, 100, 200], { easing: [tail, tail] });
  const without = interpolate(45, [0, 30, 60], [0, 100, 200], { easing: [plain, plain] });
  close(withTail - without, 100 * (tail(1.5) - 1) + 100 * (tail(0.5) - plain(0.5)), 1e-9);
  // The documented call with translate strings works and is continuous at the keyframe.
  const translate = (f: number) =>
    Number.parseFloat(interpolate(f, [0, 30, 60], ["0px", "100px", "200px"], { easing: [tail, tail] }));
  assert.ok(Math.abs(translate(30) - translate(30 - 1e-7)) < 1e-3);
  assert.ok(Math.abs(interpolate(30, [0, 30, 60], [0, 100, 200], { easing: [plain, plain] }) - 100) < 1e-12);
});
