/**
 * Waveform peaks from the core (GET /peaks, media/peaks.ts): the timeline
 * fetches 4 × buckets bytes instead of decoding the whole media file in the
 * renderer.
 *  - Access: no token → 401; a file /file would not serve (/etc/passwd, a
 *    media file next to an imported one) → 403; buckets outside 16..8192 or
 *    not an integer → 400; a file without audio → 422.
 *  - Values: channel 0 of a stereo WAV equals the renderer's toPeaks maths on
 *    the WAV's own samples (read here from the RIFF data, not through FFmpeg),
 *    max |diff| ≤ 1e-6.
 *  - Cache: a second request is served from <dataDir>/cache/peaks (a sentinel
 *    written into the cache file comes back, nothing is recomputed); the same
 *    file rewritten with another signal of the same size and a new mtime is
 *    computed again; two requests at once compute once; six files at once all
 *    get their peaks (queued, never refused); pruneDataDir leaves the cache
 *    alone and storageUsage counts it as cache.
 *
 * Run: npx tsx packages/core/scripts/smoke-peaks.ts
 * (Self-contained: synthesizes its media with ffmpeg lavfi, listens on an
 * OS-assigned port.)
 */
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EditorEngine } from "../src/engine.js";
import { EditorServer } from "../src/server.js";
import { runFfmpeg } from "../src/ffmpeg/executor.js";
import { peaksComputedCount } from "../src/media/peaks.js";
import { pruneDataDir } from "../src/gc.js";
import { storageUsage } from "../src/storage.js";

/** Channel 0 of a 16-bit PCM WAV as floats (x / 32768, as FFmpeg and WebAudio convert it). */
function wavChannel0(file: string): Float32Array {
  const b = readFileSync(file);
  let o = 12;
  let channels = 0;
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4);
    const len = b.readUInt32LE(o + 4);
    if (id === "fmt ") channels = b.readUInt16LE(o + 10);
    if (id === "data") {
      const frames = Math.floor(len / (2 * channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) out[i] = b.readInt16LE(o + 8 + i * 2 * channels) / 32768;
      return out;
    }
    o += 8 + len + (len & 1);
  }
  throw new Error(`no data chunk in ${file}`);
}

/** apps/desktop/src/waveform.ts toPeaks over channel-0 samples. */
function toPeaks(ch: Float32Array, buckets: number): Float32Array {
  const n = ch.length;
  const out = new Float32Array(buckets);
  const size = Math.max(1, Math.floor(n / buckets));
  let max = 1e-6;
  for (let i = 0; i < buckets; i++) {
    const start = i * size;
    const end = Math.min(n, start + size);
    let peak = 0;
    for (let j = start; j < end; j++) {
      const a = Math.abs(ch[j]);
      if (a > peak) peak = a;
    }
    out[i] = peak;
    if (peak > max) max = peak;
  }
  const norm = max > 0 ? 1 / max : 1;
  for (let i = 0; i < buckets; i++) out[i] = Math.min(1, out[i] * norm);
  return out;
}

