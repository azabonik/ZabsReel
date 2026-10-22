#!/usr/bin/env python3
"""Proves that another user cannot change what the judge and the steps after it rely on. judge.yml runs it as the
runner's user for the build user (zjudge): before the build, and again after it, just before the judge.

    python3 -I -B judge/lockout.py --user <name> [--kill] [--no-tighten] [--fail-if-writable DIR]... [PATH...]

For each PATH (a folder or a file): every folder and regular file under it (links are not followed), and every
folder above it. For a PATH that is not there (a folder on PATH that does not exist yet): the nearest folder above it
that is there, and the folders above that one, since <name> could make the missing folder there. In this order:

1. --kill: removes <name>'s crontab (as root, crontab -r -u <name>; a note when there is no crontab program, or
   when crontab refuses <name> even for root, as it does for a user in /etc/cron.deny, which judge.yml adds before
   any code of <name> runs), then ends every process of <name> (as root, sudo -n pkill -KILL by real and by
   effective user id; run.AsUser) and fails when one is still there after 10 s. With --kill and no PATH, only this
   and step 2 run (judge.yml's failure path, before it copies the logs).
2. Fails when <name> is root or this user, shares a group with this user, or may run sudo (sudo -n -l -U <name>).
3. Takes away the write bit for others (chmod o-w) where it is set, through sudo -n for a file this user does not own;
   not on a sticky folder above a PATH (such as /tmp, where others may add files but not rename ours). --no-tighten
   skips this step (the self-test's case: a world-writable file must then fail step 4). Under a --fail-if-writable
   DIR (and on DIR itself) a write bit for others fails the run even when it is taken away: judge.yml gives the
   runner's file-command folder, where the runner makes new files for each later step with its own umask, so a file
   there that others can write shows a umask that would let others write the later steps' files too.
4. As <name> (sudo -n -u <name>), tries to change each one: open a file for appending (nothing is written), add a
   file to a folder (removed again), and set each one's mode to the mode it has (no change; only its owner or root
   may). Every attempt must be refused; one that is not fails the run, named. A sticky folder above a PATH is not
   tried for adding a file; the nearest folder above a PATH that is not there is, sticky or not.

Exit 0 when every step passed, else 1. Python 3 standard library only.
"""
import argparse
import json
import os
import shutil
import stat
import subprocess
import sys

sys.dont_write_bytecode = True  # nothing may appear under judge/ (JUDGE.lock covers every file there)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run  # noqa: E402  (run.AsUser: the user sweep and the sudo words)

# Run as the other user: reads [[kind, path], ...] on stdin ("d" a folder, "f" a file, "a" a folder above a PATH, "m"
# the nearest folder above a PATH that is not there),
# prints {"tried": n, "written": [[path, [what]]]}.
PROBE = r'''
import json, os, sys
items = json.load(sys.stdin)
written = []
for kind, p in items:
    how = []
    if kind in ("d", "a", "m"):
        q = os.path.join(p, ".lockout-probe-%d" % os.getpid())
        try:
            fd = os.open(q, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except OSError:
            pass
        else:
            os.close(fd)
            os.unlink(q)
            how.append("added a file")
    else:
        try:
            fd = os.open(p, os.O_WRONLY | os.O_APPEND | os.O_NONBLOCK | os.O_NOFOLLOW)
        except OSError:
            pass
        else:
            os.close(fd)
            how.append("opened it for writing")
    try:
        os.chmod(p, os.lstat(p).st_mode & 0o7777)
    except OSError:
        pass
    else:
        how.append("changed its mode")
    if how:
        written.append([p, how])
print(json.dumps({"tried": len(items), "written": written}))
'''


def nearest(path):
    """The nearest folder above `path` that is there (`path` is not)."""
    p = os.path.dirname(path)
    while not os.path.isdir(p) and os.path.dirname(p) != p:
        p = os.path.dirname(p)
    return p


