#!/usr/bin/env python3
"""Makes the OpenTimelineIO files that v0.2.0 exports, for tests/test_v020_otio_compat.py (a one-time tool, not a test).

    python3 -I -B judge/fixtures/v020-otio/generate.py --build <a checkout of the v0.2.0 release, built> [--out DIR]
                                                      [--only NAME ...]

It makes the judge's media with judge/fixtures/make.sh in a new temporary folder, then, for each timeline in TIMELINES,
starts the v0.2.0 editor through the judge's v0.2.0 adapter (judge/adapters/v020/adapter.py, in a sandbox of its own),
builds the timeline with the judge's operations, checks that the editor reports it as the spec says (get_state),
exports it with export_otio, opens that file again in a new editor (import_otio) and checks the same State there (the
release opens its own export unchanged), and writes:

- <name>.otio: the file v0.2.0 wrote, with one change: the temporary media folder is replaced by MEDIA_TOKEN in every
  place it occurs (the media paths and their file:// URLs), so the test can point the file at its own media. Nothing
  else is changed (byte for byte, as v0.2.0 wrote it).
With --only, only the named timelines are made: their files are written (again) and their entries in the
manifest.json already in --out are replaced or added, in TIMELINES' order; the other files and entries stay byte for
byte. The media must then come from the FFmpeg the manifest names (media_ffmpeg).

- manifest.json: per file, what it must open as: the canvas, the length, each track's clips (the media file, position,
  source range, length, speed, effects with their amounts, params, colour and whether each is on, texts), and the
  observations the test makes on an export
  (frames that must show a source frame, a gap, a look, tones). These are the spec below, which v0.2.0's own State
  matched twice (after building and after opening the export again); the looks were measured on v0.2.0's exports by
  the test itself (run.py --build <v0.2.0> --only v020_otio_compat).

Only what the judge's protocol can build is in these files (judge/PORTING.md lists what v0.2.0 exports that is not).
The editor downloads nothing (the adapter starts it so); nothing outside the temporary folder is written but --out.
Python 3 standard library only.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.parse

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
JUDGE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, JUDGE)
import driver  # noqa: E402
import observe  # noqa: E402

MEDIA_TOKEN = "@JUDGE_MEDIA@"  # the media folder, in the checked-in files

# Each timeline: the canvas, the tracks to add, the clips (placed in this order), the edits after placing (split,
# trim, speed, effect, colour, lut, text), the clips it must then hold (State: per track, in timeline order), and the
# observations on its export. Clip keys name clips; a split names its two halves. An effect edit is (effect, clip,
# name, amount[, {params, color, enabled}]): enabled false bypasses it after adding it. A clip's effects in "expect"
# are (name, amount[, params[, colour[, enabled]]]).
TIMELINES = [
    {
        "name": "cuts",
        "what": "cuts, a trim and a gap on one video track; the clips' own audio (440 Hz, 660 Hz)",
        "canvas": [640, 360, 30],
        "add_tracks": [],
        "place": [("A", "a.mp4", "v0", 0, 30, 120), ("B", "b.mp4", "v0", 120, 0, 90)],
        "edits": [("split", "A", 45, "A1", "A2"), ("trim", "B", 15, 75)],
        "expect": {"v0": [("a.mp4", 0, 30, 75, 45, 1), ("a.mp4", 45, 75, 120, 45, 1), ("b.mp4", 120, 15, 75, 60, 1)]},
        "length": 180,
        "probes": [
            {"kind": "source", "t": 0.5, "media": "a.mp4", "source_t": 1.5},
            {"kind": "source", "t": 2.0, "media": "a.mp4", "source_t": 3.0},
            {"kind": "black", "t": 3.5},
            {"kind": "source", "t": 4.5, "media": "b.mp4", "source_t": 1.0},
            {"kind": "source", "t": 5.5, "media": "b.mp4", "source_t": 2.0},
            {"kind": "tone", "from": 0.2, "to": 2.8, "hz": 440, "heard": True},
            {"kind": "tone", "from": 4.2, "to": 5.8, "hz": 660, "heard": True},
            {"kind": "quiet", "from": 3.1, "to": 3.9},
        ],
    },
    {
        "name": "layers",
        "what": "two video tracks (a 4:3 clip over a 16:9 one, from 1 s: a gap first on v1) and an audio track",
        "canvas": [640, 360, 30],
        "add_tracks": ["video", "audio"],
        "place": [("B", "b.mp4", "v0", 0, 0, 150), ("C", "c640.mp4", "v1", 30, 0, 60), ("M", "m.mp3", "a0", 0, 0, 150)],
        "edits": [],
        "expect": {"v0": [("b.mp4", 0, 0, 150, 150, 1)], "v1": [("c640.mp4", 30, 0, 60, 60, 1)],
                   "a0": [("m.mp3", 0, 0, 150, 150, 1)]},
        "length": 150,
        "probes": [
            {"kind": "source", "t": 0.5, "media": "b.mp4", "source_t": 0.5},
            {"kind": "region", "t": 2.0, "media": "c640.mp4", "source_t": 1.0, "crop": "crop=480:360:80:0",
             "source_chain": "scale=480:360:flags=bicubic", "size": [480, 360],
             "what": "the 4:3 clip of v1, fitted in the middle"},
            {"kind": "region", "t": 2.0, "media": "b.mp4", "source_t": 2.0, "crop": "crop=72:360:0:0",
             "source_chain": "scale=640:360:flags=bicubic,crop=72:360:0:0", "size": [72, 360],
             "what": "v0 beside it, where the 4:3 clip leaves the canvas empty"},
            {"kind": "source", "t": 4.0, "media": "b.mp4", "source_t": 4.0},
            {"kind": "tone", "from": 0.2, "to": 4.8, "hz": 330, "heard": True},
            {"kind": "tone", "from": 0.2, "to": 4.8, "hz": 660, "heard": True},
            {"kind": "tone", "from": 1.2, "to": 2.8, "hz": 440, "heard": True},
            {"kind": "tone", "from": 3.3, "to": 4.8, "hz": 440, "heard": False},
        ],
    },
    {
        "name": "speed",
        "what": "a 25 fps 480x270 canvas: a clip at twice its speed, then one at half its speed",
        "canvas": [480, 270, 25],
        "add_tracks": [],
        "place": [("A", "a.mp4", "v0", 0, 0, 50), ("B", "b.mp4", "v0", 50, 25, 75)],
        "edits": [("speed", "A", 2.0), ("move", "B", 25), ("speed", "B", 0.5)],
        "expect": {"v0": [("a.mp4", 0, 0, 50, 25, 2), ("b.mp4", 25, 25, 75, 100, 0.5)]},
        "length": 125,
        "probes": [
            {"kind": "source", "t": 0.3, "media": "a.mp4", "source_t": 0.6},
            {"kind": "source", "t": 0.8, "media": "a.mp4", "source_t": 1.6},
            {"kind": "source", "t": 2.0, "media": "b.mp4", "source_t": 1.5},
            {"kind": "source", "t": 4.6, "media": "b.mp4", "source_t": 2.8},
            {"kind": "audio_length", "seconds": 5.0},
        ],
    },
    {
        "name": "looks",
        "what": "effects, colour grades, a LUT and a text: grayscale, a brightness and saturation grade, vignette 2 "
                "and 0, the red-blue LUT, a text, a warm white balance, invert",
        "canvas": [640, 360, 30],
        "add_tracks": [],
        "place": [("G", "a.mp4", "v0", 0, 0, 60), ("K", "a.mp4", "v0", 60, 60, 120), ("V2", "a.mp4", "v0", 120, 0, 60),
                  ("V0", "a.mp4", "v0", 180, 0, 60), ("L", "a.mp4", "v0", 240, 60, 120),
                  ("T", "b.mp4", "v0", 300, 0, 60), ("W", "a.mp4", "v0", 360, 0, 60),
                  ("I", "a.mp4", "v0", 420, 120, 180)],
        "edits": [("effect", "G", "grayscale", None), ("colour", "K", {"brightness": 0.15, "saturation": 1.4}),
                  ("effect", "V2", "vignette", 2.0), ("effect", "V0", "vignette", 0.0), ("lut", "L", "look.cube"),
                  ("text", "T", "JUDGE", {"position": "bottom", "font_size": 64, "color": "#ffe14d", "box": True,
                                          "box_color": "#000000"}),
                  ("colour", "W", {"temperature": 0.6}), ("effect", "I", "invert", None)],
        "expect": {"v0": [("a.mp4", 0, 0, 60, 60, 1, [("grayscale", None)]),
                          ("a.mp4", 60, 60, 120, 60, 1),
                          ("a.mp4", 120, 0, 60, 60, 1, [("vignette", 2.0)]),
                          ("a.mp4", 180, 0, 60, 60, 1, [("vignette", 0)]),
                          ("a.mp4", 240, 60, 120, 60, 1),
                          ("b.mp4", 300, 0, 60, 60, 1, [], ["JUDGE"]),
                          ("a.mp4", 360, 0, 60, 60, 1),
                          ("a.mp4", 420, 120, 180, 60, 1, [("invert", None)])]},
        "length": 480,
        "probes": [
            {"kind": "look", "look": "grayscale", "t": 1.0, "media": "a.mp4", "source_t": 1.0},
            {"kind": "look", "look": "brighter", "t": 3.0, "media": "a.mp4", "source_t": 3.0},
            {"kind": "look", "look": "vignette", "t": 5.0, "media": "a.mp4", "source_t": 1.0},
            {"kind": "source", "t": 7.0, "media": "a.mp4", "source_t": 1.0,
             "what": "vignette amount 0 leaves the picture as it is"},
            {"kind": "look", "look": "red_blue_swapped", "t": 9.0, "media": "a.mp4", "source_t": 3.0},
            {"kind": "look", "look": "text_at_bottom", "t": 11.0, "media": "b.mp4", "source_t": 1.0},
            {"kind": "look", "look": "text_yellow", "t": 11.0, "media": "b.mp4", "source_t": 1.0},
            {"kind": "look", "look": "text_box", "t": 11.0, "media": "b.mp4", "source_t": 1.0},
            {"kind": "look", "look": "warmer", "t": 13.0, "media": "a.mp4", "source_t": 1.0},
            {"kind": "look", "look": "inverted", "t": 15.0, "media": "a.mp4", "source_t": 5.0},
        ],
    },
    {
        "name": "params",
        "what": "effects with params, a colour and a bypass, and a grade on a flat colour: brightness 0.15 and "
                "saturation 1.4 on the dull and bright reds, colorhold #e02020 (similarity 0.3, blend 0.1) on the "
                "red-blue picture, exposure 0 with its black point at 0.1 on grey 128, and a vignette 2 bypassed",
        "canvas": [640, 360, 30],
        "add_tracks": [],
        "place": [("P", "fx-pair.mp4", "v0", 0, 0, 60), ("H", "fx-redblue.mp4", "v0", 60, 0, 60),
                  ("X", "fx-gray128.mp4", "v0", 120, 0, 60), ("B", "a.mp4", "v0", 180, 0, 60)],
        "edits": [("colour", "P", {"brightness": 0.15, "saturation": 1.4}),
                  ("effect", "H", "colorhold", None, {"params": {"similarity": 0.3, "blend": 0.1}, "color": "#e02020"}),
                  ("effect", "X", "exposure", 0, {"params": {"black": 0.1}}),
                  ("effect", "B", "vignette", 2.0, {"enabled": False})],
        "expect": {"v0": [("fx-pair.mp4", 0, 0, 60, 60, 1),
                          ("fx-redblue.mp4", 60, 0, 60, 60, 1,
                           [("colorhold", None, {"similarity": 0.3, "blend": 0.1}, "#e02020")]),
                          ("fx-gray128.mp4", 120, 0, 60, 60, 1, [("exposure", 0, {"black": 0.1})]),
                          ("a.mp4", 180, 0, 60, 60, 1, [("vignette", 2.0, None, None, False)])]},
        "length": 240,
        "probes": [
            {"kind": "look", "look": "graded_dull", "t": 1.0, "media": "fx-pair.mp4", "source_t": 1.0},
            {"kind": "look", "look": "red_held", "t": 3.0, "media": "fx-redblue.mp4", "source_t": 1.0},
            {"kind": "look", "look": "lifted", "t": 5.0, "media": "fx-gray128.mp4", "source_t": 1.0},
            {"kind": "source", "t": 7.0, "media": "a.mp4", "source_t": 1.0,
             "what": "a bypassed vignette (amount 2) leaves the picture as it is"},
        ],
    },
    {
        "name": "grades",
        "what": "the grade's other fields, one clip each: contrast 1.6 and gamma 2 on a grey ramp (black at the left to "
                "white at the right), tint 0.6 on grey 128, hue 120 on the red-blue picture",
        "canvas": [640, 360, 30],
        "add_tracks": [],
        "place": [("C", "fx-ramp.mp4", "v0", 0, 0, 30), ("G", "fx-ramp.mp4", "v0", 30, 0, 30),
                  ("T", "fx-gray128.mp4", "v0", 60, 0, 30), ("U", "fx-redblue.mp4", "v0", 90, 0, 30)],
        "edits": [("colour", "C", {"contrast": 1.6}), ("colour", "G", {"gamma": 2.0}), ("colour", "T", {"tint": 0.6}),
                  ("colour", "U", {"hue": 120})],
        "expect": {"v0": [("fx-ramp.mp4", 0, 0, 30, 30, 1), ("fx-ramp.mp4", 30, 0, 30, 30, 1),
                          ("fx-gray128.mp4", 60, 0, 30, 30, 1), ("fx-redblue.mp4", 90, 0, 30, 30, 1)]},
        "length": 120,
        "probes": [
            {"kind": "look", "look": "contrast", "t": 0.5, "media": "fx-ramp.mp4", "source_t": 0.5},
            {"kind": "look", "look": "gamma", "t": 1.5, "media": "fx-ramp.mp4", "source_t": 0.5},
            {"kind": "look", "look": "tint", "t": 2.5, "media": "fx-gray128.mp4", "source_t": 0.5},
            {"kind": "look", "look": "hue", "t": 3.5, "media": "fx-redblue.mp4", "source_t": 0.5},
        ],
    },
]


def log(*a):
    print("[v020-otio]", *a, file=sys.stderr, flush=True)


def colour(c):
    """A colour in the manifest's spelling: #rrggbb when it is a hex colour (observe.hex_colour), else as given."""
    v = observe.hex_colour(c)
    return c if v is None else f"#{v:06x}"


