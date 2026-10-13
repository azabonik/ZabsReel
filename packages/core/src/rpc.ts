import { z } from "zod";
import type { EditorEngine } from "./engine.js";
import { clipDurationFrames, clipEndFrame } from "./types.js";
import { WHISPER_MODELS } from "./whisper/setup.js";
import { GRAPHIC_TEMPLATES, GRAPHIC_TEMPLATE_NAMES } from "./motion/templates.js";
import { EXPORT_PRESETS, EXPORT_PRESET_NAMES } from "./ffmpeg/graph.js";
import { EFFECT_TYPE_IDS, describeEffectsForAI, validateEffect } from "./effects/registry.js";
import { BLEND_MODES, MASK_SHAPES, describeBlendModesForAI } from "./effects/compositing.js";
import { AUDIO_EFFECT_TYPE_IDS, describeAudioEffectsForAI, validateAudioEffect } from "./effects/audio.js";
import { RAMP_AUDIO_MODES, RAMP_MAX_POINTS, RAMP_MAX_SPEED, RAMP_MIN_SPEED, RAMP_PRESETS, RAMP_PRESET_DEFS, SPEED_RIPPLE_MODES } from "./speed.js";

/**
 * The RPC surface of the editor. Every editing operation is defined exactly
 * once here as a `{ schema, handler }` pair, then exposed through two
 * transports: the WebSocket server (for the desktop UI) and the MCP server
 * (for the AI). This guarantees the AI and the human drive the *same* engine
 * through the *same* validated commands.
 *
 * The timeline is multi-track and FRAME-BASED. Every position/duration param is
 * an integer count of project frames (the project runs at `fps` frames/sec).
 * Tracks are addressed by `trackIndex` (their stable stacking index); clips by
 * `clipId`. Among video tracks, a higher index composites ON TOP of lower.
 */

export interface RpcMethod<S extends z.ZodTypeAny = z.ZodTypeAny> {
  description: string;
  schema: S;
  handler: (engine: EditorEngine, params: z.infer<S>) => unknown | Promise<unknown>;
}

const empty = z.object({}).strict();

/**
 * Is `value` a color FFmpeg's drawtext/filters accept? That's a named color
 * ("white", "red", "random"), #RRGGBB[AA] / 0xRRGGBB[AA] hex, optionally with an
 * `@alpha` (0..1) suffix (e.g. "black@0.5"). CSS forms like rgb()/rgba()/hsl()
 * are NOT valid here — they don't parse and crash the whole filtergraph at
 * render time with an opaque error, so we reject them up front instead.
 */
