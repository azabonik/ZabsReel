/**
 * The graphics add-on (ADDON-PLAN D8.1): the pin, how the core finds and
 * refuses Remotion, and the installer the UI hosts run.
 *
 * The pin (scripts/gen-graphics-lock.mjs):
 *  P1. the real lock — --check --require-sizes passes; closure 212, platform
 *                      lists 166 / 166 / 166 / 168 (both linux-x64
 *                      compositors), add-on-only 193 (the 18 shared packages
 *                      and semver@7.8.4 left out), the headless-shell table
 *                      and the tarball total for every platform.
 *  P2. the walk      — on a fixture lock shaped like F3, each platform gets
 *                      npm's set: the wasm32-only subtree is skipped, both
 *                      linux-x64 compositors are kept; the closure has all.
 *  P3. --check fails — a walk that skips a non-optional entry; a resolved off
 *                      registry.npmjs.org; remotion not REMOTION_VERSION;
 *                      Remotion's TESTED_VERSION not the table's; the file out
 *                      of sync. A CRLF copy of the file (a Windows checkout)
 *                      passes; a changed one in CRLF still fails.
 *  P4. add-on-only   — an add-on path (a/node_modules/semver) with the
 *                      name@version of a production path (b/node_modules/semver)
 *                      is left out of the list.
 *  P5. the lock hash — covers the headless-shell table: another zip sha256
 *                      gives another ADDON_LOCK_SHA256 (installed add-ons
 *                      become update-needed).
 *  P6. sizes         — --check --require-sizes fails while a platform's
 *                      tarball total is unknown, and passes once every size
 *                      is in the data file.
 *  P7. drift guard   — after a fixture lock change --check fails, listing the
 *                      changed, added and removed entries and each platform's
 *                      download with reuse; --accept-addon-change records the
 *                      new fingerprint and --check passes; --check
 *                      --accept-addon-change is refused and records nothing;
 *                      the repository accepts this build's fingerprint.
 *  P8. --browser     — a write fills the headless-shell table from a folder
 *                      of zips; --check --browser passes on them, and names a
 *                      changed zip's sha256 and entry count, a zip with a
 *                      symlink, and a missing zip. A write whose pin then
 *                      fails writes neither file.
 * The core:
 *  C1. states        — readGraphicsAddon on fixture folders: ready; no or
 *                      unparsable addon.json: not-installed; lock hash,
 *                      version, platform, schema, or only another version's
 *                      folder: update-needed; each missing key file, and a
 *                      browserExecutable with "..", absolute, or a link out of
 *                      browser/, or a browser/ that links out of the add-on
 *                      folder: broken; another platform: unsupported.
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
 *                      nothing. With Remotion's own ensureBrowser queue, a
 *                      browser gone before ensureBrowser or before openBrowser
 *                      fails that render with the D5.2 message, and the next
 *                      render, browser back, succeeds.
 *  C5. failures      — a render whose add-on got another installedAt, or was
 *                      removed, fails with "changed while this graphic
 *                      rendered"; one whose add-on lost a key file with
 *                      graphics_addon_broken; any other failure passes on.
 *  C6. resolution    — AIVE_REMOTION_ADDON (and AIVE_REMOTION_BROWSER) in a
 *                      source checkout; in a packaged core folder (no src/)
 *                      the three variables are ignored, one stderr line each;
 *                      no fallback to ZabsReel's own Remotion; a malformed
 *                      AIVE_REMOTION_ADDON leaves get_state and
 *                      timeline_summary answering ("broken"), and add_graphic
 *                      gives the variable's message.
 *  C7. private area  — every writer and reader of RPC_PATH_PARAMS refuses a
 *                      path under <dataDir>/addons with the D5.4 message and
 *                      creates nothing; a link from outside into it too;
 *                      remember_projects skips it; a project whose asset,
 *                      cutout colour, LUT or font path is in the add-on folder
 *                      does not load, with the add-on folder's message.
 * The installer (addon/install.ts; fixture tarballs and zips written here,
 * served by a loopback registry on port 5031 through AIVE_ADDON_REGISTRY):
 *  I1. an install    — ready; addon.json's fields; exactly the platform's
 *                      tarballs and zip fetched (not another platform's);
 *                      bytes and execute bits, a `bin` target made executable;
 *                      no add-on code or install script ran; nothing written
 *                      outside <dataDir>/addons; progress in pinned bytes.
 *  I2. the licence   — another hash is refused before anything is fetched; the
 *                      terms are Remotion's LICENSE.md and the notice.
 *  I3. pinned bytes  — another tarball, changed zip bytes, an endless body (the
 *                      size cap): "corrupted", nothing activated, and no byte
 *                      of them reached an extractor.
 *  I4. tar entries   — "..", absolute, backslash, drive, symlink, hard link,
 *                      device, FIFO, pax and GNU long names with "..": refused;
 *                      pax and long names read; in an install, the message,
 *                      for a package and for the browser zip.
 *  I5. the registry  — AIVE_ADDON_REGISTRY other than http loopback with a port
 *                      is refused before any fetch; a packaged core ignores it,
 *                      and refuses the installer's test seams.
 *  I6. the lock      — a live lock refuses install, Remove and recovery; a dead
 *                      pid's lock, or a live unrelated pid's 3-minute-old one,
 *                      is taken over, but not a fresh lock another host wrote
 *                      after this one read the stale one; the heartbeat
 *                      rewrites it.
 *  I7. cancel, kill  — a cancel before or during the download leaves nothing; a
 *                      process killed before addon.json leaves "not installed",
 *                      and recovery or the next install cleans its staging.
 *  I8. activation    — a first rename busy past the retry window keeps the old
 *                      copy; a failed second rename puts it back; win32 retries,
 *                      elsewhere not; recovery restores one ready .old-*, never
 *                      two, never a .removed-*.
 *  I9. versions, Remove — 4.0.480 goes after activation and with Remove; a
 *                      busy Remove changes nothing; Remove of nothing creates
 *                      nothing.
 *  I10. the guard    — a renderer whose text the load-time rewrite doesn't know
 *                      is never activated.
 *  I11. messages     — 500, a closed socket, a timeout, nothing listening,
 *                      ENOSPC and ENAMETOOLONG (also while taking the lock,
 *                      for an install and for Remove) give the D3.8 messages;
 *                      a cancel while a download is failing gives "cancelled".
 *  I12. names        — Windows device names, trailing dots and spaces, refused
 *                      characters and case collisions refused for win32-x64,
 *                      case and Unicode-form collisions for darwin; written for
 *                      linux-x64.
 *  I13. reuse        — an update after a one-package change fetches only it,
 *                      a nested package's change too (its parent is reused
 *                      around it); a tampered or incomplete source package is fetched
 *                      again; a pin move reuses from another version's folder;
 *                      a failed activation leaves the source byte-identical;
 *                      a reused package's names count in the win32 collision
 *                      check.
 *  I14. no route     — only addon/index.ts imports or names the installer, and no RPC
 *                      method (so no MCP tool) installs, removes or recovers;
 *                      the MCP instructions, SKILL.md and add_graphic's
 *                      description tell the agent to ask the user instead.
 *  Z1. the zip reader — stored, deflate and empty entries, Unix execute bits;
 *                      zip64 (end record, locator, extra field), encryption,
 *                      another method, symlink, FIFO, "..", absolute, drive,
 *                      backslash and a wrong CRC-32 refused.
 *
 * No network: loopback on ports 5030 and 5031 (5039 must be free: I11's
 * "nothing listens"), fixture locks, and Remotion stubbed except in C4's last
 * rows (which start no browser). FFmpeg makes C3's video.
 * Run: npx tsx packages/core/scripts/smoke-addon.ts
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import type { RenderInternals } from "@remotion/renderer";
import { readGraphicsAddon, addonPlatform, graphicsAddonDir, platformLabel } from "../src/addon/state.js";
import { addonInstallerForTests, GraphicsAddonInstallError, type AddonSeams, type InstallFailure, type InstallOptions, type InstallProgress } from "../src/addon/install.js";
import { NameSet } from "../src/addon/names.js";
import { ArchiveRefusal, extractTarball } from "../src/addon/tar.js";
import { graphicsAddonTerms } from "../src/addon/terms.js";
import { extractZip } from "../src/addon/zip.js";
import { devVariable, GraphicsAddonError, isSourceCheckout, resolveGraphicsAddon, type ResolvedGraphicsAddon } from "../src/addon/resolve.js";
import { EditorEngine } from "../src/engine.js";
import { EditorServer } from "../src/server.js";
import { dispatch, methods, RPC_PATH_PARAMS } from "../src/rpc.js";
import { FFMPEG_BIN } from "../src/ffmpeg/executor.js";
import { ADDON_CLOSURE, ADDON_LOCK_SHA256, ADDON_ONLY, ADDON_PLATFORM_LISTS, ADDON_PLATFORMS, ADDON_REMOTION_VERSION, HEADLESS_SHELL, type AddonPlatform } from "../src/motion/addonlock.js";
import { loadRemotion } from "../src/motion/remotionload.js";
import { ADDON_CHANGED, graphicRemotion, refuseBrowserDownload, renderGraphic, type GraphicRemotion } from "../src/motion/render.js";
import { basePkgs, buildPin, CFT_EXE, fixtureRegistry, fixtureZip, makeTar, makeZip, pkgJson, RAN, reg, sha256hex, type Fixture, type TarIn, type ZipIn } from "./addon-fixture.js";

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

/** Every engine the C rows make: their storage heartbeats (run/core-*.json, every 30 s) stop before the installer rows record fs calls. */
const engines: EditorEngine[] = [];
const newEngine = (dataDir: string) => {
  const e = new EditorEngine(dataDir);
  engines.push(e);
  return e;
};

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
// Write the pin without the win32 and darwin tarball sizes (slice 1's data file) → the --require-sizes and totals rows fail.
function p1() {
  console.log("P1. the real lock...");
  const r = spawnSync(process.execPath, [GEN, "--check", "--require-sizes"], { encoding: "utf8", cwd: REPO });
  check(r.status === 0, `gen-graphics-lock.mjs --check --require-sizes passes (${`${r.stdout}${r.stderr}`.trim().split("\n").pop()})`);
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
    && /^[0-9a-f]{64}$/.test(ADDON_LOCK_SHA256) && ADDON_PLATFORMS.every((p) => ADDON_PLATFORM_LISTS[p].bytes !== null),
    `a Chrome for Testing ${HEADLESS_SHELL.version} zip with its sha256 for every platform; tarball totals ${ADDON_PLATFORMS.map((p) => `${p} ${ADDON_PLATFORM_LISTS[p].bytes}`).join(", ")} bytes`);
}

