/**
 * Render parity, non-media (MOTION-PLAN D8 "Runtime"; decisions.md PARITY
 * REDESIGN, R-PARITY-SCHEMA, VERSION-DRIFT). A dev tool, not shipped.
 *
 * Each composition (a .tsx that default-exports a component, with a header of
 * `// size:`, `// fps:`, `// durationInFrames:`, `// frames:`, `// spec:` and
 * `// why:` lines) is rendered at each header size through both pipelines,
 * each in its own child process with fresh HOME/USERPROFILE/XDG_CONFIG_HOME/
 * AIVE_DATA_DIR/TMPDIR folders:
 *  - reference: renderGraphic (core motion/render.ts) with this checkout's
 *    Remotion and its pinned headless shell (node_modules/.remotion, passed as
 *    the add-on's browser, so a missing one fails and nothing is downloaded);
 *  - zabsreel:  renderMotion (core motion/rendermotion.ts) with the graphic
 *    {source, props: {}} through ZabsReel's renderer (muted).
 * Both render every frame of the composition as an overlay (ProRes 4444 with
 * alpha); the header's frames are decoded from both files with the same FFmpeg
 * (the one on PATH) to 8-bit RGBA and compared per pixel and channel:
 * pct_within_4 (share of pixels whose largest channel difference is <= 4),
 * max_diff and mean_diff (mean channel difference). D8's rule: a frame passes
 * at pct_within_4 >= 99.5 and max_diff <= 32. control.tsx (no runtime API)
 * runs first; its numbers are the noise floor, reported apart in the summary.
 *
 * Writes to --out: render-all.jsonl (one row per composition, size and frame)
 * and render-mismatches.jsonl (the rows failing D8), each row exactly
 * {case, function, size, input, metric, expected, actual, spec, why}
 * (R-PARITY-SCHEMA: rows may go to the clean-room implementer, so they never
 * hold the reference's own error text; a composition the reference fails to
 * render is "reference refused (drift candidate)" in its rows); images/<case>/
 * <size>/ with the two decoded frames and a heatmap of each failing frame (for
 * the orchestrator only); render-summary.json with every metric, timing, the
 * error texts and the versions.
 *
 * Exit: 0 every frame passes; 2 a pipeline could not render a composition
 * (named on stderr; the other rows are still written); 3 every composition
 * rendered and some frames fail D8; 1 the harness itself failed.
 *
 * --self-test (to --out): compare() on known buffers; control.tsx rendered
 * twice through ZabsReel passes against itself with max_diff 0; the same
 * frames with +40 on every colour channel give a mismatch row per frame in
 * render-mismatches.jsonl; control.tsx with its green circle 40 brighter on
 * the second side only (its own render, its own file) fails every frame, and
 * each side's image shows its own circle; a composition that throws is tagged
 * "reference refused (drift candidate)" by the real reference pipeline, and
 * the run names it; one only the reference side refuses (its source made to
 * throw) is exactly "reference refused (drift candidate)".
 *
 * Linux only (the pinned shell's linux64 folder and the private network
 * namespace). The whole run re-executes itself in a private network namespace
 * (loopback only) when unshare allows it, so neither pipeline can reach a
 * real host. Needs `npm run build` (dist/zr-runtime.js) and FFmpeg.
 * Run: npx tsx packages/motion/scripts/parity-render.ts --out=<folder>
 *        [--cases=<folder of .tsx>] [--only=control.tsx,spring-motion.tsx]
 *        [--scratch=<folder>] [--require-netns] [--self-test]
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HEADLESS_SHELL } from "../../core/src/motion/addonlock.js";
import { REMOTION_VERSION } from "../../core/src/motion/remotionload.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const SELF = fileURLToPath(import.meta.url);
const CASES = join(REPO, "packages", "motion", "parity", "compositions");
/** The pinned headless shell in this checkout (Remotion's own cache folder, filled from the main checkout). */
const SHELL = join(REPO, "node_modules", ".remotion", "chrome-headless-shell", "linux64", HEADLESS_SHELL.platforms["linux-x64"].executable);
const NETNS = "ZR_PARITY_NETNS";
const RULE = { pct: 99.5, max: 32 };
const DRIFT = "reference refused (drift candidate)";

type Pipeline = "reference" | "zabsreel";

interface Header {
  sizes: { w: number; h: number }[];
  fps: number;
  durationInFrames: number;
  frames: number[];
  spec: string;
  why: string;
}

