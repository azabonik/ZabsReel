// The motion renderer's start probe (dist/motion/rendermotion.js, probeMotionRenderer) on this
// machine as it is set up. The renderer runs only inside Chromium's sandbox: where the system
// blocks it (Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor, and an
// npm-installed Electron has no SUID sandbox helper set up), the probe must refuse with
// sandbox-unavailable, never start without the sandbox, crash or hang. CI runs this on Ubuntu's
// default settings, before it allows the namespaces for the smokes, so the run shows what a user
// on a default Ubuntu 24.04 gets (and its step summary says which). It starts no server or core:
// the probe runs in a temp data folder, removed afterwards. Needs `npm run build` and the
// Electron binary (node node_modules/electron/install.js).
//
// Usage: node packages/core/scripts/check-renderer-sandbox.mjs
// Exits 0 when the probe answers ok or sandbox-unavailable, 1 otherwise.
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "motion", "rendermotion.js");
let failures = 0;
const check = (ok, msg) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};

console.log("[check-renderer-sandbox] the renderer's start probe on this machine's settings");
const { probeMotionRenderer, rendererArgs } = await import(pathToFileURL(DIST).href);
check(!rendererArgs("/tmp/x", 64, 64, ["--probe"]).some((a) => /no-sandbox|disable-setuid-sandbox/.test(a)), "the renderer's arguments never turn the sandbox off");

const dataDir = mkdtempSync(join(tmpdir(), "aive-sandbox-data-"));
let outcome = "no answer";
try {
  const t0 = Date.now();
  const r = await probeMotionRenderer(dataDir, { timeoutMs: 60_000 });
  outcome = r.ok ? "ok" : r.reason;
  const detail = r.ok ? `visible windows ${r.report.visibleWindows}` : r.detail.slice(0, 300);
  check(r.ok ? r.report.probe === "ok" : r.reason === "sandbox-unavailable",
    `the probe answers ok, or refuses with sandbox-unavailable (${outcome} in ${Date.now() - t0} ms: ${detail})`);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Motion renderer on this runner's default settings: **${outcome}**${outcome === "sandbox-unavailable" ? " (as a user on a default Ubuntu 24.04 without the SUID helper gets)" : ""}.\n`);
}
console.log(failures ? `[check-renderer-sandbox] FAILED: ${failures} check(s)` : `[check-renderer-sandbox] ok (${outcome})`);
process.exit(failures ? 1 : 0);
