#!/usr/bin/env bash
# judge.yml: runs a command whose output comes from zjudge or the editor with GitHub's workflow commands turned off,
# so nothing it prints (::add-mask::, ::add-matcher::, ::set-output::, ::error::, ...) is read as a workflow command.
#
#   quiet.sh <log> <command>...    the command's output (stdout and stderr) goes to <log>, a file made here (mode
#                                  0600, this user's); once the command has ended, a token is made and the log is
#                                  printed between ::stop-commands::<token> and ::<token>::. No process of the
#                                  command holds the step's output, sees the token, or keeps the step open.
#   quiet.sh --live <command>...   the token is made first, then the command's output is printed as it comes (the
#                                  judge step: the runner prints as it goes), then ::<token>::.
#
# The command's stdin is /dev/null. The token (16 random bytes, hex) is a variable of this shell: it is never
# exported, never on a command line, and never in the command's environment. Exit: the command's exit code, also
# when it fails (the commands are turned on again first). The self-test (judge/selftest.py, ci_scripts) runs both
# forms on a command that prints a workflow command.
set -u

token() {
  local t
  t="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  if [ "${#t}" -ne 32 ]; then
    echo "quiet.sh: no token from /dev/urandom" >&2
    exit 1
  fi
  printf '%s' "$t"
}

if [ "${1-}" = --live ]; then
  shift
  t="$(token)" || exit 1
  echo "::stop-commands::$t"
  rc=0
  "$@" < /dev/null 2>&1 || rc=$?
  echo "::$t::"
  exit "$rc"
fi

log="${1:?usage: quiet.sh <log> <command>... | quiet.sh --live <command>...}"
shift
install -m 0600 /dev/null "$log" || exit 1
rc=0
"$@" < /dev/null > "$log" 2>&1 || rc=$?
t="$(token)" || exit 1
echo "::stop-commands::$t"
cat "$log"
echo "::$t::"
exit "$rc"