/** The composition's header (one `// field: value` line each, before the code). */
export function parseHeader(text: string): Header {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\/\/ (size|fps|durationInFrames|frames|spec|why): (.*)$/.exec(line);
    if (!m) break;
    fields.set(m[1], m[2].trim());
  }
  const need = (k: string) => {
    const v = fields.get(k);
    if (v === undefined) throw new Error(`the header has no "// ${k}:" line`);
    return v;
  };
  const sizes = need("size").split(",").map((s) => {
    const m = /^(\d+)x(\d+)$/.exec(s.trim());
    if (!m) throw new Error(`bad size ${JSON.stringify(s)}`);
    return { w: Number(m[1]), h: Number(m[2]) };
  });
  const fps = Number(need("fps"));
  const durationInFrames = Number(need("durationInFrames"));
  const frames = need("frames").split(",").map((s) => Number(s.trim()));
  if (!(fps > 0) || !Number.isInteger(durationInFrames) || durationInFrames < 1) throw new Error("bad fps or durationInFrames");
  if (!frames.every((n) => Number.isInteger(n) && n >= 0 && n < durationInFrames)) throw new Error(`frames must be whole numbers below ${durationInFrames}`);
  return { sizes, fps, durationInFrames, frames, spec: need("spec"), why: need("why") };
}

// ---- comparison ------------------------------------------------------------------------

export interface Metrics {
  pct_within_4: number;
  max_diff: number;
  mean_diff: number;
  pass: boolean;
}

/** Two RGBA frames of the same size, per pixel and channel (alpha included). */
export function compare(a: Buffer, b: Buffer): Metrics {
  if (a.length !== b.length || a.length % 4 !== 0) throw new Error(`frames differ in size (${a.length} and ${b.length} bytes)`);
  let within = 0;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    let px = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a[i + c] - b[i + c]);
      sum += d;
      if (d > px) px = d;
    }
    if (px <= 4) within++;
    if (px > max) max = px;
  }
  const pixels = a.length / 4;
  // The rule on the exact counts (99.5 % = 995 per 1000); the share is reported to 3 decimals.
  const pass = within * 1000 >= pixels * RULE.pct * 10 && max <= RULE.max;
  return { pct_within_4: Math.round((within / pixels) * 1e5) / 1e3, max_diff: max, mean_diff: Math.round((sum / a.length) * 1e4) / 1e4, pass };
}

/** The heatmap of a failing frame: black where equal, blue up to 4, amber up to 32, red beyond. */
function heatmap(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a[i + c] - b[i + c]));
    const [r, g, bl] = d === 0 ? [0, 0, 0] : d <= 4 ? [0, 0, 60 + d * 30] : d <= RULE.max ? [255, 150 + d * 3, 0] : [255, 0, 0];
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = bl;
    out[i + 3] = 255;
  }
  return out;
}

// ---- FFmpeg ----------------------------------------------------------------------------

/** The listed frames of `file` (in ascending order), decoded by FFmpeg to RGBA; throws when fewer come out. */
function decodeFrames(file: string, w: number, h: number, frames: number[]): Map<number, Buffer> {
  const sorted = [...new Set(frames)].sort((x, y) => x - y);
  const select = `select=${sorted.map((n) => `eq(n\\,${n})`).join("+")}`;
  const size = w * h * 4;
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", select, "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], {
    maxBuffer: size * sorted.length + (1 << 20),
  });
  if (r.status !== 0) throw new Error(`FFmpeg could not decode ${basename(file)}: ${String(r.stderr).trim().split("\n").pop()}`);
  if (r.stdout.length !== size * sorted.length) throw new Error(`${basename(file)} gave ${r.stdout.length / size} of ${sorted.length} frames`);
  return new Map(sorted.map((n, i) => [n, r.stdout.subarray(i * size, (i + 1) * size)]));
}

function writePng(file: string, rgba: Buffer, w: number, h: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-i", "pipe:0", "-frames:v", "1", file], { input: rgba });
  if (r.status !== 0) throw new Error(`FFmpeg could not write ${file}: ${String(r.stderr).trim()}`);
}

// ---- one pipeline, in a child process ---------------------------------------------------

interface Job {
  pipeline: Pipeline;
  source: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  /** The child's folder: home/, data/ (AIVE_DATA_DIR, with baked/), tmp/; the result is data/baked/graphic.mov. */
  dir: string;
}

