"""freeze_frame holds the exact frame shown at a moment of a clip as a still clip, and the timeline ripples as the
user chose: the timeline grows by exactly the still, the still keeps the clip's look and has no sound, the clip's
linked sound is split and silent under the still and in sync after it, a freeze at the first or past the last frame
leaves no empty half, a slowed clip holds the frame shown there and never one past its out point, a freeze inside a
transition's overlap is refused, freezing the linked sound freezes its picture, one undo restores everything; ripple
all moves the other tracks and the markers (a straddling clip stays) and refuses to break a transition, ripple none
overwrites the clip in place. Port of the freeze_frame sections of packages/core/scripts/smoke-time.ts (its first and
fourth; judge/PORTING.md has the map of its sections; its others are tests/test_reverse_slowmo.py).

Media: idx.mp4 (180x90 30 fps, 16 s): each frame shows its own index (observe.frame_indexes) and its sound is a chirp
whose pitch says its source moment (observe.chirp_time). The canvas is 180x90 at 30 fps. v0 is muted: the pictures'
own sound is not heard, their linked clips on a0 carry it.

The still is found in get_state (the clip on v0 that plays an asset that was not there before), never taken from the
operation's answer; the frame it holds is read from an export or from render_frame at its middle. The sound is held
to the source moment the picture plays, within (0.5 + 0.5) / 30 s + 12 ms (edits.sound_offset).

Every check is recorded on every path (a check whose input is missing fails with the reason), so CHECKS is exact.
"""
import edits as E
import observe

PORT_BOUND = True
TIMEOUT = 900
FPS = 30
TOL = 1.0 / FPS + 0.012
CHECKS = 12 + 2 + 2 + 1 + 5 + 3 * 2 + 2 + 3 + 9


def run(t):
    d = t.driver()
    d.set_project(width=180, height=90, fps=FPS)
    idx = d.import_media(t.media("idx.mp4"))
    a0 = d.add_track("audio")
    v1 = d.add_track("video")
    d.set_track("v0", muted=True)
    basic(t, d, idx, a0)
    slowed(t, d, idx)
    transition(t, d, idx)
    sound_side(t, d, idx, a0)
    ripple_modes(t, d, idx, a0, v1)


def still_of(st0, st, track="v0"):
    """The still: the clips on `track` in State `st` that play an asset that is not in State `st0`."""
    new = E.new_assets(st0, st)
    return [c for c in E.clips(st, track) if c["asset"] in new]


def held(t, d, c, name):
    """The frame index render_frame shows at the middle of clip `c` (or why it could not be read)."""
    p = t.path("frames", f"{name}.png")
    try:
        d.render_frame((c["start_frame"] + c["length_frames"] / 2) / FPS, p)
        return observe.frame_indexes(p)[0]
    except (observe.Unmeasurable, IndexError) as e:
        return f"unmeasurable ({e})"


def export(t, d, name):
    """(frame indexes, samples) of an export of the timeline, or (None, None) with the reason in a third item."""
    out = t.path("out", f"{name}.mp4")
    job = d.export(out)
    if job.get("status") != "done":
        return None, None, job
    try:
        frames = observe.frame_indexes(out)
        snd = observe.samples(out) if observe.audio_stream(out) is not None else None
        return frames, snd, None
    except observe.Unmeasurable as e:
        return None, None, str(e)


