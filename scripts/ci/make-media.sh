#!/usr/bin/env bash
# The matrix's four test clips, made from FFmpeg's lavfi sources (test patterns and tones, nobody's footage), to the
# specs of the local matrix kit's media folder (whose copies FFmpeg 4.4, Lavf58.76.100, made):
#   a.mp4     testsrc2 1280x720 30 fps 6 s + sine 440 Hz   H.264 High yuv420p + AAC-LC mono 44.1 kHz
#   b.mp4     testsrc  1280x720 30 fps 6 s + sine 660 Hz   same codecs
#   c640.mp4  testsrc2  640x480 30 fps 5 s + sine 440 Hz   same codecs
#   m.mp3     sine 330 Hz 20 s                              MP3 mono 44.1 kHz 64 kb/s
# The tones are at the sine source's default amplitude (1/8: peak about -18 dBFS). x264 runs at its defaults (preset
# medium, CRF 23) and AAC at the encoder's default rate, as for the kit's clips. The frame rate is the source's
# (rate=30), never -r: from FFmpeg 5 on, -r converts from the filter link's rate.
# Usage: make-media.sh <outdir>   env: FFMPEG / FFPROBE (default: the ffmpeg / ffprobe on PATH)
# Then checks each file with ffprobe (codecs, size, rate, frame count, channels) and prints what it made.
set -euo pipefail
OUT="${1:?usage: make-media.sh <outdir>}"; FF="${FFMPEG:-ffmpeg}"; FP="${FFPROBE:-ffprobe}"
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

# probe <file> <stream> <entries>: the stream's values, comma-separated, in ffprobe's order.
probe() { "$FP" -v error -select_streams "$2" -show_entries "stream=$3" -of csv=p=0 "$OUT/$1"; }
# expect <file> <stream> <entries> <values>
expect() {
  local got
  got="$(probe "$1" "$2" "$3")"
  [ "$got" = "$4" ] || { echo "make-media: $1 $2 is '$got', expected '$4' ($3)" >&2; exit 1; }
}
for f in a.mp4:1280:720:180 b.mp4:1280:720:180 c640.mp4:640:480:150; do
  IFS=: read -r n w h frames <<< "$f"
  expect "$n" v:0 codec_name,profile,width,height,pix_fmt,r_frame_rate,nb_frames "h264,High,$w,$h,yuv420p,30/1,$frames"
  expect "$n" a:0 codec_name,profile,sample_rate,channels aac,LC,44100,1
done
expect m.mp3 a:0 codec_name,sample_rate,channels,bit_rate mp3,44100,1,64000
for f in a.mp4 b.mp4 c640.mp4 m.mp3; do
  printf '%-9s %s s, %s bytes\n' "$f" "$("$FP" -v error -show_entries format=duration -of csv=p=0 "$OUT/$f")" "$(stat -c %s "$OUT/$f")"
done
