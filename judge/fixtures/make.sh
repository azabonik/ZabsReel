#!/usr/bin/env bash
# The judge's media, made from FFmpeg's lavfi sources (test patterns and tones, nobody's footage). Nothing is
# downloaded. Usage: make.sh <outdir> [<optional fixture> ...]   env: FFMPEG / FFPROBE (default: the ffmpeg / ffprobe
# on PATH). It always makes the base set below; an optional fixture (the edit tests' media, further below) is made only
# when it is named: run.py names those that the run's tests list in EXTRA_MEDIA, so a run that needs none of them (the
# runner's self-test) does not spend the time. A name that is not an optional fixture fails (exit 2).
# The base set. The four clips use the recipes of the repository's CI media (scripts/ci/make-media.sh):
#   a.mp4     testsrc2 1280x720 30 fps 6 s + sine 440 Hz   H.264 High yuv420p + AAC-LC mono 44.1 kHz
#   b.mp4     testsrc  1280x720 30 fps 6 s + sine 660 Hz   same codecs
#   c640.mp4  testsrc2  640x480 30 fps 5 s + sine 440 Hz   same codecs
#   m.mp3     sine 330 Hz 20 s                              MP3 mono 44.1 kHz 64 kb/s
# one for the measurement self-check:
#   gap.m4a   440 Hz tone, digital silence from 2.0 to 3.5 s, 5.5 s in all   AAC-LC mono 44.1 kHz
# and a very small video that a test puts in a data: URI (a few kB):
#   tiny.mp4  testsrc 32x32 10 fps 1 s, no audio                             H.264 yuv420p
# a colour look-up table that swaps red and blue (test_v020_otio_compat):
#   look.cube  LUT_3D_SIZE 2
# and the effects test's pictures (test_effects), 30 fps, 2 s unless said, no audio, H.264 yuv420p (crf 18):
#   fx-white.mp4     white 320x180                   fx-bars.mp4      testsrc2 240x180 (4:3, letterboxed in 16:9)
#   fx-base.mp4      0xE020E0 320x180, 20 s (under it)                fx-base2.mp4     0x20C840, the same
#   fx-gray64.mp4    0x404040 320x180
#   fx-gray128.mp4   0x808080 320x180                fx-gray128p.mp4  0x808080 180x320 (portrait)
#   fx-pair.mp4      0x806060 | 0xC04040, each 160x180
#   fx-redblue.mp4   0xE02020 | 0x2020E0             fx-blue.mp4      0x2060C0 320x180
#   fx-holdgb.mp4    0xE09020 | 0xE02090 (the same colour with green and blue swapped), each 160x180
#   fx-box.mp4       a white 60x50 box at (130, 65) on black 320x180
#   fx-gridline.mp4  a white line at y 30..33 on black 320x180
#   fx-mover.mp4     a white 40x40 box at y 70, x = 20 + 100 t, on black 320x180
#   fx-ramp.mp4      a grey ramp, 0 at the left to 255 at the right, 320x180, 1 s
#   fx-greensq.mp4   a 0x606060 60x60 square at y 60, x = 100 + 30 t, on 0x00FF00 320x180, 1 s
# The optional fixtures: the edit tests' media (test_cuts, test_speed_*, test_locks, test_freeze, test_reverse_slowmo),
# whose every frame shows its own index: nine vertical stripes of 20 pixels, stripe b bright (luma 220) when bit b of the
# frame's index is set, dark (30) when not (observe.frame_indexes); their sound is a chirp,
# 0.25 sin(2 pi (200 t + 100 t^2)), whose frequency 200 + 200 t Hz says the source moment (observe.chirp_time):
#   idx.mp4      stripes 180x90 30 fps 16 s + the chirp 16 s            H.264 crf 12 (GOP 15) + AAC-LC mono 48 kHz 192 kb/s
#   idx2997.mp4  stripes 180x90 30000/1001 fps 16 s on a 1/30000 timebase, no audio
#   skew.mp4     stripes 180x90 30 fps 3.0 s + the chirp 3.5 s (the sound outlasts the picture)
#   cutout.mkv   stripes 180x90 30 fps 2 s, the top half transparent     FFV1 yuva420p, no audio
#   move.mp4     testsrc2 320x180 30 fps 3 s + sine 440 Hz               H.264 crf 12 + AAC-LC mono 48 kHz
#   tone300.m4a  sine 300 Hz 10 s                                        AAC-LC mono 48 kHz
#   chirp.m4a    the chirp alone, 16 s: another recording of idx.mp4's   AAC-LC mono 48 kHz 192 kb/s
#                moments (a microphone's, say)
# and a long one, for the edit tests' bakes that must still run while the test changes the timeline or cancels them
# (test_locks, test_reverse_slowmo: reversing 10 s of it takes about 4 s on v0.2.0):
#   long.mp4     testsrc2 1920x1080 30 fps 20 s + sine 440 Hz            the base clips' codecs
# The tones are at amplitude 1/8 (peak about -18 dBFS). The frame rate is the source's (rate=30), never -r.
# Then checks each file it made with ffprobe (codecs, size, rate, frame count, channels) and prints what it made.
set -euo pipefail
OUT="${1:?usage: make.sh <outdir> [<optional fixture> ...]}"; FF="${FFMPEG:-ffmpeg}"; FP="${FFPROBE:-ffprobe}"
shift
OPTIONAL=" idx.mp4 idx2997.mp4 skew.mp4 cutout.mkv move.mp4 tone300.m4a chirp.m4a long.mp4 "
WANT=" "
for n in "$@"; do
  case "$OPTIONAL" in
    *" $n "*) WANT="$WANT$n " ;;
    *) echo "make.sh: '$n' is not an optional fixture (they are:$OPTIONAL)" >&2; exit 2 ;;
  esac
