/**
 * Regression check for the save picker's file-name rule (src/savename.ts):
 * a typed known extension is kept (and its filter selected); only a name with
 * no extension gets the active filter's extension. presetForPath: a kept
 * extension that differs from the preset's container picks a preset that
 * writes it (an H.264 preset can't write .webm), and presetSwapNote says so.
 * Also the rules the matrix can't reach through Electron or a browser:
 * electron/save-rules.cjs (the native dialogs' extension rule, which must match
 * resolveSaveName; the second overwrite question; the unsaved-changes close
 * guard), src/editkeys.ts (S / Delete after a split) and src/pathbar.ts (a late
 * folder listing keeps a typed path).
 * Run: npx tsx apps/desktop/scripts/smoke-savename.ts
 */
import { createRequire } from "node:module";
import { resolveSaveName, presetForPath, presetSwapNote } from "../src/savename.js";
import { exportFilters, PROJECT_FILTERS, type FileFilter } from "../src/platform.js";
import { clipIsLive, splitFrameFor } from "../src/editkeys.js";
import { PathBarEdits } from "../src/pathbar.js";
import type { Clip, Project } from "../src/types.js";

type Guard = { pendingSaveQuit: boolean; forceQuit: boolean };
type GuardEvent =
  | { type: "close-dialog"; choice: "save" | "dont-save" | "cancel"; hasPath: boolean }
  | { type: "save-as-cancelled" } | { type: "save-failed" } | { type: "project-state"; dirty: boolean };
const rules = createRequire(import.meta.url)("../electron/save-rules.cjs") as {
  withExtension: (p: string, f: FileFilter[]) => string;
  finalSavePath: (p: string, f: FileFilter[], exists: (p: string) => boolean, confirm: (p: string) => boolean) => string | null;
  closeGuard: (s: Guard, e: GuardEvent) => { state: Guard; effect: string | null };
};

let failed = 0;
const eq = (got: unknown, want: unknown, what: string) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${ok ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
  if (!ok) failed++;
};
const f = exportFilters("mp4");
eq(resolveSaveName("out.webm", f, 0), { name: "out.webm", filterIdx: 1 }, "out.webm stays webm, filter switches");
eq(resolveSaveName("/x/out.MOV", f, 0), { name: "/x/out.MOV", filterIdx: 2 }, "absolute .MOV kept");
eq(resolveSaveName("out", f, 0), { name: "out.mp4", filterIdx: 0 }, "no extension gets .mp4");
eq(resolveSaveName("my.clip", f, 0), { name: "my.clip.mp4", filterIdx: 0 }, "unknown extension is part of the name");
eq(resolveSaveName("out", exportFilters("webm"), 0), { name: "out.webm", filterIdx: 0 }, "webm preset default is .webm");
eq(resolveSaveName("out", exportFilters("mov"), 0), { name: "out.mov", filterIdx: 0 }, "mov preset default is .mov");
eq(exportFilters("webm").map((x) => x.extensions[0]), ["webm", "mp4", "mov"], "preset container listed first");
// Same list as App.tsx EXPORT_PRESETS (id + container).
const presets = [
  { id: "youtube", ext: "mp4" }, { id: "youtube_hevc", ext: "mp4" }, { id: "social", ext: "mp4" },
  { id: "square", ext: "mp4" }, { id: "web", ext: "webm" }, { id: "master", ext: "mov" },
];
eq(presetForPath(presets, "social", "/x/out.mp4"), "social", "matching container keeps the preset");
eq(presetForPath(presets, "youtube", "/x/out.webm"), "web", "typed .webm with an MP4 preset exports WebM");
eq(presetForPath(presets, "youtube", "C:\\x\\out.MOV"), "master", "typed .MOV with an MP4 preset exports MOV");
eq(presetForPath(presets, "web", "/x/out.mp4"), "youtube", "typed .mp4 with the WebM preset exports MP4");
eq(presetForPath(presets, undefined, "/x/out.mp4"), undefined, "no preset + .mp4 keeps the core default");
eq(presetForPath(presets, undefined, "/x/out.webm"), "web", "no preset + .webm exports WebM");
eq(presetForPath(presets, "youtube", "/x/out"), "youtube", "no extension keeps the preset");

// presetSwapNote: the export result names the preset actually used.
const labelled = presets.map((p) => ({ ...p, label: p.id === "master" ? "Master" : p.id === "web" ? "Web (WebM)" : p.id === "youtube" ? "YouTube" : p.id }));
eq(presetSwapNote(labelled, "social", "social", "/x/out.mp4"), null, "no swap → no note");
eq(presetSwapNote(labelled, "youtube", "master", "/x/out.MOV"), "Used the Master preset instead of YouTube, because the file name ends in .MOV.", "YouTube + .MOV names Master");
eq(presetSwapNote(labelled, undefined, "web", "C:\\x\\a.b\\out.webm"), "Used the Web (WebM) preset instead of default MP4, because the file name ends in .webm.", "default + .webm names Web");

