// Host services the UI needs beyond the core's RPC: file pickers and the MCP
// client config. The renderer runs under three hosts:
//   electron — the desktop shell; native dialogs via the preload bridge (window.aive)
//   web      — the localhost web shell (web/server.cjs); an in-app picker that
//              browses the disk through the shell's /api (behind its shell key),
//              and in-app dialogs to allow network computers
//   bare     — a plain Vite page with no shell; window.prompt for paths
// App code calls `platform.*` and never needs to know which one it got.

import { PRODUCT_NAME } from "@aive/core/brand";
import { approvalDialogFor, bareFileName, classifyPath, normalizeHost } from "@aive/core/unc";
import type { ApproveContext, GraphicsAddonResult, GraphicsAddonStatus, GraphicsAddonTerms, MediaServers } from "./types";
import { UNREAD_DIALOG, allowDialogText, keepDialogText, userContextPath, type ApprovalText } from "./mediaservers";

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
/**
 * An in-app dialog of the web shell: an approval dialog (Allow, or Keep for a
 * server added outside ZabsReel) resolves true for its second button, false
 * for the first (the default, and Esc); "unread" only says the list can't be
 * read and resolves false.
 */
export type PendingReview =
  | { kind: "allow" | "keep"; id: number; text: ApprovalText; resolve: (approve: boolean) => void }
  | { kind: "unread"; id: number; text: { title: string; message: string }; resolve: (approve: boolean) => void };

export type HostStatus = "detecting" | "electron" | "web" | "bare" | "expired";

// Same filters as the Electron dialogs in electron/main.cjs.
const MEDIA_FILTERS: FileFilter[] = [
  { name: "Media", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "wav", "mp3", "aac", "png", "jpg", "jpeg", "webp", "gif", "bmp"] },
  { name: "All Files", extensions: ["*"] },
];
export const PROJECT_FILTERS: FileFilter[] = [
  { name: `${PRODUCT_NAME} Project`, extensions: ["aive"] },
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

type Snapshot = { status: HostStatus; config: WebConfig | null; pending: PendingPick | null; review: PendingReview | null };
let snapshot: Snapshot = { status: "detecting", config: null, pending: null, review: null };
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

/** The web shell's key (the launch URL's `shell`): it alone opens /api, the core token does not. */
let shellKey = "";
/** The core's list_media_servers: what the web dialogs show and pick from. */
let listMediaServers: () => Promise<MediaServers> = () => Promise.reject(new Error("not connected"));

/** Call a web-shell /api endpoint with the shell key: GET, or POST with a JSON `body`. */
export async function api<T>(path: string, body?: object): Promise<T> {
  const res = await fetch(path, body === undefined
    ? { headers: { "x-zabsreel-shell": shellKey } }
    : { method: "POST", headers: { "x-zabsreel-shell": shellKey, "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || out.ok === false) throw Object.assign(new Error(out.error || `HTTP ${res.status}`), { status: res.status });
  return out as T;
}

let detected: Promise<HostStatus> | null = null;

/**
 * Work out which host we're in. Call once at startup with the web shell's key
 * (empty elsewhere) and a way to read the core's list_media_servers.
 */
export function initPlatform(shell: string, mediaServers: () => Promise<MediaServers>): Promise<HostStatus> {
  shellKey = shell;
  listMediaServers = mediaServers;
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
      // 401 = the web shell is there but this tab's key is missing or from an
      // earlier run. Anything else (404, proxy error, offline) = no shell.
      const status: HostStatus = (err as { status?: number }).status === 401 ? "expired" : "bare";
      set({ status });
      return status;
    }
  })();
  return detected;
}

function host(): Promise<HostStatus> {
  return detected ?? initPlatform(shellKey, listMediaServers);
}

let pickSeq = 0;

/**
 * Show the in-app picker; resolves with absolute paths, or null if cancelled.
 * A picked file on a network computer is allowed first (picker auto-trust),
 * when the shell listed that folder for the user; otherwise the core refuses
 * it and the page asks.
 */
async function requestPick(req: PickRequest): Promise<string[] | null> {
  snapshot.pending?.resolve(null);
  const paths = await new Promise<string[] | null>((resolve) => {
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
  if (paths?.some((p) => classifyPath(p).kind === "network")) {
    await api("/api/media-servers/picked", { paths }).catch(() => { /* not saved: the core refuses, the page asks */ });
  }
  return paths;
}

/**
 * Show an in-app review dialog (reviewdialog.tsx); resolves with the user's
 * answer. One at a time (approveMediaServer queues them): false is an answer
 * (Keep offline, or Remove), so an open dialog is never closed with it.
 */
function requestReview(r: Omit<PendingReview, "id" | "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    set({
      review: {
        ...r,
        id: ++pickSeq,
        resolve: (approve: boolean) => {
          set({ review: null });
          resolve(approve);
        },
      } as PendingReview,
    });
  });
}

