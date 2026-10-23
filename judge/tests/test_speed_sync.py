"""After a speed change the export stays in sync and seamless: under a picture whose speed or ramp changed, its linked
sound plays the moment the picture shows (every ramp preset, the ripple modes, a ramp set on the sound, a ramp's audio
muted and stretched again), and so does a linked recording of another file, moved by its sync offset; an L-cut tail
goes on from the picture's last moment and never plays over the next sound, which plays its own moment; a J-cut head
with a ramp stays in sync; after a ramp that shortens a clip the next clip's footage fills the old length (no black),
after one that lengthens it the next clip starts where it ends; a hidden track never shows. Port of sections 5 and 7
of packages/core/scripts/smoke-ripple.ts, and the by-ear half of its sections 1 and 3 (the linked sound's curve;
judge/PORTING.md has the map; its other sections are tests/test_speed_ripple.py).

Media: idx.mp4 (180x90 30 fps, 16 s): each frame shows its own index (observe.frame_indexes), and its sound is a chirp
whose pitch says its source moment (observe.chirp_time), whatever the speed (the editor keeps the pitch). chirp.m4a is
the same chirp alone: a recording of another file (a microphone's) that the test links to the picture 1 s later into
its file. fx-white.mp4 (all white: it would read as frame 511) is the hidden title. The canvas is 180x90 at 30 fps.

Sync without a model of the editor. The heard source moment at a timeline moment t is the chirp's pitch at t, and the
offset is the median of seven such measurements 20 ms apart (a ramp's stretched sound is made of short constant-tempo
pieces joined by crossfades, where two pitches overlap). At a constant speed s the picture's source moment at t is the
rule a user can state, in + (t - start) * s (get_state's in_frame and start_frame), and the sound is held to it with
the original's bounds: under the picture max(0.5, s / 2) / 30 s + 10 ms (half a source frame, or half a frame's worth
of source), the L-cut tail 25 ms. Under a ramp the picture's source moment is read from the frames shown around t: each
frame shows the source frame that plays at its middle (test_cuts holds whole clips to that exactly), so the middle of
frame j plays within half a source frame of the middle of the source frame it shows, and a least-squares line through
those seven points (the frames nearest t) gives the moment at t and the local speed s (its slope, in source frames per
frame). At a steady speed that line is within half a source frame of the true moment (17 ms), the most at and near a
whole-number speed, where the frames shown cannot place it closer (at 0.25x to 0.75x and 1.5x: within 0.29 source
frames, 10 ms). Where the picture plays at real time or slower (s at most 1) the offset must be within the original's
bound at real time, 0.5 / 30 s + 10 ms (27 ms): the picture's worst placement there and 10 ms for the sound and its
measurement. Faster, it must be within (max(0.5, s / 2) + 0.5) / 30 s + 12 ms: the original's half a source frame or
half a frame's worth of source, half a frame more for the picture's rounding (frames are skipped, and where the speed
climbs quickly, to the flash presets' 8x, a line through seven frames bends away from the curve) and 12 ms for the
pitch measurement. A J-cut head (a sound clip that starts before its picture) starts on a whole frame, so its sync may
be off by half a frame's worth of source more (the original allows a whole frame there). An L-cut tail is held to the
picture's source out point (get_state) carried on at the speed the change ends with, and the next sound (at 1x) to its
own moment, both within the original's 25 ms: neither depends on the frames shown.

Every check is recorded on every path (a check whose input is missing fails with the reason), so CHECKS is exact.
"""
import statistics

import edits as E
import observe

PORT_BOUND = True
TIMEOUT = 900
FPS = 30
# The speeds each change starts and ends with (the presets' own definitions: bullet and montage start and end at real
# time, flash_in starts at 8x and is at real time from 30 %): the picture's first frame may be up to half a frame's
# worth of source into its range, and past the picture's end the L-cut tail goes on at the end speed.
LCUT_OPS = [("0.5x", {"speed": 0.5}, 0.5, 0.5), ("2x", {"speed": 2}, 2, 2), ("bullet", {"preset": "bullet"}, 1, 1),
            ("montage", {"preset": "montage"}, 1, 1), ("flash_in", {"preset": "flash_in"}, 8, 1)]
