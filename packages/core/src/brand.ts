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

export const PRODUCT_NAME = "ZedMix";
export const PRODUCT_ID = "zedmix";
/** The server key written into AI client configs (mcpServers.<key>). */
export const MCP_KEY = "zedmix";
export const SKILL_NAME = "zedmix-editor";
/** Electron appId and Windows AUMID. Keep it fixed: a new id installs beside the old app instead of upgrading it (this happened once, after 0.2.0). */
export const APP_ID = "io.github.azabonik.zedmix";
export const APP_ID_DEV = "io.github.azabonik.zedmix.dev";
/** The desktop workspace's package name (also the Linux executable name). */
export const DESKTOP_PACKAGE = "zedmix-desktop";
export const GITHUB_REPO = "azabonik/ZedMix";
/** Default data folder, relative to the home folder. */
export const DATA_DIR_PARTS = [".zedmix", "data"] as const;
/** Where `migrate` keeps its backups, relative to the home folder. */
export const BACKUP_DIR_PARTS = [".zedmix", "backups"] as const;

/**
 * The previous product identity (ZabsReel, through 0.2.0). Used only to find and rename what it left
 * behind (migrate) and as the data-dir fallback; never written anew.
 */
export const LEGACY = {
  productName: "ZabsReel",
  id: "zabsreel",
  mcpKey: "zabsreel",
  skillName: "zabsreel-editor",
  desktopPackage: "zabsreel-desktop",
  dataDirParts: [".zabsreel", "data"],
} as const;
