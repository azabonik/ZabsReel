// Phase 2 smoke: the pure compositor plan (no DOM, no FFmpeg). Builds a
// synthetic multi-track project and asserts that activeLayersAt() returns the
// right layers, in z-order, with the right source times / opacities, that gaps
// draw nothing, that transitions cross-fade, that hidden tracks aren't drawn
// (but still play audio), and that muted tracks are silent. Also checks the
// renderer's bleep expansion (src/bleeps.ts) against the core original on the
// same inputs (speed, audio slip, trims, fps) and that the plan plays each
// bleep's sound effect where the export does. Speed ramps: the plan's source
// time / rate follow the shared curve (@aive/core/speed), footprints agree
// with core, "mute" ramps are silent, and the ramped bleep mirror == core.
// Then the preview side of the
// effect registry: CSS builders, the vignette pass, bypassed effects, and that
// the renderer's key helpers ARE the registry's. Finally blend modes and shape
// masks: they flow into draw / adjust plans (a transition run uses its first
// clip's mode, as the export), the mask staging size buckets, and the
// mask-handle geometry (maskdraw.ts) round-trips through drawLayer's transform.
// Last, per-clip audio effects: the Web Audio plan (chain, render-only badge
// set, bleeps unaffected, the echo/EQ/compressor specs mirror the FFmpeg
// filters), the linked-audio carrier the inspector edits (also after a split),
// and that the live route starts on the Play gesture (AudioRouter with stubbed
// Web Audio).
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
import { buildSegments, colorFilter, sourceTimeFor, vignetteAngles } from "../src/playback";
import { clipDurationFrames as deskDuration } from "../src/types";
import { clipDurationFrames as coreDuration } from "../../../packages/core/src/types";
import { clipFootprintFrames, clipTimeMap } from "@aive/core/speed";
import { KEY_DEFAULTS, KEY_DEFAULT_COLOR, KEY_EFFECT_TYPES, isKeyEffect, keyPlan } from "../src/keying";
import { canvasToMask, layerXform, maskStageSize, maskToCanvas } from "../src/maskdraw";
import {
  EFFECTS, EFFECT_CATEGORIES, defaultsFor, effectByType, effectGL, exactOnly, gblurParams, posterizeTable, previewFidelity,
  previewScaleFor, vignetteAngle, vignetteFactor,
} from "@aive/core/effects";
import type { AudioEffect, Clip, MediaAsset, Project, Track, VisualEffect } from "../src/types";
import { audioCarrier, audioFxField } from "../src/audiofx";
import { AudioRouter } from "../src/audiograph";
import {
  AUDIO_EFFECTS, audioEffectFilterSteps, audioExactOnly, audioNeedsRender, audioPreviewPlan,
} from "@aive/core/audio-effects";
import { cachedPlan, planLayer, passCount, type PlannedStep } from "../src/gl/plan";
import { drawCount } from "../src/gl/runtime";
import { PlaybackGovernor } from "../src/gl/governor";
import { balanceParams, curveTable, curvesTables, eqTables, hueParams, parseCube, parseCurvePoints, safeCurve } from "../src/gl/color";
import { buildRenderCommand, EXPORT_PROFILE } from "../../../packages/core/src/ffmpeg/graph";

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

