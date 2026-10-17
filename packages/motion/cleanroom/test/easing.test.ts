import assert from "node:assert/strict";
import test from "node:test";
import { Easing } from "../runtime/src/index";
import { throwsCode } from "./helpers/host";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
const samples = (n = 200) => Array.from({ length: n + 1 }, (_, i) => i / n);

test("the reference lists 18 members", () => {
  assert.deepEqual(
    Object.keys(Easing).sort(),
    [
      "back", "bezier", "bounce", "circle", "cubic", "ease", "elastic", "exp", "in", "inOut", "linear",
      "out", "poly", "quad", "sin", "spring", "step0", "step1",
    ].sort(),
  );
});

test("standard functions: linear, quad, cubic and poly(n)", () => {
  assert.equal(Easing.linear(0.3), 0.3);
  close(Easing.quad(0.3), 0.09);
  close(Easing.cubic(0.3), 0.027);
  close(Easing.poly(4)(0.5), 0.0625);
  close(Easing.poly(5)(0.5), 0.03125);
  throwsCode(() => Easing.poly(0), "graphic_api_misuse");
  throwsCode(() => Easing.poly(Number.NaN), "graphic_api_misuse");
});

test("step0 gives 1 whenever n > 0, step1 whenever n >= 1; recorded choice: 0 otherwise", () => {
  assert.deepEqual([-1, 0, 0.001, 1].map(Easing.step0), [0, 0, 1, 1]);
  assert.deepEqual([0, 0.999, 1, 2].map(Easing.step1), [0, 0, 1, 1]);
});

test("recorded choice: sin, circle and exp formulas", () => {
  close(Easing.sin(0.5), 1 - Math.cos(Math.PI / 4));
  close(Easing.circle(0.5), 1 - Math.sqrt(0.75));
  assert.equal(Easing.circle(2), 1);
  assert.equal(Easing.exp(0), 0);
  close(Easing.exp(1), 1);
  close(Easing.exp(0.5), 2 ** -5);
  for (const f of [Easing.sin, Easing.circle, Easing.exp]) {
    close(f(1), 1);
    assert.ok(Math.abs(f(0)) < 1e-12);
  }
});

test("recorded choice: in(e) is e; out reflects it; inOut mirrors it around the middle", () => {
  assert.equal(Easing.in(Easing.quad), Easing.quad);
  close(Easing.out(Easing.quad)(0.25), 1 - 0.75 ** 2);
  const io = Easing.inOut(Easing.cubic);
  close(io(0.25), 0.0625);
  close(io(0.5), 0.5);
  close(io(0.75), 0.9375);
  close(io(1), 1);
  throwsCode(() => Easing.out(5 as unknown as (t: number) => number), "graphic_api_misuse");
});

test("bezier is a cubic Bezier timing curve: through (0,0) and (1,1), matching its parametric form", () => {
  const [x1, y1, x2, y2] = [0.25, 0.1, 0.25, 1];
  const curve = Easing.bezier(x1, y1, x2, y2);
  assert.equal(curve(0), 0);
  assert.equal(curve(1), 1);
  const point = (p1: number, p2: number, s: number) => 3 * (1 - s) ** 2 * s * p1 + 3 * (1 - s) * s * s * p2 + s ** 3;
  for (const s of samples(20)) close(curve(point(x1, x2, s)), point(y1, y2, s), 1e-6);
  const linearPreset = Easing.bezier(0, 0, 1, 1);
  for (const t of samples(10)) close(linearPreset(t), t);
  throwsCode(() => Easing.bezier(-0.1, 0, 1, 1), "graphic_api_misuse");
  throwsCode(() => Easing.bezier(0, 0, 1.5, 1), "graphic_api_misuse");
});

test("recorded choice: bezier outside 0..1 follows its end tangents", () => {
  const curve = Easing.bezier(0.5, 0.25, 0.5, 0.75);
  close(curve(-1), -0.5);
  close(curve(2), 1.5);
});

test("recorded choice: ease is the documented preset .42,0,1,1", () => {
  const preset = Easing.bezier(0.42, 0, 1, 1);
  for (const t of samples(10)) close(Easing.ease(t), preset(t));
});

