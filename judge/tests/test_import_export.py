"""Import, place, trim and export one clip; the export is what was asked for. The file surface serves the project's
media and refuses a file outside it.

Media: a.mp4 (1280x720, 30 fps, 6 s, a moving test pattern, a 440 Hz tone). The clip is placed whole (frames 0-180)
and then trimmed to source frames 30-120 (1.0 s to 4.0 s), so the export must be that 3 s range: 3 s long, 1280x720,
30 fps, the 440 Hz tone heard for the whole 3 s, and its first half second showing the source from 1.0 s on, not
from 0 s.

File surface: a GET for the imported clip returns exactly its bytes (the control), and a GET for a file that the
project never used is refused without its contents, named directly or through ".." from the media folder.
"""
import os
import secrets

import observe

PORT_BOUND = True
TIMEOUT = 600

FPS = 30
IN, OUT = 30, 120          # source frames kept by the trim: 1.0 s to 4.0 s
SECONDS = (OUT - IN) / FPS  # 3.0


def run(t):
    a = t.media("a.mp4")
    d = t.driver()

    asset = d.import_media(a)
    t.check("import returns an asset id", isinstance(asset, str) and asset, asset)
    clip = d.place_clip(asset, track="v0", start_frame=0, in_frame=0, out_frame=180)
    placed = [c for c in d.clips("v0") if c.get("id") == clip]
    t.check("the placed clip is on v0 at frame 0, 180 frames long",
            len(placed) == 1 and placed[0].get("start_frame") == 0 and placed[0].get("length_frames") == 180,
            placed)

    d.trim_clip(clip, in_frame=IN, out_frame=OUT)
    d.set_project(width=1280, height=720, fps=FPS)
    st = d.get_state()
    t.check("the canvas is 1280x720 at 30 fps after set_project",
            (st.get("canvas") or {}).get("width") == 1280 and st["canvas"].get("height") == 720
            and abs(float(st["canvas"].get("fps") or 0) - FPS) < 1e-6, st.get("canvas"))
    v0 = next((tr["clips"] for tr in st.get("tracks", []) if tr.get("track") == "v0"), [])
    t.check("after the trim, v0 holds one clip: source 30-120 at frame 0, 90 frames long",
            len(v0) == 1 and (v0[0].get("in_frame"), v0[0].get("out_frame"), v0[0].get("start_frame"),
                              v0[0].get("length_frames")) == (IN, OUT, 0, OUT - IN), v0)

    out = t.path("out", "trimmed.mp4")
    job = d.export(out)
    t.check("the export finishes", job.get("status") == "done" and os.path.isfile(out), job)
    if not os.path.isfile(out):
        return

    dec = t.measure("the export decodes to the end with no errors", lambda: observe.decode(out),
                    lambda v: v["clean"], "exit 0, nothing printed, video frames")
    if dec:
        t.check(f"the export has {OUT - IN} video frames (+-1)", abs(dec["video_frames"] - (OUT - IN)) <= 1,
                dec["video_frames"])
    t.measure(f"the export lasts {SECONDS:g} s (+-0.1)", lambda: observe.duration(out),
              lambda v: abs(v - SECONDS) <= 0.1, f"{SECONDS:g} +- 0.1 s")
    t.measure("the export is 1280x720 with square pixels", lambda: observe.size(out),
              lambda v: (v[0], v[1]) == (1280, 720) and abs(v[2] - 1.0) < 1e-6, "1280x720, SAR 1")
    t.measure("the export runs at 30 fps", lambda: observe.fps(out), lambda v: abs(v - FPS) < 0.01, "30")
    t.measure("the export has an audio stream", lambda: observe.audio_stream(out) is not None, bool, "present")
    if observe.audio_stream(out) is None:
        return
    t.measure(f"its audio lasts {SECONDS:g} s (+-0.1)", lambda: observe.stream_duration(observe.audio_stream(out)),
              lambda v: v is not None and abs(v - SECONDS) <= 0.1, f"{SECONDS:g} +- 0.1 s")
    t.measure("its audio is not silent", lambda: observe.mean_volume(out),
              lambda v: v is not None and v > -45, "mean volume > -45 dB")
    t.measure("the 440 Hz tone is heard in the first second", lambda: observe.band_level(out, 440, 0, 1),
              lambda v: v is not None and v > -40, "> -40 dB in the 440 Hz band")
    t.measure("the 440 Hz tone is heard in the last second", lambda: observe.band_level(out, 440, SECONDS - 1, SECONDS),
              lambda v: v is not None and v > -40, "> -40 dB in the 440 Hz band")

    # The picture: the export's frame at 0.5 s is the source's frame at 1.5 s (within one source frame), not the
    # frame at 0.5 s where an export that ignored the in-point would be.
    frames = observe.Frames(t.path("frames", "x"))
    want_t = IN / FPS + 0.5
    near = t.measure("the frame at 0.5 s shows the source at 1.5 s (best of +-1 frame)",
                     lambda: max(observe.frame_ssim(frames, out, 0.5, a, want_t + k / FPS) for k in (-1, 0, 1)),
                     lambda v: v >= 0.97, "SSIM >= 0.97")
    early = t.measure("the frame at 0.5 s does not show the source at 0.5 s",
                      lambda: observe.frame_ssim(frames, out, 0.5, a, 0.5), lambda v: v < 0.97, "SSIM < 0.97")
    if near is not None and early is not None:
        t.check("the frame at 0.5 s is closer to the source at 1.5 s than at 0.5 s", near > early,
                f"{near:.4f} vs {early:.4f}")

    # The file surface. Control: the project's own media is served, byte for byte.
    r = d.http_get("/file", {"path": a})
    t.check("the file surface serves the imported clip (status 200, same bytes)",
            r["status"] == 200 and r["body_length"] == os.path.getsize(a) and r["body_sha256"] == observe.sha256(a),
            {k: r[k] for k in ("status", "body_length", "content_type")})

    # A file the project never used, with a random marker inside: refused, and nothing of it in the answer.
    marker = "judge-private-" + secrets.token_hex(16)
    private = t.path("private", "notes.txt")
    with open(private, "w", encoding="utf-8") as f:
        f.write(f"{marker}\n")
    media_dir = os.path.dirname(a)
    rel = os.path.relpath(private, media_dir)
    for label, p in (("named directly", private), ("through '..' from the media folder", os.path.join(media_dir, rel))):
        r = d.http_get("/file", {"path": p})
        leaked = marker.encode() in r["body"]
        t.check(f"a file outside the project is refused ({label})", not 200 <= r["status"] < 300 and not leaked,
                f"status {r['status']}, {r['body_length']} bytes, marker {'IN' if leaked else 'not in'} the body")