// MUTATION: make matches() (gen-graphics-lock.mjs) ignore cpu → the wasm32 subtree is in every list and P2 fails.
function p2() {
  console.log("P2. the walk on a fixture lock shaped like F3...");
  const dir = fixtureRoot("p2");
  // The fixture's own fingerprint is accepted with the write (the drift guard, P7).
  const w = gen(dir, "--accept-addon-change");
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
  // A Windows checkout (core.autocrlf, the release job): the same file with CRLF line endings.
  const crlf = fixtureRoot("p3-crlf");
  gen(crlf, "--accept-addon-change");
  const out = join(crlf, "packages/core/src/motion/addonlock.ts");
  const lf = readFileSync(out, "utf8");
  writeFileSync(out, lf.replace(/\n/g, "\r\n"));
  const same = gen(crlf, "--check");
  check(lf.includes("\n") && same.status === 0, `the written file with CRLF line endings passes --check (${same.out.trim().split("\n")[0]})`);
  writeFileSync(out, lf.replace("node_modules/a", "node_modules/z").replace(/\n/g, "\r\n"));
  const changed = gen(crlf, "--check");
  check(lf.includes("node_modules/a") && changed.status === 1 && /addonlock\.ts is out of sync/.test(changed.out), `a changed file with CRLF line endings still fails --check (${changed.out.trim().split("\n")[0]})`);
}

// MUTATION: let the production walk ship nothing (gen-graphics-lock.mjs `shipped`) → semver@7.8.4 is in the list.
function p4() {
  console.log("P4. the add-on-only list is name@version...");
  const j = gen(fixtureRoot("p4"), "--json").json as { addonOnly: string[] } | undefined;
  const list = j?.addonOnly ?? [];
  check(!list.includes("semver@7.8.4") && !list.includes("react@18.3.1") && list.includes("a@1.0.0") && list.includes("@remotion/renderer@4.0.481"),
    `a/node_modules/semver has b/node_modules/semver's name@version: left out, with react; a and Remotion are in (${JSON.stringify(list)})`);
}

// MUTATION: drop headlessShell from the lockSha256 input (gen-graphics-lock.mjs) → the hash does not change.
function p5() {
  console.log("P5. the lock hash covers the headless-shell table...");
  const dir = fixtureRoot("p5");
  const hash = () => (gen(dir, "--json").json as { lockSha256?: string } | undefined)?.lockSha256;
  const before = hash();
  const again = hash();
  const dataFile = join(dir, "scripts", "graphics-lock-data.json");
  const data = JSON.parse(readFileSync(dataFile, "utf8")) as { headlessShell: { platforms: Record<string, { sha256: string }> } };
  data.headlessShell.platforms["win32-x64"].sha256 = "0".repeat(64);
  writeFileSync(dataFile, JSON.stringify(data));
  const after = hash();
  check(!!before && before === again && !!after && after !== before, `another win32-x64 zip sha256 gives another lock hash (${before?.slice(0, 12)} → ${after?.slice(0, 12)})`);
}

// MUTATION: drop the --require-sizes problems (gen-graphics-lock.mjs) → the unknown-total row passes.
function p6() {
  console.log("P6. --require-sizes and the platform totals...");
  const dir = fixtureRoot("p6");
  gen(dir, "--accept-addon-change");
  const plain = gen(dir, "--check");
  const strict = gen(dir, "--check", "--require-sizes");
  check(plain.status === 0 && strict.status === 1 && ADDON_PLATFORMS.every((p) => new RegExp(`^${p}: the tarball total is unknown \\(\\d+ of \\d+ sizes missing\\)`, "m").test(strict.out)),
    `no sizes known: --check passes, --check --require-sizes names every platform (${strict.out.trim().split("\n")[0]})`);
  const j = gen(dir, "--json").json as { closure: { integrity: string }[] } | undefined;
  const dataFile = join(dir, "scripts", "graphics-lock-data.json");
  const data = JSON.parse(readFileSync(dataFile, "utf8")) as { tarballBytes: Record<string, number> };
  data.tarballBytes = Object.fromEntries((j?.closure ?? []).map((e) => [e.integrity, 1000]));
  writeFileSync(dataFile, JSON.stringify(data));
  gen(dir);
  const sized = gen(dir, "--check", "--require-sizes");
  const totals = (gen(dir, "--json").json as { platforms: Record<string, { bytes: number | null; count: number }> } | undefined)?.platforms;
  check(sized.status === 0 && ADDON_PLATFORMS.every((p) => totals?.[p]?.bytes === (totals?.[p]?.count ?? -1) * 1000),
    `every size in the data file: --require-sizes passes, each total is the sum (${sized.out.trim().split("\n").pop()})`);
}

// MUTATION: drop drift() from --check (gen-graphics-lock.mjs) → the changed-lock row passes --check. Drop the
// "added" lines from drift() → the listing row fails. Count every package as downloaded (ignore `kept`) →
// the per-platform download row fails. Let --accept-addon-change leave `accepted` as it was → the accept row fails.
// Drop the --check --accept-addon-change refusal → the refusal row passes the drift guard (exit 0).
function p7() {
  console.log("P7. the drift guard...");
  const dir = fixtureRoot("p7");
  const first = gen(dir, "--accept-addon-change");
  const accepted = gen(dir, "--check");
  check(first.status === 0 && /fingerprint [0-9a-f]{12}… accepted/.test(first.out) && accepted.status === 0, `a written and accepted fixture pin passes --check (${accepted.out.trim().split("\n").pop()})`);
  // a@1.0.0 → 1.0.1, a new package c (linux-x64 only: os/cpu), @emnapi/core gone.
  const lock = fixtureLock();
  lock.packages["node_modules/a"] = entry("node_modules/a", "1.0.1", { dependencies: { semver: "^7.0.0" }, optionalDependencies: { c: "1.0.0" } });
  lock.packages["node_modules/c"] = entry("node_modules/c", "1.0.0", { ...OPT, ...os("linux", "x64") });
  delete lock.packages["node_modules/@emnapi/core"];
  delete lock.packages["node_modules/@napi-rs/wasm-runtime"].dependencies;
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock));
  const wrote = gen(dir);
  const c = gen(dir, "--check");
  check(wrote.status === 0 && /the fingerprint is not accepted/.test(wrote.out) && c.status === 1 && /^the graphics add-on's fingerprint changed \(accepted [0-9a-f]{12}…, now [0-9a-f]{12}…\): every user has to update the add-on/m.test(c.out),
    `a lock change after the accept: the write says it is not accepted, --check fails (${c.out.trim().split("\n")[0].slice(0, 120)})`);
  check(/^ {2}changed node_modules\/a: 1\.0\.0 → 1\.0\.1$/m.test(c.out) && /^ {2}added node_modules\/c@1\.0\.0$/m.test(c.out) && /^ {2}removed node_modules\/@emnapi\/core@1\.0\.0$/m.test(c.out) && !/addonlock\.ts is out of sync/.test(c.out),
    `--check lists the changed, added and removed entries (${JSON.stringify(c.out.split("\n").filter((l) => /^ {2}(changed|added|removed)/.test(l)))})`);
  check(/^ {2}linux-x64: the update downloads 0\.0 MB \(2 of 14 packages, some sizes unknown\); the browser is reused$/m.test(c.out) && /^ {2}win32-x64: the update downloads 0\.0 MB \(1 of 11 packages, some sizes unknown\); the browser is reused$/m.test(c.out),
    `--check gives each platform's download with reuse (${JSON.stringify(c.out.split("\n").filter((l) => /^ {2}(linux|win32)-x64:/.test(l)))})`);
  // --check writes nothing, so --check --accept-addon-change is refused rather than reported as accepted.
  const dataPath = join(dir, "scripts", "graphics-lock-data.json");
  const dataBefore = readFileSync(dataPath);
  const both = gen(dir, "--check", "--accept-addon-change");
  check(both.status === 2 && /--accept-addon-change writes the data file; run it without --check/.test(both.out) && !/accepted/.test(both.out.replace(/accept-addon-change/g, "")) && readFileSync(dataPath).equals(dataBefore) && gen(dir, "--check").status === 1,
    `--check --accept-addon-change on an unaccepted pin exits 2, records nothing, and --check still fails (${both.status}: ${both.out.trim().split("\n").pop()})`);
  const acc = gen(dir, "--accept-addon-change");
  const after = gen(dir, "--check");
  const data = JSON.parse(readFileSync(join(dir, "scripts", "graphics-lock-data.json"), "utf8")) as { accepted?: { closure: string[] } };
  check(acc.status === 0 && after.status === 0 && !!data.accepted?.closure.some((x) => x.startsWith("node_modules/a@1.0.1@sha512-")) && !data.accepted.closure.some((x) => x.startsWith("node_modules/@emnapi/core@")),
    `--accept-addon-change records the new fingerprint and closure; --check passes (${after.out.trim().split("\n").pop()})`);
  // The real pin: today's fingerprint is the accepted one.
  const real = JSON.parse(readFileSync(join(REPO, "scripts", "graphics-lock-data.json"), "utf8")) as { accepted?: { lockSha256: string; closure: string[] } };
  check(real.accepted?.lockSha256 === ADDON_LOCK_SHA256 && real.accepted.closure.length === ADDON_CLOSURE.length, `the repository's data file accepts this build's fingerprint ${ADDON_LOCK_SHA256.slice(0, 12)}…`);
}

