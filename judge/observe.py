"""Measurements on exported files: what the judge observes, never the editor's internals.

Python 3 standard library only. Each function reads a file with FFmpeg / ffprobe and returns numbers; the tests compare
them with their own expectations. The filter chains are the ones the first-try baseline's checker used (check.py 3
rev 4), so a value measured here and a baseline value measured there are the same measurement.

mean_rgb reads the mean colour of a picture (a test lets a graphic's code pick the colour it draws, to see that it
ran); pixels and block_rgb read raw pixels and a block's mean colour of a video's frame (the effects' looks);
hex_colour reads a colour that get_state reports in a hex spelling (no file).

The last part ("Side effects") holds the judge's own observations of what the editor does around it: a loopback listener
that must receive nothing (on 127.0.0.1, or on another address of this computer such as 127.0.0.2), the host-level trace
(strace) of the adapter's process tree (its file-system calls, and the network calls that show a download), files that
must not appear, secrets that must not appear in any answer, and the text substitution that makes a hostile input from a
file the editor itself wrote (craft: when the file does not hold the value as given, the input cannot be made and the
checks on it are not applicable).

FFmpeg: JUDGE_FFMPEG / JUDGE_FFPROBE, else the ffmpeg / ffprobe on PATH. Heavy commands run under `nice -n 19` (when
`nice` exists) with a timeout.

A measurement that the file makes impossible (missing file, no video stream, no frame at t) raises Unmeasurable; the
test then fails that check with the reason. So does a file outside the folders the judge measures in, or one in a format
that names other files or URLs (see "What a measurement may read").
"""
import hashlib
import ipaddress
import json
import math
import os
import re
import shutil
import socket
import stat
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


def run(cmd, timeout=TIMEOUT, heavy=True, fds=(), text=True):
    full = (NICE + cmd) if heavy else cmd
    try:
        return subprocess.run(full, capture_output=True, text=text, errors="replace" if text else None,
                              timeout=timeout, stdin=subprocess.DEVNULL, check=False, pass_fds=tuple(fds))
    except subprocess.TimeoutExpired as e:
        raise Unmeasurable(f"timed out after {timeout}s: {' '.join(cmd[:6])} ...") from e


# ---------------------------------------------------------------- what a measurement may read
# The files a measurement reads were written by the editor, or named by it (an asset's path in the State), and the
# measurement runs as the judge's user, who can read files that the editor's user cannot (run.py --as-user). So every
# file a measurement reads goes through source(): it must be a regular file in a folder the judge allowed (confine:
# run.py's T allows the test's scratch folder and the media folder), and it is opened once, by this process; FFmpeg
# and ffprobe get that open file (/dev/fd/N), with only the file protocol and only demuxers that read nothing but
# their own input. A file the editor swaps for a link after the check is not read, and a file that names other files
# or URLs (an HLS or DASH playlist, a concat list, an image sequence) is not followed, whatever its name says.
MEDIA = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,mp3,png_pipe"  # renders, exports, the media, a rendered frame
PICTURE = "png_pipe,nut"  # a rendered frame (PNG) or a frame Frames extracted (rawvideo in NUT)
_ROOTS = []
TEXT_LIMIT = 8 << 20  # the most bytes source.read() reads: captions, OTIO and project files are far smaller


def confine(*roots):
    """From now on, measurements read only regular files under `roots` (folders; links in them are resolved, so a link
    to a file elsewhere is refused). Without a call (check_observe.py) every regular file may be read."""
    _ROOTS[:] = [os.path.realpath(r) for r in roots if r]


def _allow(root):
    if _ROOTS:
        _ROOTS.append(os.path.realpath(root))


def _under(path, root):
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


