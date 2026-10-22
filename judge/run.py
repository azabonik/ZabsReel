#!/usr/bin/env python3
"""Runs the judge's tests against one editor build through an adapter (judge/PROTOCOL.md).

    python3 -I judge/run.py [--adapter "<command>"] [--build <dir>] [--only <text>] [--timeout <s>] [--jobs <n>]
                            [--scratch <dir>] [--keep] [--list] [--strict] [--require-trace] [--allow-unprotected]
                            [--as-user <name>] [--graphics-addon <dir>]
    python3 -I judge/run.py --self-test [--require-trace] [--as-user <name>]

--adapter   the adapter command (default: this judge's v0.2.0 adapter, run with this Python). A word that names an
            existing file or folder relative to the current folder is made absolute: the adapter runs with its
            current folder set to the test's scratch folder.
--build     the editor checkout or build the adapter starts (default: the folder that holds judge/)
--only      run only the tests whose file name contains this text
--timeout   seconds per test, for every test (default: each test's TIMEOUT, else 600)
--jobs      tests that use no network port run this many at a time (default 2); port-bound tests run one at a time
--scratch   the folder for this run's scratch folder (default: $JUDGE_SCRATCH, else the system temp folder)
--keep      keep the scratch folder after a run that passed (a failed run always keeps it)
--strict    a check recorded as not applicable fails (see "Statuses" below); judge.yml passes it while it grades v0.2.0
--require-trace
            a check recorded as not observed fails: every observation needs strace (judge.yml passes it). With
            --self-test: the trace cases must run (strace present), not be skipped
--allow-unprotected
            run even when the runner or a test process cannot be made non-dumpable (see below); the JUDGE line says
            UNPROTECTED. Development only (not Linux); CI never passes it
--as-user   run the adapter, the editor and everything they start as this other user (judge.yml: zjudge, made for the
            job, with no sudo and no group shared with the runner's user), through `sudo -n` (see "Another user"
            below). Without it they run as the runner's user (a local run). With --self-test: the --as-user cases
            run as this user (without it they are skipped)
--graphics-addon
            the graphics add-on the judge gives the editor (default: $JUDGE_GRAPHICS_ADDON, else none): a folder
            that judge/fixtures/graphics-addon/install.sh made (CI: /srv/judge/addon), or any folder in that layout:
            Remotion's packages in node_modules (the version judge/fixtures/graphics-addon/package.json names) and the
            Chrome headless shell in Remotion's browser cache below it (GRAPHICS_ADDON_BROWSER). A test that needs it
            records its checks on the add-on as not applicable without it (--strict fails them). Under --as-user that
            user must be able to read it and change none of it (the folder, its node_modules and the shell's folder)
--self-test the runner's own tests (judge/selftest.py): each way a test can fail must fail the run

Statuses: a check passes or fails, or is recorded as NOT APPLICABLE (the hostile input it needs could not be made from
the file the editor saved, for example because the editor's file format does not hold the value as given; or it is a
check on the graphics add-on and no --graphics-addon was given) or NOT OBSERVED (the observation needs strace, which is
not installed). Those two count as neither passed nor failed: each
is printed with its name and the JUDGE line counts them ("JUDGE: 150/150 passed, 6 not applicable, 2 not
observed"). --strict turns not applicable into a failure, --require-trace turns not observed into a failure.

Downloads: every test that starts the editor runs its adapter under strace (JUDGE_STRACE names it; empty means none,
else the strace on PATH, or under --as-user the one in SYSTEM_PATH), with the network calls traced and io_uring
refused, and the runner adds the check "nothing was downloaded": no process of the adapter's tree addressed another
computer (observe.net_hits on the lines the test process read while the editor ran from a socket that only it and
strace hold, TraceTail; a line not of strace's form, a trace that ended before stop, or one that did not end after
it, fails the check). After stop the test process
waits for strace to exit (it exits when the last process it traces has ended); when it does not, the test process
sweeps the scratch folder itself (but strace), fails "nothing the adapter started is left running after stop" on
what it finds, and a trace that still does not end within 10 s is incomplete (a traced process outlived stop). An
strace is used only when it records a UDP connect that a
child makes (strace_probe), and with --require-trace only when the runner's user cannot write it or any folder above
it and no symbolic link on the way to it sits in a folder that user can write; its real path is what runs. Without a
usable strace that check is not observed.

Each test file judge/tests/test_*.py has a function run(t), sets CHECKS (the number of checks run(t) records) and may
set PORT_BOUND (default True: it starts the editor) and TIMEOUT. Each test runs in its own session under its
timeout, with JUDGE_TEST_SCRATCH=<its scratch folder> in its environment (the driver passes it on to the adapter).
The test sends its results to the runner over a pipe that only the test process holds; nothing the runner reads for
the verdict is a file. On Linux the runner and the test process make themselves non-dumpable first (prctl), so another
process of the same user cannot reopen the pipe through /proc/<pid>/fd or attach with ptrace. A Python fork child
(fork without exec) closes the result pipe and makes itself dumpable again, so the sweep below can find it. When
the runner cannot make itself non-dumpable it prints "JUDGE: refused: ..." and exits 1; when a test process cannot,
that test fails without running. --allow-unprotected runs anyway and marks the JUDGE line UNPROTECTED. A line on
the pipe that is not one of the test's records (the declaration first, checks, the end last) fails the test. When the
test ends,
every process whose environment names the test's scratch folder is ended by exact process id. The runner prints one
line per check and then "JUDGE: <passed>/<checks> passed", and exits 1 when any check failed, a test did not finish,
did not report its end, wrote a malformed or unknown record, recorded a number of checks other than its CHECKS, left
a process running, or there were no checks. SIGTERM or SIGINT ends the running tests and what they started, prints
"JUDGE: interrupted ..." and exits 1. Python 3 standard library only; FFmpeg and ffprobe from PATH
(JUDGE_FFMPEG / JUDGE_FFPROBE override).

Another user (--as-user <name>): strace runs as root (`sudo -n env -i ... strace -u <name> ...`) and starts the adapter
as that user, so nothing the adapter starts can signal strace, attach to it or open its descriptors, and the test
process (another user, non-dumpable) and the runner's files are out of its reach. Without strace the adapter starts
through `sudo -n -u <name>`. The adapter's environment is an explicit list (AsUser.env_words), and it runs with umask
022 so the judge can read what it writes. The run's folder is the runner's (mode 0755); in it the runner keeps its
records (each test's log and the copy of its trace) in records/ (mode 0700), and a copy of the default adapter in
adapter/. Each test's folder, and every folder T.path makes in it, belongs to the runner with mode 1777 (sticky): the
editor can add files and folders there, but cannot rename or remove the test's own files, and the kernel does not let
the test follow the editor's links there or open its files with O_CREAT (fs.protected_symlinks and
fs.protected_regular, which the runner checks). After each test the runner ends every process of that user (sudo -n
pkill -KILL, by real and by effective user id) and fails "nothing left running after the test" on what it finds, as
well as the sweep by scratch values (which cannot read that user's processes' environment). Tests run one at a time
(the sweep is per user). The runner refuses to start when the user is root or itself, shares a group with it, already
runs a process, could change a folder above the run's folder, or when sudo -n does not work.
"""
import argparse
import ctypes
import importlib.util
import inspect
import json
import os
import re
import select
import shlex
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

sys.dont_write_bytecode = True  # nothing may appear under judge/ (JUDGE.lock covers every file there)
JUDGE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, JUDGE)

DEFAULT_TIMEOUT = 600
PRINT_LOCK = threading.Lock()


# ---------------------------------------------------------------- no access through /proc or ptrace
PR_SET_DUMPABLE = 4
RESULTS_FD = None  # the test child's write end of the result pipe (set by child()); the fork hook closes it


def _set_dumpable(value):
    """prctl(PR_SET_DUMPABLE, value). Returns None, or why it could not be set."""
    if not sys.platform.startswith("linux"):
        return f"not Linux ({sys.platform})"
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(PR_SET_DUMPABLE, value, 0, 0, 0) != 0:
            return f"prctl failed: {os.strerror(ctypes.get_errno())}"
    except (OSError, AttributeError) as e:
        return f"prctl unavailable: {e}"
    return None


PROTECTED_CHECK = "the test process is non-dumpable (its result pipe cannot be reopened through /proc)"


def no_dump(role):
    """Makes this process non-dumpable (Linux prctl PR_SET_DUMPABLE 0): another process of the same user can then not
    open its descriptors through /proc/<pid>/fd (opening a pipe's link there for writing gives a new write end), read
    its memory or environment, or attach with ptrace. execve resets it, so each Python process that holds the result
    pipe calls this itself; the adapter and the editor stay dumpable (the sweep reads their environment). Returns
    None, or why the process is not protected. JUDGE_FORCE_UNPROTECTED=<roles> ("runner", "child", comma-separated)
    reports a failure for those roles after the call (the self-test of the refusal; it can only make a run fail or,
    with --allow-unprotected, say UNPROTECTED)."""
    why = _set_dumpable(0)
    if why is None and role in os.environ.get("JUDGE_FORCE_UNPROTECTED", "").split(","):
        why = "forced by JUDGE_FORCE_UNPROTECTED"
    return why


