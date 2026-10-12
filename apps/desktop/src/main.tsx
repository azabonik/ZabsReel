import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CoreApi } from "./api";
import { initPlatform } from "./platform";
import { PlatformHost } from "./pathpicker";
import "./styles.css";

// The core port + session token are passed as ?port=NNNN&token=… — by the
// Electron main process, or in the URL the web shell (web/server.cjs) prints.
// In a plain browser with no ?port, fall back to the default core port.
const params = new URLSearchParams(window.location.search);
let port = Number(params.get("port")) || 0;
let token = params.get("token");

// Served over http (web shell / Vite): keep the session for reloads and new
// tabs, then take the token out of the address bar so it isn't left in view,
// bookmarks or screenshots. Electron loads from file:// and is left as-is.
if (location.protocol === "http:" || location.protocol === "https:") {
  try {
    if (token) localStorage.setItem("aive.session", JSON.stringify({ port, token }));
    else {
      const saved = JSON.parse(localStorage.getItem("aive.session") || "null") as { port?: number; token?: string } | null;
      if (saved?.token) {
        token = saved.token;
        port ||= Number(saved.port) || 0;
      }
    }
  } catch { /* storage blocked — the URL token still works for this load */ }
  if (params.has("token")) history.replaceState(null, "", location.pathname + location.hash);
}
port ||= 4789;
token ??= "";

// Desktop shell only: lets CSS make room for the native window controls.
if (window.aive) document.documentElement.classList.add("is-electron");

const api = new CoreApi(port, token);
api.connect();
initPlatform(token);

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <App api={api} />
    <PlatformHost />
  </React.StrictMode>,
);
