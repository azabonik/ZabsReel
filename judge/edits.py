"""What the edit tests share (tests/test_cuts.py, test_speed_ripple.py, test_speed_sync.py, test_locks.py,
test_freeze.py, test_reverse_slowmo.py): reading clips from a State (PROTOCOL.md), the check that an edit was refused
and changed nothing, waiting for a job, and the search for media files an editor left in the test's folder.

Python 3 standard library only. Every position comes from get_state, never from an operation's answer.
"""
import fractions
import math
import os
import time

import driver as drv
import observe


def clips(st, track):
    """The clips of `track` ("v0", "a1", ...) in a State, in timeline order ([] when there is no such track)."""
    for t in st.get("tracks", []):
        if t.get("track") == track:
            return sorted(t.get("clips", []), key=lambda c: c.get("start_frame", 0))
    return []


def track(st, name):
    """The track `name` of a State (its dict), or {}."""
    return next((t for t in st.get("tracks", []) if t.get("track") == name), {})


def clip(st, cid):
    """The clip `cid` of a State (its dict), or None."""
    for t in st.get("tracks", []):
        for c in t.get("clips", []):
            if c.get("id") == cid:
                return c
    return None


def end(c):
    """Where the clip ends on the timeline (exclusive): its start plus its length."""
    return c["start_frame"] + c["length_frames"]


def spans(st, tr):
    """[(start, end)] of the clips of track `tr`."""
    return [(c["start_frame"], end(c)) for c in clips(st, tr)]


def butted(cs):
    """Whether each clip of `cs` (in timeline order) starts where the one before it ends."""
    return all(end(cs[i - 1]) == c["start_frame"] for i, c in enumerate(cs) if i)


def overlaps(cs):
    """The pairs of clips of `cs` that overlap on the timeline (ids)."""
    out = []
    for i, a in enumerate(cs):
        for b in cs[i + 1:]:
            if a["start_frame"] < end(b) and b["start_frame"] < end(a):
                out.append((a["id"], b["id"]))
    return out


def new_assets(before, after):
    """The ids of the assets in State `after` that are not in State `before`."""
    old = {a.get("id") for a in before.get("assets", [])}
    return [a.get("id") for a in after.get("assets", []) if a.get("id") not in old]


def clips_of_asset(st, asset):
    """[(track, clip)] of every clip that plays `asset`."""
    return [(t.get("track"), c) for t in st.get("tracks", []) for c in t.get("clips", []) if c.get("asset") == asset]


def short(v, n=400):
    s = str(v)
    return s if len(s) <= n else s[:n] + "..."


def clear(d):
    """Removes every clip (the tracks stay); a clip removed with a linked one is not removed twice."""
    for _ in range(1000):
        left = [c for t in d.get_state().get("tracks", []) for c in t.get("clips", [])]
        if not left:
            return
        d.remove_clip(left[0]["id"])


def refused_unchanged(d, fn, codes=(drv.ProductError,)):
    """(ok, detail): fn() (an edit) is refused and changes nothing, its undo history included. Refused: the editor
    answers product_error (PROTOCOL.md: the editor refused the edit); bad_request says the adapter found the arguments
    malformed, which is not the editor's refusal (`codes` widens what counts). Before the call, the user's last edit is
    a marker K that stays, and a second marker P is set and undone, so the editor has a step to redo. After the
    refusal the State must be the one before; redo must bring P back (a refused edit that had made an undo step would
    have dropped the redo step), undo must take P away again, and the next undo must take back K, the last edit before
    the refusal (a refusal that had left a step in the undo history, even one that changes nothing, would make that
    undo do nothing visible). That undo gives the State from before the call."""
    st = d.get_state()
    mine = [(m["frame"], m.get("name")) for m in st.get("markers", [])]
    used = {f for f, _ in mine}
    free = [f for f in range(7, 9 + len(used)) if f not in used]
    kept, probe = (free[0], "judge kept edit"), (free[1], "judge redo probe")
    d.set_markers(mine + [kept])
    d.set_markers(mine + [kept, probe])
    d.undo()
    s0 = d.get_state()
    refused, what = drv.refused(fn, codes=codes)
    s1 = d.get_state()
    d.redo()
    s2 = d.get_state()
    redone = {"frame": probe[0], "name": probe[1]} in s2.get("markers", [])
    if redone:
        d.undo()
    s3 = d.get_state()
    d.undo()
    s4 = d.get_state()
    ok = refused and s1 == s0 and redone and s3 == s0 and s4 == st
    why = [what]
    if s1 != s0:
        why.append("the State changed")
    if not redone:
        why.append("redo did not bring back the step undone before (the redo history was lost)")
    elif s3 != s0:
        why.append("undo after that redo did not give the State before")
    if s4 != st:
        why.append("the next undo did not take back the last edit before the refusal (a marker): the refusal left a "
                   "step in the undo history" if s4 == s3 else "the next undo did not give the State from before")
    return ok, "; ".join(why)


