// The product's brand and runtime identity, and the data-dir resolver, for the
// Electron main process, core-launcher.cjs and (through it) web/server.cjs.
//
// A hand-written CommonJS copy of packages/core/src/brand.ts and datadir.ts:
// the same constants, the same rule and the same reason strings. smoke-brand
// checks they agree. The launcher does not require("@aive/core/...") for these,
// so core's exports map cannot break it.
//
// Electron-free on purpose, like core-launcher.cjs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PRODUCT_NAME = "ZedMix";
const PRODUCT_ID = "zedmix";
// The server key written into AI client configs (mcpServers.<key>).
const MCP_KEY = "zedmix";
const SKILL_NAME = "zedmix-editor";
// Electron appId and Windows AUMID. Keep it fixed: a new id installs beside the old app instead of upgrading it (this happened once, after 0.2.0).
const APP_ID = "io.github.azabonik.zedmix";
const APP_ID_DEV = "io.github.azabonik.zedmix.dev";
// The desktop workspace's package name (also the Linux executable name).
const DESKTOP_PACKAGE = "zedmix-desktop";
const GITHUB_REPO = "azabonik/ZedMix";
// Default data folder, relative to the home folder.
const DATA_DIR_PARTS = [".zedmix", "data"];
// Where `migrate` keeps its backups, relative to the home folder.
const BACKUP_DIR_PARTS = [".zedmix", "backups"];

// The previous product identity (ZabsReel, through 0.2.0). Used only to find and rename what it left
// behind (migrate) and as the data-dir fallback; never written anew.
const LEGACY = {
  productName: "ZabsReel",
  id: "zabsreel",
  mcpKey: "zabsreel",
  skillName: "zabsreel-editor",
  desktopPackage: "zabsreel-desktop",
  dataDirParts: [".zabsreel", "data"],
};

// True when <dir>/server.json or <dir>/projects.json exists as a regular file.
// A core writes server.json on every start and projects.json on save and load;
// an empty folder, or one a test or a stray mkdir made, does not count.
function holdsState(dir) {
  for (const name of ["server.json", "projects.json"]) {
    try {
      if (fs.statSync(path.join(dir, name)).isFile()) return true;
    } catch {
      // Missing or unreadable: does not count.
    }
  }
  return false;
}

// Which data folder this process uses: AIVE_DATA_DIR (made absolute), else the
// new folder if it holds state, else the old folder if it holds state (nothing
// is moved), else the new folder. Returns { dir, reason }; the reason is for
// the one log line each process prints ("data dir: <dir> (<reason>)").
function resolveDataDir(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  if (env.AIVE_DATA_DIR) return { dir: path.resolve(env.AIVE_DATA_DIR), reason: "AIVE_DATA_DIR" };
  const fresh = path.join(home, ...DATA_DIR_PARTS);
  const old = path.join(home, ...LEGACY.dataDirParts);
  if (holdsState(fresh)) {
    return { dir: fresh, reason: holdsState(old) ? `new (old folder also has data: ${old})` : "new" };
  }
  if (holdsState(old)) return { dir: old, reason: "legacy" };
  return { dir: fresh, reason: "default" };
}

module.exports = {
  PRODUCT_NAME,
  PRODUCT_ID,
  MCP_KEY,
  SKILL_NAME,
  APP_ID,
  APP_ID_DEV,
  DESKTOP_PACKAGE,
  GITHUB_REPO,
  DATA_DIR_PARTS,
  BACKUP_DIR_PARTS,
  LEGACY,
  holdsState,
  resolveDataDir,
};
