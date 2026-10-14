/**
 * SOTA Phase 4 deliverable: the segment render cache makes previews incremental.
 *  - First preview of a 3-clip timeline renders all segments.
 *  - An edit at the TAIL re-renders ONLY the tail segment (head segments hit
 *    the cache).
 *  - renderFrame over an unchanged region renders NOTHING new (pure cache).
 *  - The assembled preview probes at the right duration/size.
 *
 * Run: npx tsx packages/core/scripts/smoke-cache.ts
 * (Self-contained — synthesizes three colored clips with ffmpeg lavfi.)
 */
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EditorEngine } from "../src/engine.js";
import { planSegments, segmentKey } from "../src/ffmpeg/segments.js";
import { PREVIEW_PROFILE } from "../src/ffmpeg/graph.js";
import { probeAsset } from "../src/ffmpeg/ffprobe.js";
import { ffmpegVersionLine, runFfmpeg, runFfprobe } from "../src/ffmpeg/executor.js";

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "aive-cache-"));
  const engine = new EditorEngine(dataDir);
  engine.setProjectSettings({ width: 640, height: 360, fps: 30 });

  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  };

  console.log("1. synthesize three 4s colored clips...");
  const assets: string[] = [];
  for (const color of ["red", "green", "blue"]) {
    const p = join(dataDir, `${color}.mp4`);
    await runFfmpeg([
      "-f", "lavfi", "-i", `color=c=${color}:s=640x360:d=4:r=30`,
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-y", p,
    ]);
    const a = await engine.importVideo(p);
    assets.push(a.id);
    engine.appendClip(a.id);
  }

  console.log("2. first preview renders every segment...");
  const r1 = await engine.renderPreview();
  check(existsSync(r1.path), "preview file exists");
  const probed = await probeAsset(r1.path);
  check(Math.abs(probed.duration - 12) < 0.5, `preview duration ≈ 12s (got ${probed.duration.toFixed(2)})`);
  check(probed.width === 640 && probed.height === 360, `preview canvas 640x360 (got ${probed.width}x${probed.height})`);
  const firstRenders = engine.renderStats.segmentRenders;
  check(firstRenders >= 3, `all segments rendered on first pass (${firstRenders})`);
  check(engine.renderStats.singlePassRenders === 0, "segmented path was used (no single-pass fallback)");

  console.log("3. edit at the TAIL → only tail segments re-render...");
  const summary = engine.getProject();
  const lastTrack = summary.tracks.find((t) => t.kind === "video")!;
  const lastClip = lastTrack.clips[lastTrack.clips.length - 1];
  engine.setClipEffects(lastClip.id, { color: { saturation: 0.2 } });

  const before = engine.renderStats.segmentRenders;
  const hitsBefore = engine.renderStats.segmentCacheHits;
  await engine.renderPreview();
  const tailRenders = engine.renderStats.segmentRenders - before;
  const tailHits = engine.renderStats.segmentCacheHits - hitsBefore;
  check(tailRenders >= 1, `the edited tail segment re-rendered (${tailRenders})`);
  check(tailRenders < firstRenders, `fewer renders than the first pass (${tailRenders} < ${firstRenders})`);
  check(tailHits >= 2, `head segments came from cache (${tailHits} hits)`);

  console.log("4. renderFrame over an unchanged region is pure cache...");
  // Invalidate the full-preview shortcut with a NEW tail edit, then ask for a
  // frame in the (untouched) first clip: the head segment must come from cache.
  engine.setClipEffects(lastClip.id, { color: { saturation: 1.8 } });
  const b2 = engine.renderStats.segmentRenders;
  const h2 = engine.renderStats.segmentCacheHits;
  const frame = await engine.renderFrame(1.0);
  check(existsSync(frame), "frame extracted");
  check(engine.renderStats.segmentRenders === b2, `no segment re-rendered for the head frame (${engine.renderStats.segmentRenders - b2})`);
  check(engine.renderStats.segmentCacheHits === h2 + 1, "the head segment was a cache hit");

  console.log("5. AIVE_SEGMENT_CACHE=off falls back to single-pass...");
  process.env.AIVE_SEGMENT_CACHE = "off";
  try {
    const sp = engine.renderStats.singlePassRenders;
    await engine.renderPreview();
    check(engine.renderStats.singlePassRenders === sp + 1, "single-pass path used when cache disabled");
  } finally {
    delete process.env.AIVE_SEGMENT_CACHE;
  }

  console.log("N. a temporal effect on an adjustment layer keeps the timeline up to its end in ONE segment...");
  {
    const rc = (startSec: number, outDuration: number, extra: object = {}) => ({ startSec, outDuration, ...extra }) as never;
    const plain = [rc(0, 4), rc(4, 4), rc(8, 4)];
    const adj = (type: string) => rc(0, 8, { adjustment: true, effects: { filters: [{ type }] } });
    const before = planSegments(plain, 12).length;
    const withTrails = planSegments([...plain, adj("trails")], 12);
    const withBlur = planSegments([...plain, adj("blur")], 12);
    check(before === 3 && withBlur.length === 3, `no temporal effect: cuts at clip edges (${before} / ${withBlur.length} segments)`);
    check(withTrails.length === 2 && withTrails[0].start === 0 && withTrails[0].end === 8, `trails adjustment 0-8 s: first segment is 0-8 s (${JSON.stringify(withTrails)})`);
  }

  console.log("N. the segment key follows the FFmpeg build (version banner + xfade end-of-stream pad)...");
  {
    const rc = (startSec: number, outDuration: number, extra: object = {}) => ({ path: "/x.mp4", startSec, outDuration, ...extra }) as never;
    const clips = [rc(0, 4), rc(3, 4, { transition: { type: "fade", durationSec: 1 } })];
    const seg = { start: 0, end: 7 };
    const canvas = { width: 640, height: 360, fps: 30 };
    const line = await ffmpegVersionLine();
    const key = (ffmpeg: string, xfadeEofPad: boolean) => segmentKey(clips, seg, canvas, PREVIEW_PROFILE, {}, null, { ffmpeg, xfadeEofPad });
    check(/^ffmpeg version /.test(line) && line === (await ffmpegVersionLine()), `version banner probed once and stable ("${line}")`);
    check(key(line, true) === key(line, true), "same build: same key");
    check(key(line, true) !== key(line, false), "xfadeEofPad on / off: different keys");
    check(key("ffmpeg version 4.4.2", false) !== key("ffmpeg version 7.1", false), "another FFmpeg version: different key");
  }

  console.log("N. the opaque-base flag: staged for alpha-free sources only, never part of the segment key...");
  {
    const rc = (startSec: number, outDuration: number, extra: object = {}) => ({ path: "/x.mp4", startSec, outDuration, ...extra }) as never;
    const clips = [rc(0, 4), rc(4, 4)];
    const seg = { start: 0, end: 8 };
    const canvas = { width: 640, height: 360, fps: 30 };
    const key = (cs: never[]) => segmentKey(cs, seg, canvas, PREVIEW_PROFILE, {}, null, { ffmpeg: "ffmpeg version 4.4.2", xfadeEofPad: false });
    check(key(clips.map((c) => ({ ...(c as object), opaque: true }) as never)) === key(clips), "opaque: true hashes as unset (the shortcut renders the same pixels; cached segments stay valid)");

    const oDir = join(dataDir, "opaque");
    const oEngine = new EditorEngine(oDir);
    oEngine.setProjectSettings({ width: 640, height: 360, fps: 30 });
    const synth = (out: string, pixFmt: string, codec: string[]) =>
      runFfmpeg(["-f", "lavfi", "-i", `testsrc2=s=640x360:d=1:r=30,format=${pixFmt}`, ...codec, "-y", out]);
    const h264 = join(dataDir, "plain.mp4");
    const ffv1 = join(dataDir, "alpha.mkv");
    // QuickTime 4:4:4:4: FFmpeg 4.4.2 decodes it as yuva444p, 8.1 as uyva (a format hasAlpha's list misses).
    // 9.0 removed the v408 encoder: rawvideo tagged v408 from uyva writes the identical stream.
    const v408 = join(dataDir, "alpha-v408.mov");
    const swap = join(dataDir, "swap.mkv");
    await synth(h264, "yuv420p", ["-c:v", "libx264", "-preset", "veryfast"]);
    await synth(ffv1, "yuva420p", ["-c:v", "ffv1"]);
    let v408Path = "encoder";
    await synth(v408, "yuva444p", ["-c:v", "v408"]).catch(async (err: unknown) => {
      if (!/Unknown encoder 'v408'/.test(`${err instanceof Error ? err.message : ""}\n${(err as { stderr?: string }).stderr ?? ""}`)) throw err;
      v408Path = "rawvideo fallback";
      await synth(v408, "uyva", ["-c:v", "rawvideo", "-tag:v", "v408"]);
    });
    const v408Probe = (
      JSON.parse(await runFfprobe(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,codec_tag_string,pix_fmt", "-of", "json", v408])) as {
        streams: { codec_name: string; codec_tag_string: string; pix_fmt: string }[];
      }
    ).streams[0];
    check(
      v408Probe.pix_fmt === "yuva444p" || v408Probe.pix_fmt === "uyva",
      `v408 fixture keeps its alpha (${v408Path}: ${v408Probe.codec_name}, ${v408Probe.codec_tag_string}, ${v408Probe.pix_fmt})`,
    );
    await synth(swap, "yuv420p", ["-c:v", "libx264", "-preset", "veryfast"]);
    for (const p of [h264, ffv1, v408, swap]) oEngine.appendClip((await oEngine.importVideo(p)).id);
    type Staging = { stageRender(c: typeof oEngine.canvas): Promise<{ clips: { path: string; opaque?: boolean }[] }> };
    const staged = async () => {
      const { clips } = await (oEngine as unknown as Staging).stageRender(oEngine.canvas);
      return (p: string) => clips.find((c) => c.path === p)?.opaque;
    };
    const first = await staged();
    check(first(h264) === true, `H.264 yuv420p: staged opaque (${first(h264)})`);
    check(first(ffv1) === undefined, `FFV1 yuva420p: not opaque (${first(ffv1)})`);
    check(first(v408) === undefined, `v408 (yuva444p / uyva): not opaque (${first(v408)})`);
    check(first(swap) === true, `swap.mkv as H.264: opaque (${first(swap)})`);
    // Replaced in place (as a re-rendered overlay is) by a file with alpha: probed again, no restart.
    await synth(swap, "yuva420p", ["-c:v", "ffv1"]);
    const second = await staged();
    check(second(swap) === undefined, `swap.mkv replaced by FFV1 yuva420p: no longer opaque (${second(swap)})`);
    check(second(h264) === true, `the unchanged H.264 file stays opaque (${second(h264)})`);
  }

  console.log(failures === 0 ? "\nCACHE SMOKE TEST PASSED" : `\nCACHE SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("CACHE SMOKE TEST FAILED:", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  process.exit(1);
});
