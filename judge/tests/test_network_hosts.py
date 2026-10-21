"""Network computers end to end: the editor never opens a file on a computer the user has not allowed, an agent cannot
allow one or read the secret that stamps the allowed list, and the user's own allow / keep / revoke work. Port of
packages/core/scripts/smoke-unc-e2e.ts (judge/PORTING.md has the map of its sections).

The computers are under the reserved .invalid domain (zr-evil-N.invalid, never resolvable). On Linux a path such as
//zr-evil-1.invalid/s/a1.mp4 is also a local path that does not exist, so the only sign that the editor tried to open
it is the file-system call itself: the adapter and everything it starts run under `strace -f -e trace=%file`
(t.driver(trace=True)), and the test searches that trace for the computers' names (observe.trace_hits; argv is never
looked at). Without strace on the system the trace checks are recorded as passed with "not observed".

The hostile project is the editor's own saved project with its media paths replaced by network paths
(observe.substitute), so the test needs no knowledge of the file format. add_host_outside plays an attacker who edits
the editor's allowed list without its window (one plain entry, one with a forged stamp); approve_host and revoke_host
are the user's own actions. Every approval or revoke is followed by recheck_media.

Every check is recorded on every path, so CHECKS is exact.
"""
import os
import shutil
import time

import driver as drv
import observe

PORT_BOUND = True
TIMEOUT = 1500
CHECKS = 40


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


def refused(fn):
    """(refused?, what happened): refused = the editor answered with an error (product_error or bad_request)."""
    try:
        r = fn()
        return False, f"accepted: {str(r)[:160]}"
    except (drv.ProductError, drv.BadRequest) as e:
        return True, f"refused: {e.message[:160]}"


def sha(paths):
    return {p: (observe.sha256(p) if os.path.isfile(p) else None) for p in paths}


class Trace:
    """The adapter tree's file-system trace, or "not observed" when strace is missing."""

    def __init__(self, t):
        self.path = t.trace_path

    def mark(self):
        return len(observe.trace_lines(self.path)) if self.path else 0

    def hits(self, names, start=0):
        return observe.trace_hits(self.path, names, start) if self.path else []

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

    def check(self, t, name, ok_fn, detail_fn):
        if not self.path:
            t.check(name, True, "not observed: strace is not installed")
        else:
            t.check(name, ok_fn(), detail_fn())


