// Web shell: the localhost-webapp counterpart of electron/main.cjs. It runs the
// same React renderer in an ordinary browser tab. Responsibilities:
//   1. Ensure the @aive/core backend is running — REUSING one already started by
//      an AI client (MCP) if present, via the same core-launcher the desktop app
//      uses, so browser, desktop app and AI all share one live session.
//   2. Serve the built renderer (dist/renderer) on its own localhost port.
//   3. Stand in for the Electron preload bridge with a small token-gated /api:
//      a directory listing for the in-app file picker (browsers never reveal
//      absolute paths, and the core works with absolute paths) and the
//      ready-to-paste MCP client config.
//   4. Print — and open — the URL that hands the page the core port + token.
//   5. Tear down the core on exit ONLY if we were the ones who started it.
//
// Usage:  node web/server.cjs [--port 4790] [--no-open]
//
// Written in CommonJS with Node built-ins only, so it runs with no build step.
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ensureCore, browserBlocksPort } = require("../electron/core-launcher.cjs");

const RENDERER_DIR = path.join(__dirname, "..", "dist", "renderer");
const DEFAULT_PORT = 4790;
/** Cap on directory entries returned in one listing (System32 is ~5k). */
const MAX_ENTRIES = 10000;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

const isWsl =
  process.platform === "linux" && (!!process.env.WSL_DISTRO_NAME || /microsoft/i.test(os.release()));

