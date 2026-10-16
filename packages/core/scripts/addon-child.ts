/**
 * A second process for smoke-addon's installer rows: it installs a fixture
 * add-on and stops just before addon.json is written, so the smoke can kill
 * it there (a crash or power loss mid-install).
 *
 *   before-manifest <dataDir> <pin.json> <registry> <marker>
 *       install from the loopback registry; once the rewrite-target check has
 *       passed, write <marker> (this pid) and wait to be killed
 *
 * Not a smoke on its own (smoke-addon.ts starts it).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { addonInstallerForTests } from "../src/addon/install.js";
import { addonPlatform, type AddonPin } from "../src/addon/state.js";
import { graphicsAddonTerms } from "../src/addon/terms.js";

const [mode, dataDir, pinFile, registry, marker] = process.argv.slice(2);
if (mode !== "before-manifest") throw new Error(`unknown mode ${mode}`);
const pin = JSON.parse(readFileSync(pinFile, "utf8")) as AddonPin;
const platform = addonPlatform()!;
await addonInstallerForTests.install(
  dataDir,
  { fetch: globalThis.fetch, acceptedLicenseSha256: graphicsAddonTerms(platform).sha256, via: "desktop" },
  {
    pin,
    env: { AIVE_ADDON_REGISTRY: registry },
    beforeManifest: async () => {
      writeFileSync(marker, String(process.pid));
      setInterval(() => {}, 1000); // stay alive until killed
      await new Promise(() => {});
    },
  },
);
console.log(JSON.stringify({ error: "the install finished" }));
