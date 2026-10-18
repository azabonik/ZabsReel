import { runFfmpeg } from "../ffmpeg/executor.js";
import { atempoFactors } from "../ffmpeg/graph.js";
import { MotionRenderError } from "./motionerror.js";
import type { MotionAsset, PageAsset } from "./motionmedia.js";

/**
 * The audio of ZabsReel's own motion graphics (MOTION-PLAN D4 E3; D-AUDIO,
 * D-MIXOUT, R3-G2). <Audio> and a library video's sound never play in the
 * page: each frame's report (frameReady(n, cues)) carries one cue per
 * audible source, {sourceKey, handle, sourceTime, volume}. The core checks
 * every cue as its frame arrives ({@link GraphicAudio.add}), merges the cues
 * into ranges once the frames are done ({@link GraphicAudio.ranges}), and
 * after the video is encoded mixes the ranges with executor.ts's FFmpeg into
 * one 48 kHz stereo track inside the render's folder ({@link mixArgs}).
 *
 * A range is a run of consecutive frames of one source (sourceKey) whose
 * source time goes on at one rate (a playbackRate other than 1 shows as
 * steps of rate/fps seconds; it plays at the original pitch, through atempo)
 * and whose volume stays the same or changes by the same amount every frame
 * (a linear ramp). Any other change starts a new range.
 */

/** D4's audio caps; tests pass smaller ones. */
export interface AudioCaps {
  /** Cues (audible sources) in one composition frame. */
  perFrame: number;
  /** Ranges in one render, after merging. */
  ranges: number;
  /** Distinct audio files (library assets) in one render: the mix's FFmpeg inputs. */
  sources: number;
}

export const AUDIO_CAPS: Readonly<AudioCaps> = { perFrame: 8, ranges: 256, sources: 16 };

/** The loudest a cue plays (D4: volume clamped to 0..4). */
export const MAX_VOLUME = 4;
/** The mix's sample rate (the export's, and the runtime's defaultSampleRate). */
export const MIX_RATE = 48_000;
/** Playback rates a range may have; a step outside them starts a new range. */
const MIN_RATE = 1 / 16;
const MAX_RATE = 16;
/** How far a frame's source time (s) and volume may sit off its range's line and still extend it. */
const TIME_EPS = 1e-6;
const VOLUME_EPS = 1e-4;

/** A merged run of one source's cues: what the mix plays. */
export interface AudioRange {
  handle: string;
  /** Its first composition frame, and how many frames it lasts. */
  frame: number;
  frames: number;
  /** Seconds into the source at its first frame. */
  sourceTime: number;
  /** Source seconds per composition second (1 for a range of one frame). */
  rate: number;
  /** Volume at its first frame, and its change per frame. */
  volume: number;
  step: number;
}

/** What a render's audio did. */
export interface AudioStats {
  cues: number;
  /** Ranges after merging (set once the frames are done). */
  ranges: number;
  /** Distinct audio files. */
  sources: number;
}

/** The asset behind a handle, as the core keeps it (motionmedia.ts). */
export interface AudioSource {
  id: string;
  asset: MotionAsset;
  info: PageAsset;
}

interface Cue {
  key: string;
  handle: string;
  t: number;
  v: number;
}

/** One render's audio cues, checked as each frame arrives. */
export class GraphicAudio {
  readonly stats: AudioStats = { cues: 0, ranges: 0, sources: 0 };
  /** Composition frame -> its cues (past their source's end left out). */
  private frames = new Map<number, Cue[]>();
  private handles = new Set<string>();

  constructor(
    private source: (handle: string) => AudioSource | undefined,
    private o: { fps: number; caps: AudioCaps; requireMedia: (asset: MotionAsset) => void },
  ) {}

  /**
   * Frame `n`'s cues as the renderer sent them (JSON: a NaN volume arrives
   * as null). Throws the named error that ends the render: more cues than
   * caps.perFrame, a source time before 0, a handle with no sound, more
   * distinct audio files than caps.sources, an offline file (the caller's
   * requireMedia, before the mix ever opens it).
   */
  add(n: number, cues: unknown): void {
    const list = cues === undefined ? [] : cues;
    if (!Array.isArray(list)) throw unreadable();
    const { caps } = this.o;
    if (list.length > caps.perFrame) {
      throw new MotionRenderError("graphic_audio_cues_cap", `Frame ${n} of the graphic plays more than ${caps.perFrame} sounds at once. Play at most ${caps.perFrame} <Audio> or <Video> sounds at the same time.`);
    }
    const kept: Cue[] = [];
    for (const c of list as unknown[]) {
      if (!c || typeof c !== "object") throw unreadable();
      const { sourceKey, handle, sourceTime, volume } = c as Record<string, unknown>;
      if (typeof sourceKey !== "string" || sourceKey.length > 64 || typeof handle !== "string") throw unreadable();
      if (typeof sourceTime !== "number" || !Number.isFinite(sourceTime) || (volume !== null && typeof volume !== "number")) throw unreadable();
      const e = this.source(handle);
      if (!e) throw unreadable();
      const duration = e.info.kind === "audio" || (e.info.kind === "video" && e.info.hasAudio === true) ? e.info.durationSeconds : undefined;
      if (duration === undefined) {
        throw new MotionRenderError("graphic_asset_kind", `The asset "${e.id}" has no sound to play. Give <Audio> an audio asset, or a video asset that has sound.`);
      }
      if (sourceTime < 0) {
        throw new MotionRenderError("graphic_media_time", `The audio "${e.id}" was asked for at ${sourceTime} s, before its start. Check its trimBefore and the timing around it.`);
      }
      if (!this.handles.has(handle)) {
        if (this.handles.size >= caps.sources) {
          throw new MotionRenderError("graphic_audio_cues_cap", `The graphic plays more than ${caps.sources} different audio files. Use at most ${caps.sources} audio or video assets with sound in one graphic.`);
        }
        this.o.requireMedia(e.asset);
        this.handles.add(handle);
        this.stats.sources = this.handles.size;
      }
      this.stats.cues++;
      // Past the source's end: silence there (D4: trimmed).
      if (sourceTime >= duration) continue;
      const v = typeof volume === "number" && !Number.isNaN(volume) ? Math.min(MAX_VOLUME, Math.max(0, volume)) : 0;
      kept.push({ key: sourceKey, handle, t: sourceTime, v });
    }
    if (kept.length) this.frames.set(n, kept);
  }

