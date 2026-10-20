/**
 * Locked-track smoke test (no downloads; known issue A12). A LOCKED track's
 * clips are protected from every edit, direct or by a ripple: the edit is
 * refused with an error naming the track (and the clip), and NOTHING changes —
 * the project, the undo depth and the redo history are exactly as before.
 *
 *  1. Direct edits of a clip on a locked track (trim, move, split, effects,
 *     remove, add a clip onto it, cut_range) are refused.
 *  2. Ripples that would move a clip on a locked track are refused: a speed
 *     change with ripple 'all', a speed change whose linked detached audio sits
 *     on a locked track, freeze_frame 'all', ripple_delete_ranges / transcript
 *     cuts that include a locked track. The same edits with ripple 'none', or
 *     ones that leave the locked track alone (ripple 'track' on other tracks),
 *     still work.
 *  3. Track-level changes stay allowed: rename / reorder / unlock a locked
 *     track, change the project fps (re-times every clip), remove the track.
 *  4. Long bakes refuse up front: reverse_clip / smooth_slow_motion /
 *     freeze_frame on a locked clip write nothing to baked/.
 *  5. A bake whose commit is refused leaves nothing in baked/: freeze_frame
 *     ripple 'all' into a locked track, reverse_clip whose partner's track is
 *     locked during the bake, and reverse_clip whose J-cut audio's new spot
 *     (the L-cut tail) is taken by another clip during the bake.
 *
 * Run: npx tsx packages/core/scripts/smoke-locks.ts
 */
import { execa } from "execa";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { EditorEngine } from "../src/engine.js";
import { methods } from "../src/rpc.js";
import { FFMPEG_BIN } from "../src/ffmpeg/executor.js";
import type { AssetTranscript, Clip } from "../src/types.js";

