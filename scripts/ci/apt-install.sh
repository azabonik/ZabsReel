#!/usr/bin/env bash
# Installs apt packages on a CI runner without letting a stalled mirror hold the job.
# On 2026-10-22 the FFmpeg matrix's 4.4 and 8.1 jobs spent 32 and 34 minutes in `apt-get update && apt-get install`
# (26 s on the other jobs of the same run), close to the job's 90-minute limit. Here every connection gives up after
# 30 s without data and is retried by apt, each `apt-get` call is capped, and the whole update + install is tried up
# to 3 times before the step fails with an error.
# Usage: bash scripts/ci/apt-install.sh [--no-install-recommends] package...
# judge.yml keeps its own copy of this loop inline: it runs only lock-covered code as the runner user.
set -u
[ $# -gt 0 ] || { echo "usage: apt-install.sh [--no-install-recommends] package..." >&2; exit 2; }
opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o DPkg::Lock::Timeout=120)
for attempt in 1 2 3; do
  if sudo timeout -k 10 600 apt-get "${opts[@]}" update -q &&
     sudo DEBIAN_FRONTEND=noninteractive timeout -k 10 900 apt-get "${opts[@]}" install -y -q "$@"; then
    exit 0
  fi
  echo "::warning::apt-get attempt $attempt of 3 failed or timed out; retrying in 10 s"
  sleep 10
done
echo "::error::apt-get failed 3 times: could not install $*"
exit 1
