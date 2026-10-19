# The motion renderer

ZabsReel's own renderer for `add_graphic` (package `@aive/motion`). It renders
AI-written React components that use the Remotion API subset in
`packages/motion/cleanroom/runtime/exports.json`, with no Remotion code, in the
Electron that every desktop install already has. It is the default graphics
renderer. The Remotion add-on stays as the other choice (the user's renderer
setting, Help → Graphics add-on…). User-facing rules are in the README
("Motion graphics"); this note is for contributors.

## Parts

| Part | Where |
| --- | --- |
| The core's driver: compile, start, frames into FFmpeg, media answers, audio mix, move into `baked/` | `packages/core/src/motion/rendermotion.ts` |
| Which executable runs the renderer | `packages/core/src/motion/rendererbinary.ts` |
| Media, images and fonts on demand, the caps, the frame LRU | `packages/core/src/motion/motionmedia.ts` |
| Audio cues into ranges, the mix | `packages/core/src/motion/motionaudio.ts` |
| The graphic's compile (sucrase) and import check | `packages/core/src/motion/graphicmodule.ts` |
| The named errors | `packages/core/src/motion/motionerror.ts` |
| The renderer process (Electron main of one render) | `packages/motion/renderer/motion-renderer.cjs`, `preload.cjs` |
| The page and its scripts | `packages/motion/renderer/page.html`, `guard.js`, `loader.js`, `host.js` |
| The clean-room runtime, built into one page script | `packages/motion/cleanroom/runtime/src` → `packages/motion/dist/zr-runtime.js` (`scripts/build-runtime.mjs`) |
| React 18.3.1 UMD builds and their licence (MIT) | `packages/motion/vendor/react-18.3.1` |

## The renderer process

One process per render. The core starts it with `--zr-motion-renderer` and
`apps/desktop/electron/main.cjs` requires `motion-renderer.cjs` as its first
statement and runs nothing else: no core, no window, no desktop IPC.

- Packaged app: the core runs under the app's own Electron, so the renderer
  is the app's executable (`process.execPath`) with only the flag.
  "Packaged" is decided only by `isSourceCheckout()` (the core's package
  folder has no `src/`; the afterPack gate keeps `src/` out of every packed
  tree).
- Source checkout: the Electron binary, with `apps/desktop` as the app path,
  then the flag.

