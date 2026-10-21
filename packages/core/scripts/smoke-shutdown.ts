/**
 * Smoke test: the core stops on SIGTERM while a client is in the middle of a
 * request (EditorServer.stop() in packages/core/src/server.ts). No media.
 *
 * A core is started from src/cli.ts (as smoke-brand does) with a temporary
 * HOME / USERPROFILE / XDG_CONFIG_HOME / AIVE_DATA_DIR and AIVE_PORT=0. One TCP
 * connection sends a whole GET /health and, in the same write, the start of a
 * second request whose headers are not finished. When the first answer is back,
 * the core has read the start of the second request too, so the connection is
 * not idle. Then:
 *  1. The core gets SIGTERM and logs that it is shutting down. Its HTTP server
 *     is closed before it reads that socket again (stop() reaches it without
 *     waiting for any I/O).
 *  2. The test finishes the second request. The core must not answer it: the
 *     shutdown has closed the connection.
 *  3. The core exits with code 0 within 3 s of SIGTERM.
 * Before the fix, http.Server.close() dropped only idle connections: the core
 * answered the second request on the kept-alive connection and exited only
 * when its keep-alive timeout ran out, about 5 s after that request (in
 * smoke-web's section 9 a core went on serving /health after SIGTERM).
 *
 * The core starts its graphics probe (an Electron renderer, muted) when it is
 * ready. Teardown waits for every process that names the temp folder to exit,
 * as smoke-brand does. Not on Windows, where SIGTERM ends a process at once
 * (a printed skip).
 *
 * Run: npx tsx packages/core/scripts/smoke-shutdown.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const CORE_CLI = join(ROOT, "packages", "core", "src", "cli.ts");
const TSX_LOADER = pathToFileURL(require.resolve("tsx")).href;
/** How soon after SIGTERM the core must be gone. A kept-alive connection held it about 5 s. */
const EXIT_WITHIN_MS = 3000;

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) return false;
    await sleep(20);
  }
  return true;
}

/** Other processes whose command line names `dir` or whose working directory is in it (smoke-brand's rule). */
function processesNaming(dir: string): string[] {
  const ps = spawnSync("ps", ["-ww", "-eo", "pid=,args="], { encoding: "utf8" });
  if (ps.error || ps.status !== 0) throw new Error(`ps failed: ${ps.error?.message ?? ps.stderr}`);
  const real = process.platform === "linux" && existsSync(dir) ? realpathSync(dir) : dir;
  const cwdIn = (pid: number) => {
    if (process.platform !== "linux") return false;
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      return cwd === real || cwd.startsWith(real + "/");
    } catch {
      return false;
    }
  };
  return ps.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && Number(l.split(/\s+/)[0]) !== process.pid && (l.includes(dir) || cwdIn(Number(l.split(/\s+/)[0]))));
}

async function main(): Promise<void> {
  if (process.platform === "win32") {
    console.log("skip (win32): SIGTERM ends a process at once there, so there is no shutdown to test");
    console.log("\nSHUTDOWN SMOKE TEST SKIPPED");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "zedmix-shutdown-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".config"), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), AIVE_DATA_DIR: join(root, "data"), AIVE_PORT: "0",
  };
  delete env.AIVE_CORE_URL;
  delete env.AIVE_CORE_TOKEN;
  const core = spawn(process.execPath, ["--import", TSX_LOADER, CORE_CLI], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  core.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  core.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<{ code: number | null; at: number }>((r) => core.on("exit", (code) => r({ code, at: Date.now() })));
  let sock: net.Socket | undefined;
  try {
    console.log("1. a core with a request in progress gets SIGTERM...");
    const ready = await waitFor(() => stdout.includes('"event":"ready"') || core.exitCode !== null, 60_000);
    const line = stdout.split("\n").find((l) => l.includes('"event":"ready"'));
    if (!ready || !line) throw new Error(`core did not report ready:\n${stderr}`);
    const port = (JSON.parse(line) as { port: number }).port;

    let got = "";
    let sockErr = "";
    sock = net.connect(port, "127.0.0.1");
    sock.on("data", (d: Buffer) => (got += d.toString("latin1")));
    sock.on("error", (e: NodeJS.ErrnoException) => (sockErr = e.code ?? e.message));
    const closed = new Promise<void>((r) => sock!.on("close", () => r()));
    await new Promise<void>((r, j) => sock!.once("connect", () => r()).once("error", j));
    const head = `GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`;
    // One write: the whole first request, then the second without the blank line that ends its headers.
    sock.write(`${head}\r\n${head}`);
    const answers = () => (got.match(/^HTTP\/1\.1 \d{3} /gm) ?? []).length;
    const first = await waitFor(() => /\{"ok":true,"port":\d+\}/.test(got), 10_000);
    check(first && answers() === 1 && /^connection: keep-alive\r$/im.test(got), "the first request is answered and the connection kept alive", got.slice(0, 300));

    const killedAt = Date.now();
    process.kill(core.pid!, "SIGTERM");
    // The line is written before stop() runs, and stop() closes the server before the core reads a socket again.
    check(await waitFor(() => stderr.includes("[aive-core] shutting down..."), 5000), "the core logs that it is shutting down", stderr.slice(-400));

    console.log("2. the client finishes its request...");
    if (!sock.destroyed) sock.write("\r\n");
    const exit = await Promise.race([exited, sleep(10_000).then(() => null)]);
    await Promise.race([closed, sleep(2000)]);
    check(answers() === 1 && sock.destroyed, "the request in progress gets no answer: the shutdown closed its connection",
      `${answers()} answer(s)${sock.destroyed ? "" : ", connection still open"}${sockErr ? ` (${sockErr})` : ""}`);

    console.log("3. the core exits...");
    const how = exit ? `exit ${exit.code} after ${exit.at - killedAt} ms` : "still running 10 s after SIGTERM";
    check(exit !== null && exit.code === 0 && exit.at - killedAt <= EXIT_WITHIN_MS, `with code 0 within ${EXIT_WITHIN_MS} ms of SIGTERM (${how})`);
  } finally {
    sock?.destroy();
    if (core.exitCode === null && core.signalCode === null && core.pid) {
      process.kill(core.pid, "SIGKILL");
      await Promise.race([exited, sleep(5000)]);
    }
    // The graphics probe's renderer stops on its own soon after its core (1 s parent poll) and writes its profile
    // under root until then: wait for it before removing root. One still running after 15 s is a leak.
    const from = Date.now();
    let left = processesNaming(root);
    while (left.length && Date.now() - from < 15_000) {
      await sleep(100);
      left = processesNaming(root);
    }
    check(left.length === 0, `no process of the stopped core is left (waited ${Date.now() - from} ms)`, left.join("; "));
    for (const l of left) {
      try {
        process.kill(Number(l.split(/\s+/)[0]), "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  if (failures) {
    console.error(`\nSHUTDOWN SMOKE TEST FAILED (${failures} check${failures === 1 ? "" : "s"})`);
    process.exit(1);
  }
  console.log("\nSHUTDOWN SMOKE TEST PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("SHUTDOWN SMOKE TEST FAILED:", err);
  process.exit(1);
});