def effect_spec(name, amount, params=None, color=None, enabled=True):
    """An effect in the manifest's terms: its name, amount and whether it is on, and its params and colour if any."""
    out = {"effect": name, "amount": amount}
    if params:
        out["params"] = dict(params)
    if color:
        out["color"] = colour(color)
    out["enabled"] = enabled
    return out


def clip_spec(row):
    """(media, start, in, out, length, speed[, effects[, texts]]) -> the manifest's clip."""
    media, start, i, o, n, speed = row[:6]
    effects = row[6] if len(row) > 6 else []
    texts = row[7] if len(row) > 7 else []
    return {"media": media, "start_frame": start, "in_frame": i, "out_frame": o, "length_frames": n, "speed": speed,
            "effects": [effect_spec(*e) for e in effects], "texts": list(texts)}


def state_shape(st, media):
    """What a State says of the timeline, in the manifest's terms (media by file name, no identifiers)."""
    paths = {a.get("id"): a.get("path") for a in st.get("assets", [])}
    out = {"canvas": [st["canvas"]["width"], st["canvas"]["height"], st["canvas"]["fps"]],
           "length": st.get("length_frames"), "tracks": {}}
    for tr in st.get("tracks", []):
        clips = []
        for c in tr.get("clips", []):
            p = paths.get(c.get("asset")) or ""
            clips.append({"media": os.path.relpath(p, media) if p.startswith(media + os.sep) else p,
                          "start_frame": c.get("start_frame"), "in_frame": c.get("in_frame"),
                          "out_frame": c.get("out_frame"), "length_frames": c.get("length_frames"),
                          "speed": c.get("speed"),
                          "effects": [effect_spec(e.get("effect"), e.get("amount"), e.get("params"), e.get("color"),
                                                  e.get("enabled")) for e in c.get("effects", [])],
                          "texts": [x.get("text") for x in c.get("texts", [])]})
        if clips:
            out["tracks"][tr["track"]] = clips
    return out


