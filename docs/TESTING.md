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
| FFmpeg + ffprobe on PATH | `ffmpeg -version` | `winget install Gyan.FFmpeg` |
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

For **caption** testing you need real speech. Grab the standard sample:

```powershell
curl -L -o scratch/jfk.wav https://github.com/ggml-org/whisper.cpp/raw/master/samples/jfk.wav
```

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
npx tsx apps/desktop/scripts/smoke-composite.ts                        # compositor plan: z-order, transitions, fades, keyframes, mute/hide, effect previews (CSS, vignette, bypass, keys), speed ramps (shared curve, ramped bleep mirror), blend modes + masks in the plan, audio-effect Web Audio plan + linked carrier + live route, the WebGL2 pass plans (order, bypass, keys, uniforms, fidelity) and the colour maths vs graph.ts
npx tsx packages/core/scripts/smoke-clip-tokenizer.ts                  # CLIP text tokenizer (semantic-search input)

# Web shell end-to-end: serves the UI, Host/token/path guards, picker listing,
# import + stream through the core, and stopping the core it started (needs the build)
npx tsx apps/desktop/scripts/smoke-web.ts
npx tsx apps/desktop/scripts/smoke-savename.ts                       # save picker file-name rule (typed extension kept, filter switches)

# Security: session-token auth (HTTP/WS) + /file allowlist (self-synthesizes media)
npx tsx packages/core/scripts/smoke-security.ts

# Jobs: background export with progress, cancel_job (partial file deleted), crash-recovery surfacing
npx tsx packages/core/scripts/smoke-jobs.ts

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
npx tsx packages/core/scripts/smoke-transitions.ts scratch/a.mp4 scratch/b.mp4
npx tsx packages/core/scripts/smoke-lut-stab.ts    scratch/a.mp4 scratch/b.mp4   # + stabilize options on a synthesized shaky clip
npx tsx packages/core/scripts/smoke-color.ts       scratch/a.mp4 scratch/b.mp4
npx tsx packages/core/scripts/smoke-transform.ts   scratch/a.mp4 scratch/b.mp4
npx tsx packages/core/scripts/smoke-key.ts                             # colorkey/chromakey+despill/lumakey, color "auto"; self-synthesizes
npx tsx packages/core/scripts/smoke-registry.ts                        # effect registry: legacy filter strings, FFmpeg accepts every effect, validation, bypass, reorder, vignette amount, every effect has a WebGL2 preview; self-synthesizes

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
npx tsx packages/core/scripts/smoke-animtext.ts    scratch/a.mp4

# Audio: background music + ducking
npx tsx packages/core/scripts/smoke-music.ts       scratch/a.mp4 scratch/b.mp4 scratch/music.wav

# Captions (Whisper), subject-aware auto-reframe (YuNet), J/L cuts
npx tsx packages/core/scripts/smoke-captions.ts    scratch/jfk.wav
npx tsx packages/core/scripts/smoke-reframe.ts
npx tsx packages/core/scripts/smoke-jlcut.ts

# AI background removal for people (RVM): cutout over a red V1, native + downscaled
# paths, VP8/alpha preview proxy, undo, cancel (downloads a portrait + the 15 MB model)
npx tsx packages/core/scripts/smoke-matte.ts
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

# Time effects: freeze_frame (ripples the timeline + linked audio), chunked frame-exact
# reverse_clip (and its un-reverse), smooth_slow_motion (blend + optical flow, no
# duplicated frames) — self-contained, verified by decoding frame-index-coded media
npx tsx packages/core/scripts/smoke-time.ts

# Speed ramps (curve speed): the shared source↔timeline mapping (speed.ts —
# constant speed exactly as before, round trips, monotonic, ∫ds/speed), every
# preset exported with frame-index-coded media (each frame = the mapped source
# frame, exact footprint), audio stretch (length within a frame, 440 Hz pitch
# kept, click-free joins, bursts on the curve) and mute, bleeps on the mapped
# words, split / cut_range / trim keep the curve, cuts in a slow section snap to
# their source frame (pieces and the next clip stay butted, tracks stay in sync),
# freeze holds the shown frame, locate / transcript cuts, reverse mirrors the
# curve, OTIO, undo, long filtergraphs passed from a file (self-contained).
# RAMPS_BASELINE_REF=<git ref> also checks that constant-speed timelines emit the
# exact ffmpeg command of the graph builder at that ref (byte-identical renders).
# smoke-composite.ts checks the preview's ramp mapping and the ramped bleep mirror.
npx tsx packages/core/scripts/smoke-ramps.ts
RAMPS_BASELINE_REF=dd38598 npx tsx packages/core/scripts/smoke-ramps.ts

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