# ---------------------------------------------------------------- the freeze and its sound
def basic(t, d, idx, a0):
    clip = d.place_clip(idx, "v0", 0, 0, 120)        # [0,120)
    tail = d.place_clip(idx, "v0", 120, 300, 330)    # [120,150)
    aud = d.place_clip(idx, a0, 0, 0, 120)
    a_tail = d.place_clip(idx, a0, 120, 300, 330)
    d.apply_effect(clip, "grayscale")                # a look the still must keep
    d.link_clips([clip, aud])
    d.link_clips([tail, a_tail])
    st0 = d.get_state()
    len0 = st0["length_frames"]
    d.freeze_frame(clip, 30, 60)                     # 1 s in, for 2 s
    st = d.get_state()
    still = still_of(st0, st)
    t.check("the timeline grew by exactly the still (60 frames)", st["length_frames"] == len0 + 60,
            f"{len0} -> {st['length_frames']}")
    t.check("the still is on v0 at frame 30, 60 frames long, playing a new asset",
            len(still) == 1 and (still[0]["start_frame"], still[0]["length_frames"]) == (30, 60),
            E.spans(st, "v0"))
    t.check("the still keeps the clip's look (its effects)",
            len(still) == 1 and [e["effect"] for e in still[0].get("effects", [])] == ["grayscale"],
            still[0].get("effects") if still else None)
    t.check("v0 = left [0,30) | still [30,90) | right [90,180) | the next clip moved to [180,210)",
            E.spans(st, "v0") == [(0, 30), (30, 90), (90, 180), (180, 210)], E.spans(st, "v0"))
    t.check("the linked sound is split and has a gap under the still: [0,30) | [90,180) | [180,210)",
            E.spans(st, a0) == [(0, 30), (90, 180), (180, 210)], E.spans(st, a0))
    frames, snd, why = export(t, d, "freeze")
    names = ["the export has 210 frames",
             "the picture: 29 | 30 held for 60 frames | then 30, 31 (the held frame is also the right half's first)",
             "the next clip moved right: frame 179 shows 119, frame 180 the next clip's first frame (300)",
             "the sound before the still plays the moment the picture shows (source 0.6 s at 0.6 s)",
             "the sound is silent under the still",
             "after the still the sound goes on in sync with the picture (source 1.1 s at 3.1 s)"]
    if frames is None:
        for n in names:
            t.check(n, False, f"no export: {why}")
    else:
        t.check(names[0], len(frames) == 210, len(frames))
        t.check(names[1], frames[29] == 29 and frames[30:90] == [30] * 60 and frames[90:92] == [30, 31],
                (frames[28:32], frames[88:93]))
        t.check(names[2], len(frames) > 180 and frames[179] == 119 and frames[180] == 300, frames[178:182])
        pre = E.sound_offset(snd, 0.6, lambda x: x) if snd else None
        t.check(names[3], pre is not None and abs(pre) <= TOL, E.ms(pre))
        quiet = observe.rms(snd, 1.2, 2.8) if snd else None
        t.check(names[4], quiet is not None and quiet < 0.01, quiet)
        post = E.sound_offset(snd, 3.1, lambda x: x - 2.0) if snd else None
        t.check(names[5], post is not None and abs(post) <= TOL, E.ms(post))
    d.undo()
    t.check("one undo restores the clips, the assets and the length exactly", d.get_state() == st0, "")
    # At the first frame: the still goes before the clip, no empty half.
    d.freeze_frame(clip, 0, 30)
    st = d.get_state()
    still = still_of(st0, st)
    t.check("a freeze at the first frame puts the still before the clip, which moves whole (no empty half)",
            len(still) == 1 and still[0]["start_frame"] == 0
            and E.spans(st, "v0") == [(0, 30), (30, 150), (150, 180)], E.spans(st, "v0"))
    t.check("...and its linked sound moved with it", E.spans(st, a0) == [(30, 150), (150, 180)], E.spans(st, a0))
    d.undo()
    # Past the end: the last frame is held, a one-frame right half stays.
    d.freeze_frame(clip, 99 * FPS, 30)
    st = d.get_state()
    still = still_of(st0, st)
    t.check("a freeze past the clip's end: left [0,119) | still [119,149) | a one-frame right half | the next clip at "
            "150", E.spans(st, "v0") == [(0, 119), (119, 149), (149, 150), (150, 180)] and len(still) == 1,
            E.spans(st, "v0"))
    t.check("...the still holds the clip's last frame (119)", len(still) == 1 and held(t, d, still[0], "last") == 119,
            held(t, d, still[0], "last-again") if still else "no still")
    d.undo()
    # At 0.5x, 1 s into the clip shows source frame 15.
    d.set_speed(clip, 0.5)
    sts = d.get_state()
    d.freeze_frame(clip, 30, 30)
    st = d.get_state()
    still = still_of(sts, st)
    got = held(t, d, still[0], "half") if len(still) == 1 else "no still"
    t.check("at 0.5x the still holds the frame shown at that moment (source frame 15)", got == 15, got)
    d.undo()
    d.undo()
    E.clear(d)


