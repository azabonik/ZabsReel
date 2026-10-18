/**
 * ZabsReel's own motion renderer: the renderer host (slice 1; MOTION-PLAN D2,
 * D8 "Launch", "Binary rule", "Renderer" and "Lifecycle"), with hand-written
 * pages in R2-R7, and the clean-room runtime wired into the page (slice 3b1;
 * D5, D8 "Code delivery") in R8-R9.
 *
 *  R1. binary rule  — rendererbinary.ts over fixture layouts for win32, darwin
 *                     and linux, packaged and source checkout (no macOS or
 *                     packaged Windows build runs here, so these rows cover
 *                     them): packaged = process.execPath with only the flag,
 *                     no Electron version = no-binary; source = execPath or
 *                     require("electron") with <repo>/apps/desktop first; no
 *                     main.cjs, or no Electron at all = no-binary.
 *  R2. frames       — the page's clock (Date.now, Date(), new Date(),
 *                     performance.now, the rAF timestamp,
 *                     document.timeline.currentTime) is frame / fps, and
 *                     a new DocumentTimeline's currentTime is that less its
 *                     originTime;
 *                     the frames on fd 3 are exactly the page's pattern for
 *                     each frame: width*4 rows, B,G,R,A, premultiplied; the
 *                     ProRes 4444 round trip gives straight alpha (50%-alpha
 *                     red, blue and green within 2 levels) and BT.601 colour,
 *                     untagged; a standalone card is opaque (alpha 255 on the
 *                     pipe) and its H.264 has today's BT.601 tags; the
 *                     overlay's .webm preview lands in baked/ with it.
 *  R3. network      — (in a private network namespace: loopback plus one
 *                     dummy interface 10.99.0.1, so even a broken build
 *                     reaches no real network) fetch, XHR, WebSocket,
 *                     EventSource, img, font, CSS @import and url(), SVG
 *                     image, preconnect/prefetch and sendBeacon to listeners
 *                     on 127.0.0.1 and on the private address 10.99.0.1, and
 *                     to a .invalid host, all fail and no listener sees a
 *                     connection; ICE/STUN to a loopback UDP listener sends
 *                     nothing with guard.js (constructor gone), without it
 *                     (layers 1 and 2 alone), and from an about:blank
 *                     iframe's fresh constructor; WebTransport sends nothing;
 *                     Worker/SharedWorker/serviceWorker on a table entry and
 *                     an iframe fail (names gone with guard.js, CSP without),
 *                     and so do Worker, SharedWorker and WebTransport from an
 *                     about:blank iframe (its own constructors: the inherited
 *                     CSP stops them); on CI a missing namespace is a FAIL;
 *                     file:// and zrmotion URLs not in the table fail, a
 *                     relative URL loads a table entry; window.open,
 *                     navigation and permissions are refused.
 *  R4. limits       — a frame that never finishes, a render past its total
 *                     time and a page past its heap each end with their named
 *                     error, no renderer process and nothing in baked/.
 *  R5. lifecycle    — success: the renderer exits on its own at stdin EOF;
 *                     a renderer that cannot start (not executable): the probe
 *                     says start-failed at once, a render rejects with
 *                     graphic_renderer_unavailable and leaves nothing; a
 *                     renderer that fails: the probe's detail leads with its
 *                     own error line;
 *                     abort mid-render kills it at once; an FFmpeg failure,
 *                     a failed later move into baked/ and, across disks
 *                     (injected EXDEV), a copy whose source can't be removed
 *                     leave baked/ as it was; the core killed mid-render leaves no renderer
 *                     process within 2 s, and the next core start (the built
 *                     core) removes its motion/<id>; without --zr-scratch the
 *                     renderer exits 2 and writes nothing, with it the profile
 *                     and temp files land under that folder.
 *  R6. launch       — the D7 probe through the core's own binary rule:
 *                     (a) source checkout, core under plain node; (b) dev
 *                     desktop, the core under the dev Electron binary in Node
 *                     mode (as core-launcher.cjs starts it); (c) the packed
 *                     `--dir` build (AIVE_APP, else
 *                     apps/desktop/build/dist/linux-unpacked; skipped with a
 *                     printed reason when there is none), whose
 *                     motion-renderer.cjs, guard.js and core
 *                     dist/motion/rendermotion.js must be byte-identical to
 *                     this tree's (a stale build fails). Each prints
 *                     {"probe":"ok"}, opens no visible window, loads none of
 *                     core-launcher, media-servers, graphics-addon, starts no
 *                     core (no server.json, no port 5030-5039, no child with
 *                     ELECTRON_RUN_AS_NODE or dist/cli.js), and its
 *                     environment is only D2's allowlist, written out here
 *                     (no AIVE_DATA_DIR, no ELECTRON_RUN_AS_NODE).
 *  R7. measure      — a 1920x1080 overlay, 60 frames: milliseconds per frame;
 *                     every render here runs with no DISPLAY (Chromium's
 *                     headless platform on Linux).
 *  R8. runtime parts — (no renderer) the clean-room files match
 *                     CLEANROOM.lock, and the gate fails on a changed byte, an
 *                     added file and a deleted file (its --self-test, on
 *                     copies); the vendored React 18.3.1 UMD builds and licence
 *                     have their pinned sha256; two runtime builds are
 *                     byte-identical and dist/ holds this tree's; the
 *                     graphic's imports: react, its JSX runtimes, remotion and
 *                     @aive/motion pass (type-only imports, and import words
 *                     in strings, comments, JSX text and regular expressions,
 *                     are not imports), anything else, import(), import.meta
 *                     and a name the runtime does not export are refused.
 *  R9. graphics     — through the real renderer: the page's React globals
 *                     (ReactDOM.createRoot, flushSync) and loader.js's require
 *                     table; the title template at 1920x1080 and 1080x1920
 *                     (frames with content that changes); frames rendered out
 *                     of order equal the same frames in order, also for a
 *                     CSS keyframe animation and element.animate() ones
 *                     (also on a new DocumentTimeline() and started in a
 *                     rAF callback), whose box is where frame / fps puts it
 *                     (slice 3b2: CSS and Web Animations on the virtual
 *                     clock), a 1 ms animation shows at frame 0 only, an
 *                     endless animation played backwards fails the frame, and a
 *                     scroll-driven CSS animation renders (left alone); delayRender
 *                     holds the capture until continueRender; props reach a
 *                     component with no React import; a failed frame fails
 *                     the render with its code (a component's own throw:
 *                     graphic_component_error) and leaves nothing; an unknown
 *                     import, a syntax error and props over 256 KB are refused
 *                     before any renderer starts.
 *  R10. packed render — (Linux and Windows) the packed `--dir` build (AIVE_APP,
 *                     else apps/desktop/build/dist/linux-unpacked or
 *                     win-unpacked; skipped with a printed reason when there
 *                     is none, a FAIL when AIVE_APP names one that is
 *                     missing): its @aive/motion holds this tree's renderer
 *                     files, dist/zr-runtime.js and vendor/react-18.3.1 (both
 *                     UMD builds and React's LICENSE), byte-identical, and no
 *                     parity/, scripts/ or cleanroom/test; its core's driver is
 *                     this tree's build and finds its sucrase inside the app.
 *                     Then the packed executable in Node mode runs the packed
 *                     core: its binary rule gives the app with only the flag,
 *                     its probe prints {"probe":"ok"} (no window, the dispatch
 *                     loads none of the desktop modules, the allowlisted
 *                     environment), and it renders a graphic with a library
 *                     video, an image and a font (loadFont): exactly the
 *                     frames' bytes on fd 3, the image's colour in its box,
 *                     the video moving in its box, the font's glyphs unlike the
 *                     fallback's, the media and font answers over fd 4 (one
 *                     decode per video frame and one for the image, one font),
 *                     the baked .mp4 with every frame; afterwards no process
 *                     of the run is alive, the data folder holds only the
 *                     output and HOME nothing (on Linux also: no core started,
 *                     no port 5030-5039).
 *
 * Every renderer runs with fresh HOME/USERPROFILE/XDG_CONFIG_HOME and data
 * folders, muted. Ports: 5030-5033 (listeners) and 5036 (the core in R5).
 * On CI (CI=true) R3 fails instead of skipping when there is no namespace.
 * Needs `npm run build` (R5's core start, R6b, R8's dist/zr-runtime.js) and
 * FFmpeg. Linux only beyond R1, R8 and R10 (CI's Windows job runs R1 and
 * R10 on the packed Windows build). On GitHub Actions a skipped part is
 * also written to the step summary.
 * Run: npx tsx packages/motion/scripts/smoke-renderer.ts [--only=R1,R3]
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createSocket } from "node:dgram";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isSourceCheckout } from "../../core/src/addon/resolve.js";
import { RENDERER_FLAG, rendererBinary, type RendererBinary } from "../../core/src/motion/rendererbinary.js";
import { graphicImportRefusal, unsupportedNameMessage } from "../../core/src/motion/graphicmodule.js";
import type { MediaStats } from "../../core/src/motion/motionmedia.js";
import { TITLE_CARD_TSX } from "../../core/src/motion/templates.js";
import {
  MotionRenderError,
  probeMotionRenderer,
  rendererArgs,
  rendererEnv,
  renderMotion,
  type RendererMessage,
  type RenderMotionOptions,
} from "../../core/src/motion/rendermotion.js";
import {
  check,
  descendants,
  environNames,
  failureCount,
  filesUnder,
  fresh,
  gone,
  LINUX,
  NETNS,
  reexecInNetns,
  sleep,
  watchTree,
  type Fresh,
} from "./smoke-lib.js";

/** Set once the run's summary is printed (or the R5 child's render is done). */
let summarized = false;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const DESKTOP = join(REPO, "apps", "desktop");
const CORE_DIST = join(REPO, "packages", "core", "dist");
const ELECTRON = createRequire(join(DESKTOP, "package.json"))("electron") as string;
/**
 * What the renderer's environment may hold: D2's allowlist, written out here
 * (not read from RENDERER_ENV, so a name added there fails the rows), with its
 * own temp and cache variables (in its folder) and GTK's in-memory settings.
 */
const ALLOWED_ENV = new Set<string>([
  "PATH", "SystemRoot", "windir", "LANG", "LC_ALL", "HOME", "USERPROFILE", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR",
  "TEMP", "TMP", "TMPDIR", "XDG_CACHE_HOME", "GSETTINGS_BACKEND",
]);
/** Variables Electron/Chromium set in their own process after start (not from the core). */
const CHROMIUM_ENV = new Set(["CHROME_DESKTOP", "DBUS_SESSION_BUS_ADDRESS", "FC_FONTATIONS"]);
const DESKTOP_MODULES = /[\\/](core-launcher|media-servers|graphics-addon)\.cjs$/;
/**
 * Windows: the names libuv's spawn adds to a child's environment whenever the
 * environment it is given lacks them (src/win/process.c, required_vars), so
 * the renderer has them whatever the core passes. Only R10 runs there.
 */
