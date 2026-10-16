/**
 * The core's side of the approval store (trusthosts.ts): which network
 * computers it may open files on, and the guard that keeps every rpc read or
 * write out of the private areas (G2): the trust folder and the graphics
 * add-on folder (<dataDir>/addons, which the UI hosts install into).
 *
 * One HostTrust per engine. It holds the approved servers (valid stamps only)
 * plus the data folder's own server, and publishes them to io/gatedfs.ts
 * (setAllowedNetworkHosts) with the trust folder (setTrustDir). Servers added
 * outside ZabsReel are listed but never published. It picks up changes
 * without a restart:
 *  - a check that meets a server it does not trust re-reads the store when
 *    the size, mtime or file id of hosts.json or hosts.key changed;
 *  - while a file could not be read (stale or unread), the next check of any
 *    server re-reads it, at most once a second, and in the unread state a 1 s
 *    timer re-reads it too, so the state ends without waiting for a check;
 *  - fs.watch on the trust folder re-reads it (200 ms debounce); on WSL/9p and
 *    shares the watch may not fire, so the UI hosts also ask for a re-check.
 *
 * It also keeps the pending list: servers the open project uses but the user
 * has not allowed (origin "project", set by the engine's G3 marking), servers
 * an rpc call asked for (origin "request", G1: {@link HostTrust.requirePath}),
 * and servers added outside ZabsReel (origin "outside", from the store).
 *
 * While io/gatedfs.ts NETWORK_GATE is "log", {@link HostTrust.isAllowed} only
 * logs what it would block, and nothing is pending. G2 and the load-field
 * check are always enforced. Neither resolves a path with a ".." segment
 * ({@link hasDotDot}): an rpc path with one is refused (EDOTDOT), a loaded
 * field with one stays offline.
 */
import { posix, win32, type PlatformPath } from "node:path";
import { PRODUCT_NAME } from "./brand.js";
import { classifyPath, examplePath } from "./unc.js";
import { readTrustedHosts, trustDir, type ApprovedHost, type ReadErrorInjection, type TrustFile } from "./trusthosts.js";
import {
  classifyFsText,
  isTrustPath,
  lstatSync,
  networkGateEnforced,
  realpathNative,
  setAllowedNetworkHosts,
  setTrustDir,
  statSync,
  watch,
} from "./io/gatedfs.js";
import type { Project } from "./types.js";

/** Why a server is pending: the open project uses it, an rpc call asked for it, or it was added outside ZabsReel. */
export type PendingOrigin = "project" | "request" | "outside";

/** A server waiting for the user (list_media_servers.pending). Examples are sanitized paths. */
export interface PendingServer {
  host: string;
  display: string;
  origins: PendingOrigin[];
  /** Files the open project uses there. */
  files: number;
  examples: string[];
  since: string;
}

/** list_media_servers: the store as the core reads it (no stamp, no key) and the pending list. */
export interface MediaServers {
  gate: "log" | "enforce";
  approved: { host: string; display: string; via: ApprovedHost["via"]; added: string }[];
  outside: { host: string; display: string }[];
  unread: TrustFile[];
  pending: PendingServer[];
  dataFolderHost?: string;
}

/** G1: an rpc path on a network computer the user has not allowed (rpc code media_server_not_approved). */
export class MediaServerNotApprovedError extends Error {
  readonly code = "media_server_not_approved";
  constructor(
    message: string,
    readonly host: string,
    readonly display: string,
    readonly path: string,
    /** The server is in the store but was added outside ZabsReel. */
    readonly outside = false,
    /** The store could not be read yet: the server may be approved. */
    readonly unread = false,
  ) {
    super(message);
    this.name = "MediaServerNotApprovedError";
  }
}

/** G4 / G5: media the call needs is offline (rpc code media_offline). */
export class MediaOfflineError extends Error {
  readonly code = "media_offline";
  constructor(
    message: string,
    /** The servers it waits for (host keys). */
    readonly hosts: string[],
  ) {
    super(message);
    this.name = "MediaOfflineError";
  }
}

