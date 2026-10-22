"""Locked tracks: every edit that would change a locked track's clip, directly or by a ripple, is refused and changes
nothing (the State, the undo history: what redo brings back), a bake on a locked clip leaves no file, and a bake whose
result can no longer be placed (its linked clip's track was locked, or its new spot was taken, while it ran) is
refused and leaves no file; track-level changes (rename, an fps change, removing the track) stay allowed, and after
an unlock the same edit goes through. Port of packages/core/scripts/smoke-locks.ts (judge/PORTING.md has the map of
its sections).

Media: idx.mp4 (180x90, 16 s, each frame shows its index: observe.frame_indexes; a chirp) for the layout, and a.mp4
(1280x720, 6 s) for the two bakes that must still run when the test changes the timeline under them: reversing 6 s of
720p takes about a second (v0.2.0), and the change is sent at once, in milliseconds. The test checks that the bake
was still running after the change (jobs) before it holds the outcome to the rule.

The layout (canvas 180x90 at 30 fps): v0 "V1" A [0,60) | B [60,120); a0 "A1" A's sound Aa [0,60), linked to A;
v1 "Titles" (locked) T [90,120); a1 "Music" (locked) M [0,150). v0 is muted (A's own sound is not heard).

A refusal is observed as: the editor answers with an error (product_error or bad_request), get_state is the same as
before, and the undo history is kept: a marker set and undone just before must come back with redo (an edit that
made an undo step would have dropped it), and undo then gives the same State again (edits.refused_unchanged). A bake
that leaves something behind is seen as a new media file anywhere in the test's folder (edits.left_media): the editor
keeps its files there (PROTOCOL.md rule 1). Positions come from get_state, and the last check holds an export to it.

Every check is recorded on every path (a check whose input is missing fails with the reason), so CHECKS is exact.
"""
import os
import time

import edits as E
import observe

PORT_BOUND = True
TIMEOUT = 900
CHECKS = 8 + 7 + 3 + 3 + 5 + 2 + 1
W, H, FPS = 180, 90, 30


def run(t):
    d = t.driver()
    d.set_project(width=W, height=H, fps=FPS)
    idx = d.import_media(t.media("idx.mp4"))
    hd = d.import_media(t.media("a.mp4"))
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
    late_lock(t, d, hd, a0, mine)
    spot_taken(t, d, hd, idx, a0, mine)

    # ---- after unlocking the same edit goes through; removing a locked track is allowed
    d.set_track(v1, locked=False)
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


def late_lock(t, d, hd, a0, mine):
    """A reverse of a picture with its linked sound on a0; a0 is locked while the bake runs: the bake's result cannot
    be placed (it would change the locked sound), so the reverse ends in an error and leaves nothing."""
    R = d.place_clip(hd, "v0", 300, 0, 180)
    Ra = d.place_clip(hd, a0, 300, 0, 180)
    d.link_clips([R, Ra])
    st0 = d.get_state()
    before = E.files(t, mine)
    job = d.reverse_clip(R, wait=False)
    d.set_track(a0, locked=True)
    during = next((j for j in d.jobs() if j.get("job") == job), None)
    end = E.wait_job(d, job) if job else None
    d.set_track(a0, locked=False)
    st = d.get_state()
    left = E.left_media(t, before, mine)
    ran = bool(during) and during.get("status") == "running"
    t.check("a reverse whose linked sound's track is locked while it bakes ends in an error and leaves the project "
            "as it was",
            ran and bool(end) and end.get("status") == "error" and st == st0,
            f"running when the lock landed: {ran} ({during}); the job at its end: {end}; State unchanged: {st == st0}")
    t.check("...and leaves no media file behind", ran and not left, f"left: {left}")
    d.remove_clip(R)


def spot_taken(t, d, hd, idx, a0, mine):
    """A J-cut (the sound starts 10 frames before the picture) is reversed: its sound becomes an L-cut tail, [610, 790)
    on a0. While the bake runs, Q is moved into that spot (775, beside the sound where it is now): the result cannot
    be placed without an overlap, so the reverse ends in an error and leaves nothing, and no two clips overlap on a0."""
    P = d.place_clip(hd, "v0", 600, 0, 180)
    Pa = d.place_clip(hd, a0, 590, 0, 180)
    d.link_clips([P, Pa])
    Q = d.place_clip(idx, a0, 800, 0, 20)
    st0 = d.get_state()
    before = E.files(t, mine)
    job = d.reverse_clip(P, wait=False)
    d.move_clip(Q, 775)
    during = next((j for j in d.jobs() if j.get("job") == job), None)
    end = E.wait_job(d, job) if job else None
    st1 = d.get_state()
    d.move_clip(Q, 800)
    st = d.get_state()
    left = E.left_media(t, before, mine)
    ran = bool(during) and during.get("status") == "running"
    t.check("a reverse whose J-cut sound's new spot is taken while it bakes ends in an error, leaves no media file and "
            "the project as it was",
            ran and bool(end) and end.get("status") == "error" and st == st0 and not left,
            f"running when the move landed: {ran} ({during}); the job at its end: {end}; State unchanged: "
            f"{st == st0}; left: {left}")
    t.check("...and no two clips overlap on a0 meanwhile", not E.overlaps(E.clips(st1, a0)), E.spans(st1, a0))
    d.remove_clip(P)
    d.remove_clip(Q)
