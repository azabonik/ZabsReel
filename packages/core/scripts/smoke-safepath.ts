/**
 * Security smoke: a crafted .aive / .otio can neither write outside the data
 * dir (PATH TRAVERSAL) nor make FFmpeg/ffprobe open a URL/protocol (SSRF).
 *
 * Layered guards, each observed by its OWN assertion so a single-layer
 * regression is caught (see the MUTATION notes next to each group):
 *   1. safeFileStem()          — ids used in filenames stay inside the data dir.
 *   2. isLocalMediaPath/assert — classify local paths vs protocols (incl. Windows).
 *   3. sanitizeProjectIds      — load/import rewrites non-token ids.
 *   4. assertProjectMediaLocal — load/import refuses non-local media.
 *   5. guardFfmpegArgs/Ffprobe — the executor refuses a protocol input or a
 *                                filter that opens its own source (movie=,
 *                                subtitles=, zmq …), whatever leaked.
 *   5b. -protocol_whitelist    — FFmpeg itself refuses any non-file input.
 * One layer has no assertion of its own: importOtio skips probing a protocol
 * target_url, but guardFfprobeArgs refuses the same probe and the probe error
 * is swallowed, so nothing observable changes without the skip (it only saves
 * a refused probe). Section 4 covers the import as a whole.
 *
 * Self-contained: synthesizes its own clip with ffmpeg lavfi, binds its SSRF
 * listener on 127.0.0.1:0 and closes it. No media arguments, no network egress.
 * Run: npx tsx packages/core/scripts/smoke-safepath.ts
 */
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { EditorEngine } from "../src/engine.js";
import { runFfmpeg, runFfprobe, guardFfmpegArgs, guardFfprobeArgs, ffmpegArgsLocalOnly } from "../src/ffmpeg/executor.js";
import {
  safeFileStem,
  isLocalMediaPath,
  looksLikeProtocol,
  assertLocalMediaPath,
  sanitizeProjectIds,
} from "../src/safepath.js";
import { drawTextStep } from "../src/ffmpeg/graph.js";
import type { Project } from "../src/types.js";

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};
const threw = async (fn: () => unknown, label: string): Promise<boolean> => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};

