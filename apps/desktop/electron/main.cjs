// Electron main process. Responsibilities:
//   1. Ensure the @aive/core backend is running — REUSING one already started by
//      an AI client (MCP) if present, so the app and the AI share one session.
//   2. Open a window that loads the React renderer, passing it the core port.
//   3. Provide native file open/save dialogs to the renderer over IPC.
//   3a. Allow or remove network computers (the core's approval store) after a
//      native dialog; the core itself has no call that allows one.
//   4. Tear down the core on quit ONLY if we were the ones who started it.
//
// Written in CommonJS so it runs directly under Electron with no build step.
const { app, BrowserWindow, Menu, ipcMain, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { ensureCore, browserBlocksPort, getDataDir } = require("./core-launcher.cjs");
const { applyBundledAssetEnv } = require("./bundled-assets.cjs");
const { finalSavePath: decideSavePath, closeGuard } = require("./save-rules.cjs");
const { PRODUCT_NAME, MCP_KEY, APP_ID, APP_ID_DEV } = require("./brand.cjs");
const { allowDialog, keepDialog, unreadBox, notSavedBox, userContextPath } = require("./media-servers.cjs");

// Branding: the display name (taskbar / jump-list / dialogs) and a stable Windows
// AppUserModelID so the taskbar shows OUR name + icon instead of "Electron" and
// groups our windows under one taskbar button. In a DEV run (not packaged) we use
// a distinct name + AppUserModelID so a source build is a SEPARATE taskbar entry
// and can't be confused with an installed copy. No effect on the shipped app.
const APP_NAME = app.isPackaged ? PRODUCT_NAME : `${PRODUCT_NAME} (DEV)`;
const APP_ICON = path.join(__dirname, "..", "build", "icon.ico");
const AUMID = app.isPackaged ? APP_ID : APP_ID_DEV;
app.setName(APP_NAME);
if (process.platform === "win32") {
  app.setAppUserModelId(AUMID);
}

let coreChild = null;
let coreOwned = false;
let corePort = null;
let coreToken = null;

// Project state mirrored from the renderer so the main process can guard quit.
let mainWin = null;
let projectUnsaved = false;
let projectHasPath = false;
// forceQuit: user chose to close anyway → allow the close.
// pendingSaveQuit: waiting for the renderer to finish saving, then quit.
// Changed only through guardStep (rules in save-rules.cjs closeGuard).
let guard = { pendingSaveQuit: false, forceQuit: false };

/** Apply a close-guard event and carry out its effect. */
function guardStep(event) {
  const { state, effect } = closeGuard(guard, event);
  guard = state;
  if (effect === "close") { if (mainWin) mainWin.close(); }
  else if (effect) sendMenu(effect);
}

// No native OS menu bar — the app uses ONE custom title bar (Clipchamp-style).
// New/Open/Save live in the in-app Project menu; editing shortcuts (Ctrl+S/Z/Y)
// are handled in the renderer. Removing the menu also drops the Ctrl+/- page-zoom
// accelerators, which we don't want for a desktop app.
function buildMenu() {
  Menu.setApplicationMenu(null);
}

// Background auto-update (packaged builds only). On launch the app reads the
// GitHub Release feed (latest.yml), and if a newer version exists electron-updater
// downloads only the changed chunks (via the .blockmap) in the background, then
// installs on the next restart. Guarded by app.isPackaged so it NEVER runs during
// a `npm start` dev session. Update source is the `publish` block in package.json
// (the azabonik/ZabsReel GitHub releases).
function setupAutoUpdate() {
  if (!app.isPackaged) return; // dev build — nothing to update against
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    console.error("[aive] electron-updater unavailable:", err && err.message ? err.message : err);
    return;
  }

  // Never crash the app over a failed/unreachable update check (offline, no
  // release yet, private repo, etc.) — just log and carry on.
  autoUpdater.on("error", (err) =>
    console.error("[aive] auto-update error:", err && err.message ? err.message : err));
  autoUpdater.on("update-available", (info) =>
    console.error(`[aive] update available: v${info.version} — downloading in background`));
  autoUpdater.on("update-not-available", () =>
    console.error("[aive] up to date"));

  // When the new version is fully downloaded, offer an immediate restart. Setting
  // forceQuit first bypasses the unsaved-changes quit guard in onWindowClose so
  // quitAndInstall() can relaunch cleanly.
  autoUpdater.on("update-downloaded", (info) => {
    const choice = dialog.showMessageBoxSync(mainWin, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: "Update ready",
      message: `${PRODUCT_NAME} ${info.version} has been downloaded.`,
      detail: "Restart to install it — the update installs on next launch if you choose Later.",
    });
    if (choice === 0) {
      guard = { ...guard, forceQuit: true };
      autoUpdater.quitAndInstall();
    }
  });

  // Kick off the check. (checkForUpdates + autoDownload handles our own restart
  // UX; we don't use checkForUpdatesAndNotify since the dialog above replaces the
  // built-in OS notification.)
  autoUpdater.checkForUpdates().catch((err) =>
    console.error("[aive] update check failed:", err && err.message ? err.message : err));
}

