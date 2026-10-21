#!/usr/bin/env bash
# Stub harness for the FFmpeg matrix's rerun logic (scripts/ci/matrix-job.sh and run-matrix.sh): reruns, the merge of
# the rerun rows, FLAKY lines and annotations, MATRIX_RETRY=0, the suite floor, the download tripwire and the guard
# count. No suite, FFmpeg, npm or server runs: bin/ holds stubs for npx, ffmpeg, ffprobe and pactl, and the checkout
# is a temporary folder of empty files named in checkout.txt. Needs bash, coreutils, procps (ps) and Linux /proc.
# Usage, from the repo root: bash scripts/ci/test/matrix-retry.sh   (about a minute; CI runs it in build-and-smoke)
# Each case runs copies of the scripts (with the floor fixed at the fake checkout's 60) in a temporary folder, removed
# at exit. Prints one "ok"/"FAIL" line per check; on a failed check, the end of that case's output.
# Exit status: 0 when every check passed, else 1.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; SRC="$(dirname "$HERE")"
W="$(mktemp -d "${TMPDIR:-/tmp}/matrix-retry-test-XXXXXX")" || exit 1
trap 'rm -rf "$W"' EXIT
mkdir -p "$W/ci" "$W/wt" "$W/media" "$W/runs"
cp "$SRC"/run-matrix.sh "$SRC"/matrix-job.sh "$SRC"/check-ffmpeg.sh "$W/ci/" || exit 1
echo 60 > "$W/ci/matrix-suites.txt"
# A copy whose suite timeout is 3 s (for a real `timeout` kill); nothing else differs.
mkdir -p "$W/ci-fast"; cp "$W"/ci/* "$W/ci-fast/"; sed -i 's/timeout -k 10 900 npx/timeout -k 2 3 npx/' "$W/ci-fast/run-matrix.sh"
[ "$(grep -c 'timeout -k 2 3 npx' "$W/ci-fast/run-matrix.sh")" = 1 ] || { echo "FAIL the suite timeout line in run-matrix.sh changed (ci-fast copy)"; exit 1; }
grep -v '^#' "$HERE/checkout.txt" | while IFS= read -r f; do mkdir -p "$W/wt/$(dirname "$f")"; : > "$W/wt/$f"; done
for f in a.mp4 b.mp4 c640.mp4 m.mp3; do : > "$W/media/$f"; done
BIN="$HERE/bin"

# job <case> [VAR=value ...]: matrix-job.sh (CI=<dir> picks the scripts' copy) on the fake checkout, output in
# runs/<case>/out.txt (its last line "exit N"). OUTDIR=<dir> reuses an outdir instead of a fresh runs/<case>/job.
job() {
  local c="$1" R; shift
  R="$W/runs/$c"; rm -rf "$R"; mkdir -p "$R/state" "$R/home" "$R/tmp"
  env -i HOME="$R/home" REAL_HOME="$R/home" PATH="$BIN:/usr/bin:/bin" TMPDIR="$R/tmp" LANG=C.UTF-8 \
    AIVE_FFMPEG="$BIN/ffmpeg" AIVE_FFPROBE="$BIN/ffprobe" FF_SOURCE=btbn SKIP_BUILD=1 JOBS=4 \
    STUB_STATE="$R/state" GITHUB_STEP_SUMMARY="$R/summary.md" GITHUB_ACTIONS=true "$@" \
    timeout -k 5 120 bash "${CI:-$W/ci}/matrix-job.sh" "$W/wt" "${OUTDIR:-$R/job}" "$W/media" 6.1 > "$R/out.txt" 2>&1
  echo "exit $?" >> "$R/out.txt"
}
PASS=0; FAILN=0
# ok <label> <check>: the check runs in this shell with $c the current case.
ok() {
  if eval "$2"; then echo "  ok   $1"; PASS=$((PASS+1))
  else
    echo "  FAIL $1   [$2]"; FAILN=$((FAILN+1))
    # Indented, so a stub run's ::warning / ::error lines do not become annotations of the real CI job.
    tail -25 "$W/runs/$c/out.txt" 2>/dev/null | sed 's/^/       | /'
  fi
}
J() { echo "$W/runs/$c/job"; }
rows() { cat "$W/runs/$c"/job/m6.1-*/results-*.tsv | wc -l; }
dups() { cat "$W/runs/$c"/job/m6.1-*/results-*.tsv | cut -f2 | sort | uniq -d | wc -l; }
out() { cat "$W/runs/$c/out.txt"; }
att() { cat "$W/runs/$c/state/n/$1" 2>/dev/null || echo 0; }
retrylog() { ls "$W/runs/$c"/job/m6.1-*/logs/"$1".retry.log >/dev/null 2>&1; }
leftover() { ls "$W/runs/$c"/job/m6.1-*/rerun-*.tsv "$W/runs/$c"/job/m6.1-*/results-*.tsv.tmp 2>/dev/null | wc -l; }
MX="(ffmpeg: n6.1.3-20250831)"

