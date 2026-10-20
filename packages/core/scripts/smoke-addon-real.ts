/**
 * The graphics add-on's real install (ADDON-PLAN D8.2, R2). Opt-in: run in
 * verification, not in CI (it reads npm's cache and ~600 MB of zips).
 *
 * Offline (default), from a loopback registry (port 5032, AIVE_ADDON_REGISTRY)
 * that serves each lock `resolved` from npm's local cache by integrity and each
 * pinned zip from the cached folder (~/.cache/zedmix-addon/cft-<version>,
 * ZR_ADDON_ZIPS to override):
 *  R1. the sources   — every tarball of the four platform lists is in npm's
 *                      cache, and each pinned zip is in the folder with its
 *                      size and sha256.
 *  R2. linux-x64     — a full install into a scratch data folder is ready;
 *                      each of the 168 packages equals the checkout's
 *                      node_modules (npm's tree) file by file: bytes and
 *                      execute bits; the registry served each tarball and the
 *                      zip once; progress ends at the pinned total.
 *  R3. the zips      — the zip reader extracts all four pinned zips (each with
 *                      its platform's name rules); each tree's files equal
 *                      `unzip -Z1`'s, with zipinfo's execute bits.
 *  R4. other platforms — forced-platform installs of win32-x64, darwin-x64 and
 *                      darwin-arm64 (hashes, tar and zip) are ready for that
 *                      platform; the esbuild binary esbuild's own main.js
 *                      resolves there, and the compositor D2 names, exist (and
 *                      are executable off Windows): no install script needed.
 *  R5. the audit     — the win32 tree under a worst-case data folder
 *                      (C:\Users\<20 characters>\.zedmix\data\…), in the
 *                      longest folder the installer writes it to
 *                      (addons\.staging-<12 hex>\), stays within 259
 *                      characters, and holds no device name, trailing dot
 *                      or space, character Windows refuses, or two names that
 *                      differ only in case; the darwin trees hold no names that
 *                      differ only in case or Unicode form, and none whose NFC
 *                      and NFD forms differ.
 *  R6. the update    — a copy of the pin with one package moved to another
 *                      version: the update fetches exactly that tarball (the
 *                      browser and every other package are reused), progress
 *                      counts the reused bytes; back to the real pin, again
 *                      exactly one tarball.
 *  R7. the render    — a core (packages/core/dist/cli.js, scratch HOME and data
 *                      folder, no AIVE_REMOTION_ADDON, the renderer setting on
 *                      the add-on as the UI writes it) renders a graphic
 *                      through the installed add-on and its own Chrome for
 *                      Testing browser (a spawn trace names it), with the
 *                      system FFmpeg and with the FFmpeg matrix kit's 8.1
 *                      (~/.cache/<kit>/ffmpeg-builds/8.1/bin, or ZR_FFMPEG_81).
 *
 * --live (CI only: release.yml's Windows job, every run): the real installer
 * with Node's fetch against registry.npmjs.org and storage.googleapis.com into
 * a scratch data folder under RUNNER_TEMP (the system temp folder when it is
 * unset; never inside the checkout), then R7 once with AIVE_REMOTION_ADDON
 * unset. Never run it where the network is off limits.
 *
 * Needs the build (npm run build) for R7. Run:
 *   npx tsx packages/core/scripts/smoke-addon-real.ts [--live]
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, lstatSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { addonInstallerForTests, installGraphicsAddon, type InstallProgress } from "../src/addon/install.js";
import { writeGraphicsRenderer } from "../src/addon/renderer.js";
import { graphicsAddonDir, readGraphicsAddon, ADDON_PIN, type AddonPin, type GraphicsAddon } from "../src/addon/state.js";
import { graphicsAddonTerms } from "../src/addon/terms.js";
import { walkTree } from "../src/addon/tree.js";
import { extractZip } from "../src/addon/zip.js";
import { NameSet } from "../src/addon/names.js";
import { ADDON_CLOSURE, ADDON_PLATFORM_LISTS, ADDON_PLATFORMS, ADDON_REMOTION_VERSION, HEADLESS_SHELL, type AddonPlatform } from "../src/motion/addonlock.js";

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};

const LIVE = process.argv.includes("--live");
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = join(REPO, "packages", "core", "dist", "cli.js");
/** The real home (the test runs with a scratch HOME): npm's cache, the zips and the FFmpeg builds are read from there, read-only. */
const REAL_HOME = userInfo().homedir;
const ZIPS = process.env.ZR_ADDON_ZIPS ?? join(REAL_HOME, ".cache", "zedmix-addon", `cft-${HEADLESS_SHELL.version}`);
/** The matrix kit's FFmpeg 8.1 bin folder (~/.cache/<kit>/ffmpeg-builds/8.1/bin), or ZR_FFMPEG_81. */
function ffmpeg81(): string | null {
  if (process.env.ZR_FFMPEG_81) return process.env.ZR_FFMPEG_81;
  const cache = join(REAL_HOME, ".cache");
  const kits = existsSync(cache) ? readdirSync(cache).map((d) => join(cache, d, "ffmpeg-builds", "8.1", "bin")) : [];
  return kits.find((d) => existsSync(join(d, "ffmpeg"))) ?? null;
}
const REGISTRY_PORT = 5032;
const CORE_PORT = 5033;
/**
 * The scratch folder's parent: never inside the checkout. Another drive on
 * Windows gives an absolute relative path; a child folder named "..x" is
 * still inside.
 */
