# Setup & Testing Guide

A complete, do-it-yourself walkthrough to verify **every** feature of
SynthCut before you make it public. It covers three layers:

1. **Automated smoke tests** — the fastest way to confirm the whole pipeline
   works (each one does a *real* FFmpeg render). Start here.
2. **Manual UI testing** — drive the editor by hand in the desktop app.
3. **AI testing** — the real point: let Claude Desktop operate the editor over
   MCP, including the motion-graphics self-correction loop.

Plus how to test the **packaged installer** offline.

> Platform note: commands are shown for **Windows PowerShell** (your setup). The
> `npx tsx …` smoke commands are identical on macOS/Linux.

---

## 0. Prerequisites (one time)

| Need | Check | Install |
|---|---|---|
| Node.js ≥ 20 | `node --version` | https://nodejs.org |
| FFmpeg + ffprobe on PATH (4.4, 7.1, 8.0, 8.1 or 9.0 — see [FFmpeg versions](#ffmpeg-versions)) | `ffmpeg -version` | `winget install Gyan.FFmpeg` |
| (AI testing) Claude Desktop | — | https://claude.ai/download |

Everything else (whisper.cpp + model, YuNet model, Remotion's headless Chrome)
**auto-downloads on first use** and caches under `~/.aive`. The first run of
captions / auto-reframe / motion graphics will pause to download — that's normal
and happens only once.

---

## 1. Build

From the repo root:

```powershell
npm install
npm run build      # builds @aive/core, @aive/mcp, and the desktop renderer
```

If `npm install` ever leaves a tool half-installed (npm occasionally does this),
just run `npm install` again.

---

## 2. Generate test media

A couple of throwaway clips + an audio file are enough for most tests. Create a
`scratch/` folder and generate them with FFmpeg:

```powershell
mkdir scratch -Force
ffmpeg -f lavfi -i testsrc=size=1280x720:rate=30:duration=6 -f lavfi -i sine=frequency=440:duration=6 -shortest -pix_fmt yuv420p -y scratch/a.mp4
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30:duration=5 -f lavfi -i sine=frequency=330:duration=5 -shortest -pix_fmt yuv420p -y scratch/b.mp4
ffmpeg -f lavfi -i "sine=frequency=220:duration=20" -y scratch/music.wav
```

For **caption** testing the smokes use real speech from the checked-in,
public-domain `packages/core/scripts/fixtures/jfk.wav` (the whisper.cpp
sample); pass another spoken-word WAV to `smoke-captions.ts` to try your own.

The auto-reframe and J/L-cut smokes synthesize / download their own media, so
you don't need to prepare anything for those.

---

## 3. Automated smoke tests (fastest "test everything")

Each command runs a real render end-to-end and prints `... SMOKE TEST PASSED` (or
fails loudly). Run them from the repo root. **Paths must be absolute or relative
to the repo root**, and smoke args must be absolute — the examples below resolve
from `scratch/`.

```powershell
# Fast — no media, no FFmpeg, pure logic. Run these first (instant).
# smoke-composite imports @aive/core/effects from core's dist/, so build first.
npx tsx apps/desktop/scripts/smoke-composite.ts                        # compositor plan: z-order, transitions, fades, keyframes, mute/hide, effect previews (CSS, vignette, bypass, keys), speed ramps (shared curve, a clip ends on its footprint, a paused frame is the export's, frame steps stay on the grid and a cut shows one clip, the curve editor's out-of-clip points, ramped bleep mirror), blend modes + masks in the plan, audio-effect Web Audio plan + linked carrier + live route (+ the voice-worklet route: dry until loaded, rebuilt, stopped, render-only when it fails), the WebGL2 pass plans (order, bypass, keys, uniforms, stable effect-id keys, the lens zoom pass, the denoise tables, fixed-kernel flags, fidelity), the colour maths vs graph.ts, and the status line's job state (job events → progress text, Cancel → cancel_job, no error after a user cancel, cleared on done/failed)
npx tsx packages/core/scripts/smoke-clip-tokenizer.ts                  # CLIP text tokenizer (semantic-search input)

# Web shell end-to-end: serves the UI, Host/token/path guards, picker listing,
# import + stream through the core, stopping the core it started, and a clear
# refusal of a port that browsers block (ERR_UNSAFE_PORT, e.g. 5060) for the
# shell or the core (needs the build)
npx tsx apps/desktop/scripts/smoke-web.ts
npx tsx apps/desktop/scripts/smoke-savename.ts                       # save picker file-name rule (typed extension kept, filter switches) + the export preset for a typed .webm/.mov/.mp4 and its notice; Electron's save-rules.cjs (same rule, overwrite re-ask, close guard); S/Delete after a split; path bar vs a late listing

# Skill installer: `synthcut migrate` finds and removes only what Relo's SynthCut
# left (MCP server "ai-video-editor" that runs SynthCut's MCP server, skill
# "video-editor-pro"), keeps formatting, backs files up, asks first; temp HOME
# dirs, never the real one
npx tsx packages/core/scripts/smoke-legacy-migrate.ts

# Security: session-token auth (HTTP/WS) + /file allowlist, HEAD /file and its ETag (self-synthesizes media)
npx tsx packages/core/scripts/smoke-security.ts

# Untrusted .aive / .otio: crafted ids stay inside the data dir, URL/protocol media
# is refused on load/import (and a refused open leaves the open project, its path,
# dirty state and undo history unchanged), the executor refuses protocol inputs and
# filters that open their own source, and FFmpeg gets -protocol_whitelist
# file,pipe,fd on every input (127.0.0.1 listener + sandbox, self-synthesizes media).
# Accepted risk: UNC (\\server\share) and //host/share media paths are accepted
# for NAS workflows, so on a Windows host a crafted project can make probe,
# thumbnail and render open an SMB connection to the named host, which can send
# the user's NTLM credentials.
npx tsx packages/core/scripts/smoke-safepath.ts

# Frame picking at exact frame boundaries: get_frame(n / fps) shows frame n; GET /frames
# (the preview's trail / denoise warm-up) returns exactly the source frames asked for,
# cropped and scaled, with the token, the /file allowlist and its number checks (self-synthesizes)
npx tsx packages/core/scripts/smoke-frames.ts

# Jobs: background export with progress, cancel_job (partial file deleted), crash-recovery surfacing
npx tsx packages/core/scripts/smoke-jobs.ts

# Storage clean-up of baked/ + proxies/ (auto-trash, restore on load; temp dirs,
# no downloads): files named by the open project, its undo history, a saved .aive
# outside the data dir, an autosave or a longer string survive; old orphans (and a
# stale .work dir) go to .trash/, a young one stays; a file outside the data dir,
# a sibling baked2/ dir and symlinks are never touched; storage_report's dry run
# == what clean_up_storage moves; automatic runs skip files older than the
# known-projects list; nothing runs while a job runs; load() of a copied .aive
# moves its files back out of the trash; trash retention + emptyTrash; a corrupt
# projects.json; a symlinked proxies/; the debounced auto run; a known project
# that is missing (unplugged drive), unreadable, half-written or hangs pauses
# clean-up until it is back, the retention period passes or forgetMissing; an
# unreadable autosave pauses too; save() never waits for a hung read; a trashed
# file a project names again is moved back, never deleted; emptyTrash keeps the
# pre-tracking files it moves; remember_projects; percent-encoded file: URLs and
# relative paths count as references; the automatic run is awaited, not slept on
# (autoRunDone / runScheduledNow); a trashed file keeps its mtime and gets it
# back on restore (trash times in .trash/.index.json, an unrecorded entry counts
# as trashed when first seen); an unreadable known project is logged once per
# file state, also across restarts; two cores on one data dir (a second engine,
# a killed child process, a stale or unreadable run file, a dead pid, dispose)
# keep each other's undo-history files; library bakes no state uses leave the
# library (imported media never), remove_unused_media (dry run, generated only,
# includeImported, undo) and storage_report.libraryBakes
npx tsx packages/core/scripts/smoke-storage.ts

# Segment render cache: incremental previews (tail edit re-renders only the tail),
# single-segment get_frame, single-pass fallback (self-synthesizes media)
npx tsx packages/core/scripts/smoke-cache.ts

# Loudness normalization on export (ebur128 verification), adjustment layers,
# and the pro-polish set (SRT/VTT round-trip, named markers, drawtext word wrap)
npx tsx packages/core/scripts/smoke-loudnorm.ts
npx tsx packages/core/scripts/smoke-adjustment.ts
npx tsx packages/core/scripts/smoke-polish.ts

# OpenTimelineIO interop: lossless export→import round-trip + foreign OTIO import
npx tsx packages/core/scripts/smoke-otio.ts

# Core editing + render, multi-track compositing, and the full MCP path
npx tsx packages/core/scripts/smoke.ts             scratch/a.mp4 scratch/b.mp4
npx tsx packages/mcp/scripts/smoke.ts              scratch/a.mp4 scratch/b.mp4
npx tsx packages/core/scripts/smoke-multitrack.ts                      # self-synthesizes its own media

# Effects, keys, transitions, LUT/stabilize, color grade, per-clip transform + keyframes
npx tsx packages/core/scripts/smoke-effects.ts     scratch/a.mp4 scratch/b.mp4
npx tsx packages/core/scripts/smoke-transitions.ts scratch/a.mp4 scratch/b.mp4   # + on synthesized frame-index-coded media: the incoming clip of a wipe / fade lands on the modelled frames (FFmpeg before 7 ended an xfade a frame early)
npx tsx packages/core/scripts/smoke-lut-stab.ts    scratch/a.mp4 scratch/b.mp4   # + stabilize options on a synthesized shaky clip
npx tsx packages/core/scripts/smoke-color.ts       scratch/a.mp4 scratch/b.mp4
npx tsx packages/core/scripts/smoke-transform.ts   scratch/a.mp4 scratch/b.mp4
npx tsx packages/core/scripts/smoke-key.ts                             # colorkey/chromakey+despill/lumakey, color "auto", chromakey output identical for any FFmpeg thread count; self-synthesizes
npx tsx packages/core/scripts/smoke-registry.ts                        # effect registry: legacy filter strings, FFmpeg accepts every effect, validation, bypass, reorder, vignette amount, lens zoom to fill (no transparent pixel for 30 k1/k2 settings), every effect has a WebGL2 preview; self-synthesizes

# Blend modes + shape masks (lossless exports; self-synthesizes PNG stills and an
# FFV1 yuva420p cutout): every blend mode vs the W3C formula on the decoded
# inputs (prints the max deviation per mode), normal byte-identical (framemd5),
# ellipse/rect/linear/mirror + feather profile + invert, masks following a
# transform and rotation, on a keyed clip, on an alpha clip, on an adjustment
# layer, segment-cache invalidation, undo and validation; `add` leaves frames
# before the layer byte-identical, a blended clip's text stays unblended, and a
# follower-only segment re-renders when the run lead's mode is cleared. ~30 s.
npx tsx packages/core/scripts/smoke-masks.ts

# Text overlays + native keyframe-animated text
npx tsx packages/core/scripts/smoke-text.ts        scratch/a.mp4 scratch/b.mp4
npx tsx packages/core/scripts/smoke-animtext.ts                        # synthesizes its clip; or pass one

# Audio: background music + ducking
npx tsx packages/core/scripts/smoke-music.ts       scratch/a.mp4 scratch/b.mp4 scratch/music.wav

# Captions (Whisper), subject-aware auto-reframe (YuNet), J/L cuts
npx tsx packages/core/scripts/smoke-captions.ts                        # fixtures/jfk.wav; or pass a speech WAV
npx tsx packages/core/scripts/smoke-reframe.ts
npx tsx packages/core/scripts/smoke-jlcut.ts

# AI background removal for people (RVM): cutout over a red V1, native + downscaled
# paths, matte-only bake (FFV1 gray + the span's audio), VP8/alpha preview proxy,
# inference in a worker thread (event-loop lateness vs the same job forced onto the
# main thread with AIVE_RVM_INLINE=1), generate_proxy keeps alpha, storage GC sees the
# matte + proxy, undo, prompt cancel (downloads a portrait + the 15 MB model; pass a
# local photo/clip with a person to skip the portrait download)
npx tsx packages/core/scripts/smoke-matte.ts [portrait.jpg | clip.mp4]
# Matte-backed cutouts, offline (no model: remove_background's internal stub matte):
# the matte-only bake in a worker, then the same 17 edits (trim, split, split +
# dissolve, speed 0.5/1.5/2, ramp, reverse, freeze, smooth slow motion, luma key,
# mask, transform, effects + fades, keyframes, blend mode) on the new cutout and on
# colour+alpha FFV1 references, exported losslessly over red and over blue: bit-exact
# against a reference with the source's timestamps, and against an old-style .mkv
# cutout wherever its millisecond timestamps / AAC-delayed start don't decide the
# frame (those differences are printed). Plus odd-size 24 fps footage on a 30 fps
# project, generate_proxy alpha (reuses the baked preview, rebuilds a missing one),
# thumbnails / key colour / scenes, refusals,
# segment keys, storage GC, the AIVE_RVM_INLINE=1 fallback and cancel. ~3 min.
npx tsx packages/core/scripts/smoke-cutout.ts
# Auto-bleep: matcher, synthesized SFX, bleeps that follow their clip (move, trim,
# split, speed, audio slip), set/add/remove_bleep, undo — all checked on exported
# audio (self-contained: synthesizes its own media, injects a fake transcript).
# smoke-composite.ts checks the renderer's bleep expansion against the core's.
npx tsx packages/core/scripts/smoke-bleep.ts
# Per-clip audio effects + one-click voice tools: synthesizes speech-like audio
# (formant voice, loud/quiet phrases, pink-noise floor, 40 Hz rumble, s-bursts)
# and measures exports: every effect keeps sync + length, noise reduction /
# rumble cut / presence EQ / de-esser / compressor / limiter / normalize (±1 LU)
# / pitch (rubberband + fallback) / enhance_voice, speed 2, bypass, bleeps with
# effects, linked audio (also after a split), mono/stereo/quad/5.1 soft clip,
# exports at speed 0.5–3 that must finish, video-only staging without the
# loudness pass, undo, segment-cache key (self-contained).
# smoke-composite.ts checks the matching Web Audio preview plan.
npx tsx packages/core/scripts/smoke-voice.ts
# Live pitch / robot preview (the voice AudioWorklet): the worklet DSP in Node —
# pitch ±12/+4 st on a 440 Hz tone (dominant 880/220/554 Hz, level, length),
# robot == the export's filter after the latency: sample for sample on FFmpeg
# 4.4/5.0, within −55 dB on 5.1+ (rebuilt maths), pitch vs rubberband spectra on a
# voice-like signal — then the REAL audiograph.ts chain in your headless
# Chromium (OfflineAudioContext at 48 kHz) from a file:// page and an http://
# page: +12 st → ≈ 880 Hz with the duration unchanged, robot buzz at 187.5 Hz,
# a strict CSP falls back to dry without errors; and the built renderer
# carries the worklet source. Needs FFmpeg, core + renderer built, and
# playwright-core + a Chromium (as parity-gl; SYNTHCUT_SKIP_BROWSER=1 skips).
npx tsx packages/core/scripts/smoke-voicefx.ts

# FFmpeg version compatibility (self-contained; run it against every build you
# ship — see "FFmpeg versions" below): version parsing and the startup warning,
# `-filters` parsing (2 flag columns from 8.0), a 140 KiB filtergraph through a
# file with -filter_complex_script / -/filter_complex (9.0 has only the second,
# 4.4 only the first) and the fallback between them, alpha-mode retagging (8.1+),
# afftdn latency + strength (rewritten in 5.0), heavy noise reduction (anlmdn
# crashes 9.0), the robot against a model of 4.4's afftfilt (rewritten in 5.1)
# plus an impulse that checks which afftfilt this build has, vibrato's primed
# delay line, vibrance's pinned luma weights (8.0 swapped the defaults), a
# stereo export mix after a mono first clip, the last frame of clips with
# an alpha-keeping effect (4.4 – 6.1 dropped it), and keyed speed-ramped clips
# (footage and matte cutout) against the ramp model.
npx tsx packages/core/scripts/smoke-ffcompat.ts

# Time effects: freeze_frame (ripples the timeline + linked audio; ripple 'all'
# moves other tracks and markers, 'none' overwrites), chunked frame-exact
# reverse_clip (and its un-reverse; the linked detached audio is reversed with it,
# a J-cut head becomes an L-cut tail), smooth_slow_motion (blend + optical flow, no
# duplicated frame even at the end, exact frame count at 0.25x, the plain linked
# audio moves onto the bake, a J/L partner keeps its speed ratio) — self-contained,
# verified by decoding frame-index-coded media and a chirp
npx tsx packages/core/scripts/smoke-time.ts

# Cut rounding at CONSTANT speeds: split_clip at every frame at 0.25x … 4x (halves
# butt, the right half ends where the clip did; 1x–4x exactly where asked),
# cut_range on a grid (pieces butt, the next clip closes up, one-frame heads /
# tails kept, no gap), two-track ripple_delete_ranges, exports of pieces spread
# one black frame apart (exact footprints and frames), and freeze_frame holding
# exactly the exported frame at 0.5x–4x — also on a 29.97 fps source with a
# 1/30000 timebase; get_frame shows the exported frame anywhere in a frame period
# around 1x | 3x | 0.5x cuts, from a cached segment and from a full preview
# (self-contained, frame-index-coded media)
npx tsx packages/core/scripts/smoke-cuts.ts

# Locked tracks: every edit that would change or move a clip on a locked track —
# direct (trim, move, split, effects, remove, add, cut_range) or by a ripple (speed
# change 'all', a linked clip on it, freeze 'all', ripple_delete_ranges, transcript
# cuts) — is refused naming the track with the project, undo and redo history
# untouched; ripple 'none' / 'track' edits that leave it alone, renaming, an fps
# change and removing the track still work; bakes refuse before any work
npx tsx packages/core/scripts/smoke-locks.ts

# Speed ramps (curve speed): the shared source↔timeline mapping (speed.ts —
# constant speed exactly as before, round trips, monotonic, ∫ds/speed), every
# preset exported with frame-index-coded media (each frame = the mapped source
# frame, exact footprint), audio stretch (length within a frame, 440 Hz pitch
# kept, click-free joins, bursts on the curve) and mute, bleeps on the mapped
# words, split / cut_range / trim keep the curve, cuts in a slow section snap to
# their source frame (pieces and the next clip stay butted, tracks stay in sync),
# splits add up EXACTLY at every split point of every preset and of flat 0.1x /
# 10x / 2x / 4x curves, pieces spread one black frame apart render exactly their
# footprints and the modelled frames, freeze holds exactly the exported frame (also
# on exact half-frame ties), locate / transcript cuts, reverse mirrors the curve
# and keeps the footprint, OTIO, undo, long filtergraphs passed from a file
# (self-contained). Every frame check is exact (no ±1).
# RAMPS_BASELINE_REF=<git ref> also checks that constant-speed timelines emit the
# exact ffmpeg command of the graph builder at that ref (byte-identical renders).
# smoke-composite.ts checks the preview's ramp mapping and the ramped bleep mirror.
npx tsx packages/core/scripts/smoke-ramps.ts
RAMPS_BASELINE_REF=dd38598 npx tsx packages/core/scripts/smoke-ramps.ts

# Speed changes ripple (CapCut-style): set_clip_speed 2x / 0.5x, every ramp preset,
# clear_speed_ramp, clear_clip_effects and an audio-only ramp change move the
# clips after the clip by exactly the change in length (butted stays butted, gaps
# and a cross-dissolve overlap are kept), the detached linked audio gets the same
# speed / curve and its later clips move too; ripple "track" leaves unlinked
# tracks and markers alone, "all" moves the title and late markers (a straddling
# music bed stays, listed in notMoved), "none" moves nothing; one undo restores
# everything; a speed-up shorter than its transition is refused; freeze halves,
# a linked mic recording (curve moved by its sync offset), a J-cut head, smooth
# slow motion and reverse; a later clip's own linked mic moves with it (freeze too);
# L-cut tails / J-cut heads changed from either side stay in sync (trimmed to fit,
# reported in splitEdits) — and an L-cut tail checked BY EAR after 0.5x / 2x /
# bullet / montage (a chirp whose pitch is its source time: the sound under the
# picture plays the moment shown, the tail goes on from there, the next audio
# clip is never played over); a straddler holds the clips joined to it; split pairs
# and collisions are refused; exports have no black gap after montage and no
# overlap after bullet (self-contained, frame-index-coded media).
npx tsx packages/core/scripts/smoke-ripple.ts

# Text-based editing: word-level transcripts, delete_transcript_ranges,
# tighten_talk, edit_by_transcript (self-contained — uses the checked-in fixture)
npx tsx packages/core/scripts/smoke-textedit.ts

# Media intelligence: transcript index/search, visual + CLIP semantic search, audio sync
npx tsx packages/core/scripts/smoke-media.ts       scratch/a.mp4 scratch/b.mp4

# AI tool surface: inspect_timeline vision loop + get_transcript
npx tsx packages/core/scripts/smoke-toolsurface.ts scratch/a.mp4 scratch/b.mp4

# Export presets (containers / H.264-H.265-VP9 / quality) and proxy media (fast preview)
npx tsx packages/core/scripts/smoke-export.ts      scratch/a.mp4
npx tsx packages/core/scripts/smoke-proxy.ts                           # self-synthesizes a "4K-ish" source

# Remotion motion graphics
npx tsx packages/core/scripts/smoke-motion.ts
```

### The desktop app in Electron (run by hand)

`smoke-electron.mts` launches the real Electron app (`apps/desktop`) with
Playwright's `_electron` and drives it: a relative and an absolute
`AIVE_DATA_DIR` (the launcher gives the core an absolute path), import with the
native dialog stubbed, Add to timeline, Play (the preview's decoder pool seeks
only a few times and has a frame to draw on most animation frames: no seek
thrash, no black preview while playing), split then Delete with no piece picked
(no stale clip id),
the Project menu and **Storage…**, the native save dialogs (the same extension
rule as the web picker in `src/savename.ts`, a second overwrite question when
an extension was added, the preset's container listed first), exports (no
extension typed → `.mp4`; `.webm` typed with an MP4 preset → VP9 WebM), and the
unsaved-changes close guard (Save → Save As cancelled keeps the window open;
Save → saved, then quit; the core it started exits). It fails on renderer
console errors. The app runs with its own profile (`--user-data-dir` in the
test folder), so your SynthCut profile and its recent projects are left alone.

```bash
node node_modules/electron/install.js        # once, if node_modules/electron/dist is missing
xvfb-run -a npx tsx apps/desktop/scripts/smoke-electron.mts
# a packed build instead of the source tree:
(cd apps/desktop && npx electron-builder --dir --linux)
SYNTHCUT_APP=$PWD/apps/desktop/build/dist/linux-unpacked/synthcut-desktop xvfb-run -a npx tsx apps/desktop/scripts/smoke-electron.mts
```

- Needs `npm run build`, FFmpeg on PATH, a display (`xvfb-run` gives one
  without opening a window) and playwright-core (found like `parity-gl.mts`
  does; `PLAYWRIGHT_CORE=<dir>` overrides).
- The core gets a free port unless `AIVE_PORT` is set. Chromium, and so
  Electron and every Chromium-based browser, refuses some ports
  (`ERR_UNSAFE_PORT`: 5060, 5061, 6000, 6665–6669, 10080 and others): the app
  and the web shell now stop with a clear message instead of an "Offline"
  window when the core is on one.

### Live preview vs export parity (WebGL2, run by hand)

The preview runs each layer's look — colour grade, curves, LUT and every
effect, keys included, in stack order — through a WebGL2 pipeline
(`apps/desktop/src/gl/`) whose shaders port FFmpeg 4.4's filters. This script
measures how close it is: for every registry effect at its default and one
non-default setting, plus eq / colour wheels / hue / curves / a generated
17³ `.cube` LUT and a few stacks (YUV chains, keys between effects, fused
per-pixel ops, a pillarboxed frame with transparent padding), it renders a
synthetic 320×180 test pattern through the real GL pipeline in a headless
Chromium and through the export's own per-clip FFmpeg chain (graph.ts,
with a lossless RGBA tap instead of the final 4:2:0 encode), then prints
max / mean / p99 of the per-channel difference (alpha, and colour × alpha).

A second table runs the REAL export on 4:2:0 footage: a yuv420p clip through
the whole graph (clip chain, the yuv420p overlays, `format=yuv420p`), decoded
back to RGB, against the preview of the same decoded frame sent through the
same final 4:2:0 steps — so it catches an effect that FFmpeg ran on
subsampled chroma (FFmpeg picks a filter's pixel format from the filters
after it; graph.ts pins RGBA after every effect stack so that never
happens). It covers the effects whose filters take any pixel format (blur,
detail, lens, grayscale, invert, pixelate …), stacks, adjustment layers and
the grain's statistics as the export shows them.

A third section checks the temporal effects' clock and GPU memory: trails
decay per SOURCE frame like the export's lagfun (2× speed — reading which
source frame the export shows from a marker pixel — and a held frame at 1/3
speed), survive a reorder of the stack and a processing-size change, start
over when an enabled effect moves ahead of them, and a paused frame whose
history lacks earlier frames (a seek, that reorder) matches the export once
the warm-up re-runs them (the real `gl/warmup.ts` against a mocked `/frames`:
a scrub warms once where it stops, a failed or one-frame-short decode is not
adopted or retried for the same frame and look, playback aborts a decode in
flight, over the byte cap only the last frames are warmed, and warmed frames
keep their timeline frame); 50 new eq / curves tables on one layer create no
texture; a `.cube` rewritten in place (new ETag through a mocked `/file`)
shows the new table, also when it changes while nothing draws (a paused
preview), and 12 LUTs used in turn leave at most 8 cached; a rewrite that
fails to parse is read once and reported stale, a LUT whose first read
failed recovers once the file is fixed, and a table over the byte budget is
refused before it is parsed. A fourth section drives the preview's decoder
pool (`mediapool.ts`) on a counter clip with sound: paused at n / fps it
shows frame n, and playback settles after a seek or two (no seek thrash).
The whole run happens with
`EXT_color_buffer_float` hidden: the pipeline keeps its float intermediates
in RGBA32UI targets, so it needs nothing beyond WebGL2.

```powershell
npx tsx apps/desktop/scripts/parity-gl.mts                 # both parity tables (~2 min)
npx tsx apps/desktop/scripts/parity-gl.mts --bench         # + ms/frame: GL (full, half, quarter resolution) vs the old CSS path, 2 layers at 1280×720
npx tsx apps/desktop/scripts/parity-gl.mts --only blur,glow --dump   # some effects; keep the PNGs (ffmpeg / gl / diff×16)
npx tsx apps/desktop/scripts/parity-gl.mts --only 420      # just the real-export (4:2:0) table
npx tsx apps/desktop/scripts/parity-gl.mts --only temporal # just the temporal clock / GPU memory section
npx tsx apps/desktop/scripts/parity-gl.mts --only mediapool  # just the <video> pool section
```

- Needs FFmpeg on PATH, `npm run build` (the page imports core's dist), and
  **playwright-core** plus a Chromium. It looks for playwright-core in
  `node_modules` and the npx cache (`~/.npm/_npx/*/node_modules`), and for a
  Chromium in Playwright's browser cache (`~/.cache/ms-playwright`, or the
  Windows / macOS equivalents). Override with `PLAYWRIGHT_CORE=<dir of
  playwright-core>` and `PLAYWRIGHT_CHROMIUM=<chrome binary>`.
- Headless Chromium runs WebGL2 on SwiftShader (software), which is exact but
  slow; `--bench` numbers on a real GPU are far lower.
- Driving the app itself in headless Chromium (Playwright): a `fetch` body read
  through `getReader()` is reported as `requestfailed net::ERR_ABORTED` even
  when it is read to the end, so `/frames` entries (the paused trail / denoise
  warm-up) in such a failure list are noise. On a heavily loaded machine one
  animation frame can take seconds, and the playhead (wall-clock time) jumps
  with it: judge playback there by seeks and `readyState`, not smoothness.
- Pass thresholds follow each effect's `fidelity` in the registry: **exact** =
  max ≤ 3 levels and mean ≤ 1 (≤ 8 and ≤ 1 in the 4:2:0 table, for the
  rounding at hard colour edges); **close** = p99 ≤ 8 (grain, and trails and
  denoise, whose history the preview builds from where playback started, and
  re-runs from the clip's first frame when paused);
  **approx** would only be reported (no effect is approximate now). Film grain is random, so it compares the noise's mean and
  standard deviation instead, as the export shows it (its 4:2:0 output
  averages the grain's colour over 2×2 pixels; the preview models that). It
  also checks that a lost WebGL context makes the pipeline step aside (the
  preview uses its CSS fallback) and renders identical bytes after the
  restore, and that a still larger than the GPU's `MAX_TEXTURE_SIZE` renders
  like a small one (its crop goes through a scaled 2D canvas). Exits non-zero
  on a failure.
- On a software WebGL renderer the preview lowers the looks' processing
  resolution while playing (`gl/governor.ts`): half, and a quarter when
  frames with a look still come slower than about 16 fps; paused frames (and
  a GPU) always use full resolution. `--bench` shows all three.
- Per-viewer switch: `localStorage["synthcut.preview.gl"] = "off"` in the
  app's devtools forces the CSS fallback preview (to compare).

### FFmpeg versions

SynthCut supports FFmpeg **4.4, 7.1, 8.0, 8.1 and 9.0**
(`TESTED_FFMPEG_VERSIONS` in `packages/core/src/ffmpeg/version.ts`). The core
logs a warning at startup for any other version, and
`apps/desktop/scripts/prepare-bundle.ts` refuses to stage one unless
`AIVE_BUNDLE_ALLOW_UNTESTED_FFMPEG=1` is set (`smoke-bundle-ffmpeg.ts` checks
that gate; with `AIVE_BUNDLE_SMOKE_BUILDS=<dir>` holding
`<dir>/{6.1,7.1,8.1}/bin/` static builds it also runs it on them).

Every smoke and `parity-gl.mts` use `AIVE_FFMPEG` / `AIVE_FFPROBE`, so you can
run any of them against another build. Static Linux builds come from the
BtbN/FFmpeg-Builds GitHub releases (`ffmpeg-n<version>-…-linux64-gpl-<version>.tar.xz`
with `checksums.sha256`):

```bash
export AIVE_FFMPEG=/opt/ffmpeg-9.0/bin/ffmpeg AIVE_FFPROBE=/opt/ffmpeg-9.0/bin/ffprobe
npx tsx packages/core/scripts/smoke-ffcompat.ts      # the version-specific checks, ~1 min
npx tsx packages/core/scripts/smoke-voice.ts         # and any other smoke, the same way
```

Differences between the versions, and what the core does about them:

| Difference | Versions | What the core does |
|---|---|---|
| `-filter_complex_script` removed (deprecated from 7.0) | 9.0 | A filtergraph over 16 KiB goes to a file with `-/filter_complex` from 7.0 and `-filter_complex_script` before. If the option is unknown, the core retries once with the other option. |
| `ffmpeg -filters` prints 2 flag columns, not 3 | 8.0+ | The parser accepts both. Before the fix, rubberband was never found, so pitch effects used the lower-quality fallback. |
| Alpha modes (straight or premultiplied) are negotiated per link | 8.1+ | The executor retags frames around `premultiply` / `unpremultiply` with `setparams`. Without this, FFmpeg undid them: an `add` blend at 60 % opacity came out at 100 %, and trails, glow and rgbsplit darkened translucent pixels. |
| afftdn was rewritten: 25 ms output delay, a different noise-floor scale, noise tracking that barely works | 5.0+ | Each pass is trimmed by its delay, and the noise floor offset is recalibrated with tracking off. Noise reduction and enhance_voice match 4.4 within about 1.5 dB on smoke-voice's speech. |
| afftfilt was rewritten: sqrt-Hann on input and output, win_size − hop latency. The robot came out quieter, duller, 8–32 ms late, and lost isolated transients. | 5.1+ | The robot runs afftfilt with `win_func=rect`, and its expression rebuilds 4.4's Hann spectrum from the neighbouring bins. The latency is padded and trimmed off, the 3 pre-roll frames are gated, and the input is padded to a whole hop (4.4 rounds its output up to one, so a robot after *normalize* keeps its tail). It matches 4.4 within −65 dB at 0.0 dB level, and the live preview matches it too. |
| `anlmdn` crashes on any input | 9.0 | Probed once at run time. *Reduce noise* with *Extra pass* skips the non-local-means stage. |
| `acrossfade` returns a cut-short or empty stream at random when its inputs are short | 7.x | Speed-ramp chunks and transitions are joined by fading the pieces and mixing them at their sample positions. |
| `vibrance` defaults: red and blue luma weights swapped | 8.0+ | The weights from 4.4 (which the preview shader uses) are passed explicitly. |
| A `scale` in `-filter_complex` without `flags` is bilinear in 4.4 and bicubic from 5.0 | 5.0+ | The motion-graphics scale names `flags=bilinear`. |
| The export mix took the first clip's channel layout up to 5.x (a mono first clip made the export mono), and is stereo from 6.1 | all | The mix is pinned to stereo. |
| A two-input filter (`blend`, `alphamerge`) ends its stream with no end time, so the speed step's `fps` dropped the clip's last frame (two at 0.5x): a black frame at each cut after a clip with a key, colour grade, sharpen, denoise, grain, glow or another alpha-keeping effect, and at the end of the export | 4.4 – 6.1 | Such a clip gets two transparent padding frames before its effects (a speed ramp: copies of its last frame), where the stream's end is still exact, and is cut to its own length. A clip whose video ends before its length keeps that end. Every version gives the same frames. |
| `vibrato` reads its delay line before it writes it (leftover memory: clicks, ±inf) | 4.4 – 9.0 | *Underwater* primes the delay line with 10 ms of silence and trims it off. |
| libvidstab's default camera path ("opt") is now an L1 optimizer that ignores zoom "none" | static builds from mid-2026, any FFmpeg version | Stabilize passes `optalgo=gauss`, which gives the same output as the old default. |

Known differences that remain:
- swscale's RGB ↔ YUV conversions differ by 1–2 levels between 4.4 and 5.0+.
  7.1, 8.x and 9.0 give identical output.
- `parity-gl.mts` with 7.1: one case (`stack: colorkey → blur → vignette`)
  shows a max of 3.5 against the exact threshold of 3. 8.0, 8.1 and 9.0
  pass every case.
- Decoded alpha (ProRes 4444, PNG, FFV1 yuva420p, VP9 alpha) composites
  identically on 4.4, 8.0, 8.1 and 9.0.

Full offline matrix (every `smoke*.ts`, plus composite, savename, web shell,
MCP, parity and the ramps baseline), 2026-10-12:

| FFmpeg build | Before the version fixes | After |
|---|---|---|
| 4.4.2 (Ubuntu 22.04) | 38/38 | 39/39 |
| 7.1.5 (BtbN, 2026-07-31) | voice, ramps (incl. the ramps baseline) and parity (the one case above) failed | 38/39: parity, the one case above |
| 8.0.1 (BtbN, 2026-02-28) | voice and parity (vibrance) failed | 39/39 |
| 8.1.3 (BtbN, 2026-10-12) | voice, masks, lut-stab and parity failed | 39/39 |
| 9.0.2 (BtbN, 2026-10-12) | 34/38: masks, voice, lut-stab, parity | 39/39 |

On 9.0, the download-dependent smokes motion, matte, reframe, captions and
animtext also pass (captions needs `jfk.wav`, animtext a clip argument). The
"before" runs for 7.1, 8.0 and 8.1 covered the suites that failed on 9.0, and
smoke-ramps.

What to expect:
- The **first** captions run downloads whisper.cpp + the `base.en` model (~150 MB);
  the first reframe run downloads the YuNet model; the first `smoke-media` run
  downloads the CLIP semantic-search model (~small, into `~/.aive/clip`); the
  first motion run downloads Remotion's headless Chrome (~150 MB). Subsequent runs
  are fast. (Set `AIVE_CLIP_DISABLE=1` to skip CLIP and use the model-free
  perceptual index instead.)
- Every script exits non-zero on failure, so you can also run them in a loop and
  check exit codes.

If all of these pass, the **entire engine and render pipeline is verified** — from
core editing through multi-track compositing, color, transforms/keyframes, media
intelligence, the AI tool surface, and export.

---

## 4. Manual testing in the desktop app

```powershell
npm start
```

The app opens with **Clip Library**, **Preview**, and **Timeline** panels, and a
`core :<port>` indicator (top-right). Work through this checklist:

| Area | Try it | Expect |
|---|---|---|
| Import | Click **Import**, pick `scratch/a.mp4` & `b.mp4` | Both appear in the library |
| Build timeline | Add both clips to the timeline | Two clips, total ≈ 11 s |
| Trim / Split | Split a clip; trim its ends | Timeline updates live |
| Reorder | Drag/move clips | Order changes |
| Multi-track | Add a video track; drag a clip onto it above the base | It composites on top (overlay/B-roll layering) |
| Per-track controls | Mute / hide / lock a track; change its volume | Track header reflects it; preview/audio respond |
| Per-clip effects | Use the per-clip controls: speed, volume, fades, color grade, crop | Controls reflect on the clip |
| Transform / keyframes | Move/scale/rotate a clip; add ◆ keyframes to animate position or scale | Motion plays back in the preview |
| Effect stack | **Add effect** (grouped by category) → e.g. Vignette, Blur, Sharpen, Glow, Pixelate; drag their sliders; use the eye (bypass), ↑/↓ (reorder) and × buttons | Every effect previews live (WebGL2) in stack order and matches **Render exact**; Lens distortion fills the frame (no empty corners; **Zoom to fill** 0 brings the transparent corners back); while playing on a software renderer, Sharpen / Detail / Edges / Chroma key / Denoise show a soft **≈** (processed below the export resolution) that goes away when paused; without WebGL2 only the CSS-proxy effects preview and the rest show **Render exact**; a bypassed effect is struck through and drops out of the preview and export |
| Grade / LUT | **Color** grade (brightness, contrast, saturation, gamma); ask the AI for colour wheels / temperature / hue / curves (`apply_color`) and a `.cube` LUT (`apply_lut`) | All preview live and match **Render exact** (the LUT loads through the core's `/file` route) |
| Stabilize | On a shaky clip set **Smoothing** and **Zoom**, then **Stabilize clip** | Busy label "Stabilizing…", then the clip points at a "(stabilized)" bake; undo restores it |
| Keys | Put a gray-, green- or black-background clip on a track above another; **Add effect → Color / Chroma / Luma key** | Background turns transparent in the live preview (colour auto-detected); swatch, **Auto**, **Pick** (eyedropper) and the sliders update it in place; export matches |
| Blend modes | Put a clip on a track above another; in **Transform & animation** set **Blend** to Screen / Multiply / Overlay … | The live preview blends at once; **Render exact** / Export match it (within a few levels) |
| Masks | In the **Mask** group pick Ellipse / Rectangle / Linear / Mirror; drag Feather, Roundness, Width/Height, Rotation; tick **Invert**; drag the ✛ handle on the preview | Only the masked part shows; the mask moves/scales/rotates with the clip's transform; one undo step per change (one per handle drag) |
| Transition | Add a crossfade between the two clips | Overlap shown |
| Text | Add a title / lower-third | Overlay listed on the clip |
| Library search | Switch the search between **Words** and **Visuals**; search the library | Matching clips/moments returned |
| Voice effects | On a clip with speech set **Voice effect** to Chipmunk, Deep voice, Custom pitch or Robot, then play | The live preview plays it (a little delay on that clip only; the pitch voices are marked **Approx.**, Robot is not); **Render exact** plays the export. Opened over plain `http://` from another machine (no AudioWorklet) they show **Render exact** and play dry |
| Remove unused media | Reverse a clip, then delete it; click the library's trash button (or right-click the library) | The strip lists the unused bake; **Remove … from library** drops it (Undo brings it back); ticking the box also removes unused imported files. **Project → Storage…** shows bakes only the library holds |
| Captions | Run **Generate Captions** on a clip with speech | Cues appear after transcription |
| Motion graphic | Use **+ Title card** | A graphic overlay is added after its render |
| Aspect | Switch to **9:16** preset | Canvas changes |
| Preview / Export | **Render Preview**, then **Export** | Plays / writes an MP4 |
| Undo / Redo | Undo a few edits, redo | State steps back/forward |

All of these are the same operations the AI calls, so passing here = the UI layer
is wired correctly.

---

## 5. AI testing with Claude Desktop (the real point)

### 5.1 Connect

Ensure `npm run build` has produced `packages/mcp/dist/index.js`, then connect
**either** client (see [`GETTING_STARTED.md` §4](GETTING_STARTED.md) for full
detail):

- **Claude Desktop:** merge the `synthcut` entry from
  [`claude_desktop_config.example.json`](../claude_desktop_config.example.json)
  into `%APPDATA%\Claude\claude_desktop_config.json` (absolute path to
  `index.js`), then **fully quit and restart** Claude Desktop.
- **Claude Code (CLI):** run it **from the repo root** — the shipped
  [`.mcp.json`](../.mcp.json) registers the server (approve it when prompted, or
  check with `/mcp`). Or `claude mcp add synthcut -- node <abs path to index.js>`.

Optionally open the desktop app (`npm start`) too — every AI edit appears live in
its timeline. If the app is closed, the MCP server runs a headless core and the
app reconnects to the same session when you open it.

You should see the editor tools in your client's tool list (`/mcp` in Claude Code).

### 5.2 A test script (end-to-end)

Paste these to Claude one at a time and watch the timeline (or ask it to
`render_preview` and open the returned path). Replace the import paths with your
`scratch/` clips' absolute paths.

1. *"Import C:\…\scratch\a.mp4 and C:\…\scratch\b.mp4 and put them on the timeline back to back. Give me a timeline summary."*
2. *"Make the project vertical 9:16, then auto-reframe both clips to keep the subject centered."*
3. *"Add a crossfade between the two clips, and a fade-in on the first and fade-out on the last."*
4. *"Speed the second clip up to 1.5x and give the first clip a warmer color grade."*
5. *"Add a title that says 'Test Reel' at the top of the first clip for its first 2 seconds."*
6. *"Transcribe the first clip and burn in captions."* (needs a clip with speech)
7. *"Set scratch\music.wav as background music at 25% volume with ducking."*
8. *"Add an animated motion-graphic lower-third that says 'Hello' for 3 seconds on the first clip."*
9. *"Add a video track above the base, put the second clip on it as an overlay scaled to 40% in the top-right, then animate it sliding in with keyframes."* (multi-track + transform + keyframes)
10. *"Search the library for the moment someone says 'ask not' and jump to it."* (needs a transcribed clip; exercises transcript search + `locate_in_timeline`)
11. *"Render a preview so I can review."*
12. *"Looks good — export it with the vertical TikTok preset to C:\…\out.mp4."* (export presets)
13. *"Actually undo the music."* / *"Save the project to C:\…\test.aive."*

If Claude completes these and the exported file plays with the edits applied,
the AI path is fully working.

---

## 6. The motion-graphics self-correction loop

**Yes — this already exists.** When Claude authors a Remotion component
(`add_graphic` with `code`), the editor renders it *before* touching the
timeline:

- If the TSX fails to compile or the component throws at render time, the render
  throws **before** the graphic is added — so **the timeline is never corrupted**
  (automatic revert).
- The error is returned to Claude as a tool error (`isError: true`) with the
  message, so Claude sees exactly what went wrong and can **regenerate corrected
  code** and call `add_graphic` again.

### How to test it

Ask Claude to author a deliberately broken graphic, e.g.:

> *"Add a motion graphic using this code, then fix it if it fails:*
> ```tsx
> export default function G() { return <div>{frame}</div>; }  // 'frame' is undefined
> ```
> *"*

Expected behavior:
1. The `add_graphic` call **fails** and returns an error to Claude (e.g. an
   undefined-variable / compile error).
2. The timeline is unchanged — `timeline_summary` shows no new graphic.
3. Claude reads the error and retries with corrected code (using Remotion's
   `useCurrentFrame()`), and the second attempt succeeds.

> Improvement worth considering before public release: prefix graphic-render
> errors with a short hint ("Motion graphic failed to render — fix the component
> and retry: …") so the model reliably treats it as a code-authoring fix rather
> than a tool misuse. The mechanism works today; this just makes the loop more
> reliable. Ask and I'll add it.

---

## 7. Testing the packaged installer (offline-first)

This verifies the Windows installer ships a self-contained, offline app.

### 7.1 Build the installer

```powershell
node apps/desktop/scripts/prepare-bundle.ts        # stage bundled binaries/models (~430 MB)
npx tsx packages/core/scripts/smoke-bundled.ts     # re-runs the staging (cheap), then verifies the bundle renders OFFLINE
npm run build
npm run dist --workspace synthcut-desktop          # -> apps/desktop/build/dist/SynthCut-<version>.exe
```

`smoke-bundled.ts` points the engine at *only* the staged bundle (no PATH FFmpeg,
no system font, bundled whisper + model + YuNet) and renders captions — proving
first-run works with no network.

### 7.2 Install and run

1. Run `apps/desktop/build/dist/SynthCut-<version>.exe`.
2. It's **unsigned**, so SmartScreen may warn — click **More info → Run anyway**.
3. Launch the installed app. Import a clip, add it, **Export** — it should render
   using the bundled FFmpeg with **no internet connection** (try it with Wi-Fi
   off). Captions and auto-reframe also work offline. Only **motion graphics**
   needs one online run (to download Remotion's Chrome).

---

## 8. Troubleshooting & known gotchas

- **"Could not start the editor core"** — run `npm run build`; confirm
  `ffmpeg -version` works.
- **Claude doesn't see the tools** — fully restart Claude Desktop; check the
  config path points to an existing `packages/mcp/dist/index.js`.
- **First captions/reframe/motion call hangs for a minute** — it's the one-time
  model/Chrome download. Watch the core's stderr for `[whisper] downloading …`.
- **Motion graphics fails on a machine running a dev server** — Remotion's render
  server uses an ephemeral port to avoid colliding with port 3000; if you see
  "not a valid Remotion project", make sure you're on the current build.
- **macOS captions** — no prebuilt whisper-cli is published; `brew install
  whisper-cpp` and set `AIVE_WHISPER_BIN`.
- **Reset everything** — delete `~/.synthcut` (the data dir) and `~/.aive` (cached
  models and binaries) to start from a clean slate. `~/.synthcut/data` holds your
  shared session/project.

---

## 9. Quick verification checklist

- [ ] `npm run build` succeeds
- [ ] All §3 smoke tests print `PASSED` (32 scripts; `smoke-bundled` is §7)
- [ ] `smoke-bundled.ts` passes (offline bundle)
- [ ] Desktop app: import → edit → preview → export by hand
- [ ] Claude Desktop connected; the §5.2 prompt script completes
- [ ] Motion-graphics error loop: broken code → error → Claude self-corrects
- [ ] Installer builds; installed app exports with Wi-Fi off
