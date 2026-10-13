/**
 * How a source's YUV is turned into RGB, decided the way video players do it,
 * and how the export's RGB is turned back into YUV.
 *
 * FFmpeg on its own reads an untagged YUV stream as BT.601 whatever its size,
 * while players (Chromium, mpv, VLC) read untagged HD as BT.709 — so an
 * untagged 1080p clip came out of the old export with shifted, clipped
 * saturated colours, and every export was written as untagged BT.601 that
 * players then read as BT.709. Measured on Chromium 143 (the preview's
 * decoder): untagged HD max 38 / mean 3.2 levels off, a
 * BT.709-tagged camera clip max 41 / mean 5.2.
 *
 * The export now reads every source with an explicit matrix and range
 * ({@link resolveSourceColor}) and writes BT.709 limited range with all four
 * colour tags ({@link OUTPUT_COLOR}), which every player reads the same way.
 * PURE (no Node APIs), so the renderer can import it to model what Chromium
 * shows ({@link chromiumSourceColor}).
 */

import { isEnabled, isKeyType } from "../effects/registry.js";

/** A video stream's colour description as ffprobe reports it (only values ffprobe knows). */
export interface ProbedColor {
  /** ffprobe `color_space` (the YUV matrix), e.g. "bt709", "smpte170m", "bt470bg". */
  space?: string;
  /** ffprobe `color_range`: "tv" (limited) or "pc" (full). */
  range?: string;
  /** ffprobe `color_primaries`. */
  primaries?: string;
  /** ffprobe `color_transfer`. */
  transfer?: string;
  /** The coded (pre-rotation) picture height: what players' untagged guess looks at. */
  codedHeight?: number;
}

/** A YUV matrix as FFmpeg's scale filter names it (in_color_matrix / out_color_matrix). */
export type YuvMatrix = "bt709" | "bt601" | "bt2020" | "smpte240m" | "fcc";

/** How to read a source's YUV: its matrix and its range ("tv" limited, "pc" full). */
export interface SourceColor {
  matrix: YuvMatrix;
  range: "tv" | "pc";
}

/** ffprobe matrix names → the scale filter's. RGB (gbr), YCgCo and the rest have no swscale matrix. */
const MATRICES: Record<string, YuvMatrix> = {
  bt709: "bt709",
  smpte170m: "bt601",
  bt470bg: "bt601",
  bt2020nc: "bt2020",
  bt2020c: "bt2020",
  smpte240m: "smpte240m",
  fcc: "fcc",
};

const known = (v: string | undefined): v is string => !!v && v !== "unknown" && v !== "reserved" && v !== "unspecified";

/** The matrix a tag names, or undefined when it names none swscale has (an own key only: a loaded "constructor" names none). */
export function taggedMatrix(space: string | undefined): YuvMatrix | undefined {
  return space && Object.hasOwn(MATRICES, space) ? MATRICES[space] : undefined;
}

/** Players' guess for an untagged matrix: BT.709 from 720 lines up, BT.601 below. */
function guessMatrix(height: number): YuvMatrix {
  return height >= 720 ? "bt709" : "bt601";
}

/**
 * How the EXPORT reads a source (the way players do): a tagged matrix as
 * tagged; an untagged one as BT.709 for HD (coded height ≥ 720) and BT.601
 * below — except full range with no matrix, which is JPEG's BT.601 (MJPEG
 * webcams, yuvj streams; Chromium and FFmpeg agree), and untagged VP9, whose
 * own default is BT.601 (libvpx, and Chromium up to 148 — Electron 42's —
 * read it so at any size). Full range when tagged so, else limited. `height` is the coded height (the
 * colour info's own, when probed). BT.2020 converts the matrix only — no
 * transfer or gamut mapping.
 */
export function resolveSourceColor(color: ProbedColor | undefined, height: number, codec?: string): SourceColor {
  const range = color?.range === "pc" ? "pc" : "tv";
  const tagged = taggedMatrix(color?.space);
  const matrix = tagged ?? (range === "pc" || codec === "vp9" ? "bt601" : guessMatrix(color?.codedHeight ?? height));
  return { matrix, range };
}

/**
 * The first Chromium that reads untagged VP9 as BT.709 at any size: 143 and
 * 148 (Electron 42's) read it as BT.601, 149 as BT.709 (lossless and lossy
 * VP9, 1280×720 and 640×360).
 */
