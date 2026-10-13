// In-page entry for scripts/parity-gl.mts (bundled with esbuild, loaded in a
// headless Chromium): runs the live preview's real WebGL2 pipeline
// (src/gl/runtime.ts + plan.ts) on raw RGBA test frames and hands back the
// straight RGBA result, plus a timing loop for the performance numbers.

// The pipeline must not need EXT_color_buffer_float (many WebGL2 devices lack
// it): the whole parity run happens with it hidden. Installed before the
// runtime creates its context.
const realGetExtension = WebGL2RenderingContext.prototype.getExtension;
WebGL2RenderingContext.prototype.getExtension = function (this: WebGL2RenderingContext, name: string) {
  return name === "EXT_color_buffer_float" ? null : realGetExtension.call(this, name);
} as typeof realGetExtension;

// Live GL textures (created − deleted), for the checks that GPU memory is freed deterministically.
let liveTex = 0;
const realCreateTexture = WebGL2RenderingContext.prototype.createTexture;
const realDeleteTexture = WebGL2RenderingContext.prototype.deleteTexture;
WebGL2RenderingContext.prototype.createTexture = function (this: WebGL2RenderingContext) {
  const t = realCreateTexture.call(this);
  if (t) liveTex++;
  return t;
};
WebGL2RenderingContext.prototype.deleteTexture = function (this: WebGL2RenderingContext, t: WebGLTexture | null) {
  if (t && !this.isContextLost()) liveTex--;
  return realDeleteTexture.call(this, t);
};

import {
  drawCount, glRenderer, historyGap, loseContextForTest, lutCacheForTest, lutProblem, lutStatus, onGLChange, provideLut, runLayer, setFileUrl,
  type LayerJob,
} from "../src/gl/runtime";
import { cachedPlan, planLayer, passCount, withSourceFix, type LayerLook, type SourceFix } from "../src/gl/plan";
import { cancelWarmups, setWarmup, warmIfNeeded, warmupForTest } from "../src/gl/warmup";
import { parseCube } from "../src/gl/color";
import { MediaPool } from "../src/mediapool";
import { colorFilter, vignetteAngles } from "../src/playback";
import { vignetteLayer } from "../src/vignette2d";

interface RunArgs {
  /** Source frame, straight RGBA, base64. */
  rgba: string;
  srcW: number;
  srcH: number;
  /** Canvas (export) size; the frame is placed fit + padded like the export. */
  cw: number;
  ch: number;
  look: LayerLook;
  frame: number;
  layerId: string;
  /** .cube files the look references: path → text. */
  luts?: Record<string, string>;
  /** The source frame shown and source frames per timeline frame (a video clip's temporal clock). */
  srcFrame?: number;
  srcStep?: number;
  /** Processing size (default: the canvas, k = 1). */
  pw?: number;
  ph?: number;
}

