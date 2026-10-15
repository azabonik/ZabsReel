// The renderer's network limits (main.cjs): which URLs the window may request,
// and the Content-Security-Policy of its page (index.html, and the web shell's
// header in web/server.cjs).
//
// The window loads only the bundled renderer and the core on 127.0.0.1, so
// anything else it asks for came from data: a URL built from a project value
// could name another computer (http://nas/x.png, or file://nas/share/x, which
// Windows opens as \\nas\share), and Windows would sign in to it.
//
// Electron-free on purpose, like save-rules.cjs: scripts/smoke-netguard.ts
// tests it under plain Node.
const path = require("node:path");
const { fileURLToPath } = require("node:url");

/** True when `p` names a file inside `dir` (not `dir` itself), compared case-insensitively on win32. */
function inside(dir, p, platform) {
  const P = platform === "win32" ? path.win32 : path.posix;
  const fold = (s) => (platform === "win32" ? s.toLowerCase() : s);
  const rel = P.relative(fold(dir), fold(p));
  return rel !== "" && !rel.startsWith("..") && !P.isAbsolute(rel);
}

/**
 * True when the renderer may request `url`. `ctx`: `rendererDir` (the bundled
 * renderer's folder), `corePort`, `devOrigin` (the Vite origin in a dev run,
 * else null) and `platform` (process.platform).
 *  - data:, blob:, devtools: (no network);
 *  - file: only with no host and a path inside rendererDir (file://nas/s/x and
 *    file:////nas/s/x are refused);
 *  - http: and ws: to 127.0.0.1 on the core's port;
 *  - in a dev run, the Vite origin and its hot-reload socket.
 * Everything else is refused.
 */
function isAllowedRendererUrl(url, ctx) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "devtools:") return true;
  if (u.protocol === "file:") {
    if (u.host !== "") return false;
    let p;
    try {
      p = fileURLToPath(u, { windows: ctx.platform === "win32" });
    } catch {
      return false;
    }
    if (/^[\\/]{2}/.test(p)) return false; // a network path, whatever the folder
    return inside(ctx.rendererDir, p, ctx.platform);
  }
  if ((u.protocol === "http:" || u.protocol === "ws:") && u.hostname === "127.0.0.1" && u.port === String(ctx.corePort)) return true;
  if (ctx.devOrigin) {
    const dev = new URL(ctx.devOrigin);
    if ((u.protocol === "http:" || u.protocol === "https:") && u.origin === dev.origin) return true;
    if ((u.protocol === "ws:" || u.protocol === "wss:") && u.host === dev.host) return true;
  }
  return false;
}

/**
 * True when `url` is the app's own page: the bundled index.html, or in a dev
 * run any page of the Vite origin (a reload). will-navigate cancels the rest.
 */
function isAppPage(url, ctx) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (ctx.devOrigin) return u.origin === new URL(ctx.devOrigin).origin;
  if (u.protocol !== "file:" || u.host !== "") return false;
  try {
    const p = fileURLToPath(u, { windows: ctx.platform === "win32" });
    const P = ctx.platform === "win32" ? path.win32 : path.posix;
    const fold = (s) => (ctx.platform === "win32" ? s.toLowerCase() : s);
    return fold(P.resolve(p)) === fold(P.join(ctx.rendererDir, "index.html"));
  } catch {
    return false;
  }
}

/** The Vite origin of a dev run's ELECTRON_RENDERER_URL, or null. */
function devOriginOf(rendererUrl) {
  if (!rendererUrl) return null;
  try {
    return new URL(rendererUrl).origin;
  } catch {
    return null;
  }
}

/** What a log line shows of a refused URL: its origin, never its path or query. */
function shownOrigin(url) {
  try {
    const u = new URL(url);
    return u.protocol === "file:" ? `file://${u.host}` : u.origin !== "null" ? u.origin : u.protocol;
  } catch {
    return "(not a URL)";
  }
}

/**
 * The page's Content-Security-Policy: media, images, requests and fonts only
 * from the page itself and the core on 127.0.0.1 (`corePort`, or any port),
 * no plugins, frames or <base>. Scripts and styles are not limited: the
 * threat is a URL built from project data, which only media, image and fetch
 * requests carry. No frame-ancestors here: a meta tag can't carry it (the web
 * shell sends it as a header).
 */
function rendererCsp(corePort) {
  const core = `http://127.0.0.1:${corePort ?? "*"}`;
  const ws = `ws://127.0.0.1:${corePort ?? "*"}`;
  return [
    `media-src 'self' ${core}`,
    `img-src 'self' data: blob: ${core}`,
    `connect-src 'self' ${core} ${ws}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
  ].join("; ");
}

module.exports = { isAllowedRendererUrl, isAppPage, devOriginOf, shownOrigin, rendererCsp };
