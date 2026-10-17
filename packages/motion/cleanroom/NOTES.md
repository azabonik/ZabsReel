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
  user's `style` on top. Tailwind detection looks only at classes without a variant prefix (`md:`,
  `hover:` and so on): `static|fixed|absolute|relative|sticky` (position); `block`, `flex`, `grid`,
  `hidden`, `inline*`, `contents`, `table`, `flow-root`, `list-item` (display);
  `flex-row|flex-col[-reverse]` (flexDirection); `inset-*`, `inset-x-*`, `inset-y-*`, `top-*`,
  `right-*`, `bottom-*`, `left-*` (sides); `w-*`, `h-*`, `size-*` (size). The important marker
  (`!x` or `x!`) and the negative dash are stripped first.
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

- Media components accept `from` (default 0), as a Sequence does (SPEC 10.6 and 10.7 leave it
  open).
- Media-local frame: `trimBefore + (f - from) * playbackRate`, where `f` already carries the
  enclosing Sequences' shifts and rates, so rates multiply. With `loop`:
  `trimBefore + ((f - from) * playbackRate) mod length`. Before `from`, or past
  `durationInFrames`, nothing is mounted.
- Without `durationInFrames`, a non-looping media stays mounted to the end of its parent: the video
  shows its last frame (the clamp) and audio keeps producing cues past the source end (the host
  trims them).
- Loop length without `durationInFrames`: the rest of the source after `trimBefore`, i.e.
  `frameCount / fps` seconds for video and `durationSeconds` for audio, in composition frames. If
  nothing is left, `graphic_api_misuse`. A loop longer than the source shows the video's last
  frame (or gives audio source times past the end) for the rest of each iteration.
- `trimBefore`, `durationInFrames` and `trimAfter` count media-local frames at the composition's
  fps, before `playbackRate` (so the media takes `durationInFrames / playbackRate` parent frames).
  `trimAfter` is the frame where playback stops, counted from the source start, so
  `durationInFrames = trimAfter - trimBefore`; it must be greater than `trimBefore`.
  `startFrom`/`endAt` are the old names. Mixing old and new names, or giving `trimAfter` together
  with `durationInFrames`, throws `graphic_api_misuse`. A media `playbackRate` must be positive and
  finite; one that changes between frames is used as given.
- Seconds = media-local frame / composition fps. Source frame = floor(seconds × asset fps + 1e-9),
  clamped to `0..frameCount-1`. A negative media-local frame (only possible with a negative
  `trimBefore`) fails with `graphic_media_time`, for muted sources too.
- A video inside `<Freeze>` shows the frame for the frozen time and is silent; audio inside
  `<Freeze>` adds no cue.
- `volume`: default 1; a number, or a function called during render with the frame counted from
  the media's own start on its parent's timeline (`f - from`, not scaled by the media's own rate).
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
  `height`, `style.width`, `style.height` (BRIEF 6.2). The `ref` of `<Img>` and of both video
  components is the `<img>`. `<Html5Audio>` does not attach refs.
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
- Hooks and components used outside a graphic that ZabsReel renders throw `graphic_api_misuse`.
  `Loop.useLoop()` returns `null` (as documented) and `<AbsoluteFill>` without timing props works
  anywhere.

### 5.10 Module object

- A `Proxy` over an empty, extensible object. `ownKeys` lists exactly the export names; `has` is
  true for them and for `__esModule`. Writing, defining, deleting, changing the prototype and
  `preventExtensions` (so `Object.freeze`) throw `graphic_api_misuse`.

### 5.11 interpolate()

- `inputRange` must hold finite numbers and be strictly increasing; the input must be a finite
  number. Every violated constraint (these, and the ones SPEC states) throws `graphic_api_misuse`.
- At an interior keyframe the segment that starts there applies (progress 0).
- `extend` uses the first or last segment's mapping, including its easing, with progress outside
  0..1.
- `wrap` maps the input into `[first, last)` with a positive modulo, on either side.
- `identity` returns the (posterized) input; it is only allowed with plain number outputs.
- `posterize: n` uses `floor(input / n) * n` (an input within 1e-9 of a multiple counts as on it),
  for any positive `n` and for negative inputs alike, before extrapolation.
- CSS transform strings: components separated by spaces, at most three. Detection without
  `outputType`: the first of scale, translate, rotate, transform-origin that every keyframe fits.
  Scale needs unitless numbers; translate lengths or percentages; rotate `deg|rad|grad|turn`;
  transform-origin keywords (normalized to percentages; `top left` equals `left top`), lengths and
  percentages, and a length as the third component. A length-only range is detected as translate;
  pass `outputType: "transform-origin"` for a length-only origin. A bare `0` takes the unit the
  other keyframes use. Missing components: scale 1, translate and rotate 0, transform-origin 50%
  (x, y) and 0 (z). Results: each number rounded to 6 decimals, then its unit, joined by single
  spaces (`"50px 25px"`).
- `outputType: "font-weight"`: numbers, numeric strings, `"normal"` (400) and `"bold"` (700); the
  result is a number. Other keywords throw `graphic_api_misuse`.
- Strings with `Easing.step1` on every segment are discrete strings and come back verbatim; other
  strings are CSS values; strings that fit no CSS type throw `graphic_api_misuse`.
- Numeric tuples return a new array of numbers.
- `output: "perceptual-scale"` works for numbers, numeric tuples (per component) and scale strings;
  anything else throws `graphic_api_misuse`.
- `Easing.spring({ allowTail: true })` on a segment: when a later segment applies, the earlier
  segment's leftover motion (its easing evaluated past progress 1, minus 1, times that segment's
  output change) is added to the result. This makes the value continuous at the keyframe.

