"""What the looks and style effects do to the picture, measured on exports: exposure, vibrance, invert, colorhold
(its colour given as 0xRRGGBB and as #rrggbb), grain, glow, RGB split, the lens warp (its direction, and that it fills
the frame), trails, and that a keyed clip's background colour does not tint the subject through glow or RGB split
(through trails it does on v0.2.0's export and this tree's: judge/PORTING.md). Port of section 9 of
packages/core/scripts/smoke-registry.ts (judge/PORTING.md has the map of its sections).

Each case is a clip of its own on v0 (a segment of the timeline) of one of make.sh's flat test pictures (fx-*.mp4,
320x180 at 30 fps, the canvas's size and rate, so nothing is scaled), with its effects; one export holds a timeline's
segments (12 at a time: a timeline of many clips exports far slower), and the test samples the export where the
original sampled its export: the mean colour of a small block (observe.block_rgb, the original's sampleBlock), a run
of frames, a column. The thresholds are the original's, but for the lens's zoom to fill: the original fails a pixel
that is less than fully opaque, and the export has no alpha, so a pixel more than UNFILLED below the grey without the
lens fails (a pixel left a quarter uncovered shows the black canvas through it and reads about 97 against 128, and a
picture left 4 % see-through reads about 123).

Every check is recorded on every path (a check whose input is missing fails with the reason), so CHECKS is exact.
"""
import math

import observe

PORT_BOUND = True
TIMEOUT = 1500
CHECKS = 29

W, H, FPS = 320, 180, 30
LENS_GRID = [(k1, k2) for k1 in (-1, -0.5, 0, 0.3, 0.5, 1) for k2 in (-1, -0.5, 0, 0.5, 1) if (k1, k2) != (0, 0)]

# The segments of the landscape timeline: (name, media, frames, [(effect, amount, params, color)]).
SEGMENTS = [
    ("exp-none", "fx-gray64.mp4", 30, []), ("exp+1", "fx-gray64.mp4", 30, [("exposure", 1, None, None)]),
    ("exp-1", "fx-gray64.mp4", 30, [("exposure", -1, None, None)]),
    ("exp+3", "fx-gray64.mp4", 30, [("exposure", 3, None, None)]),
    ("exp9", "fx-gray64.mp4", 30, [("exposure", 9, None, None)]),
    ("lift", "fx-gray128.mp4", 30, [("exposure", 0, {"black": 0.1}, None)]),
    ("vib+1", "fx-pair.mp4", 30, [("vibrance", 1, None, None)]), ("vib-1", "fx-pair.mp4", 30, [("vibrance", -1, None, None)]),
    ("inv", "fx-blue.mp4", 30, [("invert", None, None, None)]),
    ("hold", "fx-redblue.mp4", 30, [("colorhold", None, {"similarity": 0.3, "blend": 0.1}, "0xE02020")]),
    ("hold#", "fx-redblue.mp4", 30, [("colorhold", None, {"similarity": 0.3, "blend": 0.1}, "#e02020")]),
    ("g0", "fx-gray128.mp4", 30, []), ("g40", "fx-gray128.mp4", 30, [("grain", 40, None, None)]),
    ("g80", "fx-gray128.mp4", 30, [("grain", 80, None, None)]),
    ("box", "fx-box.mp4", 30, []), ("glow", "fx-box.mp4", 30, [("glow", 1, {"radius": 12}, None)]),
    ("rgb0", "fx-box.mp4", 30, [("rgbsplit", 8, {"angle": 0}, None)]),
    ("rgb90", "fx-box.mp4", 30, [("rgbsplit", 8, {"angle": 90}, None)]),
    ("flat", "fx-gridline.mp4", 30, []), ("lens-", "fx-gridline.mp4", 30, [("lens", -0.4, None, None)]),
    ("lens+", "fx-gridline.mp4", 30, [("lens", 0.4, None, None)]),
    ("mover", "fx-mover.mp4", 60, []), ("tr95", "fx-mover.mp4", 60, [("trails", 0.95, None, None)]),
    ("tr80", "fx-mover.mp4", 60, [("trails", 0.8, None, None)]),
    ("ramp", "fx-ramp.mp4", 30, [("exposure", 2, {"black": 0.25}, None)]),
    ("keyed", "fx-greensq.mp4", 30, [("chromakey", None, {"similarity": 0.1, "blend": 0}, "0x00FF00")]),
] + [(f"key+{e}", "fx-greensq.mp4", 30, [("chromakey", None, {"similarity": 0.1, "blend": 0}, "0x00FF00"),
                                         (e, None, None, None)]) for e in ("glow", "rgbsplit")] + [(f"lens{k1},{k2}", "fx-gray128.mp4", 3, [("lens", k1, {"k2": k2}, None)]) for k1, k2 in LENS_GRID] + [
    ("fill0", "fx-gray128.mp4", 3, [("lens", 0.3, {"fill": 0}, None)])]


