/**
 * Storage clean-up for baked/ + proxies/ (storage.ts): auto-trash, never
 * auto-delete a file that looks referenced, restore on load.
 *  1. Files referenced by the open project, only by its undo history, only by a
 *     saved .aive OUTSIDE the data dir (recorded by save()), only by an autosave,
 *     or only inside a longer string survive; old orphans (a file, a stale
 *     `.work` dir, an orphan proxy) go to <area>/.trash/; a young orphan stays;
 *     a file outside the data dir, a sibling `baked2/` dir and a symlink are
 *     never touched.
 *  2. storage_report's dry-run list == what clean_up_storage then moves.
 *  3. Automatic runs leave files older than the known-projects list alone
 *     (they may belong to a project saved before tracking); explicit runs move
 *     them, and the report counts them (predatesTracking).
 *  4. Nothing happens while a job runs.
 *  5. A deleted known project pauses clean-up (it may be on an unplugged
 *     drive); once it has been missing for the retention period it is
 *     forgotten; load() of a copy moves its trashed files back first.
 *  6. Trash older than AIVE_BAKED_TRASH_DAYS is deleted; emptyTrash deletes all.
 *  7. A corrupt projects.json moves nothing; save() starts a fresh list.
 *  8. A symlinked managed dir is left alone; a debounced automatic run fires.
 *  9. A known project that is missing (unplugged), unreadable (no permission,
 *     half-written) or hangs pauses clean-up and nothing it names is lost;
 *     reading it again resumes; forgetMissing forgets it; an unreadable
 *     autosave pauses until the retention period; a hung read doesn't hold up
 *     save() (remember).
 * 10. A trashed file a project names again is moved back by the next clean-up
 *     and never deleted (expiry, emptyTrash).
 * 11. emptyTrash keeps the pre-tracking files it just moved in the trash;
 *     remember_projects (the UI's recent projects) keeps their bakes.
 * 12. References as percent-encoded file: URLs (an .otio target_url under a
 *     data dir with a space) and relative paths (a relative AIVE_DATA_DIR).
 * 13. A trashed file keeps its own mtime (render-cache keys) and gets it back
 *     on restore; the trash time lives in .trash/.index.json; an entry with no
 *     record counts as trashed when first seen (never expired at once).
 * 14. An unreadable known project is logged once per file state, not on every
 *     run or core start; a changed file is logged again.
 * 15. Two cores on one data dir: neither trashes a file only the other's undo
 *     history uses (run files in <dataDir>/run/); a dead core's file (killed
 *     child process) and a stale one stop counting; dispose removes its file.
 * 16. Library bakes: a bake no clip uses stays while undo can bring its clip
 *     back, leaves the library at the next clean-up once no state uses it
 *     (project stays clean), imported media never; remove_unused_media
 *     dry run / generated only / includeImported / undo; storage_report
 *     libraryBakes; a used reversed bake keeps its original.
 *
 * Run: npx tsx packages/core/scripts/smoke-storage.ts
 * (No downloads; synthesizes a tiny clip with ffmpeg; temp dirs only.)
 */
import {
  chmodSync, closeSync, constants as fsc, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync, lutimesSync, rmSync,
} from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EditorEngine } from "../src/engine.js";
import { methods } from "../src/rpc.js";
import { runFfmpeg } from "../src/ffmpeg/executor.js";
import { RUN_REAP_MS, RUN_STALE_MS, StorageJanitor, referencedManagedPaths } from "../src/storage.js";

// Automatic runs off unless a section turns them on (a timer firing between
// storage_report and clean_up_storage would break the dry-run comparison).
process.env.AIVE_STORAGE_GC_DELAY_MS = "-1";
delete process.env.AIVE_BAKED_TRASH_DAYS;