function isFfmpegColor(value: string): boolean {
  const [name, alpha, ...rest] = value.trim().split("@");
  if (rest.length > 0 || !name) return false;
  if (alpha !== undefined) {
    const a = Number(alpha);
    if (!Number.isFinite(a) || a < 0 || a > 1) return false;
  }
  // #RRGGBB(AA) or 0xRRGGBB(AA) hex, or a bare color name (letters only).
  return /^(?:#|0x)?[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(name) || /^[a-zA-Z]+$/.test(name);
}

/** A reusable FFmpeg-color string field that rejects CSS colors with a teaching message. */
const colorField = z
  .string()
  .refine(isFfmpegColor, (v) => ({
    message:
      `Invalid color "${v}". Use an FFmpeg color: a name like "white"/"red", ` +
      `#RRGGBB or 0xRRGGBB hex, or name@alpha like "black@0.5". ` +
      `CSS rgb()/rgba()/hsl() are not supported.`,
  }));

/**
 * The open text-styling vocabulary, shared by text overlays and captions. None
 * of it is an enum — the AI composes whatever look it wants. `font` is any
 * installed family name or an absolute path to a .ttf/.otf; colors are FFmpeg
 * colors (a name, #RRGGBB, or name@alpha); `position` is a keyword OR use x/y
 * (0..1 fractions of the frame).
 */
const TEXT_STYLE_FIELDS = {
  position: z.string().optional(),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  font: z.string().optional(),
  fontSize: z.number().int().positive().max(400).optional(),
  color: colorField.optional(),
  outlineColor: colorField.optional(),
  outlineWidth: z.number().min(0).max(40).optional(),
  shadowColor: colorField.optional(),
  shadowX: z.number().min(-40).max(40).optional(),
  shadowY: z.number().min(-40).max(40).optional(),
  box: z.boolean().optional(),
  boxColor: colorField.optional(),
  boxBorderW: z.number().int().min(0).max(200).optional(),
};

const TRANSITION_TYPES = [
  "fade",
  "dissolve",
  "wipeleft",
  "wiperight",
  "wipeup",
  "wipedown",
  "slideleft",
  "slideright",
  "circleopen",
  "circleclose",
  "fadeblack",
  "fadewhite",
  "radial",
  "smoothleft",
  "smoothright",
] as const;

const KEYFRAME_PROPERTIES = ["x", "y", "scale", "rotation", "opacity", "volume"] as const;
/** Built-in bleep sounds (synthesized, see audio/sfx.ts). */
const BLEEP_SOUNDS = ["beep", "quack", "squeak", "boing", "honk"] as const;
const EASE_KINDS = ["linear", "hold", "ease", "easeIn", "easeOut"] as const;

/** How set_clip_speed / set_speed_ramp / clear_speed_ramp move the timeline (engine.changeSpeed). */
const SPEED_RIPPLE_DOC =
  "every clip AFTER it on its track moves by the change in length (sped up: later clips pull in, no black gap; slowed down: they move out, no overlap; gaps and transition overlaps after it are kept). " +
  "LINKED clips that play the same moment on other tracks (its detached audio; a separate mic recording linked to it; a same-footage copy showing the same frame) get the SAME speed / curve (moved by their sync offset on another recording) and the clips after them move by the same amount, so picture and sound stay in sync (one that plays its footage at another constant speed than the clip — the picture is a smooth_slow_motion bake of it — keeps that speed RATIO instead; a speed ramp on such a pair is refused). Called on the detached audio, the linked picture keeps its start and sets the distance. A J-cut head / L-cut tail on the audio changes length with the speed: one that would run into the next clip (or before frame 0) is trimmed to fit, and one that gets shorter leaves a short silence — both listed in splitEdits. Other halves of a split pair, a freeze-frame still and a linked B-roll or cutaway clip on another video track (even from the same footage) keep their speed (a track that holds such a linked clip ripples from the clip's OLD end, see below). A later clip's own linked clips (its detached audio or mic on another track) move with it, with the clips after them. To change only one of a linked pair, unlink_clip first. " +
  "ripple: 'track' (default) = only those tracks — UNLINKED tracks (titles, overlays, music) and markers do NOT move, so re-check them; " +
  "'all' = every other track ripples from the clip's OLD end too and the markers at/after it move (keeps titles, captions, overlays and music cues on the same footage). On a track that ripples from the old end, the clips starting at/after it move, except (listed in notMoved with a reason) one that straddles it and any clip that would break the edit there by moving: entering through a transition from, butted to, or running into a clip that stays, or linked to a clip that stays; " +
  "'none' = the length changes in place and nothing moves (the linked clips still change speed) — for when you place clips yourself. " +
  "Refused (nothing changes): a speed-up that leaves the clip no longer than its transitions (shorten/remove the transition first), and a ripple that would start a clip before frame 0, run a clip into another, break a transition or split a linked pair — the error names the clip and the fix.";
const SPEED_RESULT_DOC =
  "Returns {clip, durationFrames, previousDurationFrames (the clip's length now / before), deltaFrames (how far later clips moved = the picture's change in length; with ripple 'none' nothing moves), shiftedClips (how many moved), shiftedMarkers, linked:[{clipId, trackIndex, startFrame, durationFrames, previousDurationFrames}], notMoved:[{clipId, trackIndex, startFrame, endFrame, reason: straddles|transition|butted|blocked|linked}], splitEdits:[{clipId, trackIndex, side: head|tail, wasFrames, nowFrames (frames it starts before / ends after the picture; negative = inside it), trimmedFrames}]}.";

function summarizeTimeline(engine: EditorEngine) {
  const project = engine.getProject();
  const tracks = [...project.tracks]
    .sort((a, b) => a.index - b.index)
    .map((track) => ({
      trackIndex: track.index,
      kind: track.kind,
      name: track.name,
      muted: track.muted ?? false,
      hidden: track.hidden ?? false,
      locked: track.locked ?? false,
      clips: track.clips.map((clip) => {
        const asset = project.assets.find((a) => a.id === clip.assetId);
        return {
          clipId: clip.id,
          assetId: clip.assetId,
          asset: clip.adjustment ? "(adjustment layer)" : asset?.name ?? "(missing)",
          adjustment: clip.adjustment || undefined,
          startFrame: clip.startFrame,
          durationFrames: clipDurationFrames(clip, project.fps),
          endFrame: clipEndFrame(clip, project.fps),
          sourceInFrame: clip.sourceInFrame,
          sourceOutFrame: clip.sourceOutFrame,
          transition: clip.transition,
          effects: clip.effects ?? undefined,
          // Where each visible bleep lands on the timeline now (ids for set_bleep).
          bleeps: clip.effects?.bleeps?.length
            ? engine.bleepLayers(clip).map((l) => ({
                bleepId: l.bleepId,
                word: l.word,
                sound: l.sfxAssetId ? "custom" : l.sound,
                startFrame: Math.round(l.start * project.fps),
                endFrame: Math.max(Math.round(l.start * project.fps) + 1, Math.round(l.windowEnd * project.fps)),
              }))
            : undefined,
          linkGroupId: clip.linkGroupId,
        };
      }),
    }));
  return {
    name: project.name,
    projectFile: engine.getCurrentPath() ?? null,
    unsavedChanges: engine.isDirty(),
    canvas: { width: project.width, height: project.height, fps: project.fps },
    fps: project.fps,
    totalFrames: engine.timelineDurationFrames(),
    totalDuration: Number(engine.timelineDuration().toFixed(3)),
    trackCount: project.tracks.length,
    // The human↔AI annotation channel: named markers with notes.
    markers: project.markers ?? [],
    tracks,
  };
}

const clipPlacement = {
  trackIndex: z.number().int().min(0).optional(),
  startFrame: z.number().int().min(0).optional(),
  sourceInFrame: z.number().int().min(0).optional(),
  sourceOutFrame: z.number().int().min(0).optional(),
};

export const methods = {
  get_state: {
    description:
      "Return the full current project state (assets, tracks, clips, canvas) plus `recovery` — if a crash-recovery snapshot exists ({available:true, path}), an earlier session ended with unsaved work; offer to restore it via load_project on that path. All timing is in frames.",
    schema: empty,
    handler: (engine) => ({ ...engine.getProject(), recovery: engine.recoveryInfo() }),
  },

  timeline_summary: {
    description:
      "Return a compact, human-readable summary of the multi-track timeline: tracks (with stacking trackIndex, kind, mute/hide/lock), and per-clip frame positions/durations. Prefer this over get_state when reasoning about the edit. Times are in frames; the canvas carries fps.",
    schema: empty,
    handler: (engine) => summarizeTimeline(engine),
  },

  inspect_timeline: {
    description:
      "THE VISION LOOP in one call: returns the timeline_summary (structure, in frames) AND a freshly rendered composited frame image at `atSeconds` (defaults to the midpoint) so you SEE the actual result. Call this after a batch of visual edits to verify structure + look together, then continue or fix.",
    schema: z.object({ atSeconds: z.number().min(0).optional() }).strict(),
    handler: async (engine, p) => ({ summary: summarizeTimeline(engine), frame: await engine.renderFrame(p.atSeconds) }),
  },

  import_video: {
    description:
      "Import a local media file into the project library by absolute path. Probes it with ffprobe and returns its metadata (duration, resolution, fps, audio).",
    schema: z.object({ path: z.string().min(1) }).strict(),
    handler: async (engine, p) => ({ asset: await engine.importVideo(p.path) }),
  },

  remove_asset: {
    description: "Remove an asset from the library and delete any clips that reference it.",
    schema: z.object({ assetId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.removeAsset(p.assetId);
      return { ok: true };
    },
  },

  // ---- tracks ---------------------------------------------------------------
  add_track: {
    description:
      "Add a new track. kind 'video' (stacks on top of existing video tracks — higher trackIndex composites OVER lower) or 'audio'. Returns the new track's trackIndex.",
    schema: z
      .object({ kind: z.enum(["video", "audio"]), name: z.string().optional(), height: z.number().int().positive().optional() })
      .strict(),
    handler: (engine, p) => {
      const t = engine.addTrack(p.kind, { name: p.name, height: p.height });
      return { trackIndex: t.index, id: t.id, kind: t.kind, name: t.name };
    },
  },

  remove_track: {
    description: "Remove a track (and all its clips) by trackIndex. The last video track cannot be removed.",
    schema: z.object({ trackIndex: z.number().int().min(0) }).strict(),
    handler: (engine, p) => {
      engine.removeTrack(p.trackIndex);
      return { ok: true };
    },
  },

  reorder_track: {
    description:
      "Change a track's stacking position (z-order). newIndex is the target slot among tracks; indices are re-packed afterwards. Higher final trackIndex composites on top for video.",
    schema: z.object({ trackIndex: z.number().int().min(0), newIndex: z.number().int().min(0) }).strict(),
    handler: (engine, p) => {
      engine.reorderTrack(p.trackIndex, p.newIndex);
      return { ok: true };
    },
  },

  set_track_properties: {
    description:
      "Update a track: name, muted (drop its audio from the mix), volume (track audio gain multiplier, 1 = unchanged), hidden (exclude its picture from the composite), locked, and display height. Only the fields you pass change. LOCKED protects the track's clips from every edit, yours and the UI's: one that would add, remove, move, trim or change a clip on it — directly or by a ripple (insert, cut, ripple delete, freeze_frame, a speed change, transcript cuts, a linked clip on it) — is refused with an error naming the track, and nothing changes. ripple:'none' (speed tools, freeze_frame) and edits that leave the locked track alone still work; renaming, reordering, removing the track and an fps change are allowed. Unlock it (locked:false) to edit it.",
    schema: z
      .object({
        trackIndex: z.number().int().min(0),
        name: z.string().optional(),
        muted: z.boolean().optional(),
        volume: z.number().min(0).optional(),
        hidden: z.boolean().optional(),
        locked: z.boolean().optional(),
        height: z.number().int().positive().optional(),
      })
      .strict(),
    handler: (engine, p) => {
      const { trackIndex, ...patch } = p;
      const t = engine.setTrackProperties(trackIndex, patch);
      return { trackIndex: t.index, name: t.name, muted: t.muted, volume: t.volume, hidden: t.hidden, locked: t.locked };
    },
  },

  // ---- clip placement -------------------------------------------------------
  add_clip: {
    description:
      "Place a clip on the timeline. Defaults: base (bottom) video track, appended after the last clip, whole asset. Set trackIndex to target a track (e.g. an overlay video track or an audio track), startFrame for an absolute position (gaps allowed), and sourceInFrame/sourceOutFrame to use only part of the asset.",
    schema: z.object({ assetId: z.string(), ...clipPlacement }).strict(),
    handler: (engine, p) => ({ clip: engine.addClip(p.assetId, p) }),
  },

  add_clips: {
    description:
      "Place several clips in one undoable step. Each item is { assetId, trackIndex?, startFrame?, sourceInFrame?, sourceOutFrame? } with the same defaults as add_clip. Use this to lay down a whole sequence or stack overlays at once.",
    schema: z
      .object({
        clips: z
          .array(z.object({ assetId: z.string(), ...clipPlacement }).strict())
          .min(1),
      })
      .strict(),
    handler: (engine, p) => ({ clips: engine.addClips(p.clips) }),
  },

  append_clip: {
    description:
      "Convenience: append a clip to the end of the base video track. Optionally sourceInFrame/sourceOutFrame to use part of the asset. (For positioned/multi-track placement use add_clip.)",
    schema: z
      .object({ assetId: z.string(), sourceInFrame: z.number().int().min(0).optional(), sourceOutFrame: z.number().int().min(0).optional() })
      .strict(),
    handler: (engine, p) => ({ clip: engine.appendClip(p.assetId, p.sourceInFrame, p.sourceOutFrame) }),
  },

  add_adjustment_clip: {
    description:
      "Place an ADJUSTMENT LAYER: a source-less clip whose color grade and effects apply to the COMPOSITE of every video track below it, only while it's active [startFrame, startFrame+durationFrames). Defaults to the topmost video track (grades the whole stack). After placing it, use the normal look tools on its clipId — color_grade, apply_color, apply_lut, apply_effect — and move/trim/split it like any clip. The pro way to grade a whole scene at once instead of per-clip.",
    schema: z
      .object({
        trackIndex: z.number().int().min(0).optional(),
        startFrame: z.number().int().min(0),
        durationFrames: z.number().int().positive(),
      })
      .strict(),
    handler: (engine, p) => ({ clip: engine.addAdjustmentClip(p) }),
  },

  insert_clip: {
    description:
      "Insert a clip at startFrame on a track, rippling later clips on that track to the right by the inserted footprint (nothing is overwritten). Defaults to the base video track.",
    schema: z
      .object({ assetId: z.string(), startFrame: z.number().int().min(0), trackIndex: z.number().int().min(0).optional(), sourceInFrame: z.number().int().min(0).optional(), sourceOutFrame: z.number().int().min(0).optional() })
      .strict(),
    handler: (engine, p) => ({ clip: engine.insertClip(p.assetId, p) }),
  },

  move_clip: {
    description:
      "Move a clip to an absolute startFrame, optionally onto another track (trackIndex). Linked clips move together. Any entering transition on the moved clip is cleared.",
    schema: z.object({ clipId: z.string(), startFrame: z.number().int().min(0), trackIndex: z.number().int().min(0).optional() }).strict(),
    handler: (engine, p) => {
      engine.moveClip(p.clipId, p.startFrame, p.trackIndex);
      return { ok: true };
    },
  },

  move_clips: {
    description: "Move several clips at once. Each item is { clipId, startFrame, trackIndex? }.",
    schema: z
      .object({
        moves: z
          .array(z.object({ clipId: z.string(), startFrame: z.number().int().min(0), trackIndex: z.number().int().min(0).optional() }).strict())
          .min(1),
      })
      .strict(),
    handler: (engine, p) => {
      engine.moveClips(p.moves);
      return { ok: true };
    },
  },

  trim_clip: {
    description: "Re-trim a clip by setting new sourceInFrame and/or sourceOutFrame (frames within the source asset). The clip's start position is unchanged.",
    schema: z
      .object({ clipId: z.string(), sourceInFrame: z.number().int().min(0).optional(), sourceOutFrame: z.number().int().min(0).optional() })
      .strict(),
    handler: (engine, p) => ({ clip: engine.trimClip(p.clipId, p.sourceInFrame, p.sourceOutFrame) }),
  },

  split_clip: {
    description:
      "Split a clip into two at `atFrame`, measured in frames from the clip's start on the timeline. Linked clips split at the same point. Returns the two clip ids and the atFrame used: on a speed-ramped or slowed clip the split moves to where the source frame at that point starts playing (a few frames in a slow section — up to 2 at 0.25x), and at an odd constant speed (0.75x, 1.5x…) up to a frame further so the two halves add up to the clip's length; at 1x, 2x, 3x and 4x it lands exactly on atFrame. The halves always butt and the right half ends where the clip did.",
    schema: z.object({ clipId: z.string(), atFrame: z.number().int().positive() }).strict(),
    handler: (engine, p) => engine.splitClip(p.clipId, p.atFrame),
  },

  cut_range: {
    description:
      "Remove a section [startFrame, endFrame) from within a clip (frames from the clip's start). The footage to the right and all later clips on that track close up (ripple left). The 'cut the boring part' operation. On a speed-ramped or slowed / odd-speed clip each cut moves to where its source frame starts playing (a few frames in a slow section; exact at 1x, 2x, 3x, 4x) and later clips close up by what was really removed. A piece left on either side keeps at least one frame (a one-frame head or tail stays); a side too short to hold one source frame goes with the cut — no gap is ever left.",
    schema: z.object({ clipId: z.string(), startFrame: z.number().int().min(0), endFrame: z.number().int().positive() }).strict(),
    handler: (engine, p) => ({ clips: engine.cutRange(p.clipId, p.startFrame, p.endFrame) }),
  },

  ripple_delete_ranges: {
    description:
      "Delete one or more timeline frame ranges and close the gaps (shift later clips left). Each range is { trackIndex, startFrame, endFrame }. Useful for cutting dead air across the timeline in one pass. The same range on several tracks removes the same frames from each. A range edge inside a speed-ramped or slowed / odd-speed clip moves to where its source frame starts playing (exact at 1x, 2x, 3x, 4x); `ranges` in the result is what was removed, one per requested range (endFrame === startFrame: nothing). A range that touches a LOCKED track is refused.",
    schema: z
      .object({
        ranges: z
          .array(z.object({ trackIndex: z.number().int().min(0), startFrame: z.number().int().min(0), endFrame: z.number().int().positive() }).strict())
          .min(1),
      })
      .strict(),
    handler: (engine, p) => ({ ok: true, ranges: engine.rippleDeleteRanges(p.ranges) }),
  },

  remove_clip: {
    description: "Delete a clip from the timeline (linked clips are removed together).",
    schema: z.object({ clipId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.removeClip(p.clipId);
      return { ok: true };
    },
  },

  link_clips: {
    description:
      "Link clips (e.g. a video clip and its detached audio on another track) so they move/trim/split/delete together. Returns the link group id.",
    schema: z.object({ clipIds: z.array(z.string()).min(2) }).strict(),
    handler: (engine, p) => ({ linkGroupId: engine.linkClips(p.clipIds) }),
  },

  unlink_clip: {
    description: "Unlink a clip (and its whole link group) so they move independently again.",
    schema: z.object({ clipId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.unlinkClip(p.clipId);
      return { ok: true };
    },
  },

  // ---- per-clip effects -----------------------------------------------------
  set_clip_speed: {
    description:
      "Change a clip's CONSTANT playback speed (0.25..4; 1 = normal, 2 = 2x faster, 0.5 = slow motion). Adjusts video, audio and the clip's timeline length, and the timeline RIPPLES like CapCut: " +
      SPEED_RIPPLE_DOC +
      " Clears any speed ramp on the clip (use set_speed_ramp for curve speed). One undo step (speed + ripple). " +
      SPEED_RESULT_DOC,
    schema: z.object({ clipId: z.string(), speed: z.number().min(0.25).max(4), ripple: z.enum(SPEED_RIPPLE_MODES).optional() }).strict(),
    handler: (engine, p) => engine.setClipSpeed(p.clipId, p.speed, { ripple: p.ripple }),
  },

  set_speed_ramp: {
    description:
      `CURVE SPEED (speed ramp, CapCut-style): speed changes smoothly over the clip instead of one constant speed. Either a PRESET generated across the clip's CURRENT used source range — ${RAMP_PRESETS.map((p) => `${p} (${RAMP_PRESET_DEFS[p].description})`).join("; ")} — or custom POINTS [{src, speed}] (speed 0.1..10; src = ASSET seconds, or 0..1 of the clip's used range with normalized:true; speed is linear between points and constant beyond the first/last). ` +
      "The points are anchored in SOURCE time (like bleeps), so the curve FOLLOWS the clip: a trim windows it, a split gives each half its part of the same curve, a reverse mirrors it. The clip's timeline length becomes the integral of 1/speed over its used range, and the timeline RIPPLES like set_clip_speed: " +
      SPEED_RIPPLE_DOC +
      " audio: 'stretch' (default) time-stretches the clip's own sound with pitch preserved, following the curve; 'mute' silences it (and its bleeps; the linked detached audio gets the same mode). Replaces any constant speed (set_clip_speed later clears the ramp). Omit preset and points to change only audio on an existing ramp (the length does not change, nothing moves). Not for still images or adjustment layers; smooth_slow_motion refuses a ramped clip. One undo step (curve + ripple). " +
      SPEED_RESULT_DOC +
      " Verify with get_frame / render_preview.",
    schema: z
      .object({
        clipId: z.string(),
        preset: z.enum(RAMP_PRESETS).optional(),
        points: z
          .array(z.object({ src: z.number(), speed: z.number().min(RAMP_MIN_SPEED).max(RAMP_MAX_SPEED) }).strict())
          .min(1)
          .max(RAMP_MAX_POINTS)
          .optional(),
        normalized: z.boolean().optional(),
        audio: z.enum(RAMP_AUDIO_MODES).optional(),
        ripple: z.enum(SPEED_RIPPLE_MODES).optional(),
      })
      // "preset XOR points" and the src range are checked in the handler / engine: a top-level
      // .refine() would make this a ZodEffects with no `.shape` (MCP registration needs it).
      .strict(),
    handler: (engine, p) => {
      if (p.points?.some((pt: { src: number }) => pt.src < 0 || (p.normalized && pt.src > 1))) {
        throw new Error("Point src must be >= 0 asset seconds (or within 0..1 with normalized:true).");
      }
      return engine.setSpeedRamp(p.clipId, { preset: p.preset, points: p.points, normalized: p.normalized, audio: p.audio, ripple: p.ripple });
    },
  },

  clear_speed_ramp: {
    description:
      "Remove a clip's speed ramp (curve speed): it plays at normal speed (1x) again — its linked detached audio too — and the timeline RIPPLES by the change in length like set_clip_speed (ripple 'track' default / 'all' / 'none', same meaning). One undo step. " +
      SPEED_RESULT_DOC,
    schema: z.object({ clipId: z.string(), ripple: z.enum(SPEED_RIPPLE_MODES).optional() }).strict(),
    handler: (engine, p) => engine.clearSpeedRamp(p.clipId, { ripple: p.ripple }),
  },

  set_clip_volume: {
    description: "Set a clip's audio volume (1 = unchanged, 0 = mute, 1.5 = +50%).",
    schema: z.object({ clipId: z.string(), volume: z.number().min(0) }).strict(),
    handler: (engine, p) => ({ clip: engine.setClipEffects(p.clipId, { volume: p.volume }) }),
  },

  set_clip_fade: {
    description: "Set fade-in and/or fade-out durations (in FRAMES) for a clip. Applies to both video (alpha) and audio.",
    schema: z
      .object({ clipId: z.string(), fadeInFrames: z.number().int().min(0).optional(), fadeOutFrames: z.number().int().min(0).optional() })
      .strict(),
    handler: (engine, p) => ({ clip: engine.setClipEffects(p.clipId, { fadeInFrames: p.fadeInFrames, fadeOutFrames: p.fadeOutFrames }) }),
  },

  color_grade: {
    description:
      "Apply a color grade to a clip. brightness -1..1 (0=unchanged), contrast 0..3 (1=unchanged), saturation 0..3 (1=unchanged), gamma 0.1..10 (1=unchanged).",
    schema: z
      .object({
        clipId: z.string(),
        brightness: z.number().min(-1).max(1).optional(),
        contrast: z.number().min(0).max(3).optional(),
        saturation: z.number().min(0).max(3).optional(),
        gamma: z.number().min(0.1).max(10).optional(),
      })
      .strict(),
    handler: (engine, p) => ({
      clip: engine.setClipEffects(p.clipId, {
        color: { brightness: p.brightness, contrast: p.contrast, saturation: p.saturation, gamma: p.gamma },
      }),
    }),
  },

  crop_clip: {
    description:
      "Crop a clip to a source-pixel rectangle (x, y, width, height), e.g. to reframe widescreen footage for vertical output. Combine with set_project_settings to set the output aspect ratio.",
    schema: z
      .object({ clipId: z.string(), x: z.number().min(0), y: z.number().min(0), width: z.number().positive(), height: z.number().positive() })
      .strict(),
    handler: (engine, p) => ({
      clip: engine.setClipEffects(p.clipId, { crop: { x: p.x, y: p.y, width: p.width, height: p.height } }),
    }),
  },

  apply_lut: {
    description: "Apply a 3D LUT (.cube file, absolute path) to a clip for a cinematic color look. Combine with color_grade for fine-tuning.",
    schema: z.object({ clipId: z.string(), path: z.string().min(1) }).strict(),
    handler: (engine, p) => ({ clip: engine.setClipEffects(p.clipId, { lut: p.path }) }),
  },

  apply_color: {
    description:
      "Apply a RICHER secondary color grade to a clip (runs after color_grade's eq, before any LUT). Only the fields you pass change; wheels are merged channel-by-channel. WHITE BALANCE: temperature -1..1 (+warm/redder, −cool/bluer), tint -1..1 (+magenta, −green). hue = global hue rotation in degrees (-180..180). COLOR WHEELS (3-way corrector), each an object {r,g,b} of -1..1 offsets: lift = shadows, gamma = midtones, gain = highlights (e.g. lift:{b:0.1} lifts shadows toward blue for a teal-shadow look). TONE CURVES as space-separated x/y points in 0..1: curve = master/luma (e.g. '0/0 0.25/0.18 0.75/0.85 1/1' for an S-curve / more contrast); curveR/curveG/curveB = per-channel. Combine with apply_lut for a creative look on top. Use inspect_color afterward to verify objectively.",
    schema: z
      .object({
        clipId: z.string(),
        temperature: z.number().min(-1).max(1).optional(),
        tint: z.number().min(-1).max(1).optional(),
        hue: z.number().min(-180).max(180).optional(),
        lift: z.object({ r: z.number().min(-1).max(1).optional(), g: z.number().min(-1).max(1).optional(), b: z.number().min(-1).max(1).optional() }).strict().optional(),
        gamma: z.object({ r: z.number().min(-1).max(1).optional(), g: z.number().min(-1).max(1).optional(), b: z.number().min(-1).max(1).optional() }).strict().optional(),
        gain: z.object({ r: z.number().min(-1).max(1).optional(), g: z.number().min(-1).max(1).optional(), b: z.number().min(-1).max(1).optional() }).strict().optional(),
        curve: z.string().optional(),
        curveR: z.string().optional(),
        curveG: z.string().optional(),
        curveB: z.string().optional(),
      })
      .strict(),
    handler: (engine, p) => {
      const { clipId, ...grade } = p;
      return { clip: engine.setClipGrade(clipId, grade) };
    },
  },

  apply_effect: {
    description:
      "Add a creative/utility visual EFFECT to a clip (baked as an FFmpeg filter, in stack order, after color). Effects stack — call repeatedly. " +
      "Every type with its controls (ranges, defaults):\n" +
      describeEffectsForAI() +
      "\nValues outside a range are clamped (reported in `adjusted`); an unknown param, or an amount/color the type doesn't take, is rejected with the valid list. " +
      "KEYS make the background transparent so the track BELOW shows through (put the keyed clip on a higher video track); pick the key by background as described above. " +
      "color = the key colour as '0x808080', or 'auto' to sample the clip's frame border (resolved to a concrete hex, returned as `color` with a 0..1 `confidence`; for lumakey 'auto' sets the threshold). " +
      "Keys run after the clip's color grade, so key before grading or re-run 'auto' after. Raise similarity if background speckles remain; lower it if the subject gets holes. Verify with get_frame. " +
      "Pass effectId to UPDATE an existing effect in place (amount/color/params are REPLACED by what you pass — send the full set); an effectId the clip doesn't have is an error — omit effectId to add a new effect. enabled:false BYPASSES an effect (kept, but skipped in export and preview), enabled:true turns it back on; {effectId, type, enabled} alone toggles it without touching its values. " +
      "Returns the effectId (remove_effect deletes it; reorder_effect moves it in the stack).",
    schema: z
      .object({
        clipId: z.string(),
        type: z.enum(EFFECT_TYPE_IDS),
        amount: z.number().optional(),
        color: z.string().optional(),
        params: z.record(z.number()).optional(),
        enabled: z.boolean().optional(),
        effectId: z.string().optional(),
      })
      .strict(),
    handler: async (engine, p) => {
      const v = validateEffect({ type: p.type, amount: p.amount, color: p.color, params: p.params });
      const r = await engine.applyEffectAuto(p.clipId, {
        id: p.effectId, type: p.type, amount: v.amount, color: v.color, params: v.params, enabled: p.enabled,
      });
      return v.adjusted.length ? { ...r, adjusted: v.adjusted } : r;
    },
  },

  remove_effect: {
    description: "Remove one visual effect from a clip by its effectId (from apply_effect). To clear ALL effects/color at once use clear_clip_effects. To keep it but switch it off, use apply_effect with enabled:false.",
    schema: z.object({ clipId: z.string(), effectId: z.string() }).strict(),
    handler: (engine, p) => ({ clip: engine.removeEffect(p.clipId, p.effectId) }),
  },

  reorder_effect: {
    description:
      "Move one visual effect within a clip's effect stack (effects bake in stack order, e.g. blur→key differs from key→blur). toIndex is the effect's new 0-based position (clamped to the stack). One undo step.",
    schema: z.object({ clipId: z.string(), effectId: z.string(), toIndex: z.number().int().min(0) }).strict(),
    handler: (engine, p) => ({ clip: engine.reorderEffect(p.clipId, p.effectId, p.toIndex) }),
  },

  detect_key_color: {
    description:
      "Detect a clip's background/screen colour for keying: samples the outer border of its source frames (in-point and middle) and returns { color: '0xRRGGBB', confidence 0..1 } — confidence is the share of the border matching that colour (near 1 = a flat screen; low = busy edges, so pick the colour another way). Read-only; apply_effect with color 'auto' does this for you.",
    schema: z.object({ clipId: z.string() }).strict(),
    handler: async (engine, p) => {
      const d = await engine.detectKeyColor(p.clipId);
      return { color: d.color, confidence: d.confidence };
    },
  },

  inspect_color: {
    description:
      "Measure the color of the CURRENT composited timeline at `atSeconds` (defaults to the midpoint) — your color EYES. Returns numeric scopes: luma {min,avg,max,contrast}, saturation {avg,max}, hue {avg}, mean rgb {r,g,b} (all 0..255), plus plain-language `notes` (e.g. 'warm color cast', 'low contrast'), AND three rendered scope IMAGES (histogram, waveform, vectorscope) as file paths you can view. Call after color_grade/apply_color/apply_lut to verify the grade objectively instead of guessing.",
    schema: z.object({ atSeconds: z.number().min(0).optional() }).strict(),
    handler: async (engine, p) => engine.inspectColor(p.atSeconds),
  },

  stabilize_clip: {
    description:
      "Stabilize shaky footage in a clip using two-pass analysis (vidstab). Bakes a stabilized copy and re-points the clip at it (other effects preserved; undo restores the original). May take a while for long clips. " +
      "Options: shakiness 1..10 (default 6; how shaky/fast the camera is), accuracy 1..15 (default 15), smoothing 1..100 (default 30; the camera path is smoothed over that many frames before and after each frame, i.e. a window of smoothing×2+1 frames; higher = steadier, slower camera moves), " +
      "zoom 'auto' (default; zoom in just enough to hide the moving borders) | 'none' (no zoom, so the moving borders show) | a fixed percent (e.g. 8), " +
      "crop 'keep' (default; fill the borders from nearby frames) | 'black'.",
    schema: z
      .object({
        clipId: z.string(),
        shakiness: z.number().int().min(1).max(10).optional(),
        accuracy: z.number().int().min(1).max(15).optional(),
        smoothing: z.number().int().min(1).max(100).optional(),
        zoom: z.union([z.enum(["none", "auto"]), z.number().min(-100).max(100)]).optional(),
        crop: z.enum(["keep", "black"]).optional(),
      })
      .strict(),
    handler: async (engine, p) => {
      const { clipId, ...opts } = p;
      return { clip: await engine.stabilizeClip(clipId, opts) };
    },
  },

  auto_reframe: {
    description:
      "Reframe a clip to the project's output aspect ratio (e.g. 16:9 → 9:16) while keeping the main person in frame, using local face tracking (YuNet). Bakes a smoothed moving crop and re-points the clip. Set the project to the target aspect with set_project_settings first. Returns tracking stats (hitRate).",
    schema: z
      .object({
        clipId: z.string(),
        sampleFps: z.number().positive().max(15).optional(),
        smoothing: z.number().min(0.01).max(1).optional(),
        scoreThreshold: z.number().min(0.1).max(0.99).optional(),
      })
      .strict(),
    handler: async (engine, p) => {
      const r = await engine.autoReframe(p.clipId, { sampleFps: p.sampleFps, smoothing: p.smoothing, scoreThreshold: p.scoreThreshold });
      return { clipId: r.clip.id, hitRate: Number(r.hitRate.toFixed(3)), cropWidth: r.cropWidth, cropHeight: r.cropHeight, keyframes: r.keyframes };
    },
  },

  remove_background: {
    description:
      "AI background removal for PEOPLE — a CapCut-style auto cutout, no green screen needed (local Robust Video Matting model). Mattes the clip's used span into a transparent cutout of the person, bakes it, and re-points the clip at it. Transparent areas show the track BELOW: to REPLACE the background, put a color/image/video clip on a LOWER video track under this one; or leave the cutout on top of other footage to composite the person over it. Use ONLY for people / talking-head footage — RVM is a human-matting model and won't cleanly cut out products, cars, animals or objects; for a solid green/blue backdrop use apply_effect chromakey instead, for a gray/white/black or other flat-colour backdrop colorkey (faster and exact). First use downloads a 15 MB model to ~/.aive/models. Slow-ish: on CPU it takes roughly 4–5× the clip's length at 1080p30 (≈2.5× at 720p; a 1-min 1080p clip ≈ 4–5 min). Blocks until done and returns {clipId, assetId, frames, seconds}; for clips longer than ~1 minute pass background:true to get {jobId} immediately, then poll list_jobs / stop with cancel_job. undo restores the original clip. Verify with get_frame.",
    schema: z.object({ clipId: z.string(), background: z.boolean().optional() }).strict(),
    handler: async (engine, p) => {
      if (p.background) {
        const { job } = engine.startRemoveBackgroundJob(p.clipId);
        return { jobId: job.id, status: job.status, label: job.label };
      }
      const r = await engine.removeBackground(p.clipId);
      return {
        clipId: r.clip.id,
        assetId: r.asset.id,
        frames: r.frames,
        seconds: Number(r.seconds.toFixed(1)),
        ...(r.asset.proxyError ? { previewWarning: `Live preview unavailable (${r.asset.proxyError}); export and get_frame are unaffected.` } : {}),
      };
    },
  },

  freeze_frame: {
    description:
      "FREEZE FRAME (CapCut-style): hold one exact frame of a clip for durationSeconds (default 3). atSeconds = TIMELINE seconds inside the clip (0 = its first frame; speed, speed ramps and trim are respected, so it is the frame shown at that moment; on a slowed or ramped clip the cut snaps to a source-frame boundary, which in a slow section can be several timeline frames from atSeconds — e.g. up to 10 at 0.1x; read startFrame from the result). Grabs that frame as a lossless PNG (baked into the data dir), imports it as an image asset, splits the clip there and INSERTS a still clip between the halves. THE TIMELINE RIPPLES (ripple, like set_clip_speed): 'track' (default) = the clip's track shifts right by durationSeconds, and LINKED clips (e.g. a detached audio clip of the same footage) are split at the same point and shifted too, so picture and sound stay aligned (the audio is silent under the freeze); a later clip's own linked clips on other tracks (its detached audio or mic) move with it, together with the clips after them; other clips on UNLINKED tracks (music, overlays) and the markers are not moved. 'all' = every other track also shifts its clips that start at/after the freeze point (a clip straddling it stays) and the markers at/after it move; refused if that would break a transition or split a linked pair. 'none' = nothing moves: the still OVERWRITES the clip from that frame for up to durationSeconds (never past the clip's end, so it can come out shorter — read durationFrames) and the clip continues after it; linked clips are silent under the still. The still keeps the clip's color/filters/crop/transform/opacity and has no audio. atSeconds at/before the start puts the still BEFORE the clip; at/after the end holds the last frame (no empty halves). The held frame is also the first frame of the right half, as in any NLE. If you pass the DETACHED AUDIO clip of a linked pair, the linked picture clip is frozen (a still never goes on an audio track). A freeze point inside the next clip's incoming transition overlap is refused (freeze earlier or remove_transition). One undo step. Returns {stillClipId, assetId, startFrame, durationFrames, shiftedClips, shiftedMarkers}. Verify with get_frame.",
    schema: z
      .object({ clipId: z.string(), atSeconds: z.number().min(0), durationSeconds: z.number().positive().max(600).optional(), ripple: z.enum(SPEED_RIPPLE_MODES).optional() })
      .strict(),
    handler: async (engine, p) => engine.freezeFrame(p.clipId, p.atSeconds, p.durationSeconds ?? 3, { ripple: p.ripple }),
  },

  reverse_clip: {
    description:
      "REVERSE a clip: bakes a backwards copy of the clip's used span (picture, plus audio when audio:'reverse'; audio:'mute' drops the sound) and re-points the clip at it; the timeline duration is unchanged and other effects (speed, color, fades...) are kept; a speed ramp is MIRRORED with the footage (the same moments stay slow/fast). Frame-exact (every frame appears once, in reverse order) and RAM-bounded (processed in chunks of <=2 s and a decoded-frame budget, so clip length does not matter; measured peak ~1.8 GB for 4K60 8-bit instead of 5.8 GB, 1080p well under 1 GB) but it re-encodes (H.264 CRF 18, AAC 192k; a source with transparency, e.g. a remove_background cutout, is baked lossless with its alpha kept), measured ~0.6x the span length on this machine (3 s of 1080p30 in 1.8 s). CALL IT AGAIN on a reversed clip to restore forward playback — that instantly re-points back at the original media (no bake), keeping any trim you made since. LINKED clips that play the same moment (its detached audio, a linked mic recording, a same-footage copy) are REVERSED WITH IT (linked:true, the default), so picture and sound stay matched — called on the detached audio, its picture is reversed too; the clip's own sound still follows audio. Reversing reflects time around the picture's span: a linked clip covering the same span keeps its place, one that starts before the picture (J-cut) ends after it once reversed (L-cut) and vice versa — refused if that would run it into another clip (trim it to the picture, unlink_clip it, or pass linked:false). linked:false reverses only this clip (its detached audio keeps playing forward). Calling it again restores the reversed linked clips too. Not for still images. Blocks until done and returns {clipId, assetId, restored, linked:[{clipId, assetId, startFrame, restored}]}; for clips over ~30 s pass background:true to get {jobId} immediately, then poll list_jobs / stop with cancel_job. One undo step restores the clip and its linked clips (the bakes are new assets).",
    schema: z
      .object({ clipId: z.string(), audio: z.enum(["reverse", "mute"]).optional(), linked: z.boolean().optional(), background: z.boolean().optional() })
      .strict(),
    handler: async (engine, p) => {
      const { job, promise } = engine.startReverseJob(p.clipId, p.audio ?? "reverse", { linked: p.linked });
      if (p.background && job) return { jobId: job.id, status: job.status, label: job.label };
      const r = await promise;
      return { clipId: r.clip.id, assetId: r.asset.id, restored: r.restored, linked: r.linked };
    },
  },

  smooth_slow_motion: {
    description:
      "SMOOTH SLOW MOTION for a clip whose speed is below 1 (set it first with set_clip_speed, e.g. 0.5): instead of repeating frames (stutter), bakes the used span with INTERPOLATED in-between frames so it plays at the project fps like real high-frame-rate footage, then re-points the clip at the bake with speed reset to 1. The timeline duration does NOT change. mode 'optical-flow' (default) = motion-compensated interpolation (minterpolate mci/aobmc) — best quality but SLOW (measured on this machine: ~21x the clip's source length at 1080p30, ~9x at 720p; a 10 s 1080p clip at 0.5x takes ~3.5 min) and it can WARP/smear fast or occluding motion (fast pans, hands crossing, water); mode 'blend' = frame blending (framerate filter) — ~40x faster than optical flow (1.5 s vs 63 s for the same 3 s 1080p clip), ghosting instead of warping, fine for gentle motion. Audio is slowed with a pitch-preserving tempo change. A cutout with transparency keeps its alpha but always uses blend. Refuses when speed >= 1 and on a clip with a speed ramp (bakes a constant slow speed only). LINKED clips stay in sync: its detached audio on the same footage and span is re-pointed at the bake (its slowed, pitch-kept sound) at 1x too, so later speed changes keep them together; any other linked clip (a J/L cut, another recording) keeps its speed and place, and a later set_clip_speed keeps the speed RATIO between them (a speed ramp on such a pair is refused — unlink_clip first). Blocks until done and returns {clipId, assetId, frames, linked: [re-pointed clip ids]}; for anything over a few seconds in optical-flow mode pass background:true to get {jobId} immediately, then poll list_jobs (progress is reported) / cancel_job. undo restores the original clip and speed. Verify with get_frame / render_preview.",
    schema: z
      .object({ clipId: z.string(), mode: z.enum(["blend", "optical-flow"]).optional(), background: z.boolean().optional() })
      .strict(),
    handler: async (engine, p) => {
      const { job, promise } = engine.startSmoothSlowJob(p.clipId, p.mode ?? "optical-flow");
      if (p.background) return { jobId: job.id, status: job.status, label: job.label };
      const r = await promise;
      return { clipId: r.clip.id, assetId: r.asset.id, frames: r.frames, linked: r.linked };
    },
  },

  clear_clip_effects: {
    description:
      "Remove all effects (speed, speed ramp, volume, fades, color, crop, transform, blend mode, mask, visual and audio effects) from a clip. Its bleeps are kept — use remove_bleeps for those. Dropping a speed or speed ramp changes the clip's length: its linked detached audio goes back to 1x too and the timeline ripples like set_clip_speed (ripple 'track' default / 'all' / 'none'). Returns {ok, deltaFrames, shiftedClips, shiftedMarkers, linked, notMoved, splitEdits} (same meaning as set_clip_speed).",
    schema: z.object({ clipId: z.string(), ripple: z.enum(SPEED_RIPPLE_MODES).optional() }).strict(),
    handler: (engine, p) => {
      const r = engine.clearClipEffects(p.clipId, { ripple: p.ripple });
      return { ok: true, deltaFrames: r.deltaFrames, shiftedClips: r.shiftedClips, shiftedMarkers: r.shiftedMarkers, linked: r.linked, notMoved: r.notMoved, splitEdits: r.splitEdits };
    },
  },

  // ---- per-clip transform + keyframe animation ------------------------------
  set_clip_transform: {
    description:
      "Position/scale/rotate a clip's picture within the output canvas (after it's fit to the canvas). x,y = offset as a FRACTION of canvas width/height (0 = centered, +x right, +y down; e.g. x:0.25 nudges a quarter-width right). scale = multiplier (1 = fit, 0.5 = half-size picture-in-picture, 2 = zoom in). rotation = degrees clockwise. flipH/flipV = mirror. opacity = 0..1. Only the fields you pass change; omitted fields keep their stored value. Pass null for a field to RESET it to default, or reset:true to reset the whole transform and opacity. Combine with set_keyframes to ANIMATE any of x/y/scale/rotation/opacity over time.",
    schema: z
      .object({
        clipId: z.string(),
        x: z.number().nullable().optional(),
        y: z.number().nullable().optional(),
        scale: z.number().min(0.01).max(16).nullable().optional(),
        rotation: z.number().nullable().optional(),
        flipH: z.boolean().nullable().optional(),
        flipV: z.boolean().nullable().optional(),
        opacity: z.number().min(0).max(1).nullable().optional(),
        reset: z.boolean().optional(),
      })
      .strict(),
    handler: (engine, p) => ({
      clip: engine.setClipTransform(p.clipId, {
        transform: { x: p.x, y: p.y, scale: p.scale, rotation: p.rotation, flipH: p.flipH, flipV: p.flipV },
        opacity: p.opacity,
        reset: p.reset,
      }),
    }),
  },

  set_clip_blend_mode: {
    description:
      `Set how a clip's picture composites onto the video tracks BELOW it (CapCut-style blend modes) — put the clip on a higher video track first. Modes: ${describeBlendModesForAI()}. Typical: light leaks / flares / fire / sparks shot on black → screen or add (the black vanishes); paper, grunge or shadow textures → multiply (the white vanishes); subtle textures → overlay / soft-light. Respects the clip's opacity, fades, keys, cutouts and mask (only the visible part blends). Only the PICTURE blends: the clip's own text overlays, captions and motion graphics draw normally on top (in a transition overlap both clips' text/graphics show at full strength). 'normal' resets it. Clips joined by a transition render as one stream with the run's FIRST clip's mode, so the mode applies to the clip's whole transition run (clipIds lists every clip changed). Not for adjustment layers (mask those instead) or audio. One undo step. Live in the preview; verify exactly with get_frame.`,
    schema: z.object({ clipId: z.string(), mode: z.enum(BLEND_MODES) }).strict(),
    handler: (engine, p) => engine.setClipBlendMode(p.clipId, p.mode),
  },

  set_clip_mask: {
    description:
      "Give a clip a SHAPE MASK (CapCut-style): only the part of its picture inside the shape shows (invert:true keeps the outside); the tracks below show elsewhere. The mask lives in the clip's OWN picture (fractions of the picture after crop/fit), so it moves, scales, rotates and flips with set_clip_transform/keyframes. shape: rect | ellipse | linear (a half-plane: the line through x,y at `rotation`; keeps the side ABOVE the line at rotation 0 — rotate 180 or invert for the other side) | mirror (a band of thickness h through x,y at `rotation`); null REMOVES the mask. x,y = centre (0..1 of the picture's width/height, default 0.5,0.5); w,h = size (fractions of the picture's width/height; a new rect/ellipse defaults to a centred square/circle half the short side); rotation = degrees clockwise; feather = soft-edge width 0..1 of the picture's short side (0 = crisp; 0.05–0.2 soft); roundness = rect corner radius 0..1; invert. Only the fields you pass change; out-of-range values are clamped. It multiplies the clip's alpha, so it combines with keys, remove_background cutouts, opacity and blend modes. Uses: split-screen (rect, w:0.5, x:0.25), spotlight/vignette-style reveal (ellipse + feather, or invert for a dark surround with a black lower track), picture-in-picture shapes (circle/rounded-rect face cams with set_clip_transform scale), graduated wipes (linear + feather). On an ADJUSTMENT layer the mask (canvas space) limits where its grade/effects apply — e.g. grade only the sky with a feathered linear mask. One undo step. Live in the preview; verify with get_frame.",
    schema: z
      .object({
        clipId: z.string(),
        shape: z.enum(MASK_SHAPES).nullable().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        w: z.number().optional(),
        h: z.number().optional(),
        rotation: z.number().optional(),
        feather: z.number().optional(),
        roundness: z.number().optional(),
        invert: z.boolean().optional(),
      })
      .strict(),
    handler: (engine, p) => {
      const { clipId, ...req } = p;
      const clip = engine.setClipMask(clipId, req);
      return { clip, mask: clip.effects?.mask ?? null };
    },
  },

  set_keyframes: {
    description:
      "Animate one property of a clip over time by setting its keyframes (REPLACES that property's track; pass an empty list to clear it). property: x | y | scale | rotation | opacity | volume (x/y are canvas fractions, scale a multiplier, rotation degrees, opacity & volume 0..1+). Each keyframe = { frame, value, ease? } where `frame` is CLIP-LOCAL (0 = the clip's start) and `ease` (linear|hold|ease|easeIn|easeOut) describes the interpolation INTO that keyframe (default linear; 'hold' = step). Example — a clip flying in from the left while scaling up: set_keyframes(clipId,'x',[{frame:0,value:-0.5},{frame:15,value:0,ease:'easeOut'}]) and set_keyframes(clipId,'scale',[{frame:0,value:0.6},{frame:15,value:1,ease:'easeOut'}]).",
    schema: z
      .object({
        clipId: z.string(),
        property: z.enum(KEYFRAME_PROPERTIES),
        keyframes: z
          .array(
            z.object({ frame: z.number().int().min(0), value: z.number(), ease: z.enum(EASE_KINDS).optional() }).strict(),
          )
          .max(200),
      })
      .strict(),
    handler: (engine, p) => ({ clip: engine.setKeyframes(p.clipId, p.property, p.keyframes) }),
  },

  clear_keyframes: {
    description: "Remove keyframe animation from a clip — one property (x/y/scale/rotation/opacity/volume) if given, otherwise all of them.",
    schema: z.object({ clipId: z.string(), property: z.enum(KEYFRAME_PROPERTIES).optional() }).strict(),
    handler: (engine, p) => {
      engine.clearKeyframes(p.clipId, p.property);
      return { ok: true };
    },
  },

  set_transition: {
    description:
      "Add a crossfade/transition entering a clip from the previous clip on the SAME track. The two clips overlap by `durationFrames` and crossfade over that overlap (the clip and everything after it on the track is pulled left to create the overlap). Cannot be set on a track's first clip. Use 'fade'/'dissolve' for a classic crossfade.",
    schema: z.object({ clipId: z.string(), type: z.enum(TRANSITION_TYPES), durationFrames: z.number().int().positive().max(300) }).strict(),
    handler: (engine, p) => ({ clip: engine.setTransition(p.clipId, p.type, p.durationFrames) }),
  },

  remove_transition: {
    description: "Remove the transition entering a clip (revert to a hard cut; the clip butts against the previous one again).",
    schema: z.object({ clipId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.removeTransition(p.clipId);
      return { ok: true };
    },
  },

  set_audio_offset: {
    description:
      "Create a J-cut or L-cut by sliding a clip's audio relative to its video, in FRAMES. NEGATIVE = audio leads the picture (J-cut: heard before seen — set on the INCOMING clip). POSITIVE = audio trails (L-cut: this clip's audio runs late over the next clip). Pass 0 to re-lock. These overlapping-audio edits make cuts feel seamless.",
    schema: z.object({ clipId: z.string(), offsetFrames: z.number().int() }).strict(),
    handler: (engine, p) => ({ clip: engine.setClipAudioOffset(p.clipId, p.offsetFrames) }),
  },

  // ---- text & captions ------------------------------------------------------
  add_text: {
    description:
      "Add a burned-in text overlay (title, lower-third, kinetic word, label) to a clip. Compose the look freely with the style fields: any installed `font` or a font-file path, fontSize/color, outline (outlineColor+outlineWidth), drop shadow (shadowColor+shadowX/shadowY), background box, and placement via keyword `position` or x/y (0..1). Long text AUTO-WRAPS to the canvas width; include your own \\n newlines to control the breaks exactly (then no auto-wrap). startFrame/endFrame (frames from the clip's start) limit when it shows; omit to show for the whole clip. Returns the overlay id.",
    schema: z
      .object({
        clipId: z.string(),
        text: z.string().min(1),
        ...TEXT_STYLE_FIELDS,
        startFrame: z.number().int().min(0).optional(),
        endFrame: z.number().int().positive().optional(),
      })
      .strict(),
    handler: (engine, p) => {
      const { clipId, ...overlay } = p;
      return { overlay: engine.addTextOverlay(clipId, overlay) };
    },
  },

  set_text_style: {
    description:
      "Restyle EXISTING text overlay(s) on a clip in place. Pass an `overlayId` to target one, or omit to restyle every overlay on the clip. Only the style fields you pass change. Same open vocabulary as add_text.",
    schema: z.object({ clipId: z.string(), overlayId: z.string().optional(), ...TEXT_STYLE_FIELDS }).strict(),
    handler: (engine, p) => {
      const { clipId, overlayId, ...style } = p;
      const overlays = engine.setTextStyle(clipId, overlayId, style);
      return { clipId, count: overlays.length, overlayIds: overlays.map((o) => o.id) };
    },
  },

  set_text_window: {
    description:
      "Move/resize WHEN a text overlay shows, in CLIP-LOCAL frames (0 = the clip's start). Pass startFrame and/or endFrame. (The timeline UI uses this when you drag a text bar.)",
    schema: z.object({ clipId: z.string(), overlayId: z.string(), startFrame: z.number().int().min(0).optional(), endFrame: z.number().int().min(1).optional() }).strict(),
    handler: (engine, p) => ({ overlay: engine.setTextWindow(p.clipId, p.overlayId, p.startFrame, p.endFrame) }),
  },

  set_graphic_window: {
    description:
      "Move/resize WHEN a motion graphic shows over its clip, in CLIP-LOCAL frames (0 = the clip's start). Pass startFrame and/or endFrame. (The timeline UI uses this when you drag a graphic bar.)",
    schema: z.object({ clipId: z.string(), graphicId: z.string(), startFrame: z.number().int().min(0).optional(), endFrame: z.number().int().min(1).optional() }).strict(),
    handler: (engine, p) => ({ graphic: engine.setGraphicWindow(p.clipId, p.graphicId, p.startFrame, p.endFrame) }),
  },

  set_caption_cue: {
    description:
      "Move/resize a single caption cue (by its index) in CLIP-LOCAL frames (0 = the clip's start). Pass startFrame and/or endFrame. (The timeline UI uses this when you drag a caption bar.)",
    schema: z.object({ clipId: z.string(), index: z.number().int().min(0), startFrame: z.number().int().min(0).optional(), endFrame: z.number().int().min(1).optional() }).strict(),
    handler: (engine, p) => ({ cue: engine.setCaptionCue(p.clipId, p.index, p.startFrame, p.endFrame) }),
  },

  animate_text: {
    description:
      "Animate a text overlay's position or opacity over time — native animated TITLES (fly-ins, slides, fades, pulses) with NO code. property: x | y (canvas fractions, 0=left/top … 1=right/bottom; text centered on the point) | opacity (0..1). REPLACES that property's track (empty list clears it). Each keyframe = {frame, value, ease?} where `frame` is CLIP-LOCAL (0 = clip start) and ease ∈ linear|hold|ease|easeIn|easeOut. Example — a lower-third sliding up while fading in: animate_text(clipId, overlayId, 'y', [{frame:0,value:0.9},{frame:12,value:0.8,ease:'easeOut'}]) and animate_text(clipId, overlayId, 'opacity', [{frame:0,value:0},{frame:12,value:1}]). (For complex coded motion graphics use add_graphic instead.)",
    schema: z
      .object({
        clipId: z.string(),
        overlayId: z.string(),
        property: z.enum(["x", "y", "opacity"]),
        keyframes: z
          .array(z.object({ frame: z.number().int().min(0), value: z.number(), ease: z.enum(EASE_KINDS).optional() }).strict())
          .max(200),
      })
      .strict(),
    handler: (engine, p) => ({ overlay: engine.animateText(p.clipId, p.overlayId, p.property, p.keyframes) }),
  },

  remove_text: {
    description: "Remove a single text overlay from a clip by its overlay id.",
    schema: z.object({ clipId: z.string(), overlayId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.removeTextOverlay(p.clipId, p.overlayId);
      return { ok: true };
    },
  },

  clear_text: {
    description: "Remove all text overlays from a clip.",
    schema: z.object({ clipId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.clearTextOverlays(p.clipId);
      return { ok: true };
    },
  },

  generate_captions: {
    description:
      "Transcribe a clip's audio locally with Whisper and attach timed captions burned into the clip. Runs offline; the model auto-downloads on first use. Style with the open style fields or restyle later with set_caption_style. Returns the number of caption cues created.",
    schema: z
      .object({
        clipId: z.string(),
        model: z.enum(WHISPER_MODELS).optional(),
        language: z.string().optional(),
        maxLen: z.number().int().positive().max(120).optional(),
        ...TEXT_STYLE_FIELDS,
      })
      .strict(),
    handler: async (engine, p) => {
      const { clipId, model, language, maxLen, ...style } = p;
      const { clip, cueCount } = await engine.generateCaptions(clipId, {
        model,
        language,
        maxLen,
        style: Object.keys(style).length ? style : undefined,
      });
      return { clipId: clip.id, cueCount, cues: clip.captions?.cues ?? [] };
    },
  },

  set_caption_style: {
    description:
      "Restyle a clip's EXISTING captions without re-transcribing. Open vocabulary — set any of font, fontSize, color, outline, shadow, box, and position or x/y. Only the fields you pass change.",
    schema: z.object({ clipId: z.string(), ...TEXT_STYLE_FIELDS }).strict(),
    handler: (engine, p) => {
      const { clipId, ...style } = p;
      const clip = engine.setCaptionStyle(clipId, style);
      return { clipId: clip.id, style: clip.captions?.style };
    },
  },

  clear_captions: {
    description: "Remove the caption track from a clip.",
    schema: z.object({ clipId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.clearCaptions(p.clipId);
      return { ok: true };
    },
  },

  export_captions: {
    description:
      "Write ALL timeline captions to a sidecar subtitle file (SubRip .srt or WebVTT .vtt) with ABSOLUTE timeline times — the deliverable alternative to burned-in captions (platforms like YouTube accept sidecars and let viewers toggle them). format defaults from the path extension. Fails with guidance if no clip has captions. Returns {path, cueCount, format}.",
    schema: z
      .object({ path: z.string().min(1), format: z.enum(["srt", "vtt"]).optional() })
      .strict(),
    handler: async (engine, p) => engine.exportCaptions(p.path, p.format),
  },

  import_captions: {
    description:
      "Attach a sidecar subtitle file (.srt or .vtt, auto-detected) to a clip as its caption track (REPLACES existing captions; style is kept). Cue times are ABSOLUTE timeline seconds and are converted to clip-local frames; cues outside the clip's window are dropped (reported in `dropped`). Style afterwards with set_caption_style.",
    schema: z.object({ clipId: z.string(), path: z.string().min(1) }).strict(),
    handler: async (engine, p) => {
      const r = await engine.importCaptions(p.clipId, p.path);
      return { clipId: r.clip.id, cueCount: r.cueCount, dropped: r.dropped };
    },
  },

  get_frame: {
    description:
      "Render a single composited frame of the CURRENT timeline at `atSeconds` (the whole multi-track edit — layering, cuts, color, captions, overlays, transitions) and return it as an image so you can SEE the result and self-correct. Your eyes: after a visual edit, call get_frame to verify before continuing. Defaults to the timeline midpoint.",
    schema: z.object({ atSeconds: z.number().min(0).optional() }).strict(),
    handler: async (engine, p) => ({ path: await engine.renderFrame(p.atSeconds) }),
  },

  inspect_clip: {
    description:
      "Plan an edit on a clip: returns the clip's timeline position + source range, its asset (dimensions, isImage, audio), the canvas, what's ALREADY on the clip (overlays/captions/graphics/effects with their frame windows), AND a few sampled composited frames (images) so you can SEE the footage and choose safe areas / exact placement for a motion graphic or text. Call this before authoring an add_graphic component or placing text, then place it with explicit clip-local startFrame/endFrame.",
    schema: z.object({ clipId: z.string(), frames: z.number().int().min(1).max(5).optional() }).strict(),
    handler: async (engine, p) => engine.inspectClip(p.clipId, p.frames),
  },

  // ---- motion graphics ------------------------------------------------------
  add_graphic: {
    description:
      "Add an animated motion graphic (title card, lower-third, callout, or a whole motion-graphics clip): an AI-authored Remotion React component rendered headlessly to an alpha video. Provide EITHER `code` (a TSX module default-exporting a component using Remotion's useCurrentFrame/useVideoConfig/interpolate/spring/AbsoluteFill) OR `template` (a built-in, e.g. 'title'). PLACEMENT: pass `clipId` to OVERLAY on that clip within a frame window (keep the component background transparent); set standalone=true to insert it as its OWN clip after that one; OR OMIT clipId to add it as a standalone clip (a pure motion-graphics clip — give the component a `background` prop and use durationSeconds). startFrame/endFrame are frames from the clip's start. Rendered at the project canvas size/fps.",
    schema: z
      .object({
        clipId: z.string().optional(),
        code: z.string().min(1).optional(),
        template: z.enum(GRAPHIC_TEMPLATE_NAMES).optional(),
        props: z.record(z.unknown()).optional(),
        startFrame: z.number().int().min(0).optional(),
        endFrame: z.number().int().positive().optional(),
        durationSeconds: z.number().positive().max(600).optional(),
        opacity: z.number().min(0).max(1).optional(),
        standalone: z.boolean().optional(),
      })
      .strict(),
    handler: async (engine, p) => {
      // "code XOR template" is enforced here, not via a top-level .refine():
      // a top-level .refine() makes the schema a ZodEffects with no `.shape`,
      // which makes the MCP layer advertise an empty input schema (clients then
      // strip every argument).
      if (!p.code && !p.template) {
        throw new Error("Provide either `code` (a TSX module) or `template` (a built-in name).");
      }
      const code = p.code ?? GRAPHIC_TEMPLATES[p.template as keyof typeof GRAPHIC_TEMPLATES];
      const r = await engine.addGraphic(p.clipId, {
        code,
        props: p.props,
        startFrame: p.startFrame,
        endFrame: p.endFrame,
        durationSeconds: p.durationSeconds,
        opacity: p.opacity,
        standalone: p.standalone,
      });
      return {
        graphicId: r.graphic?.id,
        clipId: r.clip.id,
        assetId: r.asset.id,
        duration: Number(r.asset.duration.toFixed(3)),
        standalone: !!p.standalone,
      };
    },
  },

  remove_graphic: {
    description: "Remove a single motion-graphic overlay from a clip by its graphic id.",
    schema: z.object({ clipId: z.string(), graphicId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.removeGraphic(p.clipId, p.graphicId);
      return { ok: true };
    },
  },

  clear_graphics: {
    description: "Remove all motion-graphic overlays from a clip.",
    schema: z.object({ clipId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.clearGraphics(p.clipId);
      return { ok: true };
    },
  },

  // ---- music & project ------------------------------------------------------
  set_music: {
    description:
      "Set background music for the whole timeline from an imported audio asset. volume defaults to 0.3 (kept under speech); duck=true auto-lowers the music whenever the main audio plays. fadeInFrames/fadeOutFrames in frames. The music loops/trims to the timeline length.",
    schema: z
      .object({
        assetId: z.string(),
        volume: z.number().min(0).max(4).optional(),
        fadeInFrames: z.number().int().min(0).optional(),
        fadeOutFrames: z.number().int().min(0).optional(),
        duck: z.boolean().optional(),
      })
      .strict(),
    handler: (engine, p) => {
      engine.setMusic(p.assetId, { volume: p.volume, fadeInFrames: p.fadeInFrames, fadeOutFrames: p.fadeOutFrames, duck: p.duck });
      return { ok: true };
    },
  },

  remove_music: {
    description: "Remove the background music.",
    schema: empty,
    handler: (engine) => {
      engine.removeMusic();
      return { ok: true };
    },
  },

  set_project_settings: {
    description:
      "Update project settings: name, and/or output canvas width/height/fps. Setting width or height fixes the output aspect ratio (e.g. 1080x1920 for 9:16 vertical). Changing fps rescales all existing frame positions to preserve timing.",
    schema: z
      .object({ name: z.string().optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), fps: z.number().positive().optional() })
      .strict(),
    handler: (engine, p) => {
      engine.setProjectSettings(p);
      return { project: engine.getProject() };
    },
  },

  set_markers: {
    description:
      "Replace the timeline's markers. Each entry is a bare frame number OR a named marker {frame, name?, color?, note?} — the annotation channel between you and the human: leave `note`s at moments that need review ('trim this pause?', 'b-roll here'), and read theirs from timeline_summary. Markers are saved with the project and act as snap targets when moving/trimming clips. Pass the FULL list each time (empty clears them; to add one, send the existing markers plus the new one).",
    schema: z
      .object({
        frames: z
          .array(
            z.union([
              z.number().int().min(0),
              z
                .object({
                  frame: z.number().int().min(0),
                  name: z.string().max(120).optional(),
                  color: z.string().max(40).optional(),
                  note: z.string().max(2000).optional(),
                })
                .strict(),
            ]),
          )
          .max(2000),
      })
      .strict(),
    handler: (engine, p) => {
      engine.setMarkers(p.frames);
      return { markers: engine.getProject().markers ?? [] };
    },
  },

  undo: {
    description: "Undo the last edit.",
    schema: empty,
    handler: (engine) => ({ changed: engine.undo() }),
  },

  redo: {
    description: "Redo the last undone edit.",
    schema: empty,
    handler: (engine) => ({ changed: engine.redo() }),
  },

  render_preview: {
    description: "Render a fast, lower-resolution preview of the entire timeline and return the output file path.",
    schema: empty,
    handler: async (engine) => engine.renderPreview(),
  },

  export_video: {
    description:
      "Render the final video to an absolute output path. Pick a per-platform `preset` (youtube, youtube_hevc, social=Reels/Shorts/TikTok, square, web=webm/vp9, master=near-lossless mov) and/or set fields directly: container (mp4|mov|webm), videoCodec (h264|h265|vp9), quality (CRF; lower=better/bigger), videoBitrate (e.g. '8M', overrides quality), preset/encoder speed, audioCodec (aac|opus), audioBitrate. Explicit fields override the named preset. Resolution & fps come from the canvas (set_project_settings). The output extension also implies the container. Default BLOCKS until done and returns {path, duration}. For long timelines (>~2 min) pass background:true — it returns {jobId} immediately; poll list_jobs for progress (fraction 0..1) and stop it with cancel_job. A canceled export deletes its partial file. `hardware: true` opts into GPU encoding (NVENC/QSV/AMF/VideoToolbox) — 2-10× faster but slightly lower quality-per-bit than the default software x264/x265; good for drafts and time-pressed deliveries, skip it for the final master. LOUDNESS: platform presets normalize the mix (youtube/social/square → -14 LUFS, web → -16, master → untouched); override with loudnessTarget (LUFS) + truePeak (dBTP, default -1.5), or pass a preset-less export for no normalization.",
    schema: z
      .object({
        outputPath: z.string().min(1),
        preset: z.enum(EXPORT_PRESET_NAMES as [string, ...string[]]).optional(),
        container: z.enum(["mp4", "mov", "webm"]).optional(),
        videoCodec: z.enum(["h264", "h265", "vp9"]).optional(),
        quality: z.number().min(0).max(63).optional(),
        videoBitrate: z.string().optional(),
        encoderPreset: z.string().optional(),
        audioCodec: z.enum(["aac", "opus"]).optional(),
        audioBitrate: z.string().optional(),
        background: z.boolean().optional(),
        hardware: z.boolean().optional(),
        loudnessTarget: z.number().min(-70).max(-5).optional(),
        truePeak: z.number().min(-9).max(0).optional(),
      })
      .strict(),
    handler: async (engine, p) => {
      const base = p.preset ? EXPORT_PRESETS[p.preset] : {};
      const settings = {
        ...base,
        ...(p.container ? { container: p.container } : {}),
        ...(p.videoCodec ? { videoCodec: p.videoCodec } : {}),
        ...(p.quality !== undefined ? { quality: p.quality } : {}),
        ...(p.videoBitrate ? { videoBitrate: p.videoBitrate } : {}),
        ...(p.encoderPreset ? { preset: p.encoderPreset } : {}),
        ...(p.audioCodec ? { audioCodec: p.audioCodec } : {}),
        ...(p.audioBitrate ? { audioBitrate: p.audioBitrate } : {}),
        ...(p.hardware !== undefined ? { hardware: p.hardware } : {}),
        ...(p.loudnessTarget !== undefined ? { loudnessTarget: p.loudnessTarget } : {}),
        ...(p.truePeak !== undefined ? { truePeak: p.truePeak } : {}),
      };
      if (p.background) {
        const { job } = engine.startExportJob(p.outputPath, settings);
        return { jobId: job.id, status: job.status, label: job.label };
      }
      return engine.exportVideo(p.outputPath, settings);
    },
  },

  // ---- jobs (long-running work) ----------------------------------------------
  list_jobs: {
    description:
      "List long-running jobs (export, preview, transcribe, reframe, stabilize, proxy, visual indexing, motion graphics): {id, type, label, status running|done|error|canceled, fraction 0..1, startedAt, endedAt?, result?, error?}. Pass activeOnly:true for just the currently-running ones. Use this to poll a background export's progress or to see what the engine is busy with.",
    schema: z.object({ activeOnly: z.boolean().optional() }).strict(),
    handler: (engine, p) => ({ jobs: engine.jobs.list(p.activeOnly ?? false) }),
  },

  cancel_job: {
    description:
      "Cancel a RUNNING job by its jobId (from list_jobs or a background export_video). Stops the underlying ffmpeg/model work; a canceled export deletes its partial output file. Returns {canceled:false} if the job already finished or the id is unknown — check list_jobs in that case.",
    schema: z.object({ jobId: z.string().min(1) }).strict(),
    handler: async (engine, p) => {
      const canceled = engine.jobs.cancel(p.jobId);
      if (!canceled && !engine.jobs.get(p.jobId)) {
        throw new Error(
          `No job with id "${p.jobId}". Call list_jobs to see running/recent jobs and use one of their ids.`,
        );
      }
      // The job is marked canceled at once, but its ffmpeg child exits (and an
      // export's partial file is deleted) a moment later. Wait for that so the
      // caller sees the finished state, not a half-cleaned one.
      if (canceled) await engine.jobs.settled(p.jobId);
      return { canceled, job: engine.jobs.get(p.jobId) };
    },
  },

  generate_thumbnail: {
    description: "Generate a thumbnail image for an asset at a given time (seconds). Returns the image path.",
    schema: z.object({ assetId: z.string(), atSeconds: z.number().min(0).optional() }).strict(),
    handler: async (engine, p) => ({ path: await engine.generateThumbnail(p.assetId, p.atSeconds) }),
  },

  generate_proxy: {
    description:
      "Transcode a low-res preview PROXY for an asset (snappier scrub/playback of large/4K footage). Auto-runs on import for big sources; call it to force one. The original is never modified and EXPORT always uses full resolution — proxies are preview-only. Returns the updated asset.",
    schema: z.object({ assetId: z.string() }).strict(),
    handler: async (engine, p) => ({ asset: await engine.generateProxy(p.assetId) }),
  },

  analyze_silence: {
    description: "Detect silent ranges in an asset's audio (for trimming dead air or finding cut points). Returns [{start, end, duration}] in seconds.",
    schema: z.object({ assetId: z.string(), noiseDb: z.number().optional(), minDur: z.number().positive().optional() }).strict(),
    handler: async (engine, p) => ({ ranges: await engine.analyzeSilence(p.assetId, p.noiseDb, p.minDur) }),
  },

  analyze_scenes: {
    description: "Detect scene-change timestamps in an asset's video (for finding natural cut points). Returns [{time}] in seconds.",
    schema: z.object({ assetId: z.string(), threshold: z.number().min(0).max(1).optional() }).strict(),
    handler: async (engine, p) => ({ cuts: await engine.analyzeScenes(p.assetId, p.threshold) }),
  },

  // ---- Phase 6: media intelligence ------------------------------------------
  create_folder: {
    description: "Create a library folder to organize imported assets. Returns the folder {id, name}.",
    schema: z.object({ name: z.string().min(1) }).strict(),
    handler: (engine, p) => ({ folder: engine.createFolder(p.name) }),
  },

  rename_folder: {
    description: "Rename a library folder.",
    schema: z.object({ folderId: z.string(), name: z.string().min(1) }).strict(),
    handler: (engine, p) => ({ folder: engine.renameFolder(p.folderId, p.name) }),
  },

  delete_folder: {
    description: "Delete a library folder. Its assets are kept (they fall back to no folder).",
    schema: z.object({ folderId: z.string() }).strict(),
    handler: (engine, p) => {
      engine.deleteFolder(p.folderId);
      return { ok: true };
    },
  },

  move_asset_to_folder: {
    description: "Move an asset into a folder, or pass folderId:null to move it out of any folder.",
    schema: z.object({ assetId: z.string(), folderId: z.string().nullable() }).strict(),
    handler: (engine, p) => ({ asset: engine.moveAssetToFolder(p.assetId, p.folderId) }),
  },

  index_transcript: {
    description:
      "Transcribe a WHOLE asset (local Whisper) and cache its transcript: segment cues AND word-level timestamps, making the asset searchable (search_transcript/locate_in_timeline) and TEXT-EDITABLE (delete_transcript_ranges/tighten_talk/edit_by_transcript). Run once per talking asset; idempotent. Returns {segmentCount, wordCount}. (Use generate_captions instead when you want burned-in on-screen captions for a placed clip.)",
    schema: z.object({ assetId: z.string(), model: z.enum(WHISPER_MODELS).optional(), language: z.string().optional() }).strict(),
    handler: async (engine, p) => engine.indexTranscript(p.assetId, { model: p.model, language: p.language }),
  },

  search_transcript: {
    description:
      "Search the spoken words across all INDEXED assets (run index_transcript first). Free-text query; exact phrases score highest. Returns ranked hits [{assetId, assetName, start, end, text, score}] with times in seconds — your way to find a quote/topic to cut to.",
    schema: z.object({ query: z.string().min(1), limit: z.number().int().positive().max(100).optional() }).strict(),
    handler: (engine, p) => ({ hits: engine.searchTranscript(p.query, p.limit) }),
  },

  get_transcript: {
    description:
      "Return the cached transcript of an asset: {segments:[{start,end,text}] in seconds} AND numbered words [{i, start, end, text}] — the stable word indices that delete_transcript_ranges and edit_by_transcript address. Null if not indexed yet (run index_transcript first). Read the real spoken content to decide cuts/quotes — don't guess from filenames.",
    schema: z.object({ assetId: z.string() }).strict(),
    handler: (engine, p) => {
      const t = engine.getTranscript(p.assetId);
      if (!t) return { transcript: null };
      return {
        transcript: {
          segments: t.segments,
          words: (t.words ?? []).map((w, i) => ({ i, start: Number(w.start.toFixed(3)), end: Number(w.end.toFixed(3)), text: w.text })),
          model: t.model,
          language: t.language,
        },
      };
    },
  },

  // ---- text-based editing (Descript-style, agent-driven) ---------------------
  delete_transcript_ranges: {
    description:
      "TEXT-BASED EDITING: cut spoken content by WORD RANGE. Pass word indices from get_transcript's numbered words; every placed clip of that asset has the matching footage removed as frame-accurate ripple cuts (gaps close), all in ONE undo step. Optional padFrames expands each cut by that many frames on both sides (breathing room). Fails with guidance if the asset has no word-level transcript (run index_transcript) or no clips on the timeline. Returns {cuts, framesRemoved, removedText, ranges}.",
    schema: z
      .object({
        assetId: z.string(),
        ranges: z
          .array(z.object({ fromWord: z.number().int().min(0), toWord: z.number().int().min(0) }).strict())
          .min(1),
        padFrames: z.number().int().min(0).max(60).optional(),
      })
      .strict(),
    handler: (engine, p) => engine.deleteTranscriptRanges(p.assetId, p.ranges, p.padFrames ?? 0),
  },

  tighten_talk: {
    description:
      "ONE-CALL talking-head cleanup: transcribes the clip's asset if needed (word-level), then removes filler words (default: um/uh/erm/hmm/…, the 'you know' bigram, and 'like' only when isolated by ≥0.25s pauses) and shrinks every pause longer than maxPauseSec (default 1.0s) down to half of it — as ONE ripple pass / undo step. Linked clips (detached audio) are cut in sync. padFrames (default 1) adds breathing room around each cut. Returns a reviewable report: each removed item with text + seconds, cut count, frames removed, old vs new duration. Run render_preview after to hear the result; undo reverts everything.",
    schema: z
      .object({
        clipId: z.string(),
        removeFillers: z.boolean().optional(),
        fillerWords: z.array(z.string().min(1)).max(100).optional(),
        maxPauseSec: z.number().min(0.2).max(10).optional(),
        padFrames: z.number().int().min(0).max(60).optional(),
      })
      .strict(),
    handler: async (engine, p) =>
      engine.tightenTalk(p.clipId, {
        removeFillers: p.removeFillers,
        fillerWords: p.fillerWords,
        maxPauseSec: p.maxPauseSec,
        padFrames: p.padFrames,
      }),
  },

  edit_by_transcript: {
    description:
      "'Here is my script — assemble the cut': pass the edited TEXT you want to keep (in playback order) and the engine diffs it against the asset's word-level transcript (LCS), then APPENDS one clip per kept span to the end of the base video track. Quote the transcript's real wording (read it with get_transcript first); paraphrases won't match. padSec (default 0.08) widens each span slightly so words aren't clipped. Returns the created clipIds, the kept spans with text, and match stats. Fails with guidance if nothing matches or the transcript isn't indexed.",
    schema: z
      .object({
        assetId: z.string(),
        keep: z.string().min(1),
        padSec: z.number().min(0).max(1).optional(),
      })
      .strict(),
    handler: (engine, p) => engine.editByTranscript(p.assetId, p.keep, p.padSec ?? 0.08),
  },

  bleep_words: {
    description:
      "AUTO-BLEEP: censor profanity using the word-level transcript (auto-indexes assets that have none). Every matched word becomes a BLEEP stored ON the clip that carries the asset's audio (clip.effects.bleeps, source seconds, padded): the original is muted under it and a sound effect plays there (sound: beep = TV bleep, quack, squeak, boing, honk; or sfxAssetId for your own imported audio). Bleeps belong to their clip and FOLLOW IT AUTOMATICALLY through every edit — move, ripple, trim (a trimmed-off word's bleep disappears, extending the trim back restores it), split (each half keeps its own range), speed changes and speed ramps (the sound keeps its pitch) and delete — so there is no need to bleep last. Matching is whole-word against a built-in English swear list (no slurs); includeMild adds damn/hell/crap/piss/bloody/arse; pass words to add custom terms (exact, case-insensitive) and useDefaultList:false to use only those. Default scope is every clip with audio; pass clipIds to limit it. Use dryRun:true FIRST to review the matches (nothing changes). Re-running REPLACES the bleeps on the targeted clips (one undo step). Fix one afterwards with set_bleep (nudge/resize/sound/volume), add a missed word with add_bleep, drop one with remove_bleep. Returns {hits:[{clipId,bleepId,text,sourceStart,sourceEnd,startFrame,endFrame}], indexedAssetIds}.",
    schema: z
      .object({
        clipIds: z.array(z.string()).optional(),
        words: z.array(z.string().min(1)).max(200).optional(),
        useDefaultList: z.boolean().optional(),
        includeMild: z.boolean().optional(),
        sound: z.enum(BLEEP_SOUNDS).optional(),
        sfxAssetId: z.string().optional(),
        padBeforeMs: z.number().min(0).max(1000).optional(),
        padAfterMs: z.number().min(0).max(1000).optional(),
        sfxVolume: z.number().min(0).max(4).optional(),
        muteOriginal: z.boolean().optional(),
        dryRun: z.boolean().optional(),
      })
      .strict(),
    handler: async (engine, p) => engine.bleepWords(p),
  },

  add_bleep: {
    description:
      "Add ONE manual bleep to a clip — for a word bleep_words missed. Give the muted window either as start+end in the clip's SOURCE (asset) seconds (e.g. a word's times from get_transcript, plus ~0.06 s padding each side), or as atSeconds (TIMELINE seconds) + duration (timeline seconds, default 0.5). The bleep belongs to the clip and follows it through every edit. sound (default beep) or sfxAssetId (custom audio asset), volume (SFX gain, default 0.8), mute (silence the original under it, default true). One undo step. Returns {clipId, bleep, startFrame, endFrame} (timeline frames where it lands now).",
    schema: z
      .object({
        clipId: z.string(),
        start: z.number().min(0).optional(),
        end: z.number().positive().optional(),
        atSeconds: z.number().min(0).optional(),
        duration: z.number().positive().max(30).optional(),
        sound: z.enum(BLEEP_SOUNDS).optional(),
        sfxAssetId: z.string().optional(),
        volume: z.number().min(0).max(4).optional(),
        mute: z.boolean().optional(),
        word: z.string().max(200).optional(),
      })
      .strict(),
    handler: async (engine, p) => engine.addBleep(p),
  },

  set_bleep: {
    description:
      "Change ONE bleep on a clip (ids from bleep_words / add_bleep / timeline_summary's clip.bleeps): nudge or resize its muted window with start/end in SOURCE seconds (start < end, clamped to the asset, min 0.04 s — e.g. +0.3 s on both to shift it later), switch sound (a built-in sound clears a custom sfxAssetId) or sfxAssetId, volume (SFX gain 0–4), mute (silence the original under it). One undo step. Returns {clipId, bleep, startFrame, endFrame} (null frames = currently trimmed out of view).",
    schema: z
      .object({
        clipId: z.string(),
        bleepId: z.string(),
        start: z.number().min(0).optional(),
        end: z.number().positive().optional(),
        sound: z.enum(BLEEP_SOUNDS).optional(),
        sfxAssetId: z.string().optional(),
        volume: z.number().min(0).max(4).optional(),
        mute: z.boolean().optional(),
      })
      .strict(),
    handler: async (engine, p) => engine.setBleep(p),
  },

  remove_bleep: {
    description: "Remove ONE bleep from a clip (restores the original audio under it). One undo step. Returns {removed}.",
    schema: z.object({ clipId: z.string(), bleepId: z.string() }).strict(),
    handler: (engine, p) => engine.removeBleep(p.clipId, p.bleepId),
  },

  remove_bleeps: {
    description:
      "Remove EVERY bleep from the given clips (all clips if clipIds is omitted), restoring the original audio. One undo step. Returns {clearedClips, removedBleeps}.",
    schema: z.object({ clipIds: z.array(z.string()).optional() }).strict(),
    handler: (engine, p) => engine.removeBleeps(p),
  },

  // ---- per-clip audio effects (effects/audio.ts) ----------------------------
  apply_audio_effect: {
    description:
      "Add an AUDIO effect to a clip's sound (baked into the clip's audio, in stack order). Effects stack — call repeatedly. " +
      "For a quick 'make the voice sound good' use enhance_voice instead (one tuned chain); use individual effects for a specific fix or a creative voice. " +
      "Every type with its params (ranges, defaults):\n" +
      describeAudioEffectsForAI() +
      "\nValues outside a range are clamped (reported in `adjusted`); an unknown param is rejected with the valid list. " +
      "Audio effects run in the clip's SOURCE time, after bleep mutes and BEFORE speed: set_clip_speed never changes an EQ, echo time or voice pitch (a pitched voice stays pitched at 2×), and bleep sounds are never processed. " +
      "If the clip's sound is carried by a linked detached-audio clip (this clip silenced at volume 0), the effect goes on that clip — the result's clipId/note say so. " +
      "A NEW effect slots in at signal-chain position (enhance → cleanup → tone → dynamics → voice changer); reorder_audio_effect moves one. " +
      "Pass effectId to UPDATE one in place (type + params REPLACED — send the full set); enabled:false BYPASSES it (kept, skipped in export and preview), {effectId, type, enabled} alone toggles it. " +
      "Live preview plays filters/EQ/compressor/echo/telephone-style effects, and pitch/chipmunk/deep/robot through an AudioWorklet ([live preview approximate]: a simpler pitch shifter than the export's rubberband; robot follows the FFmpeg 4 filter); [render-only] ones (noise reduction, normalize, de-esser, gate) are heard in render_preview/export. " +
      "Returns {clipId, effectId} (remove_audio_effect deletes it).",
    schema: z
      .object({
        clipId: z.string(),
        type: z.enum(AUDIO_EFFECT_TYPE_IDS),
        params: z.record(z.number()).optional(),
        enabled: z.boolean().optional(),
        effectId: z.string().optional(),
      })
      .strict(),
    handler: async (engine, p) => {
      const v = validateAudioEffect({ type: p.type, params: p.params });
      const r = await engine.applyAudioEffect(p.clipId, { id: p.effectId, type: p.type, params: v.params, enabled: p.enabled });
      return v.adjusted.length ? { ...r, adjusted: v.adjusted } : r;
    },
  },

  remove_audio_effect: {
    description:
      "Remove one audio effect by its effectId (from apply_audio_effect / enhance_voice; found on the clip or its linked detached audio). To keep it but switch it off use apply_audio_effect with enabled:false. One undo step.",
    schema: z.object({ clipId: z.string(), effectId: z.string() }).strict(),
    handler: (engine, p) => engine.removeAudioEffect(p.clipId, p.effectId),
  },

  reorder_audio_effect: {
    description:
      "Move one audio effect within its clip's audio stack (they run in order: e.g. noise reduction before a voice changer, normalize after EQ). toIndex = new 0-based position (clamped). One undo step.",
    schema: z.object({ clipId: z.string(), effectId: z.string(), toIndex: z.number().int().min(0) }).strict(),
    handler: (engine, p) => engine.reorderAudioEffect(p.clipId, p.effectId, p.toIndex),
  },

  enhance_voice: {
    description:
      "ONE-CLICK VOICE ENHANCE (CapCut-style) for dialogue, vlogs, voice-overs and interviews: adds — or updates — one tuned chain on the clip's audio: rumble cut (75 Hz) → noise reduction → de-esser → warmth + presence EQ → gentle compressor → speech levelling + loudness normalisation to −16 LUFS (true peak −1.5 dBTP). " +
      "strength 0..1 (default 0.7 for a new one; 0.3 = subtle, 1 = heavy cleanup); noiseReduction:false skips the denoiser (clean studio audio), normalize:false keeps the clip's own level (a limiter still prevents clipping). Omitted options keep the current values. " +
      "Use this first for any talking clip; reach for apply_audio_effect only for a specific problem (e.g. eq_presence for a muffled mic) or a creative voice. Runs before speed (unchanged by set_clip_speed). " +
      "Applies to the linked detached-audio clip when that carries the sound (see clipId/note). The live preview plays its EQ/compressor part — render_preview to hear the denoise/normalize. One undo step. Returns {clipId, effectId, params}.",
    schema: z
      .object({
        clipId: z.string(),
        strength: z.number().min(0).max(1).optional(),
        noiseReduction: z.boolean().optional(),
        normalize: z.boolean().optional(),
      })
      .strict(),
    handler: (engine, p) => engine.enhanceVoice(p.clipId, { strength: p.strength, noiseReduction: p.noiseReduction, normalize: p.normalize }),
  },

  locate_in_timeline: {
    description:
      "Find where a spoken phrase lands on the CURRENT timeline. For every placed clip whose asset transcript matches, returns the ABSOLUTE timeline frame range [{clipId, trackIndex, startFrame, endFrame, text}] — feed these straight into ripple_delete_ranges/cut_range to make transcript-driven cuts, or seek to them.",
    schema: z.object({ query: z.string().min(1), limit: z.number().int().positive().max(200).optional() }).strict(),
    handler: (engine, p) => ({ matches: engine.locateInTimeline(p.query, p.limit) }),
  },

  index_visual: {
    description:
      "Build a perceptual visual fingerprint for an asset (a few sampled keyframes) so it can be matched by appearance. Auto-run by search_visual, but you can pre-index. If a CLIP model is installed (AIVE_CLIP_VISION) it also stores semantic embeddings. Returns {sampleCount, semantic}.",
    schema: z.object({ assetId: z.string(), count: z.number().int().min(1).max(12).optional() }).strict(),
    handler: async (engine, p) => engine.indexVisual(p.assetId, p.count),
  },

  search_visual: {
    description:
      "Find shots by appearance or MEANING. Two modes: (1) pass a free-text `query` (e.g. 'wide shot of a sunset over water') for SEMANTIC text→image search via the local CLIP model (downloaded once on first use; falls back with a clear error if it can't be obtained). (2) pass a reference frame — a clip (clipId + clip-local atSeconds) OR an asset (assetId + atSeconds) — to find shots that LOOK like it (perceptual, plus CLIP image↔image when available). Returns {semantic, mode, hits:[{assetId, name, score, atSeconds}]} ranked best-first; atSeconds is the best-matching moment. Auto-indexes candidates.",
    schema: z
      .object({
        query: z.string().optional(),
        clipId: z.string().optional(),
        assetId: z.string().optional(),
        atSeconds: z.number().min(0).optional(),
        limit: z.number().int().positive().max(50).optional(),
      })
      .strict(),
    handler: async (engine, p) => {
      if (!p.query && !p.clipId && !p.assetId) throw new Error("Provide a text `query` or a reference clipId/assetId.");
      return engine.searchVisual({ query: p.query, clipId: p.clipId, assetId: p.assetId, atSeconds: p.atSeconds }, p.limit);
    },
  },

  sync_audio: {
    description:
      "Align a clip to a reference clip by SOUND (cross-correlates their audio — great for multi-cam/second-take sync). Measures the time offset and, unless apply:false, MOVES the clip on the timeline so its audio lines up with the reference. Returns {offsetSeconds, offsetFrames, confidence (−1..1), applied}.",
    schema: z.object({ clipId: z.string(), referenceClipId: z.string(), apply: z.boolean().optional() }).strict(),
    handler: async (engine, p) => engine.syncAudio(p.clipId, p.referenceClipId, p.apply ?? true),
  },

  // ---- OpenTimelineIO interop -------------------------------------------------
  export_otio: {
    description:
      "Write the timeline as an OpenTimelineIO (.otio) JSON file at the given absolute path — the industry interchange format (DaVinci Resolve, Premiere via extension, Hiero, RV all read it). Tracks/clips/gaps/transitions map to OTIO natively; SynthCut-only data (effects stacks, keyframes, captions, graphics, adjustment layers) rides in metadata.synthcut so importing back into SynthCut is LOSSLESS. Use it to hand the edit off for finishing.",
    schema: z.object({ path: z.string().min(1) }).strict(),
    handler: async (engine, p) => engine.exportOtio(p.path),
  },

  import_otio: {
    description:
      "Load an OpenTimelineIO (.otio) JSON file as the CURRENT project (unsaved edits are auto-saved first). Referenced media is probed from disk; files that can't be found are imported as OFFLINE placeholder assets (asset.missing=true — those clips won't render until the file exists at that path or you replace them). Returns {warnings} for OTIO features that couldn't be expressed and {missing} paths. A file exported by export_otio restores losslessly.",
    schema: z.object({ path: z.string().min(1) }).strict(),
    handler: async (engine, p) => {
      const autosaved = await engine.autoSaveIfDirty();
      const r = await engine.importOtio(p.path);
      const restored = engine.lastRestoredFromTrash;
      return { project: r.project, warnings: r.warnings, missing: r.missing, autosaved, ...(restored.length ? { restoredFromTrash: restored } : {}) };
    },
  },

  save_project: {
    description: "Save the project to a .aive JSON file at the given absolute path. This is 'Save As' — it also becomes the project's current file, so later `save` calls reuse this path.",
    schema: z.object({ path: z.string().min(1) }).strict(),
    handler: async (engine, p) => {
      await engine.save(p.path);
      return { ok: true, path: p.path };
    },
  },

  save: {
    description: "Save the project to its CURRENT file (the path it was last saved to or opened from) — the plain 'Save'. Fails if the project has never been saved; use save_project with a path for that first (Save As).",
    schema: empty,
    handler: async (engine) => {
      const path = engine.getCurrentPath();
      if (!path) {
        throw new Error("This project has no file yet. Use save_project with an absolute path (Save As) before calling save.");
      }
      await engine.save(path);
      return { ok: true, path };
    },
  },

  load_project: {
    description: "Load a project from a .aive JSON file at the given absolute path (old single-track projects are migrated to the multi-track frame model). Unsaved edits in the currently-open project are auto-saved first, so nothing is lost; the returned `autosaved` says whether/where that happened.",
    schema: z.object({ path: z.string().min(1) }).strict(),
    handler: async (engine, p) => {
      const autosaved = await engine.autoSaveIfDirty();
      const project = await engine.load(p.path);
      const restored = engine.lastRestoredFromTrash;
      return { project, autosaved, ...(restored.length ? { restoredFromTrash: restored } : {}) };
    },
  },

  new_project: {
    description: "Discard the current project and start a fresh, empty one. Unsaved edits in the current project are auto-saved first (to its file, or a recovery file if it was never saved), so nothing is lost; the returned `autosaved` says whether/where that happened.",
    schema: empty,
    handler: async (engine) => {
      const autosaved = await engine.autoSaveIfDirty();
      engine.reset();
      return { project: engine.getProject(), autosaved };
    },
  },

  // ---- storage housekeeping (baked/ + proxies/, see storage.ts) ---------------
  storage_report: {
    description:
      "Disk usage of SynthCut's data dir and what a clean-up would do — a DRY RUN, nothing is moved. Bakes (remove_background cutouts are lossless, ~0.9 GB per minute of 1080p; stabilize, auto_reframe, freeze_frame, reverse_clip, smooth_slow_motion, motion graphics) live in baked/, preview proxies in proxies/. Returns usage per area {baked, proxies, trash, cache, previews, frames, masks, other} in bytes + human sizes; wouldTrash = the unused files an explicit clean_up_storage would move to the trash now, each with size and why (not named by the open project, its undo history, any known .aive/.otio file or the autosaves, and older than the 1 h grace period); predatesTracking = how many of them were made before SynthCut began tracking project files, so an older project not opened since may still use them (tell the user before cleaning up); gracePeriod = unused but too new to move; trash = what is in the trash, with age (deleted for good after settings.trashDays) and inUse (a project names it again: the next clean-up moves it back); emptyTrash = what clean_up_storage {emptyTrash:true} would delete for good; unavailableProjects = known project files that can't be read (pausesCleanUp: nothing is moved to the trash meanwhile); blockedBy = running jobs that pause clean-up; otherCores = other running SynthCut cores on this data folder (an AI client's core next to the app's) whose open project and undo history also count as references; libraryBakes = bakes the open project's library holds that no clip uses (they keep their files alive: a clean-up drops them from the library once no undo/redo step uses them either; remove_unused_media drops them now). Use it when the user asks why the disk is full or before clean_up_storage.",
    schema: empty,
    handler: async (engine) => engine.storage.report(),
  },

  clean_up_storage: {
    description:
      "Run the storage clean-up now: moves the unused baked/proxy files listed by storage_report.wouldTrash into a .trash folder (reversible — opening a project with load_project/import_otio automatically moves back any file it needs, no restore tool needed) and deletes trash older than the retention period (default 7 days). Keeps everything the open project, its undo/redo history, known project files or autosaves reference, and anything newer than 1 h; a trashed file one of them names again is moved back (restored). Unlike the automatic runs, it ALSO moves files made before SynthCut began tracking project files (storage_report.predatesTracking), which a project not opened since may still use — say so to the user first. While a known project file can't be read (unplugged drive, moved or deleted file), nothing is moved to the trash; forgetMissing:true first forgets those project files — only when the user confirms they are gone. Does nothing while a job is running (returns skipped). emptyTrash:true ALSO deletes the trash for good afterwards, including what this run just moved, except files made before tracking (they stay in the trash for the retention period, keptInTrash) — only when the user explicitly asks to free the space now. Every clean-up (automatic ones too) first removes from the library the bakes that no clip uses in the open project or any undo/redo step (removedFromLibrary; imported media is never removed). Returns {moved, movedBytes, restored, purged, freedBytes, keptInTrash, forgotProjects, removedFromLibrary, failed, kept, trashBytes, warnings}. Moving to the trash frees no space until it is emptied.",
    schema: z.object({ emptyTrash: z.boolean().optional(), forgetMissing: z.boolean().optional() }).strict(),
    handler: async (engine, p) => engine.storage.cleanUp({ emptyTrash: p.emptyTrash ?? false, forgetMissing: p.forgetMissing ?? false }),
  },

  remember_projects: {
    description:
      "Record .aive/.otio project files (for example the recent-projects list, or project files the user mentions) as known projects, so the storage clean-up keeps the baked/proxy files they use. Saving, opening and exporting already record their file; use this for projects made before SynthCut tracked project files. Paths that don't exist or aren't .aive/.otio files are skipped (returned in skipped). Returns {added, skipped, knownProjects}.",
    schema: z.object({ paths: z.array(z.string().min(1)).max(500) }).strict(),
    handler: async (engine, p) => engine.storage.rememberMany(p.paths),
  },

  remove_unused_media: {
    description:
      "Remove library assets that nothing in the open project uses (no clip, motion-graphic overlay, bleep sound or music bed; a reversed bake in use keeps its original). By default only SynthCut-made ones go (kind 'generated': bakes from remove_background, reverse_clip, freeze_frame, smooth_slow_motion, stabilize, auto_reframe, motion graphics, plus built-in bleep sounds) — imported media stays unless includeImported:true, which only the user should ask for. dryRun:true reports without changing anything — use it first and tell the user what would go. One undo step. Files are not deleted here: the storage clean-up moves a bake's file to the trash once no project, undo step or other core uses it. Returns {dryRun, removed:[{assetId,name,path,kind,bytes}], keptImported (unused imported media left in place), removedBytes}.",
    schema: z.object({ dryRun: z.boolean().optional(), includeImported: z.boolean().optional() }).strict(),
    handler: async (engine, p) => engine.removeUnusedMedia({ dryRun: p.dryRun ?? false, includeImported: p.includeImported ?? false }),
  },
} satisfies Record<string, RpcMethod>;

export type MethodName = keyof typeof methods;

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: "unknown_method" | "invalid_params" | "handler_error",
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Validate and execute an RPC method against the engine. */
export async function dispatch(engine: EditorEngine, method: string, params: unknown): Promise<unknown> {
  const entry = (methods as Record<string, RpcMethod>)[method];
  if (!entry) {
    throw new RpcError(`Unknown method "${method}"`, "unknown_method");
  }
  const parsed = entry.schema.safeParse(params ?? {});
  if (!parsed.success) {
    throw new RpcError(`Invalid params for "${method}": ${parsed.error.message}`, "invalid_params");
  }
  return entry.handler(engine, parsed.data);
}
