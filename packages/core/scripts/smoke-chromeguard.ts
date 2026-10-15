/**
 * The graphics browser's network limits and Remotion's media downloads
 * (motion/chromeguard.ts, motion/render.ts): agent-written TSX can't make
 * Windows sign in to another computer, nor feed Remotion's own FFmpeg a
 * playlist.
 *
 *  M1. the wrapper   — every HeadlessBrowser.create gets Remotion's own
 *                      switches without --disable-web-security or an earlier
 *                      copy of ours, then exactly the resolver rule and the
 *                      sign-in allowlist (the headless shell's "allowlist"
 *                      spelling, a non-empty sentinel value); its browser is
 *                      marked as guarded; a second install changes nothing.
 *                      Checked through openBrowser itself (a stubbed create:
 *                      no Chrome starts).
 *  M2. renderGraphic — refuses a browser that did not come through the
 *                      wrapper; renders in the browser it opened
 *                      (puppeteerInstance) and closes it; its onDownload
 *                      refuses data:, http: and https: sources with the
 *                      message the AI can act on; graphicComposition has the
 *                      numbers Root.tsx registers. (Remotion stubbed.)
 *  M3. the patch     — the installed @remotion/renderer refuses a same-as
 *                      source in downloadAsset (CommonJS build) and in the
 *                      offthread proxy as Remotion starts it (ESM build): a
 *                      500, and no frame extraction reaches the compositor.
 *                      A copy without the patch: remotionPatched() is false
 *                      and renderGraphic refuses with "Graphics are turned off".
 *  M4. the lint      — check-io-imports.mjs --self-test has the render.ts and
 *                      @remotion/renderer cases, and the real tree passes.
 *  M5. integration   — only where Remotion's headless shell is already
 *                      cached (printed skip otherwise; nothing is downloaded):
 *                      a real graphic that asks 127.0.0.2 (not excluded by the
 *                      resolver rule) by fetch, an image, a WebSocket and
 *                      window.open reaches only the 127.0.0.1 control server;
 *                      a graphic with a data: <Audio> fails with the message
 *                      and nothing is written to Remotion's asset folder. In
 *                      an empty network namespace (loopback only) when
 *                      `unshare -rn` works.
 *
 * No network: the hosts are loopback (ports 5031-5033) or under .invalid.
 * Run: npx tsx packages/core/scripts/smoke-chromeguard.ts
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openBrowser, RenderInternals } from "@remotion/renderer";
import { GRAPHICS_CHROME_SWITCHES, guardedChromeArgs, installChromeGuard, isGuardedBrowser, remotionPatched } from "../src/motion/chromeguard.js";
import { graphicComposition, refuseDownload, renderGraphic, rootSource, type GraphicRemotion, type RenderGraphicOptions } from "../src/motion/render.js";

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};
const thrown = async (fn: () => unknown): Promise<Error | null> => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as Error;
  }
};

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const require = createRequire(import.meta.url);
const RENDERER_DIR = dirname(require.resolve("@remotion/renderer/package.json"));
const SENTENCE_HEAD = "Graphics can't load media through <OffthreadVideo>, <Video> or <Audio> (";
const SENTENCE_TAIL = "). Draw the graphic with shapes, text and CSS, or put the media on the timeline as its own clip.";

// Before the guard is installed: a stand-in for Remotion's create that records each argv and,
// by `mode`, refuses (no Chrome starts), returns a fake browser, or starts the real one (M5).
type Create = (opts: { args: string[] } & Record<string, unknown>) => Promise<object>;
const browserClass = RenderInternals.HeadlessBrowser as unknown as { create: Create };
const realCreate = browserClass.create;
const launches: string[][] = [];
let mode: "refuse" | "fake" | "real" = "refuse";
browserClass.create = async function (this: unknown, opts) {
  launches.push(opts.args);
  if (mode === "refuse") throw new Error("smoke: no Chrome started");
  if (mode === "fake") return { fake: true, close: async () => {} };
  return realCreate.call(this, opts);
};

async function main() {
  const work = mkdtempSync(join(tmpdir(), "aive-chromeguard-"));
  try {
    await m1();
    await m2(work);
    await m3(work);
    m4();
    m5Parent();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nALL CHROMEGUARD CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---- M1 ------------------------------------------------------------------------
// MUTATION: append the switches without dropping earlier copies (guardedChromeArgs
// keeps every argument) → the "exactly once" rows fail. Use the whitelist spelling →
// the exact-switch rows fail.
async function m1() {
  console.log("M1. the wrapper: Remotion's argv, then exactly our two switches...");
  check(GRAPHICS_CHROME_SWITCHES[0] === "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"
    && GRAPHICS_CHROME_SWITCHES[1] === "--auth-server-allowlist=zr-no-ambient-auth.invalid" && GRAPHICS_CHROME_SWITCHES.length === 2,
    `the switches, exactly (${JSON.stringify(GRAPHICS_CHROME_SWITCHES)})`);
  installChromeGuard();
  const wrapped = browserClass.create;
  installChromeGuard();
  check(browserClass.create === wrapped && wrapped !== realCreate, "installChromeGuard replaces HeadlessBrowser.create once; a second install changes nothing");
  // Through openBrowser itself: an existing file as the executable, so nothing is downloaded,
  // and web security turned off, which the wrapper must turn on again.
  launches.length = 0;
  const err = await thrown(() => openBrowser("chrome", { browserExecutable: process.execPath, chromeMode: "headless-shell", chromiumOptions: { disableWebSecurity: true } }));
  const argv = launches[0] ?? [];
  const profile = argv.find((a) => a.startsWith("--user-data-dir="));
  if (profile) rmSync(profile.slice("--user-data-dir=".length), { recursive: true, force: true });
  const tail = argv.slice(-2);
  check(err?.message === "smoke: no Chrome started" && launches.length === 1, `openBrowser launches through the wrapper (${err?.message})`);
  check(JSON.stringify(tail) === JSON.stringify(GRAPHICS_CHROME_SWITCHES), `the argv ends with exactly the two switches (${JSON.stringify(tail)})`);
  check(["about:blank", "--no-proxy-server", "--headless=old", "--no-sandbox"].every((a) => argv.includes(a)) && !!profile, `Remotion's own switches are kept (${argv.length} arguments)`);
  check(!argv.includes("--disable-web-security"), "--disable-web-security is dropped");
  const once = (prefix: string) => argv.filter((a) => a.startsWith(prefix)).length === 1;
  check(once("--host-resolver-rules=") && once("--auth-server-allowlist=") && !argv.some((a) => a.startsWith("--auth-server-whitelist=")),
    "each switch once, the headless shell's allowlist spelling only");
  // Copies already in the argv (an upgrade, or a caller): dropped, never doubled, never left empty.
  launches.length = 0;
  await thrown(() => browserClass.create({ args: ["--a", "--host-resolver-rules=MAP * 10.0.0.1", "--auth-server-allowlist=", "--auth-server-whitelist=*", "--disable-web-security", "--b"] }));
  check(JSON.stringify(launches[0]) === JSON.stringify(["--a", "--b", ...GRAPHICS_CHROME_SWITCHES]), `earlier copies and an empty allowlist are replaced (${JSON.stringify(launches[0])})`);
  check(JSON.stringify(guardedChromeArgs(["--x"])) === JSON.stringify(["--x", ...GRAPHICS_CHROME_SWITCHES]) && GRAPHICS_CHROME_SWITCHES.every((s) => s.split("=")[1].length > 0),
    "guardedChromeArgs: no value is empty");
  mode = "fake";
  const b = await browserClass.create({ args: [] });
  check(isGuardedBrowser(b) && !isGuardedBrowser({ close: async () => {} }), "a browser from the wrapper is marked guarded; any other is not");
}

// ---- M2 ------------------------------------------------------------------------
// MUTATION: make refuseDownload return undefined → the download rows fail. Drop the
// isGuardedBrowser check → the unguarded row renders.
async function m2(work: string) {
  console.log("M2. renderGraphic: its own guarded browser, every download refused...");
  const opts = (name: string): RenderGraphicOptions => ({
    code: "export default () => null;\n", props: { title: "x" }, width: 1279.6, height: 720.2, fps: 29.97, durationInFrames: 44.6,
    outPath: join(work, `${name}.mov`), workDir: join(work, name),
  });
  const calls: string[] = [];
  let rendered: Parameters<GraphicRemotion["renderMedia"]>[0] | undefined;
  let rootText = "";
  const stub = (open: () => Promise<object>): GraphicRemotion => ({
    remotionPatched: () => true,
    bundle: (async () => (calls.push("bundle"), "http://localhost:5039/bundle")) as unknown as GraphicRemotion["bundle"],
    ensureBrowser: (async () => (calls.push("ensureBrowser"), { type: "user-defined-path", path: "" })) as unknown as GraphicRemotion["ensureBrowser"],
    openBrowser: (async () => {
      calls.push("openBrowser");
      const b = (await open()) as { close: (o: unknown) => Promise<void> };
      const close = b.close;
      b.close = async (o: unknown) => (calls.push(`close ${JSON.stringify(o)}`), close(o));
      return b;
    }) as unknown as GraphicRemotion["openBrowser"],
    renderMedia: (async (o: Parameters<GraphicRemotion["renderMedia"]>[0]) => {
      calls.push("renderMedia");
      rendered = o;
      rootText = readFileSync(join(opts("ok").workDir, "Root.tsx"), "utf8");
      return { buffer: null, slowestFrames: [], contentType: "" };
    }) as unknown as GraphicRemotion["renderMedia"],
  });

  const plain = await thrown(() => renderGraphic(opts("plain"), stub(async () => ({ close: async () => {} }))));
  check(plain?.message === "Graphics are turned off: ZabsReel couldn't start the graphics browser with its network limits." && !calls.includes("renderMedia") && calls.some((c) => c.startsWith("close")),
    `a browser that did not come through the wrapper: refused and closed, nothing rendered (${plain?.message}; ${calls.join(", ")})`);

  calls.length = 0;
  mode = "fake";
  let opened: object | undefined;
  const ok = await thrown(() => renderGraphic(opts("ok"), stub(async () => (opened = await browserClass.create({ args: ["--x"] })))));
  check(ok === null && !!rendered && rendered.puppeteerInstance === opened && isGuardedBrowser(opened!), `rendered in the browser it opened, through the wrapper (${ok?.message})`);
  check(calls.at(-1) === 'close {"silent":true}' && calls.indexOf("renderMedia") < calls.length - 1 && calls.filter((c) => c === "openBrowser").length === 1,
    `…one browser, closed after the render (${calls.join(", ")})`);
  const onDownload = rendered?.onDownload;
  for (const src of ["data:audio/x-mpegurl;base64,I0VYVE0zVQo=", "http://zr-evil-m2.invalid/a.m3u8", "https://zr-evil-m2.invalid/v.mp4"]) {
    const e = await thrown(() => onDownload?.(src));
    check(e?.message === `${SENTENCE_HEAD}${src}${SENTENCE_TAIL}`, `onDownload refuses ${src.split(":")[0]}: (${e?.message ?? "no error"})`);
  }
  const long = `data:audio/wav;base64,${"A".repeat(5000)}‮\u0007`;
  const le = await thrown(() => refuseDownload(long));
  const shown = le?.message.slice(SENTENCE_HEAD.length, le.message.length - SENTENCE_TAIL.length) ?? "";
  check(shown.length <= 80 && shown.includes("…") && !/[\u0000-\u001f‮]/.test(shown), `a long data: source is shown short, without control or bidi characters (${shown.length} characters)`);
  const c = rendered?.composition;
  const want = graphicComposition(opts("ok"));
  const num = (k: string) => Number(new RegExp(`${k}=\\{([\\d.]+)\\}`).exec(rootText)?.[1]);
  check(JSON.stringify(c) === JSON.stringify(want) && c?.width === 1280 && c.height === 720 && c.fps === 29.97 && c.durationInFrames === 45 && c.id === "Graphic"
    && JSON.stringify(c.props) === '{"title":"x"}' && c.defaultCodec === null && c.defaultSampleRate === null,
    `renderMedia gets graphicComposition (${JSON.stringify(c)?.slice(0, 120)})`);
  check(num("width") === c?.width && num("height") === c?.height && num("fps") === c?.fps && num("durationInFrames") === c?.durationInFrames && rootText === rootSource(opts("ok")) && /id="Graphic"/.test(rootText),
    `…the numbers Root.tsx registers (${["width", "height", "fps", "durationInFrames"].map(num).join(", ")})`);
  check(!existsSync(opts("ok").workDir) && !existsSync(opts("plain").workDir), "the scaffold is removed either way");
}

// ---- M3 ------------------------------------------------------------------------
// MUTATION: revert the patch (npx patch-package --reverse) → every M3 row but the copy fails.
async function m3(work: string) {
  console.log("M3. the same-as patch in the installed @remotion/renderer...");
  check(remotionPatched(), "remotionPatched(): both builds carry the marker");
  const cjs = require(join(RENDERER_DIR, "dist/assets/download-and-map-assets-to-file.js")) as { downloadAsset: (o: Record<string, unknown>) => Promise<string> };
  const map = { downloadDir: join(work, "no-downloads"), hasBeenDownloadedMap: {}, isDownloadingMap: {} };
  const e = await thrown(() => cjs.downloadAsset({ src: "same-as-x.m3u8-0", downloadMap: map, indent: false, logLevel: "error", shouldAnalyzeAudioImmediately: false, binariesDirectory: null }));
  check(e?.message === "ZabsReel refuses same-as sources", `downloadAsset (CommonJS) refuses a same-as source (${e?.message ?? "returned it"})`);

  // The offthread proxy, as renderMedia starts it (ESM build).
  const bundleDir = join(work, "bundle");
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, "index.html"), "<!doctype html><title>x</title>");
  writeFileSync(join(bundleDir, "bundle.js"), "");
  const server = await RenderInternals.prepareServer({
    webpackConfigOrServeUrl: bundleDir, port: 5031, remotionRoot: work, offthreadVideoThreads: 1, logLevel: "error", indent: false,
    offthreadVideoCacheSizeInBytes: null, binariesDirectory: null, forceIPv4: true, sampleRate: 48000,
  });
  const commands: string[] = [];
  const compositor = server.compositor as unknown as { executeCommand: (cmd: string, p: unknown) => Promise<unknown> };
  const execute = compositor.executeCommand.bind(compositor);
  compositor.executeCommand = (cmd, p) => (commands.push(cmd), execute(cmd, p));
  try {
    const r = await fetch(`http://127.0.0.1:${server.offthreadPort}/proxy?src=${encodeURIComponent("same-as-x.m3u8")}&time=0&transparent=false&toneMapped=true`);
    const body = await r.text();
    check(r.status === 500 && body.includes("ZabsReel refuses same-as sources") && !commands.includes("ExtractFrame"),
      `/proxy?src=same-as…: 500 with the refusal, no frame extraction reaches the compositor (${r.status} ${body.slice(0, 80)}; ${JSON.stringify(commands)})`);
  } finally {
    await server.closeServer(true);
  }

  // A copy of the two files without the marker.
  const copy = join(work, "renderer-copy");
  for (const f of ["dist/assets/download-and-map-assets-to-file.js", "dist/esm/index.mjs"]) {
    mkdirSync(dirname(join(copy, f)), { recursive: true });
    copyFileSync(join(RENDERER_DIR, f), join(copy, f));
  }
  check(remotionPatched(copy), "a copy of the patched files passes");
  const esm = join(copy, "dist/esm/index.mjs");
  writeFileSync(esm, readFileSync(esm, "utf8").split("/* zabsreel: same-as refused */").join(""));
  check(!remotionPatched(copy), "a copy without the marker in one build: remotionPatched() is false");
  let bundled = false;
  const refused = await thrown(() => renderGraphic(
    { code: "", width: 64, height: 64, fps: 30, durationInFrames: 1, outPath: join(work, "x.mov"), workDir: join(work, "unpatched") },
    { remotionPatched: () => remotionPatched(copy), bundle: (async () => ((bundled = true), "")) as unknown as GraphicRemotion["bundle"] } as GraphicRemotion,
  ));
  check(refused?.message === "Graphics are turned off: this copy of Remotion is missing ZabsReel's safety patch. Run npm install again." && !bundled && !existsSync(join(work, "unpatched")),
    `renderGraphic refuses before anything else (${refused?.message})`);
}

