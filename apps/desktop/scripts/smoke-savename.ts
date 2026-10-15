/**
 * Regression check for the save picker's file-name rule (src/savename.ts):
 * a typed known extension is kept (and its filter selected); only a name with
 * no extension gets the active filter's extension. presetForPath: a kept
 * extension that differs from the preset's container picks a preset that
 * writes it (an H.264 preset can't write .webm), and presetSwapNote says so.
 * Also the rules the matrix can't reach through Electron or a browser:
 * electron/save-rules.cjs (the native dialogs' extension rule, which must match
 * resolveSaveName; the second overwrite question; the unsaved-changes close
 * guard), electron/media-servers.cjs (the approval dialogs: the renderer's
 * display-only "You opened" context counts only when the core's pending list
 * agrees; the web shell's in-app dialogs in src/mediaservers.ts say the
 * same; one flow asks and saves the answer, for Review… and for a file picked
 * in a native dialog, which asks once per server and never allows silently;
 * the web shell's reviews in src/platform.ts run one at a time), src/editkeys.ts
 * (S / Delete after a split) and src/pathbar.ts (a late folder listing keeps a
 * typed path).
 * Run: npx tsx apps/desktop/scripts/smoke-savename.ts
 */
import { createRequire } from "node:module";
import { resolveSaveName, presetForPath, presetSwapNote } from "../src/savename.js";
import { exportFilters, PROJECT_FILTERS, getSnapshot, initPlatform, platform, type FileFilter } from "../src/platform.js";
import { clipIsLive, splitFrameFor } from "../src/editkeys.js";
import { PathBarEdits } from "../src/pathbar.js";
import type { Clip, Project } from "../src/types.js";
import * as unc from "@aive/core/unc";
import { allowDialogText, keepDialogText, userContextPath } from "../src/mediaservers.js";
import type { MediaServers } from "../src/types.js";

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

// The approval dialogs (electron/media-servers.cjs): the page's context only changes the wording, and
// only when the core's pending entry lists that path among its requests.
type Pending = { host: string; origins: string[]; files: number; examples: string[] };
type Box = { title: string; message: string; detail?: string; buttons: string[]; defaultId: number; cancelId: number };
type Store = { approved: { host: string; via: string }[]; outside: { host: string }[]; unread: string[] };
type Io = {
  show: (b: Box) => Promise<{ response: number }>; pendingEntry: (key: string) => Promise<Pending | undefined>;
  approve: (key: string, via: string) => Promise<void>; revoke: (key: string) => Promise<{ removed: boolean }>;
  recheck: () => Promise<void>; log: (t: string) => void;
};
type Review = { key: string; list: Store; via: string; context?: unknown; picked?: string; platform: string; unc: typeof unc };
const ms = createRequire(import.meta.url)("../electron/media-servers.cjs") as {
  userContextPath: (context: unknown, key: string, entry: Pending | undefined, u: typeof unc) => string | null;
  allowDialog: (o: { key: string; entry?: Pending; userPath: string | null; pickedPath?: string | null; platform: string }) => Box;
  keepDialog: (o: { key: string; entry?: Pending; platform: string }) => Box;
  reviewServer: (o: Review, io: Io) => Promise<boolean>;
  pickedHostsToAsk: (paths: string[], list: Store, dataDir: string, u: typeof unc) => { key: string; path: string }[];
  askPicked: (paths: string[], o: { readList: () => Store; dataDir: string; platform: string; unc: typeof unc }, io: Io) => Promise<string[]>;
};
const asked: Pending = { host: "nas", origins: ["request"], files: 0, examples: ["//nas/p/a.aive"] };
const user = { origin: "user", path: "//nas/p/a.aive" };
eq(ms.userContextPath(user, "nas", asked, unc), "//nas/p/a.aive", "the page opened a path the core lists → \"You opened\"");
eq(ms.userContextPath({ origin: "user", path: "//nas/p/b.aive" }, "nas", asked, unc), null, "a path the core doesn't list → ignored");
eq(ms.userContextPath({ origin: "user", path: "//other/p/a.aive" }, "nas", { ...asked, examples: ["//other/p/a.aive"] }, unc), null, "a path on another server → ignored");
eq(ms.userContextPath(user, "nas", { ...asked, origins: ["project"] }, unc), null, "no request from the core → ignored");
eq(ms.userContextPath({ origin: "agent", path: "//nas/p/a.aive" }, "nas", asked, unc), null, "not origin user → ignored");
eq(ms.userContextPath(user, "nas", undefined, unc), null, "nothing pending → ignored");
const allow = ms.allowDialog({ key: "nas", entry: asked, userPath: null, platform: "win32" });
eq([allow.title, allow.buttons, allow.defaultId, allow.cancelId], ["Allow media from \\\\nas?", ["Keep offline", "Allow"], 0, 0], "Allow dialog: Keep offline is the default and Esc");
eq(allow.detail?.split("\n\n")[0], "The AI assistant asked to open //nas/p/a.aive.", "…an agent's request says so");
eq(/scrambled copy of your password/.test(allow.detail ?? "") && !/scrambled/.test(ms.allowDialog({ key: "nas", userPath: null, platform: "linux" }).detail ?? ""), true, "…the Windows sign-in sentence only on Windows");
const keep = ms.keepDialog({ key: "evil", entry: { host: "evil", origins: ["outside", "project"], files: 2, examples: ["//evil/v/a.mp4"] }, platform: "linux" });
eq([keep.title, keep.buttons, keep.defaultId, keep.cancelId], ["Keep \\\\evil?", ["Remove", "Keep"], 0, 0], "Keep dialog: Remove is the default and Esc");
eq(keep.detail?.split("\n\n")[1], "This project uses 2 files stored there, for example //evil/v/a.mp4.", "…says what the project uses there");

