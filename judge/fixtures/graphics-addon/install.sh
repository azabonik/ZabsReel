#!/usr/bin/env bash
# Installs the graphics add-on that the judge gives the editor (judge/README.md, "The graphics add-on"): Remotion's
# packages from this folder's package-lock.json (npm ci --ignore-scripts: every tarball is checked against the lock's
# sha512 integrity, and no package script runs) and the Chrome for Testing headless shell that Remotion 4.0.481 tests
# with, from headless-shell.json (its size and sha256 are checked before it is unpacked), into Remotion's own browser
# cache layout: <dest>/node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/. Then
# <dest> is made read-only for everyone (the editor only reads it).
#
# It downloads (from registry.npmjs.org and storage.googleapis.com), so it runs before the judge, never in a test:
# judge.yml runs it as the runner's user into /srv/judge/addon. Give <zip> to use a copy of the zip already on disk
# (it is checked the same way).
# Usage: install.sh <dest> [<zip>]   (<dest> must not exist yet)   needs: npm, curl (without <zip>), unzip, sha256sum
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:?usage: install.sh <dest> [<zip>]}"
ZIP="${2:-}"
if [ -e "$DEST" ]; then echo "install.sh: $DEST exists" >&2; exit 1; fi
pin() { python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$HERE/headless-shell.json" "$1"; }
VERSION="$(pin version)"; URL="$(pin url)"; SIZE="$(pin size)"; SHA="$(pin sha256)"

mkdir -p "$DEST"
cp "$HERE/package.json" "$HERE/package-lock.json" "$DEST/"
(cd "$DEST" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if [ -z "$ZIP" ]; then
  ZIP="$TMP/chrome-headless-shell-linux64.zip"
  curl -fsSL --retry 3 --max-time 900 -o "$ZIP" "$URL"
fi
got_size="$(stat -c %s "$ZIP")"
if [ "$got_size" != "$SIZE" ]; then echo "install.sh: the zip is $got_size bytes, not $SIZE" >&2; exit 1; fi
echo "$SHA  $ZIP" | sha256sum -c --quiet - || { echo "install.sh: the zip's sha256 is not the pinned one" >&2; exit 1; }
CACHE="$DEST/node_modules/.remotion/chrome-headless-shell"
mkdir -p "$CACHE/linux64"
unzip -q "$ZIP" -d "$CACHE/linux64"
printf '%s' "$VERSION" > "$CACHE/VERSION"
test -x "$CACHE/linux64/chrome-headless-shell-linux64/chrome-headless-shell"
chmod -R a-w,a+rX "$DEST"
echo "install.sh: the graphics add-on is in $DEST (Remotion $(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$DEST/node_modules/@remotion/renderer/package.json"), headless shell $VERSION)"