class source:
    """`with source(path) as fd:` the file at `path`, opened for reading by this process: a regular file under the
    folders confine() allowed, checked on the open file itself (its place as /proc/self/fd names it), so a link
    swapped in after the check is not followed. Unmeasurable otherwise. `fd.words(formats)` are FFmpeg's input
    words for it: only the file protocol and the demuxers `formats` (a comma list), then -i /dev/fd/N."""

    def __init__(self, path):
        self.path, self.fd = path, None

    def _refuse(self, why):
        raise Unmeasurable(f"{os.path.basename(self.path)} {why}")

    def __enter__(self):
        if not isinstance(self.path, str) or not self.path:
            raise Unmeasurable(f"no file named ({self.path!r})")
        real = os.path.realpath(self.path)
        if _ROOTS and not any(_under(real, r) for r in _ROOTS):
            self._refuse(f"is not in a folder the judge may measure in (it is {real})")
        try:
            self.fd = os.open(real, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0))
        except FileNotFoundError:
            raise Unmeasurable(f"missing file {os.path.basename(self.path)}") from None
        except OSError as e:
            self._refuse(f"cannot be opened: {e.strerror}")
        try:
            if not stat.S_ISREG(os.fstat(self.fd).st_mode):
                self._refuse("is not a regular file")
            try:
                where = os.readlink(f"/proc/self/fd/{self.fd}")
            except OSError:
                where = real
            if _ROOTS and not any(_under(where, r) for r in _ROOTS):
                self._refuse(f"is not in a folder the judge may measure in (it is {where})")
        except BaseException:
            os.close(self.fd)
            raise
        return self

    def __exit__(self, *exc):
        os.close(self.fd)

    def stat(self):
        return os.fstat(self.fd)

    def words(self, formats=MEDIA):
        return ["-protocol_whitelist", "file", "-format_whitelist", formats, "-i", f"/dev/fd/{self.fd}"]

    def chunks(self, size=1 << 20):
        """The file's bytes from its start, `size` bytes at a time (the last piece may be shorter)."""
        os.lseek(self.fd, 0, os.SEEK_SET)
        while True:
            b = os.read(self.fd, size)
            if not b:
                return
            yield b

    def read(self, limit=TEXT_LIMIT):
        """The file's bytes. A file that holds more than `limit` bytes (counted as they are read, so a file the editor
        makes longer meanwhile counts too) is Unmeasurable as too large to read: the editor writes these files, and
        one of any size must not exhaust the judge's memory."""
        chunks, n = [], 0
        for b in self.chunks():
            n += len(b)
            if n > limit:
                self._refuse(f"is too large to read (more than {limit} bytes)")
            chunks.append(b)
        return b"".join(chunks)


def ffmpeg_version():
    """First line of `ffmpeg -version` of the FFmpeg the measurements use."""
    p = run([FFMPEG, "-hide_banner", "-version"], heavy=False, timeout=30)
    return (p.stdout.splitlines() or ["?"])[0]


def sha256(path):
    """The sha256 of the file at `path`, read through source() 1 MiB at a time (a file of any size)."""
    h = hashlib.sha256()
    with source(path) as src:
        for b in src.chunks():
            h.update(b)
    return h.hexdigest()


# ---------------------------------------------------------------- probing
_probe_cache = {}


