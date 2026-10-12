/**
 * Smoke test: AI background removal for PEOPLE (Robust Video Matting, GPL-3.0).
 * Turns a portrait still into a ~3 s clip (slow zoom, so frames differ, plus a
 * tone so there is audio), puts it on V2 over a solid RED V1 clip, runs
 * removeBackground, and verifies:
 *   - the job completes; the baked asset is FFV1 with an alpha pix_fmt and the
 *     clip now points at it,
 *   - in the EXPORT a pixel inside the face is NOT red (and keeps its colour)
 *     while background pixels ARE red — the background was removed and V1
 *     shows through,
 *   - the .webm preview proxy exists with an alpha VP8 stream and audio,
 *   - undo restores the original asset,
 *   - the downscaled path (forced with a small processing cap) gives a
 *     full-resolution cutout that passes the same pixel checks,
 *   - cancel_job stops a run and leaves no partial files behind,
 *   - the remove_background RPC works in background mode and refuses a re-run.
 *
 * Run: npx tsx packages/core/scripts/smoke-matte.ts [portrait.jpg | clip.mp4]
 *   Pass any photo/video with a clearly visible person; if omitted, a portrait
 *   is downloaded. The RVM model (15 MB) downloads to ~/.aive/models on first
 *   run; set AIVE_RVM_MODEL to a local copy to run offline.
 */
import { execa } from "execa";
import { join, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, existsSync, readdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { EditorEngine } from "../src/engine.js";
import { dispatch } from "../src/rpc.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { runFfmpeg, FFMPEG_BIN, FFPROBE_BIN } from "../src/ffmpeg/executor.js";

const W = 1280;
const H = 720;
const FPS = 30;
const DUR = 3;
/** The portrait occupies the middle 720×720 of the canvas; the side bars are padding. */
const FACE = { x: 640, y: 250 }; // forehead/upper face of a centred portrait
const BG_POINTS: { name: string; x: number; y: number }[] = [
  { name: "top-left corner", x: 24, y: 24 },
  { name: "top-right corner", x: W - 24, y: 24 },
  { name: "photo's own background (top-left of the portrait)", x: 280 + 40, y: 40 },
];

type RGB = [number, number, number];

/** Average colour of a size×size box centred on (x, y) of a rendered file at `t` seconds. */
async function sample(file: string, t: number, x: number, y: number, size = 16): Promise<RGB> {
  const { stdout } = await execa(
    FFMPEG_BIN,
    [
      "-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1",
      "-vf", `crop=${size}:${size}:${x - size / 2}:${y - size / 2},scale=1:1:flags=area,format=rgb24`,
      "-f", "rawvideo", "-",
    ],
    { reject: true, encoding: "buffer" },
  );
  const b = stdout as unknown as Buffer;
  return [b[0], b[1], b[2]];
}

const isRed = ([r, g, b]: RGB) => r > 140 && g < 110 && b < 110;
const diff = (a: RGB, b: RGB) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

async function streams(file: string): Promise<{ codec_type: string; codec_name: string; pix_fmt?: string; tags?: Record<string, string> }[]> {
  const { stdout } = await execa(FFPROBE_BIN, [
    "-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt:stream_tags", "-of", "json", file,
  ]);
  return JSON.parse(stdout).streams ?? [];
}

function check(ok: boolean, label: string): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) throw new Error(`check failed: ${label}`);
}

/** Export the timeline and assert the person stayed while the background became the red V1. */
async function verifyExport(engine: EditorEngine, dir: string, name: string, faceRef: RGB): Promise<void> {
  const out = join(dir, `${name}.mp4`);
  await engine.exportVideo(out);
  const t = DUR / 2;
  const face = await sample(out, t, FACE.x, FACE.y);
  console.log(`   face rgb(${face.join(",")}) vs source rgb(${faceRef.join(",")})`);
  check(!isRed(face), "a pixel inside the face is NOT red (the person was kept)");
  check(diff(face, faceRef) < 60, "the face keeps its original colour (opaque, no tint or fringe)");
  for (const p of BG_POINTS) {
    const px = await sample(out, t, p.x, p.y);
    console.log(`   ${p.name}: rgb(${px.join(",")})`);
    check(isRed(px), `${p.name} IS red (background removed, V1 shows through)`);
  }
}