const TEMP = (LIVE && process.env.RUNNER_TEMP) || tmpdir();
const fromRepo = relative(REPO, TEMP);
const outsideRepo = isAbsolute(fromRepo) || fromRepo === ".." || fromRepo.startsWith(`..${sep}`);
if (!outsideRepo) throw new Error(`${TEMP} is inside the checkout: set RUNNER_TEMP (or TMPDIR) to a folder outside it`);
const root = mkdtempSync(join(TEMP, "aive-addon-real-"));
for (const v of ["AIVE_REMOTION_ADDON", "AIVE_REMOTION_BROWSER", "AIVE_ADDON_REGISTRY"]) delete process.env[v];

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const which = (bin: string) => execFileSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" }).split(/\r?\n/)[0].trim();

/** npm's cache file for an integrity (cacache content-v2). */
function cached(integrity: string): string {
  const [algo, b64] = integrity.split("-", 2) as [string, string];
  const hex = Buffer.from(b64, "base64").toString("hex");
  return join(REAL_HOME, ".npm", "_cacache", "content-v2", algo, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}
const zipFile = (p: AddonPlatform) => join(ZIPS, HEADLESS_SHELL.platforms[p].url.split("/").pop()!);

// ---- the loopback registry -------------------------------------------------------------

/** URL path → file served; and how often each path was asked for. */
const routes = new Map<string, string>();
const hits = new Map<string, number>();
const route = (url: string, file: string) => routes.set(new URL(url).pathname, file);
for (const e of ADDON_CLOSURE) route(e.resolved, cached(e.integrity));
for (const p of ADDON_PLATFORMS) route(HEADLESS_SHELL.platforms[p].url, zipFile(p));

function startRegistry(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const file = routes.get(path);
    if (!file || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-length": statSync(file).size });
    createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(REGISTRY_PORT, "127.0.0.1", () => r(server)));
}
const fetched = () => [...hits.entries()].filter(([, n]) => n > 0);

const install = async (dataDir: string, platform: AddonPlatform, pin: AddonPin = ADDON_PIN) => {
  const progress: InstallProgress[] = [];
  const opts = { fetch: globalThis.fetch, acceptedLicenseSha256: graphicsAddonTerms(platform).sha256, via: "web" as const, onProgress: (p: InstallProgress) => progress.push(p) };
  const native = platform === `${process.platform}-${process.arch}` && pin === ADDON_PIN;
  try {
    const got = native ? await installGraphicsAddon(dataDir, opts) : await addonInstallerForTests.install(dataDir, opts, { platform, pin });
    return { got, progress };
  } catch (err) {
    // A failed install is a failed row, not a crash: the state names the error.
    return { got: { state: `failed: ${(err as Error).message}` } as unknown as GraphicsAddon, progress };
  }
};

// ---- R1 ------------------------------------------------------------------------------

function r1() {
  console.log("R1. every tarball and zip is on this machine...");
  for (const p of ADDON_PLATFORMS) {
    const missing = ADDON_PLATFORM_LISTS[p].paths.filter((path) => !existsSync(cached(ADDON_CLOSURE.find((e) => e.path === path)!.integrity)));
    check(missing.length === 0, `${p}: all ${ADDON_PLATFORM_LISTS[p].count} tarballs are in npm's cache (${mb(ADDON_PLATFORM_LISTS[p].bytes ?? 0)})${missing.length ? `; missing ${missing.join(", ")}` : ""}`);
    const z = HEADLESS_SHELL.platforms[p];
    const f = zipFile(p);
    const ok = existsSync(f) && statSync(f).size === z.size && sha256(readFileSync(f)) === z.sha256;
    check(ok, `${p}: ${f.split(/[\\/]/).pop()} is in ${ZIPS} with the pinned size and sha256`);
  }
}

// ---- R2 ------------------------------------------------------------------------------

const lockKeys = new Set(Object.keys((JSON.parse(readFileSync(join(REPO, "package-lock.json"), "utf8")) as { packages: Record<string, unknown> }).packages));

/** A package folder's files by path → "sha256 exec", without its nested packages or .bin links. */
async function packageFiles(top: string, path: string): Promise<Map<string, string> | null> {
  const files = await walkTree(join(top, ...path.split("/")), (rel) => lockKeys.has(`${path}/${rel}`) || /(^|\/)node_modules\/\.bin$/.test(rel));
  return files && new Map(files.map((f) => [f.path, `${f.sha256} ${f.exec ? "x" : "-"}`]));
}

async function r2(dataDir: string) {
  console.log("R2. a full linux-x64 install equals npm's tree...");
  hits.clear();
  const t0 = Date.now();
  const { got, progress } = await install(dataDir, "linux-x64");
  const total = (ADDON_PLATFORM_LISTS["linux-x64"].bytes ?? 0) + HEADLESS_SHELL.platforms["linux-x64"].size;
  const last = progress[progress.length - 1];
  check(got.state === "ready" && readGraphicsAddon(dataDir).state === "ready", `the add-on is ready (${got.state}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const list = ADDON_PLATFORM_LISTS["linux-x64"].paths;
  const served = fetched();
  check(served.length === list.length + 1 && served.every(([, n]) => n === 1), `the registry served each of the ${list.length} tarballs and the zip once (${served.length} paths)`);
  check(last?.done === total && last.total === total && progress.every((p, i) => i === 0 || p.done >= progress[i - 1].done), `progress ends at the pinned total, ${mb(total)} (${last?.done} of ${last?.total})`);
  const dir = graphicsAddonDir(dataDir);
  let same = 0;
  const diffs: string[] = [];
  for (const path of list) {
    const ours = await packageFiles(join(dir), path);
    const npm = await packageFiles(REPO, path);
    if (!ours || !npm) {
      diffs.push(`${path}: ${!ours ? "ours" : "npm's"} can't be walked`);
      continue;
    }
    const keys = new Set([...ours.keys(), ...npm.keys()]);
    const bad = [...keys].filter((k) => ours.get(k) !== npm.get(k) && !(path === "node_modules/esbuild" && k === "bin/esbuild"));
    if (bad.length) diffs.push(`${path}: ${bad.slice(0, 3).map((k) => `${k} (ours ${ours.get(k)?.slice(-1) ?? "missing"}, npm ${npm.get(k)?.slice(-1) ?? "missing"})`).join(", ")}`);
    else same++;
  }
  check(diffs.length === 0 && same === 168, `all ${same} packages equal npm's file by file, bytes and execute bits${diffs.length ? `: ${diffs.slice(0, 5).join("; ")}` : ""}`);
  // esbuild's install script (npm ran it in this checkout) put its native binary over bin/esbuild; the add-on runs no
  // script and keeps the tarball's JavaScript launcher, which finds the same binary (R4).
  const esbuild = join(dir, "node_modules", "esbuild", "bin", "esbuild");
  const shim = existsSync(esbuild) ? readFileSync(esbuild) : Buffer.alloc(0);
  check(shim.subarray(0, 2).toString() === "#!" && (statSync(esbuild).mode & 0o111) !== 0,
    `esbuild's bin/esbuild is the tarball's executable launcher (${shim.subarray(0, 19).toString().trim()}), not an install script's binary`);
  const exe = join(dir, "browser", HEADLESS_SHELL.platforms["linux-x64"].executable);
  check(got.state === "ready" && got.browserExecutable === exe && existsSync(exe) && (statSync(exe).mode & 0o111) !== 0, `the browser is ${exe.replace(root, "<tmp>")}, executable`);
  return dir;
}

