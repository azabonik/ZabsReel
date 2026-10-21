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
    "interrupt": "PORT_BOUND = False\nCHECKS = 1\nTIMEOUT = 600\ndef run(t):\n"
                 "    p = subprocess.Popen(['sleep', '300'], start_new_session=True)\n"
                 "    open(t.path('pids.tmp'), 'w').write(f'{os.getpid()} {p.pid}')\n"
                 "    os.rename(t.path('pids.tmp'), t.path('pids'))\n"
                 "    t.check('one', True)\n    time.sleep(600)\n",
}

# A fixture adapter: fake_adapter.py <protocol> <mode>. mode "leak" leaves a process running at stop; "forge" writes
# passing result lines into results.jsonl and every other file it can find under its scratch folder; "procfd" lists
# the descriptors it holds, then tries to open every descriptor of the test process (its parent) and of the runner
# (its grandparent) for writing through /proc/<pid>/fd, writes a passing record through any it opens, and reports each
# attempt in procfd.json in its scratch folder.
FAKE = r'''import json, os, subprocess, sys
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
    test = os.getppid()
    with open(f"/proc/{test}/stat", "rb") as f:
        runner = int(f.read().rsplit(b")", 1)[1].split()[1])
    with open(f"/proc/{test}/cmdline", "rb") as f:
        argv = f.read().split(b"\0")
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
    elif op == "stop":
        res = {}
        if mode == "leak":
            subprocess.Popen(["sleep", "300"], start_new_session=True)  # inherits this adapter's environment
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


def _alive(pid):
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            return f.read().rsplit(b")", 1)[1].split()[0] != b"Z"
    except (OSError, IndexError):
        return False


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

    def procfd(self):
        """The procfd adapter's report: no descriptor inherited, and every open of the test's or the runner's
        descriptors through /proc refused with PermissionError (a dumpable process gives FileNotFoundError for a
        number it does not use, and opens the ones it does)."""
        self.run("driver", 0, [r"^PASS  test_driver: the fixture editor started", r"^JUDGE: 3/3 passed"],
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


def main(run_py, parent=None, allow_unprotected=False):
    if parent:
        os.makedirs(parent, exist_ok=True)
    s = SelfTest(run_py, parent, allow_unprotected)
    py = f"{shlex.quote(sys.executable)} -I -B"
    fail = r"^FAIL  test_{}: {}"
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
        s.run("driver", 0, [r"^PASS  test_driver: the adapter speaks protocol 1", r"^JUDGE: 3/3 passed"],
              adapter=f"{py} {FAKE_ADAPTER} 1 plain", label="driver, adapter named by a relative path")
        s.run("driver", 1, [fail.format("driver", "the adapter speaks protocol 1  -- hello says protocol 2"),
                            fail.format("driver", "the test ran to its end")],
              adapter=f"{py} {FAKE_ADAPTER} 2 plain", label="adapter speaks protocol 2")
        out = s.run("driver", 1, [fail.format("driver", "nothing left running after the test  -- \\d+ sleep 300")],
                    adapter=f"{py} {FAKE_ADAPTER} 1 leak", label="adapter leaves a process at stop")
        s.still_running("adapter leak", [int(x) for x in re.findall(r"-- (\d+) sleep 300", out)])
        s.run("forge", 1, [fail.format("forge", "a check the editor fails"), r"^JUDGE: 2/3 passed"],
              adapter=f"{py} {FAKE_ADAPTER} 1 forge", label="adapter forges passing results in the scratch folder")
        if sys.platform.startswith("linux"):
            s.procfd()
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
