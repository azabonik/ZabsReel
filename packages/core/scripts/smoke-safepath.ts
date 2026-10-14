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
 *   9. filter allowlist        — the executor refuses any filter SynthCut
 *                                doesn't build and any file option outside
 *                                the run's directory (metadata file=, psnr,
 *                                vidstabdetect result=, drawtext textfile= …),
 *                                and any bare file name unless the spawn's
 *                                cwd is in the data dir or the OS temp dir
 *                                and the name has the engine's shape; a
 *                                sendcmd file holds only a reframe crop plan.
 *   10. coerceProjectValues    — load gives every graph-bound value its type
 *                                (transition, asset geometry, probed colour
 *                                descriptions, effect params and colours, eq,
 *                                volume, speed …), and the
 *                                graph sinks format them as numbers / known
 *                                names again; the export of a crafted project
 *                                passes the strict guard with no payload text.
 *   11. round trip             — a project using every graph-bound field
 *                                saves and loads unchanged (nothing coerced).
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
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { EditorEngine } from "../src/engine.js";
import { runFfmpeg, runFfprobe, guardFfmpegArgs, guardFfprobeArgs, ffmpegArgsLocalOnly, filterGraphNames, addFfmpegWorkRoot } from "../src/ffmpeg/executor.js";
import {
  safeFileStem,
  isLocalMediaPath,
  looksLikeProtocol,
  assertLocalMediaPath,
  sanitizeProjectIds,
  coerceProjectNumbers,
  coerceProjectValues,
} from "../src/safepath.js";
import { buildRenderCommand, drawTextStep, EXPORT_PROFILE, type ResolvedMusic } from "../src/ffmpeg/graph.js";
import { cutoutMergeFilter } from "../src/ffmpeg/cutout.js";
import { framesColor } from "../src/ffmpeg/frames.js";
import { keepCodingOpts, resolveSourceColor, tagFramesStep, taggedMatrix } from "../src/ffmpeg/colorspace.js";
import { parseKeyColor } from "../src/effects/registry.js";
import { cropPlanToSendcmd } from "../src/reframe/reframe.js";
import type { Canvas, Project, ResolvedRenderClip } from "../src/types.js";

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};
const threw = async (fn: () => unknown, _label: string): Promise<boolean> => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};

