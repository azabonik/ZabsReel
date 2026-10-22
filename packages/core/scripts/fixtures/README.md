# Test fixtures

- `jfk.wav` — 11s of John F. Kennedy's 1961 inaugural address ("ask not what your
  country can do for you…"). US-government recording, **public domain**. This is
  the same standard sample bundled with whisper.cpp
  (https://github.com/ggml-org/whisper.cpp/blob/master/samples/jfk.wav). Used by
  `smoke-textedit.ts` to exercise word-level transcription and text-based editing
  without any external download.
- `v020-otio/` — the OpenTimelineIO files the v0.2.0 release exported (`cuts`,
  `layers`, `speed`, `looks`, `params`; its data under `metadata.synthcut`) and
  `manifest.json`, what each must open as. Copied byte for byte from the judge's
  `judge/fixtures/v020-otio/` (its `generate.py` made them with the v0.2.0 build);
  `@JUDGE_MEDIA@` stands for the media folder. Used by `smoke-otio.ts`, which makes
  the media and checks that each file opens as it does in v0.2.0. When the judge's
  set changes, copy the whole folder over again (every `.otio` file and
  `manifest.json` together): the smoke fails when the `.otio` files in the folder
  and the files the manifest lists differ.
