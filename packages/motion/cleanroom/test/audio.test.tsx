import "./helpers/dom";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { asset, Audio, Freeze, Html5Audio, Html5Video, Loop, OffthreadVideo, Sequence, useCurrentFrame } from "../runtime/src/index";
import type { AudioCue } from "../runtime/src/host";
import { audioAsset, makeHost, mount, rejectsWithCode, renderLoaded, videoAsset } from "./helpers/host";
import type { Mounted } from "./helpers/host";

const assets = {
  song: audioAsset("h-song", 20),
  voice: audioAsset("h-voice", 4),
  clip: videoAsset("h-clip", { hasAudio: true }),
  silent: videoAsset("h-silent", { hasAudio: false }),
};

async function cuesAt(tree: React.ReactElement | React.ComponentType, at: number[]): Promise<AudioCue[][]> {
  const Component = typeof tree === "function" ? tree : () => tree;
  const m = mount(makeHost({ assets }), Component as React.ComponentType<Record<string, unknown>>);
  const out: AudioCue[][] = [];
  for (const f of at) out.push((await renderLoaded(m, f)).cues);
  m.app.unmount();
  return out;
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const times = (cues: AudioCue[][]) => cues.map((c) => c.map((x) => r6(x.sourceTime)));
const volumes = (cues: AudioCue[][]) => cues.map((c) => c.map((x) => x.volume));

test("an audio source adds one cue per frame: sourceKey, handle, sourceTime (seconds) and volume", async () => {
  const [cues] = await cuesAt(<Html5Audio src={asset("song")} />, [45]);
  assert.equal(cues.length, 1);
  assert.deepEqual(Object.keys(cues[0]).sort(), ["handle", "sourceKey", "sourceTime", "volume"]);
  assert.equal(cues[0].handle, "h-song");
  assert.equal(cues[0].sourceTime, 1.5);
  assert.equal(cues[0].volume, 1);
  assert.equal(typeof cues[0].sourceKey, "string");
});

test("Audio is Html5Audio", async () => {
  assert.equal(Audio, Html5Audio);
});

test("sourceTime follows trimBefore, playbackRate and enclosing Sequences", async () => {
  assert.deepEqual(times(await cuesAt(<Html5Audio src="song" trimBefore={60} />, [0, 30])), [[2], [3]]);
  assert.deepEqual(times(await cuesAt(<Html5Audio src="song" playbackRate={2} />, [15])), [[1]]);
  assert.deepEqual(
    times(
      await cuesAt(
        <Sequence from={30} playbackRate={0.5}>
          <Html5Audio src="song" />
        </Sequence>,
        [29, 30, 90],
      ),
    ),
    [[], [0], [1]],
  );
});

test("durationInFrames limits the audio; loop repeats the range", async () => {
  assert.deepEqual(times(await cuesAt(<Html5Audio src="song" durationInFrames={30} />, [29, 30])), [[r6(29 / 30)], []]);
  assert.deepEqual(
    times(await cuesAt(<Html5Audio src="song" trimBefore={30} durationInFrames={30} loop />, [0, 35])),
    [[1], [r6(7 / 6)]],
  );
});

test("recorded choice: audio loop without durationInFrames repeats the rest of the source (durationSeconds)", async () => {
  // voice lasts 4 s = 120 composition frames.
  assert.deepEqual(times(await cuesAt(<Html5Audio src="voice" loop />, [119, 120, 150])), [[r6(119 / 30)], [0], [1]]);
});

test("a source time past the end of the source is allowed (the host trims it)", async () => {
  assert.deepEqual(times(await cuesAt(<Html5Audio src="voice" />, [200])), [[r6(200 / 30)]]);
});

test("a negative source time fails the frame with graphic_media_time", async () => {
  const m = mount(makeHost({ assets }), () => <Html5Audio src="song" trimBefore={-10} />);
  await rejectsWithCode(m.app.renderFrame(0), "graphic_media_time");
  m.app.unmount();
});

test("muted adds no cue and may change from frame to frame", async () => {
  function MutedMiddle() {
    const f = useCurrentFrame();
    return <Html5Audio src="voice" muted={f >= 60 && f <= 89} />;
  }
  const cues = await cuesAt(MutedMiddle, [59, 60, 89, 90]);
  assert.deepEqual(cues.map((c) => c.length), [1, 0, 0, 1]);
});

test("an unmuted source at volume 0 still adds its cue, with volume 0", async () => {
  assert.deepEqual(volumes(await cuesAt(<Html5Audio src="song" volume={0} />, [0])), [[0]]);
});

test("volume is clamped to 0..4 (NaN -> 0), whether or not useWebAudioApi is set", async () => {
  for (const [volume, expected] of [
    [0.5, 0.5],
    [3, 3],
    [9, 4],
    [-1, 0],
    [Number.NaN, 0],
  ] as const) {
    assert.deepEqual(volumes(await cuesAt(<Html5Audio src="song" volume={volume} />, [0])), [[expected]]);
    assert.deepEqual(volumes(await cuesAt(<Html5Audio src="song" volume={volume} useWebAudioApi />, [0])), [[expected]]);
  }
});

test("recorded choice: the volume callback gets the media's frame on its parent's timeline, unscaled by its rate; from does not change it", async () => {
  const seen: number[] = [];
  const cues = await cuesAt(
    <Sequence from={10}>
      <Html5Audio
        src="song"
        from={5}
        playbackRate={2}
        volume={(f) => {
          seen.push(f);
          return f / 20;
        }}
      />
    </Sequence>,
    [14, 15, 20],
  );
  // Hidden before the Sequence's frame 5; the callback then gets 5 and 10 (the Sequence's frames).
  assert.deepEqual(volumes(cues), [[], [0.25], [0.5]]);
  assert.ok(seen.includes(5) && seen.includes(10) && !seen.includes(0));
});

test("parity r2 offthread-from-prop, recorded choice: from on audio hides it until then; the source time is not shifted", async () => {
  assert.deepEqual(times(await cuesAt(<Html5Audio src="song" from={30} />, [29, 30, 45])), [[], [1], [1.5]]);
});

test("recorded choice: a volume callback result that is not a number counts as NaN, so 0", async () => {
  assert.deepEqual(volumes(await cuesAt(<Html5Audio src="song" volume={() => "loud" as unknown as number} />, [0])), [[0]]);
});

test("recorded choice: volume that is neither a number nor a function throws graphic_api_misuse", async () => {
  const m = mount(makeHost({ assets }), () => <Html5Audio src="song" volume={"0.5" as unknown as number} />);
  await rejectsWithCode(m.app.renderFrame(0), "graphic_api_misuse");
  m.app.unmount();
});

test("an error thrown by the volume callback passes through", async () => {
  const mine = new Error("volume broke");
  const m = mount(makeHost({ assets }), () => (
    <Html5Audio
      src="song"
      volume={() => {
        throw mine;
      }}
    />
  ));
  await assert.rejects(m.app.renderFrame(0), (e) => e === mine);
  m.app.unmount();
});

test("loopVolumeCurveBehavior: repeat restarts the callback's frame each iteration; extend keeps counting", async () => {
  const repeat = await cuesAt(<Html5Audio src="song" durationInFrames={20} loop volume={(f) => f / 100} />, [5, 25]);
  assert.deepEqual(volumes(repeat), [[0.05], [0.05]]);
  const extend = await cuesAt(
    <Html5Audio src="song" durationInFrames={20} loop loopVolumeCurveBehavior="extend" volume={(f) => f / 100} />,
    [5, 25],
  );
  assert.deepEqual(volumes(extend), [[0.05], [0.25]]);
});

test("recorded choice: loopVolumeCurveBehavior also covers an enclosing <Loop> (OffthreadVideo)", async () => {
  const tree = (behavior: "repeat" | "extend") => (
    <Loop durationInFrames={20}>
      <OffthreadVideo src="clip" loopVolumeCurveBehavior={behavior} volume={(f) => f / 100} />
    </Loop>
  );
  assert.deepEqual(volumes(await cuesAt(tree("repeat"), [25])), [[0.05]]);
  assert.deepEqual(volumes(await cuesAt(tree("extend"), [25])), [[0.25]]);
});

test("recorded choice: an invalid loopVolumeCurveBehavior throws graphic_api_misuse", async () => {
  const m = mount(makeHost({ assets }), () => (
    <Html5Audio src="song" loopVolumeCurveBehavior={"bounce" as "repeat"} />
  ));
  await rejectsWithCode(m.app.renderFrame(0), "graphic_api_misuse");
  m.app.unmount();
});

test("a video adds a cue only if its asset has audio; a muted video adds none", async () => {
  const [withSound] = await cuesAt(<Html5Video src="clip" />, [30]);
  assert.equal(withSound.length, 1);
  assert.equal(withSound[0].handle, "h-clip");
  assert.equal(withSound[0].sourceTime, 1);
  assert.deepEqual(await cuesAt(<Html5Video src="silent" />, [30]), [[]]);
  assert.deepEqual(await cuesAt(<OffthreadVideo src="clip" muted />, [30]), [[]]);
});

test("Freeze: audio renders muted and a paused video is silent", async () => {
  assert.deepEqual(
    await cuesAt(
      <Freeze frame={10}>
        <Html5Audio src="song" />
        <Html5Video src="clip" />
      </Freeze>,
      [0],
    ),
    [[]],
  );
});

test("cues come in React tree order", async () => {
  const [cues] = await cuesAt(
    <>
      <Html5Audio src="song" volume={0.1} />
      <Sequence>
        <Html5Video src="clip" volume={0.2} />
        <Sequence>
          <Html5Audio src="voice" volume={0.3} />
        </Sequence>
      </Sequence>
      <Html5Audio src="song" volume={0.4} />
    </>,
    [0],
  );
  assert.deepEqual(cues.map((c) => c.volume), [0.1, 0.2, 0.3, 0.4]);
});

test("tree order holds when a source mounts later than the ones after it", async () => {
  const [, cues] = await cuesAt(
    <>
      <Sequence from={1}>
        <Html5Audio src="voice" volume={0.1} />
      </Sequence>
      <Html5Audio src="song" volume={0.2} />
    </>,
    [0, 1],
  );
  assert.deepEqual(cues.map((c) => c.volume), [0.1, 0.2]);
});

test("sourceKey: stable while mounted, distinct for two elements with the same asset, new after a remount", async () => {
  function Two() {
    const f = useCurrentFrame();
    return (
      <>
        <Html5Audio src="song" />
        <Html5Audio src="song" />
        {f < 2 || f > 3 ? <Html5Audio src="voice" /> : null}
      </>
    );
  }
  const [a, b, c, d] = await cuesAt(Two, [0, 1, 2, 4]);
  assert.notEqual(a[0].sourceKey, a[1].sourceKey);
  assert.deepEqual(a.map((x) => x.sourceKey), b.map((x) => x.sourceKey));
  assert.deepEqual(c.map((x) => x.sourceKey), a.slice(0, 2).map((x) => x.sourceKey));
  assert.notEqual(d[2].sourceKey, a[2].sourceKey, "the remounted element gets a new key");
  assert.equal(d[0].sourceKey, a[0].sourceKey);
});

test("cap: 8 cues per frame are fine; a 9th fails with graphic_audio_cues_cap", async () => {
  const many = (n: number) => (
    <>
      {Array.from({ length: n }, (_, i) => (
        <Html5Audio key={i} src="song" />
      ))}
    </>
  );
  const [eight] = await cuesAt(many(8), [0]);
  assert.equal(eight.length, 8);
  const m = mount(makeHost({ assets }), () => many(9));
  await rejectsWithCode(m.app.renderFrame(0), "graphic_audio_cues_cap");
  m.app.unmount();
  // Muted sources do not count.
  const [mutedExtra] = await cuesAt(
    <>
      {many(8)}
      <Html5Audio src="song" muted />
    </>,
    [0],
  );
  assert.equal(mutedExtra.length, 8);
});

test("audio src must be an audio asset; a video asset is the wrong kind", async () => {
  for (const [src, code] of [
    ["clip", "graphic_asset_kind"],
    ["missing", "graphic_asset_unknown"],
    ["https://x.test/a.mp3", "graphic_media_ref"],
  ] as const) {
    const m = mount(makeHost({ assets }), () => <Html5Audio src={src} />);
    await rejectsWithCode(m.app.renderFrame(0), code);
    m.app.unmount();
  }
});

test("recorded choice: Html5Audio renders a hidden, empty <audio> element with no src", async () => {
  const m = mount(makeHost({ assets }), () => <Html5Audio src="song" crossOrigin="anonymous" />);
  await m.app.renderFrame(0);
  const el = m.container.querySelector("audio") as HTMLAudioElement;
  assert.ok(el);
  assert.equal(el.hidden, true);
  assert.equal(el.getAttribute("src"), null);
  assert.equal(el.attributes.length, 1, "only the hidden attribute");
  m.app.unmount();
});

test("Html5Audio accepts and ignores its ignored props", async () => {
  const [cues] = await cuesAt(
    <Html5Audio
      src="song"
      toneFrequency={0.5}
      preservePitch={false}
      audioStreamIndex={1}
      acceptableTimeShiftInSeconds={1}
      pauseWhenBuffering
      allowAmplificationDuringRender
      delayRenderTimeoutInMilliseconds={1}
      delayRenderRetries={2}
      name="music"
      showInTimeline={false}
      onError={() => undefined}
    />,
    [30],
  );
  assert.deepEqual(cues.map((c) => [c.handle, c.sourceTime, c.volume]), [["h-song", 1, 1]]);
});

test("the runtime never plays sound: no media element has a source", async () => {
  const m = mount(makeHost({ assets }), () => (
    <>
      <Html5Audio src="song" />
      <Html5Video src="clip" />
    </>
  ));
  await renderLoaded(m as Mounted, 0);
  assert.equal(m.container.querySelectorAll("video").length, 0);
  for (const el of m.container.querySelectorAll("audio")) assert.equal(el.getAttribute("src"), null);
  m.app.unmount();
});

test("recorded choice: the volume callback is only called when the source adds a cue", async () => {
  let calls = 0;
  const volume = () => {
    calls++;
    return 1;
  };
  await cuesAt(
    <>
      <Html5Audio src="song" muted volume={volume} />
      <Html5Video src="silent" volume={volume} />
      <Freeze frame={3}>
        <Html5Audio src="song" volume={volume} />
      </Freeze>
    </>,
    [0, 1],
  );
  assert.equal(calls, 0);
});

test("recorded choice: a negative source time fails the frame even for a muted source", async () => {
  const m = mount(makeHost({ assets }), () => <Html5Audio src="song" muted trimBefore={-5} />);
  await rejectsWithCode(m.app.renderFrame(0), "graphic_media_time");
  m.app.unmount();
});

test("recorded choice: Html5Audio does not attach refs", async () => {
  const ref = React.createRef<HTMLAudioElement>();
  const m = mount(makeHost({ assets }), () => <Html5Audio ref={ref} src="song" />);
  await m.app.renderFrame(0);
  assert.equal(ref.current, null);
  m.app.unmount();
});