const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** `p`, or `timedOut` after `ms` (a ref'd timer: keeps the process alive while the janitor's unref'd timer is pending). */
function within<T, U>(p: Promise<T>, ms: number, timedOut: U): Promise<T | U> {
  let t!: NodeJS.Timeout;
  return Promise.race([p, new Promise<U>((r) => { t = setTimeout(() => r(timedOut), ms); })]).finally(() => clearTimeout(t));
}

/** Pretend `name` in `areaDir`/.trash was trashed `ms` ago (the trash index holds trash times). */
function setTrashedAt(areaDir: string, name: string, ms: number) {
  const idx = join(areaDir, ".trash", ".index.json");
  let j: { version: 1; trashedAt: Record<string, number> } = { version: 1, trashedAt: {} };
  try {
    j = JSON.parse(readFileSync(idx, "utf8"));
  } catch {
    /* none yet */
  }
  j.trashedAt[name] = Date.now() - ms;
  writeFileSync(idx, JSON.stringify(j));
}

let failures = 0;
function check(ok: boolean, msg: string, detail?: unknown) {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}${!ok && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

function backdate(path: string, ms: number) {
  const t = new Date(Date.now() - ms);
  utimesSync(path, t, t);
}

function caller(engine: EditorEngine) {
  return async <T = unknown>(name: keyof typeof methods, params: Record<string, unknown> = {}): Promise<T> => {
    const m = methods[name];
    const parsed = (m.schema as { parse: (x: unknown) => unknown }).parse(params);
    return (await m.handler(engine, parsed as never)) as T;
  };
}

type Report = {
  usage: Record<string, { bytes: number }>;
  wouldTrash: { area: string; name: string; predatesTracking: boolean; why: string }[];
  wouldTrashBytes: number;
  predatesTracking: { count: number; bytes: number };
  gracePeriod: { count: number };
  trash: { area: string; name: string; expired: boolean; inUse: boolean }[];
  trashBytes: number;
  inUseTrash: { count: number };
  emptyTrash: { count: number; bytes: number };
  unavailableProjects: { path: string; missing: boolean; autosave: boolean; pausesCleanUp: boolean }[];
  blockedBy: string | null;
  warnings: string[];
};
type Cleanup = {
  skipped?: string;
  moved: { area: string; name: string; bytes: number }[];
  restored: { area: string; name: string }[];
  purged: { area: string; name: string }[];
  freedBytes: number;
  keptInTrash: { area: string; name: string }[];
  forgotProjects: string[];
  failed: unknown[];
  kept: { referenced: number; gracePeriod: number; predatesTracking: number };
  warnings: string[];
};
type Index = { since: number; projects: string[]; unavailable?: Record<string, number> };
const readIdx = (dd: string) => JSON.parse(readFileSync(join(dd, "projects.json"), "utf8")) as Index;
const writeIdx = (dd: string, idx: Index) => writeFileSync(join(dd, "projects.json"), JSON.stringify(idx));

const key = (e: { area: string; name: string }) => `${e.area}/${e.name}`;
const sorted = (xs: string[]) => [...xs].sort();

async function main() {
  const root = mkdtempSync(join(tmpdir(), "zabsreel-storage-"));
  const dataDir = join(root, "data");
  const outside = join(root, "outside");
  const baked = join(dataDir, "baked");
  const proxies = join(dataDir, "proxies");
  mkdirSync(baked, { recursive: true });
  mkdirSync(proxies, { recursive: true });
  mkdirSync(join(dataDir, "autosave"), { recursive: true });
  mkdirSync(outside, { recursive: true });

  console.log("0. synthesize a tiny clip...");
  const clip = join(outside, "tiny.mp4");
  await runFfmpeg([
    "-hide_banner", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=30:duration=0.5",
    "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-y", clip,
  ]);
  const put = (dir: string, name: string) => {
    const p = join(dir, name);
    copyFileSync(clip, p);
    return p;
  };

  const engine = new EditorEngine(dataDir);
  const call = caller(engine);

  console.log("1. build references...");
  // Only a saved project OUTSIDE the data dir references saved-only.mp4.
  const savedOnly = put(baked, "saved-only.mp4");
  const a1 = await call<{ asset: { id: string } }>("import_video", { path: savedOnly });
  await call("append_clip", { assetId: a1.asset.id });
  const projA = join(outside, "projects", "a.aive");
  await call("save_project", { path: projA });
  await call("new_project");

  // The open project: an asset in baked/, its proxy, and a LUT-like path embedded in a longer string.
  const live = put(baked, "live.mp4");
  const a2 = await call<{ asset: { id: string } }>("import_video", { path: live });
  await call("append_clip", { assetId: a2.asset.id });
  const proxied = await call<{ asset: { proxyPath: string } }>("generate_proxy", { assetId: a2.asset.id });
  const liveProxy = proxied.asset.proxyPath;
  check(liveProxy.startsWith(proxies), "generate_proxy wrote into proxies/");
  const embedded = join(baked, "grade.cube");
  writeFileSync(embedded, "LUT_3D_SIZE 2\n");
  await call("set_markers", { frames: [{ frame: 0, name: "grade", note: `lut3d=file=${embedded}:interp=tetrahedral` }] });
  // Only the undo history references undo-only.mp4.
  const undoOnly = put(baked, "undo-only.mp4");
  const a3 = await call<{ asset: { id: string } }>("import_video", { path: undoOnly });
  await call("remove_asset", { assetId: a3.asset.id });
  // Only an autosave references autosave-only.png.
  const autosaveOnly = join(baked, "autosave-only.png");
  copyFileSync(clip, autosaveOnly);
  writeFileSync(join(dataDir, "autosave", "Recovered-test.aive"), JSON.stringify({ tracks: [], assets: [{ id: "x", path: autosaveOnly }] }));

  // Orphans and things that must never move.
  const orphan = put(baked, "orphan-old.mkv");
  const young = put(baked, "orphan-young.mp4");
  const work = join(baked, "clip_x-rev-abc.work");
  mkdirSync(work);
  writeFileSync(join(work, "chunk-0.mkv"), "partial");
  const orphanProxy = put(proxies, "asset_gone.mp4");
  const outsideFile = put(outside, "downloads-video.mp4");
  const sibling = join(dataDir, "baked2");
  mkdirSync(sibling);
  const siblingFile = put(sibling, "old.mp4");
  const linkTarget = put(outside, "link-target.mp4");
  const link = join(baked, "link.mp4");
  symlinkSync(linkTarget, link);

  for (const p of [savedOnly, live, liveProxy, embedded, undoOnly, autosaveOnly, orphan, orphanProxy, outsideFile, siblingFile, linkTarget, join(work, "chunk-0.mkv"), work]) {
    backdate(p, 2 * DAY);
  }
  const old = new Date(Date.now() - 2 * DAY);
  lutimesSync(link, old, old);
  const outsideMtime = statSync(outsideFile).mtimeMs;

  console.log("2. automatic run: files older than the known-projects list stay...");
  const auto1 = await engine.storage.cleanUp({ auto: true });
  check(auto1.moved.length === 0, "automatic run moved nothing that predates project tracking", auto1.moved.map(key));
  check(existsSync(orphan), "old orphan still in baked/");

  console.log("3. dry run vs explicit clean-up...");
  const report = await call<Report>("storage_report");
  const expected = sorted(["baked/orphan-old.mkv", "baked/clip_x-rev-abc.work", "proxies/asset_gone.mp4"]);
  check(JSON.stringify(sorted(report.wouldTrash.map(key))) === JSON.stringify(expected), "storage_report lists exactly the old orphans", report.wouldTrash.map(key));
  check(report.wouldTrash.every((c) => c.predatesTracking && c.why.length > 0), "each candidate says why (and that it predates tracking)");
  check(report.predatesTracking.count === 3 && report.predatesTracking.bytes === report.wouldTrashBytes, "the report counts the pre-tracking files", report.predatesTracking);
  check(report.unavailableProjects.length === 0, "every known project is readable", report.unavailableProjects);
  check(report.gracePeriod.count === 1, "the young orphan is in the grace period", report.gracePeriod);
  check(report.usage.baked.bytes > 0 && report.usage.proxies.bytes > 0, "usage counts baked/ and proxies/");
  check(report.blockedBy === null, "nothing blocks the clean-up");
  check(report.warnings.some((w) => w.includes("symbolic link")), "the symlink is reported as left alone", report.warnings);

  const cleaned = await call<Cleanup>("clean_up_storage");
  check(JSON.stringify(sorted(cleaned.moved.map(key))) === JSON.stringify(sorted(report.wouldTrash.map(key))), "clean_up_storage moved exactly the dry-run list", cleaned.moved.map(key));
  check(cleaned.failed.length === 0 && !cleaned.skipped, "no failures", cleaned);
  for (const [p, what] of [
    [live, "open project's asset"], [liveProxy, "open project's proxy"], [embedded, "path inside a longer string"],
    [undoOnly, "undo-only asset"], [savedOnly, "saved-project-only asset"], [autosaveOnly, "autosave-only file"],
    [young, "young orphan"],
  ] as const) {
    check(existsSync(p), `${what} survives`);
  }
  check(!existsSync(orphan) && existsSync(join(baked, ".trash", "orphan-old.mkv")), "old orphan → baked/.trash/");
  check(!existsSync(work) && existsSync(join(baked, ".trash", "clip_x-rev-abc.work", "chunk-0.mkv")), "stale .work dir → baked/.trash/ (whole)");
  check(!existsSync(orphanProxy) && existsSync(join(proxies, ".trash", "asset_gone.mp4")), "orphan proxy → proxies/.trash/");
  check(lstatSync(link).isSymbolicLink() && existsSync(linkTarget), "symlink left in place, target untouched");
  check(existsSync(outsideFile) && statSync(outsideFile).mtimeMs === outsideMtime, "file outside the data dir untouched");
  check(existsSync(siblingFile), "sibling baked2/ dir untouched (no bare-prefix match)");
  const after = await call<Report>("storage_report");
  const trashedItem = (after as unknown as { trash: { name: string; trashedAt: string }[] }).trash.find((t) => t.name === "orphan-old.mkv");
  check(!!trashedItem && Date.now() - Date.parse(trashedItem.trashedAt) < 60_000, "trash time recorded for the moved file", trashedItem);
  check(Math.abs(statSync(join(baked, ".trash", "orphan-old.mkv")).mtimeMs - (Date.now() - 2 * DAY)) < 60_000, "…and the file keeps its own mtime");
  check(after.wouldTrash.length === 0, "nothing left to move");
  check(after.trash.length === 3 && after.trashBytes > 0 && after.usage.trash.bytes > 0, "report lists the trash", after.trash.map(key));

  console.log("4. automatic run once files are newer than the known-projects list...");
  const indexPath = join(dataDir, "projects.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as { since: number; projects: string[] };
  check(index.projects.includes(projA), "save() recorded the project file", index.projects);
  index.since = Date.now() - 10 * DAY;
  writeFileSync(indexPath, JSON.stringify(index));
  const orphan2 = put(baked, "orphan-2.mp4");
  backdate(orphan2, 2 * DAY);
  const auto2 = await engine.storage.cleanUp({ auto: true });
  check(JSON.stringify(auto2.moved.map(key)) === JSON.stringify(["baked/orphan-2.mp4"]), "automatic run trashes a tracked-era orphan", auto2.moved.map(key));

  console.log("5. a running job pauses clean-up...");
  const orphan3 = put(baked, "orphan-3.mp4");
  backdate(orphan3, 2 * DAY);
  let release!: () => void;
  const held = engine.jobs.start("proxy", "hold", () => new Promise<void>((r) => { release = r; }));
  const busyReport = await call<Report>("storage_report");
  check(!!busyReport.blockedBy, "storage_report shows blockedBy while a job runs", busyReport.blockedBy);
  const busy = await call<Cleanup>("clean_up_storage", { emptyTrash: true });
  check(!!busy.skipped && busy.moved.length === 0 && busy.purged.length === 0, "clean_up_storage is skipped while a job runs", busy);
  check(existsSync(orphan3) && existsSync(join(baked, ".trash", "orphan-old.mkv")), "nothing moved or deleted");
  release();
  await held.promise;
  const resumed = await call<Cleanup>("clean_up_storage");
  check(resumed.moved.some((m) => m.name === "orphan-3.mp4"), "runs again once the job ends");

  console.log("6. load() of a copied project restores its trashed files first...");
  await call("new_project");
  const restoreMe = put(baked, "restore-me.mp4");
  const a4 = await call<{ asset: { id: string } }>("import_video", { path: restoreMe });
  await call("append_clip", { assetId: a4.asset.id });
  const projB = join(outside, "projects", "b.aive");
  await call("save_project", { path: projB });
  await call("new_project");
  const copied = join(outside, "elsewhere", "b-copy.aive");
  mkdirSync(join(outside, "elsewhere"), { recursive: true });
  copyFileSync(projB, copied);
  rmSync(projB); // the original is gone (deleted, or on an unplugged drive); only an unknown copy remains
  backdate(restoreMe, 2 * DAY);
  const restoreMeMtime = Math.round(statSync(restoreMe).mtimeMs);
  const paused6 = await call<Cleanup>("clean_up_storage");
  check(paused6.moved.length === 0 && existsSync(restoreMe), "a missing known project pauses clean-up: nothing moved", paused6.moved.map(key));
  check(paused6.warnings.some((w) => w.includes("b.aive") && w.includes("paused")), "…and the warning names the file", paused6.warnings);
  const idx6a = readIdx(dataDir);
  check(idx6a.projects.includes(projB) && typeof idx6a.unavailable?.[projB] === "number", "it stays known; projects.json records since when it is missing", idx6a);
  // Fast-forward: missing for longer than the trash retention.
  writeIdx(dataDir, { ...idx6a, unavailable: { [projB]: Date.now() - 8 * DAY } });
  const r6 = await call<Cleanup>("clean_up_storage");
  check(r6.forgotProjects.includes(projB), "after the retention period it is forgotten", r6.forgotProjects);
  check(r6.moved.some((m) => m.name === "restore-me.mp4") && !existsSync(restoreMe), "file of the deleted project → trash", r6.moved.map(key));
  const idx6 = readIdx(dataDir);
  check(!idx6.projects.includes(projB) && !idx6.unavailable, "a project file that no longer exists is dropped from the list", idx6);
  const loaded = await call<{ project: { assets: { path: string }[] }; restoredFromTrash?: string[] }>("load_project", { path: copied });
  check(existsSync(restoreMe) && !existsSync(join(baked, ".trash", "restore-me.mp4")), "load_project moved it back out of the trash");
  check(Math.round(statSync(restoreMe).mtimeMs) === restoreMeMtime, "…with its original mtime (the segment cache key)", [statSync(restoreMe).mtimeMs, restoreMeMtime]);
  check(loaded.project.assets.every((a) => existsSync(a.path)), "every asset of the loaded project exists on disk");
  check((loaded.restoredFromTrash ?? []).length === 1, "load_project reports restoredFromTrash", loaded.restoredFromTrash);
  const idx6b = JSON.parse(readFileSync(indexPath, "utf8")) as { projects: string[] };
  check(idx6b.projects.includes(copied), "load() recorded the copy as a known project");
  const otio = join(outside, "handoff", "edit.otio");
  await call("export_otio", { path: otio });
  const idx6c = JSON.parse(readFileSync(indexPath, "utf8")) as { projects: string[] };
  check(idx6c.projects.includes(otio), "export_otio recorded the .otio (another NLE may use the bakes)");
  // An .otio handoff whose bake was cleaned into the trash: import_otio must bring it back
  // BEFORE probing, or the bake imports as an offline placeholder.
  await call("new_project");
  mkdirSync(join(baked, ".trash"), { recursive: true });
  renameSync(restoreMe, join(baked, ".trash", "restore-me.mp4"));
  const imp6 = await call<{ project: { assets: { path: string; missing?: boolean }[] }; missing?: string[] }>("import_otio", { path: otio });
  check(existsSync(restoreMe), "import_otio moved the handed-off bake back out of the trash");
  check(imp6.project.assets.every((a) => !a.missing) && (imp6.missing ?? []).length === 0, "…before probing it: it imports as media, not an offline placeholder", imp6.missing);

  console.log("7. trash retention and emptyTrash...");
  setTrashedAt(baked, "orphan-old.mkv", 8 * DAY);
  setTrashedAt(proxies, "asset_gone.mp4", 1 * DAY);
  const r7 = await call<Cleanup>("clean_up_storage");
  check(r7.purged.map(key).join() === "baked/orphan-old.mkv" && r7.freedBytes > 0, "trash older than 7 days deleted", r7.purged.map(key));
  check(existsSync(join(proxies, ".trash", "asset_gone.mp4")), "1-day-old trash kept");
  process.env.AIVE_BAKED_TRASH_DAYS = "0.5";
  const r7b = await call<Cleanup>("clean_up_storage");
  check(r7b.purged.some((p) => p.name === "asset_gone.mp4"), "AIVE_BAKED_TRASH_DAYS shortens the retention", r7b.purged.map(key));
  delete process.env.AIVE_BAKED_TRASH_DAYS;
  const orphan4 = put(baked, "orphan-4.mp4");
  backdate(orphan4, 2 * DAY);
  const r7c = await call<Cleanup>("clean_up_storage", { emptyTrash: true });
  check(r7c.moved.some((m) => m.name === "orphan-4.mp4"), "emptyTrash first moves the unused files");
  const leftInTrash = [baked, proxies].flatMap((d) => (existsSync(join(d, ".trash")) ? readdirSync(join(d, ".trash")).filter((n) => n !== ".index.json") : []));
  check(leftInTrash.length === 0, "emptyTrash leaves the trash empty", leftInTrash);
  check(existsSync(restoreMe) && existsSync(live) && existsSync(savedOnly) && existsSync(young), "referenced and young files still there");

  console.log("8. corrupt projects.json, symlinked managed dir, automatic trigger...");
  {
    const dd = join(root, "data-corrupt");
    mkdirSync(join(dd, "baked"), { recursive: true });
    const f = put(join(dd, "baked"), "old.mp4");
    backdate(f, 2 * DAY);
    writeFileSync(join(dd, "projects.json"), "garbage");
    const e = new EditorEngine(dd);
    const r = await e.storage.cleanUp({});
    check(r.moved.length === 0 && existsSync(f), "unreadable projects.json: nothing moved");
    check(r.warnings.some((w) => w.includes("projects.json")), "…and it says why", r.warnings);
    await e.save(join(outside, "projects", "c.aive"));
    const fresh = JSON.parse(readFileSync(join(dd, "projects.json"), "utf8")) as { projects: string[] };
    check(fresh.projects.length === 1 && readdirSync(dd).some((n) => n.startsWith("projects.json.corrupt-")), "save() kept the bad list aside and started a new one");
  }
  {
    const dd = join(root, "data-linked");
    mkdirSync(dd, { recursive: true });
    const real = join(outside, "real-proxies");
    mkdirSync(real);
    const f = put(real, "old.mp4");
    backdate(f, 2 * DAY);
    symlinkSync(real, join(dd, "proxies"));
    const e = new EditorEngine(dd);
    const r = await e.storage.cleanUp({});
    check(r.moved.length === 0 && existsSync(f) && !existsSync(join(real, ".trash")), "symlinked proxies/ left alone");
  }
  {
    const idx = JSON.parse(readFileSync(indexPath, "utf8")) as { since: number };
    idx.since = Date.now() - 10 * DAY;
    writeFileSync(indexPath, JSON.stringify(idx));
    // Timer-driven: a short delay, and the armed run starts on its own. This is
    // the engine's first automatic run, so the throttle doesn't apply yet.
    process.env.AIVE_STORAGE_GC_DELAY_MS = "20";
    const orphanT = put(baked, "orphan-timer.mp4");
    backdate(orphanT, 2 * DAY);
    await call("new_project");
    const timed = await within(engine.storage.autoRunDone(), 10_000, "timed out" as const);
    check(timed !== "timed out" && !!timed && timed.moved.some((m) => m.name === "orphan-timer.mp4") && !existsSync(orphanT),
      "the armed automatic run starts on its own after the delay", timed);
    // Throttled: a trigger within a minute of the last automatic run waits out
    // the minute, not the 20 ms delay.
    await call("new_project");
    const early = await within(engine.storage.autoRunDone().then(() => "ran" as const), 500, "waiting" as const);
    check(early === "waiting", "a second trigger within a minute waits (automatic runs at most once a minute)", early);
    await engine.storage.runScheduledNow();

    // Deterministic: a long delay, then run the armed run at once and await it
    // (no sleeps). The delay only matters for when it would have started.
    process.env.AIVE_STORAGE_GC_DELAY_MS = String(60 * 60 * 1000);
    const orphan5 = put(baked, "orphan-5.mp4");
    backdate(orphan5, 2 * DAY);
    check((await engine.storage.autoRunDone()) === null, "no automatic run armed before the trigger");
    await call("new_project"); // arms a debounced automatic run
    const armed = engine.storage.autoRunDone();
    const ran = await engine.storage.runScheduledNow();
    check(!!ran && ran.moved.some((m) => m.name === "orphan-5.mp4"), "new_project armed an automatic clean-up", ran);
    check((await armed) === ran, "autoRunDone() resolves with that run's result");
    check(!existsSync(orphan5) && existsSync(join(baked, ".trash", "orphan-5.mp4")), "…which moved the orphan to the trash");
    check((await engine.storage.autoRunDone()) === null && (await engine.storage.runScheduledNow()) === null, "nothing armed afterwards");
    process.env.AIVE_STORAGE_GC_DELAY_MS = "-1";
  }

  console.log("9. a known project that can't be read pauses clean-up...");
  {
    const dd = join(root, "data-unavail");
    const bk = join(dd, "baked");
    mkdirSync(bk, { recursive: true });
    const vol = join(root, "usb");
    mkdirSync(vol);
    const showBake = put(bk, "show-cutout.mkv");
    const orphan9 = put(bk, "orphan-9.mp4");
    for (const p of [showBake, orphan9]) backdate(p, 2 * DAY);
    const show = join(vol, "show.aive");
    const good = JSON.stringify({ tracks: [], assets: [{ id: "a", path: showBake }] });
    writeFileSync(show, good);
    writeIdx(dd, { since: Date.now() - 30 * DAY, projects: [show] });
    const j = new StorageJanitor(dd, { liveProjects: () => [], runningJobs: () => [], log: () => {}, readTimeoutMs: 1500 });

    // An unplugged drive (or a moved/renamed file): ENOENT.
    renameSync(vol, `${vol}-unplugged`);
    const rep = await j.report();
    check(
      rep.wouldTrash.length === 0 && rep.unavailableProjects.some((u) => u.path === show && u.missing && u.pausesCleanUp),
      "report: an unplugged known project pauses clean-up", rep.unavailableProjects,
    );
    const a9 = await j.cleanUp({ auto: true });
    check(a9.moved.length === 0 && existsSync(showBake) && existsSync(orphan9), "an automatic run moves nothing while it is unplugged", a9.moved.map(key));
    const e9 = await j.cleanUp({ emptyTrash: true });
    check(e9.moved.length === 0 && e9.purged.length === 0 && existsSync(showBake), "…nor does an explicit Empty trash", e9);
    check(readIdx(dd).projects.includes(show) && typeof readIdx(dd).unavailable?.[show] === "number", "it stays known, marked unavailable");
    renameSync(`${vol}-unplugged`, vol);
    // Nothing for an automatic run to act on (every file predates tracking): it must still re-read the marked file.
    const before9 = readIdx(dd);
    writeIdx(dd, { ...before9, since: Date.now() });
    const q9 = await j.cleanUp({ auto: true });
    check(q9.moved.length === 0 && !readIdx(dd).unavailable, "plugged back in: the next automatic run clears the mark, even with nothing to move", readIdx(dd));
    writeIdx(dd, { ...readIdx(dd), since: before9.since });
    const b9 = await j.cleanUp({});
    check(b9.moved.map((m) => m.name).join() === "orphan-9.mp4" && existsSync(showBake), "plugged back in: clean-up resumes and keeps its bake", b9.moved.map(key));
    check(!readIdx(dd).unavailable, "…and the mark is cleared", readIdx(dd));

    // No permission, or half-written by a sync tool: unreadable, not missing.
    const modes = process.getuid?.() === 0 ? (["partial"] as const) : (["eacces", "partial"] as const);
    for (const mode of modes) {
      const o = put(bk, `orphan-${mode}.mp4`);
      backdate(o, 2 * DAY);
      if (mode === "eacces") chmodSync(show, 0o000);
      else writeFileSync(show, good.slice(0, 20));
      const r = await j.cleanUp({});
      check(r.moved.length === 0 && existsSync(o) && existsSync(showBake) && r.warnings.some((w) => w.includes("show.aive")), `${mode}: nothing moved while the project can't be read`, r);
      if (mode === "eacces") chmodSync(show, 0o644);
      else writeFileSync(show, good);
      const r2 = await j.cleanUp({});
      check(r2.moved.some((m) => m.name === `orphan-${mode}.mp4`) && existsSync(showBake), `${mode}: readable again → resumes, its bake kept`, r2.moved.map(key));
    }

    // A read that never answers (a FIFO nobody writes; a hung network drive):
    // it times out and pauses, and save() (remember) doesn't wait for it.
    if (process.platform !== "win32") {
      const fifo = join(vol, "hung.aive");
      execFileSync("mkfifo", [fifo]);
      writeIdx(dd, { ...readIdx(dd), projects: [...readIdx(dd).projects, fifo] });
      const hungOrphan = put(bk, "orphan-hung.mp4");
      backdate(hungOrphan, 2 * DAY);
      const meanwhile = join(vol, "saved-meanwhile.aive");
      writeFileSync(meanwhile, JSON.stringify({ tracks: [], assets: [] }));
      let cleanupDone = false;
      const pending = j.cleanUp({}).then((r) => { cleanupDone = true; return r; });
      await sleep(50); // let the clean-up reach the read (the order check below holds either way)
      await j.remember(meanwhile);
      const rememberFirst = !cleanupDone;
      const hung = await pending;
      check(rememberFirst, "remember() (every save) finishes while a clean-up is stuck on a hung read");
      check(hung.moved.length === 0 && existsSync(hungOrphan) && hung.warnings.some((w) => w.includes("no answer")), "the hung read times out and pauses clean-up", hung.warnings);
      try {
        closeSync(openSync(fifo, fsc.O_WRONLY | fsc.O_NONBLOCK)); // let the stuck read finish
      } catch {
        /* no reader left */
      }
      rmSync(fifo);
      const still = await j.cleanUp({});
      check(still.moved.length === 0 && existsSync(hungOrphan), "deleted: it still pauses (it could be on a drive that comes back)");
      const forgot = await j.cleanUp({ forgetMissing: true });
      check(forgot.forgotProjects.includes(fifo) && forgot.moved.some((m) => m.name === "orphan-hung.mp4") && existsSync(showBake), "forgetMissing forgets it and cleans up; the readable project's bake stays", forgot);
      check(!readIdx(dd).projects.includes(fifo) && readIdx(dd).projects.includes(meanwhile), "the forgotten file is off the list; the one saved meanwhile is on it");
    }

    // An autosave that can't be read pauses too, until the retention period.
    mkdirSync(join(dd, "autosave"), { recursive: true });
    const badAutosave = join(dd, "autosave", "Recovered-x.aive");
    writeFileSync(badAutosave, "{ half");
    const autoOrphan = put(bk, "orphan-autosave.mp4");
    backdate(autoOrphan, 2 * DAY);
    const as1 = await j.cleanUp({});
    check(as1.moved.length === 0 && existsSync(autoOrphan), "an unreadable autosave pauses clean-up", as1.warnings);
    const idx9 = readIdx(dd);
    writeIdx(dd, { ...idx9, unavailable: { ...idx9.unavailable, [badAutosave]: Date.now() - 8 * DAY } });
    const as2 = await j.cleanUp({});
    check(as2.moved.some((m) => m.name === "orphan-autosave.mp4"), "after the retention period it no longer pauses", as2.moved.map(key));
    check(typeof readIdx(dd).unavailable?.[badAutosave] === "number", "…and stays marked (an autosave is not a project to forget)");
  }

  console.log("10. a trashed file a project names again goes back...");
  {
    const dd = join(root, "data-inuse");
    const bk = join(dd, "baked");
    mkdirSync(join(bk, ".trash"), { recursive: true });
    writeIdx(dd, { since: Date.now() - 30 * DAY, projects: [] });
    const e = new EditorEngine(dd);
    const c10 = caller(e);
    const f = put(bk, "rev-x.mp4");
    const a = await c10<{ asset: { id: string } }>("import_video", { path: f });
    await c10("append_clip", { assetId: a.asset.id });
    // However it got there (a second core, a race): in the trash, trashed 8 days ago.
    renameSync(f, join(bk, ".trash", "rev-x.mp4"));
    setTrashedAt(bk, "rev-x.mp4", 8 * DAY);
    const rep = await c10<Report>("storage_report");
    const item = rep.trash.find((t) => t.name === "rev-x.mp4");
    check(!!item && item.inUse && !item.expired && rep.inUseTrash.count === 1 && rep.emptyTrash.count === 0, "report: in use, not expired, not for Empty trash", rep.trash);
    const auto = await e.storage.cleanUp({ auto: true });
    check(auto.restored.some((r) => r.name === "rev-x.mp4") && auto.purged.length === 0 && existsSync(f), "the next automatic run moves it back (not deleted)", auto);
    renameSync(f, join(bk, ".trash", "rev-x.mp4"));
    const et = await c10<Cleanup>("clean_up_storage", { emptyTrash: true });
    check(et.restored.length === 1 && et.purged.length === 0 && existsSync(f), "Empty trash moves it back instead of deleting it", et);
  }

  console.log("11. pre-tracking files: Empty trash keeps them in the trash; remember_projects keeps their bakes...");
  {
    const dd = join(root, "data-legacy");
    const bk = join(dd, "baked");
    mkdirSync(bk, { recursive: true });
    const wedding = put(bk, "wedding-cutout.mkv");
    const stray = put(bk, "stray-old.mkv");
    for (const p of [wedding, stray]) backdate(p, 20 * DAY);
    const e = new EditorEngine(dd);
    const c11 = caller(e);
    // Saved before the upgrade and not opened since; the UI lists it in its recent projects.
    const old = join(outside, "Videos", "wedding.aive");
    mkdirSync(join(outside, "Videos"), { recursive: true });
    writeFileSync(old, JSON.stringify({ tracks: [], assets: [{ id: "w", path: wedding }] }));
    const rep0 = await c11<Report>("storage_report"); // starts projects.json now
    check(rep0.wouldTrash.length === 2 && rep0.predatesTracking.count === 2, "both old files are unused and predate tracking", rep0.wouldTrash.map(key));
    const rem = await c11<{ added: string[]; skipped: { path: string; reason: string }[] }>("remember_projects", {
      paths: [old, join(outside, "Videos", "gone.aive"), join(outside, "tiny.mp4")],
    });
    check(rem.added.length === 1 && rem.added[0] === old && rem.skipped.length === 2, "remember_projects adds the existing .aive, skips a missing one and a non-project", rem);
    check(!readIdx(dd).unavailable, "a skipped path never becomes a missing project");
    const rep1 = await c11<Report>("storage_report");
    check(JSON.stringify(rep1.wouldTrash.map(key)) === JSON.stringify(["baked/stray-old.mkv"]), "the remembered project's bake is no longer unused", rep1.wouldTrash.map(key));
    check(rep1.emptyTrash.count === 0, "Empty trash would delete nothing for good (the old file goes to the trash instead)", rep1.emptyTrash);
    const et = await c11<Cleanup>("clean_up_storage", { emptyTrash: true });
    check(et.moved.map((m) => m.name).join() === "stray-old.mkv" && et.purged.length === 0 && et.keptInTrash.length === 1, "Empty trash moves a pre-tracking file to the trash and keeps it there", et);
    check(existsSync(join(bk, ".trash", "stray-old.mkv")) && existsSync(wedding), "…it is in the trash; the remembered project's bake is in place");
  }

  console.log("12. percent-encoded file: URLs and relative paths are references...");
  {
    const dd = join(root, "John Smith", "data");
    const f = join(dd, "baked", "c1-cutout-x.mkv");
    const url = pathToFileURL(f).href;
    check(url.includes("John%20Smith"), "the URL is percent-encoded", url);
    const refs = referencedManagedPaths(dd, [{ OTIO_SCHEMA: "Timeline.1", target_url: url }]);
    check(refs.has(f), "an .otio target_url under 'John Smith' names the bake", [...refs]);
    const refs2 = referencedManagedPaths(relative(process.cwd(), dd), [{ path: relative(process.cwd(), f) }]);
    check(refs2.has(f), "a relative path under a relative data dir names the bake", [...refs2]);
    mkdirSync(join(dd, "baked", ".trash"), { recursive: true });
    writeFileSync(join(dd, "baked", ".trash", "c1-cutout-x.mkv"), "x");
    const j = new StorageJanitor(dd, { liveProjects: () => [], runningJobs: () => [], log: () => {} });
    const restored = await j.restore({ tracks: { children: [{ media_references: { DEFAULT_MEDIA: { target_url: url } } }] } });
    check(restored.length === 1 && existsSync(f), "opening such an .otio moves the bake back out of the trash", restored);
  }


  console.log("13. trashed files keep their mtime; the trash time is in the trash index...");
  {
    const dd = join(root, "data-mtime");
    const bk = join(dd, "baked");
    mkdirSync(bk, { recursive: true });
    writeIdx(dd, { since: Date.now() - 30 * DAY, projects: [] });
    const f = put(bk, "cut-x.mkv");
    backdate(f, 3 * DAY);
    const before = statSync(f).mtimeMs;
    const j = new StorageJanitor(dd, { liveProjects: () => [], runningJobs: () => [], log: () => {} });
    const r = await j.cleanUp({});
    const inTrash = join(bk, ".trash", "cut-x.mkv");
    check(r.moved.some((m) => m.name === "cut-x.mkv") && existsSync(inTrash), "moved to the trash");
    check(statSync(inTrash).mtimeMs === before, "the trash keeps the file's own mtime", [statSync(inTrash).mtimeMs, before]);
    const tIdx = JSON.parse(readFileSync(join(bk, ".trash", ".index.json"), "utf8")) as { trashedAt: Record<string, number> };
    check(Date.now() - (tIdx.trashedAt["cut-x.mkv"] ?? 0) < 60_000, "the trash time is recorded in .trash/.index.json", tIdx);
    const rep13 = await j.report();
    check(rep13.trash.length === 1 && !rep13.trash[0].expired, "an old file in the trash is not expired (trash time, not mtime)", rep13.trash);
    const back = await j.restore({ assets: [{ id: "a", path: f }] });
    check(back.length === 1 && Math.round(statSync(f).mtimeMs) === Math.round(before), "restored with its original mtime (segment-cache key unchanged)");
    const tIdx2 = JSON.parse(readFileSync(join(bk, ".trash", ".index.json"), "utf8")) as { trashedAt: Record<string, number> };
    check(tIdx2.trashedAt["cut-x.mkv"] === undefined, "its trash record is dropped on restore", tIdx2);
    // An entry without a record (trashed by an older version, a lost record): trashed "now".
    const legacy = join(bk, ".trash", "legacy-old.mp4");
    copyFileSync(clip, legacy);
    backdate(legacy, 40 * DAY);
    const r2 = await j.cleanUp({});
    check(r2.purged.length === 0 && existsSync(legacy), "an unrecorded old trash entry is not deleted at once", r2.purged);
    const tIdx3 = JSON.parse(readFileSync(join(bk, ".trash", ".index.json"), "utf8")) as { trashedAt: Record<string, number> };
    check(Date.now() - (tIdx3.trashedAt["legacy-old.mp4"] ?? 0) < 60_000, "…the clean-up records it as trashed now", tIdx3);
    setTrashedAt(bk, "legacy-old.mp4", 8 * DAY);
    const r3 = await j.cleanUp({});
    check(r3.purged.some((p) => p.name === "legacy-old.mp4") && !existsSync(legacy), "…and deletes it once the retention period has passed");
    const u = await j.report();
    const trashed = readdirSync(join(bk, ".trash")).filter((n) => n !== ".index.json");
    check(u.usage.trash.files === trashed.length && existsSync(join(bk, ".trash", ".index.json")), "the trash index is not counted as a trashed file", [u.usage.trash, trashed]);
  }

  console.log("14. an unreadable known project is logged once per file state...");
  {
    const dd = join(root, "data-log");
    const bk = join(dd, "baked");
    mkdirSync(bk, { recursive: true });
    const bad = join(outside, "corrupt.aive");
    writeFileSync(bad, "{ half");
    writeIdx(dd, { since: Date.now() - 30 * DAY, projects: [bad] });
    const o = put(bk, "orphan-14.mp4");
    backdate(o, 2 * DAY);
    const logs: string[] = [];
    const mk = () => new StorageJanitor(dd, { liveProjects: () => [], runningJobs: () => [], log: (m) => logs.push(m) });
    const pauses = () => logs.filter((l) => l.startsWith("Clean-up is paused")).length;
    const j1 = mk();
    await j1.cleanUp({});
    await j1.cleanUp({ auto: true });
    await j1.report();
    check(pauses() === 1, "logged once by one core over several runs", logs);
    await mk().cleanUp({ auto: true });
    await mk().cleanUp({});
    check(pauses() === 1, "not again after a restart (a fresh core) while the file is unchanged", logs);
    writeFileSync(bad, "{ still half, but longer");
    await mk().cleanUp({ auto: true });
    check(pauses() === 2, "logged again once the file changes", logs);
    await mk().cleanUp({});
    rmSync(bad);
    await mk().cleanUp({});
    check(pauses() === 3, "…and once it goes missing", logs);
    await mk().cleanUp({});
    check(pauses() === 3 && existsSync(o), "still paused, not logged again", logs);
  }

  console.log("15. two cores on one data dir see each other's undo history...");
  {
    const dd = join(root, "data-two");
    const bk = join(dd, "baked");
    mkdirSync(bk, { recursive: true });
    writeIdx(dd, { since: Date.now() - 30 * DAY, projects: [] });
    const A = new EditorEngine(dd);
    const B = new EditorEngine(dd);
    const cA = caller(A);
    const fa = put(bk, "only-in-a-undo.mp4");
    const ia = await cA<{ asset: { id: string } }>("import_video", { path: fa });
    await cA("append_clip", { assetId: ia.asset.id });
    await cA("remove_asset", { assetId: ia.asset.id }); // now only A's undo history names it
    backdate(fa, 2 * DAY);
    await A.storage.publishNow();
    const runDir = join(dd, "run");
    const aRun = JSON.parse(readFileSync(A.storage.runFile, "utf8")) as { pid: number; paths: string[] };
    check(aRun.pid === process.pid && aRun.paths.includes(resolve(fa)), "core A published the paths its undo history names", aRun);
    const b1 = await B.storage.cleanUp({});
    check(!b1.moved.some((m) => m.name === "only-in-a-undo.mp4") && existsSync(fa), "core B keeps a file only core A's undo history uses", b1.moved.map(key));
    const rb = await B.storage.report();
    check(rb.otherCores === 1, "storage_report counts the other core", rb.otherCores);

    // A second PROCESS that is killed: its run file stays but stops counting.
    const fc = put(bk, "only-in-child.mp4");
    backdate(fc, 2 * DAY);
    const childSrc = join(root, "child-core.mts");
    writeFileSync(childSrc, [
      `import { EditorEngine } from ${JSON.stringify(fileURLToPath(new URL("../src/engine.ts", import.meta.url)))};`,
      `const e = new EditorEngine(${JSON.stringify(dd)});`,
      `const a = await e.importVideo(${JSON.stringify(fc)});`,
      `e.appendClip(a.id);`,
      `await e.storage.publishNow();`,
      `console.log("ready " + e.storage.runFile);`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"));
    const child = spawn(process.execPath, ["--import", "tsx", childSrc], { cwd: fileURLToPath(new URL("../../..", import.meta.url)), stdio: ["ignore", "pipe", "inherit"] });
    const childRun = await new Promise<string>((res, rej) => {
      let buf = "";
      child.stdout!.on("data", (d) => {
        buf += String(d);
        const m = /ready (\S+)/.exec(buf);
        if (m) res(m[1]);
      });
      child.on("exit", (code) => rej(new Error(`child core exited early (${code})`)));
    });
    const b2 = await B.storage.cleanUp({});
    check(existsSync(fc) && !b2.moved.some((m) => m.name === "only-in-child.mp4") && b2.warnings.every((w) => !w.includes("stopped answering")),
      "a running child core's file is kept", b2.moved.map(key));
    const exited = new Promise((r) => child.on("exit", r));
    child.kill("SIGKILL");
    await exited;
    check(existsSync(childRun), "a killed core leaves its run file behind");
    const b3 = await B.storage.cleanUp({});
    check(b3.moved.some((m) => m.name === "only-in-child.mp4") && !existsSync(childRun), "…which stops counting at once (process gone) and is removed", b3.moved.map(key));

    // A live process whose file was not rewritten for RUN_STALE_MS (hung, or a reused pid).
    const fs2 = put(bk, "only-in-stale.mp4");
    backdate(fs2, 2 * DAY);
    const stale = join(runDir, `core-${process.pid}-stale0.json`);
    writeFileSync(stale, JSON.stringify({ version: 1, pid: process.pid, startedAt: 0, updatedAt: 0, paths: [resolve(fs2)] }));
    backdate(stale, RUN_STALE_MS + 60_000);
    const b4 = await B.storage.cleanUp({});
    check(b4.moved.some((m) => m.name === "only-in-stale.mp4") && b4.warnings.some((w) => w.includes("stopped answering")), "a stale run file no longer counts (and says so)", b4);
    check(existsSync(stale), "…but stays in run/ (the core may only be hung)");
    // Far past stale (a crashed core's pid reused by another process): deleted, no more warning.
    backdate(stale, RUN_REAP_MS + 60_000);
    const b4b = await B.storage.cleanUp({});
    check(!existsSync(stale) && b4b.warnings.every((w) => !w.includes("stopped answering")), "a run file far past stale is removed even though its pid is alive", b4b);

    // A live, fresh run file that can't be read: its references are unknown → pause.
    const fu = put(bk, "maybe-used.mp4");
    backdate(fu, 2 * DAY);
    const garbled = join(runDir, `core-${process.pid}-garbl.json`);
    writeFileSync(garbled, "{ nope");
    const b5 = await B.storage.cleanUp({});
    check(b5.moved.length === 0 && existsSync(fu) && b5.warnings.some((w) => w.includes("can't be read")), "an unreadable live run file pauses clean-up", b5);
    rmSync(garbled);

    // A dead pid's file is ignored even if fresh.
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    const deadFile = join(runDir, `core-${Number(dead.stdout)}-dead00.json`);
    writeFileSync(deadFile, JSON.stringify({ version: 1, pid: Number(dead.stdout), startedAt: 0, updatedAt: Date.now(), paths: [resolve(fu)] }));
    const b6 = await B.storage.cleanUp({});
    check(b6.moved.some((m) => m.name === "maybe-used.mp4") && !existsSync(deadFile), "a dead core's fresh file is ignored and removed", b6.moved.map(key));

    // A exits cleanly: its file goes, and so does the protection.
    await A.storage.dispose();
    check(!existsSync(A.storage.runFile), "dispose() removes the run file");
    const b7 = await B.storage.cleanUp({});
    check(b7.moved.some((m) => m.name === "only-in-a-undo.mp4"), "after core A exits, core B trashes what only A used", b7.moved.map(key));
    await B.storage.dispose();
  }

  console.log("16. library bakes: unused bakes leave the library, imported media never...");
  {
    const dd = join(root, "data-lib");
    mkdirSync(join(dd, "baked"), { recursive: true });
    writeIdx(dd, { since: Date.now() - 30 * DAY, projects: [] });
    const e = new EditorEngine(dd);
    const c = caller(e);
    const lib = () => e.getProject().assets.map((a) => a.id);
    const imp = await c<{ asset: { id: string } }>("import_video", { path: clip });
    const app = await c<{ clip: { id: string } }>("append_clip", { assetId: imp.asset.id });
    const rev = await c<{ assetId: string; restored: boolean }>("reverse_clip", { clipId: app.clip.id });
    const R = e.getProject().assets.find((a) => a.id === rev.assetId)!;
    check(!rev.restored && R.path.startsWith(join(dd, "baked")), "reverse_clip baked into baked/", R.path);
    const fwd = await c<{ restored: boolean }>("reverse_clip", { clipId: app.clip.id }); // flips back: R unused now
    check(fwd.restored, "reversing again re-points at the original");
    const rep16 = await c<Report & { libraryBakes: { count: number; assets: { assetId: string }[] } }>("storage_report");
    check(rep16.libraryBakes.count === 1 && rep16.libraryBakes.assets[0].assetId === R.id, "storage_report lists the bake only the library holds", rep16.libraryBakes);
    const k1 = await c<Cleanup & { removedFromLibrary: { assetId: string }[] }>("clean_up_storage");
    check(k1.removedFromLibrary.length === 0 && lib().includes(R.id), "kept while an undo step still uses it", k1.removedFromLibrary);
    // An imported file from baked/ that nothing uses: user media, never auto-removed.
    const userCopy = put(join(dd, "baked"), "my-copy.mp4");
    const ui = await c<{ asset: { id: string; userImported?: boolean } }>("import_video", { path: userCopy });
    check(ui.asset.userImported === true, "a file imported from baked/ is marked as user media");
    // A bake no clip uses but the music bed does: used (the reference scan is field-agnostic).
    const revM = await c<{ assetId: string }>("reverse_clip", { clipId: app.clip.id });
    await c("set_music", { assetId: revM.assetId });
    await c("reverse_clip", { clipId: app.clip.id }); // the clip flips back: only the music names the bake now
    const M = e.getProject().assets.find((a) => a.id === revM.assetId)!;
    check(e.getProject().tracks.every((t) => t.clips.every((cl) => cl.assetId !== M.id)) && e.getProject().music?.assetId === M.id, "a bake only the music bed uses", e.getProject().music);
    const projL = join(outside, "projects", "lib.aive");
    await c("save_project", { path: projL });
    await c("load_project", { path: projL }); // undo history cleared
    check(!e.isDirty(), "freshly opened project is clean");
    const k2 = await c<Cleanup & { removedFromLibrary: { assetId: string }[] }>("clean_up_storage");
    check(k2.removedFromLibrary.map((a) => a.assetId).join() === R.id && !lib().includes(R.id), "once no state uses it, the clean-up removes it from the library", k2.removedFromLibrary);
    check(lib().includes(ui.asset.id) && lib().includes(imp.asset.id), "imported media stays (the user copy from baked/ too)");
    check(lib().includes(M.id) && !k2.removedFromLibrary.some((a) => a.assetId === M.id), "a bake only the music bed uses stays in the library", k2.removedFromLibrary);
    check(!e.isDirty(), "the project stays clean (housekeeping, not an edit)");
    check(existsSync(R.path), "its file is kept while the saved project still names it");
    await c("save_project", { path: projL });
    backdate(R.path, 2 * DAY);
    const k3 = await c<Cleanup>("clean_up_storage");
    check(k3.moved.some((m) => R.path.endsWith(m.name)) && !existsSync(R.path), "after saving, the clean-up trashes the bake's file", k3.moved.map(key));
    check(existsSync(M.path) && lib().includes(M.id), "…but not the file of the bake the music bed uses", k3.moved.map(key));

    // remove_unused_media: dry run, generated only, undo, includeImported; a used reversed bake keeps its original.
    const rev2 = await c<{ assetId: string }>("reverse_clip", { clipId: app.clip.id });
    type RU = { dryRun: boolean; removed: { assetId: string; kind: string }[]; keptImported: { assetId: string }[] };
    const d0 = await c<RU>("remove_unused_media", { dryRun: true, includeImported: true });
    check(!d0.removed.some((a) => a.assetId === imp.asset.id) && d0.removed.some((a) => a.assetId === ui.asset.id),
      "the original of a reversed clip in use is used (reverse_clip flips back to it); the unused copy is not", d0.removed);
    check(!d0.removed.some((a) => a.assetId === M.id), "remove_unused_media does not list the bake the music bed uses", d0.removed);
    await c("remove_clip", { clipId: app.clip.id });
    const d1 = await c<RU>("remove_unused_media", { dryRun: true });
    check(d1.dryRun && d1.removed.map((a) => `${a.kind}:${a.assetId}`).join() === `generated:${rev2.assetId}` &&
      d1.keptImported.map((a) => a.assetId).join() === ui.asset.id, "dry run: the bake would go, imported media is listed as kept", d1); // the music bed's bake names imp as its original
    check(lib().includes(rev2.assetId), "…and nothing changed");
    const r1 = await c<RU>("remove_unused_media");
    check(r1.removed.length === 1 && !lib().includes(rev2.assetId) && lib().includes(imp.asset.id), "removes the unused bake only", r1);
    await c("undo");
    check(lib().includes(rev2.assetId), "one undo step brings it back");
    await c("remove_music");
    const r2 = await c<RU>("remove_unused_media", { includeImported: true });
    check(r2.removed.length === 4 && e.getProject().assets.length === 0, "includeImported removes the unused imported media too", r2);
    await e.storage.dispose();
  }

  await engine.storage.dispose();
  rmSync(root, { recursive: true, force: true });
  if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nSTORAGE SMOKE TEST PASSED");
  process.exit(0); // a stuck FIFO read (section 9) must not keep the process alive
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
