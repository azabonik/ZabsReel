/**
 * The graphics add-on (ADDON-PLAN D8.1): the pin, and how the core finds and
 * refuses Remotion. The installer's rows (slice 2) join as their own section.
 *
 * The pin (scripts/gen-graphics-lock.mjs):
 *  P1. the real lock — --check passes; closure 212, platform lists 166 / 166 /
 *                      166 / 168 (both linux-x64 compositors), add-on-only
 *                      193 (the 18 shared packages and semver@7.8.4 left out),
 *                      the headless-shell table for every platform.
 *  P2. the walk      — on a fixture lock shaped like F3, each platform gets
 *                      npm's set: the wasm32-only subtree is skipped, both
 *                      linux-x64 compositors are kept; the closure has all.
 *  P3. --check fails — a walk that skips a non-optional entry; a resolved off
 *                      registry.npmjs.org; remotion not REMOTION_VERSION;
 *                      Remotion's TESTED_VERSION not the table's; the file out
 *                      of sync.
 *  P4. add-on-only   — an add-on path (a/node_modules/semver) with the
 *                      name@version of a production path (b/node_modules/semver)
 *                      is left out of the list.
 * The core:
 *  C1. states        — readGraphicsAddon on fixture folders: ready; no or
 *                      unparsable addon.json: not-installed; lock hash,
 *                      version, platform, schema, or only another version's
 *                      folder: update-needed; each missing key file, and a
 *                      browserExecutable with "..", absolute, or a link out of
 *                      browser/: broken; another platform: unsupported.
 *  C2. refusals      — add_graphic over HTTP /rpc for each state: 409 with
 *                      graphics_addon_missing / _update / _broken /
 *                      _unsupported and the D5.3 message, nothing written, no
 *                      job; get_state and timeline_summary say `graphics`.
 *  C3. the UI signal — each refusal, and a render that finds the add-on broken,
 *                      sends one WS message {type: "graphics-addon", state} and
 *                      no other field; a successful add_graphic sends none.
 *  C4. the browser   — ensureBrowser, openBrowser and renderMedia each get the
 *                      add-on's browserExecutable and an onBrowserDownload that
 *                      throws the D5.2 message (a recording stub); without one
 *                      (AIVE_REMOTION_ADDON alone) neither; Remotion's own
 *                      ensureBrowser with them and a missing file downloads
 *                      nothing.
 *  C5. failures      — a render whose add-on got another installedAt, or was
 *                      removed, fails with "changed while this graphic
 *                      rendered"; one whose add-on lost a key file with
 *                      graphics_addon_broken; any other failure passes on.
 *  C6. resolution    — AIVE_REMOTION_ADDON (and AIVE_REMOTION_BROWSER) in a
 *                      source checkout; in a packaged core folder (no src/)
 *                      the three variables are ignored, one stderr line each;
 *                      no fallback to ZabsReel's own Remotion.
 *  C7. private area  — every writer and reader of RPC_PATH_PARAMS refuses a
 *                      path under <dataDir>/addons with the D5.4 message and
 *                      creates nothing; a link from outside into it too;
 *                      remember_projects skips it.
 *
 * No network: loopback on port 5030, fixture locks, and Remotion stubbed
 * except in C4's last row (which starts no browser). FFmpeg makes C3's video.
 * Run: npx tsx packages/core/scripts/smoke-addon.ts
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { RenderInternals } from "@remotion/renderer";
import { readGraphicsAddon, addonPlatform, graphicsAddonDir, platformLabel } from "../src/addon/state.js";
import { devVariable, GraphicsAddonError, isSourceCheckout, resolveGraphicsAddon, type ResolvedGraphicsAddon } from "../src/addon/resolve.js";
import { EditorEngine } from "../src/engine.js";
import { EditorServer } from "../src/server.js";
import { dispatch, methods, RPC_PATH_PARAMS } from "../src/rpc.js";
import { FFMPEG_BIN } from "../src/ffmpeg/executor.js";
import { ADDON_CLOSURE, ADDON_LOCK_SHA256, ADDON_ONLY, ADDON_PLATFORM_LISTS, ADDON_PLATFORMS, ADDON_REMOTION_VERSION, HEADLESS_SHELL, type AddonPlatform } from "../src/motion/addonlock.js";
import { loadRemotion } from "../src/motion/remotionload.js";
import { ADDON_CHANGED, graphicRemotion, refuseBrowserDownload, renderGraphic, type GraphicRemotion } from "../src/motion/render.js";

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};
const thrown = async (fn: () => unknown): Promise<Error | null> => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as Error;
  }
};

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const GEN = join(REPO, "scripts", "gen-graphics-lock.mjs");
const PORT = 5030;
const root = mkdtempSync(join(tmpdir(), "aive-addon-"));
// These rows decide the add-on themselves: never the checkout's own Remotion.
delete process.env.AIVE_REMOTION_ADDON;
delete process.env.AIVE_REMOTION_BROWSER;
delete process.env.AIVE_ADDON_REGISTRY;

/** D5.3's messages, as the agent reads them. */
const WHERE = "in the ZabsReel window (Help → Graphics add-on)";
const MESSAGES = {
  "not-installed": `Graphics need the Remotion add-on, which the user installs ${WHERE}. Ask the user to install it, then try again.`,
  "update-needed": `The Remotion add-on must be updated for this version of ZabsReel. Ask the user to update it ${WHERE}, then try again.`,
  broken: `The Remotion add-on is damaged (missing files). Ask the user to reinstall it ${WHERE}, then try again.`,
  // This computer's platform (C2 forces the state with a seam).
  unsupported: `The graphics add-on isn't available for ${platformLabel()}, so graphics can't be made on this computer.`,
} as const;
const CODES = { "not-installed": "graphics_addon_missing", "update-needed": "graphics_addon_update", broken: "graphics_addon_broken", unsupported: "graphics_addon_unsupported" } as const;
const BROWSER_MISSING = "The graphics add-on's browser is missing. Reinstall the add-on in the ZabsReel window (Help → Graphics add-on).";

