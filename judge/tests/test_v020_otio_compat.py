"""The editor opens the OpenTimelineIO files that the v0.2.0 release exports, as v0.2.0 itself opens them.

Anthony's compatibility decision (2026-10-20): ZedMix's first release opens v0.2.0's OTIO exports (v0.2.0 writes its
own data in metadata.synthcut), and a user's .aive projects reach the new editor through v0.2.0's OTIO export. The
files are in judge/fixtures/v020-otio: each is what the v0.2.0 release (the editor's real build, through the judge's
v0.2.0 adapter) wrote for a timeline that judge/fixtures/v020-otio/generate.py built, with only its media folder
replaced by a token. manifest.json says what each must open as; v0.2.0 opened each of them so (twice: after building,
and from its own export) before it was checked in.

For each file the test points it at this run's media (judge/fixtures/make.sh made them: a.mp4, b.mp4, c640.mp4,
m.mp3, look.cube, and the flat pictures fx-pair.mp4, fx-redblue.mp4, fx-gray128.mp4, fx-ramp.mp4), opens it with
import_otio, and checks:
- what the editor reports (get_state): the canvas, the length, which tracks hold clips, each clip's media file,
  position, source range, length on the timeline and speed, and the effects (with their amounts, their params, their
  colour read as a hex colour, and whether each is on or bypassed) and texts on it; every media file online and none
  missing;
- an export of it (observe.py): its length, size and frame rate; frames at known times against the source media
  frame they must show (SSIM, best of the source frame and its neighbours, and closer to it than to the frames half
  a second away), a gap that is black, a 4:3 clip of an upper track fitted over the track below it (regions), the
  looks the file carries (grayscale, a grade, vignette 2 and 0, the red-blue LUT, a text in its colour on its box, a
  warm white balance, invert; a grade's saturation on a flat colour, colorhold's colour, exposure's black point, a
  bypassed vignette; the grade's contrast, gamma, tint and hue on a grey ramp, a grey and a red and a blue),
  measured against references made from the source frame with FFmpeg's own filters (negate, a channel swap) or
  against the source frame's own statistics; and the tones of the clips' audio and of an audio track. A colour grade
  is not in the State (protocol 1), so it is observed on the export only.
Nothing is read from the editor's own files: what it reports and what it exports are the observations.
Every check is recorded on every path (a check whose input is missing fails with the reason), so CHECKS is exact; it
is counted from the manifest.
"""
import json
import os
import urllib.parse

import driver as drv
import observe

PORT_BOUND = True
TIMEOUT = 1800

FIXTURES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fixtures", "v020-otio")
with open(os.path.join(FIXTURES, "manifest.json"), encoding="utf-8") as _f:
    MANIFEST = json.load(_f)
STATE_CHECKS = 7    # opens, canvas, length, track layout, clips, media online, effects and texts
EXPORT_CHECKS = 3   # finishes, length, size and rate
CHECKS = sum(STATE_CHECKS + EXPORT_CHECKS + len(f["probes"]) for f in MANIFEST["files"])

SSIM_SOURCE = 0.90   # an export frame that shows a source frame (scaled to the canvas)
SSIM_REGION = 0.85   # a region of it
HEARD, NOT_HEARD, QUIET = -40.0, -60.0, -50.0   # dB: a tone's band level, and the mean level of a gap


def point_at_media(t, entry):
    """The fixture with the token replaced by this run's media folder (its file:// URL first, then its path), written
    in the test's folder. -> (path, why not) where `why not` says what did not match the manifest."""
    with open(os.path.join(FIXTURES, entry["file"]), encoding="utf-8") as f:
        text = f.read()
    token = MANIFEST["token"]
    media = os.path.realpath(t.media_dir)
    url = json.dumps("file://" + urllib.parse.quote(media))[1:-1]
    n_url = text.count("file://" + token)
    text = text.replace("file://" + token, url)
    n_path = text.count(token)
    text = text.replace(token, json.dumps(media)[1:-1])
    path = t.path("otio", entry["file"])
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    why = None
    if (n_path, n_url) != (entry["media_folder_replaced"], entry["media_url_replaced"]):
        why = (f"the fixture holds the media folder {n_path} times and its URL {n_url} times, not "
               f"{entry['media_folder_replaced']} and {entry['media_url_replaced']}")
    return path, why


