"""A speed change ripples the timeline: set_speed, set_speed_ramp (every preset), clear_speed_ramp and clear_effects
move the clips after the changed clip by exactly its change in length, its linked sound follows with the same speed
or curve, and the ripple modes (track, all, none), the linked partners, the J-cut heads and L-cut tails, and the
clips that hold their place (a clip straddling the old end, one entering it through a transition, one butted to it)
behave as the user is told; a ripple that would break the edit is refused and changes nothing. Judged on get_state
(and by ear for a ramp's muted sound; the linked sound's curve itself is heard in tests/test_speed_sync.py). Port of
sections 1 to 4 and 6 of packages/core/scripts/smoke-ripple.ts (judge/PORTING.md has the map of its sections; its
sections 5 and 7, judged on exports, are tests/test_speed_sync.py).

Media: idx.mp4 (180x90 30 fps, 16 s, frames that show their index, and a chirp), tone300.m4a (another recording, the
"mic"), m.mp3 (a music bed), fx-white.mp4 (a title). The canvas is 180x90 at 30 fps.

The main layout (build): v0 A [0,90) source 1..91 | B [90,150) 100..160 | C [150,210) 170..230 (variants: a 20-frame
gap before C; a 15-frame dissolve from A into B); a0 A's sound Aa [0,90), linked to A, then B's and C's sounds (not
linked); a1 the music [0,120) (it straddles A's end); v1 the title at 100; markers at 30 and 120. v0 is muted: A's
own sound is not heard, its linked clip carries it. Every case is one edit and one undo: who moved and by how much is
read from get_state before and after (delta = A's new length - its old length), never from the edit's answer.

Every check is recorded on every path (a check whose input is missing fails with the reason), so CHECKS is exact.
"""
import edits as E
import observe

PORT_BOUND = True
TIMEOUT = 900
FPS = 30
PRESETS = ["montage", "hero", "bullet", "jump_cut", "flash_in", "flash_out"]
CASES = 2 + len(PRESETS) + 1 + 1 + 1 + 6 + 2 + 2   # butted (17), gap (2), dissolve (2)
CHECKS = CASES * 6 + 1 + 2 + 2 + 3 + 9 + 31 + 2 + 1


class Media:
    pass


def reset(d):
    """An empty timeline: no clip, only v0 (unmuted, shown, unlocked), no marker."""
    E.clear(d)
    names = [tr["track"] for tr in d.get_state().get("tracks", []) if tr["track"] != "v0"]
    for name in reversed(names):
        d.remove_track(name)
    d.set_markers([])
    d.set_track("v0", muted=False, hidden=False, locked=False)


def build(d, m, variant):
    reset(d)
    ids = {"A": d.place_clip(m.idx, "v0", 0, 1, 91), "B": d.place_clip(m.idx, "v0", 90, 100, 160),
           "C": d.place_clip(m.idx, "v0", 170 if variant == "gap" else 150, 170, 230)}
    if variant == "dissolve":
        d.set_transition(ids["B"], "dissolve", 15)  # B -> 75, C -> 135
    a0 = d.add_track("audio")
    st = d.get_state()
    ids["Aa"] = d.place_clip(m.idx, a0, 0, 1, 91)
    ids["Ba"] = d.place_clip(m.idx, a0, E.clip(st, ids["B"])["start_frame"], 100, 160)
    ids["Ca"] = d.place_clip(m.idx, a0, E.clip(st, ids["C"])["start_frame"], 170, 230)
    d.set_track("v0", muted=True)
    d.link_clips([ids["A"], ids["Aa"]])
    a1 = d.add_track("audio")
    ids["M"] = d.place_clip(m.music, a1, 0, 0, 120)
    v1 = d.add_track("video")
    ids["T"] = d.place_clip(m.title, v1, 100, 0, 30)
    d.set_markers([(30, "early"), (120, "late")])
    return ids


def speed_state(c):
    return (c.get("speed"), c.get("ramp"))


