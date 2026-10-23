"""Locked tracks: every edit that would change a locked track's clip, directly or by a ripple, is refused and changes
nothing (the State, the undo history: what redo brings back, and the clip's look: its colours in render_frame), a bake
on a locked clip leaves no file, and a bake whose result can no longer be placed (its linked clip's track was locked,
or its new spot was taken, while it ran) is refused, leaves no file and places nothing later; track-level changes
(rename, an fps change, removing the track) stay allowed, and after an unlock the same edits go through. Port of
packages/core/scripts/smoke-locks.ts (judge/PORTING.md has the map of its sections).

Media: idx.mp4 (180x90, 16 s, each frame shows its index: observe.frame_indexes; a chirp) for the layout,
fx-redblue.mp4 (red | blue) for a card on the locked track whose look the test tries to change, and long.mp4
(1920x1080, 20 s) for the two bakes that must still run when the test changes the timeline under them: each reverses
10 s of it with its linked sound (about 4 s on v0.2.0), and the change is sent at once, in milliseconds. The test
checks that the bake was still running just before the change (jobs); a bake that had already ended there could not
be judged, and its checks are recorded as not applicable with the reason (run.py --strict fails them). Such a bake is
judged on what follows its error, not on the error alone (which may come before the work has stopped): once the
timeline would take the copy again (the track unlocked, the spot free), the clips are left in place for one and a half
times a full bake of the same media, and 2 s more, and then the State must still be as before and no media file may
have appeared. How long a full bake takes is measured first, on a clean reverse of another 10 s of long.mp4 (from 5 s:
another span, so a copy of it cannot be handed to the later bakes).

The layout (canvas 180x90 at 30 fps): v0 "V1" A [0,60) | B [60,120); a0 "A1" A's sound Aa [0,60), linked to A;
v1 "Titles" (locked) T [90,120) and the card K [120,150), butted to it; a1 "Music" (locked) M [0,150). v0 is muted
(A's own sound is not heard).

A refusal is observed as: the editor answers product_error (a bad_request is the adapter's word on the arguments, not
the editor's refusal), get_state is the same as before, and the undo history is kept: a marker set and undone just
before must come back with redo (an edit that made an undo step would have dropped it), and undo then gives the same
State again (edits.refused_unchanged). The State does not hold a clip's colours, so a change of the card's look
(apply_colour, apply_lut) is also held to its colours: render_frame at the card's middle shows the same colours after
the refusal as before (and after the unlock the same change shows); these renders come after the checks on files left.
The colour comparison guards one case only: a change that is refused but still shows. A change that is accepted is
caught by the refusal part (no product_error, and the undo history no longer as before), and refused_unchanged's own
undo steps have taken it back before the colours are read.
A bake that leaves something behind is seen as a new media file anywhere in the test's folder (edits.left_media): the
editor keeps its files there (PROTOCOL.md rule 1); no render runs between the two looks. Positions come from
get_state, and the last check holds an export to it.

Every check is recorded on every path (a check whose input is missing fails with the reason), so CHECKS is exact.
"""
import os
import time

import edits as E
import observe

PORT_BOUND = True
EXTRA_MEDIA = ("idx.mp4", "long.mp4")   # the optional fixtures it uses (run.py)
TIMEOUT = 900
W, H, FPS = 180, 90, 30
# The changes of a clip's look (none is in the State) tried on the card on the locked track, and after the unlock.
LOOKS = [("apply_colour with a grade (brightness, contrast, saturation, gamma)",
          lambda d, t, c: d.apply_colour(c, brightness=0.1, contrast=1.3, saturation=0.2, gamma=1.4)),
         ("apply_colour with adjustments (temperature, tint, hue)",
          lambda d, t, c: d.apply_colour(c, temperature=-0.8, tint=0.6, hue=90)),
         ("apply_lut (a look-up table that swaps red and blue)", lambda d, t, c: d.apply_lut(c, t.media("look.cube")))]
BLOCKS = [(20, 40), (150, 40)]   # (x, y) of a block in the card's red half and one in its blue half
CARD_AT = 135 / FPS              # the card's middle
CHECKS = 8 + 1 + len(LOOKS) + 7 + 3 + 3 + 7 + 2 + 1 + 1 + 1


