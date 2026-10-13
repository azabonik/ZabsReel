/**
 * Phase 2 smoke test: LUT, crop/reframe, and stabilization (vidstab).
 * Generates an identity .cube LUT, applies it + a crop, stabilizes a clip,
 * and exports — verifying each FFmpeg path actually runs and produces output.
 * Then stabilize_clip's options: the option → vidstab filter mapping, a
 * synthesized SHAKY clip stabilized with non-default options (zoom "auto" must
 * differ from "none"), and re-stabilizing an already stabilized clip.
 *
 * Run: npx tsx packages/core/scripts/smoke-lut-stab.ts <clipA> <clipB>
 */
import { execa } from "execa";
import { EditorEngine } from "../src/engine.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { dispatch } from "../src/rpc.js";
import { FFMPEG_BIN } from "../src/ffmpeg/executor.js";
import { stabilizeFilters } from "../src/ffmpeg/stabilize.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";

const IDENTITY_CUBE = `TITLE "Identity"
LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

async function main() {
  const [, , clipA, clipB] = process.argv;
  if (!clipA || !clipB) throw new Error("usage: smoke-lut-stab.ts <clipA> <clipB>");

  const dataDir = mkdtempSync(join(tmpdir(), "aive-lut-"));
  const engine = new EditorEngine(dataDir);

  // Write an identity LUT (a path with a Windows drive-letter colon to exercise escaping).
  const lutPath = join(dataDir, "identity.cube");
  writeFileSync(lutPath, IDENTITY_CUBE);

  const a = await engine.importVideo(clipA); // 1280x720, 5s
  const b = await engine.importVideo(clipB); // 640x480, 4s
  const c1 = engine.appendClip(a.id);
  const c2 = engine.appendClip(b.id);

  console.log("1. apply LUT + crop to clip 1...");
  engine.setClipEffects(c1.id, { lut: lutPath });
  engine.setClipEffects(c1.id, { crop: { x: 100, y: 50, width: 900, height: 600 } });

  console.log("2. set project to vertical 9:16 (reframe target)...");
  engine.setProjectSettings({ width: 1080, height: 1920 });

  console.log("3. stabilize clip 2 (two-pass vidstab)...");
  const stabilized = await engine.stabilizeClip(c2.id);
  const bakedAsset = engine.getAsset(stabilized.assetId);
  console.log(`   clip 2 now references baked asset: ${bakedAsset.name} (${bakedAsset.duration.toFixed(2)}s)`);
  if (!bakedAsset.name.includes("stabilized")) throw new Error("stabilize did not rewire the clip");

  console.log("4. export...");
  const out = join(dataDir, "lutstab.mp4");
  const result = await engine.exportVideo(out);
  const probed = await probeAsset(out);
  console.log(`   exported: ${probed.width}x${probed.height} ${probed.duration.toFixed(2)}s (expect 1080x1920)`);
  if (probed.width !== 1080 || probed.height !== 1920) throw new Error(`wrong output dimensions: ${probed.width}x${probed.height}`);
  if (probed.duration < result.duration - 0.8) throw new Error("export shorter than expected");

  console.log("5. stabilize options → vidstab filters...");
  const def = stabilizeFilters();
  if (def.detect !== "vidstabdetect=shakiness=6:accuracy=15") throw new Error(`default detect: ${def.detect}`);
  // The no-option default must equal the old fixed `smoothing=30:zoom=0` (optzoom 1 = auto, crop keep),
  // with the Gaussian camera path spelled out (newer libvidstab made "opt" an L1 path that ignores zoom none).
  if (def.transform !== "smoothing=30:optzoom=1:crop=keep:optalgo=gauss") throw new Error(`default transform: ${def.transform}`);
  const noZoom = stabilizeFilters({ zoom: "none" });
  if (noZoom.transform !== "smoothing=30:optzoom=0:zoom=0:crop=keep:optalgo=gauss") throw new Error(`zoom none transform: ${noZoom.transform}`);
  const opt = stabilizeFilters({ shakiness: 8, accuracy: 2, smoothing: 12, zoom: "auto", crop: "black" });
  if (opt.detect !== "vidstabdetect=shakiness=8:accuracy=4") throw new Error(`options detect: ${opt.detect}`);
  if (opt.transform !== "smoothing=12:optzoom=1:crop=black:optalgo=gauss") throw new Error(`options transform: ${opt.transform}`);
  const fixed = stabilizeFilters({ zoom: 7.5 });
  if (!fixed.transform.includes("optzoom=0:zoom=7.5")) throw new Error(`fixed zoom: ${fixed.transform}`);
  console.log(`   defaults ${def.detect} | ${def.transform}; options ${opt.detect} | ${opt.transform}`);

  console.log("6. stabilize a synthesized SHAKY clip with non-default options...");
  // A 640×480 window jittering around inside an 800×600 test pattern.
  const shaky = join(dataDir, "shaky.mp4");
  await execa(FFMPEG_BIN, [
    "-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=s=800x600:r=30:d=3",
    "-vf", "crop=640:480:'80+60*sin(n*1.3)':'60+45*cos(n*1.9)'", "-pix_fmt", "yuv420p", shaky,
  ]);
  const stabWith = async (name: string, opts: Record<string, unknown>) => {
    const e = new EditorEngine(join(dataDir, name));
    e.setProjectSettings({ width: 640, height: 480, fps: 30, name });
    const asset = await e.importVideo(shaky);
    const clip = e.appendClip(asset.id);
    const r = (await dispatch(e, "stabilize_clip", { clipId: clip.id, ...opts })) as { clip: { assetId: string } };
    return { e, clipId: clip.id, assetId: r.clip.assetId, path: e.getAsset(r.clip.assetId).path };
  };
  const auto = await stabWith("stab-auto", { shakiness: 8, accuracy: 9, smoothing: 10, zoom: "auto", crop: "black" });
  const none = await stabWith("stab-none", { smoothing: 10, zoom: "none" });
  // Mean absolute difference of the two bakes' mid frames (0..255).
  const { stdout } = await execa(FFMPEG_BIN, [
    "-hide_banner", "-ss", "1.5", "-i", auto.path, "-ss", "1.5", "-i", none.path,
    "-filter_complex", "[0:v][1:v]blend=all_mode=difference,format=gray,scale=1:1:flags=area", "-frames:v", "1",
    "-f", "rawvideo", "-",
  ], { encoding: "buffer" });
  const diff = (stdout as unknown as Buffer)[0];
  console.log(`   zoom auto vs none: mean abs diff ${diff}`);
  if (!(diff > 3)) throw new Error(`zoom "auto" and "none" bakes look the same (diff ${diff}) — options not reaching vidstab?`);

  console.log("7. re-stabilize the already stabilized clip (fixed zoom)...");
  const again = (await dispatch(auto.e, "stabilize_clip", { clipId: auto.clipId, zoom: 5 })) as { clip: { assetId: string } };
  const againPath = auto.e.getAsset(again.clip.assetId).path;
  if (againPath === auto.path) throw new Error("re-stabilize overwrote the previous bake");
  const againProbe = await probeAsset(againPath);
  if (!(againProbe.duration > 2)) throw new Error(`re-stabilized bake too short: ${againProbe.duration}`);
  auto.e.undo();
  const restored = auto.e.getProject().tracks[0].clips[0].assetId;
  if (restored !== auto.assetId) throw new Error(`undo did not restore the first stabilized bake (clip → ${restored})`);
  if (!((await probeAsset(auto.path)).duration > 2)) throw new Error("the first bake was damaged by the re-stabilize");
  console.log("   new bake written alongside; undo restores the first bake, still intact");

  console.log("\nLUT + STAB + REFRAME SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("LUT/STAB SMOKE TEST FAILED:", err);
  process.exit(1);
});
