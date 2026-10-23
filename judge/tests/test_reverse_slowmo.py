"""reverse_clip and smooth_slow_motion, judged on get_state and on the editor's exports: a reversed clip shows every
frame once in reverse order and its sound runs backwards in sync, a second call restores it without a new bake (also
after a trim, and after an fps change), the sound can be muted, one undo restores, a canceled bake leaves nothing,
a clip whose sound outlasts its picture stays in sync reversed, a cutout keeps its transparency; smooth slow motion
keeps the timeline's length, repeats no frame (not even at the end of the file, and inside it), keeps the source
frames where they fall, keeps the sound's pitch and its end, refuses at 1x, undoes and cancels cleanly; with linked
clips, the picture's sound is reversed with it in sync (a J-cut becomes an L-cut, refused when that would run into
another clip, linked false or reversing the sound as asked), and smooth slow motion takes the plain linked sound
along while a J/L-cut partner keeps its speed ratio. Port of the reverse_clip, smooth_slow_motion and linked-clip
sections of packages/core/scripts/smoke-time.ts (its second, third and fifth; judge/PORTING.md has the map; its
freeze_frame sections are tests/test_freeze.py).

Media: idx.mp4 (180x90 30 fps, 16 s: frames that show their index, a chirp whose pitch says its source moment),
skew.mp4 (3.0 s of those frames, 3.5 s of the chirp), cutout.mkv (2 s of those frames, the top half transparent),
fx-base.mp4 (0xE020E0, under the cutout), move.mp4 (moving 320x180 30 fps, 3 s, a 440 Hz tone), a.mp4 (1280x720, 6 s)
and long.mp4 (1920x1080, 20 s), whose bakes are canceled while they run: the second 10 s of long.mp4 reversed (about
4 s on v0.2.0) and the first 3 s of a.mp4 in optical flow at 0.5x (about 25 s). The canvas is 180x90 at 30 fps.

A cancel is judged on what follows it, not on its answer (which may come before the work has stopped): the job must
end canceled with the State as before and no new media file, and stay so: the clip is left in place for one and a
half times a full bake of the same media, and 2 s more, after the cancel answered, and then the job must not have
turned done, the State must still be as before and no media file may have appeared (a bake that went on and placed or
kept its copy fails). How long a full bake takes is measured just before, on a clean bake of the other half of the
same file (the first 10 s of long.mp4; the second 3 s of a.mp4 at 0.5x, which take longer in optical flow than the
first, about 38 s on v0.2.0): the same length, another span, so a copy of it cannot be handed to the canceled bake. A bake that had already ended done when the judge was about to cancel it could not be judged,
and its checks are recorded as not applicable (run.py --strict fails them).

A new bake is seen in get_state (the clip plays an asset that was not there before); what it holds is read from an
export, never from the editor's own files; a bake that leaves something behind is seen as a new media file in the
test's folder (edits.left_media). A repeated frame is one whose mean grey difference from the one before is under
0.05 (on 160x90 grey pictures of the export); the plain 0.5x control repeats every other frame.

Every check is recorded on every path (a check whose input is missing fails with the reason), so CHECKS is exact.
"""
import os
import time

import edits as E
import observe

PORT_BOUND = True
EXTRA_MEDIA = ("idx.mp4", "move.mp4", "long.mp4", "skew.mp4", "cutout.mkv")   # the optional fixtures it uses (run.py)
TIMEOUT = 1200
FPS = 30
TOL = 1.0 / FPS + 0.012
BASE = (0xE0, 0x20, 0xE0)
ORDINAL = {2: "second", 4: "fourth"}
CHECKS = 12 + 6 + (3 + 2 * 4 + 3) + 4 * 2 + 15   # reverse, skew and cutout, slow motion, inside, linked


def run(t):
    d = t.driver()
    d.set_project(width=180, height=90, fps=FPS)
    m = {k: d.import_media(t.media(f)) for k, f in (("idx", "idx.mp4"), ("move", "move.mp4"), ("hd", "a.mp4"),
                                                    ("long", "long.mp4"), ("skew", "skew.mp4"),
                                                    ("cut", "cutout.mkv"), ("base", "fx-base.mp4"))}
    a0 = d.add_track("audio")
    v1 = d.add_track("video")
    mine = [os.path.dirname(t.path("out", "x")), os.path.dirname(t.path("frames", "x"))]
    reverse(t, d, m, mine)
    skew_and_alpha(t, d, m, v1)
    slow_motion(t, d, m, mine)
    inside(t, d, m)
    linked(t, d, m, a0, mine)