// The web shell's in-app dialogs (src/mediaservers.ts) say exactly what the native ones say, with the same buttons
// (the first is the default and Esc), and take the page's context under the same rule.
const pendings: ((Pending & { display: string; since: string; origins: ("project" | "request" | "outside")[] }) | undefined)[] = [
  undefined, { ...asked, origins: ["request"], display: "\\\\nas", since: "" },
  { ...asked, origins: ["project"], files: 1, examples: ["//nas/v/a.mp4"], display: "\\\\nas", since: "" },
  { host: "nas", origins: ["project", "request", "outside"], files: 3, examples: ["//nas/v/a.mp4", "//nas/p/a.aive"], display: "\\\\nas", since: "" },
  { host: "nas", origins: ["outside"], files: 0, examples: [], display: "\\\\nas", since: "" },
];
const contexts = [undefined, user, { origin: "user", path: "//nas/p/b.aive" }, { origin: "user", path: "//NAS/p/a.aive" }, { origin: "agent", path: "//nas/p/a.aive" }, { origin: "user", path: 7 }];
let same = 0;
let total = 0;
for (const platform of ["win32", "linux", "darwin"]) {
  for (const entry of pendings) {
    const k = ms.keepDialog({ key: "nas", entry, platform });
    const wk = keepDialogText("nas", entry, platform);
    total++;
    if (JSON.stringify([k.title, k.message, k.detail, k.buttons]) === JSON.stringify([wk.title, wk.message, wk.detail, wk.buttons])) same++;
    else console.error("keep differs:", JSON.stringify(k), JSON.stringify(wk));
    for (const context of contexts) {
      const userPath = ms.userContextPath(context, "nas", entry, unc);
      const a = ms.allowDialog({ key: "nas", entry, userPath, platform });
      const wa = allowDialogText("nas", entry, userContextPath(context as Parameters<typeof userContextPath>[0], "nas", entry), platform);
      total++;
      if (JSON.stringify([a.title, a.message, a.detail, a.buttons]) === JSON.stringify([wa.title, wa.message, wa.detail, wa.buttons])) same++;
      else console.error("allow differs:", JSON.stringify(a), JSON.stringify(wa));
    }
  }
}
eq(`${same}/${total}`, `${total}/${total}`, "web dialogs: the same title, message, detail and buttons as the native ones (Allow and Keep, every context)");
eq(allowDialogText("nas", pendings[1], userContextPath(user, "nas", pendings[1]), "linux").detail.split("\n\n")[0], "You opened //nas/p/a.aive.", "web Allow dialog: the page's own path → \"You opened\"");
eq(allowDialogText("nas", pendings[1], userContextPath({ origin: "user", path: "//nas/p/b.aive" }, "nas", pendings[1]), "linux").detail.split("\n\n")[0], "The AI assistant asked to open //nas/p/a.aive.", "…a path the core doesn't list → the core's wording");

