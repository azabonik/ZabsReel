import assert from "node:assert/strict";
import test from "node:test";
import { graphicError, misuse, toError, unsupportedNameMessage } from "../runtime/src/errors";

test("graphicError makes an Error with a string code and an optional cause", () => {
  const cause = new Error("inner");
  const e = graphicError("graphic_media_failed", "outer", cause);
  assert.ok(e instanceof Error);
  assert.equal(e.code, "graphic_media_failed");
  assert.equal(e.message, "outer");
  assert.equal(e.cause, cause);
  assert.equal(misuse("x").code, "graphic_api_misuse");
});

test("toError passes Errors through and wraps other thrown values without a code", () => {
  const e = new TypeError("t");
  assert.equal(toError(e), e);
  const wrapped = toError({ reason: 1 });
  assert.ok(wrapped instanceof Error);
  assert.deepEqual(wrapped.cause, { reason: 1 });
  assert.equal((wrapped as { code?: unknown }).code, undefined);
});

test("the fixed module-object message is BRIEF section 5's text, on one line", () => {
  assert.equal(
    unsupportedNameMessage("Composition"),
    "Composition is not available in ZabsReel's built-in graphics renderer. Use the names listed in the graphics guide, or switch Settings → Graphics renderer to the Remotion add-on.",
  );
});