def export(t, d, name, row=None):
    """(frame indexes, samples or None, why) of an export of the timeline."""
    out = t.path("out", f"{name}.mp4")
    job = d.export(out)
    if job.get("status") != "done":
        return None, None, job
    try:
        frames = observe.frame_indexes(out, row=row)
        snd = observe.samples(out) if observe.audio_stream(out) is not None else None
        return frames, snd, None
    except observe.Unmeasurable as e:
        return None, None, str(e)


def export_path(t, d, name):
    out = t.path("out", f"{name}.mp4")
    job = d.export(out)
    return out if job.get("status") == "done" else None


def measured(d, place, bake):
    """(seconds, why) that a clean bake takes (edits.bake_time): bake(clip) (wait true) of the clip place() puts on the
    timeline, which is then removed."""
    ref = place()
    try:
        return E.bake_time(lambda: bake(ref))
    finally:
        if E.clip(d.get_state(), ref) is not None:
            d.remove_clip(ref)


def canceled_bake(t, d, full, why, start, pause, mine, names):
    """A bake started with start() (-> its job), canceled `pause` s later: it must end canceled, with the State as
    before and no new media file (names[0], names[1]), and stay so (names[2], edits.stays_stopped: the clip stays in
    place for edits.hold(full) s after the cancel answered, `full` being how long a full bake of the same media takes,
    measured() or None with `why`; then the job is not done, the State is as before and no media file appeared). When
    the bake had already ended done just before the cancel, the cancel could not land during it, and the three checks
    are not applicable (edits.too_fast)."""
    sb = d.get_state()
    files = E.files(t, mine)
    job = start()
    time.sleep(pause)
    was = E.job_now(d, job)
    if was and was.get("status") == "done":
        E.too_fast(t, names, was, "canceled it")
        return
    canceled = d.cancel(job) if job else False
    since = time.monotonic()
    end = E.wait_job(d, job) if job else None
    st = d.get_state()
    left = E.left_media(t, files, mine)
    t.check(names[0], canceled and bool(end) and end.get("status") == "canceled" and st == sb,
            f"running just before the cancel: {was}; cancel answered {canceled}; the job {end}; State unchanged: "
            f"{st == sb}")
    t.check(names[1], not left, left)
    ok, detail = E.stays_stopped(t, d, job, sb, files, mine, full, since, why)
    t.check(names[2], ok and bool(end) and end.get("status") == "canceled", detail)


