# Media fixtures for the parity batch

These assets exist in the test project. Refer to them only as `asset("<id>")` (both implementations accept that in the
test harness). Every video frame is visually distinct (a moving pattern plus a large frame counter), so a wrong source
frame is easy to measure.

| id | kind | size | fps | duration | frames | audio |
| --- | --- | --- | --- | --- | --- | --- |
| vid_a | video | 1920x1080 | 30 | 6.0 s | 180 | stereo 440 Hz tone, constant level |
| vid_b | video | 1280x720 | 25 | 4.0 s | 100 | none |
| vid_c | video | 640x360 | 60 | 3.0 s | 180 | none |
| img_a | image | 800x600 | - | - | - | - (opaque PNG) |
| img_b | image | 1920x1080 | - | - | - | - (JPEG) |
| img_c | image | 512x512 | - | - | - | - (PNG with transparent areas) |
| aud_a | audio | - | - | 8.0 s | - | stereo, a 100 ms 1 kHz beep at every whole second, silence between |
| aud_b | audio | - | - | 2.5 s | - | mono 220 Hz tone, constant level |
