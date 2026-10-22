"""Measurements on exported files: what the judge observes, never the editor's internals.

Python 3 standard library only. Each function reads a file with FFmpeg / ffprobe and returns numbers; the tests compare
them with their own expectations. The filter chains are the ones the first-try baseline's checker used (check.py 3
rev 4), so a value measured here and a baseline value measured there are the same measurement.

The last part ("Side effects") holds the judge's own observations of what the editor does around it: a loopback
listener that must receive nothing, the host-level trace (strace) of the adapter's process tree (its file-system calls,
and the network calls that show a download), files that must not appear, secrets that must not appear in any answer,
and the text substitution that makes a hostile input from a file the editor itself wrote (craft: when the file does
not hold the value as given, the input cannot be made and the checks on it are not applicable).

FFmpeg: JUDGE_FFMPEG / JUDGE_FFPROBE, else the ffmpeg / ffprobe on PATH. Heavy commands run under `nice -n 19` (when
`nice` exists) with a timeout.

A measurement that the file makes impossible (missing file, no video stream, no frame at t) raises Unmeasurable; the
test then fails that check with the reason.
"""
import hashlib
import ipaddress
import json
import math
import os
import re
import shutil
import socket
import subprocess
import tempfile
import threading

FFMPEG = os.environ.get("JUDGE_FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = os.environ.get("JUDGE_FFPROBE") or shutil.which("ffprobe") or "ffprobe"
NICE = ["nice", "-n", "19"] if shutil.which("nice") else []
TIMEOUT = 900
BAND_Q = 10          # bandpass Q per stage
BAND_STAGES = 4      # cascaded stages (leakage of a 440 Hz tone into the 330 Hz band is about -83 dB)


class Unmeasurable(Exception):
    """The file makes the measurement impossible (missing, unreadable, no stream, no frame at t)."""


def run(cmd, timeout=TIMEOUT, heavy=True):
    full = (NICE + cmd) if heavy else cmd
    try:
        return subprocess.run(full, capture_output=True, text=True, errors="replace", timeout=timeout,
                              stdin=subprocess.DEVNULL, check=False)
    except subprocess.TimeoutExpired as e:
        raise Unmeasurable(f"timed out after {timeout}s: {' '.join(cmd[:6])} ...") from e


def ffmpeg_version():
    """First line of `ffmpeg -version` of the FFmpeg the measurements use."""
    p = run([FFMPEG, "-hide_banner", "-version"], heavy=False, timeout=30)
    return (p.stdout.splitlines() or ["?"])[0]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------- probing
_probe_cache = {}


def probe(path):
    """ffprobe -show_format -show_streams as a dict (cached per path and modification time)."""
    key = (path, os.path.getmtime(path) if os.path.exists(path) else None)
    if key in _probe_cache:
        return _probe_cache[key]
    if not os.path.isfile(path):
        raise Unmeasurable(f"missing file {os.path.basename(path)}")
    p = run([FFPROBE, "-v", "error", "-show_format", "-show_streams", "-of", "json", path], heavy=False)
    try:
        info = json.loads(p.stdout or "{}")
    except json.JSONDecodeError:
        info = {}
    if "format" not in info:
        raise Unmeasurable(f"ffprobe cannot read {os.path.basename(path)}: {p.stderr.strip()[:300]}")
    _probe_cache[key] = info
    return info


def streams(path):
    return probe(path).get("streams", [])


def duration(path):
    """Container duration in seconds (ffprobe format duration)."""
    d = probe(path)["format"].get("duration")
    if d in (None, "N/A"):
        raise Unmeasurable("no container duration")
    return float(d)


def video_stream(path):
    for s in streams(path):
        if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic"):
            return s
    return None


def audio_stream(path):
    for s in streams(path):
        if s.get("codec_type") == "audio":
            return s
    return None


def stream_duration(s):
    """A stream's own duration in seconds, or None when the container does not record it."""
    d = (s or {}).get("duration")
    return None if d in (None, "N/A") else float(d)


def rotation(vs):
    rot = 0
    tags = vs.get("tags") or {}
    if "rotate" in tags:
        try:
            rot = int(float(tags["rotate"]))
        except ValueError:
            rot = 0
    for sd in vs.get("side_data_list") or []:
        if "rotation" in sd:
            try:
                rot = int(float(sd["rotation"]))
            except (TypeError, ValueError):
                pass
    return rot % 360


def display_geometry(vs):
    """(width, height, sar) as displayed: rotation by 90/270 swaps width and height."""
    w, h = int(vs["width"]), int(vs["height"])
    sar = vs.get("sample_aspect_ratio") or "1:1"
    try:
        n, d = (int(x) for x in sar.split(":"))
        sar_f = n / d if n > 0 and d > 0 else 1.0
    except ValueError:
        sar_f = 1.0
    if rotation(vs) in (90, 270):
        w, h = h, w
        sar_f = 1.0 / sar_f
    return w, h, sar_f


def size(path):
    """(width, height, sar) of the first video stream as displayed; Unmeasurable without one."""
    vs = video_stream(path)
    if vs is None:
        raise Unmeasurable(f"{os.path.basename(path)} has no video stream")
    return display_geometry(vs)


def _rate(text):
    try:
        n, d = (float(x) for x in str(text).split("/"))
        return n / d if d else None
    except ValueError:
        return None


def fps(path):
    """The first video stream's frame rate: avg_frame_rate, else r_frame_rate (frames per second)."""
    vs = video_stream(path)
    if vs is None:
        raise Unmeasurable(f"{os.path.basename(path)} has no video stream")
    r = _rate(vs.get("avg_frame_rate")) or _rate(vs.get("r_frame_rate"))
    if not r:
        raise Unmeasurable("no frame rate")
    return r


# ---------------------------------------------------------------- full decode
def decode(path):
    """Decodes every stream to the end: {exit, stderr (what `ffmpeg -v error` printed), video_frames, clean}.
    clean = exit 0, nothing printed at -v error, a video stream with at least one decoded frame."""
    if not os.path.isfile(path):
        raise Unmeasurable(f"missing file {os.path.basename(path)}")
    p = run([FFMPEG, "-nostdin", "-hide_banner", "-nostats", "-v", "error", "-progress", "pipe:1", "-i", path, "-f",
             "null", "-"])
    err = p.stderr.strip()
    frames = re.findall(r"^frame=(\d+)", p.stdout, re.M)
    nframes = int(frames[-1]) if frames else 0
    vs = video_stream(path)
    return {"exit": p.returncode, "stderr": err, "video_frames": nframes,
            "clean": p.returncode == 0 and err == "" and vs is not None and nframes > 0}


# ---------------------------------------------------------------- frames and SSIM
class Frames:
    """One frame per (path, t, size, extra filter), extracted once into a temp folder as yuv420p rawvideo .nut."""

    def __init__(self, tmp=None):
        self.tmp = tmp or tempfile.mkdtemp(prefix="judge-frames-")
        os.makedirs(self.tmp, exist_ok=True)
        self.n = 0
        self.cache = {}

    def get(self, path, t, size=None, vf_extra=None):
        """The first frame at/after t, optionally scaled to size=(w, h) (bicubic)."""
        key = (path, float(t), size, vf_extra)
        if key in self.cache:
            return self.cache[key]
        vs = video_stream(path)
        if vs is None:
            raise Unmeasurable(f"{os.path.basename(path)} has no video stream")
        if size is None:
            w, h = int(vs["width"]), int(vs["height"])
            vf = "format=yuv420p"
        else:
            w, h = size
            vf = f"scale={w}:{h}:flags=bicubic,format=yuv420p"
        if vf_extra:
            vf = f"{vf_extra},{vf}"
        self.n += 1
        out = os.path.join(self.tmp, f"f{self.n}.nut")
        p = run([FFMPEG, "-nostdin", "-hide_banner", "-v", "error", "-y", "-ss", f"{float(t):.3f}", "-i", path,
                 "-map", "0:v:0", "-frames:v", "1", "-vf", vf, "-c:v", "rawvideo", "-f", "nut", out])
        need = (w * h * 3) // 2  # one yuv420p frame; a header-only file means there was no frame at t
        if p.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) < need:
            raise Unmeasurable(f"no frame at {t}s in {os.path.basename(path)}"
                               + (f" ({p.stderr.strip()[:200]})" if p.stderr.strip() else ""))
        self.cache[key] = out
        return out