async function resolvePortrait(dir: string): Promise<string> {
  const arg = process.argv[2];
  if (arg) {
    const p = isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
    if (!existsSync(p)) throw new Error(`input not found: ${p}`);
    return p;
  }
  // Sources can be flaky, so try each in turn and VALIDATE the payload is
  // really a JPEG (magic bytes) — thispersondoesnotexist.com's root URL now
  // serves an HTML page that embeds /random-person.jpeg.
  const face = join(dir, "portrait.jpg");
  console.log("0a. downloading a sample portrait...");
  const sources = [
    "https://thispersondoesnotexist.com/random-person.jpeg",
    "https://thispersondoesnotexist.com/",
    // OpenCV's standard sample portrait (contains a clear frontal face).
    "https://raw.githubusercontent.com/opencv/opencv/4.x/samples/data/lena.jpg",
  ];
  for (const url of sources) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024 || buf[0] !== 0xff || buf[1] !== 0xd8) continue; // not a JPEG
      await writeFile(face, buf);
      return face;
    } catch {
      /* try next source */
    }
  }
  throw new Error("could not download a portrait from any source — pass one: smoke-matte.ts <portrait.jpg>");
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "aive-matte-"));
  const input = await resolvePortrait(dir);
  const inMeta = await probeAsset(input);

  console.log("0b. synthesize a 3 s person clip (slow zoom + tone) and a solid red background...");
  const person = join(dir, "person.mp4");
  const fit = `scale=${H}:${H}:force_original_aspect_ratio=decrease,pad=${H}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x3a4a3a`;
  // A JPEG often probes as a 0.04 s "video" rather than isImage — detect stills by codec too.
  const still = inMeta.isImage || (["mjpeg", "png", "webp", "bmp"].includes(inMeta.videoCodec ?? "") && inMeta.duration < 1);
  const vf = still
    ? `${fit},zoompan=z='1+0.0012*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${DUR * FPS}:s=${H}x${H}:fps=${FPS},` +
      `pad=${W}:${H}:(ow-iw)/2:0:color=0x3a4a3a,format=yuv420p`
    : `fps=${FPS},${fit},pad=${W}:${H}:(ow-iw)/2:0:color=0x3a4a3a,format=yuv420p`;
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-i", input,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${DUR}`,
    "-map", "0:v:0", "-map", "1:a:0", "-vf", vf, "-t", String(DUR),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-c:a", "aac", "-y", person,
  ]);
  const red = join(dir, "red.mp4");
  await runFfmpeg(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=red:s=${W}x${H}:r=${FPS}:d=${DUR}`, "-pix_fmt", "yuv420p", "-y", red]);

  const engine = new EditorEngine(dir);
  engine.setProjectSettings({ width: W, height: H, fps: FPS, name: "matte-smoke" });
  const aRed = await engine.importVideo(red);
  const aPerson = await engine.importVideo(person);
  engine.addClip(aRed.id, { startFrame: 0 });
  const v2 = engine.addTrack("video", { name: "V2" });
  const clip = engine.addClip(aPerson.id, { trackIndex: v2.index, startFrame: 0 });
  const spanFrames = clip.sourceOutFrame - clip.sourceInFrame;
  const faceRef = await sample(person, DUR / 2, FACE.x, FACE.y);

  console.log("1. remove the background (native-resolution path)...");
  const r = await engine.removeBackground(clip.id);
  console.log(
    `   ${r.frames} frames at ${r.procWidth}x${r.procHeight} in ${r.seconds.toFixed(1)}s ` +
      `(${(r.frames / r.seconds).toFixed(1)} fps, ${(r.seconds / DUR).toFixed(1)}× realtime); ` +
      `FFV1 ${(statSync(r.asset.path).size / 1e6).toFixed(1)} MB`,
  );
  const job = engine.jobs.list().find((j) => j.type === "matte");
  check(job?.status === "done", `matte job completed (status ${job?.status})`);
  const baked = await streams(r.asset.path);
  const bv = baked.find((s) => s.codec_type === "video");
  check(bv?.codec_name === "ffv1" && !!bv.pix_fmt?.startsWith("yuva"), `baked cutout is FFV1 with alpha (${bv?.codec_name} ${bv?.pix_fmt})`);
  check(baked.some((s) => s.codec_type === "audio"), "baked cutout keeps the source audio");
  check(!r.downscaled && r.width === W && r.height === H, "processed at native resolution");
  const after = engine.getProject().tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)!;
  check(after.assetId === r.asset.id, "the clip now points at the cutout");
  check(after.sourceOutFrame - after.sourceInFrame === spanFrames, `clip length unchanged (${spanFrames} frames)`);

  console.log("2. export: face kept, background replaced by the red V1 track...");
  await verifyExport(engine, dir, "native", faceRef);

  console.log("3. the preview proxy is a VP8/alpha .webm with audio...");
  const proxy = r.asset.proxyPath;
  check(!!proxy && proxy.endsWith(".webm") && existsSync(proxy), `proxyPath recorded and present (${proxy})`);
  const ps = await streams(proxy!);
  const pv = ps.find((s) => s.codec_type === "video");
  const alpha = !!pv?.pix_fmt?.startsWith("yuva") || pv?.tags?.alpha_mode === "1" || pv?.tags?.ALPHA_MODE === "1";
  check(pv?.codec_name === "vp8" && alpha, `proxy video is VP8 with alpha (${pv?.codec_name} ${pv?.pix_fmt} alpha_mode=${pv?.tags?.alpha_mode ?? pv?.tags?.ALPHA_MODE})`);
  check(ps.some((s) => s.codec_type === "audio" && s.codec_name === "opus"), "proxy carries the audio (opus)");

  console.log("4. undo restores the original footage...");
  engine.undo();
  const undone = engine.getProject().tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)!;
  check(undone.assetId === aPerson.id, "clip points at the original asset again");

  console.log("5. downscaled path (processing capped at 640px, alpha upscaled onto full-res colour)...");
  const r2 = await engine.removeBackground(clip.id, { maxLongEdge: 640 });
  console.log(`   ${r2.frames} frames at ${r2.procWidth}x${r2.procHeight} → ${r2.width}x${r2.height} in ${r2.seconds.toFixed(1)}s (${(r2.frames / r2.seconds).toFixed(1)} fps)`);
  check(r2.downscaled && r2.procWidth === 640 && r2.width === W && r2.height === H, "downscaled processing, full-resolution output");
  const b2 = (await streams(r2.asset.path)).find((s) => s.codec_type === "video");
  check(b2?.codec_name === "ffv1" && !!b2.pix_fmt?.startsWith("yuva"), `downscaled cutout is FFV1 with alpha (${b2?.pix_fmt})`);
  await verifyExport(engine, dir, "downscaled", faceRef);
  engine.undo();

  console.log("6. cancel_job stops a run and cleans up...");
  const bakedDir = join(dir, "baked");
  const cutouts = () => readdirSync(bakedDir).filter((f) => f.includes("-cutout-")).sort();
  const filesBefore = cutouts();
  const { job: j3, promise } = engine.startRemoveBackgroundJob(clip.id);
  await new Promise((res) => setTimeout(res, 1500));
  engine.jobs.cancel(j3.id);
  const outcome = await promise.then(() => "resolved", (err: Error) => err.message);
  check(outcome !== "resolved", `canceled run rejects (${outcome})`);
  check(engine.jobs.get(j3.id)?.status === "canceled", "job status is canceled");
  check(JSON.stringify(cutouts()) === JSON.stringify(filesBefore), "no partial cutout files left behind");
  const untouched = engine.getProject().tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)!;
  check(untouched.assetId === aPerson.id, "clip untouched by the canceled run");

  console.log("7. the remove_background RPC (background:true → jobId, then the blocking form refuses a re-run)...");
  const started = (await dispatch(engine, "remove_background", { clipId: clip.id, background: true })) as { jobId: string };
  check(typeof started.jobId === "string", `background:true returns a jobId (${started.jobId})`);
  await engine.jobs.wait(started.jobId);
  const viaRpc = engine.jobs.get(started.jobId);
  check(viaRpc?.status === "done" && (viaRpc.result as { clipId?: string })?.clipId === clip.id, "the background job finished and reports the clip");
  const again = await dispatch(engine, "remove_background", { clipId: clip.id }).then(() => "resolved", (err: Error) => err.message);
  check(/already has its background removed/.test(again), "re-running on a cutout is refused with a teaching error");

  console.log("\nMATTE SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("MATTE SMOKE TEST FAILED:", err);
  process.exit(1);
});