const WIN_SPAWN_ENV = new Set(["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "SYSTEMDRIVE", "USERDOMAIN", "USERNAME"]);

/** A fault to inject into the core's rename, copyFile and rm (gatedfs looks each fs/promises function up per call): the error to throw, or null. */
let fsFault: ((name: string, args: unknown[]) => NodeJS.ErrnoException | null) | null = null;
{
  const fsp = createRequire(import.meta.url)("node:fs/promises") as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const name of ["rename", "copyFile", "rm"]) {
    const real = fsp[name];
    fsp[name] = async (...args: unknown[]) => {
      const e = fsFault?.(name, args);
      if (e) throw e;
      return real(...args);
    };
  }
  syncBuiltinESMExports();
}
const errno = (code: string) => Object.assign(new Error(`${code}: injected`), { code }) as NodeJS.ErrnoException;

function skipped(name: string, why: string) {
  console.log(`  skip ${name}: ${why}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `- smoke-renderer: ${name} skipped (${why})\n`);
}

// ---- R1: the binary rule over fixture layouts ------------------------------------

const SHAPES = [
  { os: "win32", unpacked: "win-unpacked", app: ["resources", "app"], exe: ["ZabsReel.exe"] },
  { os: "darwin", unpacked: "mac", app: ["ZabsReel.app", "Contents", "Resources", "app"], exe: ["ZabsReel.app", "Contents", "MacOS", "ZabsReel"] },
  { os: "linux", unpacked: "linux-unpacked", app: ["resources", "app"], exe: ["zabsreel-desktop"] },
];

function touch(p: string, text = "") {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}

/** A fixture @aive/core package folder (package.json named @aive/core, a dist/ file, src/ when `src`); returns that dist file as `from`. */
function fixtureCore(dir: string, src: boolean): string {
  touch(join(dir, "package.json"), JSON.stringify({ name: "@aive/core", version: "0.0.0" }));
  if (src) mkdirSync(join(dir, "src"), { recursive: true });
  return touch(join(dir, "dist", "motion", "rendererbinary.js"));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// MUTATION: rendererbinary.ts decides "packaged" with a path-suffix test
// (`resources/app/node_modules/@aive/core` in the core's folder) instead of
// isSourceCheckout() → the darwin packaged rows fail. isSourceCheckout() forced
// true → the packaged rows fail; forced false → the source rows fail. The
// packaged command taken from require("electron") instead of execPath → the
// three packaged rows fail.
function r1(work: string) {
  console.log("R1. the binary rule over fixture layouts (win32, darwin, linux)...");
  const t = join(work, "binary");
  const version = "42.11.12";
  for (const s of SHAPES) {
    // Packaged: no src/ in @aive/core.
    const pk = join(t, `packaged-${s.os}`, s.unpacked);
    const from = fixtureCore(join(pk, ...s.app, "node_modules", "@aive", "core"), false);
    const exe = touch(join(pk, ...s.exe));
    const notElectron = () => {
      throw new Error("not consulted for a packaged core");
    };
    check(!isSourceCheckout(from), `${s.os} packaged: isSourceCheckout() reads the fixture as packaged`);
    const withVersion = rendererBinary({ from, execPath: exe, electronVersion: version, requireElectron: notElectron });
    check(same(withVersion, { ok: true, command: exe, args: [RENDERER_FLAG] }), `${s.os} packaged: execPath with only ${RENDERER_FLAG} (${JSON.stringify(withVersion)})`);
    const noVersion = rendererBinary({ from, execPath: exe, electronVersion: undefined, requireElectron: () => exe });
    check(!noVersion.ok && noVersion.reason === "no-binary", `${s.os} packaged without an Electron version: no-binary (${JSON.stringify(noVersion)})`);

    // Source checkout: src/ in packages/core, apps/desktop/electron/main.cjs.
    const root = join(t, `source-${s.os}`);
    const sfrom = fixtureCore(join(root, "repo", "packages", "core"), true);
    touch(join(root, "repo", "apps", "desktop", "electron", "main.cjs"));
    const sexe = touch(join(root, s.unpacked, ...s.exe));
    const fake = touch(join(root, "repo", "node_modules", "electron", "dist", "electron"));
    const desktop = realpathSync(join(root, "repo", "apps", "desktop"));
    check(isSourceCheckout(sfrom), `${s.os} source: isSourceCheckout() reads the fixture as a source checkout`);
    const asked: string[] = [];
    const viaExec = rendererBinary({ from: sfrom, execPath: sexe, electronVersion: version, requireElectron: () => fake });
    check(same(viaExec, { ok: true, command: sexe, args: [desktop, RENDERER_FLAG] }), `${s.os} source under Electron: execPath, then apps/desktop, then the flag (${JSON.stringify(viaExec)})`);
    const viaRequire = rendererBinary({ from: sfrom, execPath: sexe, electronVersion: undefined, requireElectron: (d) => (asked.push(d), fake) });
    check(
      same(viaRequire, { ok: true, command: fake, args: [desktop, RENDERER_FLAG] }) && same(asked, [desktop]),
      `${s.os} source under Node: require("electron") from apps/desktop, then apps/desktop, then the flag (${JSON.stringify(viaRequire)})`,
    );
    const noElectron = rendererBinary({ from: sfrom, execPath: sexe, electronVersion: undefined, requireElectron: () => { throw new Error("Cannot find module 'electron'"); } });
    check(!noElectron.ok && noElectron.reason === "no-binary", `${s.os} source, require("electron") failing and no Electron version: no-binary`);

    const bare = join(t, `nomain-${s.os}`);
    const nfrom = fixtureCore(join(bare, "repo", "packages", "core"), true);
    const nexe = touch(join(bare, s.unpacked, ...s.exe));
    const noMain = rendererBinary({ from: nfrom, execPath: nexe, electronVersion: version });
    check(!noMain.ok && noMain.reason === "no-binary", `${s.os} source without apps/desktop/electron/main.cjs: no-binary`);
  }
}

// ---- pages -------------------------------------------------------------------------

const W = 64;
const H = 32;
const FRAMES = 12;
/** Region A's opaque colour on frame n. */
const colour = (n: number): [number, number, number] => [(n * 37 + 11) % 256, (n * 59 + 23) % 256, (n * 83 + 47) % 256];
/** The 50%-alpha patches: [x, y, r, g, b]; alpha 128. */
const HALF: [number, number, number, number, number][] = [
  [32, 0, 255, 0, 0],
  [48, 0, 0, 0, 255],
  [32, 16, 0, 160, 0],
];

/** Frame n: region A (0..31 x 0..31) opaque colour(n), three 16x16 patches at 50% alpha, the rest (48..63 x 16..31) empty. */
const PATTERN = `
const c = document.createElement("canvas");
c.width = ${W}; c.height = ${H}; c.style.display = "block";
document.getElementById("root").appendChild(c);
const g = c.getContext("2d");
const half = ${JSON.stringify(HALF)};
zrMotion.onFrame(async (n) => {
  await new Promise((r) => setTimeout(r, 60)); // drawn later: a capture that does not wait for the frame sees the previous one
  g.clearRect(0, 0, ${W}, ${H});
  g.fillStyle = "rgb(" + ((n * 37 + 11) % 256) + "," + ((n * 59 + 23) % 256) + "," + ((n * 83 + 47) % 256) + ")";
  g.fillRect(0, 0, 32, 32);
  for (const [x, y, r, gr, b] of half) { g.fillStyle = "rgba(" + r + "," + gr + "," + b + ",0.5)"; g.fillRect(x, y, 16, 16); }
});
`;

/** The exact bytes frame n should have on the pipe: B,G,R,A, premultiplied; over opaque black when `opaque`. */
function expectedFrame(n: number, opaque: boolean): Buffer {
  const buf = Buffer.alloc(W * H * 4);
  const put = (x0: number, y0: number, w: number, h: number, bgra: number[]) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) buf.set(bgra, (y * W + x) * 4);
  };
  put(0, 0, W, H, [0, 0, 0, opaque ? 255 : 0]);
  const [r, g, b] = colour(n);
  put(0, 0, 32, 32, [b, g, r, 255]);
  const pm = (v: number) => Math.round((v * 128) / 255);
  for (const [x, y, hr, hg, hb] of HALF) put(x, y, 16, 16, [pm(hb), pm(hg), pm(hr), opaque ? 255 : 128]);
  return buf;
}

interface Run {
  frames: Buffer[];
  messages: RendererMessage[];
  pids: number[];
  exit: { code: number | null; signal: string | null } | null;
  result?: Awaited<ReturnType<typeof renderMotion>>;
  error?: Error;
  ms: number;
}

/** renderMotion with the run's frames, messages, renderer PID (and its children while it ran) and exit recorded; `o` has a module (a hand-written page) or a graphic. */
async function render(f: Fresh, id: string, o: Partial<RenderMotionOptions> & ({ module: string } | { graphic: NonNullable<RenderMotionOptions["graphic"]> })): Promise<Run> {
  const chunks: Buffer[] = [];
  const run: Run = { frames: [], messages: [], pids: [], exit: null, ms: 0 };
  let tree: ReturnType<typeof watchTree> | null = null;
  const alpha = o.alpha ?? true;
  const t0 = Date.now();
  try {
    run.result = await renderMotion({
      width: W,
      height: H,
      fps: 30,
      durationInFrames: FRAMES,
      alpha,
      workDir: join(f.data, "motion", id),
      outPath: join(f.data, "baked", `${id}-graphic.${alpha ? "mov" : "mp4"}`),
      previewPath: alpha ? join(f.data, "baked", `${id}-graphic.webm`) : undefined,
      env: f.env,
      onFrameData: (c) => chunks.push(Buffer.from(c)),
      onMessage: (m) => run.messages.push(m),
      onSpawn: (pid) => {
        run.pids.push(pid);
        if (LINUX) tree = watchTree(pid);
      },
      onExit: (code, signal) => (run.exit = { code, signal }),
      ...o,
    });
  } catch (err) {
    run.error = err as Error;
  }
  run.ms = Date.now() - t0;
  const w = o.width ?? W;
  const h = o.height ?? H;
  const all = Buffer.concat(chunks);
  for (let i = 0; i + w * h * 4 <= all.length; i += w * h * 4) run.frames.push(all.subarray(i, i + w * h * 4));
  if (all.length % (w * h * 4) !== 0) run.frames.push(all.subarray(all.length - (all.length % (w * h * 4))));
  const watched = (tree as ReturnType<typeof watchTree> | null)?.stop();
  if (watched) run.pids.push(...watched.seen.keys());
  return run;
}

/** After a render: its renderer and that renderer's children are gone, motion/<id> is gone. */
async function leftNothing(run: Run, f: Fresh, id: string, what: string, ms = 2000) {
  const left = LINUX ? await gone(run.pids, ms) : [];
  check(run.pids.length > 0 && left.length === 0, `${what}: no renderer process left (${run.pids.length} watched, left ${JSON.stringify(left)})`);
  check(!existsSync(join(f.data, "motion", id)), `${what}: motion/${id} is removed`);
}

const logs = (run: Run) => run.messages.filter((m) => m.type === "log").map((m) => String(m.text));

/** FFmpeg's decode of `file` as RGBA frames (its default reading: BT.601, limited range, for untagged YUV). */
function decodeRgba(file: string, w: number, h: number): Buffer[] {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { maxBuffer: 1 << 28 });
  const out: Buffer[] = [];
  for (let i = 0; i + w * h * 4 <= r.stdout.length; i += w * h * 4) out.push(r.stdout.subarray(i, i + w * h * 4));
  return out;
}

function probeStream(file: string): Record<string, string> {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,profile,pix_fmt,color_space,color_transfer,color_primaries,color_range", "-of", "json", file], { encoding: "utf8" });
  return (JSON.parse(r.stdout || "{}") as { streams?: Record<string, string>[] }).streams?.[0] ?? {};
}

const near = (a: ArrayLike<number>, b: ArrayLike<number>, tol: number) => Array.from(b).every((v, i) => Math.abs(a[i] - v) <= tol);
const px = (frame: Buffer, x: number, y: number, w = W) => [...frame.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];

// ---- R2: frames ------------------------------------------------------------------------

/** Logs each frame's clock readings: Date.now, new Date(), Date() (to the second), performance.now, the rAF timestamp, document.timeline.currentTime and a new DocumentTimeline's (originTime 10). */
const CLOCK = `
zrMotion.onFrame((n) => new Promise((resolve) => requestAnimationFrame((t) => {
  zrMotionHost.log("CLOCK " + JSON.stringify({ n, now: Date.now(), date: new Date().getTime(), str: Date.parse(Date()), perf: performance.now(), raf: t, timeline: document.timeline.currentTime, own: new DocumentTimeline({ originTime: 10 }).currentTime }));
  resolve();
})));
`;
const EPOCH = 946684800000;

// MUTATION: motion-renderer.cjs swaps R and B on this platform (swapRB = !swapRB) → the
// byte-exact frame rows fail. loader.js reports frameReady before drawing → frames come out
// one behind and the per-frame rows fail. Drop `unpremultiply=inplace=1` from encodeArgs →
// the straight-alpha rows fail. The standalone window transparent (opaque=false) → the
// standalone pipe rows fail (alpha 0). encodeArgs with `-colorspace bt709` → the untagged
// row fails.
// MUTATION (clock): guard.js without `g.Date = VirtualDate` → the Date row fails. guard.js's
// requestAnimationFrame passing the real timestamp (cb instead of cb(now)) → the
// performance/rAF row fails. guard.js without the DocumentTimeline currentTime getter → the
// timeline rows fail; the getter returning the virtual time for every timeline (originTime
// ignored) → the new DocumentTimeline row fails.
async function r2(work: string) {
  console.log("R2. frames: the page's clock, exact pattern per frame, B,G,R,A, straight alpha after ProRes, opaque standalone...");
  const k = fresh(work, "clock");
  const clock = await render(k, "clock", { module: CLOCK, durationInFrames: 4 });
  const ticks = logs(clock).filter((t) => t.startsWith("CLOCK ")).map((t) => JSON.parse(t.slice(6)) as Record<string, number>);
  const at = (n: number) => (n * 1000) / 30;
  check(!clock.error && ticks.length === 4 && ticks.every((c, n) => c.n === n && c.now === EPOCH + Math.floor(at(n)) && c.date === c.now && c.str === EPOCH),
    `Date.now, new Date() and Date() read frame / fps from 2000-01-01 (${clock.error?.message ?? JSON.stringify(ticks.map((c) => [c.now - EPOCH, c.date - EPOCH, c.str - EPOCH]))})`);
  check(ticks.length === 4 && ticks.every((c, n) => Math.abs(c.perf - at(n)) < 1e-6 && Math.abs(c.raf - at(n)) < 1e-6),
    `performance.now and the requestAnimationFrame timestamp are frame / fps in ms (${JSON.stringify(ticks.map((c) => [c.perf, c.raf]))})`);
  check(ticks.length === 4 && ticks.every((c, n) => Math.abs(c.timeline - at(n)) < 1e-6),
    `document.timeline.currentTime is frame / fps in ms (${JSON.stringify(ticks.map((c) => c.timeline))})`);
  check(ticks.length === 4 && ticks.every((c, n) => Math.abs(c.own - (at(n) - 10)) < 1e-6),
    `new DocumentTimeline({ originTime: 10 }).currentTime is frame / fps less 10 ms (${JSON.stringify(ticks.map((c) => c.own))})`);
  await leftNothing(clock, k, "clock", "clock page");

  const f = fresh(work, "frames");
  const run = await render(f, "frames", { module: PATTERN });
  check(!run.error, `the overlay renders (${run.error?.message ?? `${run.ms} ms`})`);
  check(run.frames.length === FRAMES && run.frames.every((b) => b.length === W * H * 4), `${FRAMES} frames of exactly ${W}*${H}*4 bytes on fd 3 (${run.frames.length}, ${run.frames.map((b) => b.length).join("/")})`);
  const bad = run.frames.map((b, n) => (b.equals(expectedFrame(n, false)) ? -1 : n)).filter((n) => n >= 0);
  check(bad.length === 0, `every frame is byte-for-byte its own pattern: rows of ${W * 4} bytes, B,G,R,A, premultiplied (frames off: ${JSON.stringify(bad)}; frame 3 at (8,8): ${JSON.stringify(run.frames[3] && px(run.frames[3], 8, 8))}, want ${JSON.stringify([...colour(3)].reverse().concat(255))})`);
  check(run.exit?.code === 0, `the renderer exited by itself at EOF (exit ${JSON.stringify(run.exit)})`);
  const mov = join(f.data, "baked", "frames-graphic.mov");
  const webm = join(f.data, "baked", "frames-graphic.webm");
  check(existsSync(mov) && existsSync(webm) && run.result?.previewPath === webm, `baked/ holds the .mov and its .webm preview (${JSON.stringify(readdirSync(join(f.data, "baked")))})`);
  await leftNothing(run, f, "frames", "overlay");

  const decoded = existsSync(mov) ? decodeRgba(mov, W, H) : [];
  check(decoded.length === FRAMES, `the .mov decodes to ${FRAMES} frames (${decoded.length})`);
  const offA = decoded.map((d, n) => (near(px(d, 16, 16), [...colour(n), 255], 3) ? -1 : n)).filter((n) => n >= 0);
  check(decoded.length > 0 && offA.length === 0, `read as BT.601 limited, region A is each frame's colour within 3 levels (off: ${JSON.stringify(offA)}; frame 5 ${JSON.stringify(decoded[5] && px(decoded[5], 16, 16))} vs ${JSON.stringify(colour(5))})`);
  for (const [x, y, r, g, b] of HALF) {
    const got = decoded.map((d) => px(d, x + 8, y + 8));
    check(decoded.length > 0 && got.every((p) => near(p, [r, g, b, 128], 2)), `50%-alpha (${r},${g},${b}) comes out straight within 2 levels (${JSON.stringify(got[0])})`);
  }
  check(decoded.length > 0 && decoded.every((d) => px(d, 56, 24)[3] === 0), `the empty region stays transparent (${JSON.stringify(decoded[0] && px(decoded[0], 56, 24))})`);
  const movTags = probeStream(mov);
  check(
    movTags.codec_name === "prores" && movTags.profile === "4444" && /^yuva444p1[02]le$/.test(movTags.pix_fmt) &&
      [movTags.color_space, movTags.color_primaries, movTags.color_transfer].every((t) => t === undefined || t === "unknown"),
    `ProRes 4444 with alpha, untagged like Remotion's overlays (${JSON.stringify(movTags)})`,
  );

  const s = fresh(work, "standalone");
  const card = await render(s, "card", { module: PATTERN, alpha: false });
  check(!card.error, `the standalone card renders (${card.error?.message ?? `${card.ms} ms`})`);
  const cardBad = card.frames.map((b, n) => (b.equals(expectedFrame(n, true)) ? -1 : n)).filter((n) => n >= 0);
  check(card.frames.length === FRAMES && cardBad.length === 0, `standalone frames are opaque on the pipe: alpha 255 everywhere, the 50% patches over black (off: ${JSON.stringify(cardBad)}; ${JSON.stringify(card.frames[0] && px(card.frames[0], 56, 24))})`);
  const mp4 = join(s.data, "baked", "card-graphic.mp4");
  const mp4Tags = probeStream(mp4);
  check(
    mp4Tags.codec_name === "h264" && mp4Tags.color_space === "smpte170m" && mp4Tags.color_primaries === "smpte170m" && mp4Tags.color_transfer === "smpte170m" && mp4Tags.color_range === "tv",
    `the .mp4 is H.264 with today's complete BT.601 tags (tagGraphicColor) (${JSON.stringify(mp4Tags)})`,
  );
  const cardDecoded = existsSync(mp4) ? decodeRgba(mp4, W, H) : [];
  check(cardDecoded.length === FRAMES && cardDecoded.every((d, n) => near(px(d, 16, 16), [...colour(n), 255], 4)), `the BT.601 colour patch decodes to each frame's colour within 4 levels (${JSON.stringify(cardDecoded[2] && px(cardDecoded[2], 16, 16))} vs ${JSON.stringify(colour(2))})`);
  check(readdirSync(join(s.data, "baked")).join() === "card-graphic.mp4", `baked/ holds only the .mp4 (${JSON.stringify(readdirSync(join(s.data, "baked")))})`);
  await leftNothing(card, s, "card", "standalone");
}

// ---- R3: network ---------------------------------------------------------------------

/** The private address main() gives the namespace's dummy interface: local there, so a request that got through would connect. */
const LAN = "10.99.0.1";
const HOSTS: [string, string][] = [
  ["loop", "127.0.0.1"],
  ["lan", LAN],
  ["invalid", "zr-evil-1.invalid"],
];

/** The page that tries every route; frame 0 logs "RESULTS {...}" once all have settled, frames 1-2 try to navigate away. */
const ATTACK = `
(function () {
  var out = {};
  var hosts = ${JSON.stringify(HOSTS)};
  function settle(p, ms) {
    return Promise.race([
      p.then(function (v) { return "ok:" + v; }, function (e) { return "err:" + ((e && e.name) || e); }),
      new Promise(function (r) { setTimeout(function () { r("timeout"); }, ms || 3000); }),
    ]);
  }
  function add(html) { var d = document.createElement("div"); d.innerHTML = html; document.body.appendChild(d); return d; }
  function loaded(el) { return new Promise(function (res, rej) { el.onload = function () { res("load"); }; el.onerror = function () { rej(new Error("error")); }; }); }
  function wait(ms) { return new Promise(function (r) { setTimeout(function () { r("waited"); }, ms); }); }
  var jobs = [];
  function job(name, fn, ms) { jobs.push(settle(Promise.resolve().then(fn), ms).then(function (v) { out[name] = v; })); }
  function ice(P) {
    var pc = new P({ iceServers: [{ urls: "stun:127.0.0.1:5032" }] });
    pc.createDataChannel("x");
    var cands = [];
    pc.onicecandidate = function (e) { if (e.candidate) cands.push(e.candidate.candidate); };
    return pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).then(function () { return wait(3000); }).then(function () { return cands.join(";") || "no-candidates"; });
  }
  hosts.forEach(function (h) {
    var base = "http://" + h[1] + ":5030/";
    job("fetch-" + h[0], function () { return fetch(base + "fetch").then(function (r) { return r.status; }); });
    job("xhr-" + h[0], function () { return new Promise(function (res, rej) { var x = new XMLHttpRequest(); x.open("GET", base + "xhr"); x.onload = function () { res(x.status); }; x.onerror = function () { rej(new Error("xhr")); }; x.send(); }); });
    job("ws-" + h[0], function () { return new Promise(function (res, rej) { var w = new WebSocket("ws://" + h[1] + ":5031/"); w.onopen = function () { res("open"); }; w.onerror = function () { rej(new Error("ws")); }; }); });
    job("eventsource-" + h[0], function () { return new Promise(function (res, rej) { var e = new EventSource(base + "es"); e.onopen = function () { res("open"); }; e.onerror = function () { e.close(); rej(new Error("es")); }; }); });
    job("img-" + h[0], function () { var i = new Image(); var p = loaded(i); i.src = base + "img.png"; return p; });
    job("font-" + h[0], function () { add("<style>@font-face{font-family:zr" + h[0] + ";src:url(" + base + "font.woff2)}</style>"); return document.fonts.load("16px zr" + h[0]).then(function (f) { return f.length; }); });
    job("css-import-" + h[0], function () { var s = document.createElement("style"); s.textContent = "@import url('" + base + "import.css');"; document.head.appendChild(s); return wait(1500); });
    job("css-url-" + h[0], function () { add("<div style='width:4px;height:4px;background:url(" + base + "bg.png)'></div>"); return wait(1500); });
    job("svg-image-" + h[0], function () { add("<svg width=4 height=4><image href='" + base + "svg.png' width=4 height=4 /></svg>"); return wait(1500); });
    job("preconnect-" + h[0], function () { add("<link rel=preconnect href='" + base + "'><link rel=dns-prefetch href='" + base + "'><link rel=prefetch href='" + base + "prefetch'>"); return wait(1500); });
    job("beacon-" + h[0], function () { return navigator.sendBeacon(base + "beacon", "x"); });
  });
  job("names", function () {
    return ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "WebTransport", "Worker", "SharedWorker"].filter(function (n) { return typeof window[n] !== "undefined"; }).join(",") + "|serviceWorker=" + typeof navigator.serviceWorker;
  });
  job("ice", function () { return window.RTCPeerConnection ? ice(window.RTCPeerConnection) : "gone"; }, 6000);
  job("ice-iframe", function () {
    var f = document.createElement("iframe");
    document.body.appendChild(f);
    var P = f.contentWindow && f.contentWindow.RTCPeerConnection;
    return P ? ice(P).then(function (c) { return "constructor;" + c; }) : "no-constructor";
  }, 6000);
  function blankFrame() { var f = document.createElement("iframe"); document.body.appendChild(f); return f.contentWindow; }
  job("iframe-worker", function () { var C = blankFrame().Worker; if (!C) return "gone"; return new Promise(function (res, rej) { var w = new C("zrmotion://app/worker.js"); w.onmessage = function (e) { res("message " + e.data); }; w.onerror = function () { rej(new Error("worker")); }; }); });
  job("iframe-sharedworker", function () { var C = blankFrame().SharedWorker; if (!C) return "gone"; return new Promise(function (res, rej) { var w = new C("zrmotion://app/shared.js"); w.port.onmessage = function (e) { res("message " + e.data); }; w.onerror = function () { rej(new Error("sharedworker")); }; w.port.start(); }); });
  job("iframe-webtransport", function () { var T = blankFrame().WebTransport; if (!T) return "gone"; return new T("https://127.0.0.1:5033/").ready.then(function () { return "ready"; }); }, 4000);
  job("webtransport", function () { var T = window.WebTransport; if (!T) return "gone"; return new T("https://127.0.0.1:5033/").ready.then(function () { return "ready"; }); }, 4000);
  job("worker", function () { var C = window.Worker; if (!C) return "gone"; return new Promise(function (res, rej) { var w = new C("zrmotion://app/worker.js"); w.onmessage = function (e) { res("message " + e.data); }; w.onerror = function () { rej(new Error("worker")); }; }); });
  job("sharedworker", function () { var C = window.SharedWorker; if (!C) return "gone"; return new Promise(function (res, rej) { var w = new C("zrmotion://app/shared.js"); w.port.onmessage = function (e) { res("message " + e.data); }; w.onerror = function () { rej(new Error("sharedworker")); }; w.port.start(); }); });
  job("serviceworker", function () { var c = navigator.serviceWorker; if (!c) return "gone"; return c.register("zrmotion://app/worker.js").then(function () { return "registered"; }); });
  job("iframe", function () {
    var f = document.createElement("iframe");
    f.src = "zrmotion://app/page.html";
    var p = new Promise(function (r) {
      f.onload = function () { var h; try { h = f.contentWindow.location.href; } catch (e) { h = "blocked:" + e.name; } r(h); };
      setTimeout(function () { r("no-load"); }, 2000);
    });
    document.body.appendChild(f);
    return p;
  });
  job("file-fetch", function () { return fetch("file:///etc/hostname").then(function (r) { return r.status; }); });
  job("file-img", function () { var i = new Image(); var p = loaded(i); i.src = "file:///etc/hostname"; return p; });
  job("file-script", function () { var s = document.createElement("script"); var p = loaded(s); s.src = "file:///etc/hostname"; document.body.appendChild(s); return p; });
  job("script-404", function () { var s = document.createElement("script"); var p = loaded(s); s.src = "nope.js"; document.body.appendChild(s); return p; });
  job("script-other-host", function () { var s = document.createElement("script"); var p = loaded(s); s.src = "zrmotion://other/extra.js"; document.body.appendChild(s); return p; });
  job("script-query", function () { var s = document.createElement("script"); var p = loaded(s); s.src = "extra.js?x=1"; document.body.appendChild(s); return p; });
  job("script-relative", function () { var s = document.createElement("script"); var p = loaded(s); s.src = "extra.js"; document.body.appendChild(s); return p.then(function () { return window.__zrExtra + "@" + s.src; }); });
  job("window-open", function () { return String(window.open("zrmotion://app/page.html")); });
  job("notification", function () { return Notification.requestPermission(); });
  job("geolocation", function () { return new Promise(function (res, rej) { navigator.geolocation.getCurrentPosition(function () { res("position"); }, function (e) { rej(new Error("geolocation " + e.code)); }); }); });
  job("getusermedia", function () { return navigator.mediaDevices ? navigator.mediaDevices.getUserMedia({ audio: true }).then(function () { return "stream"; }) : "no-mediaDevices"; });
  var all = Promise.all(jobs);
  zrMotion.onFrame(function (n) {
    return all.then(function () {
      if (n === 0) zrMotionHost.log("RESULTS " + JSON.stringify(out));
      if (n === 1) location.href = "http://127.0.0.1:5030/navigate";
      if (n === 2) { location.href = "zrmotion://app/other.html"; zrMotionHost.log("STILL " + location.href); }
    });
  });
})();
`;

/** A 1x1 opaque red PNG, what the image routes answer. */
const RED_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");

/**
 * Listeners that count every connection and datagram and answer like real
 * servers, so a request that got through would succeed: TCP 5030 (HTTP, CORS
 * open: text, images, an event stream) and 5031 (WebSocket handshake) on
 * 127.0.0.1 and on {@link LAN}, UDP 5032 (STUN) and 5033 (WebTransport) on
 * 127.0.0.1.
 */
async function listeners() {
  const counts: Record<string, number> = { "udp 5032": 0, "udp 5033": 0 };
  const paths: string[] = [];
  const answer = (req: IncomingMessage, res: ServerResponse) => {
    paths.push(req.url ?? "");
    const cors = { "access-control-allow-origin": "*" };
    if (/\.png$/.test(req.url ?? "")) res.writeHead(200, { ...cors, "content-type": "image/png" }).end(RED_PNG);
    else if (req.url === "/es") res.writeHead(200, { ...cors, "content-type": "text/event-stream" }).write("data: hi\n\n");
    else res.writeHead(200, { ...cors, "content-type": "text/plain" }).end("reached");
  };
  // Every socket, upgraded WebSockets included (closeAllConnections no longer sees those), so close() can end them.
  const sockets = new Set<Socket>();
  const tcp = ["127.0.0.1", LAN].flatMap((host) => [5030, 5031].map((port) => ({ host, port, key: `tcp ${host}:${port}` })));
  const http = tcp.map(({ port, key }) => {
    counts[key] = 0;
    const server = createHttpServer(answer).on("connection", (sock: Socket) => {
      counts[key]++;
      sockets.add(sock);
    });
    if (port === 5031) {
      server.on("upgrade", (req: IncomingMessage, sock: Socket) => {
        const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      });
    }
    return server;
  });
  const udp = [5032, 5033].map((port) => createSocket("udp4").on("message", () => counts[`udp ${port}`]++));
  await Promise.all([
    ...http.map((s, i) => new Promise<void>((r) => s.listen(tcp[i].port, tcp[i].host, () => r()))),
    ...udp.map((s, i) => new Promise<void>((r) => s.bind(5032 + i, "127.0.0.1", () => r()))),
  ]);
  return {
    counts,
    paths,
    async close() {
      for (const s of sockets) s.destroy();
      await Promise.all([...http.map((s) => new Promise<void>((r) => s.close(() => r()))), ...udp.map((s) => new Promise<void>((r) => s.close(() => r())))]);
    },
  };
}

// MUTATION: drop every network layer at once (the CSP header and page.html's meta CSP, the
// session's onBeforeRequest cancel, the dead proxy, the resolver rule) → the listeners on
// 127.0.0.1 and 10.99.0.1 count connections and the loop and lan rows fail. Drop worker-src
// and child-src from both CSPs → the about:blank iframe's Worker and SharedWorker rows fail.
// r3 without its CI check → a CI run with no namespace skips R3 instead of failing. Drop
// guard.js's deletions → the "names gone" rows fail. Drop both WebRTC layers 1 and 2 (setWebRTCIPHandlingPolicy and the
// switch) → the ICE rows without guard.js and from the iframe fail. Drop the permission
// handlers → the notification row fails. Drop setWindowOpenHandler's deny → the
// window.open row fails. Serve zrmotion URLs with a query (drop `!u.search`) → the
// script-query row fails.
async function r3(work: string) {
  console.log("R3. every network route from the page fails, with nothing contacted...");
  if (!process.env[NETNS]) {
    const why = "no private network namespace here (unshare --user --net), and these rows reach for a private address";
    if (process.env.CI === "true") check(false, `R3 runs on CI: ${why}`);
    else skipped("R3", why);
    return;
  }
  const net = await listeners();
  try {
    for (const guard of [true, false]) {
      const what = guard ? "with guard.js" : "without guard.js (CSP and the session alone)";
      const f = fresh(work, guard ? "net-guard" : "net-noguard");
      const before = { ...net.counts };
      // Table entries a worker could run: each answers "alive" once it runs.
      const entries: Record<string, string> = {
        "extra.js": "window.__zrExtra = 1;",
        "worker.js": "postMessage('alive');",
        "shared.js": "onconnect = function (e) { e.ports[0].postMessage('alive'); };",
      };
      if (!guard) entries["guard.js"] = "window.__zrMotionClock = { setFrame: function () {}, syncAnimations: function () {} };";
      const run = await render(f, "net", { module: ATTACK, durationInFrames: 3, entries });
      const line = logs(run).find((t) => t.startsWith("RESULTS "));
      const res = (line ? JSON.parse(line.slice(8)) : {}) as Record<string, string>;
      check(!run.error && !!line, `${what}: the page ran every attempt and rendered all 3 frames (${run.error?.message ?? "ok"})`);
      const contacted = Object.entries(net.counts).filter(([k, v]) => v !== before[k]);
      check(contacted.length === 0, `${what}: no listener (127.0.0.1, ${LAN}) saw a connection or datagram (${JSON.stringify(net.counts)}; requests ${JSON.stringify(net.paths)})`);
      for (const [name] of HOSTS) {
        for (const kind of ["fetch", "xhr", "ws", "eventsource", "img", "font"]) {
          check((res[`${kind}-${name}`] ?? "").startsWith("err:"), `${what}: ${kind} to the ${name} host fails (${res[`${kind}-${name}`]})`);
        }
      }
      const gone = guard;
      check(gone ? res.names === "ok:|serviceWorker=undefined" : res.names === "ok:RTCPeerConnection,webkitRTCPeerConnection,RTCDataChannel,WebTransport,Worker,SharedWorker|serviceWorker=object",
        `${what}: WebRTC, WebTransport, Worker, SharedWorker and serviceWorker are ${gone ? "gone" : "there (so the rows below test the other layers)"} (${res.names})`);
      const stun = net.counts["udp 5032"] - before["udp 5032"];
      check((gone ? res.ice === "ok:gone" : res.ice === "ok:no-candidates") && stun === 0, `${what}: ICE/STUN to the loopback UDP listener gathers and sends nothing (${res.ice}; ${stun} datagrams)`);
      check(res["ice-iframe"] === "ok:constructor;no-candidates" && stun === 0, `${what}: an about:blank iframe's fresh RTCPeerConnection gathers and sends nothing either (${res["ice-iframe"]}; ${stun} datagrams)`);
      const quic = net.counts["udp 5033"] - before["udp 5033"];
      check((gone ? res.webtransport === "ok:gone" : (res.webtransport ?? "").startsWith("err:")) && quic === 0, `${what}: WebTransport fails and sends nothing (${res.webtransport}; ${quic} datagrams)`);
      // An about:blank iframe has its own constructors (guard.js runs in the page only; slice 1 deviation): the CSP it inherits stops them.
      for (const k of ["iframe-worker", "iframe-sharedworker", "iframe-webtransport"]) {
        check((res[k] ?? "").startsWith("err:") && quic === 0, `${what}: ${k.slice(7)} from an about:blank iframe fails and sends nothing (${res[k]}; ${quic} datagrams)`);
      }
      for (const k of ["worker", "sharedworker", "serviceworker"]) {
        check(gone ? res[k] === "ok:gone" : (res[k] ?? "").startsWith("err:"), `${what}: ${k} on a table entry fails (${res[k]})`);
      }
      check(res.iframe === "ok:blocked:SecurityError" || res.iframe === "ok:no-load", `${what}: an iframe of a table entry is blocked (${res.iframe})`);
      for (const k of ["file-fetch", "file-img", "file-script", "script-404", "script-other-host", "script-query"]) {
        check((res[k] ?? "").startsWith("err:"), `${what}: ${k} fails (${res[k]})`);
      }
      check(res["script-relative"] === "ok:1@zrmotion://app/extra.js", `${what}: a relative script loads its table entry against the standard scheme (${res["script-relative"]})`);
      check(res["window-open"] === "ok:null", `${what}: window.open is refused (${res["window-open"]})`);
      check(res.notification === "ok:denied" && (res.geolocation ?? "").startsWith("err:") && (res.getusermedia ?? "").startsWith("err:"),
        `${what}: notification, geolocation and microphone permissions are refused (${res.notification}, ${res.geolocation}, ${res.getusermedia})`);
      check(logs(run).includes("STILL zrmotion://app/page.html"), `${what}: navigations to http: and to another table path are refused; the page stays (${JSON.stringify(logs(run).filter((t) => t.startsWith("STILL")))})`);
      const blocked = run.messages.filter((m) => m.type === "blocked").map((m) => String(m.url));
      console.log(`       (session cancels reported: ${blocked.length}${blocked.length ? `, e.g. ${blocked[0]}` : ""})`);
      await leftNothing(run, f, "net", what);
    }
  } finally {
    await net.close();
  }
}

// ---- R4: limits ----------------------------------------------------------------------

/** The pattern, with `head` run at the start of every frame. */
const withHead = (head: string) => PATTERN.replace("zrMotion.onFrame(async (n) => {", `zrMotion.onFrame(async (n) => { ${head}`);

// MUTATION: until() in rendermotion.ts never times out (drop the failWith on the deadline) →
// the frame-timeout row runs into this row's own limit and fails. Drop the total timer →
// the total-time row fails. Ignore --zr-heap-mb in motion-renderer.cjs (always 2048) → the
// heap row renders and fails.
async function r4(work: string) {
  console.log("R4. limits: frame time, total time, heap...");
  const f = fresh(work, "limits");
  const stall = await render(f, "stall", { module: withHead("if (n === 2) await new Promise(() => {});"), limits: { frameMs: 2500 } });
  const e1 = stall.error as MotionRenderError | undefined;
  check(e1?.code === "graphic_frame_timeout" && stall.ms < 15_000, `a frame that never finishes: graphic_frame_timeout (${e1?.code}: ${e1?.message}; ${stall.ms} ms)`);
  await leftNothing(stall, f, "stall", "frame timeout");

  const late = await render(f, "late", { module: withHead("await new Promise((r) => setTimeout(r, 400));"), durationInFrames: 20, limits: { totalMs: 2500 } });
  const e2 = late.error as MotionRenderError | undefined;
  check(e2?.code === "graphic_render_timeout" && late.ms < 10_000, `a render past its total time: graphic_render_timeout (${e2?.code}: ${e2?.message}; ${late.ms} ms)`);
  await leftNothing(late, f, "late", "total timeout");

  // About 320 MB of JS arrays kept alive on frame 1: past a 64 MB heap, well inside 2048 MB.
  const hog = `const keep = [];\n${withHead("if (n === 1) for (let i = 0; i < 40; i++) keep.push(new Array(1e6).fill(i + 0.5));")}`;
  const heap = await render(f, "heap", { module: hog, heapMb: 64, limits: { frameMs: 20_000 } });
  const e3 = heap.error as MotionRenderError | undefined;
  check(e3?.code === "graphic_render_crashed" && /out of memory/.test(e3.message), `a page past its heap: graphic_render_crashed, out of memory (${e3?.code}: ${e3?.message})`);
  await leftNothing(heap, f, "heap", "heap limit");
  check(readdirSync(join(f.data, "baked")).length === 0, `baked/ is empty after the three failures (${JSON.stringify(readdirSync(join(f.data, "baked")))})`);
}

// ---- R5: lifecycle -------------------------------------------------------------------

const SLOW = withHead("await new Promise((r) => setTimeout(r, 250));");

/**
 * The "core" of R5's crash row: a process that renders and prints the
 * renderer's PID and each frame. Frame 2 takes 10 s, so when the core is
 * killed the renderer is waiting on its page and writes nothing.
 */
async function childRender(data: string, id: string) {
  await renderMotion({
    module: withHead("await new Promise((r) => setTimeout(r, n === 2 ? 10000 : 50));"),
    width: W,
    height: H,
    fps: 30,
    durationInFrames: 200,
    alpha: true,
    workDir: join(data, "motion", id),
    outPath: join(data, "baked", `${id}-graphic.mov`),
    onSpawn: (pid) => console.log(JSON.stringify({ renderer: pid })),
    onProgress: (p) => console.log(JSON.stringify({ progress: p })),
  });
}

/** Lines of `child`'s stdout, parsed, as they come. */
function jsonLines(child: ChildProcess, onMsg: (m: Record<string, unknown>) => void) {
  let buf = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (c: string) => {
    buf += c;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        onMsg(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* not ours */
      }
    }
  });
}