/**
 * The web shell's review of server `key`, as electron/main.cjs does it: the
 * core's list picks the dialog (approvalDialogFor) and gives the counts and
 * examples; `context` only changes the wording. The shell writes the store.
 */
async function reviewInPage(key: string, context: ApproveContext | undefined): Promise<boolean> {
  const ms = await listMediaServers();
  const which = approvalDialogFor(ms, key);
  if (which === "unread") {
    await requestReview({ kind: "unread", text: { title: "Network computers", message: UNREAD_DIALOG } });
    return false;
  }
  if (which === "allow" && ms.approved.some((a) => a.host === key)) return true; // allowed already (another tab, or the app)
  const entry = ms.pending.find((p) => p.host === key);
  const os = snapshot.config?.platform ?? "";
  if (which === "keep") {
    if (await requestReview({ kind: "keep", text: keepDialogText(key, entry, os) })) {
      await api("/api/media-servers/approve", { host: key });
      return true;
    }
    // Remove, or Esc: only while it is still outside (another tab or the app may have kept it meanwhile).
    const { removed } = await api<{ removed: boolean }>("/api/media-servers/revoke", { host: key, onlyIfOutside: true });
    return !removed;
  }
  if (!(await requestReview({ kind: "allow", text: allowDialogText(key, entry, userContextPath(context, key, entry), os) }))) return false;
  await api("/api/media-servers/approve", { host: key });
  return true;
}

/** The web shell's reviews, one after another; each reads the core's list when its turn comes. */
let reviews: Promise<unknown> = Promise.resolve();

const NO_ADDON_HOST = `Open ${PRODUCT_NAME} (the app or npm run web) to install the graphics add-on.`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The graphics add-on (Help → Graphics add-on…). Only a UI host process
 * (Electron main, the web shell behind its shell key) installs or removes it,
 * and only from the add-on dialog's buttons; the core can't.
 */
