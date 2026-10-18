/**
 * add_graphic switched over to ZabsReel's own renderer (slice 5; MOTION-PLAN
 * D7, D8 "State" and "Both renderers"; rulings Q5, D-BOTH, D-STATE,
 * D-STORED, I7). Every renderer runs for real, muted, with fresh HOME and
 * data folders, in a private network namespace; fixtures are made here with
 * FFmpeg's lavfi sources.
 *
 *  S1. setting     — <dataDir>/addons/renderer.json: missing, not JSON, an
 *                    array, another value or another case reads "zabsreel";
 *                    "remotion" reads "remotion"; the hosts' writer
 *                    round-trips, leaves no temp file and refuses another
 *                    value. add_graphic follows it on every call, both ways:
 *                    ZabsReel's renderer renders (and the Remotion path is
 *                    not taken), then the Remotion path is taken (and no
 *                    renderer starts), then ZabsReel's renderer again;
 *                    get_state and timeline_summary say graphicsRenderer.
 *  S2. agent tools — every RPC path parameter (so every MCP tool that takes
 *                    a path) refuses renderer.json, its temp names, the add-on
 *                    folder and a link into it, and on an allowed .invalid
 *                    server the name rule refuses addons\renderer.json (and
 *                    its temp names) by text alone; every set_* method given
 *                    a renderer field is refused; afterwards renderer.json's
 *                    bytes and the add-on folder's names are unchanged, the
 *                    core's file calls and the commands it started name no
 *                    zr-evil host, no RPC method is named for the renderer,
 *                    and no core or MCP source but addon/index.ts and
 *                    addon/renderer.ts names writeGraphicsRenderer.
 *  S3. state       — no binary (the binary rule on a packaged core folder
 *                    with no Electron), no display (the real Electron on X11
 *                    without DISPLAY) and an unusable sandbox (the real
 *                    Electron sent to its SUID helper, which is not set up):
 *                    get_state's graphics is "renderer-unavailable" with that
 *                    graphicsReason (timeline_summary too); add_graphic is
 *                    refused with graphic_renderer_unavailable and the same
 *                    reason (in its message and details; over HTTP 409 with
 *                    code and reason), no job, nothing in baked/ or motion/.
 *                    Before the probe ends the state is "ready" (no-binary
 *                    when the rule gives no command) and add_graphic waits
 *                    for it, starting nothing; a render whose renderer fails
 *                    to start (the probe said ok) sets the state.
 *  S4. no spawn    — get_state and timeline_summary, in every state, start no
 *                    process and run no probe.
 *  S5. once a minute — while the renderer is unavailable add_graphic probes
 *                    again only once a minute has passed since the last probe
 *                    (the engine's clock; the real renderer counts its own
 *                    starts); a core that never probed probes on its first
 *                    add_graphic; once the renderer works again, the next
 *                    probe a minute later makes add_graphic render.
 *  S6. both renderers — the title template and every parity composition
 *                    (packages/motion/parity/compositions, no media) through
 *                    add_graphic on ZabsReel's renderer and on the Remotion
 *                    add-on (this checkout's Remotion and its pinned headless
 *                    shell; skipped with a printed reason when the shell is
 *                    missing): each renders at the canvas size and its
 *                    length, except, on the add-on, the compositions
 *                    NOTES.md 9.4 lists as refused by Remotion 4.0.481, which
 *                    must fail there.
 *  S7. add-on refusal — on the Remotion add-on, a component that imports
 *                    @aive/motion (import, export … from, require) or takes
 *                    asset or loadFont from remotion (named, renamed, or off
 *                    a namespace import) is refused naming the setting, with
 *                    no job, nothing written and Remotion untouched; the same
 *                    words in strings and comments, and a type-only import,
 *                    are not; on ZabsReel's renderer the @aive/motion one
 *                    renders.
 *  S8. stored      — a project saved with Remotion-baked graphics (an
 *                    overlay and a card; skipped without the shell) loads and
 *                    exports after the switch to ZabsReel's renderer: no
 *                    renderer starts, the baked files are byte-identical and
 *                    none is added, the overlay keeps its code and props, and
 *                    the export shows the graphic only in its window.
 *  S9. library     — on ZabsReel's renderer add_graphic hands the project
 *                    library over as the asset table: an <Img> of a library
 *                    image shows it; an overlay with <Audio> of a library
 *                    sound gets one linked audio clip over its window (on
 *                    the host's link group); an offline asset is refused with
 *                    media_offline and writes nothing.
 *  S10. text      — the "Where the two renderers differ" list is the same in
 *                    the add-on dialog's help and the agent's guide, and
 *                    SKILL.md names every item; the guide, SKILL.md and
 *                    add_graphic's description say graphics may use library
 *                    media by asset id on ZabsReel's renderer, still no
 *                    network or packages, that an overlay's audio becomes a
 *                    linked audio clip, and that only the user's setting
 *                    decides the renderer.
 *
 * Linux only beyond S1, S2, S4 and S10 (it runs Linux's Electron). Needs `npm run
 * build` (dist/zr-runtime.js) and FFmpeg. Ports: 5034 (S3's HTTP row).
 * Run: npx tsx packages/motion/scripts/smoke-motion-switch.ts [--only=S1,S3]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { graphicsRendererFile, readGraphicsRenderer, writeGraphicsRenderer } from "../../core/src/addon/renderer.js";
import type { GraphicsAddonResolution } from "../../core/src/addon/resolve.js";
import { EditorEngine } from "../../core/src/engine.js";
import { probeAsset } from "../../core/src/ffmpeg/ffprobe.js";
import type { GraphicRemotion } from "../../core/src/motion/render.js";
import { RENDERER_FLAG, rendererBinary, type RendererBinary } from "../../core/src/motion/rendererbinary.js";
import type { ProbeResult } from "../../core/src/motion/rendermotion.js";
import { HEADLESS_SHELL } from "../../core/src/motion/addonlock.js";
import { TITLE_CARD_TSX } from "../../core/src/motion/templates.js";
import { dispatch, methods, RpcError, RPC_PATH_PARAMS } from "../../core/src/rpc.js";
import { EditorServer } from "../../core/src/server.js";
import { approveHost } from "../../core/src/trusthosts.js";
import type { Clip, GraphicOverlay } from "../../core/src/types.js";
import { check, failureCount, filesUnder, fresh, LINUX, reexecInNetns, sleep, type Fresh } from "./smoke-lib.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const EVIL = "zr-evil";
/** The pinned headless shell in this checkout (Remotion's own cache folder, filled from the main checkout), as parity-render.ts uses it. */
const SHELL = join(REPO, "node_modules", ".remotion", "chrome-headless-shell", "linux64", HEADLESS_SHELL.platforms["linux-x64"].executable);
/** The Remotion add-on as this checkout has it: its Remotion, its pinned shell (a missing one fails, nothing is downloaded). */
const REMOTION_ADDON = (): GraphicsAddonResolution => ({ ok: true, root: REPO, browserExecutable: SHELL });
/** The compositions NOTES.md 9.4 lists as refused by the add-on's Remotion 4.0.481 (newer API: strings and booleans, fractional timing, Series rates and offsets). */
const ADDON_REFUSES = new Set(["interpolate-strings.tsx", "sequence-edge-fractional.tsx", "series-edge.tsx"]);

