"""No graphics add-on: with the add-on chosen as the renderer and none installed, the editor says graphics cannot
render, and add_graphic is refused and leaves nothing behind. Port of section G6 of
packages/core/scripts/smoke-graphicimports.ts, section M8 of smoke-chromeguard.ts and section 8 of smoke-unc-e2e.ts
(the same case in each; judge/PORTING.md).

The editor starts with no add-on (t.driver() without graphics_addon: what a user who never installed it has), and the
user's choice is made in the window (set_graphics_renderer). "Leaves nothing behind" is observed in the State (no
graphic, asset or clip added) and on disk: no file or folder appears anywhere in the test's folder, which holds the
editor's whole sandbox (PROTOCOL.md rule 1), during the refused calls (from a point where the editor has added none for
a few seconds: v0.2.0 checks its built-in renderer in the background at start, and writes there). The choice of the
built-in renderer is the control: the refusal is about the missing add-on. Every check is recorded on every path, so
CHECKS is exact.
"""
import time

from driver import refused

PORT_BOUND = True
TIMEOUT = 600
CHECKS = 6


def snapshot(d):
    st = d.get_state()
    clips = [c for tr in st.get("tracks", []) for c in tr.get("clips", [])]
    return (sorted(a.get("id") or "" for a in st.get("assets", [])), sorted(c.get("id") or "" for c in clips),
            sorted(g for c in clips for g in c.get("graphics") or []))


def settled(t, limit=90):
    """Every entry under the test's folder (t.look) once the editor has stopped adding or removing any for 5 s (work it
    started on its own, such as a check of its built-in renderer at start, has finished), or after `limit` s."""
    deadline = time.time() + limit
    walk = t.look(walk=[t.scratch])["walk"]
    while time.time() < deadline:
        time.sleep(5)
        again = t.look(walk=[t.scratch])["walk"]
        if sorted(again) == sorted(walk):
            return again
        walk = again
    return walk


def run(t):
    d = t.driver()  # no graphics add-on, whatever the judge was given
    d.set_project(width=160, height=90, fps=30)
    clip = d.place_clip(d.import_media(t.media("a.mp4")), "v0", 0, 0, 30)

    ok, what = refused(lambda: d.set_graphics_renderer("addon"))
    g = d.get_state().get("graphics")
    t.check("with the add-on chosen in the window and none installed, the State says graphics cannot render",
            not ok and g == {"renderer": "addon", "ready": False}, f"{what}; State graphics {g}")

    files_before = settled(t)
    before = snapshot(d)
    tried = [("the title template, as a clip", lambda: d.add_graphic(template="title", props={"title": "x"},
                                                                     duration_s=1)),
             ("the title template, over a clip", lambda: d.add_graphic(template="title", clip=clip)),
             ("code, as a clip", lambda: d.add_graphic(
                 code='import { AbsoluteFill } from "remotion";\nexport default () => <AbsoluteFill />;',
                 duration_s=1))]
    results = [(label, *refused(fn)) for label, fn in tried]
    t.check("add_graphic is refused (a template and code, as a clip and over a clip)",
            all(r for _, r, _ in results), [(lb, w[:160]) for lb, _, w in results])
    after, files_after = snapshot(d), t.look(walk=[t.scratch])["walk"]
    t.check("…and adds no graphic, asset or clip", after == before, f"{before} -> {after}")
    new = sorted(p for p in files_after if p not in files_before)
    t.check("…and no file or folder appears in the test's folder (the editor's sandbox is in it)", not new,
            new[:5] or f"none of {len(files_after)} entries is new")

    ok, what = refused(lambda: d.set_graphics_renderer("builtin"))
    g = d.get_state().get("graphics")
    t.check("control: choosing the built-in renderer again, graphics are ready (the refusal was about the add-on)",
            not ok and g == {"renderer": "builtin", "ready": True}, f"{what}; State graphics {g}")
    t.check("the clip the test placed is still there, with no graphic", any(
        c.get("id") == clip and not c.get("graphics") for c in d.clips("v0")), d.clips("v0"))
