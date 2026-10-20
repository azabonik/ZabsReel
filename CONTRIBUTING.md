# Contributing

Thanks for your interest in ZedMix! This is an open-source project and
contributions are welcome.

## Project structure

```
packages/core    @aive/core  — headless engine: timeline (EDL), FFmpeg pipeline,
                               HTTP /rpc + WebSocket server. No UI, no AI.
packages/mcp     @aive/mcp   — MCP server: exposes core's RPC methods as tools to
                               AI clients; forwards calls to the running core.
apps/desktop     zedmix-desktop — Electron + React UI. Connects to core over WS.
                               web/server.cjs serves the same UI to a browser tab.
```

The golden rule of the architecture: **the editor core is the single source of
truth.** The MCP server and the desktop UI are both thin clients of it. Add a
new editing capability **once**, in the core's RPC registry, and it is instantly
available to both the AI (as an MCP tool) and the UI.

## Adding a new editing operation

1. Implement the behavior on `EditorEngine` in `packages/core/src/engine.ts`
   (mutations should go through `this.mutate(...)` for undo support).
2. Register it in `packages/core/src/rpc.ts` with a zod schema + description.
   That's it — the MCP server auto-exposes every RPC method as a tool, and the
   UI can call `api.rpc("your_method", { ... })`.
3. If it changes rendering, update the filtergraph builder in
   `packages/core/src/ffmpeg/graph.ts`.

## Dev setup

```bash
npm install
npm run build
# there is no test runner: the checks are the smoke scripts in docs/TESTING.md (see "Testing" below)
```

## Testing

Every feature ships with an end-to-end smoke test that runs a **real FFmpeg
render** — there are no mocks. Generate two test clips, then run them. Smoke
arguments must be **absolute paths** (`importVideo` rejects relative ones).

```bash
# generate sample clips (any two media files work); scratch/ is gitignored
mkdir -p scratch
ffmpeg -f lavfi -i testsrc=size=1280x720:rate=30:duration=5 -f lavfi -i sine=frequency=440:duration=5 -shortest -pix_fmt yuv420p scratch/a.mp4
ffmpeg -f lavfi -i testsrc2=size=640x480:rate=30:duration=4 -pix_fmt yuv420p scratch/b.mp4

npx tsx packages/core/scripts/smoke.ts scratch/a.mp4 scratch/b.mp4   # engine + render
npx tsx packages/mcp/scripts/smoke.ts  scratch/a.mp4 scratch/b.mp4   # full MCP path
npx tsx apps/desktop/scripts/smoke-web.ts                            # web shell end-to-end
```

Per-feature smokes live in `packages/core/scripts/` — e.g. `smoke-effects.ts`,
`smoke-transitions.ts`, `smoke-music.ts`, `smoke-text.ts`, `smoke-captions.ts`
(Whisper), `smoke-reframe.ts` (YuNet), `smoke-jlcut.ts`, `smoke-motion.ts`
(Remotion), and `smoke-bundled.ts` (the packaged/offline bundle, see below).
Models/binaries download on first use and cache under `~/.aive` (override with
`AIVE_WHISPER_DIR` / `AIVE_MODELS_DIR`, etc.). Graphics load Remotion only from
the graphics add-on: in a source checkout, set `AIVE_REMOTION_ADDON=$PWD` to use
the Remotion in `node_modules` (the graphics smokes do this for you; see
`docs/TESTING.md`).

## Network paths and the trust folder

The core never opens a file on a network computer that the user has not
allowed (README, "Media on a network drive"). Three rules keep it that way:

1. Core code opens files only through `packages/core/src/io/gatedfs.ts` and
   starts processes only through the helpers in `ffmpeg/executor.ts`.
   `node scripts/check-io-imports.mjs` fails on any other `fs` or
   `child_process` import.
