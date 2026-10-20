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
 *                      numbers Root.tsx registers; the render is muted and
 *                      the /proxy guard is on only while it runs. (Remotion
 *                      stubbed.)
 *  M3. the refusal   — remotionload.ts's load hook gives the installed,
 *                      unpatched @remotion/renderer the same-as refusal in
 *                      memory: importing render.ts and chromeguard.ts loads
 *                      no Remotion; the guard is ok; downloadAsset (CommonJS
 *                      build, in a fresh process) refuses a same-as source;
 *                      the offthread proxy as Remotion starts it (ESM build)
 *                      answers 500, and no frame extraction reaches the
 *                      compositor. Fresh processes: a copy of the renderer
 *                      whose text changed (another version) and Remotion
 *                      loaded before the hook (ESM or CommonJS), Node without
 *                      module.registerHooks, and tsx's CommonJS loader (which
 *                      compiles from disk, past the hook): the guard is not
 *                      ok and renderGraphic refuses with its reason before
 *                      writing or bundling anything. A copy that already
 *                      carries the refusal (as patch-package left it): ok.
 *  M4. the lint      — check-io-imports.mjs --self-test has the render.ts
 *                      cases (muted and the /proxy guard included) and the
 *                      Remotion-load cases (only remotionload.ts loads it),
 *                      and the real tree passes.
 *  M5. integration   — only where Remotion's headless shell is already
 *                      cached (printed skip otherwise; nothing is downloaded):
 *                      a real graphic that asks 127.0.0.2 (not excluded by the
 *                      resolver rule) by fetch, an image, a WebSocket and
 *                      window.open reaches only the 127.0.0.1 control server,
 *                      and its H.264 has no audio stream; a graphic with a
 *                      data: <Audio> fails with the message and nothing is
 *                      written to Remotion's asset folder; a graphic that
 *                      reports a same-as asset fails with the refusal. In an
 *                      empty network namespace (loopback only) when
 *                      `unshare -rn` works. On GitHub Actions a skipped
 *                      real render (M5, M6b) is also listed in the job's step
 *                      summary ($GITHUB_STEP_SUMMARY), so CI shows the gap.
 *  M6. second layer  — each part closes its route alone, in a fresh process
 *                      where the M3 rewrite is off (Remotion loaded before the
 *                      hook; production code has no switch for it):
 *                      a. the /proxy guard: during renderGraphic, a fetch and
 *                         a WebSocket handshake to Remotion's own server at
 *                         /proxy?src=same-as… are refused (400), its compositor
 *                         gets no command, and no file naming the source is
 *                         opened (strace -f where there is one); the page
 *                         itself still loads, another server's /proxy is
 *                         untouched, and the guard is gone after the render;
 *                      b. muted (real Chrome, only with a cached shell): a
 *                         graphic that reports a same-as asset through
 *                         Remotion's RenderAssetManager starts no ffprobe or
 *                         ffmpeg whose arguments name it;
 *                      c. fail closed: a Node whose request channel reaches no
 *                         subscriber refuses before writing or bundling;
 *                      d. positive control (throwaway process, rewrite and
 *                         guard both off): the requests of (a) do reach the
 *                         compositor, and the trace sees the source opened.
 *  M7. guard lifetime — Remotion closes its server after renderMedia settles
 *                      without awaiting it (here: 1 s, then 5 s later): right
 *                      after renderGraphic returns, /proxy?src=same-as… on that
 *                      port is refused by the guard (400) or finds no server,
 *                      never served; a server still open after renderGraphic's
 *                      wait keeps the guard until it closes. A port that never
 *                      closes (shortened interval and cap): the background
 *                      check stops at its cap and the guard stays on.
 *  M8. no add-on     — without AIVE_REMOTION_ADDON and without an installed
 *                      add-on, add_graphic refuses with graphics_addon_missing.
 *
 * Remotion loads from AIVE_REMOTION_ADDON (graphics-addon-env.mjs: the repo
 * root when unset), with Remotion's own headless-shell cache.
 * No network: the hosts are loopback (ports 5031-5036, and the port
 * renderGraphic picks for Remotion's server in M6a and M7) or under .invalid.
 * Run: npx tsx packages/core/scripts/smoke-chromeguard.ts
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { channel } from "node:diagnostics_channel";
import nodeModule, { createRequire } from "node:module";
import { createServer, request, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GRAPHICS_CHROME_SWITCHES, guardedChromeArgs, installChromeGuard, isGuardedBrowser } from "../src/motion/chromeguard.js";
import { graphicComposition, graphicRemotion, refuseDownload, renderGraphic, rootSource, type GraphicRemotion, type RenderGraphicOptions } from "../src/motion/render.js";
import { loadRemotion, type LoadedRemotion, type RemotionGuard } from "../src/motion/remotionload.js";
import { guardRemotionProxy, releaseWhenClosed } from "../src/motion/proxyguard.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import type { ResolvedGraphicsAddon } from "../src/addon/resolve.js";
import { EditorEngine } from "../src/engine.js";
import { dispatch, RpcError } from "../src/rpc.js";
import { useDevAddon, useRemotionRenderer, withoutDevAddon } from "./graphics-addon-env.mjs";

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
/** The dev add-on: Remotion from the checkout's node_modules, Remotion's own browser cache. */
const DEV_ROOT = useDevAddon();
const DEV: ResolvedGraphicsAddon = { ok: true, root: DEV_ROOT };
const require = createRequire(import.meta.url);
const RENDERER_DIR = dirname(require.resolve("@remotion/renderer/package.json"));
const CJS_FILE = "dist/assets/download-and-map-assets-to-file.js";
const ESM_FILE = "dist/esm/index.mjs";
const REFUSAL = "ZedMix refuses same-as sources";
const REMOTION_MODULE = /[\\/]node_modules[\\/](?:remotion|@remotion[\\/][^\\/]+)[\\/]/;
/** Remotion modules loaded once render.ts and chromeguard.ts (imported above) are. */
const loadedByImports = Object.keys(require.cache).filter((p) => REMOTION_MODULE.test(p));
const SENTENCE_HEAD = "Graphics can't load media through <OffthreadVideo>, <Video> or <Audio> (";
const SENTENCE_TAIL = "). Draw the graphic with shapes, text and CSS, or put the media on the timeline as its own clip.";
/** Node's channel the /proxy guard (proxyguard.ts) subscribes to while a render runs. */
const REQUEST_START = "http.server.request.start";
/** Same-as sources a graphic could hand Remotion (a host under .invalid; the token is what traces look for). */
const PROXY_HOST = "zr-evil-a.invalid";
const PROXY_SRC = `same-as\\..\\..\\${PROXY_HOST}\\s\\a.mp4`;
const ASSET_HOST = "zr-evil-b.invalid";
const ASSET_SRC = `same-as\\..\\..\\${ASSET_HOST}\\s\\a.m3u8`;

// Before the guard is installed: a stand-in for Remotion's create that records each argv and,
// by `mode`, refuses (no Chrome starts), returns a fake browser, or starts the real one (M5).
type Create = (opts: { args: string[] } & Record<string, unknown>) => Promise<object>;
let remotion: LoadedRemotion;
let browserClass: { create: Create };
let realCreate: Create;
const launches: string[][] = [];
let mode: "refuse" | "fake" | "real" = "refuse";

/** Load Remotion as renderGraphic does (remotionload.ts) and put the stand-in in place. */
async function setup() {
  remotion = await loadRemotion(DEV_ROOT);
  browserClass = remotion.renderer.RenderInternals.HeadlessBrowser as unknown as { create: Create };
  realCreate = browserClass.create;
  browserClass.create = async function (this: unknown, opts) {
    launches.push(opts.args);
    if (mode === "refuse") throw new Error("smoke: no Chrome started");
    if (mode === "fake") return { fake: true, close: async () => {} };
    return realCreate.call(this, opts);
  };
}

async function main() {
  await setup();
  const work = mkdtempSync(join(tmpdir(), "aive-chromeguard-"));
  try {
    await m1();
    await m2(work);
    await m3(work);
    m4();
    m5Parent();
    m6(work);
    await m7(work);
    await m8(work);
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
  installChromeGuard(remotion.renderer.RenderInternals);
  const wrapped = browserClass.create;
  installChromeGuard(remotion.renderer.RenderInternals);
  check(browserClass.create === wrapped && wrapped !== realCreate, "installChromeGuard replaces HeadlessBrowser.create once; a second install changes nothing");
  // Through openBrowser itself: an existing file as the executable, so nothing is downloaded,
  // and web security turned off, which the wrapper must turn on again.
  launches.length = 0;
  const err = await thrown(() => remotion.renderer.openBrowser("chrome", { browserExecutable: process.execPath, chromeMode: "headless-shell", chromiumOptions: { disableWebSecurity: true } }));
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
// isGuardedBrowser check → the unguarded row renders. Drop muted: true, or release the
// /proxy guard before renderMedia → the muted/guard row fails.
async function m2(work: string) {
  console.log("M2. renderGraphic: its own guarded browser, every download refused...");
  const opts = (name: string): RenderGraphicOptions => ({
    code: "export default () => null;\n", props: { title: "x" }, width: 1279.6, height: 720.2, fps: 29.97, durationInFrames: 44.6,
    outPath: join(work, `${name}.mov`), workDir: join(work, name),
  });
  const calls: string[] = [];
  let rendered: Parameters<GraphicRemotion["renderMedia"]>[0] | undefined;
  let rootText = "";
  let guardDuring = false;
  const stub = (open: () => Promise<object>): GraphicRemotion => ({
    guard: () => ({ ok: true }),
    RenderInternals: remotion.renderer.RenderInternals,
    bundle: (async () => (calls.push("bundle"), "http://localhost:5039/bundle")) as unknown as GraphicRemotion["bundle"],
    bundlerModules: remotion.bundlerModules,
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
      guardDuring = channel(REQUEST_START).hasSubscribers;
      rootText = readFileSync(join(opts("ok").workDir, "Root.tsx"), "utf8");
      return { buffer: null, slowestFrames: [], contentType: "" };
    }) as unknown as GraphicRemotion["renderMedia"],
  });

  const plain = await thrown(() => renderGraphic(opts("plain"), DEV, stub(async () => ({ close: async () => {} }))));
  check(plain?.message === "Graphics are turned off: ZedMix couldn't start the graphics browser with its network limits." && !calls.includes("renderMedia") && calls.some((c) => c.startsWith("close")),
    `a browser that did not come through the wrapper: refused and closed, nothing rendered (${plain?.message}; ${calls.join(", ")})`);

  calls.length = 0;
  mode = "fake";
  let opened: object | undefined;
  const ok = await thrown(() => renderGraphic(opts("ok"), DEV, stub(async () => (opened = await browserClass.create({ args: ["--x"] })))));
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
  check(rendered?.muted === true && typeof rendered.port === "number" && guardDuring && !channel(REQUEST_START).hasSubscribers,
    `renderMedia is muted; the /proxy guard is on while it runs and gone after (muted ${rendered?.muted}, port ${rendered?.port}, during ${guardDuring}, after ${channel(REQUEST_START).hasSubscribers})`);
}

// ---- M3 ------------------------------------------------------------------------
// MUTATION: make the hook return every module unchanged (remotionload.ts) → the guard,
// CommonJS and /proxy rows fail. Drop the CommonJS marker check from the guard → the tsx
// row passes as ok. Drop the "no-match" check → the version row is ok.
async function m3(work: string) {
  console.log("M3. the same-as refusal remotionload.ts gives the installed (unpatched) @remotion/renderer...");
  check(loadedByImports.length === 0, `importing render.ts and chromeguard.ts loads no Remotion (${JSON.stringify(loadedByImports.slice(0, 3))})`);
  const onDisk = [CJS_FILE, ESM_FILE].map((f) => readFileSync(join(RENDERER_DIR, f), "utf8").includes("/* zedmix: same-as refused */"));
  check(JSON.stringify(remotion.guard()) === '{"ok":true}' && !onDisk.includes(true), `the guard is ok, and the files on disk are unpatched (${JSON.stringify(remotion.guard())}; marker on disk: ${JSON.stringify(onDisk)})`);
  const cjs = child("cjs");
  check(cjs.message === REFUSAL && JSON.stringify(cjs.guard) === '{"ok":true}', `downloadAsset (CommonJS) refuses a same-as source; the guard stays ok (${JSON.stringify(cjs)})`);

  // The offthread proxy, as renderMedia starts it (ESM build).
  const bundleDir = join(work, "bundle");
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, "index.html"), "<!doctype html><title>x</title>");
  writeFileSync(join(bundleDir, "bundle.js"), "");
  const server = await remotion.renderer.RenderInternals.prepareServer({
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
    check(r.status === 500 && body.includes(REFUSAL) && !commands.includes("ExtractFrame"),
      `/proxy?src=same-as…: 500 with the refusal, no frame extraction reaches the compositor (${r.status} ${body.slice(0, 80)}; ${JSON.stringify(commands)})`);
  } finally {
    await server.closeServer(true);
  }

  // Another Remotion version: the text the hook knows is not there.
  const other = copyRoot(work, "other-version", (text) => text.replace(EARLY_RETURN, (_m, head: string) => `${head}return src;`));
  const v = child("render", other);
  check(refusedEarly(v, { ok: false, reason: "version" }, off("ZedMix works with Remotion 4.0.481, and this copy of Remotion is a version it doesn't know.")),
    `a copy whose text changed (another version): refused before bundling, nothing written (${JSON.stringify(v)})`);
  // As patch-package left it: the refusal already in both builds.
  const patched = copyRoot(work, "patched", (text, f) => text.replace(EARLY_RETURN, (_m, head: string, indent: string, close: string) => {
    const q = f === CJS_FILE ? "'" : '"';
    return `${head}{\n${indent}/* zedmix: same-as refused */\n${indent}throw new Error(${q}${REFUSAL}${q});${close}`;
  }));
  const p = child("cjs", patched);
  check(p.message === REFUSAL && JSON.stringify(p.guard) === '{"ok":true}', `a copy that already carries the refusal: the guard is ok, its downloadAsset refuses (${JSON.stringify(p)})`);
  const before = off("Remotion was loaded before ZedMix could guard it. Restart ZedMix.");
  for (const how of ["esm", "cjs"]) {
    const e = child("render", "", how);
    check(refusedEarly(e, { ok: false, reason: "loaded-before" }, before), `@remotion/renderer loaded (${how === "esm" ? "import" : "require"}) before the hook: refused (${JSON.stringify(e)})`);
  }
  const t = child("cjs", "", "tsx");
  check(t.message !== REFUSAL && JSON.stringify(t.guard) === '{"ok":false,"reason":"loaded-before"}', `tsx compiles the CommonJS build past the hook: the guard is not ok (${JSON.stringify(t)})`);
  const n = child("render", "", "no-hooks");
  check(refusedEarly(n, { ok: false, reason: "node" }, off(`graphics need Node.js 22.15 or later, and ZedMix is running on Node.js ${process.versions.node}.`)),
    `Node without module.registerHooks: refused (${JSON.stringify(n)})`);
}

