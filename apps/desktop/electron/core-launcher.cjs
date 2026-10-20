// Discovers or launches the editor core, and — crucially — **reuses an already
// running core** when one exists. This is what lets the desktop app and an AI
// client (via the MCP server) share ONE live editing session: whoever starts
// first launches the core; the other attaches to it. They must agree on the
// data directory (where the core publishes server.json), so we use the same
// rule the core and MCP server use (brand.cjs resolveDataDir: ~/.zedmix/data, or
// the old folder when only that one holds state).
//
// Electron-free on purpose, so it can be tested under plain Node.
const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { resolveDataDir } = require("./brand.cjs");

const require_ = createRequire(__filename);

// Ports that Chromium, and so Electron and Chrome/Edge, refuses to connect to
// (net::ERR_UNSAFE_PORT; the full list measured with Chromium 14x over 1-65535).
// A core on one of them still serves MCP clients, but an editor window can't
// reach it and just shows "Offline".
const BROWSER_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103,
  104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
  514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

/** True when browsers and Electron refuse connections to this port. */
function browserBlocksPort(port) {
  return BROWSER_BLOCKED_PORTS.has(Number(port));
}

// The last choice that was logged, so each process prints its data dir once.
let loggedChoice = "";

/** The data folder this process uses. `opts` ({ env, home }) is for tests. */
function getDataDir(opts) {
  const { dir, reason } = resolveDataDir(opts);
  const line = `[aive] data dir: ${dir} (${reason})`;
  if (line !== loggedChoice) {
    loggedChoice = line;
    console.error(line);
  }
  return dir;
}

function coreCliPath() {
  const pkgJson = require_.resolve("@aive/core/package.json");
  return path.join(path.dirname(pkgJson), "dist", "cli.js");
}

function readServerInfo(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "server.json"), "utf8"));
  } catch {
    return null;
  }
}

function healthCheck(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Spawn a fresh core. `execPath` is the binary to run the CLI with — under
 * Electron that's the Electron binary (with ELECTRON_RUN_AS_NODE), under tests
 * it's plain node. Resolves with { child, port } once the core reports ready.
 */
function startCore(dir, execPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(execPath || process.execPath, [coreCliPath()], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", AIVE_DATA_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let buf = "";
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Timed out waiting for editor core to start"));
      }
    }, 20000);

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.event === "ready" && msg.port && !settled) {
            settled = true;
            clearTimeout(timeout);
            // token: session auth secret; also published in <dataDir>/server.json.
            resolve({ child, port: msg.port, token: msg.token || (readServerInfo(dir) || {}).token || "" });
          }
        } catch {
          /* non-JSON log line; ignore */
        }
      }
    });
    child.stderr.on("data", (d) => process.stderr.write(`[core] ${d}`));
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Core exited before ready (code ${code})`));
      }
    });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

/**
 * Ensure a core is available. Returns { port, token, owned, child }.
 *   owned=false → attached to a core someone else started (do NOT kill it).
 *   owned=true  → we spawned it (kill it on quit).
 * `token` is the core's per-run session secret — every HTTP/WS/file request
 * must carry it, so the launcher hands it to the renderer alongside the port.
 */
async function ensureCore(execPath) {
  const dir = getDataDir();
  const info = readServerInfo(dir);
  if (info && info.port && (await healthCheck(info.port))) {
    return { port: info.port, token: info.token || "", owned: false, child: null };
  }
  const { child, port, token } = await startCore(dir, execPath);
  return { port, token: token || "", owned: true, child };
}

module.exports = { ensureCore, startCore, getDataDir, coreCliPath, readServerInfo, healthCheck, browserBlocksPort };