const b64ToBytes = (b64: string): Uint8ClampedArray => {
  const bin = atob(b64);
  const out = new Uint8ClampedArray(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const bytesToB64 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

/** The export's fit: scale=W:H:force_original_aspect_ratio=decrease (av_rescale rounding), pad centred. */
function fit(srcW: number, srcH: number, cw: number, ch: number) {
  const w = Math.min(cw, Math.round((ch * srcW) / srcH));
  const h = Math.min(ch, Math.round((cw * srcH) / srcW));
  return { x: Math.trunc((cw - w) / 2), y: Math.trunc((ch - h) / 2), w, h };
}

function job(a: RunArgs, img: ImageData): LayerJob {
  const w = a.pw ?? a.cw;
  const h = a.ph ?? a.ch;
  const k = w / a.cw;
  const g = { k, w, h, cw: a.cw, ch: a.ch };
  const f = fit(a.srcW, a.srcH, a.cw, a.ch);
  return {
    source: img, srcW: a.srcW, srcH: a.srcH, dynamic: true,
    crop: { x: 0, y: 0, w: a.srcW, h: a.srcH },
    w, h, pic: { x: f.x * k, y: f.y * k, w: f.w * k, h: f.h * k },
    steps: planLayer(a.look, g), k, cw: a.cw, ch: a.ch, frame: a.frame, layerId: a.layerId,
    ...(a.srcFrame !== undefined ? { srcFrame: a.srcFrame, srcStep: a.srcStep } : {}),
  };
}

function loadLuts(luts?: Record<string, string>) {
  for (const [path, text] of Object.entries(luts ?? {})) {
    const cube = parseCube(text);
    if (cube) provideLut(path, cube);
  }
}

type WarmMode = "ok" | "fail" | "short" | "hang";
const warmStore = new Map<string, { frames: Uint8Array[]; mode: WarmMode }>();
const warmRequests: { path: string; from: number; count: number; signal?: AbortSignal | null }[] = [];
let warmRepaints = 0;
setWarmup((path, q) => `mock-frames:${encodeURIComponent(JSON.stringify({ path, ...q }))}`, () => warmRepaints++);
{
  // The mocked /frames route: the frames asked for, back to back, in odd-sized chunks (a frame spans reads).
  const pageFetch = window.fetch;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("mock-frames:")) return pageFetch(input, init);
    const q = JSON.parse(decodeURIComponent(url.slice(12))) as { path: string; from: number; count: number };
    warmRequests.push({ path: q.path, from: q.from, count: q.count, signal: init?.signal });
    const src = warmStore.get(q.path);
    if (!src || src.mode === "fail") return new Response("decode failed", { status: 500 });
    const n = src.mode === "ok" ? q.count : q.count - 1;
    const parts = src.frames.slice(q.from, q.from + n);
    const all = new Uint8Array(parts.reduce((t, f) => t + f.length, 0));
    parts.reduce((o, f) => (all.set(f, o), o + f.length), 0);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let o = 0; o < all.length; o += 70001) c.enqueue(all.subarray(o, o + 70001));
        if (src.mode !== "hang") c.close();
        else init?.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

const api = {
  renderer: () => glRenderer(),
  /** True when the hiding above works: a fresh context can't complete an RGBA32F framebuffer. */
  floatBlocked(): boolean {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return false;
    gl.getExtension("EXT_color_buffer_float");
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 4, 4);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return !complete;
  },
  run(a: RunArgs): string | null {
    loadLuts(a.luts);
    const img = new ImageData(b64ToBytes(a.rgba), a.srcW, a.srcH);
    const out = runLayer(job(a, img), true);
    return out ? bytesToB64(out) : null;
  },
  liveTextures: () => liveTex,
  /**
   * The paused-frame warm-up (src/gl/warmup.ts, the real module) against a
   * mocked core /frames route: `warmFrames` stores a clip's source frames and
   * how the route answers ("ok"; "fail": HTTP 500; "short": one frame fewer
   * than asked; "hang": all but the last frame, then nothing until aborted).
   * `warmDraw` draws a paused frame and calls warmIfNeeded like the preview;
   * `warmLog` says what the route was asked and how often the warm-up asked
   * for a repaint.
   */
  warmFrames(path: string, frames: string[], mode: WarmMode): void {
    warmStore.set(path, { frames: frames.map(b64ToBytes), mode });
  },
  warmDraw(a: RunArgs & { path: string; first: number }): { gap: number | null; out: string | null } {
    const j = job(a, new ImageData(b64ToBytes(a.rgba), a.srcW, a.srcH));
    const out = runLayer(j, true);
    const gap = historyGap(a.layerId, j.steps, a.srcFrame ?? a.frame, a.first);
    warmIfNeeded(j, { path: a.path, srcFps: 30, first: a.first });
    return { gap, out: out ? bytesToB64(out) : null };
  },
  /** Draw a paused frame (no warm-up) and ask where its history must be rebuilt from. */
  warmGap(a: RunArgs, first: number): number | null {
    const j = job(a, new ImageData(b64ToBytes(a.rgba), a.srcW, a.srcH));
    runLayer(j, true);
    return historyGap(a.layerId, j.steps, a.srcFrame ?? a.frame, first);
  },
  warmLog(): { requests: { path: string; from: number; count: number; aborted: boolean }[]; repaints: number; pending: string[]; settled: string[] } {
    return { requests: warmRequests.map((r) => ({ path: r.path, from: r.from, count: r.count, aborted: r.signal?.aborted ?? false })), repaints: warmRepaints, ...warmupForTest() };
  },
  warmCancel: () => cancelWarmups(),
  warmMaxBytes: (n: number) => void warmupForTest({ maxBytes: n }),
  /**
   * A slider drag: `n` runs of one layer (one source element), each with a NEW
   * look whose eq and curves tables are new arrays. Returns the live textures
   * after the first run and after the last (they must not grow per new table).
   */
  churn(a: RunArgs, n: number): { first: number; last: number } {
    const img = new ImageData(b64ToBytes(a.rgba), a.srcW, a.srcH);
    let first = -1;
    for (let i = 0; i < n; i++) {
      const look: LayerLook = { color: { contrast: 1 + i * 0.01 }, grade: { curve: `0/0 0.5/${(0.4 + i * 0.002).toFixed(3)} 1/1` } };
      runLayer(job({ ...a, look, frame: i }, img), true);
      if (i === 0) first = liveTex;
    }
    return { first, last: liveTex };
  },
  /**
   * The LUT cache through a mocked core /file route (GET + HEAD with ETags):
   * a .cube rewritten in place must show after its ETag changes, and 12 LUTs
   * must leave at most 8 cached (oldest dropped, their textures deleted).
   * A rewrite that fails to parse is read once (not every re-check), keeps
   * the previous table and says so; a LUT whose first read failed (bad
   * content, or no file yet) recovers once the file is fixed; a table over
   * the byte budget is refused before it is parsed.
   * Returns the outputs (base64) and the cache's state.
   */
  async lutCache(a: RunArgs, cubes: { a: string; b: string; many: string[] }): Promise<{
    before: string | null; after: string | null; idle: string | null; idleRepaints: number; ref: string | null; cached: number; textures: number; live: number[];
    broken: { gets: number; problem: string | null; out: string | null; fixed: string | null; fixedProblem: string | null };
    late: { first: string; gets: number; problem: string | null; recovered: string; out: string | null };
    idleFix: { problem: string | null; repaints: number };
    missing: { first: string; recovered: string };
    budget: { state: string; problem: string | null };
  }> {
    const store = new Map<string, { text: string; etag: string }>();
    const gets = new Map<string, number>();
    const realFetch = window.fetch;
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("mock-lut:")) return realFetch(input, init);
      const path = decodeURIComponent(url.slice(9));
      if (init?.method !== "HEAD") gets.set(path, (gets.get(path) ?? 0) + 1);
      const e = store.get(path);
      if (!e) return new Response("missing", { status: 404 });
      return new Response(init?.method === "HEAD" ? null : e.text, { status: 200, headers: { ETag: e.etag } });
    }) as typeof fetch;
    setFileUrl((p) => `mock-lut:${encodeURIComponent(p)}`);
    lutCacheForTest(0); // check for a change on every use
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const img = new ImageData(b64ToBytes(a.rgba), a.srcW, a.srcH);
    const runWith = async (path: string): Promise<Uint8Array | null> => {
      for (let i = 0; i < 100 && lutStatus(path) !== "ready"; i++) await sleep(10);
      return runLayer(job({ ...a, look: { lut: path } }, img), true);
    };
    try {
      store.set("live.cube", { text: cubes.a, etag: 'W/"1"' });
      const before = await runWith("live.cube");
      store.set("live.cube", { text: cubes.b, etag: 'W/"2"' }); // rewritten in place
      runLayer(job({ ...a, look: { lut: "live.cube" } }, img), true); // a use: notices the new ETag
      for (let i = 0; i < 100; i++) {
        await sleep(10);
        const c = lutCacheForTest();
        if (c.paths.includes("live.cube") && i > 5) break;
      }
      const after = await runWith("live.cube");
      // Rewritten again while nothing draws (a paused preview): the idle re-check notices it and asks for a repaint.
      let repaints = 0;
      const off = onGLChange(() => repaints++);
      lutCacheForTest(250);
      store.set("live.cube", { text: cubes.a, etag: 'W/"3"' });
      for (let i = 0; i < 60 && repaints === 0; i++) await sleep(50);
      off();
      const idle = runLayer(job({ ...a, look: { lut: "live.cube" } }, img), true);
      lutCacheForTest(0);
      provideLut("ref.cube", parseCube(cubes.b)!);
      const ref = runLayer(job({ ...a, look: { lut: "ref.cube" } }, img), true);
      const live: number[] = [liveTex];
      for (const [i, text] of cubes.many.entries()) {
        store.set(`many${i}.cube`, { text, etag: `W/"m${i}"` });
        await runWith(`many${i}.cube`);
        // Later runs (other layers) move the frame on, so older LUTs become evictable.
        for (let j = 0; j < 20; j++) runLayer(job({ ...a, look: {}, layerId: `lru-pad-${j}` }, img), true);
        live.push(liveTex);
      }
      const c = lutCacheForTest(2000);
      const enc = (u: Uint8Array | null) => (u ? bytesToB64(u) : null);
      // Re-checks every 50 ms from here; `use` draws with the LUT every 25 ms (a playing preview).
      lutCacheForTest(50);
      const use = async (path: string, ms: number, until?: (out: string | null) => boolean) => {
        let out = enc(runLayer(job({ ...a, look: { lut: path } }, img), true));
        for (let t = 0; t < ms && !until?.(out); t += 25) {
          await sleep(25);
          out = enc(runLayer(job({ ...a, look: { lut: path } }, img), true));
        }
        return out;
      };
      const why = (path: string) => {
        const p = lutProblem(path);
        return p ? `${p.state}: ${p.reason}` : null;
      };
      // A ready LUT rewritten with content that doesn't parse: one GET over many re-checks.
      store.set("live.cube", { text: cubes.b, etag: 'W/"4"' });
      await use("live.cube", 2000, (out) => out === enc(after));
      const g0 = gets.get("live.cube") ?? 0;
      store.set("live.cube", { text: "LUT_3D_SIZE 17\n0 0 0\n", etag: 'W/"5"' });
      const brokenOut = await use("live.cube", 800);
      const broken = { gets: (gets.get("live.cube") ?? 0) - g0, problem: why("live.cube"), out: brokenOut, fixed: null as string | null, fixedProblem: null as string | null };
      store.set("live.cube", { text: cubes.a, etag: 'W/"6"' });
      broken.fixed = await use("live.cube", 2000, () => lutProblem("live.cube") === null);
      broken.fixedProblem = why("live.cube");
      // A LUT whose first read fails (a half-written file), then is fixed on disk.
      store.set("late.cube", { text: "TITLE \"half\"\nLUT_3D_SIZE 17\n", etag: 'W/"l1"' });
      await use("late.cube", 2000, () => lutStatus("late.cube") === "error");
      const lateFirst = lutStatus("late.cube");
      const gl0 = gets.get("late.cube") ?? 0;
      await use("late.cube", 600);
      const late = { first: lateFirst, gets: (gets.get("late.cube") ?? 0) - gl0, problem: why("late.cube"), recovered: "", out: null as string | null };
      store.set("late.cube", { text: cubes.a, etag: 'W/"l2"' });
      late.out = await use("late.cube", 2000, () => lutStatus("late.cube") === "ready");
      late.recovered = lutStatus("late.cube");
      // The same while nothing draws (a paused preview): the idle re-check notices the fix and asks for a repaint.
      store.set("idle.cube", { text: "LUT_3D_SIZE 17\n", etag: 'W/"i1"' });
      await use("idle.cube", 2000, () => lutStatus("idle.cube") === "error");
      let idleFixRepaints = 0;
      const offIdle = onGLChange(() => idleFixRepaints++);
      store.set("idle.cube", { text: cubes.a, etag: 'W/"i2"' });
      for (let i = 0; i < 60 && lutProblem("idle.cube") !== null; i++) await sleep(50);
      offIdle();
      const idleFix = { problem: why("idle.cube"), repaints: idleFixRepaints };
      // No file yet (404, no ETag): retried on the throttle until it appears.
      await use("missing.cube", 2000, () => lutStatus("missing.cube") === "error");
      const missing = { first: lutStatus("missing.cube"), recovered: "" };
      store.set("missing.cube", { text: cubes.a, etag: 'W/"m"' });
      await use("missing.cube", 2000, () => lutStatus("missing.cube") === "ready");
      missing.recovered = lutStatus("missing.cube");
      // A table over the byte budget (here 50 kB: a 17³ table is 59 kB) is never parsed or kept.
      lutCacheForTest(50, 50_000);
      store.set("budget.cube", { text: cubes.a, etag: 'W/"b"' });
      await use("budget.cube", 2000, () => lutStatus("budget.cube") !== "loading");
      const budget = { state: lutStatus("budget.cube"), problem: why("budget.cube") };
      lutCacheForTest(2000, 64 << 20);
      return {
        before: enc(before), after: enc(after), idle: enc(idle), idleRepaints: repaints, ref: enc(ref), cached: c.paths.length, textures: c.textures, live,
        broken, late, idleFix, missing, budget,
      };
    } finally {
      window.fetch = realFetch;
    }
  },
  /**
   * The preview's decoder pool (src/mediapool.ts, the real class) on a
   * counter clip with sound (frame n: luma 16 + 6n): paused at n / fps for
   * each n, the frame it shows; then `playMs` of playback from `playAt` (the
   * transport clock), driven every animation frame like preview.tsx: when it
   * sought (ms from the start) and where the element got to.
   */
  async mediaPool(a: { url: string; fps: number; ns: number[]; playAt: number; playMs: number }): Promise<{
    paused: { n: number; shown: number }[]; seeks: number[]; readyState: number; currentTime: number; playing: boolean;
  }> {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const pool = new MediaPool(host, () => a.url, () => {});
    // safeSeek is private: log it on the prototype for the duration.
    const proto = MediaPool.prototype as unknown as { safeSeek: (el: HTMLVideoElement, t: number) => void };
    const realSeek = proto.safeSeek;
    let t0 = 0;
    const seeks: number[] = [];
    proto.safeSeek = function (this: MediaPool, el: HTMLVideoElement, t: number) {
      seeks.push(Math.round(performance.now() - t0));
      realSeek.call(this, el, t);
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const frameOf = (v: number) => Math.round(v / ((6 * 255) / 219));
    const cv = document.createElement("canvas");
    cv.width = 32;
    cv.height = 18;
    const g = cv.getContext("2d", { willReadFrequently: true })!;
    try {
      pool.beginFrame();
      const el = pool.acquire("counter", "counter.mp4");
      for (let i = 0; i < 300 && el.readyState < 2; i++) await sleep(10);
      const paused: { n: number; shown: number }[] = [];
      for (const n of a.ns) {
        pool.beginFrame();
        pool.acquire("counter", "counter.mp4");
        const seeked = new Promise<void>((r) => el.addEventListener("seeked", () => r(), { once: true }));
        pool.sync(el, { srcTime: n / a.fps, playing: false, rate: 1, volume: 1, muted: false });
        pool.endFrame();
        await Promise.race([seeked, sleep(2000)]);
        g.drawImage(el, 0, 0, cv.width, cv.height);
        paused.push({ n, shown: frameOf(g.getImageData(16, 9, 1, 1).data[1]) });
      }
      seeks.length = 0;
      t0 = performance.now();
      await new Promise<void>((done) => {
        const tick = () => {
          const t = performance.now() - t0;
          if (t > a.playMs) return done();
          pool.beginFrame();
          pool.acquire("counter", "counter.mp4");
          pool.sync(el, { srcTime: a.playAt + t / 1000, playing: true, rate: 1, volume: 1, muted: false });
          pool.endFrame();
          requestAnimationFrame(tick);
        };
        tick();
      });
      return { paused, seeks, readyState: el.readyState, currentTime: el.currentTime, playing: !el.paused };
    } finally {
      proto.safeSeek = realSeek;
      pool.destroy();
      host.remove();
    }
  },
  passes(a: RunArgs): { passes: number; draws: number } {
    const steps = planLayer(a.look, { k: 1, w: a.cw, h: a.ch, cw: a.cw, ch: a.ch });
    return { passes: passCount(steps), draws: drawCount(steps) };
  },
  /**
   * A still wider than the GPU's MAX_TEXTURE_SIZE (left part orange, a blue
   * strip at the right end) through a sepia look, cropped to each part in
   * turn, next to a small source of the same orange: the centre pixels (it
   * must not come out black, and a new crop of the same still must show).
   */
  oversize(): { maxTexture: number; small: number[]; bigLeft: number[]; bigRight: number[]; bigLeftAgain: number[] } | null {
    const probe = document.createElement("canvas").getContext("webgl2");
    if (!probe) return null;
    const maxTexture = probe.getParameter(probe.MAX_TEXTURE_SIZE) as number;
    const canvasOf = (w: number, h: number) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d")!;
      g.fillStyle = "rgb(200,100,50)";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "rgb(40,90,200)";
      g.fillRect(w - 1000, 0, 1000, h);
      return c;
    };
    const look: LayerLook = { filters: [{ id: "s", type: "sepia" } as never] };
    const centre = (src: HTMLCanvasElement, crop: { x: number; y: number; w: number; h: number }, layerId: string) => {
      const W = 320;
      const H = Math.round((W * crop.h) / crop.w);
      const g = { k: 1, w: W, h: H, cw: W, ch: H };
      const out = runLayer({
        source: src, srcW: src.width, srcH: src.height, dynamic: false, crop, w: W, h: H, pic: { x: 0, y: 0, w: W, h: H },
        steps: planLayer(look, g), k: 1, cw: W, ch: H, frame: 0, layerId,
      }, true);
      if (!out) return [-1, -1, -1, -1];
      const i = ((H >> 1) * W + (W >> 1)) * 4;
      return [...out.subarray(i, i + 4)];
    };
    const small = canvasOf(1600 + 1000, 400);
    const big = canvasOf(maxTexture + 1808, 400);
    const left = { x: 0, y: 0, w: 1600, h: 400 };
    const right = { x: big.width - 1000, y: 0, w: 1000, h: 400 };
    return {
      maxTexture,
      small: centre(small, left, "small"),
      bigLeft: centre(big, left, "big"),
      bigRight: centre(big, right, "big"),
      bigLeftAgain: centre(big, left, "big"),
    };
  },
  /**
   * A <video> file's frame at `t` as the preview shows it: Chromium's decode,
   * through the GL pipeline with the source-colour correction `fix` (or none),
   * at its own size. Straight RGBA, base64.
   */
  async video(a: { url: string; t: number; fix: SourceFix | null; layerId: string }): Promise<string | null> {
    const v = document.createElement("video");
    v.muted = true;
    v.src = a.url;
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new Error(`cannot play ${a.url}`));
    });
    v.currentTime = a.t;
    await new Promise<void>((res) => { v.onseeked = () => res(); });
    await new Promise<void>((res) => { v.requestVideoFrameCallback(() => res()); setTimeout(res, 500); });
    const W = v.videoWidth;
    const H = v.videoHeight;
    const out = runLayer({
      source: v, srcW: W, srcH: H, dynamic: true, crop: { x: 0, y: 0, w: W, h: H }, w: W, h: H, pic: { x: 0, y: 0, w: W, h: H },
      steps: a.fix ? withSourceFix(undefined, a.fix) : [], k: 1, cw: W, ch: H, frame: 0, layerId: a.layerId,
    }, true);
    return out ? bytesToB64(out) : null;
  },
  /** Lose the context, try a run (must fail → the preview's CSS fallback), restore, run again. */
  async contextLoss(a: RunArgs): Promise<{ whileLost: boolean; after: string | null }> {
    const h = loseContextForTest();
    if (!h) return { whileLost: false, after: null };
    h.lose();
    await new Promise((r) => setTimeout(r, 50));
    const whileLost = runLayer(job(a, new ImageData(b64ToBytes(a.rgba), a.srcW, a.srcH)), true) === null;
    h.restore();
    await new Promise((r) => setTimeout(r, 200));
    return { whileLost, after: api.run(a) };
  },
  /**
   * Time `frames` composites of `layers` layers (each a canvas source drawn
   * through the GL path and then onto a 2D canvas, like preview.tsx) against
   * the same layers drawn the way the preview did before the GL pipeline
   * (the CSS filter proxy + the canvas vignette pass; effects without a CSS
   * proxy simply didn't show). Returns ms per frame, best of three runs.
   */
  bench(a: { w: number; h: number; q?: number; layers: { look: LayerLook }[]; frames: number }): { gl: number; css: number; passes: number; draws: number } {
    const src = document.createElement("canvas");
    src.width = a.w;
    src.height = a.h;
    const sg = src.getContext("2d")!;
    const out = document.createElement("canvas");
    out.width = a.w;
    out.height = a.h;
    const og = out.getContext("2d")!;
    const paint = (f: number) => {
      // A moving gradient, so every frame is a fresh upload.
      const grad = sg.createLinearGradient(f % a.w, 0, a.w, a.h);
      grad.addColorStop(0, "#c33");
      grad.addColorStop(0.5, "#3c6");
      grad.addColorStop(1, "#36c");
      sg.fillStyle = grad;
      sg.fillRect(0, 0, a.w, a.h);
      sg.fillStyle = "#fff";
      sg.fillRect((f * 7) % a.w, 40, 60, 60);
    };
    // q < 1: the looks run at a reduced processing size (the preview's software-GL playback mode).
    const q = a.q ?? 1;
    const pw = Math.round(a.w * q);
    const ph = Math.round(a.h * q);
    const g = { k: q, w: pw, h: ph, cw: a.w, ch: a.h };
    const finish = () => og.getImageData(0, 0, 1, 1); // force the GPU/raster work to complete
    let passes = 0;
    let draws = 0;
    for (const l of a.layers) {
      passes += passCount(cachedPlan(l.look, g));
      draws += drawCount(cachedPlan(l.look, g)) + 0;
    }
    const time = (fn: (f: number) => void) => {
      for (let f = 0; f < 3; f++) fn(f); // warm up (shader compiles, pools)
      finish();
      let best = Infinity;
      for (let trial = 0; trial < 3; trial++) {
        const t0 = performance.now();
        for (let f = 0; f < a.frames; f++) fn(f);
        finish();
        best = Math.min(best, (performance.now() - t0) / a.frames);
      }
      return best;
    };
    const glMs = time((f) => {
      paint(f);
      og.fillStyle = "#000";
      og.fillRect(0, 0, a.w, a.h);
      for (const [i, l] of a.layers.entries()) {
        const r = runLayer({
          source: src, srcW: a.w, srcH: a.h, dynamic: true, crop: { x: 0, y: 0, w: a.w, h: a.h },
          w: pw, h: ph, pic: { x: 0, y: 0, w: pw, h: ph }, steps: cachedPlan(l.look, g), k: q, cw: a.w, ch: a.h,
          frame: f, layerId: `bench${i}`,
        });
        if (r) {
          og.globalAlpha = i === 0 ? 1 : 0.7;
          og.drawImage(r.canvas, r.x, r.y, r.w, r.h, 0, 0, a.w, a.h);
          og.globalAlpha = 1;
        }
      }
    });
    const old = a.layers.map((l) => ({ css: colorFilter(l.look.color, l.look.grade, l.look.filters, 1), vig: vignetteAngles(l.look.filters) }));
    const cssMs = time((f) => {
      paint(f);
      og.fillStyle = "#000";
      og.fillRect(0, 0, a.w, a.h);
      for (const [i, l] of old.entries()) {
        let from: CanvasImageSource = src;
        let filter = l.css;
        if (l.vig.length) {
          const v = vignetteLayer(src, 0, 0, a.w, a.h, filter, a.w, a.h, Math.hypot(a.w / 2, a.h / 2), l.vig);
          if (v) {
            from = v;
            filter = "none";
          }
        }
        og.filter = filter;
        og.globalAlpha = i === 0 ? 1 : 0.7;
        og.drawImage(from, 0, 0, a.w, a.h, 0, 0, a.w, a.h);
        og.filter = "none";
        og.globalAlpha = 1;
      }
    });
    return { gl: glMs, css: cssMs, passes, draws };
  },
};

(window as unknown as { parity: typeof api }).parity = api;
