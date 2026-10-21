# Judge adapter protocol, version 1

The judge drives an editor through an **adapter**: a separate process that turns the judge's product-level operations
into calls on one editor build. The judge (`judge/driver.py`) is the client. An adapter can be written in any
language; it needs stdin, stdout, JSON and the editor's own interfaces.

`judge/adapters/v020/adapter.py` is the adapter for v0.2.0's interfaces (its MCP tools over stdio, and the core's
HTTP routes where an operation needs them). A new editor ships its own adapter and runs the same tests with
`python3 -I judge/run.py --adapter "<command>"`.

## Transport

- The runner starts the adapter command once per test, with an empty scratch folder for that test. The adapter's
  current folder is that scratch folder, and its environment has `JUDGE_TEST_SCRATCH=<the scratch folder>` (the
  runner's sweep uses it to find processes left running, see rule 3). The adapter inherits no file descriptor other
  than stdin, stdout and stderr. `run.py --adapter` makes a word of the command that names an existing relative path
  absolute, so `--adapter "node adapters/new.mjs"` works from the folder you run it in.
- The judge sends `hello` first and fails the test when the result's `protocol` is not the judge's version (1).
- Requests go to the adapter's **stdin** and responses come from its **stdout**: one JSON object per line, UTF-8.
- The judge sends one request at a time and waits for its response before it sends the next.
- **stdout carries response lines only.** Logs go to stderr. The runner saves stderr as `adapter.stderr` in the test's
  scratch folder.
- When stdin closes, the adapter stops everything it started (as `stop` does) and exits within 30 s.

### Timeouts

The judge waits this long for each response before it fails the operation with `adapter_error` (`driver.py`):

| op | seconds |
|---|---|
| `hello` | 60 |
| `start` | 300 |
| `stop` | 120 |
| `export` | 1800 |
| `poke_agent_tools` | 1800 |
| every other operation | 600 |

After stdin closes, the judge waits 30 s for the adapter to exit, then kills it. The runner also ends the whole test
after its `TIMEOUT` (600 s unless the test sets another).

Request:

```json
{"id": 7, "op": "trim_clip", "args": {"clip": "c1", "in_frame": 30, "out_frame": 120}}
```

Response, success:

```json
{"id": 7, "ok": true, "result": {}}
```

Response, failure:

```json
{"id": 7, "ok": false, "error": {"code": "product_error", "message": "...", "product_code": "media_offline"}}
```

| `error.code` | Meaning |
|---|---|
| `unsupported` | The adapter does not implement this operation. A test that needs it fails. |
| `bad_request` | The arguments do not fit the operation (missing field, wrong type). |
| `product_error` | The editor answered the operation with an error or a refusal. `message` is the editor's text. `product_code` is its machine-readable code, when it gives one. |
| `adapter_error` | The adapter itself failed: the editor did not start, crashed or did not answer in time. |

A request with an unknown `op` gets `unsupported`. Unknown fields in `args` are ignored, so a later version of the
judge can add optional fields to an operation without breaking older adapters.

### Ports

Any result may carry `"ports": [int]`: TCP ports the editor started listening on during that operation (a server it
starts on first use, for example). The judge adds them to the ports of `start`, and the runner checks that every one
is closed after `stop`.

## Rules for every adapter

1. **Everything stays in the scratch folder.** `start` receives `scratch`, an absolute path to an empty folder that
   the adapter owns until `stop`. The editor's home, settings and data folders, and its temporary files, all go
   inside it. On v0.2.0 that means `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `TMPDIR` and the data folder. The
   editor must never see the user's own settings or data.
2. **Free ports only.** Every port the editor listens on is picked free at start. Never use the editor's default
   port: the user's own editor may be running on it.
3. **Stop only your own processes.** `stop` ends every process the adapter started, by exact process id, and no
   other. After the test, the runner also ends (by exact process id) any process left whose environment has a value
   inside the scratch folder (`JUDGE_TEST_SCRATCH`, or the editor's sandbox folders), and fails the test's "nothing
   left running" check if it finds one. A process that removes those values from its environment is not found.
4. **No sound and no downloads.** Every Chromium or Electron launch passes `--mute-audio`. The adapter downloads
   nothing, and the editor must not need to download anything for the judge's tests.
5. **No private shortcuts.** The adapter uses the interfaces a user or an AI client has (tools, HTTP routes, files the
   editor documents). It does not read or write the editor's internal state behind its back. One operation is the
   exception on purpose: `add_host_outside` plays an attacker who edits the editor's files (see "File surface
   and network computers").

## Identifiers, tracks and time

- Asset, clip and job ids are opaque strings that the adapter returns. The judge passes them back unchanged.
- Tracks are named from the bottom: `v0` is the base video track, `v1` composites over it, and so on. `a0`, `a1`, ...
  are the audio tracks. A new project has at least `v0`. Protocol version 1 has no operation that adds a track:
  `place_clip` or `move_clip` on a track that does not exist answers `bad_request` and changes nothing.
- Timeline positions and source ranges are integer **frames** at the project's frame rate. `out_frame` is exclusive,
  so a clip with `in_frame` 30 and `out_frame` 120 is 90 frames long. `render_frame` takes **seconds**.
- Paths are absolute. A test may send, on purpose, a string that is not a local absolute path where an operation takes
  a path (`import_media`, `load_project`, `save_project`, `import_otio`, `export_otio`, `export`, `apply_lut`, the `font`
  of `add_text`): an http or data: URL, a network path such as `//host/share/a.mp4` or `\\host\share\a.mp4`, a
  relative path, or a path with a `..` segment. The adapter passes it to the editor unchanged and does not normalize
  it; the test checks what the editor does with it.

## Operations

An operation whose result is `{}` may return more fields; the judge ignores fields it does not know.

### Lifecycle

| op | args | result |
|---|---|---|
| `hello` | `{}` | `{"protocol": 1, "adapter": str, "ops": [str]}`: the operations this adapter implements. Works before `start`. |
| `start` | `{"build": str, "scratch": str}` | `{"product": {"name": str, "version": str}, "ports": [int]}`: `build` is the editor checkout or build to run. `ports` lists every TCP port the editor listens on; the runner checks that they are closed after `stop`. |
| `stop` | `{}` | `{}`: every process the adapter started has exited. |

### Media and timeline

| op | args | result |
|---|---|---|
| `import_media` | `{"path"}` | `{"asset": id}` |
| `place_clip` | `{"asset", "track"?, "start_frame", "in_frame", "out_frame"?}` | `{"clip": id}`: the source range `[in_frame, out_frame)` placed at `start_frame` on `track`. `track` left out means `v0`. `out_frame` left out (or null) means the end of the source. |
| `trim_clip` | `{"clip", "in_frame"?, "out_frame"?}` | `{}`: new source range. The clip's start position does not change. |
| `move_clip` | `{"clip", "start_frame", "track"?}` | `{}` |
| `split_clip` | `{"clip", "at_frame"}` | `{"clips": [left id, right id]}`: `at_frame` counts from the clip's start on the timeline. |
| `remove_clip` | `{"clip"}` | `{}` |
| `set_speed` | `{"clip", "speed"}` | `{}`: constant speed, 1 = normal. |
| `apply_effect` | `{"clip", "effect", "amount"?, "params"?}` | `{"effect": id or null}` |
| `apply_colour` | `{"clip", "brightness"?, "contrast"?, "saturation"?, "gamma"?, "temperature"?, "tint"?, "hue"?}` | `{}`: a colour grade. Neutral values: brightness 0, contrast 1, saturation 1, gamma 1, temperature 0, tint 0, hue 0. |
| `apply_lut` | `{"clip", "path"}` | `{}`: applies the colour look-up table (a `.cube` file) at `path` to the clip. |
| `add_text` | `{"clip", "text", "style": {}}` | `{"text": id}`: a text overlay on the clip, shown for the whole clip. `style` fields, all optional: `position` (a placement name such as `bottom`, `top`, `center`), `x`, `y` (0..1), `font` (a font name or a font file path), `font_size`, `color`, `outline_color`, `outline_width`, `shadow_color`, `shadow_x`, `shadow_y`, `box` (bool), `box_color`, `box_border`. A colour is a name (`yellow`), `#rrggbb`, `#rrggbbaa`, `0xRRGGBB` or `name@alpha` (`white@0.5`). The adapter passes every value on unchanged, also one of another type: tests send hostile values on purpose, and the editor accepts or refuses each. |
| `make_proxy` | `{"asset"}` | `{}`: makes the editor's lower-resolution working copy of the asset (in the editor's own folders). |
| `thumbnail` | `{"asset", "time"}` | `{"path": str or null}`: makes a still image of the asset at `time` seconds, where the editor keeps such images. |
| `set_project` | `{"width"?, "height"?, "fps"?}` | `{}`: the output canvas: the size and frame rate of every export and rendered frame. See "The canvas" below. |
| `undo`, `redo` | `{}` | `{}` |
| `get_state` | `{}` | a **State** (below) |

