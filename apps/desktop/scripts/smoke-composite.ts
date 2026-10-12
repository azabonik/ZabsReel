// Phase 2 smoke: the pure compositor plan (no DOM, no FFmpeg). Builds a
// synthetic multi-track project and asserts that activeLayersAt() returns the
// right layers, in z-order, with the right source times / opacities, that gaps
// draw nothing, that transitions cross-fade, that hidden tracks aren't drawn
// (but still play audio), and that muted tracks are silent. Also checks the
// renderer's bleep expansion (src/bleeps.ts) against the core original on the
// same inputs (speed, audio slip, trims, fps) and that the plan plays each
// bleep's sound effect where the export does. Then the preview side of the
// effect registry: CSS builders, the vignette pass, bypassed effects, and that
// the renderer's key helpers ARE the registry's. Finally blend modes and shape
// masks: they flow into draw / adjust plans (a transition run uses its first
// clip's mode, as the export), the mask staging size buckets, and the
// mask-handle geometry (maskdraw.ts) round-trips through drawLayer's transform.
//
// Imports `@aive/core/effects` through the package exports (core's dist/), so
// build core first (`npm run build`, or `npx tsc -b packages/core`).
//
// Run:  npx tsx apps/desktop/scripts/smoke-composite.ts

import { activeLayersAt, timelineDurationSec } from "../src/composite";
import { bleepMuteSpans, expandBleeps } from "../src/bleeps";
import { muteGainAt } from "../src/mutes";
import type { Bleep, Clip, MediaAsset, Project, Track } from "../src/types";
// The core originals the renderer mirrors (run under tsx, which resolves core's .js imports).
import { bleepMuteSpans as coreMuteSpans, expandBleeps as coreExpand } from "../../../packages/core/src/audio/bleeps";
import { muteGainAt as coreMuteGainAt } from "../../../packages/core/src/audio/mutes";
import { colorFilter, vignetteAngles } from "../src/playback";
import { KEY_DEFAULTS, KEY_DEFAULT_COLOR, KEY_EFFECT_TYPES, isKeyEffect, keyPlan } from "../src/keying";
import { canvasToMask, layerXform, maskStageSize, maskToCanvas } from "../src/maskdraw";
import {
  EFFECTS, EFFECT_CATEGORIES, defaultsFor, effectByType, exactOnly, previewScaleFor, vignetteFactor,
} from "@aive/core/effects";
import type { Clip, MediaAsset, Project, Track, VisualEffect } from "../src/types";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function near(a: number, b: number, eps = 0.02) {
  return Math.abs(a - b) <= eps;
}

const FPS = 30;

function asset(id: string, opts: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id, path: `C:/media/${id}.mp4`, name: `${id}.mp4`, duration: 100,
    width: 1920, height: 1080, fps: FPS, hasVideo: true, hasAudio: true, addedAt: 0,
    ...opts,
  };
}
function clip(id: string, assetId: string, startFrame: number, dur: number, extra: Partial<Clip> = {}): Clip {
  return { id, assetId, startFrame, sourceInFrame: 0, sourceOutFrame: dur, ...extra };
}
function track(kind: Track["kind"], index: number, clips: Clip[], extra: Partial<Track> = {}): Track {
  return { id: `tr-${kind}-${index}`, kind, index, clips, ...extra };
}

const vidA = asset("vidA");
const vidB = asset("vidB");
const ovl = asset("ovl");
const hid = asset("hid", { hasAudio: false }); // hidden track, video-only (keeps audio test clean)
const aud = asset("aud", { hasVideo: false });
const audMute = asset("audMute", { hasVideo: false });
const music = asset("music", { hasVideo: false, duration: 30 });

const project: Project = {
  id: "p", name: "smoke", width: 1920, height: 1080, fps: FPS,
  assets: [vidA, vidB, ovl, hid, aud, audMute, music],
  tracks: [
    // Base video: A 0..60, B 45..105 (B has a fade transition → overlap [45,60)),
    // then C 120..150 (gap [105,120) before it).
    track("video", 0, [
      clip("A", "vidA", 0, 60),
      clip("B", "vidB", 45, 60, { transition: { type: "fade", durationFrames: 15 } }),
      clip("C", "vidA", 120, 30),
    ]),
    // Upper video overlay: OVL 30..45, fades in over 10 frames (z-order test).
    track("video", 1, [clip("O", "ovl", 30, 15, { effects: { fadeInFrames: 10 } })]),
    // Hidden video track: should never draw, but its audio... is video-only here.
    track("video", 2, [clip("H", "hid", 0, 60)], { hidden: true }),
    // Audio track: AUD 0..90 (unmuted) — should be audible.
    track("audio", 0, [clip("AUD", "aud", 0, 90)]),
    // Muted audio track: should be silent.
    track("audio", 1, [clip("MUTE", "audMute", 0, 90)], { muted: true }),
  ],
  music: { assetId: "music", volume: 0.5 },
  revision: 1, schemaVersion: 2, createdAt: 0, updatedAt: 0,
};