def run(t):
    d = t.driver()
    d.set_project(width=W, height=H, fps=FPS)
    idx = d.import_media(t.media("idx.mp4"))
    hd = d.import_media(t.media("long.mp4"))
    rb = d.import_media(t.media("fx-redblue.mp4"))
    a0 = d.add_track("audio")
    v1 = d.add_track("video")
    a1 = d.add_track("audio")
    d.set_track("v0", name="V1", muted=True)
    d.set_track(a0, name="A1")
    d.set_track(v1, name="Titles")
    d.set_track(a1, name="Music")
    A = d.place_clip(idx, "v0", 0, 0, 60)
    B = d.place_clip(idx, "v0", 60, 60, 120)
    Aa = d.place_clip(idx, a0, 0, 0, 60)
    d.link_clips([A, Aa])
    T = d.place_clip(idx, v1, 90, 200, 230)
    K = d.place_clip(rb, v1, 120, 0, 30)
    M = d.place_clip(idx, a1, 0, 0, 150)
    d.set_track(v1, locked=True)
    d.set_track(a1, locked=True)
    mine = [os.path.dirname(t.path("out", "x")), os.path.dirname(t.path("frames", "x"))]

    def refused(label, fn):
        ok, why = E.refused_unchanged(d, fn)
        t.check(label, ok, why)

    def refused_clean(label, fn):
        before = E.files(t, mine)
        ok, why = E.refused_unchanged(d, fn)
        left = E.left_media(t, before, mine)
        t.check(label, ok and not left, f"{why}; media files left: {left}")

    # ---- 1. direct edits of a clip on a locked track
    refused("trim_clip of a clip on the locked track: refused, nothing changes",
            lambda: d.trim_clip(T, in_frame=205))
    refused("move_clip of a clip on the locked track: refused, nothing changes", lambda: d.move_clip(T, 100))
    refused("split_clip of a clip on the locked track: refused, nothing changes", lambda: d.split_clip(T, 10))
    refused("apply_effect on a clip on the locked track: refused, nothing changes",
            lambda: d.apply_effect(T, "blur", amount=2))
    refused("remove_clip of a clip on the locked track: refused, nothing changes", lambda: d.remove_clip(T))
    refused("place_clip onto the locked track: refused, nothing changes",
            lambda: d.place_clip(idx, v1, 200, 0, 10))
    refused("insert_clip onto the locked track: refused, nothing changes",
            lambda: d.insert_clip(idx, v1, 0, 0, 10))
    refused("cut_range of a clip on the locked music track: refused, nothing changes",
            lambda: d.cut_range(M, 10, 20))
    refused("set_transition into the card on the locked track (from the title it butts): refused, nothing changes",
            lambda: d.set_transition(K, "dissolve", 10))

    # ---- 2. ripples that would move a locked clip
    refused("set_speed 0.5x with ripple all (it would move the locked title): refused, nothing changes",
            lambda: d.set_speed(A, 0.5, ripple="all"))
    d.set_speed(A, 0.5)
    st = d.get_state()
    t.check("set_speed 0.5x with ripple track leaves the locked tracks alone: allowed (B moved to 120, the title "
            "stayed at 90)",
            E.clip(st, A)["length_frames"] == 120 and E.clip(st, B)["start_frame"] == 120
            and E.clip(st, T)["start_frame"] == 90, E.spans(st, "v0") + E.spans(st, v1))
    d.undo()
    d.set_speed(A, 0.5, ripple="none")
    st = d.get_state()
    t.check("set_speed 0.5x with ripple none: allowed (A is 120 frames in place, nothing moved)",
            E.clip(st, A)["length_frames"] == 120 and E.clip(st, A)["speed"] == 0.5
            and E.clip(st, B)["start_frame"] == 60 and E.clip(st, T)["start_frame"] == 90,
            E.spans(st, "v0") + E.spans(st, v1))
    d.undo()
    d.set_track(a0, locked=True)
    refused("set_speed 2x of a clip whose linked sound sits on a locked track: refused, nothing changes",
            lambda: d.set_speed(A, 2))
    d.set_track(a0, locked=False)
    refused("freeze_frame with ripple all (it would move the locked title): refused, nothing changes",
            lambda: d.freeze_frame(A, 30, 30, ripple="all"))
    st0 = d.get_state()
    d.freeze_frame(A, 30, 30)
    st = d.get_state()
    still = [c for c in E.clips(st, "v0") if c["asset"] in E.new_assets(st0, st)]
    t.check("freeze_frame with ripple track (v0 and A's linked sound only): allowed (a 30-frame still at 30, the title "
            "stayed at 90)",
            len(still) == 1 and still[0]["start_frame"] == 30 and still[0]["length_frames"] == 30
            and E.clip(st, T)["start_frame"] == 90, E.spans(st, "v0") + E.spans(st, v1))
    d.undo()
    refused("ripple_delete of a range on v0 and on the locked music track: refused, nothing changes",
            lambda: d.ripple_delete([("v0", 10, 20), (a1, 10, 20)]))

    # ---- 3. track-level changes
    d.set_track(v1, name="Titles 2")
    t.check("renaming the locked track: allowed", E.track(d.get_state(), v1).get("name") == "Titles 2",
            E.track(d.get_state(), v1))
    d.set_track(v1, name="Titles")
    d.set_project(fps=60)
    st = d.get_state()
    t.check("an fps change re-times the locked track's clips too: allowed (the title at 180 at 60 fps)",
            E.clip(st, T)["start_frame"] == 180 and abs(float(st["canvas"]["fps"]) - 60) < 1e-6,
            (E.spans(st, v1), st["canvas"]))
    d.undo()
    st = d.get_state()
    t.check("...and one undo puts it back (the title at 90 at 30 fps)",
            E.clip(st, T)["start_frame"] == 90 and abs(float(st["canvas"]["fps"]) - FPS) < 1e-6,
            (E.spans(st, v1), st["canvas"]))

    # ---- 4. bakes on a locked clip refuse and leave no file
    refused_clean("reverse_clip of a clip on the locked track: refused, nothing changes, no media file left",
                  lambda: d.reverse_clip(T))
    refused_clean("freeze_frame of a clip on the locked track: refused, nothing changes, no media file left",
                  lambda: d.freeze_frame(T, 6, 30))
    d.set_speed(A, 0.5, ripple="none")
    d.set_track("v0", locked=True)
    refused_clean("smooth_slow_motion of a slowed clip on a locked track: refused, nothing changes, no media file left",
                  lambda: d.smooth_slow_motion(A, "blend"))
    d.set_track("v0", locked=False)
    d.set_speed(A, 1, ripple="none")

    # ---- 5. a bake whose result can no longer be placed
    refused_clean("freeze_frame with ripple all into the locked title's track: refused, nothing changes, no media "
                  "file left", lambda: d.freeze_frame(A, 30, 30, ripple="all"))
    full, why = measured(d, hd, a0)
    late_lock(t, d, hd, a0, mine, full, why)
    spot_taken(t, d, hd, idx, a0, mine, full, why)

    # ---- 1 (the look). The State does not hold a clip's colours: the card's are read with render_frame, after the
    # checks on files left (a render writes the editor's caches).
    plain = colours(t, d, "card-plain")
    for k, (name, change) in enumerate(LOOKS):
        ok, why = E.refused_unchanged(d, lambda: change(d, t, K))
        now = colours(t, d, f"card-locked-{k}")
        t.check(f"{name} on the card on the locked track: refused, nothing changes (its colours neither)",
                ok and same_colours(now, plain), f"{why}; colours before {plain}, after {now}")

    # ---- after unlocking the same edits go through; removing a locked track is allowed
    d.set_track(v1, locked=False)
    seen = []
    for k, (name, change) in enumerate(LOOKS):
        change(d, t, K)
        now = colours(t, d, f"card-unlocked-{k}")
        d.undo()
        back = colours(t, d, f"card-undone-{k}")
        seen.append((name.split(" (")[0], now, back, isinstance(now, list) and not same_colours(now, plain)
                     and same_colours(back, plain)))
    t.check("after the unlock, each of the look changes goes through: the card's colours change, and one undo takes "
            "them back", isinstance(plain, list) and all(x[3] for x in seen), f"plain {plain}; {seen}")
    d.set_transition(K, "dissolve", 10)
    k = E.clip(d.get_state(), K)
    d.undo()
    t.check("after the unlock, set_transition into the card goes through (it enters 10 frames over the title, at 110)",
            k is not None and k["start_frame"] == 110 and E.clip(d.get_state(), K)["start_frame"] == 120,
            (k, E.spans(d.get_state(), v1)))
    d.remove_clip(K)
    d.move_clip(T, 100)
    t.check("after the unlock, move_clip of the title goes through (at 100)",
            E.clip(d.get_state(), T)["start_frame"] == 100, E.spans(d.get_state(), v1))
    d.set_track(a1, locked=True)
    d.remove_track(a1)
    st = d.get_state()
    t.check("removing a locked track (the music): allowed, its track and clip are gone",
            E.clip(st, M) is None and not any(tr.get("name") == "Music" for tr in st.get("tracks", [])),
            [(tr.get("track"), tr.get("name")) for tr in st.get("tracks", [])])

    # ---- the export shows what get_state says: A, B, then the title over B
    out = t.path("out", "locks.mp4")
    job = d.export(out)
    st = d.get_state()
    want = expected(st, idx, st["length_frames"])
    try:
        got = observe.frame_indexes(out) if job.get("status") == "done" else None
    except observe.Unmeasurable as e:
        got, job = None, {"status": f"unmeasurable: {e}"}
    off = [f"{f}: {got[f]}, want {w}" for f, w in enumerate(want) if got is not None and f < len(got) and got[f] != w]
    t.check(f"the export shows what get_state reports ({len(want)} frames: A, B, and the title over B from 100)",
            got is not None and len(got) == len(want) and not off and len(want) == 130,
            f"{len(got) if got else 0} frames; {E.short(off)}; {job if got is None else ''}")


