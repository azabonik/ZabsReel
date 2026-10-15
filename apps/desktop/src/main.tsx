import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CoreApi } from "./api";
import { initPlatform } from "./platform";
import { PlatformHost } from "./pathpicker";
import type { MediaServers } from "./types";
import "./styles.css";

// The core port + session token are passed as ?port=NNNN&token=… — by the
// Electron main process, or in the URL the web shell (web/server.cjs) prints,
// which also adds &shell=… (the key to the shell's own /api).
// In a plain browser with no ?port, fall back to the default core port (4791).
const params = new URLSearchParams(window.location.search);
let port = Number(params.get("port")) || 0;
let token = params.get("token");
let shell = params.get("shell") ?? "";

// Served over http (web shell / Vite): keep the session so a reload still
// works, then take the token out of the address bar so it isn't left in view,
// bookmarks or screenshots. Electron loads from file:// and is left as-is.
// sessionStorage, not localStorage: it belongs to this tab and is cleared when
// the tab closes. localStorage would keep a live token on disk, readable by
// any page served later on the same origin (e.g. another Vite project on
// localhost:5173), which could then drive the core. A new tab needs the link.
if (location.protocol === "http:" || location.protocol === "https:") {
  try {
    if (token) sessionStorage.setItem("aive.session", JSON.stringify({ port, token, shell }));
    else {
      const saved = JSON.parse(sessionStorage.getItem("aive.session") || "null") as { port?: number; token?: string; shell?: string } | null;
      if (saved?.token) {
        token = saved.token;
        port ||= Number(saved.port) || 0;
        shell = saved.shell ?? "";
      }
    }
  } catch { /* storage blocked — the URL token still works for this load */ }
  // Earlier builds kept the session in localStorage; remove any copy left there.
  try { localStorage.removeItem("aive.session"); } catch { /* ignore */ }
  if (params.has("token") || params.has("shell")) history.replaceState(null, "", location.pathname + location.hash);
}
port ||= 4791;
token ??= "";

// Desktop shell only: lets CSS make room for the native window controls.
if (window.aive) document.documentElement.classList.add("is-electron");

const api = new CoreApi(port, token);
api.connect();
initPlatform(shell, () => api.rpc<MediaServers>("list_media_servers"));

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <App api={api} />
    <PlatformHost />
  </React.StrictMode>,
);
