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
- **A lock update needs Anthony's review.** What enforces this is that the lock change is visible in the pull
  request's diff and CI fails without it. There is no CODEOWNERS file: a reviewer has to look for a `JUDGE.lock`
  change.
- The judge asserts only on **observable behaviour**: exported media, files on disk, the state and errors the editor
  reports, and HTTP answers. It does not assert on filter-graph text, command lines, internal identifiers or the
  wording of the older code's error messages. An exact string is checked only where a spec defines it.

## Run it

Requirements: Python 3 (standard library only), FFmpeg and ffprobe on `PATH`, and for the v0.2.0 adapter, Node and
a built checkout (`npm run build`).

```sh
python3 -I judge/run.py                      # the v0.2.0 adapter against this checkout
python3 -I judge/run.py --build /path/to/other/checkout
python3 -I judge/run.py --adapter "node /path/to/new-adapter.mjs" --build /path/to/new/editor
python3 -I judge/run.py --only import_export --keep
python3 -I judge/run.py --list
python3 -I judge/run.py --allow-unprotected  # not Linux: run without the /proc protection (JUDGE line says UNPROTECTED)
```

The runner prints one line per check (`PASS` or `FAIL`), then `JUDGE: <passed>/<checks> passed`. It exits 1 when
any check fails, when a test does not finish within its timeout, when there are no checks, or when the runner or a
test process cannot be made non-dumpable (see "Threat model") and `--allow-unprotected` is not given. Each run makes
its media with `judge/fixtures/make.sh` (FFmpeg's lavfi sources, nothing downloaded) in a new scratch folder. A run
that passes deletes that folder unless you give `--keep`. A run that fails keeps it, and the runner prints its path.
Each test's folder holds `test.log`, `adapter.stderr` and the editor's own logs.

CI runs the judge in its own workflow, `.github/workflows/judge.yml`, with the FFmpeg on the runner's `PATH`. Before
the install it copies `judge/`, the gate and `judge.yml` to `$RUNNER_TEMP/judge-src` (read-only), checks the copy with
the copied gate, and runs `run.py --self-test` from it. After `npm ci` and the build it checks that the copy's lock and
gate are the bytes it pinned before the install and that the copy still matches its lock, then runs the judge from
the copy with `--build "$GITHUB_WORKSPACE"`. A failed run uploads the logs of its kept scratch folder (`*.log`,
`*.stderr`) as the `judge-logs` artifact. `ci.yml` runs the lock gate on the checkout as well, so deleting
`judge.yml` or the gate fails `ci.yml`.

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
a clean test must pass. On Linux an adapter that tries to open the test's and the runner's descriptors through
`/proc/<pid>/fd` for writing must be refused every time, with the verdict unchanged, and a fork child that writes
through the result pipe's descriptor number must get EBADF. A runner or a test process that cannot be made
non-dumpable (forced with `JUDGE_FORCE_UNPROTECTED=runner` or `child`) must fail the run, and with
`--allow-unprotected` the run must pass with `UNPROTECTED` on its `JUDGE:` line. It also runs the v0.2.0 adapter's and
`check_observe.py`'s self-tests. On a system other than Linux, run `--self-test --allow-unprotected`: every runner it
starts gets the flag, and the two refusal cases are skipped.

## What is here

| Path | What it is |
|---|---|
| `PROTOCOL.md` | The adapter protocol: JSON lines on stdin and stdout, the operations, the rules for adapters. |
| `driver.py` | The judge's side of the protocol. Tests call its methods (`import_media`, `place_clip`, `export`, ...). |
| `adapters/v020/adapter.py` | The adapter for v0.2.0's interfaces: its MCP tools over stdio, and the core's HTTP routes. |
| `observe.py` | The measurements: ffprobe facts, full decode, SSIM (whole frame or region), signalstats, volume, tone bands, loudness, silences, SRT and OTIO parsing. They are the first-try baseline checker's measurements, with the same FFmpeg filter chains. |
| `check_observe.py` | Compares `observe.py` with the values that the baseline checker recorded for its oracle exports (a local tool: the oracles are not in the repository). |
| `fixtures/make.sh` | Makes the test media. |
| `run.py` | The runner. |
| `selftest.py` | The runner's own tests (`run.py --self-test`). |
| `tests/test_*.py` | The tests. |
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
  value. If the file makes the measurement impossible, the check fails with the reason.
- Record the same checks on every path: where an input is missing (no export file, for example), record the checks
  that need it as failed with the reason instead of returning early. The runner fails a test whose number of checks
  differs from `CHECKS`, so a test cut short cannot pass with the checks it did record.
- `t.media(name)` is a fixture, and `t.path(...)` is a path in the test's scratch folder.
- A test that needs an operation the protocol does not have adds it to `PROTOCOL.md`, `driver.py` and the
  adapters (see "Adding operations" in `PROTOCOL.md`).
- **Safety:** a test writes only in its scratch folder. It starts the editor only through `t.driver()`, which gives
  the editor a scratch home and data folder and a free port. It never uses the user's own editor or its data. Every
  Chromium or Electron launch passes `--mute-audio`. Nothing is downloaded. The runner runs every test under a
  timeout, and CI runs the whole judge under `timeout -k`.

## Update the lock

After a reviewed change to the judge:

```sh
node scripts/check-judge-lock.mjs --write       # rewrite judge/JUDGE.lock from the covered files
node scripts/check-judge-lock.mjs               # check
node scripts/check-judge-lock.mjs --self-test   # the gate's own tests, on copies
```

Python writes no `__pycache__` folders under `judge/` (`run.py` turns bytecode files off, and the runner starts
its child processes with `-B`). A `__pycache__` folder left by another tool makes the gate fail. Delete it.

## Threat model

The judge measures work done by agents that can change the rest of the repository and whose code runs in CI (npm
lifecycle scripts, the build) and in the editor under test, as the same user as the judge.

What it defends against:

- **Edits to the judge, its gate or its workflow** that do not show as a `JUDGE.lock` change: the lock gate fails in
  `ci.yml` and in `judge.yml`. An edit together with a lock update passes the gate; it is visible in the diff for
  review, and nothing more stops it.
- **A weakened gate in the same pull request, when `judge.yml` is unchanged**: a pull request that changes the gate's
  checking logic (for example so that it finds no problems) and updates the lock passes its own copy of the gate, but
  not the base branch's gate, which `judge.yml` runs on pull requests. The lock's content always comes from the pull
  request, because a reviewed judge change must update it; what the base gate adds is only that a pull request that
  leaves `judge.yml` unchanged cannot weaken the checking logic (see "What it does not defend against" for one that
  changes `judge.yml` too). A pull request that changes what the gate covers can fail the base gate by design; it needs
  Anthony to merge it knowingly. This takes effect from the first pull request whose base branch has the gate.
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
  folders, and children inherit them.
- **A killed runner**: SIGTERM or SIGINT ends the running test's session and every process found by the same sweep,
  prints `JUDGE: interrupted by signal N` and exits 1.

What it does not defend against:

- Root, or a process with `CAP_SYS_PTRACE`: it can still open the pipe through `/proc` or attach with ptrace. The
  same holds for a run with `--allow-unprotected`, whose `JUDGE:` line says `UNPROTECTED`.
- The short time between the start of the test process and its `prctl` call, when it already holds the pipe: a
  process of the same user that is already running and watching for it could open the pipe then.
- A process of the same user that makes itself non-dumpable too: the sweep cannot read its environment, so it is not
  found by its scratch values.
- A fork without exec made by non-Python code in the test process (a C extension calling `fork()`): Python's fork
  hook does not run, so the child keeps the result pipe and stays non-dumpable, and the sweep cannot find it.
- A process of the same user that rewrites the read-only copy in `$RUNNER_TEMP` (it can make it writable again). Pinning the copy's
  lock and gate catches a rewrite of those two files during the install and the build, but not a change made after
  that check.
- A hosted runner's passwordless `sudo`: code from the change can replace `python3`, `node` or FFmpeg system-wide.
- A process that removes the scratch values from its environment, or a change that deletes both `judge.yml` and the
  gate step in `ci.yml` (which the lock does not cover). Only review sees those, unless branch protection requires the
  Judge workflow's check.
- A pull request that weakens the gate and also edits `judge.yml`: on `pull_request` events the workflow comes from
  the pull request, so it can remove or change the base-gate step (and with it the warning and the summary list),
  update `JUDGE.lock`, and pass every gate. Its diff shows the `judge.yml` and `JUDGE.lock` changes; nothing else
  stops it. Enforcing the base gate needs GitHub settings: a required check from a workflow the pull request cannot
  change (for example one triggered by `pull_request_target`), or a required review. That is an open decision for
  Anthony.
- An unreviewed judge change: a pull request that edits the judge and updates the lock passes every gate, and the
  base gate and the warning (when `judge.yml` is unchanged) only make the change visible. Enforcing review of judge
  changes needs GitHub settings (the Judge check required, and a required review); that is an open decision for
  Anthony.
