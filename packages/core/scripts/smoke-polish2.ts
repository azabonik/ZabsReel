/**
 * Regression checks for the "polish2" fixes. Synthesizes all media (PNG stills):
 *
 *   1. set_clip_transform / color_grade / set_clip_fade / apply_color / text and
 *      caption style: PARTIAL updates keep earlier fields (undefined used to
 *      overwrite stored values through the object spread); null resets one
 *      transform field; reset:true clears transform + opacity.
 *   2. A colour-graded 4:3 clip on V2 over a red V1 keeps red pillar bars in the
 *      export (eq used to drop alpha); the alphaSafe-wrapped eq is byte-identical
 *      (framemd5) to plain eq on opaque content.
 *   3. gc prunes orphan mask PNGs but keeps referenced ones (live project and undo
 *      history), young files and non-mask files.
 *   4. guide.ts has no hard-coded tool count; TOOLS_LIST.txt matches the rpc methods.
 *
 * Run: npx tsx packages/core/scripts/smoke-polish2.ts
 */
import { execa } from "execa";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { EditorEngine } from "../src/engine.js";
import { dispatch, methods } from "../src/rpc.js";
import { FFMPEG_BIN } from "../src/ffmpeg/executor.js";
import { alphaSafe } from "../src/effects/registry.js";
import { pruneDataDir } from "../src/gc.js";
import { referencedMaskNames } from "../src/blendmask.js";

const FPS = 30;
const W = 640;
const H = 360;
let failures = 0;
function check(cond: boolean, name: string, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function ff(args: string[]): Promise<Buffer> {
  const { stdout } = await execa(FFMPEG_BIN, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args], {
    reject: true,
    encoding: "buffer",
  });
  return stdout as unknown as Buffer;
}
const solid = (out: string, w: number, h: number, color: string) =>
  ff(["-f", "lavfi", "-i", `color=c=${color}:s=${w}x${h}`, "-frames:v", "1", out]);

