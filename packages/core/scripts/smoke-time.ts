/**
 * Time-effects smoke test (no downloads): freeze_frame, reverse_clip,
 * smooth_slow_motion. Synthesizes media whose frames encode their own index
 * (eight black/white stripes = the bits of N, robust to lossy coding) and whose
 * audio is a rising chirp (200 Hz + 300 Hz/s), then checks by DECODING:
 *   - freeze: timeline grows by the freeze length, the still is the exact frame
 *     (incl. under speed 0.5), later clips and the linked audio clip move
 *     together (audio chirp lines up with the picture after the freeze, silence
 *     under it), first/last-frame freezes leave no empty halves, one undo step;
 *   - reverse: baked frame N == source frame (len-1-N) for every N across a
 *     multi-chunk span, exact frame count, chirp direction flips, a second call
 *     restores the original (also after a trim), mute drops the audio, cancel
 *     leaves no files, undo restores;
 *   - smooth slow motion at speed 0.5 (blend + optical-flow): timeline duration
 *     unchanged, baked frame count == the clip's footprint, NO duplicated
 *     consecutive frames — not even at the very end (known issue A9; unlike
 *     plain speed 0.5, measured as the control) — on a span inside the file
 *     every other baked frame IS the source frame and 0.25x keeps its count,
 *     pitch preserved, refuses at speed 1, cancel leaves no files, undo restores;
 *   - freeze_frame ripple modes (A11): 'all' also moves other tracks' later
 *     clips and the markers, refuses to break a transition; 'none' overwrites
 *     the clip (nothing moves, the timeline keeps its length, linked audio is
 *     silent under the still);
 *   - linked clips (A10): reverse_clip reverses the detached audio with its
 *     picture (one bake shared, chirp runs backwards in sync, a J-cut head
 *     becomes an L-cut tail, a collision is refused before baking,
 *     linked:false keeps the old behaviour, calling it again restores both,
 *     one undo step); smooth_slow_motion re-points the plain detached audio at
 *     the bake, and a J/L-cut partner keeps its speed RATIO through later
 *     speed changes (a ramp on such a pair is refused).
 *
 * Run: npx tsx packages/core/scripts/smoke-time.ts
 */
import { execa } from "execa";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { EditorEngine } from "../src/engine.js";
import { methods } from "../src/rpc.js";
import { FFMPEG_BIN, FFPROBE_BIN } from "../src/ffmpeg/executor.js";
import { reverseChunkFrames } from "../src/ffmpeg/timefx.js";
import type { Clip } from "../src/types.js";

const FPS = 30;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  console.log(`  ok  ${msg}`);
}

/** Decode a video (or image) to the frame index each frame encodes (-1 if unreadable). */
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

async function frameCount(file: string): Promise<number> {
  const { stdout } = await execa(FFPROBE_BIN, ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file]);
  return Number(stdout.trim());
}

