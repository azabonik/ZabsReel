// The render page's preload (MOTION-PLAN D2): the page gets these three calls
// and nothing else of Electron or Node.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("zrMotionHost", {
  /** Frame n is drawn and painted; `cues` are its audio cues. */
  frameReady: (n, cues) => ipcRenderer.send("zr-motion:frame-ready", n, Array.isArray(cues) ? cues : []),
  /** Frame n failed: the error's code ("" when it has none) and message. The render ends. */
  frameFailed: (n, code, message) => ipcRenderer.send("zr-motion:frame-failed", n, String(code).slice(0, 64), String(message).slice(0, 2000)),
  /** One line for the core's log. */
  log: (text) => ipcRenderer.send("zr-motion:log", String(text).slice(0, 2000)),
});
