"""The editor's visual effects: what apply_effect accepts, clamps and refuses, the colour a key or hold effect keeps
(get_state's colour read as a hex colour, red first: a colour given as #rrggbb or 0xRRGGBB must come back as that
colour, observe.hex_colour), the bypass and the order of a clip's effects (what get_state reports), and on exports
that every effect renders, keeps a smaller clip's letterbox transparent (the track below shows there) at its defaults
and at the ends of its ranges, and that the vignette's amount darkens the corners in steps. Port of sections 4, 5, 6
and 8 of packages/core/scripts/smoke-registry.ts (judge/PORTING.md has the map of its sections; its looks, section 9,
are tests/test_effect_looks.py).

The effects are the product's vocabulary (PROTOCOL.md, "Effects"), with the ranges the editor documents: EFFECTS
below. The letterbox: the canvas is 320x180, fx-bars.mp4 is 240x180 (4:3) on the upper track v1, so the editor fits
it with 40 pixels of empty canvas on each side, where the track below shows. Each effect variant is a clip of its own
on v1 (a segment of the timeline), an export holds 14 of them (a timeline of many clips exports far slower), and each
group is exported twice, over two flat colours on v0 (fx-base.mp4, 0xE020E0, and fx-base2.mp4, 0x20C840). The share
of the two colours' difference that a place changes by between the two exports is how much of the track below shows
there: all of it in a transparent bar, none in an opaque picture, whatever colours the effect gives the picture (the
original reads the alpha of its RGBA output instead). It is read in the bars (small samples, as the original's), in
the bars' columns right beside the picture and in the picture's own edge columns (where an effect that softens the
clip's transparency leaves a fringe: each such column's mean over rows 10..169, against the control's within
EDGE_TOL), and in the picture's middle. A control segment without an effect shows both. A key effect (chromakey,
colorkey, lumakey) may make the picture transparent too, so only its bars and the columns beside the picture are
checked; a blur, a mosaic and a lens warp spread the picture's edge, so only the far edges of their bars are checked,
and only at their defaults (as the original).

Every check is recorded on every path (a check whose input is missing fails with the reason), so CHECKS is exact.
"""
import os

import driver as drv
import observe

PORT_BOUND = True
TIMEOUT = 1500

# The effects and their ranges: (low, high) of the amount, and of each param. A key may make the picture transparent.
EFFECTS = {
    "blur": {"amount": (0, 100)}, "sharpen": {"amount": (0, 5)}, "detail": {"amount": (0, 1)},
    "denoise": {"amount": (0, 30)}, "sepia": {}, "grayscale": {}, "vignette": {"amount": (0, 2.5)}, "edges": {},
    "posterize": {"amount": (2, 32)}, "pixelate": {"amount": (2, 100)},
    "chromakey": {"params": {"similarity": (0.01, 1), "blend": (0, 1), "despill": (0, 1)}, "key": True},
    "colorkey": {"params": {"similarity": (0.01, 1), "blend": (0, 1)}, "key": True},
    "lumakey": {"params": {"threshold": (0, 1), "tolerance": (0, 1), "softness": (0, 1)}, "key": True},
    "exposure": {"amount": (-3, 3), "params": {"black": (-1, 1)}}, "vibrance": {"amount": (-2, 2)}, "invert": {},
    "colorhold": {"params": {"similarity": (0.01, 1), "blend": (0, 1)}}, "grain": {"amount": (0, 100)},
    "glow": {"amount": (0, 1), "params": {"radius": (1, 100)}}, "rgbsplit": {"amount": (0, 50), "params": {"angle": (0, 360)}},
    "lens": {"amount": (-1, 1), "params": {"k2": (-1, 1), "fill": (0, 1)}}, "trails": {"amount": (0.8, 0.99)},
}
SPATIAL = ("blur", "pixelate", "lens")  # they spread the picture's edge: far bar edges, defaults only
EDGES = [e for e in EFFECTS if (EFFECTS[e].get("amount") or EFFECTS[e].get("params")) and e not in SPATIAL]
VARIANTS = [(e, "defaults") for e in EFFECTS] + [(e, end) for e in EDGES for end in ("low", "high")]