// ---- what the core touches ---------------------------------------------------------

/** The core's file calls (fs/promises and node:fs), "<name> <path>[ <path>]", for those that name a zr-evil host. */
const touched: string[] = [];
/** The commands the core started: [file, ...args]. */
const spawned: string[][] = [];
{
  const load = createRequire(import.meta.url);
  const wrap = (mod: Record<string, unknown>, names: string[]) => {
    for (const name of names) {
      const real = mod[name];
      if (typeof real !== "function" || name === "constants" || /^[A-Z]/.test(name)) continue;
      // Its own properties too (realpathSync.native).
      mod[name] = Object.assign(function (this: unknown, ...args: unknown[]) {
        const paths = args.slice(0, 2).map((a) => (typeof a === "string" ? a : ""));
        if (paths.some((p) => p.includes(EVIL))) touched.push(`${name} ${paths.join(" ")}`);
        return (real as (...a: unknown[]) => unknown).apply(this, args);
      }, real);
    }
  };
  const fsp = load("node:fs/promises") as Record<string, unknown>;
  wrap(fsp, Object.keys(fsp));
  const fs = load("node:fs") as Record<string, unknown>;
  wrap(fs, Object.keys(fs).filter((n) => n.endsWith("Sync") || ["open", "stat", "lstat", "readFile", "writeFile", "mkdir", "rename", "access", "createReadStream", "createWriteStream"].includes(n)));
  const cp = load("node:child_process") as Record<string, (...a: unknown[]) => unknown>;
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "fork", "exec", "execSync"]) {
    const real = cp[name];
    cp[name] = function (this: unknown, ...args: unknown[]) {
      spawned.push([String(args[0]), ...(Array.isArray(args[1]) ? (args[1] as unknown[]).map(String) : [])]);
      return real.apply(this, args);
    };
  }
  syncBuiltinESMExports();
}
/** A renderer start among `cmds` (a render's, or with `probe` a probe's). */
const rendererStarts = (cmds: string[][], probe = false) => cmds.filter((c) => c.includes(RENDERER_FLAG) && c.includes("--probe") === probe).length;

// ---- helpers -----------------------------------------------------------------------

const thrown = async (fn: () => unknown): Promise<Error | null> => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as Error;
  }
};
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const ffmpeg = (args: string[]) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}: ${r.stderr}`);
};
/** One frame of `file` at `t` seconds as RGB24 bytes. */
function frameRgb(file: string, t: number, w: number, h: number): Buffer {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-s", `${w}x${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 1 << 26 });
  return r.stdout;
}
/** Peak luma of one frame at `t`. */
function maxLuma(file: string, t: number): number {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "pipe:1"], { maxBuffer: 1 << 26 });
  let max = 0;
  for (const b of r.stdout) if (b > max) max = b;
  return max;
}

/** An engine on `x`'s data folder whose renderers get `x`'s environment (fresh HOME, no display). */
function engineFor(x: Fresh): EditorEngine {
  const engine = new EditorEngine(x.data);
  engine.motionRenderer.env = x.env;
  engine.setProjectSettings({ width: 320, height: 180, fps: 30 });
  return engine;
}

/** A Remotion that throws on first use: add_graphic reaching it took the add-on path. */
const REMOTION_PATH = "zr-remotion-path";
const remotionPathStub = (): GraphicRemotion =>
  new Proxy({} as GraphicRemotion, {
    get: () => {
      throw new Error(REMOTION_PATH);
    },
  });

/** A shell script `name` in `dir` that runs Electron as the binary rule would, with `extra` appended (and counts its starts in `count`). */
function wrapper(dir: string, name: string, extra: string[], count?: string): RendererBinary {
  const base = rendererBinary();
  if (!base.ok) throw new Error(`no renderer binary in this checkout: ${base.detail}`);
  const file = join(dir, name);
  const counting = count ? `echo start >> '${count}'\n` : "";
  writeFileSync(file, `#!/bin/sh\n${counting}exec '${base.command}' "$@" ${extra.join(" ")}\n`);
  chmodSync(file, 0o755);
  return { ...base, command: file };
}

// 30 frames: the title fades in over 10 and out over 14.
const SMALL_CARD = { code: TITLE_CARD_TSX, durationSeconds: 1 };
const errCode = (e: Error | null) => (e instanceof RpcError ? e.code : e ? e.message.slice(0, 120) : "ok");
const graphicJobs = (engine: EditorEngine) => engine.jobs.list(false).filter((j) => j.type === "graphic").length;

// ---- S1: the setting ---------------------------------------------------------------

