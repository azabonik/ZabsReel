/**
 * The product's brand and runtime identity, for the installer.
 *
 * A hand-written copy of packages/core/src/brand.ts: the installer is published
 * on its own and does not depend on @aive/core. smoke-brand checks the copies
 * are equal.
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
export const DATA_DIR_PARTS = [".zabsreel", "data"];
/** Where `migrate` keeps its backups, relative to the home folder. */
export const BACKUP_DIR_PARTS = [".zabsreel", "backups"];

/**
 * The fork's previous identity. Used only to find and rename what it left
 * behind (migrate); never written anew.
 */
export const LEGACY = {
  productName: "SynthCut",
  id: "synthcut",
  mcpKey: "synthcut",
  skillName: "synthcut-editor",
  desktopPackage: "synthcut-desktop",
  dataDirParts: [".synthcut", "data"],
};