const assetById = new Map(project.assets.map((a) => [a.id, a]));
const at = (frame: number) => activeLayersAt(project, assetById, frame / FPS);

console.log("Phase 2 compositor plan smoke\n");

// --- frame 10: only base A is drawn (upper/hidden not active) ---------------
{
  const plan = at(10);
  const draws = plan.clips.filter((c) => c.draw);
  check("f10: exactly one drawn layer (base A)", draws.length === 1 && draws[0].clipId === "A",
    `got [${draws.map((d) => d.clipId).join(",")}]`);
  // srcTime of A at 10 frames = 10/30 s
  check("f10: A srcTime ≈ 0.333s", !!draws[0] && near(draws[0].srcTime, 10 / FPS));
  // Audio: base A (hasAudio) + audio-track AUD; muted track excluded.
  const audIds = plan.clips.filter((c) => c.audio).map((c) => c.clipId).sort();
  check("f10: audible = A + AUD (muted excluded)", JSON.stringify(audIds) === JSON.stringify(["A", "AUD"]),
    `got [${audIds.join(",")}]`);
  check("f10: muted track clip not audible", !plan.clips.some((c) => c.clipId === "MUTE" && c.audio));
  check("f10: hidden track clip not drawn", !plan.clips.some((c) => c.clipId === "H" && c.draw));
}

// --- frame 35: base A under upper OVL (z-order + fade-in opacity) ------------
{
  const plan = at(35);
  const draws = plan.clips.filter((c) => c.draw);
  check("f35: two drawn layers", draws.length === 2, `got ${draws.length}`);
  check("f35: bottom→top order = [A, O]",
    draws[0]?.clipId === "A" && draws[1]?.clipId === "O",
    `got [${draws.map((d) => d.clipId).join(",")}]`);
  check("f35: base track below overlay track",
    !!draws[0] && !!draws[1] && draws[0].trackIndex < draws[1].trackIndex);
  // OVL local frame = (35-30)=5; fadeIn 10 → opacity ~0.5
  const o = draws.find((d) => d.clipId === "O");
  check("f35: overlay fade-in opacity ≈ 0.5", !!o && near(o.draw!.opacity, 0.5, 0.05),
    `got ${o?.draw?.opacity}`);
}

// --- frame 52: transition cross-fade between A (out) and B (in) on base ------
{
  const plan = at(52);
  const draws = plan.clips.filter((c) => c.draw);
  check("f52: two base layers in overlap", draws.length === 2 &&
    draws.every((d) => d.trackIndex === 0), `got [${draws.map((d) => d.clipId).join(",")}]`);
  const a = draws.find((d) => d.clipId === "A");
  const b = draws.find((d) => d.clipId === "B");
  // prog = (52-45)/(60-45) = 0.4667 → B in, A out
  check("f52: incoming B opacity ≈ 0.467", !!b && near(b.draw!.opacity, 0.4667, 0.03), `got ${b?.draw?.opacity}`);
  check("f52: outgoing A opacity ≈ 0.533", !!a && near(a.draw!.opacity, 0.5333, 0.03), `got ${a?.draw?.opacity}`);
  check("f52: incoming drawn on top of outgoing", draws[0]?.clipId === "A" && draws[1]?.clipId === "B");
}

// --- frame 112: gap on every track → nothing drawn or heard -----------------
{
  const plan = at(112);
  check("f112: gap yields no layers at all", plan.clips.length === 0, `got ${plan.clips.length}`);
}

// --- timeline duration = furthest end (C ends at frame 150) -----------------
check("duration = 5.0s (C ends @150)", near(timelineDurationSec(project), 150 / FPS), `got ${timelineDurationSec(project)}`);

// --- transform + keyframe animation surfaces in the draw plan ----------------
{
  const tfProject: Project = {
    ...project,
    tracks: [
      track("video", 0, [
        clip("TF", "vidA", 0, 60, {
          effects: { transform: { rotation: 8, flipH: true } },
          keyframes: {
            x: [{ frame: 0, value: -0.5 }, { frame: 15, value: 0, ease: "easeOut" }],
            scale: [{ frame: 0, value: 0.5 }, { frame: 10, value: 1 }],
            opacity: [{ frame: 0, value: 0 }, { frame: 5, value: 1 }],
          },
        }),
      ]),
    ],
    music: undefined,
  };
  const tfAssets = new Map(tfProject.assets.map((a) => [a.id, a]));
  const drawAt = (frame: number) => activeLayersAt(tfProject, tfAssets, frame / FPS).clips[0]?.draw;

  const d0 = drawAt(0)!;
  check("tf @0: x = -0.5", !!d0 && near(d0.transform.x, -0.5));
  check("tf @0: scale = 0.5", !!d0 && near(d0.transform.scale, 0.5));
  check("tf @0: static rotation 8 + flipH", !!d0 && d0.transform.rotation === 8 && d0.transform.flipH === true);
  check("tf @0: opacity keyframed to 0", !!d0 && near(d0.transform.opacity, 0) && near(d0.opacity, 0));

  const d5 = drawAt(5)!;
  check("tf @5: scale halfway = 0.75", !!d5 && near(d5.transform.scale, 0.75));
  check("tf @5: opacity ramped to 1", !!d5 && near(d5.opacity, 1));

  const d15 = drawAt(15)!;
  check("tf @15: x eased to 0", !!d15 && near(d15.transform.x, 0));
  check("tf @20: scale clamps after last kf", near(drawAt(20)!.transform.scale, 1));
}

