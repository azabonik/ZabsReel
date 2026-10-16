/**
 * Phase 8 smoke: native keyframe-animated TEXT bakes into the export (the thing
 * palmier-pro had and we lacked), alongside our coded motion graphics. Adds a
 * title overlay, animates its x (fly-in) + opacity (fade), and exports with real
 * FFmpeg — proving the drawtext x/alpha time-expressions run. A coexisting coded
 * Remotion graphic is attempted opportunistically (skipped if bundling is slow/
 * unavailable; it's already covered by smoke-motion).
 *
 * Remotion comes from AIVE_REMOTION_ADDON (graphics-addon-env.mjs: the repo
 * root when unset); without it and without an installed add-on, add_graphic
 * refuses with graphics_addon_missing (row 4).
 *
 * Run: npx tsx packages/core/scripts/smoke-animtext.ts [clipA]
 *   Without clipA it synthesizes a 4 s 1280x720 test clip with a tone.
 */
import { dispatch, methods, RpcError } from "../src/rpc.js";
import { useDevAddon, withoutDevAddon } from "./graphics-addon-env.mjs";
import { EditorEngine } from "../src/engine.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { runFfmpeg } from "../src/ffmpeg/executor.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

async function main() {
  useDevAddon();
  const dataDir = mkdtempSync(join(tmpdir(), "aive-animtext-"));
  let clipA = process.argv[2];
  if (!clipA) {
    clipA = join(dataDir, "src.mp4");
    await runFfmpeg([
      "-hide_banner", "-y",
      "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=4",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clipA,
    ]);
  }
  const engine = new EditorEngine(dataDir);
  const call = async <T = unknown>(name: keyof typeof methods, params: Record<string, unknown> = {}): Promise<T> => {
    const m = methods[name];
    const parsed = (m.schema as { parse: (x: unknown) => unknown }).parse(params);
    return (await m.handler(engine, parsed as never)) as T;
  };

  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  };

  const a = (await call<{ asset: { id: string } }>("import_video", { path: clipA })).asset;
  await call("set_project_settings", { width: 360, height: 640, fps: 30 });
  const base = await call<{ clip: { id: string } }>("append_clip", { assetId: a.id });

  console.log("1. add a title overlay, then animate it (fly-in + fade)...");
  const ov = await call<{ overlay: { id: string } }>("add_text", { clipId: base.clip.id, text: "ANIMATED TITLE", position: "center", fontSize: 56, box: false, outlineColor: "black", outlineWidth: 3 });
  await call("animate_text", { clipId: base.clip.id, overlayId: ov.overlay.id, property: "x", keyframes: [
    { frame: 0, value: -0.2 }, { frame: 15, value: 0.5, ease: "easeOut" },
  ] });
  await call("animate_text", { clipId: base.clip.id, overlayId: ov.overlay.id, property: "opacity", keyframes: [
    { frame: 0, value: 0 }, { frame: 12, value: 1, ease: "easeIn" },
  ] });

  // The overlay now carries two keyframe tracks.
  const proj = engine.getProject();
  const stored = proj.tracks.flatMap((t) => t.clips).find((c) => c.id === base.clip.id)?.overlays?.[0];
  check(!!stored?.keyframes?.x?.length, "x keyframe track stored on overlay");
  check(!!stored?.keyframes?.opacity?.length, "opacity keyframe track stored on overlay");
  check(stored?.keyframes?.x?.[1]?.ease === "easeOut", "ease preserved on keyframe");

  console.log("2. export (real ffmpeg — drawtext x/alpha exprs must run)...");
  const out = join(dataDir, "animtext.mp4");
  const exp = await call<{ path: string; duration: number }>("export_video", { outputPath: out });
  const probed = await probeAsset(exp.path);
  console.log(`   exported ${probed.width}x${probed.height} ${probed.duration.toFixed(2)}s`);
  check(probed.width === 360 && probed.height === 640, "animated-text export dimensions 360x640");
  check(probed.duration > 0, "export has content");

  // Opportunistic: a coded motion graphic coexisting on the timeline.
  try {
    console.log("3. coded motion graphic coexisting (optional, Remotion)...");
    const g = await call<{ graphicId?: string }>("add_graphic", { clipId: base.clip.id, template: "title", props: { title: "Coded", subtitle: "graphic" }, startFrame: 0, endFrame: 90 });
    check(!!g.graphicId, "coded graphic added alongside the animated title");
  } catch (e) {
    console.log(`   (skipped: ${(e as Error).message.split("\n")[0]})`);
  }

  // MUTATION: give resolveGraphicsAddon a fallback to ZabsReel's own node_modules (addon/resolve.ts) → this row fails.
  console.log("4. without AIVE_REMOTION_ADDON and an installed add-on, add_graphic refuses...");
  const bare = new EditorEngine(mkdtempSync(join(tmpdir(), "aive-animtext-bare-")));
  const refused = await withoutDevAddon(() => dispatch(bare, "add_graphic", { template: "title", durationSeconds: 1 }).then(() => "added", (e: unknown) => (e instanceof RpcError ? e.code : String(e))));
  check(refused === "graphics_addon_missing", `add_graphic refuses with graphics_addon_missing (${refused})`);

  console.log(failures === 0 ? "\nANIM-TEXT SMOKE TEST PASSED" : `\nANIM-TEXT SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("ANIM-TEXT SMOKE TEST FAILED:", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  process.exit(1);
});