# The linked sound's curve, heard on a plain linked pair (A and its sound Aa): each change is made as said, and the
# sound must follow the picture's curve, at MOMENTS moments spread over the parts of the picture given (fractions of
# its length; None: all of it). flash_out is heard here: it ends at 8x, so an L-cut tail would be a few frames.
# jump_cut is heard in its real-time parts (its 8x jump is the middle fifth of the source: the first 48 % and the last
# 48 % of the timeline), away from the jump: around a jump the frames shown cannot say the picture's moment within the
# bound. hero is heard as a J-cut head (jcut_hero).
JUMP_PARTS = [(0.05, 0.40), (0.60, 0.95)]
PAIR_OPS = [
    ("jump_cut", lambda d, A, Aa: d.set_speed_ramp(A, preset="jump_cut"), JUMP_PARTS),
    ("flash_out", lambda d, A, Aa: d.set_speed_ramp(A, preset="flash_out"), None),
    ("montage with ripple none", lambda d, A, Aa: d.set_speed_ramp(A, preset="montage", ripple="none"), None),
    ("bullet with ripple all", lambda d, A, Aa: d.set_speed_ramp(A, preset="bullet", ripple="all"), None),
    ("flash_out set on the sound (the picture takes it)", lambda d, A, Aa: d.set_speed_ramp(Aa, preset="flash_out"),
     None),
    ("montage, its audio set to mute and then to stretch again",
     lambda d, A, Aa: (d.set_speed_ramp(A, preset="montage"), d.set_speed_ramp(A, audio="mute"),
                       d.set_speed_ramp(A, audio="stretch")), None),
]
CHECKS = 5 * len(LCUT_OPS) + 6 + 1 + len(PAIR_OPS) + 1
MOMENTS = 12            # moments under the picture
OFFSETS = [-0.06, -0.04, -0.02, 0, 0.02, 0.04, 0.06]


def reset(d):
    E.clear(d)
    names = [tr["track"] for tr in d.get_state().get("tracks", []) if tr["track"] != "v0"]
    for name in reversed(names):
        d.remove_track(name)
    d.set_markers([])
    d.set_track("v0", muted=False, hidden=False, locked=False)


def picture_time(idx, t, lo, hi):
    """(the picture's source moment in s, the local speed) at timeline moment t (s), from the frames shown in [lo, hi)
    (timeline frames): the least-squares line through the points (j + 1/2, idx[j] + 1/2) of the seven frames j nearest
    t (the middle of frame j plays within half a source frame of the middle of the source frame it shows), at t; the
    local speed is its slope (source frames per frame). None outside [lo, hi)."""
    f = int(t * FPS)
    if not lo <= f < hi:
        return None
    js = range(max(lo, f - 3), min(hi, f + 4))
    xs = [j + 0.5 for j in js]
    ys = [idx[j] + 0.5 for j in js]
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    s = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx if sxx else 1.0
    return (my + s * (t * FPS - mx)) / FPS, s


def off_at(snd, idx, t, lo, hi, want=None, shift=0.0):
    """(heard - expected) source seconds at t: the median over OFFSETS; expected is the picture's moment plus `shift`
    (a recording's sync offset), or want(t). -> (offset or None, the local speed)."""
    diffs, speed = [], 1.0
    for o in OFFSETS:
        h = observe.chirp_time(snd, t + o)
        if want is None:
            p = picture_time(idx, t + o, lo, hi)
            if p is None:
                continue
            exp, speed = p[0] + shift, p[1]
        else:
            exp = want(t + o)
        if h is not None:
            diffs.append(h - exp)
    return (statistics.median(diffs) if diffs else None), speed


def constant_tolerance(speed):
    """The original's bound under a picture at the constant speed `speed`, whose moment is in + (t - start) * speed."""
    return max(0.5, abs(speed) / 2) / FPS + 0.010


def tolerance(speed):
    """The bound under a ramp at the local speed `speed` (the picture's moment read from the frames shown): at real
    time or slower the original's bound at real time (27 ms); faster, half a frame more for the picture's rounding and
    12 ms for the measurement (module docstring)."""
    if abs(speed) <= 1:
        return constant_tolerance(1)
    return (max(0.5, abs(speed) / 2) + 0.5) / FPS + 0.012


TAIL = 0.025   # the original's bound for an L-cut tail (after a constant speed or a ramp) and for the next sound


def head_extra(speed):
    """What a J-cut head may be off by beyond tolerance(speed): half a frame's worth of source, since it starts on a
    whole frame (the original allows a whole frame)."""
    return 0.5 * abs(speed) / FPS


def run(t):
    d = t.driver()
    d.set_project(width=180, height=90, fps=FPS)
    idx = d.import_media(t.media("idx.mp4"))
    title = d.import_media(t.media("fx-white.mp4"))
    rec = d.import_media(t.media("chirp.m4a"))
    for label, op, start_speed, end_speed in LCUT_OPS:
        lcut(t, d, idx, label, op, start_speed, end_speed)
    for i, (label, change, parts) in enumerate(PAIR_OPS):
        pair(t, d, idx, i, label, change, parts)
    recording(t, d, idx, rec)
    exports(t, d, idx, title)
    jcut_hero(t, d, idx)


