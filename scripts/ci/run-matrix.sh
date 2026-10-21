#!/usr/bin/env bash
# Full offline regression matrix for a ZedMix checkout (one shard of it), as the local matrix kit's run-matrix.sh runs
# it: the same suites, arguments and rules. The FFmpeg matrix workflow runs it through scripts/ci/matrix-job.sh.
# Usage: run-matrix.sh <checkout> <outdir> <media-dir>
#   <media-dir> holds a.mp4, b.mp4, c640.mp4 and m.mp3 (scripts/ci/make-media.sh makes them); they are copied into
#   <outdir>/media, and the suites get the copies.
#   env: AIVE_FFMPEG / AIVE_FFPROBE  run against another FFmpeg build (the executor honours them); unset = PATH ffmpeg
#        INCLUDE_DOWNLOADS=1         also run the download-dependent smokes (models cache in ~/.aive/models)
#        INCLUDE_ADDON_REAL=1        also run smoke-addon-real (the graphics add-on's full offline install)
#        SKIP_BUILD=1                skip `npm run build`
#        JOBS=<n>                    parallel suites (default 6)
#        SHARD=k/n                   run only every n-th suite starting at k (1-based); the port-bound
#                                    suites and the motion media + settle smokes run in shard n/n.
#                                    Results: <outdir>/results-k.tsv. Use shards when one call might
#                                    exceed 10 minutes (e.g. a loaded machine).
#        REAL_HOME=<dir>             the home whose read-only caches (~/.aive/clip, ~/.aive/whisper) a scratch HOME
#                                    reuses; default: the user's home in the passwd database, else $HOME
#        MATRIX_RETRY=0              a strict run: no reruns, every failed suite counts (default: each failed suite
#                                    is rerun once, see "Reruns" below)
# Writes <outdir>/results.tsv (exit<TAB>name<TAB>last line; one row per suite, its rerun's when it was rerun),
# <outdir>/logs/<name>.log (and <name>.retry.log for a rerun), <outdir>/flaky.tsv (the first-run rows of the suites
# whose rerun passed) and <outdir>/queued-k.txt (the names of the shard's suites). With SHARD=k/n: results-k.tsv and
# flaky-k.tsv.
# Prints a MATRIX line (passed/queued, and "N flaky" when a rerun passed), then a FAIL line per failed suite and a
# "FLAKY <name> (first exit N, rerun 0)" line per suite that failed once and passed its rerun.
# Exit status: number of failed suites (a FLAKY suite counts as passed), a queued suite with no result row included
# (0 = all green; capped at 95, as 96-99 mean the setup failed). Runs in the foreground; ~5-8 min on a 24-thread
# machine.
# Each suite runs under `timeout -k 10 900`: a hang shows as exit 124/137 (and is rerun once), not a stalled matrix.
set -u
WT="$(cd "$1" && pwd)"; MEDIA="${3:?usage: run-matrix.sh <checkout> <outdir> <media-dir>}"; JOBS="${JOBS:-6}"
# <outdir> made absolute: the suites run from the checkout and write their logs there.
mkdir -p "$2" && OUT="$(cd "$2" && pwd)" || exit 99
# A scratch HOME (not the real one): TMPDIR goes in a fresh folder next to HOME, removed at exit, so neither holds the
# other (the executor treats os.tmpdir() as its own, which breaks smoke-safepath's "user's home" row with HOME under
# /tmp). When the folder next to HOME has a long path it goes under /tmp instead (still apart from HOME): tsx and
# Electron make unix sockets in TMPDIR, whose paths may be at most 107 bytes, and the motion block below nests two
# more folders in it. Nothing is downloaded into the scratch HOME: the CLIP model is the real home's cache, read only
# (ensureClipModel downloads only a missing file), or CLIP is off when that cache is incomplete; a caller's
# AIVE_CLIP_DIR / AIVE_CLIP_DISABLE is kept. npm makes no update check.
# On a GitHub runner HOME is the real home (as in ci.yml), so this block is skipped there. That home has no CLIP model
# or Whisper to lend, so the workflow turns both off itself (AIVE_CLIP_DISABLE=1; AIVE_WHISPER_BIN / AIVE_WHISPER_MODEL
# name missing files, so smoke-media's optional transcription step is skipped, not downloaded), and npm's update check
# too. matrix-job.sh fails the job when a suite downloads anything.
REAL_HOME="${REAL_HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"; REAL_HOME="${REAL_HOME:-$HOME}"
if [ "$(readlink -f "$HOME")" != "$(readlink -f "$REAL_HOME")" ]; then
  P="$(dirname "$(readlink -f "$HOME")")"
  { [ "${#P}" -le 48 ] && [ -w "$P" ]; } || P=/tmp
  KIT_TMP="$(mktemp -d "$P/zr-tmp-XXXXXX")" || { echo "no TMPDIR in $P"; exit 97; }
  trap 'rm -rf "$KIT_TMP"' EXIT
  export TMPDIR="$KIT_TMP"
  if [ -z "${AIVE_CLIP_DIR:-}${AIVE_CLIP_DISABLE:-}" ]; then
    C="$REAL_HOME/.aive/clip"
    if [ -f "$C/vision.onnx" ] && [ -f "$C/text.onnx" ] && [ -f "$C/merges.txt" ] && [ -f "$C/vocab.json" ]; then
      export AIVE_CLIP_DIR="$C"
    else
      export AIVE_CLIP_DISABLE=1
    fi
  fi
  # whisper: the real home's whisper.cpp binaries and base.en model, read only (setup.ts downloads only what is
  # missing); without them a scratch HOME made smoke-unc-e2e's core fetch ~155 MB from github.com and huggingface.co.
  if [ -z "${AIVE_WHISPER_DIR:-}" ]; then
    W="$REAL_HOME/.aive/whisper"
    if [ -f "$W/models/ggml-base.en.bin" ] && ls "$W"/bin/*whisper* >/dev/null 2>&1; then export AIVE_WHISPER_DIR="$W"; fi
  fi
  export NPM_CONFIG_UPDATE_NOTIFIER=false
  echo "scratch HOME $HOME: TMPDIR=$TMPDIR${AIVE_CLIP_DIR:+ AIVE_CLIP_DIR=$AIVE_CLIP_DIR}${AIVE_CLIP_DISABLE:+ AIVE_CLIP_DISABLE=$AIVE_CLIP_DISABLE}${AIVE_WHISPER_DIR:+ AIVE_WHISPER_DIR=$AIVE_WHISPER_DIR}"
fi
mkdir -p "$OUT/logs" "$OUT/media"
for f in a.mp4 b.mp4 m.mp3 c640.mp4; do
  [ -f "$OUT/media/$f" ] || cp -n "$MEDIA/$f" "$OUT/media/$f" 2>/dev/null
  [ -f "$OUT/media/$f" ] || { echo "no $f in $MEDIA (make it with scripts/ci/make-media.sh)"; exit 96; }
done
M="$OUT/media"
cd "$WT" || exit 99
if [ -z "${SKIP_BUILD:-}" ]; then
  npm run build > "$OUT/logs/_build.log" 2>&1 || { echo "BUILD FAILED (see $OUT/logs/_build.log)"; tail -20 "$OUT/logs/_build.log"; exit 98; }
fi
DOWNLOADS="captions reframe textedit motion bundled animtext matte"
argsfor() {
  case "$1" in
    smoke-color|smoke-effects|smoke-media|smoke-text|smoke-toolsurface|smoke-transform|smoke-transitions|smoke) echo "$M/a.mp4 $M/b.mp4" ;;
    smoke-export) echo "$M/a.mp4" ;;
    smoke-lut-stab) echo "$M/a.mp4 $M/c640.mp4" ;;
    smoke-music) echo "$M/a.mp4 $M/b.mp4 $M/m.mp3" ;;
    *) echo "" ;;
  esac
}
SK=1; SN=1
if [ -n "${SHARD:-}" ]; then SK="${SHARD%/*}"; SN="${SHARD#*/}"; fi
# Per-shard list files: shards may run concurrently in one outdir.
LIST="$OUT/list-$SK.txt"; : > "$LIST"
# Suites that bind fixed loopback ports (5030-5039): run one at a time in the last shard, never in parallel.
PORTBOUND="addon brand chromeguard unc"
for f in packages/core/scripts/smoke*.ts; do
  n="$(basename "$f" .ts)"; short="${n#smoke-}"
  if [ -z "${INCLUDE_DOWNLOADS:-}" ] && [[ " $DOWNLOADS " == *" $short "* ]]; then continue; fi
  # smoke-addon-real: the graphics add-on's full offline install of four platforms plus its own renders; opt-in.
  if [ "$short" = addon-real ] && [ -z "${INCLUDE_ADDON_REAL:-}" ]; then continue; fi
  if [[ " $PORTBOUND " == *" $short "* ]]; then continue; fi
  echo "core-$n|$f $(argsfor "$n")" >> "$LIST"