CHECKS = 1 + 26 + 1 + 2 + len(VARIANTS) + 3   # the track, the rules, the stack, the letterbox, the vignette

W, H, FPS = 320, 180, 30
SEG = 8          # frames per segment of the letterbox timeline
BARS = [2, 20, 34, 284, 298, 316]   # x of 2x2 samples in the bars, rows 80..81 (the picture is x 40..279)
FAR = [2, 316]
NEAR = [38, 39, 280, 281, 282]      # the bars' columns right beside the picture (a blurred alpha leaks there)
EDGE = [40, 279]                    # the picture's own edge columns
BAND = (10, 160)                    # rows y 10..169: a column is measured as its mean over them (rows 80..81 are 70, 71)
# How far a column beside or at the picture's edge may read from the control's (the share of the track below). On
# v0.2.0's and this tree's exports with FFmpeg 9.0.2-17 and 4.4, every variant the column is checked for reads within
# 0.021 of the control at the edge columns and within 0.008 beside them; the control reads 1.004 beside the picture
# and 0.007 or less at its edge. An edge softened by a pixel (the outermost column 20 % see-through, a fringe 20 %
# opaque one pixel out and 5 % two out), put into those exports and encoded again as yuv420p, reads 0.078 to 0.107 at
# the edge columns and 0.864 to 0.904 beside them with either FFmpeg (the chroma, shared by two columns, halves the
# shift).
EDGE_TOL = 0.045
PICTURE_TOL = 0.015  # the picture's middle: every variant and the control read within 0.004 of 0 there


def clear(d):
    """Removes every clip, so a part starts on an empty timeline (the tracks stay)."""
    for tr in d.get_state().get("tracks", []):
        for c in tr.get("clips", []):
            d.remove_clip(c["id"])


def effects_of(d, clip):
    for tr in d.get_state().get("tracks", []):
        for c in tr.get("clips", []):
            if c.get("id") == clip:
                return c.get("effects")
    return None


def run(t):
    d = t.driver()
    d.set_project(width=W, height=H, fps=FPS)
    upper = d.add_track("video")
    t.check("a second video track is added (add_track) and get_state lists it",
            [tr.get("track") for tr in d.get_state().get("tracks", [])][:2] == ["v0", upper] and upper == "v1",
            f"add_track -> {upper!r}")
    rules(t, d)
    letterbox(t, d, upper)
    vignette(t, d)