def ripple_case(t, d, ids, label, op, mode):
    """One speed change on A (op), then one undo: six checks."""
    before = d.get_state()
    a0_ = E.clip(before, ids["A"])
    old_end = E.end(a0_)
    op()
    st = d.get_state()
    a = E.clip(st, ids["A"])
    delta = a["length_frames"] - a0_["length_frames"]
    movers = set() if mode == "none" else {"B", "C", "Ba", "Ca"} | ({"T"} if mode == "all" else set())
    wrong = []
    for k, cid in ids.items():
        want = E.clip(before, cid)["start_frame"] + (delta if k in movers else 0)
        got = E.clip(st, cid)
        if got is None or got["start_frame"] != want:
            wrong.append(f"{k} at {got['start_frame'] if got else None}, want {want}")
    t.check(f"{label}: " + ("nothing moves" if mode == "none" else
                            "the later clips on v0 and a0 moved by exactly A's change in length"
                            + ("; the music and the title stay" if mode == "track" else
                               "; the title moved too, the music (it straddles A's old end) stays")),
            not wrong, "; ".join(wrong) or f"delta {delta}")
    b0, c0, b, c = (E.clip(before, ids["B"]), E.clip(before, ids["C"]), E.clip(st, ids["B"]), E.clip(st, ids["C"]))
    if mode == "none":
        t.check(f"{label}: A's length changed in place (it still starts at 0)",
                a["start_frame"] == 0, (a["start_frame"], a["length_frames"]))
    else:
        t.check(f"{label}: the edit after A is kept (the distance from A's end to B and from B's end to C)",
                b["start_frame"] - E.end(a) == b0["start_frame"] - old_end
                and c["start_frame"] - E.end(b) == c0["start_frame"] - E.end(b0),
                f"A->B {b['start_frame'] - E.end(a)}, was {b0['start_frame'] - old_end}; B->C "
                f"{c['start_frame'] - E.end(b)}, was {c0['start_frame'] - E.end(b0)}")
    aa = E.clip(st, ids["Aa"])
    t.check(f"{label}: A's linked sound has A's speed or curve, starts and ends with A",
            speed_state(aa) == speed_state(a) and aa["start_frame"] == a["start_frame"] and E.end(aa) == E.end(a),
            f"A {speed_state(a)} [{a['start_frame']},{E.end(a)}); sound {speed_state(aa)} "
            f"[{aa['start_frame']},{E.end(aa)})")
    t.check(f"{label}: the later clips keep their own speed",
            speed_state(E.clip(st, ids["B"])) == speed_state(b0)
            and speed_state(E.clip(st, ids["Ba"])) == speed_state(E.clip(before, ids["Ba"])), "")
    want_m = [mk["frame"] + (delta if mode == "all" and mk["frame"] >= old_end else 0) for mk in before["markers"]]
    got_m = [mk["frame"] for mk in st.get("markers", [])]
    t.check(f"{label}: the markers are at {want_m}", got_m == want_m, got_m)
    d.undo()
    t.check(f"{label}: one undo restores every position, speed and marker", d.get_state() == before, "")


def run(t):
    d = t.driver()
    d.set_project(width=180, height=90, fps=FPS)
    m = Media()
    m.idx = d.import_media(t.media("idx.mp4"))
    m.mic = d.import_media(t.media("tone300.m4a"))
    m.music = d.import_media(t.media("m.mp3"))
    m.title = d.import_media(t.media("fx-white.mp4"))
    main_cases(t, d, m)
    ramp_mute_by_ear(t, d, m)
    refusal(t, d, m)
    linked_members(t, d, m)
    layouts(t, d, m)
    keep_length(t, d, m)
    rendered(t, d, m)


