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
//    it is there; --check never reads the cache. A cache without another
//    platform's tarballs leaves that platform's total null; --require-sizes
//    (CI and every release job) makes that a problem, so no release ships
//    without the installer's size cap.
//
//  - the drift guard (ruled 2026-10-16): the data file records the accepted
//    fingerprint (ADDON_LOCK_SHA256) and closure (path@version@integrity, and
//    each zip's sha256). --check fails while the computed fingerprint differs,
//    listing the changed, added and removed entries and what each platform's
//    update downloads with reuse (ADDON-PLAN D3.9): every changed fingerprint
//    makes every user update the add-on. --accept-addon-change records the
//    new one (a deliberate Remotion upgrade too).
//  - --browser: the headless-shell table against a folder of the pinned
//    zips, already downloaded (default ~/.cache/zabsreel-addon/cft-<version>,
//    --zips <dir>); it reads no network. A write fills the table from them
//    (url, sha256, size, entry count, the executable in each); --check says
//    where the table and the zips differ. A zip holding a symlink, a zip64
//    record or an encrypted entry is a problem: the add-on's zip reader
//    refuses them.
//
// Usage: node scripts/gen-graphics-lock.mjs [--root <dir>]          write the file
//        node scripts/gen-graphics-lock.mjs [--root <dir>] --check  exit 1 when it is out of sync, the pin is wrong or its fingerprint not accepted
//        node scripts/gen-graphics-lock.mjs [--root <dir>] --check --require-sizes
//                                                                   also exit 1 when a platform's tarball total is unknown
//        node scripts/gen-graphics-lock.mjs [--root <dir>] --accept-addon-change
//                                                                   write the file and accept its fingerprint
//        node scripts/gen-graphics-lock.mjs [--root <dir>] [--check] --browser [--zips <dir>]
//                                                                   also fill (or check) the headless-shell table from the zips
//        node scripts/gen-graphics-lock.mjs [--root <dir>] --json   print the computed pin, write nothing
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
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
/** The supported platforms (D2), the compositor binary each one's key-file check looks for, and its Chrome for Testing name. */
const PLATFORMS = {
  "win32-x64": { os: "win32", cpu: "x64", compositor: "@remotion/compositor-win32-x64-msvc/remotion.exe", cft: "win64" },
  "darwin-x64": { os: "darwin", cpu: "x64", compositor: "@remotion/compositor-darwin-x64/remotion", cft: "mac-x64" },
  "darwin-arm64": { os: "darwin", cpu: "arm64", compositor: "@remotion/compositor-darwin-arm64/remotion", cft: "mac-arm64" },
  "linux-x64": { os: "linux", cpu: "x64", compositor: "@remotion/compositor-linux-x64-gnu/remotion", cft: "linux64" },
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

/** A pinned zip's URL and the executable's path in it. */
function shellUrl(version, key) {
  const c = PLATFORMS[key].cft;
  return {
    url: `https://storage.googleapis.com/chrome-for-testing-public/${version}/${c}/chrome-headless-shell-${c}.zip`,
    executable: `chrome-headless-shell-${c}/chrome-headless-shell${key.startsWith("win32") ? ".exe" : ""}`,
  };
}

/**
 * The central directory of the zip at `file`: its entry names, and the
 * problems the add-on's zip reader (packages/core/src/addon/zip.ts) would
 * refuse it for: zip64, encryption, a symlink or another special file.
 */
function zipListing(file) {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    let at = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tailLen) { at = i; break; }
    if (at < 0) return { names: [], problems: ["no end of central directory"] };
    const count = tail.readUInt16LE(at + 10);
    const dirSize = tail.readUInt32LE(at + 12);
    const dirOffset = tail.readUInt32LE(at + 16);
    if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff || (at >= 20 && tail.readUInt32LE(at - 20) === 0x07064b50)) return { names: [], problems: ["a zip64 archive"] };
    const dir = Buffer.alloc(dirSize);
    readSync(fd, dir, 0, dirSize, dirOffset);
    const names = [];
    const problems = [];
    for (let p = 0, i = 0; i < count; i++) {
      if (dir.readUInt32LE(p) !== 0x02014b50) return { names, problems: [...problems, "a damaged central directory"] };
      const madeBy = dir.readUInt16LE(p + 4);
      const flags = dir.readUInt16LE(p + 8);
      const n = dir.readUInt16LE(p + 28);
      const unix = madeBy >> 8 === 3 ? dir.readUInt32LE(p + 38) >>> 16 : 0;
      const name = dir.subarray(p + 46, p + 46 + n).toString("utf8");
      const kind = unix & 0o170000;
      if (flags & 0x41) problems.push(`${name}: encrypted`);
      if (kind === 0o120000) problems.push(`${name}: a symlink`);
      else if (kind !== 0 && kind !== 0o100000 && kind !== 0o040000) problems.push(`${name}: a special file`);
      if ([20, 24, 42].some((o) => dir.readUInt32LE(p + o) === 0xffffffff)) problems.push(`${name}: a zip64 entry`);
      names.push(name);
      p += 46 + n + dir.readUInt16LE(p + 30) + dir.readUInt16LE(p + 32);
    }
    return { names, problems };
  } finally {
    closeSync(fd);
  }
}