async function waitFor(what: string, cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) {
      console.log(`       (gave up waiting for ${what})`);
      return false;
    }
    await sleep(50);
  }
  return true;
}

/** The renderer run directly (its stdin held open, as the core does) until it exits; at most 30 s. */
async function runRenderer(bin: Extract<RendererBinary, { ok: true }>, args: string[], env: Record<string, string>) {
  const child = spawn(bin.command, [...bin.args, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
  child.stderr?.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-4000)));
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const code = await new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
  clearTimeout(timer);
  child.stdin?.destroy();
  return { code, stdout, stderr };
}

// MUTATION: exited() and renderFrames without their "error" listeners (exit only) → the
// cannot-start rows hang and fail. motion-renderer.cjs without its parent-PID check → the
// crash row's renderer outlives the killed core and fails. cli.ts without sweepMotionScratch → motion/<id>
// survives the next core start and fails. renderMotion without the abort listener → the
// abort row renders to the end and fails. moveAll without its rollback → the later-move
// row finds the .mov in baked/ and fails. moveAll's EXDEV branch recording `to` only after
// rm(from) → the EXDEV row finds the copied .mov in baked/. probeMotionRenderer without the
// renderer's error line in its detail → the failing-renderer row fails. The renderer's stdin
// 'end' handler dropped → the success row's renderer is killed after the 10 s wait instead of
// exiting 0 (R2). The
// renderer without the --zr-scratch check → the no-scratch row fails; without
// app.setPath("userData") → the profile row finds Chromium's files in HOME and fails.
async function r5(work: string) {
  console.log("R5. lifecycle: abort, FFmpeg failure, later move, core killed mid-render, scratch folder...");
  const f = fresh(work, "life");
  const ac = new AbortController();
  let frames = 0;
  const abortRun = render(f, "abort", { module: SLOW, durationInFrames: 200, signal: ac.signal, onProgress: () => ++frames === 3 && ac.abort() });
  const aborted = await abortRun;
  const e1 = aborted.error as MotionRenderError | undefined;
  check(e1?.code === "graphic_render_canceled" && frames < 8, `abort mid-render: graphic_render_canceled after frame ${frames} (${e1?.code}: ${e1?.message})`);
  check(aborted.exit?.signal === "SIGKILL", `the renderer was killed by its PID (exit ${JSON.stringify(aborted.exit)})`);
  await leftNothing(aborted, f, "abort", "abort", 1000);

  // libx264 refuses an odd width: the encode fails after the frames.
  const odd = await render(f, "odd", { module: PATTERN, alpha: false, width: 63 });
  check(!!odd.error && !(odd.error instanceof MotionRenderError) && /ffmpeg/i.test(odd.error.message), `an FFmpeg failure in the encode rejects with FFmpeg's error (${odd.error?.message.slice(0, 120)})`);
  await leftNothing(odd, f, "odd", "FFmpeg failure");

  // The preview's move fails (a folder is in its way) after the .mov's succeeded: both go.
  const blocker = join(f.data, "baked", "move-graphic.webm");
  mkdirSync(join(blocker, "in-the-way"), { recursive: true });
  const move = await render(f, "move", { module: PATTERN });
  check(!!move.error, `a failed later move into baked/ fails the render (${move.error?.message.slice(0, 120)})`);
  check(same(readdirSync(join(f.data, "baked")), ["move-graphic.webm"]) && same(readdirSync(blocker), ["in-the-way"]),
    `baked/ is as it was: the moved .mov is taken back out (${JSON.stringify(readdirSync(join(f.data, "baked")))})`);
  await leftNothing(move, f, "move", "later move");
  rmSync(blocker, { recursive: true, force: true });
  check(readdirSync(join(f.data, "baked")).length === 0, `baked/ is empty after abort, FFmpeg failure and the failed move (${JSON.stringify(readdirSync(join(f.data, "baked")))})`);

  // baked/ on another disk: rename says EXDEV, so the .mov is copied in; then removing it from motion/<id> fails. The copy goes back out.
  const xd = fresh(work, "exdev");
  const injected: string[] = [];
  fsFault = (name, args) => {
    const code = name === "rename" && String(args[1]).startsWith(join(xd.data, "baked")) ? "EXDEV" : name === "rm" && String(args[0]) === join(xd.data, "motion", "exdev", "out.mov") ? "EPERM" : null;
    if (code) injected.push(`${name} ${code}`);
    return code ? errno(code) : null;
  };
  const exdev = await render(xd, "exdev", { module: PATTERN }).finally(() => (fsFault = null));
  check(/EPERM/.test(exdev.error?.message ?? "") && injected.includes("rename EXDEV") && injected.includes("rm EPERM"),
    `across disks (EXDEV), a failed removal after the copy fails the render (${exdev.error?.message.slice(0, 120)}; injected ${JSON.stringify(injected)})`);
  check(readdirSync(join(xd.data, "baked")).length === 0, `…and baked/ ends empty: the copied .mov is taken back out (${JSON.stringify(readdirSync(join(xd.data, "baked")))})`);
  await leftNothing(exdev, xd, "exdev", "EXDEV move");

  // A renderer that cannot start (a file that is not executable): no "exit" ever comes, only "error".
  const x = fresh(work, "nostart");
  const bad: RendererBinary = { ok: true, command: touch(join(x.dir, "not-executable"), "#!/bin/sh\nexit 0\n"), args: [] };
  const hung = (ms: number) => sleep(ms).then(() => "hung" as const);
  let t0 = Date.now();
  const probe = await Promise.race([probeMotionRenderer(x.data, { binary: bad, env: x.env }), hung(10_000)]);
  check(probe !== "hung" && !probe.ok && probe.reason === "start-failed" && Date.now() - t0 < 5000,
    `a renderer that cannot start: the probe says start-failed at once (${JSON.stringify(probe)}; ${Date.now() - t0} ms)`);
  // A renderer that starts and fails (fail() in motion-renderer.cjs: its error line on stdout, then exit 1), with only noise on stderr.
  const failing: RendererBinary = {
    ok: true,
    command: touch(join(x.dir, "failing-renderer"), `#!/bin/sh\necho "ERROR:dbus/bus.cc:406] Failed to connect to the bus" >&2\necho '{"type":"error","code":"graphic_renderer_unavailable","message":"the probe frame is wrong"}'\nexit 1\n`),
    args: [],
  };
  chmodSync(failing.command, 0o755);
  const failed = await probeMotionRenderer(x.data, { binary: failing, env: x.env });
  const detail = failed.ok ? "" : failed.detail;
  check(!failed.ok && detail.startsWith("graphic_renderer_unavailable: the probe frame is wrong; exit 1; ") && detail.includes("Failed to connect to the bus"),
    `a renderer that fails: the probe's detail leads with the renderer's own error line, then the stderr tail (${JSON.stringify(failed)})`);
  t0 = Date.now();
  const nostart = await Promise.race([render(x, "nostart", { module: PATTERN, binary: bad }), hung(15_000)]);
  const e0 = nostart === "hung" ? undefined : (nostart.error as MotionRenderError | undefined);
  check(e0?.code === "graphic_renderer_unavailable" && Date.now() - t0 < 5000, `…and a render rejects with graphic_renderer_unavailable at once (${e0?.code}: ${e0?.message}; ${Date.now() - t0} ms)`);
  const cmdline = (pid: number) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      return "";
    }
  };
  const encoders = await gone(descendants(process.pid).filter((p) => /ffmpeg/.test(cmdline(p))), 2000);
  check(!existsSync(join(x.data, "motion", "nostart")) && readdirSync(join(x.data, "baked")).length === 0 && encoders.length === 0,
    `…leaving no motion/nostart, nothing in baked/ and no FFmpeg (${JSON.stringify(filesUnder(x.data))}; FFmpeg left ${JSON.stringify(encoders)})`);

  // The core killed mid-render.
  const c = fresh(work, "crash");
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--child-render", c.data, "crash"], { env: c.env, stdio: ["ignore", "pipe", "inherit"] });
  let renderer = 0;
  let progressed = 0;
  jsonLines(child, (m) => {
    if (typeof m.renderer === "number") renderer = m.renderer;
    if (typeof m.progress === "number") progressed++;
  });
  const started = await waitFor("the child's frames", () => progressed >= 2, 30_000);
  const tree = renderer ? [renderer, ...descendants(renderer)] : [];
  check(started && tree.length > 1, `the child core renders (renderer ${renderer} with ${tree.length - 1} Chromium children)`);
  child.kill("SIGKILL");
  const left = await gone(tree, 2000);
  check(tree.length > 0 && left.length === 0, `the core killed mid-render: no renderer process within 2 s (left ${JSON.stringify(left)})`);
  check(existsSync(join(c.data, "motion", "crash", "owner.json")), "the dead core's motion/crash is still there before the next start");
  // A folder of a live core, and one without owner.json (the Remotion path's), stay.
  touch(join(c.data, "motion", "live", "owner.json"), JSON.stringify({ pid: process.pid }));
  touch(join(c.data, "motion", "remotion-scaffold", "Graphic.tsx"));
  const cli = join(CORE_DIST, "cli.js");
  if (!existsSync(cli)) {
    check(false, `the built core is missing (${cli}): run npm run build`);
  } else {
    const core = spawn(process.execPath, [cli], { env: { ...c.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined, AIVE_PORT: "5036" }, stdio: ["ignore", "pipe", "pipe"] });
    let ready = false;
    jsonLines(core, (m) => (ready ||= m.event === "ready"));
    const up = await waitFor("the core's ready line", () => ready, 30_000);
    const swept = await waitFor("the sweep", () => !existsSync(join(c.data, "motion", "crash")), 5000);
    check(up && swept, `the next core start removes the dead core's motion/crash (ready ${up})`);
    check(existsSync(join(c.data, "motion", "live")) && existsSync(join(c.data, "motion", "remotion-scaffold")), "…and keeps a live core's folder and one without owner.json");
    core.kill("SIGTERM");
    const coreLeft = await gone([core.pid!], 10_000);
    if (coreLeft.length) core.kill("SIGKILL");
    check(coreLeft.length === 0, `the core started here stopped (pid ${core.pid})`);
  }

  // The scratch folder: without it, exit 2 and nothing written; with it, everything under it.
  const bin = rendererBinary();
  if (!bin.ok) {
    check(false, `the binary rule finds this checkout's Electron (${bin.detail})`);
    return;
  }
  // Fontconfig's cache is the one thing Chromium writes before any JS runs: in XDG_CACHE_HOME,
  // which the core points at the render's tmp folder (never HOME).
  const n = fresh(work, "noscratch");
  const r = await runRenderer(bin, [`--zr-parent-pid=${process.pid}`, "--mute-audio", ...(LINUX ? ["--ozone-platform=headless"] : []), "--probe"], rendererEnv(n.dir, n.env));
  const tmpFiles = filesUnder(join(n.dir, "tmp")).filter((x) => !x.startsWith("fontconfig/"));
  check(r.code === 2 && filesUnder(n.home).length === 0 && filesUnder(n.data).length === 0 && tmpFiles.length === 0,
    `no --zr-scratch: exit 2, nothing written but fontconfig's cache in the render's tmp (exit ${r.code}; ${JSON.stringify([...filesUnder(n.home), ...filesUnder(n.data), ...tmpFiles].slice(0, 5))})`);
  const p = fresh(work, "scratch");
  const scratch = join(p.data, "motion", "probe-test");
  mkdirSync(join(scratch, "tmp"), { recursive: true });
  const r2 = await runRenderer(bin, rendererArgs(scratch, 16, 16, ["--probe"]), rendererEnv(scratch, p.env));
  const inHome = filesUnder(p.home);
  const inScratch = filesUnder(scratch);
  const probed = r2.code === 0 && /"probe":"ok"/.test(r2.stdout);
  // On a failure the renderer's stderr tail goes in the message (the row failed once, then passed on a rerun).
  check(probed, `with --zr-scratch the probe runs (exit ${r2.code}${probed ? "" : `; stderr: ${r2.stderr.trim().split("\n").slice(-5).join(" | ")}`})`);
  check(inScratch.some((x) => x.startsWith("profile/")) && inHome.length === 0, `Chromium's profile lands under motion/<id>/profile, nothing in HOME (${inScratch.length} files there; HOME: ${JSON.stringify(inHome.slice(0, 5))})`);
  check(filesUnder(p.data).every((x) => x.startsWith("motion/probe-test/")), `nothing else in the data folder (${JSON.stringify(filesUnder(p.data).filter((x) => !x.startsWith("motion/probe-test/")).slice(0, 5))})`);
}

