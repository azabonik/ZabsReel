/**
 * FFmpeg versions and the few behaviours that differ between the releases
 * ZedMix supports (4.4 and 6.1 – 9.0). Pure: executor.ts runs the probes
 * (`ffmpeg -version` once per process, plus two lazy feature probes) and
 * applies what is decided here.
 *
 * Differences handled (each measured with real builds; docs/TESTING.md has the
 * per-version matrix):
 *  - `-filter_complex_script` is deprecated in 7.x/8.x and removed in 9.0; its
 *    replacement `-/filter_complex` exists from 7.0 ({@link preferredFilterScriptFlag}).
 *  - From 8.1, FFmpeg tracks an ALPHA MODE (straight / premultiplied) per link
 *    and inserts conversions where filters disagree. Our graphs use
 *    premultiply / unpremultiply as plain arithmetic between straight-alpha
 *    filters, so 8.1+ converted the result back and undid it (an "add" blend
 *    at 60 % opacity came out at 100 %). {@link adaptFilterGraph} retags the
 *    frames around those filters so no conversion is inserted.
 *  - afftdn was rewritten in 5.0 (libavfilter 8): it delays its output by
 *    25 ms and its noise floor sits on another scale ({@link hasAfftdnV2},
 *    effects/audio.ts).
 *  - afftfilt was rewritten in 5.1 (libavfilter 8.28): sqrt-Hann analysis and
 *    synthesis windows, latency win_size − hop ({@link hasAfftfiltV2},
 *    effects/audio.ts robotSteps).
 *  - anlmdn crashes in FFmpeg 9.0, and now and then deadlocks (executor.ts
 *    probeAnlmdn, anlmdnWorks).
 *  - acrossfade drops audio when its second input ends first in 6.1 – 7.x and
 *    pre-8.0 git builds ({@link acrossfadeUnreliable}).
 *  - xfade drops the outgoing clip's last frame before 7.0 ({@link xfadeNeedsEofPad}).
 *  - `ffmpeg -filters` prints 2 flag columns from 8.0 (3 before; audio/fx.ts).
 */
import { PRODUCT_NAME } from "../brand.js";

/**
 * FFmpeg releases the full test matrix ran against (docs/TESTING.md). Bundles
 * must ship one of them (apps/desktop/scripts/prepare-bundle.ts).
 */
export const TESTED_FFMPEG_VERSIONS = ["4.4", "6.1", "7.1", "8.0", "8.1", "9.0"] as const;
/** Major versions the core runs on without a startup warning. */
export const TESTED_FFMPEG_MAJORS: readonly number[] = [...new Set(TESTED_FFMPEG_VERSIONS.map((v) => Number(v.split(".")[0])))];

/** libavfilter major → FFmpeg major (for git builds whose banner has no release number). */
const LAVFI_TO_FFMPEG: Readonly<Record<number, number>> = { 7: 4, 8: 5, 9: 6, 10: 7, 11: 8, 12: 9 };

export interface FfmpegVersion {
  /** The banner's first line, e.g. "ffmpeg version 7.1.1 Copyright (c) 2000-2025 …". */
  banner: string;
  /** Release major.minor from the banner; null for a git/nightly build ("N-12345-g…", "2026-…-git-…"). */
  major: number | null;
  minor: number | null;
  /** libavfilter major version (7 = FFmpeg 4.x … 12 = 9.x); null when not printed. */
  lavfi: number | null;
  /** libavfilter minor version; null when not printed. */
  lavfiMinor: number | null;
  /**
   * FFmpeg generation the filters behave like: the release major, else derived
   * from libavfilter. Null only when neither is known.
   */
  generation: number | null;
  /** A release whose major the matrix ran against (git builds are never "tested"). */
  tested: boolean;
  /** Short label for logs: "7.1", "git build (libavfilter 11)", "unknown". */
  label: string;
}

/** Parse `ffmpeg -version` output (smoke-ffcompat checks real banners). */
export function parseFfmpegVersion(output: string): FfmpegVersion {
  const banner = output.split(/\r?\n/)[0]?.trim() ?? "";
  // "ffmpeg version 4.4.2-0ubuntu0.22.04.1", "ffmpeg version n9.0.2-27-g…", "ffmpeg version 7.1-full_build-www.gyan.dev".
  const rel = /^ffmpeg version n?(\d+)\.(\d+)/i.exec(banner);
  const lav = /^\s*libavfilter\s+(\d+)\.\s*(\d+)/m.exec(output);
  const major = rel ? Number(rel[1]) : null;
  const minor = rel ? Number(rel[2]) : null;
  const lavfi = lav ? Number(lav[1]) : null;
  const lavfiMinor = lav ? Number(lav[2]) : null;
  const generation = major ?? (lavfi !== null ? LAVFI_TO_FFMPEG[lavfi] ?? null : null);
  const label = major !== null ? `${major}.${minor}` : lavfi !== null ? `git build (libavfilter ${lavfi})` : "unknown";
  return { banner, major, minor, lavfi, lavfiMinor, generation, tested: major !== null && TESTED_FFMPEG_MAJORS.includes(major), label };
}

/** The startup warning for an FFmpeg outside the tested set, or null for a tested release. */
export function untestedFfmpegWarning(v: FfmpegVersion): string | null {
  if (v.tested) return null;
  return (
    `WARNING: FFmpeg ${v.label} is not a version ${PRODUCT_NAME} is tested with ` +
    `(tested: ${TESTED_FFMPEG_VERSIONS.join(", ")}). Renders may fail or look different; ` +
    `install one of those releases or point AIVE_FFMPEG / AIVE_FFPROBE at one.`
  );
}