def colours(t, d, name):
    """[(r, g, b)] of BLOCKS in render_frame at the card's middle, or why they could not be read (a str)."""
    p = t.path("frames", f"{name}.png")
    try:
        d.render_frame(CARD_AT, p)  # read where the judge asked for it, not where the adapter says it is
        return [observe.block_rgb(p, 0, x, y) for x, y in BLOCKS]
    except observe.Unmeasurable as e:
        return f"unmeasurable ({e})"


def same_colours(a, b):
    """Whether two colours() readings are the same picture (each block within 8 per channel)."""
    return isinstance(a, list) and isinstance(b, list) and all(observe.colour_is(x, y, 8) for x, y in zip(a, b))


def expected(st, asset, n):
    """The frame index each of the first `n` timeline frames must show: the highest video track's 1x clip of `asset`
    there (in_frame + frames since its start), else 0 (black)."""
    out = [0] * n
    vids = sorted((tr for tr in st.get("tracks", []) if str(tr.get("track", "")).startswith("v")),
                  key=lambda tr: int(tr["track"][1:]))
    for tr in vids:
        if tr.get("hidden"):
            continue
        for c in tr.get("clips", []):
            for f in range(c["start_frame"], min(n, E.end(c))):
                out[f] = c["in_frame"] + (f - c["start_frame"]) if c["asset"] == asset else -1
    return out