// MUTATION: readGraphicsRenderer returns "remotion" for a missing file (addon/renderer.ts) → the default rows
// fail. Make graphicsRenderer() always "zabsreel" (engine.ts) → the Remotion-path row fails. Read the setting
// once at engine start (cache it in graphicsRenderer) → the switch-back rows fail.
async function s1(work: string) {
  console.log("S1. the renderer setting decides add_graphic's path, both ways...");
  const x = fresh(work, "s1");
  const file = graphicsRendererFile(x.data);
  check(readGraphicsRenderer(x.data) === "zabsreel", "no renderer.json: zabsreel (the default)");
  mkdirSync(dirname(file), { recursive: true });
  for (const [what, text] of [["not JSON", "{"], ["an array", '["remotion"]'], ["another value", '{"renderer":"remotion-addon"}'], ["another case", '{"renderer":"Remotion"}'], ["empty", ""]] as const) {
    writeFileSync(file, text);
    check(readGraphicsRenderer(x.data) === "zabsreel", `renderer.json ${what}: zabsreel`);
  }
  writeFileSync(file, '{"renderer":"remotion"}');
  check(readGraphicsRenderer(x.data) === "remotion", 'renderer.json {"renderer":"remotion"}: remotion');
  await writeGraphicsRenderer(x.data, "zabsreel");
  check(readGraphicsRenderer(x.data) === "zabsreel" && JSON.stringify(readdirSync(dirname(file))) === '["renderer.json"]',
    `the hosts' writer: zabsreel, and no temp file left (${JSON.stringify(readdirSync(dirname(file)))})`);
  const bad = await thrown(() => writeGraphicsRenderer(x.data, "chrome" as never));
  check(!!bad && readGraphicsRenderer(x.data) === "zabsreel", `the writer refuses another value (${bad?.message})`);
  rmSync(file);

  if (!LINUX) return console.log("  skip the add_graphic rows: they run Linux's Electron");
  const engine = engineFor(x);
  engine.graphicsAddon = () => ({ ok: true, root: join(x.dir, "no-remotion") });
  engine.graphicRemotion = remotionPathStub();
  const run = async () => {
    const mark = spawned.length;
    const e = await thrown(() => engine.addGraphic(undefined, SMALL_CARD));
    return { how: e ? e.message : "rendered", renders: rendererStarts(spawned.slice(mark)) };
  };
  const state = async () => ((await dispatch(engine, "get_state", {})) as { graphicsRenderer: string }).graphicsRenderer;
  const summary = async () => ((await dispatch(engine, "timeline_summary", {})) as { graphicsRenderer: string }).graphicsRenderer;
  const r1 = await run();
  check(r1.how === "rendered" && r1.renders === 1 && (await state()) === "zabsreel" && (await summary()) === "zabsreel",
    `no setting: ZabsReel's renderer renders it, the Remotion path untouched (${JSON.stringify(r1)}; get_state ${await state()})`);
  await writeGraphicsRenderer(x.data, "remotion");
  const r2 = await run();
  check(r2.how === REMOTION_PATH && r2.renders === 0 && (await state()) === "remotion" && (await summary()) === "remotion",
    `"remotion": the next add_graphic takes the Remotion path and starts no renderer (${JSON.stringify(r2)}; get_state ${await state()})`);
  await writeGraphicsRenderer(x.data, "zabsreel");
  const r3 = await run();
  check(r3.how === "rendered" && r3.renders === 1 && (await state()) === "zabsreel", `"zabsreel" again: ZabsReel's renderer again (${JSON.stringify(r3)})`);
  writeFileSync(file, '{"renderer":"remotion"}');
  const r4 = await run();
  check(r4.how === REMOTION_PATH && r4.renders === 0, `renderer.json changed on disk between calls: read again (${JSON.stringify(r4)})`);
}

// ---- S2: agent tools can't write it ------------------------------------------------

// MUTATION: drop the addons area from HostTrust.areas (hosttrust.ts) → the local rows fail. Drop renderer\.json
// from ADDON_NAME (hosttrust.ts) → the allowed-server rows fail. Import writeGraphicsRenderer into rpc.ts → the
// source row fails.
async function s2(work: string) {
  console.log("S2. no agent tool can write renderer.json...");
  const x = fresh(work, "s2");
  const engine = engineFor(x);
  await writeGraphicsRenderer(x.data, "remotion");
  const addons = join(x.data, "addons");
  const file = graphicsRendererFile(x.data);
  const before = { sha: sha(file), names: JSON.stringify(readdirSync(addons).sort()) };
  const link = join(x.dir, "addons-link");
  symlinkSync(addons, link, "dir");
  const AREA = /is in ZabsReel's graphics add-on folder, which tools can't open\./;
  const minimal = (schema: unknown): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((schema as { shape: Record<string, { isOptional(): boolean; _def: { typeName: string } }> }).shape)) {
      if (v.isOptional()) continue;
      out[k] = v._def.typeName === "ZodNumber" ? 0 : v._def.typeName === "ZodArray" ? [] : k === "text" ? "t" : "clip_none";
    }
    return out;
  };
  const local = [file, `${file}.0a1b2c3d4e5f.tmp`, addons, join(link, "renderer.json")];
  const cwd = process.cwd();
  // A backslash path that slips through (a mutation) is a relative name in this folder, never the worktree.
  const slip = join(x.dir, "cwd");
  mkdirSync(slip);
  process.chdir(slip);
  const ALIAS = `${EVIL}-alias.invalid`;
  const S = `\\\\${ALIAS}\\share`;
  const network = [`${S}\\x\\addons\\renderer.json`, `${S}\\addons\\Renderer.JSON`, `${S}\\addons\\renderer.json.0a1b2c.tmp`, `//${ALIAS}/share/addons/renderer.json`];
  const trust = (engine as unknown as { trust: { reload(): void } }).trust;
  await approveHost(engine.dataDir, ALIAS, "prompt");
  trust.reload();
  touched.length = 0;
  const spawnedBefore = spawned.length;
  let rows = 0;
  let refused = 0;
  const bad: string[] = [];
  try {
    for (const [m, ps] of Object.entries(RPC_PATH_PARAMS)) {
      for (const p of ps) {
        const key = p.replace("[]", "");
        for (const path of [...local, ...network]) {
          rows++;
          const params = { ...minimal(methods[m as keyof typeof methods].schema), [key]: p.endsWith("[]") ? [path] : path };
          if (m === "remember_projects") {
            const r = (await dispatch(engine, m, params)) as { added: unknown[]; skipped: { reason: string }[] };
            if (r.added.length === 0 && r.skipped.length === 1 && /graphics add-on folder/.test(r.skipped[0].reason)) refused++;
            else bad.push(`${m} ${path}: ${JSON.stringify(r)}`);
            continue;
          }
          const e = await thrown(() => dispatch(engine, m, params));
          if (e && AREA.test(e.message)) refused++;
          else bad.push(`${m}.${p} ${path}: ${e?.message.slice(-100) ?? "accepted"}`);
        }
      }
    }
  } finally {
    process.chdir(cwd);
  }
  check(rows > 50 && refused === rows, `every RPC path parameter refuses renderer.json, its temp names, the add-on folder, a link into it, and addons\\renderer.json on an allowed server, with the add-on folder's message (${refused}/${rows}${bad.length ? `; ${bad.slice(0, 3).join(" | ")}` : ""})`);
  // The settings tools: a renderer field is no setting of theirs.
  const setters = Object.keys(methods).filter((m) => m.startsWith("set_"));
  const accepted: string[] = [];
  for (const m of setters) {
    for (const extra of [{ renderer: "zabsreel" }, { graphicsRenderer: "zabsreel" }]) {
      const e = await thrown(() => dispatch(engine, m, { ...minimal(methods[m as keyof typeof methods].schema), ...extra }));
      if (!(e instanceof RpcError && e.code === "invalid_params")) accepted.push(`${m} ${Object.keys(extra)[0]}: ${errCode(e)}`);
    }
  }
  check(setters.length >= 15 && accepted.length === 0, `all ${setters.length} set_* methods refuse a renderer or graphicsRenderer field as invalid params (${accepted.slice(0, 3).join(" | ")})`);
  check(sha(file) === before.sha && JSON.stringify(readdirSync(addons).sort()) === before.names && readGraphicsRenderer(x.data) === "remotion" && readdirSync(slip).length === 0,
    `afterwards renderer.json's bytes, the add-on folder's names and the setting are unchanged, nothing landed in the working folder (${JSON.stringify(readdirSync(addons))})`);
  check(touched.length === 0 && !spawned.slice(spawnedBefore).some((c) => c.join(" ").includes(EVIL)), `the core's file calls and commands name no ${EVIL} host (${touched.slice(0, 3).join(" | ")})`);
  const named = Object.keys(methods).filter((m) => /renderer/i.test(m));
  check(named.length === 0, `no RPC method (so no MCP tool) is named for the renderer (${JSON.stringify(named)})`);
  const listTs = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listTs(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
  const sources = [join(REPO, "packages", "core", "src"), join(REPO, "packages", "mcp", "src")].flatMap(listTs);
  const allowed = new Set(["addon/index.ts", "addon/renderer.ts"].map((f) => join(REPO, "packages", "core", "src", ...f.split("/"))));
  const namers = sources.filter((f) => !allowed.has(f) && /\bwriteGraphicsRenderer\b/.test(readFileSync(f, "utf8")));
  check(sources.length > 50 && namers.length === 0, `no core or MCP source but addon/index.ts and addon/renderer.ts names writeGraphicsRenderer (${sources.length} files; ${JSON.stringify(namers.map((f) => f.slice(REPO.length)))})`);
}

