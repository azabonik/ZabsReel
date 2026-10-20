/**
 * FFmpeg's input-format allowlist (executor.ts MEDIA_DEMUXERS) keeps every
 * kind of media ZedMix reads working: the no-regression check for it.
 *
 * With the FFmpeg it is given (AIVE_FFMPEG / AIVE_FFPROBE, or PATH), it makes
 * one small sample per container and still-image format on the list that this
 * build can write (lavfi sources; the picker types mp4, mov, mkv, webm, avi,
 * m4v, wav, mp3, aac, png, jpg, jpeg, webp, gif and bmp among them), then
 * probes it and decodes one frame twice: through the core's helpers
 * (runFfprobe / runFfmpeg, with the allowlist) and directly (only the
 * protocol allowlist). Each sample must give the same result both ways; one
 * that only fails with the allowlist is a regression. A sample this build
 * can't write, or can't read either way, is printed as skipped. A probed
 * format_name with no name on MEDIA_DEMUXERS is printed too (a later FFmpeg
 * that renames a demuxer), and fails the smoke when the sample was readable.
 *
 * A name joins MEDIA_DEMUXERS only together with a sample here.
 *
 * No network: every sample is a local file in a temp folder.
 * Run: npx tsx packages/core/scripts/smoke-demuxers.ts
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FFMPEG_BIN, FFPROBE_BIN, MEDIA_DEMUXERS, PROTOCOL_WHITELIST, runFfmpeg, runFfprobe } from "../src/ffmpeg/executor.js";

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};

/** Exit code 0 of `bin args` (no shell). */
const runs = (bin: string, args: string[]) =>
  new Promise<boolean>((res) => execFile(bin, args, { timeout: 60_000, maxBuffer: 16 << 20 }, (err) => res(!err)));

