// ZabsReel's motion-graphics renderer: the Electron main of ONE render
// (MOTION-PLAN D2). apps/desktop/electron/main.cjs requires this file, as its
// first statement, when argv has --zr-motion-renderer, and runs nothing else;
// the core (packages/core/src/motion/rendermotion.ts) starts it.
//
// Arguments (after the flag): --zr-parent-pid=<core pid>, --zr-scratch=<the
// render's motion/<id> folder, absolute> (its profile and temp folder only;
// the page never learns it), optionally --zr-heap-mb=<n> (the page's V8 heap,
// at most 2048) and --probe (D7: render one 16x16 frame, print
// {"probe":"ok",...} and exit).
//
// Pipes with the core:
// - stdin, control in, JSON lines: {"type":"start", width, height, fps,
//   durationInFrames, alpha, table: [{path, type, body (base64)}]}, then
//   {"type":"frame","n"} per frame. EOF ends the process.
// - stdout, control out, JSON lines: {"type":"ready"} once the page has
//   loaded, {"type":"frame","n","cues"} after frame n's bytes are on fd 3,
//   {"type":"log","text"}, {"type":"blocked","url"} (a request the session
//   cancelled), {"type":"error","code","message"} before a failure exit.
// - fd 3, frames out: each frame exactly width*height*4 bytes, rows of
//   width*4 bytes with no padding, bytes B, G, R, A, premultiplied alpha as
//   Chromium paints them (the core's overlay encode unpremultiplies).
// - fd 4, media bytes in (the media routes of D4; nothing uses it yet): records
//   of [request id, u32 big-endian][length, u32 big-endian][bytes].
//
// The page runs sandboxed with no Node, in an in-memory session where every
// request that is not zrmotion: is cancelled, every host name fails to
// resolve, everything else goes to a dead proxy, WebRTC has no UDP route, and
// zrmotion: serves only the table the core sent. The process exits when stdin
// ends or the core's PID is gone.
"use strict";
const { app, BrowserWindow, ipcMain, nativeImage, protocol, session } = require("electron");
const net = require("node:net");
const path = require("node:path");

const SCHEME = "zrmotion";
const PAGE_URL = `${SCHEME}://app/page.html`;
/** The page's policy; the renderer adds it to every response, whatever the table holds. */
const CSP = [
  "default-src 'none'", "script-src zrmotion:", "img-src zrmotion: data: blob:", "media-src 'none'",
  "font-src zrmotion:", "style-src zrmotion: 'unsafe-inline'", "connect-src 'none'", "worker-src 'none'",
  "child-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join("; ");
/** Nothing listens there: a request that got past the session's filter has no route out (loopback included). */
const DEAD_PROXY = { proxyRules: "socks5://127.0.0.1:9", proxyBypassRules: "<-loopback>" };
const MAX_HEAP_MB = 2048;
/** A 1x1 opaque red PNG: its bitmap tells this platform's byte order. */
const RED_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

function argValue(name) {
  const prefix = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a === undefined ? undefined : a.slice(prefix.length);
}

const scratch = argValue("zr-scratch");
const parentPid = Number(argValue("zr-parent-pid"));
if (!scratch || !path.isAbsolute(scratch) || !Number.isInteger(parentPid) || parentPid <= 0) {
  process.stderr.write("[motion-renderer] needs --zr-scratch=<absolute folder> and --zr-parent-pid=<pid>\n");
  process.exit(2);
}
const probe = process.argv.includes("--probe");
const heapMb = Math.min(MAX_HEAP_MB, Math.max(16, Number.parseInt(argValue("zr-heap-mb") ?? "", 10) || MAX_HEAP_MB));

// Everything Chromium keeps goes under the render's own folder.
const profile = path.join(scratch, "profile");
app.setPath("userData", profile);
app.setPath("sessionData", profile);
app.setPath("crashDumps", path.join(profile, "crashes"));
app.setPath("temp", path.join(scratch, "tmp"));
// macOS: no Dock icon for a process that never shows a window.
if (process.platform === "darwin") app.dock?.hide();
// Software compositing: capturePage then returns the frame just drawn (slice 1 measured the GPU path returning stale frames).
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("mute-audio");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
// chromeguard.ts's switches: no host name resolves, and no ambient sign-in (both spellings).
app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND");
app.commandLine.appendSwitch("auth-server-whitelist", "zr-no-ambient-auth.invalid");
app.commandLine.appendSwitch("auth-server-allowlist", "zr-no-ambient-auth.invalid");
app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
app.commandLine.appendSwitch("js-flags", `--max-old-space-size=${heapMb}`);
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

let exiting = false;
function exit(code) {
  if (exiting) return;
  exiting = true;
  if (app.isReady()) app.exit(code);
  else process.exit(code);
}

function fail(code, message) {
  send({ type: "error", code, message: String(message).slice(0, 2000) });
  exit(1);
}

// Lifecycle: stdin's EOF, or the core gone, ends the render.
process.stdin.on("end", () => exit(0));
process.stdin.on("error", () => exit(0));
setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch (err) {
    if (err.code !== "EPERM") exit(3);
  }
}, 1000);

