// Web-shell smoke: starts web/server.cjs (which launches its own core in a temp
// data dir on an ephemeral port), then checks the renderer is served, the
// security guards hold (Host check, the shell key on /api and not the core
// token, no path traversal, no framing), the picker's directory listing is
// right, a path from that listing imports and streams through the core, and
// stopping the shell stops the core it started. A port that browsers refuse
// (ERR_UNSAFE_PORT, e.g. 5060), for the shell or for the core, stops the shell
// with a clear message (and stops the core it started).
//
// Network computers (plan 9.6; test servers under .invalid, which never
// resolve): the shell key is nowhere in the data folder; POST approve, revoke
// and picked need it (GET → 405, no CORS preflight answered); picked allows
// only a server whose folder the shell listed. In a browser page (headless
// Chromium): a project on a server not allowed shows the banner and the
// in-app alertdialog (focus on Keep offline, Tab stays inside, Esc keeps it
// offline, Allow allows it, the clips come online); Save As with a project
// named \\zr-evil.invalid\s\x starts the picker with x.aive and saves in the
// folder listed (not before a typed folder's listing lands, nor while the
// path bar names a folder not listed or one that failed to list); an entry
// added outside ZedMix gets the Keep dialog (focus on Remove, Esc removes it,
// Keep stamps it), and with two pages Keep in one then Esc in the other leaves
// it allowed. Both processes run under a trace
// preload (every fs and child_process call that names a test server): nothing
// touches a server before it is allowed, and the shell only lists the folder
// the picker was sent to.
//
// Needs the project built (`npm run build`), FFmpeg on PATH, and
// playwright-core + a Chromium: PLAYWRIGHT_CORE=<dir of playwright-core> and
// PLAYWRIGHT_CHROMIUM=<chrome binary> override the search (npx caches,
// ~/.cache/ms-playwright), as in parity-gl.mts.
//
// The page's network limits (X3): index.html carries the CSP meta tag and the
// shell sends the same policy as a header with the core's exact port; in the
// page a media element pointed at the core's address on another port, or at
// another computer, raises a media-src violation and makes no request. /file
// answers 415 for a playlist.
//
// The graphics add-on (ADDON-PLAN D8.5; a fixture closure from a loopback
// registry on port 5033 through AIVE_ADDON_REGISTRY, the pin from
// AIVE_ADDON_TEST_PIN, its URLs on hosts under .invalid): /api/graphics-addon/*
// answers only with the shell key (not without, not with the core token), and
// nothing is installed or fetched then. In the page: Help → Graphics add-on…
// shows the core's notice and licence, another window's install lock its
// message and no install button; Accept and install shows progress and
// Cancel, and Cancel leaves nothing; the next install ends "ready" with only
// the platform's list fetched; a fixture job of type "graphic" disables Remove
// and Reinstall; Remove; a copy whose browser is gone shows Reinstall, which
// repairs it, and Remove, which deletes it; with no
// add-on, an add_graphic over the core's HTTP RPC brings the banner, whose
// Set up… opens the dialog. The shell fetches nothing but loopback (traced).
//
// No core is left running: stopping the shell must end its core's process
// (not only its port), and at the end, also after a failure, any core this
// smoke started that still runs is stopped by its exact pid (leftover-cores.ts).
//
// Run:  npx tsx apps/desktop/scripts/smoke-web.ts

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { corePidIn, isCoreOf, stopLeftoverCores } from "./leftover-cores";

// The page's Content-Security-Policy (the shell sends it with the core's port).
const netGuard = require("../electron/net-guard.cjs") as { rendererCsp: (port?: number) => string };

type PW = typeof import("playwright-core");
type Page = Awaited<ReturnType<Awaited<ReturnType<PW["chromium"]["launch"]>>["newPage"]>>;

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };
function request(port: number, path: string, opts: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: opts.method ?? "GET",
        headers: { host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
const json = (r: Res) => JSON.parse(r.body || "{}");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, fn: () => boolean | Promise<boolean>, ms = 15000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(150);
  }
  console.log(`  (timed out waiting for ${what})`);
  return false;
}

