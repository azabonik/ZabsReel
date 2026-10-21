#!/usr/bin/env python3
"""Checks observe.py against recorded measurements: each <run>/check.json of the first-try baseline (an oracle, a
named negative or an alternative export) holds the values the baseline checker measured on <run>/final.mp4 (and its
SRT / OTIO sidecars). This script measures the same files with observe.py and compares, check by check.

    python3 -I judge/check_observe.py --briefs <briefs.json> --media <reference media dir> [--tolerance F] <run dir>...
    python3 -I judge/check_observe.py --self-test     (the agreement rule for unmeasurable values; run.py --self-test)

<briefs.json> gives each check's parameters (times, regions, bands); <reference media dir> holds the reference clips
the frame checks compare with. Neither is part of the judge: they live with the baseline, outside the repository, so
this is a local tool, not a judge test. Numbers are compared after the baseline's own rounding; --tolerance allows
that much difference on each number (for an FFmpeg other than the one that measured the oracles; 0 = equal).
Checks of kinds observe.py does not carry (burned-in counter, caption text masks, transcripts) are listed as skipped.
Exits 0 when every compared value agrees, 1 otherwise.
"""
import argparse
import json
import math
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import observe  # noqa: E402


def fnum(x, nd=3):
    return None if x is None else round(float(x), nd)


def measure(kind, c, run_dir, media, frames):
    """The value the baseline checker recorded for a check of this kind, measured with observe.py (same rounding)."""
    final = os.path.join(run_dir, "final.mp4")
    ref = (lambda n: os.path.join(media, n))
    if kind == "decodes":
        d = observe.decode(final)
        return {"exit": d["exit"], "stderr_chars": len(d["stderr"]), "video_frames": d["video_frames"]}
    if kind == "audio_not_silent":
        return observe.mean_volume(final)
    if kind in ("duration", "duration_below"):
        return fnum(observe.duration(final))
    if kind == "duration_vs_source":
        d, src = observe.duration(final), observe.duration(ref(c["source"]))
        return {"duration": fnum(d), "source": fnum(src), "shorter_by": fnum(src - d)}
    if kind == "aspect":
        w, h, sar = observe.size(final)
        return fnum(w * sar / h, 4)
    if kind == "size":
        w, h, _ = observe.size(final)
        return f"{w}x{h}"
    if kind == "frame_match":
        return fnum(observe.frame_ssim(frames, final, c["t"], ref(c["ref"]), c["ref_t"], c.get("region")), 4)
    if kind == "region_differs":
        return fnum(observe.frame_ssim(frames, final, c["t"], ref(c["ref"]), c["ref_t"], c["region"]), 4)
    if kind == "frame_matches_neither":
        return {f"{n.split('.')[0]}@{rt}": fnum(observe.frame_ssim(frames, final, c["t"], ref(n), rt), 4)
                for n, rt in c["refs"]}
    if kind == "satavg_below":
        return fnum(observe.signalstats(frames.get(final, c["t"]))["SATAVG"])
    if kind == "yavg_below":
        return fnum(observe.signalstats(frames.get(final, c["t"]))["YAVG"])
    if kind in ("yavg_ratio_at_most", "yavg_ratio_at_least"):
        y = observe.signalstats(frames.get(final, c["t"]))["YAVG"]
        y0 = observe.signalstats(frames.get(ref(c["ref"]), c["ref_t"]))["YAVG"]
        return fnum(y / y0 if y0 else (math.inf if kind.endswith("most") else 0.0), 4)
    if kind == "yavg_last_frame_below":
        return fnum(observe.last_frame_stats(final)[0]["YAVG"])
    if kind in ("band_audible", "band_below"):
        return fnum(observe.band_level(final, c["freq"], c.get("start"), c.get("end")), 1)
    if kind == "tail_quieter":
        r = observe.mean_volume(final, "", c["ref_start"], c["ref_end"])
        t = observe.tail_level(final, c["tail"])
        return None if r is None or t is None else fnum(r - t, 1)
    if kind == "max_silence":
        return {"silences": observe.silences(final, c["noise_db"], c["max_len"])}
    if kind == "srt_valid":
        p = os.path.join(run_dir, c["file"])
        if not os.path.isfile(p):
            return None
        cues, problems = observe.parse_srt(p)
        return {"cues": len(cues), "problems": problems[:10]}
    if kind == "otio_timeline":
        p = os.path.join(run_dir, c["file"])
        if not os.path.isfile(p):
            return None
        o = observe.parse_otio(p)
        return {"clips": len(o["clips"]), "root_schema": o["root_schema"]}
    if kind == "loudness":
        return fnum(observe.loudness(final), 1)
    return NotImplemented


