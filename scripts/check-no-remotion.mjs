// The packaging gate (ADDON-PLAN D6): no Remotion byte in a packed ZedMix.
// Remotion is a user-installed add-on (Help → Graphics add-on…), so no build
// ZedMix conveys may hold it. electron-builder's afterPack hook
// (apps/desktop/build/afterpack.cjs) runs this on every build's appOutDir,
// `--dir` included, before any installer is made. It fails when:
//
//  - a path segment anywhere in the tree is `remotion`, `remotion.exe`,
//    `@remotion` or `.remotion`, or starts with `chrome-headless-shell`
//    (case-insensitive): Remotion's packages, its compositor binaries and the
//    headless shell;
//  - a package.json under resources/app/node_modules (at any depth) has a
//    name@version on the add-on-only list (ADDON_ONLY in
//    packages/core/src/motion/addonlock.ts, which gen-graphics-lock.mjs keeps
//    in sync with the lock): a package only the add-on has, such as esbuild,
//    webpack or @rspack/*. A package the shipped code shares with the add-on
//    (react, ws, cross-spawn, semver@7.8.4, …) is not on that list;
//  - resources/app/node_modules/@aive/core/src exists: a core whose package
//    folder holds src/ takes itself for a source checkout and honours
//    AIVE_REMOTION_ADDON, AIVE_REMOTION_BROWSER and AIVE_ADDON_REGISTRY;
//  - resources/app/node_modules/@aive/core/licenses/remotion-<v>-LICENSE.md,
//    the licence text the add-on dialog shows, is missing or differs from the
//    repository's copy (packages/core/licenses) by a single byte.
//
// resources/app is <appOutDir>/resources/app (Windows, Linux) or
// <appOutDir>/<name>.app/Contents/Resources/app (macOS). Symbolic links are
// not followed.
//
// It only reads. Usage: node scripts/check-no-remotion.mjs <appOutDir> [--root <repo>]
//                       node scripts/check-no-remotion.mjs --self-test
// Exits 0 when clean, 1 otherwise.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = join("packages", "core", "src", "motion", "addonlock.ts");
const LICENSES = join("packages", "core", "licenses");

/** A path segment that names Remotion or its browser. */
const BANNED = (segment) => {
  const s = segment.toLowerCase();
  return s === "remotion" || s === "remotion.exe" || s === "@remotion" || s === ".remotion" || s.startsWith("chrome-headless-shell");
};

/** The pin's Remotion version and add-on-only list, read from addonlock.ts under `root`; problems when they can't be read. */
export function readPin(root) {
  let text = "";
  try {
    text = readFileSync(join(root, LOCK), "utf8");
  } catch {
    return { version: null, addonOnly: [], problems: [`${LOCK} can't be read under ${root}`] };
  }
  const version = /export const ADDON_REMOTION_VERSION = "([^"]+)";/.exec(text)?.[1] ?? null;
  const list = /export const ADDON_ONLY: readonly string\[\] = (\[[\s\S]*?\n\]);/.exec(text)?.[1];
  let addonOnly = [];
  try {
    addonOnly = list ? JSON.parse(list.replace(/,\s*\]$/, "]")) : [];
  } catch {
    /* reported below */
  }
  const problems = [];
  if (!version) problems.push(`${LOCK} has no ADDON_REMOTION_VERSION`);
  if (addonOnly.length === 0) problems.push(`${LOCK} has no ADDON_ONLY list`);
  return { version, addonOnly, problems };
}

/** The app folder in a packed tree, or null. */
function appDir(out) {
  if (existsSync(join(out, "resources", "app"))) return join(out, "resources", "app");
  let entries = [];
  try {
    entries = readdirSync(out);
  } catch {
    return null;
  }
  for (const e of entries) if (e.endsWith(".app") && existsSync(join(out, e, "Contents", "Resources", "app"))) return join(out, e, "Contents", "Resources", "app");
  return null;
}

/** Every entry below `dir` as [path, lstat], links not followed. */
function* walk(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = join(dir, name);
    const st = lstatSync(p);
    yield [p, st];
    if (st.isDirectory()) yield* walk(p);
  }
}

