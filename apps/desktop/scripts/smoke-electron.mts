// Electron smoke: launches the real desktop app (apps/desktop, electron/main.cjs)
// with Playwright's _electron and drives it like a user.
//
//   1. Start with a RELATIVE AIVE_DATA_DIR: the launcher hands the core an
//      absolute path (<cwd>/<dir>/server.json, the core's own environment),
//      the window connects ("Core :<port>").
//   2. Import (native open dialog stubbed) → Add to timeline → Play → Pause;
//      every seek the preview's decoder pool starts while playing lands, there
//      are only a few of them, and on at least 75% of the animation frames the
//      playing decoder has a frame to draw (a seek that lands behind the
//      playhead used to start the next one at once: seek thrash, a black
//      preview while playing);
//      split at the playhead, then Delete with no piece picked does nothing
//      (the split replaced the selected clip).
//   3. Project menu: New / Open / Save / Save As / Storage…; the Storage dialog
//      opens, loads its report and closes.
//   4. Native save dialogs (stubbed in the main process): the path the user
//      typed gets the same extension rule as the web picker (src/savename.ts),
//      a file that the added extension would overwrite is confirmed again, and
//      the export dialog lists the preset's container first.
//   5. Export with no extension typed → out.mp4; "out.webm" typed with the
//      YouTube preset → a VP9 WebM (presetForPath).
//   6. Closing with unsaved changes: "Save" with the Save As dialog cancelled
//      keeps the window open (and a later Save As does not close it); once the
//      project has a file, "Save" saves there and the app quits; the core the
//      app started exits with it.
//   7. Start again with an ABSOLUTE AIVE_DATA_DIR from another folder; a clean
//      project closes without asking.
//   8. A never-saved project: close → "Save" → a typed name is saved as
//      <name>.aive, then the app quits.
//   No renderer console errors or page errors in either run.
//   The app runs with its own profile (--user-data-dir) in the test folder, so
//   the user's SynthCut profile and its recent projects are left alone.
//
// Run (needs a display; xvfb-run provides one without showing a window):
//   xvfb-run -a npx tsx apps/desktop/scripts/smoke-electron.mts
// Needs: npm run build, the Electron binary (node node_modules/electron/install.js
// when node_modules/electron/dist is missing), FFmpeg on PATH and playwright-core
// (PLAYWRIGHT_CORE=<dir> overrides the search, as in parity-gl.mts). AIVE_PORT
// picks the core's port (default: any free port; note that Chromium refuses
// some ports, e.g. 5060/5061, with ERR_UNSAFE_PORT).
// SYNTHCUT_APP=<packaged executable> runs a packed build instead of the source
// tree, e.g. after `npx electron-builder --dir --linux` in apps/desktop:
//   SYNTHCUT_APP=apps/desktop/build/dist/linux-unpacked/synthcut-desktop xvfb-run -a npx tsx apps/desktop/scripts/smoke-electron.mts
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { resolveSaveName, presetForPath } from "../src/savename.js";
import { exportFilters } from "../src/platform.js";

type PW = typeof import("playwright-core");
type ElectronApp = Awaited<ReturnType<PW["_electron"]["launch"]>>;
type Page = Awaited<ReturnType<ElectronApp["firstWindow"]>>;

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const require = createRequire(import.meta.url);

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadPlaywright(): Promise<PW> {
  const out: string[] = [];
  if (process.env.PLAYWRIGHT_CORE) out.push(process.env.PLAYWRIGHT_CORE);
  out.push(resolve(HERE, "../../../node_modules/playwright-core"));
  const npx = join(homedir(), ".npm", "_npx");
  if (existsSync(npx)) for (const d of readdirSync(npx)) out.push(join(npx, d, "node_modules", "playwright-core"));
  for (const c of out.filter((c) => existsSync(join(c, "package.json")))) {
    try {
      return (await import(pathToFileURL(join(c, "index.mjs")).href)) as PW;
    } catch {
      /* try the next one */
    }
  }
  throw new Error("playwright-core not found — set PLAYWRIGHT_CORE to its directory");
}

