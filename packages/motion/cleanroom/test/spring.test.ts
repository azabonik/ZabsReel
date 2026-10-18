import assert from "node:assert/strict";
import test from "node:test";
import { measureSpring, spring } from "../runtime/src/index";
import { elapsedSeconds } from "../runtime/src/spring";
import { throwsCode } from "./helpers/host";

const fps = 30;

test("measureSpring: the documented example (fps 30, damping 200) returns 23", () => {
  assert.equal(measureSpring({ fps: 30, config: { damping: 200 } }), 23);
});

test("measureSpring: from that frame on the spring never strays further than the threshold", () => {
  for (const config of [{}, { damping: 200 }, { damping: 5, mass: 2 }, { stiffness: 300 }]) {
    for (const threshold of [0.01, 0.005]) {
      const n = measureSpring({ fps, config, threshold });
      for (let f = n; f < n + 300; f++) {
        assert.ok(Math.abs(spring({ frame: f, fps, config }) - 1) <= threshold, `${JSON.stringify(config)} frame ${f}`);
      }
      assert.ok(Math.abs(spring({ frame: n - 1, fps, config }) - 1) > threshold);
    }
  }
});

test("measureSpring: lower thresholds give longer durations; from and to do not change the result", () => {
  const loose = measureSpring({ fps, threshold: 0.05 });
  const tight = measureSpring({ fps, threshold: 0.0005 });
  assert.ok(tight > loose);
  assert.equal(measureSpring({ fps, from: 100, to: -40 }), measureSpring({ fps }));
  assert.ok(Number.isInteger(measureSpring({ fps })), "recorded choice: a whole number of frames");
});

test("recorded choice: damping at or above critical gives the same curve (the damping ratio is capped at 1)", () => {
  assert.equal(measureSpring({ fps, config: { damping: 20 } }), measureSpring({ fps, config: { damping: 200 } }));
  for (const frame of [3, 10, 17]) {
    assert.equal(spring({ frame, fps, config: { damping: 20 } }), spring({ frame, fps, config: { damping: 2000 } }));
  }
  assert.notEqual(measureSpring({ fps, config: { damping: 19 } }), measureSpring({ fps, config: { damping: 15 } }));
});

test("recorded choice: an undamped spring never settles (Infinity)", () => {
  assert.equal(measureSpring({ fps, config: { damping: 0 } }), Infinity);
});

test("spring starts at from and moves towards to; the default bounce goes slightly past to", () => {
  assert.equal(spring({ frame: 0, fps }), 0);
  const values = Array.from({ length: 90 }, (_, f) => spring({ frame: f, fps }));
  assert.ok(values[5] > 0 && values[5] < 1);
  assert.ok(Math.max(...values) > 1, "overshoots with the default config");
  assert.ok(Math.abs(values[89] - 1) < 0.005);
  const down = spring({ frame: 10, fps, from: 100, to: 50, config: { damping: 200 } });
  assert.ok(down < 100 && down > 50);
  assert.equal(spring({ frame: 0, fps, from: 100, to: 50 }), 100);
});

test("recorded choice: the value approaches to and is not snapped to it", () => {
  const late = spring({ frame: 60, fps, config: { damping: 200 } });
  assert.ok(late < 1);
  assert.ok(1 - late < 1e-6);
});

test("config: a smaller mass is quicker; higher damping removes the bounce", () => {
  const light = measureSpring({ fps, config: { mass: 0.5, damping: 200 } });
  const heavy = measureSpring({ fps, config: { mass: 3, damping: 200 } });
  assert.ok(light < heavy);
  const values = Array.from({ length: 120 }, (_, f) => spring({ frame: f, fps, config: { damping: 200 } }));
  assert.ok(values.every((v) => v <= 1));
});

test("parity r1 spring-015 (kept, decided from SPEC): overshootClamping replaces any value beyond to with to, both directions", () => {
  const values = Array.from({ length: 90 }, (_, f) => spring({ frame: f, fps, config: { overshootClamping: true } }));
  assert.ok(Math.max(...values) === 1);
  const down = Array.from({ length: 90 }, (_, f) =>
    spring({ frame: f, fps, from: 1, to: 0, config: { overshootClamping: true } }),
  );
  assert.ok(Math.min(...down) === 0);
});