// --- speed ramps: the preview maps through the SHARED curve (@aive/core/speed) ---
{
  console.log("\nspeed ramps");
  const ramp = {
    points: [{ src: 1, speed: 1 }, { src: 2.2, speed: 3 }, { src: 3.4, speed: 0.5 }, { src: 4.6, speed: 3 }, { src: 6, speed: 1 }],
    preset: "montage" as const,
  };
  const rc = clip("R", "vidA", 30, 0, { sourceInFrame: 30, sourceOutFrame: 180, effects: { speedRamp: ramp } });
  const pj: Project = { ...project, assets: [vidA], tracks: [track("video", 0, [rc])], music: undefined };
  const pa = new Map(pj.assets.map((a) => [a.id, a]));
  const map = clipTimeMap(rc, FPS);
  let bad = 0;
  for (let i = 0; i < 120; i++) {
    const tl = (map.duration * (i + 0.5)) / 120;
    const p = activeLayersAt(pj, pa, 1 + tl).clips.find((c) => c.clipId === "R");
    if (!p || Math.abs(p.srcTime - map.sourceAt(tl)) > 1e-9 || Math.abs(p.rate - map.speedAt(p.srcTime)) > 1e-9 || !p.ramped) bad++;
  }
  check("ramp: plan srcTime = the curve's sourceAt, rate = its speed there, flagged ramped (120 playheads)", bad === 0, `${bad} bad`);
  const fp = clipFootprintFrames(rc, FPS);
  check("ramp: desktop clipDurationFrames == core's == speed.ts footprint", deskDuration(rc, FPS) === fp && coreDuration(rc as never, FPS) === fp && fp !== 150, `${deskDuration(rc, FPS)} / ${coreDuration(rc as never, FPS)} / ${fp}`);
  check("ramp: timeline length uses the ramped footprint", near(timelineDurationSec(pj), (30 + fp) / FPS, 1e-9));
  const seg = buildSegments([rc], pa, FPS)[0];
  check("ramp: segment end = start + curve duration; scrub maps exactly", near(seg.end - seg.start, map.duration, 1e-9) && near(sourceTimeFor(seg, seg.start + 1.234), map.sourceAt(1.234), 1e-12));
  check("ramp: past the clip end nothing is active", !activeLayersAt(pj, pa, 1 + map.duration + 0.01).clips.some((c) => c.clipId === "R"));
  const plain = activeLayersAt(project, assetById, 10 / FPS).clips.find((c) => c.clipId === "A")!;
  check("constant clip: rate = speed, not flagged ramped", plain.rate === 1 && plain.ramped === undefined);
  // Audio "mute": the picture plays silently and its bleeps are dropped.
  const beepWav: MediaAsset = asset("sfxbeep", { path: "C:/data/sfx/beep-v1.wav", hasVideo: false, duration: 3, builtinSfx: "beep" });
  const muted: Project = {
    ...pj,
    assets: [vidA, beepWav],
    tracks: [track("video", 0, [{ ...rc, effects: { speedRamp: { ...ramp, audio: "mute" }, bleeps: [{ id: "m1", start: 2, end: 2.3 }] } }])],
  };
  const mp = new Map(muted.assets.map((a) => [a.id, a]));
  const mAt = activeLayersAt(muted, mp, 1 + map.timelineAt(2.1)).clips;
  check("ramp audio mute: drawn, silent, no bleep layer", !!mAt.find((c) => c.clipId === "R")?.draw && !mAt.find((c) => c.clipId === "R")?.audio && !mAt.some((c) => c.bleep));
  // Bleep mirror with ramps: renderer == core over ramps × trims × slips × fps.
  const BL: Bleep[] = [
    { id: "r1", start: 1.5, end: 1.9, sound: "beep" },
    { id: "r2", start: 3.3, end: 3.6, sound: "quack" },
    { id: "r3", start: 4.9, end: 5.4, sfxAssetId: "custom" },
  ];
  const customDuration = (id: string) => (id === "custom" ? 0.7 : undefined);
  let cmp = 0;
  let mis = 0;
  for (const fps of [30, 24, 29.97]) {
    for (const pts of [ramp.points, [{ src: 0, speed: 0.2 }, { src: 8, speed: 9 }], [{ src: 3, speed: 2.5 }]]) {
      for (const slip of [0, -10, 14]) {
        for (const [inS, outS] of [[1, 6], [1.7, 5.2], [0, 7]] as const) {
          const c = { startFrame: 41, sourceInFrame: Math.round(inS * fps), sourceOutFrame: Math.round(outS * fps), audioOffsetFrames: slip || undefined, effects: { speedRamp: { points: pts }, bleeps: BL } };
          const mine = expandBleeps(c, fps, customDuration);
          const core = coreExpand(c, fps, customDuration);
          cmp++;
          const m2 = clipTimeMap(c, fps);
          const same =
            mine.length === core.length &&
            mine.every((l, i) => ["srcStart", "srcEnd", "start", "windowEnd", "sfxDuration"].every(
              (f) => Math.abs((l as unknown as Record<string, number>)[f]! - (core[i] as unknown as Record<string, number>)[f]!) < 1e-9,
            )) &&
            mine.every((l) => near(l.start, (41 + slip) / fps + m2.timelineAt(l.srcStart), 1e-9));
          if (!same) mis++;
        }
      }
    }
  }
  check(`ramp: renderer expandBleeps == core on ${cmp} ramped variants, windows on the curve`, mis === 0, `${mis} mismatch(es)`);
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
  check("css: effects without a CSS proxy add nothing (sharpen/pixelate/edges/colorhold/grain/glow/rgbsplit/lens/trails)",
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

  // Every registry entry has a preview story: css, key, a canvas pass, gl, or export-only.
  const noStory = EFFECTS.filter((e) => e.preview !== "export-only" && !e.preview.css && !e.preview.key && !e.preview.pass && !e.preview.gl).map((e) => e.type);
  check("registry: every effect has css / key / pass / gl, or is export-only", noStory.length === 0, noStory.join(","));
  check("registry: no effect is Render-exact-only any more (all have a WebGL2 path)", EFFECTS.every((e) => !exactOnly(e.type)));
  check("registry: without WebGL2 the Render-exact badge set = the GL-only effects + keys",
    EFFECTS.filter((e) => previewFidelity(e.type, false) === "none").map((e) => e.type).join(",") ===
      "sharpen,detail,denoise,edges,posterize,pixelate,chromakey,colorkey,lumakey,colorhold,grain,glow,rgbsplit,lens,trails",
    EFFECTS.filter((e) => previewFidelity(e.type, false) === "none").map((e) => e.type).join(","));
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

// --- audio effects: the per-clip Web Audio plan (audiograph.ts plays it) ------
{
  console.log("\naudio effects (Web Audio plan)");
  const afx = (id: string, type: string, extra: Partial<AudioEffect> = {}): AudioEffect => ({ id, type, ...extra });
  const STACK: AudioEffect[] = [
    afx("hp", "highpass", { params: { frequency: 100 } }),
    afx("nr", "noise_reduction"),
    afx("eq", "eq_presence", { params: { gain: 6 } }),
    afx("ec", "echo", { enabled: false }),
    afx("tel", "telephone"),
  ];
  const sfxWav: MediaAsset = asset("sfxbeep", { path: "C:/data/sfx/beep-v1.wav", hasVideo: false, duration: 3, builtinSfx: "beep" });
  const aProject: Project = {
    ...project,
    assets: [vidA, aud, sfxWav],
    tracks: [
      track("video", 0, [clip("FX", "vidA", 0, 180, {
        effects: { audioFilters: STACK, bleeps: [{ id: "b1", start: 1.0, end: 1.5, sound: "beep" }], speed: 2 },
      })]),
      track("audio", 0, [clip("DRY", "aud", 0, 180)]),
      track("audio", 1, [clip("ONLYNR", "aud", 0, 180, { effects: { audioFilters: [afx("n2", "noise_reduction")] } })]),
    ],
    music: undefined,
  };
  const aAssets = new Map(aProject.assets.map((a) => [a.id, a]));
  const planAt = (t: number) => activeLayersAt(aProject, aAssets, t).clips;
  const fxClip = planAt(0.2).find((c) => c.clipId === "FX");
  const fxPlan = fxClip?.audio?.fx;
  check("plan: an audible clip with audio effects carries its Web Audio plan", !!fxPlan && fxPlan.nodes.length > 0);
  check("plan: chain = highpass ×2, presence peak, telephone (bypassed echo + render-only NR skipped)",
    fxPlan?.nodes.map((n) => (n.kind === "biquad" ? n.type : n.kind)).join() ===
      "highpass,highpass,peaking,highpass,highpass,lowpass,lowpass,peaking,shaper,gain",
    fxPlan?.nodes.map((n) => (n.kind === "biquad" ? n.type : n.kind)).join());
  check("plan: render-only effects listed for the badge (noise_reduction)", fxPlan?.renderOnly.join() === "noise_reduction");
  check("plan: highpass cutoff = the stored param", fxPlan?.nodes[0]?.kind === "biquad" && fxPlan.nodes[0].frequency === 100);
  check("plan: the plan object is reused frame to frame (no per-frame rebuild)", planAt(0.4).find((c) => c.clipId === "FX")?.audio?.fx === fxPlan);
  check("plan: a clip without audio effects has no fx", !planAt(0.2).find((c) => c.clipId === "DRY")?.audio?.fx);
  const onlyNr = planAt(0.2).find((c) => c.clipId === "ONLYNR")?.audio?.fx;
  check("plan: render-only stack → no live nodes, empty sig (never routed), badge kept",
    !!onlyNr && onlyNr.nodes.length === 0 && onlyNr.sig === "" && onlyNr.renderOnly.join() === "noise_reduction");

  // Bleeps keep working with audio effects present: the mute is in the gain,
  // and the bleep SFX layer is never processed. (Clip at speed 2: source
  // 1.0–1.5 s → timeline 0.5–0.75 s.)
  const inBleep = planAt(0.62);
  check("bleep: the clip's gain is muted inside the bleep with effects present", inBleep.find((c) => c.clipId === "FX")?.audio?.volume === 0);
  const sfx = inBleep.find((c) => c.bleep);
  check("bleep: the SFX layer plays, with no audio effects", !!sfx?.audio && sfx.audio.volume > 0 && !sfx.audio.fx);
  check("bleep: outside the bleep the clip is audible", (planAt(0.3).find((c) => c.clipId === "FX")?.audio?.volume ?? 0) > 0.99);

  // An edit makes a new stack array → a new plan with a new signature.
  const edited = audioFxField([...STACK.slice(0, 2), afx("eq", "eq_presence", { params: { gain: 3 } }), ...STACK.slice(3)]).fx;
  check("plan: editing a param changes the signature (chain rebuilt once)", !!edited && edited.sig !== fxPlan?.sig);
  check("plan: same values → same signature", audioFxField([...STACK]).fx?.sig === fxPlan?.sig);

  // The preview runs the export's maths: echo taps = the aecho delays/decays.
  const echo: AudioEffect[] = [afx("e", "echo", { params: { delay: 300, decay: 0.5 } })];
  const taps = audioPreviewPlan(echo).nodes[0];
  const aecho = audioEffectFilterSteps(echo)[0] ?? "";
  const m = /out_gain=([\d.]+):delays=([\d.|]+):decays=([\d.|]+)/.exec(aecho);
  const outGain = Number(m?.[1]);
  const delays = (m?.[2] ?? "").split("|").map(Number);
  const decays = (m?.[3] ?? "").split("|").map(Number);
  check("echo: preview taps == FFmpeg aecho (delays, decay × out_gain, dry = out_gain)",
    taps?.kind === "taps" && taps.taps.length === delays.length && near(taps.dry, outGain, 1e-6) &&
      taps.taps.every((t, i) => near(t.delay, delays[i]! / 1000, 1e-9) && near(t.gain, outGain * decays[i]!, 1e-6)),
    `${aecho} vs ${JSON.stringify(taps)}`);
  const eqStep = audioEffectFilterSteps([afx("p", "eq_presence", { params: { gain: 5, frequency: 3500 } })])[0];
  const eqNode = audioPreviewPlan([afx("p", "eq_presence", { params: { gain: 5, frequency: 3500 } })]).nodes[0];
  check("eq: preview peaking filter == FFmpeg equalizer (f, Q, gain)",
    eqNode?.kind === "biquad" && eqNode.type === "peaking" && eqStep === `equalizer=f=${(3500).toFixed(6)}:t=q:w=${(1).toFixed(6)}:g=${(5).toFixed(6)}` &&
      eqNode.frequency === 3500 && eqNode.Q === 1 && eqNode.gain === 5, `${eqStep} vs ${JSON.stringify(eqNode)}`);
  const comp = audioPreviewPlan([afx("c", "compressor", { params: { threshold: -20, ratio: 4 } })]).nodes;
  check("compressor: Web Audio's auto makeup is undone ((1/g)^0.6 with g = −15 dB → −9 dB)",
    comp[1]?.kind === "gain" && near(20 * Math.log10(comp[1].gain), -9, 1e-6), JSON.stringify(comp));

  // Registry: every type has a preview story; the render-only set is what the UI badges.
  check("registry: render-only = noise_reduction, de_esser, gate, declick, normalize, pitch, chipmunk, deep, robot",
    AUDIO_EFFECTS.filter((d) => audioExactOnly(d.type)).map((d) => d.type).join() ===
      "noise_reduction,de_esser,gate,declick,normalize,pitch,chipmunk,deep,robot");
  check("registry: enhance_voice previews partly (EQ/compressor) and still badges", !audioExactOnly("enhance_voice") && audioNeedsRender("enhance_voice"));

  // Linked detached audio: the inspector edits the clip that carries the sound.
  const linked: Project = {
    ...project,
    tracks: [
      track("video", 0, [clip("V", "vidA", 0, 60, { linkGroupId: "g", effects: { volume: 0 } })]),
      track("audio", 0, [clip("A", "vidA", 0, 60, { linkGroupId: "g" })]),
    ],
  };
  const v = linked.tracks[0]!.clips[0]!;
  check("carrier: a silenced video clip's sound is its linked audio clip", audioCarrier(linked, v).id === "A");
  check("carrier: an audible clip carries its own sound", audioCarrier(linked, linked.tracks[1]!.clips[0]!).id === "A");
  const unmuted: Project = { ...linked, tracks: [track("video", 0, [clip("V", "vidA", 0, 60, { linkGroupId: "g" })]), linked.tracks[1]!] };
  check("carrier: when the video clip is audible itself, it stays the target", audioCarrier(unmuted, unmuted.tracks[0]!.clips[0]!).id === "V");

  // A split linked pair keeps all four halves in one link group: each video
  // half's sound is the audio half playing the same source, not the first
  // audio clip in the group. (clip() takes source in = 0, so set the right
  // halves' source range explicitly.)
  const half = (id: string, start: number, srcIn: number, extra: Partial<Clip> = {}) =>
    clip(id, "vidA", start, 60, { linkGroupId: "g", sourceInFrame: srcIn, sourceOutFrame: srcIn + 60, ...extra });
  const split: Project = {
    ...project,
    tracks: [
      track("video", 0, [half("VL", 0, 0, { effects: { volume: 0 } }), half("VR", 60, 60, { effects: { volume: 0 } })]),
      track("audio", 0, [half("AL", 0, 0), half("AR", 60, 60)]),
    ],
  };
  const [vl, vr] = split.tracks[0]!.clips;
  check("carrier: after a split the RIGHT video half's sound is the right audio half", audioCarrier(split, vr!).id === "AR", audioCarrier(split, vr!).id);
  check("carrier: after a split the left video half's sound is the left audio half", audioCarrier(split, vl!).id === "AL", audioCarrier(split, vl!).id);
  // Audio halves slid 40 frames later: the right video overlaps the LEFT audio
  // half more on the timeline, but the right audio half plays its source.
  const slid: Project = {
    ...split,
    tracks: [split.tracks[0]!, track("audio", 0, [half("AL", 40, 0), half("AR", 100, 60)])],
  };
  check("carrier: source overlap beats timeline overlap (slid audio halves)", audioCarrier(slid, slid.tracks[0]!.clips[1]!).id === "AR");
  const rightSilenced: Project = {
    ...split,
    tracks: [split.tracks[0]!, track("audio", 0, [half("AL", 0, 0), half("AR", 60, 60, { effects: { volume: 0 } })])],
  };
  check("carrier: never the other half — a silenced right audio half leaves the right video as its own target",
    audioCarrier(rightSilenced, rightSilenced.tracks[0]!.clips[1]!).id === "VR");
}

// --- the live audio route starts on the Play gesture (audiograph.ts) ---------
{
  console.log("\naudio route (AudioRouter, stubbed Web Audio)");
  // Minimal stand-ins: any node accepts params/connect; the context counts creations.
  const node = (): any => {
    const store: Record<string, unknown> = {};
    return new Proxy(store, {
      get(t, k: string) {
        if (k === "connect") return (n: unknown) => n;
        if (k === "disconnect" || k === "start" || k === "stop") return () => {};
        if (!(k in t)) t[k] = { value: 0, setTargetAtTime() {} };
        return t[k];
      },
      set(t, k: string, v) { t[k] = v; return true; },
    });
  };
  let created = 0;
  class FakeAudioContext {
    state = "running";
    currentTime = 0;
    destination = node();
    constructor() { created++; }
    resume() { this.state = "running"; return Promise.resolve(); }
    close() { this.state = "closed"; return Promise.resolve(); }
  }
  const ctxProto = FakeAudioContext.prototype as unknown as Record<string, () => unknown>;
  for (const m of ["createMediaElementSource", "createGain", "createBiquadFilter", "createDynamicsCompressor", "createWaveShaper", "createDelay", "createOscillator"]) ctxProto[m] = node;
  const g = globalThis as unknown as Record<string, unknown>;
  const listeners: Record<string, Array<() => void>> = {};
  g.window = { addEventListener: (t: string, f: () => void) => (listeners[t] ??= []).push(f), removeEventListener() {} };
  g.AudioContext = FakeAudioContext;
  const tel = audioPreviewPlan([{ type: "telephone" }]);
  const el = () => ({ muted: true, volume: 0.5 }) as unknown as HTMLMediaElement;

  const before = new AudioRouter();
  check("route: no gesture yet → the element is never routed (a suspended context would silence it)", !before.route(el(), tel) && created === 0);

  // Play pressed on a plain clip (nothing wants a chain yet), then the playhead
  // runs into a telephone clip: the context made in the gesture must be there.
  created = 0;
  const router = new AudioRouter();
  router.unlock(); // doPlay's gesture, before any clip asked for a chain
  check("route: the Play gesture creates the context even before an effect clip is reached", created === 1);
  const e1 = el();
  check("route: an effect clip reached during playback is routed (not played dry)", router.route(e1, tel) && router.isRouted(e1));
  created = 0;
  const viaClick = new AudioRouter();
  for (const f of listeners.pointerdown ?? []) f();
  check("route: any click/key unlocks too", created >= 1 && viaClick.route(el(), tel));
  delete g.window;
  delete g.AudioContext;
}

// ---- the WebGL2 preview pipeline: pass plans, uniforms, fidelity, colour maths ----
{
  console.log("\nWebGL2 preview pipeline (pure parts)");
  const f = (type: string, extra: Partial<VisualEffect> = {}): VisualEffect => ({ id: `${type}-${Math.random()}`, type, ...extra });
  const g1 = { k: 1, w: 1920, h: 1080, cw: 1920, ch: 1080 };
  const kinds = (steps: PlannedStep[]) => steps.map((s) => s.kind).join(",");

  // Order = the export's: eq → colorbalance → hue → curves → lut3d → effects in stack order.
  const look = {
    color: { contrast: 1.2 },
    grade: { temperature: 0.2, hue: 30, curve: "0/0 0.5/0.6 1/1" },
    lut: "/luts/teal.cube",
    filters: [f("blur", { amount: 5 }), f("colorkey", { enabled: false }), f("vignette"), f("chromakey"), f("sharpen"), f("grain", { amount: 0 })],
  };
  const steps = planLayer(look, g1);
  check("plan: colour grade first (eq, colorbalance, hue, curves, lut3d), then the effects in stack order",
    kinds(steps) === "eq,colorbalance,hue,curves,lut3d,blur,vignette,chromakey,sharpen", kinds(steps));
  check("plan: a bypassed effect and an inactive one (grain 0, like its empty builder) are left out", !kinds(steps).includes("colorkey") && !kinds(steps).includes("grain"));
  check("plan: keys stay at their stack position (between effects), marked as keys",
    steps.findIndex((s) => s.kind === "chromakey") === 7 && steps[7].key === true && steps[6].kind === "vignette");
  check("plan: the eyedropper bypass drops only the keys", kinds(planLayer(look, g1, { skipKeys: true })) === "eq,colorbalance,hue,curves,lut3d,blur,vignette,sharpen");
  check("plan: no mask / blend / transform passes (those stay on the Canvas2D side, after the look)",
    !steps.some((s) => /mask|blend|transform|opacity/.test(s.kind)));
  check("plan: vignette is a GL pass at its stack position (replaces the canvas pass)", steps[6].passes.length === 1 && steps[6].passes[0].out === "rgb");
  check("plan: blur = 4 passes (rows causal/anticausal, columns), float between, 8-bit out",
    steps[5].passes.length === 4 && steps[5].passes.slice(0, 3).every((p) => p.float) && !steps[5].passes[3].float);
  check("plan: an empty look plans nothing (the layer skips the GL path)", planLayer({}, g1).length === 0 && planLayer(undefined, g1).length === 0);
  check("plan: an unknown effect type is skipped", planLayer({ filters: [f("nope")] }, g1).length === 0);
  check("plan: passCount sums every pass (sharpen = 2: separable rows, then columns)", passCount(steps) === 1 + 1 + 1 + 1 + 1 + 4 + 1 + 1 + 2, String(passCount(steps)));
  // Fusion (runtime.ts): per-pixel ops ride in the pass before them, so the
  // whole grade + the placement is one draw, the vignette rides on the blur's
  // last pass, and only neighbourhood passes cost a draw of their own.
  check("fusion: placement + eq/colorbalance/hue/curves/lut3d = 1 draw; blur 4; vignette fused; chromakey 1; sharpen 2 → 8 draws",
    drawCount(steps) === 8, String(drawCount(steps)));
  check("fusion: a pure per-pixel look (exposure, vibrance, vignette, colorhold) is a single draw",
    drawCount(planLayer({ filters: [f("exposure"), f("vibrance"), f("vignette"), f("colorhold")] }, g1)) === 1);
  check("fusion: the same op twice can't share a draw (its uniforms would collide)",
    drawCount(planLayer({ filters: [f("invert"), f("invert")] }, g1)) === 2);
  check("fusion: no look → the placement alone", drawCount([]) === 1);
  const c1 = cachedPlan(look, g1);
  check("plan cache: same look object + geometry → the same steps (no per-frame rebuild)", cachedPlan(look, g1) === c1);
  check("plan cache: a new processing scale re-plans", cachedPlan(look, { ...g1, k: 0.5, w: 960, h: 540 }) !== c1);

  // Uniform builders: FFmpeg's parameter maths, pixel sizes scaled to the preview.
  const bp = gblurParams(8)!;
  const lam = Math.fround(64) / 2;
  const dnu = (1 + 2 * lam - Math.sqrt(1 + 4 * lam)) / (2 * lam);
  check("blur: gblur's nu / boundary / postscale for sigma 8", bp.nu === Math.fround(dnu) && bp.bscale === Math.fround(1 / (1 - dnu)) &&
    bp.postscale === Math.fround(Math.fround(dnu / lam) ** 2) && bp.taps > 10 && bp.taps < 200, JSON.stringify(bp));
  check("blur: sigma 0 → no recursion (gblur passes through) and the step is inactive",
    gblurParams(0) === null && planLayer({ filters: [f("blur", { amount: 0 })] }, g1).length === 0);
  const blurAt = (k: number) => planLayer({ filters: [f("blur", { amount: 12 })] }, { ...g1, k }).at(0)!.passes[0].uniforms.u_nu;
  check("blur: sigma scales with the processing scale (k 2/3 → sigma 8)", blurAt(2 / 3) === gblurParams(8)!.nu && blurAt(1) === gblurParams(12)!.nu);
  const rs = (k: number) => planLayer({ filters: [f("rgbsplit", { amount: 10, params: { angle: 90 } })] }, { ...g1, k })[0].passes[0].uniforms.u_shift as number[];
  check("rgbsplit: the builder's integer offset, scaled to the preview", rs(1).join() === "0,10" && rs(0.5).join() === "0,5", `${rs(1)} / ${rs(0.5)}`);
  const sh = planLayer({ filters: [f("sharpen", { amount: 1.5 })] }, g1)[0].passes[1].uniforms.u_amount;
  check("sharpen: unsharp's Q16 amount (separable: row sums, then columns + sharpen)", sh === 98304, String(sh));
  const pz = planLayer({ filters: [f("posterize", { amount: 4 })] }, g1)[0].passes[0].uniforms.u_lut256 as number[];
  check("posterize: lutrgb's table = (int)(round(v/255·L)/L·255), L = levels − 1",
    pz.length === 256 && pz[0] === 0 && pz[255] === 255 && pz[128] === 170 && JSON.stringify(pz) === JSON.stringify(posterizeTable({ type: "posterize", amount: 4 })));
  const px = planLayer({ filters: [f("pixelate", { amount: 16 })] }, g1)[0].passes[0].uniforms;
  check("pixelate: swscale point-sampling increments for 1920 → 120 blocks → 1920",
    (px.u_inc1 as number[])[0] === Math.floor((1920 * 65536 + 60) / 120) && (px.u_inc2 as number[])[0] === Math.floor((120 * 65536 + 960) / 1920) &&
    px.u_cinc1 === Math.floor((960 * 65536 + 60) / 120), JSON.stringify(px));
  const ck = planLayer({ filters: [f("chromakey", { color: "0x00FF00", params: { despill: 0.5 } })] }, g1)[0].passes[0].uniforms;
  check("chromakey: the key's U/V from FFmpeg's own macro (green → 44, 21), despill on the green screen",
    (ck.u_key as number[]).join() === "44,21" && (ck.u_spill as number[])[1] === 1 && (ck.u_spill as number[])[0] === Math.fround(0.5), JSON.stringify(ck));
  const lk = planLayer({ filters: [f("lumakey", { params: { threshold: 0.5, tolerance: 0.1, softness: 0.05 } })] }, g1)[0].passes[0].uniforms.u_lkey_band as number[];
  check("lumakey: band = clip8((t∓tol)·255), softness·255 truncated", lk.join() === "102,153,12", lk.join());
  const vg = planLayer({ filters: [f("vignette", { amount: 2 })] }, g1)[0].passes[0].uniforms.u_vig_angle as number;
  check("vignette: the builder's lens angle", Math.abs(vg - vignetteAngle({ type: "vignette", amount: 2 })) < 1e-6);
  check("vignette: amount 0 → no pass (the builder emits nothing)", planLayer({ filters: [f("vignette", { amount: 0 })] }, g1).length === 0);
  const tr = planLayer({ filters: [f("trails")] }, g1)[0];
  check("trails: a history step (float lagfun pass, then unpremultiply)", tr.history === true && tr.passes[0].history === true && tr.passes[0].float === true && tr.passes.length === 2);

  // Fidelity flags (scripts/parity-gl.mts measures them against FFmpeg).
  const fid = (t: string) => effectGL(t)?.fidelity;
  check("fidelity: every effect declares one, with a note", EFFECTS.every((e) => !!effectGL(e.type)?.fidelity && !!effectGL(e.type)?.note));
  check("fidelity: denoise approximate; grain, trails and chromakey close; the rest exact",
    fid("denoise") === "approx" && ["grain", "trails", "chromakey"].every((t) => fid(t) === "close") &&
      EFFECTS.filter((e) => !["denoise", "grain", "trails", "chromakey"].includes(e.type)).every((e) => fid(e.type) === "exact"));
  check("badge: the inspector's '≈' set (approx with WebGL2) = denoise only", EFFECTS.filter((e) => previewFidelity(e.type) === "approx").map((e) => e.type).join() === "denoise");

  // Colour maths vs the strings graph.ts builds for the export.
  const grade = { temperature: 0.4, tint: -0.3, lift: { r: 0.1, b: -0.2 }, gamma: { g: 0.15 }, gain: { r: -0.05, b: 0.9 }, hue: -25.5, curve: "0/0 0.3/0.2 0.7/0.85 1/1", curveG: "0/0.05 1/0.95" };
  const clipFor = (effects: Record<string, unknown>) => ({
    path: "/x/p.png", trackIndex: 0, showVideo: true, startSec: 0, sourceIn: 0, sourceSpan: 1, isImage: true, outDuration: 1, hasAudio: false, muted: false, effects,
  });
  const fc = (effects: Record<string, unknown>) => {
    const cmd = buildRenderCommand([clipFor(effects) as never], { width: 320, height: 180, fps: 30 }, "/tmp/x.mp4", EXPORT_PROFILE, undefined, undefined, { videoOnly: true });
    return cmd.args[cmd.args.indexOf("-filter_complex") + 1];
  };
  const g = fc({ color: { contrast: 1.2, saturation: 0.8 }, grade });
  const cbm = /colorbalance=rs=([-\d.]+):gs=([-\d.]+):bs=([-\d.]+):rm=([-\d.]+):gm=([-\d.]+):bm=([-\d.]+):rh=([-\d.]+):gh=([-\d.]+):bh=([-\d.]+)/.exec(g);
  const cb = balanceParams(grade)!;
  check("colorbalance: the preview's wheels = graph.ts's colorbalance (white balance folded, clamped)",
    !!cbm && [...cb.s, ...cb.m, ...cb.h].every((v, i) => v === Math.fround(Number(cbm[i + 1]))), JSON.stringify({ cb, cbm: cbm?.slice(1) }));
  const hm = /hue=h=([-\d.]+)/.exec(g);
  const hp = hueParams(grade)!;
  const hdeg = Math.fround(Number(hm?.[1])) * Math.PI / 180;
  check("hue: the preview's rotation = graph.ts's hue=h (Q16 cos/sin of the float option)",
    !!hm && hp[0] === Math.round(Math.cos(hdeg) * 65536) && hp[1] === Math.round(Math.sin(hdeg) * 65536), `${hm?.[1]} ${hp}`);
  check("curves: graph.ts emits curves=all then the per-channel curves; the preview folds both",
    g.includes(`curves=all='${safeCurve(grade.curve)}'`) && g.includes(`curves=g='${safeCurve(grade.curveG)}'`) && !!curvesTables(grade));
  // The export pins RGBA after an effect stack (and around an adjustment
  // layer's), so FFmpeg never runs gblur / cas / lenscorrection on the 4:2:0
  // composite's chroma — the preview's model (parity-gl.mts measures it).
  check("export: a clip's effect stack is followed by format=rgba (gblur on full-resolution colour)",
    fc({ filters: [f("blur", { amount: 8 })] }).includes("gblur=sigma=8.000000,format=rgba,setpts="));
  check("export: no pin without an effect stack", !fc({ color: { contrast: 1.2 } }).includes("gamma=1,format=rgba"));
  const adjFc = (() => {
    const base = clipFor({});
    const adj = { ...base, path: "", adjustment: true, trackIndex: 1, effects: { color: { contrast: 1.1 }, filters: [f("detail")] } };
    const cmd = buildRenderCommand([base, adj] as never, { width: 320, height: 180, fps: 30 }, "/tmp/x.mp4", EXPORT_PROFILE, undefined, undefined, { videoOnly: true });
    return cmd.args[cmd.args.indexOf("-filter_complex") + 1];
  })();
  check("export: an adjustment layer's look starts from RGBA and its effects end in it (the stack below is yuv420p)",
    // (color_grade's eq is alphaSafe, which already opens with format=rgba: no second pin.)
    /\[adjs0\]format=rgba,split\[aeq0a\]\[aeq0b\];\[aeq0a\]eq=[^\[]+\[aeq0v\];.*alphamerge,format=rgba,cas=strength=0\.500000,format=rgba\[adjf0\]/.test(adjFc) &&
      !adjFc.includes("format=rgba,format=rgba"), adjFc.slice(adjFc.indexOf("[adjs0]"), adjFc.indexOf("[adjf0]") + 7));
  check("eq: graph.ts emits eq for any `color`, so does the plan (even neutral)", g.includes("eq=brightness=0:contrast=1.2:saturation=0.8:gamma=1") &&
    planLayer({ color: {} }, g1).map((s) => s.kind).join() === "eq");
  check("no grade step when the wheels/white balance are neutral and no hue (like colorGradeSteps)",
    balanceParams({ lift: { r: 0.00001 } }) === null && hueParams({ hue: 0 }) === null && !fc({ grade: { lift: { r: 0.00001 }, hue: 0 } }).includes("colorbalance"));

  const eq = eqTables({ contrast: 1.2, brightness: 0.1, saturation: 0.8 });
  const C = Math.trunc(1.2 * 4096);
  const B = Math.trunc((Math.trunc(110) * 511) / 200) - 128 - Math.trunc(C / 32);
  check("eq: luma table = vf_eq.c process_c ((v·C) >> 12) + B, clipped", eq[100 * 4] === ((100 * C) >> 12) + B && eq[0] === Math.max(0, B) && eq[255 * 4] === 255);
  const Cs = Math.trunc(0.8 * 4096);
  check("eq: U/V tables use saturation as their contrast (brightness 0)", eq[200 * 4 + 1] === ((200 * Cs) >> 12) + (Math.trunc(100 * 511 / 200) - 128 - Math.trunc(Cs / 32)));
  check("eq: parameters are float-rounded first, like vf_eq.c's av_clipf (brightness 0.35 → (int)134.99… = 134 → Y 0 → 86; −0.15 → Y 255 → 213)",
    eqTables({ brightness: 0.35 })[0] === 86 && eqTables({ brightness: -0.15 })[255 * 4] === 213,
    `${eqTables({ brightness: 0.35 })[0]} / ${eqTables({ brightness: -0.15 })[255 * 4]}`);
  const ident = eqTables({});
  check("eq: neutral eq = identity tables", Array.from({ length: 256 }, (_, i) => ident[i * 4] === i && ident[i * 4 + 1] === i).every(Boolean));
  const gam = eqTables({ gamma: 2 });
  check("eq: gamma uses the double-precision LUT (256·v^(1/gamma), truncated)", gam[64 * 4] === Math.trunc(256 * Math.pow(64 / 255, 0.5)));

  const idc = curveTable(parseCurvePoints("0/0 1/1")!);
  check("curves: identity points → identity, except where FFmpeg's double → int truncation drops a level (as the export does)",
    idc.every((v, i) => v === i || v === i - 1) && idc[0] === 0 && idc[255] === 255 && idc.filter((v, i) => v !== i).length < 40);
  const sc = curveTable(parseCurvePoints("0/0 0.25/0.18 0.75/0.85 1/1")!);
  check("curves: an S-curve passes through its points and stays monotonic", sc[0] === 0 && sc[255] === 255 && Math.abs(sc[63] - 0.18 * 255) <= 2 && sc.every((v, i) => i === 0 || v >= sc[i - 1]));
  check("curves: points FFmpeg rejects (out of range / not increasing) → no table", parseCurvePoints("0/0 1.5/1") === null && parseCurvePoints("0.5/0 0.5/1") === null);
  check("curves: missing end points pad flat (no auto-inserted 0/0, 1/1)", curveTable(parseCurvePoints("0.2/0.3 0.8/0.6")!)[0] === Math.trunc(0.3 * 255) && curveTable(parseCurvePoints("0.2/0.3 0.8/0.6")!)[255] === Math.trunc(0.6 * 255));

  const cube = parseCube(['TITLE "t"', "# c", "LUT_3D_SIZE 2", "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1",
    "0 0 0", "1 0 0", "0 1 0", "1 1 0", "0 0 1", "1 0 1", "0 1 1", "1 1 1"].join("\n"));
  check(".cube: size, red-fastest data, domain scale", !!cube && cube.size === 2 && cube.data[3] === 1 && cube.data[4] === 0 && cube.data[6 * 3 + 1] === 1 && cube.scale.join() === "1,1,1");
  check(".cube: lines before LUT_3D_SIZE ignored, a 1D or short table rejected (lut3d fails it too)",
    parseCube("LUT_1D_SIZE 2\n0 0 0\n1 1 1\n") === null && parseCube("LUT_3D_SIZE 2\n0 0 0\n") === null && parseCube("LUT_3D_SIZE 2\n0 0\n") === null);
  const halfDomain = parseCube(["LUT_3D_SIZE 2", "DOMAIN_MAX 2 2 2", ...Array(8).fill("0.5 0.5 0.5")].join("\n"));
  check(".cube: DOMAIN_MAX 2 → lut3d's input scale 0.5", !!halfDomain && halfDomain.scale.join() === "0.5,0.5,0.5");

  // Playback resolution of the looks (gl/governor.ts).
  const gov = (base: number, max = 4) => new PlaybackGovernor(() => base, () => max);
  const play = (gv: PlaybackGovernor, n: number, dt: number, gl = true) => { for (let i = 0; i < n; i++) gv.frame(dt, gl); return gv.div; };
  const sw = gov(2);
  sw.start("p1");
  check("governor: software playback starts at half resolution and holds it at 30 fps", sw.div === 2 && play(sw, 60, 33) === 2);
  check("governor: frames slower than the budget (8 fps) drop the looks to a quarter, no further", play(sw, 30, 125) === 4 && play(sw, 60, 125) === 4);
  sw.start("p1");
  check("governor: the next play of the same project keeps the quarter; a changed project starts at half again", sw.div === 4 && (sw.start("p2"), sw.div === 2));
  const hw = gov(1, 1);
  hw.start("p");
  check("governor: a GPU (base 1, max 1, as preview.tsx sets it) stays at full resolution, even with slow frames",
    play(hw, 60, 16) === 1 && play(hw, 30, 100) === 1);
  const stepper = gov(1);
  stepper.start("p");
  check("governor: from full resolution, slow frames step to half, then a quarter", play(stepper, 15, 100) === 2 && play(stepper, 15, 100) === 4);
  const nogl = gov(2);
  nogl.start("p");
  check("governor: slow frames without a WebGL look (decoding) change nothing; a warm-up stall after play is ignored",
    play(nogl, 60, 200, false) === 2 && (nogl.frame(900, true), nogl.frame(900, true), nogl.frame(900, true), play(nogl, 20, 20) === 2));

  // The draw / adjust plans carry the look (the effects object itself, so the GL plan caches on it).
  const fxA = { color: { brightness: 0.1 }, filters: [f("glow")] };
  const fxAdj = { filters: [f("vignette")] };
  const lp: Project = {
    ...project,
    tracks: [
      track("video", 0, [clip("L1", "vidA", 0, 30, { effects: fxA }), clip("L2", "vidB", 30, 30)]),
      track("video", 1, [{ id: "ADJL", adjustment: true, startFrame: 0, sourceInFrame: 0, sourceOutFrame: 60, effects: fxAdj } as Clip]),
    ],
    music: undefined,
  };
  const la = new Map(lp.assets.map((a) => [a.id, a]));
  const at0 = activeLayersAt(lp, la, 0.1).clips;
  check("plan: draw.look is the clip's effects object", at0.find((c) => c.clipId === "L1")?.draw?.look === fxA);
  check("plan: adjust.look is the adjustment's effects object", at0.find((c) => c.clipId === "ADJL")?.adjust?.look === fxAdj);
  check("plan: a clip without a look has no draw.look (drawn directly, no GL)", activeLayersAt(lp, la, 1.5).clips.find((c) => c.clipId === "L2")?.draw?.look === undefined);
}

console.log(failures === 0 ? "\nPASS — all checks green" : `\nFAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
