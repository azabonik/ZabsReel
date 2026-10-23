"""Frame-accurate cuts on constant-speed clips: split_clip, cut_range and ripple_delete at 0.25x to 4x (what get_state
reports), the export of a split clip's pieces spread one black frame apart, freeze_frame at constant speeds (at 30 fps
and at 29.97 fps on a 1/30000 timebase), and render_frame against the export. Port of
packages/core/scripts/smoke-cuts.ts (judge/PORTING.md has the map of its sections).

Media: idx.mp4 and idx2997.mp4 (fixtures/make.sh): 180x90, 16 s, every frame shows its own index in nine stripes, so
observe.frame_indexes reads back which source frame an exported or rendered frame shows. The canvas is 180x90.

The speed rule the exports are held to (no model of the editor; edits.speed_rule_problems): a clip at constant speed s
with source range [in, out) shows, at its timeline frame n, a source frame inside [in, out), never an earlier one than
at frame n - 1, and the source frame that plays at the middle of that frame: exactly in + floor((n + 1/2) * s) on a
whole clip (one placed and set to its speed as a whole: the freeze references and the render_frame layout). Where
(n + 1/2) * s is a whole number (at 2x and 4x) two source frames meet at the middle and either may show (v0.2.0 shows
the earlier one on idx.mp4 and the later one on idx2997.mp4's 1/30000 timebase: in + 4n + 2 at 4x). A piece of a split
clip may start part of a source frame into its in point, which get_state does not show, so the pieces are held to
in + n at 1x and within max(1, s / 2) source frames of in + n * s at another speed. Splits, cuts and ripple deletes
are held to what a user sees: the pieces butt, the right half ends where the clip did, the next clip closes up, no
empty piece, a one-frame head or tail stays, and at 1x, 2x, 3x and 4x a split lands exactly where asked. A split that
would leave a half with no source frame may be declined, changing nothing (the original counts only the splits that
happen); nine in ten must happen. A freeze (0.25x to 4x) holds exactly the frame the export shows at that moment, and
render_frame shows exactly the exported frame at the start, the middle and the end of each frame period, before and
after a preview render, and the last frame past the end.

Every check is recorded on every path (a check whose input is missing fails with the reason), so CHECKS is exact.
"""
import os

import edits as E
import observe

PORT_BOUND = True
EXTRA_MEDIA = ("idx.mp4", "idx2997.mp4")   # the optional fixtures it uses (run.py)
TIMEOUT = 1500

W, H, FPS = 180, 90, 30
SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4]
RD_SPEEDS = [0.25, 0.75, 1.5]
PIECE_SPEEDS = [0.25, 0.5, 0.75, 1.5, 2, 4]
FREEZE_SPEEDS = [0.25, 0.5, 0.75, 1.5, 2, 3, 4]
FREEZE_AT = [1, 2, 3, 4, 5, 6, 7, 8, 10, 21]   # 4 and 8: at 0.25x a picture one frame late shows there
FREEZE_LEN = 6      # frames (0.2 s at 30 fps)
PERIOD = (0, 0.5, 0.95)  # where in a frame period render_frame is asked

CHECKS = (len(SPEEDS) + len(SPEEDS) + 3 + len(RD_SPEEDS) + len(PIECE_SPEEDS)
          + 2 * len(FREEZE_SPEEDS) * 2 + (1 + 2 * 2) + (1 + 2))


def is_int(s):
    return float(s) == int(s)


def rule_problems(idx, c, whole=True):
    """Where the export `idx` breaks the speed rule (module docstring) for the clip `c` (a State clip; whole False: a
    piece of a split clip): [text]."""
    return E.speed_rule_problems(idx, c, whole=whole)