const graphicsAddon = {
  /** Whether this host can install the add-on (the bare page can't). */
  available(): boolean {
    return snapshot.status === "electron" || snapshot.status === "web";
  },

  async status(): Promise<GraphicsAddonStatus> {
    const h = await host();
    if (h === "electron" && window.aive!.graphicsAddon) return window.aive!.graphicsAddon.status();
    if (h === "web") return api<GraphicsAddonStatus>("/api/graphics-addon/status");
    throw new Error(NO_ADDON_HOST);
  },

  /** The notice and licence to show before an install, or null where the add-on isn't offered. */
  async terms(): Promise<GraphicsAddonTerms | null> {
    const h = await host();
    if (h === "electron" && window.aive!.graphicsAddon) return window.aive!.graphicsAddon.terms();
    if (h === "web") return (await api<{ terms: GraphicsAddonTerms | null }>("/api/graphics-addon/terms")).terms;
    throw new Error(NO_ADDON_HOST);
  },

  /**
   * Install, with the hash of the terms the user accepted (the dialog's
   * Accept button). Resolves when it ends; `onProgress` gets the bytes. The
   * web shell runs it in the background, and this follows its status.
   */
  async install(acceptedLicenseSha256: string, onProgress: (p: { done: number; total: number }) => void): Promise<GraphicsAddonResult> {
    const h = await host();
    if (h === "electron" && window.aive!.graphicsAddon) {
      const off = window.aive!.graphicsAddon.onProgress(onProgress);
      try {
        return await window.aive!.graphicsAddon.install(acceptedLicenseSha256);
      } finally {
        off();
      }
    }
    if (h !== "web") throw new Error(NO_ADDON_HOST);
    const { id } = await api<{ id: number }>("/api/graphics-addon/install", { acceptedLicenseSha256 });
    for (;;) {
      await pause(300);
      const s = await graphicsAddon.status();
      if (s.job?.id === id) onProgress({ done: s.job.done, total: s.job.total });
      else if (s.last?.id === id) return { ok: s.last.ok, error: s.last.error, cancelled: s.last.cancelled };
      else if (!s.job) return { ok: false, error: "The web shell lost track of the install. Open the dialog again." };
    }
  },

  async cancel(): Promise<void> {
    const h = await host();
    if (h === "electron" && window.aive!.graphicsAddon) await window.aive!.graphicsAddon.cancel();
    else if (h === "web") await api("/api/graphics-addon/cancel", {});
  },

  async remove(): Promise<GraphicsAddonResult> {
    const h = await host();
    if (h === "electron" && window.aive!.graphicsAddon) return window.aive!.graphicsAddon.remove();
    if (h !== "web") throw new Error(NO_ADDON_HOST);
    try {
      await api("/api/graphics-addon/remove", {});
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

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
    // Only the bare file name: the name comes from the project (a file or the
    // agent can set it), and must never point the picker at a folder.
    const base = `${bareFileName(defaultName || "Untitled").replace(/\.aive$/i, "")}.aive`;
    if (h === "web") return (await requestPick({ mode: "save", title: "Save project as", confirmLabel: "Save", filters: PROJECT_FILTERS.slice(0, 1), defaultName: base, key: "project" }))?.[0] ?? null;
    if (h === "expired") return null;
    return window.prompt("Absolute path to save (.aive):");
  },

  /**
   * Whether this host can allow a network computer: only a UI host process
   * (Electron main, the web shell) can write the approval store, after its
   * own dialog. The bare page can't.
   */
  canReviewMediaServers(): boolean {
    return snapshot.status === "electron" || snapshot.status === "web";
  },

  /**
   * Review network computer `server`: the host shows the Allow dialog (or Keep,
   * for one added outside ZabsReel, or only "couldn't read its list"). True
   * when the server is allowed now. `context` only changes the dialog's wording.
   */
  async approveMediaServer(server: string, context?: ApproveContext): Promise<boolean> {
    const h = await host();
    if (h === "electron" && window.aive!.mediaServers) return window.aive!.mediaServers.approve(server, context);
    if (h !== "web") return false;
    const n = normalizeHost(server);
    if (!n.ok) return false;
    // A second review waits for the open one: answering it for the user could remove a server (Keep's default).
    const next = reviews.then(() => reviewInPage(n.key, context));
    reviews = next.catch(() => {});
    return next;
  },

  /** Remove `server` from the allowed list (Project → Network computers). Rejects when that could not be saved. */
  async revokeMediaServer(server: string): Promise<void> {
    const h = await host();
    if (h === "electron" && window.aive!.mediaServers) return window.aive!.mediaServers.revoke(server);
    if (h === "web") {
      await api("/api/media-servers/revoke", { host: server });
      return;
    }
    throw new Error(`Open ${PRODUCT_NAME} (the app or npm run web) to change the network computers.`);
  },

  graphicsAddon,

  async getMcpConfig(): Promise<McpConfig | null> {
    const h = await host();
    if (h === "electron") return (await window.aive!.getMcpConfig?.()) ?? null;
    if (h === "web") return snapshot.config?.mcp ?? null;
    return null;
  },
};
