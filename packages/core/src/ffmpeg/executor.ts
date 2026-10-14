import { execa, type ResultPromise } from "execa";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { looksLikeProtocol, protocolName } from "../safepath.js";
import {
  FILTERGRAPH_OPTIONS, acrossfadeUnreliable, adaptFilterGraph, parseFfmpegVersion, preferredFilterScriptFlag, usesPremultiply,
  type FfmpegVersion,
} from "./version.js";

/**
 * Thin wrapper around the FFmpeg / ffprobe binaries. We invoke them as external
 * processes (never linked), which keeps FFmpeg an external tool dependency —
 * this project is GPL-3.0-or-later, and subprocess invocation means no FFmpeg
 * build flavor (GPL or LGPL) is compiled or linked into our distribution.
 *
 * Binary paths can be overridden via AIVE_FFMPEG / AIVE_FFPROBE env vars (used
 * by packaged desktop builds that ship their own binaries). Otherwise we rely
 * on `ffmpeg` / `ffprobe` being on PATH.
 */
export const FFMPEG_BIN = process.env.AIVE_FFMPEG || "ffmpeg";
export const FFPROBE_BIN = process.env.AIVE_FFPROBE || "ffprobe";

/** First line of FFMPEG_BIN's `-version` banner ("" when it does not run); the one probe ffmpegVersion makes. */
export function ffmpegVersionLine(): Promise<string> {
  return ffmpegVersion().then((v) => v.banner, () => "");
}

/** FFmpeg generation of FFMPEG_BIN: its release major, or the one its libavfilter implies for a git build (0 when unknown). */
export async function ffmpegMajorVersion(): Promise<number> {
  return (await ffmpegVersion().catch(() => null))?.generation ?? 0;
}

/**
 * Options whose value is a filtergraph, by base name: FFmpeg also accepts them
 * with a stream specifier (`-filter:v:0`, `-af:1`) and, from 7.0, with a `/`
 * prefix that reads the value from a file (`-/vf graph.txt`).
 */
const FILTERGRAPH_OPTION_BASES: ReadonlySet<string> = new Set(["filter", "vf", "af", "filter_complex", "lavfi"]);
/** Options that read a filtergraph from a file (older spellings of `-/…`). */
const FILTERGRAPH_FILE_OPTIONS: ReadonlySet<string> = new Set(["filter_script", "filter_complex_script"]);

/** An argument read as an FFmpeg option: its base name (no "-", "/" or ":stream"), and whether "-/" reads the value from a file. */
function ffmpegOption(a: string): { base: string; fromFile: boolean } | null {
  if (a.length < 2 || a[0] !== "-") return null;
  const fromFile = a[1] === "/";
  return { base: a.slice(fromFile ? 2 : 1).split(":")[0], fromFile };
}

/**
 * Filters that open media, sockets or shared libraries on their own (outside
 * the `-i` inputs and so outside `-protocol_whitelist`): movie/amovie and
 * subtitles/ass open any URL through libavformat, zmq/azmq bind a socket, and
 * frei0r/ladspa/lv2 load a plugin library by path. SynthCut never builds any
 * of them (it does use sendcmd, lut3d and vidstab, which read its own local
 * files). Matched at a filter-name position, with an optional `@instance`.
 */
const FORBIDDEN_FILTERS: ReadonlySet<string> = new Set(["movie", "amovie", "subtitles", "ass", "zmq", "azmq", "frei0r", "frei0r_src", "ladspa", "lv2"]);

/**
 * Every filter SynthCut builds (ffmpeg/graph.ts with the effect, audio-effect
 * and blend registries, the bakes, timefx, analysis, matting, reframe, the
 * FFmpeg 8.1 alpha-mode adaptation and the colour pipeline), then the
 * generators and meters its smokes run through runFfmpeg. A graph that names
 * any other filter is refused: graph text is built from project values in many
 * places, and FFmpeg has too many filters that read or write files by option
 * (metadata, ametadata, psnr, ssim, vidstabdetect, libvmaf, deshake,
 * signature, sr/dnn_*, arnndn, removelogo, …, more in every release) to deny
 * them one by one. A filter that SynthCut uses and that takes a file is only
 * accepted with a file in its working directory (see {@link FILE_OPTIONS}).
 * Inventory: a static scan of the source plus a full test-matrix run with
 * AIVE_GUARD_REPORT set (every filter a run builds is logged), on FFmpeg 4.4
 * and 8.1.
 */
const ALLOWED_FILTERS: ReadonlySet<string> = new Set([
  // video
  "alphaextract", "alphamerge", "blend", "cas", "chromakey", "color", "colorbalance", "colorchannelmixer", "colorhold",
  "colorkey", "crop", "curves", "despill", "drawtext", "edgedetect", "eq", "exposure", "fade", "fillborders", "format",
  "fps", "framerate", "gblur", "geq", "hflip", "histogram", "hqdn3d", "hue", "lagfun", "lenscorrection", "lumakey",
  "lut", "lut2", "lut3d", "lutrgb", "minterpolate", "negate", "noise", "overlay", "pad", "perspective", "premultiply",
  "reverse", "rgbashift", "rotate", "scale", "select", "sendcmd", "setparams", "setpts", "setsar", "showinfo",
  "signalstats", "split", "tpad", "trim", "unpremultiply", "unsharp", "vectorscope", "vflip", "vibrance",
  "vidstabdetect", "vidstabtransform", "vignette", "waveform", "xfade",
  // audio
  "acompressor", "acrossfade", "adeclick", "adelay", "aecho", "aeval", "afade", "afftdn", "afftfilt", "aformat",
  "agate", "alimiter", "amix", "anlmdn", "anoisesrc", "anullsrc", "apad", "aresample", "areverse", "asetnsamples",
  "asetpts", "asetrate", "asettb", "asoftclip", "asplit", "atempo", "atrim", "deesser", "dynaudnorm", "ebur128",
  "equalizer", "highpass", "highshelf", "loudnorm", "lowpass", "lowshelf", "rubberband", "sidechaincompress",
  "silencedetect", "vibrato", "volume",
  // both
  "concat", "metadata", "null",
  // generators and meters the smokes run through runFfmpeg (no file options)
  "aevalsrc", "anull", "nullsrc", "sine", "testsrc", "testsrc2", "volumedetect", "zoompan",
]);

