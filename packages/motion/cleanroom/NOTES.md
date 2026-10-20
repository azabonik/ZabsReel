# Implementation notes

The runtime implements SPEC.md's API for the names in BRIEF.md section 1.1, under BRIEF.md's host
contract. This file records every choice made where SPEC.md was silent or open, every conflict
between the two files (BRIEF.md wins), every prop or option that is accepted and ignored, and
what is left unfinished. Tests that check a recorded choice have "recorded choice" in their name.

## 1. Layout of the code

| File (in `runtime/src/`) | Contents |
| --- | --- |
| `index.ts` | The public exports (exactly `runtime/exports.json`) and the public types. |
| `host.ts` | The host interface types, written as BRIEF section 4 gives them, and `createMotionApp`, `createModuleObject`. |
| `hostTypes.ts` | Type-only re-export of those types for internal files (so they never load `host.ts`). |
| `app.tsx` | The React root, the error boundary, `renderFrame` with its settle loop, `unmount`. |
| `session.ts` | Per-app state: open delays, the first failure, fonts; the host-bound delay API and `loadFont`. |
| `moduleObject.ts` | The `Proxy` that `createModuleObject` returns. |
| `context.ts`, `hooks.ts` | Contexts; `useCurrentFrame`, `useVideoConfig`, `useDelayRender`. |
| `timing.ts`, `timingProps.ts`, `validate.ts` | The timing model (SPEC section 10) as pure functions; prop checks. |
| `AbsoluteFill.tsx`, `Sequence.tsx`, `Series.tsx`, `Loop.tsx`, `Freeze.tsx`, `crop.ts` | Layout and time components. |
| `assets.ts` | `asset()`, `staticFile()`, source resolution (BRIEF section 6.1). |
| `MediaImage.tsx`, `Img.tsx`, `Video.tsx`, `Audio.tsx`, `media.ts` | Media (BRIEF section 6). |
| `interpolate.ts`, `colors.ts`, `ranges.ts`, `easing.ts`, `spring.ts`, `random.ts` | Pure functions. |
| `errors.ts`, `exportNames.ts` | Coded errors and the fixed message; the export list. |

## 2. How a frame settles

- `renderFrame(n)` renders the root inside `flushSync`, so frame `n` is committed before the call
  returns. React runs that commit's layout and passive effects synchronously, so delays opened
  there are already counted.
- Updates that user code schedules outside React's synchronous work are not flushed by
  `flushSync`: `setState` in a promise callback, and `setState` inside a `useEffect` (React 18
  gives those default priority). To commit them, the runtime renders the top-level component
  again inside `React.startTransition`, passing a new "marker" number. React renders transition
  updates only after every pending update of higher priority (sync and default, including chains
  of effects that set state), and it renders pending transitions together. The top-level
  component's `useEffect` for the marker runs after every child effect of the same commit. When it
  runs, every update scheduled before the marker has been committed and its effects have run.
- The marker render re-renders nothing below the top-level component: the context values and the
  graphic's element are memoized.
- The settle loop: wait while any delay is open; then request a marker and wait for it; if any
  delay opened or closed in the meantime, start again. A marker round always runs, even when no
  delay was opened, so that `useEffect` → `setState` updates of the frame commit are committed.
- No timer decides anything. The only `setTimeout` is the `frameTimeoutMs` deadline (one per
  `renderFrame`). Every wait wakes on any change of the app's state: delay opened or closed,
  failure, marker committed, timeout, unmount. React's own scheduler uses `MessageChannel` in the
  page (`setImmediate` in Node), not timers.
- Errors: a class error boundary at the top catches errors thrown while rendering and in effects.
  Callbacks that the runtime invokes from event handlers (`onError`, `onImageError`, `onLoad`,
  `onVideoFrame`) are wrapped in `try`/`catch`; the volume callback and `<Freeze active>` run during
  render, so the boundary sees them. The first error is kept, and every later `renderFrame` rejects
  with it.

## 3. Conflicts between BRIEF.md and SPEC.md (BRIEF.md wins)

- `onError` on `<Img>`, `<Html5Video>` and `<OffthreadVideo>`: SPEC says a handler suppresses the
  exception (and that the caller must then remove the image or change `src`). BRIEF 6.2: the
  handler is called but does not stop the failure; the frame fails with `graphic_media_failed`.
- Retries and per-call timeouts: SPEC retries failed image loads with backoff (`maxRetries`) and
  times out each `delayRender` (30 s, configurable per call, with `retries`). BRIEF 6.7: nothing is
  retried and the only deadline is `frameTimeoutMs` (default 30000), counted from the
  `renderFrame` call. SPEC's 30 s vs 28000 ms inconsistency and its "from page load or from the
  call" question are moot.
- Sources: SPEC's `src` takes `staticFile()` paths and remote URLs. BRIEF 6.1: assets by id only;
  `staticFile()` throws `graphic_media_ref`; URLs and paths throw `graphic_media_ref`. SPEC 16's
  open questions about `staticFile()` are moot.
- `<Html5Video>`: SPEC wraps a native `<video>` and passes native props through (except `autoplay`
  and `controls`). BRIEF 6.3: the current frame is an `<img>`; only `width`, `height`, `style`,
  `className`, `id`, `aria-*` and `data-*` are forwarded; other native `<video>` attributes are
  dropped.
- `onVideoFrame`: SPEC passes the video element (in preview) and a timestamp and metadata where
  supported. BRIEF: the `<img>`, with the other arguments `undefined`.
- Volume above 1: SPEC needs `useWebAudioApi`; BRIEF clamps to 0..4 whatever `useWebAudioApi` says.
- Premounting and postmounting: SPEC defines them (with a Studio default of 2 s); BRIEF 6.8: never.
- `random()` with no argument: SPEC documents an exact message; BRIEF 7 forbids copying SPEC's
  message texts. The runtime throws `graphic_api_misuse` in its own words.