# ---------------------------------------------------------------- section 4: what apply_effect accepts
def rules(t, d):
    bars = d.import_media(t.media("fx-bars.mp4"))
    c = d.place_clip(bars, "v0", 0, 0, 60)
    check = t.check

    def fx():
        return effects_of(d, c) or []

    def refused(label, **kw):
        r, what = drv.refused(lambda: d.apply_effect(c, **kw))
        check(f"apply_effect refuses {label}", r, what)
    big = d.apply_effect(c, "blur", amount=500)
    check("blur amount 500 is clamped to the top of its range, 100 (get_state)",
          [(e.get("effect"), e.get("amount")) for e in fx()] == [("blur", 100)], fx())
    refused("an unknown param of chromakey (similarty)", effect="chromakey", params={"similarty": 0.2})
    refused("an amount for grayscale (it has none)", effect="grayscale", amount=1)
    refused("a colour for blur (it takes none)", effect="blur", color="0x00FF00")
    refused("params.amount for blur (amount is not a param)", effect="blur", params={"amount": 3})
    refused("a CSS colour rgb(0,255,0) for colorkey", effect="colorkey", color="rgb(0,255,0)")
    refused("a hex colour for lumakey (its colour can only be auto)", effect="lumakey", color="0x000000")
    refused("an effect the editor does not have (bogus)", effect="bogus")
    check("the refused calls changed nothing: the clip has its one effect, blur 100",
          [(e.get("effect"), e.get("amount")) for e in fx()] == [("blur", 100)], fx())
    ck = d.apply_effect(c, "colorkey", color="#80ff80", params={"similarity": 0.3})
    set_ck = next((e for e in fx() if e.get("id") == ck), {})
    d.apply_effect(c, "colorkey", effect_id=ck, enabled=False)
    off = next((e for e in fx() if e.get("id") == ck), {})
    check("{effect_id, enabled: false} bypasses the effect and keeps its colour (#80ff80, read as 0x80FF80) and params",
          off.get("enabled") is False and observe.hex_colour(set_ck.get("color")) == 0x80FF80
          and observe.hex_colour(off.get("color")) == 0x80FF80
          and (off.get("params") or {}).get("similarity") == 0.3, f"before {set_ck}; after {off}")
    d.apply_effect(c, "colorkey", effect_id=ck, enabled=True)
    on = next((e for e in fx() if e.get("id") == ck), {})
    check("enabled: true switches it on again, its values kept",
          on.get("enabled") is True and observe.hex_colour(on.get("color")) == 0x80FF80
          and (on.get("params") or {}).get("similarity") == 0.3, on)
    d.apply_effect(c, "colorkey", effect_id=ck, enabled=False)
    d.apply_effect(c, "colorkey", effect_id=ck, color="0x2060C0", params={"similarity": 0.1})
    upd = next((e for e in fx() if e.get("id") == ck), {})
    check("changing a bypassed effect's values (colour 0x2060C0, similarity 0.1) keeps it bypassed, with those values",
          upd.get("enabled") is False and observe.hex_colour(upd.get("color")) == 0x2060C0
          and (upd.get("params") or {}).get("similarity") == 0.1, upd)
    count = len(fx())
    r1, w1 = drv.refused(lambda: d.apply_effect(c, "blur", effect_id="fx_stale", enabled=False))
    r2, w2 = drv.refused(lambda: d.apply_effect(c, "colorkey", color="auto", effect_id="fx_stale"))
    check("an effect_id the clip does not have is refused (also with colour auto), and adds nothing",
          r1 and r2 and len(fx()) == count, f"{w1}; {w2}; {len(fx())} effects")
    added = d.apply_effect(c, "invert")
    check("without effect_id the effect is added at the end", len(fx()) == count + 1 and fx()[-1].get("id") == added
          and fx()[-1].get("effect") == "invert", fx())
    d.remove_effect(c, added)
    check("remove_effect removes it", all(e.get("id") != added for e in fx()) and len(fx()) == count, fx())
    lens = d.apply_effect(c, "lens", amount=5, params={"k2": -9})
    e = next((x for x in fx() if x.get("id") == lens), {})
    check("lens amount 5 and k2 -9 are clamped to 1 and -1", e.get("amount") == 1 and (e.get("params") or {}).get(
        "k2") == -1, e)
    exp = d.apply_effect(c, "exposure", amount=1, params={"black": 0.1})
    e = next((x for x in fx() if x.get("id") == exp), {})
    check("exposure amount 1 and black 0.1 (in range) are kept", e.get("amount") == 1 and (e.get("params") or {}).get(
        "black") == 0.1, e)
    exp2 = d.apply_effect(c, "exposure", amount=2, params={"black": 0.5})
    e = next((x for x in fx() if x.get("id") == exp2), {})
    black = (e.get("params") or {}).get("black")
    check("exposure EV 2 with black 0.5 keeps the black point below the white point (black < 2^-2 = 0.25)",
          isinstance(black, (int, float)) and black < 0.25, e)
    r1, w1 = drv.refused(lambda: d.apply_effect(c, "colorhold", color="auto"))
    r2, w2 = drv.refused(lambda: d.apply_effect(c, "colorhold", color="nope"))
    check("colorhold refuses colour auto and a colour it cannot read (nope)", r1 and r2, f"{w1}; {w2}")
    hold = d.apply_effect(c, "colorhold", color="#e02020", params={"similarity": 0.4})
    e = next((x for x in fx() if x.get("id") == hold), {})
    check("colorhold takes a hex colour (#e02020) and its params, and get_state shows that colour (0xE02020, red "
          "first)", e.get("effect") == "colorhold" and observe.hex_colour(e.get("color")) == 0xE02020
          and (e.get("params") or {}).get("similarity") == 0.4, e)
    r, w = drv.refused(lambda: d.apply_effect(c, "grain", color="0xFF0000"))
    check("a colour for grain (it takes none) is refused", r, w)
    for x in (lens, exp, exp2, hold):
        d.remove_effect(c, x)
    third = d.apply_effect(c, "sepia")
    order = (lambda: [x.get("effect") for x in fx()])
    check("the clip's effects are blur, colorkey, sepia", order() == ["blur", "colorkey", "sepia"], order())
    d.reorder_effect(c, third, 0)
    check("reorder_effect moves sepia to the top", order() == ["sepia", "blur", "colorkey"], order())
    d.undo()
    check("one undo puts the previous order back", order() == ["blur", "colorkey", "sepia"], order())
    d.reorder_effect(c, big, 99)
    check("a position past the end puts the effect last", order() == ["colorkey", "sepia", "blur"], order())
    r, w = drv.refused(lambda: d.reorder_effect(c, "fx_nope", 0))
    check("reorder_effect of an effect the clip does not have is refused", r, w)
    stack(t, d, bars)