/** How the guard treats the options of an allowed filter that can open a file. */
interface FileOptionRule {
  /**
   * Options (with every alias) naming a file SynthCut stages, each with the
   * name the engine gives that file: only such a bare name, in an owned
   * working directory. A write option can then never overwrite another kind
   * of file (a bake, a project) in that directory.
   */
  files?: Readonly<Record<string, RegExp>>;
  /** Options SynthCut never sets that read or write a file (or run commands): refused. */
  refused?: readonly string[];
  /** The positional (unnamed) values SynthCut passes, in order ("file": the `file` option's); a further one is refused (it could reach a file option). */
  positional: readonly ("value" | "file")[];
  /** What a file the filter reads may hold; checked before the run (sendcmd: the commands it sends to other filters). */
  content?: RegExp;
}

/** Text files of overlays and captions (engine stageRender: txt_<overlay>.txt, cap_<clip>_<cue>.txt). */
const TEXT_FILE = /^(?:txt|cap)_.*\.txt$/;
/** Fonts staged for drawtext (engine stageFont / resolveFont: font.ttf, font_<n>.ttf / .otf). */
const FONT_FILE = /^font(?:_\d+)?\.(?:ttf|otf)$/;
/** LUTs staged for lut3d (engine stageRender: lut<n>.cube). */
const LUT_FILE = /^lut\d+\.cube$/;
/** vidstab transform files (engine stabilize: <clip>-stab-<run>.trf). */
const TRF_FILE = /\.trf$/;
/** The auto-reframe crop plan (engine reframe: <clip>-reframe.txt). */
const REFRAME_FILE = /-reframe\.txt$/;

/**
 * The only sendcmd file SynthCut writes: the auto-reframe crop plan, exactly
 * as reframe.ts cropPlanToSendcmd writes it (`<seconds> crop x|y <integer>;`
 * per line). sendcmd applies its commands at run time to any filter in the
 * graph, past every option check here (curves plot= writes any file, drawtext
 * reinit re-reads its files), so nothing else may be in it: no other target
 * or command, no interval flags, no comments.
 */
const REFRAME_PLAN = /^(?:\d+\.\d{3} crop [xy] -?\d+;\r?\n)+$/;
/** Largest sendcmd file the guard reads (a reframe plan is a few KB: at most 2 lines per sampled frame). */
const SENDCMD_MAX_BYTES = 1024 * 1024;

/**
 * The allowed filters with an option that opens a file (from `ffmpeg -h
 * filter=<name>` on FFmpeg 4.4 – 9.0). SynthCut stages every file such a
 * filter reads or writes in the run's working directory and names it there
 * (lut0.cube, font_0.ttf, txt_….txt, …-stab-….trf, …-reframe.txt); a path, a
 * protocol, a name outside that directory or a name of another shape can only
 * be injected.
 */
const FILE_OPTIONS: Readonly<Record<string, FileOptionRule>> = {
  drawtext: { files: { fontfile: FONT_FILE, textfile: TEXT_FILE }, positional: [] },
  lut3d: { files: { file: LUT_FILE }, positional: ["file"] },
  vidstabdetect: { files: { result: TRF_FILE }, positional: [] },
  vidstabtransform: { files: { input: TRF_FILE }, positional: [] },
  sendcmd: { files: { filename: REFRAME_FILE, f: REFRAME_FILE }, refused: ["commands", "c"], positional: [], content: REFRAME_PLAN },
  metadata: { refused: ["file"], positional: ["value"] },
  curves: { refused: ["psfile", "plot"], positional: [] },
  loudnorm: { refused: ["stats_file"], positional: [] },
};

/**
 * Allowed filters with a run-time command that opens a file: curves' psfile
 * and plot options carry the T (runtime) flag, and drawtext's reinit command
 * re-reads textfile / fontfile (`ffmpeg -h filter=<name>` on 4.4, 8.1 and
 * 9.0: no other allowed filter has a T-flagged file option). A graph with
 * sendcmd may not have them, whatever its command file holds.
 */
const RUNTIME_FILE_FILTERS: ReadonlySet<string> = new Set(["curves", "drawtext"]);

/**
 * A file name in the working directory: no directory part, drive, protocol or
 * leading dot. A leading "-" is allowed: bake names start with a clip id
 * (safeFileStem keeps a plain-token id such as "-x" as it is).
 */
const BARE_FILE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

/** Directories whose subtrees SynthCut owns as FFmpeg working directories, besides the OS temp dir (see {@link addFfmpegWorkRoot}). */
const workRoots = new Set<string>();

/**
 * Own `dir` (the engine's data dir) as a root for FFmpeg working
 * directories: a graph that names a file by bare name is only run with its
 * cwd inside one of these or inside the OS temp dir.
 */
export function addFfmpegWorkRoot(dir: string): void {
  workRoots.add(resolve(dir));
}

