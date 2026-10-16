import { createHash, randomBytes } from "node:crypto";
import { dirname, join, posix } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PRODUCT_NAME } from "../brand.js";
import { chmod, lstat, mkdir, open, readdir, readFile, readFileSync, rename, rm, stat, writeFile } from "../io/gatedfs.js";
import { ADDON_REMOTION_VERSION, type AddonLockEntry, type AddonPlatform, type HeadlessShellZip } from "../motion/addonlock.js";
import { rewriteTargetsMatch } from "../motion/remotionload.js";
import { NameSet } from "./names.js";
import { devVariable, isSourceCheckout } from "./resolve.js";
import { ADDON_PIN, addonPlatform, addonStateAt, graphicsAddonDir, platformLabel, readManifest, type AddonManifest, type AddonPin, type GraphicsAddon } from "./state.js";
import { ArchiveRefusal, extractTarball } from "./tar.js";
import { graphicsAddonTerms } from "./terms.js";
import { copyTree, execBit, treeDigest, walkTree, type ExtractedFile } from "./tree.js";
import { extractZip } from "./zip.js";

/**
 * The graphics add-on's installer (ADDON-PLAN D3), run only by the UI hosts
 * after the user's click: Electron main and the web shell server. No RPC
 * method or MCP tool reaches it, and it never loads or runs the add-on's code.
 *
 * Install (D3.1): the licence hash; the install lock (`addons/.install.lock`,
 * O_EXCL, rewritten every 30 s; stale when its pid is gone or it is 2 minutes
 * old); recovery; staging in `addons/.staging-<random>`; the packages, then
 * the browser, each hashed before a byte is extracted, and each reused from an
 * installed copy when its digest still matches (D3.9); the rewrite-target
 * check; addon.json last; the activation renames; then the other versions'
 * folders go. A failure or cancel before activation completes deletes the
 * staging folder and leaves the previous state. Every name this writes in
 * `addons/` is one hosttrust.ts's name rule protects: remotion,
 * .install.lock, .staging-*, .old-*, .removed-*.
 */

const VERSION = ADDON_REMOTION_VERSION;
const LOCK = ".install.lock";
/** storage.ts's RUN_HEARTBEAT_MS: the lock holder rewrites the lock this often. */
const HEARTBEAT_MS = 30_000;
/** A lock not rewritten for this long (4 heartbeats) is stale, whatever its pid. */
const STALE_MS = 120_000;
/** A request that receives nothing for this long fails. */
const REQUEST_TIMEOUT_MS = 60_000;
/** How long a rename is retried on win32 (antivirus, a render holding a file). */
const RENAME_WINDOW_MS = 10_000;
const PARALLEL = 8;
const RETRIED = new Set(["EPERM", "EACCES", "EBUSY"]);

export type InstallVia = "desktop" | "web";

export interface InstallProgress {
  /** Bytes downloaded or reused so far. */
  done: number;
  /** The platform's tarball total and the browser zip (D2). */
  total: number;
}

export interface InstallOptions {
  /** The host's fetch: Electron's net.fetch, or Node's (D3.6). */
  fetch: typeof globalThis.fetch;
  onProgress?: (p: InstallProgress) => void;
  signal?: AbortSignal;
  /** The sha256 of the notice and licence the user accepted (terms.ts). */
  acceptedLicenseSha256: string;
  via: InstallVia;
}

/** Why an install, a removal or a registry override failed; `message` is for the user. */
export type InstallFailure =
  | "license"
  | "unsupported"
  | "busy"
  | "cancelled"
  | "network"
  | "http"
  | "corrupted"
  | "disk"
  | "path"
  | "guard"
  | "archive"
  | "in-use"
  | "registry"
  | "failed";

export class GraphicsAddonInstallError extends Error {
  constructor(
    readonly reason: InstallFailure,
    message: string,
  ) {
    super(message);
    this.name = "GraphicsAddonInstallError";
  }
}

const IN_USE = "Graphics are rendering or the add-on's files are in use. Try again when the graphic finishes.";
const fail = (reason: InstallFailure, message: string) => new GraphicsAddonInstallError(reason, message);
const reach = (host: string) => fail("network", `${PRODUCT_NAME} couldn't reach ${host}. Check the connection and try again.`);
const corrupted = (what: string) => fail("corrupted", `A download was corrupted or changed (${what}). Nothing was installed. Try again.`);
const code = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code;
const random = () => randomBytes(6).toString("hex");

