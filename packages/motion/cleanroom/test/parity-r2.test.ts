// Parity round 2: every example row of the spring cases, replayed against this runtime.
import assert from "node:assert/strict";
import test from "node:test";
import { evaluate, matches } from "./helpers/parity";
import { PARITY_R2 } from "./parity-r2.cases";

test("parity r2: every row of the spring cases fixed in round 2 matches the reference", () => {
  const failures: string[] = [];
  for (const row of PARITY_R2) {
    if (row.kept) continue;
    const actual = evaluate(row.expr, row.vars);
    if (!matches(row.expected, actual)) {
      failures.push(`${row.id} ${JSON.stringify(row.vars)}: expected ${JSON.stringify(row.expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("parity r2: the overshootClamping rows stay clamped at `to` (kept, SPEC 6)", () => {
  const kept = PARITY_R2.filter((row) => row.kept);
  assert.equal(kept.length, 12);
  for (const row of kept) {
    assert.equal(evaluate(row.expr, row.vars), 220, `${row.id} ${JSON.stringify(row.vars)}`);
    assert.ok((row.expected as number) > 220, "the reference's value is past `to`");
  }
});