# ---------------------------------------------------------------- 1. every speed change, three layouts
def main_cases(t, d, m):
    for variant in ("butted", "gap", "dissolve"):
        ids = build(d, m, variant)
        A = ids["A"]
        tag = f"{variant}: "
        if variant == "dissolve":
            st = d.get_state()
            t.check("dissolve: B overlaps A by 15 frames",
                    E.end(E.clip(st, A)) - E.clip(st, ids["B"])["start_frame"] == 15, E.spans(st, "v0"))
        ripple_case(t, d, ids, tag + "set_speed 2x", lambda: d.set_speed(A, 2), "track")
        ripple_case(t, d, ids, tag + "set_speed 0.5x", lambda: d.set_speed(A, 0.5), "track")
        if variant != "butted":
            continue
        for preset in PRESETS:
            ripple_case(t, d, ids, tag + f"set_speed_ramp {preset}", lambda p=preset: d.set_speed_ramp(A, preset=p),
                        "track")
        d.set_speed_ramp(A, preset="montage")
        ripple_case(t, d, ids, tag + "clear_speed_ramp (from montage)", lambda: d.clear_speed_ramp(A), "track")
        ripple_case(t, d, ids, tag + "a ramp's audio changed to mute (its length does not change)",
                    lambda: d.set_speed_ramp(A, audio="mute"), "track")
        d.undo()  # the montage
        d.set_speed(A, 2)
        ripple_case(t, d, ids, tag + "clear_effects (from 2x)", lambda: d.clear_effects(A), "track")
        d.undo()
        ripple_case(t, d, ids, tag + "set_speed 2x, ripple all", lambda: d.set_speed(A, 2, ripple="all"), "all")
        ripple_case(t, d, ids, tag + "set_speed 0.5x, ripple all", lambda: d.set_speed(A, 0.5, ripple="all"), "all")
        ripple_case(t, d, ids, tag + "set_speed_ramp bullet, ripple all",
                    lambda: d.set_speed_ramp(A, preset="bullet", ripple="all"), "all")
        ripple_case(t, d, ids, tag + "set_speed 2x, ripple none", lambda: d.set_speed(A, 2, ripple="none"), "none")
        ripple_case(t, d, ids, tag + "set_speed_ramp montage, ripple none",
                    lambda: d.set_speed_ramp(A, preset="montage", ripple="none"), "none")
        d.set_speed_ramp(A, preset="montage")
        ripple_case(t, d, ids, tag + "clear_speed_ramp, ripple all", lambda: d.clear_speed_ramp(A, ripple="all"),
                    "all")
        d.undo()
        # From the sound's side: the picture follows.
        s0 = d.get_state()
        d.set_speed(ids["Aa"], 2)
        st = d.get_state()
        t.check("set_speed 2x on A's linked sound: the picture gets 2x and both tracks ripple (B and its sound at 45)",
                E.clip(st, A)["speed"] == 2 and E.clip(st, ids["B"])["start_frame"] == 45
                and E.clip(st, ids["Ba"])["start_frame"] == 45, E.spans(st, "v0") + E.spans(st, "a0"))
        d.undo()
        t.check("...one undo restores it", d.get_state() == s0, "")


def ramp_mute_by_ear(t, d, m):
    """A ramp's audio mode by ear, on a layout with no other sound: A (v0 muted) with its linked sound Aa on a0, and B's
    sound after it. Muting the ramp's audio silences Aa too; one undo brings it back."""
    reset(d)
    a0 = d.add_track("audio")
    ids = {"A": d.place_clip(m.idx, "v0", 0, 1, 91), "B": d.place_clip(m.idx, "v0", 90, 100, 160)}
    ids["Aa"] = d.place_clip(m.idx, a0, 0, 1, 91)
    d.place_clip(m.idx, a0, 90, 100, 160)
    d.set_track("v0", muted=True)
    d.link_clips([ids["A"], ids["Aa"]])
    d.set_speed_ramp(ids["A"], preset="montage")
    heard = by_ear(t, d, ids, "montage")
    d.set_speed_ramp(ids["A"], audio="mute")
    muted = by_ear(t, d, ids, "montage-muted")
    t.check("a ramp's audio set to mute silences A's linked sound too (silent under A in the export; B's sound is "
            "still heard)", muted is not None and muted[0] < 0.01 and muted[1] > 0.05, muted)
    d.undo()
    again = by_ear(t, d, ids, "montage-again")
    t.check("one undo brings A's sound back (heard under A, as before the change)",
            heard is not None and again is not None and heard[0] > 0.05 and again[0] > 0.05, (heard, again))


