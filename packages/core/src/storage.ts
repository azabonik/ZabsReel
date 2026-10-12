import { lstat, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MASK_GRACE_MS } from "./gc.js";

/**
 * Housekeeping for the files the engine BAKES into the data dir:
 *
 *   baked/    remove_background cutouts (lossless FFV1 .mkv, ~0.9 GB per minute
 *             of 1080p, plus a VP8 .webm preview), stabilize, auto-reframe,
 *             freeze_frame PNGs, reverse_clip, smooth_slow_motion, motion graphics
 *   proxies/  generate_proxy preview proxies
 *
 * Projects reference these files, and a project is a .aive JSON file that can
 * live at ANY path, so no run can prove a file is unused. The policy is
 * therefore: AUTO-TRASH, never auto-delete a file that looks referenced, and
 * restore on load.
 *
 *  - A file is REFERENCED when any string in the open project, its undo/redo
 *    history, a file in <dataDir>/autosave/ or a known project file
 *    (<dataDir>/projects.json, appended by save/load) resolves to it. Strings
 *    are scanned without knowing field names, so new bake writers are covered.
 *  - An unreferenced top-level entry of baked/ or proxies/ older than the grace
 *    period (1 h: a bake writes its file before it re-points the clip) is
 *    RENAMED into <area>/.trash/ (same directory tree, so the rename is instant).
 *    The rename sets the entry's mtime to the time it was trashed.
 *  - Trash entries older than AIVE_BAKED_TRASH_DAYS (default 7) are deleted.
 *  - Loading a project moves any file it names back out of the trash first, and
 *    so does every clean-up for a trashed file that a project names again; a
 *    trashed file a project names is never deleted.
 *  - While a known project file or an autosave can't be read (missing — an
 *    unplugged drive, a moved file —, no permission, half-written, or no answer
 *    within 10 s), nothing is moved to the trash: its references are unknown.
 *    projects.json records since when (`unavailable`); after the trash retention
 *    period a known project is forgotten and an autosave ignored, or at once
 *    with clean_up_storage {forgetMissing}.
 *  - Nothing runs while a job is running. Symlinks are never followed or moved,
 *    and nothing outside the two managed dirs is touched.
 *  - Files older than the known-projects list itself (`since` in projects.json)
 *    may belong to a project saved before SynthCut recorded project files, so
 *    automatic runs leave them alone; an explicit clean-up (clean_up_storage,
 *    "Clean up now") moves them to the trash like any other unused file, and
 *    Empty trash keeps the ones it just moved in the trash for the retention
 *    period. The UI also records its recent projects (remember_projects).
 */

export const MANAGED_AREAS = ["baked", "proxies"] as const;
export type ManagedArea = (typeof MANAGED_AREAS)[number];
export const TRASH_DIR_NAME = ".trash";
export const KNOWN_PROJECTS_FILE = "projects.json";
/** Unreferenced files younger than this stay put (a bake writes before it re-points; cancelled jobs leave partials). */
export const STORAGE_GRACE_MS = MASK_GRACE_MS;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Longest list returned in a report (the totals still count everything). */
const REPORT_LIST_MAX = 500;
/** Automatic runs (save, bake end, load/new) run at most this often. */
const AUTO_MIN_INTERVAL_MS = 60_000;
/** A known project or autosave that gives no answer within this long counts as unreadable for the run (a hung network drive). */
export const PROJECT_READ_TIMEOUT_MS = 10_000;
/** Files remember_projects accepts. */
const PROJECT_FILE = /\.(aive|otio)$/i;

