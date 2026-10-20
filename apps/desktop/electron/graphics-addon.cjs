// The graphics add-on in the UI hosts (@aive/core/addon, ADDON-PLAN D4): the
// status, the terms and the one install or removal job of this host, shared
// by Electron main (IPC graphics-addon:*) and the web shell (/api behind its
// shell key). Only these hosts install, remove or recover the add-on, and an
// install starts only from the add-on dialog's button; the core's RPC reports
// the state and nothing else. They also write the graphics renderer setting
// (<dataDir>/addons/renderer.json, MOTION-PLAN D7), only on a click in that
// dialog: no RPC method or MCP tool can.
//
// AIVE_ADDON_TEST_PIN (a JSON pin file, honoured only in a source checkout,
// like AIVE_ADDON_REGISTRY) gives the UI smokes their fixture add-on.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

let addonModule = null;
/** @aive/core's ESM add-on module, loaded on first use. */
function addon() {
  addonModule ??= import("@aive/core/addon");
  return addonModule;
}

const errText = (err) => (err && err.message ? err.message : String(err));

/** The installer's test seams when AIVE_ADDON_TEST_PIN is set (a source checkout only), else null. */
function testSeams(a) {
  const file = a.devVariable("AIVE_ADDON_TEST_PIN");
  return file ? { pin: JSON.parse(fs.readFileSync(file, "utf8")) } : null;
}

/** Bytes below `dir` (links not followed); 0 when it can't be read. */
async function folderBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await folderBytes(p);
    else if (e.isFile()) total += await fsp.lstat(p).then((s) => s.size, () => 0);
  }
  return total;
}

/** The licence hash a copy under `addons/remotion/<v>` recorded (the live one first), or null. */
function acceptedHash(dataDir, version) {
  const base = path.join(dataDir, "addons", "remotion");
  let versions = [];
  try {
    versions = fs.readdirSync(base).sort((a, b) => Number(b === version) - Number(a === version));
  } catch {
    return null;
  }
  for (const v of versions) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(base, v, "addon.json"), "utf8"));
      if (typeof m.licenseSha256 === "string") return m.licenseSha256;
    } catch {
      /* none here */
    }
  }
  return null;
}

/**
 * One host's side of the add-on. `via` ("desktop" | "web") goes into the lock
 * and addon.json; `fetch` is the host's (Electron's network stack, or Node's);
 * `dataDir()` is the data folder the core uses.
 */
function createGraphicsAddonHost({ via, fetch, dataDir, log }) {
  /** The running install or removal: { id, kind, done, total, controller }. */
  let job = null;
  /** How the last one ended: { id, kind, ok, error, cancelled }. */
  let last = null;
  let seq = 0;

  /** For the dialog: the D1 state, what it shows for it, and this host's job. */
  async function status() {
    const a = await addon();
    const s = testSeams(a);
    const dir = dataDir();
    const platform = a.addonPlatform();
    const got = a.readGraphicsAddon(dir, s ? { pin: s.pin } : {});
    const terms = platform ? a.graphicsAddonTerms(platform) : null;
    return {
      state: got.state,
      renderer: a.readGraphicsRenderer(dir),
      version: a.ADDON_REMOTION_VERSION,
      unsupported: platform ? null : a.unsupportedMessage(),
      installedAt: typeof got.installedAt === "string" ? got.installedAt : null,
      // Measured only while nothing runs: a page polls status during an install.
      bytes: got.state === "ready" && !job ? await folderBytes(got.dir) : null,
      // An update or reinstall shows the licence again only when its text changed.
      licenseAccepted: !!terms && acceptedHash(dir, a.ADDON_REMOTION_VERSION) === terms.sha256,
      busy: job ? null : await a.graphicsAddonBusy(dir),
      job: job && { id: job.id, kind: job.kind, done: job.done, total: job.total },
      last,
    };
  }

  /** The notice and licence the dialog shows (and their hash), or null where the add-on isn't offered. */
  async function terms() {
    const a = await addon();
    const platform = a.addonPlatform();
    return platform ? a.graphicsAddonTerms(platform) : null;
  }

  /** Start `kind` unless a job runs; `work(a, seams, job)` does it. Resolves with { ok, error?, cancelled? }. */
  function start(kind, work) {
    if (job) return { id: null, result: Promise.resolve({ ok: false, error: "The graphics add-on is busy in this window. Wait for it to finish." }) };
    const id = ++seq;
    job = { id, kind, done: 0, total: 0, controller: new AbortController() };
    const current = job;
    const result = (async () => {
      try {
        const a = await addon();
        await work(a, testSeams(a), current);
        last = { id, kind, ok: true, error: null, cancelled: false };
      } catch (err) {
        const cancelled = !!(err && err.reason === "cancelled");
        last = { id, kind, ok: false, error: errText(err), cancelled };
        log(`graphics add-on ${kind} failed: ${errText(err)}`);
      } finally {
        job = null;
      }
      return { ok: last.ok, error: last.error, cancelled: last.cancelled };
    })();
    return { id, result };
  }

  /** Install with the hash of the terms the user accepted; `onProgress({ done, total })`. */
  function install(acceptedLicenseSha256, onProgress) {
    return start("install", async (a, s, j) => {
      const opts = {
        fetch,
        signal: j.controller.signal,
        acceptedLicenseSha256: String(acceptedLicenseSha256 || ""),
        via,
        onProgress: (p) => {
          j.done = p.done;
          j.total = p.total;
          if (onProgress) onProgress(p);
        },
      };
      if (s) await a.addonInstallerForTests.install(dataDir(), opts, s);
      else await a.installGraphicsAddon(dataDir(), opts);
    });
  }

  function remove() {
    return start("remove", async (a, s) => {
      if (s) await a.addonInstallerForTests.remove(dataDir(), via, s);
      else await a.removeGraphicsAddon(dataDir(), { via });
    });
  }

  /** Cancel the running install; false when there is none. */
  function cancel() {
    if (!job || job.kind !== "install") return false;
    job.controller.abort();
    return true;
  }

  /** At start: finish or clean up an install that stopped part way (D3.1 steps 2 and 3). Never throws. */
  async function recover() {
    try {
      const a = await addon();
      const s = testSeams(a);
      if (s) await a.addonInstallerForTests.recover(dataDir(), s);
      else await a.recoverGraphicsAddon(dataDir());
    } catch (err) {
      log(`graphics add-on recovery failed: ${errText(err)}`);
    }
  }

  /** The user's click on a renderer in the dialog: "zedmix" or "remotion" into renderer.json. Resolves with { ok, error? }. */
  async function setRenderer(renderer) {
    try {
      const a = await addon();
      if (!a.GRAPHICS_RENDERERS.includes(renderer)) return { ok: false, error: "Not a graphics renderer." };
      await a.writeGraphicsRenderer(dataDir(), renderer);
      return { ok: true };
    } catch (err) {
      log(`graphics renderer setting failed: ${errText(err)}`);
      return { ok: false, error: `The graphics renderer setting couldn't be saved: ${errText(err)}` };
    }
  }

  return { status, terms, install, remove, cancel, recover, setRenderer };
}

module.exports = { createGraphicsAddonHost };
