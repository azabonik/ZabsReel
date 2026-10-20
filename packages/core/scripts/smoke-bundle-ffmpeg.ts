/**
 * Smoke test: the bundle's FFmpeg gate (apps/desktop/scripts/bundle-ffmpeg.mts,
 * run by prepare-bundle.ts). Needs `npm run build` (it reads core's dist).
 *
 *  1. With recorded `-version` banners (no binaries): a tested release (4.4,
 *     6.1, 7.1, 8.1) is accepted; ffmpeg and ffprobe from different builds are
 *     refused; an untested release (5.1, 6.0, 7.0) is refused unless
 *     AIVE_BUNDLE_ALLOW_UNTESTED_FFMPEG=1 (then shipped, marked untested).
 *  2. The running FFmpeg (AIVE_FFMPEG / AIVE_FFPROBE or PATH) staged into a
 *     scratch directory: byte-identical copies whose sha256 is recorded; a
 *     refused build writes nothing.
 *  3. With AIVE_BUNDLE_SMOKE_BUILDS=<dir> holding <dir>/{5.1,7.1,8.1}/bin/{ffmpeg,ffprobe}
 *     (static builds), the same accept / mismatch / untested cases on real binaries.
 *
 * Run: npx tsx packages/core/scripts/smoke-bundle-ffmpeg.ts
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { checkFfmpegBuild, stageFfmpeg } from "../../../apps/desktop/scripts/bundle-ffmpeg.mts";
import { FFMPEG_BIN, FFPROBE_BIN } from "../src/ffmpeg/executor.js";

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
}

/** The error message `p` rejects with, or null when it resolves. */
async function refusal(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

// `ffmpeg -version` / `ffprobe -version` heads (+ libavfilter): 4.4, 5.1, 6.1, 7.1 and 8.1 as the builds
// the matrix ran print them, 6.0 and 7.0 in the release form.
const BUILDS: Record<string, { release: string; lavfi: string }> = {
  "4.4": { release: "4.4.2-0ubuntu0.22.04.1", lavfi: "7.110.100 /  7.110.100" },
  "5.1": { release: "n5.1.6-11-gcde3c5fc0c-20241130", lavfi: "8. 44.100 /  8. 44.100" },
  "6.0": { release: "6.0.1", lavfi: "9.  3.100 /  9.  3.100" },
  "6.1": { release: "n6.1.2-15-ga6a07eebdf-20241130", lavfi: "9. 12.100 /  9. 12.100" },
  "7.0": { release: "7.0.2", lavfi: "10.  1.100 / 10.  1.100" },
  "7.1": { release: "n7.1.5-12-g1fdbca85aa-20260731", lavfi: "10.  5.100 / 10.  5.100" },
  "8.1": { release: "n8.1.3-18-g46d899d7a0-20261012", lavfi: "11. 14.103 / 11. 14.103" },
};
/** A fake `-version` for binaries named "<build>/ffmpeg" and "<build>/ffprobe". */
async function fakeRun(bin: string): Promise<string> {
  const [build, tool] = bin.split("/");
  const b = BUILDS[build];
  if (!b) throw new Error(`no banner for ${bin}`);
  return tool === "ffprobe"
    ? `ffprobe version ${b.release} Copyright (c) 2007-2026 the FFmpeg developers\nbuilt with gcc 14\nlibavfilter    ${b.lavfi}\n`
    : `ffmpeg version ${b.release} Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with gcc 14\nlibavfilter    ${b.lavfi}\n`;
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** `bin` as a path (a bare name is looked up on PATH, as the executor runs it). */
function resolveBin(bin: string): string {
  if (isAbsolute(bin)) return bin;
  const exe = process.platform === "win32" ? ".exe" : "";
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    if (d && existsSync(join(d, bin + exe))) return join(d, bin + exe);
  }
  throw new Error(`${bin} is not on PATH`);
}

async function main(): Promise<void> {
  delete process.env.AIVE_BUNDLE_ALLOW_UNTESTED_FFMPEG;
  const warnings: string[] = [];
  const opts = { run: fakeRun, warn: (m: string) => void warnings.push(m) };

  console.log("1. the gate, with recorded banners...");
  for (const build of ["4.4", "6.1", "7.1", "8.1"]) {
    const r = await checkFfmpegBuild(`${build}/ffmpeg`, `${build}/ffprobe`, opts).catch((e: Error) => e);
    check(!(r instanceof Error) && r.version === build && r.tested, `${build} ffmpeg + ffprobe: accepted as tested (${r instanceof Error ? r.message : `${r.version}, tested=${r.tested}`})`);
  }
  const mixed = await refusal(checkFfmpegBuild("7.1/ffmpeg", "8.1/ffprobe", opts));
  check(!!mixed && /different builds/.test(mixed), `7.1 ffmpeg + 8.1 ffprobe: refused (${mixed})`);
  const mixedUntested = await refusal(checkFfmpegBuild("7.1/ffmpeg", "8.1/ffprobe", { ...opts, allowUntested: true }));
  check(!!mixedUntested && /different builds/.test(mixedUntested), "…also with untested builds allowed");
  for (const build of ["5.1", "6.0", "7.0"]) {
    const msg = await refusal(checkFfmpegBuild(`${build}/ffmpeg`, `${build}/ffprobe`, opts));
    check(!!msg && msg.includes(`FFmpeg ${build} `) && /not a tested release/.test(msg), `${build}: refused as untested (${msg})`);
  }
  process.env.AIVE_BUNDLE_ALLOW_UNTESTED_FFMPEG = "true";
  const notOne = await refusal(checkFfmpegBuild("5.1/ffmpeg", "5.1/ffprobe", opts));
  check(!!notOne && /not a tested release/.test(notOne), "5.1 with AIVE_BUNDLE_ALLOW_UNTESTED_FFMPEG=true: still refused (only 1 overrides)");
  process.env.AIVE_BUNDLE_ALLOW_UNTESTED_FFMPEG = "1";
  warnings.length = 0;
  const shipped = await checkFfmpegBuild("5.1/ffmpeg", "5.1/ffprobe", opts).catch((e: Error) => e);
  check(!(shipped instanceof Error) && shipped.version === "5.1" && !shipped.tested && warnings.length === 1 && /not a tested release/.test(warnings[0]),
    `5.1 with AIVE_BUNDLE_ALLOW_UNTESTED_FFMPEG=1: shipped, tested=false, one warning (${shipped instanceof Error ? shipped.message : warnings[0]})`);
  delete process.env.AIVE_BUNDLE_ALLOW_UNTESTED_FFMPEG;

  console.log("2. staging the running FFmpeg into a scratch directory...");
  const dir = mkdtempSync(join(tmpdir(), "zedmix-bundle-ffmpeg-"));
  console.log(`   work dir ${dir}`);
  try {
    const [srcFf, srcProbe] = [resolveBin(FFMPEG_BIN), resolveBin(FFPROBE_BIN)];
    const staged = await stageFfmpeg(srcFf, srcProbe, join(dir, "ffmpeg"), { allowUntested: true, warn: () => {} });
    const exe = process.platform === "win32" ? ".exe" : "";
    const [outFf, outProbe] = [join(dir, "ffmpeg", `ffmpeg${exe}`), join(dir, "ffmpeg", `ffprobe${exe}`)];
    check(staged.sha256.ffmpeg === sha(srcFf) && staged.sha256.ffprobe === sha(srcProbe) && sha(outFf) === sha(srcFf) && sha(outProbe) === sha(srcProbe),
      `FFmpeg ${staged.version} (tested=${staged.tested}) staged byte-identical; the recorded sha256 is the source's (${staged.sha256.ffmpeg.slice(0, 12)}…)`);
    const again = await stageFfmpeg(srcFf, srcProbe, join(dir, "ffmpeg"), { allowUntested: true, warn: () => {} });
    check(again.sha256.ffmpeg === staged.sha256.ffmpeg && again.sha256.ffprobe === staged.sha256.ffprobe, "re-staging keeps the same files");
    const refusedDir = join(dir, "refused");
    const refused = await refusal(stageFfmpeg(srcFf, srcProbe, refusedDir, { run: (bin) => fakeRun(bin === srcFf ? "5.1/ffmpeg" : "5.1/ffprobe") }));
    check(!!refused && !existsSync(refusedDir), `a refused build stages nothing (${refused})`);

    const builds = process.env.AIVE_BUNDLE_SMOKE_BUILDS;
    if (builds) {
      console.log(`3. real static builds in ${builds}...`);
      const bin = (v: string, tool: string) => join(builds, v, "bin", tool + exe);
      const ok71 = await stageFfmpeg(bin("7.1", "ffmpeg"), bin("7.1", "ffprobe"), join(dir, "s71"));
      check(ok71.version === "7.1" && ok71.tested && ok71.sha256.ffmpeg === sha(bin("7.1", "ffmpeg")) && ok71.sha256.ffprobe === sha(bin("7.1", "ffprobe")),
        `7.1 / 7.1: accepted, tested=true, sha256 recorded (${ok71.sha256.ffmpeg.slice(0, 12)}…)`);
      const mix = await refusal(stageFfmpeg(bin("7.1", "ffmpeg"), bin("8.1", "ffprobe"), join(dir, "smix")));
      check(!!mix && /different builds/.test(mix) && !existsSync(join(dir, "smix")), `7.1 ffmpeg + 8.1 ffprobe: refused, nothing staged (${mix})`);
      const old = await refusal(stageFfmpeg(bin("5.1", "ffmpeg"), bin("5.1", "ffprobe"), join(dir, "s51")));
      check(!!old && /not a tested release/.test(old) && !existsSync(join(dir, "s51")), "5.1 / 5.1: refused, nothing staged");
      process.env.AIVE_BUNDLE_ALLOW_UNTESTED_FFMPEG = "1";
      const forced = await stageFfmpeg(bin("5.1", "ffmpeg"), bin("5.1", "ffprobe"), join(dir, "s51"), { warn: () => {} });
      delete process.env.AIVE_BUNDLE_ALLOW_UNTESTED_FFMPEG;
      check(forced.version === "5.1" && !forced.tested && forced.sha256.ffmpeg === sha(bin("5.1", "ffmpeg")), "5.1 / 5.1 with AIVE_BUNDLE_ALLOW_UNTESTED_FFMPEG=1: shipped, tested=false");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true }); // the staged copies are large
  }

  if (failures) {
    console.error(`\nBUNDLE FFMPEG SMOKE TEST FAILED (${failures} check${failures > 1 ? "s" : ""})`);
    process.exit(1);
  }
  console.log("\nBUNDLE FFMPEG SMOKE TEST PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