done
# want <file>: whether the optional fixture <file> was named
want() { case "$WANT" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
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
if want long.mp4; then clip long.mp4 testsrc2 1920x1080 20 440; fi
"$FF" -nostdin -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=330:sample_rate=44100:duration=20" \
  -c:a libmp3lame -b:a 64k -ac 1 -ar 44100 "$OUT/m.mp3"
"$FF" -nostdin -hide_banner -loglevel error -y \
  -f lavfi -i "aevalsrc=exprs='if(between(t\,2\,3.5)\,0\,0.125*sin(2*PI*440*t))':sample_rate=44100:duration=5.5" \
  -c:a aac -ac 1 -ar 44100 "$OUT/gap.m4a"

"$FF" -nostdin -hide_banner -loglevel error -y -f lavfi -i "testsrc=size=32x32:rate=10:duration=1" \
  -c:v libx264 -preset medium -crf 30 -pix_fmt yuv420p -movflags +faststart "$OUT/tiny.mp4"

printf 'LUT_3D_SIZE 2\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1\n' > "$OUT/look.cube"

# still <file> <lavfi graph> [<seconds>]: a picture with no audio
still() {
  "$FF" -nostdin -hide_banner -loglevel error -y -f lavfi -i "$2" -t "${3:-2}" \
    -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p "$OUT/$1"
}
still fx-white.mp4 "color=c=white:s=320x180:r=30"
still fx-bars.mp4 "testsrc2=s=240x180:r=30"
still fx-base.mp4 "color=c=0xE020E0:s=320x180:r=30" 20
still fx-base2.mp4 "color=c=0x20C840:s=320x180:r=30" 20
still fx-gray64.mp4 "color=c=0x404040:s=320x180:r=30"
still fx-gray128.mp4 "color=c=0x808080:s=320x180:r=30"
still fx-gray128p.mp4 "color=c=0x808080:s=180x320:r=30"
still fx-pair.mp4 "color=c=0x806060:s=160x180:r=30[l];color=c=0xC04040:s=160x180:r=30[r];[l][r]hstack"
still fx-redblue.mp4 "color=c=0xE02020:s=160x180:r=30[l];color=c=0x2020E0:s=160x180:r=30[r];[l][r]hstack"
still fx-holdgb.mp4 "color=c=0xE09020:s=160x180:r=30[l];color=c=0xE02090:s=160x180:r=30[r];[l][r]hstack"
still fx-blue.mp4 "color=c=0x2060C0:s=320x180:r=30"
still fx-box.mp4 "color=c=black:s=320x180:r=30,drawbox=x=130:y=65:w=60:h=50:color=white:t=fill"
still fx-gridline.mp4 "color=c=black:s=320x180:r=30,drawbox=x=0:y=30:w=320:h=4:color=white:t=fill"
still fx-mover.mp4 "color=c=black:s=320x180:r=30[b];color=c=white:s=40x40:r=30[w];[b][w]overlay=x='20+t*100':y=70:eval=frame"
still fx-ramp.mp4 "color=c=gray:s=320x180:r=30,format=gray,geq=lum='X/320*255'" 1
still fx-greensq.mp4 "color=c=0x00FF00:s=320x180:r=30[b];color=c=0x606060:s=60x60:r=30[q];[b][q]overlay=x='100+t*30':y=60:eval=frame" 1

# The optional fixtures: the edit tests' frame-index pictures and chirp (see the top).
STRIPES="geq=lum='if(gt(mod(floor(N/pow(2\,floor(X*9/W)))\,2)\,0)\,220\,30)':cb=128:cr=128"
CHIRP="aevalsrc=exprs='0.25*sin(2*PI*(200*t+100*t*t))':sample_rate=48000"
X264="-c:v libx264 -preset medium -crf 12 -pix_fmt yuv420p -g 15"
if want idx.mp4; then
  # shellcheck disable=SC2086
  "$FF" -nostdin -hide_banner -loglevel error -y -f lavfi -i "color=c=gray:s=180x90:r=30:d=16,format=yuv420p,$STRIPES" \
    -f lavfi -i "$CHIRP:duration=16" -map 0:v -map 1:a $X264 -c:a aac -b:a 192k -ac 1 -ar 48000 "$OUT/idx.mp4"
fi
if want idx2997.mp4; then
  # shellcheck disable=SC2086
  "$FF" -nostdin -hide_banner -loglevel error -y \
    -f lavfi -i "color=c=gray:s=180x90:r=30000/1001:d=16,format=yuv420p,$STRIPES" $X264 -video_track_timescale 30000 \
    "$OUT/idx2997.mp4"
fi
if want skew.mp4; then
  # shellcheck disable=SC2086
  "$FF" -nostdin -hide_banner -loglevel error -y -f lavfi -i "color=c=gray:s=180x90:r=30:d=3,format=yuv420p,$STRIPES" \
    -f lavfi -i "$CHIRP:duration=3.5" -map 0:v -map 1:a $X264 -c:a aac -b:a 192k -ac 1 -ar 48000 "$OUT/skew.mp4"
fi
if want cutout.mkv; then
  "$FF" -nostdin -hide_banner -loglevel error -y \
    -f lavfi -i "color=c=gray:s=180x90:r=30:d=2,format=yuva420p,$STRIPES:a='if(lt(Y\,H/2)\,0\,255)'" \
    -c:v ffv1 -pix_fmt yuva420p "$OUT/cutout.mkv"
fi
if want move.mp4; then
  # shellcheck disable=SC2086
  "$FF" -nostdin -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=320x180:rate=30:duration=3" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=3" -map 0:v -map 1:a $X264 \
    -c:a aac -b:a 128k -ac 1 -ar 48000 "$OUT/move.mp4"
fi
if want tone300.m4a; then
  "$FF" -nostdin -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=300:sample_rate=48000:duration=10" \
    -c:a aac -b:a 128k -ac 1 -ar 48000 "$OUT/tone300.m4a"
fi
if want chirp.m4a; then
  "$FF" -nostdin -hide_banner -loglevel error -y -f lavfi -i "$CHIRP:duration=16" -c:a aac -b:a 192k -ac 1 -ar 48000 \
    "$OUT/chirp.m4a"
fi

# probe <file> <stream> <entries>: the stream's values, comma-separated, in ffprobe's order.
probe() { "$FP" -v error -select_streams "$2" -show_entries "stream=$3" -of csv=p=0 "$OUT/$1"; }
# expect <file> <stream> <entries> <values>
expect() {
  local got
  got="$(probe "$1" "$2" "$3")"
  [ "$got" = "$4" ] || { echo "make.sh: $1 $2 is '$got', expected '$4' ($3)" >&2; exit 1; }
}
clips="a.mp4:1280:720:180 b.mp4:1280:720:180 c640.mp4:640:480:150"
if want long.mp4; then clips="$clips long.mp4:1920:1080:600"; fi
for f in $clips; do
  IFS=: read -r n w h frames <<< "$f"
  expect "$n" v:0 codec_name,profile,width,height,pix_fmt,r_frame_rate,nb_frames "h264,High,$w,$h,yuv420p,30/1,$frames"
  expect "$n" a:0 codec_name,profile,sample_rate,channels aac,LC,44100,1
done
expect m.mp3 a:0 codec_name,sample_rate,channels,bit_rate mp3,44100,1,64000
expect gap.m4a a:0 codec_name,profile,sample_rate,channels aac,LC,44100,1
expect tiny.mp4 v:0 codec_name,width,height,pix_fmt,r_frame_rate,nb_frames h264,32,32,yuv420p,10/1,10
for f in fx-white fx-gray64 fx-gray128 fx-pair fx-redblue fx-holdgb fx-blue fx-box fx-gridline fx-mover; do
  expect "$f.mp4" v:0 codec_name,width,height,pix_fmt,r_frame_rate,nb_frames h264,320,180,yuv420p,30/1,60
done
for f in fx-base fx-base2; do
  expect "$f.mp4" v:0 codec_name,width,height,pix_fmt,r_frame_rate,nb_frames h264,320,180,yuv420p,30/1,600
done
expect fx-bars.mp4 v:0 codec_name,width,height,pix_fmt,r_frame_rate,nb_frames h264,240,180,yuv420p,30/1,60
expect fx-gray128p.mp4 v:0 codec_name,width,height,pix_fmt,r_frame_rate,nb_frames h264,180,320,yuv420p,30/1,60
for f in fx-ramp fx-greensq; do
  expect "$f.mp4" v:0 codec_name,width,height,pix_fmt,r_frame_rate,nb_frames h264,320,180,yuv420p,30/1,30
done
for f in fx-white fx-bars fx-ramp; do
  [ -z "$(probe "$f.mp4" a "codec_type")" ] || { echo "make.sh: $f.mp4 has an audio stream" >&2; exit 1; }
done
[ "$(sed -n 1p "$OUT/look.cube")" = "LUT_3D_SIZE 2" ] || { echo "make.sh: look.cube is not a LUT" >&2; exit 1; }
if want idx.mp4; then
  expect idx.mp4 v:0 codec_name,width,height,pix_fmt,r_frame_rate,nb_frames h264,180,90,yuv420p,30/1,480
  expect idx.mp4 a:0 codec_name,profile,sample_rate,channels aac,LC,48000,1
fi
if want idx2997.mp4; then
  expect idx2997.mp4 v:0 codec_name,width,height,pix_fmt,r_frame_rate,time_base,nb_frames \
    h264,180,90,yuv420p,30000/1001,1/30000,480
  [ -z "$(probe idx2997.mp4 a "codec_type")" ] || { echo "make.sh: idx2997.mp4 has an audio stream" >&2; exit 1; }
fi
if want skew.mp4; then
  expect skew.mp4 v:0 codec_name,width,height,r_frame_rate,nb_frames h264,180,90,30/1,90
  expect skew.mp4 a:0 codec_name,sample_rate,channels,duration aac,48000,1,3.500000
fi
if want cutout.mkv; then
  expect cutout.mkv v:0 codec_name,width,height,pix_fmt,r_frame_rate ffv1,180,90,yuva420p,30/1
fi
if want move.mp4; then
  expect move.mp4 v:0 codec_name,width,height,pix_fmt,r_frame_rate,nb_frames h264,320,180,yuv420p,30/1,90
  expect move.mp4 a:0 codec_name,sample_rate,channels aac,48000,1
fi
if want tone300.m4a; then expect tone300.m4a a:0 codec_name,sample_rate,channels aac,48000,1; fi
if want chirp.m4a; then
  expect chirp.m4a a:0 codec_name,profile,sample_rate,channels aac,LC,48000,1
  [ -z "$(probe chirp.m4a v "codec_type")" ] || { echo "make.sh: chirp.m4a has a video stream" >&2; exit 1; }
fi
for f in a.mp4 b.mp4 c640.mp4 m.mp3 gap.m4a tiny.mp4$WANT; do
  printf '%-9s %s s, %s bytes\n' "$f" "$("$FP" -v error -show_entries format=duration -of csv=p=0 "$OUT/$f")" "$(stat -c %s "$OUT/$f")"
done
