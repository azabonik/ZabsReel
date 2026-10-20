/**
 * Phase 4 smoke test: motion graphics (Remotion).
 *
 * Renders an AI-authored Remotion component (the built-in animated title card)
 * to an alpha video, composites it over a solid-color footage clip within a
 * time window [1s, 3s], exports, and then *verifies the graphic is really there
 * and really gated*: the white title text pushes peak luma high while the
 * graphic is visible, and the frame returns to the dark background colour before
 * and after the window. A no-op composite (or broken alpha) would fail this.
 * The baked graphic has no audio stream (renderGraphic renders muted;
 * ZedMix's renderer writes none for a graphic without sound).
 *
 * It runs on both graphics renderers (MOTION-PLAN D7): the Remotion add-on,
 * chosen as the user's setting (useRemotionRenderer), and ZedMix's own
 * renderer, the default. Remotion comes from AIVE_REMOTION_ADDON
 * (graphics-addon-env.mjs: the repo root when unset); without it and without
 * an installed add-on, add_graphic refuses with graphics_addon_missing on the
 * add-on, and renders on ZedMix's renderer, which needs no add-on.
 *
 * Run: npx tsx packages/core/scripts/smoke-motion.ts
 *
 * On first run Remotion downloads a headless Chrome (cached by Remotion), so the
 * first execution is slow; subsequent runs are fast.
 */
import { EditorEngine } from "../src/engine.js";
import { dispatch, RpcError } from "../src/rpc.js";
import { useDevAddon, useRemotionRenderer, withoutDevAddon } from "./graphics-addon-env.mjs";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { runFfmpeg, FFMPEG_BIN } from "../src/ffmpeg/executor.js";
import { GRAPHIC_TEMPLATES } from "../src/motion/templates.js";
import { execa } from "execa";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

/** Peak luma (0..255) of one frame at time `t` — bright graphic text spikes it. */
async function maxLuma(file: string, t: number): Promise<number> {
  const { stdout } = await execa(
    FFMPEG_BIN,
    ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "-"],
    { encoding: "buffer" },
  );
  const buf = stdout as Buffer;
  let max = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] > max) max = buf[i];
  return max;
}

type Renderer = "remotion" | "zedmix";

/** The user's renderer setting for a new data folder: the Remotion add-on, or ZedMix's renderer (no file: the default). */
const dataFor = (renderer: Renderer, prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return renderer === "remotion" ? useRemotionRenderer(dir) : dir;
};

async function main() {
  useDevAddon();
  for (const renderer of ["remotion", "zedmix"] as const) {
    console.log(`\n== ${renderer === "remotion" ? "the Remotion add-on" : "ZedMix's renderer"} ==`);
    await run(renderer);
  }
  console.log("\nMOTION GRAPHICS SMOKE TEST PASSED");
}

