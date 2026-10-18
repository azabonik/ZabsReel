/**
 * @aive/core/addon: the graphics add-on for the UI hosts (ADDON-PLAN D1, D3).
 * The core reports the add-on's state; only the UI hosts install, recover or
 * remove it, and write the graphics renderer setting (renderer.ts), after the
 * user's click.
 */
export { addonPlatform, graphicsAddonDir, readGraphicsAddon, unsupportedMessage, type AddonManifest, type AddonPin, type GraphicsAddon, type GraphicsAddonState } from "./state.js";
export { devVariable, isSourceCheckout, type DevVariable } from "./resolve.js";
export {
  addonInstallerForTests,
  graphicsAddonBusy,
  installGraphicsAddon,
  recoverGraphicsAddon,
  removeGraphicsAddon,
  GraphicsAddonInstallError,
  type AddonSeams,
  type InstallFailure,
  type InstallOptions,
  type InstallProgress,
  type InstallVia,
} from "./install.js";
export { ADDON_REMOTION_VERSION } from "../motion/addonlock.js";
export { GRAPHICS_RENDERERS, graphicsRendererFile, readGraphicsRenderer, writeGraphicsRenderer, type GraphicsRenderer } from "./renderer.js";
export { graphicsAddonNotice, graphicsAddonTerms, remotionLicenseText, type GraphicsAddonTerms } from "./terms.js";