done
for f in apps/desktop/scripts/smoke-composite.ts apps/desktop/scripts/smoke-savename.ts; do
  [ -f "$f" ] && echo "desktop-$(basename "$f" .ts)|$f" >> "$LIST"
done
awk -v k="$SK" -v n="$SN" '((NR-1) % n) == (k-1)' "$LIST" > "$LIST.shard"
# The names of the suites queued for this shard (the serial ones below add theirs as they start): a queued suite with
# no row in the results (its run died before it wrote one) counts as a failure.
QF="$OUT/queued-$SK.txt"; cut -d'|' -f1 "$LIST.shard" > "$QF"
RES="$OUT/results.tsv"; [ "$SN" -gt 1 ] && RES="$OUT/results-$SK.tsv"
FLK="$OUT/flaky.tsv"; [ "$SN" -gt 1 ] && FLK="$OUT/flaky-$SK.tsv"
RR="$OUT/rerun-$SK.tsv"
: > "$RES"; : > "$FLK"
export RES RR
# run_one <name|cmd> [.retry]: one run of a suite; its output goes to logs/<name>.log and its row to $RES, or for a
# rerun to logs/<name>.retry.log and $RR (the reruns' rows, merged into $RES below).
run_one() {
  local name="${1%%|*}" cmd="${1#*|}" log="$OUT/logs/${1%%|*}${2:-}.log" rows="$RES"
  [ -z "${2:-}" ] || rows="$RR"
  timeout -k 10 900 npx tsx $cmd > "$log" 2>&1
  local rc=$?
  printf '%s\t%s\t%s\n' "$rc" "$name" "$(tail -1 "$log" | tr '\t' ' ' | cut -c1-160)" >> "$rows"
}
export -f run_one; export OUT
# Each queued suite's name|cmd: the pool's from the shard list, the serial ones' added by queue as they start.
declare -A SPEC=()
while IFS= read -r l; do SPEC["${l%%|*}"]="$l"; done < "$LIST.shard"
queue() { echo "${1%%|*}" >> "$QF"; SPEC["${1%%|*}"]="$1"; }
FFBIN=/usr/bin; [ -n "${AIVE_FFMPEG:-}" ] && FFBIN="$(dirname "$AIVE_FFMPEG")"
# run_suite <name> [.retry]: a serial run of a queued suite in a shell of its own, with the environment that suite
# gets on its first run and on its rerun alike.
# The motion renderer's media and settle smokes (Electron, offscreen): their fixtures and reference decodes run the
# `ffmpeg` on PATH, so PATH starts with this version's bin (FFBIN: the dir of AIVE_FFMPEG; system /usr/bin when it is
# unset, e.g. 4.4), and the core gets the same build. Each run is muted, with a fresh scratch HOME / USERPROFILE /
# XDG_CONFIG_HOME / AIVE_DATA_DIR and TMPDIR next to that HOME (removed after; npm's update notice is off, so the
# results line is the smoke's last line). Needs strace (media M5, M6).
# Download tripwire for these two (their HOME is not the one matrix-job.sh watches): the files that appeared under the
# scratch HOME's .aive and the scratch AIVE_DATA_DIR, which start empty, go to <outdir>/motion-new-files.txt before the
# folder is removed (a rerun's marked "(rerun)"). Not the rest of that HOME: npx writes its own logs in ~/.npm on every
# call. The renderers and cores the smokes start get fresh folders of their own under TMPDIR, which the smokes remove
# themselves.
run_suite() {
  local name="$1" sfx="${2:-}" spec="${SPEC[$1]:-}" MS
  [ -n "$spec" ] || { echo "run_suite: $name is not queued in this shard"; return; }
  case "$name" in
    core-smoke-ramps-baseline) RAMPS_BASELINE_REF=dd38598 bash -c 'run_one "$1" "$2"' _ "$spec" "$sfx" ;;
    motion-smoke-motion-*)
      MS="$(mktemp -d "${TMPDIR:-/tmp}/zr-motion-XXXXXX")"; mkdir -p "$MS/home" "$MS/xdg" "$MS/data" "$MS/tmp"
      pactl set-sink-mute RDPSink 1 >/dev/null 2>&1 || true
      PATH="$FFBIN:$PATH" AIVE_FFMPEG="$FFBIN/ffmpeg" AIVE_FFPROBE="$FFBIN/ffprobe" TMPDIR="$MS/tmp" \
        HOME="$MS/home" USERPROFILE="$MS/home" XDG_CONFIG_HOME="$MS/xdg" AIVE_DATA_DIR="$MS/data" NPM_CONFIG_UPDATE_NOTIFIER=false \
        bash -c 'run_one "$1" "$2"' _ "$spec" "$sfx"
      find "$MS/home/.aive" "$MS/data" -type f 2>/dev/null | sed "s|^$MS/|$name${sfx:+ (rerun)}: |" >> "$OUT/motion-new-files.txt"
      rm -rf "$MS" ;;
    *) bash -c 'run_one "$1" "$2"' _ "$spec" "$sfx" ;;
  esac
}
xargs -P "$JOBS" -I{} bash -c 'run_one "$1"' _ {} < "$LIST.shard"
# Port/browser-bound suites run one at a time (in the last shard).
if [ "$SK" = "$SN" ]; then
for short in $PORTBOUND; do
  f="packages/core/scripts/smoke-$short.ts"
  [ -f "$f" ] && { queue "core-smoke-$short|$f $(argsfor "smoke-$short")"; run_suite "core-smoke-$short"; }
