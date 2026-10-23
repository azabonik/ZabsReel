"""The runner's own tests (python3 -I judge/run.py --self-test): each way a test can go wrong must fail the run, and
a clean test must pass it. Each case runs the real runner (run.py) as a separate process on a small fixture test
written to a temp folder, never under judge/, and checks its exit code and output. Then the v0.2.0 adapter's and
check_observe.py's own self-tests run (they need no editor).

Cases: a clean test passes (with and without the editor driver); a crash, a hang past TIMEOUT, sys.exit(0) in the
middle, no checks, fewer or more checks than CHECKS, no CHECKS, a process left running by the test or by the adapter,
an adapter that speaks another protocol version, an adapter that writes passing results into every file of the test's
scratch folder, and lines on the result pipe that are not the test's records (not JSON, not UTF-8, JSON of another
shape, a declaration out of place) each fail the run. On Linux an adapter that opens the test's and the runner's
descriptors through /proc/<pid>/fd for writing is refused every time (they are non-dumpable) and the verdict is
unchanged; a fork without exec that leaves the session and closes its descriptors fails the run and is ended; a fork
child that writes through the result pipe's descriptor number gets EBADF and the verdict is unchanged. When the runner
or a test process cannot make itself non-dumpable (forced with JUDGE_FORCE_UNPROTECTED) the run fails; with
--allow-unprotected it passes and its JUDGE line says UNPROTECTED. SIGTERM to the runner ends the test and what it
started and prints the interrupted JUDGE line. A relative --adapter path works (the runner makes it absolute).

Statuses: a check recorded as not applicable (directly, or through T.check(needs=...) on an input observe.craft could
not make) passes the run and is counted on the JUDGE line, and fails it with --strict; a check recorded as not observed
passes and is counted, and fails with --require-trace. A test that asks for the graphics add-on gets it in the adapter's
start with --graphics-addon (the fixture adapter writes what it got), records its check as not applicable without it (a
failure with --strict), and a --graphics-addon folder with another Remotion version or no headless shell is refused. The
download tripwire: an adapter that starts a DNS lookup (a UDP connect to 192.0.2.1 port 53), makes a UDP connect to
192.0.2.1 port 9 and writes with write(), sends with sendto() to 192.0.2.1 port 9, or starts a TCP connect to 192.0.2.1
port 80 fails the run's "nothing was downloaded" check. The adapter cannot reach the trace: one that starts a DNS lookup
and at stop rewrites, empties or deletes every file it can reach (the scratch folder, and the logs next to it with the
copy of the trace), or one that writes a partial strace line to every descriptor it holds, to strace's descriptors
through /proc and to those files and then overwrites the lookup's port in those files, still fails the check on the
lookup itself, and its open of strace's trace channel (a socket) through /proc is refused (ENXIO). One that ends strace
fails the check (the trace ended before stop). One that leaves a traced child running at stop that starts a DNS lookup
once strace no longer traces it fails the run: the test process's sweep ends it (left running after stop), or, with an
empty environment the sweep cannot read, the trace does not end and the download check fails. A line that is not of
strace's form (text joined to an strace line, a line cut short) fails the line check; real strace lines pass it.
strace's own error message at the end of the trace (tracetail_units: after a call it cut short, or alone) fails the
download check, and allows a rerun only when strace exited 1 with --kill-on-exit and no line, the cut call included,
addressed another computer; the same text inside a quoted string, in front of another line, cut short, under another
path, with a quote in it, or after a line that is not of strace's form does not. A test whose download check records
that strace failed runs once more: a second run that passes prints FLAKY, counts on the JUDGE line ("1 flaky
(strace)"), keeps the run's folder and the first run's as <test>.try1 with its verdict in its log, and writes
--flaky-file (which must be new); a second run that fails fails the test; at most two tests a run are rerun; a rerun
marker on any other record is a line that is not one of the test's records. An
adapter that asks for an io_uring is refused one (strace injects ENOSYS). One that makes a UDP connect to 127.0.0.1 and
Chromium's IPv6 probe ([2001:4860:4860::8888]:443, no packet) passes the check. With strace switched off (JUDGE_STRACE
empty) the check is not observed, a failure with --require-trace; a JUDGE_STRACE that runs its command without tracing
it is not used (the check is not observed), and with --require-trace it fails the run, as does a JUDGE_STRACE that is a
symbolic link in a folder this user can write (without --require-trace its real path runs). The cases that need strace
are skipped without it, unless --require-trace is given (judge.yml): then a missing strace fails the self-test.

T.look's stat and read (look_units): a file's kind, mode, size and bytes, a link's target, a folder; no link is
followed at the path, a file over 1 MiB is not read, and nothing is looked at whose folder, made real, is outside the
test's folder (also through a link to a folder outside it).

judge.yml's parts (ci_scripts, lockout_units): ci/quiet.sh, in both forms, prints a command's output that holds
workflow commands between ::stop-commands::<token> and ::<token>:: with a new token that is in neither the command's
arguments nor its environment, and keeps its exit code; ci/collect_logs.sh copies only the regular *.log and *.stderr
files, not a link to a file of this user's, a FIFO or a linked folder. lockout.py skips a file that was listed and then
removed only in a diagnostic-log folder of the runner's that is tried (and still tightens that folder); one removed
elsewhere, under a sticky folder above a PATH, or a PATH folder that was removed, fails. It passes only sudo's own
refusal of the build user, and fails a build user that shares a group with this user.

--as-user: the runner refuses the user that runs it, root, and a user that does not exist, before anything runs. With
--self-test --as-user <name> (judge.yml: zjudge; skipped without it, failed when sudo -n does not work) the fixture
adapter runs as that user (user_cases): it passes clean; its DNS lookup fails the download check; its attempts to
change the judge's files and the runner's records, to list and open the descriptors of strace, sudo and the test
process through /proc and to send them signal 0 are all refused (SelfTest.asuser); and the child it leaves with an
empty environment fails the run and is ended by the user sweep; its environment holds only run.AsUser.env_words (and
PWD), without a canary set in the runner's. A user that already runs a process is refused, and so, in this process
(asuser_units), are one that shares a group with this user, fs.protected_symlinks at 0, an env this user owns, and a
sudo -n that cannot run a command as root. That user's private file (0600 in a 0700 folder) is read by AsUser.look and
not by this user, and a link it planted to a file of this user's is followed by neither. A --scratch folder the user
can write or owns is refused, and a
JUDGE_STRACE in a folder of that user's is not used. A world-writable diagnostic-log folder of the runner's still
fails the probe when a file in it was removed after it was listed (the file is skipped), and the probe names an item
that is not there as gone. lockout.py --no-tighten finds a world-writable folder and file, lockout.py takes
their write bit away, and --kill ends the user's processes first. lockout.py --fail-if-writable fails on a file there
that others could write, a PATH folder that is not there is tried through the nearest folder above it (a sticky one
that others can write fails), and --kill with no PATH removes the user's crontab and ends its processes.
"""
import json
import os
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

JUDGE = os.path.dirname(os.path.abspath(__file__))
NET = "nothing was downloaded: no process of the adapter or the editor addressed another computer"  # run.NET_CHECK
PROTECTED = "the test process is non-dumpable (its result pipe cannot be reopened through /proc)"  # run.PROTECTED_CHECK

HEAD = "import os, subprocess, sys, time\n"
# strace's own message as TraceTail.tampered words it, in a fixture's download check (RERUN_FIXTURE).
STRACE_FAILED = ("strace failed while the editor ran (ptrace(PTRACE_LISTEN,pid:1,sig:0): Input/output error); the "
                 "trace ends there, so what the editor did after it was not seen")
RERUN_FIXTURE = ("PORT_BOUND = False\nCHECKS = 1\ndef run(t):\n    t.check('a passing check', True)\n"
                 "    r = sys.modules[type(t).__module__]\n    first = {first}\n"
                 "    t._record(r.NET_CHECK, not first, " + repr(STRACE_FAILED) + " if first else 'no other computer "
                 "addressed', True, None, r.RERUN_STRACE if first else None)\n")
# --as-user: the runner's environment holds this canary for the asuser run (SelfTest.asuser); the adapter must not.
CANARY = ("JUDGE_SELFTEST_SECRET", "canary-the-runners-environment-must-not-reach-the-adapter")
# The adapter's whole environment under --as-user: run.AsUser.env_words (and nothing else: no GITHUB_*, ACTIONS_*,
# tokens, SUDO_*), plus PWD, which the shell that starts the adapter (run.TRACEE_AS_USER) sets.
ADAPTER_ENV = {"PATH", "LANG", "HOME", "TMPDIR", "USER", "LOGNAME", "JUDGE_TEST_SCRATCH", "AIVE_FFMPEG", "AIVE_FFPROBE",
               "PWD"}

TESTS = {
    "ok": "PORT_BOUND = False\nCHECKS = 1\ndef run(t):\n    t.check('a passing check', True)\n",
    "crash": "PORT_BOUND = False\nCHECKS = 2\ndef run(t):\n    t.check('one', True)\n    os._exit(3)\n",
    "hang": "PORT_BOUND = False\nCHECKS = 1\nTIMEOUT = 3\ndef run(t):\n    t.check('one', True)\n"
            "    time.sleep(120)\n",
    "sysexit": "PORT_BOUND = False\nCHECKS = 2\ndef run(t):\n    t.check('one', True)\n    sys.exit(0)\n"
               "    t.check('two', True)\n",
    "zero": "PORT_BOUND = False\nCHECKS = 0\ndef run(t):\n    pass\n",
    "fewer": "PORT_BOUND = False\nCHECKS = 3\ndef run(t):\n    t.check('one', True)\n    t.check('two', True)\n",
    "more": "PORT_BOUND = False\nCHECKS = 1\ndef run(t):\n    t.check('one', True)\n    t.check('two', True)\n",
    "undeclared": "PORT_BOUND = False\ndef run(t):\n    t.check('one', True)\n",
    # Records the one check it declares, then writes lines that are not records onto its result pipe.
    "malformed": "PORT_BOUND = False\nCHECKS = 1\ndef run(t):\n    t.check('one', True)\n    t._out.flush()\n"
                 "    for b in (b'not json\\n', b'\\xff\\n', b'{\"forged\": 1}\\n', b'[1]\\n',\n"
                 "              b'{\"check\": \"x\", \"ok\": \"yes\", \"detail\": \"\"}\\n', b'{\"declare\": 1}\\n'):\n"
                 "        os.write(t._out.fileno(), b)\n",
    "leak": "PORT_BOUND = False\nCHECKS = 1\ndef run(t):\n"
            "    p = subprocess.Popen(['sleep', '300'], start_new_session=True)\n"
            "    open(t.path('leak.pid'), 'w').write(str(p.pid))\n    t.check('one', True)\n",
    # A fork without exec: the child leaves the test's session, closes every descriptor and sleeps. It inherits
    # non-dumpable unless the runner's fork hook makes it dumpable again; then the sweep can read its environment.
    "fork": "PORT_BOUND = False\nCHECKS = 1\ndef run(t):\n    pid = os.fork()\n    if pid == 0:\n"
            "        os.setsid()\n        os.closerange(3, 256)\n        time.sleep(120)\n        os._exit(0)\n"
            "    open(t.path('fork.pid'), 'w').write(str(pid))\n    t.check('one', True)\n",
    # A fork child that keeps every descriptor and writes a passing record through the result pipe's number: the fork
    # hook has closed it, so the write gives EBADF and the verdict is unchanged.
    "forkwrite": "PORT_BOUND = False\nCHECKS = 1\ndef run(t):\n    fd = t._out.fileno()\n"
                 "    r, w = os.pipe()\n    pid = os.fork()\n    if pid == 0:\n        try:\n"
                 "            os.write(fd, b'{\"check\": \"forged\", \"ok\": true, \"detail\": \"\"}\\n')\n"
                 "            res = b'written'\n        except OSError as e:\n"
                 "            res = (os.strerror(e.errno) if e.errno else str(e)).encode()\n"
                 "        os.write(w, res)\n        os._exit(0)\n    os.close(w)\n    os.waitpid(pid, 0)\n"
                 "    res = os.read(r, 200).decode()\n"
                 "    t.check('the fork child cannot write to the result pipe', res == os.strerror(9), res)\n",
    # The editor driver with a fixture adapter (FAKE below); which behaviour is chosen by the --adapter words.
    "driver": "CHECKS = 1\ndef run(t):\n    t.driver()\n    t.check('the fixture editor started', True)\n",
    "forge": "CHECKS = 1\ndef run(t):\n    t.driver()\n    t.check('a check the editor fails', False)\n",
    # A check on an input that observe.craft made, one on an input it could not make (not applicable), and one
    # recorded as not applicable directly.
    "na": "import json, observe\nPORT_BOUND = False\nCHECKS = 3\ndef run(t):\n"
          "    src = t.path('saved.json')\n"
          "    open(src, 'w').write(json.dumps({'path': '/m/a.mp4', 'n': 113}))\n"
          "    made = observe.craft(src, t.path('made.json'), [('/m/a.mp4', '//h/s/a.mp4')], 'the media path')\n"
          "    lost = observe.craft(src, t.path('lost.json'), [('/m/b.mp4', 'x'), (113, 1)], 'the clip path')\n"
          "    t.check('a check on a crafted file', json.load(open(made.path))['path'] == '//h/s/a.mp4', needs=made)\n"
          "    t.check('a check whose input cannot be made', False, 'never recorded', needs=[made, lost])\n"
          "    t.not_applicable('a check recorded as not applicable', 'the reason')\n",
    # The graphics add-on (--graphics-addon): the fixture adapter (mode addon) writes what start gave it to addon.json.
    "addon": "import json\nCHECKS = 1\ndef run(t):\n    t.driver(graphics_addon=True)\n"
             "    got = json.load(open(os.path.join(t.scratch, 'addon.json')))\n"
             "    name = \"the adapter got the judge's graphics add-on in start\"\n"
             "    if t.graphics_addon is None and got is None:\n        t.not_applicable(name, t.graphics_addon_why)\n"
             "    else:\n        t.check(name, got is not None and got == t.graphics_addon, got)\n",
    "nobs": "PORT_BOUND = False\nCHECKS = 2\ndef run(t):\n    t.check('a passing check', True)\n"
            "    t.not_observed('a trace check', 'strace is not installed')\n",
    # The download check's record as T.finish writes it when strace itself failed while the editor ran (run.strace_failed),
    # on the first run (the runner keeps that run's folder as <folder>.try1). "rerunpass" passes its second run;
    # "rerunfail" and "budget1".."budget3" record it on every run.
    "rerunpass": RERUN_FIXTURE.format(first="not os.path.isdir(t.scratch + '.try1')"),
    "rerunfail": RERUN_FIXTURE.format(first="True"),
    "budget1": RERUN_FIXTURE.format(first="True"),
    "budget2": RERUN_FIXTURE.format(first="True"),
    "budget3": RERUN_FIXTURE.format(first="True"),
    # Records that carry "rerun" where T.finish never writes it: on another check, on a passed download check, on one
    # that is not the runner's, and with another value. Each is a line that is not one of the test's records.
    "rerunbad": "import json\nPORT_BOUND = False\nCHECKS = 1\ndef run(t):\n    t.check('one', True)\n"
                "    t._out.flush()\n    net = sys.modules[type(t).__module__].NET_CHECK\n"
                "    for r in ({'check': 'x', 'ok': False, 'harness': True},\n"
                "              {'check': net, 'ok': True, 'harness': True},\n"
                "              {'check': net, 'ok': False},\n"
                "              {'check': net, 'ok': False, 'harness': True, 'rerun': 'other'}):\n"
                "        r = {'detail': 'forged', 'rerun': 'strace', **r}\n"
                "        os.write(t._out.fileno(), (json.dumps(r) + '\\n').encode())\n",
    "interrupt": "PORT_BOUND = False\nCHECKS = 1\nTIMEOUT = 600\ndef run(t):\n"
                 "    p = subprocess.Popen(['sleep', '300'], start_new_session=True)\n"
                 "    open(t.path('pids.tmp'), 'w').write(f'{os.getpid()} {p.pid}')\n"
                 "    os.rename(t.path('pids.tmp'), t.path('pids'))\n"
                 "    t.check('one', True)\n    time.sleep(600)\n",
}