def run(t):
    d = t.driver()
    d.set_project(width=W, height=H, fps=FPS)
    coded = d.import_media(t.media("idx.mp4"))
    upper = d.add_track("video")

    def setup(speed, src_in=30, src_out=90):
        """The clip at `speed`, and a butted neighbour showing source 1..30 (an exported 0 is then a gap)."""
        E.clear(d)
        c = d.place_clip(coded, "v0", 0, src_in, src_out)
        d.set_speed(c, speed)
        dur = E.clip(d.get_state(), c)["length_frames"]
        nxt = d.place_clip(coded, "v0", dur, 1, 31)
        return c, dur, nxt

    splits(t, d, setup)
    cuts(t, d, setup)
    ripple_deletes(t, d, setup, coded, upper)
    pieces(t, d, coded)
    frames(t, d, coded, FPS, "30 fps", ["segment", "preview"])
    freezes(t, d, coded, FPS, "30 fps")
    E.clear(d)
    d.set_project(fps=29.97)
    ntsc = d.import_media(t.media("idx2997.mp4"))
    freezes(t, d, ntsc, 29.97, "29.97 fps (1/30000)")
    frames(t, d, ntsc, 29.97, "29.97 fps (1/30000)", ["segment"])


# ---------------------------------------------------------------- 1. splits
def splits(t, d, setup):
    for speed in SPEEDS:
        c, dur, nxt = setup(speed)
        st0 = d.get_state()
        c0 = E.clip(st0, c)
        n = bad = moved = worst = 0
        notes = []
        for at in range(2, dur - 1):
            d.split_clip(c, at)
            st = d.get_state()
            parts = [x for x in E.clips(st, "v0") if x["id"] != nxt]
            if len(parts) == 1 and st == st0:
                pass  # a split that would leave a half without a source frame is not made (and changes nothing)
            elif len(parts) != 2:
                bad += 1
                notes.append(f"at {at}: {len(parts)} pieces")
            else:
                n += 1
                left, right = parts
                if E.end(left) != right["start_frame"] or E.end(right) != dur or left["start_frame"] != 0:
                    bad += 1
                    notes.append(f"at {at}: {E.spans(st, 'v0')}")
                if is_int(speed) and (right["start_frame"] != at
                                      or right["in_frame"] != c0["in_frame"] + round(at * speed)):
                    moved += 1
                    notes.append(f"at {at}: right half at {right['start_frame']} from source {right['in_frame']}")
                worst = max(worst, abs(right["start_frame"] - at))
            d.undo()
            if d.get_state() != st0:
                bad += 1
                notes.append(f"at {at}: undo did not restore the clip")
        t.check(f"{speed}x: split_clip at every frame of the clip: the halves butt and the right half ends where the "
                f"clip did" + ("; exactly where asked" if is_int(speed) else "") + "; one undo restores the clip",
                n >= (dur - 3) * 0.9 and bad == 0 and moved == 0,
                f"{n} splits at 2..{dur - 2}, {bad} bad, {moved} moved, worst {worst} frame(s) from the request; "
                f"{E.short(notes)}")