def measured(d, hd, a0):
    """(seconds, why) that a clean reverse of 10 s of long.mp4 (from 5 s) with its linked sound takes
    (edits.bake_time): how long a full bake of the later bakes' media takes. Its clips are removed after it."""
    X = d.place_clip(hd, "v0", 2000, 150, 450)
    Xa = d.place_clip(hd, a0, 2000, 150, 450)
    d.link_clips([X, Xa])
    try:
        return E.bake_time(lambda: d.reverse_clip(X))
    finally:
        for c in (X, Xa):
            if E.clip(d.get_state(), c) is not None:
                d.remove_clip(c)


def late_lock(t, d, hd, a0, mine, full, why):
    """A reverse of a picture (10 s of long.mp4) with its linked sound on a0; a0 is locked while the bake runs: the
    bake's result cannot be placed (it would change the locked sound), so the reverse ends in an error (at once or
    when the copy is made) and leaves nothing; once a0 is unlocked again, it stays so for longer than a full bake
    takes (`full` s, measured(); edits.stays_stopped)."""
    R = d.place_clip(hd, "v0", 300, 0, 300)
    Ra = d.place_clip(hd, a0, 300, 0, 300)
    d.link_clips([R, Ra])
    st0 = d.get_state()
    before = E.files(t, mine)
    job = d.reverse_clip(R, wait=False)
    was = E.job_now(d, job)
    ran, done = bool(was) and was.get("status") == "running", bool(was) and was.get("status") == "done"
    names = ["a reverse whose linked sound's track is locked while it bakes ends in an error and leaves the project "
             "as it was", "...and leaves no media file behind",
             "...and with the track unlocked, left in place for longer than a full bake of the same media takes, the "
             "clip and its sound still play their own media and no media file appears"]
    if done:
        E.too_fast(t, names, was, "locked the track")
    else:
        d.set_track(a0, locked=True)
        end = E.wait_job(d, job) if job else None
        since = time.monotonic()
        d.set_track(a0, locked=False)
        st = d.get_state()
        left = E.left_media(t, before, mine)
        t.check(names[0], ran and bool(end) and end.get("status") == "error" and st == st0,
                f"running just before the lock: {ran} ({was}); the job at its end: {end}; State unchanged: "
                f"{st == st0}")
        t.check(names[1], ran and not left, f"left: {left}")
        ok, detail = E.stays_stopped(t, d, job, st0, before, mine, full, since, why)
        t.check(names[2], ran and ok, detail)
    d.remove_clip(R)