State:

```json
{
  "canvas": {"width": 1280, "height": 720, "fps": 30},
  "length_frames": 90,
  "assets": [{"id": "...", "path": "/abs/a.mp4", "offline": false, "waiting_host": null}],
  "tracks": [
    {"track": "v0", "clips": [
      {"id": "...", "asset": "...", "start_frame": 0, "in_frame": 30, "out_frame": 120, "length_frames": 90,
       "speed": 1}
    ]}
  ]
}
```

### The canvas

- Before any `set_project`, the canvas is the editor's default. v0.2.0 starts at 1920x1080, 30 fps, and while the
  canvas has never been set it takes the size of the first media imported or placed. Tests do not depend on the
  default: they call `set_project` before they import or place anything, and a canvas set that way does not change
  when media of another size is imported or placed.
- Changing `fps` keeps every placed clip at the same time in seconds: its `start_frame`, `in_frame` and `out_frame`
  are scaled by new fps / old fps. On v0.2.0, a clip at `start_frame` 60 with source frames 30-120 at 30 fps is at
  `start_frame` 120 with source frames 60-240 after `set_project(fps=60)`.
- Changing `width` or `height` does not move or change clips.

`length_frames` of a clip is its length on the timeline (after speed). `length_frames` of the State is the end of the
last clip. Tracks are listed from `v0` up, then `a0` up, with their clips in timeline order. An asset is `offline`
when the editor cannot use its file now: it is missing, or it waits for the user to allow its network computer.
`waiting_host` is that computer's name (lower case, as in `list_hosts`) while the asset waits for it, else null. An
adapter whose State has no such field leaves it out; the tests that need it then fail.