c=clean; echo "== $c: nothing fails"; job $c
ok "job exit 0" '[ "$(out | tail -1)" = "exit 0" ]'
ok "MATRIX lines unchanged (no flaky suffix)" '[ "$(out | grep -c "^MATRIX shard [123]/3: \([0-9]*\)/\1 passed (ffmpeg")" = 3 ]'
ok "60 rows, floor met" 'out | grep -qx "suites 6.1: 60 with a result (floor 60)"'
ok "flaky 0" 'out | grep -q "^flaky 6.1: 0 "'
ok "no retry logs, no leftovers" '[ -z "$(ls $(J)/m6.1-*/logs/*.retry.log 2>/dev/null)" ] && [ "$(leftover)" = 0 ]'

c=flaky; echo "== $c: fail once (pool suite in each shard, brand, smoke-web, ramps-baseline, settle), exit 124 once (smoke-media, motion-media)"
job $c STUB_FAIL_ONCE="core-smoke-ffcompat core-smoke-cutout core-smoke-cuts core-smoke-brand desktop-smoke-web core-smoke-ramps-baseline motion-smoke-motion-settle" STUB_HANG_ONCE="core-smoke-media motion-smoke-motion-media"
ok "job exit 0" '[ "$(out | tail -1)" = "exit 0" ]'
ok "MATRIX 17/17 2 flaky, 17/17 1 flaky, 26/26 6 flaky" 'out | grep -qxF "MATRIX shard 1/3: 17/17 passed, 2 flaky $MX" && out | grep -qxF "MATRIX shard 2/3: 17/17 passed, 1 flaky $MX" && out | grep -qxF "MATRIX shard 3/3: 26/26 passed, 6 flaky $MX"'
ok "FLAKY lines in log: 9, exact format" '[ "$(out | grep -c "^FLAKY [a-z0-9-]* (first exit \(1\|124\), rerun 0)$")" = 9 ]'
ok "FLAKY core-smoke-media (first exit 124, rerun 0)" 'out | grep -qx "FLAKY core-smoke-media (first exit 124, rerun 0)"'
ok "FLAKY motion-smoke-motion-settle (first exit 1, rerun 0)" 'out | grep -qx "FLAKY motion-smoke-motion-settle (first exit 1, rerun 0)"'
ok "FLAKY lines in summary: 9" '[ "$(grep -c "^FLAKY " "$W/runs/$c/summary.md")" = 9 ]'
ok "warning annotations: 9" '[ "$(out | grep -c "^::warning title=FFmpeg 6.1: flaky suite::FLAKY ")" = 9 ]'
ok "warning annotation names the suite's two logs" 'out | grep -qxF "::warning title=FFmpeg 6.1: flaky suite::FLAKY core-smoke-brand (first exit 1, rerun 0) (logs in the artifact: m6.1-3/logs/core-smoke-brand.log, m6.1-3/logs/core-smoke-brand.retry.log)"'
ok "rows 60, no duplicate names, floor met" '[ "$(rows)" = 60 ] && [ "$(dups)" = 0 ] && out | grep -qx "suites 6.1: 60 with a result (floor 60)"'
ok "flaky-k.tsv rows 2+1+6, flaky 6.1: 9" '[ "$(cat $(J)/m6.1-1/flaky-1.tsv | wc -l)$(cat $(J)/m6.1-2/flaky-2.tsv | wc -l)$(cat $(J)/m6.1-3/flaky-3.tsv | wc -l)" = 216 ] && out | grep -q "^flaky 6.1: 9 "'
ok "both logs kept for all 9 (first says FAILED/hung, retry says ok)" 'n=0; for f in $(J)/m6.1-*/logs/*.retry.log; do b="${f%.retry.log}.log"; grep -q "FAILED first run\|hung" "$b" && grep -q "stub ok .* attempt 2" "$f" && n=$((n+1)); done; [ "$n" = 9 ]'
ok "final rows of the 9 are the reruns' (exit 0, attempt 2)" '[ "$(cat $(J)/m6.1-*/results-*.tsv | grep -c "^0	.*attempt 2$")" = 9 ]'
ok "9 suites ran twice, 51 once" '[ "$(cat "$W/runs/$c"/state/n/* | sort | uniq -c | tr -s " " | tr "\n" ";")" = " 51 1; 9 2;" ]'
ok "shard 3: every rerun after settle's first run (6 reruns, first one later than settle 1)" 'awk "\$1==\"motion-smoke-motion-settle\" && \$2==1 {s=NR} \$2==2 && \$1 !~ /ffcompat|cutout|core-smoke-media\$/ {n++; if (!m || NR<m) m=NR} END {exit !(s && n==6 && m>s)}" "$W/runs/$c/state/order.log"'
ok "env of each rerun == env of its first run (motion scratch dir name aside)" 'bad=0; for f in "$W/runs/$c"/state/env/*.2; do n="${f%.2}"; diff -q <(sed -E "s/zr-motion-[A-Za-z0-9]{6}/zr-motion-X/g" "$n.1") <(sed -E "s/zr-motion-[A-Za-z0-9]{6}/zr-motion-X/g" "$f") >/dev/null || bad=1; done; [ $bad = 0 ]'
ok "ramps-baseline rerun has RAMPS_BASELINE_REF=dd38598" 'grep -qx RAMPS_BASELINE_REF=dd38598 "$W/runs/$c/state/env/core-smoke-ramps-baseline.2"'
ok "motion rerun in a fresh scratch HOME, FFmpeg bin first on PATH" 'e="$W/runs/$c/state/env/motion-smoke-motion-settle"; grep -q "^HOME=.*/zr-motion-.*/home$" "$e.2" && [ "$(grep "^HOME=" "$e.1")" != "$(grep "^HOME=" "$e.2")" ] && grep -qF "PATH=$BIN:" "$e.2"'
ok "no leftover rerun files" '[ "$(leftover)" = 0 ]'