// ---- R3 ------------------------------------------------------------------------------

async function r3() {
  console.log("R3. the zip reader extracts the four pinned zips as unzip lists them...");
  for (const p of ADDON_PLATFORMS) {
    const dest = join(root, `zip-${p}`);
    const files = await extractZip(zipFile(p), dest, { platform: p, names: new NameSet(p), prefix: "browser" });
    const listing = execFileSync("unzip", ["-Z1", zipFile(p)], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").filter(Boolean);
    // zipinfo shows "x" on a FAT entry by its extension (.exe); only a Unix entry's mode carries an execute bit.
    const info = execFileSync("unzip", ["-Z", zipFile(p)], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").filter((l) => /^[-dl?][-rwxsStTa]{6,9}\s/.test(l));
    const execs = new Set(info.map((l) => l.split(/\s+/)).filter((f) => f[2] === "unx" && /^-\S*x/.test(f[0])).map((f) => f.slice(8).join(" ")));
    const onDisk = (await walkTree(dest))?.map((f) => f.path).sort() ?? [];
    const zipFiles = listing.filter((n) => !n.endsWith("/")).sort();
    const dirsOk = listing.filter((n) => n.endsWith("/")).every((n) => existsSync(join(dest, n)) && statSync(join(dest, n)).isDirectory());
    const execOk = files.every((f) => f.exec === execs.has(f.path));
    check(JSON.stringify(onDisk) === JSON.stringify(zipFiles) && dirsOk && execOk && listing.length === HEADLESS_SHELL.platforms[p].entries,
      `${p}: ${onDisk.length} files and the folders as unzip -Z1 lists them (${listing.length} entries), execute bits as zipinfo shows (${execs.size} executable)`);
    rmSync(dest, { recursive: true, force: true });
  }
}

// ---- R4, R5 --------------------------------------------------------------------------

const ARCH: Record<AddonPlatform, [string, string]> = { "win32-x64": ["win32", "x64"], "darwin-x64": ["darwin", "x64"], "darwin-arm64": ["darwin", "arm64"], "linux-x64": ["linux", "x64"] };

/** The binary esbuild's main.js (pkgAndSubpathForCurrentPlatform, then generateBinPath's require.resolve) finds in `dir` for `platform`. */
function esbuildBinary(dir: string, platform: AddonPlatform): string | null {
  const main = join(dir, "node_modules", "esbuild", "lib", "main.js");
  const text = readFileSync(main, "utf8");
  const start = text.indexOf("var knownWindowsPackages");
  const end = text.indexOf("function pkgForSomeOtherPlatform");
  if (start < 0 || end < start) return null;
  const [os, arch] = ARCH[platform];
  const got = vm.runInNewContext(`${text.slice(start, end)}\npkgAndSubpathForCurrentPlatform();`, { process: { platform: os }, os: { arch: () => arch, endianness: () => "LE" } }) as { pkg: string; subpath: string };
  try {
    return createRequire(main).resolve(`${got.pkg}/${got.subpath}`);
  } catch {
    return null;
  }
}

async function r4(platform: AddonPlatform): Promise<string | null> {
  const dataDir = mkdtempSync(join(root, `data-${platform}-`));
  hits.clear();
  const { got } = await install(dataDir, platform);
  const list = ADDON_PLATFORM_LISTS[platform];
  check(got.state === "ready" && readGraphicsAddon(dataDir, { platform }).state === "ready" && fetched().length === list.count + 1,
    `${platform}: a forced-platform install is ready (${got.state}), ${list.count} tarballs and the zip fetched (${fetched().length})`);
  const dir = graphicsAddonDir(dataDir);
  if (!existsSync(join(dir, "node_modules", "esbuild", "lib", "main.js"))) return null;
  const win = platform.startsWith("win32");
  const bin = esbuildBinary(dir, platform);
  const want = win ? "@esbuild/win32-x64/esbuild.exe" : `@esbuild/${platform}/bin/esbuild`;
  check(!!bin && bin === join(dir, "node_modules", ...want.split("/")) && existsSync(bin) && (win || (statSync(bin).mode & 0o111) !== 0),
    `${platform}: esbuild's main.js resolves ${want}, which exists${win ? "" : " and is executable"} (${bin?.replace(root, "<tmp>")})`);
  const comp = join(dir, "node_modules", ...list.compositor.split("/"));
  check(existsSync(comp) && (win || (statSync(comp).mode & 0o111) !== 0), `${platform}: the compositor ${list.compositor} exists${win ? "" : " and is executable"}`);
  return dir;
}

/** Every file and folder below `dir`, relative, `/`-separated. */
function allPaths(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(rel ? join(dir, rel) : dir)) {
    const r = rel ? `${rel}/${name}` : name;
    out.push(r);
    if (lstatSync(join(dir, r)).isDirectory()) out.push(...allPaths(dir, r));
  }
  return out;
}

/** Pairs of names in one folder that `fold` makes equal. */
function collisions(paths: string[], fold: (s: string) => string): string[] {
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const p of paths) {
    const i = p.lastIndexOf("/");
    const key = `${p.slice(0, i + 1)}\0${fold(p.slice(i + 1))}`;
    const had = seen.get(key);
    if (had !== undefined && had !== p) out.push(`${had} ~ ${p}`);
    seen.set(key, p);
  }
  return out;
}