const off = (why: string) => `Graphics are turned off: ${why}`;
/** A `render` child that refused with `message` before bundling or writing anything. */
const refusedEarly = (r: Record<string, unknown>, guard: RemotionGuard, message: string) =>
  JSON.stringify(r.guard) === JSON.stringify(guard) && r.message === message && r.bundled === false && r.wrote === false;

/** downloadAsset's same-as early return in either build: the `if (…isAssetCompressed…(src)) ` head, the body's indent, the closing brace. */
const EARLY_RETURN = /(if \((?:\(0, compress_assets_1\.)?isAssetCompressed\)?\(src\)\) )\{\n(\s*)return src;(\n\s*\})/;

/**
 * A root whose node_modules links to the repo's, except @remotion/renderer: a copy, both
 * builds passed through `edit` (nothing in the repo's node_modules changes).
 */
function copyRoot(work: string, name: string, edit: (text: string, file: string) => string): string {
  const modules = dirname(dirname(RENDERER_DIR));
  const into = join(work, name, "node_modules");
  mkdirSync(join(into, "@remotion"), { recursive: true });
  const link = (rel: string) => symlinkSync(join(modules, rel), join(into, rel), statSync(join(modules, rel)).isDirectory() ? "junction" : "file");
  for (const e of readdirSync(modules)) if (e !== "@remotion") link(e);
  for (const e of readdirSync(join(modules, "@remotion"))) if (e !== "renderer") link(join("@remotion", e));
  const copy = join(into, "@remotion", "renderer");
  cpSync(RENDERER_DIR, copy, { recursive: true });
  for (const f of [CJS_FILE, ESM_FILE]) {
    const text = readFileSync(join(copy, f), "utf8");
    const edited = edit(text, f);
    if (edited === text) throw new Error(`smoke: the edit changed nothing in ${f}`);
    writeFileSync(join(copy, f), edited);
  }
  return join(work, name);
}