// --- keys surface as a live key plan (WebGL preview), split around colour ----
{
  const keyProject: Project = {
    ...project,
    tracks: [
      track("video", 0, [clip("PLAIN", "vidA", 0, 30)]),
      track("video", 1, [
        clip("KEYED", "ovl", 0, 30, {
          effects: {
            color: { brightness: 0.1 },
            filters: [
              { id: "g", type: "grayscale" },
              { id: "k1", type: "colorkey", color: "0x808080" },
              { id: "b", type: "blur", amount: 10 },
              { id: "k2", type: "chromakey", color: "#00ff00", params: { despill: 0.5 } },
            ],
          },
        }),
      ]),
    ],
    music: undefined,
  };
  const kAssets = new Map(keyProject.assets.map((a) => [a.id, a]));
  const draws = activeLayersAt(keyProject, kAssets, 0.1).clips.filter((c) => c.draw);
  const plain = draws.find((c) => c.clipId === "PLAIN")?.draw;
  const key = draws.find((c) => c.clipId === "KEYED")?.draw?.key;
  check("key: un-keyed clip has no key plan", !!plain && plain.key === undefined);
  check("key: keyed clip has a plan with both keys in order", key?.keys.map((k) => k.kind).join(",") === "colorkey,chromakey");
  check("key: colour + effects before the first key run first", key?.pre === "brightness(1.1) grayscale(1)", key?.pre);
  check("key: effects after the first key run on the keyed result", key?.post === "blur(6.6667px)", key?.post);
  check("key: colorkey defaults + parsed colour", !!key && key.keys[0].rgb.join() === "128,128,128" &&
    near(key.keys[0].similarity, 0.08, 1e-9) && near(key.keys[0].blend, 0.04, 1e-9));
  check("key: chromakey #00ff00 is a green screen with despill", !!key && key.keys[1].screen === "green" &&
    near(key.keys[1].despill, 0.5, 1e-9) && near(key.keys[1].similarity, 0.18, 1e-9));
}