test("durationInFrames stretches the curve; durationRestThreshold 0.001 covers 99.9 % by the end (documented)", () => {
  const end = spring({ frame: 30, fps, durationInFrames: 30, durationRestThreshold: 0.001, config: { damping: 200 } });
  assert.ok(Math.abs(end - 1) <= 0.001, String(end));
  const half = spring({ frame: 15, fps, durationInFrames: 30, config: { damping: 200 } });
  const longHalf = spring({ frame: 15, fps, durationInFrames: 60, config: { damping: 200 } });
  assert.ok(longHalf < half, "a longer duration is slower");
  // recorded choice: the default durationRestThreshold is 0.005
  const defaultEnd = spring({ frame: 30, fps, durationInFrames: 30, config: { damping: 200 } });
  assert.ok(Math.abs(1 - defaultEnd) <= 0.005);
  // durationRestThreshold is ignored without durationInFrames
  assert.equal(spring({ frame: 9, fps, durationRestThreshold: 0.2 }), spring({ frame: 9, fps }));
});

const near = (a: number, b: number) =>
  assert.ok(Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

test("parity r1 spring-022..026/041..043, recorded choice: a stretched spring scales its whole-frame settle length onto durationInFrames", () => {
  const d30 = (frame: number, extra: Partial<Parameters<typeof spring>[0]> = {}) =>
    spring({ frame, fps, durationInFrames: 30, ...extra });
  near(d30(1), 0.043399);
  near(d30(21), 0.981963);
  near(d30(29.5), 0.995114);
  near(d30(1, { durationRestThreshold: 0.001 }), 0.080445);
  near(d30(20, { durationRestThreshold: 0.001 }), 0.988398);
  near(d30(30, { durationRestThreshold: 0.001 }), 1.000448);
  near(d30(22, { config: { overshootClamping: true } }), 0.975967);
  near(spring({ frame: 1, fps: 60, durationInFrames: 30 }), 0.043399);
  near(spring({ frame: 21, fps: 60, durationInFrames: 30 }), 0.981963);
  near(spring({ frame: 1, fps, durationInFrames: 15, config: { damping: 200 } }), 0.093592);
  near(spring({ frame: 11, fps, durationInFrames: 15, config: { damping: 200 } }), 0.97605);
  near(spring({ frame: 1, fps, durationInFrames: 60, config: { damping: 5 } }), 0.055512);
  near(spring({ frame: 35, fps, durationInFrames: 60, config: { damping: 5 } }), 0.979115);
});

test("parity r1 spring-022..026/041, recorded choice: after its duration a stretched spring is exactly `to`", () => {
  assert.equal(spring({ frame: 40, fps, durationInFrames: 30 }), 1);
  assert.equal(spring({ frame: 39, fps, durationInFrames: 30, durationRestThreshold: 0.001 }), 1);
  assert.equal(spring({ frame: 20, fps, durationInFrames: 15, config: { damping: 200 } }), 1);
  assert.equal(spring({ frame: 70, fps, durationInFrames: 60, config: { damping: 5 } }), 1);
  assert.equal(spring({ frame: 31, fps, durationInFrames: 30, config: { overshootClamping: true } }), 1);
  assert.notEqual(spring({ frame: 30, fps, durationInFrames: 30 }), 1, "at the duration itself the curve still applies");
  assert.equal(spring({ frame: 40, fps, durationInFrames: 30, from: 5, to: -2 }), -2);
});

test("parity r1 spring-018/021: reverse and delay with a stretched spring", () => {
  const rev = (frame: number) => spring({ frame, fps, reverse: true, durationInFrames: 30 });
  near(rev(0), 0.996846);
  near(rev(15), 1.10414);
  near(rev(29), 0.043399);
  const delayed = (frame: number) => spring({ frame, fps, delay: 10, durationInFrames: 20, reverse: true });
  assert.equal(delayed(0), 1);
  near(delayed(15), 0.974359);
  near(delayed(29), 0.092121);
});

test("parity r1 spring-011/measure-025, recorded choice: a frame advances the spring by at most 64 ms", () => {
  near(spring({ frame: 1, fps: 1 }), 0.161909);
  near(spring({ frame: 6, fps: 1 }), 1.159616);
  near(spring({ frame: 10, fps: 1 }), 0.985795);
  assert.equal(measureSpring({ fps: 1, config: { damping: 200 } }), 12);
  assert.equal(spring({ frame: 2, fps: 10 }), spring({ frame: 2, fps: 1 / 0.064 }));
  assert.notEqual(spring({ frame: 2, fps: 20 }), spring({ frame: 2, fps: 10 }), "above 15.625 fps a frame is 1/fps");
});

test("parity r1 spring-032, recorded choice: an unstretched spring never becomes exactly `to`", () => {
  const late = spring({ frame: 1000, fps });
  assert.notEqual(late, 1);
  assert.ok(Math.abs(late - 1) < 1e-15);
  const down = spring({ frame: 1000, fps, from: 5, to: 2 });
  assert.ok(down !== 2 && down > 2 && down - 2 < 1e-14);
  assert.equal(spring({ frame: 1000, fps, from: 1, to: 1 }), 1, "no motion: from equals to");
  assert.equal(spring({ frame: 1000, fps, to: 0, from: -1 }) < 0, true);
});

test("parity r1 spring-053/054/058/059/061/064, recorded choice: unusual config and options give values instead of errors", () => {
  assert.ok(Number.isNaN(spring({ frame: 10, fps, config: { mass: 0 } })));
  assert.equal(spring({ frame: 10, fps, config: { stiffness: 0 } }), 0);
  assert.ok(Number.isNaN(spring({ frame: 10, fps, config: { mass: -1 } })));
  assert.equal(spring({ frame: 10, fps, durationInFrames: 30, durationRestThreshold: 1.5 }), 0);
  assert.equal(`${spring({ frame: 10, fps, durationInFrames: 30, durationRestThreshold: 1.5 })}`, "0");
  assert.equal(spring({ frame: 10, fps, delay: Number.NaN }), 0);
});

test("delay: with delay 25 the output stays at the start for frames 0-24 and moves from 25 on", () => {
  for (let f = 0; f <= 25; f++) assert.equal(spring({ frame: f, fps, delay: 25 }), 0);
  assert.ok(spring({ frame: 26, fps, delay: 25 }) > 0);
  assert.equal(spring({ frame: 35, fps, delay: 25 }), spring({ frame: 10, fps }));
});

test("recorded choice: negative frames hold the starting value", () => {
  assert.equal(spring({ frame: -20, fps, from: 3 }), 3);
});

test("recorded choice: reverse plays the curve backwards over measureSpring's length (or durationInFrames)", () => {
  const length = measureSpring({ fps, config: { damping: 200 } });
  const config = { damping: 200 };
  assert.ok(Math.abs(spring({ frame: 0, fps, reverse: true, config }) - 1) <= 0.005);
  assert.equal(spring({ frame: length, fps, reverse: true, config }), 0);
  assert.equal(spring({ frame: length + 50, fps, reverse: true, config }), 0);
  assert.equal(spring({ frame: 5, fps, reverse: true, config }), spring({ frame: length - 5, fps, config }));
  assert.equal(
    spring({ frame: 4, fps, reverse: true, durationInFrames: 20, config }),
    spring({ frame: 16, fps, durationInFrames: 20, config }),
  );
});

test("order of operations: stretch, then reverse, then delay", () => {
  const config = { damping: 200 };
  const combined = (frame: number) => spring({ frame, fps, config, durationInFrames: 20, reverse: true, delay: 10 });
  const stretchedReversed = (frame: number) => spring({ frame, fps, config, durationInFrames: 20, reverse: true });
  for (const f of [0, 5, 10, 15, 25, 30, 40]) assert.equal(combined(f), stretchedReversed(f - 10));
  assert.equal(combined(30), 0);
  assert.ok(combined(5) > 0.99, "recorded choice: during the delay a reversed spring holds its starting value");
});

test("recorded choice: at 30 fps fractional frames below the 64 ms cap follow the curve smoothly (step rule, round 2)", () => {
  const a = spring({ frame: 10, fps });
  const b = spring({ frame: 10.5, fps });
  const c = spring({ frame: 11, fps });
  assert.ok((a < b && b < c) || (a > b && b > c));
});

test("recorded choice: invalid input throws graphic_api_misuse", () => {
  const bad: Parameters<typeof spring>[0][] = [
    { frame: Number.NaN, fps },
    { frame: 0, fps: 0 },
    { frame: 0, fps: -30 },
    { frame: 0, fps, config: { mass: "1" as unknown as number } },
    { frame: 0, fps, durationInFrames: 0 },
    { frame: 0, fps, durationInFrames: 30, durationRestThreshold: 0 },
    { frame: 0, fps, durationInFrames: 30, config: { damping: 0 } },
    { frame: 0, fps, reverse: true, config: { damping: 0 } },
    { frame: 0, fps, from: Number.NaN },
  ];
  for (const options of bad) throwsCode(() => spring(options), "graphic_api_misuse");
  throwsCode(() => spring(undefined as unknown as Parameters<typeof spring>[0]), "graphic_api_misuse");
  throwsCode(() => measureSpring({ fps: 0 }), "graphic_api_misuse");
  throwsCode(() => measureSpring({ fps, threshold: 0 }), "graphic_api_misuse");
});

test("parity r2 spring-fps*, recorded choice: frames advance in whole steps of at most 64 ms; the first step spans 1 + the fraction", () => {
  const close6 = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);
  // 10 fps (a frame would be 100 ms): a frame below 1 is one partial step; from frame 1 on every step is 64 ms
  // and a fraction only lengthens the first step, which is capped already.
  close6(elapsedSeconds(0.25, 10), 0.025);
  close6(elapsedSeconds(1, 10), 0.064);
  close6(elapsedSeconds(1.5, 10), 0.064);
  close6(elapsedSeconds(2.5, 10), 0.128);
  close6(elapsedSeconds(12.5, 10), 0.768);
  // 16 fps (62.5 ms): the first step of 1.5 frames is 93.75 ms, capped to 64 ms.
  close6(elapsedSeconds(1.5, 16), 0.064);
  close6(elapsedSeconds(4.5, 16), 0.064 + 3 * 0.0625);
  // 30 fps: continuous until the first step would pass 64 ms (fraction above 0.92).
  close6(elapsedSeconds(29.5, 30), 29.5 / 30);
  close6(elapsedSeconds(2.95, 30), 0.064 + 1 / 30);
  // Whole frames are unchanged from round 1: n * min(1/fps, 0.064).
  close6(elapsedSeconds(7, 10), 7 * 0.064);
  close6(elapsedSeconds(7, 30), 7 / 30);
  // Floating-point noise around whole frames does not change the step count.
  close6(elapsedSeconds(3 - 1e-12, 10), 3 * 0.064);
});