def shape(st, media):
    """The State in the manifest's terms: media by file name (in the media folder), no identifiers."""
    paths = {a.get("id"): a.get("path") for a in st.get("assets", [])}
    tracks = {}
    for tr in st.get("tracks", []):
        clips = []
        for c in tr.get("clips", []):
            p = paths.get(c.get("asset")) or ""
            rp = os.path.realpath(p) if p else ""
            clips.append({"media": os.path.relpath(rp, media) if rp.startswith(media + os.sep) else p,
                          "start_frame": c.get("start_frame"), "in_frame": c.get("in_frame"),
                          "out_frame": c.get("out_frame"), "length_frames": c.get("length_frames"),
                          "speed": c.get("speed"),
                          "effects": [{"effect": e.get("effect"), "amount": e.get("amount"), "params": e.get("params"),
                                       "color": e.get("color"), "enabled": e.get("enabled")}
                                      for e in c.get("effects") or []],
                          "texts": [x.get("text") for x in c.get("texts") or []]})
        if clips:
            tracks[tr.get("track")] = clips
    return tracks


def place(c):
    return {k: c.get(k) for k in ("media", "start_frame", "in_frame", "out_frame", "length_frames", "speed")}


def same_number(a, b):
    return isinstance(a, (int, float)) and isinstance(b, (int, float)) and abs(a - b) < 1e-6


def same_effect(got, want):
    """Whether an effect the editor reports is the manifest's: its name and amount, each param the manifest names (the
    editor may report more), its colour as a hex colour (observe.hex_colour: any spelling), and whether it is on."""
    params = got.get("params") or {}
    return (got.get("effect") == want["effect"]
            and (got.get("amount") == want["amount"] or same_number(got.get("amount"), want["amount"]))
            and all(same_number(params.get(k), v) for k, v in (want.get("params") or {}).items())
            and ("color" not in want or observe.hex_colour(got.get("color")) == observe.hex_colour(want["color"]))
            and got.get("enabled") is want.get("enabled", True))


def run(t):
    d = t.driver()
    media = os.path.realpath(t.media_dir)
    frames = observe.Frames(t.path("frames", "x"))
    for entry in MANIFEST["files"]:
        one_file(t, d, media, frames, entry)


def one_file(t, d, media, frames, e):
    name = e["file"]
    w, h, fps = e["canvas"]
    path, why = point_at_media(t, e)
    opened, what, missing = False, why, None
    if not why:
        try:
            missing = d.import_otio(path).get("missing")
            opened, what = True, f"missing {missing}"
        except (drv.ProductError, drv.BadRequest) as ex:
            what = f"refused: {ex.message[:300]}"
    t.check(f"{name}: v0.2.0's export opens (import_otio)", opened, what)
    st = d.get_state() if opened else {}
    canvas = st.get("canvas") or {}
    t.check(f"{name}: the canvas is {w}x{h} at {fps} fps, as v0.2.0 exported it",
            opened and canvas.get("width") == w and canvas.get("height") == h
            and same_number(canvas.get("fps"), fps), canvas if opened else "not opened")
    t.check(f"{name}: the timeline is {e['length']} frames long", opened and st.get("length_frames") == e["length"],
            st.get("length_frames") if opened else "not opened")
    got = shape(st, media) if opened else {}
    want = e["tracks"]
    t.check(f"{name}: the tracks that hold clips are {sorted(want)}, with "
            + ", ".join(f"{len(want[k])} on {k}" for k in sorted(want)),
            opened and {k: len(v) for k, v in got.items()} == {k: len(v) for k, v in want.items()},
            {k: len(v) for k, v in got.items()} if opened else "not opened")
    bad = []
    for k, clips in want.items():
        have = got.get(k, [])
        for i, c in enumerate(clips):
            g = place(have[i]) if i < len(have) else None
            if g is None or any(not (g[x] == c[x] or same_number(g[x], c[x])) for x in place(c)):
                bad.append(f"{k}[{i}]: {g} (want {place(c)})")
    t.check(f"{name}: each clip has the media file, position, source range, length and speed v0.2.0 exported",
            opened and not bad and bool(got), "; ".join(bad)[:900] if opened else "not opened")
    assets = st.get("assets") or []
    off = [a.get("path") for a in assets if a.get("offline")]
    t.check(f"{name}: every media file is online and none is missing", opened and not off and not missing,
            f"offline {off}, missing {missing}" if opened else "not opened")
    bad = []
    for k, clips in want.items():
        have = got.get(k, [])
        for i, c in enumerate(clips):
            g = have[i] if i < len(have) else {"effects": None, "texts": None}
            fx_ok = g["effects"] is not None and len(g["effects"]) == len(c["effects"]) and all(
                same_effect(x, y) for x, y in zip(g["effects"], c["effects"]))
            if not fx_ok or g["texts"] != c["texts"]:
                bad.append(f"{k}[{i}]: effects {g['effects']} texts {g['texts']} (want {c['effects']}, {c['texts']})")
    t.check(f"{name}: each clip has the effects (with their amounts, params, colours and bypass) and texts v0.2.0 "
            "exported",
            opened and not bad, "; ".join(bad)[:900] if opened else "not opened")

    out = t.path("out", name.replace(".otio", ".mp4"))
    job = d.export(out) if opened else {"status": "not opened"}
    done = job.get("status") == "done"
    t.check(f"{name}: the export finishes", done, job)
    seconds = e["length"] / fps
    if done:
        t.measure(f"{name}: the export lasts {seconds:g} s (+-0.1)", lambda: observe.duration(out),
                  lambda v: abs(v - seconds) <= 0.1, f"{seconds:g} +- 0.1 s")
        t.measure(f"{name}: the export is {w}x{h} at {fps} fps", lambda: (observe.size(out), observe.fps(out)),
                  lambda v: v[0][:2] == (w, h) and abs(v[1] - fps) < 0.01, f"{w}x{h}, {fps} fps")
    else:
        for c in (f"{name}: the export lasts {seconds:g} s (+-0.1)", f"{name}: the export is {w}x{h} at {fps} fps"):
            t.check(c, False, "no export")
    for p in e["probes"]:
        label = f"{name}: {describe(p)}"
        if not done:
            t.check(label, False, "no export")
            continue
        try:
            ok, detail = probe(t, frames, media, out, p, (w, h))
        except observe.Unmeasurable as ex:
            ok, detail = False, f"unmeasurable: {ex}"
        t.check(label, ok, detail)


