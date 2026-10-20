/**
 * Cut rounding smoke test (no downloads) — split_clip, cut_range,
 * ripple_delete_ranges and freeze_frame on CONSTANT-speed clips, checked by
 * decoding synthesized media whose frames encode their own index (9 stripes =
 * the bits of N):
 *
 *  1. Splits (known issue A6): at every split point at 0.25x … 4x the halves
 *     butt, and the right half ends where the clip did (halves' footprints add
 *     up); at 1x, 2x, 3x and 4x every split lands exactly where asked, on
 *     source in + round(local × speed), as always.
 *  2. cut_range on a grid at each speed: the pieces butt and the next clip
 *     closes up exactly. A one-frame head or tail left by a cut stays (known
 *     issue A7: it used to vanish and leave a one-frame gap); a side too short
 *     to hold a source frame (0.25x) goes with the cut — no gap either way.
 *  3. ripple_delete_ranges over two tracks at 0.25x / 0.75x: both lose the same
 *     frames, the pieces stay butted on both.
 *  4. Exports: slowed / odd-speed clips split into pieces and spread one black
 *     frame apart show exactly each piece's footprint (a frame too many would
 *     cover the gap), every frame the source frame speed.ts
 *     sourceFrameShownAt predicts.
 *  5. freeze_frame at constant speeds (known issue A4) holds exactly the frame
 *     the export shows — also at 0.75x / 3x / 4x, and on a 29.97 fps source on a
 *     1/30000 timebase, whose odd tick step makes FFmpeg break exact
 *     half-frame ties (2x, 4x) the other way.
 *  6. get_frame shows the frame the export shows at that time, at the start,
 *     middle and end of each frame period around 1x | 3x | 0.5x cuts — from a
 *     single cached segment and from a fresh full preview, at 30 and 29.97 fps.
 *     (It used to round atSeconds to 3 decimals, which could land on the next
 *     frame, and in a segment's last frame period wrote no image at all.)
 *
 * Run: npx tsx packages/core/scripts/smoke-cuts.ts
 */
import { execa } from "execa";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { EditorEngine } from "../src/engine.js";
import { methods } from "../src/rpc.js";
import { FFMPEG_BIN } from "../src/ffmpeg/executor.js";
import { probeFrameClock } from "../src/ffmpeg/timefx.js";
import { clipFootprintFrames, sourceFrameShownAt } from "../src/speed.js";
import type { Clip } from "../src/types.js";

let failures = 0;
function check(cond: boolean, name: string, detail = ""): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Decode a video (or image) to the frame index each frame encodes (9 stripes = bits). */
async function frameIndexes(file: string): Promise<number[]> {
  const W = 180;
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
    for (let bit = 0; bit < 9; bit++) if (b[k * fs + (H >> 1) * W + Math.floor(((bit + 0.5) * W) / 9)] > 125) n |= 1 << bit;
    out.push(n);
  }
  return out;
}