/** The gate's problems for the packed tree at `out`, with the pin and licence of the repository at `root`. */
export function scan(out, root = DEFAULT_ROOT) {
  const pin = readPin(root);
  const problems = [...pin.problems];
  const shown = (p) => relative(out, p).split(sep).join("/");
  if (!existsSync(out)) return [...problems, `${out} does not exist`];

  // A banned folder is reported once, not with every file in it.
  for (const [p] of walk(out)) if (BANNED(basename(p))) problems.push(`${shown(p)}: "${basename(p)}" names Remotion or its headless shell`);

  const app = appDir(out);
  if (!app) return [...problems, `${out} has no resources/app`];
  const addonOnly = new Set(pin.addonOnly);
  for (const [p, st] of walk(join(app, "node_modules"))) {
    if (!st.isFile() || basename(p) !== "package.json") continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    if (typeof pkg?.name !== "string" || typeof pkg?.version !== "string") continue;
    if (addonOnly.has(`${pkg.name}@${pkg.version}`)) problems.push(`${shown(p)}: ${pkg.name}@${pkg.version} is a graphics add-on package (ADDON_ONLY), which no build may ship`);
  }

  const core = join(app, "node_modules", "@aive", "core");
  if (existsSync(join(core, "src"))) problems.push(`${shown(join(core, "src"))} exists: a core with src/ takes itself for a source checkout (leave it out in apps/desktop's build.files)`);
  if (pin.version) {
    const name = `remotion-${pin.version}-LICENSE.md`;
    const shipped = join(core, "licenses", name);
    let want = null;
    try {
      want = readFileSync(join(root, LICENSES, name));
    } catch {
      problems.push(`${join(LICENSES, name)} can't be read under ${root}`);
    }
    if (!existsSync(shipped)) problems.push(`${shown(shipped)} is missing: the add-on dialog shows Remotion's licence from it`);
    else if (want && !readFileSync(shipped).equals(want)) problems.push(`${shown(shipped)} differs from ${join(LICENSES, name)}`);
  }
  return problems;
}