# A fixture adapter: fake_adapter.py <protocol> <mode>. mode "leak" leaves a process running at stop; "forge" writes
# passing result lines into results.jsonl and every other file it can find under its scratch folder; "procfd" lists
# the descriptors it holds, then tries to open every descriptor of the test process (its nearest ancestor started
# with --child; strace may sit between them) and of the runner (that process's parent) for writing through
# /proc/<pid>/fd, writes a passing record through any it opens, and reports each attempt in procfd.json in its scratch
# folder. At start, "connect" starts a DNS lookup (a UDP connect to 192.0.2.1, TEST-NET-1, port 53), "udp" makes a UDP
# connect to 192.0.2.1 port 9 and sends with write() (not a traced call), "udpsend" sends with sendto() to 192.0.2.1
# port 9 on an unconnected socket, "tcp" starts a non-blocking TCP connect to 192.0.2.1 port 80, "uring" asks for an
# io_uring and refuses start when it gets one, "rewrite", "truncate" and "unlink" start a DNS lookup and at stop
# rewrite every file under the scratch folder and every log next to it (the test process's copy of the trace) without
# it (padded to more than its old length), empty them or delete them, "inject" writes a partial strace line to every
# descriptor it holds (but 0 and 1), to strace's descriptors through /proc and to those files, then starts a DNS
# lookup and overwrites its port in place in those files, "killstrace" ends strace (its parent) and then starts a
# DNS lookup, "outlive" and "outlivehidden" leave a child running at stop (OUTLIVE) that waits until strace no longer
# traces it and then starts a DNS lookup ("outlivehidden" with an empty environment, which the sweep cannot find), and
# "loopback" makes a UDP connect to 127.0.0.1 and one to [2001:4860:4860::8888]:443 (Chromium's reachability
# probe, which observe.net_hits allows). "asuser <judge folder>" (run.py --as-user) tries at start to change the judge
# and the records and to reach strace, sudo and the test process (asuser.json), and leaves a child with an empty
# environment at stop (asuser.pid).
FAKE = r'''import errno, json, os, socket, subprocess, sys, time
proto, mode = int(sys.argv[1]), sys.argv[2]
extra = sys.argv[3:]
scratch = None
FORGED = json.dumps({"check": "forged", "ok": True, "detail": ""}) + "\n"

def forge():
    if not scratch:
        return
    with open(os.path.join(scratch, "results.jsonl"), "w") as f:
        f.write(json.dumps({"declare": 3}) + "\n" + FORGED * 3 + json.dumps({"end": True}) + "\n")
    for d, _, files in os.walk(scratch):
        for n in files:
            try:
                with open(os.path.join(d, n), "a") as f:
                    f.write(FORGED)
            except OSError:
                pass
    for fd in range(3, 64):  # any inherited descriptor
        try:
            os.write(fd, FORGED.encode())
        except OSError:
            pass

def procfd():
    own = []
    for fd in range(3, 64):  # before anything below opens a descriptor
        try:
            os.fstat(fd)
            own.append(fd)
        except OSError:
            pass
    def parent(pid):
        with open(f"/proc/{pid}/stat", "rb") as f:
            return int(f.read().rsplit(b")", 1)[1].split()[1])
    test = parent(os.getpid())
    while test > 1:
        with open(f"/proc/{test}/cmdline", "rb") as f:
            argv = f.read().split(b"\0")
        if b"--child" in argv:
            break
        test = parent(test)
    runner = parent(test)
    results_fd = int(argv[argv.index(b"--results-fd") + 1])
    report = {"own_fds": own, "test": test, "runner": runner, "results_fd": results_fd, "attempts": {}}
    for who, pid in (("test", test), ("runner", runner)):
        try:
            listed = sorted(int(n) for n in os.listdir(f"/proc/{pid}/fd"))
        except OSError as e:
            listed = type(e).__name__
        tried = {}
        for n in range(0, 64):
            try:
                fd = os.open(f"/proc/{pid}/fd/{n}", os.O_WRONLY | os.O_NONBLOCK)
            except OSError as e:
                tried[n] = type(e).__name__
                continue
            tried[n] = "opened"
            try:
                os.write(fd, FORGED.encode())
            except OSError:
                pass
            os.close(fd)
        report["attempts"][who] = {"listed": listed, "open": tried}
    with open("procfd.json", "w") as f:
        json.dump(report, f)

def udp(family, addr, send=None):
    try:
        s = socket.socket(family, socket.SOCK_DGRAM)
    except OSError:
        return  # no IPv6 here
    try:
        if send is None:
            s.connect(addr)
            if mode == "udp":
                os.write(s.fileno(), b"x")  # write() on a connected UDP socket: not a traced call
        else:
            s.sendto(send, addr)
    except OSError:
        pass  # no route (a network namespace without one): the call is still traced
    s.close()

def logs():
    """Every file under the scratch folder, and every log next to it (the test process's copy of the trace)."""
    found = [os.path.join(d, n) for d, _, files in os.walk(scratch) for n in files]
    parent = os.path.dirname(scratch)
    return found + [os.path.join(parent, n) for n in os.listdir(parent) if n.endswith(".log")]

def tamper(mode):
    """At stop: every file the adapter can reach (logs()) rewritten without the DNS lookup's line (padded to more than
    its old length), emptied, or deleted."""
    for log in logs():
        try:
            if mode == "unlink":
                os.unlink(log)
                continue
            with open(log, "r", encoding="latin-1") as f:
                kept = [ln for ln in f if "htons(53)" not in ln]
            with open(log, "w", encoding="latin-1") as f:
                if mode == "rewrite":
                    f.write("".join(kept) + "0 getpid() = 0\n" * 400)
        except OSError:
            pass

PARTIAL = b'0 open(""'  # a line strace never ends this way: the next line written after it would join it

def strace_fds():
    """Descriptors of the processes between this adapter and the test process (strace), as /proc paths; not 0 and 1
    (the protocol's pipes)."""
    out, pid = [], os.getppid()
    while pid > 1:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            if b"--child" in f.read().split(b"\0"):
                break
        out += [f"/proc/{pid}/fd/{n}" for n in range(2, 64)]
        with open(f"/proc/{pid}/stat", "rb") as f:
            pid = int(f.read().rsplit(b")", 1)[1].split()[1])
    return out

def inject():
    """Before the DNS lookup: PARTIAL, without a newline, written to every place the adapter can reach: its own
    descriptors but 0 and 1, strace's descriptors through /proc, and logs(). What it reached is in inject.json."""
    reached = {}
    for fd in range(2, 64):
        try:
            os.write(fd, PARTIAL)
            reached[f"fd {fd}"] = "written"
        except OSError as e:
            reached[f"fd {fd}"] = errno.errorcode.get(e.errno, type(e).__name__)
    for path in strace_fds() + logs():
        try:
            fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_NONBLOCK)
        except OSError as e:
            reached[path] = errno.errorcode.get(e.errno, type(e).__name__)
            continue
        try:
            os.write(fd, PARTIAL)
            reached[path] = "written"
        except OSError as e:
            reached[path] = errno.errorcode.get(e.errno, type(e).__name__)
        os.close(fd)
    with open(os.path.join(scratch, "inject.json"), "w") as f:
        json.dump(reached, f)

def overwrite():
    """After the DNS lookup: its port, overwritten in place (same size) in every file the adapter can reach."""
    for log in logs():
        try:
            with open(log, "r+b") as f:
                data = f.read()
                if b"htons(53)" in data:
                    f.seek(0)
                    f.write(data.replace(b"htons(53)", b"htons(54)"))
        except OSError:
            pass

def chain():
    """The process ids from this adapter's parent up to the test process (the nearest ancestor started with --child):
    strace and sudo between them under --as-user."""
    out, pid = [], os.getppid()
    while pid > 1:
        out.append(pid)
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            if b"--child" in f.read().split(b"\0"):
                return out
        with open(f"/proc/{pid}/stat", "rb") as f:
            pid = int(f.read().rsplit(b")", 1)[1].split()[1])
    return out

def err(e):
    return errno.errorcode.get(e.errno, type(e).__name__) if e.errno else type(e).__name__

def change_file(p):
    """[open for appending (nothing written), chmod to its own mode]: "opened" / "chmod", or the error of each."""
    try:
        fd = os.open(p, os.O_WRONLY | os.O_APPEND | os.O_NONBLOCK)
    except OSError as e:
        res = [err(e)]
    else:
        os.close(fd)
        res = ["opened"]
    try:
        os.chmod(p, os.stat(p).st_mode & 0o7777)
    except OSError as e:
        return res + [err(e)]
    return res + ["chmod"]

def change_folder(d):
    """[add a file (removed again), chmod to its own mode]: "added" / "chmod", or the error of each."""
    q = os.path.join(d, ".asuser-probe-%d" % os.getpid())
    try:
        fd = os.open(q, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError as e:
        res = [err(e)]
    else:
        os.close(fd)
        os.unlink(q)
        res = ["added"]
    try:
        os.chmod(d, os.stat(d).st_mode & 0o7777)
    except OSError as e:
        return res + [err(e)]
    return res + ["chmod"]

def asuser():
    """--as-user: what the adapter (the editor's user) can reach. It tries to change the judge's folder (argv 3: every
    file and folder it can list there, and run.py and JUDGE.lock by name), the runner's records (records/ next to the
    scratch folder, and the test's log and copy of the trace there by name), and to open every descriptor of each
    process from strace up to the test process through /proc/<pid>/fd, for writing and for reading, to list them, and
    to send each process signal 0. Every attempt is in asuser.json in the scratch folder, with this adapter's whole
    environment."""
    judge = extra[0]
    rep = {"judge": {}, "records": {}, "procs": {}, "env": dict(os.environ)}
    paths = [judge, os.path.join(judge, "run.py"), os.path.join(judge, "JUDGE.lock")]
    for d, dirs, files in os.walk(judge):
        paths += [os.path.join(d, n) for n in dirs + files]
    for p in dict.fromkeys(paths):
        rep["judge"][p] = change_folder(p) if os.path.isdir(p) else change_file(p)
    records = os.path.join(os.path.dirname(scratch), "records")
    rep["records"][records] = change_folder(records)
    for n in ("test_driver.log", "test_driver.adapter-strace.log"):
        rep["records"][os.path.join(records, n)] = change_file(os.path.join(records, n))
    for pid in chain():
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            entry = {"cmd": f.read().replace(b"\0", b" ").decode("utf-8", "replace")[:100], "open": {}}
        try:
            entry["listed"] = sorted(os.listdir(f"/proc/{pid}/fd"))
        except OSError as e:
            entry["listed"] = type(e).__name__
        for n in range(64):
            for flags, how in ((os.O_WRONLY, "w"), (os.O_RDONLY, "r")):
                try:
                    fd = os.open(f"/proc/{pid}/fd/{n}", flags | os.O_NONBLOCK)
                except OSError as e:
                    entry["open"][f"{n}{how}"] = type(e).__name__
                else:
                    os.close(fd)
                    entry["open"][f"{n}{how}"] = "opened"
        try:
            os.kill(pid, 0)
            entry["signal"] = "sent"
        except OSError as e:
            entry["signal"] = type(e).__name__
        rep["procs"][str(pid)] = entry
    with open(os.path.join(scratch, "asuser.json"), "w") as f:
        json.dump(rep, f)

def net(mode):
    if mode == "killstrace":  # strace (this adapter's parent) ended: the lookup after it is not traced
        os.kill(os.getppid(), 9)
        time.sleep(0.5)
        udp(socket.AF_INET, ("192.0.2.1", 53))
    elif mode in ("connect", "rewrite", "truncate", "unlink", "inject"):
        if mode == "inject":
            inject()
        udp(socket.AF_INET, ("192.0.2.1", 53))
        if mode == "inject":
            for _ in range(50):  # the copy of the trace gets the line a moment after the call
                overwrite()
                time.sleep(0.01)
    elif mode == "loopback":
        udp(socket.AF_INET, ("127.0.0.1", 443))
        udp(socket.AF_INET6, ("2001:4860:4860::8888", 443))
    elif mode == "udp":
        udp(socket.AF_INET, ("192.0.2.1", 9))
    elif mode == "udpsend":
        udp(socket.AF_INET, ("192.0.2.1", 9), send=b"x")
    elif mode == "tcp":
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setblocking(False)
        try:
            s.connect(("192.0.2.1", 80))
        except OSError:
            pass  # in progress, or no route: the call is still traced
        s.close()
    elif mode == "uring":
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        params = ctypes.create_string_buffer(120)
        fd = libc.syscall(425, 1, params)  # io_uring_setup (x86_64 and aarch64)
        if fd >= 0:
            os.close(fd)
            return "got an io_uring: the trace did not refuse it"

# A child left running at stop: it waits until strace no longer traces it (strace ended), then starts a DNS lookup.
OUTLIVE = """import socket, time
deadline = time.time() + 120
while time.time() < deadline:
    with open("/proc/self/status") as f:
        if [ln for ln in f if ln.startswith("TracerPid:")][0].split()[1] == "0":
            break
    time.sleep(0.1)
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    s.connect(("192.0.2.1", 53))
except OSError:
    pass
"""

for line in sys.stdin:
    req = json.loads(line)
    op, args = req["op"], req.get("args") or {}
    if op == "hello":
        res = {"protocol": proto, "adapter": "fixture", "ops": ["hello", "start", "stop"]}
    elif op == "start":
        scratch = args["scratch"]
        res = {"product": {"name": "fixture", "version": "0"}, "ports": []}
        if mode == "forge":
            forge()
        if mode == "procfd":
            procfd()
        if mode == "asuser":
            asuser()
        if mode == "addon":
            with open(os.path.join(scratch, "addon.json"), "w") as f:
                json.dump(args.get("graphics_addon"), f)
        why = net(mode)
        if why:
            print(json.dumps({"id": req["id"], "ok": False, "error": {"code": "product_error", "message": why}}),
                  flush=True)
            continue
    elif op == "stop":
        res = {}
        if mode in ("rewrite", "truncate", "unlink"):
            tamper(mode)
        if mode == "leak":
            subprocess.Popen(["sleep", "300"], start_new_session=True)  # inherits this adapter's environment
        if mode in ("outlive", "outlivehidden"):
            c = subprocess.Popen([sys.executable, "-I", "-c", OUTLIVE], start_new_session=True,
                                 env={} if mode == "outlivehidden" else None)
            with open(os.path.join(scratch, mode + ".pid"), "w") as f:
                f.write(str(c.pid))
        if mode == "asuser":  # left running with an empty environment: only the user sweep can find it
            c = subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(300)"], start_new_session=True,
                                 env={}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            with open(os.path.join(scratch, "asuser.pid"), "w") as f:
                f.write(str(c.pid))
        if mode == "forge":
            forge()
    else:
        print(json.dumps({"id": req["id"], "ok": False, "error": {"code": "unsupported", "message": op}}), flush=True)
        continue
    print(json.dumps({"id": req["id"], "ok": True, "result": res}), flush=True)
if mode == "forge":
    forge()
'''