/**
 * True when `cwd` is set and inside a SynthCut-owned directory. A bare file
 * name resolves against the spawn's cwd: without one it is the process's own
 * (the launch directory, often the user's home), where an injected
 * textfile= would read the user's files and result= would write there.
 */
function ownedWorkDir(cwd: string | undefined): boolean {
  if (!cwd) return false;
  const at = resolve(cwd);
  return [resolve(tmpdir()), ...workRoots].some((root) => {
    const rel = relative(root, at);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });
}

/**
 * One token the way FFmpeg's av_get_token reads it (libavutil/avstring.c):
 * leading whitespace skipped, `\x` is a literal x, `'…'` is literal up to the
 * next quote, unquoted trailing whitespace dropped; it stops before an
 * unquoted, unescaped character in `term`. Returns the token and where it ended.
 */
function avGetToken(s: string, start: number, term: string): { token: string; end: number } {
  let i = start;
  while (i < s.length && /\s/.test(s[i])) i++;
  let out = "";
  let keep = 0; // length of `out` that trailing-whitespace trimming must not cut (escaped or quoted text)
  while (i < s.length && !term.includes(s[i])) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      out += s[i + 1];
      keep = out.length;
      i += 2;
    } else if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close < 0) throw new Error("unterminated quote in a filtergraph");
      out += s.slice(i + 1, close);
      keep = out.length;
      i = close + 1;
    } else {
      out += c;
      i++;
    }
  }
  let end = out.length;
  while (end > keep && /\s/.test(out[end - 1])) end--;
  return { token: out.slice(0, end), end: i };
}

/** One filter of a graph: its name (lower case, no `@instance`) and its argument string as the graph parser hands it to the filter. */
export interface GraphFilter {
  name: string;
  /** The `=…` part with the graph level of quoting removed (undefined: no arguments). */
  args?: string;
}

/**
 * The filters of graph `g`, read the way libavfilter's graph parser does
 * (graphparser.c: [labels] name[@id][=args][labels], separated by `,` / `;`),
 * so quoting or escaping a name (`'movie'=…`, `mo\vie=…`) can't hide it from the
 * check the way it would from a pattern. Throws on a graph it can't read.
 */
export function filterGraphFilters(g: string): GraphFilter[] {
  const filters: GraphFilter[] = [];
  let i = 0;
  const skipWs = () => {
    while (i < g.length && /\s/.test(g[i])) i++;
  };
  const labels = () => {
    for (skipWs(); g[i] === "["; skipWs()) {
      // A label is itself an av_get_token up to "]", so an escaped "\]" doesn't end it.
      const label = avGetToken(g, i + 1, "]");
      if (g[label.end] !== "]") throw new Error("unterminated [label] in a filtergraph");
      i = label.end + 1;
    }
  };
  for (;;) {
    labels();
    if (i >= g.length) break;
    const name = avGetToken(g, i, "=,;[");
    i = name.end;
    const filter: GraphFilter = { name: name.token.split("@")[0].toLowerCase() };
    if (g[i] === "=") {
      const args = avGetToken(g, i + 1, "[],;");
      filter.args = args.token;
      i = args.end;
    }
    filters.push(filter);
    labels();
    if (i >= g.length) break;
    if (g[i] !== "," && g[i] !== ";") throw new Error(`unexpected "${g[i]}" in a filtergraph`);
    i++;
  }
  return filters;
}

/** The filter names of graph `g` ({@link filterGraphFilters}). */
export function filterGraphNames(g: string): string[] {
  return filterGraphFilters(g).map((f) => f.name);
}

/** One option of a filter's arguments: `key` is undefined for a positional (shorthand) value. */
export interface FilterOption {
  key?: string;
  value: string;
}

/** av_opt_get_key_value's key characters (libavutil/opt.c is_key_char). */
const OPTION_KEY_CHAR = /[A-Za-z0-9_\-/.]/;
const OPTION_WS = /[ \n\t\r]/;

/**
 * A filter's argument string split into options the way libavfilter's
 * process_options reads it (av_opt_get_key_value with "=" and ":"): a
 * `key=` prefix names the option, anything else is the next positional
 * value, and every value is one more av_get_token level (so `'…'` and `\:`
 * can't hide a path from the checks below).
 */
export function filterOptions(args: string): FilterOption[] {
  const out: FilterOption[] = [];
  let i = 0;
  while (i < args.length) {
    let k = i;
    while (k < args.length && OPTION_WS.test(args[k])) k++;
    const keyStart = k;
    while (k < args.length && OPTION_KEY_CHAR.test(args[k])) k++;
    const keyEnd = k;
    while (k < args.length && OPTION_WS.test(args[k])) k++;
    const named = args[k] === "=";
    const value = avGetToken(args, named ? k + 1 : i, ":");
    out.push(named ? { key: args.slice(keyStart, keyEnd), value: value.token } : { value: value.token });
    i = value.end;
    if (i < args.length) i++; // the ":" separator
  }
  return out;
}

/**
 * AIVE_GUARD_REPORT: instead of refusing a graph for an unknown filter or a
 * file option, log what strict mode would refuse ("1": to stderr, otherwise
 * appended to that file) and let it run. For collecting the filters a test
 * run uses; never set in production. The always-forbidden filters and an
 * unreadable graph are refused in both modes.
 */
function refuseOrReport(message: string): void {
  const to = process.env.AIVE_GUARD_REPORT;
  if (!to) throw new Error(message);
  const line = `[ffmpeg-guard] ${message}\n`;
  if (to === "1") process.stderr.write(line);
  else appendFileSync(to, line);
}