/**
 * Test seams, honoured only in a source checkout (a packaged core refuses
 * them): the platform key (an offline install of another platform's list),
 * a fixture pin, the environment the registry override is read from, and
 * the timings.
 */
export interface AddonSeams {
  platform?: string;
  pin?: AddonPin;
  env?: NodeJS.ProcessEnv;
  /** A core file whose package folder decides "source checkout" for AIVE_ADDON_REGISTRY. */
  from?: string;
  /** Retry renames as on win32. */
  windowsRenames?: boolean;
  renameWindowMs?: number;
  heartbeatMs?: number;
  staleMs?: number;
  requestTimeoutMs?: number;
  /** Runs after the rewrite-target check, before addon.json is written. */
  beforeManifest?: () => void | Promise<void>;
}

function seams(s: AddonSeams): AddonSeams {
  if (Object.keys(s).length > 0 && !isSourceCheckout()) throw new Error(`The add-on installer's test seams work only in a ${PRODUCT_NAME} source checkout.`);
  return s;
}

// ---- the install lock ----------------------------------------------------------------

interface Lock {
  file: string;
  text: string;
  timer: NodeJS.Timeout;
}

/** Is process `pid` running? (EPERM: it exists, owned by someone else.) */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return code(err) === "EPERM";
  }
}

/** Whether the lock at `file` is stale, and which host holds it. */
async function holder(file: string, s: AddonSeams): Promise<{ stale: boolean; via?: string }> {
  let info: { pid?: unknown; via?: unknown } | undefined;
  try {
    info = JSON.parse(await readFile(file, "utf8")) as typeof info;
  } catch {
    /* being written, or damaged: the mtime decides */
  }
  let mtime: number;
  try {
    mtime = (await stat(file)).mtimeMs;
  } catch {
    return { stale: true }; // gone meanwhile
  }
  const pidGone = typeof info?.pid === "number" && !alive(info.pid);
  return { stale: pidGone || Date.now() - mtime > (s.staleMs ?? STALE_MS), via: typeof info?.via === "string" ? info.via : undefined };
}

/** Take `addons/.install.lock` (D3.1 step 2), or refuse while another host holds it. */
async function takeLock(addons: string, via: string, s: AddonSeams): Promise<Lock> {
  await mkdir(addons, { recursive: true });
  const file = join(addons, LOCK);
  const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const text = `${JSON.stringify({ pid: process.pid, startedAt, via, token: random() })}\n`;
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(file, text, { flag: "wx" });
      break;
    } catch (err) {
      if (code(err) !== "EEXIST") throw err;
    }
    const held = await holder(file, s);
    if (attempt === 0 && held.stale) {
      await rm(file, { force: true });
      continue;
    }
    throw fail("busy", `Another ${PRODUCT_NAME} window is installing the graphics add-on (${held.via ?? "unknown"}). Wait for it to finish.`);
  }
  const timer = setInterval(() => {
    void readFile(file, "utf8")
      .then((now) => (now === text ? writeFile(file, text) : undefined))
      .catch(() => {});
  }, s.heartbeatMs ?? HEARTBEAT_MS);
  timer.unref();
  return { file, text, timer };
}

async function releaseLock(lock: Lock): Promise<void> {
  clearInterval(lock.timer);
  try {
    if ((await readFile(lock.file, "utf8")) === lock.text) await rm(lock.file, { force: true });
  } catch {
    /* already gone */
  }
}

// ---- folders -------------------------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** rename, retried on win32 for EPERM, EACCES and EBUSY with backoff for about 10 s. */
async function renameRetry(from: string, to: string, s: AddonSeams): Promise<void> {
  const windows = s.windowsRenames ?? process.platform === "win32";
  const until = Date.now() + (s.renameWindowMs ?? RENAME_WINDOW_MS);
  for (let wait = 50; ; wait = Math.min(wait * 2, 1000)) {
    try {
      return await rename(from, to);
    } catch (err) {
      if (!windows || !RETRIED.has(code(err) ?? "") || Date.now() >= until) throw err;
      await sleep(wait);
    }
  }
}

/** A rename that failed on a file in use gets the D3.1 step 8 message; anything else passes on. */
const inUse = (err: unknown) => (RETRIED.has(code(err) ?? "") ? fail("in-use", IN_USE) : err);

/**
 * D3.1 step 3: with the live folder missing and exactly one ready `.old-*`
 * (power lost between the activation renames), put it back; then delete
 * every `.staging-*`, `.old-*` and `.removed-*`.
 */
