/**
 * The approval store: the network computers the user allowed ZabsReel to open
 * files on (`<dataDir>/trust/hosts.json`), and the key that stamps each entry
 * ZabsReel writes there (`<dataDir>/trust/hosts.key`).
 *
 * Only the UI hosts (Electron main and the web shell server) write it, after
 * the user's click in a dialog or a pick in the app's own file dialog. The
 * core only reads it (hosttrust.ts) and refuses every rpc read or write in
 * `trust/` (G2), so no tool can approve a server or see the key. This module
 * is the only code that opens a file in `trust/`: it imports node:fs itself
 * (scripts/check-io-imports.mjs allows it), and io/gatedfs.ts refuses the
 * folder to the rest of the core.
 *
 *  - Stamps. An entry is approved only when its stamp is the HMAC-SHA256 of
 *    its host, `via` and `added` under the key. Any other entry (a hand edit,
 *    another program, an AI assistant with a shell) is "outside": listed, but
 *    never used until the user keeps it (a UI host stamps it) or removes it.
 *    Tamper-evident, not tamper-proof: whoever can read the key can forge.
 *  - Read errors. ENOENT is missing, bytes that do not parse are corrupt, and
 *    any other error (an antivirus scanner holding the file, a share hiccup)
 *    is unreadable. Only missing and corrupt change anything on disk. A reader
 *    keeps the last good copy of each file per data folder and uses it while
 *    the file is unreadable (`stale`). With no good copy yet, no listed server
 *    is trusted and none is called outside (`unread`).
 *  - Writes. approveHost and revokeHost go through updateHosts, the only
 *    writer, under a lock file ({@link withTrustLock}), so two UI hosts never
 *    lose a revoke. Files are replaced by rename, so a reader never sees half
 *    of one.
 *  - No log line, result or error carries a stamp, the key or file content.
 */
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import { PRODUCT_NAME } from "./brand.js";
import { normalizeHost } from "./unc.js";

export type TrustFile = "hosts.json" | "hosts.key";
/** How the user approved a server: Allow or Keep in a dialog, or a file picked in the app's own file dialog. */
export type Via = "prompt" | "picker";

export interface ApprovedHost {
  host: string;
  via: Via;
  added: string;
}

export interface TrustedHosts {
  /** Servers with a valid stamp. */
  approved: ApprovedHost[];
  /** Servers in the list without a valid stamp ("added outside ZabsReel"): never used. */
  outside: { host: string }[];
  /** A file could not be read just now, so its last good copy was used (or there was none): read again soon. */
  stale: boolean;
  /** The files that could not be read and have no good copy yet: then no listed server is approved or outside. */
  unread: TrustFile[];
}

/** Test seam: the read of each named file fails with this error code. */
export type ReadErrorInjection = Partial<Record<TrustFile, string>>;

export interface ReadOptions {
  readError?: ReadErrorInjection;
}

export interface UpdateOptions extends ReadOptions, LockOptions {
  /** Test seam: runs inside the lock, after the store was read and before it is written. */
  afterRead?: () => unknown;
}

export interface LockOptions {
  /** Test seam: runs when a waiter has judged the lock stale, before it claims it. */
  onStale?: () => unknown;
}

/** A store write that did not happen (the lock stayed busy, or a file could not be read): nothing changed; try again. */
export class TrustStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustStoreError";
  }
}

/** `<dataDir>/trust`: the approval list, its key and the lock. */
export function trustDir(dataDir: string): string {
  return join(dataDir, "trust");
}

const LIST = "hosts.json";
const KEY = "hosts.key";
const LOCK = "hosts.lock";
/** The HMAC input starts with this, so a stamp can't be reused for anything else. */
const STAMP_LABEL = "zabsreel-hosts-v2";
/** 32 random bytes as base64url. */
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;
/** A lock older than this was left by a writer that crashed (a write takes a few milliseconds). */
const STALE_MS = 10_000;
const WAIT_MS = 2_000;
const POLL_MS = 25;

const log = (msg: string) => console.error(`[${PRODUCT_NAME} trust] ${msg}`);

type FileRead = { kind: "ok"; bytes: Buffer } | { kind: "missing" } | { kind: "unreadable"; code: string };

