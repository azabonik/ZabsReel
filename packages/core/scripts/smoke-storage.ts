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
 *
 * Run: npx tsx packages/core/scripts/smoke-storage.ts
 * (No downloads; synthesizes a tiny clip with ffmpeg; temp dirs only.)
 */
import {
  chmodSync, closeSync, constants as fsc, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync, lutimesSync, rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { EditorEngine } from "../src/engine.js";
import { methods } from "../src/rpc.js";
import { runFfmpeg } from "../src/ffmpeg/executor.js";
import { StorageJanitor, referencedManagedPaths } from "../src/storage.js";

// Automatic runs off unless a section turns them on (a timer firing between
// storage_report and clean_up_storage would break the dry-run comparison).
process.env.AIVE_STORAGE_GC_DELAY_MS = "-1";
delete process.env.AIVE_BAKED_TRASH_DAYS;

const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const root = mkdtempSync(join(tmpdir(), "synthcut-storage-"));
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
  const trashedAt = statSync(join(baked, ".trash", "orphan-old.mkv")).mtimeMs;
  check(Date.now() - trashedAt < 60_000, "trash time stamped on the moved file");
  const after = await call<Report>("storage_report");
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
  check(loaded.project.assets.every((a) => existsSync(a.path)), "every asset of the loaded project exists on disk");
  check((loaded.restoredFromTrash ?? []).length === 1, "load_project reports restoredFromTrash", loaded.restoredFromTrash);
  const idx6b = JSON.parse(readFileSync(indexPath, "utf8")) as { projects: string[] };
  check(idx6b.projects.includes(copied), "load() recorded the copy as a known project");
  const otio = join(outside, "handoff", "edit.otio");
  await call("export_otio", { path: otio });
  const idx6c = JSON.parse(readFileSync(indexPath, "utf8")) as { projects: string[] };
  check(idx6c.projects.includes(otio), "export_otio recorded the .otio (another NLE may use the bakes)");

  console.log("7. trash retention and emptyTrash...");
  backdate(join(baked, ".trash", "orphan-old.mkv"), 8 * DAY);
  backdate(join(proxies, ".trash", "asset_gone.mp4"), 1 * DAY);
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
  const leftInTrash = [baked, proxies].flatMap((d) => (existsSync(join(d, ".trash")) ? readdirSync(join(d, ".trash")) : []));
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
    process.env.AIVE_STORAGE_GC_DELAY_MS = "50";
    const idx = JSON.parse(readFileSync(indexPath, "utf8")) as { since: number };
    idx.since = Date.now() - 10 * DAY;
    writeFileSync(indexPath, JSON.stringify(idx));
    const orphan5 = put(baked, "orphan-5.mp4");
    backdate(orphan5, 2 * DAY);
    await call("new_project"); // schedules a debounced automatic run
    await sleep(400);
    await engine.storage.report(); // waits for the run (same lock)
    check(!existsSync(orphan5) && existsSync(join(baked, ".trash", "orphan-5.mp4")), "new_project triggered an automatic clean-up");
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
    const j = new StorageJanitor(dd, { liveProjects: () => [], runningJobs: () => [], log: () => {}, readTimeoutMs: 500 });

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
      const pending = j.cleanUp({});
      await sleep(50);
      const t1 = Date.now();
      await j.remember(meanwhile);
      const rememberMs = Date.now() - t1;
      const hung = await pending;
      check(rememberMs < 250, `remember() (every save) doesn't wait for a clean-up stuck on a hung read (${rememberMs} ms)`);
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
    backdate(join(bk, ".trash", "rev-x.mp4"), 8 * DAY);
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