/**
 * The headless-shell table as the zips in `zips` give it, and the problems:
 * a zip missing, one the zip reader would refuse, or one without the
 * executable.
 */
export function browserTable(version, zips) {
  const problems = [];
  const platforms = {};
  for (const key of Object.keys(PLATFORMS)) {
    const { url, executable } = shellUrl(version, key);
    const file = join(zips, url.split("/").pop());
    if (!existsSync(file)) {
      problems.push(`${key}: ${file} is missing (download ${url} there first)`);
      continue;
    }
    const z = zipListing(file);
    for (const p of z.problems) problems.push(`${key}: ${file}: ${p}, which the add-on's zip reader refuses`);
    if (!z.names.includes(executable)) problems.push(`${key}: ${file} has no ${executable}`);
    platforms[key] = { url, sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), size: statSync(file).size, executable, entries: z.names.length };
  }
  return { table: { version, platforms }, problems };
}

/** The closure as the drift guard records it. */
const accepted = (pin) => ({
  lockSha256: pin.lockSha256,
  closure: pin.closure.map((e) => `${e.path}@${e.version}@${e.integrity}`),
  headlessShell: Object.fromEntries(Object.entries(pin.headlessShell.platforms).map(([k, v]) => [k, v.sha256])),
});

/**
 * What changed since the accepted fingerprint, as --check prints it: the
 * closure's changed, added and removed entries, and what each platform's
 * update downloads when it reuses every unchanged package and the browser
 * (D3.9). Empty when the fingerprint is the accepted one.
 */
