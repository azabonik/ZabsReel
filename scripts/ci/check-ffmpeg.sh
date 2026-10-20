#!/usr/bin/env bash
# The FFmpeg under test is <version>: a job must not pass on another build. The one copy of this check: the FFmpeg
# matrix workflow runs it before npm ci (to fail early), and matrix-job.sh runs it again before the shards.
# Usage: check-ffmpeg.sh <version>
#   env: AIVE_FFMPEG / AIVE_FFPROBE  the build under test; unset = the ffmpeg and ffprobe on PATH
#        FF_SOURCE                   the version's source in ffmpeg-builds.txt (the workflow sets it from the matrix):
#                                    btbn  AIVE_FFMPEG and AIVE_FFPROBE must be set, side by side, outside /usr/bin,
#                                          and report "n<version>." (BtbN's banner), so a lost AIVE_FFMPEG cannot
#                                          make the job test the runner's apt FFmpeg of the same version (6.1)
#                                    apt   AIVE_FFMPEG and AIVE_FFPROBE must be unset, the ffmpeg and ffprobe on
#                                          PATH must be the ones in /usr/bin, and all report "<version>."
#                                    unset (a local run): either banner
# Checks every ffmpeg and ffprobe the suites use: AIVE_FFMPEG and AIVE_FFPROBE, or else the ones on PATH and in
# /usr/bin (where run-matrix.sh's motion smokes look when AIVE_FFMPEG is unset). Prints one line per binary.
# Exit status: 0 when all match, else 1 (with an ::error:: line on GitHub Actions).
set -u
V="${1:-}"
fail() {
  echo "FFmpeg $V: $*"
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=FFmpeg $V: wrong build::$*"
  exit 1
}
[[ "$V" =~ ^[0-9]+\.[0-9]+$ ]] || fail "<version> is major.minor (e.g. 4.4 or 9.0), not '$V'"
case "${FF_SOURCE:-}" in
  btbn)
    [ -n "${AIVE_FFMPEG:-}" ] && [ -n "${AIVE_FFPROBE:-}" ] || fail "a btbn build needs AIVE_FFMPEG and AIVE_FFPROBE (the unpack step sets them)"
    [ "$(dirname "$AIVE_FFPROBE")" = "$(dirname "$AIVE_FFMPEG")" ] || fail "AIVE_FFPROBE ($AIVE_FFPROBE) is not next to AIVE_FFMPEG ($AIVE_FFMPEG)"
    case "$AIVE_FFMPEG" in /usr/bin/*) fail "AIVE_FFMPEG is $AIVE_FFMPEG, the runner's apt build, not the BtbN build";; esac
    FFS=("$AIVE_FFMPEG" "$AIVE_FFPROBE"); OK=("n$V.*") ;;
  apt)
    [ -z "${AIVE_FFMPEG:-}${AIVE_FFPROBE:-}" ] || fail "an apt build runs with AIVE_FFMPEG and AIVE_FFPROBE unset, not '${AIVE_FFMPEG:-}' '${AIVE_FFPROBE:-}'"
    for b in ffmpeg ffprobe; do
      [ "$(command -v "$b")" = "/usr/bin/$b" ] || fail "$b on PATH is '$(command -v "$b")', not /usr/bin/$b"
    done
    FFS=(ffmpeg ffprobe /usr/bin/ffmpeg /usr/bin/ffprobe); OK=("$V.*") ;;
  "")
    if [ -n "${AIVE_FFMPEG:-}" ]; then FFS=("$AIVE_FFMPEG" "${AIVE_FFPROBE:-ffprobe}"); else FFS=(ffmpeg ffprobe /usr/bin/ffmpeg /usr/bin/ffprobe); fi
    OK=("$V.*" "n$V.*") ;;
  *) fail "FF_SOURCE is '$FF_SOURCE', not apt or btbn" ;;
esac
for ff in "${FFS[@]}"; do
  got="$("$ff" -version 2>/dev/null | sed -n '1s/^ff[a-z]* version \([^ ]*\).*/\1/p')"
  ok=""
  for p in "${OK[@]}"; do
    # shellcheck disable=SC2053 # $p is a glob on purpose
    [[ "$got" == $p ]] && ok=1
  done
  [ -n "$ok" ] || fail "$ff reports '${got:-no version}', not ${OK[*]%.\*}"
  echo "FFmpeg $V: $ff is $got"
done
exit 0
