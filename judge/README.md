# The judge

The judge is a set of black-box tests for the ZedMix editor. It decides whether a rewrite of the editor behaves the
way the tested version does. The tests use product-level operations ("import this file", "trim this clip", "export")
and measure what comes out: the exported files, the project state the editor reports, and what its file surface
serves. They never import editor code, and they do not depend on its tool names, routes or internal identifiers. One
**adapter** per editor version maps the operations to that version's own interfaces (see [PROTOCOL.md](PROTOCOL.md)).

## Rules

- **The agents that rewrite the editor must not edit anything under `judge/`.** The judge is how their work is
  measured.
- `judge/JUDGE.lock` holds the sha256 of every file under `judge/`. CI's lock gate
  (`node scripts/check-judge-lock.mjs`) fails when a file differs from the lock, or when a file is added or removed
  without a lock update. So every change to the judge also changes `JUDGE.lock` in the same pull request, where
  review sees it.
- **A lock update needs Anthony's review.** The same applies to changes to `scripts/check-judge-lock.mjs` and to the
  judge's CI steps in `.github/workflows/ci.yml`.
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
```

The runner prints one line per check (`PASS` or `FAIL`), then `JUDGE: <passed>/<checks> passed`. It exits 1 when
any check fails, when a test does not finish within its timeout, or when there are no checks. Each run makes its media
with `judge/fixtures/make.sh` (FFmpeg's lavfi sources, nothing downloaded) in a new scratch folder. A run that
passes deletes that folder unless you give `--keep`. A run that fails keeps it, and the runner prints its path.
Each test's folder holds `test.log`, `adapter.stderr` and the editor's own logs.

CI runs the judge in the `build-and-smoke` job ("Judge (v0.2.0 adapter)") with the FFmpeg on the runner's `PATH`.

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
| `tests/test_*.py` | The tests. |
| `JUDGE.lock` | The lock (above). |

## Write a test

A test is a file `tests/test_<name>.py` with a function `run(t)`:

```python
import observe

PORT_BOUND = True   # it starts the editor (default); tests without a port can run in parallel
TIMEOUT = 600       # seconds; the runner ends the test after that

def run(t):
    d = t.driver()                                  # the editor, started in this test's scratch folder
    clip = d.place_clip(d.import_media(t.media("a.mp4")), "v0", 0, 0, 90)
    out = t.path("out", "x.mp4")
    d.export(out)
    t.measure("the export lasts 3 s", lambda: observe.duration(out), lambda v: abs(v - 3) <= 0.1, "3 +- 0.1 s")
    t.check("the clip is on v0", any(c["id"] == clip for c in d.clips("v0")))
```

- `t.check(name, ok, detail)` records one check. `t.measure(name, fn, accept, want)` records a check on a measured
  value. If the file makes the measurement impossible, the check fails with the reason.
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
node scripts/check-judge-lock.mjs --write       # rewrite judge/JUDGE.lock from the files
node scripts/check-judge-lock.mjs               # check
node scripts/check-judge-lock.mjs --self-test   # the gate's own tests, on copies
```

Python writes no `__pycache__` folders under `judge/` (`run.py` turns bytecode files off, and the runner starts
its child processes with `-B`). A `__pycache__` folder left by another tool makes the gate fail. Delete it.
