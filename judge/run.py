#!/usr/bin/env python3
"""Runs the judge's tests against one editor build through an adapter (judge/PROTOCOL.md).

    python3 -I judge/run.py [--adapter "<command>"] [--build <dir>] [--only <text>] [--timeout <s>] [--jobs <n>]
                            [--scratch <dir>] [--keep] [--list] [--allow-unprotected]
    python3 -I judge/run.py --self-test

--adapter   the adapter command (default: this judge's v0.2.0 adapter, run with this Python). A word that names an
            existing file or folder relative to the current folder is made absolute: the adapter runs with its
            current folder set to the test's scratch folder.
--build     the editor checkout or build the adapter starts (default: the folder that holds judge/)
--only      run only the tests whose file name contains this text
--timeout   seconds per test, for every test (default: each test's TIMEOUT, else 600)
--jobs      tests that use no network port run this many at a time (default 2); port-bound tests run one at a time
--scratch   the folder for this run's scratch folder (default: $JUDGE_SCRATCH, else the system temp folder)
--keep      keep the scratch folder after a run that passed (a failed run always keeps it)
--allow-unprotected
            run even when the runner or a test process cannot be made non-dumpable (see below); the JUDGE line says
            UNPROTECTED. Development only (not Linux); CI never passes it
--self-test the runner's own tests (judge/selftest.py): each way a test can fail must fail the run

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
"""
import argparse
import ctypes
import importlib.util
import json
import os
import shlex
import shutil
import signal
import socket
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


def scratch_pids(folder):
    """Process ids whose environment has a value inside `folder` (Linux /proc; elsewhere none are found)."""
    if not os.path.isdir("/proc"):
        return []
    root = os.path.realpath(folder).encode()
    skip = _ancestors()
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


def sweep(folder):
    """Ends every process left whose environment names `folder`. Returns [(pid, cmdline)] of what it found."""
    left = []
    for _ in range(3):
        pids = scratch_pids(folder)
        if not pids:
            break
        left += [(p, cmdline(p)) for p in pids]
        end_pids(pids)
    return left


# ---------------------------------------------------------------- the test's side (child process)
class T:
    """What a test's run(t) gets: its scratch folder, the media, checks, and the editor (t.driver())."""

    def __init__(self, name, scratch, media, build, adapter, out):
        self.name, self.scratch, self.media_dir, self.build, self.adapter = name, scratch, media, build, adapter
        self._out = out  # the write end of the runner's result pipe
        self._driver = None
        self.n_checks = 0
        self.trace_path = None  # set by driver(trace=True) when strace runs

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
        """A path in this test's scratch folder (its parent folders are made)."""
        p = os.path.join(self.scratch, *parts)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        return p

    def check(self, name, ok, detail="", harness=False):
        """Records one check. Returns ok. A harness check (one the runner adds, such as "port closed after stop") is
        not counted against the test's CHECKS."""
        if not harness:
            self.n_checks += 1
        rec = {"check": str(name), "ok": bool(ok), "detail": str(detail)}
        if harness:
            rec["harness"] = True
        self._emit(rec)
        return bool(ok)

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

    def driver(self, trace=False):
        """The editor, started through the adapter in this test's scratch folder (started once per test). The
        adapter must answer hello with this judge's protocol version first.

        trace=True (on the first call): when `strace` is on PATH, the adapter runs under `strace -f -e trace=%file`,
        so every file-system call of the adapter, the editor and every process they start is logged to
        self.trace_path (observe.trace_hits reads it). Without strace, self.trace_path stays None and the test
        records its trace checks as not observed."""
        if self._driver is None:
            import driver
            cmd = list(self.adapter)
            if trace and shutil.which("strace"):
                self.trace_path = os.path.join(self.scratch, "adapter-strace.log")
                cmd = [shutil.which("strace"), "-f", "-qq", "-s", "4096", "-e", "trace=%file", "-e", "signal=none",
                       "-o", self.trace_path, "--"] + cmd
            self._driver = driver.Driver(cmd, self.scratch)
            hello = self._driver.hello()
            proto = hello.get("protocol") if isinstance(hello, dict) else None
            if not self.check(f"the adapter speaks protocol {driver.PROTOCOL}", proto == driver.PROTOCOL,
                              f"hello says protocol {proto!r}", harness=True):
                raise driver.AdapterError(f"the adapter speaks protocol {proto!r}, not {driver.PROTOCOL}", op="hello")
            self._driver.start(self.build)
        return self._driver

    def finish(self):
        d = self._driver
        if d is None:
            return
        try:
            if d.started:
                d.stop()
        except Exception as e:  # noqa: BLE001
            self.check("the editor stops when asked", False, str(e), harness=True)
        finally:
            d.close()
        for port in d.ports:
            deadline = time.time() + 10
            while time.time() < deadline and _listening(port):
                time.sleep(0.2)
            self.check(f"port {port} is closed after stop", not _listening(port), harness=True)


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
    t = T(os.path.basename(a.child)[:-3], a.scratch, a.media, a.build, json.loads(a.adapter_json), out)
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