# ---------------------------------------------------------------- section 5: every effect on one clip
def stack(t, d, bars):
    clear(d)
    c = d.place_clip(bars, "v0", 0, 0, 60)
    for e in EFFECTS:
        d.apply_effect(c, e, enabled=False if e == "pixelate" else None)
    names = [x.get("effect") for x in effects_of(d, c) or []]
    out = t.path("out", "stack.mp4")
    job = d.export(out)
    dec, why = None, job.get("status")
    if job.get("status") == "done":
        try:
            dec = observe.decode(out)
            why = {k: dec[k] for k in ("exit", "video_frames", "clean", "stderr")}
        except observe.Unmeasurable as ex:
            why = f"unmeasurable: {ex}"
    t.check("every effect stacked on one clip (pixelate bypassed) renders: the export decodes clean, 60 frames",
            dec is not None and names == list(EFFECTS) and dec["clean"] and abs(dec["video_frames"] - 60) <= 1,
            f"effects {names}; {why}")


# ---------------------------------------------------------------- sections 5 and 8: the letterbox stays transparent
def variant_args(e, end):
    spec = EFFECTS[e]
    if end == "defaults":
        return {}
    i = 0 if end == "low" else 1
    out = {}
    if spec.get("amount"):
        out["amount"] = spec["amount"][i]
    if spec.get("params"):
        out["params"] = {k: v[i] for k, v in spec["params"].items()}
    return out


def band(out, ts):
    """Rows BAND of the export at ts as rgb24 bytes (BAND[1] rows of W pixels)."""
    raw = observe.pixels(out, ts, f"crop={W}:{BAND[1]}:0:{BAND[0]}")
    if len(raw) < W * BAND[1] * 3:
        raise observe.Unmeasurable(f"a short frame at {ts}s")
    return raw


def mean_at(raw, xs, rows=(80 - BAND[0], 81 - BAND[0])):
    """The mean (r, g, b) of the pixels at columns `xs` of `rows` of the band (y 80 and 81 unless said)."""
    px = [raw[(y * W + x) * 3:(y * W + x) * 3 + 3] for y in rows for x in xs]
    return [sum(p[k] for p in px) / len(px) for k in range(3)]


def shows_base(a, b):
    """How much of the track below shows at a place, from its colour over base A (a) and over base B (b): the part of
    the difference between the two bases that the difference a - b holds (0: none, the picture is opaque; 1: all,
    transparent). Whatever the picture's own colour, only the base's share changes between the two exports."""
    da = [x - y for x, y in zip(BASE_A, BASE_B)]
    return sum((x - y) * z for x, y, z in zip(a, b, da)) / sum(z * z for z in da)


