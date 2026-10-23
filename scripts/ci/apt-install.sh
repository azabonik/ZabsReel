#!/usr/bin/env bash
# Installs apt packages on a CI runner with bounded waits and retries.
# On 2026-10-22 the FFmpeg matrix's 4.4 and 8.1 jobs spent 32 and 34 minutes in `apt-get update && apt-get install`
# (26 s on the other jobs of the same run). The saved log shows throttled mirror throughput, not a stall: 85 MB at a
# steady 43 kB/s for 31m50s, never idle. So `install` has no time cap (any cap turns a slow pass into a fail); the
# 90-minute job limit bounds it. Each connection gives up after 30 s without data and apt retries it; `update` is
# capped at 10 min; the whole update + install is tried up to 3 times for real failures (a 404 during a mirror sync,
# a hash mismatch). Before attempts 2 and 3, `dpkg --configure -a` finishes an install the failed attempt left
# half-done, or every later attempt fails at once with "dpkg was interrupted".
# Callers pass --no-install-recommends themselves (it is not a default here); the CI suites need no recommended package.
# Usage: bash scripts/ci/apt-install.sh [--no-install-recommends] package...
# judge.yml keeps its own copy of this loop inline: it runs only lock-covered code as the runner user.
set -u
[ $# -gt 0 ] || { echo "usage: apt-install.sh [--no-install-recommends] package..." >&2; exit 2; }
opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o DPkg::Lock::Timeout=120)
for attempt in 1 2 3; do
  if [ "$attempt" -gt 1 ]; then
    sudo DEBIAN_FRONTEND=noninteractive timeout -k 10 300 dpkg --configure -a || true
  fi
  if sudo timeout -k 10 600 apt-get "${opts[@]}" update -q &&
     sudo DEBIAN_FRONTEND=noninteractive apt-get "${opts[@]}" install -y -q "$@"; then
    exit 0
  fi
  echo "::warning::apt-get attempt $attempt of 3 failed; retrying in 10 s"
  sleep 10
done
echo "::error::apt-get failed 3 times: could not install $*"
exit 1
