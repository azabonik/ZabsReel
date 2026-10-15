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
//      (the split replaced the selected clip); a drag of a new audio track's
//      volume slider sends one set_track_properties edit (one undo entry), not
//      one per step, an arrow key sends one more, and a key released after the
//      focus moved away is committed when the slider loses focus (once); with
//      a clip on that track, the preview's Web Audio gain for it follows the
//      slider while dragged (above 1 too), still with one edit on release, the
//      committed value then drives it, and Escape or a pointercancel mid-drag
//      puts it back to the committed value with no edit; an
//      audio clip's waveform comes from the core's /peaks (200), and the
//      renderer never fetches the whole file to decode it.
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
//      project closes without asking. Before that (7b), the window's network
//      limits: main sets auth-server-whitelist to a non-empty sentinel; a
//      script from http://zr-evil.invalid and from file://zr-evil.invalid ends
//      with net::ERR_BLOCKED_BY_CLIENT (the request guard, net-guard.cjs, which
//      main logs by origin); a navigation away from the app's page is
//      cancelled; the page carries the CSP meta tag, and a media element
//      pointed at another origin raises a media-src violation.
//   8. A never-saved project: close → "Save" → a typed name is saved as
//      <name>.aive, then the app quits.
//   9. Network computers (a 4th run; test servers under .invalid, which never
//      resolve, and native dialogs stubbed). A server in the store that
//      ZabsReel didn't stamp ("added outside") is
//      offline at load, with the outside banner; Review… shows the Keep dialog
//      (Remove default and Esc): Remove takes it out of the store, Keep stamps
//      it and its clips come online without a reload. A project on a server
//      not allowed shows the banner and an "Offline" badge, and the page asks
//      the core for none of its files (no /file, /peaks or /frames URL, no
//      thumbnail); Keep offline in the Allow dialog changes nothing, Allow
//      stores it and the clips come online. A file picked in the native open
//      dialog on a server not allowed yet asks once ("You picked …"): Keep
//      offline returns no path and saves nothing, and the store stays
//      unchanged until Allow, which saves it (via picker). A recent
//      project on a server not allowed opens the dialog with "You opened" and
//      the banner says "You tried"; an agent's import_video says "The AI
//      assistant asked" in both. Project → Network computers… lists the
//      servers (outside ones with Keep… and Remove, no date) and Remove takes
//      one out. Save As never starts in a folder from the project's name.
//   No renderer console errors or page errors in any run.
//   The app runs with its own profile (--user-data-dir) in the test folder, so
//   the user's ZabsReel profile and its recent projects are left alone.
//
// Run (needs a display; xvfb-run provides one without showing a window):
//   xvfb-run -a npx tsx apps/desktop/scripts/smoke-electron.mts
// Needs: npm run build, the Electron binary (node node_modules/electron/install.js
// when node_modules/electron/dist is missing), FFmpeg on PATH and playwright-core
// (PLAYWRIGHT_CORE=<dir> overrides the search, as in parity-gl.mts). AIVE_PORT
// picks the core's port (default: any free port; note that Chromium refuses
// some ports, e.g. 5060/5061, with ERR_UNSAFE_PORT).
// AIVE_APP=<packaged executable> runs a packed build instead of the source
// tree, e.g. after `npx electron-builder --dir --linux` in apps/desktop:
//   AIVE_APP=apps/desktop/build/dist/linux-unpacked/zabsreel-desktop xvfb-run -a npx tsx apps/desktop/scripts/smoke-electron.mts
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { resolveSaveName, presetForPath } from "../src/savename.js";
import { exportFilters } from "../src/platform.js";
import { stopLeftoverCores } from "./leftover-cores.js";

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
/** The data folder of every launch: at the end, also after a failure, no core of these may still run. */
const launchedDataDirs: string[] = [];