// The one flow behind Review… and the native pickers (electron/media-servers.cjs reviewServer and askPicked),
// against a store in memory: the dialogs it shows, and every write it makes.
function fakeMain(store: Store, answers: number[], opts: { removed?: boolean } = {}) {
  const shown: Box[] = [];
  const writes: string[] = [];
  const io: Io = {
    show: async (b) => {
      shown.push(b);
      return { response: b.buttons.length === 1 ? 0 : answers.shift() ?? 0 };
    },
    pendingEntry: async () => undefined,
    approve: async (key, via) => {
      writes.push(`approve ${key} ${via}`);
      store.outside = store.outside.filter((o) => o.host !== key);
      store.approved.push({ host: key, via });
    },
    revoke: async (key) => {
      writes.push(`revoke ${key}`);
      const removed = opts.removed ?? true;
      if (removed) store.outside = store.outside.filter((o) => o.host !== key);
      return { removed };
    },
    recheck: async () => { writes.push("recheck"); },
    log: () => {},
  };
  const pick = (paths: string[], dataDir = "/home/u/.zabsreel/data") =>
    ms.askPicked(paths, { readList: () => store, dataDir, platform: "linux", unc }, io);
  return { io, shown, writes, pick };
}
const emptyStore = (): Store => ({ approved: [], outside: [], unread: [] });
const PICK = "\\\\zr-pick.invalid\\s\\a.mp4";
async function pickerChecks() {
  eq(ms.pickedHostsToAsk([PICK, "//ZR-PICK.invalid/s/b.mp4", "/home/u/c.mp4"], emptyStore(), "/d", unc), [{ key: "zr-pick.invalid", path: PICK }],
    "picked paths: one question per server not allowed yet, none for a local file");
  eq(ms.pickedHostsToAsk([PICK, "\\\\nas@SSL\\s\\a.mp4", "//?/UNC/x/s/a.mp4"], { ...emptyStore(), approved: [{ host: "zr-pick.invalid", via: "prompt" }] }, "/d", unc), [],
    "…none for an allowed server, and a refused form is left to the core");
  eq(ms.pickedHostsToAsk(["//nas/zr/a.mp4"], emptyStore(), "//nas/zr", unc), [], "…none for the data folder's own server");

  let m = fakeMain(emptyStore(), [0]);
  const kept = await m.pick([PICK, "/home/u/c.mp4"]);
  eq([m.shown.map((b) => b.title), m.shown[0]?.detail?.split("\n\n")[0], m.shown[0]?.buttons], [["Allow media from \\\\zr-pick.invalid?"], `You picked ${PICK}.`, ["Keep offline", "Allow"]],
    "empty store, a file picked on \\\\zr-pick.invalid → the Allow dialog: \"You picked …\"");
  eq([m.writes, kept], [[], ["/home/u/c.mp4"]], "…Keep offline (0) → nothing written, and the picked path on that server is left out");

  const store = emptyStore();
  m = fakeMain(store, [1]);
  const allowed = await m.pick([PICK, "//zr-pick.invalid/s/b.mp4"]);
  eq([m.shown.length, m.writes, allowed], [1, ["approve zr-pick.invalid picker", "recheck"], [PICK, "//zr-pick.invalid/s/b.mp4"]],
    "…Allow (1) → one question for two files there, one write with via \"picker\", both paths kept");
  const again = fakeMain(store, [1]);
  eq([await again.pick([PICK]), again.shown.length, again.writes], [[PICK], 0, []], "…picked again once allowed: no question, no write");

  m = fakeMain({ ...emptyStore(), outside: [{ host: "zr-pick.invalid" }] }, [1]);
  await m.pick([PICK]);
  eq([m.shown[0]?.title, m.shown[0]?.buttons, m.writes], ["Keep \\\\zr-pick.invalid?", ["Remove", "Keep"], ["approve zr-pick.invalid picker", "recheck"]],
    "a picked file on a server added outside ZabsReel → the Keep dialog; Keep (1) saves it with via \"picker\"");
  m = fakeMain({ ...emptyStore(), outside: [{ host: "zr-pick.invalid" }] }, [0]);
  eq([await m.pick([PICK]), m.writes], [[], ["revoke zr-pick.invalid", "recheck"]], "…Remove (0) removes the outside entry and leaves the path out");

  m = fakeMain({ ...emptyStore(), unread: ["hosts.key"] }, [1]);
  eq([await m.pick([PICK]), m.shown.map((b) => b.buttons), m.writes], [[], [["OK"]], []], "unread store: a pick shows only the info box, writes nothing and leaves the path out");
  m = fakeMain({ ...emptyStore(), unread: ["hosts.key"] }, [1]);
  eq([await ms.reviewServer({ key: "nas", list: { ...emptyStore(), unread: ["hosts.key"] }, via: "prompt", platform: "linux", unc }, m.io), m.shown.map((b) => [b.title, b.buttons]), m.writes],
    [false, [["Network computers", ["OK"]]], []], "Review… while the store is unread: only the info box (OK), no write, resolves false");

  const outside = (): Store => ({ ...emptyStore(), outside: [{ host: "evil" }] });
  m = fakeMain(outside(), [0], { removed: false });
  eq([await ms.reviewServer({ key: "evil", list: outside(), via: "prompt", platform: "linux", unc }, m.io), m.writes], [true, ["revoke evil", "recheck"]],
    "Keep dialog, Remove or Esc after another window kept it ({removed: false}) → resolves true (allowed)");
  m = fakeMain(outside(), [0], { removed: true });
  eq(await ms.reviewServer({ key: "evil", list: outside(), via: "prompt", platform: "linux", unc }, m.io), false, "…and when it was removed → false");
  m = fakeMain(emptyStore(), [1]);
  eq([await ms.reviewServer({ key: "nas", list: emptyStore(), via: "prompt", platform: "linux", unc }, m.io), m.writes], [true, ["approve nas prompt", "recheck"]], "Review… Allow → saved with via \"prompt\"");
}