function readTrustFile(dir: string, file: TrustFile, opts: ReadOptions): FileRead {
  const injected = opts.readError?.[file];
  if (injected) return injected === "ENOENT" ? { kind: "missing" } : { kind: "unreadable", code: injected };
  try {
    return { kind: "ok", bytes: readFileSync(join(dir, file)) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "EIO";
    return code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable", code };
  }
}

/** The key in a hosts.key file, or null when the file does not hold one (corrupt). */
function parseKey(bytes: Buffer): Buffer | null {
  const text = bytes.toString("latin1").replace(/\r?\n$/, "");
  if (!KEY_TEXT.test(text)) return null;
  const key = Buffer.from(text, "base64url");
  return key.length === 32 && key.toString("base64url") === text ? key : null;
}

interface List {
  version: 1 | 2;
  entries: unknown[];
}
const EMPTY: List = { version: 2, entries: [] };

/** The entries of a hosts.json file, or why it is corrupt (never its content). */
function parseList(bytes: Buffer): List | { why: string } {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { why: "does not parse" };
  }
  const { version, servers } = (json ?? {}) as { version?: unknown; servers?: unknown };
  if (version !== 1 && version !== 2) return { why: "has an unknown version" };
  if (!Array.isArray(servers)) return { why: "has no list of servers" };
  return { version, entries: servers };
}

function stampOf(key: Buffer, host: string, via: string, added: string): Buffer {
  return createHmac("sha256", key).update(`${STAMP_LABEL}\n${host}\n${via}\n${added}`).digest();
}

/** An entry as written: approved ones carry via, added and stamp; outside ones only the host. */
interface Entry {
  host: string;
  via?: Via;
  added?: string;
  stamp?: string;
}

interface Sorted {
  /** Every host once, in file order. */
  order: string[];
  /** The first validly stamped entry per host. */
  approved: Map<string, Required<Entry>>;
  /** Hosts with no validly stamped entry. */
  outside: string[];
}

/**
 * Sort entries into approved (a valid stamp under `key`) and outside. Each
 * host is normalized (unc.ts) and an entry whose host has no key is dropped.
 * Version 1 had no stamps, so all its entries are outside.
 */
function sortEntries(list: List, key: Buffer | null): Sorted {
  const order: string[] = [];
  const approved = new Map<string, Required<Entry>>();
  for (const raw of list.entries) {
    const e = (raw ?? {}) as Record<string, unknown>;
    if (typeof e.host !== "string") continue;
    const h = normalizeHost(e.host);
    if (!h.ok) continue;
    if (!order.includes(h.key)) order.push(h.key);
    if (approved.has(h.key) || list.version !== 2 || !key) continue;
    const { via, added, stamp } = e;
    if ((via !== "prompt" && via !== "picker") || typeof added !== "string" || typeof stamp !== "string") continue;
    const got = Buffer.from(stamp, "base64url");
    if (got.length === 32 && timingSafeEqual(got, stampOf(key, h.key, via, added))) approved.set(h.key, { host: h.key, via, added, stamp });
  }
  return { order, approved, outside: order.filter((h) => !approved.has(h)) };
}

/**
 * The last good read of each file, per data folder. Only a key or list that
 * parsed is kept: a missing or corrupt read clears it, so a later unreadable
 * read is in the unread state, never "every entry outside".
 */
interface Kept {
  key?: Buffer;
  list?: List;
  /** The problems the last read logged, so a re-read every second logs each once. */
  logged: Set<string>;
}
const kept = new Map<string, Kept>();

/**
 * The servers in the approval store of `dataDir`, sorted into approved (valid
 * stamp) and outside. Never throws and never writes. A file that can't be
 * read right now is replaced by its last good copy (`stale`), or, with none,
 * nothing in the list counts (`unread`). See the module comment.
 */
export function readTrustedHosts(dataDir: string, opts: ReadOptions = {}): TrustedHosts {
  const dir = trustDir(dataDir);
  let c = kept.get(resolve(dataDir));
  if (!c) kept.set(resolve(dataDir), (c = { logged: new Set() }));
  const problems: string[] = [];
  let stale = false;

  const k = readTrustFile(dir, KEY, opts);
  let key: Buffer | null | undefined;
  if (k.kind === "ok") {
    key = parseKey(k.bytes);
    c.key = key ?? undefined;
    if (!key) problems.push(`${KEY} is not 43 base64url characters for 32 bytes, so no entry counts as added by ${PRODUCT_NAME}`);
  } else if (k.kind === "missing") {
    key = null;
    c.key = undefined;
  } else {
    stale = true;
    key = c.key;
  }

  const j = readTrustFile(dir, LIST, opts);
  let list: List | undefined;
  if (j.kind === "ok") {
    const parsed = parseList(j.bytes);
    if ("why" in parsed) problems.push(`${LIST} ${parsed.why}; no server in it is used`);
    list = "why" in parsed ? EMPTY : parsed;
    c.list = "why" in parsed ? undefined : parsed;
  } else if (j.kind === "missing") {
    list = EMPTY;
    c.list = undefined;
  } else {
    stale = true;
    list = c.list;
  }

  // An unreadable key with no copy matters only when there is an entry to check.
  const unread: TrustFile[] = [];
  if (k.kind === "unreadable") {
    if (key !== undefined) problems.push(`${KEY} could not be read (${k.code}); using the last good copy`);
    else if (list === undefined || list.entries.length > 0) unread.push(KEY);
  }
  if (j.kind === "unreadable") {
    if (list !== undefined) problems.push(`${LIST} could not be read (${j.code}); using the last good copy`);
    else unread.push(LIST);
  }
  for (const f of unread) {
    const code = f === KEY ? (k as { code: string }).code : (j as { code: string }).code;
    problems.push(`${f} could not be read (${code}); no good copy yet, so no listed server is used until it can be read`);
  }
  for (const p of problems) if (!c.logged.has(p)) log(p);
  c.logged = new Set(problems);

  if (unread.length > 0 || list === undefined) return { approved: [], outside: [], stale: true, unread };
  const sorted = sortEntries(list, key ?? null);
  return {
    approved: [...sorted.approved.values()].map(({ host, via, added }) => ({ host, via, added })),
    outside: sorted.outside.map((host) => ({ host })),
    stale,
    unread,
  };
}

