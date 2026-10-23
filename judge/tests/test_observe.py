"""The judge's own instruments (observe.py) on media with known properties, with the FFmpeg this run uses. Starts no
editor. If a measurement is wrong here, every test that uses it is wrong, so this runs first and on every FFmpeg.

Known properties (judge/fixtures/make.sh): a.mp4 and b.mp4 are 6 s, 1280x720, 30 fps, 180 frames, with a 440 Hz
(a) or 660 Hz (b) tone at amplitude 1/8; m.mp3 is 20 s of 330 Hz with no picture; gap.m4a is a 440 Hz tone with
digital silence from 2.0 to 3.5 s, 5.5 s in all.

The side-effect observations (the loopback listener, the strace form of a name and the trace search, the text
substitution, the marker search and the secret search) are checked on inputs made here, and the edit tests' refusal
check (edits.refused_unchanged) on a model of an editor's undo history.
"""
import json
import os
import socket

import driver as drv
import edits
import observe

PORT_BOUND = False
TIMEOUT = 300
CHECKS = 40


def run(t):
    a, b, m, gap = t.media("a.mp4"), t.media("b.mp4"), t.media("m.mp3"), t.media("gap.m4a")
    frames = observe.Frames(t.path("frames", "x"))

    t.measure("duration of a.mp4", lambda: observe.duration(a), lambda v: abs(v - 6.0) < 0.01, "6.0 s")
    t.measure("size of a.mp4", lambda: observe.size(a), lambda v: v == (1280, 720, 1.0), "1280x720, SAR 1")
    t.measure("frame rate of a.mp4", lambda: observe.fps(a), lambda v: abs(v - 30) < 1e-6, "30")
    t.measure("full decode of a.mp4", lambda: observe.decode(a),
              lambda v: v["clean"] and v["video_frames"] == 180, "clean, 180 frames")
    t.measure("audio stream duration of a.mp4", lambda: observe.stream_duration(observe.audio_stream(a)),
              lambda v: v is not None and abs(v - 6.0) < 0.05, "6.0 s")
    t.measure("mean volume of a.mp4", lambda: observe.mean_volume(a), lambda v: -23 < v < -19, "about -21 dB")
    t.measure("440 Hz band of a.mp4", lambda: observe.band_level(a, 440), lambda v: v > -30, "> -30 dB")
    t.measure("660 Hz band of a.mp4", lambda: observe.band_level(a, 660), lambda v: v < -60, "< -60 dB")
    t.measure("660 Hz band of b.mp4", lambda: observe.band_level(b, 660), lambda v: v > -30, "> -30 dB")
    t.measure("440 Hz band of b.mp4, 1-5 s", lambda: observe.band_level(b, 440, 1, 5), lambda v: v < -60, "< -60 dB")
    t.measure("SSIM of a frame with itself", lambda: observe.frame_ssim(frames, a, 2.0, a, 2.0),
              lambda v: v > 0.999, "> 0.999")
    t.measure("SSIM of a.mp4 against b.mp4", lambda: observe.frame_ssim(frames, a, 2.0, b, 2.0),
              lambda v: v < 0.8, "< 0.8")
    t.measure("SSIM of the centre region of a frame with itself",
              lambda: observe.frame_ssim(frames, a, 2.0, a, 2.0, region="centre"), lambda v: v > 0.999, "> 0.999")
    t.measure("signalstats of a frame of a.mp4", lambda: observe.signalstats(frames.get(a, 1.0)),
              lambda v: 10 < v["YAVG"] < 245 and v["SATAVG"] > 5, "YAVG inside 10..245, SATAVG > 5")
    t.measure("last frame of a.mp4", lambda: observe.last_frame_stats(a)[3], lambda v: v == 180, "180 frames seen")
    t.measure("duration of m.mp3", lambda: observe.duration(m), lambda v: abs(v - 20.0) < 0.1, "20.0 s")
    t.check("m.mp3 has no video stream", observe.video_stream(m) is None)
    t.measure("330 Hz band of m.mp3", lambda: observe.band_level(m, 330), lambda v: v > -30, "> -30 dB")
    t.measure("silences in gap.m4a", lambda: observe.silences(gap, -50, 0.5),
              lambda v: len(v) == 1 and abs(v[0][0] - 2.0) < 0.05 and abs(v[0][1] - 3.5) < 0.05, "one, 2.0-3.5 s")
    t.measure("tone in gap.m4a before the gap", lambda: observe.band_level(gap, 440, 0.5, 1.5),
              lambda v: v > -30, "> -30 dB")
    t.measure("nothing in gap.m4a inside the gap", lambda: observe.mean_volume(gap, "", 2.1, 3.4),
              lambda v: v is None or v < -80, "< -80 dB")
    t.measure("last 0.2 s of gap.m4a", lambda: observe.tail_level(gap, 0.2), lambda v: v > -30, "> -30 dB")
    t.measure("loudness of gap.m4a", lambda: observe.loudness(gap), lambda v: -30 < v < -15, "-30 to -15 LUFS")

    srt = t.path("side", "c.srt")
    with open(srt, "w", encoding="utf-8") as f:
        f.write("1\n00:00:00,500 --> 00:00:01,250\nHello there\n\n2\n00:00:02,000 --> 00:00:01,000\nBackwards\n\n"
                "3\n00:00:03,000 --> 00:00:04,000\nTwo\nlines\n")
    cues, problems = observe.parse_srt(srt)
    t.check("SRT: two valid cues, the backwards one flagged",
            [c[:2] for c in cues] == [(0.5, 1.25), (3.0, 4.0)] and len(problems) == 1 and "end" in problems[0],
            {"cues": cues, "problems": problems})

    otio = t.path("side", "t.otio")
    clip = (lambda n: {"OTIO_SCHEMA": "Clip.2", "name": n})
    doc = {"OTIO_SCHEMA": "Timeline.1", "tracks": {"OTIO_SCHEMA": "Stack.1", "children": [
        {"OTIO_SCHEMA": "Track.1", "children": [clip("one"), {"OTIO_SCHEMA": "Gap.1"}, clip("two")]}]}}
    with open(otio, "w", encoding="utf-8") as f:
        json.dump(doc, f)
    o = observe.parse_otio(otio)
    t.check("OTIO: a timeline with two clips", o["root_schema"] == "Timeline.1" and o["clips"] == ["one", "two"]
            and not o["problems"], o)
    with open(otio, "w", encoding="utf-8") as f:
        json.dump({"OTIO_SCHEMA": "Clip.2"}, f)
    t.check("OTIO: a file that is not a timeline is flagged", bool(observe.parse_otio(otio)["problems"]))

    side_effects(t)
    refusal_model(t)


