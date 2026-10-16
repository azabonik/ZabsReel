/**
 * @aive/core/addon: the graphics add-on for the UI hosts (ADDON-PLAN D1, D3).
 * The core reports the add-on's state; only the UI hosts install, recover or
 * remove it, after the user's click.
 */
export { addonPlatform, graphicsAddonDir, readGraphicsAddon, type AddonManifest, type GraphicsAddon, type GraphicsAddonState } from "./state.js";
export { devVariable, isSourceCheckout, type DevVariable } from "./resolve.js";
