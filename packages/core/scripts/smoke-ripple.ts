/**
 * Speed-change ripple smoke test (no downloads). A clip's speed change
 * (set_clip_speed, set_speed_ramp, clear_speed_ramp, clear_clip_effects) moves
 * the clips after it like CapCut, and its linked detached audio follows.
 *
 * Synthesizes 8 s of 160x90 video whose frames encode their own index (eight
 * black/white stripes = the bits of N) plus a 440 Hz tone, a separate "mic"
 * recording, a music bed and a still for a title, then builds:
 *   V1 = A [0,90) | B [90,150) | C [150,210)   (variants: a 20-frame gap
 *        before C; a 15-frame cross-dissolve from A into B)
 *   A1 = A's detached audio (A at volume 0, linked) | later audio clips
 *   A2 = unlinked music bed [0,120) (straddles A's end)
 *   V2 = unlinked title at frame 100 (after A)
 *   markers at 30 (inside A) and 120 (after A)
 * and checks, for set_clip_speed 2x / 0.5x, every ramp preset, clear_speed_ramp,
 * clear_clip_effects and an audio-only ramp change:
 *   - the clips after A on V1 and A1 move by exactly delta = A's new length −
 *     its old length (butted stays butted, the gap and the transition overlap
 *     are kept), and the result's deltaFrames / shiftedClips / linked say so;
 *   - A's linked audio gets the same speed / the same curve (same length);
 *   - ripple "track": the music, the title and the markers do not move;
 *     "all": the title and the late marker move, the music (straddles A's old
 *     end) stays and is listed in notMoved; "none": nothing moves;
 *   - ONE undo restores every position, speed and marker;
 *   - a speed-up that would leave A no longer than its transition is refused
 *     and changes nothing;
 *   - after freeze_frame the still and the right halves keep their speed but
 *     move; a linked mic recording on another asset gets the curve moved by its
 *     sync offset; a J-cut audio head is re-anchored so it stays in sync;
 *   - a LATER clip's own linked mic on another track moves with it (track and
 *     all modes; freeze_frame too); a linked pair the ripple would split, and a
 *     mic that would run into a clip that stays, are refused and change nothing;
 *   - an L-cut tail changed from the picture or the audio side: the picture
 *     sets the distance, the tail is trimmed to fit (slow-down) or leaves a
 *     short silence (speed-up), reported in splitEdits; a J-cut head slowed
 *     down at frame 0 / after another audio clip is trimmed, never clamped;
 *   - on a track that ripples from the old end, a straddler holds the clip
 *     entering it through a transition and the clip butted to it (notMoved
 *     reasons); a clip after a gap still moves; a same-footage cutaway on
 *     another video track is not a speed partner, a same-moment copy is;
 *   - an L-cut tail by EAR (known issue A13): picture frames + a chirp sound
 *     (pitch = source time) — after 0.5x / 2x / the bullet and montage curves
 *     on the picture, the sound under the picture plays the moment the picture
 *     shows, the tail goes on from there, and it never plays over the next
 *     audio clip, which starts on its own moment;
 *   - smooth_slow_motion and reverse_clip keep the length (nothing moves twice);
 *   - export: after montage on A the old gap region shows B's footage (no
 *     black); after bullet on A, B starts where A ends (no overlap).
 *
 * Run: npx tsx packages/core/scripts/smoke-ripple.ts
 */
import { execa } from "execa";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { EditorEngine } from "../src/engine.js";
import { methods } from "../src/rpc.js";
import { FFMPEG_BIN } from "../src/ffmpeg/executor.js";
import { RAMP_PRESETS, clipFootprintFrames, clipTimeMap, sourceFrameShownAt } from "../src/speed.js";
import type { Clip } from "../src/types.js";

const FPS = 30;
let failures = 0;
function check(cond: boolean, name: string, detail = ""): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Decode a video to the frame index each frame encodes (8 stripes = bits; black = 0). */
async function frameIndexes(file: string): Promise<number[]> {
  const W = 160;
  const H = 90;
  const { stdout } = await execa(
    FFMPEG_BIN,
    ["-hide_banner", "-v", "error", "-i", file, "-vf", `scale=${W}:${H}:flags=neighbor,format=yuv444p`, "-f", "rawvideo", "-"],
    { encoding: "buffer", maxBuffer: 1 << 29 },
  );
  const b = Buffer.from(stdout as unknown as Uint8Array);
  const fs = W * H * 3;
  const out: number[] = [];
  for (let k = 0; k < Math.floor(b.length / fs); k++) {
    let n = 0;
    for (let bit = 0; bit < 8; bit++) {
      const x = Math.floor(((bit + 0.5) * W) / 8);
      if (b[k * fs + (H >> 1) * W + x] > 125) n |= 1 << bit;
    }
    out.push(n);
  }
  return out;
}

interface Media {
  coded: string;
  mic: string;
  music: string;
  still: string;
}

type Variant = "butted" | "gap" | "dissolve";

