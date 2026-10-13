/**
 * Phase 2 smoke test: crossfade transitions. Builds 3 clips, adds a 1s
 * crossfade entering clip 2 and a hard cut into clip 3, exports, and verifies
 * the output duration reflects the overlap (total - transition durations).
 *
 * Then, on synthesized frame-index-coded media (no args needed for this part),
 * the incoming clip of a transition is placed exactly where the timeline puts
 * it (known issue A8: FFmpeg before 7 ended an xfade one frame early and
 * showed the incoming clip one frame late): during a wipe the incoming side
 * shows the modelled source frame, after the transition every frame does, and
 * the export is exactly the timeline's length. The FFmpeg 4-6 workaround (a
 * cloned frame before xfade) is in the graph only when xfadeEofPad asks for
 * it; run with AIVE_FFMPEG pointing at an FFmpeg 7+ build to check the
 * unpadded graph frame by frame too.
 *
 * Run: npx tsx packages/core/scripts/smoke-transitions.ts <clipA> <clipB>
 */
import { execa } from "execa";
import { EditorEngine } from "../src/engine.js";
import { FFMPEG_BIN, ffmpegVersionLine } from "../src/ffmpeg/executor.js";
import { buildRenderCommand, EXPORT_PROFILE } from "../src/ffmpeg/graph.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import type { Canvas, ResolvedRenderClip } from "../src/types.js";

async function main() {
  const [, , clipA, clipB] = process.argv;
  if (!clipA || !clipB) throw new Error("usage: smoke-transitions.ts <clipA> <clipB>");

  const dataDir = mkdtempSync(join(tmpdir(), "aive-tr-"));
  const engine = new EditorEngine(dataDir);

  const a = await engine.importVideo(clipA);
  const b = await engine.importVideo(clipB);
  const fps = engine.fps;
  engine.appendClip(a.id);
  const c2 = engine.appendClip(b.id);
  const c3 = engine.appendClip(a.id);
  // Expectations derive from the PROBED durations so any test media works.
  const baseline = 2 * a.duration + b.duration;
  console.log(`baseline timeline: ${engine.timelineDuration().toFixed(2)}s (expect ~${baseline.toFixed(1)})`);

  // 1s crossfade entering clip 2 -> overlaps clip1/clip2 by 1s.
  engine.setTransition(c2.id, "fade", Math.round(1 * fps));
  const afterT = engine.timelineDuration();
  console.log(`after 1s crossfade into clip2: ${afterT.toFixed(2)}s (expect ~${(baseline - 1).toFixed(1)})`);
  if (Math.abs(afterT - (baseline - 1)) > 0.15) throw new Error(`transition duration math wrong: ${afterT}`);

  // dissolve entering clip 3 too.
  engine.setTransition(c3.id, "dissolve", Math.round(0.8 * fps));
  const total = engine.timelineDuration();
  console.log(`after dissolve into clip3: ${total.toFixed(2)}s (expect ~${(baseline - 1.8).toFixed(1)})`);

  const out = join(dataDir, "tr.mp4");
  const result = await engine.exportVideo(out);
  const probed = await probeAsset(out);
  console.log(`exported: ${probed.width}x${probed.height} ${probed.duration.toFixed(2)}s (engine est ~${result.duration.toFixed(2)})`);
  if (Math.abs(probed.duration - result.duration) > 0.8) {
    throw new Error(`export duration drift: got ${probed.duration}, expected ${result.duration}`);
  }

  // Verify a hard-cut + transition mix also renders: remove transition on clip2.
  engine.removeTransition(c2.id);
  const out2 = join(dataDir, "tr2.mp4");
  await engine.exportVideo(out2);
  const probed2 = await probeAsset(out2);
  console.log(`mixed cut+transition export: ${probed2.duration.toFixed(2)}s`);

  await incomingClipTiming();

  console.log("\nTRANSITIONS SMOKE TEST PASSED");
}