async function main() {
  const root = mkdtempSync(join(tmpdir(), "aive-safepath-"));
  const dataDir = join(root, "data");
  const clip = join(root, "a.mp4");
  await runFfmpeg([
    "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-pix_fmt", "yuv420p", "-shortest", "-y", clip,
  ]);

  // ---- 1. safeFileStem ------------------------------------------------------
  // MUTATION: make safeFileStem return its argument unchanged → the traversal
  // and "never empty" checks below fail.
  console.log("1. safeFileStem...");
  check(safeFileStem("asset_abc123") === "asset_abc123", "a legitimate id passes through unchanged");
  check(safeFileStem("clip_0a9z_-X") === "clip_0a9z_-X", "a plain token with _ and - is unchanged");
  for (const bad of ["../../x", "..\\..\\x", "a/b", "a\0b", "a:b", ".."]) {
    const s = safeFileStem(bad);
    check(!/[\/\\.:\0]/.test(s) && s.length > 0, `"${bad.replace(/\0/g, "\\0")}" → "${s}" (no path chars, non-empty)`);
  }
  check(safeFileStem("") === "id", "an empty id collapses to a safe, non-empty stem");
  check(safeFileStem("x".repeat(200)).length <= 64, "an over-long id is bounded to 64 chars");

  // ---- 2. media-path classification (incl. Windows) -------------------------
  // MUTATION: make looksLikeProtocol() always return false → the http/file/
  // data/concat rows and assertLocalMediaPath-throws rows fail.
  console.log("2. local vs protocol classification...");
  for (const p of ["/home/u/a.mp4", "/tmp/x.mov", "C:\\Users\\a\\v.mp4", "c:/users/a/v.mp4", "\\\\server\\share\\v.mp4"]) {
    check(isLocalMediaPath(p), `local: ${p}`);
  }
  for (const p of [
    "http://127.0.0.1/a", "https://evil/a", "file:///etc/passwd", "data:text/plain,hi",
    "concat:a|b", "subfile,,start,0,end,0:::/x", "rtmp://h/a", "ftp://h/a", "async:tcp://h:1",
    "\\\\?\\C:\\x", "\\\\.\\PhysicalDrive0", "relative/path.mp4", "a.mp4", "",
  ]) {
    check(!isLocalMediaPath(p), `not local: ${JSON.stringify(p)}`);
  }
  check(looksLikeProtocol("http://x") && !looksLikeProtocol("C:\\x") && !looksLikeProtocol("/x"), "C:\\ is not a protocol; http:// is");
  check(await threw(() => assertLocalMediaPath("http://127.0.0.1/a", "field"), ""), "assertLocalMediaPath throws on a URL");
  check(assertLocalMediaPath("/ok/a.mp4", "field") === "/ok/a.mp4", "assertLocalMediaPath returns a local path");

  // Build a legitimate template project to craft the attacks from.
  const base = new EditorEngine(join(dataDir, "seed"));
  const seedAsset = await base.importVideo(clip);
  const seedClip = base.addClip(seedAsset.id, { sourceOutFrame: 10 });
  base.addTextOverlay(seedClip.id, { text: "hi", box: true });
  const legitFile = join(root, "legit.aive");
  await base.save(legitFile);
  const tpl = JSON.parse(readFileSync(legitFile, "utf8")) as Project;

  // ---- 3. PATH TRAVERSAL: a crafted .aive stays inside the data dir ---------
  // MUTATION: comment out sanitizeProjectIds in engine.load() → the id-token
  // assertion fails AND a bake escapes (the ESCAPED-* assertion fails).
  console.log("3. traversal .aive is contained + ids rewritten...");
  const trav = structuredClone(tpl);
  trav.id = "../../ESCAPED-proj";
  trav.assets[0].id = "../../ESCAPED-asset";
  trav.tracks[0].clips[0].id = "../../ESCAPED-clip";
  trav.tracks[0].clips[0].assetId = "../../ESCAPED-asset";
  trav.tracks[0].clips[0].overlays![0].id = "../../ESCAPED-ov";
  // Not an id but a scalar that reaches a file name (previews/preview-<revision>-…mp4)
  // and graph strings: a string survives `revision += 1`, so it must be a number after load.
  // MUTATION: comment out coerceProjectNumbers in engine.load() → the revision checks fail.
  (trav as unknown as Record<string, unknown>).revision = "../../ESCAPED-rev";
  (trav as unknown as Record<string, unknown>).fps = "30,movie=x";
  // The engine's data dir is one level under an isolated "escape sandbox": a
  // `../../x` id writing from <travDir>/<area>/ therefore lands in escapeRoot
  // (outside the data dir) if a guard fails, where the scan below catches it.
  const escapeRoot = join(root, "escape");
  const travDir = join(escapeRoot, "data");
  mkdirSync(travDir, { recursive: true });
  const travFile = join(root, "traversal.aive");
  writeFileSync(travFile, JSON.stringify(trav));
  const e1 = new EditorEngine(travDir);
  const loaded = await e1.load(travFile);
  const TOKEN = /^[A-Za-z0-9_-]+$/;
  const everyId = [
    loaded.id,
    ...loaded.assets.map((a) => a.id),
    ...loaded.tracks.map((t) => t.id),
    ...loaded.tracks.flatMap((t) => t.clips.flatMap((c) => [c.id, ...(c.overlays ?? []).map((o) => o.id)])),
  ];
  check(everyId.every((id) => TOKEN.test(id)), `every id in the loaded project is a plain token (${everyId.length} ids)`);
  check(!loaded.assets.some((a) => a.id.includes("..")) && !loaded.tracks.some((t) => t.clips.some((c) => c.id.includes(".."))), "no id still contains '..'");
  check(typeof loaded.revision === "number" && Number.isFinite(loaded.revision), `a string revision is a number after load (${JSON.stringify(loaded.revision)})`);
  check(loaded.fps === 30, `a non-numeric fps falls back to 30 (${JSON.stringify(loaded.fps)})`);
  // Drive bakes through the real engine with the (now-clean) ids.
  const freshAsset = loaded.assets[0].id;
  const freshClip = loaded.tracks[0].clips[0].id;
  await e1.generateThumbnail(freshAsset, 0).catch(() => {});
  await e1.generateProxy(freshAsset).catch(() => {});
  await e1.freezeFrame(freshClip, 0, 1).catch(() => {});
  await e1.renderPreview().catch((err) => console.log(`    renderPreview error: ${(err as Error).message}`));
  // Everything the engine wrote must stay under its data dir: scan the escape
  // sandbox for anything OUTSIDE <travDir>, and for any ESCAPED-* name anywhere.
  const walk = (dir: string, acc: string[]): string[] => {
    for (const n of readdirSync(dir)) {
      const full = join(dir, n);
      if (n.includes("ESCAPED")) acc.push(full);
      if (statSync(full).isDirectory()) walk(full, acc);
    }
    return acc;
  };
  const outside = readdirSync(escapeRoot).filter((n) => join(escapeRoot, n) !== travDir);
  check(outside.length === 0, `nothing written outside the engine's data dir (found: ${JSON.stringify(outside)})`);
  check(walk(escapeRoot, []).length === 0, "no ESCAPED-* file exists anywhere in the sandbox");

  // ---- SSRF listener (127.0.0.1, ephemeral, recorded, then closed) ----------
  const hits: string[] = [];
  const srv: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  const url = (name: string) => `http://127.0.0.1:${port}/${name}`;

  const guardThrew = (args: string[]) => { try { guardFfmpegArgs(args); return false; } catch { return true; } };
  try {
    // ---- 4. SSRF: load/import refuse non-local media ----------------------
    // MUTATION: remove assertProjectMediaLocal from load()/importOtio() → the
    // "load refused" / "import refused" assertions fail (load succeeds).
    console.log("4. crafted .aive / .otio media is refused (no probe)...");
    const ssrf = structuredClone(tpl);
    ssrf.assets[0].path = url("aive-asset.mp4");
    const ssrfFile = join(root, "ssrf.aive");
    writeFileSync(ssrfFile, JSON.stringify(ssrf));
    const e2 = new EditorEngine(join(dataDir, "ssrf"));
    check(await threw(() => e2.load(ssrfFile), ""), "load refuses a .aive whose asset.path is a URL");

    const ssrfLut = structuredClone(tpl);
    ssrfLut.tracks[0].clips[0].effects = { ...(ssrfLut.tracks[0].clips[0].effects ?? {}), lut: url("x.cube") };
    const lutFile = join(root, "ssrf-lut.aive");
    writeFileSync(lutFile, JSON.stringify(ssrfLut));
    const e2b = new EditorEngine(join(dataDir, "ssrflut"));
    check(await threw(() => e2b.load(lutFile), ""), "load refuses a .aive whose clip LUT is a URL");

    await base.exportOtio(join(root, "t.otio"));
    const otio = JSON.parse(readFileSync(join(root, "t.otio"), "utf8"));
    if (otio.metadata?.synthcut?.assets?.[0]) otio.metadata.synthcut.assets[0].path = url("otio-meta.mp4");
    for (const trk of otio.tracks.children) {
      for (const it of trk.children ?? []) {
        if (typeof it.OTIO_SCHEMA === "string" && it.OTIO_SCHEMA.startsWith("Clip")) {
          const ref = it.media_references?.[it.active_media_reference_key ?? "DEFAULT_MEDIA"] ?? it.media_reference;
          if (ref) ref.target_url = url("otio-ref.mp4");
        }
      }
    }
    writeFileSync(join(root, "ssrf.otio"), JSON.stringify(otio));
    const e3 = new EditorEngine(join(dataDir, "ssrfotio"));
    check(await threw(() => e3.importOtio(join(root, "ssrf.otio")), ""), "import_otio refuses a URL target_url / meta path");

    // A refused open leaves the OPEN project exactly as it was: same project,
    // path, dirty state and undo history, so the next autosave (open/new call
    // autoSaveIfDirty) writes the user's own project, not the refused one.
    // MUTATION: in load() assign this.project / clear the undo stack before the
    // checks → the "unchanged" and "autosave keeps" assertions fail.
    const goodFile = join(root, "good.aive");
    writeFileSync(goodFile, readFileSync(legitFile));
    const e5 = new EditorEngine(join(dataDir, "refused"));
    await e5.load(goodFile);
    e5.addTextOverlay(e5.getProject().tracks[0].clips[0].id, { text: "unsaved edit" });
    const before = e5.getProject();
    const beforeRev = before.revision;
    for (const [label, open] of [
      ["load", () => e5.load(ssrfFile)],
      ["import_otio", () => e5.importOtio(join(root, "ssrf.otio"))],
    ] as const) {
      check(await threw(open, ""), `${label} of a crafted file is refused`);
      check(e5.getProject() === before && e5.getProject().revision === beforeRev, `a refused ${label} keeps the open project`);
      check(e5.getCurrentPath() === goodFile, `a refused ${label} keeps the current path`);
      check(e5.isDirty(), `a refused ${label} keeps the unsaved-edit (dirty) state`);
    }
    const autosaved = await e5.autoSaveIfDirty();
    const onDisk = JSON.parse(readFileSync(goodFile, "utf8")) as Project;
    check(autosaved === goodFile && onDisk.assets[0].path === clip, `autosave after a refused open writes the user's project (asset path ${JSON.stringify(onDisk.assets[0].path)})`);
    check(onDisk.tracks[0].clips[0].overlays!.some((o) => o.text === "unsaved edit"), "the autosaved file keeps the unsaved edit");
    check(e5.undo() && !e5.getProject().tracks[0].clips[0].overlays!.some((o) => o.text === "unsaved edit"), "the undo history survives a refused open");

    // Relative media references are NOT a network vector: a .aive / foreign OTIO
    // with a scheme-free relative path must still LOAD (offline placeholder for
    // a missing file), and the listener must still see nothing.
    const relAive = structuredClone(tpl);
    relAive.assets[0].path = "media/relative-clip.mp4"; // no scheme → local, just missing
    const relFile = join(root, "relative.aive");
    writeFileSync(relFile, JSON.stringify(relAive));
    const e3b = new EditorEngine(join(dataDir, "rel"));
    check(!(await threw(() => e3b.load(relFile), "")), "load ACCEPTS a .aive with a relative (scheme-free) asset path");

    const relOtio = JSON.parse(readFileSync(join(root, "t.otio"), "utf8"));
    for (const trk of relOtio.tracks.children) {
      for (const it of trk.children ?? []) {
        if (typeof it.OTIO_SCHEMA === "string" && it.OTIO_SCHEMA.startsWith("Clip")) {
          const ref = it.media_references?.[it.active_media_reference_key ?? "DEFAULT_MEDIA"] ?? it.media_reference;
          if (ref) ref.target_url = "media/relative-shot.mov";
        }
      }
    }
    if (relOtio.metadata?.synthcut?.assets) relOtio.metadata.synthcut.assets = [];
    writeFileSync(join(root, "relative.otio"), JSON.stringify(relOtio));
    const e3c = new EditorEngine(join(dataDir, "relotio"));
    const relImp = await e3c.importOtio(join(root, "relative.otio")).catch(() => null);
    check(relImp !== null, "import_otio ACCEPTS a relative target_url (offline placeholder)");
    check(!!relImp && relImp.project.assets.some((a) => a.missing), "the relative-path asset is an offline placeholder (missing:true)");

    // ---- 4c. legitimate non-POSIX media still loads; caches and numbers ----
    // A project saved on Windows (drive-letter and UNC media, a drive-letter
    // LUT), a POSIX name with a colon and an old relative proxy bake must load
    // with those paths kept, and the same paths must pass the executor guard.
    // MUTATION: test SCHEME before WIN_DRIVE in looksLikeProtocol → the C:\
    // rows fail (`C:` reads as scheme "C").
    console.log("4c. Windows / UNC / colon-in-name media loads unchanged...");
    const winPaths = ["C:\\Users\\a\\clip.mp4", "\\\\nas\\share\\clip.mp4", "/x/clip 10:30.mp4"];
    const winAive = structuredClone(tpl);
    winAive.assets = winPaths.map((p, i) => ({ ...structuredClone(tpl.assets[0]), id: `asset_win${i}`, path: p }));
    winAive.assets[0].proxyPath = "proxies/old-proxy.mp4";
    winAive.tracks[0].clips[0].assetId = "asset_win0";
    winAive.tracks[0].clips[0].effects = { ...(winAive.tracks[0].clips[0].effects ?? {}), lut: "C:\\luts\\look.cube" };
    writeFileSync(join(root, "windows.aive"), JSON.stringify(winAive));
    const ew = new EditorEngine(join(dataDir, "win"));
    const winLoaded = await ew.load(join(root, "windows.aive")).catch((err) => { console.log(`    load error: ${(err as Error).message}`); return null; });
    check(!!winLoaded && winPaths.every((p, i) => winLoaded.assets[i]?.path === p), "load ACCEPTS C:\\, UNC and colon-in-name asset paths unchanged");
    check(winLoaded?.assets[0].proxyPath === "proxies/old-proxy.mp4", "a relative proxyPath bake is kept on load");
    check(winLoaded?.tracks[0].clips[0].effects?.lut === "C:\\luts\\look.cube", "a C:\\ LUT is kept on load");
    for (const p of [...winPaths, "C:\\luts\\look.cube"]) {
      check(!guardThrew(["-i", p, "-f", "null", "-"]) && !guardThrew(["-hide_banner", "-i", p]), `guardFfmpegArgs passes ${JSON.stringify(p)}`);
      let probeRefused = false; try { guardFfprobeArgs(["-show_format", p]); } catch { probeRefused = true; }
      check(!probeRefused, `guardFfprobeArgs passes ${JSON.stringify(p)}`);
    }
    // MUTATION: delete the colorPath assert in assertProjectMediaLocal → the
    // cutout row fails; delete the proxyPath drop → the proxy row fails.
    const cut = structuredClone(tpl);
    cut.assets[0].cutout = { colorPath: url("colour.mp4"), colorStart: 0 };
    writeFileSync(join(root, "cutout-url.aive"), JSON.stringify(cut));
    check(await threw(() => new EditorEngine(join(dataDir, "cut")).load(join(root, "cutout-url.aive")), ""), "load refuses a .aive whose cutout colour path is a URL");
    const prox = structuredClone(tpl);
    prox.assets[0].proxyPath = url("proxy.mp4");
    prox.assets[0].previewPath = url("preview.mp4");
    writeFileSync(join(root, "proxy-url.aive"), JSON.stringify(prox));
    const proxLoaded = await new EditorEngine(join(dataDir, "prox")).load(join(root, "proxy-url.aive")).catch(() => null);
    check(!!proxLoaded && proxLoaded.assets[0].proxyPath === undefined && proxLoaded.assets[0].previewPath === undefined,
      "load drops a URL proxyPath / previewPath (and still loads)");
    // MUTATION: delete the clip loop in coerceProjectNumbers → the startFrame row
    // fails; delete the width line → the width row fails.
    const nums = structuredClone(tpl) as unknown as Record<string, unknown> & Project;
    const c0 = nums.tracks[0].clips[0] as unknown as Record<string, unknown>;
    c0.startFrame = "5;x";
    c0.sourceOutFrame = "10,movie=x";
    nums.width = "1920,movie=" as unknown as number;
    writeFileSync(join(root, "numbers.aive"), JSON.stringify(nums));
    const numLoaded = await new EditorEngine(join(dataDir, "nums")).load(join(root, "numbers.aive"));
    const nc = numLoaded.tracks[0].clips[0];
    check(typeof nc.startFrame === "number" && typeof nc.sourceOutFrame === "number", `string clip timing is a number after load (${JSON.stringify([nc.startFrame, nc.sourceOutFrame])})`);
    check(numLoaded.width === 1920, `a string project width falls back to 1920 (${JSON.stringify(numLoaded.width)})`);

    // ---- 4d. user RPC input: LUT and import refuse URLs in TypeScript ------
    // The message must be the TS one ("URL/protocol"), not FFmpeg's or the
    // executor's: the lut3d filter is not an -i input the executor checks.
    // MUTATION: delete assertLocalMediaPath in setClipEffects → the LUT row fails.
    console.log("4d. set_clip_effects / import_video refuse a URL...");
    const errOf = async (fn: () => unknown): Promise<string> => {
      try { await fn(); return "(accepted)"; } catch (err) { return (err as Error).message; }
    };
    const lutErr = await errOf(() => base.setClipEffects(seedClip.id, { lut: url("x.cube") }));
    check(/URL\/protocol/.test(lutErr), `set_clip_effects refuses a URL LUT (${lutErr.slice(0, 80)})`);
    check(base.getProject().tracks[0].clips[0].effects?.lut === undefined, "the refused LUT is not set on the clip");
    const impErr = await errOf(() => base.importVideo(url("v.mp4")));
    check(impErr !== "(accepted)" && !/ffprobe|Refusing/.test(impErr), `import_video refuses a URL before any probe (${impErr.slice(0, 80)})`);

    // ---- 5. executor backstop: a protocol input never reaches the wire ----
    // MUTATION: remove guardFfmpegArgs/guardFfprobeArgs from runFfmpeg/
    // runFfprobe → these connect and `hits` grows (the 0-request assertion fails).
    console.log("5. executor refuses protocol inputs + movie= sources...");
    // (a) real runs: a protocol input must never reach the wire — the 0-request
    //     assertion below is what catches a removed guard (a bad input still
    //     makes ffmpeg "throw" after it has already connected).
    check(await threw(() => runFfmpeg(["-i", url("direct.mp4"), "-f", "null", "-"]), ""), "runFfmpeg refuses an http -i input");
    check(await threw(() => runFfprobe(["-of", "json", "-show_format", url("probe.mp4")]), ""), "runFfprobe refuses an http input");
    check(await threw(() => runFfmpeg(["-i", "data:application/octet-stream;base64,AAAA", "-f", "null", "-"]), ""), "runFfmpeg refuses a data: input");
    check(hits.length === 0, `the 127.0.0.1 listener received NO request across all scenarios (got ${hits.length}: ${JSON.stringify(hits)})`);
    // (b) guard function directly (deterministic, no dependence on ffmpeg's own
    //     fetch behaviour): the movie=/amovie= branch and the input branch.
    check(guardThrew(["-vf", `movie=${url("inj.mp4")}`]), "guardFfmpegArgs refuses a movie= filter source");
    check(guardThrew(["-filter_complex", `[0]amovie=${url("x.mp4")}[a]`]), "guardFfmpegArgs refuses an amovie= filter source");
    check(guardThrew(["-i", url("x.mp4")]), "guardFfmpegArgs refuses an http -i input");
    check(!guardThrew(["-f", "lavfi", "-i", "anullsrc", "-vf", "scale=16:16,format=yuv420p", "-i", "/abs/a.mp4", "-i", "C:\\a.mp4"]), "guardFfmpegArgs passes lavfi + local + drive-letter inputs");
    let probeGuardThrew = false; try { guardFfprobeArgs(["-of", "json", url("p.mp4")]); } catch { probeGuardThrew = true; }
    check(probeGuardThrew, "guardFfprobeArgs refuses a URL last positional");
    // (c) every filter that opens its own source, in any filter-name position
    //     and with an @instance name; the core's own sendcmd/lut3d/vidstab/
    //     drawtext/metadata graphs (and labels that merely contain the names) pass.
    // Names are read the way libavfilter's graph parser reads them (filterGraphNames),
    // so a quoted or escaped name ('movie'=, mo\vie=, both accepted by FFmpeg 4.4 and
    // 8.1) is still caught; a pattern match on the raw text would miss them.
    // MUTATION: shrink FORBIDDEN_FILTERS back to movie|amovie → the subtitles/
    // ass/zmq rows fail; stop avGetToken unquoting/unescaping → the quoted and
    // escaped movie rows fail; keep the "@id" in the name → the movie@a row fails.
    for (const [flag, g] of [
      ["-vf", `movie@a=${url("m.mp4")}`],
      ["-vf", `scale=16:16,subtitles=${url("s.srt")}`],
      ["-filter_complex", "[0:v]ass=x.ass[v]"],
      ["-vf", "zmq,null"],
      ["-af", "anull,azmq"],
      ["-vf", "frei0r=filter_name=/tmp/x.so"],
      ["-af", "ladspa=file=/tmp/x.so"],
      ["-filter_complex", `[0:v]null[v]; amovie@x =${url("a.mp4")}[a]`],
      ["-filter_complex", `'movie'=${url("q.mp4").replace(/:/g, "\\:")}[m];[0:v][m]overlay`],
      ["-vf", "mo\\vie=x.mp4"],
      ["-vf", "null,\n sub'titles'=x.srt"],
    ] as const) {
      check(guardThrew([flag, g]), `guardFfmpegArgs refuses ${flag} ${JSON.stringify(g)}`);
    }
    check(guardThrew(["-f", "lavfi", "-i", `movie=${url("l.mp4")}`]), "guardFfmpegArgs scans a -f lavfi -i graph for movie=");
    check(guardThrew(["-f", "lavfi", "-t", "1", "-i", `amovie=${url("l.mp4")}`]), "…also when another input option sits between -f lavfi and -i");
    check(guardThrew(["-vf", "scale=16:16,'unterminated"]), "guardFfmpegArgs refuses a graph it can't read (unterminated quote)");
    // Graph options are matched by base name, as FFmpeg reads them: a stream
    // specifier (-filter:v:0, -af:1) or the plain -filter still gets its graph
    // checked, and a graph read from a file (-/vf, -filter_script, -filter_complex_script)
    // is refused outright: the core passes graphs inline (runFfmpeg's own script
    // file is written after this check).
    // MUTATION: match only the exact flag set (-filter_complex, -vf, -af, -lavfi,
    // -filter:v, -filter:a) and ignore file options → these five rows fail.
    check(guardThrew(["-filter:v:0", `movie=${url("s.mp4")}`]), "guardFfmpegArgs checks the graph of -filter:v:0 (a stream specifier)");
    check(guardThrew(["-af:0", `amovie=${url("s.mp3")}`]), "guardFfmpegArgs checks the graph of -af:0");
    check(guardThrew(["-filter", "subtitles=x.srt"]), "guardFfmpegArgs checks the graph of a bare -filter");
    check(guardThrew(["-/vf", join(root, "graph.txt")]), "guardFfmpegArgs refuses -/vf (a graph read from a file)");
    check(guardThrew(["-filter_complex_script", join(root, "graph.txt")]) && guardThrew(["-filter_script:v", join(root, "graph.txt")]), "guardFfmpegArgs refuses -filter_complex_script / -filter_script");
    check(!guardThrew(["-i", "/abs/a.mp4", "-filter:v", "signalstats,metadata=print", "-f", "null", "-"]), "guardFfmpegArgs passes the core's own -filter:v graph (analysis.ts)");
    for (const g of [
      "sendcmd=f=c-reframe.txt,crop=10:10:0:0,scale=16:16",
      "lut3d=file=look.cube:interp=tetrahedral",
      "drawtext=textfile=t.txt:fontfile=f.ttf:fontsize=48",
      "vidstabtransform=input=t.trf:smoothing=10",
      "signalstats,metadata=print",
      "[0:a]volume=1[bass];[bass]anull[movie_out]",
      "drawtext=text='Movie\\, ass\\: 10\\:30':fontsize=48,setpts='(PTS-STARTPTS)/2'",
      "[a\\]b]null[o]",
    ]) {
      check(!guardThrew(["-filter_complex", g]), `guardFfmpegArgs passes the core's own graph ${JSON.stringify(g)}`);
    }

    // ---- 5b. FFmpeg's own protocol whitelist on every input ------------------
    // The TypeScript guard re-implements FFmpeg's input-name parsing; FFmpeg
    // itself must also refuse a non-file input. A -f concat list is exempt from
    // the TS guard (its entries are not args), so a data: entry in one is
    // opened (default nested whitelist file,crypto,data) unless the executor
    // passes -protocol_whitelist file,pipe,fd.
    // MUTATION: make ffmpegArgsLocalOnly / ffprobeArgsLocalOnly return the args
    // without the whitelist → the concat render/probe succeed and these fail.
    console.log("5b. FFmpeg refuses non-file protocols itself (-protocol_whitelist)...");
    const wav = join(root, "tiny.wav");
    await runFfmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", "-y", wav]);
    const dataList = join(root, "data-list.txt");
    writeFileSync(dataList, `file 'data:audio/wav;base64,${readFileSync(wav).toString("base64")}'\n`);
    const whitelistRefusal = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn();
        return "(no error: the data: entry was opened)";
      } catch (err) {
        const e = err as { message?: string; stderr?: string };
        return `${e.message ?? ""} ${e.stderr ?? ""}`;
      }
    };
    const ffErr = await whitelistRefusal(() => runFfmpeg(["-f", "concat", "-safe", "0", "-i", dataList, "-f", "null", "-"]));
    check(/not on whitelist 'file,pipe,fd'/.test(ffErr), `runFfmpeg: FFmpeg refuses a data: entry in a concat list (${ffErr.slice(0, 120).trim()})`);
    const fpErr = await whitelistRefusal(() => runFfprobe(["-v", "error", "-f", "concat", "-safe", "0", "-show_format", dataList]));
    check(/not on whitelist 'file,pipe,fd'/.test(fpErr), `runFfprobe: ffprobe refuses a data: entry in a concat list (${fpErr.slice(0, 120).trim()})`);
    const wl = ffmpegArgsLocalOnly(["-f", "lavfi", "-i", "anullsrc", "-i", "/a.mp4", "-map", "1", "-y", "/o.mp4"]);
    check(wl.filter((a) => a === "-protocol_whitelist").length === 2 && wl[wl.indexOf("/a.mp4") - 3] === "-protocol_whitelist",
      `ffmpegArgsLocalOnly puts the whitelist before every -i (${wl.join(" ")})`);
    // The subfile protocol is FFmpeg's one comma form (no `scheme:` prefix): the TS parser reads it as a protocol too.
    // MUTATION: drop SUBFILE from looksLikeProtocol → these fail.
    const subfile = `subfile,,start,0,end,0,,:${clip}`;
    check(looksLikeProtocol(subfile) && guardThrew(["-i", subfile]), "the subfile,…: form is a protocol to the TS guard");
    const subAive = structuredClone(tpl);
    subAive.assets[0].path = subfile;
    writeFileSync(join(root, "subfile.aive"), JSON.stringify(subAive));
    check(await threw(() => new EditorEngine(join(dataDir, "subfile")).load(join(root, "subfile.aive")), ""), "load refuses a .aive whose asset.path is a subfile,…: form");

    // ---- positive: the guard leaves the core's own inputs working ---------
    console.log("6. legitimate inputs still pass the guard...");
    const okOut = join(root, "guard-ok.png");
    const guardOk = await threw(async () => {
      await runFfmpeg(["-f", "lavfi", "-i", "color=c=red:s=16x16:d=0.1", "-frames:v", "1", "-y", okOut]);
    }, "");
    check(!guardOk && existsSync(okOut), "a -f lavfi input + local output render passes the guard");
    const probeOk = await threw(() => runFfprobe(["-v", "quiet", "-show_format", clip]), "");
    check(!probeOk, "ffprobe of a local absolute path passes the guard");
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }

  // ---- 7. a fully legitimate project is unaffected --------------------------
  console.log("7. a legitimate project loads and renders unchanged...");
  const sane = sanitizeProjectIds(structuredClone(tpl));
  check(sane === 0, "sanitizeProjectIds rewrites nothing in a legitimate project");
  const e4 = new EditorEngine(join(dataDir, "legit2"));
  await e4.load(legitFile);
  const frame = await e4.renderFrame(0).catch((err) => { console.log(`    renderFrame error: ${(err as Error).message}`); return ""; });
  check(frame.startsWith(join(dataDir, "legit2")) && existsSync(frame), "renderFrame writes inside the data dir");

  // ---- 8. drawtext style fields are coerced -----------------------------------
  // A crafted overlay style must not add an option or filter to the drawtext
  // step; the colours the core and desktop really use must pass unchanged.
  // MUTATION: use ov.fontSize / ov.boxColor raw in drawTextStep → the crafted
  // rows fail; tighten DT_COLOR (e.g. drop the @alpha part) → the legit rows fail.
  console.log("8. drawtext style coercion...");
  const ovBase = { textFile: "t.txt", fontFile: "f.ttf", fontSize: 48, color: "white", box: false, boxColor: "black@0.55", boxBorderW: 12, position: "bottom" };
  const crafted = drawTextStep({
    ...ovBase,
    fontSize: "12,movie=x" as unknown as number,
    color: "red:x=0,movie=x" as string,
    box: true,
    boxColor: "black:x=0,movie=x",
    boxBorderW: "1:enable=0" as unknown as number,
    outlineWidth: 2,
    outlineColor: "blue,movie=x",
    shadowX: 3,
    shadowColor: "#000:y=0",
  });
  check(!/movie|enable/.test(crafted), `no injected filter/option survives (${crafted})`);
  for (const want of ["fontsize=48", "fontcolor=white", "boxcolor=black@0.55", "boxborderw=12", "bordercolor=black", "shadowcolor=black"]) {
    check(crafted.split(":").includes(want), `a crafted value falls back: ${want}`);
  }
  check(crafted.split(":").length === drawTextStep({ ...ovBase, box: true, outlineWidth: 2, shadowX: 3 }).split(":").length, "the crafted step has no extra ':' option");
  for (const c of ["#ffe14d", "#000000cc", "#0a0a0a99", "0xFFE14D", "black@0.55", "white@0x80", "yellow", "white@1.0"]) {
    const st = drawTextStep({ ...ovBase, color: c, box: true, boxColor: c });
    check(st.includes(`fontcolor=${c}:`) && st.includes(`boxcolor=${c}:`), `legit colour ${c} passes unchanged`);
  }
  check(drawTextStep({ ...ovBase, fontSize: 72.5 }).includes("fontsize=72.5:"), "a legit numeric fontsize passes unchanged");

  rmSync(root, { recursive: true, force: true });
  console.log(failures === 0 ? "\nALL SAFEPATH CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