c=twice; echo "== $c: fail twice (ffcompat, settle), fail once (brand)"
job $c STUB_FAIL_TWICE="core-smoke-ffcompat motion-smoke-motion-settle" STUB_FAIL_ONCE="core-smoke-brand"
ok "job exit 1" '[ "$(out | tail -1)" = "exit 1" ]'
ok "MATRIX 16/17; 25/26, 1 flaky" 'out | grep -qxF "MATRIX shard 1/3: 16/17 passed $MX" && out | grep -qxF "MATRIX shard 3/3: 25/26 passed, 1 flaky $MX"'
ok "FAIL lines carry both exits" 'out | grep -qx "FAIL core-smoke-ffcompat (first exit 1, rerun 1): stub core-smoke-ffcompat: FAILED (attempt 2)" && out | grep -qx "FAIL motion-smoke-motion-settle (first exit 1, rerun 1): stub motion-smoke-motion-settle: FAILED (attempt 2)"'
ok "FAIL lines in summary" '[ "$(grep -c "^FAIL " "$W/runs/$c/summary.md")" = 2 ]'
ok "brand still FLAKY" 'out | grep -qx "FLAKY core-smoke-brand (first exit 1, rerun 0)"'
ok "twice-failed not in flaky-k.tsv" '! grep -q "ffcompat\|settle" $(J)/m6.1-*/flaky-*.tsv'
ok "both logs kept for the twice-failed" 'retrylog core-smoke-ffcompat && retrylog motion-smoke-motion-settle && ls $(J)/m6.1-1/logs/core-smoke-ffcompat.log >/dev/null'
ok "ran exactly twice" '[ "$(att core-smoke-ffcompat)$(att motion-smoke-motion-settle)" = 22 ]'
ok "rows 60, no duplicates" '[ "$(rows)" = 60 ] && [ "$(dups)" = 0 ]'