test("parity r2 spring-fps*: fractional and stretched springs at low frame rates follow the step rule", () => {
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(b)), `${a} vs ${b}`);
  near(spring({ frame: 0.25, fps: 10 }), 0.028654);
  near(spring({ frame: 2.5, fps: 10 }), 0.492353);
  near(spring({ frame: 1.5, fps: 16, config: { damping: 200 } }), 0.13524);
  near(spring({ frame: 6, fps: 10, durationInFrames: 12 }), 1.120108);
  near(spring({ frame: 3, fps: 24, durationInFrames: 12 }), 0.964794);
  near(spring({ frame: 5, fps: 10, reverse: true, durationInFrames: 10 }), 1.120108);
  near(spring({ frame: 5, fps: 15, durationInFrames: 20, durationRestThreshold: 0.02, config: { damping: 200 } }), 0.366075);
});

test("parity r2 spring-fps*-clamp-fromto (kept, SPEC 6): overshootClamping clamps an increasing spring at `to` too", () => {
  for (const fps of [10, 15, 16, 24]) {
    const values = Array.from({ length: 30 }, (_, frame) =>
      spring({ frame, fps, from: 20, to: 220, config: { damping: 8, overshootClamping: true } }),
    );
    assert.equal(Math.max(...values), 220);
    assert.ok(values.some((v) => v === 220));
  }
});
