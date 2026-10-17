import assert from "node:assert/strict";
import test from "node:test";
import { Easing, interpolate, spring } from "../runtime/src/index";
import { throwsCode } from "./helpers/host";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
/** The parity rounds' tolerance: |d| <= 1e-4 * max(1, |expected|). */
const near = (a: number, b: number) => close(a, b, 1e-4 * Math.max(1, Math.abs(b)));
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
  throwsCode(() => Easing.poly("2" as unknown as number), "graphic_api_misuse");
});

test("parity r1 ease-063, recorded choice: poly accepts any number of power, 0 included", () => {
  assert.equal(Easing.poly(0)(0), 1);
  assert.equal(Easing.poly(0)(0.4), 1);
  assert.equal(Easing.poly(-1)(0.5), 2);
});

test("step0 gives 1 whenever n > 0, step1 whenever n >= 1; recorded choice: 0 otherwise", () => {
  assert.deepEqual([-1, 0, 0.001, 1].map(Easing.step0), [0, 0, 1, 1]);
  assert.deepEqual([0, 0.999, 1, 2].map(Easing.step1), [0, 0, 1, 1]);
});

test("recorded choice: sin and circle formulas", () => {
  close(Easing.sin(0.5), 1 - Math.cos(Math.PI / 4));
  close(Easing.circle(0.5), 1 - Math.sqrt(0.75));
  assert.equal(Easing.circle(2), 1);
  for (const f of [Easing.sin, Easing.circle]) {
    close(f(1), 1);
    assert.ok(Math.abs(f(0)) < 1e-12);
  }
});