/** How long an rpc request keeps its server pending. */
const REQUEST_TTL_MS = 30 * 60_000;

/** Sanitized example paths (unc.ts, so the UI hosts compare paths the same way). */
export { examplePath };

/** A file's identity: equal dev and ino are one file, under any spelling of its path (ino 0 means unknown). */
interface FileId {
  dev: bigint;
  ino: bigint;
}

export interface HostTrustOptions {
  /** Called after a re-read changed what is approved, outside or unread. */
  onChange?: () => void;
  /** Called when an rpc request made a server pending (the project's own entries change with the project). */
  onPending?: () => void;
  /** Test seams: store read errors (re-read at each reload), the platform, and the stat / realpath of G2. */
  readError?: ReadErrorInjection;
  platform?: NodeJS.Platform;
  stat?: (p: string) => FileId;
  realpath?: (p: string) => string;
}

/** An rpc path G2 refused: it is in a private area, or its folder could not be checked. */
export class PrivatePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivatePathError";
  }
}

/** A private area: the trust folder (the approval store) or the graphics add-on folder. */
type Area = "trust" | "addons";
/** Why a path may not be used, or ok. */
type PathCheck = { ok: true } | { ok: false; private: true; area: Area; rule?: string } | { ok: false; private: false; code: string; host?: string };
const OK: PathCheck = { ok: true };
const PRIVATE = (area: Area): PathCheck => ({ ok: false, private: true, area });
const IDENTITY = (area: Area): PathCheck => ({ ok: false, private: true, area, rule: "the identity check" });
/** How a message names each private area. */
const AREA_NAME: Record<Area, string> = { trust: `${PRODUCT_NAME}'s private settings folder`, addons: `${PRODUCT_NAME}'s graphics add-on folder` };
/** A path with a ".." segment: never resolved, so a link before the ".." can't lead into the trust folder. */
const DOTDOT: PathCheck = { ok: false, private: false, code: "EDOTDOT" };
/** A path with a NUL character: no file name can hold one, and Node refuses it with a raw error. */
const NUL: PathCheck = { ok: false, private: false, code: "ENUL" };

/**
 * True when `p` has a ".." segment, split on "/" and "\\" on every platform.
 * A segment of ".." followed only by dots or spaces, or by a ":" stream
 * suffix, counts too (Windows may trim those). The kernel follows a link
 * before it applies the ".." after it, but path.resolve removes the ".." as
 * text first, so `<link>/../trust/hosts.key` (or `/proc/<pid>/cwd/../…`,
 * `/proc/self/root/../…`) can't be checked by resolving it: G2 refuses it.
 */
export function hasDotDot(p: string): boolean {
  return p.split(/[\\/]/).some((s) => /^\.\.[. ]*(?::.*)?$/.test(s));
}

/** Store file names (and their temp, .bad-* and break-claim files), refused on any network path. */
const STORE_NAME = /^hosts\.(?:key|json|lock)(?:\..*)?$/;

/** A path as shown in a message: quoted, hidden characters visible, at most 160 characters. */
function show(p: string): string {
  const s = JSON.stringify(p);
  return s.length > 160 ? `${s.slice(0, 157)}…"` : s;
}

function errCode(err: unknown): string {
  return String((err as NodeJS.ErrnoException)?.code ?? "EIO");
}

export class HostTrust {
  /** The trust folder, spelled for this platform. */
  readonly trustDir: string;
  /** The graphics add-on folder, spelled for this platform (D5.4: private like the trust folder; gatedfs stays trust-only). */
  readonly addonsDir: string;
  /** The data folder's own server, trusted implicitly when the data folder is on a share. */
  readonly dataFolderHost?: string;
  private approved = new Map<string, ApprovedHost>();
  private outside: string[] = [];
  private unread: TrustFile[] = [];
  private stale = false;
  private lastRead = 0;
  /** Size, mtime and file id of the two store files at the last read. */
  private sig = "";
  private retry: NodeJS.Timeout | null = null;
  private watcher: ReturnType<typeof watch> | null = null;
  private debounce: NodeJS.Timeout | null = null;
  /** Servers already named in a "would block" / "blocked" line, with the reason. */
  private logged = new Set<string>();
  /** Pending, origin "project": what the open project uses on each server it may not open (G3 sets it). */
  private projectUse = new Map<string, { files: number; examples: string[] }>();
  /** Pending, origin "request": servers rpc calls asked for, with example paths and when. */
  private requests = new Map<string, { examples: string[]; at: number }>();
  /** When each server first became pending (kept while it stays pending). */
  private since = new Map<string, number>();