/**
 * Throw when filtergraph `g` (the value of `flag`) can't be read, uses a
 * {@link FORBIDDEN_FILTERS} filter or one that is not in
 * {@link ALLOWED_FILTERS}, or gives an allowed filter an option that opens a
 * file outside its working directory `cwd` ({@link FILE_OPTIONS}).
 */
function assertGraphSafe(g: string, flag: string, cwd: string | undefined): void {
  let filters: GraphFilter[];
  try {
    filters = filterGraphFilters(g);
  } catch (err) {
    throw new Error(`Refusing an ffmpeg ${flag} graph SynthCut can't read safely: ${(err as Error).message}.`);
  }
  const bad = filters.find((f) => FORBIDDEN_FILTERS.has(f.name));
  if (bad) {
    throw new Error(
      `Refusing an ffmpeg ${flag} graph that uses the ${bad.name} filter — SynthCut never builds one (it opens files, URLs or sockets by itself), so this came from an injected project field.`,
    );
  }
  const commanded = filters.some((f) => f.name === "sendcmd") && filters.find((f) => RUNTIME_FILE_FILTERS.has(f.name));
  if (commanded) {
    refuseOrReport(
      `Refusing an ffmpeg ${flag} graph with both sendcmd and ${commanded.name} (a run-time command could make ${commanded.name} open a file) — SynthCut never builds that, so this came from an injected project field.`,
    );
  }
  for (const f of filters) {
    if (!ALLOWED_FILTERS.has(f.name)) {
      refuseOrReport(
        `Refusing an ffmpeg ${flag} graph that uses the unknown filter "${f.name}" — SynthCut never builds it, so this came from an injected project field.`,
      );
    } else if (f.args !== undefined) {
      assertOptionsSafe(f.name, f.args, flag, cwd);
    }
  }
}

/** Refuse (or report) a `name=args` filter whose options could open a file SynthCut did not stage. */
function assertOptionsSafe(name: string, args: string, flag: string, cwd: string | undefined): void {
  let options: FilterOption[];
  try {
    options = filterOptions(args);
  } catch (err) {
    throw new Error(`Refusing an ffmpeg ${flag} graph SynthCut can't read safely: ${(err as Error).message}.`);
  }
  const rule = FILE_OPTIONS[name];
  const refuse = (what: string) =>
    refuseOrReport(`Refusing an ffmpeg ${flag} graph: ${name} ${what} — SynthCut never builds that, so this came from an injected project field.`);
  /** A file option's bare name, opened in `cwd`: only of the engine's `shape`, in a SynthCut-owned working directory, and holding what the rule allows. */
  const fileOk = (value: string, shape: RegExp | undefined, what: string) => {
    if (!BARE_FILE.test(value)) refuse(`${what} "${value}" outside its working directory`);
    else if (!shape?.test(value)) refuse(`${what} "${value}", a name SynthCut never gives that file`);
    else if (!ownedWorkDir(cwd)) refuse(`${what} "${value}" in ${cwd ? `"${cwd}", which is not a SynthCut working directory` : "the process's working directory"}`);
    else if (rule?.content && !fileHolds(join(cwd!, value), rule.content)) refuse(`${what} "${value}", which holds more than SynthCut ever writes to it`);
  };
  const shapeOf = (key: string) => (rule?.files && Object.hasOwn(rule.files, key) ? rule.files[key] : undefined);
  let positional = 0;
  for (const o of options) {
    if (o.key === undefined) {
      const slot = rule?.positional[positional++];
      if (!rule) continue;
      if (slot === undefined) refuse(`has an unexpected positional value "${o.value}"`);
      else if (slot === "file") fileOk(o.value, shapeOf("file"), "reads the file");
      continue;
    }
    // FFmpeg 7.0+ reads an option's value from the file a "/" key prefix names (-vf drawtext=/text=…).
    if (o.key.startsWith("/")) {
      refuse(`reads option ${o.key.slice(1)} from the file "${o.value}"`);
      continue;
    }
    if (!rule) continue;
    const key = o.key.toLowerCase();
    if (rule.refused?.includes(key)) refuse(`option ${o.key}="${o.value}"`);
    else if (shapeOf(key)) fileOk(o.value, shapeOf(key), "opens the file");
  }
}

