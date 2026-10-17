/**
 * FFmpeg version-compatibility smoke (no downloads; synthesizes its inputs).
 * ZabsReel supports FFmpeg 4.4 and 6.1 – 9.0 (packages/core/src/ffmpeg/version.ts);
 * run this against every build you ship or test:
 *
 *   npx tsx packages/core/scripts/smoke-ffcompat.ts
 *   AIVE_FFMPEG=/opt/ff9/bin/ffmpeg AIVE_FFPROBE=/opt/ff9/bin/ffprobe npx tsx packages/core/scripts/smoke-ffcompat.ts
 *
 * Checks, each against the RUNNING binary unless marked pure:
 *   - version parsing of real banners (pure) with the gates that follow from it
 *     (afftfilt, the xfade EOF pad before 7.0, mixed audio joins on 6.1 – 7.x,
 *     the frame passthrough option),
 *     and this FFmpeg's version; the
 *     version/ffprobe banners are probed once (the authenticated /health reads them);
 *   - `ffmpeg -filters` parsing: 3 flag columns up to 7.x, 2 from 8.0 (which
 *     hid rubberband, so pitch effects silently used the fallback);
 *   - a > 128 KiB filtergraph (inline it would fail with E2BIG on Linux) runs
 *     through a file with the option this version prefers, and with the other
 *     one forced first: 9.0 has no -filter_complex_script, 4.4 no -/filter_complex,
 *     7.x / 8.x know both;
 *   - alpha modes (8.1+): premultiply → alphamerge → unpremultiply (the trails /
 *     alphaSafe shape) keeps a translucent colour, and the graph adapter's rewrite;
 *   - afftdn (rewritten in 5.0): the noise reduction chain adds no latency and
 *     still lowers a noise floor; heavy mode runs (anlmdn crashes 9.0);
 *   - afftfilt (rewritten in 5.1): an impulse shows which afftfilt this build
 *     has (5.1+ delays it by win_size − hop), and the robot effect in graph.ts's
 *     clip-chain shape matches a model of 4.4's robot — sample for sample on
 *     4.4/5.0, within −50 dB on 5.1+ (its rebuilt chain), head included, mono
 *     and stereo;
 *   - vibrato's uncleared delay line is primed (underwater);
 *   - vibrance uses 4.4's luma weights on every version (8.0 swapped the defaults);
 *   - the export mix is stereo when a mono clip comes first (4.4 exported mono);
 *   - a clip with an alpha-keeping effect (key, colour grade, sharpen, glow) keeps
 *     its last frame at 1x and 0.5x, before a cut and at the timeline's end
 *     (4.4 – 6.1 dropped it: a black frame), and a keyed, speed-ramped clip (as
 *     footage and as a matte cutout) shows the ramp model's frame in every slot;
 *   - a speed-ramped clip's audio (chunks joined by 8 ms crossfades) and short
 *     clips joined by transitions export the same audio every time, with no
 *     silent gap (6.1 – 7.x's acrossfade ends its output when the next piece
 *     ends first: 6.1 every time, 7.x at random; there they are mixed).
 */
import { execa } from "execa";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FFMPEG_BIN, FFPROBE_BIN, INLINE_FILTERGRAPH_MAX, adaptFfmpegArgs, anlmdnWorks, checkBinaries, ffmpegVersion,
  filterScriptFlagInUse, hasAlphaModes, runFfmpeg, runFfmpegStdoutBuffer, setFilterScriptFlag,
} from "../src/ffmpeg/executor.js";
import {
  TESTED_FFMPEG_MAJORS, acrossfadeUnreliable, adaptFilterGraph, hasAfftdnV2, hasAfftfiltV2, parseFfmpegVersion, passthroughFlag, preferredFilterScriptFlag,
  untestedFfmpegWarning, xfadeNeedsEofPad,
} from "../src/ffmpeg/version.js";
import { audioFilterCaps, detectFilters, measureNoiseFloor, parseFilterList } from "../src/audio/fx.js";
import { AFFTDN_V2_DELAY, audioEffectFilterSteps } from "../src/effects/audio.js";
import { alphaSafe, effectFilterSteps } from "../src/effects/registry.js";
import { stabilizeFilters } from "../src/ffmpeg/stabilize.js";
import { EditorEngine } from "../src/engine.js";
import { clipFootprintFrames, sourceFrameShownAt } from "../src/speed.js";
import type { ClipEffects } from "../src/types.js";

const SR = 48000;
let failures = 0;
function check(cond: unknown, msg: string): void {
  if (cond) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.error(`  FAIL ${msg}`);
  }
}
const db = (x: number) => 20 * Math.log10(Math.max(1e-12, x));
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));

/** Mono 48 kHz float samples of `file` after the -af chain `af` (empty = as is). */
async function pcm(file: string, af: string[] = [], channels = 1): Promise<Float32Array> {
  const args = ["-hide_banner", "-v", "error", "-i", file];
  if (af.length) args.push("-af", af.join(","));
  args.push("-ac", String(channels), "-ar", String(SR), "-f", "f32le", "-");
  const b = Buffer.from(await runFfmpegStdoutBuffer(args));
  const out = new Float32Array(b.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4);
  return out;
}
function onsetSec(x: Float32Array, frac = 0.25): number {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= p * frac) return i / SR;
  return NaN;
}

/**
 * Interleaved 48 kHz float samples through the -af chain `af`, fed as a 32-bit
 * float WAV and read as raw f32 (no 16-bit rounding). A WAV, not a raw f32le
 * input: the executor's format allowlist (MEDIA_DEMUXERS) refuses a forced
 * raw format read from a file.
 */
async function pcmF32(dir: string, x: Float32Array, af: string[], channels = 1): Promise<Float32Array> {
  const src = join(dir, `in-${channels}.wav`);
  const data = Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(3, 20); // WAVE_FORMAT_IEEE_FLOAT
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(SR, 24);
  head.writeUInt32LE(SR * channels * 4, 28);
  head.writeUInt16LE(channels * 4, 32);
  head.writeUInt16LE(32, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(data.length, 40);
  writeFileSync(src, Buffer.concat([head, data]));
  const b = Buffer.from(await runFfmpegStdoutBuffer(["-hide_banner", "-v", "error", "-i", src,
    "-af", af.join(","), "-f", "f32le", "-ar", String(SR), "-ac", String(channels), "-"]));
  const out = new Float32Array(b.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4);
  return out;
}

const twiddles = new Map<number, [Float64Array, Float64Array]>();
/** In-place radix-2 complex FFT (n a power of two); `inverse` = the unnormalised e^{+i…} transform. */
function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  let tw = twiddles.get(n);
  if (!tw) {
    tw = [new Float64Array(n / 2), new Float64Array(n / 2)];
    for (let k = 0; k < n / 2; k++) {
      tw[0][k] = Math.cos((2 * Math.PI * k) / n);
      tw[1][k] = -Math.sin((2 * Math.PI * k) / n);
    }
    twiddles.set(n, tw);
  }
  const sgn = inverse ? -1 : 1;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len / 2;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = tw[0][k * step];
        const wi = sgn * tw[1][k * step];
        const p = i + k;
        const q = p + half;
        const xr = re[q] * wr - im[q] * wi;
        const xi = re[q] * wi + im[q] * wr;
        re[q] = re[p] - xr;
        im[q] = im[p] - xi;
        re[p] += xr;
        im[p] += xi;
      }
    }
  }
}