# ---------------------------------------------------------------- 2. cut_range
def cuts(t, d, setup):
    for speed in SPEEDS:
        c, dur, nxt = setup(speed)
        st0 = d.get_state()
        cases = bad = 0
        notes = []
        for s0 in range(0, dur, 7):
            for e0 in range(s0 + 1, dur + 1, 5):
                cases += 1
                d.cut_range(c, s0, e0)
                st = d.get_state()
                parts = [x for x in E.clips(st, "v0") if x["id"] != nxt]
                n = E.clip(st, nxt)
                last = E.end(parts[-1]) if parts else 0
                if n is None or not E.butted(parts) or last != n["start_frame"] or (parts and parts[0]["start_frame"])\
                        or any(p["out_frame"] <= p["in_frame"] or p["length_frames"] < 1 for p in parts):
                    bad += 1
                    notes.append(f"[{s0},{e0}): {E.spans(st, 'v0')}")
                d.undo()
                if d.get_state() != st0:
                    bad += 1
                    notes.append(f"[{s0},{e0}): undo did not restore the clip")
        t.check(f"{speed}x: cut_range over a grid of ranges (from every 7th frame to every 5th): the pieces butt, the "
                f"next clip closes up exactly, no empty piece; one undo restores the clip", bad == 0 and cases > 5,
                f"{cases} ranges, {bad} bad; {E.short(notes)}")
    # A one-frame tail or head left by a cut stays (no gap); at 0.25x a head too short to hold a source frame goes.
    c, dur, nxt = setup(1)
    d.cut_range(c, 10, dur - 1)
    st = d.get_state()
    parts = [x for x in E.clips(st, "v0") if x["id"] != nxt]
    t.check("1x: cut_range leaving a one-frame tail keeps it, on the clip's last source frame, and the next clip "
            "follows it at frame 11 (no gap)",
            len(parts) == 2 and parts[1]["length_frames"] == 1 and parts[1]["in_frame"] == 89
            and E.end(parts[1]) == E.clip(st, nxt)["start_frame"] == 11,
            [(p["start_frame"], p["in_frame"], p["out_frame"]) for p in parts])
    d.undo()
    d.cut_range(c, 1, 30)
    st = d.get_state()
    parts = [x for x in E.clips(st, "v0") if x["id"] != nxt]
    t.check("1x: cut_range leaving a one-frame head keeps it at the clip's start (no gap)",
            len(parts) == 2 and parts[0]["start_frame"] == 0 and parts[0]["length_frames"] == 1
            and parts[1]["start_frame"] == 1 and E.end(parts[1]) == E.clip(st, nxt)["start_frame"],
            [(p["start_frame"], p["in_frame"], p["out_frame"]) for p in parts])
    c, dur, nxt = setup(0.25)
    d.cut_range(c, 1, 40)  # one timeline frame is a quarter of a source frame: it goes with the cut
    st = d.get_state()
    parts = [x for x in E.clips(st, "v0") if x["id"] != nxt]
    t.check("0.25x: a head too short to hold a source frame goes with the cut (one piece, at 0, no gap)",
            len(parts) == 1 and parts[0]["start_frame"] == 0 and E.end(parts[0]) == E.clip(st, nxt)["start_frame"],
            [(p["start_frame"], p["in_frame"], p["out_frame"]) for p in parts])


# ---------------------------------------------------------------- 3. ripple_delete on two tracks
def ripple_deletes(t, d, setup, coded, upper):
    for speed in RD_SPEEDS:
        c, dur, nxt = setup(speed)
        c0 = E.clip(d.get_state(), c)
        twin = d.place_clip(coded, upper, 0, c0["in_frame"], c0["out_frame"])
        d.set_speed(twin, speed)
        st0 = d.get_state()
        total = (lambda st, tr: sum(x["length_frames"] for x in E.clips(st, tr)))
        l0, l1 = total(st0, "v0"), total(st0, upper)
        bad, notes, removed = 0, [], 0
        for s0, e0 in [(5, 17), (22, 23), (9, 31), (1, 6), (30, dur - 1), (0, 2), (dur - 2, dur)]:
            d.ripple_delete([("v0", s0, e0), (upper, s0, e0)])
            st = d.get_state()
            a = [x for x in E.clips(st, "v0") if x["id"] != nxt]
            b = E.clips(st, upper)
            empty = [x for x in a + b if x["out_frame"] <= x["in_frame"] or x["length_frames"] < 1]
            removed += l0 - total(st, "v0")
            if not (a and b and E.butted(a) and E.butted(b) and not empty
                    and l0 - total(st, "v0") == l1 - total(st, upper) >= 0
                    and E.end(a[-1]) == E.clip(st, nxt)["start_frame"]):
                bad += 1
                notes.append(f"[{s0},{e0}): v0 {E.spans(st, 'v0')}, {upper} {E.spans(st, upper)}")
            d.undo()
            if d.get_state() != st0:
                bad += 1
                notes.append(f"[{s0},{e0}): undo did not restore both tracks")
        t.check(f"{speed}x: ripple_delete of the same ranges on two tracks: both lose the same frames, the pieces stay "
                f"butted on both (no empty piece, also at the clip's edges), the next clip closes up; one undo "
                f"restores both", bad == 0 and removed > 0, f"{removed} frames removed in all, {bad} bad; "
                                                            f"{E.short(notes)}")


