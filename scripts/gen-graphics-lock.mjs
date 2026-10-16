// The graphics add-on's pin (ADDON-PLAN D2): writes
// packages/core/src/motion/addonlock.ts from the root package-lock.json, so the
// add-on installs exactly the Remotion bytes dev and CI install and test.
//
//  - the closure of remotion, @remotion/bundler, @remotion/renderer, react and
//    react-dom as packages/core resolves them, over dependencies,
//    optionalDependencies and peerDependencies, for every platform;
//  - for each supported platform, the walk of the same graph that skips a
//    package whose os/cpu does not match, with its subtree (what npm installs
//    there), with its totals;
//  - per platform, the compositor binary the add-on's key-file check needs;
//  - the add-on-only list: the name@version of every closure entry, less every
//    name@version the production closure (apps/desktop's dependencies, core's
//    Remotion edges gone with them) has, for the packaging gate;
//  - the headless-shell table and the tarball sizes, from
//    scripts/graphics-lock-data.json (the lock has no sizes). A write fills a
//    missing size from npm's local cache (the tarball by its integrity), when
//    it is there; --check never reads the cache.
//
// Usage: node scripts/gen-graphics-lock.mjs [--root <dir>]          write the file
//        node scripts/gen-graphics-lock.mjs [--root <dir>] --check  exit 1 when it is out of sync or the pin is wrong
//        node scripts/gen-graphics-lock.mjs [--root <dir>] --json   print the computed pin, write nothing
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join("packages", "core", "src", "motion", "addonlock.ts");
const DATA = join("scripts", "graphics-lock-data.json");
const REMOTION_LOAD = join("packages", "core", "src", "motion", "remotionload.ts");
const TESTED = join("node_modules", "@remotion", "renderer", "dist", "browser", "get-chrome-download-url.js");

const CORE = "packages/core";
const DESKTOP = "apps/desktop";
const ROOTS = ["remotion", "@remotion/bundler", "@remotion/renderer", "react", "react-dom"];
const REGISTRY = "https://registry.npmjs.org/";
/** The supported platforms (D2) and the compositor binary each one's key-file check looks for. */
const PLATFORMS = {
  "win32-x64": { os: "win32", cpu: "x64", compositor: "@remotion/compositor-win32-x64-msvc/remotion.exe" },
  "darwin-x64": { os: "darwin", cpu: "x64", compositor: "@remotion/compositor-darwin-x64/remotion" },
  "darwin-arm64": { os: "darwin", cpu: "arm64", compositor: "@remotion/compositor-darwin-arm64/remotion" },
  "linux-x64": { os: "linux", cpu: "x64", compositor: "@remotion/compositor-linux-x64-gnu/remotion" },
};

/** The lock path a dependency `name` of the package at lock path `from` resolves to (node's lookup), or null. */
function resolveIn(packages, from, name) {
  for (let base = from; ; ) {
    const p = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[p]) return p;
    if (!base) return null;
    const i = base.lastIndexOf("node_modules/");
    base = i > 0 ? base.slice(0, i - 1) : "";
  }
}

/** npm's os/cpu rule: a "!x" entry refuses x; otherwise a list of names must hold `value`. */
function matches(list, value) {
  if (!list) return true;
  if (list.includes(`!${value}`)) return false;
  const allowed = list.filter((x) => !x.startsWith("!"));
  return allowed.length === 0 || allowed.includes(value);
}

/**
 * The entries reachable from `names` as the package at `from` resolves them.
 * `platform` set: a package whose os/cpu does not match is skipped with its
 * subtree, and `skipped` gets each one the lock does not mark optional.
 */
function walk(packages, from, names, { platform, skipped, missing } = {}) {
  const seen = new Set();
  const queue = [];
  const visit = (at, name, optional) => {
    const target = resolveIn(packages, at, name);
    if (!target) {
      if (!optional) missing?.push(`${at} -> ${name}`);
      return;
    }
    let entry = packages[target];
    if (entry.link) entry = packages[entry.resolved] ? { ...packages[entry.resolved], linkTo: entry.resolved } : entry;
    const key = entry.linkTo ?? target;
    if (seen.has(key)) return;
    if (platform && !(matches(entry.os, platform.os) && matches(entry.cpu, platform.cpu))) {
      if (!entry.optional) skipped?.push(key);
      return;
    }
    seen.add(key);
    queue.push(key);
  };
  for (const n of names) visit(from, n, false);
  while (queue.length) {
    const at = queue.shift();
    const e = packages[at];
    for (const n of Object.keys(e.dependencies ?? {})) visit(at, n, false);
    for (const n of Object.keys(e.optionalDependencies ?? {})) visit(at, n, true);
    for (const n of Object.keys(e.peerDependencies ?? {})) visit(at, n, !!e.peerDependenciesMeta?.[n]?.optional);
  }
  return seen;
}

/** A lock path's package name: `node_modules/a/node_modules/@s/b` → `@s/b`. */
const nameOf = (path) => path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);

