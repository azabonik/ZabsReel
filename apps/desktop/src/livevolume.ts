// The track volume slider's value while it moves (timeline.tsx), before the one
// set_track_properties edit on release: the preview (composite.ts via
// preview.tsx) and the track meter use it at once, with no edit or store
// write per step. Cleared on cancel, on a refused edit and once the committed
// track.volume arrives; then the project's value drives the gain again.

/** One slider moves at a time: its track and value. */
export interface LiveTrackVolume {
  trackIndex: number;
  volume: number;
}

let live: LiveTrackVolume | null = null;
const listeners = new Set<() => void>();

export function liveTrackVolume(): LiveTrackVolume | null {
  return live;
}

export function setLiveTrackVolume(v: LiveTrackVolume | null): void {
  if (live === v || (live && v && live.trackIndex === v.trackIndex && live.volume === v.volume)) return;
  live = v;
  listeners.forEach((l) => l());
}

/** Drop the live value of `trackIndex` (another track's drag is left alone). */
export function clearLiveTrackVolume(trackIndex: number): void {
  if (live?.trackIndex === trackIndex) setLiveTrackVolume(null);
}

/** Subscribe to changes; returns the unsubscribe. */
export function onLiveTrackVolumeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * A track meter's bar (0..1): the waveform peak at the playhead × the track's gain × the clip's
 * volume. The gain is the slider's live value while it moves on this track, else the committed
 * track volume, so the meter shows the level being heard.
 */
export function meterLevel(peak: number, live: LiveTrackVolume | null, trackIndex: number, volume: number, clipVol: number): number {
  const gain = live && live.trackIndex === trackIndex ? live.volume : volume;
  return Math.min(1, peak * gain * clipVol);
}