c=hang; echo "== $c: exit 124 once (cutout); exit 124 twice is covered by fail-twice"
job $c STUB_HANG_ONCE="core-smoke-cutout"
ok "job exit 0, FLAKY core-smoke-cutout (first exit 124, rerun 0)" '[ "$(out | tail -1)" = "exit 0" ] && out | grep -qx "FLAKY core-smoke-cutout (first exit 124, rerun 0)" && out | grep -qxF "MATRIX shard 2/3: 17/17 passed, 1 flaky $MX"'

c=realtimeout; echo "== $c: a real timeout kill (copy with a 3 s suite timeout): cutout sleeps 60 s on its first run"
CI="$W/ci-fast" job $c STUB_SLEEP_ONCE="core-smoke-cutout"
ok "job exit 0, FLAKY core-smoke-cutout (first exit 124, rerun 0)" '[ "$(out | tail -1)" = "exit 0" ] && out | grep -qx "FLAKY core-smoke-cutout (first exit 124, rerun 0)"'
ok "first log ends at the sleep" '[ "$(tail -1 $(J)/m6.1-2/logs/core-smoke-cutout.log)" = "stub core-smoke-cutout: sleeping" ]'

c=lostrow; echo "== $c: mcp-smoke's run_one shell is killed (no result row), ffcompat fails once"
job $c STUB_KILL="mcp-smoke" STUB_FAIL_ONCE="core-smoke-ffcompat"
ok "job exit 1" '[ "$(out | tail -1)" = "exit 1" ]'
ok "FAIL mcp-smoke (no result row...)" 'out | grep -qx "FAIL mcp-smoke (no result row: its run ended before it wrote one)"'
ok "MATRIX shard 3/3: 25/26 passed" 'out | grep -qxF "MATRIX shard 3/3: 25/26 passed $MX"'
ok "not rerun (one attempt, no retry log)" '[ "$(att mcp-smoke)" = 1 ] && ! retrylog mcp-smoke'
ok "the suites after it in the serial block still ran" '[ "$(att motion-smoke-motion-settle)" = 1 ]'
ok "floor check fails (59 < 60, ffcompat's rerun row not counted on top) with ::error" 'out | grep -qx "suites 6.1: 59 with a result, fewer than the 60 in scripts/ci/matrix-suites.txt" && out | grep -q "^::error title=FFmpeg 6.1: suites missing::"'

c=lostpool; echo "== $c: a pool suite's run_one shell is killed (xargs stops: rows lost)"
job $c STUB_KILL="core-smoke-ffcompat"
ok "job exit 1" '[ "$(out | tail -1)" = "exit 1" ]'
ok "FAIL core-smoke-ffcompat (no result row...)" 'out | grep -qx "FAIL core-smoke-ffcompat (no result row: its run ended before it wrote one)"'
ok "lost rows not rerun (no RERUN line in shard 1, no retry logs)" '! sed -n "/^--- shard 1/,/^--- shard 2/p" "$W/runs/$c/out.txt" | grep -q "^RERUN" && [ -z "$(ls $(J)/m6.1-1/logs/*.retry.log 2>/dev/null)" ]'

c=rerunlost; echo "== $c: core-smoke-unc fails, then its rerun's run_one shell is killed"
job $c STUB_KILL_RERUN="core-smoke-unc"
ok "job exit 1" '[ "$(out | tail -1)" = "exit 1" ]'
ok "FAIL core-smoke-unc (first exit 1, rerun: no result row)" 'out | grep -qx "FAIL core-smoke-unc (first exit 1, rerun: no result row): stub core-smoke-unc: FAILED first run"'
ok "rows 60 (the first row kept), no duplicates" '[ "$(rows)" = 60 ] && [ "$(dups)" = 0 ]'
ok "shard 3 still finished (MATRIX line)" 'out | grep -qxF "MATRIX shard 3/3: 25/26 passed $MX"'