def job_now(d, job):
    """The job `job` as d.jobs() lists it now (None when it is not listed)."""
    return next((j for j in d.jobs() if j.get("job") == job), None) if job else None


def too_fast(t, names, was, change):
    """Records the checks `names` as not applicable: the bake (`was`, as jobs() listed it) had ended done before the
    judge could make `change` during it (it bakes long media so that this does not happen; run.py --strict fails it)."""
    for n in names:
        t.not_applicable(n, f"the bake had ended done before the judge {change} ({was}): it was not seen running, so "
                            f"the change could not land during it")


def wait_job(d, job, timeout=600):
    """The job `job` (from d.jobs()) once it is no longer running, or the last one seen when `timeout` s pass (None
    when the editor never listed it)."""
    deadline, seen = time.time() + timeout, None
    while time.time() < deadline:
        seen = next((j for j in d.jobs() if j.get("job") == job), seen)
        if seen is not None and seen.get("status") != "running":
            return seen
        time.sleep(0.1)
    return seen


# ---------------------------------------------------------------- what an export must show
def middle_frame(c, n):
    """(frame, tie) for the State clip `c` at its constant speed s: the source frame that plays at the middle of the
    clip's timeline frame n, in_frame + floor((n + 1/2) * s), and whether (n + 1/2) * s is a whole number: a tie,
    where that frame starts playing at the very middle and the frame before it may show as well (of the speeds the
    tests use, at 2x and 4x)."""
    s = fractions.Fraction(float(c.get("speed") or 1)).limit_denominator(10000)
    x = (n + fractions.Fraction(1, 2)) * s
    return c["in_frame"] + math.floor(x), x.denominator == 1


def speed_rule_problems(frames, c, whole=True):
    """Where `frames` (observe.frame_indexes of an export, one per timeline frame) breaks the speed rule for the State
    clip `c` (a constant speed s, source range [in, out), at start_frame) -> [text]. At its timeline frame n the clip
    shows a source frame inside [in, out), never an earlier one than at frame n - 1, and:
    - a whole clip (placed and set to its speed as a whole, so its first frame starts on its in point) shows exactly
      the source frame playing at the middle of that frame, in + floor((n + 1/2) * s) (middle_frame; at a tie, that
      frame or the one before it: v0.2.0 shows the one before on idx.mp4 and the later one on idx2997.mp4's 1/30000
      timebase);
    - a piece of a split clip (whole False) may start part of a source frame into its in point, which get_state does
      not show (its in_frame is a whole frame), so it is held to in + n at 1x and within max(1, s / 2) source frames
      of in + n * s at another speed."""
    out, prev = [], None
    s = float(c.get("speed") or 1)
    for n in range(c["length_frames"]):
        f = c["start_frame"] + n
        if f >= len(frames):
            out.append(f"frame {f} is missing")
            break
        got = frames[f]
        if whole:
            want, tie = middle_frame(c, n)
            wrong = got not in ((want - 1, want) if tie else (want,))
            what = f"the middle of the frame plays {want}" + (" (a tie: or the one before)" if tie else "")
        else:
            ideal = c["in_frame"] + n * s
            wrong = got != ideal if s == 1 else abs(got - ideal) > max(1, s / 2) + 1e-9
            what = f"in + n*s = {ideal:g}"
        if not c["in_frame"] <= got < c["out_frame"] or (prev is not None and got < prev) or wrong:
            out.append(f"{f}: {got} (clip {c['id']} at {s:g}x: {what})")
        prev = got
    return out


