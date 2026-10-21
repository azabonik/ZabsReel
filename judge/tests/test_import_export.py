"""Import, place, trim and export one clip; the export is what was asked for. The file surface serves the project's
media and refuses a file outside it.

Media: a.mp4 (1280x720, 30 fps, 6 s, a moving test pattern, a 440 Hz tone). The canvas is set to 640x360 at 30 fps
before anything is placed: the same aspect and frame rate as the source but a different size, so an export that
copies the source's size instead of the canvas fails. The clip is placed whole (frames 0-180) and then trimmed to
source frames 30-120 (1.0 s to 4.0 s), so the export must be that 3 s range: 3 s long, 640x360, 30 fps, the 440 Hz
tone heard for the whole 3 s, and its first half second showing the source from 1.0 s on, not from 0 s (the source
frame is scaled to the export's size for the comparison).

File surface: a GET for the imported clip returns exactly its bytes (the control), and a GET for a file that the
project never used is refused without its contents, named directly or through ".." from the media folder.

Every check is recorded on every path (a check whose input is missing fails with the reason), so CHECKS is exact.
"""
import os
import secrets

import observe

PORT_BOUND = True
TIMEOUT = 600
CHECKS = 21

FPS = 30
W, H = 640, 360            # the canvas: the source's 16:9 aspect and frame rate, not its 1280x720 size
IN, OUT = 30, 120          # source frames kept by the trim: 1.0 s to 4.0 s
SECONDS = (OUT - IN) / FPS  # 3.0

EXPORT_CHECKS = [
    "the export decodes to the end with no errors",
    f"the export has {OUT - IN} video frames (+-1)",
    f"the export lasts {SECONDS:g} s (+-0.1)",
    f"the export is {W}x{H} (the canvas) with square pixels",
    "the export runs at 30 fps",
    "the export has an audio stream",
    f"its audio lasts {SECONDS:g} s (+-0.1)",
    "its audio is not silent",
    "the 440 Hz tone is heard in the first second",
    "the 440 Hz tone is heard in the last second",
    "the frame at 0.5 s shows the source at 1.5 s (best of +-1 frame)",
    "the frame at 0.5 s does not show the source at 0.5 s",
    "the frame at 0.5 s is closer to the source at 1.5 s than at 0.5 s",
]
AUDIO_CHECKS = EXPORT_CHECKS[6:10]


def run(t):
    a = t.media("a.mp4")
    d = t.driver()

    d.set_project(width=W, height=H, fps=FPS)
    asset = d.import_media(a)
    t.check("import returns an asset id", isinstance(asset, str) and asset, asset)
    clip = d.place_clip(asset, track="v0", start_frame=0, in_frame=0, out_frame=180)
    placed = [c for c in d.clips("v0") if c.get("id") == clip]
    t.check("the placed clip is on v0 at frame 0, 180 frames long",
            len(placed) == 1 and placed[0].get("start_frame") == 0 and placed[0].get("length_frames") == 180,
            placed)

    d.trim_clip(clip, in_frame=IN, out_frame=OUT)
    st = d.get_state()
    canvas = st.get("canvas") or {}
    t.check(f"the canvas is still {W}x{H} at 30 fps after placing a 1280x720 clip",
            canvas.get("width") == W and canvas.get("height") == H and abs(float(canvas.get("fps") or 0) - FPS) < 1e-6,
            canvas)
    v0 = next((tr["clips"] for tr in st.get("tracks", []) if tr.get("track") == "v0"), [])
    t.check("after the trim, v0 holds one clip: source 30-120 at frame 0, 90 frames long",
            len(v0) == 1 and (v0[0].get("in_frame"), v0[0].get("out_frame"), v0[0].get("start_frame"),
                              v0[0].get("length_frames")) == (IN, OUT, 0, OUT - IN), v0)

    out = t.path("out", "trimmed.mp4")
    job = d.export(out)
    t.check("the export finishes (status done, the file is there)",
            job.get("status") == "done" and os.path.isfile(out), job)
    if os.path.isfile(out):
        measure_export(t, a, out)
    else:
        for name in EXPORT_CHECKS:
            t.check(name, False, "no export file")

    file_surface(t, d, a)


def measure_export(t, a, out):
    dec = t.measure(EXPORT_CHECKS[0], lambda: observe.decode(out), lambda v: v["clean"],
                    "exit 0, nothing printed, video frames")
    t.check(EXPORT_CHECKS[1], dec is not None and abs(dec["video_frames"] - (OUT - IN)) <= 1,
            dec["video_frames"] if dec else "no decode")
    t.measure(EXPORT_CHECKS[2], lambda: observe.duration(out), lambda v: abs(v - SECONDS) <= 0.1,
              f"{SECONDS:g} +- 0.1 s")
    t.measure(EXPORT_CHECKS[3], lambda: observe.size(out),
              lambda v: (v[0], v[1]) == (W, H) and abs(v[2] - 1.0) < 1e-6, f"{W}x{H}, SAR 1")
    t.measure(EXPORT_CHECKS[4], lambda: observe.fps(out), lambda v: abs(v - FPS) < 0.01, "30")
    has_audio = t.measure(EXPORT_CHECKS[5], lambda: observe.audio_stream(out) is not None, bool, "present")
    if has_audio:
        t.measure(AUDIO_CHECKS[0], lambda: observe.stream_duration(observe.audio_stream(out)),
                  lambda v: v is not None and abs(v - SECONDS) <= 0.1, f"{SECONDS:g} +- 0.1 s")
        t.measure(AUDIO_CHECKS[1], lambda: observe.mean_volume(out), lambda v: v is not None and v > -45,
                  "mean volume > -45 dB")
        t.measure(AUDIO_CHECKS[2], lambda: observe.band_level(out, 440, 0, 1), lambda v: v is not None and v > -40,
                  "> -40 dB in the 440 Hz band")
        t.measure(AUDIO_CHECKS[3], lambda: observe.band_level(out, 440, SECONDS - 1, SECONDS),
                  lambda v: v is not None and v > -40, "> -40 dB in the 440 Hz band")
    else:
        for name in AUDIO_CHECKS:
            t.check(name, False, "no audio stream")

    # The picture: the export's frame at 0.5 s is the source's frame at 1.5 s (within one source frame), not the
    # frame at 0.5 s where an export that ignored the in-point would be. The source frame is scaled to the export's
    # size (the canvas), so the comparison is at the size the export was asked for.
    frames = observe.Frames(t.path("frames", "x"))
    want_t = IN / FPS + 0.5
    near = t.measure(EXPORT_CHECKS[10],
                     lambda: max(observe.frame_ssim(frames, a, want_t + k / FPS, out, 0.5) for k in (-1, 0, 1)),
                     lambda v: v >= 0.97, "SSIM >= 0.97")
    early = t.measure(EXPORT_CHECKS[11], lambda: observe.frame_ssim(frames, a, 0.5, out, 0.5),
                      lambda v: v < 0.97, "SSIM < 0.97")
    t.check(EXPORT_CHECKS[12], near is not None and early is not None and near > early,
            f"{near:.4f} vs {early:.4f}" if near is not None and early is not None else "a frame was unmeasurable")


def file_surface(t, d, a):
    # Control: the project's own media is served, byte for byte.
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