/** The option that reads a filtergraph from a file, for this generation (see executor.ts runFfmpeg). */
export function preferredFilterScriptFlag(v: Pick<FfmpegVersion, "generation"> | null): "-filter_complex_script" | "-/filter_complex" {
  return v?.generation != null && v.generation >= 7 ? "-/filter_complex" : "-filter_complex_script";
}

/**
 * The output option that passes decoded frames through as they are, none
 * repeated or dropped (motion/motionmedia.ts): -fps_mode from FFmpeg 6 (it
 * exists from 5.1, where -vsync still works), -vsync before. An unknown build
 * counts as current.
 */
export function passthroughFlag(v: Pick<FfmpegVersion, "generation"> | null): ["-fps_mode" | "-vsync", "passthrough"] {
  return v?.generation != null && v.generation < 6 ? ["-vsync", "passthrough"] : ["-fps_mode", "passthrough"];
}

/**
 * True for the rewritten afftdn (FFmpeg ≥ 5, libavfilter ≥ 8): 25 ms output
 * delay at 48 kHz and a different noise-floor scale. An unknown build counts
 * as current.
 */
export function hasAfftdnV2(v: Pick<FfmpegVersion, "generation"> | null): boolean {
  return v?.generation == null || v.generation >= 5;
}

/**
 * True for afftfilt's 2022 rewrite (FFmpeg ≥ 5.1, libavfilter ≥ 8.28; commit f984383ea0):
 * sqrt-Hann analysis AND synthesis windows (the robot's buzz pulse sits where the synthesis
 * window is 0), latency win_size − hop, output length = input length. 5.0.x (libavfilter 8.24)
 * is still the old filter. An unknown build counts as current.
 */
export function hasAfftfiltV2(v: Pick<FfmpegVersion, "major" | "minor" | "lavfi" | "lavfiMinor"> | null): boolean {
  if (!v) return true;
  if (v.major !== null) return v.major > 5 || (v.major === 5 && (v.minor ?? 0) >= 1);
  if (v.lavfi !== null) return v.lavfi > 8 || (v.lavfi === 8 && (v.lavfiMinor ?? 99) >= 28);
  return true;
}

/**
 * True for FFmpeg 6.1 – 7.x (libavfilter 9.x – 10): their acrossfade ends its
 * output as soon as its SECOND input has reached EOF, even while the first is
 * still playing (FFmpeg commit c44fe10160, 2023-06: activate() checks input 1's
 * pending EOF before input 0 has finished). A ramp's chunks come from one
 * asplit (and a transition's clips are decoded side by side), so the next piece
 * is often complete before the one it joins: the rest of the first piece and
 * all of the second are dropped.
 * 6.1's single-threaded CLI does it the same way every time (a "montage" ramp
 * lost about 0.6 s: silence at its end); 7.x's threaded CLI at random (2–5
 * different outputs in 10 runs). 6.0 and 8.0+ (whose acrossfade was
 * rewritten) wait for the first input's end. graph.ts mixes instead. A git
 * build of libavfilter 9 or 11 counts as affected (mixing is correct on every
 * version): libavfilter 11 git builds made before 8.0's rewrite still have the
 * c44fe10160 code, and no one has measured the libavfilter minor of the rewrite.
 */
export function acrossfadeUnreliable(v: Pick<FfmpegVersion, "major" | "minor" | "generation" | "lavfi"> | null): boolean {
  if (v?.major === 6) return (v.minor ?? 0) >= 1;
  if (v != null && v.major === null && v.lavfi === 11) return true;
  return v?.generation === 6 || v?.generation === 7;
}

/**
 * True before FFmpeg 7 (generations 4 – 6): xfade sees the outgoing stream's
 * EOF while its last frame is still queued, drops that frame and starts the
 * incoming clip a frame late, so graph.ts pads the outgoing stream by one
 * cloned frame (RenderOptions.xfadeEofPad). From 7.0 the pad would leave a hair
 * of the outgoing clip in the frame after a wipe. An unknown build counts as current.
 */
export function xfadeNeedsEofPad(v: Pick<FfmpegVersion, "generation"> | null): boolean {
  return v?.generation != null && v.generation < 7;
}

/** Options whose value is a filtergraph. */
export const FILTERGRAPH_OPTIONS: ReadonlySet<string> = new Set(["-filter_complex", "-lavfi", "-vf", "-af", "-filter:v", "-filter:a"]);

/** True when `graph` uses premultiply / unpremultiply in place (what {@link adaptFilterGraph} rewrites). */
export function usesPremultiply(graph: string): boolean {
  return graph.includes("premultiply=inplace=1");
}

/**
 * Adapt one filtergraph to an FFmpeg that negotiates alpha modes (8.1+):
 * `premultiply` outputs frames tagged PREMULTIPLIED and `unpremultiply` wants
 * them as input, and FFmpeg inserts a conversion wherever the neighbours
 * disagree — which re-did or undid our arithmetic. Retagging (not converting)
 * the frames with setparams keeps every link "straight", as FFmpeg ≤ 8.0
 * treated them. Without alpha modes the graph is returned unchanged.
 */
export function adaptFilterGraph(graph: string, caps: { alphaModes: boolean }): string {
  if (!caps.alphaModes || !usesPremultiply(graph)) return graph;
  return graph
    .replace(/\bunpremultiply=inplace=1\b/g, "setparams=alpha_mode=premultiplied,unpremultiply=inplace=1")
    .replace(/\bpremultiply=inplace=1\b/g, "premultiply=inplace=1,setparams=alpha_mode=straight");
}
