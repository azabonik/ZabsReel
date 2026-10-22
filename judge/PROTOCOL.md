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
- With `run.py --as-user <name>` (CI: `zjudge`) the adapter and everything it starts run as that user, with umask
  022 and an environment of exactly `PATH` (the runner's), `LANG`, `HOME` and `TMPDIR` (the scratch folder), `USER`,
  `LOGNAME`, `JUDGE_TEST_SCRATCH`, and `AIVE_FFMPEG` / `AIVE_FFPROBE` when the runner has them. The adapter's command,
  the build and the media must be readable by that user. The scratch folder belongs to the runner (mode 1777): the
  adapter can add files and folders there, but cannot rename or remove the judge's. The hostile inputs the judge
  writes (`observe.craft`) are writable by others, because the editor may save into a project it opened; the
  judge's other files there are not. Files the editor writes for the judge to read
  (exports, saved projects, frames) must be readable by others; its own private files need not be (the judge reads
  those through `t.look`, as that user).
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
starts on first use, for example). A port opened during an operation that answered with an error goes in the next
result that succeeds (`stop`'s included), so it is reported once in every case. The judge adds them to the ports of
`start`, and the runner checks that every one is closed after `stop`.

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
   nothing, and it **starts the editor so that the editor downloads nothing**, whatever operation a test sends
   (`poke_agent_tools` calls every agent tool): every model or helper program the editor would fetch on first use is
   either switched off or named by a setting that points at a file that does not exist, so the feature refuses
   instead of fetching. Never point such a setting at the user's own copy. On v0.2.0: `AIVE_CLIP_DISABLE=1`, and
   `AIVE_WHISPER_BIN` / `AIVE_WHISPER_MODEL` name files in the sandbox that are never made (as the FFmpeg matrix does).
   The graphics add-on is never installed through the editor (that downloads it): a test that needs it gets the
   judge's copy in `start`, headless shell included, so the editor never fetches a browser (see "Motion graphics").
   The judge checks this rule: the runner traces the network calls of the adapter and everything it starts (strace)
   and fails the test's "nothing was downloaded" check on a TCP connect to another computer, a DNS lookup or a send to
   another computer, also when the network is down and the call failed (`judge/README.md`, "Write a test").
5. **No private shortcuts.** The adapter uses the interfaces a user or an AI client has (tools, HTTP routes, files the
   editor documents). It does not read or write the editor's internal state behind its back. One operation is the
   exception on purpose: `add_host_outside` plays an attacker who edits the editor's files (see "File surface
   and network computers").

## Identifiers, tracks and time

- Asset, clip and job ids are opaque strings that the adapter returns. The judge passes them back unchanged.
- Tracks are named from the bottom: `v0` is the base video track, `v1` composites over it, and so on. `a0`, `a1`, ...
  are the audio tracks. A new project has at least `v0`; `add_track` adds one. `place_clip` or `move_clip` on a track
  that does not exist answers `bad_request` and changes nothing.
- Timeline positions and source ranges are integer **frames** at the project's frame rate. `out_frame` is exclusive,
  so a clip with `in_frame` 30 and `out_frame` 120 is 90 frames long. `render_frame` takes **seconds**.
- Paths are absolute. A test may send, on purpose, a string that is not a local absolute path where an operation takes
  a path (`import_media`, `load_project`, `save_project`, `import_otio`, `export_otio`, `export`, `apply_lut`, the `font`
  of `add_text`): an http or data: URL, a network path such as `//host/share/a.mp4` or `\\host\share\a.mp4`, a
  relative path, or a path with a `..` segment. The adapter passes it to the editor unchanged and does not normalize
  it; the test checks what the editor does with it.

## Files the editor saves, and the hostile copies made from them

The judge makes its hostile inputs (a project or OTIO file with a URL, a network path, a `../` identifier, filter
text in a colour or a number) by text substitution in a file the editor itself saved with `save_project`, `save` or
`export_otio`: it needs no knowledge of the format. That works when the saved file holds the values the test gave
the editor as plain text or JSON values: media, LUT and font paths as given, the asset, clip and text identifiers
the adapter returned, text colours as given, and some numbers exactly once. A format that does not (one that stores
paths relative to the project, encodes the file, or renames identifiers) is allowed: the checks on an input that
cannot be made are then recorded as **not applicable**, each listed by name with the replacement counts, never as
failed and never as passed. `run.py --strict` turns them into failures. The adapter does not change saved files.

## Operations

An operation whose result is `{}` may return more fields; the judge ignores fields it does not know.

Every operation can answer the errors in the table under "Transport": `bad_request` for arguments of the wrong shape,
`product_error` when the editor refuses, `adapter_error` when the editor is not started or does not answer. Where an
operation has refusals of its own, its "Errors" line below names them; the tests check that a refusal happens and
what it leaves behind, never its message or code.

### Lifecycle

| op | args | result |
|---|---|---|
| `hello` | `{}` | `{"protocol": 1, "adapter": str, "ops": [str]}`: the operations this adapter implements. Works before `start`. |
| `start` | `{"build": str, "scratch": str, "graphics_addon"?: {"root": str, "browser": str}}` | `{"product": {"name": str, "version": str}, "ports": [int]}`: `build` is the editor checkout or build to run. `ports` lists every TCP port the editor listens on; the runner checks that they are closed after `stop`. `graphics_addon` (see "Motion graphics" below): the graphics add-on the judge gives this editor; left out, the editor has none. |
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
| `apply_effect` | `{"clip", "effect", "amount"?, "params"?, "color"?, "enabled"?, "effect_id"?}` | `{"effect": id or null}`: adds the effect `effect` (see "Effects" below) at the end of the clip's effects. With `effect_id` (an effect of this clip) it changes that effect in place instead: `amount`, `params` and `color` are replaced by what is sent, and `enabled` alone (false: bypassed, kept but not rendered; true: on again) changes nothing else. Values are passed on unchanged: the editor clamps a value outside its range (get_state then shows the clamped value) or refuses it. Errors: `bad_request` when `enabled` is not a boolean or a field has the wrong type; `product_error` when the editor refuses: an effect it does not have, a param the effect does not have, an amount or a colour for an effect that takes none, a colour it cannot read or the effect does not take, an `effect_id` the clip does not have. |
| `remove_effect` | `{"clip", "effect"}` | `{}`: removes the effect (an id from `apply_effect`). Errors: `product_error` when the clip does not have it. |
| `reorder_effect` | `{"clip", "effect", "to_index"}` | `{}`: moves the effect to position `to_index` of the clip's effects (0 is the first, rendered first); a position past the end puts it last. One undo step. Errors: `product_error` when the clip does not have it. |
| `add_track` | `{"kind": "video" \| "audio"}` | `{"track": name}`: a new track: a video track composites over every video track there is (it is the highest `v` name), an audio track is the next `a` name. Errors: `bad_request` for another kind. |
| `apply_colour` | `{"clip", "brightness"?, "contrast"?, "saturation"?, "gamma"?, "temperature"?, "tint"?, "hue"?}` | `{}`: a colour grade. Neutral values: brightness 0, contrast 1, saturation 1, gamma 1, temperature 0, tint 0, hue 0. |
| `apply_lut` | `{"clip", "path"}` | `{}`: applies the colour look-up table (a `.cube` file) at `path` to the clip. Errors: `bad_request` when `clip` or `path` is missing or not a string; `product_error` when the clip does not exist, or the path is not a local file the editor may read: a URL or another protocol, a path on a network computer the user has not allowed (that computer then waits for the user, see `list_hosts`), or a file of the editor's own allowed list in any spelling. |
| `add_text` | `{"clip", "text", "style": {}}` | `{"text": id}`: a text overlay on the clip, shown for the whole clip. `style` fields, all optional: `position` (a placement name such as `bottom`, `top`, `center`), `x`, `y` (0..1), `font` (a font name or a font file path), `font_size`, `color`, `outline_color`, `outline_width`, `shadow_color`, `shadow_x`, `shadow_y`, `box` (bool), `box_color`, `box_border`. A colour is a name (`yellow`), `#rrggbb`, `#rrggbbaa`, `0xRRGGBB` or `name@alpha` (`white@0.5`). The adapter passes every value on unchanged, also one of another type: tests send hostile values on purpose, and the editor accepts or refuses each. |
| `make_proxy` | `{"asset"}` | `{}`: makes the editor's lower-resolution working copy of the asset (in the editor's own folders). Errors: `bad_request` when `asset` is missing; `product_error` when the asset does not exist or its media is offline, for example while it waits for its network computer. |
| `thumbnail` | `{"asset", "time"}` | `{"path": str or null}`: makes a still image of the asset at `time` seconds, where the editor keeps such images. Errors: `bad_request` when `asset` is missing or `time` is not a number; `product_error` as for `make_proxy`. |
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
       "speed": 1, "graphics": [], "texts": [{"id": "...", "text": "Hello"}],
       "effects": [{"id": "...", "effect": "vignette", "enabled": true, "amount": 1.5}]}
    ]}
  ],
  "graphics": {"renderer": "builtin", "ready": true}
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
adapter whose State has no such field leaves it out; the tests that need it then fail. A clip's `graphics` lists the
ids of the motion graphics shown over it (`add_graphic` with `clip`), and the State's `graphics` says which renderer
the user chose for motion graphics and whether it can render now (see "Motion graphics" below). A clip's `texts` are
its text overlays (`add_text`: their ids and texts), and its `effects` are its visual effects in the order they are
rendered: each one's id, its name (see "Effects"), whether it is on (`enabled` false: bypassed), and, when it has
them, its `amount`, its `params` (an object of numbers) and its `color` (in the editor's own spelling, which the tests
only compare with itself). Values the editor clamped are shown clamped.