  /** The cues merged into ranges, in frame order. Throws graphic_audio_cues_cap past caps.ranges. */
  ranges(): AudioRange[] {
    const { fps, caps } = this.o;
    const out: AudioRange[] = [];
    const open = new Map<string, AudioRange>();
    for (const n of [...this.frames.keys()].sort((a, b) => a - b)) {
      for (const c of this.frames.get(n) as Cue[]) {
        const r = open.get(c.key);
        if (r && r.handle === c.handle && r.frame + r.frames === n && extend(r, c, fps)) continue;
        if (out.length >= caps.ranges) {
          throw new MotionRenderError(
            "graphic_audio_cues_cap",
            `The graphic's sound changes in more than ${caps.ranges} places (each jump in a source's time, change of playbackRate or volume curve that is not a straight line starts a new piece). Use fewer, longer sounds, or volume changes that are straight lines.`,
          );
        }
        const next: AudioRange = { handle: c.handle, frame: n, frames: 1, sourceTime: c.t, rate: 1, volume: c.v, step: 0 };
        out.push(next);
        open.set(c.key, next);
      }
    }
    this.stats.ranges = out.length;
    return out;
  }
}

const unreadable = () => new MotionRenderError("graphic_render_crashed", "The graphics renderer sent an unreadable audio cue.");

/**
 * Extends `r` by cue `c` (on the frame after it) when `c` lies on its line:
 * the second frame sets the range's rate and volume step, every later one
 * must match them.
 */
function extend(r: AudioRange, c: Cue, fps: number): boolean {
  const k = r.frames;
  if (k === 1) {
    const rate = (c.t - r.sourceTime) * fps;
    if (!(rate >= MIN_RATE && rate <= MAX_RATE)) return false;
    r.rate = rate;
    r.step = c.v - r.volume;
  } else if (Math.abs(r.sourceTime + (k * r.rate) / fps - c.t) > TIME_EPS || Math.abs(r.volume + k * r.step - c.v) > VOLUME_EPS) {
    return false;
  }
  r.frames++;
  return true;
}

/** A number for a filter expression: fixed digits (never an exponent, which time options do not read). */
const num = (x: number, digits = 6) => x.toFixed(digits).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
const rateOf = (r: AudioRange) => (Math.abs(r.rate - 1) > 1e-6 ? r.rate : 1);

/**
 * FFmpeg's arguments for the mix of `ranges` into `out` (48 kHz stereo
 * 16-bit WAV, exactly the graphic's length), in the chain family graph.ts
 * uses for a speed-ramped clip's audio: one input per audio file (at most
 * caps.sources), seeked to the part the ranges use, split once per range;
 * each range trimmed to its source span (atrim/asetpts), time-stretched at
 * the original pitch (atempo, whose window plays content a few ms early,
 * graph.ts atempoLeadSamples; not corrected here), its volume (a linear
 * ramp in output time from its first cue's volume to its last one's, held
 * for its last frame: volume eval=frame, clamped to 0..4), pinned to its
 * exact sample count and delayed to its first frame (adelay); then mixed
 * unnormalized over a silent base of the whole length (amix normalize=0).
 * One input per range would repeat each input's format and protocol
 * allowlists 256 times, past Windows' 32,767-character command line.
 */
