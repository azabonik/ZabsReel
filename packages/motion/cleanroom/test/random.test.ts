import assert from "node:assert/strict";
import test from "node:test";
import { random } from "../runtime/src/index";
import { throwsCode } from "./helpers/host";

test("a seed always gives the same number, between 0 and 1", () => {
  for (const seed of [1, 0, -5, 3.25, 1e12, "a", "", "x-3"]) {
    const v = random(seed);
    assert.equal(random(seed), v);
    assert.ok(v >= 0 && v < 1, `${String(seed)} -> ${v}`);
  }
});

test("string seeds built from a label and an index give different values for x and y", () => {
  const xs = Array.from({ length: 50 }, (_, i) => random(`x-${i}`));
  const ys = Array.from({ length: 50 }, (_, i) => random(`y-${i}`));
  assert.equal(new Set([...xs, ...ys]).size, 100);
});

test("random(null) is different on every call", () => {
  assert.notEqual(random(null), random(null));
});

test("calling random() without a usable seed throws graphic_api_misuse", () => {
  throwsCode(() => (random as unknown as () => number)(), "graphic_api_misuse");
  for (const bad of [undefined, true, {}, []]) {
    throwsCode(() => random(bad as unknown as number), "graphic_api_misuse");
  }
});

test("parity r1 random-035/036/039, recorded choice: NaN and infinite seeds are accepted and give 0", () => {
  assert.equal(random(Number.NaN), 0);
  assert.equal(random(Infinity), 0);
  assert.equal(random(-Infinity), 0);
});

test("recorded choice: number and string seeds differ; -0 and 0 are the same seed", () => {
  assert.notEqual(random(1), random("1"));
  assert.equal(random(-0), random(0));
});

test("recorded choice: values spread evenly over [0, 1) with no repeats across 10000 seeds", () => {
  const values = Array.from({ length: 10000 }, (_, i) => random(i));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  assert.ok(Math.abs(mean - 0.5) < 0.02, String(mean));
  const buckets = new Array(10).fill(0);
  for (const v of values) buckets[Math.floor(v * 10)]++;
  for (const count of buckets) assert.ok(count > 850 && count < 1150, String(buckets));
  assert.equal(new Set(values).size, values.length);
  const neighbours = values.slice(1).map((v, i) => Math.abs(v - values[i]));
  assert.ok(neighbours.reduce((a, b) => a + b, 0) / neighbours.length > 0.25, "consecutive seeds are not correlated");
});
