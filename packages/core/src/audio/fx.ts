/**
 * Engine-side helpers for per-clip AUDIO effects (the vocabulary itself is the
 * pure registry in ../effects/audio.ts): the stack edits behind
 * apply_audio_effect / remove_audio_effect / reorder_audio_effect /
 * enhance_voice, and the render-time FFmpeg capability probe (rubberband).
 */
import { stat } from "../io/gatedfs.js";
import { FFMPEG_BIN, anlmdnWorks, ffmpegVersion, runTool, spawnFfmpegStream } from "../ffmpeg/executor.js";
import { hasAfftdnV2, hasAfftfiltV2 } from "../ffmpeg/version.js";
import { newId } from "../ids.js";
import {
  AUDIO_EFFECT_CATEGORIES, AUDIO_FX_RATE, audioEffectByType, audioMeasureSteps, audioParamValue, hasLoudnessStage, isAudioEffectEnabled,
} from "../effects/audio.js";
import { muteGainExpr, type SourceMute } from "./mutes.js";
import type { AudioFilterCaps } from "../effects/audio.js";
import type { AudioEffect, Clip, ResolvedEffects } from "../types.js";

/** Pitch-shifting types (rubberband, or the asetrate+atempo fallback). */
const PITCH_TYPES = new Set(["pitch", "chipmunk", "deep"]);

let filtersPromise: Promise<Set<string>> | null = null;

/**
 * Filter names in `ffmpeg -filters` output. Lines look like
 * " TSC afftdn            A->A       Denoise audio samples using FFT." — three
 * flag columns up to FFmpeg 7.x, two (" TS afftdn …") from 8.0, where the
 * command-support column was dropped.
 */
