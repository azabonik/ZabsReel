// I/O import gate (G8-lint of the network-host plan): every core file-system
// call goes through packages/core/src/io/gatedfs.ts and every child process
// through packages/core/src/ffmpeg/executor.ts, which check each path against
// the network-path gate. This fails when the core escapes them:
//
//  - a packages/core/src file other than those two (and trusthosts.ts, the
//    approval store) imports fs, fs/promises, child_process or execa, in any
//    form: `import … from`, `export … from`, `import "…"`, `import(…)`,
//    `require(…)` or any other one-argument call (a createRequire). A
//    type-only `import type … from` is allowed;
//  - gatedfs.ts imports anything but fs, executor.ts anything but
//    execa / child_process;
//  - a file other than datadir.ts imports or re-exports gatedfs's `bootstrap`
//    (it allows a path on any server until the engine sets the allowed
//    servers), or takes gatedfs as a whole, which would hide it: a namespace
//    import, `export * from`, `export * as … from`, or a dynamic import(…) /
//    require(…) of it;
//  - motion/render.ts no longer passes GateNetworkFsPlugin (G9) to bundle(),
//    or mentions disableWebSecurity (Chromium would then load file:// from the
//    graphic) or rspack (it resolves in native code, outside G9's wrapper).
//
// It only reads. Usage: node scripts/check-io-imports.mjs [--root <dir>]
//                       node scripts/check-io-imports.mjs --self-test
// Exits 0 when clean, 1 otherwise.
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..");
const SRC = join("packages", "core", "src");

const FS = ["fs", "fs/promises"];
const PROC = ["child_process", "execa"];
/** The gated modules: what each may import itself (paths relative to packages/core/src). */
const OWNERS = { "io/gatedfs.ts": FS, "ffmpeg/executor.ts": PROC, "trusthosts.ts": FS };

const MODULE = String.raw`(?:node:)?(?:fs\/promises|fs|child_process)|execa`;
/** `import … from "m"` / `export … from "m"` (not `import type`); the clause may span lines. */
const FROM = new RegExp(String.raw`\b(import|export)\s+(?!type\b)([^;'"\`]*?)\bfrom\s*(['"])(${MODULE})\3`, "g");
/** `import "m"` (side effect only). */
const BARE = new RegExp(String.raw`\bimport\s*(['"])(${MODULE})\1`, "g");
/** Any call with the module as its only argument: import("m"), require("m"), req("m"). */
const CALL = new RegExp(String.raw`\(\s*(['"\`])(${MODULE})\1\s*\)`, "g");
/** The io/gatedfs module as a specifier: `./io/gatedfs.js`, `../io/gatedfs`, …. */
const GATEDFS_SPEC = String.raw`[./]*(?:[\w-]+\/)*io\/gatedfs(?:\.js)?`;
/** An `import … from` / `export … from` of io/gatedfs.js: the keyword and its clause. */
const GATEDFS = new RegExp(String.raw`\b(import|export)\s+(?!type\b)([^;'"\`]*?)\bfrom\s*(['"])${GATEDFS_SPEC}\3`, "g");
/** io/gatedfs.js as the only argument of a call: import("…"), require("…"). */
const GATEDFS_CALL = new RegExp(String.raw`\(\s*(['"\`])${GATEDFS_SPEC}\1\s*\)`, "g");

const bareName = (m) => m.replace(/^node:/, "");
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

