"""What the edit tests share (tests/test_cuts.py, test_speed_ripple.py, test_speed_sync.py, test_locks.py,
test_freeze.py, test_reverse_slowmo.py): reading clips from a State (PROTOCOL.md), the check that an edit was refused
and changed nothing, waiting for a job, and the search for media files an editor left in the test's folder.

Python 3 standard library only. Every position comes from get_state, never from an operation's answer.
"""
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


def refused_unchanged(d, fn):
    """(ok, detail): fn() (an edit) is refused and changes nothing, its undo history included. Before it, a marker is
    set and undone, so the editor has a step to redo. After the refusal the State must be the one before; redo must
    bring that marker back (a refused edit that had made an undo step would have dropped the redo step), and undo then
    gives the State before again."""
    st = d.get_state()
    mine = [(m["frame"], m.get("name")) for m in st.get("markers", [])]
    probe = (7, "judge redo probe")
    if probe in mine:
        probe = (8, "judge redo probe 2")
    d.set_markers(mine + [probe])
    d.undo()
    s0 = d.get_state()
    refused, what = drv.refused(fn)
    s1 = d.get_state()
    d.redo()
    s2 = d.get_state()
    redone = {"frame": probe[0], "name": probe[1]} in s2.get("markers", [])
    if redone:
        d.undo()
    s3 = d.get_state()
    ok = refused and s1 == s0 and redone and s3 == s0
    why = [what]
    if s1 != s0:
        why.append("the State changed")
    if not redone:
        why.append("redo did not bring back the step undone before (the redo history was lost)")
    elif s3 != s0:
        why.append("undo after that redo did not give the State before")
    return ok, "; ".join(why)


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
def render_problems(st, frames, stripes):
    """Where `frames` (observe.frame_indexes of an export of the timeline) differs from what State `st` says: at each
    timeline frame the highest shown video track's clip there shows its source (a clip of the asset `stripes` at a
    constant speed s: a source frame inside its range, never earlier than at the frame before, exactly in + n at 1x,
    else within max(1, s / 2) of in + n * s; a clip of another asset or with a ramp is not read), and a frame with no
    clip is black (0). The export must hold State's length_frames frames. -> [text]"""
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
        s = float(c.get("speed") or 1)
        k = f - c["start_frame"]
        ideal = c["in_frame"] + k * s
        p = prev.get(c["id"])
        if not c["in_frame"] <= got < c["out_frame"] or (p is not None and got < p) \
                or (got != ideal if s == 1 else abs(got - ideal) > max(1, s / 2) + 1e-9):
            out.append(f"{f}: {got} (clip {c['id']} at {s:g}x: in + n*s = {ideal:g})")
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
