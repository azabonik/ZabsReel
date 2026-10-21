#!/usr/bin/env bash
# Records the FFmpeg matrix's FLAKY suites of one run on main as a comment on one tracking issue, "Flaky suites in the
# FFmpeg matrix" (created when no open issue has that exact title). Every flaky suite is investigated, so the issue
# keeps the record of when and where each one flaked.
# Usage: bash scripts/ci/flaky-report.sh <dir>
#   <dir> holds flaky-<version>.txt files, each with the FLAKY lines of that version's job (empty when none). A missing
#   <dir>, no files or only empty files means nothing flaked: no issue call is made.
# Environment: GH_REPO (owner/name, required when something flaked), RUN_URL, RUN_ID, SHA, EVENT (shown in the
#   comment), GH (the gh binary; default gh, which reads GH_TOKEN).
# Exit status: 0 when nothing flaked or the comment was posted; 1 when an issue call failed.
set -u
DIR="${1:?usage: flaky-report.sh <dir>}"
GH="${GH:-gh}"
TITLE='Flaky suites in the FFmpeg matrix'
W="$(mktemp -d "${TMPDIR:-/tmp}/flaky-report-XXXXXX")" || exit 1
trap 'rm -rf "$W"' EXIT

# One line per flaky suite, prefixed with its FFmpeg version, versions in sorted order.
: > "$W/lines"
while IFS= read -r f; do
  v="$(basename "$f" .txt)"; v="${v#flaky-}"
  grep '^FLAKY ' "$f" | sed "s/^/FFmpeg $v: /" >> "$W/lines"
done < <(ls -d "$DIR"/flaky-*.txt 2>/dev/null | sort -V)
n="$(wc -l < "$W/lines")"
if [ "$n" -eq 0 ]; then echo "flaky-report: no flaky suites in this run"; exit 0; fi
: "${GH_REPO:?flaky-report: GH_REPO is not set}"

{
  echo "**$n flaky suite$([ "$n" -eq 1 ] || echo s)** in [FFmpeg matrix run ${RUN_ID:-?}](${RUN_URL:-}) on \`${SHA:0:7}\` (${EVENT:-?}, $(date -u +%Y-%m-%d))."
  echo
  echo '```'
  cat "$W/lines"
  echo '```'
  echo
  echo "Each suite failed once and passed its rerun. Logs: the run's \`ffmpeg-matrix-<version>\` artifact, \`m<version>-<shard>/logs/<suite>.log\` (first run) and \`<suite>.retry.log\` (rerun)."
} > "$W/comment.md"

# The open issue with exactly this title; the listing is not the search index, so an issue made a moment ago is in it.
# A failed listing stops here: going on would open a second tracking issue.
open="$("$GH" issue list --repo "$GH_REPO" --state open --limit 200 --json number,title \
  --jq ".[] | select(.title == \"$TITLE\") | .number")" || { echo "flaky-report: listing the issues failed"; exit 1; }
num="$(printf '%s\n' "$open" | grep -E '^[0-9]+$' | sort -n | head -1)"
if [ -z "$num" ]; then
  cat > "$W/intro.md" <<'EOF'
The FFmpeg matrix (`.github/workflows/ffmpeg-matrix.yml`) reruns a failed suite once. A suite that passes its rerun is FLAKY: the job stays green, and each run on main (push or the weekly run) adds a comment here naming every flaky suite, with its FFmpeg version and the run. Every flaky suite is investigated; close this issue when none is left open.
EOF
  url="$("$GH" issue create --repo "$GH_REPO" --title "$TITLE" --body-file "$W/intro.md")" || { echo "flaky-report: creating the issue failed"; exit 1; }
  num="${url##*/}"
  case "$num" in ''|*[!0-9]*) echo "flaky-report: no issue number in '$url'"; exit 1;; esac
  echo "flaky-report: created issue #$num"
fi
"$GH" issue comment "$num" --repo "$GH_REPO" --body-file "$W/comment.md" > /dev/null || { echo "flaky-report: commenting on #$num failed"; exit 1; }
echo "flaky-report: $n flaky suite(s) recorded on #$num"
cat "$W/lines"