async function run(renderer: Renderer) {
  const dataDir = dataFor(renderer, "aive-motion-");
  const engine = new EditorEngine(dataDir);

  console.log("0. synthesize a 4s solid dark-green clip (1280x720) as footage...");
  const dur = 4;
  const src = join(dataDir, "bg.mp4");
  await runFfmpeg([
    "-hide_banner",
    "-f", "lavfi", "-i", `color=c=0x103018:s=1280x720:d=${dur}:r=30`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-t", String(dur), "-y", src,
  ]);

  const asset = await engine.importVideo(src);
  engine.setProjectSettings({ width: 1280, height: 720, fps: 30 });
  const clip = engine.appendClip(asset.id);
  console.log(`   footage: ${asset.width}x${asset.height} ${asset.duration.toFixed(2)}s`);

  console.log(`1. render the animated title card (${renderer}) over [1s, 3s]...`);
  if (renderer === "remotion") console.log("   (first run downloads a headless Chrome — this can take a minute)");
  const t0 = Date.now();
  const r = await engine.addGraphic(clip.id, {
    code: GRAPHIC_TEMPLATES.title,
    props: { title: "Phase 4", subtitle: "Motion graphics", accent: "#33ccff" },
    startFrame: Math.round(1.0 * engine.fps),
    endFrame: Math.round(3.0 * engine.fps),
  });
  console.log(`   baked alpha graphic: ${r.asset.name} ${r.asset.duration.toFixed(2)}s  in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!r.graphic) throw new Error("expected an overlay graphic to be created");
  // MUTATION: render the Remotion path whatever the setting (graphicsRenderer() always "remotion", engine.ts) → the
  // ZedMix run fails here (its baked file is Remotion's: no motion renderer started).
  const job = engine.jobs.list(false).find((j) => j.type === "graphic");
  if (!job) throw new Error("expected a graphic job");
  if (renderer === "zedmix" && !(r.asset.path.endsWith("-graphic.mov") && engine.graphicsRenderer() === "zedmix" && !r.graphic.audioClipId)) throw new Error("expected ZedMix's renderer to bake the overlay (no sound: no audio clip)");
  // MUTATION: drop muted: true from renderWith (motion/render.ts) → Remotion adds a silent track and this fails.
  console.log(`   baked graphic streams (ffprobe): video=${r.asset.hasVideo} audio=${r.asset.hasAudio}`);
  if (!r.asset.hasVideo || r.asset.hasAudio) throw new Error("the baked graphic must have a video stream and no audio stream (renderGraphic renders muted)");

  console.log("2. export the composited video...");
  const out = join(dataDir, "out.mp4");
  const result = await engine.exportVideo(out);
  const probed = await probeAsset(out);
  console.log(`   exported: ${probed.width}x${probed.height} ${probed.duration.toFixed(2)}s`);
  if (probed.width !== 1280 || probed.height !== 720) throw new Error(`expected 1280x720, got ${probed.width}x${probed.height}`);
  if (Math.abs(probed.duration - result.duration) > 0.5) throw new Error(`duration drift: ${probed.duration} vs ${result.duration}`);

  console.log("3. verify the graphic shows ONLY inside its [1s,3s] window...");
  const before = await maxLuma(out, 0.3);
  const during = await maxLuma(out, 2.0);
  const after = await maxLuma(out, 3.6);
  console.log(`   peak luma — before(0.3s)=${before}  during(2.0s)=${during}  after(3.6s)=${after}  (bg≈${before})`);
  if (during < 200) throw new Error(`title text not visible during the window (peak luma ${during}, expected >200)`);
  if (before > 130) throw new Error(`graphic leaked BEFORE its start (peak luma ${before}, expected background <130)`);
  if (after > 130) throw new Error(`graphic leaked AFTER its end (peak luma ${after}, expected background <130)`);
  if (during - before < 80) throw new Error(`no clear brightness jump from the graphic (${before} -> ${during})`);

  console.log("4. clear the graphic — export should return to plain background...");
  engine.clearGraphics(clip.id);
  const plain = join(dataDir, "plain.mp4");
  await engine.exportVideo(plain);
  const plainDuring = await maxLuma(plain, 2.0);
  console.log(`   peak luma during(2.0s) after clear = ${plainDuring} (expect background <130)`);
  if (plainDuring > 130) throw new Error(`graphic still present after clear_graphics (peak luma ${plainDuring})`);

  // MUTATION: give resolveGraphicsAddon a fallback to ZedMix's own node_modules (addon/resolve.ts) → the Remotion
  // run's step renders and fails. Make ZedMix's path ask for the add-on (addGraphic, engine.ts) → the ZedMix run fails.
  console.log(`5. without AIVE_REMOTION_ADDON and an installed add-on, add_graphic ${renderer === "remotion" ? "refuses" : "renders (no add-on needed)"}...`);
  const bare = new EditorEngine(dataFor(renderer, "aive-motion-bare-"));
  const refused = await withoutDevAddon(() => dispatch(bare, "add_graphic", { template: "title", durationSeconds: 1 }).then(() => "added", (e: unknown) => (e instanceof RpcError ? e.code : String(e))));
  console.log(`   ${refused}`);
  const want = renderer === "remotion" ? "graphics_addon_missing" : "added";
  if (refused !== want) throw new Error(`expected ${want}, got ${refused}`);
}

main().catch((err) => {
  console.error("MOTION GRAPHICS SMOKE TEST FAILED:", err);
  process.exit(1);
});