export function parseFilterList(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*[A-Z.|]{2,3}\s+(\S+)\s+\S+->\S+/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

/** The filter names this ffmpeg build ships (`ffmpeg -filters`), probed once per process. */
export function detectFilters(): Promise<Set<string>> {
  if (!filtersPromise) {
    filtersPromise = runTool(FFMPEG_BIN, ["-hide_banner", "-filters"], { reject: true })
      .then((r) => parseFilterList(r.stdout))
      .catch(() => new Set<string>());
  }
  return filtersPromise;
}

/** Types whose FFmpeg chain runs afftdn (noise_reduction; enhance_voice with denoise on). */
const DENOISE_TYPES = new Set(["noise_reduction", "enhance_voice"]);

/**
 * The {@link AudioFilterCaps} of this FFmpeg that matter for `filters`, or
 * undefined when none do (FFmpeg 4.4, or neither a denoiser nor a robot): the
 * rewritten afftdn (FFmpeg ≥ 5) for a denoiser, the rewritten afftfilt
 * (FFmpeg ≥ 5.1) for a robot and, only when a heavy noise reduction is in the
 * stack, whether anlmdn runs at all (it crashes FFmpeg 9.0).
 */
export async function audioFilterCaps(filters: readonly AudioEffect[]): Promise<AudioFilterCaps | undefined> {
  const on = filters.filter((f) => isAudioEffectEnabled(f));
  const denoise = on.some((f) => DENOISE_TYPES.has(f.type));
  const robot = on.some((f) => f.type === "robot");
  if (!denoise && !robot) return undefined;
  const v = await ffmpegVersion().catch(() => null);
  const caps: AudioFilterCaps = {};
  if (denoise && hasAfftdnV2(v)) caps.afftdnV2 = true;
  if (robot && hasAfftfiltV2(v)) caps.afftfiltV2 = true;
  if (on.some((f) => f.type === "noise_reduction" && audioParamValue(f, "heavy") >= 0.5) && !(await anlmdnWorks())) caps.noAnlmdn = true;
  return Object.keys(caps).length ? caps : undefined;
}

/** The stretch of source audio a clip's effects run on (for render-time measurements). */
export interface AudioFxSource {
  path: string;
  /** Source seconds. */
  sourceIn: number;
  sourceSpan: number;
  /** Bleep mutes (asset seconds), applied before the effects. */
  mutes?: SourceMute[];
}

/**
 * The render-time audio-effect fields of a clip's resolved effects: its stack;
 * `pitchFallback` when it pitch-shifts and FFmpeg has no rubberband
 * (AIVE_NO_RUBBERBAND=1 forces the fallback — smoke-voice tests it); and, for
 * each loudness stage (normalize, enhance_voice), the measured loudness of the
 * audio entering it, so the stage is an exact linear gain (measureLoudness).
 * Without `src` nothing is measured (video-only renders never play the audio);
 * `signal` cancels a measurement in progress.
 */
export async function resolveAudioFx(
  filters: AudioEffect[] | undefined,
  src?: AudioFxSource,
  signal?: AbortSignal,
): Promise<Pick<ResolvedEffects, "audioFilters" | "pitchFallback" | "loudness" | "audioCaps">> {
  if (!filters?.length) return {};
  const pitches = filters.some((f) => isAudioEffectEnabled(f) && PITCH_TYPES.has(f.type));
  const pitchFallback = pitches && (process.env.AIVE_NO_RUBBERBAND === "1" || !(await detectFilters()).has("rubberband"));
  const caps = await audioFilterCaps(filters);
  const out: Pick<ResolvedEffects, "audioFilters" | "pitchFallback" | "loudness" | "audioCaps"> = { audioFilters: filters };
  if (pitchFallback) out.pitchFallback = true;
  if (caps) out.audioCaps = caps;
  if (!src) return out;
  const loudness: Record<string, number> = {};
  for (const f of filters) {
    if (!hasLoudnessStage(f)) continue;
    const steps = audioMeasureSteps(filters, f.id, { pitchFallback, loudness, caps });
    if (!steps) continue;
    const L = await measureLoudness(src, steps, signal);
    if (L !== null) loudness[f.id] = L;
  }
  if (Object.keys(loudness).length) out.loudness = loudness;
  return out;
}

const loudnessCache = new Map<string, number | null>();

/**
 * Integrated loudness (LUFS, ebur128 on the clip's own channels — the mix
 * plays a mono clip as mono or at −3 dB per side, the same loudness) of a
 * clip's source audio after `steps`, the
 * same chain the render runs up to that point (graph.ts audioFilterChain:
 * asetpts → bleep mutes → resample → effects). Cached per file + mtime +
 * range + chain, so only an edit that changes what feeds the stage re-measures.
 * Null when it can't be measured (the stage then falls back to loudnorm).
 * `signal` (the render job's) kills the pass: it then throws and caches nothing.
 */
export async function measureLoudness(src: AudioFxSource, steps: string[], signal?: AbortSignal): Promise<number | null> {
  let mtime = -1;
  try {
    mtime = Math.round((await stat(src.path)).mtimeMs);
  } catch {
    return null;
  }
  const chain = ["asetpts=PTS-STARTPTS"];
  if (src.mutes?.length) chain.push(`aeval='val(ch)*${muteGainExpr(src.mutes, src.sourceIn)}':c=same`);
  chain.push(`aresample=${AUDIO_FX_RATE}`, ...steps, "ebur128");
  const key = JSON.stringify([src.path, mtime, src.sourceIn.toFixed(6), src.sourceSpan.toFixed(6), chain]);
  if (loudnessCache.has(key)) return loudnessCache.get(key)!;
  let L: number | null = null;
  try {
    const args = [
      "-hide_banner", "-nostats", "-ss", src.sourceIn.toFixed(6), "-t", src.sourceSpan.toFixed(6), "-i", src.path,
      "-vn", "-af", chain.join(","), "-f", "null", "-",
    ];
    const r = await spawnFfmpegStream(args, { reject: true, ...(signal ? { cancelSignal: signal } : {}) });
    const m = [...r.stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)];
    if (m.length) L = Number(m[m.length - 1][1]);
  } catch (err) {
    if (signal?.aborted) throw err; // canceled, not unmeasurable: don't cache a fallback
    L = null;
  }
  loudnessCache.set(key, L);
  return L;
}

const floorCache = new Map<string, number | null>();

/** Analysis rate / window for the noise-floor measure. */
const FLOOR_RATE = 16000;
const FLOOR_WIN = Math.round(FLOOR_RATE * 0.03);
/** At most this many seconds are analysed (from the clip's in-point). */
const FLOOR_MAX_SEC = 300;

/**
 * The noise floor of a stretch of a file's audio, in dBFS RMS: the 5th
 * percentile of 30 ms window levels (speech always has gaps between words, so
 * the quietest windows are the room/hiss/hum alone). Digital silence is
 * ignored. Streams the decode (memory stays flat for long clips), analyses at
 * most {@link FLOOR_MAX_SEC} seconds, and caches per file + mtime + range.
 * Null when the audio is silent or can't be read.
 */
