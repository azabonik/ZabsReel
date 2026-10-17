/**
 * ZabsReel's own motion renderer, slice 1: the renderer host (MOTION-PLAN D2,
 * D8 "Launch", "Binary rule", "Renderer" and "Lifecycle"). The pages here are
 * hand-written (no runtime yet).
 *
 *  R1. binary rule  — rendererbinary.ts over fixture layouts for win32, darwin
 *                     and linux, packaged and source checkout (no macOS or
 *                     packaged Windows build runs here, so these rows cover
 *                     them): packaged = process.execPath with only the flag,
 *                     no Electron version = no-binary; source = execPath or
 *                     require("electron") with <repo>/apps/desktop first; no
 *                     main.cjs, or no Electron at all = no-binary.
 *  R2. frames       — the page's clock (Date.now, Date(), new Date(),
 *                     performance.now, the rAF timestamp) is frame / fps;
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
 *
 * Every renderer runs with fresh HOME/USERPROFILE/XDG_CONFIG_HOME and data
 * folders, muted. Ports: 5030-5033 (listeners) and 5036 (the core in R5).
 * On CI (CI=true) R3 fails instead of skipping when there is no namespace.
 * Needs `npm run build` (R5's core start, R6b) and FFmpeg. Linux only beyond
 * R1. On GitHub Actions a skipped part is also written to the step summary.
 * Run: npx tsx packages/motion/scripts/smoke-renderer.ts [--only=R1,R3]
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createSocket } from "node:dgram";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isSourceCheckout } from "../../core/src/addon/resolve.js";
import { RENDERER_FLAG, rendererBinary, type RendererBinary } from "../../core/src/motion/rendererbinary.js";
import {
  MotionRenderError,
  probeMotionRenderer,
  rendererArgs,
  rendererEnv,
  renderMotion,
  type RendererMessage,
  type RenderMotionOptions,
} from "../../core/src/motion/rendermotion.js";

let failures = 0;
/** Set once the run's summary is printed (or the R5 child's render is done). */
let summarized = false;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const DESKTOP = join(REPO, "apps", "desktop");
const CORE_DIST = join(REPO, "packages", "core", "dist");
const ELECTRON = createRequire(join(DESKTOP, "package.json"))("electron") as string;
const NETNS = "ZR_MOTION_SMOKE_NETNS";
const LINUX = process.platform === "linux";
/**
 * What the renderer's environment may hold: D2's allowlist, written out here
 * (not read from RENDERER_ENV, so a name added there fails the rows), with its
 * own temp variables and GTK's in-memory settings.
 */
const ALLOWED_ENV = new Set<string>([
  "PATH", "SystemRoot", "windir", "LANG", "LC_ALL", "HOME", "USERPROFILE", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR",
  "TEMP", "TMP", "TMPDIR", "GSETTINGS_BACKEND",
]);
/** Variables Electron/Chromium set in their own process after start (not from the core). */
const CHROMIUM_ENV = new Set(["CHROME_DESKTOP", "DBUS_SESSION_BUS_ADDRESS", "FC_FONTATIONS"]);
const DESKTOP_MODULES = /[\\/](core-launcher|media-servers|graphics-addon)\.cjs$/;

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

// ---- fresh folders and processes -------------------------------------------------

interface Fresh {
  dir: string;
  home: string;
  data: string;
  /** For a renderer or a core: fresh HOME/USERPROFILE/XDG_CONFIG_HOME and AIVE_DATA_DIR, no display, plus what a core inherits. */
  env: NodeJS.ProcessEnv;
}

let counter = 0;
function fresh(work: string, name: string): Fresh {
  const dir = join(work, `${name}-${++counter}`);
  const home = join(dir, "home");
  const data = join(dir, "data");
  mkdirSync(join(home, ".config"), { recursive: true });
  mkdirSync(join(data, "baked"), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    AIVE_DATA_DIR: data,
    // A core runs with these; the renderer must get none of them.
    ELECTRON_RUN_AS_NODE: "1",
    NODE_OPTIONS: "--max-old-space-size=4096",
    AIVE_SMOKE_SECRET: "core-only",
  };
  return { dir, home, data, env };
}

/** Every file under `dir`, relative, "/"-separated. */
function filesUnder(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, base));
    else out.push(p.slice(base.length + 1).split("\\").join("/"));
  }
  return out;
}

/** Linux: pid -> parent pid, for live processes (zombies left out). */
function processTable(): Map<number, number> {
  const out = new Map<number, number>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] !== "Z") out.set(Number(name), Number(fields[1]));
    } catch {
      /* gone meanwhile */
    }
  }
  return out;
}

function descendants(root: number, table = processTable()): number[] {
  const out: number[] = [];
  const walk = (pid: number) => {
    for (const [child, parent] of table) {
      if (parent === pid) {
        out.push(child);
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

async function gone(pids: number[], ms: number): Promise<number[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const table = processTable();
    const left = pids.filter((p) => table.has(p));
    if (left.length === 0 || Date.now() > deadline) return left;
    await sleep(50);
  }
}

function environNames(pid: number): string[] | null {
  try {
    return readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").filter(Boolean).map((e) => e.slice(0, e.indexOf("=")));
  } catch {
    return null;
  }
}

/** Local TCP ports in LISTEN state (this network namespace). */
function listeningPorts(): number[] {
  const out: number[] = [];
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols[3] === "0A") out.push(parseInt(cols[1].split(":")[1], 16));
    }
  }
  return out;
}

