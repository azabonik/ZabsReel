import assert from "node:assert/strict";
import test from "node:test";
import { measureSpring, spring } from "../runtime/src/index";
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

test("overshootClamping replaces any value beyond to with to", () => {
  const values = Array.from({ length: 90 }, (_, f) => spring({ frame: f, fps, config: { overshootClamping: true } }));
  assert.ok(Math.max(...values) === 1);
  const down = Array.from({ length: 90 }, (_, f) =>
    spring({ frame: f, fps, from: 1, to: 0, config: { overshootClamping: true } }),
  );
  assert.ok(Math.min(...down) === 0);
});

test("durationInFrames stretches the curve; durationRestThreshold 0.001 covers 99.9 % by the end (documented)", () => {
  const end = spring({ frame: 30, fps, durationInFrames: 30, durationRestThreshold: 0.001, config: { damping: 200 } });
  assert.ok(end >= 0.999 - 1e-9 && end < 1, String(end));
  const half = spring({ frame: 15, fps, durationInFrames: 30, config: { damping: 200 } });
  const longHalf = spring({ frame: 15, fps, durationInFrames: 60, config: { damping: 200 } });
  assert.ok(longHalf < half, "a longer duration is slower");
  // recorded choice: the default durationRestThreshold is 0.005
  const defaultEnd = spring({ frame: 30, fps, durationInFrames: 30, config: { damping: 200 } });
  assert.ok(Math.abs(1 - defaultEnd - 0.005) < 1e-6);
  // durationRestThreshold is ignored without durationInFrames
  assert.equal(spring({ frame: 9, fps, durationRestThreshold: 0.2 }), spring({ frame: 9, fps }));
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

test("recorded choice: fractional frames are evaluated on the continuous curve", () => {
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
    { frame: 0, fps, config: { mass: 0 } },
    { frame: 0, fps, config: { stiffness: -1 } },
    { frame: 0, fps, config: { damping: -1 } },
    { frame: 0, fps, durationInFrames: 0 },
    { frame: 0, fps, durationInFrames: 30, durationRestThreshold: 1 },
    { frame: 0, fps, durationInFrames: 30, config: { damping: 0 } },
    { frame: 0, fps, reverse: true, config: { damping: 0 } },
    { frame: 0, fps, from: Number.NaN },
  ];
  for (const options of bad) throwsCode(() => spring(options), "graphic_api_misuse");
  throwsCode(() => spring(undefined as unknown as Parameters<typeof spring>[0]), "graphic_api_misuse");
  throwsCode(() => measureSpring({ fps: 0 }), "graphic_api_misuse");
  throwsCode(() => measureSpring({ fps, threshold: 0 }), "graphic_api_misuse");
});