- `cancelRender`: SPEC's message format is open; BRIEF fixes the code (`graphic_render_cancelled`),
  the message (the reason, or the Error's message, with the Error as `cause`), and that the pending
  frame rejects even if user code catches the throw.
- `Video`/`Audio`: SPEC leaves open whether these names still exist; BRIEF: they are the same
  objects as `Html5Video`/`Html5Audio`.
- `useVideoConfig()`: SPEC lets `calculateMetadata` change `defaultCodec` and `defaultSampleRate`;
  BRIEF fixes them to `null` and `48000`. Every field SPEC lists is named by BRIEF section 4, so no
  field is `null` for the "not named here" reason.
- Composition, `<Still>`, `calculateMetadata` and `registerRoot` (SPEC 1) are not exported; the
  host supplies the composition (BRIEF 1.1, 4).

## 4. Accepted and ignored props and options

BRIEF 6.8's list, with the components that take each one. "Accepted" means the prop is allowed
(it is in the TypeScript types) and has no effect.

| Name | Where |
| --- | --- |
| `premountFor`, `postmountFor` | `Sequence`, `Series`, `Series.Sequence`, `Loop`, `AbsoluteFill`, `Img` |
| `styleWhilePremounted`, `styleWhilePostmounted` | `Sequence`, `Series`, `Series.Sequence`, `Loop`, `AbsoluteFill`, `Img` |
| `pauseWhenBuffering` | `Html5Video`, `OffthreadVideo`, `Html5Audio` |
| `pauseWhenLoading` | `Img` |
| `acceptableTimeShiftInSeconds` | `Html5Video`, `OffthreadVideo`, `Html5Audio` |
| `onAutoPlayError` | `Html5Video`, `OffthreadVideo` (never called) |
| `transparent`, `toneMapped` | `OffthreadVideo` |
| `name` | `Sequence`, `Series`, `Series.Sequence`, `Loop`, `AbsoluteFill`, `Img`, media |
| `showInTimeline` | `Sequence`, `Series`, `Series.Sequence`, `AbsoluteFill`, `Img`, media |
| `crossOrigin` | `Img`, `Html5Video`, `OffthreadVideo`, `Html5Audio` (never set on an element) |
| `effects` | `Img` (it always renders a native `<img>`) |
| `maxRetries` | `Img` |
| `toneFrequency`, `audioStreamIndex`, `preservePitch` | `Html5Video`, `OffthreadVideo`, `Html5Audio` |
| `useWebAudioApi`, `allowAmplificationDuringRender` | `Html5Video`, `OffthreadVideo`, `Html5Audio` |
| `delayRenderTimeoutInMilliseconds`, `delayRenderRetries` | `Img`, `Html5Video`, `OffthreadVideo`, `Html5Audio` |
| `timeoutInMilliseconds`, `retries` (options of `delayRender`) | `delayRender` (module object and `useDelayRender`) |

Also accepted without effect (my choice, not in BRIEF's list):

- `outlineRef` on `Sequence` (deprecated and ignored in SPEC too).
- `imageFormat` on `OffthreadVideo` (removed from SPEC's API in v4).
- `onError` on `Html5Audio`: audio never plays, so there is never a playback error to report.
- `trimBefore` on `Img`: checked like a Sequence prop, but an image has no timeline to trim.

Dropped (not forwarded to any element):

- Both video components: every native `<video>` attribute except the forwarded ones (BRIEF 6.3),
  for example `autoPlay`, `controls`, `poster`, `playsInline`, `preload`, `title` and event
  handlers. That includes `loop` on `<OffthreadVideo>`, which SPEC gives no loop prop.
- `<Img>`: `srcSet` and `sizes` (the browser could load a URL other than the host's) and `loading`
  (`"lazy"` could keep an image from loading, so the frame would time out).
- `<Html5Audio>`: every native `<audio>` attribute.

## 5. Choices where SPEC.md is silent or open

### 5.1 Time and the timing model

- `useCurrentFrame()` returns the exact value of SPEC's formula, so it can be fractional under a
  `playbackRate` other than 1 (half speed gives smooth half-speed animation). Values within 1e-9
  of a whole number are snapped to it, to hide floating-point noise. It is negative only when a
  negative `trimBefore` or `freeze`/`<Freeze frame>` value asks for it.
- Active range: a non-looping item is mounted for parent frames with `from <= f` and
  `(f - from) * playbackRate < durationInFrames` (with a 1e-9 tolerance). Outside it nothing is
  mounted.
- Negative or fractional `from`, `trimBefore` and `durationInFrames` are allowed; NaN and
  non-numbers throw `graphic_api_misuse`. A `durationInFrames` of 0 shows nothing; a negative one
  throws. `playbackRate` must be positive and finite (SPEC's rule). A rate that changes between
  frames is not detected; each frame uses the rate it is given. `null` counts as "not given" for
  the optional number props.
- `freeze` on a Sequence is a child-timeline frame: children see exactly `freeze`; the Sequence's
  own active range still follows the parent's timeline. It combines with `trimBefore`,
  `playbackRate` and `loop` only through that range.
- `useVideoConfig().durationInFrames` inside a Sequence (and a `Series.Sequence`):
  `trimBefore + durationInFrames`; for an infinite `durationInFrames`,
  `trimBefore + max(0, parentDuration - from) * playbackRate` (the parent's end in the child's
  frames). `fps` does not change inside a Sequence with a `playbackRate`. Nothing changes inside
  `<Freeze>`.
- `width`/`height` on a Sequence must be positive numbers; they set the container's inline size
  (a `style.width`/`style.height` wins) and what `useVideoConfig()` reports below.
- `<AbsoluteFill>` without timing props is a plain styled `<div>`; it does not touch time and works
  outside a graphic. With any of `from`, `durationInFrames`, `trimBefore`, `playbackRate`, `freeze`,
  `hidden`, it acts as a Sequence whose container is the fill `<div>` itself, and renders nothing
  outside its range.
- `<AbsoluteFill>` style: the default styles, minus the ones a Tailwind class overrides, then the
  user's `style` on top. Tailwind detection (revised in round 1 to the reference's observed
  behaviour): a variant prefix does not matter (`md:flex-row` counts like `flex-row`; the part after
  the last `:` is matched); the class is otherwise matched as written, so important markers
  (`flex-row!`, `!grid`) are not recognised; position classes (`relative`, `absolute`, ...) do not
  drop the default position. Detected: `block`, `flex`, `grid`, `hidden`, `inline*`, `contents`,
  `table`, `flow-root`, `list-item` (display); `flex-row|flex-col[-reverse]` (flexDirection);
  `inset-*`, `inset-x-*`, `inset-y-*`, `top-*`, `right-*`, `bottom-*`, `left-*` (sides); `w-*`,
  `h-*`, `size-*` (size). A leading negative-value dash (`-top-2`) is ignored; round 1 had no
  evidence either way on that.
- Crop props: clamped to 0..1 and applied as `clip-path: inset(...)`. Opposite crops that overlap
  meet in the middle of their overlap (an empty region). An inline `borderRadius` and the
  per-corner longhands become the inset's `round` part (missing corners are 0). They need
  `layout="absolute-fill"`. Defaults are 0.
- `layout="none"` with `style`, `className`, a crop prop or a `ref` throws `graphic_api_misuse`.
- `hidden` defaults to `false`.

### 5.2 Series

- `offset` defaults to 0 and may be fractional or negative; a negative first offset starts the
  first scene before frame 0. Scene starts follow SPEC's derived formula. Inside a scene the
  children see frame `trimBefore` (0 by default) at the scene's start.
- `durationInFrames` must be a positive whole number; `Infinity` only on the last scene. Otherwise
  `graphic_api_misuse`.
- Children: fragments are opened up; `null`, `undefined` and booleans are skipped; anything else
  that is not a `<Series.Sequence>` throws `graphic_api_misuse`. A `<Series.Sequence>` outside a
  `<Series>` throws `graphic_api_misuse`.
- Scenes accept the Sequence props (`name`, `hidden`, `width`, `height`, crops, `layout`, `style`,
  `className`, `ref`, the ignored premount props) except `from` and `loop`, which throw
  `graphic_api_misuse` (use `offset`, or a looping Sequence inside the scene).
- `from` and the other Sequence props on `<Series>` itself shift or scale the whole series.

### 5.3 Loop

- Iterations start at the parent's frame 0. One iteration is `durationInFrames` parent frames;
  inside, children see `(f - iteration * durationInFrames) * playbackRate`, so one iteration spans
  `durationInFrames * playbackRate` child frames. Nothing is mounted before frame 0 or after
  `times` iterations (total length `durationInFrames * times`).
- Docs inconsistency (SPEC 14, 26.2): the `useLoop` example comments 75 at iteration 1 of a
  50-frame loop. Here a child reads the local frame, 25 at parent frame 75; 75 is the parent's
  frame.
- `durationInFrames` is required (positive, finite). `times` is a whole number >= 0 or `Infinity`
  (0 shows nothing). `className` is supported, as on Sequence.
- `useVideoConfig().durationInFrames` inside a Loop is `durationInFrames * playbackRate`.
- `Loop.useLoop()` reports the nearest enclosing `<Loop>` or looping `<Sequence>`. Inside a looping
  Sequence, `durationInFrames` is that Sequence's `durationInFrames` prop (the loop length in its
  child frames).

### 5.4 Freeze

- `frame` is required (a finite number). `active` defaults to `true`; a function gets the frame the
  `<Freeze>`'s parent sees, and its result is read as a boolean. `true` means frozen.
- Docs inconsistency (SPEC 15, 26.1): with `frame={30} active={(f) => f < 30}`, this runtime shows
  frame 30 before frame 30 and plays normally from frame 30 on.
- Sequences inside a `<Freeze>` mount and unmount by the frozen frame.

### 5.5 Media timing (BRIEF 6.3, 6.4)

(Round 2 changed `from`, `trimAfter` and the source-frame rounding to the reference's observed
behaviour; section 10 lists the cases and the scripts that derive them.)

- Media components accept `from` (default 0; SPEC 10.6 and 10.7 leave it open). It only keeps the
  element unmounted before parent frame `from`; it does not shift the source: the media's timeline
  starts at its parent's frame 0 whatever `from` is (derived: `notes/fit/r2-media-rules.js`,
  part 2). Choices with no row evidence: `durationInFrames` and `trimAfter` also count from the
  parent's frame 0 (so `from` does not extend the end), and the volume callback is unaffected by
  `from`.
- Media-local frame: `trimBefore + f * playbackRate`, where `f` is the parent's frame and already
  carries the enclosing Sequences' shifts and rates, so rates multiply. With `loop`:
  `trimBefore + (f * playbackRate) mod length`. Before `from`, or past `durationInFrames` (or
  `trimAfter`, below), nothing is mounted.
- Without `durationInFrames`, a non-looping media stays mounted to the end of its parent: the video
  shows its last frame (the clamp) and audio keeps producing cues past the source end (the host
  trims them).
- Loop length without `durationInFrames`: the rest of the source after `trimBefore`, i.e.
  `frameCount / fps` seconds for video and `durationSeconds` for audio, in composition frames. If
  nothing is left, `graphic_api_misuse`. A loop longer than the source shows the video's last
  frame (or gives audio source times past the end) for the rest of each iteration.
- `trimBefore` and `durationInFrames` count media-local frames at the composition's fps, before
  `playbackRate` (so the media takes `durationInFrames / playbackRate` parent frames; SPEC dates
  the media `durationInFrames` v4.0.530).
- `trimAfter` (and its old name `endAt`), without `loop`: the element stays mounted for
  `trimAfter - trimBefore` parent frames, not divided by `playbackRate`; the source keeps advancing at
  the rate meanwhile (clamped to its last frame). At rate 1 this is the same as playing source
  frames `trimBefore..trimAfter-1`. Derived from round 2's rows (`notes/fit/r2-media-rules.js`,
  part 3, the only candidate that fits all four trim compositions). With `loop`, the
  `trimBefore..trimAfter` source range is what repeats (unchanged; the rows say nothing about loops at
  rates other than 1). `trimAfter` must be greater than `trimBefore`. `startFrom`/`endAt` are the
  old names. Mixing old and new names, or giving `trimAfter` together with `durationInFrames`,
  throws `graphic_api_misuse`. A media `playbackRate` must be positive and finite; one that changes
  between frames is used as given.
- Seconds = media-local frame / composition fps. Source frame = the nearest source frame to
  `seconds × asset fps`, ties going up (`floor(x + 0.5)`, with a 1e-9 tolerance), then clamped to
  `0..frameCount-1`. Derived from round 2's rows (`notes/fit/r2-media-rules.js`, part 1): round
  half up fits 34 of the 35 observations; floor fits 20, the other candidates fewer than 31. The
  one observation it does not reproduce: in `offthread-rate-half`, frame 59 (position exactly 29.5)
  showed source frame 29 in the reference, while every other exact tie (0.5, 1.5, 14.5, 15.5, 30.5,
  59.5, 74.5) went up; no arithmetic order of the conversion reproduces that row, so it is left as
  an outlier (this runtime shows 30). A negative media-local frame (only possible with a negative
  `trimBefore`) fails with `graphic_media_time`, for muted sources too.
- A video inside `<Freeze>` shows the frame for the frozen time and is silent; audio inside
  `<Freeze>` adds no cue.
- `volume`: default 1; a number, or a function called during render with the media's frame on its
  parent's timeline (`f`, counted from the parent's frame 0, not scaled by the media's own rate and
  not shifted by `from`; inside a Sequence that is the Sequence's frame). Round 2's
  `audio-volume-step-sequence` shows the reference counting differently (its step comes earlier),
  but its single metric cannot tell "trimBefore included" from "composition frame" apart, so this
  stays as it is (section 10.4).
  With `loopVolumeCurveBehavior: "repeat"` (the default) that count restarts with every iteration:
  of the media's own loop, and (because the parent's frame restarts) of an enclosing `<Loop>` or
  looping Sequence. With `"extend"` it keeps counting across all of them. A result that is not a
  number counts as NaN, so 0. The callback is only called when the source adds a cue. A `volume`
  that is neither a number nor a function throws `graphic_api_misuse`.
