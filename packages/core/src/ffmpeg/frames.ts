/**
 * Decoded source frames for the live preview's temporal effects (GET /frames
 * in server.ts). The export's trails (lagfun) and denoise (hqdn3d) build
 * their state from the clip's first frame; a paused preview after a seek has
 * only the frame on screen. The renderer asks for the source frames before
 * the playhead and runs its own WebGL plan over them (apps/desktop
 * src/gl/warmup.ts), so the paused frame shows what the export has.
 *
 * Frames come back as raw RGBA, back to back (w × h × 4 bytes each), the
 * clip's crop scaled to the size the preview processes the picture at. YUV
 * is read the way Chromium reads it (the preview's own frames come from
 * Chromium's decoder, and a trail mixes the two): a tagged matrix as tagged,
 * an untagged one as BT.709 from 720 lines up and BT.601 below (full range
 * and VP9: BT.601) — measured on Chromium 143, mean difference 0.1–0.2 levels.
 */
import { execa } from "execa";
import type { ServerResponse } from "node:http";
import { stat } from "node:fs/promises";
import { FFMPEG_BIN, FFPROBE_BIN, ffmpegArgsLocalOnly, ffprobeArgsLocalOnly } from "./executor.js";

/** Most frames one request returns (the renderer asks for at most 90: 3 s at 30 fps). */
export const FRAMES_MAX = 120;
/** Most bytes one request returns (the renderer keeps a warm-up under 360 MB). */
const BYTES_MAX = 512 << 20;
/** Largest frame edge served (the preview's processing cap). */
const EDGE_MAX = 4096;
/** Decodes running at once; more are refused (429) — the renderer keeps one per layer. */
const RUNNING_MAX = 4;

export interface FramesQuery {
  path: string;
  /** First source frame (0-based; frame n starts at n / fps). */
  from: number;
  count: number;
  /** The source's frame rate, as the renderer counts frames. */
  fps: number;
  /** Output size. */
  w: number;
  h: number;
  /** Source rect to scale to w × h (the clip's crop), in decoded pixels. */
  crop?: { x: number; y: number; w: number; h: number };
}

/** The query from a /frames URL, or an error message. */
export function parseFramesQuery(q: URLSearchParams): FramesQuery | string {
  const path = q.get("path");
  if (!path) return "Missing 'path'";
  const int = (name: string, min: number, max: number): number | string => {
    const v = Number(q.get(name));
    return Number.isInteger(v) && v >= min && v <= max ? v : `'${name}' must be an integer in ${min}..${max}`;
  };
  const from = int("from", 0, 1e8);
  const count = int("count", 1, FRAMES_MAX);
  const w = int("w", 1, EDGE_MAX);
  const h = int("h", 1, EDGE_MAX);
  const fps = Number(q.get("fps"));
  for (const v of [from, count, w, h]) if (typeof v === "string") return v;
  if (!(fps > 0 && fps <= 1000)) return "'fps' must be a number in (0, 1000]";
  if ((count as number) * (w as number) * (h as number) * 4 > BYTES_MAX) return `count × w × h × 4 must be at most ${BYTES_MAX} bytes`;
  let crop: FramesQuery["crop"];
  const c = q.get("crop");
  if (c) {
    const [x, y, cw, ch] = c.split(",").map(Number);
    if (![x, y, cw, ch].every((n) => Number.isInteger(n) && n >= 0 && n <= 1e5) || cw < 1 || ch < 1) return "'crop' must be x,y,w,h in whole pixels";
    crop = { x, y, w: cw, h: ch };
  }
  return { path, from: from as number, count: count as number, fps, w: w as number, h: h as number, ...(crop ? { crop } : {}) };
}

