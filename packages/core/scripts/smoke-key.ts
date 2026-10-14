/**
 * Keying smoke test: colorkey / chromakey (+ despill) / lumakey, colour "auto"
 * detection and detect_key_color. Synthesizes all of its media (no downloads):
 *
 *   1. A GRAY-screen overlay (flat 0x808080, 1080×1920) with WHITE, BLACK and
 *      RED boxes on V2 over solid BLUE on V1. colorkey with color "auto" must
 *      resolve to 0x808080; after export the gray shows BLUE and every box keeps
 *      its colour. The same overlay keyed with chromakey 0x808080 ERASES the
 *      white box — the reason colorkey exists (neutrals share gray's chroma).
 *      A colour grade ahead of the key (eq → alpha-less YUV) must still key.
 *   2. The same overlay pillarboxed on a 1280×720 canvas: the transparent bars
 *      must STAY transparent (blue) after the key — FFmpeg's keyers rewrite
 *      alpha, so graph.ts multiplies the key into the existing alpha.
 *   3. A GREEN screen with a red box and a green-tinted "spill" box: chromakey
 *      "auto" + despill removes the green, keeps red, and pulls the spill down.
 *   4. A BLACK background with a white box: lumakey "auto" removes the black.
 *   5. Determinism: chromakey's export chain gives byte-identical frames with
 *      1, 3 and 7 filter threads (FFmpeg slices the frame per thread, and the
 *      bare filter's first pixel of each slice used to depend on that count).
 *
 * Run: npx tsx packages/core/scripts/smoke-key.ts
 */
import { execa } from "execa";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { EditorEngine } from "../src/engine.js";
import { dispatch } from "../src/rpc.js";
import { FFMPEG_BIN } from "../src/ffmpeg/executor.js";
import { effectFilterSteps } from "../src/effects/registry.js";

const FPS = 30;
type RGB = [number, number, number];