/**
 * This file's `--child <case> <root> <how>` in a fresh process, with tsx's ESM loader only
 * (so require() goes through Node's own loader and its hooks), or all of tsx for how=tsx;
 * the JSON line it prints. With `trace`, under `strace -f` (file calls) writing to that log.
 */
function child(name: string, root = "", how = "", trace = ""): Record<string, unknown> {
  const loader = how === "tsx" ? process.execArgv : ["--import", pathToFileURL(require.resolve("tsx/esm")).href];
  const argv = [process.execPath, ...loader, fileURLToPath(import.meta.url), "--child", name, root, how];
  const [cmd, ...args] = trace ? ["strace", "-f", "-qq", "-s", "1024", "-e", "trace=file", "-o", trace, ...argv] : argv;
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000 });
  try {
    return JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as Record<string, unknown>;
  } catch {
    return { error: `exit ${r.status}: ${(r.stderr || r.stdout).slice(-400)}` };
  }
}

/** A `--child` case (see {@link child}); `root` "" is the dev add-on. */
async function childCase(name: string, root: string, how: string): Promise<Record<string, unknown>> {
  const from = root ? createRequire(join(root, "noop.js")) : require;
  if (how === "esm") await import("@remotion/renderer");
  if (how === "cjs") from("@remotion/renderer");
  if (how === "no-hooks") (nodeModule as { registerHooks?: unknown }).registerHooks = undefined;
  // A Node whose request channel reaches no subscriber (the /proxy guard can't work).
  if (how === "no-channel") Object.assign(channel(REQUEST_START), { publish: () => {} });
  if (name === "proxy" || name === "proxy-open") {
    await import("@remotion/renderer"); // before the hook: this process has no rewrite
    return proxyCase(name);
  }
  if (name === "cjs") {
    const loaded = await loadRemotion(root || DEV_ROOT);
    const dir = dirname(from.resolve("@remotion/renderer/package.json"));
    const cjs = from(join(dir, CJS_FILE)) as { downloadAsset: (o: Record<string, unknown>) => Promise<string> };
    const map = { downloadDir: join(tmpdir(), "aive-chromeguard-no-downloads"), hasBeenDownloadedMap: {}, isDownloadingMap: {} };
    const e = await thrown(() => cjs.downloadAsset({ src: "same-as-x.m3u8-0", downloadMap: map, indent: false, logLevel: "error", shouldAnalyzeAudioImmediately: false, binariesDirectory: null }));
    return { message: e?.message ?? null, guard: loaded.guard() };
  }
  const r = await graphicRemotion(root || DEV_ROOT);
  let bundled = false;
  const workDir = join(mkdtempSync(join(tmpdir(), "aive-chromeguard-child-")), "scaffold");
  const e = await thrown(() => renderGraphic(
    { code: "export default () => null;\n", width: 64, height: 64, fps: 30, durationInFrames: 1, outPath: join(workDir, "x.mov"), workDir },
    { ok: true, root: root || DEV_ROOT },
    { ...r, bundle: (async () => ((bundled = true), Promise.reject(new Error("smoke: bundle reached")))) as unknown as GraphicRemotion["bundle"] },
  ));
  const wrote = existsSync(workDir);
  rmSync(dirname(workDir), { recursive: true, force: true });
  return { guard: r.guard(), message: e?.message ?? null, bundled, wrote };
}