REGIONS = {
    None: "null",
    "centre": "crop=iw/2:ih/2:iw/4:ih/4",
    "bottom_third": "crop=iw:ih/3:0:ih-ih/3",
    "bottom_half": "crop=iw:ih/2:0:ih/2",
}


def ssim(f1, f2, region=None, crop=None):
    """FFmpeg's SSIM 'All' of two frames (files from Frames.get), over a named region (REGIONS) or an FFmpeg crop."""
    crop = crop or REGIONS[region]
    p = run([FFMPEG, "-nostdin", "-hide_banner", "-nostats", "-i", f1, "-i", f2, "-lavfi",
             f"[0:v]{crop}[x];[1:v]{crop}[y];[x][y]ssim", "-f", "null", "-"])
    m = re.findall(r"All:\s*([0-9.]+)", p.stderr)
    if not m:
        raise Unmeasurable(f"ssim failed: {p.stderr.strip()[-300:]}")
    return float(m[-1])


def frame_ssim(frames, path, t, ref, ref_t, region=None, crop=None):
    """SSIM of path's frame at t (scaled to ref's size) against ref's frame at ref_t."""
    vs = video_stream(ref)
    if vs is None:
        raise Unmeasurable(f"{os.path.basename(ref)} has no video stream")
    sz = (int(vs["width"]), int(vs["height"]))
    return ssim(frames.get(path, t, sz), frames.get(ref, ref_t), region, crop)