app.on("window-all-closed", () => {});
app.on("web-contents-created", (_e, wc) => lockDownContents(wc));

/** The render's session: in memory, every non-zrmotion request cancelled, no route out, nothing allowed. */
async function renderSession(table) {
  const ses = session.fromPartition(`zrmotion-${process.pid}`);
  ses.webRequest.onBeforeRequest((details, callback) => {
    const ours = details.url.startsWith(`${SCHEME}:`);
    if (!ours) send({ type: "blocked", url: details.url.slice(0, 300) });
    callback({ cancel: !ours });
  });
  await ses.setProxy(DEAD_PROXY);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setSpellCheckerEnabled(false);
  ses.on("will-download", (e) => e.preventDefault());
  ses.protocol.handle(SCHEME, (request) => serve(table, request));
  return ses;
}

/** A zrmotion: response: a table entry by its path on host "app", else 404. */
function serve(table, request) {
  const headers = { "content-security-policy": CSP, "x-content-type-options": "nosniff", "cache-control": "no-store" };
  let entry;
  try {
    const u = new URL(request.url);
    if (request.method === "GET" && u.host === "app" && !u.search) entry = table.get(u.pathname.slice(1));
  } catch {
    /* not a URL we serve */
  }
  if (!entry) return new Response("", { status: 404, headers });
  return new Response(entry.body, { status: 200, headers: { ...headers, "content-type": entry.type } });
}

/** No window.open, navigation, redirect, webview or WebRTC UDP for any page of this process. */
function lockDownContents(wc) {
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (e) => e.preventDefault());
  wc.on("will-frame-navigate", (e) => e.preventDefault());
  wc.on("will-redirect", (e) => e.preventDefault());
  wc.on("will-attach-webview", (e) => e.preventDefault());
  wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  wc.setAudioMuted(true);
}

function renderWindow(ses, width, height, opaque) {
  return new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    frame: false,
    enableLargerThanScreen: true,
    transparent: !opaque,
    backgroundColor: opaque ? "#000000" : "#00000000",
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
      session: ses,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
}

let swapRB = null;
/** `img` as width*height*4 bytes, B,G,R,A, rows without padding. */
function frameBytes(img, width, height) {
  const size = img.getSize();
  if (size.width !== width || size.height !== height) throw new Error(`captured ${size.width}x${size.height}, expected ${width}x${height}`);
  if (swapRB === null) {
    const red = nativeImage.createFromDataURL(RED_PNG).toBitmap();
    if (red[2] === 255 && red[0] === 0) swapRB = false;
    else if (red[0] === 255 && red[2] === 0) swapRB = true;
    else throw new Error(`unknown bitmap byte order (${[...red].join(",")})`);
  }
  let bytes = img.toBitmap();
  const row = width * 4;
  if (bytes.length !== row * height) {
    const stride = bytes.length / height;
    if (!Number.isInteger(stride) || stride < row) throw new Error(`captured ${bytes.length} bytes for ${width}x${height}`);
    const packed = Buffer.alloc(row * height);
    for (let y = 0; y < height; y++) bytes.copy(packed, y * row, y * stride, y * stride + row);
    bytes = packed;
  }
  if (swapRB) {
    for (let i = 0; i < bytes.length; i += 4) {
      const r = bytes[i];
      bytes[i] = bytes[i + 2];
      bytes[i + 2] = r;
    }
  }
  return bytes;
}

