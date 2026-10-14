/**
 * The core's side of the approval store (trusthosts.ts): which network
 * computers it may open files on, and the guard that keeps every rpc read or
 * write out of the private trust folder (G2).
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
 * While io/gatedfs.ts NETWORK_GATE is "log", {@link HostTrust.isAllowed} only
 * logs what it would block. G2 and the load-field check are always enforced.
 */
import { posix, win32, type PlatformPath } from "node:path";
import { PRODUCT_NAME } from "./brand.js";
import { classifyPath } from "./unc.js";
import { readTrustedHosts, trustDir, type ApprovedHost, type ReadErrorInjection, type TrustFile } from "./trusthosts.js";
import {
  classifyFsText,
  isTrustPath,
  networkGateEnforced,
  realpathNative,
  setAllowedNetworkHosts,
  setTrustDir,
  statSync,
  watch,
  type TrustPathContext,
} from "./io/gatedfs.js";
import type { Project } from "./types.js";

/** A file's identity: equal dev and ino are one file, under any spelling of its path (ino 0 means unknown). */
interface FileId {
  dev: bigint;
  ino: bigint;
}

export interface HostTrustOptions {
  /** Called after a re-read changed what is approved, outside or unread. */
  onChange?: () => void;
  /** Test seams: store read errors (re-read at each reload), the platform, and the stat / realpath of G2. */
  readError?: ReadErrorInjection;
  platform?: NodeJS.Platform;
  stat?: (p: string) => FileId;
  realpath?: (p: string) => string;
}

/** An rpc path G2 refused: it is in the private trust folder, or its folder could not be checked. */
export class PrivatePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivatePathError";
  }
}

