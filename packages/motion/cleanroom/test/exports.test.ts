import "./helpers/dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as index from "../runtime/src/index";
import { EXPORT_NAMES } from "../runtime/src/exportNames";
import * as host from "../runtime/src/host";

const exportsJson = JSON.parse(readFileSync(join(__dirname, "..", "runtime", "exports.json"), "utf8")) as {
  exports: string[];
};

test("gate: index.ts exports exactly the names in exports.json", () => {
  assert.deepEqual(Object.keys(index).sort(), [...exportsJson.exports].sort());
});

test("exports.json is sorted with JavaScript's default sort and has no duplicates", () => {
  assert.deepEqual(exportsJson.exports, [...exportsJson.exports].sort());
  assert.equal(new Set(exportsJson.exports).size, exportsJson.exports.length);
});

test("exports.json lists exactly BRIEF section 1.1's names", () => {
  const brief = [
    "AbsoluteFill", "Audio", "Easing", "Freeze", "Html5Audio", "Html5Video", "Img", "Loop",
    "OffthreadVideo", "Sequence", "Series", "Video", "asset", "cancelRender", "continueRender",
    "delayRender", "interpolate", "interpolateColors", "loadFont", "measureSpring", "random", "spring",
    "staticFile", "useCurrentFrame", "useDelayRender", "useVideoConfig",
  ];
  assert.deepEqual(exportsJson.exports, brief);
  assert.deepEqual([...EXPORT_NAMES], brief);
});

test("Video and Audio are the same component objects as Html5Video and Html5Audio", () => {
  assert.equal(index.Video, index.Html5Video);
  assert.equal(index.Audio, index.Html5Audio);
});

test("host entry points are not part of the public exports", () => {
  assert.equal(typeof host.createMotionApp, "function");
  assert.equal(typeof host.createModuleObject, "function");
  assert.ok(!("createMotionApp" in index));
  assert.ok(!("createModuleObject" in index));
  for (const name of ["Composition", "Still", "calculateMetadata", "registerRoot"]) {
    assert.ok(!(name in index), name);
  }
});

test("index.ts's delayRender, continueRender, cancelRender and loadFont throw graphic_api_unsupported", () => {
  for (const call of [
    () => index.delayRender("x"),
    () => index.continueRender(1),
    () => index.cancelRender("x"),
    () => index.loadFont("font"),
  ]) {
    let caught: unknown;
    try {
      call();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error);
    assert.equal((caught as { code?: string }).code, "graphic_api_unsupported");
  }
});

test("the runtime imports only react, react-dom and its own files, and from react-dom only createRoot and flushSync", () => {
  const dir = join(__dirname, "..", "runtime", "src");
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const files = readdirSync(dir).filter((f: string) => /\.tsx?$/.test(f));
  assert.ok(files.length > 0);
  for (const file of files) {
    // Whole-line and block comments are left out of the scan.
    const source = readFileSync(join(dir, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const specs = [
      ...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm),
      ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
      ...source.matchAll(/\brequire\(\s*["']([^"']+)["']/g),
    ];
    for (const match of specs) {
      const spec = match[1];
      assert.ok(spec === "react" || spec === "react-dom" || spec.startsWith("./"), `${file} imports ${spec}`);
    }
    for (const match of source.matchAll(/ReactDOM\.(\w+)|import \{([^}]*)\} from "react-dom"/g)) {
      const names = (match[1] ?? match[2]).split(",").map((s) => s.trim()).filter(Boolean);
      for (const name of names) assert.ok(["createRoot", "flushSync"].includes(name), `${file} uses react-dom's ${name}`);
    }
    assert.ok(!/\bimport\(/.test(source), `${file} uses dynamic import()`);
  }
});
