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
not make) passes the run and is counted on the JUDGE line, and fails it with --strict; a check recorded as not
observed passes and is counted, and fails with --require-trace. The download tripwire: an adapter that starts a DNS
lookup (a UDP connect to 192.0.2.1 port 53), makes a UDP connect to 192.0.2.1 port 9 and writes with write(), sends
with sendto() to 192.0.2.1 port 9, or starts a TCP connect to 192.0.2.1 port 80 fails the run's "nothing was
downloaded" check. The adapter cannot reach the trace: one that starts a DNS lookup and at stop rewrites, empties or
deletes every file it can reach (the scratch folder, and the logs next to it with the copy of the trace), or one
that writes a partial strace line to every descriptor it holds, to strace's descriptors through /proc and to those
files and then overwrites the lookup's port in those files, still fails the check on the lookup itself, and its open
of strace's trace channel (a socket) through /proc is refused (ENXIO). One that ends strace fails the check (the
trace ended before stop). One that leaves a traced child running at stop that starts a DNS lookup once strace no
longer traces it fails the run: the test process's sweep ends it (left running after stop), or, with an empty
environment the sweep cannot read, the trace does not end and the download check fails. A line that is not of strace's form (text
joined to an strace line, a line cut short) fails the line check; real strace lines pass it. An adapter that asks
for an io_uring is refused one (strace injects ENOSYS). One that makes a UDP connect to 127.0.0.1 and Chromium's IPv6
probe ([2001:4860:4860::8888]:443, no packet) passes the check. With strace switched off (JUDGE_STRACE empty) the
check is not observed, a failure with --require-trace; a JUDGE_STRACE that runs its command without tracing it is
not used (the check is not observed), and with --require-trace it fails the run, as does a JUDGE_STRACE that is a
symbolic link in a folder this user can write (without --require-trace its real path runs). The cases that need
strace are skipped without it, unless --require-trace is given (judge.yml): then a missing strace fails the
self-test.
"""
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time

JUDGE = os.path.dirname(os.path.abspath(__file__))
PROTECTED = "the test process is non-dumpable (its result pipe cannot be reopened through /proc)"  # run.PROTECTED_CHECK

HEAD = "import os, subprocess, sys, time\n"

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
    "nobs": "PORT_BOUND = False\nCHECKS = 2\ndef run(t):\n    t.check('a passing check', True)\n"
            "    t.not_observed('a trace check', 'strace is not installed')\n",
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
# probe, which observe.net_hits allows).
FAKE = r'''import errno, json, os, socket, subprocess, sys, time
proto, mode = int(sys.argv[1]), sys.argv[2]
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


def main(run_py, parent=None, allow_unprotected=False, require_trace=False):
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
            s.run("driver", 1, [fail.format("driver", net + ".*a failure with --require-trace: strace .*strace-link is "
                                            "not used with --require-trace: .*strace-link is a symbolic link in a "
                                            "folder this user can write"), r"^JUDGE: 3/4 passed( UNPROTECTED|$)"],
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
        # The form of an strace line (observe.strace_line_problem): text joined to strace's own line in front or in
        # the middle cannot hide a call.
        sys.path.insert(0, JUDGE)
        import observe
        real = ('1234 connect(3<UDP:[5]>, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("192.0.2.1")}, '
                '16) = 0')
        good = [real, '7 openat(AT_FDCWD</a>, "/dev/null", O_RDONLY) = 3</dev/null<char 1:3>>',
                '7 openat(AT_FDCWD</a>, "a\\"b<c>d 12 connect(\\\\x\\n", O_RDWR) = 3</a/a\\"b\\74c\\76d 12 connect(>',
                '7 sendto(3<UDP:[10.0.0.2:5->192.0.2.1:53]>, "x", 1, 0, NULL, 0) = 1',
                '7 read(3,  <unfinished ...>', '7 mkdir("/a", 0777 <unfinished ...>', '7 <... read resumed>"", 1) = 0',
                '7 sendto(5<UNIX-STREAM:[1->2]>, "x", 1, MSG_NOSIGNAL, NULL, 0 <unfinished ...>', '7 exit_group(0) = ?',
                '7 io_uring_setup(1, 0x7f) = -1 ENOSYS (Function not implemented) (INJECTED)']
        bad = ['0 open(""' + real, '0 open("' + real, '0 read(3<' + real, '0 x(' + real, real[:70],
               '0 x(7 <... io_uring_setup resumed>) = 3<anon_inode:[io_uring]>',
               '0 strace: Process 5 attached', '0 ' + real[5:].replace("connect", "Connect")]
        s.unit("a real strace line passes the line check",
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
