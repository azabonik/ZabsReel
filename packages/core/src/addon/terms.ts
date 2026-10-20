import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PRODUCT_NAME } from "../brand.js";
import { readFileSync } from "../io/gatedfs.js";
import { ADDON_PLATFORM_LISTS, ADDON_REMOTION_VERSION, HEADLESS_SHELL, type AddonPlatform } from "../motion/addonlock.js";

/**
 * What the user accepts before the graphics add-on downloads anything
 * (ADDON-PLAN D4.2): ZedMix's notice and Remotion's LICENSE.md as of the
 * v4.0.481 tag (the npm tarballs lack it). The add-on dialog shows both, and
 * the installer refuses unless it is given {@link GraphicsAddonTerms.sha256}.
 */

/**
 * Remotion's LICENSE.md at v4.0.481, shipped with the core as a data file
 * (packages/core/licenses, in the package's `files`): the same folder depth
 * from src/addon and dist/addon.
 */
const LICENSE_FILE = new URL(`../../licenses/remotion-${ADDON_REMOTION_VERSION}-LICENSE.md`, import.meta.url);

let license: string | undefined;
/** Remotion's licence text (line endings as committed: a Windows checkout's CRLF is read as LF). */
export function remotionLicenseText(): string {
  license ??= readFileSync(fileURLToPath(LICENSE_FILE), "utf8").replace(/\r\n/g, "\n");
  return license;
}

const mb = (bytes: number) => Math.max(1, Math.round(bytes / 1e6));

/** ZedMix's notice for `platform`, with that platform's download sizes. */
export function graphicsAddonNotice(platform: AddonPlatform): string {
  const packages = ADDON_PLATFORM_LISTS[platform].bytes ?? 0;
  const shell = HEADLESS_SHELL.platforms[platform].size;
  return [
    `Graphics in ${PRODUCT_NAME} use Remotion ${ADDON_REMOTION_VERSION}, which you install here as an add-on. Remotion is separate software under its own license, shown below. It is not part of ${PRODUCT_NAME} and is not covered by ${PRODUCT_NAME}'s GPL license.`,
    "Remotion is free for individuals, non-profit organizations and companies of up to three people. Larger companies need their own Remotion license.",
    `The install downloads about ${mb(packages)} MB of packages from registry.npmjs.org and the Chrome headless shell (about ${mb(shell)} MB) from Google, each under its own terms.`,
    "",
  ].join("\n\n");
}

export interface GraphicsAddonTerms {
  notice: string;
  license: string;
  /** sha256 of the notice followed by the licence: addon.json records it as licenseSha256. */
  sha256: string;
}

/** The notice and licence for `platform`, and the hash the installer requires. */
export function graphicsAddonTerms(platform: AddonPlatform): GraphicsAddonTerms {
  const notice = graphicsAddonNotice(platform);
  const text = remotionLicenseText();
  return { notice, license: text, sha256: createHash("sha256").update(notice + text).digest("hex") };
}