// ---- playwright-core and Chromium (as parity-gl.mts finds them) --------------------
async function loadPlaywright(): Promise<PW> {
  const out: string[] = [];
  if (process.env.PLAYWRIGHT_CORE) out.push(process.env.PLAYWRIGHT_CORE);
  out.push(resolve(__dirname, "../../../node_modules/playwright-core"));
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
function chromiumPath(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const cache = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? "", "ms-playwright")
    : process.platform === "darwin" ? join(homedir(), "Library", "Caches", "ms-playwright") : join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  const dirs = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const d of dirs) {
    for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-win/chrome.exe", "chrome-win64/chrome.exe", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
      const p = join(cache, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

// Preloaded into the shell (NODE_OPTIONS, which its core inherits): one JSON
// line per fs / child_process call whose arguments name a test server, with
// the process's script, as smoke-unc-e2e.ts traces the core.
const TRACE_MJS = `
import { createRequire, syncBuiltinESMExports } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("node:fs");
const append = fs.appendFileSync;
const out = process.env.ZR_TRACE;
const WATCH = /zr-(evil|pick)/i;
const hit = (v, d = 0) =>
  typeof v === "string" ? WATCH.test(v)
  : v instanceof Uint8Array ? WATCH.test(Buffer.from(v).toString("utf8"))
  : v instanceof URL ? WATCH.test(v.href)
  : Array.isArray(v) ? d < 3 && v.some((x) => hit(x, d + 1))
  : v && typeof v === "object" && d < 2 ? Object.values(v).some((x) => hit(x, d + 1))
  : false;
const PATH_ONLY = new Set(["writeFile", "writeFileSync", "appendFile", "appendFileSync"]);
const SKIP = new Set(["write", "writeSync", "writev", "writevSync", "read", "readSync"]);
const show = (v) => (typeof v === "string" ? v : v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : v instanceof URL ? v.href : Array.isArray(v) ? v.map(show) : typeof v === "object" && v ? "[object]" : String(v));
const done = new Set();
for (const [name, mod] of [["fs", fs], ["fs/promises", fs.promises], ["child_process", require("node:child_process")]]) {
  if (done.has(mod)) continue;
  done.add(mod);
  for (const key of Object.keys(mod)) {
    const orig = mod[key];
    if (typeof orig !== "function" || /^[A-Z]/.test(key) || SKIP.has(key)) continue;
    const wrapped = function (...args) {
      const checked = PATH_ONLY.has(key) ? args.slice(0, 1) : args;
      if (checked.some((a) => hit(a))) {
        try { append(out, JSON.stringify({ fn: name + "." + key, args: checked.map(show), main: process.argv[1] }) + "\\n"); } catch {}
      }
      return orig.apply(this, args);
    };
    Object.assign(wrapped, orig);
    mod[key] = wrapped;
  }
}
syncBuiltinESMExports();
// Every fetch to anything but loopback (the add-on's downloads go to the fixture registry only).
const realFetch = globalThis.fetch;
const loopback = (u) => { try { return ["127.0.0.1", "localhost"].includes(new URL(u).hostname); } catch { return false; } };
globalThis.fetch = function (input, init) {
  const u = String(input && input.url ? input.url : input);
  if (!loopback(u)) {
    try { append(out, JSON.stringify({ fn: "fetch", args: [u], main: process.argv[1] }) + "\\n"); } catch {}
  }
  return realFetch.call(this, input, init);
};
`;

async function main() {
  const root = mkdtempSync(join(tmpdir(), "aive-web-smoke-"));
  const dataDir = join(root, "data");
  const mediaDir = join(root, "media");
  const traceFile = join(root, "trace.jsonl");
  writeFileSync(join(root, "trace.mjs"), TRACE_MJS);
  writeFileSync(traceFile, "");
  mkdirSync(join(mediaDir, "sub"), { recursive: true });
  writeFileSync(join(mediaDir, ".hidden"), "x");
  const clip = join(mediaDir, "clip.mp4");
  const ff = spawnSync(process.env.AIVE_FFMPEG || "ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=1", "-pix_fmt", "yuv420p", clip]);
  if (ff.status !== 0) {
    console.error("ffmpeg could not generate the test clip — is FFmpeg on PATH?");
    process.exit(1);
  }

  // The graphics add-on's fixture closure, its registry and its pin (step 7b).
  const { basePkgs, buildPin, fixtureRegistry } = await import("../../../packages/core/scripts/addon-fixture.ts");
  const fixture = buildPin(basePkgs(join(root, "addon-postinstall-ran")), {}, "", { registry: "https://zr-addon-registry.invalid", storage: "https://zr-addon-storage.invalid" });
  const registry = fixtureRegistry(5033);
  registry.publish(fixture);
  await registry.start();
  const pinFile = join(root, "addon-pin.json");
  writeFileSync(pinFile, JSON.stringify(fixture.pin));

  // apps/desktop is CommonJS (no "type": "module"), so tsx runs this as CJS.
  const serverPath = join(__dirname, "..", "web", "server.cjs");
  const shell = spawn(process.execPath, [serverPath, "--port", "0", "--no-open"], {
    env: {
      ...process.env, AIVE_DATA_DIR: dataDir, AIVE_PORT: "0", NODE_OPTIONS: `--import ${pathToFileURL(join(root, "trace.mjs")).href}`, ZR_TRACE: traceFile,
      AIVE_ADDON_REGISTRY: registry.url, AIVE_ADDON_TEST_PIN: pinFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let shellLog = "";
  shell.stderr.on("data", (d) => { shellLog += d.toString(); if (process.env.SMOKE_VERBOSE) process.stderr.write(d); });
  const shellExit = new Promise<number | null>((resolve) => shell.on("exit", (code) => resolve(code)));

  const ready = await new Promise<{ url: string; port: number; corePort: number; coreOwned: boolean }>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("web shell did not report ready within 30s")), 30000);
    shell.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      for (const line of buf.split("\n")) {
        try {
          const msg = JSON.parse(line);
          if (msg.event === "ready") { clearTimeout(timer); resolve(msg); }
        } catch { /* partial or non-JSON line */ }
      }
    });
    shell.on("exit", (code) => { clearTimeout(timer); reject(new Error(`web shell exited early (code ${code})`)); });
  });
  const { port, corePort } = ready;
  const token = new URL(ready.url).searchParams.get("token") ?? "";
  const shellKey = new URL(ready.url).searchParams.get("shell") ?? "";
  const auth = { "x-aive-token": token };
  const shellAuth = { "x-zedmix-shell": shellKey };
  console.log(`web shell on :${port}, core on :${corePort}`);

  try {
    console.log("1. renderer");
    const index = await request(port, "/");
    check("GET / serves index.html", index.status === 200 && /text\/html/.test(String(index.headers["content-type"])) && index.body.includes('id="root"'));
    check("index forbids framing", /frame-ancestors 'none'/.test(String(index.headers["content-security-policy"])));
    // MUTATION: send rendererCsp() (any port) instead of the core's port from server.cjs → this row and 7's other-port row fail.
    const wantCsp = `frame-ancestors 'none'; ${netGuard.rendererCsp(corePort)}`;
    check("index's CSP header limits media, images and requests to itself and the core's exact port", index.headers["content-security-policy"] === wantCsp, String(index.headers["content-security-policy"]));
    check("…and the page carries the CSP meta tag (any core port)", index.body.includes(`<meta http-equiv="Content-Security-Policy" content="${netGuard.rendererCsp()}" />`));
    check("index sends no Referer (URL carries the token)", index.headers["referrer-policy"] === "no-referrer");
    check("launch URL carries core port + token", ready.coreOwned && new URL(ready.url).searchParams.get("port") === String(corePort) && token.length > 10);
    check("…and the shell key, which is not the core token", shellKey.length >= 32 && shellKey !== token);
    const asset = /assets\/[^"]+\.js/.exec(index.body)?.[0];
    const js = asset ? await request(port, `/${asset}`) : null;
    check("hashed JS asset served + cached immutably", !!js && js.status === 200 && /javascript/.test(String(js.headers["content-type"])) && /immutable/.test(String(js.headers["cache-control"])));
    check("favicon answered quietly", (await request(port, "/favicon.ico")).status === 204);

    console.log("2. guards");
    check("encoded ../ traversal refused", (await request(port, "/%2e%2e/%2e%2e/package.json")).status === 404);
    check("encoded slash traversal refused", (await request(port, "/..%2f..%2fpackage.json")).status === 404);
    check("foreign Host header refused (DNS rebinding)", (await request(port, "/", { host: `evil.example:${port}` })).status === 403);
    check("non-GET refused", (await request(port, "/", { method: "POST", body: "{}" })).status === 405);
    check("/api without the shell key → 401", (await request(port, "/api/config")).status === 401);
    check("/api with a wrong shell key → 401", (await request(port, "/api/config", { headers: { "x-zedmix-shell": "nope" } })).status === 401);
    const coreOnly = await request(port, "/api/config", { headers: auth });
    check("/api/config with only the core token (what server.json gives the agent) → 401", coreOnly.status === 401 && !coreOnly.body.includes(shellKey));
    check("/api/fs/list with only the core token → 401", (await request(port, `/api/fs/list?path=${encodeURIComponent(mediaDir)}`, { headers: auth })).status === 401);

    console.log("3. /api/config");
    const cfg = await request(port, "/api/config", { headers: shellAuth });
    const c = json(cfg);
    check("config ok with the shell key", cfg.status === 200 && c.ok === true && typeof c.home === "string");
    check("places include Home", Array.isArray(c.places) && c.places.some((p: { label: string }) => p.label === "Home"));
    check("MCP config resolved", c.mcp?.available === true && !!JSON.parse(String(c.mcp?.json ?? "{}")).mcpServers?.zedmix);
    check("MCP config has the one key zedmix", JSON.stringify(Object.keys(JSON.parse(String(c.mcp?.json ?? "{}")).mcpServers ?? {})) === '["zedmix"]');
    check("startup text names ZedMix", shellLog.includes("ZedMix is running at:"), shellLog);
    check("launcher logs the data dir it chose", shellLog.includes(`[aive] data dir: ${dataDir} (AIVE_DATA_DIR)`), shellLog);

    console.log("4. /api/fs/list");
    const list = await request(port, `/api/fs/list?path=${encodeURIComponent(mediaDir)}`, { headers: shellAuth });
    const l = json(list);
    const names = (l.entries ?? []).map((e: { name: string }) => e.name);
    check("lists the folder with the shell key", list.status === 200 && l.path === mediaDir && l.parent === root);
    check("folders first", names[0] === "sub" && l.entries[0].dir === true, JSON.stringify(names));
    const clipEntry = l.entries?.find((e: { name: string }) => e.name === "clip.mp4");
    check("file has size + mtime", !!clipEntry && clipEntry.size > 0 && clipEntry.mtime > 0);
    check("dotfiles flagged hidden", l.entries?.find((e: { name: string }) => e.name === ".hidden")?.hidden === true);
    check("relative path refused", (await request(port, `/api/fs/list?path=media`, { headers: shellAuth })).status === 400);
    const notDir = await request(port, `/api/fs/list?path=${encodeURIComponent(clip)}`, { headers: shellAuth });
    check("file path → 400 Not a folder", notDir.status === 400 && /^Not a folder/.test(json(notDir).error));
    check("missing folder → 404", (await request(port, `/api/fs/list?path=${encodeURIComponent(join(root, "nope"))}`, { headers: shellAuth })).status === 404);

    console.log("5. picked path → core");
    const health = await request(corePort, "/health", { headers: auth });
    check("core accepts the same token, CORS-readable", health.status === 200 && health.headers["access-control-allow-origin"] === "*");
    const picked = join(l.path, clipEntry?.name ?? "clip.mp4");
    const imp = await request(corePort, "/rpc", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ method: "import_video", params: { path: picked } }),
    });
    check("import_video accepts the picked path", imp.status === 200 && json(imp).ok === true, imp.body.slice(0, 200));
    const stream = await request(corePort, `/file?path=${encodeURIComponent(picked)}&token=${encodeURIComponent(token)}`, { headers: { range: "bytes=0-99" } });
    check("core streams it with Range (video seeking)", stream.status === 206);
    // A browser's own HLS player would fetch every segment a playlist names: /file refuses one (smoke-unc row 18).
    const playlist = join(dataDir, "renamed-playlist.mp4");
    writeFileSync(playlist, "#EXTM3U\n#EXTINF:1.0,\n//zr-csp.invalid/s/seg0.ts\n");
    const hls = await request(corePort, `/file?path=${encodeURIComponent(playlist)}&token=${encodeURIComponent(token)}`);
    check("/file answers 415 for a playlist, whatever its name", hls.status === 415 && json(hls).error === "ZedMix can't open this kind of file. If it is a playlist, manifest or list file, import the video file itself.", `${hls.status} ${hls.body.slice(0, 160)}`);

    await networkComputers({ port, corePort, token, shellKey, ready, root, dataDir, traceFile, clip });
    await graphicsAddon({ port, corePort, token, shellKey, ready, root, dataDir, traceFile, registry, fixture });

    console.log("8. shutdown");
    shell.kill("SIGTERM");
    check("web shell exits cleanly", (await shellExit) === 0);
    let coreGone = false;
    for (let i = 0; i < 25 && !coreGone; i++) {
      coreGone = await request(corePort, "/health").then(() => false, () => true);
      if (!coreGone) await new Promise((r) => setTimeout(r, 200));
    }
    check("core it started is stopped too", coreGone);
    // MUTATION: make the web shell's stop() skip core.child.kill() → this row fails (the core keeps running).
    const corePid = corePidIn(dataDir);
    check("…its process exits, not only its port", corePid !== null && (await waitFor("core process exit", () => !isCoreOf(corePid, dataDir), 10000)), `pid ${corePid}`);

    console.log("9. ports browsers refuse (ERR_UNSAFE_PORT)");
    const blocked = spawnSync(process.execPath, [serverPath, "--port", "5060", "--no-open"], {
      env: { ...process.env, AIVE_DATA_DIR: join(root, "data-blocked"), AIVE_PORT: "0" }, encoding: "utf8", timeout: 20000,
    });
    check("--port 5060 is refused with a clear message", blocked.status === 2 && /ERR_UNSAFE_PORT/.test(blocked.stderr), `exit ${blocked.status}: ${blocked.stderr}`);
    // A free port from Chromium's list for the core (5061, 6566, … could be taken on this machine).
    const free = (p: number) => new Promise<boolean>((r) => { const srv = net.createServer().once("error", () => r(false)).listen(p, "127.0.0.1", () => srv.close(() => r(true))); });
    let corePortBlocked = 0;
    for (const p of [10080, 6566, 6697, 6669, 5061]) if (await free(p)) { corePortBlocked = p; break; }
    const blockedCore = spawnSync(process.execPath, [serverPath, "--port", "0", "--no-open"], {
      env: { ...process.env, AIVE_DATA_DIR: join(root, "data-blocked-core"), AIVE_PORT: String(corePortBlocked) }, encoding: "utf8", timeout: 30000,
    });
    check(`a core on port ${corePortBlocked} stops the shell with a clear message`, blockedCore.status === 1 && /ERR_UNSAFE_PORT/.test(blockedCore.stderr), `exit ${blockedCore.status}: ${blockedCore.stderr}`);
    let blockedCoreGone = false;
    for (let i = 0; i < 25 && !blockedCoreGone; i++) {
      blockedCoreGone = await request(corePortBlocked, "/health").then(() => false, () => true);
      if (!blockedCoreGone) await new Promise((r) => setTimeout(r, 200));
    }
    check("…and stops the core it started", blockedCoreGone);
  } finally {
    await registry.stop();
    if (shell.exitCode === null) shell.kill("SIGKILL");
    // A failure part way (or the SIGKILL above) leaves the shell's core running: stop it by its pid.
    const cores = await stopLeftoverCores([dataDir, join(root, "data-blocked"), join(root, "data-blocked-core")]);
    if (cores.stopped.length) console.log(`  (stopped a core left running: ${cores.stopped.join(", ")})`);
    check("no core this smoke started is left running", cores.left.length === 0, cores.left.join(", "));
    rmSync(root, { recursive: true, force: true });
  }

  if (failures) {
    console.error(`\nWEB SMOKE FAILED (${failures} check${failures === 1 ? "" : "s"})`);
    process.exit(1);
  }
  console.log("\nWEB SMOKE PASSED");
}