def known_record(r, i, n):
    """Whether record `i` of `n` has one of the shapes T._emit writes, in its place: {"declare": int or None} first,
    {"check": str, "ok": bool, "detail": str} (with "harness": true for a runner-added check), {"end": true} last."""
    if not isinstance(r, dict):
        return False
    keys = set(r)
    if keys == {"declare"}:
        return i == 0 and (r["declare"] is None or (_is_int(r["declare"]) and r["declare"] >= 0))
    if keys == {"end"}:
        return i == n - 1 and r["end"] is True
    if keys in ({"check", "ok", "detail"}, {"check", "ok", "detail", "harness"}):
        return (isinstance(r["check"], str) and isinstance(r["ok"], bool) and isinstance(r["detail"], str)
                and r.get("harness", True) is True)
    return False


def verdict(recs, timed_out, returncode, timeout, left, channel_closed):
    """The checks for one test from its pipe records and what the runner saw. A record of another shape, or out of its
    place, fails the test (a corrupted or tampered pipe), and is not counted as a check."""
    checks = []
    bad = [(i, r) for i, r in enumerate(recs) if not known_record(r, i, len(recs))]
    for i, r in bad:
        text = r.raw.decode("utf-8", "replace") if isinstance(r, BadLine) else json.dumps(r)
        checks.append({"check": "the result pipe carries only the test's records", "ok": False,
                       "detail": f"line {i + 1}: {_short(text, 200)}"})
    recs = [r for i, r in enumerate(recs) if known_record(r, i, len(recs))]
    declared = recs[0].get("declare") if recs and isinstance(recs[0], dict) and "declare" in recs[0] else None
    ended = any(isinstance(r, dict) and r.get("end") is True for r in recs)
    counted = 0
    for r in recs:
        if isinstance(r, dict) and "check" in r:
            harness = r.get("harness") is True
            counted += not harness
            checks.append({"check": str(r.get("check")), "ok": r.get("ok") is True, "detail": r.get("detail") or ""})
    if not isinstance(declared, int) or isinstance(declared, bool):
        checks.append({"check": "the test declares its number of checks (CHECKS)", "ok": False,
                       "detail": "no declaration as its first record"})
    elif counted != declared:
        checks.append({"check": f"the test recorded the {declared} checks it declares", "ok": False,
                       "detail": f"{counted} recorded"})
    if counted == 0:
        checks.append({"check": "the test recorded checks", "ok": False, "detail": "no check was recorded"})
    if timed_out:
        checks.append({"check": f"finished within {timeout} s", "ok": False, "detail": "ended by the runner"})
    else:
        if returncode != 0:
            checks.append({"check": "the test process exited cleanly", "ok": False, "detail": f"exit {returncode}"})
        if not ended:
            checks.append({"check": "the test reported its end", "ok": False, "detail": "no end record"})
    if not channel_closed:
        checks.append({"check": "the result pipe closed after the test", "ok": False,
                       "detail": "a process still holds its write end"})
    checks.append({"check": "nothing left running after the test", "ok": not left,
                   "detail": "; ".join(f"{pid} {cmd[:120]}" for pid, cmd in left)})
    return checks