def by_ear(t, d, ids, name):
    """(rms under A, rms under B) of an export of the current timeline, or None when it cannot be measured."""
    st = d.get_state()
    a, b = E.clip(st, ids["A"]), E.clip(st, ids["B"])
    out = t.path("out", f"ear-{name}.mp4")
    job = d.export(out)
    if job.get("status") != "done":
        return None
    try:
        s = observe.samples(out)
    except observe.Unmeasurable:
        return None
    return (round(observe.rms(s, a["start_frame"] / FPS + 0.1, E.end(a) / FPS - 0.1), 4),
            round(observe.rms(s, b["start_frame"] / FPS + 0.1, E.end(b) / FPS - 0.1), 4))


# ---------------------------------------------------------------- 2. refused: a speed-up shorter than the transition
def refusal(t, d, m):
    ids = build(d, m, "dissolve")
    A, B = ids["A"], ids["B"]
    ok, why = E.refused_unchanged(d, lambda: d.set_speed_ramp(A, points=[(0, 10)]))
    t.check("a ramp at 10x that leaves A 9 frames, no longer than its 15-frame dissolve into B: refused, nothing "
            "changes", ok, why)
    st0 = d.get_state()
    d.set_speed(A, 4)
    st = d.get_state()
    t.check("4x (23 frames, longer than the dissolve) is allowed and keeps the 15-frame overlap (B moved by -67)",
            E.clip(st, A)["length_frames"] == 23 and E.end(E.clip(st, A)) - E.clip(st, B)["start_frame"] == 15
            and E.clip(st, B)["start_frame"] == E.clip(st0, B)["start_frame"] - 67, E.spans(st, "v0"))
    st0 = d.get_state()
    d.set_speed_ramp(A, points=[(0, 10)], ripple="none")
    st = d.get_state()
    t.check("with ripple none the 10x ramp is allowed: A is 9 frames in place and B does not move",
            E.clip(st, A)["length_frames"] == 9 and E.clip(st, B)["start_frame"] == E.clip(st0, B)["start_frame"],
            E.spans(st, "v0"))