def probe(path):
    """ffprobe -show_format -show_streams as a dict (cached per path and the file's identity and modification
    time). The file is read through source() with the MEDIA demuxers."""
    with source(path) as src:
        st = src.stat()
        key = (path, st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)
        if key in _probe_cache:
            return _probe_cache[key]
        p = run([FFPROBE, "-v", "error", "-show_format", "-show_streams", "-of", "json"] + src.words(), heavy=False,
                fds=[src.fd])
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
    with source(path) as src:
        p = run([FFMPEG, "-nostdin", "-hide_banner", "-nostats", "-v", "error", "-progress", "pipe:1"] + src.words()
                + ["-f", "null", "-"], fds=[src.fd])
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
        if not tmp:
            tmp = tempfile.mkdtemp(prefix="judge-frames-")
            _allow(tmp)  # this process's own folder (mode 0700): its frames may be measured
        self.tmp = tmp
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
        with source(path) as src:
            p = run([FFMPEG, "-nostdin", "-hide_banner", "-v", "error", "-y", "-ss", f"{float(t):.3f}"] + src.words()
                    + ["-map", "0:v:0", "-frames:v", "1", "-vf", vf, "-c:v", "rawvideo", "-f", "nut", out],
                    fds=[src.fd])
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
    with source(f1) as s1, source(f2) as s2:
        p = run([FFMPEG, "-nostdin", "-hide_banner", "-nostats"] + s1.words(PICTURE) + s2.words(PICTURE)
                + ["-lavfi", f"[0:v]{crop}[x];[1:v]{crop}[y];[x][y]ssim", "-f", "null", "-"], fds=[s1.fd, s2.fd])
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
    with source(frame) as src:
        p = run([FFMPEG, "-nostdin", "-hide_banner", "-v", "error"] + src.words(PICTURE)
                + ["-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"], fds=[src.fd])
    vals = dict(re.findall(r"lavfi\.signalstats\.(\w+)=([-0-9.]+)", p.stdout))
    if "YAVG" not in vals:
        raise Unmeasurable(f"signalstats failed: {p.stderr.strip()[-300:]}")
    return {k: float(v) for k, v in vals.items()}


def last_frame_stats(path):
    """signalstats of the LAST decoded video frame (every frame goes through the filter, before any output frame-rate
    change): (stats, frame index, pts_time, frames decoded)."""
    if video_stream(path) is None:
        raise Unmeasurable(f"{os.path.basename(path)} has no video stream")
    with source(path) as src:
        p = run([FFMPEG, "-nostdin", "-hide_banner", "-v", "error"] + src.words()
                + ["-map", "0:v:0", "-vf", "format=yuv420p,signalstats,metadata=print:file=-", "-f", "null", "-"],
                fds=[src.fd])
    blocks = re.split(r"^frame:", p.stdout, flags=re.M)[1:]
    if not blocks:
        raise Unmeasurable(f"no decoded frames: {p.stderr.strip()[-300:]}")
    last = blocks[-1]
    head = re.match(r"\s*(\d+)\s+pts:\s*(-?\d+|NOPTS)\s+pts_time:\s*(\S+)", last)
    vals = {k: float(v) for k, v in re.findall(r"lavfi\.signalstats\.(\w+)=([-0-9.]+)", last)}
    if "YAVG" not in vals:
        raise Unmeasurable("signalstats failed on the last frame")
    return vals, (int(head.group(1)) if head else None), (head.group(3) if head else None), len(blocks)


def mean_rgb(path, region="centre"):
    """The mean colour (r, g, b, each 0..255) of a picture (a PNG, as render_frame writes), over a named region
    (REGIONS): the picture scaled down to one pixel (area average) as rgb24. A test that needs to know whether a
    graphic's code ran to its end lets the code pick the colour it draws."""
    if video_stream(path) is None:
        raise Unmeasurable(f"{os.path.basename(path)} has no picture")
    with source(path) as src:
        p = run([FFMPEG, "-nostdin", "-hide_banner", "-v", "error"] + src.words(PICTURE)
                + ["-frames:v", "1", "-vf", f"{REGIONS[region]},scale=1:1:flags=area,format=rgb24", "-f", "rawvideo",
                   "-"], timeout=120, fds=[src.fd], text=False)
    if p.returncode != 0 or len(p.stdout) < 3:
        why = p.stderr.decode("utf-8", "replace")[-300:]
        raise Unmeasurable(f"no colour read from {os.path.basename(path)}: {why}")
    return tuple(p.stdout[:3])


