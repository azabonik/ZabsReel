# The judge

The judge is a set of black-box tests for the ZedMix editor. It decides whether a rewrite of the editor behaves the
way the tested version does. The tests use product-level operations ("import this file", "trim this clip", "export")
and measure what comes out: the exported files, the project state the editor reports, and what its file surface
serves. They never import editor code, and they do not depend on its tool names, routes or internal identifiers. One
**adapter** per editor version maps the operations to that version's own interfaces (see [PROTOCOL.md](PROTOCOL.md)).

## Rules

- **The agents that rewrite the editor must not edit anything under `judge/`.** The judge is how their work is
  measured.
- `judge/JUDGE.lock` holds the sha256 of every file under `judge/`, of the gate `scripts/check-judge-lock.mjs` and of
  the judge's workflow `.github/workflows/judge.yml`. The lock gate (`node scripts/check-judge-lock.mjs`) fails when
  one of them differs from the lock, or when one is added or removed without a lock update. So every change to the
  judge, to its gate or to how CI runs it also changes `JUDGE.lock` in the same pull request, where review sees it.
- **Lock changes are reviewed by the gauntlet on their pull request.** A pull request that changes the judge (and
  so `JUDGE.lock`) merges under the same rule as any other: once the gauntlet's review of it passes (that review
  includes a lock and leakage check) and CI is green. Anthony does not review each lock change. What makes the change
  visible to that review is that it shows in the pull request's diff and CI fails without the lock update; nothing in
  GitHub requires the review (see "Threat model"). There is no CODEOWNERS file.
- The judge asserts only on **observable behaviour**: exported media, files on disk, the state and errors the editor
  reports, and HTTP answers. It does not assert on filter-graph text, command lines, internal identifiers or the
  wording of the older code's error messages. An exact string is checked only where a spec defines it.

## Run it

Requirements: Python 3 (standard library only), FFmpeg and ffprobe on `PATH`, `strace` (CI installs it; see "Statuses"
for a run without it), and for the v0.2.0 adapter, Node and a built checkout (`npm run build`; the adapter's
approve_host and revoke_host start the web shell, which needs the renderer that the build makes).

```sh
python3 -I judge/run.py                      # the v0.2.0 adapter against this checkout
python3 -I judge/run.py --build /path/to/other/checkout
python3 -I judge/run.py --adapter "node /path/to/new-adapter.mjs" --build /path/to/new/editor
python3 -I judge/run.py --only import_export --keep
python3 -I judge/run.py --list
python3 -I judge/run.py --strict --require-trace   # not applicable and not observed fail, as in CI
python3 -I judge/run.py --as-user zjudge --scratch /srv/judge/scratch --strict --require-trace --build /home/zjudge/build
                                             # as CI runs it: the adapter and the editor as the user zjudge (below)
python3 -I judge/run.py --allow-unprotected  # not Linux: run without the /proc protection (JUDGE line says UNPROTECTED)
```

Without `--as-user` (a local run) the adapter, the editor and everything they start run as your own user, and the
runner prints a note that says so: the judge's same-user defences apply (see "Threat model"), and so do their gaps.
`--as-user <name>` runs them as another user, through `sudo -n` (your user needs sudo without a password, and the
other user must run nothing else: the runner ends every process of it after each test). The runner refuses to start
when that user is root or your own, shares a group with yours, already runs a process, or could change a folder above
the run's folder (give `--scratch` a folder that it can enter but not write), or when `fs.protected_symlinks`,
`fs.protected_hardlinks` or `fs.protected_regular` is 0. The other user must be able to read and run the build, and
`python3`, `node` and FFmpeg on your `PATH`. A custom `--adapter` must be readable and runnable by it too; the default
adapter is copied into the run's folder for it. strace then runs as root and traces a process of the other user,
which needs root's `CAP_SYS_PTRACE` (a virtual machine's root has it; in a Docker container, give `--cap-add
SYS_PTRACE`): without it the strace probe fails and the trace checks are not observed. That strace is
`JUDGE_STRACE`, or else the one in `/usr/sbin:/usr/bin:/sbin:/bin` (never your `PATH`), and it is not used when your
user can change it or a folder above it.