# ---------------------------------------------------------------- 3. linked members
def linked_members(t, d, m):
    # A freeze splits A and its sound; the left half's speed change: only its own sound half follows.
    ids = build(d, m, "butted")
    st0 = d.get_state()
    d.freeze_frame(ids["A"], 30, 15)
    st = d.get_state()
    v0 = E.clips(st, "v0")
    a0 = E.clips(st, "a0")
    still = [c for c in v0 if c["asset"] in E.new_assets(st0, st)]
    t.check("freeze at frame 30 for 15 frames: v0 = left [0,30) | the still [30,45) | right [45,105) | B ...",
            len(still) == 1 and E.spans(st, "v0")[:3] == [(0, 30), (30, 45), (45, 105)]
            and v0[1]["id"] == still[0]["id"], E.spans(st, "v0"))
    left, right = v0[0], v0[2]
    a_left, a_right = a0[0], a0[1]
    d.set_speed(left["id"], 2)
    s2 = d.get_state()
    t.check("the left half at 2x: the still and both right halves keep their speed; the left sound half gets 2x and "
            "ends with the left picture half (at 15)",
            all(speed_state(E.clip(s2, c["id"])) == speed_state(c) for c in (still[0], right, a_right))
            and E.clip(s2, a_left["id"])["speed"] == 2 and E.end(E.clip(s2, a_left["id"])) == 15
            and E.end(E.clip(s2, left["id"])) == 15, E.spans(s2, "v0") + E.spans(s2, "a0"))
    t.check("...and the still (15), the right halves (30) and B with its sound (-15) moved: picture and sound stay "
            "aligned",
            E.clip(s2, still[0]["id"])["start_frame"] == 15 and E.clip(s2, right["id"])["start_frame"] == 30
            and E.clip(s2, a_right["id"])["start_frame"] == 30
            and E.clip(s2, ids["B"])["start_frame"] == E.clip(st, ids["B"])["start_frame"] - 15
            and E.clip(s2, ids["Ba"])["start_frame"] == E.clip(st, ids["Ba"])["start_frame"] - 15,
            E.spans(s2, "v0") + E.spans(s2, "a0"))
    t.check("...nothing else on a0 changed speed", all(c["speed"] == 1 for c in E.clips(s2, "a0")
                                                        if c["id"] != a_left["id"]), E.clips(s2, "a0"))

    # A separate recording (another asset), synced 1 s later into its file, linked to A.
    ids = build(d, m, "butted")
    d.unlink_clip(ids["A"])
    d.remove_clip(ids["Aa"])
    mic = d.place_clip(m.mic, "a0", 0, 31, 121)
    d.link_clips([ids["A"], mic])
    d.set_speed_ramp(ids["A"], preset="montage")
    st = d.get_state()
    a, mc = E.clip(st, ids["A"]), E.clip(st, mic)
    t.check("a linked recording on another asset gets A's curve: the same length (+-1), from 0, and the later sound "
            "moved with the picture",
            mc["ramp"] and mc["start_frame"] == 0 and abs(E.end(mc) - E.end(a)) <= 1
            and E.clip(st, ids["Ba"])["start_frame"] == E.end(a), (E.spans(st, "v0"), E.spans(st, "a0")))
    d.undo()
    broll = d.place_clip(m.idx, "v1", 20, 200, 230)
    d.link_clips([ids["A"], mic, broll])
    d.set_speed(ids["A"], 2)
    st = d.get_state()
    br = E.clip(st, broll)
    t.check("a linked B-roll clip on v1 (other footage) keeps its speed and its place",
            br["speed"] == 1 and not br["ramp"] and br["start_frame"] == 20, br)
    t.check("...but v1 holds a linked clip, so the title after A's old end moved with the ripple (to 55)",
            E.clip(st, ids["T"])["start_frame"] == 55, E.spans(st, "v1"))

    # A J-cut: A's sound starts 10 frames before the picture (the same footage).
    ids = build(d, m, "butted")
    d.unlink_clip(ids["A"])
    d.remove_clip(ids["Aa"])
    d.move_clip(ids["A"], 10)
    d.trim_clip(ids["A"], in_frame=11, out_frame=91)  # A [10,90) shows source 11..90
    head = d.place_clip(m.idx, "a0", 0, 1, 91)       # [0,90) plays source 1..90
    d.link_clips([ids["A"], head])
    d.set_speed(ids["A"], 2)
    st = d.get_state()
    a, h = E.clip(st, ids["A"]), E.clip(st, head)
    t.check("a J-cut at 2x: the sound head is re-anchored (it starts at 5) and ends with the picture (at 50)",
            (a["start_frame"], E.end(a), h["start_frame"], E.end(h)) == (10, 50, 5, 50), (E.spans(st, "v0"),
                                                                                       E.spans(st, "a0")))
    d.undo()
    d.set_speed_ramp(ids["A"], preset="hero")
    st = d.get_state()
    a, h = E.clip(st, ids["A"]), E.clip(st, head)
    t.check("a J-cut with the hero ramp: the sound gets the curve and ends with the picture (+-1)",
            h["ramp"] and abs(E.end(h) - E.end(a)) <= 1 and h["start_frame"] < a["start_frame"],
            (E.spans(st, "v0"), E.spans(st, "a0")))


# ---------------------------------------------------------------- 4. later linked pairs, split edits, straddlers
def fresh(d):
    reset(d)
    return d.add_track("audio")


