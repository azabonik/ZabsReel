// Stops a core that a smoke test started and that is still running, by its
// exact pid. Each core writes its pid to <dataDir>/server.json, and the file
// stays after the core exits. A smoke that fails part way, or a UI host that
// is killed, can leave its core running, so smoke-web and smoke-electron call
// stopLeftoverCores at the end, also on failure.
//
// A pid is signalled only when that process is this checkout's core: its
// command line runs the cli.js that core-launcher.cjs starts and, on Linux
// (/proc/<pid>/environ), its AIVE_DATA_DIR is that folder. A pid that another
// process now uses is never touched.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The script core-launcher.cjs (coreCliPath) runs for a core of this checkout. */
const CORE_CLI = join(dirname(require.resolve("@aive/core/package.json")), "dist", "cli.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The command line of `pid`, or null when it can't be read. */
function commandLine(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim() || null;
    } catch {
      return null;
    }
  }
  const r = process.platform === "win32"
    ? spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8" })
    : spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** True when `pid` is a running core of this checkout whose data folder is `dataDir`. */
export function isCoreOf(pid: number, dataDir: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return false;
  const cmd = commandLine(pid);
  if (!cmd || !cmd.includes(CORE_CLI)) return false;
  if (process.platform !== "linux") return true;
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    return env.includes(`AIVE_DATA_DIR=${resolve(dataDir)}`);
  } catch {
    return false;
  }
}

/** The pid in <dataDir>/server.json, or null. */
export function corePidIn(dataDir: string): number | null {
  try {
    const pid = Number(JSON.parse(readFileSync(join(dataDir, "server.json"), "utf8")).pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Stop the core of each data folder that is still running: SIGTERM, then
 * SIGKILL after 5 s. `stopped` lists the pids this had to stop; `left` the
 * ones still running afterwards (each as "<pid> <dataDir>").
 */
export async function stopLeftoverCores(dataDirs: string[]): Promise<{ stopped: string[]; left: string[] }> {
  const stopped: string[] = [];
  const left: string[] = [];
  for (const dir of dataDirs) {
    const pid = corePidIn(dir);
    if (pid === null || !isCoreOf(pid, dir)) continue;
    stopped.push(`${pid} ${dir}`);
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      try {
        process.kill(pid, signal);
      } catch {
        /* gone meanwhile */
      }
      const end = Date.now() + (signal === "SIGTERM" ? 5000 : 3000);
      while (isCoreOf(pid, dir) && Date.now() < end) await sleep(100);
      if (!isCoreOf(pid, dir)) break;
    }
    if (isCoreOf(pid, dir)) left.push(`${pid} ${dir}`);
  }
  return { stopped, left };
}