function parseArgs(argv) {
  const opts = {
    port: process.env.AIVE_WEB_PORT ? Number(process.env.AIVE_WEB_PORT) : DEFAULT_PORT,
    open: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-open") opts.open = false;
    else if (a === "--port") opts.port = Number(argv[++i]);
    else if (a.startsWith("--port=")) opts.port = Number(a.slice("--port=".length));
    else if (a === "--help" || a === "-h") {
      console.error("Usage: node web/server.cjs [--port 4790] [--no-open]");
      process.exit(0);
    } else {
      console.error(`[aive-web] unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    console.error("[aive-web] --port must be an integer between 0 and 65535");
    process.exit(2);
  }
  if (browserBlocksPort(opts.port)) {
    console.error(`[aive-web] browsers refuse to open pages on port ${opts.port} (ERR_UNSAFE_PORT). Pick another --port.`);
    process.exit(2);
  }
  return opts;
}

// ---- Responses ---------------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Errors thrown by handlers that should reach the client as `{ ok:false, error }`. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fsError(err, target) {
  switch (err && err.code) {
    case "ENOENT": return new HttpError(404, `Not found: ${target}`);
    case "ENOTDIR": return new HttpError(400, `Not a folder: ${target}`);
    case "EACCES":
    case "EPERM": return new HttpError(403, `Permission denied: ${target}`);
    default: return new HttpError(500, err && err.message ? err.message : String(err));
  }
}

// ---- Static renderer ---------------------------------------------------------

async function serveStatic(pathname, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { ok: false, error: "Malformed URL" });
    return;
  }
  if (rel === "/") rel = "/index.html";
  // Resolve inside RENDERER_DIR and refuse anything that escapes it.
  const abs = path.resolve(RENDERER_DIR, `.${rel}`);
  if (!abs.startsWith(RENDERER_DIR + path.sep)) {
    sendJson(res, 404, { ok: false, error: "Not found" });
    return;
  }
  let info;
  try {
    info = await fsp.stat(abs);
  } catch {
    info = null;
  }
  if (!info || !info.isFile()) {
    // No favicon ships with the renderer; answer quietly instead of a 404.
    if (rel === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    sendJson(res, 404, { ok: false, error: "Not found" });
    return;
  }
  const isHtml = abs.endsWith(".html");
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream",
    "Content-Length": info.size,
    // Vite fingerprints everything under assets/, so it can be cached forever;
    // index.html must always be revalidated to pick up a fresh build.
    "Cache-Control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    // The launch URL carries the session token until the page strips it, so
    // never leak it in a Referer, and never let another site frame the editor.
    "Referrer-Policy": "no-referrer",
    ...(isHtml ? { "Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY" } : {}),
  });
  fs.createReadStream(abs).pipe(res);
}

// ---- /api --------------------------------------------------------------------

async function isDir(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Shortcut folders for the picker sidebar — only ones that exist on this machine. */
async function listPlaces() {
  const home = os.homedir();
  const places = [{ label: "Home", path: home }];
  for (const name of ["Videos", "Movies", "Desktop", "Downloads"]) {
    const p = path.join(home, name);
    if (await isDir(p)) places.push({ label: name, path: p });
  }

  if (process.platform === "win32") {
    for (let c = 65; c <= 90; c++) {
      const root = `${String.fromCharCode(c)}:\\`;
      if (fs.existsSync(root)) places.push({ label: `${String.fromCharCode(c)}:`, path: root });
    }
    return places;
  }

  places.push({ label: "Computer", path: "/" });
  if (isWsl) {
    // Footage under WSL usually lives on the Windows side: the drives are
    // mounted at /mnt/<letter>, and each Windows user has Videos/Desktop/...
    let mnt = [];
    try {
      mnt = await fsp.readdir("/mnt", { withFileTypes: true });
    } catch { /* no /mnt */ }
    for (const d of mnt) {
      if (/^[a-z]$/.test(d.name) && d.isDirectory()) {
        places.push({ label: `${d.name.toUpperCase()}: (Windows)`, path: `/mnt/${d.name}` });
      }
    }
    let users = [];
    try {
      users = await fsp.readdir("/mnt/c/Users", { withFileTypes: true });
    } catch { /* no C: drive */ }
    const skip = new Set(["Public", "Default", "Default User", "All Users"]);
    for (const u of users) {
      if (!u.isDirectory() || skip.has(u.name)) continue;
      for (const name of ["Videos", "Desktop", "Downloads"]) {
        const p = `/mnt/c/Users/${u.name}/${name}`;
        if (await isDir(p)) places.push({ label: `Windows ${name}`, path: p });
      }
    }
  }
  return places;
}

/**
 * List one directory for the picker. Folders first, then files, each in
 * natural order. Only files (and symlinks) are stat'ed — for size, and to
 * resolve what a link points at — which keeps big folders on /mnt/c quick.
 */
async function listDir(raw) {
  if (raw && !path.isAbsolute(raw)) throw new HttpError(400, "Path must be absolute");
  const dir = raw ? path.resolve(raw) : os.homedir();
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw fsError(err, dir);
  }
  const truncated = dirents.length > MAX_ENTRIES;
  const entries = await Promise.all(
    dirents.slice(0, MAX_ENTRIES).map(async (d) => {
      const full = path.join(dir, d.name);
      let dirFlag = d.isDirectory();
      let size = null;
      let mtime = null;
      if (d.isFile() || d.isSymbolicLink()) {
        try {
          const st = await fsp.stat(full);
          dirFlag = st.isDirectory();
          if (st.isFile()) size = st.size;
          mtime = st.mtimeMs;
        } catch { /* broken link or no access: list it without details */ }
      }
      return { name: d.name, dir: dirFlag, size, mtime, hidden: d.name.startsWith(".") };
    }),
  );
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  entries.sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, sep: path.sep, entries, truncated };
}

/** Same shape the Electron bridge returns, for the "Connect AI" panel. */
function mcpConfig() {
  let mcpEntry = null;
  try {
    mcpEntry = path.join(path.dirname(require.resolve("@aive/mcp/package.json")), "dist", "index.js");
  } catch {
    mcpEntry = null;
  }
  const config = { mcpServers: { synthcut: { command: "node", args: [mcpEntry] } } };
  return { available: !!mcpEntry, packaged: false, mcpEntry, json: JSON.stringify(config, null, 2) };
}

async function handleApi(url, res) {
  if (url.pathname === "/api/config") {
    sendJson(res, 200, {
      ok: true,
      platform: process.platform,
      sep: path.sep,
      home: os.homedir(),
      places: await listPlaces(),
      mcp: mcpConfig(),
    });
    return;
  }
  if (url.pathname === "/api/fs/list") {
    sendJson(res, 200, { ok: true, ...(await listDir(url.searchParams.get("path") || "")) });
    return;
  }
  sendJson(res, 404, { ok: false, error: "Not found" });
}

// ---- Server --------------------------------------------------------------------

function createWebServer(core) {
  let boundPort = 0;
  const server = http.createServer(async (req, res) => {
    // DNS-rebinding guard: a hostile site can point its own hostname at
    // 127.0.0.1, so only answer requests addressed to loopback by name.
    const host = String(req.headers.host || "").toLowerCase();
    const allowed = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
    if (!allowed.includes(host)) {
      sendJson(res, 403, { ok: false, error: "Forbidden host" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    const url = new URL(req.url || "/", `http://${host}`);
    try {
      if (url.pathname.startsWith("/api/")) {
        // Same secret as the core: the page already holds it, so the picker
        // and the core trust exactly the same callers.
        if (req.headers["x-aive-token"] !== core.token || !core.token) {
          sendJson(res, 401, { ok: false, error: "Unauthorized: missing or stale session token" });
          return;
        }
        await handleApi(url, res);
        return;
      }
      await serveStatic(url.pathname, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      sendJson(res, status, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });
  return {
    server,
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          boundPort = server.address().port;
          resolve(boundPort);
        });
      });
    },
  };
}