/** How Chromium reads a stream's YUV (see the header): the scale filter's matrix and range. */
export function chromiumMatrix(s: { codec?: string; height?: number; space?: string; range?: string }): { matrix: string; range: "tv" | "pc" } {
  const range = s.range === "pc" ? "pc" : "tv";
  const tagged: Record<string, string> = {
    bt709: "bt709", smpte170m: "bt601", bt470bg: "bt601", bt2020nc: "bt2020", bt2020c: "bt2020", smpte240m: "smpte240m", fcc: "fcc",
  };
  const t = s.space ? tagged[s.space] : undefined;
  return { matrix: t ?? (range === "pc" || s.codec === "vp9" ? "bt601" : (s.height ?? 0) >= 720 ? "bt709" : "bt601"), range };
}

/** Probed colour description per file (path + size + mtime). */
const probed = new Map<string, Promise<{ matrix: string; range: "tv" | "pc" } | null>>();

async function sourceColor(path: string): Promise<{ matrix: string; range: "tv" | "pc" } | null> {
  const info = await stat(path);
  const key = `${path}|${info.size}|${info.mtimeMs}`;
  let p = probed.get(key);
  if (!p) {
    const probeArgs = ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,height,color_space,color_range,pix_fmt", "-of", "json", path];
    p = execa(FFPROBE_BIN, ffprobeArgsLocalOnly(probeArgs))
      .then((r) => {
        const s = (JSON.parse(r.stdout) as { streams?: Record<string, unknown>[] }).streams?.[0];
        if (!s) return null;
        // RGB sources (PNG sequences, ProRes 4444 decoded as RGB …) have no matrix to choose.
        if (typeof s.pix_fmt === "string" && /^(rgb|bgr|argb|abgr|gbr|gray|pal)/.test(s.pix_fmt)) return null;
        return chromiumMatrix({ codec: s.codec_name as string, height: Number(s.height), space: s.color_space as string, range: s.color_range as string });
      })
      .catch(() => null);
    if (probed.size > 64) probed.clear();
    probed.set(key, p);
  }
  return p;
}

/** The ffmpeg arguments that write frames [from, from + count) of the query's source to stdout. */
export function framesArgs(q: FramesQuery, color: { matrix: string; range: string } | null): string[] {
  // -ss keeps the first frame at or after the time: half a frame early so a
  // timestamp rounding can't drop frame `from` (frame n starts at n / fps).
  const ss = Math.max(0, (q.from - 0.5) / q.fps);
  const vf = [
    ...(q.crop ? [`crop=${q.crop.w}:${q.crop.h}:${q.crop.x}:${q.crop.y}`] : []),
    // bilinear: the closest to the preview's own GPU sampling of the frame.
    `scale=${q.w}:${q.h}:flags=bilinear+accurate_rnd+full_chroma_int${color ? `:in_color_matrix=${color.matrix}:in_range=${color.range}` : ""}`,
    "format=rgba",
  ].join(",");
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-ss", ss.toFixed(6), "-i", q.path,
    "-map", "0:v:0", "-an", "-sn", "-dn",
    "-frames:v", String(q.count), "-vf", vf,
    "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ];
}

let running = 0;

/**
 * Stream the frames into `res` (200, application/octet-stream). The decode
 * stops when the client goes away (the renderer aborts a warm-up the moment
 * the playhead moves). Fewer frames than asked (the source ends) is not an
 * error: the body is simply shorter.
 */
export async function streamFrames(q: FramesQuery, res: ServerResponse): Promise<void> {
  if (running >= RUNNING_MAX) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Too many frame decodes at once" }));
    return;
  }
  running++;
  try {
    const color = await sourceColor(q.path).catch(() => null);
    const decodeArgs = framesArgs(q, color);
    const child = execa(FFMPEG_BIN, ffmpegArgsLocalOnly(decodeArgs), { stdin: "ignore", stderr: "ignore", buffer: false, reject: false });
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
    const stop = () => {
      if (child.exitCode === null) child.kill("SIGKILL");
    };
    res.on("close", stop);
    child.stdout!.pipe(res);
    await child;
    res.off("close", stop);
  } finally {
    running--;
  }
}