const WIN = process.platform === "win32";
const AREA_HINT = /baked|proxies/i;
/** Characters that end a path embedded in a longer string (filter args, URLs, lists). */
const EMBED_END = /[\s"'`;,|()<>[\]{}?#*:=&]/;

/** How long trashed files are kept: AIVE_BAKED_TRASH_DAYS (default 7, may be fractional, 0 = next clean-up). */
export function trashRetentionMs(): number {
  const raw = process.env.AIVE_BAKED_TRASH_DAYS;
  const days = raw !== undefined && raw.trim() !== "" ? Number(raw) : NaN;
  return (Number.isFinite(days) && days >= 0 ? days : 7) * DAY_MS;
}

/** Debounce for automatic runs: AIVE_STORAGE_GC_DELAY_MS (default 3000; negative turns automatic runs off). */
function autoDelayMs(): number {
  const raw = process.env.AIVE_STORAGE_GC_DELAY_MS;
  const ms = raw !== undefined && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isFinite(ms) ? ms : 3000;
}

function norm(p: string): string {
  const r = resolve(p);
  return WIN ? r.toLowerCase() : r;
}

function fold(s: string): string {
  return WIN ? s.toLowerCase() : s;
}

function under(p: string, dir: string): boolean {
  return p.startsWith(dir + sep);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function fmtAge(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function fmtDays(ms: number): string {
  const d = ms / DAY_MS;
  return plural(Number.isInteger(d) ? d : Number(d.toFixed(1)), "day");
}

// ---- reference walker --------------------------------------------------------

/** Every string value (and object key) in a JSON-like value, the way JSON.stringify would see it. */
export function collectStrings(value: unknown, out: Set<string>, seen: Set<object> = new Set()): void {
  if (typeof value === "string") {
    out.add(value);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, seen);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    out.add(k);
    collectStrings(v, out, seen);
  }
}

function addRefs(s: string, dirs: string[], out: Set<string>): void {
  if (!AREA_HINT.test(s)) return;
  addPathRefs(s, dirs, out);
  // A file: URL (an .otio target_url) or a percent-encoded path: decode it, so
  // a data dir under "John Smith" or a non-ASCII user name still matches.
  if (/^file:/i.test(s)) {
    try {
      addPathRefs(fileURLToPath(s), dirs, out);
    } catch {
      /* not a local file URL */
    }
  }
  if (s.includes("%")) {
    let decoded: string | undefined;
    try {
      decoded = decodeURIComponent(s);
    } catch {
      /* malformed escape */
    }
    if (decoded && decoded !== s) addPathRefs(decoded, dirs, out);
  }
}

function addPathRefs(s: string, dirs: string[], out: Set<string>): void {
  // A whole-string path (the normal case: asset.path / proxyPath / previewPath).
  if (isAbsolute(s)) {
    const r = norm(s);
    for (const d of dirs) if (r === d || under(r, d)) out.add(r);
  } else {
    // A relative path, resolved against the working directory as the engine's
    // was when it wrote it (a relative AIVE_DATA_DIR). Only files count: a bare
    // word never marks a whole managed dir as used.
    const r = norm(s);
    for (const d of dirs) if (under(r, d)) out.add(r);
  }
  // A managed path embedded in a longer string (e.g. a filter argument).
  const folded = fold(s);
  for (const d of dirs) {
    const variants = WIN ? [d + "\\", d.replace(/\\/g, "/") + "/"] : [d + "/"];
    for (const v of variants) {
      for (let i = folded.indexOf(v); i >= 0; i = folded.indexOf(v, i + 1)) {
        const tail = folded.slice(i + v.length).split(EMBED_END)[0];
        if (!tail) continue;
        const r = norm(join(d, tail));
        if (under(r, d)) out.add(r);
      }
    }
  }
}

/**
 * The resolved paths under <dataDir>/baked/ and <dataDir>/proxies/ that any of
 * `projects` mention (case-folded on Windows). Field-agnostic: every string in
 * each project is checked, so a new bake writer needs no change here.
 */
export function referencedManagedPaths(dataDir: string, projects: Iterable<unknown>): Set<string> {
  const dirs = MANAGED_AREAS.map((a) => norm(join(dataDir, a)));
  const out = new Set<string>();
  for (const p of projects) {
    const strings = new Set<string>();
    collectStrings(p, strings);
    for (const s of strings) addRefs(s, dirs, out);
  }
  return out;
}

type RefNames = { all: boolean; names: Set<string>; trashNames: Set<string> };

/** Top-level entry names of `dir` that `refs` reach (plus names inside its .trash). */
function referencedNames(dir: string, refs: Set<string>): RefNames {
  const d = norm(dir);
  const names = new Set<string>();
  const trashNames = new Set<string>();
  let all = false;
  for (const r of refs) {
    if (r === d) all = true;
    if (!under(r, d)) continue;
    const parts = r.slice(d.length + 1).split(sep);
    if (parts[0] === fold(TRASH_DIR_NAME)) {
      if (parts[1]) trashNames.add(parts[1]);
    } else if (parts[0]) {
      names.add(parts[0]);
    }
  }
  return { all, names, trashNames };
}

// ---- known project files (<dataDir>/projects.json) -----------------------------

interface KnownProjects {
  version: 1;
  /** When SynthCut started recording project files here (ms). */
  since: number;
  projects: string[];
  /**
   * Known project files and autosaves that could not be read, with when that
   * was first seen (ms). While one is younger than the trash retention, nothing
   * is moved to the trash; after it, a known project is forgotten and an
   * autosave ignored.
   */
  unavailable?: Record<string, number>;
}

type IndexRead =
  | { state: "ok"; index: KnownProjects }
  | { state: "missing" }
  | { state: "corrupt"; error: string };

async function readIndex(dataDir: string): Promise<IndexRead> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir, KNOWN_PROJECTS_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "corrupt", error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const j = JSON.parse(raw) as Partial<KnownProjects>;
    if (!j || typeof j.since !== "number" || !Array.isArray(j.projects) || !j.projects.every((p) => typeof p === "string")) {
      return { state: "corrupt", error: "unexpected shape" };
    }
    // Optional; a malformed map is dropped, not a reason to distrust the list.
    const unavailable: Record<string, number> = {};
    if (j.unavailable && typeof j.unavailable === "object" && !Array.isArray(j.unavailable)) {
      for (const [p, t] of Object.entries(j.unavailable)) if (typeof t === "number" && Number.isFinite(t)) unavailable[p] = t;
    }
    return {
      state: "ok",
      index: { version: 1, since: j.since, projects: j.projects, ...(Object.keys(unavailable).length ? { unavailable } : {}) },
    };
  } catch (err) {
    return { state: "corrupt", error: err instanceof Error ? err.message : String(err) };
  }
}

async function writeIndex(dataDir: string, index: KnownProjects): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, KNOWN_PROJECTS_FILE);
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(tmp, JSON.stringify(index, null, 2), "utf8");
  await rename(tmp, path);
}

// ---- listing -------------------------------------------------------------------

interface Entry {
  area: ManagedArea;
  name: string;
  path: string;
  isDir: boolean;
  bytes: number;
  /** Newest mtime in the entry (a directory counts its contents). For a trash entry: when it was trashed. */
  mtimeMs: number;
}

async function treeStats(path: string): Promise<{ bytes: number; newest: number }> {
  let bytes = 0;
  let newest = 0;
  const walk = async (p: string): Promise<void> => {
    let st;
    try {
      st = await lstat(p);
    } catch {
      return;
    }
    newest = Math.max(newest, st.mtimeMs);
    if (st.isSymbolicLink()) return; // never followed
    if (st.isFile()) {
      bytes += st.size;
      return;
    }
    if (!st.isDirectory()) return;
    let names: string[] = [];
    try {
      names = await readdir(p);
    } catch {
      return;
    }
    for (const n of names) await walk(join(p, n));
  };
  await walk(path);
  return { bytes, newest };
}

interface AreaListing {
  area: ManagedArea;
  dir: string;
  entries: Entry[];
  trash: Entry[];
  /** Why this area is left alone this run (symlinked dir, unreadable …). */
  problem?: string;
  skippedLinks: number;
}

async function listEntries(area: ManagedArea, dir: string): Promise<{ entries: Entry[]; skippedLinks: number }> {
  const entries: Entry[] = [];
  let skippedLinks = 0;
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return { entries, skippedLinks };
  }
  for (const name of names) {
    if (name === TRASH_DIR_NAME) continue;
    const path = join(dir, name);
    let st;
    try {
      st = await lstat(path);
    } catch {
      continue; // raced deletion
    }
    if (st.isSymbolicLink()) {
      skippedLinks++;
      continue;
    }
    if (st.isFile()) entries.push({ area, name, path, isDir: false, bytes: st.size, mtimeMs: st.mtimeMs });
    else if (st.isDirectory()) {
      const t = await treeStats(path);
      entries.push({ area, name, path, isDir: true, bytes: t.bytes, mtimeMs: Math.max(st.mtimeMs, t.newest) });
    }
  }
  return { entries, skippedLinks };
}

