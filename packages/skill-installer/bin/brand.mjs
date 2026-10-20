/**
 * The product's brand and runtime identity, for the installer.
 *
 * A hand-written copy of packages/core/src/brand.ts: the installer is published
 * on its own and does not depend on @aive/core. smoke-brand checks the copies
 * are equal.
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
export const DATA_DIR_PARTS = [".zedmix", "data"];
/** Where `migrate` keeps its backups, relative to the home folder. */
export const BACKUP_DIR_PARTS = [".zedmix", "backups"];

/**
 * The previous product identity (ZabsReel, through 0.2.0). Used only to find and rename what it left
 * behind (migrate); never written anew.
 */
export const LEGACY = {
  productName: "ZabsReel",
  id: "zabsreel",
  mcpKey: "zabsreel",
  skillName: "zabsreel-editor",
  desktopPackage: "zabsreel-desktop",
  dataDirParts: [".zabsreel", "data"],
};