export const CHROMIUM_VP9_BT709_FROM = 149;

/**
 * How Chromium (the live preview's decoder: <video> drawImage and WebGL
 * texImage2D give the same pixels) reads a VIDEO stream, measured on
 * Chromium 143 (H.264, VP8, VP9 fixtures; 148 and 149 the same, but for VP9):
 * a complete colour description (matrix, primaries and transfer all known) as
 * tagged, full range included; an incomplete one is ignored entirely (matrix
 * AND range) and the size guess applies; full range with no matrix is JPEG's
 * BT.601 full range; untagged VP9 is BT.601 — BT.709 from
 * {@link CHROMIUM_VP9_BT709_FROM} (`chromeMajor`: the decoding Chromium's
 * major version, default Electron's). Stills go through the image decoder
 * (JPEG: BT.601 full range) and match {@link resolveSourceColor}.
 */
export function chromiumSourceColor(color: ProbedColor | undefined, height: number, codec?: string, chromeMajor?: number): SourceColor {
  const tagged = taggedMatrix(color?.space);
  if (tagged && known(color?.primaries) && known(color?.transfer)) return { matrix: tagged, range: color?.range === "pc" ? "pc" : "tv" };
  if (!known(color?.space) && color?.range === "pc") return { matrix: "bt601", range: "pc" };
  if (!known(color?.space) && codec === "vp9") return { matrix: (chromeMajor ?? 0) >= CHROMIUM_VP9_BT709_FROM ? "bt709" : "bt601", range: "tv" };
  return { matrix: guessMatrix(color?.codedHeight ?? height), range: "tv" };
}

/** Kr, Kb of each matrix. */
const KRB: Record<YuvMatrix, [number, number]> = {
  bt709: [0.2126, 0.0722],
  bt601: [0.299, 0.114],
  bt2020: [0.2627, 0.0593],
  smpte240m: [0.212, 0.087],
  fcc: [0.3, 0.11],
};

/** 8-bit YUV → RGB levels (0..255) for `c`: rgb = A·(yuv − o). */
function yuvToRgb(c: SourceColor): { A: number[][]; o: number[] } {
  const [kr, kb] = KRB[c.matrix];
  const kg = 1 - kr - kb;
  const ys = c.range === "pc" ? 1 : 255 / 219;
  const cs = c.range === "pc" ? 1 : 255 / 224;
  return {
    A: [
      [ys, 0, 2 * (1 - kr) * cs],
      [ys, ((-2 * kb * (1 - kb)) / kg) * cs, ((-2 * kr * (1 - kr)) / kg) * cs],
      [ys, 2 * (1 - kb) * cs, 0],
    ],
    o: [c.range === "pc" ? 0 : 16, 128, 128],
  };
}