# ---------------------------------------------------------------- reverse_clip
def reverse(t, d, m, mine):
    idx = m["idx"]
    clip = d.place_clip(idx, "v0", 0, 10, 110)       # 100 frames: more than one 2 s piece of a bake
    st0 = d.get_state()
    d.reverse_clip(clip)
    st1 = d.get_state()
    c = E.clip(st1, clip)
    t.check("reverse_clip: the clip plays a new asset (the reversed copy), the same 100 frames at the same place",
            c["asset"] != idx and c["asset"] in E.new_assets(st0, st1) and (c["start_frame"], c["length_frames"])
            == (0, 100), c)
    frames, snd, why = export(t, d, "reverse")
    t.check("the export has 100 frames and frame N shows source frame 109 - N, every one",
            frames is not None and frames == [109 - n for n in range(100)],
            why or (len(frames), [n for n in range(min(100, len(frames))) if frames[n] != 109 - n][:10]))
    offs = [E.sound_offset(snd, tm, lambda x: 110 / FPS - x) if snd else None for tm in (0.3, 1.6, 3.0)]
    t.check("the sound runs backwards with the picture (at 0.3, 1.6 and 3.0 s it plays the moment shown)",
            all(o is not None and abs(o) <= TOL for o in offs), [E.ms(o) for o in offs])
    before = E.files(t, mine)
    d.reverse_clip(clip)
    st2 = d.get_state()
    c = E.clip(st2, clip)
    t.check("a second reverse_clip restores the original media and range (10..110)",
            (c["asset"], c["in_frame"], c["out_frame"]) == (idx, 10, 110), c)
    left = E.left_media(t, before, mine)
    t.check("...without a new bake: no new asset and no new media file", not E.new_assets(st1, st2) and not left,
            (E.new_assets(st1, st2), left))
    d.reverse_clip(clip)
    d.trim_clip(clip, in_frame=20, out_frame=80)
    d.reverse_clip(clip)
    c = E.clip(d.get_state(), clip)
    t.check("un-reversing after a trim of the reversed copy (20..80) maps the trim back (original 30..90)",
            (c["asset"], c["in_frame"], c["out_frame"]) == (idx, 30, 90), c)
    d.reverse_clip(clip, audio="mute")
    frames, snd, why = export(t, d, "reverse-mute")
    quiet = observe.rms(snd, 0.1, 1.9) if snd is not None else 0.0
    t.check("reverse with the sound muted: the export is silent and shows the 60 frames reversed (89 .. 30)",
            frames is not None and frames == [89 - n for n in range(60)] and quiet < 0.01,
            why or (len(frames), frames[:3], frames[-3:], quiet))
    d.undo()
    before_st = d.get_state()
    d.reverse_clip(clip)
    d.undo()
    t.check("one undo restores the clip as it was before the reverse", d.get_state() == before_st, "")
    # A cancel while the bake runs (10 s of 1080p: about 4 s to bake), after a clean bake of the other 10 s.
    full, why = measured(d, lambda: d.place_clip(m["long"], "v0", 200, 0, 300), d.reverse_clip)
    hdc = d.place_clip(m["long"], "v0", 200, 300, 600)
    canceled_bake(t, d, full, why, lambda: d.reverse_clip(hdc, wait=False), 0, mine,
                  ["a reverse canceled while it bakes ends canceled, and the project is as it was",
                   "...and no media file is left",
                   "...and it stays canceled: left in place for longer than a full bake of the same media takes, the "
                   "clip still plays its own media and no media file appears"])
    E.clear(d)
    # Un-reverse after an fps change.
    rc = d.place_clip(idx, "v0", 0, 10, 110)
    d.reverse_clip(rc)
    d.set_project(fps=60)
    d.reverse_clip(rc)
    c = E.clip(d.get_state(), rc)
    t.check("un-reversing after a 30 to 60 fps change restores the same span (20..220 at 60 fps)",
            (c["asset"], c["in_frame"], c["out_frame"]) == (idx, 20, 220), c)
    d.set_project(fps=FPS)
    E.clear(d)


def skew_and_alpha(t, d, m, v1):
    # The sound outlasts the picture (3.5 s against 3.0 s).
    sc = d.place_clip(m["skew"], "v0", 0, 0)
    span = E.clip(d.get_state(), sc)["length_frames"]
    d.reverse_clip(sc)
    frames, snd, why = export(t, d, "skew")
    t.check("a clip whose sound outlasts its picture is placed whole (104 or 105 frames) and reversed whole",
            span in (104, 105) and frames is not None and len(frames) == span, why or (span, len(frames)))
    ok = frames is not None and len(frames) == span and frames[0] == 89 and frames[14] == 89 \
        and frames[20] == span - 21 and frames[60] == span - 61
    t.check("...the reversed picture stays on the sound's time: the missing picture comes first (frame 89 held), then "
            "frame N shows span - 1 - N", ok, why or (frames[:3], frames[13:16], frames[20], frames[60]))
    offs = [E.sound_offset(snd, tm, lambda x: span / FPS - x) if snd else None for tm in (1.0, 2.0)]
    t.check("...and its sound runs backwards in sync (at 1.0 and 2.0 s)",
            all(o is not None and abs(o) <= TOL for o in offs), [E.ms(o) for o in offs])
    E.clear(d)
    # A cutout keeps its transparency: the track below shows through its top half.
    d.place_clip(m["base"], "v0", 0, 0, 120)
    cc = d.place_clip(m["cut"], v1, 0, 0, 60)
    d.reverse_clip(cc)
    out = export_path(t, d, "cutout-reverse")
    try:
        frames = observe.frame_indexes(out, row=70) if out else None
        top = [observe.block_rgb(out, tm, 80, 10) for tm in (0.2, 1.0, 1.8)] if out else None
    except observe.Unmeasurable as e:
        frames, top = None, str(e)
    t.check("a reversed cutout keeps its transparency: the track below shows in its top half, and its bottom half "
            "shows its 60 frames reversed (59 .. 0)",
            frames is not None and isinstance(top, list) and all(observe.colour_is(c, BASE) for c in top)
            and frames[:60] == [59 - n for n in range(60)],
            (top, frames[:4] if frames else None, frames[56:60] if frames else None))
    d.reverse_clip(cc)
    d.set_speed(cc, 0.5)
    for mode in ("blend", "flow"):
        d.smooth_slow_motion(cc, mode)
        out = export_path(t, d, f"cutout-{mode}")
        try:
            top = [observe.block_rgb(out, tm, 80, 10) for tm in (0.2, 2.0, 3.8)] if out else None
            n = observe.decode(out)["video_frames"] if out else 0
        except observe.Unmeasurable as e:
            top, n = str(e), 0
        t.check(f"smooth slow motion ({mode}) of a cutout keeps its transparency: the track below shows in its top half "
                f"over all its 120 frames",
                isinstance(top, list) and all(observe.colour_is(c, BASE) for c in top) and n == 120, (top, n))
        d.undo()
    E.clear(d)