def layouts(t, d, m):
    for ripple, speed, bm in (("track", 2, 90), ("track", 0.5, 90), ("all", 2, 85)):
        a0 = fresh(d)
        a1 = d.add_track("audio")
        A = d.place_clip(m.idx, "v0", 0, 1, 91)
        B = d.place_clip(m.idx, "v0", 90, 100, 160)
        Aa = d.place_clip(m.idx, a0, 0, 1, 91)
        Bm = d.place_clip(m.mic, a1, bm, 100 - (90 - bm), 160)
        Z = d.place_clip(m.music, a1, 200, 0, 30)
        d.link_clips([A, Aa])
        d.link_clips([B, Bm])
        st0 = d.get_state()
        d.set_speed(A, speed, ripple=ripple)
        st = d.get_state()
        delta = E.clip(st, A)["length_frames"] - E.clip(st0, A)["length_frames"]
        t.check(f"ripple {ripple} {speed}x: B's linked recording on a1 moved with B, and the clip after it there too",
                E.clip(st, B)["start_frame"] == 90 + delta and E.clip(st, Bm)["start_frame"] == bm + delta
                and E.clip(st, Z)["start_frame"] == 200 + delta, f"delta {delta}; {E.spans(st, a1)}")
    # A linked pair that the ripple would split (one before A, one after A's sound) is refused.
    a0 = fresh(d)
    P0 = d.place_clip(m.idx, "v0", 0, 200, 230)
    A = d.place_clip(m.idx, "v0", 30, 1, 91)
    Aa = d.place_clip(m.idx, a0, 30, 1, 91)
    Xa = d.place_clip(m.idx, a0, 120, 200, 230)
    d.link_clips([A, Aa])
    d.link_clips([P0, Xa])
    ok, why = E.refused_unchanged(d, lambda: d.set_speed(A, 2))
    t.check("a linked pair that the ripple would split (its picture before A, its sound after A's): refused, nothing "
            "changes", ok, why)
    # B's recording would be pushed into a music bed that stays on its track: refused, not overlapped.
    a0 = fresh(d)
    a1 = d.add_track("audio")
    A2 = d.place_clip(m.idx, "v0", 0, 1, 91)
    B2 = d.place_clip(m.idx, "v0", 90, 100, 160)
    d.place_clip(m.music, a1, 0, 0, 90)
    Bm = d.place_clip(m.mic, a1, 90, 100, 160)
    d.link_clips([B2, Bm])
    ok, why = E.refused_unchanged(d, lambda: d.set_speed(A2, 2))
    t.check("a later linked recording that would run into a clip that stays on its track: refused, nothing changes",
            ok, why)
    d.set_speed(A2, 0.5)
    st = d.get_state()
    t.check("...slowing A down moves it away instead (B and its recording at 180, no overlap)",
            E.clip(st, B2)["start_frame"] == 180 and E.clip(st, Bm)["start_frame"] == 180
            and not E.overlaps(E.clips(st, a1)), E.spans(st, a1))
    # An L-cut tail (A's sound runs 30 frames past the picture), changed from either side.
    for side, speed in (("picture", 0.5), ("picture", 2), ("sound", 0.5), ("sound", 2)):
        a0 = fresh(d)
        A = d.place_clip(m.idx, "v0", 0, 1, 91)
        B = d.place_clip(m.idx, "v0", 90, 100, 160)
        Aa = d.place_clip(m.idx, a0, 0, 1, 121)
        Ba = d.place_clip(m.idx, a0, 120, 130, 160)
        d.link_clips([A, Aa])
        d.link_clips([B, Ba])
        s0 = d.get_state()
        d.set_speed(A if side == "picture" else Aa, speed)
        st = d.get_state()
        a, aa, b, ba = (E.clip(st, x) for x in (A, Aa, B, Ba))
        label = f"an L-cut, set_speed {speed}x on the {side}"
        t.check(f"{label}: the picture sets the distance (A is {round(90 / speed)} frames from 0, B follows it)",
                a["start_frame"] == 0 and a["length_frames"] == round(90 / speed) and b["start_frame"] == E.end(a),
                E.spans(st, "v0"))
        t.check(f"{label}: B's sound stays 30 frames after B", ba["start_frame"] - b["start_frame"] == 30,
                (b["start_frame"], ba["start_frame"]))
        gap = 0 if speed < 1 else 15
        t.check(f"{label}: A's sound is {speed}x from 0 and its tail "
                + ("is cut to end where B's sound starts" if speed < 1 else "got shorter: a 15-frame silence"),
                aa["start_frame"] == 0 and aa["speed"] == speed and ba["start_frame"] - E.end(aa) == gap,
                E.spans(st, "a0"))
        d.undo()
        t.check(f"{label}: one undo restores it", d.get_state() == s0, "")
    # A J-cut head slowed down: it would grow before frame 0, or into the clip before it: it is cut, never moved.
    a0 = fresh(d)
    A = d.place_clip(m.idx, "v0", 10, 11, 91)
    B = d.place_clip(m.idx, "v0", 90, 100, 160)
    head = d.place_clip(m.idx, a0, 0, 1, 91)
    Ba = d.place_clip(m.idx, a0, 90, 100, 160)
    d.link_clips([A, head])
    d.link_clips([B, Ba])
    d.set_speed(A, 0.5)
    st = d.get_state()
    a, h = E.clip(st, A), E.clip(st, head)
    t.check("a J-cut head slowed to 0.5x at frame 0: it is cut to start at 0, still plays the picture's moment with "
            "it, ends with it, and B's sound follows it",
            h["start_frame"] == 0 and h["in_frame"] + (a["start_frame"] - h["start_frame"]) * 0.5 == a["in_frame"]
            and E.end(h) == E.end(a) and E.clip(st, Ba)["start_frame"] == E.end(h),
            f"head [{h['start_frame']},{E.end(h)}) from source {h['in_frame']}; picture [{a['start_frame']},"
            f"{E.end(a)}) from {a['in_frame']}")
    a0 = fresh(d)
    P = d.place_clip(m.idx, "v0", 0, 200, 230)
    A2 = d.place_clip(m.idx, "v0", 30, 11, 91)
    Pa = d.place_clip(m.idx, a0, 0, 200, 220)
    head2 = d.place_clip(m.idx, a0, 20, 1, 91)
    d.link_clips([P, Pa])
    d.link_clips([A2, head2])
    d.set_speed(A2, 0.5)
    st = d.get_state()
    a, h, pa = E.clip(st, A2), E.clip(st, head2), E.clip(st, Pa)
    t.check("a J-cut head slowed to 0.5x after another sound clip: it stops where that clip ends (no overlap) and "
            "stays in sync with the picture",
            h["start_frame"] == 20 and E.end(pa) <= h["start_frame"]
            and h["in_frame"] + (a["start_frame"] - h["start_frame"]) * 0.5 == a["in_frame"] and E.end(h) == E.end(a),
            f"head [{h['start_frame']},{E.end(h)}) from source {h['in_frame']}; picture from {a['in_frame']}")
    straddlers(t, d, m)
    a0 = fresh(d)
    a1 = d.add_track("audio")
    A = d.place_clip(m.idx, "v0", 0, 1, 91)
    B = d.place_clip(m.idx, "v0", 90, 100, 160)
    Bm = d.place_clip(m.mic, a1, 90, 100, 160)
    d.link_clips([B, Bm])
    d.freeze_frame(A, 30, 15)
    st = d.get_state()
    t.check("freeze_frame: B and its linked recording on a1 both move by the still (to 105)",
            E.clip(st, B)["start_frame"] == 105 and E.clip(st, Bm)["start_frame"] == 105,
            (E.spans(st, "v0"), E.spans(st, a1)))