/** Why a path may not be used, or ok. */
type PathCheck = { ok: true } | { ok: false; private: true } | { ok: false; private: false; code: string; host?: string };
const OK: PathCheck = { ok: true };
const PRIVATE: PathCheck = { ok: false, private: true };

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

  constructor(
    readonly dataDir: string,
    private readonly opts: HostTrustOptions = {},
  ) {
    this.trustDir = this.opts.platform === undefined ? trustDir(dataDir) : this.P.join(dataDir, "trust");
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
          const s = statSync(this.P.join(this.trustDir, f));
          return `${s.size}:${s.mtimeMs}:${s.ino}`;
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

  // ---- the private trust folder (G2) ------------------------------------------------

  private quick(p: string, ctx: TrustPathContext = {}): boolean {
    return isTrustPath(p, { platform: this.platform, realpath: this.opts.realpath, trustDir: this.trustDir, ...ctx });
  }

  /** True when `p` is the trust folder or in it, as spelled (G2's quick form: G6 and the load fields). */
  inTrustDir(p: string): boolean {
    return this.quick(p);
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

  /** Quick form and name rule, no I/O: what a loaded project's fields are checked with. */
  private privateAsSpelled(p: string): boolean {
    const c = classifyPath(p);
    if (c.kind === "refused") return false;
    return this.quick(p) || (c.kind === "network" && this.storeName(p));
  }

  /** `p` resolved with realpath at its nearest existing ancestor; throws the error code when a level can't be checked. */
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
        const parent = P.dirname(cur);
        if (parent === cur) return P.resolve(p);
        rest.unshift(P.basename(cur));
        cur = parent;
      }
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
   * the trust folder means the path is in it; a level that is the data folder
   * means the rest below it is judged by the quick form as if under
   * `<dataDir>`, so `\\nas\d$\zr\trust\…` is caught as well as `\\nas\zr\trust\…`.
   * A level that can't be stat'ed (other than "not found") fails closed.
   */
  private identity(p: string, host: string, cache: Map<string, FileId | null>): PathCheck {
    const P = this.P;
    const same = (a: FileId | null, b: FileId | null) => !!a && !!b && a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
    try {
      const data = this.idOf(this.dataDir, cache);
      const trust = this.idOf(this.trustDir, cache);
      const target = P.resolve(p);
      for (let level = target; ; level = P.dirname(level)) {
        const id = this.idOf(level, cache);
        if (same(id, trust)) return PRIVATE;
        if (same(id, data)) return this.quick(P.join(this.dataDir, P.relative(level, target))) ? PRIVATE : OK;
        if (P.dirname(level) === level) return OK;
      }
    } catch (code) {
      return { ok: false, private: false, code: String(code), host };
    }
  }

  /**
   * G2 for an rpc path, read or write. Local: the quick form, then the same on
   * real paths (the nearest existing ancestor through realpath, which folds
   * links, 8.3 names, trailing dots and case on Windows). Network: the quick
   * form and the name rule, plus the identity check on the data folder's own
   * server; no other server is contacted. A refused form passes (safepath's
   * assertPathUsable refuses it with its own message).
   */
  checkPath(p: string, cache = new Map<string, FileId | null>()): PathCheck {
    const { text, c } = classifyFsText(p, { platform: this.platform });
    if (c.kind === "refused") return OK;
    if (this.quick(text)) return PRIVATE;
    if (c.kind === "network") {
      if (this.storeName(text)) return PRIVATE;
      return c.host === this.dataFolderHost ? this.identity(text, c.host, cache) : OK;
    }
    try {
      return this.quick(this.realResolve(text), { trustDir: this.realResolve(this.trustDir) }) ? PRIVATE : OK;
    } catch (code) {
      return { ok: false, private: false, code: String(code) };
    }
  }

  /** Why rpc path `p` may not be used, as a reason for a skipped entry (remember_projects), or null. */
  pathRefusal(p: string): string | null {
    const r = this.checkPath(p);
    if (r.ok) return null;
    if (r.private) return `in ${PRODUCT_NAME}'s private settings folder`;
    return `${PRODUCT_NAME} couldn't check this path${r.host ? ` on \\\\${r.host}` : ""} (${r.code}); try again`;
  }

  /** G2: throw PrivatePathError when rpc path `p` (`field` names it) is in the trust folder or can't be checked. */
  assertNotPrivate(p: unknown, field: string): void {
    if (typeof p !== "string" || p === "") return;
    const r = this.checkPath(p);
    if (r.ok) return;
    if (r.private) throw new PrivatePathError(`${field} ${show(p)} is in ${PRODUCT_NAME}'s private settings folder, which tools can't open.`);
    throw new PrivatePathError(`${field} ${show(p)}: ${PRODUCT_NAME} couldn't check this path${r.host ? ` on \\\\${r.host}` : ""} (${r.code}); try again.`);
  }

  /**
   * The load-field check (P16), quick form and name rule: a project whose
   * asset path, cutout colour path, LUT or text or caption font is in the
   * trust folder does not load; a proxy or preview path there is dropped. For
   * an .otio import (`otio`), an asset path there stays an offline placeholder
   * (its import already skipped the probe). Mutates `project`. The identity
   * check of a field on the data folder's server (pathCheckFailed,
   * uncheckedPaths) comes with the offline state.
   */
  checkLoadedProject(project: Project, opts: { otio?: boolean } = {}): void {
    const refuse = (field: string, p: string) => {
      throw new PrivatePathError(`${field} ${show(p)} is in ${PRODUCT_NAME}'s private settings folder, which tools can't open. Change this path in the project file and open the project again.`);
    };
    const priv = (p: unknown): p is string => typeof p === "string" && this.privateAsSpelled(p);
    for (const a of project.assets ?? []) {
      if (priv(a.path) && !(opts.otio && a.missing)) refuse(`asset "${a.id}" path`, a.path);
      if (priv(a.cutout?.colorPath)) refuse(`asset "${a.id}" cutout colour path`, a.cutout.colorPath);
      if (priv(a.proxyPath)) delete a.proxyPath;
      if (priv(a.previewPath)) delete a.previewPath;
    }
    for (const t of project.tracks ?? []) {
      for (const c of t.clips ?? []) {
        if (priv(c.effects?.lut)) refuse(`clip "${c.id}" LUT path`, c.effects.lut);
        // Fonts are trimmed where they are used (resolveFont), so check them trimmed.
        for (const ov of c.overlays ?? []) {
          const f = ov.font?.trim();
          if (priv(f)) refuse(`clip "${c.id}" text "${ov.id}" font`, f);
        }
        const cf = c.captions?.style?.font?.trim();
        if (priv(cf)) refuse(`clip "${c.id}" caption font`, cf);
      }
    }
  }

  /** True when an .otio media path must not be probed: it is in the trust folder (quick form or name rule). */
  isPrivateMediaPath(p: string): boolean {
    return this.privateAsSpelled(p);
  }
}