def signalstats(frame):
    """FFmpeg signalstats of one frame file (YAVG, SATAVG, ... on 8-bit values)."""
    p = run([FFMPEG, "-nostdin", "-hide_banner", "-v", "error", "-i", frame, "-vf",
             "signalstats,metadata=print:file=-", "-f", "null", "-"])
    vals = dict(re.findall(r"lavfi\.signalstats\.(\w+)=([-0-9.]+)", p.stdout))
    if "YAVG" not in vals:
        raise Unmeasurable(f"signalstats failed: {p.stderr.strip()[-300:]}")
    return {k: float(v) for k, v in vals.items()}


def last_frame_stats(path):
    """signalstats of the LAST decoded video frame (every frame goes through the filter, before any output frame-rate
    change): (stats, frame index, pts_time, frames decoded)."""
    if video_stream(path) is None:
        raise Unmeasurable(f"{os.path.basename(path)} has no video stream")
    p = run([FFMPEG, "-nostdin", "-hide_banner", "-v", "error", "-i", path, "-map", "0:v:0", "-vf",
             "format=yuv420p,signalstats,metadata=print:file=-", "-f", "null", "-"])
    blocks = re.split(r"^frame:", p.stdout, flags=re.M)[1:]
    if not blocks:
        raise Unmeasurable(f"no decoded frames: {p.stderr.strip()[-300:]}")
    last = blocks[-1]
    head = re.match(r"\s*(\d+)\s+pts:\s*(-?\d+|NOPTS)\s+pts_time:\s*(\S+)", last)
    vals = {k: float(v) for k, v in re.findall(r"lavfi\.signalstats\.(\w+)=([-0-9.]+)", last)}
    if "YAVG" not in vals:
        raise Unmeasurable("signalstats failed on the last frame")
    return vals, (int(head.group(1)) if head else None), (head.group(3) if head else None), len(blocks)


# ---------------------------------------------------------------- audio
def mean_volume(path, af_prefix="", start=None, end=None):
    """volumedetect mean_volume in dB of the first audio stream (optionally of [start, end) s, after af_prefix);
    None = no samples; -inf = digital silence."""
    if audio_stream(path) is None:
        raise Unmeasurable("no audio stream")
    trim = ""
    if start is not None or end is not None:
        parts = []
        if start is not None:
            parts.append(f"start={start}")
        if end is not None:
            parts.append(f"end={end}")
        trim = "atrim=" + ":".join(parts) + ","
    af = f"{af_prefix}{trim}volumedetect"
    p = run([FFMPEG, "-nostdin", "-hide_banner", "-nostats", "-i", path, "-map", "0:a:0", "-af", af, "-f", "null",
             "-"])
    m = re.findall(r"mean_volume:\s*(-?[0-9.]+|-inf) dB", p.stderr)
    if p.returncode != 0:
        raise Unmeasurable(f"audio decode failed: {p.stderr.strip()[-300:]}")
    if not m:
        return None
    return -math.inf if m[-1] == "-inf" else float(m[-1])