def render_problem(path, root, seconds, fps, judge_paths=()):
    """None when `path` (a file the State names as a render) is a video the editor rendered: a regular file under
    `root` (the test's folder; links resolved) that is none of `judge_paths` (files the test wrote or asked the editor
    to write, and folders of them), in a video container (QuickTime / MP4, or Matroska / WebM: not a picture), whose
    video stream decodes to round(seconds * fps) frames, one either way. Else why not. A render that the State
    reports as the judge's own file (a frame render_frame wrote, say) cannot then stand in for the editor's."""
    if not isinstance(path, str) or not path:
        return f"the State names no file ({path!r})"
    real = os.path.realpath(path)
    if not _under(real, os.path.realpath(root)):
        return f"{path} is not in the test's folder"
    mine = [os.path.realpath(p) for p in judge_paths]
    if any(_under(real, p) for p in mine):
        return f"{path} is the test's own file, not the editor's render"
    try:
        fmt = probe(path)["format"].get("format_name") or ""
        if not set(fmt.split(",")) & {"mov", "matroska"}:
            return f"{os.path.basename(path)} is {fmt or 'no known format'}, not a video container"
        if video_stream(path) is None:
            return f"{os.path.basename(path)} has no video stream"
        frames, want = decode(path)["video_frames"], round(seconds * fps)
    except Unmeasurable as e:
        return str(e)
    if abs(frames - want) > 1:
        return f"{os.path.basename(path)} holds {frames} frames, not {want} ({seconds} s at {fps} fps)"
    return None


def pixels(path, t, chain, fmt="rgb24", frames=1):
    """The raw pixels (bytes) of `frames` frames of the video at `path`, from the first frame at or after `t` s, after
    the FFmpeg filter `chain` (a crop, for example, in the frame's own size), as `fmt` (rgb24: 3 bytes a pixel; gray:
    1). Unmeasurable without a video stream or a frame there."""
    if video_stream(path) is None:
        raise Unmeasurable(f"{os.path.basename(path)} has no video stream")
    with source(path) as src:
        p = run([FFMPEG, "-nostdin", "-hide_banner", "-v", "error", "-ss", f"{float(t):.3f}"] + src.words()
                + ["-map", "0:v:0", "-frames:v", str(int(frames)), "-vf", f"{chain},format={fmt}", "-f", "rawvideo",
                   "-"], timeout=300, fds=[src.fd], text=False)
    if p.returncode != 0 or not p.stdout:
        why = p.stderr.decode("utf-8", "replace")[-300:]
        raise Unmeasurable(f"no frame at {t}s in {os.path.basename(path)} ({why})")
    return p.stdout


def block_rgb(path, t, x, y, size=8):
    """The mean colour (r, g, b, each 0..255) of the `size` x `size` block at (x, y) (its top left corner) of the
    video's frame at `t` s: the block scaled to one pixel (area average) as rgb24, as smoke-registry.ts's sampleBlock."""
    b = pixels(path, t, f"crop={size}:{size}:{x}:{y},scale=1:1:flags=area")
    if len(b) < 3:
        raise Unmeasurable(f"no colour read from {os.path.basename(path)} at {t}s")
    return tuple(b[:3])


def colour_is(rgb, want, tol=40):
    """Whether the colour `rgb` is within `tol` of `want` in each channel."""
    return rgb is not None and all(abs(int(a) - int(b)) <= tol for a, b in zip(rgb, want))


def hex_colour(value):
    """The colour a hex spelling names, as 0xRRGGBB (an int): `0xRRGGBB` or `#rrggbb`, in any case, red first. None
    for anything else (a name, rgb(), a number, another length). A colour that get_state reports is read with this
    and compared with the colour a test gave, whatever spelling each has (PROTOCOL.md, "State")."""
    if not isinstance(value, str):
        return None
    m = re.fullmatch(r"(?:0[xX]|#)([0-9a-fA-F]{6})", value.strip())
    return int(m.group(1), 16) if m else None


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
    with source(path) as src:
        p = run([FFMPEG, "-nostdin", "-hide_banner", "-nostats"] + src.words() + ["-map", "0:a:0", "-af", af, "-f",
                                                                                 "null", "-"], fds=[src.fd])
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
    with source(path) as src:
        p = run([FFMPEG, "-nostdin", "-hide_banner", "-nostats"] + src.words()
                + ["-map", "0:a:0", "-af", "ebur128=peak=none:framelog=verbose", "-f", "null", "-"], fds=[src.fd])
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
    with source(path) as src:
        p = run([FFMPEG, "-nostdin", "-hide_banner", "-nostats"] + src.words()
                + ["-map", "0:a:0", "-af", f"silencedetect=noise={noise_db}dB:d={min_len}", "-f", "null", "-"],
                fds=[src.fd])
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


