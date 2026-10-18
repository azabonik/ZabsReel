/**
 * Media parity: library video, images and audio (MOTION-PLAN D8 "Media" and
 * "Audio"; decisions.md MEDIA PARITY BATCH and its REFERENCE-SIDE NOTE, PARITY
 * POLICY, R-PARITY-SCHEMA). A dev tool, not shipped.
 *
 * Fixtures. The media batch's compositions name the assets of FIXTURES.md by
 * id (asset("vid_a")). Each run generates them with FFmpeg's own sources (no
 * download, no font lookup) into its scratch folder and records their sha256:
 *  - videos: testsrc stepped one picture per frame, so its own counter shows
 *    the frame number and its gradient bar moves every frame (one frame off
 *    fails D8 on about 13 % of the pixels); H.264 yuv420p, BT.709 tagged,
 *    limited range, one keyframe per second and no B-frames, one encoder
 *    thread (x264 output depends on the thread count); vid_a has a constant
 *    stereo 440 Hz tone (AAC);
 *  - images: testsrc2 (img_a PNG, img_b JPEG; img_c PNG with alpha 255 inside
 *    a circle, 128 in a ring around it and 0 outside);
 *  - audio (WAV, 48 kHz, sample-exact): aud_a a 100 ms 1 kHz beep at every
 *    whole second (stereo, 8 s), aud_b a mono 220 Hz tone (2.5 s);
 *  levels 0.5 (peak) throughout.
 *
 * Each composition (header as parity-render.ts's, plus `// audio: yes|no`)
 * is rendered through both pipelines, each in its own child process with fresh
 * HOME/USERPROFILE/XDG_CONFIG_HOME/AIVE_DATA_DIR/TMPDIR folders and no sound
 * device:
 *  - reference: Remotion 4.0.481 of this checkout called directly (its
 *    bundler and renderer, public API only), NOT ZabsReel's guarded add-on
 *    path, which refuses library media. The scaffold is the add-on path's
 *    (Root and entry), with a public folder holding the fixtures and the
 *    source rewritten on this side only: asset("<id>") becomes
 *    staticFile("<id>.<ext>") and the import names staticFile instead of
 *    asset. Its browser is the pinned headless shell (never a download),
 *    started through a wrapper that adds --mute-audio; its server takes a
 *    port in 5030-5039; the render keeps its sound (not Remotion's muted).
 *  - zabsreel: renderMotion with the graphic {source, props: {}} and the
 *    fixtures as the project library describes them (probeAsset), keyed by id;
 *    rendered twice (the repeat: the same job in its own child), because its
 *    frames of library media were not always the same from one render to the
 *    next (finding ZR-MEDIA-SETTLE: a frame captured before the requested
 *    source frame is painted, blank or the previous source frame; fixed in
 *    slice 4f, so a frame the two renders differ on is now a regression).
 * Both render every frame as an overlay (ProRes 4444 with alpha). Frames: the
 * header's frames, compared as parity-render.ts does (D8: pct_within_4 >= 99.5
 * and max_diff <= 32). Audio, for `audio: yes`: the reference's sound track and
 * ZabsReel's overlay .wav (no file or no track is silence), decoded by the same
 * FFmpeg to 48 kHz stereo floats over the composition's length, then:
 *  - rms_db_max_diff: the largest difference, over 20 ms windows and both
 *    channels, of the windows' RMS level in dBFS, each clamped at -40 dBFS
 *    (below it both sides count as silence); windows at and next to a start
 *    or end of sound on either side are left out, so a sub-window timing
 *    difference is measured once, by the second metric, and not again as a
 *    level jump;
 *  - onset_ms_max_diff: each start and end of sound (a sample above 0.01,
 *    -40 dBFS, after / before at least 20 ms below it, both channels), paired
 *    in order; a different count is a mismatch of its own ("edges a:b").
 *  The rule, AUDIO: rms_db_max_diff <= 1 dB and onset_ms_max_diff <= 5 ms.
 *  Why: 1 dB is about the smallest level difference a listener notices, so a
 *  volume or curve difference that can be heard fails while codec and
 *  resampling noise (well under 0.1 dB on these steady tones) passes; 5 ms is
 *  under a third of a frame at 60 fps (16.7 ms) and a sixth at 30 fps, so a
 *  whole-frame timing difference always fails, while encoder delays the
 *  decoders remove and resampler delays (under 1 ms) pass.
 * Repeatability: each frame of ZabsReel's render is compared with the same
 * frame of its repeat, and its sound with the repeat's; a frame that is not
 * pixel-identical (or a sound that is not 0/0) is nondeterministic. The repeat
 * is also compared with the reference. Where the two renders get different
 * verdicts (one passes the rule, the other fails), the row's actual is exactly
 * "zabsreel nondeterministic": the two samples disagree on whether there is a
 * behaviour difference. Where both fail, the row is a mismatch with the first
 * render's metric, since both samples show the difference. The frames that
 * differ are a lower bound on the renderer's nondeterminism, not its full
 * extent, and the identical ones are not a noise floor: a frame both renders
 * get wrong the same way counts as identical.
 *
 * Writes to --out: render-all.jsonl / render-mismatches.jsonl (frame rows) and
 * audio-all.jsonl / audio-mismatches.jsonl (one audio row per composition and
 * size), each row exactly {case, function, size, input, metric, expected,
 * actual, spec, why} (R-PARITY-SCHEMA: never the reference's error text; a
 * composition the reference fails to render is "reference refused (drift
 * candidate)" in its frame and audio rows; a "zabsreel nondeterministic" row is
 * in the -all file only, never in a -mismatches file, so it never reaches a
 * feedback round); images/<case>/<size>/ with the two decoded frames and a
 * heatmap of each failing or nondeterministic frame (and the repeat's frame of
 * the latter), and audio.json with each side's window levels and edges (for the
 * orchestrator only); render-summary.json with every metric (each frame's and
 * sound's repeat metrics too: against ZabsReel's first render and against the
 * reference), zabsreelRepeat (how many frames and sounds the two ZabsReel
 * renders agree on, how the others split, and every nondeterministic frame and
 * sound with its verdicts), the fixtures (sha256 and probe), the media baseline
 * (offthread-plain, video-plain, img-sizes: plain mapping and sizing, so their
 * numbers show how far the two decodes of the same pictures differ), timing,
 * the error texts and the versions.
 *
 * Exit: 0 every frame and audio row passes; 2 a pipeline could not render a
 * composition (named on stderr; the other rows are still written); 3 every
 * composition rendered and some rows fail or are nondeterministic; 1 the harness
 * itself failed.
 *
 * --self-test (to --out): the run is offline (only loopback; the NETNS variable
 * alone is not taken for it); referenceSource
 * rewrites; compareAudio() on known signals; the fixtures are generated twice
 * with equal sha256 and probe as FIXTURES.md lists them (img_c with alpha), with every frame
 * distinct from its neighbours and the beeps where they belong; no sound file
 * or no sound track is silence; a self-test
 * composition (video, image, beeps) rendered through ZabsReel on both sides
 * passes with 100/0 frames and 0/0 audio, its repeat identical; with a brighter
 * background and half the volume on the second side (and its repeat) only,
 * every frame and the audio row fail, nothing is nondeterministic, each side's
 * image shows its own background and each side's level is its own; the
 * same composition through the real reference has the beeps where they belong,
 * and its browser ran with --mute-audio; one only the reference side refuses is
 * exactly "reference refused (drift candidate)" in every row; one whose repeat
 * alone differs (the first render passes, the repeat fails), and one whose
 * second side alone differs (the first render fails, the repeat passes), is
 * "zabsreel nondeterministic" in every row, in no mismatches file, listed in
 * the summary, and exits 3; one whose second side and repeat differ from the
 * reference and from each other (both fail) is a mismatch in every row, with
 * the first render's metric and the repeat's against the reference, and is
 * counted as both failing; one whose repeat differs by one step (both pass)
 * passes and exits 0.
 *
 * Linux only; the whole run re-executes itself in a private network namespace
 * (loopback only). Needs `npm run build` (dist/zr-runtime.js) and FFmpeg with
 * libx264.
 * Run: npx tsx packages/motion/scripts/parity-media.ts --out=<folder>
 *        [--cases=<folder of .tsx>] [--only=offthread-plain.tsx,audio-two.tsx]
 *        [--scratch=<folder>] [--require-netns] [--self-test]
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { networkInterfaces, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { bundle as Bundle } from "@remotion/bundler";
import type { renderMedia as RenderMedia } from "@remotion/renderer";
import type { MediaAsset } from "../../core/src/types.js";
import { compare, decodeFrames, DRIFT, type Fixture, FIXTURES, fmt, generateFixtures, heatmap, inPrivateNetns, leftovers, type Metrics, NETNS, offline, type Outcome, parseHeader, REPO, RULE, runPipeline, SHELL, versions, writePng } from "./parity-lib.js";

const SELF = fileURLToPath(import.meta.url);
const CASES = join(REPO, "packages", "motion", "parity", "media", "compositions");
/** Cases of plain mapping and sizing, reported apart as the media baseline. */
const BASELINE = ["offthread-plain.tsx", "video-plain.tsx", "img-sizes.tsx"];
/** A row whose ZabsReel frame or sound differs between two renders of the same job, one passing against the reference and one failing. */
export const NONDET = "zabsreel nondeterministic";
/** The finding behind NONDET, as the summary names it. */
const SETTLE = "ZR-MEDIA-SETTLE: ZabsReel's renderer captured some frames of library media before the requested source frame was painted (a blank frame, the previous source frame or part of one), differently from one render to the next, because Chromium let the page's next frame start before the last one was rastered and drawn. Fixed in slice 4f (motion-renderer.cjs's compositor switches and loader.js's wait for every image's decode; smoke-motion-settle.ts), so every frame or sound listed in zabsreelRepeat.nondeterministic is a regression of that fix. A frame both renders capture the same wrong way is not detected by the repeat and is an ordinary mismatch row.";