def spot_taken(t, d, hd, idx, a0, mine, full, why):
    """A J-cut (the sound starts 10 frames before the picture) of 10 s of long.mp4 is reversed: its sound becomes an
    L-cut tail, [1010, 1310) on a0. While the bake runs, Q is moved into that spot (1295, beside the sound where it is
    now, [990, 1290)): the result cannot be placed without an overlap, so the reverse ends in an error and leaves
    nothing, and no two clips overlap on a0; once Q is back (the spot free again), it stays so for longer than a full
    bake takes (`full` s, measured(); edits.stays_stopped)."""
    P = d.place_clip(hd, "v0", 1000, 300, 600)
    Pa = d.place_clip(hd, a0, 990, 300, 600)
    d.link_clips([P, Pa])
    Q = d.place_clip(idx, a0, 1320, 0, 20)
    st0 = d.get_state()
    before = E.files(t, mine)
    job = d.reverse_clip(P, wait=False)
    was = E.job_now(d, job)
    ran, done = bool(was) and was.get("status") == "running", bool(was) and was.get("status") == "done"
    names = ["a reverse whose J-cut sound's new spot is taken while it bakes ends in an error, leaves no media file "
             "and the project as it was", "...and no two clips overlap on a0 meanwhile",
             "...and with the spot free again, left in place for longer than a full bake of the same media takes, the "
             "J-cut still plays its own media and no media file appears"]
    if done:
        E.too_fast(t, names, was, "moved the clip")
    else:
        d.move_clip(Q, 1295)
        end = E.wait_job(d, job) if job else None
        since = time.monotonic()
        st1 = d.get_state()
        d.move_clip(Q, 1320)
        st = d.get_state()
        left = E.left_media(t, before, mine)
        t.check(names[0], ran and bool(end) and end.get("status") == "error" and st == st0 and not left,
                f"running just before the move: {ran} ({was}); the job at its end: {end}; State unchanged: "
                f"{st == st0}; left: {left}")
        t.check(names[1], not E.overlaps(E.clips(st1, a0)), E.spans(st1, a0))
        ok, detail = E.stays_stopped(t, d, job, st0, before, mine, full, since, why)
        t.check(names[2], ran and ok, detail)
    d.remove_clip(P)
    d.remove_clip(Q)