// ---- M4 ------------------------------------------------------------------------
// MUTATION: drop the "onDownload" (or "muted: true") entry from RENDER_MUST in check-io-imports.mjs → its self-test case fails here.
function m4() {
  console.log("M4. the lint (scripts/check-io-imports.mjs)...");
  const lint = join(REPO, "scripts", "check-io-imports.mjs");
  const run = (args: string[]) => spawnSync(process.execPath, [lint, ...args], { encoding: "utf8" });
  const self = run(["--self-test"]);
  const cases = [
    "render.ts without installChromeGuard( fails", "render.ts without isGuardedBrowser( fails", "render.ts without puppeteerInstance fails",
    "render.ts without onDownload fails", "render.ts without onBrowserDownload fails", "render.ts without muted: true fails", "render.ts without proxyGuardWorks( fails",
    "render.ts without guardRemotionProxy( fails", "render.ts with selectComposition fails", "Remotion loaded outside remotionload.ts (a named import) fails",
    "motion/render.ts with a value import of @remotion/renderer fails", "motion/chromeguard.ts with a value import of @remotion/renderer fails",
    "remotionload.ts with a static import of Remotion fails", "render.ts without the I9 plugin fails", "render.ts without its own publicDir fails",
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
  realChrome("M5", "--m5");
}

// MUTATION: drop the appendFileSync → with GITHUB_STEP_SUMMARY set and no cached shell, the
// summary rows fail.
/**
 * A real-render row that did not run: the console line, and on GitHub Actions
 * (GITHUB_STEP_SUMMARY set) a line in the job's step summary, so every CI run
 * shows that no real graphic was rendered.
 */
function skipped(name: string, why: string) {
  console.log(`  skip ${name}: ${why}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  const line = `- smoke-chromeguard: ${name} skipped, no real graphic render ran (${why})`;
  appendFileSync(summary, `${line}\n`);
  const lines = existsSync(summary) ? readFileSync(summary, "utf8").split("\n") : [];
  check(lines.includes(line), `${name}'s skip is in the step summary (${summary})`);
}

/** This file's `flag` part (a real Chrome render) in its own process, in an empty network namespace when it can. */
function realChrome(name: string, flag: string) {
  if (!shellCached()) {
    skipped(name, "Remotion's headless shell is not cached here, and this smoke downloads nothing");
    return;
  }
  const can = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
  const isolated = process.platform === "linux" && can("unshare", ["-rn", "sh", "-c", "ip link set lo up"]);
  const self = [...process.execArgv, fileURLToPath(import.meta.url), flag];
  const r = isolated
    ? spawnSync("unshare", ["-rn", "sh", "-c", 'ip link set lo up && exec "$0" "$@"', process.execPath, ...self], { stdio: "inherit", timeout: 600_000 })
    : spawnSync(process.execPath, self, { stdio: "inherit", timeout: 600_000 });
  check(r.status === 0, `${name} ${isolated ? "in an empty network namespace" : "(no unshare here: loopback servers only)"} passed (exit ${r.status})`);
}

/** A graphic that reports a same-as `src` to Remotion as an audio asset (RenderAssetManager), with no media component. */
const sameAsGraphic = (src: string) => `import React, { useContext, useEffect } from "react";
import { AbsoluteFill, Internals, useCurrentFrame } from "remotion";
export default function SameAs() {
  const { registerRenderAsset } = useContext(Internals.RenderAssetManager);
  const frame = useCurrentFrame();
  useEffect(() => {
    registerRenderAsset({ type: "audio", src: ${JSON.stringify(src)}, id: "zr-same-as", frame, volume: 1, mediaFrame: frame,
      playbackRate: 1, toneFrequency: 1, audioStartFrame: 0, audioStreamIndex: 0 } as never);
  }, [frame, registerRenderAsset]);
  return <AbsoluteFill style={{ background: "#123" }} />;
}
`;

/** M5 itself, in its own process. */
async function m5() {
  await setup();
  mode = "real";
  installChromeGuard(remotion.renderer.RenderInternals);
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
    const e1 = await thrown(() => renderGraphic({ ...base, code, outPath: join(work, "probe.mp4"), workDir: join(work, "probe") }, DEV));
    check(e1 === null && existsSync(join(work, "probe.mp4")), `the probe graphic renders (${e1?.message.slice(0, 160)})`);
    check(launches.length >= 1 && launches.every((a) => JSON.stringify(a.slice(-2)) === JSON.stringify(GRAPHICS_CHROME_SWITCHES)), `every Chrome it started had the switches (${launches.length})`);
    check(hits.control >= 1 && hits.other === 0, `the 127.0.0.1 control server saw ${hits.control} connection(s), 127.0.0.2 saw ${hits.other}`);
    // MUTATION: drop muted: true from renderWith (motion/render.ts) → Remotion adds a silent track.
    const streams = e1 === null ? await probeAsset(join(work, "probe.mp4")) : undefined;
    check(!!streams?.hasVideo && streams.hasAudio === false, `its H.264 has a video stream and no audio stream (video ${streams?.hasVideo}, audio ${streams?.hasAudio})`);
    const audio = `import React from "react";
import { AbsoluteFill, Audio } from "remotion";
export default function Sound() {
  return <AbsoluteFill><Audio src="data:audio/x-mpegurl;base64,I0VYVE0zVQojRVhUSU5GOjEuMCwKLy96ci1ldmlsLW01LmludmFsaWQvcy9zZWcudHMK" /></AbsoluteFill>;
}
`;
    const e2 = await thrown(() => renderGraphic({ ...base, code: audio, outPath: join(work, "audio.mp4"), workDir: join(work, "audio") }, DEV));
    check(!!e2?.message.includes(`${SENTENCE_HEAD}data:audio/x-mpegurl;`) && e2.message.includes(SENTENCE_TAIL), `a data: <Audio> fails with the message (${e2?.message.slice(0, 160)})`);
    check(written.length === 0, `nothing is written to Remotion's asset folder (${JSON.stringify(written.slice(0, 3))})`);
    // The page reports the asset to Remotion (M6b's graphic); the M3 rewrite refuses it.
    const e3 = await thrown(() => renderGraphic({ ...base, code: sameAsGraphic(ASSET_SRC), outPath: join(work, "same-as.mp4"), workDir: join(work, "same-as") }, DEV));
    check(!!e3?.message.includes(REFUSAL), `a graphic that reports a same-as asset fails with the refusal (${e3?.message.slice(0, 160)})`);
  } finally {
    control.close();
    other.close();
    rmSync(work, { recursive: true, force: true });
  }
  process.exit(failures === 0 ? 0 : 1);
}

// ---- M6 ------------------------------------------------------------------------
// MUTATION: guard another port in renderWith (guardRemotionProxy(port + 1)) → (a) reaches the
// compositor. Skip Upgrade requests in proxyguard.ts → the WebSocket row fails. Drop its parsed-path
// test → the absolute-form row answers 404. Make proxyGuardWorks() always true → (c) bundles.
// Drop muted: true → (b) sees ffprobe named. Leave the rewrite on in (d)'s process → (d) fails.
function m6(work: string) {
  console.log("M6. the second layer, each part alone (the M3 rewrite off in its own process)...");
  const traced = process.platform === "linux" && spawnSync("strace", ["-V"], { stdio: "ignore" }).status === 0;
  if (!traced) console.log("  (no strace here: the file trace is skipped; the compositor's commands are still checked)");
  const named = (log: string) => (log ? readFileSync(log, "utf8").split("\n").filter((l) => l.includes(PROXY_HOST)).length : 0);
  const loadedBefore = '{"ok":false,"reason":"loaded-before"}';

  const aLog = traced ? join(work, "m6a.strace") : "";
  const a = child("proxy", "", "", aLog);
  const aNamed = named(aLog);
  check(JSON.stringify(a.rewrite) === loadedBefore && a.error === null, `(a) the rewrite is off in this process, and renderGraphic ran (${JSON.stringify(a.rewrite)}; ${a.error ?? "no error"})`);
  check(a.fetched === 400 && a.ws === 400 && a.absolute === 400 && JSON.stringify(a.commands) === "[]",
    `(a) /proxy?src=same-as… on Remotion's server: fetch, WebSocket handshake and absolute form refused, the compositor got no command (${a.fetched}, ${a.ws}, ${a.absolute}; ${JSON.stringify(a.commands)})`);
  check(!traced || aNamed === 0, `(a) no file naming the source is opened (${traced ? `${aNamed} traced call(s)` : "not traced"})`);
  check(a.page === 200 && a.otherUrl === "unchanged" && a.after === false,
    `(a) the page still loads, another server's /proxy is untouched, the guard is gone after the render (${a.page}, ${a.otherUrl}, ${a.after})`);

  console.log("  (b) muted alone, a real render (only with a cached headless shell)...");
  realChrome("M6b", "--m6b");

  const c = child("render", "", "no-channel");
  check(refusedEarly(c, { ok: true }, off(`ZedMix couldn't guard Remotion's server on Node.js ${process.versions.node}.`)),
    `(c) Node's request channel reaches no subscriber: refused before bundling, nothing written (${JSON.stringify(c)})`);

  const dLog = traced ? join(work, "m6d.strace") : "";
  const d = child("proxy-open", "", "", dLog);
  const dNamed = named(dLog);
  const extracts = ((d.commands as string[] | undefined) ?? []).filter((x) => x === "ExtractFrame").length;
  check(JSON.stringify(d.rewrite) === loadedBefore && extracts >= 2 && (!traced || dNamed > 0),
    `(d) positive control, rewrite and guard off: the fetch and the handshake reach the compositor (${extracts} ExtractFrame), the trace sees the source (${traced ? `${dNamed} call(s)` : "not traced"}; ${JSON.stringify(d).slice(0, 200)})`);
}

/**
 * M6a / M6d in a child: Remotion loaded before the hook, so this process has no rewrite.
 * "proxy": renderGraphic (stubbed bundle and browser) whose renderMedia starts Remotion's own
 * server on the port renderGraphic gave it and sends it the requests; "proxy-open": the same
 * requests with no renderGraphic, so no /proxy guard either.
 */
async function proxyCase(name: string): Promise<Record<string, unknown>> {
  await setup();
  const work = mkdtempSync(join(tmpdir(), "aive-chromeguard-proxy-"));
  const bundleDir = join(work, "bundle");
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, "index.html"), "<!doctype html><title>x</title>");
  writeFileSync(join(bundleDir, "bundle.js"), "");
  try {
    const rewrite = remotion.guard();
    if (name === "proxy-open") return { rewrite, ...(await proxyRequests(5035, bundleDir, work, false)) };
    mode = "fake";
    let during: Record<string, unknown> = {};
    const r = await graphicRemotion(DEV_ROOT);
    const e = await thrown(() => renderGraphic(
      { code: "export default () => null;\n", width: 64, height: 64, fps: 30, durationInFrames: 1, alpha: false, outPath: join(work, "x.mp4"), workDir: join(work, "scaffold") },
      DEV,
      {
        ...r,
        guard: () => ({ ok: true }), // the rewrite is off here: the /proxy guard alone
        bundle: (async () => bundleDir) as unknown as GraphicRemotion["bundle"],
        ensureBrowser: (async () => ({ type: "user-defined-path", path: "" })) as unknown as GraphicRemotion["ensureBrowser"],
        openBrowser: (async () => browserClass.create({ args: [] })) as unknown as GraphicRemotion["openBrowser"],
        renderMedia: (async (o: { port: number }) => {
          during = await proxyRequests(o.port, bundleDir, work, true);
          return { buffer: null, slowestFrames: [], contentType: "" };
        }) as unknown as GraphicRemotion["renderMedia"],
      },
    ));
    return { rewrite, error: e?.message ?? null, ...during, after: channel(REQUEST_START).hasSubscribers };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Remotion's own server on `port`, as renderMedia starts it (prepareServer): a fetch, a
 * WebSocket handshake and an absolute-form request for /proxy?src=same-as…, then the page;
 * what its compositor was asked. With `other`, the same /proxy request to another server.
 */
async function proxyRequests(port: number, bundleDir: string, work: string, other: boolean): Promise<Record<string, unknown>> {
  const server = await remotion.renderer.RenderInternals.prepareServer({
    webpackConfigOrServeUrl: bundleDir, port, remotionRoot: work, offthreadVideoThreads: 1, logLevel: "error", indent: false,
    offthreadVideoCacheSizeInBytes: null, binariesDirectory: null, forceIPv4: true, sampleRate: 48000,
  });
  const commands: string[] = [];
  const compositor = server.compositor as unknown as { executeCommand: (cmd: string, p: unknown) => Promise<unknown> };
  const execute = compositor.executeCommand.bind(compositor);
  compositor.executeCommand = (cmd, p) => (commands.push(cmd), execute(cmd, p));
  const path = `/proxy?src=${encodeURIComponent(PROXY_SRC)}&time=0&transparent=false&toneMapped=true`;
  const upgrade = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" };
  try {
    const fetched = await raw(port, path);
    const ws = await raw(port, path, upgrade);
    const absolute = await raw(port, `http://127.0.0.1:${port}${path}`);
    const page = await raw(port, "/index.html");
    let otherUrl: string | undefined;
    if (other) {
      const s = createServer((q, res) => ((otherUrl = q.url), res.end()));
      await new Promise<void>((res) => s.listen(5034, "127.0.0.1", res));
      await raw(5034, path);
      await new Promise((res) => s.close(res));
    }
    return { fetched, ws, absolute, page, commands, otherUrl: otherUrl === path ? "unchanged" : otherUrl };
  } finally {
    await server.closeServer(true);
  }
}

/** A GET of `path` (origin or absolute form) on 127.0.0.1:`port`: its status (101 for an upgrade) or the error. */
function raw(port: number, path: string, headers: Record<string, string> = {}): Promise<number | string> {
  return new Promise((resolve) => {
    const q = request({ host: "127.0.0.1", port, path, headers, timeout: 30_000 });
    q.on("response", (r) => (r.resume(), resolve(r.statusCode ?? 0)));
    q.on("upgrade", (_r, socket) => (socket.destroy(), resolve(101)));
    q.on("timeout", () => q.destroy(new Error("timeout")));
    q.on("error", (err) => resolve(String(err)));
    q.end();
  });
}

// ---- M7 ------------------------------------------------------------------------
// MUTATION: release the /proxy guard as soon as the browser is closed (render.ts: releaseProxyGuard()
// in place of releaseWhenClosed) → both rows reach Remotion's /proxy (500). Release it at the
// deadline whatever the port says (proxyguard.ts) → the 5 s row is served.
async function m7(work: string) {
  console.log("M7. the /proxy guard outlives Remotion's server...");
  const bundleDir = join(work, "m7-bundle");
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, "index.html"), "<!doctype html><title>x</title>");
  writeFileSync(join(bundleDir, "bundle.js"), "");
  mode = "fake";
  const r = await graphicRemotion(DEV_ROOT);
  for (const closeAfterMs of [1000, 5000]) {
    let port = 0;
    let closed: Promise<unknown> = Promise.resolve();
    const commands: string[] = [];
    const t0 = Date.now();
    const e = await thrown(() => renderGraphic(
      { code: "export default () => null;\n", width: 64, height: 64, fps: 30, durationInFrames: 1, alpha: false, outPath: join(work, "m7.mp4"), workDir: join(work, "m7") },
      DEV,
      {
        ...r,
        bundle: (async () => bundleDir) as unknown as GraphicRemotion["bundle"],
        ensureBrowser: (async () => ({ type: "user-defined-path", path: "" })) as unknown as GraphicRemotion["ensureBrowser"],
        openBrowser: (async () => browserClass.create({ args: [] })) as unknown as GraphicRemotion["openBrowser"],
        renderMedia: (async (o: { port: number }) => {
          port = o.port;
          const server = await remotion.renderer.RenderInternals.prepareServer({
            webpackConfigOrServeUrl: bundleDir, port: o.port, remotionRoot: work, offthreadVideoThreads: 1, logLevel: "error", indent: false,
            offthreadVideoCacheSizeInBytes: null, binariesDirectory: null, forceIPv4: true, sampleRate: 48000,
          });
          const compositor = server.compositor as unknown as { executeCommand: (cmd: string, p: unknown) => Promise<unknown> };
          const execute = compositor.executeCommand.bind(compositor);
          compositor.executeCommand = (cmd, p) => (commands.push(cmd), execute(cmd, p));
          // As Remotion does: the server is closed after renderMedia settles, and nothing waits for it.
          closed = new Promise((res) => setTimeout(() => void server.closeServer(true).then(res, res), closeAfterMs));
          return { buffer: null, slowestFrames: [], contentType: "" };
        }) as unknown as GraphicRemotion["renderMedia"],
      },
    ));
    const tookMs = Date.now() - t0;
    const right = await raw(port, `/proxy?src=${encodeURIComponent(PROXY_SRC)}&time=0&transparent=false&toneMapped=true`);
    const refused = right === 400 || /ECONNREFUSED/.test(String(right));
    check(e === null && port > 0 && refused && (closeAfterMs < 3000 || right === 400) && commands.length === 0,
      `server closed ${closeAfterMs / 1000} s after renderMedia: right after renderGraphic returns (${tookMs} ms), /proxy?src=same-as… on its port is ${right === 400 ? "refused by the guard (400)" : String(right).slice(0, 60)}; the compositor got ${JSON.stringify(commands)} (${e?.message ?? "no error"})`);
    await closed;
    let after = true;
    for (let i = 0; i < 40 && after; i++) {
      await new Promise((res) => setTimeout(res, 100));
      after = channel(REQUEST_START).hasSubscribers;
    }
    check(!after, `…and the guard is gone once the server has closed (${after ? "still on" : "gone"})`);
  }
  await m7Cap();
}