/** Open the URL in the user's default browser; best effort, never fatal. */
function openBrowser(url) {
  const candidates =
    process.platform === "win32" ? [["rundll32", ["url.dll,FileProtocolHandler", url]]]
    : process.platform === "darwin" ? [["open", [url]]]
    // WSL: hand the URL to the Windows browser (wslu's wslview, else Explorer).
    // WSL2 forwards Windows' localhost to this distro, so the page can reach us.
    : isWsl ? [["wslview", [url]], ["explorer.exe", [url]]]
    : [["xdg-open", [url]]];
  const tryNext = (i) => {
    if (i >= candidates.length) {
      console.error("[aive-web] could not open a browser — open the URL above yourself.");
      return;
    }
    const [cmd, args] = candidates[i];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => tryNext(i + 1));
    child.unref();
  };
  tryNext(0);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(path.join(RENDERER_DIR, "index.html"))) {
    console.error('[aive-web] renderer not built — run "npm run build" at the repo root first.');
    process.exit(1);
  }

  // Under plain Node, process.execPath is node; core-launcher's
  // ELECTRON_RUN_AS_NODE env var is simply ignored.
  let core;
  try {
    core = await ensureCore(process.execPath);
  } catch (err) {
    console.error(`[aive-web] could not start the editor core: ${err && err.message ? err.message : err}`);
    console.error('[aive-web] make sure the project is built ("npm run build") and FFmpeg is on your PATH.');
    process.exit(1);
  }
  console.error(`[aive-web] ${core.owned ? "started" : "attached to existing"} core on port ${core.port}`);
  if (browserBlocksPort(core.port)) {
    console.error(
      `[aive-web] the editor core is on port ${core.port}, which browsers refuse to connect to (ERR_UNSAFE_PORT). ` +
        "Set AIVE_PORT to another port (the default is 4791) and start it again.",
    );
    if (core.owned && core.child) core.child.kill();
    process.exit(1);
  }

  const web = createWebServer(core);
  let port;
  try {
    port = await web.listen(opts.port);
  } catch (err) {
    const inUse = err && err.code === "EADDRINUSE";
    console.error(
      inUse
        ? `[aive-web] port ${opts.port} is already in use — is another "npm run web" running? Try --port <n>.`
        : `[aive-web] could not listen: ${err && err.message ? err.message : err}`,
    );
    if (core.owned && core.child) core.child.kill();
    process.exit(1);
  }

  const url = `http://127.0.0.1:${port}/?port=${core.port}&token=${encodeURIComponent(core.token)}`;
  // Machine-readable line for scripts/tests (mirrors the core's own ready event).
  console.log(JSON.stringify({ event: "ready", url, port, corePort: core.port, coreOwned: core.owned }));
  console.error(`\n  SynthCut is running at:\n\n    ${url}\n\n  Press Ctrl+C to stop.\n`);
  if (opts.open) openBrowser(url);

  let stopping = false;
  const stop = (code) => {
    if (stopping) return;
    stopping = true;
    web.server.close();
    // Only stop a core WE started; an AI-started core keeps its session.
    if (core.owned && core.child && !core.child.killed) core.child.kill();
    process.exit(code);
  };
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
  if (core.owned && core.child) {
    core.child.on("exit", (code) => {
      if (stopping) return;
      console.error(`[aive-web] editor core exited (code ${code}) — stopping.`);
      stop(1);
    });
  }
}

main();