FAKE_ADAPTER = "fake_adapter.py"
# A fake strace: it skips its options and runs the command after "--" without tracing it (what a build step could name
# through JUDGE_STRACE in $GITHUB_ENV).
FAKE_STRACE = "fake_strace.sh"
FAKE_STRACE_SH = '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n'


def _alive(pid):
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            return f.read().rsplit(b")", 1)[1].split()[0] != b"Z"
    except (OSError, IndexError):
        return False


def run_strace_path():
    """The real path of the strace the runner uses (run.strace())."""
    sys.path.insert(0, JUDGE)
    import run
    return run.strace(False)


def run_left():
    """The name of the test process's check on processes left running after stop (run.LEFT_CHECK)."""
    sys.path.insert(0, JUDGE)
    import run
    return run.LEFT_CHECK


def strace_here(require_trace=False):
    """Whether the runner will trace (run.strace(): JUDGE_STRACE, else strace on PATH, it records a child's network
    call, and with --require-trace this user cannot write it)."""
    sys.path.insert(0, JUDGE)
    import run
    return run.strace(require_trace) is not None


class SelfTest:
    def __init__(self, run_py, parent, allow_unprotected=False):
        self.run_py = run_py
        self.allow_unprotected = allow_unprotected  # another system: every runner gets --allow-unprotected
        self.tmp = tempfile.mkdtemp(prefix="judge-selftest-", dir=parent)
        os.chmod(self.tmp, 0o755)  # the --as-user cases: the other user runs the fixture adapter from here
        self.tests = os.path.join(self.tmp, "tests")
        os.makedirs(self.tests)
        for name, body in TESTS.items():
            with open(os.path.join(self.tests, f"test_{name}.py"), "w", encoding="utf-8") as f:
                f.write(HEAD + body)
        with open(os.path.join(self.tmp, FAKE_ADAPTER), "w", encoding="utf-8") as f:
            f.write(FAKE)
        self.fake_strace = os.path.join(self.tmp, FAKE_STRACE)
        with open(self.fake_strace, "w", encoding="utf-8") as f:
            f.write(FAKE_STRACE_SH)
        os.chmod(self.fake_strace, 0o755)
        self.failures = 0

    def addon_fixture(self, name, version=None, shell=True):
        """A folder in the graphics add-on's layout (run.graphics_addon): @remotion/renderer's package.json with
        `version` (default: the one judge/fixtures/graphics-addon pins) and, with `shell`, an executable file where the
        headless shell goes. Nothing in it runs."""
        sys.path.insert(0, JUDGE)
        import run
        if version is None:
            with open(os.path.join(run.GRAPHICS_ADDON_PIN, "package.json"), encoding="utf-8") as f:
                version = json.load(f)["dependencies"]["@remotion/renderer"]
        root = os.path.join(self.tmp, name)
        pkg = os.path.join(root, "node_modules", "@remotion", "renderer")
        os.makedirs(pkg)
        with open(os.path.join(pkg, "package.json"), "w", encoding="utf-8") as f:
            json.dump({"name": "@remotion/renderer", "version": version}, f)
        if shell:
            browser = os.path.join(root, *run.GRAPHICS_ADDON_BROWSER)
            os.makedirs(os.path.dirname(browser))
            with open(browser, "w", encoding="utf-8") as f:
                f.write("#!/bin/sh\nexit 1\n")
            os.chmod(browser, 0o755)
        return root

    def runner(self, case, adapter=None, extra=()):
        argv = [sys.executable, "-I", "-B", self.run_py, "--tests", self.tests, "--only", f"test_{case}.py",
                "--scratch", os.path.join(self.tmp, "scratch"), *extra]
        if self.allow_unprotected and "--allow-unprotected" not in argv:
            argv.append("--allow-unprotected")
        if adapter:
            argv += ["--adapter", adapter]
        return argv

    def run(self, case, want_rc, want=(), adapter=None, label=None, extra=(), env=None):
        p = subprocess.run(self.runner(case, adapter, extra), capture_output=True, text=True, timeout=300, cwd=self.tmp,
                           stdin=subprocess.DEVNULL, env=None if env is None else {**os.environ, **env})
        return self.judge(label or case, p.returncode, p.stdout + p.stderr, want_rc, want)

    def judge(self, case, rc, out, want_rc, want):
        if self.allow_unprotected:  # an unprotected test process adds one record: totals and line numbers shift
            want = [re.sub(r"-- line \d+: ", r"-- line \\d+: ",
                           re.sub(r"\^JUDGE: \d+/\d+ passed", r"^JUDGE: \\d+/\\d+ passed", w)) for w in want]
        missing = [w for w in want if not re.search(w, out, re.M)]
        ok = rc == want_rc and not missing and "JUDGE:" in out
        print(f"{'ok  ' if ok else 'FAIL'} {case}: exit {rc} (want {want_rc})"
              + (f"; missing {missing}" if missing else ""), flush=True)
        if not ok:
            self.failures += 1
            print("     | " + "\n     | ".join(out.strip().splitlines()[-25:]), flush=True)
        return out

    def procfd(self, judge_line):
        """The procfd adapter's report: no descriptor inherited, and every open of the test's or the runner's
        descriptors through /proc refused with PermissionError (a dumpable process gives FileNotFoundError for a
        number it does not use, and opens the ones it does)."""
        self.run("driver", 0, [r"^PASS  test_driver: the fixture editor started", judge_line],
                 adapter=f"{shlex.quote(sys.executable)} -I -B {FAKE_ADAPTER} 1 procfd", extra=("--keep",),
                 label="adapter opens the result pipe through /proc: the verdict is unchanged")
        problems, rep = [], None
        for d, _, files in os.walk(os.path.join(self.tmp, "scratch")):
            if os.path.basename(d) == "test_driver" and "procfd.json" in files:
                with open(os.path.join(d, "procfd.json"), encoding="utf-8") as f:
                    rep = json.load(f)
        if rep is None:
            problems.append("no procfd.json report")
        else:
            if rep["own_fds"]:
                problems.append(f"the adapter holds descriptors {rep['own_fds']}")
            for who in ("test", "runner"):
                att = rep["attempts"].get(who) or {}
                if att.get("listed") != "PermissionError":
                    problems.append(f"{who} ({rep[who]}): listing /proc/<pid>/fd gave {att.get('listed')}")
                other = {n: r for n, r in (att.get("open") or {}).items() if r != "PermissionError"}
                if len(att.get("open") or {}) != 64 or other:
                    problems.append(f"{who} ({rep[who]}): opens not refused: {other}")
            if (rep["attempts"].get("test") or {}).get("open", {}).get(str(rep["results_fd"])) != "PermissionError":
                problems.append(f"the results descriptor {rep['results_fd']} was not refused")
        ok = not problems
        print(f"{'ok  ' if ok else 'FAIL'} adapter opens the result pipe through /proc: every open refused"
              + (f"; {problems}" if problems else ""), flush=True)
        if not ok:
            self.failures += 1

    def inject(self):
        """The inject adapter's report: strace's trace channel (its stderr, a socket) refused every open through /proc
        (ENXIO), and nothing the adapter wrote reached the trace (the case above: the hit comes first)."""
        rep = None
        for d, _, files in os.walk(os.path.join(self.tmp, "scratch")):
            if os.path.basename(d) == "test_driver" and "inject.json" in files:
                with open(os.path.join(d, "inject.json"), encoding="utf-8") as f:
                    rep = json.load(f)
        problems = []
        if rep is None:
            problems.append("no inject.json report")
        else:
            fd2 = {k: v for k, v in rep.items() if k.startswith("/proc/") and k.endswith("/fd/2")}
            if not fd2 or any(v != "ENXIO" for v in fd2.values()):
                problems.append(f"strace's stderr through /proc: {fd2}")
        ok = not problems
        print(f"{'ok  ' if ok else 'FAIL'} the adapter cannot open strace's trace channel through /proc"
              + (f"; {problems}" if problems else ""), flush=True)
        if not ok:
            self.failures += 1

    def asuser(self, judge):
        """The asuser adapter's report (--as-user): the judge's folder, the runner's records, and every process from
        strace up to the test process are out of the other user's reach. Every change of the judge's files and
        folders and of the records is refused; listing each process's descriptors, opening each one through
        /proc/<pid>/fd for writing and for reading, and sending it signal 0 are refused (PermissionError)."""
        rep = None
        for d, _, files in os.walk(os.path.join(self.tmp, "scratch")):
            if os.path.basename(d) == "test_driver" and "asuser.json" in files:
                with open(os.path.join(d, "asuser.json"), encoding="utf-8") as f:
                    rep = json.load(f)
        problems = []
        if rep is None:
            problems.append("no asuser.json report")
        else:
            env = rep.get("env")
            if not isinstance(env, dict) or not {"PATH", "HOME", "JUDGE_TEST_SCRATCH"} <= set(env):
                problems.append(f"the adapter's environment was not reported: {env}")
            else:
                if set(env) - ADAPTER_ENV:
                    problems.append(f"the adapter's environment holds more than run.AsUser.env_words gives: "
                                    f"{sorted(set(env) - ADAPTER_ENV)}")
                if CANARY[0] in env or any(CANARY[1] in v for v in env.values()):
                    problems.append(f"the runner's {CANARY[0]} reached the adapter")
            for part in ("judge", "records"):
                done = {p: r for p, r in rep[part].items() if set(r) & {"opened", "added", "chmod"}}
                if done:
                    problems.append(f"{part}: changed {done}")
            if os.path.join(judge, "run.py") not in rep["judge"]:
                problems.append("run.py was not tried")
            procs = rep["procs"]
            if not procs or "--child" not in list(procs.values())[-1]["cmd"]:
                problems.append(f"the processes up to the test process were not all tried: {procs}")
            for pid, e in procs.items():
                other = {n: r for n, r in e["open"].items() if r != "PermissionError"}
                if e["listed"] != "PermissionError" or other or len(e["open"]) != 128 or e["signal"] != "PermissionError":
                    problems.append(f"{pid} ({e['cmd'][:60]}): listed {e['listed'] if e['listed'] == 'PermissionError' else 'yes'}, "
                                    f"opens not refused {other}, signal 0 {e['signal']}")
        ok = not problems
        print(f"{'ok  ' if ok else 'FAIL'} --as-user: the adapter cannot change the judge or the records, open the "
              f"descriptors of strace, sudo or the test process, or signal them, and gets none of the runner's "
              f"environment" + (f"; {problems}" if problems else ""), flush=True)
        if not ok:
            self.failures += 1

    def unit(self, name, ok, detail=""):
        print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"; {detail}" if not ok and detail else ""), flush=True)
        if not ok:
            self.failures += 1

    def pids_in(self, case, name):
        for d, _, files in os.walk(os.path.join(self.tmp, "scratch")):
            if os.path.basename(d) == f"test_{case}" and name in files:
                return [int(x) for x in open(os.path.join(d, name)).read().split()]
        return []

    def still_running(self, case, pids):
        deadline = time.time() + 10
        while time.time() < deadline and any(_alive(p) for p in pids):
            time.sleep(0.2)
        alive = [p for p in pids if _alive(p)]
        ok = bool(pids) and not alive
        print(f"{'ok  ' if ok else 'FAIL'} {case}: the processes it left ({pids}) are gone"
              + (f"; still running: {alive}" if alive else ""), flush=True)
        if not ok:
            self.failures += 1
        for p in alive:  # this self-test's own process, by exact id
            try:
                os.kill(p, signal.SIGKILL)
            except OSError:
                pass

    def interrupt(self):
        p = subprocess.Popen(self.runner("interrupt"), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                             cwd=self.tmp, stdin=subprocess.DEVNULL)
        pids, deadline = [], time.time() + 120
        while not pids and time.time() < deadline and p.poll() is None:
            time.sleep(0.2)
            pids = self.pids_in("interrupt", "pids")
        if p.poll() is None:
            p.send_signal(signal.SIGTERM)
        try:
            out, _ = p.communicate(timeout=60)
        except subprocess.TimeoutExpired:
            p.kill()
            out, _ = p.communicate()
        self.judge("SIGTERM to the runner", p.returncode, out or "", 1,
                   [r"^JUDGE: interrupted by signal 15", r"^judge: scratch kept for inspection"])
        self.still_running("SIGTERM to the runner", pids)

    def sub(self, name, argv):
        p = subprocess.run(argv, capture_output=True, text=True, timeout=300, stdin=subprocess.DEVNULL, cwd=self.tmp)
        ok = p.returncode == 0
        print(f"{'ok  ' if ok else 'FAIL'} {name}", flush=True)
        if not ok:
            self.failures += 1
            print("     | " + "\n     | ".join((p.stdout + p.stderr).strip().splitlines()[-25:]), flush=True)