// MUTATION: drop the cap test from releaseWhenClosed's background loop (proxyguard.ts) → the
// port is still polled after the cap. Release the guard at the cap → the release row fails.
/** A port that never closes: the background check stops at its cap (shortened here) and the guard stays on. */
async function m7Cap() {
  const port = 5036;
  let connections = 0;
  let seen: string | undefined;
  const server = createServer((q, res) => ((seen = q.url), res.end()));
  server.on("connection", () => connections++);
  await new Promise<void>((res) => server.listen(port, "127.0.0.1", res));
  const release = guardRemotionProxy(port);
  let released = false;
  try {
    await releaseWhenClosed(port, () => ((released = true), release()), 100, { pollMs: 20, capMs: 300 });
    await new Promise((res) => setTimeout(res, 800));
    const atCap = connections;
    await new Promise((res) => setTimeout(res, 600));
    const later = connections;
    const status = await raw(port, "/proxy?src=x");
    check(atCap >= 5 && later === atCap, `a port that never closes: the background check polled it (${atCap} connections) and stopped at its cap (${later - atCap} after it)`);
    check(!released && status === 200 && seen === "/%zedmix-refused-proxy" && channel(REQUEST_START).hasSubscribers,
      `…and the guard stays on: /proxy on that port reaches the server as ${JSON.stringify(seen)} (${status}; released ${released})`);
  } finally {
    release();
    await new Promise((res) => server.close(res));
  }
}