# ---------------------------------------------------------------- slowed clips
def slowed(t, d, idx):
    slow = d.place_clip(idx, "v0", 0, 0, 120)
    d.set_speed(slow, 0.5)                           # 240 frames
    plain, _, why = export(t, d, "slow-plain")
    t.check("control: the plain 0.5x export has 240 frames and shows source frame 15 at frame 31",
            plain is not None and len(plain) == 240 and plain[31] == 15,
            why or (len(plain), plain[29:33]))
    st0 = d.get_state()
    d.freeze_frame(slow, 31, 30)
    st = d.get_state()
    still = still_of(st0, st)
    got = held(t, d, still[0], "odd") if len(still) == 1 else "no still"
    t.check("a 0.5x freeze at an odd frame (31) holds the frame shown there (15)", got == 15, got)
    cs = E.clips(st, "v0")
    t.check("...the halves and the still tile with no gap or overlap, and the timeline grew by exactly 30",
            len(cs) == 3 and E.butted(cs) and st["length_frames"] == st0["length_frames"] + 30, E.spans(st, "v0"))
    frames, _, why = export(t, d, "slow-odd")
    t.check("...the export has 270 frames: 14 | 15 held | 15, 15, 16",
            frames is not None and len(frames) == 270
            and [frames[i] for i in (29, 30, 59, 60, 61, 62)] == [14, 15, 15, 15, 15, 16],
            why or (len(frames), [frames[i] for i in (29, 30, 59, 60, 61, 62)]))
    d.undo()
    t.check("...one undo restores the slowed clip", d.get_state() == st0, "")
    for spd in (0.5, 0.25):
        d.set_speed(slow, spd)
        total = round(120 / spd)
        sb = d.get_state()
        d.freeze_frame(slow, 99 * FPS, 30)
        st = d.get_state()
        still = still_of(sb, st)
        got = held(t, d, still[0], f"end-{spd}") if len(still) == 1 else "no still"
        t.check(f"{spd}x: a freeze past the end holds the last frame inside the trim (119), not the one past its out "
                f"point", got == 119, got)
        cs = E.clips(st, "v0")
        right = cs[-1] if cs else None
        t.check(f"{spd}x: the right half keeps at least one source frame inside the trim, and the pieces tile "
                f"exactly (+30)",
                len(cs) == 3 and E.butted(cs) and right["out_frame"] - right["in_frame"] >= 1
                and right["out_frame"] <= 120 and st["length_frames"] == sb["length_frames"] + 30,
                [(c["start_frame"], E.end(c), c["in_frame"], c["out_frame"]) for c in cs])
        frames, _, why = export(t, d, f"slow-end-{spd}")
        tail = frames[right["start_frame"]:] if frames is not None and right else []
        t.check(f"{spd}x: the export has {total + 30} frames and the right half shows the last source frames (no "
                f"black flash)", frames is not None and len(frames) == total + 30 and tail and min(tail) >= 118,
                why or (len(frames), tail))
        d.undo()
    E.clear(d)


# ---------------------------------------------------------------- a transition after the clip
def transition(t, d, idx):
    A = d.place_clip(idx, "v0", 0, 0, 120)
    B = d.place_clip(idx, "v0", 120, 300, 360)
    d.set_transition(B, "fade", 15)                  # B [105,165)
    ok, why = E.refused_unchanged(d, lambda: d.freeze_frame(A, 99 * FPS, 60))
    t.check("a freeze inside the next clip's transition overlap: refused, nothing changes", ok, why)
    d.freeze_frame(A, 50, 60)
    st = d.get_state()
    b = E.clip(st, B)
    right = [c for c in E.clips(st, "v0") if c["id"] not in (B,)][-1]
    t.check("a freeze before the overlap: the next clip moved by 60 with its 15-frame transition and overlap kept",
            b["start_frame"] == 165 and (b.get("transition") or {}).get("frames") == 15
            and E.end(right) - b["start_frame"] == 15, (E.spans(st, "v0"), b.get("transition")))
    d.undo()
    E.clear(d)


# ---------------------------------------------------------------- freezing the linked sound
def sound_side(t, d, idx, a0):
    V = d.place_clip(idx, "v0", 0, 0, 120)
    Au = d.place_clip(idx, a0, 0, 0, 120)
    d.link_clips([V, Au])
    st0 = d.get_state()
    d.freeze_frame(Au, 30, 30)
    st = d.get_state()
    new = E.new_assets(st0, st)
    t.check("freezing the linked sound clip freezes its picture: the still goes on v0, no hole ([0,30) | [30,60) | "
            "[60,150))", E.spans(st, "v0") == [(0, 30), (30, 60), (60, 150)] and len(still_of(st0, st)) == 1,
            E.spans(st, "v0"))
    t.check("...and the sound track holds no picture: no clip on a0 plays the still, two sound pieces",
            len(E.clips(st, a0)) == 2 and not any(c["asset"] in new for c in E.clips(st, a0)), E.clips(st, a0))
    d.undo()
    lone = d.place_clip(idx, a0, 400, 0, 120)
    ok, why = E.refused_unchanged(d, lambda: d.freeze_frame(lone, 0, 30))
    t.check("freeze_frame of a sound clip with no linked picture: refused, nothing changes", ok, why)
    E.clear(d)