BASE_A, BASE_B = (224, 32, 224), (32, 200, 64)   # fx-base.mp4 and fx-base2.mp4 as the export shows them (about)
PICTURE = list(range(60, 260))   # the middle of the picture (it covers x 40..279)
GROUP = 14  # segments per export (a timeline of many clips exports far slower than a few of fewer)


def letterbox(t, d, upper):
    """Every variant is a clip on v1 over a flat colour on v0, exported twice: over fx-base.mp4 and over fx-base2.mp4.
    A place where the clip is transparent changes colour between the two exports by the difference of the bases; where
    it is opaque it does not change (shows_base)."""
    clear(d)
    bases = [d.import_media(t.media("fx-base.mp4")), d.import_media(t.media("fx-base2.mp4"))]
    bars = d.import_media(t.media("fx-bars.mp4"))
    segs = [(None, None)] + VARIANTS
    placed, where, decoded = [], [], []  # per segment: why its effect was refused, and (exports, time); per export
    for g in range(0, len(segs), GROUP):
        clear(d)
        group = segs[g:g + GROUP]
        for i, (e, end) in enumerate(group):
            clip = d.place_clip(bars, upper, i * SEG, 0, SEG)
            why = None
            if e:
                try:
                    d.apply_effect(clip, e, **variant_args(e, end))
                except drv.JudgeError as ex:
                    why = str(ex)[:200]
            placed.append(why)
        outs = []
        for k, base in enumerate(bases):
            under = d.place_clip(base, "v0", 0, 0, SEG * len(group))
            out = t.path("out", f"letterbox{g // GROUP}-{k}.mp4")
            job = d.export(out)
            d.remove_clip(under)
            ok, dec = job.get("status") == "done", None
            if ok:
                try:
                    dec = observe.decode(out)
                except observe.Unmeasurable as ex:
                    job = {"status": f"unmeasurable: {ex}"}
            decoded.append((len(group), job.get("status"), dec))
            outs.append(out if ok else None)
        where += [(outs, (i * SEG + SEG // 2) / FPS) for i in range(len(group))]
    t.check(f"the exports with a clip for every effect at its defaults and at the ends of its ranges ({len(VARIANTS)}, "
            f"{GROUP} to an export, over two colours) decode clean",
            all(dec is not None and dec["clean"] and abs(dec["video_frames"] - n * SEG) <= 1 for n, _, dec in decoded),
            [(st, dec and {k: dec[k] for k in ("exit", "video_frames", "clean", "stderr")}) for _, st, dec in decoded])

    rows = range(BAND[1])

    def measure(i, xs, cols):
        """({x: how much of the base shows in the bar's 2x2 sample at x}, {x: how much shows in the column x (its mean
        over BAND)}, how much shows in the picture's middle)."""
        outs, ts = where[i]
        if None in outs:
            raise observe.Unmeasurable("no export of its group")
        a, b = band(outs[0], ts), band(outs[1], ts)
        bars_ = {x: round(shows_base(mean_at(a, [x, x + 1]), mean_at(b, [x, x + 1])), 3) for x in xs}
        cols_ = {x: round(shows_base(mean_at(a, [x], rows), mean_at(b, [x], rows)), 3) for x in cols}
        return bars_, cols_, round(shows_base(mean_at(a, PICTURE, rows), mean_at(b, PICTURE, rows)), 3)
    try:
        cb, cc, cp = measure(0, BARS, NEAR + EDGE)
        ctrl_ok = (all(v >= 0.9 for v in cb.values()) and all(cc[x] >= 0.9 for x in NEAR)
                   and all(cc[x] <= EDGE_TOL for x in EDGE) and abs(cp) <= PICTURE_TOL)
        why = f"bars {cb}; beside the picture {[cc[x] for x in NEAR]}; its edge {[cc[x] for x in EDGE]}; picture {cp}"
    except observe.Unmeasurable as ex:
        ctrl_ok, why = False, f"unmeasurable: {ex}"
    t.check(f"control: without an effect the track below shows fully in the bars and the columns beside the picture "
            f"(90 % or more of the difference of the two colours under it) and not in the picture's edge columns "
            f"({EDGE_TOL:g} or less) or its middle ({PICTURE_TOL:g} or less)", ctrl_ok, why)
    for i, (e, end) in enumerate(segs[1:], 1):
        key = EFFECTS[e].get("key")
        label = (f"{e} ({'at its defaults' if end == 'defaults' else 'every value at the ' + end + ' end'}) keeps the "
                 f"letterbox transparent" + ("" if key else " and the picture opaque"))
        if not ctrl_ok or placed[i]:
            t.check(label, False, placed[i] or "the control failed")
            continue
        spatial = e in SPATIAL
        cols = [] if spatial else NEAR + ([] if key else EDGE)
        try:
            got, col, pic = measure(i, FAR if spatial else BARS, cols)
        except observe.Unmeasurable as ex:
            t.check(label, False, f"unmeasurable: {ex}")
            continue
        near = {x: col[x] for x in NEAR if x in col}
        edge = {x: col[x] for x in EDGE if x in col}
        ok = (all(v >= 0.9 for v in got.values())
              and all(v >= 0.9 and v >= cc[x] - EDGE_TOL for x, v in near.items())
              and all(v <= cc[x] + EDGE_TOL for x, v in edge.items())
              and (key or abs(pic) <= PICTURE_TOL))
        low = {x: v for x, v in got.items() if v < 0.9}
        pairs = (lambda cols: ", ".join(f"{x}: {v:g}/{cc[x]:g}" for x, v in cols.items()))
        t.check(label, ok, f"the track below shows: bars {low or f'min {min(got.values()):g}'} (want >= 0.9)"
                + (f"; beside the picture {pairs(near)} (this/control; want >= 0.9 and >= control - {EDGE_TOL:g})"
                   if near else "")
                + (f"; edge columns {pairs(edge)} (want <= control + {EDGE_TOL:g})" if edge else "")
                + ("" if key else f"; middle {pic:g} (want within {PICTURE_TOL:g} of 0)"))


# ---------------------------------------------------------------- section 6: the vignette's amount
def vignette(t, d):
    clear(d)
    white = d.import_media(t.media("fx-white.mp4"))
    seg = 15
    variants = [("none", None), ("0", {"amount": 0}), ("0.5", {"amount": 0.5}), ("1", {"amount": 1}),
                ("2", {"amount": 2}), ("bypassed", {"amount": 2})]
    for i, (name, args) in enumerate(variants):
        clip = d.place_clip(white, "v0", i * seg, 0, seg)
        if args is not None:
            e = d.apply_effect(clip, "vignette", **args)
            if name == "bypassed":
                d.apply_effect(clip, "vignette", effect_id=e, enabled=False)
    out = t.path("out", "vignette.mp4")
    job = d.export(out)
    lum = {}
    why = f"export {job.get('status')}"
    if job.get("status") == "done":
        try:
            for i, (name, _) in enumerate(variants):
                r, g, b = observe.block_rgb(out, (i * seg + seg // 2) / FPS, 8, 8)
                lum[name] = 0.2126 * r + 0.7152 * g + 0.0722 * b
            why = ", ".join(f"{k} {v:.0f}" for k, v in lum.items())
        except observe.Unmeasurable as ex:
            lum, why = {}, f"unmeasurable: {ex}"
    t.check("vignette amount 0 leaves the corner as without a vignette (+-2)",
            bool(lum) and abs(lum["0"] - lum["none"]) <= 2, why)
    t.check("the corner darkens with the amount, in steps of more than 8 (0 > 0.5 > 1 > 2)",
            bool(lum) and lum["0"] - lum["0.5"] > 8 and lum["0.5"] - lum["1"] > 8 and lum["1"] - lum["2"] > 8, why)
    t.check("a bypassed vignette (amount 2) leaves the corner alone (+-2)",
            bool(lum) and abs(lum["bypassed"] - lum["none"]) <= 2, why)