let failures = 0;
function check(cond: boolean, name: string, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function synth(args: string[]): Promise<void> {
  await execa(FFMPEG_BIN, ["-hide_banner", "-y", ...args], { reject: true });
}

/**
 * A solid-colour clip with optional drawbox shapes, as H.264 yuv420p. lavfi's color /
 * drawbox code RGB with BT.601: tagged so (complete), the file reads as drawn at any
 * size — untagged HD is read as BT.709, as players read it (ffmpeg/colorspace.ts).
 */
async function solid(out: string, color: string, w: number, h: number, seconds: number, boxes: string[] = []) {
  const vf = boxes.length ? ["-vf", boxes.join(",")] : [];
  await synth(["-f", "lavfi", "-i", `color=c=${color}:s=${w}x${h}:r=${FPS}:d=${seconds}`, ...vf, "-pix_fmt", "yuv420p",
    "-colorspace", "smpte170m", "-color_primaries", "smpte170m", "-color_trc", "smpte170m", "-color_range", "tv", out]);
}
const box = (x: number, y: number, w: number, h: number, c: string) => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:c=${c}:t=fill`;

/** Mean RGB of a 24×24 block centred on (x,y) of the frame at `t` seconds. */
async function sample(file: string, t: number, x: number, y: number): Promise<RGB> {
  const { stdout } = await execa(
    FFMPEG_BIN,
    ["-hide_banner", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1",
      "-vf", `crop=24:24:${x - 12}:${y - 12},scale=1:1:flags=area,format=rgb24`, "-f", "rawvideo", "-"],
    { reject: true, encoding: "buffer" },
  );
  const b = stdout as unknown as Buffer;
  return [b[0], b[1], b[2]];
}

const near = (px: RGB, want: RGB, tol = 40) => px.every((v, i) => Math.abs(v - want[i]) <= tol);
const fmt = (px: RGB) => `rgb(${px.join(",")})`;
async function expectPx(file: string, t: number, x: number, y: number, want: RGB, label: string, tol = 40) {
  const px = await sample(file, t, x, y);
  check(near(px, want, tol), `${label}: ${fmt(px)} ≈ ${fmt(want)}`);
  return px;
}

const BLUE: RGB = [0, 0, 255];
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];
const RED: RGB = [255, 0, 0];

/** A fresh engine with BLUE on V1 and `overlay` on V2, both 2 s. Returns the overlay clip id. */
async function layered(dir: string, name: string, W: number, H: number, blue: string, overlay: string) {
  const engine = new EditorEngine(join(dir, name));
  engine.setProjectSettings({ width: W, height: H, fps: FPS, name });
  const aBlue = await engine.importVideo(blue);
  const aOver = await engine.importVideo(overlay);
  engine.addClip(aBlue.id, { startFrame: 0 });
  const v2 = engine.addTrack("video", { name: "V2" });
  const over = engine.addClip(aOver.id, { trackIndex: v2.index, startFrame: 0 });
  return { engine, overId: over.id };
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "zabsreel-key-"));

  // ---- media ----------------------------------------------------------------
  // Gray screen 1080×1920: white / black / red boxes (≥ 200 px so x264 chroma
  // subsampling can't blur their centres), gray everywhere else.
  const gray = join(dir, "gray.mp4");
  await solid(gray, "0x808080", 1080, 1920, 2, [
    box(100, 300, 300, 300, "white"),
    box(680, 300, 300, 300, "black"),
    box(100, 1000, 300, 300, "red"),
    box(680, 1000, 300, 300, "black"), box(730, 1050, 200, 200, "white"), // outlined target
  ]);
  const bluePortrait = join(dir, "blue-portrait.mp4");
  await solid(bluePortrait, "blue", 1080, 1920, 2);
  const blueLandscape = join(dir, "blue-landscape.mp4");
  await solid(blueLandscape, "blue", 1280, 720, 4);
  // Saturated green screen with a red box and a green-tinted light box standing
  // in for spill on a subject's edge. (FFmpeg's chroma distance is small: on a
  // duller green, chromakey's default similarity already half-keys light
  // neutrals — a saturated screen keeps the spill box opaque so despill shows.)
  const green = join(dir, "green.mp4");
  await solid(green, "0x00FF00", 1280, 720, 2, [box(200, 200, 240, 240, "red"), box(800, 200, 240, 240, "0xB4DCB4")]);
  const black = join(dir, "black.mp4");
  await solid(black, "black", 1280, 720, 2, [box(500, 200, 280, 280, "white")]);

  // ---- 1. gray screen: colorkey "auto" ---------------------------------------
  console.log("1. gray-screen overlay, colorkey color=auto (1080×1920)...");
  const A = await layered(dir, "portrait", 1080, 1920, bluePortrait, gray);
  const det = (await dispatch(A.engine, "detect_key_color", { clipId: A.overId })) as { color: string; confidence: number };
  console.log(`   detect_key_color → ${det.color} (confidence ${det.confidence})`);
  check(det.color === "0x808080", "detect_key_color finds the flat gray", det.color);
  check(det.confidence >= 0.95, "confidence is high for a flat screen", String(det.confidence));
  const ck = (await dispatch(A.engine, "apply_effect", { clipId: A.overId, type: "colorkey", color: "auto" })) as {
    effectId: string; color?: string; confidence?: number;
  };
  check(ck.color === "0x808080", "apply_effect resolves color 'auto' to 0x808080", String(ck.color));
  const stored = A.engine.getProject().tracks.flatMap((t) => t.clips).find((c) => c.id === A.overId)?.effects?.filters?.[0];
  check(stored?.color === "0x808080", "the stored effect holds the concrete hex (not 'auto')", String(stored?.color));

  const outA = join(dir, "colorkey.mp4");
  await A.engine.exportVideo(outA);
  await expectPx(outA, 1, 540, 1650, BLUE, "gray background → blue V1 shows through");
  await expectPx(outA, 1, 540, 800, BLUE, "gray between the boxes → blue");
  await expectPx(outA, 1, 250, 450, WHITE, "white box kept");
  await expectPx(outA, 1, 830, 450, BLACK, "black box kept");
  await expectPx(outA, 1, 250, 1150, RED, "red box kept", 60);
  await expectPx(outA, 1, 705, 1150, BLACK, "black outline of the target kept");
  await expectPx(outA, 1, 830, 1150, WHITE, "white centre of the target kept");

  // Why colorkey exists: chromakey at the same gray erases every neutral.
  console.log("   ...and chromakey at 0x808080 for comparison:");
  await dispatch(A.engine, "apply_effect", { clipId: A.overId, type: "chromakey", color: "0x808080", effectId: ck.effectId });
  const outA2 = join(dir, "chromakey-gray.mp4");
  await A.engine.exportVideo(outA2);
  const wbox = await sample(outA2, 1, 250, 450);
  check(near(wbox, BLUE, 60), `chromakey 0x808080 ERASES the white box (shows blue): ${fmt(wbox)}`);
  const kbox = await sample(outA2, 1, 830, 450);
  check(near(kbox, BLUE, 60), `chromakey 0x808080 ERASES the black box too: ${fmt(kbox)}`);

  // Colour runs BEFORE effects on export: a grade (eq → YUV) ahead of the key
  // must still build and key. Saturation leaves neutral gray/white/black alone.
  await dispatch(A.engine, "apply_effect", { clipId: A.overId, type: "colorkey", color: "0x808080", effectId: ck.effectId });
  await dispatch(A.engine, "color_grade", { clipId: A.overId, saturation: 1.3 });
  const outA3 = join(dir, "graded-key.mp4");
  await A.engine.exportVideo(outA3);
  await expectPx(outA3, 1, 540, 1650, BLUE, "graded clip: gray still keys to blue");
  await expectPx(outA3, 1, 250, 450, WHITE, "graded clip: white box kept");
  await expectPx(outA3, 1, 250, 1150, RED, "graded clip: red box kept", 60);

  // ---- 2. pillarboxed overlay keeps transparent bars ----------------------------
  console.log("2. same overlay pillarboxed on a 1280×720 canvas, colorkey...");
  const B = await layered(dir, "landscape", 1280, 720, blueLandscape, gray);
  await dispatch(B.engine, "apply_effect", { clipId: B.overId, type: "colorkey", color: "0x808080" });
  const outB = join(dir, "pillarbox.mp4");
  await B.engine.exportVideo(outB);
  // 1080×1920 fits as 405×720 centred: bars are x < 437 and x > 842.
  await expectPx(outB, 1, 150, 360, BLUE, "left pillarbox bar stays transparent (blue)");
  await expectPx(outB, 1, 1130, 360, BLUE, "right pillarbox bar stays transparent (blue)");
  await expectPx(outB, 1, 640, 620, BLUE, "keyed gray inside the picture → blue");
  await expectPx(outB, 1, 437 + Math.round(250 * 0.375), Math.round(450 * 0.375), WHITE, "white box kept", 50);

  // ---- 3 + 4. green screen (chromakey auto + despill) and lumakey ------------
  console.log("3. green screen: chromakey auto (+despill); 4. black background: lumakey auto...");
  const C = new EditorEngine(join(dir, "landscape2"));
  C.setProjectSettings({ width: 1280, height: 720, fps: FPS, name: "keys" });
  const aBlue = await C.importVideo(blueLandscape);
  const aGreen = await C.importVideo(green);
  const aBlack = await C.importVideo(black);
  C.addClip(aBlue.id, { startFrame: 0 });
  const v2 = C.addTrack("video", { name: "V2" });
  const g = C.addClip(aGreen.id, { trackIndex: v2.index, startFrame: 0 }); // [0,2s)
  const l = C.addClip(aBlack.id, { trackIndex: v2.index, startFrame: 2 * FPS }); // [2s,4s)
  const gk = (await dispatch(C, "apply_effect", { clipId: g.id, type: "chromakey", color: "auto" })) as { effectId: string; color: string };
  console.log(`   chromakey auto → ${gk.color}`);
  const [gr, gg, gb] = [1, 3, 5].map((o) => parseInt(gk.color.slice(1 + o, 3 + o), 16));
  check(gr <= 3 && gg >= 0xfc && gb <= 3, "chromakey auto finds the screen green", gk.color);
  const lk = (await dispatch(C, "apply_effect", { clipId: l.id, type: "lumakey", color: "auto" })) as { clip: { effects?: { filters?: { params?: Record<string, number> }[] } } };
  const thr = lk.clip.effects?.filters?.[0]?.params?.threshold ?? -1;
  check(thr >= 0 && thr < 0.1, "lumakey auto sets a black threshold", String(thr));

  const outC = join(dir, "keys.mp4");
  await C.exportVideo(outC);
  await expectPx(outC, 1, 640, 600, BLUE, "green screen → blue");
  await expectPx(outC, 1, 320, 320, RED, "red subject kept", 60);
  const spill = await expectPx(outC, 1, 920, 320, [180, 220, 180], "spill box kept (no despill yet)", 30);
  await expectPx(outC, 3, 200, 600, BLUE, "black background → blue (lumakey)");
  await expectPx(outC, 3, 640, 340, WHITE, "white subject kept (lumakey)");

  await dispatch(C, "apply_effect", { clipId: g.id, type: "chromakey", color: gk.color, params: { despill: 1 }, effectId: gk.effectId });
  const outD = join(dir, "despill.mp4");
  await C.exportVideo(outD);
  const ds = await sample(outD, 1, 920, 320);
  console.log(`   spill box: ${fmt(spill)} → despill ${fmt(ds)}`);
  check(ds[1] < spill[1] - 25 && Math.abs(ds[0] - spill[0]) < 20, "despill pulls green spill down toward avg(R,B)");
  check(ds[1] <= Math.max(ds[0], ds[2]) + 15, "despilled box is no longer green-dominant", fmt(ds));
  await expectPx(outD, 1, 640, 600, BLUE, "green screen still keyed with despill on");
  await expectPx(outD, 1, 320, 320, RED, "red subject still kept with despill on", 60);

  // ---- 5. chromakey output does not depend on the CPU count ------------------
  console.log("5. chromakey export chain: identical output for 1, 3 and 7 filter threads...");
  const noisy = join(dir, "noisy-green.mkv");
  await synth(["-f", "lavfi", "-i", "color=0x30C040:s=320x240:r=30:d=0.2,format=yuv444p,noise=alls=60:allf=u+t", "-c:v", "ffv1", noisy]);
  const keyChain = effectFilterSteps([{ type: "chromakey", color: "0x00FF00", params: { despill: 0.5 } }], 320, 240, "d").join(",");
  const hashes: string[] = [];
  for (const threads of [1, 3, 7]) {
    const { stdout } = await execa(FFMPEG_BIN, ["-hide_banner", "-loglevel", "error", "-filter_complex_threads", String(threads), "-i", noisy,
      "-filter_complex", `[0:v]${keyChain}[o]`, "-map", "[o]", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { reject: true, encoding: "buffer" });
    hashes.push(createHash("md5").update(stdout as unknown as Buffer).digest("hex"));
  }
  check(hashes.every((h) => h === hashes[0]), "the keyed frames are byte-identical whatever the thread count", hashes.join(" / "));

  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nKEY SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("KEY SMOKE TEST FAILED:", err);
  process.exit(1);
});
