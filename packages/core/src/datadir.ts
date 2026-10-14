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
 *
 * It runs before any engine exists, on folders the environment chose, so it
 * reads through the network-path gate's bootstrap (io/gatedfs.ts). A data
 * folder on a network computer is allowed; a Windows device / NT path or a
 * server name with no key (unc.ts) is refused here, at startup, because every
 * later read and write in it would be refused.
 */
import { bootstrap } from "./io/gatedfs.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DATA_DIR_PARTS, LEGACY, PRODUCT_NAME } from "./brand.js";
import { classifyPath } from "./unc.js";

/** True when <dir>/server.json or <dir>/projects.json exists as a regular file. */
export function holdsState(dir: string): boolean {
  for (const name of ["server.json", "projects.json"]) {
    try {
      if (bootstrap.statSync(join(dir, name)).isFile()) return true;
    } catch {
      // Missing or unreadable: does not count.
    }
  }
  return false;
}

/**
 * Throw when any of `paths` (a folder as given and as resolved) is a form
 * unc.ts refuses, with a message that says how to fix it. `what` names the
 * setting at the start of the message.
 */
function assertUsable(what: string, ...paths: string[]): void {
  for (const p of paths) {
    const c = classifyPath(p);
    if (c.kind === "refused") {
      throw new Error(
        `${what} can't be the ${PRODUCT_NAME} data folder: ${c.reason} Set AIVE_DATA_DIR to a folder on a drive letter or a \\\\server\\share path, and start ${PRODUCT_NAME} again.`,
      );
    }
  }
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
  if (env.AIVE_DATA_DIR) {
    const dir = resolve(env.AIVE_DATA_DIR);
    assertUsable(`AIVE_DATA_DIR "${env.AIVE_DATA_DIR}"`, env.AIVE_DATA_DIR, dir);
    return { dir, reason: "AIVE_DATA_DIR" };
  }
  const fresh = join(home, ...DATA_DIR_PARTS);
  const old = join(home, ...LEGACY.dataDirParts);
  assertUsable(`The home folder "${home}"`, home, fresh, old);
  if (holdsState(fresh)) {
    return { dir: fresh, reason: holdsState(old) ? `new (old folder also has data: ${old})` : "new" };
  }
  if (holdsState(old)) return { dir: old, reason: "legacy" };
  return { dir: fresh, reason: "default" };
}
