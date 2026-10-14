/**
 * The product's brand and runtime identity: one source of truth for the name,
 * the id, the MCP client key, the skill name, the app id and the data folders.
 *
 * Pure constants with no Node imports, so the desktop renderer can bundle it.
 * The data-dir resolver that uses these folders lives in datadir.ts (Node only).
 *
 * Two hand-written copies must stay equal to this file (smoke-brand checks it):
 *   - apps/desktop/electron/brand.cjs (the Electron main process and launcher)
 *   - packages/skill-installer/bin/brand.mjs (the installer, published alone)
 *
 * The internal "aive" codename (@aive/*, AIVE_*, .aive, ~/.aive) is not part of
 * the brand and stays as it is.
 */

export const PRODUCT_NAME = "ZabsReel";
export const PRODUCT_ID = "zabsreel";
/** The server key written into AI client configs (mcpServers.<key>). */
export const MCP_KEY = "zabsreel";
export const SKILL_NAME = "zabsreel-editor";
/** Electron appId and Windows AUMID; frozen after the first release. */
export const APP_ID = "io.github.azabonik.zabsreel";
export const APP_ID_DEV = "io.github.azabonik.zabsreel.dev";
/** The desktop workspace's package name (also the Linux executable name). */
export const DESKTOP_PACKAGE = "zabsreel-desktop";
export const GITHUB_REPO = "azabonik/ZabsReel";
/** Default data folder, relative to the home folder. */
export const DATA_DIR_PARTS = [".zabsreel", "data"] as const;
/** Where `migrate` keeps its backups, relative to the home folder. */
export const BACKUP_DIR_PARTS = [".zabsreel", "backups"] as const;

/**
 * The fork's previous identity. Used only to find and rename what it left
 * behind (migrate) and as the data-dir fallback; never written anew.
 */
export const LEGACY = {
  productName: "SynthCut",
  id: "synthcut",
  mcpKey: "synthcut",
  skillName: "synthcut-editor",
  desktopPackage: "synthcut-desktop",
  dataDirParts: [".synthcut", "data"],
} as const;
