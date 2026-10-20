import "./helpers/dom";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { transform } from "sucrase";
import * as index from "../runtime/src/index";
import { EXPORT_NAMES } from "../runtime/src/exportNames";
import { createModuleObject, createMotionApp } from "../runtime/src/host";
import type { MotionHost } from "../runtime/src/host";
import { makeHost, rejectsWithCode, throwsCode, ticks, track } from "./helpers/host";

// BRIEF v5, section 5 (the renderer setting now lives in Help → Graphics add-on…).
const fixedMessage = (name: string) =>
  `${name} is not available in ZedMix's built-in graphics renderer. Use the names listed in the graphics guide, or choose the Remotion add-on as the graphics renderer in Help → Graphics add-on….`;

const HOST_BOUND = new Set(["delayRender", "continueRender", "cancelRender", "loadFont", "random"]);

/** Compiles graphic source the way ZedMix does and evaluates it against a module object. */
function evaluateGraphic(source: string, host: MotionHost): { exports: Record<string, unknown>; mod: object } {
  const { code } = transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "classic" });
  const mod = createModuleObject(host);
  const exports: Record<string, unknown> = {};
  const requireFn = (name: string) => {
    if (name === "react") return React;
    if (name === "remotion" || name === "@aive/motion") return mod;
    throw new Error(`unexpected require(${name})`);
  };
  new Function("require", "exports", "module", code)(requireFn, exports, { exports });
  return { exports, mod };
}

test("the module object exposes exactly the export list", () => {
  const mod = createModuleObject(makeHost());
  assert.deepEqual(Object.keys(mod), [...EXPORT_NAMES]);
  assert.deepEqual(Reflect.ownKeys(mod), [...EXPORT_NAMES]);
  for (const name of EXPORT_NAMES) assert.ok(name in mod, name);
  assert.ok("__esModule" in mod);
  assert.ok(!("Composition" in mod));
});

test("the module object returns the same components and pure functions as index.ts", () => {
  const mod = createModuleObject(makeHost()) as Record<string, unknown>;
  for (const name of EXPORT_NAMES) {
    if (HOST_BOUND.has(name)) {
      assert.notEqual(mod[name], (index as Record<string, unknown>)[name], name);
      assert.equal(typeof mod[name], "function");
    } else {
      assert.equal(mod[name], (index as Record<string, unknown>)[name], name);
    }
  }
});

test("reading an unknown name throws graphic_api_unsupported with the fixed message", () => {
  const mod = createModuleObject(makeHost()) as Record<string, unknown>;
  for (const name of ["Composition", "Still", "staticFiles", "toString", "constructor"]) {
    const error = throwsCode(() => mod[name], "graphic_api_unsupported");
    assert.equal(error.message, fixedMessage(name));
    assert.ok(!error.message.includes("\n"));
  }
});

test("__esModule is true, default throws, symbols and then are undefined", async () => {
  const mod = createModuleObject(makeHost()) as Record<string | symbol, unknown>;
  assert.equal(mod.__esModule, true);
  const error = throwsCode(() => mod.default, "graphic_api_unsupported");
  assert.equal(error.message, fixedMessage("default"));
  assert.equal(mod.then, undefined);
  assert.equal(mod[Symbol.iterator], undefined);
  assert.equal(mod[Symbol.toStringTag], undefined);
  // A promise check (await / Promise.resolve) treats it as a plain value.
  assert.equal(await Promise.resolve(mod), mod);
});

test("the module object cannot be changed", () => {
  const mod = createModuleObject(makeHost()) as Record<string, unknown>;
  throwsCode(() => {
    mod.Sequence = null;
  }, "graphic_api_misuse");
  throwsCode(() => {
    mod.extra = 1;
  }, "graphic_api_misuse");
  throwsCode(() => delete mod.Sequence, "graphic_api_misuse");
  throwsCode(() => Object.defineProperty(mod, "x", { value: 1 }), "graphic_api_misuse");
  throwsCode(() => Object.setPrototypeOf(mod, {}), "graphic_api_misuse");
  throwsCode(() => Object.freeze(mod), "graphic_api_misuse");
  assert.equal(typeof mod.Sequence, "object");
});