function electronBinary(): string {
  const pkg = dirname(require.resolve("electron/package.json"));
  const rel = existsSync(join(pkg, "path.txt")) ? readFileSync(join(pkg, "path.txt"), "utf8") : "";
  const bin = rel ? join(pkg, "dist", rel) : "";
  if (!bin || !existsSync(bin)) {
    throw new Error(`Electron binary missing (${bin || join(pkg, "dist")}). Run: node ${join(pkg, "install.js")}`);
  }
  return bin;
}

function ffprobe(file: string): { codec: string; duration: number } {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name:format=duration", "-of", "json", file], { encoding: "utf8" });
  const j = JSON.parse(r.stdout || "{}");
  return { codec: j.streams?.[0]?.codec_name ?? "", duration: Number(j.format?.duration ?? 0) };
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const launched: ElectronApp[] = [];

interface Run {
  app: ElectronApp;
  win: Page;
  errors: string[];
  alerts: string[];
  mainLog: () => string;
}

async function launch(pw: PW, cwd: string, dataDir: string): Promise<Run> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("ELECTRON_")) env[k] = v;
  Object.assign(env, { AIVE_DATA_DIR: dataDir, AIVE_PORT: process.env.AIVE_PORT ?? "0" });
  const packaged = process.env.SYNTHCUT_APP;
  const app = await pw._electron.launch({
    executablePath: packaged || electronBinary(),
    // SwiftShader gives the renderer WebGL2 without a GPU, as on a plain VM.
    // A profile under the test folder: the user's own (~/.config/SynthCut…,
    // with its recent projects) is neither read nor changed.
    args: [...(packaged ? [] : [APP_DIR]), `--user-data-dir=${join(cwd, "..", "profile")}`, "--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    cwd,
    env,
    timeout: 60000,
  });
  launched.push(app);
  let log = "";
  app.process().stderr?.on("data", (d) => (log += d.toString()));
  app.process().stdout?.on("data", (d) => (log += d.toString()));
  const win = await app.firstWindow({ timeout: 60000 });
  const errors: string[] = [];
  const alerts: string[] = [];
  win.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  win.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  win.on("dialog", (d) => {
    alerts.push(d.message());
    void d.accept();
  });
  return { app, win, errors, alerts, mainLog: () => log };
}

/** Replace a main-process dialog function; every call's options are kept in globalThis.__calls. */
async function stub(app: ElectronApp, fn: "showOpenDialog" | "showSaveDialog" | "showMessageBoxSync", results: unknown[]) {
  await app.evaluate(({ dialog }, { fn, results }) => {
    const g = globalThis as unknown as { __calls: Record<string, unknown[]>; __results: Record<string, unknown[]> };
    g.__calls ??= {};
    g.__results ??= {};
    g.__calls[fn] = [];
    g.__results[fn] = [...results];
    (dialog as unknown as Record<string, unknown>)[fn] = (...args: unknown[]) => {
      const opts = args.find((a) => a && typeof a === "object" && !("webContents" in (a as object)));
      g.__calls[fn].push(opts);
      const r = g.__results[fn].length > 1 ? g.__results[fn].shift() : g.__results[fn][0];
      return fn === "showMessageBoxSync" ? r : Promise.resolve(r);
    };
  }, { fn, results });
}
const calls = (app: ElectronApp, fn: string) =>
  app.evaluate((_e, fn) => ((globalThis as unknown as { __calls: Record<string, unknown[]> }).__calls?.[fn] ?? []), fn) as Promise<
    { defaultPath?: string; filters?: { extensions: string[] }[]; message?: string }[]
  >;
const saveResult = (filePath: string | null) => (filePath ? { canceled: false, filePath } : { canceled: true, filePath: undefined });

async function waitFor(what: string, fn: () => boolean | Promise<boolean>, ms = 30000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(200);
  }
  console.log(`  (timed out waiting for ${what})`);
  return false;
}