def asuser_units(s, user):
    """AsUser.problem()'s refusals that the runs below do not reach, each on a fresh AsUser of `user` with one thing
    changed in this process (nothing on the system changes): a group shared with this user, fs.protected_symlinks at
    0 (run._sysctl replaced, then put back), an env program this user owns, and a sudo -n that cannot run a command
    as root (its `true` replaced by `false`)."""
    import run
    au = run.AsUser(user)
    au.groups |= {os.getgid()}
    why = au.problem() or ""
    s.unit("--as-user: a user that shares a group with this user is refused",
           why.startswith(f"{user} shares the group(s) ") and why.endswith(" with the user that runs the judge"), why)
    real = run._sysctl
    run._sysctl = lambda name: 0 if name == "protected_symlinks" else real(name)
    try:
        why = run.AsUser(user).problem() or ""
    finally:
        run._sysctl = real
    s.unit("--as-user: fs.protected_symlinks at 0 is refused",
           why.startswith(f"fs.protected_symlinks is 0: the test's folders are shared with {user} "), why)
    mine = os.path.join(s.tmp, "env-mine")
    shutil.copyfile(run.AsUser(user).tools["env"], mine)
    os.chmod(mine, 0o755)
    au = run.AsUser(user)
    au.tools["env"] = mine
    why = au.problem() or ""
    s.unit("--as-user: an env program this user can change is not used",
           why == f"env {mine} is not used: {os.path.realpath(mine)} belongs to this user", why)
    au = run.AsUser(user)
    au.tools["true"] = shutil.which("false", path=run.SYSTEM_PATH)
    why = au.problem() or ""
    s.unit("--as-user: a sudo -n that cannot run a command as root is refused",
           why.startswith("sudo -n cannot run a command as root: ") or why == "sudo -n cannot run a command as root",
           why)


def user_cases(s, user, traced, py, drv, fail, net, left):
    """--self-test --as-user <user>: the fixture adapter as that user. It passes clean, its DNS lookup fails the
    download check (strace -u traces it), it cannot change the judge or the records or reach strace, sudo or the test
    process or get the runner's environment (SelfTest.asuser), and the child it leaves with an empty environment is
    ended by the user sweep. A user that already runs a process is refused (and the refusals in asuser_units), and
    so are a --scratch folder and a --graphics-addon folder the user can write or owns. A JUDGE_STRACE in a folder of the user's is not used.
    lockout.py finds a world-writable file and folder with --no-tighten, and takes the write bit away without it;
    with --kill it ends the user's processes first. With --fail-if-writable a file there that others could write
    fails it; a PATH folder that is not there is tried through the nearest folder above it; a world-writable folder
    still fails the probe when a file in it was removed after it was listed; --kill with no PATH removes the user's
    crontab and ends its processes."""
    import run
    try:
        au = run.AsUser(user)
        why = au.problem()  # never root or this user: the cases below end every process of that user
    except KeyError:
        why = "no such user"
    if why:
        s.unit(f"the --as-user cases can run as {user}", False, why)
        return
    asuser_units(s, user)
    # T.look's stat and read with another user: that user's private file (0600 in a 0700 folder, in a shared sticky
    # folder as a test's) is read as that user (AsUser.look) and not by this one, and a link that user planted to a
    # file of this user's is followed by neither.
    shared = os.path.realpath(os.path.join(s.tmp, "look-user"))
    os.mkdir(shared)
    os.chmod(shared, 0o1777)
    mine = os.path.join(s.tmp, "look-mine.txt")
    with open(mine, "w", encoding="utf-8") as f:
        f.write("this user's secret\n")
    subprocess.run(au.as_user([au.tools["env"], "-i", "PATH=/usr/bin:/bin", "/bin/sh", "-c",
                               'umask 077; mkdir "$0/p" && printf private > "$0/p/f" && ln -s "$1" "$0/l"', shared,
                               mine]), check=True, capture_output=True, timeout=60, cwd="/")
    pf, pl = os.path.join(shared, "p", "f"), os.path.join(shared, "l")
    req = {"stat": [pf, pl], "read": [pf, pl], "root": shared}
    theirs, me = au.look(req), run.look(req)
    import base64
    s.unit(f"look as {user}: its private file is read as it (mode 0600) and not by this user; a link it planted to a "
           "file of this user's is followed by neither",
           (theirs["read"][pf] and base64.b64decode(theirs["read"][pf])) == b"private"
           and (theirs["stat"][pf] or {}).get("mode") == 0o600 and me["read"][pf] is None and me["stat"][pf] is None
           and me["read"][pl] is None and theirs["read"][pl] is None and (me["stat"][pl] or {}).get("link") == mine,
           {"theirs": theirs["stat"], "me": me["stat"], "read": {"theirs": theirs["read"], "me": me["read"]}})
    subprocess.run(au.root([au.tools["rm"], "-rf", "--one-file-system", "--", shared]), capture_output=True,
                   timeout=60, cwd="/")
    if traced:  # AsUser.tracer: the adapter's tree gets the judge's own core limits, not the 0 sudo sets
        st = shutil.which("strace", path=run.SYSTEM_PATH)
        p = subprocess.run(au.tracer(au.env_words() + [st, "-f", "-qq", "-e", "trace=none", "-u", user, "--",
                                                       "/bin/sh", "-c", "ulimit -H -c; ulimit -S -c"]),
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60, cwd="/")
        soft, hard = run.core_limits()
        s.unit(f"--as-user: the adapter's tree (under strace -u, through sudo) has the judge's core limits ({soft} "
               f"soft, {hard} hard), so the editor can raise its soft limit as it can without --as-user",
               p.returncode == 0 and p.stdout.split() == [hard, soft], f"rc {p.returncode}: {p.stdout!r} {p.stderr!r}")
    extra = ("--as-user", user)
    s.run("driver", 0, [r"^judge: as user " + re.escape(user), r"^PASS  test_driver: the fixture editor started",
                        drv(3, 3)], adapter=f"{py} {FAKE_ADAPTER} 1 plain", extra=extra,
          label="--as-user: the fixture adapter runs as the other user and passes")
    if traced:
        s.run("driver", 1, [fail.format("driver", net + ".*htons\\(53\\).*192\\.0\\.2\\.1")],
              adapter=f"{py} {FAKE_ADAPTER} 1 connect", extra=extra,
              label="--as-user: the other user's DNS lookup fails the download check (strace -u traces it)")
    s.run("driver", 1, [left + r"\d+ \S+ -I -c import time; time\.sleep\(300\)"],
          adapter=f"{py} {FAKE_ADAPTER} 1 asuser {shlex.quote(JUDGE)}", extra=extra + ("--keep",),
          env=dict([CANARY]),
          label="--as-user: a child left with an empty environment is found by the user sweep and the run fails")
    s.asuser(JUDGE)
    s.still_running("--as-user: the child the adapter left", s.pids_in("driver", "asuser.pid"))

    def user_sleeps():
        p = subprocess.Popen(au.as_user([au.tools["env"], "-i", "PATH=/usr/bin:/bin", "sleep", "120"]),
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd="/")
        deadline = time.time() + 20
        while time.time() < deadline and not any("sleep" in c for _, c in au.procs()):
            time.sleep(0.2)
        return p
    p = user_sleeps()
    s.run("ok", 1, [r"^JUDGE: refused: --as-user " + re.escape(user) + ": " + re.escape(user)
                    + r" already runs 1 process"], extra=extra, label="--as-user: a user that already runs a process "
                                                                       "is refused")
    au.sweep()
    p.wait(30)

    # The run's folder must be one the other user can enter but not change (AsUser.folder_problem): a --scratch
    # folder it can write (mode 0777, not sticky: it could rename the run's folder) or one of its own is refused.
    chown = shutil.which("chown", path=run.SYSTEM_PATH)
    rm = [au.tools["rm"], "-rf", "--one-file-system", "--"]
    open_scratch = os.path.realpath(os.path.join(s.tmp, "scratch-open"))
    os.mkdir(open_scratch)
    os.chmod(open_scratch, 0o777)
    s.run("ok", 1, [r"^JUDGE: refused: --as-user " + re.escape(user) + r": the run's folder " + re.escape(open_scratch)
                    + r"/judge-\S+: " + re.escape(user) + r" can (write|rename) .*\(it can write "
                    + re.escape(open_scratch) + r"\)"], extra=extra + ("--scratch", open_scratch),
          label="--as-user: a --scratch folder the other user can write is refused")
    own_scratch = os.path.realpath(os.path.join(s.tmp, "scratch-user"))
    os.mkdir(own_scratch)
    os.chmod(own_scratch, 0o777)  # the runner makes the run's folder in it
    subprocess.run(au.root([chown, user, own_scratch]), check=True, capture_output=True, timeout=60, cwd="/")
    s.run("ok", 1, [r"^JUDGE: refused: --as-user " + re.escape(user) + r": the run's folder " + re.escape(own_scratch)
                    + r"/judge-\S+: " + re.escape(own_scratch) + " belongs to " + re.escape(user)],
          extra=extra + ("--scratch", own_scratch),
          label="--as-user: a --scratch folder of the other user's is refused")
    left_runs = os.listdir(open_scratch) + os.listdir(own_scratch)
    s.unit("--as-user: a refused run leaves no folder in --scratch", not left_runs, left_runs)
    subprocess.run(au.root(rm + [own_scratch]), capture_output=True, timeout=60, cwd="/")

    # The graphics add-on's folder must be one the other user can read but not change (run.py checks its root, its
    # node_modules and the headless shell's folder with AsUser.folder_problem): a --graphics-addon folder it can write
    # (mode 0777, not sticky) or one of its own is refused before any test runs.
    open_addon = os.path.realpath(s.addon_fixture("addon-open"))
    os.chmod(open_addon, 0o777)
    s.run("ok", 1, [r"^JUDGE: refused: --graphics-addon \S+: " + re.escape(user) + " can write "
                    + re.escape(open_addon) + "$"], extra=extra + ("--graphics-addon", open_addon),
          label="--as-user: a --graphics-addon folder the other user can write is refused")
    own_addon = os.path.realpath(s.addon_fixture("addon-user"))
    subprocess.run(au.root([chown, user, own_addon]), check=True, capture_output=True, timeout=60, cwd="/")
    s.run("ok", 1, [r"^JUDGE: refused: --graphics-addon \S+: " + re.escape(own_addon) + " belongs to "
                    + re.escape(user) + "$"], extra=extra + ("--graphics-addon", own_addon),
          label="--as-user: a --graphics-addon folder of the other user's is refused")
    subprocess.run(au.root(rm + [own_addon]), capture_output=True, timeout=60, cwd="/")

    # strace runs as root under --as-user: a JUDGE_STRACE that the other user could replace (a root-owned copy in a
    # folder of that user's) is not used, so the trace checks are not observed. Every folder above that one is root's
    # (a new folder in /run, made as root): under the self-test's folder, which is this user's, it would be refused
    # for this user already. The same copy in the root-owned folder is used (the case's control).
    if traced:
        def as_root(*words):
            return subprocess.run(au.root(list(words)), check=True, capture_output=True, text=True, timeout=60, cwd="/")
        tool = {t: shutil.which(t, path=run.SYSTEM_PATH) for t in ("mktemp", "install", "chmod")}
        top = as_root(tool["mktemp"], "-d", "/run/judge-selftest-strace.XXXXXXXX").stdout.strip()
        try:
            as_root(tool["chmod"], "0755", top)
            as_root(tool["install"], "-o", "0", "-g", "0", "-m", "0755", run_strace_path(), os.path.join(top, "strace"))
            sdir = os.path.join(top, "user")
            as_root(tool["install"], "-d", "-o", user, "-m", "0755", sdir)
            scopy = os.path.join(sdir, "strace")
            as_root(tool["install"], "-o", "0", "-g", "0", "-m", "0755", run_strace_path(), scopy)
            s.run("driver", 0, [r"^judge: trace with " + re.escape(os.path.join(top, "strace")) + r"( |$)",
                                r"^JUDGE: 4/4 passed( UNPROTECTED|$)"],
                  adapter=f"{py} {FAKE_ADAPTER} 1 plain", extra=extra,
                  env={"JUDGE_STRACE": os.path.join(top, "strace")},
                  label="--as-user: a JUDGE_STRACE in a folder of root's is used")
            s.run("driver", 0, [r"^judge: trace with nothing \(strace " + re.escape(scopy) + r" is not used with "
                                r"--as-user \(it runs as root\): " + re.escape(sdir) + " belongs to " + re.escape(user)
                                + r"\)", r"^JUDGE: 3/3 passed, 1 not observed( UNPROTECTED|$)"],
                  adapter=f"{py} {FAKE_ADAPTER} 1 plain", extra=extra, env={"JUDGE_STRACE": scopy},
                  label="--as-user: a JUDGE_STRACE in a folder of the other user's is not used (strace runs as root)")
        finally:
            subprocess.run(au.root(rm + [top]), capture_output=True, timeout=60, cwd="/")

    lockout = [sys.executable, "-I", "-B", os.path.join(JUDGE, "lockout.py"), "--user", user]
    lk = os.path.join(s.tmp, "lockout")
    os.mkdir(lk)
    os.chmod(lk, 0o755)
    open_dir, closed = os.path.join(lk, "open"), os.path.join(lk, "closed")
    os.mkdir(open_dir)
    open_file = os.path.join(open_dir, "f")
    for path, mode in ((open_file, 0o666), (closed, 0o644)):
        with open(path, "w", encoding="utf-8") as f:
            f.write("x\n")
        os.chmod(path, mode)
    os.chmod(open_dir, 0o777)
    r = subprocess.run(lockout + ["--no-tighten", lk], capture_output=True, text=True, timeout=600,
                       stdin=subprocess.DEVNULL)
    out = r.stdout + r.stderr
    want = [f"lockout: FAIL {user} could change {open_dir}: added a file",
            f"lockout: FAIL {user} could change {open_file}: opened it for writing"]
    s.unit("lockout.py --no-tighten: a world-writable folder and file are found, and the run fails",
           r.returncode == 1 and all(w in out for w in want) and closed not in out, out[-1500:])
    r = subprocess.run(lockout + [lk], capture_output=True, text=True, timeout=600, stdin=subprocess.DEVNULL)
    modes = {p: stat.S_IMODE(os.stat(p).st_mode) for p in (open_dir, open_file, closed)}
    s.unit("lockout.py: it takes the write bit for others away (chmod o-w), and then nothing can be changed",
           r.returncode == 0 and "lockout: ok" in r.stdout and modes == {open_dir: 0o775, open_file: 0o664,
                                                                          closed: 0o644},
           f"exit {r.returncode}; {modes}; {(r.stdout + r.stderr)[-1500:]}")
    p = user_sleeps()
    r = subprocess.run(lockout + ["--kill", lk], capture_output=True, text=True, timeout=600, stdin=subprocess.DEVNULL)
    s.unit("lockout.py --kill: it ends the user's processes first",
           r.returncode == 0 and "lockout: ended 1 process(es)" in r.stdout and not au.procs(),
           f"exit {r.returncode}; {(r.stdout + r.stderr)[-1500:]}")
    try:
        p.wait(30)
    except subprocess.TimeoutExpired:
        pass

    # --fail-if-writable (judge.yml: the runner's file-command folder): a file there that others can write fails the
    # run, also when its write bit is taken away.
    fc = os.path.join(s.tmp, "lockout-file-commands")
    os.mkdir(fc)
    os.chmod(fc, 0o755)
    fc_file = os.path.join(fc, "set_env_later")
    with open(fc_file, "w", encoding="utf-8") as f:
        f.write("")
    os.chmod(fc_file, 0o666)
    r = subprocess.run(lockout + ["--fail-if-writable", fc, fc], capture_output=True, text=True, timeout=600,
                       stdin=subprocess.DEVNULL)
    out = r.stdout + r.stderr
    s.unit("lockout.py --fail-if-writable: a file there that others could write fails the run (its bit taken away)",
           r.returncode == 1 and f"lockout: FAIL others could write {fc_file} (mode 666)" in out
           and stat.S_IMODE(os.stat(fc_file).st_mode) == 0o664, f"exit {r.returncode}; {out[-1500:]}")

    # A folder on PATH that is not there: the user could make it in the nearest folder above, which is tried (here a
    # sticky folder that everyone can write, as /tmp is, so it is not tightened and the user can add to it).
    open_top = os.path.join(s.tmp, "lockout-sticky")
    os.mkdir(open_top)
    os.chmod(open_top, 0o1777)
    r = subprocess.run(lockout + [os.path.join(open_top, "not", "there", "bin")], capture_output=True, text=True,
                       timeout=600, stdin=subprocess.DEVNULL)
    out = r.stdout + r.stderr
    s.unit("lockout.py: a PATH folder that is not there is tried through the nearest folder above it",
           r.returncode == 1 and f"lockout: FAIL {user} could change {open_top}: added a file" in out,
           f"exit {r.returncode}; {out[-1500:]}")

    # A file listed and then removed before the probe, in a diagnostic-log folder of the runner's (GitHub's runner
    # removes its own logs at any time): skipped, while that folder, which the user can write, still fails the probe.
    # An item that is gone when the probe reaches it is named as gone, not counted as refused.
    import lockout as lockout_mod
    vt = os.path.realpath(os.path.join(s.tmp, "lockout-vanish-open"))
    vd = os.path.join(vt, "actions-runner", "cached", "2.338.0", "_diag", "pages")
    os.makedirs(vd)
    os.chmod(vd, 0o777)
    vf = os.path.join(vd, "gone.log")
    with open(vf, "w", encoding="utf-8") as f:
        f.write("x\n")
    items = [i for i in lockout_mod.gather([vt]) if i[0] != "a"]
    os.unlink(vf)
    kept, gone = lockout_mod.present(items)
    tried, written, missing = lockout_mod.probe(au, kept + [("f", vf)])
    skipped, problems = lockout_mod.vanish_verdict(gone, kept, {vt})
    s.unit("lockout.py: a file removed from a diagnostic-log folder of the runner's after it was listed is skipped, "
           "the folder that held it, which the user can write, still fails the probe, and the probe names the file as "
           "gone",
           items[-1] == ("f", vf) and gone == [("f", vf)] and ("d", vd) in kept and tried == len(kept) + 1
           and written == [(vd, ["added a file"])] and missing == [vf] and skipped == [vf] and problems == [],
           f"items {items}; gone {gone}; tried {tried}; written {written}; missing {missing}; skipped {skipped}; "
           f"problems {problems}")

    # --kill with no PATH (judge.yml's failure path): the user's crontab is removed and its processes are ended. When
    # crontab refuses the user even for root (judge.yml puts zjudge in /etc/cron.deny), no crontab can be planted
    # and lockout.py must say that cron refuses the user; with no crontab program it says so.
    crontab = shutil.which("crontab", path=run.SYSTEM_PATH)
    planted = crontab and subprocess.run(au.root([crontab, "-u", user, "-"]), input="@reboot true\n",
                                         capture_output=True, text=True, timeout=60, cwd="/").returncode == 0
    p = user_sleeps()
    r = subprocess.run(lockout + ["--kill"], capture_output=True, text=True, timeout=600, stdin=subprocess.DEVNULL)
    out = r.stdout + r.stderr
    tab = subprocess.run(au.root([crontab, "-l", "-u", user]), capture_output=True, text=True, timeout=60,
                         stdin=subprocess.DEVNULL, cwd="/") if crontab else None
    s.unit("lockout.py --kill with no PATH: it removes the user's crontab (or says cron refuses the user) and ends "
           "its processes",
           r.returncode == 0 and "lockout: ended 1 process(es)" in out and not au.procs()
           and (f"lockout: removed the crontab of {user}" in out and tab.returncode != 0 if planted else
                f"lockout: {user} may not use cron" in out if crontab else "lockout: no crontab in " in out),
           f"exit {r.returncode}; crontab {crontab}, planted {planted}: {tab and (tab.stdout + tab.stderr).strip()}; "
           f"{out[-1500:]}")
    try:
        p.wait(30)
    except subprocess.TimeoutExpired:
        pass