// MUTATION: compare only the sha256 in --browser's check (gen-graphics-lock.mjs) → the entries row passes.
// Drop the symlink problem from zipListing → the symlink row passes.
function p8() {
  console.log("P8. --browser: the headless-shell table against a folder of zips...");
  const dir = fixtureRoot("p8");
  const zips = join(dir, "zips");
  mkdirSync(zips);
  const cft = { "win32-x64": "win64", "darwin-x64": "mac-x64", "darwin-arm64": "mac-arm64", "linux-x64": "linux64" } as const;
  const put = (p: AddonPlatform, extra: ZipIn[] = []) => {
    const c = cft[p];
    const exe = `chrome-headless-shell-${c}/chrome-headless-shell${p === "win32-x64" ? ".exe" : ""}`;
    writeFileSync(join(zips, `chrome-headless-shell-${c}.zip`), makeZip([{ name: `chrome-headless-shell-${c}/` }, { name: exe, data: `exe ${p}`, mode: 0o100755 }, ...extra]));
  };
  for (const p of ADDON_PLATFORMS) put(p);
  const filled = gen(dir, "--browser", "--zips", zips, "--accept-addon-change");
  const table = (JSON.parse(readFileSync(join(dir, "scripts", "graphics-lock-data.json"), "utf8")) as { headlessShell: { platforms: Record<string, { sha256: string; entries: number; url: string; size: number }> } }).headlessShell.platforms;
  const linux = readFileSync(join(zips, "chrome-headless-shell-linux64.zip"));
  check(filled.status === 0 && table["linux-x64"].sha256 === createHash("sha256").update(linux).digest("hex") && table["linux-x64"].size === linux.length && table["linux-x64"].entries === 2
    && table["linux-x64"].url === `https://storage.googleapis.com/chrome-for-testing-public/${HEADLESS_SHELL.version}/linux64/chrome-headless-shell-linux64.zip`,
    `a write with --browser fills the table from the zips (${filled.out.trim().split("\n").pop()})`);
  check(gen(dir, "--check", "--browser", "--zips", zips).status === 0, "--check --browser passes on the zips it was filled from");
  // A write with another zip whose pin then fails (remotionload.ts guards another version) writes neither
  // file: the data file keeps its old table.
  const files = [join(dir, "scripts", "graphics-lock-data.json"), join(dir, "packages", "core", "src", "motion", "addonlock.ts")];
  const before = files.map((f) => readFileSync(f, "utf8"));
  const loadTs = join(dir, "packages", "core", "src", "motion", "remotionload.ts");
  writeFileSync(loadTs, 'export const REMOTION_VERSION = "4.0.480";\n');
  put("linux-x64", [{ name: "chrome-headless-shell-linux64/extra.txt", data: "x" }]);
  const refused = gen(dir, "--browser", "--zips", zips);
  check(refused.status === 1 && /nothing written/.test(refused.out) && files.every((f, i) => readFileSync(f, "utf8") === before[i]),
    `a --browser write whose pin fails changes neither the data file nor addonlock.ts (${refused.out.trim().split("\n").pop()})`);
  writeFileSync(loadTs, 'export const REMOTION_VERSION = "4.0.481";\n');
  put("linux-x64");
  put("darwin-arm64", [{ name: "chrome-headless-shell-mac-arm64/extra.txt", data: "x" }]);
  const changed = gen(dir, "--check", "--browser", "--zips", zips);
  check(changed.status === 1 && /^darwin-arm64: the headless-shell table's sha256 is "[0-9a-f]{64}", and the zip in .* gives "[0-9a-f]{64}"$/m.test(changed.out) && /^darwin-arm64: the headless-shell table's entries is 2, and the zip in .* gives 3$/m.test(changed.out),
    `another zip: --check --browser names its sha256 and entry count (${changed.out.trim().split("\n")[0].slice(0, 100)})`);
  put("darwin-arm64", [{ name: "chrome-headless-shell-mac-arm64/link", data: "chrome-headless-shell", mode: 0o120777 }]);
  const linked = gen(dir, "--check", "--browser", "--zips", zips);
  check(linked.status === 1 && /^darwin-arm64: .*chrome-headless-shell-mac-arm64\.zip: chrome-headless-shell-mac-arm64\/link: a symlink, which the add-on's zip reader refuses$/m.test(linked.out),
    `a zip with a symlink: --check --browser says the zip reader refuses it (${linked.out.trim().split("\n")[0].slice(0, 120)})`);
  rmSync(join(zips, "chrome-headless-shell-win64.zip"));
  const gone = gen(dir, "--check", "--browser", "--zips", zips);
  check(gone.status === 1 && /^win32-x64: .*chrome-headless-shell-win64\.zip is missing \(download https:\/\/storage\.googleapis\.com\/.* there first\)$/m.test(gone.out), "a zip missing: --check --browser says which one to download");
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
  // browser/ itself a link to a folder outside the add-on, the executable inside that folder.
  const linked = freshData();
  const la = installFixture(linked);
  const outsideBrowser = join(root, "outside-browser");
  const exeRel = HEADLESS_SHELL.platforms[PLATFORM].executable;
  mkdirSync(dirname(join(outsideBrowser, exeRel)), { recursive: true });
  writeFileSync(join(outsideBrowser, exeRel), "");
  rmSync(join(la, "browser"), { recursive: true, force: true });
  symlinkSync(outsideBrowser, join(la, "browser"), "dir");
  check(existsSync(join(la, "browser", exeRel)) && state(linked) === "broken", `a browser/ that links out of the add-on folder: broken (${state(linked)})`);
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
  const engine = newEngine(dataDir);
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
  mkdirSync(dirname(exe), { recursive: true });
  writeFileSync(exe, "");
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
  unlinkSync(exe);
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
    await c4Queue(exe, requests);
  } finally {
    globalThis.fetch = realFetch;
    [http.get, http.request, https.get, https.request] = realGet as [typeof http.get, typeof http.request, typeof https.get, typeof https.request];
  }
}

/**
 * Remotion queues every ensureBrowser (openBrowser's own included) behind the one before, and
 * once one fails every later call gets that failure: renderGraphic must never hand Remotion a
 * browser that is gone. A fresh copy of the renderer (so the row above's failure is not in its
 * queue) answers ensureBrowser, and openBrowser goes through the same queue first, as Remotion's
 * does. `exe` is missing on entry.
 */