/** True when `path` is a readable file of at most {@link SENDCMD_MAX_BYTES} whose whole text `content` matches. */
function fileHolds(path: string, content: RegExp): boolean {
  try {
    return statSync(path).size <= SENDCMD_MAX_BYTES && content.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

/** The `-f <format>` given as an input option of the `-i` at index `i` (between the previous `-i` and it). */
function inputFormat(args: readonly string[], i: number): string | undefined {
  for (let j = i - 1; j > 0 && args[j - 1] !== "-i"; j--) {
    if (args[j - 1] === "-f") return args[j];
  }
  return undefined;
}

/**
 * Final backstop against SSRF / protocol reads and file reads or writes at the
 * FFmpeg boundary. The core only ever hands FFmpeg/ffprobe LOCAL files (plus
 * its own pipes and `-f lavfi`/`-f concat` inputs it builds by bare name) and
 * builds graphs from its own filters; anything else could only come from a
 * project value that slipped past the load-time guard. What this guarantees
 * for every graph option (`-vf`, `-af`, `-filter_complex`, `-filter:v:0`, a
 * `-f lavfi` input …):
 * - no filter that opens its own source (movie=, subtitles=, zmq …, see
 *   {@link FORBIDDEN_FILTERS}) and no filter SynthCut does not build
 *   ({@link ALLOWED_FILTERS}: metadata's file=, psnr, ssim, asendcmd …);
 * - a filter option opens a file only by a bare name of the shape the engine
 *   gives that file ({@link FILE_OPTIONS}), in a `cwd` SynthCut owns (the data
 *   dir or the OS temp dir, {@link addFfmpegWorkRoot}); with `cwd` unset any
 *   such name is refused, since it would open in the process's own directory;
 * - the options that write or read other files (curves plot / psfile,
 *   metadata file, loudnorm stats_file, sendcmd commands) and FFmpeg 7+'s
 *   `/option` (a value read from a file) are refused;
 * - run-time commands: sendcmd's file must hold only the reframe crop plan
 *   ({@link REFRAME_PLAN}), and a graph with sendcmd may not have a filter
 *   whose run-time commands open files ({@link RUNTIME_FILE_FILTERS});
 * - a graph read from a file (`-filter_complex_script`, `-/vf` …) is refused.
 * Bitstream filters (`-bsf:v h264_metadata=…`) are not checked: none of them
 * on FFmpeg 4.4 – 9.0 has an option that names a file, and they don't read the
 * `/option` file form. It is the TypeScript half; {@link ffmpegArgsLocalOnly}
 * adds FFmpeg's own `-protocol_whitelist`, so an input form this parser
 * misreads is still refused by FFmpeg itself.
 *
 * Exempt `-i` inputs: anything with no colon (a bare filename like `v.txt`,
 * never a protocol), `pipe:N` / `-`, and an input declared by a `-f lavfi` /
 * `-f concat` (anullsrc, the concat list; a lavfi graph is checked like any
 * other graph instead). A Windows drive path (`C:\…`) has a colon but is
 * NOT a protocol — {@link looksLikeProtocol} lets it through.
 *
 * `cwd` is the spawn's working directory, where a bare file name in a graph
 * opens.
 */
export function guardFfmpegArgs(args: readonly string[], cwd?: string): void {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-i") {
      const input = args[i + 1];
      if (input === undefined) continue;
      // FFmpeg matches a format name case-insensitively (`-f LAVFI` is lavfi).
      const fmt = inputFormat(args, i)?.toLowerCase();
      if (fmt === "lavfi") {
        assertGraphSafe(input, "-f lavfi -i", cwd);
        continue;
      }
      if (fmt === "concat") continue;
      if (input === "-" || /^pipe:\d*$/.test(input)) continue;
      assertFfmpegInputLocal(input, "ffmpeg -i input");
    } else {
      const opt = ffmpegOption(a);
      if (!opt) continue;
      // A graph read from a file can't be checked here; the core always passes
      // graphs inline (runFfmpeg moves a long one into its own file only after
      // this check), so a file-reading graph option can only be injected.
      if (FILTERGRAPH_FILE_OPTIONS.has(opt.base) || (opt.fromFile && FILTERGRAPH_OPTION_BASES.has(opt.base))) {
        throw new Error(`Refusing ffmpeg option ${a}: it reads a filtergraph from a file, which SynthCut never passes itself.`);
      }
      if (FILTERGRAPH_OPTION_BASES.has(opt.base)) {
        const g = args[i + 1];
        if (typeof g === "string") assertGraphSafe(g, a, cwd);
      }
    }
  }
}

/** Assert a single ffmpeg/ffprobe input is local (not a protocol). Bare, colon-free names pass. */
function assertFfmpegInputLocal(input: string, where: string): void {
  if (!input.includes(":")) return; // bare filename — can't be a protocol
  if (looksLikeProtocol(input)) {
    const scheme = protocolName(input);
    const shown = input.length > 120 ? `${input.slice(0, 117)}…` : input;
    throw new Error(
      `Refusing ${where} "${shown}": "${scheme}:" is a protocol/URL, not a local file. SynthCut only reads local media (relink the file to this machine).`,
    );
  }
  // Has a colon but is not a protocol (a Windows drive path C:\…) — allowed.
}

/** Guard ffprobe args: the media file is the LAST positional argument. */
export function guardFfprobeArgs(args: readonly string[]): void {
  const last = args[args.length - 1];
  if (typeof last === "string") assertFfmpegInputLocal(last, "ffprobe input");
}

/**
 * The only protocols FFmpeg/ffprobe may open for an input: local files and the
 * core's own pipes (`-i -` is `pipe:` in FFmpeg 4.x and `fd:` in newer builds).
 * Nested opens (a concat list's entries, an image sequence) inherit it.
 */
export const PROTOCOL_WHITELIST = "file,pipe,fd";

/**
 * `args` checked by {@link guardFfmpegArgs} and with `-protocol_whitelist`
 * before every `-i`, so FFmpeg itself refuses any input that is not a local
 * file or pipe even where the TypeScript guard reads the input name differently
 * from FFmpeg. Every ffmpeg spawn in the core goes through this; pass the
 * spawn's `cwd` when its graph names files. The added flags are not part of
 * any cache key (segmentKey hashes clip data, not args).
 */
export function ffmpegArgsLocalOnly(args: readonly string[], cwd?: string): string[] {
  guardFfmpegArgs(args, cwd);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-i" && i + 1 < args.length) out.push("-protocol_whitelist", PROTOCOL_WHITELIST);
    out.push(args[i]);
  }
  return out;
}

