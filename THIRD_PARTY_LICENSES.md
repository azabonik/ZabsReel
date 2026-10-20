# Third-Party Licenses & Notices

ZedMix is licensed under the **GNU General Public License v3.0 or later** (see `LICENSE`).
It is a modified version of another GPL program; `NOTICE` names that program and its
copyright holder, and carries the GPL section 7 permission for Remotion.
It ships with, or downloads on first use, a number of third-party components.
This file lists them, their licenses, and any obligations they place on
redistribution. Packaged installers include a copy of this file, `LICENSE` and `NOTICE`.

> **TL;DR for redistributors**
> - Everything bundled is freely redistributable. **Remotion is not bundled:**
>   motion graphics render with ZedMix's own renderer (GPL, no Remotion
>   code), or, if the user chooses, with a copy of Remotion that the user
>   installs as an optional add-on, under Remotion's own license (see the
>   **Remotion** section). Remotion is
>   *source-available, not OSI open-source*, and **companies with 4 or more
>   people need their own Remotion license** to use it.
> - **FFmpeg** is bundled as a GPL build and invoked as a separate process. If you
>   redistribute the installer you must make the **corresponding FFmpeg source**
>   available (it is unmodified upstream FFmpeg — see the FFmpeg section).

---

## Bundled in the installer

### FFmpeg / ffprobe
- **Role:** all media decoding, filtering, encoding. Invoked as an external
  subprocess — it is **never linked** into our code. Its GPL license is in any
  case compatible with this project's GPL-3.0 license.
- **Build shipped:** a static GPL build. The release installer bundles FFmpeg
  9.0.2, gyan.dev's essentials build (Chocolatey's `ffmpeg` package, pinned in
  `.github/workflows/release.yml`); an installer you build yourself bundles the
  tested build you stage (e.g. gyan.dev or BtbN). Because the
  binary is a GPL build, distributing it carries GPL obligations **for the binary
  itself**: you must offer the corresponding source.
