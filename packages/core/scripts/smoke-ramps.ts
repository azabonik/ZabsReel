/**
 * Speed-ramp (curve speed) smoke test — no downloads. Covers the shared
 * mapping module (speed.ts) and every place that maps source ↔ timeline:
 *
 *  1. Mapping properties: constant-speed clips give EXACTLY the pre-ramp
 *     numbers (footprint, split/cut frames, locate frames) on a grid of
 *     trims × speeds × fps; a flat ramp equals constant speed; random ramps
 *     round-trip (source→timeline→source and back), are strictly monotonic,
 *     have d(source)/d(timeline) = speed, integrate to the numeric integral and
 *     add up over split windows; presets; audio chunk plan is sample-exact.
 *  2. Constant speed is untouched: golden filter strings (setpts/atempo, no
 *     ramp graph), segment-cache key identical after set+clear of a ramp, and
 *     — with RAMPS_BASELINE_REF=<git ref> — the whole ffmpeg command for a set
 *     of constant-speed timelines equals the one the graph builder at that ref
 *     emits (byte-identical renders).
 *  3. Export through every preset with frame-index-coded media: every output
 *     frame is the source frame the mapping predicts, frame count = footprint.
 *  4. Audio "stretch": length within a frame of the video, pitch kept (440 Hz
 *     tone stays 440 Hz, Goertzel), no clicks at chunk joins, burst positions
 *     follow the curve (within a frame); "mute" is silent.
 *  5. Bleeps on a ramped clip land on the (mapped) words: the original is
 *     silent under the window, the 1 kHz beep plays there, add_bleep by
 *     timeline time maps through the curve; renderer mirror == core.
 *  6. Split / cut_range / trim keep the anchored curve (split export shows the
 *     same frames as the unsplit one); freeze_frame on a ramped clip holds the
 *     frame actually shown; transcript ranges / locate map through the curve.
 *     A cut in a slow section (bullet, 0.15x) snaps to where its source frame
 *     plays: split at every frame, cut_range on a grid and a two-track
 *     ripple_delete_ranges keep the pieces and the next clip butted (exports
 *     have no gap) and both tracks lose the same frames.
 *  6c. Splits add up EXACTLY (known issue A2): at every split point of every
 *     preset and of flat 0.1x / 10x curves the halves' footprints sum to the
 *     whole and the right half ends where the clip did; split into pieces and
 *     spread apart by one black frame each, the export shows exactly each
 *     piece's footprint (a frame too many would cover the black gap) and every
 *     frame is the source frame the model predicts — also on flat 2x / 4x
 *     curves and on clips whose ramp points all lie outside them (A4: exact
 *     half-frame ties), and freeze_frame holds exactly that frame there.
 *  7. RPC surface + undo: one undo step each, set_clip_speed clears a ramp,
 *     preset XOR points, normalized points, audio-only change, refusals (still
 *     image, smooth_slow_motion), reverse mirrors the curve, OTIO export
 *     (average speed + note) and lossless round-trip, fps change keeps it.
 *  8. Long filtergraphs: 20 ramped clips make a graph past the OS argument
 *     limits (E2BIG), so runFfmpeg passes it from a file; a real export of a
 *     graph over the inline limit follows the curve and removes the file.
 *
 * Run: npx tsx packages/core/scripts/smoke-ramps.ts
 *      RAMPS_BASELINE_REF=dd38598 npx tsx packages/core/scripts/smoke-ramps.ts   # + byte-identical check
 */
import { execa } from "execa";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EditorEngine } from "../src/engine.js";
import { methods } from "../src/rpc.js";
import { FFMPEG_BIN, FFPROBE_BIN, INLINE_FILTERGRAPH_MAX, longFilterGraphIndex } from "../src/ffmpeg/executor.js";
import { buildRenderCommand, EXPORT_PROFILE, PREVIEW_PROFILE } from "../src/ffmpeg/graph.js";
import { segmentKey, type SegmentBuild } from "../src/ffmpeg/segments.js";
import { expandBleeps } from "../src/audio/bleeps.js";
import {
  RAMP_PRESETS,
  RAMP_PRESET_DEFS,
  buildSpeedCurve,
  clipFootprintFrames,
  clipTimeMap,
  curveSpeedAt,
  localFrameAtSource,
  presetRampPoints,
  RAMP_TIE_EPS,
  rampAudioChunks,
  rampSetptsExpr,
  sourceFrameAtLocalFrame,
  sourceFrameShownAt,
  type SpeedRamp,
  type SpeedRampPoint,
} from "../src/speed.js";
import type { AssetTranscript, Clip, ResolvedRenderClip } from "../src/types.js";

/** These keys compare one project against itself: any fixed FFmpeg build will do. */
const BUILD: SegmentBuild = { ffmpeg: "", xfadeEofPad: false };

const FPS = 30;
let failures = 0;
function check(cond: boolean, name: string, detail = ""): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;

// Deterministic PRNG (mulberry32).
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- media helpers -----------------------------------------------------------

/** Decode a video (or image) to the frame index each frame encodes (8 stripes = bits). */
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

/** Mono f32 samples of a file's audio at 48 kHz. */
async function samples(file: string): Promise<Float32Array> {
  const { stdout } = await execa(FFMPEG_BIN, ["-hide_banner", "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], {
    encoding: "buffer",
    maxBuffer: 1 << 30,
  });
  const b = Buffer.from(stdout as unknown as Uint8Array);
  const out = new Float32Array(Math.floor(b.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4);
  return out;
}
/** Goertzel amplitude of `freq` over s[i0, i1). */
function tone(s: Float32Array, i0: number, i1: number, freq: number): number {
  const w = (2 * Math.PI * freq) / 48000;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = Math.max(0, i0); i < Math.min(s.length, i1); i++) {
    const s0 = s[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const n = Math.max(1, Math.min(s.length, i1) - Math.max(0, i0));
  return (2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2))) / n;
}
function rms(s: Float32Array, i0: number, i1: number): number {
  let e = 0;
  let n = 0;
  for (let i = Math.max(0, i0); i < Math.min(s.length, i1); i++, n++) e += s[i] * s[i];
  return n ? Math.sqrt(e / n) : 0;
}
/** Dominant frequency over s[i0,i1) by zero crossings. */
function zcFreq(s: Float32Array, i0: number, i1: number): number {
  let z = 0;
  for (let i = i0 + 1; i < i1; i++) if (s[i - 1] < 0 !== s[i] < 0) z++;
  return z / 2 / ((i1 - i0) / 48000);
}

async function probeDur(file: string, stream: "v" | "a"): Promise<number> {
  const { stdout } = await execa(FFPROBE_BIN, ["-v", "error", "-select_streams", `${stream}:0`, "-show_entries", "stream=duration", "-of", "csv=p=0", file]);
  return Number(stdout.trim());
}

// ---- 1. mapping properties ---------------------------------------------------

