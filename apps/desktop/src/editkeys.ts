// Which clip the timeline's S (split) and Delete keys act on. Pure, so a smoke
// script can test it.
import { clipDurationFrames, type Clip, type Project } from "./types";

/**
 * True when `id` names a clip in `live`, the project as of the latest render.
 * The key handler is re-subscribed in an effect, so for a moment after a split
 * its closure still holds the old clips and the old (now removed) selection.
 */
export function clipIsLive(live: Project | null | undefined, id: string): boolean {
  return !!live?.tracks.some((t) => t.clips.some((c) => c.id === id));
}

/**
 * The frame (into the clip) where S splits the selected clip, or null for no
 * split: nothing selected, the selection no longer exists, or the playhead is
 * not strictly inside the clip. `clips` may come from an older render.
 */
export function splitFrameFor(live: Project | null | undefined, clips: Clip[], selected: string | null, playheadFrame: number, fps: number): number | null {
  if (!selected || !clipIsLive(live, selected)) return null;
  const clip = clips.find((c) => c.id === selected);
  if (!clip) return null;
  const local = playheadFrame - clip.startFrame;
  return local > 0 && local < clipDurationFrames(clip, fps) ? local : null;
}