/** Steps 6-7: allowing network computers through the shell (plan 9.6). */
async function networkComputers(o: {
  port: number; corePort: number; token: string; shellKey: string; ready: { url: string };
  root: string; dataDir: string; traceFile: string; clip: string;
}) {
  const { port, corePort, token, shellKey, ready, root, dataDir, traceFile, clip } = o;
  const { readTrustedHosts } = await import("@aive/core/trusthosts");
  const expect = (cond: boolean, name: string, detail = "") => check(name, cond, detail);
  /** A step the checks below build on: stop here if it did not happen. */
  const need = (cond: boolean, what: string) => {
    if (!cond) throw new Error(`setup failed: ${what}`);
  };
  const hostsFile = join(dataDir, "trust", "hosts.json");
  const viaOf = (host: string) => readTrustedHosts(dataDir).approved.find((a) => a.host === host)?.via;
  const listed = (host: string) => {
    const t = readTrustedHosts(dataDir);
    return [...t.approved, ...t.outside].some((e) => e.host === host);
  };
  /** Write an entry ZedMix did not stamp ("added outside ZedMix"), as a hand edit would. */
  const addOutside = (host: string) => {
    const cur = existsSync(hostsFile) ? JSON.parse(readFileSync(hostsFile, "utf8")) : { version: 2, servers: [] };
    cur.servers = [...cur.servers.filter((e: { host: string }) => e.host !== host), { host }];
    mkdirSync(join(dataDir, "trust"), { recursive: true, mode: 0o700 });
    writeFileSync(hostsFile, JSON.stringify(cur, null, 2));
  };
  const post = (path: string, body: unknown, headers: Record<string, string> = { "x-zedmix-shell": shellKey }) =>
    request(port, path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const rpc = async (method: string, params: object = {}) => {
    const r = await request(corePort, "/rpc", {
      method: "POST", headers: { "x-aive-token": token, "content-type": "application/json" }, body: JSON.stringify({ method, params }),
    });
    return json(r);
  };
  type Trace = { fn: string; args: string[]; main: string };
  const traced = (host: string): Trace[] => readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Trace)
    .filter((t) => JSON.stringify(t.args).includes(host));

  console.log("6. network computers: the shell key and the /api/media-servers routes");
  // The core's start probe runs Chromium with its temp folder in <data>/motion/probe-<pid>/tmp, where fontconfig
  // renames cache files while this walk runs: a file (or folder) that is gone by the time it is read can't hold the
  // key, so it is skipped; every file still there is read.
  const gone = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
  const files: string[] = [];
  const walk = (d: string) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch (e) { if (gone(e)) return; throw e; }
    for (const e of entries) (e.isDirectory() ? walk : (f: string) => files.push(f))(join(d, e.name));
  };
  walk(dataDir);
  const holdsKey = (f: string): boolean => {
    try { return statSync(f).size <= 1e7 && readFileSync(f, "utf8").includes(shellKey); } catch (e) { if (gone(e)) return false; throw e; }
  };
  check("the shell key is in no file of the data folder (server.json included)", files.length > 0 && !files.some(holdsKey),
    files.filter(holdsKey).join(", "));
  const noKey = await post("/api/media-servers/approve", { host: "zr-evil-2.invalid" }, {});
  check("POST approve without the shell key → 401, nothing stored", noKey.status === 401 && !noKey.body.includes(shellKey) && !listed("zr-evil-2.invalid"), `${noKey.status}`);
  const coreToken = await post("/api/media-servers/approve", { host: "zr-evil-2.invalid" }, { "x-aive-token": token });
  check("…with only the core token → 401, nothing stored", coreToken.status === 401 && !listed("zr-evil-2.invalid"), `${coreToken.status}`);
  // What another site can send without a preflight: a simple POST (text/plain, its Origin), no custom header.
  const crossSite = await request(port, "/api/media-servers/approve", {
    method: "POST", headers: { "content-type": "text/plain", origin: "https://evil.example" }, body: JSON.stringify({ host: "zr-evil-2.invalid" }),
  });
  check("a cross-site style POST (no custom header) → refused, nothing stored", crossSite.status === 401 && !listed("zr-evil-2.invalid"), `${crossSite.status}`);
  const preflight = await request(port, "/api/media-servers/approve", {
    method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "x-zedmix-shell" },
  });
  check("…and the CORS preflight a custom header needs is not answered", preflight.status >= 400 && !preflight.headers["access-control-allow-origin"] && !preflight.headers["access-control-allow-headers"], `${preflight.status}`);
  const getApprove = await request(port, "/api/media-servers/approve?host=zr-evil-2.invalid", { headers: { "x-zedmix-shell": shellKey } });
  check("GET approve → 405, nothing stored", getApprove.status === 405 && !listed("zr-evil-2.invalid"), `${getApprove.status}`);
  const bad = await post("/api/media-servers/approve", { host: "nas@SSL" });
  check("a host that can't be allowed → 400", bad.status === 400 && /Not a network computer name/.test(json(bad).error ?? ""), `${bad.status} ${bad.body}`);
  const approved = await post("/api/media-servers/approve", { host: "ZR-EVIL-2.invalid" });
  check("POST approve with the shell key → stored as allowed (normalized, via prompt)", approved.status === 200 && json(approved).approved === true && viaOf("zr-evil-2.invalid") === "prompt", `${approved.status} ${approved.body}`);
  check("…and the core sees it at once", (await rpc("list_media_servers")).result?.approved?.some((a: { host: string }) => a.host === "zr-evil-2.invalid") === true);
  const revoked = await post("/api/media-servers/revoke", { host: "zr-evil-2.invalid" });
  check("POST revoke → removed", revoked.status === 200 && json(revoked).removed === true && !listed("zr-evil-2.invalid"), revoked.body);
  addOutside("zr-evil-6.invalid");
  await post("/api/media-servers/approve", { host: "zr-evil-8.invalid" });
  const keptRemove = await post("/api/media-servers/revoke", { host: "zr-evil-8.invalid", onlyIfOutside: true });
  check("POST revoke onlyIfOutside on an allowed server → removes nothing ({removed: false})", json(keptRemove).removed === false && viaOf("zr-evil-8.invalid") === "prompt", keptRemove.body);
  const outsideRemove = await post("/api/media-servers/revoke", { host: "zr-evil-6.invalid", onlyIfOutside: true });
  check("…on one added outside ZedMix → removed", json(outsideRemove).removed === true && !listed("zr-evil-6.invalid"), outsideRemove.body);
  await post("/api/media-servers/revoke", { host: "zr-evil-8.invalid" });

  const pickedPath = "//zr-pick.invalid/s/a.mp4";
  const unlisted = await post("/api/media-servers/picked", { paths: [pickedPath, clip] });
  check("picked on a server the shell never listed → needsApproval, not stored",
    unlisted.status === 200 && JSON.stringify(json(unlisted).needsApproval) === '["zr-pick.invalid"]' && !listed("zr-pick.invalid"), unlisted.body);
  const listing = await request(port, `/api/fs/list?path=${encodeURIComponent("//zr-pick.invalid/s")}`, { headers: { "x-zedmix-shell": shellKey } });
  console.log(`  (listed //zr-pick.invalid/s: ${listing.status}; on Linux it is a missing local folder, and the shell notes the server either way)`);
  // Plan 2.2: a device path, or a server name that can't be allowed, is refused before the shell reads anything.
  // MUTATION: drop the refused check in listDir → these rows get 404 (a missing local folder) and the trace shows the readdir.
  for (const p of ["//./UNC/zr-evil-refused.invalid/s", "//zr-evil-refused.invalid@SSL/s"]) {
    const refusedList = await request(port, `/api/fs/list?path=${encodeURIComponent(p)}`, { headers: { "x-zedmix-shell": shellKey } });
    check(`/api/fs/list ${p} → 400 with the refusal`, refusedList.status === 400 && String(json(refusedList).error).startsWith(`Refusing to open ${p}: `), `${refusedList.status} ${refusedList.body.slice(0, 160)}`);
  }
  check("…and nothing in the shell read those paths", traced("zr-evil-refused").length === 0, JSON.stringify(traced("zr-evil-refused")).slice(0, 300));
  const pickedRes = await post("/api/media-servers/picked", { paths: [pickedPath] });
  check("…then picked on it → allowed (via picker)", JSON.stringify(json(pickedRes).approved) === '["zr-pick.invalid"]' && viaOf("zr-pick.invalid") === "picker", pickedRes.body);
  check("GET picked → 405", (await request(port, "/api/media-servers/picked", { headers: { "x-zedmix-shell": shellKey } })).status === 405);

  console.log("7. network computers in the page (headless Chromium)");
  // Projects made from a saved one: the imported clip's asset on a test server, or a name that is a path.
  need((await rpc("append_clip", { assetId: (await rpc("get_state")).result?.assets?.[0]?.id })).ok === true, "a clip on the timeline");
  const basePath = join(root, "base.aive");
  need((await rpc("save_project", { path: basePath })).ok === true, "the project saved as base.aive");
  const base = JSON.parse(readFileSync(basePath, "utf8"));
  const craft = (file: string, edit: (p: typeof base) => void) => {
    const p = structuredClone(base);
    edit(p);
    writeFileSync(join(root, file), JSON.stringify(p));
    return join(root, file);
  };
  const onServer = (host: string) => (p: typeof base) => {
    for (const a of p.assets) {
      a.path = `//${host}/s/a.mp4`;
      delete a.proxyPath;
      delete a.previewPath;
    }
  };
  const crafted1 = craft("crafted1.aive", onServer("zr-evil-1.invalid"));
  const crafted3 = craft("crafted3.aive", onServer("zr-evil-3.invalid"));
  const craftedName = craft("crafted-name.aive", (p) => { p.name = "\\\\zr-evil.invalid\\s\\x"; });

  const pw = await loadPlaywright();
  const exe = chromiumPath();
  const browser = await pw.chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-audio-output", "--mute-audio"] });
  try {
    const evil: string[] = [];
    const picked: string[] = [];
    const pageErrors: string[] = [];
    const revokes: number[] = [];
    const open = async () => {
      const page = await browser.newPage();
      // A step that fails reports a FAIL and the run goes on, instead of waiting 30 s and stopping.
      page.setDefaultTimeout(5000);
      page.on("request", (q) => {
        const u = decodeURIComponent(q.url());
        if (u.includes("zr-evil")) evil.push(u);
        if (u.includes("/api/media-servers/picked")) picked.push(q.postData() ?? "");
      });
      page.on("response", (r) => { if (r.url().includes("/api/media-servers/revoke")) revokes.push(r.status()); });
      page.on("pageerror", (e) => pageErrors.push(e.message));
      await page.goto(ready.url);
      return page;
    };
    const a = await open();
    need(await waitFor("Core pill", async () => (await a.locator(".statuspill.ok").count()) > 0), "the page connects to the core");
    expect(!a.url().includes("token=") && !a.url().includes("shell="), `the page takes the token and the shell key out of the address bar (${a.url()})`);
    // The CSP (header with the core's exact port, and the meta tag): media from the core's address on
    // another port, or from another computer, is refused before any request is made.
    const otherPort = corePort === 65535 ? corePort - 1 : corePort + 1;
    const cspRequests: string[] = [];
    a.on("request", (q) => { if (q.url().includes("zr-csp.invalid") || q.url().includes(`:${otherPort}/`)) cspRequests.push(q.url()); });
    for (const src of [`http://127.0.0.1:${otherPort}/file?path=x`, "http://zr-csp.invalid/a.mp4"]) {
      const v = await a.evaluate((src) => new Promise<{ directive: string; uri: string } | null>((res) => {
        document.addEventListener("securitypolicyviolation", (e) => res({ directive: e.effectiveDirective, uri: e.blockedURI }), { once: true });
        const el = document.createElement("video");
        el.src = src;
        setTimeout(() => res(null), 5000);
      }), src);
      expect(v?.directive === "media-src" && src.startsWith(v.uri.replace(/\/$/, "")), `a media element pointed at ${src.split("/file")[0].replace("/a.mp4", "")} raises a media-src violation (${JSON.stringify(v)})`);
    }
    expect(cspRequests.length === 0, `…and no request is made (${cspRequests.join(", ") || "none"})`);
    const banner = (p: Page) => p.locator(".ms-banner").innerText().catch(() => "");
    const badgeLabel = (p: Page) => p.locator(".asset-card.offline .offline-badge").first().getAttribute("aria-label").catch(() => null);
    const dialog = (p: Page) => p.getByRole("alertdialog");
    const focused = (p: Page) => p.evaluate(() => ({
      text: document.activeElement?.textContent ?? "",
      inside: !!document.activeElement?.closest("[role=alertdialog]"),
    }));
    const review = async (p: Page, host: string) => {
      const button = p.getByRole("button", { name: `Review \\\\${host}…`, exact: true });
      if (!(await waitFor("Review… button", async () => (await button.count()) > 0, 10000))) return false;
      if (!(await button.click().then(() => true, () => false))) return false;
      return waitFor("approval dialog", async () => (await dialog(p).count()) === 1, 10000);
    };
    /** Click a button of the open approval dialog; false when there is none. */
    const choose = (p: Page, name: string) => dialog(p).getByRole("button", { name, exact: true }).click().then(() => true, () => false);
    const evilFor = (host: string) => evil.filter((u) => u.includes(host));

    // Plan 9.6 step 4: a project on a server not allowed.
    await rpc("load_project", { path: crafted1 });
    expect(await waitFor("project banner", async () => /This project uses 1 file on the network computer \\\\zr-evil-1\.invalid\. They stay offline until you allow it/.test(await banner(a))),
      `banner: "${(await banner(a)).replace(/\s+/g, " ")}"`);
    expect(await waitFor("badge", async () => (await badgeLabel(a)) === "Offline: waiting for you to allow \\\\zr-evil-1.invalid"), `media pool badge (${await badgeLabel(a)})`);
    expect(await review(a, "zr-evil-1.invalid"), "Review… opens the in-app dialog");
    const d = dialog(a);
    const attr = (n: string) => d.getAttribute(n).catch(() => null);
    expect((await attr("aria-modal")) === "true" && !!(await attr("aria-labelledby")) && !!(await attr("aria-describedby")),
      "…an alertdialog: modal, labelled and described");
    const dText = (await d.innerText().catch(() => "")).replace(/\s+/g, " ");
    expect(dText.includes("Allow media from \\\\zr-evil-1.invalid?") && dText.includes("This project uses 1 file stored there, for example //zr-evil-1.invalid/s/a.mp4."),
      `…with the Allow wording (${dText.slice(0, 160)})`);
    let f = await focused(a);
    expect(f.inside && f.text === "Keep offline", `…focus starts on Keep offline (${f.text})`);
    await a.keyboard.press("Tab");
    const f2 = await focused(a);
    await a.keyboard.press("Tab");
    f = await focused(a);
    expect(f2.inside && f2.text === "Allow" && f.inside && f.text === "Keep offline", `…Tab stays inside (${f2.text}, then ${f.text})`);
    await a.keyboard.press("Escape");
    expect(await waitFor("dialog closed", async () => (await dialog(a).count()) === 0, 5000), "Esc closes it");
    await sleep(500);
    expect(!listed("zr-evil-1.invalid") && (await badgeLabel(a)) !== null, "…and keeps it offline (the store is unchanged)");
    expect(evilFor("zr-evil-1").length === 0, `the page asked for none of its files (${evilFor("zr-evil-1").join(", ") || "none"})`);
    expect(traced("zr-evil-1").length === 0, `nothing in the shell or the core touched it (${JSON.stringify(traced("zr-evil-1")).slice(0, 300)})`);
    await review(a, "zr-evil-1.invalid");
    await choose(a, "Allow");
    expect(await waitFor("allowed", () => viaOf("zr-evil-1.invalid") === "prompt", 10000), "Allow → the store has it (via prompt)");
    expect(await waitFor("online", async () => (await a.locator(".asset-card.offline").count()) === 0, 10000), "…and the clip comes online without a reload");

    // Plan 9.6 step 5: Save As with a project named like a path.
    await rpc("load_project", { path: craftedName });
    expect(await waitFor("project x", async () => (await a.locator(".proj-name").innerText().catch(() => "")).trim().startsWith("x")),
      `a project named \\\\zr-evil.invalid\\s\\x opens as "${(await a.locator(".proj-name").innerText().catch(() => "")).trim()}"`);
    const saveDir = join(root, "saved");
    // A folder row the picker shows once it lists saveDir (the start folder has none named so), and a project file
    // to double-click there.
    mkdirSync(join(saveDir, "listed-here"), { recursive: true });
    writeFileSync(join(saveDir, "old.aive"), "{}");
    await a.getByRole("button", { name: /Project/ }).click().catch(() => {});
    await a.getByRole("menuitem", { name: /^Save As/ }).click().catch(() => {});
    const picker = a.getByRole("dialog", { name: "Save project as" });
    expect(await waitFor("picker", async () => (await picker.count()) === 1, 10000), "Save As opens the in-app picker");
    const nameField = picker.locator(".picker-filename input");
    expect((await nameField.inputValue().catch(() => "")) === "x.aive", `…with the name field "${await nameField.inputValue().catch(() => "")}"`);
    const pathBar = picker.getByRole("textbox", { name: "Folder path" });
    // The picker opens on its start folder, and that listing writes its path into the bar unless something was typed.
    // fill() selects the bar's text, then types in a second round trip: a listing landing between the two left its path
    // in front of the typed one, so Enter listed nothing and Save wrote into the start folder. Type once it has landed.
    await waitFor("start folder", async () => (await pathBar.inputValue().catch(() => "")) !== "", 10000);
    await pathBar.fill(saveDir).catch(() => {});
    // Hold saveDir's listing: until it lands the picker still shows the start folder, and Save must not write there.
    // MUTATION: drop `loading` from pathpicker.tsx confirmSave and canConfirm → x.aive goes to the start folder here.
    let release = () => {};
    const held = new Promise<void>((r) => { release = r; });
    let parked = false;
    const fsList = /\/api\/fs\/list\?/;
    await a.route(fsList, async (route) => { parked = true; await held; await route.continue().catch(() => {}); });
    await pathBar.press("Enter").catch(() => {});
    await waitFor("saved folder requested", () => parked, 5000);
    const saveButton = picker.getByRole("button", { name: "Save", exact: true });
    const disabled = await saveButton.isDisabled().catch(() => false);
    await saveButton.click({ force: true, timeout: 1000 }).catch(() => {});
    await nameField.press("Enter").catch(() => {});
    expect(parked && disabled && (await picker.count()) === 1 && !existsSync(join(saveDir, "x.aive")),
      `…Save waits while the typed folder is being listed (${parked ? "" : "no listing asked for; "}Save ${disabled ? "disabled" : "enabled"}, picker ${(await picker.count()) === 1 ? "open" : "closed"})`);
    release();
    await a.unroute(fsList);
    expect(await waitFor("listing", async () => (await picker.locator('.picker-row[title="listed-here"]').count()) === 1, 10000), "…then lists it");
    // A folder typed into the bar but not listed, then one that fails to list: saveDir stays on screen while the bar
    // names the other folder, and Save must not write into saveDir. The listing is routed to fail.
    // MUTATION: drop `error` and the path bar check from pathpicker.tsx's folderReady → x.aive goes into saveDir here,
    // and the typed-only row fails. Skip confirmSave's check only when activate() calls it → the double-click asks
    // "Replace it?" and this row fails.
    const missing = join(root, "zr-missing");
    await pathBar.fill(missing).catch(() => {});
    const typedOnly = await saveButton.isDisabled().catch(() => false);
    expect(typedOnly, `…Save waits while the path bar names a folder not listed yet (Save ${typedOnly ? "disabled" : "enabled"})`);
    let refused = 0;
    await a.route(fsList, async (route) => {
      refused++;
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: `Not found: ${missing}` }) }).catch(() => {});
    });
    await pathBar.press("Enter").catch(() => {});
    const pickerError = picker.locator(".picker-error");
    await waitFor("listing error", async () => (await pickerError.count()) === 1, 5000);
    const errorText = (await pickerError.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    const failedOff = await saveButton.isDisabled().catch(() => false);
    // A double-click on a file saves over it, after a "Replace it?" confirm (dismissed here, so nothing is written).
    const asked: string[] = [];
    a.on("dialog", (d) => { asked.push(d.message()); d.dismiss().catch(() => {}); });
    await saveButton.click({ force: true, timeout: 1000 }).catch(() => {});
    await nameField.press("Enter").catch(() => {});
    const oldFile = picker.locator('.picker-row[title="old.aive"]');
    const fileShown = (await oldFile.count()) === 1;
    await oldFile.dblclick({ timeout: 1000 }).catch(() => {});
    const stillOpen = (await picker.count()) === 1;
    await a.unroute(fsList);
    expect(refused > 0 && failedOff && stillOpen && fileShown && asked.length === 0 && !existsSync(join(saveDir, "x.aive"))
      && errorText.includes(`Not found: ${missing}`) && errorText.includes("Fix the path and press Enter"),
      `…nor after the folder typed fails to list, with an error that says what to do ("${errorText}"; Save ${failedOff ? "disabled" : "enabled"}, picker ${stillOpen ? "open" : "closed"}${fileShown ? "" : ", no old.aive row to double-click"}${asked.length ? `, asked "${asked.join(" | ")}"` : ""})`);
    // The double-click's first click put old.aive in the name field.
    await nameField.fill("x.aive").catch(() => {});
    await pathBar.fill(saveDir).catch(() => {});
    await pathBar.press("Enter").catch(() => {});
    expect(await waitFor("listed again", async () => (await pickerError.count()) === 0 && (await saveButton.isEnabled().catch(() => false)), 10000),
      "…and a folder that lists clears the error and turns Save back on");
    await saveButton.click().catch(() => {});
    expect(await waitFor("saved", () => existsSync(join(saveDir, "x.aive")), 10000), "Save writes x.aive into the folder listed");
    expect(picked.every((b) => !b.includes("zr-evil.invalid")) && !listed("zr-evil.invalid"), `/api/media-servers/picked got no zr-evil.invalid path (${picked.join(" | ") || "no call"}); the store is unchanged`);

    // Plan 9.6 step 6: added outside ZedMix.
    addOutside("zr-evil-3.invalid");
    await rpc("load_project", { path: crafted3 });
    const outsideBanner = /This project uses 1 file on \\\\zr-evil-3\.invalid\. It is in your list of allowed network computers, but ZedMix didn't put it there/;
    expect(await waitFor("outside banner", async () => outsideBanner.test(await banner(a))), `outside entry: banner "${(await banner(a)).replace(/\s+/g, " ")}"`);
    expect(await review(a, "zr-evil-3.invalid"), "Review… opens the in-app dialog");
    const kText = (await dialog(a).innerText().catch(() => "")).replace(/\s+/g, " ");
    expect(kText.includes("Keep \\\\zr-evil-3.invalid?") && kText.includes("was added to your allowed network computers outside ZedMix"), `…the Keep dialog (${kText.slice(0, 120)})`);
    f = await focused(a);
    expect(f.inside && f.text === "Remove", `…focus starts on Remove (${f.text})`);
    await a.keyboard.press("Escape");
    expect(await waitFor("removed", () => !listed("zr-evil-3.invalid"), 10000), "Esc removes it from the store");
    expect(await waitFor("allow banner", async () => /This project uses 1 file on the network computer \\\\zr-evil-3\.invalid\. They stay offline until you allow it/.test(await banner(a)), 10000),
      "…and the project now asks to allow it");
    expect(traced("zr-evil-3").length === 0 && evilFor("zr-evil-3").length === 0, "nothing touched zr-evil-3 so far");
    addOutside("zr-evil-3.invalid");
    expect(await waitFor("outside banner again", async () => outsideBanner.test(await banner(a))), "written again: the outside banner is back");
    await review(a, "zr-evil-3.invalid");
    await choose(a, "Keep");
    expect(await waitFor("kept", () => viaOf("zr-evil-3.invalid") === "prompt", 10000), "Keep → allowed with a valid stamp (via prompt)");
    expect(await waitFor("online", async () => (await a.locator(".asset-card.offline").count()) === 0, 10000), "…and the clip comes online");

    // Two UI hosts: Keep in page A, then Esc in page B.
    addOutside("zr-evil-3.invalid");
    const b = await open();
    need(await waitFor("page B", async () => (await b.locator(".statuspill.ok").count()) > 0), "a second page of the same shell connects");
    expect(await waitFor("outside in both", async () => outsideBanner.test(await banner(a)) && outsideBanner.test(await banner(b))), "both pages show the outside banner");
    expect((await review(a, "zr-evil-3.invalid")) && (await review(b, "zr-evil-3.invalid")), "the Keep dialog is open in both");
    await choose(a, "Keep");
    expect(await waitFor("kept by A", () => viaOf("zr-evil-3.invalid") === "prompt", 10000), "Keep in page A → allowed");
    f = await focused(b);
    revokes.length = 0;
    await b.keyboard.press("Escape");
    expect(await waitFor("B answered", () => revokes.length > 0, 10000) && revokes[0] === 200, `Esc in page B sends its Remove (${revokes.join()})`);
    expect(f.text === "Remove" && viaOf("zr-evil-3.invalid") === "prompt", "…which leaves it allowed with a valid stamp (it was kept meanwhile)");
    expect(await waitFor("B closed", async () => (await dialog(b).count()) === 0, 5000), "page B's dialog closes");
    expect(await waitFor("both online", async () => (await a.locator(".asset-card.offline").count()) === 0 && (await b.locator(".asset-card.offline").count()) === 0
      && (await a.locator(".asset-card").count()) > 0 && (await b.locator(".asset-card").count()) > 0, 10000), "both pages show the clip online");

    expect(traced("zr-evil.invalid").length === 0, "nothing ever touched zr-evil.invalid (the Save As name)");
    const pick = traced("zr-pick");
    expect(pick.length > 0 && pick.every((t) => t.main.endsWith("server.cjs") && /readdir/.test(t.fn)),
      `zr-pick.invalid: only the shell's listing of the folder sent to the picker (${pick.map((t) => `${t.fn} ${t.args[0]}`).join(", ")})`);
    expect(pageErrors.length === 0, `no page errors (${pageErrors.join(" | ")})`);
  } finally {
    await browser.close();
  }
}

