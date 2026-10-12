// How far the live preview lowers the resolution of the WebGL looks while
// PLAYING. Paused frames always render at full resolution. During playback a
// software WebGL renderer (SwiftShader, llvmpipe …) starts at half
// resolution, and drops to a quarter when frames that ran a look keep
// arriving slower than the budget; a GPU stays at full resolution (preview.tsx
// passes base 1, max 1 there). A blur's cost grows with the cube of the scale
// (pixels × kernel length), so one step is about 8× cheaper for the heavy
// effects. PURE (no DOM).

export class PlaybackGovernor {
  /** Divisor of the looks' processing resolution while playing (1, 2, 4). */
  div = 1;
  private ema = 0;
  private frames = 0;
  private key: unknown = undefined;
  private max = 1;

  /**
   * @param base the starting divisor (read at each start)
   * @param maxDiv the lowest resolution it may step down to (read at each start)
   * @param budgetMs a frame interval above this (as a running average) lowers the resolution
   */
  constructor(
    private readonly base: () => number,
    private readonly maxDiv: () => number = () => 4,
    private readonly budgetMs = 60,
  ) {}

  /**
   * Playback (re)starts. `key` identifies what plays (the project state): the
   * divisor a slow look needed is kept while it stays the same, so the next
   * play starts at that resolution; anything new starts again from the base.
   */
  start(key: unknown): void {
    this.max = this.maxDiv();
    if (key !== this.key) {
      this.key = key;
      this.div = this.base();
    }
    this.ema = 0;
    this.frames = 0;
  }

  /** One played frame: `dtMs` since the previous one; `gl` = it ran a WebGL look. */
  frame(dtMs: number, gl: boolean): void {
    if (!gl || !(dtMs > 0) || this.div >= this.max) return;
    if (++this.frames <= 3) return; // decoders warming up after play / a seek
    this.ema = this.ema ? this.ema * 0.8 + dtMs * 0.2 : dtMs;
    if (this.frames >= 12 && this.ema > this.budgetMs) {
      this.div *= 2;
      this.frames = 0; // measure again at the new resolution
      this.ema = 0;
    }
  }
}