test("parity r1 ease-010/039/040, recorded choice: exp(t) = 2^(10 (t - 1)) for every t, so exp(0) is 2^-10", () => {
  near(Easing.exp(0), 0.000977);
  near(Easing.exp(-0.3), 0.000122);
  near(Easing.exp(-0.15), 0.000345);
  close(Easing.exp(1), 1);
  close(Easing.exp(0.5), 2 ** -5);
  near(Easing.out(Easing.exp)(1), 0.999023);
  near(Easing.out(Easing.exp)(1.15), 0.999655);
  near(Easing.inOut(Easing.exp)(-0.1), 0.000122);
  near(Easing.inOut(Easing.exp)(1), 0.999512);
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

test("parity r1 ease-002/019/021/022/052, recorded choice: bezier curves hold 0 before 0 and 1 after 1", () => {
  for (const curve of [
    Easing.ease,
    Easing.bezier(0.25, 0.1, 0.25, 1),
    Easing.bezier(0, 0, 1, 1),
    Easing.bezier(0.68, -0.6, 0.32, 1.6),
    Easing.inOut(Easing.bezier(0.25, 0.1, 0.25, 1)),
  ]) {
    for (const t of [-0.5, -0.25, -0.05]) assert.equal(curve(t), 0);
    for (const t of [1.05, 1.3, 1.5]) assert.equal(curve(t), 1);
  }
});

test("recorded choice: ease is the documented preset .42,0,1,1", () => {
  const preset = Easing.bezier(0.42, 0, 1, 1);
  for (const t of samples(10)) close(Easing.ease(t), preset(t));
});

test("parity r1 ease-011..014/043/044/055/056, recorded choice: elastic(b)(t) = 1 - cos(pi t / 2)^3 cos(b pi t)", () => {
  near(Easing.elastic()(-0.5), 1);
  near(Easing.elastic()(0.5), 1);
  near(Easing.elastic(1)(1.45), 0.957149);
  near(Easing.elastic(0)(-0.5), 0.646447);
  near(Easing.elastic(0)(0.5), 0.646447);
  near(Easing.elastic(0)(1.5), 1.353553);
  near(Easing.elastic(3)(1.45), 1.12436);
  near(Easing.out(Easing.elastic(1))(-0.45), 0.042851);
  near(Easing.out(Easing.elastic(1))(0.55), 0.068781);
  near(Easing.inOut(Easing.elastic(2))(0.55), 0.501549);
  near(Easing.inOut(Easing.elastic(2))(-0.5), 0.5);
  assert.equal(Easing.elastic(-1)(0.5), 1, "negative bounciness is accepted");
  assert.equal(`${Easing.elastic(-1)(0.5)}`, "1");
  for (const b of [0, 1, 3]) {
    assert.equal(Easing.elastic(b)(0), 0);
    close(Easing.elastic(b)(1), 1);
  }
  assert.ok(samples().every((t) => Easing.elastic(0)(t) <= 1 + 1e-12), "0 never overshoots inside 0..1");
  assert.ok(samples().some((t) => Easing.elastic(1)(t) > 1), "1 overshoots");
});

test("parity r1 ease-015/046, recorded choice: back(s) = t^3 - s t^2 (1 - t) with the default s = 1.70158", () => {
  const f = Easing.back();
  near(f(-0.5), -0.763092);
  near(f(0.5), -0.087698);
  near(f(1.5), 5.289278);
  near(Easing.inOut(Easing.back())(-0.5), -2.20158);
  near(Easing.inOut(Easing.back())(0.55), 0.704414);
  near(Easing.inOut(Easing.back())(1.5), 3.20158);
  close(f(1), 1);
  assert.equal(f(0), 0);
  assert.ok(Math.min(...samples().map(Easing.back(3))) < Math.min(...samples().map(f)), "a larger s dips further");
});

test("parity r1 ease-018/037/038/054, recorded choice: bounce is a ball drop with three bounces (t clamped to 0..1)", () => {
  near(Easing.bounce(0.05), 0.018906);
  near(Easing.bounce(0.5), 0.765625);
  near(Easing.bounce(0.95), 0.984531);
  near(Easing.in(Easing.bounce)(0.5), 0.765625);
  near(Easing.out(Easing.bounce)(0.05), 0.015469);
  near(Easing.out(Easing.bounce)(0.5), 0.234375);
  near(Easing.inOut(Easing.bounce)(0.05), 0.037813);
  near(Easing.inOut(Easing.bounce)(0.55), 0.505938);
  close(Easing.bounce(1 / 2.75), 1, 1e-9);
  assert.equal(Easing.bounce(-1), 0);
  assert.equal(Easing.bounce(2), 1);
  for (const t of samples()) {
    const v = Easing.bounce(t);
    assert.ok(v >= -1e-12 && v <= 1 + 1e-12);
  }
});

test("parity r1 ease-070/071/074/075/078: Easing.spring is spring({durationInFrames: 30}) over a 30-frame span", () => {
  const f = Easing.spring();
  near(f(0.05), 0.092121);
  near(f(0.5), 1.10414);
  near(f(0.95), 0.991179);
  near(f(1 / 30), 0.043399);
  near(Easing.spring({})(0.5), 1.10414);
  near(Easing.spring({ damping: 200 })(0.05), 0.05714);
  near(Easing.spring({ damping: 200 })(0.5), 0.895419);
  near(Easing.spring({ damping: 200 })(0.95), 0.99431);
  near(Easing.spring({ overshootClamping: true })(0.7), 0.981963);
  // Same damping ratio as the default, so the same stretched curve.
  near(Easing.spring({ mass: 2, stiffness: 50 })(0.5), 1.10414);
  for (const p of [0.1, 0.4, 0.8]) near(f(p), spring({ frame: 30 * p, fps: 30, durationInFrames: 30 }));
});

test("Easing.spring: from 0 to 1 over the segment; without allowTail exactly 1 from progress 1 on", () => {
  const f = Easing.spring();
  assert.equal(f(0), 0);
  assert.equal(f(-0.5), 0);
  assert.equal(f(1), 1);
  assert.equal(f(1.5), 1);
  const heavy = Easing.spring({ damping: 200 });
  for (const t of samples(50)) assert.ok(heavy(t) <= 1 + 1e-12);
});

test("parity r1 ease-076/077: Easing.spring's durationRestThreshold is kept (SPEC v4.0.483); it decides the stretch", () => {
  const nearEnd = Easing.spring({ damping: 200, durationRestThreshold: 0.001, allowTail: true });
  const farEnd = Easing.spring({ damping: 200, durationRestThreshold: 0.1, allowTail: true });
  assert.ok(Math.abs(1 - nearEnd(1)) <= 0.001);
  assert.ok(Math.abs(1 - farEnd(1)) <= 0.1);
  assert.ok(Math.abs(1 - farEnd(1)) > Math.abs(1 - nearEnd(1)));
  assert.ok(farEnd(0.5) < nearEnd(0.5), "a larger threshold pushes more of the motion towards the end");
  assert.notEqual(Easing.spring({ durationRestThreshold: 0.001 })(0.05), Easing.spring()(0.05));
  throwsCode(() => Easing.spring({ durationRestThreshold: 0 }), "graphic_api_misuse");
  throwsCode(() => Easing.spring({ damping: 0 }), "graphic_api_misuse");
});

test("parity r1 ease-072/080/086: allowTail is kept (SPEC v4.0.483): the spring keeps moving past progress 1", () => {
  const tail = Easing.spring({ allowTail: true });
  near(tail(0.05), 0.092121);
  assert.notEqual(tail(1), 1);
  assert.ok(Math.abs(tail(3) - 1) < Math.abs(tail(1) - 1));
  const bouncy = Easing.spring({ damping: 5 });
  assert.ok(samples(400).some((t) => bouncy(t) > 1));
  const clamped = Easing.spring({ damping: 5, overshootClamping: true });
  assert.ok(samples(400).every((t) => clamped(t) <= 1));
});

test("parity r1 ease-083/084/085: spring segments in interpolate", () => {
  const twice = (easing: (t: number) => number) => (f: number) => interpolate(f, [0, 30, 60], [0, 100, 50], { easing: [easing, easing] });
  const plain = twice(Easing.spring());
  near(plain(1), 4.339935);
  near(plain(31), 97.830033);
  near(plain(59), 50.339131);
  near(twice(Easing.spring({ allowTail: true }))(1), 4.339935);
  const one = (f: number) => interpolate(f, [0, 30], [0, 1], { easing: Easing.spring() });
  near(one(1), 0.043399);
  near(one(15), 1.10414);
  near(one(29), 0.993217);
  assert.equal(one(45), 1);
});

test("recorded choice: polynomial and trigonometric easings are evaluated as written outside 0..1", () => {
  assert.equal(Easing.quad(2), 4);
  assert.equal(Easing.cubic(-1), -1);
  close(Easing.sin(2), 1 - Math.cos(Math.PI));
  close(Easing.back()(2), 8 + 1.70158 * 4);
});
