#!/usr/bin/env bash
# The judge's media, made from FFmpeg's lavfi sources (test patterns and tones, nobody's footage). Nothing is
# downloaded. The four clips use the recipes of the repository's CI media (scripts/ci/make-media.sh):
#   a.mp4     testsrc2 1280x720 30 fps 6 s + sine 440 Hz   H.264 High yuv420p + AAC-LC mono 44.1 kHz
#   b.mp4     testsrc  1280x720 30 fps 6 s + sine 660 Hz   same codecs
#   c640.mp4  testsrc2  640x480 30 fps 5 s + sine 440 Hz   same codecs
#   m.mp3     sine 330 Hz 20 s                              MP3 mono 44.1 kHz 64 kb/s
# one for the measurement self-check:
#   gap.m4a   440 Hz tone, digital silence from 2.0 to 3.5 s, 5.5 s in all   AAC-LC mono 44.1 kHz
# and a very small video that a test puts in a data: URI (a few kB):
#   tiny.mp4  testsrc 32x32 10 fps 1 s, no audio                             H.264 yuv420p
# The tones are at amplitude 1/8 (peak about -18 dBFS). The frame rate is the source's (rate=30), never -r.
# Usage: make.sh <outdir>   env: FFMPEG / FFPROBE (default: the ffmpeg / ffprobe on PATH)
# Then checks each file with ffprobe (codecs, size, rate, frame count, channels) and prints what it made.
set -euo pipefail
OUT="${1:?usage: make.sh <outdir>}"; FF="${FFMPEG:-ffmpeg}"; FP="${FFPROBE:-ffprobe}"
mkdir -p "$OUT"
"$FF" -version | sed -n 1p

# clip <file> <video source> <size> <seconds> <tone Hz>
clip() {
  "$FF" -nostdin -hide_banner -loglevel error -y \
    -f lavfi -i "$2=size=$3:rate=30:duration=$4" \
    -f lavfi -i "sine=frequency=$5:sample_rate=44100:duration=$4" \
    -map 0:v -map 1:a -c:v libx264 -preset medium -crf 23 -profile:v high -pix_fmt yuv420p \
    -c:a aac -ac 1 -ar 44100 "$OUT/$1"
}
clip a.mp4 testsrc2 1280x720 6 440
clip b.mp4 testsrc 1280x720 6 660
clip c640.mp4 testsrc2 640x480 5 440
"$FF" -nostdin -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=330:sample_rate=44100:duration=20" \
  -c:a libmp3lame -b:a 64k -ac 1 -ar 44100 "$OUT/m.mp3"
"$FF" -nostdin -hide_banner -loglevel error -y \
  -f lavfi -i "aevalsrc=exprs='if(between(t\,2\,3.5)\,0\,0.125*sin(2*PI*440*t))':sample_rate=44100:duration=5.5" \
  -c:a aac -ac 1 -ar 44100 "$OUT/gap.m4a"

"$FF" -nostdin -hide_banner -loglevel error -y -f lavfi -i "testsrc=size=32x32:rate=10:duration=1" \
  -c:v libx264 -preset medium -crf 30 -pix_fmt yuv420p -movflags +faststart "$OUT/tiny.mp4"

# probe <file> <stream> <entries>: the stream's values, comma-separated, in ffprobe's order.
probe() { "$FP" -v error -select_streams "$2" -show_entries "stream=$3" -of csv=p=0 "$OUT/$1"; }
# expect <file> <stream> <entries> <values>
expect() {
  local got
  got="$(probe "$1" "$2" "$3")"
  [ "$got" = "$4" ] || { echo "make.sh: $1 $2 is '$got', expected '$4' ($3)" >&2; exit 1; }
}
for f in a.mp4:1280:720:180 b.mp4:1280:720:180 c640.mp4:640:480:150; do
  IFS=: read -r n w h frames <<< "$f"
  expect "$n" v:0 codec_name,profile,width,height,pix_fmt,r_frame_rate,nb_frames "h264,High,$w,$h,yuv420p,30/1,$frames"
  expect "$n" a:0 codec_name,profile,sample_rate,channels aac,LC,44100,1
done
expect m.mp3 a:0 codec_name,sample_rate,channels,bit_rate mp3,44100,1,64000
expect gap.m4a a:0 codec_name,profile,sample_rate,channels aac,LC,44100,1
expect tiny.mp4 v:0 codec_name,width,height,pix_fmt,r_frame_rate,nb_frames h264,32,32,yuv420p,10/1,10
for f in a.mp4 b.mp4 c640.mp4 m.mp3 gap.m4a tiny.mp4; do
  printf '%-9s %s s, %s bytes\n' "$f" "$("$FP" -v error -show_entries format=duration -of csv=p=0 "$OUT/$f")" "$(stat -c %s "$OUT/$f")"
done
