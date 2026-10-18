/**
 * ZabsReel's own motion renderer: a graphic's sound (slice 4c; MOTION-PLAN D4
 * E3 with D-SPLIT, the audio rows of its caps table, D8 "Audio"). Every
 * render goes through the real renderer, muted (nothing is ever played: the
 * sound is measured from the files FFmpeg writes), with fresh HOME and data
 * folders, in a private network namespace; fixtures are made with FFmpeg's
 * lavfi sources.
 *
 *  A1. merge     — the core's cue checks and merge (no renderer): one source
 *                  at one rate is one range, at rate 2 too, and so is a
 *                  linear volume ramp; a jump in source time, another rate,
 *                  a curved volume, a frame without the source or another
 *                  source key starts a new one; ranges come out in frame
 *                  order whatever order the frames came in; volume clamped
 *                  to 0..4 (NaN, sent as null, is 0); a source time before
 *                  0 is graphic_media_time, past the end left out; a handle
 *                  with no sound is graphic_asset_kind, an unreadable cue
 *                  graphic_render_crashed; 8 cues in a frame pass and a 9th,
 *                  a 17th audio file and a 257th range are
 *                  graphic_audio_cues_cap; requireMedia runs once per file
 *                  and its media_offline ends the render; the default caps
 *                  and the mix limit are D4's numbers.
 *  A2. standalone — a card with two <Audio> of one file (volumes 1 and 0.5)
 *                  and a 0.5 s file in a 1 s Sequence: its .mp4 has 48 kHz
 *                  stereo AAC whose levels, tones and silences fall where the
 *                  graphic put them (silence after the short file's end), and
 *                  its video keeps the BT.601 tags; a library video's own
 *                  sound plays from its trimBefore; a card with no sound
 *                  still has no audio stream.
 *  A3. timing    — playbackRate 2 plays the source twice as fast at its own
 *                  pitch (a 440 Hz then 880 Hz source: each tone half as
 *                  long, at its own frequency) and is one range; a linear
 *                  volume ramp is one range and rises as a line; volume 8
 *                  plays as 4; two sources of one file whose source times go
 *                  backwards between them, and a <Loop>, play each piece where
 *                  it belongs.
 *  A4. overlay   — an overlay's sound is baked/<id>-graphic-audio.wav (48 kHz
 *                  stereo, the graphic's length) beside its .mov; attached to
 *                  a clip (attachGraphic) it becomes one audio clip over the
 *                  graphic's window, linked to the clip, on the first audio
 *                  track free there (else a new one), joining the clip's
 *                  existing link group; the export and an audioOnly render
 *                  measure the sound inside the window and silence outside;
 *                  moving the clip moves it; set_graphic_window moves and
 *                  trims it (never past the clip or the sound, removed when
 *                  the window leaves the clip); remove_graphic and
 *                  clear_graphics remove it (and the link group it made).
 *                  D-SPLIT: a split inside the window keeps the one clip (same
 *                  id) ending at the split, the export has sound up to the
 *                  split and silence after it, and remove_graphic on the left
 *                  piece leaves no clip of that sound; a split before the
 *                  window removes it and clears audioClipId; one after it
 *                  leaves it alone; split_clip on the audio clip is refused.
 *                  The other cuts keep it one clip with its graphic too:
 *                  freeze_frame inside the window ends it at the freeze point
 *                  (and one before the clip moves it with the clip);
 *                  ripple_delete_ranges ends it with the first piece (the
 *                  graphic's copy on the second piece names no sound), moves
 *                  it with the clip, and removes it with a removed clip; a
 *                  ripple before the window gives it to the second piece,
 *                  which shows the graphic; cut_range ends it with the left
 *                  piece, and is refused on the audio clip; trim_clip ends it
 *                  with the clip (removed when the clip ends before the
 *                  window); set_clip_speed on the clip leaves it at 1x where
 *                  it was, ending no later than the clip, and on the audio
 *                  clip leaves the clip alone and ends it with the window;
 *                  tighten_talk ends it with the first piece and leaves the
 *                  rest of its track alone. A muted audio track is not free.
 *  A5. failures  — graphic_mix_timeout (a 1 ms limit) for an overlay and a
 *                  card, and a failed move of the .wav into baked/, each leave
 *                  baked/ as it was (the project changes only after a render
 *                  has succeeded: attachGraphic); a range cap and a
 *                  source cap breach end the render; an audio file on a
 *                  server not allowed is media_offline before any FFmpeg
 *                  opens it, and nothing the core did named that host.
 *  A6. pieces    — 200 ranges: the mix's long filter graph is written inside
 *                  motion/<id>, the render writes nothing outside it but its
 *                  outputs, and the mix plays every piece.
 *
 * Linux only (it reads /proc and runs Linux's Electron). Needs `npm run
 * build` (dist/zr-runtime.js) and FFmpeg. Ports: none.
 * Run: npx tsx packages/motion/scripts/smoke-motion-audio.ts [--only=A1,A4]
 */
import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EditorEngine } from "../../core/src/engine.js";
import { runFfmpeg } from "../../core/src/ffmpeg/executor.js";
import { probeAsset } from "../../core/src/ffmpeg/ffprobe.js";
import { buildRenderCommand, EXPORT_PROFILE } from "../../core/src/ffmpeg/graph.js";
import type { GraphicStart } from "../../core/src/motion/graphicmodule.js";
import { AUDIO_CAPS, GraphicAudio, mixArgs, mixLimitMs, type AudioCaps, type AudioRange } from "../../core/src/motion/motionaudio.js";
import type { MotionAsset, PageAsset } from "../../core/src/motion/motionmedia.js";
import { renderMotion, type RenderMotionOptions, type RenderMotionResult } from "../../core/src/motion/rendermotion.js";
import { dispatch } from "../../core/src/rpc.js";
import { clipEndFrame, type Canvas, type Clip, type GraphicOverlay, type MediaAsset, type ResolvedRenderClip } from "../../core/src/types.js";
import { check, failureCount, filesUnder, fresh, gone, LINUX, reexecInNetns, type Fresh } from "./smoke-lib.js";

const RATE = 48_000;
const EVIL = "zr-evil";

// ---- what the core touches ---------------------------------------------------------