def _after_fork_in_child():
    """A fork without exec inherits non-dumpable, and the sweep cannot read a non-dumpable process's environment. So
    a Python fork child first closes its copy of the result pipe, then makes itself dumpable again (best-effort: it
    holds nothing the protection is for)."""
    if RESULTS_FD is not None:
        try:
            os.close(RESULTS_FD)
        except OSError:
            pass
    try:
        _set_dumpable(1)
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------- processes left behind
def _ancestors():
    out, pid = set(), os.getpid()
    while pid > 1:
        out.add(pid)
        try:
            with open(f"/proc/{pid}/stat", "rb") as f:
                pid = int(f.read().rsplit(b")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return out


def scratch_pids(folder, skip=()):
    """Process ids whose environment has a value inside `folder` (Linux /proc; elsewhere none are found), but this
    process, its ancestors and the ids in `skip`."""
    if not os.path.isdir("/proc"):
        return []
    root = os.path.realpath(folder).encode()
    skip = _ancestors() | set(skip)
    found = []
    for name in os.listdir("/proc"):
        if not name.isdigit() or int(name) in skip:
            continue
        try:
            with open(f"/proc/{name}/environ", "rb") as f:
                env = f.read().split(b"\0")
        except OSError:
            continue
        for entry in env:
            value = entry.split(b"=", 1)[1] if b"=" in entry else b""
            if value == root or value.startswith(root + b"/"):
                found.append(int(name))
                break
    return found


def cmdline(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return f.read().replace(b"\0", b" ").decode("utf-8", "replace").strip()
    except OSError:
        return "?"


def end_pids(pids, grace=5.0):
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
    deadline = time.time() + grace
    while time.time() < deadline and any(os.path.exists(f"/proc/{p}") for p in pids):
        time.sleep(0.1)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def sweep(folder, skip=()):
    """Ends every process left whose environment names `folder` (but those in `skip`). Returns [(pid, cmdline)] of
    what it found."""
    left = []
    for _ in range(3):
        pids = scratch_pids(folder, skip)
        if not pids:
            break
        left += [(p, cmdline(p)) for p in pids]
        end_pids(pids)
    return left


# ---------------------------------------------------------------- --as-user: the adapter and the editor as another user
SYSTEM_PATH = "/usr/sbin:/usr/bin:/sbin:/bin"  # where the commands run as root are looked up (never the PATH)
AS_USER = None  # an AsUser while --as-user is given (in the runner and in each test process)
# TRACEE (below) for --as-user: the adapter's tree also gets umask 022, so the judge can read what the editor writes.
TRACEE_AS_USER = ["/bin/sh", "-c", 'umask 022; exec 2>>"$0"; exec "$@"']
SHARED = 0o1777  # each test's folder and the folders T.path makes in it, under --as-user (sticky: see the docstring)
PROTECTED_SYSCTLS = ("protected_symlinks", "protected_hardlinks", "protected_regular")


def runner_groups():
    """Every group id of the user that runs this (supplementary, real and effective)."""
    return set(os.getgroups()) | {os.getgid(), os.getegid()}


def shared_groups(user_groups, my_groups):
    """The group ids in both sets, sorted. A user that shares a group with the runner's user can write what that group
    may write (AsUser.problem and lockout.py refuse it)."""
    return sorted(set(user_groups) & set(my_groups))


def _sysctl(name):
    """The value of the sysctl fs.<name> (/proc/sys/fs/<name>) as an integer; raises OSError or ValueError."""
    with open(f"/proc/sys/fs/{name}", encoding="ascii") as f:
        return int(f.read().strip())


def _status_ids(pid):
    """(user ids, state letter) of a process from /proc/<pid>/status (readable by every user), or None."""
    try:
        with open(f"/proc/{pid}/status", encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return None
    uids, state = set(), "?"
    for ln in text.splitlines():
        if ln.startswith("Uid:"):
            uids = {int(x) for x in ln.split()[1:] if x.isdigit()}
        elif ln.startswith("State:"):
            state = (ln.split() + ["?", "?"])[1]
    return uids, state


def core_limits():
    """(soft, hard) core file size limits of this process as `ulimit -c` words: 512-byte blocks or "unlimited"."""
    import resource
    return tuple("unlimited" if v == resource.RLIM_INFINITY else str(v // 512)
                 for v in resource.getrlimit(resource.RLIMIT_CORE))


class AsUser:
    """--as-user <name>: the adapter, the editor and everything they start run as this user. Commands that need root
    (strace, which then starts the adapter as the user with -u; the user sweep) run through `sudo -n`, so the runner's
    user needs sudo without a password (a GitHub-hosted runner has it). Every command run as root is looked up in
    SYSTEM_PATH (strace too, unless JUDGE_STRACE names one), and strace is not used when this user can change it
    (strace())."""

    def __init__(self, name):
        import pwd
        pw = pwd.getpwnam(name)  # KeyError: no such user
        self.name, self.uid, self.gid = pw.pw_name, pw.pw_uid, pw.pw_gid
        self.groups = set(os.getgrouplist(pw.pw_name, pw.pw_gid))
        self.tools = {t: shutil.which(t, path=SYSTEM_PATH) for t in ("sudo", "env", "pkill", "pgrep", "rm", "true")}

    def root(self, words):
        """The words that run `words` as root."""
        return [self.tools["sudo"], "-n", "--"] + list(words)

    def tracer(self, words):
        """The words that run `words` (strace, which then starts the adapter as this user) as root, with the core
        file size limits of the process that runs the judge (core_limits). sudo gives the command it runs a core limit
        of 0 (soft and hard: sudoers' rlimit_core), and a hard limit only root can raise, so without this the editor
        as this user could not raise its own soft limit as it can when it runs as the judge's user (v0.2.0's built-in
        graphics renderer does: "prlimit: failed to set the CORE resource limit"). The shell runs as root, between
        sudo and strace -u, so it can set them; the user gets no limit the judge's user does not have."""
        soft, hard = core_limits()
        return self.root(["/bin/sh", "-c", 'ulimit -H -c "$0" && ulimit -S -c "$1" && shift && exec "$@"', hard, soft]
                         + list(words))

    def as_user(self, words):
        """The words that run `words` as this user (sudo's own environment rules apply: give `env_words` first)."""
        return [self.tools["sudo"], "-n", "-u", self.name, "--"] + list(words)

    def env_words(self, scratch=None):
        """`env -i` with the adapter's whole environment: PATH (the runner's), LANG, HOME and TMPDIR (the test's
        scratch folder, so nothing goes elsewhere), USER and LOGNAME, JUDGE_TEST_SCRATCH, and AIVE_FFMPEG /
        AIVE_FFPROBE when the runner has them."""
        home = scratch or "/"
        pairs = {"PATH": os.environ.get("PATH") or "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": home, "TMPDIR": home,
                 "USER": self.name, "LOGNAME": self.name}
        if scratch:
            pairs["JUDGE_TEST_SCRATCH"] = scratch
        for k in ("AIVE_FFMPEG", "AIVE_FFPROBE"):
            if os.environ.get(k):
                pairs[k] = os.environ[k]
        return [self.tools["env"], "-i"] + [f"{k}={v}" for k, v in pairs.items()]

    def _run(self, words, timeout=60, **kw):
        return subprocess.run(words, stdin=kw.pop("stdin", subprocess.DEVNULL), capture_output=True, text=True,
                              timeout=timeout, cwd="/", **kw)

    def problem(self):
        """None when the runner may use this user, else why not. It must be another user than root and the runner's,
        share no group with the runner's user, run no process yet (what runs as it is ended after each test), and
        sudo -n must run commands as root and as it. The kernel must refuse to follow another user's link and to open
        another user's file with O_CREAT in a sticky folder that others can write (the shared test folders)."""
        if not sys.platform.startswith("linux"):
            return f"another user needs Linux (this is {sys.platform})"
        if self.uid == 0:
            return f"{self.name} is root"
        if self.uid in (os.getuid(), os.geteuid()):
            return f"{self.name} is the user that runs the judge"
        import grp
        shared = shared_groups(self.groups, runner_groups())
        if shared:
            names = []
            for g in shared:
                try:
                    names.append(grp.getgrgid(g).gr_name)
                except KeyError:
                    names.append(str(g))
            return f"{self.name} shares the group(s) {', '.join(names)} with the user that runs the judge"
        missing = [t for t, p in self.tools.items() if not p]
        if missing:
            return f"no {', '.join(missing)} in {SYSTEM_PATH}"
        for t in ("sudo", "env"):
            why = _not_writable(self.tools[t], self)
            if why:
                return f"{t} {self.tools[t]} is not used: {why}"
        for name in PROTECTED_SYSCTLS:
            try:
                value = _sysctl(name)
            except (OSError, ValueError) as e:
                return f"fs.{name} cannot be read ({e})"
            if value < 1:
                return (f"fs.{name} is {value}: the test's folders are shared with {self.name} (sticky, mode 1777) "
                        f"and need it at 1 or more")
        for words, who in ((self.root([self.tools["true"]]), "root"),
                           (self.as_user([self.tools["true"]]), self.name)):
            try:
                p = self._run(words, timeout=30)
            except (OSError, subprocess.TimeoutExpired) as e:
                return f"sudo -n cannot run a command as {who} ({e})"
            if p.returncode != 0:
                return f"sudo -n cannot run a command as {who}: {_short(p.stderr or p.stdout, 200)}"
        running = self.procs()
        if running:
            return (f"{self.name} already runs {len(running)} process(es) ({_short([f'{p} {c}' for p, c in running], 200)}"
                    f"): the runner ends every process of this user after each test, so it must be a user only the "
                    f"judge uses")
        return None

    def _may(self, st, bit):
        """Whether this user has permission `bit` (4 read, 2 write, 1 search) on a file with stat `st` (mode bits)."""
        if st.st_uid == self.uid:
            return bool(st.st_mode & (bit << 6))
        if st.st_gid in self.groups:
            return bool(st.st_mode & (bit << 3))
        return bool(st.st_mode & bit)

    def folder_problem(self, path):
        """None when this user can reach the folder `path` (search permission on it and on every folder above it) and
        can change none of them: it owns none, cannot write `path`, and cannot rename any of them (it cannot write
        the folder above, or that folder is sticky and it owns neither). Else why not. Mode bits only (no ACLs)."""
        chain, p = [], os.path.realpath(path)
        while True:
            chain.append(p)
            if os.path.dirname(p) == p:
                break
            p = os.path.dirname(p)
        for d in chain:
            st = os.stat(d)
            if st.st_uid == self.uid:
                return f"{d} belongs to {self.name}"
            if not self._may(st, 1):
                return f"{self.name} cannot enter {d} (no search permission for it)"
        if self._may(os.stat(chain[0]), 2):
            return f"{self.name} can write {chain[0]}"
        for child, parent in zip(chain, chain[1:]):
            pst = os.stat(parent)
            if self._may(pst, 2) and not (pst.st_mode & stat.S_ISVTX):
                return f"{self.name} can rename {child} (it can write {parent})"
        return None

    def procs(self):
        """[(pid, cmdline)] of every process of this user (by real, effective, saved or file-system user id) that is
        not a zombie: this process's own look at /proc, and `pgrep` as root for any that /proc hides from it."""
        found = {}
        for name in os.listdir("/proc"):
            if name.isdigit():
                ids = _status_ids(name)
                if ids and self.uid in ids[0] and ids[1] != "Z":
                    found[int(name)] = cmdline(name)
        for flag in ("-U", "-u"):
            try:
                p = self._run(self.root([self.tools["pgrep"], flag, str(self.uid)]), timeout=30)
            except (OSError, subprocess.TimeoutExpired):
                continue
            for word in p.stdout.split():
                if word.isdigit() and int(word) not in found:
                    ids = _status_ids(word)
                    if ids and ids[1] != "Z":
                        found[int(word)] = cmdline(word)
        return sorted(found.items())

    def sweep(self, wait=10.0):
        """Ends every process of this user: pkill -KILL by real and by effective user id, as root, again until none is
        left or `wait` s have passed. Returns (found, left): [(pid, cmdline)] seen before the first kill, and those
        still there at the end. Never for root or the user that runs this (it would end the judge itself)."""
        if self.uid == 0 or self.uid in (os.getuid(), os.geteuid()):
            raise RuntimeError(f"no sweep of every process of {self.name}: root, or the user that runs the judge")
        found = left = self.procs()
        deadline = time.time() + wait
        while left and time.time() < deadline:
            for flag in ("-U", "-u"):
                try:
                    self._run(self.root([self.tools["pkill"], "-KILL", flag, str(self.uid)]), timeout=30)
                except (OSError, subprocess.TimeoutExpired):
                    pass
            settle = time.time() + 2
            while time.time() < settle:
                left = self.procs()
                if not left:
                    break
                time.sleep(0.2)
        return found, left

    def look(self, req):
        """look(req) run as this user (its own rights: the editor's private files and folders), or raises
        RuntimeError."""
        src = "import json, sys\n" + inspect.getsource(look) + "\nprint(json.dumps(look(json.load(sys.stdin))))\n"
        words = self.as_user([self.tools["env"], "-i", "PATH=/usr/bin:/bin", "LANG=C.UTF-8", sys.executable, "-I",
                              "-S", "-B", "-c", src])
        try:
            p = self._run(words, timeout=300, input=json.dumps(req), stdin=None)
            return json.loads(p.stdout)
        except (OSError, subprocess.TimeoutExpired, ValueError) as e:
            raise RuntimeError(f"looking as {self.name} failed: {e}")

    def remove(self, folder):
        """Removes `folder` (the run's folder, which holds files of this user) as root."""
        self._run(self.root([self.tools["rm"], "-rf", "--one-file-system", "--", folder]), timeout=600)


def look(req):
    """What one user sees of some paths (T.look; under --as-user AsUser.look runs this function's own source as that
    user). req: {"files": [path], "folders": [path], "walk": [path], "stat": [path], "read": [path], "root": folder}.
    Returns {"files": {path: sha256 of a regular file it can read, else None}, "folders": {path: sorted names, or None
    when it cannot list it}, "walk": {path: size of a regular file, None for a folder, a link or anything else} for
    every entry under each walk root (links are not followed), "stat": {path: {"type": "file" | "dir" | "link" |
    "other", "mode": permission bits, "size", "link": a link's target or None}, or None}, "read": {path: the bytes of a
    regular file as base64, when it holds at most 1 MiB, else None}}.
    stat and read follow no link at the path itself (lstat, O_NOFOLLOW), and answer None for a path whose folder,
    made real, is not inside `root` (when given), so a link the editor put on the way cannot point them at a file
    of the user that runs this; read also checks where the file it opened is (/proc/self/fd) before it reads."""
    import base64
    import hashlib
    import os
    import stat
    read_cap = 1 << 20
    root = os.path.realpath(req["root"]) if req.get("root") else None

    def inside(p):
        return root is None or p == root or p.startswith(root.rstrip(os.sep) + os.sep)
    out = {"files": {}, "folders": {}, "walk": {}, "stat": {}, "read": {}}
    for p in req.get("stat", []):
        out["stat"][p] = None
        if not inside(os.path.realpath(os.path.dirname(p))):
            continue
        try:
            st = os.lstat(p)
            kind = ("link" if stat.S_ISLNK(st.st_mode) else "dir" if stat.S_ISDIR(st.st_mode)
                    else "file" if stat.S_ISREG(st.st_mode) else "other")
            out["stat"][p] = {"type": kind, "mode": stat.S_IMODE(st.st_mode), "size": st.st_size,
                              "link": os.readlink(p) if kind == "link" else None}
        except OSError:
            pass
    for p in req.get("read", []):
        out["read"][p] = None
        if not inside(os.path.realpath(os.path.dirname(p))):
            continue
        try:
            fd = os.open(p, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        except OSError:
            continue
        try:
            where = os.readlink(f"/proc/self/fd/{fd}") if os.path.isdir("/proc/self/fd") else p
            if stat.S_ISREG(os.fstat(fd).st_mode) and inside(where):
                chunks, n = [], 0
                while n <= read_cap:
                    b = os.read(fd, 1 << 16)
                    if not b:
                        break
                    chunks.append(b)
                    n += len(b)
                if n <= read_cap:
                    out["read"][p] = base64.b64encode(b"".join(chunks)).decode("ascii")
        except OSError:
            pass
        finally:
            os.close(fd)
    for p in req.get("files", []):
        out["files"][p] = None
        try:
            fd = os.open(p, os.O_RDONLY | os.O_NONBLOCK)
        except OSError:
            continue
        try:
            if stat.S_ISREG(os.fstat(fd).st_mode):
                h = hashlib.sha256()
                for chunk in iter(lambda: os.read(fd, 1 << 20), b""):
                    h.update(chunk)
                out["files"][p] = h.hexdigest()
        except OSError:
            pass
        finally:
            os.close(fd)
    for p in req.get("folders", []):
        try:
            out["folders"][p] = sorted(os.listdir(p))
        except OSError:
            out["folders"][p] = None
    for root in req.get("walk", []):
        for d, dirs, files in os.walk(root, followlinks=False):
            for n in dirs + files:
                q = os.path.join(d, n)
                try:
                    st = os.lstat(q)
                except OSError:
                    continue
                out["walk"][q] = st.st_size if stat.S_ISREG(st.st_mode) else None
    return out


def shared_folder(path):
    """Makes the folder `path` for --as-user: owned by this user, mode SHARED (1777)."""
    os.mkdir(path)
    os.chmod(path, SHARED)


def shared_folders(root, folder):
    """Makes `folder` and the folders between it and `root` (a test's folder) as shared_folder does. A folder already
    there must be this user's own, not a link: one the editor made could hold links the test would write through."""
    rel = os.path.relpath(folder, root)
    if rel == ".":
        return
    if rel.startswith(".."):
        raise ValueError(f"{folder} is outside the test's folder {root}")
    cur = root
    for part in rel.split(os.sep):
        cur = os.path.join(cur, part)
        try:
            shared_folder(cur)
        except FileExistsError:
            st = os.lstat(cur)
            if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid():
                raise RuntimeError(f"{cur} is not a folder the test made (another user's, or a link): the test does "
                                   "not write in it")


# ---------------------------------------------------------------- strace (file-system trace and the download tripwire)
NET_CALLS = "connect,sendto,sendmsg,sendmmsg,io_uring_setup"  # the calls observe.net_hits reads (see its docstring)
NET_CHECK = "nothing was downloaded: no process of the adapter or the editor addressed another computer"
LEFT_CHECK = "nothing the adapter started is left running after stop"
_STRACE = {}
REQUIRE_TRACE = False  # --require-trace (the runner's flag; the runner passes it on to each test process)
# The first process strace starts. strace writes its trace to its stderr, which is the trace channel (TraceTail); this
# process inherits it as its own stderr, points its stderr at the adapter's stderr file ($0) and then runs the
# adapter, so no process of the adapter's tree holds the channel.
TRACEE = ["/bin/sh", "-c", 'exec 2>>"$0"; exec "$@"']

# The graphics add-on the judge gives the editor (--graphics-addon; PROTOCOL.md, "Motion graphics"): the folder's
# node_modules holds Remotion's packages, and the Chrome headless shell is in Remotion's own browser cache below it.
GRAPHICS_ADDON_BROWSER = ("node_modules", ".remotion", "chrome-headless-shell", "linux64",
                          "chrome-headless-shell-linux64", "chrome-headless-shell")
GRAPHICS_ADDON_PIN = os.path.join(JUDGE, "fixtures", "graphics-addon")
NO_GRAPHICS_ADDON = ("no graphics add-on was given to the judge (run.py --graphics-addon, or JUDGE_GRAPHICS_ADDON; "
                     "judge/fixtures/graphics-addon/install.sh makes one)")


def graphics_addon(folder):
    """({"root", "browser"}, None) for an add-on folder in the layout PROTOCOL.md describes, with the Remotion version
    the judge pins (judge/fixtures/graphics-addon/package.json), or (None, why not)."""
    root = os.path.realpath(folder)
    browser = os.path.join(root, *GRAPHICS_ADDON_BROWSER)
    try:
        with open(os.path.join(GRAPHICS_ADDON_PIN, "package.json"), encoding="utf-8") as f:
            want = json.load(f)["dependencies"]["@remotion/renderer"]
        with open(os.path.join(root, "node_modules", "@remotion", "renderer", "package.json"), encoding="utf-8") as f:
            have = json.load(f).get("version")
    except (OSError, ValueError, KeyError) as e:
        return None, f"{root} holds no Remotion add-on ({e})"
    if have != want:
        return None, f"{root} holds @remotion/renderer {have}, not {want} (judge/fixtures/graphics-addon)"
    if not (os.path.isfile(browser) and os.access(browser, os.X_OK)):
        return None, f"{root} has no headless shell at {os.path.join(*GRAPHICS_ADDON_BROWSER)}"
    return {"root": root, "browser": browser}, None


def _not_writable(path, user=None):
    """None when neither `path` (made real) nor any folder above it can be written by this user: each is owned by root
    or by another user (in a user namespace root's files belong to the overflow user), this user cannot write it, and
    it has no group or other write bit. With `user` (an AsUser: the --as-user user, for a program that runs as root)
    none of them may belong to that user or be writable by it either. Else why not."""
    p = os.path.realpath(path)
    me = os.geteuid()
    while True:
        try:
            st = os.stat(p)
        except OSError as e:
            return f"{p}: {e}"
        if st.st_uid == me and me != 0:
            return f"{p} belongs to this user"
        if user is not None and st.st_uid == user.uid:
            return f"{p} belongs to {user.name}"
        if user is not None and user._may(st, 2):
            return f"{p} can be written by {user.name}"
        if st.st_mode & 0o022:
            return f"{p} can be written by its group or by others"
        if me != 0 and os.access(p, os.W_OK):  # root can write any file: for root, ownership and mode decide
            return f"{p} can be written by this user"
        parent = os.path.dirname(p)
        if parent == p:
            return None
        p = parent


def _links_not_writable(path, user=None):
    """None when no symbolic link met while resolving `path` (as given, before it is made real) sits in a folder that
    this user, or `user` (an AsUser), can write (_not_writable on that folder), else why not. Such a link could be
    pointed elsewhere between the check of the real file and its start."""
    parts = [p for p in (path if os.path.isabs(path) else os.path.join(os.getcwd(), path)).split(os.sep) if p]
    cur, links = os.sep, 0
    while parts:
        part = parts.pop(0)
        if part == ".":
            continue
        if part == "..":
            cur = os.path.dirname(cur)
            continue
        nxt = os.path.join(cur, part)
        if not os.path.islink(nxt):
            cur = nxt
            continue
        links += 1
        if links > 40:
            return f"{path}: too many symbolic links"
        why = _not_writable(cur, user)
        if why:
            return (f"{nxt} is a symbolic link in a folder this user" + (f" or {user.name}" if user else "")
                    + f" can write ({why})")
        target = os.readlink(nxt)
        parts = [p for p in target.split(os.sep) if p] + parts
        if os.path.isabs(target):
            cur = os.sep
    return None


def strace_probe(st, bpf):
    """None when strace `st` traces a child here: run as the tests run it (TraceTail, TRACEE), it must record the
    child's UDP connect to 192.0.2.1 port 53 (observe.net_hits finds exactly that line), and every line it writes must
    have the form of an strace line. Else why not. A program that runs its command without tracing it, or traces
    nothing, fails this."""
    import observe
    tmp = tempfile.mkdtemp(prefix="judge-strace-probe-")
    child = [sys.executable, "-I", "-S", "-c",
             "import socket\ns = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)\ntry:\n"
             "    s.connect(('192.0.2.1', 53))\nexcept OSError:\n    pass\n"]
    tail = None
    try:
        tail = TraceTail(os.path.join(tmp, "probe.log"))
        if AS_USER is None:
            words = strace_words(st, bpf, NET_CALLS) + TRACEE + [os.path.join(tmp, "probe.stderr")] + child
        else:  # as the tests run it: strace as root, the child as the other user (its stderr: nowhere it cannot reach)
            words = AS_USER.tracer(AS_USER.env_words() + strace_words(st, bpf, NET_CALLS, AS_USER.name)
                                   + TRACEE_AS_USER + ["/dev/null"] + child)
        p = subprocess.Popen(words, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=tail.writer,
                             close_fds=True, cwd="/" if AS_USER else None)
        tail.started()
        tail.stopping()
        try:
            rc = p.wait(60)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()
            return "it did not end within 60 s"
        tail.close(wait=5)
        if rc != 0:
            return f"exit {rc}: {_short(tail.lines(), 200)}"
        if tail.tampered:
            return tail.tampered
        hits = observe.net_hits(tail)
        if len(hits) != 1 or "htons(53)" not in hits[0] or "192.0.2.1" not in hits[0]:
            return ("it did not record the probe's UDP connect to 192.0.2.1 port 53 ("
                    + (f"found {_short(hits, 200)}" if hits else "it wrote no such line") + ")")
        return None
    except (OSError, observe.Unmeasurable) as e:
        return f"{type(e).__name__}: {e}"
    finally:
        if tail is not None:
            tail.close(wait=0)
        shutil.rmtree(tmp, ignore_errors=True)


def strace(require_trace=None):
    """The strace to run the adapter under, as its real path, or None (strace_why() says why): JUDGE_STRACE when set
    (empty: none), else strace on PATH (under --as-user, where strace runs as root: strace in SYSTEM_PATH). The path
    is made real once, here, and that real path is what runs. With --require-trace (REQUIRE_TRACE), and always under
    --as-user, an strace whose real file, or a folder above it, this user can write is not used, and neither is one
    named through a symbolic link that sits in a folder this user can write: a build step could have named it through
    $GITHUB_ENV or $GITHUB_PATH, or point the link elsewhere after the check. Under --as-user (strace runs as root)
    the same holds for the other user: an strace whose real file, a folder above it, or a folder holding a link on
    the way belongs to that user or can be written by it is not used either. An strace that fails strace_probe is not
    used."""
    if require_trace is None:
        require_trace = REQUIRE_TRACE
    key = (bool(require_trace), AS_USER.name if AS_USER else None)
    if key not in _STRACE:
        env = os.environ.get("JUDGE_STRACE")
        st = (env or None) if env is not None else shutil.which("strace", path=SYSTEM_PATH if AS_USER else None)
        real = os.path.realpath(st) if st else None
        why, bpf = None, False
        if not st:
            why = "strace is not installed" + (" (JUDGE_STRACE is empty)" if env == "" else "")
        elif not (os.path.isfile(real) and os.access(real, os.X_OK)):
            why = f"strace {st} is not an executable file"
        elif (require_trace or AS_USER) and (_links_not_writable(st, AS_USER) or _not_writable(real, AS_USER)):
            why = (f"strace {st} is not used with " + ("--require-trace" if require_trace else "--as-user (it runs as "
                   "root)") + f": {_links_not_writable(st, AS_USER) or _not_writable(real, AS_USER)}")
        else:
            bad = strace_probe(real, True)
            if bad is None:
                bpf = True  # stops only at the traced calls: the network-only trace costs almost nothing
            else:
                plain = strace_probe(real, False)
                if plain is not None:
                    why = f"strace {st} does not trace a child here: {plain}"
        _STRACE[key] = (None if why else real, bpf, why)
    path, bpf, why = _STRACE[key]
    _STRACE["path"], _STRACE["bpf"], _STRACE["why"] = path, bpf, why
    return path


def strace_why():
    """Why strace() found no strace (after a call), else None."""
    return _STRACE.get("why")


def strace_words(st, bpf, calls, user=None):
    """The strace words that run a command under strace `st` with `calls` traced to strace's stderr (the trace
    channel, TraceTail), following every process it starts: -yy names each socket (TCP, UDP, UNIX, ...) and the ends
    of a connected one, which observe.net_hits needs, and every io_uring_setup is refused with ENOSYS (io_uring
    connect and send operations are not system calls strace sees; Node's libuv then uses epoll). With `user` (strace
    then runs as root) the command runs as that user (-u). The command after them is TRACEE and then the adapter."""
    return ([st, "-f"] + (["--seccomp-bpf"] if bpf else [])
            + ["-qq", "-yy", "-s", "4096", "-e", f"trace={calls}", "-e", "inject=io_uring_setup:error=ENOSYS",
               "-e", "signal=none"] + (["-u", user] if user else []) + ["--"])


def strace_cmd(stderr_path, files, scratch=None):
    """The words that run a command under strace with the network calls (and with files=True, the file calls) traced
    (strace_words), started through TRACEE with its stderr appended to `stderr_path`. Under --as-user strace runs as
    root through sudo with the adapter's environment (AsUser.env_words for the test's `scratch` folder), and starts
    the command as the other user."""
    calls = ("%file," if files else "") + NET_CALLS
    if AS_USER is None:
        return strace_words(strace(), _STRACE.get("bpf"), calls) + TRACEE + [stderr_path]
    return AS_USER.tracer(AS_USER.env_words(scratch) + strace_words(strace(), _STRACE.get("bpf"), calls, AS_USER.name)
                          + TRACEE_AS_USER + [stderr_path])


_PID = re.compile(r"^\[pid +(\d+)\] (.*)$", re.S)


class TraceTail:
    """The adapter tree's strace trace, read while the editor runs by the test process (non-dumpable, so the editor
    cannot reach this memory). strace writes its trace to its stderr, which is one end of a UNIX socket pair (`writer`,
    given to strace as its stderr); this process holds the other end. No process of the adapter's tree holds either
    end (TRACEE points the first one's stderr elsewhere before the adapter runs), and a socket cannot be opened again
    through /proc/<pid>/fd (ENXIO), so a process of the same user can neither add a line to the trace nor take one
    out of it. (Through a pipe or a file it could do both: a pipe's end opened through /proc reads strace's lines
    before this reader does.) Taking strace's descriptor with pidfd_getfd or attaching to strace needs ptrace rights
    over it, which Yama's ptrace_scope 1 gives only to strace's own ancestors.

    A thread reads every line as strace writes it and keeps it here; lines() first reads whatever is new. strace
    prefixes a line with "[pid N] " only while it traces more than one process: each line is kept as "N <call>", and
    a line with no prefix as "0 <call>", the form observe.py reads. Each line must have the form of an strace line
    (observe.strace_line_problem); the first one that does not, or an end of the trace before stopping() (strace ended
    while the editor ran), sets `tampered`, and every check on the trace then fails. The test process also writes each
    line it keeps to `copy_path`, outside the test's scratch folder, for people and for CI's log upload; the checks
    never read that file."""

    def __init__(self, copy_path):
        self._r, self.writer = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        self._r.setblocking(False)
        self.copy_path = copy_path
        self._copy = open(copy_path, "x", encoding="latin-1", newline="\n")
        self._lock = threading.Lock()
        self._lines, self._rest = [], b""
        self._tampered = None
        self._eof = self._stopping = False
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def started(self):
        """Closes this process's copy of the write end, once strace holds it: the reader then sees the end of the
        trace when strace exits."""
        if self.writer is not None:
            self.writer.close()
            self.writer = None

    def stopping(self):
        """The editor is about to be asked to stop: from here the end of the trace is expected."""
        with self._lock:
            self._stopping = True

    def _keep(self, raw):
        import observe
        m = _PID.match(raw)
        ln = f"{m.group(1)} {m.group(2)}" if m else f"0 {raw}"
        why = observe.strace_line_problem(ln)
        if why and not self._tampered:
            self._tampered = f"the trace holds a line that strace does not write ({why}): {_short(ln, 200)}"
        self._lines.append(ln)
        self._copy.write(ln + "\n")

    def _pull(self):
        """Reads what is new (under the lock)."""
        if self._r is None or self._eof:
            return
        got = False
        while True:
            try:
                chunk = self._r.recv(1 << 20)
            except (BlockingIOError, InterruptedError):
                break
            except OSError as e:
                chunk = b""
                self._tampered = self._tampered or f"the trace cannot be read: {e}"
            if not chunk:
                self._eof = True
                if not self._stopping:
                    self._tampered = self._tampered or ("the trace ended before the editor was asked to stop "
                                                        "(strace exited or was ended while the editor ran)")
                break
            got = True
            parts = (self._rest + chunk).split(b"\n")
            self._rest = parts.pop()
            for p in parts:
                self._keep(p.decode("latin-1"))
        if got:
            self._copy.flush()

    def _loop(self):
        while not self._stop.is_set():
            try:
                ready, _, _ = select.select([self._r], [], [], 0.05)
            except (OSError, ValueError):
                return
            if ready:
                with self._lock:
                    self._pull()
                    if self._eof:
                        return

    @property
    def tampered(self):
        """None, or why the trace cannot be trusted (after reading what is new)."""
        with self._lock:
            self._pull()
            return self._tampered

    def lines(self):
        """Every complete line read so far (after reading what is new)."""
        with self._lock:
            self._pull()
            return list(self._lines)

    def close(self, wait=5):
        """Stops the reader after a last read: waits up to `wait` s for the end of the trace (strace exits when the
        last process it traces has ended); the last line counts even without a newline. A trace that does not end
        within `wait` is incomplete: a process strace traces still runs (it outlived stop, and the sweep before this
        did not find it), and a call it makes after this read is never seen. That sets `tampered`, so every check on
        the trace fails."""
        self.started()
        deadline = time.time() + wait
        while time.time() < deadline:
            with self._lock:
                self._pull()
                if self._eof or self._r is None:
                    break
            time.sleep(0.02)
        with self._lock:
            if self._r is not None and not self._eof:
                self._tampered = self._tampered or (f"the trace did not end within {wait} s of stop: a traced "
                                                    "process outlived stop (strace still traces it)")
        self._stop.set()
        self._thread.join(5)
        with self._lock:
            self._pull()
            if self._rest:
                self._keep(self._rest.decode("latin-1"))
                self._rest = b""
            if self._r is not None:
                self._r.close()
                self._r = None
                self._copy.close()


# ---------------------------------------------------------------- the test's side (child process)
class T:
    """What a test's run(t) gets: its scratch folder, the media, checks, and the editor (t.driver())."""

    def __init__(self, name, scratch, media, build, adapter, out, trace_copy=None, addon=None):
        self.name, self.scratch, self.media_dir, self.build, self.adapter = name, scratch, media, build, adapter
        import observe
        observe.confine(scratch, media)  # what the measurements may read: the test's folder and the media
        # The graphics add-on the judge gives the editor when a test asks for it (driver(graphics_addon=True)):
        # {"root", "browser"}, or None, and then graphics_addon_why says why (the checks on it are not applicable).
        self.graphics_addon = addon
        self.graphics_addon_why = None if addon else NO_GRAPHICS_ADDON
        self._out = out  # the write end of the runner's result pipe
        # Where this process writes its copy of the trace's lines (the runner names it: next to the scratch folder, or
        # in the run's records/ under --as-user).
        self.trace_copy = trace_copy or os.path.join(os.path.dirname(scratch), f"{name}.adapter-strace.log")
        self._driver = None
        self.n_checks = 0
        self.trace_path = None  # the copy of the trace's lines (for people; no check reads it): driver(trace=True)
        self.trace = None       # its lines (TraceTail): what observe.trace_hits reads; None without trace=True
        self.trace_why = None   # why there is no trace (strace_why()), set by driver() when strace is not usable
        self.net_trace = None   # the adapter tree's strace trace (TraceTail: network calls, and file calls with trace=True)

    def _emit(self, rec):
        self._out.write(json.dumps(rec) + "\n")
        self._out.flush()

    def media(self, name):
        """Path of a fixture made by judge/fixtures/make.sh."""
        p = os.path.join(self.media_dir, name)
        if not os.path.isfile(p):
            raise FileNotFoundError(f"fixture {name} missing in {self.media_dir}")
        return p

    def path(self, *parts):
        """A path in this test's scratch folder (its parent folders are made; under --as-user they are shared with the
        editor's user, mode 1777, and one that is there already must be this test's own: shared_folders)."""
        p = os.path.join(self.scratch, *parts)
        if AS_USER is None:
            os.makedirs(os.path.dirname(p), exist_ok=True)
        else:
            shared_folders(self.scratch, os.path.dirname(p))
        return p

    def look(self, files=(), folders=(), walk=(), stat=(), read=()):
        """What the editor can see of these paths, for checks on its own files (run.look): {"files": {path: sha256 or
        None}, "folders": {path: sorted names or None}, "walk": {path: size of a regular file, else None} under each
        walk root, "stat": {path: {"type", "mode", "size", "link"} or None}, "read": {path: bytes or None}}. stat and
        read look only inside this test's scratch folder and follow no link at the path (run.look). This process looks
        itself; under --as-user the editor's user looks too (the editor keeps private files, mode 0600 in folders of
        mode 0700, that the runner's user cannot read): a file or folder this process cannot read gets that user's
        answer, and the walk lists what either of them sees. That user's answer is the editor's own word on its own
        files (it runs as the editor's user), as it is in a run without --as-user."""
        import base64
        req = {"files": list(files), "folders": list(folders), "walk": list(walk), "stat": list(stat),
               "read": list(read), "root": self.scratch}
        mine = look(req)
        if AS_USER is not None:
            theirs = AS_USER.look(req)
            mine = {k: {p: mine[k][p] if mine[k][p] is not None else theirs[k].get(p) for p in req[k]}
                    for k in ("files", "folders", "stat", "read")} | {"walk": {**theirs["walk"], **mine["walk"]}}
        mine["read"] = {p: None if v is None else base64.b64decode(v) for p, v in mine["read"].items()}
        return mine

    def _record(self, name, ok, detail, harness, status):
        if not harness:
            self.n_checks += 1
        rec = {"check": str(name), "ok": bool(ok), "detail": str(detail)}
        if harness:
            rec["harness"] = True
        if status:
            rec["status"] = status
        self._emit(rec)
        return bool(ok)

    def check(self, name, ok, detail="", harness=False, needs=()):
        """Records one check. Returns ok. A harness check (one the runner adds, such as "port closed after stop") is
        not counted against the test's CHECKS.

        needs: the crafted inputs (observe.Crafted, one or a list) the check is about. When one of them could not be
        made (the substitution found nothing to replace in the file the editor saved), the check is recorded as not
        applicable with that reason, and ok and detail are not used: a different file format must not fail a check,
        and the check is still listed by name (run.py --strict fails it)."""
        needs = [needs] if hasattr(needs, "applicable") else list(needs or ())
        missing = [c for c in needs if not c.applicable]
        if missing:
            return self.not_applicable(name, "; ".join(c.why for c in missing), harness=harness)
        return self._record(name, ok, detail, harness, None)

    def not_applicable(self, name, why, harness=False):
        """Records a check that cannot be made on this editor (its input cannot be crafted): neither passed nor
        failed, listed by name and counted on the JUDGE line; a failure with run.py --strict."""
        return self._record(name, True, why, harness, "not_applicable")

    def not_observed(self, name, why, harness=False):
        """Records a check whose observation is not available here (no usable strace): neither passed nor
        failed, listed by name and counted on the JUDGE line; a failure with run.py --require-trace."""
        return self._record(name, True, why, harness, "not_observed")

    def measure(self, name, fn, accept, want):
        """Records a check on a measured value: value = fn(); ok = accept(value). A measurement the file makes
        impossible (observe.Unmeasurable) fails the check with its reason. Returns the value (None if unmeasurable)."""
        import observe
        try:
            v = fn()
        except observe.Unmeasurable as e:
            self.check(name, False, f"unmeasurable: {e}")
            return None
        self.check(name, accept(v), f"{_short(v)} (want {want})")
        return v

    def driver(self, trace=False, graphics_addon=False):
        """The editor, started through the adapter in this test's scratch folder (started once per test). The
        adapter must answer hello with this judge's protocol version first.

        When strace is available (strace()), the adapter always runs under `strace -f` with the network calls traced
        to a channel only this process reads while the editor runs (self.net_trace, a TraceTail), for the runner's
        download check (NET_CHECK, after stop). trace=True (on the first call) traces the file-system calls too, so
        every file-system call of the adapter, the editor and every process they start is in it; self.trace is then
        the same TraceTail (observe.trace_hits reads its lines) and self.trace_path names the copy this process writes
        of those lines (<test>.adapter-strace.log next to the scratch folder, for people and CI's log upload; no check
        reads it). Without strace all three stay None: the download check and the test's trace checks are then
        recorded as not observed.

        graphics_addon=True (on the first call) gives the editor the judge's graphics add-on (self.graphics_addon, from
        --graphics-addon) in start; without one it starts with none, and the test records its checks on the add-on
        with t.not_applicable(name, t.graphics_addon_why). False: the editor has no add-on."""
        if self._driver is None:
            import driver
            cmd = list(self.adapter)
            stderr_path = os.path.join(self.scratch, "adapter.stderr")
            if strace():
                if self.net_trace is None:
                    self.net_trace = TraceTail(self.trace_copy)  # its reader runs before strace (and the adapter) starts
                if trace:
                    self.trace, self.trace_path = self.net_trace, self.net_trace.copy_path
                cmd = strace_cmd(stderr_path, files=trace, scratch=self.scratch) + cmd
                self._driver = driver.Driver(cmd, self.scratch, stderr_path, stderr_fd=self.net_trace.writer.fileno())
                self.net_trace.started()
            else:
                self.trace_why = strace_why()
                if AS_USER is not None:
                    cmd = AS_USER.as_user(AS_USER.env_words(self.scratch) + ["/bin/sh", "-c", 'umask 022; exec "$@"',
                                                                            "sh"]) + cmd
                self._driver = driver.Driver(cmd, self.scratch, stderr_path)
            hello = self._driver.hello()
            proto = hello.get("protocol") if isinstance(hello, dict) else None
            if not self.check(f"the adapter speaks protocol {driver.PROTOCOL}", proto == driver.PROTOCOL,
                              f"hello says protocol {proto!r}", harness=True):
                raise driver.AdapterError(f"the adapter speaks protocol {proto!r}, not {driver.PROTOCOL}", op="hello")
            self._driver.start(self.build, self.graphics_addon if graphics_addon else None)
        return self._driver

    def finish(self):
        d = self._driver
        if d is None:
            return
        if self.net_trace is not None:
            self.net_trace.stopping()
        exited = False
        try:
            if d.started:
                d.stop()
        except Exception as e:  # noqa: BLE001
            self.check("the editor stops when asked", False, str(e), harness=True)
        finally:
            # Under strace, d's process is strace (under --as-user, sudo, whose child strace is): it exits when the
            # last process it traces has ended. It is not killed here: that would end the trace while a traced process
            # still runs (TraceTail.close below).
            exited = d.close(kill=self.net_trace is None)
        if not exited and AS_USER is not None:
            # The adapter's tree outlived stop by 30 s (all of it runs as the other user, and no process of that user
            # belongs to anything else): the user sweep ends every process of that user, so the trace can end.
            found, still = AS_USER.sweep()
            if found:
                self.check(LEFT_CHECK, False, "; ".join(f"{pid} {cmd[:120]}" for pid, cmd in found)
                           + (f"; still running after the user sweep: {[p for p, _ in still]}" if still else ""),
                           harness=True)
        elif not exited and self.net_trace is not None:
            # A process of the adapter's tree outlived stop. The sweep ends each one whose environment names the
            # scratch folder (not strace itself), so the trace can end; one it cannot find keeps the trace open, and
            # TraceTail.close then marks the trace as not ended.
            left = sweep(self.scratch, skip=(d.p.pid,))
            if left:
                self.check(LEFT_CHECK, False, "; ".join(f"{pid} {cmd[:120]}" for pid, cmd in left), harness=True)
        for port in d.ports:
            deadline = time.time() + 10
            while time.time() < deadline and _listening(port):
                time.sleep(0.2)
            self.check(f"port {port} is closed after stop", not _listening(port), harness=True)
        if self.net_trace is None:
            self.not_observed(NET_CHECK, strace_why() or "strace is not installed", harness=True)
            return
        import observe
        self.net_trace.close(wait=10)
        if d.p.poll() is None:  # strace still runs: the trace is already marked as not ended
            try:
                d.p.kill()  # under --as-user sudo; strace (root) then ends when what it traces has ended
                d.p.wait(10)
            except (OSError, subprocess.TimeoutExpired):
                pass
        hits = observe.net_hits(self.net_trace)
        bad = self.net_trace.tampered
        detail = "; ".join(([bad] if bad else []) + ([_short(hits[:3])] if hits else []))
        self.check(NET_CHECK, not hits and not bad, detail or "no other computer addressed", harness=True)


def _listening(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.5)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()


def _short(v, n=300):
    s = v if isinstance(v, str) else json.dumps(v, default=str)
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 3] + "..."


def _declared(mod):
    n = getattr(mod, "CHECKS", None)
    return n if isinstance(n, int) and not isinstance(n, bool) and n >= 0 else None


def child(a, unprotected):
    """One test, in the process the runner started (made non-dumpable by main() before this runs). Records go to the
    inherited pipe (--results-fd), which no process this one starts inherits. The first record declares CHECKS; the
    last one says the test reached its end."""
    global RESULTS_FD
    fd = int(a.results_fd)
    os.set_inheritable(fd, False)
    RESULTS_FD = fd  # from here a fork child closes it first (_after_fork_in_child)
    out = os.fdopen(fd, "w", encoding="utf-8")
    spec = importlib.util.spec_from_file_location(os.path.basename(a.child)[:-3], a.child)
    mod = importlib.util.module_from_spec(spec)
    addon = graphics_addon(a.graphics_addon)[0] if a.graphics_addon else None  # the runner checked it
    t = T(os.path.basename(a.child)[:-3], a.scratch, a.media, a.build, json.loads(a.adapter_json), out, a.trace_copy,
          addon)
    try:
        spec.loader.exec_module(mod)
        t._emit({"declare": _declared(mod)})
        if unprotected:
            t.check(PROTECTED_CHECK, a.allow_unprotected, f"UNPROTECTED: {unprotected}"
                    + ("; allowed by --allow-unprotected" if a.allow_unprotected else "; the test is not run"),
                    harness=True)
            if not a.allow_unprotected:
                return 0
        mod.run(t)
    except BaseException as e:  # noqa: BLE001  (SystemExit too: a test that exits early has not run to its end)
        t.check("the test ran to its end", False, f"{type(e).__name__}: {e} | "
                + " / ".join(traceback.format_exc().strip().splitlines()[-4:-1]), harness=True)
    finally:
        try:
            t.finish()
        finally:
            t._emit({"end": True})
            out.close()
    return 0


# ---------------------------------------------------------------- the runner's side
LIVE = {}                  # test name -> (Popen, scratch folder) while the test runs
LIVE_LOCK = threading.Lock()
RESULTS = []               # every check reported so far (for the interrupted line)


def load_meta(path):
    spec = importlib.util.spec_from_file_location(os.path.basename(path)[:-3], path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not callable(getattr(mod, "run", None)):
        raise SystemExit(f"{path} has no run(t)")
    return {"path": path, "name": os.path.basename(path)[:-3], "port_bound": bool(getattr(mod, "PORT_BOUND", True)),
            "timeout": int(getattr(mod, "TIMEOUT", DEFAULT_TIMEOUT))}


def _end_group(p, grace=10):
    """SIGTERM, then SIGKILL, to the test's session (it is its own process group)."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(p.pid, sig)
        except (ProcessLookupError, PermissionError):
            return
        try:
            p.wait(grace)
            return
        except subprocess.TimeoutExpired:
            continue


class BadLine:
    """A line on the result pipe that is not UTF-8 JSON (made by the runner's reader, never by a test)."""

    def __init__(self, raw):
        self.raw = raw

    def __repr__(self):
        return repr(self.raw)


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


STATUSES = ("not_applicable", "not_observed")
CHECK_KEYS = {"check", "ok", "detail"}


def known_record(r, i, n):
    """Whether record `i` of `n` has one of the shapes T._emit writes, in its place: {"declare": int or None} first,
    {"check": str, "ok": bool, "detail": str} (with "harness": true for a runner-added check, and "status":
    "not_applicable" or "not_observed", with ok true, for a check that was not made), {"end": true} last."""
    if not isinstance(r, dict):
        return False
    keys = set(r)
    if keys == {"declare"}:
        return i == 0 and (r["declare"] is None or (_is_int(r["declare"]) and r["declare"] >= 0))
    if keys == {"end"}:
        return i == n - 1 and r["end"] is True
    if CHECK_KEYS <= keys <= CHECK_KEYS | {"harness", "status"}:
        return (isinstance(r["check"], str) and isinstance(r["ok"], bool) and isinstance(r["detail"], str)
                and r.get("harness", True) is True and r.get("status", STATUSES[0]) in STATUSES
                and ("status" not in r or r["ok"] is True))
    return False


LABEL = {"pass": "PASS", "fail": "FAIL", "not applicable": "N/A ", "not observed": "N/O "}


def status_of(r, strict=False, require_trace=False):
    """(status, detail) of a check record: pass, fail, not applicable or not observed; --strict and --require-trace
    turn the last two into failures."""
    detail = r.get("detail") or ""
    st = r.get("status")
    if st == "not_applicable":
        return ("fail", f"not applicable, a failure with --strict: {detail}") if strict else \
            ("not applicable", f"not applicable: {detail}")
    if st == "not_observed":
        return ("fail", f"not observed, a failure with --require-trace: {detail}") if require_trace else \
            ("not observed", f"not observed: {detail}")
    return ("pass" if r.get("ok") is True else "fail"), detail


def verdict(recs, timed_out, returncode, timeout, left, channel_closed, strict=False, require_trace=False):
    """The checks for one test from its pipe records and what the runner saw: [{"check", "ok", "status", "detail"}],
    status pass, fail, not applicable or not observed (ok is true only for pass). A record of another shape, or out of
    its place, fails the test (a corrupted or tampered pipe), and is not counted as a check."""
    checks = []

    def add(name, ok, detail):
        checks.append({"check": name, "ok": ok, "status": "pass" if ok else "fail", "detail": detail})

    bad = [(i, r) for i, r in enumerate(recs) if not known_record(r, i, len(recs))]
    for i, r in bad:
        text = r.raw.decode("utf-8", "replace") if isinstance(r, BadLine) else json.dumps(r)
        add("the result pipe carries only the test's records", False, f"line {i + 1}: {_short(text, 200)}")
    recs = [r for i, r in enumerate(recs) if known_record(r, i, len(recs))]
    declared = recs[0].get("declare") if recs and isinstance(recs[0], dict) and "declare" in recs[0] else None
    ended = any(isinstance(r, dict) and r.get("end") is True for r in recs)
    counted = 0
    for r in recs:
        if isinstance(r, dict) and "check" in r:
            harness = r.get("harness") is True
            counted += not harness
            st, detail = status_of(r, strict, require_trace)
            checks.append({"check": str(r.get("check")), "ok": st == "pass", "status": st, "detail": detail})
    if not isinstance(declared, int) or isinstance(declared, bool):
        add("the test declares its number of checks (CHECKS)", False, "no declaration as its first record")
    elif counted != declared:
        add(f"the test recorded the {declared} checks it declares", False, f"{counted} recorded")
    if counted == 0:
        add("the test recorded checks", False, "no check was recorded")
    if timed_out:
        add(f"finished within {timeout} s", False, "ended by the runner")
    else:
        if returncode != 0:
            add("the test process exited cleanly", False, f"exit {returncode}")
        if not ended:
            add("the test reported its end", False, "no end record")
    if not channel_closed:
        add("the result pipe closed after the test", False, "a process still holds its write end")
    add("nothing left running after the test", not left, "; ".join(f"{pid} {cmd[:120]}" for pid, cmd in left))
    return checks


def run_test(meta, a, base, media, adapter):
    name = meta["name"]
    scratch = os.path.realpath(os.path.join(base, name))
    if AS_USER is None:
        os.makedirs(scratch)
        log_path, trace_copy = os.path.join(scratch, "test.log"), os.path.join(base, f"{name}.adapter-strace.log")
    else:  # the test's folder is shared with the editor's user; the runner's records are not
        shared_folder(scratch)
        records = os.path.join(base, "records")
        log_path, trace_copy = os.path.join(records, f"{name}.log"), os.path.join(records, f"{name}.adapter-strace.log")
    timeout = a.timeout or meta["timeout"]
    t0 = time.time()
    env = dict(os.environ)
    env["JUDGE_TEST_SCRATCH"] = scratch  # the sweep's marker: the test and the adapter carry it
    r, w = os.pipe()
    recs = []

    def read():
        with os.fdopen(r, "rb") as f:
            for line in f:
                try:
                    recs.append(json.loads(line.decode("utf-8")))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    recs.append(BadLine(line))  # not a dict: no line on the pipe can produce one

    with open(log_path, "xb") as logf:
        try:
            p = subprocess.Popen([sys.executable, "-I", "-B", os.path.abspath(__file__), "--child", meta["path"],
                                  "--scratch", scratch, "--results-fd", str(w), "--media", media, "--build", a.build,
                                  "--adapter-json", json.dumps(adapter), "--trace-copy", trace_copy]
                                 + (["--allow-unprotected"] if a.allow_unprotected else [])
                                 + (["--require-trace"] if a.require_trace else [])
                                 + (["--as-user", AS_USER.name] if AS_USER else [])
                                 + (["--graphics-addon", a.graphics_addon] if a.graphics_addon else []),
                                 stdin=subprocess.DEVNULL, stdout=logf, stderr=subprocess.STDOUT,
                                 start_new_session=True, cwd=scratch, env=env, pass_fds=(w,))
        finally:
            os.close(w)
        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        with LIVE_LOCK:
            LIVE[name] = (p, scratch)
        timed_out = False
        try:
            p.wait(timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            _end_group(p)
    left = sweep(scratch)
    if AS_USER is not None:  # the editor's user's processes: the sweep above cannot read their environment
        found, still = AS_USER.sweep()
        left += found + [(pid, f"(still running after the user sweep) {cmd}") for pid, cmd in still]
    reader.join(10)
    with LIVE_LOCK:
        LIVE.pop(name, None)
    checks = verdict(list(recs), timed_out, p.returncode, timeout, left, not reader.is_alive(), a.strict,
                     a.require_trace)
    for c in checks:
        c["test"] = name
    with PRINT_LOCK:
        RESULTS.extend(checks)
        for c in checks:
            detail = _short(c.get("detail") or "", 400)
            print(f"{LABEL[c['status']]}  {name}: {c['check']}" + (f"  -- {detail}" if detail else ""), flush=True)
        print(f"      {name}: {time.time() - t0:.1f} s, scratch {scratch}", flush=True)
    return checks


def _on_signal(base):
    def handler(signum, frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        with LIVE_LOCK:
            live = list(LIVE.values())
        for p, _ in live:
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
        deadline = time.time() + 5
        while time.time() < deadline and any(p.poll() is None for p, _ in live):
            time.sleep(0.1)
        for p, _ in live:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        for _, scratch in live:
            if scratch:
                sweep(scratch)
        if AS_USER is not None:
            AS_USER.sweep()
        passed = sum(1 for c in RESULTS if c["status"] == "pass")
        judged = sum(1 for c in RESULTS if c["status"] in ("pass", "fail"))
        try:
            sys.stdout.flush()
        except Exception:  # noqa: BLE001
            pass
        os.write(1, (f"JUDGE: interrupted by signal {signum} ({passed}/{judged} checks passed before it)\n"
                     f"judge: scratch kept for inspection: {base}\n").encode())
        os._exit(1)
    return handler


def absolute_words(words):
    """Adapter command words that name an existing path relative to the current folder, made absolute."""
    return [os.path.abspath(w) if not os.path.isabs(w) and os.path.exists(w) else w for w in words]


def main():
    # First, in every mode: the runner (the pipe's read end) and the test child (its write end) both run main.
    unprotected = no_dump("child" if "--child" in sys.argv else "runner")
    if hasattr(os, "register_at_fork"):
        os.register_at_fork(after_in_child=_after_fork_in_child)
    if unprotected:
        print(f"judge: unprotected: the result pipe can be reopened through /proc by a process of the same user "
              f"({unprotected})", file=sys.stderr, flush=True)
    ap = argparse.ArgumentParser(description="Run the judge's tests against an editor build.")
    ap.add_argument("--adapter", help="adapter command (shell words); a word naming an existing relative path is made "
                                      "absolute, because the adapter runs in the test's scratch folder")
    ap.add_argument("--build", default=os.path.dirname(JUDGE))
    ap.add_argument("--only")
    ap.add_argument("--timeout", type=int)
    ap.add_argument("--jobs", type=int, default=2)
    ap.add_argument("--scratch", default=os.environ.get("JUDGE_SCRATCH") or None)
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--strict", action="store_true",
                    help="a check recorded as not applicable (its hostile input could not be made from the editor's "
                         "saved file) fails")
    ap.add_argument("--require-trace", action="store_true",
                    help="a check recorded as not observed (no usable strace) fails; with --self-test the "
                         "trace cases must run")
    ap.add_argument("--allow-unprotected", action="store_true",
                    help="run even when the runner or a test process cannot be made non-dumpable (not Linux, or prctl "
                         "fails); the JUDGE line then says UNPROTECTED. For development only; CI never passes it")
    ap.add_argument("--as-user", metavar="NAME",
                    help="run the adapter, the editor and everything they start as this other user, through sudo -n "
                         "(judge.yml: zjudge); with --self-test, run the --as-user cases as this user")
    ap.add_argument("--graphics-addon", metavar="DIR", default=os.environ.get("JUDGE_GRAPHICS_ADDON") or None,
                    help="the graphics add-on to give the editor (Remotion and its headless shell, as "
                         "judge/fixtures/graphics-addon/install.sh makes it); without it the checks that need the "
                         "add-on are not applicable")
    ap.add_argument("--tests", default=os.path.join(JUDGE, "tests"), help=argparse.SUPPRESS)
    # child mode (one test, started by the runner)
    ap.add_argument("--child", help=argparse.SUPPRESS)
    ap.add_argument("--results-fd", help=argparse.SUPPRESS)
    ap.add_argument("--media", help=argparse.SUPPRESS)
    ap.add_argument("--adapter-json", help=argparse.SUPPRESS)
    ap.add_argument("--trace-copy", help=argparse.SUPPRESS)
    a = ap.parse_args()
    global REQUIRE_TRACE, AS_USER
    REQUIRE_TRACE = a.require_trace
    if a.child:
        if a.as_user:
            AS_USER = AsUser(a.as_user)  # the runner checked it (AsUser.problem) before it started any test
        return child(a, unprotected)
    if a.self_test:
        import selftest
        return selftest.main(os.path.abspath(__file__), a.scratch, a.allow_unprotected, a.require_trace, a.as_user)

    a.build = os.path.abspath(a.build)
    tests_dir = os.path.abspath(a.tests)
    tests = sorted(os.path.join(tests_dir, f) for f in os.listdir(tests_dir)
                   if f.startswith("test_") and f.endswith(".py"))
    if a.only:
        tests = [t for t in tests if a.only in os.path.basename(t)]
    metas = [load_meta(t) for t in tests]
    if a.list:
        for m in metas:
            print(f"{m['name']}  port_bound={m['port_bound']}  timeout={m['timeout']}")
        return 0
    if not metas:
        print("JUDGE: 0/0 passed (no tests selected)")
        return 1
    if unprotected and not a.allow_unprotected:
        print(f"JUDGE: refused: the runner is not protected ({unprotected}): a process of the same user could reopen "
              f"the result pipe through /proc. --allow-unprotected runs anyway (development only)", flush=True)
        return 1
    if a.as_user:
        try:
            au = AsUser(a.as_user)
        except KeyError:
            print(f"JUDGE: refused: --as-user {a.as_user}: no such user", flush=True)
            return 1
        why = au.problem()
        if why:
            print(f"JUDGE: refused: --as-user {a.as_user}: {why}", flush=True)
            return 1
        AS_USER = au
        os.umask(0o022)  # the fixtures and every file the tests write must be readable by the editor's user
        a.jobs = 1  # the user sweep after a test ends every process of that user: no other test may run meanwhile

    addon = None
    if a.graphics_addon:
        addon, why = graphics_addon(a.graphics_addon)
        if why is None and AS_USER is not None:  # the editor's user reads it and must not be able to change it
            for d in (addon["root"], os.path.join(addon["root"], "node_modules"), os.path.dirname(addon["browser"])):
                why = why or AS_USER.folder_problem(d)
        if why:
            print(f"JUDGE: refused: --graphics-addon {a.graphics_addon}: {why}", flush=True)
            return 1
        a.graphics_addon = addon["root"]

    import observe
    parent = a.scratch or tempfile.gettempdir()
    os.makedirs(parent, exist_ok=True)
    base = os.path.realpath(tempfile.mkdtemp(prefix="judge-", dir=parent))
    if AS_USER is not None:
        os.chmod(base, 0o755)
        why = AS_USER.folder_problem(base)
        if why:
            shutil.rmtree(base, ignore_errors=True)
            print(f"JUDGE: refused: --as-user {AS_USER.name}: the run's folder {base}: {why} (give --scratch a folder "
                  f"that user can enter but not change)", flush=True)
            return 1
        os.mkdir(os.path.join(base, "records"), 0o700)
    handler = _on_signal(base)
    signal.signal(signal.SIGTERM, handler)
    signal.signal(signal.SIGINT, handler)
    if a.adapter:
        adapter = absolute_words(shlex.split(a.adapter))
    elif AS_USER is None:
        adapter = [sys.executable, "-I", "-B", os.path.join(JUDGE, "adapters", "v020", "adapter.py")]
    else:  # a copy the editor's user can read (it may not reach judge/), and cannot change
        adir = os.path.join(base, "adapter")
        os.mkdir(adir, 0o755)
        shutil.copyfile(os.path.join(JUDGE, "adapters", "v020", "adapter.py"), os.path.join(adir, "adapter.py"))
        os.chmod(os.path.join(adir, "adapter.py"), 0o444)
        adapter = [sys.executable, "-I", "-B", os.path.join(adir, "adapter.py")]
    print(f"judge: adapter {' '.join(adapter)}")
    if AS_USER is not None:
        print(f"judge: as user {AS_USER.name} (uid {AS_USER.uid}) through sudo -n: the adapter, the editor and what "
              f"they start; the runner's records in {os.path.join(base, 'records')}; one test at a time")
    else:
        print("judge: note: the adapter and the editor run as this user (a local run). CI runs them as another user "
              "(--as-user zjudge), which closes the same-user gaps listed in judge/README.md, \"Threat model\"")
    print(f"judge: build {a.build}")
    print(f"judge: graphics add-on {addon['root']} (headless shell {addon['browser']})" if addon
          else f"judge: graphics add-on: none, so the checks on it are not applicable: {NO_GRAPHICS_ADDON}")
    print(f"judge: measurements with {observe.ffmpeg_version()} ({observe.FFMPEG})")
    print(f"judge: trace with {strace() or f'nothing ({strace_why()}): the trace checks are not observed'}"
          + (" (--seccomp-bpf)" if _STRACE.get("bpf") else "")
          + ("; --strict" if a.strict else "") + ("; --require-trace" if a.require_trace else ""))
    print(f"judge: scratch {base}", flush=True)

    media = os.path.join(base, "media")
    mk = subprocess.Popen(["bash", os.path.join(JUDGE, "fixtures", "make.sh"), media], stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True, stdin=subprocess.DEVNULL, start_new_session=True)
    with LIVE_LOCK:
        LIVE["fixtures"] = (mk, None)
    try:
        _, mk_err = mk.communicate(timeout=600)
    except subprocess.TimeoutExpired:
        _end_group(mk)
        _, mk_err = mk.communicate()
    with LIVE_LOCK:
        LIVE.pop("fixtures", None)
    if mk.returncode != 0:
        print(f"FAIL  fixtures: judge/fixtures/make.sh exit {mk.returncode}  -- {_short(mk_err, 600)}")
        print("JUDGE: 0/1 passed")
        print(f"judge: scratch kept for inspection: {base}")
        return 1

    results = []
    free = [m for m in metas if not m["port_bound"]]
    bound = [m for m in metas if m["port_bound"]]
    with ThreadPoolExecutor(max_workers=max(1, a.jobs)) as pool:
        for checks in pool.map(lambda m: run_test(m, a, base, media, adapter), free):
            results += checks
    for m in bound:
        results += run_test(m, a, base, media, adapter)

    passed = sum(1 for c in results if c["status"] == "pass")
    judged = sum(1 for c in results if c["status"] in ("pass", "fail"))
    ok = passed == judged and judged > 0
    tests_unprotected = sum(1 for c in results if c["check"] == PROTECTED_CHECK)
    mark = ""
    if unprotected or tests_unprotected:
        mark = (" UNPROTECTED (" + ", ".join(([f"runner: {unprotected}"] if unprotected else [])
                                             + ([f"{tests_unprotected} test process(es)"] if tests_unprotected else []))
                + ")")
    counts = ""
    for st in ("not applicable", "not observed"):
        named = [c for c in results if c["status"] == st]
        if named:
            counts += f", {len(named)} {st}"
            print(f"judge: {len(named)} check(s) {st} (neither passed nor failed; "
                  + ("--strict" if st == "not applicable" else "--require-trace") + " fails them):")
            for c in named:
                print(f"judge:   {c['test']}: {c['check']}")
    print(f"JUDGE: {passed}/{judged} passed{counts}{mark}", flush=True)
    if ok and not a.keep:
        if AS_USER is not None:
            AS_USER.remove(base)  # it holds files and folders of the editor's user
        shutil.rmtree(base, ignore_errors=True)
    elif not ok:
        print(f"judge: scratch kept for inspection: {base}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