```powershell
npx tsx apps/desktop/scripts/parity-gl.mts                 # both parity tables (~2 min)
npx tsx apps/desktop/scripts/parity-gl.mts --bench         # + ms/frame: GL (full, half, quarter resolution) vs the old CSS path, 2 layers at 1280×720
npx tsx apps/desktop/scripts/parity-gl.mts --only blur,glow --dump   # some effects; keep the PNGs (ffmpeg / gl / diff×16)
npx tsx apps/desktop/scripts/parity-gl.mts --only 420      # just the real-export (4:2:0) table
```

- Needs FFmpeg on PATH, `npm run build` (the page imports core's dist), and
  **playwright-core** plus a Chromium. It looks for playwright-core in
  `node_modules` and the npx cache (`~/.npm/_npx/*/node_modules`), and for a
  Chromium in Playwright's browser cache (`~/.cache/ms-playwright`, or the
  Windows / macOS equivalents). Override with `PLAYWRIGHT_CORE=<dir of
  playwright-core>` and `PLAYWRIGHT_CHROMIUM=<chrome binary>`.
- Headless Chromium runs WebGL2 on SwiftShader (software), which is exact but
  slow; `--bench` numbers on a real GPU are far lower.
- Pass thresholds follow each effect's `fidelity` in the registry: **exact** =
  max ≤ 3 levels and mean ≤ 1 (≤ 8 and ≤ 1 in the 4:2:0 table, for the
  rounding at hard colour edges); **close** = p99 ≤ 8; **approx** (denoise)
  is only reported. Film grain is random, so it compares the noise's mean and
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
| Effect stack | **Add effect** (grouped by category) → e.g. Vignette, Blur, Sharpen, Glow, Pixelate; drag their sliders; use the eye (bypass), ↑/↓ (reorder) and × buttons | Every effect previews live (WebGL2) in stack order and matches **Render exact**; Denoise shows a soft **≈** (approximate preview); without WebGL2 only the CSS-proxy effects preview and the rest show **Render exact**; a bypassed effect is struck through and drops out of the preview and export |
| Grade / LUT | **Color** grade (brightness, contrast, saturation, gamma); ask the AI for colour wheels / temperature / hue / curves (`apply_color`) and a `.cube` LUT (`apply_lut`) | All preview live and match **Render exact** (the LUT loads through the core's `/file` route) |
| Stabilize | On a shaky clip set **Smoothing** and **Zoom**, then **Stabilize clip** | Busy label "Stabilizing…", then the clip points at a "(stabilized)" bake; undo restores it |
| Keys | Put a gray-, green- or black-background clip on a track above another; **Add effect → Color / Chroma / Luma key** | Background turns transparent in the live preview (colour auto-detected); swatch, **Auto**, **Pick** (eyedropper) and the sliders update it in place; export matches |
| Blend modes | Put a clip on a track above another; in **Transform & animation** set **Blend** to Screen / Multiply / Overlay … | The live preview blends at once; **Render exact** / Export match it (within a few levels) |
| Masks | In the **Mask** group pick Ellipse / Rectangle / Linear / Mirror; drag Feather, Roundness, Width/Height, Rotation; tick **Invert**; drag the ✛ handle on the preview | Only the masked part shows; the mask moves/scales/rotates with the clip's transform; one undo step per change (one per handle drag) |
| Transition | Add a crossfade between the two clips | Overlap shown |
| Text | Add a title / lower-third | Overlay listed on the clip |
| Library search | Switch the search between **Words** and **Visuals**; search the library | Matching clips/moments returned |
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
npx tsx packages/core/scripts/smoke-bundled.ts     # verify the staged bundle renders OFFLINE
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