async function main() {
  const pw = await loadPlaywright();
  const work = mkdtempSync(join(tmpdir(), "aive-electron-"));
  const clip = join(work, "clip.mp4");
  spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
  check(existsSync(clip), "synthesized a 6 s test clip");

  // ---------------------------------------------------------------- run 1
  console.log("1. start with a relative AIVE_DATA_DIR...");
  const cwd1 = join(work, "cwd1");
  mkdirSync(cwd1);
  const r1 = await launch(pw, cwd1, "data-rel");
  const { app, win } = r1;
  const serverJson = join(cwd1, "data-rel", "server.json");
  check(await waitFor("server.json", () => existsSync(serverJson)), "server.json written under <cwd>/data-rel");
  const info = existsSync(serverJson) ? JSON.parse(readFileSync(serverJson, "utf8")) : {};
  check(await waitFor("Core pill", async () => (await win.locator(".statuspill.ok").count()) > 0), `window connected (${await win.locator(".statuspill").innerText().catch(() => "?")})`);
  check((await win.locator(".statuspill .port").innerText().catch(() => "")) === `:${info.port}`, `pill shows the core's port :${info.port}`);
  if (process.platform === "linux" && info.pid) {
    const environ = readFileSync(`/proc/${info.pid}/environ`, "utf8").split("\0");
    const dd = environ.find((l) => l.startsWith("AIVE_DATA_DIR="));
    check(dd === `AIVE_DATA_DIR=${join(cwd1, "data-rel")}`, `core got the absolute data dir (${dd})`);
    if (process.env.SYNTHCUT_APP) {
      const ff = environ.find((l) => l.startsWith("AIVE_FFMPEG=")) ?? "";
      check(ff.includes(`${join("resources", "aive", "ffmpeg")}`), `packaged: the core uses the bundled FFmpeg (${ff})`);
    }
  }
  check(/started core on port/.test(r1.mainLog()), "main process started its own core");
  const userData = await app.evaluate(({ app }) => app.getPath("userData"));
  check(userData === join(work, "profile"), `app profile is the test's own (${userData})`);


  console.log("2. import → add to timeline → play...");
  await stub(app, "showOpenDialog", [{ canceled: false, filePaths: [clip] }]);
  await win.getByRole("button", { name: "Import", exact: true }).click();
  check(await waitFor("asset row", async () => (await win.getByRole("button", { name: "Add to timeline" }).count()) > 0), "clip.mp4 is in the library");
  await win.getByRole("button", { name: "Add to timeline" }).first().click();
  const play = win.getByRole("button", { name: "Play", exact: true });
  check(await waitFor("Play enabled", async () => (await play.count()) > 0 && (await play.isEnabled())), "timeline has a clip (Play enabled)");
  const clock0 = await win.locator(".tp-now").first().innerText().catch(() => "");
  // Media events don't bubble: count them in the capture phase. Every animation
  // frame, note whether the playing decoder has a frame the canvas can draw
  // (readyState >= 2, not seeking); the preview is black on the frames it hasn't.
  // (A string, because tsx wraps named functions in a __name() helper the page lacks.)
  type Probe = { seeking: number; seeked: number; ticks: number; drawable: number; landed: boolean; on: boolean };
  await win.evaluate(`(() => {
    const p = (window.__seeks = { seeking: 0, seeked: 0, ticks: 0, drawable: 0, landed: false, on: true });
    document.addEventListener("seeking", () => p.seeking++, true);
    document.addEventListener("seeked", () => p.seeked++, true);
    const tick = () => {
      if (!p.on) return;
      const v = [...document.querySelectorAll(".pv-pool video")].find((x) => !x.paused);
      if (v) {
        const ok = v.readyState >= 2 && !v.seeking;
        p.landed = p.landed || ok; // from the first frame shown (playback may start with a seek)
        if (p.landed) {
          p.ticks++;
          if (ok) p.drawable++;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
  await play.click();
  check(await waitFor("Pause", async () => (await win.getByRole("button", { name: "Pause", exact: true }).count()) > 0, 5000), "playing (button turns into Pause)");
  await sleep(2000);
  const clock1 = await win.locator(".tp-now").first().innerText().catch(() => "");
  await win.getByRole("button", { name: "Pause", exact: true }).click().catch(() => {});
  const seeks = await win.evaluate(() => {
    const p = (window as unknown as { __seeks: Probe }).__seeks;
    p.on = false;
    return p;
  });
  check(seeks.seeked >= seeks.seeking - 1, `seeks during playback land (${seeks.seeking} started, ${seeks.seeked} landed)`);
  // A seek that lands behind the playhead used to start the next one at once
  // (seek thrash): ~15 seeks in 2 s and a black preview for most of them.
  const shown = seeks.ticks ? seeks.drawable / seeks.ticks : 0;
  check(seeks.seeking <= 6, `no seek thrash while playing (${seeks.seeking} seeks in 2 s)`);
  check(shown >= 0.75, `the preview has a frame to draw while playing (${(shown * 100).toFixed(0)}% of ${seeks.ticks} animation frames)`);
  check(clock0 !== clock1, `playhead moved (${clock0.replace(/\s+/g, " ")} → ${clock1.replace(/\s+/g, " ")})`);

  console.log("2b. split at the playhead, then Delete without picking a piece...");
  const tlClip = win.locator(".tl-clip").first();
  const tb = await tlClip.boundingBox();
  await tlClip.click({ position: { x: 20, y: (tb?.height ?? 40) - 8 } });
  await tlClip.getByRole("button", { name: "Split at playhead" }).click();
  check(await waitFor("2 pieces", async () => (await win.locator(".tl-clip").count()) === 2, 10000), "split into two pieces");
  await win.keyboard.press("Delete");
  await sleep(1000);
  check((await win.locator(".error-bar").count()) === 0, `Delete does not act on the replaced clip (${(await win.locator(".error-bar").innerText().catch(() => "no error")).split("\n")[0]})`);
  check((await win.locator(".tl-clip").count()) === 2, "both pieces are still there");

  console.log("3. Project menu and Storage…...");
  await win.getByRole("button", { name: /Project/ }).click();
  const items = (await win.getByRole("menuitem").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  check(["New project", "Open…", "Save", "Save As…", "Storage…"].every((n) => items.some((t) => t.startsWith(n))), `menu items: ${items.join(" | ")}`);
  await win.getByRole("menuitem", { name: /Storage/ }).click();
  const storage = win.getByRole("dialog", { name: /Storage/i });
  check(await waitFor("storage dialog", async () => (await storage.count()) > 0, 5000), "Storage dialog opens");
  check(await waitFor("storage report", async () => /Unused files|trash/i.test(await storage.innerText().catch(() => "")), 15000), "Storage dialog shows its report");
  await storage.getByRole("button", { name: "Close" }).first().click();
  check(await waitFor("storage closed", async () => (await storage.count()) === 0, 5000), "Storage dialog closes");

  console.log("4. native save dialogs: extension rule (src/savename.ts) and overwrite check...");
  const typed = [
    ["mp4", join(work, "out")],
    ["mp4", join(work, "out.webm")],
    ["mp4", join(work, "my.clip")],
    ["mp4", join(work, "OUT.MOV")],
    ["webm", join(work, "out")],
    ["mov", join(work, "out.Mp4")],
  ] as const;
  for (const [ext, name] of typed) {
    await stub(app, "showSaveDialog", [saveResult(name)]);
    const got = await win.evaluate((ext) => window.aive!.pickSavePath(ext), ext);
    const want = resolveSaveName(name, exportFilters(ext), 0).name;
    check(got === want, `${ext} preset, typed ${name.slice(work.length + 1)} → ${String(got).slice(work.length + 1)} (savename.ts: ${want.slice(work.length + 1)})`);
  }
  const [opts] = await calls(app, "showSaveDialog");
  check(opts?.defaultPath === "export.mov" && opts?.filters?.map((f) => f.extensions[0]).join(",") === "mov,mp4,webm", `export dialog: default export.mov, filters ${opts?.filters?.map((f) => f.extensions[0]).join(",")}`);
  writeFileSync(join(work, "taken.mp4"), "x");
  await stub(app, "showSaveDialog", [saveResult(join(work, "taken"))]);
  await stub(app, "showMessageBoxSync", [1]);
  check((await win.evaluate(() => window.aive!.pickSavePath("mp4"))) === null, "taken → taken.mp4 exists, Cancel → no path");
  const [ask] = await calls(app, "showMessageBoxSync");
  check(/taken\.mp4" already exists/.test(ask?.message ?? ""), `asks before replacing (${ask?.message})`);
  await stub(app, "showMessageBoxSync", [0]);
  check((await win.evaluate(() => window.aive!.pickSavePath("mp4"))) === join(work, "taken.mp4"), "Replace → taken.mp4");
  await stub(app, "showSaveDialog", [saveResult(join(work, "My Cut"))]);
  check((await win.evaluate(() => window.aive!.saveProjectAs("My Cut"))) === join(work, "My Cut.aive"), "Save project as: typed 'My Cut' → My Cut.aive");
  const [popts] = await calls(app, "showSaveDialog");
  check(popts?.defaultPath === "My Cut.aive", `project dialog default ${popts?.defaultPath}`);

  console.log("5. export from the Export menu...");
  const exportWith = async (label: RegExp, typedPath: string) => {
    await stub(app, "showSaveDialog", [saveResult(typedPath)]);
    r1.alerts.length = 0;
    await win.getByRole("button", { name: /Export…/ }).click();
    await win.getByRole("menuitem", { name: label }).first().click();
    return waitFor("export alert", () => r1.alerts.some((a) => /Exported/.test(a)), 120000);
  };
  check(await exportWith(/^YouTube H\.264/, join(work, "out")), "YouTube export finished (no extension typed)");
  const mp4 = ffprobe(join(work, "out.mp4"));
  check(mp4.codec === "h264" && Math.abs(mp4.duration - 6) < 0.2, `out.mp4: ${mp4.codec}, ${mp4.duration.toFixed(2)} s`);
  check(presetForPath([{ id: "youtube", ext: "mp4" }, { id: "web", ext: "webm" }], "youtube", "x.webm") === "web", "presetForPath maps .webm to the WebM preset");
  check(await exportWith(/^YouTube H\.264/, join(work, "typed.webm")), "YouTube preset + typed .webm finished");
  const webm = ffprobe(join(work, "typed.webm"));
  check(webm.codec === "vp9", `typed.webm is WebM/VP9 (${webm.codec || "missing"})`);

  console.log("6. close with unsaved changes...");
  check((await win.locator(".proj-dot").count()) > 0, "project shows unsaved changes");
  await stub(app, "showMessageBoxSync", [0]); // "Save"
  await stub(app, "showSaveDialog", [saveResult(null)]); // …then cancel the Save As dialog
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await sleep(1500);
  check(!win.isClosed() && (await calls(app, "showSaveDialog")).length === 1, "Save → Save As dialog shown (sendMenu); cancelled → window stays open");
  await stub(app, "showSaveDialog", [saveResult(join(work, "manual"))]);
  await win.getByRole("button", { name: /Project/ }).click();
  await win.getByRole("menuitem", { name: /Save As/ }).click();
  check(await waitFor("manual.aive", () => existsSync(join(work, "manual.aive")), 15000), "a later Save As writes manual.aive");
  await sleep(1500);
  check(!win.isClosed(), "…and does not close the window");
  // Dirty it again, then close → Save: the project has a file now, so it is
  // saved there without a dialog, and the app quits.
  await win.getByRole("button", { name: "Add to timeline" }).first().click();
  check(await waitFor("dirty", async () => (await win.locator(".proj-dot").count()) > 0, 10000), "edited again (unsaved)");
  await stub(app, "showMessageBoxSync", [0]);
  await stub(app, "showSaveDialog", [saveResult(join(work, "unexpected"))]);
  const closed = new Promise<void>((r) => app.once("close", () => r()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  const didClose = await Promise.race([closed.then(() => true), sleep(30000).then(() => false)]);
  check(didClose, "Save → saved to its file, then quit");
  const clipsIn = (file: string) => {
    const p = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    return p?.tracks?.reduce((n: number, t: { clips: unknown[] }) => n + t.clips.length, 0) ?? 0;
  };
  check(clipsIn(join(work, "manual.aive")) === 3 && !existsSync(join(work, "unexpected.aive")), `manual.aive holds all three clips (${clipsIn(join(work, "manual.aive"))}), no Save As dialog`);
  check(await waitFor("core exit", () => !pidAlive(info.pid), 10000), "the core the app started exited with it");
  check(!/A JavaScript error occurred|ReferenceError|TypeError/.test(r1.mainLog()), "no main-process errors");
  check(r1.errors.length === 0, `no renderer console errors${r1.errors.length ? `:\n    ${r1.errors.join("\n    ")}` : ""}`);
  if (!didClose) await app.close().catch(() => {});

  // ---------------------------------------------------------------- run 2
  console.log("7. start with an absolute AIVE_DATA_DIR from another folder...");
  const cwd2 = join(work, "cwd2");
  mkdirSync(cwd2);
  const abs = join(work, "data-abs");
  const r2 = await launch(pw, cwd2, abs);
  check(await waitFor("server.json", () => existsSync(join(abs, "server.json"))), "server.json written to the absolute dir");
  check(!existsSync(join(cwd2, "data-abs")) && !existsSync(join(cwd2, "data-rel")), "nothing written under the working folder");
  check(await waitFor("Core pill", async () => (await r2.win.locator(".statuspill.ok").count()) > 0), "window connected");
  const info2 = JSON.parse(readFileSync(join(abs, "server.json"), "utf8"));
  const closed2 = new Promise<void>((r) => r2.app.once("close", () => r()));
  await r2.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  check(await Promise.race([closed2.then(() => true), sleep(15000).then(() => false)]), "a clean project closes without asking");
  check(await waitFor("core exit", () => !pidAlive(info2.pid), 10000), "its core exited");
  check(r2.errors.length === 0, `no renderer console errors${r2.errors.length ? `:\n    ${r2.errors.join("\n    ")}` : ""}`);
  await r2.app.close().catch(() => {});

  // ---------------------------------------------------------------- run 3
  console.log("8. a never-saved project: close → Save → typed name → saved as <name>.aive, then quit...");
  const r3 = await launch(pw, cwd2, abs);
  check(await waitFor("Core pill", async () => (await r3.win.locator(".statuspill.ok").count()) > 0), "window connected");
  await stub(r3.app, "showOpenDialog", [{ canceled: false, filePaths: [clip] }]);
  await r3.win.getByRole("button", { name: "Import", exact: true }).click();
  check(await waitFor("asset row", async () => (await r3.win.getByRole("button", { name: "Add to timeline" }).count()) > 0), "imported");
  await r3.win.getByRole("button", { name: "Add to timeline" }).first().click();
  check(await waitFor("dirty", async () => (await r3.win.locator(".proj-dot").count()) > 0, 10000), "unsaved changes");
  await stub(r3.app, "showMessageBoxSync", [0]);
  await stub(r3.app, "showSaveDialog", [saveResult(join(work, "guarded"))]);
  const info3 = JSON.parse(readFileSync(join(abs, "server.json"), "utf8"));
  const closed3 = new Promise<void>((r) => r3.app.once("close", () => r()));
  await r3.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  check(await Promise.race([closed3.then(() => true), sleep(30000).then(() => false)]), "saved and quit");
  check(clipsIn(join(work, "guarded.aive")) === 1, `guarded.aive (extension added) holds the clip (${clipsIn(join(work, "guarded.aive"))})`);
  check(await waitFor("core exit", () => !pidAlive(info3.pid), 10000), "its core exited");
  check(!/A JavaScript error occurred|ReferenceError|TypeError/.test(r3.mainLog()), "no main-process errors");
  check(r3.errors.length === 0, `no renderer console errors${r3.errors.length ? `:\n    ${r3.errors.join("\n    ")}` : ""}`);
  await r3.app.close().catch(() => {});

  rmSync(work, { recursive: true, force: true });
  if (failures) {
    console.log(`\nELECTRON SMOKE TEST FAILED (${failures} check(s))`);
    process.exit(1);
  }
  console.log("\nELECTRON SMOKE TEST PASSED");
  process.exit(0);
}

main().catch(async (err) => {
  console.error("ELECTRON SMOKE TEST FAILED:", err);
  for (const a of launched) {
    // An unsaved project would wait on the real "Save changes?" box: answer
    // "Don't Save" so the app quits and stops its core; kill it if it still hangs.
    await a.evaluate(({ dialog }) => { (dialog as unknown as { showMessageBoxSync: () => number }).showMessageBoxSync = () => 1; }).catch(() => {});
    const closed = await Promise.race([a.close().then(() => true, () => true), sleep(15000).then(() => false)]);
    if (!closed) a.process().kill("SIGKILL");
  }
  process.exit(1);
});
