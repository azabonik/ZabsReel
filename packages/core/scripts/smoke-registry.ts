/**
 * Effect-registry smoke test (effects/registry.ts). Synthesizes all of its media
 * (no downloads, no arguments):
 *
 *   1. Registry integrity: one entry per EFFECT_TYPE_IDS, sane param schemas,
 *      every type in the generated AI description.
 *   2. Legacy stored effects ({type:"blur",amount:8}, keys with params, …) emit
 *      BYTE-IDENTICAL filter strings to b6219ab (literals captured from that
 *      commit's graph.ts). Vignette is the intended exception: it now maps
 *      amount → lens angle and keeps alpha. Chromakey is the other one: its
 *      key copy gets a 1-px smeared border (cropped off again), so the output
 *      no longer depends on FFmpeg's thread count.
 *   3. Bypassed effects (enabled:false) are skipped without renaming the other
 *      effects' sub-graph labels.
 *   4. rpc: apply_effect validation (clamp + clear errors), the bypass toggle,
 *      and reorder_effect (one undo step).
 *   5. FFmpeg accepts every registry entry with its defaults (1 frame each, on a
 *      letterboxed RGBA source), and a whole stack + adjustment layer exports.
 *   6. Vignette amounts give different corner luma in the export, matching the
 *      registry's vignetteFactor (the preview's curve); a bypassed vignette
 *      leaves the corner alone.
 *   7. Pre-v4 projects (.aive and SynthCut OTIO) lose their vignette amounts
 *      on load — the old export ignored them — so they render the old PI/5;
 *      other effects' amounts and current projects are untouched.
 *
 *   8. Alpha safety: every effect (defaults AND every param at its min / max) keeps
 *      the transparent letterbox padding at alpha 0 and the picture opaque, and
 *      the bare unsharp / hqdn3d / edgedetect are shown to drop alpha (why alphaSafe).
 *   9. Look + style effects measured on an engine EXPORT: exposure doubles luma
 *      (clamped), vibrance lifts a dull colour more than a saturated one, invert
 *      flips a known pixel, colorhold keeps red and greys the rest, grain adds
 *      temporal variance, glow brightens around a bright shape, RGB split
 *      separates channels at an edge, lens distortion bends a grid line, trails
 *      leave a ghost of a moving box.
 *  10. stabilize_clip canceled mid-run (analysis and encode) leaves no .trf /
 *      partial .mp4 in baked/ and the clip keeps its source.
 *
 * Run: npx tsx packages/core/scripts/smoke-registry.ts
 */
import { execa } from "execa";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { EditorEngine } from "../src/engine.js";
import { dispatch } from "../src/rpc.js";
import { FFMPEG_BIN } from "../src/ffmpeg/executor.js";
import { PROJECT_SCHEMA_VERSION } from "../src/types.js";
import {
  EFFECTS, EFFECT_CATEGORIES, EFFECT_TYPE_IDS, defaultsFor, describeEffectsForAI,
  alphaSafe, effectFilterSteps, exposureBlack, validateEffect, exactOnly, isKeyType, vignetteAngle, vignetteFactor, type EffectInput,
  effectGL, previewFidelity,
} from "../src/effects/registry.js";