/** One timeline: engine + the clip ids + rpc helper. */
async function build(dir: string, media: Media, variant: Variant) {
  const engine = new EditorEngine(dir);
  engine.setProjectSettings({ width: 160, height: 90, fps: FPS, name: `ripple-${variant}` });
  const coded = await engine.importVideo(media.coded);
  const music = await engine.importVideo(media.music);
  const still = await engine.importVideo(media.still);
  const call = async <T = unknown>(name: keyof typeof methods, params: Record<string, unknown> = {}): Promise<T> => {
    const m = methods[name];
    const parsed = (m.schema as { parse: (x: unknown) => unknown }).parse(params);
    return (await m.handler(engine, parsed as never)) as T;
  };
  const v1 = engine.getProject().tracks[0].index;
  // Sources start at frame >= 1 so a decoded 0 can only be black (a gap).
  const A = engine.addClip(coded.id, { trackIndex: v1, startFrame: 0, sourceInFrame: 1, sourceOutFrame: 91 });
  const B = engine.addClip(coded.id, { trackIndex: v1, startFrame: 90, sourceInFrame: 100, sourceOutFrame: 160 });
  const C = engine.addClip(coded.id, { trackIndex: v1, startFrame: variant === "gap" ? 170 : 150, sourceInFrame: 170, sourceOutFrame: 230 });
  if (variant === "dissolve") engine.setTransition(B.id, "dissolve", 15); // B → 75, C → 135
  const a1 = engine.addTrack("audio", { name: "A1" });
  const Aa = engine.addClip(coded.id, { trackIndex: a1.index, startFrame: 0, sourceInFrame: 1, sourceOutFrame: 91 });
  const pos = (id: string) => engine.getProject().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!.startFrame;
  const Ba = engine.addClip(coded.id, { trackIndex: a1.index, startFrame: pos(B.id), sourceInFrame: 100, sourceOutFrame: 160 });
  const Ca = engine.addClip(coded.id, { trackIndex: a1.index, startFrame: pos(C.id), sourceInFrame: 170, sourceOutFrame: 230 });
  engine.setClipEffects(A.id, { volume: 0 }); // the picture's own sound is silent; the linked clip carries it
  engine.linkClips([A.id, Aa.id]);
  const a2 = engine.addTrack("audio", { name: "A2" });
  const M = engine.addClip(music.id, { trackIndex: a2.index, startFrame: 0, sourceInFrame: 0, sourceOutFrame: 120 }); // [0,120): straddles A's end, ends before V1
  const v2 = engine.addTrack("video", { name: "V2" });
  const T = engine.addClip(still.id, { trackIndex: v2.index, startFrame: 100, sourceInFrame: 0, sourceOutFrame: 30 });
  engine.setMarkers([{ frame: 30, name: "early" }, { frame: 120, name: "late" }]);
  const clip = (id: string): Clip => engine.getProject().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
  const undoDepth = () => (engine as unknown as { undoStack: unknown[] }).undoStack.length;
  const state = () => JSON.stringify({ tracks: engine.getProject().tracks, markers: engine.getProject().markers });
  return { engine, call, coded, ids: { A: A.id, B: B.id, C: C.id, Aa: Aa.id, Ba: Ba.id, Ca: Ca.id, M: M.id, T: T.id }, clip, undoDepth, state, v1, a1: a1.index, v2: v2.index };
}

type Built = Awaited<ReturnType<typeof build>>;

interface SpeedResult {
  durationFrames: number;
  previousDurationFrames: number;
  deltaFrames: number;
  shiftedClips: number;
  shiftedMarkers: number;
  linked: { clipId: string; trackIndex: number; startFrame: number; durationFrames: number; previousDurationFrames: number }[];
  notMoved: { clipId: string; trackIndex: number; startFrame: number; endFrame: number; reason: string }[];
  splitEdits: { clipId: string; trackIndex: number; side: "head" | "tail"; wasFrames: number; nowFrames: number; trimmedFrames: number }[];
}

const speedState = (c: Clip) => JSON.stringify([c.effects?.speed ?? 1, c.effects?.speedRamp ?? null]);
const end = (c: Clip) => c.startFrame + clipFootprintFrames(c, FPS);

/**
 * Run one speed change on A and check the ripple, the linked audio and one undo.
 * `mode` is the ripple passed (undefined = the default, "track").
 */