class UndoModel:
    """An editor's undo history in miniature, for edits.refused_unchanged: the State is its markers, set_markers is one
    undo step (a new step drops the redo steps), and its one edit is refused the way `refusal` says: "clean" (nothing
    changes), "empty step" (a step that changes nothing is added to the undo history, the redo steps are kept), "redo
    lost" (the redo steps are dropped), "state" (a marker is added) or "accepted" (no refusal)."""

    def __init__(self, refusal):
        self.refusal, self.markers, self.undos, self.redos = refusal, [(30, "early"), (7, None)], [], []

    def get_state(self):
        return {"markers": [{"frame": f, "name": n} for f, n in sorted(self.markers, key=lambda m: m[0])]}

    def set_markers(self, markers):
        self.undos.append(self.markers)
        self.redos = []
        self.markers = [tuple(m) for m in markers]

    def undo(self):
        if self.undos:
            self.redos.append(self.markers)
            self.markers = self.undos.pop()

    def redo(self):
        if self.redos:
            self.undos.append(self.markers)
            self.markers = self.redos.pop()

    def edit(self):
        if self.refusal == "accepted":
            return {}
        if self.refusal == "empty step":
            self.undos.append(self.markers)
        elif self.refusal == "redo lost":
            self.redos = []
        elif self.refusal == "state":
            self.markers = self.markers + [(99, "x")]
        raise drv.ProductError("refused", op="edit")