### Effects

The effects a clip can have (`apply_effect`), as the product names them, with their controls: the range of the
`amount` (a number) and of each param (`params`, numbers), and what they do. A value outside its range is clamped. The
tests use these names and ranges; another editor's adapter maps them to its own.

| effect | controls | what it does |
|---|---|---|
| `blur` | amount 0..100 (the blur radius, sigma in pixels) | Gaussian blur |
| `sharpen` | amount 0..5 | unsharp-mask sharpening |
| `detail` | amount 0..1 | contrast-adaptive sharpening |
| `denoise` | amount 0..30 | noise reduction over space and time |
| `sepia`, `grayscale`, `edges`, `invert` | none | a warm brown tone; no colour; an edge drawing; every colour inverted |
| `vignette` | amount 0..2.5 (1 the classic strength, 0 none) | darker corners |
| `posterize` | amount 2..32 (levels per channel) | flat colour levels |
| `pixelate` | amount 2..100 (block size factor) | mosaic blocks |
| `chromakey` | params similarity 0.01..1, blend 0..1, despill 0..1; `color` the key colour (`0xRRGGBB`, `#rrggbb`, or `auto`) | a green or blue screen made transparent |
| `colorkey` | params similarity 0.01..1, blend 0..1; `color` as chromakey | a flat colour made transparent |
| `lumakey` | params threshold 0..1, tolerance 0..1, softness 0..1; `color` only `auto` | black or white made transparent |
| `exposure` | amount -3..3 (stops), params black -1..1 (the black point; kept below the white point) | camera-style exposure |
| `vibrance` | amount -2..2 | saturation that lifts dull colours more than saturated ones |
| `colorhold` | params similarity 0.01..1, blend 0..1; `color` the colour kept (hex, not `auto`) | every other colour turned grey |
| `grain` | amount 0..100 | film grain, new on every frame |
| `glow` | amount 0..1, params radius 1..100 (pixels) | a bloom around bright areas |
| `rgbsplit` | amount 0..50 (pixels), params angle 0..360 (degrees, 0 horizontal) | red and blue pushed apart |
| `lens` | amount -1..1 (k1: positive barrel, negative pincushion), params k2 -1..1, fill 0..1 (1: zoomed so that no corner is left empty, the default; 0: the uncovered corners stay transparent) | a lens warp around the middle |
| `trails` | amount 0.8..0.99 (the decay per source frame) | a fading echo of what moves |