function r5(trees: Partial<Record<AddonPlatform, string>>) {
  console.log("R5. the Windows and macOS trees...");
  const win = trees["win32-x64"];
  if (win) {
    // The tree sits in addons\.staging-<12 hex>\ while an install runs (as long as .removed-<12 hex>), then in
    // addons\remotion\<version>\: the longer of the folders the installer uses.
    const folder = [`.staging-${"0".repeat(12)}`, `remotion\\${ADDON_REMOTION_VERSION}`].sort((a, b) => b.length - a.length)[0];
    const prefix = `C:\\Users\\${"u".repeat(20)}\\.zedmix\\data\\addons\\${folder}\\`;
    const paths = allPaths(win);
    const longest = paths.map((p) => prefix + p.split("/").join("\\")).sort((a, b) => b.length - a.length)[0];
    check(longest.length <= 259, `win32-x64: ${paths.length} paths; the longest with a worst-case prefix (${folder}) is ${longest.length} characters (≤ 259): ${longest}`);
    const names = paths.map((p) => p.slice(p.lastIndexOf("/") + 1));
    const reserved = names.filter((n) => /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i.test(n));
    const trailing = names.filter((n) => /[. ]$/.test(n));
    const chars = names.filter((n) => /[<>:"|?*\u0000-\u001f]/.test(n));
    const cases = collisions(paths, (s) => s.toUpperCase());
    check(reserved.length + trailing.length + chars.length + cases.length === 0,
      `win32-x64: no device names (${reserved.length}), trailing dots or spaces (${trailing.length}), refused characters (${chars.length}) or case collisions (${cases.length})${[...reserved, ...trailing, ...chars, ...cases].slice(0, 5).map((x) => ` ${JSON.stringify(x)}`).join("")}`);
  }
  for (const p of ["darwin-x64", "darwin-arm64"] as const) {
    const dir = trees[p];
    if (!dir) continue;
    const paths = allPaths(dir);
    const cases = collisions(paths, (s) => s.normalize("NFC").toLowerCase());
    const forms = paths.filter((x) => x.normalize("NFC") !== x.normalize("NFD"));
    check(cases.length === 0 && forms.length === 0, `${p}: ${paths.length} paths; no case or Unicode-form collisions (${cases.length}), no names whose NFC and NFD forms differ (${forms.length})${[...cases, ...forms].slice(0, 5).map((x) => ` ${JSON.stringify(x)}`).join("")}`);
  }
}

// ---- R6 ------------------------------------------------------------------------------

/** The pin with `path` moved to the version npm's cache also holds (the index key gives its integrity). */
function movedPin(path: string, version: string, integrity: string): AddonPin {
  const at = ADDON_CLOSURE.find((e) => e.path === path)!;
  const resolved = at.resolved.replace(`-${at.version}.tgz`, `-${version}.tgz`);
  route(resolved, cached(integrity));
  const closure = ADDON_CLOSURE.map((e) => (e.path === path ? { ...e, version, resolved, integrity, bytes: statSync(cached(integrity)).size } : e));
  return { ...ADDON_PIN, lockSha256: sha256(Buffer.from(`moved ${path}@${version}`)), closure };
}

/** The integrity npm's cache index records for `url`. */
function indexIntegrity(url: string): string | null {
  const dir = join(REAL_HOME, ".npm", "_cacache", "index-v5");
  const key = `make-fetch-happen:request-cache:${url}`;
  const hex = createHash("sha256").update(key).digest("hex");
  const f = join(dir, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
  if (!existsSync(f)) return null;
  for (const line of readFileSync(f, "utf8").split("\n").reverse()) {
    const m = /^[0-9a-f]+\t(.*)$/.exec(line);
    if (!m) continue;
    const entry = JSON.parse(m[1]) as { key: string; integrity?: string };
    if (entry.key === key && entry.integrity) return entry.integrity;
  }
  return null;
}

async function r6(dataDir: string) {
  console.log("R6. an update after a one-package change fetches only that tarball...");
  const path = "node_modules/@jridgewell/sourcemap-codec";
  const version = "1.6.0";
  const url = ADDON_CLOSURE.find((e) => e.path === path)!.resolved.replace(/-[^-]+\.tgz$/, `-${version}.tgz`);
  const integrity = indexIntegrity(url);
  if (!integrity || !existsSync(cached(integrity))) {
    check(false, `npm's cache holds ${url} (the update row's other version)`);
    return;
  }
  const pin = movedPin(path, version, integrity);
  for (const [what, p, want] of [[`${path}@${version}`, pin, url], [`back to the real pin`, ADDON_PIN, ADDON_CLOSURE.find((e) => e.path === path)!.resolved]] as const) {
    hits.clear();
    const { got, progress } = await install(dataDir, "linux-x64", p);
    const last = progress[progress.length - 1];
    const served = fetched();
    const pkgFile = join(graphicsAddonDir(dataDir), ...path.split("/"), "package.json");
    const pkg = (existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, "utf8")) : { version: "missing" }) as { version: string };
    check(got.state === "ready" && readGraphicsAddon(dataDir, { pin: p }).state === "ready" && served.length === 1 && served[0][0] === new URL(want).pathname && served[0][1] === 1,
      `${what}: ready, and the registry served exactly ${new URL(want).pathname.split("/").pop()} (${JSON.stringify(served)})`);
    check(pkg.version === (p === ADDON_PIN ? ADDON_CLOSURE.find((e) => e.path === path)!.version : version) && last?.done === last?.total,
      `${what}: the package is ${pkg.version}; progress counts the reused bytes (${last?.done} of ${last?.total})`);
  }
}

// ---- R7 ------------------------------------------------------------------------------

interface Core {
  child: ChildProcess;
  base: string;
  token: string;
  stderr: string[];
  cwd: string;
}

/** A preload that records every child_process spawn's command and arguments (puppeteer launches the browser with spawn; on Linux chromeguard.ts starts it through setpriv). */
function writeTrace(file: string): string {
  const pre = join(root, "spawn-trace.mjs");
  writeFileSync(pre, [
    `import cp from "node:child_process";`,
    `import { appendFileSync } from "node:fs";`,
    `import { syncBuiltinESMExports } from "node:module";`,
    `for (const fn of ["spawn", "execFile", "fork"]) {`,
    `  const real = cp[fn];`,
    `  cp[fn] = function (cmd, ...rest) { appendFileSync(${JSON.stringify(file)}, JSON.stringify({ fn, cmd: [String(cmd), ...(Array.isArray(rest[0]) ? rest[0].map(String) : [])] }) + "\\n"); return real.call(this, cmd, ...rest); };`,
    `}`,
    `syncBuiltinESMExports();`,
  ].join("\n"));
  return pre;
}

async function startCore(dataDir: string, ffmpegDir: string | null, trace: string): Promise<Core> {
  const home = mkdtempSync(join(root, "home-"));
  const cwd = mkdtempSync(join(root, "cwd-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), AIVE_DATA_DIR: dataDir, AIVE_PORT: String(CORE_PORT), AIVE_STORAGE_GC_DELAY_MS: "-1" };
  for (const v of ["AIVE_REMOTION_ADDON", "AIVE_REMOTION_BROWSER", "AIVE_ADDON_REGISTRY"]) delete env[v];
  const exe = process.platform === "win32" ? ".exe" : "";
  env.AIVE_FFMPEG = ffmpegDir ? join(ffmpegDir, `ffmpeg${exe}`) : process.env.AIVE_FFMPEG ?? which("ffmpeg");
  env.AIVE_FFPROBE = ffmpegDir ? join(ffmpegDir, `ffprobe${exe}`) : process.env.AIVE_FFPROBE ?? which("ffprobe");
  const child = spawn(process.execPath, ["--import", pathToFileURL(writeTrace(trace)).href, CLI], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const stderr: string[] = [];
  child.stderr!.on("data", (d) => stderr.push(...String(d).split("\n").filter(Boolean)));
  const ready = await new Promise<{ port: number; token: string }>((res, rej) => {
    let buf = "";
    const timer = setTimeout(() => rej(new Error(`the core did not start: ${stderr.join("\n")}`)), 60_000);
    child.stdout!.on("data", (d) => {
      buf += String(d);
      for (const line of buf.split("\n")) {
        try {
          const m = JSON.parse(line) as { event?: string; port: number; token: string };
          if (m.event === "ready") {
            clearTimeout(timer);
            res(m);
          }
        } catch {
          /* a log line */
        }
      }
    });
    child.on("exit", (c) => rej(new Error(`the core exited (${c}): ${stderr.join("\n")}`)));
  });
  return { child, base: `http://127.0.0.1:${ready.port}`, token: ready.token, stderr, cwd };
}

async function rpc(core: Core, method: string, params: unknown = {}) {
  const res = await fetch(`${core.base}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-aive-token": core.token },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(600_000),
  });
  return { status: res.status, ...((await res.json()) as { ok: boolean; result?: any; error?: string; code?: string }) };
}

async function stopCore(core: Core) {
  if (core.child.exitCode !== null || core.child.signalCode !== null) return;
  core.child.kill();
  await new Promise((r) => core.child.once("exit", r));
}

async function r7(dataDir: string, ffmpegDir: string | null, label: string) {
  // The user chose the add-on as the graphics renderer (the UI hosts write renderer.json); ZedMix's own renderer is the default.
  await writeGraphicsRenderer(dataDir, "remotion");
  const trace = join(root, `spawns-${label.replace(/\W+/g, "-")}.jsonl`);
  const core = await startCore(dataDir, ffmpegDir, trace);
  try {
    const state = await rpc(core, "get_state");
    const graphics = (state.result as { graphics?: string } | undefined)?.graphics;
    const t0 = Date.now();
    const r = await rpc(core, "add_graphic", { template: "title", durationSeconds: 1, props: { title: "Add-on", subtitle: label } });
    const assetId = (r.result as { assetId?: string } | undefined)?.assetId;
    const after = await rpc(core, "get_state");
    const assetPath = (after.result as { assets?: { id: string; path: string }[] } | undefined)?.assets?.find((a) => a.id === assetId)?.path;
    const exe = readGraphicsAddon(dataDir).state === "ready" ? (readGraphicsAddon(dataDir) as { browserExecutable: string }).browserExecutable : "";
    const spawns = existsSync(trace) ? readFileSync(trace, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { cmd: string[] }).cmd) : [];
    const browsers = spawns.flat().filter((a) => /chrome/i.test(a) && !a.startsWith("-"));
    const ffprobe = ffmpegDir ? join(ffmpegDir, `ffprobe${process.platform === "win32" ? ".exe" : ""}`) : process.env.AIVE_FFPROBE ?? which("ffprobe");
    const probed = assetPath && existsSync(assetPath) ? (JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", assetPath], { encoding: "utf8" })) as { streams: { codec_type: string }[] }) : null;
    const streams = probed?.streams.map((x) => x.codec_type).join(",") ?? "";
    check(graphics === "ready" && r.ok && streams === "video", `${label}: get_state says graphics ready (${graphics}); add_graphic rendered ${assetPath ? assetPath.split(/[\\/]/).pop() : "nothing"} (streams: ${streams || "none"}) in ${((Date.now() - t0) / 1000).toFixed(1)} s${r.ok ? "" : ` — ${r.status} ${r.code ?? ""} ${r.error?.slice(0, 300)}`}`);
    check(!!exe && browsers.length > 0 && browsers.every((a) => a === exe),
      `${label}: the only browser the core started is the add-on's own (${exe.replace(root, "<tmp>")}; ${browsers.length} start(s)${browsers.some((a) => a !== exe) ? `, others: ${browsers.filter((a) => a !== exe).join(" ")}` : ""})`);
    check(!existsSync(join(core.cwd, "node_modules", ".remotion")), `${label}: Remotion made no browser cache of its own in the core's folder`);
  } finally {
    await stopCore(core);
  }
}

// ---- main ----------------------------------------------------------------------------

async function offline() {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: run npm run build first`);
  r1();
  const server = await startRegistry();
  process.env.AIVE_ADDON_REGISTRY = `http://127.0.0.1:${REGISTRY_PORT}`;
  try {
    const dataDir = mkdtempSync(join(root, "data-linux-x64-"));
    await r2(dataDir);
    await r3();
    const trees: Partial<Record<AddonPlatform, string>> = {};
    console.log("R4. forced-platform installs of the other platforms...");
    for (const p of ["win32-x64", "darwin-x64", "darwin-arm64"] as const) trees[p] = (await r4(p)) ?? undefined;
    r5(trees);
    // <data>/addons/remotion/<version> → <data>
    for (const d of Object.values(trees)) if (d) rmSync(dirname(dirname(dirname(d))), { recursive: true, force: true });
    await r6(dataDir);
    delete process.env.AIVE_ADDON_REGISTRY;
    console.log("R7. a real graphic through the installed add-on...");
    await r7(dataDir, null, "system FFmpeg");
    const v81 = ffmpeg81();
    if (v81) await r7(dataDir, v81, "FFmpeg 8.1");
    else check(false, "the FFmpeg matrix kit's 8.1 build is on this machine (or set ZR_FFMPEG_81)");
  } finally {
    server.close();
  }
}

async function live() {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: run npm run build first`);
  const platform = `${process.platform}-${process.arch}` as AddonPlatform;
  console.log(`L1. the real install for ${platform} from registry.npmjs.org and storage.googleapis.com...`);
  const dataDir = mkdtempSync(join(root, "data-live-"));
  const t0 = Date.now();
  const got = await installGraphicsAddon(dataDir, { fetch: globalThis.fetch, acceptedLicenseSha256: graphicsAddonTerms(platform).sha256, via: "web" });
  check(got.state === "ready", `the add-on is ready (${got.state}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log("L2. a real graphic through it, AIVE_REMOTION_ADDON unset...");
  await r7(dataDir, null, "live");
}

async function main() {
  try {
    if (LIVE) await live();
    else await offline();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nALL REAL ADD-ON CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
});