/** M6b in its own process: no rewrite (Remotion loaded before the hook), a real render of a graphic that reports a same-as asset. */
async function m6b() {
  await import("@remotion/renderer");
  await setup();
  mode = "real";
  // Every process Remotion starts (execa and Remotion's own spawns go through these).
  const spawned: string[] = [];
  const cp = require("node:child_process") as Record<string, (...a: unknown[]) => unknown>;
  for (const k of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
    const orig = cp[k];
    cp[k] = function (this: unknown, ...a: unknown[]) {
      spawned.push([a[0], ...(Array.isArray(a[1]) ? a[1] : [])].map(String).join(" "));
      return orig.apply(this, a);
    };
  }
  nodeModule.syncBuiltinESMExports();
  const work = mkdtempSync(join(tmpdir(), "aive-chromeguard-m6b-"));
  try {
    const r = await graphicRemotion(DEV_ROOT);
    check(JSON.stringify(r.guard()) === '{"ok":false,"reason":"loaded-before"}', `(b) the rewrite is off in this process (${JSON.stringify(r.guard())})`);
    const e = await thrown(() => renderGraphic(
      { code: sameAsGraphic(ASSET_SRC), width: 64, height: 64, fps: 30, durationInFrames: 1, alpha: false, outPath: join(work, "same-as.mp4"), workDir: join(work, "same-as") },
      DEV,
      { ...r, guard: () => ({ ok: true }) }, // muted alone
    ));
    const named = spawned.filter((c) => c.includes(ASSET_HOST));
    const ffmpeg = spawned.filter((c) => /ffmpeg|ffprobe/.test(c)).length;
    check(ffmpeg > 0 && named.length === 0,
      `(b) no ffprobe or ffmpeg names the same-as source (${spawned.length} processes, ${ffmpeg} FFmpeg; ${named.length} name it${named.length ? `: ${named[0].slice(0, 160)}` : ""}); the render ${e ? `failed: ${e.message.slice(0, 160)}` : "finished"}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  process.exit(failures === 0 ? 0 : 1);
}

// ---- M8 ------------------------------------------------------------------------
// MUTATION: give resolveGraphicsAddon a fallback to ZedMix's own node_modules
// (addon/resolve.ts) → add_graphic gets past the refusal and this row fails.
async function m8(work: string) {
  console.log("M8. no add-on: add_graphic refuses with graphics_addon_missing...");
  // The add-on path: the user chose the Remotion add-on (ZedMix's own renderer, the default, needs none).
  const dataDir = useRemotionRenderer(mkdtempSync(join(work, "m8-data-")));
  const engine = new EditorEngine(dataDir);
  const e = await withoutDevAddon(() => thrown(() => dispatch(engine, "add_graphic", { template: "title", durationSeconds: 1 })));
  const code = e instanceof RpcError ? e.code : e?.message;
  check(code === "graphics_addon_missing" && !existsSync(join(dataDir, "motion")) && !existsSync(join(dataDir, "baked")),
    `without AIVE_REMOTION_ADDON and an installed add-on: graphics_addon_missing, nothing written (${code})`);
}

if (process.argv[2] === "--child") {
  childCase(process.argv[3], process.argv[4], process.argv[5]).then(
    (r) => (console.log(JSON.stringify(r)), process.exit(0)),
    (err) => (console.log(JSON.stringify({ error: String(err) })), process.exit(1)),
  );
} else ({ "--m5": m5, "--m6b": m6b }[process.argv[2]] ?? main)().catch((err) => {
  console.error(err);
  process.exit(1);
});
