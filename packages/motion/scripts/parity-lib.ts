/**
 * What the two parity harnesses share (parity-render.ts, non-media, and
 * parity-media.ts, library media and audio): the composition header, D8's
 * frame comparison, FFmpeg frame decoding, the child process that renders one
 * side in fresh folders, and the private network namespace. A dev tool, not
 * shipped. Importing it starts nothing.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HEADLESS_SHELL } from "../../core/src/motion/addonlock.js";
import { REMOTION_VERSION } from "../../core/src/motion/remotionload.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "../../..");
/** The pinned headless shell in this checkout (Remotion's own cache folder, filled from the main checkout). */
export const SHELL = join(REPO, "node_modules", ".remotion", "chrome-headless-shell", "linux64", HEADLESS_SHELL.platforms["linux-x64"].executable);
export const NETNS = "ZR_PARITY_NETNS";
export const RULE = { pct: 99.5, max: 32 };
export const DRIFT = "reference refused (drift candidate)";

export interface Header {
  sizes: { w: number; h: number }[];
  fps: number;
  durationInFrames: number;
  frames: number[];
  /** The media batch's `// audio: yes|no` line (no line: no). */
  audio: boolean;
  spec: string;
  why: string;
}

/** The composition's header (one `// field: value` line each, before the code). */
export function parseHeader(text: string): Header {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\/\/ (size|fps|durationInFrames|frames|audio|spec|why): (.*)$/.exec(line);
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
  const audio = fields.get("audio") ?? "no";
  if (audio !== "yes" && audio !== "no") throw new Error(`bad audio ${JSON.stringify(audio)}`);
  return { sizes, fps, durationInFrames, frames, audio: audio === "yes", spec: need("spec"), why: need("why") };
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
export function heatmap(a: Buffer, b: Buffer): Buffer {
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

export const fmt = (m: Metrics) => `${m.pct_within_4}/${m.max_diff}`;

// ---- FFmpeg ----------------------------------------------------------------------------

/** The listed frames of `file` (in ascending order), decoded by FFmpeg to RGBA; throws when fewer come out. */
export function decodeFrames(file: string, w: number, h: number, frames: number[]): Map<number, Buffer> {
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

export function writePng(file: string, rgba: Buffer, w: number, h: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-i", "pipe:0", "-frames:v", "1", file], { input: rgba });
  if (r.status !== 0) throw new Error(`FFmpeg could not write ${file}: ${String(r.stderr).trim()}`);
}

// ---- one side, in a child process -------------------------------------------------------

/** A child's result.json: the overlay it rendered (and, from parity-media, its sound), or why it failed. */
export type Outcome = { ok: true; mov: string; audio?: string; ms: number } | { ok: false; error: string; code?: string; ms: number };

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
export const leftovers: { dir: string; pids: number[] }[] = [];
let scratchCounter = 0;

/**
 * Run `script --child=<job.json>` for `job` in a fresh child folder under
 * `scratch` (job.json gets `dir`); the child gets only fresh folders in its
 * environment (HOME, USERPROFILE, XDG_CONFIG_HOME, AIVE_DATA_DIR = dir/data with
 * baked/, TEMP/TMP/TMPDIR = dir/tmp) and a PulseAudio server that does not
 * exist, and writes result.json in its folder.
 */
export function runPipeline<J extends { durationInFrames: number }>(script: string, scratch: string, name: string, job: J): Promise<Outcome> {
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
    // Silent tests: no sound device for anything the child starts.
    PULSE_SERVER: `unix:${join(dir, "no-pulse")}`,
  };
  const limitMs = 300_000 + 3000 * job.durationInFrames;
  const t0 = Date.now();
  return new Promise((resolveRun) => {
    // cwd = the child's folder: Remotion's webpack cache lands there, not in the checkout.
    const p = spawn(process.execPath, [...process.execArgv, script, `--child=${jobFile}`], { cwd: dir, env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
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

// ---- the run ------------------------------------------------------------------------------

export function versions() {
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

/** This process runs in the harness's private network namespace: NETNS is set and loopback is the only interface (`nics`: the interfaces' names). */
export function offline(nics = Object.keys(networkInterfaces())): boolean {
  return process.env[NETNS] === "1" && nics.join() === "lo";
}

/**
 * Linux only. Re-executes `script` with `args` in a private network namespace
 * (loopback only) when unshare allows it, so nothing it starts can reach a real
 * host, and returns that run's exit code; null when this process already runs
 * in one (offline(): NETNS alone is not enough), or (without --require-netns)
 * when unshare fails. NETNS set with other interfaces than loopback throws under
 * --require-netns.
 */
export function inPrivateNetns(script: string, args: string[], nics = Object.keys(networkInterfaces())): number | null {
  if (process.platform !== "linux") throw new Error("the parity harness runs on Linux only");
  if (offline(nics)) return null;
  if (process.env[NETNS] && args.includes("--require-netns")) throw new Error(`--require-netns: ${NETNS} is set but the interfaces are ${nics.join(", ")}, not loopback only`);
  const ns = ["--user", "--map-current-user", "--net", "--keep-caps", "sh", "-c"];
  if (spawnSync("unshare", [...ns, "ip link set lo up"], { stdio: "ignore" }).status === 0) {
    const r = spawnSync("unshare", [...ns, 'ip link set lo up && exec setpriv --inh-caps=-all --ambient-caps=-all "$0" "$@"', process.execPath, ...process.execArgv, script, ...args], {
      stdio: "inherit",
      env: { ...process.env, [NETNS]: "1" },
    });
    return r.status ?? 1;
  }
  if (args.includes("--require-netns")) throw new Error("--require-netns: no private network namespace (unshare failed)");
  console.log("note: no private network namespace (unshare failed); running in the current one");
  return null;
}