function mappingProperties(): void {
  console.log("\nmapping (speed.ts)");
  // Constant speed: exactly the pre-ramp formulas.
  let constMismatch = 0;
  let cases = 0;
  for (const fps of [24, 25, 30, 60]) {
    for (const speed of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]) {
      for (const [inF, outF] of [[0, 1], [0, 7], [13, 100], [1, 2], [250, 1000], [33, 34 + fps * 3]]) {
        const clip = { sourceInFrame: inF, sourceOutFrame: outF, effects: { speed } };
        cases++;
        if (clipFootprintFrames(clip, fps) !== Math.max(1, Math.round((outF - inF) / speed))) constMismatch++;
        for (const local of [1, 5, 17]) {
          if (sourceFrameAtLocalFrame(clip, local, fps) !== inF + Math.round(local * speed)) constMismatch++;
        }
        for (const s of [inF / fps, (inF + 0.37) / fps, outF / fps]) {
          if (localFrameAtSource(clip, s, fps) !== Math.round(((s - inF / fps) / speed) * fps)) constMismatch++;
        }
      }
    }
  }
  check(constMismatch === 0, `constant speed == the pre-ramp formulas (${cases} trims × speeds × fps)`, `${constMismatch} mismatches`);
  check(clipFootprintFrames({ sourceInFrame: 0, sourceOutFrame: 90 }, 30) === 90, "no effects → 1x");

  // A flat ramp is constant speed (its frames round on the curve's own timeline: within a frame of round(span / v)).
  let flatBad = 0;
  for (const v of [0.25, 0.5, 1, 2, 3.5]) {
    const clip = { sourceInFrame: 30, sourceOutFrame: 211, effects: { speedRamp: { points: [{ src: 0, speed: v }, { src: 20, speed: v }] } } };
    const map = clipTimeMap(clip, 30);
    if (!near(map.duration, (181 / 30) / v, 1e-9)) flatBad++;
    const anchored = Math.floor(211 / v + 0.5 + RAMP_TIE_EPS) - Math.floor(30 / v + 0.5 + RAMP_TIE_EPS);
    if (clipFootprintFrames(clip, 30) !== anchored || Math.abs(anchored - 181 / v) > 1) flatBad++;
    if (!near(map.sourceAt(2), 1 + 2 * v, 1e-9)) flatBad++;
  }
  check(flatBad === 0, "flat ramp at v == constant speed v (duration, mapping; footprint = the anchored slots, within a frame of span / v)");

  // Random ramps: round trips, monotonicity, derivative = speed, integral, additivity.
  const r = rng(7);
  let rtBad = 0;
  let monoBad = 0;
  let derivBad = 0;
  let integBad = 0;
  let addBad = 0;
  for (let n = 0; n < 200; n++) {
    const k = 1 + Math.floor(r() * 7);
    const pts: SpeedRampPoint[] = [];
    let x = r() * 3;
    for (let i = 0; i < k; i++) {
      pts.push({ src: x, speed: 10 ** (-1 + 2 * r()) });
      x += 0.01 + r() * 2;
    }
    const inF = Math.floor(r() * 90);
    const outF = inF + 2 + Math.floor(r() * 300);
    const clip = { sourceInFrame: inF, sourceOutFrame: outF, effects: { speedRamp: { points: pts } } };
    const map = clipTimeMap(clip, FPS);
    // Round trips over (and beyond) the clip.
    for (let i = -5; i <= 25; i++) {
      const t = (map.duration * i) / 20;
      if (!near(map.timelineAt(map.sourceAt(t)), t, 1e-9 * Math.max(1, Math.abs(t)))) rtBad++;
      const s = map.srcIn + ((map.srcOut - map.srcIn) * i) / 20;
      if (!near(map.sourceAt(map.timelineAt(s)), s, 1e-9 * Math.max(1, Math.abs(s)))) rtBad++;
    }
    let prev = -Infinity;
    for (let i = 0; i <= 400; i++) {
      const s = map.sourceAt((map.duration * (i - 50)) / 300);
      if (!(s > prev)) monoBad++;
      prev = s;
    }
    for (let i = 1; i < 10; i++) {
      const t = (map.duration * i) / 10;
      const h = 1e-6 * Math.max(1, map.duration);
      const d = (map.sourceAt(t + h) - map.sourceAt(t - h)) / (2 * h);
      if (!near(d / map.speedAt(map.sourceAt(t)), 1, 1e-4)) derivBad++;
    }
    // Simpson integral of 1/v over the used range, piece by piece between the knots (1/v is smooth there).
    const c = buildSpeedCurve(pts);
    const cuts = [map.srcIn, ...c.xs.filter((x) => x > map.srcIn && x < map.srcOut), map.srcOut];
    let acc = 0;
    for (let p = 1; p < cuts.length; p++) {
      const a = cuts[p - 1];
      const b = cuts[p];
      const N = 2000;
      let part = 0;
      for (let i = 0; i <= N; i++) {
        const s = a + ((b - a) * i) / N;
        const w = i === 0 || i === N ? 1 : i % 2 ? 4 : 2;
        part += w / curveSpeedAt(c, s);
      }
      acc += (part * (b - a)) / N / 3;
    }
    if (!near(acc / map.duration, 1, 1e-6)) integBad++;
    const mid = inF + 1 + Math.floor(r() * (outF - inF - 1));
    const left = clipTimeMap({ ...clip, sourceOutFrame: mid }, FPS).duration;
    const right = clipTimeMap({ ...clip, sourceInFrame: mid }, FPS).duration;
    if (!near(left + right, map.duration, 1e-9 * Math.max(1, map.duration))) addBad++;
  }
  check(rtBad === 0, "random ramps: timeline↔source round trips (incl. extrapolation)", `${rtBad} bad`);
  check(monoBad === 0, "random ramps: sourceAt strictly increasing", `${monoBad} bad`);
  check(derivBad === 0, "random ramps: d(source)/d(timeline) == speed", `${derivBad} bad`);
  check(integBad === 0, "random ramps: duration == numeric ∫ds/speed (Simpson)", `${integBad} bad`);
  check(addBad === 0, "random ramps: split windows add up to the whole", `${addBad} bad`);

  // Presets.
  for (const p of RAMP_PRESETS) {
    const pts = presetRampPoints(p, 1, 7);
    const shape = RAMP_PRESET_DEFS[p].shape;
    check(
      pts.length === shape.length && pts.every((q, i) => near(q.src, 1 + 6 * shape[i][0], 1e-6) && near(q.speed, shape[i][1], 1e-9)),
      `preset ${p}: points across the used range`,
    );
  }

  // Audio chunks: contiguous, sample-exact, cumulative length follows the curve.
  let chunkBad = 0;
  for (const p of RAMP_PRESETS) {
    const ramp: SpeedRamp = { points: presetRampPoints(p, 1, 7) };
    const ch = rampAudioChunks(ramp, 1, 6, 48000);
    const map = clipTimeMap({ sourceInFrame: 30, sourceOutFrame: 210, effects: { speedRamp: ramp } }, 30);
    if (ch[0].srcStart !== 0 || ch[0].outStart !== 0) chunkBad++;
    for (let i = 1; i < ch.length; i++) if (ch[i].srcStart !== ch[i - 1].srcEnd || ch[i].outStart !== ch[i - 1].outEnd) chunkBad++;
    const last = ch[ch.length - 1];
    if (last.srcEnd !== 288000 || last.outEnd !== Math.round(map.duration * 48000)) chunkBad++;
    for (const c of ch) if (Math.abs(c.outEnd - Math.round(map.timelineAt(1 + c.srcEnd / 48000) * 48000)) > 1) chunkBad++;
  }
  check(chunkBad === 0, "audio chunk plan: contiguous, sample-exact boundaries on the curve");
  const lin2 = rampSetptsExpr({ points: [{ src: 0, speed: 2 }] }, 1, 3, 30);
  check(lin2 === "(max(floor((0+((PTS-STARTPTS)*TB-(-1))/2)*30+0.500001)-(15),0)+0.25)/30/TB", "single-point ramp = linear setpts (slot of X/2, anchored at slot 15)", lin2);
}

// ---- 2. constant speed untouched ---------------------------------------------

function goldenClip(over: Partial<ResolvedRenderClip> = {}): ResolvedRenderClip {
  return {
    path: "/tmp/x.mp4",
    trackIndex: 0,
    showVideo: true,
    startSec: 0,
    sourceIn: 1,
    sourceSpan: 4,
    outDuration: 2,
    hasAudio: true,
    muted: false,
    effects: { speed: 2, mutes: [{ start: 2, end: 2.5 }], fadeIn: 0.2 },
    ...over,
  };
}