def measure_units(s, observe):
    """What a measurement may read (observe.source): with observe.confine(<folder>), a regular file in the folder is
    measured; a file there that holds an HLS playlist (named .png, as a rendered frame, or .m3u8) naming a file
    outside the folder is Unmeasurable for ffprobe (observe.streams) and FFmpeg (observe.mean_rgb), and the file it
    names is never opened (a FIFO: a writer in this process counts every open of it); a link in the folder to a file
    outside it is Unmeasurable."""
    import threading
    inside, outside = os.path.join(s.tmp, "measure", "test"), os.path.join(s.tmp, "measure", "elsewhere")
    os.makedirs(inside)
    os.makedirs(outside)
    png = os.path.join(inside, "ok.png")
    observe.run([observe.FFMPEG, "-nostdin", "-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i",
                 "color=c=0xff00ff:size=64x36,format=rgb24", "-frames:v", "1", png], heavy=False, timeout=60)
    secret = os.path.join(outside, "secret.png")
    shutil.copyfile(png, secret)
    os.symlink(secret, os.path.join(inside, "link.png"))
    seg = os.path.join(outside, "seg.ts")
    os.mkfifo(seg)
    opens, stop = [], threading.Event()

    def writer():  # every open of the FIFO for reading meets one open here for writing
        while not stop.is_set():
            fd = os.open(seg, os.O_WRONLY)
            if not stop.is_set():
                opens.append(1)
            os.close(fd)
    w = threading.Thread(target=writer, daemon=True)
    w.start()
    playlist = f"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\n{seg}\n#EXT-X-ENDLIST\n"
    for name in ("probe.png", "probe.m3u8"):
        with open(os.path.join(inside, name), "w", encoding="utf-8") as f:
            f.write(playlist)

    def measured(fn, path):
        try:
            return f"measured {fn(path)}"
        except observe.Unmeasurable as e:
            return f"unmeasurable: {e}"
    observe.confine(inside)
    try:
        try:
            control = observe.mean_rgb(png)
        except observe.Unmeasurable as e:
            control = f"unmeasurable: {e}"
        hls = {f"{fn.__name__}({name})": measured(fn, os.path.join(inside, name))
               for name in ("probe.png", "probe.m3u8") for fn in (observe.streams, observe.mean_rgb)}
        link = {fn.__name__: measured(fn, os.path.join(inside, "link.png")) for fn in (observe.streams, observe.mean_rgb)}
    finally:
        observe.confine()
        seen = len(opens)
        stop.set()
        fd = os.open(seg, os.O_RDONLY | os.O_NONBLOCK)  # lets the writer's last open return
        w.join(10)
        os.close(fd)
    s.unit("a measurement reads a regular file in the folder the judge allowed (a magenta PNG reads as magenta)",
           isinstance(control, tuple) and observe.colour_is(control, (255, 0, 255)), control)
    s.unit("a .png or .m3u8 file there holding an HLS playlist that names a file outside the folder is unmeasurable, "
           "and that file is never opened",
           all(v.startswith("unmeasurable") for v in hls.values()) and seen == 0, f"{seen} open(s) of it; {hls}")
    s.unit("a link there to a picture outside the folder is unmeasurable (not read)",
           all("is not in a folder the judge may measure in" in v for v in link.values()), link)


def read_cap_units(s, observe):
    """observe's readers of a file the editor wrote: sha256 reads it 1 MiB at a time, so a file of any size has its
    hash; parse_srt, parse_otio and substitute read at most observe.TEXT_LIMIT bytes and call a longer file too large
    to read (a failed check), so a huge file the editor writes cannot exhaust the judge's memory. The big files are
    sparse: they take no disk space."""
    import hashlib
    d = os.path.join(s.tmp, "read-cap")
    os.makedirs(d)
    big, small = os.path.join(d, "big.srt"), os.path.join(d, "small.srt")
    with open(big, "wb") as f:
        f.truncate(observe.TEXT_LIMIT + 1)
    with open(small, "w", encoding="utf-8") as f:
        f.write("1\n00:00:00,000 --> 00:00:01,000\nhello\n")
    hashed = os.path.join(d, "hashed.bin")
    with open(hashed, "wb") as f:
        f.truncate(3 * (1 << 20) + 5)

    def outcome(fn):
        try:
            return f"read: {str(fn())[:80]}"
        except observe.Unmeasurable as e:
            return f"unmeasurable: {e}"
    observe.confine(d)
    try:
        small_srt = outcome(lambda: observe.parse_srt(small))
        too_big = {"parse_srt": outcome(lambda: observe.parse_srt(big)),
                   "parse_otio": outcome(lambda: observe.parse_otio(big)["problems"]),
                   "substitute": outcome(lambda: observe.substitute(big, os.path.join(d, "out.srt"), [("a", "b")]))}
        digest = outcome(lambda: observe.sha256(hashed))
    finally:
        observe.confine()
    s.unit("parse_srt reads a captions file the editor wrote (control)", small_srt.startswith("read: ([(0.0, 1.0"),
           small_srt)
    s.unit(f"parse_srt, parse_otio and substitute do not read a file of more than {observe.TEXT_LIMIT} bytes: it is "
           "too large to read", all("too large to read" in v for v in too_big.values()), too_big)
    s.unit("sha256 hashes a file of several MiB read 1 MiB at a time (the same hash as the whole file's)",
           digest == "read: " + hashlib.sha256(bytes(3 * (1 << 20) + 5)).hexdigest(), digest)


def tracetail_units(s):
    """run.TraceTail on bytes written to its channel as strace would write them, and run.strace_failed on the result:
    strace's own error message at the end of the trace (after a call it cut short, or alone) fails the download check
    and allows the one rerun only when strace exited 1 with --kill-on-exit and no line addressed another computer; the
    same text inside a quoted string, followed by another line, cut short, under another path, or after a line that is
    not of strace's form does not."""
    import observe
    import run
    tracer = "/usr/bin/strace"
    msg = "ptrace(PTRACE_LISTEN,pid:52800,sig:0): Input/output error"
    sent = ('[pid 52756] sendto(48<UNIX-STREAM:[73087->73088]>, "\\20\\0", 2, MSG_NOSIGNAL, NULL, 0) = 2')
    cut = ('[pid 52779] sendmsg(11<UNIX:[73051->73052]>, {msg_name=NULL, msg_namelen=0, msg_iov=[{iov_base="\\10\\0",'
           ' iov_len=2}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, MSG_NOSIGNAL')
    lookup = '[pid 52779] connect(6<UDP:[11]>, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("192.0.2.1")}, 16'
    quoted = (f'[pid 52756] sendto(5<UDP:[127.0.0.1:5->127.0.0.1:9]>, "{tracer}: {msg}", 60, 0, NULL, 0) = 60')

    def tail(data, path=tracer):
        t = run.TraceTail(os.path.join(s.tmp, f"tracetail-{len(os.listdir(s.tmp))}.log"), tracer=path)
        t.writer.sendall(data.encode("latin-1"))
        t.started()  # this process's write end closed: the reader sees the end of the trace
        t.close(wait=5)
        return t

    saved = {k: run._STRACE.get(k) for k in ("path", "kill")}
    run._STRACE.update(path=tracer, kill=True)
    try:
        t = tail(f"{sent}\n{cut}{tracer}: {msg}\n")
        hits = observe.net_hits(t)
        s.unit("strace's own message after a call it cut short: the download check fails (strace failed while the "
               "editor ran), the cut call is kept as '<unfinished ...>', and the test may run once more",
               t.tampered and t.tampered.startswith(f"strace failed while the editor ran ({msg})")
               and t.tracer_failed == msg and not hits and run.strace_failed(t, 1, hits)
               and t.lines()[-1] == "52779 " + cut.split("] ", 1)[1] + " <unfinished ...>",
               f"tampered {t.tampered!r}, failed {t.tracer_failed!r}, hits {hits}, last {t.lines()[-1:]}")
        s.unit("...and not when strace exited with 0, was killed (-9) or ran without --kill-on-exit",
               not run.strace_failed(t, 0, []) and not run.strace_failed(t, -9, [])
               and not run.strace_failed(t, 137, []) and not (run._STRACE.update(kill=False)
                                                              or run.strace_failed(t, 1, [])))
        run._STRACE.update(kill=True)
        t = tail(f"{tracer}: {msg}\n")
        s.unit("strace's own message on a line of its own: the check fails and the test may run once more",
               t.tracer_failed == msg and bool(t.tampered) and run.strace_failed(t, 1, []), repr(t.tampered))
        t = tail(f"{lookup}{tracer}: {msg}\n")
        hits = observe.net_hits(t)
        s.unit("a DNS lookup that strace's message cut short counts: no rerun",
               t.tracer_failed == msg and len(hits) == 1 and "htons(53)" in hits[0] and not run.strace_failed(t, 1, hits),
               f"hits {hits}")
        for label, data, path in (
                ("inside a quoted string (a process's data)", f"{quoted}\n", tracer),
                ("in an open quoted string", f'[pid 7] sendto(5<UDP:[1]>, "{tracer}: {msg}\n', tracer),
                ("followed by another line", f"{cut}{tracer}: {msg}\n{sent}\n", tracer),
                ("cut short (no newline)", f"{cut}{tracer}: {msg[:20]}", tracer),
                ("under another path", f"{cut}/tmp/strace: {msg}\n", tracer),
                ("after a line that is not of strace's form", f"x{sent}\n{cut}{tracer}: {msg}\n", tracer),
                ("with a quote in it", f'{cut}{tracer}: can\'t "x"\n', tracer),
                ("after a call line cut inside a decoration", f"[pid 7] sendmsg(11<UNIX:[1{tracer}: {msg}\n", tracer),
                ("with no tracer given", f"{cut}{tracer}: {msg}\n", None)):
            t = tail(data, path)
            s.unit(f"strace's message {label}: the check fails and there is no rerun",
                   bool(t.tampered) and t.tracer_failed is None and not run.strace_failed(t, 1, observe.net_hits(t)),
                   f"tampered {t.tampered!r}, failed {t.tracer_failed!r}")
    finally:
        run._STRACE.update(saved)