def refusal_model(t):
    got = {}
    for kind in ("clean", "empty step", "redo lost", "state", "accepted"):
        m = UndoModel(kind)
        before = m.get_state()
        ok, why = edits.refused_unchanged(m, m.edit)
        got[kind] = (ok, why, m.get_state() == before)
    t.check("the refusal check passes a clean refusal (and leaves the State as before), and fails a refusal that "
            "leaves an empty step in the undo history, one that drops the redo step, one that changes the State and "
            "an edit that is not refused",
            got["clean"][0] and got["clean"][2] and not any(got[k][0] for k in got if k != "clean"), got)


def side_effects(t):
    canary = observe.Canary()
    try:
        c = socket.create_connection(("127.0.0.1", canary.port), timeout=5)
        c.sendall(b"GET /x HTTP/1.0\r\n\r\n")
        c.recv(64)
        c.close()
        t.check("the loopback listener counts a connection and its first line",
                canary.count() == 1 and canary.seen()[0].startswith("GET /x"), canary.seen())
    finally:
        canary.close()
    other = observe.Canary("127.0.0.2")  # another address of this computer (the graphics tests' listener)
    try:
        c = socket.create_connection(("127.0.0.2", other.port), timeout=5)
        c.sendall(b"GET /y HTTP/1.0\r\n\r\n")
        c.recv(64)
        c.close()
        t.check("a listener on 127.0.0.2 counts a connection there, and its URLs name it",
                other.count() == 1 and other.seen()[0].startswith("GET /y")
                and other.url("ws", "ws") == f"ws://127.0.0.2:{other.port}/ws", other.seen())
    finally:
        other.close()
    reader = observe.Canary(answer=b"zr-token-42\n")  # the graphics test's listener whose answer a page must not read
    try:
        c = socket.create_connection(("127.0.0.1", reader.port), timeout=5)
        c.sendall(b"GET /r HTTP/1.1\r\nHost: x\r\nOrigin: http://127.0.0.1:1\r\n\r\n")
        got = b""
        while True:
            part = c.recv(4096)
            if not part:
                break
            got += part
        c.close()
        head, _, body = got.partition(b"\r\n\r\n")
        t.check("a listener with an answer serves it (200, the body) with no cross-origin permission, and counts it",
                head.startswith(b"HTTP/1.0 200 ") and body == b"zr-token-42\n"
                and b"access-control-" not in head.lower() and reader.count() == 1, [got[:200], reader.seen()])
    finally:
        reader.close()
    png = t.path("colour", "magenta.png")
    p = observe.run([observe.FFMPEG, "-nostdin", "-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i",
                     "color=c=0xff00ff:size=64x36,format=rgb24", "-frames:v", "1", png], heavy=False, timeout=60)
    try:
        rgb = observe.mean_rgb(png)
    except observe.Unmeasurable as e:
        rgb = f"unmeasurable: {e} ({p.stderr.strip()[:200]})"
    t.check("colour: a magenta picture reads as magenta, not as green",
            observe.colour_is(rgb, (255, 0, 255)) and not observe.colour_is(rgb, (0, 255, 0))
            and not observe.colour_is(None, (255, 0, 255)), rgb)
    spellings = {s: observe.hex_colour(s) for s in ("0xE02020", "#e02020", "0Xe02020", " #E02020 ", "0x2020E0",
                                                    "e02020", "#e020", "red", "rgb(224,32,32)", 0xE02020)}
    t.check("hex colour: 0xE02020, #e02020 in any case are the same red (red first), 0x2020E0 is blue, and a name, "
            "rgb(), a bare or short hex and a number are not read",
            [spellings[s] for s in ("0xE02020", "#e02020", "0Xe02020", " #E02020 ")] == [0xE02020] * 4
            and spellings["0x2020E0"] == 0x2020E0
            and all(spellings[s] is None for s in ("e02020", "#e020", "red", "rgb(224,32,32)", 0xE02020)),
            spellings)
    t.check("strace form: a non-ASCII byte as three-digit octal, a backslash doubled",
            observe.strace_form("\uff5a-x") == "\\357\\275\\232-x" and observe.strace_form("\\\\nas") == "\\\\\\\\nas",
            [observe.strace_form("\uff5a-x"), observe.strace_form("\\\\nas")])
    log = t.path("side", "trace.log")
    with open(log, "w", encoding="latin-1") as f:
        f.write('10 execve("/usr/bin/ffmpeg", ["ffmpeg", "-i", "//zr-evil-9.invalid/s/a.mp4"], 0x0 /* 3 vars */) = 0\n'
                '10 <... execve resumed>) = 0\n'
                '11 stat("//ZR-EVIL-9.invalid/s/a.mp4", 0x7ff) = -1 ENOENT (No such file or directory)\n'
                '12 openat(AT_FDCWD, "\\\\\\\\\\357\\275\\232r-x\\\\s", O_RDONLY) = -1 ENOENT\n')
    hits = observe.trace_hits(log, ["zr-evil-9.invalid", "\uff5ar-x"])
    with open(log, "a", encoding="latin-1") as f:
        f.write('13 sendto(5<TCP:[127.0.0.1:1->127.0.0.1:2]>, "GET /file?path=//zr-evil-9.invalid/s HTTP/1.1", 40, 0, '
                'NULL, 0) = 40\n')
    hits = observe.trace_hits(log, ["zr-evil-9.invalid", "\uff5ar-x"])
    t.check("trace search: finds a file call (any ASCII case, a non-ASCII name), never an execve's argv or a "
            "send's data", len(hits) == 2 and hits[0].startswith("11 ") and hits[1].startswith("12 "), hits)
    net = t.path("side", "net.log")
    lines = {
        "tcp out": '20 connect(19<TCP:[9]>, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("140.82.1.3")}, 16)'
                   ' = -1 ENETUNREACH (Network is unreachable)',
        "tcp6 out": '21 connect(7<TCPv6:[9]>, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), '
                    'inet_pton(AF_INET6, "2606:50c0::153", &sin6_addr), sin6_scope_id=0}, 28 <unfinished ...>',
        "dns": '22 connect(3<UDP:[9]>, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("127.0.0.53")}, 16) = 0',
        "udp send": '23 sendmmsg(3<UDP:[10.0.0.2:5->1.1.1.1:443]>, [{msg_hdr={msg_name=NULL, msg_namelen=0}}], 1, 0) = 1',
        "sendto addr": '24 sendto(4<UDP:[9]>, "x", 1, 0, {sa_family=AF_INET, sin_port=htons(9), '
                       'sin_addr=inet_addr("192.0.2.1")}, 16) = 1',
        "unknown socket": '25 connect(8, {sa_family=AF_INET, sin_port=htons(80), sin_addr=inet_addr("192.0.2.9")}, 16) = 0',
        "udp connect": '26 connect(6<UDP:[9]>, {sa_family=AF_INET, sin_port=htons(9), sin_addr=inet_addr("192.0.2.1")}, 16)'
                       ' = 0',
        "udp6 other port": '27 connect(6<UDPv6:[9]>, {sa_family=AF_INET6, sin6_port=htons(444), sin6_flowinfo=htonl(0), '
                           'inet_pton(AF_INET6, "2001:4860:4860::8888", &sin6_addr), sin6_scope_id=0}, 28) = 0',
        "io_uring": '28 io_uring_setup(8, {flags=0, sq_thread_cpu=0, sq_thread_idle=0}) = 5<anon_inode:[io_uring]>',
        "io_uring resumed": '28 <... io_uring_setup resumed>, sq_entries=8, cq_entries=16}) = 7',
        "io_uring refused": '28 io_uring_setup(256, {flags=0x10000, sq_thread_cpu=0, sq_thread_idle=0}) = -1 ENOSYS '
                            '(Function not implemented) (INJECTED)',
        "io_uring unfinished": '28 io_uring_setup(256, {flags=0x10000, sq_thread_cpu=0, sq_thread_idle=0} <unfinished ...>',
        "udp probe": '30 connect(19<UDPv6:[9]>, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), '
                     'inet_pton(AF_INET6, "2001:4860:4860::8888", &sin6_addr), sin6_scope_id=0}, 28) = 0',
        "udp loopback": '29 connect(6<UDP:[9]>, {sa_family=AF_INET, sin_port=htons(9), sin_addr=inet_addr("127.0.0.1")}, '
                        '16) = 0',
        "loopback": '31 connect(4<TCP:[9]>, {sa_family=AF_INET, sin_port=htons(4791), sin_addr=inet_addr("127.0.0.1")}, 16) = 0',
        "loopback6": '32 sendto(4<TCPv6:[[::1]:5->[::1]:6]>, "hi", 2, 0, NULL, 0) = 2',
        "unix": '33 connect(5<UNIX-STREAM:[9]>, {sa_family=AF_UNIX, sun_path="/run/x"}, 110) = 0',
        "quoted data": '34 sendto(4<TCP:[127.0.0.1:5->127.0.0.1:6]>, "sa_family=AF_INET, sin_port=htons(443), '
                       'sin_addr=inet_addr(\\"8.8.8.8\\")", 60, 0, NULL, 0) = 60',
        "resumed": '35 <... connect resumed>) = 0',
        "file": '36 openat(AT_FDCWD, "/m/a.mp4", O_RDONLY) = 3',
    }
    with open(net, "w", encoding="latin-1") as f:
        f.write("\n".join(lines.values()) + "\n")
    found = {k for k, v in lines.items() if any(h == v for h in observe.net_hits(net))}
    want = {"tcp out", "tcp6 out", "dns", "udp send", "sendto addr", "unknown socket", "udp connect", "udp6 other port",
            "io_uring", "io_uring resumed"}
    t.check("network search: a TCP or UDP connect to another computer, a DNS lookup, a send to another computer or an "
            "io_uring setup that made a ring is found; a refused or unfinished io_uring setup, the exact Chromium probe (a UDP connect to [2001:4860:4860::8888]:443), loopback, "
            "unix sockets and quoted data are not", found == want,
            sorted(found ^ want) or sorted(found))
    src = t.path("side", "saved.json")
    with open(src, "w", encoding="utf-8") as f:
        json.dump({"path": "/m/a.mp4", "size": 113, "counter": 113}, f)
    made = observe.craft(src, t.path("side", "made.json"), [("/m/a.mp4", "//h/s/a.mp4")], "the media path")
    twice = observe.craft(src, t.path("side", "twice.json"), [(113, "113,x")], "the size once",
                          need=lambda c: c == [1])
    lost = observe.craft(src, t.path("side", "lost.json"), [("/m/b.mp4", "x")], "the other path")
    t.check("crafting: an input made, one whose number occurs twice and one whose value is absent are not",
            made.applicable and not twice.applicable and not lost.applicable and twice.counts == [2]
            and "the other path" in lost.why and json.load(open(made.path))["path"] == "//h/s/a.mp4",
            [made, twice, lost])
    sizes = observe.file_sizes(t.path("side"))
    t.check("file sizes: every file under a folder with its size", sizes.get(src) == os.path.getsize(src)
            and sizes.get(net) == os.path.getsize(net), len(sizes))
    src = t.path("side", "p.json")
    with open(src, "w", encoding="utf-8") as f:
        json.dump({"path": "/m/a.mp4", "list": ["x /m/a.mp4 y", 0.0123], "/m/a.mp4": 1, "n": 0.0123, "k": 2}, f)
    out = t.path("side", "q.json")
    counts = observe.substitute(src, out, [("/m/a.mp4", "//h/s/a.mp4"), (0.0123, "0.0123,x"), ("absent", "z")])
    q = json.load(open(out, encoding="utf-8"))
    t.check("substitution: strings and equal numbers replaced, keys kept, a missing value counted 0",
            counts == [2, 2, 0] and q == {"path": "//h/s/a.mp4", "list": ["x //h/s/a.mp4 y", "0.0123,x"],
                                          "/m/a.mp4": 1, "n": "0.0123,x", "k": 2}, [counts, q])
    os.makedirs(t.path("side", "deep", "x"), exist_ok=True)
    with open(t.path("side", "deep", "x", "a-MARK-1.jpg"), "w") as f:
        f.write("")
    found = observe.named(t.path("side", "deep"), "MARK-1")
    t.check("marker search: a file named with the marker is found", len(found) == 1 and found[0].endswith("a-MARK-1.jpg"),
            found)
    t.check("secret search: 8 characters of the secret are found, 7 are not",
            observe.holds_secret("..abcdefgh..", "xabcdefghz") and not observe.holds_secret("..abcdefg..", "xabcdefghz"))
