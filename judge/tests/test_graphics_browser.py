"""The graphics add-on's browser and media downloads: a motion graphic's page reaches no other computer and no address
of this one but its own, keeps the browser's same-origin policy and reads no file, the render is muted, and no media a
graphic names is downloaded or opened. Port of packages/core/scripts/smoke-chromeguard.ts (judge/PORTING.md has the
map of its sections).

Observed from outside, never through the add-on's internals: listeners the test runs (one on 127.0.0.2, an address of
this computer that a graphic's page must not reach; two on 127.0.0.1, which it may reach: one for the detail only, and
one that answers a token with no cross-origin permission, so the page must not be able to read it), a file holding
another token that the page must not read either, the frame a graphic draws (its code picks the colour it draws once
its requests have settled, which shows that it ran and what it could read), the rendered graphic's streams (ffprobe
of its asset, which the State names), the refusals, and the file-system calls of the editor and of everything it
started (strace, t.driver(trace=True); never argv). Hosts are under the reserved .invalid domain; the
runner's own "nothing was downloaded" check fails on any DNS lookup or connection to another computer.

Everything here is about the graphics add-on: without one given to the judge (run.py --graphics-addon) every check is
recorded as not applicable (run.py --strict fails them). Every check is recorded on every path, so CHECKS is exact.
"""
import os
import secrets as rnd

import driver as drv
from driver import refused
import observe

PORT_BOUND = True
TIMEOUT = 1500
GREEN, RED = (0, 255, 0), (255, 0, 0)
M5_HOST, AUDIO_HOST = "zr-evil-m5.invalid", "zr-evil-m2.invalid"
SAME_AS = {"asset": "zr-evil-b.invalid", "offthread": "zr-evil-a.invalid", "proxy": "zr-evil-c.invalid"}
HOSTS = [M5_HOST, AUDIO_HOST] + list(SAME_AS.values())


def same_as(host, name):
    """A Remotion "same-as" source that names a network share (on Windows, ..\\..\\host\\s is a UNC path), as JS text."""
    return "same-as\\\\..\\\\..\\\\" + host + "\\\\s\\\\" + name


PROBE = """import React, { useEffect, useState } from "react";
import { AbsoluteFill, continueRender, delayRender } from "remotion";
export default function Probe() {
  const [handle] = useState(() => delayRender("probe"));
  const [done, setDone] = useState(false);
  useEffect(() => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const get = (u) => Promise.race([fetch(u, { mode: "no-cors" }).then(() => {}, () => {}), wait(3000)]);
    try { new WebSocket("WS_OTHER"); } catch {}
    try { window.open("OPEN_OTHER"); } catch {}
    Promise.all([get("CONTROL"), get("FETCH_OTHER"), get("http://M5_HOST/x")])
      .then(() => wait(1500))
      .then(() => { setDone(true); continueRender(handle); });
  }, [handle]);
  return <AbsoluteFill style={{ background: done ? "#00ff00" : "#ff0000" }}><img src="IMG_OTHER" /></AbsoluteFill>;
}
"""

# The page tries to read, by fetch (CORS mode) and by XMLHttpRequest, the answer of a listener on 127.0.0.1 at another
# port (another origin than its own server's) that gives no cross-origin permission, and a file of this computer. Once
# both have settled it draws green, plus red when it read the listener's token and blue when it read the file's.
READ = """import React, { useEffect, useState } from "react";
import { AbsoluteFill, continueRender, delayRender } from "remotion";
export default function Read() {
  const [handle] = useState(() => delayRender("read"));
  const [colour, setColour] = useState("rgb(0,0,0)");
  useEffect(() => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const byFetch = (u) => fetch(u).then((r) => r.text()).then((x) => x, () => "");
    const byXhr = (u) => new Promise((ok) => {
      try {
        const x = new XMLHttpRequest();
        x.onload = () => ok(String(x.responseText || ""));
        x.onerror = x.onabort = x.ontimeout = () => ok("");
        x.open("GET", u);
        x.send();
      } catch { ok(""); }
    });
    const read = (u) => Promise.race([Promise.all([byFetch(u), byXhr(u)]).then((a) => a.join(" ")),
                                      wait(5000).then(() => "")]);
    Promise.all([read("OTHER_ORIGIN"), read("FILE_URL")])
      .then(([o, f]) => {
        setColour(`rgb(${o.includes("LISTENER_TOKEN") ? 255 : 0},255,${f.includes("FILE_TOKEN") ? 255 : 0})`);
        return wait(1000);
      })
      .then(() => continueRender(handle));
  }, [handle]);
  return <AbsoluteFill style={{ background: colour }} />;
}
"""