/** D7's start probe: one 16x16 frame in a session locked down like a render's, then one line. */
async function runProbe() {
  const body = Buffer.from('<!doctype html><html><body style="margin:0;background:#000"></body></html>');
  const ses = await renderSession(new Map([["page.html", { type: "text/html; charset=utf-8", body }]]));
  const win = renderWindow(ses, 16, 16, true);
  await win.loadURL(PAGE_URL);
  const bytes = frameBytes(await win.webContents.capturePage(), 16, 16);
  if (bytes.length !== 16 * 16 * 4 || bytes[3] !== 255) throw new Error("the probe frame is wrong");
  send({
    probe: "ok",
    visibleWindows: BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
    modules: Object.keys(require.cache),
    env: Object.keys(process.env).sort(),
  });
  exit(0);
}

const LIMITS = { width: 8192, height: 8192, fps: 240, frames: 36000 };

/** The core's start message, checked. */
function startOptions(msg) {
  const int = (v, max) => Number.isInteger(v) && v >= 1 && v <= max;
  if (!int(msg.width, LIMITS.width) || !int(msg.height, LIMITS.height) || !int(msg.durationInFrames, LIMITS.frames)) throw new Error("bad size or length");
  if (typeof msg.fps !== "number" || !(msg.fps > 0 && msg.fps <= LIMITS.fps)) throw new Error("bad fps");
  if (!Array.isArray(msg.table)) throw new Error("no table");
  const table = new Map();
  for (const e of msg.table) {
    if (typeof e?.path !== "string" || typeof e.type !== "string" || typeof e.body !== "string") throw new Error("bad table entry");
    table.set(e.path, { type: e.type, body: Buffer.from(e.body, "base64") });
  }
  return { width: msg.width, height: msg.height, fps: msg.fps, frames: msg.durationInFrames, opaque: msg.alpha === false, table };
}

let render = null;

async function start(msg) {
  const o = startOptions(msg);
  const frames = new net.Socket({ fd: 3, readable: false, writable: true });
  frames.on("error", (err) => fail("graphic_render_crashed", `frame pipe: ${err.message}`));
  const ses = await renderSession(o.table);
  const win = renderWindow(ses, o.width, o.height, o.opaque);
  const wc = win.webContents;
  wc.on("render-process-gone", (_e, d) => fail("graphic_render_crashed", `the page stopped (${d.reason}, exit code ${d.exitCode})`));
  wc.on("preload-error", (_e, _p, err) => fail("graphic_render_crashed", `preload: ${err.message}`));
  wc.on("console-message", (e, _level, message) => send({ type: "log", text: String(message ?? e.message).slice(0, 2000) }));
  render = { o, win, frames, pending: null };
  await win.loadURL(PAGE_URL);
  send({ type: "ready" });
}

ipcMain.on("zr-motion:frame-ready", (e, n, cues) => {
  const p = render?.pending;
  if (!p || e.sender !== render.win.webContents || n !== p.n) return;
  render.pending = null;
  p.resolve(Array.isArray(cues) ? cues.slice(0, 8) : []);
});
ipcMain.on("zr-motion:log", (e, text) => {
  if (render && e.sender === render.win.webContents) send({ type: "log", text: String(text).slice(0, 2000) });
});

async function renderFrame(n) {
  if (!render || render.pending) throw new Error("frame requested out of order");
  if (!Number.isInteger(n) || n < 0 || n >= render.o.frames) throw new Error(`bad frame ${n}`);
  const cues = await new Promise((resolve) => {
    render.pending = { n, resolve };
    render.win.webContents.executeJavaScript(`typeof __zrMotionRender === "function" && __zrMotionRender(${n}, ${render.o.fps})`).catch(() => {});
  });
  const bytes = frameBytes(await render.win.webContents.capturePage(), render.o.width, render.o.height);
  await new Promise((resolve, reject) => render.frames.write(bytes, (err) => (err ? reject(err) : resolve())));
  send({ type: "frame", n, cues });
}

// Control lines run one after another, after app ready.
let queue = app.whenReady();
function onMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail("graphic_render_crashed", "unreadable control line");
  }
  queue = queue
    .then(() => (msg.type === "start" ? start(msg) : msg.type === "frame" ? renderFrame(msg.n) : undefined))
    .catch((err) => fail("graphic_render_crashed", err.message));
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (probe) return;
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) onMessage(line);
  }
});

if (probe) app.whenReady().then(runProbe).catch((err) => fail("graphic_renderer_unavailable", err.message));