def straddlers(t, d, m):
    """Tracks that ripple from A's old end (ripple all): a clip straddling it holds the clip entering it through a
    transition; a clip straddling it holds the clip butted to it; a clip after a gap still moves."""
    fresh(d)
    v1 = d.add_track("video")
    a1 = d.add_track("audio")
    A = d.place_clip(m.idx, "v0", 0, 1, 91)
    d.place_clip(m.idx, "v0", 90, 100, 160)
    X = d.place_clip(m.idx, v1, 60, 160, 220)
    Y = d.place_clip(m.idx, v1, 120, 190, 250)
    d.set_transition(Y, "dissolve", 10)  # Y -> [110, 170)
    M1 = d.place_clip(m.music, a1, 0, 0, 120)
    M2 = d.place_clip(m.music, a1, 120, 120, 200)
    M3 = d.place_clip(m.music, a1, 260, 0, 30)
    for speed in (0.5, 2):
        st0 = d.get_state()
        d.set_speed(A, speed, ripple="all")
        st = d.get_state()
        delta = E.clip(st, A)["length_frames"] - E.clip(st0, A)["length_frames"]
        t.check(f"ripple all {speed}x: X (it straddles A's old end), Y (it enters X through a transition), the music "
                f"straddling the old end and the music butted to it stay",
                all(E.clip(st, c)["start_frame"] == E.clip(st0, c)["start_frame"] for c in (X, Y, M1, M2)),
                (E.spans(st, v1), E.spans(st, a1)))
        t.check(f"ripple all {speed}x: the music after a gap still moves",
                E.clip(st, M3)["start_frame"] == 260 + delta, f"delta {delta}; {E.spans(st, a1)}")
        d.undo()
    R = d.place_clip(m.idx, v1, 10, 0, 30)
    d.link_clips([A, R])
    d.set_speed(A, 0.5)
    st = d.get_state()
    r = E.clip(st, R)
    t.check("a linked cutaway of the same footage on v1 keeps its speed and its place; v1 (it holds a linked clip) "
            "keeps X and Y",
            r["speed"] == 1 and not r["ramp"] and r["start_frame"] == 10 and E.clip(st, X)["start_frame"] == 60
            and E.clip(st, Y)["start_frame"] == 110, E.spans(st, v1))
    d.undo()
    v2 = d.add_track("video")
    dup = d.place_clip(m.idx, v2, 0, 1, 91)
    d.link_clips([A, R, dup])
    d.set_speed(A, 2, ripple="none")
    st = d.get_state()
    t.check("a copy showing the same frame at the same moment on v2 (a blurred background, say) gets the speed; the "
            "cutaway does not",
            E.clip(st, dup)["speed"] == 2 and E.clip(st, R)["speed"] == 1, (E.clip(st, dup), E.clip(st, R)))


