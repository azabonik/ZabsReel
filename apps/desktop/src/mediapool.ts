// A small pool of hidden <video> decoders the compositor draws from. One element
// is bound to one clip at a time (keyed by clipId) so seeking/decoding state is
// reused frame-to-frame; a <video> decodes audio-only assets too, so the same
// pool feeds both the canvas (video frames) and the audio mix. The pool is
// capped — only a handful of clips are ever live at one playhead (one per track,
// two during a transition overlap) — and least-recently-used clips are evicted.

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
/** playbackRate range browsers accept (Chromium: 1/16..16). */
const MIN_RATE = 0.0625;
const MAX_RATE = 16;
/** Seconds a paused seek lands past srcTime, so a frame boundary shows the frame that starts there. */
const PAUSED_SEEK_NUDGE = 0.001;
/** Least time between two drift-correcting seeks of a curve-speed clip (see sync). */
const FOLLOW_SEEK_GAP_MS = 400;
/** How far (s) a paused element may be from where it should be and still just play on (see resumeNear). */
const RESUME_TOLERANCE = 0.06;
/** How long (ms) a landed constant-speed element must play on without a stall before its drift is judged (see sync). */
const SETTLE_MS = 250;

export interface SyncOpts {
  /** Source time (seconds) this clip should be at. */
  srcTime: number;
  /** Master transport state. */
  playing: boolean;
  /** Clip speed (a speed ramp's speed at `srcTime`). */
  rate: number;
  /**
   * The rate follows a speed CURVE: steer the element toward `srcTime` with a
   * soft rate correction every frame, and only seek on a drift that grows with
   * the rate (a 10x part moves 10 source-seconds per second — a fixed 80 ms
   * window would reseek every frame and stutter).
   */
  follow?: boolean;
  /**
   * Linear volume (already includes fades); 0 + muted when inaudible. el.volume
   * stops at 1: a louder clip plays through its Web Audio route (`routed`).
   */
  volume: number;
  muted: boolean;
  /**
   * The element plays through Web Audio (audiograph.ts): it stays unmuted at
   * full volume and its loudness is the route's GainNode, not el.volume.
   */
  routed?: boolean;
}

export class MediaPool {
  private readonly host: HTMLElement;
  private readonly fileUrl: (path: string) => string;
  private readonly onSeeked: () => void;
  private readonly cap: number;
  private readonly byClip = new Map<string, HTMLVideoElement>();
  /** clipIds ordered oldest→newest for LRU eviction. */
  private readonly lru: string[] = [];
  /** clipIds acquired in the current frame (protected from eviction/pause). */
  private used = new Set<string>();
  /**
   * A playing element's last resync: where it landed, when (0 = it has settled), the start lag learned (s),
   * when it last started advancing without a stall (0 = not advancing) and its currentTime at the last sync.
   */
  private readonly landing = new WeakMap<HTMLVideoElement, { at: number; since: number; lead: number; moved: number; last: number }>();
  /** When each element last seeked to follow a speed curve (performance.now()). */
  private readonly lastFollowSeek = new WeakMap<HTMLVideoElement, number>();

  constructor(host: HTMLElement, fileUrl: (path: string) => string, onSeeked: () => void, cap = 8) {
    this.host = host;
    this.fileUrl = fileUrl;
    this.onSeeked = onSeeked;
    this.cap = cap;
  }

  /** Start a new frame: forget which clips were touched last frame. */
  beginFrame(): void {
    this.used = new Set();
  }

  /** Get (or bind) the decoder element for a clip, pointed at `path`. */
  acquire(clipId: string, path: string): HTMLVideoElement {
    this.used.add(clipId);
    this.touch(clipId);

    let el = this.byClip.get(clipId);
    if (!el) {
      el = this.evictOrCreate();
      el.dataset.clipId = clipId;
      this.byClip.set(clipId, el);
    }
    if (el.dataset.path !== path) {
      el.dataset.path = path;
      el.src = this.fileUrl(path);
      el.load();
    }
    return el;
  }