async function recover(addons: string, platform: AddonPlatform | null, pin: AddonPin): Promise<void> {
  let names: string[];
  try {
    names = await readdir(addons);
  } catch {
    return;
  }
  const live = join(addons, "remotion", VERSION);
  if (platform && !(await exists(live))) {
    const ready = names.filter((n) => n.startsWith(".old-") && addonStateAt(join(addons, n), platform, pin).state === "ready");
    if (ready.length === 1) {
      await mkdir(dirname(live), { recursive: true });
      await rename(join(addons, ready[0]), live).catch(() => {});
    }
  }
  for (const n of names) if (/^\.(?:staging|old|removed)-/.test(n)) await rm(join(addons, n), { recursive: true, force: true }).catch(() => {});
}

/** D3.1 step 9 (and Remove): every `remotion/<v>` but this build's is renamed to `.removed-*` and deleted; a failure leaves it for later. */
async function dropOtherVersions(addons: string, s: AddonSeams): Promise<void> {
  let versions: string[];
  try {
    versions = await readdir(join(addons, "remotion"));
  } catch {
    return;
  }
  for (const v of versions.filter((x) => x !== VERSION)) {
    const gone = join(addons, `.removed-${random()}`);
    try {
      await renameRetry(join(addons, "remotion", v), gone, s);
    } catch {
      continue;
    }
    await rm(gone, { recursive: true, force: true }).catch(() => {});
  }
}

/** D3.1 step 8: the live copy to `.old-*`, staging into place, the old copy deleted; a failed second rename puts the old copy back. */
async function activate(addons: string, staging: string, s: AddonSeams): Promise<void> {
  const live = join(addons, "remotion", VERSION);
  await mkdir(dirname(live), { recursive: true });
  let old: string | null = null;
  if (await exists(live)) {
    old = join(addons, `.old-${random()}`);
    try {
      await renameRetry(live, old, s);
    } catch (err) {
      throw inUse(err);
    }
  }
  try {
    await renameRetry(staging, live, s);
  } catch (err) {
    if (old) await renameRetry(old, live, s).catch(() => {});
    throw inUse(err);
  }
  if (old) await rm(old, { recursive: true, force: true }).catch(() => {});
}

// ---- downloads -----------------------------------------------------------------------

/** AIVE_ADDON_REGISTRY (a source checkout only): an http loopback origin that replaces every URL's scheme and host. */
function registryOverride(s: AddonSeams): URL | null {
  const value = devVariable("AIVE_ADDON_REGISTRY", { env: s.env, from: s.from });
  if (value === undefined) return null;
  let u: URL | null = null;
  try {
    u = new URL(value);
  } catch {
    /* refused below */
  }
  if (!u || u.protocol !== "http:" || (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") || !u.port || u.username || u.password || u.pathname !== "/" || u.search || u.hash) {
    throw fail("registry", `AIVE_ADDON_REGISTRY must be http://127.0.0.1:<port> or http://localhost:<port> (it is ${JSON.stringify(value)}).`);
  }
  return u;
}

interface Run {
  fetch: typeof globalThis.fetch;
  /** The user's cancel, or the first failure of a parallel download. */
  signal: AbortSignal;
  override: URL | null;
  timeoutMs: number;
  progress: (bytes: number) => void;
}

interface Download {
  url: string;
  what: string;
  /** No more bytes than this are read. */
  cap: number;
  algorithm: "sha512" | "sha256";
  /** The expected digest: base64 for sha512 (npm's integrity), hex for sha256. */
  expect: string;
  /** Write the bytes to this new file instead of returning them. */
  file?: string;
}

/**
 * Fetch one pinned download, hash every byte, and give it back (or leave it in
 * `d.file`) only when its digest is the pinned one. A request that receives
 * nothing for `timeoutMs` fails; the user's cancel stops it.
 */
async function download(run: Run, d: Download): Promise<Buffer | null> {
  const url = run.override ? `${run.override.origin}${new URL(d.url).pathname}` : d.url;
  const host = new URL(url).host;
  const ctl = new AbortController();
  const stop = () => ctl.abort(run.signal.reason);
  run.signal.addEventListener("abort", stop, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctl.abort(new Error("timed out")), run.timeoutMs);
  };
  const lost = () => {
    run.signal.throwIfAborted();
    return reach(host);
  };
  const out = d.file ? await open(d.file, "wx") : null;
  try {
    arm();
    let res: Response;
    try {
      res = await run.fetch(url, { signal: ctl.signal, redirect: "error" });
    } catch {
      throw lost();
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw fail("http", `${host} answered ${res.status} for ${d.what}. Try again later.`);
    }
    const hash = createHash(d.algorithm);
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      let r: Awaited<ReturnType<typeof reader.read>>;
      try {
        r = await reader.read();
      } catch {
        throw lost();
      }
      if (r.done) break;
      arm();
      size += r.value.length;
      if (size > d.cap) {
        ctl.abort();
        throw corrupted(d.what);
      }
      hash.update(r.value);
      if (out) await out.write(r.value);
      else chunks.push(Buffer.from(r.value));
      run.progress(r.value.length);
    }
    if (hash.digest(d.algorithm === "sha512" ? "base64" : "hex") !== d.expect) throw corrupted(d.what);
    return out ? null : Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    run.signal.removeEventListener("abort", stop);
    await out?.close();
  }
}