// --- bleeps: renderer mirror == core expansion, and the plan plays them ------
{
  console.log("\nbleeps");
  const BLEEPS: Bleep[] = [
    { id: "b1", start: 0.94, end: 1.48, sound: "beep", word: "fucking" },
    { id: "b2", start: 2.94, end: 3.38, sound: "quack", volume: 1.2 },
    { id: "b3", start: 3.2, end: 3.5, sound: "boing", mute: false },      // overlaps b2
    { id: "b4", start: 4.0, end: 4.3, sfxAssetId: "custom" },             // custom sound (0.7 s)
    { id: "b5", start: 4.5, end: 4.7, sfxAssetId: "gone" },               // custom asset missing
    { id: "b6", start: 5.9, end: 6.4, sound: "honk" },                    // runs past a 6 s trim
    { id: "b7", start: 0.1, end: 0.3, sound: "squeak" },
  ];
  const customDuration = (id: string) => (id === "custom" ? 0.7 : undefined);
  let compared = 0;
  let mismatches = 0;
  for (const fps of [30, 24, 29.97]) {
    for (const speed of [1, 2, 0.5, 1.5, 0.25]) {
      for (const audioOffsetFrames of [0, -12, 20]) {
        for (const [inS, outS] of [[0, 6], [0.5, 6], [1.6, 4.4], [3.25, 5.95]] as const) {
          const c = {
            startFrame: 37,
            sourceInFrame: Math.round(inS * fps),
            sourceOutFrame: Math.round(outS * fps),
            audioOffsetFrames: audioOffsetFrames || undefined,
            effects: { speed, bleeps: BLEEPS },
          };
          const mine = expandBleeps(c, fps, customDuration);
          const core = coreExpand(c, fps, customDuration);
          compared++;
          const same =
            mine.length === core.length &&
            mine.every((l, i) => {
              const k = core[i]!;
              return l.bleepId === k.bleepId && l.sound === k.sound && l.sfxAssetId === k.sfxAssetId && l.mute === k.mute &&
                l.word === k.word && ["srcStart", "srcEnd", "start", "windowEnd", "sfxDuration", "volume"].every(
                  (f) => Math.abs((l as unknown as Record<string, number>)[f]! - (k as unknown as Record<string, number>)[f]!) < 1e-9,
                );
            }) &&
            JSON.stringify(bleepMuteSpans(c, fps)) === JSON.stringify(coreMuteSpans(c, fps));
          if (!same) {
            mismatches++;
            if (mismatches <= 3) console.error("    mismatch", { fps, speed, audioOffsetFrames, inS, outS }, mine, core);
          }
          // The mute envelope itself, sampled across the source range.
          for (let t = inS; t < outS; t += 0.0137) {
            if (Math.abs(muteGainAt(bleepMuteSpans(c, fps), t) - coreMuteGainAt(coreMuteSpans(c, fps), t)) > 1e-12) { mismatches++; break; }
          }
        }
      }
    }
  }
  check(`renderer expandBleeps/bleepMuteSpans == core on ${compared} clip variants (speed, slip, trims, fps)`, mismatches === 0, `${mismatches} mismatch(es)`);

  // Spot-check the expansion semantics directly.
  const c2 = { startFrame: 30, sourceInFrame: 0, sourceOutFrame: 180, audioOffsetFrames: 15, effects: { speed: 2, bleeps: BLEEPS } };
  const ls = expandBleeps(c2, 30, customDuration);
  const b1 = ls.find((l) => l.bleepId === "b1")!;
  check("speed 2 + slip: b1 starts at clip audio start + src/2", near(b1.start, 1 + 0.5 + 0.94 / 2, 1e-9));
  check("beep lasts window / speed", near(b1.sfxDuration, (1.48 - 0.94) / 2, 1e-9));
  const b2 = ls.find((l) => l.bleepId === "b2")!;
  const b3 = ls.find((l) => l.bleepId === "b3")!;
  check("quack cut at the next bleep's start", near(b2.sfxDuration, b3.start - b2.start, 1e-9));
  check("custom sound cut at the next bleep (0.25 s at speed 2)", near(ls.find((l) => l.bleepId === "b4")!.sfxDuration, (4.5 - 4.0) / 2, 1e-9));
  const lone = expandBleeps({ startFrame: 0, sourceInFrame: 0, sourceOutFrame: 180, effects: { speed: 2, bleeps: [BLEEPS[3]!] } }, 30, customDuration);
  check("custom sound plays its full asset length at normal speed", near(lone[0]!.sfxDuration, 0.7, 1e-9));
  check("missing custom asset → silent layer", ls.find((l) => l.bleepId === "b5")!.sfxDuration === 0);
  check("bleep past the trim is clipped to the clip end", near(ls.find((l) => l.bleepId === "b6")!.srcEnd, 6, 1e-9));
  check("mute:false bleep is not in the mute spans", !bleepMuteSpans(c2, 30).some((m) => near(m.start, 3.2) && near(m.end, 3.5)));

  // The compositor plan plays the SFX layer where the export puts it.
  const beepWav: MediaAsset = asset("sfxbeep", { path: "C:/data/sfx/beep-v1.wav", hasVideo: false, duration: 3, builtinSfx: "beep" });
  const quackWav: MediaAsset = asset("sfxquack", { path: "C:/data/sfx/quack-v1.wav", hasVideo: false, duration: 0.3, builtinSfx: "quack" });
  const mk = (extra: Partial<Track> = {}, clipFx: Clip["effects"] = {}): Project => ({
    ...project,
    assets: [vidA, beepWav, quackWav],
    tracks: [
      track("video", 0, [clip("BL", "vidA", 30, 180, { effects: { bleeps: BLEEPS.slice(0, 2), ...clipFx } })], extra),
    ],
    music: undefined,
  });
  const pj = mk();
  const pAssets = new Map(pj.assets.map((a) => [a.id, a]));
  const inWin = activeLayersAt(pj, pAssets, 1 + 1.2);
  const sfx = inWin.clips.find((c) => c.bleep?.bleepId === "b1");
  check("plan: beep layer inside its window", !!sfx && sfx.path === beepWav.path && near(sfx.srcTime, 1.2 - 0.94, 1e-9) && sfx.rate === 1 && near(sfx.audio!.volume, 0.8));
  const parent = inWin.clips.find((c) => c.clipId === "BL");
  check("plan: parent audio muted under the bleep", !!parent?.audio && parent.audio.volume < 1e-9, `got ${parent?.audio?.volume}`);
  const pre = activeLayersAt(pj, pAssets, 1 + 0.94 - 0.3).clips.find((c) => c.bleep?.bleepId === "b1");
  check("plan: preroll binds the decoder early, silent + parked at 0", !!pre?.bleep?.preroll && !pre.audio && pre.srcTime === 0);
  const quackAt = activeLayersAt(pj, pAssets, 1 + 2.94 + 0.1).clips.find((c) => c.bleep?.bleepId === "b2");
  check("plan: quack uses the quack SFX at its own volume (clamped to 1)", !!quackAt && quackAt.path === quackWav.path && near(quackAt.audio!.volume, 1));
  check("plan: no SFX after the beep ends", !activeLayersAt(pj, pAssets, 1 + 1.5).clips.some((c) => c.bleep?.bleepId === "b1"));
  check("plan: muted track plays no bleeps", !activeLayersAt(mk({ muted: true }), pAssets, 2.2).clips.some((c) => c.bleep));
  check("plan: clip volume 0 silences its bleeps", !activeLayersAt(mk({}, { volume: 0 }), pAssets, 2.2).clips.some((c) => c.bleep));
}