# ---------------------------------------------------------------- frame-index pictures and the chirp
# The edit tests' media (fixtures/make.sh: idx.mp4, idx2997.mp4, skew.mp4, cutout.mkv) show their own frame index:
# STRIPES vertical stripes of equal width across the picture, stripe b bright (luma 220) when bit b of the source
# frame's index is set and dark (30) when it is not. A frame of an export is read back to the source frame it shows,
# so a test sees which source frame lands on which timeline frame without any model of the editor. A black frame (a
# gap) reads 0, like source frame 0, so the tests place no source frame 0 where a gap must show.
# Their sound is a chirp, sin(2 pi (CHIRP_F0 t + CHIRP_K t^2)): its frequency at source time t is CHIRP_F0 +
# 2 CHIRP_K t Hz (200 Hz at 0 s, 3400 Hz at 16 s), so the pitch heard at a moment of an export says which source moment
# plays there (chirp_time), whatever the speed (the editor keeps the pitch when it changes the tempo) or the direction.
STRIPES = 9
STRIPE_SIZE = (180, 90)
CHIRP_F0 = 200.0
CHIRP_K = 100.0
RATE = 48000


def frame_indexes(path, t=None, frames=None, bits=STRIPES, size=STRIPE_SIZE, row=None):
    """The source frame index each decoded video frame of `path` shows (see above): every frame, or `frames` frames
    from the first at or after `t` s. Each frame is scaled to `size` (nearest neighbour) as grey, and stripe b is read
    at its middle on the middle row, or on `row` (bright: luma over 125). A rendered frame (a PNG) reads as one
    frame."""
    w, h = size
    if video_stream(path) is None:
        raise Unmeasurable(f"{os.path.basename(path)} has no video stream")
    seek = [] if t is None else ["-ss", f"{float(t):.4f}"]
    limit = [] if frames is None else ["-frames:v", str(int(frames))]
    with source(path) as src:
        p = run([FFMPEG, "-nostdin", "-hide_banner", "-v", "error"] + seek + src.words() + ["-map", "0:v:0"] + limit
                + ["-vf", f"scale={w}:{h}:flags=neighbor,format=gray", "-f", "rawvideo", "-"], fds=[src.fd],
                text=False)
    if p.returncode != 0:
        raise Unmeasurable(f"decoding {os.path.basename(path)} failed: "
                           f"{p.stderr.decode('utf-8', 'replace').strip()[-300:]}")
    fs, row = w * h, (h >> 1 if row is None else int(row)) * w
    xs = [int((b + 0.5) * w / bits) for b in range(bits)]
    out = []
    for k in range(len(p.stdout) // fs):
        base = k * fs + row
        out.append(sum(1 << b for b, x in enumerate(xs) if p.stdout[base + x] > 125))
    return out


def grey_frames(path, size=(160, 90)):
    """Every decoded video frame of `path` as grey bytes of `size` (bilinear scale): [bytes]."""
    w, h = size
    if video_stream(path) is None:
        raise Unmeasurable(f"{os.path.basename(path)} has no video stream")
    with source(path) as src:
        p = run([FFMPEG, "-nostdin", "-hide_banner", "-v", "error"] + src.words() + ["-map", "0:v:0", "-vf",
                f"scale={w}:{h},format=gray", "-f", "rawvideo", "-"], fds=[src.fd], text=False)
    if p.returncode != 0:
        raise Unmeasurable(f"decoding {os.path.basename(path)} failed: "
                           f"{p.stderr.decode('utf-8', 'replace').strip()[-300:]}")
    fs = w * h
    return [p.stdout[k * fs:(k + 1) * fs] for k in range(len(p.stdout) // fs)]


def mean_abs_diff(a, b):
    """The mean absolute difference (0..255) of two grey frames of the same size (bytes)."""
    n = min(len(a), len(b))
    return sum(abs(x - y) for x, y in zip(a[:n], b[:n])) / max(1, n)


def samples(path, rate=RATE):
    """The first audio stream of `path` decoded to mono 32-bit float samples at `rate` Hz, from its start (as an
    export's own timeline: sample i plays at i / rate s): array('f')."""
    import array
    import sys
    if audio_stream(path) is None:
        raise Unmeasurable("no audio stream")
    with source(path) as src:
        p = run([FFMPEG, "-nostdin", "-hide_banner", "-v", "error"] + src.words()
                + ["-map", "0:a:0", "-ac", "1", "-ar", str(rate), "-f", "f32le", "-"], fds=[src.fd], text=False)
    if p.returncode != 0:
        raise Unmeasurable(f"audio decode failed: {p.stderr.decode('utf-8', 'replace').strip()[-300:]}")
    a = array.array("f")
    a.frombytes(p.stdout[:len(p.stdout) - len(p.stdout) % 4])
    if sys.byteorder != "little":
        a.byteswap()
    return a


def rms(s, t0, t1, rate=RATE):
    """The root mean square (0..1) of samples `s` over [t0, t1) s; 0.0 where there are none."""
    i0, i1 = max(0, int(round(t0 * rate))), min(len(s), int(round(t1 * rate)))
    if i1 <= i0:
        return 0.0
    return math.sqrt(sum(v * v for v in s[i0:i1]) / (i1 - i0))


def pitch(s, t0, t1, rate=RATE):
    """The frequency (Hz) of samples `s` over [t0, t1) s, from its zero crossings (each one placed between its two
    samples), or None where it is quiet (mean power under 1e-4) or holds fewer than 3 crossings."""
    i0, i1 = max(1, int(round(t0 * rate))), min(len(s), int(round(t1 * rate)))
    xs, e = [], 0.0
    for i in range(i0, i1):
        a, b = s[i - 1], s[i]
        e += b * b
        if (a < 0) != (b < 0):
            xs.append(i - 1 + a / (a - b))
    if i1 <= i0 or e / (i1 - i0) < 1e-4 or len(xs) < 3:
        return None
    return (len(xs) - 1) / 2 / ((xs[-1] - xs[0]) / rate)


def chirp_time(s, t, half=0.012, rate=RATE):
    """The source moment (s) that the chirp heard at `t` s of samples `s` comes from: its pitch over [t - half,
    t + half) mapped back through the chirp's frequency (CHIRP_F0 + 2 CHIRP_K t). None where it is quiet."""
    f = pitch(s, t - half, t + half, rate)
    return None if f is None else (f - CHIRP_F0) / (2 * CHIRP_K)


def chirp_freq(source_t):
    """The chirp's frequency (Hz) at source moment `source_t` s."""
    return CHIRP_F0 + 2 * CHIRP_K * source_t


def media_magic(head):
    """Whether `head` (a file's first bytes) starts like a media file: MP4 / QuickTime (ftyp, moov, mdat, free, wide at
    byte 4), Matroska / WebM, PNG, JPEG, RIFF (WAV, AVI, WebP), Ogg, FLAC, MP3, NUT, MPEG-TS / PS, or an H.264 / HEVC
    stream (a start code)."""
    if head is None:
        return False
    if len(head) >= 8 and head[4:8] in (b"ftyp", b"moov", b"mdat", b"free", b"wide", b"skip"):
        return True
    return head.startswith((b"\x1a\x45\xdf\xa3", b"\x89PNG", b"\xff\xd8\xff", b"RIFF", b"OggS", b"fLaC", b"ID3",
                            b"\xff\xfb", b"\xff\xf3", b"\xff\xf2", b"nut/", b"\x47", b"\x00\x00\x01\xba",
                            b"\x00\x00\x00\x01", b"\x00\x00\x01"))


# ---------------------------------------------------------------- sidecar files
SRT_TIME =r"(\d{1,2}):([0-5]\d):([0-5]\d),(\d{3})"
SRT_TIMING = re.compile(rf"^{SRT_TIME}\s+-->\s+{SRT_TIME}(\s+.*)?$")


def parse_srt(path):
    """Strict SubRip parse: index line, 'HH:MM:SS,mmm --> HH:MM:SS,mmm' (end > start), one or more text lines.
    Returns (cues [(start s, end s, text)], problems [str])."""
    with source(path) as src:
        raw = src.read()
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
        with source(path) as src:
            doc = json.loads(src.read().decode("utf-8"))
    except Unmeasurable as e:
        out["problems"].append(f"not read: {e}")
        return out
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
    whatever its protocol, with the first bytes it sent. An HTTP client gets a 404 and the connection is closed.
    `host` binds another loopback address (Linux answers all of 127.0.0.0/8): 127.0.0.2 is this computer too, but
    not an address a graphic's page may reach (PROTOCOL.md, "Motion graphics").
    With `answer` (bytes) every connection gets `200 OK` with that body as text/plain and no cross-origin permission
    (no Access-Control-Allow-Origin header): a page of another origin may send it a request but must not read the
    answer (the browser's same-origin policy)."""

    def __init__(self, host="127.0.0.1", answer=None):
        self.host = host
        self.answer = answer
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.bind((host, 0))
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
                if self.answer is None:
                    reply = b"HTTP/1.0 404 Not Found\r\nContent-Length: 0\r\n\r\n"
                else:
                    reply = (b"HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\n"
                             b"Content-Length: %d\r\n\r\n" % len(self.answer)) + self.answer
                try:
                    conn.sendall(reply)
                except OSError:
                    pass
            finally:
                conn.close()

    def url(self, name, scheme="http"):
        """A URL on the listener (http, or ws for a WebSocket)."""
        return f"{scheme}://{self.host}:{self.port}/{name}"

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
_CALL_START = re.compile(r"(?<![\w.])\d+ +(?:<\.\.\.>|[a-z_][a-z0-9_]*\(|\?\?\?\??\()")


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


# The one line strace writes for a call whose tracee had gone when strace stopped it at the call's entry: strace could
# not read its registers (they are readable as long as the tracee lives), so it has no name, no arguments and no
# result, and the tracee never ran the call. Seen when Chromium's and Electron's threads end together at exit. strace
# 5.16 writes four question marks ("????("), strace 6.x (6.8 on GitHub's Ubuntu 24.04 runner) three ("???("). strace
# 6.8 also writes "<pid> ???() = ?" for such a call: no name, no arguments, no result.
_VANISHED = re.compile(r"^\d+ +\?\?\?\??\((?: <(?:unfinished|detached) \.\.\.>|\) += \?)$")


def strace_line_problem(ln):
    """None when `ln` has the form of one line strace writes with -f (its pid first, see _LINE_FORM), else why not. A
    line that is cut short, holds a quote or a decoration that does not close, or holds the start of a second call
    ("<pid> name(" outside quoted strings and decorations) is not one: text added to the trace in front of strace's
    own line, or into the middle of it, shows here, so such text cannot hide a call. The check cannot catch every
    such text (a writer that can cut one of strace's lines in two at the right place could make two lines of this
    form); what keeps other text out of the trace is that no process of the adapter's tree can reach it (run.py's
    TraceTail). One more form is strace's own: "<pid> ????( <unfinished ...>" (or "<detached ...>"; strace 6.x writes
    "???(" in place of "????("), or "<pid> ???() = ?", exactly, for a call whose tracee was gone at its entry
    (_VANISHED): it never ran, and the line holds nothing that could hide a call; "???" or "????" with anything else
    is not accepted."""
    if _VANISHED.match(ln):
        return None
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
    with source(src) as f:  # the editor's file: a link to a file of the judge's user is not copied
        raw = f.read()
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
