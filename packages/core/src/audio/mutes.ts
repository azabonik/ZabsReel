/**
 * Source-time audio mutes (the bleep envelope). A mute is a span of the clip's
 * SOURCE audio, in asset seconds, that plays silent. The edges ramp over
 * {@link MUTE_RAMP_SEC} OUTSIDE the span (so the word itself is fully silent)
 * to avoid clicks. The same math is mirrored in apps/desktop/src/mutes.ts for
 * the live preview — keep the two in sync.
 */

export interface SourceMute {
  start: number;
  end: number;
}

/** De-click ramp length in seconds. */
export const MUTE_RAMP_SEC = 0.01;

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

/**
 * FFmpeg expression (variable `t` = seconds since the clip's source-in) giving
 * the same envelope as {@link muteGainAt}. `sourceIn` converts stream time to
 * asset time. Contains commas, so quote it in a filter option.
 */
export function muteGainExpr(mutes: readonly SourceMute[], sourceIn: number): string {
  const r = MUTE_RAMP_SEC;
  const terms = mutes.map((m) => {
    const s = (m.start - sourceIn).toFixed(4);
    const e = (m.end - sourceIn).toFixed(4);
    return `clip(min((t-(${s})+${r})/${r},(${e}+${r}-t)/${r}),0,1)`;
  });
  // Product of (1 - window); bleep windows are merged so they never overlap,
  // which makes this equal to the min() form of muteGainAt.
  return terms.map((w) => `(1-${w})`).join("*");
}