// MUTATION: drop pinnedBrowserPresent before ensureBrowser (render.ts) → the first render fails
// with Remotion's message and the second with the same. Drop it before openBrowser → the third
// and fourth do.
async function c4Queue(exe: string, requests: string[]) {
  const esm = join(REPO, "node_modules", "@remotion", "renderer", "dist", "esm", "index.mjs");
  const fresh = (await import(`${pathToFileURL(esm).href}?c4-queue`)) as typeof import("@remotion/renderer");
  const work = join(root, "c4-queue");
  const opts = (name: string) => ({ code: "export default () => null;\n", width: 64, height: 64, fps: 30, durationInFrames: 1, alpha: false, outPath: join(work, `${name}.mp4`), workDir: join(work, name) });
  let goneAfterEnsure = false;
  const q = recordingRemotion();
  const open = q.stub.openBrowser;
  q.stub.ensureBrowser = (async (o: Record<string, unknown>) => {
    const status = await fresh.ensureBrowser({ ...o, logLevel: "error" });
    if (goneAfterEnsure) unlinkSync(exe);
    return status;
  }) as unknown as GraphicRemotion["ensureBrowser"];
  q.stub.openBrowser = (async (b: "chrome", o: Record<string, unknown>) => {
    await fresh.ensureBrowser({ browserExecutable: o.browserExecutable as string, onBrowserDownload: o.onBrowserDownload as never, logLevel: "error" });
    return open(b, o as never);
  }) as unknown as GraphicRemotion["openBrowser"];
  const render = (name: string) => thrown(() => renderGraphic(opts(name), { ok: true, root: REPO, browserExecutable: exe }, q.stub));
  const e1 = await render("gone");
  check(e1?.message === BROWSER_MISSING, `a render whose browser is gone before ensureBrowser fails with the D5.2 message (${e1?.message.slice(0, 90)})`);
  writeFileSync(exe, "");
  const e2 = await render("back");
  check(e2 === null, `the next render, the browser back, succeeds (${e2?.message.slice(0, 90) ?? "ok"})`);
  goneAfterEnsure = true;
  const e3 = await render("gone-before-open");
  goneAfterEnsure = false;
  check(e3?.message === BROWSER_MISSING, `a render whose browser goes between ensureBrowser and openBrowser fails with the D5.2 message (${e3?.message.slice(0, 90)})`);
  writeFileSync(exe, "");
  const e4 = await render("back-again");
  check(e4 === null && requests.length === 0, `the next render, the browser back, succeeds; no network (${e4?.message.slice(0, 90) ?? "ok"}; ${requests.length} request(s))`);
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
  // MUTATION: drop the catch in EditorEngine.graphicsState → get_state and timeline_summary throw.
  // A typo in the variable takes away add_graphic only; the state tools still answer.
  const engine = newEngine(freshData());
  process.env.AIVE_REMOTION_ADDON = "node_modules";
  try {
    const answers: unknown[] = [];
    for (const m of ["get_state", "timeline_summary"]) {
      const e = await thrown(async () => answers.push(((await dispatch(engine, m, {})) as { graphics?: unknown }).graphics));
      if (e) answers.push(`${m} threw: ${e.message.slice(0, 60)}`);
    }
    check(JSON.stringify(answers) === '["broken","broken"]', `a malformed AIVE_REMOTION_ADDON: get_state and timeline_summary still answer, graphics "broken" (${JSON.stringify(answers)})`);
    const g = await thrown(() => dispatch(engine, "add_graphic", { template: "title", durationSeconds: 1 }));
    check(!!g && /^AIVE_REMOTION_ADDON must be an absolute folder that holds node_modules\/@remotion\/renderer \(it is "node_modules"\)\.$/.test(g.message) && engine.jobs.list().length === 0,
      `…and add_graphic gives the variable's message, no job (${g?.message.slice(0, 80)})`);
  } finally {
    delete process.env.AIVE_REMOTION_ADDON;
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
  const engine = newEngine(dataDir);
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

  // MUTATION: name the trust area in checkLoadedProject's message (hosttrust.ts) → these rows fail.
  // A project file outside the data folder whose fields are in the add-on folder.
  const inAddon = (f: string) => join(graphicsAddonDir(dataDir), f);
  const projectWith = (name: string, asset: Record<string, unknown>, clip: Record<string, unknown> = {}) => {
    const f = join(root, `c7-${name}.aive`);
    writeFileSync(f, JSON.stringify({
      assets: [{ id: "asset_a1", path: "/x/a.mp4", name: "a", duration: 1, width: 64, height: 64, fps: 30, hasVideo: true, hasAudio: false, addedAt: 0, ...asset }],
      tracks: [{ id: "track_v", kind: "video", index: 0, clips: [{ id: "clip_c1", assetId: "asset_a1", startFrame: 0, sourceInFrame: 0, sourceOutFrame: 10, ...clip }] }],
    }));
    return f;
  };
  const fields: [string, string, string][] = [
    ["asset path", projectWith("asset", { path: inAddon("browser/a.mp4") }), 'asset "asset_a1" path'],
    ["cutout colour path", projectWith("cutout", { cutout: { colorPath: inAddon("c.mp4"), colorStart: 0 } }), 'asset "asset_a1" cutout colour path'],
    ["clip LUT", projectWith("lut", {}, { effects: { lut: inAddon("x.cube") } }), 'clip "clip_c1" LUT path'],
    ["overlay font", projectWith("font", {}, { overlays: [{ id: "text_t1", text: "t", font: inAddon("f.ttf") }] }), 'clip "clip_c1" text "text_t1" font'],
    ["caption font", projectWith("caption", {}, { captions: { cues: [], style: { font: inAddon("f.ttf") } } }), 'clip "clip_c1" caption font'],
  ];
  const before = JSON.stringify(engine.getProject());
  for (const [what, file, field] of fields) {
    const e = await thrown(() => dispatch(engine, "load_project", { path: file }));
    const msg = e?.message ?? "";
    check(msg.startsWith(`${field} `) && / is in ZabsReel's graphics add-on folder, which tools can't open\. Change this path in the project file and open the project again\.$/.test(msg)
      && JSON.stringify(engine.getProject()) === before && engine.getCurrentPath() === undefined,
      `a project whose ${what} is in the add-on folder does not load, with the add-on folder's message (${msg.slice(-120)})`);
  }
}

// ---- I: the installer ----------------------------------------------------------------

// The fixture registry (loopback, port 5031): addon-fixture.ts.
const REG_PORT = 5031;
const registry = fixtureRegistry(REG_PORT);
const REGISTRY = registry.url;
const { served, hits, answers, publish, hitPaths } = registry;
const startRegistry = registry.start;
const stopRegistry = registry.stop;

/** Every fs call of the installer's kinds while `recording`, and an optional fault to inject (gatedfs looks the functions up per call). */
const fsCalls: string[] = [];
let recording = false;
let fault: ((name: string, path: string) => NodeJS.ErrnoException | null) | null = null;
/** Runs after each fs/promises readFile returns (I6's lock race). */
let afterRead: ((path: string) => void) | null = null;
{
  const fsp = createRequire(import.meta.url)("node:fs/promises") as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const rf = fsp.readFile;
  fsp.readFile = async (...args: unknown[]) => {
    const got = await rf(...args);
    afterRead?.(String(args[0]));
    return got;
  };
  for (const name of ["writeFile", "rename", "open", "mkdir", "link", "copyFile", "chmod", "rm"]) {
    const real = fsp[name];
    fsp[name] = async (...args: unknown[]) => {
      const p = String(args[0]);
      if (recording) fsCalls.push(`${name} ${p}${name === "rename" || name === "link" || name === "copyFile" ? ` ${String(args[1])}` : ""}`);
      const e = fault?.(name, p);
      if (e) throw e;
      return real(...args);
    };
  }
  const fsc = createRequire(import.meta.url)("node:fs") as Record<string, (...a: unknown[]) => unknown>;
  const cws = fsc.createWriteStream;
  fsc.createWriteStream = (...args: unknown[]) => {
    if (recording) fsCalls.push(`createWriteStream ${String(args[0])}`);
    return cws(...args);
  };
  syncBuiltinESMExports();
}
const errno = (code: string) => Object.assign(new Error(`${code}: injected`), { code }) as NodeJS.ErrnoException;

const T = addonInstallerForTests;
const LICENSE = PLATFORM ? graphicsAddonTerms(PLATFORM).sha256 : "";
const POSTINSTALL = join(root, "postinstall-ran");

/** Install `f` into `dataDir` from the fixture registry; the result or the error. */
async function fixtureInstall(dataDir: string, f: Fixture, s: AddonSeams = {}, opts: Partial<InstallOptions> = {}) {
  publish(f);
  const progress: InstallProgress[] = [];
  try {
    const got = await T.install(dataDir, { fetch: globalThis.fetch, acceptedLicenseSha256: LICENSE, via: "web", onProgress: (p) => progress.push(p), ...opts }, { pin: f.pin, env: { AIVE_ADDON_REGISTRY: REGISTRY }, ...s });
    return { got, err: null, progress };
  } catch (err) {
    return { got: null, err: err as GraphicsAddonInstallError, progress };
  }
}
const addonsListing = (dataDir: string) => (existsSync(join(dataDir, "addons")) ? readdirSync(join(dataDir, "addons")).sort() : []);
/** The live addon.json, or {} when there is none (a row then fails instead of throwing). */
const manifestOf = (dataDir: string): Record<string, any> => {
  try {
    return JSON.parse(readFileSync(join(graphicsAddonDir(dataDir), "addon.json"), "utf8")) as Record<string, any>;
  } catch {
    return {};
  }
};
/** The add-on's own folder left exactly as it was: addons/ holds only remotion (no lock, staging, .old-*, .removed-*). */
const clean = (dataDir: string) => JSON.stringify(addonsListing(dataDir)) === JSON.stringify(existsSync(join(dataDir, "addons", "remotion")) ? ["remotion"] : []);
/** Every file below `dir` with its bytes' hash (to see a copy left exactly as it was). */
const treeHash = (dir: string): string => {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = lstatSync(p);
      h.update(`${p.slice(dir.length)} ${st.mode & 0o777}\n`);
      if (st.isDirectory()) walk(p);
      else h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
};

// MUTATION: fetch every closure entry instead of the platform's list (install.ts stage) → the other-platform
// row fails. Drop markBins → the bin row fails. Import the staged renderer before activation → the
// no-add-on-code row fails. Write addon.json before the packages → I7's kill row finds it ready.
async function i1() {
  console.log("I1. a fixture install...");
  const dataDir = freshData();
  const f = buildPin(basePkgs(POSTINSTALL));
  hits.clear();
  recording = true;
  fsCalls.length = 0;
  const { got, err, progress } = await fixtureInstall(dataDir, f);
  recording = false;
  const dir = graphicsAddonDir(dataDir);
  const list = f.pin.lists[PLATFORM!];
  const m = existsSync(join(dir, "addon.json")) ? manifestOf(dataDir) : {};
  check(!err && got?.state === "ready" && readGraphicsAddon(dataDir, { pin: f.pin }).state === "ready", `the add-on is ready (${got?.state ?? err?.message})`);
  check(m.schema === 1 && m.remotion === ADDON_REMOTION_VERSION && m.lockSha256 === f.pin.lockSha256 && m.platform === PLATFORM && m.browserExecutable === CFT_EXE(PLATFORM!)
    && m.licenseSha256 === LICENSE && m.via === "web" && Date.parse(m.acceptedAt) <= Date.parse(m.installedAt)
    && JSON.stringify(Object.keys(m.entries ?? {}).sort()) === JSON.stringify(list.paths) && list.paths.every((p) => m.entries[p].integrity === f.pin.closure.find((e) => e.path === p)!.integrity && /^[0-9a-f]{64}$/.test(m.entries[p].digest))
    && m.browser?.sha256 === f.pin.shell[PLATFORM!].sha256 && /^[0-9a-f]{64}$/.test(m.browser?.digest),
    `addon.json: schema, version, the pin's hash, platform, browser, the licence hash, via, times, each package's integrity and digest, the zip's sha256 and digest`);
  const other = f.pin.closure.filter((e) => !list.paths.includes(e.path)).map((e) => new URL(e.resolved).pathname);
  const want = [...list.paths.map((p) => new URL(f.pin.closure.find((e) => e.path === p)!.resolved).pathname), new URL(f.pin.shell[PLATFORM!].url).pathname].sort();
  check(JSON.stringify(hitPaths()) === JSON.stringify(want) && other.length === 3 && other.every((p) => !hits.has(p)),
    `the registry got exactly this platform's ${list.count} tarballs and its zip; the other platforms' compositors never (${other.map((p) => p.split("/").pop()).join(", ")})`);
  const exe = (p: string) => (lstatSync(join(dir, p)).mode & 0o111) !== 0;
  check(readFileSync(join(dir, "node_modules/a/lib/deep/x.js"), "utf8") === "x\n" && readFileSync(join(dir, "node_modules/a/node_modules/b/b.js"), "utf8") === "b\n"
    && exe(`node_modules/${ADDON_PLATFORM_LISTS[PLATFORM!].compositor}`) && !exe("node_modules/a/index.js") && exe(`browser/${CFT_EXE(PLATFORM!)}`) && !exe(`browser/chrome-headless-shell-${PLATFORM}/resources.pak`)
    && readFileSync(join(dir, `browser/chrome-headless-shell-${PLATFORM}/locales/en-US.pak`), "utf8") === "x".repeat(5000) && readFileSync(join(dir, `browser/chrome-headless-shell-${PLATFORM}/resources.pak`), "utf8") === "stored bytes",
    "files, nested packages and the zip's stored and deflated entries hold their bytes; execute bits as the archives give them");
  check(exe("node_modules/@remotion/bundler/bin/cli.js"), "a file the package's `bin` names is executable (npm's bin-links does this without a script)");
  check(!(RAN in globalThis) && !existsSync(POSTINSTALL), "no add-on code ran in the installer's process, and no install script ran");
  const outside = fsCalls.filter((c) => c.split(" ").slice(1).some((p) => !p.startsWith(join(dataDir, "addons"))));
  check(outside.length === 0 && JSON.stringify(readdirSync(dataDir)) === JSON.stringify(["addons"]) && clean(dataDir),
    `nothing outside <dataDir>/addons was written; addons/ holds only remotion (${JSON.stringify(outside.slice(0, 3))} ${JSON.stringify(addonsListing(dataDir))})`);
  const total = list.bytes! + f.pin.shell[PLATFORM!].size;
  check(progress.length > 2 && progress[0].done === 0 && progress.every((p, i) => p.total === total && (i === 0 || p.done >= progress[i - 1].done)) && progress[progress.length - 1].done === total,
    `progress in bytes against the pinned total ${total}, from 0 to the total (${progress.length} reports)`);
}

// MUTATION: drop the licence check (install.ts) → the licence row installs.
async function i2() {
  console.log("I2. the licence...");
  const dataDir = freshData();
  const f = buildPin(basePkgs(POSTINSTALL));
  hits.clear();
  const { err } = await fixtureInstall(dataDir, f, {}, { acceptedLicenseSha256: "0".repeat(64) });
  check(err?.reason === "license" && err.message === "Accept Remotion's license in the graphics add-on dialog first. Nothing was installed." && hits.size === 0 && !existsSync(join(dataDir, "addons")),
    `another licence hash: refused before anything is fetched or created (${err?.message})`);
  const t = graphicsAddonTerms(PLATFORM!);
  const file = readFileSync(join(REPO, "packages", "core", "licenses", "remotion-4.0.481-LICENSE.md"));
  check(sha256hex(file) === "bd65083b940f61904f6ef298aade918a7cad72a3e35bc406e36fab365844b673" && t.license === file.toString("utf8") && t.sha256 === sha256hex(t.notice + t.license)
    && /Remotion is free for individuals, non-profit organizations and companies of up to three people\. Larger companies need their own Remotion license\./.test(t.notice)
    && /is not covered by ZabsReel's GPL license/.test(t.notice) && new RegExp(`downloads about ${Math.round(ADDON_PLATFORM_LISTS[PLATFORM!].bytes! / 1e6)} MB of packages from registry\\.npmjs\\.org and the Chrome headless shell \\(about ${Math.round(HEADLESS_SHELL.platforms[PLATFORM!].size / 1e6)} MB\\) from Google`).test(t.notice),
    `the terms: Remotion's LICENSE.md at v4.0.481 (sha256 bd65083b…), the notice with this platform's sizes, and sha256(notice + licence) (${t.sha256.slice(0, 12)}…)`);
}

// MUTATION: return the bytes before the hash check (install.ts download) → the EVIL row sees the marker
// written. Drop the size cap → the endless body is read until the row's 10 s deadline cancels it.
async function i3() {
  console.log("I3. a download that is not the pinned bytes...");
  const evil = buildPin(basePkgs(POSTINSTALL));
  const a = evil.pin.closure.find((e) => e.path === "node_modules/a")!;
  // The registry serves a valid tarball with a marker file in place of a.
  const swapped = makeTar([{ name: "package/package.json", data: "{}" }, { name: "package/EVIL-marker.txt", data: "evil" }]);
  for (const [what, setup, want] of [
    ["another tarball for a@1.0.0", () => served.set(new URL(a.resolved).pathname, swapped), "a@1.0.0"],
    ["changed bytes for the zip", () => answers.set(new URL(evil.pin.shell[PLATFORM!].url).pathname, "wrong"), "the Chrome headless shell"],
    ["an endless body for a@1.0.0 (the size cap)", () => answers.set(new URL(a.resolved).pathname, "big"), "a@1.0.0"],
  ] as const) {
    const dataDir = freshData();
    publish(evil);
    answers.clear();
    setup();
    recording = true;
    fsCalls.length = 0;
    const opts = { fetch: globalThis.fetch, acceptedLicenseSha256: LICENSE, via: "web" as const, signal: AbortSignal.timeout(10_000) };
    const { err } = await T.install(dataDir, opts, { pin: evil.pin, env: { AIVE_ADDON_REGISTRY: REGISTRY } }).then(() => ({ err: null }), (e: GraphicsAddonInstallError) => ({ err: e }));
    recording = false;
    answers.clear();
    check(err?.reason === "corrupted" && err.message === `A download was corrupted or changed (${want}). Nothing was installed. Try again.`
      && !existsSync(graphicsAddonDir(dataDir)) && clean(dataDir) && readGraphicsAddon(dataDir, { pin: evil.pin }).state === "not-installed" && !fsCalls.some((c) => c.includes("EVIL")),
      `${what}: "${err?.message}"; nothing activated, no staging or lock left, no byte of it extracted`);
  }
  publish(evil);
}

// MUTATION: drop the ".." check from entryNameProblem (names.ts) → the traversal row is written. Accept type
// "2" in tar.ts → the symlink row is written. Pass SHELL to archive() for the zip (install.ts) → the zip row
// reads "The add-on's the Chrome headless shell".
async function i4() {
  console.log("I4. tar entries the reader refuses...");
  const cases: [string, TarIn, RegExp][] = [
    ["a .. segment", { name: "package/../escape.txt", data: "x" }, /"package\/\.\.\/escape\.txt": a "\.\." segment/],
    ["an absolute path", { name: "package//etc/x", data: "x" }, /an absolute path|a "" segment/],
    ["a backslash", { name: "package/a\\b.txt", data: "x" }, /a backslash/],
    ["a drive letter", { name: "package/C:/x.txt", data: "x" }, /a ':' \(a drive letter or a stream\)/],
    ["a symlink", { name: "package/link", type: "2", linkname: "../../../../etc/passwd" }, /an entry of type "2"/],
    ["a hard link", { name: "package/hard", type: "1", linkname: "package/index.js" }, /an entry of type "1"/],
    ["a character device", { name: "package/dev", type: "3" }, /an entry of type "3"/],
    ["a FIFO", { name: "package/fifo", type: "6" }, /an entry of type "6"/],
    ["a pax path with ..", { name: "package/ok.txt", pax: { path: "package/../../pax-escape.txt" }, data: "x" }, /a "\.\." segment/],
    ["a GNU long name with ..", { name: `package/${"d/".repeat(60)}../../${"e/".repeat(60)}x.txt`, long: true, data: "x" }, /a "\.\." segment/],
  ];
  for (const [what, e, want] of cases) {
    const dest = join(root, `i4-${what.replace(/\W+/g, "-")}`, "pkg");
    const err = await thrown(() => extractTarball(makeTar([{ name: "package/index.js", data: "1" }, e]), dest, { platform: "linux-x64", names: new NameSet("linux-x64"), prefix: "node_modules/x" }));
    check(err instanceof ArchiveRefusal && want.test(err.message) && !existsSync(join(dirname(dest), "escape.txt")) && !existsSync(join(root, "pax-escape.txt")),
      `${what}: refused (${err?.message.slice(0, 90)}), nothing written outside the package`);
  }
  const ok = join(root, "i4-ok", "pkg");
  const files = await extractTarball(makeTar([
    { name: "package/", type: "5" },
    { name: "package/index.js", data: "1", mode: 0o755 },
    { name: "package/p.txt", pax: { path: "package/pax/long-name.txt" }, data: "pax" },
    { name: `package/${"n".repeat(120)}.txt`, long: true, data: "long" },
    { name: "top-level-file", data: "skipped as npm does" },
  ]), ok, { platform: "linux-x64", names: new NameSet("linux-x64"), prefix: "node_modules/x" });
  check(JSON.stringify(files.map((f) => f.path).sort()) === JSON.stringify(["index.js", `${"n".repeat(120)}.txt`, "pax/long-name.txt"].sort()) && readFileSync(join(ok, "pax", "long-name.txt"), "utf8") === "pax"
    && (lstatSync(join(ok, "index.js")).mode & 0o111) !== 0 && files.find((f) => f.path === "index.js")!.sha256 === sha256hex("1"),
    `a pax path and a GNU long name are read, package/ is stripped, an entry outside it skipped (${files.map((f) => f.path.slice(0, 20)).join(", ")})`);
  // The same refusal through a full install: the pinned bytes are the bad tarball itself.
  const dataDir = freshData();
  const pkgs = basePkgs(POSTINSTALL);
  pkgs.find((p) => p.path === "node_modules/a")!.files.push({ name: "../escape.txt", data: "x" });
  const { err } = await fixtureInstall(dataDir, buildPin(pkgs));
  check(err?.reason === "archive" && /^The add-on's a@1\.0\.0 holds an entry ZabsReel doesn't install \("package\/\.\.\/escape\.txt": a "\.\." segment\)\. Nothing was installed\.$/.test(err.message) && !existsSync(graphicsAddonDir(dataDir)) && clean(dataDir),
    `in an install: "${err?.message}"; nothing activated`);
  // The browser zip's refusal names it the same way (the pinned bytes are the bad zip itself).
  const zd = freshData();
  const zip = fixtureZip(PLATFORM!, [{ name: `chrome-headless-shell-${PLATFORM}/locked.bin`, data: "x", flags: 1 }]);
  const z = await fixtureInstall(zd, buildPin(basePkgs(POSTINSTALL), { [PLATFORM!]: zip }, "-i4zip"));
  check(z.err?.reason === "archive" && z.err.message === `The add-on's Chrome headless shell holds an entry ZabsReel doesn't install ("chrome-headless-shell-${PLATFORM}/locked.bin": an encrypted entry). Nothing was installed.` && !existsSync(graphicsAddonDir(zd)) && clean(zd),
    `in an install, a browser zip entry: "${z.err?.message}"; nothing activated`);
}

// MUTATION: accept any http host in registryOverride (install.ts) → the non-loopback rows fetch. Ignore
// `checkout` in seams() → the packaged-seams row installs (to the stub) and recovers.
async function i5() {
  console.log("I5. AIVE_ADDON_REGISTRY...");
  const f = buildPin(basePkgs(POSTINSTALL));
  for (const value of ["https://127.0.0.1:5031", "http://10.0.0.1:5031", "http://zr-evil-1.invalid:5031", "http://127.0.0.1", "http://127.0.0.1:5031/x", "http://u@127.0.0.1:5031", "http://[::1]:5031", "file:///tmp/x"]) {
    const dataDir = freshData();
    const urls: string[] = [];
    const stub = (async (u: string | URL | Request) => {
      urls.push(String(u));
      throw new Error("no network in this row");
    }) as typeof fetch;
    const err = await thrown(() => T.install(dataDir, { fetch: stub, acceptedLicenseSha256: LICENSE, via: "web" }, { pin: f.pin, env: { AIVE_ADDON_REGISTRY: value } }));
    check(err instanceof GraphicsAddonInstallError && err.reason === "registry" && err.message === `AIVE_ADDON_REGISTRY must be http://127.0.0.1:<port> or http://localhost:<port> (it is ${JSON.stringify(value)}).` && urls.length === 0 && !existsSync(join(dataDir, "addons")),
      `${value}: refused before anything is fetched or created`);
  }
  // A packaged core (its package folder has no src/) ignores the variable: the pinned URLs, here to a stub.
  const pkg = join(root, "i5-packaged");
  mkdirSync(join(pkg, "dist", "addon"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@aive/core" }));
  const urls: string[] = [];
  const stub = (async (u: string | URL | Request) => {
    urls.push(String(u));
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  hits.clear();
  const dataDir = freshData();
  const err = await thrown(() => T.install(dataDir, { fetch: stub, acceptedLicenseSha256: LICENSE, via: "web" }, { pin: f.pin, env: { AIVE_ADDON_REGISTRY: REGISTRY }, from: join(pkg, "dist", "addon", "install.js") }));
  check(err instanceof GraphicsAddonInstallError && err.reason === "http" && /^registry\.npmjs\.org answered 404 for /.test(err.message) && urls.length > 0 && urls.every((u) => u.startsWith("https://registry.npmjs.org/")) && hits.size === 0,
    `a packaged core ignores it: only registry.npmjs.org URLs, to a stub (${urls.length}); the loopback registry got nothing (${err?.message})`);
  // A packaged core refuses the installer's test seams: install, recovery and Remove touch nothing.
  const sd = freshData();
  mkdirSync(join(sd, "addons", ".staging-planted"), { recursive: true });
  urls.length = 0;
  const packaged: AddonSeams = { pin: f.pin, platform: PLATFORM!, checkout: join(pkg, "dist", "addon", "install.js") };
  const refused = [
    await thrown(() => T.install(sd, { fetch: stub, acceptedLicenseSha256: LICENSE, via: "web" }, packaged)),
    await thrown(() => T.recover(sd, packaged)),
    await thrown(() => T.remove(sd, "web", packaged)),
  ];
  check(refused.every((e) => e?.message === "The add-on installer's test seams work only in a ZabsReel source checkout.") && urls.length === 0 && JSON.stringify(addonsListing(sd)) === JSON.stringify([".staging-planted"]),
    `a packaged core refuses the test seams (platform, pin) for install, recovery and Remove; nothing fetched or deleted (${refused.map((e) => e?.message ?? "no error").join(" | ")})`);
}

// MUTATION: never treat a lock as stale (holder() stale: false) → the dead-pid and old-mtime rows refuse.
// Delete a stale lock without reading it again (takeLock) → the race row deletes the other host's lock.
// Drop the heartbeat timer → the heartbeat row sees the mtime unchanged.
async function i6() {
  console.log("I6. the install lock...");
  const f = buildPin(basePkgs(POSTINSTALL));
  const lockAt = (d: string) => join(d, "addons", ".install.lock");
  const plant = (d: string, pid: number, ageMs = 0) => {
    mkdirSync(join(d, "addons"), { recursive: true });
    writeFileSync(lockAt(d), JSON.stringify({ pid, startedAt: new Date().toISOString(), via: "desktop", token: "other" }));
    if (ageMs) utimesSync(lockAt(d), new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
  };
  const live = freshData();
  plant(live, process.ppid);
  const before = readFileSync(lockAt(live), "utf8");
  hits.clear();
  const { err } = await fixtureInstall(live, f);
  check(err?.reason === "busy" && err.message === "Another ZabsReel window is installing the graphics add-on (desktop). Wait for it to finish." && readFileSync(lockAt(live), "utf8") === before && hits.size === 0,
    `a live lock (another pid, fresh): "${err?.message}"; the lock is untouched, nothing fetched`);
  const removed = await thrown(() => T.remove(live, "web", {}));
  check(removed instanceof GraphicsAddonInstallError && removed.reason === "busy" && (await T.recover(live, {})) === false && readFileSync(lockAt(live), "utf8") === before,
    "Remove refuses with the same message, and recovery skips (returns false) while it is held");
  const deadPid = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  const dead = freshData();
  plant(dead, Number(deadPid));
  const r1 = await fixtureInstall(dead, f);
  check(r1.got?.state === "ready" && !existsSync(lockAt(dead)), `a lock whose pid (${deadPid}) is gone is taken over; the install's own lock is released (${r1.err?.message ?? "ready"})`);
  const old = freshData();
  plant(old, process.ppid, 3 * 60_000);
  const r2 = await fixtureInstall(old, f);
  check(r2.got?.state === "ready" && !existsSync(lockAt(old)), `a lock of a live but unrelated pid (the parent, ${process.ppid}) not rewritten for 3 minutes is taken over (${r2.err?.message ?? "ready"})`);
  // Two hosts judge the same stale lock: the other host deletes it and writes its own just after this one
  // read it. This one must not delete that fresh lock.
  const race = freshData();
  plant(race, Number(deadPid));
  const theirs = JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString(), via: "desktop", token: "taker" });
  let swapped = false;
  afterRead = (p) => {
    if (swapped || p !== lockAt(race)) return;
    swapped = true;
    writeFileSync(lockAt(race), theirs);
  };
  hits.clear();
  const r4 = await fixtureInstall(race, f);
  afterRead = null;
  check(swapped && r4.err?.reason === "busy" && readFileSync(lockAt(race), "utf8") === theirs && hits.size === 0,
    `a fresh lock written after the stale one was read is kept: busy, nothing fetched (${r4.err?.message ?? r4.got?.state})`);
  // The heartbeat: a slow download (1.5 s) with a 100 ms heartbeat rewrites the lock while it waits.
  const slow = freshData();
  const a = f.pin.closure.find((e) => e.path === "node_modules/a")!;
  answers.set(new URL(a.resolved).pathname, { delay: 1500 });
  const mtimes = new Set<number>();
  const watch = setInterval(() => {
    try {
      mtimes.add(statSync(lockAt(slow)).mtimeMs);
    } catch {
      /* not yet, or gone */
    }
  }, 50);
  const r3 = await fixtureInstall(slow, f, { heartbeatMs: 100 });
  clearInterval(watch);
  answers.clear();
  check(r3.got?.state === "ready" && mtimes.size >= 5, `the holder rewrites the lock while a slow download runs (${mtimes.size} distinct mtimes)`);
}

// MUTATION: keep the staging folder on failure (install.ts finally) → the cancel rows find .staging-*. Skip
// recover() → the kill row's staging stays.
async function i7() {
  console.log("I7. cancel, a kill before addon.json, stale staging...");
  const f = buildPin(basePkgs(POSTINSTALL));
  const zipPath = new URL(f.pin.shell[PLATFORM!].url).pathname;
  for (const [what, when] of [["before it starts", "now"], ["mid-download", "zip"]] as const) {
    const dataDir = freshData();
    const ctl = new AbortController();
    if (when === "now") ctl.abort();
    else answers.set(zipPath, "hold");
    const poll = setInterval(() => {
      if ((hits.get(zipPath) ?? 0) > 0) ctl.abort();
    }, 20);
    hits.clear();
    const { err } = await fixtureInstall(dataDir, f, {}, { signal: ctl.signal });
    clearInterval(poll);
    answers.clear();
    check(err?.reason === "cancelled" && err.message === "The graphics add-on install was cancelled. Nothing was installed." && !existsSync(graphicsAddonDir(dataDir)) && clean(dataDir),
      `cancel ${what}: "${err?.message}"; no add-on, no staging, the lock released (${JSON.stringify(addonsListing(dataDir))})`);
  }
  // A process killed after the rewrite-target check, before addon.json.
  const dataDir = freshData();
  const pinFile = join(root, "i7-pin.json");
  writeFileSync(pinFile, JSON.stringify(f.pin));
  const marker = join(root, "i7-marker");
  const child = spawn(process.execPath, [...process.execArgv, join(dirname(fileURLToPath(import.meta.url)), "addon-child.ts"), "before-manifest", dataDir, pinFile, REGISTRY, marker], { stdio: "ignore" });
  for (let i = 0; i < 600 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  const left = addonsListing(dataDir);
  check(existsSync(marker) && readGraphicsAddon(dataDir, { pin: f.pin }).state === "not-installed" && left.includes(".install.lock") && left.some((n) => n.startsWith(".staging-")) && !existsSync(graphicsAddonDir(dataDir)),
    `killed just before addon.json: not installed; its lock and staging stay behind (${JSON.stringify(left)})`);
  const recovered = await T.recover(dataDir, { pin: f.pin });
  check(recovered && clean(dataDir) && addonsListing(dataDir).length === 0, `recoverGraphicsAddon takes over the dead pid's lock and deletes the stale staging (${JSON.stringify(addonsListing(dataDir))})`);
  mkdirSync(join(dataDir, "addons", ".staging-stale1", "node_modules"), { recursive: true });
  mkdirSync(join(dataDir, "addons", ".removed-stale2"), { recursive: true });
  const again = await fixtureInstall(dataDir, f);
  check(again.got?.state === "ready" && clean(dataDir), `an install deletes stale .staging-* and .removed-* folders first (${JSON.stringify(addonsListing(dataDir))})`);
}

// MUTATION: rename .old-* back only on success (drop the rollback in activate) → the second-rename row finds no
// live copy. Retry on every platform's EBUSY without the window (no `until`) → the first-rename row hangs (timeout).
// Restore a ready .removed-* in recover() → the .removed row is restored.
async function i8() {
  console.log("I8. activation and recovery...");
  const f = buildPin(basePkgs(POSTINSTALL));
  const installed = async () => {
    const d = freshData();
    await fixtureInstall(d, f);
    return { d, at: manifestOf(d).installedAt as string, hash: treeHash(graphicsAddonDir(d)) };
  };
  const live = (d: string) => join(d, "addons", "remotion", ADDON_REMOTION_VERSION);
  const win = { windowsRenames: true, renameWindowMs: 300 };
  {
    const { d, at, hash } = await installed();
    fault = (name, p) => (name === "rename" && p === live(d) ? errno("EBUSY") : null);
    const t0 = Date.now();
    const { err } = await fixtureInstall(d, f, win);
    fault = null;
    check(err?.reason === "in-use" && err.message === "Graphics are rendering or the add-on's files are in use. Try again when the graphic finishes." && Date.now() - t0 >= 300
      && manifestOf(d).installedAt === at && treeHash(live(d)) === hash && clean(d),
      `the first rename fails past the retry window (EBUSY): "${err?.message}"; the old copy stays live and whole, staging deleted`);
  }
  {
    const { d, at, hash } = await installed();
    fault = (name, p) => (name === "rename" && p.includes(".staging-") ? errno("EPERM") : null);
    const { err } = await fixtureInstall(d, f, win);
    fault = null;
    check(err?.reason === "in-use" && manifestOf(d).installedAt === at && treeHash(live(d)) === hash && clean(d),
      `the second rename fails (EPERM): the .old-* copy is renamed back, live and whole; no .old-* or staging left (${JSON.stringify(addonsListing(d))})`);
  }
  {
    const { d, at } = await installed();
    let busy = 2;
    fault = (name, p) => (name === "rename" && p === live(d) && busy-- > 0 ? errno("EACCES") : null);
    const { got } = await fixtureInstall(d, f, { windowsRenames: true });
    fault = null;
    check(got?.state === "ready" && manifestOf(d).installedAt !== at && clean(d), "on win32 a rename that fails twice (EACCES) and then works is retried: the new copy is live");
  }
  {
    const { d, at } = await installed();
    let busy = 1;
    fault = (name, p) => (name === "rename" && p === live(d) && busy-- > 0 ? errno("EBUSY") : null);
    const { err } = await fixtureInstall(d, f, { windowsRenames: false });
    fault = null;
    check(err?.reason === "in-use" && manifestOf(d).installedAt === at, "off win32 a rename is not retried: one EBUSY gives the message, the old copy stays");
  }
  // Recovery: live missing, exactly one ready .old-*.
  {
    const { d, hash } = await installed();
    renameSync(live(d), join(d, "addons", ".old-a1"));
    check((await T.recover(d, { pin: f.pin })) && readGraphicsAddon(d, { pin: f.pin }).state === "ready" && treeHash(live(d)) === hash && clean(d), "live missing, one ready .old-*: recoverGraphicsAddon puts it back");
  }
  {
    const { d } = await installed();
    cpSync(live(d), join(d, "addons", ".old-a1"), { recursive: true });
    renameSync(live(d), join(d, "addons", ".old-a2"));
    await T.recover(d, { pin: f.pin });
    check(!existsSync(live(d)) && clean(d), "live missing, two ready .old-*: neither is restored (which one is unknown), both deleted");
  }
  {
    const { d } = await installed();
    renameSync(live(d), join(d, "addons", ".removed-a1"));
    await T.recover(d, { pin: f.pin });
    check(!existsSync(live(d)) && clean(d), "a ready .removed-* (the user removed it) is deleted, never restored");
  }
}

// MUTATION: skip dropOtherVersions after activation → the 4.0.480 row keeps it. Remove only the live
// folder → Remove's 4.0.480 row keeps it.
async function i9() {
  console.log("I9. other versions, and Remove...");
  const f = buildPin(basePkgs(POSTINSTALL));
  const plantOld = (d: string) => {
    mkdirSync(join(d, "addons", "remotion", "4.0.480", "node_modules"), { recursive: true });
    writeFileSync(join(d, "addons", "remotion", "4.0.480", "addon.json"), JSON.stringify({ schema: 1, remotion: "4.0.480" }));
  };
  const d = freshData();
  plantOld(d);
  check(readGraphicsAddon(d, { pin: f.pin }).state === "update-needed", "only 4.0.480 installed: update-needed");
  const { got } = await fixtureInstall(d, f);
  check(got?.state === "ready" && JSON.stringify(readdirSync(join(d, "addons", "remotion"))) === JSON.stringify([ADDON_REMOTION_VERSION]) && clean(d),
    `after activation the 4.0.480 folder is gone (${JSON.stringify(readdirSync(join(d, "addons", "remotion")))})`);
  plantOld(d);
  await T.remove(d, "web", {});
  check(readGraphicsAddon(d, { pin: f.pin }).state === "not-installed" && readdirSync(join(d, "addons", "remotion")).length === 0 && clean(d),
    `Remove deletes this version's folder and 4.0.480, and releases its lock (${JSON.stringify(addonsListing(d))})`);
  const busy = freshData();
  await fixtureInstall(busy, f);
  const at = manifestOf(busy).installedAt;
  fault = (name, p) => (name === "rename" && p === graphicsAddonDir(busy) ? errno("EBUSY") : null);
  const err = await thrown(() => T.remove(busy, "web", { windowsRenames: true, renameWindowMs: 200 }));
  fault = null;
  check(err instanceof GraphicsAddonInstallError && err.reason === "in-use" && manifestOf(busy).installedAt === at && clean(busy), `Remove whose rename stays busy: "${err?.message}"; nothing changed`);
  const none = freshData();
  await T.remove(none, "web", {});
  check(!existsSync(join(none, "addons")), "Remove with nothing installed creates nothing");
}

// MUTATION: return true from rewriteTargetsMatch (remotionload.ts) → the changed-renderer row activates.
async function i10() {
  console.log("I10. the rewrite-target check...");
  const pkgs = basePkgs(POSTINSTALL);
  const esm = pkgs.find((p) => p.path === "node_modules/@remotion/renderer")!.files.find((x) => x.name === "dist/esm/index.mjs")!;
  esm.data = String(esm.data).replace("  if (isAssetCompressed(src)) {\n    return src;", "  if (isAssetCompressed(src)) {\n    return src ;");
  const d = freshData();
  const { err } = await fixtureInstall(d, buildPin(pkgs));
  check(String(esm.data).includes("return src ;") && err?.reason === "guard" && err.message === "This add-on doesn't match the Remotion version ZabsReel guards. Nothing was installed." && !existsSync(graphicsAddonDir(d)) && clean(d),
    `a renderer whose text the guard doesn't know: "${err?.message}"; nothing activated`);
}

// MUTATION: map every fetch failure to "corrupted" (download) → the 500, closed-socket, timeout and offline rows
// fail. Drop the ENOSPC branch in failure() → the disk row gives the generic message. Call takeLock outside
// failure() → the lock rows get the raw fs error.
async function i11() {
  console.log("I11. the failure messages...");
  const f = buildPin(basePkgs(POSTINSTALL));
  const a = new URL(f.pin.closure.find((e) => e.path === "node_modules/a")!.resolved).pathname;
  const host = `127.0.0.1:${REG_PORT}`;
  const cases: [string, () => void, AddonSeams, InstallFailure, string][] = [
    ["the registry answers 500", () => answers.set(a, "500"), {}, "http", `${host} answered 500 for a@1.0.0. Try again later.`],
    ["the socket closes mid-body", () => answers.set(a, "close"), {}, "network", `ZabsReel couldn't reach ${host}. Check the connection and try again.`],
    ["no answer within the request timeout", () => answers.set(a, "hold"), { requestTimeoutMs: 300 }, "network", `ZabsReel couldn't reach ${host}. Check the connection and try again.`],
    ["nothing listens (offline)", () => {}, { env: { AIVE_ADDON_REGISTRY: "http://127.0.0.1:5039" } }, "network", "ZabsReel couldn't reach 127.0.0.1:5039. Check the connection and try again."],
  ];
  for (const [what, setup, s, reason, message] of cases) {
    const d = freshData();
    setup();
    const { err } = await fixtureInstall(d, f, s);
    answers.clear();
    check(err?.reason === reason && err.message === message && !existsSync(graphicsAddonDir(d)) && clean(d), `${what}: "${err?.message}"`);
  }
  const mb = Math.max(1, Math.round((f.pin.lists[PLATFORM!].bytes! + f.pin.shell[PLATFORM!].size) / 1e6));
  for (const [code, reason, message] of [
    ["ENOSPC", "disk", (d: string) => `Not enough disk space: the add-on needs about ${mb} MB in ${d}.`],
    ["ENAMETOOLONG", "path", (d: string) => `A path in the add-on is too long for this folder (${d}). Move ZabsReel's data folder to a shorter path and try again.`],
  ] as const) {
    const d = freshData();
    fault = (name, p) => (name === "writeFile" && p.includes(".staging-") && p.endsWith("x.js") ? errno(code) : null);
    const { err } = await fixtureInstall(d, f);
    fault = null;
    check(err?.reason === reason && err.message === message(d) && !existsSync(graphicsAddonDir(d)) && clean(d), `${code} while extracting: "${err?.message}"`);
  }
  // The same while taking the lock: creating addons/, or writing .install.lock.
  for (const [code, reason, op, message] of [
    ["ENOSPC", "disk", "writeFile", (d: string) => `Not enough disk space: the add-on needs about ${mb} MB in ${d}.`],
    ["ENAMETOOLONG", "path", "mkdir", (d: string) => `A path in the add-on is too long for this folder (${d}). Move ZabsReel's data folder to a shorter path and try again.`],
  ] as const) {
    const d = freshData();
    hits.clear();
    fault = (name, p) => (name === op && (p.endsWith(".install.lock") || p === join(d, "addons")) ? errno(code) : null);
    const { err } = await fixtureInstall(d, f);
    fault = null;
    check(err instanceof GraphicsAddonInstallError && err.reason === reason && err.message === message(d) && !existsSync(join(d, "addons", ".install.lock")) && hits.size === 0,
      `${code} on ${op === "mkdir" ? "addons/" : ".install.lock"}: "${err?.message}"`);
  }
  // Remove takes the same lock, with the same messages; the add-on stays.
  for (const [code, reason, message] of [
    ["ENOSPC", "disk", (d: string) => `Not enough disk space: the add-on needs about ${mb} MB in ${d}.`],
    ["ENAMETOOLONG", "path", (d: string) => `A path in the add-on is too long for this folder (${d}). Move ZabsReel's data folder to a shorter path and try again.`],
  ] as const) {
    const d = freshData();
    await fixtureInstall(d, f);
    fault = (name, p) => (name === "writeFile" && p.endsWith(".install.lock") ? errno(code) : null);
    const err = await thrown(() => T.remove(d, "web", { pin: f.pin }));
    fault = null;
    check(err instanceof GraphicsAddonInstallError && err.reason === reason && err.message === message(d) && readGraphicsAddon(d, { pin: f.pin }).state === "ready" && clean(d),
      `Remove with ${code} on .install.lock: "${err?.message}", the add-on is still ready`);
  }
  // The user's cancel lands while a download is already failing (its 500's body being discarded): "cancelled".
  {
    const d = freshData();
    const ctl = new AbortController();
    const failing: typeof fetch = async (url, init) => {
      const res = await fetch(url, init);
      if (new URL(String(url)).pathname !== a) return res;
      await res.body?.cancel();
      return { ok: false, status: 500, body: { cancel: async () => ctl.abort() } } as unknown as Response;
    };
    const { err } = await fixtureInstall(d, f, {}, { fetch: failing, signal: ctl.signal });
    check(err?.reason === "cancelled" && err.message === "The graphics add-on install was cancelled. Nothing was installed." && !existsSync(graphicsAddonDir(d)) && clean(d),
      `a cancel while a download is failing: "${err?.message}"`);
  }
}

// MUTATION: skip the Windows rules in entryNameProblem (platform check) → the win32 rows extract. Make NameSet
// compare case-sensitively → the collision rows extract.
async function i12() {
  console.log("I12. names Windows and macOS can't hold...");
  const tarWith = (name: string) => makeTar([{ name: `package/${name}`, data: "x" }]);
  const winNames = ["CON", "aux.js", "Com1.txt", "lpt9", "nul.tar.gz", "dot.", "space ", "lt<.js", 'q".js', "pipe|.js", "ask?.js", "star*.js", "ctl\u0001.js", "dir./x.js"];
  for (const n of winNames) {
    const e = await thrown(() => extractTarball(tarWith(n), join(root, "i12", `w-${createHash("md5").update(n).digest("hex")}`), { platform: "win32-x64", names: new NameSet("win32-x64"), prefix: "node_modules/x" }));
    const l = await thrown(() => extractTarball(tarWith(n), join(root, "i12", `l-${createHash("md5").update(n).digest("hex")}`), { platform: "linux-x64", names: new NameSet("linux-x64"), prefix: "node_modules/x" }));
    check(e instanceof ArchiveRefusal && /device name|ends in a dot or a space|a character Windows refuses/.test(e.message) && l === null, `${JSON.stringify(n)}: refused for win32-x64 (${e?.message.slice(0, 80)}), written for linux-x64`);
  }
  const pairs: [string, string, AddonPlatform][] = [["README.md", "readme.md", "win32-x64"], ["Lib/a.js", "lib/b.js", "win32-x64"], ["caf\u00e9.txt", "cafe\u0301.txt", "darwin-x64"], ["A.js", "a.js", "darwin-arm64"]];
  for (const [x, y, p] of pairs) {
    const tar = makeTar([{ name: `package/${x}`, data: "1" }, { name: `package/${y}`, data: "2" }]);
    const e = await thrown(() => extractTarball(tar, join(root, "i12", `c-${p}-${createHash("md5").update(x + y).digest("hex")}`), { platform: p, names: new NameSet(p), prefix: "node_modules/x" }));
    const l = await thrown(() => extractTarball(tar, join(root, "i12", `cl-${createHash("md5").update(x + y).digest("hex")}`), { platform: "linux-x64", names: new NameSet("linux-x64"), prefix: "node_modules/x" }));
    check(e instanceof ArchiveRefusal && /which are the same name on/.test(e.message) && l === null, `${JSON.stringify(x)} and ${JSON.stringify(y)}: refused for ${p} (${e?.message.slice(0, 90)}), both written for linux-x64`);
  }
  const zip = makeZip([{ name: "x/CON.txt", data: "x" }]);
  const zf = join(root, "i12-win.zip");
  writeFileSync(zf, zip);
  const z = await thrown(() => extractZip(zf, join(root, "i12", "zw"), { platform: "win32-x64", names: new NameSet("win32-x64"), prefix: "browser" }));
  check(z instanceof ArchiveRefusal && /the Windows device name "CON\.txt"/.test(z.message), `the zip reader applies the same rules (${z?.message})`);
}

// MUTATION: skip reuse (always download) → every reuse row fetches everything. Reuse without comparing the
// digest → the tampered and missing-file rows keep the bad copy. Move (rename) the source folder instead of
// copying → the failed-activation row finds the source changed. Walk nested package folders as part of
// their parent (stage()'s nested callback `() => false`) → the nested row fetches a too.
async function i13() {
  console.log("I13. reuse on update (D3.9)...");
  const pkgs = basePkgs(POSTINSTALL);
  const f1 = buildPin(pkgs);
  const moved = pkgs.map((p) => (p.path === "node_modules/a" ? { ...p, version: "1.0.1", files: [pkgJson("a", "1.0.1"), { name: "index.js", data: "module.exports = 2;\n" }, { name: "lib/deep/x.js", data: "x\n" }] } : p));
  const f2 = buildPin(moved);
  const aPath = (f: Fixture) => new URL(f.pin.closure.find((e) => e.path === "node_modules/a")!.resolved).pathname;
  const d = freshData();
  await fixtureInstall(d, f1);
  hits.clear();
  const up = await fixtureInstall(d, f2);
  const last = up.progress[up.progress.length - 1];
  const aBytes = f2.pin.closure.find((e) => e.path === "node_modules/a")!.bytes!;
  const total = f2.pin.lists[PLATFORM!].bytes! + f2.pin.shell[PLATFORM!].size;
  check(up.got?.state === "ready" && JSON.stringify(hitPaths()) === JSON.stringify([aPath(f2)]) && readFileSync(join(graphicsAddonDir(d), "node_modules/a/index.js"), "utf8") === "module.exports = 2;\n"
    && readFileSync(join(graphicsAddonDir(d), "node_modules/a/node_modules/b/b.js"), "utf8") === "b\n" && clean(d),
    `an update after a one-package change fetches exactly that tarball, nothing else, the browser included (${JSON.stringify(hitPaths())})`);
  check(last?.done === total && last.total === total, `progress counts the reused bytes as done: it ends at the total, ${total}, though ${aBytes} bytes were downloaded (${last?.done} of ${last?.total})`);
  // A change to the nested package only: a is reused around it (its digest skips a/node_modules/b), b is fetched.
  const nestedMoved = pkgs.map((p) => (p.path === "node_modules/a/node_modules/b" ? { ...p, version: "1.0.1", files: [pkgJson("b", "1.0.1"), { name: "b.js", data: "b2\n" }] } : p));
  const f3 = buildPin(nestedMoved);
  const bPath = new URL(f3.pin.closure.find((e) => e.path === "node_modules/a/node_modules/b")!.resolved).pathname;
  const dn = freshData();
  await fixtureInstall(dn, f1);
  hits.clear();
  const nu = await fixtureInstall(dn, f3);
  const nd = graphicsAddonDir(dn);
  check(nu.got?.state === "ready" && JSON.stringify(hitPaths()) === JSON.stringify([bPath]) && readFileSync(join(nd, "node_modules/a/index.js"), "utf8") === "module.exports = 1;\n"
    && readFileSync(join(nd, "node_modules/a/lib/deep/x.js"), "utf8") === "x\n" && readFileSync(join(nd, "node_modules/a/node_modules/b/b.js"), "utf8") === "b2\n"
    && JSON.parse(readFileSync(join(nd, "node_modules/a/node_modules/b/package.json"), "utf8")).version === "1.0.1" && clean(dn),
    `an update of the nested a/node_modules/b fetches exactly its tarball; a is reused around it; both hold the right bytes (${JSON.stringify(hitPaths())})`);
  // A reused package's names count as a download's (win32, darwin): an update adding node_modules/A next to
  // the reused node_modules/a is refused for win32-x64, and the installed copy stays.
  const dw = freshData();
  const win = { acceptedLicenseSha256: graphicsAddonTerms("win32-x64").sha256 };
  const firstWin = await fixtureInstall(dw, f1, { platform: "win32-x64" }, win);
  const fA = buildPin([...pkgs, { path: "node_modules/A", version: "1.0.0", files: [pkgJson("A", "1.0.0")] }]);
  hits.clear();
  const upA = await fixtureInstall(dw, fA, { platform: "win32-x64" }, win);
  check(firstWin.got?.state === "ready" && upA.err?.reason === "archive" && /the names "a" and "A", which are the same name on win32-x64/.test(upA.err.message)
    && !hitPaths().includes(aPath(fA)) && manifestOf(dw).lockSha256 === f1.pin.lockSha256 && clean(dw),
    `win32-x64: a downloaded node_modules/A beside the reused node_modules/a is refused (${upA.err?.message ?? upA.got?.state}); the old copy stays`);
  // A tampered source package (one byte), and a source missing one file: re-downloaded, not reused.
  for (const [what, damage] of [
    ["one byte changed", (dir: string) => writeFileSync(join(dir, "node_modules/a/lib/deep/x.js"), "y\n")],
    ["one file missing", (dir: string) => rmSync(join(dir, "node_modules/a/lib/deep/x.js"))],
  ] as const) {
    const dd = freshData();
    await fixtureInstall(dd, f1);
    damage(graphicsAddonDir(dd));
    hits.clear();
    const again = await fixtureInstall(dd, buildPin(pkgs, {}, "-reinstall"));
    check(again.got?.state === "ready" && JSON.stringify(hitPaths()) === JSON.stringify([aPath(f1)]) && readFileSync(join(graphicsAddonDir(dd), "node_modules/a/lib/deep/x.js"), "utf8") === "x\n",
      `a source with ${what}: that package is downloaded again and correct; the rest and the browser reused (${JSON.stringify(hitPaths().map((p) => p.split("/").pop()))})`);
  }
  // A pin move: the copy is under another version's folder; its packages and browser are reused, then it goes.
  const dm = freshData();
  await fixtureInstall(dm, f1);
  renameSync(graphicsAddonDir(dm), join(dm, "addons", "remotion", "4.0.480"));
  hits.clear();
  const pm = await fixtureInstall(dm, f2);
  check(pm.got?.state === "ready" && JSON.stringify(hitPaths()) === JSON.stringify([aPath(f2)]) && JSON.stringify(readdirSync(join(dm, "addons", "remotion"))) === JSON.stringify([ADDON_REMOTION_VERSION]),
    `a pin move reuses the unchanged packages and the browser from remotion/4.0.480, which is then deleted (${JSON.stringify(hitPaths())})`);
  // A failed activation after reuse leaves the source copy byte-identical.
  const df = freshData();
  await fixtureInstall(df, f1);
  const before = treeHash(graphicsAddonDir(df));
  fault = (name, p) => (name === "rename" && p.includes(".staging-") ? errno("EBUSY") : null);
  const failed = await fixtureInstall(df, f2, { windowsRenames: true, renameWindowMs: 200 });
  fault = null;
  check(failed.err?.reason === "in-use" && treeHash(graphicsAddonDir(df)) === before && manifestOf(df).lockSha256 === f1.pin.lockSha256 && clean(df),
    "a failed activation after reuse leaves the source copy byte-identical (hard links or copies, never a move)");
}

// MUTATION: import the installer into rpc.ts → the import row fails. Add an RPC method named install_graphics_addon
// → the method row fails. Import installGraphicsAddon from "./addon/index.js" into rpc.ts → the names row fails.
function i14() {
  console.log("I14. the core never installs...");
  const listTs = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listTs(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
  const sources = [join(REPO, "packages", "core", "src"), join(REPO, "packages", "mcp", "src")].flatMap(listTs);
  const allowed = new Set(["addon/index.ts", "addon/install.ts"].map((f) => join(REPO, "packages", "core", "src", ...f.split("/"))));
  const importers = sources.filter((f) => !allowed.has(f) && /["'][./]*(?:addon\/)?install(?:\.js)?["']/.test(readFileSync(f, "utf8")));
  check(sources.length > 50 && importers.length === 0, `no core or MCP source but addon/index.ts imports the installer (${sources.length} files; ${JSON.stringify(importers.map((f) => f.slice(REPO.length)))})`);
  // Through addon/index.js too: no other source names the installer's functions.
  const namers = sources.filter((f) => !allowed.has(f) && /\b(?:installGraphicsAddon|removeGraphicsAddon|recoverGraphicsAddon|addonInstallerForTests)\b/.test(readFileSync(f, "utf8")));
  check(namers.length === 0, `no core or MCP source but addon/index.ts and addon/install.ts names installGraphicsAddon, removeGraphicsAddon, recoverGraphicsAddon or addonInstallerForTests (${JSON.stringify(namers.map((f) => f.slice(REPO.length)))})`);
  const named = Object.keys(methods).filter((m) => /install|addon|remove_graphics|recover|accept/i.test(m));
  check(named.length === 0, `no RPC method installs, removes, recovers or accepts the add-on (${JSON.stringify(named)})`);
  // The agent's text (D7): the four refusals, ask the user, never install it.
  const codes = Object.values(CODES);
  const guide = readFileSync(join(REPO, "packages", "mcp", "src", "guide.ts"), "utf8");
  const instructions = guide.slice(guide.indexOf("export const PLATFORM_INSTRUCTIONS"), guide.indexOf("export const EDITING_GUIDE"));
  check(codes.every((c) => instructions.includes(c)) && instructions.includes("Ask them, and try again once they say it is done.") && instructions.includes("You cannot install, update or repair the add-on, and no tool can: never try"),
    "the MCP instructions name the four graphics_addon_* refusals, say to ask the user, and never to install the add-on");
  const skill = readFileSync(join(REPO, "packages", "skill-installer", "skill", "SKILL.md"), "utf8");
  check(codes.every((c) => skill.includes(`\`${c}\``)) && skill.includes("Never try to install, update or repair the add-on") && skill.includes("Help → Graphics add-on"),
    "SKILL.md names the four refusals, where the user installs the add-on, and never to install it");
  check(/Needs the Remotion graphics add-on, which only the user installs in the ZabsReel window \(Help → Graphics add-on\).*no tool can install it\.$/.test(methods.add_graphic.description),
    "add_graphic's description says the user installs the add-on and no tool can");
}

// ---- Z: the zip reader -----------------------------------------------------------------

// MUTATION: drop the zip64 checks (zip.ts) → the zip64 rows extract. Drop the encryption check → its row
// extracts. Drop the CRC comparison → the CRC row passes.
async function z1() {
  console.log("Z1. the zip reader...");
  const ok = join(root, "z1-ok.zip");
  writeFileSync(ok, makeZip([
    { name: "d/" },
    { name: "d/stored.txt", data: "stored", method: 0 },
    { name: "d/deflated.bin", data: "y".repeat(100_000), mode: 0o100755 },
    { name: "d/empty.txt", data: "", method: 0 },
    { name: "dos.txt", data: "dos", host: 0, mode: 0 },
  ]));
  const dest = join(root, "z1-ok");
  const files = await extractZip(ok, dest, { platform: "linux-x64", names: new NameSet("linux-x64"), prefix: "browser" });
  const mode = (p: string) => lstatSync(join(dest, p)).mode & 0o777;
  check(readFileSync(join(dest, "d/stored.txt"), "utf8") === "stored" && readFileSync(join(dest, "d/deflated.bin"), "utf8") === "y".repeat(100_000) && readFileSync(join(dest, "d/empty.txt"), "utf8") === ""
    && (mode("d/deflated.bin") & 0o111) !== 0 && (mode("d/stored.txt") & 0o111) === 0 && (mode("dos.txt") & 0o111) === 0 && files.length === 4 && files.find((x) => x.path === "d/deflated.bin")!.exec,
    `stored, deflated and empty entries hold their bytes; a Unix 0755 entry is executable, a 0644 or DOS one not (${files.map((x) => x.path).join(", ")})`);
  const cases: [string, Buffer, RegExp][] = [
    ["a zip64 end record (count 0xffff)", (() => { const z = makeZip([{ name: "a.txt", data: "a" }]); z.writeUInt16LE(0xffff, z.length - 12); z.writeUInt16LE(0xffff, z.length - 14); return z; })(), /a zip64 archive/],
    ["a zip64 locator", makeZip([{ name: "a.txt", data: "a" }], { zip64: true }), /a zip64 archive/],
    ["a zip64 extra field", makeZip([{ name: "a.txt", data: "a", extra: Buffer.from([1, 0, 0, 0]) }]), /"a\.txt": a zip64 entry/],
    ["an encrypted entry", makeZip([{ name: "a.txt", data: "a", flags: 1 }]), /"a\.txt": an encrypted entry/],
    ["another method (bzip2)", makeZip([{ name: "a.txt", data: "a", method: 12 }]), /"a\.txt": compression method 12/],
    ["a symlink", makeZip([{ name: "link", data: "/etc/passwd", mode: 0o120777 }]), /"link": a symlink/],
    ["a FIFO", makeZip([{ name: "fifo", mode: 0o010644 }]), /"fifo": a special file/],
    ["an entry with ..", makeZip([{ name: "../out.txt", data: "x" }]), /"\.\.\/out\.txt": a "\.\." segment/],
    ["an absolute entry", makeZip([{ name: "/abs.txt", data: "x" }]), /"\/abs\.txt": an absolute path/],
    ["a drive letter", makeZip([{ name: "C:/x.txt", data: "x" }]), /a ':' \(a drive letter or a stream\)/],
    ["a backslash", makeZip([{ name: "a\\..\\..\\x.txt", data: "x" }]), /a backslash/],
    ["a wrong CRC-32", makeZip([{ name: "a.txt", data: "a", crc: 1 }]), /"a\.txt": its size or CRC-32 does not match/],
  ];
  for (const [what, buf, want] of cases) {
    const zf = join(root, `z1-${what.replace(/\W+/g, "-")}.zip`);
    writeFileSync(zf, buf);
    const out = join(root, `z1-${what.replace(/\W+/g, "-")}`, "browser");
    const e = await thrown(() => extractZip(zf, out, { platform: "linux-x64", names: new NameSet("linux-x64"), prefix: "browser" }));
    check(e instanceof ArchiveRefusal && want.test(e.message) && !existsSync(join(dirname(out), "out.txt")), `${what}: refused (${e?.message})`);
  }
}

async function main() {
  try {
    p1();
    p2();
    p3();
    p4();
    p5();
    p6();
    p7();
    p8();
    c1();
    await c2c3();
    await c4();
    await c5();
    await c6();
    await c7();
    for (const e of engines) await e.storage.dispose();
    if (PLATFORM) {
      await startRegistry();
      try {
        await i1();
        await i2();
        await i3();
        await i4();
        await i5();
        await i6();
        await i7();
        await i8();
        await i9();
        await i10();
        await i11();
        await i12();
        await i13();
        i14();
      } finally {
        await stopRegistry();
      }
    } else console.log(`I. skip: ${process.platform}-${process.arch} has no add-on`);
    await z1();
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