export function drift(pin, acc) {
  if (acc?.lockSha256 === pin.lockSha256) return [];
  if (!acc) return ["the data file has no accepted add-on fingerprint; run node scripts/gen-graphics-lock.mjs --accept-addon-change"];
  const lines = [`the graphics add-on's fingerprint changed (accepted ${acc.lockSha256.slice(0, 12)}…, now ${pin.lockSha256.slice(0, 12)}…): every user has to update the add-on. If that is meant, run node scripts/gen-graphics-lock.mjs --accept-addon-change`];
  // path@version@integrity: a scoped path has an "@" of its own, so split from the right.
  const split = (x) => {
    const j = x.lastIndexOf("@");
    const i = x.lastIndexOf("@", j - 1);
    return { path: x.slice(0, i), version: x.slice(i + 1, j), integrity: x.slice(j + 1) };
  };
  const before = new Map((acc.closure ?? []).map((x) => { const e = split(x); return [e.path, e]; }));
  const now = new Map(pin.closure.map((e) => [e.path, e]));
  for (const [path, e] of now) {
    const b = before.get(path);
    if (!b) lines.push(`  added ${path}@${e.version}`);
    else if (b.version !== e.version || b.integrity !== e.integrity) lines.push(`  changed ${path}: ${b.version} → ${e.version}${b.version === e.version ? " (another integrity)" : ""}`);
  }
  for (const [path, b] of before) if (!now.has(path)) lines.push(`  removed ${path}@${b.version}`);
  const kept = new Set(acc.closure ?? []);
  for (const [key, list] of Object.entries(pin.platforms)) {
    const fresh = list.paths.map((p) => now.get(p)).filter((e) => !kept.has(`${e.path}@${e.version}@${e.integrity}`));
    const bytes = fresh.reduce((n, e) => n + (e.bytes ?? 0), 0);
    const shell = pin.headlessShell.platforms[key];
    const browser = acc.headlessShell?.[key] === shell?.sha256 ? "the browser is reused" : `plus the browser, ${(shell.size / 1e6).toFixed(1)} MB`;
    lines.push(`  ${key}: the update downloads ${(bytes / 1e6).toFixed(1)} MB (${fresh.length} of ${list.count} packages${fresh.some((e) => e.bytes === null) ? ", some sizes unknown" : ""}); ${browser}`);
  }
  return lines;
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
    .update(JSON.stringify({ remotion, closure: closure.map(({ bytes, ...e }) => e), platforms: Object.fromEntries(Object.entries(platforms).map(([k, v]) => [k, v.paths])), headlessShell: shell }))
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
    "/** The hash of this pin (the closure, the platform lists and the headless-shell table); addon.json records it. */",
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
  const accept = process.argv.includes("--accept-addon-change");
  const browser = process.argv.includes("--browser");
  const dataFile = JSON.parse(readFileSync(join(root, DATA), "utf8"));
  const zips = resolve(arg("--zips") ?? join(userInfo().homedir, ".cache", "zabsreel-addon", `cft-${dataFile.headlessShell.version}`));
  const shell = browser ? browserTable(dataFile.headlessShell.version, zips) : null;
  if (shell && !check && shell.problems.length === 0) {
    // Fill the table from the zips, then compute the pin with it.
    writeFileSync(join(root, DATA), `${JSON.stringify({ ...dataFile, headlessShell: shell.table }, null, 2)}\n`);
  }
  const pin = compute(root, { fillSizes: !check });
  if (shell) {
    pin.problems.push(...shell.problems);
    for (const [k, v] of Object.entries(shell.table.platforms)) {
      const had = pin.headlessShell.platforms[k];
      for (const f of ["url", "sha256", "size", "executable", "entries"]) if (had?.[f] !== v[f]) pin.problems.push(`${k}: the headless-shell table's ${f} is ${JSON.stringify(had?.[f])}, and the zip in ${zips} gives ${JSON.stringify(v[f])}`);
    }
  }
  if (accept) pin.data.accepted = accepted(pin);
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
      // A Windows checkout (core.autocrlf, the release job) has CRLF line endings.
      current = readFileSync(join(root, OUT), "utf8").replace(/\r\n/g, "\n");
    } catch {
      /* missing: out of sync */
    }
    if (current !== text) problems.push(`${OUT} is out of sync with package-lock.json; run node scripts/gen-graphics-lock.mjs`);
    problems.push(...drift(pin, pin.data.accepted));
    if (process.argv.includes("--require-sizes")) {
      for (const [k, v] of Object.entries(pin.platforms)) {
        const unsized = v.paths.filter((x) => pin.closure.find((e) => e.path === x)?.bytes === null).length;
        if (v.bytes === null) problems.push(`${k}: the tarball total is unknown (${unsized} of ${v.count} sizes missing); the installer's size cap and progress need it`);
      }
    }
    for (const p of problems) console.error(p);
    if (problems.length) console.error(`[gen-graphics-lock] FAILED: ${problems.length} problem(s)`);
    else console.log(`[gen-graphics-lock] ok: ${counts}; fingerprint ${pin.lockSha256.slice(0, 12)}… accepted${shell ? `; the headless-shell table matches the zips in ${zips}` : ""}`);
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
  const pending = drift(pin, pin.data.accepted).length > 0;
  console.log(`[gen-graphics-lock] wrote ${OUT}: ${counts}${unsized ? `; ${unsized} tarball size(s) unknown` : ""}${accept ? `; fingerprint ${pin.lockSha256.slice(0, 12)}… accepted` : pending ? "; the fingerprint is not accepted (--check fails until --accept-addon-change)" : ""}`);
}
