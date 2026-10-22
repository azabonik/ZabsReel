"""A crafted project or OTIO file can neither write outside the editor's own folders, nor make the editor (or the
FFmpeg it runs) fetch a URL, nor smuggle filter text into a render. Port of packages/core/scripts/smoke-safepath.ts
(judge/PORTING.md has the map of its sections; the checks of the guard functions themselves stay with that script).

Observations, all made by the judge itself:
- a loopback listener (observe.Canary, 127.0.0.1 on a free port) that must receive no connection: every URL in a
  hostile input names it;
- files that must not appear: a marker in crafted identifiers that must never become a file name, and payload files
  that a filter option smuggled into a render would write;
- files that must not change: a refused project and OTIO file, hashed before the refusals (the plain Save after them
  must write the user's project);
- refusals, the project the editor reports (get_state), what its file surface serves, and exports.

Every hostile file is the editor's own saved project (or OTIO export) with values replaced by text substitution
(observe.craft), so the test needs no knowledge of the file format. When the saved file does not hold a value as the
test gave it (an identifier verbatim, a colour as given, a number exactly once: another file format), that input
cannot be made, and every check on it is recorded as not applicable (listed by name; run.py --strict fails it), never
as failed. Every check is recorded on every path, so CHECKS is exact.
"""
import base64
import os
import secrets
import shutil

import driver as drv
from driver import refused
import observe

PORT_BOUND = True
TIMEOUT = 1500
CHECKS = 35

LUT_TEXT = "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n"
LEGIT_COLOURS = ["#ffe14d", "#000000cc", "0xFFE14D", "yellow", "white@0.5", "black@0.55"]
# Distinctive text style values (none of them elsewhere in the project), each later given filter text (section 8,
# from a file). The two numbers must occur once in the saved project: small numbers such as an edit counter can
# take the same value.
TEXT_STYLE = {"color": "#c0ffee", "box": True, "box_color": "#0a0b0c99", "box_border": 117, "outline_width": 2,
              "outline_color": "#1b2c3d", "shadow_x": 3, "shadow_y": 3, "shadow_color": "#2c3d4e", "font_size": 113}
# Distinctive values of the full-featured project, each later given a filter payload (section 10).
GRADE = {"brightness": 0.0123, "contrast": 1.0123, "saturation": 1.0234, "gamma": 1.0345}
COLOUR = {"temperature": 0.123, "tint": -0.0456, "hue": 7.89}
BLUR, VIGNETTE, SIMILARITY, BLEND, SPEED = 2.345, 0.4567, 0.1234, 0.0567, 1.25


def shape(st):
    """What a project is, without its identifiers: canvas, media paths, and each track's clips."""
    return {"canvas": st.get("canvas"), "assets": sorted(a.get("path") or "" for a in st.get("assets", [])),
            "tracks": [(tr.get("track"), [(c.get("start_frame"), c.get("in_frame"), c.get("out_frame"),
                                           c.get("length_frames"), c.get("speed")) for c in tr.get("clips", [])])
                       for tr in st.get("tracks", [])]}


def run(t):
    canary = observe.Canary()
    try:
        body(t, canary)
    finally:
        canary.close()