c=strict; echo "== $c: MATRIX_RETRY=0, fail once (ffcompat, brand)"
job $c MATRIX_RETRY=0 STUB_FAIL_ONCE="core-smoke-ffcompat core-smoke-brand"
ok "job exit 1" '[ "$(out | tail -1)" = "exit 1" ]'
ok "FAIL lines as before (exit 1)" 'out | grep -qx "FAIL core-smoke-ffcompat (exit 1): stub core-smoke-ffcompat: FAILED first run" && out | grep -qx "FAIL core-smoke-brand (exit 1): stub core-smoke-brand: FAILED first run"'
ok "no flaky, no RERUN, no retry logs, one attempt each" '! out | grep -q "flaky (ffmpeg\|^FLAKY\|^RERUN" && [ -z "$(ls $(J)/m6.1-*/logs/*.retry.log 2>/dev/null)" ] && [ "$(att core-smoke-ffcompat)$(att core-smoke-brand)" = 11 ]'
ok "MATRIX 16/17 and 25/26" 'out | grep -qxF "MATRIX shard 1/3: 16/17 passed $MX" && out | grep -qxF "MATRIX shard 3/3: 25/26 passed $MX"'

c=dlrerun; echo "== $c: motion-media and cuts fail once, their reruns download into ~/.aive"
job $c STUB_DL_RERUN="motion-smoke-motion-media core-smoke-cuts"
ok "job exit 1 although both are FLAKY" '[ "$(out | tail -1)" = "exit 1" ] && out | grep -qx "FLAKY core-smoke-cuts (first exit 1, rerun 0)" && out | grep -qx "FLAKY motion-smoke-motion-media (first exit 1, rerun 0)"'
ok "DOWNLOAD lines for both reruns" 'out | grep -q "^DOWNLOAD new file in motion-smoke-motion-media (rerun): home/.aive/models/new.bin$" && out | grep -q "^DOWNLOAD new file .*/home/.aive/models/new.bin$"'

c=guard; echo "== $c: ffcompat (fails once) and cutout print one [ffmpeg-guard] line per run"
job $c STUB_GUARD="core-smoke-ffcompat core-smoke-cutout" STUB_FAIL_ONCE="core-smoke-ffcompat"
ok "job exit 0" '[ "$(out | tail -1)" = "exit 0" ]'
ok "guard lines from first runs only, the rerun's apart" 'out | grep -qx "guard lines 6.1: 2 (reruns: 1 more)"'

c=stale-1; echo "== stale: a reused outdir; run 1's cuts rerun logged a whisper download, run 2 is clean"
D="$W/runs/stale-out"
OUTDIR="$D" job $c STUB_WHISPER_RERUN="core-smoke-cuts"
ok "run 1: job exit 1, DOWNLOAD whisper in core-smoke-cuts.retry" '[ "$(out | tail -1)" = "exit 1" ] && out | grep -qx "DOWNLOAD whisper in core-smoke-cuts.retry"'
c=stale-2; OUTDIR="$D" job $c
ok "run 2: job exit 0, no DOWNLOAD line" '[ "$(out | tail -1)" = "exit 0" ] && ! out | grep -q "^DOWNLOAD"'
ok "run 2: run 1's core-smoke-cuts.retry.log removed" '[ -z "$(ls "$D"/m6.1-*/logs/core-smoke-cuts.retry.log 2>/dev/null)" ]'

c=unsharded; echo "== $c: run-matrix.sh alone, no SHARD, ffcompat fails once"
R="$W/runs/$c"; rm -rf "$R"; mkdir -p "$R/state" "$R/home" "$R/tmp"
env -i HOME="$R/home" REAL_HOME="$R/home" PATH="$BIN:/usr/bin:/bin" TMPDIR="$R/tmp" LANG=C.UTF-8 AIVE_FFMPEG="$BIN/ffmpeg" AIVE_FFPROBE="$BIN/ffprobe" \
  SKIP_BUILD=1 JOBS=4 STUB_STATE="$R/state" STUB_FAIL_ONCE="core-smoke-ffcompat" timeout -k 5 120 bash "$W/ci/run-matrix.sh" "$W/wt" "$R/out" "$W/media" > "$R/out.txt" 2>&1
echo "exit $?" >> "$R/out.txt"
ok "exit 0; MATRIX: 60/60 passed, 1 flaky; results.tsv 60 rows; flaky.tsv 1 row" '[ "$(out | tail -1)" = "exit 0" ] && out | grep -qxF "MATRIX: 60/60 passed, 1 flaky $MX" && [ "$(wc -l < "$R/out/results.tsv")" = 60 ] && [ "$(wc -l < "$R/out/flaky.tsv")" = 1 ]'

echo "== $PASS checks passed, $FAILN failed"
[ "$FAILN" = 0 ]