// ---------------------------------------------------------------- self-test

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "check-no-remotion-"));
  let failures = 0;
  const LICENSE = "Remotion License\r\nfixture text\n";
  /** A fixture repository: its pin (two add-on-only pairs) and licence. */
  const root = join(dir, "repo");
  mkdirSync(join(root, dirname(LOCK)), { recursive: true });
  mkdirSync(join(root, LICENSES), { recursive: true });
  writeFileSync(join(root, LOCK), `export const ADDON_REMOTION_VERSION = "4.0.481";\n\nexport const ADDON_ONLY: readonly string[] = [\n  "esbuild@0.28.1",\n  "webpack@5.105.0",\n];\n`);
  writeFileSync(join(root, LICENSES, "remotion-4.0.481-LICENSE.md"), LICENSE);
  const pkg = (name, version) => JSON.stringify({ name, version });
  /** A clean Windows/Linux tree: shared packages (react, semver@7.8.4 as global-agent has it), the core without src/, its licence. */
  const base = {
    "zedmix.exe": "",
    "resources/app/package.json": pkg("zedmix-desktop", "0.2.0"),
    "resources/app/node_modules/react/package.json": pkg("react", "18.3.1"),
    "resources/app/node_modules/global-agent/node_modules/semver/package.json": pkg("semver", "7.8.4"),
    "resources/app/node_modules/esbuild-like/package.json": pkg("esbuild", "0.25.12"),
    "resources/app/node_modules/x/dist/esm/package.json": JSON.stringify({ type: "module" }),
    "resources/app/node_modules/@aive/core/package.json": pkg("@aive/core", "0.2.0"),
    "resources/app/node_modules/@aive/core/dist/motion/remotionload.js": "",
    "resources/app/node_modules/@aive/core/licenses/remotion-4.0.481-LICENSE.md": LICENSE,
  };
  /**
   * Write `files` over the base tree (null leaves a base file out; `only`: no base tree, `mac`: in a .app);
   * `expect` is a regex every problem must match, or null for clean.
   */
  const run = (name, files, expect, { mac = false, only = false, repo = root } = {}) => {
    const out = join(dir, "out");
    mkdirSync(out, { recursive: true });
    for (const [f, body] of Object.entries(only ? files : { ...base, ...files })) {
      if (body === null) continue;
      const at = join(out, mac ? f.replace(/^resources\//, "ZedMix.app/Contents/Resources/") : f);
      mkdirSync(f.endsWith("/") ? at : dirname(at), { recursive: true });
      if (!f.endsWith("/")) writeFileSync(at, body);
    }
    const problems = scan(out, repo);
    const wrong = expect === null ? problems.length > 0 : problems.length === 0 || !problems.every((p) => expect.test(p));
    console.log(`${wrong ? "FAIL" : "ok  "} ${name}${wrong ? `: ${JSON.stringify(problems)}` : ""}`);
    if (wrong) failures++;
    rmSync(out, { recursive: true, force: true });
  };
  const NAMES = /names Remotion or its headless shell$/;

  try {
    run("a clean tree passes: shared packages, semver@7.8.4, another esbuild version, the core's remotionload.js", {}, null);
    run("a clean macOS tree passes", {}, null, { mac: true });
    for (const [what, file] of [
      ["node_modules/remotion", "resources/app/node_modules/remotion/package.json"],
      ["node_modules/@remotion/renderer", "resources/app/node_modules/@remotion/renderer/package.json"],
      ["a nested @remotion", "resources/app/node_modules/a/node_modules/@Remotion/x/index.js"],
      ["the compositor binary", "resources/app/bin/Remotion.exe"],
      ["Remotion's browser cache", "resources/app/node_modules/.remotion/x"],
      ["a headless shell outside node_modules", "resources/aive/chrome-headless-shell-win64/chrome-headless-shell.exe"],
    ]) {
      run(`${what} fails`, { [file]: "x" }, NAMES);
    }
    run("an add-on-only name@version fails", { "resources/app/node_modules/esbuild/package.json": pkg("esbuild", "0.28.1") }, /node_modules\/esbuild\/package\.json: esbuild@0\.28\.1 is a graphics add-on package/);
    run("an add-on-only package nested in another fails", { "resources/app/node_modules/a/node_modules/webpack/package.json": pkg("webpack", "5.105.0") }, /node_modules\/a\/node_modules\/webpack\/package\.json: webpack@5\.105\.0/);
    run("the core's src/ fails", { "resources/app/node_modules/@aive/core/src/index.ts": "" }, /@aive\/core\/src exists/);
    run("an empty src/ folder of the core fails", { "resources/app/node_modules/@aive/core/src/": "" }, /@aive\/core\/src exists/);
    run("a missing licence file fails", { "resources/app/node_modules/@aive/core/licenses/remotion-4.0.481-LICENSE.md": null }, /remotion-4\.0\.481-LICENSE\.md is missing/);
    run("a licence file with other line endings fails", { "resources/app/node_modules/@aive/core/licenses/remotion-4.0.481-LICENSE.md": LICENSE.replace("\r\n", "\n") }, /remotion-4\.0\.481-LICENSE\.md differs/);
    run("a tree without resources/app fails", { "zedmix.exe": "" }, /has no resources\/app$/, { only: true });
    // This repository's pin: the 18 packages production shares with the add-on, and semver@7.8.4 (global-agent's), pass;
    // the add-on's own esbuild does not.
    const lock = JSON.parse(readFileSync(join(DEFAULT_ROOT, "package-lock.json"), "utf8")).packages;
    const { version } = readPin(DEFAULT_ROOT);
    const real = { "resources/app/node_modules/@aive/core/licenses/remotion-4.0.481-LICENSE.md": readFileSync(join(DEFAULT_ROOT, LICENSES, `remotion-${version}-LICENSE.md`)) };
    const SHARED = ["react", "react-dom", "scheduler", "loose-envify", "js-tokens", "ws", "path-key", "cross-spawn", "which", "isexe", "shebang-command", "shebang-regex", "graceful-fs", "fast-deep-equal", "ajv", "require-from-string", "json-schema-traverse", "fast-uri", "global-agent/node_modules/semver"];
    for (const n of SHARED) real[`resources/app/node_modules/${n}/package.json`] = JSON.stringify({ name: n.split("/").pop(), version: lock[`node_modules/${n}`].version });
    run(`this repository's pin passes the ${SHARED.length - 1} shared packages and semver@${lock["node_modules/global-agent/node_modules/semver"].version}`, real, null, { repo: DEFAULT_ROOT });
    run(`this repository's pin refuses the add-on's esbuild@${lock["node_modules/esbuild"].version}`, { ...real, "resources/app/node_modules/esbuild/package.json": pkg("esbuild", lock["node_modules/esbuild"].version) }, /esbuild@[\d.]+ is a graphics add-on package/, { repo: DEFAULT_ROOT });
    {
      const problems = scan(join(dir, "missing"), join(dir, "no-repo"));
      const ok = problems.some((p) => /addonlock\.ts can't be read/.test(p)) && problems.some((p) => /does not exist$/.test(p));
      console.log(`${ok ? "ok  " : "FAIL"} an unreadable pin and a missing tree fail${ok ? "" : `: ${JSON.stringify(problems)}`}`);
      if (!ok) failures++;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failures ? `[check-no-remotion] self-test FAILED: ${failures} case(s)` : "[check-no-remotion] self-test ok");
  return failures === 0;
}

// ---------------------------------------------------------------- main

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  const out = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--root");
  if (!out) {
    console.error("Usage: node scripts/check-no-remotion.mjs <appOutDir> [--root <repo>]");
    process.exit(2);
  }
  const problems = scan(resolve(out), resolve(arg("--root") ?? DEFAULT_ROOT));
  for (const p of problems) console.error(p);
  if (problems.length) console.error(`[check-no-remotion] FAILED: ${problems.length} problem(s) in ${out}`);
  else console.log(`[check-no-remotion] ok: ${out} holds no Remotion package, add-on-only package, headless shell or core src/, and the core's Remotion licence matches`);
  process.exit(problems.length ? 1 : 0);
}