async function rippleCase(t: Built, label: string, op: () => Promise<SpeedResult>, mode: "track" | "all" | "none" | undefined): Promise<SpeedResult> {
  const { ids, clip } = t;
  const all = Object.values(ids);
  const before = new Map(all.map((id) => [id, structuredClone(clip(id))]));
  const markersBefore = structuredClone(t.engine.getProject().markers ?? []);
  const s0 = t.state();
  const d0 = t.undoDepth();
  const oldEnd = end(before.get(ids.A)!);
  const r = await op();
  const A = clip(ids.A);
  const delta = clipFootprintFrames(A, FPS) - clipFootprintFrames(before.get(ids.A)!, FPS);
  const ripple = mode ?? "track";
  check(t.undoDepth() === d0 + 1, `${label}: one undo step`);
  check(r.deltaFrames === delta && r.durationFrames === end(A) - A.startFrame && r.previousDurationFrames === oldEnd, `${label}: deltaFrames ${r.deltaFrames} == new length ${r.durationFrames} − old ${r.previousDurationFrames}`, `want delta ${delta}`);
  // Who should move: the clips after A on V1 and after its audio on A1 ("track", "all"); the title too ("all").
  const movers = new Set(ripple === "none" ? [] : ripple === "all" ? [ids.B, ids.C, ids.Ba, ids.Ca, ids.T] : [ids.B, ids.C, ids.Ba, ids.Ca]);
  const wrong: string[] = [];
  for (const id of all) {
    const want = before.get(id)!.startFrame + (movers.has(id) && delta !== 0 ? delta : 0);
    if (clip(id).startFrame !== want) wrong.push(`${Object.entries(ids).find(([, v]) => v === id)![0]} at ${clip(id).startFrame}, want ${want}`);
  }
  check(wrong.length === 0, `${label}: ${ripple === "none" ? "nothing moves" : `later clips moved by exactly ${delta}`}${ripple === "track" ? "; music, title stay" : ripple === "all" ? "; the title moved too, the music stays" : ""}`, wrong.join("; "));
  check(r.shiftedClips === (delta !== 0 ? movers.size : 0), `${label}: shiftedClips ${r.shiftedClips}`, `want ${delta !== 0 ? movers.size : 0}`);
  // The edit stays seamless after A: butted stays butted, the gap and the overlap are kept.
  const B0 = before.get(ids.B)!;
  const C0 = before.get(ids.C)!;
  const B = clip(ids.B);
  const C = clip(ids.C);
  if (ripple !== "none") {
    check(B.startFrame - end(A) === B0.startFrame - oldEnd && C.startFrame - end(B) === C0.startFrame - end(B0), `${label}: A→B ${B.startFrame - end(A)} (was ${B0.startFrame - oldEnd}), B→C ${C.startFrame - end(B)} (was ${C0.startFrame - end(B0)})`);
  }
  // The detached audio got the same speed and length, and stays aligned with A.
  const Aa = clip(ids.Aa);
  check(speedState(Aa) === speedState(A) && Aa.startFrame === A.startFrame && end(Aa) === end(A), `${label}: linked audio has A's speed/curve (${clipFootprintFrames(Aa, FPS)} frames, ends with A)`);
  check(r.linked.length === 1 && r.linked[0].clipId === ids.Aa && r.linked[0].durationFrames === clipFootprintFrames(Aa, FPS), `${label}: result.linked = A's audio`);
  check(speedState(clip(ids.B)) === speedState(B0) && speedState(clip(ids.Ba)) === speedState(before.get(ids.Ba)!), `${label}: the later clips keep their own speed`);
  // Markers: "all" moves the ones at/after A's old end.
  const markers = t.engine.getProject().markers ?? [];
  const wantMarkers = markersBefore.map((m) => (ripple === "all" && m.frame >= oldEnd && delta !== 0 ? m.frame + delta : m.frame));
  check(JSON.stringify(markers.map((m) => m.frame)) === JSON.stringify(wantMarkers) && r.shiftedMarkers === (ripple === "all" && delta !== 0 ? 1 : 0), `${label}: markers ${JSON.stringify(markers.map((m) => m.frame))}`, `want ${JSON.stringify(wantMarkers)}`);
  if (ripple === "all" && delta !== 0) {
    check(r.notMoved.length === 1 && r.notMoved[0].clipId === ids.M, `${label}: the music bed straddles A's old end — left in place, listed in notMoved`, JSON.stringify(r.notMoved));
  } else {
    check(r.notMoved.length === 0, `${label}: notMoved empty`, JSON.stringify(r.notMoved));
  }
  t.engine.undo();
  check(t.state() === s0, `${label}: one undo restores every position, speed and marker`);
  return r;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "zabsreel-ripple-"));
  const media: Media = {
    coded: join(dir, "coded.mp4"),
    mic: join(dir, "mic.wav"),
    music: join(dir, "music.wav"),
    still: join(dir, "title.png"),
  };
  // 8 s / 240 frames: frame N encodes N in 8 stripes; audio = 440 Hz tone.
  await execa(FFMPEG_BIN, [
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", `color=c=gray:s=160x90:r=${FPS}:d=8,format=yuv420p,geq=lum='if(gt(mod(floor(N/pow(2,floor(X*8/W))),2),0),220,30)':cb=128:cr=128`,
    "-f", "lavfi", "-i", "sine=frequency=440:duration=8:sample_rate=48000",
    "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-g", "15", "-c:a", "aac", "-b:a", "128k", "-shortest", media.coded,
  ]);
  await execa(FFMPEG_BIN, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=9:sample_rate=48000", "-c:a", "pcm_s16le", media.mic]);
  await execa(FFMPEG_BIN, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=10:sample_rate=48000", "-c:a", "pcm_s16le", media.music]);
  await execa(FFMPEG_BIN, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=red:s=160x90", "-frames:v", "1", media.still]);

  try {
    // ---- every speed change, three layouts ------------------------------------
    for (const variant of ["butted", "gap", "dissolve"] as Variant[]) {
      console.log(`\n${variant}: V1 = A | B | C${variant === "gap" ? " (20-frame gap before C)" : variant === "dissolve" ? " (15-frame dissolve A→B)" : ""}`);
      const t = await build(dir, media, variant);
      const A = t.ids.A;
      if (variant === "dissolve") {
        check(end(t.clip(A)) - t.clip(t.ids.B).startFrame === 15, "dissolve: B overlaps A by 15 frames");
      }
      await rippleCase(t, "set_clip_speed 2x", () => t.call("set_clip_speed", { clipId: A, speed: 2 }), undefined);
      await rippleCase(t, "set_clip_speed 0.5x", () => t.call("set_clip_speed", { clipId: A, speed: 0.5 }), undefined);
      if (variant !== "butted") continue;
      for (const preset of RAMP_PRESETS) {
        await rippleCase(t, `set_speed_ramp ${preset}`, () => t.call("set_speed_ramp", { clipId: A, preset }), undefined);
      }
      // Ramp → clear_speed_ramp, and an audio-only ramp change (no length change → nothing moves).
      await t.call("set_speed_ramp", { clipId: A, preset: "montage" });
      await rippleCase(t, "clear_speed_ramp (from montage)", () => t.call("clear_speed_ramp", { clipId: A }), undefined);
      const audioOnly = await rippleCase(t, "audio-only ramp change", () => t.call("set_speed_ramp", { clipId: A, audio: "mute" }), undefined);
      check(audioOnly.deltaFrames === 0, "audio-only ramp change: delta 0");
      check(t.clip(A).effects?.speedRamp?.audio === undefined, "(undone) audio mode back to stretch");
      await t.call("set_speed_ramp", { clipId: A, audio: "mute" });
      check(t.clip(t.ids.Aa).effects?.speedRamp?.audio === "mute", "audio-only ramp change: the linked audio gets audio:'mute' too");
      t.engine.undo();
      t.engine.undo(); // the montage
      // clear_clip_effects drops the speed: ripples back and the linked audio returns to 1x.
      await t.call("set_clip_speed", { clipId: A, speed: 2 });
      await rippleCase(t, "clear_clip_effects (from 2x)", async () => {
        const r = await t.call<SpeedResult & { ok: boolean }>("clear_clip_effects", { clipId: A });
        const c = t.clip(A);
        return { ...r, durationFrames: clipFootprintFrames(c, FPS), previousDurationFrames: clipFootprintFrames(c, FPS) - r.deltaFrames };
      }, undefined);
      t.engine.undo();
      // ripple "all" and "none".
      await rippleCase(t, "set_clip_speed 2x, ripple all", () => t.call("set_clip_speed", { clipId: A, speed: 2, ripple: "all" }), "all");
      await rippleCase(t, "set_clip_speed 0.5x, ripple all", () => t.call("set_clip_speed", { clipId: A, speed: 0.5, ripple: "all" }), "all");
      await rippleCase(t, "set_speed_ramp bullet, ripple all", () => t.call("set_speed_ramp", { clipId: A, preset: "bullet", ripple: "all" }), "all");
      await rippleCase(t, "set_clip_speed 2x, ripple none", () => t.call("set_clip_speed", { clipId: A, speed: 2, ripple: "none" }), "none");
      await rippleCase(t, "set_speed_ramp montage, ripple none", () => t.call("set_speed_ramp", { clipId: A, preset: "montage", ripple: "none" }), "none");
      await t.call("set_speed_ramp", { clipId: A, preset: "montage" });
      await rippleCase(t, "clear_speed_ramp, ripple all", () => t.call("clear_speed_ramp", { clipId: A, ripple: "all" }), "all");
      t.engine.undo();
      // Change it from the AUDIO side: the picture follows.
      {
        const s0 = t.state();
        const r = await t.call<SpeedResult>("set_clip_speed", { clipId: t.ids.Aa, speed: 2 });
        check(r.linked.length === 1 && r.linked[0].clipId === A && t.clip(A).effects?.speed === 2 && t.clip(t.ids.B).startFrame === 45 && t.clip(t.ids.Ba).startFrame === 45, "set_clip_speed on the detached audio: the picture gets 2x and both tracks ripple");
        t.engine.undo();
        check(t.state() === s0, "…one undo restores it");
      }
    }

    // ---- refusal: a speed-up that leaves A no longer than its transition ---------
    console.log("\nrefusal: shorter than the transition");
    {
      const t = await build(dir, media, "dissolve");
      const s0 = t.state();
      const d0 = t.undoDepth();
      let err = "";
      try {
        // 90 frames at 10x = 9 frames: not longer than the 15-frame dissolve into B.
        await t.call("set_speed_ramp", { clipId: t.ids.A, points: [{ src: 0, speed: 10 }] });
      } catch (e) {
        err = String(e);
      }
      check(/transition/.test(err) && /9 frames/.test(err), "refused with a message naming the transition", err.slice(0, 160));
      check(t.state() === s0 && t.undoDepth() === d0, "the refusal changes nothing (no undo step)");
      const r = await t.call<SpeedResult>("set_clip_speed", { clipId: t.ids.A, speed: 4 }); // 23 frames > 15: fine
      check(r.deltaFrames === 23 - 90 && end(t.clip(t.ids.A)) - t.clip(t.ids.B).startFrame === 15, "4x (23 frames) is allowed and keeps the 15-frame overlap");
      const none = await t.call<SpeedResult>("set_speed_ramp", { clipId: t.ids.A, points: [{ src: 0, speed: 10 }], ripple: "none" });
      check(none.deltaFrames === 9 - 23 && none.shiftedClips === 0, "ripple none keeps the old in-place behaviour (not refused)");
    }

    // ---- linked members: freeze still + halves, another recording, a J-cut head ---------
    console.log("\nlinked members");
    {
      const t = await build(dir, media, "butted");
      const f = await t.call<{ stillClipId: string }>("freeze_frame", { clipId: t.ids.A, atSeconds: 1, durationSeconds: 0.5 });
      const v1 = t.engine.getProject().tracks.find((x) => x.index === t.v1)!.clips;
      const a1 = t.engine.getProject().tracks.find((x) => x.index === t.a1)!.clips;
      const left = v1[0];
      const right = v1[2];
      check(v1[1].id === f.stillClipId && left.startFrame === 0 && end(left) === 30 && right.startFrame === 45, `freeze: V1 = left [0,30) | still | right [45,…) (${v1.map((c) => `[${c.startFrame},${end(c)})`).join(" ")})`);
      const aLeft = a1[0];
      const aRight = a1[1];
      const before = new Map([...v1, ...a1].map((c) => [c.id, structuredClone(c)]));
      const r = await t.call<SpeedResult>("set_clip_speed", { clipId: left.id, speed: 2 });
      check(r.deltaFrames === -15 && r.linked.length === 1 && r.linked[0].clipId === aLeft.id, "left half 2x: only the left audio half is its partner", JSON.stringify(r.linked));
      const still = t.clip(f.stillClipId);
      const R = t.clip(right.id);
      check(speedState(still) === speedState(before.get(f.stillClipId)!) && speedState(R) === speedState(before.get(right.id)!) && speedState(t.clip(aRight.id)) === speedState(before.get(aRight.id)!), "the still and both right halves keep their speed");
      check(still.startFrame === 15 && R.startFrame === 30 && t.clip(aRight.id).startFrame === 30 && t.clip(t.ids.B).startFrame === before.get(t.ids.B)!.startFrame - 15 && t.clip(t.ids.Ba).startFrame === before.get(t.ids.Ba)!.startFrame - 15, "…and the still, the right halves and B all moved by −15 (picture and sound stay aligned)");
      check(t.clip(aLeft.id).effects?.speed === 2 && end(t.clip(aLeft.id)) === 15, "the left audio half is 2x and ends with the left picture half");
    }
    {
      // A separate mic recording (another asset) linked to A, synced 1 s later into its file.
      const t = await build(dir, media, "butted");
      const mic = await t.engine.importVideo(media.mic);
      t.engine.unlinkClip(t.ids.A);
      t.engine.removeClip(t.ids.Aa);
      const micClip = t.engine.addClip(mic.id, { trackIndex: t.a1, startFrame: 0, sourceInFrame: 31, sourceOutFrame: 121 });
      t.engine.linkClips([t.ids.A, micClip.id]);
      const r = await t.call<SpeedResult>("set_speed_ramp", { clipId: t.ids.A, preset: "montage" });
      const A = t.clip(t.ids.A);
      const m = t.clip(micClip.id);
      const shifted = A.effects!.speedRamp!.points.every((p, i) => Math.abs(m.effects!.speedRamp!.points[i].src - (p.src + 1)) < 1e-6 && m.effects!.speedRamp!.points[i].speed === p.speed);
      check(r.linked.length === 1 && r.linked[0].clipId === micClip.id && shifted, "a linked mic recording on another asset gets the curve moved by its +1 s sync offset");
      check(m.startFrame === 0 && Math.abs(end(m) - end(A)) <= 1 && t.clip(t.ids.Ba).startFrame === end(A), `…same length (${clipFootprintFrames(m, FPS)} vs ${clipFootprintFrames(A, FPS)}), later audio moved with the picture`);
      // A linked B-roll clip on another VIDEO track is not a partner: it keeps its speed.
      t.engine.undo();
      const broll = t.engine.addClip(t.coded.id, { trackIndex: t.v2, startFrame: 20, sourceInFrame: 200, sourceOutFrame: 230 });
      t.engine.linkClips([t.ids.A, micClip.id, broll.id]);
      const r2 = await t.call<SpeedResult>("set_clip_speed", { clipId: t.ids.A, speed: 2 });
      check(r2.linked.every((l) => l.clipId !== broll.id) && t.clip(broll.id).effects?.speed === undefined && t.clip(broll.id).startFrame === 20, "a linked B-roll clip on V2 (other footage) keeps its speed and place");
      check(t.clip(t.ids.T).startFrame === 100 - 45, "…but V2 holds a linked clip, so the title after A's old end moved with the ripple");
    }
    {
      // J-cut: A's audio starts 10 frames before the picture (same footage).
      const t = await build(dir, media, "butted");
      t.engine.unlinkClip(t.ids.A);
      t.engine.removeClip(t.ids.Aa);
      t.engine.moveClip(t.ids.A, 10);
      t.engine.trimClip(t.ids.A, 11, 91); // A [10,90) shows source 11..90
      const head = t.engine.addClip(t.coded.id, { trackIndex: t.a1, startFrame: 0, sourceInFrame: 1, sourceOutFrame: 91 }); // [0,90) = source 1..90
      t.engine.linkClips([t.ids.A, head.id]);
      await t.call("set_clip_speed", { clipId: t.ids.A, speed: 2 });
      const A = t.clip(t.ids.A);
      const h = t.clip(head.id);
      check(A.startFrame === 10 && end(A) === 50 && h.startFrame === 5 && end(h) === 50, `J-cut 2x: the audio head is re-anchored (starts at ${h.startFrame}, want 5) and ends with the picture (${end(h)} vs ${end(A)})`);
      t.engine.undo();
      await t.call("set_speed_ramp", { clipId: t.ids.A, preset: "hero" });
      const A2 = t.clip(t.ids.A);
      const h2 = t.clip(head.id);
      // Source frame 11 (the picture's first) plays at the same timeline frame in both.
      const at = (c: Clip, srcFrame: number) => c.startFrame + Math.round(((): number => {
        let lo = 0;
        while (lo < 400 && sourceFrameShownAt(c, lo, FPS) < srcFrame) lo++;
        return lo;
      })());
      check(Math.abs(at(h2, 11) - A2.startFrame) <= 1 && Math.abs(end(h2) - end(A2)) <= 1, `J-cut hero: source frame 11 plays at ${at(h2, 11)} in the audio and ${A2.startFrame} in the picture; ends ${end(h2)} / ${end(A2)}`);
    }

    // ---- later linked pairs, split edits, tracks held by a straddler ------------
    console.log("\nlater linked pairs, J-cut / L-cut, tracks held by a straddler");
    const fresh = async () => {
      const engine = new EditorEngine(dir);
      engine.setProjectSettings({ width: 160, height: 90, fps: FPS, name: "ripple-layouts" });
      const coded = await engine.importVideo(media.coded);
      const mic = await engine.importVideo(media.mic);
      const music = await engine.importVideo(media.music);
      const call = async <T = SpeedResult>(name: keyof typeof methods, params: Record<string, unknown> = {}): Promise<T> => {
        const m = methods[name];
        return (await m.handler(engine, (m.schema as { parse: (x: unknown) => unknown }).parse(params) as never)) as T;
      };
      const v1 = engine.getProject().tracks[0].index;
      const a1 = engine.addTrack("audio", { name: "A1" }).index;
      const add = (assetId: string, trackIndex: number, startFrame: number, sourceInFrame: number, sourceOutFrame: number) =>
        engine.addClip(assetId, { trackIndex, startFrame, sourceInFrame, sourceOutFrame }).id;
      const clip = (id: string): Clip => engine.getProject().tracks.flatMap((x) => x.clips).find((c) => c.id === id)!;
      const state = () => JSON.stringify({ tracks: engine.getProject().tracks, markers: engine.getProject().markers });
      const undoDepth = () => (engine as unknown as { undoStack: unknown[] }).undoStack.length;
      const refused = async (params: Record<string, unknown>, method: keyof typeof methods = "set_clip_speed"): Promise<string> => {
        const s0 = state();
        const d0 = undoDepth();
        try {
          await call(method, params);
          return "";
        } catch (e) {
          return state() === s0 && undoDepth() === d0 ? String(e) : `CHANGED STATE: ${String(e)}`;
        }
      };
      return { engine, call, coded: coded.id, mic: mic.id, music: music.id, v1, a1, add, clip, state, refused };
    };
    // A LATER clip's own linked mic on a track A's pair doesn't use moves with it (and what follows it there).
    for (const [ripple, speed, bmStart] of [["track", 2, 90], ["track", 0.5, 90], ["all", 2, 85]] as const) {
      const t = await fresh();
      const a2 = t.engine.addTrack("audio", { name: "A2" }).index;
      const A = t.add(t.coded, t.v1, 0, 1, 91);
      const B = t.add(t.coded, t.v1, 90, 100, 160);
      const Aa = t.add(t.coded, t.a1, 0, 1, 91);
      const Bm = t.add(t.mic, a2, bmStart, 100 - (90 - bmStart), 160);
      const Z = t.add(t.music, a2, 200, 0, 30);
      t.engine.linkClips([A, Aa]);
      t.engine.linkClips([B, Bm]);
      const r = await t.call("set_clip_speed", { clipId: A, speed, ripple });
      const d = r.deltaFrames;
      check(
        t.clip(B).startFrame === 90 + d && t.clip(Bm).startFrame === bmStart + d && t.clip(Z).startFrame === 200 + d && r.shiftedClips === 3 && r.notMoved.length === 0,
        `ripple ${ripple} ${speed}x: B's linked mic on A2 moved with B (${t.clip(B).startFrame - 90} / ${t.clip(Bm).startFrame - bmStart}, want ${d}), the clip after it too, nothing in notMoved`,
        JSON.stringify(r.notMoved),
      );
    }
    {
      // A linked pair split by the ripple point (one half before A, one after A's audio) is refused.
      const t = await fresh();
      const P0 = t.add(t.coded, t.v1, 0, 200, 230);
      const A = t.add(t.coded, t.v1, 30, 1, 91);
      const Aa = t.add(t.coded, t.a1, 30, 1, 91);
      const Xa = t.add(t.coded, t.a1, 120, 200, 230);
      t.engine.linkClips([A, Aa]);
      t.engine.linkClips([P0, Xa]);
      const err = await t.refused({ clipId: A, speed: 2 });
      check(/cannot move/.test(err) && err.includes(P0) && !err.startsWith("CHANGED"), "a linked pair that the ripple would split is refused and nothing changes", err.slice(0, 200));
      // B's mic would be pushed into a music bed that stays on its track: refused, not overlapped.
      const u = await fresh();
      const a2 = u.engine.addTrack("audio", { name: "A2" }).index;
      const A2 = u.add(u.coded, u.v1, 0, 1, 91);
      const B2 = u.add(u.coded, u.v1, 90, 100, 160);
      const W = u.add(u.music, a2, 0, 0, 90);
      const Bm = u.add(u.mic, a2, 90, 100, 160);
      u.engine.linkClips([B2, Bm]);
      const err2 = await u.refused({ clipId: A2, speed: 2 });
      check(/overlap/.test(err2) && err2.includes(W) && !err2.startsWith("CHANGED"), "a later mic that would run into a clip that stays is refused (no overlap, no desync)", err2.slice(0, 200));
      check((await u.call("set_clip_speed", { clipId: A2, speed: 0.5 })).deltaFrames === 90 && u.clip(Bm).startFrame === 180, "…slowing down moves it out (no collision)");
    }
    // L-cut tail (the audio runs 30 frames past the picture), changed from either side.
    for (const [side, speed] of [["picture", 0.5], ["picture", 2], ["audio", 0.5], ["audio", 2]] as const) {
      const t = await fresh();
      const A = t.add(t.coded, t.v1, 0, 1, 91);
      const B = t.add(t.coded, t.v1, 90, 100, 160);
      const Aa = t.add(t.coded, t.a1, 0, 1, 121);
      const Ba = t.add(t.coded, t.a1, 120, 130, 160);
      t.engine.linkClips([A, Aa]);
      t.engine.linkClips([B, Ba]);
      const s0 = t.state();
      const r = await t.call("set_clip_speed", { clipId: side === "picture" ? A : Aa, speed });
      const a = t.clip(A);
      const aa = t.clip(Aa);
      const b = t.clip(B);
      const ba = t.clip(Ba);
      const tail = speed < 1 ? { wasFrames: 30, nowFrames: 30, trimmedFrames: 30 } : { wasFrames: 30, nowFrames: 15, trimmedFrames: 0 };
      check(r.deltaFrames === (speed < 1 ? 90 : -45) && a.startFrame === 0 && b.startFrame === end(a), `L-cut, ${side} ${speed}x: the picture sets the distance (${r.deltaFrames}); V1 stays butted (A ends ${end(a)}, B at ${b.startFrame})`);
      check(ba.startFrame - b.startFrame === 30, `…B's audio stays in sync with B (${ba.startFrame - b.startFrame}, want 30)`);
      check(
        aa.startFrame === 0 && ba.startFrame - end(aa) === (speed < 1 ? 0 : 15) && aa.effects?.speed === speed,
        `…A's audio ${speed < 1 ? "tail is trimmed to end where B's audio starts" : "tail got shorter: a 15-frame silence"} (ends ${end(aa)}, B's audio at ${ba.startFrame})`,
      );
      const se = r.splitEdits.find((x) => x.clipId === Aa && x.side === "tail");
      check(r.splitEdits.length === 1 && !!se && se.wasFrames === tail.wasFrames && se.nowFrames === tail.nowFrames && se.trimmedFrames === tail.trimmedFrames, "…reported in splitEdits", JSON.stringify(r.splitEdits));
      t.engine.undo();
      check(t.state() === s0, "…one undo restores it");
    }
    // J-cut head + SLOW DOWN: the head would grow before frame 0 / into the clip before it.
    {
      const t = await fresh();
      const A = t.add(t.coded, t.v1, 10, 11, 91);
      const B = t.add(t.coded, t.v1, 90, 100, 160);
      const head = t.add(t.coded, t.a1, 0, 1, 91);
      const Ba = t.add(t.coded, t.a1, 90, 100, 160);
      t.engine.linkClips([A, head]);
      t.engine.linkClips([B, Ba]);
      const r = await t.call("set_clip_speed", { clipId: A, speed: 0.5 });
      const a = t.clip(A);
      const h = t.clip(head);
      check(
        h.startFrame === 0 && h.sourceInFrame + (a.startFrame - h.startFrame) * 0.5 === a.sourceInFrame && end(h) === end(a) && t.clip(Ba).startFrame === end(h),
        `J-cut 0.5x at frame 0: the head is trimmed to start at 0 (src ${h.sourceInFrame}), still in sync with the picture, ends with it; B's audio butted`,
        `head [${h.startFrame},${end(h)}) src ${h.sourceInFrame}`,
      );
      check(r.splitEdits.length === 1 && r.splitEdits[0].side === "head" && r.splitEdits[0].trimmedFrames === 10 && r.splitEdits[0].nowFrames === 10, "…reported in splitEdits (10 frames trimmed)", JSON.stringify(r.splitEdits));
      const u = await fresh();
      const P = u.add(u.coded, u.v1, 0, 200, 230);
      const A2 = u.add(u.coded, u.v1, 30, 11, 91);
      const Pa = u.add(u.coded, u.a1, 0, 200, 220);
      const head2 = u.add(u.coded, u.a1, 20, 1, 91);
      u.engine.linkClips([P, Pa]);
      u.engine.linkClips([A2, head2]);
      await u.call("set_clip_speed", { clipId: A2, speed: 0.5 });
      const h2 = u.clip(head2);
      const a2 = u.clip(A2);
      check(
        h2.startFrame === 20 && end(u.clip(Pa)) <= h2.startFrame && h2.sourceInFrame + (a2.startFrame - h2.startFrame) * 0.5 === a2.sourceInFrame && end(h2) === end(a2),
        `J-cut 0.5x after another audio clip: the head stops where it ends (starts ${h2.startFrame}, no overlap) and stays in sync`,
      );
    }
    // Tracks that ripple from the old end: a straddler holds what is joined to it.
    {
      const t = await fresh();
      const v2 = t.engine.addTrack("video", { name: "V2" }).index;
      const a2 = t.engine.addTrack("audio", { name: "A2" }).index;
      const A = t.add(t.coded, t.v1, 0, 1, 91);
      t.add(t.coded, t.v1, 90, 100, 160);
      const X = t.add(t.coded, v2, 60, 160, 220);
      const Y = t.add(t.coded, v2, 120, 190, 250);
      t.engine.setTransition(Y, "dissolve", 10); // Y → [110,170)
      const M1 = t.add(t.music, a2, 0, 0, 120);
      const M2 = t.add(t.music, a2, 120, 120, 200);
      const M3 = t.add(t.music, a2, 260, 0, 30);
      for (const speed of [0.5, 2]) {
        const before = new Map([X, Y, M1, M2, M3].map((id) => [id, t.clip(id).startFrame]));
        const r = await t.call("set_clip_speed", { clipId: A, speed, ripple: "all" });
        const reasons = Object.fromEntries(r.notMoved.map((n) => [n.clipId, n.reason]));
        check(
          [X, Y, M1, M2].every((id) => t.clip(id).startFrame === before.get(id)) && reasons[X] === "straddles" && reasons[Y] === "transition" && reasons[M1] === "straddles" && reasons[M2] === "butted",
          `ripple all ${speed}x: X and the clip entering it through a transition stay; the music straddling the old end and the music butted to it stay (notMoved ${JSON.stringify(r.notMoved.map((n) => n.reason))})`,
        );
        check(t.clip(M3).startFrame === 260 + r.deltaFrames, `…the music after a gap still moves (${t.clip(M3).startFrame})`);
        t.engine.undo();
      }
      // A linked cutaway from the SAME footage on V2 is not a speed partner (it keeps its speed and place).
      const R = t.add(t.coded, v2, 10, 0, 30);
      t.engine.linkClips([A, R]);
      const r = await t.call("set_clip_speed", { clipId: A, speed: 0.5 });
      check(r.linked.length === 0 && t.clip(R).effects?.speed === undefined && t.clip(R).startFrame === 10 && t.clip(X).startFrame === 60 && t.clip(Y).startFrame === 110, "a linked same-footage cutaway on V2 keeps its speed and place; V2 (linked) holds X and Y", JSON.stringify(r.linked));
      t.engine.undo();
      // …but a same-footage copy showing the same frame at the same moment (a blurred background) follows.
      const v3 = t.engine.addTrack("video", { name: "V3" }).index;
      const Dup = t.add(t.coded, v3, 0, 1, 91);
      t.engine.linkClips([A, R, Dup]);
      const r2 = await t.call("set_clip_speed", { clipId: A, speed: 2, ripple: "none" });
      check(r2.linked.length === 1 && r2.linked[0].clipId === Dup && t.clip(Dup).effects?.speed === 2 && t.clip(R).effects?.speed === undefined, "a same-moment copy on V3 (a blurred-background duplicate) gets the speed; the cutaway does not", JSON.stringify(r2.linked));
    }
    {
      // freeze_frame: a later clip's own linked mic moves with it too.
      const t = await fresh();
      const a2 = t.engine.addTrack("audio", { name: "A2" }).index;
      const A = t.add(t.coded, t.v1, 0, 1, 91);
      const B = t.add(t.coded, t.v1, 90, 100, 160);
      const Bm = t.add(t.mic, a2, 90, 100, 160);
      t.engine.linkClips([B, Bm]);
      await t.call("freeze_frame", { clipId: A, atSeconds: 1, durationSeconds: 0.5 });
      check(t.clip(B).startFrame === 105 && t.clip(Bm).startFrame === 105, `freeze_frame: B and its linked mic on A2 both move by the still (${t.clip(B).startFrame} / ${t.clip(Bm).startFrame})`);
    }

    // ---- smooth_slow_motion / reverse_clip keep the length --------------------
    console.log("\nsmooth slow motion and reverse keep the length");
    {
      const t = await build(dir, media, "butted");
      await t.call("set_clip_speed", { clipId: t.ids.A, speed: 0.5 });
      const s1 = JSON.stringify(t.engine.getProject().tracks.map((x) => x.clips.map((c) => [c.id, c.startFrame, clipFootprintFrames(c, FPS)])));
      await t.call("smooth_slow_motion", { clipId: t.ids.A, mode: "blend" });
      const s2 = JSON.stringify(t.engine.getProject().tracks.map((x) => x.clips.map((c) => [c.id, c.startFrame, clipFootprintFrames(c, FPS)])));
      check(s1 === s2 && t.clip(t.ids.A).effects?.speed === undefined, "smooth_slow_motion: same length, nothing moved again (the bake is already slow)");
      t.engine.undo();
      t.engine.undo();
      await t.call("set_speed_ramp", { clipId: t.ids.A, preset: "montage" });
      const r1 = JSON.stringify(t.engine.getProject().tracks.map((x) => x.clips.map((c) => [c.id, c.startFrame])));
      const len = clipFootprintFrames(t.clip(t.ids.A), FPS);
      await t.call("reverse_clip", { clipId: t.ids.A, audio: "mute" });
      const r2 = JSON.stringify(t.engine.getProject().tracks.map((x) => x.clips.map((c) => [c.id, c.startFrame])));
      check(r1 === r2 && clipFootprintFrames(t.clip(t.ids.A), FPS) === len, "reverse_clip on a ramped clip: same length exactly, nothing moved");
    }

    // ---- export: the edit stays seamless ------------------------------------------
    console.log("\nexport");
    {
      const t = await build(dir, media, "butted");
      t.engine.setTrackProperties(t.v2, { hidden: true }); // the title would cover the stripes
      await t.call("set_speed_ramp", { clipId: t.ids.A, preset: "montage" });
      const A = t.clip(t.ids.A);
      const D = clipFootprintFrames(A, FPS);
      const out = join(dir, "montage.mp4");
      await t.engine.exportVideo(out);
      const idx = await frameIndexes(out);
      const gapRegion = idx.slice(D, 90);
      check(D < 90 && idx.length === D + 120, `montage: A is ${D} frames (was 90), export is ${idx.length} frames (A + B + C)`);
      check(gapRegion.length === 90 - D && gapRegion.every((v, i) => v === 100 + i), `montage: frames ${D}..89 (the old gap) show B's footage ${gapRegion[0]}..${gapRegion[gapRegion.length - 1]}, not black`, JSON.stringify(gapRegion));
      check(!idx.includes(0), "montage: no black frame anywhere");
      check(idx[D + 60] === 170, `montage: C follows B (frame ${D + 60} = ${idx[D + 60]})`);
      t.engine.undo();
      await t.call("set_speed_ramp", { clipId: t.ids.A, preset: "bullet" });
      const A2 = t.clip(t.ids.A);
      const D2 = clipFootprintFrames(A2, FPS);
      check(D2 > 90 && t.clip(t.ids.B).startFrame === D2 && t.clip(t.ids.Ba).startFrame === D2, `bullet: A is ${D2} frames (was 90) and B starts where A ends (${t.clip(t.ids.B).startFrame}) — no overlap`);
      const out2 = join(dir, "bullet.mp4");
      await t.engine.exportVideo(out2);
      const idx2 = await frameIndexes(out2);
      check(idx2.length === D2 + 120 && idx2[D2 - 1] === sourceFrameShownAt(A2, D2 - 1, FPS) && idx2[D2] === 100 && idx2[D2 + 59] === 159, `bullet: A plays to its end (frame ${D2 - 1} = ${idx2[D2 - 1]}), then B from its first frame (${idx2[D2]})`);
    }

    await lCutTailSync(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall ripple checks passed");
  process.exit(failures ? 1 : 0);
}

/**
 * A13: an L-cut tail stays in sync BY EAR after a speed change. The sound is a
 * chirp whose pitch is its source time (f = 300 + 100·t Hz), the picture
 * encodes its source frame: at a timeline moment under the picture the pitch
 * must say the source moment the picture shows; in the tail the sound goes on
 * from there; the next audio clip is never played over.
 */
async function lCutTailSync(dir: string): Promise<void> {
  console.log("\nL-cut tail by ear (picture frame vs chirp pitch)");
  const src = join(dir, "chirp.mp4");
  await execa(FFMPEG_BIN, [
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", `color=c=gray:s=160x90:r=${FPS}:d=10,format=yuv420p,geq=lum='if(gt(mod(floor(N/pow(2,floor(X*8/W))),2),0),220,30)':cb=128:cr=128`,
    "-f", "lavfi", "-i", "aevalsrc='0.5*sin(2*PI*(300*t+50*t*t))':s=48000:d=10",
    "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-g", "15", "-c:a", "pcm_s16le", src.replace(".mp4", ".mov"),
  ]);
  const media = src.replace(".mp4", ".mov");
  const pcm = async (file: string): Promise<Float32Array> => {
    const { stdout } = await execa(FFMPEG_BIN, ["-hide_banner", "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { encoding: "buffer", maxBuffer: 1 << 29 });
    const b = Buffer.from(stdout as unknown as Uint8Array);
    const out = new Float32Array(Math.floor(b.length / 4));
    for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4);
    return out;
  };
  /** Source seconds the chirp says at timeline second t (its pitch over ±12 ms, from interpolated zero crossings), or NaN when silent. */
  const heard = (a: Float32Array, t: number): number => {
    const i0 = Math.max(1, Math.round((t - 0.012) * 48000));
    const i1 = Math.min(a.length, Math.round((t + 0.012) * 48000));
    const xs: number[] = [];
    let e = 0;
    for (let i = i0; i < i1; i++) {
      e += a[i] * a[i];
      if (a[i - 1] < 0 !== a[i] < 0) xs.push(i - 1 + a[i - 1] / (a[i - 1] - a[i]));
    }
    if (e / Math.max(1, i1 - i0) < 1e-4 || xs.length < 3) return NaN;
    const hz = (xs.length - 1) / 2 / ((xs[xs.length - 1] - xs[0]) / 48000);
    return (hz - 300) / 100;
  };
  for (const op of [{ speed: 0.5 }, { speed: 2 }, { preset: "bullet" }, { preset: "montage" }] as const) {
    const engine = new EditorEngine(dir);
    engine.setProjectSettings({ width: 160, height: 90, fps: FPS, name: "lcut" });
    const asset = await engine.importVideo(media);
    const call = async <T,>(name: keyof typeof methods, params: Record<string, unknown>): Promise<T> => {
      const m = methods[name];
      return (await m.handler(engine, (m.schema as { parse: (x: unknown) => unknown }).parse(params) as never)) as T;
    };
    const v1 = engine.getProject().tracks[0].index;
    const a1 = engine.addTrack("audio", { name: "A1" }).index;
    const A = engine.addClip(asset.id, { trackIndex: v1, startFrame: 0, sourceInFrame: 30, sourceOutFrame: 120 });
    const B = engine.addClip(asset.id, { trackIndex: v1, startFrame: 90, sourceInFrame: 180, sourceOutFrame: 240 });
    const Aa = engine.addClip(asset.id, { trackIndex: a1, startFrame: 0, sourceInFrame: 30, sourceOutFrame: 150 }); // 30-frame L-cut tail
    const Ba = engine.addClip(asset.id, { trackIndex: a1, startFrame: 120, sourceInFrame: 210, sourceOutFrame: 240 });
    engine.setClipEffects(A.id, { volume: 0 });
    engine.setClipEffects(B.id, { volume: 0 });
    engine.linkClips([A.id, Aa.id]);
    engine.linkClips([B.id, Ba.id]);
    const label = "speed" in op ? `${op.speed}x` : op.preset;
    if ("speed" in op) await call("set_clip_speed", { clipId: A.id, speed: op.speed });
    else await call("set_speed_ramp", { clipId: A.id, preset: op.preset });
    const clip = (id: string) => engine.getProject().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
    const a = clip(A.id);
    const aa = clip(Aa.id);
    const ba = clip(Ba.id);
    const b = clip(B.id);
    const out = join(dir, `lcut-${label}.mp4`);
    await engine.exportVideo(out);
    const idx = await frameIndexes(out);
    const snd = await pcm(out);
    // Under the picture: the picture shows exactly the frames of the shared frame model, and the sound plays the
    // same curve — its pitch says the source moment the curve reaches there. (A ramp's stretched sound is made of
    // constant-tempo chunks joined by 8 ms crossfades, where two pitches overlap: the median of seven nearby
    // measurements steps over a join.)
    const map = clipTimeMap(a, FPS);
    const sync = (m: ReturnType<typeof clipTimeMap>, t0: number, t: number): number => {
      const d = [-0.06, -0.04, -0.02, 0, 0.02, 0.04, 0.06].map((o) => heard(snd, t + o) - m.sourceAt(t + o - t0)).filter(Number.isFinite).sort((x, y) => x - y);
      return d.length ? d[d.length >> 1] : NaN;
    };
    let off = 0;
    let picOff = 0;
    let worst = 0;
    const endA = end(a);
    for (let n = 0; n < endA; n++) if (idx[n] !== sourceFrameShownAt(a, n, FPS)) picOff++;
    for (let k = 1; k <= 12; k++) {
      const t = (endA * k) / 13 / FPS;
      const d = Math.abs(sync(map, 0, t));
      worst = Math.max(worst, d);
      // Within the source span one picture frame covers there (half a source frame, or half the frames a fast
      // part skips per timeline frame), plus 10 ms of measuring slack.
      if (!(d <= Math.max(0.5, map.speedAt(map.sourceAt(t)) / 2) / FPS + 0.01)) off++;
    }
    // The tail goes on from the picture's last moment (the curve's end speed); B's audio starts on its own moment.
    const tailSync = sync(clipTimeMap(aa, FPS), aa.startFrame / FPS, (endA + Math.min(8, (end(aa) - endA) / 2)) / FPS);
    const bSync = sync(clipTimeMap(ba, FPS), ba.startFrame / FPS, (ba.startFrame + 10) / FPS);
    const noOverlap = end(aa) <= ba.startFrame;
    check(
      off === 0 && picOff === 0 && Math.abs(tailSync) <= 0.025 && noOverlap && Math.abs(bSync) <= 0.025 && b.startFrame === endA && ba.startFrame - b.startFrame === 30,
      `L-cut, ${label} on the picture: picture on the frame model, the sound under it on the same curve (worst ${(worst * 1000).toFixed(0)} ms), the tail goes on from there (${(tailSync * 1000).toFixed(0)} ms), it ends at ${end(aa)} <= B's audio at ${ba.startFrame}, which plays its own moment (${(bSync * 1000).toFixed(0)} ms)`,
      `${off} moments off, ${picOff} picture frames off`,
    );
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
