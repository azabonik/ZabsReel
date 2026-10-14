/**
 * Smoke test: MATTE-BACKED remove_background cutouts, fully offline (no model,
 * no downloads — the pipeline's internal `stubMatte` stand-in replaces RVM
 * with a deterministic soft luma key, so every frame's matte follows its own
 * picture and any colour/matte misalignment shows).
 *
 *  1. remove_background bakes ONLY the matte (FFV1 gray + the span's audio) in a
 *     worker thread, records the colour source, and builds a VP8+alpha proxy.
 *  2. Frame-by-frame equivalence: the same edits on three cutouts of the same
 *     matte — the new matte-backed asset (N), a colour+alpha FFV1 yuva .mkv
 *     written exactly like the old remove_background output (L), and the same
 *     colour+alpha FFV1 in a .mov that keeps the source's timestamps (M) —
 *     exported LOSSLESSLY over a red and over a blue background (so alpha and
 *     colour must both match). N must equal M bit for bit in every scenario
 *     (trim, split, speed 0.5/1.5/2, ramp, reverse, freeze, smooth slow motion,
 *     luma key, mask, transform, effects + fades, keyframes, blend mode) and L
 *     in every scenario that doesn't retime (L's Matroska timestamps are whole
 *     milliseconds, so at exact half-frame ties — 2x — FFmpeg picks the other
 *     neighbour; that is the old cutout's behaviour, reported, not asserted).
 *  3. Odd-size 24 fps footage on a 30 fps project, trimmed off the footage's
 *     frame grid: colour and matte stay paired (alpha recovered from exports
 *     over black and white matches the matte of the SAME frame).
 *  4. generate_proxy keeps transparency (matte-backed and legacy cutouts get a
 *     VP8+alpha .webm, ordinary footage still an H.264 .mp4); a cutout's baked
 *     preview is reused while it exists, a missing one is rebuilt.
 *  5. Thumbnails, key-colour detection, scene detection read the colour;
 *     stabilize / auto_reframe / a second remove_background are refused.
 *  6. Segment-cache keys follow the colour file; storage GC sees the matte and
 *     proxy as referenced (and as unused once no project names them). A cutout
 *     whose colour is an engine bake (reverse_clip) keeps that bake in the
 *     library and its file and proxy out of the trash until the cutout goes.
 *  7. AIVE_RVM_INLINE=1 runs the same pipeline on the calling thread and writes
 *     an identical matte; cancel_job stops a run promptly, its worker thread
 *     and ffmpeg children are gone within 2 s, and it leaves no files.
 *  8. A cutout shows its colour source's colours, read as the clip without its
 *     background removal reads them (the gray matte's own description — full
 *     range on FFmpeg 7+, untagged before — said nothing about them): tagged
 *     BT.601 HD, tagged BT.709 SD, full range JPEG and tagged BT.709 full
 *     range sources, in the export, the thumbnail, a freeze frame and a
 *     reverse bake (kept patches equal, removed ones black).
 *
 * Run: npx tsx packages/core/scripts/smoke-cutout.ts
 */
import { execa } from "execa";
import { mkdtempSync, existsSync, readdirSync, statSync, utimesSync, rmSync, copyFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorEngine } from "../src/engine.js";
import { dispatch } from "../src/rpc.js";
import { runFfmpeg, FFMPEG_BIN, FFPROBE_BIN } from "../src/ffmpeg/executor.js";
import { referencedManagedPaths } from "../src/storage.js";
import { segmentKey } from "../src/ffmpeg/segments.js";
import { previewColorFix } from "../src/ffmpeg/colorspace.js";
import type { MediaAsset, ResolvedRenderClip } from "../src/types.js";
import workerThreads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";

// Count the worker threads remove_background starts and see them exit (section 7).
const workers = { created: 0, live: new Set<object>() };
class TrackedWorker extends workerThreads.Worker {
  constructor(...args: ConstructorParameters<typeof workerThreads.Worker>) {
    super(...args);
    workers.created++;
    workers.live.add(this);
    this.once("exit", () => workers.live.delete(this));
  }
}
workerThreads.Worker = TrackedWorker;
syncBuiltinESMExports();

const W = 320;
const H = 180;
const FPS = 30;
const DUR = 3;
const LOSSLESS = { quality: 0 } as const;

