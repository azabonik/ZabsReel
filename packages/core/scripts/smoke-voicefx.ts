/**
 * Live preview of the pitch and robot voice effects (the voice AudioWorklet,
 * src/effects/voiceworklet.ts, built into chains by apps/desktop/src/audiograph.ts).
 *
 *  1. The worklet's DSP in Node (the processor source evaluated with a tiny
 *     AudioWorkletProcessor stand-in, 128-sample render quanta):
 *     - pitch +12 / -12 / +4 st on a 440 Hz tone: dominant 880 / 220 / 554 Hz,
 *       level within 2 dB, length unchanged; 0 st builds no node (as the export);
 *     - robot (tone 0/1/2 = win 2048/1024/512) == the export's own filter
 *       (FFmpeg afftfilt), after the documented latency (fft size − 128):
 *       sample for sample on FFmpeg 4.4/5.0, within −55 dB on 5.1+ (afftfilt
 *       was rewritten; the export rebuilds 4.4's maths, audio.ts robotSteps);
 *     - pitch vs the export's rubberband on a harmonic voice-like signal:
 *       long-term log spectra correlate (> 0.97).
 *  2. Headless Chromium (playwright-core): the REAL renderer code
 *     (audiograph.ts buildChain + loadVoiceWorklet, bundled minified like the
 *     Vite build) renders a 440 Hz tone through an OfflineAudioContext at
 *     48 kHz, from a file:// page (Electron's loadFile) and from an http://
 *     page with the web shell's headers: pitch +12 → dominant ≈ 880 Hz,
 *     duration unchanged; robot → buzz at 48000/256 Hz. Under a CSP that
 *     forbids blob: but allows data: scripts the worklet loads from a data:
 *     URL (pitch +12 → ≈ 880 Hz). Under a CSP that forbids both it fails to
 *     load cleanly (loadVoiceWorklet → false, the render-only fallback)
 *     instead of throwing.
 *  3. The built renderer (apps/desktop/dist/renderer) carries the worklet
 *     source intact (if built).
 *
 * Needs FFmpeg (AIVE_FFMPEG, else the one on PATH) and, for part 2,
 * playwright-core + a Chromium: PLAYWRIGHT_CORE=<dir of playwright-core> and
 * PLAYWRIGHT_CHROMIUM=<chrome binary> override the search (npx caches,
 * ~/.cache/ms-playwright), as for apps/desktop/scripts/parity-gl.mts.
 * AIVE_SKIP_BROWSER=1 skips part 2.
 *
 * Run: npx tsx packages/core/scripts/smoke-voicefx.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { audioEffectFilterSteps, audioPreviewPlan } from "../src/effects/audio.js";
import { VOICE_WORKLET_SOURCE, voiceWorkletLatency } from "../src/effects/voiceworklet.js";
import { FFMPEG_BIN } from "../src/ffmpeg/executor.js";
import { hasAfftfiltV2, parseFfmpegVersion } from "../src/ffmpeg/version.js";

const RATE = 48000;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let failures = 0;
function check(ok: boolean, msg: string, detail?: unknown) {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}${!ok && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

// ---- the worklet in Node ------------------------------------------------------------

type Proc = { process(i: Float32Array[][], o: Float32Array[][]): boolean };
function processorClass(rate: number): new (o: unknown) => Proc {
  let cls: unknown;
  class AudioWorkletProcessor {
    port = { onmessage: null as unknown, postMessage() {} };
  }
  new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", VOICE_WORKLET_SOURCE)(
    AudioWorkletProcessor, (_name: string, c: unknown) => { cls = c; }, rate,
  );
  return cls as new (o: unknown) => Proc;
}

/** Run mono `x` through one node (stereo out; channel 0 returned). */
function runNode(opts: unknown, x: Float32Array, rate = RATE): Float32Array {
  const P = processorClass(rate);
  const p = new P({ processorOptions: opts });
  const out = new Float32Array(x.length);
  for (let i = 0; i + 128 <= x.length; i += 128) {
    const o0 = new Float32Array(128);
    const o1 = new Float32Array(128);
    p.process([[x.subarray(i, i + 128)]], [[o0, o1]]);
    out.set(o0, i);
  }
  return out;
}

const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));
const db = (r: number) => 20 * Math.log10(r);