def luma(c):
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def hsv_sat(c):
    mx = max(c)
    return 0 if mx == 0 else (mx - min(c)) / mx


def sd(a):
    m = sum(a) / len(a)
    return math.sqrt(sum((x - m) ** 2 for x in a) / len(a))


def fmt(c):
    return "(" + ",".join(str(int(v)) for v in c) + ")"


# Luma below the unwarped grey's that counts a pixel as not filled (empty or partly empty). Every pixel of every real
# lens setting reads the grey itself (128) on v0.2.0's and this tree's exports with FFmpeg 9.0.2-17 and 4.4, and the
# export keeps a single darker pixel within 1 of its value; a picture 2 % see-through over the black canvas reads 125.
UNFILLED = 2


def unfilled(frames, control):
    """({name: how many pixels of the frame are more than UNFILLED below the control's median luma, for each frame that
    has one}, that median, [the lowest luma of any frame, the frame's name]). frames: {name: (export, time)} of lens
    segments of a flat grey picture; control: (export, time) of the same picture without the lens. A pixel the warp
    leaves partly uncovered shows the black canvas through it and reads darker (one left a quarter uncovered reads
    about 97 against 128, and the export keeps such a pixel within 1)."""
    px = sorted(observe.pixels(*control, "null", "gray"))
    grey = px[len(px) // 2]
    counts, lowest = {}, [256, None]
    for k, f in frames.items():
        got = observe.pixels(*f, "null", "gray")
        n = sum(1 for v in got if v < grey - UNFILLED)
        if n:
            counts[k] = n
        if min(got) < lowest[0]:
            lowest = [min(got), k]
    return counts, grey, lowest


def filled(v):
    counts, grey, _ = v
    return grey >= 100 and not counts


def build(d, t, segments, track="v0"):
    """Places each segment's clip and its effects. -> {name: start time in seconds}"""
    assets, starts, at = {}, {}, 0
    for name, media, frames, effects in segments:
        if media not in assets:
            assets[media] = d.import_media(t.media(media))
        clip = d.place_clip(assets[media], track, at, 0, frames)
        for e, amount, params, color in effects:
            d.apply_effect(clip, e, amount=amount, params=params, color=color)
        starts[name] = at / FPS
        at += frames
    return starts, at


GROUP = 12  # segments per export (a timeline of many clips exports far slower than a few of fewer)


def clear(d):
    """Removes every clip, so the next group starts on an empty timeline."""
    for tr in d.get_state().get("tracks", []):
        for c in tr.get("clips", []):
            d.remove_clip(c["id"])


def export_groups(d, t, segments, tag):
    """Builds and exports the segments a group at a time. -> {name: (export path, start s, export job or None)}:
    the job is None when the export finished."""
    where = {}
    for i in range(0, len(segments), GROUP):
        clear(d)
        starts, _ = build(d, t, segments[i:i + GROUP])
        out = t.path("out", f"{tag}{i // GROUP}.mp4")
        job = d.export(out)
        for name, s in starts.items():
            where[name] = (out, s, None if job.get("status") == "done" else job)
    return where


def run(t):
    d = t.driver()
    d.set_project(width=W, height=H, fps=FPS)
    where = export_groups(d, t, SEGMENTS, "looks")

    def at(name, local_t):
        """(the export that holds segment `name`, the time of `local_t` s into it); Unmeasurable without that export."""
        out, s, failed = where[name]
        if failed:
            raise observe.Unmeasurable(f"no export of its group: {failed}")
        return out, s + local_t

    def m(name, fn, accept, want):
        return t.measure(name, fn, accept, want)

    def blk(name, local_t, x, y, size=8):
        return observe.block_rgb(*at(name, local_t), x, y, size)

    def media_blk(media, local_t, x, y, size=8):
        return observe.block_rgb(t.media(media), local_t, x, y, size)

    # exposure
    m("exposure +1 EV doubles the mean luma (x2 +-0.12)", lambda: luma(blk("exp+1", 0.5, 100, 80)) / luma(
        blk("exp-none", 0.5, 100, 80)), lambda v: abs(v - 2) <= 0.12, "x2 +- 0.12")
    m("exposure -1 EV halves it (x0.5 +-0.08)", lambda: luma(blk("exp-1", 0.5, 100, 80)) / luma(
        blk("exp-none", 0.5, 100, 80)), lambda v: abs(v - 0.5) <= 0.08, "x0.5 +- 0.08")
    m("exposure clips at white: +3 EV, and 9 (clamped to +3)", lambda: (luma(blk("exp+3", 0.5, 100, 80)),
                                                                      luma(blk("exp9", 0.5, 100, 80))),
      lambda v: min(v) >= 250, ">= 250 both")
    m("exposure black level 0.1 on grey 128 gives about 114 (+-6)", lambda: luma(blk("lift", 0.5, 100, 80)),
      lambda v: abs(v - 114) <= 6, "114 +- 6")
    # vibrance
    def vib():
        d0, s0 = media_blk("fx-pair.mp4", 0.5, 60, 80), media_blk("fx-pair.mp4", 0.5, 220, 80)
        d1, s1 = blk("vib+1", 0.5, 60, 80), blk("vib+1", 0.5, 220, 80)
        return hsv_sat(d1) / hsv_sat(d0), hsv_sat(s1) / hsv_sat(s0)
    m("vibrance +1 raises a dull colour's saturation more than a saturated one's", vib,
      lambda v: v[0] > 1.3 and v[1] >= 1 and v[0] > v[1] + 0.2, "dull gain > 1.3, saturated >= 1, dull > saturated + 0.2")
    m("vibrance -1 mutes the dull colour (below half its saturation)",
      lambda: (hsv_sat(blk("vib-1", 0.5, 60, 80)), hsv_sat(media_blk("fx-pair.mp4", 0.5, 60, 80))),
      lambda v: v[0] < v[1] * 0.5, "< half the source's")
    # invert
    m("invert flips 0x2060C0 to about 0xDF9F3F (+-6 each)", lambda: blk("inv", 0.5, 100, 80),
      lambda c: abs(c[0] - 0xDF) <= 6 and abs(c[1] - 0x9F) <= 6 and abs(c[2] - 0x3F) <= 6, "(223,159,63) +- 6")
    # colorhold
    m("colorhold keeps the held red", lambda: blk("hold", 0.5, 60, 80), lambda c: c[0] > 180 and c[0] - c[1] > 120,
      "red > 180, red - green > 120")
    m("colorhold turns the rest grey (channel spread <= 16)", lambda: blk("hold", 0.5, 220, 80),
      lambda c: max(c) - min(c) <= 16, "spread <= 16")
    m("colorhold given its colour as #e02020 (not 0xE02020) holds the same red and turns the blue grey",
      lambda: (blk("hold#", 0.5, 60, 80), blk("hold#", 0.5, 220, 80)),
      lambda v: v[0][0] > 180 and v[0][0] - v[0][1] > 120 and max(v[1]) - min(v[1]) <= 16,
      "left: red > 180, red - green > 120; right: spread <= 16")
    # grain
    def series(name):
        return list(observe.pixels(*at(name, 0), "crop=2:2:100:80,scale=1:1:flags=area", "gray", 20))
    m("grain raises the temporal variance of a block, more with more amount",
      lambda: (sd(series("g0")), sd(series("g40")), sd(series("g80"))),
      lambda v: v[0] < 0.8 and v[1] > 2 and v[2] > v[1], "none < 0.8, 40 > 2, 80 > 40")
    m("grain is also spatial noise within one frame", lambda: sd(list(observe.pixels(
        *at("g40", 0.5), "crop=64:64:100:60", "gray"))), lambda v: v > 3, "sigma > 3")
    # glow
    m("glow brightens the area around a bright shape", lambda: (luma(blk("box", 0.5, 112, 86, 4)),
                                                                luma(blk("glow", 0.5, 112, 86, 4))),
      lambda v: v[1] > v[0] + 15, "+15 beside the box")
    m("glow brightens beside the shape more than far from it", lambda: (luma(blk("glow", 0.5, 112, 86, 4)),
                                                                         luma(blk("glow", 0.5, 4, 4, 4))),
      lambda v: v[0] > v[1] + 10, "+10")
    # rgbsplit
    m("without RGB split the box's edge is neutral", lambda: blk("box", 0.5, 130, 86, 4),
      lambda c: abs(c[0] - c[2]) < 10, "|red - blue| < 10")
    m("RGB split (angle 0) pushes red and blue apart at the box's left and right edges",
      lambda: (blk("rgb0", 0.5, 130, 86, 4), blk("rgb0", 0.5, 182, 86, 4)),
      lambda v: abs(v[0][0] - v[0][2]) > 100 and abs(v[1][0] - v[1][2]) > 100 and
      (v[0][0] - v[0][2] > 0) != (v[1][0] - v[1][2] > 0), "|red - blue| > 100 at both, opposite signs")
    m("RGB split angle 90 splits vertically (the top edge, not the side)",
      lambda: (blk("rgb90", 0.5, 150, 65, 4), blk("rgb90", 0.5, 130, 86, 4)),
      lambda v: abs(v[0][0] - v[0][2]) > 100 and abs(v[1][0] - v[1][2]) < 40, "top > 100, side < 40")
    # lens
    def row(name, x):
        col = list(observe.pixels(*at(name, 0.5), f"crop=1:180:{x}:0", "gray"))
        return col.index(max(col))
    m("a straight line stays straight without lens", lambda: (row("flat", 160), row("flat", 20)),
      lambda v: abs(v[0] - v[1]) <= 1, "rows within 1")
    m("lens -0.4 bends the line (its rows in the middle and near the edge differ by 4 or more)",
      lambda: (row("lens-", 160), row("lens-", 40)), lambda v: abs(v[0] - v[1]) >= 4, ">= 4 rows")
    m("lens k1 > 0 is barrel (the ends pulled toward the middle), k1 < 0 pincushion (pushed out)",
      lambda: (row("lens-", 160), row("lens-", 40), row("lens+", 160), row("lens+", 40)),
      lambda v: v[1] < v[0] and v[3] > v[2], "negative: edge row < middle row; positive: edge row > middle row")
    m("the opposite sign bends the line the other way",
      lambda: (row("lens+", 160), row("lens+", 40), row("lens-", 160), row("lens-", 40)),
      lambda v: abs(v[0] - v[1]) >= 4 and (v[1] - v[0] > 0) != (v[3] - v[2] > 0), ">= 4 rows, the other way")
    # trails
    m("trails leave a ghost of the moving box behind it", lambda: (luma(blk("mover", 1.0, 94, 88, 4)),
                                                                   luma(blk("tr95", 1.0, 94, 88, 4))),
      lambda v: v[0] < 10 and v[1] > v[0] + 40, "plain < 10, ghost +40")
    m("a higher decay leaves a longer trail", lambda: (luma(blk("tr95", 1.0, 94, 88, 4)),
                                                       luma(blk("tr80", 1.0, 94, 88, 4))),
      lambda v: v[0] > v[1], "0.95 > 0.8")
    # exposure with a black point at the white point
    m("exposure EV 2 with black 0.25 still brightens left to right (not blanked or inverted)",
      lambda: (luma(blk("ramp", 0.5, 10, 80)), luma(blk("ramp", 0.5, 300, 80))), lambda v: v[0] < v[1], "left < right")
    # lens zoom to fill: no pixel of a flat grey picture left empty or partly empty (darker than the grey without
    # the warp: the black canvas shows through it)
    m(f"lens (zoom to fill, the default) leaves no pixel empty or partly empty for any k1 and k2 ({len(LENS_GRID)} "
      f"settings, 16:9): none more than {UNFILLED} below the grey without the lens",
      lambda: unfilled({f"{k1},{k2}": at(f"lens{k1},{k2}", 1 / FPS) for k1, k2 in LENS_GRID}, at("g0", 1 / FPS)),
      filled, "no setting with such a pixel; the grey's luma >= 100")
    m("lens fill 0 leaves the corners the warp uncovers empty",
      lambda: [observe.block_rgb(*at("fill0", 1 / FPS), x, y, 2) for x, y in ((0, 0), (318, 0), (0, 178), (318, 178))],
      lambda v: all(luma(c) < 40 for c in v), "dark corners")
    # key, then glow / trails / rgbsplit: the key's colour must not tint the subject
    inside = [123, 130, 150, 170, 177]

    def greenest(name, xs):
        raw = observe.pixels(*at(name, 21 / FPS), "crop=320:1:0:90")
        return max(raw[x * 3 + 1] - max(raw[x * 3], raw[x * 3 + 2]) for x in xs)
    for e in ("glow", "rgbsplit"):
        m(f"a keyed clip with {e}: no green tint inside the subject", lambda e=e: (greenest(f"key+{e}", inside),
                                                                                   greenest("keyed", inside)),
          lambda v: v[0] <= v[1] + 12, "<= the key alone + 12")
    portrait(t, d)


def portrait(t, d):
    """The lens zoom to fill on a 9:16 canvas (ctrl: the grey without the lens)."""
    clear(d)
    d.set_project(width=180, height=320, fps=FPS)
    lens = [(f"lens{k1},{k2}", "fx-gray128p.mp4", 3, [("lens", k1, {"k2": k2}, None)]) for k1, k2 in LENS_GRID]
    segs = [("ctrl", "fx-gray128p.mp4", 3, [])] + lens
    where = export_groups(d, t, segs, "portrait")

    def frame(k):
        path, s, failed = where[k]
        if failed:
            raise observe.Unmeasurable(f"no export of its group: {failed}")
        return path, s + 1 / FPS

    def empties():
        return unfilled({k: frame(k) for k in where if k != "ctrl"}, frame("ctrl"))
    t.measure(f"lens (zoom to fill) leaves no pixel empty or partly empty for any k1 and k2 ({len(LENS_GRID)} "
              f"settings, 9:16): none more than {UNFILLED} below the grey without the lens", empties, filled,
              "no setting with such a pixel; the grey's luma >= 100")