let failures = 0;
function check(ok: boolean, label: string, detail: unknown = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${ok || detail === "" ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

async function ff(args: string[]): Promise<void> {
  await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

async function streams(file: string): Promise<{ codec_type: string; codec_name: string; pix_fmt?: string; tags?: Record<string, string> }[]> {
  const { stdout } = await execa(FFPROBE_BIN, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt:stream_tags", "-of", "json", file]);
  return JSON.parse(stdout).streams ?? [];
}

/** Every frame of a video as raw planes in `pixFmt` (`vf`: a conversion filter to use first). */
async function frames(file: string, pixFmt = "yuv420p", decoder?: string, vf?: string): Promise<Buffer[]> {
  const probe = await execa(FFPROBE_BIN, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
  const [w, h] = probe.stdout.trim().split(",").map(Number);
  const per = pixFmt === "yuv420p" ? (w * h * 3) / 2 : pixFmt === "yuva420p" ? (w * h * 5) / 2 : pixFmt === "rgba" ? w * h * 4 : w * h * 3;
  const { stdout } = await execa(
    FFMPEG_BIN,
    // Renumbered timestamps at a stated rate: every decoded frame comes out exactly once (a file whose video
    // starts late, like an old cutout behind its AAC delay, would otherwise get a duplicated first frame from
    // the CFR muxer, and FFmpeg 7 would fall back to 25 fps and drop frames).
    ["-hide_banner", "-loglevel", "error", ...(decoder ? ["-c:v", decoder] : []), "-i", file, "-vf", `setpts=N/${FPS}/TB${vf ? `,${vf}` : ""}`, "-r", String(FPS), "-f", "rawvideo", "-pix_fmt", pixFmt, "-"],
    { encoding: "buffer", maxBuffer: 1 << 30 },
  );
  const buf = stdout as unknown as Buffer;
  const out: Buffer[] = [];
  for (let o = 0; o + per <= buf.length; o += per) out.push(buf.subarray(o, o + per));
  return out;
}

/** Frame count and the largest per-byte difference between two videos (decoded planes). */
async function compareVideos(a: string, b: string): Promise<{ framesA: number; framesB: number; maxDiff: number; differingFrames: number }> {
  const [fa, fb] = await Promise.all([frames(a), frames(b)]);
  let maxDiff = 0;
  let differingFrames = 0;
  for (let i = 0; i < Math.min(fa.length, fb.length); i++) {
    let m = 0;
    const x = fa[i];
    const y = fb[i];
    for (let k = 0; k < x.length; k++) {
      const d = Math.abs(x[k] - y[k]);
      if (d > m) m = d;
    }
    if (m > 0) differingFrames++;
    maxDiff = Math.max(maxDiff, m);
  }
  return { framesA: fa.length, framesB: fb.length, maxDiff, differingFrames };
}

/** The stub matte (rvm-pipeline.ts stubMatter) of an RGB pixel. */
function stubAlpha(r: number, g: number, b: number): number {
  const y = (77 * r + 150 * g + 29 * b) >> 8;
  return y <= 64 ? 0 : y >= 160 ? 255 : Math.floor(((y - 64) * 255) / 96);
}

interface Layout {
  engine: EditorEngine;
  clipId: string;
  bgTrack: number;
}

/** V1 red, V2 blue (hidden), V3 the subject — the subject clip spans the whole asset. */
async function layout(dir: string, red: string, blue: string, subject: string): Promise<Layout & { asset: MediaAsset }> {
  const engine = new EditorEngine(dir);
  engine.setProjectSettings({ width: W, height: H, fps: FPS, name: "cutout-smoke" });
  const aRed = await engine.importVideo(red);
  const aBlue = await engine.importVideo(blue);
  const asset = await engine.importVideo(subject);
  engine.addClip(aRed.id, { startFrame: 0 });
  const v2 = engine.addTrack("video", { name: "blue" });
  engine.addClip(aBlue.id, { trackIndex: v2.index, startFrame: 0 });
  await dispatch(engine, "set_track_properties", { trackIndex: v2.index, hidden: true });
  const v3 = engine.addTrack("video", { name: "subject" });
  const clip = engine.addClip(asset.id, { trackIndex: v3.index, startFrame: 0 });
  return { engine, clipId: clip.id, bgTrack: v2.index, asset };
}

async function exportBoth(l: Layout, out: string): Promise<[string, string]> {
  const red = `${out}-red.mp4`;
  const blue = `${out}-blue.mp4`;
  await dispatch(l.engine, "set_track_properties", { trackIndex: l.bgTrack, hidden: true });
  await l.engine.exportVideo(red, LOSSLESS);
  await dispatch(l.engine, "set_track_properties", { trackIndex: l.bgTrack, hidden: false });
  await l.engine.exportVideo(blue, LOSSLESS);
  await dispatch(l.engine, "set_track_properties", { trackIndex: l.bgTrack, hidden: true });
  return [red, blue];
}

/**
 * `legacy`: why the old .mkv (L) can't be held to the same frames — its timestamps are whole
 * milliseconds ("ms": ties at 2x, ramp and blend timing, fade alpha per frame) and its video starts
 * 23 ms late behind the AAC encoder delay ("seek": a seek half a frame early lands a frame early).
 */
type Scenario = { name: string; legacy?: "ms" | "seek"; apply: (e: EditorEngine, clipId: string) => Promise<void> };

const SCENARIOS: Scenario[] = [
  { name: "plain", apply: async () => {} },
  { name: "trim in/out", apply: async (e, id) => void (await dispatch(e, "trim_clip", { clipId: id, sourceInFrame: 7, sourceOutFrame: 80 })) },
  { name: "split (right half seeks inside the files)", apply: async (e, id) => void (await dispatch(e, "split_clip", { clipId: id, atFrame: 41 })) },
  {
    name: "split + dissolve (two merged cutout streams in one transition run)",
    apply: async (e, id) => {
      const r = (await dispatch(e, "split_clip", { clipId: id, atFrame: 41 })) as { right: string };
      await dispatch(e, "set_transition", { clipId: r.right, type: "dissolve", durationFrames: 12 });
    },
  },
  { name: "speed 0.5x", apply: async (e, id) => void (await dispatch(e, "set_clip_speed", { clipId: id, speed: 0.5 })) },
  { name: "speed 1.5x", apply: async (e, id) => void (await dispatch(e, "set_clip_speed", { clipId: id, speed: 1.5 })) },
  { name: "speed 2x", legacy: "ms", apply: async (e, id) => void (await dispatch(e, "set_clip_speed", { clipId: id, speed: 2 })) },
  {
    name: "speed ramp",
    legacy: "ms",
    apply: async (e, id) => void (await dispatch(e, "set_speed_ramp", { clipId: id, points: [{ src: 0.4, speed: 0.6 }, { src: 1.6, speed: 2.4 }, { src: 2.6, speed: 0.8 }] })),
  },
  { name: "reverse (bake)", legacy: "seek", apply: async (e, id) => void (await dispatch(e, "reverse_clip", { clipId: id })) },
  { name: "freeze frame (bake)", legacy: "seek", apply: async (e, id) => void (await dispatch(e, "freeze_frame", { clipId: id, atSeconds: 1.2, durationSeconds: 0.5 })) },
  {
    name: "smooth slow motion 0.5x (bake)",
    legacy: "ms",
    apply: async (e, id) => {
      await dispatch(e, "set_clip_speed", { clipId: id, speed: 0.5 });
      await dispatch(e, "smooth_slow_motion", { clipId: id, mode: "blend" });
    },
  },
  { name: "luma key on the cutout", apply: async (e, id) => void (await dispatch(e, "apply_effect", { clipId: id, type: "lumakey", params: { threshold: 0.9, tolerance: 0.1, softness: 0.1 } })) },
  { name: "shape mask", apply: async (e, id) => void (await dispatch(e, "set_clip_mask", { clipId: id, shape: "ellipse", w: 0.7, h: 0.8, feather: 0.1 })) },
  { name: "transform", apply: async (e, id) => void (await dispatch(e, "set_clip_transform", { clipId: id, x: 0.42, y: 0.55, scale: 0.7, rotation: 12, flipH: true })) },
  {
    name: "effects + colour + fades",
    legacy: "ms",
    apply: async (e, id) => {
      await dispatch(e, "apply_effect", { clipId: id, type: "blur", amount: 3 });
      await dispatch(e, "apply_color", { clipId: id, temperature: 0.4, hue: 20 });
      await dispatch(e, "set_clip_fade", { clipId: id, fadeInFrames: 10, fadeOutFrames: 12 });
    },
  },
  {
    name: "keyframes (opacity + scale)",
    apply: async (e, id) => {
      await dispatch(e, "set_keyframes", { clipId: id, property: "opacity", keyframes: [{ frame: 0, value: 0.2 }, { frame: 60, value: 1 }] });
      await dispatch(e, "set_keyframes", { clipId: id, property: "scale", keyframes: [{ frame: 0, value: 1 }, { frame: 89, value: 0.6, ease: "ease" }] });
    },
  },
  { name: "blend mode screen", apply: async (e, id) => void (await dispatch(e, "set_clip_blend_mode", { clipId: id, mode: "screen" })) },
];

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "aive-cutout-"));
  console.log(`work dir ${dir}`);
  const src = join(dir, "src.mp4");
  const red = join(dir, "red.mp4");
  const blue = join(dir, "blue.mp4");
  await ff([
    "-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=${FPS}:d=${DUR}`, "-f", "lavfi", "-i", `sine=frequency=440:duration=${DUR}`,
    "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "aac", src,
  ]);
  for (const [file, c] of [[red, "red"], [blue, "blue"]] as const) {
    await ff(["-f", "lavfi", "-i", `color=c=${c}:s=${W}x${H}:r=${FPS}:d=6.5`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "0", "-pix_fmt", "yuv420p", file]);
  }

  // ---- 1. the bake --------------------------------------------------------------------------
  console.log("1. remove_background stores only the matte (worker thread, stub matte)...");
  const n = await layout(join(dir, "n"), red, blue, src);
  let maxGap = 0;
  let last = performance.now();
  const tick = setInterval(() => {
    const t = performance.now();
    maxGap = Math.max(maxGap, t - last);
    last = t;
  }, 5);
  const fractions: number[] = [];
  const onJob = (job: { type: string; status: string; fraction: number }) => {
    if (job.type === "matte" && job.status === "running") fractions.push(job.fraction);
  };
  n.engine.on("job", onJob);
  const r = await n.engine.removeBackground(n.clipId, { stubMatte: true });
  n.engine.off("job", onJob);
  clearInterval(tick);
  const cut = r.asset;
  check(r.runner === "worker", `inference ran in a worker thread (${r.runner})`);
  const steps = new Set(fractions.map((f) => f.toFixed(2))).size;
  check(steps >= 5 && fractions.every((f, i) => i === 0 || f >= fractions[i - 1]), `progress is reported from the worker (${steps} distinct steps, never backwards)`);
  check(cut.cutout?.colorPath === src && cut.cutout.colorStart === 0, "the cutout records its colour source", cut.cutout);
  const ms = await streams(cut.path);
  const mv = ms.find((s) => s.codec_type === "video");
  check(mv?.codec_name === "ffv1" && mv.pix_fmt === "gray", `the baked file is an FFV1 gray matte (${mv?.codec_name} ${mv?.pix_fmt})`);
  check(ms.some((s) => s.codec_type === "audio" && s.codec_name === "flac"), "the matte file carries the span's audio (lossless FLAC)");
  check(r.frames === DUR * FPS && r.width === W && r.height === H, `one matte frame per frame at the source size (${r.frames} @ ${r.width}x${r.height})`);
  const pv = (await streams(cut.proxyPath!)).find((s) => s.codec_type === "video");
  check(!!cut.proxyPath?.endsWith(".webm") && pv?.codec_name === "vp8" && (pv.tags?.alpha_mode ?? pv.tags?.ALPHA_MODE) === "1", "the preview proxy is VP8 with alpha", pv);
  console.log(`   (longest event-loop gap during the job: ${maxGap.toFixed(0)} ms)`);
  const nBase = join(dir, "n-base.aive");
  await n.engine.save(nBase);

  // ---- 2. frame-by-frame equivalence --------------------------------------------------------
  console.log("2. references from the same matte: legacy colour+alpha .mkv (L) and source-timed .mov (M)...");
  const legacy = join(dir, "legacy-cutout.mkv");
  const exact = join(dir, "exact-cutout.mov");
  const merge = `[0:v]setpts=N/${FPS}/TB,format=yuva420p[b];[1:v]setpts=N/${FPS}/TB,format=gray[a];[b][a]alphamerge[v]`;
  // Exactly what the old remove_background wrote: FFV1 yuva420p (-g 1, 16 slices) + the span's audio as AAC 192k, in Matroska.
  await ff(["-i", src, "-i", cut.path, "-filter_complex", merge, "-map", "[v]", "-map", "1:a", "-r", String(FPS), "-frames:v", String(DUR * FPS), "-c:v", "ffv1", "-level", "3", "-slices", "16", "-g", "1", "-pix_fmt", "yuva420p", "-c:a", "aac", "-b:a", "192k", legacy]);
  await ff(["-i", src, "-i", cut.path, "-filter_complex", merge, "-map", "[v]", "-map", "1:a", "-r", String(FPS), "-frames:v", String(DUR * FPS), "-c:v", "ffv1", "-level", "3", "-slices", "16", "-g", "1", "-pix_fmt", "yuva420p", "-video_track_timescale", "15360", "-c:a", "aac", "-b:a", "192k", exact]);
  // Sanity: the references' alpha is the stub matte of their own colour (decoded to RGB as the bake's decoder does).
  {
    const rgba = await frames(legacy, "rgba", undefined, "scale=in_color_matrix=bt709");
    let worst = 0;
    for (const f of rgba) {
      for (let p = 0; p < f.length; p += 4 * 37) worst = Math.max(worst, Math.abs(f[p + 3] - stubAlpha(f[p], f[p + 1], f[p + 2])));
    }
    check(rgba.length === DUR * FPS && worst <= 3, `reference alpha is the matte of its own frame (${rgba.length} frames, worst |alpha - key(colour)| ${worst})`);
  }
  const l = await layout(join(dir, "l"), red, blue, legacy);
  const m = await layout(join(dir, "m"), red, blue, exact);
  check(!l.asset.cutout && !m.asset.cutout, "the references are ordinary alpha assets (no cutout record)");
  const lBase = join(dir, "l-base.aive");
  const mBase = join(dir, "m-base.aive");
  await l.engine.save(lBase);
  await m.engine.save(mBase);

  console.log("   scenarios (lossless exports over red and blue; N = matte-backed, M = colour+alpha with the source's timestamps, L = old .mkv):");
  const legacyNotes: string[] = [];
  for (const sc of SCENARIOS) {
    const outs: Record<string, [string, string]> = {};
    await Promise.all(
      ([["n", n, nBase], ["m", m, mBase], ["l", l, lBase]] as const).map(async ([tag, lay, base]) => {
        await lay.engine.load(base);
        await sc.apply(lay.engine, lay.clipId);
        outs[tag] = await exportBoth(lay, join(dir, `${sc.name.replace(/[^a-z0-9]+/gi, "_")}-${tag}`));
      }),
    );
    const nm = [await compareVideos(outs.n[0], outs.m[0]), await compareVideos(outs.n[1], outs.m[1])];
    const okM = nm.every((c) => c.framesA === c.framesB && c.framesA > 0 && c.maxDiff === 0);
    check(okM, `${sc.name}: N == M on every frame over red and blue (${nm[0].framesA} frames)`, nm);
    const nl = [await compareVideos(outs.n[0], outs.l[0]), await compareVideos(outs.n[1], outs.l[1])];
    const okL = nl.every((c) => c.framesA === c.framesB && c.maxDiff === 0);
    if (!sc.legacy) check(okL, `${sc.name}: N == L (old .mkv cutout) on every frame`, nl);
    else {
      const why = sc.legacy === "ms" ? "its whole-millisecond timestamps" : "its video starting 23 ms late (AAC delay), so time seeks land a frame early";
      legacyNotes.push(`${sc.name}: ${okL ? "identical to" : `${Math.max(nl[0].differingFrames, nl[1].differingFrames)}/${nl[0].framesA} frames differ from`} the old .mkv cutout (${why})`);
    }
  }
  for (const note of legacyNotes) console.log(`   · ${note}`);

  // ---- 3. odd size, 24 fps footage, 30 fps project, off-grid trim -----------------------------
  console.log("3. odd-size 24 fps footage on a 30 fps project, trimmed off its frame grid: colour and matte stay paired...");
  {
    const flick = join(dir, "flicker24.mkv"); // FFV1: H.264 can't store an odd width
    // Flat gray frames whose level changes every frame (a misaligned matte would belong to a neighbour's level).
    await ff([
      "-f", "lavfi", "-i", "nullsrc=s=241x135:r=24:d=3,geq=lum='96+mod(N*13\\,56)':cb=128:cr=128,format=yuv420p",
      "-c:v", "ffv1", "-pix_fmt", "yuv420p", flick,
    ]);
    const black = join(dir, "black.mp4");
    const white = join(dir, "white.mp4");
    for (const [file, c] of [[black, "black"], [white, "white"]] as const) {
      await ff(["-f", "lavfi", "-i", `color=c=${c}:s=${W}x${H}:r=${FPS}:d=4`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "0", "-pix_fmt", "yuv420p", file]);
    }
    const e = new EditorEngine(join(dir, "odd"));
    e.setProjectSettings({ width: W, height: H, fps: FPS, name: "odd" });
    const aB = await e.importVideo(black);
    const aW = await e.importVideo(white);
    const aF = await e.importVideo(flick);
    e.addClip(aB.id, { startFrame: 0 });
    const tW = e.addTrack("video", { name: "white" });
    e.addClip(aW.id, { trackIndex: tW.index, startFrame: 0 });
    const tS = e.addTrack("video", { name: "subject" });
    const c = e.addClip(aF.id, { trackIndex: tS.index, startFrame: 0 });
    await dispatch(e, "trim_clip", { clipId: c.id, sourceInFrame: 4, sourceOutFrame: 70 }); // 0.133 s: between 24 fps frames 3 and 4
    const rr = await e.removeBackground(c.id, { stubMatte: true });
    check(rr.width === 240 && rr.height === 134, `matte at the even-floored source size (${rr.width}x${rr.height})`);
    // Frame 4 of the 24 fps footage (0.1667 s; Matroska rounds it to 0.167), not the project's 0.1333 s.
    check(Math.abs((rr.asset.cutout?.colorStart ?? 0) - 4 / 24) < 1e-3, `colour starts on the footage's own frame (${rr.asset.cutout?.colorStart.toFixed(4)} s = frame 4 at 24 fps)`);
    await dispatch(e, "split_clip", { clipId: c.id, atFrame: 23 }); // the right half seeks off-grid too
    const outB = join(dir, "odd-black.mp4");
    const outW = join(dir, "odd-white.mp4");
    await dispatch(e, "set_track_properties", { trackIndex: tW.index, hidden: true });
    await e.exportVideo(outB, LOSSLESS);
    await dispatch(e, "set_track_properties", { trackIndex: tW.index, hidden: false });
    await e.exportVideo(outW, LOSSLESS);
    const fb = await frames(outB, "rgb24");
    const fw = await frames(outW, "rgb24");
    let worst = 0;
    let checked = 0;
    for (let i = 0; i < Math.min(fb.length, fw.length); i++) {
      const p = ((H / 2) * W + W / 2) * 3; // centre pixel (the picture is flat)
      const g1 = fb[i][p];
      const g2 = fw[i][p];
      const a = 1 - (g2 - g1) / 255; // over black: a·F; over white: a·F + (1-a)·255
      if (a < 0.15) continue; // too transparent to read the colour back
      const fgr = g1 / a;
      worst = Math.max(worst, Math.abs(a * 255 - stubAlpha(fgr, fgr, fgr)));
      checked++;
    }
    check(checked > 40 && worst <= 16, `every frame's alpha is the matte of its own colour (${checked} frames, worst ${worst.toFixed(1)} levels; a one-frame slip is ~40)`);
  }

  // ---- 4. generate_proxy keeps transparency ----------------------------------------------------
  console.log("4. generate_proxy keeps transparency...");
  await n.engine.load(nBase);
  {
    // The preview remove_background baked is reused, not encoded a second time (which left the first behind).
    const rebuilt = join(dir, "n", "proxies", `${cut.id}.webm`);
    const again = (await dispatch(n.engine, "generate_proxy", { assetId: cut.id })) as { asset: MediaAsset };
    check(again.asset.proxyPath === cut.proxyPath && !existsSync(rebuilt), `cutout: generate_proxy reuses the baked preview (${again.asset.proxyPath?.split("/").pop()}, no second copy)`);
    // A missing preview is rebuilt (VP8+alpha, in proxies/).
    const aside = `${cut.proxyPath!}.aside`;
    renameSync(cut.proxyPath!, aside);
    let pr: { asset: MediaAsset };
    try {
      pr = (await dispatch(n.engine, "generate_proxy", { assetId: cut.id })) as { asset: MediaAsset };
    } finally {
      renameSync(aside, cut.proxyPath!);
    }
    check(pr.asset.proxyPath === rebuilt && existsSync(rebuilt), `cutout: a missing preview is rebuilt (${pr.asset.proxyPath?.split("/").pop()})`);
    const ps = (await streams(pr.asset.proxyPath!)).find((s) => s.codec_type === "video");
    check(!!pr.asset.proxyPath?.endsWith(".webm") && (ps?.tags?.alpha_mode ?? ps?.tags?.ALPHA_MODE) === "1", `cutout: proxy is still VP8+alpha (${pr.asset.proxyPath?.split("/").pop()})`);
    // The proxy's alpha is the cutout's (libvpx decodes the alpha plane).
    const pf = await frames(pr.asset.proxyPath!, "rgba", "libvpx");
    const ref = await frames(legacy, "rgba");
    let sum = 0;
    let count = 0;
    for (const k of [0, 10, 50, 89]) for (let p = 3; p < pf[k].length; p += 4 * 7) (sum += Math.abs(pf[k][p] - ref[k][p])), count++;
    const mean = sum / count;
    check(pf.length === DUR * FPS && mean <= 6, `cutout proxy alpha matches the cutout frame for frame (${pf.length} frames, mean |Δalpha| ${mean.toFixed(2)}; VP8 is lossy)`);
    const lp = (await dispatch(l.engine, "generate_proxy", { assetId: l.asset.id })) as { asset: MediaAsset };
    const ls = (await streams(lp.asset.proxyPath!)).find((s) => s.codec_type === "video");
    check(!!lp.asset.proxyPath?.endsWith(".webm") && (ls?.tags?.alpha_mode ?? ls?.tags?.ALPHA_MODE) === "1", "legacy colour+alpha cutout: proxy is VP8+alpha too");
    const srcAsset = n.engine.getProject().assets.find((a) => a.path === src)!;
    const op = (await dispatch(n.engine, "generate_proxy", { assetId: srcAsset.id })) as { asset: MediaAsset };
    const os = (await streams(op.asset.proxyPath!)).find((s) => s.codec_type === "video");
    check(!!op.asset.proxyPath?.endsWith(".mp4") && os?.codec_name === "h264", "ordinary footage: H.264 .mp4 proxy as before");
  }

  // ---- 5. colour readers and refusals ----------------------------------------------------------
  console.log("5. thumbnails, key colour and scenes read the colour; opaque bakes are refused...");
  {
    await n.engine.load(nBase);
    const th = (await dispatch(n.engine, "generate_thumbnail", { assetId: cut.id, atSeconds: 1 })) as { path: string };
    const tf = (await frames(th.path, "rgb24"))[0];
    const ref = (await frames(legacy, "rgba"))[30];
    // Where the matte removes the picture the thumbnail is black; where it keeps it, it isn't.
    let offSum = 0;
    let offN = 0;
    let onSum = 0;
    let onN = 0;
    for (let p = 0; p < W * H; p++) {
      const v = tf[p * 3] + tf[p * 3 + 1] + tf[p * 3 + 2];
      if (ref[p * 4 + 3] === 0) (offSum += v), offN++;
      else if (ref[p * 4 + 3] === 255) (onSum += v), onN++;
    }
    const offAvg = offSum / Math.max(1, offN);
    const onAvg = onSum / Math.max(1, onN);
    check(offN > 100 && onN > 100 && offAvg < 24 && onAvg > 150, `thumbnail: the removed background is black (avg ${offAvg.toFixed(1)}), the subject is not (avg ${onAvg.toFixed(1)})`);
    const project = n.engine.getProject();
    const cutClip = project.tracks.flatMap((t) => t.clips).find((c) => c.assetId === cut.id)!;
    const keyCut = await n.engine.detectKeyColor(cutClip.id);
    const srcAsset = project.assets.find((a) => a.path === src)!;
    const plain = n.engine.addClip(srcAsset.id, { trackIndex: 0, startFrame: 200 });
    const keySrc = await n.engine.detectKeyColor(plain.id);
    check(JSON.stringify(keyCut) === JSON.stringify(keySrc), "detect_key_color on the cutout reads its colour (same as the original clip)");
    const scenes = await n.engine.analyzeScenes(cut.id, 0.3);
    check(Array.isArray(scenes) && scenes.every((s) => s.time >= 0 && s.time <= DUR + 0.1), `analyze_scenes runs on the cutout's colour span (${scenes.length} cuts)`);
    for (const method of ["stabilize_clip", "auto_reframe", "remove_background"]) {
      const msg = await dispatch(n.engine, method, { clipId: cutClip.id }).then(() => "resolved", (err: Error) => err.message);
      check(/remove_background cutout|already has its background removed/.test(msg), `${method} on a cutout is refused with a teaching error`, msg);
    }
  }

  // ---- 6. segment keys + storage GC ------------------------------------------------------------
  console.log("6. segment-cache keys follow the colour file; storage GC sees the matte and proxy...");
  {
    const rc: ResolvedRenderClip = {
      path: cut.path, trackIndex: 2, showVideo: true, startSec: 0, sourceIn: 0, sourceSpan: DUR, outDuration: DUR, hasAudio: true, muted: false,
      cutout: { colorPath: src, colorStart: 0, fps: FPS, width: W, height: H, range: "tv" },
    };
    const canvas = { width: W, height: H, fps: FPS };
    const prof = { crf: 23, preset: "veryfast" } as never;
    const k1 = segmentKey([rc], { start: 0, end: DUR }, canvas, prof, { [cut.path]: 1, [src]: 1 }, null, { ffmpeg: "", xfadeEofPad: false });
    const k2 = segmentKey([rc], { start: 0, end: DUR }, canvas, prof, { [cut.path]: 1, [src]: 2 }, null, { ffmpeg: "", xfadeEofPad: false });
    check(k1 !== k2, "a newer colour file changes the segment key");
    const fr = (await dispatch(n.engine, "get_frame", { atSeconds: 1 })) as { path: string };
    check(existsSync(fr.path), "get_frame renders a preview segment with the cutout");

    // Its own data dir: no saved project or autosave names the bake there.
    const gdir = join(dir, "gc");
    const g = new EditorEngine(gdir);
    g.setProjectSettings({ width: W, height: H, fps: FPS, name: "gc" });
    const ga = await g.importVideo(src);
    const gclip = g.addClip(ga.id, { startFrame: 0 });
    const gcut = (await g.removeBackground(gclip.id, { stubMatte: true })).asset;
    const refs = referencedManagedPaths(gdir, [g.getProject()]);
    check(refs.has(gcut.path) && refs.has(gcut.proxyPath!), "storage GC: the matte and the proxy are referenced by the project");
    const fakeColour = join(gdir, "baked", "some-bake.mp4");
    const viaColour = referencedManagedPaths(gdir, [{ assets: [{ ...gcut, cutout: { colorPath: fakeColour, colorStart: 0 } }] }]);
    check(viaColour.has(fakeColour), "storage GC: a colour source inside baked/ is referenced through the cutout record");
    const old = (Date.now() - 3 * 3600_000) / 1000;
    for (const f of readdirSync(join(gdir, "baked"))) utimesSync(join(gdir, "baked", f), old, old);
    const names = (rep: { wouldTrash: { name: string }[] }) => rep.wouldTrash.map((c) => c.name);
    const inUse = await g.storage.report();
    check(!names(inUse).some((x) => gcut.path.endsWith(x) || gcut.proxyPath!.endsWith(x)), "storage report: neither file is up for the trash while the project uses them", names(inUse));
    g.reset();
    const unused = await g.storage.report();
    check(
      names(unused).some((x) => gcut.path.endsWith(x)) && names(unused).some((x) => gcut.proxyPath!.endsWith(x)),
      "…and both are once no project or history names them",
      names(unused),
    );
  }

  // ---- 6b. OTIO round trip; missing original footage ---------------------------------------
  console.log("6b. an OTIO round trip keeps the cutout; a missing original gives a teaching error...");
  {
    const colour = join(dir, "colour-copy.mp4");
    copyFileSync(src, colour);
    const o = new EditorEngine(join(dir, "otio"));
    o.setProjectSettings({ width: W, height: H, fps: FPS, name: "otio" });
    const oa = await o.importVideo(colour);
    const oc = o.addClip(oa.id, { startFrame: 0 });
    await o.removeBackground(oc.id, { stubMatte: true });
    const otioPath = join(dir, "cutout.otio");
    await dispatch(o, "export_otio", { path: otioPath });
    const o2 = new EditorEngine(join(dir, "otio2"));
    await dispatch(o2, "import_otio", { path: otioPath });
    const back = o2.getProject().assets.find((a) => a.cutout);
    check(back?.cutout?.colorPath === colour && back.cutout.colorAssetId === oa.id && back.name.endsWith("(background removed)"), "ZabsReel → OTIO → ZabsReel keeps the cutout record", back?.cutout);
    const saved = join(dir, "otio-save.aive");
    await o.save(saved);
    const o3 = new EditorEngine(join(dir, "otio3"));
    await o3.load(saved);
    check(o3.getProject().assets.find((a) => a.cutout)?.cutout?.colorAssetId === oa.id, "save and load keep the cutout's colour asset id");
    const fr = (await dispatch(o2, "get_frame", { atSeconds: 1 })) as { path: string };
    check(existsSync(fr.path), "the re-imported cutout renders");
    rmSync(colour);
    const msg = await dispatch(o2, "get_frame", { atSeconds: 2 }).then(() => "resolved", (err: Error) => err.message);
    check(/original footage is missing/.test(msg), "a missing original file is named in a teaching error", msg);
  }

  // ---- 6c. a cutout of an engine bake keeps the bake ------------------------------------------
  console.log("6c. a cutout whose colour is an engine bake keeps that bake in the library and on disk...");
  {
    const bdir = join(dir, "bakesrc");
    const b = new EditorEngine(bdir);
    b.setProjectSettings({ width: W, height: H, fps: FPS, name: "bakesrc" });
    const ba = await b.importVideo(src);
    const bclip = b.addClip(ba.id, { startFrame: 0 });
    const rev = (await b.reverseClip(bclip.id)).asset;
    const revWithProxy = await b.generateProxy(rev.id);
    const bcut = (await b.removeBackground(bclip.id, { stubMatte: true })).asset;
    check(bcut.cutout?.colorPath === rev.path && bcut.cutout?.colorAssetId === rev.id, "the cutout records its colour source's path and asset id", bcut.cutout);
    b.undo();
    b.redo();
    check(b.getProject().assets.find((a) => a.id === bcut.id)?.cutout?.colorAssetId === rev.id, "the colour source's id survives undo and redo");
    const has = (id: string) => b.getProject().assets.some((a) => a.id === id);
    const removable = async (includeImported: boolean) =>
      (await b.removeUnusedMedia({ dryRun: true, includeImported })).removed.map((r) => r.assetId);
    check(!(await removable(false)).includes(rev.id) && !(await removable(true)).includes(rev.id), "remove_unused_media (dry run, with and without imported media) keeps the colour source");
    const rep = await b.storage.report();
    check(!rep.libraryBakes.assets.some((a) => a.assetId === rev.id), "storage_report does not list the colour source as a library-only bake", rep.libraryBakes);
    const hist = b as unknown as { undoStack: unknown[]; redoStack: unknown[] };
    hist.undoStack = [];
    hist.redoStack = [];
    const pruned = b.pruneLibraryBakes();
    check(!pruned.some((p) => p.assetId === rev.id) && has(rev.id), "with no undo history, the library prune keeps the colour source", pruned);
    // A cutout saved before colorAssetId existed is matched by its colorPath.
    const legacyCut = b.getProject().assets.find((a) => a.id === bcut.id)!;
    delete legacyCut.cutout!.colorAssetId;
    check(!(await removable(true)).includes(rev.id) && !b.pruneLibraryBakes().some((p) => p.assetId === rev.id), "a cutout without colorAssetId keeps its colour source by path");
    const old = (Date.now() - 3 * 3600_000) / 1000;
    for (const area of ["baked", "proxies"]) {
      for (const f of readdirSync(join(bdir, area))) utimesSync(join(bdir, area, f), old, old);
    }
    const names = (r: { wouldTrash: { name: string }[] }) => r.wouldTrash.map((c) => c.name);
    const srcFiles = [rev.path, revWithProxy.proxyPath!];
    const kept = await b.storage.report();
    check(!names(kept).some((x) => srcFiles.some((f) => f.endsWith(x))), "storage report: the colour source's file and proxy are not up for the trash", names(kept));
    const fr = (await dispatch(b, "get_frame", { atSeconds: 1 })) as { path: string };
    check(existsSync(fr.path), "get_frame renders the cutout after the clean-up");
    // Once the cutout is gone, the colour source is an unused bake like any other.
    b.removeClip(bclip.id);
    hist.undoStack = [];
    hist.redoStack = [];
    const gone = b.pruneLibraryBakes().map((p) => p.assetId);
    check(gone.includes(rev.id) && gone.includes(bcut.id) && !has(rev.id), "with the cutout deleted, the prune drops the cutout and its colour source", gone);
    const freed = await b.storage.report();
    check(srcFiles.every((f) => names(freed).some((x) => f.endsWith(x))), "…and the source's file and proxy become trashable", names(freed));
  }

  // ---- 7. inline fallback, cancel -----------------------------------------------------------
  console.log("7. AIVE_RVM_INLINE=1 writes the identical matte on the calling thread; cancel_job cleans up...");
  {
    await n.engine.load(nBase);
    const project = n.engine.getProject();
    const srcAsset = project.assets.find((a) => a.path === src)!;
    const c2 = n.engine.addClip(srcAsset.id, { trackIndex: 0, startFrame: 300 });
    process.env.AIVE_RVM_INLINE = "1";
    const ri = await n.engine.removeBackground(c2.id, { stubMatte: true });
    delete process.env.AIVE_RVM_INLINE;
    check(ri.runner === "inline", `runner is inline (${ri.runner})`);
    const md5 = async (f: string) => (await execa(FFMPEG_BIN, ["-hide_banner", "-loglevel", "error", "-i", f, "-map", "0:v", "-f", "md5", "-"])).stdout.trim();
    check((await md5(ri.asset.path)) === (await md5(cut.path)), "the inline matte is identical to the worker's");

    // Long enough that an abandoned run would still be matting well after the 2 s checks below.
    const long = join(dir, "long.mp4");
    await ff(["-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=60", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", long]);
    const aLong = await n.engine.importVideo(long);
    const cl = n.engine.addClip(aLong.id, { trackIndex: 0, startFrame: 600 });
    const bakedDir = join(dir, "n", "baked");
    const before = readdirSync(bakedDir).filter((f) => f.includes(cl.id)).length;
    const workersBefore = workers.created;
    // The run's ffmpeg decoder/encoder: children of this process naming the clip's input or output.
    const runChildren = async () =>
      (await execa("ps", ["--ppid", String(process.pid), "-o", "pid=,args="], { reject: false })).stdout
        .split("\n")
        .filter((l) => /ffmpeg/.test(l) && (l.includes(long) || l.includes(cl.id)));
    const { job, promise } = n.engine.startRemoveBackgroundJob(cl.id, { stubMatte: true });
    await new Promise((res) => setTimeout(res, 700));
    // Cancel mid-run, once the worker has started both ffmpeg processes (a slow worker start can take longer).
    let childrenWhileRunning = await runChildren();
    for (let i = 0; i < 50 && childrenWhileRunning.length < 2; i++) {
      await new Promise((res) => setTimeout(res, 100));
      childrenWhileRunning = await runChildren();
    }
    check(workers.created === workersBefore + 1 && workers.live.size === 1 && childrenWhileRunning.length === 2,
      "the run has a worker thread and two ffmpeg children", { workers: workers.live.size, children: childrenWhileRunning });
    const t0 = performance.now();
    n.engine.jobs.cancel(job.id);
    const outcome = await promise.then(() => "resolved", (err: Error) => err.message);
    const took = performance.now() - t0;
    check(outcome !== "resolved" && took < 3000, `cancel stops the run promptly (${took.toFixed(0)} ms: ${outcome})`);
    check(n.engine.jobs.get(job.id)?.status === "canceled", "job status is canceled");
    let left = await runChildren();
    for (let i = 0; i < 20 && (workers.live.size || left.length); i++) {
      await new Promise((res) => setTimeout(res, 100));
      left = await runChildren();
    }
    check(workers.live.size === 0, "the worker thread has exited within 2 s");
    check(left.length === 0, "no ffmpeg child of the run is left within 2 s", left);
    // After the exits above: a late write by a leftover could only have landed by now.
    await new Promise((res) => setTimeout(res, 300));
    const after = readdirSync(bakedDir).filter((f) => f.includes(cl.id)).length;
    check(after === before, "no partial matte or proxy left behind");
  }

  // ---- 8. a cutout's colour is its colour source's -------------------------------------------
  console.log("8. a cutout shows the clip's own colours (tagged BT.601 HD, BT.709 SD, full range): export, thumbnail, freeze, reverse...");
  {
    // Bright, distinctive patches the stub matte keeps (luma ≥ 175: alpha 255) and three dark ones it removes (alpha 0).
    const PAT: [number, number, number][] = [
      [255, 255, 0], [0, 255, 255], [224, 172, 105], [255, 200, 0], [120, 255, 200], [255, 180, 200], [180, 220, 255], [200, 255, 100],
      [0, 0, 0], [40, 20, 10], [255, 255, 255], [150, 255, 255], [255, 210, 255], [255, 230, 120], [10, 30, 60], [235, 235, 235],
    ];
    const kept = PAT.map(([r, g, b]) => stubAlpha(r, g, b) === 255);
    const removed = PAT.map(([r, g, b]) => stubAlpha(r, g, b) === 0);
    /** Patch-centre colours (6×6 averages) of a W×H rgb24 frame. */
    const centres = (rgb: Buffer) =>
      PAT.map((_, i) => {
        const cx = Math.floor((((i % 8) + 0.5) * W) / 8), cy = Math.floor(((Math.floor(i / 8) + 0.5) * H) / 2);
        const acc = [0, 0, 0];
        for (let y = cy - 3; y < cy + 3; y++) for (let x = cx - 3; x < cx + 3; x++) for (let c = 0; c < 3; c++) acc[c] += rgb[(y * W + x) * 3 + c];
        return acc.map((v) => v / 36);
      });
    const AS_EXPORTED = "scale=in_color_matrix=bt709:in_range=tv:flags=bilinear+accurate_rnd+full_chroma_int"; // OUTPUT_COLOR
    const worst = (a: number[][], b: number[][], which: boolean[]) =>
      Math.round(Math.max(0, ...a.flatMap((p, i) => (which[i] ? p.map((v, c) => Math.abs(v - b[i][c])) : []))) * 10) / 10;
    const pat = join(dir, "colpat.rgb");
    const rgb = (w: number, h: number) => {
      const b = Buffer.alloc(w * h * 3);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.set(PAT[Math.floor((y * 2) / h) * 8 + Math.floor((x * 8) / w)], (y * w + x) * 3);
      return b;
    };
    const ALL = (m: string, p: string, t: string) => ["-colorspace", m, "-color_primaries", p, "-color_trc", t];
    const rows: { name: string; w: number; h: number; matrix: string; range: "tv" | "pc"; tags: string[]; mjpeg?: boolean }[] = [
      { name: "BT.601-tagged HD", w: 1280, h: 720, matrix: "bt601", range: "tv", tags: [...ALL("smpte170m", "smpte170m", "smpte170m"), "-color_range", "tv"] },
      { name: "BT.709-tagged SD", w: W, h: H, matrix: "bt709", range: "tv", tags: [...ALL("bt709", "bt709", "bt709"), "-color_range", "tv"] },
      { name: "full range JPEG (MJPEG yuvj420p)", w: W, h: H, matrix: "bt601", range: "pc", tags: [], mjpeg: true },
      { name: "full range, BT.709-tagged", w: W, h: H, matrix: "bt709", range: "pc", tags: [...ALL("bt709", "bt709", "bt709"), "-color_range", "pc"] },
    ];
    for (const [k, row] of rows.entries()) {
      writeFileSync(pat, rgb(row.w, row.h));
      const png = join(dir, `colpat${k}.png`);
      await ff(["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${row.w}x${row.h}`, "-i", pat, "-frames:v", "1", png]);
      const file = join(dir, `colsrc${k}.${row.mjpeg ? "mkv" : "mp4"}`);
      const pix = row.range === "pc" ? "yuvj420p" : "yuv420p";
      const v = (opt: string) => (row.tags.includes(opt) ? row.tags[row.tags.indexOf(opt) + 1] : "unknown");
      await ff([
        "-loop", "1", "-framerate", String(FPS), "-i", png, "-t", "1",
        "-vf", `scale=out_color_matrix=${row.matrix}:out_range=${row.range}:flags=lanczos+accurate_rnd+full_chroma_int,format=${pix},` +
          `setparams=colorspace=${v("-colorspace")}:color_primaries=${v("-color_primaries")}:color_trc=${v("-color_trc")}:range=${row.mjpeg ? "pc" : v("-color_range")}`,
        ...(row.mjpeg ? ["-c:v", "mjpeg", "-q:v", "2"] : ["-c:v", "libx264", "-crf", "4"]), "-pix_fmt", pix, ...row.tags, file,
      ]);
      const e = new EditorEngine(join(dir, `col${k}`));
      e.setProjectSettings({ width: W, height: H, fps: FPS, name: `col${k}` });
      const a = await e.importVideo(file);
      const clip = e.addClip(a.id, { startFrame: 0 });
      const exp = async (tag: string) => {
        const out = join(dir, `col${k}-${tag}.mp4`);
        await e.exportVideo(out, LOSSLESS);
        return (await frames(out, "rgb24", undefined, AS_EXPORTED)).map(centres);
      };
      const thumb = async (assetId: string) => centres((await frames(await e.generateThumbnail(assetId, 0.5), "rgb24"))[0]);
      const plain = (await exp("plain"))[10];
      const plainThumb = await thumb(a.id);
      const truth = worst(plain, PAT, PAT.map(() => true));
      const cutAsset = (await e.removeBackground(clip.id, { stubMatte: true })).asset;
      // The preview plays the cutout's VP8+alpha proxy: coded and tagged (completely) as its colour is read.
      const pt = cutAsset.proxyColor;
      const space = row.matrix === "bt709" ? "bt709" : "smpte170m";
      check(pt?.space === space && pt.primaries === space && pt.transfer === space && pt.range === "tv" && previewColorFix(cutAsset, true) === null,
        `${row.name}: the cutout's preview proxy is tagged ${space}/tv, complete (${pt?.space}/${pt?.primaries}/${pt?.transfer}/${pt?.range}), so the preview shows it uncorrected`);
      const results: [string, number[][][], number][] = [["export", await exp("cut"), 4]];
      results.push(["thumbnail", [await thumb(cutAsset.id)], 8]);
      await dispatch(e, "freeze_frame", { clipId: clip.id, atSeconds: 0.5, durationSeconds: 0.3 });
      results.push(["freeze frame", await exp("freeze"), 4]);
      e.undo();
      await dispatch(e, "reverse_clip", { clipId: clip.id });
      results.push(["reverse bake", await exp("reverse"), 4]);
      const detail: string[] = [];
      let ok = truth <= 4;
      for (const [what, got, tol] of results) {
        const ref = what === "thumbnail" ? plainThumb : plain;
        const off = Math.max(...got.map((f) => worst(f, ref, kept)));
        const bg = Math.max(...got.map((f) => Math.max(...f.flatMap((p, i) => (removed[i] ? p : [])))));
        ok &&= got.length > 0 && off <= tol && bg <= 4;
        detail.push(`${what} ${off}${bg > 4 ? ` (removed patches not black: ${bg.toFixed(1)})` : ""}`);
      }
      check(ok, `${row.name}: the cutout's kept patches = the clip without background removal (max level difference: ${detail.join(", ")}; clip vs true colours ${truth})`);
    }
  }

  console.log(`\n   sizes for this synthetic ${W}x${H} clip: matte ${statSync(cut.path).size} B vs old colour+alpha cutout ${statSync(legacy).size} B (${(statSync(legacy).size / statSync(cut.path).size).toFixed(1)}x)`);
  if (failures) {
    console.error(`\nCUTOUT SMOKE TEST FAILED (${failures} check${failures === 1 ? "" : "s"})`);
    process.exit(1);
  }
  rmSync(dir, { recursive: true, force: true });
  console.log("\nCUTOUT SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("CUTOUT SMOKE TEST FAILED:", err);
  process.exit(1);
});