type Outcome = { ok: true; mov: string; ms: number } | { ok: false; error: string; code?: string; ms: number };

/** The child: one render through `job.pipeline`; writes result.json in its folder. */
async function child(jobFile: string): Promise<void> {
  const job = JSON.parse(readFileSync(jobFile, "utf8")) as Job;
  const data = join(job.dir, "data");
  const mov = join(data, "baked", "graphic.mov");
  const t0 = Date.now();
  let out: Outcome;
  try {
    const common = { width: job.width, height: job.height, fps: job.fps, durationInFrames: job.durationInFrames, alpha: true, outPath: mov };
    if (job.pipeline === "reference") {
      // Loaded here only: the parent process never loads Remotion.
      const { renderGraphic } = await import("../../core/src/motion/render.js");
      await renderGraphic({ ...common, code: job.source, props: {}, workDir: join(data, "graphic-src") }, { ok: true, root: REPO, browserExecutable: SHELL });
    } else {
      const { renderMotion } = await import("../../core/src/motion/rendermotion.js");
      await renderMotion({ ...common, graphic: { source: job.source, props: {} }, workDir: join(data, "motion", "parity") });
    }
    out = { ok: true, mov, ms: Date.now() - t0 };
  } catch (err) {
    const e = err as Error & { code?: unknown };
    out = { ok: false, error: `${e.name}: ${e.message}`, code: typeof e.code === "string" ? e.code : undefined, ms: Date.now() - t0 };
  }
  writeFileSync(join(job.dir, "result.json"), JSON.stringify(out));
}

