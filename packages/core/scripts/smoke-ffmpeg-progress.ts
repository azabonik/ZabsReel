/**
 * Smoke test: the progress runFfmpeg reports never goes backwards
 * (packages/core/src/ffmpeg/executor.ts). No real FFmpeg and no media:
 * AIVE_FFMPEG points to a stub that prints a fixed `-progress` sequence, so the
 * result does not depend on load or on the FFmpeg version.
 *
 * FFmpeg 9.0 (upstream 8a0ae6b344) gives `out_time` as the largest dts of the
 * output streams that are still running: when an audio stream ends ahead of the
 * video, out_time goes back to the video's dts. A job's progress then went
 * backwards (generate_proxy 94% → 83% → 100%; smoke-cutout's "never backwards"
 * check failed on a loaded runner).
 *
 *  1. The stub prints what FFmpeg 9.0 prints for such a run: out_time_us 0.5 s,
 *     1.5 s, 2.9 s, then 2.7 s (the audio ended), then progress=end at 3.0 s.
 *     Each block is its own write, and one line is split across two writes.
 *     Control: run directly, it prints the backward value.
 *  2. runFfmpeg with onProgress and a 3 s totalDuration runs the stub: the
 *     fractions never decrease, end at 1, the backward value (2.7 s) is not
 *     reported, and each forward value is (0.5, 1.5, 2.9 s and the end).
 *  3. A second run reports its own values from the start again (the furthest
 *     fraction reached belongs to one run, not to the process).
 *
 * Run: npx tsx packages/core/scripts/smoke-ffmpeg-progress.ts
 */
import { execa } from "execa";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The totalDuration runFfmpeg gets, in seconds. */
const TOTAL = 3;
/** out_time_us of each block the stub prints, in order; the last block ends the run (progress=end). */
const OUT_TIMES_US = [500_000, 1_500_000, 2_900_000, 2_700_000, 3_000_000];
/** The value that goes back: the audio stream ended, out_time is the video's dts again. */
const BACKWARD_US = 2_700_000;
/** The arguments runFfmpeg gets (the stub reads none of them; -progress pipe:1 is what the callers pass). */
const ARGS = ["-hide_banner", "-progress", "pipe:1", "-f", "null", "-"];

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
}

/** A fraction as runFfmpegOnce computes it from out_time_us (so equal values compare equal). */
const fraction = (us: number) => Math.max(0, Math.min(1, us / 1e6 / TOTAL));
const show = (fs: number[]) => `[${fs.map((f) => f.toFixed(3)).join(", ")}]`;
/** `fs` without adjacent repeats: FFmpeg prints out_time_us and out_time_ms (also microseconds), and both are read. */
const distinct = (fs: number[]) => fs.filter((f, i) => i === 0 || f !== fs[i - 1]);

// One -progress block per value, as FFmpeg prints them, each its own write 20 ms apart; the second block's
// out_time_us line is split across two writes. `-version` gets a 9.0 banner, in case something asks.
const STUB_MJS = `
const args = process.argv.slice(2);
if (args.includes("-version")) {
  process.stdout.write("ffmpeg version n9.0.2-stub Copyright (c) 2000-2026 the FFmpeg developers\\n");
} else {
  const times = ${JSON.stringify(OUT_TIMES_US)};
  const clock = (us) => "00:00:" + (us / 1e6).toFixed(6).padStart(9, "0");
  const writes = [];
  times.forEach((us, i) => {
    const block = [
      "frame=" + 15 * (i + 1), "fps=30.00", "stream_0_0_q=-1.0", "bitrate=N/A", "total_size=" + 4096 * (i + 1),
      "out_time_us=" + us, "out_time_ms=" + us, "out_time=" + clock(us), "dup_frames=0", "drop_frames=0", "speed=1.00x",
      "progress=" + (i === times.length - 1 ? "end" : "continue"),
    ].join("\\n") + "\\n";
    const cut = i === 1 ? block.indexOf("out_time_us=") + "out_time_us=".length + 2 : -1;
    if (cut > 0) writes.push(block.slice(0, cut), block.slice(cut));
    else writes.push(block);
  });
  for (const w of writes) {
    process.stdout.write(w);
    await new Promise((r) => setTimeout(r, 20));
  }
}
`;

/** Write the stub into `dir` and return the path to run it by. */
function writeStub(dir: string): string {
  if (process.platform === "win32") {
    writeFileSync(join(dir, "ffstub.mjs"), STUB_MJS);
    const cmd = join(dir, "ffmpeg.cmd");
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "%~dp0ffstub.mjs" %*\r\n`);
    return cmd;
  }
  const f = join(dir, "ffmpeg.mjs");
  writeFileSync(f, `#!/usr/bin/env node\n${STUB_MJS}`);
  chmodSync(f, 0o755);
  return f;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "zedmix-ffmpeg-progress-"));
  console.log(`work dir ${dir}`);
  try {
    const stub = writeStub(dir);
    // executor.ts reads AIVE_FFMPEG when it loads, so it is imported after this.
    process.env.AIVE_FFMPEG = stub;

    console.log("1. the stub prints FFmpeg 9.0's -progress for a run whose audio ends first...");
    const direct = await execa(stub, ARGS);
    const printed = [...direct.stdout.matchAll(/^out_time_us=(\d+)$/gm)].map((m) => Number(m[1]));
    check(JSON.stringify(printed) === JSON.stringify(OUT_TIMES_US), `out_time_us goes 0.5 s, 1.5 s, 2.9 s, back to 2.7 s, then 3.0 s (${printed.map((us) => us / 1e6).join(", ")})`);
    check(/^progress=end$/m.test(direct.stdout) && direct.exitCode === 0, `it ends with progress=end and exits 0 (exit ${direct.exitCode})`);

    const { FFMPEG_BIN, runFfmpeg } = await import("../src/ffmpeg/executor.js");
    check(FFMPEG_BIN === stub, `the executor runs the stub (${FFMPEG_BIN})`);

    console.log(`2. runFfmpeg reports progress (totalDuration ${TOTAL} s)...`);
    const want = OUT_TIMES_US.filter((us) => us !== BACKWARD_US).map(fraction);
    const got: number[] = [];
    await runFfmpeg(ARGS, { totalDuration: TOTAL, onProgress: (f) => got.push(f) });
    check(got.length > 0 && got.every((f, i) => i === 0 || f >= got[i - 1]), `the fractions never decrease ${show(got)}`);
    check(got.at(-1) === 1, `they end at 1 (${got.at(-1)})`);
    check(!got.includes(fraction(BACKWARD_US)), `the backward value (${BACKWARD_US / 1e6} s = ${fraction(BACKWARD_US).toFixed(3)}) is not reported`);
    check(JSON.stringify(distinct(got)) === JSON.stringify(want), `each forward value is reported, in order: ${show(distinct(got))} (want ${show(want)})`);

    console.log("3. a second run starts from its own first value...");
    const again: number[] = [];
    await runFfmpeg(ARGS, { totalDuration: TOTAL, onProgress: (f) => again.push(f) });
    check(JSON.stringify(distinct(again)) === JSON.stringify(want), `the second run reports the same values ${show(distinct(again))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures) {
    console.error(`\nFFMPEG PROGRESS SMOKE TEST FAILED (${failures} check${failures === 1 ? "" : "s"})`);
    process.exit(1);
  }
  console.log("\nFFMPEG PROGRESS SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("FFMPEG PROGRESS SMOKE TEST FAILED:", err);
  process.exit(1);
});