async function pixel(file: string, t: number, x: number, y: number): Promise<[number, number, number]> {
  const b = await ff(["-ss", String(t), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const i = (y * W + x) * 3;
  return [b[i], b[i + 1], b[i + 2]];
}
async function framemd5(args: string[]): Promise<string> {
  const out = await ff([...args, "-f", "framemd5", "-"]);
  return Buffer.from(out).toString("utf8").split("\n").filter((l) => l && !l.startsWith("#")).join("\n");
}
const clipOf = (e: EditorEngine, id: string) => e.getProject().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;

async function partialUpdates(dir: string) {
  console.log("1. partial set_* updates keep earlier fields...");
  await solid(join(dir, "a.png"), 320, 240, "gray");
  const engine = new EditorEngine(join(dir, "d1"));
  engine.setProjectSettings({ width: W, height: H, fps: FPS });
  const asset = await engine.importVideo(join(dir, "a.png"));
  const clip = engine.addClip(asset.id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: 30 });
  const set = (p: Record<string, unknown>) => dispatch(engine, "set_clip_transform", { clipId: clip.id, ...p });

  await set({ scale: 0.5 });
  await set({ x: 0.25 });
  await set({ rotation: 15 });
  await set({ flipH: true });
  await set({ opacity: 0.7 });
  await set({ y: -0.1 });
  let fx = clipOf(engine, clip.id).effects!;
  const t = fx.transform!;
  check(t.scale === 0.5 && t.x === 0.25 && t.rotation === 15 && t.flipH === true && t.y === -0.1, "scale, x, rotation, flipH, y all kept", JSON.stringify(t));
  check(fx.opacity === 0.7, "opacity kept across transform edits", String(fx.opacity));
  check(!Object.values(t).some((v) => v === undefined) && !("flipV" in t), "no undefined keys stored", JSON.stringify(t));
  engine.setClipTransform(clip.id, { transform: { x: undefined, scale: undefined } });
  check(clipOf(engine, clip.id).effects!.transform!.x === 0.25, "engine ignores undefined keys");

  await set({ x: null });
  const t2 = clipOf(engine, clip.id).effects!.transform!;
  check(!("x" in t2) && t2.scale === 0.5 && t2.rotation === 15, "null resets only that field", JSON.stringify(t2));
  await set({ reset: true });
  fx = clipOf(engine, clip.id).effects ?? {};
  check(fx.transform === undefined && fx.opacity === undefined, "reset:true clears transform and opacity");

  await dispatch(engine, "color_grade", { clipId: clip.id, brightness: 0.1 });
  await dispatch(engine, "color_grade", { clipId: clip.id, contrast: 1.4 });
  await dispatch(engine, "color_grade", { clipId: clip.id, saturation: 0.8 });
  const c = clipOf(engine, clip.id).effects!.color!;
  check(c.brightness === 0.1 && c.contrast === 1.4 && c.saturation === 0.8, "color_grade partial updates accumulate", JSON.stringify(c));

  await dispatch(engine, "set_clip_fade", { clipId: clip.id, fadeInFrames: 6 });
  await dispatch(engine, "set_clip_fade", { clipId: clip.id, fadeOutFrames: 9 });
  const e = clipOf(engine, clip.id).effects!;
  check(e.fadeInFrames === 6 && e.fadeOutFrames === 9, "set_clip_fade partial updates accumulate", `${e.fadeInFrames}/${e.fadeOutFrames}`);

  await dispatch(engine, "apply_color", { clipId: clip.id, lift: { r: 0.1 }, hue: 20 });
  await dispatch(engine, "apply_color", { clipId: clip.id, lift: { b: 0.2 } });
  await dispatch(engine, "apply_color", { clipId: clip.id, temperature: 0.3 });
  const g = clipOf(engine, clip.id).effects!.grade!;
  check(g.lift?.r === 0.1 && g.lift?.b === 0.2 && g.hue === 20 && g.temperature === 0.3, "apply_color partial + wheel channels accumulate", JSON.stringify(g));
  engine.setClipGrade(clip.id, { hue: undefined, lift: { r: undefined, g: 0.05 } });
  const g2 = clipOf(engine, clip.id).effects!.grade!;
  check(g2.hue === 20 && g2.lift?.r === 0.1 && g2.lift?.g === 0.05, "engine.setClipGrade ignores undefined", JSON.stringify(g2));

  await dispatch(engine, "add_text", { clipId: clip.id, text: "hi" });
  const ov = clipOf(engine, clip.id).overlays![0];
  await dispatch(engine, "set_text_style", { clipId: clip.id, color: "#ff0000" });
  engine.setTextStyle(clip.id, undefined, { color: undefined, fontSize: 50 });
  const ov2 = clipOf(engine, clip.id).overlays![0];
  check(ov2.id === ov.id && ov2.color === ov.color && ov2.fontSize === 50, "setTextStyle ignores undefined", `${ov2.color}/${ov2.fontSize}`);
}

async function alphaGrade(dir: string) {
  console.log("2. colour grade keeps transparent letterbox bars...");
  await solid(join(dir, "red.png"), W, H, "red");
  await solid(join(dir, "blue43.png"), 480, 360, "0x3060c0");
  const engine = new EditorEngine(join(dir, "d2"));
  engine.setProjectSettings({ width: W, height: H, fps: FPS });
  const red = await engine.importVideo(join(dir, "red.png"));
  const blue = await engine.importVideo(join(dir, "blue43.png"));
  engine.addClip(red.id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: 15 });
  const v2 = engine.addTrack("video");
  const up = engine.addClip(blue.id, { trackIndex: v2.index, startFrame: 0, sourceInFrame: 0, sourceOutFrame: 15 });
  const out0 = join(dir, "nograde.mp4");
  await engine.exportVideo(out0, { quality: 0 });
  await dispatch(engine, "color_grade", { clipId: up.id, brightness: 0.05, contrast: 1.2, saturation: 1.3 });
  const out1 = join(dir, "graded.mp4");
  await engine.exportVideo(out1, { quality: 0 });
  const bar0 = await pixel(out0, 0.2, 20, 180);
  const bar1 = await pixel(out1, 0.2, 20, 180);
  const mid0 = await pixel(out0, 0.2, 320, 180);
  const mid1 = await pixel(out1, 0.2, 320, 180);
  console.log(`     bar ungraded=${bar0} graded=${bar1}; centre ungraded=${mid0} graded=${mid1}`);
  check(bar0[0] > 240 && bar0[1] < 15 && bar0[2] < 15, "ungraded: pillar bar shows red V1");
  check(bar1[0] > 240 && bar1[1] < 15 && bar1[2] < 15, "graded: pillar bar still shows red V1 (alpha kept)");
  check(mid0.some((v, i) => Math.abs(v - mid1[i]) > 3), "grade actually changed the picture");

  // alphaSafe(eq) must equal plain eq on opaque RGBA (non-letterboxed) content.
  const src = ["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=1"];
  const eq = "eq=brightness=0.1:contrast=1.2:saturation=1.3:gamma=1.1";
  const plain = await framemd5([...src, "-vf", `format=rgba,${eq},format=rgba`, "-pix_fmt", "rgba"]);
  const safe = await framemd5([...src, "-vf", `format=rgba,${alphaSafe([eq], "t")[0]}`, "-pix_fmt", "rgba"]);
  check(plain.length > 0 && plain === safe, "alphaSafe(eq) framemd5 == plain eq on opaque content");

  // Probe record: which colour filters keep alpha (FFmpeg 4.4 on a 50% alpha red).
  const probe: Record<string, string> = {};
  for (const f of ["colorbalance=rs=0.2:rm=0.1", "hue=h=30", "curves=all='0/0 0.5/0.6 1/1'", "colortemperature=temperature=4000"]) {
    const b = await ff(["-f", "lavfi", "-i", `color=red:s=8x8,format=rgba,colorchannelmixer=aa=0.5,${f},format=rgba`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
    probe[f] = String(b[3]);
    check(Math.abs(b[3] - 128) <= 1, `alpha preserved by ${f.split("=")[0]}`, `a=${b[3]}`);
  }
}

async function maskGc(dir: string) {
  console.log("3. gc prunes orphan mask PNGs...");
  await solid(join(dir, "m.png"), 320, 240, "gray");
  const dd = join(dir, "d3");
  const engine = new EditorEngine(dd);
  engine.setProjectSettings({ width: W, height: H, fps: FPS });
  const asset = await engine.importVideo(join(dir, "m.png"));
  const clip = engine.addClip(asset.id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: 30 });
  await dispatch(engine, "set_clip_mask", { clipId: clip.id, shape: "ellipse", feather: 0.1 });
  await engine.exportVideo(join(dir, "m1.mp4"), { quality: 30 });
  const masksDir = join(dd, "masks");
  const live = readdirSync(masksDir).filter((n) => /^mask-.*\.png$/.test(n));
  check(live.length >= 1, "export staged a mask PNG", live.join(","));
  const keep = referencedMaskNames([engine.getProject()]);
  check(live.every((n) => keep.has(n)), "referencedMaskNames covers the staged masks");

  const old = new Date(Date.now() - 3 * 3600_000);
  const mk = (name: string, ageOld: boolean) => {
    const p = join(masksDir, name);
    writeFileSync(p, "x");
    if (ageOld) utimesSync(p, old, old);
  };
  mk("mask-aaaaaaaaaaaaaaaaaaaaaaaa.png", true); // orphan, old -> pruned
  mk("mask-bbbbbbbbbbbbbbbbbbbbbbbb.png", false); // orphan, fresh -> kept (grace)
  mk("notes.txt", true); // not a mask -> kept
  for (const n of live) utimesSync(join(masksDir, n), old, old);

  const rNo = await pruneDataDir(dd);
  check(readdirSync(masksDir).includes("mask-aaaaaaaaaaaaaaaaaaaaaaaa.png"), "no keepMasks -> masks/ untouched", `freed ${rNo.freedBytes}`);
  await pruneDataDir(dd, { keepMasks: keep });
  const after = readdirSync(masksDir);
  check(!after.includes("mask-aaaaaaaaaaaaaaaaaaaaaaaa.png"), "old orphan mask pruned");
  check(after.includes("mask-bbbbbbbbbbbbbbbbbbbbbbbb.png"), "fresh orphan kept (grace)");
  check(after.includes("notes.txt"), "non-mask file kept");
  check(live.every((n) => after.includes(n)), "referenced masks kept");

  // Remove the mask: the project no longer references it, but undo history does.
  await dispatch(engine, "set_clip_mask", { clipId: clip.id, shape: null });
  await (engine as unknown as { pruneData(): Promise<void> }).pruneData();
  check(live.every((n) => readdirSync(masksDir).includes(n)), "mask kept while undo history references it");
  while (engine.undo()) { /* walk back */ }
  while (engine.redo()) { /* walk forward */ }
  // Wipe history by loading a fresh project state: simulate with a new engine on the same dir.
  const fresh = new EditorEngine(dd);
  await (fresh as unknown as { pruneData(): Promise<void> }).pruneData();
  check(live.every((n) => !readdirSync(masksDir).includes(n)), "unreferenced old masks pruned by a fresh engine");
}

function docs() {
  console.log("4. guide + tool list...");
  const guide = readFileSync(new URL("../../mcp/src/guide.ts", import.meta.url), "utf8");
  check(!/~?\b94\b\s*tools/.test(guide) && !/~\d+ tools/.test(guide), "guide.ts has no hard-coded tool count");
  const list = readFileSync(new URL("../../skill-installer/TOOLS_LIST.txt", import.meta.url), "utf8");
  const listed = new Set([...list.matchAll(/^\d+\. ([a-z_0-9]+) /gm)].map((m) => m[1]));
  const actual = Object.keys(methods);
  const missing = actual.filter((n) => !listed.has(n));
  const stale = [...listed].filter((n) => !actual.includes(n));
  check(missing.length === 0 && stale.length === 0, "TOOLS_LIST.txt matches rpc methods", `missing=${missing} stale=${stale}`);
  check(list.includes(`(${actual.length} tools)`), "TOOLS_LIST.txt title count matches");
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "zedmix-polish2-"));
  mkdirSync(dir, { recursive: true });
  await partialUpdates(dir);
  await alphaGrade(dir);
  await maskGc(dir);
  docs();
  if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nsmoke-polish2: all checks passed");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
