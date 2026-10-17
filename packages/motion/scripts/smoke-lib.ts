/**
 * What the motion renderer's smokes share (smoke-renderer.ts,
 * smoke-motion-media.ts): the check counter, fresh HOME and data folders,
 * Linux's process table and listening ports, and the private network
 * namespace a run re-executes itself in.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
export const check = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};
/** How many checks failed so far. */
export const failureCount = () => failures;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const NETNS = "ZR_MOTION_SMOKE_NETNS";
export const LINUX = process.platform === "linux";

/**
 * On Linux, outside the namespace: run `script` again with `args` in a private
 * network namespace (loopback and a dummy interface at `lan`, nothing routed
 * out), so even a broken guard reaches no real host, and exit with its
 * status. Returns when already inside, or when no namespace can be made.
 */
export function reexecInNetns(script: string, args: string[], lan: string): void {
  if (!LINUX || process.env[NETNS]) return;
  const setup = `ip link set lo up && ip link add zr0 type dummy && ip addr add ${lan}/24 dev zr0 && ip link set zr0 up`;
  const ns = ["--user", "--map-current-user", "--net", "--keep-caps", "sh", "-c"];
  if (spawnSync("unshare", [...ns, setup], { stdio: "ignore" }).status === 0) {
    const r = spawnSync("unshare", [...ns, `${setup} && exec setpriv --inh-caps=-all --ambient-caps=-all "$0" "$@"`, process.execPath, ...process.execArgv, script, ...args], {
      stdio: "inherit",
      env: { ...process.env, [NETNS]: "1" },
    });
    process.exit(r.status ?? 1);
  }
}

// ---- fresh folders and processes -------------------------------------------------

export interface Fresh {
  dir: string;
  home: string;
  data: string;
  /** For a renderer or a core: fresh HOME/USERPROFILE/XDG_CONFIG_HOME and AIVE_DATA_DIR, no display, plus what a core inherits. */
  env: NodeJS.ProcessEnv;
}

let counter = 0;
export function fresh(work: string, name: string): Fresh {
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
export function filesUnder(dir: string, base = dir): string[] {
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
export function processTable(): Map<number, number> {
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

export function descendants(root: number, table = processTable()): number[] {
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

export async function gone(pids: number[], ms: number): Promise<number[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const table = processTable();
    const left = pids.filter((p) => table.has(p));
    if (left.length === 0 || Date.now() > deadline) return left;
    await sleep(50);
  }
}

export function environNames(pid: number): string[] | null {
  try {
    return readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").filter(Boolean).map((e) => e.slice(0, e.indexOf("=")));
  } catch {
    return null;
  }
}

/** Local TCP ports in LISTEN state (this network namespace). */
export function listeningPorts(): number[] {
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
export function watchTree(root: number) {
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
