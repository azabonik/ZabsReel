// Pure renderer-side helpers for per-clip AUDIO effects (the vocabulary itself
// is core's registry, `@aive/core/audio-effects`): the compositor's per-clip
// Web Audio plan, which clip carries a clip's sound (mirrors the engine's
// audioCarrier), and the inspector's one-click presets. No DOM — unit-tested by
// scripts/smoke-composite.ts.

import {
  AUDIO_EFFECTS, VOICE_CHANGER_TYPES, audioPreviewPlan, isAudioEffectEnabled, linkedSoundPartners, type AudioPreviewPlan,
} from "@aive/core/audio-effects";
import type { AudioEffect, Clip, Project } from "./types";

const plans = new WeakMap<readonly AudioEffect[], AudioPreviewPlan>();

/**
 * `{ fx }` for a clip's audio effect stack (nothing when it has none), memoised
 * per stack array: a state update replaces the array, so an edit makes a new
 * plan (and a new `sig`) while every other frame reuses the same object.
 */
export function audioFxField(filters: readonly AudioEffect[] | undefined): { fx?: AudioPreviewPlan } {
  if (!filters?.length) return {};
  let plan = plans.get(filters);
  if (!plan) {
    plan = audioPreviewPlan(filters);
    plans.set(filters, plan);
  }
  return plan.nodes.length || plan.renderOnly.length ? { fx: plan } : {};
}

/** Find a clip anywhere in the project, with its track. */
function locate(project: Project, clipId: string) {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return undefined;
}

/**
 * The clip that carries `clip`'s sound — itself when audible, else the audible
 * linked clip of the same asset that plays the same stretch of the source (a
 * video clip silenced to volume 0 with its detached audio on an audio track;
 * after a split, the matching half). The same rule as the engine's
 * audioCarrier (core's linkedSoundPartners), so the inspector edits the stack
 * the export uses.
 */
export function audioCarrier(project: Project | null, clip: Clip): Clip {
  if (!project) return clip;
  const audible = (c: Clip, muted?: boolean) => !muted && c.effects?.volume !== 0;
  const own = locate(project, clip.id);
  if (!own || audible(own.clip, own.track.muted)) return own?.clip ?? clip;
  if (!clip.linkGroupId) return own.clip;
  const group: Clip[] = [];
  const muted = new Map<string, boolean>();
  for (const track of project.tracks) {
    for (const c of track.clips) {
      if (c.linkGroupId !== clip.linkGroupId) continue;
      group.push(c);
      muted.set(c.id, !!track.muted);
    }
  }
  return linkedSoundPartners(own.clip, group).find((c) => audible(c, muted.get(c.id))) ?? own.clip;
}

/** The inspector's "Voice effect" choices, in registry order. */
export const VOICE_PRESETS = VOICE_CHANGER_TYPES.map((type) => ({
  type,
  label: AUDIO_EFFECTS.find((d) => d.type === type)!.label,
}));

/** The first effect of `type` in a stack (the one-click toggles manage one each). */
export function firstOfType(filters: readonly AudioEffect[] | undefined, type: string): AudioEffect | undefined {
  return filters?.find((f) => f.type === type);
}

/** The stack's voice-changer effect (the single "Voice effect" slot), if any. */
export function voiceSlot(filters: readonly AudioEffect[] | undefined): AudioEffect | undefined {
  return filters?.find((f) => (VOICE_CHANGER_TYPES as readonly string[]).includes(f.type));
}

/** Is a one-click toggle on (its effect present and not bypassed)? */
export function toggleOn(f: AudioEffect | undefined): boolean {
  return !!f && isAudioEffectEnabled(f);
}