test("recorded choice: elastic(bounciness) - 0 never overshoots, 1 overshoots once, N about N times", () => {
  const swings = (b: number) => {
    const f = Easing.elastic(b);
    let crossings = 0;
    let above = false;
    for (const t of samples(2000)) {
      const now = f(t) > 1 + 1e-9;
      if (now !== above && t < 1) crossings++;
      above = now;
    }
    return crossings;
  };
  for (const b of [0, 1, 3]) {
    const f = Easing.elastic(b);
    assert.ok(Math.abs(f(0)) < 1e-12);
    close(f(1), 1);
  }
  assert.ok(samples().every((t) => Easing.elastic(0)(t) <= 1 + 1e-12));
  assert.equal(swings(1), 2, "one excursion above the end (up and back down)");
  assert.ok(samples().some((t) => Easing.elastic()(t) > 1), "the default bounciness is 1");
  assert.ok(swings(3) >= 2);
  throwsCode(() => Easing.elastic(-1), "graphic_api_misuse");
});

test("recorded choice: back(s) dips below 0 before moving forward; default s = 1.5 dips about 8 %", () => {
  const f = Easing.back();
  const lowest = Math.min(...samples(1000).map(f));
  assert.ok(lowest < -0.07 && lowest > -0.09, String(lowest));
  close(f(1), 1);
  assert.equal(f(0), 0);
  assert.ok(Math.min(...samples().map(Easing.back(3))) < lowest, "a larger s dips further");
});

test("recorded choice: bounce is the 'in' form of a three-bounce ball drop", () => {
  const out = Easing.out(Easing.bounce);
  assert.equal(Easing.bounce(0), 0);
  close(Easing.bounce(1), 1);
  close(out(1 / 2.75), 1, 1e-9);
  close(out(1), 1);
  for (const t of samples()) {
    const v = Easing.bounce(t);
    assert.ok(v >= -1e-12 && v <= 1 + 1e-12);
  }
  close(out(1.5 / 2.75), 0.75, 1e-9);
});

test("Easing.spring: from 0 to 1 over the segment; without allowTail exactly 1 at the end", () => {
  const f = Easing.spring();
  assert.equal(f(0), 0);
  assert.equal(f(1), 1);
  assert.equal(f(1.5), 1);
  assert.ok(f(0.5) > 0);
  const heavy = Easing.spring({ damping: 200 });
  for (const t of samples(50)) assert.ok(heavy(t) <= 1 + 1e-12);
});

test("Easing.spring: durationRestThreshold sets how near the end it comes within the segment", () => {
  const near = Easing.spring({ damping: 200, durationRestThreshold: 0.001, allowTail: true });
  const far = Easing.spring({ damping: 200, durationRestThreshold: 0.1, allowTail: true });
  close(1 - near(1), 0.001, 1e-6);
  close(1 - far(1), 0.1, 1e-6);
  assert.ok(far(0.5) < near(0.5), "a larger threshold pushes more of the motion towards the end");
  throwsCode(() => Easing.spring({ durationRestThreshold: 0 }), "graphic_api_misuse");
  throwsCode(() => Easing.spring({ damping: 0 }), "graphic_api_misuse");
});

test("Easing.spring: allowTail keeps moving past the segment end; overshootClamping stops at 1", () => {
  const tail = Easing.spring({ allowTail: true });
  assert.notEqual(tail(1), 1);
  assert.ok(Math.abs(tail(3) - 1) < Math.abs(tail(1) - 1));
  const bouncy = Easing.spring({ damping: 5 });
  assert.ok(samples(400).some((t) => bouncy(t) > 1));
  const clamped = Easing.spring({ damping: 5, overshootClamping: true });
  assert.ok(samples(400).every((t) => clamped(t) <= 1));
});

test("recorded choice: polynomial and trigonometric easings are evaluated as written outside 0..1", () => {
  assert.equal(Easing.quad(2), 4);
  assert.equal(Easing.cubic(-1), -1);
  close(Easing.sin(2), 1 - Math.cos(Math.PI));
  close(Easing.back()(2), 8 - 1.5 * 4 * -1);
});
