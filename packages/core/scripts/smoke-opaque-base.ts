/**
 * Opaque-base smoke test: the render graph
 * skips its full-canvas black base (and the first full-frame RGBA overlay)
 * only when the bottom layer is ONE opaque, untransformed, canvas-filling clip
 * that covers the whole render (graph.ts fillsCanvasOpaque). That clip then
 * becomes the base itself, padded with opaque black. Every case that can make
 * or move alpha keeps the black base: a source with alpha, a transform, a
 * transition, a fade, opacity < 1, a mask, a still, a crop, another aspect, a
 * clip that starts late or ends early. A plain colour grade keeps the
 * shortcut, and so does a preview segment whose window starts inside the clip.
 *
 * The graph checks are pure logic. The pixel check renders a synthesized 2 s
 * clip that is 3 s long on the timeline (its last second is the black pad)
 * with the shortcut and without it, as an export and as a preview segment, and
 * compares the decoded frames (framemd5): the shortcut keeps CACHE_VERSION, so
 * it must render the same pixels.
 *
 * Run: npx tsx packages/core/scripts/smoke-opaque-base.ts
 * (Self-contained: synthesizes its clip with ffmpeg.)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRenderCommand, EXPORT_PROFILE, PREVIEW_PROFILE } from "../src/ffmpeg/graph.js";
import { runFfmpeg, runFfmpegStdoutBuffer } from "../src/ffmpeg/executor.js";
import type { ResolvedRenderClip } from "../src/types.js";

const canvas = { width: 1920, height: 1080, fps: 30 };
const BLACK_BASE = `color=c=black:s=${canvas.width}x${canvas.height}:`;
const OWN_BASE = "tpad=stop=-1:stop_mode=add:color=black[vbase]";

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
function expectBase(label: string, clips: ResolvedRenderClip[], wantOwn: boolean, window?: { start: number; end: number }): void {
  const g = graphOf(clips, window);
  const black = g.includes(BLACK_BASE);
  const own = g.includes(OWN_BASE);
  const ok = wantOwn ? own && !black : black && !own;
  console.log(`   ${ok ? "✓" : "✗"} ${label}: ${own ? "clip is the base" : black ? "black base" : "no base?"}`);
  if (!ok) failed++;
}

console.log("opaque bottom layer: no black base");
expectBase("one opaque 16:9 clip filling the render", [clip()], true);
expectBase("with a colour grade (eq keeps alpha)", [clip({ effects: { color: { contrast: 1.2, saturation: 1.1 } } })], true);
expectBase("a preview segment whose window starts inside the clip", [clip()], true, { start: 2, end: 7 });

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

console.log("pixels: the clip as its own base renders what the black base does");
const dir = mkdtempSync(join(tmpdir(), "aive-opaque-base-"));
try {
  const small = { width: 640, height: 360, fps: 30 };
  const src = join(dir, "src.mp4");
  await runFfmpeg(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=2", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-y", src]);
  // 3 s on the timeline from a 2 s file: the last second shows the pad (the own base's tpad, or the black base).
  const one = (opaque?: boolean) => [clip({ path: src, size: { w: 640, h: 360 }, sourceSpan: 3, outDuration: 3, hasAudio: false, opaque })];
  const frames = async (name: string, opaque: boolean | undefined, window?: { start: number; end: number }) => {
    const out = join(dir, `${name}-${opaque ? "own" : "black"}.${window ? "ts" : "mp4"}`);
    const { args } = window
      ? buildRenderCommand(one(opaque), small, out, PREVIEW_PROFILE, undefined, undefined, { window, videoOnly: true })
      : buildRenderCommand(one(opaque), small, out, EXPORT_PROFILE);
    const graph = args[args.indexOf("-filter_complex") + 1];
    const blackBase = graph.includes(`color=c=black:s=${small.width}x${small.height}:`);
    if (blackBase === !!opaque) throw new Error(`${name}: the ${opaque ? "opaque" : "alpha"} render ${opaque ? "skipped" : "took"} the shortcut`);
    await runFfmpeg(args);
    const md5 = Buffer.from(await runFfmpegStdoutBuffer(["-v", "error", "-i", out, "-map", "0:v:0", "-f", "framemd5", "-"])).toString("utf8");
    return md5.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop()!.trim());
  };
  for (const [name, label, window] of [["export", "export", undefined], ["segment", "segment 1.5-3 s", { start: 1.5, end: 3 }]] as const) {
    const own = await frames(name, true, window);
    const black = await frames(name, undefined, window);
    const want = Math.round((window ? window.end - window.start : 3) * small.fps);
    const same = own.length === want && own.length === black.length && own.every((m, i) => m === black[i]);
    const diff = own.findIndex((m, i) => m !== black[i]);
    console.log(`   ${same ? "✓" : "✗"} ${label}: ${own.length} / ${black.length} frames (want ${want})${same ? ", framemd5-identical" : `, first difference at frame ${diff}`}`);
    if (!same) failed++;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.error(`\nOPAQUE BASE SMOKE TEST FAILED (${failed})`);
  process.exit(1);
}
console.log("\nOPAQUE BASE SMOKE TEST PASSED");