async function codedMedia(dir: string, name: string, rate: string, secs: number, timescale?: number): Promise<string> {
  const out = join(dir, name);
  await execa(FFMPEG_BIN, [
    "-hide_banner", "-y", "-f", "lavfi",
    "-i", `color=c=gray:s=180x90:r=${rate}:d=${secs},format=yuv420p,geq=lum='if(gt(mod(floor(N/pow(2,floor(X*9/W))),2),0),220,30)':cb=128:cr=128`,
    "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-g", "15",
    ...(timescale ? ["-video_track_timescale", String(timescale)] : []),
    out,
  ]);
  return out;
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "zedmix-cuts-"));
  const FPS = 30;
  const src = await codedMedia(dir, "coded.mp4", "30", 16);
  const engine = new EditorEngine(dir);
  engine.setProjectSettings({ width: 180, height: 90, fps: FPS, name: "cuts-smoke" });
  const coded = await engine.importVideo(src);
  const call = async <T = unknown>(name: keyof typeof methods, params: Record<string, unknown> = {}): Promise<T> => {
    const m = methods[name];
    const parsed = (m.schema as { parse: (x: unknown) => unknown }).parse(params);
    return (await m.handler(engine, parsed as never)) as T;
  };
  const tracks = () => engine.getProject().tracks;
  const clipById = (id: string): Clip => tracks().flatMap((t) => t.clips).find((c) => c.id === id)!;
  const fp = (c: Clip) => clipFootprintFrames(c, FPS);
  const end = (c: Clip) => c.startFrame + fp(c);
  const dur = (c: Clip) => fp(clipById(c.id));
  const clearTimeline = () => {
    for (const t of tracks()) for (const c of [...t.clips]) engine.removeClip(c.id);
  };
  /** The clip, at `speed`, plus a butted neighbour showing source 1..30 (so a 0 in an export is a gap). */
  const setup = (speed: number, inF = 30, outF = 90) => {
    clearTimeline();
    const clip = engine.addClip(coded.id, { startFrame: 0, sourceInFrame: inF, sourceOutFrame: outF });
    engine.setClipEffects(clip.id, { speed });
    const dur = fp(clipById(clip.id));
    const next = engine.addClip(coded.id, { startFrame: dur, sourceInFrame: 1, sourceOutFrame: 31, trackIndex: tracks()[0].index });
    return { clip: clipById(clip.id), dur, next };
  };

  // ---- 1. splits -----------------------------------------------------------------
  console.log("\nsplit_clip at every frame");
  for (const speed of SPEEDS) {
    const { clip, dur } = setup(speed);
    let splits = 0;
    let bad = 0;
    let moved = 0;
    let worst = 0;
    for (let at = 2; at < dur - 1; at++) {
      const r = engine.splitClip(clip.id, at);
      if (r.left !== r.right) {
        splits++;
        const L = clipById(r.left);
        const R = clipById(r.right);
        if (end(L) !== R.startFrame || end(R) !== dur || r.atFrame !== R.startFrame) bad++;
        if (Number.isInteger(speed) && (R.startFrame !== at || R.sourceInFrame !== clip.sourceInFrame + Math.round(at * speed))) moved++;
        worst = Math.max(worst, Math.abs(R.startFrame - at));
      }
      engine.undo();
    }
    check(
      bad === 0 && moved === 0 && splits > 0,
      `${speed}x: ${splits} splits — halves butt and the right half ends where the clip did (up to ${worst} frame${worst === 1 ? "" : "s"} from the request${Number.isInteger(speed) ? "; exactly where asked, as before" : ""})`,
      `${bad} bad, ${moved} moved`,
    );
  }

  // ---- 2. cut_range ----------------------------------------------------------------
  console.log("\ncut_range");
  for (const speed of SPEEDS) {
    const { clip, dur, next } = setup(speed);
    let bad = 0;
    let cases = 0;
    for (let s0 = 0; s0 < dur; s0 += 7) {
      for (let e0 = s0 + 1; e0 <= dur; e0 += 5) {
        cases++;
        engine.cutRange(clip.id, s0, e0);
        const parts = tracks()[0].clips.filter((c) => c.id !== next.id).sort((a, b) => a.startFrame - b.startFrame);
        const N = clipById(next.id);
        const lastEnd = parts.length ? end(parts[parts.length - 1]) : 0;
        if (parts.some((p, i) => i > 0 && end(parts[i - 1]) !== p.startFrame) || lastEnd !== N.startFrame || parts.some((p) => p.sourceOutFrame <= p.sourceInFrame)) bad++;
        engine.undo();
      }
    }
    check(bad === 0, `${speed}x: ${cases} ranges — pieces butt, the next clip closes up exactly`, `${bad} bad`);
  }
  {
    // A7: a one-frame tail / head is kept, and nothing leaves a gap.
    const { clip, dur, next } = setup(1);
    engine.cutRange(clip.id, 10, dur - 1);
    let parts = tracks()[0].clips.filter((c) => c.id !== next.id);
    check(
      parts.length === 2 && fp(parts[1]) === 1 && parts[1].sourceInFrame === clip.sourceOutFrame - 1 && end(parts[1]) === clipById(next.id).startFrame && clipById(next.id).startFrame === 11,
      "1x: cut_range leaving a one-frame tail keeps it (no gap before the next clip)",
      JSON.stringify(parts.map((p) => [p.startFrame, p.sourceInFrame, p.sourceOutFrame])),
    );
    engine.undo();
    engine.cutRange(clip.id, 1, 30);
    parts = tracks()[0].clips.filter((c) => c.id !== next.id).sort((a, b) => a.startFrame - b.startFrame);
    check(
      parts.length === 2 && parts[0].startFrame === 0 && fp(parts[0]) === 1 && parts[1].startFrame === 1 && end(parts[1]) === clipById(next.id).startFrame,
      "1x: cut_range leaving a one-frame head keeps it at the clip's start (no gap)",
      JSON.stringify(parts.map((p) => [p.startFrame, p.sourceInFrame, p.sourceOutFrame])),
    );
    engine.undo();
    const q = setup(0.25);
    engine.cutRange(q.clip.id, 1, 40); // 1 timeline frame = a quarter of a source frame: it goes with the cut
    parts = tracks()[0].clips.filter((c) => c.id !== q.next.id);
    check(
      parts.length === 1 && parts[0].startFrame === 0 && end(parts[0]) === clipById(q.next.id).startFrame,
      "0.25x: a head too short to hold a source frame goes with the cut (no gap)",
      JSON.stringify(parts.map((p) => [p.startFrame, p.sourceInFrame, p.sourceOutFrame])),
    );
  }

  // ---- 3. ripple_delete_ranges over two tracks ---------------------------------------
  console.log("\nripple_delete_ranges on two tracks");
  for (const speed of [0.25, 0.75, 1.5]) {
    const { clip, next } = setup(speed);
    const ti = tracks()[0].index;
    const v2 = engine.addTrack("video", { name: "V2" });
    const twin = engine.addClip(coded.id, { startFrame: 0, sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame, trackIndex: v2.index });
    engine.setClipEffects(twin.id, { speed });
    const len = (idx: number) => tracks().find((t) => t.index === idx)!.clips.reduce((n, c) => n + fp(c), 0);
    const l0 = len(ti);
    const l2 = len(v2.index);
    let bad = 0;
    for (const [s0, e0] of [[5, 17], [22, 23], [9, 31], [1, 6], [30, dur(clip) - 1], [0, 2], [dur(clip) - 2, dur(clip)]]) {
      await call("ripple_delete_ranges", { ranges: [{ trackIndex: ti, startFrame: s0, endFrame: e0 }, { trackIndex: v2.index, startFrame: s0, endFrame: e0 }] });
      const a = tracks().find((t) => t.index === ti)!.clips.filter((c) => c.id !== next.id).sort((x, y) => x.startFrame - y.startFrame);
      const b = tracks().find((t) => t.index === v2.index)!.clips.sort((x, y) => x.startFrame - y.startFrame);
      const butted = (cs: Clip[]) => cs.every((c, i) => i === 0 || end(cs[i - 1]) === c.startFrame);
      const empty = [...a, ...b].some((c) => c.sourceOutFrame <= c.sourceInFrame);
      if (!butted(a) || !butted(b) || empty || l0 - len(ti) !== l2 - len(v2.index) || end(a[a.length - 1]) !== clipById(next.id).startFrame) bad++;
      engine.undo();
    }
    check(bad === 0, `${speed}x: both tracks lose the same frames, pieces butted on both (no empty piece, also at the clip's edges), the next clip closes up`, `${bad} bad`);
  }

  // ---- 4. exports: pieces render exactly their footprints ------------------------------
  console.log("\nexport: pieces spread one black frame apart");
  for (const speed of [0.25, 0.5, 0.75, 1.5, 2, 4]) {
    clearTimeline();
    const clip = engine.addClip(coded.id, { startFrame: 0, sourceInFrame: 31, sourceOutFrame: speed < 1 ? 91 : 331 });
    engine.setClipEffects(clip.id, { speed });
    const dur = fp(clipById(clip.id));
    let ids = [clip.id];
    for (let k = 1; k <= 5; k++) {
      const at = Math.round((dur * k) / 6) + (k % 3);
      const host = ids.map(clipById).find((c) => c.startFrame < at && at < end(c));
      if (!host) continue;
      const r = engine.splitClip(host.id, at - host.startFrame);
      if (r.left !== r.right) ids = ids.filter((x) => x !== host.id).concat([r.left, r.right]);
    }
    const pieces = ids.map(clipById).sort((a, b) => a.startFrame - b.startFrame);
    engine.moveClips(pieces.map((p, i) => ({ clipId: p.id, startFrame: p.startFrame + i })).reverse());
    const placed = pieces.map((p) => clipById(p.id));
    const out = join(dir, `pieces-${speed}.mp4`);
    await engine.exportVideo(out);
    const idx = await frameIndexes(out);
    let bad = 0;
    let gapBad = 0;
    for (const p of placed) {
      for (let n = 0; n < fp(p); n++) if (idx[p.startFrame + n] !== sourceFrameShownAt(p, n, FPS)) bad++;
      if (end(p) < idx.length && idx[end(p)] !== 0) gapBad++;
    }
    check(
      bad === 0 && gapBad === 0 && idx.length === end(placed[placed.length - 1]) && placed.reduce((n, p) => n + fp(p), 0) === dur,
      `${speed}x: ${placed.length} pieces render exactly their footprints and the modelled frames`,
      `${bad} frames off, ${gapBad} gaps covered, ${idx.length} frames`,
    );
  }

  // ---- 6. get_frame shows the exported frame (run below, at 30 and 29.97 fps) --------------
  const getFrameCheck = async (assetId: string, fps: number, label: string, paths: ("segment" | "preview")[]) => {
    clearTimeline();
    const ti = tracks()[0].index;
    const a = engine.addClip(assetId, { startFrame: 0, sourceInFrame: 31, sourceOutFrame: 97 });
    const b = engine.addClip(assetId, { startFrame: end(clipById(a.id)), sourceInFrame: 100, sourceOutFrame: 340, trackIndex: ti });
    engine.setClipEffects(b.id, { speed: 3 });
    const c = engine.addClip(assetId, { startFrame: end(clipById(b.id)), sourceInFrame: 350, sourceOutFrame: 383, trackIndex: ti });
    engine.setClipEffects(c.id, { speed: 0.5 });
    const out = join(dir, `getframe-${label.replace(/\W+/g, "")}.mp4`);
    await engine.exportVideo(out);
    const ref = await frameIndexes(out);
    const total = end(clipById(c.id));
    const cuts = [end(clipById(a.id)), end(clipById(b.id))];
    const frames = new Set([0, 1, 2, 40, 100, total - 2, total - 1]);
    for (const s of cuts) for (let d = -2; d <= 1; d++) frames.add(s + d);
    for (const path of paths) {
      if (path === "preview") await engine.renderPreview(); // a fresh cached full preview: extracted with an input-side seek
      const off: string[] = [];
      let calls = 0;
      for (const f of [...frames].sort((x, y) => x - y)) {
        // The whole frame period [f, f+1) shows frame f: its start, its middle, and its very end (the last
        // frame period of a segment used to seek past the segment's last frame and write nothing).
        for (const d of [0, 0.5, 0.95]) {
          calls++;
          const at = (f + d) / fps;
          const got = (await frameIndexes(await engine.renderFrame(at)))[0];
          if (got !== ref[f]) off.push(`${at.toFixed(4)}s (frame ${f}+${d}): ${got}, export ${ref[f]}`);
        }
      }
      const past = (await frameIndexes(await engine.renderFrame(total / fps + 5)))[0];
      const mid = (await frameIndexes(await engine.renderFrame()))[0];
      check(
        ref.length === total && off.length === 0 && past === ref[total - 1] && mid === ref[Math.floor(total / 2)],
        `${label} ${path}: get_frame shows the exported frame at ${calls} times around 1x | 3x | 0.5x cuts (start, middle and end of each frame period), past the end = the last frame, default = the middle`,
        `${ref.length}/${total} frames; ${off.slice(0, 6).join("; ")}; past ${past} vs ${ref[total - 1]}; mid ${mid} vs ${ref[Math.floor(total / 2)]}`,
      );
    }
  };
  console.log("\nget_frame");
  await getFrameCheck(coded.id, FPS, "30 fps", ["segment", "preview"]);

  // ---- 5. freeze_frame holds the exported frame -----------------------------------------
  console.log("\nfreeze_frame at constant speeds");
  const freezeCheck = async (assetId: string, fps: number, label: string) => {
    for (const speed of [0.5, 0.75, 1.5, 2, 3, 4]) {
      clearTimeline();
      const clip = engine.addClip(assetId, { startFrame: 0, sourceInFrame: 31, sourceOutFrame: speed < 1 ? 91 : 331 });
      engine.setClipEffects(clip.id, { speed });
      const out = join(dir, `ref-${label}-${speed}.mp4`);
      await engine.exportVideo(out);
      const ref = await frameIndexes(out);
      const clock = await probeFrameClock(engine.getProject().assets.find((a) => a.id === assetId)!.path);
      const c = clipById(clip.id);
      let modelOff = 0;
      ref.forEach((g, n) => {
        if (g !== sourceFrameShownAt(c, n, fps, clock)) modelOff++;
      });
      const off: string[] = [];
      for (const n of [1, 2, 3, 5, 6, 7, 10, 21]) {
        const r = await call<{ assetId: string }>("freeze_frame", { clipId: clip.id, atSeconds: n / fps, durationSeconds: 0.2 });
        const held = (await frameIndexes(engine.getProject().assets.find((a) => a.id === r.assetId)!.path))[0];
        if (held !== ref[n]) off.push(`${n}: held ${held}, export ${ref[n]}`);
        engine.undo();
      }
      check(modelOff === 0 && off.length === 0, `${label} ${speed}x: freeze_frame holds exactly the exported frame; the model matches all ${ref.length} frames`, `${modelOff} model frames off; ${off.join("; ")}`);
    }
  };
  await freezeCheck(coded.id, FPS, "30 fps");
  // 29.97 fps on a 1/30000 timebase: a frame is 1001 ticks (odd), so (PTS-STARTPTS)/2 truncates at the ties.
  const ntscSrc = await codedMedia(dir, "ntsc.mp4", "30000/1001", 16, 30000);
  engine.setProjectSettings({ fps: 29.97 });
  const ntsc = await engine.importVideo(ntscSrc);
  await freezeCheck(ntsc.id, 29.97, "29.97 fps (1/30000)");
  await getFrameCheck(ntsc.id, 29.97, "29.97 fps (1/30000)", ["segment"]);

  if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nsmoke-cuts: all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