def look_units(s):
    """run.look's stat and read (T.look; tests/test_cli_migrate.py reads the installer's world with them): a regular
    file's kind, mode and bytes, a link's target, a folder; no link is followed at the path, a file over the cap is not
    read, and a path whose folder (made real) is outside `root` is not looked at, also through a link to a folder."""
    import base64
    import run
    root = os.path.realpath(os.path.join(s.tmp, "look", "root"))
    outside = os.path.realpath(os.path.join(s.tmp, "look", "outside"))
    os.makedirs(os.path.join(root, "d"))
    os.makedirs(outside)
    f = os.path.join(root, "f.json")
    with open(f, "wb") as fo:
        fo.write(b"x\r\n")
    os.chmod(f, 0o640)
    secret = os.path.join(outside, "secret")
    with open(secret, "w", encoding="utf-8") as fo:
        fo.write("judge secret\n")
    os.symlink(secret, os.path.join(root, "link"))
    os.symlink(outside, os.path.join(root, "out"))
    big = os.path.join(root, "big")
    with open(big, "wb") as fo:
        fo.truncate((1 << 20) + 1)
    paths = [f, os.path.join(root, "link"), os.path.join(root, "d"), os.path.join(root, "out", "secret"), big,
             os.path.join(root, "nope")]
    got = run.look({"stat": paths, "read": paths, "root": root})
    st, rd = got["stat"], got["read"]
    s.unit("look stat: a file's kind, mode and size, a link's target (not followed), a folder; nothing for a path "
           "outside root (through a link to a folder) or one that is not there",
           st[f] == {"type": "file", "mode": 0o640, "size": 3, "link": None}
           and st[paths[1]] == {"type": "link", "mode": st[paths[1]]["mode"], "size": len(secret), "link": secret}
           and st[paths[2]]["type"] == "dir" and st[paths[3]] is None and st[paths[5]] is None, st)
    s.unit("look read: a regular file's bytes; nothing through a link at the path, through a link to a folder outside "
           "root, for a folder, a file over 1 MiB or one that is not there",
           base64.b64decode(rd[f]) == b"x\r\n" and all(rd[p] is None for p in paths[1:]),
           {p: (v[:20] if v else v) for p, v in rd.items()})


def lockout_units(s):
    """lockout.py's parts that need no other user (judge.yml runs it for zjudge). A file that was listed and is gone
    when tighten reaches it is skipped and named only in a diagnostic-log folder of the runner's (GitHub's runner
    removes its own logs at any time) that is tried; that folder is still tightened and kept for the probe. A file gone
    from any other folder, a gone PATH whose folder is sticky (not tried), and a gone PATH folder fail the run."""
    import lockout
    top = os.path.realpath(os.path.join(s.tmp, "lockout-vanish"))  # stands in for the runner's home (a PATH)
    diag = os.path.join(top, "actions-runner", "cached", "2.338.0", "_diag", "pages")
    other = os.path.join(top, "work")
    os.makedirs(diag)
    os.makedirs(other)
    os.chmod(top, 0o777)
    diag_gone, other_gone = os.path.join(diag, "gone.log"), os.path.join(other, "gone.log")
    for p in (diag_gone, other_gone):
        with open(p, "w", encoding="utf-8") as f:
            f.write("x\n")
    items = [i for i in lockout.gather([top]) if i[0] != "a"]  # the folders above are not this case's
    listed = items[0] == ("d", top) and ("f", diag_gone) in items and ("f", other_gone) in items
    os.unlink(diag_gone)
    os.unlink(other_gone)
    done, problems, vanished = lockout.tighten(None, items)
    kept, later = lockout.present(items)
    probed = lockout.to_probe(kept)
    skipped, failed = lockout.vanish_verdict(vanished, probed, {top})
    s.unit("lockout.py: a file listed and then removed from a diagnostic-log folder of the runner's is skipped and "
           "named, not failed; its folder is still tightened and tried",
           listed and problems == [] and sorted(vanished) == sorted([("f", diag_gone), ("f", other_gone)])
           and [p for p, _ in done] == [top] and ("d", diag) in probed and sorted(later) == sorted(vanished)
           and stat.S_IMODE(os.stat(top).st_mode) == 0o775 and skipped == [diag_gone],
           f"listed {listed}; done {done}; problems {problems}; vanished {vanished}; later {later}; "
           f"skipped {skipped}; failed {failed}")
    s.unit("lockout.py: a file listed and then removed from a folder that is not a diagnostic-log folder of the "
           "runner's fails the run, named",
           len(failed) == 1 and failed[0].startswith(f"{other_gone} vanished after it was listed, and it is not in a "
                                                     f"diagnostic-log folder"), f"skipped {skipped}; failed {failed}")
    # A PATH file in a sticky diagnostic-log folder: that folder is a folder above a PATH, which the probe does not try
    # when sticky, so the file's removal is covered by nothing and fails, also when the PATH is not counted.
    shome = os.path.realpath(os.path.join(s.tmp, "lockout-vanish-sticky"))
    sdiag = os.path.join(shome, "actions-runner", "cached", "2.338.0", "_diag")
    os.makedirs(sdiag)
    os.chmod(sdiag, 0o1777)
    sfile = os.path.join(sdiag, "Runner.log")
    with open(sfile, "w", encoding="utf-8") as f:
        f.write("x\n")
    sitems = lockout.gather([sfile])
    os.unlink(sfile)
    skept, sgone = lockout.present(sitems)
    sprobed = lockout.to_probe(skept)
    as_path = lockout.vanish_verdict(sgone, sprobed, {sfile})
    below_home = lockout.vanish_verdict(sgone, sprobed, {shome})
    s.unit("lockout.py: a file removed under a sticky folder above a PATH (not tried) fails the run, named",
           sitems[:2] == [("f", sfile), ("a", sdiag)] and sgone == [("f", sfile)] and ("a", sdiag) not in sprobed
           and as_path[0] == [] and len(as_path[1]) == 1 and as_path[1][0].startswith(f"{sfile} vanished")
           and below_home[0] == [] and len(below_home[1]) == 1 and below_home[1][0].startswith(f"{sfile} vanished"),
           f"items {sitems[:3]}; gone {sgone}; as a PATH {as_path}; below a PATH folder {below_home}")
    # A PATH folder removed after it was listed (here a diagnostic-log folder of the runner's, whose folder is tried):
    # it fails, and so does the nearest folder above a PATH that is not there ("m").
    phome = os.path.realpath(os.path.join(s.tmp, "lockout-vanish-path"))
    pdir = os.path.join(phome, "actions-runner", "cached", "2.338.0", "_diag", "pages")
    os.makedirs(pdir)
    pitems = lockout.gather([pdir])
    os.rmdir(pdir)
    pkept, pgone = lockout.present(pitems)
    pprobed = lockout.to_probe(pkept)
    pv = lockout.vanish_verdict(pgone + [("m", phome)], pprobed, {pdir, phome})
    s.unit("lockout.py: a PATH folder, or the nearest folder above a PATH that is not there, removed after it was "
           "listed fails the run, named",
           pgone == [("d", pdir)] and ("a", os.path.dirname(pdir)) in pprobed and pv[0] == []
           and [x.split(" vanished")[0] for x in pv[1]] == [pdir, phome]
           and all("it is a PATH or a folder above one" in x for x in pv[1]), f"gone {pgone}; verdict {pv}")
    # The build user must not run sudo: only sudo's own refusal passes; a list of commands, an error or nothing fails.
    ok_text = "User zjudge is not allowed to run sudo on runnervm8k3b6.\n"
    bad = {"may run": "Matching Defaults entries for zjudge on host:\n    env_reset\n\n"
                      "User zjudge may run the following commands on host:\n    (ALL) NOPASSWD: ALL\n",
           "error": "sudo: unknown user zjudge\nsudo: error initializing audit plugin sudoers_audit\n",
           "password": "sudo: a password is required\n", "empty": "", "blank": " \n "}
    s.unit("lockout.py: sudo's refusal of the build user passes the sudo check",
           lockout.sudo_verdict("zjudge", ok_text) is None, lockout.sudo_verdict("zjudge", ok_text))
    s.unit("lockout.py: a build user that may run sudo, or a sudo -l answer that is an error or empty, fails",
           all((lockout.sudo_verdict("zjudge", t) or "").startswith("zjudge may run sudo, or sudo -l -U could not tell")
               for t in bad.values()), {k: lockout.sudo_verdict("zjudge", t) for k, t in bad.items()})
    s.unit("lockout.py: a build user that shares a group with this user fails; one with only its own group passes",
           lockout.group_verdict("zjudge", {1002, 4}, {1001, 4, 27})
           == "zjudge shares the group id(s) [4] with this user"
           and lockout.group_verdict("zjudge", {1002}, {1001, 4, 27}) is None,
           [lockout.group_verdict("zjudge", {1002, 4}, {1001, 4, 27}), lockout.group_verdict("zjudge", {1002}, {1001})])