type Pipeline = "reference" | "zabsreel";
/** The two ZabsReel renders' verdicts against the reference, for a frame or sound they differ on. */
type Verdict = "both pass" | "split" | "both fail";

/** The project library's record of each fixture (probeAsset, as an import does), keyed by id. */
async function libraryOf(fixtures: Fixture[]): Promise<Record<string, MediaAsset>> {
  const { probeAsset } = await import("../../core/src/ffmpeg/ffprobe.js");
  const lib: Record<string, MediaAsset> = {};
  for (const f of fixtures) lib[f.id] = await probeAsset(f.file);
  return lib;
}

/** How each fixture differs from FIXTURES.md, as probed (an empty list: it matches). */
function fixtureProblems(fixtures: Fixture[], lib: Record<string, MediaAsset>): string[] {
  const out: string[] = [];
  for (const spec of FIXTURES) {
    const a = lib[spec.id];
    const file = fixtures.find((f) => f.id === spec.id)!.file;
    const say = (what: string, got: unknown, want: unknown) => got !== want && out.push(`${spec.id}: ${what} ${String(got)}, not ${String(want)}`);
    say("hasAudio", a.hasAudio, spec.hasAudio);
    if (spec.kind === "audio") {
      say("hasVideo", a.hasVideo, false);
      say("duration", a.duration, spec.seconds);
    } else {
      say("width", a.width, spec.width);
      say("height", a.height, spec.height);
      say("isImage", !!a.isImage, spec.kind === "image");
    }
    if (spec.kind === "video") {
      say("fps", a.fps, spec.fps);
      // validAsset's frame count (motionmedia.ts) and the pictures actually in the file.
      say("frame count", Math.round(a.duration * a.fps), spec.fps! * spec.seconds!);
      const n = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", file], { encoding: "utf8" });
      say("pictures", Number(n.stdout.trim()), spec.fps! * spec.seconds!);
    }
    if (spec.pixFmt) {
      const p = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", file], { encoding: "utf8" });
      say("pixel format", p.stdout.trim(), spec.pixFmt);
    }
    if (spec.channels) {
      const c = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels,sample_rate", "-of", "csv=p=0", file], { encoding: "utf8" });
      say("sample rate and channels", c.stdout.trim(), `48000,${spec.channels}`);
    }
  }
  return out;
}

// ---- the reference side's source -----------------------------------------------------------

/**
 * The composition as the reference renders it: each asset("<id>") becomes
 * staticFile("<id>.<ext>") (the fixture in its public folder) and the import
 * from "remotion" names staticFile instead of asset. Throws on an id no
 * fixture has, and when an asset( call or the asset import is left.
 */
