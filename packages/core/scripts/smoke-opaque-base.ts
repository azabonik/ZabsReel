/**
 * Opaque-base smoke test: the render graph
 * skips its full-canvas black base (and the first full-frame RGBA overlay)
 * only when the bottom layer is ONE opaque, untransformed, canvas-filling clip
 * that covers the whole render (graph.ts fillsCanvasOpaque). That clip then
 * becomes the base itself, padded with opaque black. Every case that can make
 * or move alpha keeps the black base: a source with alpha, a transform, a
 * transition, a fade, opacity < 1, a mask, a still, a crop, another aspect, a
 * clip that starts late or ends early, and a colour (eq) grade: its two
 * transparent end-guard frames, which the eq brightens, follow the video's last
 * frame when the video ends early, and only a base under them keeps them black.
 * A secondary grade and a LUT keep the shortcut, and so does a preview segment
 * whose window starts inside the clip or exactly at its start.
 *
 * The graph checks are pure logic. The pixel check renders a synthesized 2 s
 * clip that is 3 s long on the timeline (its last second is the black pad)
 * as the engine flags it (opaque) and with the black base forced (opaque
 * unset), as an export and as three preview segments (one whose window ends
 * before the clip does, one whose window starts after the video ends), plain
 * and colour-graded, and compares the decoded frames (framemd5): the opaque
 * flag stays out of the segment key (segments.ts), so the shortcut must render
 * the same pixels. A render that hangs is killed and fails the test.
 *
 * Run: npx tsx packages/core/scripts/smoke-opaque-base.ts
 * (Self-contained: synthesizes its clip with ffmpeg.)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRenderCommand, EXPORT_PROFILE, PREVIEW_PROFILE } from "../src/ffmpeg/graph.js";
import { FfmpegError, runFfmpeg, runFfmpegStdoutBuffer } from "../src/ffmpeg/executor.js";
import type { ResolvedEffects, ResolvedRenderClip } from "../src/types.js";

const canvas = { width: 1920, height: 1080, fps: 30 };
const BLACK_BASE = `color=c=black:s=${canvas.width}x${canvas.height}:`;
/** The own base of a render `total` seconds long, padded with one render length of black frames (between the window's trim and setpts). */
const OWN_BASE = (total: number, cut?: number) => {
  const pad = `tpad=stop=${Math.ceil(total * canvas.fps) + 1}:stop_mode=add:color=black`;
  return cut === undefined ? `${pad}[vbase]` : `trim=start=${cut.toFixed(6)},${pad},setpts=PTS-STARTPTS[vbase]`;
};
/** A render that runs longer than this is a hang (FFmpeg 7.1 once spun forever on an unbounded pad): kill it and fail. */
const RENDER_TIMEOUT_MS = 60_000;

function clip(over: Partial<ResolvedRenderClip> = {}): ResolvedRenderClip {
  return {
    path: "/media/a.mp4",
    trackIndex: 0,
    showVideo: true,
    startSec: 0,
    sourceIn: 0,
    sourceSpan: 10,
    outDuration: 10,
    hasAudio: true,
    muted: false,
    colorIn: { matrix: "bt709", range: "tv" },
    size: { w: 3840, h: 2160 },
    opaque: true,
    ...over,
  };
}

/** The video graph of an export (or a windowed, video-only preview segment) of `clips`. */
function graphOf(clips: ResolvedRenderClip[], window?: { start: number; end: number }): string {
  const { args } = window
    ? buildRenderCommand(clips, canvas, "/tmp/o.ts", PREVIEW_PROFILE, undefined, undefined, { window, videoOnly: true })
    : buildRenderCommand(clips, canvas, "/tmp/o.mp4", EXPORT_PROFILE);
  const at = args.indexOf("-filter_complex");
  if (at < 0) throw new Error("no -filter_complex in the command");
  return args[at + 1];
}