- Audibility: a cue is added when the source is mounted, not muted, not frozen, and (for video)
  the asset's `hasAudio` is `true`. `muted` may change from frame to frame.
- Cue order is tree order, read from the DOM position of each source's element: the video's
  `<img>`, and for `<Html5Audio>` a hidden, empty `<audio>` element without `src` (SPEC 21 leaves
  the audio component's DOM open). `sourceKey` is `source-<n>`, assigned when the component mounts.

### 5.6 Images and video frames

- Size attributes come from the asset's `width`/`height` when the user gives none of `width`,
  `height`, `style.width`, `style.height` (BRIEF 6.2). This is a BRIEF rule, so it stays even where
  the reference stretches an unsized image or video in a flex container (round 2's `img-in-fill`,
  section 10.3). The `ref` of `<Img>` and of both video components is the `<img>`. `<Html5Audio>`
  does not attach refs.
- Both video components put `object-fit: contain` on their `<img>` unless the user's `style` sets
  `objectFit`: a frame in a box of another shape is letterboxed, as a video element shows it
  (derived from round 2's frame images: `notes/fit/r2-media-rules.js`, part 4). `<Img>` keeps the
  browser's default (`fill`). This does not change any size, so `img-in-fill` is unaffected.
- An `<img>` whose URL is unchanged and already loaded holds no delay. "Loaded" means this element
  fired `load` for that URL, or reports `complete` with a non-zero `naturalWidth` when committed.
  While a new video frame loads, the browser keeps showing the previous one; the frame does not
  settle until the new one has loaded.
- On `error`: `onError(event)` (the React error event of the `<img>`), then `onImageError(error)`
  (the `graphic_media_failed` error that fails the frame), then the frame fails. If a handler
  throws, the frame fails with that error instead. The user's `onLoad` on `<Img>` is called after
  the runtime's own load handling.
- `onVideoFrame(img)` is called once per `renderFrame` call for each video element, after commit
  and load, before the frame settles, also when the source frame did not change.
- Media cap: every mounted media `<img>` counts (images, `data:` images, video frames); the 9th in
  a commit fails the frame at once with `graphic_media_per_frame`.

### 5.7 Fonts

- `loadFont` resolves its argument like a media `src` but without the URL/path step: an `asset()`
  reference or a font id; anything else is `graphic_asset_unknown`. `options` must be an object and
  `family` a non-empty string; otherwise `graphic_api_misuse` (also recorded for the frame).
- Two ids with the same family: both faces are added to `document.fonts`, in call order. The
  runtime does not choose between them; the browser's font matching decides which file draws.
- The returned `fontFamily` is the bare family name (`zr-font-<id>` or `options.family`), not a
  quoted CSS string. `zr-font-<id>` works unquoted in CSS `font-family` when the id holds only
  letters, digits, `-` and `_`; for other ids (with `.`, `/`, quotes and so on), and for an
  `options.family` that is not a plain identifier, the graphic must quote it
  (`fontFamily: '"' + fontFamily + '"'`).
- The source is exactly `url(<host.fontUrl(handle)>)`, unquoted, as BRIEF writes it. A URL with
  spaces or parentheses would need quoting; host URLs are assumed not to contain them.
- If the page has no `FontFace` or `document.fonts`, the frame fails with `graphic_media_failed`.
  `loadFont` after `unmount()` throws `graphic_render_cancelled` and registers nothing.

### 5.8 Delays

- Handles are numbers, unique across the page. `continueRender` returns `undefined`. Called with a
  value that is not a handle this app issued (no argument, another app's handle, a string), it
  throws `graphic_api_misuse`; releasing a handle twice does nothing.
- `delayRender` with a label that is not a string throws `graphic_api_misuse`.
- `cancelRender` with a value that is neither a string nor an Error: the message is the value's
  `message` property if that is a string, else `String(value)`; the value is the `cause`.
- `useDelayRender()` returns one object per app, the same on every render. "Scoped to a specific
  render" means bound to that app. There is no `useContinueRender()` (not in the export list).
- Session binding: `createModuleObject(host)` creates (or reuses) the session that the next
  `createMotionApp(host)` adopts, so delays and errors from module evaluation belong to that app.
  A `createModuleObject(host)` after that starts a new session for a later app.

### 5.9 renderFrame and the app

- `renderFrame(n)` needs a whole `n` in `0..durationInFrames-1`, otherwise it rejects with
  `graphic_api_misuse`. Calling it while the previous call is pending also fails the app with
  `graphic_api_misuse`. Both rejections are final, like every rejection.
- `createMotionApp` checks the composition (positive width, height and fps; a whole
  `durationInFrames >= 1`) and throws `graphic_api_misuse` synchronously.
- A thrown value that is not an Error is wrapped in a plain `Error` (no `code`, since the error is
  the user's) whose `cause` is the value.
- The timeout message lists the labels of the open delays: `delayRender("label")`,
  `delayRender() without a label`, `loading image "id"`, `loading a data: image`,
  `loading frame N of video "id"`, `loading font "id"`.
- `unmount()` unmounts the React root and removes the root element and the app's font faces.
- Hooks and components used outside a graphic that ZedMix renders throw `graphic_api_misuse`.
  `Loop.useLoop()` returns `null` (as documented) and `<AbsoluteFill>` without timing props works
  anywhere.

### 5.10 Module object

- A `Proxy` over an empty, extensible object. `ownKeys` lists exactly the export names; `has` is
  true for them and for `__esModule`. Writing, defining, deleting, changing the prototype and
  `preventExtensions` (so `Object.freeze`) throw `graphic_api_misuse`.

### 5.11 interpolate()

(Round 1 changed several of these to the reference's observed behaviour; section 9 lists the cases.)

- `inputRange` must hold finite numbers and be strictly increasing; otherwise
  `graphic_api_misuse`. The input may be any number: NaN and infinities go through the arithmetic
  (`interpolate(NaN, ...)` is NaN; `Infinity` with a right clamp gives the last value). A
  non-number input throws `graphic_api_misuse`.
- At an interior keyframe the segment that ends there applies (progress 1). The first keyframe
  starts segment 0.
- `extend` uses the first or last segment's mapping, including its easing, with progress outside
  0..1.
- `wrap` repeats the end segment on that side: left of the range the first segment, right of it the
  last one, each wrapped with a positive modulo into `[start, end)` of that segment. (The parity
  rows cannot tell a positive modulo from JavaScript's `%` on the left side; the positive modulo is
  the reading of SPEC's "repeats in a loop".)
- `identity` returns the (posterized) input as every component of the result: a number for plain
  numbers, the input in each component's unit for CSS values (`"1.5px"`), and an array full of the
  input for numeric tuples. For discrete strings and booleans it still throws `graphic_api_misuse`.
- `posterize: n` is a plain `floor(input / n) * n` in floating point (so `0.3` with `n = 0.1` gives
  `0.2`, because `0.3 / 0.1` is `2.9999999999999996`), for any positive `n` and for negative inputs
  alike, before extrapolation.
- Option values outside their documented sets (`extrapolateLeft`, `extrapolateRight`, `output`,
  `outputType`) count as not given: `extend`, `linear`, no output type.
- CSS transform strings: components separated by spaces, at most three. Detection without
  `outputType`: the first of scale, translate, rotate, transform-origin that every keyframe fits.
  Scale needs unitless numbers; translate lengths or percentages; rotate `deg|rad|grad|turn`;
  transform-origin keywords (normalized to percentages; `top left` equals `left top`), lengths and
  percentages, and a length as the third component. A length-only range is detected as translate;
  pass `outputType: "transform-origin"` for a length-only origin. A bare `0` takes the unit the
  other keyframes use. A transform-origin keyframe keeps the number of components written (a lone
  `left`/`center`/`right` or length is one component; a lone `top`/`bottom` becomes `50% <y>`).
  Missing components, when keyframes differ in length: scale 1, translate and rotate 0,
  transform-origin 50% (x, y) and 0 (z). Results: each number rounded to 6 decimals, then its unit,
  joined by single spaces (`"50px 25px"`).
- An `outputType` that the values do not fit is ignored: the values are then read as they would be
  without it (`["0px", "100px"]` with `outputType: "rotate"` gives `"50px"`).
- `outputType: "font-weight"`: numbers, numeric strings, `"normal"` (400) and `"bold"` (700). The
  result is a number when every keyframe is a number, otherwise a numeric string (`"500"`). Other
  keywords make the outputType not fit (then, for keyword strings, `graphic_api_misuse`).
- Strings are read as CSS values whenever they are CSS values, also with `Easing.step1` (then they
  hold, reformatted: `"0.50px"` gives `"0.5px"`). Strings that are not CSS values need
  `Easing.step1` on every segment and come back verbatim (discrete strings); otherwise
  `graphic_api_misuse`.
- Numeric tuples return a new array of numbers.
- `output: "perceptual-scale"` changes plain number outputs only (SPEC's documented mapping).
  Numeric tuples, CSS strings (scale strings included), discrete strings and booleans interpolate as
  without it.
- `Easing.spring({ allowTail: true })` on a segment: when a later segment applies, the earlier
  segment's leftover motion (its easing evaluated past progress 1, minus 1, times that segment's
  output change) is added to the result. This makes the value continuous at the keyframe.

### 5.12 interpolateColors()

- Accepted: the CSS named colours and `transparent`; `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`;
  `rgb()`/`rgba()`/`hsl()`/`hsla()` in comma or space syntax (numbers or percentages); `hwb()`,
  `lab()`, `lch()`, `oklab()`, `oklch()` in space syntax with an optional `/ alpha`; `none` as 0;
  hue units `deg`, `rad`, `grad`, `turn`. `currentColor` and anything else throw
  `graphic_api_misuse`.
- Every colour is converted to sRGB (CSS Color 4 conversions for hsl, hwb, oklab, oklch).
  `lab()` and `lch()` are read against the D65 white point with no chromatic adaptation. This
  follows the reference library's observed values; CSS Color 4 itself defines Lab on D50, and SPEC
  leaves the conversion open.
- Each keyframe colour is then clipped to 0..255 per channel and rounded to 8 bits, alpha included
  (`round(alpha * 255)`). Interpolation happens per channel on those values, non-premultiplied.
- A channel that is equal at both ends of the segment keeps that value whatever the progress (so a
  NaN input gives `rgba(NaN, 0, NaN, 1)` from red to blue).
- Inputs outside the input range hold the first or last colour (there is no extrapolation).
- `Easing.spring({ allowTail: true })` has no tail here: only `interpolate()` carries a segment's
  leftover motion into the next segment. In `interpolateColors()` each segment uses its own easing.
- The result's channels are rounded to whole numbers but not clamped: an easing that overshoots can
  give values outside 0..255 (`rgba(-39, 147, 0, 1)`). Alpha is the 8-bit value divided by 255,
  rounded to 3 decimals (`25%` gives `0.251`). Format: `rgba(r, g, b, a)` with `", "` separators.

### 5.13 spring() and measureSpring()

- Model: the exact solution of a damped spring released at rest, with the damping ratio
  `damping / (2 * sqrt(stiffness * mass))` capped at 1. So every `damping >= 2 * sqrt(stiffness *
  mass)` gives the same, critically damped, curve: overdamped settings cannot be told apart from
  critical damping. High-damping springs (such as `damping: 200`) therefore settle in well under a
  second. The model also reproduces SPEC 7's documented `measureSpring` example (23), which a
  physically overdamped curve (about 318 frames) would not. Round 1's parity rows agree with this
  model to within about 2e-6 (well inside the report's 1e-4) wherever they sample it (default,
  `damping: 200`, `damping: 5`, `mass: 2, stiffness: 50`).
- Time: a whole frame advances the spring by `min(1 / fps, 0.064)` seconds. Above 15.625 fps that is
  just `1 / fps`; at lower frame rates each frame counts as 64 ms (round 1's rows at 1 fps;
  `measureSpring({fps: 1, config: {damping: 200}})` is 12; `notes/fit/r1-derive.js`, part 1).
- Fractional frames (round 2): time advances in whole-frame steps, each at most 64 ms, and the
  fraction lengthens the first step: frame `g >= 0` with `n = max(1, floor(g))` steps lasts
  `min((g - n + 1) / fps, 0.064) + (n - 1) * min(1 / fps, 0.064)` seconds. A frame below 1 is one
  partial step (`g / fps`, at most 64 ms). At 10 fps, frame 2.5 is 128 ms like frame 2; at 16 fps
  frame 1.5 is 64 ms. Derived from round 2's rows (`notes/fit/r2-spring-steps.js`: the only one of
  five candidates that fits all 24 unclamped rows, including stretched and reversed springs at 10,
  15, 16 and 24 fps). The same rule applies to the natural frame of a stretched spring and to
  `Easing.spring`. At 30 fps it only differs from `g / 30` for fractions above 0.92 (the first step
  would pass 64 ms), which gives small jumps just below whole natural frames; round 1's rows still
  all match.
- `measureSpring` returns a whole number of frames: the smallest frame from which every later frame
  is within `threshold` of the target. Distance is measured on the 0-to-1 curve, so `from` and `to`
  do not matter. An undamped spring returns `Infinity`.
- The default of `durationRestThreshold` is 0.005 (the same as `measureSpring`'s `threshold`).
- `durationInFrames`: the spring's whole-frame settle length `N` (`measureSpring`'s count, with
  `durationRestThreshold` as the threshold) is scaled onto `durationInFrames`: requested frame `g`
  shows the natural curve at frame `g * N / durationInFrames`. Frames after `durationInFrames` give
  exactly `to`; the frame `durationInFrames` itself still shows the curve (within the threshold of
  `to`, so it may overshoot slightly, e.g. 1.000448).
- `reverse` without `durationInFrames` uses `measureSpring`'s length (threshold 0.005). The value at
  frame `g` (after the delay) is the curve at `length - g`, so a reversed spring starts near `to`
  (within the threshold) and holds `from` once it is over. A stretched, reversed spring before its
  start (during a delay) is past its duration, so it is exactly `to`.
- Before its start (negative frames, or during `delay`, or with a NaN `delay`) the spring holds its
  starting value: `from`, or, for a reversed spring, the value at its length.
- An unstretched spring approaches `to` without reaching it: when the remaining distance is below
  floating-point precision (e.g. frame 1000), the result is the double next to `to` on the side of
  `from`, so `spring({frame: 1000, fps: 30}) === 1` is `false`. This applies only when `from !== to`,
  without clamping and without stretching (a stretched spring ends exactly at `to`;
  `overshootClamping` gives exactly `to`).
- `overshootClamping` replaces every value beyond `to` (past the target in the direction of travel)
  by `to`, as SPEC 6 documents. The reference never clamped in any parity row (decreasing in round
  1, increasing in round 2); see sections 9.3 and 10.3.
- `config.mass`, `config.damping`, `config.stiffness` and `durationRestThreshold` accept any number;
  the formulas then decide: `mass: 0` or `mass: -1` gives NaN, `stiffness: 0` gives a spring that
  never moves (`from`), `durationRestThreshold: 1.5` gives a settle length of 0 (the stretched
  spring stays at `from` until its duration ends).
- Still `graphic_api_misuse`: `fps <= 0`, a non-finite `frame`, non-numbers in the config,
  `durationInFrames <= 0`, `durationRestThreshold <= 0`, non-finite `from`/`to`, and stretching or
  reversing an undamped spring.

### 5.14 Easing

The formulas below were derived from the reference's values in round 1 where SPEC gives none
(section 9); they are written in this runtime's own code.

- `ease` is `bezier(0.42, 0, 1, 1)` (the preset SPEC links).
- `sin(t) = 1 - cos(t * pi / 2)`; `circle(t) = 1 - sqrt(1 - t^2)` with `t` clamped to 0..1;
  `exp(t) = 2^(10 (t - 1))` for every `t` (so `exp(0)` is `2^-10`, about 0.000977).
- `elastic(bounciness = 1)`: `1 - cos(pi t / 2)^3 * cos(bounciness * pi * t)`, evaluated as written
  for every `t` and every number of bounciness (negative included). 0 never overshoots inside 0..1;
  1 overshoots once.
- `back(s = 1.70158)`: `t^3 - s * t^2 * (1 - t)` (the same as `t^2 ((s + 1) t - s)`).
- `bounce`: a ball drop with three bounces, each keeping half the speed: 0 at `t = 0`, touching 1
  at `t = 1/2.75` and between the bounces, 1 at `t = 1`. `t` is clamped to 0..1.
  `Easing.out(Easing.bounce)` is its mirror image.
- `in(e) = e`; `out(e)(t) = 1 - e(1 - t)`; `inOut(e)(t) = e(2t) / 2` for `t < 0.5`, else
  `1 - e(2 (1 - t)) / 2`.
- `step0` and `step1` return 0 when their condition is false.
- `bezier` needs `x1` and `x2` in 0..1 (else `graphic_api_misuse`); outside 0..1 the progress holds:
  0 before 0, 1 after 1. This includes the linear `bezier(0, 0, 1, 1)` and `ease`.
- `poly(n)` accepts any number `n` (`poly(0)(0)` is `0 ** 0`, 1).
- The polynomial, trigonometric, `elastic` and `back` formulas are evaluated as written for progress
  outside 0..1.
- `Easing.spring(config)(p)` is `spring({frame: 30 p, fps: 30, durationInFrames: 30, config})`: the
  whole-frame settle length at 30 fps (threshold `durationRestThreshold`, default 0.005) is scaled
  onto the 30-frame span. Progress <= 0 gives 0. Without `allowTail`, progress >= 1 gives exactly 1;
  with it, the spring keeps moving past 1.

### 5.15 random()

- Own hash: the seed becomes a key (`#` + `String(n)` for numbers, `$` + the string for strings),
  hashed in two 32-bit lanes into 53 bits; the result is in `[0, 1)`. `random(1)` and `random("1")`
  differ; `-0` and `0` are the same seed. Values are stable for as long as this hash is unchanged.
  They do not match SPEC's documented `random(1)`, which SPEC says cannot be reproduced.
- `random(null)` returns `Math.random()`. The module object's `random` calls `host.log` once per
  host, on the first `random(null)`; `index.ts`'s `random` logs nothing (it has no host).
- NaN, `Infinity` and `-Infinity` are accepted and give 0.
- `undefined`, booleans, objects and no argument throw `graphic_api_misuse` (SPEC documents the
  no-argument error).

### 5.16 Errors

- Messages are this runtime's own. Tests check codes, the two fixed texts (BRIEF 5 and the
  `cancelRender` reason), and the required parts of messages (open delay labels, asset ids, the
  rejected value), never free wording.

## 6. Deviations

- None from BRIEF.md. SPEC.md is departed from only where BRIEF.md says so (section 3).

## 7. Unfinished or limited

- Suspense: a component that suspends fails the frame (React reports it to the error boundary);
  suspension is not treated as a delay.
- Updates that user code schedules after the marker commit (for example from the effect of a user
  transition that React batched with the marker) are not waited for.
- `random()`'s numbers are this runtime's own and do not reproduce Remotion's values (SPEC says they
  cannot be reproduced from the spec). `spring()` matches the reference wherever rounds 1 and 2
  sampled it (except `overshootClamping`, kept from SPEC); between those samples it is this
  runtime's model.
- Media: four round-2 compositions keep differences for which no rule could be derived from the
  rows (section 10.4).

## 8. Testing

- `npm test` runs every file in `test/`. The rendering tests run in jsdom (`test/helpers/dom.ts`)
  against React's development build; `test/production.test.tsx` repeats the core cases against
  the production builds that the page loads.
- jsdom never loads images, so tests fire `load`/`error` on the `<img>` elements
  (`renderLoaded`, `fireLoad`, `fireError` in `test/helpers/host.ts`). `FontFace` and
  `document.fonts` are stubbed (`installFontStubs`).
- The test setup hides two kinds of console output from React's development build: the warning
  about importing `createRoot` from `react-dom` (the production build has none), and the logging of
  errors that the runtime's error boundary catches on purpose.
- `test/exports.test.ts` is the export gate (index.ts against `exports.json`) and also checks that
  the runtime imports only `react`, `react-dom` (only `createRoot` and `flushSync`) and its own
  files. `test/moduleObject.test.tsx` compiles graphic code with sucrase and runs it against the
  module object.
- `test/parity-r1.test.ts` replays every example row of round 1's action cases
  (`test/parity-r1.cases.ts`, generated from `feedback/feedback-r1/values.json`): rows of fixed
  cases must match the reference within the report's tolerance; kept cases must still differ. Tests
  named "parity r1 <case id>" check the individual changes.
- `test/parity-r2.test.ts` does the same for round 2's spring rows (`test/parity-r2.cases.ts`, from
  `feedback/feedback-r2/values.json`); the replay helpers are in `test/helpers/parity.ts`. Tests
  named "parity r2 <case id>" check the media changes in `test/video.test.tsx` and
  `test/audio.test.tsx` and the spring step rule in `test/spring.test.ts`.
- `notes/fit/` holds the scripts that derive every formula or constant adopted from the parity rows
  (`node notes/fit/<script>.js .` from this folder): `r1-derive.js` (round 1),
  `r2-spring-steps.js` and `r2-media-rules.js` (round 2). They read only the feedback files and
  print, for each rule, the candidates tried and how well each fits.

## 9. Parity round 1

Round 1 compared this runtime with the original library, version 4.0.481, which is older than the
documentation SPEC.md was written from. The policy applied, case by case:

1. Where this runtime threw and the reference returned a value, the input is now accepted and
   behaves like the reference, unless SPEC.md documents the error explicitly.
2. Where both returned different values: if SPEC.md leaves the behaviour open, the reference's
   behaviour (as its rows show) is adopted; if SPEC.md documents it and dates it after 4.0.481, this
   runtime's behaviour is kept; if SPEC.md documents it without a date, the decision is made from
   SPEC.md (recorded below).
3. Informational cases (the reference throws, this runtime returns a value) need no change unless
   SPEC.md requires the throw.

A rule used for mixed cases: when a feature is dated after 4.0.481 but the specific question is one
SPEC.md lists as unspecified (for example how `output: "perceptual-scale"` treats tuples, what
`outputType: "font-weight"` returns, how a transform-origin value is formatted), the question counts
as open, and the reference's behaviour is adopted. The reference shows the feature's absence there,
which is a valid answer to the open question. The documented part of the feature is kept.

### 9.1 Changed to the reference's behaviour (SPEC open)

The constants and formulas below are derived from round 1's rows by `notes/fit/r1-derive.js`
(64 ms per frame, the whole-frame stretch counts 28/39/23/62, `back`'s s = 1.70158, the `elastic`,
`exp` and `bounce` formulas, `bezier` holding 0 and 1, D65 against D50 for `lab()`/`lch()`, 8-bit
keyframe colours, and the end-segment `wrap`).

- Easing formulas: `exp`, `elastic`, `back`'s default, `bounce`, `bezier` (and `ease`) outside
  0..1, `poly(0)`, negative `elastic` bounciness (section 5.14).
- `Easing.spring` and stretched `spring()`: whole-frame settle length scaled onto the duration,
  exactly `to` after a stretched spring's duration, 64 ms per frame at most, never exactly `to` for
  an unstretched spring, unusual config values accepted (section 5.13).
- `interpolate`: NaN and infinite inputs, the interior-keyframe segment, `wrap` on multi-segment
  ranges, plain-floor `posterize`, `identity` with CSS strings and tuples, unknown option values,
  `perceptual-scale` on non-numbers, an `outputType` that does not fit, `font-weight` results,
  transform-origin component count, CSS values under `Easing.step1` (section 5.11).
- `interpolateColors`: D65 Lab/LCH, 8-bit keyframe colours, unclamped results, equal-channel rule
  for NaN progress, the interior-keyframe segment (section 5.12).
- `random`: NaN and infinite seeds give 0 (section 5.15).
- `<AbsoluteFill>` Tailwind detection (section 5.1).

### 9.2 Kept: SPEC.md documents the behaviour and dates it after 4.0.481

The reference lacks these, and the differences it shows come from that.

- `output: "perceptual-scale"` on numbers (v4.0.490).
- `Easing.spring`'s `allowTail` and `durationRestThreshold` (v4.0.483). The base curve now matches;
  the tail and the custom threshold stay.
- `trimBefore` on `<Sequence>` (v4.0.482) and on `<Series.Sequence>` (v4.0.497); `playbackRate` on
  `<Sequence>`, `<Series>`, `<Series.Sequence>` and `<Loop>` (v4.0.528). This includes
  `useVideoConfig().durationInFrames`, where SPEC's own worked example (90) depends on them.
- `<AbsoluteFill>`'s timing props (v4.0.501), `hidden` included.
- The crop props on `<Sequence>` (v4.0.500).

### 9.3 Kept: SPEC.md documents the behaviour without a date (decided from SPEC.md)

- `loop` on `<Sequence>`, and `Loop.useLoop()` inside a looping Sequence: SPEC 12 documents both
  explicitly ("plays the child range ... again and again until the parent is over"; "inside a
  looping Sequence, `Loop.useLoop()` reports the current iteration"). The 4.0.481 reference
  behaves as if the prop did not exist (no repetition, `useLoop()` is `null`), which suggests a
  later feature. SPEC is followed.
- `overshootClamping` on a decreasing spring (`from > to`): SPEC 6 says "any value beyond `to` is
  replaced by `to`". For a spring moving downwards, "beyond" is below `to` (past the target in the
  direction of travel), so those values are clamped. Round 2 showed that the reference does not clamp
  increasing springs either: its `overshootClamping` had no observable effect in any row of either
  round (section 10.3). SPEC is followed in both directions.

### 9.4 No change

- Informational cases (color-031, color-032, color-033, color-034, color-036, color-038, color-067,
  interp-130, interp-161, interp-169, interp-170, interp-171, interp-177, interp-178, interp-179,
  interp-180, interp-185, interp-186, interp-191, spring-037): the reference throws where this
  runtime returns a value. Only their ids were provided; SPEC.md documents no error that would
  require a throw in any of the behaviours they could target.
- Compositions the reference refused to render (`interpolate-strings`, `sequence-edge-fractional`,
  `series-edge`): the reference throws (they use discrete strings and booleans from v4.0.509 and
  v4.0.530, fractional timing values, and Series rates and offsets). SPEC.md requires no throw there.

## 10. Parity round 2 (and BRIEF v5)

BRIEF.md v5 changes section 5's fixed message to "... or choose the Remotion add-on as the graphics
renderer in Help → Graphics add-on…." (U+2192 arrow, U+2026 ellipsis, then a full stop). The module
object uses it exactly; `test/moduleObject.test.tsx` and `test/errors.test.ts` check it.

Round 2 applied the same policy as round 1 (section 9) to spring cases at 10, 15, 16 and 24 fps and
to a media batch rendered by both implementations. New in this round: every formula or constant
adopted from the rows is derived by a script kept in `notes/fit/` (copied from `$TMPDIR/fit/`). A
rule that no script could derive from the rows was not adopted.

### 10.1 Derivation scripts

- `notes/fit/r2-spring-steps.js`: inverts the round-1 curve for every round-2 row and tests five
  rules for turning a fractional frame into time. Only "whole steps of at most 64 ms, the first
  spanning 1 + the fraction" fits all 24 unclamped rows. It also shows that the 12
  `overshootClamping` rows are exactly the unclamped curve.
- `notes/fit/r2-media-rules.js`: reads the composition headers (frames compared), the rows (frames
  that differed) and the frame images (decoded PNG pixels):
  1. source-frame rounding: round half up fits 34 of 35 observations (floor 20, half even 29,
     half down 26, ceil 30); the misfit is `offthread-rate-half` frame 59 (section 5.5);
  2. `from` on a media element: "hidden before `from`, source not shifted" is the only fit;
  3. `trimAfter` at a playbackRate other than 1: "`trimAfter - trimBefore` parent frames, not divided
     by the rate" is the only fit across `offthread-trim-rate`, `offthread-trim`, `offthread-endat`
     and `video-trim-legacy`;
  4. object-fit: in `offthread-style` and `video-style` the expected frames show the box background
     above and below the frame in an 800x800 box (letterboxed), where this runtime stretched it.
- `notes/fit/r1-derive.js`: the round-1 constants (section 9.1), re-derived from round 1's rows.

### 10.2 Changed to the reference's behaviour (SPEC or BRIEF leave it open)

- Spring time for fractional frames (all value cases except the clamp ones; section 5.13).
- Video source frame: nearest frame, ties up (`offthread-25fps`, `offthread-rate-half`,
  `offthread-rate-fractional`, and the width-only box of `video-style`; BRIEF 6.3 leaves rounding to
  the implementer; section 5.5).
- `from` on media components (`offthread-from-prop`; SPEC 10.7 leaves it open; section 5.5).
- `trimAfter`/`endAt` at a playbackRate other than 1 (`offthread-trim-rate`; SPEC 18.3 leaves the
  units open; section 5.5).
- `object-fit: contain` by default on video frames (`offthread-style`, `video-style`; SPEC does not
  say how a frame fits a box of another shape; section 5.6).

### 10.3 Kept

- `overshootClamping` (the four `clamp-fromto` value cases): SPEC 6 documents it without a date
  ("with `true`, any value beyond `to` is replaced by `to`"). The reference's `overshootClamping` had
  no observable effect in any row of either round; this runtime clamps as SPEC says.
- `img-in-fill`: with no size props, the reference lets an image and a video frame take whatever
  size the flex container gives them. BRIEF 6.2 (and 6.3 for video) requires this runtime to set
  the `<img>`'s width and height attributes to the asset's size in that case, and BRIEF overrides
  SPEC. The new `object-fit: contain` does not change this.
- `video-in-sequence-rate`: the difference comes from the Sequence's `playbackRate` (SPEC v4.0.528),
  which the reference ignores; the media's own rate and the rounding agree.
- `freeze-video` (audio): SPEC 15 documents that `<Video>` children of an active `<Freeze>` are
  paused, so this runtime gives no cue while frozen (sound on frames 0-59 only). The reference's
  sound differs (31 dB, 4 sound edges against this runtime's 2); the aggregate metric does not show
  what it plays, and SPEC decides.

### 10.4 Not adopted: no rule can be derived from the rows

- `video-loop`: frames 1, 88, 91 and 178 differ in content, the rest agree. At frames 1 and 91 the
  reference shows source frame 1 where `2 * (f mod 90)` gives 2; every source position here is an
  exact integer, so no rounding rule explains it, and frames 45, 89, 135 and 179 follow the formula.
  SPEC 19 says `<Html5Video>`'s frame accuracy is "not guaranteed" (a browser `<video>` seeking);
  ZedMix draws the exact frame.
- `audio-volume-step-sequence`: the reference's volume step comes before this runtime's (frame 60),
  but "trimBefore included" (frame 45) and "composition frame" (frame 30) both give the reported
  13.98 dB and 0.02 ms, so the rows cannot tell which rule the reference uses.
- `audio-volume-callback` (2.15 dB, 9.1 ms) and `audio-loop-volume-extend` (1.11 dB, 1.54 ms): a
  ramping volume differs by less than a frame's worth at its quiet end. The cues carry the callback's
  value at each frame (BRIEF 6.4); how the volume changes within a frame is not in the cue data, and
  one aggregate figure per composition does not determine a rule.
- `offthread-sound`: identical levels (0 dB) with one sound edge 9.35 ms away, below one frame
  (33 ms). The cues start and stop on the right frames; a sub-frame offset is not expressible in
  per-frame cues and no rule follows from one figure.

### 10.5 No change

- `host_side_informational` compositions (`img-sizes`, `img-timing`, `video-plain`,
  `freeze-video` render, `html5video-trimbefore`, `video-loop-range`, `video-loop-trimbefore`,
  `video-rate-2`, `video-sound-muted`): differences from the host's decoding pipeline.
- No informational value cases this round.