// ---- S3: renderer-unavailable --------------------------------------------------------

interface StateView {
  graphics: string;
  graphicsReason?: string;
  graphicsRenderer: string;
}
/** get_state's or timeline_summary's graphics fields. */
const view = (r: unknown): StateView => {
  const { graphics, graphicsReason, graphicsRenderer } = r as StateView;
  return { graphics, graphicsReason, graphicsRenderer };
};
const stateOf = async (engine: EditorEngine) => view(await dispatch(engine, "get_state", {}));
const summaryOf = async (engine: EditorEngine) => view(await dispatch(engine, "timeline_summary", {}));

/** A packaged core folder (no src/) and no Electron: the binary rule's own no-binary. */
function noBinary(dir: string): RendererBinary {
  const core = join(dir, "packaged", "resources", "app", "node_modules", "@aive", "core");
  mkdirSync(join(core, "dist"), { recursive: true });
  writeFileSync(join(core, "package.json"), JSON.stringify({ name: "@aive/core" }));
  writeFileSync(join(core, "dist", "cli.js"), "");
  return rendererBinary({ from: join(core, "dist", "cli.js"), electronVersion: undefined });
}

// MUTATION: report graphicsState() "ready" whatever the probe said (engine.ts) → the state rows fail. Drop
// graphic_renderer_unavailable from server.ts FORWARDED_CODES → the HTTP row fails. Run add_graphic's job before
// motionReady() (engine.ts) → the "no job" rows fail. Drop the early-exit classification in renderFrames
// (rendermotion.ts) → the failed-start row fails.
async function s3(work: string) {
  console.log("S3. no binary, no display and an unusable sandbox: renderer-unavailable...");
  const cases: [string, (dir: string) => RendererBinary][] = [
    ["no-binary", noBinary],
    ["no-display", (dir) => wrapper(dir, "x11-electron", ["--ozone-platform=x11"])],
    ["sandbox-unavailable", (dir) => wrapper(dir, "suid-electron", ["--disable-namespace-sandbox"])],
  ];
  for (const [reason, make] of cases) {
    const x = fresh(work, `s3-${reason}`);
    const bin = make(x.dir);
    const engine = engineFor(x);
    engine.motionRenderer.binary = () => bin;
    const early = await stateOf(engine);
    const wantEarly = reason === "no-binary" ? "renderer-unavailable" : "ready";
    check(early.graphics === wantEarly && early.graphicsRenderer === "zabsreel" && (reason !== "no-binary" || early.graphicsReason === "no-binary"),
      `${reason}: before the probe, get_state says ${wantEarly}${reason === "no-binary" ? " (no-binary: the rule gave no command)" : " (the rule gave a command)"} (${JSON.stringify(early)})`);
    const mark = spawned.length;
    await engine.startGraphicsProbe();
    const s = await stateOf(engine);
    const t = await summaryOf(engine);
    check(s.graphics === "renderer-unavailable" && s.graphicsReason === reason && t.graphics === s.graphics && t.graphicsReason === reason,
      `${reason}: after the probe get_state and timeline_summary say renderer-unavailable, ${reason} (${JSON.stringify(s)}; probe starts ${rendererStarts(spawned.slice(mark), true)})`);
    const e = await thrown(() => dispatch(engine, "add_graphic", { template: "title", durationSeconds: 0.2 }));
    const details = e instanceof RpcError ? e.details : {};
    check(e instanceof RpcError && e.code === "graphic_renderer_unavailable" && details.reason === reason && e.message.includes(`(${reason}: `),
      `${reason}: add_graphic is refused with graphic_renderer_unavailable, the same reason in its details and message (${errCode(e)}; ${JSON.stringify(details)}; ${e?.message.slice(0, 140)})`);
    check(graphicJobs(engine) === 0 && filesUnder(join(x.data, "baked")).length === 0 && filesUnder(join(x.data, "motion")).length === 0 && engine.getProject().assets.length === 0,
      `${reason}: no job, nothing in baked/ or motion/, no asset (${filesUnder(x.data).join(", ")})`);
    if (reason === "no-binary") {
      // Over the core's HTTP RPC (as the MCP server sends it): 409 with the code and the reason.
      const server = new EditorServer(engine, { port: 5034, dataDir: x.data });
      const port = await server.start();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-aive-token": server.getToken() },
          body: JSON.stringify({ method: "add_graphic", params: { template: "title", durationSeconds: 0.2 } }),
        });
        const body = (await res.json()) as { code?: string; reason?: string; error?: string };
        check(res.status === 409 && body.code === "graphic_renderer_unavailable" && body.reason === "no-binary",
          `no-binary over HTTP /rpc: ${res.status} ${body.code} ${body.reason}`);
      } finally {
        await server.stop();
      }
    }
  }

  // Before the probe ends: "ready", and add_graphic waits for it, starting nothing.
  {
    const x = fresh(work, "s3-wait");
    const engine = engineFor(x);
    let release!: (r: ProbeResult) => void;
    let probes = 0;
    engine.motionRenderer.probe = () => {
      probes++;
      return new Promise<ProbeResult>((r) => (release = r));
    };
    void engine.startGraphicsProbe();
    const during = await stateOf(engine);
    const mark = spawned.length;
    let settled: Error | "rendered" | null = null;
    const pending = engine.addGraphic(undefined, SMALL_CARD).then(() => (settled = "rendered"), (e: Error) => (settled = e));
    await sleep(500);
    check(during.graphics === "ready" && settled === null && graphicJobs(engine) === 0 && rendererStarts(spawned.slice(mark)) === 0 && probes === 1,
      `while the probe runs: get_state "ready", add_graphic waits for it (no job, no renderer, one probe) (${JSON.stringify(during)}; ${String(settled)})`);
    release({ ok: false, reason: "sandbox-unavailable", detail: "zr-held probe" });
    await pending;
    const e = settled as Error | "rendered" | null;
    check(e instanceof Error && (e as { code?: string }).code === "graphic_renderer_unavailable" && e.message.includes("(sandbox-unavailable: zr-held probe)") && graphicJobs(engine) === 0,
      `…then refused with the probe's reason (${e instanceof Error ? e.message.slice(0, 100) : String(e)})`);
  }

  // A render whose renderer fails to start, after a probe that said ok: the state follows it.
  {
    const x = fresh(work, "s3-start");
    const engine = engineFor(x);
    engine.motionRenderer.binary = () => wrapper(x.dir, "suid-electron", ["--disable-namespace-sandbox"]);
    engine.motionRenderer.probe = async () => ({ ok: true, report: { probe: "ok" } });
    await engine.startGraphicsProbe();
    const before = await stateOf(engine);
    const e = await thrown(() => engine.addGraphic(undefined, SMALL_CARD));
    const after = await stateOf(engine);
    check(before.graphics === "ready" && (e as { code?: string } | null)?.code === "graphic_renderer_unavailable" && (e as { reason?: string }).reason === "sandbox-unavailable"
      && after.graphics === "renderer-unavailable" && after.graphicsReason === "sandbox-unavailable" && filesUnder(join(x.data, "baked")).length === 0,
      `a render whose renderer can't start (no usable sandbox) sets the state: ${before.graphics} → ${after.graphics} ${after.graphicsReason} (${e?.message.slice(0, 120)})`);
  }
}

