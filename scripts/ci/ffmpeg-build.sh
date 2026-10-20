#!/usr/bin/env bash
# The FFmpeg builds of the FFmpeg matrix workflow, from the pins in ffmpeg-builds.txt (next to this script).
# Usage: ffmpeg-build.sh plan                      the job matrix for VERSIONS (space- or comma-separated versions;
#                                                  empty = every row); writes matrix=<json> to GITHUB_OUTPUT when set
#        ffmpeg-build.sh fetch <ver> <dir>         the pinned BtbN tarball in <dir>: kept when there (a cache hit),
#                                                  else downloaded into <dir> as a new, empty folder; then its size
#                                                  and sha256 are checked against the pin
#        ffmpeg-build.sh unpack <ver> <dir> <dest> checks the tarball in <dir> again, unpacks it into <dest> (a new,
#                                                  empty folder) and prints the build's bin folder
# Nothing inside an archive is executed except the final `ffmpeg -version` check, which must name the pinned build.
set -euo pipefail
PINS="$(dirname "$(readlink -f "$0")")/ffmpeg-builds.txt"
die() { echo "::error::$*" >&2; exit 1; }

# pin <ver>: sets RUNNER SRC TAG ASSET SHA BYTES from the version's row; fails when there is none.
pin() {
  local row
  row="$(awk -v v="$1" '!/^#/ && NF && $1 == v' "$PINS")"
  [ -n "$row" ] || return 1
  read -r _ RUNNER SRC TAG ASSET SHA BYTES <<< "$row"
  # The workflow's FFmpeg steps run only for these two: any other value would leave the job on the runner's apt FFmpeg.
  case "$SRC" in apt|btbn) ;; *) die "ffmpeg-builds.txt: unknown source '$SRC' for $1 (apt or btbn)";; esac
  if [ "$SRC" = btbn ]; then
    [[ "$ASSET" =~ ^ffmpeg-n[0-9][A-Za-z0-9.-]*-linux64-gpl-[0-9.]+\.tar\.xz$ ]] || die "ffmpeg-builds.txt: bad asset name for $1: $ASSET"
    [[ "$SHA" =~ ^[0-9a-f]{64}$ ]] || die "ffmpeg-builds.txt: bad sha256 for $1"
    [[ "$BYTES" =~ ^[0-9]+$ ]] || die "ffmpeg-builds.txt: bad size for $1"
  fi
}

plan() {
  local all v json='[]' seen=" "
  all="$(awk '!/^#/ && NF {printf "%s ", $1}' "$PINS")"
  local want="${VERSIONS:-}"; want="${want//,/ }"
  [ -n "${want// /}" ] || want="$all"
  for v in $want; do
    [[ "$v" =~ ^[0-9]+\.[0-9]+$ ]] && pin "$v" || die "FFmpeg '$v' is not in scripts/ci/ffmpeg-builds.txt (versions: ${all% })"
    [[ "$seen" == *" $v "* ]] && continue
    seen="$seen$v "
    [ "$SRC" = btbn ] || SHA=""
    json="$(jq -c --arg f "$v" --arg os "$RUNNER" --arg src "$SRC" --arg sha "$SHA" \
      '. + [{ffmpeg: $f, os: $os, source: $src, sha256: $sha}]' <<< "$json")"
  done
  echo "matrix={\"include\":$json}" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
}

# check <file>: the file's size and sha256 against the pin.
check() {
  local size
  size="$(stat -c %s "$1")"
  [ "$size" = "$BYTES" ] || return 1
  (cd "$(dirname "$1")" && echo "$SHA  $ASSET" | sha256sum -c --strict -) >&2
}