# ---------------------------------------------------------------- 5. an L-cut tail by ear
def lcut(t, d, idx, label, op, s_start, s_end):
    reset(d)
    a0 = d.add_track("audio")
    A = d.place_clip(idx, "v0", 0, 30, 120)
    B = d.place_clip(idx, "v0", 90, 180, 240)
    Aa = d.place_clip(idx, a0, 0, 30, 150)   # a 30-frame L-cut tail
    Ba = d.place_clip(idx, a0, 120, 210, 240)
    d.set_track("v0", muted=True)            # the pictures' own sound is not heard: the linked clips carry it
    d.link_clips([A, Aa])
    d.link_clips([B, Ba])
    if "speed" in op:
        d.set_speed(A, op["speed"])
    else:
        d.set_speed_ramp(A, preset=op["preset"])
    st = d.get_state()
    a, aa, b, ba = (E.clip(st, x) for x in (A, Aa, B, Ba))
    name = f"an L-cut with {label} on the picture"
    t.check(f"{name}: B starts where A ends and B's sound 30 frames after B (get_state)",
            b["start_frame"] == E.end(a) and ba["start_frame"] - b["start_frame"] == 30 and E.end(aa) <= ba["start_frame"],
            (E.spans(st, "v0"), E.spans(st, a0)))
    out = t.path("out", f"lcut-{label}.mp4")
    job = d.export(out)
    try:
        frames = observe.frame_indexes(out) if job.get("status") == "done" else None
        snd = observe.samples(out) if frames is not None else None
    except observe.Unmeasurable as e:
        frames, snd, job = None, None, {"status": f"unmeasurable: {e}"}
    names = [f"{name}: the picture under A runs forward through A's source range, from its first frame to its last",
             f"{name}: under the picture, the sound plays the moment the picture shows",
             f"{name}: the tail goes on from the picture's last moment",
             f"{name}: A's sound ends before B's sound, which plays its own moment"]
    if frames is None or snd is None:
        for n in names:
            t.check(n, False, f"no export: {job}")
        return
    end_a = E.end(a)
    pic = frames[:end_a]
    probs = [f"{f}: {g}" for f, g in enumerate(pic) if not 30 <= g < 120 or (f and g < pic[f - 1])]
    if "speed" in op:
        probs += E.speed_rule_problems(frames, a)   # a whole clip: exactly the frame playing at each frame's middle
    t.check(names[0], len(pic) == end_a and not probs and pic[0] <= 30 + max(1, s_start / 2) and pic[-1] >= 117,
            f"{len(pic)} frames, first {pic[:3]}, last {pic[-3:]}; {E.short(probs)}")
    if "speed" in op:
        # At a constant speed the picture's moment is the rule's: in + (t - start) * s, held with the original's bound.
        k_s = op["speed"]
        rule = (lambda x: a["in_frame"] / FPS + (x - a["start_frame"] / FPS) * k_s)
        off, summary = under(snd, frames, 0, end_a, want=rule, bound=constant_tolerance(k_s))
    else:
        off, summary = under(snd, frames, 0, end_a)
    t.check(names[1], not off, f"{summary}; {E.short(off)}")
    # The tail: at A's end the picture has played its source range to its end (out_frame); from there the sound goes
    # on at the speed the change ends with.
    t0 = end_a / FPS
    src0 = a["out_frame"] / FPS
    tt = (end_a + min(8, (E.end(aa) - end_a) / 2)) / FPS
    o, _ = off_at(snd, frames, tt, 0, 0, want=lambda x: src0 + (x - t0) * s_end)
    t.check(names[2], o is not None and abs(o) <= TAIL,
            f"at {tt:.3f} s: {'silent' if o is None else f'{o * 1000:+.0f} ms'} (end speed {s_end:.2f}; allowed "
            f"{TAIL * 1000:.0f} ms)")
    tb = (ba["start_frame"] + 10) / FPS
    ob, _ = off_at(snd, frames, tb, 0, 0, want=lambda x: ba["in_frame"] / FPS + (x - ba["start_frame"] / FPS))
    t.check(names[3], E.end(aa) <= ba["start_frame"] and ob is not None and abs(ob) <= TAIL,
            f"A's sound ends at {E.end(aa)}, B's starts at {ba['start_frame']}; B's sound at {tb:.3f} s: "
            f"{'silent' if ob is None else f'{ob * 1000:+.0f} ms'}")


