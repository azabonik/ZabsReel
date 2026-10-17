// electron-builder afterPack hook: the packaging gate (ADDON-PLAN D6). Runs
// scripts/check-no-remotion.mjs on the packed app folder before any installer
// or zip is made from it, for every build (`--dir` included): no Remotion
// package, add-on-only package, headless shell or core src/ may ship, and the
// core's copy of Remotion's licence must match the repository's. A failure
// stops the build.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const CHECK = path.join(__dirname, "..", "..", "..", "scripts", "check-no-remotion.mjs");

module.exports = async function afterPack(context) {
  const r = spawnSync(process.execPath, [CHECK, context.appOutDir], { stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`[afterpack] the packaging gate refused ${context.appOutDir} (check-no-remotion exit ${r.status ?? r.signal}); see above`);
  }
};