let failed = 0;
/** `cut`: how far the window's trim cuts into the bottom clip (unset: no trim). */
function expectBase(label: string, clips: ResolvedRenderClip[], wantOwn: boolean, window?: { start: number; end: number }, cut?: number): void {
  const g = graphOf(clips, window);
  const black = g.includes(BLACK_BASE);
  const total = window ? window.end - window.start : Math.max(...clips.map((c) => c.startSec + c.outDuration));
  const own = g.includes(OWN_BASE(total, cut));
  const ok = wantOwn ? own && !black : black && !own;
  console.log(`   ${ok ? "✓" : "✗"} ${label}: ${own ? "clip is the base" : black ? "black base" : "no base?"}`);
  if (!ok) failed++;
}

console.log("opaque bottom layer: no black base");
expectBase("one opaque 16:9 clip filling the render", [clip()], true);
expectBase("with a secondary grade and a LUT (no sub-graph)", [clip({ effects: { grade: { temperature: 0.3, lift: { r: 0.05, g: 0, b: 0 } }, lut: "look.cube" } })], true);
expectBase("a preview segment whose window starts inside the clip", [clip()], true, { start: 2, end: 7 }, 2);
expectBase("a preview segment whose window starts exactly at the clip's start (no trim)", [clip({ startSec: 1, outDuration: 9, sourceSpan: 9 })], true, { start: 1, end: 5 });

console.log("everything that can make or move alpha keeps it");
expectBase("a source with alpha (opaque unset)", [clip({ opaque: undefined })], false);
expectBase("a transform", [clip({ effects: { transform: { scale: 0.6 } } })], false);
expectBase("a transition run", [clip({ outDuration: 5, sourceSpan: 5 }), clip({ startSec: 4.5, outDuration: 5.5, sourceSpan: 5.5, transition: { type: "fade", duration: 0.5 } })], false);
expectBase("a fade in", [clip({ effects: { fadeIn: 0.5 } })], false);
expectBase("a fade out", [clip({ effects: { fadeOut: 0.5 } })], false);
expectBase("opacity below 1", [clip({ effects: { opacity: 0.5 } })], false);
expectBase("a shape mask", [clip({ effects: { maskFile: "mask-0.png" } })], false);
expectBase("a still image", [clip({ isImage: true })], false);
expectBase("a crop", [clip({ effects: { crop: { x: 0, y: 0, width: 1920, height: 1080 } } })], false);
expectBase("another aspect (4:3 on 16:9)", [clip({ size: { w: 1440, h: 1080 } })], false);
expectBase("a clip that starts after 0", [clip({ startSec: 1, outDuration: 9, sourceSpan: 9 })], false);
expectBase("a clip that ends before the render (a longer clip above)", [clip({ outDuration: 5, sourceSpan: 5 }), clip({ trackIndex: 1, outDuration: 8, sourceSpan: 8, effects: { transform: { scale: 0.5 } } })], false);
expectBase("a blend mode", [clip({ effects: { blendMode: "screen" } })], false);
expectBase("a colour grade (its eq brightens the transparent end-guard frames)", [clip({ effects: { color: { contrast: 1.2, saturation: 1.1 } } })], false);

