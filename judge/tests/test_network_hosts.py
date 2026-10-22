"""Network computers end to end: the editor never opens a file on a computer the user has not allowed, an agent cannot
allow one or read the secret that stamps the allowed list, and the user's own allow / keep / revoke work. Port of
packages/core/scripts/smoke-unc-e2e.ts (judge/PORTING.md has the map of its sections).

The computers are under the reserved .invalid domain (zr-evil-N.invalid, never resolvable). On Linux a path such as
//zr-evil-1.invalid/s/a1.mp4 is also a local path that does not exist, so the only sign that the editor tried to open
it is the file-system call itself: the adapter and everything it starts run under `strace -f -e trace=%file`
(t.driver(trace=True)), and the test searches that trace for the computers' names (observe.trace_hits on t.trace, the
lines the test process read while the editor ran; argv is never looked at). Without strace on the system the trace checks are recorded as not observed (run.py --require-trace fails
them).

The hostile project is the editor's own saved project with its media paths replaced by network paths
(observe.craft), so the test needs no knowledge of the file format. When the saved file does not hold a value as
given (another file format), that input cannot be made, and every check on it is recorded as not applicable (listed
by name; run.py --strict fails it), never as failed. add_host_outside plays an attacker who edits
the editor's allowed list without its window (one plain entry, one with a forged stamp); approve_host and revoke_host
are the user's own actions. Every approval or revoke is followed by recheck_media.

Motion graphics (the original's graphics rows in sections 2 and 4): a graphic that imports a file on a test computer,
or the allowed list's secret file, is refused on both renderers, the graphics add-on (when the judge has one: run.py
--graphics-addon; without it those checks are not applicable) and the built-in one, each shown to work first by an
allowed graphic. The trace and transcript checks above and below cover what those refusals must not do.

Every check is recorded on every path, so CHECKS is exact.
"""
import json
import os
import shutil
import time

import driver as drv
from driver import refused
import observe

PORT_BOUND = True
TIMEOUT = 1500
CHECKS = 47
ABSENT = "(no waiting_host)"  # an asset without the field (PROTOCOL.md: a check that needs it fails)
BIG = 1 << 20  # a new file this large during the agent tool calls is a download (models are 13 to 150 MB)


def H(n):
    return f"zr-evil-{n}.invalid"


SPELL = {  # how each crafted media path names its computer: //host/..., \\host\..., both slash forms mixed
    1: lambda f: f"//{H(1)}/s/{f}",
    2: lambda f: f"\\\\{H(2)}\\s\\{f}",
    3: lambda f: f"\\\\{H(3)}\\s\\{f}",
    4: lambda f: f"//{H(4)}/s/{f}",
}
LOOKALIKE_HOSTS = ["\uff5a\uff52-evil-1.invalid", "zr\u200b-evil-1.invalid"]  # fullwidth zr; a zero-width space
LOOKALIKES = [f"\\\\{x}\\s\\a.mp4" for x in LOOKALIKE_HOSTS]
FRAMES_Q = {"from": "0", "count": "1", "w": "8", "h": "8", "fps": "30"}
UP = "../" * 40  # from wherever the editor keeps a graphic's code, enough '..' to reach the root
ALLOWED_GRAPHIC = ('import React from "react";\nimport { AbsoluteFill } from "remotion";\n'
                   'export default () => <AbsoluteFill style={{ background: "#00ff00" }} />;')
RENDERERS = {"addon": "the graphics add-on", "builtin": "the built-in renderer"}


def graphic_rows(t, d, codes, control):
    """{renderer: [(refused?, what)] for each of `codes`} on each renderer (the add-on only when the judge has one),
    chosen in the window as the user does; `control` (a dict, filled on the first call) gets whether an allowed graphic
    renders there. Leaves the built-in renderer chosen, as the editor starts."""
    out = {}
    for r in (["addon"] if t.graphics_addon else []) + ["builtin"]:
        d.set_graphics_renderer(r)
        if r not in control:  # tried twice: v0.2.0 picks a free port for the add-on's server and binds it later,
            # and another process can take the port in between (the render then fails)
            control[r] = refused(lambda: d.add_graphic(code=ALLOWED_GRAPHIC, duration_s=0.2))
            if control[r][0]:
                again = refused(lambda: d.add_graphic(code=ALLOWED_GRAPHIC, duration_s=0.2))
                control[r] = (again[0], f"{again[1]} (first try {control[r][1][:120]})")
        out[r] = [refused(lambda c=c: d.add_graphic(code=c, duration_s=1)) for c in codes]
    d.set_graphics_renderer("builtin")
    return out


