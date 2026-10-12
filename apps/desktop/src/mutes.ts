// Renderer-side mirror of packages/core/src/audio/mutes.ts — the SAME bleep mute
// envelope the FFmpeg export applies, so the live preview matches. Kept
// decoupled (no core import) like the rest of the desktop model mirror.

export interface SourceMute {
  start: number;
  end: number;
}

const MUTE_RAMP_SEC = 0.01;

/** Gain (0..1) of the mute envelope at a given SOURCE time in seconds. */
export function muteGainAt(mutes: readonly SourceMute[] | undefined, srcSec: number): number {
  if (!mutes?.length) return 1;
  let g = 1;
  for (const m of mutes) {
    const w = Math.min(
      1,
      Math.max(0, Math.min((srcSec - (m.start - MUTE_RAMP_SEC)) / MUTE_RAMP_SEC, (m.end + MUTE_RAMP_SEC - srcSec) / MUTE_RAMP_SEC)),
    );
    g = Math.min(g, 1 - w);
  }
  return g;
}