/** Send a Project-menu action ("save", "save-as", …) to the renderer (preload: onMenu). */
function sendMenu(action) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("menu", action);
}

/** Intercept window close to confirm unsaved changes (main-process dialog). */
function onWindowClose(e) {
  if (guard.forceQuit || !projectUnsaved) return; // clean (or already confirmed) → allow
  e.preventDefault();
  const choice = dialog.showMessageBoxSync(mainWin, {
    type: "warning",
    buttons: ["Save", "Don't Save", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: "Unsaved changes",
    message: "Save changes before closing?",
    detail: "Your project has unsaved edits.",
  });
  // Save → ask the renderer to save; we quit once it reports the project clean.
  // Don't Save → close. Cancel → stay open. Each choice drops an earlier Save
  // request that never completed.
  guardStep({ type: "close-dialog", choice: ["save", "dont-save", "cancel"][choice] || "cancel", hasPath: projectHasPath });
}

function createWindow(port, token) {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#0e0f13",
    title: APP_NAME,
    icon: APP_ICON,
    // Single custom title bar (Clipchamp-style): hide the OS title bar but keep
    // the native min/max/close buttons overlaid in the top-right of OUR top bar.
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#131419", symbolColor: "#c4c9d6", height: 52 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWin = win;
  win.on("close", onWindowClose);
  win.on("closed", () => { if (mainWin === win) mainWin = null; });

  // Lock the page zoom: a desktop app must never pinch/Ctrl-zoom the whole UI.
  // Renderer-side preventDefault isn't enough on its own — Chromium can still
  // apply Ctrl+wheel / Ctrl+±/pinch zoom — so we hard-lock it in the main process:
  // clamp the zoom range to 1×, and snap any zoom change straight back to 1×.
  const lockZoom = () => {
    win.webContents.setVisualZoomLevelLimits(1, 1); // disable trackpad pinch-zoom
    win.webContents.setZoomLevel(0);
    win.webContents.setZoomFactor(1);
  };
  win.webContents.on("did-finish-load", lockZoom);
  win.webContents.on("zoom-changed", () => lockZoom());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    win.loadURL(`${devUrl}?port=${port}&token=${encodeURIComponent(token || "")}`);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "renderer", "index.html"), {
      query: { port: String(port), token: String(token || "") },
    });
  }
}

// The renderer reports its dirty/has-file state so quit-guard logic can use it.
ipcMain.on("project:state", (_e, state) => {
  projectUnsaved = !!(state && state.dirty);
  projectHasPath = !!(state && state.hasPath);
  // A save we requested before quitting just completed → proceed to close.
  guardStep({ type: "project-state", dirty: projectUnsaved });
});

