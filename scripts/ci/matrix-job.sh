#!/usr/bin/env bash
# The regression matrix on one FFmpeg build, as the local matrix kit's drive.sh runs it for each version: build once
# (unless SKIP_BUILD=1), then the 3 shards one after another; each shard runs even when an earlier one failed.
# Usage: matrix-job.sh <checkout> <outdir> <media-dir> <version>
#   The build under test is AIVE_FFMPEG / AIVE_FFPROBE (unset = the ffmpeg on PATH: on ubuntu-22.04, apt's 4.4.2).
#   <version> must be that build's version: before anything runs, check-ffmpeg.sh checks every ffmpeg and ffprobe the
#   suites use against it (and, with FF_SOURCE=apt|btbn, where they are), else the job fails (exit 1). <version> also
#   names the files: <outdir>/m<version>-<k>.log (the shard's output) and <outdir>/m<version>-<k>/ (results-<k>.tsv,
#   logs/<suite>.log). JOBS is passed on to run-matrix.sh. BROWSER_INFO, when set, goes to the job summary.
# Prints each shard's output (its MATRIX and FAIL lines) and the real [ffmpeg-guard] refusal count. Do not grep
# "guard"+"refus": smoke-safepath prints expected "ok ... refuses" lines, which gives a misleading 46.
# With GITHUB_STEP_SUMMARY set, each shard's MATRIX and FAIL lines go to the job summary as soon as that shard ends
# (so a job stopped by its timeout still shows the shards that finished), then the count and any DOWNLOAD lines.
# Download tripwire (nothing may be fetched during the matrix): a "[whisper] downloading" line in any suite log, a
# file that appeared under $HOME/.aive during the run, or one that appeared under the motion smokes' scratch HOME/.aive
# or AIVE_DATA_DIR (run-matrix.sh lists those in motion-new-files.txt) is reported as a DOWNLOAD line and fails the job.
# The suites with a result row are counted across the shards; fewer than the floor in matrix-suites.txt (next to this
# script) fails the job, and the count goes to the job summary.
# Exit status: 0 when all 3 shards printed a MATRIX line, no suite failed, at least the floor's number of suites gave a
# result and nothing was downloaded, else 1 (98: the build failed).
set -u
HERE="$(dirname "$(readlink -f "$0")")"
WT="$1"; MEDIA="$3"; V="$4"
mkdir -p "$2" && OUT="$(cd "$2" && pwd)" || exit 99
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
# The FFmpeg under test is <version> (a job must not pass on another build).
bash "$HERE/check-ffmpeg.sh" "$V" || exit 1
FF="${AIVE_FFMPEG:-ffmpeg}"
build="$("$FF" -version | sed -n '1s/^ffmpeg version \([^ ]*\).*/\1/p')"
if [ -z "${SKIP_BUILD:-}" ]; then
  (cd "$WT" && npm run build > "$OUT/build.log" 2>&1) && echo "BUILD OK" || { echo "BUILD FAILED (see $OUT/build.log)"; exit 98; }
fi
# Files under $HOME/.aive before the run, for the tripwire.
find "$HOME/.aive" -type f 2>/dev/null | sort > "$OUT/aive-before.txt"
bad=0
{
  echo "### FFmpeg $V"
  echo "Build under test: \`$build\` ($FF)"
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
# Suites with a result row across the shards, against the recorded floor in matrix-suites.txt.
rows="$(cat "$OUT"/m"$V"-*/results-*.tsv 2>/dev/null | wc -l)"
floor="$(grep -v '^#' "$HERE/matrix-suites.txt" 2>/dev/null | tr -d '[:space:]')"
suites="suites $V: $rows with a result (floor $floor)"
low=""
if ! [[ "$floor" =~ ^[0-9]+$ ]]; then low="scripts/ci/matrix-suites.txt has no number"
elif [ "$rows" -lt "$floor" ]; then low="fewer than the $floor in scripts/ci/matrix-suites.txt"; fi
if [ -n "$low" ]; then
  bad=1; suites="suites $V: $rows with a result, $low"
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=FFmpeg $V: suites missing::$suites"
fi
echo "$suites"
guard="$(cat "$OUT"/m"$V"-*/logs/*.log 2>/dev/null | grep -c '\[ffmpeg-guard\]')"
echo "guard lines $V: $guard"
find "$HOME/.aive" -type f 2>/dev/null | sort > "$OUT/aive-after.txt"
{
  grep -l '\[whisper\] downloading' "$OUT"/m"$V"-*/logs/*.log 2>/dev/null | sed 's|.*/logs/|DOWNLOAD whisper in |; s|\.log$||'
  comm -13 "$OUT/aive-before.txt" "$OUT/aive-after.txt" | sed 's|^|DOWNLOAD new file |'
  cat "$OUT"/m"$V"-*/motion-new-files.txt 2>/dev/null | sed 's|^|DOWNLOAD new file in |'
} > "$OUT/downloads.txt"
cat "$OUT/downloads.txt"
{
  echo '```'
  echo "$suites"
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