def ci_scripts(s):
    """judge.yml's shell parts, run here as this user. ci/quiet.sh (both forms) prints a command's output, which holds
    a workflow command, between ::stop-commands::<token> and ::<token>:: with one fresh 32-digit token that is in
    neither the command's arguments nor its environment, keeps the command's exit code, and makes its log mode 0600.
    ci/collect_logs.sh copies only the regular *.log and *.stderr files: not a link to a file this user can read
    (the runner's), not a FIFO, nothing under a linked folder, and nothing else."""
    ci = os.path.join(JUDGE, "ci")
    base = os.path.join(s.tmp, "ci")
    os.mkdir(base)
    tokens = []
    for form in ("log", "live"):
        log = os.path.join(base, f"quiet-{form}.log")
        seen = os.path.join(base, f"quiet-{form}.seen")  # the command's arguments and environment (never printed)
        cmd = ["sh", "-c", 'echo "::error::canary $*"; echo "::add-mask::x"; { echo "$0 $*"; env; } > "$0"; exit 3',
               seen, "arg"]
        words = ["bash", os.path.join(ci, "quiet.sh")] + (["--live"] if form == "live" else [log]) + cmd
        p = subprocess.run(words, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
        lines = p.stdout.splitlines()
        m = re.fullmatch(r"::stop-commands::([0-9a-f]{32})", lines[0]) if lines else None
        tok = m.group(1) if m else None
        tokens.append(tok)
        with open(seen, encoding="utf-8", errors="replace") as f:
            seen_text = f.read()
        ok = (p.returncode == 3 and tok is not None
              and lines[1:] == ["::error::canary arg", "::add-mask::x", f"::{tok}::"]
              and "PATH=" in seen_text and tok not in seen_text and p.stderr == ""
              and (form == "live" or stat.S_IMODE(os.stat(log).st_mode) == 0o600))
        s.unit(f"ci/quiet.sh{' --live' if form == 'live' else ''}: the command's workflow commands are printed between "
               f"::stop-commands::<token> and ::<token>::, the token is not in its arguments or environment, its exit "
               f"code is kept", ok, f"exit {p.returncode}; stdout {p.stdout[-800:]!r}; stderr {p.stderr[-300:]!r}")
    s.unit("ci/quiet.sh: each run makes a new token", None not in tokens and tokens[0] != tokens[1], tokens)

    secret = os.path.join(base, "runner-only.txt")
    with open(secret, "w", encoding="utf-8") as f:
        f.write("SECRET-OF-THE-RUNNER\n")
    os.chmod(secret, 0o600)
    outside = os.path.join(base, "outside")
    os.mkdir(outside)
    with open(os.path.join(outside, "c.log"), "w", encoding="utf-8") as f:
        f.write("SECRET-OF-THE-RUNNER\n")
    top = os.path.join(base, "scratch")
    t = os.path.join(top, "judge-x", "test_a")
    os.makedirs(os.path.join(t, "editor", "sub"))
    os.makedirs(os.path.join(top, "judge-x", "records"))
    want = [os.path.join(top, "judge-x", "records", "test_a.log"), os.path.join(t, "adapter.stderr"),
            os.path.join(t, "editor", "sub", "e.log")]
    for path in want + [os.path.join(t, "media.mp4"), os.path.join(t, "notes.txt")]:
        with open(path, "w", encoding="utf-8") as f:
            f.write("a log line\n")
    os.symlink(secret, os.path.join(t, "editor", "token.log"))
    os.symlink(secret, os.path.join(t, "editor", "marker.stderr"))
    os.symlink(outside, os.path.join(t, "editor", "d.log"))
    os.symlink(outside, os.path.join(t, "editor", "d"))
    os.mkfifo(os.path.join(t, "editor", "fifo.log"))
    out = os.path.join(base, "judge-logs")
    os.mkdir(out)
    with open(os.path.join(out, "stale.log"), "w", encoding="utf-8") as f:
        f.write("from before\n")
    p = subprocess.Popen(["bash", os.path.join(ci, "collect_logs.sh"), f"{os.getuid()}:{os.getgid()}", out, top,
                          os.path.join(base, "not-there")], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    try:
        said, _ = p.communicate(timeout=60)
        rc = p.returncode
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL)  # its own session: the cp blocked on the FIFO too
        p.communicate()
        rc, said = None, "it did not end within 60 s (it opened the FIFO)"
    got, other, leaked = [], [], []
    for d, dirs, files in os.walk(out):
        for n in dirs + files:
            q = os.path.join(d, n)
            st = os.lstat(q)
            if stat.S_ISREG(st.st_mode):
                got.append(os.path.relpath(q, out))
                with open(q, encoding="utf-8", errors="replace") as f:
                    if "SECRET" in f.read():
                        leaked.append(q)
            elif not stat.S_ISDIR(st.st_mode):
                other.append(q)
    s.unit("ci/collect_logs.sh: only the regular *.log and *.stderr files are copied (no link, FIFO or linked folder, "
           "nothing older), into a folder of mode 0700",
           rc == 0 and sorted(got) == sorted(os.path.relpath(w, "/") for w in want) and not other and not leaked
           and stat.S_IMODE(os.stat(out).st_mode) == 0o700,
           f"exit {rc}; got {sorted(got)}; other {other}; leaked {leaked}; {said[-500:]}")


def main(run_py, parent=None, allow_unprotected=False, require_trace=False, as_user=None):
    if parent:
        os.makedirs(parent, exist_ok=True)
    s = SelfTest(run_py, parent, allow_unprotected)
    py = f"{shlex.quote(sys.executable)} -I -B"
    fail = r"^FAIL  test_{}: {}"
    traced = strace_here(require_trace)
    net = re.escape("nothing was downloaded: ")

    def drv(passed, total):
        """The JUDGE line of a test that started the fixture adapter: with strace, one more check (the download
        tripwire, passed); without it, that check is not observed."""
        return (rf"^JUDGE: {passed + 1}/{total + 1} passed( UNPROTECTED|$)" if traced
                else rf"^JUDGE: {passed}/{total} passed, 1 not observed( UNPROTECTED|$)")
    try:
        s.run("ok", 0, [r"^PASS  test_ok: a passing check", r"^JUDGE: 2/2 passed"])
        s.run("crash", 1, [fail.format("crash", "the test process exited cleanly"),
                           fail.format("crash", "the test reported its end")])
        s.run("hang", 1, [fail.format("hang", r"finished within 3 s")])
        s.run("sysexit", 1, [fail.format("sysexit", "the test ran to its end"),
                             fail.format("sysexit", "the test recorded the 2 checks it declares")])
        s.run("zero", 1, [fail.format("zero", "the test recorded checks")])
        s.run("fewer", 1, [fail.format("fewer", "the test recorded the 3 checks it declares  -- 2 recorded")])
        s.run("more", 1, [fail.format("more", "the test recorded the 1 checks it declares  -- 2 recorded")])
        s.run("undeclared", 1, [fail.format("undeclared", r"the test declares its number of checks")])
        bad = fail.format("malformed", "the result pipe carries only the test's records  -- line {}: {}")
        s.run("malformed", 1, [bad.format(3, "not json"), bad.format(4, "\ufffd"),
                               bad.format(5, re.escape('{"forged": 1}')), bad.format(6, re.escape("[1]")),
                               bad.format(7, re.escape('{"check": "x", "ok": "yes"')),
                               bad.format(8, re.escape('{"declare": 1}')), r"^PASS  test_malformed: one",
                               r"^JUDGE: 2/8 passed"])
        # strace failed while the editor ran (the download check's record says so): the test runs once more. Its
        # first run's checks are printed as "  try 1: " and not counted, its folder is kept as <test>.try1 with its
        # log; a second run that passes prints FLAKY, counts on the JUDGE line, keeps the run's folder and goes to
        # --flaky-file; one that fails fails the test; at most two tests a run are rerun.
        first = re.escape(STRACE_FAILED.split(";", 1)[0].split(" (", 1)[1].rstrip(")"))
        flaky_file = os.path.join(s.tmp, "flaky.txt")
        out = s.run("rerunpass", 0, [r"^  try 1: PASS  test_rerunpass: a passing check$",
                                     r"^  try 1: FAIL  test_rerunpass: " + net + r".*strace failed while the editor ran",
                                     r"^RERUN test_rerunpass: strace failed while the editor ran \(" + first
                                     + r"\)\. The first run's 3 checks are not counted \(kept: \S+test_rerunpass\.try1\)",
                                     r"^PASS  test_rerunpass: " + net + ".*  -- no other computer addressed$",
                                     r"^FLAKY test_rerunpass \(first run: strace failed while the editor ran: " + first
                                     + r"; rerun passed\)$",
                                     r"^JUDGE: 3/3 passed, 1 flaky \(strace\)( UNPROTECTED|$)",
                                     r"^judge: scratch kept for inspection: \S+ \(a test was rerun after strace failed"],
                    extra=("--flaky-file", flaky_file),
                    label="strace failed in the first run, the rerun passes: FLAKY, counted, the folder kept")
        kept = re.search(r"^judge: scratch kept for inspection: (\S+) ", out, re.M)
        logs = [os.path.join(kept.group(1), f"test_rerunpass{x}", "test.log") for x in (".try1", "")] if kept else []
        texts = [open(p, encoding="utf-8").read() if os.path.isfile(p) else "" for p in logs]
        s.unit("the rerun's first run is kept as test_rerunpass.try1 with its verdict in its log, the second run's "
               "log holds the FLAKY line, and --flaky-file holds exactly that line",
               len(texts) == 2 and "  try 1: FAIL  test_rerunpass: " + NET in texts[0] and "FLAKY test_rerunpass" in
               texts[1] and open(flaky_file, encoding="utf-8").read().splitlines() == [
                   ln for ln in out.splitlines() if ln.startswith("FLAKY ")] and out.count("\nFLAKY ") == 1,
               f"logs {logs}, texts {[t[-300:] for t in texts]}")
        s.run("rerunpass", 1, [r"^JUDGE: refused: --flaky-file \S+ exists"], extra=("--flaky-file", flaky_file),
              label="--flaky-file that exists: refused")
        out = s.run("rerunfail", 1, [r"^  try 1: FAIL  test_rerunfail: " + net, r"^RERUN test_rerunfail: ",
                                     fail.format("rerunfail", net + r".*strace failed while the editor ran"),
                                     r"^judge: test_rerunfail failed its rerun too \(the first run: strace failed while "
                                     r"the editor ran: " + first + r"\)$", r"^JUDGE: 2/3 passed( UNPROTECTED|$)"],
                    label="strace failed in both runs: the test fails")
        s.unit("...and no FLAKY line", "FLAKY" not in out)
        argv = s.runner("budget", extra=("--jobs", "1"))
        argv[argv.index("--only") + 1] = "test_budget"  # test_budget1, 2 and 3, one at a time
        p = subprocess.run(argv, capture_output=True, text=True, timeout=300, cwd=s.tmp, stdin=subprocess.DEVNULL)
        out = s.judge("three tests in which strace failed: two are rerun, the third fails as it is", p.returncode,
                      p.stdout + p.stderr, 1,
                      [r"^RERUN test_budget1: ", r"^RERUN test_budget2: ",
                       r"^judge: test_budget3 is not run again: 2 tests of this run were rerun already",
                       fail.format("budget3", net + r".*strace failed while the editor ran"),
                       r"^JUDGE: 6/9 passed( UNPROTECTED|$)"])
        s.unit("...and the third is not rerun", "RERUN test_budget3" not in out and "try 1: FAIL  test_budget3" not in out)
        bad = fail.format("rerunbad", "the result pipe carries only the test's records  -- line {}: ")
        out = s.run("rerunbad", 1, [bad.format(3), bad.format(4), bad.format(5), bad.format(6),
                                    r"^JUDGE: 2/6 passed( UNPROTECTED|$)"],
                    label="a rerun marker anywhere but on a failed download check of the runner's: not a record")
        s.unit("...and no rerun", "RERUN" not in out)
        s.run("leak", 1, [fail.format("leak", "nothing left running after the test  -- \\d+ sleep 300")])
        s.still_running("leak", s.pids_in("leak", "leak.pid"))
        if sys.platform.startswith("linux"):
            s.run("fork", 1, [fail.format("fork", "nothing left running after the test  -- \\d+ \\S+ -I -B ")],
                  label="a fork without exec that leaves the session and closes its descriptors")
            s.still_running("fork", s.pids_in("fork", "fork.pid"))
            s.run("forkwrite", 0, [r"^PASS  test_forkwrite: the fork child cannot write to the result pipe  -- "
                                   + re.escape(os.strerror(9)), r"^JUDGE: 2/2 passed"],
                  label="a fork child writes through the result pipe's number: EBADF, the verdict is unchanged")
        # The driver path, with the adapter named by a relative path (the runner makes it absolute).
        s.run("driver", 0, [r"^PASS  test_driver: the adapter speaks protocol 1", drv(3, 3)],
              adapter=f"{py} {FAKE_ADAPTER} 1 plain", label="driver, adapter named by a relative path")
        s.run("driver", 1, [fail.format("driver", "the adapter speaks protocol 1  -- hello says protocol 2"),
                            fail.format("driver", "the test ran to its end")],
              adapter=f"{py} {FAKE_ADAPTER} 2 plain", label="adapter speaks protocol 2")
        left = fail.format("driver", "nothing (the adapter started is )?left running after (the test|stop)  -- ")
        out = s.run("driver", 1, [left + "\\d+ sleep 300"],
                    adapter=f"{py} {FAKE_ADAPTER} 1 leak", label="adapter leaves a process at stop")
        s.still_running("adapter leak", [int(x) for x in re.findall(r"-- (\d+) sleep 300", out)])
        s.run("forge", 1, [fail.format("forge", "a check the editor fails"), drv(2, 3)],
              adapter=f"{py} {FAKE_ADAPTER} 1 forge", label="adapter forges passing results in the scratch folder")
        if sys.platform.startswith("linux"):
            s.procfd(drv(3, 3))
        # Statuses: not applicable passes and is counted, fails with --strict; not observed likewise with
        # --require-trace.
        na = r"^N/A   test_na: {}  -- not applicable: {}"
        s.run("na", 0, [r"^PASS  test_na: a check on a crafted file$",
                        na.format("a check whose input cannot be made", re.escape(
                            "the file the editor saved does not hold the clip path (replacements [0, 1])")),
                        na.format("a check recorded as not applicable", "the reason"),
                        r"^judge:   test_na: a check whose input cannot be made$",
                        r"^JUDGE: 2/2 passed, 2 not applicable( UNPROTECTED|$)"], label="not applicable: counted, the run passes")
        s.run("na", 1, [fail.format("na", "a check whose input cannot be made  -- not applicable, a failure with "
                                    "--strict: "), r"^JUDGE: 2/4 passed( UNPROTECTED|$)"], extra=("--strict",),
              label="not applicable with --strict: the run fails")
        s.run("nobs", 0, [r"^N/O   test_nobs: a trace check  -- not observed: strace is not installed",
                          r"^JUDGE: 2/2 passed, 1 not observed( UNPROTECTED|$)"], label="not observed: counted, the run passes")
        s.run("nobs", 1, [fail.format("nobs", "a trace check  -- not observed, a failure with --require-trace"),
                          r"^JUDGE: 2/3 passed( UNPROTECTED|$)"], extra=("--require-trace",),
              label="not observed with --require-trace: the run fails")
        # The graphics add-on: start carries it when the runner has one and the test asks; without one the test's
        # checks on it are not applicable (a failure with --strict); a folder that is not the pinned add-on is refused.
        name = re.escape("the adapter got the judge's graphics add-on in start")
        s.run("addon", 0, [rf"^PASS  test_addon: {name}", drv(3, 3)], adapter=f"{py} {FAKE_ADAPTER} 1 addon",
              extra=("--graphics-addon", s.addon_fixture("addon-ok")),
              label="--graphics-addon: the adapter gets the add-on's root and browser in start")
        na_line = (r"^JUDGE: 3/3 passed, 1 not applicable( UNPROTECTED|$)" if traced
                   else r"^JUDGE: 2/2 passed, 1 not applicable, 1 not observed( UNPROTECTED|$)")
        s.run("addon", 0, [rf"^N/A   test_addon: {name}  -- not applicable: no graphics add-on was given", na_line],
              adapter=f"{py} {FAKE_ADAPTER} 1 addon", env={"JUDGE_GRAPHICS_ADDON": ""},
              label="no --graphics-addon: start carries none, the check is not applicable")
        s.run("addon", 1, [fail.format("addon", f"{name}  -- not applicable, a failure with --strict")],
              adapter=f"{py} {FAKE_ADAPTER} 1 addon", extra=("--strict",), env={"JUDGE_GRAPHICS_ADDON": ""},
              label="no --graphics-addon with --strict: the run fails")
        s.run("addon", 1, [r"^JUDGE: refused: --graphics-addon \S+: \S+ holds @remotion/renderer 0\.0\.1, not "],
              adapter=f"{py} {FAKE_ADAPTER} 1 addon", extra=("--graphics-addon", s.addon_fixture("addon-old", "0.0.1")),
              label="--graphics-addon with another Remotion version: refused")
        s.run("addon", 1, [r"^JUDGE: refused: --graphics-addon \S+: \S+ has no headless shell at "],
              adapter=f"{py} {FAKE_ADAPTER} 1 addon", extra=("--graphics-addon", s.addon_fixture("addon-noshell",
                                                                                             shell=False)),
              label="--graphics-addon without the headless shell: refused")
        # The download tripwire (strace on the adapter's tree, ptrace_scope 1 allows it: strace starts the adapter).
        if traced:
            s.run("driver", 1, [fail.format("driver", net + ".*htons\\(53\\).*192\\.0\\.2\\.1"),
                                r"^JUDGE: 3/4 passed( UNPROTECTED|$)"],
                  adapter=f"{py} {FAKE_ADAPTER} 1 connect",
                  label="the adapter starts a DNS lookup: the download check fails")
            for mode, dest, what in (
                    ("udp", r"htons\(9\).*192\.0\.2\.1", "a UDP connect to 192.0.2.1 port 9 and a write()"),
                    ("udpsend", r"sendto\(.*htons\(9\).*192\.0\.2\.1", "a UDP sendto() to 192.0.2.1 port 9"),
                    ("tcp", r"htons\(80\).*192\.0\.2\.1", "a TCP connect to 192.0.2.1 port 80")):
                s.run("driver", 1, [fail.format("driver", net + ".*" + dest), r"^JUDGE: 3/4 passed( UNPROTECTED|$)"],
                      adapter=f"{py} {FAKE_ADAPTER} 1 {mode}", label=f"the adapter makes {what}: the download check fails")
            # The adapter cannot reach the trace: whatever it does to the files it can reach, the check fails on the
            # DNS lookup itself (the detail starts with the hit, no other reason comes first).
            hit = net + r"[^\n]*?  -- \[\"\d+ connect\([^\n]*htons\(53\)[^\n]*192\.0\.2\.1"
            for mode, what in (
                    ("rewrite", "rewrites every file it can reach without the line, padded"),
                    ("truncate", "empties every file it can reach"),
                    ("unlink", "deletes every file it can reach")):
                s.run("driver", 1, [fail.format("driver", hit), r"^JUDGE: 3/4 passed( UNPROTECTED|$)"],
                      adapter=f"{py} {FAKE_ADAPTER} 1 {mode}",
                      label=f"the adapter starts a DNS lookup and at stop {what}: the hit is still seen")
            s.run("driver", 1, [fail.format("driver", hit), r"^JUDGE: 3/4 passed( UNPROTECTED|$)"],
                  adapter=f"{py} {FAKE_ADAPTER} 1 inject", extra=("--keep",),
                  label="the adapter writes a partial line everywhere it can, then starts a DNS lookup and "
                        "overwrites its port in place: the hit is still seen")
            s.inject()
            # Two shapes, both a failed run with the download check failed on the ended trace. strace 5.x leaves the
            # adapter running when strace ends: the test runs to its end (3/4). strace 6.x with --seccomp-bpf implies
            # --kill-on-exit (PTRACE_O_EXITKILL: a seccomp filter cannot be removed, so an untraced tracee would get
            # ENOSYS), so ending strace also kills the adapter (code -9) and the test fails early (2/6).
            s.run("driver", 1, [fail.format("driver", net + r".*  -- the trace ended before the editor was asked to "
                                            r"stop"), r"^JUDGE: (3/4|2/6) passed( UNPROTECTED|$)"],
                  adapter=f"{py} {FAKE_ADAPTER} 1 killstrace",
                  label="the adapter ends strace, then starts a DNS lookup: the download check fails")
            # A traced child that outlives stop: the trace ends only after it has ended. Found by the sweep (it
            # carries the scratch folder), it is ended and named; with an empty environment it is not found, and the
            # trace that does not end fails the download check. Either way the DNS lookup it starts once strace no
            # longer traces it cannot pass the run.
            s.run("driver", 1, [fail.format("driver", re.escape(run_left()) + r"  -- \d+ \S+ -I -c ")],
                  adapter=f"{py} {FAKE_ADAPTER} 1 outlive", extra=("--keep",),
                  label="the adapter leaves a traced child at stop: the test's sweep ends it and the run fails")
            s.still_running("outliving child", s.pids_in("driver", "outlive.pid"))
            s.run("driver", 1, [fail.format("driver", net + r".*  -- the trace did not end within \d+ s of stop: a "
                                            r"traced process outlived stop"), r"^JUDGE: 3/4 passed( UNPROTECTED|$)"],
                  adapter=f"{py} {FAKE_ADAPTER} 1 outlivehidden", extra=("--keep",),
                  label="the adapter leaves a traced child with an empty environment at stop: the trace does not "
                        "end and the download check fails")
            s.still_running("outliving child with an empty environment", s.pids_in("driver", "outlivehidden.pid"))
            s.run("driver", 0, [r"^PASS  test_driver: the fixture editor started", r"^PASS  test_driver: " + net,
                                r"^JUDGE: 4/4 passed( UNPROTECTED|$)"], adapter=f"{py} {FAKE_ADAPTER} 1 uring",
                  label="the adapter asks for an io_uring: strace refuses it (the fixture refuses start if it gets one)")
            s.run("driver", 0, [r"^PASS  test_driver: " + net, r"^JUDGE: 4/4 passed( UNPROTECTED|$)"],
                  adapter=f"{py} {FAKE_ADAPTER} 1 loopback",
                  label="the adapter makes a UDP connect to 127.0.0.1 and Chromium's IPv6 probe: the check passes")
            # JUDGE_STRACE through a symbolic link in a folder this user can write: with --require-trace it is not
            # used (the link could be pointed elsewhere after the check); without, its real path is what runs.
            link = os.path.join(s.tmp, "strace-link")
            os.symlink(run_strace_path(), link)
            # (The reason is matched on the "trace with" line, which is printed whole: a check's detail is cut at 400
            # characters, and the two paths in it are long when the scratch folder's path is.)
            s.run("driver", 1, [fail.format("driver", net + ".*a failure with --require-trace: strace .*strace-link is "
                                            "not used with --require-trace: "),
                                r"^judge: trace with nothing \(strace .*strace-link is not used with --require-trace: "
                                r".*strace-link is a symbolic link in a folder this user can write",
                                r"^JUDGE: 3/4 passed( UNPROTECTED|$)"],
                  adapter=f"{py} {FAKE_ADAPTER} 1 plain", env={"JUDGE_STRACE": link}, extra=("--require-trace",),
                  label="a JUDGE_STRACE symbolic link in a folder this user can write, with --require-trace: refused")
            s.run("driver", 0, [r"^judge: trace with " + re.escape(run_strace_path()) + r"( |$)",
                                r"^JUDGE: 4/4 passed( UNPROTECTED|$)"],
                  adapter=f"{py} {FAKE_ADAPTER} 1 plain", env={"JUDGE_STRACE": link},
                  label="a JUDGE_STRACE symbolic link without --require-trace: its real path runs")
        else:
            print(f"{'FAIL' if require_trace else 'skip'} the download tripwire cases: strace is not installed"
                  + (" (--require-trace)" if require_trace else ""), flush=True)
            s.failures += bool(require_trace)
        # --as-user: a user that is root, the runner's own, or not there is refused before anything runs (no sudo
        # needed). The cases with another user run only when --as-user names one (judge.yml does); then a sudo -n
        # that does not work fails them.
        if sys.platform.startswith("linux"):
            import pwd
            me = pwd.getpwuid(os.geteuid()).pw_name
            for who, why in ((me, "is root" if os.geteuid() == 0 else "is the user that runs the judge"),
                             ("root", "is root"), ("judge-no-such-user", "no such user")):
                s.run("ok", 1, [r"^JUDGE: refused: --as-user " + re.escape(who) + ": " + ("" if why == "no such user"
                                                                                          else re.escape(who) + " ")
                                + re.escape(why)], extra=("--as-user", who), label=f"--as-user {who}: refused")
            if as_user:
                user_cases(s, as_user, traced, py, drv, fail, net, left)
            else:
                print("skip the --as-user cases with another user: no --as-user given (judge.yml gives one)",
                      flush=True)
        sys.path.insert(0, JUDGE)
        lockout_units(s)
        ci_scripts(s)
        # The form of an strace line (observe.strace_line_problem): text joined to strace's own line in front or in
        # the middle cannot hide a call.
        import observe
        measure_units(s, observe)
        read_cap_units(s, observe)
        look_units(s)
        tracetail_units(s)
        real = ('1234 connect(3<UDP:[5]>, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("192.0.2.1")}, '
                '16) = 0')
        good = [real, '7 openat(AT_FDCWD</a>, "/dev/null", O_RDONLY) = 3</dev/null<char 1:3>>',
                '7 openat(AT_FDCWD</a>, "a\\"b<c>d 12 connect(\\\\x\\n", O_RDWR) = 3</a/a\\"b\\74c\\76d 12 connect(>',
                '7 sendto(3<UDP:[10.0.0.2:5->192.0.2.1:53]>, "x", 1, 0, NULL, 0) = 1',
                '7 read(3,  <unfinished ...>', '7 mkdir("/a", 0777 <unfinished ...>', '7 <... read resumed>"", 1) = 0',
                '7 sendto(5<UNIX-STREAM:[1->2]>, "x", 1, MSG_NOSIGNAL, NULL, 0 <unfinished ...>', '7 exit_group(0) = ?',
                '7 io_uring_setup(1, 0x7f) = -1 ENOSYS (Function not implemented) (INJECTED)',
                '7 ????( <unfinished ...>', '7 ????( <detached ...>', '7 ???( <unfinished ...>', '7 ???( <detached ...>',
                '7 ???() = ?', '7 ????() = ?']
        bad = ['0 open(""' + real, '0 open("' + real, '0 read(3<' + real, '0 x(' + real, real[:70],
               '0 x(7 <... io_uring_setup resumed>) = 3<anon_inode:[io_uring]>',
               '0 strace: Process 5 attached', '0 ' + real[5:].replace("connect", "Connect"),
               '7 ????(1, 2) = 0', '7 ????( <unfinished ...>' + real, '7 ????( <unavailable>',
               '7 ????( <detached ...>) = 0', real + ' 7 ????( <unfinished ...>', '7 ???(1, 2) = 0',
               '7 ???( <unfinished ...>' + real, '7 ???( <unavailable>', '7 ???( <detached ...>) = 0',
               '7 ??( <unfinished ...>', '7 ?????( <unfinished ...>', '7 ???(  <unfinished ...>',
               real + ' 7 ???( <unfinished ...>', '7 ???() = 0', '7 ???(1) = ?', '7 ???() = ? ' + real,
               real + ' 7 ???() = ?', '7 ??() = ?']
        s.unit("a real strace line passes the line check (also strace's own line for a call whose tracee was gone "
               "at its entry: '<pid> ????( <unfinished ...>', and strace 6.x's '<pid> ???( <unfinished ...>' and '<pid> ???() = ?')",
               all(observe.strace_line_problem(ln) is None for ln in good),
               [(ln, observe.strace_line_problem(ln)) for ln in good if observe.strace_line_problem(ln)])
        s.unit("text joined to an strace line, or a line cut short, fails the line check",
               all(observe.strace_line_problem(ln) for ln in bad),
               [ln for ln in bad if not observe.strace_line_problem(ln)])
        s.run("driver", 0, [r"^N/O   test_driver: " + net + ".*not observed: strace is not installed",
                            r"^JUDGE: 3/3 passed, 1 not observed( UNPROTECTED|$)"], adapter=f"{py} {FAKE_ADAPTER} 1 connect",
              env={"JUDGE_STRACE": ""}, label="no strace: the download check is not observed, the run passes")
        s.run("driver", 1, [fail.format("driver", net + ".*a failure with --require-trace"), r"^JUDGE: 3/4 passed( UNPROTECTED|$)"],
              adapter=f"{py} {FAKE_ADAPTER} 1 connect", env={"JUDGE_STRACE": ""}, extra=("--require-trace",),
              label="no strace with --require-trace: the run fails")
        s.run("driver", 0, [r"^N/O   test_driver: " + net + ".*not observed: strace .*fake_strace\\.sh does not trace a "
                            r"child here: it did not record the probe's UDP connect",
                            r"^JUDGE: 3/3 passed, 1 not observed( UNPROTECTED|$)"],
              adapter=f"{py} {FAKE_ADAPTER} 1 connect", env={"JUDGE_STRACE": s.fake_strace},
              label="a JUDGE_STRACE that does not trace: not used (its probe fails), the check is not observed")
        s.run("driver", 1, [fail.format("driver", net + ".*a failure with --require-trace: strace .*fake_strace\\.sh "
                                        "is not used with --require-trace"),
                            r"^JUDGE: 3/4 passed( UNPROTECTED|$)"],
              adapter=f"{py} {FAKE_ADAPTER} 1 connect", env={"JUDGE_STRACE": s.fake_strace}, extra=("--require-trace",),
              label="a JUDGE_STRACE this user can write, with --require-trace: the run fails")
        # The protection fails open nowhere: a runner or test process that is not non-dumpable fails the run unless
        # --allow-unprotected is given, and then the JUDGE line says UNPROTECTED.
        force = "JUDGE_FORCE_UNPROTECTED"
        if not allow_unprotected:  # with --allow-unprotected on every runner these two cannot refuse
            s.run("ok", 1, [r"^JUDGE: refused: the runner is not protected \(forced by JUDGE_FORCE_UNPROTECTED\)"],
                  env={force: "runner"}, label="the runner cannot be made non-dumpable: the run is refused")
            s.run("ok", 1, [fail.format("ok", re.escape(PROTECTED) + "  -- UNPROTECTED: forced by "
                                        "JUDGE_FORCE_UNPROTECTED; the test is not run"),
                            r"^JUDGE: \d+/\d+ passed UNPROTECTED \(1 test process"],
                  env={force: "child"}, label="a test process cannot be made non-dumpable: the test fails")
        s.run("ok", 0, [r"^PASS  test_ok: a passing check", r"^PASS  test_ok: " + re.escape(PROTECTED),
                        r"^JUDGE: 3/3 passed UNPROTECTED \(runner: forced by JUDGE_FORCE_UNPROTECTED, 1 test process"],
              env={force: "runner,child"}, extra=("--allow-unprotected",),
              label="--allow-unprotected: the run passes and says UNPROTECTED")
        s.interrupt()
        s.sub("the v0.2.0 adapter's self-test",
              [sys.executable, "-I", "-B", os.path.join(JUDGE, "adapters", "v020", "adapter.py"), "--self-test"])
        s.sub("check_observe.py's self-test",
              [sys.executable, "-I", "-B", os.path.join(JUDGE, "check_observe.py"), "--self-test"])
    finally:
        if not s.failures:
            shutil.rmtree(s.tmp, ignore_errors=True)
    print(f"[run.py] self-test FAILED: {s.failures} case(s); kept {s.tmp}" if s.failures else "[run.py] self-test ok")
    return 1 if s.failures else 0