let failures = 0;
function check(cond: boolean, name: string, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function rejects(p: Promise<unknown>, pattern: RegExp, name: string) {
  try {
    await p;
    check(false, name, "did not throw");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(pattern.test(msg), name, msg);
    return msg;
  }
}

type Clip = { id: string; effects?: { filters?: (EffectInput & { id: string })[] } };

async function ffmpeg(args: string[]) {
  return execa(FFMPEG_BIN, ["-hide_banner", "-y", ...args], { reject: true, encoding: "buffer" });
}

/** Mean RGB of a `size`×`size` block at (x,y) (top-left) of the frame at `t`. */
async function sampleBlock(file: string, t: number, x: number, y: number, size = 8): Promise<[number, number, number]> {
  const { stdout } = await ffmpeg([
    "-ss", t.toFixed(3), "-i", file, "-frames:v", "1",
    "-vf", `crop=${size}:${size}:${x}:${y},scale=1:1:flags=area,format=rgb24`, "-f", "rawvideo", "-",
  ]);
  const b = stdout as unknown as Buffer;
  return [b[0], b[1], b[2]];
}

/** The padded RGBA test chain: a 240×180 source letterboxed into 320×180 (40px transparent bars), then the effect. */
function paddedGraph(steps: string[]): string {
  return `[0:v]format=rgba,scale=240:180,pad=320:180:40:0:color=0x00000000,setsar=1${steps.length ? `,${steps.join(",")}` : ""},format=rgba[out]`;
}
async function runPadded(src: string, steps: string[]): Promise<Buffer> {
  const { stdout } = await ffmpeg(["-i", src, "-filter_complex", paddedGraph(steps), "-map", "[out]", "-frames:v", "4", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
  return stdout as unknown as Buffer;
}
async function renderPadded(src: string, fx: EffectInput): Promise<{ buf: Buffer; steps: number }> {
  const steps = effectFilterSteps([fx], 320, 180, "t0");
  return { buf: await runPadded(src, steps), steps: steps.length };
}
async function renderPaddedRaw(src: string, step: string): Promise<{ buf: Buffer }> {
  return { buf: await runPadded(src, [step]) };
}
/** Alpha of pixel (x,y) in frame `frame` (320×180 RGBA frames back to back). */
function alphaAt(buf: Buffer, frame: number, x: number, y: number): number {
  return buf[frame * 320 * 180 * 4 + (y * 320 + x) * 4 + 3];
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "synthcut-registry-"));

  // ---- 1. integrity -----------------------------------------------------------
  console.log("1. registry integrity...");
  check(EFFECTS.length === EFFECT_TYPE_IDS.length && EFFECTS.every((e, i) => e.type === EFFECT_TYPE_IDS[i]),
    "one entry per EFFECT_TYPE_IDS, in order");
  check(EFFECTS.every((e) => (EFFECT_CATEGORIES as readonly string[]).includes(e.category)), "every category is listed");
  const badParams = EFFECTS.flatMap((e) => e.params.filter((p) => !(p.min < p.max && p.step > 0 && p.default >= p.min && p.default <= p.max)).map((p) => `${e.type}.${p.key}`));
  check(badParams.length === 0, "every param has min < max, step > 0 and an in-range default", badParams.join(", "));
  const dupKeys = EFFECTS.filter((e) => new Set(e.params.map((p) => p.key)).size !== e.params.length).map((e) => e.type);
  check(dupKeys.length === 0, "param keys are unique per effect", dupKeys.join(", "));
  const desc = describeEffectsForAI();
  check(EFFECT_TYPE_IDS.every((t) => desc.includes(`- ${t}:`)), "describeEffectsForAI lists every type");
  check(["chromakey", "colorkey", "lumakey"].every(isKeyType) && !isKeyType("blur"), "key flag marks exactly the keys");
  check(EFFECT_TYPE_IDS.every((t) => !exactOnly(t)), "exactOnly: every effect previews live now (WebGL2; CSS / canvas fallback for some)");
  check(EFFECT_TYPE_IDS.every((t) => !!effectGL(t) && effectGL(t)!.passes.length > 0 && !!effectGL(t)!.note),
    "every effect has a WebGL2 preview (passes + a fidelity note)");
  check(previewFidelity("denoise") === "close" && previewFidelity("blur") === "exact" && previewFidelity("chromakey") === "exact" &&
    EFFECTS.every((e) => previewFidelity(e.type) !== "approx"),
    "previewFidelity follows the GL entry (blur, chromakey exact; denoise close; nothing approximate any more)");
  check(previewFidelity("sharpen", false) === "none" && previewFidelity("chromakey", false) === "none" &&
    previewFidelity("blur", false) === "close" && previewFidelity("invert", false) === "exact" && previewFidelity("vignette", false) === "close",
    "without WebGL2: GL-only effects and keys have no preview; CSS / canvas proxies remain");
  check(["exposure", "vibrance", "invert"].every((t) => { const p = EFFECTS.find((e) => e.type === t)?.preview; return !!p && p !== "export-only" && !!p.note; }),
    "every CSS proxy documents how close it is (preview.note)");
  check(alphaSafe([], "x").length === 0 && alphaSafe(["negate"], "x")[0].includes("alphamerge"), "alphaSafe: empty in → empty out; wraps a chain with alphamerge");
  check(JSON.stringify(defaultsFor("chromakey")) === JSON.stringify({ params: { similarity: 0.18, blend: 0.1, despill: 0 }, color: "0x00FF00" }),
    "defaultsFor(chromakey)", JSON.stringify(defaultsFor("chromakey")));

  // ---- 2. legacy filter strings (byte-identical to b6219ab) ---------------------
  console.log("2. legacy stored effects emit the b6219ab filter strings (sharpen/denoise/edges now alpha-wrapped)...");
  const LEGACY: [EffectInput, string[]][] = [
    [{ type: "blur", amount: 8 }, ["gblur=sigma=8.000000"]],
    [{ type: "blur" }, ["gblur=sigma=8.000000"]],
    [{ type: "blur", amount: 150 }, ["gblur=sigma=100.000000"]],
    [{ type: "sharpen", amount: 1.2 }, ["format=rgba,split[sharpc1_0a][sharpc1_0b];[sharpc1_0a]unsharp=5:5:1.200000:5:5:0[sharpc1_0v];[sharpc1_0b]alphaextract[sharpc1_0m];[sharpc1_0v][sharpc1_0m]alphamerge,format=rgba"]],
    [{ type: "detail" }, ["cas=strength=0.500000"]],
    [{ type: "denoise", amount: 4 }, ["format=rgba,split[dnc1_0a][dnc1_0b];[dnc1_0a]hqdn3d=4.000000[dnc1_0v];[dnc1_0b]alphaextract[dnc1_0m];[dnc1_0v][dnc1_0m]alphamerge,format=rgba"]],
    [{ type: "sepia" }, ["colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131"]],
    [{ type: "grayscale", amount: 3 }, ["hue=s=0"]],
    [{ type: "edges" }, ["format=rgba,split[edgec1_0a][edgec1_0b];[edgec1_0a]edgedetect=mode=colormix[edgec1_0v];[edgec1_0b]alphaextract[edgec1_0m];[edgec1_0v][edgec1_0m]alphamerge,format=rgba"]],
    [{ type: "posterize", amount: 6 }, ["lutrgb=r='round(val/255*5)/5*255':g='round(val/255*5)/5*255':b='round(val/255*5)/5*255'"]],
    [{ type: "pixelate", amount: 16 }, ["scale=max(2\\,iw/16.000000):max(2\\,ih/16.000000):flags=neighbor", "scale=640:360:flags=neighbor"]],
    [{ type: "colorkey", color: "0x808080" },
      ["format=rgba,split[keyc1_0a][keyc1_0b];[keyc1_0a]colorkey=0x808080:0.080000:0.040000,format=rgba[keyc1_0k];[keyc1_0b][keyc1_0k]blend=c3_mode=multiply,format=rgba"]],
    [{ type: "chromakey", color: "#00ff00", params: { despill: 0.5 } },
      ["format=rgba,split[keyc1_0a][keyc1_0b];[keyc1_0a]format=yuva444p,pad=iw+2:ih+2:1:1,fillborders=1:1:1:1:smear,chromakey=0x00FF00:0.180000:0.100000,crop=iw-2:ih-2:1:1,despill=type=green:mix=0.5:expand=0:red=0:green=-0.500000:blue=0:brightness=0,format=rgba[keyc1_0k];[keyc1_0k][keyc1_0b]blend=c3_mode=multiply,format=rgba"]],
    [{ type: "chromakey", color: "auto", params: { similarity: 3 } },
      ["format=rgba,split[keyc1_0a][keyc1_0b];[keyc1_0a]format=yuva444p,pad=iw+2:ih+2:1:1,fillborders=1:1:1:1:smear,chromakey=0x00FF00:1.000000:0.100000,crop=iw-2:ih-2:1:1,format=rgba[keyc1_0k];[keyc1_0b][keyc1_0k]blend=c3_mode=multiply,format=rgba"]],
    [{ type: "lumakey", params: { threshold: 1 } },
      ["format=rgba,split[keyc1_0a][keyc1_0b];[keyc1_0a]lutrgb=a=maxval,lumakey=threshold=1.000000:tolerance=0.100000:softness=0.050000,format=rgba[keyc1_0k];[keyc1_0b][keyc1_0k]blend=c3_mode=multiply,format=rgba"]],
    [{ type: "nonexistent", amount: 3 }, []],
  ];
  for (const [fx, want] of LEGACY) {
    const got = effectFilterSteps([fx], 640, 360, "c1");
    check(JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(fx)}`, `got ${JSON.stringify(got)}`);
  }
  // Vignette: the intended change — amount → angle (1 = FFmpeg's PI/5), alpha kept.
  const vig = (fx: EffectInput) => effectFilterSteps([fx], 640, 360, "c1").join(",");
  check(vig({ type: "vignette" }).includes("vignette=angle=0.628319") && vig({ type: "vignette" }).includes("alphamerge"),
    "vignette default = angle PI/5 (as the old bare filter), alpha merged back", vig({ type: "vignette" }));
  check(vig({ type: "vignette", amount: 0 }) === "", "vignette amount 0 = no filter");
  check(vig({ type: "vignette", amount: 0.5 }).includes("angle=0.314159"), "vignette amount 0.5 → PI/10");
  check(vig({ type: "vignette", amount: 9 }).includes("angle=1.570796"), "vignette amount clamps to the filter's PI/2");

  // ---- 3. bypass ----------------------------------------------------------------
  console.log("3. bypassed effects are skipped (labels stay put)...");
  const stack: EffectInput[] = [
    { type: "colorkey", color: "0x808080", enabled: false },
    { type: "blur", amount: 4, enabled: false },
    { type: "chromakey", color: "0x00FF00" },
    { type: "sepia", enabled: true },
  ];
  const steps = effectFilterSteps(stack, 640, 360, "c2");
  check(steps.length === 2 && steps[0].includes("[keyc2_2a]") && steps[1].startsWith("colorchannelmixer"),
    "only the enabled chromakey (label _2) + sepia remain", JSON.stringify(steps));
  check(!steps.join().includes("gblur") && !steps.join().includes("colorkey="), "no bypassed filter in the graph");

  // ---- media --------------------------------------------------------------------
  const white = join(dir, "white.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=white:s=320x180:r=30:d=2", "-pix_fmt", "yuv420p", white]);
  const bars = join(dir, "bars.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=240x180:r=30:d=2", "-pix_fmt", "yuv420p", bars]);

  // ---- 4. rpc: validation, bypass toggle, reorder --------------------------------
  console.log("4. apply_effect validation, bypass toggle, reorder_effect...");
  const E = new EditorEngine(join(dir, "rpc"));
  E.setProjectSettings({ width: 320, height: 180, fps: 30, name: "rpc" });
  const a = await E.importVideo(bars);
  const c = E.addClip(a.id, { startFrame: 0 });
  const filtersOf = () => (E.getProject().tracks.flatMap((t) => t.clips).find((x) => x.id === c.id) as Clip).effects?.filters ?? [];

  const big = (await dispatch(E, "apply_effect", { clipId: c.id, type: "blur", amount: 500 })) as { effectId: string; adjusted?: string[] };
  check(filtersOf()[0]?.amount === 100, "blur amount 500 is clamped to 100", String(filtersOf()[0]?.amount));
  check(!!big.adjusted?.[0]?.includes("500 → 100"), "the clamp is reported in `adjusted`", JSON.stringify(big.adjusted));
  const unknownMsg = await rejects(dispatch(E, "apply_effect", { clipId: c.id, type: "chromakey", params: { similarty: 0.2 } }),
    /Unknown param "similarty" for chromakey/, "unknown param is rejected");
  check(!!unknownMsg && /similarity 0\.01\.\.1 \(default 0\.18\)/.test(unknownMsg) && unknownMsg.includes("despill"),
    "…and the error lists the valid params with ranges", unknownMsg);
  await rejects(dispatch(E, "apply_effect", { clipId: c.id, type: "grayscale", amount: 1 }), /grayscale takes no amount/, "amount on grayscale is rejected");
  await rejects(dispatch(E, "apply_effect", { clipId: c.id, type: "blur", color: "0x00FF00" }), /blur takes no color/, "color on blur is rejected");
  await rejects(dispatch(E, "apply_effect", { clipId: c.id, type: "blur", params: { amount: 3 } }), /top-level "amount"/, "params.amount points at amount");
  await rejects(dispatch(E, "apply_effect", { clipId: c.id, type: "colorkey", color: "rgb(0,255,0)" }), /Invalid color "rgb\(0,255,0\)"/, "a CSS colour is rejected");
  await rejects(dispatch(E, "apply_effect", { clipId: c.id, type: "lumakey", color: "0x000000" }), /lumakey takes no key colour/, "lumakey rejects a hex colour");
  await rejects(dispatch(E, "apply_effect", { clipId: c.id, type: "bogus" }), /Invalid params/, "an unknown type is rejected by the schema");
  check(filtersOf().length === 1, "rejected calls changed nothing");

  const ck = (await dispatch(E, "apply_effect", { clipId: c.id, type: "colorkey", color: "#80ff80", params: { similarity: 0.3 } })) as { effectId: string };
  check(filtersOf()[1]?.color === "0x80FF80", "key colour is stored normalised (0xRRGGBB)", filtersOf()[1]?.color);
  await dispatch(E, "apply_effect", { clipId: c.id, type: "colorkey", effectId: ck.effectId, enabled: false });
  const off = filtersOf()[1];
  check(off?.enabled === false && off.color === "0x80FF80" && off.params?.similarity === 0.3,
    "{effectId, type, enabled:false} bypasses and keeps colour + params", JSON.stringify(off));
  await dispatch(E, "apply_effect", { clipId: c.id, type: "colorkey", effectId: ck.effectId, enabled: true });
  check(filtersOf()[1] !== undefined && !("enabled" in filtersOf()[1]), "enabled:true removes the field (absent = on)");
  await dispatch(E, "apply_effect", { clipId: c.id, type: "colorkey", effectId: ck.effectId, enabled: false });
  await dispatch(E, "apply_effect", { clipId: c.id, type: "colorkey", effectId: ck.effectId, color: "0x808080", params: { similarity: 0.1 } });
  check(filtersOf()[1]?.enabled === false && filtersOf()[1]?.params?.similarity === 0.1, "a value update keeps the bypass");

  // 4b: an effectId the clip doesn't have is an error, not a silent new effect.
  const before = filtersOf().length;
  const stale = await rejects(dispatch(E, "apply_effect", { clipId: c.id, type: "blur", effectId: "fx_stale", enabled: false }),
    /Effect "fx_stale" not found on clip/, "apply_effect with a stale effectId is rejected (was: silently added a new effect)");
  check(!!stale && stale.includes(ck.effectId) && stale.includes("Omit effectId"), "…and the error lists the clip's effects and says how to add", stale);
  await rejects(dispatch(E, "apply_effect", { clipId: c.id, type: "colorkey", color: "auto", effectId: "fx_stale" }),
    /not found on clip/, "…also for color 'auto' (rejected before sampling the frame)");
  check(filtersOf().length === before, "the rejected stale-id calls added nothing");
  const noId = (await dispatch(E, "apply_effect", { clipId: c.id, type: "invert" })) as { effectId: string };
  check(filtersOf().length === before + 1 && filtersOf().at(-1)?.id === noId.effectId, "no effectId = add (unchanged)");
  await dispatch(E, "remove_effect", { clipId: c.id, effectId: noId.effectId });
  const made = E.applyEffect(c.id, { id: "fx_mine", type: "invert" }, { createWithId: true });
  check(made.effectId === "fx_mine" && filtersOf().some((f) => f.id === "fx_mine"), "engine.applyEffect(…, {createWithId:true}) still adds with a caller-chosen id (explicit opt-in)");
  let threw = false;
  try { E.applyEffect(c.id, { id: "fx_other", type: "invert" }); } catch { threw = true; }
  check(threw, "…while the same call without the opt-in is an error");
  await dispatch(E, "remove_effect", { clipId: c.id, effectId: "fx_mine" });

  // The new effects through the rpc: clamping, colour rules.
  const lensFx = (await dispatch(E, "apply_effect", { clipId: c.id, type: "lens", amount: 5, params: { k2: -9 } })) as { adjusted?: string[] };
  check((lensFx.adjusted ?? []).length === 2, "lens amount 5 / k2 -9 are clamped and reported", JSON.stringify(lensFx.adjusted));
  const expFx = (await dispatch(E, "apply_effect", { clipId: c.id, type: "exposure", amount: 1, params: { black: 0.1 } })) as { adjusted?: string[] };
  check(!expFx.adjusted, "exposure in-range values are not adjusted");
  await rejects(dispatch(E, "apply_effect", { clipId: c.id, type: "colorhold", color: "auto" }), /colorhold does not support color "auto"/, "colorhold rejects color 'auto'");
  await rejects(dispatch(E, "apply_effect", { clipId: c.id, type: "colorhold", color: "nope" }), /Invalid color "nope"/, "colorhold rejects an unparseable colour");
  const holdFx = (await dispatch(E, "apply_effect", { clipId: c.id, type: "colorhold", color: "#e02020", params: { similarity: 0.4 } })) as { effectId: string };
  check(filtersOf().find((f) => f.id === holdFx.effectId)?.color === "0xE02020", "colorhold stores the normalised colour");
  await rejects(dispatch(E, "apply_effect", { clipId: c.id, type: "grain", color: "0xFF0000" }), /grain takes no color \(only colorkey, chromakey, lumakey|grain takes no color/, "color on grain is rejected");
  for (const id of [holdFx.effectId]) await dispatch(E, "remove_effect", { clipId: c.id, effectId: id });
  for (const f of filtersOf().filter((x) => x.type === "lens" || x.type === "exposure")) await dispatch(E, "remove_effect", { clipId: c.id, effectId: f.id });

  const third = (await dispatch(E, "apply_effect", { clipId: c.id, type: "sepia" })) as { effectId: string };
  const order = () => filtersOf().map((f) => f.type).join(",");
  check(order() === "blur,colorkey,sepia", "stack order blur,colorkey,sepia", order());
  await dispatch(E, "reorder_effect", { clipId: c.id, effectId: third.effectId, toIndex: 0 });
  check(order() === "sepia,blur,colorkey", "reorder_effect moves sepia to the top", order());
  E.undo();
  check(order() === "blur,colorkey,sepia", "one undo restores the previous order");
  await dispatch(E, "reorder_effect", { clipId: c.id, effectId: big.effectId, toIndex: 99 });
  check(order() === "colorkey,sepia,blur", "toIndex past the end clamps to the last slot", order());
  const reordered = effectFilterSteps(filtersOf(), 320, 180, "c0");
  check(reordered.length === 2 && reordered[0].startsWith("colorchannelmixer") && reordered[1].startsWith("gblur"),
    "reordered stack emits filters in the new order (bypassed key skipped)", JSON.stringify(reordered));
  await rejects(dispatch(E, "reorder_effect", { clipId: c.id, effectId: "fx_nope", toIndex: 0 }), /not found/, "reorder of an unknown effect is rejected");

  // ---- 5. FFmpeg accepts every entry -----------------------------------------------
  console.log("5. FFmpeg accepts every registry entry (defaults, letterboxed RGBA, 1 frame)...");
  for (const def of EFFECTS) {
    const fx: EffectInput = { type: def.type, ...defaultsFor(def.type) };
    try {
      const { buf, steps } = await renderPadded(bars, fx);
      check(buf.length === 4 * 320 * 180 * 4, `${def.type}: renders frames (${steps} step${steps === 1 ? "" : "s"})`, `${buf.length} bytes`);
    } catch (e) {
      check(false, `${def.type}: FFmpeg rejected the filter`, `${e instanceof Error ? e.message.slice(-400) : e}`);
    }
  }

  // ---- 8. alpha safety ----------------------------------------------------------
  console.log("8. alpha safety: transparent padding stays alpha 0 for every effect...");
  // Proof that the wrapper is needed: the bare filters make the padding opaque.
  for (const bare of ["unsharp=5:5:1:5:5:0", "hqdn3d=4", "edgedetect=mode=colormix", "lagfun=decay=0.9"]) {
    const { buf } = await renderPaddedRaw(bars, bare);
    console.log(`   (bare ${bare.split("=")[0]}: padding alpha ${alphaAt(buf, 3, 2, 90)} — why alphaSafe exists)`);
  }
  const alphaOf = async (fx: EffectInput, label: string) => {
    try {
      const { buf } = await renderPadded(bars, fx);
      // The bar is x 0..39: sample the far edge AND right beside the picture (a blurred alpha leaks there).
      // (blur / pixelate legitimately feather or block across the picture edge, and lens's zoom to fill
      // scales the canvas-space frame, bars included, so the picture covers part of them: far edge only.)
      const xs = !["blur", "pixelate", "lens"].includes(fx.type) ? [2, 20, 34, 38, 281, 285, 300] : [2];
      const pad = Math.max(...xs.map((x) => alphaAt(buf, 3, x, 90)));
      const mid = alphaAt(buf, 3, 200, 90);
      const isKey = isKeyType(fx.type);
      check(pad === 0 && (isKey || mid >= 250), `${label}: padding alpha ${pad} (want 0)${isKey ? "" : `, picture alpha ${mid} (want 255)`}`);
    } catch (e) {
      check(false, `${label}: FFmpeg rejected the filter`, `${e instanceof Error ? e.message.slice(-300) : e}`);
    }
  };
  for (const def of EFFECTS) {
    await alphaOf({ type: def.type, ...defaultsFor(def.type) }, `${def.type} (defaults)`);
    // Every param at its min, then at its max, plus a colour for colorhold.
    for (const edge of ["min", "max"] as const) {
      const fx: EffectInput = { type: def.type, ...defaultsFor(def.type) };
      for (const p of def.params) {
        const v = edge === "min" ? p.min : p.max;
        if (p.key === "amount") fx.amount = v;
        else fx.params = { ...fx.params, [p.key]: v };
      }
      // Spatial effects legitimately move or spread the picture's edge at their
      // extremes (a 100px blur feathers alpha, 100px mosaic blocks straddle the
      // bar, a k1=k2=-1 lens pulls the picture over the bar): defaults only.
      if (def.params.length && !["blur", "pixelate", "lens"].includes(def.type)) await alphaOf(fx, `${def.type} (all params at ${edge})`);
    }
  }

  console.log("   a full stack + adjustment layer through the engine export...");
  const S = new EditorEngine(join(dir, "stack"));
  S.setProjectSettings({ width: 320, height: 180, fps: 30, name: "stack" });
  const sa = await S.importVideo(bars);
  const sc = S.addClip(sa.id, { startFrame: 0 });
  for (const def of EFFECTS) {
    const d = defaultsFor(def.type);
    await dispatch(S, "apply_effect", { clipId: sc.id, type: def.type, ...d, ...(def.type === "pixelate" ? { enabled: false } : {}) });
  }
  const top = S.addTrack("video", { name: "V2" });
  const adj = (await dispatch(S, "add_adjustment_clip", { trackIndex: top.index, startFrame: 0, durationFrames: 30 })) as { clip: { id: string } };
  await dispatch(S, "apply_effect", { clipId: adj.clip.id, type: "vignette", amount: 1.5 });
  await dispatch(S, "apply_effect", { clipId: adj.clip.id, type: "colorkey", color: "0x000000" });
  try {
    const out = join(dir, "stack.mp4");
    const r = await S.exportVideo(out);
    check(r.duration > 0.5, "every effect stacked on one clip (+ vignette/key adjustment layer) exports", `${r.duration}s`);
  } catch (e) {
    check(false, "full stack export", e instanceof Error ? e.message.slice(-600) : String(e));
  }

  // ---- 6. vignette amounts change the export ----------------------------------------
  console.log("6. vignette amount → corner luma in the export...");
  const corner = async (name: string, fx?: Record<string, unknown>): Promise<number> => {
    const V = new EditorEngine(join(dir, `vig-${name}`));
    V.setProjectSettings({ width: 320, height: 180, fps: 30, name });
    const wa = await V.importVideo(white);
    const wc = V.addClip(wa.id, { startFrame: 0 });
    if (fx) await dispatch(V, "apply_effect", { clipId: wc.id, type: "vignette", ...fx });
    const out = join(dir, `vig-${name}.mp4`);
    await V.exportVideo(out);
    const [r, g, b] = await sampleBlock(out, 0.5, 8, 8);
    return (r + g + b) / 3;
  };
  // Block (8..16, 8..16) centre (12,12) on 320×180: d = |(148,78)| / |(160,90)|.
  const d = Math.hypot(160 - 12, 90 - 12) / Math.hypot(160, 90);
  const none = await corner("none");
  const results: Record<string, number> = {};
  for (const amt of [0, 0.5, 1, 2]) results[amt] = await corner(`a${amt}`, { amount: amt });
  const bypassed = await corner("off", { amount: 2, enabled: false });
  console.log(`   corner luma: none ${none.toFixed(0)}, 0 → ${results[0].toFixed(0)}, 0.5 → ${results[0.5].toFixed(0)}, 1 → ${results[1].toFixed(0)}, 2 → ${results[2].toFixed(0)}, bypassed(2) → ${bypassed.toFixed(0)}`);
  check(Math.abs(results[0] - none) <= 2, "amount 0 leaves the corner as without a vignette");
  check(results[0] - results[0.5] > 8 && results[0.5] - results[1] > 8 && results[1] - results[2] > 8,
    "corner luma strictly darkens with amount (0 > 0.5 > 1 > 2)");
  check(Math.abs(bypassed - none) <= 2, "a bypassed vignette leaves the corner alone");
  for (const amt of [0.5, 1, 2]) {
    const want = none * vignetteFactor(d, vignetteAngle({ type: "vignette", amount: amt }));
    check(Math.abs(results[amt] - want) <= 12, `amount ${amt}: export ≈ the preview curve (${want.toFixed(0)})`, results[amt].toFixed(1));
  }

  // ---- 7. legacy vignette amounts are dropped on load ------------------------------
  console.log("7. pre-v4 projects: vignette amounts dropped on load (.aive + OTIO)...");
  const L = new EditorEngine(join(dir, "legacy"));
  L.setProjectSettings({ width: 320, height: 180, fps: 30, name: "legacy" });
  const la = await L.importVideo(white);
  const lc = L.addClip(la.id, { startFrame: 0 });
  // What the old inspector stored: a vignette touched at the slider's resting 0, plus a blur.
  await dispatch(L, "apply_effect", { clipId: lc.id, type: "vignette", amount: 0 });
  await dispatch(L, "apply_effect", { clipId: lc.id, type: "blur", amount: 3 });
  const lTop = L.addTrack("video", { name: "V2" });
  const lAdj = (await dispatch(L, "add_adjustment_clip", { trackIndex: lTop.index, startFrame: 0, durationFrames: 30 })) as { clip: { id: string } };
  await dispatch(L, "apply_effect", { clipId: lAdj.clip.id, type: "vignette", amount: 1.5 });
  const legacyPath = join(dir, "legacy.aive");
  await L.save(legacyPath);
  const json = JSON.parse(readFileSync(legacyPath, "utf8")) as { schemaVersion: number };
  check(json.schemaVersion === PROJECT_SCHEMA_VERSION && PROJECT_SCHEMA_VERSION >= 4, "projects are saved as schema v4+", String(json.schemaVersion));
  type Loaded = { tracks: { clips: Clip[] }[]; schemaVersion: number };
  const fxOf = (p: Loaded) => p.tracks.flatMap((t) => t.clips.flatMap((c) => c.effects?.filters ?? []));
  const vigAngles = (p: Loaded) => fxOf(p).filter((f) => f.type === "vignette").map((f) => effectFilterSteps([f], 320, 180, "m")[0] ?? "");

  // A current project keeps amount 0 (= no vignette): only old files migrate.
  const cur = (await new EditorEngine(join(dir, "legacy-cur")).load(legacyPath)) as unknown as Loaded;
  check(fxOf(cur).filter((f) => f.type === "vignette").map((f) => f.amount).join() === "0,1.5", "a v4 project keeps its vignette amounts (0 and 1.5)");

  json.schemaVersion = 3;
  writeFileSync(legacyPath, JSON.stringify(json));
  const old = (await new EditorEngine(join(dir, "legacy-old")).load(legacyPath)) as unknown as Loaded;
  const oldVig = fxOf(old).filter((f) => f.type === "vignette");
  check(old.schemaVersion === PROJECT_SCHEMA_VERSION, "a v3 project is stamped with the current schema on load", String(old.schemaVersion));
  check(oldVig.length === 2 && oldVig.every((f) => !("amount" in f)), "v3 vignette amounts (0 on a clip, 1.5 on an adjustment layer) are dropped", JSON.stringify(oldVig));
  check(vigAngles(old).length === 2 && vigAngles(old).every((s) => s.includes("vignette=angle=0.628319")),
    "…so both render the old PI/5 again (amount 0 no longer vanishes)", JSON.stringify(vigAngles(old)));
  check(fxOf(old).find((f) => f.type === "blur")?.amount === 3, "other effects' amounts are untouched (blur 3)");

  // A SynthCut OTIO written by the old build: the clips ride verbatim in the metadata.
  const otioPath = join(dir, "legacy.otio");
  await L.exportOtio(otioPath);
  const otio = JSON.parse(readFileSync(otioPath, "utf8")) as { metadata: { synthcut: { schemaVersion: number } } };
  otio.metadata.synthcut.schemaVersion = 3;
  writeFileSync(otioPath, JSON.stringify(otio));
  const fromOtio = (await new EditorEngine(join(dir, "legacy-otio")).importOtio(otioPath)).project as unknown as Loaded;
  const otioVig = fxOf(fromOtio).filter((f) => f.type === "vignette");
  check(otioVig.length === 2 && otioVig.every((f) => !("amount" in f)) && fromOtio.schemaVersion === PROJECT_SCHEMA_VERSION,
    "a v3 SynthCut OTIO import drops the vignette amounts too", JSON.stringify(otioVig));
  const otioCur = join(dir, "current.otio");
  await L.exportOtio(otioCur);
  const fromCur = (await new EditorEngine(join(dir, "current-otio")).importOtio(otioCur)).project as unknown as Loaded;
  check(fxOf(fromCur).filter((f) => f.type === "vignette").map((f) => f.amount).join() === "0,1.5", "a current OTIO round-trip keeps the vignette amounts");

  // ---- 9. look + style effects, measured on an engine export -----------------------
  console.log("9. look + style effects measured on export...");
  const gray = join(dir, "gray64.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=0x404040:s=320x180:r=30:d=2", "-pix_fmt", "yuv420p", gray]);
  const gray128 = join(dir, "gray128.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=0x808080:s=320x180:r=30:d=2", "-pix_fmt", "yuv420p", gray128]);
  const pair = join(dir, "pair.mp4"); // left dull 0x806060, right saturated 0xC04040
  await ffmpeg(["-f", "lavfi", "-i", "color=c=0x806060:s=160x180:r=30:d=2", "-f", "lavfi", "-i", "color=c=0xC04040:s=160x180:r=30:d=2",
    "-filter_complex", "[0][1]hstack", "-pix_fmt", "yuv420p", pair]);
  const redblue = join(dir, "redblue.mp4"); // left red, right blue
  await ffmpeg(["-f", "lavfi", "-i", "color=c=0xE02020:s=160x180:r=30:d=2", "-f", "lavfi", "-i", "color=c=0x2020E0:s=160x180:r=30:d=2",
    "-filter_complex", "[0][1]hstack", "-pix_fmt", "yuv420p", redblue]);
  const blue = join(dir, "c2060c0.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=0x2060C0:s=320x180:r=30:d=2", "-pix_fmt", "yuv420p", blue]);
  const box = join(dir, "box.mp4"); // white 60×50 box (x 130..190, y 65..115) on black
  await ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=2,drawbox=x=130:y=65:w=60:h=50:color=white:t=fill", "-pix_fmt", "yuv420p", box]);
  const gridline = join(dir, "gridline.mp4"); // one white horizontal line at y 30..33
  await ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=2,drawbox=x=0:y=30:w=320:h=4:color=white:t=fill", "-pix_fmt", "yuv420p", gridline]);
  const mover = join(dir, "mover.mp4"); // 40×40 white box moving right at 100 px/s along y 70..110
  await ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=2", "-f", "lavfi", "-i", "color=c=white:s=40x40:r=30",
    "-filter_complex", "[0][1]overlay=x='20+t*100':y=70:eval=frame:shortest=1", "-pix_fmt", "yuv420p", mover]);

  type Fx = { type: string; amount?: number; color?: string; params?: Record<string, number> };
  /** Export `media` (320×180, no letterbox) with `effects` stacked on its clip, through the engine. */
  let exportN = 0;
  const exportWith = async (media: string, effects: Fx[]): Promise<string> => {
    const X = new EditorEngine(join(dir, `m${exportN}`));
    X.setProjectSettings({ width: 320, height: 180, fps: 30, name: "m" });
    const asset = await X.importVideo(media);
    const clip = X.addClip(asset.id, { startFrame: 0 });
    for (const fx of effects) await dispatch(X, "apply_effect", { clipId: clip.id, ...fx });
    const out = join(dir, `m${exportN++}.mp4`);
    await X.exportVideo(out);
    return out;
  };
  const luma = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const hsvSat = ([r, g, b]: number[]) => { const mx = Math.max(r, g, b); return mx === 0 ? 0 : (mx - Math.min(r, g, b)) / mx; };
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
  const fmt = (c: number[]) => `(${c.map((v) => v.toFixed(0)).join(",")})`;

  // exposure
  {
    const base = await sampleBlock(await exportWith(gray, []), 0.5, 100, 80);
    const ev1 = await sampleBlock(await exportWith(gray, [{ type: "exposure", amount: 1 }]), 0.5, 100, 80);
    const evm1 = await sampleBlock(await exportWith(gray, [{ type: "exposure", amount: -1 }]), 0.5, 100, 80);
    const ev3 = await sampleBlock(await exportWith(gray, [{ type: "exposure", amount: 3 }]), 0.5, 100, 80);
    const evOver = await sampleBlock(await exportWith(gray, [{ type: "exposure", amount: 9 }]), 0.5, 100, 80);
    const lift = await sampleBlock(await exportWith(gray128, [{ type: "exposure", amount: 0, params: { black: 0.1 } }]), 0.5, 100, 80);
    const b0 = luma(base);
    check(near(luma(ev1) / b0, 2, 0.12), `exposure +1 EV doubles mean luma (${b0.toFixed(0)} → ${luma(ev1).toFixed(0)})`);
    check(near(luma(evm1) / b0, 0.5, 0.08), `exposure -1 EV halves mean luma (→ ${luma(evm1).toFixed(0)})`);
    check(luma(ev3) >= 250 && luma(evOver) >= 250, "exposure clips at white (+3 EV and an out-of-range 9 → clamped to +3)", `${luma(ev3).toFixed(0)} / ${luma(evOver).toFixed(0)}`);
    // black 0.1 on mid grey 128: (128/255 − 0.1)/(1 − 0.1) → ~114.
    check(near(luma(lift), 114, 6), `exposure black level 0.1 on grey 128 → ~114 (got ${luma(lift).toFixed(0)})`);
  }
  // vibrance
  {
    const out = await exportWith(pair, [{ type: "vibrance", amount: 1 }]);
    const dull0 = await sampleBlock(pair, 0.5, 60, 80), sat0 = await sampleBlock(pair, 0.5, 220, 80);
    const dull1 = await sampleBlock(out, 0.5, 60, 80), sat1 = await sampleBlock(out, 0.5, 220, 80);
    const [gDull, gSat] = [hsvSat(dull1) / hsvSat(dull0), hsvSat(sat1) / hsvSat(sat0)];
    console.log(`   vibrance +1: dull saturation ${hsvSat(dull0).toFixed(2)} → ${hsvSat(dull1).toFixed(2)} (×${gDull.toFixed(2)}), saturated ${hsvSat(sat0).toFixed(2)} → ${hsvSat(sat1).toFixed(2)} (×${gSat.toFixed(2)})`);
    check(gDull > 1.3 && gSat >= 1 && gDull > gSat + 0.2, "vibrance raises a dull colour's saturation more than a saturated one's");
    const neg = await sampleBlock(await exportWith(pair, [{ type: "vibrance", amount: -1 }]), 0.5, 60, 80);
    check(hsvSat(neg) < hsvSat(dull0) * 0.5, "negative vibrance mutes the dull colour", `${hsvSat(neg).toFixed(2)}`);
  }
  // invert
  {
    const [r, g, b] = await sampleBlock(await exportWith(blue, [{ type: "invert" }]), 0.5, 100, 80);
    check(near(r, 0xdf, 6) && near(g, 0x9f, 6) && near(b, 0x3f, 6), `invert flips 0x2060C0 → ~0xDF9F3F (got ${fmt([r, g, b])})`);
  }
  // colorhold
  {
    const out = await exportWith(redblue, [{ type: "colorhold", color: "0xE02020", params: { similarity: 0.3, blend: 0.1 } }]);
    const kept = await sampleBlock(out, 0.5, 60, 80), dropped = await sampleBlock(out, 0.5, 220, 80);
    check(kept[0] > 180 && kept[0] - kept[1] > 120, `colorhold keeps the held red (got ${fmt(kept)})`);
    check(Math.max(...dropped) - Math.min(...dropped) <= 16, `colorhold desaturates everything else (blue → ${fmt(dropped)})`);
  }
  // grain
  {
    const series = async (file: string): Promise<number[]> => {
      const { stdout } = await ffmpeg(["-i", file, "-frames:v", "20", "-vf", "crop=2:2:100:80,scale=1:1:flags=area,format=gray", "-f", "rawvideo", "-"]);
      return [...(stdout as unknown as Buffer)];
    };
    const sd = (a: number[]) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
    const none = sd(await series(await exportWith(gray128, [])));
    const g40 = sd(await series(await exportWith(gray128, [{ type: "grain", amount: 40 }])));
    const g80 = sd(await series(await exportWith(gray128, [{ type: "grain", amount: 80 }])));
    console.log(`   grain temporal σ of a 2×2 block mean over 20 frames: none ${none.toFixed(2)}, 40 → ${g40.toFixed(2)}, 80 → ${g80.toFixed(2)}`);
    check(none < 0.8 && g40 > 2 && g80 > g40, "grain raises temporal variance (and more amount = more)");
    const grainOut = await exportWith(gray128, [{ type: "grain", amount: 40 }]);
    const { stdout } = await ffmpeg(["-i", grainOut, "-frames:v", "1", "-vf", "crop=64:64:100:60,format=gray", "-f", "rawvideo", "-"]);
    check(sd([...(stdout as unknown as Buffer)]) > 3, "grain is also spatial noise within one frame");
  }
  // glow
  {
    const probe = (file: string) => sampleBlock(file, 0.5, 112, 86, 4); // ~14px left of the box, vertical middle
    const plain = luma(await probe(await exportWith(box, [])));
    const glowy = luma(await probe(await exportWith(box, [{ type: "glow", amount: 1, params: { radius: 12 } }])));
    const far = luma(await sampleBlock(await exportWith(box, [{ type: "glow", amount: 1, params: { radius: 12 } }]), 0.5, 4, 4, 4));
    console.log(`   glow: 14px beside a white box ${plain.toFixed(0)} → ${glowy.toFixed(0)}, far corner ${far.toFixed(0)}`);
    check(glowy > plain + 15, "glow brightens the area around a bright shape");
    check(glowy > far + 10, "…more than far from it");
  }
  // RGB split
  {
    const out = await exportWith(box, [{ type: "rgbsplit", amount: 8, params: { angle: 0 } }]);
    const left = await sampleBlock(out, 0.5, 130, 86, 4), right = await sampleBlock(out, 0.5, 182, 86, 4);
    const plain = await sampleBlock(await exportWith(box, []), 0.5, 130, 86, 4);
    check(Math.abs(plain[0] - plain[2]) < 10, `without the effect the box edge is neutral (${fmt(plain)})`);
    check(Math.abs(left[0] - left[2]) > 100 && Math.abs(right[0] - right[2]) > 100 && Math.sign(left[0] - left[2]) !== Math.sign(right[0] - right[2]),
      `RGB split pushes red and blue apart at the box edges (left ${fmt(left)}, right ${fmt(right)})`);
    const vert = await exportWith(box, [{ type: "rgbsplit", amount: 8, params: { angle: 90 } }]);
    const top = await sampleBlock(vert, 0.5, 150, 65, 4), side = await sampleBlock(vert, 0.5, 130, 86, 4);
    check(Math.abs(top[0] - top[2]) > 100 && Math.abs(side[0] - side[2]) < 40, `angle 90 splits vertically (top edge ${fmt(top)}, side edge ${fmt(side)})`);
  }
  // lens distortion
  {
    const lineRow = async (file: string, x: number): Promise<number> => {
      const { stdout } = await ffmpeg(["-ss", "0.5", "-i", file, "-frames:v", "1", "-vf", `crop=1:180:${x}:0,format=gray`, "-f", "rawvideo", "-"]);
      const col = [...(stdout as unknown as Buffer)];
      return col.indexOf(Math.max(...col));
    };
    const flat = await exportWith(gridline, []);
    const bent = await exportWith(gridline, [{ type: "lens", amount: -0.4 }]);
    const [f0, f1] = [await lineRow(flat, 160), await lineRow(flat, 20)];
    const [b0, b1] = [await lineRow(bent, 160), await lineRow(bent, 40)];
    console.log(`   lens -0.4: grid line rows — flat ${f0}/${f1}, distorted centre ${b0} vs near the edge ${b1}`);
    check(Math.abs(f0 - f1) <= 1, "a straight line is straight without the effect");
    check(Math.abs(b0 - b1) >= 4, "lens distortion bends the line (centre and edge rows differ)");
    const bentPos = await exportWith(gridline, [{ type: "lens", amount: 0.4 }]);
    const [p0, p1] = [await lineRow(bentPos, 160), await lineRow(bentPos, 40)];
    check(b1 < b0 && p1 > p0, `k1 > 0 is barrel (ends pulled toward the centre), k1 < 0 pincushion (ends pushed out) — the documented convention (neg ${b0}/${b1}, pos ${p0}/${p1})`);
    check(Math.abs(p0 - p1) >= 4 && Math.sign(p1 - p0) !== Math.sign(b1 - b0), `the opposite sign bends it the other way (centre ${p0}, edge ${p1})`);

    // Zoom to fill (params.fill, default 1): whatever k1 / k2, no pixel of an opaque frame turns
    // transparent (the binding ray isn't always the corner when the signs differ); fill 0 keeps
    // the old transparent corners.
    const alphas = async (fx: EffectInput, w: number, h: number): Promise<Buffer> => {
      const chain = effectFilterSteps([fx], w, h, "lz").join(",");
      const { stdout } = await ffmpeg(["-f", "lavfi", "-i", `testsrc2=s=${w}x${h}:r=30:d=0.1`, "-filter_complex", `[0:v]format=rgba${chain ? `,${chain}` : ""},format=rgba[o]`,
        "-map", "[o]", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
      const b = stdout as unknown as Buffer;
      return Buffer.from(Array.from({ length: w * h }, (_, i) => b[i * 4 + 3]));
    };
    const empty: string[] = [];
    for (const [w, h] of [[320, 180], [180, 320]]) {
      for (const k1 of [-1, -0.5, 0, 0.3, 0.5, 1]) {
        for (const k2 of [-1, -0.5, 0, 0.5, 1]) {
          if (k1 === 0 && k2 === 0) continue;
          const a = await alphas({ type: "lens", amount: k1, params: { k2 } }, w, h);
          const n = a.filter((v) => v < 255).length;
          if (n) empty.push(`${w}×${h} k1 ${k1} k2 ${k2}: ${n} px`);
        }
      }
    }
    check(empty.length === 0, "lens zoom to fill (default): no transparent pixel for any k1 / k2 (30 settings × 2 aspects)", empty.join("; "));
    const off = await alphas({ type: "lens", amount: 0.3, params: { fill: 0 } }, 320, 180);
    check(off[0] === 0 && off[319] === 0 && off[179 * 320] === 0 && off[179 * 320 + 319] === 0, "lens fill 0: the uncovered corners stay transparent (the old look)");
    const zoomed = effectFilterSteps([{ type: "lens", amount: 0.3 }], 1920, 1080, "lz").join(",");
    check(zoomed.includes("perspective=") && !effectFilterSteps([{ type: "lens", amount: -0.4, params: { k2: 0.3 } }], 1920, 1080, "lz").join(",").includes("perspective"),
      "the zoom is a perspective step only when the warp uncovers something (barrel yes, this pincushion no)", zoomed);
  }
  // trails
  {
    const at = (file: string) => sampleBlock(file, 1.0, 94, 88, 4); // behind the box (now x 120..160), where it was ~0.5 s earlier
    const plain = luma(await at(await exportWith(mover, [])));
    const ghost = luma(await at(await exportWith(mover, [{ type: "trails", amount: 0.95 }])));
    const ghostShort = luma(await at(await exportWith(mover, [{ type: "trails", amount: 0.8 }])));
    console.log(`   trails: behind the moving box ${plain.toFixed(0)} → decay 0.95 ${ghost.toFixed(0)}, decay 0.8 ${ghostShort.toFixed(0)}`);
    check(plain < 10 && ghost > plain + 40, "trails leave a ghost of the moving box behind it");
    check(ghost > ghostShort, "a higher decay leaves a longer trail");
  }

  // exposure: the CSS proxy modelled with CSS's per-stage clamp (Chrome clamps between filter functions)
  {
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
    const css = (filter: string, x: number): number => {
      let v = x;
      for (const m of filter.matchAll(/(brightness|contrast)\(([-\d.]+)\)/g)) {
        const a = Number(m[2]);
        v = clamp01(m[1] === "brightness" ? v * a : (v - 0.5) * a + 0.5);
      }
      return v;
    };
    const exp = EFFECTS.find((e) => e.type === "exposure")!;
    let worst = 0, worstAt = "";
    for (const ev of [-3, -1, -0.5, 0, 0.5, 1, 2, 3]) {
      for (const black of [-1, -0.6, -0.5, -0.2, -0.05, 0, 0.05, 0.2, 0.5, 1]) {
        const fx: EffectInput = { type: "exposure", amount: ev, params: { black } };
        const b = exposureBlack(fx);
        check(b < 2 ** -ev, `exposure EV ${ev} black ${black}: black kept below 2^-EV (${b.toFixed(3)} < ${(2 ** -ev).toFixed(3)})`);
        const filter = (exp.preview as { css: (e: EffectInput) => string }).css(fx);
        for (const x of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
          const want = clamp01((x - b) / (2 ** -ev - b)); // what FFmpeg's exposure computes
          const d = Math.abs(css(filter, x) - want);
          if (d > worst) { worst = d; worstAt = `EV ${ev} black ${black} x ${x}: css ${css(filter, x).toFixed(3)} vs ${want.toFixed(3)} (${filter})`; }
        }
      }
    }
    check(worst < 0.01, "exposure CSS preview matches the FFmpeg formula (per-stage clamp modelled) incl. black < 0", `${worst.toFixed(3)} at ${worstAt}`);
    const v = validateEffect({ type: "exposure", amount: 2, params: { black: 0.5 } });
    check(v.adjusted.length === 1 && (v.params?.black ?? 1) < 0.25, "exposure black >= 2^-EV is clamped and reported", JSON.stringify(v));
  }
  // exposure on the engine export with an incoherent pair must not blank or invert the picture
  {
    const ramp = join(dir, "ramp-exp.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "color=c=gray:s=320x180:r=30:d=1,format=gray,geq=lum='X/320*255'", "-pix_fmt", "yuv420p", ramp]);
    const out = await exportWith(ramp, [{ type: "exposure", amount: 2, params: { black: 0.25 } }]);
    const [l, r] = [luma(await sampleBlock(out, 0.5, 10, 80)), luma(await sampleBlock(out, 0.5, 300, 80))];
    check(l < r, `exposure EV 2 black 0.25 (denominator 0 in raw FFmpeg) still brightens left to right (${l.toFixed(0)} < ${r.toFixed(0)})`);
  }
  // key, then glow / trails / rgbsplit: the colour hidden under alpha 0 must not tint the subject
  {
    const keyed = (steps: string[]) =>
      `color=c=0x00FF00:s=320x180:r=10:d=1,format=rgba[bg];color=c=0x606060:s=60x60:r=10:d=1,format=rgba[sq];[bg][sq]overlay=x=100+t*30:y=60,format=rgba,` +
      `${["chromakey=0x00FF00:0.1:0.0", ...steps].join(",")},format=rgba[out]`;
    const run = async (steps: string[]) => {
      const { stdout } = await ffmpeg(["-filter_complex", keyed(steps), "-map", "[out]", "-frames:v", "8", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
      return stdout as unknown as Buffer;
    };
    const px = (buf: Buffer, frame: number, x: number, y: number) => buf.subarray(frame * 320 * 180 * 4 + (y * 320 + x) * 4).subarray(0, 4);
    const greenest = (buf: Buffer, frame: number, xs: number[]) => Math.max(...xs.map((x) => { const p = px(buf, frame, x, 90); return p[3] > 0 ? p[1] - Math.max(p[0], p[2]) : 0; }));
    // Interior of the grey (0x60) square at the last frame: x 123..177 (skip the 1px key fringe).
    const inside = [123, 130, 150, 170, 177];
    const plainG = greenest(await run([]), 7, inside);
    for (const type of ["glow", "trails", "rgbsplit"] as const) {
      const steps = effectFilterSteps([{ type, ...defaultsFor(type) }], 320, 180, "k");
      const g = greenest(await run(steps), 7, inside);
      check(g <= plainG + 12, `key + ${type}: no green tint inside the subject (${g} vs ${plainG} without it)`);
    }
    // Trail pixels behind the subject: x 100..118 at frame 7 are well left of the square.
    const tr = await run(effectFilterSteps([{ type: "trails", amount: 0.95 }], 320, 180, "k"));
    check(greenest(tr, 7, [104, 108, 112, 116]) <= 12, "key + trails: the ghost behind the subject is not green");
  }

  // ---- 10. stabilize cancel cleanup ---------------------------------------------------
  console.log("10. canceled stabilize leaves no .trf / partial .mp4 in baked/...");
  {
    // 320x180 x 40 s: vidstabdetect's cost scales with pixels (~0.3 CPU-s per
    // 720p frame), so a bigger clip outran even a 150 s wait while the machine
    // ran several matrices at once. The encode pass still lasts well over the
    // 300 ms the cancel waits for.
    const long = join(dir, "long.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=40", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", long]);
    const St = new EditorEngine(join(dir, "stab"));
    St.setProjectSettings({ width: 320, height: 180, fps: 30, name: "stab" });
    const sa = await St.importVideo(long);
    const sc = St.addClip(sa.id, { startFrame: 0 });
    const bakedDir = join(St.dataDir, "baked");
    const stabFiles = () => (existsSync(bakedDir) ? readdirSync(bakedDir).filter((f) => f.includes("-stab-")) : []);
    for (const phase of ["analysis", "encode"] as const) {
      const p = St.stabilizeClip(sc.id, { shakiness: 6 });
      p.catch(() => {});
      const want = phase === "analysis" ? ".trf" : ".mp4";
      // Wait for the phase's file, not for a fixed time: stop early only if the
      // job ends first (the 300 s cap only bounds a hung ffmpeg).
      const stabRunning = () => St.jobs.list(true).some((j) => j.type === "stabilize");
      const t0 = Date.now();
      while (!stabFiles().some((f) => f.endsWith(want)) && stabRunning() && Date.now() - t0 < 300_000) await new Promise((r) => setTimeout(r, 25));
      const seen = stabFiles();
      const running = St.jobs.list(true).filter((j) => j.type === "stabilize");
      check(seen.some((f) => f.endsWith(want)) && running.length === 1, `${phase}: the job is mid-run with ${want} on disk (${seen.join(", ")})`);
      if (phase === "encode") await new Promise((r) => setTimeout(r, 300)); // let the encoder write something
      for (const j of running) St.jobs.cancel(j.id);
      let err = "";
      try { await p; } catch (e) { err = e instanceof Error ? e.message : String(e); }
      check(err !== "", `${phase}: canceled stabilize rejects`, err);
      await new Promise((r) => setTimeout(r, 200));
      check(stabFiles().length === 0, `${phase}: baked/ has no leftover stabilize files`, stabFiles().join(", "));
      const after = (St.getProject().tracks.flatMap((t) => t.clips).find((c) => c.id === sc.id));
      check(after?.assetId === sa.id, `${phase}: the clip still points at its source`);
    }
  }

  console.log(failures === 0 ? "\nEFFECT REGISTRY SMOKE TEST PASSED" : `\nEFFECT REGISTRY SMOKE TEST FAILED — ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("EFFECT REGISTRY SMOKE TEST FAILED:", err);
  process.exit(1);
});
