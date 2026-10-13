import { execa, type ResultPromise } from "execa";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

let versionLine: Promise<string> | undefined;
/** First line of FFMPEG_BIN's `-version` banner, probed once ("" when it does not run). */
export function ffmpegVersionLine(): Promise<string> {
  versionLine ??= execa(FFMPEG_BIN, ["-version"]).then(
    (r) => r.stdout.split("\n")[0].trim(),
    () => "",
  );
  return versionLine;
}

/** Major version of FFMPEG_BIN (0 when the banner has none, e.g. a git snapshot build). */
export async function ffmpegMajorVersion(): Promise<number> {
  const m = /^ffmpeg version n?(\d+)\.\d/.exec(await ffmpegVersionLine());
  return m ? Number(m[1]) : 0;
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

/** Run ffprobe and return its stdout (typically JSON). */
export async function runFfprobe(args: string[]): Promise<string> {
  try {
    const { stdout } = await execa(FFPROBE_BIN, args, { reject: true });
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
   * directory and use relative filenames instead.
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
 * works in FFmpeg 4.x–7.x (deprecated in 7.0 and removed later);
 * `-/filter_complex` (the generic "-/option <file>" form) exists from 7.0.
 * runFfmpeg uses the current one and changes to the other once when this
 * ffmpeg does not know it.
 */
const FILTER_SCRIPT_FLAGS = ["-filter_complex_script", "-/filter_complex"] as const;
let filterScriptFlag = 0;

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
export async function runFfmpeg(args: string[], opts: FfmpegRunOptions = {}): Promise<void> {
  const at = longFilterGraphIndex(args);
  if (at < 0) return runFfmpegOnce(args, opts);
  const name = `filtergraph-${process.pid}-${randomUUID()}.txt`;
  const path = join(opts.cwd ?? tmpdir(), name);
  const graph = args[at + 1];
  await writeFile(path, graph, "utf8");
  const ref = opts.cwd ? name : path;
  try {
    for (let attempt = 0; ; attempt++) {
      const flag = FILTER_SCRIPT_FLAGS[filterScriptFlag];
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
  const { stdout } = await execa(FFMPEG_BIN, args, {
    reject: true,
    encoding: "buffer",
  });
  return stdout as unknown as Buffer;
}

/** Run ffmpeg and return combined stderr (used by analysis filters that log to stderr). */
export async function runFfmpegCaptureStderr(args: string[]): Promise<string> {
  try {
    const result = await execa(FFMPEG_BIN, args, { reject: false, all: false });
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

export async function checkBinaries(): Promise<{ ffmpeg: string; ffprobe: string }> {
  const [ff, fp] = await Promise.all([
    execa(FFMPEG_BIN, ["-version"]).then((r) => r.stdout.split("\n")[0]),
    execa(FFPROBE_BIN, ["-version"]).then((r) => r.stdout.split("\n")[0]),
  ]);
  return { ffmpeg: ff, ffprobe: fp };
}