The runner prints one line per check (`PASS`, `FAIL`, `N/A` or `N/O`, see "Statuses"), then
`JUDGE: <passed>/<judged> passed`, followed by `, <n> not applicable` and `, <n> not observed` when there are any. It
exits 1 when any check fails, when a test does not finish within its timeout, when there are no checks, or when the
runner or a test process cannot be made non-dumpable (see "Threat model") and `--allow-unprotected` is not given.
Each run makes its media with `judge/fixtures/make.sh` (FFmpeg's lavfi sources, nothing downloaded) in a new scratch
folder. A run that passes deletes that folder unless you give `--keep`. A run that fails keeps it, and the runner
prints its path. Each test's folder holds `test.log`, `adapter.stderr` and the editor's own logs; next to it, with
strace, `<test>.adapter-strace.log` is the test process's copy of the trace lines it read (no check reads it). With
`--as-user` the runner keeps its own records in `records/` in the run's folder (mode 0700, the runner's):
`records/<test>.log` (the test process's output) and `records/<test>.adapter-strace.log`. Each test's folder then
belongs to the runner with mode 1777 (sticky), as does every folder `t.path` makes in it: the editor's user can add
files and folders there (exports, its sandbox, saved projects), but cannot rename or remove the test's own files, and
the kernel does not let the test follow that user's links there or open that user's files with `O_CREAT`. The
test's files are not writable by that user, except the hostile inputs that `observe.craft` writes (mode 0666): the
editor treats a project it opened as the user's own and may save into it, as it can without `--as-user`. A folder
there that the test did not make (the editor's) is never written by the test (`t.path` fails). Removing a kept run's
folder then needs `sudo`.

### Statuses

A check passes or fails, or it is not made, for one of two reasons, each printed with its name and counted on the
`JUDGE` line (`JUDGE: 150/150 passed, 6 not applicable`), neither passed nor failed:

- **Not applicable** (`N/A`): the hostile input the check is about could not be made. The judge makes a hostile
  project or OTIO file by text substitution in a file the editor itself saved (`observe.craft`). That needs the file
  to hold the values as the test gave them: media and LUT paths and identifiers verbatim, colours as given, a number
  exactly once. A correct rewrite with another file format must not fail a security check for that reason, and must
  not skip it silently either, so every check on that input is recorded as not applicable, with the replacement
  counts. `--strict` makes each one a failure. `judge.yml` passes `--strict` while the judge grades v0.2.0, whose
  format every crafted input comes from. A rewrite's run without `--strict` lists its not-applicable checks: each one
  is a security check the judge could not apply to that build, not a pass.
- **Not observed** (`N/O`): the observation needs `strace`, which is not installed, not usable (it failed the
  runner's test of it, or under `--require-trace` it can be written by the runner's user or is named through a
  symbolic link in a folder that user can write), or `JUDGE_STRACE` is set empty:
  the download check of every test that starts the editor, and `test_network_hosts`' file-system trace checks.
  `--require-trace` makes each one a failure; `judge.yml` passes it.

### CI

CI runs the judge in its own workflow, `.github/workflows/judge.yml`, with the FFmpeg on the runner's `PATH`. No code
from the change under test runs as the runner's user, which has passwordless `sudo`, except the lock-covered judge
files (`judge/`, the gate and `judge.yml`): they come from the pull request's checkout, and the gauntlet reviews them
on that pull request (see "Threat model"). Before anything from the change runs, the workflow copies `judge/`, the
gate and `judge.yml` to `$RUNNER_TEMP/judge-src` (read-only), closes the checkout's `.git` (which holds the job's
token) to other users (`chmod -R go-rwx`), checks the copy with the copied gate, installs FFmpeg and `strace` from
apt, and makes the build user `zjudge`: no `sudo`, only its own group, its own home, and no cron or at jobs (it is
added to `/etc/cron.deny` and `/etc/at.deny`; the step fails when `/etc/cron.allow` or `/etc/at.allow` is there,
since either makes the deny file ignored). It makes `/srv/judge` (the runner's, mode 0755) for the judge's scratch
folders, and runs `lockout.py` (below) for `zjudge`. Then it runs `run.py --self-test --require-trace --as-user
zjudge` from the copy. It copies the checkout without `.git` and `judge/` to `/home/zjudge/build`, and runs `npm ci`,
the Electron install and the build there as `zjudge` (`sudo -n -u zjudge -H env -i`, with the toolchain's `node` first
on `PATH`, `zjudge`'s home and npm cache, umask 022; no npm cache is restored or saved). The output of those steps
goes to a file of the runner's (mode 0600), which the step prints after the command ends between
`::stop-commands::<token>` and `::<token>::`, with a token made in the step's shell after `zjudge`'s command ended:
nothing `zjudge` prints is read as a workflow command (`::add-mask::`, `::add-matcher::`, `::set-output::`, ...).
The judge step turns workflow commands off the same way while it runs, since its check details quote what the editor
said. After the build it runs `lockout.py --kill` (`zjudge`'s crontab is removed and every process the build left is
ended), checks that the copy's lock and gate are the bytes it pinned before the install and that the copy still
matches its lock, then runs the judge from the copy with `--build /home/zjudge/build --scratch /srv/judge/scratch
--strict --require-trace --as-user zjudge`. A failed run first ends every `zjudge` process (`lockout.py --kill`
with no path: by real and by effective user id, and the step fails when one is left), then root copies only the
regular files named `*.log` or `*.stderr` from the kept scratch folders (`find -type f`, which follows no link and
leaves out links, FIFOs and devices) into a new folder of the runner's, and only that folder is uploaded as the
`judge-logs` artifact (among the files, `records/<test>.adapter-strace.log`). The editor's sandbox is a folder of
`zjudge`'s, where the kernel's link protection does not apply, so a link it planted there (to the job's token in
`.git/config`, to `/proc/self/environ`, or to a folder of the runner's) never reaches the artifact. `ci.yml` runs the
lock gate on the checkout as well, so deleting `judge.yml` or the gate fails `ci.yml`.

`lockout.py --user zjudge [--kill] [--fail-if-writable DIR] PATH...` proves that `zjudge` cannot change what the
judge and the steps after it rely on. `judge.yml` gives it the judge's copy, its own step's file-command files
(`$GITHUB_ENV`, `$GITHUB_PATH`, `$GITHUB_OUTPUT`, `$GITHUB_STEP_SUMMARY` and their folder under
`$RUNNER_TEMP/_runner_file_commands`), the setup-node toolchain, every folder on `PATH`, the runner's home, the
workspace and `/srv/judge`. For every folder and regular file under each of them, and every folder above them, it
takes away the write bit for others where it is set (`chmod o-w`; not on a sticky folder above them, such as `/tmp`),
then, as `zjudge`, tries to open each file for writing, to add a file to each folder and to change each one's mode
(nothing is written, and an added file is removed again). For a folder on `PATH` that is not there, it tries the
nearest folder above it that is there (sticky or not), since `zjudge` could make the missing folder there and put a
`python3` or a `node` in it. The runner makes new file-command files for each later step in the same folder, with its
own umask; `judge.yml` passes that folder as `--fail-if-writable`, so a write bit for others there fails the step
instead of being taken away quietly (it shows a umask that would leave the later steps' files open too). The step
fails when one attempt is not refused, when `zjudge` shares a group with the runner's user or may run `sudo` (`sudo
-l -U`), or when a `zjudge` process is still running (`--kill` removes `zjudge`'s crontab and ends its processes
first; with `--kill` and no path it does only that and the user checks).

On a pull request, `judge.yml` also fetches the base branch, writes the base branch's copy of the gate to
`$RUNNER_TEMP/base-gate` and runs it with `--root "$GITHUB_WORKSPACE"` on the pull request's files, before the
install. When the base branch has no gate (the pull request that adds it), the step prints a notice and skips the
check. The same step lists every lock-covered path that differs from the base branch (`judge/**`, the gate,
`judge.yml`) in the job summary and in one warning. This step catches a weakened gate only when the pull request
leaves `judge.yml` unchanged: on `pull_request` events GitHub runs the pull request's own `judge.yml`, so a pull
request that also edits `judge.yml` can remove the step, and with it the warning and the summary list. Such a pull
request shows `judge.yml` and `JUDGE.lock` changes in its diff, and only review sees them (see "Threat model").

`python3 -I judge/run.py --self-test` runs the runner's own tests (`selftest.py`, on fixture tests in a temp folder):
a crash, a hang past the timeout, `sys.exit(0)` in the middle, no checks, fewer or more checks than declared, no
`CHECKS`, a process left by the test or by the adapter, an adapter that speaks another protocol version, an adapter
that writes passing results into its scratch folder, lines on the result pipe that are not the test's records, a fork
without exec that leaves the session and closes its descriptors, and SIGTERM to the runner must each fail the run, and
a clean test must pass. A not-applicable check (also one made through `needs=` on an input that could not be
crafted) and a not-observed one must pass the run and be counted, and fail it with `--strict` and `--require-trace`.
A fixture adapter that starts a DNS lookup (a UDP connect to 192.0.2.1 port 53), makes a UDP connect to 192.0.2.1
port 9 and sends with `write()`, sends with `sendto()` to 192.0.2.1 port 9, or starts a TCP connect to 192.0.2.1
port 80 must fail the download check. The adapter must not reach the trace: one that starts a DNS lookup and at stop
rewrites, empties or deletes every file it can reach (its scratch folder and the logs next to it, among them the copy
of the trace), or that writes a partial strace line to every descriptor it holds, to strace's descriptors through
`/proc` and to those files and then overwrites the lookup's port in them, must still fail the check on the lookup
itself, and its open of strace's trace channel through `/proc` must be refused (`ENXIO`). One that ends strace must
fail the check (the trace ended before stop). One that at stop leaves a child running that waits until strace no
longer traces it and then starts a DNS lookup must fail the run: when the child carries the scratch folder in its
environment, the test process's sweep ends it and fails "nothing the adapter started is left running after stop";
when its environment is cleared (the sweep cannot find it), the download check fails (the trace did not end). Real strace lines must pass the line check, and text joined to an
strace line or a line cut short must fail it. One that asks for an io_uring must be refused it, and one that makes a UDP connect to
127.0.0.1 and Chromium's IPv6 probe must pass the check. With strace switched off (`JUDGE_STRACE=`) the check must
be not observed, a failure with `--require-trace`; a fake `JUDGE_STRACE` (a script that runs its command without
tracing it) must not be used, and with `--require-trace` it must fail the run, as must a `JUDGE_STRACE` that is a
symbolic link in a folder the runner's user can write (without `--require-trace` its real path runs). The cases that
need strace are
skipped without it, unless `--self-test --require-trace` is given (`judge.yml` does): then a missing strace fails
the self-test. On Linux an adapter that tries to open the test's and the runner's descriptors through
`/proc/<pid>/fd` for writing must be refused every time, with the verdict unchanged, and a fork child that writes
through the result pipe's descriptor number must get EBADF. A runner or a test process that cannot be made
non-dumpable (forced with `JUDGE_FORCE_UNPROTECTED=runner` or `child`) must fail the run, and with
`--allow-unprotected` the run must pass with `UNPROTECTED` on its `JUDGE:` line. `--as-user` with the runner's own
user, with root or with a user that does not exist must be refused before anything runs. With `--self-test --as-user
<name>` (`judge.yml` gives `zjudge`; without it these cases are skipped, and when `sudo -n` does not work they fail),
the fixture adapter runs as that user: it must pass clean, and its DNS lookup must fail the download check; its
attempts to change the judge's files (append, add a file, change a mode) and the runner's records, to list and open
the descriptors of strace, sudo and the test process through `/proc` and to send them signal 0 must all be refused;
and the child it leaves at stop with an empty environment must fail the run and be ended by the user sweep. A user
that already runs a process must be refused. `lockout.py --no-tighten` must find a world-writable folder and file
and fail, `lockout.py` must take their write bit away and pass, and `--kill` must end the user's processes. A file
that others can write under a `--fail-if-writable` folder must fail `lockout.py`, a `PATH` folder that is not there,
below a sticky folder that everyone can write, must fail it, and `--kill` with no path must remove the user's crontab
(or report that `crontab` refuses the user, as it does for one in `cron.deny`) and end its processes. It also
runs the v0.2.0 adapter's and `check_observe.py`'s self-tests. On a system other than Linux, run `--self-test --allow-unprotected`: every runner it
starts gets the flag, and the two refusal cases are skipped.

## What is here

| Path | What it is |
|---|---|
| `PROTOCOL.md` | The adapter protocol: JSON lines on stdin and stdout, the operations, the rules for adapters. |
| `driver.py` | The judge's side of the protocol. Tests call its methods (`import_media`, `place_clip`, `export`, ...). |
| `adapters/v020/adapter.py` | The adapter for v0.2.0's interfaces: its MCP tools over stdio, and the core's HTTP routes. |
| `observe.py` | The measurements: ffprobe facts, full decode, SSIM (whole frame or region), signalstats, volume, tone bands, loudness, silences, SRT and OTIO parsing. They are the first-try baseline checker's measurements, with the same FFmpeg filter chains. Also the judge's own observations of side effects: a loopback listener that must receive nothing, the search of the file-system trace, the search of the network calls for a download (`net_hits`), files that must not appear, secrets that must not appear in an answer, and the text substitution that makes a hostile input from a file the editor wrote (`craft`, which also says when it cannot). |
| `check_observe.py` | Compares `observe.py` with the values that the baseline checker recorded for its oracle exports (a local tool: the oracles are not in the repository). |
| `fixtures/make.sh` | Makes the test media. |
| `run.py` | The runner. |
| `lockout.py` | CI's proof that the build user cannot change what the judge relies on (see "CI"). |
| `selftest.py` | The runner's own tests (`run.py --self-test`). |
| `tests/test_*.py` | The tests. |
| `PORTING.md` | Where each section of the older test scripts went: a judge check, a test that stays with v0.2.0, or a recorded drop. |
| `JUDGE.lock` | The lock (above). |

## Write a test

A test is a file `tests/test_<name>.py` with a function `run(t)`:

```python
import observe

PORT_BOUND = True   # it starts the editor (default); tests without a port can run in parallel
TIMEOUT = 600       # seconds; the runner ends the test after that
CHECKS = 2          # the number of checks run(t) records; the runner fails the test on any other number

def run(t):
    d = t.driver()                                  # the editor, started in this test's scratch folder
    d.set_project(width=1280, height=720, fps=30)   # set the canvas before placing anything (PROTOCOL.md)
    clip = d.place_clip(d.import_media(t.media("a.mp4")), "v0", 0, 0, 90)
    out = t.path("out", "x.mp4")
    d.export(out)
    t.measure("the export lasts 3 s", lambda: observe.duration(out), lambda v: abs(v - 3) <= 0.1, "3 +- 0.1 s")
    t.check("the clip is on v0", any(c["id"] == clip for c in d.clips("v0")))
```

- `t.check(name, ok, detail)` records one check. `t.measure(name, fn, accept, want)` records a check on a measured
  value. If the file makes the measurement impossible, the check fails with the reason. `t.not_applicable(name, why)`
  and `t.not_observed(name, why)` record a check that is not made (see "Statuses"); they count against `CHECKS`.
- Record the same checks on every path: where an input is missing (no export file, for example), record the checks
  that need it as failed with the reason instead of returning early. The runner fails a test whose number of checks
  differs from `CHECKS`, so a test cut short cannot pass with the checks it did record.
- `t.media(name)` is a fixture, and `t.path(...)` is a path in the test's scratch folder.
- To check the editor's own files (its allowed list, what appeared in a folder), use `t.look(files=[...],
  folders=[...], walk=[...])`, not `open` or `os.listdir`: with `--as-user` the editor keeps files that the runner's
  user cannot read (mode 0600 in folders of mode 0700), and `t.look` then also looks as the editor's user. It returns
  each file's sha256 (or None), each folder's sorted names (or None), and every entry under each walk root with the
  size of each regular file. What the editor's user reports is the editor's own word on its own files, as it is
  without `--as-user`.
- `t.driver()` runs the adapter, and so the editor and everything they start, under `strace -f -yy` with the
  network calls traced (`connect`, `sendto`, `sendmsg`, `sendmmsg`, `io_uring_setup`) when strace is available
  (`JUDGE_STRACE`, else `strace` on `PATH`; see "A download during a run" under "Threat model"). strace refuses every `io_uring_setup` with
  `ENOSYS` (io_uring connect and send operations are not calls strace sees; Node's libuv then uses epoll). strace
  writes the trace to a socket that only the test process reads (see "A download during a run"); the test process
  keeps every line in its own memory while the editor runs, and writes a copy to `<test>.adapter-strace.log` next to
  the test's scratch folder, which a failed CI run uploads with the other logs (no check reads the copy). After
  `stop` the runner adds the check "nothing was downloaded" (`observe.net_hits` on the lines kept): no TCP or UDP
  connect to an address that is not this computer's own, no DNS lookup, no send to another computer, and no
  `io_uring_setup` that made a ring. One UDP connect is allowed: a connect to exactly `[2001:4860:4860::8888]:443`,
  Chromium's IPv6 reachability probe, which sends no packet. Data that a process then sends on that socket with
  `write()` is not a traced call and is not seen (see "What it does not defend against"). Every other UDP connect
  counts, because `write()` on a connected UDP socket sends without a traced call. The check sees an attempt also
  when the network is down. It fails too when a line in the trace is not of the form strace writes, or when the
  trace ended (strace exited) before the editor was asked to stop. `t.driver(trace=True)` traces the file-system
  calls (`%file`) too; `t.trace` is then the lines kept (`t.trace_path` names the copy), and
  `observe.trace_hits(t.trace, names)` searches them (never in a process's argv or a send's data). Without strace, `t.trace` and `t.trace_path` are None and the test records
  its trace checks with `t.not_observed`.
- A hostile input (a crafted project or OTIO file) is made from a file the editor wrote, with `observe.craft`: the
  test needs no knowledge of the file format. Pass the result to every check that is about it,
  `t.check(name, ok, detail, needs=crafted)`: when a value was not found (another file format), the check is recorded
  as not applicable instead of failed. Do not open a file that could not be crafted where the check needs a refusal
  (it is the user's project, not a hostile one).
- A test that needs an operation the protocol does not have adds it to `PROTOCOL.md`, `driver.py` and the
  adapters (see "Adding operations" in `PROTOCOL.md`).
- **Safety:** a test writes only in its scratch folder. It starts the editor only through `t.driver()`, which gives
  the editor a scratch home and data folder and a free port. It never uses the user's own editor or its data. Every
  Chromium or Electron launch passes `--mute-audio`. Nothing is downloaded: the adapter starts the editor so that a
  feature that would fetch a model or a helper program refuses instead (PROTOCOL.md rule 4), and the runner's
  "nothing was downloaded" check fails a test whose editor addresses another computer anyway. The runner runs every
  test under a timeout, and CI runs the whole judge under `timeout -k`.

## Update the lock

After a change to the judge (its pull request's gauntlet reviews the lock change):

```sh
node scripts/check-judge-lock.mjs --write       # rewrite judge/JUDGE.lock from the covered files
node scripts/check-judge-lock.mjs               # check
node scripts/check-judge-lock.mjs --self-test   # the gate's own tests, on copies
```

Python writes no `__pycache__` folders under `judge/` (`run.py` turns bytecode files off, and the runner starts
its child processes with `-B`). A `__pycache__` folder left by another tool makes the gate fail. Delete it.

## Threat model

The judge measures work done by agents that can change the rest of the repository and whose code runs in CI (npm
lifecycle scripts, the build) and in the editor under test. In CI that code runs as the user `zjudge`, never as the
runner's user (see "CI"). In a run without `--as-user` (a local run) it runs as the same user as the judge.

What it defends against:

- **Code from the change running with the judge's rights** (CI): the install, the build, the adapter and the editor
  run as `zjudge`, a user made for the job with no `sudo`, only its own group, no cron or at jobs, umask 022 and an
  environment of its own (`env -i`); the checkout's `.git` is closed to it. (The lock-covered judge files are the
  exception: they come from the pull request and run as the runner's user; see "Edits to the judge" below.)
  `lockout.py` proves before the build and again just before the judge that `zjudge` can change none of the judge's
  copy, its own step's file-command files (`$GITHUB_ENV`, `$GITHUB_PATH`, `$GITHUB_OUTPUT`, `$GITHUB_STEP_SUMMARY`),
  the Node toolchain, the folders on `PATH` (or the nearest folder above one that is not there), the runner's home,
  the workspace and the judge's scratch root, and ends every process the build left. The files the runner makes for
  later steps are protected by the folder and the runner's umask: a file there that others can write fails the step.
  Workflow commands are off while `zjudge`'s output is printed, and a failed run uploads only copies of the regular
  log files, never a link `zjudge` planted. `run.py --as-user zjudge` runs strace as root (`sudo -n env -i
  ... strace -u zjudge ...`), so the traced tree cannot signal strace, attach to it or open its descriptors (it is
  another user's), nor reach the test process or the runner (another user's, non-dumpable). The runner's records
  (`records/`, mode 0700) and the copy of each trace are out of its reach, and so is the run's folder above each
  test's folder. After each test the runner ends every process of `zjudge` (`sudo -n pkill -KILL` by real and by
  effective user id, and checks that none is left), also one that cleared its environment or made itself
  non-dumpable, and fails "nothing left running after the test" on what it found. The tests run one at a time. The
  self-test proves it with a fixture adapter that runs as `zjudge`: its attempts to change the judge's files and the
  records, to open the descriptors of strace, sudo and the test process through `/proc`, and to signal them are all
  refused, and the child it leaves with an empty environment is ended by the user sweep.

- **Edits to the judge, its gate or its workflow** that do not show as a `JUDGE.lock` change: the lock gate fails in
  `ci.yml` and in `judge.yml`. An edit together with a lock update passes the gate; it is visible in the diff, where
  the gauntlet's review of the pull request (with its lock and leakage check) sees it, and nothing more stops it.
- **A weakened gate in the same pull request, when `judge.yml` is unchanged**: a pull request that changes the gate's
  checking logic (for example so that it finds no problems) and updates the lock passes its own copy of the gate, but
  not the base branch's gate, which `judge.yml` runs on pull requests. The lock's content always comes from the pull
  request, because a judge change must update it; what the base gate adds is only that a pull request that leaves
  `judge.yml` unchanged cannot weaken the checking logic (see "What it does not defend against" for one that changes
  `judge.yml` too). A pull request that changes what the gate covers can fail the base gate by design: its Judge check
  is red, so it cannot merge under the merge-when-green rule, and merging it is a deliberate exception that the
  gauntlet's review has to justify. This takes effect from the first pull request whose base branch has the gate.
- **Edits made by the install or the build** to the judge after the gate ran: `judge.yml` runs the judge from a copy
  made before any code from the change runs, and checks the copy against bytes pinned before the install.
- **Forged results** through a path the editor or the adapter is given: a test sends its results to the runner over a
  pipe that only the test process holds (the adapter and the editor start with no inherited descriptors). Nothing the
  runner reads for the verdict is a file. On Linux the runner and the test process make themselves non-dumpable
  (`prctl(PR_SET_DUMPABLE, 0)`) before any adapter starts, so a process of the same user cannot open their
  descriptors through `/proc/<pid>/fd` (opening a pipe's link there for writing gives a new write end), read their
  memory or attach to them with ptrace. When the runner cannot make itself non-dumpable (another system, or the call
  fails) it prints `JUDGE: refused: the runner is not protected (...)` and exits 1; when a test process cannot, that
  test fails with the check "the test process is non-dumpable" and does not run. `--allow-unprotected` (development
  on another system; `judge.yml` never passes it) runs anyway, and the `JUDGE:` line then ends with `UNPROTECTED`.
  The adapter and the editor stay dumpable on purpose: the sweep reads their environment. A fork without exec
  inherits non-dumpable, so a Python fork child of the runner or the test first closes its copy of the result pipe
  and then makes itself dumpable again (`os.register_at_fork`), and the sweep finds it. The first record declares the
  test's number of checks and the last one says the test reached its end; a missing declaration, another number of
  checks, or no end record fails the test. Any line on the pipe that is not one of these records in its place (not
  UTF-8 JSON, JSON of another shape, a declaration after the first line, a record after the end) fails the test with
  a check that names the line.
- **Processes left running**: after each test the runner ends every process whose environment has a value inside the
  test's scratch folder. The test and the adapter carry `JUDGE_TEST_SCRATCH=<scratch>`, the editor carries its sandbox
  folders, and children inherit them. With `--as-user` it also ends every process of that user (the sweep by scratch
  values cannot read another user's environment), whatever its environment.
- **A killed runner**: SIGTERM or SIGINT ends the running test's session and every process found by the same sweeps,
  prints `JUDGE: interrupted by signal N` and exits 1.
- **A download during a run**: every test that starts the editor runs it under strace with the network calls traced,
  and its "nothing was downloaded" check fails on a TCP or UDP connect to another computer (except Chromium's exact
  IPv6 probe), a DNS lookup or a send to another computer, also when the call failed (no network). strace refuses
  io_uring rings, whose operations it cannot see. strace writes the trace to its stderr, which is one end of a UNIX
  socket pair; the test process (non-dumpable) holds the other end and keeps every line it reads in its own memory.
  The first process strace starts is a `/bin/sh` that points its own stderr at `adapter.stderr` and then runs the
  adapter, so no process of the adapter's tree holds either end. A socket cannot be opened again through
  `/proc/<pid>/fd` (`ENXIO`), and taking strace's descriptor with `pidfd_getfd` or attaching to strace needs ptrace
  rights over strace, which Yama's `ptrace_scope` 1 (Ubuntu's default) gives only to strace's ancestors. So a process of the same user can neither add a line to the trace nor take one out of it. A
  file would let it rewrite lines before the reader reads them, and a pipe would let it open strace's end through
  `/proc` for reading and take lines out. Every line must also have the form strace writes (its pid, then a call,
  a resumed call, or a `+++`/`---` line, with every quoted string and `<...>` closed and no second call inside), so
  text joined to an strace line fails the check instead of hiding a call. The check also fails when the trace ends
  before the editor is asked to stop: a process that ends strace (same user, so it can send it a signal) stops the
  trace, and what it does after that would not be seen. The trace must also end after stop: strace exits when the
  last process it traces has ended, and the test process waits for that instead of killing strace (which would end
  the trace while a traced process still runs, and that process's later calls would not be seen). When strace does
  not exit within 30 s of stop, the test process ends every process whose environment names the scratch folder (but
  strace) and fails "nothing the adapter started is left running after stop" naming them; when the trace still has
  not ended 10 s later, a traced process the sweep could not find (one with a cleared environment) outlived stop, and
  the check fails ("the trace did not end"). In CI `--require-trace` makes a run without a working
  strace fail, so the check cannot quietly turn into not observed. Under `--require-trace` the runner uses an strace
  (from `JUDGE_STRACE` or `PATH`) only when its real path and every folder above it are owned by root (or another
  user) and cannot be written by the runner's user, and when no symbolic link met on the way to it sits in a folder
  that user can write, so a `JUDGE_STRACE` or `PATH` entry that a build step writes to `$GITHUB_ENV` or
  `$GITHUB_PATH` cannot name a fake one, and a link cannot be pointed elsewhere after the check. The runner makes
  the path real once and runs that real path. Every strace is also tested before use: it must record a UDP connect to
  192.0.2.1 port 53 made by a child, or it is not used. `test_network_hosts` also fails when a file of 1 MiB or more
  appears in its folder during the agent tool calls. With `--as-user` (CI) strace runs as root and starts the adapter
  as the other user (`strace -u`; it is probed that way too), so no process of the traced tree can end, stop or attach
  to strace, read its memory or open its descriptors, and the copy of the trace is in the runner's `records/`.
- **A file format that defeats the crafted inputs**: a rewrite whose saved files do not hold the values as given
  turns the checks on crafted inputs into not applicable, each listed by name and counted on the `JUDGE` line, never
  into passes; `--strict` fails them.

What it does not defend against:

- **What remains in CI**, where the code under test runs as `zjudge`:
  - Root on the runner, and the runner's own user, which has passwordless `sudo` (the judge itself uses it for strace,
    the user sweep and `lockout.py`). No code from the change runs as either, except the lock-covered judge files
    (below); a change to `judge.yml` that ran it as the runner's user would undo that, and only review sees it (see
    the open decisions below).
  - A kernel bug, or a bug in `sudo` or strace, that gives `zjudge` root or another user's rights.
  - The runner image itself: its root-owned programs (`python3`, `sudo`, strace, FFmpeg, `tar`, ...) and settings
    (`fs.protected_*`, Yama's `ptrace_scope`) are trusted as GitHub ships them. `lockout.py` tries only the paths
    `judge.yml` gives it (the judge's copy, the file-command files, the Node toolchain, the folders on `PATH`, the
    runner's home, the workspace, `/srv/judge`, and the folders above them).
  - FFmpeg and ffprobe parse hostile files with the runner's rights. `observe.py` runs the runner's FFmpeg (from
    `PATH`, as the runner's user, which has passwordless `sudo`) on the exports and frames the editor wrote, so a bug
    in an FFmpeg demuxer or decoder is a path from `zjudge` to the runner's user and to root. Running those
    measurements as another unprivileged user would close it; the judge does not do that yet. The runner's `tar`
    also reads the checkout (file names from the pull request) when it copies it for `zjudge`.
  - The lock-covered judge files (`judge/`, the gate and `judge.yml`) come from the pull request and run as the
    runner's user. Only review stops a pull request that changes them and updates the lock (see "Edits to the judge"
    above and the open decisions below).
  - What `zjudge` can still do: read what others may read on the runner (the checkout's `.git`, with the job's token,
    is closed to it); use the network during the install and the build; and have a service other than cron and at
    that starts processes as it start one later (cron and at refuse it: it is in `cron.deny` and `at.deny`, and
    `lockout.py --kill` removes any crontab). Such a process is not in the traced tree, so its network calls are not
    seen, and it runs until the user sweep after the test. As in a local run, the editor's own word about its own
    files (`t.look` as `zjudge`) is not checked against anything else.
- **Same-user gaps, in a run without `--as-user`** (a local run). In CI the separate user closes each of them:
  - Root, or a process with `CAP_SYS_PTRACE`: it can still open the pipe through `/proc` or attach with ptrace. The
    same holds for a run with `--allow-unprotected`, whose `JUDGE:` line says `UNPROTECTED`. (Root remains in CI too,
    above.)
  - The short time between the start of the test process and its `prctl` call, when it already holds the pipe: a
    process of the same user that is already running and watching for it could open the pipe then.
  - A process of the same user that makes itself non-dumpable too, or removes the scratch values from its environment:
    the sweep cannot read its environment, so it is not found by its scratch values.
  - A process of the same user that rewrites the read-only copy in `$RUNNER_TEMP` (it can make it writable again).
    Pinning the copy's lock and gate catches a rewrite of those two files during the install and the build, but not a
    change made after that check.
  - Passwordless `sudo` of the user that runs the judge: code from the change could replace `python3`, `node`, FFmpeg
    or `/usr/bin/strace` system-wide.
  - The trace channel against a stronger process of the same user: with `ptrace_scope` 0, or as root or with
    `CAP_SYS_PTRACE`, a process can attach to strace (or take its descriptor with `pidfd_getfd`) and add or remove
    lines. The line check catches text joined in front of an strace line, but not every cut: a writer that could split
    one of strace's lines in two at the right place could make two lines of the right form. strace itself is
    dumpable, so a process of the same user can read its memory and send it signals: ending strace fails the check
    (the trace ended before stop), but stopping it with `SIGSTOP` holds the editor's traced calls until strace runs
    again. The copy of the trace (`<test>.adapter-strace.log`) is a file the editor can change; no check reads it.
- A fork without exec made by non-Python code in the test process (a C extension calling `fork()`): Python's fork
  hook does not run, so the child keeps the result pipe and stays non-dumpable, and the sweep cannot find it.
- A change that deletes both `judge.yml` and the gate step in `ci.yml` (which the lock does not cover). Only review
  sees that, unless branch protection requires the Judge workflow's check.
- A pull request that weakens the gate and also edits `judge.yml`: on `pull_request` events the workflow comes from
  the pull request, so it can remove or change the base-gate step (and with it the warning and the summary list),
  update `JUDGE.lock`, and pass every gate. Its diff shows the `judge.yml` and `JUDGE.lock` changes; nothing else
  stops it. Enforcing the base gate needs GitHub settings: a required check from a workflow the pull request cannot
  change (for example one triggered by `pull_request_target`), or a required review. That is an open decision for
  Anthony.
- The 1 MiB file check sees only files that stay in the test's folder.
- Data sent on Chromium's IPv6 probe socket: a UDP connect to exactly `[2001:4860:4860::8888]:443` is allowed, and
  `write()` on a connected socket is not a traced call, so a process could send data to that one address and port
  without the check seeing it. Running the editor as another user does not change this; a run with the network
  switched off does (nothing reaches that address).
- A judge change that review lets through: judge changes are reviewed by the gauntlet on their pull request (with a
  lock and leakage check), not by Anthony, and merge when CI is green. A pull request that edits the judge and
  updates the lock passes every gate; the base gate and the warning (when `judge.yml` is unchanged) only make the
  change visible to that review. As decided on 2026-10-21, main's branch protection requires the Judge check but no
  review, so GitHub enforces neither the gauntlet's review nor any other. A required review (or CODEOWNERS) on
  `judge/**`, the gate and `judge.yml` would; that is an open decision for Anthony.