2. A new RPC parameter that takes a path goes in `RPC_PATH_PARAMS` in
   `packages/core/src/rpc.ts`. `smoke-unc.ts` fails on a path-like parameter
   that is not listed.
3. Only `trusthosts.ts` opens files in `<dataDir>/trust/`. No result, log line
   or error text may carry a stamp, the key, or the content of a file there.

Run these after a change to file access, an RPC path, or the approval store
(both use temp folders and test servers under `.invalid`, so they reach no
network):

```bash
npx tsx packages/core/scripts/smoke-unc.ts       # unit: keys, refusals, gatedfs, the store, the trust folder
npm run build                                    # smoke-unc-e2e runs the built core
npx tsx packages/core/scripts/smoke-unc-e2e.ts   # a real core process with every fs and child_process call traced
```

`smoke-unc-e2e.ts` step 7 needs Windows shares, so it runs only on Windows (as
an administrator, in the release workflow) and is skipped elsewhere.

## Packaging / building installers

Distribution is **offline-first**: the installer bundles FFmpeg, whisper.cpp
(+ `base.en`), the YuNet model, and an OSS font so the app works with no
downloads on first run, motion graphics included (ZedMix's own renderer,
`@aive/motion`). The one exception is the optional graphics add-on (Remotion
and its headless shell), which the user installs from **Help → Graphics
add-on** and which no installer may contain (see "Remotion is a devDependency
only" below).

```bash
node apps/desktop/scripts/prepare-bundle.ts     # stage bundled binaries → apps/desktop/build/resources/aive
npx tsx packages/core/scripts/smoke-bundled.ts  # verify the staged bundle renders offline
npm run build
npm run dist --workspace zedmix-desktop       # build the NSIS installer
```

A few non-obvious things if you touch the packaging:

- `apps/desktop/electron/bundled-assets.cjs` sets the engine's env overrides
  (`AIVE_FFMPEG`, `AIVE_WHISPER_BIN`, …) to the bundled copies — but **only when
  `app.isPackaged`**. In dev it's a no-op and the engine uses PATH + `~/.aive`.
- The electron-builder config sets **`npmRebuild: false`**. Without it,
  electron-builder runs a production `npm install` that, in this hoisted npm
  workspace, **prunes devDependencies from the shared root `node_modules`** — it
  will delete electron-builder itself mid-build. Leave it off.
- `asar: false` is intentional: the core runs as a spawned Node subprocess from
  real files.
- `build.files` leaves out the core's `src/` (`!**/packages/core/src{,/**}`;
  electron-builder copies the workspace's `packages/core` whole and ignores its
  `files` field). A core with `src/` takes itself for a source checkout and
  honours the developer variables in `docs/TESTING.md`.
- `build.files` also leaves out `@aive/motion`'s `parity/`, `scripts/` and
  `cleanroom/test/` (dev tools and tests). The packed app keeps its renderer
  (`renderer/`), the built runtime (`dist/zr-runtime.js`), React's UMD builds
  with their licence (`vendor/react-18.3.1/`) and the core's `sucrase` (a
  production dependency). `smoke-renderer.ts` R10 checks this on a `--dir`
  build and renders a graphic with it (docs/TESTING.md); CI runs it on Linux
  and on Windows.
- The `afterPack` hook (`apps/desktop/build/afterpack.cjs`) runs
  `node scripts/check-no-remotion.mjs <appOutDir>` on every build, `--dir`
  included, and fails it on any Remotion package, add-on-only package, headless
  shell or core `src/`, or a missing or changed copy of Remotion's licence.
  `node scripts/check-no-remotion.mjs --self-test` checks its rules.