def gather(paths):
    """[(kind, path)]: "d" each folder and "f" each regular file under each path (the path itself included, links not
    followed), "m" the nearest folder that is there above a path that is not, then "a" each folder above those; each
    once, in that order."""
    items, seen = [], set()

    def add(kind, p):
        if p not in seen:
            seen.add(p)
            items.append((kind, p))
    tops = []
    for top in paths:
        top = os.path.realpath(top)
        try:
            st = os.lstat(top)
        except FileNotFoundError:
            # A PATH folder that is not there (main prints it): the user could make it in the nearest folder above.
            top = nearest(top)
            add("m", top)
            tops.append(top)
            continue
        tops.append(top)
        if stat.S_ISREG(st.st_mode):
            add("f", top)
            continue
        for d, dirs, files in os.walk(top, followlinks=False):
            add("d", d)
            for n in files:
                p = os.path.join(d, n)
                try:
                    if stat.S_ISREG(os.lstat(p).st_mode):
                        add("f", p)
                except OSError:
                    pass
    for top in tops:
        p = os.path.dirname(top)
        while True:
            add("a", p)
            if os.path.dirname(p) == p:
                break
            p = os.path.dirname(p)
    return items


def under(p, folders):
    """Whether `p` is one of `folders` (real paths) or inside one."""
    return any(p == d or p.startswith(d.rstrip(os.sep) + os.sep) for d in folders)


def tighten(au, items, strict=()):
    """chmod o-w on each item that others can write (not a sticky folder above a path, nor a sticky nearest folder
    above a path that is not there: step 4 then fails on it). Returns [(path, how)] done and [problem]: what was not
    done, and each item under a folder in `strict` (real paths) that others could write (done or not)."""
    done, problems = [], []
    for kind, p in items:
        try:
            st = os.lstat(p)
        except OSError as e:
            problems.append(f"{p}: {e}")
            continue
        if not st.st_mode & stat.S_IWOTH or (kind in ("a", "m") and st.st_mode & stat.S_ISVTX):
            continue
        if kind != "a" and under(p, strict):
            problems.append(f"others could write {p} (mode {stat.S_IMODE(st.st_mode):o}) under a --fail-if-writable "
                            f"folder: the files made there for later steps would be writable by others too")
        mode = stat.S_IMODE(st.st_mode) & ~stat.S_IWOTH
        if st.st_uid == os.geteuid():
            try:
                os.chmod(p, mode)
                done.append((p, f"{stat.S_IMODE(st.st_mode):o} -> {mode:o}"))
            except OSError as e:
                problems.append(f"chmod o-w {p}: {e}")
            continue
        r = subprocess.run(au.root([shutil.which("chmod", path=run.SYSTEM_PATH) or "chmod", "o-w", "--", p]),
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60, cwd="/")
        if r.returncode == 0:
            done.append((p, f"{stat.S_IMODE(st.st_mode):o} -> {mode:o} (as root)"))
        else:
            problems.append(f"sudo chmod o-w {p}: {(r.stderr or r.stdout).strip()[:200]}")
    return done, problems


def probe(au, items):
    """Each item tried as the user (PROBE). Returns (tried, [(path, [what])])."""
    words = au.as_user([au.tools["env"], "-i", "PATH=/usr/bin:/bin", "LANG=C.UTF-8", sys.executable, "-I", "-S", "-B",
                        "-c", PROBE])
    r = subprocess.run(words, input=json.dumps([[k, p] for k, p in items]), capture_output=True, text=True,
                       timeout=1800, cwd="/")
    try:
        out = json.loads(r.stdout)
    except ValueError:
        raise SystemExit(f"lockout: FAIL the probe as {au.name} did not answer (exit {r.returncode}): "
                         f"{(r.stderr or r.stdout).strip()[:400]}")
    return out["tried"], [(p, how) for p, how in out["written"]]