export function referenceSource(tsx: string, ext: Record<string, string>): string {
  let out = tsx.replace(/\basset\(\s*(["'])([^"']+)\1\s*\)/g, (_m, _q: string, id: string) => {
    if (!ext[id]) throw new Error(`no fixture for asset("${id}")`);
    return `staticFile(${JSON.stringify(`${id}.${ext[id]}`)})`;
  });
  out = out.replace(/import\s*\{([^}]*)\}\s*from\s*(["'])remotion\2;?/, (_m, names: string) => {
    const list = names.split(",").map((s) => s.trim()).filter((s) => s && s !== "asset");
    if (!list.includes("staticFile")) list.push("staticFile");
    return `import {${list.join(", ")}} from "remotion";`;
  });
  if (/\basset\s*\(/.test(out) || /import\s*\{[^}]*\basset\b[^}]*\}\s*from/.test(out)) throw new Error("an asset() call or import is left after the rewrite");
  return out;
}

// ---- audio ---------------------------------------------------------------------------------

export const AUDIO_RULE = { rate: 48000, windowMs: 20, floorDb: -40, threshold: 0.01, gapMs: 20, rmsDb: 1, onsetMs: 5 };
const WINDOW = (AUDIO_RULE.rate * AUDIO_RULE.windowMs) / 1000;
/** Two channels of 48 kHz samples. */
export type Pcm = [Float32Array, Float32Array];

/** `file`'s first sound track, decoded by FFmpeg to 48 kHz stereo floats, cut or padded with silence to `samples`; no file or no track: silence. */
function decodeAudio(file: string | undefined, samples: number): { pcm: Pcm; channels: number } {
  const pcm: Pcm = [new Float32Array(samples), new Float32Array(samples)];
  if (!file) return { pcm, channels: 0 };
  const p = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", file], { encoding: "utf8" });
  if (p.status !== 0) throw new Error(`ffprobe could not read ${basename(file)}`);
  const channels = Number(p.stdout.trim() || 0);
  if (!channels) return { pcm, channels: 0 };
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-map", "0:a:0", "-ac", "2", "-ar", String(AUDIO_RULE.rate), "-f", "f32le", "pipe:1"], { maxBuffer: samples * 8 + (64 << 20) });
  if (r.status !== 0) throw new Error(`FFmpeg could not decode the sound of ${basename(file)}: ${String(r.stderr).trim().split("\n").pop()}`);
  const n = Math.min(samples, Math.floor(r.stdout.length / 8));
  for (let i = 0; i < n; i++) {
    pcm[0][i] = r.stdout.readFloatLE(8 * i);
    pcm[1][i] = r.stdout.readFloatLE(8 * i + 4);
  }
  return { pcm, channels };
}

/** Each 20 ms window's RMS level in dBFS, clamped at the floor. */
function levels(ch: Float32Array): number[] {
  const out: number[] = [];
  for (let s = 0; s < ch.length; s += WINDOW) {
    const e = Math.min(ch.length, s + WINDOW);
    let sum = 0;
    for (let i = s; i < e; i++) sum += ch[i] * ch[i];
    out.push(Math.max(AUDIO_RULE.floorDb, 20 * Math.log10(Math.sqrt(sum / (e - s)))));
  }
  return out;
}

/** Sample index of each start and end of sound (either channel above the threshold), ends after a 20 ms gap. */
function soundEdges(pcm: Pcm): number[] {
  const gap = (AUDIO_RULE.rate * AUDIO_RULE.gapMs) / 1000;
  const out: number[] = [];
  let last = -1;
  let on = false;
  for (let i = 0; i < pcm[0].length; i++) {
    if (Math.max(Math.abs(pcm[0][i]), Math.abs(pcm[1][i])) > AUDIO_RULE.threshold) {
      if (!on) out.push(i);
      on = true;
      last = i;
    } else if (on && i - last > gap) {
      out.push(last + 1);
      on = false;
    }
  }
  if (on) out.push(last + 1);
  return out;
}

export interface AudioMetrics {
  rms_db_max_diff: number;
  /** null: the two sides have a different number of starts and ends of sound. */
  onset_ms_max_diff: number | null;
  /** Each side's starts and ends of sound, in ms. */
  edges: [number[], number[]];
  /** Each side's loudest window, dBFS. */
  loudest: [number, number];
  /** Windows compared (the others are at a start or end of sound). */
  windows: number;
  pass: boolean;
}

const ms = (samples: number) => Math.round((samples * 1e5) / AUDIO_RULE.rate) / 100;

/** Two sounds of the same length (AUDIO rule in the header). */
export function compareAudio(a: Pcm, b: Pcm): AudioMetrics {
  const ea = soundEdges(a);
  const eb = soundEdges(b);
  const skip = new Set<number>();
  for (const e of [...ea, ...eb]) for (const d of [-1, 0, 1]) skip.add(Math.floor(e / WINDOW) + d);
  let rms = 0;
  let windows = 0;
  const loudest: [number, number] = [AUDIO_RULE.floorDb, AUDIO_RULE.floorDb];
  for (let c = 0; c < 2; c++) {
    const la = levels(a[c]);
    const lb = levels(b[c]);
    for (let k = 0; k < la.length; k++) {
      loudest[0] = Math.max(loudest[0], la[k]);
      loudest[1] = Math.max(loudest[1], lb[k]);
      if (skip.has(k)) continue;
      if (c === 0) windows++;
      rms = Math.max(rms, Math.abs(la[k] - lb[k]));
    }
  }
  const onset = ea.length === eb.length ? Math.max(0, ...ea.map((x, i) => Math.abs(x - eb[i]))) : null;
  const metrics = {
    rms_db_max_diff: Math.round(rms * 100) / 100,
    onset_ms_max_diff: onset === null ? null : ms(onset),
    edges: [ea.map(ms), eb.map(ms)] as [number[], number[]],
    loudest: loudest.map((v) => Math.round(v * 100) / 100) as [number, number],
    windows,
  };
  return { ...metrics, pass: metrics.onset_ms_max_diff !== null && metrics.onset_ms_max_diff <= AUDIO_RULE.onsetMs && metrics.rms_db_max_diff <= AUDIO_RULE.rmsDb };
}

const fmtAudio = (m: AudioMetrics) => `${m.rms_db_max_diff}/${m.onset_ms_max_diff ?? `edges ${m.edges[0].length}:${m.edges[1].length}`}`;
const AUDIO_EXPECTED = `AUDIO: <=${AUDIO_RULE.rmsDb} dB (${AUDIO_RULE.windowMs} ms RMS windows, floor ${AUDIO_RULE.floorDb} dBFS) / <=${AUDIO_RULE.onsetMs} ms (each start and end of sound)`;

// ---- one side, in a child process -----------------------------------------------------------

interface Job {
  pipeline: Pipeline;
  source: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  fixtures: Fixture[];
  /** The project library's records (zabsreel side). */
  library: Record<string, MediaAsset>;
  /** The child's folder: home/, data/ (AIVE_DATA_DIR, with baked/), tmp/; results in data/baked/. */
  dir: string;
}

/** The browser wrapper's log of every launch's arguments. */
const BROWSER_LOG = "browser-args.txt";

/** A free port in 5030-5039 (the ports this harness may open; in the private namespace they are its own). */
function port(): Promise<number> {
  const tryPort = (p: number): Promise<number> =>
    new Promise((ok, fail) => {
      if (p > 5039) return fail(new Error("no free port in 5030-5039"));
      const srv = createServer();
      srv.once("error", () => tryPort(p + 1).then(ok, fail));
      srv.listen(p, "127.0.0.1", () => srv.close(() => ok(p)));
    });
  return tryPort(5030);
}

/** The reference: this checkout's Remotion bundler and renderer, called directly (public API), with the fixtures in the public folder. */
async function referenceRender(job: Job, mov: string): Promise<void> {
  const { graphicComposition, rootSource } = await import("../../core/src/motion/render.js");
  const src = join(job.dir, "src");
  const publicDir = join(job.dir, "public");
  mkdirSync(src, { recursive: true });
  mkdirSync(publicDir, { recursive: true });
  for (const f of job.fixtures) copyFileSync(f.file, join(publicDir, `${f.id}.${f.ext}`));
  const opts = { code: "", width: job.width, height: job.height, fps: job.fps, durationInFrames: job.durationInFrames, outPath: mov, workDir: src };
  writeFileSync(join(src, "Graphic.tsx"), referenceSource(job.source, Object.fromEntries(job.fixtures.map((f) => [f.id, f.ext]))));
  writeFileSync(join(src, "Root.tsx"), rootSource(opts));
  writeFileSync(join(src, "index.ts"), 'import { registerRoot } from "remotion";\nimport { RemotionRoot } from "./Root";\nregisterRoot(RemotionRoot);\n');
  // Silent tests: every launch of the pinned shell gets --mute-audio (and is logged).
  const browser = join(job.dir, "browser.sh");
  writeFileSync(browser, `#!/bin/sh\nprintf '%s\\n' "$0" --mute-audio "$@" >> '${join(job.dir, BROWSER_LOG)}'\nexec '${SHELL}' --mute-audio "$@"\n`, { mode: 0o755 });

  // Loaded here only: the parent process never loads Remotion.
  const req = createRequire(join(REPO, "package.json"));
  const { bundle } = req("@remotion/bundler") as { bundle: typeof Bundle };
  const { renderMedia } = req("@remotion/renderer") as { renderMedia: typeof RenderMedia };
  const modules = join(REPO, "node_modules");
  const serveUrl = await bundle({
    entryPoint: join(src, "index.ts"),
    publicDir,
    enableCaching: false,
    // The scaffold is outside the checkout's node_modules tree: react and remotion resolve from it.
    webpackOverride: (config) => ({ ...config, resolve: { ...config.resolve, modules: [modules, ...((config.resolve && config.resolve.modules) || ["node_modules"])] } }),
  });
  await renderMedia({
    composition: graphicComposition(opts),
    serveUrl,
    port: await port(),
    browserExecutable: browser,
    onBrowserDownload: () => {
      throw new Error("the parity harness never downloads a browser");
    },
    chromeMode: "headless-shell",
    codec: "prores",
    proResProfile: "4444",
    pixelFormat: "yuva444p10le",
    imageFormat: "png",
    colorSpace: "default",
    outputLocation: mov,
    inputProps: {},
    logLevel: "error",
  });
}

/** The child: one render through `job.pipeline`; writes result.json in its folder. */
async function child(jobFile: string): Promise<void> {
  const job = JSON.parse(readFileSync(jobFile, "utf8")) as Job;
  const data = join(job.dir, "data");
  const mov = join(data, "baked", "graphic.mov");
  const t0 = Date.now();
  let out: Outcome;
  try {
    if (job.pipeline === "reference") {
      await referenceRender(job, mov);
      out = { ok: true, mov, audio: mov, ms: Date.now() - t0 };
    } else {
      const { renderMotion } = await import("../../core/src/motion/rendermotion.js");
      const res = await renderMotion({
        width: job.width, height: job.height, fps: job.fps, durationInFrames: job.durationInFrames, alpha: true, outPath: mov,
        audioPath: join(data, "baked", "graphic-audio.wav"),
        graphic: { source: job.source, props: {} },
        assets: job.library,
        workDir: join(data, "motion", "parity"),
      });
      out = { ok: true, mov, audio: res.audioPath, ms: Date.now() - t0 };
    }
  } catch (err) {
    const e = err as Error & { code?: unknown };
    out = { ok: false, error: `${e.name}: ${e.message}`, code: typeof e.code === "string" ? e.code : undefined, ms: Date.now() - t0 };
  }
  writeFileSync(join(job.dir, "result.json"), JSON.stringify(out));
}

// ---- one composition --------------------------------------------------------------------

interface Row {
  case: string;
  function: "render" | "audio";
  size: string;
  input: string;
  metric: "pct_within_4/max_diff" | "rms_db_max_diff/onset_ms_max_diff";
  expected: string;
  actual: string;
  spec: string;
  why: string;
}

type Side = Outcome & { browserArgs?: string[]; channels?: number };

interface SizeResult {
  size: string;
  reference: Side;
  zabsreel: Side;
  /** ZabsReel's second render of the same job. */
  repeat: Side;
  /**
   * repeat: this frame against the repeat's; repeatReference: the reference's against the
   * repeat's; nondeterministic: the two ZabsReel renders differ at all; split: they get
   * different verdicts against the reference (the row is NONDET, in no mismatches file).
   */
  frames: ({ frame: number; repeat: Metrics; repeatReference: Metrics; nondeterministic: boolean; split: boolean } & Metrics)[];
  audio?: AudioMetrics & { repeat: AudioMetrics; repeatReference: AudioMetrics; nondeterministic: boolean; split: boolean };
  /** A decode failure after both rendered. */
  error?: string;
}

interface CaseResult {
  case: string;
  spec: string;
  why: string;
  audio: boolean;
  status: "pass" | typeof NONDET | "mismatch" | typeof DRIFT | "zabsreel failed" | "harness error";
  sizes: SizeResult[];
}

interface Run {
  out: string;
  scratch: string;
  fixtures: Fixture[];
  library: Record<string, MediaAsset>;
  /** Which pipeline renders each side (the self-test renders ZabsReel on both). */
  sides: { reference: Pipeline; zabsreel: Pipeline };
  /** Self-test: change one side's composition before it renders (the header is read from the original). */
  sourceA?: (tsx: string) => string;
  sourceB?: (tsx: string) => string;
  /** Self-test: change the repeat's source (after sourceB) before it renders. */
  sourceRepeat?: (tsx: string) => string;
}

const FILES = ["render-all.jsonl", "render-mismatches.jsonl", "audio-all.jsonl", "audio-mismatches.jsonl"];

function rowsFile(run: Run, name: string, rows: Row[]): void {
  if (rows.length) appendFileSync(join(run.out, name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** What the reference's browser wrapper logged (the parent reads it before the child folder goes). */
function browserArgs(side: Outcome): string[] | undefined {
  if (!side.ok) return undefined;
  const log = join(dirname(dirname(dirname(side.mov))), BROWSER_LOG);
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : undefined;
}

/** Render `file` at each header size through both sides, compare frames and sound, append its rows. */
async function runCase(run: Run, file: string, source = readFileSync(file, "utf8")): Promise<CaseResult> {
  const name = basename(file);
  const header = parseHeader(source);
  const result: CaseResult = { case: name, spec: header.spec, why: header.why, audio: header.audio, status: "pass", sizes: [] };
  const rows: Row[] = [];
  const mismatches: Row[] = [];
  const audioRows: Row[] = [];
  const audioMismatches: Row[] = [];
  for (const { w, h } of header.sizes) {
    const size = `${w}x${h}`;
    const job = { source, width: w, height: h, fps: header.fps, durationInFrames: header.durationInFrames, fixtures: run.fixtures, library: run.library };
    const tag = `${name.replace(/\.tsx$/, "")}-${size}`;
    const sourceB = run.sourceB?.(source) ?? source;
    const [a, b, c] = await Promise.all([
      runPipeline(SELF, run.scratch, `${tag}-a`, { ...job, source: run.sourceA?.(source) ?? source, pipeline: run.sides.reference }),
      runPipeline(SELF, run.scratch, `${tag}-b`, { ...job, source: sourceB, pipeline: run.sides.zabsreel }),
      runPipeline(SELF, run.scratch, `${tag}-c`, { ...job, source: run.sourceRepeat?.(sourceB) ?? sourceB, pipeline: run.sides.zabsreel }),
    ]);
    const reference: Side = { ...a, browserArgs: browserArgs(a) };
    const zabsreel: Side = { ...b, browserArgs: browserArgs(b) };
    const sized: SizeResult = { size, reference, zabsreel, repeat: { ...c, browserArgs: browserArgs(c) }, frames: [] };
    result.sizes.push(sized);
    const row = (n: number, actual: string): Row => ({ case: name, function: "render", size, input: `frame ${n}`, metric: "pct_within_4/max_diff", expected: `D8: >=${RULE.pct} / <=${RULE.max}`, actual, spec: header.spec, why: header.why });
    const audioRow = (actual: string): Row => ({ case: name, function: "audio", size, input: `audio 0-${header.durationInFrames - 1}`, metric: "rms_db_max_diff/onset_ms_max_diff", expected: AUDIO_EXPECTED, actual, spec: header.spec, why: header.why });
    let failed: string | undefined;
    // Either ZabsReel render failing is a ZabsReel failure (the summary's zabsreel and repeat say which).
    const zf = !b.ok ? b : !c.ok ? c : undefined;
    if (!a.ok) failed = zf ? `${DRIFT}; zabsreel failed: ${zf.code ?? "error"}` : DRIFT;
    else if (zf) failed = `zabsreel failed: ${zf.code ?? "error"}`;
    const dir = join(run.out, "images", name.replace(/\.tsx$/, ""), size);
    if (!failed && a.ok && b.ok && c.ok) {
      try {
        const fa = decodeFrames(a.mov, w, h, header.frames);
        const fb = decodeFrames(b.mov, w, h, header.frames);
        const fc = decodeFrames(c.mov, w, h, header.frames);
        for (const n of header.frames) {
          const m = compare(fa.get(n)!, fb.get(n)!);
          const again = compare(fb.get(n)!, fc.get(n)!);
          const repeatReference = compare(fa.get(n)!, fc.get(n)!);
          const nondeterministic = again.max_diff > 0;
          // Both renders failing is a mismatch (both samples show it); only a split verdict is NONDET.
          const split = nondeterministic && m.pass !== repeatReference.pass;
          sized.frames.push({ frame: n, ...m, repeat: again, repeatReference, nondeterministic, split });
          const r = row(n, split ? NONDET : fmt(m));
          rows.push(r);
          if (!m.pass && !split) mismatches.push(r);
          if (!m.pass || nondeterministic) {
            writePng(join(dir, `frame-${n}-reference.png`), fa.get(n)!, w, h);
            writePng(join(dir, `frame-${n}-zabsreel.png`), fb.get(n)!, w, h);
            writePng(join(dir, `frame-${n}-diff.png`), heatmap(fa.get(n)!, fb.get(n)!), w, h);
          }
          if (nondeterministic) writePng(join(dir, `frame-${n}-zabsreel-repeat.png`), fc.get(n)!, w, h);
        }
        if (header.audio) {
          const samples = Math.round((header.durationInFrames / header.fps) * AUDIO_RULE.rate);
          const sa = decodeAudio(a.audio, samples);
          const sb = decodeAudio(b.audio, samples);
          const sc = decodeAudio(c.audio, samples);
          reference.channels = sa.channels;
          zabsreel.channels = sb.channels;
          sized.repeat.channels = sc.channels;
          const m = compareAudio(sa.pcm, sb.pcm);
          const again = compareAudio(sb.pcm, sc.pcm);
          const repeatReference = compareAudio(sa.pcm, sc.pcm);
          const nondeterministic = !(again.rms_db_max_diff === 0 && again.onset_ms_max_diff === 0);
          const split = nondeterministic && m.pass !== repeatReference.pass;
          sized.audio = { ...m, repeat: again, repeatReference, nondeterministic, split };
          const r = audioRow(split ? NONDET : fmtAudio(m));
          audioRows.push(r);
          if (!m.pass && !split) audioMismatches.push(r);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "audio.json"), JSON.stringify({ windowMs: AUDIO_RULE.windowMs, metrics: sized.audio, reference: sa.pcm.map(levels), zabsreel: sb.pcm.map(levels), repeat: sc.pcm.map(levels) }) + "\n");
        }
      } catch (err) {
        sized.error = (err as Error).message;
        failed = "harness error";
      }
    }
    if (failed) {
      for (const n of header.frames) {
        const r = row(n, failed);
        rows.push(r);
        mismatches.push(r);
      }
      if (header.audio) {
        const r = audioRow(failed);
        audioRows.push(r);
        audioMismatches.push(r);
      }
    }
    for (const o of [a, b, c]) if (o.ok) rmSync(dirname(dirname(dirname(o.mov))), { recursive: true, force: true, maxRetries: 5 });
    const random = [...sized.frames, ...(sized.audio ? [sized.audio] : [])].filter((x) => x.split);
    const differ = [...sized.frames, ...(sized.audio ? [sized.audio] : [])].some((x) => !x.pass && !x.split);
    const status: CaseResult["status"] = failed === "harness error" ? "harness error" : failed?.startsWith(DRIFT) ? DRIFT : failed ? "zabsreel failed" : differ ? "mismatch" : random.length ? NONDET : "pass";
    const rank = ["pass", NONDET, "mismatch", "zabsreel failed", DRIFT, "harness error"];
    if (rank.indexOf(status) > rank.indexOf(result.status)) result.status = status;
    const worst = sized.frames.length ? `min pct ${Math.min(...sized.frames.map((f) => f.pct_within_4))}, max diff ${Math.max(...sized.frames.map((f) => f.max_diff))}` : failed;
    const sound = sized.audio ? `; audio ${fmtAudio(sized.audio)}` : "";
    const nd = random.length ? `; ${random.length} ${NONDET}` : "";
    console.log(`  ${name} ${size}: ${worst}${sound}${nd} (${run.sides.reference} ${(a.ms / 1000).toFixed(1)} s, ${run.sides.zabsreel} ${(b.ms / 1000).toFixed(1)} s and ${(c.ms / 1000).toFixed(1)} s)`);
  }
  rowsFile(run, "render-all.jsonl", rows);
  rowsFile(run, "render-mismatches.jsonl", mismatches);
  rowsFile(run, "audio-all.jsonl", audioRows);
  rowsFile(run, "audio-mismatches.jsonl", audioMismatches);
  return result;
}

/** A baseline case's numbers per size: its worst frame and the mean of its mean_diff. */
function baseline(results: CaseResult[]) {
  return results
    .filter((r) => BASELINE.includes(r.case))
    .map((r) => ({
      case: r.case,
      status: r.status,
      sizes: r.sizes.map((s) => ({
        size: s.size,
        min_pct_within_4: s.frames.length ? Math.min(...s.frames.map((f) => f.pct_within_4)) : null,
        max_diff: s.frames.length ? Math.max(...s.frames.map((f) => f.max_diff)) : null,
        mean_diff: s.frames.length ? Math.round((s.frames.reduce((t, f) => t + f.mean_diff, 0) / s.frames.length) * 1e4) / 1e4 : null,
      })),
    }));
}

function freshOut(out: string): void {
  mkdirSync(out, { recursive: true });
  for (const f of [...FILES, "render-summary.json"]) rmSync(join(out, f), { force: true });
  rmSync(join(out, "images"), { recursive: true, force: true });
  for (const f of FILES) writeFileSync(join(out, f), "");
}

// ---- the run ------------------------------------------------------------------------------

async function parity(run: Run, casesDir: string, only: string[] | undefined, netns: boolean): Promise<number> {
  const names = readdirSync(casesDir).filter((f) => f.endsWith(".tsx") && (!only || only.includes(f))).sort();
  // The baseline first.
  names.sort((a, b) => Number(BASELINE.includes(b)) - Number(BASELINE.includes(a)));
  if (!names.length) throw new Error(`no compositions in ${casesDir}`);
  freshOut(run.out);
  const t0 = Date.now();
  const results: CaseResult[] = [];
  for (const name of names) {
    let r: CaseResult;
    try {
      r = await runCase(run, join(casesDir, name));
    } catch (err) {
      // A header the harness cannot read: the case is named, the run goes on.
      r = { case: name, spec: "", why: "", audio: false, status: "harness error", sizes: [] };
      console.log(`  ${name}: ${(err as Error).message}`);
      (r as CaseResult & { error?: string }).error = (err as Error).message;
    }
    results.push(r);
  }
  const count = (s: CaseResult["status"]) => results.filter((r) => r.status === s).map((r) => r.case);
  const frames = results.flatMap((r) => r.sizes.flatMap((s) => s.frames));
  const sounds = results.flatMap((r) => r.sizes.flatMap((s) => (s.audio ? [s.audio] : [])));
  const verdict = (x: { pass: boolean; repeatReference: { pass: boolean } }): Verdict => (x.pass && x.repeatReference.pass ? "both pass" : x.pass || x.repeatReference.pass ? "split" : "both fail");
  const random = results.flatMap((r) =>
    r.sizes
      .filter((s) => s.frames.some((f) => f.nondeterministic) || s.audio?.nondeterministic)
      .map((s) => ({ case: r.case, size: s.size, frames: s.frames.filter((f) => f.nondeterministic).map((f) => ({ frame: f.frame, verdict: verdict(f) })), audio: s.audio?.nondeterministic ? verdict(s.audio) : null })),
  );
  const differing = <T extends { nondeterministic: boolean; pass: boolean; repeatReference: { pass: boolean } }>(xs: T[], v: string) => xs.filter((x) => x.nondeterministic && verdict(x) === v).length;
  const summary = {
    rule: `D8: pct_within_4 >= ${RULE.pct} and max_diff <= ${RULE.max} (per pixel and channel, RGBA 8-bit, both ProRes 4444 files decoded by the same FFmpeg)`,
    audioRule: `${AUDIO_EXPECTED}; both sides decoded by the same FFmpeg to ${AUDIO_RULE.rate} Hz stereo; a start or end of sound: a sample above ${AUDIO_RULE.threshold} after or before ${AUDIO_RULE.gapMs} ms below it; windows at and next to one are left out of the level metric. Why: 1 dB is about the smallest audible level difference; 5 ms is under a third of a frame at 60 fps, so a whole-frame timing difference always fails.`,
    casesDir,
    netns,
    versions: versions(),
    fixtures: run.fixtures.map((f) => ({ id: f.id, file: basename(f.file), sha256: f.sha256, bytes: f.bytes, probe: run.library[f.id] && { ...run.library[f.id], path: undefined, id: undefined, addedAt: undefined } })),
    seconds: Math.round((Date.now() - t0) / 1000),
    mediaBaseline: baseline(results),
    // ZabsReel against its own repeat (each frame's and sound's repeat metrics are in cases). The
    // differing ones are a lower bound on its nondeterminism and framesIdentical is not a noise floor:
    // a frame both renders get wrong the same way counts as identical. Differing ones: split (NONDET
    // rows), both fail (mismatch rows) or both pass.
    zabsreelRepeat: {
      finding: SETTLE,
      framesCompared: frames.length,
      framesIdentical: frames.filter((f) => !f.nondeterministic).length,
      framesSplit: differing(frames, "split"),
      framesBothFailReference: differing(frames, "both fail"),
      framesBothPassReference: differing(frames, "both pass"),
      audioCompared: sounds.length,
      audioIdentical: sounds.filter((s) => !s.nondeterministic).length,
      audioSplit: differing(sounds, "split"),
      audioBothFailReference: differing(sounds, "both fail"),
      audioBothPassReference: differing(sounds, "both pass"),
      nondeterministic: random,
    },
    // Nondeterministic here: the rows marked NONDET (a split verdict).
    counts: {
      cases: results.length,
      frames: frames.length,
      framesPassing: frames.filter((f) => f.pass && !f.split).length,
      framesNondeterministic: frames.filter((f) => f.split).length,
      audioRows: sounds.length,
      audioPassing: sounds.filter((s) => s.pass && !s.split).length,
      audioNondeterministic: sounds.filter((s) => s.split).length,
    },
    passing: count("pass"),
    nondeterministic: count(NONDET),
    mismatching: count("mismatch"),
    referenceRefused: count(DRIFT),
    zabsreelFailed: count("zabsreel failed"),
    harnessErrors: count("harness error"),
    leftoverProcesses: leftovers,
    cases: results,
  };
  writeFileSync(join(run.out, "render-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(
    `\n${summary.counts.framesPassing}/${summary.counts.frames} frames pass D8 (${summary.counts.framesNondeterministic} ${NONDET}), ${summary.counts.audioPassing}/${summary.counts.audioRows} audio rows pass (${summary.counts.audioNondeterministic} ${NONDET}); pass ${summary.passing.length}, ${NONDET} ${summary.nondeterministic.length}, mismatch ${summary.mismatching.length}, ${DRIFT} ${summary.referenceRefused.length}, zabsreel failed ${summary.zabsreelFailed.length}, harness errors ${summary.harnessErrors.length}; ${summary.seconds} s; netns ${netns}`,
  );
  if (leftovers.length) console.log(`killed ${leftovers.reduce((t, l) => t + l.pids.length, 0)} leftover process(es): ${JSON.stringify(leftovers)}`);
  const unrendered = results.filter((r) => r.status === DRIFT || r.status === "zabsreel failed" || r.status === "harness error");
  if (unrendered.length) {
    for (const r of unrendered) console.error(`NOT RENDERED: ${r.case} (${r.status})`);
    return 2;
  }
  return summary.mismatching.length || summary.nondeterministic.length ? 3 : 0;
}

async function prepare(scratch: string): Promise<Pick<Run, "fixtures" | "library">> {
  const fixtures = generateFixtures(join(scratch, "fixtures"));
  const library = await libraryOf(fixtures);
  const problems = fixtureProblems(fixtures, library);
  if (problems.length) throw new Error(`the fixtures do not match FIXTURES.md: ${problems.join("; ")}`);
  return { fixtures, library };
}

// ---- self-test ------------------------------------------------------------------------------

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};

const readRows = (file: string): Row[] => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
const readSummary = (out: string) =>
  JSON.parse(readFileSync(join(out, "render-summary.json"), "utf8")) as {
    counts: { framesPassing: number; framesNondeterministic: number; audioNondeterministic: number };
    zabsreelRepeat: Record<"framesSplit" | "framesBothFailReference" | "framesBothPassReference" | "audioSplit" | "audioBothFailReference" | "audioBothPassReference", number> & { finding: string; nondeterministic: { case: string; size: string; frames: { frame: number; verdict: Verdict }[]; audio: Verdict | null }[] };
    passing: string[];
    nondeterministic: string[];
    mismatching: string[];
    cases: CaseResult[];
  };
/** A source change: each `from` replaced by its `to`; throws when one is missing. */
const swap =
  (...pairs: [string, string][]) =>
  (tsx: string) =>
    pairs.reduce((t, [from, to]) => {
      if (!t.includes(from)) throw new Error("the self-test composition changed");
      return t.replace(from, to);
    }, tsx);
const KEYS = "case,function,size,input,metric,expected,actual,spec,why";

/** `onsets` (ms) of 100 ms 1 kHz beeps at `level` (peak), `seconds` long; `right` scales the right channel. */
function beeps(onsets: number[], level: number, seconds = 2, right = 1): Pcm {
  const n = seconds * AUDIO_RULE.rate;
  const pcm: Pcm = [new Float32Array(n), new Float32Array(n)];
  for (const at of onsets) {
    const s0 = Math.round((at * AUDIO_RULE.rate) / 1000);
    for (let i = 0; i < AUDIO_RULE.rate / 10 && s0 + i < n; i++) {
      const v = level * Math.sin((2 * Math.PI * 1000 * i) / AUDIO_RULE.rate);
      pcm[0][s0 + i] = v;
      pcm[1][s0 + i] = v * right;
    }
  }
  return pcm;
}

// Frame 0 too: it was the frame ZR-MEDIA-SETTLE (SETTLE above) hit most, the video missing.
const SELF_TSX = [
  "// size: 320x180",
  "// fps: 30",
  "// durationInFrames: 45",
  "// frames: 0, 1, 10, 20, 31, 44",
  "// audio: yes",
  "// spec: self-test",
  "// why: library video, an image with alpha and beeps at 0 s and 1 s",
  'import React from "react";',
  'import {AbsoluteFill, Audio, Img, OffthreadVideo, asset} from "remotion";',
  "",
  "export default function SelfTest() {",
  "  return (",
  '    <AbsoluteFill style={{backgroundColor: "#203040"}}>',
  '      <OffthreadVideo src={asset("vid_b")} muted style={{position: "absolute", left: 0, top: 0, width: 192, height: 108}} />',
  '      <Img src={asset("img_c")} style={{position: "absolute", left: 210, top: 70, width: 100, height: 100}} />',
  '      <Audio src={asset("aud_a")} volume={0.5} />',
  "    </AbsoluteFill>",
  "  );",
  "}",
  "",
].join("\n");

async function selfTest(out: string, scratch: string): Promise<number> {
  console.log("S0. the run is offline...");
  const nics = Object.keys(networkInterfaces());
  check(process.env[NETNS] === "1" && nics.join() === "lo" && offline(), `a private network namespace with loopback only (${nics.join(", ")})`);
  let notOffline = "";
  try {
    inPrivateNetns(SELF, ["--require-netns"], ["lo", "eth0"]);
  } catch (err) {
    notOffline = (err as Error).message;
  }
  check(!offline(["lo", "eth0"]) && notOffline.includes("lo, eth0"), `${NETNS} set with another interface is not offline, and --require-netns throws (${notOffline})`);

  console.log("S1. referenceSource() rewrites asset() to staticFile() on the reference side...");
  const ext = { vid_a: "mp4", img_c: "png" };
  const rewritten = referenceSource('import React from "react";\nimport {AbsoluteFill, OffthreadVideo, asset} from "remotion";\nconst a = <OffthreadVideo src={asset("vid_a")} />;\nconst b = asset( \'img_c\' );\n', ext);
  check(
    rewritten.includes('import {AbsoluteFill, OffthreadVideo, staticFile} from "remotion";') && rewritten.includes('src={staticFile("vid_a.mp4")}') && rewritten.includes('staticFile("img_c.png")') && !/\basset\b/.test(rewritten),
    `asset("vid_a") -> staticFile("vid_a.mp4"), asset('img_c') -> staticFile("img_c.png"), the import names staticFile (${JSON.stringify(rewritten.split("\n")[1])})`,
  );
  const refuses = (tsx: string) => {
    try {
      referenceSource(tsx, ext);
      return false;
    } catch {
      return true;
    }
  };
  check(refuses('import {asset} from "remotion";\nasset("vid_z");'), "an id no fixture has throws");
  check(refuses('import {asset} from "remotion";\nconst id = "vid_a";\nasset(id);'), "an asset() call left after the rewrite throws");

  console.log("S2. compareAudio() on known sounds...");
  const near = (got: number[], want: number[], tol: number) => got.length === want.length && got.every((v, i) => Math.abs(v - want[i]) <= tol);
  const at = [0, 1000];
  const same = compareAudio(beeps(at, 0.25), beeps(at, 0.25));
  check(same.pass && same.rms_db_max_diff === 0 && same.onset_ms_max_diff === 0 && near(same.edges[0], [0, 100, 1000, 1100], 0.1), `identical beeps: 0/0, edges at 0, 100, 1000, 1100 ms (${fmtAudio(same)}, ${same.edges[0]})`);
  const quieter = compareAudio(beeps(at, 0.25), beeps(at, 0.125));
  check(!quieter.pass && Math.abs(quieter.rms_db_max_diff - 6.02) < 0.05 && quieter.onset_ms_max_diff === 0, `half the level: 6.02 dB, fails (${fmtAudio(quieter)})`);
  const right = compareAudio(beeps(at, 0.25), beeps(at, 0.25, 2, 0.5));
  check(!right.pass && Math.abs(right.rms_db_max_diff - 6.02) < 0.05, `the right channel alone at half the level fails (${fmtAudio(right)})`);
  const late = compareAudio(beeps(at, 0.25), beeps([0, 1010], 0.25));
  check(!late.pass && Math.abs(late.onset_ms_max_diff! - 10) < 0.1 && late.rms_db_max_diff <= 1, `the second beep 10 ms late fails on timing alone (${fmtAudio(late)})`);
  const early = compareAudio(beeps(at, 0.25), beeps([0, 999], 0.25));
  check(early.pass && Math.abs(early.onset_ms_max_diff! - 1) < 0.1, `the second beep 1 ms early passes: the windows at its start and end are left out (${fmtAudio(early)})`);
  const extra = compareAudio(beeps(at, 0.25), beeps([0, 500, 1000], 0.25));
  check(!extra.pass && extra.onset_ms_max_diff === null && fmtAudio(extra).endsWith("/edges 4:6"), `an extra beep fails on the count (${fmtAudio(extra)})`);
  const silent = compareAudio(beeps(at, 0.25), beeps([], 0.25));
  check(!silent.pass && fmtAudio(silent).endsWith("/edges 4:0"), `silence against beeps fails (${fmtAudio(silent)})`);

  console.log("S3. the fixtures: twice the same bytes, as FIXTURES.md lists them...");
  const { fixtures, library } = await prepare(scratch);
  const again = generateFixtures(join(scratch, "fixtures-again"));
  check(fixtures.every((f, i) => f.sha256 === again[i].sha256), `generated twice, equal sha256 (${fixtures.map((f) => `${f.id} ${f.sha256.slice(0, 12)}`).join(", ")})`);
  rmSync(join(scratch, "fixtures-again"), { recursive: true, force: true });
  check(fixtureProblems(fixtures, library).length === 0, "sizes, frame rates, frame counts, durations and sound as FIXTURES.md (probeAsset, ffprobe)");
  const vid = (id: string) => fixtures.find((f) => f.id === id)!;
  const neighbours = (id: string, w: number, h: number, pairs: number[][]) => {
    const fr = decodeFrames(vid(id).file, w, h, pairs.flat());
    return pairs.map(([x, y]) => compare(fr.get(x)!, fr.get(y)!));
  };
  const steps = [...neighbours("vid_a", 1920, 1080, [[0, 1], [89, 90], [178, 179]]), ...neighbours("vid_b", 1280, 720, [[0, 1], [98, 99]]), ...neighbours("vid_c", 640, 360, [[0, 1], [178, 179]])];
  check(steps.every((m) => !m.pass), `neighbouring frames fail D8 against each other (${steps.map(fmt).join(", ")})`);
  const tracks = (id: string, seconds: number) => decodeAudio(vid(id).file, seconds * AUDIO_RULE.rate).pcm;
  const ea = compareAudio(tracks("aud_a", 8), tracks("aud_a", 8)).edges[0];
  const want = Array.from({ length: 8 }, (_, k) => [k * 1000, k * 1000 + 100]).flat();
  check(near(ea, want, 0.1), `aud_a beeps 100 ms at every whole second (${ea.join(", ")})`);
  const eb = compareAudio(tracks("aud_b", 3), tracks("aud_b", 3)).edges[0];
  check(near(eb, [0, 2500], 0.1), `aud_b sounds from 0 to 2500 ms (${eb.join(", ")})`);
  const silence = (file: string | undefined) => {
    try {
      const q = decodeAudio(file, 4800);
      return q.channels === 0 && q.pcm.every((c) => c.length === 4800 && c.every((v) => v === 0));
    } catch {
      return false;
    }
  };
  check(silence(undefined), "no sound file decodes to silence of the asked length");
  check(silence(vid("vid_b").file), "a file with no sound track (vid_b) decodes to silence of the asked length");

  const selfDir = join(scratch, "self-case");
  mkdirSync(selfDir, { recursive: true });
  const selfFile = join(selfDir, "self.tsx");
  writeFileSync(selfFile, SELF_TSX);
  const listed = parseHeader(SELF_TSX);
  const both: Run = { out: join(out, "self"), scratch, fixtures, library, sides: { reference: "zabsreel", zabsreel: "zabsreel" } };

  console.log("S4. the self-test composition rendered twice through ZabsReel passes against itself...");
  freshOut(both.out);
  const r4 = await runCase(both, selfFile);
  const frames4 = r4.sizes.flatMap((s) => s.frames);
  const all4 = readRows(join(both.out, "render-all.jsonl"));
  const audio4 = readRows(join(both.out, "audio-all.jsonl"));
  check(r4.status === "pass" && frames4.length === listed.frames.length && frames4.every((f) => f.max_diff === 0), `every frame equal: ${frames4.map(fmt).join(", ")} (${r4.status})`);
  check(all4.length === frames4.length && all4.every((r) => Object.keys(r).join() === KEYS && r.actual === "100/0"), `render-all.jsonl: one row per frame, keys ${KEYS}, actual 100/0`);
  const a4 = r4.sizes[0].audio;
  check(!!a4 && a4.pass && a4.rms_db_max_diff === 0 && a4.onset_ms_max_diff === 0 && a4.edges[0].length === 4, `the sound is equal, with both beeps (${a4 && fmtAudio(a4)}, ${a4?.edges[0]})`);
  check(audio4.length === 1 && Object.keys(audio4[0]).join() === KEYS && audio4[0].function === "audio" && audio4[0].actual === "0/0", `audio-all.jsonl: one row, keys ${KEYS}, actual 0/0 (${JSON.stringify(audio4.map((r) => r.actual))})`);
  check(["render-mismatches.jsonl", "audio-mismatches.jsonl"].every((f) => readFileSync(join(both.out, f), "utf8") === ""), "render-mismatches.jsonl and audio-mismatches.jsonl are empty");
  check(
    r4.sizes[0].repeat.ok && frames4.every((f) => !f.nondeterministic && f.repeat.max_diff === 0) && !!a4 && !a4.nondeterministic && a4.repeat.rms_db_max_diff === 0 && a4.repeat.onset_ms_max_diff === 0,
    `the repeat is identical: frames ${frames4.map((f) => fmt(f.repeat)).join(", ")}, audio ${a4 && fmtAudio(a4.repeat)}, nothing nondeterministic`,
  );

  console.log("S5. a brighter background and half the volume on the second side only: every row fails, each side shows its own...");
  const altered: Run = {
    ...both,
    out: join(out, "altered"),
    sourceB: (tsx) => {
      if (!tsx.includes('"#203040"') || !tsx.includes("volume={0.5}")) throw new Error("the self-test composition changed");
      return tsx.replace('"#203040"', '"#485868"').replace("volume={0.5}", "volume={0.25}");
    },
  };
  freshOut(altered.out);
  const r5 = await runCase(altered, selfFile);
  const frames5 = r5.sizes.flatMap((s) => s.frames);
  const mis5 = readRows(join(altered.out, "render-mismatches.jsonl"));
  const amis5 = readRows(join(altered.out, "audio-mismatches.jsonl"));
  check(r5.status === "mismatch" && frames5.length === listed.frames.length && frames5.every((f) => !f.pass && f.max_diff >= 36 && f.max_diff <= 44), `every frame fails, max_diff about 40 (${frames5.map(fmt).join(", ")})`);
  check(mis5.length === listed.frames.length && mis5.every((r) => r.case === "self.tsx" && Object.keys(r).join() === KEYS), `render-mismatches.jsonl holds ${mis5.length} rows of ${listed.frames.length}`);
  const a5 = r5.sizes[0].audio;
  check(!!a5 && !a5.pass && Math.abs(a5.rms_db_max_diff - 6.02) < 0.5 && a5.onset_ms_max_diff !== null && a5.onset_ms_max_diff <= AUDIO_RULE.onsetMs, `the audio row fails on level, about 6 dB, the beeps in place (${a5 && fmtAudio(a5)})`);
  check(amis5.length === 1 && amis5[0].function === "audio" && Object.keys(amis5[0]).join() === KEYS, "audio-mismatches.jsonl holds its row");
  check(frames5.every((f) => !f.nondeterministic) && !!a5 && !a5.nondeterministic, "the repeat renders the second side's source: nothing is nondeterministic");
  // compare() and compareAudio() are symmetric: only the images and the levels show which side was decoded as which.
  const pixel = (side: string, at = altered.out) => {
    const png = join(at, "images", "self", "320x180", `frame-${listed.frames[0]}-${side}.png`);
    if (!existsSync(png)) return null;
    const px = decodeFrames(png, 320, 180, [0]).get(0)!;
    const i = (170 * 320 + 160) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  };
  const p5a = pixel("reference");
  const p5b = pixel("zabsreel");
  check(!!p5a && !!p5b && near(p5a, [0x20, 0x30, 0x40], 4) && near(p5b, [0x48, 0x58, 0x68], 4), `the background is #203040 in the first side's image and #485868 in the second's (${p5a} and ${p5b})`);
  // aud_a's beeps peak at 0.5: at volume 0.5 a full window is 0.25/sqrt(2) = -15.05 dBFS, at 0.25 -21.07 dBFS.
  check(!!a5 && Math.abs(a5.loudest[0] + 15.05) < 0.5 && Math.abs(a5.loudest[1] + 21.07) < 0.5, `the first side's loudest window is -15.05 dBFS and the second's -21.07 (${a5?.loudest})`);

  console.log("S6. the self-test composition through the real reference: the beeps where they belong, the browser muted...");
  const real: Run = { ...both, out: join(out, "reference"), sides: { reference: "reference", zabsreel: "zabsreel" } };
  freshOut(real.out);
  const r6 = await runCase(real, selfFile);
  const s6 = r6.sizes[0];
  console.log(`    (status ${r6.status}; reference ${s6.reference.ok ? "rendered" : (s6.reference as { error: string }).error})`);
  check(s6.reference.ok && !!s6.audio, "the reference rendered it, with its sound compared");
  const e6 = s6.audio?.edges[0] ?? [];
  check(near(e6, [0, 100, 1000, 1100], AUDIO_RULE.onsetMs), `the reference's beeps start and end at 0, 100, 1000, 1100 ms (${e6.join(", ")})`);
  check(!!s6.audio && Math.abs(s6.audio.loudest[0] + 15.05) < 1, `at aud_a's level times 0.5, -15.05 dBFS (${s6.audio?.loudest[0]})`);
  const args6 = s6.reference.browserArgs ?? [];
  check(args6.length > 1 && args6[0].endsWith("browser.sh") && args6[1] === "--mute-audio", `its browser started through the wrapper with --mute-audio first (${args6.slice(0, 2).join(" ")})`);
  check(!leftovers.length, `no process was left behind (${JSON.stringify(leftovers)})`);

  console.log("S7. a composition only the reference side refuses (its source made to throw) is exactly a drift candidate...");
  const driftOut = join(out, "drift");
  const drift: Run = { ...real, out: driftOut, sourceA: (tsx) => tsx.replace("  return (", '  throw new Error("media parity self-test drift");\n  return (') };
  const code7 = await parity(drift, selfDir, undefined, offline());
  const mis7 = readRows(join(driftOut, "render-mismatches.jsonl"));
  const amis7 = readRows(join(driftOut, "audio-mismatches.jsonl"));
  const summary7 = JSON.parse(readFileSync(join(driftOut, "render-summary.json"), "utf8")) as { referenceRefused: string[]; zabsreelFailed: string[]; cases: CaseResult[] };
  check(code7 === 2, `the run exits 2 (it exited ${code7})`);
  check(mis7.length === listed.frames.length && mis7.every((r) => r.actual === DRIFT) && amis7.length === 1 && amis7[0].actual === DRIFT, `every frame row and the audio row say exactly "${DRIFT}" (${JSON.stringify([...mis7, ...amis7].map((r) => r.actual))})`);
  const sized7 = summary7.cases[0].sizes[0];
  check(summary7.referenceRefused.join() === "self.tsx" && !summary7.zabsreelFailed.length && !sized7.reference.ok && sized7.zabsreel.ok, "the summary lists it as refused by the reference only, ZabsReel rendered it");
  check(![...mis7, ...amis7].some((r) => r.actual.includes("self-test drift")), "no row carries the error text");

  console.log(`S8. ZabsReel's repeat alone differs (a brighter background and half the volume; the first render passes, the repeat fails): every row is exactly "${NONDET}", in no mismatches file...`);
  const randomOut = join(out, "repeat");
  const random: Run = { ...both, out: randomOut, sourceRepeat: altered.sourceB };
  const code8 = await parity(random, selfDir, undefined, offline());
  const all8 = readRows(join(randomOut, "render-all.jsonl"));
  const audio8 = readRows(join(randomOut, "audio-all.jsonl"));
  const summary8 = readSummary(randomOut);
  check(code8 === 3, `the run exits 3 (it exited ${code8})`);
  check(all8.length === listed.frames.length && all8.every((r) => r.actual === NONDET && Object.keys(r).join() === KEYS), `every frame row says exactly "${NONDET}" (${JSON.stringify(all8.map((r) => r.actual))})`);
  check(audio8.length === 1 && audio8[0].actual === NONDET, `the audio row says exactly "${NONDET}" (${JSON.stringify(audio8.map((r) => r.actual))})`);
  check(["render-mismatches.jsonl", "audio-mismatches.jsonl"].every((f) => readFileSync(join(randomOut, f), "utf8") === ""), "render-mismatches.jsonl and audio-mismatches.jsonl are empty");
  const listed8 = summary8.zabsreelRepeat.nondeterministic;
  check(
    summary8.nondeterministic.join() === "self.tsx" &&
      !summary8.mismatching.length &&
      listed8.length === 1 &&
      listed8[0].case === "self.tsx" &&
      listed8[0].size === "320x180" &&
      listed8[0].frames.map((f) => f.frame).join() === listed.frames.join() &&
      listed8[0].frames.every((f) => f.verdict === "split") &&
      listed8[0].audio === "split" &&
      summary8.zabsreelRepeat.finding.startsWith("ZR-MEDIA-SETTLE"),
    `the summary lists the case, its frames and its sound as nondeterministic, not as a mismatch (${JSON.stringify(listed8)})`,
  );
  check(summary8.counts.framesPassing === 0 && summary8.counts.framesNondeterministic === listed.frames.length && summary8.counts.audioNondeterministic === 1, `counts: 0 frames passing, ${listed.frames.length} frames and 1 sound nondeterministic (${JSON.stringify(summary8.counts)})`);
  const p8 = pixel("zabsreel-repeat", randomOut);
  check(!!p8 && near(p8, [0x48, 0x58, 0x68], 4), `the repeat's own frame is saved, background #485868 (${p8})`);

  console.log(`S9. the second side alone differs (the first render fails, its repeat of the original passes): every row is exactly "${NONDET}", in no mismatches file...`);
  const secondOut = join(out, "second");
  const second: Run = { ...altered, out: secondOut, sourceRepeat: swap(['"#485868"', '"#203040"'], ["volume={0.25}", "volume={0.5}"]) };
  const code9 = await parity(second, selfDir, undefined, offline());
  const rows9 = [...readRows(join(secondOut, "render-all.jsonl")), ...readRows(join(secondOut, "audio-all.jsonl"))];
  const summary9 = readSummary(secondOut);
  const s9 = summary9.cases[0].sizes[0];
  check(
    s9.frames.length === listed.frames.length && s9.frames.every((f) => !f.pass && f.repeatReference.pass && f.split) && !!s9.audio && !s9.audio.pass && s9.audio.repeatReference.pass && s9.audio.split,
    `the first render fails and the repeat passes against the reference: frames ${s9.frames.map((f) => `${fmt(f)} and ${fmt(f.repeatReference)}`).join(", ")}, audio ${s9.audio && `${fmtAudio(s9.audio)} and ${fmtAudio(s9.audio.repeatReference)}`}`,
  );
  check(rows9.length === listed.frames.length + 1 && rows9.every((r) => r.actual === NONDET), `every frame row and the audio row say exactly "${NONDET}" (${JSON.stringify(rows9.map((r) => r.actual))})`);
  check(["render-mismatches.jsonl", "audio-mismatches.jsonl"].every((f) => readFileSync(join(secondOut, f), "utf8") === ""), "render-mismatches.jsonl and audio-mismatches.jsonl are empty");
  const z9 = summary9.zabsreelRepeat;
  check(
    code9 === 3 && summary9.nondeterministic.join() === "self.tsx" && !summary9.mismatching.length && z9.framesSplit === listed.frames.length && z9.audioSplit === 1 && z9.framesBothFailReference === 0 && z9.audioBothFailReference === 0,
    `exits 3, the case nondeterministic, ${listed.frames.length} frames and 1 sound split (exit ${code9}, ${JSON.stringify({ ...z9, finding: undefined, nondeterministic: undefined })})`,
  );

  console.log("S10. the second side and its repeat differ from the reference and from each other (both fail): every row is a mismatch with the first render's metric...");
  const bothOut = join(out, "both-fail");
  const bothFail: Run = { ...altered, out: bothOut, sourceRepeat: swap(['"#485868"', '"#708090"'], ["volume={0.25}", "volume={0.125}"]) };
  const code10 = await parity(bothFail, selfDir, undefined, offline());
  const mis10 = readRows(join(bothOut, "render-mismatches.jsonl"));
  const amis10 = readRows(join(bothOut, "audio-mismatches.jsonl"));
  const summary10 = readSummary(bothOut);
  const s10 = summary10.cases[0].sizes[0];
  // #485868 is 40 from #203040 and #708090 is 80 from it, 40 from #485868; the volumes 0.25 and 0.125 are 6 and 12 dB below 0.5.
  check(
    s10.frames.length === listed.frames.length &&
      s10.frames.every((f) => f.nondeterministic && !f.split && !f.pass && f.max_diff >= 36 && f.max_diff <= 44 && f.repeat.max_diff >= 36 && f.repeat.max_diff <= 44 && !f.repeatReference.pass && f.repeatReference.max_diff >= 76 && f.repeatReference.max_diff <= 84),
    `every frame differs from its repeat and both fail: first ${s10.frames.map(fmt).join(", ")}; repeat against the first ${s10.frames.map((f) => fmt(f.repeat)).join(", ")}; repeat against the reference ${s10.frames.map((f) => fmt(f.repeatReference)).join(", ")}`,
  );
  const a10 = s10.audio;
  check(
    !!a10 && a10.nondeterministic && !a10.split && !a10.pass && Math.abs(a10.rms_db_max_diff - 6.02) < 0.5 && Math.abs(a10.repeat.rms_db_max_diff - 6.02) < 0.5 && !a10.repeatReference.pass && Math.abs(a10.repeatReference.rms_db_max_diff - 12.04) < 0.5,
    `the sound differs from its repeat and both fail: ${a10 && `${fmtAudio(a10)}, repeat against the first ${fmtAudio(a10.repeat)}, against the reference ${fmtAudio(a10.repeatReference)}`}`,
  );
  check(
    mis10.length === listed.frames.length && mis10.every((r, i) => r.input === `frame ${listed.frames[i]}` && r.actual === fmt(s10.frames[i])) && amis10.length === 1 && !!a10 && amis10[0].actual === fmtAudio(a10),
    `render-mismatches.jsonl and audio-mismatches.jsonl hold every row with the first render's metric (${JSON.stringify([...mis10, ...amis10].map((r) => r.actual))})`,
  );
  const z10 = summary10.zabsreelRepeat;
  check(
    code10 === 3 &&
      summary10.mismatching.join() === "self.tsx" &&
      !summary10.nondeterministic.length &&
      summary10.counts.framesNondeterministic === 0 &&
      summary10.counts.audioNondeterministic === 0 &&
      z10.framesBothFailReference === listed.frames.length &&
      z10.audioBothFailReference === 1 &&
      z10.framesSplit === 0 &&
      z10.audioSplit === 0 &&
      z10.nondeterministic.length === 1 &&
      z10.nondeterministic[0].frames.map((f) => f.frame).join() === listed.frames.join() &&
      z10.nondeterministic[0].frames.every((f) => f.verdict === "both fail") &&
      z10.nondeterministic[0].audio === "both fail",
    `exits 3, the case a mismatch, its frames and sound listed as nondeterministic with both failing and counted so (exit ${code10}, ${JSON.stringify({ ...z10, finding: undefined })})`,
  );

  console.log("S11. the repeat differs from the first render by one step (both pass): every row passes, the case passes...");
  const nearOut = join(out, "both-pass");
  const bothPass: Run = { ...both, out: nearOut, sourceRepeat: swap(['"#203040"', '"#213141"'], ["volume={0.5}", "volume={0.49}"]) };
  const code11 = await parity(bothPass, selfDir, undefined, offline());
  const rows11 = [...readRows(join(nearOut, "render-all.jsonl")), ...readRows(join(nearOut, "audio-all.jsonl"))];
  const summary11 = readSummary(nearOut);
  const s11 = summary11.cases[0].sizes[0];
  check(
    s11.frames.length === listed.frames.length && s11.frames.every((f) => f.nondeterministic && !f.split && f.pass && f.repeatReference.pass) && !!s11.audio && s11.audio.nondeterministic && !s11.audio.split && s11.audio.pass && s11.audio.repeatReference.pass,
    `every frame and the sound differ from the repeat and both pass: repeat ${s11.frames.map((f) => fmt(f.repeat)).join(", ")}, audio ${s11.audio && fmtAudio(s11.audio.repeat)}`,
  );
  const z11 = summary11.zabsreelRepeat;
  check(
    code11 === 0 && summary11.passing.join() === "self.tsx" && rows11.every((r) => r.actual !== NONDET) && z11.framesBothPassReference === listed.frames.length && z11.audioBothPassReference === 1 && summary11.counts.framesPassing === listed.frames.length,
    `exits 0, the case passes, no row is "${NONDET}", counted as both passing (exit ${code11}, ${JSON.stringify(rows11.map((r) => r.actual))}, ${JSON.stringify({ ...z11, finding: undefined, nondeterministic: undefined })})`,
  );

  console.log(failures === 0 ? "\nMEDIA PARITY HARNESS SELF-TEST PASSED" : `\n${failures} CHECK(S) FAILED`);
  return failures === 0 ? 0 : 1;
}

// ---- main ---------------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const jobFile = arg("child");
  if (jobFile) {
    await child(jobFile);
    return 0;
  }
  // The whole run in a private network namespace (loopback only), so neither pipeline reaches a real host.
  const code = inPrivateNetns(SELF, args);
  if (code !== null) return code;
  const out = arg("out");
  if (!out) throw new Error("--out=<folder> is required");
  if (!existsSync(SHELL)) throw new Error(`the pinned headless shell is missing: ${SHELL}`);
  const scratchParent = arg("scratch") ?? tmpdir();
  mkdirSync(scratchParent, { recursive: true });
  const scratch = mkdtempSync(join(scratchParent, "zr-media-"));
  try {
    if (args.includes("--self-test")) return await selfTest(resolve(out), scratch);
    const only = arg("only")?.split(",");
    const sides = { reference: "reference", zabsreel: "zabsreel" } as const;
    return await parity({ out: resolve(out), scratch, sides, ...(await prepare(scratch)) }, resolve(arg("cases") ?? CASES), only, offline());
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