def agree(a, b, tol):
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(agree(a[k], b[k], tol) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(agree(x, y, tol) for x, y in zip(a, b))
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if math.isinf(a) or math.isinf(b):
            return a == b
        return abs(a - b) <= tol + 1e-9
    return a == b


# What the baseline checker records when the file makes a check impossible: None (the check could not be measured or
# was skipped) or its own markers for final.mp4 ("missing", "empty", "unreadable"). Only these agree with an
# observe.Unmeasurable; any other recorded value (a size "1280x720", a number) was measured, so an Unmeasurable now
# is a difference.
IMPOSSIBLE = {"missing", "empty", "unreadable"}


def unmeasurable_agrees(want):
    return want is None or (isinstance(want, str) and want in IMPOSSIBLE)


def self_test():
    cases = [(None, True), ("missing", True), ("empty", True), ("unreadable", True), ("1280x720", False),
             ("", False), (0, False), (3.0, False), ({"exit": 0}, False)]
    bad = [(w, want) for w, want in cases if unmeasurable_agrees(w) is not want]
    for w, want in cases:
        print(f"{'ok  ' if unmeasurable_agrees(w) is want else 'FAIL'} an unmeasurable value "
              f"{'agrees' if want else 'differs'} with a recorded {json.dumps(w)}")
    print(f"[check_observe] self-test FAILED: {len(bad)} case(s)" if bad else "[check_observe] self-test ok")
    return 1 if bad else 0


def main():
    if "--self-test" in sys.argv[1:]:
        return self_test()
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--briefs", required=True)
    ap.add_argument("--media", required=True)
    ap.add_argument("--tolerance", type=float, default=0.0)
    ap.add_argument("runs", nargs="+")
    a = ap.parse_args()
    briefs = json.load(open(a.briefs, encoding="utf-8"))
    params = {b["id"]: {c["id"]: c for c in briefs["common_checks"] + b["checks"]} for b in briefs["briefs"]}
    frames = observe.Frames()
    print(f"observe.py with {observe.ffmpeg_version()} ({observe.FFMPEG}), tolerance {a.tolerance}")
    n_ok = n_bad = n_skip = 0
    skipped = {}
    for run_dir in a.runs:
        cj = os.path.join(run_dir, "check.json")
        if not os.path.isfile(cj):
            continue
        rec = json.load(open(cj, encoding="utf-8"))
        for r in rec.get("checks", []):
            c = params.get(rec["brief"], {}).get(r["id"])
            if c is None:
                continue
            kind = c["type"]
            try:
                got = measure(kind, c, run_dir, a.media, frames)
            except observe.Unmeasurable as e:
                got = f"unmeasurable: {e}"
            if got is NotImplemented:
                n_skip += 1
                skipped[kind] = skipped.get(kind, 0) + 1
                continue
            want = r["value"]
            if isinstance(got, str) and got.startswith("unmeasurable"):
                ok = unmeasurable_agrees(want)
            else:
                ok = agree(got, want, a.tolerance)
            n_ok += ok
            n_bad += not ok
            if not ok:
                print(f"DIFF {os.path.basename(run_dir)} {r['id']} ({kind}): observe {json.dumps(got)} vs recorded "
                      f"{json.dumps(want)}")
    print(f"agree {n_ok}, differ {n_bad}, skipped {n_skip} {json.dumps(skipped)}")
    return 1 if n_bad or not n_ok else 0


if __name__ == "__main__":
    sys.exit(main())