/** Decode each frame's index (9 stripes = bits) on the row at `row` (0..1 of the height). */
async function frameIndexes(file: string, row: number): Promise<number[]> {
  const W = 160;
  const H = 90;
  const { stdout } = await execa(FFMPEG_BIN, ["-hide_banner", "-v", "error", "-i", file, "-vf", `scale=${W}:${H}:flags=neighbor,format=yuv444p`, "-f", "rawvideo", "-"], {
    encoding: "buffer",
    maxBuffer: 1 << 29,
  });
  const b = Buffer.from(stdout as unknown as Uint8Array);
  const fs = W * H * 3;
  const out: number[] = [];
  for (let k = 0; k < Math.floor(b.length / fs); k++) {
    let n = 0;
    for (let bit = 0; bit < 9; bit++) if (b[k * fs + Math.floor(H * row) * W + Math.floor(((bit + 0.5) * W) / 9)] > 125) n |= 1 << bit;
    out.push(n);
  }
  return out;
}

/** A8: the incoming clip of a transition shows the frame the timeline model puts there. */
async function incomingClipTiming(): Promise<void> {
  console.log("\nincoming clip of a transition lands on the modelled frames");
  const dir = mkdtempSync(join(tmpdir(), "aive-tr-coded-"));
  const src = join(dir, "coded.mp4");
  await execa(FFMPEG_BIN, [
    "-hide_banner", "-y", "-f", "lavfi",
    "-i", "color=c=gray:s=160x90:r=30:d=12,format=yuv420p,geq=lum='if(gt(mod(floor(N/pow(2,floor(X*9/W))),2),0),220,30)':cb=128:cr=128",
    "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-g", "15", src,
  ]);
  const engine = new EditorEngine(dir);
  engine.setProjectSettings({ width: 160, height: 90, fps: 30, name: "tr-coded" });
  const asset = await engine.importVideo(src);
  console.log(`  (${await ffmpegVersionLine()})`);
  let failures = 0;
  for (const [type, frames] of [["wipeup", 15], ["wipedown", 9], ["fade", 20]] as const) {
    for (const t of engine.getProject().tracks) for (const c of [...t.clips]) engine.removeClip(c.id);
    engine.addClip(asset.id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: 120 });
    const y = engine.addClip(asset.id, { startFrame: 120, sourceInFrame: 200, sourceOutFrame: 290 });
    engine.setTransition(y.id, type, frames);
    const yStart = engine.getProject().tracks[0].clips.find((c) => c.id === y.id)!.startFrame;
    if (type === "wipeup") {
      // The end-of-stream pad is FFmpeg-version dependent: in the graph exactly when asked for.
      const canvas = engine.canvas;
      const { clips } = await (engine as unknown as { stageRender(c: Canvas): Promise<{ clips: ResolvedRenderClip[] }> }).stageRender(canvas);
      const graph = (xfadeEofPad: boolean) => buildRenderCommand(clips, canvas, join(dir, "g.mp4"), EXPORT_PROFILE, undefined, undefined, { xfadeEofPad }).args.join(" ");
      const padded = graph(true);
      const plain = graph(false);
      const ok = padded.includes("xfade=") && plain.includes("xfade=") && padded.includes("tpad=stop_mode=clone:stop=1") && !plain.includes("tpad=stop_mode=clone");
      if (!ok) failures++;
      console.log(`  ${ok ? "ok  " : "FAIL"} xfadeEofPad:true clones one frame before xfade (tpad=stop_mode=clone:stop=1); xfadeEofPad:false has no clone`);
    }
    const out = join(dir, `${type}.mp4`);
    await engine.exportVideo(out);
    // wipeup reveals the incoming clip from the bottom, wipedown from the top; a fade only after it ends.
    const row = type === "wipedown" ? 0.05 : 0.95;
    const idx = await frameIndexes(out, row);
    const mid = await frameIndexes(out, 0.5);
    let bad = 0;
    const from = type === "fade" ? yStart + frames : yStart + Math.ceil(frames * 0.15);
    for (let n = from; n < yStart + 90; n++) if ((n >= yStart + frames ? mid[n] : idx[n]) !== 200 + (n - yStart)) bad++;
    const ok = bad === 0 && idx.length === engine.timelineDurationFrames();
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${type} (${frames} frames): incoming frames ${from}..${yStart + 89} show source 200 + (n − ${yStart}); ${idx.length} frames = timeline${ok ? "" : ` — ${bad} off`}`);
  }
  if (failures) throw new Error(`${failures} transition timing check(s) failed`);
}

main().catch((err) => {
  console.error("TRANSITIONS SMOKE TEST FAILED:", err);
  process.exit(1);
});