/** The core's file calls (fs/promises, which gatedfs looks up per call): "<name> <path>[ <path>]". */
const touched: string[] = [];
/** The commands the core started: [file, ...args]. */
const spawned: string[][] = [];
{
  const load = createRequire(import.meta.url);
  const fsp = load("node:fs/promises") as Record<string, unknown>;
  for (const name of Object.keys(fsp)) {
    const real = fsp[name];
    if (typeof real !== "function" || name === "constants") continue;
    fsp[name] = function (this: unknown, ...args: unknown[]) {
      const paths = (["rename", "copyFile", "link", "symlink", "cp"].includes(name) ? args.slice(0, 2) : args.slice(0, 1)).map(String);
      touched.push(`${name} ${paths.join(" ")}`);
      return (real as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
  const cp = load("node:child_process") as { spawn: (file: string, args: string[], opts: Record<string, unknown>) => ChildProcess };
  const realSpawn = cp.spawn;
  cp.spawn = (file, args = [], opts = {}) => {
    spawned.push([file, ...args]);
    return realSpawn(file, args, opts);
  };
  syncBuiltinESMExports();
}

// ---- fixtures and measures ---------------------------------------------------------

interface Fixtures {
  /** 3 s of 440 Hz, stereo 48 kHz WAV, quiet (x4 does not clip). */
  tone: string;
  /** 0.5 s of 880 Hz. */
  short: string;
  /** 1 s of 440 Hz, then 1 s of 880 Hz. */
  two: string;
  /** 8 s of 160x90 colour, 30 fps, no audio: a host clip whose own sound is silence. */
  host: string;
  /** 2 s of 160x90 video with `two` as its AAC sound. */
  vid: string;
  /** 8 s of 160x90 colour with a quiet 220 Hz AAC sound: a clip tighten_talk accepts (its source has audio). */
  talk: string;
}

function ffmpeg(args: string[]): void {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`fixture: ffmpeg ${args.join(" ")}: ${r.stderr}`);
}

function fixtures(work: string): Fixtures {
  const dir = join(work, "fixtures");
  mkdirSync(dir, { recursive: true });
  const at = (n: string) => join(dir, n);
  const sine = (hz: number, d: number) => ["-f", "lavfi", "-i", `sine=frequency=${hz}:duration=${d}:sample_rate=${RATE}`];
  const quiet = ["-af", "volume=0.2", "-ac", "2", "-c:a", "pcm_s16le"];
  ffmpeg([...sine(440, 3), ...quiet, at("tone.wav")]);
  ffmpeg([...sine(880, 0.5), ...quiet, at("short.wav")]);
  ffmpeg([...sine(440, 1), ...sine(880, 1), "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1,volume=0.2", "-ac", "2", "-c:a", "pcm_s16le", at("two.wav")]);
  ffmpeg(["-f", "lavfi", "-i", "color=c=0x203040:s=160x90:r=30:d=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", at("host.mp4")]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=2", "-i", at("two.wav"), "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", at("vid.mp4")]);
  ffmpeg(["-f", "lavfi", "-i", "color=c=0x203040:s=160x90:r=30:d=8", ...sine(220, 8), "-af", "volume=0.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-c:a", "aac", "-shortest", at("talk.mp4")]);
  return { tone: at("tone.wav"), short: at("short.wav"), two: at("two.wav"), host: at("host.mp4"), vid: at("vid.mp4"), talk: at("talk.mp4") };
}

/** A file's first audio channel, as 48 kHz floats (empty when it has no audio). */
function pcm(file: string): Float32Array {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-ac", "2", "-ar", String(RATE), "-f", "f32le", "pipe:1"], { maxBuffer: 1 << 28 });
  const all = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 4));
  const left = new Float32Array(all.length / 2);
  for (let i = 0; i < left.length; i++) left[i] = all[2 * i];
  return left;
}

/** RMS and frequency (rising zero crossings per second) of `a` over [from, to) seconds. */
function measure(a: Float32Array, from: number, to: number): { rms: number; hz: number } {
  let sum = 0;
  let n = 0;
  let zc = 0;
  let prev = 0;
  for (let i = Math.round(from * RATE); i < Math.min(a.length, Math.round(to * RATE)); i++) {
    sum += a[i] * a[i];
    n++;
    if (prev <= 0 && a[i] > 0) zc++;
    prev = a[i];
  }
  return { rms: Math.sqrt(sum / Math.max(1, n)), hz: zc / (to - from) };
}

const near = (x: number, want: number, tol: number) => Math.abs(x - want) <= tol * want;
const SILENT = 1e-4;

interface Probe {
  streams: { codec_type: string; codec_name: string; sample_rate?: string; channels?: number; duration?: string; color_space?: string; color_primaries?: string; color_transfer?: string }[];
}
function probe(file: string): Probe {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,sample_rate,channels,duration,color_space,color_primaries,color_transfer", "-of", "json", file], { encoding: "utf8" });
  return JSON.parse(r.stdout) as Probe;
}

// ---- rendering ---------------------------------------------------------------------

interface Run {
  result?: RenderMotionResult;
  error?: Error & { code?: string; hosts?: string[] };
  pids: number[];
}

/** renderMotion at 64x36, 30 fps, with the run's renderer PIDs recorded; `o` has a graphic or a page written from the start data. */
async function render(
  f: Fresh,
  id: string,
  o: Partial<RenderMotionOptions> & { durationInFrames: number } & ({ graphic: NonNullable<RenderMotionOptions["graphic"]> } | { page: (start: GraphicStart) => string }),
): Promise<Run> {
  const run: Run = { pids: [] };
  const { page, ...rest } = o as typeof o & { page?: (start: GraphicStart) => string };
  const alpha = o.alpha ?? false;
  try {
    run.result = await renderMotion({
      width: 64,
      height: 36,
      fps: 30,
      alpha,
      workDir: join(f.data, "motion", id),
      outPath: join(f.data, "baked", `${id}-graphic.${alpha ? "mov" : "mp4"}`),
      env: f.env,
      onSpawn: (pid) => run.pids.push(pid),
      ...(page ? { module: (start: GraphicStart) => page(start) } : {}),
      ...rest,
    });
  } catch (err) {
    run.error = err as Run["error"];
  }
  return run;
}

/** After a render: no renderer left, motion/<id> gone; after a failure, nothing of it in baked/. */
async function leftNothing(run: Run, f: Fresh, id: string, what: string) {
  const left = await gone(run.pids, 2000);
  check(run.pids.length > 0 && left.length === 0, `${what}: no renderer process left (${run.pids.length} watched, left ${JSON.stringify(left)})`);
  check(!existsSync(join(f.data, "motion", id)), `${what}: motion/${id} is removed`);
  if (run.error) {
    const baked = readdirSync(join(f.data, "baked")).filter((n) => n.startsWith(`${id}-`));
    check(baked.length === 0, `${what}: nothing of it in baked/ (${JSON.stringify(baked)})`);
  }
}

/** A step the rows after it build on (not a check of this slice's behaviour): stop the smoke when it does not hold. */
function setup(ok: boolean, what: string): void {
  if (!ok) throw new Error(`setup: ${what} did not hold`);
}

const failedWith = (run: Run, code: string, what: string, msg?: RegExp) =>
  check(run.error?.code === code && (!msg || msg.test(run.error.message)), `${what}: ${code} (${run.error ? `${run.error.code}: ${run.error.message}` : "it rendered"})`);
const why = (run: Run) => (run.error ? `${run.error.code ?? ""}: ${run.error.message}` : JSON.stringify(run.result?.audio));

const TSX = (body: string) => `import { AbsoluteFill, Audio, Loop, OffthreadVideo, Sequence, asset } from "remotion";
export default function G() {
  return <AbsoluteFill style={{ background: "#123" }}>${body}</AbsoluteFill>;
}`;

/** A hand-written page (no runtime) reporting `cues(n, A)` (A: the start data's assets) as frame n's cues. */
const cuePage = (cues: string) => (start: GraphicStart) => `
const A = ${JSON.stringify(start.assets)};
zrMotion.onFrame((n) => ({ cues: (${cues})(n, A) }));
`;

// ---- A1: the merge -----------------------------------------------------------------

function a1() {
  console.log("A1. the core's cue checks and merge...");
  const info = (kind: PageAsset["kind"], extra: Partial<PageAsset> = {}): PageAsset => ({ handle: "h", kind, durationSeconds: 10, ...extra });
  const sources: Record<string, { id: string; asset: MotionAsset; info: PageAsset }> = {};
  const asset = { path: "/nowhere/a.wav" } as unknown as MotionAsset;
  for (let i = 0; i < 20; i++) sources[`a${i}`] = { id: `aud${i}`, asset, info: info("audio") };
  sources.img = { id: "pic", asset, info: { handle: "img", kind: "image", width: 4, height: 4 } };
  sources.mute = { id: "silentvid", asset, info: info("video", { hasAudio: false, fps: 30, frameCount: 300, width: 4, height: 4 }) };
  sources.vid = { id: "vid", asset, info: info("video", { hasAudio: true, fps: 30, frameCount: 300, width: 4, height: 4 }) };
  const required: string[] = [];
  const make = (caps: Partial<AudioCaps> = {}, requireMedia: (a: MotionAsset) => void = () => {}) =>
    new GraphicAudio((h) => sources[h], {
      fps: 30,
      caps: { ...AUDIO_CAPS, ...caps },
      requireMedia: (a) => {
        required.push(String((a as { path: string }).path));
        requireMedia(a);
      },
    });
  const cue = (sourceTime: number, volume: number | null = 1, handle = "a0", sourceKey = "s0") => ({ sourceKey, handle, sourceTime, volume });
  /** The ranges of frames `from`..`from+count-1` with cues from `at(n)`. */
  const merged = (count: number, at: (n: number) => unknown[], g = make(), from = 0): AudioRange[] => {
    for (let n = from; n < from + count; n++) g.add(n, at(n));
    return g.ranges();
  };
  const err = (fn: () => void) => {
    try {
      fn();
      return null;
    } catch (e) {
      return e as Error & { code?: string };
    }
  };

  // MUTATION: extend() never extending (every frame its own range) → these rows fail.
  const one = merged(60, (n) => [cue(n / 30)]);
  check(one.length === 1 && one[0].frames === 60 && Math.abs(one[0].rate - 1) < 1e-9 && one[0].step === 0, `one source at one rate: one range of 60 frames, rate 1 (${JSON.stringify(one)})`);
  const fast = merged(30, (n) => [cue(1 + (2 * n) / 30)]);
  check(fast.length === 1 && Math.abs(fast[0].rate - 2) < 1e-9 && fast[0].sourceTime === 1, `playbackRate 2: one range at rate 2 (${JSON.stringify(fast)})`);
  // MUTATION: the volume check dropped from extend() → the curved row below merges into one range.
  const ramp = merged(60, (n) => [cue(n / 30, n / 60)]);
  check(ramp.length === 1 && Math.abs(ramp[0].step - 1 / 60) < 1e-12 && ramp[0].volume === 0, `a linear volume ramp: one range, step 1/60 per frame (${JSON.stringify(ramp)})`);
  const curve = merged(10, (n) => [cue(n / 30, (n * n) / 100)]);
  check(curve.length === 5, `a curved volume: a new range every second frame (${curve.length} ranges)`);
  // MUTATION: the time check dropped from extend() → the jump and rate-change rows merge.
  const jump = merged(30, (n) => [cue(n < 15 ? n / 30 : (n - 15) / 30)]);
  check(jump.length === 2 && jump[1].frame === 15 && jump[1].sourceTime === 0, `a jump back in source time (a loop): a new range at frame 15 (${JSON.stringify(jump.map((r) => [r.frame, r.sourceTime]))})`);
  const rates = merged(30, (n) => [cue(n < 15 ? n / 30 : 0.5 + (2 * (n - 15)) / 30)]);
  check(rates.length === 2 && Math.abs(rates[1].rate - 2) < 1e-9, `a rate change: a new range (${JSON.stringify(rates.map((r) => [r.frame, r.rate]))})`);
  // MUTATION: the frame check dropped from ranges() → the cue after the gap extends the range (one frame early).
  const gap = merged(30, (n) => (n === 10 ? [] : [cue((n > 10 ? n - 1 : n) / 30)]));
  check(gap.length === 2 && gap[0].frames === 10 && gap[1].frame === 11, `a frame without the source (its time going on after it): a new range after it (${JSON.stringify(gap.map((r) => [r.frame, r.frames]))})`);
  const keys = merged(30, (n) => [cue(n / 30, 1, "a0", "s0"), cue(n / 30, 0.5, "a0", "s1")]);
  check(keys.length === 2 && keys.every((r) => r.frames === 30), `two source keys of one file: two ranges (${JSON.stringify(keys.map((r) => [r.frame, r.frames, r.volume]))})`);
  // Frames out of order (o.frames in tests): the merge sorts them.
  const g = make();
  for (const n of [5, 0, 3, 1, 4, 2]) g.add(n, [cue(n / 30)]);
  const sorted = g.ranges();
  check(sorted.length === 1 && sorted[0].frames === 6 && sorted[0].frame === 0, `frames arriving out of order merge in frame order (${JSON.stringify(sorted)})`);
  // MUTATION: no clamp (volume as sent) → this fails.
  const vols = [7, null, -1, 2.5].map((v) => merged(1, () => [cue(0, v)])[0].volume);
  check(JSON.stringify(vols) === "[4,0,0,2.5]", `volume clamped to 0..4, NaN (null) to 0 (${JSON.stringify(vols)})`);
  // MUTATION: cues past the end kept → the range runs on to frame 59.
  const past = merged(60, (n) => [cue(9 + n / 30)]);
  check(past.length === 1 && past[0].frames === 30, `cues at or past the source's end are left out (silence): ${past[0]?.frames} frames kept`);

  // MUTATION: no time check in add() → no graphic_media_time.
  const before = err(() => make().add(0, [cue(-0.01)]));
  check(before?.code === "graphic_media_time" && /aud0/.test(before.message), `a source time before 0: graphic_media_time naming the asset (${before?.code}: ${before?.message})`);
  const image = err(() => make().add(0, [cue(0, 1, "img")]));
  const mute = err(() => make().add(0, [cue(0, 1, "mute")]));
  const vid = err(() => make().add(0, [cue(0, 1, "vid")]));
  check(image?.code === "graphic_asset_kind" && /pic/.test(image.message) && mute?.code === "graphic_asset_kind" && vid === null, `an image or a video without sound: graphic_asset_kind; a video with sound plays (${image?.code}, ${mute?.code}, ${vid?.code ?? "ok"})`);
  const bad = [[{ sourceKey: "s", handle: "nope", sourceTime: 0, volume: 1 }], [{ sourceKey: "s", handle: "a0", sourceTime: null, volume: 1 }], [{ sourceKey: 3, handle: "a0", sourceTime: 0, volume: 1 }], [null], "x"];
  const crashed = bad.map((c) => err(() => make().add(0, c))?.code);
  check(crashed.every((c) => c === "graphic_render_crashed"), `an unreadable cue (unknown handle, no time, no key, not an object, not a list): graphic_render_crashed (${JSON.stringify(crashed)})`);
  // MUTATION: the per-frame check off by one (> perFrame + 1) → the 9th passes.
  const eight = err(() => make().add(0, Array.from({ length: 8 }, (_, i) => cue(0, 1, `a${i}`, `s${i}`))));
  const nine = err(() => make().add(0, Array.from({ length: 9 }, (_, i) => cue(0, 1, `a${i}`, `s${i}`))));
  check(eight === null && nine?.code === "graphic_audio_cues_cap" && /more than 8/.test(nine.message), `8 cues in a frame pass, a 9th: graphic_audio_cues_cap (${eight?.message ?? "ok"}; ${nine?.code}: ${nine?.message})`);
  // MUTATION: the source cap counted per cue, not per file / off by one → these fail.
  const sixteen = err(() => {
    const s = make();
    for (let i = 0; i < 16; i++) s.add(i, [cue(0, 1, `a${i}`), cue(0.1, 1, `a${i}`, "t")]);
  });
  const seventeen = err(() => {
    const s = make();
    for (let i = 0; i < 17; i++) s.add(i, [cue(0, 1, `a${i}`)]);
  });
  check(sixteen === null && seventeen?.code === "graphic_audio_cues_cap" && /more than 16 different audio files/.test(seventeen.message), `16 audio files pass, a 17th: graphic_audio_cues_cap (${sixteen?.message ?? "ok"}; ${seventeen?.code}: ${seventeen?.message})`);
  // MUTATION: the range cap checked as > ranges + 1 → 257 pass.
  const alternating = (count: number) => () => merged(count * 2, (n) => [cue((n % 90) / 30, n % 2 ? 0.6 : 0.2)]);
  const r256 = err(alternating(256));
  const r257 = err(alternating(257));
  check(r256 === null && r257?.code === "graphic_audio_cues_cap" && /more than 256 places/.test(r257.message), `256 ranges pass, a 257th: graphic_audio_cues_cap (${r256?.message ?? "ok"}; ${r257?.code}: ${r257?.message})`);
  // MUTATION: requireMedia called for every cue (or never) → the count is wrong.
  required.length = 0;
  merged(30, (n) => [cue(n / 30, 1, "a0"), cue(n / 30, 1, "a1", "s1")]);
  check(required.length === 2, `requireMedia once per audio file (${required.length} calls for 2 files over 30 frames)`);
  const offline = err(() =>
    make({}, () => {
      throw Object.assign(new Error("offline"), { code: "media_offline" });
    }).add(0, [cue(0)]),
  );
  check(offline?.code === "media_offline", `requireMedia's refusal ends the render (${offline?.code})`);
  // MUTATION: a default changed (ranges 255, sources 15, perFrame 9; the mix limit 30 s) → these fail.
  check(JSON.stringify(AUDIO_CAPS) === JSON.stringify({ perFrame: 8, ranges: 256, sources: 16 }), `the default audio caps are D4's (${JSON.stringify(AUDIO_CAPS)})`);
  // The mix's command: one input per audio file (not per range) and the silent base; a ramp held after its last cue.
  const many = merged(400, (n) => [cue((Math.floor(n / 2) % 2) + (n % 2) / 30, 1, "a0"), cue(n / 30, 1, "a1", "s1")]);
  const args = mixArgs(many, (h) => `/nowhere/${h}.wav`, { fps: 30, durationInFrames: 400 }, "/nowhere/out.wav");
  // MUTATION: one input per range → 202 inputs.
  check(many.length === 201 && args.filter((a) => a === "-i").length === 3, `201 ranges of 2 files: the mix has 3 inputs (2 files and the silent base; ${args.filter((a) => a === "-i").length})`);
  const rampArgs = mixArgs(merged(30, (n) => [cue(n / 30, n / 60)]), () => "/nowhere/a.wav", { fps: 30, durationInFrames: 30 }, "/nowhere/out.wav").join(" ");
  // MUTATION: the ramp's min(t, ...) dropped → it runs on past its last cue.
  check(rampArgs.includes("volume=eval=frame:volume='max(0,min(4,0+0.5*min(t,0.966666667)))'"), `a ramp over 30 frames: 0 to 29/60, held for its last frame (${/volume=[^,]*'[^']*'/.exec(rampArgs)?.[0]})`);
  check(mixLimitMs(300, 30) === 80_000 && mixLimitMs(36_000, 60) === 1_260_000, `the mix limit is 60 s + 2 x the graphic's length (${mixLimitMs(300, 30)}, ${mixLimitMs(36_000, 60)})`);
}

// ---- A2: a standalone card ---------------------------------------------------------

async function a2(work: string, lib: Record<string, MediaAsset>) {
  console.log("A2. a standalone card with sound...");
  const f = fresh(work, "standalone");
  const graphic = {
    source: TSX(`
      <Sequence durationInFrames={30}><Audio src={asset("tone")} /></Sequence>
      <Sequence from={45} durationInFrames={30}><Audio src={asset("tone")} volume={0.5} /></Sequence>
      <Sequence from={90} durationInFrames={30}><Audio src={asset("short")} /></Sequence>`),
  };
  const run = await render(f, "card", { graphic, durationInFrames: 120, assets: { tone: lib.tone, short: lib.short } });
  // MUTATION: a card's result naming a .wav (audioPath always set) → this fails.
  check(!run.error && run.result?.audio.ranges === 3 && run.result.audio.sources === 2 && run.result.audioPath === undefined, `the card renders: 3 ranges of 2 files, no separate .wav (${why(run)})`);
  const out = join(f.data, "baked", "card-graphic.mp4");
  const p = probe(out);
  const a = p.streams.find((s) => s.codec_type === "audio");
  const v = p.streams.find((s) => s.codec_type === "video");
  // MUTATION: the mux skipped (the encoded .mp4 moved as it was) → no audio stream.
  check(a?.codec_name === "aac" && a.sample_rate === "48000" && a.channels === 2 && Math.abs(Number(a.duration) - 4) < 0.05, `its .mp4 has 48 kHz stereo AAC, 4 s (${JSON.stringify(a)})`);
  // MUTATION: tagGraphicColor skipped for a card with sound → the muxed video is untagged.
  check(v?.codec_name === "h264" && v.color_space === "smpte170m" && v.color_primaries === "smpte170m" && v.color_transfer === "smpte170m", `its video is the tagged H.264 (BT.601 tags kept by the mux: ${JSON.stringify(v)})`);
  const s = pcm(out);
  const full = measure(s, 0.05, 0.95);
  const off1 = measure(s, 1.05, 1.45);
  const half = measure(s, 1.55, 2.45);
  const off2 = measure(s, 2.55, 2.95);
  const short = measure(s, 3.05, 3.45);
  const tail = measure(s, 3.55, 3.95);
  console.log(`       levels: ${[full, off1, half, off2, short, tail].map((m) => `${m.rms.toFixed(5)}@${Math.round(m.hz)}`).join(" ")}`);
  // MUTATION: adelay dropped (every range at time 0) → the later windows are silent.
  check(full.rms > 0.01 && near(full.hz, 440, 0.03), `0-1 s: the tone at volume 1 (rms ${full.rms.toFixed(5)}, ${full.hz.toFixed(0)} Hz)`);
  // MUTATION: a range's atrim end and its sample pin both dropped → the source plays on past each range.
  check(off1.rms < SILENT && off2.rms < SILENT, `1.0-1.5 s and 2.5-3.0 s: silence (rms ${off1.rms.toExponential(1)}, ${off2.rms.toExponential(1)})`);
  // MUTATION: the volume step ignored for constant volumes (volume= left out) → the ratio is 1.
  check(near(half.rms / full.rms, 0.5, 0.03) && near(half.hz, 440, 0.03), `1.5-2.5 s: the tone at volume 0.5 (${(half.rms / full.rms).toFixed(3)} of full)`);
  check(near(short.rms / full.rms, 1, 0.05) && near(short.hz, 880, 0.03), `3.0-3.5 s: the 0.5 s file (${short.hz.toFixed(0)} Hz)`);
  // (Leaving out the cues past the short file's end is A1's row: the mix is silent there either way.)
  // MUTATION: the mix's last atrim dropped → the sound runs 0.1 s past the graphic (the silent base's margin).
  check(tail.rms < SILENT && Math.abs(s.length / RATE - 4) < 0.05, `3.5-4.0 s: silence after the short file's end; 4 s in all (${tail.rms.toExponential(1)}, ${(s.length / RATE).toFixed(3)} s)`);
  await leftNothing(run, f, "card", "card");

  // A library video's own sound (E3: the audio of E1 videos), from 1 s into the file: the mix seeks a container that also has a
  // picture and takes its audio stream.
  const vs = await render(f, "vidsound", { graphic: { source: TSX(`<OffthreadVideo src={asset("vid")} trimBefore={30} />`) }, durationInFrames: 30, assets: { vid: lib.vid } });
  const vsound = pcm(join(f.data, "baked", "vidsound-graphic.mp4"));
  const vm = measure(vsound, 0.05, 0.9);
  // MUTATION: only audio assets accepted as cue sources (a video's sound: graphic_asset_kind) → the render fails.
  check(!vs.error && vs.result?.audio.ranges === 1 && vm.rms > 0.01 && near(vm.hz, 880, 0.03), `a library video's sound plays from its trimBefore: ${vm.hz.toFixed(0)} Hz, rms ${vm.rms.toFixed(5)} (${why(vs)})`);
  await leftNothing(vs, f, "vidsound", "video sound");

  const silent = await render(f, "quiet", { graphic: { source: TSX(`<Sequence durationInFrames={10}><div /></Sequence>`) }, durationInFrames: 10 });
  const q = probe(join(f.data, "baked", "quiet-graphic.mp4"));
  check(!silent.error && silent.result?.audio.ranges === 0 && !q.streams.some((x) => x.codec_type === "audio"), `a card with no sound has no audio stream (${why(silent)}; ${q.streams.map((x) => x.codec_type).join(",")})`);
}

// ---- A3: rates, ramps, clamps, loops -----------------------------------------------

async function a3(work: string, lib: Record<string, MediaAsset>) {
  console.log("A3. playback rate, volume ramp, clamp and loops...");
  const f = fresh(work, "timing");
  const card = (id: string, body: string, durationInFrames: number, assets: Record<string, MediaAsset>) =>
    render(f, id, { graphic: { source: TSX(body) }, durationInFrames, assets });
  const sound = (id: string) => pcm(join(f.data, "baked", `${id}-graphic.mp4`));

  const fast = await card("fast", `<Audio src={asset("two")} playbackRate={2} />`, 30, { two: lib.two });
  const s = sound("fast");
  const lo = measure(s, 0.05, 0.45);
  const hi = measure(s, 0.55, 0.95);
  console.log(`       rate 2: ${lo.hz.toFixed(0)} Hz then ${hi.hz.toFixed(0)} Hz`);
  // MUTATION: atempo dropped from the chain → the source plays at rate 1: 440 Hz in both halves.
  check(!fast.error && fast.result?.audio.ranges === 1, `rate 2: one range (${why(fast)})`);
  check(near(lo.hz, 440, 0.03) && near(hi.hz, 880, 0.03) && lo.rms > 0.01 && hi.rms > 0.01, `rate 2: 1 s of 440 Hz then 1 s of 880 Hz play in 0.5 s each, at their own pitch (${lo.hz.toFixed(0)} / ${hi.hz.toFixed(0)} Hz)`);

  const ramp = await card("ramp", `<Audio src={asset("tone")} volume={(f) => f / 60} />`, 60, { tone: lib.tone });
  const r = sound("ramp");
  const w = [0.4, 0.9, 1.4, 1.9].map((t) => measure(r, t - 0.05, t + 0.05).rms);
  const ref = measure(pcm(lib.tone.path), 0.5, 1.5).rms;
  console.log(`       ramp: ${w.map((x) => (x / ref).toFixed(3)).join(" ")} of the source (want 0.200 0.450 0.700 0.950)`);
  check(!ramp.error && ramp.result?.audio.ranges === 1, `a linear ramp: one range (${why(ramp)})`);
  // MUTATION: the ramp's expression left constant (its first volume) → silence all along.
  check(w.every((x, i) => near(x / ref, [0.4, 0.9, 1.4, 1.9][i] / 2, 0.06)), `a linear ramp rises as a line: ${w.map((x) => (x / ref).toFixed(3)).join(", ")} of the source at 0.4, 0.9, 1.4, 1.9 s`);

  const loud = await card("loud", `<Sequence durationInFrames={30}><Audio src={asset("tone")} /></Sequence><Sequence from={30} durationInFrames={30}><Audio src={asset("tone")} volume={8} /></Sequence>`, 60, { tone: lib.tone });
  const l = sound("loud");
  const ratio = measure(l, 1.05, 1.95).rms / measure(l, 0.05, 0.95).rms;
  // (The runtime clamps a cue's volume to 4 as well; the core's own clamp is A1's row.)
  // MUTATION: the mix capping a constant volume at 2 → the ratio is 2.
  check(!loud.error && near(ratio, 4, 0.03), `volume 8 plays as 4: ${ratio.toFixed(3)} x volume 1`);

  // Two sources of one file whose source times go backwards between them: one split input (asplit).
  const back = await card("back", `<Sequence durationInFrames={15}><Audio src={asset("two")} trimBefore={30} /></Sequence><Sequence from={15} durationInFrames={15}><Audio src={asset("two")} /></Sequence>`, 30, { two: lib.two });
  const b = sound("back");
  const b1 = measure(b, 0.05, 0.45);
  const b2 = measure(b, 0.55, 0.95);
  // MUTATION: audio files counted by source key → 2 files.
  check(!back.error && back.result?.audio.ranges === 2 && back.result.audio.sources === 1, `two sources of one file: 2 ranges, 1 file (${why(back)})`);
  // MUTATION: the input seeked to the first range's source time, not the earliest → 880 Hz in both halves.
  check(near(b1.hz, 880, 0.03) && near(b2.hz, 440, 0.03) && b1.rms > 0.01 && b2.rms > 0.01, `the later source time first, the earlier one second: ${b1.hz.toFixed(0)} Hz then ${b2.hz.toFixed(0)} Hz`);

  // MUTATION: a branch's atrim made relative to the source start, not the input's seek point → the loop plays from 1.0 s.
  const loop = await card("loop", `<Loop durationInFrames={15}><Audio src={asset("two")} trimBefore={15} /></Loop>`, 60, { two: lib.two });
  const lp = sound("loop");
  const pieces = [0, 0.5, 1, 1.5].map((t) => measure(lp, t + 0.05, t + 0.45));
  check(!loop.error && loop.result?.audio.ranges === 4, `a <Loop> of 15 frames over 60: 4 ranges (${why(loop)})`);
  check(pieces.every((m) => near(m.hz, 440, 0.03) && m.rms > 0.01), `each loop plays the source from 0.5 s again (${pieces.map((m) => m.hz.toFixed(0)).join(", ")} Hz)`);
  for (const id of ["fast", "ramp", "loud", "back", "loop"]) check(!existsSync(join(f.data, "motion", id)), `${id}: motion/${id} is removed`);
}

// ---- A4: an overlay, its audio clip, the export and D-SPLIT ------------------------

/** The private renderer staging an audioOnly render needs (engine.ts stageRender; export_video has no audioOnly). */
type Staging = { stageRender(canvas: Canvas, opts?: object): Promise<{ clips: ResolvedRenderClip[]; cwd: string }> };

async function a4(work: string, fx: Fixtures, lib: Record<string, MediaAsset>) {
  console.log("A4. an overlay's sound: the .wav, the linked audio clip, export and D-SPLIT...");
  const f = fresh(work, "overlay");
  const ov = await render(f, "ov", {
    alpha: true,
    graphic: { source: TSX(`<Sequence from={15} durationInFrames={30}><Audio src={asset("tone")} /></Sequence>`) },
    durationInFrames: 60,
    assets: { tone: lib.tone },
  });
  const mov = join(f.data, "baked", "ov-graphic.mov");
  const wav = join(f.data, "baked", "ov-graphic-audio.wav");
  check(!ov.error && ov.result?.audioPath === wav && existsSync(mov) && existsSync(wav), `the overlay renders: its .mov and baked/ov-graphic-audio.wav (${why(ov)})`);
  const pw = probe(wav).streams[0];
  check(pw?.codec_name === "pcm_s16le" && pw.sample_rate === "48000" && pw.channels === 2 && Math.abs(Number(pw.duration) - 2) < 0.002, `the .wav is 48 kHz stereo, 2 s, the graphic's length (${JSON.stringify(pw)})`);
  // MUTATION: an overlay muxed like a card (into a .mov) → it has an audio stream.
  const mv = probe(mov).streams;
  check(!mv.some((s) => s.codec_type === "audio"), `the overlay's .mov stays video-only (${mv.map((s) => s.codec_type).join(",")})`);
  await leftNothing(ov, f, "ov", "overlay");
  if (ov.error) return;

  const engine = new EditorEngine(f.data);
  engine.setProjectSettings({ width: 160, height: 90, fps: 30 });
  const hostAsset = await engine.importVideo(fx.host);
  const host = engine.addClip(hostAsset.id, { trackIndex: 0, startFrame: 30, sourceInFrame: 0, sourceOutFrame: 180 });
  const baked = await probeAsset(mov);
  const sound = await probeAsset(wav);
  const clipOf = (id: string): Clip | undefined => engine.getProject().tracks.flatMap((t) => t.clips).find((c) => c.id === id);
  const trackOf = (id: string) => engine.getProject().tracks.find((t) => t.clips.some((c) => c.id === id));
  const graphicOn = (clipId: string): GraphicOverlay | undefined => clipOf(clipId)?.graphics?.[0];
  const soundClips = () => engine.getProject().tracks.flatMap((t) => t.clips).filter((c) => c.assetId === sound.id);
  const audioTracks = () => engine.getProject().tracks.filter((t) => t.kind === "audio").length;

  // A graphic window [30, 90) of the clip at timeline frame 30: its sound from timeline frame 60, 60 frames.
  const r = engine.attachGraphic(host.id, { id: "gfx_ov", assetId: baked.id, startFrame: 30, endFrame: 90 }, baked, sound);
  const ac = r.audioClip;
  const acId = ac?.id ?? "";
  const linked = clipOf(host.id)?.linkGroupId;
  console.log(`       audio clip: ${JSON.stringify(ac && { start: ac.startFrame, in: ac.sourceInFrame, out: ac.sourceOutFrame, track: trackOf(acId)?.index })}`);
  // MUTATION: the start without the host clip's start → 30.
  // MUTATION: the window not limiting the length → the 30-frame window below gets 60 frames.
  check(!!ac && ac.startFrame === 60 && ac.sourceInFrame === 0 && ac.sourceOutFrame === 60 && ac.assetId === sound.id, `one audio clip over the window: timeline frame 60, 60 frames of the sound`);
  // MUTATION: no link group set → undefined.
  check(!!linked && ac?.linkGroupId === linked && r.graphic.audioClipId === acId && graphicOn(host.id)?.audioClipId === acId, `linked to the clip (a new group) and named by the graphic's audioClipId`);
  check(trackOf(acId)?.kind === "audio" && audioTracks() === 1 && soundClips().length === 1 && engine.getProject().assets.some((a) => a.id === sound.id), `on a new audio track (the project had none); the .wav is a library asset of its own`);

  // The first audio track free over the window, else a new one; a host already in a group keeps it.
  const r2 = engine.attachGraphic(host.id, { id: "gfx_two", assetId: baked.id, startFrame: 40, endFrame: 100 }, baked, sound);
  const r3 = engine.attachGraphic(host.id, { id: "gfx_three", assetId: baked.id, startFrame: 120, endFrame: 150 }, baked, sound);
  // MUTATION: free() always true → the overlapping second clip lands on the first track.
  check(
    trackOf(r2.audioClip?.id ?? "")?.id !== trackOf(acId)?.id && trackOf(r3.audioClip?.id ?? "")?.id === trackOf(acId)?.id && audioTracks() === 2,
    `an overlapping window goes to a new audio track, a free one to the first (${audioTracks()} audio tracks)`,
  );
  // MUTATION: always a new link group → the second clip's group differs.
  check(r2.audioClip?.linkGroupId === linked && r3.audioClip?.linkGroupId === linked && clipOf(host.id)?.linkGroupId === linked, `a clip already linked keeps its group, and the audio clips join it`);
  // The window's frames past the sound's length are not filled: r3's window is 30 frames.
  check(r3.audioClip?.sourceOutFrame === 30, `a 30-frame window: a 30-frame audio clip (${r3.audioClip?.sourceOutFrame})`);
  engine.undo();
  engine.undo();

  // The export and an audioOnly render: the tone at timeline [2.5, 3.5) s, silence elsewhere (the host has no sound).
  const timeline = async (name: string): Promise<{ full: Float32Array; audioOnly: Float32Array }> => {
    const out = join(f.dir, `${name}.mp4`);
    await engine.exportVideo(out);
    const { clips, cwd } = await (engine as unknown as Staging).stageRender(engine.canvas);
    const m4a = join(f.dir, `${name}-audio.m4a`);
    const cmd = buildRenderCommand(clips, engine.canvas, m4a, EXPORT_PROFILE, undefined, undefined, { audioOnly: true });
    await runFfmpeg(cmd.args, { cwd });
    return { full: pcm(out), audioOnly: pcm(m4a) };
  };
  const inside = (a: Float32Array, from: number, to: number) => {
    const m = measure(a, from, to);
    return m.rms > 0.01 && near(m.hz, 440, 0.03);
  };
  const silent = (a: Float32Array, from: number, to: number) => measure(a, from, to).rms < SILENT;
  const exp = await timeline("export");
  for (const [what, a] of [["export", exp.full], ["audioOnly", exp.audioOnly]] as const) {
    // MUTATION: attachGraphic placing no audio clip → silence inside the window.
    check(inside(a, 2.55, 3.45) && silent(a, 0.1, 2.4) && silent(a, 3.6, 6.9), `${what}: the graphic's sound inside its window (2.5-3.5 s), silence outside (${measure(a, 2.55, 3.45).rms.toFixed(5)} / ${measure(a, 0.1, 2.4).rms.toExponential(1)} / ${measure(a, 3.6, 6.9).rms.toExponential(1)})`);
  }

  // Moving the clip moves its sound (the link group).
  engine.moveClip(host.id, 90);
  check(clipOf(acId)?.startFrame === 120, `moving the clip by 60 frames moves the audio clip to 120 (${clipOf(acId)?.startFrame})`);
  engine.undo();

  // set_graphic_window moves and trims it.
  await dispatch(engine, "set_graphic_window", { clipId: host.id, graphicId: "gfx_ov", startFrame: 45, endFrame: 75 });
  const moved = clipOf(acId);
  // MUTATION: setGraphicWindow leaving the audio clip alone → still 60 / 60.
  check(moved?.startFrame === 75 && moved.sourceInFrame === 0 && moved.sourceOutFrame === 30, `set_graphic_window 45-75: the audio clip moves to 75 and is trimmed to 30 frames (${JSON.stringify(moved && [moved.startFrame, moved.sourceOutFrame])})`);
  // MUTATION: the sound's length not limiting it → 150 frames.
  await dispatch(engine, "set_graphic_window", { clipId: host.id, graphicId: "gfx_ov", startFrame: 30, endFrame: 400 });
  check(clipOf(acId)?.sourceOutFrame === 60, `a window longer than the sound: the audio clip stays the sound's 60 frames (${clipOf(acId)?.sourceOutFrame})`);
  await dispatch(engine, "set_graphic_window", { clipId: host.id, graphicId: "gfx_ov", startFrame: 170, endFrame: 230 });
  // MUTATION: graphicAudioSpan without the clip-end limit → 60 frames past the clip's end.
  check(clipOf(acId)?.startFrame === 200 && clipOf(acId)?.sourceOutFrame === 10, `a window running past the clip's end: the audio clip ends with the clip (10 frames: ${clipOf(acId)?.sourceOutFrame})`);
  await dispatch(engine, "set_graphic_window", { clipId: host.id, graphicId: "gfx_ov", startFrame: 185, endFrame: 200 });
  check(!clipOf(acId) && graphicOn(host.id)?.audioClipId === undefined, `a window past the clip's end: the audio clip is removed and audioClipId cleared`);
  for (let i = 0; i < 4; i++) engine.undo();
  setup(clipOf(acId)?.startFrame === 60 && clipOf(acId)?.sourceOutFrame === 60, "undo restores the audio clip");

  // remove_graphic and clear_graphics remove it, and the link group it made.
  for (const tool of ["remove_graphic", "clear_graphics"] as const) {
    await dispatch(engine, tool, tool === "remove_graphic" ? { clipId: host.id, graphicId: "gfx_ov" } : { clipId: host.id });
    // MUTATION: removeGraphic / clearGraphics not removing the audio clip → it stays.
    check(soundClips().length === 0 && clipOf(host.id)?.linkGroupId === undefined && !!clipOf(host.id), `${tool}: no clip of the sound is left, the clip is unlinked again and stays`);
    engine.undo();
  }
  setup(clipOf(acId)?.startFrame === 60, "undo restores the audio clip");

  // D-SPLIT, inside the window: split at timeline frame 90 (3.0 s), inside the tone.
  const split = (await dispatch(engine, "split_clip", { clipId: host.id, atFrame: 60 })) as { left: string; right: string };
  const kept = clipOf(acId);
  const left = clipOf(split.left);
  const right = clipOf(split.right);
  // MUTATION: the audio clip split with the group (no exclusion) → a second clip of the sound.
  check(soundClips().length === 1 && !!kept, `a split inside the window: one audio clip, the same id (${soundClips().map((c) => c.id).join(",")})`);
  // MUTATION: no trim after the split → it still ends at 120.
  check(kept?.startFrame === 60 && kept.sourceOutFrame === 30, `it ends at the split point, timeline frame 90 (${JSON.stringify(kept && [kept.startFrame, kept.sourceOutFrame])})`);
  // MUTATION: the trim clearing audioClipId → the left piece's graphic names no clip.
  check(left?.graphics?.[0]?.audioClipId === acId && !right?.graphics, `the left piece keeps the graphic and its audioClipId; the right piece has none`);
  const afterSplit = await timeline("split");
  for (const [what, a] of [["export", afterSplit.full], ["audioOnly", afterSplit.audioOnly]] as const) {
    check(inside(a, 2.55, 2.95) && silent(a, 3.05, 6.9) && silent(a, 0.1, 2.4), `${what} after the split: the sound up to the split (2.5-3.0 s), silence after it (${measure(a, 2.55, 2.95).rms.toFixed(5)} / ${measure(a, 3.05, 6.9).rms.toExponential(1)})`);
  }
  await dispatch(engine, "remove_graphic", { clipId: split.left, graphicId: "gfx_ov" });
  check(soundClips().length === 0, `remove_graphic on the left piece: no clip of the sound is left (${soundClips().length})`);
  engine.undo();
  engine.undo();

  // Before the window: the sound goes, audioClipId is cleared.
  const early = (await dispatch(engine, "split_clip", { clipId: host.id, atFrame: 15 })) as { left: string };
  // MUTATION: audioClipId not cleared → it names a clip that is gone.
  check(soundClips().length === 0 && clipOf(early.left)?.graphics?.[0] !== undefined && clipOf(early.left)?.graphics?.[0]?.audioClipId === undefined, `a split before the window: the audio clip is removed and audioClipId cleared`);
  engine.undo();
  // After the window: nothing changes.
  const late = (await dispatch(engine, "split_clip", { clipId: host.id, atFrame: 150 })) as { left: string };
  check(clipOf(acId)?.startFrame === 60 && clipOf(acId)?.sourceOutFrame === 60 && clipOf(late.left)?.graphics?.[0]?.audioClipId === acId, `a split after the window leaves the audio clip as it was`);
  engine.undo();

  // split_clip on the audio clip itself is refused, and changes nothing.
  const rev = engine.getProject().revision;
  let refused: Error | null = null;
  try {
    await dispatch(engine, "split_clip", { clipId: acId, atFrame: 10 });
  } catch (err) {
    refused = err as Error;
  }
  // MUTATION: no refusal in splitClip → the audio clip is split (two clips of the sound).
  check(
    !!refused && /split the clip the graphic is on/i.test(refused.message) && /set_graphic_window/.test(refused.message) && refused.message.includes(host.id) && engine.getProject().revision === rev && soundClips().length === 1,
    `split_clip on the audio clip: refused, naming the host clip and set_graphic_window, and nothing changes (${refused?.message})`,
  );

  // A muted audio track is not free: the sound would play silent there.
  engine.setTrackProperties(trackOf(acId)?.index ?? -1, { muted: true });
  const r4 = engine.attachGraphic(host.id, { id: "gfx_four", assetId: baked.id, startFrame: 120, endFrame: 150 }, baked, sound);
  // MUTATION: free() not testing muted → the sound goes on the muted track.
  check(!!r4.audioClip && trackOf(r4.audioClip.id)?.id !== trackOf(acId)?.id && !trackOf(r4.audioClip.id)?.muted, `a muted audio track is not free: the sound goes on a new track (track ${trackOf(r4.audioClip?.id ?? "")?.index})`);
  engine.undo();
  engine.undo();
  setup(soundClips().length === 1 && !trackOf(acId)?.muted, "undo restores the audio track");

  const allClips = () => engine.getProject().tracks.flatMap((t) => t.clips);
  const holders = () => allClips().filter((c) => c.graphics?.some((g) => g.id === "gfx_ov")).sort((p, q) => p.startFrame - q.startFrame);
  const span = (c: Clip | undefined) => JSON.stringify(c && [c.startFrame, c.sourceInFrame, c.sourceOutFrame]);
  const removeOnFirst = async (what: string) => {
    await dispatch(engine, "remove_graphic", { clipId: holders()[0]?.id, graphicId: "gfx_ov" });
    check(soundClips().length === 0, `${what}, then remove_graphic on the first piece: no clip of the sound is left (${soundClips().length})`);
    engine.undo();
  };

  // freeze_frame inside the window (clip-local 2.5 s, timeline frame 105): the graphic stays on the left piece, so the sound ends there (D-SPLIT).
  await engine.freezeFrame(host.id, 2.5, 1);
  // MUTATION: no exclusion in freezeFrame → the sound splits into two new clips; the graphic names neither.
  check(soundClips().length === 1 && holders()[0]?.graphics?.[0]?.audioClipId === acId, `freeze_frame inside the window: one audio clip, the same id, named by the left piece's graphic (${soundClips().map((c) => c.id).join(",")})`);
  // MUTATION: no trim after freezeFrame's split → it still ends at 120.
  check(clipOf(acId)?.startFrame === 60 && clipOf(acId)?.sourceOutFrame === 45, `it ends at the freeze point, timeline frame 105 (${span(clipOf(acId))})`);
  await removeOnFirst("freeze_frame");
  engine.undo();
  setup(clipOf(acId)?.sourceOutFrame === 60 && soundClips().length === 1, "undo restores the audio clip");
  // Before the clip's first frame (ripple 'track'): the clip and its graphic move by the still's length, and so does the sound.
  const still = await engine.freezeFrame(host.id, 0, 1);
  // MUTATION: freezeFrame's tracks without the sound's (built from the group less the graphic's sound) → it stays at 60.
  check(clipOf(acId)?.startFrame === 60 + still.durationFrames && clipOf(acId)?.sourceOutFrame === 60 && graphicOn(host.id)?.audioClipId === acId, `freeze_frame before the clip: the sound moves with it, by ${still.durationFrames} frames (${span(clipOf(acId))})`);
  engine.undo();
  setup(clipOf(acId)?.startFrame === 60, "undo restores the audio clip");

  // ripple_delete_ranges [80, 90) on the clip's track and the sound's: the graphic is on both pieces (copied, as before
  // the sound existed); its sound stays one clip and ends with the first piece.
  const hostTrack = trackOf(host.id)?.index ?? -1;
  const soundTrack = trackOf(acId)?.index ?? -1;
  engine.rippleDeleteRanges([{ trackIndex: hostTrack, startFrame: 80, endFrame: 90 }, { trackIndex: soundTrack, startFrame: 80, endFrame: 90 }]);
  // MUTATION: rippleDeleteRanges cutting the graphic's audio clip like any clip → two new clips of the sound.
  // MUTATION: no followGraphicAudio in rippleDeleteRanges → it runs on past the first piece, to 120.
  check(soundClips().length === 1 && clipOf(acId)?.startFrame === 60 && clipOf(acId)?.sourceOutFrame === 20, `ripple_delete_ranges inside the window: one audio clip, the same id, ending at 80 (${soundClips().map((c) => span(c)).join(",")})`);
  // MUTATION: the copy's audioClipId not cleared → both pieces name the sound.
  check(holders().length === 2 && holders()[0].graphics?.[0]?.audioClipId === acId && holders()[1].graphics?.[0]?.audioClipId === undefined, `the first piece's graphic names it, the copy on the second piece names no sound`);
  await removeOnFirst("ripple_delete_ranges");
  engine.undo();
  // A range before the clip, on its track only: the clip moves left, and its sound with it.
  engine.rippleDeleteRanges([{ trackIndex: hostTrack, startFrame: 0, endFrame: 20 }]);
  // MUTATION: followGraphicAudio not moving the sound → it stays at 60.
  check(clipOf(host.id)?.startFrame === 10 && clipOf(acId)?.startFrame === 40 && clipOf(acId)?.sourceOutFrame === 60, `ripple_delete_ranges before the clip: the sound moves with it to 40 (${span(clipOf(acId))})`);
  engine.undo();
  // A range over the whole clip, on its track only: the graphic goes with the clip, and so does its sound.
  engine.rippleDeleteRanges([{ trackIndex: hostTrack, startFrame: 30, endFrame: 210 }]);
  // MUTATION: followGraphicAudio keeping a sound whose graphic is gone → it stays.
  check(!clipOf(host.id) && soundClips().length === 0, `ripple_delete_ranges over the whole clip: no clip of the sound is left (${soundClips().length})`);
  engine.undo();
  setup(clipOf(acId)?.startFrame === 60 && clipOf(acId)?.sourceOutFrame === 60, "undo restores the audio clip");

  // cut_range [70, 80) of the clip: the left piece keeps the graphic and ends at 100; the sound ends there too.
  await dispatch(engine, "cut_range", { clipId: host.id, startFrame: 70, endFrame: 80 });
  // MUTATION: no followGraphicAudio in cutRange → it runs on to 120.
  check(soundClips().length === 1 && clipOf(acId)?.startFrame === 60 && clipOf(acId)?.sourceOutFrame === 40 && holders()[0]?.graphics?.[0]?.audioClipId === acId, `cut_range inside the window: one audio clip, the same id, ending with the left piece at 100 (${span(clipOf(acId))})`);
  engine.undo();
  const rev2 = engine.getProject().revision;
  let cutRefused: Error | null = null;
  try {
    await dispatch(engine, "cut_range", { clipId: acId, startFrame: 10, endFrame: 20 });
  } catch (err) {
    cutRefused = err as Error;
  }
  // MUTATION: no refusal in cutRange → the sound is cut into two new clips.
  check(!!cutRefused && /set_graphic_window/.test(cutRefused.message) && cutRefused.message.includes(host.id) && engine.getProject().revision === rev2 && soundClips().length === 1, `cut_range on the audio clip: refused, and nothing changes (${cutRefused?.message})`);

  // ripple_delete_ranges [40, 50) on the clip's track only, before the window: the graphic shows on the second piece
  // (its copy, window 30-90 from 40), so the sound goes there, to 70; the 10-frame first piece never shows it.
  engine.rippleDeleteRanges([{ trackIndex: hostTrack, startFrame: 40, endFrame: 50 }]);
  const [p1, p2] = holders();
  // MUTATION: followGraphicAudio keeping the sound on the earliest piece only → it is removed (that piece ends at 40).
  check(soundClips().length === 1 && clipOf(acId)?.startFrame === 70 && clipOf(acId)?.sourceOutFrame === 60 && p2?.startFrame === 40 && p2.graphics?.[0]?.audioClipId === acId && p1?.graphics?.[0]?.audioClipId === undefined, `ripple_delete_ranges before the window: the same audio clip, at 70, named by the second piece only (${span(clipOf(acId))})`);
  // MUTATION: removeGraphic not removing the audio clip → it stays.
  await dispatch(engine, "remove_graphic", { clipId: p2?.id, graphicId: "gfx_ov" });
  check(soundClips().length === 0, `ripple_delete_ranges before the window, then remove_graphic on the second piece: no clip of the sound is left (${soundClips().length})`);
  engine.undo();
  engine.undo();
  setup(clipOf(acId)?.startFrame === 60 && clipOf(acId)?.sourceOutFrame === 60, "undo restores the audio clip");

  // trim_clip out to 50 (the clip ends at 80): the sound ends there too; out to 25 (it ends at 55, before the window): it goes.
  await dispatch(engine, "trim_clip", { clipId: host.id, sourceOutFrame: 50 });
  // MUTATION: no followGraphicAudio in trimClip → it runs on to 120.
  check(soundClips().length === 1 && clipOf(acId)?.startFrame === 60 && clipOf(acId)?.sourceOutFrame === 20 && graphicOn(host.id)?.audioClipId === acId, `trim_clip out to 50: the same audio clip, ending with the clip at 80 (${span(clipOf(acId))})`);
  engine.undo();
  await dispatch(engine, "trim_clip", { clipId: host.id, sourceOutFrame: 25 });
  // MUTATION: followGraphicAudio not clearing audioClipId when no piece shows the window → it names a clip that is gone.
  check(soundClips().length === 0 && graphicOn(host.id) !== undefined && graphicOn(host.id)?.audioClipId === undefined, `trim_clip out to 25, before the window: the audio clip is removed and audioClipId cleared`);
  engine.undo();
  setup(clipOf(acId)?.startFrame === 60 && clipOf(acId)?.sourceOutFrame === 60, "undo restores the audio clip");

  // set_clip_speed on the clip: the graphic plays at 1x in its clip-local window (graph.ts), so its sound stays where it
  // was, at 1x, and ends no later than the clip.
  const fps = engine.getProject().fps;
  const sped = (await dispatch(engine, "set_clip_speed", { clipId: host.id, speed: 2 })) as { linked?: { clipId: string }[] };
  // MUTATION: speedPartners counting the graphic's audio clip → it moves to 45 at 2x, 30 frames, and is reported linked.
  check(clipOf(acId)?.startFrame === 60 && clipEndFrame(clipOf(acId)!, fps) === 120 && clipOf(acId)?.effects?.speed === undefined && !sped.linked?.some((l) => l.clipId === acId), `set_clip_speed 2 on the clip: the sound stays at 60-120, at 1x, not re-timed as a linked clip (${span(clipOf(acId))}, speed ${clipOf(acId)?.effects?.speed})`);
  engine.undo();
  await dispatch(engine, "set_clip_speed", { clipId: host.id, speed: 4 });
  // MUTATION: no followGraphicAudio in changeSpeed → it runs on to 120, past the clip's end at 75.
  check(clipEndFrame(clipOf(host.id)!, fps) === 75 && clipOf(acId)?.startFrame === 60 && clipOf(acId)?.sourceOutFrame === 15 && clipOf(acId)?.effects?.speed === undefined, `set_clip_speed 4 on the clip (it ends at 75): the sound ends with it, 15 frames at 1x (${span(clipOf(acId))})`);
  engine.undo();
  // set_clip_speed on the audio clip itself: the clip it follows is not re-timed, and the sound ends with the window.
  await dispatch(engine, "set_clip_speed", { clipId: acId, speed: 0.5 });
  // MUTATION: speedPartners of the graphic's audio clip naming the clip → the clip is slowed to 0.5x as its picture.
  check(clipOf(host.id)?.effects?.speed === undefined && clipEndFrame(clipOf(host.id)!, fps) === 210, `set_clip_speed 0.5 on the audio clip: the clip stays 1x, ending at 210 (speed ${clipOf(host.id)?.effects?.speed})`);
  // MUTATION: followGraphicAudio trimming to the clip's end, not the window's → it ends at 180.
  check(clipOf(acId)?.startFrame === 60 && clipEndFrame(clipOf(acId)!, fps) === 120, `set_clip_speed 0.5 on the audio clip: it ends with the window at 120 (${span(clipOf(acId))})`);
  engine.undo();
  setup(clipOf(acId)?.startFrame === 60 && clipOf(acId)?.sourceOutFrame === 60 && !clipOf(acId)?.effects?.speed, "undo restores the audio clip");

  // tighten_talk on a clip with words: a pause cut inside the window ends the sound with the first piece; the rest of the
  // sound's track (a clip of another file there) is not cut for it.
  const t = fresh(work, "tighten");
  const te = new EditorEngine(t.data);
  te.setProjectSettings({ width: 160, height: 90, fps: 30 });
  const talk = await te.importVideo(fx.talk);
  const other = await te.importVideo(fx.short);
  const words = [
    { text: "one", start: 0.2, end: 0.6 },
    { text: "two", start: 1.0, end: 2.3 },
    { text: "three", start: 4.0, end: 4.5 },
  ];
  (te as unknown as { setCachedTranscript(id: string, t: object): void }).setCachedTranscript(talk.id, { segments: [{ start: 0, end: 8, text: "one two three" }], words });
  const th = te.addClip(talk.id, { trackIndex: 0, startFrame: 30, sourceInFrame: 0, sourceOutFrame: 180 });
  const bedTrack = te.addTrack("audio");
  const bed = te.addClip(other.id, { trackIndex: bedTrack.index, startFrame: 200 });
  const ta = te.attachGraphic(th.id, { id: "gfx_t", assetId: baked.id, startFrame: 30, endFrame: 90 }, baked, sound).audioClip;
  const teClips = () => te.getProject().tracks.flatMap((x) => x.clips);
  const teSound = () => teClips().filter((c) => c.assetId === sound.id);
  setup(!!ta && te.getProject().tracks.find((x) => x.clips.some((c) => c.id === ta.id))?.id === bedTrack.id && ta.startFrame === 60, "the sound goes on the track with the other clip");
  const tight = await te.tightenTalk(th.id, { removeFillers: false });
  const first = teClips().filter((c) => c.graphics?.length).sort((p, q) => p.startFrame - q.startFrame)[0];
  const firstEnd = first ? first.startFrame + first.sourceOutFrame - first.sourceInFrame : -1;
  const kept2 = teSound()[0];
  setup(tight.cuts === 1 && firstEnd > 60 && firstEnd < 120, `tighten_talk cuts the long pause, inside the window (the first piece ends at ${firstEnd})`);
  // MUTATION: no followGraphicAudio in rippleDeleteRanges → it runs on to 120.
  check(teSound().length === 1 && kept2?.id === ta?.id && kept2.startFrame === 60 && 60 + kept2.sourceOutFrame === firstEnd && first?.graphics?.[0]?.audioClipId === ta?.id, `tighten_talk: one audio clip, the same id, ending with the first piece (${span(kept2)})`);
  // MUTATION: tighten_talk cutting the sound's track for it (linkedClips, not linkedWithoutGraphicAudio) → the other clip there moves left.
  check(teClips().find((c) => c.id === bed.id)?.startFrame === 200, `the other clip on the sound's track stays at 200 (${teClips().find((c) => c.id === bed.id)?.startFrame})`);
  te.removeGraphic(first?.id ?? "", "gfx_t");
  check(teSound().length === 0, `tighten_talk, then remove_graphic on the first piece: no clip of the sound is left (${teSound().length})`);
}

// ---- A5: failures ------------------------------------------------------------------

async function a5(work: string, lib: Record<string, MediaAsset>) {
  console.log("A5. failures: the mix's limit, a failed move, caps, an offline file...");
  const f = fresh(work, "fail");
  const bakedBefore = () => filesUnder(join(f.data, "baked")).sort().join(",");
  const before = bakedBefore();
  const graphic = { source: TSX(`<Audio src={asset("tone")} />`) };
  for (const alpha of [true, false]) {
    const id = alpha ? "slowov" : "slowcard";
    const run = await render(f, id, { alpha, graphic, durationInFrames: 30, assets: { tone: lib.tone }, limits: { mixMs: 1 }, previewPath: alpha ? join(f.data, "baked", `${id}-graphic.webm`) : undefined });
    // MUTATION: the timeout mapped to the FFmpeg error as it is → no graphic_mix_timeout.
    failedWith(run, "graphic_mix_timeout", `${alpha ? "an overlay" : "a card"}'s mix past its limit`, /Mixing the graphic's sound took longer/);
    // MUTATION: the encoded file moved into baked/ before the mix → the .mov/.mp4 is left there.
    check(bakedBefore() === before, `${alpha ? "overlay" : "card"}: baked/ is exactly as before (${bakedBefore()})`);
    await leftNothing(run, f, id, alpha ? "mix timeout (overlay)" : "mix timeout (card)");
  }
  // The .wav's move fails (its folder does not exist): the .mov already moved is taken back out.
  const moveRun = await render(f, "nomove", { alpha: true, graphic, durationInFrames: 30, assets: { tone: lib.tone }, audioPath: join(f.data, "nowhere", "x.wav") });
  // MUTATION: moveAll without the .wav (left in workDir) → the render succeeds.
  check(!!moveRun.error && bakedBefore() === before, `a failed move of the .wav: the render fails, baked/ is exactly as before (${moveRun.error?.message}; ${bakedBefore()})`);
  await leftNothing(moveRun, f, "nomove", "a failed move");

  // Caps through the renderer.
  const three = TSX(`<Sequence durationInFrames={10}><Audio src={asset("tone")} /></Sequence><Sequence from={10} durationInFrames={10}><Audio src={asset("tone")} volume={0.5} /></Sequence><Sequence from={20} durationInFrames={10}><Audio src={asset("tone")} volume={0.2} /></Sequence>`);
  const ranges = await render(f, "ranges", { graphic: { source: three }, durationInFrames: 30, assets: { tone: lib.tone }, audioCaps: { ranges: 2 } });
  failedWith(ranges, "graphic_audio_cues_cap", "3 ranges with a cap of 2", /more than 2 places/);
  await leftNothing(ranges, f, "ranges", "range cap");
  const two = TSX(`<Audio src={asset("tone")} /><Audio src={asset("short")} />`);
  const srcs = await render(f, "srcs", { graphic: { source: two }, durationInFrames: 10, assets: { tone: lib.tone, short: lib.short }, audioCaps: { sources: 1 } });
  failedWith(srcs, "graphic_audio_cues_cap", "2 audio files with a cap of 1", /more than 1 different audio files/);
  await leftNothing(srcs, f, "srcs", "source cap");

  // An audio file on a server the user has not allowed: refused when its first cue arrives, before any mix opens it.
  const evil = { ...lib.tone, path: "\\\\zr-evil-1.invalid\\s\\a.wav", name: "a.wav", awaitingServer: "zr-evil-1.invalid" };
  const t0 = touched.length;
  const s0 = spawned.length;
  const off = await render(f, "off", { graphic, durationInFrames: 10, assets: { tone: evil } });
  // MUTATION: requireMedia skipped in GraphicAudio.add → executor.ts's own gate refuses the path (ERR_PATH_BLOCKED), not media_offline.
  // MUTATION: the core stats the file before requireMedia → the zr-evil host is named.
  check(off.error?.code === "media_offline" && JSON.stringify(off.error.hosts) === JSON.stringify(["zr-evil-1.invalid"]), `an audio file on a server not allowed: media_offline naming the server (${off.error ? `${off.error.code}: ${off.error.message}` : "it rendered"})`);
  const named = [...touched.slice(t0), ...spawned.slice(s0).map((c) => c.join(" "))].filter((x) => x.includes(EVIL));
  check(named.length === 0, `no file call or command of the core named the zr-evil host (${JSON.stringify(named.slice(0, 3))})`);
  await leftNothing(off, f, "off", "offline audio");
}

// ---- A6: many pieces ---------------------------------------------------------------

async function a6(work: string, lib: Record<string, MediaAsset>) {
  console.log("A6. 200 ranges: the long graph stays in motion/<id>...");
  const f = fresh(work, "pieces");
  const t0 = touched.length;
  // Every second frame the source time jumps between the 440 Hz second and the 880 Hz one: a new range each time.
  const page = cuePage(`(n, A) => [{ sourceKey: "s", handle: A.two.handle, sourceTime: (Math.floor(n / 2) % 2) + (n % 2) / 30, volume: 1 }]`);
  const run = await render(f, "many", { page, durationInFrames: 400, width: 16, height: 16, assets: { two: lib.two } });
  check(!run.error && run.result?.audio.ranges === 200, `400 frames: 200 ranges, mixed (${why(run)})`);
  const work0 = join(f.data, "motion", "many");
  const graphs = touched.slice(t0).filter((x) => /filtergraph-/.test(x));
  // MUTATION: the mix run without cwd → its graph file goes to the OS temp folder.
  check(graphs.length > 0 && graphs.every((x) => x.split(" ").slice(1).every((p) => p.startsWith(`${work0}/`))), `the mix's graph file is written inside motion/many (${JSON.stringify(graphs.slice(0, 2))})`);
  const writes = touched
    .slice(t0)
    .filter((x) => /^(writeFile|appendFile|mkdir|copyFile|rename|cp) /.test(x))
    .flatMap((x) => x.split(" ").slice(1))
    .filter((p) => !p.startsWith(`${work0}/`) && p !== work0 && !p.endsWith("/baked/many-graphic.mp4") && p !== join(work0, "tmp"));
  check(writes.length === 0, `nothing written outside motion/many but the output (${JSON.stringify(writes.slice(0, 3))})`);
  const s = pcm(join(f.data, "baked", "many-graphic.mp4"));
  // Pieces of 440 Hz and 880 Hz by turns, all at the source's level: no gap, no overlap.
  const ref = measure(pcm(lib.two.path), 0.2, 0.8).rms;
  const got = [1, 5, 10].map((t) => measure(s, t, t + 1));
  // MUTATION: adelay of every second piece of a source dropped (asplit branch index) → gaps and overlaps change the level.
  check(
    got.every((m) => near(m.rms / ref, 1, 0.03) && near(m.hz, 660, 0.05)),
    `every piece plays: ${got.map((m) => `${(m.rms / ref).toFixed(3)} of the source at ${m.hz.toFixed(0)} Hz`).join(", ")} at 1, 5 and 10 s (want 1.000 at ~660 Hz)`,
  );
  await leftNothing(run, f, "many", "200 ranges");
}

// ---- main ----------------------------------------------------------------------------

let summarized = false;

async function main() {
  const args = process.argv.slice(2);
  reexecInNetns(fileURLToPath(import.meta.url), args, "10.98.0.1");
  const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
  const part = (name: string) => !only || only.includes(name);
  if (part("A1")) a1();
  if (!LINUX) {
    console.log("  skip A2-A6: they read /proc and run Linux's Electron");
  } else if (!only || only.some((p) => p !== "A1")) {
    const work = mkdtempSync(join(tmpdir(), "zr-motion-audio-"));
    try {
      const fx = fixtures(work);
      const lib: Record<string, MediaAsset> = {};
      for (const [k, p] of Object.entries({ tone: fx.tone, short: fx.short, two: fx.two, vid: fx.vid })) lib[k] = await probeAsset(p);
      if (part("A2")) await a2(work, lib);
      if (part("A3")) await a3(work, lib);
      if (part("A4")) await a4(work, fx, lib);
      if (part("A5")) await a5(work, lib);
      if (part("A6")) await a6(work, lib);
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 5 });
    }
  }
  summarized = true;
  const failures = failureCount();
  console.log(failures === 0 ? "\nALL MOTION AUDIO CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// The event loop drained before the summary (a promise that never settles): a failure, never exit 0.
process.on("beforeExit", () => {
  if (summarized) return;
  console.log("\nthe smoke ended before its summary");
  process.exit(1);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