export function mixArgs(ranges: readonly AudioRange[], pathOf: (handle: string) => string, o: { fps: number; durationInFrames: number }, out: string): string[] {
  const { fps } = o;
  const sampleAt = (frame: number) => Math.round((frame / fps) * MIX_RATE);
  const inputs: string[] = [];
  const parts: string[] = [];
  const mixed: string[] = [];
  const byHandle = new Map<string, AudioRange[]>();
  for (const r of ranges) byHandle.set(r.handle, [...(byHandle.get(r.handle) ?? []), r]);
  let k = 0;
  for (const [handle, list] of byHandle) {
    const input = k++;
    const from = Number(Math.min(...list.map((r) => r.sourceTime)).toFixed(6));
    const to = Math.max(...list.map((r) => r.sourceTime + (r.frames * rateOf(r)) / fps));
    // A little past the last range: the ranges' own atrim decides where each ends.
    inputs.push("-ss", from.toFixed(6), "-t", (to - from + 0.1).toFixed(6), "-i", pathOf(handle));
    const labels = list.map((_, j) => `s${input}_${j}`);
    if (list.length > 1) parts.push(`[${input}:a]asplit=${list.length}${labels.map((l) => `[${l}]`).join("")}`);
    list.forEach((r, j) => {
      const rate = rateOf(r);
      const start = Math.max(0, r.sourceTime - from);
      const at = sampleAt(r.frame);
      const steps = [`atrim=start=${num(start)}:end=${num(start + (r.frames * rate) / fps)}`, "asetpts=PTS-STARTPTS"];
      if (rate !== 1) for (const f of atempoFactors(rate)) steps.push(`atempo=${f}`);
      if (r.step !== 0) {
        // From the first cue's volume to the last one's, then held for the range's last frame.
        const perSecond = r.step * fps;
        const ramp = `${num(r.volume, 9)}${perSecond < 0 ? "-" : "+"}${num(Math.abs(perSecond), 9)}*min(t,${num((r.frames - 1) / fps, 9)})`;
        steps.push(`volume=eval=frame:volume='max(0,min(${MAX_VOLUME},${ramp}))'`);
      } else if (r.volume !== 1) {
        steps.push(`volume=${num(r.volume, 9)}`);
      }
      steps.push(
        `aresample=${MIX_RATE}`,
        "aformat=channel_layouts=stereo",
        "apad",
        `atrim=end_sample=${sampleAt(r.frame + r.frames) - at}`,
        "asetpts=PTS-STARTPTS",
      );
      if (at > 0) steps.push(`adelay=delays=${at}S:all=1`);
      // graph.ts: FFmpeg 4.4's amix can stall for good on inputs whose frame sizes wander (atempo).
      steps.push("asetnsamples=n=1024:p=0");
      parts.push(`${list.length > 1 ? `[${labels[j]}]` : `[${input}:a]`}${steps.join(",")}[m${input}_${j}]`);
      mixed.push(`[m${input}_${j}]`);
    });
  }
  const total = sampleAt(o.durationInFrames);
  const base = k;
  inputs.push("-f", "lavfi", "-t", (o.durationInFrames / fps + 0.1).toFixed(6), "-i", `anullsrc=channel_layout=stereo:sample_rate=${MIX_RATE}`);
  parts.push(`[${base}:a]asetpts=PTS-STARTPTS[base]`);
  parts.push(`[base]${mixed.join("")}amix=inputs=${mixed.length + 1}:duration=longest:normalize=0,aformat=channel_layouts=stereo,aresample=${MIX_RATE},apad,atrim=end_sample=${total}[mix]`);
  return ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", parts.join(";"), "-map", "[mix]", "-c:a", "pcm_s16le", "-ar", String(MIX_RATE), "-ac", "2", "-f", "wav", out];
}

/** FFmpeg's arguments for a standalone graphic's file: its video copied, the mix as AAC. */
export function muxArgs(video: string, wav: string, out: string): string[] {
  return ["-hide_banner", "-loglevel", "error", "-y", "-i", video, "-i", wav, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out];
}

/** The mix's limit (D4): 60 s + 2 x the graphic's length. */
export function mixLimitMs(durationInFrames: number, fps: number): number {
  return 60_000 + Math.round((2000 * durationInFrames) / fps);
}

/**
 * Mixes `ranges` into `wav` and, for a standalone graphic, muxes it with
 * `video` into `muxed`, through executor.ts's FFmpeg in `workDir` (a long
 * graph's file lands there too). Past `limitMs` the work is stopped and the
 * render ends with graphic_mix_timeout; the caller's own abort, and an
 * FFmpeg error, are thrown as they are.
 */
export async function mixGraphicAudio(o: {
  ranges: readonly AudioRange[];
  pathOf: (handle: string) => string;
  fps: number;
  durationInFrames: number;
  wav: string;
  mux?: { video: string; out: string };
  workDir: string;
  limitMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  const timeout = AbortSignal.timeout(Math.max(1, o.limitMs));
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  try {
    await runFfmpeg(mixArgs(o.ranges, o.pathOf, o, o.wav), { signal, cwd: o.workDir });
    if (o.mux) await runFfmpeg(muxArgs(o.mux.video, o.wav, o.mux.out), { signal, cwd: o.workDir });
  } catch (err) {
    if (timeout.aborted && !o.signal?.aborted) {
      throw new MotionRenderError(
        "graphic_mix_timeout",
        `Mixing the graphic's sound took longer than ${Math.round(o.limitMs / 1000)} s. Use fewer or shorter sounds, or fewer changes in them, and try again.`,
      );
    }
    throw err;
  }
}