const FPS = 30;
let failures = 0;
function check(cond: boolean, name: string, detail = ""): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "zedmix-locks-"));
  const src = join(dir, "clip.mp4");
  await execa(FFMPEG_BIN, [
    "-hide_banner", "-y", "-f", "lavfi", "-i", `testsrc2=s=160x90:r=${FPS}:d=8`, "-f", "lavfi", "-i", "sine=frequency=440:duration=8:sample_rate=48000",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src,
  ]);
  const engine = new EditorEngine(dir);
  engine.setProjectSettings({ width: 160, height: 90, fps: FPS, name: "locks-smoke" });
  const asset = await engine.importVideo(src);
  const call = async <T = unknown>(name: keyof typeof methods, params: Record<string, unknown> = {}): Promise<T> => {
    const m = methods[name];
    const parsed = (m.schema as { parse: (x: unknown) => unknown }).parse(params);
    return (await m.handler(engine, parsed as never)) as T;
  };
  const tracks = () => engine.getProject().tracks;
  const clip = (id: string): Clip => tracks().flatMap((t) => t.clips).find((c) => c.id === id)!;
  const internals = engine as unknown as { undoStack: unknown[]; redoStack: unknown[] };
  const state = () => JSON.stringify({ tracks: tracks(), markers: engine.getProject().markers, assets: engine.getProject().assets.map((a) => a.id) });
  const bakedFiles = () => (existsSync(join(dir, "baked")) ? readdirSync(join(dir, "baked")).length : 0);

  // V1: A [0,60) | B [60,120); A1: A's detached audio (linked); V2 (locked): T [90,120) after A's end; A2 (locked): music [0,150).
  const v1 = tracks()[0];
  const A = engine.addClip(asset.id, { trackIndex: v1.index, startFrame: 0, sourceInFrame: 0, sourceOutFrame: 60 });
  const B = engine.addClip(asset.id, { trackIndex: v1.index, startFrame: 60, sourceInFrame: 60, sourceOutFrame: 120 });
  const a1 = engine.addTrack("audio", { name: "A1" });
  const Aa = engine.addClip(asset.id, { trackIndex: a1.index, startFrame: 0, sourceInFrame: 0, sourceOutFrame: 60 });
  engine.setClipEffects(A.id, { volume: 0 });
  engine.linkClips([A.id, Aa.id]);
  const v2 = engine.addTrack("video", { name: "Titles" });
  const T = engine.addClip(asset.id, { trackIndex: v2.index, startFrame: 90, sourceInFrame: 0, sourceOutFrame: 30 });
  const a2 = engine.addTrack("audio", { name: "Music" });
  const M = engine.addClip(asset.id, { trackIndex: a2.index, startFrame: 0, sourceInFrame: 0, sourceOutFrame: 150 });
  await call("set_track_properties", { trackIndex: v2.index, locked: true });
  await call("set_track_properties", { trackIndex: a2.index, locked: true });

  /** Run an edit that must be refused: it throws naming the track, and nothing changes (history included). */
  const refused = async (label: string, run: () => unknown, track: { index: number; name?: string }) => {
    // Leave a redo-able step, to prove a refusal keeps the redo history too.
    engine.setMarkers([{ frame: 7, name: "redo me" }]);
    engine.undo();
    const s0 = state();
    const u0 = internals.undoStack.length;
    const r0 = internals.redoStack.length;
    let err = "";
    try {
      await run();
    } catch (e) {
      err = (e as Error).message;
    }
    check(
      new RegExp(`Track ${track.index} \\("${track.name}"\\) is locked`).test(err) && state() === s0 && internals.undoStack.length === u0 && internals.redoStack.length === r0 && r0 > 0,
      `${label}: refused, naming the track; nothing changed (undo depth ${u0}, redo ${r0} kept)`,
      err.slice(0, 160) || "not refused",
    );
  };

  // ---- 1. direct edits ------------------------------------------------------------
  console.log("\ndirect edits of a clip on a locked track");
  await refused("trim_clip", () => call("trim_clip", { clipId: T.id, sourceInFrame: 5 }), v2);
  await refused("move_clip", () => call("move_clip", { clipId: T.id, startFrame: 100 }), v2);
  await refused("split_clip", () => call("split_clip", { clipId: T.id, atFrame: 10 }), v2);
  await refused("set_clip_effects", () => engine.setClipEffects(T.id, { opacity: 0.5 }), v2);
  await refused("remove_clip", () => engine.removeClip(T.id), v2);
  await refused("add a clip onto it", () => engine.addClip(asset.id, { trackIndex: v2.index, startFrame: 200, sourceInFrame: 0, sourceOutFrame: 10 }), v2);
  await refused("cut_range", () => call("cut_range", { clipId: M.id, startFrame: 10, endFrame: 20 }), a2);

  // ---- 2. ripples -------------------------------------------------------------------
  console.log("\nripples that would move a clip on a locked track");
  await refused("set_clip_speed 0.5x, ripple 'all' (moves the title)", () => call("set_clip_speed", { clipId: A.id, speed: 0.5, ripple: "all" }), v2);
  const ok1 = await call<{ deltaFrames: number }>("set_clip_speed", { clipId: A.id, speed: 0.5 });
  check(ok1.deltaFrames === 60 && clip(T.id).startFrame === 90 && clip(B.id).startFrame === 120, "set_clip_speed ripple 'track' leaves the locked tracks alone: allowed (B moved, the title stayed)");
  engine.undo();
  const ok2 = await call<{ deltaFrames: number; shiftedClips: number }>("set_clip_speed", { clipId: A.id, speed: 0.5, ripple: "none" });
  check(ok2.shiftedClips === 0 && clip(A.id).effects?.speed === 0.5, "ripple 'none': allowed");
  engine.undo();
  await call("set_track_properties", { trackIndex: a1.index, locked: true });
  await refused("set_clip_speed whose linked detached audio sits on a locked track", () => call("set_clip_speed", { clipId: A.id, speed: 2 }), { index: a1.index, name: "A1" });
  await call("set_track_properties", { trackIndex: a1.index, locked: false });
  await refused("freeze_frame ripple 'all' (moves the title)", () => call("freeze_frame", { clipId: A.id, atSeconds: 1, durationSeconds: 1, ripple: "all" }), v2);
  const fz = await call<{ durationFrames: number }>("freeze_frame", { clipId: A.id, atSeconds: 1, durationSeconds: 1 });
  check(fz.durationFrames === 30 && clip(T.id).startFrame === 90, "freeze_frame ripple 'track' (V1 + its linked audio only): allowed");
  engine.undo();
  await refused(
    "ripple_delete_ranges including a locked track",
    () => call("ripple_delete_ranges", { ranges: [{ trackIndex: v1.index, startFrame: 10, endFrame: 20 }, { trackIndex: a2.index, startFrame: 10, endFrame: 20 }] }),
    a2,
  );
  // Transcript cuts: the picture's linked audio on a locked track.
  const transcript: AssetTranscript = {
    segments: [{ start: 0.5, end: 1.0, text: "cut this" }],
    words: [{ text: "cut", start: 0.5, end: 0.7 }, { text: "this", start: 0.7, end: 1.0 }],
    model: "fake",
    language: "en",
  };
  (engine as unknown as { setCachedTranscript(id: string, t: AssetTranscript): void }).setCachedTranscript(asset.id, transcript);
  await call("set_track_properties", { trackIndex: a1.index, locked: true });
  await refused("delete_transcript_ranges whose cut reaches a locked track", () => call("delete_transcript_ranges", { assetId: asset.id, ranges: [{ fromWord: 0, toWord: 1 }] }), { index: a1.index, name: "A1" });
  await call("set_track_properties", { trackIndex: a1.index, locked: false });

  // ---- 3. track-level changes ------------------------------------------------------
  console.log("\ntrack-level changes");
  await call("set_track_properties", { trackIndex: v2.index, name: "Titles 2" });
  check(tracks().find((t) => t.id === v2.id)!.name === "Titles 2", "renaming a locked track: allowed");
  await call("set_track_properties", { trackIndex: v2.index, name: "Titles" });
  engine.setProjectSettings({ fps: 60 });
  check(clip(T.id).startFrame === 180 && engine.getProject().fps === 60, "an fps change re-times the locked track's clips too: allowed (title at 180 @ 60 fps)");
  engine.undo();
  check(clip(T.id).startFrame === 90 && engine.getProject().fps === FPS, "…and undoes");

  // ---- 4. bakes refuse up front ----------------------------------------------------
  console.log("\nlong bakes refuse before any work");
  const files0 = bakedFiles();
  for (const [name, params] of [["reverse_clip", { clipId: T.id }], ["freeze_frame", { clipId: T.id, atSeconds: 0.2, durationSeconds: 1 }]] as const) {
    let err = "";
    try {
      await call(name, params as Record<string, unknown>);
    } catch (e) {
      err = (e as Error).message;
    }
    check(/Track \d+ \("Titles"\) is locked/.test(err) && bakedFiles() === files0, `${name} on a locked clip: refused before baking (nothing in baked/)`, err.slice(0, 120));
  }
  engine.setClipEffects(A.id, { speed: 0.5 });
  await call("set_track_properties", { trackIndex: v1.index, locked: true });
  let err = "";
  try {
    await call("smooth_slow_motion", { clipId: A.id, mode: "blend" });
  } catch (e) {
    err = (e as Error).message;
  }
  check(/is locked/.test(err) && bakedFiles() === files0, "smooth_slow_motion on a locked clip: refused before baking", err.slice(0, 120));
  await call("set_track_properties", { trackIndex: v1.index, locked: false });

  // ---- 5. a refused commit removes its bake --------------------------------------
  console.log("\na bake whose commit is refused leaves nothing in baked/");
  const refusedBake = async (label: string, run: () => Promise<unknown>, want: RegExp) => {
    const f0 = bakedFiles();
    const s0 = state();
    let e = "";
    try {
      await run();
    } catch (x) {
      e = (x as Error).message;
    }
    check(want.test(e) && bakedFiles() === f0 && state() === s0, `${label}: refused, nothing left in baked/ (${bakedFiles() - f0} new), project unchanged`, e.slice(0, 160) || "not refused");
  };
  await refusedBake("freeze_frame ripple 'all' (would move the locked title)", () => call("freeze_frame", { clipId: A.id, atSeconds: 1, durationSeconds: 1, ripple: "all" }), /Track \d+ \("Titles"\) is locked/);
  await refusedBake(
    "reverse_clip whose linked audio's track is locked during the bake",
    async () => {
      const { promise } = engine.startReverseJob(A.id);
      engine.setTrackProperties(a1.index, { locked: true });
      try {
        return await promise;
      } finally {
        engine.setTrackProperties(a1.index, { locked: false });
      }
    },
    /Track \d+ \("A1"\) is locked/,
  );
  // P on V1 [300,360); its audio Pa on A1 starts 10 frames early (a J-cut, [290,350)): reversed it becomes an L-cut tail [310,370).
  const P = engine.addClip(asset.id, { trackIndex: v1.index, startFrame: 300, sourceInFrame: 0, sourceOutFrame: 60 });
  const Pa = engine.addClip(asset.id, { trackIndex: a1.index, startFrame: 290, sourceInFrame: 0, sourceOutFrame: 60 });
  engine.linkClips([P.id, Pa.id]);
  const Q = engine.addClip(asset.id, { trackIndex: a1.index, startFrame: 400, sourceInFrame: 0, sourceOutFrame: 20 });
  const a1Spans = () => tracks().find((t) => t.id === a1.id)!.clips.map((c) => [c.startFrame, c.startFrame + c.sourceOutFrame - c.sourceInFrame]);
  let a1Clips: number[][] = [];
  await refusedBake(
    "reverse_clip whose J-cut audio's new spot is taken during the bake",
    async () => {
      const { promise } = engine.startReverseJob(P.id);
      try {
        engine.moveClip(Q.id, 355);
        return await promise;
      } finally {
        a1Clips = a1Spans();
        engine.moveClip(Q.id, 400);
      }
    },
    new RegExp(`would move to frame 310 and overlap clip "${Q.id}"`),
  );
  check(a1Clips.length === 3 && a1Clips.every(([s0, e0], i) => a1Clips.every(([s1, e1], j) => i === j || e0 <= s1 || e1 <= s0)), `…and no two clips overlap on A1 (${JSON.stringify(a1Clips)})`);

  // Unlocked again: the same edit goes through.
  await call("set_track_properties", { trackIndex: v2.index, locked: false });
  await call("move_clip", { clipId: T.id, startFrame: 100 });
  check(clip(T.id).startFrame === 100, "after unlocking, the edit goes through");
  // Removing a locked track is a track-level change: allowed.
  await call("set_track_properties", { trackIndex: a2.index, locked: true });
  engine.removeTrack(a2.index);
  check(!tracks().some((t) => t.id === a2.id), "removing a locked track: allowed");

  if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nsmoke-locks: all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