// --- effect registry: preview side ------------------------------------------
{
  const fx = (type: string, extra: Partial<VisualEffect> = {}): VisualEffect => ({ id: `${type}-${Math.random()}`, type, ...extra });
  // CSS builders (byte-identical to the pre-registry colorFilter for blur/grayscale/sepia).
  // Blur: CSS blur(r) has std-dev r px = gblur's sigma, so r = sigma × preview scale over the WHOLE slider range.
  const blurCss = (amount: number | undefined, scale?: number) => colorFilter(undefined, undefined, [fx("blur", amount === undefined ? {} : { amount })], scale);
  check("css: blur 10 at scale 1 → blur(10px)", blurCss(10, 1) === "blur(10px)", blurCss(10, 1));
  check("css: blur default (8) at scale 1 → blur(8px)", blurCss(undefined, 1) === "blur(8px)");
  check("css: blur 100 at scale 1 → blur(100px) (no longer stops at amount 50)", blurCss(100, 1) === "blur(100px)", blurCss(100, 1));
  check("css: blur clamps at the slider's 100", blurCss(400, 1) === "blur(100px)");
  const bs = [10, 25, 50, 75, 100].map((a) => parseFloat(blurCss(a, 1).slice(5)));
  check("css: blur grows strictly over the whole range (10 < 25 < 50 < 75 < 100)", bs.every((v, i) => i === 0 || v > bs[i - 1]), bs.join(","));
  check("css: blur scales with the preview (100 at 1280/1920 → 66.6667px; at 0.5 → 50px)",
    blurCss(100) === "blur(66.6667px)" && blurCss(100, 0.5) === "blur(50px)", `${blurCss(100)} / ${blurCss(100, 0.5)}`);
  check("css: previewScaleFor = the compositor buffer cap (1920 → 2/3, 1280 → 1, 3840 → 1/3)",
    near(previewScaleFor(1920, 1080), 2 / 3, 1e-12) && previewScaleFor(1280, 720) === 1 && near(previewScaleFor(1080, 3840), 1 / 3, 1e-12));
  // Look effects with a CSS proxy.
  const css1 = (type: string, extra: Partial<VisualEffect> = {}) => colorFilter(undefined, undefined, [fx(type, extra)], 1);
  check("css: exposure +1 EV → brightness(2) (the export's x·2^EV)", css1("exposure", { amount: 1 }) === "brightness(2)", css1("exposure", { amount: 1 }));
  check("css: exposure -1 EV → brightness(0.5)", css1("exposure", { amount: -1 }) === "brightness(0.5)");
  check("css: exposure 0 → brightness(1); default stored effect = +0.5 EV", css1("exposure", { amount: 0 }) === "brightness(1)" && css1("exposure") === `brightness(${Math.round(2 ** 0.5 * 10000) / 10000})`, css1("exposure"));
  // Black level: brightness(m) contrast(c) must equal k·x − k·b on the encoded value.
  {
    const m = /brightness\(([\d.]+)\) contrast\(([\d.]+)\)/.exec(css1("exposure", { amount: 1, params: { black: 0.1 } }));
    const k = 1 / (0.5 - 0.1);
    const apply = (x: number) => (Number(m?.[2]) * (Number(m?.[1]) * x - 0.5) + 0.5);
    check("css: exposure with black level = FFmpeg's (x − b)/(2^-EV − b) via brightness+contrast",
      !!m && [0.2, 0.5, 0.7].every((x) => near(apply(x), k * x - k * 0.1, 1e-3)), css1("exposure", { amount: 1, params: { black: 0.1 } }));
  }
  check("css: exposure amount clamps to ±3 EV", css1("exposure", { amount: 9 }) === "brightness(8)", css1("exposure", { amount: 9 }));
  check("css: vibrance → saturate (0 = 1, +1 = 1.75, -1 = 0.2, -2 floors at 0)",
    css1("vibrance", { amount: 0 }) === "saturate(1)" && css1("vibrance", { amount: 1 }) === "saturate(1.75)" &&
    css1("vibrance", { amount: -1 }) === "saturate(0.2)" && css1("vibrance", { amount: -2 }) === "saturate(0)",
    [0, 1, -1, -2].map((a) => css1("vibrance", { amount: a })).join(" "));
  check("css: invert → invert(1)", css1("invert") === "invert(1)");
  check("css: exposure + invert + vibrance stack in order",
    colorFilter(undefined, undefined, [fx("exposure", { amount: 1 }), fx("invert"), fx("vibrance", { amount: 1 })], 1) === "brightness(2) invert(1) saturate(1.75)");
  check("css: bypassed look effects add nothing", css1("invert", { enabled: false }) === "none" && css1("exposure", { amount: 1, enabled: false }) === "none");
  check("css: every CSS proxy documents its accuracy (note)",
    EFFECTS.every((e) => e.preview === "export-only" || !e.preview.css || !!e.preview.note));
  check("css: grayscale + sepia in stack order",
    colorFilter(undefined, undefined, [fx("grayscale"), fx("sepia")]) === "grayscale(1) sepia(0.85)");
  check("css: export-only effects add nothing (sharpen/pixelate/edges/colorhold/grain/glow/rgbsplit/lens/trails)",
    colorFilter(undefined, undefined, ["sharpen", "pixelate", "edges", "colorhold", "grain", "glow", "rgbsplit", "lens", "trails"].map((t) => fx(t))) === "none");
  check("css: vignette is no longer a contrast/brightness hack", colorFilter(undefined, undefined, [fx("vignette")]) === "none");
  check("css: bypassed effects are skipped",
    colorFilter({ brightness: 0.1 }, undefined, [fx("blur", { amount: 10, enabled: false }), fx("grayscale")]) === "brightness(1.1) grayscale(1)",
    colorFilter({ brightness: 0.1 }, undefined, [fx("blur", { amount: 10, enabled: false }), fx("grayscale")]));
  check("css: enabled:true counts as on", colorFilter(undefined, undefined, [fx("sepia", { enabled: true })]) === "sepia(0.85)");

  // Vignette pass: angles from the registry (amount 1 = PI/5), bypass + amount 0 drop it.
  const angles = vignetteAngles([fx("vignette"), fx("vignette", { amount: 2 }), fx("vignette", { amount: 0 }), fx("vignette", { amount: 1.5, enabled: false })]);
  check("vignette: default and amount 2 → [PI/5, 2·PI/5]; amount 0 and bypassed dropped",
    angles.length === 2 && near(angles[0], Math.PI / 5, 1e-9) && near(angles[1], (2 * Math.PI) / 5, 1e-9), JSON.stringify(angles));
  check("vignette: falloff = FFmpeg's cos⁴ (centre 1, corner at PI/5 ≈ 0.428)",
    vignetteFactor(0, Math.PI / 5) === 1 && near(vignetteFactor(1, Math.PI / 5), Math.cos(Math.PI / 5) ** 4, 1e-12) && vignetteFactor(1.01, 1) === 0);

  // Every registry entry has a preview story: css, key, a canvas pass, or export-only.
  const noStory = EFFECTS.filter((e) => e.preview !== "export-only" && !e.preview.css && !e.preview.key && !e.preview.pass).map((e) => e.type);
  check("registry: every effect has css / key / pass, or is export-only", noStory.length === 0, noStory.join(","));
  check("registry: Render-exact badge set = the old six + colorhold and the style effects",
    EFFECTS.filter((e) => exactOnly(e.type)).map((e) => e.type).join(",") === "sharpen,detail,denoise,edges,posterize,pixelate,colorhold,grain,glow,rgbsplit,lens,trails",
    EFFECTS.filter((e) => exactOnly(e.type)).map((e) => e.type).join(","));
  check("registry: colorhold takes a colour but no 'auto' (generic swatch, not the key controls)",
    effectByType("colorhold")?.color?.default === "0xFF0000" && effectByType("colorhold")?.color?.auto === false && !isKeyEffect("colorhold"));
  check("registry: the Look category exists and lists exposure, vibrance, invert, colorhold",
    EFFECT_CATEGORIES.includes("Look") && EFFECTS.filter((e) => e.category === "Look").map((e) => e.type).join() === "exposure,vibrance,invert,colorhold");

  // The renderer's key helpers are derived from the registry, not a copy.
  check("keying: KEY_EFFECT_TYPES from the registry's key flag", KEY_EFFECT_TYPES.join(",") === "chromakey,colorkey,lumakey");
  check("keying: KEY_DEFAULTS = registry defaults",
    KEY_EFFECT_TYPES.every((t) => JSON.stringify(KEY_DEFAULTS[t]) === JSON.stringify(defaultsFor(t).params)));
  check("keying: KEY_DEFAULT_COLOR = registry colour defaults",
    KEY_DEFAULT_COLOR.chromakey === "0x00FF00" && KEY_DEFAULT_COLOR.colorkey === effectByType("colorkey")?.color?.default && KEY_DEFAULT_COLOR.lumakey === "");

  // Bypassed keys: no plan when the only key is off; a bypassed first key moves the split.
  check("key: a bypassed key gives no key plan",
    keyPlan({ filters: [fx("chromakey", { color: "0x00FF00", enabled: false })] }) === undefined);
  const kp = keyPlan({ filters: [fx("colorkey", { enabled: false }), fx("grayscale"), fx("lumakey", { params: { threshold: 1 } }), fx("blur", { amount: 5 })] });
  check("key: bypassed key skipped — the plan starts at the next enabled key",
    !!kp && kp.keys.map((k) => k.kind).join() === "lumakey" && kp.pre === "grayscale(1)" && kp.post === "blur(3.3333px)",
    JSON.stringify(kp));
  check("key: params clamped by the registry ranges (similarity 5 → 1)",
    keyPlan({ filters: [fx("chromakey", { params: { similarity: 5 } })] })?.keys[0].similarity === 1);

  // Vignettes split around the first key like the CSS proxy: one before the key
  // darkens the frame the key sees (the export keys the darkened frame, so the
  // dark edge stays opaque); one after it darkens the keyed result.
  const vk = keyPlan({ filters: [fx("vignette"), fx("colorkey"), fx("vignette", { amount: 2 })] });
  check("key: a vignette before the first key → preVignette, one after → postVignette",
    !!vk && vk.preVignette?.length === 1 && near(vk.preVignette[0], Math.PI / 5, 1e-9) &&
      vk.postVignette?.length === 1 && near(vk.postVignette[0], (2 * Math.PI) / 5, 1e-9),
    JSON.stringify(vk));
  const kv = keyPlan({ filters: [fx("colorkey"), fx("vignette")] });
  check("key: [key, vignette] → only postVignette", !!kv && kv.preVignette === undefined && kv.postVignette?.length === 1, JSON.stringify(kv));
  const vOff = keyPlan({ filters: [fx("vignette", { enabled: false }), fx("vignette", { amount: 0 }), fx("colorkey")] });
  check("key: bypassed / amount-0 vignettes before a key → neither field", !!vOff && vOff.preVignette === undefined && vOff.postVignette === undefined,
    JSON.stringify(vOff));
  const noVig = keyPlan({ filters: [fx("grayscale"), fx("chromakey")] });
  check("key: no vignette → no vignette fields in the plan", !!noVig && !("preVignette" in noVig) && !("postVignette" in noVig));

  // The draw plan carries the vignette for clips AND adjustment layers.
  const vProject: Project = {
    ...project,
    tracks: [
      track("video", 0, [clip("VIG", "vidA", 0, 30, { effects: { filters: [fx("vignette", { amount: 1.5 })] } })]),
      track("video", 1, [{ id: "ADJ", adjustment: true, startFrame: 0, sourceInFrame: 0, sourceOutFrame: 30,
        effects: { filters: [fx("vignette"), fx("grayscale")] } } as Clip]),
      track("video", 2, [clip("OFF", "ovl", 0, 30, { effects: { filters: [fx("vignette", { enabled: false })] } })]),
    ],
    music: undefined,
  };
  const vAssets = new Map(vProject.assets.map((a) => [a.id, a]));
  const vPlan = activeLayersAt(vProject, vAssets, 0.1).clips;
  const vig = vPlan.find((c) => c.clipId === "VIG");
  const adj = vPlan.find((c) => c.clipId === "ADJ");
  const offC = vPlan.find((c) => c.clipId === "OFF");
  check("plan: clip vignette angle (1.5 → 0.3·PI)", !!vig?.draw?.vignette && near(vig.draw.vignette[0], 0.3 * Math.PI, 1e-9));
  check("plan: adjustment layer carries vignette + css", !!adj?.adjust?.vignette && adj.adjust.colorFilter === "grayscale(1)");
  check("plan: bypassed vignette → no vignette field", !!offC?.draw && offC.draw.vignette === undefined);

  // A keyed clip: draw.vignette keeps every vignette (the unkeyed fallback);
  // the key plan carries the split the keyed draw uses.
  const kvProject: Project = {
    ...project,
    tracks: [track("video", 0, [clip("KV", "vidA", 0, 30, { effects: { filters: [fx("vignette"), fx("colorkey", { color: "0x808080" })] } })])],
    music: undefined,
  };
  const kvDraw = activeLayersAt(kvProject, new Map(kvProject.assets.map((a) => [a.id, a])), 0.1).clips.find((c) => c.clipId === "KV")?.draw;
  check("plan: [vignette, key] → draw.vignette has it, key.preVignette has it, no postVignette",
    kvDraw?.vignette?.length === 1 && kvDraw.key?.preVignette?.length === 1 && kvDraw.key.postVignette === undefined,
    JSON.stringify({ vignette: kvDraw?.vignette, key: kvDraw?.key }));
}

