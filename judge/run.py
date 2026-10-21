#!/usr/bin/env python3
"""Runs the judge's tests against one editor build through an adapter (judge/PROTOCOL.md).

    python3 -I judge/run.py [--adapter "<command>"] [--build <dir>] [--only <text>] [--timeout <s>] [--jobs <n>]
                            [--scratch <dir>] [--keep] [--list]

--adapter   the adapter command (default: this judge's v0.2.0 adapter, run with this Python)
--build     the editor checkout or build the adapter starts (default: the folder that holds judge/)
--only      run only the tests whose file name contains this text
--timeout   seconds per test, for every test (default: each test's TIMEOUT, else 600)
--jobs      tests that use no network port run this many at a time (default 2); port-bound tests run one at a time
--scratch   the folder for this run's scratch folder (default: $JUDGE_SCRATCH, else the system temp folder)
--keep      keep the scratch folder after a run that passed (a failed run always keeps it)

Each test file judge/tests/test_*.py has a function run(t) and may set PORT_BOUND (default True: it starts the
editor) and TIMEOUT. Each test runs in its own process group under its timeout; when it ends, every process whose
environment names the test's scratch folder is ended by exact process id. The runner prints one line per check and
then "JUDGE: <passed>/<checks> passed", and exits 1 when any check failed, a test did not finish, or there were no
checks. Python 3 standard library only; FFmpeg and ffprobe from PATH (JUDGE_FFMPEG / JUDGE_FFPROBE override).
"""
import argparse
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

    def __init__(self, name, scratch, media, build, adapter, results):
        self.name, self.scratch, self.media_dir, self.build, self.adapter = name, scratch, media, build, adapter
        self._results = open(results, "a", encoding="utf-8")
        self._driver = None
        self.n_checks = 0

    def _emit(self, rec):
        self._results.write(json.dumps(rec) + "\n")
        self._results.flush()

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

    def check(self, name, ok, detail=""):
        """Records one check. Returns ok."""
        self.n_checks += 1
        self._emit({"check": name, "ok": bool(ok), "detail": str(detail)})
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

    def driver(self):
        """The editor, started through the adapter in this test's scratch folder (started once per test)."""
        if self._driver is None:
            import driver
            self._driver = driver.Driver(self.adapter, self.scratch)
            self._emit({"started": True})
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
            self.check("the editor stops when asked", False, str(e))
        finally:
            d.close()
        for port in d.ports:
            deadline = time.time() + 10
            while time.time() < deadline and _listening(port):
                time.sleep(0.2)
            self.check(f"port {port} is closed after stop", not _listening(port))


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


def child(a):
    spec = importlib.util.spec_from_file_location(os.path.basename(a.child)[:-3], a.child)
    mod = importlib.util.module_from_spec(spec)
    t = T(os.path.basename(a.child)[:-3], a.scratch, a.media, a.build, json.loads(a.adapter_json), a.results)
    try:
        spec.loader.exec_module(mod)
        mod.run(t)
    except Exception as e:  # noqa: BLE001
        t.check("the test ran to its end", False, f"{type(e).__name__}: {e} | "
                + " / ".join(traceback.format_exc().strip().splitlines()[-4:-1]))
    finally:
        t.finish()
        if t.n_checks == 0:
            t.check("the test recorded checks", False, "no check was recorded")
    return 0


