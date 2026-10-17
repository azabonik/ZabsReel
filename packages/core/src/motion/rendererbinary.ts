import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { corePackageDir, isSourceCheckout } from "../addon/resolve.js";
import { existsSync, realpathNative } from "../io/gatedfs.js";

/**
 * Which executable runs ZabsReel's motion renderer (MOTION-PLAN D2, ruling
 * D-LAUNCH-3). "Packaged or source checkout" is decided by isSourceCheckout()
 * alone, never by process.versions.electron (under `electron .` the core runs
 * under Electron too):
 * - packaged: the core always runs under the app's own Electron in Node mode,
 *   so the executable is process.execPath (ZabsReel.exe, the .app's
 *   Contents/MacOS binary, zabsreel-desktop), started with only the flag:
 *   main.cjs dispatches on it before anything else. Without an Electron
 *   version there is no binary;
 * - source checkout (dev desktop, web shell, tests): the Electron binary
 *   (process.execPath when the core runs under Electron, else what
 *   require("electron") names, from <repo>/apps/desktop), with
 *   <repo>/apps/desktop as the app path, so it loads main.cjs and not
 *   Electron's default_app; <repo> is two folders above the core's package.
 * The spawn's environment and further arguments are rendermotion.ts's.
 */

/** The flag main.cjs dispatches on. */
export const RENDERER_FLAG = "--zr-motion-renderer";

export type RendererBinary = { ok: true; command: string; args: string[] } | { ok: false; reason: "no-binary"; detail: string };

/** Test seams (the fixture-layout rows of smoke-renderer.ts). */
export interface RendererBinaryOptions {
  /** A file of the core (default: this module). */
  from?: string;
  execPath?: string;
  /** process.versions.electron; pass the key with undefined for "not under Electron". */
  electronVersion?: string;
  /** What require("electron") gives, resolved from the desktop app's folder; throws when it fails. */
  requireElectron?: (desktopDir: string) => unknown;
}

const nodeRequireElectron = (desktopDir: string): unknown => createRequire(join(desktopDir, "package.json"))("electron");

export function rendererBinary(opts: RendererBinaryOptions = {}): RendererBinary {
  const execPath = opts.execPath ?? process.execPath;
  const electron = "electronVersion" in opts ? opts.electronVersion : process.versions.electron;
  const none = (detail: string): RendererBinary => ({ ok: false, reason: "no-binary", detail });

  if (!isSourceCheckout(opts.from)) {
    if (!electron) return none("this packaged core is not running under the app's Electron");
    if (!existsSync(execPath)) return none(`the app executable ${execPath} is missing`);
    return { ok: true, command: execPath, args: [RENDERER_FLAG] };
  }

  const core = corePackageDir(opts.from);
  if (core === undefined) return none("the core's package folder was not found");
  const desktop = join(dirname(dirname(realpathNative(core))), "apps", "desktop");
  if (!existsSync(join(desktop, "electron", "main.cjs"))) return none(`${join(desktop, "electron", "main.cjs")} is missing`);
  let binary: unknown = execPath;
  if (!electron) {
    try {
      binary = (opts.requireElectron ?? nodeRequireElectron)(desktop);
    } catch (err) {
      return none(`require("electron") failed: ${(err as Error).message}`);
    }
  }
  if (typeof binary !== "string" || !existsSync(binary)) return none(`the Electron binary ${String(binary)} is missing`);
  return { ok: true, command: binary, args: [desktop, RENDERER_FLAG] };
}