/** Run `fn` over `items`, `n` at a time; the first failure aborts the rest (`abort`) and is thrown. */
async function pool<T>(items: readonly T[], n: number, abort: AbortController, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { err: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (err) {
        failure ??= { err };
        abort.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  if (failure) throw failure.err;
}

// ---- staging -------------------------------------------------------------------------

/** A package as messages name it: `name@version`. */
const label = (e: AddonLockEntry) => `${e.path.slice(e.path.lastIndexOf("node_modules/") + "node_modules/".length)}@${e.version}`;
const SHELL = "the Chrome headless shell";
const archive = (what: string, err: ArchiveRefusal) => fail("archive", `The add-on's ${what} holds an entry ${PRODUCT_NAME} doesn't install (${err.message}). Nothing was installed.`);

/**
 * npm makes every file a package's `bin` names executable when it installs it
 * (bin-links), with no script; the add-on does the same, so its tree is npm's.
 * Only a file the tarball held is changed.
 */
async function markBins(dir: string, files: ExtractedFile[]): Promise<void> {
  let bin: unknown;
  try {
    bin = (JSON.parse(text(join(dir, "package.json")) ?? "null") as { bin?: unknown } | null)?.bin;
  } catch {
    return;
  }
  const targets = typeof bin === "string" ? [bin] : isRecord(bin) ? Object.values(bin).filter((t): t is string => typeof t === "string") : [];
  for (const t of targets) {
    const f = files.find((x) => x.path === posix.normalize(t.replace(/\\/g, "/")).replace(/^\.\//, ""));
    if (!f || f.exec) continue;
    await chmod(join(dir, ...f.path.split("/")), 0o755);
    f.exec = execBit(0o755);
  }
}

/** An installed copy whose addon.json records what it holds (D3.9). */
interface Source {
  dir: string;
  entries: Record<string, { integrity?: unknown; digest?: unknown }>;
  browser?: { sha256?: unknown; digest?: unknown };
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The copies an update may reuse from: this build's live folder first, then every other `remotion/<v>`. */
async function sources(addons: string): Promise<Source[]> {
  let versions: string[];
  try {
    versions = await readdir(join(addons, "remotion"));
  } catch {
    return [];
  }
  versions.sort((a, b) => Number(b === VERSION) - Number(a === VERSION));
  const out: Source[] = [];
  for (const v of versions) {
    const dir = join(addons, "remotion", v);
    const m = readManifest(join(dir, "addon.json"));
    if (m && (isRecord(m.entries) || isRecord(m.browser))) out.push({ dir, entries: isRecord(m.entries) ? (m.entries as Source["entries"]) : {}, browser: isRecord(m.browser) ? m.browser : undefined });
  }
  return out;
}

/**
 * Copy `rel` (a package path, or "browser") from the first source with a
 * matching record (`record`) whose folder still has the recorded digest;
 * the digest, or null when nothing can be reused. `nested`: the folders below
 * it that are other packages.
 */
async function reuse(
  from: Source[],
  rel: string,
  staging: string,
  run: Run,
  record: (src: Source) => { digest?: unknown } | undefined,
  nested: (src: Source, sub: string) => boolean,
): Promise<string | null> {
  for (const src of from) {
    const r = record(src);
    if (!r || typeof r.digest !== "string") continue;
    const dir = join(src.dir, ...rel.split("/"));
    const files = await walkTree(dir, (sub) => nested(src, sub), run.signal);
    if (!files || treeDigest(files) !== r.digest) continue;
    await copyTree(dir, join(staging, ...rel.split("/")), files, run.signal);
    return r.digest;
  }
  return null;
}

/** D3.1 step 5: this platform's packages, then the browser, into `staging`; what addon.json records of them. */
async function stage(addons: string, staging: string, platform: AddonPlatform, pin: AddonPin, run: Run, abort: AbortController) {
  const byPath = new Map(pin.closure.map((e) => [e.path, e]));
  const list = pin.lists[platform].paths.map((p) => {
    const e = byPath.get(p);
    if (!e) throw new Error(`the pin has no closure entry for ${p}`);
    return e;
  });
  const listed = new Set(list.map((e) => e.path));
  const shell: HeadlessShellZip = pin.shell[platform];
  const names = new NameSet(platform);
  const from = await sources(addons);
  const entries: Record<string, { integrity: string; digest: string }> = {};

  const fetchList: AddonLockEntry[] = [];
  for (const e of list) {
    const digest = await reuse(
      from,
      e.path,
      staging,
      run,
      (src) => (src.entries[e.path]?.integrity === e.integrity ? src.entries[e.path] : undefined),
      (src, sub) => listed.has(`${e.path}/${sub}`) || `${e.path}/${sub}` in src.entries,
    );
    if (digest === null) fetchList.push(e);
    else {
      entries[e.path] = { integrity: e.integrity, digest };
      run.progress(e.bytes ?? 0);
    }
  }
  const capAll = (pin.lists[platform].bytes ?? 0) + shell.size;
  await pool(fetchList, PARALLEL, abort, async (e) => {
    const gz = (await download(run, { url: e.resolved, what: label(e), cap: e.bytes ?? capAll, algorithm: "sha512", expect: e.integrity.slice("sha512-".length) })) as Buffer;
    const dir = join(staging, ...e.path.split("/"));
    let files;
    try {
      files = await extractTarball(gz, dir, { platform, names, prefix: e.path, signal: run.signal });
    } catch (err) {
      throw err instanceof ArchiveRefusal ? archive(label(e), err) : err;
    }
    await markBins(dir, files);
    entries[e.path] = { integrity: e.integrity, digest: treeDigest(files) };
  });

  let browserDigest = await reuse(from, "browser", staging, run, (src) => (src.browser?.sha256 === shell.sha256 ? src.browser : undefined), () => false);
  if (browserDigest !== null) run.progress(shell.size);
  else {
    const zip = join(staging, "browser.zip");
    await download(run, { url: shell.url, what: SHELL, cap: shell.size, algorithm: "sha256", expect: shell.sha256, file: zip });
    let files;
    try {
      files = await extractZip(zip, join(staging, "browser"), { platform, names, prefix: "browser", signal: run.signal });
    } catch (err) {
      throw err instanceof ArchiveRefusal ? archive(SHELL, err) : err;
    }
    await rm(zip, { force: true });
    browserDigest = treeDigest(files);
  }
  return { entries, browser: { sha256: shell.sha256, digest: browserDigest } };
}

/** A staged file's text, or null. */
function text(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The user-facing error for anything that stopped an install. */
function failure(err: unknown, dataDir: string, cancel: AbortSignal | undefined, mb: number): unknown {
  if (err instanceof GraphicsAddonInstallError) return err;
  if (cancel?.aborted) return fail("cancelled", "The graphics add-on install was cancelled. Nothing was installed.");
  if (code(err) === "ENOSPC") return fail("disk", `Not enough disk space: the add-on needs about ${mb} MB in ${dataDir}.`);
  if (code(err) === "ENAMETOOLONG") return fail("path", `A path in the add-on is too long for this folder (${dataDir}). Move ${PRODUCT_NAME}'s data folder to a shorter path and try again.`);
  return fail("failed", `The graphics add-on couldn't be installed: ${(err as Error)?.message ?? String(err)}`);
}

async function install(dataDir: string, opts: InstallOptions, s: AddonSeams): Promise<GraphicsAddon> {
  const acceptedAt = new Date().toISOString();
  const pin = s.pin ?? ADDON_PIN;
  const platform = addonPlatform(s.platform);
  if (!platform) throw fail("unsupported", `The graphics add-on isn't available for ${platformLabel(s.platform)}.`);
  const licenseSha256 = graphicsAddonTerms(platform).sha256;
  if (opts.acceptedLicenseSha256 !== licenseSha256) throw fail("license", "Accept Remotion's license in the graphics add-on dialog first. Nothing was installed.");
  const override = registryOverride(s);
  const total = pin.lists[platform].paths.reduce((n, p) => n + (pin.closure.find((e) => e.path === p)?.bytes ?? 0), 0) + pin.shell[platform].size;
  const addons = join(dataDir, "addons");
  const lock = await takeLock(addons, opts.via, s);
  let staging: string | null = null;
  try {
    opts.signal?.throwIfAborted();
    await recover(addons, platform, pin);
    staging = join(addons, `.staging-${random()}`);
    await mkdir(staging);
    let done = 0;
    opts.onProgress?.({ done, total });
    const abort = new AbortController();
    const run: Run = {
      fetch: opts.fetch,
      signal: opts.signal ? AbortSignal.any([opts.signal, abort.signal]) : abort.signal,
      override,
      timeoutMs: s.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      progress: (bytes) => opts.onProgress?.({ done: (done += bytes), total }),
    };
    const staged = await stage(addons, staging, platform, pin, run, abort);
    opts.signal?.throwIfAborted();
    const at = staging;
    if (!rewriteTargetsMatch((rel) => text(join(at, "node_modules", ...rel.split("/"))))) {
      throw fail("guard", `This add-on doesn't match the Remotion version ${PRODUCT_NAME} guards. Nothing was installed.`);
    }
    await s.beforeManifest?.();
    const manifest: Required<AddonManifest> = {
      schema: 1,
      remotion: VERSION,
      lockSha256: pin.lockSha256,
      platform,
      browserExecutable: pin.shell[platform].executable,
      licenseSha256,
      acceptedAt,
      installedAt: new Date().toISOString(),
      via: opts.via,
      entries: staged.entries,
      browser: staged.browser,
    };
    await writeFile(join(staging, "addon.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    opts.signal?.throwIfAborted();
    await activate(addons, staging, s);
    staging = null;
    await dropOtherVersions(addons, s);
  } catch (err) {
    throw failure(err, dataDir, opts.signal, Math.max(1, Math.round(total / 1e6)));
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    await releaseLock(lock);
  }
  return addonStateAt(graphicsAddonDir(dataDir), platform, pin);
}

async function recoverAddon(dataDir: string, s: AddonSeams): Promise<boolean> {
  const addons = join(dataDir, "addons");
  if (!(await exists(addons))) return true;
  let lock: Lock;
  try {
    lock = await takeLock(addons, "recovery", s);
  } catch (err) {
    if (err instanceof GraphicsAddonInstallError && err.reason === "busy") return false;
    throw err;
  }
  try {
    await recover(addons, addonPlatform(s.platform), s.pin ?? ADDON_PIN);
  } finally {
    await releaseLock(lock);
  }
  return true;
}

async function remove(dataDir: string, via: InstallVia, s: AddonSeams): Promise<void> {
  const addons = join(dataDir, "addons");
  if (!(await exists(addons))) return;
  const lock = await takeLock(addons, via, s);
  try {
    const live = graphicsAddonDir(dataDir);
    if (await exists(live)) {
      const gone = join(addons, `.removed-${random()}`);
      try {
        await renameRetry(live, gone, s);
      } catch (err) {
        throw inUse(err);
      }
      await rm(gone, { recursive: true, force: true }).catch(() => {});
    }
    await dropOtherVersions(addons, s);
  } finally {
    await releaseLock(lock);
  }
}

/**
 * Install the graphics add-on into `<dataDir>/addons/remotion/<version>/`
 * (D3.1); the add-on's state afterwards ("ready"). Throws a
 * {@link GraphicsAddonInstallError} whose message is for the user.
 */
export function installGraphicsAddon(dataDir: string, opts: InstallOptions): Promise<GraphicsAddon> {
  return install(dataDir, opts, {});
}

/**
 * D3.1 steps 2 and 3 only, then the lock is released: the hosts call it once
 * at start. False when another host holds the install lock (nothing is touched).
 */
export function recoverGraphicsAddon(dataDir: string): Promise<boolean> {
  return recoverAddon(dataDir, {});
}

/** Remove the add-on (D3.7): this version's folder and every other `remotion/<v>`. */
export function removeGraphicsAddon(dataDir: string, opts: { via?: InstallVia } = {}): Promise<void> {
  return remove(dataDir, opts.via ?? "desktop", {});
}

/** The same three with {@link AddonSeams}: for the smokes; a packaged core refuses them. */
export const addonInstallerForTests = {
  install: (dataDir: string, opts: InstallOptions, s: AddonSeams) => install(dataDir, opts, seams(s)),
  recover: (dataDir: string, s: AddonSeams) => recoverAddon(dataDir, seams(s)),
  remove: (dataDir: string, via: InstallVia, s: AddonSeams) => remove(dataDir, via, seams(s)),
};
