#!/usr/bin/env bash
# The regression matrix on one FFmpeg build, as the local matrix kit's drive.sh runs it for each version: build once
# (unless SKIP_BUILD=1), then the 3 shards one after another; each shard runs even when an earlier one failed.
# Usage: matrix-job.sh <checkout> <outdir> <media-dir> <version>
#   The build under test is AIVE_FFMPEG / AIVE_FFPROBE (unset = the ffmpeg on PATH: on ubuntu-22.04, apt's 4.4.2).
#   <version> must be that build's version: before anything runs, every ffmpeg and ffprobe the suites use (those two,
#   or else the ones on PATH and in /usr/bin, where run-matrix.sh's motion smokes look) must report a version that
#   starts with "<version>." or "n<version>." (BtbN's builds), else the job fails (exit 1). <version> also names the
#   files: <outdir>/m<version>-<k>.log (the shard's output) and <outdir>/m<version>-<k>/ (results-<k>.tsv,
#   logs/<suite>.log). JOBS is passed on to run-matrix.sh. BROWSER_INFO, when set, goes to the job summary.
# Prints each shard's output (its MATRIX and FAIL lines) and the real [ffmpeg-guard] refusal count. Do not grep
# "guard"+"refus": smoke-safepath prints expected "ok ... refuses" lines, which gives a misleading 46.
# With GITHUB_STEP_SUMMARY set, each shard's MATRIX and FAIL lines go to the job summary as soon as that shard ends
# (so a job stopped by its timeout still shows the shards that finished), then the count and any DOWNLOAD lines.
# Download tripwire (nothing may be fetched during the matrix): a "[whisper] downloading" line in any suite log, or a
# file that appeared under $HOME/.aive during the run, is reported as a DOWNLOAD line and fails the job.
# Exit status: 0 when all 3 shards printed a MATRIX line, no suite failed and nothing was downloaded, else 1 (98: the
# build failed).
set -u
HERE="$(dirname "$(readlink -f "$0")")"
WT="$1"; MEDIA="$3"; V="$4"
mkdir -p "$2" && OUT="$(cd "$2" && pwd)" || exit 99
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
# The FFmpeg under test is <version> (a job must not pass on another build).
[[ "$V" =~ ^[0-9]+\.[0-9]+$ ]] || { echo "matrix-job.sh: <version> is major.minor (e.g. 4.4 or 9.0), not '$V'"; exit 1; }
if [ -n "${AIVE_FFMPEG:-}" ]; then FFS=("$AIVE_FFMPEG" "${AIVE_FFPROBE:-ffprobe}"); else FFS=(ffmpeg ffprobe /usr/bin/ffmpeg /usr/bin/ffprobe); fi
for ff in "${FFS[@]}"; do
  got="$("$ff" -version 2>/dev/null | sed -n '1s/^ff[a-z]* version \([^ ]*\).*/\1/p')"
  case "$got" in
    "$V".*|"n$V".*) echo "FFmpeg $V: $ff is $got" ;;
    *) echo "FFmpeg $V: $ff reports '${got:-no version}', not $V"
       [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=FFmpeg $V: wrong build::$ff reports '${got:-no version}', not $V"
       exit 1 ;;
  esac
done
build="$("${FFS[0]}" -version | sed -n '1s/^ffmpeg version \([^ ]*\).*/\1/p')"
if [ -z "${SKIP_BUILD:-}" ]; then
  (cd "$WT" && npm run build > "$OUT/build.log" 2>&1) && echo "BUILD OK" || { echo "BUILD FAILED (see $OUT/build.log)"; exit 98; }
fi
# Files under $HOME/.aive before the run, for the tripwire.
find "$HOME/.aive" -type f 2>/dev/null | sort > "$OUT/aive-before.txt"
bad=0
{
  echo "### FFmpeg $V"
  echo "Build under test: \`$build\` (${FFS[0]})"
  [ -z "${BROWSER_INFO:-}" ] || echo "Browser suites (smoke-web, parity-gl, smoke-voicefx): $BROWSER_INFO"
  echo
} >> "$SUMMARY"
for k in 1 2 3; do
  echo "--- shard $k/3 ($(date -u +%H:%M:%S) UTC)"
  SKIP_BUILD=1 SHARD=$k/3 bash "$HERE/run-matrix.sh" "$WT" "$OUT/m$V-$k" "$MEDIA" 2>&1 | tee "$OUT/m$V-$k.log"
  rc="${PIPESTATUS[0]}"
  [ "$rc" = 0 ] || bad=1
  # A shard that stopped before its results (setup error, killed) has no MATRIX line: say so where the line would be.
  grep -q '^MATRIX' "$OUT/m$V-$k.log" || { echo "MATRIX shard $k/3: no result (exit $rc)" | tee -a "$OUT/m$V-$k.log"; bad=1; }
  # One closed block per shard: a job stopped later still has a well-formed summary of the shards before.
  { echo '```'; grep -E '^(MATRIX|FAIL )' "$OUT/m$V-$k.log"; echo '```'; } >> "$SUMMARY"
done
guard="$(cat "$OUT"/m"$V"-*/logs/*.log 2>/dev/null | grep -c '\[ffmpeg-guard\]')"
echo "guard lines $V: $guard"
find "$HOME/.aive" -type f 2>/dev/null | sort > "$OUT/aive-after.txt"
{
  grep -l '\[whisper\] downloading' "$OUT"/m"$V"-*/logs/*.log 2>/dev/null | sed 's|.*/logs/|DOWNLOAD whisper in |; s|\.log$||'
  comm -13 "$OUT/aive-before.txt" "$OUT/aive-after.txt" | sed 's|^|DOWNLOAD new file |'
} > "$OUT/downloads.txt"
cat "$OUT/downloads.txt"
{
  echo '```'
  echo "guard lines $V: $guard"
  cat "$OUT/downloads.txt"
  echo '```'
} >> "$SUMMARY"
if [ -s "$OUT/downloads.txt" ]; then
  bad=1
  echo "DOWNLOAD: $(wc -l < "$OUT/downloads.txt") line(s) above; nothing may be downloaded during the matrix"
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=FFmpeg $V: download during the matrix::$(head -1 "$OUT/downloads.txt") (all lines: downloads.txt in the artifact)"
fi
exit "$bad"