# ---------------------------------------------------------------- 4. the exported pieces
def pieces(t, d, coded):
    for speed in PIECE_SPEEDS:
        E.clear(d)
        c = d.place_clip(coded, "v0", 0, 31, 91 if speed < 1 else 331)
        d.set_speed(c, speed)
        dur = E.clip(d.get_state(), c)["length_frames"]
        for k in range(1, 6):
            at = round(dur * k / 6) + k % 3
            host = next((x for x in E.clips(d.get_state(), "v0") if x["start_frame"] < at < E.end(x)), None)
            if host is not None:
                d.split_clip(host["id"], at - host["start_frame"])
        ps = E.clips(d.get_state(), "v0")
        for i in range(len(ps) - 1, 0, -1):  # spread them one black frame apart, from the last one
            d.move_clip(ps[i]["id"], ps[i]["start_frame"] + i)
        placed = E.clips(d.get_state(), "v0")
        out = t.path("out", f"pieces-{speed}.mp4")
        job = d.export(out)
        try:
            idx = observe.frame_indexes(out) if job.get("status") == "done" else None
        except observe.Unmeasurable as e:
            idx, job = None, {"status": f"unmeasurable: {e}"}
        if idx is None:
            t.check(f"{speed}x: the six pieces of a split clip, one black frame apart, export exactly their "
                    f"lengths and the speed rule's frames" + (" (no source frame lost)" if speed < 1 else ""), False,
                    f"no export: {job}")
            continue
        bad = [x for p in placed for x in rule_problems(idx, p, whole=False)]
        gaps = [E.end(p) for p in placed[:-1] if E.end(p) >= len(idx) or idx[E.end(p)] != 0]
        shown = sorted({idx[f] for p in placed for f in range(p["start_frame"], min(E.end(p), len(idx)))})
        lost = [f for f in range(31, 91) if f not in shown] if speed < 1 else []
        total = sum(p["length_frames"] for p in placed)
        t.check(f"{speed}x: the six pieces of a split clip, one black frame apart, export exactly their "
                f"lengths and the speed rule's frames" + (" (no source frame lost)" if speed < 1 else ""),
                len(placed) == 6 and not bad and not gaps and not lost and len(idx) == E.end(placed[-1])
                and total == dur,
                f"{len(placed)} pieces {[(p['start_frame'], p['length_frames'], p['in_frame']) for p in placed]}; "
                f"{len(idx)} frames, want {E.end(placed[-1])}; footprints {total} of {dur}; off {E.short(bad, 200)}; "
                f"gaps covered at {gaps}; lost {lost[:10]}")


# ---------------------------------------------------------------- 5. freeze_frame at constant speeds
def freezes(t, d, asset, fps, label):
    for speed in FREEZE_SPEEDS:
        E.clear(d)
        c = d.place_clip(asset, "v0", 0, 31, 91 if speed < 1 else 331)
        d.set_speed(c, speed)
        out = t.path("out", f"ref-{label.split()[0]}-{speed}.mp4")
        job = d.export(out)
        try:
            ref = observe.frame_indexes(out) if job.get("status") == "done" else None
        except observe.Unmeasurable as e:
            ref, job = None, {"status": f"unmeasurable: {e}"}
        st = d.get_state()
        cl = E.clip(st, c)
        bad = rule_problems(ref, cl) if ref is not None else ["no export"]
        t.check(f"{label} {speed}x: the export has the clip's length in frames and shows the speed rule's frames",
                ref is not None and cl is not None and not bad and len(ref) == cl["length_frames"],
                f"{len(ref) if ref else 0} frames of {cl['length_frames'] if cl else '?'}; off {E.short(bad, 300)}; "
                f"{job if ref is None else ''}")
        off = []
        for n in FREEZE_AT:
            st0 = d.get_state()
            d.freeze_frame(c, n, FREEZE_LEN)
            st1 = d.get_state()
            new = E.new_assets(st0, st1)
            still = [x for x in E.clips(st1, "v0") if x["asset"] in new]
            if len(still) != 1 or ref is None or n >= len(ref):
                off.append(f"{n}: {len(still)} new clips on v0")
            else:
                at = (still[0]["start_frame"] + still[0]["length_frames"] / 2) / fps
                p = t.path("frames", f"freeze-{label.split()[0]}-{speed}-{n}.png")
                try:
                    d.render_frame(at, p)  # read where the judge asked for it, not where the adapter says it is
                    held = observe.frame_indexes(p)[0]
                except (observe.Unmeasurable, IndexError) as e:
                    held = f"unmeasurable ({e})"
                if held != ref[n]:
                    off.append(f"{n}: held {held}, export {ref[n]}")
            d.undo()
        t.check(f"{label} {speed}x: freeze_frame at frames {FREEZE_AT} holds exactly the frame the export shows there",
                not off, E.short(off))