/** {@link ffmpegArgsLocalOnly} for ffprobe: the whitelist goes before the input (the last argument). */
export function ffprobeArgsLocalOnly(args: readonly string[]): string[] {
  guardFfprobeArgs(args);
  if (args.length === 0) return [];
  return [...args.slice(0, -1), "-protocol_whitelist", PROTOCOL_WHITELIST, args[args.length - 1]];
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

/**
 * Extract the meaningful tail of an ffmpeg stderr dump. ffmpeg prints the actual
 * cause (an invalid color, an unparseable filter option, a missing file) on the
 * last few lines after pages of banner/progress noise. We surface that tail in
 * the thrown error message so callers — including the AI driving the editor over
 * MCP — see *why* a render failed and can self-correct, instead of an opaque
 * "Command failed with exit code 1".
 */
export function ffmpegStderrDetail(stderr: string, maxLines = 5, maxChars = 600): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // Drop the version/config banner and benign progress lines.
    .filter((l) => !/^(ffmpeg version|built with|configuration:|lib\w+\s+\d|Input #|Stream #|Press \[q\]|frame=|size=|video:|audio:|Output #|Metadata:)/i.test(l));
  const tail = lines.slice(-maxLines).join(" | ");
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
}

/**
 * Environment additions for the children of the runFfprobe / runFfmpeg*
 * helpers below (execa merges them into process.env); vidstab runs through
 * runFfmpeg. Children spawned elsewhere with execa, and the -version / -h
 * capability probes, do not get them. A system FFmpeg that links libvidstab
 * with libgomp (Ubuntu's 4.4.2) spins its OpenMP threads while they wait:
 * vidstabdetect burned 88.7 CPU-seconds for 4.5 s of wall time on 10 s of
 * 1080p, and 28.4 with OMP_WAIT_POLICY=passive. Builds without OpenMP (the
 * bundled one) ignore it; a value the user set is kept.
 */
const CHILD_ENV = { OMP_WAIT_POLICY: process.env.OMP_WAIT_POLICY ?? "passive" };

/** Run ffprobe and return its stdout (typically JSON). */
export async function runFfprobe(args: string[]): Promise<string> {
  const run = ffprobeArgsLocalOnly(args);
  try {
    const { stdout } = await execa(FFPROBE_BIN, run, { reject: true, env: CHILD_ENV });
    return stdout;
  } catch (err: unknown) {
    const e = err as { stderr?: string; shortMessage?: string; message?: string };
    throw new FfmpegError(
      `ffprobe failed: ${e.shortMessage || e.message || "unknown error"}`,
      `${FFPROBE_BIN} ${args.join(" ")}`,
      e.stderr || "",
    );
  }
}

export interface FfmpegRunOptions {
  /** Called with a 0..1 progress fraction when a total duration is known. */
  onProgress?: (fraction: number) => void;
  /** Total output duration in seconds, used to compute progress. */
  totalDuration?: number;
  /** AbortSignal to cancel a long-running render. */
  signal?: AbortSignal;
  /**
   * Working directory. Set this when the filtergraph references files by bare
   * name (LUTs, vidstab transform files) — on Windows, absolute paths with a
   * drive-letter colon cannot be parsed inside a filtergraph, so we cd into the
   * directory and use relative filenames instead. Such a graph is refused
   * unless this is inside the data dir or the OS temp dir (addFfmpegWorkRoot).
   */
  cwd?: string;
}

/**
 * Longest `-filter_complex` graph (characters) passed inline on the command
 * line. A longer one goes to a file (see {@link runFfmpeg}): Linux limits ONE
 * argument to 128 KiB (MAX_ARG_STRLEN → spawn E2BIG) and Windows limits the
 * WHOLE command line to 32,767 characters. Speed-ramped clips reach these
 * limits (their audio is many time-stretched chunks); ordinary graphs are a
 * few KB and stay inline, so their commands do not change.
 */
export const INLINE_FILTERGRAPH_MAX = 16 * 1024;

/**
 * The options that read a filtergraph from a file. `-filter_complex_script`
 * works in FFmpeg 4.x–8.x (deprecated from 7.0, removed in 9.0);
 * `-/filter_complex` (the generic "-/option <file>" form) exists from 7.0.
 * runFfmpeg starts with the one this version prefers (ffmpegVersion) and
 * changes to the other once when this ffmpeg does not know it.
 */
const FILTER_SCRIPT_FLAGS = ["-filter_complex_script", "-/filter_complex"] as const;
/** Index into FILTER_SCRIPT_FLAGS; null until the first long graph picks it from the version. */
let filterScriptFlag: number | null = null;

/** The filtergraph-file option the next long graph starts with (null: not chosen yet). */
export function filterScriptFlagInUse(): (typeof FILTER_SCRIPT_FLAGS)[number] | null {
  return filterScriptFlag === null ? null : FILTER_SCRIPT_FLAGS[filterScriptFlag];
}

/**
 * Make the next long graph start with `flag` (null: choose from the version
 * again). smoke-ffcompat uses it to run the fallback against a real binary.
 */
export function setFilterScriptFlag(flag: (typeof FILTER_SCRIPT_FLAGS)[number] | null): void {
  filterScriptFlag = flag === null ? null : FILTER_SCRIPT_FLAGS.indexOf(flag);
}

let versionPromise: Promise<FfmpegVersion> | null = null;

/**
 * The running FFmpeg's version (`ffmpeg -version`, probed once per process; a
 * failed probe is not cached, so installing FFmpeg later is picked up).
 * Rejects when ffmpeg can't be run.
 */
export function ffmpegVersion(): Promise<FfmpegVersion> {
  if (!versionPromise) {
    versionPromise = execa(FFMPEG_BIN, ["-version"], { reject: true }).then(
      (r) => parseFfmpegVersion(r.stdout),
      (err: unknown) => {
        versionPromise = null;
        throw err;
      },
    );
  }
  return versionPromise;
}

/** True when this FFmpeg's acrossfade can't be trusted (7.x; version.ts acrossfadeUnreliable). */
export async function acrossfadeNeedsMix(): Promise<boolean> {
  return acrossfadeUnreliable(await ffmpegVersion().catch(() => null));
}

let alphaModesPromise: Promise<boolean> | null = null;

/**
 * True when this FFmpeg negotiates alpha modes (8.1+; its `setparams` has an
 * `alpha_mode` option). Probed once, only when a graph uses (un)premultiply;
 * a failed probe is not cached (as ffmpegVersion), so an FFmpeg installed
 * later is asked again.
 */
export function hasAlphaModes(): Promise<boolean> {
  if (!alphaModesPromise) {
    alphaModesPromise = execa(FFMPEG_BIN, ["-hide_banner", "-h", "filter=setparams"], { reject: false })
      .then((r) => {
        if (r.failed || r.exitCode !== 0) throw new Error("ffmpeg -h failed");
        return /^\s*alpha_mode\s/m.test(r.stdout);
      })
      .catch(() => {
        alphaModesPromise = null;
        return false;
      });
  }
  return alphaModesPromise;
}

let anlmdnPromise: Promise<boolean> | null = null;

/**
 * False when this FFmpeg's anlmdn crashes (FFmpeg 9.0 corrupts its heap on
 * any input, which would kill the whole export). A 0.25 s run on generated
 * noise, once per process, only when a render would use anlmdn.
 */
export function anlmdnWorks(): Promise<boolean> {
  if (!anlmdnPromise) {
    anlmdnPromise = execa(
      FFMPEG_BIN,
      ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "anoisesrc=d=0.25:sample_rate=48000:amplitude=0.1", "-af", "anlmdn", "-f", "null", "-"],
      { reject: false },
    )
      .then((r) => r.exitCode === 0)
      .catch(() => false);
  }
  return anlmdnPromise;
}

/**
 * `args` adapted to this FFmpeg: every filtergraph option goes through
 * version.ts adaptFilterGraph (only 8.1+ with (un)premultiply in the graph
 * changes anything). Returns `args` itself otherwise, so FFmpeg 4.4 – 8.0 run
 * exactly the command the graph builders produced.
 */
export async function adaptFfmpegArgs(args: string[]): Promise<string[]> {
  const isGraph = (i: number) => i > 0 && FILTERGRAPH_OPTIONS.has(args[i - 1]);
  if (!args.some((a, i) => isGraph(i) && usesPremultiply(a)) || !(await hasAlphaModes())) return args;
  return args.map((a, i) => (isGraph(i) ? adaptFilterGraph(a, { alphaModes: true }) : a));
}

/**
 * Where `args` has a `-filter_complex` graph longer than `max`: the index of
 * the `-filter_complex` flag, else -1.
 */
export function longFilterGraphIndex(args: readonly string[], max = INLINE_FILTERGRAPH_MAX): number {
  const at = args.indexOf("-filter_complex");
  return at >= 0 && at + 1 < args.length && args[at + 1].length > max ? at : -1;
}

/** `args` with the `-filter_complex <graph>` pair at `at` replaced by `<flag> <file>`. */
export function withFilterGraphFile(args: readonly string[], at: number, file: string, flag: string): string[] {
  return [...args.slice(0, at), flag, file, ...args.slice(at + 2)];
}

/**
 * Run an ffmpeg command to completion. Parses `-progress pipe:1` output (the
 * caller must include those flags) to report progress.
 *
 * A `-filter_complex` graph longer than {@link INLINE_FILTERGRAPH_MAX} is
 * written to a temporary file (in `cwd` and passed by its bare name when a
 * `cwd` is set, else in the OS temp dir) and passed with
 * `-filter_complex_script` / `-/filter_complex`; the file is deleted after
 * the run.
 */
export async function runFfmpeg(built: string[], opts: FfmpegRunOptions = {}): Promise<void> {
  const args = ffmpegArgsLocalOnly(await adaptFfmpegArgs(built), opts.cwd);
  const at = longFilterGraphIndex(args);
  if (at < 0) return runFfmpegOnce(args, opts);
  if (filterScriptFlag === null) {
    const v = await ffmpegVersion().catch(() => null);
    filterScriptFlag = FILTER_SCRIPT_FLAGS.indexOf(preferredFilterScriptFlag(v));
  }
  const name = `filtergraph-${process.pid}-${randomUUID()}.txt`;
  const path = join(opts.cwd ?? tmpdir(), name);
  const graph = args[at + 1];
  await writeFile(path, graph, "utf8");
  const ref = opts.cwd ? name : path;
  try {
    for (let attempt = 0; ; attempt++) {
      const flag: (typeof FILTER_SCRIPT_FLAGS)[number] = FILTER_SCRIPT_FLAGS[filterScriptFlag ?? 0];
      try {
        return await runFfmpegOnce(withFilterGraphFile(args, at, ref, flag), opts);
      } catch (err) {
        // This ffmpeg does not know the option (it stops before reading any input): use the other one.
        const unknown = err instanceof FfmpegError && err.stderr.includes(`Unrecognized option '${flag.slice(1)}'`);
        if (attempt > 0 || !unknown || opts.signal?.aborted) {
          // Report the command with the graph inline (the file is deleted below).
          if (err instanceof FfmpegError) throw new FfmpegError(err.message, `${FFMPEG_BIN} ${args.join(" ")}`, err.stderr);
          throw err;
        }
        // (From the flag that failed, not a toggle: concurrent runs may fail on the same one.)
        filterScriptFlag = flag === FILTER_SCRIPT_FLAGS[0] ? 1 : 0;
      }
    }
  } finally {
    await rm(path, { force: true }).catch(() => {});
  }
}

async function runFfmpegOnce(args: string[], opts: FfmpegRunOptions): Promise<void> {
  const child: ResultPromise = execa(FFMPEG_BIN, args, {
    reject: true,
    buffer: { stdout: false, stderr: true },
    cancelSignal: opts.signal,
    cwd: opts.cwd,
    env: CHILD_ENV,
  });

  if (opts.onProgress && opts.totalDuration && opts.totalDuration > 0 && child.stdout) {
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        // ffmpeg emits `out_time_us=<microseconds>` lines under -progress.
        // NOTE: `out_time_ms` is ALSO microseconds — ffmpeg kept the wrong
        // name for compatibility — so both divide by 1e6.
        if (line.startsWith("out_time_us=") || line.startsWith("out_time_ms=")) {
          const raw = Number(line.split("=")[1]);
          if (Number.isFinite(raw)) {
            const seconds = raw / 1e6;
            const frac = Math.max(0, Math.min(1, seconds / opts.totalDuration!));
            opts.onProgress!(frac);
          }
        }
      }
    });
  }

  try {
    await child;
  } catch (err: unknown) {
    const e = err as { stderr?: string; shortMessage?: string; message?: string; isCanceled?: boolean };
    if (e.isCanceled) {
      throw new FfmpegError("ffmpeg render canceled", `${FFMPEG_BIN} ${args.join(" ")}`, e.stderr || "");
    }
    const detail = ffmpegStderrDetail(e.stderr || "");
    throw new FfmpegError(
      `ffmpeg failed${detail ? `: ${detail}` : `: ${e.shortMessage || e.message || "unknown error"}`}`,
      `${FFMPEG_BIN} ${args.join(" ")}`,
      e.stderr || "",
    );
  }
}