/** The path of an integrity's content in npm's local cache (cacache, content-v2). */
function cachePath(integrity) {
  const m = /^(sha\d+)-(.+)$/.exec(integrity);
  if (!m) return null;
  const hex = Buffer.from(m[2], "base64").toString("hex");
  return join(homedir(), ".npm", "_cacache", "content-v2", m[1], hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

/**
 * The pin computed from the tree at `root`, and the problems --check reports
 * besides an out-of-date file. `fillSizes`: take a missing tarball size from
 * npm's cache (a write; --check never does).
 */
export function compute(root, { fillSizes = false } = {}) {
  const problems = [];
  const packages = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages;
  const data = JSON.parse(readFileSync(join(root, DATA), "utf8"));
  const remotion = /export const REMOTION_VERSION = "([^"]+)";/.exec(readFileSync(join(root, REMOTION_LOAD), "utf8"))?.[1];
  if (!remotion) problems.push(`${REMOTION_LOAD}: no REMOTION_VERSION`);

  const missing = [];
  const closurePaths = [...walk(packages, CORE, ROOTS, { missing })].sort();
  for (const m of missing) problems.push(`the lock has no entry for the dependency ${m}`);
  const sizes = { ...data.tarballBytes };
  const closure = closurePaths.map((path) => {
    const e = packages[path];
    if (!String(e.resolved ?? "").startsWith(REGISTRY)) problems.push(`${path}: resolved ${JSON.stringify(e.resolved)} is not ${REGISTRY}…`);
    if (!/^sha512-/.test(e.integrity ?? "")) problems.push(`${path}: integrity ${JSON.stringify(e.integrity)} is not sha512`);
    if (fillSizes && sizes[e.integrity] === undefined) {
      const cached = e.integrity && cachePath(e.integrity);
      if (cached && existsSync(cached)) sizes[e.integrity] = statSync(cached).size;
    }
    return { path, version: e.version, resolved: e.resolved, integrity: e.integrity, optional: !!e.optional, bytes: sizes[e.integrity] ?? null };
  });
  const main = closure.find((e) => e.path === "node_modules/remotion");
  if (!main || main.version !== remotion) problems.push(`node_modules/remotion is ${main?.version ?? "missing"}, and remotionload.ts guards Remotion ${remotion}`);

  const byPath = new Map(closure.map((e) => [e.path, e]));
  const platforms = {};
  for (const [key, p] of Object.entries(PLATFORMS)) {
    const skipped = [];
    const paths = [...walk(packages, CORE, ROOTS, { platform: p, skipped })].sort();
    for (const s of skipped) problems.push(`${key}: the walk skips ${s}, which the lock does not mark optional`);
    const compositor = `node_modules/${p.compositor.slice(0, p.compositor.lastIndexOf("/"))}`;
    if (!paths.includes(compositor)) problems.push(`${key}: the walk has no ${compositor}`);
    const bytes = paths.map((x) => byPath.get(x)?.bytes ?? null);
    platforms[key] = { count: paths.length, bytes: bytes.includes(null) ? null : bytes.reduce((a, b) => a + b, 0), compositor: p.compositor, paths };
  }

  // What ships: apps/desktop's dependencies (core's Remotion edges are devDependencies now).
  const shipped = new Set(
    [...walk(packages, DESKTOP, Object.keys(packages[DESKTOP]?.dependencies ?? {}))]
      .filter((p) => p.startsWith("node_modules/"))
      .map((p) => `${nameOf(p)}@${packages[p].version}`),
  );
  const addonOnly = [...new Set(closure.map((e) => `${nameOf(e.path)}@${e.version}`))].filter((nv) => !shipped.has(nv)).sort();

  const shell = data.headlessShell;
  let tested = null;
  try {
    tested = /exports\.TESTED_VERSION = '([^']+)';/.exec(readFileSync(join(root, TESTED), "utf8"))?.[1] ?? null;
  } catch {
    /* reported below */
  }
  if (tested !== shell.version) problems.push(`Remotion's TESTED_VERSION is ${tested ?? "unreadable"}, and the headless-shell table pins ${shell.version}`);
  for (const key of Object.keys(PLATFORMS)) if (!shell.platforms[key]) problems.push(`the headless-shell table has no ${key}`);

  const lockSha256 = createHash("sha256")
    .update(JSON.stringify({ remotion, closure: closure.map(({ bytes, ...e }) => e), platforms: Object.fromEntries(Object.entries(platforms).map(([k, v]) => [k, v.paths])) }))
    .digest("hex");
  const usedSizes = Object.fromEntries(closure.filter((e) => e.bytes !== null).map((e) => [e.integrity, e.bytes]).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { problems, remotion, lockSha256, closure, platforms, addonOnly, headlessShell: shell, data: { ...data, tarballBytes: usedSizes } };
}

const json = (v) => JSON.stringify(v);