AUDIO = """import React from "react";
import { AbsoluteFill, Audio } from "remotion";
export default function Sound() {
  return <AbsoluteFill><Audio src="SRC" /></AbsoluteFill>;
}
"""
# An HLS playlist (#EXTM3U) whose one segment is on M5_HOST, as a data: URI.
PLAYLIST = "data:audio/x-mpegurl;base64,I0VYVE0zVQojRVhUSU5GOjEuMCwKLy96ci1ldmlsLW01LmludmFsaWQvcy9zZWcudHMK"

REPORTED = """import React, { useContext, useEffect } from "react";
import { AbsoluteFill, Internals, useCurrentFrame } from "remotion";
export default function SameAs() {
  const { registerRenderAsset } = useContext(Internals.RenderAssetManager);
  const frame = useCurrentFrame();
  useEffect(() => {
    registerRenderAsset({ type: "audio", src: "SRC", id: "zr-same-as", frame, volume: 1, mediaFrame: frame,
      playbackRate: 1, toneFrequency: 1, audioStartFrame: 0, audioStreamIndex: 0 } as never);
  }, [frame, registerRenderAsset]);
  return <AbsoluteFill style={{ background: "#112233" }} />;
}
"""

OFFTHREAD = """import React from "react";
import { AbsoluteFill, OffthreadVideo } from "remotion";
export default function Off() {
  return <AbsoluteFill><OffthreadVideo src={"SRC"} /></AbsoluteFill>;
}
"""

# The page asks its own server's media route (Remotion's /proxy, which <OffthreadVideo> uses) for a same-as source, by
# fetch and by a WebSocket handshake; red when it was served, green when it was refused.
PROXY = """import React, { useEffect, useState } from "react";
import { AbsoluteFill, continueRender, delayRender } from "remotion";
export default function Proxy() {
  const [handle] = useState(() => delayRender("proxy"));
  const [got, setGot] = useState("pending");
  useEffect(() => {
    const q = "/proxy?src=" + encodeURIComponent("SRC") + "&time=0&transparent=false&toneMapped=true";
    try { new WebSocket(location.origin.replace(/^http/, "ws") + q); } catch {}
    Promise.race([fetch(q).then((r) => (r.ok ? "served" : "refused"), () => "refused"),
                  new Promise((r) => setTimeout(() => r("refused"), 5000))])
      .then((g) => { setGot(g); return new Promise((r) => setTimeout(r, 1000)); })
      .then(() => continueRender(handle));
  }, [handle]);
  return <AbsoluteFill style={{ background: got === "served" ? "#ff0000" : got === "pending" ? "#0000ff" : "#00ff00" }} />;
}
"""

NAMES = [
    "the graphics add-on is chosen in the window and ready (the State says so)",
    "a graphic that requests 127.0.0.2 and a .invalid computer (fetch, an image, a WebSocket, window.open) renders",
    "…and its code ran past its requests: its frame shows the colour it draws after them",
    "…and its rendered file, which the State names (a 0.2 s video the editor wrote in the test's folder), has no "
    "audio stream (renders are muted)",
    "a graphic that reads a listener on 127.0.0.1 at another port (another origin) and a file of this computer renders",
    "…and its page could not read the listener's answer, which gives no cross-origin permission (its frame's colour)",
    "…and its page could not read the file (its frame's colour)",
    f"a graphic whose <Audio> plays a data: playlist (a segment on {M5_HOST}) is refused",
    f"a graphic whose <Audio> plays an http: URL on 127.0.0.2 or an https: URL on {AUDIO_HOST} is refused",
    f"a graphic that reports a same-as media source on {SAME_AS['asset']} to the renderer is refused",
    f"a graphic whose <OffthreadVideo> names a same-as source on {SAME_AS['offthread']} is refused",
    f"a graphic that asks the renderer's own media route for a same-as source on {SAME_AS['proxy']} is refused, or "
    "renders with that request refused",
    "the refused graphics added nothing to the project (no clip, asset or graphic)",
    "the 127.0.0.2 listener received nothing (the probe's requests and the http: <Audio> named it)",
    "no file-system call of the editor or of anything it started named a computer these graphics named",
    "no file-system call of the editor or of anything it started named the folder of the file the page tried to read",
    "control: the trace saw the editor write the probe graphic's rendered file",
]
CHECKS = len(NAMES)