// The renderer could not write the project: a Save chosen in the close dialog
// failed, so the next save (the autosave included) must not close the window.
ipcMain.on("project:save-failed", () => guardStep({ type: "save-failed" }));

// ---- network computers (@aive/core hosttrust.ts) ------------------------------
// Only the UI hosts write the approval store (<dataDir>/trust), through
// @aive/core/trusthosts, and only after the user's own gesture: Allow or Keep
// in a native dialog the renderer cannot answer, or a file picked in a folder
// the user browsed to (picker auto-trust). Each write is followed by
// recheck_offline_media with main's own token, so the core picks it up even
// where its folder watch does not fire.

let coreModules = null;
/** @aive/core's ESM modules for the store, loaded on first use. */
function trustModules() {
  coreModules ??= Promise.all([import("@aive/core/unc"), import("@aive/core/trusthosts")]).then(([unc, trust]) => ({ unc, trust }));
  return coreModules;
}

/** One rpc call to the core with main's own session token. */
async function coreRpc(method, params = {}) {
  const res = await fetch(`http://127.0.0.1:${corePort}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-aive-token": coreToken || "" },
    body: JSON.stringify({ method, params }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.result;
}

const errText = (err) => (err && err.message ? err.message : String(err));

/** Ask the core to re-read the store and re-check offline media; never fails the caller. */
async function recheckOfflineMedia() {
  try {
    await coreRpc("recheck_offline_media");
  } catch (err) {
    console.error(`[aive] recheck_offline_media failed: ${errText(err)}`);
  }
}

function messageBox(opts) {
  return mainWin ? dialog.showMessageBox(mainWin, opts) : dialog.showMessageBox(opts);
}

/**
 * Picker auto-trust: the servers of files the user picked in a native dialog,
 * which only ever opens in a folder he navigated to (no dialog gets a folder
 * from project or agent data). Stored before the paths go to the renderer. A
 * host that can't be allowed (a refused form) is left to the core's refusal.
 */
async function trustPicked(paths) {
  const { unc, trust } = await trustModules();
  const hosts = new Set();
  for (const p of paths) {
    const c = unc.classifyPath(p);
    if (c.kind === "network") hosts.add(c.host);
  }
  if (!hosts.size) return;
  const dataDir = getDataDir();
  const approved = new Set(trust.readTrustedHosts(dataDir).approved.map((a) => a.host));
  for (const host of hosts) {
    if (approved.has(host)) continue;
    try {
      await trust.approveHost(dataDir, host, "picker");
    } catch (err) {
      // Not saved: the core refuses the path and the renderer asks instead.
      console.error(`[aive] couldn't save \\\\${host} as allowed: ${errText(err)}`);
    }
  }
  await recheckOfflineMedia();
}