def describe(p):
    k = p["kind"]
    if k == "source":
        return (f"the frame at {p['t']} s shows {p['media']} at {p['source_t']} s"
                + (f" ({p['what']})" if p.get("what") else ""))
    if k == "region":
        return f"at {p['t']} s, {p['what']} shows {p['media']} at {p['source_t']} s"
    if k == "black":
        return f"the frame at {p['t']} s is black (a gap)"
    if k == "tone":
        return f"the {p['hz']} Hz tone is {'heard' if p['heard'] else 'not heard'} from {p['from']} to {p['to']} s"
    if k == "quiet":
        return f"the audio is quiet from {p['from']} to {p['to']} s (a gap)"
    if k == "audio_length":
        return f"the audio lasts {p['seconds']:g} s (+-0.15)"
    if k == "look":
        return f"the frame at {p['t']} s shows {p['media']} at {p['source_t']} s {LOOKS[p['look']]}"
    raise ValueError(k)


TEXT_CHANGE = 200   # a pixel the text changed: its R+G+B differs from the source's by this much (and it is bright)
BOX_ROWS = 60       # rows of the bottom third the box turns black (v0.2.0's 64-pixel text: 97; without a box: 16-18)
LOOKS = {
    "grayscale": "in grayscale",
    "brighter": "brighter (its grade's brightness 0.15; its saturation 1.4 is measured in params.otio)",
    "vignette": "with darker corners and the middle unchanged",
    "red_blue_swapped": "with red and blue swapped (the LUT)",
    "text_at_bottom": "with a text at the bottom and the top unchanged",
    "text_yellow": "with the text in its colour, yellow (#ffe14d)",
    "text_box": "with the text on its black box, as tall as for 64-pixel text",
    "warmer": "warmer (more red against blue)",
    "inverted": "inverted",
    "graded_dull": "brighter and more saturated (its grade: brightness 0.15, saturation 1.4)",
    "red_held": "with its red held and its blue turned grey (colorhold #e02020)",
    "lifted": "with its black point lifted (exposure, black 0.1)",
    "contrast": "with more contrast (contrast 1.6: the ramp's dark end darker, its light end lighter, its middle kept)",
    "gamma": "with its mid-tones lifted (gamma 2: the ramp's middle brighter, its ends less)",
    "tint": "tinted magenta (tint 0.6: red and blue over green)",
    "hue": "with its hues turned 120 degrees (hue 120: the red to green, the blue to red)",
}
SOURCE_FPS = 30
# The grade fields on flat pictures (grades.otio). Where the ramp is sampled (its share of the width), and how much each
# field must change it; v0.2.0's export of its own file (FFmpeg 9.0.2-17 and 4.4 alike) changes the ramp's luma at
# RAMP_AT by -31, -42, -4, +35, +33 with contrast 1.6 and by +72, +74, +62, +41, +27 with gamma 2, turns grey 128
# into (128, 96, 128) with tint 0.6, and the red and the blue into (0, 166, 0) and (182, 0, 0) with hue 120. The
# values in brackets below are v0.2.0's for a weaker or another grade, which must fail (and does): judge/PORTING.md.
RAMP_AT = (0.125, 0.25, 0.5, 0.75, 0.875)
CONTRAST_STEP = 25   # contrast 1.6: the ramp's quarter points darker and lighter by this much (contrast 1.3: -22, +17)
GAMMA_MID = 45       # gamma 2: the ramp's middle brighter by this much (gamma 1.5: +39)
GAMMA_BEND = 10      # ... and by this much more than its three-quarter point (brightness 0.25: +73 and +65)
KEPT = 12            # what may move where a field keeps the picture
TINT = 20            # tint 0.6 on grey: red and blue over green (tint 0.3: 15)
HUE = 100            # hue 120 on red and blue: the new dominant channel over the others (hue 60: none)
CORNERS = [f"crop=48:48:{x}:{y}" for x, y in (("0", "0"), ("iw-48", "0"), ("0", "ih-48"), ("iw-48", "ih-48"))]