# ---------------------------------------------------------------- 6. render_frame against the export
def frames(t, d, asset, fps, label, paths):
    E.clear(d)
    a = d.place_clip(asset, "v0", 0, 31, 97)
    b = d.place_clip(asset, "v0", E.end(E.clip(d.get_state(), a)), 100, 340)
    d.set_speed(b, 3)
    c = d.place_clip(asset, "v0", E.end(E.clip(d.get_state(), b)), 350, 383)
    d.set_speed(c, 0.5)
    st = d.get_state()
    total = E.end(E.clip(st, c))
    cuts = [E.end(E.clip(st, a)), E.end(E.clip(st, b))]
    out = t.path("out", f"getframe-{label.split()[0]}.mp4")
    job = d.export(out)
    try:
        ref = observe.frame_indexes(out) if job.get("status") == "done" else None
    except observe.Unmeasurable as e:
        ref, job = None, {"status": f"unmeasurable: {e}"}
    t.check(f"{label}: the export of a 1x | 3x | 0.5x layout has all its frames and the speed rule's frames",
            ref is not None and len(ref) == total
            and not [x for cl in (a, b, c) for x in rule_problems(ref, E.clip(st, cl))],
            f"{len(ref) if ref else 0} frames of {total}; {job if ref is None else ''}")
    want = sorted({0, 1, 2, 40, 100, total - 2, total - 1} | {s + k for s in cuts for k in (-2, -1, 0, 1)})
    for path in paths:
        if path == "preview":
            d.render_preview()  # a fresh preview of the whole timeline, then the same frames again
        off, calls = [], 0
        for f in want:
            for part in PERIOD:
                calls += 1
                at = (f + part) / fps
                got = shown(t, d, at, f"{label.split()[0]}-{path}-{f}-{part}")
                if ref is None or got != ref[f]:
                    off.append(f"{at:.4f} s (frame {f}+{part}): {got}, export {ref[f] if ref else '?'}")
        t.check(f"{label}, {path}: render_frame shows the exported frame around the 1x | 3x | 0.5x cuts and at the "
                f"ends (the start, middle and end of each frame period)", not off, f"{calls} times; {E.short(off)}")
        past = shown(t, d, total / fps + 5, f"{label.split()[0]}-{path}-past")
        t.check(f"{label}, {path}: render_frame 5 s past the end shows the last frame",
                ref is not None and past == ref[total - 1], f"{past}, last {ref[total - 1] if ref else '?'}")


def shown(t, d, at, name):
    """The frame index render_frame shows at `at` s (or the reason it could not be read)."""
    p = t.path("frames", f"{name}.png")
    try:
        d.render_frame(at, p)  # read where the judge asked for it, not where the adapter says it is
        return observe.frame_indexes(p)[0]
    except (observe.Unmeasurable, IndexError) as e:
        return f"unmeasurable ({e})"