- **License:** GPLv3 (the build); FFmpeg itself is LGPL/GPL.
- **Source:** https://ffmpeg.org/download.html and the build packager's source
  (https://www.gyan.dev/ffmpeg/builds/ or https://github.com/BtbN/FFmpeg-Builds).
  The bundled binaries are unmodified upstream releases.

### whisper.cpp (`whisper-cli` + ggml libraries)
- **Role:** local, offline speech-to-text for captions.
- **License:** MIT — © The ggml authors / Georgi Gerganov.
- **Source:** https://github.com/ggml-org/whisper.cpp (release v1.9.0).

### Whisper ggml model (`ggml-base.en.bin`)
- **Role:** the speech-recognition weights used by whisper.cpp.
- **License:** MIT — derived from OpenAI Whisper (MIT), converted to ggml format
  and distributed by the whisper.cpp project.
- **Source:** https://huggingface.co/ggerganov/whisper.cpp

### YuNet face-detection model (`face_detection_yunet_2023mar.onnx`)
- **Role:** local face tracking for subject-aware auto-reframe.
- **License:** Apache-2.0 — from OpenCV Zoo (© Shiqi Yu, Yuantao Feng et al.).
- **Source:** https://github.com/opencv/opencv_zoo

### Robust Video Matting model (`rvm_mobilenetv3_fp32.onnx`)
- **Role:** local AI background removal for people (`remove_background`).
- **License:** GPL-3.0 — from the Robust Video Matting project (Shanchuan Lin et
  al., "Robust High-Resolution Video Matting with Temporal Guidance"). Compatible
  with this project's GPL-3.0-or-later license.
- **Source:** https://github.com/PeterL1n/RobustVideoMatting (release v1.0.0).
- **Note:** dev/source builds download it once on first use into `~/.aive/models`
  (size + SHA-256 verified); override with `AIVE_RVM_MODEL` (path to a local copy)
  or `AIVE_MODELS_DIR`.

### ONNX Runtime (`onnxruntime-node`, incl. `onnxruntime.dll`, `DirectML.dll`)
- **Role:** runs the YuNet face model, the RVM matting model and the CLIP
  semantic-search model.
  Prebuilt native binaries (no compilation).
- **License:** MIT — © Microsoft Corporation.
- **Source:** https://github.com/microsoft/onnxruntime

### CLIP semantic-search model (`vision.onnx` + `text.onnx` + tokenizer)
- **Role:** local, on-device semantic visual search (text→image and image→image).
  CLIP ViT-B/32, quantized ONNX export + BPE tokenizer (vocab.json / merges.txt).
- **License:** MIT — OpenAI CLIP weights are MIT; the ONNX export is repackaged by
  the Transformers.js project (Xenova) under the same terms.
- **Source:** https://huggingface.co/Xenova/clip-vit-base-patch32 (upstream:
  https://github.com/openai/CLIP).
- **Note:** NOT bundled in the installer — downloaded once on first use into
  `~/.aive/clip` and cached locally (offline thereafter), like the larger Whisper
  models. Override/air-gap via `AIVE_CLIP_DIR` / `AIVE_CLIP_URL`; disable with
  `AIVE_CLIP_DISABLE=1` (search falls back to the model-free perceptual index).

### Noto Sans (`NotoSans-Regular.ttf`)
- **Role:** the bundled font for burned-in text overlays and captions, so they
  render identically on machines without the system fonts.
- **License:** SIL Open Font License, Version 1.1 (see
  `resources/aive/fonts/LICENSE-NotoSans.txt` in the installed app).
- **Source:** https://github.com/googlefonts/noto-fonts

### Electron
- **Role:** the desktop application shell.
- **License:** MIT — © GitHub / OpenJS Foundation. Electron itself bundles
  Chromium (BSD-style) and Node.js (MIT); see Electron's own license manifest
  shipped in the app.

### React 18.3.1 UMD builds (in `@aive/motion`)
- **Role:** the React that ZedMix's motion renderer loads into its render
  page: `react.production.min.js` and `react-dom.production.min.js`,
  unmodified, committed in `packages/motion/vendor/react-18.3.1/` with
  pinned sha256 values.
- **License:** MIT — © Facebook, Inc. and its affiliates (now Meta Platforms,
  Inc.). The licence text ships beside the two files
  (`resources/app/node_modules/@aive/motion/vendor/react-18.3.1/LICENSE` in the
  installed app).
- **Source:** https://github.com/facebook/react (v18.3.1); npm `react` and
  `react-dom` 18.3.1.

### sucrase
- **Role:** compiles the TSX of an AI-written motion graphic in memory, in the
  core, before the render (pure JavaScript, no native binary).
- **License:** MIT — © 2012-2018 various contributors (sucrase's AUTHORS).
  Its own dependencies are MIT, ISC (`glob`, `minimatch` and their helpers),
  BlueOak-1.0.0 (`minipass`, `jackspeak`, `path-scurry`,
  `package-json-from-dist`) and Apache-2.0 (`ts-interface-checker`); they ship
  as their npm packages, in `resources/app/node_modules`.
- **Source:** https://github.com/alangpierce/sucrase (3.35.0).

### npm runtime dependencies
All MIT-licensed:
- **react**, **react-dom** — © Meta Platforms, Inc.
- **execa** — © Sindre Sorhus
- **ws** — © Einar Otto Stangvik
- **zod** — © Colin McDonnell
- **nanoid** — © Andrey Sitnik

---

## ⚠️ Remotion — an optional add-on the user installs (NOT in the installer)

- **Packages:** `remotion`, `@remotion/bundler`, `@remotion/renderer` 4.0.481,
  with their dependencies (the `@remotion/*` compositors among them, which
  include an FFmpeg build that is not redistributable).
- **Role:** renders AI-authored React/Remotion components into motion graphics.
  Used **only** by the motion-graphics feature; ZedMix loads it only in
  `packages/core/src/motion/remotionload.ts`, for `motion/render.ts`.
- **Not conveyed:** no ZedMix installer contains Remotion. The user installs it
  from inside ZedMix (**Help → Graphics add-on**): the dialog shows ZedMix's
  notice and Remotion's `LICENSE.md` as of the v4.0.481 tag, and only **Accept
  and install** downloads the packages, from `registry.npmjs.org`, each checked
  against the sha512 this ZedMix version pins. The release build checks that
  the packed app holds no Remotion package (`scripts/check-no-remotion.mjs`).
  In the source repository Remotion is a development dependency only.
- **License:** the **Remotion License** — *source-available, not OSI
  open-source.* Individuals, non-profit organizations and companies of up to 3
  people may use it for free; **larger companies need their own Remotion
  license.** The add-on dialog shows these terms before anything is
  downloaded: https://github.com/remotion-dev/remotion/blob/main/LICENSE.md
- **Note:** Remotion's terms, not ZedMix's GPL, govern the add-on. The code
  that loads it is confined to one module and can be swapped for a
  Puppeteer/Playwright-based renderer if a fully-OSI motion-graphics path is
  required. `NOTICE` carries the GPL section 7 permission for linking with it.

---

## Downloaded on first use (NOT in the installer)

These are fetched and cached on the user's machine the first time the relevant
feature runs, or when the user installs them; they are not shipped in the
installer.

### Chrome Headless Shell (Chrome for Testing, with the graphics add-on)
- **Role:** the headless browser Remotion drives to render motion graphics.
- **License:** BSD-style (Chromium) — © The Chromium Authors, distributed by
  Google as Chrome for Testing under Google's terms.
- **Download:** the graphics add-on install downloads the Chrome for Testing
  headless shell 149.0.7790.0 for the user's platform from Google
  (`storage.googleapis.com`), checked against the sha256 this ZedMix version
  pins, into the add-on's folder. Remotion itself never downloads a browser in
  ZedMix.

### Additional whisper models
Larger Whisper models (small/medium/large) download on demand from Hugging Face
under the same MIT terms as the bundled `base.en` model, if the user requests
them.