async function listArea(dataDir: string, area: ManagedArea): Promise<AreaListing> {
  const dir = join(dataDir, area);
  const out: AreaListing = { area, dir, entries: [], trash: [], skippedLinks: 0 };
  try {
    const st = await lstat(dir);
    if (st.isSymbolicLink()) return { ...out, problem: `${area}/ is a symbolic link — left alone` };
    if (!st.isDirectory()) return { ...out, problem: `${area} is not a directory — left alone` };
  } catch {
    return out; // nothing baked yet
  }
  const top = await listEntries(area, dir);
  out.entries = top.entries;
  out.skippedLinks = top.skippedLinks;
  const trashDir = join(dir, TRASH_DIR_NAME);
  try {
    const st = await lstat(trashDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return { ...out, problem: `${area}/${TRASH_DIR_NAME} is not a plain directory — left alone` };
    }
    // A trash entry's own mtime is the time it was trashed (set by the rename).
    const t = await listEntries(area, trashDir);
    for (const e of t.entries) {
      try {
        e.mtimeMs = (await lstat(e.path)).mtimeMs;
      } catch {
        /* raced */
      }
    }
    out.trash = t.entries;
    out.skippedLinks += t.skippedLinks;
  } catch {
    /* no trash yet */
  }
  return out;
}

// ---- plan (dry run) --------------------------------------------------------------

export interface StorageCandidate {
  area: ManagedArea;
  name: string;
  path: string;
  bytes: number;
  size: string;
  isDir: boolean;
  modifiedAt: string;
  /** Older than the known-projects list: only an explicit clean-up moves it. */
  predatesTracking: boolean;
  why: string;
}

export interface StorageTrashItem {
  area: ManagedArea;
  name: string;
  path: string;
  bytes: number;
  size: string;
  isDir: boolean;
  trashedAt: string;
  age: string;
  /** Deleted for good by the next clean-up (older than the retention period). */
  expired: boolean;
  /** A project names it again: the next clean-up moves it back (never deleted). */
  inUse: boolean;
}

/** A known project file or autosave that could not be read this run. */
interface UnavailableProject {
  path: string;
  autosave: boolean;
  missing: boolean;
  reason: string;
  /** When it was first seen unreadable (ms). */
  firstMs: number;
  /** Unreadable for longer than the trash retention: no longer pauses clean-up (a known project is forgotten). */
  stale: boolean;
}

type InUseTrash = Entry & { destName: string };

interface Plan {
  now: number;
  mode: "auto" | "explicit";
  areas: AreaListing[];
  /** Index state; corrupt → nothing is trashed this run. */
  index: IndexRead;
  since: number;
  /** Files to move to the trash in this mode. */
  candidates: (Entry & { predatesTracking: boolean; why: string })[];
  /** Unreferenced but inside the grace period. */
  young: Entry[];
  /** Unreferenced, old enough, but predates tracking (auto mode keeps them). */
  legacyKept: Entry[];
  referenced: Entry[];
  trash: (Entry & { expired: boolean; inUse: boolean })[];
  expired: Entry[];
  /** Trash entries a project names again, with the name each goes back to (newest copy per name). */
  inUseTrash: InUseTrash[];
  /** Referenced names per usable area (explicit and full automatic runs). */
  refs: Map<ManagedArea, RefNames>;
  knownProjects: string[];
  unavailable: UnavailableProject[];
  /** Why nothing is moved to the trash this run (an unreadable project file), if so. */
  paused: string | null;
  warnings: string[];
  /** True when an automatic run found nothing old enough to look at (no project files were read). */
  quick: boolean;
}

export interface StorageDeps {
  /** In-memory projects: the open project plus its undo/redo history. Read last so they are freshest. */
  liveProjects: () => unknown[];
  /** Jobs still running; any of them pauses clean-up. */
  runningJobs: () => { type: string; label: string }[];
  log?: (msg: string) => void;
  /** Per-file read timeout for known projects and autosaves (default PROJECT_READ_TIMEOUT_MS). */
  readTimeoutMs?: number;
}

export interface StorageCleanupResult {
  /** Set when nothing was done, with the reason. */
  skipped?: string;
  moved: { area: ManagedArea; name: string; bytes: number }[];
  movedBytes: number;
  /** Trashed files a project names again, moved back out of the trash. */
  restored: { area: ManagedArea; name: string; bytes: number }[];
  purged: { area: ManagedArea; name: string; bytes: number }[];
  /** Bytes deleted for good (purged trash). Moving to the trash frees nothing until it is purged. */
  freedBytes: number;
  /** emptyTrash only: files from before project tracking this run moved, kept in the trash for the retention period. */
  keptInTrash: { area: ManagedArea; name: string; bytes: number }[];
  /** Known project files dropped from the list (unreadable past the retention period, or forgetMissing). */
  forgotProjects: string[];
  failed: { name: string; error: string }[];
  kept: { referenced: number; gracePeriod: number; predatesTracking: number };
  trashBytes: number;
  warnings: string[];
}

export interface StorageCleanupOptions {
  /** Automatic run: keeps files that predate project tracking; a job running re-arms it. */
  auto?: boolean;
  /** Afterwards delete the trash for good (except files it just moved that predate tracking). */
  emptyTrash?: boolean;
  /** First forget known project files that can't be read (the user says they are gone). */
  forgetMissing?: boolean;
}

/**
 * Owns the baked/ + proxies/ housekeeping for one engine: dry-run reports,
 * clean-up runs (serialized with restores by one lock), restore-on-load, the
 * known-projects list, and the debounced automatic runs.
 */
export class StorageJanitor {
  /** Serializes clean-ups, reports and restores (the long work). */
  private lock: Promise<unknown> = Promise.resolve();
  /** Serializes every read-modify-write of projects.json; short, so save/load never wait for a clean-up walk. */
  private indexLock: Promise<unknown> = Promise.resolve();
  /** When remember() last recorded each path (folded): a clean-up never forgets a file saved while it ran. */
  private rememberedAt = new Map<string, number>();
  /** The unreadable project files the last full run paused for (logged when it changes). */
  private lastPaused = "";
  private timer: NodeJS.Timeout | null = null;
  private lastAutoRun = 0;
  /** An automatic run was skipped because jobs were running; re-arm when they finish. */
  private deferred = false;

  constructor(
    readonly dataDir: string,
    private readonly deps: StorageDeps,
  ) {}