/**
 * FFmpeg 4.4's robot (afftfilt real='hypot(re,im)':imag='0', win_size W,
 * overlap 0.75) in float64: frames at k·hop while k·hop < n, zero-padded past
 * the end, × its float symmetric Hann; every bin's magnitude; the unnormalised
 * inverse FFT × 0.5/W (1/(W/2) × (1 − overlap)) overlap-added; its output
 * rounded up to a whole hop (ceil(n / hop)·hop samples, as 4.4 emits). The sound
 * the export must have on every FFmpeg version (and the live worklet plays).
 */
function robot44(x: Float32Array, W: number): Float64Array {
  const hop = W / 4;
  const n = x.length;
  const win = new Float64Array(W);
  for (let i = 0; i < W; i++) win[i] = Math.fround(0.5 * (1 - Math.cos((2 * Math.PI * i) / (W - 1))));
  const y = new Float64Array(n + W);
  const re = new Float64Array(W);
  const im = new Float64Array(W);
  for (let s = 0; s < n; s += hop) {
    for (let i = 0; i < W; i++) {
      re[i] = s + i < n ? x[s + i] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < W; b++) {
      re[b] = Math.hypot(re[b], im[b]);
      im[b] = 0;
    }
    fft(re, im, true);
    for (let i = 0; i < W; i++) y[s + i] += (0.5 / W) * re[i];
  }
  return y.subarray(0, Math.ceil(n / hop) * hop);
}

