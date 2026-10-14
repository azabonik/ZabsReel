/**
 * Which data folder this process uses. The app, the MCP server and the core
 * share one live core only because they all read <dataDir>/server.json, so
 * every process must pick the same folder. The rule depends only on files a
 * core writes, so processes started on their own still agree:
 *
 *   1. AIVE_DATA_DIR set: that folder, made absolute.
 *   2. The new folder holds state: the new folder.
 *   3. The old folder holds state: the old folder (nothing is moved).
 *   4. Otherwise: the new folder (created on first use).
 *
 * A folder holds state when a core has written server.json (on every start) or
 * projects.json (on save and load) in it. An empty folder, or one a test or a
 * stray mkdir made, does not count.
 *
 * apps/desktop/electron/brand.cjs is a CommonJS copy with the same rule and the
 * same reason strings; smoke-brand checks they agree.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DATA_DIR_PARTS, LEGACY } from "./brand.js";

/** True when <dir>/server.json or <dir>/projects.json exists as a regular file. */
export function holdsState(dir: string): boolean {
  for (const name of ["server.json", "projects.json"]) {
    try {
      if (statSync(join(dir, name)).isFile()) return true;
    } catch {
      // Missing or unreadable: does not count.
    }
  }
  return false;
}

/**
 * Resolve the data folder. `reason` says which rule chose it, for the one log
 * line each process prints ("data dir: <dir> (<reason>)").
 */
export function resolveDataDir(opts: { env?: Record<string, string | undefined>; home?: string } = {}): {
  dir: string;
  reason: string;
} {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  if (env.AIVE_DATA_DIR) return { dir: resolve(env.AIVE_DATA_DIR), reason: "AIVE_DATA_DIR" };
  const fresh = join(home, ...DATA_DIR_PARTS);
  const old = join(home, ...LEGACY.dataDirParts);
  if (holdsState(fresh)) {
    return { dir: fresh, reason: holdsState(old) ? `new (old folder also has data: ${old})` : "new" };
  }
  if (holdsState(old)) return { dir: old, reason: "legacy" };
  return { dir: fresh, reason: "default" };
}