  constructor(
    readonly dataDir: string,
    private readonly opts: HostTrustOptions = {},
  ) {
    this.trustDir = this.opts.platform === undefined ? trustDir(dataDir) : this.P.join(dataDir, "trust");
    this.addonsDir = this.P.join(dataDir, "addons");
    const c = classifyPath(dataDir);
    if (c.kind === "network") this.dataFolderHost = c.host;
  }

  private get platform(): NodeJS.Platform {
    return this.opts.platform ?? process.platform;
  }

  private get P(): PlatformPath {
    return this.platform === "win32" ? win32 : posix;
  }

  /** Read the store, publish to gatedfs and watch the trust folder. */
  start(): this {
    setTrustDir(this.trustDir);
    this.reload();
    return this;
  }

  /** Stop the watch and the timers. */
  close(): void {
    if (this.retry) clearInterval(this.retry);
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.retry = this.debounce = this.watcher = null;
  }

  /** Re-read the store (stamps checked) and publish the approved servers. */
  reload(): void {
    const before = this.state();
    const r = readTrustedHosts(this.dataDir, { readError: this.opts.readError });
    this.approved = new Map(r.approved.map((a) => [a.host, a]));
    this.outside = r.outside.map((o) => o.host);
    this.unread = r.unread;
    this.stale = r.stale;
    this.lastRead = Date.now();
    this.sig = this.signature();
    setAllowedNetworkHosts(this.dataFolderHost ? [...this.approved.keys(), this.dataFolderHost] : this.approved.keys());
    if (this.unread.length > 0 && !this.retry) {
      this.retry = setInterval(() => this.reload(), 1_000);
      this.retry.unref();
    } else if (this.unread.length === 0 && this.retry) {
      clearInterval(this.retry);
      this.retry = null;
    }
    this.watchStore();
    if (this.state() !== before) this.opts.onChange?.();
  }

  private state(): string {
    return JSON.stringify([[...this.approved.keys()], this.outside, this.unread]);
  }

  private signature(): string {
    return ["hosts.json", "hosts.key"]
      .map((f) => {
        try {
          // bigint: a 64-bit file id (Windows, SMB) or a nanosecond mtime loses nothing.
          const s = statSync(this.P.join(this.trustDir, f), { bigint: true });
          return `${s.size}:${s.mtimeNs}:${s.ino}`;
        } catch (err) {
          return errCode(err);
        }
      })
      .join("|");
  }