// ---- R6: launch rows -------------------------------------------------------------------

/** The child "core" of rows b and c: the built core's probe, run under Electron in Node mode as core-launcher.cjs runs the core. */
const PROBE_CHILD = `
import { readFileSync } from "node:fs";
const [motion, data] = process.argv.slice(2);
const { probeMotionRenderer } = await import(motion);
const { rendererBinary } = await import(motion.replace(/rendermotion\\.js$/, "rendererbinary.js"));
let environ = null;
const probe = await probeMotionRenderer(data, {
  onSpawn: (pid) => {
    try { environ = readFileSync("/proc/" + pid + "/environ", "latin1").split("\\0").filter(Boolean).map((e) => e.slice(0, e.indexOf("="))); } catch {}
  },
});
console.log(JSON.stringify({ binary: rendererBinary(), probe, environ, execPath: process.execPath, electron: process.versions.electron ?? null }));
`;

interface LaunchResult {
  binary: RendererBinary;
  probe: Awaited<ReturnType<typeof probeMotionRenderer>>;
  environ: string[] | null;
}

/** The checks every launch row shares. */
function launchChecks(row: string, r: LaunchResult | null, f: Fresh, watched: ReturnType<ReturnType<typeof watchTree>["stop"]>, want: { command: string; args: string[] }) {
  check(!!r && same(r.binary, { ok: true, ...want }), `${row}: the binary rule gives ${JSON.stringify(want)} (${JSON.stringify(r?.binary)})`);
  const report = r?.probe.ok ? r.probe.report : null;
  check(report?.probe === "ok", `${row}: the probe prints {"probe":"ok"} (${JSON.stringify(r?.probe).slice(0, 300)})`);
  check(report?.visibleWindows === 0, `${row}: no visible window (${String(report?.visibleWindows)})`);
  const modules = (report?.modules as string[] | undefined) ?? [];
  check(modules.length > 0 && modules.some((m) => /motion-renderer\.cjs$/.test(m)) && !modules.some((m) => DESKTOP_MODULES.test(m)),
    `${row}: main.cjs dispatched to motion-renderer.cjs and loaded none of core-launcher, media-servers, graphics-addon (${JSON.stringify(modules.filter((m) => /\.cjs$/.test(m)).map((m) => m.split(/[\\/]/).pop()))})`);
  const env = (report?.env as string[] | undefined) ?? [];
  const extra = env.filter((k) => !ALLOWED_ENV.has(k) && !CHROMIUM_ENV.has(k));
  check(env.length > 0 && extra.length === 0 && !env.includes("AIVE_DATA_DIR") && !env.includes("ELECTRON_RUN_AS_NODE"), `${row}: the renderer's environment is the allowlist (extra: ${JSON.stringify(extra)})`);
  const initial = r?.environ ?? null;
  check(!!initial && initial.every((k) => ALLOWED_ENV.has(k)) && !initial.includes("AIVE_DATA_DIR") && !initial.includes("ELECTRON_RUN_AS_NODE"), `${row}: as spawned, only allowlisted variables (/proc environ: ${JSON.stringify(initial)})`);
  const cores = [...watched.seen.values()].filter((p) => /dist[\\/]cli\.js|aive-core/.test(p.cmd));
  const asNode = [...watched.seen.entries()].filter(([, p]) => p.env.includes("ELECTRON_RUN_AS_NODE"));
  check(cores.length === 0 && asNode.length === 0, `${row}: no core and no child with ELECTRON_RUN_AS_NODE (${watched.seen.size} processes seen; ${JSON.stringify([...cores, ...asNode.map(([, p]) => p)].map((p) => p.cmd.slice(0, 80)))})`);
  check(watched.ports.size === 0, `${row}: no port 5030-5039 opened (${JSON.stringify([...watched.ports])})`);
  const servers = [...filesUnder(f.home), ...filesUnder(f.data)].filter((x) => x.endsWith("server.json"));
  check(servers.length === 0, `${row}: no server.json written (${JSON.stringify(servers)})`);
  check(!existsSync(join(f.data, "motion")) || readdirSync(join(f.data, "motion")).length === 0, `${row}: the probe's motion/probe-<pid> is removed`);
}