/** Correlation of log long-term spectra (0–~2.3 kHz) of two signals (smoke-voicefx.ts's measure). */
function logSpectrumCorr(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const N = 2048;
  const K = 100;
  const spec = (x: ArrayLike<number>) => {
    const acc = new Float64Array(K);
    for (let s0 = SR / 2; s0 + N < x.length - SR / 4; s0 += N) {
      for (let k = 2; k < K; k++) {
        let re = 0;
        let im = 0;
        for (let i = 0; i < N; i++) {
          const v = x[s0 + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
          const w = (2 * Math.PI * k * i) / N;
          re += v * Math.cos(w);
          im -= v * Math.sin(w);
        }
        acc[k] += Math.hypot(re, im);
      }
    }
    return acc;
  };
  const A = spec(a);
  const B = spec(b);
  let num = 0;
  let da = 0;
  let dbb = 0;
  for (let k = 2; k < K; k++) {
    const x = Math.log10(A[k] + 1e-9);
    const y = Math.log10(B[k] + 1e-9);
    num += x * y;
    da += x * x;
    dbb += y * y;
  }
  return num / Math.sqrt(da * dbb);
}

/** `got` vs `ref` over [from, to): residual energy and level (dB re `ref`), max abs error. */
function vsModel(got: ArrayLike<number>, ref: ArrayLike<number>, from: number, to: number): { residual: number; level: number; maxErr: number } {
  let e2 = 0;
  let r2 = 0;
  let g2 = 0;
  let maxErr = 0;
  for (let i = from; i < to; i++) {
    const e = got[i] - ref[i];
    e2 += e * e;
    r2 += ref[i] * ref[i];
    g2 += got[i] * got[i];
    maxErr = Math.max(maxErr, Math.abs(e));
  }
  return { residual: 10 * Math.log10(e2 / r2), level: 10 * Math.log10(g2 / r2), maxErr };
}

// Real `ffmpeg -version` heads (banner … libavfilter line) of the builds the matrix ran, plus
// the afftfilt boundary: 5.0 (libavfilter 8.24) has 4.4's afftfilt, 5.1 (8.44) the rewrite, and the
// acrossfade boundary: 6.0 (9.3) waits for its first input's end, 6.1 (9.12) – 7.x do not (mixed joins);
// git builds of libavfilter 9 and 11 mix too (an 11.x git build may predate 8.0's acrossfade rewrite).
type Want = { major: number | null; generation: number | null; tested: boolean; lavfiMinor: number; afftfiltV2: boolean; xfadeEofPad: boolean; mixJoins: boolean };
const BANNERS: Array<[string, string, Want]> = [
  ["ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021 the FFmpeg developers", "libavfilter     7.110.100 /  7.110.100", { major: 4, generation: 4, tested: true, lavfiMinor: 110, afftfiltV2: false, xfadeEofPad: true, mixJoins: false }],
  ["ffmpeg version 5.0.3 Copyright (c) 2000-2022 the FFmpeg developers", "libavfilter     8. 24.100 /  8. 24.100", { major: 5, generation: 5, tested: false, lavfiMinor: 24, afftfiltV2: false, xfadeEofPad: true, mixJoins: false }],
  ["ffmpeg version n5.1.6-11-gcde3c5fc0c-20241130 Copyright (c) 2000-2024 the FFmpeg developers", "libavfilter     8. 44.100 /  8. 44.100", { major: 5, generation: 5, tested: false, lavfiMinor: 44, afftfiltV2: true, xfadeEofPad: true, mixJoins: false }],
  ["ffmpeg version 6.0 Copyright (c) 2000-2023 the FFmpeg developers", "libavfilter     9.  3.100 /  9.  3.100", { major: 6, generation: 6, tested: true, lavfiMinor: 3, afftfiltV2: true, xfadeEofPad: true, mixJoins: false }],
  ["ffmpeg version n6.1.2-15-ga6a07eebdf-20241130 Copyright (c) 2000-2024 the FFmpeg developers", "libavfilter     9. 12.100 /  9. 12.100", { major: 6, generation: 6, tested: true, lavfiMinor: 12, afftfiltV2: true, xfadeEofPad: true, mixJoins: true }],
  ["ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers", "libavfilter     9. 12.100 /  9. 12.100", { major: 6, generation: 6, tested: true, lavfiMinor: 12, afftfiltV2: true, xfadeEofPad: true, mixJoins: true }],
  ["ffmpeg version n7.1.5-12-g1fdbca85aa-20260731 Copyright (c) 2000-2026 the FFmpeg developers", "libavfilter    10.  5.100 / 10.  5.100", { major: 7, generation: 7, tested: true, lavfiMinor: 5, afftfiltV2: true, xfadeEofPad: false, mixJoins: true }],
  ["ffmpeg version 7.1-full_build-www.gyan.dev Copyright (c) 2000-2024 the FFmpeg developers", "libavfilter    10.  4.100 / 10.  4.100", { major: 7, generation: 7, tested: true, lavfiMinor: 4, afftfiltV2: true, xfadeEofPad: false, mixJoins: true }],
  ["ffmpeg version n8.0.1-66-g27b8d1a017-20260228 Copyright (c) 2000-2025 the FFmpeg developers", "libavfilter    11.  4.100 / 11.  4.100", { major: 8, generation: 8, tested: true, lavfiMinor: 4, afftfiltV2: true, xfadeEofPad: false, mixJoins: false }],
  ["ffmpeg version n8.1.3-18-g46d899d7a0-20261012 Copyright (c) 2000-2026 the FFmpeg developers", "libavfilter    11. 14.103 / 11. 14.103", { major: 8, generation: 8, tested: true, lavfiMinor: 14, afftfiltV2: true, xfadeEofPad: false, mixJoins: false }],
  ["ffmpeg version n9.0.2-27-g7e93014c5b-20261012 Copyright (c) 2000-2026 the FFmpeg developers", "libavfilter    12.  1.102 / 12.  1.102", { major: 9, generation: 9, tested: true, lavfiMinor: 1, afftfiltV2: true, xfadeEofPad: false, mixJoins: false }],
  ["ffmpeg version N-121234-gdeadbeef00-20261001 Copyright (c) 2000-2026 the FFmpeg developers", "libavfilter    12.  3.100 / 12.  3.100", { major: null, generation: 9, tested: false, lavfiMinor: 3, afftfiltV2: true, xfadeEofPad: false, mixJoins: false }],
  ["ffmpeg version 2026-10-01-git-abcdef1234-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers", "libavfilter    11. 14.103 / 11. 14.103", { major: null, generation: 8, tested: false, lavfiMinor: 14, afftfiltV2: true, xfadeEofPad: false, mixJoins: true }],
  ["ffmpeg version N-115000-g1a2b3c4d5e Copyright (c) 2000-2024 the FFmpeg developers", "libavfilter    11.  0.100 / 11.  0.100", { major: null, generation: 8, tested: false, lavfiMinor: 0, afftfiltV2: true, xfadeEofPad: false, mixJoins: true }],
  ["ffmpeg version N-102000-g0123456789 Copyright (c) 2000-2021 the FFmpeg developers", "libavfilter     7.110.100 /  7.110.100", { major: null, generation: 4, tested: false, lavfiMinor: 110, afftfiltV2: false, xfadeEofPad: true, mixJoins: false }],
  ["ffmpeg version N-105500-g89abcdef01 Copyright (c) 2000-2022 the FFmpeg developers", "libavfilter     8. 24.100 /  8. 24.100", { major: null, generation: 5, tested: false, lavfiMinor: 24, afftfiltV2: false, xfadeEofPad: true, mixJoins: false }],
  ["ffmpeg version N-107900-gfedcba9876 Copyright (c) 2000-2022 the FFmpeg developers", "libavfilter     8. 44.100 /  8. 44.100", { major: null, generation: 5, tested: false, lavfiMinor: 44, afftfiltV2: true, xfadeEofPad: true, mixJoins: false }],
  ["ffmpeg version N-112000-g0a1b2c3d4e Copyright (c) 2000-2023 the FFmpeg developers", "libavfilter     9.  8.100 /  9.  8.100", { major: null, generation: 6, tested: false, lavfiMinor: 8, afftfiltV2: true, xfadeEofPad: true, mixJoins: true }],
];

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "zabsreel-ffcompat-"));
  console.log(`work dir ${dir}`);

  // ---- version ------------------------------------------------------------------
  console.log("version parsing (pure)");
  for (const [banner, lavfi, want] of BANNERS) {
    const v = parseFfmpegVersion(`${banner}\nbuilt with gcc 14\nconfiguration: --enable-gpl\nlibavutil      60.  8.100 / 60.  8.100\n${lavfi}\n`);
    check(v.major === want.major && v.generation === want.generation && v.tested === want.tested && (untestedFfmpegWarning(v) === null) === want.tested &&
      v.lavfiMinor === want.lavfiMinor && hasAfftfiltV2(v) === want.afftfiltV2 && xfadeNeedsEofPad(v) === want.xfadeEofPad && acrossfadeUnreliable(v) === want.mixJoins,
      `${v.major !== null ? `${v.label}, ` : "git build, "}libavfilter ${v.lavfi}.${v.lavfiMinor}: generation ${v.generation}, ${v.tested ? "tested" : "untested (startup warning)"}, ` +
      `afftfilt ${hasAfftfiltV2(v) ? "v2" : "v1"}, xfade EOF pad ${xfadeNeedsEofPad(v) ? "on" : "off"}, audio joins ${acrossfadeUnreliable(v) ? "mixed" : "acrossfade"}`);
  }
  check(hasAfftfiltV2(null) && hasAfftfiltV2({ major: null, minor: null, lavfi: null, lavfiMinor: null }), "afftfilt v2 for an unknown build");
  check(preferredFilterScriptFlag({ generation: 4 }) === "-filter_complex_script" && preferredFilterScriptFlag({ generation: 6 }) === "-filter_complex_script" &&
    preferredFilterScriptFlag({ generation: 7 }) === "-/filter_complex" && preferredFilterScriptFlag({ generation: 9 }) === "-/filter_complex" &&
    preferredFilterScriptFlag(null) === "-filter_complex_script", "filtergraph-file option: -filter_complex_script before 7.0, -/filter_complex from 7.0");
  check(passthroughFlag({ generation: 4 })[0] === "-vsync" && passthroughFlag({ generation: 6 })[0] === "-fps_mode" && passthroughFlag({ generation: 9 })[0] === "-fps_mode" &&
    passthroughFlag(null)[0] === "-fps_mode" && passthroughFlag({ generation: null })[0] === "-fps_mode", "frame passthrough: -vsync on 4.4, -fps_mode from 6 (and for an unknown build)");
  check(!hasAfftdnV2({ generation: 4 }) && hasAfftdnV2({ generation: 5 }) && hasAfftdnV2({ generation: 9 }) && hasAfftdnV2(null), "afftdn v2 from FFmpeg 5 (and for an unknown build)");
  check(xfadeNeedsEofPad({ generation: 4 }) && xfadeNeedsEofPad({ generation: 6 }) && !xfadeNeedsEofPad({ generation: 7 }) && !xfadeNeedsEofPad({ generation: 9 }) &&
    !xfadeNeedsEofPad(null) && !xfadeNeedsEofPad({ generation: null }), "xfade EOF pad before FFmpeg 7 only (off for an unknown build)");
  check(!acrossfadeUnreliable(null) && !acrossfadeUnreliable({ major: null, minor: null, generation: null, lavfi: null }), "audio joins use acrossfade on an unknown build");

  console.log("this FFmpeg");
  const v = await ffmpegVersion();
  console.log(`     ${v.banner}`);
  check(v.generation !== null && v.lavfi !== null, `version ${v.label}, libavfilter ${v.lavfi}, behaves like FFmpeg ${v.generation}${v.tested ? "" : " — UNTESTED"}`);
  if (v.major !== null) check(TESTED_FFMPEG_MAJORS.includes(v.major) === v.tested, "tested flag follows the tested majors");
  const t0 = Date.now();
  const [b1, b2] = [await checkBinaries(), await checkBinaries()];
  check(b1 === b2 && b1.ffmpeg === v.banner && /ffprobe version/.test(b1.ffprobe) && Date.now() - t0 < 5000, `checkBinaries is probed once (${b1.ffprobe.slice(0, 40)}…)`);

  // ---- -filters -------------------------------------------------------------------
  console.log("filter list");
  const three = parseFilterList(" TSC afftdn            A->A       Denoise audio samples using FFT.\n ..C rubberband        A->A       Apply time-stretching and pitch-shifting.\n ... abuffer           |->A       Buffer audio frames.");
  const two = parseFilterList(" TS afftdn            A->A       Denoise audio samples using FFT.\n .. rubberband        A->A       Apply time-stretching and pitch-shifting.\n T.C = Command support");
  check(three.has("rubberband") && three.has("abuffer") && two.has("rubberband") && two.has("afftdn") && two.size === 2, "parses 3-column (≤ 7.x) and 2-column (8.0+) -filters lines");
  const filters = await detectFilters();
  const rbHelp = await execa(FFMPEG_BIN, ["-hide_banner", "-h", "filter=rubberband"], { reject: false });
  const hasRb = rbHelp.exitCode === 0 && /Filter rubberband/.test(rbHelp.stdout);
  check(filters.size > 100 && filters.has("overlay") && filters.has("afftdn") && filters.has("rubberband") === hasRb,
    `detectFilters finds ${filters.size} filters (rubberband ${hasRb ? "present" : "absent"} in this build)`);

  // ---- long filtergraphs ------------------------------------------------------------
  console.log("long filtergraphs (> 128 KiB, through a file)");
  const long = "x".repeat(70 * 1024); // one label, used twice: a 140 KiB graph that does little
  const graph = `[0:v]negate[${long}];[${long}]format=rgb24[o]`;
  check(graph.length > 128 * 1024 && graph.length > INLINE_FILTERGRAPH_MAX, `graph is ${Math.round(graph.length / 1024)} KiB`);
  const longRun = async (): Promise<string> => {
    const out = join(dir, `long-${Date.now()}.rgb`);
    await runFfmpeg(["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=4x4:d=0.04", "-filter_complex", graph, "-map", "[o]", "-frames:v", "1", "-f", "rawvideo", "-y", out]);
    return [...readFileSync(out).subarray(0, 3)].join(",");
  };
  // Red negated is cyan (within a couple of levels: the YUV round trip differs between versions).
  const cyan = (px: string) => {
    const c = px.split(",").map(Number);
    return c.length === 3 && c[0] <= 4 && c[1] >= 251 && c[2] >= 251;
  };
  const preferred = preferredFilterScriptFlag(v);
  setFilterScriptFlag(null);
  const px = await longRun();
  check(cyan(px) && filterScriptFlagInUse() === preferred, `runs with ${preferred} (red negated: ${px})`);
  const other = preferred === "-/filter_complex" ? "-filter_complex_script" : "-/filter_complex";
  // Which option this binary knows decides whether the forced one sticks or falls back.
  const knows = async (flag: string) => {
    const r = await execa(FFMPEG_BIN, ["-hide_banner", "-h", "full"], { reject: false });
    return r.stdout.split(/\r?\n/).some((l) => l.startsWith(`${flag} `));
  };
  const knowsOther = await knows(other);
  setFilterScriptFlag(other);
  let px2 = "";
  try {
    px2 = await longRun();
  } catch (e) {
    px2 = String(e).slice(0, 200);
  }
  const want = knowsOther ? other : preferred;
  check(cyan(px2) && filterScriptFlagInUse() === want,
    `${other} forced first: ${knowsOther ? "this FFmpeg still knows it" : "unknown here, falls back to " + preferred} (${px2})`);
  setFilterScriptFlag(null);

  // ---- alpha modes --------------------------------------------------------------------
  console.log("alpha modes (FFmpeg 8.1+ negotiates straight / premultiplied)");
  const alphaModes = await hasAlphaModes();
  const g0 = "[0:v]format=rgba,premultiply=inplace=1,gblur=sigma=2,unpremultiply=inplace=1[o]";
  check(adaptFilterGraph(g0, { alphaModes: false }) === g0 &&
    adaptFilterGraph(g0, { alphaModes: true }) === "[0:v]format=rgba,premultiply=inplace=1,setparams=alpha_mode=straight,gblur=sigma=2,setparams=alpha_mode=premultiplied,unpremultiply=inplace=1[o]",
    "adaptFilterGraph retags around (un)premultiply only where alpha modes exist (pure)");
  const plain = ["-filter_complex", "[0:v]null[o]"];
  check((await adaptFfmpegArgs(plain)) === plain, "a graph without (un)premultiply is passed through untouched");
  // alphaSafe(premultiplied) is the trails shape: premultiply → filter → alphamerge → unpremultiply.
  const safe = alphaSafe(["null"], "cmp", [], true)[0];
  const round = await runFfmpegStdoutBuffer(["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=0xC86432@0.5:s=4x4,format=rgba",
    "-filter_complex", `[0:v]${safe}[o]`, "-map", "[o]", "-frames:v", "1", "-f", "rawvideo", "-"]);
  const [r, g, bl, a] = round;
  check(Math.abs(r - 200) <= 3 && Math.abs(g - 100) <= 3 && Math.abs(bl - 50) <= 3 && Math.abs(a - 127) <= 1,
    `premultiply → alphamerge → unpremultiply keeps rgba(200,100,50,127): got ${r},${g},${bl},${a} (alpha modes ${alphaModes ? "on, retagged" : "off"})`);
  // A probe that fails (no FFmpeg at FFMPEG_BIN yet) is not cached: an FFmpeg installed later is asked
  // again, or an 8.1+ build would run (un)premultiply graphs without the retag (an add blend at 60 %
  // came out at 100 %). In a child process, since FFMPEG_BIN is read at import; the "FFmpeg" installed
  // there is a script that prints an alpha_mode option.
  if (process.platform !== "win32") {
    const fake = join(mkdtempSync(join(tmpdir(), "aive-alphamodes-")), "ffmpeg");
    const code = `const m = await import(process.argv[1]); const fs = await import("node:fs");
      const before = await m.hasAlphaModes();
      fs.writeFileSync(process.argv[2], "#!/bin/sh\\necho '  alpha_mode        <int>        ..FV....... select alpha mode'\\n", { mode: 0o755 });
      console.log(JSON.stringify({ before, after: await m.hasAlphaModes() }));`;
    const child = await execa(process.execPath, ["--import", "tsx", "-e", code, join(import.meta.dirname, "../src/ffmpeg/executor.ts"), fake],
      { env: { ...process.env, AIVE_FFMPEG: fake }, reject: false });
    const res = /\{.*\}/.exec(child.stdout)?.[0];
    check(res === '{"before":false,"after":true}', `a failed alpha-mode probe is not cached: FFmpeg installed later is asked again (${res ?? child.stderr.split("\n")[0]})`);
  }

  // ---- audio -------------------------------------------------------------------------
  console.log("audio filters");
  // 1 s of a −50 dBFS pink-noise floor, then a 440 Hz tone over it.
  const toneWav = join(dir, "tone.wav");
  await execa(FFMPEG_BIN, ["-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", `anoisesrc=c=pink:a=0.006:d=4:sample_rate=${SR}:seed=7`,
    "-f", "lavfi", "-i", `aevalsrc='if(gte(t,1),0.25*sin(2*PI*440*t),0)':s=${SR}:d=4`,
    "-filter_complex", "[0:a][1:a]amix=inputs=2:normalize=0", "-c:a", "pcm_s16le", toneWav]);
  const floorDb = await measureNoiseFloor(toneWav, 0, 4);
  check(floorDb !== null && floorDb < -40 && floorDb > -70, `measured noise floor ${floorDb?.toFixed(1)} dBFS`);
  const nrFx = [{ id: "nr", type: "noise_reduction" as const, params: { floor: floorDb ?? -55, amount: 0.5, heavy: 0 } }];
  const caps = await audioFilterCaps(nrFx);
  check(!!caps?.afftdnV2 === hasAfftdnV2(v), `afftdn ${caps?.afftdnV2 ? "v2 (FFmpeg ≥ 5)" : "v1 (FFmpeg 4.x)"} for this build`);
  const dry = await pcm(toneWav, [`aresample=${SR}`]);
  const nrSteps = audioEffectFilterSteps(nrFx, { caps });
  const wet = await pcm(toneWav, [`aresample=${SR}`, ...nrSteps]);
  const lagMs = (onsetSec(wet) - onsetSec(dry)) * 1000;
  check(Math.abs(lagMs) <= 2, `noise reduction adds no latency (${lagMs.toFixed(1)} ms; afftdn v2 alone lags ${(AFFTDN_V2_DELAY / SR * 1000).toFixed(0)} ms)`);
  check(wet.length >= dry.length - 0.03 * SR, `…and keeps the length within 30 ms (${(wet.length / SR).toFixed(3)} of ${(dry.length / SR).toFixed(3)} s)`);
  const gap = (x: Float32Array) => db(rms(x.subarray(Math.round(0.2 * SR), Math.round(0.9 * SR))));
  check(gap(dry) - gap(wet) >= 8, `…and lowers the noise floor ${gap(dry).toFixed(1)} → ${gap(wet).toFixed(1)} dB (≥ 8 dB)`);
  const heavyFx = [{ id: "nr", type: "noise_reduction" as const, params: { floor: floorDb ?? -55, amount: 1, heavy: 1 } }];
  const heavyCaps = await audioFilterCaps(heavyFx);
  const works = await anlmdnWorks();
  let heavyOk = false;
  try {
    heavyOk = (await pcm(toneWav, [`aresample=${SR}`, ...audioEffectFilterSteps(heavyFx, { caps: heavyCaps })])).length > 3 * SR;
  } catch (e) {
    console.error(`     ${String(e).slice(0, 300)}`);
  }
  check(heavyOk && !!heavyCaps?.noAnlmdn === !works, `heavy noise reduction runs (anlmdn ${works ? "works" : "crashes this FFmpeg: skipped"})`);
  // vibrato: primed with silence, so the first output samples are never heap leftovers.
  const uw = audioEffectFilterSteps([{ type: "underwater", params: { muffle: 1500, wobble: 1 } }]);
  let worst = -Infinity;
  for (let k = 0; k < 4; k++) {
    const y = await pcm(toneWav, [`aresample=${SR}`, ...uw]);
    const head = y.subarray(0, Math.round(0.02 * SR));
    worst = Math.max(worst, head.every(Number.isFinite) ? db(Math.max(...head.map(Math.abs))) : Infinity);
  }
  check(uw.some((s) => s.startsWith("adelay=")) && worst < -20, `underwater: vibrato's delay line is primed (first 20 ms peak ${worst.toFixed(1)} dBFS over 4 runs)`);

  // ---- robot (afftfilt, rewritten in 5.1) ------------------------------------------------
  console.log("robot voice (afftfilt rewritten in 5.1: sqrt-Hann in and out, latency win_size − hop)");
  const v2 = hasAfftfiltV2(v);
  // An impulse at sample 100 through an identity afftfilt (win 16, hop 4): 4.4's comes out at 100, the rewrite's 12 later.
  const imp = Buffer.from(await runFfmpegStdoutBuffer(["-hide_banner", "-v", "error", "-f", "lavfi", "-i",
    `aevalsrc='eq(n,100)':s=${SR}:d=0.01,afftfilt=win_size=16:overlap=0.75`, "-f", "f32le", "-ac", "1", "-"]));
  let peakAt = -1;
  let peak = 0;
  for (let i = 0; i < imp.length / 4; i++) {
    const a = Math.abs(imp.readFloatLE(i * 4));
    if (a > peak) [peak, peakAt] = [a, i];
  }
  check(peakAt === (v2 ? 112 : 100), `impulse at sample 100 peaks at ${peakAt}: afftfilt ${peakAt === 112 ? "v2 (5.1+)" : "v1 (4.4/5.0)"}, version gate says ${v2 ? "v2" : "v1"}`);
  const robotCaps = await audioFilterCaps([{ id: "r", type: "robot" }]);
  check(!!robotCaps?.afftfiltV2 === v2 && (v2 || robotCaps === undefined), `a robot-only stack resolves caps ${JSON.stringify(robotCaps ?? null)}`);
  const bothCaps = await audioFilterCaps([...nrFx, { id: "r", type: "robot" }]);
  check(!!bothCaps?.afftfiltV2 === v2 && !!bothCaps?.afftdnV2 === hasAfftdnV2(v) && !caps?.afftfiltV2,
    `noise reduction + robot: ${JSON.stringify(bothCaps ?? null)} (noise reduction alone: no afftfilt flag)`);
  // smoke-voicefx's voice: f0 125 Hz ±3 % at 5 Hz, 20 harmonics at 1/h, full level from sample 0 (that is what exposes the pre-roll gate).
  const n = 3 * SR;
  const voiceX = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += (2 * Math.PI * 125 * (1 + 0.03 * Math.sin((2 * Math.PI * 5 * i) / SR))) / SR;
    let s = 0;
    for (let h = 1; h <= 20; h++) s += Math.sin(h * ph) / h;
    voiceX[i] = 0.2 * s;
  }
  // graph.ts audioSourceSteps' shape around the effect chain.
  const clipChain = (steps: string[]) => ["asetpts=PTS-STARTPTS", `aresample=${SR}`, ...steps, "apad", "atrim=0:3", "asetpts=PTS-STARTPTS"];
  /** The class's pass: 4.4/5.0 sample for sample (but the last W, read from pool memory past the input on 4.4), 5.1+ within −50 dB and 1e−3. */
  const robotOk = (r: { residual: number; level: number; maxErr: number }, corr: number) =>
    (v2 ? r.residual <= -50 && r.maxErr <= 1e-3 : r.residual <= -100) && Math.abs(r.level) <= 0.5 && corr >= 0.9995;
  const robotNote = (r: { residual: number; level: number; maxErr: number }, corr: number) =>
    `residual ${Number.isFinite(r.residual) ? r.residual.toFixed(1) : "-inf"} dB (≤ ${v2 ? -50 : -100}), level ${r.level >= 0 ? "+" : ""}${r.level.toFixed(3)} dB, ` +
    `log-spectrum corr ${corr.toFixed(6)}, max err ${r.maxErr.toExponential(1)}`;
  for (const tone of [0, 1, 2]) {
    const W = [2048, 1024, 512][tone];
    const steps = audioEffectFilterSteps([{ id: "r", type: "robot", params: { tone } }], { caps: robotCaps });
    const got = await pcmF32(dir, voiceX, clipChain(steps));
    const ref = robot44(voiceX, W);
    const r = vsModel(got, ref, 0, v2 ? n : n - W);
    const corr = logSpectrumCorr(got, ref);
    check(got.length === n && robotOk(r, corr),
      `robot tone ${tone} (win ${W}, ${steps.length} step${steps.length > 1 ? "s" : ""}) vs 4.4's robot over ${v2 ? "the whole clip" : "all but the last window"}: ${robotNote(r, corr)}, ${got.length}/${n} samples`);
  }
  {
    // Stereo (left voice, right noise): each channel's expression reads its own spectrum.
    const noise = new Float32Array(n);
    let seed = 12345;
    for (let i = 0; i < n; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      noise[i] = 0.3 * (seed / 2 ** 32 - 0.5);
    }
    const lr = new Float32Array(2 * n);
    for (let i = 0; i < n; i++) [lr[2 * i], lr[2 * i + 1]] = [voiceX[i], noise[i]];
    const W = 1024;
    const got = await pcmF32(dir, lr, clipChain(audioEffectFilterSteps([{ id: "r", type: "robot", params: { tone: 1 } }], { caps: robotCaps })), 2);
    const notes: string[] = [];
    let ok = got.length === 2 * n;
    for (const [ch, x] of [[0, voiceX], [1, noise]] as const) {
      const g = new Float32Array(n);
      for (let i = 0; i < n; i++) g[i] = got[2 * i + ch] ?? 0;
      const ref = robot44(x, W);
      const r = vsModel(g, ref, 0, v2 ? n : n - W);
      const corr = logSpectrumCorr(g, ref);
      ok &&= robotOk(r, corr);
      notes.push(`${ch ? "R noise" : "L voice"} ${robotNote(r, corr)}`);
    }
    check(ok, `robot tone 1 on stereo: ${notes.join("; ")}`);
  }
  // A robot input that is not a whole number of hops (normalize before it drops 240 samples, a trim
  // ends anywhere): 4.4 rounds its output up to a whole hop, so up to hop − 1 samples of robot tail
  // fall inside the clip. Compared over the whole clip, that tail included.
  const short = n - 240;
  for (const tone of [0, 1, 2]) {
    const W = [2048, 1024, 512][tone];
    const steps = audioEffectFilterSteps([{ id: "r", type: "robot", params: { tone } }], { caps: robotCaps });
    const got = await pcmF32(dir, voiceX, [...clipChain([`atrim=end_sample=${short}`, ...steps])]);
    const tail = robot44(voiceX.subarray(0, short), W);
    const ref = new Float64Array(n);
    ref.set(tail.subarray(0, Math.min(n, tail.length)));
    const r = vsModel(got, ref, 0, v2 ? n : short - W);
    const corr = logSpectrumCorr(got, ref);
    check(got.length === n && robotOk(r, corr),
      `robot tone ${tone} on ${short} samples (${short % (W / 4)} past a whole hop) vs 4.4's robot over ${v2 ? "the whole clip" : "all but the last window"}: ` +
      `${robotNote(r, corr)}, 4.4's output ${tail.length} samples`);
  }

  // ---- video filter defaults -----------------------------------------------------------
  console.log("filter defaults that changed between versions");
  // vibrance: FFmpeg 8.0 swapped the rlum/blum defaults; the registry pins 4.4's.
  const vib = effectFilterSteps([{ type: "vibrance", amount: 1 }], 4, 4, "v");
  const vpx = await runFfmpegStdoutBuffer(["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=0x3080C0:s=4x4,format=gbrp",
    "-vf", `${vib.join(",")},format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"]);
  // FFmpeg 4.4's output for this colour (8.0+ with its own defaults: 0,147,255).
  const model = [0, 115, 255];
  const vdiff = Math.max(...[0, 1, 2].map((i) => Math.abs(vpx[i] - model[i])));
  check(/rlum=0\.072186:blum=0\.212656/.test(vib.join()) && vdiff <= 2, `vibrance matches FFmpeg 4.4: ${[...vpx.subarray(0, 3)].join(",")} vs ${model.join(",")}`);
  check(stabilizeFilters({ zoom: "none" }).transform.endsWith(":optalgo=gauss"), "stabilize names the Gaussian camera path (newer libvidstab: L1 by default)");

  // ---- export mix --------------------------------------------------------------------
  console.log("export audio mix");
  const mono = join(dir, "mono.mkv");
  const stereo = join(dir, "stereo.mkv");
  await execa(FFMPEG_BIN, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=160x90:r=30:d=1", "-f", "lavfi", "-i", `sine=f=440:d=1:sample_rate=${SR}`,
    "-af", "aformat=channel_layouts=mono", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest", mono]);
  await execa(FFMPEG_BIN, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=160x90:r=30:d=1",
    "-f", "lavfi", "-i", `aevalsrc='0.3*sin(2*PI*660*t)|0':s=${SR}:d=1:c=stereo`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest", stereo]);
  const engine = new EditorEngine(dir);
  engine.setProjectSettings({ width: 160, height: 90, fps: 30, name: "ffcompat" });
  engine.appendClip((await engine.importVideo(mono)).id);
  engine.appendClip((await engine.importVideo(stereo)).id);
  const outMp4 = join(dir, "mix.mp4");
  await engine.exportVideo(outMp4);
  const chans = Number((await execa(FFPROBE_BIN, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", outMp4])).stdout.trim());
  const lr = chans === 2 ? await pcm(outMp4, [], 2) : new Float32Array(0);
  const side = (ch: number) => {
    const s: number[] = [];
    for (let i = Math.round(1.2 * SR) * 2 + ch; i < Math.round(1.8 * SR) * 2; i += 2) s.push(lr[i] ?? 0);
    return db(rms(Float32Array.from(s)));
  };
  check(chans === 2 && side(0) - side(1) >= 20, `mono clip then stereo clip → stereo export, the stereo clip keeps its sides (${chans} ch, L ${chans === 2 ? side(0).toFixed(1) : "-"} / R ${chans === 2 ? side(1).toFixed(1) : "-"} dBFS)`);

  // Clip lengths: an alpha-keeping effect (key / colour grade / sharpen / glow) ends
  // its sub-graph in blend or alphamerge, whose stream has no end time on FFmpeg
  // 4.4 – 6.1; the retime's fps then dropped the clip's last frame (two at 0.5x),
  // a black frame at the cut. graph.ts pads and cuts such clips to their length.
  console.log("clip lengths after alpha-keeping effects (4.4 – 6.1 dropped the last frame)");
  const grayA = join(dir, "grayA.mp4");
  const grayB = join(dir, "grayB.mp4");
  for (const [p, c] of [[grayA, "0x909090"], [grayB, "0x505050"]]) {
    await execa(FFMPEG_BIN, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${c}:s=160x90:r=30:d=3`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", p]);
  }
  const lumas = async (file: string): Promise<number[]> => {
    const r = await execa(FFMPEG_BIN, ["-hide_banner", "-v", "error", "-i", file, "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-f", "null", "-"]);
    return [...r.stdout.matchAll(/YAVG=([0-9.]+)/g)].map((m) => Number(m[1]));
  };
  const lengthFx: Array<[string, ClipEffects]> = [
    ["chromakey", { filters: [{ id: "k", type: "chromakey", color: "0x00FF00" }] }],
    ["colour grade", { color: { brightness: 0.05 } }],
    ["sharpen", { filters: [{ id: "s", type: "sharpen", amount: 1 }] }],
    ["glow", { filters: [{ id: "g", type: "glow", amount: 0.3 }] }],
  ];
  for (const [name, effects] of lengthFx) {
    for (const speed of [1, 0.5]) {
      const e = new EditorEngine(dir);
      e.setProjectSettings({ width: 160, height: 90, fps: 30, name: "lengths" });
      const first = e.appendClip((await e.importVideo(grayA)).id, 0, 30);
      e.setClipEffects(first.id, effects);
      if (speed !== 1) e.setClipSpeed(first.id, speed);
      e.appendClip((await e.importVideo(grayB)).id, 0, 15);
      const cut = Math.round(30 / speed);
      const out = join(dir, `len-${name.replace(/\W/g, "")}-${speed}.mp4`);
      await e.exportVideo(out);
      const y = await lumas(out);
      const dark = y.findIndex((l) => l < 40);
      check(y.length === cut + 15 && dark < 0 && Math.abs(y[cut - 1] - y[cut - 2]) < 3,
        `${name} at ${speed}x, then a cut: ${y.length}/${cut + 15} frames, last frame before the cut Y ${y[cut - 1]?.toFixed(1)} (${dark < 0 ? "no black frame" : `BLACK at frame ${dark}`})`);
    }
  }
  {
    // The same clip last on the timeline: the export's final frame.
    const e = new EditorEngine(dir);
    e.setProjectSettings({ width: 160, height: 90, fps: 30, name: "lengths" });
    const only = e.appendClip((await e.importVideo(grayA)).id, 0, 30);
    e.setClipEffects(only.id, lengthFx[0][1]);
    const out = join(dir, "len-last.mp4");
    await e.exportVideo(out);
    const y = await lumas(out);
    check(y.length === 30 && y[29] > 40, `chromakey clip ending the timeline: ${y.length}/30 frames, final frame Y ${y[29]?.toFixed(1)}`);
  }
  {
    // The sub-graph's padding frames are transparent: only the cut to the clip's length keeps them
    // out of a wipe, where xfade shows the outgoing stream's frames past the transition at its edge
    // (a black column on the two frames after the wipe). 4.4 – 6.1 show one column of the outgoing
    // clip's last frame on the first of them (graph.ts xfadeEofPad), never a darker one.
    const e = new EditorEngine(dir);
    e.setProjectSettings({ width: 160, height: 90, fps: 30, name: "lengths" });
    const first = e.appendClip((await e.importVideo(grayA)).id, 0, 30);
    e.setClipEffects(first.id, lengthFx[0][1]);
    const next = e.appendClip((await e.importVideo(grayB)).id, 0, 20);
    e.setTransition(next.id, "wipeleft", 10);
    const out = join(dir, "len-wipe.mp4");
    await e.exportVideo(out, { quality: 0 });
    const y = await lumas(out);
    const off = y.slice(30).findIndex((l, i) => (i === 0 ? l < y[39] : l !== y[39]));
    check(y.length === 40 && off < 0,
      `chromakey clip, wipe into the next clip: ${y.length}/40 frames, ` +
      `${off < 0 ? "the frames after the wipe are the next clip's" : `frame ${30 + off} is not the next clip's (Y ${y[30 + off].toFixed(3)} vs ${y[39]?.toFixed(3)})`}`);
  }
  {
    // All three end guards on one clip (graph.ts: the sub-graph's padding, the ramp's clone pad, the
    // cutout's held frame, then one cut): a chromakey on a "montage" ramp, as footage and as a matte
    // cutout, then a cut. Source frame k is gray Y 170 + 3·(k mod 22), so each output frame names the
    // frame it shows; it must be the ramp model's frame for every slot of the footprint, the last one too.
    const coded = join(dir, "coded.mp4");
    await execa(FFMPEG_BIN, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "nullsrc=s=160x90:r=30:d=3,format=yuv420p,geq=lum='170+3*mod(N\\,22)':cb=128:cr=128",
      "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv420p", coded]);
    for (const cutout of [false, true]) {
      const e = new EditorEngine(dir);
      e.setProjectSettings({ width: 160, height: 90, fps: 30, name: "guards" });
      let id = e.appendClip((await e.importVideo(coded)).id).id;
      if (cutout) id = (await e.removeBackground(id, { stubMatte: true })).clip.id;
      e.setClipEffects(id, lengthFx[0][1]);
      const { clip } = e.setSpeedRamp(id, { preset: "montage" });
      e.appendClip((await e.importVideo(grayB)).id, 0, 15);
      const foot = clipFootprintFrames(clip, 30);
      const out = join(dir, `len-guards-${cutout ? "cutout" : "footage"}.mp4`);
      await e.exportVideo(out, { quality: 0 });
      const y = await lumas(out);
      const wrong: string[] = [];
      for (let n = 0; n < foot; n++) {
        const want = sourceFrameShownAt(clip, n, 30) % 22;
        if (Math.abs((y[n] ?? 0) - (170 + 3 * want)) > 1) wrong.push(`${n}: Y ${y[n]?.toFixed(1)} (want frame ${sourceFrameShownAt(clip, n, 30)})`);
      }
      const dark = y.findIndex((l) => l < 40);
      check(y.length === foot + 15 && dark < 0 && wrong.length === 0 && Math.abs(y[foot] - y[foot + 14]) < 1 && y[foot] < 150,
        `${cutout ? "matte cutout" : "footage"} + chromakey + "montage" ramp, then a cut: ${y.length}/${foot + 15} frames, ` +
        `${wrong.length ? `wrong frames ${wrong.slice(0, 3).join("; ")}` : "every slot the model's source frame, the last one held"}` +
        `${dark < 0 ? ", no black frame" : `, BLACK at frame ${dark}`}`);
    }
    // Footage whose video ends 0.3 s before its audio: the ramp holds the last video frame to the
    // footprint, and the key (its padding frames clone for a ramp) must not change that.
    const shortVideo = join(dir, "coded-short.mkv");
    await execa(FFMPEG_BIN, ["-hide_banner", "-v", "error", "-y", "-i", coded, "-f", "lavfi", "-i", `sine=f=440:d=3.3:sample_rate=${SR}`,
      "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "pcm_s16le", shortVideo]);
    const runs: number[][] = [];
    for (const keyed of [false, true]) {
      const e = new EditorEngine(dir);
      e.setProjectSettings({ width: 160, height: 90, fps: 30, name: "guards" });
      const id = e.appendClip((await e.importVideo(shortVideo)).id).id;
      if (keyed) e.setClipEffects(id, lengthFx[0][1]);
      e.setSpeedRamp(id, { preset: "montage" });
      e.appendClip((await e.importVideo(grayB)).id, 0, 15);
      const out = join(dir, `len-guards-short-${keyed}.mp4`);
      await e.exportVideo(out, { quality: 0 });
      runs.push(await lumas(out));
    }
    const differ = runs[1].findIndex((l, i) => Math.abs(l - runs[0][i]) > 1);
    const dark = runs.map((y) => y.findIndex((l) => l < 40));
    check(runs[0].length === runs[1].length && differ < 0 && dark.every((d) => d < 0),
      `video 0.3 s shorter than its audio, "montage" ramp with and without a chromakey: ${runs[1].length}/${runs[0].length} frames, ` +
      `${differ < 0 ? "the same frames" : `frame ${differ} differs (Y ${runs[1][differ]?.toFixed(1)} vs ${runs[0][differ]?.toFixed(1)})`}, ` +
      `${dark.every((d) => d < 0) ? "the last video frame held to the footprint" : `BLACK from frame ${dark.filter((d) => d >= 0).join(" / ")}`}`);
  }

  // Audio joins: 6.1 – 7.x's acrossfade ends its output when its second input ends
  // first (a ramp's chunks): 6.1 left a ramp's end silent, 7.x cut it short at
  // random; there the joins are mixed (graph.ts).
  console.log("audio joins (speed ramp chunks, transitions)");
  const rampSrc = join(dir, "ramp.mkv");
  await execa(FFMPEG_BIN, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=160x90:r=30:d=6", "-f", "lavfi", "-i", `sine=f=440:d=6:sample_rate=${SR}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest", rampSrc]);
  const rampSums = new Set<string>();
  let rampWorst = Infinity;
  for (let run = 0; run < 3; run++) {
    const e = new EditorEngine(dir);
    e.setProjectSettings({ width: 160, height: 90, fps: 30, name: "ramp" });
    const c = e.addClip((await e.importVideo(rampSrc)).id, { startFrame: 0, sourceInFrame: 30, sourceOutFrame: 150 });
    e.setSpeedRamp(c.id, { preset: "montage" });
    const out = join(dir, `ramp${run}.mp4`);
    await e.exportVideo(out);
    const y = await pcm(out);
    rampSums.add(createHash("md5").update(Buffer.from(y.buffer)).digest("hex"));
    // The 440 Hz tone (pitch kept by atempo) in every 100 ms window but the last.
    for (let i = 0; i + 4800 <= y.length - 4800; i += 4800) rampWorst = Math.min(rampWorst, db(rms(y.subarray(i, i + 4800))));
  }
  check(rampSums.size === 1 && rampWorst > -30,
    `3 exports of a "montage" speed ramp: ${rampSums.size} distinct result(s), quietest 100 ms ${rampWorst.toFixed(1)} dBFS${acrossfadeUnreliable(v) ? " (mixed joins)" : ""}`);
  const shortClip = async (f: number): Promise<string> => {
    const p = join(dir, `short${f}.mkv`);
    await execa(FFMPEG_BIN, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=160x90:r=30:d=0.4", "-f", "lavfi", "-i", `sine=f=${f}:d=0.4:sample_rate=${SR}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest", p]);
    return p;
  };
  const tones = [await shortClip(440), await shortClip(660), await shortClip(880)];
  const sums = new Set<string>();
  let worstGap = Infinity;
  let len = 0;
  for (let run = 0; run < 4; run++) {
    const e = new EditorEngine(dir);
    e.setProjectSettings({ width: 160, height: 90, fps: 30, name: "xfade" });
    for (const [k, t] of tones.entries()) {
      const c = e.appendClip((await e.importVideo(t)).id);
      if (k > 0) e.setTransition(c.id, "fade", 3);
    }
    const out = join(dir, `xfade${run}.mp4`);
    await e.exportVideo(out);
    const y = await pcm(out);
    sums.add(createHash("md5").update(Buffer.from(y.buffer)).digest("hex"));
    len = y.length / SR;
    for (let i = 0; i + 2400 <= y.length - 2400; i += 2400) worstGap = Math.min(worstGap, db(rms(y.subarray(i, i + 2400))));
  }
  check(sums.size === 1 && Math.abs(len - 1.0) < 0.06 && worstGap > -30,
    `4 exports of 3 × 0.4 s clips with 0.1 s fades: ${sums.size} distinct result(s), ${len.toFixed(3)} s, quietest 50 ms ${worstGap.toFixed(1)} dBFS${acrossfadeUnreliable(v) ? " (mixed joins)" : ""}`);

  writeFileSync(join(dir, "done"), "ok");
  if (failures) {
    console.error(`\nFFCOMPAT SMOKE TEST FAILED (${failures}) on FFmpeg ${v.label}`);
    process.exit(1);
  }
  console.log(`\nFFCOMPAT SMOKE TEST PASSED on FFmpeg ${v.label}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