/** The text of addonlock.ts for a computed pin. */
export function render(pin) {
  const keys = Object.keys(PLATFORMS);
  const lines = [
    "// Generated by scripts/gen-graphics-lock.mjs from package-lock.json and",
    "// scripts/graphics-lock-data.json. Do not edit: run `node scripts/gen-graphics-lock.mjs`",
    "// (`--check` says whether this file is in sync).",
    "",
    "/** A platform the graphics add-on supports: `${process.platform}-${process.arch}` (linux-x64 needs glibc). */",
    `export type AddonPlatform = ${keys.map(json).join(" | ")};`,
    "",
    "/** One package of the pinned closure, at its path in the lock (the add-on's node_modules has the same layout). */",
    "export interface AddonLockEntry {",
    "  path: string;",
    "  version: string;",
    "  resolved: string;",
    "  integrity: string;",
    "  optional: boolean;",
    "  /** The tarball's size; null until the generator knows it. */",
    "  bytes: number | null;",
    "}",
    "",
    "/** The entries one platform installs (the graph walk that skips other platforms' packages), with totals. */",
    "export interface AddonPlatformList {",
    "  count: number;",
    "  /** The tarballs' total; null while a size is unknown. */",
    "  bytes: number | null;",
    "  /** The compositor binary the add-on's key-file check looks for, under node_modules. */",
    "  compositor: string;",
    "  paths: readonly string[];",
    "}",
    "",
    "/** A Chrome for Testing headless-shell zip, and the executable's path in it. */",
    "export interface HeadlessShellZip {",
    "  url: string;",
    "  sha256: string;",
    "  size: number;",
    "  executable: string;",
    "  entries: number;",
    "}",
    "",
    `export const ADDON_PLATFORMS: readonly AddonPlatform[] = ${json(keys)};`,
    "",
    "/** The Remotion version of the pin (remotionload.ts's REMOTION_VERSION). */",
    `export const ADDON_REMOTION_VERSION = ${json(pin.remotion)};`,
    "",
    "/** The hash of this pin (the closure and the platform lists); addon.json records it. */",
    `export const ADDON_LOCK_SHA256 = ${json(pin.lockSha256)};`,
    "",
    `/** The closure, every platform (${pin.closure.length} entries). */`,
    "export const ADDON_CLOSURE: readonly AddonLockEntry[] = [",
    ...pin.closure.map((e) => `  ${json(e)},`),
    "];",
    "",
    "export const ADDON_PLATFORM_LISTS: Readonly<Record<AddonPlatform, AddonPlatformList>> = {",
    ...keys.flatMap((k) => {
      const p = pin.platforms[k];
      return [`  ${json(k)}: {`, `    count: ${p.count},`, `    bytes: ${json(p.bytes)},`, `    compositor: ${json(p.compositor)},`, "    paths: [", ...p.paths.map((x) => `      ${json(x)},`), "    ],", "  },"];
    }),
    "};",
    "",
    `/** name@version of every closure package that no shipped package has (${pin.addonOnly.length}): the packaging gate refuses each one. */`,
    "export const ADDON_ONLY: readonly string[] = [",
    ...pin.addonOnly.map((x) => `  ${json(x)},`),
    "];",
    "",
    "/** Chrome for Testing headless shell, one zip per platform, passed to Remotion as browserExecutable. */",
    "export const HEADLESS_SHELL: { version: string; platforms: Readonly<Record<AddonPlatform, HeadlessShellZip>> } = {",
    `  version: ${json(pin.headlessShell.version)},`,
    "  platforms: {",
    ...keys.map((k) => `    ${json(k)}: ${json(pin.headlessShell.platforms[k])},`),
    "  },",
    "};",
    "",
  ];
  return lines.join("\n");
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(arg("--root") ?? DEFAULT_ROOT);
  const check = process.argv.includes("--check");
  const pin = compute(root, { fillSizes: !check });
  if (process.argv.includes("--json")) {
    const { data, ...rest } = pin;
    console.log(JSON.stringify(rest, null, 1));
    process.exit(0);
  }
  const text = render(pin);
  const counts = `closure ${pin.closure.length}; ${Object.entries(pin.platforms).map(([k, v]) => `${k} ${v.count}`).join(", ")}; add-on-only ${pin.addonOnly.length}`;
  if (check) {
    const problems = [...pin.problems];
    let current = null;
    try {
      current = readFileSync(join(root, OUT), "utf8");
    } catch {
      /* missing: out of sync */
    }
    if (current !== text) problems.push(`${OUT} is out of sync with package-lock.json; run node scripts/gen-graphics-lock.mjs`);
    for (const p of problems) console.error(p);
    if (problems.length) console.error(`[gen-graphics-lock] FAILED: ${problems.length} problem(s)`);
    else console.log(`[gen-graphics-lock] ok: ${counts}`);
    process.exit(problems.length ? 1 : 0);
  }
  if (pin.problems.length) {
    for (const p of pin.problems) console.error(p);
    console.error(`[gen-graphics-lock] FAILED: ${pin.problems.length} problem(s); nothing written`);
    process.exit(1);
  }
  writeFileSync(join(root, OUT), text);
  writeFileSync(join(root, DATA), `${JSON.stringify(pin.data, null, 2)}\n`);
  const unsized = pin.closure.filter((e) => e.bytes === null).length;
  console.log(`[gen-graphics-lock] wrote ${OUT}: ${counts}${unsized ? `; ${unsized} tarball size(s) unknown` : ""}`);
}