### Output and jobs

| op | args | result |
|---|---|---|
| `export` | `{"path", "wait": true}` | a **Job**. With `wait` true, the call returns when the export has finished. With `wait` false, it returns at once with a running job. See "Exports" below. |
| `jobs` | `{}` | `{"jobs": [Job]}` |
| `cancel` | `{"job"}` | `{"canceled": bool}` |
| `render_frame` | `{"time", "path"}` | `{"path"}`: one composited frame of the timeline at `time` seconds, written as a PNG at `path`. |

Job: `{"job": id or null, "status": "running" | "done" | "error" | "canceled", "path": str or null, "error": str or
null, "fraction": number or null}`.

#### Exports

- The path's extension names the container. `.mp4` is an MP4 file with H.264 video and AAC audio. The judge's tests
  use `.mp4` only. For an extension the editor cannot write, the adapter answers `product_error` (the editor refused)
  or `bad_request`.
- The video is the project canvas: its width, height and fps (not the size or rate of the media placed on it), with
  square pixels. It covers the timeline from frame 0 to the State's `length_frames`.
- There is an audio stream when any clip on the timeline has audio.
- With `wait` true, `status` is the editor's own: `error` or `canceled` (with the editor's text in `error`) when the
  editor reports one, even when it left a file at the path; `done` only when the editor reports no error and the file
  is there.

### Projects and interchange

| op | args | result |
|---|---|---|
| `save_project` | `{"path"}` | `{}`: save as `path`. `path` becomes the project's current file. |
| `save` | `{}` | `{}`: the plain Save: writes the project to its current file, the one it was last saved as (`save_project`) or opened from (`load_project`). A project that has no current file is refused (`product_error`). A refused `load_project` or `import_otio` does not change the current file. |
| `load_project` | `{"path"}` | `{"notice": str or null}`: opens the project. `notice` is what the editor tells the user about it (offline media, for example). |
| `export_otio` | `{"path"}` | `{}`: the timeline as an OpenTimelineIO file. |
| `import_otio` | `{"path"}` | `{"missing": [str]}`: opens the OTIO file as the project. `missing` lists the media paths the editor could not find. |

