/**
 * The core's only door to the file system (G8). Every `fs` / `fs/promises`
 * function the core uses is re-exported here, wrapped so that each path
 * argument passes {@link assertReachable} before the real function runs.
 * scripts/check-io-imports.mjs fails the build when any other core module
 * imports `node:fs`, `node:fs/promises`, `node:child_process` or execa
 * (child processes go through ffmpeg/executor.ts, which checks every argv
 * string with the same gate, G7).
 *
 * Why: on Windows, opening `\\server\share\…` (even a `stat`) signs in to that
 * server and sends it an NTLM response. unc.ts recognizes such a path and keys
 * its server; this module refuses to open one whose server is not allowed.
 *
 *  - A Windows device / NT path and a server name with no key (unc.ts
 *    refuses them) are always refused.
 *  - A network path whose server is not in {@link setAllowedNetworkHosts}:
 *    while {@link NETWORK_GATE} is "log", one line per server says what would
 *    be blocked and the call goes on; when enforced, the call is refused.
 *  - A call that reads or changes content (not stat, lstat, readdir, access,
 *    existsSync, realpath, watch) refuses a path in the private trust folder
 *    ({@link setTrustDir}, {@link isTrustPath}) in every mode: only
 *    trusthosts.ts opens the files there.
 *
 * The real function is looked up on the `node:fs` module at each call (not
 * captured at load), so a test that replaces it sees every call.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { posix, win32 } from "node:path";
import { PRODUCT_NAME } from "../brand.js";
import { classifyPath, type PathClass } from "../unc.js";

/**
 * "enforce": a path on a server the user has not allowed is refused. ("log",
 * which only logged what it would block, carried the rollout until the user
 * could allow a server in both UI hosts.)
 */
export const NETWORK_GATE = "enforce" as "log" | "enforce";
const ENFORCED = NETWORK_GATE === "enforce";

/** True when a path on a server that is not allowed is refused (not only logged). */
export function networkGateEnforced(): boolean {
  return ENFORCED;
}

/** Host keys (unc.ts) the core may open paths on. */
let allowed: ReadonlySet<string> = new Set();
/** False until the first {@link setAllowedNetworkHosts}: {@link bootstrap} allows a path on any server until then. */
let hostsSet = false;
/** Servers already named in a log line. */
const logged = new Set<string>();

/** Replace the set of servers (host keys from unc.ts) whose paths may be opened. */
export function setAllowedNetworkHosts(keys: Iterable<string>): void {
  allowed = new Set(keys);
  hostsSet = true;
}

/** The servers {@link setAllowedNetworkHosts} last allowed. */
export function allowedNetworkHosts(): ReadonlySet<string> {
  return allowed;
}

/** `<dataDir>/trust` once {@link setTrustDir} named it; until then nothing is refused for being in it. */
let trustFolder: string | null = null;

/** The private trust folder (hosttrust.ts sets it): content calls refuse every path in it. */
export function setTrustDir(dir: string): void {
  trustFolder = dir;
}

/** A path the gate refused to open. */
export class BlockedPathError extends Error {
  readonly code = "ERR_PATH_BLOCKED";
  constructor(
    message: string,
    readonly path: string,
    /** The server's key, for a network path that is not allowed. */
    readonly host?: string,
  ) {
    super(message);
    this.name = "BlockedPathError";
  }
}

/** Short, log-safe rendering of a path, with hidden characters shown. */
function show(p: string): string {
  const s = JSON.stringify(p);
  return s.length > 160 ? `${s.slice(0, 157)}…"` : s;
}

/**
 * Where a relative path resolves (plan rule R5): the platform (default
 * `process.platform`) and the folder (default `process.cwd()`). Tests pass
 * both to check the Windows rule on any host.
 */
export interface PathContext {
  platform?: NodeJS.Platform;
  cwd?: string;
}