// Review a network computer. The store decides the dialog (approvalDialogFor):
// unread → only "couldn't read its list"; added outside ZabsReel → Keep /
// Remove; else Allow / Keep offline. Resolves true when the server is allowed.
// `context` ({ origin: "user", path }) only changes the wording, and only when
// the core's pending list agrees (userContextPath).
ipcMain.handle("media-servers:approve", async (_e, host, context) => {
  const { unc, trust } = await trustModules();
  const h = typeof host === "string" ? unc.normalizeHost(host) : { ok: false };
  if (!h.ok) return false;
  const key = h.key;
  const dataDir = getDataDir();
  const list = trust.readTrustedHosts(dataDir);
  const which = unc.approvalDialogFor(list, key);
  if (which === "unread") {
    await messageBox(unreadBox());
    return false;
  }
  if (which === "allow" && list.approved.some((a) => a.host === key)) {
    await recheckOfflineMedia(); // allowed already (another window): nothing to ask
    return true;
  }
  // The core's own count and examples; nothing the renderer sends is shown as fact.
  const servers = await coreRpc("list_media_servers").catch(() => null);
  const entry = servers ? servers.pending.find((p) => p.host === key) : undefined;
  if (which === "keep") {
    const { response } = await messageBox(keepDialog({ key, entry, platform: process.platform }));
    if (response === 1) {
      try {
        await trust.approveHost(dataDir, key, "prompt");
      } catch (err) {
        console.error(`[aive] keep \\\\${key}: ${errText(err)}`);
        await messageBox(notSavedBox("Couldn't save; try again."));
        return false;
      }
      await recheckOfflineMedia();
      return true;
    }
    // Remove, or Esc: only while it is still outside (another window may have kept it meanwhile).
    let removed;
    try {
      ({ removed } = await trust.revokeHost(dataDir, key, { onlyIfOutside: true }));
    } catch (err) {
      console.error(`[aive] remove \\\\${key}: ${errText(err)}`);
      await messageBox(notSavedBox(`Couldn't remove \\\\${key}; try again.`));
      return false;
    }
    await recheckOfflineMedia();
    return !removed;
  }
  const userPath = userContextPath(context, key, entry, unc);
  const { response } = await messageBox(allowDialog({ key, entry, userPath, platform: process.platform }));
  if (response !== 1) return false;
  try {
    await trust.approveHost(dataDir, key, "prompt");
  } catch (err) {
    console.error(`[aive] allow \\\\${key}: ${errText(err)}`);
    await messageBox(notSavedBox("Couldn't save; try again."));
    return false;
  }
  await recheckOfflineMedia();
  return true;
});

// Remove a network computer (Project → Network computers). No dialog: it only
// takes trust away. Rejects when the store could not be written.
ipcMain.handle("media-servers:revoke", async (_e, host) => {
  const { unc, trust } = await trustModules();
  const h = typeof host === "string" ? unc.normalizeHost(host) : { ok: false };
  if (!h.ok) throw new Error("Not a network computer name.");
  await trust.revokeHost(getDataDir(), h.key);
  await recheckOfflineMedia();
});