// ---- M4 ------------------------------------------------------------------------
// MUTATION: drop the "onDownload" entry from RENDER_MUST in check-io-imports.mjs → its self-test case fails here.
function m4() {
  console.log("M4. the lint (scripts/check-io-imports.mjs)...");
  const lint = join(REPO, "scripts", "check-io-imports.mjs");
  const run = (args: string[]) => spawnSync(process.execPath, [lint, ...args], { encoding: "utf8" });
  const self = run(["--self-test"]);
  const cases = [
    "render.ts without installChromeGuard( fails", "render.ts without isGuardedBrowser( fails", "render.ts without puppeteerInstance fails",
    "render.ts without onDownload fails", "render.ts with selectComposition fails", "@remotion/renderer outside motion/ (a named import) fails",
  ];
  const missing = cases.filter((c) => !self.stdout.split("\n").includes(`ok   ${c}`));
  check(self.status === 0 && missing.length === 0, `--self-test passes, with the chromeguard cases (${missing.join("; ") || "all present"})`);
  const real = run([]);
  check(real.status === 0, `the real tree passes (${(real.stdout + real.stderr).trim().split("\n").pop()})`);
}

// ---- M5 ------------------------------------------------------------------------
/** True when Remotion would use a cached headless shell (so renderGraphic downloads nothing). */
function shellCached(): boolean {
  let dir = process.cwd();
  while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
  const version = join(dir, "node_modules", ".remotion", "chrome-headless-shell", "VERSION");
  const tested = /var TESTED_VERSION = "([^"]+)"/.exec(readFileSync(join(RENDERER_DIR, "dist/esm/index.mjs"), "utf8"))?.[1];
  return existsSync(version) && readFileSync(version, "utf8").trim() === tested;
}