const V = ["-f", "lavfi", "-i", "testsrc=size=64x48:rate=10", "-f", "lavfi", "-i", "sine", "-t", "1"];
const V2 = ["-f", "lavfi", "-i", "testsrc2=s=128x72:r=25:d=1"];
const IMG = ["-f", "lavfi", "-i", "testsrc=size=64x48", "-frames:v", "1"];
const A = ["-f", "lavfi", "-i", "sine", "-t", "1"];
const A2 = ["-f", "lavfi", "-i", "sine=d=1:sample_rate=48000"];
/** [file, ffmpeg arguments before the output (null: written here)]: the research set (gen.sh, gen2.sh). */
const SAMPLES: [string, string[] | null][] = [
  ["a.mp4", [...V, "-c:v", "libx264", "-c:a", "aac"]],
  ["a.mov", [...V, "-c:v", "libx264", "-c:a", "aac"]],
  ["a.m4v", [...V, "-c:v", "libx264", "-an", "-f", "mp4"]],
  ["a.3gp", [...V, "-c:v", "libx264", "-c:a", "aac", "-f", "3gp"]],
  ["a.mkv", [...V, "-c:v", "libx264", "-c:a", "aac"]],
  ["a.webm", [...V, "-c:v", "libvpx", "-c:a", "libopus"]],
  ["a.avi", [...V, "-c:v", "mpeg4", "-c:a", "libmp3lame"]],
  ["a.ts", [...V, "-c:v", "libx264", "-c:a", "aac"]],
  ["a.m2ts", [...V, "-c:v", "libx264", "-c:a", "aac", "-f", "mpegts"]],
  ["a.mpg", [...V, "-c:v", "mpeg2video", "-c:a", "mp2"]],
  ["a.vob", [...V, "-c:v", "mpeg2video", "-c:a", "mp2", "-f", "vob"]],
  ["a.flv", [...V, "-c:v", "flv1", "-c:a", "libmp3lame", "-ar", "44100"]],
  ["a.wmv", [...V, "-c:v", "wmv2", "-c:a", "wmav2"]],
  ["a.mxf", ["-f", "lavfi", "-i", "testsrc=size=64x48:rate=25", "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "1", "-c:v", "mpeg2video", "-c:a", "pcm_s16le"]],
  ["a.dv", ["-f", "lavfi", "-i", "testsrc=size=720x576:rate=25", "-t", "1", "-c:v", "dvvideo", "-pix_fmt", "yuv420p"]],
  ["a.ogv", [...V, "-c:v", "libtheora", "-c:a", "libvorbis"]],
  ["a.nut", [...V, "-c:v", "mpeg4", "-c:a", "pcm_s16le"]],
  ["a.y4m", ["-f", "lavfi", "-i", "testsrc=size=64x48", "-t", "1", "-pix_fmt", "yuv420p"]],
  ["a.h264", ["-f", "lavfi", "-i", "testsrc=size=64x48", "-t", "1", "-c:v", "libx264"]],
  ["a.hevc", ["-f", "lavfi", "-i", "testsrc=size=64x48", "-t", "1", "-c:v", "libx265"]],
  ["a.ivf", ["-f", "lavfi", "-i", "testsrc=size=64x48", "-t", "1", "-c:v", "libvpx"]],
  ["a_mjpeg.mov", [...V, "-c:v", "mjpeg", "-c:a", "pcm_s16le"]],
  ["a_prores.mov", [...V, "-c:v", "prores_ks", "-c:a", "pcm_s16le"]],
  ["a.m4a", [...A, "-c:a", "aac"]],
  ["a.wav", A],
  ["a.w64", [...A, "-f", "w64"]],
  ["a.mp3", A],
  ["a.aac", [...A, "-c:a", "aac", "-f", "adts"]],
  ["a.ac3", A],
  ["a.eac3", [...A, "-c:a", "eac3"]],
  ["a.flac", A],
  ["a.ogg", [...A, "-c:a", "libvorbis"]],
  ["a.opus", [...A, "-c:a", "libopus"]],
  ["a.aiff", A],
  ["a.caf", [...A, "-c:a", "pcm_s16le", "-f", "caf"]],
  ["a.wv", [...A, "-c:a", "wavpack"]],
  ["a.amr", [...A, "-ar", "8000", "-ac", "1", "-c:a", "libopencore_amrnb"]],
  ["a.mka", [...A, "-c:a", "libopus"]],
  ["a.dts", [...A2, "-c:a", "dca", "-strict", "-2", "-ac", "2"]],
  ["a.thd", [...A2, "-c:a", "truehd", "-strict", "-2", "-ac", "2"]],
  ["a.mlp", [...A2, "-c:a", "mlp", "-strict", "-2", "-ac", "2"]],
  ["a.mp2", [...A2, "-c:a", "mp2"]],
  ["a.au", A2],
  ["a.m2v", [...V2, "-c:v", "mpeg2video"]],
  ["a.raw.m4v", [...V2, "-c:v", "mpeg4", "-f", "m4v"]],
  ["a.mjpeg", [...V2, "-c:v", "mjpeg", "-f", "mjpeg"]],
  ["a.obu", [...V2, "-c:v", "libsvtav1", "-f", "obu"]],
  ["a.png", IMG], ["a.jpg", IMG], ["a.jpeg", IMG], ["a.webp", IMG], ["a.gif", IMG], ["a.bmp", IMG],
  ["a.tif", IMG], ["a.tiff", IMG], ["a.ppm", IMG], ["a.pgm", [...IMG, "-pix_fmt", "gray"]], ["a.tga", IMG],
  ["a.jxl", [...IMG, "-c:v", "libjxl"]],
  ["a.avif", [...IMG, "-c:v", "libaom-av1", "-still-picture", "1"]],
  ["a.exr", [...IMG, "-c:v", "exr", "-pix_fmt", "gbrpf32le"]],
  ["a.apng", [...IMG, "-f", "apng"]],
  ["a.dpx", [...IMG, "-c:v", "dpx"]],
  ["a.hdr", [...V2, "-frames:v", "1"]], ["a.qoi", [...V2, "-frames:v", "1"]], ["a.pam", [...V2, "-frames:v", "1"]],
  ["a.pbm", [...V2, "-frames:v", "1", "-pix_fmt", "monob"]],
  ["a.jp2", [...V2, "-frames:v", "1", "-c:v", "jpeg2000"]],
  ["a.j2k", [...V2, "-frames:v", "1", "-c:v", "jpeg2000", "-f", "image2pipe"]],
  ["a.sgi", [...V2, "-frames:v", "1"]], ["a.xwd", [...V2, "-frames:v", "1"]], ["a.pcx", [...V2, "-frames:v", "1"]],
  ["a.svg", null],
];

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "aive-demuxers-"));
  const listed = new Set(MEDIA_DEMUXERS.split(","));
  console.log(`(FFmpeg: ${FFMPEG_BIN}, ${FFPROBE_BIN}; ${listed.size} names on MEDIA_DEMUXERS)`);
  let compared = 0;
  const skipped: string[] = [];
  try {
    for (const [name, args] of SAMPLES) {
      const file = join(dir, name);
      if (args === null) {
        writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
      } else if (!(await runs(FFMPEG_BIN, ["-nostdin", "-hide_banner", "-v", "error", "-y", ...args, file]))) {
        skipped.push(`${name} (this build can't write it)`);
        continue;
      }
      // Without the format allowlist: FFmpeg itself, with only the protocol allowlist the core always passes.
      let formatName = "";
      const bare = await new Promise<boolean>((res) =>
        execFile(FFPROBE_BIN, ["-v", "error", "-print_format", "json", "-show_format", "-protocol_whitelist", PROTOCOL_WHITELIST, file], { timeout: 60_000 }, (err, stdout) => {
          try {
            formatName = (JSON.parse(stdout) as { format?: { format_name?: string } }).format?.format_name ?? "";
          } catch {
            /* unreadable */
          }
          res(!err);
        }),
      );
      const bareDecode = bare && (await runs(FFMPEG_BIN, ["-nostdin", "-v", "error", "-protocol_whitelist", PROTOCOL_WHITELIST, "-i", file, "-frames:v", "1", "-f", "null", "-"]));
      // With it: the core's own helpers.
      const listedProbe = await runFfprobe(["-v", "error", "-print_format", "json", "-show_format", file]).then(() => true, () => false);
      const listedDecode = listedProbe && (await runFfmpeg(["-nostdin", "-v", "error", "-i", file, "-frames:v", "1", "-f", "null", "-"]).then(() => true, () => false));
      const unlisted = formatName !== "" && !formatName.split(",").some((n) => listed.has(n));
      if (unlisted) console.log(`  note ${name}: format_name "${formatName}" has no name on MEDIA_DEMUXERS`);
      if (!bare || !bareDecode) {
        skipped.push(`${name} (this build can't ${bare ? "decode" : "read"} it, with or without the allowlist${listedProbe ? "; it probes with it" : ""})`);
        continue;
      }
      compared++;
      check(listedProbe && listedDecode && !unlisted, `${name} (${formatName}): probes and decodes one frame with the allowlist as without it`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const s of skipped) console.log(`  skip ${s}`);
  // The picker types (main.cjs) and the plain formats every FFmpeg the app supports writes.
  check(compared >= 30, `${compared} samples compared (${skipped.length} skipped)`);
  console.log(failures === 0 ? "\nALL DEMUXER CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
