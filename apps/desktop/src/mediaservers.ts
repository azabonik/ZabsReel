// Network computers in the editor (core hosttrust.ts, list_media_servers):
// media on a server the user has not allowed is offline, and nothing in the
// renderer asks the core for its file. This module holds the wording of the
// banner above the preview and of the offline badges, and the LUT rule of the
// live preview (networkcomputers.tsx draws them). The renderer never allows a
// server itself: Review… asks the UI host (platform.approveMediaServer),
// whose own dialog decides.
import { PRODUCT_NAME } from "@aive/core/brand";
import { classifyPath } from "@aive/core/unc";
import type { MediaAsset, MediaServers, Project } from "./types";

type Pending = MediaServers["pending"][number];

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** `\\host`, as the UI writes a network computer. */
export const show = (host: string) => `\\\\${host}`;

/** The one line shown in place of every per-server line while the store can't be read. */
export const UNREAD_LINE = `${PRODUCT_NAME} couldn't read its list of approved computers; retrying. Clips on network computers stay offline until it can.`;
/** No UI host here (a bare Vite page): nothing can allow a server. */
export const BARE_LINE = `Open ${PRODUCT_NAME} (the app or npm run web) to review this network computer.`;

/**
 * Whether the live preview may fetch a LUT at `path` (gl/runtime setLutGate),
 * or null for every path: only while the core enforces the gate is a LUT on a
 * server that is not allowed (or a refused form) left out.
 */
export function lutGateFor(ms: MediaServers | null): ((path: string) => boolean) | null {
  if (!ms || ms.gate !== "enforce") return null;
  const allowed = new Set(ms.approved.map((a) => a.host));
  if (ms.dataFolderHost) allowed.add(ms.dataFolderHost);
  return (path) => {
    const c = classifyPath(path);
    return c.kind === "local" || (c.kind === "network" && allowed.has(c.host));
  };
}

/** The network computer a path is on, or null. */
function hostOf(path: string): string | null {
  const c = classifyPath(path);
  return c.kind === "network" ? c.host : null;
}

/** What an offline asset waits for: the badge's and the timeline clip's label, and its action. */
export function offlineState(a: MediaAsset, ms: MediaServers | null): { label: string; action: "review" | "retry" | null } | null {
  if (a.awaitingServer) {
    if (ms?.unread.length) return { label: `Offline: ${PRODUCT_NAME} couldn't read its list of approved computers; retrying`, action: null };
    return { label: `Offline: waiting for you to allow ${show(a.awaitingServer)}`, action: "review" };
  }
  if (a.pathCheckFailed) {
    if (a.pathCheckFailed === "private") return { label: `Offline: this file is in ${PRODUCT_NAME}'s private settings folder`, action: null };
    const host = hostOf(a.path);
    return { label: `Offline: ${PRODUCT_NAME} couldn't check this file's folder${host ? ` on ${show(host)}` : ""}`, action: "retry" };
  }
  if (a.missing) return { label: "Offline: file not found", action: null };
  return null;
}

/** One banner line. `who` is the server's display name, shown in bold. */
export type Line = { key: string; host?: string; before: string; who: string; after: string; action: "review" | "retry" | null };

/**
 * The banner's lines: one per pending server (outside wording first, then the
 * project's use, then a request: "You tried" only when every example path is
 * one the renderer itself sent), then one per server with files whose folder
 * could not be checked. In the unread state only UNREAD_LINE (the caller).
 */
export function bannerLines(ms: MediaServers, project: Project | null, own: ReadonlySet<string>, dismissed: ReadonlySet<string>): Line[] {
  const lines: Line[] = [];
  for (const p of ms.pending) {
    if (dismissed.has(p.host)) continue;
    lines.push({ key: p.host, host: p.host, action: "review", ...pendingWords(p, own) });
  }
  const unchecked = new Map<string, { files: number; code: string }>();
  for (const a of project?.assets ?? []) {
    if (!a.pathCheckFailed || a.pathCheckFailed === "private") continue;
    const host = hostOf(a.path) ?? "";
    const u = unchecked.get(host) ?? { files: 0, code: a.pathCheckFailed };
    unchecked.set(host, { ...u, files: u.files + 1 });
  }
  for (const [host, u] of unchecked) {
    lines.push({
      key: `check:${host}`, action: "retry",
      before: `${PRODUCT_NAME} couldn't check the folder of ${plural(u.files, "file")}${host ? " on " : ""}`,
      who: host ? show(host) : "",
      after: ` (${u.code}), so it didn't open ${u.files === 1 ? "it" : "them"}. ${u.files === 1 ? "It stays" : "They stay"} offline until the folder can be read.`,
    });
  }
  return lines;
}

function pendingWords(p: Pending, own: ReadonlySet<string>): Pick<Line, "before" | "who" | "after"> {
  const who = show(p.host);
  const uses = p.origins.includes("project") && p.files > 0;
  if (p.origins.includes("outside")) {
    return uses
      ? { before: `This project uses ${plural(p.files, "file")} on `, who, after: `. It is in your list of allowed network computers, but ${PRODUCT_NAME} didn't put it there, so they stay offline until you check it.` }
      : { before: "", who, after: ` is in your list of allowed network computers, but ${PRODUCT_NAME} didn't put it there. ${PRODUCT_NAME} won't use it until you check it.` };
  }
  if (uses) return { before: `This project uses ${plural(p.files, "file")} on the network computer `, who, after: ". They stay offline until you allow it." };
  if (p.examples.length > 0 && p.examples.every((e) => own.has(e))) {
    return { before: "You tried to open a file on the network computer ", who, after: ". Nothing has been opened yet." };
  }
  return { before: "The AI assistant asked to open a file on the network computer ", who, after: ". Nothing has been opened." };
}
