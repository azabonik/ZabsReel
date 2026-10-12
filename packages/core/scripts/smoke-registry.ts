/**
 * Effect-registry smoke test (effects/registry.ts). Synthesizes all of its media
 * (no downloads, no arguments):
 *
 *   1. Registry integrity: one entry per EFFECT_TYPE_IDS, sane param schemas,
 *      every type in the generated AI description.
 *   2. Legacy stored effects ({type:"blur",amount:8}, keys with params, …) emit
 *      BYTE-IDENTICAL filter strings to b6219ab (literals captured from that
 *      commit's graph.ts). Vignette is the intended exception: it now maps
 *      amount → lens angle and keeps alpha.
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
 * Run: npx tsx packages/core/scripts/smoke-registry.ts
 */
import { execa } from "execa";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { EditorEngine } from "../src/engine.js";
import { dispatch } from "../src/rpc.js";
import { FFMPEG_BIN } from "../src/ffmpeg/executor.js";
import { PROJECT_SCHEMA_VERSION } from "../src/types.js";
import {
  EFFECTS, EFFECT_CATEGORIES, EFFECT_TYPE_IDS, defaultsFor, describeEffectsForAI,
  effectFilterSteps, exactOnly, isKeyType, vignetteAngle, vignetteFactor, type EffectInput,
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
  check(exactOnly("sharpen") && exactOnly("pixelate") && !exactOnly("blur") && !exactOnly("vignette") && !exactOnly("chromakey"),
    "exactOnly: sharpen/pixelate export-only; blur (css), vignette (pass), keys (WebGL) preview live");
  check(JSON.stringify(defaultsFor("chromakey")) === JSON.stringify({ params: { similarity: 0.18, blend: 0.1, despill: 0 }, color: "0x00FF00" }),
    "defaultsFor(chromakey)", JSON.stringify(defaultsFor("chromakey")));

  // ---- 2. legacy filter strings (byte-identical to b6219ab) ---------------------
  console.log("2. legacy stored effects emit the b6219ab filter strings...");
  const LEGACY: [EffectInput, string[]][] = [
    [{ type: "blur", amount: 8 }, ["gblur=sigma=8.000000"]],
    [{ type: "blur" }, ["gblur=sigma=8.000000"]],
    [{ type: "blur", amount: 150 }, ["gblur=sigma=100.000000"]],
    [{ type: "sharpen", amount: 1.2 }, ["unsharp=5:5:1.200000:5:5:0"]],
    [{ type: "detail" }, ["cas=strength=0.500000"]],
    [{ type: "denoise", amount: 4 }, ["hqdn3d=4.000000"]],
    [{ type: "sepia" }, ["colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131"]],
    [{ type: "grayscale", amount: 3 }, ["hue=s=0"]],
    [{ type: "edges" }, ["edgedetect=mode=colormix"]],
    [{ type: "posterize", amount: 6 }, ["lutrgb=r='round(val/255*5)/5*255':g='round(val/255*5)/5*255':b='round(val/255*5)/5*255'"]],
    [{ type: "pixelate", amount: 16 }, ["scale=max(2\\,iw/16.000000):max(2\\,ih/16.000000):flags=neighbor", "scale=640:360:flags=neighbor"]],
    [{ type: "colorkey", color: "0x808080" },
      ["format=rgba,split[keyc1_0a][keyc1_0b];[keyc1_0a]colorkey=0x808080:0.080000:0.040000,format=rgba[keyc1_0k];[keyc1_0b][keyc1_0k]blend=c3_mode=multiply,format=rgba"]],
    [{ type: "chromakey", color: "#00ff00", params: { despill: 0.5 } },
      ["format=rgba,split[keyc1_0a][keyc1_0b];[keyc1_0a]chromakey=0x00FF00:0.180000:0.100000,despill=type=green:mix=0.5:expand=0:red=0:green=-0.500000:blue=0:brightness=0,format=rgba[keyc1_0k];[keyc1_0k][keyc1_0b]blend=c3_mode=multiply,format=rgba"]],
    [{ type: "chromakey", color: "auto", params: { similarity: 3 } },
      ["format=rgba,split[keyc1_0a][keyc1_0b];[keyc1_0a]chromakey=0x00FF00:1.000000:0.100000,format=rgba[keyc1_0k];[keyc1_0b][keyc1_0k]blend=c3_mode=multiply,format=rgba"]],
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
  await rejects(dispatch(E, "apply_effect", { clipId: c.id, type: "colorkey", color: "rgb(0,255,0)" }), /Invalid key color "rgb\(0,255,0\)"/, "a CSS colour is rejected");
  await rejects(dispatch(E, "apply_effect", { clipId: c.id, type: "lumakey", color: "0x000000" }), /lumakey takes no key colour/, "lumakey rejects a hex colour");
  await rejects(dispatch(E, "apply_effect", { clipId: c.id, type: "glow" }), /Invalid params/, "an unknown type is rejected by the schema");
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
    const s = effectFilterSteps([fx], 320, 180, "t0");
    const graph = `[0:v]format=rgba,scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setsar=1${s.length ? `,${s.join(",")}` : ""},format=rgba[out]`;
    try {
      const { stdout } = await ffmpeg(["-i", bars, "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
      const buf = stdout as unknown as Buffer;
      check(buf.length === 320 * 180 * 4, `${def.type}: renders a frame (${s.length} step${s.length === 1 ? "" : "s"})`, `${buf.length} bytes`);
      if (def.type === "vignette") check(buf[3] === 0, "vignette keeps the letterbox bar transparent", `alpha ${buf[3]}`);
    } catch (e) {
      check(false, `${def.type}: FFmpeg rejected the filter`, `${graph}\n${e instanceof Error ? e.message.slice(-400) : e}`);
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

  console.log(failures === 0 ? "\nEFFECT REGISTRY SMOKE TEST PASSED" : `\nEFFECT REGISTRY SMOKE TEST FAILED — ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("EFFECT REGISTRY SMOKE TEST FAILED:", err);
  process.exit(1);
});