def graphic_checks(t, name, rows, control):
    """One check per renderer: every code refused there, and the allowed graphic rendered there (so the refusals are
    the renderer's own, not a renderer that cannot run). The add-on's check is not applicable without one."""
    for r, label in RENDERERS.items():
        title = f"{name} on {label}"
        if r not in rows:
            t.not_applicable(title, t.graphics_addon_why)
            continue
        ctl = control.get(r, (True, "not tried"))
        t.check(title, not ctl[0] and all(ok for ok, _ in rows[r]),
                f"control: {ctl[1][:120]}; " + " | ".join(w[:120] for _, w in rows[r]))


def sha(t, paths):
    """{path: sha256, or None when it is not a regular file}, as the editor's user sees them (t.look: under run.py
    --as-user the editor's private files are not readable by the runner's user)."""
    return t.look(files=paths)["files"]


def listing(t, folder):
    """The sorted names in `folder`, or None (t.look)."""
    return t.look(folders=[folder])["folders"][folder]


def file_sizes(t, root):
    """{path: size} of every regular file under `root` (links are not followed), as either user sees it (t.look)."""
    return {p: n for p, n in t.look(walk=[root])["walk"].items() if n is not None}


class Trace:
    """The adapter tree's file-system trace (t.trace: the lines the test process read while the editor ran), or not
    observed when strace is missing. When the trace cannot be trusted (a line not of strace's form, or the trace ended
    before stop: TraceTail.tampered), every trace check fails with that reason."""

    def __init__(self, t):
        self.src = t.trace

    def mark(self):
        return len(observe.trace_lines(self.src)) if self.src else 0

    def hits(self, names, start=0):
        return observe.trace_hits(self.src, names, start) if self.src else []

    def settle(self, d, limit=30):
        """Waits (at most `limit` s) until the editor runs no job and the trace stops growing for a second: work the
        user's approvals started in the background (probes, proxies) has finished before a revoke is observed."""
        deadline = time.time() + limit
        while time.time() < deadline:
            n = self.mark()
            time.sleep(1.0)
            busy = any(j.get("status") == "running" for j in d.jobs())
            if not busy and self.mark() == n:
                return True
        return False

    def check(self, t, name, ok_fn, detail_fn, needs=()):
        if not self.src:
            t.not_observed(name, t.trace_why or "strace is not installed")
        elif self.src.tampered:
            t.check(name, False, self.src.tampered, needs=needs)
        else:
            t.check(name, ok_fn(), detail_fn(), needs=needs)


