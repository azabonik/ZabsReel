// The built core's Remotion guard (packages/core/dist/motion/remotionload.js)
// in the runtime that runs it: plain Node (the web shell, dev) and Electron's
// Node (the app's core child, ELECTRON_RUN_AS_NODE=1). It loads Remotion as
// renderGraphic does and checks that the guard is ok and that downloadAsset
// refuses a same-as source in both builds, so the load hook rewrote them in
// memory: the CommonJS one called directly, the ESM one (the build renderGraphic
// runs) through Remotion's own stitchFramesToVideo, which hands an audio asset
// to downloadAsset before it starts any process. It also checks that the /proxy guard (proxyguard.js) works in this
// runtime: Node's request channel rewrites a /proxy request before the
// handler (over an in-memory stream). Remotion loads from AIVE_REMOTION_ADDON
// (graphics-addon-env.mjs: the repo root when unset). Last, without that
// variable and without an installed add-on, graphics refuse with
// graphics_addon_missing. It starts no server, browser or core (opens no
// port), and needs `npm run build`.
//
// Usage: node packages/core/scripts/check-remotion-guard.mjs
//        ELECTRON_RUN_AS_NODE=1 <electron> packages/core/scripts/check-remotion-guard.mjs
// Exits 0 when all hold, 1 otherwise.
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { useDevAddon, withoutDevAddon } from "./graphics-addon-env.mjs";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "motion", "remotionload.js");
const PROXY_GUARD = join(dirname(DIST), "proxyguard.js");
const RESOLVE = join(dirname(DIST), "..", "addon", "resolve.js");
const ROOT = useDevAddon();
const runtime = process.versions.electron ? `Electron ${process.versions.electron} (Node ${process.versions.node})` : `Node ${process.versions.node}`;
let failures = 0;
const check = (ok, msg) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};

console.log(`[check-remotion-guard] ${runtime}`);
const { loadRemotion } = await import(pathToFileURL(DIST).href);
const remotion = await loadRemotion(ROOT);
check(remotion.guard().ok === true, `the guard is ok after loading Remotion (${JSON.stringify(remotion.guard())})`);

const require = createRequire(join(ROOT, "noop.js"));
const dir = dirname(require.resolve("@remotion/renderer/package.json"));
const cjs = require(join(dir, "dist", "assets", "download-and-map-assets-to-file.js"));
let message = "returned the source";
try {
  await cjs.downloadAsset({ src: "same-as-x.m3u8-0", downloadMap: { downloadDir: "", hasBeenDownloadedMap: {}, isDownloadingMap: {} }, indent: false, logLevel: "error" });
} catch (err) {
  message = err.message;
}
check(message === "ZedMix refuses same-as sources", `downloadAsset (CommonJS) refuses a same-as source (${message})`);
check(remotion.guard().ok === true, `the guard stays ok after the CommonJS build is loaded (${JSON.stringify(remotion.guard())})`);

const { stitchFramesToVideo, RenderInternals } = remotion.renderer;
const map = RenderInternals.makeDownloadMap(48000);
const asset = { type: "audio", src: "same-as-x.m3u8-0", id: "a", frame: 0, volume: 1, mediaFrame: 0, playbackRate: 1, toneFrequency: 1, audioStartFrame: 0, audioStreamIndex: 0 };
message = "returned the source";
try {
  await stitchFramesToVideo({
    assetsInfo: { assets: [{ frame: 0, audioAndVideoAssets: [asset], artifactAssets: [], inlineAudioAssets: [] }], imageSequenceName: "x", firstFrameIndex: 0, downloadMap: map, trimLeftOffset: 0, trimRightOffset: 0, chunkLengthInSeconds: 1, forSeamlessAacConcatenation: false },
    fps: 30, width: 64, height: 64, codec: "aac", outputLocation: join(map.assetDir, "x.aac"),
  });
} catch (err) {
  message = err.message;
} finally {
  RenderInternals.deleteDirectory(map.assetDir);
}
check(message === "ZedMix refuses same-as sources", `downloadAsset (ESM, through stitchFramesToVideo) refuses a same-as source (${message.slice(0, 120)})`);

const { proxyGuardWorks } = await import(pathToFileURL(PROXY_GUARD).href);
check((await proxyGuardWorks()) === true, "the /proxy guard works here (a /proxy request reaches the handler rewritten)");

const { resolveGraphicsAddon, GraphicsAddonError } = await import(pathToFileURL(RESOLVE).href);
const dataDir = mkdtempSync(join(tmpdir(), "aive-guard-data-"));
try {
  const r = await withoutDevAddon(() => resolveGraphicsAddon(dataDir));
  const code = r.ok ? "ready" : new GraphicsAddonError(r.state).code;
  check(code === "graphics_addon_missing", `without AIVE_REMOTION_ADDON and an installed add-on, graphics refuse with graphics_addon_missing (${code})`);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures ? `[check-remotion-guard] FAILED: ${failures} check(s)` : "[check-remotion-guard] ok");
process.exit(failures ? 1 : 0);