def fractions(parts):
    """MOMENTS fractions of a picture's length: evenly spread over all of it (parts None: k / (MOMENTS + 1)), or over
    the parts [(from, to)] (fractions), the same number in each."""
    if parts is None:
        return [k / (MOMENTS + 1) for k in range(1, MOMENTS + 1)]
    n = MOMENTS // len(parts)
    return [a + (b - a) * k / (n - 1) for a, b in parts for k in range(n)]


def under(snd, frames, lo, hi, want=None, bound=None, shift=0.0, parts=None, extra=None):
    """The moments under the picture [lo, hi) (timeline frames) where the sound is off, and a summary: at MOMENTS
    moments (fractions(parts) of the picture), the offset from want(t) (a rule) within `bound`, or else from the
    picture's moment read from the frames (plus `shift`) within tolerance(the local speed), plus extra(the local speed)
    when given. The summary names the worst offset, the worst where the local speed is 1 or less, and the moment
    closest to its bound."""
    off, worst, slow, close = [], 0.0, None, None
    for x in fractions(parts):
        tm = (lo + (hi - lo) * x) / FPS
        o, s = off_at(snd, frames, tm, lo, hi, want=want, shift=shift)
        b = bound if want is not None else tolerance(s) + (extra(s) if extra else 0)
        what = f"{tm:.3f} s: {E.ms(o)} (" + (f"allowed {b * 1000:.0f} ms)" if want is not None
                                             else f"speed {s:.2f}, allowed {b * 1000:.0f} ms)")
        if o is None or abs(o) > b:
            off.append(what)
        if o is not None:
            worst = max(worst, abs(o))
            if want is None and abs(s) <= 1:
                slow = max(slow or 0.0, abs(o))
            if close is None or abs(o) / b > close[0]:
                close = (abs(o) / b, what)
    at1 = "" if want is not None else ("; at 1x or slower: none" if slow is None else
                                       f"; at 1x or slower: worst {slow * 1000:.0f} ms")
    return off, f"worst {worst * 1000:.0f} ms{at1}; closest to its bound {close[1] if close else None}"


def export_sound(t, d, name):
    """(frame indexes, samples, why) of an export of the timeline; (None, None, why) when it cannot be measured."""
    out = t.path("out", f"{name}.mp4")
    job = d.export(out)
    if job.get("status") != "done":
        return None, None, job
    try:
        return observe.frame_indexes(out), observe.samples(out), None
    except observe.Unmeasurable as e:
        return None, None, str(e)


# ---------------------------------------------------------------- 1, 3. the linked sound's curve by ear
def pair(t, d, idx, i, label, change, parts):
    """A linked pair (A [0,90) shows source 30..120 on v0, muted; its sound Aa the same on a0); `change` is made; under
    the picture (at fractions(parts) of it) the sound must play the moment the picture shows."""
    reset(d)
    a0 = d.add_track("audio")
    A = d.place_clip(idx, "v0", 0, 30, 120)
    Aa = d.place_clip(idx, a0, 0, 30, 120)
    d.set_track("v0", muted=True)
    d.link_clips([A, Aa])
    change(d, A, Aa)
    st = d.get_state()
    a, aa = E.clip(st, A), E.clip(st, Aa)
    frames, snd, why = export_sound(t, d, f"pair-{i}")
    name = f"{label} on a linked picture: under the picture, its sound plays the moment the picture shows"
    if frames is None or snd is None:
        t.check(name, False, f"no export: {why}")
        return
    end_a = E.end(a)
    off, summary = under(snd, frames, a["start_frame"], end_a, parts=parts)
    t.check(name, a["ramp"] and aa["ramp"] and not off,
            f"ramps (picture, sound) {a['ramp']}, {aa['ramp']}; {summary}; {E.short(off)}")


def recording(t, d, idx, rec):
    """A recording of another file (chirp.m4a), linked to the picture A (source 1..91) 1 s later into its file
    (source 31..121), at the same place: after a montage ramp on A, under the picture it plays the picture's moment
    plus its 1 s offset."""
    reset(d)
    a0 = d.add_track("audio")
    A = d.place_clip(idx, "v0", 0, 1, 91)
    R = d.place_clip(rec, a0, 0, 31, 121)
    d.set_track("v0", muted=True)
    d.link_clips([A, R])
    d.set_speed_ramp(A, preset="montage")
    st = d.get_state()
    a, r = E.clip(st, A), E.clip(st, R)
    frames, snd, why = export_sound(t, d, "recording-montage")
    name = ("a linked recording of another file, with montage on the picture: under the picture it plays the picture's "
            "moment moved by its 1 s sync offset")
    if frames is None or snd is None:
        t.check(name, False, f"no export: {why}")
        return
    off, summary = under(snd, frames, a["start_frame"], E.end(a), shift=1.0)
    t.check(name, r["ramp"] and not off, f"recording ramped: {r['ramp']}; {summary}; {E.short(off)}")