def main():
    ap = argparse.ArgumentParser(description="Prove that a user cannot change what the judge relies on.")
    ap.add_argument("--user", required=True)
    ap.add_argument("--kill", action="store_true", help="first end every process of the user")
    ap.add_argument("--no-tighten", action="store_true", help="do not take away write bits (the self-test's case)")
    ap.add_argument("--fail-if-writable", action="append", default=[], metavar="DIR",
                    help="a write bit for others on DIR or under it fails the run (also when it is taken away)")
    ap.add_argument("paths", nargs="*")
    a = ap.parse_args()
    if not a.paths and not a.kill:
        ap.error("give a PATH, or --kill")
    fails = []
    try:
        au = run.AsUser(a.user)
    except KeyError:
        print(f"lockout: FAIL no such user {a.user}")
        return 1
    if not sys.platform.startswith("linux"):
        print("lockout: FAIL needs Linux")
        return 1
    missing = [t for t, p in au.tools.items() if not p]
    if missing:
        print(f"lockout: FAIL no {', '.join(missing)} in {run.SYSTEM_PATH}")
        return 1
    if au.uid == 0 or au.uid in (os.getuid(), os.geteuid()):  # before anything is ended by user id
        print(f"lockout: FAIL {au.name} is root or the user that runs this")
        return 1
    print(f"lockout: user {au.name} (uid {au.uid}, groups {sorted(au.groups)}); paths {a.paths}", flush=True)

    if a.kill:
        crontab = shutil.which("crontab", path=run.SYSTEM_PATH)
        if not crontab:
            print(f"lockout: no crontab in {run.SYSTEM_PATH}: no crontab of {au.name} to remove", flush=True)
        else:
            r = subprocess.run(au.root([crontab, "-r", "-u", au.name]), stdin=subprocess.DEVNULL, capture_output=True,
                               text=True, timeout=60, cwd="/")
            said = " ".join((r.stdout + " " + r.stderr).split())
            if r.returncode == 0:
                print(f"lockout: removed the crontab of {au.name}", flush=True)
            elif "no crontab for" in said:
                print(f"lockout: {au.name} has no crontab", flush=True)
            elif "cannot use this program" in said:  # cron.deny: crontab refuses even root for that user
                print(f"lockout: {au.name} may not use cron (crontab refuses it, also for root): {said[:200]}",
                      flush=True)
            else:
                fails.append(f"crontab -r -u {au.name} failed (exit {r.returncode}): {said[:300]}")
        found, left = au.sweep()
        print(f"lockout: ended {len(found)} process(es) of {au.name}"
              + (": " + run._short([f"{p} {c[:100]}" for p, c in found], 600) if found else ""), flush=True)
        if left:
            fails.append(f"processes of {au.name} still running after the sweep: {left}")

    mine = set(os.getgroups()) | {os.getgid(), os.getegid()}
    if au.groups & mine:
        fails.append(f"{au.name} shares the group id(s) {sorted(au.groups & mine)} with this user")
    r = subprocess.run(au.root([au.tools["sudo"], "-n", "-l", "-U", au.name]), stdin=subprocess.DEVNULL,
                       capture_output=True, text=True, timeout=60, cwd="/")
    said = " ".join((r.stdout + " " + r.stderr).split())
    if "is not allowed to run sudo" not in said:
        fails.append(f"{au.name} may run sudo, or sudo -l -U could not tell: {said[:300]}")
    else:
        print(f"lockout: sudo -l -U {au.name}: {said[:200]}", flush=True)

    if not a.paths:
        for f in fails:
            print(f"lockout: FAIL {f}", flush=True)
        print("lockout: ok" if not fails else f"lockout: FAILED ({len(fails)})", flush=True)
        return 1 if fails else 0

    absent = [p for p in a.paths if not os.path.lexists(os.path.realpath(p))]
    if absent:
        print(f"lockout: not there (the nearest folder above each is tried instead): {absent}", flush=True)
    items = gather(a.paths)
    strict = [os.path.realpath(d) for d in a.fail_if_writable]
    if a.no_tighten:
        print("lockout: --no-tighten: no write bit is taken away", flush=True)
        fails += [f"others could write {p} under a --fail-if-writable folder" for k, p in items
                  if k != "a" and under(p, strict) and os.lstat(p).st_mode & stat.S_IWOTH]
    else:
        done, problems = tighten(au, items, strict)
        fails += problems
        print(f"lockout: chmod o-w on {len(done)} of {len(items)} path(s)"
              + (": " + run._short([f"{p} {how}" for p, how in done], 800) if done else ""), flush=True)

    # A sticky folder above a path (such as /tmp) lets others add files but not rename or remove ours: not tried. The
    # nearest folder above a path that is not there ("m") is tried even when sticky: the user could make the path.
    tried, written = probe(au, [(k, p) for k, p in items if not (k == "a" and os.stat(p).st_mode & stat.S_ISVTX)])
    for p, how in written:
        fails.append(f"{au.name} could change {p}: {', '.join(how)}")
    print(f"lockout: {au.name} tried to change {tried} path(s) (files, folders, and the folders above them): "
          f"{len(written)} not refused", flush=True)
    running = au.procs()  # the probe's own process has ended
    if running:
        fails.append(f"processes of {au.name} are running: {running}")
    for f in fails:
        print(f"lockout: FAIL {f}", flush=True)
    print("lockout: ok" if not fails else f"lockout: FAILED ({len(fails)})", flush=True)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