### 5.12 interpolateColors()

- Accepted: the CSS named colours and `transparent`; `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`;
  `rgb()`/`rgba()`/`hsl()`/`hsla()` in comma or space syntax (numbers or percentages); `hwb()`,
  `lab()`, `lch()`, `oklab()`, `oklch()` in space syntax with an optional `/ alpha`; `none` as 0;
  hue units `deg`, `rad`, `grad`, `turn`. `currentColor` and anything else throw
  `graphic_api_misuse`.
- Every colour is converted to sRGB (CSS Color 4 conversions; Lab and LCH use D50) and interpolated
  per channel in non-premultiplied sRGB, alpha included.
- Inputs outside the input range hold the first or last colour (there is no extrapolation).
- Channels are clamped to 0..255 and rounded to whole numbers; alpha is clamped to 0..1 and rounded
  to 3 decimals. Format: `rgba(r, g, b, a)` with `", "` separators.

### 5.13 spring() and measureSpring()

- Model: the exact solution of a damped spring released at rest, with the damping ratio
  `damping / (2 * sqrt(stiffness * mass))` capped at 1. So every `damping >= 2 * sqrt(stiffness *
  mass)` gives the same, critically damped, curve: overdamped settings cannot be told apart from
  critical damping. High-damping springs (such as `damping: 200`) therefore settle in well under a
  second. The model also reproduces SPEC 7's documented `measureSpring` example (23), which a
  physically overdamped curve (about 318 frames) would not. Other curves are not meant to match any
  other library numerically.
- `measureSpring` returns a whole number of frames: the smallest frame from which every later frame
  is within `threshold` of the target. Distance is measured on the 0-to-1 curve, so `from` and `to`
  do not matter. An undamped spring returns `Infinity`.
- The default of `durationRestThreshold` is 0.005 (the same as `measureSpring`'s `threshold`).
- `durationInFrames`: the curve is stretched so that the last moment it is `durationRestThreshold`
  (as a share of the distance) away from `to` falls exactly on `durationInFrames`. This uses the
  continuous settle time, not `measureSpring`'s whole-frame value.
- `reverse` without `durationInFrames` uses `measureSpring`'s length (threshold 0.005). The value at
  frame `g` (after the delay) is the curve at `length - g`, so a reversed spring starts near `to`
  (within the threshold) and holds `from` once it is over.
- Before its start (negative frames, or during `delay`) the spring holds its starting value: `from`,
  or, for a reversed spring, the value at its length.
- The value approaches `to` and is never snapped to it (except by `overshootClamping`).
- Fractional frames are evaluated on the continuous curve.
- Invalid input (`fps <= 0`, a non-finite `frame`, `mass <= 0`, `stiffness <= 0`, `damping < 0`,
  `durationInFrames <= 0`, `durationRestThreshold` outside (0, 1), non-finite `from`/`to`/`delay`)
  throws `graphic_api_misuse`, as does stretching or reversing an undamped spring.

### 5.14 Easing

- `ease` is `bezier(0.42, 0, 1, 1)` (the preset SPEC links).
- `sin(t) = 1 - cos(t * pi / 2)`; `circle(t) = 1 - sqrt(1 - t^2)` with `t` clamped to 0..1;
  `exp(t) = 2^(10 (t - 1))`, and 0 for `t <= 0`.
- `elastic(bounciness = 1)`: `1 - (1 - t)^2 * cos((bounciness + 0.5) * pi * t)`, `t` clamped to
  0..1. 0 never overshoots; 1 overshoots once; `N` swings past the end about `N` times. Negative
  bounciness throws `graphic_api_misuse`.
- `back(s = 1.5)`: `t^3 - s * t^2 * (1 - t)`, which dips about 8 % below 0 with the default.
- `bounce`: the "in" form of a ball drop with three bounces, each keeping half the speed;
  `Easing.out(Easing.bounce)` is the drop itself. `t` is clamped to 0..1.
- `in(e) = e`; `out(e)(t) = 1 - e(1 - t)`; `inOut(e)(t) = e(2t) / 2` for `t < 0.5`, else
  `1 - e(2 (1 - t)) / 2`.
- `step0` and `step1` return 0 when their condition is false.
- `bezier` needs `x1` and `x2` in 0..1; outside 0..1 the progress follows the curve's end tangents.
- The polynomial, trigonometric and `back` formulas are evaluated as written for progress outside
  0..1.
- `Easing.spring(config)`: the spring is stretched so that it comes within `durationRestThreshold`
  (default 0.005) of its end exactly at progress 1, so the 30-frame span and its fps cancel out.
  Without `allowTail`, progress >= 1 gives exactly 1; with it, the spring keeps moving past 1.

### 5.15 random()

- Own hash: the seed becomes a key (`#` + `String(n)` for numbers, `$` + the string for strings),
  hashed in two 32-bit lanes into 53 bits; the result is in `[0, 1)`. `random(1)` and `random("1")`
  differ; `-0` and `0` are the same seed. Values are stable for as long as this hash is unchanged.
  They do not match SPEC's documented `random(1)`, which SPEC says cannot be reproduced.
- `random(null)` returns `Math.random()`. The module object's `random` calls `host.log` once per
  host, on the first `random(null)`; `index.ts`'s `random` logs nothing (it has no host).
- Non-finite numbers, `undefined`, booleans, objects and no argument throw `graphic_api_misuse`.

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
- `random()`'s numbers and `spring()`'s curves are this runtime's own and do not reproduce
  Remotion's values (SPEC says they cannot be reproduced from the spec), except the documented
  `measureSpring` example.

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