  private log(msg: string): void {
    (this.deps.log ?? ((m: string) => console.error(`[aive-core] storage: ${m}`)))(msg);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  private withIndex<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.indexLock.then(fn, fn);
    this.indexLock = run.catch(() => {});
    return run;
  }

  private blockedBy(): string | undefined {
    const jobs = this.deps.runningJobs();
    if (jobs.length === 0) return undefined;
    return `${jobs.length} job${jobs.length === 1 ? " is" : "s are"} running (${jobs.map((j) => j.type).join(", ")}) — clean-up waits until they finish`;
  }

  // ---- known projects ----------------------------------------------------------

  /** The list to update (call under withIndex): the current one, or a fresh one (a corrupt list is kept aside). */
  private async indexForUpdate(): Promise<{ index: KnownProjects; existed: boolean }> {
    const read = await readIndex(this.dataDir);
    if (read.state === "ok") return { index: read.index, existed: true };
    if (read.state === "corrupt") {
      // Keep the unreadable list for inspection; the fresh list's `since`
      // keeps automatic runs away from every older file.
      const bad = join(this.dataDir, `${KNOWN_PROJECTS_FILE}.corrupt-${Date.now().toString(36)}`);
      await rename(join(this.dataDir, KNOWN_PROJECTS_FILE), bad).catch(() => {});
      this.log(`known-projects list was unreadable (${read.error}); kept it as ${bad} and started a new one`);
    }
    return { index: { version: 1, since: Date.now(), projects: [] }, existed: false };
  }