done
queue "desktop-smoke-web|apps/desktop/scripts/smoke-web.ts"; run_suite desktop-smoke-web
queue "mcp-smoke|packages/mcp/scripts/smoke.ts $M/a.mp4 $M/b.mp4"; run_suite mcp-smoke
[ -f apps/desktop/scripts/parity-gl.mts ] && { queue "desktop-parity-gl|apps/desktop/scripts/parity-gl.mts"; run_suite desktop-parity-gl; }
queue "core-smoke-ramps-baseline|packages/core/scripts/smoke-ramps.ts"; run_suite core-smoke-ramps-baseline
# The motion media and settle smokes, one at a time after everything else (settle is load-sensitive).
: > "$OUT/motion-new-files.txt"
for m in media settle; do
  queue "motion-smoke-motion-$m|packages/motion/scripts/smoke-motion-$m.ts"; run_suite "motion-smoke-motion-$m"
done
fi
# Reruns (none with MATRIX_RETRY=0). Each suite whose run failed (a row with a non-zero exit, a hang's 124/137
# included) runs once more, after everything else in the shard and one at a time, through run_suite: the same command
# and environment as its first run. Its first log stays logs/<name>.log, the rerun's is logs/<name>.retry.log, and the
# rerun's row replaces the first one, so the results keep one row per suite. A suite whose rerun passes is FLAKY: it
# counts as passed, its first-run row goes to flaky.tsv (flaky-k.tsv) and a FLAKY line names it. A suite whose rerun fails too, or ends
# before it writes a row, stays failed. A queued suite with no row at all is not rerun: it fails (below).
declare -A NOTE=()
if [ "${MATRIX_RETRY:-1}" != 0 ]; then
  mapfile -t RERUN < <(awk -F'\t' '$1!=0 {print $1 "\t" $2}' "$RES")
  : > "$RR"
  for r in "${RERUN[@]}"; do
    IFS=$'\t' read -r rc1 name <<< "$r"
    echo "RERUN $name (first exit $rc1) at $(date -u +%H:%M:%S) UTC"
    run_suite "$name" .retry < /dev/null
    rc2="$(awk -F'\t' -v n="$name" '$2==n {print $1; exit}' "$RR")"
    case "$rc2" in
      0) awk -F'\t' -v n="$name" '$2==n' "$RES" >> "$FLK" ;;
      "") NOTE[$name]="first exit $rc1, rerun: no result row" ;;
      *) NOTE[$name]="first exit $rc1, rerun $rc2" ;;
    esac
  done
  awk -F'\t' 'FILENAME==ARGV[1] {r[$2]=$0; next} {print (($2 in r) ? r[$2] : $0)}' "$RR" "$RES" > "$RES.tmp" &&
    mv "$RES.tmp" "$RES"
  rm -f "$RR"
