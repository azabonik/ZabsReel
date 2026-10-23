#!/usr/bin/env bash
# Records the FLAKY lines of one run on main as a comment on one tracking issue (created when no open issue has that
# exact title). By default these are the FFmpeg matrix's flaky suites and the issue is "Flaky suites in the FFmpeg
# matrix"; the FLAKY_* variables below make it another workflow's report (judge.yml's: "Flaky judge tests (strace)").
# Every flaky line is investigated, so the issue keeps the record of when and where each one flaked.
# Usage: bash scripts/ci/flaky-report.sh <dir>
#   <dir> holds flaky-<name>.txt files, each with the FLAKY lines of one job (empty when none; the matrix's <name> is
#   the FFmpeg version). A missing <dir>, no files or only empty files means nothing flaked: no issue call is made.
# Environment: GH_REPO (owner/name, required when something flaked), RUN_URL, RUN_ID, SHA, EVENT (shown in the
#   comment), GH (the gh binary; default gh, which reads GH_TOKEN). For another report (each defaults to the FFmpeg
#   matrix's text): FLAKY_TITLE (the issue's title), FLAKY_PREFIX (a printf format put in front of each line, with %s
#   for the file's <name>; may be empty), FLAKY_WHAT (what one line names: "suite"), FLAKY_RUN (the run's name in the
#   comment: "FFmpeg matrix run"), FLAKY_NONE (the line printed when nothing flaked), FLAKY_LOGS (the comment's last
#   paragraph: where the logs are) and FLAKY_INTRO (the body of a new issue).
# Exit status: 0 when nothing flaked or the comment was posted; 1 when an issue call failed.
set -u
DIR="${1:?usage: flaky-report.sh <dir>}"
GH="${GH:-gh}"
TITLE="${FLAKY_TITLE-Flaky suites in the FFmpeg matrix}"
PREFIX="${FLAKY_PREFIX-FFmpeg %s: }"
WHAT="${FLAKY_WHAT-suite}"
RUN="${FLAKY_RUN-FFmpeg matrix run}"
NONE="${FLAKY_NONE-flaky-report: no flaky suites in this run}"
logs="Each suite failed once and passed its rerun. Logs: the run's \`ffmpeg-matrix-<version>\` artifact, \`m<version>-<shard>/logs/<suite>.log\` (first run) and \`<suite>.retry.log\` (rerun)."
LOGS="${FLAKY_LOGS-$logs}"
intro="The FFmpeg matrix (\`.github/workflows/ffmpeg-matrix.yml\`) reruns a failed suite once. A suite that passes its rerun is FLAKY: the job stays green, and each run on main (a push, the weekly run or a manual run) adds a comment here naming every flaky suite, with its FFmpeg version and the run. Every flaky suite is investigated; close this issue when none is left open."
INTRO="${FLAKY_INTRO-$intro}"
W="$(mktemp -d "${TMPDIR:-/tmp}/flaky-report-XXXXXX")" || exit 1
trap 'rm -rf "$W"' EXIT

# One line per FLAKY line, prefixed with its file's name (the matrix's: its FFmpeg version), names in sorted order.
: > "$W/lines"
while IFS= read -r f; do
  v="$(basename "$f" .txt)"; v="${v#flaky-}"
  # shellcheck disable=SC2059  # PREFIX is a printf format by design
  p="$(printf "$PREFIX" "$v")"
  grep '^FLAKY ' "$f" | while IFS= read -r l; do printf '%s%s\n' "$p" "$l"; done >> "$W/lines"
done < <(ls -d "$DIR"/flaky-*.txt 2>/dev/null | sort -V)
n="$(wc -l < "$W/lines")"
if [ "$n" -eq 0 ]; then echo "$NONE"; exit 0; fi
: "${GH_REPO:?flaky-report: GH_REPO is not set}"

{
  echo "**$n flaky $WHAT$([ "$n" -eq 1 ] || echo s)** in [$RUN ${RUN_ID:-?}](${RUN_URL:-}) on \`${SHA:0:7}\` (${EVENT:-?}, $(date -u +%Y-%m-%d))."
  echo
  echo '```'
  cat "$W/lines"
  echo '```'
  echo
  echo "$LOGS"
} > "$W/comment.md"

# The open issue with exactly this title; the listing is not the search index, so an issue made a moment ago is in it.
# A failed listing stops here: going on would open a second tracking issue.
open="$("$GH" issue list --repo "$GH_REPO" --state open --limit 200 --json number,title \
  --jq ".[] | select(.title == \"$TITLE\") | .number")" || { echo "flaky-report: listing the issues failed"; exit 1; }
num="$(printf '%s\n' "$open" | grep -E '^[0-9]+$' | sort -n | head -1)"
if [ -z "$num" ]; then
  printf '%s\n' "$INTRO" > "$W/intro.md"
  url="$("$GH" issue create --repo "$GH_REPO" --title "$TITLE" --body-file "$W/intro.md")" || { echo "flaky-report: creating the issue failed"; exit 1; }
  num="${url##*/}"
  case "$num" in ''|*[!0-9]*) echo "flaky-report: no issue number in '$url'"; exit 1;; esac
  echo "flaky-report: created issue #$num"
fi
"$GH" issue comment "$num" --repo "$GH_REPO" --body-file "$W/comment.md" > /dev/null || { echo "flaky-report: commenting on #$num failed"; exit 1; }
echo "flaky-report: $n flaky suite(s) recorded on #$num"
cat "$W/lines"