async function constantUntouched(dir: string, engine: EditorEngine, codedId: string): Promise<void> {
  console.log("\nconstant speed untouched");
  const canvas = { width: 160, height: 90, fps: FPS };
  const { args } = buildRenderCommand([goldenClip()], canvas, join(dir, "g.mp4"), EXPORT_PROFILE);
  const fc = args[args.indexOf("-filter_complex") + 1];
  check(fc.includes("setpts=(PTS-STARTPTS)/2,fps=30"), "speed 2: setpts=(PTS-STARTPTS)/2 then fps");
  check(fc.includes("atempo=2,") && !fc.includes("asplit") && !fc.includes("log(") && !fc.includes("acrossfade"), "speed 2: one atempo, no ramp graph");
  const { args: a3 } = buildRenderCommand([goldenClip({ effects: { speed: 3 } })], canvas, join(dir, "g.mp4"), EXPORT_PROFILE);
  check(a3[a3.indexOf("-filter_complex") + 1].includes("atempo=2,atempo=1.5,"), "speed 3: atempo chain 2 × 1.5");

  // Segment key: set a ramp then go back to constant speed → the same key as before.
  const clip = engine.addClip(codedId, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: 120 });
  engine.setClipEffects(clip.id, { speed: 2 });
  const stage = async () => (engine as unknown as { stageRender(c: typeof canvas, o: { audio: boolean }): Promise<{ clips: ResolvedRenderClip[] }> }).stageRender(canvas, { audio: false });
  const key = async () => {
    const { clips } = await stage();
    return segmentKey(clips, { start: 0, end: 2 }, canvas, PREVIEW_PROFILE, {}, null, BUILD);
  };
  const k0 = await key();
  engine.setSpeedRamp(clip.id, { preset: "montage" });
  const k1 = await key();
  engine.setClipEffects(clip.id, { speed: 2 });
  const k2 = await key();
  check(k1 !== k0 && k2 === k0, "segment key: ramp changes it, back to constant speed restores it exactly");
  const staged = (await stage()).clips[0];
  check(!JSON.stringify(staged).includes("speedRamp"), "constant clip resolves with no speedRamp field");
  engine.removeClip(clip.id);

  const ref = process.env.RAMPS_BASELINE_REF;
  if (!ref) {
    console.log("  note RAMPS_BASELINE_REF unset — skipping the byte-identical command check against an older graph.ts");
    return;
  }
  // Byte-identical: the graph builder at `ref` must emit the same ffmpeg command for constant-speed timelines.
  const here = fileURLToPath(new URL("../src/ffmpeg/", import.meta.url));
  const tmp = join(here, `.baseline-graph-${process.pid}.ts`);
  try {
    const { stdout } = await execa("git", ["show", `${ref}:packages/core/src/ffmpeg/graph.ts`], { cwd: here });
    writeFileSync(tmp, stdout);
    const old = (await import(pathToFileURL(tmp).href)) as typeof import("../src/ffmpeg/graph.js");
    const sets: ResolvedRenderClip[][] = [
      [goldenClip()],
      [goldenClip({ effects: { speed: 0.5, volume: 0.7 }, outDuration: 8 })],
      [goldenClip({ effects: { speed: 3, fadeOut: 0.3, audioFilters: [{ id: "e1", type: "eq_presence", amount: 0.5 }] as never } })],
      [goldenClip({ effects: undefined, outDuration: 4 }), goldenClip({ startSec: 3.5, transition: { type: "fade", duration: 0.5 }, effects: { speed: 1.5 }, outDuration: 2.667 })],
      [goldenClip({ effects: { speed: 0.25, keyframes: { volume: [{ sec: 0, value: 0 }, { sec: 1, value: 1 }] } }, outDuration: 16 })],
    ];
    let same = 0;
    for (const s of sets) {
      for (const opts of [{}, { videoOnly: true, window: { start: 0.5, end: 1.5 } }, { audioOnly: true }]) {
        const a = buildRenderCommand(s, canvas, "/tmp/o.mp4", EXPORT_PROFILE, undefined, undefined, opts);
        const b = old.buildRenderCommand(s, canvas, "/tmp/o.mp4", EXPORT_PROFILE, undefined, undefined, opts);
        // The one intended change since the ref: the audio mix is pinned to stereo
        // (FFmpeg 4.4/5.x took the first clip's channel layout, 6.1+ stereo).
        b.args = b.args.map((x) => x.replace(/(amix=inputs=\d+:duration=longest:normalize=0)\[amixraw\]/, "$1,aformat=channel_layouts=stereo[amixraw]"));
        if (JSON.stringify(a) === JSON.stringify(b)) same++;
        else console.error("    differs:", JSON.stringify(opts), "\n     new:", a.args.join(" ").slice(0, 400), "\n     old:", b.args.join(" ").slice(0, 400));
      }
    }
    check(same === sets.length * 3, `constant speed: ffmpeg commands identical to ${ref}'s graph builder (${same}/${sets.length * 3})`);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// ---- main --------------------------------------------------------------------

async function main(): Promise<void> {
  mappingProperties();

  const dir = mkdtempSync(join(tmpdir(), "synthcut-ramps-"));
  // 8 s / 240 frames: frame N encodes N in 8 stripes; audio = 440 Hz tone.
  const src = join(dir, "coded.mp4");
  await execa(FFMPEG_BIN, [
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", `color=c=gray:s=160x90:r=${FPS}:d=8,format=yuv420p,geq=lum='if(gt(mod(floor(N/pow(2,floor(X*8/W))),2),0),220,30)':cb=128:cr=128`,
    "-f", "lavfi", "-i", "sine=frequency=440:duration=8:sample_rate=48000",
    "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-g", "15", "-c:a", "aac", "-b:a", "192k", "-shortest", src,
  ]);
  // Audio with 1.2 kHz bursts (hann-windowed, 60 ms) centred every 0.5 s from 0.25 s.
  const pulses = join(dir, "pulses.wav");
  await execa(FFMPEG_BIN, [
    "-hide_banner", "-y", "-f", "lavfi", "-i",
    "aevalsrc='if(lt(mod(t-0.22,0.5),0.06),sin(2*PI*1200*t)*sin(PI*mod(t-0.22,0.5)/0.06)*0.6,0)':s=48000:d=8",
    "-c:a", "pcm_s16le", pulses,
  ]);
  const still = join(dir, "still.png");
  await execa(FFMPEG_BIN, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=red:s=160x90", "-frames:v", "1", still]);

  const engine = new EditorEngine(dir);
  engine.setProjectSettings({ width: 160, height: 90, fps: FPS, name: "ramps-smoke" });
  const coded = await engine.importVideo(src);
  const pulse = await engine.importVideo(pulses);
  const img = await engine.importVideo(still);
  const call = async <T = unknown>(name: keyof typeof methods, params: Record<string, unknown> = {}): Promise<T> => {
    const m = methods[name];
    const parsed = (m.schema as { parse: (x: unknown) => unknown }).parse(params);
    return (await m.handler(engine, parsed as never)) as T;
  };
  const tracks = () => engine.getProject().tracks;
  const clipById = (id: string): Clip => tracks().flatMap((t) => t.clips).find((c) => c.id === id)!;
  const clearTimeline = () => {
    for (const t of tracks()) for (const c of [...t.clips]) engine.removeClip(c.id);
  };
  let outN = 0;
  const exportNow = async (): Promise<string> => {
    const out = join(dir, `out${outN++}.mp4`);
    await engine.exportVideo(out);
    return out;
  };

  await constantUntouched(dir, engine, coded.id);

  // ---- 3. every preset through the export ------------------------------------
  console.log("\nexport: frames follow the curve");
  const shown = new Map<string, number[]>();
  for (const preset of RAMP_PRESETS) {
    clearTimeline();
    const clip = engine.addClip(coded.id, { startFrame: 0, sourceInFrame: 30, sourceOutFrame: 210 });
    const res = await call<{ durationFrames: number; previousDurationFrames: number }>("set_speed_ramp", { clipId: clip.id, preset });
    const c = clipById(clip.id);
    const out = await exportNow();
    const idx = await frameIndexes(out);
    shown.set(preset, idx);
    let exact = 0;
    let within1 = 0;
    idx.forEach((got, n) => {
      const want = sourceFrameShownAt(c, n, FPS);
      if (got === want) exact++;
      if (Math.abs(got - want) <= 1) within1++;
    });
    check(
      idx.length === res.durationFrames && exact === idx.length,
      `${preset}: ${idx.length} frames (footprint ${res.durationFrames}, was ${res.previousDurationFrames}), every frame exactly the one the mapping predicts`,
      `within1=${within1}`,
    );
    const vd = await probeDur(out, "v");
    check(near(vd, res.durationFrames / FPS, 0.5 / FPS), `${preset}: video duration ${vd.toFixed(3)} s == footprint`);
    if (preset === "montage" || preset === "bullet") {
      // ---- 4. audio stretch: length, pitch, clicks --------------------------
      const s = await samples(out);
      const ad = s.length / 48000;
      check(near(ad, res.durationFrames / FPS, 1 / FPS), `${preset}: audio length ${ad.toFixed(3)} s within a frame of the video`);
      let pitchBad = 0;
      const win = 4800;
      for (let i = 4800; i + win < s.length - 4800; i += win) {
        const f = zcFreq(s, i, i + win);
        if (!near(f, 440, 440 * 0.03)) pitchBad++;
      }
      check(pitchBad === 0, `${preset}: 440 Hz tone stays 440 Hz (±3%) in every 100 ms window — pitch preserved`, `${pitchBad} windows off`);
      let gBad = 0;
      const amps: number[] = [];
      for (let i = 4800; i + win < s.length - 4800; i += win) {
        const g = tone(s, i, i + win, 440);
        amps.push(g);
        if (!(tone(s, i, i + win, 400) < g * 0.3 && tone(s, i, i + win, 480) < g * 0.3)) gBad++;
      }
      amps.sort((x, y) => x - y);
      const med = amps[amps.length >> 1];
      console.log(`       (${preset}: 440 Hz amplitude per 100 ms window — min ${amps[0].toFixed(3)}, median ${med.toFixed(3)} of 0.125)`);
      // Each chunk join is an 8 ms crossfade between two independently stretched (WSOLA) runs:
      // on a PURE tone their phases can disagree, so a window holding a join can dip — that is
      // the known cost of exact-length chunking. Pitch must hold everywhere (zero crossings above);
      // the spectrum must be 440 Hz in ≥ 90% of windows and the median level ≥ 80%.
      check(gBad <= amps.length * 0.1 && med > 0.1, `${preset}: Goertzel 440 Hz dominates 400/480 Hz in ${amps.length - gBad}/${amps.length} windows, median level kept`, `${gBad} windows`);
      let spikes = 0;
      for (let i = 2; i < s.length - 2400; i++) if (Math.abs(s[i] - 2 * s[i - 1] + s[i - 2]) > 0.02) spikes++;
      check(spikes === 0, `${preset}: no clicks at the stretch chunk joins (2nd difference)`, `${spikes} spike samples`);
    }
  }

  // The segmented preview (render_preview: windowed video-only MPEG-TS segments + one audio pass)
  // retimes the same way as the export.
  {
    clearTimeline();
    const clip = engine.addClip(coded.id, { startFrame: 0, sourceInFrame: 30, sourceOutFrame: 210 });
    await call("set_speed_ramp", { clipId: clip.id, preset: "montage" });
    const c = clipById(clip.id);
    const pv = await engine.renderPreview();
    const idx = await frameIndexes(pv.path);
    let bad = 0;
    idx.forEach((got, n) => {
      if (got !== sourceFrameShownAt(c, n, FPS)) bad++;
    });
    check(bad === 0 && idx.length === clipFootprintFrames(c, FPS), `render_preview (segment cache) shows exactly the export's frames (${idx.length} frames)`, `${bad} bad`);
  }

  // Burst positions follow the curve (stretch alignment), and mute is silent.
  console.log("\naudio: bursts land where the curve plays them");
  for (const preset of ["bullet", "montage", "flash_in"] as const) {
    clearTimeline();
    const clip = engine.addClip(pulse.id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: 180 });
    await call("set_speed_ramp", { clipId: clip.id, preset });
    const c = clipById(clip.id);
    const map = clipTimeMap(c, FPS);
    const out = await exportNow();
    const s = await samples(out);
    let worst = 0;
    let found = 0;
    for (let k = 0; k < 12; k++) {
      const srcCentre = 0.25 + 0.5 * k;
      if (srcCentre > 5.9) break;
      const tl = map.timelineAt(srcCentre);
      // Energy centroid of the 1.2 kHz burst within ±(half the gap) around the expected time.
      const half = Math.min(map.timelineAt(srcCentre + 0.2) - tl, tl - map.timelineAt(srcCentre - 0.2));
      const i0 = Math.round((tl - half) * 48000);
      const i1 = Math.round((tl + half) * 48000);
      let e = 0;
      let m = 0;
      for (let i = Math.max(0, i0); i < Math.min(s.length, i1); i++) {
        e += s[i] * s[i];
        m += i * s[i] * s[i];
      }
      if (e < 1e-3) continue;
      found++;
      worst = Math.max(worst, Math.abs(m / e / 48000 - tl));
    }
    check(found >= 10 && worst <= 1 / FPS, `${preset}: ${found} bursts centred on the mapped time (worst ${(worst * 1000).toFixed(1)} ms ≤ 1 frame)`);
  }
  {
    clearTimeline();
    const clip = engine.addClip(coded.id, { startFrame: 0, sourceInFrame: 30, sourceOutFrame: 210 });
    await call("set_speed_ramp", { clipId: clip.id, preset: "hero", audio: "mute" });
    const out = await exportNow();
    const s = await samples(out);
    const fp = clipFootprintFrames(clipById(clip.id), FPS);
    check(rms(s, 0, s.length) < 1e-4 && near(s.length / 48000, fp / FPS, 1 / FPS), `audio "mute": silent for the clip's ${fp / FPS} s`);
    await call("set_speed_ramp", { clipId: clip.id, audio: "stretch" });
    check(clipById(clip.id).effects?.speedRamp?.preset === "hero" && !clipById(clip.id).effects?.speedRamp?.audio, "audio-only change keeps the curve");
  }

  // ---- 5. bleeps on a ramped clip -------------------------------------------
  console.log("\nbleeps on a ramped clip");
  {
    clearTimeline();
    const clip = engine.addClip(coded.id, { startFrame: 15, sourceInFrame: 30, sourceOutFrame: 210 });
    await call("set_speed_ramp", { clipId: clip.id, preset: "bullet" });
    // A "word" at 3.9–4.2 s of the asset (inside bullet time) and one at 1.4–1.6 s (real time).
    await call("add_bleep", { clipId: clip.id, start: 3.9, end: 4.2 });
    await call("add_bleep", { clipId: clip.id, start: 1.4, end: 1.6, sound: "beep" });
    const c = clipById(clip.id);
    const map = clipTimeMap(c, FPS);
    const layers = engine.bleepLayers(c);
    const slow = layers.find((l) => near(l.srcStart, 3.9, 1e-9))!;
    check(near(slow.start, 0.5 + map.timelineAt(3.9), 1e-9) && near(slow.windowEnd, 0.5 + map.timelineAt(4.2), 1e-9), "bleep window maps through the curve");
    check(near(slow.sfxDuration, slow.windowEnd - slow.start, 1e-9) && slow.windowEnd - slow.start > 0.3 * 2, "beep lasts the (stretched) mapped window");
    const out = await exportNow();
    const s = await samples(out);
    for (const l of layers) {
      const a = Math.round((l.start + 0.02) * 48000);
      const b = Math.round((l.windowEnd - 0.02) * 48000);
      const t440 = tone(s, a, b, 440);
      const t1k = tone(s, a, b, 1000);
      check(t440 < 0.01 && t1k > 0.2, `bleep @${l.srcStart}s src: original silent (440 Hz ${t440.toFixed(4)}) and beep plays (1 kHz ${t1k.toFixed(3)}) at timeline ${l.start.toFixed(3)}–${l.windowEnd.toFixed(3)} s`);
      const pre = tone(s, Math.round((l.start - 0.25) * 48000), Math.round((l.start - 0.08) * 48000), 440);
      check(pre > 0.05, `bleep @${l.srcStart}s: tone audible just before the window (${pre.toFixed(3)})`);
    }
    // add_bleep by timeline time maps back through the curve.
    const at = 0.5 + map.timelineAt(5.0);
    const placed = await call<{ bleep: { start: number; end: number } }>("add_bleep", { clipId: clip.id, atSeconds: at, duration: 0.5 });
    check(
      near(placed.bleep.start, 5.0, 0.002) && near(placed.bleep.end, map.sourceAt(at - 0.5 + 0.5), 0.002),
      `add_bleep atSeconds on a ramp → source ${placed.bleep.start}–${placed.bleep.end} (expected 5.0–${map.sourceAt(at).toFixed(4)})`,
    );
    // The renderer mirror is checked against the core in smoke-composite; here the core's expansion
    // must equal the shared mapping for a few slips.
    const slipped = { ...c, audioOffsetFrames: 9 };
    const l2 = expandBleeps(slipped, FPS);
    check(l2.every((l) => near(l.start, (15 + 9) / FPS + map.timelineAt(l.srcStart), 1e-9)), "audio slip shifts ramped bleeps with the audio");
  }

  // ---- 6. split / cut / trim keep the curve; freeze; transcript --------------
  console.log("\nsplit / cut / trim / freeze / transcript on a ramped clip");
  {
    clearTimeline();
    const clip = engine.addClip(coded.id, { startFrame: 0, sourceInFrame: 30, sourceOutFrame: 210 });
    await call("set_speed_ramp", { clipId: clip.id, preset: "montage" });
    const whole = clipById(clip.id);
    const wholeDur = clipFootprintFrames(whole, FPS);
    const ref = shown.get("montage")!;
    const at = 61;
    const r = await call<{ left: string; right: string; atFrame: number }>("split_clip", { clipId: clip.id, atFrame: at });
    const L = clipById(r.left);
    const R = clipById(r.right);
    const samePts = JSON.stringify(L.effects?.speedRamp?.points) === JSON.stringify(whole.effects?.speedRamp?.points) && JSON.stringify(R.effects?.speedRamp?.points) === JSON.stringify(whole.effects?.speedRamp?.points);
    check(samePts, "split: both halves keep the same anchored curve");
    check(
      R.sourceInFrame === sourceFrameAtLocalFrame(whole, at, FPS) &&
        R.startFrame === localFrameAtSource(whole, R.sourceInFrame / FPS, FPS) &&
        R.startFrame === clipFootprintFrames(L, FPS) &&
        r.atFrame === R.startFrame &&
        Math.abs(R.startFrame - at) <= 1,
      `split at ${at}: right half starts on the mapped source frame ${R.sourceInFrame}, where it plays (frame ${R.startFrame}), butted to the left half`,
    );
    const sum = clipFootprintFrames(L, FPS) + clipFootprintFrames(R, FPS);
    check(sum === wholeDur, `split halves' lengths add up exactly (${sum} vs ${wholeDur})`);
    const out = await exportNow();
    const idx = await frameIndexes(out);
    let diff = 0;
    for (let n = 0; n < Math.min(idx.length, ref.length); n++) if (idx[n] !== ref[n]) diff++;
    check(diff === 0 && idx.length === ref.length, `split export shows exactly the unsplit clip's frames (${idx.length} vs ${ref.length} frames)`, `${diff} differ`);
    engine.undo();
    check(clipById(clip.id).effects?.speedRamp !== undefined && tracks()[0].clips.length === 1, "undo restores the unsplit ramped clip");

    // cut_range keeps the curve on both sides.
    const kept = await call<{ clips: string[] }>("cut_range", { clipId: clip.id, startFrame: 40, endFrame: 70 });
    const parts = tracks()[0].clips;
    check(
      kept.clips.length === 2 && parts.length === 2 && parts.every((p) => JSON.stringify(p.effects?.speedRamp?.points) === JSON.stringify(whole.effects?.speedRamp?.points)),
      `cut_range: ${parts.length} pieces keep the curve`,
    );
    check(parts[1].sourceInFrame === sourceFrameAtLocalFrame(whole, 70, FPS) && parts[0].sourceOutFrame === sourceFrameAtLocalFrame(whole, 40, FPS), "cut_range: cut points map through the curve");
    engine.undo();

    // Trim: the curve stays anchored; the new footprint is the window's integral.
    await call("trim_clip", { clipId: clip.id, sourceInFrame: 60 });
    const t = clipById(clip.id);
    check(JSON.stringify(t.effects?.speedRamp?.points) === JSON.stringify(whole.effects?.speedRamp?.points), "trim keeps the anchored points");
    check(clipFootprintFrames(t, FPS) === Math.round((clipTimeMap(whole, FPS).duration - clipTimeMap(whole, FPS).timelineAt(2)) * FPS), "trimmed footprint = the curve's integral over the new window");
    const tout = await exportNow();
    const tidx = await frameIndexes(tout);
    let tbad = 0;
    tidx.forEach((got, n) => {
      if (got !== sourceFrameShownAt(t, n, FPS)) tbad++;
    });
    check(tbad === 0 && tidx.length === clipFootprintFrames(t, FPS), `trimmed ramp export follows the window of the same curve (${tidx.length} frames)`);
    engine.undo();

    // Freeze frame: the still is the frame actually shown at that moment.
    for (const n of [20, 77, 120]) {
      const before = tracks()[0].clips.length;
      const res = await call<{ stillClipId: string; assetId: string; heldClipFrame: number }>("freeze_frame", { clipId: clip.id, atSeconds: n / FPS, durationSeconds: 0.5 });
      const stillAsset = engine.getProject().assets.find((a) => a.id === res.assetId)!;
      const held = (await frameIndexes(stillAsset.path))[0];
      check(held === ref[n], `freeze at output frame ${n}: still shows source frame ${held} (render showed ${ref[n]})`);
      const parts2 = tracks()[0].clips;
      const right = parts2.find((p) => p.startFrame > 0 && p.assetId === coded.id && p.sourceInFrame > 30);
      check(!!right && right.sourceInFrame === held && JSON.stringify(right.effects?.speedRamp?.points) === JSON.stringify(whole.effects?.speedRamp?.points), "freeze: right half starts on the held frame and keeps the curve");
      engine.undo();
      check(tracks()[0].clips.length === before, "freeze undone in one step");
    }

    // Transcript-driven ranges and locate map through the curve.
    const transcript: AssetTranscript = {
      segments: [{ start: 3.0, end: 3.5, text: "slow motion moment" }],
      words: [{ text: "slow", start: 3.0, end: 3.2 }, { text: "motion", start: 3.2, end: 3.4 }, { text: "moment", start: 3.4, end: 3.5 }],
      model: "fake",
      language: "en",
    };
    (engine as unknown as { setCachedTranscript(id: string, t: AssetTranscript): void }).setCachedTranscript(coded.id, transcript);
    const hits = (await call<{ matches: Array<{ startFrame: number; endFrame: number }> }>("locate_in_timeline", { query: "slow motion moment" })).matches;
    const cur = clipById(clip.id);
    check(
      hits.length > 0 && hits[0].startFrame === localFrameAtSource(cur, 3.0, FPS) && hits[0].endFrame === localFrameAtSource(cur, 3.5, FPS),
      `locate_in_timeline maps through the curve (frames ${hits[0]?.startFrame}–${hits[0]?.endFrame})`,
    );
    const del = await call<{ framesRemoved: number }>("delete_transcript_ranges", { assetId: coded.id, ranges: [{ fromWord: 0, toWord: 2 }] });
    const pieces = tracks()[0].clips;
    const piecesLen = pieces.reduce((n, p) => n + clipFootprintFrames(p, FPS), 0);
    check(
      Math.abs(del.framesRemoved - (localFrameAtSource(cur, 3.5, FPS) - localFrameAtSource(cur, 3.0, FPS))) <= 1 &&
        del.framesRemoved === clipFootprintFrames(cur, FPS) - piecesLen &&
        pieces.length === 2 && pieces[1].startFrame === pieces[0].startFrame + clipFootprintFrames(pieces[0], FPS),
      `delete_transcript_ranges removes the mapped ${del.framesRemoved} frames (pieces butted)`,
    );
    check(pieces.length === 2 && near(pieces[0].sourceOutFrame / FPS, 3.0, 1.01 / FPS) && near(pieces[1].sourceInFrame / FPS, 3.5, 1.01 / FPS), "transcript cut lands on the words' source times");
    engine.undo();
  }

  // ---- 6b. cuts in a slow section stay butted ----------------------------------
  console.log("\ncuts in a slow section (bullet, 0.15x) stay butted");
  {
    clearTimeline();
    const clip = engine.addClip(coded.id, { startFrame: 0, sourceInFrame: 30, sourceOutFrame: 210 });
    await call("set_speed_ramp", { clipId: clip.id, preset: "bullet" });
    const whole = clipById(clip.id);
    const dur = clipFootprintFrames(whole, FPS);
    const ti = tracks()[0].index;
    // A butted neighbour showing source frames 1..30, so a 0 in the export is a gap (black).
    const next = engine.addClip(coded.id, { startFrame: dur, sourceInFrame: 1, sourceOutFrame: 31, trackIndex: ti });
    const end = (c: Clip) => c.startFrame + clipFootprintFrames(c, FPS);
    const ref = await frameIndexes(await exportNow());
    check(ref.length === dur + 30 && !ref.includes(0), `reference: ${ref.length} frames, no gap`);

    // Every split point: the halves butt, the right half starts where its source frame plays,
    // and (a split never moves the next clip) the right half ends within a frame of it.
    let bad = 0;
    let moved = 0;
    for (let at = 2; at < dur - 1; at++) {
      const r = engine.splitClip(clip.id, at);
      if (r.left !== r.right) {
        const L = clipById(r.left);
        const R = clipById(r.right);
        if (end(L) !== R.startFrame || R.startFrame !== localFrameAtSource(whole, R.sourceInFrame / FPS, FPS) || r.atFrame !== R.startFrame || end(R) !== dur) bad++;
        moved = Math.max(moved, Math.abs(R.startFrame - at));
      }
      engine.undo();
    }
    check(bad === 0, `split at every frame: halves butt, the right half starts where its source frame plays (up to ${moved} frames from the request)`, `${bad} bad`);

    // The reviewer's case: split at 211 (inside the 0.15x section) exports the unsplit frames.
    const r = await call<{ left: string; right: string; atFrame: number }>("split_clip", { clipId: clip.id, atFrame: 211 });
    const R = clipById(r.right);
    const idx = await frameIndexes(await exportNow());
    let diff = 0;
    for (let n = 0; n < end(R); n++) if (idx[n] !== ref[n]) diff++;
    const gaps = idx.map((v, n) => (v === 0 ? n : -1)).filter((n) => n >= 0);
    check(
      diff === 0 && gaps.every((n) => n >= end(R) && n < clipById(next.id).startFrame),
      `split at 211 → ${r.atFrame}: export shows exactly the unsplit frames, no gap inside the clip`,
      `${diff} differ, gaps at ${gaps.join(",")}`,
    );
    engine.undo();

    // cut_range: pieces butt and the next clip closes up exactly, on a grid of ranges.
    bad = 0;
    for (let s0 = 5; s0 < dur - 5; s0 += 13) {
      for (let e0 = s0 + 3; e0 < dur - 2; e0 += 17) {
        await call("cut_range", { clipId: clip.id, startFrame: s0, endFrame: e0 });
        const parts = tracks()[0].clips.filter((c) => c.id !== next.id);
        const N = clipById(next.id);
        if (parts.length !== 2 || end(parts[0]) !== parts[1].startFrame || end(parts[1]) !== N.startFrame || parts[1].sourceInFrame < parts[0].sourceOutFrame) bad++;
        engine.undo();
      }
    }
    check(bad === 0, "cut_range on a grid: pieces butt, the next clip closes up exactly", `${bad} bad`);
    await call("cut_range", { clipId: clip.id, startFrame: 150, endFrame: 201 });
    const cutIdx = await frameIndexes(await exportNow());
    check(cutIdx.length === end(clipById(next.id)) && !cutIdx.includes(0), `cut_range [150, 201): ${cutIdx.length} frames, no gap`);
    engine.undo();

    // ripple_delete_ranges over two tracks: both lose the same frames; the ramped track stays butted.
    const v2 = engine.addTrack("video", { name: "V2" });
    engine.addClip(coded.id, { startFrame: 0, sourceInFrame: 0, sourceOutFrame: 240, trackIndex: v2.index });
    const v2Len = () => tracks().find((t) => t.index === v2.index)!.clips.reduce((n, c) => n + clipFootprintFrames(c, FPS), 0);
    const len0 = v2Len();
    await call("ripple_delete_ranges", { ranges: [{ trackIndex: ti, startFrame: 150, endFrame: 201 }, { trackIndex: v2.index, startFrame: 150, endFrame: 201 }] });
    const parts = tracks()[0].clips.filter((c) => c.id !== next.id);
    const N = clipById(next.id);
    const v2Parts = tracks().find((t) => t.index === v2.index)!.clips;
    check(
      parts.length === 2 && end(parts[0]) === parts[1].startFrame && end(parts[1]) === N.startFrame &&
        len0 - v2Len() === dur - N.startFrame && v2Parts.length === 2 && end(v2Parts[0]) === v2Parts[1].startFrame,
      `ripple_delete_ranges on two tracks: both lose ${dur - N.startFrame} frames, pieces butted on both`,
    );
    engine.undo();
    engine.removeTrack(v2.index);
  }

  // ---- 6c. splits add up exactly; every piece renders exactly its footprint ----
  console.log("\nsplits add up exactly; pieces render exactly their footprints (A2 / A4)");
  {
    const cases: Array<{ name: string; points?: SpeedRampPoint[]; preset?: (typeof RAMP_PRESETS)[number]; inF: number; outF: number }> = [
      ...RAMP_PRESETS.map((preset) => ({ name: preset, preset, inF: 30, outF: 210 })),
      { name: "flat 0.1x", points: [{ src: 0, speed: 0.1 }], inF: 31, outF: 61 },
      { name: "flat 10x", points: [{ src: 0, speed: 10 }], inF: 11, outF: 239 },
      { name: "flat 2x", points: [{ src: 0, speed: 2 }, { src: 1, speed: 2 }], inF: 31, outF: 211 },
      { name: "flat 4x", points: [{ src: 0, speed: 4 }, { src: 1, speed: 4 }], inF: 31, outF: 211 },
      { name: "points after the clip", points: [{ src: 7.5, speed: 2 }, { src: 7.9, speed: 3 }], inF: 31, outF: 211 },
      { name: "points before the clip", points: [{ src: 0.1, speed: 0.5 }, { src: 0.5, speed: 4 }], inF: 31, outF: 211 },
    ];
    let points = 0;
    let notAdditive = 0;
    let endMoved = 0;
    for (const cs of cases) {
      clearTimeline();
      const clip = engine.addClip(coded.id, { startFrame: 0, sourceInFrame: cs.inF, sourceOutFrame: cs.outF });
      await call("set_speed_ramp", { clipId: clip.id, ...(cs.preset ? { preset: cs.preset } : { points: cs.points }) });
      const whole = clipById(clip.id);
      const dur = clipFootprintFrames(whole, FPS);
      // Pure: every source frame as the cut — the two windows' footprints add up.
      for (let S = cs.inF + 1; S < cs.outF; S++) {
        const l = { ...whole, sourceOutFrame: S };
        const r = { ...whole, sourceInFrame: S };
        if (localFrameAtSource(whole, S / FPS, FPS) < 1 || localFrameAtSource(whole, S / FPS, FPS) >= dur) continue; // a 0-frame piece is never cut
        points++;
        if (clipFootprintFrames(l, FPS) + clipFootprintFrames(r, FPS) !== dur) notAdditive++;
      }
      // Engine: split at every timeline frame — halves butt and the right half ends where the clip did.
      for (let at = 2; at < dur - 1; at++) {
        const res = engine.splitClip(clip.id, at);
        if (res.left !== res.right) {
          const L = clipById(res.left);
          const R = clipById(res.right);
          if (L.startFrame + clipFootprintFrames(L, FPS) !== R.startFrame || R.startFrame + clipFootprintFrames(R, FPS) !== dur) endMoved++;
        }
        engine.undo();
      }
    }
    check(notAdditive === 0 && points > 1200, `${points} split points (every preset + flat 0.1x / 10x / 2x / 4x + outside points): left + right footprint == whole exactly`, `${notAdditive} not additive`);
    check(endMoved === 0, "split_clip at every frame of each: halves butt and the right half ends where the clip did", `${endMoved} moved`);

    // Export: pieces spread apart by one black frame — each shows exactly its footprint, every frame as modelled.
    for (const cs of cases) {
      clearTimeline();
      const clip = engine.addClip(coded.id, { startFrame: 0, sourceInFrame: cs.inF, sourceOutFrame: cs.outF });
      await call("set_speed_ramp", { clipId: clip.id, ...(cs.preset ? { preset: cs.preset } : { points: cs.points }) });
      const dur = clipFootprintFrames(clipById(clip.id), FPS);
      let ids = [clip.id];
      for (let k = 1; k <= 7; k++) {
        const at = Math.round((dur * k) / 8) + (k % 3);
        const host = ids.map(clipById).find((c) => c.startFrame < at && at < c.startFrame + clipFootprintFrames(c, FPS));
        if (!host) continue;
        const r = engine.splitClip(host.id, at - host.startFrame);
        if (r.left !== r.right) ids = ids.filter((x) => x !== host.id).concat([r.left, r.right]);
      }
      const pieces = ids.map(clipById).sort((a, b) => a.startFrame - b.startFrame);
      const sumFp = pieces.reduce((n, p) => n + clipFootprintFrames(p, FPS), 0);
      // Spread: piece i moves right by i frames (a black frame after each piece).
      engine.moveClips(pieces.map((p, i) => ({ clipId: p.id, startFrame: p.startFrame + i })).reverse());
      const placed = pieces.map((p) => clipById(p.id));
      const idx = await frameIndexes(await exportNow());
      let bad = 0;
      let gapBad = 0;
      for (const p of placed) {
        const F = clipFootprintFrames(p, FPS);
        for (let n = 0; n < F; n++) if (idx[p.startFrame + n] !== sourceFrameShownAt(p, n, FPS)) bad++;
        const gap = p.startFrame + F;
        if (gap < idx.length && idx[gap] !== 0) gapBad++;
      }
      const lastEnd = placed[placed.length - 1].startFrame + clipFootprintFrames(placed[placed.length - 1], FPS);
      check(
        sumFp === dur && bad === 0 && gapBad === 0 && idx.length === lastEnd,
        `${cs.name}: ${placed.length} pieces (footprints sum to ${sumFp} = ${dur}) each render exactly their frames, the black gap after each stays black`,
        `${bad} frames off, ${gapBad} gaps covered, ${idx.length} vs ${lastEnd} frames`,
      );
    }

    // A4: freeze_frame holds exactly the frame the export shows, also on exact half-frame ties.
    for (const cs of cases.filter((c) => /flat [24]x|points/.test(c.name))) {
      clearTimeline();
      const clip = engine.addClip(coded.id, { startFrame: 0, sourceInFrame: cs.inF, sourceOutFrame: cs.outF });
      await call("set_speed_ramp", { clipId: clip.id, points: cs.points });
      const c = clipById(clip.id);
      const ref = await frameIndexes(await exportNow());
      let off = 0;
      const tried: string[] = [];
      for (const n of [1, 2, 3, 7, 10, 21, 33]) {
        if (n >= clipFootprintFrames(c, FPS) - 1) continue;
        const res = await call<{ assetId: string }>("freeze_frame", { clipId: clip.id, atSeconds: n / FPS, durationSeconds: 0.2 });
        const held = (await frameIndexes(engine.getProject().assets.find((a) => a.id === res.assetId)!.path))[0];
        if (held !== ref[n]) off++;
        tried.push(`${n}:${held}/${ref[n]}`);
        engine.undo();
      }
      check(off === 0, `${cs.name}: freeze_frame holds exactly the exported frame (${tried.join(" ")})`);
    }
    // Leave the undo history as short as this section found it (section 7 counts undo steps; the stack is capped).
    while (engine.undo()) {
      /* unwind */
    }
  }

  // ---- 7. rpc surface, undo, refusals, reverse, OTIO, fps -------------------
  console.log("\nrpc + undo");
  {
    clearTimeline();
    const clip = engine.addClip(coded.id, { startFrame: 0, sourceInFrame: 30, sourceOutFrame: 210 });
    engine.setClipEffects(clip.id, { speed: 2, volume: 0.8 });
    const undoDepth = () => (engine as unknown as { undoStack: unknown[] }).undoStack.length;
    const d0 = undoDepth();
    await call("set_speed_ramp", { clipId: clip.id, preset: "hero" });
    check(undoDepth() === d0 + 1, "set_speed_ramp is one undo step");
    check(clipById(clip.id).effects?.speed === undefined && clipById(clip.id).effects?.volume === 0.8, "a ramp replaces the constant speed (other effects kept)");
    engine.undo();
    check(clipById(clip.id).effects?.speed === 2 && !clipById(clip.id).effects?.speedRamp, "undo restores speed 2, no ramp");
    await call("set_speed_ramp", { clipId: clip.id, points: [{ src: 0, speed: 0.5 }, { src: 0.5, speed: 4 }, { src: 1, speed: 0.5 }], normalized: true });
    const pts = clipById(clip.id).effects!.speedRamp!.points;
    check(pts.length === 3 && near(pts[0].src, 1, 1e-6) && near(pts[1].src, 4, 1e-6) && near(pts[2].src, 7, 1e-6) && !clipById(clip.id).effects!.speedRamp!.preset, "normalized points map onto the used source range (custom)");
    await call("set_clip_speed", { clipId: clip.id, speed: 1.5 });
    check(!clipById(clip.id).effects?.speedRamp && clipById(clip.id).effects?.speed === 1.5, "set_clip_speed clears the ramp");
    await call("set_speed_ramp", { clipId: clip.id, preset: "flash_out" });
    const d1 = undoDepth();
    const cleared = await call<{ durationFrames: number }>("clear_speed_ramp", { clipId: clip.id });
    check(undoDepth() === d1 + 1 && !clipById(clip.id).effects?.speedRamp && cleared.durationFrames === 180, "clear_speed_ramp: one undo step, back to 1x (180 frames)");
    let err = "";
    try {
      await call("set_speed_ramp", { clipId: clip.id, preset: "hero", points: [{ src: 1, speed: 2 }] });
    } catch (e) {
      err = String(e);
    }
    check(/either preset or points/.test(err), "preset + points is refused", err);
    err = "";
    try {
      await call("set_speed_ramp", { clipId: clip.id, points: [{ src: 1, speed: 20 }] });
    } catch (e) {
      err = String(e);
    }
    check(err.length > 0, "speed outside 0.1..10 is refused by the schema");
    err = "";
    try {
      await call("clear_speed_ramp", { clipId: clip.id });
    } catch (e) {
      err = String(e);
    }
    check(/no speed ramp/.test(err), "clear_speed_ramp on a clip without one explains itself");
    const stillClip = engine.addClip(img.id, { startFrame: 400, trackIndex: tracks()[0].index });
    err = "";
    try {
      await call("set_speed_ramp", { clipId: stillClip.id, preset: "hero" });
    } catch (e) {
      err = String(e);
    }
    check(/still image/.test(err), "a still image is refused", err);
    engine.removeClip(stillClip.id);
    await call("set_speed_ramp", { clipId: clip.id, preset: "bullet" });
    err = "";
    try {
      await call("smooth_slow_motion", { clipId: clip.id, mode: "blend" });
    } catch (e) {
      err = String(e);
    }
    check(/speed ramp/.test(err), "smooth_slow_motion refuses a ramped clip", err.slice(0, 120));

    // reverse_clip mirrors the curve: same footprint, slow parts stay on the same moments.
    const pre = clipById(clip.id);
    const preDur = clipFootprintFrames(pre, FPS);
    const preMap = clipTimeMap(pre, FPS);
    await call("reverse_clip", { clipId: clip.id, audio: "mute" });
    const rev = clipById(clip.id);
    const revMap = clipTimeMap(rev, FPS);
    check(clipFootprintFrames(rev, FPS) === preDur, `reverse keeps the ramped footprint exactly (${clipFootprintFrames(rev, FPS)} vs ${preDur})`);
    // Original asset second s plays reversed at u = span - (s - in): the speed there is the same.
    let mirrorBad = 0;
    for (let i = 1; i < 10; i++) {
      const s = preMap.srcIn + (6 * i) / 10;
      const u = 6 - (s - preMap.srcIn);
      if (!near(revMap.speedAt(u), preMap.speedAt(s), 1e-6)) mirrorBad++;
    }
    check(mirrorBad === 0, "reverse mirrors the curve onto the reversed media");
    const rout = await exportNow();
    const ridx = await frameIndexes(rout);
    let rbad = 0;
    ridx.forEach((got, n) => {
      // Reversed media frame k shows original frame (30 + 180 - 1 - k).
      const k = sourceFrameShownAt(rev, n, FPS);
      if (got !== 30 + 179 - k) rbad++;
    });
    check(rbad === 0 && ridx.length === preDur, `reversed ramped export follows the mirrored curve exactly (${ridx.length} frames)`, `${rbad} bad`);
    await call("reverse_clip", { clipId: clip.id });
    const back = clipById(clip.id);
    check(JSON.stringify(back.effects?.speedRamp?.points.map((p) => [Number(p.src.toFixed(4)), p.speed])) === JSON.stringify(pre.effects?.speedRamp?.points.map((p) => [Number(p.src.toFixed(4)), p.speed])), "un-reverse restores the original curve");

    // OTIO: average speed + note; SynthCut round trip keeps the curve.
    const otioPath = join(dir, "t.otio");
    await call("export_otio", { path: otioPath });
    const otio = JSON.parse((await import("node:fs")).readFileSync(otioPath, "utf8"));
    const item = otio.tracks.children[0].children.find((x: { OTIO_SCHEMA: string }) => x.OTIO_SCHEMA === "Clip.2");
    const warp = item.effects?.[0];
    const avg = (180 / FPS) / clipTimeMap(back, FPS).duration;
    check(warp?.OTIO_SCHEMA === "LinearTimeWarp.1" && near(warp.time_scalar, avg, 1e-5) && /average/.test(warp.metadata?.synthcut?.note ?? ""), `OTIO: LinearTimeWarp at the average speed ${avg.toFixed(4)} + a note`);
    await call("import_otio", { path: otioPath });
    const imported = engine.getProject().tracks.flatMap((t) => t.clips).find((c) => c.effects?.speedRamp);
    check(!!imported && JSON.stringify(imported.effects!.speedRamp) === JSON.stringify(back.effects!.speedRamp), "OTIO round trip keeps the speed ramp");
    engine.undo();

    // A reverse whose mirrored curve would round a frame the other way keeps the footprint through its rounding
    // phase — and the phase survives save → load and an OTIO round trip (a clip must not change length on reopen).
    {
      const pc = engine.addClip(coded.id, { startFrame: 400, sourceInFrame: 31, sourceOutFrame: 120, trackIndex: tracks()[0].index });
      await call("set_speed_ramp", { clipId: pc.id, points: [{ src: 0, speed: 2 }] }); // flat 2x: slots on exact halves
      const fp0 = clipFootprintFrames(clipById(pc.id), FPS);
      await call("reverse_clip", { clipId: pc.id, audio: "mute" });
      const rc = clipById(pc.id);
      const phase = rc.effects?.speedRamp?.phase;
      check(fp0 === 44 && clipFootprintFrames(rc, FPS) === 44 && typeof phase === "number" && phase > 0, `reverse of a flat 2x ramp on an odd frame keeps 44 frames through a rounding phase (${phase})`);
      const aive = join(dir, "phase.aive");
      await engine.save(aive);
      const e2 = new EditorEngine(dir);
      await e2.load(aive);
      const lc = e2.getProject().tracks.flatMap((t) => t.clips).find((c) => c.id === pc.id)!;
      check(lc.effects?.speedRamp?.phase === phase && clipFootprintFrames(lc, FPS) === 44, "save → load keeps the phase and the footprint");
      const otioP = join(dir, "phase.otio");
      await call("export_otio", { path: otioP });
      await call("import_otio", { path: otioP });
      const oc = engine.getProject().tracks.flatMap((t) => t.clips).find((c) => c.effects?.speedRamp?.phase !== undefined)!;
      check(!!oc && oc.effects?.speedRamp?.phase === phase && clipFootprintFrames(oc, FPS) === 44, "an OTIO round trip keeps the phase and the footprint");
      // import_otio replaced the project (clip ids kept, history cleared): un-reverse the imported clip.
      await call("reverse_clip", { clipId: pc.id });
      check(clipFootprintFrames(clipById(pc.id), FPS) === 44, "un-reverse keeps the footprint too");
      engine.removeClip(pc.id);
    }

    // fps change: ramp points are seconds, the timing holds.
    const before = clipTimeMap(clipById(clip.id), FPS).duration;
    engine.setProjectSettings({ fps: 60 });
    const after = clipTimeMap(clipById(clip.id), 60).duration;
    check(near(after, before, 1 / 60), `fps 30 → 60 keeps the ramped duration (${before.toFixed(3)} → ${after.toFixed(3)} s)`);
    engine.undo();
  }

  // ---- 8. long filtergraphs go to a file ------------------------------------
  console.log("\nlong filtergraphs (many ramped clips) go to a file");
  {
    const canvas = { width: 160, height: 90, fps: FPS };
    // 20 × 8 s montage clips: their audio chunks make ~200 KB of filtergraph, past Linux's
    // 128 KiB limit on one argument (spawn E2BIG) and Windows' 32,767-character command line.
    const many: ResolvedRenderClip[] = [];
    let t = 0;
    for (let i = 0; i < 20; i++) {
      const points = presetRampPoints("montage", i * 10, i * 10 + 8);
      const outDuration = clipFootprintFrames({ sourceInFrame: i * 300, sourceOutFrame: i * 300 + 240, effects: { speedRamp: { points } } }, FPS) / FPS;
      many.push(goldenClip({ startSec: t, sourceIn: i * 10, sourceSpan: 8, outDuration, effects: { speedRamp: { points } } }));
      t += outDuration;
    }
    const big = buildRenderCommand(many, canvas, join(dir, "big.mp4"), EXPORT_PROFILE).args;
    const plain = buildRenderCommand([goldenClip()], canvas, join(dir, "plain.mp4"), EXPORT_PROFILE).args;
    check(
      longFilterGraphIndex(big) >= 0 && big[longFilterGraphIndex(big) + 1].length > 131072 && longFilterGraphIndex(plain) < 0,
      `20 ramped clips: a ${big[big.indexOf("-filter_complex") + 1].length}-character graph goes to a file; a constant-speed graph (${plain[plain.indexOf("-filter_complex") + 1].length}) stays inline`,
    );

    // A real export whose graph is over the inline limit: 3 × 8 s montage clips.
    clearTimeline();
    let start = 0;
    const placed: Clip[] = [];
    for (let i = 0; i < 3; i++) {
      const c = engine.addClip(coded.id, { startFrame: start, sourceInFrame: 0, sourceOutFrame: 240 });
      await call("set_speed_ramp", { clipId: c.id, preset: "montage" });
      placed.push(clipById(c.id));
      start += clipFootprintFrames(clipById(c.id), FPS);
    }
    const staged = await (engine as unknown as { stageRender(c: typeof canvas): Promise<{ clips: ResolvedRenderClip[]; cwd: string }> }).stageRender(canvas);
    const graphLen = (a: string[]) => a[a.indexOf("-filter_complex") + 1].length;
    const fcLen = graphLen(buildRenderCommand(staged.clips, canvas, join(dir, "x.mp4"), EXPORT_PROFILE).args);
    const out = await exportNow();
    const idx = await frameIndexes(out);
    let bad = 0;
    idx.forEach((got, n) => {
      const k = placed.findIndex((c) => n >= c.startFrame && n < c.startFrame + clipFootprintFrames(c, FPS));
      if (k < 0 || got !== sourceFrameShownAt(placed[k], n - placed[k].startFrame, FPS)) bad++;
    });
    const vDur = await probeDur(out, "v");
    const aDur = await probeDur(out, "a");
    const left = readdirSync(staged.cwd).filter((f) => f.startsWith("filtergraph-"));
    check(
      fcLen > INLINE_FILTERGRAPH_MAX && idx.length === start && bad === 0 && Math.abs(aDur - vDur) <= 1 / FPS + 1e-3 && left.length === 0,
      `export with a ${fcLen}-character graph (from a file): ${idx.length} frames follow the curve, audio ${aDur.toFixed(3)} s vs video ${vDur.toFixed(3)} s, file removed`,
      `${bad} frames off, ${left.length} graph files left`,
    );
  }

  rmSync(dir, { recursive: true, force: true });
  if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nsmoke-ramps: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