/** Stop any core of this run that is still running (by its exact pid, leftover-cores.ts); the check fails if one stays. */
async function noLeftoverCores() {
  const cores = await stopLeftoverCores([...new Set(launchedDataDirs)]);
  if (cores.stopped.length) console.log(`  (stopped a core left running: ${cores.stopped.join(", ")})`);
  check(cores.left.length === 0, `no core this smoke started is left running${cores.left.length ? ` (${cores.left.join(", ")})` : ""}`);
}

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
  const packaged = process.env.AIVE_APP;
  const app = await pw._electron.launch({
    executablePath: packaged || electronBinary(),
    // SwiftShader gives the renderer WebGL2 without a GPU, as on a plain VM.
    // A profile under the test folder: the user's own (~/.config/ZabsReel…,
    // with its recent projects) is neither read nor changed.
    args: [...(packaged ? [] : [APP_DIR]), `--user-data-dir=${join(cwd, "..", "profile")}`, "--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    cwd,
    env,
    timeout: 60000,
  });
  launched.push(app);
  launchedDataDirs.push(resolve(cwd, dataDir));
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
async function stub(app: ElectronApp, fn: "showOpenDialog" | "showSaveDialog" | "showMessageBoxSync" | "showMessageBox", results: unknown[]) {
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
    {
      defaultPath?: string; filters?: { name?: string; extensions: string[] }[]; message?: string;
      title?: string; detail?: string; buttons?: string[]; defaultId?: number; cancelId?: number; properties?: string[];
    }[]
  >;
/** Stub showMessageBox so it waits: each call is kept in globalThis.__calls at once, and answer() settles the oldest. */
async function stubWaiting(app: ElectronApp) {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __calls: Record<string, unknown[]>; __answers: ((r: { response: number }) => void)[] };
    g.__calls ??= {};
    g.__calls.showMessageBox = [];
    g.__answers = [];
    (dialog as unknown as Record<string, unknown>).showMessageBox = (...args: unknown[]) => {
      g.__calls.showMessageBox.push(args.find((a) => a && typeof a === "object" && !("webContents" in (a as object))));
      return new Promise((res) => g.__answers.push(res));
    };
  });
}
const answer = (app: ElectronApp, response: number) =>
  app.evaluate((_e, response) => (globalThis as unknown as { __answers: ((r: { response: number }) => void)[] }).__answers.shift()?.({ response }), response);
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
  const tone = join(work, "tone.wav");
  spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=6", tone]);
  check(existsSync(tone), "synthesized a 6 s audio-only file");

  // ---------------------------------------------------------------- run 1
  console.log("1. start with a relative AIVE_DATA_DIR...");
  const cwd1 = join(work, "cwd1");
  mkdirSync(cwd1);
  const r1 = await launch(pw, cwd1, "data-rel");
  const { app, win } = r1;
  // Waveform traffic for tone.wav: /peaks answers, and /file requests made by fetch/XHR (the WebAudio
  // fallback reads the whole file that way; a media element's own /file requests are "media").
  const peaksStatus: number[] = [];
  const toneFetches: string[] = [];
  const toneQuery = (url: string) => {
    const u = new URL(url);
    return u.searchParams.get("path") === tone ? u.pathname : "";
  };
  win.on("response", (r) => {
    if (toneQuery(r.url()) === "/peaks") peaksStatus.push(r.status());
  });
  win.on("request", (r) => {
    if (toneQuery(r.url()) === "/file" && ["fetch", "xhr"].includes(r.resourceType())) toneFetches.push(r.resourceType());
  });
  const serverJson = join(cwd1, "data-rel", "server.json");
  check(await waitFor("server.json", () => existsSync(serverJson)), "server.json written under <cwd>/data-rel");
  const info = existsSync(serverJson) ? JSON.parse(readFileSync(serverJson, "utf8")) : {};
  check(await waitFor("Core pill", async () => (await win.locator(".statuspill.ok").count()) > 0), `window connected (${await win.locator(".statuspill").innerText().catch(() => "?")})`);
  check((await win.locator(".statuspill .port").innerText().catch(() => "")) === `:${info.port}`, `pill shows the core's port :${info.port}`);
  if (process.platform === "linux" && info.pid) {
    const environ = readFileSync(`/proc/${info.pid}/environ`, "utf8").split("\0");
    const dd = environ.find((l) => l.startsWith("AIVE_DATA_DIR="));
    check(dd === `AIVE_DATA_DIR=${join(cwd1, "data-rel")}`, `core got the absolute data dir (${dd})`);
    if (process.env.AIVE_APP) {
      const ff = environ.find((l) => l.startsWith("AIVE_FFMPEG=")) ?? "";
      check(ff.includes(`${join("resources", "aive", "ffmpeg")}`), `packaged: the core uses the bundled FFmpeg (${ff})`);
    }
  }
  check(/started core on port/.test(r1.mainLog()), "main process started its own core");
  const userData = await app.evaluate(({ app }) => app.getPath("userData"));
  check(userData === join(work, "profile"), `app profile is the test's own (${userData})`);
  // The brand: the app's name (taskbar, dialogs), the Windows AUMID and the window title.
  const appName = await app.evaluate(({ app }) => app.getName());
  const wantName = process.env.AIVE_APP ? "ZabsReel" : "ZabsReel (DEV)";
  check(appName === wantName, `app.getName() is "${wantName}" (${appName})`);
  const brand = require("../electron/brand.cjs") as { APP_ID: string; APP_ID_DEV: string };
  check(brand.APP_ID === "io.github.azabonik.zabsreel" && brand.APP_ID_DEV === `${brand.APP_ID}.dev`, `AUMIDs are ${brand.APP_ID} and ${brand.APP_ID_DEV}`);
  // setAppUserModelId has no getter and does nothing off Windows, so check what main.cjs passes it.
  const mainSrc = readFileSync(join(APP_DIR, "electron", "main.cjs"), "utf8");
  check(/const AUMID = app\.isPackaged \? APP_ID : APP_ID_DEV;/.test(mainSrc) && /setAppUserModelId\(AUMID\)/.test(mainSrc), "main.cjs sets the AUMID: APP_ID when packaged, APP_ID_DEV in a dev run");
  const title = await win.title();
  check(title.includes("ZabsReel"), `window title shows ZabsReel (${title})`);


  console.log("2. import → add to timeline → play...");
  await stub(app, "showOpenDialog", [{ canceled: false, filePaths: [clip] }]);
  await win.getByRole("button", { name: "Import", exact: true }).click();
  check(await waitFor("asset row", async () => (await win.getByRole("button", { name: "Add to timeline" }).count()) > 0), "clip.mp4 is in the library");
  const [mopts] = await calls(app, "showOpenDialog");
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

  console.log("2c. drag a track volume slider: one edit on release...");
  await win.evaluate(`(() => {
    window.__trackEdits = 0;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      window.__ws = this; // the app's socket: 2c's own RPCs go through it
      if (typeof d === "string" && d.includes('"set_track_properties"')) window.__trackEdits++;
      return send.call(this, d);
    };
  })()`);
  const trackEdits = () => win.evaluate(() => (window as unknown as { __trackEdits: number }).__trackEdits);
  await win.getByRole("button", { name: "Add audio track" }).click();
  const vol = win.getByRole("slider", { name: "Track volume" }).first();
  check(await waitFor("volume slider", async () => (await vol.count()) > 0, 10000), "an added audio track shows its volume slider");
  const vb = await vol.boundingBox();
  if (vb) {
    const y = vb.y + vb.height / 2;
    await win.mouse.move(vb.x + vb.width / 2, y);
    await win.mouse.down();
    for (let i = 1; i <= 12; i++) await win.mouse.move(vb.x + vb.width / 2 + (vb.width * 0.4 * i) / 12, y);
    check((await trackEdits()) === 0, "no edit while the slider is dragged");
    await win.mouse.up();
  }
  check(await waitFor("volume committed", async () => Number(await vol.inputValue().catch(() => "1")) > 1.3, 5000), `released: the track volume is ${await vol.inputValue().catch(() => "?")}`);
  await sleep(500);
  check((await trackEdits()) === 1, `one drag → one set_track_properties edit (${await trackEdits()})`);
  const before = Number(await vol.inputValue());
  await vol.focus();
  await win.keyboard.press("ArrowLeft");
  check(await waitFor("arrow committed", async () => Math.abs(Number(await vol.inputValue().catch(() => "0")) - (before - 0.05)) < 1e-6, 5000), `ArrowLeft → ${await vol.inputValue().catch(() => "?")}`);
  await sleep(500);
  check((await trackEdits()) === 2, `one key press → one more edit (${await trackEdits()})`);
  // The key goes down on the slider and comes up after the focus moved away: no keyup reaches the slider.
  const before2 = Number(await vol.inputValue());
  await vol.focus();
  await win.keyboard.down("ArrowLeft");
  await vol.evaluate((el) => (el as HTMLElement).blur());
  await win.keyboard.up("ArrowLeft");
  check(await waitFor("blur committed", async () => (await trackEdits()) === 3, 5000), `focus lost before the keyup → committed on blur (${await trackEdits()} edits)`);
  check(await waitFor("blur value", async () => Math.abs(Number(await vol.inputValue().catch(() => "0")) - (before2 - 0.05)) < 1e-6, 5000), `…the track volume is ${await vol.inputValue().catch(() => "?")}`);
  await vol.focus();
  await vol.evaluate((el) => (el as HTMLElement).blur());
  await sleep(500);
  check((await trackEdits()) === 3, `focus and blur with nothing changed → no edit (${await trackEdits()})`);

  console.log("2c'. the preview's gain follows the slider live, the edit still waits for release...");
  // Each routed decoder's gain: the source → GainNode connect names the element, setTargetAtTime its value
  // (audiograph.ts). A gain above 1 routes the clip (el.volume stops at 1). An RPC of our own: string ids,
  // which the app's pending map ignores.
  await win.evaluate(`(() => {
    const params = new WeakMap(), targets = new WeakMap();
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (to, ...rest) {
      if (this instanceof MediaElementAudioSourceNode && to instanceof GainNode && !params.has(this.mediaElement)) params.set(this.mediaElement, to.gain);
      return connect.call(this, to, ...rest);
    };
    const target = AudioParam.prototype.setTargetAtTime;
    AudioParam.prototype.setTargetAtTime = function (v, ...rest) {
      targets.set(this, v);
      return target.call(this, v, ...rest);
    };
    window.__gainOf = (clipId) => {
      const el = [...document.querySelectorAll(".pv-pool video")].find((v) => v.dataset.clipId === clipId);
      const p = el && params.get(el);
      return p && targets.has(p) ? targets.get(p) : null;
    };
    let n = 0;
    window.__rpc = (method, params) => new Promise((resolve, reject) => {
      const ws = window.__ws, id = "smoke-" + ++n;
      const on = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type !== "rpc_result" || m.id !== id) return;
        ws.removeEventListener("message", on);
        if (m.ok) resolve(m.result); else reject(new Error(m.error));
      };
      ws.addEventListener("message", on);
      ws.send(JSON.stringify({ type: "rpc", id, method, params }));
    });
  })()`);
  type W = { __rpc: (m: string, p?: object) => Promise<any>; __gainOf: (id: string) => number | null };
  const rpc = (method: string, params: object = {}) => win.evaluate(([m, p]) => (window as unknown as W).__rpc(m, p), [method, params] as const);
  const gainOf = (id: string) => win.evaluate((id) => (window as unknown as W).__gainOf(id), id);
  const state = await rpc("get_state");
  const aTrack = state.tracks.find((t: { kind: string }) => t.kind === "audio");
  const clipAsset = state.assets.find((a: { path: string }) => a.path === clip);
  const { clip: aClip } = await rpc("add_clip", { assetId: clipAsset.id, trackIndex: aTrack.index, startFrame: 0 });
  let edits0 = await trackEdits();
  const committed = Number(await vol.inputValue());
  const gainNear = async (want: number, what: string) => {
    const ok = await waitFor(what, async () => Math.abs(((await gainOf(aClip.id)) ?? -1) - want) < 1e-6, 5000);
    return { ok, got: await gainOf(aClip.id) };
  };
  let g = await gainNear(committed, "committed gain");
  check(committed > 1 && g.ok, `the committed track volume ${committed} drives the clip's routed preview gain (${g.got})`);
  const vb2 = await vol.boundingBox();
  if (vb2) {
    const y = vb2.y + vb2.height / 2;
    const at = (f: number) => vb2.x + vb2.width * f;
    await win.mouse.move(at(0.3), y);
    await win.mouse.down();
    const seen: string[] = [];
    let follows = true;
    for (const f of [0.3, 0.85, 0.65]) { // above 1 (routed), then ends away from the committed value
      await win.mouse.move(at(f), y, { steps: 3 });
      const v = Number(await vol.inputValue());
      g = await gainNear(v, `gain ${v}`);
      seen.push(`${v}→${g.got}`);
      follows &&= g.ok;
    }
    check(follows && new Set(seen).size === 3, `while dragged, the preview gain follows the slider (${seen.join(", ")})`);
    check((await trackEdits()) === edits0, "…with no edit sent");
    await win.mouse.up();
    const released = Number(await vol.inputValue());
    check(Math.abs(released - committed) > 0.1 && await waitFor("one edit", async () => (await trackEdits()) === edits0 + 1, 5000),
      `released at ${released} → one set_track_properties edit (${(await trackEdits()) - edits0})`);
    const s2 = await rpc("get_state");
    const stored = s2.tracks.find((t: { index: number }) => t.index === aTrack.index)?.volume;
    g = await gainNear(released, "released gain");
    check(Math.abs(stored - released) < 1e-9 && g.ok, `the committed value (${stored}) then drives the gain (${g.got})`);
    // No live value is left behind: a later edit from elsewhere (an agent) is heard.
    await rpc("set_track_properties", { trackIndex: aTrack.index, volume: 1.6 });
    g = await gainNear(1.6, "agent gain");
    check(g.ok, `then an agent's set_track_properties 1.6 drives the gain (${g.got})`);
    const agentSet = await waitFor("slider 1.6", async () => Number(await vol.inputValue()) === 1.6, 5000);
    check(agentSet, `…and the slider shows it (${await vol.inputValue()})`);
    const committed2 = 1.6;
    edits0 = await trackEdits();

    // Escape mid-drag: back to the committed value; the rest of the drag and the release change nothing.
    await win.mouse.move(at(0.2), y);
    await win.mouse.down();
    await win.mouse.move(at(0.5), y, { steps: 3 });
    const mid = Number(await vol.inputValue());
    g = await gainNear(mid, "drag gain");
    check(Math.abs(mid - committed2) > 0.2 && g.ok, `dragging again: gain ${g.got} (slider ${mid})`);
    await win.keyboard.press("Escape");
    g = await gainNear(committed2, "escape gain");
    check(g.ok && Number(await vol.inputValue()) === committed2, `Escape → the gain is the committed ${committed2} again (${g.got}), so is the slider (${await vol.inputValue()})`);
    await win.mouse.move(at(0.9), y, { steps: 3 });
    await sleep(300);
    check((await gainOf(aClip.id)) === committed2 && Number(await vol.inputValue()) === committed2, `…moving on after Escape changes nothing (gain ${await gainOf(aClip.id)})`);
    await win.mouse.up();
    await sleep(500);
    check((await trackEdits()) === edits0, `…and the release sends no edit (${(await trackEdits()) - edits0})`);

    // A pointercancel (the OS took the pointer) restores too.
    await win.mouse.move(at(0.2), y);
    await win.mouse.down();
    await win.mouse.move(at(0.4), y, { steps: 3 });
    const mid2 = Number(await vol.inputValue());
    g = await gainNear(mid2, "drag gain 2");
    await vol.dispatchEvent("pointercancel", { bubbles: true, pointerId: 1, pointerType: "mouse" });
    const g2 = await gainNear(committed2, "pointercancel gain");
    check(g.ok && g2.ok && Math.abs(mid2 - committed2) > 0.2 && Number(await vol.inputValue()) === committed2,
      `pointercancel: ${mid2} (gain ${g.got}) → back to ${committed2} (gain ${g2.got}, slider ${await vol.inputValue()})`);
    await win.mouse.up();
    await sleep(500);
    check((await trackEdits()) === edits0, `…no edit (${(await trackEdits()) - edits0})`);
  } else check(false, "volume slider has a box");
  await rpc("remove_clip", { clipId: aClip.id });

  console.log("2d. an audio clip's waveform comes from /peaks...");
  await stub(app, "showOpenDialog", [{ canceled: false, filePaths: [tone] }]);
  await win.getByRole("button", { name: "Import", exact: true }).click();
  const toneCard = win.locator(".asset-card", { hasText: "tone" });
  check(await waitFor("tone asset", async () => (await toneCard.count()) > 0), "tone.wav is in the library");
  const clipsBefore = await win.locator(".tl-clip").count();
  await toneCard.getByRole("button", { name: "Add to timeline" }).click();
  check(await waitFor("peaks", () => peaksStatus.length > 0, 15000), `the timeline asked /peaks for tone.wav (${peaksStatus.join(", ") || "no request"})`);
  check(peaksStatus.length > 0 && peaksStatus.every((s) => s === 200), `/peaks answered 200 (${peaksStatus.join(", ")})`);
  await sleep(1500);
  check(toneFetches.length === 0, `no fetch of the whole file for a WebAudio decode (${toneFetches.length})`);
  const toneClip = win.locator(".tl-clip", { hasText: "tone" });
  check(await waitFor("tone clip", async () => (await toneClip.count()) === 1, 5000), "tone.wav is on the timeline");
  await toneClip.click();
  await toneClip.getByRole("button", { name: "Remove clip" }).click();
  check(await waitFor("tone removed", async () => (await win.locator(".tl-clip").count()) === clipsBefore, 10000), `tone clip removed again (${await win.locator(".tl-clip").count()} clips)`);

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
  check(popts?.filters?.[0]?.name === "ZabsReel Project", `project save filter is named "${popts?.filters?.[0]?.name}"`);
  await stub(app, "showOpenDialog", [{ canceled: true, filePaths: [] }]);
  await win.evaluate(() => window.aive!.openProject());
  const [oopts] = await calls(app, "showOpenDialog");
  check(oopts?.filters?.[0]?.name === "ZabsReel Project", `project open filter is named "${oopts?.filters?.[0]?.name}"`);
  // A picked file is not added to the OS's recent files (all four dialogs).
  const noRecent = [mopts, opts, popts, oopts].map((o) => !!o?.properties?.includes("dontAddToRecent"));
  check(noRecent.every(Boolean), `import, export, save-as and open dialogs pass dontAddToRecent (${noRecent.join(", ")})`);

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

  console.log("7b. the window's network limits: the sign-in switch, the request guard, navigation, the CSP...");
  const before7b = r2.errors.length;
  const authSwitch = await r2.app.evaluate(({ app }) => app.commandLine.getSwitchValue("auth-server-whitelist"));
  check(authSwitch === "zr-no-ambient-auth.invalid", `main sets auth-server-whitelist to the sentinel (${JSON.stringify(authSwitch)})`);
  // Requests the page's CSP does not limit (scripts), so they reach the request guard; how each
  // one ended is recorded in main. A cancel there is ERR_BLOCKED_BY_CLIENT, before any DNS.
  // MUTATION: remove the onBeforeRequest guard from main.cjs → these end with
  // ERR_NAME_NOT_RESOLVED and a file error instead.
  await r2.app.evaluate(({ session }) => {
    const g = globalThis as unknown as { __netErrors: { url: string; error: string }[] };
    g.__netErrors = [];
    session.defaultSession.webRequest.onErrorOccurred((d) => void g.__netErrors.push({ url: d.url, error: d.error }));
  });
  const guarded = ["http://zr-evil.invalid/x.js", "file://zr-evil.invalid/s/x.js"];
  await r2.win.evaluate((urls) => {
    for (const src of urls) {
      const el = document.createElement("script");
      el.src = src;
      document.head.append(el);
    }
  }, guarded);
  const netErrors = () => r2.app.evaluate(() => (globalThis as unknown as { __netErrors: { url: string; error: string }[] }).__netErrors);
  await waitFor("both requests end", async () => (await netErrors()).length >= guarded.length, 10000);
  const ended = await netErrors();
  for (const u of guarded) {
    const e = ended.find((x) => x.url.replace(/\/$/, "") === u.replace(/\/$/, ""));
    check(e?.error === "net::ERR_BLOCKED_BY_CLIENT", `${u} is cancelled by the guard (${e?.error ?? "no error recorded"})`);
  }
  check(/\[aive\] blocked a renderer request to http:\/\/zr-evil\.invalid\n/.test(r2.mainLog()) && !/zr-evil\.invalid\/x\.js/.test(r2.mainLog()),
    "main logs the blocked origin, not the path");
  // A navigation away from the app's own page (here to the core, which the guard would allow) does nothing.
  // MUTATION: drop the will-navigate handler → the page leaves the app.
  const pageUrl = r2.win.url();
  await r2.win.evaluate((u) => void (location.href = u), `http://127.0.0.1:${info2.port}/methods`);
  await sleep(1500);
  check(r2.win.url() === pageUrl && (await r2.win.locator(".statuspill.ok").count()) > 0, `a navigation to another page is cancelled (${r2.win.url().split("?")[0]})`);
  // The CSP meta tag; a media element pointed at a non-core origin is refused under media-src.
  // MUTATION: remove the meta tag from index.html → no violation, the request goes out (and the guard cancels it).
  const meta = await r2.win.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? null);
  const netGuard = require("../electron/net-guard.cjs") as { rendererCsp: (port?: number) => string };
  check(meta === netGuard.rendererCsp(), `the page has the CSP meta tag (${meta})`);
  const violation = await r2.win.evaluate(() => new Promise<{ directive: string; uri: string } | null>((res) => {
    document.addEventListener("securitypolicyviolation", (e) => res({ directive: e.effectiveDirective, uri: e.blockedURI }), { once: true });
    const a = document.createElement("audio");
    a.src = "http://zr-evil.invalid/a.mp4";
    setTimeout(() => res(null), 5000);
  }));
  check(violation?.directive === "media-src" && violation.uri.startsWith("http://zr-evil.invalid"), `a media element pointed at http://zr-evil.invalid raises a media-src violation (${JSON.stringify(violation)})`);
  // The console errors these refusals cause, and only those, are taken out of run 7's "no errors" check.
  await waitFor("7b console errors", () => r2.errors.length - before7b >= 3, 5000);
  const from7b = r2.errors.splice(before7b);
  const blockedLines = from7b.filter((e) => e === "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT").length;
  const cspLines = from7b.filter((e) => /^Loading media from +'http:\/\/zr-evil\.invalid\/a\.mp4' violates the following Content Security Policy directive: "media-src /.test(e)).length;
  check(from7b.length === 3 && blockedLines === 2 && cspLines === 1, `7b's console errors are the two cancelled scripts and the media refusal (${JSON.stringify(from7b)})`);
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

  // ---------------------------------------------------------------- run 4
  await networkComputers(pw, work, cwd2, clip);

  await noLeftoverCores();
  rmSync(work, { recursive: true, force: true });
  if (failures) {
    console.log(`\nELECTRON SMOKE TEST FAILED (${failures} check(s))`);
    process.exit(1);
  }
  console.log("\nELECTRON SMOKE TEST PASSED");
  process.exit(0);
}