// ---- fixtures ----------------------------------------------------------------------

const PLATFORM = addonPlatform();
let dataN = 0;
const freshData = () => mkdtempSync(join(root, `data-${dataN++}-`));

/** A fake installed add-on in `dataDir` (the key files empty), addon.json from `manifest`; returns its folder. */
function installFixture(dataDir: string, manifest: Record<string, unknown> = {}, platform: AddonPlatform = PLATFORM ?? "linux-x64"): string {
  const dir = graphicsAddonDir(dataDir);
  const exe = HEADLESS_SHELL.platforms[platform].executable;
  const files = [
    "node_modules/@remotion/renderer/dist/esm/index.mjs",
    "node_modules/@remotion/bundler/package.json",
    `node_modules/${ADDON_PLATFORM_LISTS[platform].compositor}`,
    `browser/${exe}`,
  ];
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), "");
  }
  writeFileSync(join(dir, "addon.json"), JSON.stringify({
    schema: 1, remotion: ADDON_REMOTION_VERSION, lockSha256: ADDON_LOCK_SHA256, platform, browserExecutable: exe,
    licenseSha256: "0".repeat(64), acceptedAt: "2026-10-16T00:00:00.000Z", installedAt: "2026-10-16T00:00:01.000Z", via: "desktop", ...manifest,
  }));
  return dir;
}

/** The generator on a fixture tree (`--root`), with `args`. */
function gen(rootDir: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [GEN, "--root", rootDir, ...args], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, json: args.includes("--json") && r.status === 0 ? JSON.parse(r.stdout) : undefined };
}

const reg = (name: string, version: string) => `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`;
/** A lock entry for `path` (a fixture integrity from the path). */
function entry(path: string, version: string, extra: Record<string, unknown> = {}) {
  const name = path.slice(path.lastIndexOf("node_modules/") + 13);
  return { version, resolved: reg(name, version), integrity: `sha512-${createHash("sha512").update(path + version).digest("base64")}`, ...extra };
}
const OPT = { optional: true };
const os = (o: string, c: string) => ({ os: [o], cpu: [c] });

/**
 * A lock shaped like F3: the five roots, @rspack/core with a linux-x64 binding
 * and a wasm32 binding whose own subtree has no os/cpu, the renderer's five
 * compositors (gnu and musl both os=linux cpu=x64), an add-on-only semver with
 * the name@version a production package also has.
 */
function fixtureLock(): { packages: Record<string, Record<string, unknown>> } {
  return {
    packages: {
      "": { name: "fixture", workspaces: ["packages/*", "apps/*"] },
      "packages/core": { name: "@aive/core", devDependencies: { remotion: "4.0.481", "@remotion/bundler": "4.0.481", "@remotion/renderer": "4.0.481", react: "18.3.1", "react-dom": "18.3.1" } },
      "apps/desktop": { name: "zabsreel-desktop", dependencies: { "@aive/core": "*", react: "^18.3.1", b: "1.0.0" } },
      "node_modules/@aive/core": { resolved: "packages/core", link: true },
      "node_modules/remotion": entry("node_modules/remotion", "4.0.481", { peerDependencies: { react: ">=16.8.0", "react-dom": ">=16.8.0" } }),
      "node_modules/react": entry("node_modules/react", "18.3.1", { dependencies: { "loose-envify": "^1.1.0" } }),
      "node_modules/loose-envify": entry("node_modules/loose-envify", "1.4.0"),
      "node_modules/react-dom": entry("node_modules/react-dom", "18.3.1", { peerDependencies: { react: "^18.3.1" }, dependencies: { scheduler: "^0.23.2" } }),
      "node_modules/scheduler": entry("node_modules/scheduler", "0.23.2"),
      "node_modules/@remotion/bundler": entry("node_modules/@remotion/bundler", "4.0.481", { dependencies: { "@rspack/core": "1.0.0", a: "1.0.0" } }),
      "node_modules/@rspack/core": entry("node_modules/@rspack/core", "1.0.0", { optionalDependencies: { "@rspack/binding-linux-x64-gnu": "1.0.0", "@rspack/binding-wasm32-wasi": "1.0.0" } }),
      "node_modules/@rspack/binding-linux-x64-gnu": entry("node_modules/@rspack/binding-linux-x64-gnu", "1.0.0", { ...OPT, ...os("linux", "x64") }),
      "node_modules/@rspack/binding-wasm32-wasi": entry("node_modules/@rspack/binding-wasm32-wasi", "1.0.0", { ...OPT, cpu: ["wasm32"], dependencies: { "@napi-rs/wasm-runtime": "1.0.0" } }),
      "node_modules/@napi-rs/wasm-runtime": entry("node_modules/@napi-rs/wasm-runtime", "1.0.0", { ...OPT, dependencies: { "@emnapi/core": "1.0.0" } }),
      "node_modules/@emnapi/core": entry("node_modules/@emnapi/core", "1.0.0", OPT),
      "node_modules/a": entry("node_modules/a", "1.0.0", { dependencies: { semver: "^7.0.0" } }),
      "node_modules/a/node_modules/semver": entry("node_modules/a/node_modules/semver", "7.8.4"),
      "node_modules/b": entry("node_modules/b", "1.0.0", { dependencies: { semver: "^7.0.0" } }),
      "node_modules/b/node_modules/semver": entry("node_modules/b/node_modules/semver", "7.8.4"),
      "node_modules/semver": entry("node_modules/semver", "6.3.1"),
      "node_modules/@remotion/renderer": entry("node_modules/@remotion/renderer", "4.0.481", {
        dependencies: { remotion: "4.0.481" },
        optionalDependencies: Object.fromEntries(["linux-x64-gnu", "linux-x64-musl", "win32-x64-msvc", "darwin-x64", "darwin-arm64"].map((p) => [`@remotion/compositor-${p}`, "4.0.481"])),
        peerDependencies: { react: ">=16.8.0", "react-dom": ">=16.8.0" },
      }),
      "node_modules/@remotion/compositor-linux-x64-gnu": entry("node_modules/@remotion/compositor-linux-x64-gnu", "4.0.481", { ...OPT, ...os("linux", "x64") }),
      "node_modules/@remotion/compositor-linux-x64-musl": entry("node_modules/@remotion/compositor-linux-x64-musl", "4.0.481", { ...OPT, ...os("linux", "x64") }),
      "node_modules/@remotion/compositor-win32-x64-msvc": entry("node_modules/@remotion/compositor-win32-x64-msvc", "4.0.481", { ...OPT, ...os("win32", "x64") }),
      "node_modules/@remotion/compositor-darwin-x64": entry("node_modules/@remotion/compositor-darwin-x64", "4.0.481", { ...OPT, ...os("darwin", "x64") }),
      "node_modules/@remotion/compositor-darwin-arm64": entry("node_modules/@remotion/compositor-darwin-arm64", "4.0.481", { ...OPT, ...os("darwin", "arm64") }),
    },
  };
}