// The web shell (src/platform.ts): a review asked for while one is open waits for its answer; it never answers
// the open one for the user (false would be Remove in a Keep dialog). Its Keep dialog's Remove after another tab
// kept the server resolves true, and the unread state shows only its note.
async function webReviewChecks() {
  let servers: MediaServers = { gate: "enforce", approved: [], outside: [{ host: "zr-evil-3.invalid", display: "\\\\zr-evil-3.invalid" }], unread: [], pending: [] };
  const posts: string[] = [];
  let removed = true;
  (globalThis as { window?: object }).window = {};
  globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") posts.push(`${url} ${init.body}`);
    const body = url === "/api/config" ? { platform: "linux", sep: "/", home: "/home/u", places: [], mcp: { available: false, packaged: false, mcpEntry: null, json: "" } }
      : url.endsWith("/revoke") ? { ok: true, removed } : { ok: true };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  eq(await initPlatform("k", async () => servers), "web", "web shell host detected (fetch stubbed)");
  const tick = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
  const first = platform.approveMediaServer("zr-evil-3.invalid");
  await tick();
  const open = getSnapshot().review;
  const second = platform.approveMediaServer("zr-evil-3.invalid");
  await tick();
  eq([open?.kind, getSnapshot().review?.id === open?.id, posts], ["keep", true, []], "a second review while the Keep dialog is open: the open one stays, nothing is posted");
  servers = { ...servers, outside: [], approved: [{ host: "zr-evil-3.invalid", display: "\\\\zr-evil-3.invalid", via: "prompt", added: "" }] };
  open?.resolve(true);
  eq([await first, await second, posts.map((p) => p.split(" ")[0]), getSnapshot().review], [true, true, ["/api/media-servers/approve"], null],
    "…Keep in it: one approve, and the second review then finds the server allowed and asks nothing");

  servers = { ...servers, approved: [], outside: [{ host: "zr-evil-3.invalid", display: "\\\\zr-evil-3.invalid" }] };
  removed = false;
  posts.length = 0;
  const esc = platform.approveMediaServer("zr-evil-3.invalid");
  await tick();
  getSnapshot().review?.resolve(false);
  eq([await esc, posts], [true, ['/api/media-servers/revoke {"host":"zr-evil-3.invalid","onlyIfOutside":true}']],
    "Keep dialog, Remove or Esc after another tab kept it (removed: false) → resolves true (allowed)");

  servers = { ...servers, unread: ["hosts.key"] };
  posts.length = 0;
  const unread = platform.approveMediaServer("zr-evil-3.invalid");
  await tick();
  const note = getSnapshot().review;
  note?.resolve(false);
  eq([note?.kind, await unread, posts], ["unread", false, []], "unread store: only the note, resolves false, nothing posted");
}

// A check that waits on a promise nobody settles would otherwise let node exit with 0.
process.on("beforeExit", () => {
  console.log("FAIL the async checks did not finish (a dialog or request never settled)");
  process.exit(1);
});
void (async () => {
  await pickerChecks();
  await webReviewChecks();
  process.exit(failed ? 1 : 0);
})();