test("sucrase output of `import { a, b } from \"remotion\"` works against the module object", async () => {
  const host = makeHost();
  const { exports } = evaluateGraphic(
    `
    import React from "react";
    import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
    export default function Graphic(props: { label: string }) {
      const frame = useCurrentFrame();
      return <AbsoluteFill>{props.label}:{interpolate(frame, [0, 10], [0, 1])}</AbsoluteFill>;
    }
    `,
    { ...host, composition: { ...host.composition, props: { label: "x" } } },
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createMotionApp(
    { ...host, composition: { ...host.composition, props: { label: "x" } } },
    exports.default as React.ComponentType<Record<string, unknown>>,
    container,
  );
  await app.renderFrame(5);
  assert.equal(container.textContent, "x:0.5");
  app.unmount();
});

test("an unknown name fails when it is first used, not when it is imported", async () => {
  const host = makeHost();
  const { exports } = evaluateGraphic(
    `
    import React from "react";
    import { useCurrentFrame, Composition } from "remotion";
    export default function Graphic() {
      const frame = useCurrentFrame();
      if (frame > 3) return <Composition />;
      return <span>{frame}</span>;
    }
    `,
    host,
  );
  const container = document.createElement("div");
  const app = createMotionApp(host, exports.default as React.ComponentType<Record<string, unknown>>, container);
  await app.renderFrame(2);
  assert.equal(container.textContent, "2");
  const error = await rejectsWithCode(app.renderFrame(4), "graphic_api_unsupported");
  assert.equal(error.message, fixedMessage("Composition"));
  app.unmount();
});

test("default and namespace imports work through the interop helpers; using .default throws", () => {
  const host = makeHost();
  const { exports } = evaluateGraphic(
    `
    import * as R from "@aive/motion";
    import Def from "remotion";
    export const seq = R.Sequence;
    export function useDefault() { return Def.Sequence; }
    `,
    host,
  );
  assert.equal(exports.seq, index.Sequence);
  const error = throwsCode(() => (exports.useDefault as () => unknown)(), "graphic_api_unsupported");
  assert.equal(error.message, fixedMessage("default"));
});

test("delayRender at the top level of the graphic's module holds the app's first frame", async () => {
  const host = makeHost();
  const { exports } = evaluateGraphic(
    `
    import React from "react";
    import { delayRender, continueRender } from "remotion";
    const handle = delayRender("module data");
    export const release = () => continueRender(handle);
    export default function Graphic() { return null; }
    `,
    host,
  );
  const container = document.createElement("div");
  const app = createMotionApp(host, exports.default as React.ComponentType<Record<string, unknown>>, container);
  const t = track(app.renderFrame(0));
  await ticks(5);
  assert.equal(t.settled(), false);
  (exports.release as () => void)();
  await t.promise;
  app.unmount();
});

test("the module object's random(null) logs once per host; seeded calls and index.ts's random log nothing", () => {
  const host = makeHost();
  const mod = createModuleObject(host) as Record<string, any>;
  mod.random(1);
  mod.random("seed");
  assert.equal(host.logs.length, 0);
  const a = mod.random(null);
  const b = mod.random(null);
  assert.ok(a >= 0 && a < 1 && b >= 0 && b < 1);
  assert.equal(host.logs.length, 1);
  assert.match(host.logs[0], /random\(null\)/);
  // A second module object for the same host does not warn again.
  (createModuleObject(host) as Record<string, any>).random(null);
  assert.equal(host.logs.length, 1);
  const other = makeHost();
  (createModuleObject(other) as Record<string, any>).random(null);
  assert.equal(other.logs.length, 1);
  index.random(null);
  assert.equal(host.logs.length, 1);
});

test("the module object's random gives the same values as index.ts's for seeds", () => {
  const mod = createModuleObject(makeHost()) as Record<string, any>;
  for (const seed of [0, 1, 42, "a", "label-3"]) assert.equal(mod.random(seed), index.random(seed));
});

test("recorded choice: a module object created after the app exists starts a new session", async () => {
  const host = makeHost({ frameTimeoutMs: 80 });
  createModuleObject(host);
  const container = document.createElement("div");
  const app = createMotionApp(host, () => null, container);
  const later = createModuleObject(host) as Record<string, any>;
  later.delayRender("belongs to the next app");
  assert.deepEqual(await app.renderFrame(0), { cues: [] });
  app.unmount();
});