def want_shape(tl):
    return {"canvas": tl["canvas"], "length": tl["length"],
            "tracks": {k: [clip_spec(r) for r in rows] for k, rows in tl["expect"].items()}}


def session(adapter, build, root, name):
    scratch = tempfile.mkdtemp(prefix=f"{name}-", dir=root)
    d = driver.Driver([sys.executable, "-I", "-B", adapter], scratch)
    d.hello()
    d.start(build)
    return d


def build_one(d, tl, media):
    w, h, fps = tl["canvas"]
    d.set_project(width=w, height=h, fps=fps)
    tracks = {"v0": "v0"}
    for kind in tl["add_tracks"]:
        name = d.add_track(kind)
        tracks[name] = name
    assets, clips = {}, {}
    for key, file, track, start, i, o in tl["place"]:
        if file not in assets:
            assets[file] = d.import_media(os.path.join(media, file))
        clips[key] = d.place_clip(assets[file], track, start, i, o)
    for e in tl["edits"]:
        op, key = e[0], e[1]
        if op == "split":
            clips[e[3]], clips[e[4]] = d.split_clip(clips[key], e[2])
        elif op == "trim":
            d.trim_clip(clips[key], e[2], e[3])
        elif op == "move":
            d.move_clip(clips[key], e[2])
        elif op == "speed":
            d.set_speed(clips[key], e[2])
        elif op == "effect":
            opts = e[4] if len(e) > 4 else {}
            fx = d.apply_effect(clips[key], e[2], amount=e[3], params=opts.get("params"), color=opts.get("color"))
            if opts.get("enabled") is False:
                d.apply_effect(clips[key], e[2], effect_id=fx, enabled=False)
        elif op == "colour":
            d.apply_colour(clips[key], **e[2])
        elif op == "lut":
            d.apply_lut(clips[key], os.path.join(media, e[2]))
        elif op == "text":
            d.add_text(clips[key], e[2], **e[3])
        else:
            raise SystemExit(f"unknown edit {e}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--build", required=True, help="a built checkout of the v0.2.0 release")
    ap.add_argument("--out", default=HERE)
    ap.add_argument("--keep", action="store_true", help="keep the temporary folder")
    ap.add_argument("--only", action="append", choices=[tl["name"] for tl in TIMELINES],
                    help="make only this timeline (again), and update its entry in --out's manifest.json")
    a = ap.parse_args()
    build = os.path.realpath(a.build)
    root = os.path.realpath(tempfile.mkdtemp(prefix="v020-otio-"))
    media = os.path.join(root, "media")
    adapter = os.path.join(JUDGE, "adapters", "v020", "adapter.py")
    try:
        mk = subprocess.run(["bash", os.path.join(JUDGE, "fixtures", "make.sh"), media], capture_output=True,
                            text=True, stdin=subprocess.DEVNULL, timeout=600)
        if mk.returncode != 0:
            raise SystemExit(f"make.sh failed: {mk.stderr[-2000:]}")
        ffmpeg_line = mk.stdout.splitlines()[0] if mk.stdout else "?"
        manifest = {"token": MEDIA_TOKEN, "made_with": None, "media_ffmpeg": ffmpeg_line, "files": []}
        kept = {}
        if a.only:
            with open(os.path.join(a.out, "manifest.json"), encoding="utf-8") as f:
                old = json.load(f)
            if old.get("media_ffmpeg") != ffmpeg_line:
                raise SystemExit(f"--only: the media were made with {ffmpeg_line!r}, the manifest's with "
                                 f"{old.get('media_ffmpeg')!r}: use that FFmpeg")
            manifest = {**old, "files": []}
            kept = {e["file"]: e for e in old["files"]}
        for tl in TIMELINES:
            if a.only and tl["name"] not in a.only:
                if f"{tl['name']}.otio" in kept:
                    manifest["files"].append(kept[f"{tl['name']}.otio"])
                continue
            log(f"{tl['name']}: building on v0.2.0")
            want = want_shape(tl)
            d = session(adapter, build, root, tl["name"])
            try:
                if a.only and manifest["made_with"] != d.product:
                    raise SystemExit(f"--only: this build is {d.product}, the manifest's files {manifest['made_with']}")
                manifest["made_with"] = d.product
                build_one(d, tl, media)
                built = state_shape(d.get_state(), media)
                if built != want:
                    raise SystemExit(f"{tl['name']}: v0.2.0 reports\n{json.dumps(built)}\nnot\n{json.dumps(want)}")
                otio = os.path.join(root, f"{tl['name']}.otio")
                d.export_otio(otio)
            finally:
                d.stop()
                d.close()
            d = session(adapter, build, root, tl["name"] + "-open")
            try:
                missing = d.import_otio(otio).get("missing")
                opened = state_shape(d.get_state(), media)
            finally:
                d.stop()
                d.close()
            if missing or opened != want:
                raise SystemExit(f"{tl['name']}: v0.2.0 opens its own export as\n{json.dumps(opened)} (missing "
                                 f"{missing})\nnot\n{json.dumps(want)}")
            with open(otio, encoding="utf-8") as f:
                text = f.read()
            url = "file://" + urllib.parse.quote(media)
            n_url = text.count(json.dumps(url)[1:-1])  # the file:// URLs first, then the paths left
            text = text.replace(json.dumps(url)[1:-1], "file://" + MEDIA_TOKEN)
            n_path = text.count(json.dumps(media)[1:-1])
            text = text.replace(json.dumps(media)[1:-1], MEDIA_TOKEN)
            if root in text or n_path == 0:
                raise SystemExit(f"{tl['name']}: the media folder is not (only) where it was expected in the file")
            with open(os.path.join(a.out, f"{tl['name']}.otio"), "w", encoding="utf-8", newline="") as f:
                f.write(text)
            entry = {"file": f"{tl['name']}.otio", "what": tl["what"], **want, "probes": tl["probes"],
                     "media_folder_replaced": n_path, "media_url_replaced": n_url}
            manifest["files"].append(entry)
            log(f"{tl['name']}: ok ({n_path} media paths, {n_url} URLs replaced)")
        with open(os.path.join(a.out, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=1)
            f.write("\n")
    finally:
        if not a.keep:
            shutil.rmtree(root, ignore_errors=True)
        else:
            log(f"kept {root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