- On Windows, electron-builder's `winCodeSign` archive contains macOS symlinks
  that can't be created without Developer Mode/admin. If extraction fails,
  pre-extract it once into
  `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\` (the two
  failed `.dylib` symlinks are macOS-only and unused on Windows).

## Licensing rules for dependencies

This project is GPL-3.0 and must stay free for everyone to build on. When adding
dependencies — **especially ML models** — only permissive licenses are allowed:

- ✅ MIT / Apache-2.0 / BSD
- ❌ **AGPL** (e.g. Ultralytics YOLO) or non-commercial / research-only weights

FFmpeg is invoked as an external process (never linked), so its GPL/LGPL
components don't affect our license.

**One accepted exception:** Remotion (motion graphics) is *source-available*, not
OSI open-source, and is a *linked* dependency. It is deliberately isolated to
`packages/core/src/motion/render.ts` so it can be swapped for a
Puppeteer/Playwright renderer. Don't add new source-available/commercial deps
without the same isolation + a clear reason. Every bundled or downloaded
component must be listed in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

The paragraph above comes from the original project and is kept as written.
For the ZedMix changes, [`NOTICE`](NOTICE) adds an explicit GNU GPL section 7
permission to link with Remotion.

### Remotion is a devDependency only

No installer ZedMix conveys may contain Remotion. Users install it
themselves as the graphics add-on, under Remotion's own license, and the core
loads it only from there (or, in a source checkout, from `AIVE_REMOTION_ADDON`).
So:

- `remotion`, `@remotion/*`, `react` and `react-dom` are `devDependencies` of
  `packages/core`. Never move them back to `dependencies`, and never add a
  package to `apps/desktop`'s `dependencies` that only the add-on uses (esbuild,
  webpack, `@rspack/*`, ...).
- `node scripts/check-no-remotion.mjs <appOutDir>` (run by the `afterPack` hook)
  fails a build that holds such a package. It allows the packages the shipped
  code shares with the add-on (react, ws, cross-spawn, ...): it compares
  `name@version` with the add-on-only list in
  `packages/core/src/motion/addonlock.ts`.
- **The add-on drift guard.** `addonlock.ts` pins every package the add-on
  installs, generated from the root `package-lock.json` by
  `node scripts/gen-graphics-lock.mjs`. A dependency update that changes the
  add-on's package set (even a shared package that moves Remotion's copy to
  another folder) changes the add-on's fingerprint, and
  `node scripts/gen-graphics-lock.mjs --check` (CI and the release job) then
  fails and lists what changed. `--accept-addon-change` accepts the new
  fingerprint, and that makes **every user update the add-on** after the next
  release (an update downloads only the changed packages). So prefer to leave
  the add-on's packages unchanged between deliberate Remotion upgrades: undo
  the lock change, or update only packages outside the add-on.

## The clean-room runtime (`packages/motion/cleanroom`)

ZedMix's motion renderer runs a runtime compatible with Remotion's API that
was written in a clean room, from Remotion's public documentation only
([`docs/MOTION_RENDERER.md`](docs/MOTION_RENDERER.md), "The clean room"). To
keep it clean:

- Only a clean-room session changes `packages/motion/cleanroom/runtime/`,
  `packages/motion/cleanroom/test/` and `packages/motion/cleanroom/NOTES.md`.
  Never edit, move, reformat or regenerate them in a normal change, a typo
  included; put wiring around them (`packages/motion/renderer`,
  `packages/motion/scripts`, `packages/core/src/motion`).
- `packages/motion/cleanroom/CLEANROOM.lock` lists the sha256 of each of
  those files. `node scripts/check-cleanroom-lock.mjs` fails on a changed,
  added or deleted file; CI runs it before the install.
- When the runtime must behave differently, open an issue that describes the
  observable behaviour you need (which file, what it should do, why), with no
  code from Remotion. A clean-room session makes the change and regenerates
  the lock.
- Do not read Remotion's source if you will write runtime code, and never paste
  Remotion code or text from it anywhere in this repository.

## Style

- TypeScript everywhere, `strict` mode.
- Keep the core free of UI/AI concerns; keep transports (MCP, WS) thin.
- No placeholders — every contribution should actually work end-to-end.