// ---- writing ----------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function statOrNull(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function unlinkQuiet(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    /* already gone */
  }
}

/** Create `p` with O_EXCL holding `text`; false when it exists. */
function createExclusive(p: string, text: string): boolean {
  let fd: number;
  try {
    fd = openSync(p, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * What Windows answers while another process has a file open (a reader of the list, an antivirus
 * scan) or its name is still being deleted: a rename over it, or creating a file of that name,
 * fails until the last handle closes. Retried there, never final.
 */
const WIN_IN_USE = new Set(["EPERM", "EACCES", "EBUSY"]);
/** How long such a rename is retried on win32, as addon/install.ts's renameRetry; from 10 ms, doubling to 1 s. */
const RENAME_WINDOW_MS = 10_000;

/** Write `name` in `dir` whole: a temp file (mode 0600), then a rename over it, retried on win32 while the file is open elsewhere. */
async function writeAtomic(dir: string, name: string, text: string): Promise<void> {
  const tmp = join(dir, `${name}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    createExclusive(tmp, text);
    const until = Date.now() + RENAME_WINDOW_MS;
    for (let wait = 10; ; wait = Math.min(wait * 2, 1000)) {
      try {
        renameSync(tmp, join(dir, name));
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "";
        if (process.platform !== "win32" || !WIN_IN_USE.has(code)) throw err;
        if (Date.now() >= until) throw new TrustStoreError(`Couldn't save the list of approved computers: another program kept ${name} open (${code}). Try again.`);
        await sleep(wait);
      }
    }
  } catch (err) {
    unlinkQuiet(tmp);
    throw err;
  }
}

/**
 * Remove the stale lock whose mtime floor is `t`, if it is still there: only
 * the waiter holding the claim `hosts.lock.break-<t>.<k>` may. A claim whose
 * claimer crashed (older than the stale age) gives way to claim k + 1. True
 * when this call removed the lock.
 */
function breakStaleLock(dir: string, t: number): boolean {
  const lock = join(dir, LOCK);
  for (let k = 1; ; k++) {
    const claim = join(dir, `${LOCK}.break-${t}.${k}`);
    if (!createExclusive(claim, "")) {
      const held = statOrNull(claim);
      if (held && Date.now() - held.mtimeMs > STALE_MS) continue;
      return false; // another waiter is breaking this lock: start over
    }
    try {
      const now = statOrNull(lock);
      if (!now || Math.floor(now.mtimeMs) !== t || Date.now() - now.mtimeMs <= STALE_MS) return false;
      unlinkQuiet(lock);
      return true;
    } finally {
      unlinkQuiet(claim);
    }
  }
}

/**
 * Run `fn` holding `<dataDir>/trust/hosts.lock` (created with O_EXCL). A lock
 * more than 10 s old is broken through a claim ({@link breakStaleLock}), never
 * unlinked on an earlier judgement, so a live lock is never removed. No lock
 * within 2 s: TrustStoreError, and `fn` does not run.
 */
export async function withTrustLock<T>(dataDir: string, fn: () => T | Promise<T>, opts: LockOptions = {}): Promise<T> {
  const dir = trustDir(dataDir);
  mkdirSync(dataDir, { recursive: true });
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const lock = join(dir, LOCK);
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    let busy = false;
    try {
      if (createExclusive(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))) break;
    } catch (err) {
      // win32: the lock's name stays taken a moment after its holder deletes it (WIN_IN_USE, not EEXIST).
      if (process.platform !== "win32" || !WIN_IN_USE.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
      busy = true;
    }
    const held = statOrNull(lock);
    if (held && Date.now() - held.mtimeMs > STALE_MS) {
      await opts.onStale?.();
      if (breakStaleLock(dir, Math.floor(held.mtimeMs))) continue;
    }
    if (Date.now() >= deadline) throw new TrustStoreError(`Couldn't save the list of approved computers: another ${PRODUCT_NAME} window is saving it. Try again.`);
    if (held || busy) await sleep(POLL_MS);
  }
  try {
    return await fn();
  } finally {
    unlinkQuiet(lock);
  }
}