def snapshot(d):
    st = d.get_state()
    clips = [c for tr in st.get("tracks", []) for c in tr.get("clips", [])]
    return (sorted(a.get("id") or "" for a in st.get("assets", [])), sorted(c.get("id") or "" for c in clips),
            sorted(g for c in clips for g in c.get("graphics") or []))


def frame_colour(t, d, clip_id, name):
    """The mean colour in the middle of clip `clip_id` (its first second), as the editor renders the frame."""
    st = d.get_state()
    fps = (st.get("canvas") or {}).get("fps") or 30
    c = next((c for tr in st.get("tracks", []) for c in tr.get("clips", []) if c.get("id") == clip_id), None)
    if c is None:
        return None, "the clip is not in the State"
    at = (c["start_frame"] + min(c.get("length_frames") or 1, fps) / 2) / fps
    try:
        return observe.mean_rgb(d.render_frame(at, t.path("frames", f"{name}.png"))), f"frame at {at:.2f} s"
    except (drv.JudgeError, observe.Unmeasurable) as e:
        return None, str(e)


def add(d, code, duration_s=0.2):
    """add_graphic as a clip of its own: (result or None, what the editor said)."""
    try:
        return d.add_graphic(code=code, duration_s=duration_s), ""
    except (drv.ProductError, drv.BadRequest) as e:
        return None, f"refused: {e.message[:200]}"


def rendered(d, code):
    """add() of a graphic that must render, tried twice: v0.2.0 picks a free port for the add-on's server and binds it
    later, and another process can take the port in between (the render then fails)."""
    r, said = add(d, code)
    if r is None:
        r, again = add(d, code)
        said = f"{said}; {again}" if r is None else f"first try {said}"
    return r, said


def run(t):
    if not t.graphics_addon:
        for name in NAMES:
            t.not_applicable(name, t.graphics_addon_why)
        return
    token = f"zr-page-{rnd.token_hex(8)}"
    other, control = observe.Canary("127.0.0.2"), observe.Canary("127.0.0.1")
    reader = observe.Canary("127.0.0.1", answer=f"{token}-listener\n".encode())
    try:
        _run(t, other, control, reader, token)
    finally:
        other.close()
        control.close()
        reader.close()


