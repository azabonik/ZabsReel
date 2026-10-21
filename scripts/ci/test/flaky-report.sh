#!/usr/bin/env bash
# Stub harness for scripts/ci/flaky-report.sh: which issue calls it makes for a run's flaky-<version>.txt files. No
# network: a stub gh records each call in calls.txt, answers `issue list` from STUB_ISSUES (JSON) and fails the call
# named in STUB_FAIL (list, create or comment).
# Usage, from the repo root: bash scripts/ci/test/flaky-report.sh   (a few seconds; CI runs it in build-and-smoke)
# Prints one "ok"/"FAIL" line per check. Exit status: 0 when every check passed, else 1.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; SRC="$(dirname "$HERE")"
W="$(mktemp -d "${TMPDIR:-/tmp}/flaky-report-test-XXXXXX")" || exit 1
trap 'rm -rf "$W"' EXIT
mkdir -p "$W/bin"
cat > "$W/bin/gh" <<'EOF'
#!/usr/bin/env bash
# Stub gh: logs "<args>" to $STUB_STATE/calls.txt; issue list applies the --jq filter to $STUB_ISSUES with jq.
echo "$*" >> "$STUB_STATE/calls.txt"
case "$1 $2" in
  "issue list")
    [ "${STUB_FAIL:-}" = list ] && exit 1
    q=""; while [ $# -gt 0 ]; do [ "$1" = --jq ] && q="$2"; shift; done
    printf '%s' "${STUB_ISSUES:-[]}" | jq -r "$q" ;;
  "issue create")
    [ "${STUB_FAIL:-}" = create ] && exit 1
    while [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" "$STUB_STATE/intro.md"; shift; done
    echo "https://github.com/o/r/issues/${STUB_NEW:-41}" ;;
  "issue comment")
    [ "${STUB_FAIL:-}" = comment ] && exit 1
    while [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" "$STUB_STATE/comment.md"; shift; done ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$W/bin/gh"

PASS=0; FAILN=0
# run <case> [VAR=value ...]: flaky-report.sh on $W/<case>/in, output in $W/<case>/out.txt (last line "exit N").
run() {
  local c="$1"; shift
  mkdir -p "$W/$c/state"; : > "$W/$c/state/calls.txt"
  env -i PATH="/usr/bin:/bin" TMPDIR="$W/$c" GH="$W/bin/gh" STUB_STATE="$W/$c/state" GH_REPO=o/r \
    RUN_URL=https://github.com/o/r/actions/runs/7 RUN_ID=7 SHA=0123456789abcdef EVENT=push "$@" \
    timeout -k 5 30 bash "$SRC/flaky-report.sh" "$W/$c/in" > "$W/$c/out.txt" 2>&1
  echo "exit $?" >> "$W/$c/out.txt"
}
ok() {
  if eval "$2"; then echo "  ok   $1"; PASS=$((PASS+1))
  else echo "  FAIL $1   [$2]"; FAILN=$((FAILN+1)); sed 's/^/       | /' "$W/$c/out.txt" "$W/$c/state/calls.txt" 2>/dev/null | tail -20; fi
}
calls() { wc -l < "$W/$c/state/calls.txt"; }
called() { grep -c "^issue $1 " "$W/$c/state/calls.txt"; }
last() { tail -1 "$W/$c/out.txt"; }
body() { cat "$W/$c/state/comment.md"; }
flaky() { mkdir -p "$W/$c/in"; printf '%s\n' "${@:2}" > "$W/$c/in/flaky-$1.txt"; }
L71='FLAKY core-smoke-ffcompat (first exit 1, rerun 0)'
L90='FLAKY core-smoke-cutout (first exit 124, rerun 0)'
OPEN12='[{"number":12,"title":"Flaky suites in the FFmpeg matrix"}]'

c=nodir; echo "== $c: no flaky folder (the download found nothing)"; run $c
ok "exit 0" '[ "$(last)" = "exit 0" ]'
ok "no issue call" '[ "$(calls)" = 0 ]'

c=empty; echo "== $c: every version's file is empty"; mkdir -p "$W/$c/in"; for v in 4.4 6.1 9.0; do : > "$W/$c/in/flaky-$v.txt"; done; run $c
ok "exit 0" '[ "$(last)" = "exit 0" ]'
ok "no issue call" '[ "$(calls)" = 0 ]'
ok "says nothing flaked" 'grep -q "no flaky suites" "$W/$c/out.txt"'

c=nonflaky; echo "== $c: files hold other lines only"; flaky 7.1 'MATRIX shard 1/3: 17/17 passed' 'FAIL x (first exit 1, rerun 1)'; run $c
ok "exit 0, no issue call" '[ "$(last)" = "exit 0" ] && [ "$(calls)" = 0 ]'

c=existing; echo "== $c: an open tracking issue exists (9.0 has two flaky suites among other lines)"
flaky 9.0 'MATRIX shard 2/3: 17/17 passed' "$L90" "$L71"; flaky 7.1 "$L71"; : > "$W/$c/in/flaky-4.4.txt"
run $c STUB_ISSUES="$OPEN12"
ok "exit 0" '[ "$(last)" = "exit 0" ]'
ok "lists open issues once, creates none" '[ "$(called list)" = 1 ] && [ "$(called create)" = 0 ]'
ok "comments on #12 once" '[ "$(called comment)" = 1 ] && grep -q "^issue comment 12 --repo o/r " "$W/$c/state/calls.txt"'
ok "list asks for open issues only" 'grep -q "^issue list --repo o/r --state open " "$W/$c/state/calls.txt"'
ok "comment counts 3 suites" 'body | grep -q "^\*\*3 flaky suites\*\* in \[FFmpeg matrix run 7\](https://github.com/o/r/actions/runs/7) on \`0123456\` (push, "'
ok "lines carry their version, in version order" '[ "$(body | grep "^FFmpeg ")" = "$(printf "FFmpeg 7.1: %s\nFFmpeg 9.0: %s\nFFmpeg 9.0: %s" "$L71" "$L90" "$L71")" ]'
ok "keeps every FLAKY line of a file, drops its other lines" '[ "$(body | grep -c "^FFmpeg 9.0: ")" = 2 ] && ! body | grep -q "MATRIX shard"'
ok "comment names the logs" 'body | grep -q "ffmpeg-matrix-<version>"'

c=one; echo "== $c: one suite"; flaky 6.1 "$L71"; run $c STUB_ISSUES="$OPEN12"
ok "singular" 'body | grep -q "^\*\*1 flaky suite\*\* in "'

c=create; echo "== $c: no open tracking issue (a similar title does not count)"; flaky 8.0 "$L71"
run $c STUB_ISSUES='[{"number":3,"title":"Flaky suites in the FFmpeg matrix (old)"},{"number":5,"title":"flaky suites in the ffmpeg matrix"}]' STUB_NEW=41
ok "exit 0" '[ "$(last)" = "exit 0" ]'
ok "creates the issue with the exact title" '[ "$(called create)" = 1 ] && grep -q "^issue create --repo o/r --title Flaky suites in the FFmpeg matrix --body-file " "$W/$c/state/calls.txt"'
ok "the new issue explains itself" 'grep -q "reruns a failed suite once" "$W/$c/state/intro.md"'
ok "comments on the new #41" 'grep -q "^issue comment 41 " "$W/$c/state/calls.txt"'
ok "create comes before the comment" '[ "$(grep -n "^issue create" "$W/$c/state/calls.txt" | cut -d: -f1)" -lt "$(grep -n "^issue comment" "$W/$c/state/calls.txt" | cut -d: -f1)" ]'

c=twoopen; echo "== $c: two open issues with the title: the older one"; flaky 8.1 "$L71"
run $c STUB_ISSUES='[{"number":30,"title":"Flaky suites in the FFmpeg matrix"},{"number":9,"title":"Flaky suites in the FFmpeg matrix"}]'
ok "comments on #9 only" '[ "$(called comment)" = 1 ] && grep -q "^issue comment 9 " "$W/$c/state/calls.txt"'

for step in list create comment; do
  c=fail-$step; echo "== $c: the $step call fails"; flaky 7.1 "$L71"
  if [ $step = create ]; then run $c STUB_FAIL=$step; else run $c STUB_FAIL=$step STUB_ISSUES="$OPEN12"; fi
  ok "exit 1" '[ "$(last)" = "exit 1" ]'
  ok "says which call failed" 'grep -q "flaky-report: .*failed" "$W/$c/out.txt"'
done

c=badurl; echo "== $c: create prints no issue number"; flaky 7.1 "$L71"; run $c STUB_NEW=abc
ok "exit 1, no comment" '[ "$(last)" = "exit 1" ] && [ "$(called comment)" = 0 ]'

c=norepo; echo "== $c: GH_REPO unset with flaky lines"; flaky 7.1 "$L71"; run $c GH_REPO=
ok "exit non-zero, no issue call" '[ "$(last)" != "exit 0" ] && [ "$(calls)" = 0 ]'

echo "== $PASS checks passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
