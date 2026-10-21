"""The judge's own instruments (observe.py) on media with known properties, with the FFmpeg this run uses. Starts no
editor. If a measurement is wrong here, every test that uses it is wrong, so this runs first and on every FFmpeg.

Known properties (judge/fixtures/make.sh): a.mp4 and b.mp4 are 6 s, 1280x720, 30 fps, 180 frames, with a 440 Hz
(a) or 660 Hz (b) tone at amplitude 1/8; m.mp3 is 20 s of 330 Hz with no picture; gap.m4a is a 440 Hz tone with
digital silence from 2.0 to 3.5 s, 5.5 s in all.
"""
import json

import observe

PORT_BOUND = False
TIMEOUT = 300


def run(t):
    a, b, m, gap = t.media("a.mp4"), t.media("b.mp4"), t.media("m.mp3"), t.media("gap.m4a")
    frames = observe.Frames(t.path("frames", "x"))

    t.measure("duration of a.mp4", lambda: observe.duration(a), lambda v: abs(v - 6.0) < 0.01, "6.0 s")
    t.measure("size of a.mp4", lambda: observe.size(a), lambda v: v == (1280, 720, 1.0), "1280x720, SAR 1")
    t.measure("frame rate of a.mp4", lambda: observe.fps(a), lambda v: abs(v - 30) < 1e-6, "30")
    t.measure("full decode of a.mp4", lambda: observe.decode(a),
              lambda v: v["clean"] and v["video_frames"] == 180, "clean, 180 frames")
    t.measure("audio stream duration of a.mp4", lambda: observe.stream_duration(observe.audio_stream(a)),
              lambda v: v is not None and abs(v - 6.0) < 0.05, "6.0 s")
    t.measure("mean volume of a.mp4", lambda: observe.mean_volume(a), lambda v: -23 < v < -19, "about -21 dB")
    t.measure("440 Hz band of a.mp4", lambda: observe.band_level(a, 440), lambda v: v > -30, "> -30 dB")
    t.measure("660 Hz band of a.mp4", lambda: observe.band_level(a, 660), lambda v: v < -60, "< -60 dB")
    t.measure("660 Hz band of b.mp4", lambda: observe.band_level(b, 660), lambda v: v > -30, "> -30 dB")
    t.measure("440 Hz band of b.mp4, 1-5 s", lambda: observe.band_level(b, 440, 1, 5), lambda v: v < -60, "< -60 dB")
    t.measure("SSIM of a frame with itself", lambda: observe.frame_ssim(frames, a, 2.0, a, 2.0),
              lambda v: v > 0.999, "> 0.999")
    t.measure("SSIM of a.mp4 against b.mp4", lambda: observe.frame_ssim(frames, a, 2.0, b, 2.0),
              lambda v: v < 0.8, "< 0.8")
    t.measure("SSIM of the centre region of a frame with itself",
              lambda: observe.frame_ssim(frames, a, 2.0, a, 2.0, region="centre"), lambda v: v > 0.999, "> 0.999")
    t.measure("signalstats of a frame of a.mp4", lambda: observe.signalstats(frames.get(a, 1.0)),
              lambda v: 10 < v["YAVG"] < 245 and v["SATAVG"] > 5, "YAVG inside 10..245, SATAVG > 5")
    t.measure("last frame of a.mp4", lambda: observe.last_frame_stats(a)[3], lambda v: v == 180, "180 frames seen")
    t.measure("duration of m.mp3", lambda: observe.duration(m), lambda v: abs(v - 20.0) < 0.1, "20.0 s")
    t.check("m.mp3 has no video stream", observe.video_stream(m) is None)
    t.measure("330 Hz band of m.mp3", lambda: observe.band_level(m, 330), lambda v: v > -30, "> -30 dB")
    t.measure("silences in gap.m4a", lambda: observe.silences(gap, -50, 0.5),
              lambda v: len(v) == 1 and abs(v[0][0] - 2.0) < 0.05 and abs(v[0][1] - 3.5) < 0.05, "one, 2.0-3.5 s")
    t.measure("tone in gap.m4a before the gap", lambda: observe.band_level(gap, 440, 0.5, 1.5),
              lambda v: v > -30, "> -30 dB")
    t.measure("nothing in gap.m4a inside the gap", lambda: observe.mean_volume(gap, "", 2.1, 3.4),
              lambda v: v is None or v < -80, "< -80 dB")
    t.measure("last 0.2 s of gap.m4a", lambda: observe.tail_level(gap, 0.2), lambda v: v > -30, "> -30 dB")
    t.measure("loudness of gap.m4a", lambda: observe.loudness(gap), lambda v: -30 < v < -15, "-30 to -15 LUFS")

    srt = t.path("side", "c.srt")
    with open(srt, "w", encoding="utf-8") as f:
        f.write("1\n00:00:00,500 --> 00:00:01,250\nHello there\n\n2\n00:00:02,000 --> 00:00:01,000\nBackwards\n\n"
                "3\n00:00:03,000 --> 00:00:04,000\nTwo\nlines\n")
    cues, problems = observe.parse_srt(srt)
    t.check("SRT: two valid cues, the backwards one flagged",
            [c[:2] for c in cues] == [(0.5, 1.25), (3.0, 4.0)] and len(problems) == 1 and "end" in problems[0],
            {"cues": cues, "problems": problems})

    otio = t.path("side", "t.otio")
    clip = (lambda n: {"OTIO_SCHEMA": "Clip.2", "name": n})
    doc = {"OTIO_SCHEMA": "Timeline.1", "tracks": {"OTIO_SCHEMA": "Stack.1", "children": [
        {"OTIO_SCHEMA": "Track.1", "children": [clip("one"), {"OTIO_SCHEMA": "Gap.1"}, clip("two")]}]}}
    with open(otio, "w", encoding="utf-8") as f:
        json.dump(doc, f)
    o = observe.parse_otio(otio)
    t.check("OTIO: a timeline with two clips", o["root_schema"] == "Timeline.1" and o["clips"] == ["one", "two"]
            and not o["problems"], o)
    with open(otio, "w", encoding="utf-8") as f:
        json.dump({"OTIO_SCHEMA": "Clip.2"}, f)
    t.check("OTIO: a file that is not a timeline is flagged", bool(observe.parse_otio(otio)["problems"]))