  /** Drive an element toward `srcTime`, correcting drift sparingly while playing. */
  sync(el: HTMLVideoElement, o: SyncOpts): void {
    const rate = o.rate > 0 ? o.rate : 1;
    if (!o.follow) el.playbackRate = rate;
    if (o.routed) {
      if (el.muted) el.muted = false;
      if (el.volume !== 1) el.volume = 1;
    } else {
      el.muted = o.muted || o.volume <= 0;
      el.volume = clamp01(o.volume);
    }
    if (!Number.isFinite(o.srcTime)) return;

    if (o.playing) {
      if (o.follow) {
        // Curve speed: rate = the curve's speed + a proportional pull toward the
        // expected source time (closes the gap in ~0.1 s), clamped to what
        // browsers play. Seek only past a rate-scaled threshold, never while a
        // seek is still pending and at most every FOLLOW_SEEK_GAP_MS: when the
        // decoder can't keep up (8x on a loaded machine) seeking every frame
        // only restarts decoding at a keyframe and falls further behind (seek
        // thrash). A seek while behind lands a little AHEAD — about what the
        // playhead covers during a seek — so it is not behind again on arrival.
        const err = o.srcTime - el.currentTime;
        const steer = Math.min(rate * 3, Math.max(rate * 0.5, rate + 12 * err));
        el.playbackRate = Math.min(MAX_RATE, Math.max(MIN_RATE, steer));
        const now = performance.now();
        const seekTo = (t: number) => {
          this.lastFollowSeek.set(el, now);
          this.safeSeek(el, t);
        };
        if (el.paused) {
          seekTo(o.srcTime);
          void el.play().catch(() => {});
        } else if (!el.seeking && Math.abs(err) > 0.08 * Math.max(1, rate) && now - (this.lastFollowSeek.get(el) ?? -Infinity) > FOLLOW_SEEK_GAP_MS) {
          seekTo(o.srcTime + (err > 0 ? Math.min(0.5, 0.06 * rate) : 0));
        }
        return;
      }
      // A seek takes a while to play again (decoding from a keyframe, the
      // audio output restarting). With a real audio sink the element plays
      // 30-50 ms after a seek lands, then currentTime freezes 80-130 ms while
      // the audio output restarts (measured on WSLg Pulse; longer on
      // Bluetooth). Judging the drift at that first motion seeks into the
      // stall again and again (seek thrash: 13-15 seeks in 2 s in 24% of
      // runs), so a landing seek is left alone until the element has played
      // on WITHOUT a stall for SETTLE_MS (a stall restarts the wait), or 1 s
      // passes, and the next one lands ahead by the start lag that one showed.
      const now = performance.now();
      const r = this.landing.get(el) ?? { at: NaN, since: 0, lead: 0, moved: 0, last: NaN };
      const seekAhead = () => {
        r.at = o.srcTime + r.lead * rate;
        r.since = now;
        r.moved = 0;
        r.last = NaN;
        this.landing.set(el, r);
        this.safeSeek(el, r.at);
      };
      if (el.paused) {
        seekAhead();
        void el.play().catch(() => {});
        return;
      }
      if (r.since) {
        const t = el.currentTime;
        const moved = !el.seeking && t > r.at + 1e-3;
        const advancing = moved && t > r.last + 1e-4;
        r.last = t;
        if (!advancing) r.moved = 0;
        else if (!r.moved) r.moved = now;
        if ((!r.moved || now - r.moved < SETTLE_MS) && now - r.since < 1000) return;
        if (moved) r.lead = Math.min(0.5, Math.max(0, r.lead + (o.srcTime - t) / rate));
        r.since = 0;
        r.moved = 0;
      }
      // Re-sync only on meaningful drift — constant reseeking would stutter.
      if (Math.abs(el.currentTime - o.srcTime) > 0.08) seekAhead();
    } else {
      if (o.follow) el.playbackRate = Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
      if (!el.paused) el.pause();
      // Paused: show the frame the export shows at srcTime (the one whose
      // interval holds it). Chromium seeks in whole microseconds, so a seek to
      // exactly n/fps can land on frame n - 1; a 1 ms nudge keeps it on n. The
      // tolerance is below a 120 fps frame, so a one-frame step always seeks.
      const dur = el.duration;
      const target = Math.min(o.srcTime + PAUSED_SEEK_NUDGE, Number.isFinite(dur) && dur > 0 ? dur : Infinity);
      if (Math.abs(el.currentTime - target) > 0.003) this.safeSeek(el, target);
    }
  }

  /** Pause every element not acquired in the current frame (it left the playhead). */
  endFrame(): void {
    for (const [clipId, el] of this.byClip) {
      if (!this.used.has(clipId) && !el.paused) el.pause();
    }
  }

  /**
   * Play a paused element that already sits at `srcTime` (within RESUME_TOLERANCE): a clip parked on its first
   * frame ahead of a cut, or playback resuming where it was paused. sync's seek-and-play would drop it to
   * HAVE_METADATA for the seek — a frame the canvas can't draw. Anything else is left to sync.
   */
  resumeNear(el: HTMLVideoElement, srcTime: number, rate: number): void {
    if (!el.paused || el.seeking || el.readyState < 2 || !Number.isFinite(srcTime)) return;
    if (Math.abs(el.currentTime - srcTime) > RESUME_TOLERANCE) return;
    el.playbackRate = Math.min(MAX_RATE, Math.max(MIN_RATE, rate > 0 ? rate : 1));
    void el.play().catch(() => {});
  }

  /** Pause all decoders (transport stop / empty timeline). */
  pauseAll(): void {
    for (const el of this.byClip.values()) if (!el.paused) el.pause();
  }

  /** Tear down: remove every element from the DOM. */
  destroy(): void {
    for (const el of this.byClip.values()) {
      el.pause();
      el.removeAttribute("src");
      el.load();
      el.remove();
    }
    this.byClip.clear();
    this.lru.length = 0;
  }

  private safeSeek(el: HTMLVideoElement, srcTime: number): void {
    try {
      el.currentTime = Math.max(0, srcTime);
    } catch {
      /* seeking before metadata — onSeeked / readiness will catch up */
    }
  }

  private touch(clipId: string): void {
    const i = this.lru.indexOf(clipId);
    if (i >= 0) this.lru.splice(i, 1);
    this.lru.push(clipId);
  }

  /** Reuse the least-recently-used idle element if at capacity, else make one. */
  private evictOrCreate(): HTMLVideoElement {
    if (this.byClip.size >= this.cap) {
      const victim = this.lru.find((id) => !this.used.has(id));
      if (victim) {
        const el = this.byClip.get(victim)!;
        this.byClip.delete(victim);
        this.lru.splice(this.lru.indexOf(victim), 1);
        el.pause();
        delete el.dataset.clipId;
        delete el.dataset.path;
        el.removeAttribute("src");
        el.load();
        return el;
      }
    }
    return this.create();
  }

  private create(): HTMLVideoElement {
    const el = document.createElement("video");
    el.playsInline = true;
    el.preload = "auto";
    el.muted = true;
    // Speed changes (constant or curve) keep the voice's pitch, like the export's atempo.
    el.preservesPitch = true;
    el.crossOrigin = "anonymous";
    el.addEventListener("seeked", this.onSeeked);
    el.addEventListener("loadeddata", this.onSeeked);
    this.host.appendChild(el);
    return el;
  }
}
