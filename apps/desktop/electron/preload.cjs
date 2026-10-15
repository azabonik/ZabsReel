// Preload script: exposes a minimal, safe bridge to the renderer. The renderer
// has no direct Node access — only these explicit functions.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aive", {
  platform: process.platform,
  /** Open a native file picker; returns an array of absolute paths. */
  pickFiles: () => ipcRenderer.invoke("dialog:openFiles"),
  /** Open a native save dialog; returns an absolute path or null. */
  pickSavePath: (ext) => ipcRenderer.invoke("dialog:saveFile", ext),
  /** Open a native picker for a .aive project; returns an absolute path or null. */
  openProject: () => ipcRenderer.invoke("dialog:openProject"),
  /** Native save dialog for a .aive project; returns an absolute path or null. */
  saveProjectAs: (defaultName) => ipcRenderer.invoke("dialog:saveProject", defaultName),
  /** Subscribe to native-menu actions ("new"|"open"|"save"|"save-as"|"undo"|"redo"). */
  onMenu: (cb) => ipcRenderer.on("menu", (_e, action) => cb(action)),
  /** Report unsaved/has-file state so the main process can guard quit. */
  reportProjectState: (state) => ipcRenderer.send("project:state", state),
  /** A project save failed: a "Save before closing?" request must not quit on a later save. */
  reportSaveFailed: () => ipcRenderer.send("project:save-failed"),
  /** Ready-to-paste MCP client config for this exact install (no repo path guessing). */
  getMcpConfig: () => ipcRenderer.invoke("mcp:config"),
  /** Network computers: the main process asks in a native dialog the page can't answer. */
  mediaServers: {
    /** Review server `host` (Allow, or Keep for one added outside ZabsReel); resolves true when it is allowed. `context` only changes the wording. */
    approve: (host, context) => ipcRenderer.invoke("media-servers:approve", host, context),
    /** Remove server `host` from the allowed list (no dialog); rejects when that could not be saved. */
    revoke: (host) => ipcRenderer.invoke("media-servers:revoke", host),
  },
});
