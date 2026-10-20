/**
 * Auto-bleep smoke test (no downloads). Synthesizes a 6 s 440 Hz tone clip,
 * injects a fake word-level transcript straight into the engine's transcript
 * cache, and verifies — by EXPORTING and measuring the audio (1 kHz SFX energy,
 * 440 Hz source energy in short windows) — that bleeps belong to their clip:
 *   - the profanity matcher and every synthesized SFX,
 *   - bleep_words dry run (mutates nothing) and real run (Bleeps on the clip,
 *     no extra track, built-in SFX imported as an asset but not placed),
 *   - the SFX + mutes follow the clip: move +1 s, head trim 0.5 s, trim past a
 *     word (gone) and back (returns), split between the words (one bleep per
 *     half, export unchanged), speed 2 (on the words, still 1 kHz), audio slip,
 *   - set_bleep +0.3 s, add_bleep, remove_bleep, remove_bleeps, re-run
 *     replacement, linked/muted-track targeting, undo (one step each),
 *   - segment-cache keys change with bleeps; the segmented preview mixes them.
 *
 * Run: npx tsx packages/core/scripts/smoke-bleep.ts
 */
import { execa } from "execa";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { EditorEngine } from "../src/engine.js";
import { methods } from "../src/rpc.js";
import { FFMPEG_BIN } from "../src/ffmpeg/executor.js";
import { findProfanity } from "../src/audio/profanity.js";
import { SFX_NAMES, SFX_RATE, sfxDuration, synthesizeSfx } from "../src/audio/sfx.js";
import { planSegments, segmentKey, type SegmentBuild } from "../src/ffmpeg/segments.js";
import { PREVIEW_PROFILE, previewCanvas } from "../src/ffmpeg/graph.js";
import type { AssetTranscript, Clip, ResolvedRenderClip, TranscriptWord } from "../src/types.js";

/** These keys compare one project against itself: any fixed FFmpeg build will do. */
const BUILD: SegmentBuild = { ffmpeg: "", xfadeEofPad: false };

const FPS = 30;

const WORDS: TranscriptWord[] = [
  { text: "hello", start: 0.5, end: 0.8 },
  { text: "fucking", start: 1.0, end: 1.4 },
  { text: "class", start: 2.0, end: 2.3 },
  { text: "s**t", start: 3.0, end: 3.3 },
  { text: "assume", start: 4.0, end: 4.3 },
];
/** Padded windows (default 60 ms before / 80 ms after), in source seconds. */
const W1: [number, number] = [0.94, 1.48];
const W2: [number, number] = [2.94, 3.38];

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  console.log(`  ok  ${msg}`);
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

/** Amplitude of a pure tone at `freq` in [t0,t1] of a file's audio (Goertzel). */
async function toneAmp(file: string, t0: number, t1: number, freq: number): Promise<number> {
  const { stdout } = await execa(
    FFMPEG_BIN,
    ["-hide_banner", "-v", "error", "-ss", t0.toFixed(3), "-t", (t1 - t0).toFixed(3), "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
    { encoding: "buffer" },
  );
  const b = Buffer.from(stdout as unknown as Uint8Array);
  const n = Math.floor(b.length / 4);
  if (n === 0) return 0;
  const w = (2 * Math.PI * freq) / 48000;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const v = b.readFloatLE(i * 4);
    re += v * Math.cos(w * i);
    im -= v * Math.sin(w * i);
  }
  return (2 * Math.hypot(re, im)) / n;
}