// ---- S4: get_state never spawns --------------------------------------------------------

// MUTATION: make graphicsState() call startGraphicsProbe() when nothing is cached (engine.ts) → the never-probed
// row fails. Call this.motionRenderer.binary() on every graphicsState() and let it spawn → the spawn count fails.
async function s4(work: string) {
  console.log("S4. get_state and timeline_summary start no process...");
  const x = fresh(work, "s4");
  const engine = engineFor(x);
  let probes = 0;
  let answer: ProbeResult = { ok: false, reason: "no-display", detail: "zr-stub" };
  engine.motionRenderer.probe = async () => {
    probes++;
    return answer;
  };
  const sweep = async (what: string) => {
    const mark = spawned.length;
    const p = probes;
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add((await stateOf(engine)).graphics);
      seen.add((await summaryOf(engine)).graphics);
    }
    check(spawned.length === mark && probes === p, `${what}: 100 get_state/timeline_summary calls start no process and no probe (${spawned.length - mark} spawns, ${probes - p} probes; ${[...seen].join(",")})`);
  };
  await sweep("never probed");
  await engine.startGraphicsProbe();
  await sweep("renderer-unavailable");
  answer = { ok: true, report: { probe: "ok" } };
  await engine.startGraphicsProbe();
  await sweep("ready");
  await writeGraphicsRenderer(x.data, "remotion");
  await sweep("the Remotion add-on");
}

// ---- S5: once a minute -------------------------------------------------------------------

// MUTATION: drop the minute from motionReady() (probe again on every refused add_graphic, engine.ts) → the
// count rows fail. Never probe again once unavailable → the "back" row fails.
async function s5(work: string) {
  console.log("S5. while unavailable, add_graphic probes again at most once a minute...");
  const x = fresh(work, "s5");
  const count = join(x.dir, "starts.txt");
  const starts = () => (existsSync(count) ? readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0);
  let bin = wrapper(x.dir, "electron-counted", ["--disable-namespace-sandbox"], count);
  const engine = engineFor(x);
  engine.motionRenderer.binary = () => bin;
  let now = 1_000_000;
  engine.motionRenderer.now = () => now;
  // A core that never probed: its first add_graphic runs the probe.
  const first = await thrown(() => engine.addGraphic(undefined, SMALL_CARD));
  check(starts() === 1 && (first as { reason?: string } | null)?.reason === "sandbox-unavailable", `a core that never probed: the first add_graphic probes once and is refused (${starts()} starts; ${first?.message.slice(0, 80)})`);
  const at = async (dt: number) => {
    now = 1_000_000 + dt;
    const e = await thrown(() => engine.addGraphic(undefined, SMALL_CARD));
    return { starts: starts(), code: (e as { code?: string } | null)?.code ?? "rendered" };
  };
  const rows: [number, number][] = [[0, 1], [1_000, 1], [30_000, 1], [59_999, 1], [60_000, 2], [61_000, 2], [119_999, 2]];
  for (const [dt, want] of rows) {
    const r = await at(dt);
    check(r.starts === want && r.code === "graphic_renderer_unavailable", `add_graphic ${dt / 1000} s after the first probe: ${want} probe start(s), refused (${JSON.stringify(r)})`);
  }
  // The renderer works again: the probe a minute after the last one finds it, and add_graphic renders.
  bin = wrapper(x.dir, "electron-counted", [], count);
  const r = await at(120_000);
  check(r.starts === 4 && r.code === "rendered" && (await stateOf(engine)).graphics === "ready", `back: the probe at 120 s finds it working and add_graphic renders (${JSON.stringify(r)}; probe + render = 2 more starts)`);
}

