// Parity round 1: every example row of the action cases, replayed against this runtime.
import assert from "node:assert/strict";
import test from "node:test";
import { evaluate, matches } from "./helpers/parity";
import { PARITY_R1 } from "./parity-r1.cases";

test("parity r1: every row of the cases fixed in round 1 matches the reference", () => {
  const failures: string[] = [];
  for (const row of PARITY_R1) {
    if (row.kept) continue;
    const actual = evaluate(row.expr, row.vars);
    if (!matches(row.expected, actual)) {
      failures.push(`${row.id} ${JSON.stringify(row.vars)}: expected ${JSON.stringify(row.expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("parity r1: kept cases still follow SPEC.md where it differs from the older reference", () => {
  const kept = PARITY_R1.filter((row) => row.kept);
  assert.ok(kept.length > 0);
  for (const row of kept) assert.equal(typeof row.kept, "string", row.id);
  // The kept differences are deliberate: each case here still differs in at least one row.
  const stillDifferent = new Set(kept.filter((row) => !matches(row.expected, evaluate(row.expr, row.vars))).map((row) => row.id));
  assert.deepEqual([...new Set(kept.map((row) => row.id))].filter((id) => !stillDifferent.has(id)), []);
});
