/**
 * Frame picking at exact frame boundaries, for the two places that pull one
 * frame by time:
 *  - get_frame (engine.renderFrame) at t = n / fps shows timeline frame n —
 *    it used to show n + 1 for every n whose time rounds up at 3 decimals
 *    (a third of the frames at 30 fps), and n - 1 just below a boundary.
 *  - GET /frames (the live preview's trail / denoise warm-up) returns exactly
 *    source frames [from, from + count), cropped and scaled, as raw RGBA;
 *    it needs the token, decodes only files /file would serve and validates
 *    its numbers (and their product: at most 512 MB a request); at most
 *    4 decodes run at once (429 beyond), and an aborted request kills its ffmpeg.
 *
 * Run: npx tsx packages/core/scripts/smoke-frames.ts
 * (Self-contained — synthesizes a frame-counter clip with ffmpeg lavfi:
 * frame n has luma 16 + 6n.)
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { execa } from "execa";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EditorEngine } from "../src/engine.js";
import { EditorServer } from "../src/server.js";
import { chromiumMatrix } from "../src/ffmpeg/frames.js";
import { runFfmpeg, runFfmpegStdoutBuffer } from "../src/ffmpeg/executor.js";

/** The frame number a grey level shows (RGB from 16 + 6n limited-range luma). */
const frameOf = (v: number) => Math.round(v / ((6 * 255) / 219));

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "aive-frames-"));
  const engine = new EditorEngine(dataDir);
  engine.setProjectSettings({ width: 320, height: 180, fps: 30 });
  const server = new EditorServer(engine, { port: 0, dataDir });
  const port = await server.start();
  const base = `http://127.0.0.1:${port}`;
  const token = (JSON.parse(readFileSync(join(dataDir, "server.json"), "utf8")) as { token: string }).token;

  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  };

  console.log("1. synthesize a 36-frame counter clip (frame n: luma 16 + 6n; left half white)...");
  const clip = join(dataDir, "counter.mp4");
  await runFfmpeg([
    "-f", "lavfi", "-i", "color=black:s=320x180:r=30:d=1.2",
    "-vf", "geq=lum='if(lt(X,160),235,16+N*6)':cb=128:cr=128",
    "-c:v", "libx264", "-preset", "veryfast", "-g", "30", "-pix_fmt", "yuv420p", "-y", clip,
  ]);
  const asset = await engine.importVideo(clip);
  engine.appendClip(asset.id);

  console.log("2. get_frame at frame boundaries shows that frame...");
  const shown = async (t: number) => {
    const png = await engine.renderFrame(t);
    const px = await runFfmpegStdoutBuffer(["-v", "error", "-i", png, "-vf", "crop=8:8:240:86,format=gray", "-frames:v", "1", "-f", "rawvideo", "-"]);
    return frameOf(px[0]);
  };
  const bad: string[] = [];
  for (const n of [0, 1, 2, 5, 10, 19, 20, 21, 29, 32, 34]) {
    const at = await shown(n / 30);
    if (at !== n) bad.push(`t=${n}/30 → ${at}`);
  }
  check(bad.length === 0, `get_frame(n/30) shows frame n for 11 boundaries${bad.length ? ` (${bad.join(", ")})` : ""}`);
  const mid = await shown(20.6 / 30);
  check(mid === 20, `get_frame inside frame 20 (t = 20.6/30) shows 20 (got ${mid})`);
  const below = await shown(20 / 30 - 0.0005);
  check(below === 19, `get_frame just before frame 20 shows 19 (got ${below})`);

  console.log("3. GET /frames returns exactly the frames asked for...");
  const url = (q: Record<string, string | number>, withToken = true) => {
    const u = new URL(`${base}/frames`);
    u.searchParams.set("path", clip);
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, String(v));
    if (withToken) u.searchParams.set("token", token);
    return u.toString();
  };
  const W = 40;
  const H = 30;
  const r = await fetch(url({ from: 20, count: 6, fps: 30, w: W, h: H, crop: "160,0,160,180" }));
  const body = new Uint8Array(await r.arrayBuffer());
  check(r.status === 200 && r.headers.get("content-type") === "application/octet-stream", `200 octet-stream (got ${r.status})`);
  check(r.headers.get("access-control-allow-origin") === "*", "CORS-readable by the renderer");
  check(body.length === 6 * W * H * 4, `6 frames of ${W}x${H} RGBA (got ${body.length} bytes)`);
  const frames: number[] = [];
  for (let i = 0; i < 6; i++) {
    const o = i * W * H * 4 + ((H >> 1) * W + (W >> 1)) * 4;
    frames.push(frameOf(body[o + 1]));
  }
  check(frames.join(",") === "20,21,22,23,24,25", `frames 20..25 in order (got ${frames.join(",")})`);
  const leftCol = body[((H >> 1) * W + 0) * 4];
  check(leftCol < 200, `the crop left the white half out (left edge ${leftCol})`);
  check(body[3] === 255, "opaque alpha");

  const first = new Uint8Array(await (await fetch(url({ from: 0, count: 2, fps: 30, w: W, h: H, crop: "160,0,160,180" }))).arrayBuffer());
  check(frameOf(first[((H >> 1) * W + (W >> 1)) * 4 + 1]) === 0, "from = 0 starts at frame 0");
  const tail = await fetch(url({ from: 30, count: 10, fps: 30, w: W, h: H }));
  const tailBytes = (await tail.arrayBuffer()).byteLength;
  check(tail.status === 200 && tailBytes === 6 * W * H * 4, `past the end: only the 6 frames there are (got ${tailBytes / (W * H * 4)})`);

  console.log("4. /frames access and validation...");
  check((await fetch(url({ from: 0, count: 1, fps: 30, w: W, h: H }, false))).status === 401, "no token → 401");
  const other = new URL(url({ from: 0, count: 1, fps: 30, w: W, h: H }));
  other.searchParams.set("path", "/etc/hostname");
  check((await fetch(other)).status === 403, "a file /file would not serve → 403");
  check((await fetch(url({ from: 0, count: 500, fps: 30, w: W, h: H }))).status === 400, "count above the cap → 400");
  check((await fetch(url({ from: 0, count: 120, fps: 30, w: 4096, h: 4096 }))).status === 400, "more than 512 MB of frames in one request → 400");
  check((await fetch(url({ from: -1, count: 1, fps: 30, w: W, h: H }))).status === 400, "negative from → 400");
  check((await fetch(url({ from: 0, count: 1, fps: 0, w: W, h: H }))).status === 400, "fps 0 → 400");
  check((await fetch(url({ from: 0, count: 1, fps: 30, w: W, h: H, crop: "1,2,x,4" }))).status === 400, "a malformed crop → 400");

  // Decodes at once are capped (RUNNING_MAX = 4), and a client that goes away
  // (the warm-up aborts on every scrub) takes its ffmpeg with it. A body nobody
  // reads holds its decode (pipe backpressure), so four unread requests fill
  // every slot.
  // The ffmpeg processes decoding the clip (pgrep: not on Windows, where those two checks are skipped).
  const counted = process.platform !== "win32";
  const decoders = async () => {
    if (!counted) return 0;
    const r = await execa("pgrep", ["-f", clip], { reject: false });
    return r.stdout.split("\n").filter(Boolean).length;
  };
  const big = () => url({ from: 0, count: 30, fps: 30, w: 2048, h: 2048 });
  const ctrls = Array.from({ length: 4 }, () => new AbortController());
  const held = await Promise.all(ctrls.map((c) => fetch(big(), { signal: c.signal })));
  check(held.every((x) => x.status === 200), `4 decodes at once run (got ${held.map((x) => x.status).join(",")})`);
  if (counted) check((await decoders()) === 4, `… one ffmpeg each (got ${await decoders()})`);
  const fifth = await fetch(big());
  const fifthBody = (await fifth.json().catch(() => null)) as { ok?: boolean } | null;
  check(fifth.status === 429 && fifthBody?.ok === false, `a 5th at once → 429 ok:false (got ${fifth.status})`);
  for (const c of ctrls) c.abort();
  let left = -1;
  for (let i = 0; i < 15 && left !== 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
    left = await decoders();
  }
  if (counted) check(left === 0, `aborted requests leave no ffmpeg running within 1.5 s (got ${left})`);
  const again = await fetch(url({ from: 0, count: 1, fps: 30, w: W, h: H }));
  await again.arrayBuffer();
  check(again.status === 200, `the slots free again once the aborted decodes end (got ${again.status})`);

  console.log("5. the YUV matrix is chosen as Chromium does...");
  check(chromiumMatrix({ height: 360 }).matrix === "bt601", "untagged SD → BT.601");
  check(chromiumMatrix({ height: 720 }).matrix === "bt709", "untagged HD → BT.709");
  check(chromiumMatrix({ height: 360, space: "bt709" }).matrix === "bt709", "tagged BT.709 SD → BT.709");
  check(chromiumMatrix({ height: 1080, space: "smpte170m" }).matrix === "bt601", "tagged BT.601 HD → BT.601");
  check(chromiumMatrix({ height: 1080, codec: "vp9" }).matrix === "bt601", "untagged VP9 → BT.601");
  check(chromiumMatrix({ height: 1080, range: "pc" }).range === "pc", "full range kept");

  await server.stop();
  console.log(failures === 0 ? "\nFRAMES SMOKE TEST PASSED" : `\nFRAMES SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FRAMES SMOKE TEST FAILED:", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  process.exit(1);
});