# ---------------------------------------------------------------- the runner's side
def load_meta(path):
    spec = importlib.util.spec_from_file_location(os.path.basename(path)[:-3], path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not callable(getattr(mod, "run", None)):
        raise SystemExit(f"{path} has no run(t)")
    return {"path": path, "name": os.path.basename(path)[:-3], "port_bound": bool(getattr(mod, "PORT_BOUND", True)),
            "timeout": int(getattr(mod, "TIMEOUT", DEFAULT_TIMEOUT))}


def run_test(meta, a, base, media, adapter):
    name = meta["name"]
    scratch = os.path.join(base, name)
    os.makedirs(scratch)
    results = os.path.join(scratch, "results.jsonl")
    timeout = a.timeout or meta["timeout"]
    t0 = time.time()
    with open(os.path.join(scratch, "test.log"), "wb") as logf:
        p = subprocess.Popen([sys.executable, "-I", "-B", os.path.abspath(__file__), "--child", meta["path"],
                              "--scratch", scratch, "--results", results, "--media", media, "--build", a.build,
                              "--adapter-json", json.dumps(adapter)],
                             stdin=subprocess.DEVNULL, stdout=logf, stderr=subprocess.STDOUT, start_new_session=True,
                             cwd=scratch)
        timed_out = False
        try:
            p.wait(timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(p.pid, sig)
                except ProcessLookupError:
                    break
                try:
                    p.wait(10)
                    break
                except subprocess.TimeoutExpired:
                    continue
    left = sweep(scratch)
    recs = []
    if os.path.isfile(results):
        for line in open(results, encoding="utf-8"):
            try:
                recs.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    started = any(r.get("started") for r in recs)
    checks = [r for r in recs if "check" in r]
    if timed_out:
        checks.append({"check": f"finished within {timeout} s", "ok": False, "detail": "ended by the runner"})
    elif p.returncode != 0:
        checks.append({"check": "the test process exited cleanly", "ok": False, "detail": f"exit {p.returncode}"})
    if started or left:
        checks.append({"check": "nothing left running after the test", "ok": not left,
                       "detail": "; ".join(f"{pid} {cmd[:120]}" for pid, cmd in left)})
    if not checks:
        checks.append({"check": "the test recorded checks", "ok": False, "detail": "no results"})
    with PRINT_LOCK:
        for c in checks:
            detail = _short(c.get("detail") or "", 400)
            print(f"{'PASS' if c['ok'] else 'FAIL'}  {name}: {c['check']}" + (f"  -- {detail}" if detail else ""),
                  flush=True)
        print(f"      {name}: {time.time() - t0:.1f} s, scratch {scratch}", flush=True)
    return checks


def main():
    ap = argparse.ArgumentParser(description="Run the judge's tests against an editor build.")
    ap.add_argument("--adapter", help="adapter command (shell words)")
    ap.add_argument("--build", default=os.path.dirname(JUDGE))
    ap.add_argument("--only")
    ap.add_argument("--timeout", type=int)
    ap.add_argument("--jobs", type=int, default=2)
    ap.add_argument("--scratch", default=os.environ.get("JUDGE_SCRATCH") or None)
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--list", action="store_true")
    # child mode (one test, started by the runner)
    ap.add_argument("--child", help=argparse.SUPPRESS)
    ap.add_argument("--results", help=argparse.SUPPRESS)
    ap.add_argument("--media", help=argparse.SUPPRESS)
    ap.add_argument("--adapter-json", help=argparse.SUPPRESS)
    a = ap.parse_args()
    if a.child:
        return child(a)

    a.build = os.path.abspath(a.build)
    adapter = shlex.split(a.adapter) if a.adapter else [sys.executable, "-I", "-B",
                                                        os.path.join(JUDGE, "adapters", "v020", "adapter.py")]
    tests = sorted(os.path.join(JUDGE, "tests", f) for f in os.listdir(os.path.join(JUDGE, "tests"))
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

    import observe
    parent = a.scratch or tempfile.gettempdir()
    os.makedirs(parent, exist_ok=True)
    base = tempfile.mkdtemp(prefix="judge-", dir=parent)
    print(f"judge: adapter {' '.join(adapter)}")
    print(f"judge: build {a.build}")
    print(f"judge: measurements with {observe.ffmpeg_version()} ({observe.FFMPEG})")
    print(f"judge: scratch {base}", flush=True)

    media = os.path.join(base, "media")
    mk = subprocess.run(["bash", os.path.join(JUDGE, "fixtures", "make.sh"), media], capture_output=True, text=True,
                        timeout=600, stdin=subprocess.DEVNULL)
    if mk.returncode != 0:
        print(f"FAIL  fixtures: judge/fixtures/make.sh exit {mk.returncode}  -- {_short(mk.stderr, 600)}")
        print("JUDGE: 0/1 passed")
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
    print(f"JUDGE: {passed}/{len(results)} passed", flush=True)
    if ok and not a.keep:
        shutil.rmtree(base, ignore_errors=True)
    elif not ok:
        print(f"judge: scratch kept for inspection: {base}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
