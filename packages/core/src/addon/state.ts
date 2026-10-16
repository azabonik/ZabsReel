import { join, posix, relative, win32, isAbsolute } from "node:path";
import { existsSync, readdirSync, readFileSync, realpathNative } from "../io/gatedfs.js";
import { ADDON_LOCK_SHA256, ADDON_PLATFORM_LISTS, ADDON_PLATFORMS, ADDON_REMOTION_VERSION, type AddonPlatform } from "../motion/addonlock.js";

/**
 * The graphics add-on on disk (ADDON-PLAN D1): the pinned Remotion tree and
 * headless shell the user installs from a UI host into
 * `<dataDir>/addons/remotion/<version>/`, and its state, read only.
 *
 * - "ready": addon.json matches this build's pin and platform, and the key
 *   files exist (the renderer's ESM build, the bundler, the platform's
 *   compositor and the browser executable, which stays inside browser/);
 * - "update-needed": addon.json (or another version's) is from another pin;
 * - "broken": addon.json matches, but a key file is missing, or the browser
 *   executable leaves browser/;
 * - "not-installed": no addon.json, or it does not parse;
 * - "unsupported": this platform has no add-on (nothing on disk is read).
 */
export type GraphicsAddonState = "ready" | "not-installed" | "update-needed" | "broken" | "unsupported";

/** addon.json, written last by the installer. */
export interface AddonManifest {
  schema: 1;
  remotion: string;
  lockSha256: string;
  platform: AddonPlatform;
  /** Relative to the add-on's browser/ folder. */
  browserExecutable: string;
  licenseSha256: string;
  acceptedAt: string;
  installedAt: string;
  via: "desktop" | "web";
}

/** What {@link readGraphicsAddon} found; `installedAt` whenever addon.json parsed. */
export type GraphicsAddon =
  | { state: "ready"; dir: string; installedAt: unknown; browserExecutable: string }
  | { state: Exclude<GraphicsAddonState, "ready">; dir?: string; installedAt?: unknown };

/** The installed add-on's folder for this build's Remotion. */
export function graphicsAddonDir(dataDir: string): string {
  return join(dataDir, "addons", "remotion", ADDON_REMOTION_VERSION);
}

let glibc: boolean | undefined;
/** True when this Linux runs glibc (Chrome for Testing's linux64 build needs it). */
function hasGlibc(): boolean {
  glibc ??= !!(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime;
  return glibc;
}

/** This platform as the pin names it, or null when the add-on isn't offered here. `key`: a test seam. */
export function addonPlatform(key = `${process.platform}-${process.arch}`): AddonPlatform | null {
  if (!(ADDON_PLATFORMS as readonly string[]).includes(key)) return null;
  if (key === "linux-x64" && !hasGlibc()) return null;
  return key as AddonPlatform;
}

/** This platform as a message names it. */
export function platformLabel(key = `${process.platform}-${process.arch}`): string {
  return key === "linux-x64" && !hasGlibc() ? "linux-x64 without glibc" : key;
}

/** addon.json at `file` as an object, or undefined when it is missing or does not parse. */
function readManifest(file: string): Record<string, unknown> | undefined {
  try {
    const m: unknown = JSON.parse(readFileSync(file, "utf8"));
    return m !== null && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** True when another version's folder holds an addon.json (a ZabsReel update moved the pin). */
function otherVersion(dataDir: string): boolean {
  try {
    return readdirSync(join(dataDir, "addons", "remotion"))
      .filter((v) => v !== ADDON_REMOTION_VERSION)
      .some((v) => readManifest(join(dataDir, "addons", "remotion", v, "addon.json")) !== undefined);
  } catch {
    return false;
  }
}

/** True when `child` is `parent` or below it. */
const inside = (parent: string, child: string) => {
  const r = relative(parent, child);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
};

/**
 * The browser executable addon.json names, as an absolute path inside
 * `<dir>/browser`, or null when it leaves that folder: not a string, absolute
 * (either platform's form, or a drive letter), a ".." segment, a link
 * whose real path is outside browser/, or a browser/ that is itself a link
 * out of the add-on's folder. A missing file is the caller's
 * key-file check.
 */
function browserPath(dir: string, rel: unknown): string | null {
  if (typeof rel !== "string" || rel === "" || rel.includes("\0")) return null;
  if (posix.isAbsolute(rel) || win32.isAbsolute(rel) || /^[a-z]:/i.test(rel)) return null;
  if (rel.split(/[\\/]/).some((s) => s === "..")) return null;
  const browser = join(dir, "browser");
  const exe = join(browser, rel);
  if (!inside(browser, exe)) return null;
  let real: string;
  try {
    real = realpathNative(exe);
  } catch {
    return exe;
  }
  try {
    const realBrowser = realpathNative(browser);
    return inside(realpathNative(dir), realBrowser) && inside(realBrowser, real) ? exe : null;
  } catch {
    return null;
  }
}

/** The add-on's state in `dataDir` (D1). `platform`: a test seam for the platform key. */
export function readGraphicsAddon(dataDir: string, opts: { platform?: string } = {}): GraphicsAddon {
  const platform = addonPlatform(opts.platform);
  if (!platform) return { state: "unsupported" };
  const dir = graphicsAddonDir(dataDir);
  const m = readManifest(join(dir, "addon.json"));
  if (!m) return { state: otherVersion(dataDir) ? "update-needed" : "not-installed", dir };
  const installedAt = m.installedAt;
  if (m.schema !== 1 || m.remotion !== ADDON_REMOTION_VERSION || m.lockSha256 !== ADDON_LOCK_SHA256 || m.platform !== platform) {
    return { state: "update-needed", dir, installedAt };
  }
  const exe = browserPath(dir, m.browserExecutable);
  const modules = join(dir, "node_modules");
  const keys = [
    join(modules, "@remotion", "renderer", "dist", "esm", "index.mjs"),
    join(modules, "@remotion", "bundler", "package.json"),
    join(modules, ...ADDON_PLATFORM_LISTS[platform].compositor.split("/")),
  ];
  if (exe === null || ![...keys, exe].every((k) => existsSync(k))) return { state: "broken", dir, installedAt };
  return { state: "ready", dir, installedAt, browserExecutable: exe };
}