/** A full drive-letter path (`C:\…`, `c:/…`): it never depends on the cwd. */
const WIN_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * {@link classifyPath} with rule R5: on Windows, a path that classifies as
 * local but depends on the cwd (`v.txt`, `\v.txt`, `C:v.txt`) is classified
 * again as `path.win32.resolve` gives it, so a core whose cwd is on a share
 * opens nothing there unchecked. It only adds blocking: the result is the
 * resolved path's class (local, or stricter) with that path as `text`.
 */
export function classifyFsText(text: string, ctx: PathContext = {}): { text: string; c: PathClass } {
  const c = classifyPath(text);
  if (c.kind !== "local" || (ctx.platform ?? process.platform) !== "win32" || WIN_DRIVE_ABSOLUTE.test(text)) return { text, c };
  let resolved: string;
  try {
    resolved = ctx.cwd === undefined ? win32.resolve(text) : win32.resolve(ctx.cwd, text);
  } catch {
    return { text, c }; // no cwd to resolve against (it was removed): the real call can't use one either
  }
  const r = classifyPath(resolved);
  return r.kind === "local" ? { text, c } : { text: resolved, c: r };
}

/**
 * The path an fs argument names, as text, and its class: a string, a Buffer
 * (any Uint8Array), or a `file:` URL (a host makes it `//host/path`, as
 * Windows opens it). Null for anything else (a file descriptor, a FileHandle).
 * A string or Buffer goes through {@link classifyFsText} (R5) with `ctx`.
 */
export function fsArgPath(p: unknown, ctx: PathContext = {}): { text: string; c: PathClass } | null {
  let text: string;
  if (typeof p === "string") return classifyFsText(p, ctx);
  if (p instanceof Uint8Array) return classifyFsText(Buffer.from(p).toString("utf8"), ctx);
  if (p instanceof URL) {
    if (p.protocol !== "file:") return null; // fs refuses any other URL itself
    if (p.hostname !== "") text = `//${p.hostname}${p.pathname}`;
    else {
      try {
        text = decodeURIComponent(p.pathname);
      } catch {
        return { text: p.href, c: { kind: "refused", form: "host", host: "", reason: "The file URL can't be decoded." } };
      }
    }
  } else return null;
  return { text, c: classifyPath(text) };
}

/**
 * Where a path resolves for {@link isTrustPath}: the platform and cwd of
 * {@link PathContext}, the `realpath` the Windows 8.3 rule uses (default
 * `fs.realpathSync.native`) and the trust folder (default the one
 * {@link setTrustDir} named). The overrides are for hosttrust.ts and tests.
 */
export interface TrustPathContext extends PathContext {
  realpath?: (p: string) => string;
  trustDir?: string;
}

/**
 * The form two paths are compared in by {@link isTrustPath}: resolved
 * (`.`, `..` and mixed separators collapsed); on Windows, each segment after
 * the root without an NTFS stream suffix (`hosts.key::$DATA`) or trailing
 * dots and spaces, case-folded, and a path with a `~` segment (maybe an 8.3
 * short name, `ZABSRE~1`) first resolved with realpath at its nearest
 * existing ancestor (local paths only: a server is never contacted here);
 * on macOS case-folded in NFC.
 */
function trustForm(text: string, ctx: TrustPathContext): string {
  const platform = ctx.platform ?? process.platform;
  const P = platform === "win32" ? win32 : posix;
  let r = ctx.cwd === undefined ? P.resolve(text) : P.resolve(ctx.cwd, text);
  if (platform === "darwin") return r.normalize("NFC").toLowerCase();
  if (platform !== "win32") return r;
  if (/~/.test(r) && classifyPath(r).kind === "local") r = realAncestor(r, ctx.realpath ?? fs.realpathSync.native);
  const root = win32.parse(r).root;
  const segments = r
    .slice(root.length)
    .split(/[\\/]/)
    .map((s) => s.replace(/:.*$/, "").replace(/[. ]+$/, ""))
    .filter((s) => s !== "");
  return (root + segments.join("\\")).toLowerCase();
}

