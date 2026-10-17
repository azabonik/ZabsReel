// The render page's preload (MOTION-PLAN D2): the page gets these two calls
// and nothing else of Electron or Node.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("zrMotionHost", {
  /** Frame n is drawn and painted; `cues` are its audio cues (none until the runtime has audio). */
  frameReady: (n, cues) => ipcRenderer.send("zr-motion:frame-ready", n, Array.isArray(cues) ? cues : []),
  /** One line for the core's log. */
  log: (text) => ipcRenderer.send("zr-motion:log", String(text).slice(0, 2000)),
});
