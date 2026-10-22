#!/usr/bin/env bash
# judge.yml, after a failed run: copies the judge's logs out of the kept scratch folders for the upload.
#
#   collect_logs.sh <uid:gid> <out> <folder>...
#
# judge.yml runs it as root (sudo -n), after lockout.py --kill has ended every zjudge process, so nothing changes the
# folders while it runs. The scratch folders hold files and folders of zjudge's and links among them (the editor's
# sandbox is zjudge's own folder, where the kernel's link protection does not apply). Only the regular files named
# *.log or *.stderr are copied: find follows no link (also not a <folder> that is one), stays on the folder's file
# system, and -type f leaves out links, FIFOs and devices, so a link to a file of the runner's (the checkout's .git,
# /proc/self/environ) or to a folder never reaches <out>. <out> is made new (mode 0700) and then given to <uid:gid>
# (the runner's user); it is all the upload sees. The self-test (judge/selftest.py, ci_scripts) runs it on a tree
# with such a link and a FIFO.
set -euo pipefail
owner="${1:?usage: collect_logs.sh <uid:gid> <out> <folder>...}"
out="${2:?usage: collect_logs.sh <uid:gid> <out> <folder>...}"
shift 2
rm -rf -- "$out"
mkdir -m 0700 -- "$out"
for top in "$@"; do
  if [ -d "$top" ] && [ ! -L "$top" ]; then
    find "$top" -xdev -type f \( -name '*.log' -o -name '*.stderr' \) -exec cp -P --parents -t "$out" -- {} +
  fi
done
chown -R -- "$owner" "$out"