# ---------------------------------------------------------------- smooth slow motion
def repeats(path):
    """The indexes of the frames of `path` that repeat the one before (mean grey difference under 0.05)."""
    g = observe.grey_frames(path)
    return [k for k in range(1, len(g)) if observe.mean_abs_diff(g[k - 1], g[k]) < 0.05], len(g)


def slow_motion(t, d, m, mine):
    clip = d.place_clip(m["move"], "v0", 0, 0, 90)
    ok, why = E.refused_unchanged(d, lambda: d.smooth_slow_motion(clip, "blend"))
    t.check("smooth_slow_motion of a clip at 1x: refused, nothing changes", ok, why)
    d.set_speed(clip, 0.5)
    t.check("at 0.5x the clip is 180 frames", E.clip(d.get_state(), clip)["length_frames"] == 180,
            E.spans(d.get_state(), "v0"))
    out = export_path(t, d, "plain-half")
    try:
        ctrl, n = repeats(out) if out else ([], 0)
    except observe.Unmeasurable as e:
        ctrl, n = [], str(e)
    t.check("control: the plain 0.5x export repeats frames (at least 60 of its 179 pairs)", len(ctrl) >= 60,
            f"{len(ctrl)} repeats in {n} frames")
    for mode in ("blend", "flow"):
        st0 = d.get_state()
        d.smooth_slow_motion(clip, mode)
        st = d.get_state()
        c = E.clip(st, clip)
        t.check(f"{mode}: the clip plays a new asset at 1x and the timeline keeps its length (180 frames)",
                c["asset"] in E.new_assets(st0, st) and c["speed"] == 1 and c["length_frames"] == 180
                and st["length_frames"] == st0["length_frames"], c)
        out = export_path(t, d, f"smooth-{mode}")
        try:
            rep, n = repeats(out) if out else (["no export"], 0)
            snd = observe.samples(out) if out else None
        except observe.Unmeasurable as e:
            rep, n, snd = [str(e)], 0, None
        t.check(f"{mode}: the export has 180 frames, none the same as the one before (not even at the end)",
                n == 180 and not rep, f"{n} frames; repeats at {rep[:20]}")
        f = observe.pitch(snd, 1.4, 1.6) if snd else None
        end_rms = observe.rms(snd, 5.75, 5.9) if snd else 0
        t.check(f"{mode}: the sound is slowed with its pitch kept (440 Hz) and heard to the end of the 6 s",
                f is not None and abs(f - 440) < 15 and end_rms > 0.02, (f, end_rms))
        d.undo()
        t.check(f"{mode}: one undo restores the original clip at 0.5x", d.get_state() == st0, "")
    # A cancel while optical flow runs (3 s of 720p at 0.5x: about 25 s), after a clean bake of the other 3 s (the
    # second, which takes longer: about 38 s).
    def slowed(a, b):
        c = d.place_clip(m["hd"], "v0", 400, a, b)
        d.set_speed(c, 0.5)
        return c
    full, why = measured(d, lambda: slowed(90, 180), lambda c: d.smooth_slow_motion(c, "flow"))
    hdc = slowed(0, 90)
    canceled_bake(t, d, full, why, lambda: d.smooth_slow_motion(hdc, "flow", wait=False), 0.3, mine,
                  ["a smooth slow motion (flow) canceled while it bakes ends canceled and leaves the clip alone (0.5x)",
                   "...and no media file is left",
                   "...and it stays canceled: left in place for longer than a full bake of the same media takes, the "
                   "clip still plays its own media at 0.5x and no media file appears"])
    E.clear(d)


