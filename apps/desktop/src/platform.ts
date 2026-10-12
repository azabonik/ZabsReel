// Host services the UI needs beyond the core's RPC: file pickers and the MCP
// client config. The renderer runs under three hosts:
//   electron — the desktop shell; native dialogs via the preload bridge (window.aive)
//   web      — the localhost web shell (web/server.cjs); an in-app picker that
//              browses the disk through the shell's token-gated /api
//   bare     — a plain Vite page with no shell; window.prompt for paths
// App code calls `platform.*` and never needs to know which one it got.

export type McpConfig = { available: boolean; packaged: boolean; mcpEntry: string | null; json: string };
export type FileFilter = { name: string; extensions: string[] }; // extensions without the dot; "*" = any
export type Place = { label: string; path: string };
export type FsEntry = { name: string; dir: boolean; size: number | null; mtime: number | null; hidden: boolean };
export type FsListing = { path: string; parent: string | null; sep: string; entries: FsEntry[]; truncated: boolean };
export type WebConfig = { platform: string; sep: string; home: string; places: Place[]; mcp: McpConfig };

/** `key` names the remembered start folder; `confirmLabel` is the primary button's text. */
export type PickRequest =
  | { mode: "open"; multiple: boolean; title: string; confirmLabel: string; filters: FileFilter[]; key: string }
  | { mode: "save"; title: string; confirmLabel: string; filters: FileFilter[]; defaultName: string; key: string };
export type PendingPick = PickRequest & { id: number; resolve: (paths: string[] | null) => void };

export type HostStatus = "detecting" | "electron" | "web" | "bare" | "expired";

// Same filters as the Electron dialogs in electron/main.cjs.
const MEDIA_FILTERS: FileFilter[] = [
  { name: "Media", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "wav", "mp3", "aac", "png", "jpg", "jpeg", "webp", "gif", "bmp"] },
  { name: "All Files", extensions: ["*"] },
];
const PROJECT_FILTERS: FileFilter[] = [
  { name: "SynthCut Project", extensions: ["aive"] },
  { name: "All Files", extensions: ["*"] },
];
// One filter per container the export presets produce (core EXPORT_PRESETS:
// mp4 / webm / mov). The preset's own container is listed first so it is the
// default; typing another of these extensions switches the filter to match.
const EXPORT_FORMATS: FileFilter[] = [
  { name: "MP4 Video", extensions: ["mp4"] },
  { name: "WebM Video", extensions: ["webm"] },
  { name: "QuickTime Movie", extensions: ["mov"] },
];
export function exportFilters(ext = "mp4"): FileFilter[] {
  const first = EXPORT_FORMATS.find((f) => f.extensions[0] === ext) ?? EXPORT_FORMATS[0];
  return [first, ...EXPORT_FORMATS.filter((f) => f !== first)];
}

// ---- tiny external store (read by PlatformHost via useSyncExternalStore) ----

type Snapshot = { status: HostStatus; config: WebConfig | null; pending: PendingPick | null };
let snapshot: Snapshot = { status: "detecting", config: null, pending: null };
const listeners = new Set<() => void>();

function set(patch: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((l) => l());
}
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function getSnapshot(): Snapshot {
  return snapshot;
}

// ---- web shell API ----

let token = "";

/** GET a web-shell /api endpoint with the session token. */
export async function api<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { "x-aive-token": token } });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || body.ok === false) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body as T;
}

let detected: Promise<HostStatus> | null = null;

/** Work out which host we're in. Call once at startup with the core session token. */
export function initPlatform(sessionToken: string): Promise<HostStatus> {
  token = sessionToken;
  detected ??= (async (): Promise<HostStatus> => {
    if (window.aive) {
      set({ status: "electron" });
      return "electron";
    }
    try {
      const config = await api<WebConfig>("/api/config");
      set({ status: "web", config });
      return "web";
    } catch (err) {
      // 401 = the web shell is there but this tab's token is missing or from an
      // earlier run. Anything else (404, proxy error, offline) = no shell.
      const status: HostStatus = (err as { status?: number }).status === 401 ? "expired" : "bare";
      set({ status });
      return status;
    }
  })();
  return detected;
}

function host(): Promise<HostStatus> {
  return detected ?? initPlatform(token);
}

let pickSeq = 0;

/** Show the in-app picker; resolves with absolute paths, or null if cancelled. */
function requestPick(req: PickRequest): Promise<string[] | null> {
  snapshot.pending?.resolve(null);
  return new Promise((resolve) => {
    set({
      pending: {
        ...req,
        id: ++pickSeq,
        resolve: (paths) => {
          set({ pending: null });
          resolve(paths);
        },
      },
    });
  });
}

export const platform = {
  async pickFiles(): Promise<string[]> {
    const h = await host();
    if (h === "electron") return window.aive!.pickFiles();
    if (h === "web") return (await requestPick({ mode: "open", multiple: true, title: "Import media", confirmLabel: "Import", filters: MEDIA_FILTERS, key: "media" })) ?? [];
    if (h === "expired") return [];
    const p = window.prompt("Absolute path to a media file:");
    return p ? [p] : [];
  },

  /** `ext` (mp4 | webm | mov) is the container of the chosen export preset. */
  async pickSavePath(ext = "mp4"): Promise<string | null> {
    const h = await host();
    if (h === "electron") return window.aive!.pickSavePath(ext);
    if (h === "web") return (await requestPick({ mode: "save", title: "Export video", confirmLabel: "Export here", filters: exportFilters(ext), defaultName: `export.${ext}`, key: "export" }))?.[0] ?? null;
    if (h === "expired") return null;
    return window.prompt(`Absolute output path (.${ext}):`);
  },

  async openProject(): Promise<string | null> {
    const h = await host();
    if (h === "electron") return window.aive!.openProject();
    if (h === "web") return (await requestPick({ mode: "open", multiple: false, title: "Open project", confirmLabel: "Open", filters: PROJECT_FILTERS, key: "project" }))?.[0] ?? null;
    if (h === "expired") return null;
    return window.prompt("Absolute path to a .aive project:");
  },

  async saveProjectAs(defaultName: string): Promise<string | null> {
    const h = await host();
    if (h === "electron") return window.aive!.saveProjectAs(defaultName);
    const base = `${(defaultName || "Untitled").replace(/\.aive$/i, "")}.aive`;
    if (h === "web") return (await requestPick({ mode: "save", title: "Save project as", confirmLabel: "Save", filters: PROJECT_FILTERS.slice(0, 1), defaultName: base, key: "project" }))?.[0] ?? null;
    if (h === "expired") return null;
    return window.prompt("Absolute path to save (.aive):");
  },

  async getMcpConfig(): Promise<McpConfig | null> {
    const h = await host();
    if (h === "electron") return (await window.aive!.getMcpConfig?.()) ?? null;
    if (h === "web") return snapshot.config?.mcp ?? null;
    return null;
  },
};