async function main() {
  // These rows test the strict guard: a matrix run in report mode must neither loosen them nor log their payloads.
  delete process.env.AIVE_GUARD_REPORT;
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

  const guardThrew = (args: string[], cwd?: string) => { try { guardFfmpegArgs(args, cwd); return false; } catch { return true; } };
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
    // MUTATION: compare inputFormat's value as given (no toLowerCase) → these rows fail.
    check(guardThrew(["-f", "LAVFI", "-i", "movie=x.mp4"]) && guardThrew(["-f", "LaVfI", "-i", "movie=x.mp4"]), "…also when -f spells lavfi in another case (FFmpeg reads -f LAVFI as lavfi)");
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
    writeFileSync(join(root, "c-reframe.txt"), cropPlanToSendcmd([{ t: 0, x: 0, y: 0 }]));
    for (const g of [
      "sendcmd=f=c-reframe.txt,crop=10:10:0:0,scale=16:16",
      "lut3d=file=lut0.cube:interp=tetrahedral",
      "drawtext=textfile=txt_t.txt:fontfile=font_0.ttf:fontsize=48",
      "vidstabtransform=input=t.trf:smoothing=10",
      "signalstats,metadata=print",
      "[0:a]volume=1[bass];[bass]anull[movie_out]",
      "drawtext=text='Movie\\, ass\\: 10\\:30':fontsize=48,setpts='(PTS-STARTPTS)/2'",
      "[a\\]b]null[o]",
    ]) {
      check(!guardThrew(["-filter_complex", g], root), `guardFfmpegArgs passes the core's own graph ${JSON.stringify(g)}`);
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
  check(drawTextStep({ ...ovBase, position: "constructor" }) === drawTextStep(ovBase), "a prototype-key position is placed as the default (bottom)");

  // ---- 9. strict filter allowlist + file options --------------------------
  // Any filter SynthCut doesn't build is refused (not a denylist): the four
  // payloads measured on the denylist guard, an unknown name, every file
  // option of an allowed filter pointing outside the run's directory, in
  // quoted / escaped / positional / "/key" (FFmpeg 7+ file value) spellings.
  // MUTATION: remove "file" from metadata's refused options → the metadata
  // rows fail; drop the vidstabdetect rule → the vidstabdetect rows fail; add
  // "psnr" to ALLOWED_FILTERS → the psnr row fails.
  console.log("9. strict filter allowlist and file options...");
  {
    const guardThrew = (args: string[], cwd?: string) => { try { guardFfmpegArgs(args, cwd); return false; } catch { return true; } };
    const pwn = join(root, "pwn.txt");
    for (const [flag, g] of [
      ["-vf", `metadata=mode=print:file=${pwn}`],
      ["-filter_complex", `[0:v][1:v]psnr=stats_file=${pwn}`],
      ["-vf", `vidstabdetect=result=${pwn}`],
      ["-vf", "drawtext=textfile=/etc/passwd"],
      ["-vf", "scale=16:16,boxblur=2"],
      ["-af", `anull,ametadata=mode=print:file=${pwn}`],
      ["-vf", `ssim=f=${pwn}`],
      ["-filter_complex", `[0:v]'metadata'=mode=print:file=${pwn}[v]`],
      ["-filter_complex", `[0:v]metadata='mode=print:file=${pwn}'[v]`],
      ["-vf", `metadata=mode=print:file\\=${pwn}`],
      ["-vf", `metadata=print:file='${pwn}'`],
      ["-vf", `metadata=print:k:v:equal:0:${pwn}`],
      ["-vf", `signalstats,metadata@m=print:file=${pwn}`],
      ["-vf", `vidstabdetect=shakiness=5:result='${pwn}'`],
      ["-vf", `vidstabdetect=${pwn}`],
      ["-vf", "vidstabtransform=input=../x.trf"],
      ["-vf", "drawtext=textfile='/etc/passwd':fontsize=20"],
      ["-vf", "drawtext=textfile=\\/etc\\/passwd"],
      ["-vf", "drawtext=fontfile=C\\:/Windows/Fonts/x.ttf:text=a"],
      ["-vf", "drawtext=/text=/etc/passwd"],
      ["-vf", "drawtext=f.ttf"],
      ["-vf", "lut3d=/etc/passwd"],
      ["-vf", "lut3d=file='../look.cube'"],
      ["-vf", "sendcmd=f=/tmp/cmds.txt,crop=8:8"],
      ["-vf", "sendcmd=c='0 drawtext reinit textfile=/etc/passwd',drawtext=text=a"],
      ["-vf", `curves=psfile=${pwn}`],
      ["-vf", `curves=all='0/0 1/1':plot=${pwn}`],
      ["-af", `loudnorm=I=-14:stats_file=${pwn}`],
    ] as const) {
      check(guardThrew([flag, g]), `guardFfmpegArgs refuses ${flag} ${JSON.stringify(g)}`);
    }
    check(guardThrew(["-f", "lavfi", "-i", `sine,ametadata=mode=print:file=${pwn}`]), "…and the same in a -f lavfi -i graph");
    // The forms SynthCut builds (graph.ts, the stabilize / reframe bakes, analysis.ts).
    writeFileSync(join(root, "clip_1-reframe.txt"), cropPlanToSendcmd([{ t: 0, x: 0, y: 0 }, { t: 1.25, x: 16, y: 8 }]));
    for (const g of [
      "lut3d=lut0.cube",
      "lut3d=file=lut12.cube:interp=tetrahedral",
      "drawtext=textfile=txt_text_1.txt:fontfile=font_0.ttf:fontsize=48:fontcolor=white:x=(w-text_w)/2:y=h*0.06",
      "vidstabdetect=shakiness=5:accuracy=15:result=clip_1-stab-x1.trf",
      "vidstabdetect=result=-x-stab-x1.trf",
      "vidstabtransform=input=clip_1-stab-x1.trf:smoothing=10:optzoom=1:crop=black:optalgo=gauss,unsharp=5:5:0.8:3:3:0.4",
      "sendcmd=f=clip_1-reframe.txt,crop=8:8:0:0,scale=16:16,setsar=1,format=yuv420p",
      "signalstats,metadata=print",
      "curves=all='0/0 0.5/0.6 1/1'",
      "curves=r='0/0 1/1':g='0/0 1/1'",
      "loudnorm=I=-14.000000:TP=-1.500000:LRA=11,aresample=48000",
    ]) {
      check(!guardThrew(["-filter_complex", g], root), `guardFfmpegArgs passes SynthCut's ${JSON.stringify(g.slice(0, 60))}`);
    }
    // A bare name opens in the spawn's cwd: only a SynthCut-owned one (the data dir, the OS temp dir) will do.
    // MUTATION: make ownedWorkDir return true → the "no cwd" row fails.
    const text = ["-vf", "drawtext=textfile=txt_notes.txt:fontfile=font.ttf"];
    const fakeData = join(dirname(tmpdir()), "synthcut-smoke-unused", "data"); // never created: the guard only compares paths
    addFfmpegWorkRoot(fakeData);
    check(guardThrew(text), "a drawtext textfile with no cwd (the process's own: often the user's home) is refused");
    check(guardThrew(text, homedir()) && guardThrew(text, dirname(tmpdir())), "…and with cwd = the user's home or another directory SynthCut doesn't own");
    check(guardThrew(text, `${fakeData}-other`) && guardThrew(text, join(fakeData, "..")), "…and with cwd beside or above the data dir");
    check(!guardThrew(text, join(root, "render")) && !guardThrew(text, join(fakeData, "render")) && !guardThrew(text, fakeData),
      "…and passes with cwd in the OS temp dir or in a data dir the engine owns");
    check(!guardThrew(["-vf", "scale=16:16,format=yuv420p"]), "a graph that names no file needs no cwd");
    // sendcmd sends its file's commands to any filter at run time, past every option check:
    // the round-1 bypass wrote a file anywhere through curves plot= (FFmpeg 4.4 – 9.0).
    // MUTATION: drop the content check (FILE_OPTIONS sendcmd content) → the "x-reframe.txt"
    // row fails; drop the name shapes (fileOk's shape test) → the "result=notes.txt" row
    // fails; drop the sendcmd + curves/drawtext refusal → the "grammar-clean file" rows fail.
    const plot = join(root, "pwn-plot.plt");
    writeFileSync(join(root, "txt_ov3.txt"), `0 curves plot ${plot};\n`);
    check(guardThrew(["-vf", "sendcmd=f=txt_ov3.txt,curves=all='0/0 1/1'"], root), "the round-1 repro (sendcmd f= an overlay text file holding `curves plot`) is refused");
    writeFileSync(join(root, "x-reframe.txt"), `0 curves plot ${plot};\n`);
    check(guardThrew(["-vf", "sendcmd=f=x-reframe.txt,crop=8:8"], root), "a reframe-named sendcmd file holding `curves plot` is refused (content check)");
    const plan = cropPlanToSendcmd([{ t: 0, x: 0, y: 0 }, { t: 0.5, x: 16, y: 16 }]);
    for (const [why, text] of [
      ["an extra command", `${plan}0.500 crop w 8;\n`],
      ["another target", "0.000 scale x 4;\n"],
      ["a named instance", "0.000 crop@c x 4;\n"],
      ["a flag interval", "0.000 [enter] crop x 4;\n"],
      ["an end time", "0.000-1.000 crop x 4;\n"],
      ["a non-integer argument", "0.000 crop x 4.5;\n"],
      ["an expression argument", "0.000 crop x iw/2;\n"],
      ["a comment", `# plan\n${plan}`],
      ["two commands on a line", "0.000 crop x 4, crop y 4;\n"],
      ["nothing", ""],
    ] as const) {
      writeFileSync(join(root, "bad-reframe.txt"), text);
      check(guardThrew(["-vf", "sendcmd=f=bad-reframe.txt,crop=32:32:0:0"], root), `a sendcmd file with ${why} is refused`);
    }
    // MUTATION: drop the SENDCMD_MAX_BYTES test in fileHolds → the "over 1 MiB" row fails.
    writeFileSync(join(root, "big-reframe.txt"), "0.000 crop x 0;\n".repeat(70_000));
    check(guardThrew(["-vf", "sendcmd=f=big-reframe.txt,crop=32:32:0:0"], root), "a grammar-clean sendcmd file over 1 MiB is refused (size cap)");
    check(guardThrew(["-vf", "sendcmd=f=gone-reframe.txt,crop=32:32:0:0"], root), "a sendcmd file that doesn't exist is refused");
    writeFileSync(join(root, "y-reframe.txt"), plan);
    check(guardThrew(["-vf", "sendcmd=f=y-reframe.txt,crop=32:32:0:0,curves=all='0/0 1/1'"], root), "sendcmd + curves in one graph is refused, even with a grammar-clean file");
    check(guardThrew(["-filter_complex", "[0:v]sendcmd=f=y-reframe.txt,crop=32:32:0:0[c];[c]drawtext=textfile=txt_a.txt:fontfile=font.ttf[o]"], root), "…and sendcmd + drawtext (reinit) likewise");
    writeFileSync(join(root, "cmds.txt"), plan);
    for (const [g, why] of [
      ["vidstabdetect=result=notes.txt", "a vidstabdetect result= that is not *.trf"],
      ["vidstabtransform=input=project.aive", "a vidstabtransform input= that is not *.trf"],
      ["lut3d=look.cube", "a lut3d file that is not lut<n>.cube"],
      ["drawtext=textfile=notes.txt:fontfile=font.ttf", "a drawtext textfile that is not txt_/cap_*.txt"],
      ["drawtext=textfile=txt_a.txt:fontfile=clip.mp4", "a drawtext fontfile that is not font[_n].ttf/otf"],
      ["sendcmd=f=cmds.txt,crop=32:32:0:0", "a sendcmd file that is not *-reframe.txt (even with a clean plan)"],
    ] as const) {
      check(guardThrew(["-vf", g], root), `${why} is refused (in an owned cwd)`);
    }
    // The real auto-reframe bake (engine reframe), with cropPlanToSendcmd's file, passes and runs.
    const bakeVf = `sendcmd=f=y-reframe.txt,crop=32:32:0:0,scale=48:48${keepCodingOpts({ matrix: "bt601", range: "tv" })},setsar=1,format=yuv420p,${tagFramesStep({ matrix: "bt601", range: "tv" })}`;
    const bakeArgs = ["-hide_banner", "-loglevel", "error", "-i", clip, "-vf", bakeVf, "-c:v", "libx264", "-preset", "ultrafast", "-an", "-y", "y-reframe.mp4"];
    check(!guardThrew(bakeArgs, root), `the reframe bake command passes (${bakeVf.slice(0, 70)}…)`);
    const baked = await runFfmpeg(bakeArgs, { cwd: root }).then(() => existsSync(join(root, "y-reframe.mp4")), (err) => { console.log(`    bake: ${(err as Error).message}`); return false; });
    check(baked, "…and FFmpeg runs it");
    check(!existsSync(plot), "no plot file was written");
    // Report mode (AIVE_GUARD_REPORT): logs what strict mode refuses and lets
    // it run, for collecting the filters a test run uses; movie= stays refused.
    const report = join(root, "guard-report.txt");
    process.env.AIVE_GUARD_REPORT = report;
    try {
      check(!guardThrew(["-vf", "scale=16:16,boxblur=2"]), "report mode lets an unknown filter through…");
      check(existsSync(report) && readFileSync(report, "utf8").includes('unknown filter "boxblur"'), "…and logs its name");
      check(guardThrew(["-vf", `movie=${pwn}`]), "report mode still refuses movie=");
    } finally {
      delete process.env.AIVE_GUARD_REPORT;
    }
    check(guardThrew(["-vf", "scale=16:16,boxblur=2"]), "strict again once AIVE_GUARD_REPORT is unset");
  }

  // ---- 10. graph-bound project values are typed on load and at the sinks --
  // A crafted .aive puts filtergraph payloads into a transition type, asset
  // geometry / fps and cutout start, effect params and colours, eq, volume,
  // speed and a track volume, plus a LUT whose (legitimate) file name holds
  // , : [ ]. Each layer has its own rows:
  // MUTATION (load): drop the width line of coerceProjectValues → the
  // "asset width" row fails; drop the transition check → the "transition"
  // row fails.
  // MUTATION (sink): use clip.transition.type raw in graph.ts → the "sink
  // xfade" row fails; drop the finiteOr re-binding in cutoutMergeFilter → the
  // "sink cutout" row fails.
  // Probed colour descriptions (asset color / proxyColor / videoCodec, cutout
  // colorTags / colorCodec) hold a prototype key ("constructor") and payloads.
  // MUTATION: drop the colour lines of coerceProjectValues → the "colour
  // descriptions" row fails; drop Object.hasOwn in taggedMatrix → the
  // "taggedMatrix" row fails.
  console.log("10. crafted graph values are coerced on load and formatted at the sinks...");
  {
    const pwn = join(root, "pwn-load.txt");
    const pay = `,metadata=mode=print:file=${pwn}`;
    const lutDir = join(root, "luts");
    mkdirSync(lutDir, { recursive: true });
    const lutPath = join(lutDir, "look,x:y[z]';.cube");
    writeFileSync(lutPath, "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n");
    const cr = structuredClone(tpl) as unknown as Project;
    const a0 = cr.assets[0] as unknown as Record<string, unknown>;
    a0.width = `64:flags=bicubic${pay}`;
    a0.fps = `10${pay}`;
    a0.cutout = { colorPath: clip, colorStart: `0${pay}`, colorTags: { space: `bt709${pay}`, range: "tv" }, colorCodec: `h264${pay}` };
    const a1 = structuredClone(a0);
    delete a1.cutout;
    Object.assign(a1, {
      id: "asset_col", width: 64, fps: 10, videoCodec: `h264${pay}`,
      color: { space: "constructor", range: "pc,metadata=mode=print:file=x", primaries: `bt709${pay}`, transfer: "bt709", codedHeight: "64" },
      proxyColor: { space: "bt709", range: `tv${pay}`, codedHeight: 64 },
    });
    cr.assets.push(a1 as unknown as Project["assets"][number]);
    const c0 = cr.tracks[0].clips[0];
    const c1 = structuredClone(c0);
    c1.id = "clip_two";
    c1.startFrame = 5;
    c1.overlays = [];
    (c1 as unknown as Record<string, unknown>).transition = { type: `fade${pay}`, durationFrames: 3 };
    cr.tracks[0].clips.push(c1);
    const c2 = structuredClone(c1);
    Object.assign(c2, { id: "clip_col", assetId: "asset_col", startFrame: 16 });
    delete c2.transition;
    cr.tracks[0].clips.push(c2);
    (cr.tracks[0] as unknown as Record<string, unknown>).volume = `0.5${pay}`;
    c0.effects = {
      color: { brightness: `0.1${pay}` as unknown as number, contrast: 1.1 },
      volume: `2${pay}` as unknown as number,
      speed: `1${pay}` as unknown as number,
      lut: lutPath,
      filters: [
        { id: "fx_a", type: "blur", amount: `2${pay}` as unknown as number },
        { id: "fx_b", type: "chromakey", color: `0x00FF00${pay}`, params: { similarity: `0.1${pay}` as unknown as number, blend: 0.05 } },
      ],
    };
    const crFile = join(root, "crafted-values.aive");
    writeFileSync(crFile, JSON.stringify(cr));
    const ec = new EditorEngine(join(dataDir, "values"));
    const lp = await ec.load(crFile);
    const la = lp.assets[0];
    const [l0, l1] = lp.tracks[0].clips;
    check(typeof la.width === "number" && la.width === 0, `asset width: a string becomes a number on load (${JSON.stringify(la.width)})`);
    check(typeof la.fps === "number" && typeof la.cutout?.colorStart === "number", `asset fps and cutout start are numbers on load (${JSON.stringify([la.fps, la.cutout?.colorStart])})`);
    check(l1?.transition?.type === "fade", `transition: an unknown type becomes "fade" on load (${JSON.stringify(l1?.transition?.type)})`);
    const fxa = l0.effects?.filters?.find((f) => f.id === "fx_a");
    const fxb = l0.effects?.filters?.find((f) => f.id === "fx_b");
    check(!!fxa && fxa.amount === undefined && !!fxb && fxb.color === undefined && fxb.params?.similarity === undefined && fxb.params?.blend === 0.05,
      `effect amount / param / colour payloads are dropped, valid params kept (${JSON.stringify([fxa, fxb])})`);
    check(l0.effects?.color?.brightness === undefined && l0.effects?.color?.contrast === 1.1 && l0.effects?.volume === undefined && l0.effects?.speed === undefined,
      `eq, volume and speed payloads are dropped (${JSON.stringify(l0.effects?.color)})`);
    check(lp.tracks[0].volume === undefined, "a track volume payload is dropped");
    const lc = lp.assets.find((a) => a.id === "asset_col");
    check(!!lc && lc.color === undefined && lc.proxyColor === undefined && lc.videoCodec === undefined && la.cutout?.colorTags === undefined && la.cutout?.colorCodec === undefined,
      `colour descriptions with a prototype key, a payload or a string coded height are dropped on load, to be probed again (${JSON.stringify([lc?.color, lc?.proxyColor, lc?.videoCodec, la.cutout])})`);
    check(taggedMatrix("constructor") === undefined && taggedMatrix("__proto__") === undefined && taggedMatrix("toString") === undefined && taggedMatrix("bt470bg") === "bt601",
      "taggedMatrix: a prototype key names no matrix");
    // MUTATION: drop Object.hasOwn in taggedMatrix → this row fails.
    const fc = (h: number, space: string) => framesColor({ height: h, color_space: space, color_primaries: "bt709", color_transfer: "bt709" })?.matrix;
    check(fc(360, "constructor") === "bt601" && fc(1080, "__proto__") === "bt709",
      "framesColor (/frames): a prototype key reads as untagged");
    check(JSON.stringify(resolveSourceColor({ space: "constructor", range: "pc,x" }, 1080)) === '{"matrix":"bt709","range":"tv"}' && resolveSourceColor({ space: "hasOwnProperty" }, 480).matrix === "bt601",
      "resolveSourceColor reads a prototype-key space as untagged");
    check(parseKeyColor("constructor") === null && parseKeyColor("green") === "0x00FF00", "parseKeyColor: a prototype key names no key colour");
    check(l0.effects?.lut === lutPath, "a LUT whose file name holds , : [ ] ' ; is kept on load");
    // The export command the engine builds from the loaded project.
    const canvas: Canvas = { width: lp.width, height: lp.height, fps: lp.fps };
    const internals = ec as unknown as {
      stageRender(c: Canvas, o: object): Promise<{ clips: ResolvedRenderClip[]; cwd: string }>;
      resolveMusic(): ResolvedMusic | undefined;
    };
    const staged = await internals.stageRender(canvas, {});
    const cmd = buildRenderCommand(staged.clips, canvas, join(root, "values.mp4"), EXPORT_PROFILE, internals.resolveMusic()).args;
    const graph = cmd[cmd.indexOf("-filter_complex") + 1];
    let guardOk = true;
    try { guardFfmpegArgs(cmd, staged.cwd); } catch (err) { guardOk = false; console.log(`    guard: ${(err as Error).message}`); }
    check(guardOk, "the export command of the loaded project passes the strict guard (allowlisted filters only)");
    check(!cmd.join(" ").includes(pwn) && !filterGraphNames(graph).includes("metadata") && !/native code|function|constructor|undefined/.test(graph),
      "no payload text, metadata filter or prototype value in the export command");
    check(graph.includes("xfade=transition=fade:") && /lut3d=lut\d+\.cube/.test(graph) && !graph.includes("look,x"), `xfade uses "fade" and lut3d the staged bare name (${graph.match(/lut3d=[^,;[]*/)?.[0]})`);
    const exported = await ec.exportVideo(join(root, "values.mp4")).then(() => true, (err) => { console.log(`    export error: ${(err as Error).message}`); return false; });
    check(exported && !existsSync(pwn), "the crafted project exports, and no payload file was written");
    // Sinks: the same payloads straight into the graph builders (as if a value slipped past load).
    const raw = structuredClone(staged.clips);
    const r1 = raw.find((c) => c.transition)!;
    (r1.transition as { type: string }).type = `wipeleft${pay}`;
    const r0 = raw.find((c) => c !== r1 && !c.sfx)!;
    r0.effects = { ...r0.effects, color: { brightness: `0.1${pay}` as unknown as number }, volume: `2${pay}` as unknown as number, speed: `1${pay}` as unknown as number };
    r0.trackVolume = `0.5${pay}` as unknown as number;
    const music: ResolvedMusic = { path: clip, volume: `0.3${pay}` as unknown as number };
    const sinkCmd = buildRenderCommand(raw, canvas, join(root, "sink.mp4"), EXPORT_PROFILE, music).args;
    const sinkGraph = sinkCmd[sinkCmd.indexOf("-filter_complex") + 1];
    check(!sinkGraph.includes(pwn) && sinkGraph.includes("xfade=transition=fade:"), "sink xfade: an unknown transition type is built as fade, no payload in eq / volume / speed");
    const merge = cutoutMergeFilter("[1:v]", "[0:v]", "[m]", { width: `64:flags=bicubic${pay}` as unknown as number, height: 64, fps: `10${pay}` as unknown as number, range: "tv" });
    check(!merge.includes(pwn) && merge.includes("scale=0:64:"), `sink cutout: string geometry / fps never reach the merge graph (${merge.slice(0, 60)})`);
  }

  // ---- 11. a project using every graph-bound field round-trips unchanged ---
  // Nothing SynthCut writes is coerced: the counters return 0 and load keeps
  // every value. MUTATION: make coerceProjectValues treat effects.lut as a
  // number (nums instead of strs) → the counter and round-trip rows fail.
  console.log("11. a full-featured project saves and loads with nothing coerced...");
  {
    const ef = new EditorEngine(join(dataDir, "full"));
    const asset = await ef.importVideo(clip);
    const lut = join(root, "full.cube");
    writeFileSync(lut, "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n");
    const A = ef.addClip(asset.id, { sourceOutFrame: 10 });
    const B = ef.addClip(asset.id, { startFrame: 6, sourceOutFrame: 10 });
    ef.setTransition(B.id, "circleopen", 3);
    ef.setClipEffects(A.id, { color: { brightness: 0.05, contrast: 1.1, saturation: 1.2, gamma: 0.9 }, lut, crop: { x: 2, y: 2, width: 60, height: 60 }, volume: 0.8, fadeInFrames: 2, fadeOutFrames: 2 });
    ef.setClipGrade(A.id, { temperature: 0.2, tint: -0.1, hue: 10, lift: { r: 0.1 }, gamma: { g: -0.05 }, gain: { b: 0.1 }, curve: "0/0 0.5/0.6 1/1", curveR: "0/0 1/0.9" });
    ef.applyEffect(A.id, { type: "chromakey", color: "0x00FF00", params: { similarity: 0.12, blend: 0.05 } });
    ef.applyEffect(A.id, { type: "blur", amount: 2 });
    ef.applyEffect(B.id, { type: "vignette", amount: 0.5 });
    ef.setClipTransform(A.id, { transform: { x: 0.1, y: -0.1, scale: 0.9, rotation: 5, flipH: true }, opacity: 0.9 });
    ef.setClipBlendMode(B.id, "screen");
    ef.setClipMask(A.id, { shape: "ellipse", x: 0.5, y: 0.5, w: 0.6, h: 0.6, feather: 0.1 });
    ef.setKeyframes(A.id, "x", [{ frame: 0, value: 0 }, { frame: 5, value: 0.2, ease: "easeOut" }]);
    ef.setKeyframes(A.id, "volume", [{ frame: 0, value: 1 }, { frame: 8, value: 0.5 }]);
    const ov = ef.addTextOverlay(A.id, { text: "full", position: "top", fontSize: 20, color: "#ffe14d", outlineWidth: 2, outlineColor: "black", shadowX: 2, shadowY: 2, box: true, boxColor: "black@0.55", startFrame: 1, endFrame: 8 });
    ef.animateText(A.id, ov.id, "opacity", [{ frame: 0, value: 0 }, { frame: 3, value: 1 }]);
    await ef.addBleep({ clipId: A.id, start: 0.2, end: 0.4, volume: 0.6 });
    await ef.applyAudioEffect(A.id, { type: "echo", params: { delay: 120 } });
    ef.setTrackProperties(ef.getProject().tracks[0].index, { volume: 0.9 });
    ef.setSpeedRamp(B.id, { preset: "montage" });
    ef.setMusic(asset.id, { volume: 0.3, fadeInFrames: 2, fadeOutFrames: 2, duck: true });
    const adj = ef.addAdjustmentClip({ startFrame: 0, durationFrames: 10 });
    ef.applyEffect(adj.id, { type: "grayscale" });
    const fullFile = join(root, "full.aive");
    await ef.save(fullFile);
    // The colour fields as probeAsset and a matte cutout record them (ffprobe names).
    const withColour = JSON.parse(readFileSync(fullFile, "utf8")) as Project;
    const fa = withColour.assets.find((a) => a.id === asset.id)!;
    fa.color = { space: "bt709", range: "tv", primaries: "bt709", transfer: "bt709", codedHeight: 64 };
    fa.proxyColor = { space: "smpte170m", range: "tv", primaries: "smpte170m", transfer: "smpte170m", codedHeight: 360 };
    withColour.assets.push({ ...structuredClone(fa), id: "asset_cut", name: "cutout", proxyColor: undefined,
      cutout: { colorPath: clip, colorStart: 0, colorAssetId: fa.id, colorTags: { space: "bt2020nc", range: "pc", primaries: "bt2020", transfer: "arib-std-b67", codedHeight: 2160 }, colorCodec: "hevc" } });
    writeFileSync(fullFile, JSON.stringify(withColour, null, 2));
    const saved = JSON.parse(readFileSync(fullFile, "utf8")) as Project;
    check(!!saved.assets.find((a) => a.id === "asset_cut")?.cutout?.colorTags && !!saved.assets.find((a) => a.id === asset.id)?.proxyColor, "the full-featured project has color, proxyColor and cutout colorTags");
    const counts = [coerceProjectNumbers(structuredClone(saved)), coerceProjectValues(structuredClone(saved))];
    check(counts[0] === 0 && counts[1] === 0, `nothing in a full-featured saved project is coerced (numbers ${counts[0]}, values ${counts[1]})`);
    const back = await new EditorEngine(join(dataDir, "full2")).load(fullFile);
    const strip = (p: Project) => JSON.stringify({ ...p, revision: 0, updatedAt: 0 });
    check(strip(back) === strip(saved), "load keeps every value of the full-featured project");
  }

  rmSync(root, { recursive: true, force: true });
  console.log(failures === 0 ? "\nALL SAFEPATH CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