/** Processes whose command line names `dir` (a renderer's --zr-scratch, a browser's profile under TMPDIR). */
function processesUnder(dir: string): number[] {
  const out: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${name}/cmdline`, "utf8").includes(dir)) out.push(Number(name));
    } catch {
      /* gone meanwhile */
    }
  }
  return out;
}

/** Processes found and killed after a child ended (recorded in the summary). */
const leftovers: { dir: string; pids: number[] }[] = [];
let scratchCounter = 0;

/** Run `job` (without dir) in a fresh child folder under `scratch`; the child gets only fresh folders in its environment. */
function runPipeline(scratch: string, name: string, job: Omit<Job, "dir">): Promise<Outcome> {
  const dir = join(scratch, `${++scratchCounter}-${name}`);
  const home = join(dir, "home");
  for (const d of [join(home, ".config"), join(dir, "data", "baked"), join(dir, "tmp")]) mkdirSync(d, { recursive: true });
  const jobFile = join(dir, "job.json");
  writeFileSync(jobFile, JSON.stringify({ ...job, dir }));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    AIVE_DATA_DIR: join(dir, "data"),
    TMPDIR: join(dir, "tmp"),
    TEMP: join(dir, "tmp"),
    TMP: join(dir, "tmp"),
  };
  const limitMs = 300_000 + 3000 * job.durationInFrames;
  const t0 = Date.now();
  return new Promise((resolveRun) => {
    // cwd = the child's folder: Remotion's webpack cache lands there, not in the checkout.
    const p = spawn(process.execPath, [...process.execArgv, SELF, `--child=${jobFile}`], { cwd: dir, env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-4000)));
    const timer = setTimeout(() => {
      try {
        process.kill(-p.pid!, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, limitMs);
    p.on("close", (code, signal) => {
      clearTimeout(timer);
      try {
        process.kill(-p.pid!, "SIGKILL");
      } catch {
        /* the group is gone */
      }
      const left = processesUnder(dir);
      for (const pid of left) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* gone meanwhile */
        }
      }
      if (left.length) leftovers.push({ dir, pids: left });
      const resultFile = join(dir, "result.json");
      if (existsSync(resultFile)) return resolveRun(JSON.parse(readFileSync(resultFile, "utf8")) as Outcome);
      const why = signal === "SIGKILL" && Date.now() - t0 >= limitMs ? `timed out after ${limitMs} ms` : `the child exited (${code ?? signal}) without a result`;
      resolveRun({ ok: false, error: `${why}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`, ms: Date.now() - t0 });
    });
  });
}

// ---- one composition --------------------------------------------------------------------

interface Row {
  case: string;
  function: "render";
  size: string;
  input: string;
  metric: "pct_within_4/max_diff";
  expected: string;
  actual: string;
  spec: string;
  why: string;
}

interface SizeResult {
  size: string;
  reference: Outcome;
  zabsreel: Outcome;
  frames: ({ frame: number } & Metrics)[];
  /** A decode failure after both rendered. */
  error?: string;
}

interface CaseResult {
  case: string;
  spec: string;
  why: string;
  status: "pass" | "mismatch" | typeof DRIFT | "zabsreel failed" | "harness error";
  sizes: SizeResult[];
}

interface Run {
  out: string;
  scratch: string;
  /** Which pipeline renders each side (the self-test renders ZabsReel on both). */
  sides: { reference: Pipeline; zabsreel: Pipeline };
  /** Self-test: change the second side's decoded frames before comparing. */
  alter?: (frame: Buffer) => Buffer;
  /** Self-test: change one side's composition before it renders (the header is read from the original). */
  sourceA?: (tsx: string) => string;
  sourceB?: (tsx: string) => string;
}

const fmt = (m: Metrics) => `${m.pct_within_4}/${m.max_diff}`;

function rowsFile(run: Run, name: string, rows: Row[]): void {
  if (rows.length) appendFileSync(join(run.out, name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** Render `file` at each header size through both sides, compare, append its rows. */
async function runCase(run: Run, file: string, source = readFileSync(file, "utf8")): Promise<CaseResult> {
  const name = basename(file);
  const header = parseHeader(source);
  const result: CaseResult = { case: name, spec: header.spec, why: header.why, status: "pass", sizes: [] };
  const rows: Row[] = [];
  const mismatches: Row[] = [];
  for (const { w, h } of header.sizes) {
    const size = `${w}x${h}`;
    const job = { source, width: w, height: h, fps: header.fps, durationInFrames: header.durationInFrames };
    const tag = `${name.replace(/\.tsx$/, "")}-${size}`;
    const [reference, zabsreel] = await Promise.all([
      runPipeline(run.scratch, `${tag}-a`, { ...job, source: run.sourceA?.(source) ?? source, pipeline: run.sides.reference }),
      runPipeline(run.scratch, `${tag}-b`, { ...job, source: run.sourceB?.(source) ?? source, pipeline: run.sides.zabsreel }),
    ]);
    const sized: SizeResult = { size, reference, zabsreel, frames: [] };
    result.sizes.push(sized);
    const row = (n: number, actual: string): Row => ({ case: name, function: "render", size, input: `frame ${n}`, metric: "pct_within_4/max_diff", expected: `D8: >=${RULE.pct} / <=${RULE.max}`, actual, spec: header.spec, why: header.why });
    let failed: string | undefined;
    if (!reference.ok) failed = zabsreel.ok ? DRIFT : `${DRIFT}; zabsreel failed: ${zabsreel.code ?? "error"}`;
    else if (!zabsreel.ok) failed = `zabsreel failed: ${zabsreel.code ?? "error"}`;
    if (!failed && reference.ok && zabsreel.ok) {
      try {
        const a = decodeFrames(reference.mov, w, h, header.frames);
        const b = decodeFrames(zabsreel.mov, w, h, header.frames);
        for (const n of header.frames) {
          const fa = a.get(n)!;
          const fb = run.alter ? run.alter(b.get(n)!) : b.get(n)!;
          const m = compare(fa, fb);
          sized.frames.push({ frame: n, ...m });
          const r = row(n, fmt(m));
          rows.push(r);
          if (!m.pass) {
            mismatches.push(r);
            const dir = join(run.out, "images", name.replace(/\.tsx$/, ""), size);
            writePng(join(dir, `frame-${n}-reference.png`), fa, w, h);
            writePng(join(dir, `frame-${n}-zabsreel.png`), fb, w, h);
            writePng(join(dir, `frame-${n}-diff.png`), heatmap(fa, fb), w, h);
          }
        }
      } catch (err) {
        sized.error = (err as Error).message;
        failed = "harness error";
      }
    }
    if (failed) {
      for (const n of header.frames) {
        const r = row(n, failed);
        rows.push(r);
        mismatches.push(r);
      }
    }
    for (const o of [reference, zabsreel]) if (o.ok) rmSync(dirname(dirname(dirname(o.mov))), { recursive: true, force: true, maxRetries: 5 });
    const status: CaseResult["status"] = failed === "harness error" ? "harness error" : failed?.startsWith(DRIFT) ? DRIFT : failed ? "zabsreel failed" : sized.frames.every((f) => f.pass) ? "pass" : "mismatch";
    const rank = ["pass", "mismatch", "zabsreel failed", DRIFT, "harness error"];
    if (rank.indexOf(status) > rank.indexOf(result.status)) result.status = status;
    const worst = sized.frames.length ? `min pct ${Math.min(...sized.frames.map((f) => f.pct_within_4))}, max diff ${Math.max(...sized.frames.map((f) => f.max_diff))}` : failed;
    console.log(`  ${name} ${size}: ${worst} (${run.sides.reference} ${(reference.ms / 1000).toFixed(1)} s, ${run.sides.zabsreel} ${(zabsreel.ms / 1000).toFixed(1)} s)`);
  }
  rowsFile(run, "render-all.jsonl", rows);
  rowsFile(run, "render-mismatches.jsonl", mismatches);
  return result;
}

/** The control's numbers per size: its worst frame and the mean of its mean_diff. */
function noiseFloor(control: CaseResult | undefined) {
  if (!control) return null;
  return {
    case: control.case,
    passesD8: control.status === "pass",
    sizes: control.sizes.map((s) => ({
      size: s.size,
      frames: s.frames,
      min_pct_within_4: s.frames.length ? Math.min(...s.frames.map((f) => f.pct_within_4)) : null,
      max_diff: s.frames.length ? Math.max(...s.frames.map((f) => f.max_diff)) : null,
      mean_diff: s.frames.length ? Math.round((s.frames.reduce((t, f) => t + f.mean_diff, 0) / s.frames.length) * 1e4) / 1e4 : null,
      errors: [s.reference, s.zabsreel].filter((o) => !o.ok).map((o) => (o as { error: string }).error),
    })),
  };
}

function versions() {
  const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).stdout.split("\n")[0];
  const electron = (createRequire(join(REPO, "apps", "desktop", "package.json"))("electron/package.json") as { version: string }).version;
  let shell = "missing";
  try {
    shell = readFileSync(join(REPO, "node_modules", ".remotion", "chrome-headless-shell", "VERSION"), "utf8").trim();
  } catch {
    /* reported as missing */
  }
  return { remotion: REMOTION_VERSION, headlessShell: { pinned: HEADLESS_SHELL.version, installed: shell, path: SHELL }, electron, ffmpeg };
}

function freshOut(out: string): void {
  mkdirSync(out, { recursive: true });
  for (const f of ["render-all.jsonl", "render-mismatches.jsonl", "render-summary.json"]) rmSync(join(out, f), { force: true });
  rmSync(join(out, "images"), { recursive: true, force: true });
  writeFileSync(join(out, "render-all.jsonl"), "");
  writeFileSync(join(out, "render-mismatches.jsonl"), "");
}

// ---- the run ------------------------------------------------------------------------------

async function parity(run: Run, casesDir: string, only: string[] | undefined, netns: boolean): Promise<number> {
  const names = readdirSync(casesDir).filter((f) => f.endsWith(".tsx") && (!only || only.includes(f))).sort();
  // The noise floor first.
  names.sort((a, b) => Number(b === "control.tsx") - Number(a === "control.tsx"));
  if (!names.length) throw new Error(`no compositions in ${casesDir}`);
  freshOut(run.out);
  const t0 = Date.now();
  const results: CaseResult[] = [];
  for (const name of names) {
    let r: CaseResult;
    try {
      r = await runCase(run, join(casesDir, name));
    } catch (err) {
      // A header the harness cannot read: the case is named, the run goes on.
      r = { case: name, spec: "", why: "", status: "harness error", sizes: [] };
      console.log(`  ${name}: ${(err as Error).message}`);
      (r as CaseResult & { error?: string }).error = (err as Error).message;
    }
    results.push(r);
  }
  const count = (s: CaseResult["status"]) => results.filter((r) => r.status === s).map((r) => r.case);
  const frames = results.flatMap((r) => r.sizes.flatMap((s) => s.frames));
  const summary = {
    rule: `D8: pct_within_4 >= ${RULE.pct} and max_diff <= ${RULE.max} (per pixel and channel, RGBA 8-bit, both ProRes 4444 files decoded by the same FFmpeg)`,
    casesDir,
    netns,
    versions: versions(),
    seconds: Math.round((Date.now() - t0) / 1000),
    noiseFloor: noiseFloor(results.find((r) => r.case === "control.tsx")),
    counts: { cases: results.length, frames: frames.length, framesPassing: frames.filter((f) => f.pass).length },
    passing: count("pass"),
    mismatching: count("mismatch"),
    referenceRefused: count(DRIFT),
    zabsreelFailed: count("zabsreel failed"),
    harnessErrors: count("harness error"),
    leftoverProcesses: leftovers,
    cases: results,
  };
  writeFileSync(join(run.out, "render-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`\n${summary.counts.framesPassing}/${summary.counts.frames} frames pass D8; pass ${summary.passing.length}, mismatch ${summary.mismatching.length}, ${DRIFT} ${summary.referenceRefused.length}, zabsreel failed ${summary.zabsreelFailed.length}, harness errors ${summary.harnessErrors.length}; ${summary.seconds} s; netns ${netns}`);
  if (leftovers.length) console.log(`killed ${leftovers.reduce((t, l) => t + l.pids.length, 0)} leftover process(es): ${JSON.stringify(leftovers)}`);
  const unrendered = results.filter((r) => r.status === DRIFT || r.status === "zabsreel failed" || r.status === "harness error");
  if (unrendered.length) {
    for (const r of unrendered) console.error(`NOT RENDERED: ${r.case} (${r.status})`);
    return 2;
  }
  return summary.mismatching.length ? 3 : 0;
}

// ---- self-test ------------------------------------------------------------------------------

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};

const readRows = (file: string): Row[] => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
const KEYS = "case,function,size,input,metric,expected,actual,spec,why";

async function selfTest(out: string, scratch: string): Promise<number> {
  console.log("S1. compare() on known frames...");
  const base = Buffer.alloc(100 * 100 * 4, 100);
  const plus = (buf: Buffer, at: (i: number) => number) => Buffer.from(buf.map((v, i) => Math.min(255, v + at(i))));
  const same = compare(base, Buffer.from(base));
  check(same.pass && same.pct_within_4 === 100 && same.max_diff === 0 && same.mean_diff === 0, `identical frames: 100/0, mean 0 (${JSON.stringify(same)})`);
  const alpha5 = compare(base, plus(base, (i) => (i % 4 === 3 ? 5 : 0)));
  check(!alpha5.pass && alpha5.pct_within_4 === 0 && alpha5.max_diff === 5, `alpha +5 everywhere: 0/5, fails (${fmt(alpha5)})`);
  const one33 = compare(base, plus(base, (i) => (i === 2 ? 33 : 0)));
  check(!one33.pass && one33.pct_within_4 === 99.99 && one33.max_diff === 33, `one pixel's blue +33: 99.99/33 fails on max_diff (${fmt(one33)})`);
  const edge = compare(base, plus(base, (i) => (i < 50 * 4 && i % 4 === 0 ? 32 : i % 4 === 1 ? 4 : 0)));
  check(edge.pass && edge.pct_within_4 === 99.5 && edge.max_diff === 32, `50 pixels' red +32 and every green +4: 99.5/32 passes (${fmt(edge)})`);

  const control = join(CASES, "control.tsx");
  console.log("S2. control.tsx rendered twice through ZabsReel passes against itself...");
  const selfOut = join(out, "self");
  const self: Run = { out: selfOut, scratch, sides: { reference: "zabsreel", zabsreel: "zabsreel" } };
  freshOut(selfOut);
  const r2 = await runCase(self, control);
  const all2 = readRows(join(selfOut, "render-all.jsonl"));
  const frames2 = r2.sizes.flatMap((s) => s.frames);
  const listed = parseHeader(readFileSync(control, "utf8"));
  check(r2.status === "pass" && frames2.length === listed.frames.length * listed.sizes.length && frames2.every((f) => f.max_diff === 0), `every frame at every size equal: ${frames2.map(fmt).join(", ")} (${r2.status})`);
  check(all2.length === frames2.length && all2.every((r) => Object.keys(r).join() === KEYS && r.actual === "100/0"), `render-all.jsonl: one row per frame and size, keys ${KEYS}, actual 100/0`);
  check(readFileSync(join(selfOut, "render-mismatches.jsonl"), "utf8") === "", "render-mismatches.jsonl is empty");

  console.log("S3. the same frames with +40 on every colour channel give a mismatch row per frame...");
  const altOut = join(out, "altered");
  const altered: Run = { ...self, out: altOut, alter: (f) => plus(f, (i) => (i % 4 === 3 ? 0 : 40)) };
  freshOut(altOut);
  const r3 = await runCase(altered, control);
  const mis3 = readRows(join(altOut, "render-mismatches.jsonl"));
  check(r3.status === "mismatch" && r3.sizes.flatMap((s) => s.frames).every((f) => !f.pass && f.max_diff === 40), `every frame fails with max_diff 40 (${r3.sizes.flatMap((s) => s.frames).map(fmt).join(", ")})`);
  check(mis3.length === frames2.length && mis3.every((r) => r.case === "control.tsx" && Object.keys(r).join() === KEYS && r.actual.endsWith("/40")), `render-mismatches.jsonl holds ${mis3.length} rows of ${frames2.length}, each control.tsx .../40`);
  const img = join(altOut, "images", "control", `${listed.sizes[0].w}x${listed.sizes[0].h}`, `frame-${listed.frames[0]}-diff.png`);
  check(existsSync(img), `a heatmap and both frames are written for a failing frame (${img.slice(out.length + 1)})`);

  console.log("S3b. control.tsx with its green circle 40 brighter on the second side only fails every frame, each image its own side...");
  const brightOut = join(out, "brighter");
  const brighter: Run = {
    ...self,
    out: brightOut,
    sourceB: (tsx) => {
      if (!tsx.includes('"#3cb44b"')) throw new Error("control.tsx no longer has the green circle #3cb44b");
      return tsx.replace('"#3cb44b"', '"#64dc73"');
    },
  };
  freshOut(brightOut);
  const r3b = await runCase(brighter, control);
  const frames3b = r3b.sizes.flatMap((s) => s.frames);
  const mis3b = readRows(join(brightOut, "render-mismatches.jsonl"));
  check(
    r3b.status === "mismatch" && frames3b.length === frames2.length && frames3b.every((f) => !f.pass && f.pct_within_4 < RULE.pct && f.max_diff >= 36 && f.max_diff <= 44),
    `every frame fails, max_diff about 40 (${frames3b.map(fmt).join(", ")})`,
  );
  check(mis3b.length === frames2.length && mis3b.every((r) => r.case === "control.tsx" && Object.keys(r).join() === KEYS), `render-mismatches.jsonl holds ${mis3b.length} rows of ${frames2.length}`);
  // compare() is symmetric: only the two images show which side's file was decoded as which.
  const { w: w0, h: h0 } = listed.sizes[0];
  const centre = (side: Pipeline) => {
    const png = join(brightOut, "images", "control", `${w0}x${h0}`, `frame-${listed.frames[0]}-${side}.png`);
    if (!existsSync(png)) return null;
    const px = decodeFrames(png, w0, h0, [0]).get(0)!;
    const i = (Math.round(h0 * 0.25) * w0 + Math.round(w0 * 0.55)) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  };
  const near = (px: number[], want: number[]) => px.every((v, c) => Math.abs(v - want[c]) <= 4);
  const ref3b = centre("reference");
  const zr3b = centre("zabsreel");
  check(!!ref3b && !!zr3b && near(ref3b, [0x3c, 0xb4, 0x4b]) && near(zr3b, [0x64, 0xdc, 0x73]), `the circle is #3cb44b in the first side's image and #64dc73 in the second's (${ref3b} and ${zr3b})`);

  console.log("S4. a composition that throws, through the real reference pipeline, is a drift candidate and is named...");
  const throws = join(scratch, "throws.tsx");
  writeFileSync(throws, ["// size: 64x48", "// fps: 30", "// durationInFrames: 2", "// frames: 0, 1", "// spec: self-test", "// why: a composition both pipelines refuse", "export default function Throws(): never {", '  throw new Error("parity self-test");', "}", ""].join("\n"));
  const refOut = join(out, "refused");
  const refRun: Run = { out: refOut, scratch, sides: { reference: "reference", zabsreel: "zabsreel" } };
  const code = await parity(refRun, scratch, ["throws.tsx"], process.env[NETNS] === "1");
  const mis4 = readRows(join(refOut, "render-mismatches.jsonl"));
  const summary4 = JSON.parse(readFileSync(join(refOut, "render-summary.json"), "utf8")) as { referenceRefused: string[]; cases: CaseResult[] };
  check(code === 2, `the run exits 2 (it exited ${code})`);
  check(mis4.length === 2 && mis4.every((r) => r.actual.startsWith(DRIFT) && r.input.startsWith("frame ")), `both rows say "${DRIFT}" (${JSON.stringify(mis4.map((r) => r.actual))})`);
  check(summary4.referenceRefused.join() === "throws.tsx" && !summary4.cases[0].sizes[0].reference.ok, "the summary lists it, with the reference's own error kept there");
  check(!mis4.some((r) => r.actual.includes("parity self-test")), "no row carries the error text");

  console.log("S4b. a composition only the reference side refuses (its source made to throw) is exactly a drift candidate...");
  const driftDir = join(scratch, "drift");
  mkdirSync(driftDir, { recursive: true });
  writeFileSync(join(driftDir, "drift.tsx"), ["// size: 64x48", "// fps: 30", "// durationInFrames: 2", "// frames: 0, 1", "// spec: self-test", "// why: a composition only the reference side refuses", 'import React from "react";', "export default function Drift() {", '  return <div style={{ position: "absolute", inset: 0, backgroundColor: "#204060" }} />;', "}", ""].join("\n"));
  const driftOut = join(out, "drift");
  const driftRun: Run = { ...refRun, out: driftOut, sourceA: (tsx) => tsx.replace("  return <div", '  throw new Error("parity self-test drift");\n  return <div') };
  const code4b = await parity(driftRun, driftDir, undefined, process.env[NETNS] === "1");
  const mis4b = readRows(join(driftOut, "render-mismatches.jsonl"));
  const summary4b = JSON.parse(readFileSync(join(driftOut, "render-summary.json"), "utf8")) as { referenceRefused: string[]; zabsreelFailed: string[]; cases: CaseResult[] };
  check(code4b === 2, `the run exits 2 (it exited ${code4b})`);
  check(mis4b.length === 2 && mis4b.every((r) => r.actual === DRIFT), `both rows say exactly "${DRIFT}" (${JSON.stringify(mis4b.map((r) => r.actual))})`);
  const sized4b = summary4b.cases[0].sizes[0];
  check(summary4b.referenceRefused.join() === "drift.tsx" && !summary4b.zabsreelFailed.length && !sized4b.reference.ok && sized4b.zabsreel.ok, "the summary lists it as refused by the reference only, ZabsReel rendered it");
  check(!mis4b.some((r) => r.actual.includes("parity self-test")), "no row carries the error text");

  console.log(failures === 0 ? "\nPARITY HARNESS SELF-TEST PASSED" : `\n${failures} CHECK(S) FAILED`);
  return failures === 0 ? 0 : 1;
}