def inside(t, d, m):
    """A span inside the file (source 15..60 of 90): the frame count is the clip's length, no frame repeats, blend keeps
    the source frames where they fall (every 1/speed-th frame), and the sound runs to the end."""
    ref_clip = d.place_clip(m["move"], "v0", 0, 15, 60)
    ref = export_path(t, d, "inside-ref")         # the span at 1x: its frame k is source frame 15 + k
    try:
        ref_g = observe.grey_frames(ref) if ref else []
    except observe.Unmeasurable:
        ref_g = []
    d.remove_clip(ref_clip)
    for speed in (0.5, 0.25):
        for mode in ("blend", "flow"):
            clip = d.place_clip(m["move"], "v0", 0, 15, 60)
            d.set_speed(clip, speed)
            want = round(45 / speed)
            d.smooth_slow_motion(clip, mode)
            out = export_path(t, d, f"inside-{speed}-{mode}")
            try:
                g = observe.grey_frames(out) if out else []
                snd = observe.samples(out) if out else None
            except observe.Unmeasurable:
                g, snd = [], None
            rep = [k for k in range(1, len(g)) if observe.mean_abs_diff(g[k - 1], g[k]) < 0.05]
            step = round(1 / speed)
            off = []
            if mode == "blend":
                for k in (0, 11, 29, 44):
                    if k * step >= len(g) or k >= len(ref_g) or observe.mean_abs_diff(g[k * step], ref_g[k]) > 3:
                        off.append(k)
            t.check(f"{speed}x {mode}: {want} frames (the clip's length), none repeated"
                    + (f", every {ORDINAL[step]} frame the source frame" if mode == "blend" else ""),
                    len(g) == want and not rep and not off, f"{len(g)} frames; repeats {rep[:10]}; off at {off}")
            tail = observe.rms(snd, want / FPS - 0.2, want / FPS - 0.1) if snd else 0
            t.check(f"{speed}x {mode}: the sound runs to the end (heard 0.1 s before it)", tail > 0.02, tail)
            d.undo()
            d.remove_clip(clip)


