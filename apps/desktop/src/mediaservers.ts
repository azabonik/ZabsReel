// Network computers in the editor (core hosttrust.ts, list_media_servers):
// media on a server the user has not allowed is offline, and nothing in the
// renderer asks the core for its file. This module holds the wording of the
// banner above the preview, of the offline badges and of the web shell's
// approval dialogs, and the LUT rule of the live preview (networkcomputers.tsx
// and reviewdialog.tsx draw them). The renderer never allows a server itself:
// Review… asks the UI host (platform.approveMediaServer), whose own dialog
// decides and whose own process writes the store.
import { PRODUCT_NAME } from "@aive/core/brand";
import { classifyPath, examplePath } from "@aive/core/unc";
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

/**
 * The recent projects that stay in the window's own-request set ("You
 * tried…") once remember_projects answered: the ones it skipped on a network
 * computer, whose server is pending because this window asked (sanitized as
 * in the pending list).
 */
export function ownRecentPaths(skipped: readonly { path: string }[]): Set<string> {
  return new Set(skipped.filter((s) => classifyPath(s.path).kind === "network").map((s) => examplePath(s.path)));
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

// ---- the web shell's approval dialogs ----------------------------------------
// The same wording and rules as electron/media-servers.cjs (the native
// dialogs); smoke-savename checks that the two agree.

/** An approval dialog: `buttons[0]` is the default and Esc (Keep offline, Remove), `buttons[1]` approves. */
export type ApprovalText = { title: string; message: string; detail: string; buttons: [string, string] };

/** "This project uses 3 files stored there, for example …", when the open project uses the server. */
function projectUse(entry: Pending | undefined): string | null {
  if (!entry || !entry.origins.includes("project") || !entry.files) return null;
  const ex = entry.examples[0];
  return `This project uses ${plural(entry.files, "file")} stored there${ex ? `, for example ${ex}` : ""}.`;
}

/**
 * The path the page says the user opened, when the core agrees: `context` is
 * `{ origin: "user", path }`, the path is on server `key`, and the core's
 * pending entry lists it (sanitized as the core does) among the examples of a
 * request. Otherwise null. Display-only: it never changes what Allow does.
 */
export function userContextPath(context: { origin?: string; path?: unknown } | undefined, key: string, entry: Pending | undefined): string | null {
  if (!context || context.origin !== "user" || typeof context.path !== "string") return null;
  const c = classifyPath(context.path);
  if (c.kind !== "network" || c.host !== key) return null;
  const shown = examplePath(context.path);
  return entry && entry.origins.includes("request") && entry.examples.includes(shown) ? shown : null;
}

/** "Allow media from \\nas?" (Keep offline is the default and Esc). `platform` is the host's process.platform. */
export function allowDialogText(key: string, entry: Pending | undefined, userPath: string | null, platform: string): ApprovalText {
  const asked = entry && entry.origins.includes("request") && entry.examples[0] ? `The AI assistant asked to open ${entry.examples[0]}.` : null;
  const first = userPath ? `You opened ${userPath}.` : projectUse(entry) ?? asked;
  const risk = platform === "win32"
    ? `When ${PRODUCT_NAME} opens them, Windows may automatically send your Windows sign-in (a scrambled copy of your password) to that computer. Allow it only if you know and trust this computer, for example your own network drive.`
    : `To open them, ${PRODUCT_NAME} connects to that computer. Allow it only if you know and trust it.`;
  const after = `Until you allow it, those clips stay offline and ${PRODUCT_NAME} does not contact that computer. You can remove it later in Project → Network computers.`;
  return {
    title: `Allow media from ${show(key)}?`,
    message: `Allow ${PRODUCT_NAME} to open files on the network computer "${key}"?`,
    detail: [first, risk, after].filter(Boolean).join("\n\n"),
    buttons: ["Keep offline", "Allow"],
  };
}

/** The Keep dialog for a server added outside ZabsReel (Remove is the default and Esc). */
export function keepDialogText(key: string, entry: Pending | undefined, platform: string): ApprovalText {
  const keepOnly = platform === "win32"
    ? `Keep it only if you added it yourself. When ${PRODUCT_NAME} opens files there, Windows may automatically send your Windows sign-in (a scrambled copy of your password) to that computer.`
    : `Keep it only if you added it yourself. To open files there, ${PRODUCT_NAME} connects to that computer.`;
  return {
    title: `Keep ${show(key)}?`,
    message: `"${key}" was added to your allowed network computers outside ${PRODUCT_NAME}.`,
    detail: [
      `${PRODUCT_NAME} didn't add it. Something changed ${PRODUCT_NAME}'s settings file directly: you, another program, or an AI assistant that can run commands on this computer.`,
      projectUse(entry),
      keepOnly,
      `If you remove it, those files stay offline and ${PRODUCT_NAME} asks you again if a project needs them.`,
    ].filter(Boolean).join("\n\n"),
    buttons: ["Remove", "Keep"],
  };
}

/** Shown in place of any approval dialog while the store can't be read and there is no good copy yet. */
export const UNREAD_DIALOG = `${PRODUCT_NAME} couldn't read its list of approved computers just now. Try again in a moment.`;
