"""A crafted project or OTIO file can neither write outside the editor's own folders, nor make the editor (or the
FFmpeg it runs) fetch a URL, nor smuggle filter text into a render. Port of packages/core/scripts/smoke-safepath.ts
(judge/PORTING.md has the map of its sections; the checks of the guard functions themselves stay with that script).

Observations, all made by the judge itself:
- a loopback listener (observe.Canary, 127.0.0.1 on a free port) that must receive no connection: every URL in a
  hostile input names it;
- files that must not appear: a marker in crafted identifiers that must never become a file name, and payload files
  that a filter option smuggled into a render would write;
- refusals, the project the editor reports (get_state), what its file surface serves, and exports.

Every hostile file is the editor's own saved project (or OTIO export) with values replaced by text substitution
(observe.substitute), so the test needs no knowledge of the file format; a substitution that finds nothing to replace
fails the check that uses its file. Every check is recorded on every path, so CHECKS is exact.
"""
import os
import secrets
import shutil

import driver as drv
import observe

PORT_BOUND = True
TIMEOUT = 1500
CHECKS = 31

LUT_TEXT = "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n"
LEGIT_COLOURS = ["#ffe14d", "#000000cc", "0xFFE14D", "yellow", "white@0.5", "black@0.55"]
# Distinctive values of the full-featured project, each later given a filter payload (section 10).
GRADE = {"brightness": 0.0123, "contrast": 1.0123, "saturation": 1.0234, "gamma": 1.0345}
COLOUR = {"temperature": 0.123, "tint": -0.0456, "hue": 7.89}
BLUR, VIGNETTE, SIMILARITY, BLEND, SPEED = 2.345, 0.4567, 0.1234, 0.0567, 1.25