/** `p` (a resolved Windows path) with its nearest existing ancestor replaced by that ancestor's real path. */
function realAncestor(p: string, realpath: (p: string) => string): string {
  const rest: string[] = [];
  for (let cur = p; ; ) {
    try {
      return win32.join(realpath(cur), ...rest);
    } catch {
      const parent = win32.dirname(cur);
      if (parent === cur) return p;
      rest.unshift(win32.basename(cur));
      cur = parent;
    }
  }
}

/**
 * True when an fs argument (string, Buffer or `file:` URL) names the private
 * trust folder or a path in it (G2's quick form). Lexical apart from the 8.3
 * rule: a link that already points there is not followed (the rpc check in
 * hosttrust.ts resolves real paths).
 */
export function isTrustPath(p: unknown, ctx: TrustPathContext = {}): boolean {
  const dir = ctx.trustDir ?? trustFolder;
  const a = dir === null ? null : fsArgPath(p, ctx);
  if (dir === null || !a) return false;
  const sep = (ctx.platform ?? process.platform) === "win32" ? "\\" : "/";
  const target = trustForm(a.text, ctx);
  const folder = trustForm(dir, ctx);
  return target === folder || target.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

/** The refusal for a content call (`what`) on a path in the trust folder, or null. */
function inTrustFolder(p: unknown, what: string, ctx: TrustPathContext = {}): BlockedPathError | null {
  if (!isTrustPath(p, ctx)) return null;
  const text = fsArgPath(p, ctx)?.text ?? String(p);
  return new BlockedPathError(`Refusing ${what} ${show(text)}: it is in ${PRODUCT_NAME}'s trust folder, which only the approval store opens.`, text);
}

/**
 * Throw a {@link BlockedPathError} when `p` is in the private trust folder, in
 * every mode (G7 checks each argv string with it; `ctx.cwd` is where a
 * relative one resolves).
 */
export function assertNotTrustPath(p: unknown, what: string, ctx: TrustPathContext = {}): void {
  const e = inTrustFolder(p, what, ctx);
  if (e) throw e;
}

/** Why `p` may not be opened (`what`: the call, for the log line), or null. `ctx`: where a relative `p` resolves. */
function blocked(p: unknown, what: string, bootstrapping = false, ctx: PathContext = {}): BlockedPathError | null {
  const a = fsArgPath(p, ctx);
  if (!a || a.c.kind === "local") return null;
  // Refused forms are refused always, the bootstrap included: it only skips the trust decision on a server.
  if (a.c.kind === "refused") return new BlockedPathError(`Refusing to open ${show(a.text)}: ${a.c.reason}`, a.text);
  if (bootstrapping && !hostsSet) return null;
  const { host, display } = a.c;
  if (allowed.has(host)) return null;
  if (!logged.has(host)) {
    logged.add(host);
    console.error(`[aive-core] ${ENFORCED ? "blocked" : "would block"} ${display}: ${what} ${show(a.text)} (a network computer not allowed in ${PRODUCT_NAME})`);
  }
  if (!ENFORCED) return null;
  return new BlockedPathError(
    `Refusing to open ${show(a.text)}: it is on the network computer ${display}, which has not been allowed in ${PRODUCT_NAME}.`,
    a.text,
    host,
  );
}

/**
 * Throw a {@link BlockedPathError} when `p` may not be opened. `what` names the
 * call for the log line; `ctx` says where a relative `p` resolves (R5; the
 * process's own cwd by default).
 */
export function assertReachable(p: unknown, what: string, ctx: PathContext = {}): void {
  const e = blocked(p, what, false, ctx);
  if (e) throw e;
}

type Fn = (...args: any[]) => any;
const promises = fsp as unknown as Record<string, Fn>;
const sync = fs as unknown as Record<string, Fn>;

/** Which arguments a wrapped call gates, and whether it reads or changes content (then a trust-folder path is refused too). */
interface Gate {
  paths?: readonly number[];
  content?: boolean;
  bootstrapping?: boolean;
}

/** The first refusal for the gated arguments of a call, or null. */
function refusal(name: string, args: unknown[], { paths = [0], content = false, bootstrapping = false }: Gate): BlockedPathError | null {
  for (const i of paths) {
    const e = blocked(args[i], name, bootstrapping) ?? (content ? inTrustFolder(args[i], name) : null);
    if (e) return e;
  }
  return null;
}

/** `fs/promises` `name`, gated: a refusal is a rejected promise. */
function gatedAsync<F extends Fn>(name: string, gate: Gate = {}): F {
  return ((...args: unknown[]) => {
    const e = refusal(name, args, gate);
    return e ? Promise.reject(e) : promises[name](...args);
  }) as F;
}

/** `fs` `name`, gated: a refusal throws. */
function gatedSync<F extends Fn>(name: string, gate: Gate = {}): F {
  return ((...args: unknown[]) => {
    const e = refusal(name, args, gate);
    if (e) throw e;
    return sync[name](...args);
  }) as F;
}

const CONTENT = { content: true } as const;
const BOTH_CONTENT = { paths: [0, 1], content: true } as const;

export const access = gatedAsync<typeof fsp.access>("access");
export const chmod = gatedAsync<typeof fsp.chmod>("chmod", CONTENT);
export const copyFile = gatedAsync<typeof fsp.copyFile>("copyFile", BOTH_CONTENT);
export const lstat = gatedAsync<typeof fsp.lstat>("lstat");
export const mkdir = gatedAsync<typeof fsp.mkdir>("mkdir", CONTENT);
export const mkdtemp = gatedAsync<typeof fsp.mkdtemp>("mkdtemp", CONTENT);
export const open = gatedAsync<typeof fsp.open>("open", CONTENT);
export const readdir = gatedAsync<typeof fsp.readdir>("readdir");
export const readFile = gatedAsync<typeof fsp.readFile>("readFile", CONTENT);
export const rename = gatedAsync<typeof fsp.rename>("rename", BOTH_CONTENT);
export const rm = gatedAsync<typeof fsp.rm>("rm", CONTENT);
export const stat = gatedAsync<typeof fsp.stat>("stat");
export const utimes = gatedAsync<typeof fsp.utimes>("utimes", CONTENT);
export const writeFile = gatedAsync<typeof fsp.writeFile>("writeFile", CONTENT);

export const appendFileSync = gatedSync<typeof fs.appendFileSync>("appendFileSync", CONTENT);
export const createReadStream = gatedSync<typeof fs.createReadStream>("createReadStream", CONTENT);
export const createWriteStream = gatedSync<typeof fs.createWriteStream>("createWriteStream", CONTENT);
export const readFileSync = gatedSync<typeof fs.readFileSync>("readFileSync", CONTENT);
export const rmSync = gatedSync<typeof fs.rmSync>("rmSync", CONTENT);
export const lstatSync = gatedSync<typeof fs.lstatSync>("lstatSync");
export const readdirSync = gatedSync<typeof fs.readdirSync>("readdirSync");
export const statSync = gatedSync<typeof fs.statSync>("statSync");
export const watch = gatedSync<typeof fs.watch>("watch");

/** `fs.realpathSync.native` (it follows links and, on Windows, 8.3 names and case), gated. */
export function realpathNative(p: string): string {
  const e = blocked(p, "realpathSync");
  if (e) throw e;
  return fs.realpathSync.native(p);
}

/** `fs.existsSync`, false for a path the gate refuses. */
export function existsSync(p: fs.PathLike): boolean {
  return blocked(p, "existsSync") ? false : fs.existsSync(p);
}

/**
 * For datadir.ts only (the lint checks it): it resolves the data folder from
 * the environment before any engine exists, so these allow a path on any
 * server until the first {@link setAllowedNetworkHosts}, then gate like the
 * rest. A Windows device / NT path or a server name with no key is refused
 * here too.
 */
export const bootstrap = {
  statSync: gatedSync<typeof fs.statSync>("statSync", { bootstrapping: true }),
};