const maxDiff = (a: Float32Array, b: Float32Array) => {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "aive-peaks-"));
  const media = mkdtempSync(join(tmpdir(), "aive-peaks-media-"));
  const engine = new EditorEngine(dataDir);
  const server = new EditorServer(engine, { port: 0, dataDir });
  const port = await server.start();
  const base = `http://127.0.0.1:${port}`;
  const token = (JSON.parse(readFileSync(join(dataDir, "server.json"), "utf8")) as { token: string }).token;

  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  };

  console.log("1. synthesize stereo WAVs (channel 0 and channel 1 differ), a video without audio...");
  // Channel 0: 220 Hz under a slow swell; channel 1: a louder steady 1 kHz tone (a wrong channel shows).
  const stereo = (file: string, f0: number, swell: string) =>
    runFfmpeg([
      "-f", "lavfi", "-i", `aevalsrc=exprs=(${swell})*sin(2*PI*${f0}*t)|0.9*sin(2*PI*1000*t):s=44100:d=3`,
      "-c:a", "pcm_s16le", "-y", file,
    ]);
  const wav = join(media, "tone.wav");
  await stereo(wav, 220, "0.1+0.4*t/3");
  const other = join(media, "other.wav");
  await stereo(other, 330, "0.5-0.15*t");
  const silent = join(media, "silent.mp4");
  await runFfmpeg(["-f", "lavfi", "-i", "testsrc=s=160x90:r=10:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", silent]);
  const copies: string[] = [];
  for (let i = 0; i < 6; i++) {
    copies.push(join(media, `copy${i}.wav`));
    copyFileSync(other, copies[i]);
  }
  await engine.importVideo(wav);
  await engine.importVideo(silent);
  for (const c of copies) await engine.importVideo(c);

  const url = (path: string, q: Record<string, string | number> = {}, withToken = true) => {
    const u = new URL(`${base}/peaks`);
    u.searchParams.set("path", path);
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, String(v));
    if (withToken) u.searchParams.set("token", token);
    return u.toString();
  };
  const peaks = async (path: string, buckets = 1600) => {
    const r = await fetch(url(path, { buckets }));
    const bytes = new Uint8Array(await r.arrayBuffer());
    return { r, bytes, f: new Float32Array(bytes.slice().buffer) };
  };

  console.log("2. access and validation...");
  check((await fetch(url(wav, {}, false))).status === 401, "no token → 401");
  const passwd = await fetch(url("/etc/passwd"));
  const passwdBody = await passwd.text();
  check(passwd.status === 403, `/etc/passwd → 403 (got ${passwd.status})`);
  check(!passwdBody.includes("/etc/passwd"), "the refusal does not echo the path");
  check((await fetch(url(other))).status === 403, "a media file that was never imported → 403");
  for (const b of ["0", "15", "8193", "1.5", "abc", "", "1e3x"]) {
    check((await fetch(url(wav, { buckets: b }))).status === 400, `buckets=${JSON.stringify(b)} → 400`);
  }
  const noAudio = await fetch(url(silent));
  check(noAudio.status === 422, `a video without audio → 422 (got ${noAudio.status})`);

  console.log("3. peaks of channel 0 equal toPeaks over the WAV's own samples...");
  const c0 = peaksComputedCount();
  const first = await peaks(wav);
  check(first.r.status === 200 && first.r.headers.get("content-type") === "application/octet-stream", `200 octet-stream (got ${first.r.status})`);
  check(first.r.headers.get("access-control-allow-origin") === "*", "CORS-readable by the renderer");
  check(first.bytes.length === 4 * 1600, `4 × 1600 bytes (got ${first.bytes.length})`);
  const ref = toPeaks(wavChannel0(wav), 1600);
  const d = maxDiff(first.f, ref);
  check(d <= 1e-6, `max |diff| vs the reference ${d.toExponential(2)} ≤ 1e-6`);
  check(first.f[0] < 0.4 && first.f[1599] > 0.95, `channel 0, not channel 1 (first ${first.f[0].toFixed(3)}, last ${first.f[1599].toFixed(3)})`);
  const dflt = await fetch(url(wav));
  check(dflt.status === 200 && (await dflt.arrayBuffer()).byteLength === 4 * 1600, "no buckets → the default 1600");
  const small = await peaks(wav, 16);
  check(small.r.status === 200 && small.bytes.length === 64 && maxDiff(small.f, toPeaks(wavChannel0(wav), 16)) <= 1e-6, "16 buckets (the minimum) match too");
  check(peaksComputedCount() === c0 + 2, `two computations: the default request was a cache hit (got ${peaksComputedCount() - c0})`);

  console.log("4. cache hit, and invalidation when the file changes...");
  const cacheDir = join(dataDir, "cache", "peaks");
  const cached = readdirSync(cacheDir).filter((n) => n.endsWith(".f32"));
  check(cached.length === 2 && readdirSync(cacheDir).length === 2, `two cache files, no temp left (${readdirSync(cacheDir).join(", ")})`);
  const bigFile = cached.find((n) => readFileSync(join(cacheDir, n)).length === 6400);
  const sentinel = new Float32Array(1600).fill(0.5);
  if (bigFile) writeFileSync(join(cacheDir, bigFile), Buffer.from(sentinel.buffer));
  const second = await peaks(wav);
  check(second.r.status === 200 && maxDiff(second.f, sentinel) === 0, "second request served from the cache file");
  check(peaksComputedCount() === c0 + 2, "…without computing again");
  const before = readFileSync(wav);
  await stereo(join(media, "swap.wav"), 330, "0.5-0.15*t");
  copyFileSync(join(media, "swap.wav"), wav);
  check(readFileSync(wav).length === before.length, `the rewritten file keeps its size (${before.length} bytes)`);
  const later = new Date(Date.now() + 5000);
  utimesSync(wav, later, later);
  const third = await peaks(wav);
  const d3 = maxDiff(third.f, toPeaks(wavChannel0(wav), 1600));
  check(third.r.status === 200 && d3 <= 1e-6, `same size, new mtime → computed again from the new samples (max |diff| ${d3.toExponential(2)})`);
  check(peaksComputedCount() === c0 + 3, "…once");

  console.log("5. concurrency: one job per key, every request answered...");
  const cBefore = peaksComputedCount();
  const [a, b] = await Promise.all([peaks(wav, 800), peaks(wav, 800)]);
  check(a.r.status === 200 && b.r.status === 200 && maxDiff(a.f, b.f) === 0, "two requests at once get the same peaks");
  check(peaksComputedCount() === cBefore + 1, `…computed once (got ${peaksComputedCount() - cBefore})`);
  const many = await Promise.all(copies.map((c) => peaks(c)));
  const refOther = toPeaks(wavChannel0(other), 1600);
  check(many.every((m) => m.r.status === 200 && maxDiff(m.f, refOther) <= 1e-6), `six files at once: ${many.map((m) => m.r.status).join(",")} (queued, none refused)`);

  console.log("6. storage: GC keeps the peaks cache, usage counts it as cache...");
  const n0 = readdirSync(cacheDir).length;
  await pruneDataDir(dataDir, { maxBytes: 0 });
  check(readdirSync(cacheDir).length === n0, `pruneDataDir (budget 0) left all ${n0} peaks files`);
  const usage = await storageUsage(dataDir);
  check(usage.areas.cache.files >= n0 && usage.areas.baked.files === 0 && usage.areas.proxies.files === 0, `storageUsage: cache ${usage.areas.cache.files} files, baked ${usage.areas.baked.files}, proxies ${usage.areas.proxies.files}`);

  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(media, { recursive: true, force: true });
  if (failures) {
    console.log(`\nPEAKS SMOKE TEST FAILED (${failures} check(s))`);
    process.exit(1);
  }
  console.log("\nPEAKS SMOKE TEST PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("PEAKS SMOKE TEST FAILED:", err);
  process.exit(1);
});