// ---- S6: the title template and the parity set on both renderers ------------------------------

interface Case {
  name: string;
  source: string;
  frames: number;
}
function cases(): Case[] {
  const dir = join(REPO, "packages", "motion", "parity", "compositions");
  const out: Case[] = [{ name: "title template", source: TITLE_CARD_TSX, frames: 45 }];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".tsx")).sort()) {
    const source = readFileSync(join(dir, f), "utf8");
    const frames = Number(/^\/\/ durationInFrames: (\d+)$/m.exec(source)?.[1]);
    if (!(frames > 0) || !/^\/\/ fps: 30$/m.test(source)) throw new Error(`${f}: a header of fps 30 and a durationInFrames is expected`);
    out.push({ name: f, source, frames });
  }
  return out;
}

// MUTATION: render the Remotion path for ZabsReel's renderer too (graphicsRenderer() always "remotion") → the
// three compositions the add-on refuses fail the ZabsReel rows. Drop one of ADDON_REFUSES's names → its add-on row
// fails (the composition does not render there).
async function s6(work: string) {
  console.log("S6. the title template and the parity set through add_graphic on both renderers...");
  const all = cases();
  check(all.length === 30, `the title template and ${all.length - 1} parity compositions`);
  const renderers: ["zabsreel" | "remotion", string][] = [["zabsreel", "ZabsReel's renderer"], ["remotion", "the Remotion add-on"]];
  for (const [renderer, label] of renderers) {
    if (renderer === "remotion" && !existsSync(SHELL)) {
      console.log(`  skip the Remotion add-on rows: the pinned headless shell is missing (${SHELL})`);
      continue;
    }
    const x = fresh(work, `s6-${renderer}`);
    const engine = engineFor(x);
    if (renderer === "remotion") {
      await writeGraphicsRenderer(x.data, "remotion");
      engine.graphicsAddon = REMOTION_ADDON;
    }
    const failed: string[] = [];
    const refusedOk: string[] = [];
    const t0 = Date.now();
    for (const c of all) {
      await dispatch(engine, "new_project", {});
      engine.setProjectSettings({ width: 320, height: 180, fps: 30 });
      const e = await thrown(async () => {
        const r = (await dispatch(engine, "add_graphic", { code: c.source, durationSeconds: c.frames / 30 })) as { assetId: string };
        const a = engine.getProject().assets.find((x) => x.id === r.assetId)!;
        const probed = await probeAsset(a.path);
        if (probed.width !== 320 || probed.height !== 180 || Math.abs(probed.duration * 30 - c.frames) > 1.5) throw new Error(`size ${probed.width}x${probed.height}, ${(probed.duration * 30).toFixed(1)} frames`);
      });
      const refuses = renderer === "remotion" && ADDON_REFUSES.has(c.name);
      if (refuses && e) refusedOk.push(c.name);
      else if (refuses) failed.push(`${c.name}: rendered on the add-on`);
      else if (e) failed.push(`${c.name}: ${e.message.split("\n")[0].slice(0, 160)}`);
    }
    const want = renderer === "remotion" ? all.length - ADDON_REFUSES.size : all.length;
    check(failed.length === 0, `${label}: ${want} of ${all.length} render at 320x180 and their length${renderer === "remotion" ? `, and the ${ADDON_REFUSES.size} NOTES.md 9.4 lists fail (${refusedOk.join(", ")})` : ""} in ${((Date.now() - t0) / 1000).toFixed(0)} s${failed.length ? `: ${failed.join(" | ")}` : ""}`);
  }
}

// ---- S7: @aive/motion on the add-on path ---------------------------------------------------

// MUTATION: drop the motionOnlyUse() refusal from addGraphic (engine.ts) → every refusal row fails. Treat a
// name token anywhere as a use (scan the raw text) → the control rows fail.
async function s7(work: string) {
  console.log("S7. on the Remotion add-on, a graphic that needs ZabsReel's renderer is refused naming the setting...");
  const x = fresh(work, "s7");
  const engine = engineFor(x);
  await writeGraphicsRenderer(x.data, "remotion");
  engine.graphicsAddon = () => ({ ok: true, root: join(x.dir, "no-remotion") });
  engine.graphicRemotion = remotionPathStub();
  const refused: [string, string, string][] = [
    ["an @aive/motion import", 'import { AbsoluteFill } from "@aive/motion";\nexport default () => <AbsoluteFill />;', "@aive/motion"],
    ["asset from remotion", 'import { AbsoluteFill, Img, asset } from "remotion";\nexport default () => <AbsoluteFill><Img src={asset("asset_x")} /></AbsoluteFill>;', "asset()"],
    ["loadFont renamed", 'import { loadFont as lf } from "remotion";\nlf("asset_x");\nexport default () => null;', "loadFont()"],
    ["a namespace's loadFont", 'import * as R from "remotion";\nexport default () => { R.loadFont(R.staticFile("x")); return null; };', "loadFont()"],
    ["export from @aive/motion", 'export { AbsoluteFill } from "@aive/motion";\nexport default () => null;', "@aive/motion"],
    ["require of @aive/motion", 'const m = require("@aive/motion");\nexport default () => m.AbsoluteFill;', "@aive/motion"],
  ];
  for (const [what, code, names] of refused) {
    const e = await thrown(() => dispatch(engine, "add_graphic", { code, durationSeconds: 0.2 }));
    const msg = e?.message ?? "";
    check(!!e && msg.includes(`This graphic uses ${names}`) && msg.includes('the user\'s graphics renderer setting is "Remotion add-on"') && msg.includes("Help → Graphics add-on…") && !msg.includes(REMOTION_PATH)
      && graphicJobs(engine) === 0 && filesUnder(join(x.data, "baked")).length === 0 && !existsSync(join(x.data, "motion")),
      `${what}: refused naming the setting, before Remotion, no job, nothing written (${msg.slice(0, 120)})`);
  }
  const controls: [string, string][] = [
    ["the words in a string and a comment", 'import { AbsoluteFill } from "remotion";\n// asset() loadFont() @aive/motion\nconst s = "asset(\\"x\\") loadFont @aive/motion";\nexport default () => <AbsoluteFill>{s}</AbsoluteFill>;'],
    ["a type-only import", 'import type { Foo } from "@aive/motion";\nimport { AbsoluteFill } from "remotion";\nexport default () => <AbsoluteFill />;'],
    ["a local function named asset", 'import { AbsoluteFill } from "remotion";\nconst asset = (s: string) => s;\nexport default () => <AbsoluteFill>{asset("x")}</AbsoluteFill>;'],
  ];
  for (const [what, code] of controls) {
    const e = await thrown(() => dispatch(engine, "add_graphic", { code, durationSeconds: 0.2 }));
    check(e?.message === REMOTION_PATH, `${what}: not refused, it reaches Remotion (${e?.message.slice(0, 100)})`);
  }
  if (!LINUX) return console.log("  skip the ZabsReel row: it runs Linux's Electron");
  await writeGraphicsRenderer(x.data, "zabsreel");
  const r = await thrown(() => dispatch(engine, "add_graphic", { code: refused[0][1], durationSeconds: 0.2 }));
  check(r === null, `on ZabsReel's renderer the @aive/motion graphic renders (${r?.message.slice(0, 100)})`);
}