# ---------------------------------------------------------------- ripple modes
def ripple_modes(t, d, idx, a0, v1):
    x = d.place_clip(idx, "v0", 0, 0, 120)
    tail = d.place_clip(idx, "v0", 120, 300, 330)
    ax = d.place_clip(idx, a0, 0, 0, 120)
    d.link_clips([x, ax])
    o1 = d.place_clip(idx, v1, 20, 400, 420)         # straddles the freeze point (30)
    o2 = d.place_clip(idx, v1, 50, 420, 450)         # after it
    d.set_markers([10, 100])
    st0 = d.get_state()
    len0 = st0["length_frames"]
    d.freeze_frame(x, 30, 60, ripple="all")
    st = d.get_state()
    t.check("ripple all: the next clip (to 180) and the later v1 clip (to 110) move; the v1 clip straddling the freeze "
            "point stays (20)",
            (E.clip(st, tail)["start_frame"], E.clip(st, o2)["start_frame"], E.clip(st, o1)["start_frame"])
            == (180, 110, 20), (E.spans(st, "v0"), E.spans(st, v1)))
    t.check("ripple all: the marker after the freeze point moves (100 to 160), the one before stays",
            [m["frame"] for m in st.get("markers", [])] == [10, 160], st.get("markers"))
    d.undo()
    d.freeze_frame(x, 30, 60)
    st = d.get_state()
    t.check("ripple track (the default): the other tracks and the markers stay",
            E.clip(st, o2)["start_frame"] == 50 and [m["frame"] for m in st.get("markers", [])] == [10, 100],
            (E.spans(st, v1), st.get("markers")))
    d.undo()
    o3 = d.place_clip(idx, v1, 35, 440, 450)
    d.set_transition(o3, "fade", 4)
    ok, why = E.refused_unchanged(d, lambda: d.freeze_frame(x, 30, 60, ripple="all"))
    t.check("ripple all that would break a transition on another track: refused, nothing changes", ok, why)
    for c in (o1, o2, o3):                            # v1 composites over v0: keep the export showing v0
        if E.clip(d.get_state(), c) is not None:
            d.remove_clip(c)
    sb = d.get_state()
    d.freeze_frame(x, 30, 15, ripple="none")
    st = d.get_state()
    still = still_of(sb, st)
    t.check("ripple none: a 15-frame still, nothing moves, the timeline keeps its length",
            len(still) == 1 and still[0]["length_frames"] == 15 and st["length_frames"] == len0
            and E.clip(st, tail)["start_frame"] == 120, (E.spans(st, "v0"), st["length_frames"]))
    rest = [(c["start_frame"], E.end(c), c["in_frame"]) for c in E.clips(st, "v0") if c not in still]
    t.check("ripple none: v0 = left [0,30) | still [30,45) | the clip resumes on source 45 at 45 | the next clip "
            "unmoved", rest == [(0, 30, 0), (45, 120, 45), (120, 150, 300)] and len(still) == 1
            and (still[0]["start_frame"], E.end(still[0])) == (30, 45), E.spans(st, "v0"))
    t.check("ripple none: the linked sound is silent under the still and stays in sync",
            [(c["start_frame"], E.end(c), c["in_frame"]) for c in E.clips(st, a0)] == [(0, 30, 0), (45, 120, 45)],
            E.clips(st, a0))
    frames, _, why = export(t, d, "freeze-none")
    t.check("ripple none: the export shows 29 | 30 held 15 frames | 45 ... 119 | the next clip, 150 frames",
            frames is not None and len(frames) == len0
            and [frames[i] for i in (29, 30, 44, 45, 119, 120)] == [29, 30, 30, 45, 119, 300],
            why or (len(frames), [frames[i] for i in (29, 30, 44, 45, 119, 120)]))
    d.undo()
    d.freeze_frame(x, 100, 60, ripple="none")
    st = d.get_state()
    still = still_of(sb, st)
    t.check("ripple none near the end: the still stops at the clip's end (20 of 60 frames) and the next clip stays",
            len(still) == 1 and still[0]["length_frames"] == 20 and E.clip(st, tail)["start_frame"] == 120,
            E.spans(st, "v0"))
    d.undo()