/**
 * Run ffmpeg and return its raw stdout as a Buffer (used by analysis paths that
 * pipe rawvideo to `pipe:1`, e.g. reading the mean RGB of a frame as 3 bytes).
 */
export async function runFfmpegStdoutBuffer(args: string[]): Promise<Buffer> {
  const { stdout } = await execa(FFMPEG_BIN, ffmpegArgsLocalOnly(await adaptFfmpegArgs(args)), {
    reject: true,
    encoding: "buffer",
    env: CHILD_ENV,
  });
  return stdout as unknown as Buffer;
}

/** Run ffmpeg and return combined stderr (used by analysis filters that log to stderr). */
export async function runFfmpegCaptureStderr(args: string[]): Promise<string> {
  const run = ffmpegArgsLocalOnly(await adaptFfmpegArgs(args));
  try {
    const result = await execa(FFMPEG_BIN, run, { reject: false, all: false, env: CHILD_ENV });
    return result.stderr ?? "";
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    return e.stderr ?? e.message ?? "";
  }
}

/** Verify ffmpeg & ffprobe are available; returns their version banner lines. */
let encodersPromise: Promise<Set<string>> | null = null;

/**
 * The set of encoder names this ffmpeg build ships (`ffmpeg -encoders`), probed
 * once per process and cached. Used to opportunistically pick a HARDWARE H.264/
 * HEVC encoder for previews/segment renders (2-10× faster than libx264).
 */