fetch() {
  local v="$1" dir="$2" url code
  pin "$v" || die "FFmpeg $v is not in ffmpeg-builds.txt"
  [ "$SRC" = btbn ] || die "FFmpeg $v is the runner's $SRC build, not a download"
  if [ -f "$dir/$ASSET" ]; then
    echo "FFmpeg $v: $ASSET from the cache" >&2
    check "$dir/$ASSET" || die "FFmpeg $v: the cached $ASSET does not match its pin (sha256 $SHA, $BYTES bytes). Delete the cache entry (gh cache delete ffmpeg-btbn-$v-$SHA) and rerun."
    return 0
  fi
  # A new, empty folder for the download: mkdir without -p fails when it exists.
  mkdir "$dir" || die "FFmpeg $v: $dir already exists without $ASSET in it"
  url="https://github.com/BtbN/FFmpeg-Builds/releases/download/$TAG/$ASSET"
  echo "FFmpeg $v: downloading $url" >&2
  code="$(curl -sSL --retry 3 --retry-delay 10 --connect-timeout 30 -o "$dir/$ASSET" -w '%{http_code}' "$url")" || code="${code:-000}"
  if [ "$code" = 404 ]; then
    rm -f "$dir/$ASSET"
    echo "::error title=FFmpeg $v build gone::$ASSET is no longer in BtbN/FFmpeg-Builds release $TAG (BtbN prunes old autobuild releases), and the cache has no copy (key ffmpeg-btbn-$v-$SHA). Re-pin FFmpeg $v: see this step's log." >&2
    cat >&2 <<EOF
To re-pin FFmpeg $v in scripts/ci/ffmpeg-builds.txt:
  1. Find the newest month-end build that still has a linux64-gpl $v asset (BtbN keeps the last 14 daily
     builds and each month's last build for two years, so never pin a daily or "latest"). A month-end build is
     the newest autobuild tag of a month that is over, whatever its day: the list is newest first, so the loop
     skips the current month's tags and keeps the first tag of each earlier month:
       for t in \$(gh release list -R BtbN/FFmpeg-Builds --limit 100 --json tagName -q '.[].tagName' \\
                  | grep -E '^autobuild-[0-9]{4}-[0-9]{2}-' | grep -v "^autobuild-\$(date -u +%Y-%m)-" \\
                  | awk -F- '!seen[\$2 "-" \$3]++'); do
         a=\$(gh release view "\$t" -R BtbN/FFmpeg-Builds --json assets \\
              -q '.assets[].name | select(endswith("linux64-gpl-$v.tar.xz"))')
         [ -n "\$a" ] && { echo "\$t \$a"; break; }
       done
  2. Download the asset and that release's checksums.sha256 into a new, empty folder and check it:
       gh release download <tag> -R BtbN/FFmpeg-Builds -p <asset> -p checksums.sha256 -D <new folder>
       cd <new folder> && grep " <asset>\$" checksums.sha256 | sha256sum -c -
  3. Put the tag, the asset, its sha256 (sha256sum <asset>) and its size in bytes (stat -c %s <asset>) in the $v row.
  4. A new build is a new FFmpeg: run the matrix on it (locally first) before merging the change.
EOF
    exit 1
  fi
  [ "$code" = 200 ] || { rm -f "$dir/$ASSET"; die "FFmpeg $v: downloading $url failed (HTTP $code)"; }
  check "$dir/$ASSET" || { rm -f "$dir/$ASSET"; die "FFmpeg $v: the download of $ASSET does not match its pin (sha256 $SHA, $BYTES bytes)"; }
}

unpack() {
  local v="$1" dir="$2" dest="$3" top bin want got
  pin "$v" || die "FFmpeg $v is not in ffmpeg-builds.txt"
  [ "$SRC" = btbn ] || die "FFmpeg $v is the runner's $SRC build, nothing to unpack"
  [ -f "$dir/$ASSET" ] && check "$dir/$ASSET" || die "FFmpeg $v: no checked $ASSET in $dir (run fetch first)"
  mkdir "$dest" || die "FFmpeg $v: $dest already exists"
  tar -xJf "$dir/$ASSET" -C "$dest" --no-same-owner
  # One top folder (ffmpeg-<build>-linux64-gpl-<ver>) holding bin/ffmpeg and bin/ffprobe as plain files.
  top="$(find "$dest" -mindepth 1 -maxdepth 1)"
  [ "$(printf '%s\n' "$top" | wc -l)" = 1 ] && [ -d "$top" ] && [ ! -L "$top" ] || die "FFmpeg $v: $ASSET does not unpack to one folder"
  bin="$top/bin"
  for b in ffmpeg ffprobe; do
    [ -f "$bin/$b" ] && [ ! -L "$bin/$b" ] && [ -x "$bin/$b" ] || die "FFmpeg $v: no executable bin/$b in $ASSET"
  done
  # The banner's version must be the asset's build (n8.1.3-9-g29e619e767-<date> for ffmpeg-n8.1.3-9-g29e619e767-...;
  # n6.1.3-<date> for ffmpeg-n6.1.3-...).
  want="${ASSET#ffmpeg-}"; want="${want%-linux64-gpl-*}"
  got="$("$bin/ffmpeg" -version | sed -n '1s/^ffmpeg version \([^ ]*\).*/\1/p')"
  case "$got" in "$want"|"$want"-*) ;; *) die "FFmpeg $v: $bin/ffmpeg reports '$got', not $want";; esac
  echo "FFmpeg $v: $got ($bin)" >&2
  echo "$bin"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  plan) plan ;;
  fetch) [ $# = 2 ] || die "usage: ffmpeg-build.sh fetch <ver> <dir>"; fetch "$@" ;;
  unpack) [ $# = 3 ] || die "usage: ffmpeg-build.sh unpack <ver> <dir> <dest>"; unpack "$@" ;;
  *) die "usage: ffmpeg-build.sh plan | fetch <ver> <dir> | unpack <ver> <dir> <dest>" ;;
esac