/** Mono f32 samples [t0,t1) of a file's audio at 48 kHz. */
async function audioSamples(file: string, t0: number, t1: number): Promise<Float32Array> {
  const { stdout } = await execa(
    FFMPEG_BIN,
    ["-hide_banner", "-v", "error", "-ss", t0.toFixed(3), "-t", (t1 - t0).toFixed(3), "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
    { encoding: "buffer", maxBuffer: 1 << 29 },
  );
  const b = Buffer.from(stdout as unknown as Uint8Array);
  const out = new Float32Array(Math.floor(b.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4);
  return out;
}
/** Zero-crossing frequency estimate (Hz) of the audio in [t0,t1). */
async function freqAt(file: string, t0: number, t1: number): Promise<number> {
  const s = await audioSamples(file, t0, t1);
  let z = 0;
  for (let i = 1; i < s.length; i++) if (s[i - 1] < 0 !== s[i] < 0) z++;
  return s.length ? z / 2 / (s.length / 48000) : 0;
}
async function rmsAt(file: string, t0: number, t1: number): Promise<number> {
  const s = await audioSamples(file, t0, t1);
  let e = 0;
  for (const v of s) e += v * v;
  return s.length ? Math.sqrt(e / s.length) : 0;
}
/** Mean absolute difference (0..255) between consecutive gray frames. */
async function consecutiveDiffs(file: string, w: number, h: number): Promise<number[]> {
  const { stdout } = await execa(FFMPEG_BIN, ["-hide_banner", "-v", "error", "-i", file, "-vf", `scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"], {
    encoding: "buffer",
    maxBuffer: 1 << 29,
  });
  const b = Buffer.from(stdout as unknown as Uint8Array);
  const fs = w * h;
  const n = Math.floor(b.length / fs);
  const d: number[] = [];
  for (let k = 1; k < n; k++) {
    let sum = 0;
    for (let i = 0; i < fs; i++) sum += Math.abs(b[k * fs + i] - b[(k - 1) * fs + i]);
    d.push(sum / fs);
  }
  return d;
}

const clipEnd = (c: Clip) => c.startFrame + Math.round((c.sourceOutFrame - c.sourceInFrame) / (c.effects?.speed ?? 1));

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "synthcut-time-"));
  // 4 s / 120 frames: frame N encodes N in chroma; audio = rising chirp 200 -> 1400 Hz.
  const src = join(dir, "coded.mp4");
  await execa(FFMPEG_BIN, [
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", `color=c=gray:s=160x90:r=${FPS}:d=4,format=yuv420p,geq=lum='if(gt(mod(floor(N/pow(2,floor(X*8/W))),2),0),220,30)':cb=128:cr=128`,
    "-f", "lavfi", "-i", "aevalsrc='sin(2*PI*(200*t+150*t*t))*0.5:s=48000:d=4'",
    "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-g", "15", "-c:a", "aac", "-b:a", "192k", "-shortest", src,
  ]);
  // Moving content (+ a 440 Hz tone) for the interpolation tests.
  const moving = join(dir, "moving.mp4");
  await execa(FFMPEG_BIN, [
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", `testsrc2=s=320x180:r=${FPS}:d=3`,
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=48000",
    "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", moving,
  ]);

  const engine = new EditorEngine(dir);
  engine.setProjectSettings({ width: 160, height: 90, fps: FPS, name: "time-smoke" });
  const coded = await engine.importVideo(src);
  const mov = await engine.importVideo(moving);

  const call = async <T = unknown>(name: keyof typeof methods, params: Record<string, unknown> = {}): Promise<T> => {
    const m = methods[name];
    const parsed = (m.schema as { parse: (x: unknown) => unknown }).parse(params);
    return (await m.handler(engine, parsed as never)) as T;
  };
  const tracks = () => engine.getProject().tracks;
  const allClips = () => tracks().flatMap((t) => t.clips);
  const cur = (id: string): Clip => allClips().find((c) => c.id === id)!;
  const snapshot = () => JSON.stringify({ tracks: tracks(), assets: engine.getProject().assets.map((a) => a.id) });
  const bakedFiles = () => (existsSync(join(dir, "baked")) ? readdirSync(join(dir, "baked")) : []);
  const exportNow = async (name: string): Promise<string> => {
    const out = join(dir, name);
    await engine.exportVideo(out);
    return out;
  };

  // ======================= FREEZE FRAME =====================================
  console.log("freeze_frame");
  {
    const v1Clips_ = () => tracks().find((t) => t.kind === "video")!.clips;
    const a1 = engine.addTrack("audio");
    const clip = engine.addClip(coded.id, { startFrame: 0 }); // [0,120)
    const tail = engine.addClip(coded.id, { startFrame: 120, sourceInFrame: 0, sourceOutFrame: 30 }); // [120,150)
    const aud = engine.addClip(coded.id, { trackIndex: a1.index, startFrame: 0 });
    const aTail = engine.addClip(coded.id, { trackIndex: a1.index, startFrame: 120, sourceInFrame: 0, sourceOutFrame: 30 });
    engine.setClipEffects(clip.id, { volume: 0, opacity: 0.99 }); // the picture's own audio is silent; the linked clip carries sound
    engine.setClipEffects(tail.id, { volume: 0 });
    engine.linkClips([clip.id, aud.id]);
    engine.linkClips([tail.id, aTail.id]);
    const dur0 = engine.timelineDurationFrames();
    const snap0 = snapshot();
    const rev0 = engine.getProject().revision;
    const undo0 = (engine as unknown as { undoStack: unknown[] }).undoStack.length;

    const r = await call<{ stillClipId: string; assetId: string; startFrame: number; durationFrames: number }>("freeze_frame", {
      clipId: clip.id,
      atSeconds: 1.0,
      durationSeconds: 2,
    });
    assert((engine as unknown as { undoStack: unknown[] }).undoStack.length === undo0 + 1, "freeze is ONE undo step");
    assert(engine.timelineDurationFrames() === dur0 + 60, `timeline grew by exactly the freeze (${dur0} -> ${engine.timelineDurationFrames()})`);
    const still = cur(r.stillClipId);
    const stillAsset = engine.getProject().assets.find((a) => a.id === r.assetId)!;
    assert(stillAsset.isImage === true && !stillAsset.hasAudio, "the still is an image asset without audio");
    assert(still.startFrame === 30 && still.sourceOutFrame - still.sourceInFrame === 60, "still sits at frame 30, 60 frames long");
    assert(still.effects?.opacity === 0.99 && still.effects?.volume === undefined, "still inherits opacity, drops volume");
    const vClips = v1Clips_().map((c) => [c.startFrame, c.startFrame + (c.sourceOutFrame - c.sourceInFrame)]);
    assert(JSON.stringify(vClips) === JSON.stringify([[0, 30], [30, 90], [90, 180], [180, 210]]), `V1 = left | still | right | tail rippled (${JSON.stringify(vClips)})`);
    const aClips = tracks().find((t) => t.id === a1.id)!.clips.map((c) => [c.startFrame, c.startFrame + (c.sourceOutFrame - c.sourceInFrame)]);
    assert(JSON.stringify(aClips) === JSON.stringify([[0, 30], [90, 180], [180, 210]]), `linked audio split + gapped under the freeze (${JSON.stringify(aClips)})`);

    const stillIdx = (await frameIndexes(stillAsset.path))[0];
    assert(stillIdx === 30, `still image is source frame 30 (decoded ${stillIdx})`);

    const out = await exportNow("freeze.mp4");
    const idx = await frameIndexes(out);
    assert(idx.length === dur0 + 60, `export has ${dur0 + 60} frames (got ${idx.length})`);
    assert(idx[29] === 29 && idx[30] === 30 && idx[89] === 30 && idx[90] === 30 && idx[91] === 31, `picture: ...29 | 30 held x60 | 30,31... (${idx[29]},${idx[30]},${idx[89]},${idx[90]},${idx[91]})`);
    assert(idx[179] === 119 && idx[180] === 0, "later clip moved right (frame 180 = tail clip frame 0)");
    // Audio alignment: before the freeze 0.5-0.7 s (src 0.5-0.7 -> ~380 Hz), silent under it,
    // after it export 3.0-3.2 s is source 1.0-1.2 s (~530 Hz), unchanged from where picture frame 30 continues.
    const fPre = await freqAt(out, 0.5, 0.7);
    const rFreeze = await rmsAt(out, 1.2, 2.8);
    const fPost = await freqAt(out, 3.0, 3.2);
    assert(Math.abs(fPre - 380) < 25, `audio before the freeze plays source 0.5-0.7 s (~${fPre.toFixed(0)} Hz, want 380)`);
    assert(rFreeze < 0.01, `audio is silent under the still (rms ${rFreeze.toFixed(4)})`);
    assert(Math.abs(fPost - 530) < 25, `audio after the freeze continues at source 1.0 s, aligned with the picture (~${fPost.toFixed(0)} Hz, want 530)`);

    assert(engine.undo(), "undo");
    assert(snapshot() === snap0 && engine.timelineDurationFrames() === dur0, "undo restores clips, assets and duration exactly");
    assert(engine.getProject().revision > rev0, "revision moved");

    // first frame: still goes BEFORE the clip, no empty halves
    const f0 = await call<{ stillClipId: string; startFrame: number }>("freeze_frame", { clipId: clip.id, atSeconds: 0, durationSeconds: 1 });
    const v1Clips = v1Clips_().map((c) => [c.startFrame, c.sourceOutFrame - c.sourceInFrame]);
    assert(JSON.stringify(v1Clips) === JSON.stringify([[0, 30], [30, 120], [150, 30]]), `freeze at 0 = still + whole clip rippled, no empty half (${JSON.stringify(v1Clips)})`);
    const a0 = tracks().find((t) => t.id === a1.id)!.clips.map((c) => c.startFrame);
    assert(JSON.stringify(a0) === JSON.stringify([30, 150]), `linked audio moved with it (${JSON.stringify(a0)})`);
    assert(cur(f0.stillClipId).startFrame === 0, "still at frame 0");
    engine.undo();

    // last frame (and past the end): holds frame 119, one-frame tail kept
    const fL = await call<{ stillClipId: string; assetId: string }>("freeze_frame", { clipId: clip.id, atSeconds: 99, durationSeconds: 1 });
    const lc = v1Clips_().map((c) => [c.startFrame, c.sourceOutFrame - c.sourceInFrame]);
    assert(JSON.stringify(lc) === JSON.stringify([[0, 119], [119, 30], [149, 1], [150, 30]]), `freeze at the end = left | still | 1-frame tail (${JSON.stringify(lc)})`);
    const lastAsset = engine.getProject().assets.find((a) => a.id === fL.assetId)!;
    assert((await frameIndexes(lastAsset.path))[0] === 119, "last-frame still is frame 119");
    engine.undo();

    // speed 0.5: timeline second 1.0 is source frame 15 of the span
    engine.setClipEffects(clip.id, { speed: 0.5 });
    const fS = await call<{ assetId: string; durationFrames: number }>("freeze_frame", { clipId: clip.id, atSeconds: 1.0, durationSeconds: 1 });
    const sAsset = engine.getProject().assets.find((a) => a.id === fS.assetId)!;
    assert((await frameIndexes(sAsset.path))[0] === 15, "freeze under speed 0.5 grabs the frame actually shown (source frame 15)");
    engine.undo();
    engine.undo(); // speed
    // clean slate for later sections
    while (allClips().length) engine.removeClip(allClips()[0].id);

    // ---- freeze under slow motion: odd playhead frame, and the last frame must stay inside the trim ----
    {
      const slow = engine.addClip(coded.id, { startFrame: 0 }); // 120 source frames
      engine.setClipEffects(slow.id, { speed: 0.5 }); // 240 timeline frames
      const plainIdx = await frameIndexes(await exportNow("slow-plain.mp4"));
      assert(plainIdx.length === 240 && plainIdx[31] === 15, `control: plain 0.5x shows source 15 at timeline frame 31 (${plainIdx[31]})`);
      const dur0 = engine.timelineDurationFrames();
      const snapS = snapshot();

      const fo = await call<{ stillClipId: string; assetId: string; heldClipFrame: number }>("freeze_frame", { clipId: slow.id, atSeconds: 31 / FPS, durationSeconds: 1 });
      const oAsset = engine.getProject().assets.find((a) => a.id === fo.assetId)!;
      assert((await frameIndexes(oAsset.path))[0] === 15, "0.5x freeze at an ODD frame (31) holds the frame shown there (source 15)");
      const oc = tracks().find((t) => t.kind === "video")!.clips.map((c) => [c.startFrame, clipEnd(c)]);
      assert(oc.length === 3 && oc[0][1] === oc[1][0] && oc[1][1] === oc[2][0], `halves tile with no overlap or gap (${JSON.stringify(oc)})`);
      assert(engine.timelineDurationFrames() === dur0 + 30, "timeline grew by exactly the freeze");
      const oIdx = await frameIndexes(await exportNow("slow-odd.mp4"));
      assert(oIdx.length === 270, `export has 270 frames (got ${oIdx.length})`);
      assert(oIdx[29] === 14 && oIdx[30] === 15 && oIdx[59] === 15 && oIdx[60] === 15 && oIdx[61] === 15 && oIdx[62] === 16, `picture: 14 | 15 held | 15,15,16 (${[29, 30, 59, 60, 61, 62].map((i) => oIdx[i])})`);
      engine.undo();
      assert(snapshot() === snapS, "undo restores the slowed clip");

      for (const [spd, srcLen] of [[0.5, 120], [0.25, 120]] as const) {
        engine.setClipEffects(slow.id, { speed: spd });
        const total = Math.round(srcLen / spd);
        const dBefore = engine.timelineDurationFrames();
        const fl = await call<{ stillClipId: string; assetId: string }>("freeze_frame", { clipId: slow.id, atSeconds: 99, durationSeconds: 1 });
        const lAsset = engine.getProject().assets.find((a) => a.id === fl.assetId)!;
        assert((await frameIndexes(lAsset.path))[0] === srcLen - 1, `${spd}x end freeze holds the last IN-TRIM frame ${srcLen - 1}, not the frame past the out-point`);
        const lc = tracks().find((t) => t.kind === "video")!.clips;
        const tailC = lc[lc.length - 1];
        assert(lc.length === 3 && tailC.sourceOutFrame - tailC.sourceInFrame >= 1 && tailC.sourceOutFrame <= srcLen, `${spd}x tail keeps >= 1 source frame (in ${tailC.sourceInFrame}, out ${tailC.sourceOutFrame})`);
        assert(clipEnd(lc[0]) === lc[1].startFrame && clipEnd(lc[1]) === lc[2].startFrame && engine.timelineDurationFrames() === dBefore + 30, `${spd}x halves tile exactly, total ${dBefore} -> ${engine.timelineDurationFrames()}`);
        const lIdx = await frameIndexes(await exportNow(`slow-end-${spd}.mp4`));
        assert(lIdx.length === total + 30, `${spd}x export length ${total + 30} (got ${lIdx.length})`);
        assert(lIdx.slice(lc[2].startFrame).every((v) => v >= srcLen - 2), `${spd}x tail frames are the last source frame (no black flash): ${lIdx.slice(lc[2].startFrame)} (tail at ${lc[2].startFrame}, ${lc[2].sourceInFrame}..${lc[2].sourceOutFrame})`);
        engine.undo();
      }
      engine.undo(); // 0.25x speed
      engine.undo(); // 0.5x speed
      while (allClips().length) engine.removeClip(allClips()[0].id);
    }

    // ---- freeze next to an incoming transition ----
    {
      const A = engine.addClip(coded.id, { startFrame: 0 }); // [0,120)
      const B = engine.addClip(coded.id, { startFrame: 120, sourceInFrame: 0, sourceOutFrame: 60 });
      engine.setTransition(B.id, "fade", 15); // B [105,165)
      const snapT = snapshot();
      let refused = "";
      try {
        await call("freeze_frame", { clipId: A.id, atSeconds: 99, durationSeconds: 2 });
      } catch (e) {
        refused = (e as Error).message;
      }
      assert(/transition/.test(refused) && snapshot() === snapT, `freeze inside the transition overlap is refused, project untouched (${refused.slice(0, 60)}...)`);
      await call("freeze_frame", { clipId: A.id, atSeconds: 50 / FPS, durationSeconds: 2 });
      const v = tracks().find((t) => t.kind === "video")!.clips;
      const bNow = v.find((c) => c.id === B.id)!;
      const right = v[v.length - 2];
      assert(bNow.startFrame === 105 + 60 && bNow.transition?.durationFrames === 15 && clipEnd(right) - bNow.startFrame === 15, `incoming clip rippled with its overlap kept (B at ${bNow.startFrame}, overlap ${clipEnd(right) - bNow.startFrame})`);
      engine.undo();
      while (allClips().length) engine.removeClip(allClips()[0].id);
    }

    // ---- freezing the detached audio clip freezes the linked PICTURE ----
    {
      const V = engine.addClip(coded.id, { startFrame: 0 });
      const Au = engine.addClip(coded.id, { trackIndex: a1.index, startFrame: 0 });
      engine.linkClips([V.id, Au.id]);
      await call("freeze_frame", { clipId: Au.id, atSeconds: 1, durationSeconds: 1 });
      const vv = tracks().find((t) => t.kind === "video")!.clips.map((c) => [c.startFrame, clipEnd(c)]);
      const aa = tracks().find((t) => t.id === a1.id)!.clips;
      assert(JSON.stringify(vv) === JSON.stringify([[0, 30], [30, 60], [60, 150]]), `the still went on the VIDEO track, no hole (${JSON.stringify(vv)})`);
      assert(aa.every((c) => engine.getProject().assets.find((x) => x.id === c.assetId)!.isImage !== true) && aa.length === 2, "no image on the audio track");
      engine.undo();
      let msg = "";
      const lone = engine.addClip(coded.id, { trackIndex: a1.index, startFrame: 400 });
      try {
        await call("freeze_frame", { clipId: lone.id, atSeconds: 0, durationSeconds: 1 });
      } catch (e) {
        msg = (e as Error).message;
      }
      assert(/audio track/.test(msg), "an unlinked audio-track clip is refused with a clear error");
      while (allClips().length) engine.removeClip(allClips()[0].id);
    }
  }

  // ======================= REVERSE ==========================================
  console.log("reverse_clip");
  {
    const clip = engine.addClip(coded.id, { startFrame: 0, sourceInFrame: 10, sourceOutFrame: 110 }); // 100 frames, 2 chunks
    const assetsBefore = engine.getProject().assets.length;
    const snap0 = snapshot();
    const t0 = Date.now();
    const r = await call<{ clipId: string; assetId: string; restored: boolean }>("reverse_clip", { clipId: clip.id });
    console.log(`     (reverse of 100 frames took ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    const baked = engine.getProject().assets.find((a) => a.id === r.assetId)!;
    assert(!r.restored && baked.reversedFrom?.assetId === coded.id && baked.reversedFrom.sourceInFrame === 10 && baked.reversedFrom.sourceOutFrame === 110, "baked asset records reversedFrom");
    const c1 = cur(clip.id);
    assert(c1.assetId === baked.id && c1.sourceInFrame === 0 && c1.sourceOutFrame === 100, "clip re-pointed at the bake, same length");
    assert((await frameCount(baked.path)) === 100, `baked frame count == span (${await frameCount(baked.path)})`);
    const idx = await frameIndexes(baked.path);
    let exact = idx.length === 100;
    for (let i = 0; i < idx.length; i++) if (idx[i] !== 109 - i) exact = false;
    assert(exact, `frame N of the output == source frame (109-N) for all 100 frames, across the 2 s chunk boundary (first ${idx.slice(0, 3)}, at 60: ${idx.slice(59, 62)})`);
    const early = await freqAt(baked.path, 0.1, 0.3); // = source ~3.5 s -> ~1250 Hz
    const late = await freqAt(baked.path, 2.9, 3.1); // = source ~0.5 s -> ~350 Hz
    assert(early > late + 400, `chirp direction flipped: ${early.toFixed(0)} Hz early, ${late.toFixed(0)} Hz late`);
    assert(Math.abs(baked.duration - 100 / FPS) < 0.05, `baked duration ${baked.duration.toFixed(3)} s`);

    // timeline export agrees
    const out = await exportNow("reverse.mp4");
    const eidx = await frameIndexes(out);
    assert(eidx.length === 100 && eidx[0] === 109 && eidx[99] === 10, "exported timeline plays reversed (109 .. 10)");

    // second call restores
    const r2 = await call<{ restored: boolean }>("reverse_clip", { clipId: clip.id });
    const c2 = cur(clip.id);
    assert(r2.restored && c2.assetId === coded.id && c2.sourceInFrame === 10 && c2.sourceOutFrame === 110, "second reverse restores original asset/in/out");
    assert(engine.getProject().assets.length === assetsBefore + 1, "restoring bakes nothing");

    // trim the reversed copy, then un-reverse maps the trim back
    await call("reverse_clip", { clipId: clip.id });
    engine.trimClip(clip.id, 20, 80);
    await call("reverse_clip", { clipId: clip.id });
    const c3 = cur(clip.id);
    assert(c3.assetId === coded.id && c3.sourceInFrame === 30 && c3.sourceOutFrame === 90, `un-reverse after trimming 20..80 -> original 30..90 (got ${c3.sourceInFrame}..${c3.sourceOutFrame})`);

    // mute
    const rm = await call<{ assetId: string }>("reverse_clip", { clipId: clip.id, audio: "mute" });
    const mAsset = engine.getProject().assets.find((a) => a.id === rm.assetId)!;
    assert(!mAsset.hasAudio && (await frameCount(mAsset.path)) === 60, "audio:'mute' bakes a silent reversed copy (60 frames)");
    engine.undo();

    // undo of a reverse
    const before = snapshot();
    await call("reverse_clip", { clipId: clip.id });
    engine.undo();
    assert(snapshot() === before, "undo restores the pre-reverse clip");

    // cancel mid-flight leaves nothing behind
    const files0 = bakedFiles().join(",");
    const { job, promise } = engine.startReverseJob(clip.id);
    engine.jobs.cancel(job!.id);
    let canceled = false;
    await promise.catch(() => (canceled = true));
    assert(canceled && bakedFiles().join(",") === files0, "cancel -> job rejects, no partial/scratch files remain");
    assert(snapshot() === before, "cancel leaves the project untouched");

    // ---- A/V sync when the audio stream is longer than the video ----
    while (allClips().length) engine.removeClip(allClips()[0].id);
    {
      const skew = join(dir, "skew.mp4"); // video 3.0 s (90 frames), audio 3.5 s -> a 105-frame span
      await execa(FFMPEG_BIN, [
        "-hide_banner", "-y",
        "-f", "lavfi", "-i", `color=c=gray:s=160x90:r=${FPS}:d=3,format=yuv420p,geq=lum='if(gt(mod(floor(N/pow(2,floor(X*8/W))),2),0),220,30)':cb=128:cr=128`,
        "-f", "lavfi", "-i", "aevalsrc='sin(2*PI*(200*t+150*t*t))*0.5:s=48000:d=3.5'",
        "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-g", "15", "-c:a", "aac", "-b:a", "192k", skew,
      ]);
      const sa = await engine.importVideo(skew);
      const sc = engine.addClip(sa.id, { startFrame: 0 });
      const spanLen = sc.sourceOutFrame - sc.sourceInFrame;
      const rr = await call<{ assetId: string }>("reverse_clip", { clipId: sc.id });
      const rb = engine.getProject().assets.find((a) => a.id === rr.assetId)!;
      const ri = await frameIndexes(rb.path);
      // The missing video frames (3.0-3.5 s) must land FIRST (held on the last real frame), so the rest lines up with the mirrored audio.
      assert(ri.length === spanLen && spanLen >= 104, `reversed copy has the whole ${spanLen}-frame span (got ${ri.length})`);
      assert(ri[0] === 89 && ri[14] === 89 && ri[20] === spanLen - 1 - 20 && ri[60] === spanLen - 1 - 60, `picture stays on the audio's timeline: 89 held | then ${spanLen - 1}-N (idx[20]=${ri[20]}, want ${spanLen - 21})`);
      while (allClips().length) engine.removeClip(allClips()[0].id);
    }

    // ---- RAM budget sizing, and transparency kept ----
    {
      assert(reverseChunkFrames(30, { width: 1920, height: 1080, pixFmt: "yuv420p" }) === 60, "1080p30 chunk = 2 s (60 frames)");
      const k4 = reverseChunkFrames(60, { width: 3840, height: 2160, pixFmt: "yuv420p" });
      assert(k4 >= 8 && k4 <= 24, `4K60 chunk shrinks to a frame budget (${k4} frames, not 120)`);
      assert(reverseChunkFrames(60, { width: 3840, height: 2160, pixFmt: "yuv422p10le" }) < k4, "10-bit 4:2:2 gets a smaller chunk than 8-bit 4:2:0");

      const cut = join(dir, "cutout.mkv"); // left half transparent
      await execa(FFMPEG_BIN, [
        "-hide_banner", "-y",
        "-f", "lavfi", "-i", `color=c=gray:s=160x90:r=${FPS}:d=2,format=yuva420p,geq=lum='if(gt(mod(floor(N/pow(2,floor(X*8/W))),2),0),220,30)':cb=128:cr=128:a='if(lt(X,W/2),0,255)'`,
        "-c:v", "ffv1", "-pix_fmt", "yuva420p", cut,
      ]);
      const ca = await engine.importVideo(cut);
      const alphaOf = async (f: string): Promise<[number, number]> => {
        const { stdout } = await execa(FFMPEG_BIN, ["-hide_banner", "-v", "error", "-i", f, "-vf", "alphaextract,format=gray", "-frames:v", "1", "-f", "rawvideo", "-"], { encoding: "buffer" });
        const b = Buffer.from(stdout as unknown as Uint8Array);
        return [b[45 * 160 + 20], b[45 * 160 + 140]];
      };
      const pix = async (f: string) => (await execa(FFPROBE_BIN, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", f])).stdout.trim();
      const cc = engine.addClip(ca.id, { startFrame: 0 });
      const cr = await call<{ assetId: string }>("reverse_clip", { clipId: cc.id });
      const cb = engine.getProject().assets.find((a) => a.id === cr.assetId)!;
      const [l, r] = await alphaOf(cb.path);
      assert(/^yuva/.test(await pix(cb.path)) && l === 0 && r === 255, `reverse keeps the cutout's alpha (${await pix(cb.path)}, left ${l}, right ${r})`);
      assert((await frameCount(cb.path)) === 60, "alpha reverse bake has every frame");
      await call("reverse_clip", { clipId: cc.id }); // restore
      engine.setClipEffects(cc.id, { speed: 0.5 });
      for (const mode of ["blend", "optical-flow"] as const) {
        const sr = await call<{ assetId: string }>("smooth_slow_motion", { clipId: cc.id, mode });
        const sb = engine.getProject().assets.find((a) => a.id === sr.assetId)!;
        const [sl, sright] = await alphaOf(sb.path);
        assert(/^yuva/.test(await pix(sb.path)) && sl === 0 && sright === 255, `smooth slow motion (${mode}) keeps the cutout's alpha (left ${sl}, right ${sright})`);
        engine.undo();
      }
      while (allClips().length) engine.removeClip(allClips()[0].id);
    }

    // ---- un-reverse after a project fps change ----
    {
      const rc = engine.addClip(coded.id, { startFrame: 0, sourceInFrame: 10, sourceOutFrame: 110 });
      await call("reverse_clip", { clipId: rc.id });
      engine.setProjectSettings({ fps: 60 });
      await call("reverse_clip", { clipId: rc.id });
      const back = cur(rc.id);
      assert(back.assetId === coded.id && back.sourceInFrame === 20 && back.sourceOutFrame === 220, `un-reverse after 30 -> 60 fps restores the same span (${back.sourceInFrame}..${back.sourceOutFrame}, want 20..220)`);
      engine.setProjectSettings({ fps: FPS });
      while (allClips().length) engine.removeClip(allClips()[0].id);
    }

    void snap0;
  }

  // ======================= SMOOTH SLOW MOTION ===============================
  console.log("smooth_slow_motion");
  {
    const clip = engine.addClip(mov.id, { startFrame: 0 }); // 90 frames
    try {
      await call("smooth_slow_motion", { clipId: clip.id });
      assert(false, "should refuse at speed 1");
    } catch (e) {
      assert(/speed < 1|slowed clips/.test((e as Error).message), `refuses at speed 1: ${(e as Error).message.slice(0, 70)}...`);
    }
    engine.setClipEffects(clip.id, { speed: 0.5 });
    const dur0 = engine.timelineDurationFrames();
    assert(dur0 === 180, "speed 0.5 -> 180 timeline frames");
    // control: plain speed 0.5 duplicates frames
    const ctrl = await consecutiveDiffs(await exportNow("plain.mp4"), 160, 90);
    const dupCtrl = ctrl.filter((d) => d < 0.05).length;
    assert(dupCtrl >= 60, `control: plain 0.5x repeats frames (${dupCtrl} of ${ctrl.length} consecutive pairs identical)`);

    for (const mode of ["blend", "optical-flow"] as const) {
      const snap0 = snapshot();
      const t0 = Date.now();
      const r = await call<{ clipId: string; assetId: string; frames: number }>("smooth_slow_motion", { clipId: clip.id, mode });
      const secs = (Date.now() - t0) / 1000;
      console.log(`     (${mode}: 3 s of 320x180 -> 6 s took ${secs.toFixed(1)}s)`);
      const c = cur(clip.id);
      const baked = engine.getProject().assets.find((a) => a.id === r.assetId)!;
      assert(c.assetId === baked.id && c.effects?.speed === undefined, `${mode}: re-pointed with speed reset`);
      assert(engine.timelineDurationFrames() === dur0, `${mode}: timeline duration unchanged (${dur0})`);
      const n = await frameCount(baked.path);
      assert(n === 180, `${mode}: baked has 180 frames = 2x the 90-frame span (got ${n})`);
      const d = await consecutiveDiffs(baked.path, 160, 90);
      const dupAt = d.map((x, i) => (x < 0.05 ? i : -1)).filter((i) => i >= 0);
      // Not even at the end: the span ends the file, so its frames are spread to land the last source frame last.
      assert(dupAt.length === 0, `${mode}: no duplicated consecutive frames anywhere, not even at the end (repeats at ${JSON.stringify(dupAt)} of ${d.length}; plain 0.5x has ${dupCtrl})`);
      const hz = await freqAt(baked.path, 1.0, 2.0);
      assert(Math.abs(hz - 440) < 15 && baked.duration > 5.9 && baked.duration < 6.15, `${mode}: audio slowed to 6 s with pitch preserved (${hz.toFixed(0)} Hz, ${baked.duration.toFixed(2)} s)`);
      const out = await exportNow(`smooth-${mode}.mp4`);
      assert((await frameCount(out)) === 180, `${mode}: export is 180 frames`);
      engine.undo();
      assert(snapshot() === snap0 && cur(clip.id).effects?.speed === 0.5, `${mode}: undo restores original clip + speed 0.5`);
    }

    // cancel
    const files0 = bakedFiles().join(",");
    const { job, promise } = engine.startSmoothSlowJob(clip.id, "optical-flow");
    setTimeout(() => engine.jobs.cancel(job.id), 300);
    let canceled = false;
    await promise.catch(() => (canceled = true));
    assert(canceled && bakedFiles().join(",") === files0, "cancel -> no partial slow-mo file remains");
    assert(cur(clip.id).effects?.speed === 0.5, "cancel leaves the clip alone");
  }

  // ======================= SMOOTH SLOW MOTION inside the file (A9) ==========
  console.log("smooth_slow_motion on a span inside the file");
  {
    while (allClips().length) engine.removeClip(allClips()[0].id);
    for (const speed of [0.5, 0.25]) {
      for (const mode of ["blend", "optical-flow"] as const) {
        const clip = engine.addClip(mov.id, { startFrame: 0, sourceInFrame: 15, sourceOutFrame: 60 }); // ends 1 s before the file
        engine.setClipEffects(clip.id, { speed });
        const want = Math.round(45 / speed);
        const r = await call<{ assetId: string }>("smooth_slow_motion", { clipId: clip.id, mode });
        const baked = engine.getProject().assets.find((a) => a.id === r.assetId)!;
        const n = await frameCount(baked.path);
        const d = await consecutiveDiffs(baked.path, 160, 90);
        const dupAt = d.map((x, i) => (x < 0.05 ? i : -1)).filter((i) => i >= 0);
        let srcOff = 0;
        if (mode === "blend") {
          // Every 1/speed-th baked frame is a real source frame (blend = exact at the source times).
          const step = Math.round(1 / speed);
          const gray = async (f: string, ss: number) => {
            const { stdout } = await execa(FFMPEG_BIN, ["-hide_banner", "-v", "error", "-ss", ss.toFixed(4), "-i", f, "-frames:v", "1", "-vf", "scale=160:90,format=gray", "-f", "rawvideo", "-"], { encoding: "buffer" });
            return Buffer.from(stdout as unknown as Uint8Array);
          };
          for (const k of [0, 11, 29, 44]) {
            const a = await gray(baked.path, (k * step + 0.5) / FPS);
            const b = await gray(mov.path, (15 + k + 0.5) / FPS);
            let sum = 0;
            for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
            if (sum / a.length > 3) srcOff++;
          }
        }
        assert(n === want && dupAt.length === 0 && srcOff === 0, `${speed}x ${mode}: ${n} frames (footprint ${want}), no repeated frame${mode === "blend" ? ", every " + Math.round(1 / speed) + "th frame is the source frame" : ""} (repeats at ${JSON.stringify(dupAt)}, ${srcOff} source frames off)`);
        engine.undo();
        engine.removeClip(clip.id);
      }
    }
  }

  // ======================= FREEZE FRAME ripple modes (A11) ===================
  console.log("freeze_frame ripple modes");
  {
    while (allClips().length) engine.removeClip(allClips()[0].id);
    for (const t of tracks().filter((t) => t.clips.length === 0 && t.index !== tracks()[0].index)) engine.removeTrack(t.index);
    const v1 = tracks().find((t) => t.kind === "video")!;
    const a1 = engine.addTrack("audio");
    const v2 = engine.addTrack("video", { name: "V2" });
    const x = engine.addClip(coded.id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: 120, trackIndex: v1.index });
    const tail = engine.addClip(coded.id, { startFrame: 120, sourceInFrame: 0, sourceOutFrame: 30, trackIndex: v1.index });
    const ax = engine.addClip(coded.id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: 120, trackIndex: a1.index });
    engine.setClipEffects(x.id, { volume: 0 });
    engine.linkClips([x.id, ax.id]);
    const o1 = engine.addClip(coded.id, { startFrame: 20, sourceInFrame: 0, sourceOutFrame: 20, trackIndex: v2.index }); // straddles frame 30
    const o2 = engine.addClip(coded.id, { startFrame: 50, sourceInFrame: 0, sourceOutFrame: 30, trackIndex: v2.index }); // after it
    engine.setMarkers([10, 100]);
    const len0 = engine.timelineDurationFrames();

    const r = await call<{ durationFrames: number; shiftedClips: number; shiftedMarkers: number }>("freeze_frame", { clipId: x.id, atSeconds: 1, durationSeconds: 2, ripple: "all" });
    assert(cur(tail.id).startFrame === 180 && cur(o1.id).startFrame === 20 && cur(o2.id).startFrame === 110, `ripple 'all': the tail (180) and the later V2 clip (110) move, the V2 clip straddling the freeze point stays (20)`);
    assert(JSON.stringify(engine.getProject().markers!.map((m) => m.frame)) === "[10,160]" && r.shiftedMarkers === 1, "ripple 'all': the marker after the freeze point moves (100 -> 160), the one before stays");
    engine.undo();
    await call("freeze_frame", { clipId: x.id, atSeconds: 1, durationSeconds: 2 });
    assert(cur(o2.id).startFrame === 50 && JSON.stringify(engine.getProject().markers!.map((m) => m.frame)) === "[10,100]", "ripple 'track' (default): other tracks and markers stay, as before");
    engine.undo();

    // 'all' refuses to break a transition into a clip that would move away from one that stays.
    const o3 = engine.addClip(coded.id, { startFrame: 35, sourceInFrame: 40, sourceOutFrame: 50, trackIndex: v2.index });
    engine.setTransition(o3.id, "fade", 4);
    const snap = snapshot();
    let err = "";
    try {
      await call("freeze_frame", { clipId: x.id, atSeconds: 1, durationSeconds: 2, ripple: "all" });
    } catch (e) {
      err = (e as Error).message;
    }
    assert(/transition/.test(err) && snapshot() === snap, `ripple 'all' that would break a transition on another track is refused, nothing changes (${err.slice(0, 80)}...)`);
    for (const c of [o1, o2, o3]) engine.removeClip(c.id); // V2 sits above V1: keep the export showing V1

    // 'none': the still overwrites the clip; nothing moves; linked audio is silent under it.
    const rn = await call<{ stillClipId: string; durationFrames: number; shiftedClips: number }>("freeze_frame", { clipId: x.id, atSeconds: 1, durationSeconds: 0.5, ripple: "none" });
    const v1c = tracks().find((t) => t.id === v1.id)!.clips.map((c) => [c.startFrame, c.startFrame + (c.sourceOutFrame - c.sourceInFrame), c.sourceInFrame]);
    const a1c = tracks().find((t) => t.id === a1.id)!.clips.map((c) => [c.startFrame, c.startFrame + (c.sourceOutFrame - c.sourceInFrame), c.sourceInFrame]);
    assert(rn.durationFrames === 15 && rn.shiftedClips === 0 && engine.timelineDurationFrames() === len0, `ripple 'none': a 15-frame still, nothing shifted, the timeline keeps its length (${engine.timelineDurationFrames()} = ${len0})`);
    assert(JSON.stringify(v1c) === "[[0,30,0],[30,45,0],[45,120,45],[120,150,0]]", `ripple 'none': V1 = left | still | the clip resumes on source 45 at frame 45 | tail unmoved (${JSON.stringify(v1c)})`);
    assert(JSON.stringify(a1c) === "[[0,30,0],[45,120,45]]", `ripple 'none': the linked audio is silent under the still and stays in sync (${JSON.stringify(a1c)})`);
    const out = await exportNow("freeze-none.mp4");
    const idx = await frameIndexes(out);
    assert(idx.length === len0 && idx[29] === 29 && idx[30] === 30 && idx[44] === 30 && idx[45] === 45 && idx[119] === 119 && idx[120] === 0, `export: ...29 | 30 held x15 | 45...119 | tail (${idx[29]},${idx[30]},${idx[44]},${idx[45]},${idx[119]},${idx[120]})`);
    engine.undo();
    const rEnd = await call<{ durationFrames: number }>("freeze_frame", { clipId: x.id, atSeconds: 100 / FPS, durationSeconds: 2, ripple: "none" });
    assert(rEnd.durationFrames === 20 && cur(tail.id).startFrame === 120, `ripple 'none' near the end: the still stops at the clip's end (${rEnd.durationFrames} of 60 frames), the tail stays`);
    engine.undo();
    while (allClips().length) engine.removeClip(allClips()[0].id);
    engine.setMarkers([]);
    engine.removeTrack(v2.index);
    engine.removeTrack(a1.index);
  }

  // ======================= LINKED clips: reverse + smooth slow motion (A10) ====
  console.log("linked clips: reverse_clip and smooth_slow_motion");
  {
    while (allClips().length) engine.removeClip(allClips()[0].id);
    const v1 = tracks().find((t) => t.kind === "video")!;
    const a1 = engine.addTrack("audio");
    const pic = engine.addClip(coded.id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: 120, trackIndex: v1.index });
    const snd = engine.addClip(coded.id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: 120, trackIndex: a1.index });
    engine.setClipEffects(pic.id, { volume: 0 });
    engine.linkClips([pic.id, snd.id]);
    const undo0 = (engine as unknown as { undoStack: unknown[] }).undoStack.length;
    const r = await call<{ assetId: string; linked: { clipId: string; assetId: string; startFrame: number }[] }>("reverse_clip", { clipId: pic.id });
    assert((engine as unknown as { undoStack: unknown[] }).undoStack.length === undo0 + 1, "reverse of a linked pair is ONE undo step");
    assert(r.linked.length === 1 && r.linked[0].clipId === snd.id && cur(snd.id).assetId === r.assetId && cur(snd.id).startFrame === 0, "the detached audio is reversed too — sharing the picture's bake, in place");
    const out = await exportNow("rev-linked.mp4");
    const idx = await frameIndexes(out);
    const f1 = await freqAt(out, 0.4, 0.6); // = source 3.5 s reversed -> ~1250 Hz
    const f2 = await freqAt(out, 3.4, 3.6); // = source 0.5 s -> ~350 Hz
    assert(idx[0] === 119 && idx[60] === 59 && Math.abs(f1 - 1250) < 60 && Math.abs(f2 - 350) < 60, `picture and sound run backwards together (frame 0 = ${idx[0]}, 60 = ${idx[60]}; ${f1.toFixed(0)} Hz at 0.5 s, ${f2.toFixed(0)} Hz at 3.5 s)`);
    const back = await call<{ restored: boolean; linked: { restored: boolean }[] }>("reverse_clip", { clipId: pic.id });
    assert(back.restored && back.linked.length === 1 && back.linked[0].restored && cur(pic.id).assetId === coded.id && cur(snd.id).assetId === coded.id, "calling it again restores both (no bake)");
    const only = await call<{ linked: unknown[] }>("reverse_clip", { clipId: pic.id, linked: false });
    assert(only.linked.length === 0 && cur(snd.id).assetId === coded.id, "linked:false reverses only the picture (the old behaviour)");
    engine.undo();
    // Called on the detached audio: the picture is reversed with it.
    const fromSnd = await call<{ linked: { clipId: string }[] }>("reverse_clip", { clipId: snd.id });
    assert(fromSnd.linked.some((l) => l.clipId === pic.id) && cur(pic.id).assetId !== coded.id, "reverse_clip on the detached audio reverses its picture too");
    engine.undo();
    assert(cur(pic.id).assetId === coded.id && cur(snd.id).assetId === coded.id, "undo restores both");

    // A J-cut head becomes an L-cut tail.
    engine.removeClip(pic.id);
    const p2 = engine.addClip(coded.id, { startFrame: 30, sourceInFrame: 30, sourceOutFrame: 120, trackIndex: v1.index });
    const s2 = engine.addClip(coded.id, { startFrame: 20, sourceInFrame: 20, sourceOutFrame: 120, trackIndex: a1.index });
    engine.setClipEffects(p2.id, { volume: 0 });
    engine.linkClips([p2.id, s2.id]);
    const blocker = engine.addClip(coded.id, { startFrame: 125, sourceInFrame: 0, sourceOutFrame: 10, trackIndex: a1.index });
    const files0 = bakedFiles().length;
    let err = "";
    try {
      await call("reverse_clip", { clipId: p2.id });
    } catch (e) {
      err = (e as Error).message;
    }
    assert(/J\/L cut/.test(err) && bakedFiles().length === files0, `a reversed J-cut that would run into the next audio clip is refused before baking (${err.slice(0, 70)}...)`);
    engine.removeClip(blocker.id);
    await call("reverse_clip", { clipId: p2.id });
    assert(cur(s2.id).startFrame === 30 && cur(s2.id).startFrame + (cur(s2.id).sourceOutFrame - cur(s2.id).sourceInFrame) === 130, `its 10-frame J-cut head is now a 10-frame L-cut tail (audio ${cur(s2.id).startFrame}..130, picture 30..120)`);
    const jout = await exportNow("rev-jcut.mp4");
    const jidx = await frameIndexes(jout);
    // At timeline frame t the picture shows source 149 - t; the sound plays source 150 - t: 2.0 s -> source 3.0 s -> 1100 Hz.
    const jf = await freqAt(jout, 1.9, 2.1);
    assert(jidx[60] === 89 && Math.abs(jf - 1100) < 60, `reversed J/L pair stays in sync (frame 60 = ${jidx[60]}, ${jf.toFixed(0)} Hz at 2 s, want 1100)`);
    engine.undo();

    // Smooth slow motion: the plain detached audio moves onto the bake; a J/L partner keeps its speed ratio.
    while (allClips().length) engine.removeClip(allClips()[0].id);
    const p3 = engine.addClip(mov.id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: 60, trackIndex: v1.index });
    const s3 = engine.addClip(mov.id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: 60, trackIndex: a1.index });
    engine.setClipEffects(p3.id, { volume: 0 });
    engine.linkClips([p3.id, s3.id]);
    await call("set_clip_speed", { clipId: p3.id, speed: 0.5 });
    const sm = await call<{ assetId: string; linked: string[] }>("smooth_slow_motion", { clipId: p3.id, mode: "blend" });
    assert(sm.linked.includes(s3.id) && cur(s3.id).assetId === sm.assetId && cur(s3.id).effects?.speed === undefined, "smooth_slow_motion re-points the plain detached audio at the bake (its slowed sound), speed 1");
    const sp = await call<{ linked: { clipId: string; durationFrames: number }[]; durationFrames: number }>("set_clip_speed", { clipId: p3.id, speed: 2 });
    assert(cur(s3.id).effects?.speed === 2 && sp.linked[0]?.durationFrames === sp.durationFrames, "a later speed change keeps picture and sound together");
    while (allClips().length) engine.removeClip(allClips()[0].id);
    const p4 = engine.addClip(mov.id, { startFrame: 20, sourceInFrame: 10, sourceOutFrame: 60, trackIndex: v1.index });
    const s4 = engine.addClip(mov.id, { startFrame: 10, sourceInFrame: 5, sourceOutFrame: 60, trackIndex: a1.index }); // 5 source frames of J-cut head
    engine.linkClips([p4.id, s4.id]);
    await call("set_clip_speed", { clipId: p4.id, speed: 0.5 });
    const before4 = { p: cur(p4.id).startFrame, s: cur(s4.id).startFrame };
    await call("smooth_slow_motion", { clipId: p4.id, mode: "blend" });
    assert(cur(s4.id).assetId === mov.id && cur(s4.id).effects?.speed === 0.5 && cur(p4.id).startFrame === before4.p && cur(s4.id).startFrame === before4.s, "a J-cut partner keeps its speed (0.5x) and place — still in sync");
    await call("set_clip_speed", { clipId: p4.id, speed: 2 });
    const P = cur(p4.id);
    const S = cur(s4.id);
    // In sync: at the picture's first frame the sound plays the picture's first source frame (10).
    console.log(`     (after 2x: picture ${JSON.stringify([P.startFrame, P.sourceInFrame, P.sourceOutFrame, P.effects?.speed])}, sound ${JSON.stringify([S.startFrame, S.sourceInFrame, S.sourceOutFrame, S.effects?.speed])})`);
    assert(S.effects?.speed === undefined && S.sourceInFrame + (P.startFrame - S.startFrame) * 1 === 10, `the speed RATIO is kept: picture 2x of the 0.5x bake = 1x, sound 1x (sound source at the picture's start = ${S.sourceInFrame + (P.startFrame - S.startFrame)})`);
    err = "";
    try {
      await call("set_speed_ramp", { clipId: p4.id, preset: "montage" });
    } catch (e) {
      err = (e as Error).message;
    }
    assert(/ratio/.test(err), `a speed ramp can't keep the ratio: refused (${err.slice(0, 80)}...)`);
    while (allClips().length) engine.removeClip(allClips()[0].id);
    engine.removeTrack(a1.index);
  }

  console.log("\nsmoke-time: ALL OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