/** A tree the generator runs on: `lock`, remotionload.ts's version, the data file, Remotion's TESTED_VERSION; the pin written once. */
function fixtureRoot(name: string, lock = fixtureLock(), opts: { remotion?: string; tested?: string } = {}): string {
  const dir = join(root, name);
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put("package-lock.json", JSON.stringify(lock));
  put("packages/core/src/motion/remotionload.ts", `export const REMOTION_VERSION = "${opts.remotion ?? "4.0.481"}";\n`);
  put("scripts/graphics-lock-data.json", readFileSync(join(REPO, "scripts", "graphics-lock-data.json"), "utf8"));
  put("node_modules/@remotion/renderer/dist/browser/get-chrome-download-url.js", `exports.TESTED_VERSION = '${opts.tested ?? HEADLESS_SHELL.version}';\n`);
  return dir;
}

// ---- P: the pin ----------------------------------------------------------------------

// MUTATION: drop the peerDependencies edges from walk() (gen-graphics-lock.mjs) → the closure is 211 and P1 fails.
function p1() {
  console.log("P1. the real lock...");
  const r = spawnSync(process.execPath, [GEN, "--check"], { encoding: "utf8", cwd: REPO });
  check(r.status === 0, `gen-graphics-lock.mjs --check passes (${`${r.stdout}${r.stderr}`.trim().split("\n").pop()})`);
  const counts = ADDON_PLATFORMS.map((p) => `${p} ${ADDON_PLATFORM_LISTS[p].count}`).join(", ");
  check(ADDON_CLOSURE.length === 212 && counts === "win32-x64 166, darwin-x64 166, darwin-arm64 166, linux-x64 168" && ADDON_PLATFORMS.every((p) => ADDON_PLATFORM_LISTS[p].paths.length === ADDON_PLATFORM_LISTS[p].count),
    `closure ${ADDON_CLOSURE.length}; ${counts}`);
  const linux = ADDON_PLATFORM_LISTS["linux-x64"].paths;
  check(linux.includes("node_modules/@remotion/compositor-linux-x64-gnu") && linux.includes("node_modules/@remotion/compositor-linux-x64-musl") && !linux.some((p) => /wasm32|@emnapi|@tybys/.test(p)),
    "linux-x64 has both compositors and none of the wasm32 subtree");
  const shared = ["react@18.3.1", "react-dom@18.3.1", "scheduler@0.23.2", "loose-envify@1.4.0", "js-tokens@4.0.0", "semver@7.8.4"];
  check(ADDON_ONLY.length === 193 && !shared.some((s) => ADDON_ONLY.includes(s)) && ADDON_ONLY.includes("webpack@" + ADDON_CLOSURE.find((e) => e.path === "node_modules/webpack")?.version) && ADDON_ONLY.some((s) => s.startsWith("esbuild@")),
    `add-on-only: ${ADDON_ONLY.length} name@version pairs, without the shared packages and semver@7.8.4, with webpack and esbuild`);
  check(ADDON_PLATFORMS.every((p) => /^https:\/\/storage\.googleapis\.com\/chrome-for-testing-public\/149\.0\.7790\.0\//.test(HEADLESS_SHELL.platforms[p].url) && /^[0-9a-f]{64}$/.test(HEADLESS_SHELL.platforms[p].sha256))
    && /^[0-9a-f]{64}$/.test(ADDON_LOCK_SHA256) && ADDON_PLATFORM_LISTS["linux-x64"].bytes !== null,
    `a Chrome for Testing ${HEADLESS_SHELL.version} zip with its sha256 for every platform; linux-x64 tarballs total ${ADDON_PLATFORM_LISTS["linux-x64"].bytes} bytes`);
}

// MUTATION: make matches() (gen-graphics-lock.mjs) ignore cpu → the wasm32 subtree is in every list and P2 fails.
function p2() {
  console.log("P2. the walk on a fixture lock shaped like F3...");
  const dir = fixtureRoot("p2");
  const w = gen(dir);
  const j = gen(dir, "--json").json as { closure: { path: string }[]; platforms: Record<string, { paths: string[] }> } | undefined;
  const roots = ["node_modules/remotion", "node_modules/react", "node_modules/loose-envify", "node_modules/react-dom", "node_modules/scheduler", "node_modules/@remotion/bundler", "node_modules/@rspack/core", "node_modules/a", "node_modules/a/node_modules/semver", "node_modules/@remotion/renderer"];
  const want: Record<string, string[]> = {
    "linux-x64": [...roots, "node_modules/@rspack/binding-linux-x64-gnu", "node_modules/@remotion/compositor-linux-x64-gnu", "node_modules/@remotion/compositor-linux-x64-musl"],
    "win32-x64": [...roots, "node_modules/@remotion/compositor-win32-x64-msvc"],
    "darwin-x64": [...roots, "node_modules/@remotion/compositor-darwin-x64"],
    "darwin-arm64": [...roots, "node_modules/@remotion/compositor-darwin-arm64"],
  };
  check(w.status === 0 && !!j, `the generator writes the fixture's pin (${w.out.trim().split("\n").pop()})`);
  for (const [p, paths] of Object.entries(want)) {
    const got = j?.platforms[p]?.paths ?? [];
    check(JSON.stringify(got) === JSON.stringify([...paths].sort()), `${p}: npm's set, ${got.length} entries (${JSON.stringify(got.filter((x) => !paths.includes(x)))} extra, ${JSON.stringify(paths.filter((x) => !got.includes(x)))} missing)`);
  }
  check(j?.closure.length === 19 && ["node_modules/@napi-rs/wasm-runtime", "node_modules/@emnapi/core"].every((p) => j.closure.some((e) => e.path === p)) && !j.closure.some((e) => e.path === "node_modules/semver" || e.path.startsWith("node_modules/b")),
    `the closure has every platform's entries, the wasm32 subtree included, and nothing only production uses (${j?.closure.length})`);
  check(gen(dir, "--check").status === 0, "--check passes on the fixture it wrote");
}

// MUTATION: drop skipped.push in walk() → the non-optional row passes --check. Drop the registry
// check → the resolved row passes. Drop the TESTED_VERSION check → its row passes.
function p3() {
  console.log("P3. --check fails on a pin it can't trust...");
  const cases: [string, (l: ReturnType<typeof fixtureLock>) => void, { remotion?: string; tested?: string }, RegExp][] = [
    ["a walk that skips a non-optional entry", (l) => {
      l.packages["node_modules/@remotion/bundler"].dependencies = { "@rspack/core": "1.0.0", a: "1.0.0", "linux-only": "1.0.0" };
      l.packages["node_modules/linux-only"] = entry("node_modules/linux-only", "1.0.0", os("linux", "x64"));
    }, {}, /^win32-x64: the walk skips node_modules\/linux-only, which the lock does not mark optional$/m],
    ["a resolved off the registry", (l) => {
      l.packages["node_modules/a"].resolved = "https://zr-evil-p3.invalid/a/-/a-1.0.0.tgz";
    }, {}, /^node_modules\/a: resolved "https:\/\/zr-evil-p3\.invalid\/a\/-\/a-1\.0\.0\.tgz" is not https:\/\/registry\.npmjs\.org\//m],
    ["remotion not REMOTION_VERSION", (l) => {
      l.packages["node_modules/remotion"].version = "4.0.480";
    }, {}, /^node_modules\/remotion is 4\.0\.480, and remotionload\.ts guards Remotion 4\.0\.481$/m],
    ["Remotion's TESTED_VERSION not the table's", () => {}, { tested: "150.0.0.0" }, /^Remotion's TESTED_VERSION is 150\.0\.0\.0, and the headless-shell table pins 149\.0\.7790\.0$/m],
  ];
  for (const [what, change, opts, want] of cases) {
    const lock = fixtureLock();
    change(lock);
    const dir = fixtureRoot(`p3-${what.replace(/\W+/g, "-")}`, lock, opts);
    const c = gen(dir, "--check");
    const w = gen(dir);
    check(c.status === 1 && want.test(c.out) && w.status === 1 && /nothing written/.test(w.out) && !existsSync(join(dir, "packages/core/src/motion/addonlock.ts")),
      `${what}: --check fails, and a write refuses (${c.out.trim().split("\n")[0]})`);
  }
  const dir = fixtureRoot("p3-sync");
  gen(dir);
  const lock = fixtureLock();
  lock.packages["node_modules/a"].version = "1.0.1";
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock));
  const c = gen(dir, "--check");
  check(c.status === 1 && /addonlock\.ts is out of sync with package-lock\.json/.test(c.out), `a lock changed after the file was written: out of sync (${c.out.trim().split("\n")[0]})`);
}

// MUTATION: let the production walk ship nothing (gen-graphics-lock.mjs `shipped`) → semver@7.8.4 is in the list.
function p4() {
  console.log("P4. the add-on-only list is name@version...");
  const j = gen(fixtureRoot("p4"), "--json").json as { addonOnly: string[] } | undefined;
  const list = j?.addonOnly ?? [];
  check(!list.includes("semver@7.8.4") && !list.includes("react@18.3.1") && list.includes("a@1.0.0") && list.includes("@remotion/renderer@4.0.481"),
    `a/node_modules/semver has b/node_modules/semver's name@version: left out, with react; a and Remotion are in (${JSON.stringify(list)})`);
}

// ---- C: the core ---------------------------------------------------------------------

// MUTATION: drop the lockSha256 comparison (addon/state.ts) → the lock-hash row is ready. Drop
// otherVersion → the other-version row is not-installed. Drop the realpath confinement of the
// browser → the link row is ready. Drop the compositor key file → its row is ready.
function c1() {
  console.log("C1. readGraphicsAddon's states...");
  if (!PLATFORM) {
    console.log(`  skip: ${process.platform}-${process.arch} has no add-on`);
    return;
  }
  const state = (dataDir: string) => readGraphicsAddon(dataDir).state;
  const ready = freshData();
  const dir = installFixture(ready);
  const got = readGraphicsAddon(ready);
  check(got.state === "ready" && got.browserExecutable === join(dir, "browser", HEADLESS_SHELL.platforms[PLATFORM].executable) && got.installedAt === "2026-10-16T00:00:01.000Z",
    `a complete add-on is ready, with its browser inside browser/ (${JSON.stringify(got)})`);
  const none = freshData();
  check(state(none) === "not-installed", "no add-on: not-installed");
  const bad = freshData();
  installFixture(bad);
  writeFileSync(join(graphicsAddonDir(bad), "addon.json"), "{ not json");
  check(state(bad) === "not-installed", "an addon.json that does not parse: not-installed");
  const other = ADDON_PLATFORMS.find((p) => p !== PLATFORM)!;
  for (const [what, manifest] of [
    ["another lock hash", { lockSha256: "f".repeat(64) }],
    ["another Remotion version", { remotion: "4.0.480" }],
    [`another platform (${other})`, { platform: other }],
    ["an unknown schema", { schema: 2 }],
  ] as const) {
    const d = freshData();
    installFixture(d, manifest);
    check(state(d) === "update-needed", `${what}: update-needed (${state(d)})`);
  }
  const moved = freshData();
  installFixture(moved);
  const dirOld = join(moved, "addons", "remotion", "4.0.480");
  mkdirSync(dirname(dirOld), { recursive: true });
  execFileSync(process.execPath, ["-e", `require("fs").renameSync(${JSON.stringify(graphicsAddonDir(moved))}, ${JSON.stringify(dirOld)})`]);
  check(state(moved) === "update-needed", `only another version's folder (a ZabsReel update moved the pin): update-needed (${state(moved)})`);
  const keys: [string, string][] = [
    ["the renderer's ESM build", "node_modules/@remotion/renderer/dist/esm/index.mjs"],
    ["the bundler's package.json", "node_modules/@remotion/bundler/package.json"],
    ["the compositor", `node_modules/${ADDON_PLATFORM_LISTS[PLATFORM].compositor}`],
    ["the browser executable", `browser/${HEADLESS_SHELL.platforms[PLATFORM].executable}`],
  ];
  for (const [what, rel] of keys) {
    const d = freshData();
    unlinkSync(join(installFixture(d), rel));
    check(state(d) === "broken", `${what} missing: broken (${state(d)})`);
  }
  const outside = join(root, "outside-chrome");
  writeFileSync(outside, "");
  for (const [what, exe, link] of [
    ['a ".." path', "../node_modules/@remotion/bundler/package.json", false],
    ["an absolute path", outside, false],
    ["a link out of browser/", "linked/chrome", true],
  ] as const) {
    const d = freshData();
    const a = installFixture(d, { browserExecutable: exe });
    if (link) {
      mkdirSync(join(a, "browser", "linked"), { recursive: true });
      symlinkSync(outside, join(a, "browser", "linked", "chrome"));
    }
    check(state(d) === "broken", `a browserExecutable that leaves browser/ (${what}): broken (${state(d)})`);
  }
  const arm = readGraphicsAddon(ready, { platform: "linux-arm64" });
  check(arm.state === "unsupported" && arm.dir === undefined, `another platform (linux-arm64): unsupported, nothing read (${JSON.stringify(arm)})`);
}

/** A server on PORT for `engine`, a WS client on it, and the graphics-addon messages it got. */
async function serve(engine: EditorEngine, dataDir: string) {
  const server = new EditorServer(engine, { port: PORT, dataDir });
  await server.start();
  const { token } = JSON.parse(readFileSync(join(dataDir, "server.json"), "utf8")) as { token: string };
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${token}`);
  const signals: Record<string, unknown>[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(String(d)) as Record<string, unknown>;
    if (m.type === "graphics-addon") signals.push(m);
  });
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  const rpc = async (method: string, params: unknown = {}) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/rpc`, { method: "POST", headers: { "content-type": "application/json", "x-aive-token": token }, body: JSON.stringify({ method, params }) });
    return { status: res.status, body: (await res.json()) as { ok: boolean; result?: any; error?: string; code?: string } };
  };
  /** The signals sent since the last call, after the WS has caught up. */
  const take = async () => {
    await new Promise((r) => setTimeout(r, 200));
    return signals.splice(0);
  };
  const stop = async () => {
    ws.close();
    await server.stop();
  };
  return { rpc, take, stop };
}