// Electron's native save dialog (save-rules.cjs withExtension) applies the same
// rule as resolveSaveName with the first filter active.
eq(PROJECT_FILTERS[0].name, "ZabsReel Project", "the project file filter carries the product name");
const filterSets: [string, FileFilter[]][] = [
  ["export mp4", exportFilters("mp4")], ["export webm", exportFilters("webm")], ["export mov", exportFilters("mov")],
  ["project", PROJECT_FILTERS.slice(0, 1)],
  ["project + all", PROJECT_FILTERS],
];
const typedNames = ["/x/out", "/x/out.webm", "/x/out.MOV", "/x/out.mp4", "/x/my.clip", "/x/My Cut", "/x/My Cut.aive", "/x/.hidden", "/x/a.b/out", "/x/out.*", "/x/out."];
for (const [fname, fs] of filterSets) {
  for (const typed of typedNames) {
    eq(rules.withExtension(typed, fs), resolveSaveName(typed, fs, 0).name, `native rule = web rule: ${fname}, ${typed}`);
  }
}
eq(rules.withExtension("/x/my.clip", exportFilters("mp4")), "/x/my.clip.mp4", "native: my.clip gets .mp4");
eq(rules.withExtension("/x/out.MOV", exportFilters("mp4")), "/x/out.MOV", "native: .MOV kept");
eq(rules.withExtension("/x/out", [{ name: "All Files", extensions: ["*"] }]), "/x/out", "native: '*' filter adds nothing");

// finalSavePath: asks again only when it added an extension and that file exists.
const ask = (existing: string[], answer: boolean) => {
  const asked: string[] = [];
  return { asked, run: (p: string) => rules.finalSavePath(p, exportFilters("mp4"), (q) => existing.includes(q), (q) => { asked.push(q); return answer; }) };
};
let t = ask(["/x/taken.mp4"], false);
eq([t.run("/x/taken"), t.asked], [null, ["/x/taken.mp4"]], "added .mp4 + file exists + Cancel → null, asked once");
t = ask(["/x/taken.mp4"], true);
eq([t.run("/x/taken"), t.asked], ["/x/taken.mp4", ["/x/taken.mp4"]], "added .mp4 + file exists + Replace → path");
t = ask([], false);
eq([t.run("/x/fresh"), t.asked], ["/x/fresh.mp4", []], "added .mp4, no such file → no question");
t = ask(["/x/taken.mp4"], false);
eq([t.run("/x/taken.mp4"), t.asked], ["/x/taken.mp4", []], "typed name kept → the dialog already asked, no second question");

// The unsaved-changes close guard.
const start: Guard = { pendingSaveQuit: false, forceQuit: false };
const play = (events: GuardEvent[]) => {
  let s = start;
  const effects: (string | null)[] = [];
  for (const e of events) { const r = rules.closeGuard(s, e); s = r.state; effects.push(r.effect); }
  return { state: s, effects };
};
const save = (hasPath: boolean): GuardEvent => ({ type: "close-dialog", choice: "save", hasPath });
const clean: GuardEvent = { type: "project-state", dirty: false };
const dirty: GuardEvent = { type: "project-state", dirty: true };
eq(play([save(true), clean]).effects, ["save", "close"], "Save (has file) → save, then clean → close");
eq(play([save(false), clean]).effects, ["save-as", "close"], "Save (no file) → Save As, then clean → close");
eq(play([{ type: "close-dialog", choice: "dont-save", hasPath: true }]), { state: { pendingSaveQuit: false, forceQuit: true }, effects: ["close"] }, "Don't Save → close");
eq(play([{ type: "close-dialog", choice: "cancel", hasPath: true }, clean]).effects, [null, null], "Cancel → stay; a later save doesn't close");
eq(play([save(false), { type: "save-as-cancelled" }, clean]).effects, ["save-as", null, null], "Save As cancelled → a later save doesn't close");
eq(play([save(true), { type: "save-failed" }, dirty, clean]), { state: start, effects: ["save", null, null, null] }, "save failed → the later autosave doesn't close");
eq(play([save(true), { type: "close-dialog", choice: "cancel", hasPath: true }, clean]).effects, ["save", null, null], "second close → Cancel drops the earlier Save");
eq(play([save(true), dirty, clean]).effects, ["save", null, "close"], "dirty report while saving → keep waiting");
eq(play([clean, dirty, clean]).effects, [null, null, null], "no close asked → saves never close");

// S / Delete after a split: the closure's clips and selection can be stale.
const clip = (id: string, startFrame: number): Clip => ({ id, assetId: "a", startFrame, sourceInFrame: 0, sourceOutFrame: 60 }) as unknown as Clip;
const proj = (...ids: [string, number][]): Project => ({ tracks: [{ id: "v", kind: "video", index: 0, clips: ids.map(([id, s]) => clip(id, s)) }] }) as unknown as Project;
const stale = [clip("c1", 0)];
const live = proj(["c1a", 0], ["c1b", 30]); // c1 was split into c1a + c1b
eq(clipIsLive(live, "c1"), false, "split clip's old id is not live");
eq(clipIsLive(live, "c1b"), true, "a new piece is live");
eq(clipIsLive(null, "c1"), false, "no project → nothing is live");
eq(splitFrameFor(live, stale, "c1", 10, 30), null, "S right after a split: stale selection → no split");
eq(splitFrameFor(proj(["c1", 0]), stale, "c1", 10, 30), 10, "S inside a live clip → split at the playhead");
eq(splitFrameFor(proj(["c1", 0]), stale, "c1", 0, 30), null, "S at the clip's first frame → no split");
eq(splitFrameFor(proj(["c1", 0]), stale, "c1", 60, 30), null, "S at the clip's end → no split");
eq(splitFrameFor(proj(["c1", 0]), stale, null, 10, 30), null, "S with nothing selected → no split");

// The web picker's path bar: a listing that lands after an edit keeps the typed text.
const bar = new PathBarEdits();
let mark = bar.mark();
eq(bar.listingMayReplace(mark), true, "listing with no edit since it started → shows its path");
mark = bar.mark();
bar.typed();
eq(bar.listingMayReplace(mark), false, "typed while the listing was loading → typed text kept");
bar.typed();
mark = bar.mark();
eq(bar.listingMayReplace(mark), true, "listing started after the edits → shows its path");

process.exit(failed ? 1 : 0);