export async function measureNoiseFloor(path: string, startSec: number, durSec: number): Promise<number | null> {
  const dur = Math.max(0.1, Math.min(FLOOR_MAX_SEC, durSec));
  let mtime = -1;
  try {
    mtime = Math.round((await stat(path)).mtimeMs);
  } catch {
    return null;
  }
  const key = `${path}|${mtime}|${startSec.toFixed(3)}|${dur.toFixed(3)}`;
  if (floorCache.has(key)) return floorCache.get(key)!;
  const floorArgs = [
    "-hide_banner", "-v", "error", "-ss", startSec.toFixed(3), "-t", dur.toFixed(3), "-i", path,
    "-vn", "-ac", "1", "-ar", String(FLOOR_RATE), "-f", "f32le", "-",
  ];
  const levels = await new Promise<number[]>((resolve) => {
    const levelsOut: number[] = [];
    const child = spawnFfmpegStream(floorArgs, { stdin: "ignore", stderr: "ignore", buffer: false, reject: false });
    let carry: Buffer = Buffer.alloc(0);
    let sum = 0;
    let n = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      const buf: Buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const whole = buf.length - (buf.length % 4);
      for (let i = 0; i < whole; i += 4) {
        const v = buf.readFloatLE(i);
        sum += v * v;
        if (++n === FLOOR_WIN) {
          const rms = Math.sqrt(sum / n);
          if (rms > 1e-5) levelsOut.push(20 * Math.log10(rms)); // skip digital silence (< −100 dBFS)
          sum = 0;
          n = 0;
        }
      }
      carry = buf.subarray(whole);
    });
    child.on("error", () => resolve([]));
    child.on("close", () => resolve(levelsOut));
  });
  let floor: number | null = null;
  if (levels.length >= 5) {
    levels.sort((a, b) => a - b);
    floor = Math.round(levels[Math.floor(levels.length * 0.05)]);
  }
  floorCache.set(key, floor);
  return floor;
}

/** Signal-chain rank of a type (enhance → cleanup → tone → dynamics → voice changer). */
function rank(type: string): number {
  const cat = audioEffectByType(type)?.category;
  return cat ? AUDIO_EFFECT_CATEGORIES.indexOf(cat) : AUDIO_EFFECT_CATEGORIES.length;
}

/** What apply_audio_effect / enhance_voice write. */
export interface AudioEffectPatch {
  id?: string;
  type: string;
  params?: Record<string, number>;
  enabled?: boolean;
}

/**
 * Add (or update by id) an audio effect on `clip` IN PLACE; returns its id.
 * An update REPLACES type + params — except a bare bypass toggle (only
 * `enabled`, same type), which keeps the values. A NEW effect slots in at
 * signal-chain position: after every effect of the same or an earlier
 * category, so cleanup runs before tone, dynamics and voice changers.
 * `enabled: false` is the only stored state (absent = on).
 */
export function upsertAudioEffect(clip: Clip, patch: AudioEffectPatch): string {
  const effects = clip.effects ?? (clip.effects = {});
  const list = effects.audioFilters ?? (effects.audioFilters = []);
  const existing = patch.id ? list.find((f) => f.id === patch.id) : undefined;
  let target: AudioEffect;
  const toggleOnly = patch.enabled !== undefined && patch.params === undefined;
  if (existing && toggleOnly && existing.type === patch.type) {
    target = existing;
  } else if (existing) {
    existing.type = patch.type;
    if (patch.params && Object.keys(patch.params).length) existing.params = { ...patch.params };
    else delete existing.params;
    target = existing;
  } else {
    target = { id: patch.id ?? newId("afx"), type: patch.type };
    if (patch.params && Object.keys(patch.params).length) target.params = { ...patch.params };
    const r = rank(patch.type);
    let at = list.length;
    while (at > 0 && rank(list[at - 1].type) > r) at--;
    list.splice(at, 0, target);
  }
  if (patch.enabled === false) target.enabled = false;
  else if (patch.enabled === true) delete target.enabled;
  return target.id;
}

/** Remove one audio effect from `clip` in place (drops the empty list). */
export function removeAudioEffectFrom(clip: Clip, effectId: string): void {
  const fx = clip.effects;
  if (!fx?.audioFilters) return;
  fx.audioFilters = fx.audioFilters.filter((f) => f.id !== effectId);
  if (fx.audioFilters.length === 0) delete fx.audioFilters;
}

/** Move one audio effect to `toIndex` (clamped) in place. */
export function reorderAudioEffectIn(clip: Clip, effectId: string, toIndex: number): void {
  const list = clip.effects?.audioFilters;
  if (!list) return;
  const from = list.findIndex((f) => f.id === effectId);
  if (from < 0) return;
  const to = Math.max(0, Math.min(list.length - 1, Math.round(toIndex)));
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
}

/** "afx_1 (echo), afx_2 (pitch)" — for teaching errors. */
export function describeAudioStack(clip: Clip): string {
  return (clip.effects?.audioFilters ?? []).map((f) => `${f.id} (${f.type})`).join(", ");
}