fi
sort -k2 "$RES" -o "$RES"; sort -k2 "$FLK" -o "$FLK"
# Queued suites without a result row: one FAIL line each, counted with the failed ones; the total is the queued count.
LOST="$(comm -23 <(sort -u "$QF") <(cut -f2 "$RES" | sort -u))"
FAILS=$(( $(awk -F'\t' '$1!=0' "$RES" | wc -l) + $(printf '%s' "$LOST" | grep -c .) ))
TOTAL=$(wc -l < "$QF")
NFLAKY=$(wc -l < "$FLK")
echo "MATRIX${SHARD:+ shard $SHARD}: $((TOTAL-FAILS))/$TOTAL passed$([ "$NFLAKY" -eq 0 ] || echo ", $NFLAKY flaky") (ffmpeg: $(${AIVE_FFMPEG:-ffmpeg} -version 2>/dev/null | head -1 | cut -d' ' -f3))"
while IFS=$'\t' read -r rc name last; do
  [ "$rc" = 0 ] || echo "FAIL $name (${NOTE[$name]:-exit $rc}): $last"
done < "$RES"
[ -z "$LOST" ] || printf '%s\n' "$LOST" | sed 's/^/FAIL /; s/$/ (no result row: its run ended before it wrote one)/'
awk -F'\t' '{print "FLAKY " $2 " (first exit " $1 ", rerun 0)"}' "$FLK"
[ "$FAILS" -le 95 ] || FAILS=95
exit "$FAILS"