/** The Remotion calls renderGraphic makes, recorded; `onRender` runs in renderMedia (it may write the output or throw). */
function recordingRemotion(onRender: (o: Record<string, any>) => void | Promise<void> = () => {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const internals = { HeadlessBrowser: { create: async () => ({ close: async () => {} }) } } as unknown as typeof RenderInternals;
  const stub: GraphicRemotion = {
    guard: () => ({ ok: true }),
    RenderInternals: internals,
    bundlerModules: join(REPO, "node_modules"),
    bundle: (async () => "http://127.0.0.1:5039/bundle") as unknown as GraphicRemotion["bundle"],
    ensureBrowser: (async (...args: unknown[]) => (calls.push({ name: "ensureBrowser", args }), { type: "user-defined-path", path: "" })) as unknown as GraphicRemotion["ensureBrowser"],
    openBrowser: (async (...args: unknown[]) => {
      calls.push({ name: "openBrowser", args });
      return (internals.HeadlessBrowser as unknown as { create: (o: object) => Promise<object> }).create({ args: [] });
    }) as unknown as GraphicRemotion["openBrowser"],
    renderMedia: (async (o: Record<string, any>) => {
      calls.push({ name: "renderMedia", args: [o] });
      await onRender(o);
      return { buffer: null, slowestFrames: [], contentType: "" };
    }) as unknown as GraphicRemotion["renderMedia"],
  };
  return { stub, calls };
}

/** renderMedia's stand-in output: a short real H.264 at the location it was given. */
const writeVideo = (o: Record<string, any>) => {
  execFileSync(FFMPEG_BIN, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.5:r=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", o.outputLocation as string]);
};

// MUTATION: map 409 back to 403 for the graphics codes (server.ts FORWARDED_CODES) → the status rows
// fail. Drop the GraphicsAddonError branch from dispatch → the codes are missing. Drop
// `graphics` from get_state → its rows fail. Drop the emit in addGraphic → C3's rows fail.
async function c2c3() {
  console.log("C2/C3. add_graphic refusals over HTTP, and the UI signal...");
  const dataDir = freshData();
  const engine = new EditorEngine(dataDir);
  const s = await serve(engine, dataDir);
  try {
    const listing = () => readdirSync(dataDir).filter((f) => f !== "server.json").sort();
    const setups: [keyof typeof CODES, () => void][] = [
      ["not-installed", () => {}],
      ["update-needed", () => installFixture(dataDir, { lockSha256: "f".repeat(64) })],
      ["broken", () => (installFixture(dataDir), unlinkSync(join(graphicsAddonDir(dataDir), "node_modules", ...ADDON_PLATFORM_LISTS[PLATFORM ?? "linux-x64"].compositor.split("/"))))],
      ["unsupported", () => (engine.graphicsAddon = () => resolveGraphicsAddon(dataDir, { platform: "linux-arm64" }))],
    ];
    for (const [state, setup] of setups) {
      if (!PLATFORM && state !== "not-installed" && state !== "unsupported") continue;
      rmSync(join(dataDir, "addons"), { recursive: true, force: true });
      setup();
      const before = listing();
      const r = await s.rpc("add_graphic", { template: "title", durationSeconds: 1 });
      const signals = await s.take();
      const after = listing();
      check(r.status === 409 && r.body.code === CODES[state] && r.body.error === MESSAGES[state],
        `${state}: ${r.status} ${r.body.code}, the D5.3 message (${r.body.error?.slice(0, 70)})`);
      check(JSON.stringify(after) === JSON.stringify(before) && engine.jobs.list().length === 0 && engine.getProject().assets.length === 0,
        `…nothing written, no job (${JSON.stringify(after)})`);
      check(signals.length === 1 && JSON.stringify(signals[0]) === JSON.stringify({ type: "graphics-addon", state }), `…one WS message {type, state} (${JSON.stringify(signals)})`);
      const st = await s.rpc("get_state");
      const sum = await s.rpc("timeline_summary");
      check(st.body.result?.graphics === state && sum.body.result?.graphics === state, `…get_state and timeline_summary: graphics "${st.body.result?.graphics}" / "${sum.body.result?.graphics}"`);
    }
    // A render that finds the add-on broken (a key file gone meanwhile): graphics_addon_broken, and the signal.
    if (PLATFORM) {
      engine.graphicsAddon = () => resolveGraphicsAddon(dataDir);
      rmSync(join(dataDir, "addons"), { recursive: true, force: true });
      const dir = installFixture(dataDir);
      const st = await s.rpc("get_state");
      check(st.body.result?.graphics === "ready", `a complete add-on: get_state graphics "${st.body.result?.graphics}"`);
      engine.graphicRemotion = recordingRemotion(() => {
        unlinkSync(join(dir, "node_modules", "@remotion", "bundler", "package.json"));
        throw new Error("smoke: the renderer died");
      }).stub;
      const r = await s.rpc("add_graphic", { template: "title", durationSeconds: 1 });
      const signals = await s.take();
      check(r.status === 409 && r.body.code === "graphics_addon_broken" && signals.length === 1 && JSON.stringify(signals[0]) === '{"type":"graphics-addon","state":"broken"}',
        `a render that finds the add-on broken: ${r.status} ${r.body.code}, one signal (${JSON.stringify(signals)})`);
    }
    // A successful add_graphic (the dev add-on, Remotion stubbed, a real video written): no signal.
    engine.graphicsAddon = () => ({ ok: true, root: REPO });
    engine.graphicRemotion = recordingRemotion(writeVideo).stub;
    const ok = await s.rpc("add_graphic", { template: "title", durationSeconds: 1 });
    const quiet = await s.take();
    check(ok.status === 200 && !!ok.body.result?.clipId && quiet.length === 0, `a successful add_graphic: ${ok.status}, no graphics-addon message (${ok.body.error ?? JSON.stringify(quiet)})`);
  } finally {
    await s.stop();
  }
}

// MUTATION: drop `...pinned` from renderMedia's options (render.ts) → its row fails. Pass openBrowser
// only chromeMode → its row fails. Make refuseBrowserDownload return → the message row fails.
async function c4() {
  console.log("C4. the add-on's browser, everywhere Remotion could start one...");
  const work = join(root, "c4");
  const exe = join(root, "c4-browser", "chrome-headless-shell");
  const opts = (name: string) => ({ code: "export default () => null;\n", width: 64, height: 64, fps: 30, durationInFrames: 1, alpha: false, outPath: join(work, `${name}.mp4`), workDir: join(work, name) });
  const pinned = recordingRemotion();
  const e = await thrown(() => renderGraphic(opts("pinned"), { ok: true, root: REPO, browserExecutable: exe }, pinned.stub));
  const optionsOf = (name: string) => {
    const c = pinned.calls.find((x) => x.name === name);
    return (name === "openBrowser" ? c?.args[1] : c?.args[0]) as Record<string, unknown> | undefined;
  };
  for (const name of ["ensureBrowser", "openBrowser", "renderMedia"]) {
    const o = optionsOf(name);
    const download = o?.onBrowserDownload as ((options: { chromeMode: string }) => unknown) | undefined;
    const d = await thrown(() => download?.({ chromeMode: "headless-shell" }));
    check(e === null && o?.browserExecutable === exe && d?.message === BROWSER_MISSING, `${name} gets the add-on's browserExecutable and an onBrowserDownload that throws the D5.2 message (${d?.message ?? "no throw"})`);
  }
  check(optionsOf("openBrowser")?.chromeMode === "headless-shell", "openBrowser still opens the headless shell");
  const dev = recordingRemotion();
  await renderGraphic(opts("dev"), { ok: true, root: REPO }, dev.stub);
  const leaked = dev.calls.filter((c) => c.args.some((a) => a && typeof a === "object" && ("browserExecutable" in a || "onBrowserDownload" in a)));
  check(dev.calls.length === 3 && leaked.length === 0, `AIVE_REMOTION_ADDON without a browser: Remotion's own cache, nothing pinned (${leaked.map((c) => c.name).join(", ") || "none"})`);
  // Remotion itself, given a pinned browser that is gone: it fails, and never downloads.
  const remotion = await loadRemotion(REPO);
  const requests: string[] = [];
  const realFetch = globalThis.fetch;
  const realGet = [http.get, http.request, https.get, https.request];
  globalThis.fetch = (async (u: unknown) => (requests.push(String(u)), Promise.reject(new Error("smoke: no network")))) as typeof fetch;
  for (const m of [http, https]) {
    for (const k of ["get", "request"] as const) {
      (m as unknown as Record<string, unknown>)[k] = (u: unknown) => {
        requests.push(String(u));
        throw new Error("smoke: no network");
      };
    }
  }
  let downloadAsked = false;
  try {
    const r = await thrown(() => remotion.renderer.ensureBrowser({ browserExecutable: exe, onBrowserDownload: () => ((downloadAsked = true), refuseBrowserDownload()), logLevel: "error" }));
    check(r !== null && !downloadAsked && requests.length === 0, `Remotion's ensureBrowser with the add-on's (missing) browser: refused, no download asked or started (${r?.message.slice(0, 90)})`);
  } finally {
    globalThis.fetch = realFetch;
    [http.get, http.request, https.get, https.request] = realGet as [typeof http.get, typeof http.request, typeof https.get, typeof https.request];
  }
}

// MUTATION: drop the installedAt comparison from renderGraphic (render.ts) → the two "changed" rows
// pass the renderer's error on. Drop the broken branch → that row passes it on.
async function c5() {
  console.log("C5. a render whose add-on changed under it...");
  if (!PLATFORM) {
    console.log(`  skip: ${process.platform}-${process.arch} has no add-on`);
    return;
  }
  const opts = (dataDir: string) => ({ code: "export default () => null;\n", width: 64, height: 64, fps: 30, durationInFrames: 1, alpha: false, outPath: join(dataDir, "x.mp4"), workDir: join(dataDir, "motion", "x") });
  const DIED = "smoke: the renderer died";
  const cases: [string, (dir: string) => void, (e: Error | null) => boolean][] = [
    ["reinstalled (another installedAt)", (dir) => {
      const m = JSON.parse(readFileSync(join(dir, "addon.json"), "utf8")) as Record<string, unknown>;
      writeFileSync(join(dir, "addon.json"), JSON.stringify({ ...m, installedAt: "2026-10-16T09:00:00.000Z" }));
    }, (e) => e?.message === ADDON_CHANGED],
    ["removed", (dir) => rmSync(dir, { recursive: true, force: true }), (e) => e?.message === ADDON_CHANGED],
    ["broken (a key file gone)", (dir) => unlinkSync(join(dir, "node_modules", "@remotion", "renderer", "dist", "esm", "index.mjs")), (e) => e instanceof GraphicsAddonError && e.code === "graphics_addon_broken"],
    ["unchanged", () => {}, (e) => e?.message === DIED],
  ];
  for (const [what, change, ok] of cases) {
    const dataDir = freshData();
    const dir = installFixture(dataDir);
    const addon = resolveGraphicsAddon(dataDir) as ResolvedGraphicsAddon;
    const { stub } = recordingRemotion(() => {
      change(dir);
      throw new Error(DIED);
    });
    const e = await thrown(() => renderGraphic(opts(dataDir), addon, stub));
    check(addon.ok && ok(e), `the add-on ${what} while rendering: ${e?.message.slice(0, 90)}`);
  }
  const dev = recordingRemotion(() => {
    throw new Error(DIED);
  });
  const e = await thrown(() => renderGraphic(opts(freshData()), { ok: true, root: REPO }, dev.stub));
  check(e?.message === DIED, `AIVE_REMOTION_ADDON (no installed add-on): the renderer's error passes on (${e?.message})`);
}

// MUTATION: make isSourceCheckout always true (addon/resolve.ts) → the packaged rows use the
// variables. Give resolveGraphicsAddon a fallback to ZabsReel's own node_modules → the
// no-fallback row is ready.
async function c6() {
  console.log("C6. AIVE_REMOTION_ADDON and the source-checkout rule...");
  const empty = freshData();
  check(isSourceCheckout(), "this checkout is a source checkout (packages/core holds src/)");
  const dev = resolveGraphicsAddon(empty, { env: { AIVE_REMOTION_ADDON: REPO } });
  const withBrowser = resolveGraphicsAddon(empty, { env: { AIVE_REMOTION_ADDON: REPO, AIVE_REMOTION_BROWSER: "/opt/zr/chrome" } });
  check(dev.ok && dev.root === REPO && dev.browserExecutable === undefined && dev.installed === undefined && withBrowser.ok && withBrowser.browserExecutable === "/opt/zr/chrome",
    `in a source checkout AIVE_REMOTION_ADDON is the root, and AIVE_REMOTION_BROWSER its browser (${JSON.stringify(dev)})`);
  for (const bad of ["node_modules", join(root, "no-remotion")]) {
    const e = await thrown(() => resolveGraphicsAddon(empty, { env: { AIVE_REMOTION_ADDON: bad } }));
    check(!!e && /^AIVE_REMOTION_ADDON must be an absolute folder that holds node_modules\/@remotion\/renderer/.test(e.message), `AIVE_REMOTION_ADDON=${JSON.stringify(bad)} is refused (${e?.message.slice(0, 80)})`);
  }
  const none = resolveGraphicsAddon(empty, { env: {} });
  check(!none.ok && none.state === "not-installed", `no variable and no add-on: not-installed, never ZabsReel's own Remotion (${JSON.stringify(none)})`);
  check(loadRemotion.length === 1 && graphicRemotion.length === 1, "loadRemotion and graphicRemotion take a root, with no default");

  // A packaged core: its package folder has dist/ and no src/.
  const pkg = join(root, "packaged", "resources", "app", "node_modules", "@aive", "core");
  mkdirSync(join(pkg, "dist", "addon"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@aive/core" }));
  const from = join(pkg, "dist", "addon", "resolve.js");
  const env = { AIVE_REMOTION_ADDON: REPO, AIVE_REMOTION_BROWSER: "/opt/zr/chrome", AIVE_ADDON_REGISTRY: "http://127.0.0.1:5039" };
  const lines: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  let packaged: ReturnType<typeof resolveGraphicsAddon>;
  let values: (string | undefined)[];
  try {
    packaged = resolveGraphicsAddon(empty, { env, from });
    resolveGraphicsAddon(empty, { env, from });
    values = (["AIVE_REMOTION_BROWSER", "AIVE_ADDON_REGISTRY", "AIVE_ADDON_REGISTRY"] as const).map((n) => devVariable(n, { env, from }));
  } finally {
    console.error = realError;
  }
  check(!isSourceCheckout(from) && !packaged.ok && packaged.state === "not-installed" && values.every((v) => v === undefined),
    `a packaged core ignores AIVE_REMOTION_ADDON, AIVE_REMOTION_BROWSER and AIVE_ADDON_REGISTRY (${JSON.stringify(packaged)})`);
  const want = ["AIVE_REMOTION_ADDON", "AIVE_REMOTION_BROWSER", "AIVE_ADDON_REGISTRY"].map((n) => `[aive-core] ${n} is ignored: ZabsReel honours it only in a source checkout.`);
  check(JSON.stringify(lines) === JSON.stringify(want), `…one stderr line for each, once (${JSON.stringify(lines)})`);
  mkdirSync(join(pkg, "src"));
  const control = join(pkg, "dist", "x.js");
  check(isSourceCheckout(control) && devVariable("AIVE_ADDON_REGISTRY", { env, from: control }) === env.AIVE_ADDON_REGISTRY, "the same folder with src/ is a source checkout (control)");
}

// MUTATION: drop the addons area from HostTrust.areas (hosttrust.ts) → every row fails.
async function c7() {
  console.log("C7. agent tools can't open the add-on folder...");
  const dataDir = freshData();
  const engine = new EditorEngine(dataDir);
  if (PLATFORM) installFixture(dataDir);
  const AREA = /is in ZabsReel's graphics add-on folder, which tools can't open\.$/;
  const minimal = (schema: unknown): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((schema as { shape: Record<string, { isOptional(): boolean; _def: { typeName: string } }> }).shape)) {
      if (v.isOptional()) continue;
      out[k] = v._def.typeName === "ZodNumber" ? 0 : v._def.typeName === "ZodArray" ? [] : k === "text" ? "t" : "clip_none";
    }
    return out;
  };
  const link = join(root, "addons-link");
  symlinkSync(join(dataDir, "addons"), link, "dir");
  const paths = [join(graphicsAddonDir(dataDir), "x.aive"), join(dataDir, "addons", "x.aive"), join(dataDir, "addons"), join(link, "remotion", "x.aive")];
  for (const [m, ps] of Object.entries(RPC_PATH_PARAMS)) {
    for (const p of ps) {
      const key = p.replace("[]", "");
      for (const path of paths) {
        const params = { ...minimal(methods[m as keyof typeof methods].schema), [key]: p.endsWith("[]") ? [path] : path };
        if (m === "remember_projects") {
          const r = (await dispatch(engine, m, params)) as { added: unknown[]; skipped: { reason: string }[] };
          check(r.added.length === 0 && r.skipped.length === 1 && r.skipped[0].reason === "in ZabsReel's graphics add-on folder", `remember_projects skips ${path} (${JSON.stringify(r.skipped)})`);
          continue;
        }
        const e = await thrown(() => dispatch(engine, m, params));
        // The add-on folder itself exists (the fixture); nothing else may.
        const created = path !== join(dataDir, "addons") && existsSync(path);
        check(!!e && AREA.test(e.message) && !created,
          `${m}.${p} of ${path.replace(root, "<tmp>")}: refused with the add-on folder message, nothing created (${e?.message.slice(-90)})`);
      }
    }
  }
  check(!PLATFORM || readGraphicsAddon(dataDir).state === "ready", "the core itself still reads the add-on (gatedfs stays trust-only)");
}

async function main() {
  try {
    p1();
    p2();
    p3();
    p4();
    c1();
    await c2c3();
    await c4();
    await c5();
    await c6();
    await c7();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nALL ADD-ON CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
});
