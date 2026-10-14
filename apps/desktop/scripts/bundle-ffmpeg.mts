/**
 * The FFmpeg half of prepare-bundle.ts, importable on its own (smoke-bundle-ffmpeg.ts
 * runs it against a scratch directory): the ffmpeg/ffprobe pair about to ship
 * must be one build and a release the full smoke matrix tested (core's
 * TESTED_FFMPEG_VERSIONS), unless AIVE_BUNDLE_ALLOW_UNTESTED_FFMPEG=1; the staged
 * copies are verified byte-identical and their sha256 recorded for the manifest.
 *
 * Runs under plain `node` (type stripping) like prepare-bundle.ts, so it reads
 * core's COMPILED version module.
 */
import { mkdir, copyFile, access } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { join, dirname } from "node:path";

import { parseFfmpegVersion, TESTED_FFMPEG_VERSIONS } from "../../../packages/core/dist/ffmpeg/version.js";

/** What bundle-manifest.json records about the staged FFmpeg. */
export interface StagedFfmpeg {
  version: string;
  banner: string;
  tested: boolean;
  sha256: { ffmpeg: string; ffprobe: string };
}

export interface FfmpegBuildCheck {
  /** Runs `bin -version` and returns its stdout (default: the real binary). */
  run?: (bin: string, args: string[]) => Promise<string>;
  /** Ship an untested release anyway (default: AIVE_BUNDLE_ALLOW_UNTESTED_FFMPEG=1). */
  allowUntested?: boolean;
  /** Where the untested-release warning goes (default: console.warn). */
  warn?: (msg: string) => void;
}

const execFileP = promisify(execFile);
const runBinary = async (bin: string, args: string[]): Promise<string> => (await execFileP(bin, args)).stdout;

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function sha256(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

/** Copy src → dest unless dest already has the same content; returns dest's sha256. */
export async function copyVerified(src: string, dest: string): Promise<string> {
  await mkdir(dirname(dest), { recursive: true });
  const want = await sha256(src);
  if (!(await exists(dest)) || (await sha256(dest)) !== want) await copyFile(src, dest);
  const got = await sha256(dest);
  if (got !== want) throw new Error(`staged ${dest} does not match ${src} (sha256 ${got} vs ${want})`);
  return got;
}

/**
 * Check the ffmpeg/ffprobe about to ship: same release, and one the matrix
 * tested (or AIVE_BUNDLE_ALLOW_UNTESTED_FFMPEG=1).
 */
export async function checkFfmpegBuild(
  ffmpeg: string,
  ffprobe: string,
  opts: FfmpegBuildCheck = {},
): Promise<{ version: string; banner: string; tested: boolean }> {
  const run = opts.run ?? runBinary;
  const v = parseFfmpegVersion(await run(ffmpeg, ["-version"]));
  const probeBanner = (await run(ffprobe, ["-version"])).split(/\r?\n/)[0] ?? "";
  const probeRelease = /^ffprobe version (\S+)/.exec(probeBanner)?.[1];
  const ffRelease = /^ffmpeg version (\S+)/.exec(v.banner)?.[1];
  if (!probeRelease || probeRelease !== ffRelease) {
    throw new Error(`ffmpeg (${ffRelease ?? v.banner}) and ffprobe (${probeRelease ?? probeBanner}) are from different builds — stage a matching pair.`);
  }
  const version = v.major !== null ? `${v.major}.${v.minor}` : v.label;
  const tested = (TESTED_FFMPEG_VERSIONS as readonly string[]).includes(version);
  if (!tested) {
    const msg =
      `FFmpeg ${version} (${v.banner}) is not a tested release (tested: ${TESTED_FFMPEG_VERSIONS.join(", ")}). ` +
      "Point AIVE_FFMPEG / AIVE_FFPROBE at a tested static build, or set AIVE_BUNDLE_ALLOW_UNTESTED_FFMPEG=1 to ship it anyway.";
    if (!(opts.allowUntested ?? process.env.AIVE_BUNDLE_ALLOW_UNTESTED_FFMPEG === "1")) throw new Error(msg);
    (opts.warn ?? console.warn)(`  ! ${msg} (shipping it: AIVE_BUNDLE_ALLOW_UNTESTED_FFMPEG=1)`);
  }
  return { version, banner: v.banner, tested };
}

/**
 * Check the pair, then stage it as `dir`/ffmpeg(.exe) and `dir`/ffprobe(.exe).
 * Nothing is written when the check refuses the build.
 */
export async function stageFfmpeg(ffmpeg: string, ffprobe: string, dir: string, opts: FfmpegBuildCheck = {}): Promise<StagedFfmpeg> {
  const release = await checkFfmpegBuild(ffmpeg, ffprobe, opts);
  const exe = process.platform === "win32" ? ".exe" : "";
  const sums = {
    ffmpeg: await copyVerified(ffmpeg, join(dir, "ffmpeg" + exe)),
    ffprobe: await copyVerified(ffprobe, join(dir, "ffprobe" + exe)),
  };
  return { ...release, sha256: sums };
}