function m5Parent() {
  console.log("M5. a real graphic (only with a cached headless shell)...");
  if (!shellCached()) {
    console.log("  skip M5: Remotion's headless shell is not cached here, and this smoke downloads nothing");
    return;
  }
  const can = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
  const isolated = process.platform === "linux" && can("unshare", ["-rn", "sh", "-c", "ip link set lo up"]);
  const self = [...process.execArgv, fileURLToPath(import.meta.url), "--m5"];
  const r = isolated
    ? spawnSync("unshare", ["-rn", "sh", "-c", 'ip link set lo up && exec "$0" "$@"', process.execPath, ...self], { stdio: "inherit", timeout: 600_000 })
    : spawnSync(process.execPath, self, { stdio: "inherit", timeout: 600_000 });
  check(r.status === 0, `M5 ${isolated ? "in an empty network namespace" : "(no unshare here: loopback servers only)"} passed (exit ${r.status})`);
}

/** M5 itself, in its own process. */
async function m5() {
  mode = "real";
  installChromeGuard();
  const work = mkdtempSync(join(tmpdir(), "aive-chromeguard-m5-"));
  // Anything Remotion writes into its download folder.
  const written: string[] = [];
  const fsMod = require("node:fs") as Record<string, unknown> & { promises: Record<string, unknown> };
  for (const [obj, key] of [[fsMod, "createWriteStream"], [fsMod, "writeFileSync"], [fsMod.promises, "writeFile"]] as const) {
    const orig = obj[key] as (...a: unknown[]) => unknown;
    obj[key] = (...a: unknown[]) => {
      if (typeof a[0] === "string" && a[0].includes("remotion-assets-dir")) written.push(a[0]);
      return orig(...a);
    };
  }
  const hits = { control: 0, other: 0 };
  const listen = (host: string, port: number, on: () => void) =>
    new Promise<Server>((res) => {
      const s = createServer((_q, a) => a.end("x"));
      s.on("connection", on);
      s.listen(port, host, () => res(s));
    });
  const control = await listen("127.0.0.1", 5032, () => hits.control++);
  const other = await listen("127.0.0.2", 5033, () => hits.other++);
  try {
    const code = `import React, { useEffect, useState } from "react";
import { AbsoluteFill, continueRender, delayRender } from "remotion";
export default function Probe() {
  const [handle] = useState(() => delayRender("probe"));
  useEffect(() => {
    const get = (u: string) => fetch(u, { mode: "no-cors" }).then(() => {}, () => {});
    try { new WebSocket("ws://127.0.0.2:5033/ws"); } catch {}
    try { window.open("http://127.0.0.2:5033/open"); } catch {}
    Promise.all([get("http://127.0.0.1:5032/control"), get("http://127.0.0.2:5033/fetch"), get("http://zr-evil-m5.invalid/x")])
      .then(() => new Promise((r) => setTimeout(r, 1500)))
      .then(() => continueRender(handle));
  }, [handle]);
  return <AbsoluteFill style={{ background: "#123" }}><img src="http://127.0.0.2:5033/img.png" /></AbsoluteFill>;
}
`;
    const base = { width: 64, height: 64, fps: 30, durationInFrames: 1, alpha: false };
    launches.length = 0;
    const e1 = await thrown(() => renderGraphic({ ...base, code, outPath: join(work, "probe.mp4"), workDir: join(work, "probe") }));
    check(e1 === null && existsSync(join(work, "probe.mp4")), `the probe graphic renders (${e1?.message.slice(0, 160)})`);
    check(launches.length >= 1 && launches.every((a) => JSON.stringify(a.slice(-2)) === JSON.stringify(GRAPHICS_CHROME_SWITCHES)), `every Chrome it started had the switches (${launches.length})`);
    check(hits.control >= 1 && hits.other === 0, `the 127.0.0.1 control server saw ${hits.control} connection(s), 127.0.0.2 saw ${hits.other}`);
    const audio = `import React from "react";
import { AbsoluteFill, Audio } from "remotion";
export default function Sound() {
  return <AbsoluteFill><Audio src="data:audio/x-mpegurl;base64,I0VYVE0zVQojRVhUSU5GOjEuMCwKLy96ci1ldmlsLW01LmludmFsaWQvcy9zZWcudHMK" /></AbsoluteFill>;
}
`;
    const e2 = await thrown(() => renderGraphic({ ...base, code: audio, outPath: join(work, "audio.mp4"), workDir: join(work, "audio") }));
    check(!!e2?.message.includes(`${SENTENCE_HEAD}data:audio/x-mpegurl;`) && e2.message.includes(SENTENCE_TAIL), `a data: <Audio> fails with the message (${e2?.message.slice(0, 160)})`);
    check(written.length === 0, `nothing is written to Remotion's asset folder (${JSON.stringify(written.slice(0, 3))})`);
  } finally {
    control.close();
    other.close();
    rmSync(work, { recursive: true, force: true });
  }
  process.exit(failures === 0 ? 0 : 1);
}

(process.argv[2] === "--m5" ? m5() : main()).catch((err) => {
  console.error(err);
  process.exit(1);
});