def render_problems(st, frames, stripes):
    """Where `frames` (observe.frame_indexes of an export of the timeline) differs from what State `st` says: at each
    timeline frame the highest shown video track's clip there shows its source, and a frame with no clip is black (0).
    A clip of the asset `stripes` at a constant speed is held, where it is on top, to the whole clip's speed rule
    (speed_rule_problems: the clips of the layouts this checks are whole, none is a piece of a split clip); a clip of
    another asset or with a ramp is not read. The export must hold State's length_frames frames. -> [text]"""
    n = st.get("length_frames") or 0
    out = [] if len(frames) == n else [f"{len(frames)} frames, get_state says {n}"]
    top = [None] * n
    vids = sorted((t for t in st.get("tracks", []) if str(t.get("track", "")).startswith("v") and not t.get("hidden")),
                  key=lambda t: int(t["track"][1:]))
    for t in vids:
        for c in t.get("clips", []):
            for f in range(max(0, c["start_frame"]), min(n, end(c))):
                top[f] = c
    prev = {}
    for f in range(min(n, len(frames))):
        c, got = top[f], frames[f]
        if c is None:
            if got != 0:
                out.append(f"{f}: {got}, a gap (want black)")
            continue
        if c["asset"] != stripes or c.get("ramp"):
            continue
        want, tie = middle_frame(c, f - c["start_frame"])
        p = prev.get(c["id"])
        if not c["in_frame"] <= got < c["out_frame"] or (p is not None and got < p) \
                or got not in ((want - 1, want) if tie else (want,)):
            out.append(f"{f}: {got} (clip {c['id']} at {float(c.get('speed') or 1):g}x: the middle of the frame "
                       f"plays {want}" + (" (a tie: or the one before)" if tie else "") + ")")
        prev[c["id"]] = got
    return out


# ---------------------------------------------------------------- what the chirp says
OFFSETS = [-0.06, -0.04, -0.02, 0, 0.02, 0.04, 0.06]


def sound_offset(snd, t, src_at):
    """The heard source moment minus the expected one, around timeline moment `t` (s) of the samples `snd`
    (observe.samples of an export of idx.mp4's chirp): the median over seven moments 20 ms apart of
    observe.chirp_time(moment) - src_at(moment). None where it is quiet."""
    diffs = []
    for o in OFFSETS:
        h = observe.chirp_time(snd, t + o)
        if h is not None:
            diffs.append(h - src_at(t + o))
    if not diffs:
        return None
    diffs.sort()
    return diffs[len(diffs) // 2]


def ms(v):
    return "silent" if v is None else f"{v * 1000:+.0f} ms"


# ---------------------------------------------------------------- files the editor left
LOGS = (".stderr", ".log")


def files(t, mine=()):
    """{path: size} of every regular file in the test's folder (as the judge and, under --as-user, the editor's user
    see it: t.look), but the logs (*.stderr, *.log) and the folders `mine` (the test's own output)."""
    walk = t.look(walk=[t.scratch])["walk"]
    skip = [os.path.realpath(m).rstrip(os.sep) + os.sep for m in mine]
    return {p: s for p, s in walk.items()
            if s is not None and not p.endswith(LOGS) and not any(os.path.realpath(p).startswith(m) for m in skip)}


def left_media(t, before, mine=()):
    """The files that appeared in the test's folder since `before` (files()) and hold media: a file that starts like
    one (observe.media_magic), or one the judge cannot read or that is larger than 1 MiB (t.look reads no more), so
    a bake or a piece of one that an editor left behind is found wherever it put it. Text files (a project, a list of
    jobs) are not media. -> [path]"""
    new = sorted(p for p in files(t, mine) if p not in before)
    if not new:
        return []
    heads = t.look(read=new)["read"]
    return [p for p in new if heads.get(p) is None or observe.media_magic(heads[p][:16])]