  /** Watch the trust folder once it exists (a reload tries again until then); not for a simulated platform (tests). */
  private watchStore(): void {
    if (this.watcher || this.opts.platform !== undefined) return;
    try {
      this.watcher = watch(this.trustDir, (_event, name) => {
        if (name && !/^hosts\.(?:json|key)$/.test(String(name))) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          this.debounce = null;
          this.reload();
        }, 200);
        this.debounce.unref();
      });
      this.watcher.unref();
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null; // no trust/ yet
    }
  }

  private trusts(host: string): boolean {
    return host === this.dataFolderHost || this.approved.has(host);
  }

  /**
   * Whether the user approved `host` (a valid stamp, or the data folder's
   * server). A miss re-reads the store when it changed on disk; a stale or
   * unread store is re-read at most once a second.
   */
  isApproved(host: string): boolean {
    if ((this.stale || this.unread.length > 0) && Date.now() - this.lastRead >= 1_000) this.reload();
    if (this.trusts(host)) return true;
    if (this.signature() !== this.sig) this.reload();
    return this.trusts(host);
  }

  /**
   * {@link isApproved}, through the network gate's mode: a server that is not
   * approved is logged once ("would block" / "blocked", with the reason) and
   * refused only when the gate is enforced.
   */
  isAllowed(host: string): boolean {
    if (this.isApproved(host)) return true;
    const enforced = networkGateEnforced();
    const why =
      this.unread.length > 0
        ? ": couldn't read the list of approved computers"
        : this.outside.includes(host)
          ? ` (added outside ${PRODUCT_NAME})`
          : `: a network computer not allowed in ${PRODUCT_NAME}`;
    const line = `${enforced ? "blocked" : "would block"} \\\\${host}${why}`;
    if (!this.logged.has(line)) {
      this.logged.add(line);
      console.error(`[aive-core] ${line}`);
    }
    return !enforced;
  }

  /** The store as list_media_servers shows it (no stamp, no key). */
  list(): {
    approved: (ApprovedHost & { display: string })[];
    outside: { host: string; display: string }[];
    unread: TrustFile[];
    stale: boolean;
    dataFolderHost?: string;
  } {
    return {
      approved: [...this.approved.values()].map((a) => ({ ...a, display: `\\\\${a.host}` })),
      outside: this.outside.map((host) => ({ host, display: `\\\\${host}` })),
      unread: [...this.unread],
      stale: this.stale,
      ...(this.dataFolderHost ? { dataFolderHost: this.dataFolderHost } : {}),
    };
  }

  // ---- the pending list and G1 ----------------------------------------------------

  /** Whether the store could not be read and there is no good copy yet (3.1 "Unread state"). */
  isUnread(): boolean {
    return this.unread.length > 0;
  }

  /** Whether `host` is in the store but was added outside ZabsReel. */
  isOutside(host: string): boolean {
    return this.outside.includes(host);
  }

  /** G3: the servers the open project uses but may not open, with its file count and examples (origin "project"). */
  setProjectUse(use: Map<string, { files: number; examples: string[] }>): void {
    this.projectUse = use;
  }

  /** Forget the rpc requests (a new project was loaded, imported or started). */
  clearRequests(): void {
    if (this.requests.size === 0) return;
    this.requests.clear();
    this.opts.onPending?.();
  }

  /**
   * The pending list (enforce mode only: in log mode nothing is blocked, so
   * nothing waits). A request lasts until its server is approved, the next
   * load, or 30 minutes; an outside entry lasts until it is kept or removed.
   */
  pending(): PendingServer[] {
    if (!networkGateEnforced()) return [];
    const now = Date.now();
    for (const [host, r] of this.requests) if (now - r.at > REQUEST_TTL_MS || this.trusts(host)) this.requests.delete(host);
    const hosts = new Set([...this.projectUse.keys(), ...this.requests.keys(), ...this.outside]);
    const out: PendingServer[] = [];
    for (const host of hosts) {
      if (this.trusts(host)) continue;
      const origins: PendingOrigin[] = [];
      if (this.projectUse.has(host)) origins.push("project");
      if (this.requests.has(host)) origins.push("request");
      if (this.outside.includes(host)) origins.push("outside");
      const use = this.projectUse.get(host);
      const examples = [...new Set([...(use?.examples ?? []), ...(this.requests.get(host)?.examples ?? [])])].slice(0, 3);
      if (!this.since.has(host)) this.since.set(host, now);
      out.push({ host, display: `\\\\${host}`, origins, files: use?.files ?? 0, examples, since: new Date(this.since.get(host)!).toISOString() });
    }
    for (const host of this.since.keys()) if (!hosts.has(host) || this.trusts(host)) this.since.delete(host);
    return out;
  }

  /** list_media_servers (and mediaServers in the state): no stamp and no key in any field. */
  mediaServers(): MediaServers {
    const l = this.list();
    return {
      gate: networkGateEnforced() ? "enforce" : "log",
      approved: l.approved.map(({ host, display, via, added }) => ({ host, display, via, added })),
      outside: l.outside,
      unread: l.unread,
      pending: this.pending(),
      ...(l.dataFolderHost ? { dataFolderHost: l.dataFolderHost } : {}),
    };
  }

  /**
   * G1, at the top of every engine method that takes an rpc path (read or
   * write): a network path on a server the user has not allowed is refused
   * with MediaServerNotApprovedError, before anything opens it, and the server
   * becomes pending with origin "request" (not while the store is unread: the
   * server may be approved). Log mode only logs. `field` names the parameter.
   */
  requirePath(p: unknown, field: string): void {
    if (typeof p !== "string" || p === "") return;
    const { text, c } = classifyFsText(p, { platform: this.platform });
    if (c.kind !== "network" || this.isAllowed(c.host)) return;
    const { host, display } = c;
    if (this.isUnread()) {
      throw new MediaServerNotApprovedError(
        `${PRODUCT_NAME} couldn't read its list of approved computers; retrying. It did not open ${show(examplePath(text))}. Try again in a few seconds.`,
        host, display, text, false, true,
      );
    }
    const r = this.requests.get(host) ?? { examples: [], at: 0 };
    const ex = examplePath(text);
    this.requests.set(host, { examples: [...new Set([...r.examples, ex])].slice(-3), at: Date.now() });
    this.opts.onPending?.();
    if (this.isOutside(host)) {
      throw new MediaServerNotApprovedError(
        `${field} ${show(text)} is on ${display}. ${display} was added to ${PRODUCT_NAME}'s allowed list outside ${PRODUCT_NAME}, so it is not used until the user keeps it in the ${PRODUCT_NAME} window. You cannot keep it yourself, and editing ${PRODUCT_NAME}'s files does not allow it. Nothing was opened.`,
        host, display, text, true,
      );
    }
    throw new MediaServerNotApprovedError(
      `${field} ${show(text)} is on the network computer ${display}, which the user has not allowed in ${PRODUCT_NAME} yet. Nothing was opened. You cannot allow it yourself: tell the user what it is for; they can allow it in the ${PRODUCT_NAME} window (Project → Network computers).`,
      host, display, text,
    );
  }

  /** G1 for remember_projects: why `p` is skipped (a server not allowed, then G2), or null. Never throws. */
  rememberRefusal(p: string): string | null {
    try {
      this.requirePath(p, "path");
    } catch (err) {
      if (!(err instanceof MediaServerNotApprovedError)) throw err;
      return err.unread
        ? `${PRODUCT_NAME} couldn't read its list of approved computers; try again`
        : err.outside
          ? `on ${err.display}, which was added outside ${PRODUCT_NAME} and is not used until the user keeps it`
          : `on a network computer you haven't allowed (${err.display})`;
    }
    return this.pathRefusal(p);
  }

  // ---- the private areas (G2) ------------------------------------------------------

  /** Each private area and its folder. */
  private get areas(): [Area, string][] {
    return [["trust", this.trustDir], ["addons", this.addonsDir]];
  }

  /** The quick form: the private area `p` is in (`folders`: the areas' folders, default as spelled), or null. */
  private quick(p: string, folders: [Area, string][] = this.areas): Area | null {
    for (const [area, dir] of folders) {
      if (isTrustPath(p, { platform: this.platform, realpath: this.opts.realpath, trustDir: dir })) return area;
    }
    return null;
  }

  /**
   * The name rule: a network path whose last segment (without a `:` stream
   * suffix or trailing dots and spaces, any case) is a store file. It covers a
   * server that gives no file id, and another name of the data folder's
   * server, where the identity check does not run.
   */
  private storeName(p: string): boolean {
    const last = p.split(/[\\/]/).filter((s) => s !== "").pop() ?? "";
    return STORE_NAME.test(last.replace(/:.*$/, "").replace(/[. ]+$/, "").toLowerCase());
  }

  /** Quick form and name rule, no I/O: the first step of a loaded field's check. */
  private privateAsSpelled(p: string): boolean {
    const c = classifyPath(p);
    if (c.kind === "refused") return false;
    return this.quick(p) !== null || (c.kind === "network" && this.storeName(p));
  }

  /**
   * `p` resolved with realpath at its nearest existing ancestor; throws the
   * error code when a level can't be checked. Only for a path without a ".."
   * segment ({@link hasDotDot}): path.resolve would remove a ".." as text,
   * before the link ahead of it is followed. A level that realpath can't find
   * but that exists is a link whose target does not exist yet; a write
   * through it would create that target, wherever it is, so it throws
   * "EDANGLING" (not with a test realpath: the seam stands for the whole file system).
   */
  private realResolve(p: string): string {
    const P = this.P;
    const realpath = this.opts.realpath ?? realpathNative;
    const rest: string[] = [];
    for (let cur = P.resolve(p); ; ) {
      try {
        return P.join(realpath(cur), ...rest);
      } catch (err) {
        const code = errCode(err);
        if (code !== "ENOENT" && code !== "ENOTDIR") throw code;
        if (code === "ENOENT" && !this.opts.realpath && this.isLink(cur)) throw "EDANGLING";
        const parent = P.dirname(cur);
        if (parent === cur) return P.resolve(p);
        rest.unshift(P.basename(cur));
        cur = parent;
      }
    }
  }

  private isLink(p: string): boolean {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  }

  /**
   * G2's real-path form for a local path without a ".." segment: `p` and each
   * private area's folder resolved with {@link realResolve}, then compared
   * with the quick form, so a link, `/proc/self/root/…` or `/proc/<pid>/cwd/…`
   * that leads into a private area is caught. On Linux the same letters in
   * another case are that folder on a case-insensitive mount (drvfs, ext4
   * casefold) when the level has the folder's file id, or when neither exists
   * yet (a write would create it). One realpath per path and per area.
   */
  private realCheck(p: string, cache: Map<string, FileId | null>): PathCheck {
    try {
      const real = this.realResolve(p);
      const folders = this.areas.map(([area, dir]): [Area, string] => [area, this.realResolve(dir)]);
      const found = this.quick(real, folders);
      if (found) return PRIVATE(found);
      if (this.platform === "win32" || this.platform === "darwin") return OK; // the quick form folds case there
      const lower = real.toLowerCase();
      for (const [area, dir] of folders) {
        const folder = dir.toLowerCase();
        if (lower !== folder && !lower.startsWith(folder.endsWith("/") ? folder : `${folder}/`)) continue;
        const level = real.split("/").slice(0, dir.split("/").length).join("/");
        const a = this.idOf(level, cache);
        const b = this.idOf(dir, cache);
        if (a && b ? a.ino === 0n || (a.dev === b.dev && a.ino === b.ino) : !a && !b) return PRIVATE(area);
      }
      return OK;
    } catch (code) {
      return { ok: false, private: false, code: String(code) };
    }
  }

  /** The identity of `p`, null when it does not exist; throws the error code when it can't be stat'ed. */
  private idOf(p: string, cache: Map<string, FileId | null>): FileId | null {
    if (cache.has(p)) return cache.get(p)!;
    let id: FileId | null;
    try {
      const s = this.opts.stat ? this.opts.stat(p) : statSync(p, { bigint: true });
      id = { dev: s.dev, ino: s.ino };
    } catch (err) {
      const code = errCode(err);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw code;
      id = null;
    }
    cache.set(p, id);
    return id;
  }

  /**
   * The identity check, for a path on the data folder's own server: the path
   * and each folder above it up to the share root are stat'ed. A level that is
   * a private area's folder means the path is in it; a level that is the data
   * folder means the rest below it is judged by the quick form as if under
   * `<dataDir>`, so `\\nas\d$\zr\trust\…` is caught as well as `\\nas\zr\trust\…`.
   * A level that can't be stat'ed (other than "not found") fails closed.
   */
  private identity(p: string, host: string, cache: Map<string, FileId | null>): PathCheck {
    const P = this.P;
    const same = (a: FileId | null, b: FileId | null) => !!a && !!b && a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
    try {
      const data = this.idOf(this.dataDir, cache);
      const folders = this.areas.map(([area, dir]) => [area, this.idOf(dir, cache)] as const);
      const target = P.resolve(p);
      for (let level = target; ; level = P.dirname(level)) {
        const id = this.idOf(level, cache);
        const inside = folders.find(([, folder]) => same(id, folder));
        if (inside) return IDENTITY(inside[0]);
        if (same(id, data)) {
          const area = this.quick(P.join(this.dataDir, P.relative(level, target)));
          return area ? IDENTITY(area) : OK;
        }
        if (P.dirname(level) === level) return OK;
      }
    } catch (code) {
      return { ok: false, private: false, code: String(code), host };
    }
  }

  /**
   * G2 for an rpc path, read or write. First the quick form (no I/O). Then a
   * path with a ".." segment is refused (code EDOTDOT) before anything
   * resolves it: the caller passes the full path instead. Local: the
   * real-path form ({@link realCheck}: links, 8.3 names, trailing dots and
   * case on Windows). Network: the name rule, plus the identity check on the
   * data folder's own server; no other server is contacted. A refused form
   * passes (safepath's assertPathUsable refuses it with its own message).
   */
  checkPath(p: string, cache = new Map<string, FileId | null>()): PathCheck {
    if (p.includes("\0")) return NUL;
    const { text, c } = classifyFsText(p, { platform: this.platform });
    if (c.kind === "refused") return OK;
    const area = this.quick(text);
    if (area) return PRIVATE(area);
    if (hasDotDot(p) || hasDotDot(text)) return DOTDOT;
    if (c.kind === "network") {
      // The store's file names: the trust folder only.
      if (this.storeName(text)) return { ok: false, private: true, area: "trust", rule: "the name rule" };
      return c.host === this.dataFolderHost ? this.identity(text, c.host, cache) : OK;
    }
    return this.realCheck(text, cache);
  }

  /** Why rpc path `p` may not be used, as a reason for a skipped entry (remember_projects), or null. */
  pathRefusal(p: string): string | null {
    const r = this.checkPath(p);
    if (r.ok) return null;
    if (r.private) return `in ${AREA_NAME[r.area]}`;
    if (r.code === "EDOTDOT") return `it has a ".." segment, which ${PRODUCT_NAME} doesn't follow; pass the full path without ".."`;
    if (r.code === "EDANGLING") return `it goes through a link whose target does not exist; pass the path of the real file`;
    if (r.code === "ENUL") return "it contains a NUL character, which no file name can hold";
    return `${PRODUCT_NAME} couldn't check this path${r.host ? ` on \\\\${r.host}` : ""} (${r.code}); try again`;
  }

  /** G2: throw PrivatePathError when rpc path `p` (`field` names it) is in a private area, has a ".." segment, or can't be checked. */
  assertNotPrivate(p: unknown, field: string): void {
    if (typeof p !== "string" || p === "") return;
    const r = this.checkPath(p);
    if (r.ok) return;
    // Which rule caught a network spelling (a server that gives no file ids still has the name rule).
    if (r.private && r.rule) console.error(`[aive-core] refused ${show(p)}: in the private ${r.area === "trust" ? "trust" : "graphics add-on"} folder (${r.rule})`);
    if (r.private) throw new PrivatePathError(`${field} ${show(p)} is in ${AREA_NAME[r.area]}, which tools can't open.`);
    if (r.code === "EDOTDOT") {
      throw new PrivatePathError(`${field} ${show(p)} has a ".." segment. ${PRODUCT_NAME} doesn't follow ".." in a path (a linked folder can make it lead somewhere else), so nothing was opened. Pass the full path without "..".`);
    }
    if (r.code === "EDANGLING") {
      throw new PrivatePathError(`${field} ${show(p)} goes through a link whose target does not exist, so ${PRODUCT_NAME} can't tell where it leads; nothing was opened. Pass the path of the real file or folder.`);
    }
    if (r.code === "ENUL") throw new PrivatePathError(`${field} ${show(p)} contains a NUL character, which no file name can hold, so nothing was opened.`);
    throw new PrivatePathError(`${field} ${show(p)}: ${PRODUCT_NAME} couldn't check this path${r.host ? ` on \\\\${r.host}` : ""} (${r.code}); try again.`);
  }

  /**
   * One loaded field: "ok", "private" (in a private area, by the quick
   * form, the real-path form, the name rule or the identity check),
   * "EDOTDOT" (a ".." segment, never resolved), or the error code of a
   * folder that could not be checked. A local field gets the real-path form
   * ({@link realCheck}, one realpath); a field on the data folder's own
   * server the identity check; another server's field is not contacted.
   * `cache` keeps the stats of one load.
   */
  loadFieldCheck(p: unknown, cache = new Map<string, FileId | null>()): string {
    if (typeof p !== "string" || p === "") return "ok";
    if (p.includes("\0")) return "ENUL";
    if (this.privateAsSpelled(p)) return "private";
    const c = classifyPath(p);
    if (c.kind === "refused") return "ok";
    if (hasDotDot(p)) return "EDOTDOT";
    if (c.kind === "network" && c.host !== this.dataFolderHost) return "ok";
    const r = c.kind === "network" ? this.identity(p, c.host, cache) : this.realCheck(p, cache);
    return r.ok ? "ok" : r.private ? "private" : r.code;
  }

  /**
   * The load-field check (P16): a project whose asset path, cutout colour
   * path, LUT or text or caption font is in a private area does not load; a
   * proxy or preview path there is dropped. For an .otio import (`otio`), an
   * asset path there stays an offline placeholder (its import already
   * skipped the probe), flagged "private". A field with a ".." segment
   * (EDOTDOT), or whose folder can't be checked, is never opened, and only
   * it goes offline: an asset gets `pathCheckFailed` (the code), a proxy or
   * preview path is dropped, and a LUT or font is returned (path → code) for
   * the engine's uncheckedPaths. An incoming `pathCheckFailed` is dropped
   * first. Mutates `project`.
   */
  checkLoadedProject(project: Project, opts: { otio?: boolean } = {}): Map<string, string> {
    const refuse = (field: string, p: string) => {
      const r = this.checkPath(p);
      const where = AREA_NAME[!r.ok && r.private ? r.area : "trust"];
      throw new PrivatePathError(`${field} ${show(p)} is in ${where}, which tools can't open. Change this path in the project file and open the project again.`);
    };
    const cache = new Map<string, FileId | null>();
    const unchecked = new Map<string, string>();
    const check = (p: unknown) => this.loadFieldCheck(p, cache);
    for (const a of project.assets ?? []) {
      delete a.pathCheckFailed;
      const path = check(a.path);
      if (path === "private" && !(opts.otio && a.missing)) refuse(`asset "${a.id}" path`, a.path);
      if (path !== "ok") a.pathCheckFailed = path;
      const color = check(a.cutout?.colorPath);
      if (color === "private") refuse(`asset "${a.id}" cutout colour path`, a.cutout!.colorPath);
      if (color !== "ok") a.pathCheckFailed ??= color;
      if (check(a.proxyPath) !== "ok") delete a.proxyPath;
      if (check(a.previewPath) !== "ok") delete a.previewPath;
    }
    const other = (field: string, p: string | undefined) => {
      const r = check(p);
      if (r === "private") refuse(field, p!);
      if (r !== "ok") unchecked.set(p!, r);
    };
    for (const t of project.tracks ?? []) {
      for (const c of t.clips ?? []) {
        other(`clip "${c.id}" LUT path`, c.effects?.lut);
        // Fonts are trimmed where they are used (resolveFont), so check them trimmed.
        for (const ov of c.overlays ?? []) other(`clip "${c.id}" text "${ov.id}" font`, ov.font?.trim());
        other(`clip "${c.id}" caption font`, c.captions?.style?.font?.trim());
      }
    }
    return unchecked;
  }
}