ipcMain.handle("dialog:openFiles", async () => {
  const result = await dialog.showOpenDialog({
    title: "Import media",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Media", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "wav", "mp3", "aac", "png", "jpg", "jpeg", "webp", "gif", "bmp"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled) return [];
  await trustPicked(result.filePaths);
  return result.filePaths;
});

// Extension rule and the second overwrite question: save-rules.cjs. Returns the
// path to write, or null to cancel.
function finalSavePath(filePath, filters) {
  return decideSavePath(filePath, filters, fs.existsSync, (final) => dialog.showMessageBoxSync(mainWin, {
    type: "warning",
    buttons: ["Replace", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "Replace file?",
    message: `"${path.basename(final)}" already exists. Replace it?`,
  }) === 0);
}

ipcMain.handle("dialog:saveFile", async (_e, ext) => {
  // Same containers as the web picker (platform.ts exportFilters); the chosen
  // preset's container is listed first so it is the default.
  const formats = [
    { name: "MP4 Video", extensions: ["mp4"] },
    { name: "WebM Video", extensions: ["webm"] },
    { name: "QuickTime Movie", extensions: ["mov"] },
  ];
  const want = formats.find((f) => f.extensions[0] === ext) || formats[0];
  const filters = [want, ...formats.filter((f) => f !== want)];
  const result = await dialog.showSaveDialog({
    title: "Export video",
    defaultPath: `export.${want.extensions[0]}`,
    filters,
  });
  const chosen = result.canceled || !result.filePath ? null : finalSavePath(result.filePath, filters);
  if (chosen) await trustPicked([chosen]);
  return chosen;
});

ipcMain.handle("dialog:openProject", async () => {
  const result = await dialog.showOpenDialog({
    title: "Open project",
    properties: ["openFile"],
    filters: [
      { name: `${PRODUCT_NAME} Project`, extensions: ["aive"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  await trustPicked([result.filePaths[0]]); // the project file's own server; not the media in it
  return result.filePaths[0];
});

// `defaultName` is the project's name, which a project file or the agent can
// set: only its bare file name goes into defaultPath, so the dialog opens in
// the folder the OS remembers from the user's own use, never in a folder (or
// on a server) the name points at, and a Save there is auto-trusted safely.
ipcMain.handle("dialog:saveProject", async (_e, defaultName) => {
  const { unc } = await trustModules();
  const base = unc.bareFileName((defaultName && String(defaultName)) || "Untitled");
  const filters = [{ name: `${PRODUCT_NAME} Project`, extensions: ["aive"] }];
  const result = await dialog.showSaveDialog({
    title: "Save project as",
    defaultPath: `${base.replace(/\.aive$/i, "")}.aive`,
    filters,
  });
  const chosen = result.canceled || !result.filePath ? null : finalSavePath(result.filePath, filters);
  if (chosen) await trustPicked([chosen]);
  // Cancelled during "Save before closing?": stay open, and don't close on a later save.
  if (!chosen) guardStep({ type: "save-as-cancelled" });
  return chosen;
});

// Build a ready-to-paste MCP client config for THIS install, so the user never
// has to guess a "<REPO_PATH>". In a packaged app there is no Node on the user's
// machine, so we launch the bundled MCP server with the app's own Electron binary
// running in Node mode (ELECTRON_RUN_AS_NODE) — the same trick used for the core.
// From a source checkout, plain `node` is available and clearer.
ipcMain.handle("mcp:config", () => {
  let mcpEntry = null;
  try {
    mcpEntry = path.join(path.dirname(require.resolve("@aive/mcp/package.json")), "dist", "index.js");
  } catch {
    mcpEntry = null;
  }
  const packaged = app.isPackaged;
  const server = packaged
    ? { command: process.execPath, args: [mcpEntry], env: { ELECTRON_RUN_AS_NODE: "1" } }
    : { command: "node", args: [mcpEntry] };
  const config = { mcpServers: { [MCP_KEY]: server } };
  return {
    available: !!mcpEntry,
    packaged,
    mcpEntry,
    json: JSON.stringify(config, null, 2),
  };
});

app.whenReady().then(async () => {
  try {
    // In a packaged build, point the core at the bundled ffmpeg/whisper/YuNet/font
    // so the first run is offline. No-op in dev. Must run BEFORE ensureCore, which
    // spawns the core inheriting process.env.
    const bundle = applyBundledAssetEnv(app);
    if (bundle.applied) console.error(`[aive] using bundled assets (${bundle.vars.join(", ")})`);

    const result = await ensureCore(process.execPath);
    corePort = result.port;
    coreToken = result.token;
    coreOwned = result.owned;
    coreChild = result.child;
    console.error(`[aive] ${coreOwned ? "started" : "attached to existing"} core on port ${corePort}`);
    if (browserBlocksPort(corePort)) {
      throw Object.assign(
        new Error(
          `The editor core is on port ${corePort}, which Electron and browsers refuse to connect to ` +
            `(ERR_UNSAFE_PORT), so this window could not reach it. Set AIVE_PORT to another port ` +
            `(the default is 4791) and start the core again.`,
        ),
        { blockedPort: true },
      );
    }
    buildMenu();
    createWindow(corePort, coreToken);
    setupAutoUpdate();
  } catch (err) {
    dialog.showErrorBox(
      "Could not start the editor core",
      `${err && err.message ? err.message : err}` +
        (err && err.blockedPort
          ? ""
          : '\n\nMake sure the project is built (run "npm run build" at the repo root) and that FFmpeg is installed.'),
    );
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && corePort) createWindow(corePort, coreToken);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("quit", () => {
  // Only kill the core if WE started it. If we attached to an AI-started core,
  // leave it running so the AI's session survives the window closing.
  if (coreOwned && coreChild && !coreChild.killed) coreChild.kill();
});
