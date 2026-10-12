// Phase 2 smoke: the pure compositor plan (no DOM, no FFmpeg). Builds a
// synthetic multi-track project and asserts that activeLayersAt() returns the
// right layers, in z-order, with the right source times / opacities, that gaps
// draw nothing, that transitions cross-fade, that hidden tracks aren't drawn
// (but still play audio), and that muted tracks are silent. Also checks the
// renderer's bleep expansion (src/bleeps.ts) against the core original on the
// same inputs (speed, audio slip, trims, fps) and that the plan plays each
// bleep's sound effect where the export does.
//
// Run:  npx tsx apps/desktop/scripts/smoke-composite.ts

import { activeLayersAt, timelineDurationSec } from "../src/composite";
import { bleepMuteSpans, expandBleeps } from "../src/bleeps";
import { muteGainAt } from "../src/mutes";
import type { Bleep, Clip, MediaAsset, Project, Track } from "../src/types";
// The core originals the renderer mirrors (run under tsx, which resolves core's .js imports).
import { bleepMuteSpans as coreMuteSpans, expandBleeps as coreExpand } from "../../../packages/core/src/audio/bleeps";
import { muteGainAt as coreMuteGainAt } from "../../../packages/core/src/audio/mutes";

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
  check("key: effects after the first key run on the keyed result", key?.post === "blur(2px)", key?.post);
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

console.log(failures === 0 ? "\nPASS — all checks green" : `\nFAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