def band_prefix(freq):
    """The band filter: BAND_STAGES cascaded bandpass filters at freq Hz, Q = BAND_Q."""
    return "".join(f"bandpass=f={freq}:width_type=q:width={BAND_Q}," for _ in range(BAND_STAGES))


def band_level(path, freq, start=None, end=None):
    """Mean volume (dB) of the freq Hz band of the first audio stream, whole or [start, end) s; None = no samples."""
    return mean_volume(path, band_prefix(freq), start, end)


def tail_level(path, tail):
    """Mean volume (dB) of the last `tail` s of the audio stream itself (its decoded samples reversed and trimmed), not
    the container's last seconds."""
    return mean_volume(path, f"areverse,atrim=end={tail},", None, None)


def loudness(path):
    """EBU R128 integrated loudness (LUFS) of the first audio stream; -inf when it cannot be measured."""
    if audio_stream(path) is None:
        raise Unmeasurable("no audio stream")
    p = run([FFMPEG, "-nostdin", "-hide_banner", "-nostats", "-i", path, "-map", "0:a:0", "-af",
             "ebur128=peak=none:framelog=verbose", "-f", "null", "-"])
    m = re.findall(r"I:\s*(-?[0-9.]+|-inf|nan) LUFS", p.stderr)
    if not m:
        raise Unmeasurable(f"ebur128 failed: {p.stderr.strip()[-300:]}")
    try:
        return float(m[-1])
    except ValueError:
        return -math.inf


def silences(path, noise_db, min_len):
    """silencedetect spans [[start, end], ...] (s) of the first audio stream at noise_db dB lasting >= min_len s; a
    silence still open at the end closes at the container duration."""
    if audio_stream(path) is None:
        raise Unmeasurable("no audio stream")
    p = run([FFMPEG, "-nostdin", "-hide_banner", "-nostats", "-i", path, "-map", "0:a:0", "-af",
             f"silencedetect=noise={noise_db}dB:d={min_len}", "-f", "null", "-"])
    if p.returncode != 0:
        raise Unmeasurable(f"silencedetect failed: {p.stderr.strip()[-300:]}")
    events = re.findall(r"silence_(start|end):\s*(-?[0-9.]+)", p.stderr)
    spans, cur = [], None
    for kind, v in events:
        if kind == "start":
            cur = float(v)
        elif cur is not None:
            spans.append([round(cur, 3), round(float(v), 3)])
            cur = None
    if cur is not None:
        spans.append([round(cur, 3), round(duration(path), 3)])
    return spans


# ---------------------------------------------------------------- sidecar files
SRT_TIME = r"(\d{1,2}):([0-5]\d):([0-5]\d),(\d{3})"
SRT_TIMING = re.compile(rf"^{SRT_TIME}\s+-->\s+{SRT_TIME}(\s+.*)?$")


def parse_srt(path):
    """Strict SubRip parse: index line, 'HH:MM:SS,mmm --> HH:MM:SS,mmm' (end > start), one or more text lines.
    Returns (cues [(start s, end s, text)], problems [str])."""
    raw = open(path, "rb").read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise Unmeasurable("captions file is not UTF-8")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    blocks = [b for b in re.split(r"\n[ \t]*\n+", text.strip("\n")) if b.strip()]
    cues, problems = [], []
    for i, b in enumerate(blocks, 1):
        lines = [ln.rstrip() for ln in b.split("\n")]
        if len(lines) < 3 and not (len(lines) == 2 and SRT_TIMING.match(lines[1].strip())):
            problems.append(f"block {i}: needs index, timing and text")
            continue
        if not lines[0].strip().isdigit():
            problems.append(f"block {i}: index line {lines[0][:40]!r} is not a number")
            continue
        m = SRT_TIMING.match(lines[1].strip())
        if not m:
            problems.append(f"block {i}: bad timing line {lines[1][:60]!r}")
            continue
        g = [int(x) for x in m.groups()[:8]]
        t0 = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000
        t1 = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000
        if t1 <= t0:
            problems.append(f"block {i}: end {t1} <= start {t0}")
            continue
        body = "\n".join(lines[2:]).strip()
        if not body:
            problems.append(f"block {i}: no text")
            continue
        cues.append((t0, t1, body))
    return cues, problems