// ---- main ---------------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const jobFile = arg("child");
  if (jobFile) {
    await child(jobFile);
    return 0;
  }
  if (process.platform !== "linux") throw new Error("the parity harness runs on Linux only");
  // The whole run in a private network namespace (loopback only), so neither pipeline reaches a real host.
  if (!process.env[NETNS]) {
    const ns = ["--user", "--map-current-user", "--net", "--keep-caps", "sh", "-c"];
    if (spawnSync("unshare", [...ns, "ip link set lo up"], { stdio: "ignore" }).status === 0) {
      const r = spawnSync("unshare", [...ns, 'ip link set lo up && exec setpriv --inh-caps=-all --ambient-caps=-all "$0" "$@"', process.execPath, ...process.execArgv, SELF, ...args], {
        stdio: "inherit",
        env: { ...process.env, [NETNS]: "1" },
      });
      return r.status ?? 1;
    }
    if (args.includes("--require-netns")) throw new Error("--require-netns: no private network namespace (unshare failed)");
    console.log("note: no private network namespace (unshare failed); running in the current one");
  }
  const out = arg("out");
  if (!out) throw new Error("--out=<folder> is required");
  if (!existsSync(SHELL)) throw new Error(`the pinned headless shell is missing: ${SHELL}`);
  const scratchParent = arg("scratch") ?? tmpdir();
  mkdirSync(scratchParent, { recursive: true });
  const scratch = mkdtempSync(join(scratchParent, "zr-parity-"));
  try {
    if (args.includes("--self-test")) return await selfTest(resolve(out), scratch);
    const only = arg("only")?.split(",");
    return await parity({ out: resolve(out), scratch, sides: { reference: "reference", zabsreel: "zabsreel" } }, resolve(arg("cases") ?? CASES), only, process.env[NETNS] === "1");
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