/** Run 4 (step 9 above): network computers. `work` holds run 1's manual.aive, whose clip.mp4 asset is moved onto test servers. */
async function networkComputers(pw: PW, work: string, cwd: string, clip: string) {
  console.log("9. network computers...");
  const { readTrustedHosts } = await import("@aive/core/trusthosts");
  const dataDir = join(work, "data-unc");
  const hostsFile = join(dataDir, "trust", "hosts.json");
  type Entry = { host: string };
  /** Write an entry ZabsReel did not stamp ("added outside ZabsReel"), as a hand edit would. */
  const addOutside = (host: string) => {
    const cur = existsSync(hostsFile) ? JSON.parse(readFileSync(hostsFile, "utf8")) : { version: 2, servers: [] };
    cur.servers = [...cur.servers.filter((e: Entry) => e.host !== host), { host }];
    writeFileSync(hostsFile, JSON.stringify(cur, null, 2));
  };
  mkdirSync(join(dataDir, "trust"), { recursive: true, mode: 0o700 });
  addOutside("zr-evil-3.invalid");
  const viaOf = (host: string) => readTrustedHosts(dataDir).approved.find((a) => a.host === host)?.via;
  const listed = (host: string) => {
    const t = readTrustedHosts(dataDir);
    return [...t.approved, ...t.outside].some((e) => e.host === host);
  };

  // Projects made from run 1's manual.aive: its clip.mp4 asset on a test server (.invalid never resolves).
  const base = JSON.parse(readFileSync(join(work, "manual.aive"), "utf8"));
  const clipAsset = base.assets.find((a: { path: string }) => a.path === clip);
  check(!!clipAsset, "manual.aive has the clip.mp4 asset");
  const craft = (file: string, edit: (p: typeof base) => void) => {
    const p = structuredClone(base);
    edit(p);
    writeFileSync(join(work, file), JSON.stringify(p));
    return join(work, file);
  };
  const onServer = (host: string) => (p: typeof base) => {
    for (const a of p.assets) {
      if (a.path !== clip) continue;
      a.path = `//${host}/s/a.mp4`;
      delete a.proxyPath;
      delete a.previewPath;
    }
  };
  const crafted1 = craft("crafted1.aive", onServer("zr-evil-1.invalid"));
  const crafted3 = craft("crafted3.aive", onServer("zr-evil-3.invalid"));
  const craftedName = craft("crafted-name.aive", (p) => { p.name = "\\\\zr-evil.invalid\\s\\x"; });
  // The local clip, graded with a LUT on a server not allowed: the live preview leaves the LUT out.
  const craftedLut = craft("crafted-lut.aive", (p) => {
    for (const t of p.tracks) for (const c of t.clips) c.effects = { ...c.effects, lut: "//zr-evil-5.invalid/l/a.cube" };
  });

  const r = await launch(pw, cwd, dataDir);
  const { app, win } = r;
  check(await waitFor("Core pill", async () => (await win.locator(".statuspill.ok").count()) > 0), "window connected");
  const info = JSON.parse(readFileSync(join(dataDir, "server.json"), "utf8"));
  /** An rpc call as the agent makes it: HTTP with the session token from server.json. */
  const agentRpc = async (method: string, params: object = {}) => {
    const res = await fetch(`http://127.0.0.1:${info.port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-aive-token": info.token },
      body: JSON.stringify({ method, params }),
    });
    return { status: res.status, body: await res.json() };
  };
  const servers = async () => (await agentRpc("list_media_servers")).body.result;
  check((await servers()).gate === "enforce", `the core's gate is "${(await servers()).gate}" (it ships enforced)`);

  // Every page request that names a test server, and every thumbnail the page asks the core for.
  const evil: string[] = [];
  let clipServed = 0;
  win.on("request", (q) => {
    const u = decodeURIComponent(q.url());
    if (u.includes("zr-evil")) evil.push(u);
    if ([clip, clipAsset?.proxyPath].some((p) => p && u.includes(`/file?path=${p}&`))) clipServed++;
  });
  const notFound: string[] = [];
  win.on("response", (q) => {
    if (q.status() === 404) notFound.push(decodeURIComponent(q.url()));
  });
  const watchThumbs = () => win.evaluate(`(() => {
    window.__thumbs = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      if (typeof d === "string" && d.includes('"generate_thumbnail"')) window.__thumbs.push(JSON.parse(d).params.assetId);
      return send.call(this, d);
    };
  })()`);
  await watchThumbs();
  const thumbsAsked = () => win.evaluate(() => (window as unknown as { __thumbs: string[] }).__thumbs);
  const clearThumbs = () => win.evaluate(() => { (window as unknown as { __thumbs: string[] }).__thumbs = []; });
  const evilFor = (host: string) => evil.filter((u) => u.includes(host));

  const bannerText = () => win.locator(".ms-banner").innerText().catch(() => "");
  const badge = win.locator(".asset-card.offline .offline-badge");
  const badgeLabel = () => badge.first().getAttribute("aria-label").catch(() => null);
  const openViaMenu = async (file: string) => {
    await stub(app, "showOpenDialog", [{ canceled: false, filePaths: [file] }]);
    await win.getByRole("button", { name: /Project/ }).click();
    await win.getByRole("menuitem", { name: /^Open/ }).click();
  };
  /** Click the banner's Review… with the native dialog stubbed to `response`; the dialog's options. */
  const review = async (host: string, response: number) => {
    await stub(app, "showMessageBox", [{ response }]);
    await win.getByRole("button", { name: `Review \\\\${host}…`, exact: true }).click();
    await waitFor("approval dialog", async () => (await calls(app, "showMessageBox")).length > 0, 10000);
    return (await calls(app, "showMessageBox"))[0] ?? {};
  };
  const buttonsOf = (o: { buttons?: string[] }) => JSON.stringify(o.buttons ?? []);

  // 9a. Added outside ZabsReel: offline at load, the Keep dialog decides.
  await openViaMenu(crafted3);
  check(await waitFor("outside banner", async () => /It is in your list of allowed network computers, but ZabsReel didn't put it there/.test(await bannerText()), 15000),
    `outside entry: banner "${(await bannerText()).replace(/\s+/g, " ")}"`);
  check(await waitFor("badge", async () => (await badgeLabel()) === "Offline: waiting for you to allow \\\\zr-evil-3.invalid", 5000), `…the asset is offline (${await badgeLabel()})`);
  await sleep(1500);
  check(evilFor("zr-evil-3").length === 0, `…the page asked for none of its files (${evilFor("zr-evil-3").join(", ") || "no request"})`);
  check(!(await thumbsAsked()).includes(clipAsset.id), "…and no thumbnail");
  let box = await review("zr-evil-3.invalid", 0);
  check(box.title === "Keep \\\\zr-evil-3.invalid?" && buttonsOf(box) === '["Remove","Keep"]' && box.defaultId === 0 && box.cancelId === 0,
    `Review… → the Keep dialog (${box.title}, ${buttonsOf(box)}, default ${box.defaultId}, cancel ${box.cancelId})`);
  check(await waitFor("removed", () => !listed("zr-evil-3.invalid"), 10000), "Remove (default, Esc) → the server is out of the store");
  check(await waitFor("allow banner", async () => /This project uses 1 file on the network computer \\\\zr-evil-3\.invalid\. They stay offline until you allow it/.test(await bannerText()), 10000),
    `…and the project now gets the normal banner ("${(await bannerText()).replace(/\s+/g, " ")}")`);
  addOutside("zr-evil-3.invalid");
  await openViaMenu(crafted3);
  check(await waitFor("outside again", async () => /didn't put it there/.test(await bannerText()), 15000), "written again by hand and reopened: outside again");
  box = await review("zr-evil-3.invalid", 1);
  check(box.title === "Keep \\\\zr-evil-3.invalid?", `Review… → Keep dialog again (${box.title})`);
  check(await waitFor("kept", () => viaOf("zr-evil-3.invalid") === "prompt", 10000), "Keep → the store has it with a valid stamp (via prompt)");
  check(await waitFor("online", async () => (await badge.count()) === 0, 10000), "…and the asset comes online without a reload");

  // 9b. A project on a server not allowed: banner, badge, nothing asked for; Keep offline, then Allow.
  await clearThumbs(); // the same asset was online on zr-evil-3 just now
  await openViaMenu(crafted1);
  check(await waitFor("project banner", async () => /This project uses 1 file on the network computer \\\\zr-evil-1\.invalid\. They stay offline until you allow it/.test(await bannerText()), 15000),
    `banner: "${(await bannerText()).replace(/\s+/g, " ")}"`);
  check(await waitFor("badge", async () => (await badgeLabel()) === "Offline: waiting for you to allow \\\\zr-evil-1.invalid", 5000), `media pool badge (${await badgeLabel()}, "${await badge.first().innerText().catch(() => "")}")`);
  check(await win.locator(".tl-clip.offline").count() > 0, `timeline clips are hatched (${await win.locator(".tl-clip.offline").count()})`);
  check((await win.locator('.ms-banner[role="status"]').count()) === 1, "the banner is a polite status (role=status)");
  await sleep(1500);
  check(evilFor("zr-evil-1").length === 0, `no /file, /peaks or /frames request names the server (${evilFor("zr-evil-1").join(", ") || "none"})`);
  check(!(await thumbsAsked()).includes(clipAsset.id), "no thumbnail asked for the offline asset");
  box = await review("zr-evil-1.invalid", 0);
  check(box.title === "Allow media from \\\\zr-evil-1.invalid?" && buttonsOf(box) === '["Keep offline","Allow"]' && box.defaultId === 0 && box.cancelId === 0,
    `Review… → the Allow dialog (${box.title}, ${buttonsOf(box)}, default ${box.defaultId}, cancel ${box.cancelId})`);
  check((box.detail ?? "").startsWith("This project uses 1 file stored there, for example //zr-evil-1.invalid/s/a.mp4."), `…its detail: "${(box.detail ?? "").split("\n")[0]}"`);
  await sleep(1000);
  check(!listed("zr-evil-1.invalid") && (await badge.count()) > 0, "Keep offline → the store is unchanged and the asset is still offline");
  box = await review("zr-evil-1.invalid", 1);
  check(await waitFor("allowed", () => viaOf("zr-evil-1.invalid") === "prompt", 10000), "Allow → the store has it (via prompt)");
  check(await waitFor("online", async () => (await badge.count()) === 0, 10000), "…and the asset comes online without a reload (badge gone)");

  // 9b'. A local clip whose LUT is on a server not allowed: the preview draws the clip, without the LUT.
  const served = clipServed;
  await openViaMenu(craftedLut);
  check(await waitFor("lut banner", async () => /\\\\zr-evil-5\.invalid/.test(await bannerText()), 15000), `a LUT on zr-evil-5.invalid: banner "${(await bannerText()).replace(/\s+/g, " ")}"`);
  check((await badge.count()) === 0, "…the clip itself is online");
  await win.getByRole("button", { name: "Play", exact: true }).click();
  await sleep(2500);
  await win.getByRole("button", { name: "Pause", exact: true }).click().catch(() => {});
  check(clipServed > served, `…the preview played the local clip (${clipServed - served} /file requests)`);
  check(evilFor("zr-evil-5").length === 0, `…and never asked for the LUT (${evilFor("zr-evil-5").join(", ") || "no request"})`);
  await openViaMenu(crafted1); // its server is allowed: nothing pending any more
  check(await waitFor("no banner", async () => (await win.locator(".ms-banner").count()) === 0, 15000), "back on crafted1: no banner");

  // 9c. A file picked on a server not allowed yet asks once (Round 5: a pick alone allows nothing, because a
  // Windows dialog follows a shortcut to another computer). Keep offline leaves the path out; nothing is
  // saved until Allow, which saves it with via "picker"; picked again, it asks nothing.
  await stub(app, "showOpenDialog", [{ canceled: false, filePaths: ["//zr-pick.invalid/s/a.mp4"] }]);
  check(!listed("zr-pick.invalid"), "zr-pick.invalid is not in the store yet");
  await stub(app, "showMessageBox", [{ response: 0 }]);
  const keptOff = await win.evaluate(() => window.aive!.pickFiles());
  const [pickBox] = await calls(app, "showMessageBox");
  check(pickBox?.title === "Allow media from \\\\zr-pick.invalid?" && buttonsOf(pickBox) === '["Keep offline","Allow"]' && pickBox.cancelId === 0
    && (pickBox.detail ?? "").startsWith("You picked //zr-pick.invalid/s/a.mp4."), `picked → the Allow dialog (${pickBox?.title}, "${(pickBox?.detail ?? "").split("\n")[0]}")`);
  check(keptOff.length === 0 && !listed("zr-pick.invalid"), `Keep offline → the store is unchanged and no path comes back (${JSON.stringify(keptOff)})`);
  await stubWaiting(app);
  const picking = win.evaluate(() => window.aive!.pickFiles());
  await waitFor("picker dialog", async () => (await calls(app, "showMessageBox")).length > 0, 10000);
  await sleep(500);
  check((await calls(app, "showMessageBox")).length === 1 && !listed("zr-pick.invalid"), "picked again: asked, and the store is unchanged while the dialog is open");
  await answer(app, 1);
  const picked = await picking;
  check(picked[0] === "//zr-pick.invalid/s/a.mp4" && viaOf("zr-pick.invalid") === "picker", `Allow → the store has it (via ${viaOf("zr-pick.invalid")}) when the path comes back`);
  await stub(app, "showMessageBox", [{ response: 0 }]);
  await win.getByRole("button", { name: "Import", exact: true }).click();
  check(await waitFor("import refused", async () => (await win.locator(".error-bar").count()) > 0, 15000), `the import itself then fails as the file isn't there (${(await win.locator(".error-bar").innerText().catch(() => "")).split("\n")[0]})`);
  check((await calls(app, "showMessageBox")).length === 0, "…picked once it is allowed: no dialog");
  await win.locator(".error-bar").click();

  // 9c'. The export, open-project and save-as pickers ask the same question (askAboutPicked in each
  // handler): Keep offline gives no path and leaves the store as it was. The save pickers ask before
  // their overwrite check, so main stats nothing on a server the user has not answered for.
  // MUTATION: drop askAboutPicked from dialog:openProject → its row gets a path and no dialog.
  // MUTATION: run finalSavePath before askAboutPicked in dialog:saveFile → the export row's spy sees out.mp4 stat'd.
  await app.evaluate(() => {
    const g = globalThis as unknown as { __exists: string[]; __realExists?: (p: unknown) => boolean };
    const nodeFs = (process as unknown as { getBuiltinModule: (m: string) => { existsSync: (p: unknown) => boolean } }).getBuiltinModule("node:fs");
    g.__exists = [];
    g.__realExists ??= nodeFs.existsSync;
    const real = g.__realExists;
    nodeFs.existsSync = (p: unknown) => {
      g.__exists.push(String(p));
      return real(p);
    };
  });
  const existsCalls = () => app.evaluate(() => (globalThis as unknown as { __exists: string[] }).__exists.splice(0));
  await stub(app, "showSaveDialog", [saveResult(join(work, "spied"))]);
  const spiedPath = await win.evaluate(() => window.aive!.pickSavePath("mp4"));
  const spiedCalls = await existsCalls();
  check(spiedPath === join(work, "spied.mp4") && spiedCalls.includes(join(work, "spied.mp4")), `the existsSync spy in main sees the overwrite check of a local save (${spiedPath}; ${JSON.stringify(spiedCalls)})`);
  const storeBeforePickers = readFileSync(hostsFile, "utf8");
  const pickers = [
    ["export", "zr-pick2.invalid", "//zr-pick2.invalid/s/out", () => stub(app, "showSaveDialog", [saveResult("//zr-pick2.invalid/s/out")]), () => win.evaluate(() => window.aive!.pickSavePath("mp4"))],
    ["open project", "zr-pick3.invalid", "//zr-pick3.invalid/p/a.aive", () => stub(app, "showOpenDialog", [{ canceled: false, filePaths: ["//zr-pick3.invalid/p/a.aive"] }]), () => win.evaluate(() => window.aive!.openProject())],
    ["save project as", "zr-pick3.invalid", "//zr-pick3.invalid/p/x", () => stub(app, "showSaveDialog", [saveResult("//zr-pick3.invalid/p/x")]), () => win.evaluate(() => window.aive!.saveProjectAs("x"))],
  ] as const;
  for (const [what, host, picked, setUp, run] of pickers) {
    await setUp();
    await stub(app, "showMessageBox", [{ response: 0 }]);
    const got = await run();
    const [box] = await calls(app, "showMessageBox");
    const statted = (await existsCalls()).filter((p) => p.includes(host));
    check(box?.title === `Allow media from \\\\${host}?` && buttonsOf(box) === '["Keep offline","Allow"]' && (box.detail ?? "").startsWith(`You picked ${picked}.`),
      `${what}: a pick on ${host} → the Allow dialog (${box?.title}, "${(box?.detail ?? "").split("\n")[0]}")`);
    check(got === null && readFileSync(hostsFile, "utf8") === storeBeforePickers && !listed(host) && statted.length === 0,
      `${what}: Keep offline → no path, the store is unchanged, and main stat'd nothing there (${JSON.stringify(got)}; ${JSON.stringify(statted)})`);
  }
  // Save As kept offline during "Save before closing?" counts as a cancelled Save As: the window
  // stays open, and a later clean report does not close it.
  // MUTATION: send save-as-cancelled only when the save dialog itself is cancelled → the clean report closes the window.
  await win.evaluate(() => window.aive!.reportProjectState({ dirty: true, hasPath: false }));
  await stub(app, "showMessageBoxSync", [0]); // "Save"
  await stub(app, "showSaveDialog", [saveResult("//zr-pick3.invalid/p/guarded")]);
  await stub(app, "showMessageBox", [{ response: 0 }]); // Keep offline
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await waitFor("allow dialog on close", async () => (await calls(app, "showMessageBox")).length > 0, 10000);
  await sleep(1000);
  check(!win.isClosed() && (await calls(app, "showSaveDialog")).length === 1 && (await calls(app, "showMessageBox"))[0]?.title === "Allow media from \\\\zr-pick3.invalid?",
    "close → Save → Save As on zr-pick3.invalid → Keep offline: the window stays open");
  await win.evaluate(() => window.aive!.reportProjectState({ dirty: false, hasPath: false }));
  await sleep(1500);
  check(!win.isClosed(), "…and a later clean report does not close it (the Save request was dropped)");
  check(readFileSync(hostsFile, "utf8") === storeBeforePickers, "…and the store is unchanged");
  await existsCalls();
  await app.evaluate(() => {
    const g = globalThis as unknown as { __realExists: (p: unknown) => boolean };
    (process as unknown as { getBuiltinModule: (m: string) => { existsSync: (p: unknown) => boolean } }).getBuiltinModule("node:fs").existsSync = g.__realExists;
  });

  // 9d. Origin wording: a recent project (the page's own request) vs an agent's import.
  await win.evaluate((p) => localStorage.setItem("aive.recent", JSON.stringify([p])), "//zr-evil-7.invalid/p/a.aive");
  await win.reload();
  check(await waitFor("Core pill", async () => (await win.locator(".statuspill.ok").count()) > 0), "page reloaded with a recent project on zr-evil-7.invalid");
  await watchThumbs();
  await stub(app, "showMessageBox", [{ response: 0 }]);
  await win.getByRole("button", { name: /Project/ }).click();
  await win.getByRole("menuitem", { name: "a.aive", exact: true }).click();
  await waitFor("approval dialog", async () => (await calls(app, "showMessageBox")).length > 0, 10000);
  const [mine] = await calls(app, "showMessageBox");
  check((mine?.detail ?? "").startsWith("You opened //zr-evil-7.invalid/p/a.aive."), `opening it asks at once: "${(mine?.detail ?? "").split("\n")[0]}"`);
  check(await waitFor("own banner", async () => /You tried to open a file on the network computer \\\\zr-evil-7\.invalid/.test(await bannerText()), 10000),
    `…the banner says "You tried" ("${(await bannerText()).replace(/\s+/g, " ")}")`);
  const refused = await agentRpc("import_video", { path: "//zr-evil-9.invalid/s/a.mp4" });
  check(refused.status === 403 && refused.body.code === "media_server_not_approved" && refused.body.host === "zr-evil-9.invalid", `an agent's import_video is refused (${refused.status} ${refused.body.code})`);
  check(await waitFor("agent banner", async () => /The AI assistant asked to open a file on the network computer \\\\zr-evil-9\.invalid/.test(await bannerText()), 10000),
    `…the banner says "The AI assistant asked" ("${(await bannerText()).replace(/\s+/g, " ")}")`);
  const agent = await review("zr-evil-9.invalid", 0);
  check((agent.detail ?? "").startsWith("The AI assistant asked to open //zr-evil-9.invalid/s/a.mp4."), `…and so does its dialog: "${(agent.detail ?? "").split("\n")[0]}"`);
  check(evilFor("zr-evil-7").length === 0 && evilFor("zr-evil-9").length === 0, "no page request names zr-evil-7 or zr-evil-9");

  // 9e. Project → Network computers…: allowed servers with Remove, outside ones with Keep… and Remove (no date).
  addOutside("zr-evil-4.invalid");
  await win.getByRole("button", { name: /Project/ }).click();
  await win.getByRole("menuitem", { name: /Network computers/ }).click();
  const dlg = win.getByRole("dialog", { name: /Network computers/ });
  check(await waitFor("outside row", async () => (await dlg.innerText().catch(() => "")).includes("\\\\zr-evil-4.invalid"), 10000), "the dialog opens and lists the entry written by hand");
  const outsideRow = dlg.locator("table", { has: win.locator("caption", { hasText: "Added outside ZabsReel" }) }).locator("tr", { hasText: "zr-evil-4.invalid" });
  const rowText = (await outsideRow.innerText().catch(() => "")).replace(/\s+/g, " ");
  const want = "ZabsReel didn't add this, so it doesn't use it.";
  check(rowText.includes(want) && !/\d{4}/.test(rowText), `…under "Added outside ZabsReel", no date: "${rowText}"`);
  check((await outsideRow.getByRole("button", { name: "Keep \\\\zr-evil-4.invalid…", exact: true }).count()) === 1 && (await outsideRow.getByRole("button", { name: "Remove \\\\zr-evil-4.invalid", exact: true }).count()) === 1,
    "…with Keep… and Remove");
  const allowedText = (await dlg.locator("table", { has: win.locator("caption", { hasText: "Allowed" }) }).innerText().catch(() => "")).replace(/\s+/g, " ");
  check(/\\\\zr-pick\.invalid Added by you on \d+ \w+ \d{4} · You picked a file there/.test(allowedText) && /\\\\zr-evil-3\.invalid Added by you on .* · You allowed it/.test(allowedText),
    `allowed: "${allowedText}"`);
  await outsideRow.getByRole("button", { name: "Remove \\\\zr-evil-4.invalid", exact: true }).click();
  check(await waitFor("zr-evil-4 removed", () => !listed("zr-evil-4.invalid"), 10000), "Remove → it is out of the store");
  await dlg.getByRole("button", { name: "Close" }).last().click();
  await openViaMenu(crafted1);
  check(await waitFor("online", async () => (await win.locator(".asset-card").count()) > 0 && (await badge.count()) === 0, 15000), "crafted1 opens with its server allowed: online");
  await win.getByRole("button", { name: /Project/ }).click();
  await win.getByRole("menuitem", { name: /Network computers/ }).click();
  await dlg.getByRole("button", { name: "Remove \\\\zr-evil-1.invalid", exact: true }).click();
  check(await waitFor("zr-evil-1 removed", () => !listed("zr-evil-1.invalid"), 10000), "Remove on an allowed server → out of the store");
  check(await waitFor("offline again", async () => (await badge.count()) > 0, 10000), "…and its asset goes offline");
  await dlg.getByRole("button", { name: "Close" }).last().click();
  check(await waitFor("dialog closed", async () => (await dlg.count()) === 0, 5000), "the dialog closes");

  // 9f. Save As never starts in a folder named by the project.
  await openViaMenu(craftedName);
  check(await waitFor("name", async () => (await win.locator(".proj-name").innerText().catch(() => "")).trim().startsWith("x"), 15000),
    `a project named \\\\zr-evil.invalid\\s\\x opens as "${(await win.locator(".proj-name").innerText().catch(() => "")).trim()}"`);
  const storeBefore = readFileSync(hostsFile, "utf8");
  await stub(app, "showSaveDialog", [saveResult(null)]);
  await win.getByRole("button", { name: /Project/ }).click();
  await win.getByRole("menuitem", { name: /Save As/ }).click();
  await waitFor("save dialog", async () => (await calls(app, "showSaveDialog")).length > 0, 10000);
  check((await calls(app, "showSaveDialog"))[0]?.defaultPath === "x.aive", `Project → Save As: default ${(await calls(app, "showSaveDialog"))[0]?.defaultPath}`);
  await stub(app, "showSaveDialog", [saveResult(null)]);
  await win.evaluate(() => window.aive!.saveProjectAs("\\\\zr-evil.invalid\\s\\x"));
  check((await calls(app, "showSaveDialog"))[0]?.defaultPath === "x.aive", `saveProjectAs("\\\\zr-evil.invalid\\s\\x") from the page: default ${(await calls(app, "showSaveDialog"))[0]?.defaultPath}`);
  check(readFileSync(hostsFile, "utf8") === storeBefore && !listed("zr-evil.invalid"), "…and the store is unchanged");

  await stub(app, "showMessageBoxSync", [1]); // "Don't Save" if anything is unsaved
  const closed = new Promise<void>((res) => app.once("close", () => res()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  check(await Promise.race([closed.then(() => true), sleep(30000).then(() => false)]), "closed");
  check(await waitFor("core exit", () => !pidAlive(info.pid), 10000), "its core exited");
  check(!/A JavaScript error occurred|ReferenceError|TypeError/.test(r.mainLog()), "no main-process errors");
  // Once a test server is allowed, the preview asks for the clip's file, which a .invalid
  // server never has: those 404s, and only those, are expected (each a /file request for the zr-evil-1 or -3 clip).
  const errors = r.errors.filter((e) => !/^Failed to load resource: the server responded with a status of 404/.test(e));
  const expected404 = notFound.every((u) => /\/file\?path=\/\/zr-evil-[13]\.invalid\/s\/a\.mp4&/.test(u)) && r.errors.length - errors.length === notFound.length;
  check(errors.length === 0 && expected404, `no renderer console errors${errors.length ? `:\n    ${errors.join("\n    ")}` : ""} (404s: ${notFound.length}, all for an allowed test server: ${expected404})`);
  await app.close().catch(() => {});
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
  // A killed app leaves its core running.
  await noLeftoverCores().catch((e) => console.error("could not stop a leftover core:", e));
  process.exit(1);
});