def probe(t, frames, media, out, p, size):
    """(ok, detail) of one observation on the export `out` (Unmeasurable when a frame or a stream is missing)."""
    k = p["kind"]
    if k == "black":
        st = observe.signalstats(frames.get(out, p["t"]))
        return st["YAVG"] < 30, f"mean luma {st['YAVG']:.1f} (want < 30)"
    if k == "tone":
        lv = observe.band_level(out, p["hz"], p["from"], p["to"])
        ok = (lv is not None and lv > HEARD) if p["heard"] else (lv is None or lv < NOT_HEARD)
        return ok, f"{lv} dB in the {p['hz']} Hz band (want {'>' if p['heard'] else '<'} " \
                   f"{HEARD if p['heard'] else NOT_HEARD} dB)"
    if k == "quiet":
        lv = observe.mean_volume(out, start=p["from"], end=p["to"])
        return lv is None or lv < QUIET, f"mean volume {lv} dB (want < {QUIET} dB)"
    if k == "audio_length":
        a = observe.audio_stream(out)
        if a is None:
            raise observe.Unmeasurable("no audio stream")
        n = observe.stream_duration(a)
        return n is not None and abs(n - p["seconds"]) <= 0.15, f"{n} s"
    src = os.path.join(media, p["media"])
    if k == "source":
        best = max(observe.frame_ssim(frames, src, max(0.0, p["source_t"] + j / SOURCE_FPS), out, p["t"])
                   for j in (-1, 0, 1))
        offs = [observe.frame_ssim(frames, src, p["source_t"] + dt, out, p["t"]) for dt in (-0.5, 0.5)
                if 0 <= p["source_t"] + dt <= observe.duration(src) - 0.2]
        return best >= SSIM_SOURCE and all(best > o for o in offs), \
            f"SSIM {best:.4f} (want >= {SSIM_SOURCE}); half a second away {[round(o, 4) for o in offs]}"
    if k == "region":  # the crop is in the canvas's terms: an export of another size is scaled to it first
        sz = tuple(p["size"])
        got = frames.get(out, p["t"], size=sz, vf_extra=f"scale={size[0]}:{size[1]}:flags=bicubic,{p['crop']}")
        best = max(observe.ssim(got, frames.get(src, max(0.0, p["source_t"] + j / SOURCE_FPS), size=sz,
                                                vf_extra=p["source_chain"])) for j in (-1, 0, 1))
        return best >= SSIM_REGION, f"SSIM {best:.4f} (want >= {SSIM_REGION})"
    if k == "look":
        return look(frames, src, out, p, size)
    raise ValueError(k)