  /** Record a .aive (or .otio) file whose references must keep their baked files. Never throws. */
  remember(path: string): Promise<void> {
    const abs = resolve(path);
    const key = fold(abs);
    this.rememberedAt.set(key, Date.now());
    return this.withIndex(async () => {
      try {
        const { index, existed } = await this.indexForUpdate();
        const flagged = Object.keys(index.unavailable ?? {}).some((p) => fold(resolve(p)) === key);
        const last = index.projects[index.projects.length - 1];
        if (existed && !flagged && last !== undefined && fold(resolve(last)) === key) return; // autosave: already newest
        index.projects = [...index.projects.filter((p) => fold(resolve(p)) !== key), abs];
        if (flagged) index.unavailable = withoutPaths(index.unavailable, new Set([key]));
        await writeIndex(this.dataDir, index);
      } catch (err) {
        this.log(`could not record ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  /**
   * Add existing .aive/.otio files (e.g. the UI's recent projects) to the
   * known-projects list, so automatic and explicit clean-ups keep their baked
   * files. Anything that isn't an existing .aive/.otio file is skipped, so a
   * stale entry can't pause clean-up. One list write.
   */
  rememberMany(paths: string[]): Promise<{ added: string[]; skipped: { path: string; reason: string }[]; knownProjects: number }> {
    return this.withIndex(async () => {
      const added: string[] = [];
      const skipped: { path: string; reason: string }[] = [];
      const found: string[] = [];
      for (const p of paths) {
        const abs = resolve(p);
        if (!PROJECT_FILE.test(abs)) {
          skipped.push({ path: p, reason: "not a .aive or .otio file" });
          continue;
        }
        try {
          if (!(await stat(abs)).isFile()) {
            skipped.push({ path: p, reason: "not a file" });
            continue;
          }
        } catch {
          skipped.push({ path: p, reason: "not found" });
          continue;
        }
        found.push(abs);
      }
      const { index, existed } = await this.indexForUpdate();
      const known = new Set(index.projects.map((p) => fold(resolve(p))));
      for (const abs of found) {
        const key = fold(abs);
        if (known.has(key)) continue;
        known.add(key);
        added.push(abs);
        this.rememberedAt.set(key, Date.now());
      }
      if (added.length || !existed) {
        // Older than anything saved since: the newest entry stays the open project.
        index.projects = [...added, ...index.projects];
        await writeIndex(this.dataDir, index);
      }
      return { added, skipped, knownProjects: index.projects.length };
    });
  }

  // ---- restore on load ----------------------------------------------------------

  /**
   * Move every baked/proxy file `project` names that is missing on disk back
   * out of the trash (newest trashed copy first). Returns the restored paths.
   * Call it BEFORE using the project. Never throws.
   */
  restore(project: unknown): Promise<string[]> {
    return this.exclusive(async () => {
      const restored: string[] = [];
      try {
        const refs = referencedManagedPaths(this.dataDir, [project]);
        if (refs.size === 0) return restored;
        for (const area of MANAGED_AREAS) {
          const dir = join(this.dataDir, area);
          const trashDir = join(dir, TRASH_DIR_NAME);
          const { names } = referencedNames(dir, refs);
          if (names.size === 0) continue;
          let trashNames: string[];
          try {
            const st = await lstat(trashDir);
            if (st.isSymbolicLink() || !st.isDirectory()) continue;
            trashNames = await readdir(trashDir);
          } catch {
            continue; // no trash
          }
          for (const want of names) {
            const dest = join(dir, want);
            if (await exists(dest)) continue;
            const pick = await newestTrashCopy(trashDir, trashNames, want);
            if (!pick) continue;
            // An exact match keeps its own (on-disk) spelling; a `name~N.ext` copy drops the suffix.
            const destName = fold(pick) === want ? pick : trashOriginalName(pick);
            const target = join(dir, destName);
            if (await exists(target)) continue;
            try {
              await rename(join(trashDir, pick), target);
              restored.push(target);
              trashNames = trashNames.filter((n) => n !== pick);
            } catch (err) {
              this.log(`could not restore ${destName} from the trash: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
        if (restored.length) this.log(`restored ${restored.length} file(s) from the trash for the project being opened`);
      } catch (err) {
        this.log(`restore failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return restored;
    });
  }

  // ---- plan ------------------------------------------------------------------------

  private async plan(mode: "auto" | "explicit", opts: { forgetMissing?: boolean } = {}): Promise<Plan> {
    const now = Date.now();
    const grace = STORAGE_GRACE_MS;
    const retention = trashRetentionMs();
    const areas = await Promise.all(MANAGED_AREAS.map((a) => listArea(this.dataDir, a)));
    const warnings: string[] = areas.flatMap((a) => (a.problem ? [a.problem] : []));
    const skippedLinks = areas.reduce((n, a) => n + a.skippedLinks, 0);
    if (skippedLinks) warnings.push(`${skippedLinks} symbolic link(s) in baked/ or proxies/ were left alone`);

    let index = await readIndex(this.dataDir);
    if (index.state === "missing") {
      // First run with project tracking: everything already here predates it.
      index = await this.withIndex(async (): Promise<IndexRead> => {
        const again = await readIndex(this.dataDir);
        if (again.state !== "missing") return again; // a save got there first
        const fresh: KnownProjects = { version: 1, since: now, projects: [] };
        try {
          await writeIndex(this.dataDir, fresh);
        } catch {
          /* read-only data dir: plan still works */
        }
        return { state: "ok", index: fresh };
      });
    }
    const since = index.state === "ok" ? index.index.since : now;
    if (index.state === "corrupt") {
      warnings.push(`the known-projects list ${join(this.dataDir, KNOWN_PROJECTS_FILE)} is unreadable (${index.error}) — nothing is moved to the trash until the next save replaces it`);
    }

    const base: Plan = {
      now, mode, areas, index, since,
      candidates: [], young: [], legacyKept: [], referenced: [], trash: [], expired: [], inUseTrash: [], refs: new Map(),
      knownProjects: index.state === "ok" ? index.index.projects : [],
      unavailable: [], paused: null, warnings, quick: false,
    };

    const usable = areas.filter((a) => !a.problem);
    // Cheap exit for automatic runs: the UI autosaves every few seconds, so
    // don't read every known project unless something is old enough to act on
    // (or the open project names a trashed file: a race, a second core), or a
    // project file is marked unreadable: re-read it, so a drive plugged back in
    // clears its mark (an old mark would make the next unplug forget it at once).
    if (mode === "auto") {
      let actionable = (index.state === "ok" && Object.keys(index.index.unavailable ?? {}).length > 0) || usable.some(
        (a) => a.entries.some((e) => now - e.mtimeMs >= grace && e.mtimeMs >= since) || a.trash.some((e) => now - e.mtimeMs >= retention),
      );
      if (!actionable && usable.some((a) => a.trash.length > 0)) {
        const live = referencedManagedPaths(this.dataDir, this.deps.liveProjects());
        actionable = usable.some((a) => inUseTrash(a, referencedNames(a.dir, live)).length > 0);
      }
      if (!actionable) return { ...base, quick: true };
    }

    // References on disk: autosaves, then every known project file, read in
    // parallel with a timeout (a hung network drive must not stall saves).
    const autosaveDir = join(this.dataDir, "autosave");
    let autosaveNames: string[] = [];
    try {
      autosaveNames = await readdir(autosaveDir);
    } catch {
      /* none */
    }
    const sources = [
      ...autosaveNames.map((n) => ({ path: join(autosaveDir, n), autosave: true })),
      ...base.knownProjects.map((p) => ({ path: p, autosave: false })),
    ];
    const timeoutMs = this.deps.readTimeoutMs ?? PROJECT_READ_TIMEOUT_MS;
    const reads = await Promise.all(sources.map(async (s) => ({ ...s, read: await readProjectFile(s.path, timeoutMs, s.autosave) })));
    const firstSeen = new Map(
      Object.entries(index.state === "ok" ? index.index.unavailable ?? {} : {}).map(([p, t]) => [fold(resolve(p)), t] as const),
    );
    const diskProjects: unknown[] = [];
    for (const { path, autosave, read } of reads) {
      if (read.kind === "ok") diskProjects.push(read.value);
      if (read.kind !== "missing" && read.kind !== "unreadable") continue;
      const firstMs = opts.forgetMissing ? 0 : firstSeen.get(fold(resolve(path))) ?? now;
      base.unavailable.push({ path, autosave, missing: read.kind === "missing", reason: read.error, firstMs, stale: now - firstMs >= retention });
    }
    const pausing = base.unavailable.filter((u) => !u.stale);
    const stale = base.unavailable.filter((u) => u.stale);
    const list = (us: UnavailableProject[]) =>
      us.slice(0, 3).map((u) => `${u.path} (${u.reason})`).join("; ") + (us.length > 3 ? `; and ${us.length - 3} more` : "");
    if (pausing.length) {
      const one = pausing.length === 1;
      base.paused =
        `Clean-up is paused: ${plural(pausing.length, "project file")} SynthCut knows about can't be read right now — ${list(pausing)}. ` +
        `On an unplugged drive, moved or deleted? Nothing is moved to the trash until ${one ? "it is" : "they are"} back, ` +
        `or until ${one ? "it has" : "they have"} been unreadable for ${fmtDays(retention)}. Forget ${one ? "it" : "them"} to clean up now.`;
      warnings.push(base.paused);
      // Log once per change, not on every automatic run while it lasts.
      const key = pausing.map((u) => u.path).join("\n");
      if (key !== this.lastPaused) this.log(base.paused);
      this.lastPaused = key;
    } else {
      this.lastPaused = "";
    }
    if (stale.length) {
      warnings.push(`No longer counted (unreadable for ${fmtDays(retention)} or forgotten): ${list(stale)}`);
    }

    // In-memory references last, so they are the freshest.
    const refs = referencedManagedPaths(this.dataDir, [...diskProjects, ...this.deps.liveProjects()]);
    const counted = base.knownProjects.length - base.unavailable.filter((u) => !u.autosave).length;

    for (const a of usable) {
      const r = referencedNames(a.dir, refs);
      base.refs.set(a.area, r);
      for (const e of a.entries) {
        if (r.all || r.names.has(fold(e.name))) {
          base.referenced.push(e);
          continue;
        }
        const age = now - e.mtimeMs;
        if (age < grace) {
          base.young.push(e);
          continue;
        }
        const predatesTracking = e.mtimeMs < since;
        if (mode === "auto" && predatesTracking) {
          base.legacyKept.push(e);
          continue;
        }
        const why =
          `not used by the open project, its undo history, ${counted} known project file(s) or the autosaves; ` +
          `last written ${fmtAge(age)} ago` +
          (predatesTracking ? "; made before SynthCut began tracking project files, so an older project not opened since may still use it (only an explicit clean-up moves it)" : "");
        base.candidates.push({ ...e, predatesTracking, why });
      }
      const back = inUseTrash(a, r);
      base.inUseTrash.push(...back);
      const backPaths = new Set(back.map((t) => t.path));
      for (const t of a.trash) {
        // Never delete a trashed file a project names, under its trash path or its original one.
        const inUse = backPaths.has(t.path) || r.trashNames.has(fold(t.name));
        const expired = !inUse && now - t.mtimeMs >= retention;
        base.trash.push({ ...t, expired, inUse });
        if (expired) base.expired.push(t);
      }
    }
    // Without a readable known-projects list every file looks unused, and an
    // unreadable project's references are unknown: move nothing.
    if (index.state === "corrupt" || base.paused) base.candidates = [];
    return base;
  }

  // ---- report ------------------------------------------------------------------------

  /**
   * Dry run: usage per area, what an explicit clean-up would move now (and
   * why), what it would move back, and the trash. The usage walk runs outside
   * the lock (it only reads), so saves and loads don't wait for it.
   */
  async report(): Promise<{
    dataDir: string;
    usage: Record<string, { bytes: number; size: string; files: number }>;
    totalBytes: number;
    wouldTrash: StorageCandidate[];
    wouldTrashCount: number;
    wouldTrashBytes: number;
    /** Of wouldTrash: files made before project tracking (an older project may still use them). */
    predatesTracking: { count: number; bytes: number };
    gracePeriod: { count: number; bytes: number };
    referenced: { count: number; bytes: number };
    trash: StorageTrashItem[];
    trashCount: number;
    trashBytes: number;
    expiredTrashBytes: number;
    /** Trashed files a project names again: the next clean-up moves them back. */
    inUseTrash: { count: number; bytes: number };
    /** What clean_up_storage {emptyTrash:true} would delete for good now. */
    emptyTrash: { count: number; bytes: number };
    trackingSince: string | null;
    knownProjects: number;
    /** Known project files and autosaves that can't be read; pausesCleanUp → nothing is moved to the trash. */
    unavailableProjects: { path: string; autosave: boolean; missing: boolean; reason: string; since: string; pausesCleanUp: boolean }[];
    blockedBy: string | null;
    settings: { gracePeriodMinutes: number; trashDays: number };
    warnings: string[];
  }> {
    const plan = await this.exclusive(() => this.plan("explicit"));
    const usage = await storageUsage(this.dataDir);
    const sum = (es: { bytes: number }[]) => es.reduce((n, e) => n + e.bytes, 0);
    const older = plan.candidates.filter((c) => c.predatesTracking);
    const newer = plan.candidates.filter((c) => !c.predatesTracking);
    const inUse = plan.trash.filter((t) => t.inUse);
    const deletable = plan.trash.filter((t) => !t.inUse);
    return {
      dataDir: this.dataDir,
      usage: Object.fromEntries(
        Object.entries(usage.areas).map(([k, v]) => [k, { bytes: v.bytes, size: fmtBytes(v.bytes), files: v.files }]),
      ),
      totalBytes: usage.totalBytes,
      wouldTrash: plan.candidates.slice(0, REPORT_LIST_MAX).map((c) => ({
        area: c.area, name: c.name, path: c.path, bytes: c.bytes, size: fmtBytes(c.bytes), isDir: c.isDir,
        modifiedAt: new Date(c.mtimeMs).toISOString(), predatesTracking: c.predatesTracking, why: c.why,
      })),
      wouldTrashCount: plan.candidates.length,
      wouldTrashBytes: sum(plan.candidates),
      predatesTracking: { count: older.length, bytes: sum(older) },
      gracePeriod: { count: plan.young.length, bytes: sum(plan.young) },
      referenced: { count: plan.referenced.length, bytes: sum(plan.referenced) },
      trash: plan.trash.slice(0, REPORT_LIST_MAX).map((t) => ({
        area: t.area, name: t.name, path: t.path, bytes: t.bytes, size: fmtBytes(t.bytes), isDir: t.isDir,
        trashedAt: new Date(t.mtimeMs).toISOString(), age: fmtAge(plan.now - t.mtimeMs), expired: t.expired, inUse: t.inUse,
      })),
      trashCount: plan.trash.length,
      trashBytes: sum(plan.trash),
      expiredTrashBytes: sum(plan.expired),
      inUseTrash: { count: inUse.length, bytes: sum(inUse) },
      emptyTrash: { count: deletable.length + newer.length, bytes: sum(deletable) + sum(newer) },
      trackingSince: plan.index.state === "ok" ? new Date(plan.since).toISOString() : null,
      knownProjects: plan.knownProjects.length - plan.unavailable.filter((u) => !u.autosave).length,
      unavailableProjects: plan.unavailable.map((u) => ({
        path: u.path, autosave: u.autosave, missing: u.missing, reason: u.reason,
        since: new Date(u.firstMs).toISOString(), pausesCleanUp: !u.stale,
      })),
      blockedBy: this.blockedBy() ?? null,
      settings: { gracePeriodMinutes: Math.round(STORAGE_GRACE_MS / 60_000), trashDays: trashRetentionMs() / DAY_MS },
      warnings: plan.warnings,
    };
  }

  // ---- clean-up ------------------------------------------------------------------------

  /**
   * Move trashed files a project names again back, move unused baked/proxy
   * files to the trash and delete expired trash. `auto` runs keep files that
   * predate project tracking; `emptyTrash` afterwards deletes the trash for
   * good (but not a file a project names, nor a pre-tracking file this run
   * moved); `forgetMissing` first forgets unreadable known projects. Never throws.
   */
  cleanUp(opts: StorageCleanupOptions = {}): Promise<StorageCleanupResult> {
    return this.exclusive(() => this.cleanUpLocked(opts));
  }

  private async cleanUpLocked(opts: StorageCleanupOptions): Promise<StorageCleanupResult> {
    const result: StorageCleanupResult = {
      moved: [], movedBytes: 0, restored: [], purged: [], freedBytes: 0, keptInTrash: [], forgotProjects: [], failed: [],
      kept: { referenced: 0, gracePeriod: 0, predatesTracking: 0 }, trashBytes: 0, warnings: [],
    };
    try {
      const busy = this.blockedBy();
      if (busy) {
        if (opts.auto) this.deferred = true;
        return { ...result, skipped: busy };
      }
      const plan = await this.plan(opts.auto ? "auto" : "explicit", { forgetMissing: opts.forgetMissing });
      result.warnings = plan.warnings;
      result.kept = { referenced: plan.referenced.length, gracePeriod: plan.young.length, predatesTracking: plan.legacyKept.length };

      // A job may have started while project files were read.
      const late = this.blockedBy();
      if (late) {
        if (opts.auto) this.deferred = true;
        return { ...result, skipped: late };
      }

      // Trashed files a project names again go back first (a second core, a race).
      for (const t of plan.inUseTrash) {
        const target = join(dirname(dirname(t.path)), t.destName);
        if (await exists(target)) continue;
        try {
          await rename(t.path, target);
          result.restored.push({ area: t.area, name: t.destName, bytes: t.bytes });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            result.failed.push({ name: `${t.area}/${TRASH_DIR_NAME}/${t.name}`, error: err instanceof Error ? err.message : String(err) });
          }
        }
      }

      // Pre-tracking files Empty trash moves stay in the trash for the retention period.
      const keep = new Set<string>();
      if (plan.index.state === "ok") {
        for (const c of plan.candidates) {
          const r = await moveToTrash(c);
          if (r && typeof r === "object") {
            result.moved.push({ area: c.area, name: c.name, bytes: c.bytes });
            result.movedBytes += c.bytes;
            if (opts.emptyTrash && c.predatesTracking) {
              keep.add(r.target);
              result.keptInTrash.push({ area: c.area, name: c.name, bytes: c.bytes });
            }
          } else if (r) result.failed.push({ name: `${c.area}/${c.name}`, error: r });
        }
      }

      const purge = async (e: Entry) => {
        try {
          const st = await lstat(e.path);
          if (st.isSymbolicLink()) return;
          await rm(e.path, { recursive: true, force: true });
          result.purged.push({ area: e.area, name: e.name, bytes: e.bytes });
          result.freedBytes += e.bytes;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            result.failed.push({ name: `${e.area}/${TRASH_DIR_NAME}/${e.name}`, error: err instanceof Error ? err.message : String(err) });
          }
        }
      };
      if (opts.emptyTrash) {
        for (const area of MANAGED_AREAS) {
          const a = await listArea(this.dataDir, area);
          const r = plan.refs.get(area);
          if (a.problem || !r) continue;
          // Still named by a project (its move back failed): never deleted.
          const inUse = new Set(inUseTrash(a, r).map((t) => t.path));
          for (const t of a.trash) {
            if (keep.has(t.path) || inUse.has(t.path) || r.trashNames.has(fold(t.name))) continue;
            await purge(t);
          }
        }
      } else {
        for (const e of plan.expired) await purge(e);
      }

      // Record which project files can't be read (and since when); forget the
      // ones unreadable for longer than the retention period.
      if (plan.index.state === "ok" && !plan.quick) result.forgotProjects = await this.updateUnavailable(plan);

      for (const area of MANAGED_AREAS) {
        const a = await listArea(this.dataDir, area);
        result.trashBytes += a.trash.reduce((n, t) => n + t.bytes, 0);
      }
      if (result.moved.length || result.purged.length || result.restored.length) {
        this.log(
          `moved ${result.moved.length} unused file(s) (${fmtBytes(result.movedBytes)}) to the trash; ` +
            `deleted ${result.purged.length} trashed file(s) (${fmtBytes(result.freedBytes)})` +
            (result.restored.length ? `; moved ${result.restored.length} file(s) a project names back out of the trash` : ""),
        );
      }
    } catch (err) {
      result.warnings.push(`clean-up stopped: ${err instanceof Error ? err.message : String(err)}`);
    }
    return result;
  }

  /** Rewrite projects.json's `unavailable` map from this run's reads; returns the project files it forgot. */
  private updateUnavailable(plan: Plan): Promise<string[]> {
    return this.withIndex(async () => {
      const fresh = await readIndex(this.dataDir);
      if (fresh.state !== "ok") return [];
      const index = fresh.index;
      // A file saved or opened while this run read the disk is readable now.
      const touched = (p: string) => (this.rememberedAt.get(fold(resolve(p))) ?? 0) >= plan.now;
      const forget = new Set(plan.unavailable.filter((u) => u.stale && !u.autosave && !touched(u.path)).map((u) => fold(resolve(u.path))));
      const unavailable: Record<string, number> = {};
      for (const u of plan.unavailable) {
        if (!forget.has(fold(resolve(u.path))) && !touched(u.path)) unavailable[u.path] = u.firstMs;
      }
      const forgot = index.projects.filter((p) => forget.has(fold(resolve(p))));
      const next: KnownProjects = {
        version: 1, since: index.since,
        projects: index.projects.filter((p) => !forget.has(fold(resolve(p)))),
        ...(Object.keys(unavailable).length ? { unavailable } : {}),
      };
      if (!forgot.length && JSON.stringify(next.unavailable ?? {}) === JSON.stringify(index.unavailable ?? {})) return [];
      try {
        await writeIndex(this.dataDir, next);
      } catch {
        return [];
      }
      if (forgot.length) this.log(`forgot ${forgot.length} project file(s) that could not be read: ${forgot.join(", ")}`);
      return forgot;
    });
  }

  // ---- automatic runs ------------------------------------------------------------------

  /** Debounced, throttled background clean-up (after save / load / new / a bake). Never blocks the caller. */
  schedule(): void {
    const delay = autoDelayMs();
    if (delay < 0 || this.timer) return;
    const wait = Math.max(delay, this.lastAutoRun + AUTO_MIN_INTERVAL_MS - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.lastAutoRun = Date.now();
      this.deferred = false;
      void this.cleanUp({ auto: true }).catch(() => {});
    }, wait);
    this.timer.unref?.();
  }

  /** Feed job events: a finished bake (or the last job ending after a deferred run) schedules a clean-up. */
  onJob(job: { type: string; status: string }): void {
    if (job.status === "running") return;
    const bake = ["matte", "stabilize", "reframe", "reverse", "slowmo", "proxy", "graphic"].includes(job.type);
    if (bake || (this.deferred && this.deps.runningJobs().length === 0)) this.schedule();
  }
}

// ---- helpers -------------------------------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** `name~3.ext` → `name.ext` (the suffix added on a trash name collision). */
function trashOriginalName(trashName: string): string {
  const ext = extname(trashName);
  const stem = trashName.slice(0, trashName.length - ext.length);
  const m = /^(.*)~\d+$/.exec(stem);
  return m ? m[1] + ext : trashName;
}

/** `map` without the paths whose folded, resolved form is in `keys` (undefined when nothing is left). */
function withoutPaths(map: Record<string, number> | undefined, keys: Set<string>): Record<string, number> | undefined {
  const out = Object.fromEntries(Object.entries(map ?? {}).filter(([p]) => !keys.has(fold(resolve(p)))));
  return Object.keys(out).length ? out : undefined;
}

/**
 * Trash entries of `a` whose original name `r` names while nothing is at that
 * name: the newest copy of each, with the name it goes back to (the same rule
 * as restore(); when the name is taken again, the trash copy is superseded).
 */
function inUseTrash(a: AreaListing, r: RefNames): InUseTrash[] {
  if (!a.trash.length || !r.names.size) return [];
  const present = new Set(a.entries.map((e) => fold(e.name)));
  const best = new Map<string, Entry>();
  for (const t of a.trash) {
    for (const want of new Set([fold(trashOriginalName(t.name)), fold(t.name)])) {
      if (!r.names.has(want) || present.has(want)) continue;
      const b = best.get(want);
      if (!b || t.mtimeMs > b.mtimeMs) best.set(want, t);
    }
  }
  const out: InUseTrash[] = [];
  const taken = new Set<string>();
  for (const [want, t] of best) {
    if (taken.has(t.path)) continue;
    taken.add(t.path);
    out.push({ ...t, destName: fold(t.name) === want ? t.name : trashOriginalName(t.name) });
  }
  return out;
}

type ProjectRead =
  | { kind: "ok"; value: unknown }
  | { kind: "skip" }
  | { kind: "missing" | "unreadable"; error: string };

/**
 * Read one project file as JSON, giving up after `timeoutMs` (a hung network
 * drive; the read itself can't be cancelled and is left to finish). An
 * autosave-dir entry that isn't a plain file, or vanished, is skipped.
 */
async function readProjectFile(path: string, timeoutMs: number, autosave: boolean): Promise<ProjectRead> {
  const work = (async (): Promise<ProjectRead> => {
    try {
      if (autosave && !(await lstat(path)).isFile()) return { kind: "skip" };
      return { kind: "ok", value: JSON.parse(await readFile(path, "utf8")) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return autosave ? { kind: "skip" } : { kind: "missing", error: "not found" };
      return { kind: "unreadable", error: err instanceof Error ? err.message : String(err) };
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ProjectRead>((res) => {
    timer = setTimeout(() => res({ kind: "unreadable", error: `no answer after ${Math.max(1, Math.round(timeoutMs / 1000))} s` }), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The most recently trashed copy of `want` (case-folded on Windows) in `trashNames`. */
async function newestTrashCopy(trashDir: string, trashNames: string[], want: string): Promise<string | undefined> {
  let best: { name: string; t: number } | undefined;
  for (const n of trashNames) {
    if (fold(trashOriginalName(n)) !== want && fold(n) !== want) continue;
    try {
      const st = await lstat(join(trashDir, n));
      if (st.isSymbolicLink()) continue;
      if (!best || st.mtimeMs > best.t) best = { name: n, t: st.mtimeMs };
    } catch {
      /* raced */
    }
  }
  return best?.name;
}

/** Rename one entry into its area's .trash/ and stamp the trash time. Its trash path, an error string, or null when skipped. */
async function moveToTrash(e: Entry): Promise<{ target: string } | string | null> {
  try {
    const st = await lstat(e.path);
    if (st.isSymbolicLink()) return null;
    // Written to since the plan (a re-bake reusing the name): leave it for a later run.
    if (!st.isDirectory() && st.mtimeMs > e.mtimeMs) return null;
  } catch {
    return null; // already gone
  }
  const dir = dirname(e.path);
  const trashDir = join(dir, TRASH_DIR_NAME);
  try {
    await mkdir(trashDir, { recursive: true });
    const tst = await lstat(trashDir);
    if (tst.isSymbolicLink() || !tst.isDirectory()) return `${TRASH_DIR_NAME} is not a plain directory`;
    const ext = extname(e.name);
    const stem = e.name.slice(0, e.name.length - ext.length);
    let target = join(trashDir, e.name);
    for (let i = 1; await exists(target); i++) target = join(trashDir, `${stem}~${i}${ext}`);
    await rename(e.path, target);
    const now = new Date();
    try {
      const st = await lstat(target);
      await utimes(target, st.atime, now);
    } catch (err) {
      // Without a trash time the next run could delete it at once: put it back.
      await rename(target, e.path).catch(() => {});
      return `could not stamp the trash time: ${err instanceof Error ? err.message : String(err)}`;
    }
    return { target };
  } catch (err) {
    return err instanceof Error ? err.message : String(err); // e.g. file in use on Windows
  }
}

// ---- usage -----------------------------------------------------------------------------------

const USAGE_AREAS = ["baked", "proxies", "trash", "cache", "previews", "frames", "masks", "other"] as const;

/** Bytes and file counts per data-dir area (symlinks are not followed). */
export async function storageUsage(dataDir: string): Promise<{
  areas: Record<(typeof USAGE_AREAS)[number], { bytes: number; files: number }>;
  totalBytes: number;
}> {
  const areas = Object.fromEntries(USAGE_AREAS.map((a) => [a, { bytes: 0, files: 0 }])) as Record<
    (typeof USAGE_AREAS)[number],
    { bytes: number; files: number }
  >;
  const walk = async (p: string, bucket: (typeof USAGE_AREAS)[number]): Promise<void> => {
    let st;
    try {
      st = await lstat(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isFile()) {
      areas[bucket].bytes += st.size;
      areas[bucket].files += 1;
      return;
    }
    if (!st.isDirectory()) return;
    let names: string[] = [];
    try {
      names = await readdir(p);
    } catch {
      return;
    }
    for (const n of names) await walk(join(p, n), bucket);
  };
  let top: string[] = [];
  try {
    top = await readdir(dataDir);
  } catch {
    /* empty data dir */
  }
  for (const name of top) {
    const p = join(dataDir, name);
    if (name === "baked" || name === "proxies") {
      let inner: string[] = [];
      try {
        const st = await lstat(p);
        if (st.isSymbolicLink() || !st.isDirectory()) continue;
        inner = await readdir(p);
      } catch {
        continue;
      }
      for (const n of inner) await walk(join(p, n), n === TRASH_DIR_NAME ? "trash" : name);
    } else if (name === "cache" || name === "previews" || name === "frames" || name === "masks") {
      await walk(p, name);
    } else {
      await walk(p, "other");
    }
  }
  const totalBytes = Object.values(areas).reduce((n, a) => n + a.bytes, 0);
  return { areas, totalBytes };
}