def parse_otio(path):
    """An OpenTimelineIO JSON file: {root_schema, clips [names], problems [str]}. Clips are counted inside
    Timeline.tracks (Stack / Track children, any depth up to 50). problems is empty for a well-formed timeline."""
    out = {"root_schema": None, "clips": [], "problems": []}
    try:
        doc = json.load(open(path, encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        out["problems"].append(f"not JSON: {e}")
        return out
    schema = doc.get("OTIO_SCHEMA") if isinstance(doc, dict) else None
    out["root_schema"] = schema
    if not (isinstance(schema, str) and re.fullmatch(r"Timeline\.\d+", schema)):
        out["problems"].append("root OTIO_SCHEMA is not Timeline.N")
        return out
    tracks = doc.get("tracks")
    if not (isinstance(tracks, dict) and re.fullmatch(r"Stack\.\d+", str(tracks.get("OTIO_SCHEMA")))
            and isinstance(tracks.get("children"), list)):
        out["problems"].append("Timeline.tracks is not a Stack with a children list")
        return out

    def walk(o, depth):
        if depth > 50 or not isinstance(o, dict):
            return
        sch = str(o.get("OTIO_SCHEMA", ""))
        if re.fullmatch(r"Clip\.\d+", sch):
            out["clips"].append(o.get("name"))
        elif re.fullmatch(r"(Track|Stack)\.\d+", sch):
            ch = o.get("children")
            if not isinstance(ch, list):
                out["problems"].append(f"{sch} without children list")
                return
            for x in ch:
                walk(x, depth + 1)

    walk(tracks, 0)
    return out


# ---------------------------------------------------------------- side effects (no media)
class Canary:
    """A TCP listener on 127.0.0.1 (a free port) that must receive nothing. A URL that names it in a hostile input shows
    whether the editor, or anything it starts (FFmpeg, a browser), ever connects: every accepted connection is counted,
    whatever its protocol, with the first bytes it sent. An HTTP client gets a 404 and the connection is closed."""

    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(16)
        self.port = self.sock.getsockname()[1]
        self.hits = []
        self._lock = threading.Lock()
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            try:
                conn.settimeout(1.0)
                try:
                    first = conn.recv(256)
                except OSError:
                    first = b""
                with self._lock:
                    self.hits.append(first.split(b"\r\n", 1)[0].decode("latin-1")[:200] or "(connected, sent nothing)")
                try:
                    conn.sendall(b"HTTP/1.0 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                except OSError:
                    pass
            finally:
                conn.close()

    def url(self, name):
        """An http URL on the listener."""
        return f"http://127.0.0.1:{self.port}/{name}"

    def count(self):
        with self._lock:
            return len(self.hits)

    def seen(self):
        with self._lock:
            return list(self.hits)

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def media_streams(target):
    """The codec types (["video", "audio", ...]) FFmpeg's ffprobe reads from `target`: a file, or a data: URI. Only the
    file and data protocols are allowed, so nothing is fetched. Unmeasurable when ffprobe reads nothing."""
    p = run([FFPROBE, "-v", "error", "-protocol_whitelist", "file,data", "-show_streams", "-of", "json", target],
            heavy=False, timeout=60)
    try:
        info = json.loads(p.stdout or "{}")
    except json.JSONDecodeError:
        info = {}
    if not info.get("streams"):
        raise Unmeasurable(f"ffprobe reads no stream: {p.stderr.strip()[:300]}")
    return [s.get("codec_type") for s in info["streams"]]


def strace_form(text):
    """`text` as strace prints it inside a quoted string: printable ASCII as is (with \\ and \" escaped), every other
    byte as a three-digit octal escape. A non-ASCII look-alike of a host name is found in a trace only in this form."""
    out = []
    for b in text.encode("utf-8"):
        if b == 0x5C:
            out.append("\\\\")
        elif b == 0x22:
            out.append('\\"')
        elif 0x20 <= b < 0x7F:
            out.append(chr(b))
        else:
            out.append("\\%03o" % b)
    return "".join(out)


NET_SYSCALL = re.compile(r"^\d+\s+(<\.\.\. )?(connect|sendto|sendmsg|sendmmsg|io_uring_setup)[ (]")

# The forms of an strace line (after strace_skeleton): "<pid> name(...) = result", "<pid> name(... <unfinished ...>",
# "<pid> <... name resumed>...) = result", "<pid> +++ ... +++" and "<pid> --- ... ---". A system call's name is any
# lower-case word, not a list: %file gives names that differ between kernels and architectures (statx, openat2,
# faccessat2, newfstatat), and a line of another call can never hide a network call.
_LINE_FORM = re.compile(r"^\d+ +(?:[a-z_][a-z0-9_]*\(.*(?:\) += .+|<>)|<\.\.\.>.*= .+|\+\+\+ .* \+\+\+|--- .* ---)$")
_CALL_START = re.compile(r"(?<![\w.])\d+ +(?:<\.\.\.>|[a-z_][a-z0-9_]*\()")


def strace_skeleton(ln):
    """`ln` with every quoted string left as "" and every <...> (a -yy decoration, which can hold another one, as in
    "</dev/null<char 1:3>>", or "<unfinished ...>") left as <>, and "<... name resumed>" left as <...>, or None when
    one does not close.
    strace escapes '"' and '\\' inside both, and '<' and '>' inside a path; a socket's decoration holds "->"."""
    out, i, n = [], 0, len(ln)
    while i < n:
        c = ln[i]
        if c == '"':
            j = i + 1
            while j < n and ln[j] != '"':
                j += 2 if ln[j] == "\\" else 1
            if j >= n:
                return None
            out.append('""')
            i = j + 1
        elif c == "<":
            j, depth = i + 1, 1
            while j < n:
                if ln[j] == "<":
                    depth += 1
                elif ln[j] == ">" and ln[j - 1] != "-":
                    depth -= 1
                    if not depth:
                        break
                elif ln[j] == '"':
                    j += 1
                    while j < n and ln[j] != '"':
                        j += 2 if ln[j] == "\\" else 1
                j += 2 if j < n and ln[j] == "\\" else 1
            if j >= n:
                return None
            out.append("<...>" if ln.startswith("<... ", i) else "<>")
            i = j + 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def strace_line_problem(ln):
    """None when `ln` has the form of one line strace writes with -f (its pid first, see _LINE_FORM), else why not. A
    line that is cut short, holds a quote or a decoration that does not close, or holds the start of a second call
    ("<pid> name(" outside quoted strings and decorations) is not one: text added to the trace in front of strace's
    own line, or into the middle of it, shows here, so such text cannot hide a call. The check cannot catch every
    such text (a writer that can cut one of strace's lines in two at the right place could make two lines of this
    form); what keeps other text out of the trace is that no process of the adapter's tree can reach it (run.py's
    TraceTail)."""
    skel = strace_skeleton(ln)
    if skel is None:
        return "a quoted string or a <...> does not close"
    if not _LINE_FORM.match(skel):
        return "not the form of an strace line"
    if _CALL_START.search(skel, 1):
        return "a second call starts inside it"
    return None


def _log_lines(src):
    """The lines of an strace log: `src` is a path, a list of lines, or an object with a lines() method (run.py's
    TraceTail, which holds every line it read while the editor ran). Unmeasurable when there is no log."""
    if hasattr(src, "lines"):
        return src.lines()
    if isinstance(src, list):
        return [ln.rstrip("\n") for ln in src]
    if not src or not os.path.isfile(src):
        raise Unmeasurable("no trace log")
    with open(src, "r", encoding="latin-1") as f:
        return [ln.rstrip("\n") for ln in f]


def trace_lines(src):
    """The file-system lines of an `strace -o` log (a path, a list of lines or a TraceTail: _log_lines): without
    execve / execveat lines (what a process was started with, its argv, is not observed, only what it opened, read,
    listed or wrote) and without the network calls (net_hits reads those; a send's data is not a file name)."""
    return [ln for ln in _log_lines(src)
            if not re.match(r"^\d+\s+(<\.\.\. )?execve(at)?[ (]", ln) and not NET_SYSCALL.match(ln)]


def trace_hits(src, needles, start=0):
    """Trace lines (from index `start` of trace_lines) that name any of `needles`, matched as strace prints them
    (strace_form) and without regard to ASCII case."""
    forms = [strace_form(n).lower() for n in needles]
    lines = trace_lines(src)[start:]
    return [ln for ln in lines if any(f in ln.lower() for f in forms)]


_V4 = re.compile(r'sa_family=AF_INET, sin_port=htons\((\d+)\), sin_addr=inet_addr\("([^"]*)"\)')
_V6 = re.compile(r'sa_family=AF_INET6, sin6_port=htons\((\d+)\),.*?inet_pton\(AF_INET6, "([^"]*)"')
_CALL = re.compile(r"^\d+\s+(connect|sendto|sendmsg|sendmmsg)\((\d+)(?:<([^:>]+):\[(.*?)\]>)?")
_URING = re.compile(r"^\d+\s+(<\.\.\. )?io_uring_setup\b")
_RESULT = re.compile(r"\) = (-?\d+|\?)")  # a call's result: a number (-yy adds "<anon_inode:[io_uring]>") or ?
_DATA = re.compile(r'(?<!inet_addr\()(?<!AF_INET6, )"(?:[^"\\]|\\.)*"')  # quoted data, not an address
# UDP connects that send no packet and are allowed: Chromium's IPv6 reachability probe (the only UDP connect to another
# computer in v0.2.0's runs, with and without a network). Each entry is an exact (address, port).
UDP_PROBES = {("2001:4860:4860::8888", "443")}


def _own(addr):
    """Whether an IP address is this computer's own: loopback, unspecified, or an IPv4-mapped one of those."""
    try:
        ip = ipaddress.ip_address(addr.strip("[]"))
    except ValueError:
        return False
    ip = getattr(ip, "ipv4_mapped", None) or ip
    return ip.is_loopback or ip.is_unspecified


def net_hits(src, start=0):
    """Lines of an strace log (`-yy`, traced with connect, sendto, sendmsg, sendmmsg and io_uring_setup; a path, a
    list of lines or a TraceTail, see _log_lines) in which a process addressed another computer, or could have without
    a traced call:
    - a connect (TCP, UDP, or on a socket strace could not name) to an address that is not this computer's own. The
      one exception is a UDP connect to an exact entry of UDP_PROBES (Chromium's IPv6 reachability probe, which sends
      no packet). Any other UDP connect counts, because write() on a connected UDP socket sends without a traced call.
      The exception is exactly that wide: the connect to [2001:4860:4860::8888]:443 is allowed, and data a process
      then sends on that socket with write() is not seen (write is not traced). Running the editor as another user
      does not change this; a run with the network switched off does;
    - any connect to port 53 (a DNS lookup, also to this computer's own resolver, and also when it fails);
    - a send whose destination (its own address, else the far end of the connected socket) is another computer or
      port 53;
    - an io_uring_setup that made a ring: io_uring connect and send operations are not system calls strace sees.
      run.py makes strace refuse every io_uring_setup (ENOSYS, which Node's libuv and others take as "no io_uring";
      Node 24 asks for a ring at every start), so a ring that was made means the refusal did not apply. A refused
      setup ("= -1 ... (INJECTED)") and the "<unfinished ...>" half of a call (no result) do not count; a result of
      "?" (the process ended in the call) counts.
    Unix sockets and netlink are not network. Quoted data is never read as an address. A download needs one of these
    calls, so a log without such a line shows that nothing was fetched, also when the network is down and the call
    failed. Unmeasurable when there is no log."""
    hits = []
    for i, ln in enumerate(_log_lines(src)):
        if i < start:
            continue
        if _URING.match(ln):
            r = _RESULT.findall(ln)
            if r and not r[-1].startswith("-"):
                hits.append(ln[:300])  # a ring was made: the refusal (run.py's inject) did not apply
            continue
        m = _CALL.match(ln)
        if not m:
            continue  # another call, or the "<... resumed>" half of one (its arguments are on the first half)
        call, proto, info = m.group(1), (m.group(3) or "").upper(), m.group(4) or ""
        if proto.startswith(("UNIX", "NETLINK")):
            continue
        bare = _DATA.sub('""', ln)
        dests = [(port, addr) for port, addr in _V4.findall(bare) + _V6.findall(bare)]
        if call != "connect" and not dests and "->" in info:
            host, _, port = info.split("->", 1)[1].rpartition(":")
            dests = [(port, host)]
        if call == "connect" and proto.startswith("UDP"):
            bad = any(port == "53" or not (_own(addr) or (addr.strip("[]"), port) in UDP_PROBES)
                      for port, addr in dests)
        else:
            bad = any(port == "53" or not _own(addr) for port, addr in dests)
        if bad:
            hits.append(ln[:300])
    return hits


def substitute(src, out, pairs):
    """Writes a copy of `src` to `out` with each (old, new) of `pairs` applied, and returns how many replacements each
    made. In a JSON file every string value that holds `old` gets it replaced, and every number equal to a numeric
    `old` becomes `new` (keys are kept); any other file is replaced as UTF-8 text. A test crafts a hostile input this
    way from a file the editor itself wrote, without knowing its layout; a pair that made no replacement means the
    file does not hold that value, and the test records that as a failed check."""
    raw = open(src, "rb").read()
    counts = [0] * len(pairs)
    try:
        doc = json.loads(raw.decode("utf-8"))
        is_json = True
    except (UnicodeDecodeError, json.JSONDecodeError):
        is_json = False

    def num(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool)

    def walk(v):
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        if isinstance(v, list):
            return [walk(x) for x in v]
        for i, (old, new) in enumerate(pairs):
            if isinstance(v, str) and isinstance(old, str) and old and old in v:
                counts[i] += v.count(old)
                v = v.replace(old, new)
            elif num(v) and num(old) and v == old:
                counts[i] += 1
                v = new
        return v

    if is_json:
        data = json.dumps(walk(doc), ensure_ascii=False).encode("utf-8")
    else:
        text = raw.decode("utf-8", "replace")
        for i, (old, new) in enumerate(pairs):
            counts[i] = text.count(str(old))
            text = text.replace(str(old), str(new))
        data = text.encode("utf-8")
    with open(out, "wb") as f:
        f.write(data)
    # The editor treats the file as the user's own document and may save into it (v0.2.0 saves the open project before
    # it opens another). With run.py --as-user the editor is another user: the file is writable by others, as it is
    # writable by the editor when it runs as the judge's user. (The test's folder is sticky there, so the editor can
    # change the file but not replace or remove it.)
    os.chmod(out, 0o666)
    return counts


class Crafted:
    """A hostile input made by craft(): `path` (the file written), `counts` (replacements per pair), `applicable`
    (whether every needed value was found) and `why` (the reason when it was not)."""

    def __init__(self, path, counts, applicable, why):
        self.path, self.counts, self.applicable, self.why = path, counts, applicable, why

    def __repr__(self):
        return f"Crafted({os.path.basename(self.path)}, {self.counts}, applicable={self.applicable})"


def craft(src, out, pairs, what, need=None):
    """substitute(src, out, pairs) for a hostile input, and whether it could be made. `what` names the values in words
    ("the media path as given"); `need(counts)` says whether the counts make the input (default: every pair replaced at
    least once). When they do not, the file the editor saved does not hold the values as the judge gave them (another
    file format, for example): the checks on this input are then not applicable (T.check(..., needs=crafted)), not
    failed, and they are listed by name. The file at `out` is written either way."""
    counts = substitute(src, out, pairs)
    ok = bool(need(counts)) if need else all(c > 0 for c in counts)
    why = "" if ok else (f"the file the editor saved does not hold {what} (replacements {counts}), so this hostile "
                         f"input cannot be made by substitution")
    return Crafted(out, counts, ok, why)


def named(root, marker):
    """Paths under `root` (files, folders and links; links are not followed) whose name holds `marker`."""
    found = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        for n in dirnames + filenames:
            if marker in n:
                found.append(os.path.join(dirpath, n))
    return found


def file_sizes(root):
    """{path: size} of every file under `root` (links are not followed, and not listed)."""
    out = {}
    for dirpath, _, filenames in os.walk(root, followlinks=False):
        for n in filenames:
            p = os.path.join(dirpath, n)
            try:
                st = os.lstat(p)
            except OSError:
                continue
            if not os.path.islink(p):
                out[p] = st.st_size
    return out


def holds_secret(text, secret, n=8):
    """Whether `text` holds any `n` consecutive characters of `secret`."""
    if not secret or not text:
        return False
    return any(secret[i:i + n] in text for i in range(0, max(1, len(secret) - n + 1)))