def _run(t, other, control, reader, token):
    d = t.driver(trace=True, graphics_addon=True)
    d.set_project(width=160, height=90, fps=30)
    ok, what = refused(lambda: d.set_graphics_renderer("addon"))
    g = d.get_state().get("graphics")
    t.check(NAMES[0], not ok and g == {"renderer": "addon", "ready": True}, f"{what}; State graphics {g}")

    # ---- M5: the probe
    code = (PROBE.replace("WS_OTHER", other.url("ws", "ws")).replace("OPEN_OTHER", other.url("open"))
            .replace("FETCH_OTHER", other.url("fetch")).replace("IMG_OTHER", other.url("img.png"))
            .replace("CONTROL", control.url("control")).replace("M5_HOST", M5_HOST))
    probe, said = rendered(d, code)
    t.check(NAMES[1], probe is not None, f"{probe or ''} {said}".strip())
    colour, how = frame_colour(t, d, probe["clip"], "probe") if probe else (None, "not rendered")
    t.check(NAMES[2], observe.colour_is(colour, GREEN), f"{colour} at {how} (want {GREEN}; red: it did not finish)")
    asset = next((a for a in d.get_state().get("assets", []) if probe and a.get("id") == probe.get("asset")), None)
    path = (asset or {}).get("path")
    # The file must be the editor's render of this graphic: a file the test wrote (its frames) is not one.
    bad = observe.render_problem(path, t.scratch, 0.2, 30, [t.path("frames")])
    if bad:
        t.check(NAMES[3], False, f"the probe graphic's rendered file: {bad} ({probe})")
    else:
        t.measure(NAMES[3], lambda: [s.get("codec_type") for s in observe.streams(path)],
                  lambda v: "video" in v and "audio" not in v, "a video stream and no audio stream")

    # ---- M1 (its outcome): the page keeps the browser's same-origin policy and reads no file
    secret = t.path(f"judge-page-{rnd.token_hex(4)}", "secret.txt")
    with open(secret, "w", encoding="utf-8") as f:
        f.write(f"{token}-file\n")
    os.chmod(secret, 0o644)  # the editor's user can read it: a failed read is the browser's, not the file system's
    code = (READ.replace("OTHER_ORIGIN", reader.url("read")).replace("FILE_URL", "file://" + secret)
            .replace("LISTENER_TOKEN", f"{token}-listener").replace("FILE_TOKEN", f"{token}-file"))
    page, said = rendered(d, code)
    t.check(NAMES[4], page is not None, f"{page or ''} {said}".strip())
    colour, how = frame_colour(t, d, page["clip"], "read") if page else (None, "not rendered")
    settled = colour is not None and colour[1] >= 128
    why = (f"{colour} at {how} (green: its reads settled; red: it read the listener's answer; blue: it read the file); "
           f"the listener got {reader.count()} request(s)")
    t.check(NAMES[5], settled and colour[0] < 128, why)
    t.check(NAMES[6], settled and colour[2] < 128, why)

    # ---- M2, M3, M6a: media a graphic names is never fetched or opened
    before = snapshot(d)
    r, said = add(d, AUDIO.replace("SRC", PLAYLIST))
    t.check(NAMES[7], r is None, r or said)
    rs = [add(d, AUDIO.replace("SRC", src)) for src in (other.url("a.m3u8"), f"https://{AUDIO_HOST}/v.mp4")]
    t.check(NAMES[8], all(r is None for r, _ in rs), [r or s for r, s in rs])
    r, said = add(d, REPORTED.replace("SRC", same_as(SAME_AS["asset"], "a.m3u8")))
    t.check(NAMES[9], r is None, r or said)
    r, said = add(d, OFFTHREAD.replace("SRC", same_as(SAME_AS["offthread"], "a.mp4")))
    t.check(NAMES[10], r is None, r or said)
    after = snapshot(d)
    r, said = add(d, PROXY.replace("SRC", same_as(SAME_AS["proxy"], "a.mp4")))
    colour, how = frame_colour(t, d, r["clip"], "proxy") if r else (None, said)
    t.check(NAMES[11], r is None or observe.colour_is(colour, GREEN),
            said if r is None else f"rendered; {colour} at {how} (green: the request was refused; red: served)")
    t.check(NAMES[12], after == before, f"{before} -> {after}")

    t.check(NAMES[13], other.count() == 0, f"127.0.0.2 saw {other.seen()[:3] or 'nothing'}; the 127.0.0.1 listener "
                                           f"(this computer's own address, which the page may reach) saw "
                                           f"{control.count()} request(s)")
    traced = NAMES[14:17]
    if not t.trace:
        for name in traced:
            t.not_observed(name, t.trace_why or "strace is not installed")
    elif t.trace.tampered:
        for name in traced:
            t.check(name, False, t.trace.tampered)
    else:
        hits = observe.trace_hits(t.trace, HOSTS)
        t.check(NAMES[14], not hits, hits[:3] or f"none of {len(observe.trace_lines(t.trace))} lines names {HOSTS}")
        folder = os.path.basename(os.path.dirname(secret))
        hits = observe.trace_hits(t.trace, [folder])
        t.check(NAMES[15], not hits, hits[:3] or f"none of {len(observe.trace_lines(t.trace))} lines names {folder}")
        if bad:
            t.check(NAMES[16], False, f"the probe graphic's rendered file: {bad}")
        else:
            seen = observe.trace_hits(t.trace, [os.path.basename(path)])
            t.check(NAMES[16], bool(seen), f"{os.path.basename(path)}: {len(seen)} line(s)")