function listTs(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listTs(p));
    else if (/\.(?:ts|tsx|mts|cts)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The problems in the core sources under `root`, as "file:line: what" strings. */
export function scan(root) {
  const problems = [];
  const src = join(root, SRC);
  const files = listTs(src);
  if (files.length === 0) problems.push(`${SRC}: no TypeScript files found`);
  for (const path of files) {
    const rel = relative(src, path).split(sep).join("/");
    const shown = `${SRC.split(sep).join("/")}/${rel}`;
    const text = readFileSync(path, "utf8");
    const allowed = OWNERS[rel] ?? [];
    const found = (m, index) => {
      if (!allowed.includes(bareName(m))) {
        problems.push(`${shown}:${lineOf(text, index)}: imports "${m}"; use io/gatedfs.ts (fs) or the ffmpeg/executor.ts helpers (child processes)`);
      }
    };
    for (const m of text.matchAll(FROM)) found(m[4], m.index);
    for (const m of text.matchAll(BARE)) found(m[2], m.index);
    for (const m of text.matchAll(CALL)) found(m[2], m.index);
    if (rel !== "io/gatedfs.ts" && rel !== "datadir.ts") {
      for (const m of text.matchAll(GATEDFS)) {
        const verb = m[1] === "export" ? "re-exports" : "imports";
        if (/\bbootstrap\b/.test(m[2])) problems.push(`${shown}:${lineOf(text, m.index)}: ${verb} gatedfs's bootstrap, which only datadir.ts may use`);
        if (/(?:^|,)\s*\*/.test(m[2])) problems.push(`${shown}:${lineOf(text, m.index)}: ${verb} gatedfs as a namespace; ${verb === "imports" ? "import" : "re-export"} the functions by name`);
      }
      for (const m of text.matchAll(GATEDFS_CALL)) {
        problems.push(`${shown}:${lineOf(text, m.index)}: loads gatedfs with a call (a dynamic import or require), which hides what it uses; import the functions by name`);
      }
    }
    if (rel === "motion/render.ts") {
      if (!/import\s*\{[^}]*\bGateNetworkFsPlugin\b[^}]*\}\s*from\s*(['"])\.\/netgate\.js\1/.test(text) || !/\bplugins\s*:\s*\[[^;]*?\bnew\s+GateNetworkFsPlugin\s*\(\s*\)/.test(text)) {
        problems.push(`${shown}: bundle() must get plugins: [..., new GateNetworkFsPlugin()] from ./netgate.js (G9)`);
      }
      if (/disableWebSecurity/.test(text)) problems.push(`${shown}: mentions disableWebSecurity; the graphic's Chromium must keep web security on`);
      if (/rspack/i.test(text)) problems.push(`${shown}: mentions rspack, which resolves outside G9's file-system wrapper`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- self-test

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "check-io-imports-"));
  let failures = 0;
  const GOOD_RENDER = `import { bundle } from "@remotion/bundler";\nimport { GateNetworkFsPlugin } from "./netgate.js";\nbundle({ webpackOverride: (c) => ({ ...c, plugins: [...(c.plugins ?? []), new GateNetworkFsPlugin()] }) });\n`;
  const base = {
    "io/gatedfs.ts": `import * as fs from "node:fs";\nimport * as fsp from "node:fs/promises";\n`,
    "ffmpeg/executor.ts": `import { execa } from "execa";\nimport { readFileSync } from "../io/gatedfs.js";\n`,
    "datadir.ts": `import { bootstrap } from "./io/gatedfs.js";\n`,
    "motion/render.ts": GOOD_RENDER,
  };
  /** Write `files` over the base tree; `expect` is a regex every problem must match, or null for clean. */
  const run = (name, files, expect) => {
    const root = join(dir, "case");
    for (const [f, body] of Object.entries({ ...base, ...files })) {
      mkdirSync(dirname(join(root, SRC, f)), { recursive: true });
      writeFileSync(join(root, SRC, f), body);
    }
    const problems = scan(root);
    const wrong = expect === null ? problems.length > 0 : problems.length === 0 || !problems.every((p) => expect.test(p));
    console.log(`${wrong ? "FAIL" : "ok  "} ${name}${wrong ? `: ${JSON.stringify(problems)}` : ""}`);
    if (wrong) failures++;
    rmSync(root, { recursive: true, force: true });
  };
  const IMPORTS = /^packages\/core\/src\/bad\.ts:\d+: imports "/;

  try {
    run("the gated modules and datadir's bootstrap pass", {}, null);
    run("a file using gatedfs and the executor helpers passes", {
      "engine.ts": `import { stat, readFile } from "./io/gatedfs.js";\nimport { runTool } from "./ffmpeg/executor.js";\nimport type { Stats } from "node:fs";\n// node:fs is gated: see io/gatedfs.ts\n`,
    }, null);
    for (const [form, body] of [
      ["named import of node:fs", `import { statSync } from "node:fs";\n`],
      ["named import of fs/promises", `import { stat } from "fs/promises";\n`],
      ["default import of fs", `import fs from "fs";\n`],
      ["namespace import of node:fs/promises", `import * as fsp from 'node:fs/promises';\n`],
      ["a multi-line import", `import {\n  mkdir,\n  rm,\n} from "node:fs/promises";\n`],
      ["a mixed type and value import", `import { type Stats, statSync } from "node:fs";\n`],
      ["a re-export", `export { readFile } from "node:fs/promises";\n`],
      ["a side-effect import", `import "node:fs";\n`],
      ["a dynamic import", `const { rename } = await import("node:fs/promises");\n`],
      ["a require", `const cp = require("child_process");\n`],
      ["a createRequire call", `const fs = req('node:fs');\n`],
      ["a TypeScript import-equals", `import fs = require("fs");\n`],
      ["execa", `import { execa } from "execa";\n`],
      ["node:child_process", `import { spawn } from "node:child_process";\n`],
    ]) {
      run(`${form} outside the gated modules fails`, { "bad.ts": body }, IMPORTS);
    }
    run("a file in a subfolder is scanned", { "media/deep/x.ts": `import { stat } from "node:fs/promises";\n` }, /media\/deep\/x\.ts:1: imports "node:fs\/promises"/);
    run("gatedfs may not spawn", { "io/gatedfs.ts": `import * as fs from "node:fs";\nimport { spawn } from "node:child_process";\n` }, /io\/gatedfs\.ts:2: imports "node:child_process"/);
    run("the executor may not import fs", { "ffmpeg/executor.ts": `import { execa } from "execa";\nimport { statSync } from "node:fs";\n` }, /ffmpeg\/executor\.ts:2: imports "node:fs"/);
    run("bootstrap outside datadir.ts fails", { "engine.ts": `import { bootstrap, stat } from "./io/gatedfs.js";\n` }, /engine\.ts:1: imports gatedfs's bootstrap/);
    run("a namespace import of gatedfs fails", { "storage.ts": `import * as g from "./io/gatedfs.js";\n` }, /storage\.ts:1: imports gatedfs as a namespace/);
    run("a re-export of bootstrap fails", { "barrel.ts": `export { bootstrap } from "./io/gatedfs.js";\n` }, /barrel\.ts:1: re-exports gatedfs's bootstrap/);
    run("a renamed re-export of bootstrap fails", { "barrel.ts": `export { stat, bootstrap as boot } from "../io/gatedfs";\n` }, /barrel\.ts:1: re-exports gatedfs's bootstrap/);
    run("export * from gatedfs fails", { "barrel.ts": `export * from "./io/gatedfs.js";\n` }, /barrel\.ts:1: re-exports gatedfs as a namespace/);
    run("export * as from gatedfs fails", { "barrel.ts": `export * as g from "./io/gatedfs.js";\n` }, /barrel\.ts:1: re-exports gatedfs as a namespace/);
    run("a dynamic import of gatedfs fails", { "lazy.ts": `const g = await import("./io/gatedfs.js");\n` }, /lazy\.ts:1: loads gatedfs with a call/);
    run("a require of gatedfs fails", { "lazy.ts": `const g = require('../io/gatedfs');\n` }, /lazy\.ts:1: loads gatedfs with a call/);
    run("a default-and-namespace import of gatedfs fails", { "storage.ts": `import d, * as g from "./io/gatedfs.js";\n` }, /storage\.ts:1: imports gatedfs as a namespace/);
    run("a comment with a star in a named import passes", { "engine.ts": `import { stat /* gated */ } from "./io/gatedfs.js";\n` }, null);
    run("a re-export of a gated function passes", { "barrel.ts": `export { stat, readFile } from "./io/gatedfs.js";\nexport type { BlockedPathError } from "./io/gatedfs.js";\n` }, null);
    run("datadir.ts may re-export bootstrap", { "datadir.ts": `import { bootstrap } from "./io/gatedfs.js";\nexport { bootstrap } from "./io/gatedfs.js";\n` }, null);
    run("render.ts without the G9 plugin fails", {
      "motion/render.ts": `import { bundle } from "@remotion/bundler";\nbundle({ webpackOverride: (c) => c });\n`,
    }, /motion\/render\.ts: bundle\(\) must get plugins/);
    run("render.ts that imports the plugin but does not pass it fails", {
      "motion/render.ts": `import { GateNetworkFsPlugin } from "./netgate.js";\nbundle({ webpackOverride: (c) => ({ ...c, plugins: c.plugins }) });\nvoid GateNetworkFsPlugin;\n`,
    }, /motion\/render\.ts: bundle\(\) must get plugins/);
    run("render.ts with disableWebSecurity fails", {
      "motion/render.ts": `${GOOD_RENDER}renderMedia({ chromiumOptions: { disableWebSecurity: true } });\n`,
    }, /motion\/render\.ts: mentions disableWebSecurity/);
    run("render.ts with rspack fails", { "motion/render.ts": `${GOOD_RENDER}bundle({ rspack: true });\n` }, /motion\/render\.ts: mentions rspack/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failures ? `[check-io-imports] self-test FAILED: ${failures} case(s)` : "[check-io-imports] self-test ok");
  return failures === 0;
}

// ---------------------------------------------------------------- main

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  const problems = scan(resolve(arg("--root") ?? DEFAULT_ROOT));
  for (const p of problems) console.error(p);
  if (problems.length) console.error(`[check-io-imports] FAILED: ${problems.length} problem(s)`);
  else console.log("[check-io-imports] ok: core file-system and child-process access goes through io/gatedfs.ts and ffmpeg/executor.ts");
  process.exit(problems.length ? 1 : 0);
}