# ---------------------------------------------------------------- linked clips
def linked(t, d, m, a0, mine):
    idx, mov = m["idx"], m["move"]
    E.clear(d)
    d.set_track("v0", muted=True)
    pic = d.place_clip(idx, "v0", 0, 0, 120)
    snd = d.place_clip(idx, a0, 0, 0, 120)
    d.link_clips([pic, snd])
    st0 = d.get_state()
    d.reverse_clip(pic)
    st1 = d.get_state()
    p, s = E.clip(st1, pic), E.clip(st1, snd)
    t.check("reversing a picture reverses its linked sound with it, in place (both play a new asset)",
            p["asset"] != idx and s["asset"] != idx and s["start_frame"] == 0 and p["start_frame"] == 0, (p, s))
    frames, sound, why = export(t, d, "rev-linked")
    offs = [E.sound_offset(sound, tm, lambda x: 120 / FPS - x) if sound else None for tm in (0.5, 2.0, 3.5)]
    t.check("...picture and sound run backwards together (frame 0 shows 119, frame 60 shows 59; the sound plays the "
            "moment shown at 0.5, 2.0 and 3.5 s)",
            frames is not None and frames[0] == 119 and frames[60] == 59
            and all(o is not None and abs(o) <= TOL for o in offs),
            why or (frames[0], frames[60], [E.ms(o) for o in offs]))
    d.reverse_clip(pic)
    st2 = d.get_state()
    t.check("calling it again restores both, without a new asset",
            E.clip(st2, pic)["asset"] == idx and E.clip(st2, snd)["asset"] == idx and not E.new_assets(st1, st2), "")
    d.reverse_clip(pic, linked=False)
    st3 = d.get_state()
    t.check("linked false reverses only the picture", E.clip(st3, pic)["asset"] != idx
            and E.clip(st3, snd)["asset"] == idx, (E.clip(st3, pic)["asset"], E.clip(st3, snd)["asset"]))
    d.undo()
    sb = d.get_state()
    d.reverse_clip(snd)
    t.check("reverse_clip on the linked sound reverses its picture too", E.clip(d.get_state(), pic)["asset"] != idx,
            E.clip(d.get_state(), pic))
    d.undo()
    t.check("one undo restores both", d.get_state() == sb, "")
    # A J-cut (the sound starts 10 frames early) becomes an L-cut when reversed.
    d.remove_clip(pic)
    p2 = d.place_clip(idx, "v0", 30, 30, 120)
    s2 = d.place_clip(idx, a0, 20, 20, 120)
    d.link_clips([p2, s2])
    blocker = d.place_clip(idx, a0, 125, 0, 10)
    files = E.files(t, mine)
    ok, why = E.refused_unchanged(d, lambda: d.reverse_clip(p2))
    left = E.left_media(t, files, mine)
    t.check("a reversed J-cut whose sound would run into the next sound clip: refused, nothing changes, no media file",
            ok and not left, f"{why}; left {left}")
    d.remove_clip(blocker)
    d.reverse_clip(p2)
    st = d.get_state()
    t.check("its 10-frame J-cut head is now a 10-frame L-cut tail (the sound [30,130), the picture [30,120))",
            (E.clip(st, s2)["start_frame"], E.end(E.clip(st, s2))) == (30, 130)
            and (E.clip(st, p2)["start_frame"], E.end(E.clip(st, p2))) == (30, 120), (E.spans(st, "v0"),
                                                                                      E.spans(st, a0)))
    frames, sound, why = export(t, d, "rev-jcut")
    o = E.sound_offset(sound, 2.0, lambda x: 150 / FPS - x) if sound else None
    t.check("...and the reversed pair stays in sync (frame 60 shows 89; at 2 s the sound plays source 3.0 s)",
            frames is not None and frames[60] == 89 and o is not None and abs(o) <= TOL,
            why or (frames[60], E.ms(o)))
    d.undo()
    # Smooth slow motion: the plain linked sound moves onto the new asset; a J/L-cut partner keeps its speed ratio.
    E.clear(d)
    p3 = d.place_clip(idx, "v0", 0, 0, 60)
    s3 = d.place_clip(idx, a0, 0, 0, 60)
    d.link_clips([p3, s3])
    d.set_speed(p3, 0.5)
    d.smooth_slow_motion(p3, "blend")
    st = d.get_state()
    p, s = E.clip(st, p3), E.clip(st, s3)
    t.check("smooth slow motion takes the plain linked sound along: it plays a new asset at 1x, as long as the picture",
            s["asset"] != idx and p["asset"] != idx and s["speed"] == 1 and s["start_frame"] == p["start_frame"]
            and s["length_frames"] == p["length_frames"] == 120, (p, s))
    _, sound, why = export(t, d, "slowmo-linked")
    offs = [E.sound_offset(sound, tm, lambda x: x / 2) if sound else None for tm in (0.5, 2.0, 3.5)]
    t.check("...and it is the slowed sound, in sync: at 0.5, 2.0 and 3.5 s it plays source 0.25, 1.0 and 1.75 s",
            all(o is not None and abs(o) <= TOL for o in offs), why or [E.ms(o) for o in offs])
    d.set_speed(p3, 2)
    st = d.get_state()
    t.check("...and a later speed change keeps picture and sound together (both 2x, the same length)",
            E.clip(st, s3)["speed"] == 2 and E.clip(st, s3)["length_frames"] == E.clip(st, p3)["length_frames"],
            (E.clip(st, p3), E.clip(st, s3)))
    E.clear(d)
    p4 = d.place_clip(mov, "v0", 20, 10, 60)
    s4 = d.place_clip(mov, a0, 10, 5, 60)              # 5 source frames of J-cut head
    d.link_clips([p4, s4])
    d.set_speed(p4, 0.5)
    sb = d.get_state()
    d.smooth_slow_motion(p4, "blend")
    st = d.get_state()
    s = E.clip(st, s4)
    t.check("a J-cut partner keeps its speed (0.5x) and its place: still in sync",
            s["asset"] == mov and s["speed"] == 0.5 and E.clip(st, p4)["start_frame"] == E.clip(sb, p4)["start_frame"]
            and s["start_frame"] == E.clip(sb, s4)["start_frame"], s)
    d.set_speed(p4, 2)
    st = d.get_state()
    p, s = E.clip(st, p4), E.clip(st, s4)
    t.check("a later 2x keeps the speed ratio: the picture 2x of its 0.5x bake, the sound at 1x, in sync (it plays "
            "source frame 10 at the picture's start)",
            s["speed"] == 1 and s["in_frame"] + (p["start_frame"] - s["start_frame"]) == 10, (p, s))
    ok, why = E.refused_unchanged(d, lambda: d.set_speed_ramp(p4, preset="montage"))
    t.check("a speed ramp on such a pair (it cannot keep the ratio): refused, nothing changes", ok, why)
    E.clear(d)