// ---- blend modes + shape masks flow into the draw plans ----------------------
{
  console.log("\nBlend modes + masks in the plan");
  const mask = { shape: "ellipse", x: 0.3, y: 0.6, w: 0.4, h: 0.5, rotation: 15, feather: 0.1, roundness: 0, invert: true } as const;
  const bmProject: Project = {
    ...project,
    tracks: [
      track("video", 0, [clip("BASE", "vidA", 0, 90)]),
      // A run: R1 multiply → R2 (transition into it) screen: the run uses R1's mode.
      // R3 starts later without a transition: its own mode.
      track("video", 1, [
        clip("R1", "ovl", 0, 30, { effects: { blendMode: "multiply", mask: { ...mask } } }),
        clip("R2", "ovl", 20, 30, { transition: { type: "fade", durationFrames: 10 }, effects: { blendMode: "screen" } }),
        clip("R3", "ovl", 60, 30, { effects: { blendMode: "screen" } }),
      ]),
      track("video", 2, [
        { id: "ADJ2", adjustment: true, startFrame: 0, sourceInFrame: 0, sourceOutFrame: 90,
          effects: { filters: [{ id: "g", type: "grayscale" }], mask: { ...mask, shape: "linear" } } } as Clip,
      ]),
      track("video", 3, [clip("BAD", "ovl", 0, 90, { effects: { blendMode: "normal", mask: { shape: "star" } as never } })]),
      track("audio", 4, [clip("AUD", "vidA", 0, 90, { effects: { blendMode: "screen", mask: { ...mask } } })]),
    ],
    music: undefined,
  };
  const bmAssets = new Map(bmProject.assets.map((a) => [a.id, a]));
  const p25 = activeLayersAt(bmProject, bmAssets, 25 / FPS).clips;
  const r1 = p25.find((c) => c.clipId === "R1");
  const r2 = p25.find((c) => c.clipId === "R2");
  check("plan: blend mode flows into draw.blend", r1?.draw?.blend === "multiply", JSON.stringify(r1?.draw?.blend));
  check("plan: a transition run uses its FIRST clip's mode (R2 → multiply, like the export)", r2?.draw?.blend === "multiply", JSON.stringify(r2?.draw?.blend));
  check("plan: mask params flow into draw.mask (normalized)",
    !!r1?.draw?.mask && r1.draw.mask.shape === "ellipse" && near(r1.draw.mask.x, 0.3, 1e-9) && near(r1.draw.mask.rotation, 15, 1e-9) && r1.draw.mask.invert === true,
    JSON.stringify(r1?.draw?.mask));
  check("plan: a clip without a mask has no draw.mask", !!r2?.draw && r2.draw.mask === undefined);
  const r3 = activeLayersAt(bmProject, bmAssets, 70 / FPS).clips.find((c) => c.clipId === "R3");
  check("plan: a new run uses its own mode", r3?.draw?.blend === "screen");
  const base = p25.find((c) => c.clipId === "BASE");
  check("plan: normal / absent mode → no draw.blend (plain source-over)", !!base?.draw && base.draw.blend === undefined);
  const adj2 = p25.find((c) => c.clipId === "ADJ2");
  check("plan: an adjustment layer's mask flows into adjust.mask", adj2?.adjust?.mask?.shape === "linear", JSON.stringify(adj2?.adjust));
  const bad = p25.find((c) => c.clipId === "BAD");
  check("plan: an invalid stored mask / explicit normal → neither field", !!bad?.draw && bad.draw.mask === undefined && bad.draw.blend === undefined);
  const audC = p25.find((c) => c.clipId === "AUD");
  check("plan: an audio-track clip is never drawn (no blend/mask)", !!audC && audC.draw === undefined);

  // Staging size: power-of-two scale buckets, capped by the source resolution.
  check("maskStageSize: scale 0.5 → half size", JSON.stringify(maskStageSize(960, 540, 0.5, 1920, 1080)) === JSON.stringify({ w: 480, h: 270 }));
  check("maskStageSize: scale 0.7 and 0.9 share a bucket (no per-frame mask rebuild)",
    JSON.stringify(maskStageSize(960, 540, 0.7, 1920, 1080)) === JSON.stringify(maskStageSize(960, 540, 0.9, 1920, 1080)));
  check("maskStageSize: zoom capped at the source resolution", JSON.stringify(maskStageSize(960, 540, 3, 1920, 1080)) === JSON.stringify({ w: 1920, h: 1080 }));

  // Mask handle geometry: a scaled/rotated/flipped layer maps the centre and back.
  const layer = {
    clipId: "X", trackIndex: 1, trackKind: "video", srcTime: 0, rate: 1, gain: 1, overlays: [], graphics: [],
    draw: { opacity: 1, colorFilter: "none", assetWidth: 1920, assetHeight: 1080,
      transform: { x: 0.25, y: -0.1, scale: 0.5, rotation: 90, flipH: true, flipV: false, opacity: 1 } },
  } as unknown as Parameters<typeof layerXform>[0];
  const xf = layerXform(layer, 1280, 720)!;
  const [hx, hy] = maskToCanvas(xf, 0.5, 0.5);
  check("mask handle: the picture centre sits at the transform's translate", near(hx, 1280 * 0.75, 1e-6) && near(hy, 720 * 0.4, 1e-6), `${hx},${hy}`);
  const [qx, qy] = maskToCanvas(xf, 0.8, 0.3);
  // rotation 90° (clockwise): the picture's +x axis points down; flipH mirrors it first.
  // (0.8, 0.3): local (+0.3·1280, −0.2·720) → flipH·0.5 → (−192, −72) → 90° cw → (+72, −192).
  check("mask handle: rotation/flip/scale map the point like drawLayer", near(qx, 1032, 1e-6) && near(qy, 96, 1e-6), `${qx},${qy}`);
  const [bx, by] = canvasToMask(xf, qx, qy);
  check("mask handle: canvas → mask inverts maskToCanvas", near(bx, 0.8, 1e-9) && near(by, 0.3, 1e-9), `${bx},${by}`);
}

console.log(failures === 0 ? "\nPASS — all checks green" : `\nFAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