console.log("pixels: the clip as its own base renders what the black base does");
const dir = mkdtempSync(join(tmpdir(), "aive-opaque-base-"));
try {
  const small = { width: 640, height: 360, fps: 30 };
  const src = join(dir, "src.mp4");
  await runFfmpeg(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=2", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-y", src]);
  // 3 s on the timeline from a 2 s file: the last second shows the pad (the own base's tpad, or the black base).
  const one = (opaque: boolean | undefined, effects?: ResolvedEffects) => [
    clip({ path: src, size: { w: 640, h: 360 }, sourceSpan: 3, outDuration: 3, hasAudio: false, opaque, ...(effects ? { effects } : {}) }),
  ];
  /** The render's frame hashes, and whether the clip was its own base (no black base in the graph). */
  const frames = async (name: string, opaque: boolean | undefined, window?: { start: number; end: number }, effects?: ResolvedEffects) => {
    const out = join(dir, `${name}-${opaque ? "own" : "black"}.${window ? "ts" : "mp4"}`);
    const { args } = window
      ? buildRenderCommand(one(opaque, effects), small, out, PREVIEW_PROFILE, undefined, undefined, { window, videoOnly: true })
      : buildRenderCommand(one(opaque, effects), small, out, EXPORT_PROFILE);
    const graph = args[args.indexOf("-filter_complex") + 1];
    const ownBase = !graph.includes(`color=c=black:s=${small.width}x${small.height}:`);
    if (ownBase && !opaque) throw new Error(`${name}: the alpha render took the shortcut`);
    await runFfmpeg(args, { signal: AbortSignal.timeout(RENDER_TIMEOUT_MS) });
    const md5 = Buffer.from(await runFfmpegStdoutBuffer(["-v", "error", "-i", out, "-map", "0:v:0", "-f", "framemd5", "-"])).toString("utf8");
    return { ownBase, md5s: md5.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop()!.trim()) };
  };
  // A colour grade: its eq brightens the two transparent end-guard frames that follow the video's last frame.
  const bright: ResolvedEffects = { color: { brightness: 0.1 } };
  // [name, label, window, effects, the opaque render is its own base]
  const cases: [string, string, { start: number; end: number } | undefined, ResolvedEffects | undefined, boolean][] = [
    ["export", "export", undefined, undefined, true],
    ["segment", "segment 1.5-3 s", { start: 1.5, end: 3 }, undefined, true],
    // The window ends before the clip does: the trim at its start and the end cut both fall inside the video.
    ["early", "segment 0.5-1.5 s (ends before the clip ends)", { start: 0.5, end: 1.5 }, undefined, true],
    // The window starts after the video ends: the trimmed clip has no frames, the pad alone is the picture.
    ["late", "segment 2.5-3 s (after the video ends)", { start: 2.5, end: 3 }, undefined, true],
    ["bright", "colour-graded export", undefined, bright, false],
    // The window starts 0.1 s before the video ends, so the end-guard frames fall inside it.
    ["bright-seg", "colour-graded segment 1.9-3 s", { start: 1.9, end: 3 }, bright, false],
  ];
  for (const [name, label, window, effects, wantOwn] of cases) {
    let ownBase: boolean, own: string[], black: string[];
    try {
      ({ ownBase, md5s: own } = await frames(name, true, window, effects));
      ({ md5s: black } = await frames(name, undefined, window, effects));
    } catch (err) {
      // A hang (killed at the timeout) or an output FFmpeg cannot read back (no frames at all) fails this case.
      const hung = err instanceof FfmpegError && err.message.includes("canceled");
      console.log(`   ✗ ${label}: ${hung ? `render ran past ${RENDER_TIMEOUT_MS / 1000} s, ffmpeg killed` : (err as Error).message.split("\n")[0]}`);
      failed++;
      continue;
    }
    const want = Math.round((window ? window.end - window.start : 3) * small.fps);
    const same = own.length === want && own.length === black.length && own.every((m, i) => m === black[i]);
    const diff = own.findIndex((m, i) => m !== black[i]);
    const ok = same && ownBase === wantOwn;
    const base = ownBase === wantOwn ? "" : `; the opaque render ${ownBase ? "was its own base" : "kept the black base"}, want ${wantOwn ? "its own base" : "the black base"}`;
    console.log(`   ${ok ? "✓" : "✗"} ${label}: ${own.length} / ${black.length} frames (want ${want})${same ? ", framemd5-identical" : `, first difference at frame ${diff}`}${base}`);
    if (!ok) failed++;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.error(`\nOPAQUE BASE SMOKE TEST FAILED (${failed})`);
  process.exit(1);
}
console.log("\nOPAQUE BASE SMOKE TEST PASSED");