# ---------------------------------------------------------------- 6. smooth slow motion and reverse keep the length
def keep_length(t, d, m):
    ids = build(d, m, "butted")
    A = ids["A"]
    d.set_speed(A, 0.5)
    shape = (lambda st: [(c["id"], c["start_frame"], c["length_frames"]) for tr in st["tracks"] for c in tr["clips"]])
    s1 = d.get_state()
    d.smooth_slow_motion(A, "blend")
    s2 = d.get_state()
    t.check("smooth_slow_motion: the same lengths, nothing moved again (the bake is already slow), A at 1x on it",
            shape(s1) == shape(s2) and E.clip(s2, A)["speed"] == 1 and E.clip(s2, A)["asset"] != E.clip(s1, A)["asset"],
            (E.spans(s2, "v0"), E.clip(s2, A)))
    d.undo()
    d.undo()
    d.set_speed_ramp(A, preset="montage")
    r1 = d.get_state()
    d.reverse_clip(A, audio="mute")
    r2 = d.get_state()
    t.check("reverse_clip of a ramped clip: the same length exactly, nothing moved",
            shape(r1) == shape(r2) and E.clip(r2, A)["asset"] != E.clip(r1, A)["asset"], E.spans(r2, "v0"))


# ---------------------------------------------------------------- the export shows the ripple get_state reports
def rendered(t, d, m):
    """After a ripple (A at 2x, ripple all, on the gap layout) the export shows what get_state reports: A at 2x, B,
    the gap, C (the title's track hidden): the judge sees the edit in the frames, not only in the editor's word."""
    ids = build(d, m, "gap")
    d.set_speed(ids["A"], 2, ripple="all")
    d.set_track("v1", hidden=True)
    st = d.get_state()
    out = t.path("out", "ripple-render.mp4")
    job = d.export(out)
    try:
        frames = observe.frame_indexes(out) if job.get("status") == "done" else None
    except observe.Unmeasurable as e:
        frames, job = None, {"status": f"unmeasurable: {e}"}
    bad = E.render_problems(st, frames, m.idx) if frames is not None else ["no export"]
    t.check("after set_speed 2x with ripple all, the export shows what get_state reports (A at 2x, B, the gap, C; the "
            "hidden title not at all)", frames is not None and not bad,
            f"{E.spans(st, 'v0')}; {E.short(bad)}; {job if frames is None else ''}")