def run(t):
    d = t.driver(trace=True, graphics_addon=True)
    tr = Trace(t)
    d.set_project(width=640, height=360, fps=30)

    # ---- setup: five local clips (one stays local), a LUT and a font file, all in the project the editor saves
    src = t.media("a.mp4")
    local = t.path("media", "local.mp4")
    shutil.copyfile(src, local)
    files = {n: t.path("media", f"e{n}.mp4") for n in SPELL}
    for p in files.values():
        shutil.copyfile(src, p)
    lut = t.path("media", "look.cube")
    with open(lut, "w", encoding="utf-8") as f:
        f.write("LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n")
    assets, clips = {}, {}
    for i, (k, p) in enumerate([("local", local)] + list(files.items())):
        assets[k] = d.import_media(p)
        clips[k] = d.place_clip(assets[k], "v0", i * 30, 0, 30)
    d.apply_lut(clips[2], lut)
    font = t.path("media", "judge-font.ttf")  # a font file path the saved project keeps (its bytes are never used)
    with open(font, "wb") as f:
        f.write(b"\0" * 64)
    d.add_text(clips["local"], "hi", font=font)
    legit = t.path("projects", "legit.aive")
    d.save_project(legit)
    legit_otio = t.path("projects", "legit.otio")
    d.export_otio(legit_otio)

    # The attacker's entries, before any approval: \\zr-evil-3 plain, \\zr-evil-4 with a forged stamp.
    d.add_host_outside(H(3))
    priv = d.add_host_outside(H(4), forged=True)
    private, secrets = list(priv.get("files") or []), [s for s in priv.get("secrets") or [] if s]
    private_before = sha(t, private)

    net = {n: SPELL[n](f"a{n}.mp4") for n in SPELL}
    lut_net = f"\\\\{H(1)}\\s\\look.cube"
    cr = observe.craft(legit, t.path("projects", "crafted.aive"), [(files[n], net[n]) for n in SPELL]
                       + [(lut, lut_net)], "each media path and the LUT path as given")
    crafted = cr.path
    t.check("the saved project names each media file and the LUT, so the hostile copy holds network paths only",
            True, f"replacements {cr.counts}", needs=cr)

    # ---- 1. load: every asset on a computer waits for it, each computer is pending once
    notice = None
    try:
        notice = d.load_project(crafted).get("notice")
        loaded = True
    except drv.JudgeError as e:
        loaded, notice = False, str(e)
    t.check("the crafted project loads", loaded, str(notice)[:300], needs=cr)
    st = d.get_state()
    by_path = {a.get("path"): a for a in st.get("assets", [])}
    waits = {n: (by_path.get(net[n]) or {}).get("waiting_host", ABSENT) for n in SPELL}
    loc = by_path.get(local) or {}
    t.check("each network asset waits for its own computer; the local one waits for none",
            all(waits[n] == H(n) and (by_path.get(net[n]) or {}).get("offline") is True for n in SPELL)
            and loc.get("waiting_host", ABSENT) is None and loc.get("offline") is False, f"{waits}; local {loc}",
            needs=cr)
    h = d.list_hosts()
    t.check("each computer is pending once, nothing is allowed",
            all(h["pending"].count(H(n)) == 1 for n in SPELL) and not h["approved"], h, needs=cr)
    d.recheck_media()  # the editor reads its allowed list again (the load may already have; this does not rely on it)
    h = d.list_hosts()
    t.check(f"{H(3)} (plain entry) and {H(4)} (forged stamp), written outside the window, are listed outside",
            sorted(h["outside"]) == [H(3), H(4)] and not h["approved"], h)
    t.check("the load's notice names each computer", all(H(n) in str(notice or "").lower() for n in SPELL),
            str(notice)[:400], needs=cr)

    # ---- 2. what refuses and what works while the media waits
    ok_x, what_x = refused(lambda: d.export(t.path("out", "x.mp4")))
    ok_f, what_f = refused(lambda: d.render_frame(0.5, t.path("out", "f.png")))
    t.check("an export of the timeline is refused", ok_x and not os.path.exists(t.path("out", "x.mp4")), what_x,
            needs=cr)
    t.check("rendering a frame is refused", ok_f, what_f, needs=cr)
    ok_t, what_t = refused(lambda: d.thumbnail(assets[1], 0.5))
    ok_p, what_p = refused(lambda: d.make_proxy(assets[1]))
    t.check("a thumbnail and a proxy of a waiting asset are refused", ok_t and ok_p, f"{what_t}; {what_p}", needs=cr)
    answers = []
    for p in (net[1], lut_net):
        for route, q in (("/file", {}), ("/frames", FRAMES_Q), ("/peaks", {})):
            r = d.http_get(route, {"path": p, **q})
            answers.append((route, p, r["status"]))
    t.check("the file surface serves no file of a waiting computer (/file, /frames, /peaks; media and LUT)",
            all(not 200 <= s < 300 for _, _, s in answers), answers, needs=cr)
    r = d.http_get("/file", {"path": local})
    t.check("control: the file surface serves the local clip", r["status"] == 200, r["status"])

    resaved = t.path("projects", "resaved.aive")
    ok_save = not refused(lambda: d.save_project(resaved))[0]
    ok_load = ok_save and not refused(lambda: d.load_project(resaved))[0]
    a1 = next((a for a in d.get_state().get("assets", []) if a.get("path") == net[1]), {})
    t.check("the project saves to a local file and loads again with the media still waiting",
            ok_save and ok_load and a1.get("waiting_host") == H(1), f"save {ok_save}, load {ok_load}, {a1}", needs=cr)
    moved = refused(lambda: d.move_clip(d.clips("v0")[0]["id"], 300))
    undo_ok = not refused(d.undo)[0] and not refused(d.redo)[0]
    a1 = next((a for a in d.get_state().get("assets", []) if a.get("path") == net[1]), {})
    t.check("editing, undo and redo work while media waits, and it still waits",
            not moved[0] and undo_ok and a1.get("waiting_host") == H(1), f"move {moved[1]}; undo/redo {undo_ok}; {a1}",
            needs=cr)

    def h7(name):
        return f"//{H(7)}/s/{name}"
    asks = [
        ("import", lambda: d.import_media(h7("x.mp4"), raw=True)),
        ("open project", lambda: d.load_project(h7("x.aive"), raw=True)),
        ("import OTIO", lambda: d.import_otio(h7("x.otio"), raw=True)),
        ("LUT", lambda: d.apply_lut(d.clips("v0")[0]["id"], h7("x.cube"), raw=True)),
        ("text font", lambda: d.add_text(d.clips("v0")[0]["id"], "t", font=h7("f.ttf"))),
        ("save project", lambda: d.save_project(h7("x.aive"), raw=True)),
        ("export", lambda: d.export(h7("x.mp4"), raw=True)),
        ("export OTIO", lambda: d.export_otio(h7("x.otio"), raw=True)),
    ]
    results = [(label, *refused(fn)) for label, fn in asks]
    t.check(f"every path on {H(7)} that the agent passes is refused (import, open, OTIO, LUT, font, save, export)",
            all(ok for _, ok, _ in results), [(lb, w) for lb, ok, w in results if not ok] or len(results))
    h = d.list_hosts()
    t.check(f"…and {H(7)} only waits for the user (pending, not allowed)",
            H(7) in h["pending"] and H(7) not in h["approved"], h)

    # An OTIO file names its media by URL (file://<path>) and may repeat the path elsewhere: both become the raw
    # network path, as a file written on another computer would hold it.
    pairs5 = []
    for p in [local] + list(files.values()):
        net5 = f"\\\\{H(5)}\\s\\{os.path.basename(p)}"
        pairs5 += [(f"file://{p}", net5), (p, net5)]
    cr5 = observe.craft(legit_otio, t.path("projects", "h5.otio"), pairs5, "each media path (as a file:// URL or a path)",
                        need=lambda c: all(c[i] + c[i + 1] > 0 for i in range(0, len(c), 2)))
    otio5 = cr5.path
    n5 = [cr5.counts[i] + cr5.counts[i + 1] for i in range(0, len(cr5.counts), 2)]
    st5, what5 = None, ""
    try:
        d.import_otio(otio5)
        st5 = d.get_state()
    except drv.JudgeError as e:
        what5 = str(e)
    w5 = [(a.get("offline"), a.get("waiting_host")) for a in (st5 or {}).get("assets", [])]
    t.check(f"an OTIO file whose media is on {H(5)} imports, every asset offline and waiting for it",
            st5 is not None and len(w5) >= 5 and all(w == (True, H(5)) for w in w5),
            f"replacements {n5}; {w5 or what5}", needs=cr5)

    # A graphic never imports a file on a network computer, on either renderer (the trace check below covers what
    # the refusals must not have opened).
    control = {}
    imports = [f'import x from "//{H(6)}/s/x";\nexport default () => String(x);',
               f'const ctx = (require as any).context("//{H(6)}/s", false, /x/);\nexport default () => String(ctx);',
               f'import x from "file://{H(6)}/s/x.png";\nexport default () => String(x);']
    rows = graphic_rows(t, d, imports, control)
    for r, label in RENDERERS.items():
        if r in control:
            t.check(f"control: an allowed graphic renders on {label}", not control[r][0], control[r][1][:300])
        else:
            t.not_applicable(f"control: an allowed graphic renders on {label}", t.graphics_addon_why)
    graphic_checks(t, f"a graphic that imports a file on {H(6)} (an import, require.context, a file:// URL) is refused",
                   rows, control)

    # ---- 3. so far nothing opened a file on any test computer
    tr.check(t, "no file-system call of the editor named a test computer (before any approval)",
             lambda: not tr.hits(["-evil-"]), lambda: tr.hits(["-evil-"])[:3])
    tr.check(t, "control: the trace saw the editor's own file-system calls", lambda: tr.mark() > 100,
             lambda: f"{tr.mark()} lines")

    # ---- 4. the allowed list's files and secret are out of the agent's reach
    t.check("the editor names the files of its allowed list and a secret to look for",
            len(private) >= 1 and all(h is not None for h in sha(t, private).values()) and len(secrets) >= 1, private)
    store_dir = os.path.dirname(private[-1]) if private else "/nonexistent"
    link_dir = t.path("links", "store-dir")        # a link to the store's folder: <link>/../<folder>/<file> is the
    os.symlink(store_dir, link_dir)                # file to the kernel, a path outside the folder to a lexical check

    def spellings(p, ext):
        """Every spelling of private file `p` (the original's section 4): direct, '..' inside the path, a link to the
        file named like a project or OTIO file (`ext`), '..' after a link to its folder, /proc/self/root before it,
        and /proc/self/root/.. before it (the kernel's root has no parent; to a lexical check it is /proc/self/...)."""
        folder, base = os.path.dirname(p), os.path.basename(p)
        link = t.path("links", f"{base}-link{ext}")
        if not os.path.lexists(link):
            os.symlink(p, link)
        return [p, os.path.join(folder, "..", os.path.basename(folder), base), link,
                os.path.join(link_dir, "..", os.path.basename(folder), base), f"/proc/self/root{p}",
                f"/proc/self/root/..{p}"]

    listing_before = listing(t, store_dir)
    writes = []
    for p in private:
        for label, ext, fn in (("save", ".aive", d.save_project), ("export OTIO", ".otio", d.export_otio)):
            for x in spellings(p, ext):
                writes.append((label, x, *refused(lambda x=x, fn=fn: fn(x, raw=True))))
    t.check("saving the project or exporting an OTIO file over the allowed list's files is refused in every "
            "spelling (direct, '..', a link, '..' after a link, /proc/self/root, /proc/self/root/..)",
            len(writes) == 12 * len(private) > 0 and all(ok for _, _, ok, _ in writes),
            [(lb, x, w) for lb, x, ok, w in writes if not ok]
            or f"{len(writes)} refused: " + " | ".join(sorted({w[:90] for _, _, _, w in writes})))
    clip0 = d.clips("v0")[0]["id"] if d.clips("v0") else "none"
    aliases = [x for p in private for x in spellings(p, ".mp4")]
    opens = []
    for p in aliases:
        for label, fn in (("open", lambda p=p: d.load_project(p, raw=True)),
                          ("OTIO", lambda p=p: d.import_otio(p, raw=True)),
                          ("import", lambda p=p: d.import_media(p, raw=True)),
                          ("LUT", lambda p=p: d.apply_lut(clip0, p, raw=True)),
                          ("font", lambda p=p: d.add_text(clip0, "t", font=p))):
            opens.append((label, p, *refused(fn)))
    t.check("opening the allowed list's files as a project, OTIO, media, LUT or font is refused (direct, '..', a "
            "link, '..' after a link, /proc/self/root, /proc/self/root/..)", all(ok for _, _, ok, _ in opens),
            [(lb, p, w) for lb, p, ok, w in opens if not ok] or len(opens))
    served = []
    for p in aliases:
        for route, q in (("/file", {}), ("/frames", FRAMES_Q), ("/peaks", {})):
            served.append((route, p, d.http_get(route, {"path": p, **q})["status"]))
    t.check("the file surface serves none of them", all(not 200 <= s < 300 for _, _, s in served),
            [x for x in served if 200 <= x[2] < 300] or len(served))
    secret_file = private[-1] if private else "/nonexistent/key"
    rows = graphic_rows(t, d, [f"import k from {json.dumps(secret_file)};\nexport default () => String(k);",
                               f"import k from {json.dumps(UP + secret_file.lstrip('/'))};\n"
                               "export default () => String(k);"], control)
    graphic_checks(t, "a graphic that imports the allowed list's secret file (its path, or a relative path to it) is "
                      "refused", rows, control)
    listing_after = listing(t, store_dir)
    t.check("the allowed list's files are unchanged, and no file was added beside them",
            sha(t, private) == private_before and listing_after is not None and listing_after == listing_before,
            f"{private}; folder {listing_before} -> {listing_after}")
    key = private[-1] if private else "/nonexistent/key"
    crk = observe.craft(legit, t.path("projects", "font-key.aive"), [(font, key)], "the text's font path as given")
    ok, what = refused(lambda: d.load_project(crk.path))
    t.check("a project whose text font is the allowed list's secret file does not open", ok,
            f"{crk.counts[0]} substitution(s); {what}", needs=crk)

    # ---- 9.4 what an agent is offered
    tools = d.agent_tools()
    names = [x.get("name", "") for x in tools.get("tools", [])]
    allowish = [n for n in names if any(w in n.lower() for w in ("approv", "allow", "grant", "trust"))]
    t.check("the agent is offered tools, none named like approve / allow / grant / trust", names and not allowish,
            allowish or f"{len(names)} tools")

    # ---- 5. the user allows \\zr-evil-1: its media comes online after a re-check, the others still wait
    refused(lambda: d.load_project(crafted))
    mark = tr.mark()
    d.approve_host(H(1))
    d.recheck_media()
    st = d.get_state()
    by_path = {a.get("path"): a for a in st.get("assets", [])}
    waits = {n: (by_path.get(net[n]) or {}).get("waiting_host", ABSENT) for n in SPELL}
    t.check(f"after the user allows {H(1)} and a re-check, its asset no longer waits; the others still do",
            waits == {1: None, 2: H(2), 3: H(3), 4: H(4)}, waits, needs=cr)
    a1_id = (by_path.get(net[1]) or {}).get("id", "")
    refused(lambda: d.thumbnail(a1_id, 0.5))  # makes the editor open \\zr-evil-1's file (it is not there)
    tr.check(t, f"control: the trace now has the editor opening {H(1)}'s files", lambda: bool(tr.hits([H(1)], mark)),
             lambda: f"{len(tr.hits([H(1)], mark))} lines", needs=cr)
    others = [H(n) for n in (2, 3, 4, 5, 6, 7, 8, 9)]
    tr.check(t, "…and still none for any other test computer", lambda: not tr.hits(others),
             lambda: tr.hits(others)[:3])

    d.approve_host(H(3))  # Keep: the plain entry written outside the window
    d.recheck_media()
    st = d.get_state()
    by_path = {a.get("path"): a for a in st.get("assets", [])}
    h = d.list_hosts()
    t.check(f"keeping {H(3)} in the window brings its asset online; {H(4)} (forged) still waits and stays outside",
            (by_path.get(net[3]) or {}).get("waiting_host", ABSENT) is None
            and (by_path.get(net[4]) or {}).get("waiting_host") == H(4) and h["outside"] == [H(4)]
            and H(4) not in h["approved"], f"{h}", needs=cr)

    w5 = []
    if not refused(lambda: d.import_otio(otio5))[0]:
        d.approve_host(H(5))
        d.recheck_media()
        w5 = [a.get("waiting_host", ABSENT) for a in d.get_state().get("assets", [])]
    t.check(f"the OTIO's placeholders stop waiting once {H(5)} is allowed", len(w5) >= 5 and not any(w5), w5,
            needs=cr5)

    look, crl = [], []
    lmark = tr.mark()
    for i, p in enumerate(LOOKALIKES):
        c = observe.craft(legit, t.path("projects", f"lookalike-{i}.aive"), [(files[1], p)], "the media path as given")
        crl.append(c)
        ok, what = refused(lambda: d.load_project(c.path))
        a = next((x for x in d.get_state().get("assets", []) if x.get("path") == p), None) if not ok else None
        look.append((repr(p), ok or (a is not None and a.get("offline") is True), what if ok else a))
    t.check(f"a look-alike of the allowed {H(1)} (fullwidth, zero-width space) is refused or stays offline",
            all(s for _, s, _ in look), look, needs=crl)
    tr.check(t, "…and the editor never opened a look-alike path", lambda: not tr.hits(LOOKALIKE_HOSTS, lmark),
             lambda: tr.hits(LOOKALIKE_HOSTS, lmark)[:3], needs=crl)

    # ---- 6. revoke: the media waits again and nothing opens it
    refused(lambda: d.load_project(crafted))
    tr.settle(d)
    d.revoke_host(H(1))
    d.recheck_media()
    st = d.get_state()
    a1 = next((a for a in st.get("assets", []) if a.get("path") == net[1]), {})
    t.check(f"after the user revokes {H(1)} and a re-check, its asset waits again", a1.get("waiting_host") == H(1), a1,
            needs=cr)
    mark = tr.mark()
    again = [refused(lambda: d.export(t.path("out", "x2.mp4"))),
             refused(lambda: d.render_frame(0.5, t.path("out", "f2.png"))),
             refused(lambda: d.thumbnail(a1.get("id", ""), 0.5)), refused(lambda: d.make_proxy(a1.get("id", "")))]
    t.check("export, frame, thumbnail and proxy are refused again", all(ok for ok, _ in again), [w for _, w in again],
            needs=cr)
    served = [(route, d.http_get(route, {"path": net[1], **q})["status"])
              for route, q in (("/file", {}), ("/frames", FRAMES_Q), ("/peaks", {}))]
    t.check("the file surface refuses the revoked computer's file again", all(not 200 <= s < 300 for _, s in served),
            served, needs=cr)
    tr.check(t, f"after the revoke nothing opened {H(1)}'s files", lambda: not tr.hits([H(1)], mark),
             lambda: tr.hits([H(1)], mark)[:3], needs=cr)
    tr.check(t, f"the computers never allowed ({H(4)} with its forged stamp, {H(7)}) were never opened",
             lambda: not tr.hits([H(4), H(7)]), lambda: tr.hits([H(4), H(7)])[:3])

    # ---- 4 (end). every agent tool with empty arguments allows nothing, and no answer held the secret
    before, files_before = d.list_hosts(), sha(t, private)
    sizes_before = file_sizes(t, t.scratch)
    poked = d.poke_agent_tools()
    big = [(os.path.relpath(p, t.scratch), n) for p, n in file_sizes(t, t.scratch).items()
           if p not in sizes_before and n >= BIG]
    t.check("no file of 1 MiB or more appeared in the test's folder during the agent tool calls (nothing was "
            "downloaded)", not big, big[:3] or "none")
    after = d.list_hosts()
    t.check("calling every agent tool with empty arguments allows nothing and keeps the outside entry outside",
            poked.get("called", 0) > 0 and sorted(after["approved"]) == sorted(before["approved"])
            and after["outside"] == [H(4)], f"{poked}; before {before}; after {after}")
    t.check("…and leaves the allowed list's files unchanged", sha(t, private) == files_before, private)
    texts = d.transcript()
    leaked = [x[:120] for x in texts if any(observe.holds_secret(x, s) for s in secrets)]
    t.check("no answer of the editor (results, errors, file surface) held 8 characters of the secret",
            len(texts) > 0 and secrets and not leaked, leaked[:2] or f"{len(texts)} answers checked")