def run(t):
    d = t.driver(trace=True)
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
    private_before = sha(private)

    crafted = t.path("projects", "crafted.aive")
    net = {n: SPELL[n](f"a{n}.mp4") for n in SPELL}
    lut_net = f"\\\\{H(1)}\\s\\look.cube"
    counts = observe.substitute(legit, crafted, [(files[n], net[n]) for n in SPELL] + [(lut, lut_net)])
    t.check("the saved project names each media file and the LUT, so the hostile copy holds network paths only",
            all(c > 0 for c in counts), f"replacements {counts}")

    # ---- 1. load: every asset on a computer waits for it, each computer is pending once
    notice = None
    try:
        notice = d.load_project(crafted).get("notice")
        loaded = True
    except drv.JudgeError as e:
        loaded, notice = False, str(e)
    t.check("the crafted project loads", loaded, str(notice)[:300])
    st = d.get_state()
    by_path = {a.get("path"): a for a in st.get("assets", [])}
    waits = {n: (by_path.get(net[n]) or {}).get("waiting_host") for n in SPELL}
    loc = by_path.get(local) or {}
    t.check("each network asset waits for its own computer; the local one waits for none",
            all(waits[n] == H(n) and (by_path.get(net[n]) or {}).get("offline") is True for n in SPELL)
            and loc.get("waiting_host") is None and loc.get("offline") is False, f"{waits}; local {loc}")
    h = d.list_hosts()
    t.check("each computer is pending once, nothing is allowed",
            all(h["pending"].count(H(n)) == 1 for n in SPELL) and not h["approved"], h)
    t.check(f"{H(3)} (plain entry) and {H(4)} (forged stamp), written outside the window, are listed outside",
            sorted(h["outside"]) == [H(3), H(4)], h)
    t.check("the load's notice names each computer", all(H(n) in str(notice or "").lower() for n in SPELL),
            str(notice)[:400])

    # ---- 2. what refuses and what works while the media waits
    ok_x, what_x = refused(lambda: d.export(t.path("out", "x.mp4")))
    ok_f, what_f = refused(lambda: d.render_frame(0.5, t.path("out", "f.png")))
    t.check("an export of the timeline is refused", ok_x and not os.path.exists(t.path("out", "x.mp4")), what_x)
    t.check("rendering a frame is refused", ok_f, what_f)
    ok_t, what_t = refused(lambda: d.thumbnail(assets[1], 0.5))
    ok_p, what_p = refused(lambda: d.make_proxy(assets[1]))
    t.check("a thumbnail and a proxy of a waiting asset are refused", ok_t and ok_p, f"{what_t}; {what_p}")
    answers = []
    for p in (net[1], lut_net):
        for route, q in (("/file", {}), ("/frames", FRAMES_Q), ("/peaks", {})):
            r = d.http_get(route, {"path": p, **q})
            answers.append((route, p, r["status"]))
    t.check("the file surface serves no file of a waiting computer (/file, /frames, /peaks; media and LUT)",
            all(not 200 <= s < 300 for _, _, s in answers), answers)
    r = d.http_get("/file", {"path": local})
    t.check("control: the file surface serves the local clip", r["status"] == 200, r["status"])

    resaved = t.path("projects", "resaved.aive")
    ok_save = not refused(lambda: d.save_project(resaved))[0]
    ok_load = ok_save and not refused(lambda: d.load_project(resaved))[0]
    a1 = next((a for a in d.get_state().get("assets", []) if a.get("path") == net[1]), {})
    t.check("the project saves to a local file and loads again with the media still waiting",
            ok_save and ok_load and a1.get("waiting_host") == H(1), f"save {ok_save}, load {ok_load}, {a1}")
    moved = refused(lambda: d.move_clip(d.clips("v0")[0]["id"], 300))
    undo_ok = not refused(d.undo)[0] and not refused(d.redo)[0]
    a1 = next((a for a in d.get_state().get("assets", []) if a.get("path") == net[1]), {})
    t.check("editing, undo and redo work while media waits, and it still waits",
            not moved[0] and undo_ok and a1.get("waiting_host") == H(1), f"move {moved[1]}; undo/redo {undo_ok}; {a1}")

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
    otio5 = t.path("projects", "h5.otio")
    pairs5 = []
    for p in [local] + list(files.values()):
        net5 = f"\\\\{H(5)}\\s\\{os.path.basename(p)}"
        pairs5 += [(f"file://{p}", net5), (p, net5)]
    c5 = observe.substitute(legit_otio, otio5, pairs5)
    n5 = [c5[i] + c5[i + 1] for i in range(0, len(c5), 2)]
    st5, what5 = None, ""
    try:
        d.import_otio(otio5)
        st5 = d.get_state()
    except drv.JudgeError as e:
        what5 = str(e)
    w5 = [(a.get("offline"), a.get("waiting_host")) for a in (st5 or {}).get("assets", [])]
    t.check(f"an OTIO file whose media is on {H(5)} imports, every asset offline and waiting for it",
            all(c > 0 for c in n5) and st5 is not None and len(w5) >= 5 and all(w == (True, H(5)) for w in w5),
            f"replacements {n5}; {w5 or what5}")

    # ---- 3. so far nothing opened a file on any test computer
    tr.check(t, "no file-system call of the editor named a test computer (before any approval)",
             lambda: not tr.hits(["-evil-"]), lambda: tr.hits(["-evil-"])[:3])
    tr.check(t, "control: the trace saw the editor's own file-system calls", lambda: tr.mark() > 100,
             lambda: f"{tr.mark()} lines")

    # ---- 4. the allowed list's files and secret are out of the agent's reach
    t.check("the editor names the files of its allowed list and a secret to look for",
            len(private) >= 1 and all(os.path.isfile(p) for p in private) and len(secrets) >= 1, private)
    dotted = [os.path.join(os.path.dirname(p), "..", os.path.basename(os.path.dirname(p)), os.path.basename(p))
              for p in private]
    key = private[-1] if private else "/nonexistent/key"
    link = t.path("links", "store-link.mp4")       # a link to the secret
    os.symlink(key, link)
    link_dir = t.path("links", "store-dir")        # a link to its folder: <link>/../<folder>/<file> is the secret to
    os.symlink(os.path.dirname(key), link_dir)     # the kernel, a path outside the folder to a lexical check
    after_link = os.path.join(link_dir, "..", os.path.basename(os.path.dirname(key)), os.path.basename(key))
    aliases = private + dotted + [link, after_link, f"/proc/self/root{key}"]
    saves = [(p, refused(lambda p=p: d.save_project(p, raw=True))) for p in private + dotted]
    t.check("saving the project over the allowed list's files is refused (also through '..')",
            all(ok for _, (ok, _) in saves), [(p, w) for p, (ok, w) in saves if not ok] or len(saves))
    clip0 = d.clips("v0")[0]["id"] if d.clips("v0") else "none"
    opens = []
    for p in aliases:
        for label, fn in (("open", lambda p=p: d.load_project(p, raw=True)),
                          ("OTIO", lambda p=p: d.import_otio(p, raw=True)),
                          ("import", lambda p=p: d.import_media(p, raw=True)),
                          ("LUT", lambda p=p: d.apply_lut(clip0, p, raw=True)),
                          ("font", lambda p=p: d.add_text(clip0, "t", font=p))):
            opens.append((label, p, *refused(fn)))
    t.check("opening the allowed list's files as a project, OTIO, media, LUT or font is refused (direct, '..', a "
            "link, '..' after a link, /proc/self/root)", all(ok for _, _, ok, _ in opens),
            [(lb, p, w) for lb, p, ok, w in opens if not ok] or len(opens))
    served = []
    for p in aliases:
        for route, q in (("/file", {}), ("/frames", FRAMES_Q), ("/peaks", {})):
            served.append((route, p, d.http_get(route, {"path": p, **q})["status"]))
    t.check("the file surface serves none of them", all(not 200 <= s < 300 for _, _, s in served),
            [x for x in served if 200 <= x[2] < 300] or len(served))
    t.check("the allowed list's files are unchanged", sha(private) == private_before, private)
    fontkey = t.path("projects", "font-key.aive")
    nk = observe.substitute(legit, fontkey, [(font, key)])[0]
    ok, what = refused(lambda: d.load_project(fontkey))
    t.check("a project whose text font is the allowed list's secret file does not open", nk > 0 and ok,
            f"{nk} substitution(s); {what}")

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
    waits = {n: (by_path.get(net[n]) or {}).get("waiting_host") for n in SPELL}
    t.check(f"after the user allows {H(1)} and a re-check, its asset no longer waits; the others still do",
            waits == {1: None, 2: H(2), 3: H(3), 4: H(4)}, waits)
    a1_id = (by_path.get(net[1]) or {}).get("id", "")
    refused(lambda: d.thumbnail(a1_id, 0.5))  # makes the editor open \\zr-evil-1's file (it is not there)
    tr.check(t, f"control: the trace now has the editor opening {H(1)}'s files", lambda: bool(tr.hits([H(1)], mark)),
             lambda: f"{len(tr.hits([H(1)], mark))} lines")
    others = [H(n) for n in (2, 3, 4, 5, 6, 7, 8, 9)]
    tr.check(t, "…and still none for any other test computer", lambda: not tr.hits(others),
             lambda: tr.hits(others)[:3])

    d.approve_host(H(3))  # Keep: the plain entry written outside the window
    d.recheck_media()
    st = d.get_state()
    by_path = {a.get("path"): a for a in st.get("assets", [])}
    h = d.list_hosts()
    t.check(f"keeping {H(3)} in the window brings its asset online; {H(4)} (forged) still waits and stays outside",
            (by_path.get(net[3]) or {}).get("waiting_host") is None
            and (by_path.get(net[4]) or {}).get("waiting_host") == H(4) and h["outside"] == [H(4)]
            and H(4) not in h["approved"], f"{h}")

    w5 = []
    if not refused(lambda: d.import_otio(otio5))[0]:
        d.approve_host(H(5))
        d.recheck_media()
        w5 = [a.get("waiting_host") for a in d.get_state().get("assets", [])]
    t.check(f"the OTIO's placeholders stop waiting once {H(5)} is allowed", len(w5) >= 5 and not any(w5), w5)

    look = []
    lmark = tr.mark()
    for i, p in enumerate(LOOKALIKES):
        crafted_l = t.path("projects", f"lookalike-{i}.aive")
        n = observe.substitute(legit, crafted_l, [(files[1], p)])[0]
        ok, what = refused(lambda: d.load_project(crafted_l))
        a = next((x for x in d.get_state().get("assets", []) if x.get("path") == p), None) if not ok else None
        safe = n > 0 and (ok or (a is not None and a.get("offline") is True))
        look.append((repr(p), safe, what if ok else a))
    t.check(f"a look-alike of the allowed {H(1)} (fullwidth, zero-width space) is refused or stays offline",
            all(s for _, s, _ in look), look)
    tr.check(t, "…and the editor never opened a look-alike path", lambda: not tr.hits(LOOKALIKE_HOSTS, lmark),
             lambda: tr.hits(LOOKALIKE_HOSTS, lmark)[:3])

    # ---- 6. revoke: the media waits again and nothing opens it
    refused(lambda: d.load_project(crafted))
    tr.settle(d)
    d.revoke_host(H(1))
    d.recheck_media()
    st = d.get_state()
    a1 = next((a for a in st.get("assets", []) if a.get("path") == net[1]), {})
    t.check(f"after the user revokes {H(1)} and a re-check, its asset waits again", a1.get("waiting_host") == H(1), a1)
    mark = tr.mark()
    again = [refused(lambda: d.export(t.path("out", "x2.mp4"))),
             refused(lambda: d.render_frame(0.5, t.path("out", "f2.png"))),
             refused(lambda: d.thumbnail(a1.get("id", ""), 0.5)), refused(lambda: d.make_proxy(a1.get("id", "")))]
    t.check("export, frame, thumbnail and proxy are refused again", all(ok for ok, _ in again), [w for _, w in again])
    served = [(route, d.http_get(route, {"path": net[1], **q})["status"])
              for route, q in (("/file", {}), ("/frames", FRAMES_Q), ("/peaks", {}))]
    t.check("the file surface refuses the revoked computer's file again", all(not 200 <= s < 300 for _, s in served),
            served)
    tr.check(t, f"after the revoke nothing opened {H(1)}'s files", lambda: not tr.hits([H(1)], mark),
             lambda: tr.hits([H(1)], mark)[:3])
    tr.check(t, f"the computers never allowed ({H(4)} with its forged stamp, {H(7)}) were never opened",
             lambda: not tr.hits([H(4), H(7)]), lambda: tr.hits([H(4), H(7)])[:3])

    # ---- 4 (end). every agent tool with empty arguments allows nothing, and no answer held the secret
    before, files_before = d.list_hosts(), sha(private)
    poked = d.poke_agent_tools()
    after = d.list_hosts()
    t.check("calling every agent tool with empty arguments allows nothing and keeps the outside entry outside",
            poked.get("called", 0) > 0 and sorted(after["approved"]) == sorted(before["approved"])
            and after["outside"] == [H(4)], f"{poked}; before {before}; after {after}")
    t.check("…and leaves the allowed list's files unchanged", sha(private) == files_before, private)
    texts = d.transcript()
    leaked = [x[:120] for x in texts if any(observe.holds_secret(x, s) for s in secrets)]
    t.check("no answer of the editor (results, errors, file surface) held 8 characters of the secret",
            len(texts) > 0 and secrets and not leaked, leaked[:2] or f"{len(texts)} answers checked")