def body(t, canary):
    d = t.driver()
    d.set_project(width=640, height=360, fps=30)
    src = t.path("media", "a.mp4")
    shutil.copyfile(t.media("a.mp4"), src)
    lut = t.path("media", "look.cube")
    with open(lut, "w", encoding="utf-8") as f:
        f.write(LUT_TEXT)
    asset = d.import_media(src)
    clip = d.place_clip(asset, "v0", 0, 0, 60)
    text = d.add_text(clip, "hi", box=True)
    d.apply_lut(clip, lut)
    legit = t.path("projects", "legit.aive")
    d.save_project(legit)
    legit_otio = t.path("projects", "legit.otio")
    d.export_otio(legit_otio)

    def craft(name, pairs, what, base=legit, need=None):
        return observe.craft(base, t.path("projects", name), pairs, what, need)

    def first_clip():
        cs = d.clips("v0")
        return cs[0]["id"] if cs else "none"

    # ---- 3. identifiers that hold '../' paths: nothing named after them appears anywhere
    marker = "ESCAPED-" + secrets.token_hex(4)
    trav = craft("traversal.aive", [(asset, f"../../{marker}-asset"), (clip, f"../../{marker}-clip"),
                                    (text, f"../../{marker}-text")], "the asset, clip and text identifiers verbatim")
    loaded = not refused(lambda: d.load_project(trav.path))[0]
    t.check("a project whose identifiers hold '../' paths loads", loaded, f"replacements {trav.counts}; loaded {loaded}",
            needs=trav)
    st = d.get_state()
    aid = (st.get("assets") or [{}])[0].get("id", "none")
    for fn in (lambda: d.thumbnail(aid, 0.5), lambda: d.make_proxy(aid), lambda: d.render_frame(0.5, t.path("out", "trav.png"))):
        refused(fn)
    job = d.export(t.path("out", "trav.mp4"))
    t.check("…and it renders: the export finishes", job.get("status") == "done", job, needs=trav)
    seen = t.look(walk=[os.path.dirname(t.scratch)])["walk"]  # every entry, as the runner or the editor's user sees it
    found = [p for p in seen if marker in os.path.basename(p)]
    t.check("no file or folder named after a crafted identifier appears (the test's folder and the run's)",
            not found, found[:5], needs=trav)

    # ---- 4. URLs in a project or OTIO file, or given to an operation, are refused and never fetched
    media_path = "the media path as given"
    url_proj = craft("url-media.aive", [(src, canary.url("asset.mp4"))], media_path)
    r, what = refused(lambda: d.load_project(url_proj.path))
    t.check("opening a project whose media path is an http URL is refused", r, what, needs=url_proj)
    lut_proj = craft("url-lut.aive", [(lut, canary.url("look.cube"))], "the LUT path as given")
    r, what = refused(lambda: d.load_project(lut_proj.path))
    t.check("opening a project whose LUT is an http URL is refused", r, what, needs=lut_proj)
    # A data: URI that holds real media (a small H.264 MP4): an editor that opened it would show the media online.
    data_uri = "data:video/mp4;base64," + base64.b64encode(open(t.media("tiny.mp4"), "rb").read()).decode("ascii")
    t.measure("control: FFmpeg decodes the data: URI used below (it holds a small video)",
              lambda: observe.media_streams(data_uri), lambda v: "video" in v, "a video stream")
    for label, value in (("a subfile,…: protocol form", f"subfile,,start,0,end,0,,:{src}"),
                         ("a data: URI holding a video", data_uri)):
        c = craft(f"proto-{label[:6].strip(',: ')}.aive", [(src, value)], media_path)
        r, what = refused(lambda: d.load_project(c.path))
        a = None if r else next((x for x in d.get_state().get("assets", []) if x.get("path") == value), None)
        t.check(f"a project whose media path is {label} is refused, or its media stays offline",
                r or (a is not None and a.get("offline") is True), what if r else str(a)[:300], needs=c)
    url_otio = craft("url.otio", [(f"file://{src}", canary.url("otio.mp4")), (src, canary.url("meta.mp4"))],
                     "the media path (as a file:// URL or a path)", base=legit_otio, need=lambda c: c[0] + c[1] > 0)
    r, what = refused(lambda: d.import_otio(url_otio.path))
    t.check("importing an OTIO file whose media is an http URL is refused", r, what, needs=url_otio)

    # A refused open leaves the open project as it was: its edits, its undo history, and the file it saves to. The
    # file is observed through the plain Save after an edit made once both refusals are over: the edit must land in
    # the user's project, and neither refused file may change.
    # (A file that could not be made is not opened: it would be the user's project, not a refusal.)
    both = [url_proj, url_otio]
    d.load_project(legit)
    d.move_clip(first_clip(), 30)
    before = shape(d.get_state())
    refused_files = {c.path: observe.sha256(c.path) for c in both}
    r1, w1 = refused(lambda: d.load_project(url_proj.path)) if url_proj.applicable else (False, "")
    t.check("after a refused project open the open project is unchanged (with its edit)",
            r1 and shape(d.get_state()) == before, w1, needs=url_proj)
    r2, w2 = refused(lambda: d.import_otio(url_otio.path)) if url_otio.applicable else (False, "")
    t.check("after a refused OTIO import the open project is unchanged", r2 and shape(d.get_state()) == before, w2,
            needs=url_otio)
    d.undo()
    starts = [c.get("start_frame") for c in d.clips("v0")]
    d.redo()
    t.check("…and its undo history works (undo puts the clip back at frame 0)", starts == [0], starts, needs=both)
    d.move_clip(first_clip(), 45)  # an edit made after the refusals
    r3, w3 = refused(d.save)
    starts = []
    if not r3:
        d.load_project(legit)
        starts = [c.get("start_frame") for c in d.clips("v0")]
    t.check("…and Save then writes the user's own project: reopened, it has the edit made after the refusals",
            not r3 and starts == [45], f"{w3}; {starts}", needs=both)
    changed = [os.path.basename(p) for p, h in refused_files.items() if observe.sha256(p) != h]
    t.check("…and neither refused file was written (the project and the OTIO file are unchanged)", not changed,
            changed, needs=both)
    d.load_project(legit)
    d.move_clip(first_clip(), 0)  # the legitimate project as it was, for the sections below
    d.save_project(legit)

    # Relative and foreign local paths are not URLs: they load (an OTIO import makes an offline placeholder).
    rel = craft("relative.aive", [(src, "media/relative-clip.mp4")], media_path)
    r, what = refused(lambda: d.load_project(rel.path))
    a = None if r else next((x for x in d.get_state().get("assets", []) if x.get("path") == "media/relative-clip.mp4"), None)
    t.check("a project with a relative (scheme-free) media path loads, the path unchanged",
            not r and a is not None, what if r else a, needs=rel)
    rel_otio = craft("relative.otio", [(f"file://{src}", "media/relative-shot.mov"), (src, "media/relative-shot.mov")],
                     "the media path (as a file:// URL or a path)", base=legit_otio, need=lambda c: c[0] + c[1] > 0)
    r, what = refused(lambda: d.import_otio(rel_otio.path))
    offl = [] if r else [x.get("offline") for x in d.get_state().get("assets", [])]
    t.check("an OTIO file with a relative media path imports, the media offline",
            not r and offl and all(offl), what if r else offl, needs=rel_otio)
    win = "C:\\Users\\a\\clip.mp4"
    winp = craft("windows.aive", [(src, win)], media_path)
    r, what = refused(lambda: d.load_project(winp.path))
    a = None if r else next((x for x in d.get_state().get("assets", []) if x.get("path") == win), None)
    t.check("a project saved on Windows (a C:\\ media path) loads with the path unchanged",
            not r and a is not None, what if r else a, needs=winp)
    colon = t.path("media", "clip 10:30.mp4")
    shutil.copyfile(src, colon)
    r, what = refused(lambda: d.import_media(colon))
    g = d.http_get("/file", {"path": colon})
    t.check("a local file with a colon in its name imports and is served (a colon is not a protocol)",
            not r and g["status"] == 200 and g["body_sha256"] == observe.sha256(colon), f"{what}; {g['status']}")

    # A LUT path that names a file that is no LUT does not make that file servable.
    marker2 = "judge-private-" + secrets.token_hex(16)
    notes = t.path("private", "notes.txt")
    with open(notes, "w", encoding="utf-8") as f:
        f.write(marker2 + "\n")
    notlut = craft("lut-not-cube.aive", [(lut, notes)], "the LUT path as given")
    refused(lambda: d.load_project(notlut.path))
    g = d.http_get("/file", {"path": notes})
    t.check("a project that names a text file as its LUT does not make that file servable",
            not 200 <= g["status"] < 300 and marker2.encode() not in g["body"], f"status {g['status']}", needs=notlut)

    d.load_project(legit)
    r, what = refused(lambda: d.apply_lut(first_clip(), canary.url("x.cube"), raw=True))
    t.check("applying a LUT given as an http URL is refused", r, what)
    r1, w1 = refused(lambda: d.import_media(canary.url("v.mp4"), raw=True))
    r2, w2 = refused(lambda: d.import_media(data_uri, raw=True))
    t.check("importing an http URL or a data: URI is refused", r1 and r2, f"{w1}; {w2}")
    t.check("the loopback listener received nothing (every URL above named it)", canary.count() == 0, canary.seen())

    # ---- 7. a legitimate project loads and renders
    d.load_project(legit)
    png = t.path("out", "legit.png")
    r, what = refused(lambda: d.render_frame(0.5, png))
    t.measure("a legitimate project loads and renders a frame", lambda: observe.size(png) if not r else None,
              lambda v: v is not None and v[:2] == (640, 360), f"a 640x360 frame ({what})")

    # ---- 8. text style values that carry filter text: refused or harmless
    pwn8 = t.path("pwn", "text-style.txt")
    hostile = [
        {"color": f"red,metadata=mode=print:file={pwn8}"},
        {"color": f"red:x=0,movie={canary.url('t.mp4')}"},
        {"box": True, "box_color": f"black:x=0,metadata=mode=print:file={pwn8}"},
        {"font_size": "12,movie=x"},
        {"box": True, "box_border": "1:enable=0"},
        {"outline_width": 2, "outline_color": f"blue,movie={canary.url('o.mp4')}"},
        {"shadow_x": 3, "shadow_color": "#000:y=0"},
        {"position": f"bottom,metadata=mode=print:file={pwn8}"},
        {"position": "constructor"},
    ]
    cl = first_clip()
    kept = [style for style in hostile if not refused(lambda style=style: d.add_text(cl, "x", **style))[0]]
    job = d.export(t.path("out", "styles.mp4"))
    t.check("with each hostile text style refused or kept, the export finishes", job.get("status") == "done",
            f"kept {len(kept)} of {len(hostile)}: {kept}; {job}")
    t.check("no file was written through a text style", not os.path.exists(pwn8), pwn8)
    bad = [c for c in LEGIT_COLOURS if refused(lambda c=c: d.add_text(cl, "c", color=c, box=True, box_color=c))[0]]
    t.check("the documented colour forms (#rrggbb, #rrggbbaa, 0xRRGGBB, a name, name@alpha) are accepted", not bad,
            bad)

    # ---- 8, from a file. The same kind of values read from a project file, where no tool's input check runs first:
    # a text styled with distinctive values, saved, and each value given filter text by substitution.
    d.load_project(legit)
    d.add_text(first_clip(), "styled", **TEXT_STYLE)
    styled = t.path("projects", "styled.aive")
    d.save_project(styled)
    pwn8f = t.path("pwn", "text-style-file.txt")
    pay8 = f",metadata=mode=print:file={pwn8f}"
    pairs = [(TEXT_STYLE["color"], TEXT_STYLE["color"] + pay8),
             (TEXT_STYLE["box_color"], f"{TEXT_STYLE['box_color']}:x=0,movie={canary.url('box.mp4')}"),
             (TEXT_STYLE["outline_color"], TEXT_STYLE["outline_color"] + pay8),
             (TEXT_STYLE["shadow_color"], f"{TEXT_STYLE['shadow_color']}:y=0,movie={canary.url('shadow.mp4')}"),
             (TEXT_STYLE["font_size"], f"{TEXT_STYLE['font_size']}{pay8}"),
             (TEXT_STYLE["box_border"], f"{TEXT_STYLE['box_border']}{pay8}")]
    # The two numbers must each be found exactly once: a number found elsewhere too (an edit counter) would change
    # that as well, so the input could not be made.
    ts = craft("text-style.aive", pairs, "the text's colours as given and its font size and box border once each",
               base=styled, need=lambda c: all(x > 0 for x in c[:4]) and c[4:] == [1, 1])
    harmless, what = refused(lambda: d.load_project(ts.path))  # refused at open, or opened and exported below
    if not harmless:
        try:
            job = d.export(t.path("out", "text-style.mp4"))
            harmless, what = job.get("status") == "done", f"opened; export {job.get('status')}: {job.get('error')}"
        except drv.JudgeError as e:
            what = f"opened; export refused: {str(e)[:300]}"
    t.check("a project whose text colours, size and box border carry filter text is refused at open, or opens and "
            "its export finishes", harmless, f"replacements {ts.counts}; {what}", needs=ts)
    t.check("no file was written through a text style value in a project", not os.path.exists(pwn8f), pwn8f,
            needs=ts)

    # ---- 11. a project using the rendering features saves and loads unchanged, and renders the same
    d.load_project(legit)
    cl = first_clip()
    d.apply_colour(cl, **GRADE)
    d.apply_colour(cl, **COLOUR)
    d.apply_effect(cl, "blur", amount=BLUR)
    d.apply_effect(cl, "vignette", amount=VIGNETTE)
    d.apply_effect(cl, "chromakey", params={"similarity": SIMILARITY, "blend": BLEND})
    d.set_speed(cl, SPEED)
    full = t.path("projects", "full.aive")
    f1, f2 = t.path("out", "full-1.png"), t.path("out", "full-2.png")
    d.render_frame(0.5, f1)
    before = shape(d.get_state())
    d.save_project(full)
    d.load_project(legit)
    d.load_project(full)
    t.check("a project using colour, effects, a LUT, text and speed saves and loads unchanged",
            shape(d.get_state()) == before, shape(d.get_state()))
    d.render_frame(0.5, f2)
    t.measure("…and renders the same frame after the load", lambda: observe.ssim(f1, f2), lambda v: v >= 0.99,
              "SSIM >= 0.99")

    # ---- 10. the same project with filter text added to every rendering value
    pwn10 = t.path("pwn", "values.txt")
    pay = f",metadata=mode=print:file={pwn10}"
    odd_lut = t.path("luts", "look,x:y[z]';.cube")
    with open(odd_lut, "w", encoding="utf-8") as f:
        f.write(LUT_TEXT)
    values = list(GRADE.values()) + list(COLOUR.values()) + [BLUR, VIGNETTE, SIMILARITY, BLEND, SPEED]
    vals = craft("values.aive", [(v, f"{v}{pay}") for v in values] + [(lut, odd_lut)],
                 "each rendering value as given and the LUT path", base=full)
    r, what = refused(lambda: d.load_project(vals.path))
    t.check("a project whose rendering values carry filter text loads", not r, f"replacements {vals.counts}; {what}",
            needs=vals)
    st = d.get_state()
    nums = [st.get("canvas", {}).get(k) for k in ("width", "height", "fps")] + [
        c.get(k) for tr in st.get("tracks", []) for c in tr.get("clips", [])
        for k in ("start_frame", "in_frame", "out_frame", "length_frames", "speed")]
    t.check("…and reports its canvas and clips with numbers only", nums and all(
        isinstance(v, (int, float)) and not isinstance(v, bool) for v in nums), nums, needs=vals)
    job = d.export(t.path("out", "values.mp4"))
    t.check("…and exports", job.get("status") == "done", job, needs=vals)
    t.check("no file was written through a project value", not os.path.exists(pwn10), pwn10, needs=vals)

    t.check("the loopback listener received nothing over the whole test", canary.count() == 0, canary.seen())