// ---- S8: stored graphics -----------------------------------------------------------------

// MUTATION: make load() re-render a loaded overlay through add_graphic (engine.ts) → the no-renderer and
// byte-identical rows fail.
async function s8(work: string, host: string) {
  console.log("S8. a project with Remotion-baked graphics after the switch to ZabsReel's renderer...");
  if (!existsSync(SHELL)) return console.log(`  skip: the pinned headless shell is missing (${SHELL})`);
  const x = fresh(work, "s8");
  const engine = engineFor(x);
  // Big enough for the title's text to reach a peak luma above 200.
  engine.setProjectSettings({ width: 640, height: 360 });
  await writeGraphicsRenderer(x.data, "remotion");
  engine.graphicsAddon = REMOTION_ADDON;
  const asset = await engine.importVideo(host);
  const clip = engine.appendClip(asset.id);
  const props = { title: "Stored", subtitle: "graphic", accent: "#33ccff" };
  const overlay = await engine.addGraphic(clip.id, { code: TITLE_CARD_TSX, props, startFrame: 30, endFrame: 90 });
  await engine.addGraphic(undefined, { code: TITLE_CARD_TSX, durationSeconds: 1 });
  const project = join(x.dir, "stored.aive");
  await dispatch(engine, "save_project", { path: project });
  const baked = join(x.data, "baked");
  const hashes = () => Object.fromEntries(filesUnder(baked).filter((f) => !f.startsWith(".trash/")).map((f) => [f, sha(join(baked, f))]));
  const before = hashes();
  check(Object.keys(before).some((f) => f.endsWith("-graphic.mov")) && Object.keys(before).some((f) => f.endsWith("-graphic.mp4")) && Object.keys(before).some((f) => f.endsWith("-graphic.webm")),
    `Remotion baked an overlay (.mov, .webm preview) and a card (.mp4): ${Object.keys(before).join(", ")}`);

  await writeGraphicsRenderer(x.data, "zabsreel");
  const later = engineFor(x);
  const mark = spawned.length;
  await dispatch(later, "load_project", { path: project });
  const loaded = later.getProject().tracks.flatMap((t) => t.clips).flatMap((c: Clip) => c.graphics ?? []) as GraphicOverlay[];
  check(loaded.length === 1 && loaded[0].id === overlay.graphic!.id && loaded[0].code === TITLE_CARD_TSX && JSON.stringify(loaded[0].props) === JSON.stringify(props) && loaded[0].assetId === overlay.asset.id,
    `loaded on ZabsReel's renderer: the overlay keeps its code, props and baked asset (${JSON.stringify(loaded.map((g) => ({ id: g.id, assetId: g.assetId })))})`);
  const out = join(x.dir, "out.mp4");
  await later.exportVideo(out);
  const during = maxLuma(out, 2.0);
  const outside = maxLuma(out, 0.5);
  const card = maxLuma(out, 4.45);
  check(during > 200 && outside < 130 && card > 200, `the export shows the overlay in its window only and the card after the clip (peak luma ${outside} before, ${during} during, card ${card})`);
  check(rendererStarts(spawned.slice(mark)) === 0 && rendererStarts(spawned.slice(mark), true) === 0, "no renderer started to load or export it (nothing re-renders)");
  const after = hashes();
  check(JSON.stringify(after) === JSON.stringify(before), `baked/ is byte-identical, no file added or changed (${Object.keys(after).length} files)`);
}

// ---- S9: the project library -----------------------------------------------------------------