Only the keys (and `lens` with fill 0) make pixels transparent. A clip smaller than the canvas, or of another aspect,
is fitted in the middle, and the rest of the canvas is transparent: the tracks below show there, also under any
effect.

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
| `revoke_host` | `{"host", "only_if_outside"?}` | `{"removed": bool}`: removes `host` from the allowed computers, as the user does in the editor's window. With `only_if_outside` true it removes the entry only while it is still listed outside (the Remove of a Keep question): an entry the user kept meanwhile stays, and `removed` is false. For a host that is not in the list, `removed` is the editor's own answer (v0.2.0 answers true); the tests do not depend on it. Errors: `bad_request` when `host` is missing or `only_if_outside` is not a boolean; `product_error` when the window refuses the name (one that cannot be a network computer); `adapter_error` when the window's interface cannot be reached (on v0.2.0 the web shell did not start or did not take its key). |
| `add_host_outside` | `{"host", "forged"?}` | `{"files": [path], "secrets": [str]}`: adds `host` to the editor's allowed list by editing the editor's files, not through its window: what another program or an agent with file access could do. With `forged` true the entry claims an approval it never had (for example a stamp made with a key that is not the editor's). The editor must treat it as `outside`. The result names the files that hold the allowed list and its secrets, and the secret texts (the key that stamps approvals), so a test can check that no answer of the editor holds them and that no agent operation changes the files. The adapter may create the secret when the editor has none yet, as an attacker could; call it before any approval. Errors: `bad_request` when `host` is missing or `forged` is not a boolean; `adapter_error` when the editor is not started or its files cannot be written. Never `product_error`: the editor is not asked. |
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

### Motion graphics

A motion graphic is code an AI agent writes: a TSX module whose default export is a React component that uses
[Remotion](https://www.remotion.dev)'s API (`remotion`, and `react`). The editor renders it to video. Which renderer
does that is the user's setting, made in the editor's window, never by an agent:

- `builtin`: the editor's own renderer (v0.2.0: ZedMix's renderer, in the app's Electron; the default).
- `addon`: the **graphics add-on**, Remotion 4.0.481 itself and the Chrome headless shell it renders in. A user
  installs it from the editor's window, which downloads it. The judge never asks the editor to install it: `start`'s
  `graphics_addon` gives the editor the add-on's files, which the judge installed before the run (README, "The
  graphics add-on"): `root` is a folder whose `node_modules` holds Remotion 4.0.481's packages (`remotion`,
  `@remotion/bundler`, `@remotion/renderer`, `react`, `react-dom` and what they need, as
  `judge/fixtures/graphics-addon/package-lock.json` pins them), and `browser` is the Chrome for Testing headless shell
  that Remotion 4.0.481 tests with (149.0.7790.0, pinned in `judge/fixtures/graphics-addon/headless-shell.json`). The
  adapter starts the editor so that it uses these files as its installed add-on (v0.2.0: `AIVE_REMOTION_ADDON=<root>`
  and `AIVE_REMOTION_BROWSER=<browser>`, which a source checkout honours; another adapter may copy them where its
  editor keeps its add-on, inside the scratch folder). Without `graphics_addon` the editor has no add-on, as for a
  user who never installed it. The files are read-only; the editor must not need to write there.

| op | args | result |
|---|---|---|
| `set_graphics_renderer` | `{"renderer": "builtin" \| "addon"}` | `{}`: chooses the renderer, as the user does in the editor's window (v0.2.0: Help, Graphics add-on, Graphics renderer). Errors: `bad_request` for another value; `product_error` when the window refuses it; `adapter_error` when the window's interface cannot be reached (v0.2.0: the web shell, started on first use as for `approve_host`; its port comes back in `ports`). |
| `add_graphic` | `{"code"?: str, "template"?: str, "props"?: {}, "clip"?: id, "duration_s"?: number}` | `{"graphic": id or null, "clip": id, "asset": id or null}`: renders a motion graphic with the chosen renderer and adds it. Exactly one of `code` (the TSX module, sent unchanged: tests send hostile code on purpose) and `template` (a built-in graphic: `title`, a title card whose `props.title` is its text). `props` are the component's props. With `clip`, the graphic is shown over that clip for the clip's whole length, and `graphic` is its id (in the clip's `graphics` in the State). Without it, the graphic is a clip of its own, `duration_s` seconds long, added at the end of `v0`; `graphic` is then null. `clip` is the clip that shows it, and `asset` the project asset that holds the rendered graphic (null when the editor keeps it in no asset). That asset's file (its `path` in the State) must be readable by others, as an export is. Errors: `bad_request` when neither or both of `code` and `template` are given, or a field has the wrong type; `product_error` when the editor refuses or the render fails: the renderer cannot run, the add-on is missing on the `addon` setting, the code imports what a graphic may not, or the graphic loads media it may not. The tests check that a refusal happens and what it leaves behind (no graphic, no asset, no file, nothing contacted), never its message. |

The State's `graphics` is `{"renderer": "builtin" | "addon", "ready": bool}`: the user's choice, and whether
`add_graphic` can render with it now (false while the `addon` setting has no add-on, or the renderer cannot run on
this computer). An adapter whose editor has no renderer setting leaves it out, and answers `unsupported` for
`set_graphics_renderer`; the tests that need them then fail.

Every graphic is rendered muted (no sound reaches the speakers, and the rendered graphic has no audio stream), and the
renderer gives the graphic no network: the only computer its page may reach is this one at `127.0.0.1` or
`localhost` (the add-on's own server runs there), and no request may make the renderer open a network path or a file
the graphic names. The page keeps the browser's same-origin policy: it cannot read the answer of a server of another
origin (another port of `127.0.0.1` included) that gives it no cross-origin permission, and it cannot read a file of
this computer by its `file://` URL.

### The command-line installer

The editor's command-line installer (v0.2.0: `npx zabsreel`, this tree: `npx zedmix`; the v0.2.0 adapter runs the
`bin` program of the build's `packages/skill-installer` with node) installs the editor's AI skill (`add`) and moves what an earlier release left in a
user's AI-client configuration over to the current one (`migrate`). It works on the files of a home folder, so the
judge gives it a **world**: a folder in the test's scratch folder with a home folder, project folders and the files in
them, made by the adapter as the editor's user (with `run.py --as-user` the installer runs as that user, and must be
able to rewrite, rename and remove a user's own files there).

| op | args | result |
|---|---|---|
| `cli_world` | `{"root", "files": {path: entry}}` | `{}`: makes the folder `root` (absolute, inside the test's scratch folder, not there yet) and in it, for each relative `path` (`/`-separated plain names), the entry: `{"text": str}` a file with that text (UTF-8, exactly, line ends included), `{"link": target}` a symbolic link, or `{"dir": true}` a folder; each may have `"mode"` (permission bits, set after everything is made). Missing parent folders are made. Errors: `bad_request` when `root` is not inside the scratch folder or is there already, or an entry or path has another shape. |
| `cli` | `{"args": [str], "cwd", "home", "appdata"?, "path"?: [folder], "input"?: str, "tty"?: bool}` | `{"exit": int, "output": str}`: runs the installer with `args` in the folder `cwd`, with its home folder at `home` (`HOME`, `USERPROFILE`, and `XDG_CONFIG_HOME` at `<home>/.config`), `APPDATA` at `appdata` (default `<home>/AppData/Roaming`), its data folder and temporary files in the editor's sandbox, and `PATH` exactly the `path` folders (none: no program can be found). `input` goes to its stdin; with `tty` true it runs on a new terminal instead, and each line of `input` is typed once the installer has printed something and waits. `exit` is its exit code (-9 when it did not end within 120 s and was killed); `output` is what it printed (stdout and stderr, or what the terminal showed). Every path is absolute and inside the test's scratch folder. Errors: `bad_request` for a path outside it or a field of another type; `adapter_error` when the installer cannot be found or started. |

The tests check the world's files after each run (through `t.look`), and the exit code; they never check what the
installer printed for its wording, only that a dry run names the files it would change or leave alone.

### What an AI agent is offered

| op | args | result |
|---|---|---|
| `agent_tools` | `{}` | `{"tools": [{"name": str, "read_only": bool}], "instructions": str}`: every tool the editor offers an AI agent (on v0.2.0 its MCP tools), and the instructions it gives the agent. Errors: `adapter_error` when the editor is not started or does not list its tools. Never `product_error`. |
| `poke_agent_tools` | `{}` | `{"called": int, "refused": int}`: calls every agent tool once with empty arguments; answers and refusals are only counted. It may change the project (a tool that starts a new project, for example), so tests call it last. A tool that refuses, fails or does not answer within the adapter's limit for one tool (v0.2.0: 120 s) counts in `refused`, not as an error of the operation. No tool may download anything (rule 4). Errors: `adapter_error` when the editor is not started or does not list its tools. |
| `transcript` | `{}` | `{"texts": [str]}`: every text the editor answered through this adapter since `start`: tool results and errors, and the bodies of `http_get` and of the window's routes (images left out). Tests search it for secrets that must never reach an agent. Errors: none of its own; before `start` it answers an empty list. |

## Adding operations

A batch of judge tests that needs a new operation adds it to this file and to `driver.py`, and adds it to the
adapters. An existing operation's arguments and result keep their meaning. New optional arguments and new result
fields are allowed. An adapter that does not have a new operation yet answers `unsupported`, and the tests that need
it fail.