The renderer gets only an environment allowlist (`RENDERER_ENV` in
`rendermotion.ts`, plus its own TEMP/TMP/TMPDIR/XDG_CACHE_HOME in the
render's folder). Its profile and temp files go under the render's folder,
`<dataDir>/motion/<id>` (`--zr-scratch`). It exits when its stdin ends or the
core's PID is gone. A probe run (`--probe`) at core start sets the renderer
state that `get_state` reports.

Pipes with the core:

| Pipe | Direction | Carries |
| --- | --- | --- |
| stdin | core → renderer | JSON lines: the start table (page, scripts, runtime, the compiled graphic), one line per frame, EOF to stop |
| stdout | renderer → core | JSON lines: ready, frame n done (with its audio cues), media and font requests, logs, errors |
| fd 3 | renderer → core | raw frames: exactly width × height × 4 bytes each, B, G, R, A, premultiplied, no row padding |
| fd 4 | core → renderer | media and font answers: `[request id][status][length]` (u32, big-endian), then the bytes |

The core writes the frames into FFmpeg (ProRes 4444 with alpha for an
overlay, H.264 for a standalone card; BT.601, as Remotion's files are),
mixes the audio, and moves every output into `baked/` together only after the
whole render has succeeded.

## The page and the host contract

`page.html` loads, in order: `guard.js` (virtual time; WebRTC, WebTransport,
Worker, SharedWorker and serviceWorker removed), React's two UMD builds,
`loader.js` (the frame driver and the `require` table: react, react-dom, the
JSX runtimes, `remotion` and `@aive/motion`; any other name fails),
`zr-runtime.js`, `host.js` and `module.js` (the graphic, compiled by the core
with sucrase).

`host.js` is the adapter between the page and the runtime. The runtime's side
of the contract is `packages/motion/cleanroom/runtime/src/host.ts`
(`createMotionApp`, `createModuleObject`, `MotionHost`, `AssetInfo`,
`CompositionInput`, `AudioCue`). For frame n the main calls the page, the
runtime renders frame n and waits for its `delayRender` handles, the page
reports `frameReady(n, cues)`, and the main captures the frame. Before the
capture the main forces a draw of the page as it is now (`drawn()` in
`motion-renderer.cjs`), so the capture never copies an older frame.

## Media, images, fonts and audio

- A graphic names library media only by asset id: `asset("<id>")`. At render
  start the page gets a table of id → opaque per-render handle, kind and
  sizes. It never gets a path, a file name or a folder.
- Video frames and images: the page loads
  `zrmotion://media/<handle>?t=<source frame>&w=&h=` (no `t` for an image).
  The renderer sends the request on stdout; the core checks the handle, the
  caps and whether the file may be opened (offline and network-path rules),
  decodes with ZabsReel's FFmpeg (`ffmpeg/executor.ts`) to a PNG on FFmpeg's
  stdout, and answers on fd 4. No decoded frame is written to a file. Repeated
  requests come from an in-memory LRU.
- FFmpeg 8.1 and newer place a video that starts later than its file's audio
  one frame earlier than older FFmpeg does. FFmpeg 8.1 and newer start the
  file's clock at 0; older versions start it at the audio's first packet,
  which can be a little before 0 (the audio encoder's delay). The Windows
  installer bundles one pinned FFmpeg (9.0.2), so its users always see the
  same placement.
- `<Video>` and `<Html5Video>` show the same decoded frames as
  `<OffthreadVideo>` (there is no `<video>` element in the page): their
  colours match `<OffthreadVideo>`'s, within about 14 levels of the add-on's
  `<Video>` (which the browser decodes).
- Fonts: installed fonts work by CSS family name. A font file goes in through
  `add_graphic`'s `fonts` parameter (checked like `add_text`'s font), and
  `loadFont(asset("<id>"))` loads it from `zrmotion://app/font/<handle>`; the
  core reads the file and answers on fd 4.
- Audio does not play in the page. Each frame reports its audio cues; the
  core merges them into ranges and mixes them with FFmpeg into the render's
  folder: a standalone card gets the mix in its .mp4, an overlay gets a .wav
  that `add_graphic` places as one linked audio clip over the graphic's window.

## Caps

Each cap is checked before the work it bounds. A breach ends the render with a
named error and leaves no process, no `motion/<id>`, nothing in `baked/` and no
project change.

| Rule | Value | On breach |
| --- | --- | --- |
| media requests per composition frame | 8 | `graphic_media_per_frame` |
| requested box | scaled down to fit the canvas | clamped |
| FFmpeg decodes per render (LRU hits do not count) | 40,000 | `graphic_media_decodes_cap` |
| in-memory LRU of decoded frames | 256 MB | oldest entries dropped |
| FFmpeg decodes at once | 8 | the next request waits |
| fonts per render / bytes per font file | 16 / 32 MB | `graphic_font_cap` |
| audio cues per frame / ranges / sources | 8 / 256 / 16 | `graphic_audio_cues_cap` |
| one media or font request | 20 s | `graphic_decode_timeout` |
| one frame (page side) | 30 s | `graphic_frame_timeout` |
| the whole render | 120 s + 1 s per frame | `graphic_render_timeout` |
| the audio mix | 60 s + 2 × the graphic's length | `graphic_mix_timeout` |
| the page's heap | 2048 MB | `graphic_render_crashed` |
| frames per graphic | 36,000 | refused before the render |
| props | 256 KB of JSON | refused before the render |

The values are `MEDIA_CAPS` (`motionmedia.ts`), `AUDIO_CAPS`
(`motionaudio.ts`) and the limits in `rendermotion.ts`.

## Security invariants

1. No data leaves the computer from the page. The render's in-memory session
   cancels every request that is not `zrmotion:`, every host name fails to
   resolve, everything else goes to a dead proxy, and `zrmotion:` serves only
   the table the core sent. The page's CSP allows no connection, media
   element, worker, frame or object. WebRTC is off in three layers (the IP
   handling policy with the dead proxy, a command-line switch, the names
   removed by `guard.js`).
2. No path reaches the page or the renderer. The renderer knows only its own
   scratch folder; the page knows handles only.
3. Every media byte is decoded by ZabsReel's FFmpeg after the offline and
   network-path checks; font bytes are read by the core after the font
   checks. The renderer opens no library file.
4. The renderer runs none of the desktop's code, the page has no Node, and the
   renderer holds no core token and no ZabsReel API. Its only outputs are
   frames, logs, audio cues, frame failures and media requests on its pipes.
5. The renderer main drives its own page over the DevTools protocol
   in-process (`webContents.debugger`), only to force a draw before each
   capture. There is no remote debugging port, and the page cannot reach the
   protocol.
6. Graphic code can load only react, react-dom, the JSX runtimes, the runtime
   and itself.
7. A runaway graphic is stopped on both sides (the caps above), and every stop
   leaves nothing behind. If the core dies, the renderer exits, and the next
   core start removes its scratch folder.
8. The agent cannot write the renderer setting: only the desktop app and the
   web shell (after the user's click in the add-on dialog) write
   `<dataDir>/addons/renderer.json`.
9. A graphic's audio clip never outlasts the graphic that made it (split,
   trim and remove follow the graphic).

## The clean room

The runtime in `packages/motion/cleanroom/` was written without access to
Remotion's source code:

1. A spec author read only Remotion's public documentation and wrote a
   specification in its own words. A reviewer checked it against the
   documentation.
2. An implementer, in a sandbox with no Remotion on disk and no network, wrote
   the runtime and its unit tests from that specification and an interface
   brief only.
3. Parity tests rendered the same compositions with Remotion and with this
   runtime (`packages/motion/scripts/parity-render.ts`, `parity-media.ts`)
   and sent the differences back to the implementer only as numbers in a
   fixed format, never as Remotion code.
4. An audit compared the runtime with Remotion's source for shared code and
   checked every clean-room session's record.

Each role ran as its own session with its own settings. The evidence
(settings with their sha256, command lines, session records, documentation
snapshots, the specification's sha256 and the audit reports) is kept by the
maintainer outside this repository and is not in any installer.

Rules for contributors:

- Only a clean-room session changes `packages/motion/cleanroom/runtime/`,
  `packages/motion/cleanroom/test/` or `packages/motion/cleanroom/NOTES.md`.
  Do not edit, move or reformat them, even for a typo. Wiring goes around
  them (`packages/motion/renderer`, `packages/motion/scripts`,
  `packages/core/src/motion`).
- `packages/motion/cleanroom/CLEANROOM.lock` holds the sha256 of each of those
  files. `node scripts/check-cleanroom-lock.mjs` (CI, before the install)
  fails on a changed, added or deleted file.
- If the runtime must behave differently, describe the observable behaviour
  you need (file, behaviour, why) in an issue; a clean-room session makes the
  change and the lock is regenerated with it.
- Anyone who has read Remotion's source must not write runtime code.

## Tests

`docs/TESTING.md` lists the motion renderer's smokes (`smoke-renderer`,
`smoke-motion-media`, `-audio`, `-settle`, `-switch`), the clean-room tests
(`npm run test:cleanroom`) and the two parity tools.