// MUTATION: pass no assets to renderMotion from addMotionGraphicRun (engine.ts) → the image and audio rows fail
// (graphic_asset_unknown). Pass requireOnline instead of the engine's own check → still media_offline (the engine's
// adds the server re-check; the row guards the refusal). Call attachGraphic without the sound → the audio row fails.
async function s9(work: string, fx: { host: string; red: string; tone: string }) {
  console.log("S9. ZabsReel's renderer takes the project library as the asset table...");
  const x = fresh(work, "s9");
  const engine = engineFor(x);
  const host = await engine.importVideo(fx.host);
  const red = await engine.importVideo(fx.red);
  const tone = await engine.importVideo(fx.tone);
  const clip = engine.appendClip(host.id);

  const img = `import { AbsoluteFill, Img, asset } from "remotion";
export default () => (
  <AbsoluteFill style={{ background: "black" }}>
    <Img src={asset("${red.id}")} style={{ position: "absolute", left: 0, top: 0, width: 160, height: 180 }} />
  </AbsoluteFill>
);`;
  let card: { assetId: string } | null = null;
  const ce = await thrown(async () => (card = (await dispatch(engine, "add_graphic", { code: img, durationSeconds: 0.2 })) as { assetId: string }));
  const file = card ? engine.getProject().assets.find((a) => a.id === card!.assetId)!.path : "";
  const px = file ? frameRgb(file, 0, 320, 180) : Buffer.alloc(320 * 180 * 3);
  const at = (x0: number, y0: number) => [...px.subarray((y0 * 320 + x0) * 3, (y0 * 320 + x0) * 3 + 3)];
  const left = at(80, 90);
  const right = at(240, 90);
  check(!ce && left[0] > 180 && left[1] < 70 && left[2] < 70 && right.every((c) => c < 40), `an <Img> of the library's image shows it: left ${left}, right ${right} (${ce?.message.slice(0, 100) ?? "rendered"})`);

  const sound = `import { AbsoluteFill, Audio, asset } from "remotion";
export default () => (
  <AbsoluteFill>
    <Audio src={asset("${tone.id}")} />
  </AbsoluteFill>
);`;
  let r: { graphicId?: string } = {};
  const se = await thrown(async () => (r = (await dispatch(engine, "add_graphic", { clipId: clip.id, code: sound, startFrame: 30, endFrame: 90 })) as { graphicId: string }));
  const now = engine.getProject();
  const hostNow = now.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)!;
  const g = hostNow.graphics?.find((x) => x.id === r.graphicId);
  const audioTrack = now.tracks.find((t) => t.kind === "audio" && t.clips.some((c) => c.id === g?.audioClipId));
  const ac = audioTrack?.clips.find((c) => c.id === g?.audioClipId);
  const acAsset = ac && now.assets.find((a) => a.id === ac.assetId);
  check(!!g && !!ac && ac.startFrame === hostNow.startFrame + 30 && ac.sourceOutFrame - ac.sourceInFrame === 60 && !!hostNow.linkGroupId && ac.linkGroupId === hostNow.linkGroupId
    && !!acAsset && acAsset.hasAudio && !acAsset.hasVideo && acAsset.name === "Motion graphic sound" && audioTrack!.clips.filter((c) => c.assetId === ac.assetId).length === 1,
    `an overlay with <Audio> of a library sound gets one linked audio clip over its window (${JSON.stringify(ac && { start: ac.startFrame, in: ac.sourceInFrame, out: ac.sourceOutFrame, link: ac.linkGroupId === hostNow.linkGroupId })}${se ? `; ${se.message.slice(0, 100)}` : ""})`);

  // An offline library asset: the engine's own check refuses it when the page asks for it.
  const bakedBefore = filesUnder(join(x.data, "baked")).length;
  const assetsBefore = engine.getProject().assets.length;
  engine.getProject().assets.find((a) => a.id === red.id)!.missing = true;
  const e = await thrown(() => dispatch(engine, "add_graphic", { code: img, durationSeconds: 0.2 }));
  check(e instanceof RpcError && e.code === "media_offline" && e.message.includes(`Asset "${red.name}" is offline`) && filesUnder(join(x.data, "baked")).length === bakedBefore
    && engine.getProject().assets.length === assetsBefore && filesUnder(join(x.data, "motion")).length === 0,
    `an offline library image: media_offline with its message, nothing written (${errCode(e)}: ${e?.message.slice(0, 100)})`);
}

// ---- S10: the text --------------------------------------------------------------------------------

// MUTATION: drop an item from RENDERER_DIFFERENCES in graphicsaddon.tsx → the same-list row fails. Drop the
// linked-audio sentence from the guide's instructions → the guide row fails.
function s10() {
  console.log("S10. the guide, SKILL.md, add_graphic's description and the dialog's help...");
  const read = (...p: string[]) => readFileSync(join(REPO, ...p), "utf8");
  const list = (src: string) => {
    const m = /const RENDERER_DIFFERENCES = \[([\s\S]*?)\]/.exec(src);
    return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  };
  const guideSrc = read("packages", "mcp", "src", "guide.ts");
  const dialog = list(read("apps", "desktop", "src", "graphicsaddon.tsx"));
  const guide = list(guideSrc);
  const flat = (t: string) => t.replace(/\s+/g, " ");
  const skill = flat(read("packages", "skill-installer", "skill", "SKILL.md"));
  check(dialog.length === 7 && JSON.stringify(dialog) === JSON.stringify(guide) && dialog.every((d) => skill.includes(d)),
    `the dialog's help and the guide list the same ${dialog.length} differences, and SKILL.md names each (${JSON.stringify(dialog.filter((d) => !skill.includes(d) || !guide.includes(d)))})`);
  const instructions = flat(guideSrc.slice(guideSrc.indexOf("export const PLATFORM_INSTRUCTIONS"), guideSrc.indexOf("export const EDITING_GUIDE")));
  const wants: [string, string, string[]][] = [
    ["the MCP instructions", instructions, ["ONLY THE USER'S SETTING decides", 'asset("<id>")', "Still no network and no packages", "An OVERLAY graphic's audio appears as a linked audio clip", "graphic_renderer_unavailable", "${RENDERER_DIFFERENCES}", "nothing re-renders by itself"]],
    ["SKILL.md", skill, ["Only the user's **graphics renderer setting** decides", 'asset("<id>")', "still no network and no packages", "An overlay graphic's audio appears as a linked audio clip", "`graphic_renderer_unavailable`", "Changing the setting re-renders nothing"]],
    ["add_graphic's description", methods.add_graphic.description, ["only the user's setting decides", 'asset("<id>")', "still with no network and no packages", "an overlay's audio becomes a linked audio clip", "graphic_renderer_unavailable"]],
  ];
  for (const [what, text, phrases] of wants) {
    const missing = phrases.filter((p) => !text.includes(p));
    check(missing.length === 0, `${what}: library media by asset id, no network or packages, the linked audio clip, the setting decides (${JSON.stringify(missing)})`);
  }
}

// ---- main -----------------------------------------------------------------------------------------

let summarized = false;
async function main() {
  const args = process.argv.slice(2);
  reexecInNetns(fileURLToPath(import.meta.url), args, "10.97.0.1");
  const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
  const part = (name: string) => !only || only.includes(name);
  const work = mkdtempSync(join(tmpdir(), "zr-motion-switch-"));
  try {
    if (part("S1")) await s1(work);
    if (part("S2")) await s2(work);
    if (part("S4")) await s4(work);
    if (part("S10")) s10();
    if (!LINUX) {
      console.log("  skip S3 and S5-S9: they run Linux's Electron");
    } else {
      if (part("S3")) await s3(work);
      if (part("S5")) await s5(work);
      if (part("S6")) await s6(work);
      if (part("S7")) await s7(work);
      const fx = { host: join(work, "host.mp4"), red: join(work, "red.png"), tone: join(work, "tone.wav") };
      if (part("S8") || part("S9")) {
        ffmpeg(["-f", "lavfi", "-i", "color=c=0x103018:s=320x180:r=30:d=4", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", fx.host]);
        ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-frames:v", "1", fx.red]);
        ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=48000", "-af", "volume=0.2", "-ac", "2", "-c:a", "pcm_s16le", fx.tone]);
      }
      if (part("S8")) await s8(work, fx.host);
      if (part("S9")) await s9(work, fx);
    }
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  }
  summarized = true;
  const failures = failureCount();
  console.log(failures === 0 ? `\nALL MOTION SWITCH CHECKS PASSED (${basename(fileURLToPath(import.meta.url))})` : `\n${failures} CHECK(S) FAILED`);
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