export function detectEncoders(): Promise<Set<string>> {
  if (!encodersPromise) {
    encodersPromise = execa(FFMPEG_BIN, ["-hide_banner", "-encoders"], { reject: true })
      .then((r) => {
        const names = new Set<string>();
        // Lines look like " V....D h264_nvenc   NVIDIA NVENC H.264 encoder".
        for (const line of r.stdout.split(/\r?\n/)) {
          const m = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line);
          if (m) names.add(m[1]);
        }
        return names;
      })
      .catch(() => new Set<string>());
  }
  return encodersPromise;
}

/** Preference-ordered hardware encoders per codec (NVIDIA → Intel → AMD → Apple). */
const HW_ENCODERS: Record<"h264" | "h265", string[]> = {
  h264: ["h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox"],
  h265: ["hevc_nvenc", "hevc_qsv", "hevc_amf", "hevc_videotoolbox"],
};

/**
 * Pick the best available HARDWARE encoder for a codec, or null when none is
 * available or hardware encoding is disabled (`AIVE_HWENC=off`; default auto).
 * NOTE: a listed encoder can still fail at runtime (no GPU/driver) — callers
 * must be prepared to retry with the software encoder.
 */
export async function pickHwEncoder(codec: "h264" | "h265"): Promise<string | null> {
  if ((process.env.AIVE_HWENC ?? "auto").toLowerCase() === "off") return null;
  const available = await detectEncoders();
  return HW_ENCODERS[codec].find((e) => available.has(e)) ?? null;
}

let binariesPromise: Promise<{ ffmpeg: string; ffprobe: string }> | null = null;

/**
 * The ffmpeg and ffprobe version banners. Probed once (the authenticated
 * /health asks on every call); a failure is not cached, so installing FFmpeg
 * while the core runs is picked up.
 */
export function checkBinaries(): Promise<{ ffmpeg: string; ffprobe: string }> {
  if (!binariesPromise) {
    binariesPromise = Promise.all([
      ffmpegVersion().then((v) => v.banner),
      execa(FFPROBE_BIN, ["-version"]).then((r) => r.stdout.split("\n")[0]),
    ]).then(
      ([ffmpeg, ffprobe]) => ({ ffmpeg, ffprobe }),
      (err: unknown) => {
        binariesPromise = null;
        throw err;
      },
    );
  }
  return binariesPromise;
}