/** Step 7b: the graphics add-on through the shell (ADDON-PLAN D8.5). */
async function graphicsAddon(o: {
  port: number; corePort: number; token: string; shellKey: string; ready: { url: string };
  root: string; dataDir: string; traceFile: string;
  registry: import("../../../packages/core/scripts/addon-fixture.ts").FixtureRegistry;
  fixture: import("../../../packages/core/scripts/addon-fixture.ts").Fixture;
}) {
  const { port, corePort, token, shellKey, ready, dataDir, traceFile, registry, fixture } = o;
  const { addonPlatform, graphicsAddonDir, graphicsAddonTerms, readGraphicsAddon } = await import("@aive/core/addon");
  const platform = addonPlatform();
  console.log("7b. the graphics add-on: the shell key, then the dialog in the page");
  if (!platform) {
    console.log(`  skip: ${process.platform}-${process.arch} has no add-on`);
    return;
  }
  const terms = graphicsAddonTerms(platform);
  const state = () => readGraphicsAddon(dataDir, { pin: fixture.pin }).state;
  const zipPath = new URL(fixture.pin.shell[platform].url).pathname;
  const wanted = [...fixture.pin.lists[platform].paths.map((p) => new URL(fixture.pin.closure.find((e) => e.path === p)!.resolved).pathname), zipPath].sort();
  const shellAuth = { "x-zedmix-shell": shellKey };
  const post = (path: string, body: unknown, headers: Record<string, string>) =>
    request(port, path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  // MUTATION: serve /api/graphics-addon/* before the shell-key check in server.cjs → the 401 rows fail. Serve only
  // POST /api/graphics-addon/cancel before it → they fail too.
  for (const [what, headers] of [["without the shell key", {}], ["with only the core token", { "x-aive-token": token }]] as const) {
    const st = await request(port, "/api/graphics-addon/status", { headers });
    const tm = await request(port, "/api/graphics-addon/terms", { headers });
    const ins = await post("/api/graphics-addon/install", { acceptedLicenseSha256: terms.sha256 }, headers);
    const rem = await post("/api/graphics-addon/remove", {}, headers);
    const can = await post("/api/graphics-addon/cancel", {}, headers);
    // MUTATION: serve POST /api/graphics-addon/renderer before the shell-key check in server.cjs → this row fails.
    const ren = await post("/api/graphics-addon/renderer", { renderer: "remotion" }, headers);
    await sleep(500);
    check(`GET status and terms, POST install, remove, cancel and renderer ${what} → 401; nothing installed, fetched or written`,
      [st, tm, ins, rem, can, ren].every((r) => r.status === 401) && registry.hits.size === 0 && !existsSync(join(dataDir, "addons")), [st, tm, ins, rem, can, ren].map((r) => r.status).join());
  }
  const st = await request(port, "/api/graphics-addon/status", { headers: shellAuth });
  check("GET status with the shell key → not installed", st.status === 200 && json(st).state === "not-installed" && json(st).version === "4.0.481", st.body.slice(0, 200));
  check("GET install → 405", (await request(port, "/api/graphics-addon/install", { headers: shellAuth })).status === 405);

  // A new project: the one step 7 left names files on test servers, which the page would ask for.
  const fresh = await request(corePort, "/rpc", { method: "POST", headers: { "x-aive-token": token, "content-type": "application/json" }, body: JSON.stringify({ method: "new_project", params: {} }) });
  check("a new project in the core", fresh.status === 200, fresh.body.slice(0, 120));
  const pw = await loadPlaywright();
  const exe = chromiumPath();
  const browser = await pw.chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-audio-output", "--mute-audio"] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    // The page's own socket, for the fixture job below.
    await page.addInitScript(`(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) { window.__ws = this; return send.call(this, d); };
    })()`);
    await page.goto(ready.url);
    check("the page connects", await waitFor("Core pill", async () => (await page.locator(".statuspill.ok").count()) > 0));
    const dlg = page.getByRole("dialog", { name: /Graphics add-on/ });
    const button = (name: string) => dlg.getByRole("button", { name, exact: true });
    const text = () => dlg.innerText().catch(() => "");
    const openDialog = async () => {
      await page.getByRole("button", { name: "Help", exact: true }).click();
      await page.getByRole("menuitem", { name: "Graphics add-on…" }).click();
      return waitFor("add-on dialog", async () => (await dlg.count()) > 0 && !(await text()).includes("Loading…"), 10000);
    };
    const closeDialog = async () => {
      await button("Close").last().click();
      await waitFor("dialog closed", async () => (await dlg.count()) === 0, 5000);
    };

    check("Help → Graphics add-on… opens the dialog", await openDialog());
    const notice = await dlg.locator(".ga-notice").allTextContents();
    const license = await dlg.locator(".ga-license").textContent();
    check("it shows the notice and Remotion's licence exactly as the core gives them, and Accept and install",
      JSON.stringify(notice) === JSON.stringify(terms.notice.split("\n\n").filter((p) => p.trim())) && license === terms.license && (await button("Accept and install").count()) === 1,
      `${notice.length} paragraphs, ${license?.length ?? 0} characters`);
    check("…and nothing is fetched before Accept", registry.hits.size === 0 && state() === "not-installed");

    // Another window holds the install lock (a live pid): its message, and no install button until it clears.
    // MUTATION: report no `busy` from graphics-addon.cjs status() → this row fails.
    mkdirSync(join(dataDir, "addons"), { recursive: true });
    const lock = join(dataDir, "addons", ".install.lock");
    writeFileSync(lock, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), via: "desktop", token: "zr-fixture" })}\n`);
    await closeDialog();
    await openDialog();
    check("another window's install lock: its message, and no install button",
      (await text()).includes("Another ZedMix window is installing the graphics add-on (desktop). Wait for it to finish.") && (await button("Accept and install").count()) === 0,
      (await text()).replace(/\s+/g, " ").slice(0, 160));
    // A status request that fails once while the dialog follows the lock: its error shows, and the next request
    // that succeeds clears it. The page logs that 503 (a response and a console line); those are expected here.
    // MUTATION: never clear the failed poll's error in refresh() (graphicsaddon.tsx) → this row fails.
    const errorsBefore = errors.length;
    await page.route("**/api/graphics-addon/status", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "zr-fixture: the status request failed" }) }), { times: 1 });
    const alert = dlg.locator(".storage-error");
    const pollError = await waitFor("poll error", async () => (await alert.innerText().catch(() => "")).includes("zr-fixture: the status request failed"), 5000);
    const pollCleared = pollError && (await waitFor("poll error cleared", async () => (await alert.count()) === 0 && (await text()).includes("Another ZedMix window is installing"), 5000));
    const logged = errors.splice(errorsBefore);
    check("a status request that fails once while the dialog follows the lock: its error, then cleared by the next one",
      pollError && pollCleared && logged.every((e) => /503/.test(e)), `${pollError} ${pollCleared} ${JSON.stringify(logged)}`);
    rmSync(lock);
    check("…until the lock clears", await waitFor("lock cleared", async () => (await button("Accept and install").count()) === 1, 10000));

    // MUTATION: make /api/graphics-addon/cancel do nothing in server.cjs → the cancel row ends "ready".
    registry.answers.set(zipPath, "hold");
    await button("Accept and install").click();
    check("Accept and install shows its progress and Cancel",
      await waitFor("progress", async () => /Installing… \d+ MB of \d+ MB/.test(await dlg.locator(".ga-progress").innerText().catch(() => "")), 10000) && (await button("Cancel").count()) === 1,
      (await dlg.locator(".ga-progress").innerText().catch(() => "")).replace(/\s+/g, " "));
    await button("Cancel").click();
    check("Cancel → \"cancelled\", nothing installed",
      await waitFor("cancelled", async () => (await text()).includes("The graphics add-on install was cancelled. Nothing was installed."), 10000) && state() === "not-installed"
      && JSON.stringify(readdirSync(join(dataDir, "addons"))) === "[]", (await text()).replace(/\s+/g, " ").slice(0, 200));
    registry.answers.clear();

    // The dialog closed while an install runs that then fails (the zip answers 500): opened again, it shows the
    // D3.8 message once, and not on the next open.
    // MUTATION: drop the status.last branch from refresh() (graphicsaddon.tsx) → the reopened row fails. Show
    // status.last on every open (drop the shownJob comparison) → the next-open row fails.
    const failed = `${new URL(registry.url).host} answered 500 for the Chrome headless shell. Try again later.`;
    registry.answers.set(zipPath, { delay: 3000, status: 500 });
    await button("Accept and install").click();
    const started = await waitFor("progress", async () => (await dlg.locator(".ga-progress").count()) === 1, 10000);
    await closeDialog();
    const ended = await waitFor("install ended", async () => {
      const s = json(await request(port, "/api/graphics-addon/status", { headers: shellAuth }));
      return s.job === null && s.last?.ok === false;
    }, 20000);
    registry.answers.clear();
    await openDialog();
    const reopened = (await text()).replace(/\s+/g, " ");
    check("an install that fails while the dialog is closed: opened again, the dialog shows the D3.8 message",
      started && ended && reopened.includes(failed) && (await dlg.getByRole("alert").innerText().catch(() => "")) === failed && (await button("Accept and install").count()) === 1 && state() === "not-installed",
      reopened.slice(0, 200));
    await closeDialog();
    await openDialog();
    const again = (await text()).replace(/\s+/g, " ");
    check("…once: the next open doesn't show it again", !again.includes(failed) && (await button("Accept and install").count()) === 1, again.slice(0, 200));

    registry.hits.clear();
    await button("Accept and install").click();
    check("Accept and install → \"Graphics are ready.\" and ready", await waitFor("ready", async () => (await text()).includes("Graphics are ready."), 20000) && state() === "ready", state());
    check("…fetching exactly the platform's tarballs and its browser zip", JSON.stringify(registry.hitPaths()) === JSON.stringify(wanted), JSON.stringify(registry.hitPaths()));
    const manifest = JSON.parse(readFileSync(join(graphicsAddonDir(dataDir), "addon.json"), "utf8"));
    check("addon.json: via web, the accepted terms' hash", manifest.via === "web" && manifest.licenseSha256 === terms.sha256, `${manifest.via}`);
    // The ready view comes from the status refresh after "Graphics are ready.", a moment later.
    const readyView = async () => (await button("Remove").count()) === 1 && (await button("Reinstall").count()) === 1 && (await text()).includes(`Remotion ${manifest.remotion} is installed`);
    check("ready: the version, Remove and Reinstall", await waitFor("the ready view", readyView, 10000));

    // A graphic renders (a fixture job of type "graphic" on the page's own socket).
    // MUTATION: drop `blocked` from the Reinstall button in graphicsaddon.tsx → the disabled row fails.
    const job = (status: string) => page.evaluate((status) => {
      const job = { id: "zr-fixture-graphic", type: "graphic", label: "Render motion graphic", status, fraction: 0.3, startedAt: Date.now() };
      (window as unknown as { __ws: WebSocket }).__ws.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "job", job }) }));
    }, status);
    await job("running");
    check("while a graphic renders, Remove and Reinstall are disabled: \"Wait for the graphic to finish.\"",
      await waitFor("disabled", async () => (await button("Remove").isDisabled()) && (await button("Reinstall").isDisabled()), 5000) && (await text()).includes("Wait for the graphic to finish."));
    await job("done");
    check("…and enabled once it is done", await waitFor("enabled", async () => (await button("Remove").isEnabled()) && (await button("Reinstall").isEnabled()), 5000));

    await button("Remove").click();
    check("Remove → not installed, its folder gone", await waitFor("removed", async () => (await button("Accept and install").count()) === 1, 10000) && state() === "not-installed" && !existsSync(graphicsAddonDir(dataDir)));

    // A copy whose browser went missing: "damaged", with Reinstall and Remove.
    // MUTATION: offer Remove only when ready (graphicsaddon.tsx, slice 3) → the damaged rows fail.
    await button("Accept and install").click();
    await waitFor("ready again", async () => (await text()).includes("Graphics are ready."), 20000);
    const breakIt = async () => {
      await closeDialog();
      rmSync(join(graphicsAddonDir(dataDir), "browser", fixture.pin.shell[platform].executable));
      await openDialog();
    };
    await breakIt();
    check("a copy whose browser is gone: \"damaged\", Reinstall and Remove",
      state() === "broken" && (await text()).includes("The graphics add-on is damaged (missing files).") && (await button("Reinstall").count()) === 1 && (await button("Remove").count()) === 1);
    await button("Reinstall").click();
    check("Reinstall repairs it", await waitFor("repaired", async () => (await text()).includes("Graphics are ready."), 20000) && state() === "ready");
    await breakIt();
    await button("Remove").click();
    check("Remove of a damaged copy → not installed, its folder gone",
      await waitFor("removed", async () => (await button("Accept and install").count()) === 1, 10000) && state() === "not-installed" && !existsSync(graphicsAddonDir(dataDir)));
    await closeDialog();

    // The graphics renderer setting (MOTION-PLAN D7): ZedMix's by default; a click on "Remotion add-on" in the
    // dialog makes the shell write renderer.json (behind its shell key; GET is 405).
    // MUTATION: make POST /api/graphics-addon/renderer do nothing in server.cjs → the click row fails.
    const rendererFile = join(dataDir, "addons", "renderer.json");
    const radio = (name: RegExp) => dlg.getByRole("radio", { name });
    check("GET renderer → 405", (await request(port, "/api/graphics-addon/renderer", { headers: shellAuth })).status === 405);
    const badRenderer = await post("/api/graphics-addon/renderer", { renderer: "chrome" }, shellAuth);
    check("POST renderer with another value → 400, nothing written", badRenderer.status === 400 && !existsSync(rendererFile), `${badRenderer.status} ${badRenderer.body.slice(0, 100)}`);
    await openDialog();
    check("the dialog's Graphics renderer: ZedMix's (the default) is chosen, no renderer.json",
      (await radio(/^ZedMix/).isChecked()) && !(await radio(/^Remotion add-on/).isChecked()) && !existsSync(rendererFile));
    await radio(/^Remotion add-on/).click();
    const chose = await waitFor("renderer.json", async () => existsSync(rendererFile) && JSON.parse(readFileSync(rendererFile, "utf8")).renderer === "remotion" && (await radio(/^Remotion add-on/).isChecked()), 5000);
    const gs = await request(corePort, "/rpc", { method: "POST", headers: { "x-aive-token": token, "content-type": "application/json" }, body: JSON.stringify({ method: "get_state", params: {} }) });
    check("a click on \"Remotion add-on\": the shell writes renderer.json, get_state says graphicsRenderer \"remotion\"",
      chose && json(gs).result?.graphicsRenderer === "remotion", `${json(gs).result?.graphicsRenderer} ${json(gs).result?.graphics}`);
    await closeDialog();

    // The agent's add_graphic with no add-on: refused, and the banner offers the dialog.
    // MUTATION: render no GraphicsAddonBanner in App.tsx → the banner row fails.
    const res = await request(corePort, "/rpc", {
      method: "POST", headers: { "x-aive-token": token, "content-type": "application/json" },
      body: JSON.stringify({ method: "add_graphic", params: { code: "export default () => null;", durationSeconds: 1 } }),
    });
    check("add_graphic over the core's HTTP RPC with no add-on → 409 graphics_addon_missing", res.status === 409 && json(res).code === "graphics_addon_missing", `${res.status} ${res.body.slice(0, 120)}`);
    const banner = page.locator(".ga-banner");
    check("…and the page shows the banner",
      await waitFor("banner", async () => (await banner.count()) > 0, 10000) && (await banner.innerText()).includes("The AI asked for a graphic. Graphics need the Remotion add-on."),
      (await banner.innerText().catch(() => "")).replace(/\s+/g, " "));
    await banner.getByRole("button", { name: "Set up…" }).click();
    check("Set up… opens the dialog (and the banner goes)", await waitFor("dialog from banner", async () => (await button("Accept and install").count()) === 1, 10000) && (await banner.count()) === 0);
    await closeDialog();

    const outside = readFileSync(traceFile, "utf8").split("\n").filter((l) => l.includes('"fn":"fetch"'));
    check("the shell and its core fetched nothing but loopback (the pin's .invalid hosts never)", outside.length === 0, outside.slice(0, 3).join(" | "));
    check("no page errors or console errors", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