/** Strongest frequency (1 Hz grid, 50–3000 Hz) of a Hann-windowed stretch. */
function dominantHz(x: Float32Array, rate = RATE): number {
  const n = x.length;
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = x[i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  let best = 0;
  let bf = 0;
  const scan = (lo: number, hi: number, step: number) => {
    for (let f = lo; f <= hi; f += step) {
      let re = 0;
      let im = 0;
      const k = (2 * Math.PI * f) / rate;
      for (let i = 0; i < n; i++) {
        re += w[i]! * Math.cos(k * i);
        im += w[i]! * Math.sin(k * i);
      }
      const m = re * re + im * im;
      if (m > best) { best = m; bf = f; }
    }
  };
  scan(50, 3000, 5);
  const coarse = bf;
  scan(coarse - 5, coarse + 5, 0.5);
  return bf;
}

function tone(hz: number, seconds: number, amp = 0.5): Float32Array {
  const x = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / RATE);
  return x;
}

function ffmpegF32(input: Float32Array, af: string, dir: string): Float32Array {
  const src = join(dir, "in.f32");
  const dst = join(dir, "out.f32");
  writeFileSync(src, Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  execFileSync(FFMPEG_BIN, [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "f32le", "-ar", String(RATE), "-ac", "1", "-i", src,
    "-af", af, "-f", "f32le", "-ar", String(RATE), "-ac", "1", dst,
  ]);
  const b = readFileSync(dst);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}

function hasFilter(name: string): boolean {
  return new RegExp(`\\s${name}\\s`).test(execFileSync(FFMPEG_BIN, ["-hide_banner", "-filters"], { encoding: "utf8" }));
}

/** Correlation of log long-term spectra (0–~2.3 kHz) of two signals. */
function logSpectrumCorr(a: Float32Array, b: Float32Array): number {
  const N = 2048;
  const K = 100;
  const spec = (x: Float32Array) => {
    const acc = new Float64Array(K);
    for (let s0 = RATE / 2; s0 + N < x.length - RATE / 4; s0 += N) {
      for (let k = 2; k < K; k++) {
        let re = 0;
        let im = 0;
        for (let i = 0; i < N; i++) {
          const v = x[s0 + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
          const w = (2 * Math.PI * k * i) / N;
          re += v * Math.cos(w);
          im -= v * Math.sin(w);
        }
        acc[k] += Math.hypot(re, im);
      }
    }
    return acc;
  };
  const A = spec(a);
  const B = spec(b);
  let num = 0;
  let da = 0;
  let dbb = 0;
  for (let k = 2; k < K; k++) {
    const x = Math.log10(A[k]! + 1e-9);
    const y = Math.log10(B[k]! + 1e-9);
    num += x * y;
    da += x * x;
    dbb += y * y;
  }
  return num / Math.sqrt(da * dbb);
}

function nodeChecks(dir: string): void {
  console.log("1. the voice worklet's DSP in Node...");
  const t = tone(440, 2);
  const dryRms = rms(t.subarray(RATE / 2, RATE * 1.5));
  for (const [st, want] of [[12, 880], [-12, 220], [4, 440 * Math.pow(2, 4 / 12)]] as const) {
    const plan = audioPreviewPlan([{ type: "pitch", params: { semitones: st } }]);
    const spec = plan.nodes[0];
    const y = runNode(spec?.kind === "pitch" ? { kind: "pitch", ratio: spec.ratio } : null, t);
    const mid = y.subarray(RATE / 2, RATE * 1.5);
    const hz = dominantHz(mid);
    check(Math.abs(hz - want) < want * 0.01, `pitch ${st > 0 ? "+" : ""}${st} st: 440 Hz → ${hz} Hz (want ${want.toFixed(1)})`);
    check(Math.abs(db(rms(mid) / dryRms)) < 2, `…level within 2 dB (${db(rms(mid) / dryRms).toFixed(2)} dB)`);
    check(y.length === t.length, "…length unchanged (a real-time node: one sample out per sample in)");
  }
  check(audioPreviewPlan([{ type: "pitch", params: { semitones: 0 } }]).nodes.length === 0 &&
    audioEffectFilterSteps([{ type: "pitch", params: { semitones: 0 } }]).length === 0, "pitch 0 st is a no-op in the preview, like the export");

  const ff = parseFfmpegVersion(execFileSync(FFMPEG_BIN, ["-version"], { encoding: "utf8" }));
  // The caps a render resolves for a robot on this FFmpeg (audio/fx.ts audioFilterCaps).
  const v2 = hasAfftfiltV2(ff);
  const caps = v2 ? { afftfiltV2: true } : {};
  const voice = new Float32Array(RATE * 3);
  let ph = 0;
  for (let i = 0; i < voice.length; i++) {
    const f0 = 125 * (1 + 0.03 * Math.sin((2 * Math.PI * 5 * i) / RATE));
    ph += (2 * Math.PI * f0) / RATE;
    let s = 0;
    for (let h = 1; h <= 20; h++) s += Math.sin(h * ph) / h;
    voice[i] = 0.2 * s;
  }
  for (const toneParam of [0, 1, 2]) {
    const steps = audioEffectFilterSteps([{ type: "robot", params: { tone: toneParam } }], { caps });
    const plan = audioPreviewPlan([{ type: "robot", params: { tone: toneParam } }]);
    const win = plan.nodes[0]?.kind === "robot" ? plan.nodes[0].win : 0;
    const winOpt = /win_size=\d+/.exec(steps.join())?.[0];
    check(winOpt === `win_size=${win}`, `robot tone ${toneParam}: preview window ${win} == the export's (${winOpt}, ${steps.length} step${steps.length > 1 ? "s" : ""})`);
    const out = ffmpegF32(voice, steps.join(","), dir);
    const mine = runNode({ kind: "robot", win }, voice);
    const L = voiceWorkletLatency(win);
    let num = 0;
    let d1 = 0;
    let d2 = 0;
    let e2 = 0;
    let err = 0;
    for (let i = 2 * win; i < Math.min(out.length, mine.length - L) - 2 * win; i++) {
      const a = out[i]!;
      const b = mine[i + L]!;
      num += a * b;
      d1 += a * a;
      d2 += b * b;
      e2 += (a - b) * (a - b);
      err = Math.max(err, Math.abs(a - b));
    }
    const corr = num / Math.sqrt(d1 * d2);
    const residual = 10 * Math.log10(e2 / d1);
    if (!v2) {
      check(err < 1e-4 && corr > 0.99999, `robot tone ${toneParam}: == FFmpeg ${ff.label} afftfilt sample for sample after ${L} samples (max err ${err.toExponential(2)})`);
    } else {
      // 5.1+'s afftfilt is rebuilt to 4.4's maths (win_func=rect + a 5-tap spectral Hann): equal up to a −65 dB floor.
      check(residual <= -55 && err <= 1e-3 && corr >= 0.99999,
        `robot tone ${toneParam}: FFmpeg ${ff.label} (afftfilt v2, rebuilt with win_func=rect) == worklet within ${residual.toFixed(1)} dB after ${L} samples (≤ −55; max err ${err.toExponential(2)}, corr ${corr.toFixed(7)})`);
    }
  }
  if (hasFilter("rubberband")) {
    for (const st of [5, -5]) {
      const r = Math.pow(2, st / 12);
      const rb = ffmpegF32(voice, audioEffectFilterSteps([{ type: "pitch", params: { semitones: st } }])[0]!, dir);
      const me = runNode({ kind: "pitch", ratio: r }, voice);
      const c = logSpectrumCorr(rb, me);
      check(c > 0.97, `pitch ${st > 0 ? "+" : ""}${st} st on a voice-like signal: spectrum follows the export's rubberband (log-spectrum corr ${c.toFixed(4)})`);
    }
  } else {
    console.log("  note no rubberband filter in this FFmpeg: skipped the spectrum comparison");
  }
}

// ---- headless Chromium -----------------------------------------------------------------

function playwrightCandidates(): string[] {
  const out: string[] = [];
  if (process.env.PLAYWRIGHT_CORE) out.push(process.env.PLAYWRIGHT_CORE);
  out.push(join(ROOT, "node_modules", "playwright-core"));
  const npx = join(homedir(), ".npm", "_npx");
  if (existsSync(npx)) for (const d of readdirSync(npx)) out.push(join(npx, d, "node_modules", "playwright-core"));
  return out.filter((c) => existsSync(join(c, "package.json")));
}

async function loadPlaywright(): Promise<typeof import("playwright-core") | null> {
  for (const c of playwrightCandidates()) {
    try {
      return (await import(pathToFileURL(join(c, "index.mjs")).href)) as typeof import("playwright-core");
    } catch {
      /* next */
    }
  }
  return null;
}

function chromiumPath(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const cache = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? "", "ms-playwright")
    : process.platform === "darwin" ? join(homedir(), "Library", "Caches", "ms-playwright") : join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  const dirs = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const d of dirs) {
    for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-win/chrome.exe", "chrome-win64/chrome.exe", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
      const p = join(cache, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/** The page-side test: the real audiograph.ts chain in an OfflineAudioContext. */
const PAGE_ENTRY = `
import { buildChain, loadVoiceWorklet } from ${JSON.stringify(join(ROOT, "apps/desktop/src/audiograph.ts"))};
import { audioPreviewPlan } from ${JSON.stringify(join(ROOT, "packages/core/src/effects/audio.ts"))};

function dominant(x, rate) {
  const n = x.length; let best = 0, bf = 0;
  const scan = (lo, hi, step) => {
    for (let f = lo; f <= hi; f += step) {
      let re = 0, im = 0; const k = 2 * Math.PI * f / rate;
      for (let i = 0; i < n; i++) { const w = x[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n)); re += w * Math.cos(k * i); im += w * Math.sin(k * i); }
      const m = re * re + im * im; if (m > best) { best = m; bf = f; }
    }
  };
  scan(50, 3000, 5); const c = bf; scan(c - 5, c + 5, 0.5); return bf;
}

async function render(filters, seconds) {
  const rate = 48000;
  const ctx = new OfflineAudioContext(2, rate * seconds, rate);
  const loaded = await loadVoiceWorklet(ctx);
  const plan = audioPreviewPlan(filters);
  const osc = ctx.createOscillator(); osc.frequency.value = 440;
  const amp = ctx.createGain(); amp.gain.value = 0.5;
  const chain = buildChain(ctx, plan.nodes, { worklet: loaded });
  if (chain) { osc.connect(amp).connect(chain.input); chain.output.connect(ctx.destination); }
  else osc.connect(amp).connect(ctx.destination);
  osc.start();
  const buf = await ctx.startRendering();
  const x = buf.getChannelData(0);
  const mid = x.subarray(rate / 2, rate * 1.5);
  let s = 0; for (const v of mid) s += v * v;
  // Robot buzz: the autocorrelation peak between 100 and 400 samples.
  let bestLag = 0, bestR = -1;
  for (let lag = 100; lag <= 400; lag++) { let r = 0; for (let i = 0; i < 8192; i++) r += mid[i] * mid[i + lag]; if (r > bestR) { bestR = r; bestLag = lag; } }
  return { loaded, sampleRate: buf.sampleRate, length: buf.length, seconds: buf.duration, hz: dominant(mid, rate), rms: Math.sqrt(s / mid.length), period: bestLag, nodes: chain ? chain.nodes.map((n) => n.constructor.name) : [] };
}

window.runVoiceTests = async () => {
  const out = { secure: window.isSecureContext, worklet: typeof AudioWorkletNode === "function" };
  out.dry = await render([], 2);
  out.pitch = await render([{ type: "pitch", params: { semitones: 12 } }], 2);
  out.robot = await render([{ type: "robot", params: { tone: 1 } }], 2);
  out.noWorklet = await loadVoiceWorklet({});
  return out;
};
`;

async function browserChecks(dir: string): Promise<void> {
  console.log("2. the real preview chain in headless Chromium (OfflineAudioContext)...");
  if (process.env.AIVE_SKIP_BROWSER === "1") {
    console.log("  note AIVE_SKIP_BROWSER=1: skipped");
    return;
  }
  const pw = await loadPlaywright();
  const exe = chromiumPath();
  if (!pw || !exe) {
    check(false, "playwright-core and a Chromium are needed (set PLAYWRIGHT_CORE / PLAYWRIGHT_CHROMIUM, or AIVE_SKIP_BROWSER=1)");
    return;
  }
  writeFileSync(join(dir, "entry.ts"), PAGE_ENTRY);
  // Bundled the way Vite builds the renderer: minified, Chrome 87 syntax.
  await build({
    entryPoints: [join(dir, "entry.ts")], bundle: true, minify: true, target: "chrome87", format: "iife",
    outfile: join(dir, "voice.js"), logLevel: "error", absWorkingDir: ROOT,
  });
  writeFileSync(join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><title>voice</title><script src="voice.js"></script>`);
  const js = readFileSync(join(dir, "voice.js"));
  const html = readFileSync(join(dir, "index.html"));
  // An http origin with the web shell's headers, one with a strict CSP, and
  // one whose CSP allows data: scripts but not blob: ones.
  const server = http.createServer((req, res) => {
    const csp = /^\/(strict|dataonly)\//.exec(req.url ?? "")?.[1];
    const path = (req.url ?? "/").replace(/^\/(strict|dataonly)/, "") || "/";
    const isJs = path.endsWith(".js");
    res.writeHead(200, {
      "Content-Type": isJs ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
      ...(isJs ? {} : csp === "strict"
        ? { "Content-Security-Policy": "script-src 'self'" }
        : csp === "dataonly"
          ? { "Content-Security-Policy": "script-src 'self' data:" }
          : { "Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY" }),
    });
    res.end(isJs ? js : html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const browser = await pw.chromium.launch({ executablePath: exe, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    for (const [label, url] of [
      ["file:// (Electron loadFile)", pathToFileURL(join(dir, "index.html")).href],
      ["http://127.0.0.1 (web shell)", `http://127.0.0.1:${port}/index.html`],
    ] as const) {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(url);
      const r = (await page.evaluate("window.runVoiceTests()")) as {
        secure: boolean; worklet: boolean; noWorklet: boolean;
        dry: { hz: number; rms: number; length: number; seconds: number };
        pitch: { loaded: boolean; hz: number; rms: number; length: number; seconds: number; sampleRate: number; nodes: string[] };
        robot: { loaded: boolean; period: number; rms: number; nodes: string[] };
      };
      console.log(`  ${label}: pitch +12 → ${r.pitch.hz} Hz, ${r.pitch.seconds.toFixed(3)} s at ${r.pitch.sampleRate} Hz (dry ${r.dry.hz} Hz, ${r.dry.seconds.toFixed(3)} s); robot period ${r.robot.period} samples`);
      check(r.secure && r.worklet && r.pitch.loaded, `${label}: AudioWorklet available and the voice module loads (Blob URL, else data: URL)`, r);
      check(r.pitch.nodes.includes("AudioWorkletNode"), `${label}: the pitch chain is a real AudioWorkletNode`, r.pitch.nodes);
      check(Math.abs(r.dry.hz - 440) < 2 && Math.abs(r.pitch.hz - 880) < 4, `${label}: 440 Hz pitched +12 st → dominant ≈ 880 Hz (${r.pitch.hz})`);
      check(r.pitch.length === r.dry.length && r.pitch.seconds === 2, `${label}: duration unchanged (${r.pitch.seconds} s)`);
      check(Math.abs(db(r.pitch.rms / r.dry.rms)) < 2, `${label}: pitched level within 2 dB of dry (${db(r.pitch.rms / r.dry.rms).toFixed(2)} dB)`);
      check(r.robot.loaded && r.robot.period === 256 && r.robot.rms > 0.01, `${label}: robot buzzes at 48000/256 Hz (period ${r.robot.period})`);
      check(r.noWorklet === false, `${label}: a context without AudioWorklet → loadVoiceWorklet false (render-only fallback)`);
      check(errors.length === 0, `${label}: no page errors`, errors);
      await page.close();
    }
    // A CSP that allows neither blob: nor data: scripts: the load fails, cleanly.
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/strict/index.html`);
    const strict = (await page.evaluate(`(async () => {
      const { pitch } = await window.runVoiceTests();
      return pitch;
    })()`)) as { loaded: boolean; hz: number; nodes: string[] };
    check(!strict.loaded && !strict.nodes.includes("AudioWorkletNode") && Math.abs(strict.hz - 440) < 2 && errors.length === 0,
      `strict CSP (script-src 'self'): the module is refused, the chain plays dry (${strict.hz} Hz), nothing throws`, { strict, errors });
    await page.close();
    // A CSP that refuses blob: but allows data: scripts: the data: URL fallback loads the module.
    const dpage = await browser.newPage();
    const derrors: string[] = [];
    dpage.on("pageerror", (e) => derrors.push(String(e)));
    await dpage.goto(`http://127.0.0.1:${port}/dataonly/index.html`);
    const dataOnly = (await dpage.evaluate(`(async () => {
      const { dry, pitch } = await window.runVoiceTests();
      return { dry, pitch };
    })()`)) as { dry: { hz: number }; pitch: { loaded: boolean; hz: number; nodes: string[] } };
    check(dataOnly.pitch.loaded && dataOnly.pitch.nodes.includes("AudioWorkletNode") && Math.abs(dataOnly.dry.hz - 440) < 2 &&
      Math.abs(dataOnly.pitch.hz - 880) < 4 && derrors.length === 0,
      `CSP without blob: (script-src 'self' data:): the module loads from a data: URL, 440 Hz pitched +12 st → ${dataOnly.pitch.hz} Hz`, { dataOnly, derrors });
    await dpage.close();
  } finally {
    await browser.close();
    server.close();
  }
}

function bundleCheck(): void {
  console.log("3. the built renderer carries the worklet source...");
  const assets = join(ROOT, "apps/desktop/dist/renderer/assets");
  if (!existsSync(assets)) {
    console.log("  note apps/desktop not built: skipped");
    return;
  }
  const js = readdirSync(assets).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(assets, f), "utf8")).join("\n");
  check(js.includes("aive-voicefx") && js.includes("registerProcessor(") && js.includes("hypot"), "dist/renderer includes the voice worklet module source");
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "zedmix-voicefx-"));
  try {
    nodeChecks(dir);
    await browserChecks(dir);
    bundleCheck();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nVOICE FX SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