def refused(fn):
    """(refused?, what happened): refused = the editor answered with an error (product_error or bad_request)."""
    try:
        r = fn()
        return False, f"accepted: {str(r)[:160]}"
    except (drv.ProductError, drv.BadRequest) as e:
        return True, f"refused: {e.message[:160]}"


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

    def craft(name, pairs, base=legit):
        out = t.path("projects", name)
        counts = observe.substitute(base, out, pairs)
        return out, all(c > 0 for c in counts), f"replacements {counts}"

    def first_clip():
        cs = d.clips("v0")
        return cs[0]["id"] if cs else "none"

    # ---- 3. identifiers that hold '../' paths: nothing named after them appears anywhere
    marker = "ESCAPED-" + secrets.token_hex(4)
    trav, ok, why = craft("traversal.aive", [(asset, f"../../{marker}-asset"), (clip, f"../../{marker}-clip"),
                                            (text, f"../../{marker}-text")])
    loaded, what = (not refused(lambda: d.load_project(trav))[0]), ""
    t.check("a project whose identifiers hold '../' paths loads", ok and loaded, f"{why}; loaded {loaded}")
    st = d.get_state()
    aid = (st.get("assets") or [{}])[0].get("id", "none")
    for fn in (lambda: d.thumbnail(aid, 0.5), lambda: d.make_proxy(aid), lambda: d.render_frame(0.5, t.path("out", "trav.png"))):
        refused(fn)
    job = d.export(t.path("out", "trav.mp4"))
    t.check("…and it renders: the export finishes", job.get("status") == "done", job)
    found = observe.named(os.path.dirname(t.scratch), marker)
    t.check("no file or folder named after a crafted identifier appears (the test's folder and the run's)",
            not found, found[:5])

    # ---- 4. URLs in a project or OTIO file, or given to an operation, are refused and never fetched
    url_proj, ok, why = craft("url-media.aive", [(src, canary.url("asset.mp4"))])
    r, what = refused(lambda: d.load_project(url_proj))
    t.check("opening a project whose media path is an http URL is refused", ok and r, f"{why}; {what}")
    lut_proj, ok, why = craft("url-lut.aive", [(lut, canary.url("look.cube"))])
    r, what = refused(lambda: d.load_project(lut_proj))
    t.check("opening a project whose LUT is an http URL is refused", ok and r, f"{why}; {what}")
    for label, value in (("a subfile,…: protocol form", f"subfile,,start,0,end,0,,:{src}"),
                         ("a data: URI", "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28y")):
        p, ok, why = craft(f"proto-{label[:6].strip(',: ')}.aive", [(src, value)])
        r, what = refused(lambda: d.load_project(p))
        a = None if r else next((x for x in d.get_state().get("assets", []) if x.get("path") == value), None)
        t.check(f"a project whose media path is {label} is refused, or its media stays offline",
                ok and (r or (a is not None and a.get("offline") is True)), f"{why}; {what if r else a}")
    url_otio, ok, why = craft("url.otio", [(f"file://{src}", canary.url("otio.mp4")), (src, canary.url("meta.mp4"))],
                              base=legit_otio)
    r, what = refused(lambda: d.import_otio(url_otio))
    t.check("importing an OTIO file whose media is an http URL is refused", ok and r, f"{why}; {what}")

    # A refused open leaves the open project as it was: its edits, its undo history, and the file it saves to.
    other = t.path("projects", "other.aive")
    shutil.copyfile(legit, other)
    d.load_project(legit)
    d.move_clip(first_clip(), 30)
    before = shape(d.get_state())
    r1, w1 = refused(lambda: d.load_project(url_proj))
    t.check("after a refused project open the open project is unchanged (with its unsaved edit)",
            r1 and shape(d.get_state()) == before, w1)
    r2, w2 = refused(lambda: d.import_otio(url_otio))
    t.check("after a refused OTIO import the open project is unchanged", r2 and shape(d.get_state()) == before, w2)
    d.undo()
    starts = [c.get("start_frame") for c in d.clips("v0")]
    d.redo()
    t.check("…and its undo history works (undo puts the clip back at frame 0)", starts == [0], starts)
    d.load_project(other)  # opening another project first saves the open one's unsaved edits to its own file
    d.load_project(legit)
    starts = [c.get("start_frame") for c in d.clips("v0")]
    t.check("…and the next open saves the unsaved edit into the user's own project, not the refused file",
            starts == [30], starts)
    d.move_clip(first_clip(), 0)  # the legitimate project as it was, for the sections below
    d.save_project(legit)

    # Relative and foreign local paths are not URLs: they load (an OTIO import makes an offline placeholder).
    rel, ok, why = craft("relative.aive", [(src, "media/relative-clip.mp4")])
    r, what = refused(lambda: d.load_project(rel))
    a = None if r else next((x for x in d.get_state().get("assets", []) if x.get("path") == "media/relative-clip.mp4"), None)
    t.check("a project with a relative (scheme-free) media path loads, the path unchanged",
            ok and not r and a is not None, f"{why}; {what if r else a}")
    rel_otio, ok, why = craft("relative.otio", [(f"file://{src}", "media/relative-shot.mov"),
                                                (src, "media/relative-shot.mov")], base=legit_otio)
    r, what = refused(lambda: d.import_otio(rel_otio))
    offl = [] if r else [x.get("offline") for x in d.get_state().get("assets", [])]
    t.check("an OTIO file with a relative media path imports, the media offline",
            ok and not r and offl and all(offl), f"{why}; {what if r else offl}")
    win = "C:\\Users\\a\\clip.mp4"
    winp, ok, why = craft("windows.aive", [(src, win)])
    r, what = refused(lambda: d.load_project(winp))
    a = None if r else next((x for x in d.get_state().get("assets", []) if x.get("path") == win), None)
    t.check("a project saved on Windows (a C:\\ media path) loads with the path unchanged",
            ok and not r and a is not None, f"{why}; {what if r else a}")
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
    notlut, ok, why = craft("lut-not-cube.aive", [(lut, notes)])
    refused(lambda: d.load_project(notlut))
    g = d.http_get("/file", {"path": notes})
    t.check("a project that names a text file as its LUT does not make that file servable",
            ok and not 200 <= g["status"] < 300 and marker2.encode() not in g["body"], f"{why}; status {g['status']}")

    d.load_project(legit)
    r, what = refused(lambda: d.apply_lut(first_clip(), canary.url("x.cube"), raw=True))
    t.check("applying a LUT given as an http URL is refused", r, what)
    r1, w1 = refused(lambda: d.import_media(canary.url("v.mp4"), raw=True))
    r2, w2 = refused(lambda: d.import_media("data:video/mp4;base64,AAAAIGZ0eXBpc29t", raw=True))
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
    crafted, ok, why = craft("values.aive", [(v, f"{v}{pay}") for v in values] + [(lut, odd_lut)], base=full)
    r, what = refused(lambda: d.load_project(crafted))
    t.check("a project whose rendering values carry filter text loads", ok and not r, f"{why}; {what}")
    st = d.get_state()
    nums = [st.get("canvas", {}).get(k) for k in ("width", "height", "fps")] + [
        c.get(k) for tr in st.get("tracks", []) for c in tr.get("clips", [])
        for k in ("start_frame", "in_frame", "out_frame", "length_frames", "speed")]
    t.check("…and reports its canvas and clips with numbers only", nums and all(
        isinstance(v, (int, float)) and not isinstance(v, bool) for v in nums), nums)
    job = d.export(t.path("out", "values.mp4"))
    t.check("…and exports", job.get("status") == "done", job)
    t.check("no file was written through a project value", not os.path.exists(pwn10), pwn10)

    t.check("the loopback listener received nothing over the whole test", canary.count() == 0, canary.seen())