def look(frames, src, out, p, size):
    """A look: the export's frame at p["t"] against the source's frame at p["source_t"], scaled to the canvas."""
    w, h = size
    scale = f"scale={w}:{h}:flags=bicubic"
    got = frames.get(out, p["t"], size=(w, h))  # an export of another size is compared at the canvas's
    ref = frames.get(src, p["source_t"], size=(w, h))
    lk = p["look"]
    if lk == "grayscale":
        g, s = observe.signalstats(got), observe.signalstats(ref)
        return g["SATAVG"] < 5 and s["SATAVG"] > 30, \
            f"saturation {g['SATAVG']:.1f} (want < 5; the source's {s['SATAVG']:.1f})"
    if lk == "brighter":
        g, s = observe.signalstats(got), observe.signalstats(ref)
        return g["YAVG"] >= s["YAVG"] + 12, f"luma {g['YAVG']:.1f} vs the source's {s['YAVG']:.1f} (want +12)"
    if lk == "vignette":
        gc = sum(observe.signalstats(frames.get(out, p["t"], size=(48, 48), vf_extra=f"{scale},{c}"))["YAVG"]
                 for c in CORNERS)
        sc = sum(observe.signalstats(frames.get(src, p["source_t"], size=(48, 48), vf_extra=f"{scale},{c}"))["YAVG"]
                 for c in CORNERS)
        mid = observe.ssim(got, ref, region="centre")
        return gc <= 0.6 * sc and mid >= SSIM_REGION, \
            f"corner luma {gc / 4:.1f} vs the source's {sc / 4:.1f} (want <= 60%); middle SSIM {mid:.4f}"
    if lk in ("red_blue_swapped", "inverted"):
        chain = "colorchannelmixer=rr=0:rb=1:bb=0:br=1" if lk == "red_blue_swapped" else "negate"
        made = frames.get(src, p["source_t"], size=(w, h), vf_extra=f"format=rgb24,{chain}")
        a, b = observe.ssim(got, made), observe.ssim(got, ref)
        return a >= SSIM_REGION and a > b + 0.1, \
            f"SSIM {a:.4f} against the source with FFmpeg's {chain} (want >= {SSIM_REGION}), {b:.4f} against the " \
            f"source as it is"
    if lk == "text_at_bottom":
        bottom, top = observe.ssim(got, ref, region="bottom_third"), observe.ssim(got, ref, crop="crop=iw:ih/2:0:0")
        return bottom < 0.85 and top >= SSIM_SOURCE, \
            f"bottom third SSIM {bottom:.4f} (want < 0.85), top half {top:.4f} (want >= {SSIM_SOURCE})"
    if lk == "warmer":  # more red (Cr, V) and less blue (Cb, U) than the source
        g, s = observe.signalstats(got), observe.signalstats(ref)
        dg, ds = g["VAVG"] - g["UAVG"], s["VAVG"] - s["UAVG"]
        return dg >= ds + 8, f"V - U {dg:.1f} vs the source's {ds:.1f} (want +8)"
    if lk in ("text_yellow", "text_box"):
        return text(src, out, p, size, lk)
    # a flat picture's 16x16 blocks (the source scaled to the canvas, as the editor fits it): the middle of the left
    # half, of the right half, and of the picture
    left, right, mid = (w // 4 - 8, h // 2 - 8), (3 * w // 4 - 8, h // 2 - 8), (w // 2 - 8, h // 2 - 8)

    def block(path, at, xy):
        b = observe.pixels(path, at, f"{scale},crop=16:16:{xy[0]}:{xy[1]},scale=1:1:flags=area")
        if len(b) < 3:
            raise observe.Unmeasurable(f"no colour read from {os.path.basename(path)} at {at}s")
        return tuple(b[:3])
    if lk == "graded_dull":  # fx-pair's left half, a dull red (0x806060)
        g, s = block(out, p["t"], left), block(src, p["source_t"], left)
        return luma(g) >= luma(s) + 12 and spread(g) >= 1.2 * spread(s), \
            f"the dull red {g}: luma {luma(g):.1f}, spread {spread(g)} vs the source's {s}: {luma(s):.1f}, " \
            f"{spread(s)} (want luma +12, spread x1.2)"
    if lk == "red_held":  # fx-redblue: 0xE02020 on the left, 0x2020E0 on the right
        a, b = block(out, p["t"], left), block(out, p["t"], right)
        return a[0] > 180 and a[0] - a[1] > 120 and spread(b) <= 16, \
            f"left {a} (want red > 180, red - green > 120), right {b} (want spread <= 16)"
    if lk == "lifted":  # fx-gray128
        g, s = block(out, p["t"], mid), block(src, p["source_t"], mid)
        return abs(luma(g) - 114) <= 6 and luma(s) >= 122, f"luma {luma(g):.1f} (want 114 +- 6), the source's " \
            f"{luma(s):.1f}"
    if lk in ("contrast", "gamma"):  # fx-ramp: black at the left to white at the right
        at = [(int(f * w) - 8, h // 2 - 8) for f in RAMP_AT]
        g = [round(luma(block(out, p["t"], xy)), 1) for xy in at]
        s = [round(luma(block(src, p["source_t"], xy)), 1) for xy in at]
        d = [round(a - b, 1) for a, b in zip(g, s)]
        detail = f"the ramp's luma at {list(RAMP_AT)} of its width {g} vs the source's {s} (change {d})"
        if lk == "contrast":
            return d[0] < 0 and d[1] <= -CONTRAST_STEP and d[3] >= CONTRAST_STEP and d[4] > 0 and abs(d[2]) <= KEPT, \
                f"{detail} (want the quarter points {CONTRAST_STEP} or more darker and lighter, the ends too, the " \
                f"middle within {KEPT})"
        return d[2] >= GAMMA_MID and d[1] > d[2] and d[2] - d[3] >= GAMMA_BEND and min(d) > 0, \
            f"{detail} (want the middle {GAMMA_MID} or more brighter, the quarter more than that, the three-quarter " \
            f"point {GAMMA_BEND} or more less, nothing darker)"
    if lk == "tint":  # fx-gray128
        g, s = block(out, p["t"], mid), block(src, p["source_t"], mid)
        return min(g[0], g[2]) - g[1] >= TINT and abs(g[0] - g[2]) <= 8 and spread(s) <= 4, \
            f"{g} vs the source's {s} (want red and blue each {TINT} or more over green and within 8 of each other; " \
            f"the source grey)"
    if lk == "hue":  # fx-redblue: 0xE02020 on the left, 0x2020E0 on the right
        a, b = block(out, p["t"], left), block(out, p["t"], right)
        return a[1] - max(a[0], a[2]) >= HUE and b[0] - max(b[1], b[2]) >= HUE, \
            f"left {a} (want green {HUE} or more over red and blue), right {b} (want red {HUE} or more over green and " \
            f"blue)"
    raise ValueError(lk)


def luma(c):
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def spread(c):
    return max(c) - min(c)


def text(src, out, p, size, lk):
    """The text in the bottom third of the export's frame against the source frame (both at the canvas's size, rgb24):
    text_yellow, the mean colour of the pixels the text changed (R+G+B by TEXT_CHANGE or more, and bright: a channel
    over 100); text_box, how many rows of it the box turned black (100 pixels or more of a row whose colour changed by
    60 or more to black: every channel under 40)."""
    w, h = size
    h3 = h // 3
    chain = f"scale={w}:{h}:flags=bicubic,crop={w}:{h3}:0:{h - h3}"
    g, s = observe.pixels(out, p["t"], chain), observe.pixels(src, p["source_t"], chain)
    if min(len(g), len(s)) < w * h3 * 3:
        raise observe.Unmeasurable("a short frame")
    changed, rows = [], [0] * h3
    for k in range(w * h3):
        a, b = g[k * 3:k * 3 + 3], s[k * 3:k * 3 + 3]
        d = abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])
        if d >= TEXT_CHANGE and max(a) > 100:
            changed.append(a)
        elif d >= 60 and max(a) < 40:
            rows[k // w] += 1
    if lk == "text_box":
        n = sum(1 for r in rows if r >= 100)
        return n >= BOX_ROWS, f"{n} rows of the bottom third turned black (want {BOX_ROWS} or more; v0.2.0: 97)"
    if len(changed) < 500:
        return False, f"{len(changed)} pixels changed by the text (want 500 or more)"
    m = [sum(c[i] for c in changed) / len(changed) for i in range(3)]
    return m[0] - m[2] >= 80 and m[1] - m[2] >= 60, \
        f"{len(changed)} pixels changed by the text, mean ({m[0]:.0f}, {m[1]:.0f}, {m[2]:.0f}) (want red - blue " \
        f">= 80, green - blue >= 60)"