def run_test(meta, a, base, media, adapter):
    name = meta["name"]
    scratch = os.path.realpath(os.path.join(base, name))
    os.makedirs(scratch)
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

    with open(os.path.join(scratch, "test.log"), "wb") as logf:
        try:
            p = subprocess.Popen([sys.executable, "-I", "-B", os.path.abspath(__file__), "--child", meta["path"],
                                  "--scratch", scratch, "--results-fd", str(w), "--media", media, "--build", a.build,
                                  "--adapter-json", json.dumps(adapter)]
                                 + (["--allow-unprotected"] if a.allow_unprotected else []),
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
    reader.join(10)
    with LIVE_LOCK:
        LIVE.pop(name, None)
    checks = verdict(list(recs), timed_out, p.returncode, timeout, left, not reader.is_alive())
    with PRINT_LOCK:
        RESULTS.extend(checks)
        for c in checks:
            detail = _short(c.get("detail") or "", 400)
            print(f"{'PASS' if c['ok'] else 'FAIL'}  {name}: {c['check']}" + (f"  -- {detail}" if detail else ""),
                  flush=True)
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
        passed = sum(1 for c in RESULTS if c["ok"])
        try:
            sys.stdout.flush()
        except Exception:  # noqa: BLE001
            pass
        os.write(1, (f"JUDGE: interrupted by signal {signum} ({passed}/{len(RESULTS)} checks passed before it)\n"
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
    ap.add_argument("--allow-unprotected", action="store_true",
                    help="run even when the runner or a test process cannot be made non-dumpable (not Linux, or prctl "
                         "fails); the JUDGE line then says UNPROTECTED. For development only; CI never passes it")
    ap.add_argument("--tests", default=os.path.join(JUDGE, "tests"), help=argparse.SUPPRESS)
    # child mode (one test, started by the runner)
    ap.add_argument("--child", help=argparse.SUPPRESS)
    ap.add_argument("--results-fd", help=argparse.SUPPRESS)
    ap.add_argument("--media", help=argparse.SUPPRESS)
    ap.add_argument("--adapter-json", help=argparse.SUPPRESS)
    a = ap.parse_args()
    if a.child:
        return child(a, unprotected)
    if a.self_test:
        import selftest
        return selftest.main(os.path.abspath(__file__), a.scratch, a.allow_unprotected)

    a.build = os.path.abspath(a.build)
    adapter = absolute_words(shlex.split(a.adapter)) if a.adapter else [
        sys.executable, "-I", "-B", os.path.join(JUDGE, "adapters", "v020", "adapter.py")]
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

    import observe
    parent = a.scratch or tempfile.gettempdir()
    os.makedirs(parent, exist_ok=True)
    base = os.path.realpath(tempfile.mkdtemp(prefix="judge-", dir=parent))
    handler = _on_signal(base)
    signal.signal(signal.SIGTERM, handler)
    signal.signal(signal.SIGINT, handler)
    print(f"judge: adapter {' '.join(adapter)}")
    print(f"judge: build {a.build}")
    print(f"judge: measurements with {observe.ffmpeg_version()} ({observe.FFMPEG})")
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

    passed = sum(1 for c in results if c["ok"])
    ok = passed == len(results) and results
    tests_unprotected = sum(1 for c in results if c["check"] == PROTECTED_CHECK)
    mark = ""
    if unprotected or tests_unprotected:
        mark = (" UNPROTECTED (" + ", ".join(([f"runner: {unprotected}"] if unprotected else [])
                                             + ([f"{tests_unprotected} test process(es)"] if tests_unprotected else []))
                + ")")
    print(f"JUDGE: {passed}/{len(results)} passed{mark}", flush=True)
    if ok and not a.keep:
        shutil.rmtree(base, ignore_errors=True)
    elif not ok:
        print(f"judge: scratch kept for inspection: {base}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