/** Samples, every 20 ms, the processes below `root`: their command lines, their environment's names, and listening ports 5030-5039. */
function watchTree(root: number) {
  const seen = new Map<number, { cmd: string; env: string[] }>();
  const ports = new Set<number>();
  const sample = () => {
    for (const pid of descendants(root)) {
      if (seen.has(pid)) continue;
      let cmd = "";
      try {
        cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
      } catch {
        continue;
      }
      seen.set(pid, { cmd, env: environNames(pid) ?? [] });
    }
    for (const p of listeningPorts()) if (p >= 5030 && p <= 5039) ports.add(p);
  };
  sample();
  const timer = setInterval(sample, 20);
  return {
    stop() {
      clearInterval(timer);
      sample();
      return { seen, ports };
    },
  };
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

/** renderMotion with the run's frames, messages, renderer PID (and its children while it ran) and exit recorded. */
async function render(f: Fresh, id: string, o: Partial<RenderMotionOptions> & { module: string }): Promise<Run> {
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

/** Logs each frame's clock readings: Date.now, new Date(), Date() (to the second), performance.now and the rAF timestamp. */
const CLOCK = `
zrMotion.onFrame((n) => new Promise((resolve) => requestAnimationFrame((t) => {
  zrMotionHost.log("CLOCK " + JSON.stringify({ n, now: Date.now(), date: new Date().getTime(), str: Date.parse(Date()), perf: performance.now(), raf: t }));
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
// performance/rAF row fails.
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
      if (!guard) entries["guard.js"] = "window.__zrMotionClock = { setFrame: function () {} };";
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
  const child = spawn(bin.command, [...bin.args, ...args], { env, stdio: ["pipe", "pipe", "ignore"] });
  let stdout = "";
  child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const code = await new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
  clearTimeout(timer);
  child.stdin?.destroy();
  return { code, stdout };
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
  // Fontconfig's cache (HOME/.cache/fontconfig) is the one file Chromium writes outside, before any JS runs.
  const outside = (home: string) => filesUnder(home).filter((x) => !x.startsWith(".cache/fontconfig/"));
  const n = fresh(work, "noscratch");
  const r = await runRenderer(bin, [`--zr-parent-pid=${process.pid}`, "--mute-audio", ...(LINUX ? ["--ozone-platform=headless"] : []), "--probe"], rendererEnv(n.dir, n.env));
  check(r.code === 2 && outside(n.home).length === 0 && filesUnder(n.data).length === 0 && !existsSync(join(n.dir, "tmp")),
    `no --zr-scratch: exit 2, nothing written (exit ${r.code}; ${JSON.stringify([...outside(n.home), ...filesUnder(n.data)].slice(0, 5))})`);
  const p = fresh(work, "scratch");
  const scratch = join(p.data, "motion", "probe-test");
  mkdirSync(join(scratch, "tmp"), { recursive: true });
  const r2 = await runRenderer(bin, rendererArgs(scratch, 16, 16, ["--probe"]), rendererEnv(scratch, p.env));
  const inHome = outside(p.home);
  const inScratch = filesUnder(scratch);
  check(r2.code === 0 && /"probe":"ok"/.test(r2.stdout), `with --zr-scratch the probe runs (exit ${r2.code})`);
  check(inScratch.some((x) => x.startsWith("profile/")) && inHome.length === 0, `Chromium's profile lands under motion/<id>/profile, nothing in HOME but fontconfig's cache (${inScratch.length} files there; HOME: ${JSON.stringify(inHome.slice(0, 5))})`);
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
  if (LINUX && !process.env[NETNS]) {
    const setup = `ip link set lo up && ip link add zr0 type dummy && ip addr add ${LAN}/24 dev zr0 && ip link set zr0 up`;
    const ns = ["--user", "--map-current-user", "--net", "--keep-caps", "sh", "-c"];
    if (spawnSync("unshare", [...ns, setup], { stdio: "ignore" }).status === 0) {
      const r = spawnSync("unshare", [...ns, `${setup} && exec setpriv --inh-caps=-all --ambient-caps=-all "$0" "$@"`, process.execPath, ...process.execArgv, fileURLToPath(import.meta.url), ...args], {
        stdio: "inherit",
        env: { ...process.env, [NETNS]: "1" },
      });
      process.exit(r.status ?? 1);
    }
  }
  // --only=R2,R5 runs those parts alone.
  const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
  const part = (name: string) => !only || only.includes(name);
  const work = mkdtempSync(join(tmpdir(), "zr-motion-smoke-"));
  try {
    if (part("R1")) r1(work);
    if (!LINUX) {
      skipped("R2-R7", "they read /proc and run Linux's Electron");
    } else {
      if (part("R2")) await r2(work);
      if (part("R3")) await r3(work);
      if (part("R4")) await r4(work);
      if (part("R5")) await r5(work);
      if (part("R6")) await r6(work);
      if (part("R7")) await r7(work);
    }
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  }
  summarized = true;
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