### File surface and network computers

| op | args | result |
|---|---|---|
| `http_get` | `{"route", "query": {}}` | `{"status": int, "content_type": str, "body_length": int, "body_sha256": str, "body_b64": str, "truncated": bool}` |
| `list_hosts` | `{}` | `{"approved": [host], "pending": [host], "outside": [host]}`: `approved` the computers the user allowed; `pending` those that offline media or a refused path names, waiting for the user; `outside` the entries of the editor's allowed list that it did not make itself (see `add_host_outside`): not used until the user keeps them. |
| `approve_host` | `{"host"}` | `{}`: allows media from network computer `host`, as the user does in the editor's window (Allow, or Keep for an entry listed outside). No agent tool may be able to do this. The editor stores the name in lower case; a name that cannot be a network computer is refused (`product_error`). |
| `revoke_host` | `{"host", "only_if_outside"?}` | `{"removed": bool}`: removes `host` from the allowed computers, as the user does in the editor's window. With `only_if_outside` true it removes the entry only while it is still listed outside (the Remove of a Keep question): an entry the user kept meanwhile stays, and `removed` is false. |
| `add_host_outside` | `{"host", "forged"?}` | `{"files": [path], "secrets": [str]}`: adds `host` to the editor's allowed list by editing the editor's files, not through its window: what another program or an agent with file access could do. With `forged` true the entry claims an approval it never had (for example a stamp made with a key that is not the editor's). The editor must treat it as `outside`. The result names the files that hold the allowed list and its secrets, and the secret texts (the key that stamps approvals), so a test can check that no answer of the editor holds them and that no agent operation changes the files. The adapter may create the secret when the editor has none yet, as an attacker could; call it before any approval. |
| `recheck_media` | `{}` | `{}`: the editor reads its list of allowed computers again and re-checks offline media. |

`http_get` requests the editor's file surface: the HTTP routes the editor's own interface uses to read media. The
adapter adds the authentication that the editor's interface uses. The judge tests what is served, not how a client
signs in. Routes, by their v0.2.0 names (another editor's adapter maps each one to its own route):

- `/file`: the bytes of the file named by `query.path`. Only files that the project uses or that the editor made may
  be served.
- `/frames`: decoded video frames of the file named by `query.path`: `from` (the first frame), `count`, `w`, `h` (the
  size of each frame) and `fps`. The same files as `/file` may be read.
- `/peaks`: the audio levels (a waveform overview) of the file named by `query.path`. The same files as `/file`.

`body_b64` holds at most the first 262144 bytes of the body (`truncated` says whether there was more).
`body_length` and `body_sha256` always describe the whole body.

`host` is a computer name as it appears in a network path (`nas` in `//nas/share/clip.mp4`), in lower case. The
judge's tests use names under the reserved `.invalid` domain, which never resolve.

### What an AI agent is offered

| op | args | result |
|---|---|---|
| `agent_tools` | `{}` | `{"tools": [{"name": str, "read_only": bool}], "instructions": str}`: every tool the editor offers an AI agent (on v0.2.0 its MCP tools), and the instructions it gives the agent. |
| `poke_agent_tools` | `{}` | `{"called": int, "refused": int}`: calls every agent tool once with empty arguments; answers and refusals are only counted. It may change the project (a tool that starts a new project, for example), so tests call it last. |
| `transcript` | `{}` | `{"texts": [str]}`: every text the editor answered through this adapter since `start`: tool results and errors, and the bodies of `http_get` and of the window's routes (images left out). Tests search it for secrets that must never reach an agent. |

## Adding operations

A batch of judge tests that needs a new operation adds it to this file and to `driver.py`, and adds it to the
adapters. An existing operation's arguments and result keep their meaning. New optional arguments and new result
fields are allowed. An adapter that does not have a new operation yet answers `unsupported`, and the tests that need
it fail.