async function main() {
  // ---- matcher --------------------------------------------------------------
  console.log("matcher");
  const matched = findProfanity(WORDS).map((h) => h.word.text);
  assert(matched.length === 2 && matched[0] === "fucking" && matched[1] === "s**t", `matches exactly fucking + s**t (got ${matched.join(",")})`);
  const w = (t: string): TranscriptWord[] => [{ text: t, start: 0, end: 1 }];
  for (const safe of ["class", "assume", "Scunthorpe", "cocktail", "hello", "shitake", "Hell", "damn,", "dickens", "passion"]) {
    assert(findProfanity(w(safe)).length === 0, `"${safe}" is not bleeped by default`);
  }
  for (const bad of ["Fuck!", "“bullshit.”", "motherfuckers", "f***", "****", "Bitches", "goddamn"]) {
    assert(findProfanity(w(bad)).length === 1, `"${bad}" is bleeped`);
  }
  assert(findProfanity(w("Damn,"), { includeMild: true }).length === 1, "includeMild adds damn");
  assert(findProfanity(w("fuck"), { useDefaultList: false }).length === 0, "useDefaultList:false drops the built-in list");
  assert(findProfanity(w("Banana."), { extraWords: ["banana"], useDefaultList: false }).length === 1, "custom words match case-insensitively");

  // ---- synthesized SFX ------------------------------------------------------
  console.log("sfx");
  for (const name of SFX_NAMES) {
    const buf = synthesizeSfx(name);
    let peak = 0;
    let sum = 0;
    let bad = false;
    for (const v of buf) {
      if (!Number.isFinite(v)) bad = true;
      peak = Math.max(peak, Math.abs(v));
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    const dur = buf.length / SFX_RATE;
    assert(!bad && peak < 1 && peak > 0.5 && rms > 0.05 && Math.abs(dur - sfxDuration(name)) < 0.01, `${name}: ${dur.toFixed(2)}s peak ${peak.toFixed(2)} rms ${rms.toFixed(2)}`);
  }

  // ---- engine ---------------------------------------------------------------
  const dir = mkdtempSync(join(tmpdir(), "zedmix-bleep-"));
  const src = join(dir, "tone.mp4");
  await execa(FFMPEG_BIN, [
    "-hide_banner", "-y", "-f", "lavfi", "-i", `color=c=gray:s=320x180:r=${FPS}:d=6`,
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6:sample_rate=48000", "-shortest", "-pix_fmt", "yuv420p", src,
  ]);

  const engine = new EditorEngine(dir);
  engine.setProjectSettings({ width: 320, height: 180, fps: FPS, name: "bleep-smoke" });
  const asset = await engine.importVideo(src);
  const clip = engine.addClip(asset.id, { startFrame: 0 });
  const transcript: AssetTranscript = { segments: [{ start: 0, end: 6, text: WORDS.map((x) => x.text).join(" ") }], words: WORDS, model: "fake", language: "en" };
  (engine as unknown as { setCachedTranscript(id: string, t: AssetTranscript): void }).setCachedTranscript(asset.id, transcript);

  // Drive the bleep tools exactly like the server: schema-validate, then run the handler.
  const call = async <T = unknown>(name: keyof typeof methods, params: Record<string, unknown> = {}): Promise<T> => {
    const m = methods[name];
    const parsed = (m.schema as { parse: (x: unknown) => unknown }).parse(params);
    return (await m.handler(engine, parsed as never)) as T;
  };
  const snapshot = () => JSON.stringify({ tracks: engine.getProject().tracks, assets: engine.getProject().assets.map((a) => a.id) });
  const allClips = () => engine.getProject().tracks.flatMap((t) => t.clips);
  const cur = (id = clip.id): Clip => allClips().find((c) => c.id === id)!;
  const visible = (id = clip.id) => engine.bleepLayers(cur(id));

  let outN = 0;
  const exportNow = async (): Promise<string> => {
    const out = join(dir, `out${++outN}.mp4`);
    await engine.exportVideo(out);
    return out;
  };
  /** Each [a,b] timeline window: source 440 Hz silent, 1 kHz SFX present (margins trim the de-click ramps). */
  const expectBleeped = async (file: string, wins: Array<[number, number]>, label: string, m440 = 0.03, m1k = 0.05) => {
    for (const [a, b] of wins) {
      const s440 = await toneAmp(file, a + m440, b - m440, 440);
      const s1k = await toneAmp(file, a + m1k, b - m1k, 1000);
      assert(s440 < 0.004 && s1k > 0.1, `${label}: [${a.toFixed(2)},${b.toFixed(2)}] 440 Hz silent (${s440.toFixed(4)}), 1 kHz SFX (${s1k.toFixed(3)})`);
    }
  };
  /** Each [a,b] timeline window: source 440 Hz present, no 1 kHz SFX. */
  const expectClean = async (file: string, wins: Array<[number, number]>, label: string) => {
    for (const [a, b] of wins) {
      const s440 = await toneAmp(file, a, b, 440);
      const s1k = await toneAmp(file, a, b, 1000);
      assert(s440 > 0.05 && s1k < 0.005, `${label}: [${a.toFixed(2)},${b.toFixed(2)}] 440 Hz present (${s440.toFixed(3)}), no SFX (${s1k.toFixed(4)})`);
    }
  };
  const shift = (win: [number, number], d: number, k = 1): [number, number] => [win[0] / k + d, win[1] / k + d];

  console.log("dry run");
  const before = snapshot();
  const rev0 = engine.getProject().revision;
  const dry = await call<{ hits: Array<{ text: string; bleepId?: string; startFrame: number }> }>("bleep_words", { dryRun: true });
  assert(dry.hits.length === 2 && dry.hits[0]!.text === "fucking" && dry.hits.every((h) => h.bleepId === undefined), "dryRun reports 2 hits (no bleep ids)");
  assert(snapshot() === before && engine.getProject().revision === rev0, "dryRun mutates nothing");

  console.log("bleep_words");
  const trackCount = engine.getProject().tracks.length;
  const res = await call<{ hits: Array<{ clipId: string; bleepId?: string; startFrame: number; endFrame: number }>; indexedAssetIds: string[] }>("bleep_words", { sound: "beep" });
  assert(res.hits.length === 2 && res.indexedAssetIds.length === 0 && res.hits.every((h) => h.clipId === clip.id && !!h.bleepId), "2 hits on the clip, with bleep ids");
  assert(res.hits[0]!.startFrame === Math.round(W1[0] * FPS) && res.hits[1]!.endFrame === Math.round(W2[1] * FPS), `hit frames are the padded windows (${res.hits[0]!.startFrame}..${res.hits[1]!.endFrame})`);
  const bleeps = cur().effects?.bleeps ?? [];
  assert(bleeps.length === 2 && near(bleeps[0]!.start, W1[0]) && near(bleeps[0]!.end, W1[1]) && near(bleeps[1]!.start, W2[0]) && bleeps[0]!.word === "fucking", "clip.effects.bleeps holds both padded source windows");
  assert(engine.getProject().tracks.length === trackCount, "no Bleeps track is created");
  const beepAsset = engine.getProject().assets.find((a) => a.builtinSfx === "beep");
  assert(!!beepAsset && !allClips().some((c) => c.assetId === beepAsset.id), "built-in beep imported as an asset, NOT placed on the timeline");
  engine.undo();
  assert(snapshot() === before, "undo of bleep_words restores the state in ONE step");
  engine.redo();
  const [b1, b2] = cur().effects!.bleeps!;

  const base = await exportNow();
  await expectBleeped(base, [W1, W2], "base");
  await expectClean(base, [[0.2, 0.8], [1.7, 2.8], [3.6, 5.5]], "base");

  // ---- segment cache keys change with bleeps + segmented preview mixes them
  console.log("cache keys / preview");
  const keysNow = async (): Promise<string[]> => {
    const { clips: staged } = await (engine as unknown as { stageRender(): Promise<{ clips: ResolvedRenderClip[] }> }).stageRender();
    const segs = planSegments(staged, 6);
    return segs.map((s) => segmentKey(staged, s, previewCanvas(engine.canvas), PREVIEW_PROFILE, {}, null, BUILD));
  };
  const keysA = await keysNow();
  await call("set_bleep", { clipId: clip.id, bleepId: b1!.id, volume: 0.5 });
  const keysB = await keysNow();
  assert(keysA.join() !== keysB.join(), "segment cache keys change when a bleep changes");
  engine.undo();
  const prev = await engine.renderPreview();
  await expectBleeped(prev.path, [W1, W2], "segmented preview", 0.04, 0.07);

  // ---- move ---------------------------------------------------------------
  console.log("move +1 s");
  await call("move_clip", { clipId: clip.id, startFrame: 30 });
  const moved = await exportNow();
  await expectBleeped(moved, [shift(W1, 1), shift(W2, 1)], "moved");
  await expectClean(moved, [[1.2, 1.8], [2.7, 3.8]], "moved");
  engine.undo();

  // ---- trim head ------------------------------------------------------------
  console.log("trim head 0.5 s");
  await call("trim_clip", { clipId: clip.id, sourceInFrame: 15 });
  const trimmed = await exportNow();
  await expectBleeped(trimmed, [shift(W1, -0.5), shift(W2, -0.5)], "head-trimmed");
  await expectClean(trimmed, [[0.05, 0.4], [1.2, 2.3]], "head-trimmed");

  console.log("trim past the first word, then back");
  await call("trim_clip", { clipId: clip.id, sourceInFrame: 48 }); // 1.6 s, past W1's end
  assert(visible().length === 1 && visible()[0]!.bleepId === b2!.id, "first bleep is gone once its word is trimmed off");
  assert(cur().effects?.bleeps?.length === 2, "…but stays on the clip (source time)");
  const pastFirst = await exportNow();
  await expectBleeped(pastFirst, [shift(W2, -1.6)], "trimmed past word 1");
  await expectClean(pastFirst, [[0.05, 1.2]], "trimmed past word 1");
  await call("trim_clip", { clipId: clip.id, sourceInFrame: 0 });
  assert(visible().length === 2, "extending the trim back restores it");
  const restored = await exportNow();
  await expectBleeped(restored, [W1, W2], "trim restored");

  // ---- split ----------------------------------------------------------------
  console.log("split between the words");
  const split = await call<{ left: string; right: string }>("split_clip", { clipId: clip.id, atFrame: 66 }); // 2.2 s
  const lv = visible(split.left);
  const rv = visible(split.right);
  assert(lv.length === 1 && lv[0]!.bleepId === b1!.id && rv.length === 1 && rv[0]!.bleepId === b2!.id, "each half carries exactly its own bleep");
  for (const id of [split.left, split.right]) {
    const ids = (cur(id).effects?.bleeps ?? []).map((b) => b.id);
    assert(new Set(ids).size === ids.length, `bleep ids unique within ${id === split.left ? "left" : "right"} half`);
  }
  const splitOut = await exportNow();
  await expectBleeped(splitOut, [W1, W2], "split");
  await expectClean(splitOut, [[0.2, 0.8], [1.7, 2.1], [2.3, 2.8], [3.6, 5.5]], "split");
  engine.undo();
  assert(!!cur() && cur().effects?.bleeps?.length === 2, "undo of split restores the single clip with both bleeps");

  // ---- speed 2 --------------------------------------------------------------
  console.log("speed 2");
  await call("set_clip_speed", { clipId: clip.id, speed: 2 });
  const fast = await exportNow();
  const F1 = shift(W1, 0, 2);
  const F2 = shift(W2, 0, 2);
  await expectBleeped(fast, [F1, F2], "speed 2", 0.03, 0.04);
  for (const [a, b] of [F1, F2]) {
    const k1 = await toneAmp(fast, a + 0.04, b - 0.04, 1000);
    const k2 = await toneAmp(fast, a + 0.04, b - 0.04, 2000);
    const k05 = await toneAmp(fast, a + 0.04, b - 0.04, 500);
    assert(k1 > 0.1 && k2 < 0.01 && k05 < 0.01, `speed 2: SFX still 1 kHz, not pitch-shifted (1k ${k1.toFixed(3)}, 2k ${k2.toFixed(4)}, 500 ${k05.toFixed(4)})`);
  }
  // A beep lasts the window / speed: gone right after the (sped-up) window.
  const tail = await toneAmp(fast, F1[1] + 0.03, F1[1] + 0.2, 1000);
  assert(tail < 0.005, `speed 2: beep ends with its window (${tail.toFixed(4)})`);
  await expectClean(fast, [[0.05, 0.4], [0.8, 1.4], [1.8, 2.9]], "speed 2");
  engine.undo();

  // ---- J/L audio slip -------------------------------------------------------
  console.log("audio slip (L-cut +0.5 s)");
  await call("set_audio_offset", { clipId: clip.id, offsetFrames: 15 });
  const slipped = await exportNow();
  await expectBleeped(slipped, [shift(W1, 0.5), shift(W2, 0.5)], "slipped");
  engine.undo();

  // ---- set_bleep -------------------------------------------------------------
  console.log("set_bleep +0.3 s");
  const undoDepth = () => (engine as unknown as { undoStack: unknown[] }).undoStack.length;
  const d0 = undoDepth();
  const nudged = await call<{ startFrame: number | null; bleep: { start: number; end: number } }>("set_bleep", {
    clipId: clip.id, bleepId: b1!.id, start: b1!.start + 0.3, end: b1!.end + 0.3,
  });
  assert(undoDepth() === d0 + 1, "set_bleep is ONE undo step");
  assert(near(nudged.bleep.start, W1[0] + 0.3, 1e-3) && nudged.startFrame === Math.round((W1[0] + 0.3) * FPS), `set_bleep returns the new placement (frame ${nudged.startFrame})`);
  const nudgedOut = await exportNow();
  await expectBleeped(nudgedOut, [shift(W1, 0.3)], "nudged");
  await expectClean(nudgedOut, [[0.97, 1.2]], "nudged (old window start now clean)");
  let threw = false;
  try { await call("set_bleep", { clipId: clip.id, bleepId: b1!.id, start: 2, end: 1 }); } catch { threw = true; }
  assert(threw, "set_bleep rejects start >= end");
  const tiny = await call<{ bleep: { start: number; end: number } }>("set_bleep", { clipId: clip.id, bleepId: b1!.id, start: 1.0, end: 1.01 });
  assert(near(tiny.bleep.end - tiny.bleep.start, 0.04, 1e-6), "set_bleep enforces the 0.04 s minimum window");
  const clamped = await call<{ bleep: { start: number; end: number } }>("set_bleep", { clipId: clip.id, bleepId: b1!.id, start: 5.8, end: 9 });
  assert(near(clamped.bleep.end, asset.duration, 1e-3), `set_bleep clamps to the asset duration (${clamped.bleep.end})`);
  engine.undo();
  engine.undo();
  engine.undo();
  assert(near(cur().effects!.bleeps!.find((b) => b.id === b1!.id)!.start, W1[0]), "three undos restore the original window");

  // ---- add_bleep ------------------------------------------------------------
  console.log("add_bleep");
  const manual = await call<{ bleep: { id: string }; startFrame: number }>("add_bleep", { clipId: clip.id, atSeconds: 5.0, duration: 0.4, word: "manual" });
  assert(manual.startFrame === 150 && cur().effects?.bleeps?.length === 3, "add_bleep (timeline seconds) adds a third bleep at 5.0 s");
  const quack = await call<{ bleep: { id: string; sound: string } }>("add_bleep", { clipId: clip.id, start: 4.5, end: 4.6, sound: "quack" });
  assert(quack.bleep.sound === "quack" && !!engine.getProject().assets.find((a) => a.builtinSfx === "quack"), "add_bleep (source seconds) with quack imports the quack SFX asset");
  const qLayer = visible().find((l) => l.bleepId === quack.bleep.id)!;
  assert(near(qLayer.sfxDuration, 0.3, 1e-6), "quack plays its natural 0.3 s (longer than its 0.1 s window)");
  threw = false;
  try { await call("add_bleep", { clipId: clip.id, atSeconds: 7 }); } catch { threw = true; }
  assert(threw, "add_bleep outside the clip is rejected");
  const added = await exportNow();
  await expectBleeped(added, [[5.0, 5.4]], "manual bleep");
  engine.undo(); // drop the quack

  // ---- remove ---------------------------------------------------------------
  console.log("remove_bleep / remove_bleeps");
  await call("remove_bleep", { clipId: clip.id, bleepId: manual.bleep.id });
  assert(cur().effects?.bleeps?.length === 2, "remove_bleep removes only that bleep");
  const removedOne = await exportNow();
  await expectClean(removedOne, [[5.05, 5.35]], "manual bleep removed");
  await expectBleeped(removedOne, [W1, W2], "others kept");
  const withBleeps = snapshot();
  const rm = await call<{ clearedClips: number; removedBleeps: number }>("remove_bleeps", {});
  assert(rm.clearedClips === 1 && rm.removedBleeps === 2 && cur().effects?.bleeps === undefined, "remove_bleeps clears every bleep");
  const clean = await exportNow();
  await expectClean(clean, [[0.9, 1.5], [2.9, 3.4]], "after remove_bleeps");
  engine.undo();
  assert(snapshot() === withBleeps, "undo of remove_bleeps restores them");

  // ---- re-run replaces --------------------------------------------------------
  console.log("re-run / clear effects");
  await call("bleep_words", { sound: "quack" });
  const re = cur().effects?.bleeps ?? [];
  assert(re.length === 2 && re.every((b) => b.sound === "quack") && !re.some((b) => b.id === b1!.id), "re-running replaces the clip's bleeps");
  await call("clear_clip_effects", { clipId: clip.id });
  assert(cur().effects?.bleeps?.length === 2, "clear_clip_effects keeps the bleeps");
  engine.undo();
  engine.undo();

  // ---- linked audio + muted track targeting ----------------------------------
  console.log("linked audio / muted track");
  await call("remove_bleeps", {});
  const aTrack = engine.addTrack("audio");
  const audioClip = engine.addClip(asset.id, { trackIndex: aTrack.index, startFrame: 0 });
  engine.linkClips([clip.id, audioClip.id]);
  engine.setClipEffects(clip.id, { volume: 0 }); // the detached audio carries the sound
  const linked = await call<{ hits: Array<{ clipId: string }> }>("bleep_words", { clipIds: [clip.id] });
  assert(linked.hits.length === 2 && linked.hits.every((h) => h.clipId === audioClip.id) && !cur().effects?.bleeps, "bleeps land on the linked clip that carries the audio");
  const linkedOut = await exportNow();
  await expectBleeped(linkedOut, [W1, W2], "linked audio clip");
  engine.setTrackProperties(aTrack.index, { muted: true });
  const mutedOut = await exportNow();
  const m1k = await toneAmp(mutedOut, W1[0] + 0.05, W1[1] - 0.05, 1000);
  assert(m1k < 0.005, `muted track silences its bleeps too (${m1k.toFixed(4)})`);
  engine.setTrackProperties(aTrack.index, { muted: false });

  // ---- .aive save → load round-trip -------------------------------------------
  console.log("save / load");
  const file = join(dir, "bleeps.aive");
  await call("save_project", { path: file });
  const reopened = new EditorEngine(dir);
  await (methods.load_project.handler as (e: EditorEngine, p: { path: string }) => Promise<unknown>)(reopened, { path: file });
  const reClip = reopened.getProject().tracks.flatMap((t) => t.clips).find((c) => c.id === audioClip.id);
  assert(JSON.stringify(reClip?.effects?.bleeps) === JSON.stringify(cur(audioClip.id).effects?.bleeps), "bleeps survive save → load unchanged");
  assert(reopened.getProject().assets.some((a) => a.builtinSfx === "beep"), "the built-in SFX asset keeps its builtinSfx marker");
  const reOut = join(dir, "reopened.mp4");
  await reopened.exportVideo(reOut);
  await expectBleeped(reOut, [W1, W2], "reopened project");

  console.log("\nBLEEP SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("BLEEP SMOKE TEST FAILED:", err);
  process.exit(1);
});
