/**
 * Built-in bleep sound effects, synthesized in pure Node (no bundled samples,
 * so no licensing questions). Each is rendered once to a 48 kHz mono 16-bit
 * PCM WAV under <dataDir>/sfx/<name>-v1.wav and then imported like any asset.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BleepSound } from "../types.js";

export type SfxName = BleepSound;
export const SFX_NAMES: readonly SfxName[] = ["beep", "quack", "squeak", "boing", "honk"];

export const SFX_RATE = 48000;
/** Length of the beep tone; long enough to trim to any word. */
export const BEEP_SECONDS = 3;
/** Peak level of every synthesized sound (linear, ~ -1 dBFS). */
const PEAK = 0.89;

const TAU = Math.PI * 2;

/** RBJ constant-0dB-peak band-pass biquad, returned as a stateful sample function. */
function bandpass(freq: number, q: number): (x: number) => number {
  const w0 = (TAU * freq) / SFX_RATE;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w0)) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

/** Deterministic noise so the generated files are byte-stable. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 0x100000000) * 2 - 1;
  };
}

/** Scale to PEAK so no sound clips. */
function normalize(buf: Float32Array): Float32Array {
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < buf.length; i++) buf[i] = (buf[i]! / peak) * PEAK;
  return buf;
}

const saw = (phase: number) => 2 * (phase - Math.floor(phase + 0.5));
const square = (phase: number) => (phase - Math.floor(phase) < 0.5 ? 1 : -1);

/** Synthesize a built-in sound as mono float samples at {@link SFX_RATE}. */
export function synthesizeSfx(name: SfxName): Float32Array {
  const sr = SFX_RATE;
  switch (name) {
    case "beep": {
      const n = Math.round(BEEP_SECONDS * sr);
      const out = new Float32Array(n);
      const fade = Math.round(0.005 * sr);
      for (let i = 0; i < n; i++) {
        const env = Math.min(1, i / fade, (n - 1 - i) / fade);
        out[i] = Math.sin((TAU * 1000 * i) / sr) * env;
      }
      return normalize(out);
    }
    case "quack": {
      const n = Math.round(0.3 * sr);
      const out = new Float32Array(n);
      const f1 = bandpass(1100, 5);
      const f2 = bandpass(2500, 6);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const f0 = 450 * Math.pow(300 / 450, t / 0.3);
        phase += f0 / sr;
        // Raspy buzz: sawtooth with a fast amplitude flutter.
        const src = saw(phase) * (0.75 + 0.25 * Math.sin(TAU * 70 * t));
        const y = 0.2 * src + 1.6 * f1(src) + 0.9 * f2(src);
        const env = Math.min(1, t / 0.008) * Math.exp(-Math.max(0, t - 0.06) / 0.11);
        out[i] = y * env;
      }
      return normalize(out);
    }
    case "squeak": {
      const n = Math.round(0.35 * sr);
      const out = new Float32Array(n);
      const noise = rng(7);
      let phase = 0;
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const u = t / 0.35;
        const base = u < 0.4 ? 1600 + (2800 - 1600) * (u / 0.4) : 2800 + (2200 - 2800) * ((u - 0.4) / 0.6);
        const f = base * (1 + 0.03 * Math.sin(TAU * 28 * t));
        phase += f / sr;
        // Breath: high-passed noise (one-pole LP subtracted).
        const nz = noise();
        lp += 0.2 * (nz - lp);
        const breath = (nz - lp) * 0.08;
        const tone = Math.sin(TAU * phase) + 0.3 * Math.sin(TAU * 2 * phase);
        const env = Math.min(1, t / 0.01) * Math.min(1, (0.35 - t) / 0.07) * (0.7 + 0.3 * Math.sin(Math.PI * u));
        out[i] = (tone + breath) * env;
      }
      return normalize(out);
    }
    case "boing": {
      const n = Math.round(0.5 * sr);
      const out = new Float32Array(n);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const f = 180 + 60 * Math.exp(-t / 0.18) * Math.sin(TAU * 14 * t);
        phase += f / sr;
        const env = Math.min(1, t / 0.003) * Math.exp(-t / 0.25);
        out[i] = (Math.sin(TAU * phase) + 0.3 * Math.sin(TAU * 2 * phase)) * env;
      }
      return normalize(out);
    }
    case "honk": {
      const n = Math.round(0.35 * sr);
      const out = new Float32Array(n);
      const f1 = bandpass(900, 1.5);
      const f2 = bandpass(1500, 2);
      let p1 = 0;
      let p2 = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        p1 += 360 / sr;
        p2 += 453 / sr;
        const src = 0.5 * square(p1) + 0.5 * saw(p2);
        const y = 0.3 * src + 1.2 * f1(src) + 0.8 * f2(src);
        const env = Math.min(1, t / 0.012) * Math.min(1, (0.35 - t) / 0.06);
        out[i] = y * env;
      }
      return normalize(out);
    }
  }
}

/** Encode mono float samples as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, rate = SFX_RATE): Buffer {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/** Natural length in seconds of a built-in sound. */
export function sfxDuration(name: SfxName): number {
  return { beep: BEEP_SECONDS, quack: 0.3, squeak: 0.35, boing: 0.5, honk: 0.35 }[name];
}

/** Write (once) and return the WAV path for a built-in sound. */
export async function ensureSfxFile(dataDir: string, name: SfxName): Promise<string> {
  const dir = join(dataDir, "sfx");
  const path = join(dir, `${name}-v1.wav`);
  if (existsSync(path)) return path;
  await mkdir(dir, { recursive: true });
  await writeFile(path, encodeWav(synthesizeSfx(name)));
  return path;
}