# ---------------------------------------------------------------- 7. the export stays seamless
def exports(t, d, idx, title):
    reset(d)
    A = d.place_clip(idx, "v0", 0, 1, 91)
    B = d.place_clip(idx, "v0", 90, 100, 160)
    d.place_clip(idx, "v0", 150, 170, 230)
    a0 = d.add_track("audio")
    Aa = d.place_clip(idx, a0, 0, 1, 91)
    Ba = d.place_clip(idx, a0, 90, 100, 160)
    d.link_clips([A, Aa])
    v1 = d.add_track("video")
    d.place_clip(title, v1, 100, 0, 30)
    d.set_track(v1, hidden=True)  # the title would cover the stripes: hidden, it must never show
    d.set_speed_ramp(A, preset="montage")
    dur = E.clip(d.get_state(), A)["length_frames"]
    got = export_frames(t, d, "montage")
    names = ["montage: A is shorter than 90 frames and the export holds A, B and C (A + 120 frames)",
             "montage: the frames where A used to end (the old length) show B's footage from its first frame",
             "montage: no black frame anywhere, and nothing of the hidden title",
             "montage: C follows B (frame A + 60 shows C's first frame)"]
    if got is None:
        for n in names:
            t.check(n, False, "no export")
    else:
        t.check(names[0], dur < 90 and len(got) == dur + 120, f"A {dur} frames; export {len(got)} frames")
        t.check(names[1], got[dur:90] == list(range(100, 100 + 90 - dur)), got[dur:90])
        t.check(names[2], 0 not in got and 511 not in got, f"black at {[i for i, v in enumerate(got) if v == 0][:10]}; "
                                                            f"title at {[i for i, v in enumerate(got) if v == 511][:10]}")
        t.check(names[3], len(got) > dur + 60 and got[dur + 60] == 170, got[dur + 55:dur + 65])
    d.undo()
    d.set_speed_ramp(A, preset="bullet")
    st = d.get_state()
    dur2 = E.clip(st, A)["length_frames"]
    t.check("bullet: A is longer than 90 frames and B and its sound start where A ends (no overlap)",
            dur2 > 90 and E.clip(st, B)["start_frame"] == dur2 and E.clip(st, Ba)["start_frame"] == dur2,
            (E.spans(st, "v0"), E.spans(st, a0)))
    got = export_frames(t, d, "bullet")
    t.check("bullet: the export plays A to its end, then B from its first frame to its last",
            got is not None and len(got) == dur2 + 120 and got[dur2 - 1] >= 88 and got[dur2] == 100
            and got[dur2 + 59] == 159,
            f"{len(got) if got else 0} frames (want {dur2 + 120}); around A's end {got[dur2 - 3:dur2 + 3] if got else []}"
            f"; B's last {got[dur2 + 59] if got and len(got) > dur2 + 59 else None}")


def export_frames(t, d, name):
    out = t.path("out", f"seamless-{name}.mp4")
    job = d.export(out)
    if job.get("status") != "done":
        return None
    try:
        return observe.frame_indexes(out)
    except observe.Unmeasurable:
        return None


# ---------------------------------------------------------------- 3c. a J-cut head with a ramp, by ear
def jcut_hero(t, d, idx):
    reset(d)
    a0 = d.add_track("audio")
    A = d.place_clip(idx, "v0", 10, 11, 91)   # A [10,90) shows source 11..90
    head = d.place_clip(idx, a0, 0, 1, 91)    # its sound [0,90) plays source 1..90: it starts 10 frames early
    d.set_track("v0", muted=True)
    d.link_clips([A, head])
    d.set_speed_ramp(A, preset="hero")
    st = d.get_state()
    a = E.clip(st, A)
    out = t.path("out", "jcut-hero.mp4")
    job = d.export(out)
    off, summary = [], ""
    try:
        frames = observe.frame_indexes(out) if job.get("status") == "done" else None
        snd = observe.samples(out) if frames is not None else None
    except observe.Unmeasurable as e:
        frames, snd, off = None, None, [str(e)]
    if frames is not None and snd is not None:
        off, summary = under(snd, frames, a["start_frame"], E.end(a), extra=head_extra)
    t.check("a J-cut with the hero ramp: under the picture, its sound head plays the moment the picture shows",
            frames is not None and snd is not None and not off, f"{summary}; {E.short(off)}; "
                                                                 f"{job if frames is None else ''}")