function inverse3(m: number[][]): number[][] {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

/**
 * The RGB → RGB correction from a picture decoded as `from` to the same YUV
 * decoded as `to` (8-bit levels): rows [r, g, b] of `[m0, m1, m2, offset]`,
 * or null when the two agree. Exact for colours `from` didn't clip.
 */
export function colorFixAffine(from: SourceColor, to: SourceColor): [number[], number[], number[]] | null {
  if (from.matrix === to.matrix && from.range === to.range) return null;
  const f = yuvToRgb(from);
  const t = yuvToRgb(to);
  const fi = inverse3(f.A);
  const d = [0, 1, 2].map((k) => f.o[k] - t.o[k]);
  const rows = [0, 1, 2].map((r) => {
    const m = [0, 1, 2].map((c) => t.A[r][0] * fi[0][c] + t.A[r][1] * fi[1][c] + t.A[r][2] * fi[2][c]);
    const off = t.A[r][0] * d[0] + t.A[r][1] * d[1] + t.A[r][2] * d[2];
    return [...m, off];
  });
  return rows as [number[], number[], number[]];
}

/** What the live preview needs to know about an asset to match the export's colours. */
export interface PreviewColorSource {
  color?: ProbedColor;
  width: number;
  height: number;
  videoCodec?: string;
  isImage?: boolean;
  /** The preview proxy's own probed colour description (absent on proxies made before it was recorded). */
  proxyColor?: ProbedColor;
  /** A matte-backed cutout: its colour source's description and codec (its own `color` is the gray matte's). */
  cutout?: { colorTags?: ProbedColor; colorCodec?: string };
}

/** The long edge preview proxies are scaled to (engine generateProxy, and the cutout's VP8 proxy). */
export const PROXY_LONG_EDGE = 1280;

/**
 * The correction the live preview applies to the file it plays (`proxy`:
 * the asset's H.264 preview proxy, else the original) so its picture shows
 * the export's reading of the source: null when Chromium already reads it so
 * (untagged and completely tagged H.264/HEVC/VP8/VP9, stills). A proxy keeps
 * the source's matrix in limited range (the engine's generate_proxy), so it
 * should read as the export's matrix, limited; how Chromium reads it comes
 * from its own probed tags, or — for a proxy without them (one made before
 * they were recorded) — from the source's tags at the proxy's size (what
 * FFmpeg copied over). The VP8+alpha proxy of a cutout or other alpha video
 * (ffmpeg/cutout.ts alphaProxyArgs) is coded and tagged the same way.
 * `chromeMajor`: the decoding Chromium's major version
 * ({@link chromiumSourceColor}).
 */
export function previewColorFix(a: PreviewColorSource, proxy: boolean, chromeMajor?: number): [number[], number[], number[]] | null {
  if (a.isImage) return null;
  // A matte-backed cutout shows its colour source's YUV (merged into its proxy), read as the export reads that.
  if (a.cutout) a = { ...a, color: a.cutout.colorTags, height: a.cutout.colorTags?.codedHeight ?? a.height, videoCodec: a.cutout.colorCodec };
  const target = resolveSourceColor(a.color, a.height, a.videoCodec);
  if (!proxy) return colorFixAffine(chromiumSourceColor(a.color, a.height, a.videoCodec, chromeMajor), target);
  let tags = a.proxyColor;
  if (!tags) {
    const coded = a.color?.codedHeight ?? a.height;
    const long = Math.max(a.width, a.height);
    const proxyH = long > 0 ? Math.round((coded * Math.min(1, PROXY_LONG_EDGE / long)) / 2) * 2 : coded;
    tags = { ...a.color, range: "tv", codedHeight: proxyH };
  }
  return colorFixAffine(chromiumSourceColor(tags, tags.codedHeight ?? a.height, "h264"), { matrix: target.matrix, range: "tv" });
}

/**
 * swscale flags of the explicit colour/scale steps. Every one rounds
 * accurately and handles chroma at full resolution: accurate_rnd takes
 * swscale off its fast converter (8-bit table arithmetic, the path FFmpeg's
 * auto-inserted converters take).
 *
 *  - SWS_RESIZE: a picture that is resized — lanczos, the sharpest kernel.
 *  - SWS_PLAIN: a picture kept at its size — each chroma sample repeated
 *    over its 2×2 block, which SWS_OUTPUT averages back to the same sample:
 *    4:2:0 chroma that nothing changes reaches the export as it was coded,
 *    and what an eq, LUT, blur, sharpen, rotation or downscale changes is
 *    changed once. Interpolating instead (bilinear in, any filter out)
 *    blurred every hard colour edge twice: up to 80-100 levels at a
 *    saturated edge, p99 15-26, against max 1-4 for a plain clip this way,
 *    and p99 about halved with those effects (end to end, played back in
 *    Chromium or decoded bilinear / bicubic, against the preview).
 *  - SWS_CONVERT: a picture kept at its size for a key or a magnifying
 *    transform ({@link keepsChromaSamples}) — bilinear chroma upsampling,
 *    close to Chromium's decode: the full-resolution matte is keyed from
 *    smooth chroma as the preview keys it, and a zoom doesn't blow repeated
 *    samples up into blocks. 8 ms a 1080p frame where lanczos takes 21
 *    (FFmpeg 4.4, one core).
 *  - SWS_OUTPUT: RGB → 4:2:0 — area (box) chroma averaging: no ringing, and
 *    at most bicubic's error on full-chroma RGB too (text, graphics,
 *    stills: max, p99 and mean, decoded bilinear or bicubic).
 */
export const SWS_RESIZE = "lanczos+accurate_rnd+full_chroma_int+full_chroma_inp";
export const SWS_CONVERT = "bilinear+accurate_rnd+full_chroma_int+full_chroma_inp";
export const SWS_PLAIN = "neighbor+accurate_rnd+full_chroma_int+full_chroma_inp";
export const SWS_OUTPUT = "area+accurate_rnd";

/** What {@link keepsChromaSamples} needs of a clip's effects (graph.ts ResolvedEffects). */
export interface ChromaReadEffects {
  filters?: readonly { type: string; enabled?: boolean }[];
  transform?: { scale?: number };
  keyframes?: { scale?: readonly unknown[] };
}

/**
 * True when a clip read at its own size keeps its chroma samples
 * (SWS_PLAIN): unless it carries an enabled key (chromakey / colorkey /
 * lumakey) or a magnifying transform — a static scale above 1, or any
 * keyframed scale (it may zoom in) — which read with SWS_CONVERT.
 */
export function keepsChromaSamples(fx: ChromaReadEffects | undefined): boolean {
  if (!fx) return true;
  if (fx.filters?.some((f) => isEnabled(f) && isKeyType(f.type))) return false;
  return (fx.transform?.scale ?? 1) <= 1 && !fx.keyframes?.scale?.length;
}

/**
 * The flags of a clip's input scale: SWS_RESIZE when it resizes; at the
 * fitted size, SWS_PLAIN when `plain` ({@link keepsChromaSamples}), else
 * SWS_CONVERT.
 */
export function inputScaleFlags(src: { w: number; h: number } | undefined, W: number, H: number, plain = false): string {
  if (!src || src.w !== W || src.h !== H) return SWS_RESIZE;
  return plain ? SWS_PLAIN : SWS_CONVERT;
}

/**
 * The steps that turn a clip's decoded picture into the canvas-fitted RGBA
 * its effects and the composite work on: the source crop (`crop`, in the
 * decoded picture of `size`), then ONE explicit scale that reads the YUV with
 * `color` ({@link inputScaleFlags}) and fits it, straight into RGBA.
 *
 * A crop with an odd offset or size can't be cut from 4:2:0 chroma, whose
 * samples each cover 2×2 pixels: FFmpeg's crop shifts the chroma half a pixel
 * and swscale stretches it over an odd width (p99 14-36 levels at colour
 * edges against the preview, which crops the decoded RGB). Such a crop reads
 * the 2×2-aligned area around it at its own size, then crops the RGBA exactly
 * and fits that.
 */
export function clipReadSteps(
  crop: { x: number; y: number; width: number; height: number } | undefined,
  size: { w: number; h: number } | undefined,
  color: SourceColor | undefined,
  plain: boolean,
  W: number,
  H: number,
): string[] {
  const fit = (flags: string, opts: string) => `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=${flags}${opts}`;
  if (!crop) return [fit(inputScaleFlags(size, W, H, plain), inputColorOpts(color)), "format=rgba"];
  let [x, y, w, h] = [crop.x, crop.y, crop.width, crop.height].map(Math.round);
  if (size) {
    // Inside the picture, as FFmpeg's crop moves a rectangle that runs off its edge.
    [w, h] = [Math.min(w, size.w), Math.min(h, size.h)];
    [x, y] = [Math.max(0, Math.min(x, size.w - w)), Math.max(0, Math.min(y, size.h - h))];
  }
  if (!((x | y | w | h) & 1)) return [`crop=${w}:${h}:${x}:${y}`, fit(inputScaleFlags({ w, h }, W, H, plain), inputColorOpts(color)), "format=rgba"];
  const x0 = x - (x & 1), y0 = y - (y & 1);
  const x1 = Math.min((x + w + 1) & ~1, size?.w ?? Infinity), y1 = Math.min((y + h + 1) & ~1, size?.h ?? Infinity);
  // SWS_CONVERT even for a plain clip: off the 2×2 grid, or resized, its samples can't pass through.
  return [
    `crop=${x1 - x0}:${y1 - y0}:${x0}:${y0}:exact=1`, `scale=flags=${SWS_CONVERT}${inputColorOpts(color)}`, "format=rgba",
    `crop=${w}:${h}:${x - x0}:${y - y0}:exact=1`, fit(SWS_RESIZE, ""), "format=rgba",
  ];
}

/** The export's colour encoding: BT.709, limited range — what every player assumes for HD and reads from the tags. */
export const OUTPUT_COLOR = { matrix: "bt709", range: "tv" } as const satisfies SourceColor;

/**
 * The scale options that read a source's YUV with `c` (none for RGB sources or
 * when unknown: FFmpeg's own default). For the `scale` filter, after w/h.
 */
export function inputColorOpts(c: SourceColor | undefined): string {
  return c ? `:in_color_matrix=${c.matrix}:in_range=${c.range}` : "";
}

/** The complete tag set (matrix, primaries, transfer) that names each matrix's usual colour space. */
const TAGS: Record<YuvMatrix, { space: string; primaries: string; transfer: string }> = {
  bt709: { space: "bt709", primaries: "bt709", transfer: "bt709" },
  bt601: { space: "smpte170m", primaries: "smpte170m", transfer: "smpte170m" },
  bt2020: { space: "bt2020nc", primaries: "bt2020", transfer: "bt2020-10" },
  smpte240m: { space: "smpte240m", primaries: "smpte240m", transfer: "smpte240m" },
  fcc: { space: "fcc", primaries: "bt470m", transfer: "bt470m" },
};

/**
 * A `setparams` step that tags the FRAMES as YUV coded with `c` (complete).
 * FFmpeg 7+ takes an encoder's colour tags from its frames, over the
 * -colorspace / -color_primaries / … options, so a re-encode tags both.
 */
export function tagFramesStep(c: SourceColor): string {
  const t = TAGS[c.matrix];
  return `setparams=colorspace=${t.space}:color_primaries=${t.primaries}:color_trc=${t.transfer}:range=${c.range}`;
}

/**
 * The step that ends every render's video: RGB → 4:2:0 YUV with the BT.709
 * matrix in limited range, in one explicitly flagged scale, frames tagged to
 * match (`exportCodecArgs` writes the same tags into the stream).
 */
export const OUTPUT_YUV_STEP =
  `scale=out_color_matrix=${OUTPUT_COLOR.matrix}:out_range=${OUTPUT_COLOR.range}:flags=${SWS_OUTPUT},format=yuv420p,` +
  tagFramesStep(OUTPUT_COLOR);

/** Encoder options that tag a stream as {@link OUTPUT_COLOR} (all four: Chromium ignores a partial set). */
export const OUTPUT_COLOR_ARGS = colorTagArgs(OUTPUT_COLOR);

/**
 * The scale options of a re-encoded copy of a source read as `c` (a preview
 * proxy, a reframe bake): the same matrix out (the YUV is kept, not
 * converted), limited range. Tag the copy — frames ({@link tagFramesStep})
 * and encoder ({@link colorTagArgs}), as { matrix: c.matrix, range: "tv" } —
 * at its new size the untagged guess could read it otherwise.
 */
export function keepCodingOpts(c: SourceColor): string {
  return `${inputColorOpts(c)}:out_color_matrix=${c.matrix}:out_range=tv`;
}

/** RGB frames coded by FFmpeg with no colour options (Remotion's default too): BT.601, limited range, untagged. */
export const FFMPEG_DEFAULT_CODING: SourceColor = { matrix: "bt601", range: "tv" };

/**
 * The `h264_metadata` bitstream filter that rewrites an H.264 stream's colour
 * tags (complete) for YUV coded as `c`, without re-encoding (`-c copy`).
 */
export function h264RetagBsf(c: SourceColor): string {
  const code: Record<YuvMatrix, [number, number, number]> = {
    bt709: [1, 1, 1],
    bt601: [6, 6, 6],
    bt2020: [9, 14, 9],
    smpte240m: [7, 7, 7],
    fcc: [4, 4, 4],
  };
  const [p, t, m] = code[c.matrix];
  return `h264_metadata=colour_primaries=${p}:transfer_characteristics=${t}:matrix_coefficients=${m}:video_full_range_flag=${c.range === "pc" ? 1 : 0}`;
}

/**
 * Encoder options that tag a stream as YUV coded with `c`, complete (matrix,
 * primaries, transfer, range) — e.g. a preview proxy, so Chromium reads the
 * copy as the export reads the original (a downscaled copy of an untagged HD
 * clip would otherwise fall under the SD guess).
 */
export function colorTagArgs(c: SourceColor): string[] {
  const t = TAGS[c.matrix];
  return ["-colorspace", t.space, "-color_primaries", t.primaries, "-color_trc", t.transfer, "-color_range", c.range];
}