/** Keep a corrupt store file (a hand-edit mistake) as `<name>.bad-<time>` instead of overwriting it. */
function moveAside(dir: string, name: string): void {
  renameSync(join(dir, name), join(dir, `${name}.bad-${Date.now()}`));
}

/** The entries as they are written back: approved ones keep their stamps; outside ones keep only the host (no laundering). */
function written(s: Sorted): Entry[] {
  return s.order.map((host) => s.approved.get(host) ?? { host });
}

/**
 * The only writer. Under the lock: read both files, refuse to go on when
 * either is unreadable (nothing is created, renamed or written), create a
 * missing key and replace a corrupt one (kept as `.bad-*`), keep a corrupt
 * list as `.bad-*`, then write what `change` returns (null: write nothing).
 * Returns whether it wrote.
 */
async function updateHosts(dataDir: string, change: (s: Sorted, key: Buffer) => Entry[] | null, opts: UpdateOptions = {}): Promise<boolean> {
  return withTrustLock(
    dataDir,
    async () => {
      const dir = trustDir(dataDir);
      const k = readTrustFile(dir, KEY, opts);
      const j = readTrustFile(dir, LIST, opts);
      for (const [file, r] of [[KEY, k], [LIST, j]] as const) {
        if (r.kind === "unreadable") throw new TrustStoreError(`Couldn't save the list of approved computers: ${file} could not be read (${r.code}). Try again.`);
      }
      let key = k.kind === "ok" ? parseKey(k.bytes) : null;
      if (!key) {
        if (k.kind === "ok") moveAside(dir, KEY);
        const text = randomBytes(32).toString("base64url");
        await writeAtomic(dir, KEY, `${text}\n`);
        key = Buffer.from(text, "base64url");
      }
      let list = EMPTY;
      if (j.kind === "ok") {
        const parsed = parseList(j.bytes);
        if ("why" in parsed) moveAside(dir, LIST);
        else list = parsed;
      }
      const sorted = sortEntries(list, key);
      await opts.afterRead?.();
      // Claims left by a crashed claimer: every lock they name is gone (this one holds the lock).
      for (const f of readdirSync(dir)) if (f.startsWith(`${LOCK}.break-`)) unlinkQuiet(join(dir, f));
      const servers = change(sorted, key);
      if (!servers) return false;
      await writeAtomic(dir, LIST, `${JSON.stringify({ version: 2, servers }, null, 2)}\n`);
      return true;
    },
    opts,
  );
}

function hostKey(host: string): string {
  const h = normalizeHost(host);
  if (!h.ok) throw new Error(`"${host}" is not a computer name ${PRODUCT_NAME} can use. ${h.reason}`);
  return h.key;
}

/**
 * Approve `host` (Allow or Keep in a dialog, or a pick in the app's own file
 * dialog): every entry for it is replaced by one new stamped entry. Other
 * entries are written back as they were (outside ones stay outside).
 * Rejects with TrustStoreError when nothing could be saved.
 */
export async function approveHost(dataDir: string, host: string, via: Via, opts: UpdateOptions = {}): Promise<void> {
  const key = hostKey(host);
  if (via !== "prompt" && via !== "picker") throw new Error(`Unknown approval kind "${String(via)}".`);
  await updateHosts(
    dataDir,
    (s, k) => {
      const added = new Date().toISOString();
      return [...written(s).filter((e) => e.host !== key), { host: key, via, added, stamp: stampOf(k, key, via, added).toString("base64url") }];
    },
    opts,
  );
}

/**
 * Remove every entry for `host`, approved or outside. With `onlyIfOutside`
 * (the Keep dialog's Remove), decided under the lock: when the host has a
 * validly stamped entry by then (another UI host kept it), nothing is written
 * and `removed` is false. Re-reads the file afterwards and rejects unless the
 * host is gone.
 */
export async function revokeHost(dataDir: string, host: string, opts: UpdateOptions & { onlyIfOutside?: boolean } = {}): Promise<{ removed: boolean }> {
  const key = hostKey(host);
  let removed = true;
  await updateHosts(
    dataDir,
    (s) => {
      if (opts.onlyIfOutside && s.approved.has(key)) {
        removed = false;
        return null;
      }
      return written(s).filter((e) => e.host !== key);
    },
    opts,
  );
  if (removed) {
    const j = readTrustFile(trustDir(dataDir), LIST, opts);
    const list = j.kind === "ok" ? parseList(j.bytes) : j.kind === "missing" ? EMPTY : null;
    if (!list || "why" in list || sortEntries(list, null).order.includes(key)) throw new TrustStoreError(`Couldn't remove \\\\${key}; try again.`);
  }
  return { removed };
}