/** Rows b and c: `exe` in Node mode runs the probe child with `motion` (the core's rendermotion.js). */
async function childProbe(work: string, row: string, exe: string, motion: string, want: { command: string; args: string[] }) {
  const f = fresh(work, row.replace(/\W+/g, "-"));
  const script = join(f.dir, "probe-child.mjs");
  writeFileSync(script, PROBE_CHILD);
  const child = spawn(exe, [script, pathToFileURL(motion).href, f.data], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  const watch = watchTree(child.pid!);
  const got: { out: LaunchResult | null } = { out: null };
  let err = "";
  child.stderr?.on("data", (c: Buffer) => (err = (err + c.toString()).slice(-4000)));
  jsonLines(child, (m) => (got.out = m as unknown as LaunchResult));
  const done = await waitFor(`${row}'s child`, () => child.exitCode !== null || child.signalCode !== null, 60_000);
  if (!done) child.kill("SIGKILL");
  const watched = watch.stop();
  if (!got.out) console.log(`       (${row} child stderr: ${err.trim().split("\n").slice(-5).join(" | ")})`);
  launchChecks(row, got.out, f, watched, want);
}

// MUTATION: rendererbinary.ts's source-checkout branch without the apps/desktop app path
// (args: [RENDERER_FLAG]) → Electron's default_app starts instead: rows a and b fail.
// rendererbinary.ts deciding "packaged" from process.versions.electron → row b fails. The
// renderer's environment built from {...process.env} → the environment rows fail; a name
// added to RENDERER_ENV → the same rows fail (ALLOWED_ENV is its own list). main.cjs's
// dispatch moved below its requires → the module rows fail. A packed build older than this
// tree, or one packed file changed → the byte-identical rows of (c) fail.
async function r6(work: string) {
  console.log("R6. launch: the probe through the core's binary rule (source checkout, dev desktop, packed build)...");
  // (a) Source checkout, the core under plain node (this process).
  {
    const f = fresh(work, "launch-a");
    const watch = watchTree(process.pid);
    let environ: string[] | null = null;
    const probe = await probeMotionRenderer(f.data, { env: f.env, onSpawn: (pid) => (environ = environNames(pid)) });
    const watched = watch.stop();
    launchChecks("(a) source checkout, core under node", { binary: rendererBinary(), probe, environ }, f, watched, { command: realpathSync(ELECTRON), args: [DESKTOP, RENDERER_FLAG] });
  }
  // (b) Dev desktop: the core under the dev Electron binary in Node mode.
  const motionDist = join(CORE_DIST, "motion", "rendermotion.js");
  if (!existsSync(motionDist)) check(false, `the built core is missing (${motionDist}): run npm run build`);
  else await childProbe(work, "(b) dev desktop, core under the dev Electron", ELECTRON, motionDist, { command: realpathSync(ELECTRON), args: [DESKTOP, RENDERER_FLAG] });
  // (c) The packed --dir build.
  const exe = process.env.AIVE_APP || join(DESKTOP, "build", "dist", "linux-unpacked", "zabsreel-desktop");
  if (!existsSync(exe)) {
    skipped("R6 (c)", `no packed build (${exe}; npx electron-builder --linux --dir in apps/desktop makes one)`);
    return;
  }
  const packedCore = join(dirname(exe), "resources", "app", "node_modules", "@aive", "core");
  check(!existsSync(join(packedCore, "src")), `(c) the packed core has no src/ (${packedCore})`);
  // A build older than this tree proves nothing about it: the renderer's files and the core's driver must be this tree's own bytes.
  const packedMotion = join(dirname(exe), "resources", "app", "node_modules", "@aive", "motion");
  for (const [packed, built] of [
    [join(packedMotion, "renderer", "motion-renderer.cjs"), join(REPO, "packages", "motion", "renderer", "motion-renderer.cjs")],
    [join(packedMotion, "renderer", "guard.js"), join(REPO, "packages", "motion", "renderer", "guard.js")],
    [join(packedCore, "dist", "motion", "rendermotion.js"), join(CORE_DIST, "motion", "rendermotion.js")],
  ]) {
    const identical = existsSync(packed) && existsSync(built) && realpathSync(packed) !== realpathSync(built) && readFileSync(packed).equals(readFileSync(built));
    check(identical, `(c) the packed ${packed.slice(dirname(exe).length + 1)} is byte-identical to this tree's ${built.slice(REPO.length + 1)} (rebuild: npm run build, then electron-builder --linux --dir)`);
  }
  await childProbe(work, "(c) packed build", exe, join(packedCore, "dist", "motion", "rendermotion.js"), { command: realpathSync(exe), args: [RENDERER_FLAG] });
}

// ---- R10: the packed app renders ----------------------------------------------------------

/** The packed app's executable on this platform (electron-builder --dir's layout). */
const PACKED_EXE: Record<string, string[]> = {
  linux: ["linux-unpacked", "zabsreel-desktop"],
  win32: ["win-unpacked", "ZabsReel.exe"],
  darwin: ["mac", "ZabsReel.app", "Contents", "MacOS", "ZabsReel"],
};
/** resources/app of the packed app whose executable is `exe`. */
const packedApp = (exe: string) => (process.platform === "darwin" ? join(dirname(exe), "..", "Resources", "app") : join(dirname(exe), "resources", "app"));

const PR_W = 320;
const PR_H = 180;
const PR_FRAMES = 6;
/** The image's one colour (R, G, B). */
const PR_RGB: [number, number, number] = [30, 200, 90];
/** A library video, an image and a font (through loadFont), and the same text below in the fallback font. */
const PACKED_TSX = `import { AbsoluteFill, OffthreadVideo, Img, asset, loadFont } from "remotion";
const { fontFamily } = loadFont(asset("mono"));
const line = { position: "absolute", left: 4, fontSize: 36, color: "#fff", whiteSpace: "nowrap" };
export default function G() {
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <OffthreadVideo src={asset("vid")} style={{ position: "absolute", left: 0, top: 0, width: 160, height: 90 }} />
      <Img src={asset("img")} style={{ position: "absolute", left: 200, top: 10, width: 80, height: 60 }} />
      <div style={{ ...line, top: 92, fontFamily }}>Wil 1 g</div>
      <div style={{ ...line, top: 136 }}>Wil 1 g</div>
    </AbsoluteFill>
  );
}`;

/**
 * The child "core" of R10, run by the packed executable in Node mode (as the packed
 * desktop runs its core): the packed core's own binary rule, its probe, then one render of
 * PACKED_TSX with the packed core's renderMotion. Every process it starts is recorded.
 */
const PACKED_CHILD = `
import { createRequire, syncBuiltinESMExports } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [core, data, job, framesOut] = process.argv.slice(2);
const { fixtures, tsx, width, height, frames } = JSON.parse(readFileSync(job, "utf8"));
const cp = createRequire(import.meta.url)("node:child_process");
const realSpawn = cp.spawn;
const spawned = [];
cp.spawn = function (file, ...rest) {
  const child = realSpawn.call(this, file, ...rest);
  spawned.push({ pid: child.pid ?? null, file: String(file) });
  return child;
};
syncBuiltinESMExports();
const at = (p) => new URL(p, core).href;
const { probeMotionRenderer, renderMotion } = await import(at("dist/motion/rendermotion.js"));
const { rendererBinary } = await import(at("dist/motion/rendererbinary.js"));
const { probeAsset } = await import(at("dist/ffmpeg/ffprobe.js"));
const pids = [];
const probe = await probeMotionRenderer(data, { onSpawn: (pid) => pids.push(pid) });
const chunks = [];
const routes = { media: 0, font: 0 };
let media = null;
let error = null;
try {
  const assets = { vid: await probeAsset(fixtures.vid), img: await probeAsset(fixtures.img), mono: { kind: "font", path: fixtures.font, name: "mono.ttf" } };
  await renderMotion({
    graphic: { source: tsx },
    width, height, fps: 30, durationInFrames: frames, alpha: false,
    workDir: join(data, "motion", "packed"),
    outPath: join(data, "baked", "packed-graphic.mp4"),
    assets,
    onFrameData: (c) => chunks.push(Buffer.from(c)),
    onMessage: (m) => { if (m.type === "media") routes[m.route === "font" ? "font" : "media"]++; },
    onMedia: (s) => (media = s),
    onSpawn: (pid) => pids.push(pid),
  });
} catch (err) {
  error = { code: err.code ?? null, message: String(err.message).slice(0, 400) };
}
writeFileSync(framesOut, Buffer.concat(chunks));
console.log(JSON.stringify({ binary: rendererBinary(), probe, error, media, routes, pids: [...pids, ...spawned.map((s) => s.pid).filter(Boolean)], spawned: spawned.map((s) => s.file.split(/[\\\\/]/).pop()) }));
`;

/** Whether `pid` is alive (portable: Windows has no /proc). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A monospace font file of this computer (not the page's fallback font), or null. */
function monoFont(): string | null {
  const windows = join(process.env.SystemRoot ?? "C:\\Windows", "Fonts");
  const fonts = ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf", join(windows, "consola.ttf"), join(windows, "cour.ttf")];
  return fonts.find((p) => existsSync(p)) ?? null;
}

// MUTATION: build.files leaving out @aive/motion's vendor/ → the React rows fail (and the render
// fails); leaving out sucrase → the sucrase row and the render fail; without the parity/scripts/
// cleanroom/test exclusions → the "not shipped" row fails. motion-renderer.cjs answering the
// font route with a 404 → the font rows fail; writing zeros to fd 3 → the image, video and font
// rows fail; main.cjs's dispatch moved below its requires → the probe's module row fails;
// motionmedia.ts's close() neither stopping nor awaiting its FFmpeg decodes → the core's
// process does not end on its own and the processes row fails.
async function r10(work: string) {
  console.log("R10. the packed app renders: a library video, an image and a font, frames over fd 3, media over fd 4...");
  const shape = PACKED_EXE[process.platform];
  const exe = process.env.AIVE_APP || (shape ? join(DESKTOP, "build", "dist", ...shape) : "");
  if (!exe || !existsSync(exe)) {
    // A run that names its packed app (CI's packaged jobs) must never pass by skipping.
    if (process.env.AIVE_APP) check(false, `the packed app AIVE_APP names exists (${exe})`);
    else skipped("R10", `no packed build (${exe || process.platform}; npx electron-builder --dir in apps/desktop makes one)`);
    return;
  }
  const app = packedApp(exe);
  const packedCore = join(app, "node_modules", "@aive", "core");
  const packedMotion = join(app, "node_modules", "@aive", "motion");
  // What ships: this tree's renderer, runtime and React (byte-identical: a stale pack proves nothing), the core's sucrase.
  const shipped = [
    ...["motion-renderer.cjs", "preload.cjs", "page.html", "guard.js", "loader.js", "host.js"].map((n) => ["renderer", n]),
    ["dist", "zr-runtime.js"],
    ...["react.production.min.js", "react-dom.production.min.js", "LICENSE"].map((n) => ["vendor", "react-18.3.1", n]),
  ];
  const stale = shipped.filter((p) => {
    const packed = join(packedMotion, ...p);
    const built = join(REPO, "packages", "motion", ...p);
    return !(existsSync(packed) && existsSync(built) && realpathSync(packed) !== realpathSync(built) && readFileSync(packed).equals(readFileSync(built)));
  });
  check(stale.length === 0, `the packed @aive/motion holds this tree's renderer files, dist/zr-runtime.js and vendor/react-18.3.1 (both UMD builds and React's LICENSE), byte-identical (missing or different: ${JSON.stringify(stale.map((p) => p.join("/")))})`);
  const drivers = ["rendermotion.js", "motionmedia.js", "graphicmodule.js"].filter((n) => {
    const packed = join(packedCore, "dist", "motion", n);
    return !(existsSync(packed) && readFileSync(packed).equals(readFileSync(join(CORE_DIST, "motion", n))));
  });
  check(drivers.length === 0, `the packed core's motion driver is this tree's build (rebuild: npm run build, then electron-builder --dir; different: ${JSON.stringify(drivers)})`);
  let sucrase = "";
  try {
    sucrase = realpathSync(createRequire(join(packedCore, "package.json")).resolve("sucrase"));
  } catch {
    /* not shipped */
  }
  check(!!sucrase && sucrase.startsWith(realpathSync(app) + sep), `the packed core finds its sucrase inside the packed app (${sucrase || "not found"})`);
  const extra = ["parity", "scripts", join("cleanroom", "test")].filter((p) => existsSync(join(packedMotion, p)));
  check(existsSync(packedMotion) && extra.length === 0, `the packed @aive/motion has no parity/, scripts/ or cleanroom/test (${JSON.stringify(extra)})`);

  // Fixtures (FFmpeg's lavfi sources) and the font.
  const f = fresh(work, "packed-render");
  const fx = join(f.dir, "fixtures");
  mkdirSync(fx, { recursive: true });
  const font = monoFont();
  if (!font) return check(false, "a monospace font for R10 is installed (DejaVuSansMono, LiberationMono, Consolas or Courier New)");
  const hex = PR_RGB.map((v) => v.toString(16).padStart(2, "0")).join("");
  for (const args of [
    ["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(fx, "vid.mp4")],
    ["-f", "lavfi", "-i", `color=c=0x${hex}:s=16x16`, "-frames:v", "1", join(fx, "img.png")],
  ]) {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
    if (r.status !== 0) return check(false, `R10's fixture: ffmpeg ${args.join(" ")}: ${r.stderr}`);
  }
  writeFileSync(join(fx, "mono.ttf"), readFileSync(font));
  const job = join(f.dir, "job.json");
  writeFileSync(job, JSON.stringify({ fixtures: { vid: join(fx, "vid.mp4"), img: join(fx, "img.png"), font: join(fx, "mono.ttf") }, tsx: PACKED_TSX, width: PR_W, height: PR_H, frames: PR_FRAMES }));
  const script = join(f.dir, "packed-child.mjs");
  writeFileSync(script, PACKED_CHILD);
  const framesOut = join(f.dir, "frames.raw");
  // Windows: what any process there needs (the renderer's allowlist passes SystemRoot and windir on), temp in the row's folder.
  const tmp = join(f.dir, "tmp");
  mkdirSync(tmp, { recursive: true });
  const winEnv = process.platform === "win32"
    ? { SystemRoot: process.env.SystemRoot, windir: process.env.windir, PATHEXT: process.env.PATHEXT, COMSPEC: process.env.COMSPEC, TEMP: tmp, TMP: tmp }
    : {};
  // The core's FFmpeg overrides, when set (CI's Windows job points them past choco's shims, so the processes row watches the real FFmpeg).
  const ffmpegEnv = Object.fromEntries((["AIVE_FFMPEG", "AIVE_FFPROBE"] as const).filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  const child = spawn(exe, [script, pathToFileURL(packedCore + sep).href, f.data, job, framesOut], { env: { ...f.env, ...winEnv, ...ffmpegEnv }, stdio: ["ignore", "pipe", "pipe"] });
  const watch = LINUX ? watchTree(child.pid!) : null;
  type PackedResult = LaunchResult & { error: { code: string | null; message: string } | null; media: MediaStats | null; routes: { media: number; font: number }; pids: number[]; spawned: string[] };
  const got: { out: PackedResult | null } = { out: null };
  let err = "";
  child.stderr?.on("data", (c: Buffer) => (err = (err + c.toString()).slice(-4000)));
  jsonLines(child, (m) => (got.out = m as unknown as PackedResult));
  const done = await waitFor("R10's child", () => child.exitCode !== null || child.signalCode !== null, 180_000);
  if (!done) child.kill("SIGKILL");
  const watched = watch?.stop();
  const r = got.out;
  if (!r) console.log(`       (R10 child stderr: ${err.trim().split("\n").slice(-5).join(" | ")})`);

  // The probe through the packed core's binary rule.
  // Compared as real paths: on Windows the child's execPath may spell the same file another way (case, short names).
  const binary = r?.binary;
  check(!!binary?.ok && existsSync(binary.command) && realpathSync.native(binary.command) === realpathSync.native(exe) && same(binary.args, [RENDERER_FLAG]),
    `the packed core's binary rule gives the app itself with only the flag (${JSON.stringify(binary)})`);
  const report = r?.probe.ok ? r.probe.report : null;
  check(report?.probe === "ok" && report?.visibleWindows === 0, `the packed app's probe prints {"probe":"ok"} with no visible window (${String(JSON.stringify(r?.probe)).slice(0, 300)})`);
  const modules = (report?.modules as string[] | undefined) ?? [];
  check(modules.some((m) => /motion-renderer\.cjs$/.test(m)) && !modules.some((m) => DESKTOP_MODULES.test(m)),
    `the packed main.cjs dispatched to motion-renderer.cjs and loaded none of core-launcher, media-servers, graphics-addon (${JSON.stringify(modules.filter((m) => /\.cjs$/.test(m)).map((m) => m.split(/[\\/]/).pop()))})`);
  const env = (report?.env as string[] | undefined) ?? [];
  // Windows names are case-insensitive, and libuv adds its required ones (WIN_SPAWN_ENV).
  const win = process.platform === "win32";
  const allowed = new Set([...ALLOWED_ENV, ...CHROMIUM_ENV, ...(win ? WIN_SPAWN_ENV : [])].map((k) => (win ? k.toUpperCase() : k)));
  const extraEnv = env.filter((k) => !allowed.has(win ? k.toUpperCase() : k));
  check(env.length > 0 && extraEnv.length === 0, `the packed renderer's environment is the allowlist (extra: ${JSON.stringify(extraEnv)})`);

  // The render: real frames on fd 3, media and a font over fd 4.
  check(!!r && r.error === null, `the packed app renders the graphic (${JSON.stringify(r?.error)})`);
  const raw = existsSync(framesOut) ? readFileSync(framesOut) : Buffer.alloc(0);
  const size = PR_W * PR_H * 4;
  check(raw.length === PR_FRAMES * size, `fd 3 carried exactly ${PR_FRAMES} frames of ${PR_W}x${PR_H}x4 bytes (${raw.length} bytes)`);
  const frames = Array.from({ length: Math.floor(raw.length / size) }, (_, i) => raw.subarray(i * size, (i + 1) * size));
  const at = (fr: Buffer, x: number, y: number) => px(fr, x, y, PR_W);
  const [R, G, B] = PR_RGB;
  const image = frames.length > 0 && frames.every((fr) => near(at(fr, 240, 40), [B, G, R, 255], 2));
  check(image, `the library image shows in its box in every frame, B,G,R,A (${JSON.stringify(frames.map((fr) => at(fr, 240, 40)))})`);
  let lit = 0;
  let moved = 0;
  const first = frames[0];
  const last = frames[frames.length - 1];
  for (let y = 5; first && last && y < 85; y++) {
    for (let x = 5; x < 155; x++) {
      const a = at(first, x, y);
      if (Math.max(a[0], a[1], a[2]) > 40) lit++;
      if (!near(a, at(last, x, y), 16)) moved++;
    }
  }
  check(lit > 6000 && moved > 200, `the library video shows in its box and moves from the first frame to the last (${lit} of 12000 pixels lit, ${moved} changed)`);
  let ink = 0;
  let differ = 0;
  for (let y = 0; first && y < 42; y++) {
    for (let x = 0; x < 196; x++) {
      const a = first[((92 + y) * PR_W + x) * 4 + 1];
      const b = first[((136 + y) * PR_W + x) * 4 + 1];
      if (a > 128) ink++;
      if (Math.abs(a - b) > 64) differ++;
    }
  }
  check(ink > 200 && differ > 200, `the font from the font route draws glyphs that differ from the fallback font's (${ink} inked pixels, ${differ} differ)`);
  check(!!r?.media && r.media.decodes === PR_FRAMES + 1 && r.media.fonts === 1 && r.routes.media >= 2 && r.routes.font === 1,
    `the page's media requests went to the core and their answers back over fd 4: ${PR_FRAMES} video frames, the image and the font (${JSON.stringify({ decodes: r?.media?.decodes, fonts: r?.media?.fonts, routes: r?.routes })})`);
  const out = join(f.data, "baked", "packed-graphic.mp4");
  const counted = existsSync(out) ? spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", out], { encoding: "utf8" }).stdout.trim() : "";
  check(counted === String(PR_FRAMES), `the baked .mp4 has the ${PR_FRAMES} frames (${counted || "no file"})`);

  // Nothing left: no process, no scratch, no file but the output, no core.
  const deadline = Date.now() + 2000;
  const pids = [child.pid!, ...(r?.pids ?? [])];
  let left = pids.filter(alive);
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(50);
    left = left.filter(alive);
  }
  check(!!r && done && child.exitCode === 0 && r.pids.length >= 2 && left.length === 0,
    `the packed core's process ended on its own, and no process of the run is left: its renderers and FFmpeg (exit ${child.exitCode ?? child.signalCode}; ${pids.length} watched: ${JSON.stringify(r?.spawned)}; left ${JSON.stringify(left)})`);
  const files = filesUnder(f.data);
  check(same(files, ["baked/packed-graphic.mp4"]), `the data folder holds only the baked output: no motion/<id>, no probe folder (${JSON.stringify(files.slice(0, 5))})`);
  const servers = [...filesUnder(f.home), ...files].filter((x) => x.endsWith("server.json"));
  check(servers.length === 0 && filesUnder(f.home).length === 0, `nothing in HOME and no server.json (${JSON.stringify(filesUnder(f.home).slice(0, 5))})`);
  if (watched) {
    const cores = [...watched.seen.values()].filter((p) => /dist[\\/]cli\.js|aive-core/.test(p.cmd));
    check(cores.length === 0 && watched.ports.size === 0, `no core started and no port 5030-5039 opened (${watched.seen.size} processes seen; ports ${JSON.stringify([...watched.ports])})`);
  }
}

// ---- R7: measure ----------------------------------------------------------------------

async function r7(work: string) {
  console.log("R7. measure: a 1920x1080 overlay, 60 frames, no DISPLAY...");
  const f = fresh(work, "measure");
  const big = PATTERN.replace(/c\.width = \d+; c\.height = \d+;/, "c.width = 1920; c.height = 1080;").replace(/\n  await new Promise\(\(r\) => setTimeout\(r, 60\)\);[^\n]*/, "");
  const at: number[] = [];
  const run = await render(f, "big", { module: big, width: 1920, height: 1080, durationInFrames: 60, previewPath: undefined, onProgress: () => at.push(Date.now()) });
  check(!run.error && run.frames.length === 60 && run.frames.every((b, n) => near(px(b, 16, 16, 1920), [...colour(n)].reverse().concat(255), 0)), `60 frames of 1920x1080 (${run.error?.message ?? "ok"})`);
  const first = run.result ? run.result.framesMs - (at[at.length - 1] - at[0]) : 0;
  console.log(
    `       measure: ${((at[at.length - 1] - at[0]) / 59).toFixed(1)} ms per 1920x1080 frame through capturePage after the first, ` +
      `${first} ms to the first frame (start included), ${run.ms} ms in all with the ProRes encode; DISPLAY ${f.env.DISPLAY ? "set" : "unset"}, Chromium's headless platform`,
  );
  await leftNothing(run, f, "big", "1920x1080");
}

// ---- R8: the runtime's pieces (no renderer) ------------------------------------------

const MOTION = join(REPO, "packages", "motion");
const VENDOR = join(MOTION, "vendor", "react-18.3.1");
/** The vendored React 18.3.1 UMD production builds and React's MIT licence, as published (npm react@18.3.1 / react-dom@18.3.1, umd/). */
const REACT_SHA256: Record<string, string> = {
  "react.production.min.js": "d949f1c3687aedadcedac85261865f29b17cd273997e7f6b2bfc53b2f9d4c4dd",
  "react-dom.production.min.js": "35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d",
  LICENSE: "52412d7bc7ce4157ea628bbaacb8829e0a9cb3c58f57f99176126bc8cf2bfc85",
};
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** [what, graphic source, the refusal it must get (a RegExp), or null when it must pass]. */
const NAME_MSG = (name: string) => new RegExp(`^${name} is not available in ZabsReel's built-in graphics renderer`);
const IMPORT_CASES: [string, string, RegExp | null][] = [
  ["the title template", TITLE_CARD_TSX, null],
  ["react, its JSX runtimes, remotion and @aive/motion", `import React, { useState } from "react"; import { jsx } from "react/jsx-runtime"; import { jsxDEV } from "react/jsx-dev-runtime"; import { spring } from "remotion"; import { asset, loadFont } from "@aive/motion"; export default () => null;`, null],
  ["a namespace import of remotion", `import * as R from "remotion"; export default () => R.AbsoluteFill;`, null],
  ["type-only imports (erased by the compile)", `import type { CSSProperties } from "./types"; import type Q from "lodash"; import { type CalculateMetadataFunction, spring } from "remotion"; export default () => null;`, null],
  ["import words inside strings, comments, JSX text and a regular expression", `// import x from "fs"\nconst a = "import y from 'fs'"; const r = /import z from 'fs'/; export default () => <div title={a + r}>Don't import "fs" here</div>;`, null],
  ["another package", `import _ from "lodash"; export default () => null;`, /^A graphic can import only react, react\/jsx-runtime, remotion and @aive\/motion, not "lodash"/],
  ["react-dom", `import { createPortal } from "react-dom"; export default () => null;`, /not "react-dom"/],
  ["a relative file", `import x from "./data.json"; export default () => null;`, /not "\.\/data\.json"/],
  ["a side-effect import", `import "fs"; export default () => null;`, /not "fs"/],
  ["a require() call", `const fs = require("fs"); export default () => null;`, /not "fs"/],
  ["import x = require()", `import fs = require("node:fs"); export default () => null;`, /not "node:fs"/],
  ["a re-export from another package", `export { readFile } from "fs"; export default () => null;`, /not "fs"/],
  ["export * from another package", `export * from "fs"; export default () => null;`, /not "fs"/],
  ["dynamic import()", `export default () => { void import("fs"); return null; };`, /^A graphic can't load code with import\(\)/],
  ["import.meta", `export default () => <div>{String(import.meta)}</div>;`, /^A graphic can't use import\.meta/],
  ["a name the runtime does not export", `import { AbsoluteFill, Composition } from "remotion";\nexport default () => null;`, NAME_MSG("Composition")],
  ["a renamed import of a missing name", `import { Still as S } from "@aive/motion"; export default () => null;`, NAME_MSG("Still")],
  ["a string import name", `import { "Thumbnail" as T } from "remotion"; export default () => null;`, NAME_MSG("Thumbnail")],
  ["a default import of remotion", `import Remotion from "remotion"; export default () => null;`, NAME_MSG("default")],
  ["a re-export of a missing name", `export { spring, getInputProps } from "remotion"; export default () => null;`, NAME_MSG("getInputProps")],
];

// MUTATION: check-cleanroom-lock.mjs's sha256 comparison inverted (=== for !==) → the gate row
// fails (and the self-test). The gate without its "not in the lock" check → the self-test's
// added-file case fails. One byte of the vendored react or react-dom, or of the licence,
// changed → its sha256 row fails. build-runtime.mjs with a time stamp in its header → the
// two-builds row fails; dist/zr-runtime.js edited after the build → the "dist is this tree's
// build" row fails. graphicmodule.ts: GRAPHIC_SPECIFIERS with "lodash" added → the lodash row
// fails; the specifier check dropped → every "not <specifier>" row fails; react's names
// checked against the runtime's list → the accepted react rows fail; `* as N` not skipped →
// the namespace row fails; the names check dropped (check() returns null for remotion) → the
// five missing-name rows fail; `import type` not skipped → the type-only row fails; the
// require() check dropped → the require and import-x-=-require rows fail; the export…from
// branch dropped → the two re-export rows and export * fail; the import() and import.meta
// checks dropped → those rows fail; imports found with a regular expression over the text
// instead of sucrase's tokens → the strings/comments/JSX-text row fails; the default import
// not counted → the default row fails.
async function r8(work: string) {
  console.log("R8. the runtime's pieces: the clean-room lock, React's UMD builds, the runtime build, the graphic's imports...");
  // The clean-room lock gate: the real tree, then its own mutations on copies (--self-test).
  const gate = spawnSync(process.execPath, [join(REPO, "scripts", "check-cleanroom-lock.mjs")], { encoding: "utf8" });
  check(gate.status === 0, `the clean-room files match CLEANROOM.lock (${(gate.stdout + gate.stderr).trim().split("\n").pop()})`);
  const self = spawnSync(process.execPath, [join(REPO, "scripts", "check-cleanroom-lock.mjs"), "--self-test"], { encoding: "utf8" });
  check(self.status === 0 && /changed in a runtime file fails/.test(self.stdout) && /added under runtime\/src fails/.test(self.stdout) && /deleted fails/.test(self.stdout),
    `the lock gate fails on a changed byte, an added file and a deleted file (copies of the tree) (${self.stdout.trim().split("\n").filter((l) => !l.startsWith("ok")).join(" | ")})`);

  // React 18.3.1's UMD builds, vendored with their licence.
  for (const [name, want] of Object.entries(REACT_SHA256)) {
    const file = join(VENDOR, name);
    const got = existsSync(file) ? sha256(file) : "missing";
    check(got === want, `vendor/react-18.3.1/${name} has its pinned sha256 (${got.slice(0, 16)}…)`);
  }
  check(existsSync(join(VENDOR, "LICENSE")) && /^MIT License/.test(readFileSync(join(VENDOR, "LICENSE"), "utf8")), "React's MIT licence is beside its builds");

  // The runtime's page script: two builds are byte-identical, and dist/ holds this tree's.
  const outs = [join(work, "runtime-a.js"), join(work, "runtime-b.js")];
  for (const out of outs) spawnSync(process.execPath, [join(MOTION, "scripts", "build-runtime.mjs"), "--out", out], { encoding: "utf8" });
  const [a, b] = outs.map((p) => (existsSync(p) ? readFileSync(p) : Buffer.alloc(0)));
  check(a.length > 0 && a.equals(b), `two builds of the runtime are byte-identical (${a.length} and ${b.length} bytes)`);
  const dist = join(MOTION, "dist", "zr-runtime.js");
  check(existsSync(dist) && readFileSync(dist).equals(a), `dist/zr-runtime.js is this tree's build (npm run build) (${existsSync(dist) ? "differs" : "missing"})`);

  // The graphic's imports, checked before anything starts.
  const exportsList = new Set((JSON.parse(readFileSync(join(MOTION, "cleanroom", "runtime", "exports.json"), "utf8")) as { exports: string[] }).exports);
  for (const [what, source, want] of IMPORT_CASES) {
    let got: string | null;
    try {
      got = graphicImportRefusal(source, exportsList);
    } catch (err) {
      got = `threw: ${(err as Error).message}`;
    }
    check(want === null ? got === null : got !== null && want.test(got), `imports, ${what}: ${want === null ? "accepted" : "refused"} (${got ?? "accepted"})`);
  }
}

// ---- R9: graphics through the runtime --------------------------------------------------

/** Pixels with alpha above 0. */
function inked(frame: Buffer): number {
  let n = 0;
  for (let i = 3; i < frame.length; i += 4) if (frame[i] > 0) n++;
  return n;
}

/** Logs what the page's globals and loader.js's require table give (a hand-written module). */
const TABLE_PAGE = `
(function () {
  var mod = { marker: 1 };
  var req = zrMotion.require(mod);
  function attempt(name) { try { var v = req(name); return v === mod ? "module object" : v === React ? "React" : v === ReactDOM ? "ReactDOM" : typeof v; } catch (e) { return "throws " + e.code; } }
  var jsxr = req("react/jsx-runtime");
  var el = jsxr.jsx("div", { id: "a", children: "x" }, "k");
  zrMotionHost.log("UMD " + JSON.stringify({
    react: React.version, reactDom: ReactDOM.version, createRoot: typeof ReactDOM.createRoot, flushSync: typeof ReactDOM.flushSync,
    runtime: Object.keys(window.__zrMotionRuntime || {}).sort(),
  }));
  zrMotionHost.log("TABLE " + JSON.stringify({
    react: attempt("react"), reactDom: attempt("react-dom"), remotion: attempt("remotion"), motion: attempt("@aive/motion"),
    jsx: [typeof jsxr.jsx, typeof jsxr.jsxs, jsxr.Fragment === React.Fragment, el.type, el.key, el.props.id, el.props.children].join(","),
    jsxDev: req("react/jsx-dev-runtime") === jsxr,
    fs: attempt("fs"), relative: attempt("./x"), client: attempt("react-dom/client"), remotionSub: attempt("remotion/no-react"),
  }));
  zrMotion.onFrame(function () {});
})();
`;

/** Frames from a clock-driven graphic: what each shows depends only on its frame (the virtual clock, useCurrentFrame), never on what was drawn before. */
const SEEK_TSX = `import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
export default function Seek() {
  const frame = useCurrentFrame();
  const x = interpolate(frame, [0, 11], [0, 400]);
  return (
    <AbsoluteFill style={{ background: "transparent" }}>
      <div style={{ position: "absolute", left: x, top: 20, width: 40, height: 40, background: "rgb(200, 30, 90)" }} />
      <div style={{ position: "absolute", left: 10, top: 100, width: (Date.now() % 1000) / 4 + 1, height: 20, background: "white" }} />
    </AbsoluteFill>
  );
}
`;

/** Red until a delayRender it opened on mount is released 400 ms later, green after. */
const DELAY_TSX = `import { useEffect, useState } from "react";
import { AbsoluteFill, delayRender, continueRender } from "remotion";
export default function Waits() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const handle = delayRender("loading the data");
    const t = setTimeout(() => { setReady(true); continueRender(handle); }, 400);
    return () => clearTimeout(t);
  }, []);
  return <AbsoluteFill style={{ background: ready ? "rgb(0, 255, 0)" : "rgb(255, 0, 0)" }} />;
}
`;

/** A component with no React import (automatic JSX) whose colour comes from its props. */
const PROPS_TSX = `import { AbsoluteFill } from "remotion";
type Props = { colour: string };
export default ({ colour }: Props) => <AbsoluteFill style={{ background: colour }} />;
`;

/**
 * A 40x40 box whose `left` runs 0 → 480 px, linear, over 400 ms from the timeline's start:
 * at 30 fps frame n puts it at 40n. CSS_TSX animates it with a CSS keyframe animation,
 * WAAPI_TSX with element.animate() on mount (which, out of order, is the first frame drawn),
 * and four more boxes the same way: one over 800 ms at playback rate 2, one 480 → 0 px played
 * backwards (reverse()), one on a new DocumentTimeline() and one 480 → 0 px played backwards,
 * started in a rAF callback's rAF callback: after loader.js's first sync, and in the frame of
 * its second, so its play and reverse() are still pending there.
 */
const SLIDE_W = 480;
const CSS_TSX = `import { AbsoluteFill } from "remotion";
export default function Slide() {
  return (
    <AbsoluteFill>
      <style>{"@keyframes zr-slide { from { left: 0px; } to { left: 480px; } }"}</style>
      <div style={{ position: "absolute", left: 0, top: 20, width: 40, height: 40, background: "rgb(30, 200, 90)", animation: "zr-slide 400ms linear both" }} />
    </AbsoluteFill>
  );
}
`;
const WAAPI_TSX = `import { useEffect, useRef } from "react";
import { AbsoluteFill } from "remotion";
export default function Slide() {
  const box = useRef<HTMLDivElement>(null);
  const fast = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLDivElement>(null);
  const own = useRef<HTMLDivElement>(null);
  const late = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timing = { duration: 400, easing: "linear", fill: "both" } as const;
    box.current!.animate([{ left: "0px" }, { left: "480px" }], timing);
    fast.current!.animate([{ left: "0px" }, { left: "480px" }], { ...timing, duration: 800 }).playbackRate = 2;
    back.current!.animate([{ left: "480px" }, { left: "0px" }], timing).reverse();
    own.current!.animate([{ left: "0px" }, { left: "480px" }], { ...timing, timeline: new DocumentTimeline() });
    requestAnimationFrame(() => requestAnimationFrame(() => late.current!.animate([{ left: "480px" }, { left: "0px" }], timing).reverse()));
  }, []);
  const at = (top: number) => ({ position: "absolute", left: 0, top, width: 40, height: 40, background: "rgb(30, 200, 90)" }) as const;
  return (
    <AbsoluteFill>
      <div ref={box} style={at(20)} />
      <div ref={fast} style={at(80)} />
      <div ref={back} style={at(140)} />
      <div ref={own} style={at(200)} />
      <div ref={late} style={at(260)} />
    </AbsoluteFill>
  );
}
`;

/** A box shown only by a 1 ms CSS animation: at frame 0 (time 0) it is in its animation, from frame 1 on past it. */
const BLINK_TSX = `import { AbsoluteFill } from "remotion";
export default function Blink() {
  return (
    <AbsoluteFill>
      <style>{"@keyframes zr-blink { from { opacity: 1; } to { opacity: 1; } }"}</style>
      <div style={{ position: "absolute", left: 0, top: 20, width: 40, height: 40, background: "rgb(30, 200, 90)", opacity: 0, animation: "zr-blink 1ms linear" }} />
    </AbsoluteFill>
  );
}
`;

/** A box on a scroll-driven CSS animation (animation-timeline: scroll()): its progress does not depend on time. */
const SCROLL_TSX = `import { AbsoluteFill } from "remotion";
export default function Scrolled() {
  return (
    <AbsoluteFill>
      <style>{"@keyframes zr-scroll { from { left: 0px; } to { left: 440px; } } .zr-scroll { animation: zr-scroll linear both; animation-timeline: scroll(root); }"}</style>
      <div className="zr-scroll" style={{ position: "absolute", left: 0, top: 20, width: 40, height: 40, background: "rgb(30, 200, 90)" }} />
    </AbsoluteFill>
  );
}
`;

/**
 * An endless animation played backwards (playbackRate -1), started in a rAF callback: it has
 * no end to start from, so the sync in painted() throws.
 */
const NO_END_TSX = `import { useEffect, useRef } from "react";
import { AbsoluteFill } from "remotion";
export default function NoEnd() {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    requestAnimationFrame(() => {
      box.current!.animate([{ left: "0px" }, { left: "440px" }], { duration: 400, iterations: Infinity, fill: "both" }).playbackRate = -1;
    });
  }, []);
  return <AbsoluteFill><div ref={box} style={{ position: "absolute", width: 40, height: 40, background: "red" }} /></AbsoluteFill>;
}
`;

const THROWS_AT_2 = `import { AbsoluteFill, useCurrentFrame } from "remotion";
export default () => {
  if (useCurrentFrame() === 2) throw new Error("boom at two");
  return <AbsoluteFill style={{ background: "blue" }} />;
};
`;

// MUTATION: page.html without react-dom's script → the UMD row fails (ReactDOM is gone).
// loader.js's require answering unknown names (no throw) → the table row fails; remotion
// mapped to window.React → the table row fails. host.js not sizing #root → the title rows'
// non-blank checks fail; host.js rendering frame 0 for every n → the "content changes"
// rows fail; host.js with a shorter composition → the title "renders" rows fail. loader.js
// drawing each frame at the previous frame's time → the out-of-order row fails; renderMotion
// ignoring `frames` → the same row fails. loader.js without its two syncAnimations() calls
// (CSS and Web Animations on the wall clock) → the CSS and element.animate() out-of-order and
// position rows fail. The first call made before the draw instead (the frame's new animations
// wait for the sync in painted(), by when a short one has ended), without it, or
// syncAnimations() without pause() → the 1 ms animation row fails. Without the second call (in
// painted()'s second animation frame) → the element.animate() out-of-order row (the nested rAF
// box) and the endless backwards row (that animation renders) fail; painted() resolving when
// syncAnimations() throws → the endless backwards row fails. syncAnimations() setting
// currentTime = now (no playback rate) → the rate-2, backwards and endless backwards rows
// fail; without its backwards branch → the backwards and endless backwards rows fail; without
// the `currentTime = 0` that completes the pause (reverse()'s pending rate unread) → the
// element.animate() out-of-order row fails at the nested rAF box (for an animation the draw
// starts, the first sync's time setting completes the pause before the second sync reads the
// rate); without its skip of animations on another timeline → the scroll-driven row fails
// (setting a scroll() animation's currentTime throws a TypeError); skipping every timeline but
// document.timeline → the new DocumentTimeline row and the element.animate() out-of-order row
// fail.
// loader.js not waiting for the frame's promise →
// the delayRender row fails. loader.js reporting frameReady when the frame rejects (slice
// 1's behaviour) → the error rows and the "frames before the failed one" row fail;
// motion-renderer.cjs sending the page's failure as a plain "error" line → the error rows
// fail (graphic_render_crashed). rendermotion.ts ignoring the page's code (always
// graphic_component_error) → the coded rows fail; accepting any code → the foreign-code row
// fails. The core's missing-name message changed (graphicmodule.ts) → the coded runtime
// error row fails (it must be the runtime's text). host.js without its "did not run"
// default → the empty-module row fails; without its default-export check → the "no
// default export" row fails. graphicmodule.ts without the import check → the unknown-import
// and other-package "before launch" rows fail (a renderer starts); without the vm parse →
// the top-level await row fails; a sucrase error thrown as is → the syntax-error row fails;
// renderMotion making the work folder before the compile → the "nothing written" part of
// the refusal rows fails; without the props cap, or taking an array as props → those rows
// fail. loader.js's JSX shim returning null → the no-React-import row fails; host.js
// dropping the props → the same row fails. The encode written straight into baked/ → the
// "nothing in baked/" rows fail.
async function r9(work: string) {
  console.log("R9. graphics through the runtime: React's globals, the require table, the title template, seeking, CSS and Web Animations, delayRender, errors, refusals before launch...");
  {
    const f = fresh(work, "table");
    const run = await render(f, "table", { module: TABLE_PAGE, durationInFrames: 1 });
    const umd = logs(run).find((t) => t.startsWith("UMD "));
    const u = umd ? (JSON.parse(umd.slice(4)) as Record<string, unknown>) : {};
    check(!run.error && u.react === "18.3.1" && /^18\.3\.1(-|$)/.test(String(u.reactDom)) && u.createRoot === "function" && u.flushSync === "function" && same(u.runtime, ["createModuleObject", "createMotionApp"]),
      `the page has React 18.3.1's globals with ReactDOM.createRoot and flushSync, and the runtime's two entry points (${run.error?.message ?? umd})`);
    const table = logs(run).find((t) => t.startsWith("TABLE "));
    check(same(table ? JSON.parse(table.slice(6)) : null, {
      react: "React", reactDom: "ReactDOM", remotion: "module object", motion: "module object",
      jsx: "function,function,true,div,k,a,x", jsxDev: true,
      fs: "throws graphic_api_unsupported", relative: "throws graphic_api_unsupported", client: "throws graphic_api_unsupported", remotionSub: "throws graphic_api_unsupported",
    }), `loader.js's require: react, react-dom, the JSX shim, remotion and @aive/motion (the module object); anything else throws graphic_api_unsupported (${table})`);
    await leftNothing(run, f, "table", "require table page");
  }

  // The title template at both orientations: frames with content, changing over time.
  for (const [w, h] of [[1920, 1080], [1080, 1920]]) {
    const id = `title-${w}x${h}`;
    const f = fresh(work, id);
    const run = await render(f, id, { graphic: { source: TITLE_CARD_TSX, props: { title: "ZabsReel", subtitle: "motion runtime" } }, width: w, height: h, durationInFrames: 36, previewPath: undefined });
    check(!run.error && run.frames.length === 36, `the title template renders at ${w}x${h} (${run.error?.message ?? `${run.frames.length} frames, ${run.ms} ms`})`);
    const ink = run.frames.map(inked);
    check(ink.length === 36 && ink[0] === 0 && [8, 16, 24].every((n) => ink[n] > 2000), `${w}x${h}: frame 0 is faded out, frames 8, 16 and 24 hold the title (${[0, 8, 16, 24].map((n) => ink[n]).join(", ")} inked pixels)`);
    check(run.frames.length === 36 && !run.frames[4].equals(run.frames[8]) && !run.frames[8].equals(run.frames[16]) && ink[34] < ink[24], `${w}x${h}: the content changes over time (enters, settles, fades out: ${[4, 8, 16, 24, 34].map((n) => ink[n]).join(", ")})`);
    await leftNothing(run, f, id, `title ${w}x${h}`);
  }

  // Seeking: frames rendered out of order are the same bytes as in order.
  {
    const f = fresh(work, "seek");
    const base = { graphic: { source: SEEK_TSX }, width: 480, height: 160, durationInFrames: 12, previewPath: undefined };
    const inOrder = await render(f, "seek-in", base);
    const order = [7, 2, 11, 0, 5, 9, 1, 10, 3, 8, 6, 4];
    const shuffled = await render(f, "seek-out", { ...base, frames: order });
    const byFrame = new Map(order.map((n, i) => [n, shuffled.frames[i]]));
    const off = inOrder.frames.map((b, n) => (byFrame.get(n)?.equals(b) ? -1 : n)).filter((n) => n >= 0);
    check(!inOrder.error && !shuffled.error && inOrder.frames.length === 12 && shuffled.frames.length === 12 && off.length === 0 && !inOrder.frames[0].equals(inOrder.frames[11]),
      `frames rendered out of order (${order.join(",")}) are byte-identical to the same frames in order (${inOrder.error?.message ?? shuffled.error?.message ?? `frames off: ${JSON.stringify(off)}`})`);
    await leftNothing(shuffled, f, "seek-out", "out-of-order render");
  }

  // CSS and Web Animations follow the virtual clock: the same bytes in any order, the box at frame / fps.
  const slides: [string, string, [string, number][]][] = [
    ["a CSS keyframe animation", CSS_TSX, [["", 40]]],
    ["element.animate()", WAAPI_TSX, [["", 40], [" at playback rate 2", 100], [" played backwards", 160], [" on a new DocumentTimeline()", 220], [" started in a nested rAF callback, played backwards", 280]]],
  ];
  for (const [what, source, rows] of slides) {
    const id = source === CSS_TSX ? "css" : "waapi";
    const f = fresh(work, id);
    const base = { graphic: { source }, width: SLIDE_W, height: 320, durationInFrames: 12, previewPath: undefined };
    const inOrder = await render(f, `${id}-in`, base);
    const order = [7, 2, 11, 0, 5, 9, 1, 10, 3, 8, 6, 4];
    const shuffled = await render(f, `${id}-out`, { ...base, frames: order });
    const byFrame = new Map(order.map((n, i) => [n, shuffled.frames[i]]));
    const off = inOrder.frames.map((b, n) => (byFrame.get(n)?.equals(b) ? -1 : n)).filter((n) => n >= 0);
    check(!inOrder.error && !shuffled.error && inOrder.frames.length === 12 && shuffled.frames.length === 12 && off.length === 0,
      `${what}: frames rendered out of order are byte-identical to the same frames in order (${inOrder.error?.message ?? shuffled.error?.message ?? `frames off: ${JSON.stringify(off)}`})`);
    // Frame n: the box covers x = 40n..40n+39 on its row, and 4 px to either side is empty.
    const box = [90, 200, 30, 255];
    for (const [how, y] of rows) {
      const wrong = inOrder.frames.map((b, n) => {
        const inside = same(px(b, 40 * n + 20, y, SLIDE_W), box);
        const before = n === 0 || px(b, 40 * n - 4, y, SLIDE_W)[3] === 0;
        const after = 40 * n + 44 >= SLIDE_W || px(b, 40 * n + 44, y, SLIDE_W)[3] === 0;
        return inside && before && after ? -1 : n;
      }).filter((n) => n >= 0);
      const edge = (b: Buffer) => { for (let x = 0; x < SLIDE_W; x++) if (px(b, x, y, SLIDE_W)[3] > 0) return x; return -1; };
      check(inOrder.frames.length === 12 && wrong.length === 0,
        `${what}${how}: at frame n the box's left edge is at 40n px, frame / fps into the animation (frames off: ${JSON.stringify(wrong)}; left edges ${JSON.stringify(inOrder.frames.map(edge))})`);
    }
    await leftNothing(shuffled, f, `${id}-out`, `${what} out of order`);
  }
  // A 1 ms animation is on screen at frame 0 only, though it has ended by the wall clock before the capture.
  {
    const f = fresh(work, "blink");
    const run = await render(f, "blink", { graphic: { source: BLINK_TSX }, width: SLIDE_W, height: 80, durationInFrames: 3, previewPath: undefined });
    const shown = run.frames.map((b) => px(b, 20, 40, SLIDE_W)[3] > 0);
    check(!run.error && same(shown, [true, false, false]), `a 1 ms CSS animation shows its box at frame 0 only (${run.error?.message ?? JSON.stringify(shown)})`);
    await leftNothing(run, f, "blink", "1 ms animation");
  }
  // An animation on a scroll() timeline is left alone: every frame renders, and they are all the same.
  {
    const f = fresh(work, "scroll");
    const run = await render(f, "scroll", { graphic: { source: SCROLL_TSX }, width: SLIDE_W, height: 200, durationInFrames: 12, previewPath: undefined });
    check(!run.error && run.frames.length === 12 && run.frames.every((b) => b.equals(run.frames[0])),
      `a scroll-driven CSS animation (animation-timeline: scroll()) renders 12 frames, all the same (${run.error?.message ?? `${run.frames.length} frames`})`);
    await leftNothing(run, f, "scroll", "scroll-driven animation");
  }

  // delayRender: the frame is captured only after continueRender.
  {
    const f = fresh(work, "delay");
    const run = await render(f, "delay", { graphic: { source: DELAY_TSX }, durationInFrames: 2 });
    check(!run.error && run.frames.length === 2 && run.frames.every((b) => same(px(b, 10, 10), [0, 255, 0, 255])),
      `a frame waits for delayRender: captured after continueRender, green, not red (${run.error?.message ?? JSON.stringify(run.frames.map((b) => px(b, 10, 10)))})`);
    await leftNothing(run, f, "delay", "delayRender");
  }

  // Props reach the component, which needs no React import (automatic JSX).
  {
    const f = fresh(work, "props");
    const run = await render(f, "props", { graphic: { source: PROPS_TSX, props: { colour: "rgb(10, 20, 250)" } }, durationInFrames: 1 });
    check(!run.error && run.frames.length === 1 && same(px(run.frames[0], 5, 5), [250, 20, 10, 255]), `a graphic without a React import renders, with its props (${run.error?.message ?? JSON.stringify(run.frames[0] && px(run.frames[0], 5, 5))})`);
    await leftNothing(run, f, "props", "props");
  }

  // A failed frame fails the render with its code; frames before it were drawn.
  const failing: [string, string, string, RegExp][] = [
    ["a component that throws", THROWS_AT_2, "graphic_component_error", /^The graphic failed at frame 2: boom at two$/],
    // The runtime's own message, word for word the core's (unsupportedNameMessage), so the agent reads one text whichever side refuses.
    ["a coded runtime error (a name the runtime lacks, read at render time)", `import * as R from "remotion";\nexport default () => { const C = (R as any).Composition; return null; };`, "graphic_api_unsupported", new RegExp(`^The graphic failed at frame 0: ${unsupportedNameMessage("Composition").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)],
    ["staticFile()", `import { Img, staticFile } from "remotion";\nexport default () => <Img src={staticFile("logo.png")} />;`, "graphic_media_ref", /frame 0/],
    ["a code the page may not report", `export default () => { throw Object.assign(new Error("pretend"), { code: "graphic_renderer_unavailable" }); };`, "graphic_component_error", /pretend/],
    ["a module that throws while it loads", `throw new Error("top level");\nexport default () => null;`, "graphic_component_error", /top level/],
    ["no default export", `export const Graphic = () => null;`, "graphic_api_misuse", /default-export a React component/],
    ["an endless animation played backwards, started in a rAF callback", NO_END_TSX, "graphic_component_error", /^The graphic failed at frame 0: .*currentTime/],
  ];
  for (const [i, [what, source, code, message]] of failing.entries()) {
    const f = fresh(work, `fail-${i}`);
    const run = await render(f, `fail-${i}`, { graphic: { source }, durationInFrames: 4 });
    const err = run.error as MotionRenderError | undefined;
    check(err instanceof MotionRenderError && err.code === code && message.test(err.message), `${what}: the render fails with ${code} (${err ? `${(err as MotionRenderError).code}: ${err.message}` : "it succeeded"})`);
    check(readdirSync(join(f.data, "baked")).length === 0, `${what}: nothing in baked/`);
    await leftNothing(run, f, `fail-${i}`, what);
  }
  {
    const f = fresh(work, "fail-early");
    const run = await render(f, "early", { graphic: { source: THROWS_AT_2 }, durationInFrames: 4 });
    check(run.frames.length === 2, `the frames before the failed one were drawn, none after (${run.frames.length})`);
    const empty = await render(f, "empty", { module: "// a page whose graphic never registers", durationInFrames: 2 });
    const err = empty.error as MotionRenderError | undefined;
    check(err?.code === "graphic_component_error" && /did not run/.test(err.message) && empty.frames.length === 0, `a module.js that never hands host.js a graphic fails, not an empty graphic (${err ? `${err.code}: ${err.message}` : "it succeeded"})`);
    await leftNothing(empty, f, "empty", "empty module");
  }

  // Refused before launch: nothing starts, nothing is written.
  const big = { blob: "x".repeat(256 * 1024) };
  const refused: [string, Partial<RenderMotionOptions> & { graphic: NonNullable<RenderMotionOptions["graphic"]> }, (e: Error | undefined) => boolean][] = [
    ["an unknown named import", { graphic: { source: `import { Composition } from "remotion";\nexport default () => null;` } },
      (e) => e instanceof MotionRenderError && e.code === "graphic_api_unsupported" && e.message === unsupportedNameMessage("Composition")],
    ["another package", { graphic: { source: `import _ from "lodash";\nexport default () => null;` } }, (e) => e instanceof MotionRenderError && e.code === "graphic_api_unsupported" && /"lodash"/.test(e.message)],
    ["a syntax error", { graphic: { source: `export default () => <div>;` } }, (e) => e instanceof MotionRenderError && e.code === "graphic_compile_error"],
    ["top-level await (a page script has none)", { graphic: { source: `const x = await Promise.resolve(1);\nexport default () => null;` } }, (e) => e instanceof MotionRenderError && e.code === "graphic_compile_error"],
    ["props over 256 KB", { graphic: { source: PROPS_TSX, props: big } }, (e) => e instanceof RangeError && /256 KB/.test(e.message)],
    ["props that are not a JSON object", { graphic: { source: PROPS_TSX, props: [1, 2] as unknown as Record<string, unknown> } }, (e) => e instanceof TypeError],
  ];
  for (const [i, [what, o, ok]] of refused.entries()) {
    const f = fresh(work, `refused-${i}`);
    const run = await render(f, `refused-${i}`, { ...o, durationInFrames: 2 });
    check(ok(run.error) && run.pids.length === 0 && !existsSync(join(f.data, "motion")) && readdirSync(join(f.data, "baked")).length === 0,
      `${what} is refused before the renderer starts, with nothing written (${run.error ? `${(run.error as MotionRenderError).code ?? run.error.name}: ${run.error.message.slice(0, 160)}` : "it rendered"}; ${run.pids.length} process(es))`);
  }
}

// ---- main -------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--child-render") {
    await childRender(args[1], args[2]);
    summarized = true;
    return;
  }
  // The whole run in a private network namespace (loopback and a dummy interface, nothing
  // routed out), so even a broken guard reaches no real host.
  reexecInNetns(fileURLToPath(import.meta.url), args, LAN);
  // --only=R2,R5 runs those parts alone.
  const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
  const part = (name: string) => !only || only.includes(name);
  const work = mkdtempSync(join(tmpdir(), "zr-motion-smoke-"));
  try {
    if (part("R1")) r1(work);
    if (part("R8")) await r8(work);
    if (!LINUX) {
      skipped("R2-R7, R9", "they read /proc and run Linux's Electron");
    } else {
      if (part("R2")) await r2(work);
      if (part("R3")) await r3(work);
      if (part("R4")) await r4(work);
      if (part("R5")) await r5(work);
      if (part("R6")) await r6(work);
      if (part("R7")) await r7(work);
      if (part("R9")) await r9(work);
    }
    if (part("R10")) await r10(work);
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  }
  summarized = true;
  const failures = failureCount();
  console.log(failures === 0 ? "\nALL MOTION RENDERER CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// The event loop drained before the summary (a promise that never settles): a failure, never exit 0.
process.on("beforeExit", () => {
  if (summarized) return;
  console.log("\nthe smoke ended before its summary");
  process.exit(1);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
