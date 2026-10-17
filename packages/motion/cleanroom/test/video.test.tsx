import "./helpers/dom";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { asset, Freeze, Html5Video, Loop, OffthreadVideo, Sequence, Video } from "../runtime/src/index";
import {
  fireError,
  fireLoad,
  imageAsset,
  images,
  makeHost,
  mount,
  rejectsWithCode,
  renderLoaded,
  ticks,
  track,
  videoAsset,
} from "./helpers/host";
import type { Mounted } from "./helpers/host";

const assets = {
  clip: videoAsset("h-clip", { fps: 30, frameCount: 300, durationSeconds: 10 }),
  film: videoAsset("h-film", { fps: 24, frameCount: 48, durationSeconds: 2, width: 800, height: 450 }),
  logo: imageAsset("h-logo"),
};

function sourceFrame(m: Mounted, index = 0): number | null {
  const img = images(m.container)[index];
  if (!img) return null;
  const match = /[?&]f=(\d+)/.exec(img.getAttribute("src") ?? "");
  return match ? Number(match[1]) : null;
}

async function frames(tree: React.ReactElement, at: number[], hostAssets = assets): Promise<(number | null)[]> {
  const m = mount(makeHost({ assets: hostAssets }), () => tree);
  const out: (number | null)[] = [];
  for (const f of at) {
    await renderLoaded(m, f);
    out.push(sourceFrame(m));
  }
  m.app.unmount();
  return out;
}

test("video renders an <img> (no <video>) with mediaUrl(handle, asset size, source frame)", async () => {
  const m = mount(makeHost({ assets }), () => <Html5Video src={asset("clip")} />);
  await renderLoaded(m, 12);
  assert.equal(m.container.querySelector("video"), null);
  const [img] = images(m.container);
  assert.equal(img.getAttribute("src"), "https://media.test/h-clip?w=1920&h=1080&f=12");
  assert.equal(img.getAttribute("width"), "1920");
  assert.equal(img.getAttribute("height"), "1080");
  m.app.unmount();
});

test("Video and OffthreadVideo behave like Html5Video", async () => {
  assert.deepEqual(await frames(<Video src="clip" />, [0, 7]), [0, 7]);
  assert.deepEqual(await frames(<OffthreadVideo src="clip" />, [0, 7]), [0, 7]);
});

test("recorded choice: seconds use the composition fps, source frames the asset fps, rounded down", async () => {
  // 24 fps asset in a 30 fps composition: frame 10 is 0.333 s, source frame 8.
  assert.deepEqual(await frames(<Html5Video src="film" />, [0, 1, 10, 30]), [0, 0, 8, 24]);
});

test("the source frame is clamped to 0..frameCount-1 (the last frame keeps showing)", async () => {
  assert.deepEqual(await frames(<Html5Video src="film" />, [59, 60, 200]), [47, 47, 47]);
});

test("trimBefore, playbackRate and enclosing Sequences decide the source frame", async () => {
  // trimBefore={60} at 30 fps trims the first 2 seconds.
  assert.deepEqual(await frames(<Html5Video src="clip" trimBefore={60} />, [0, 10]), [60, 70]);
  assert.deepEqual(await frames(<Html5Video src="clip" playbackRate={2} />, [10]), [20]);
  assert.deepEqual(
    await frames(
      <Sequence from={30} playbackRate={2}>
        <Html5Video src="clip" playbackRate={1.5} />
      </Sequence>,
      [29, 30, 40],
    ),
    [null, 0, 30],
    "rates multiply",
  );
});

test("durationInFrames: the media takes durationInFrames / playbackRate parent frames", async () => {
  assert.deepEqual(
    await frames(<Html5Video src="clip" trimBefore={60} durationInFrames={60} playbackRate={2} />, [0, 29, 30]),
    [60, 118, null],
  );
});

test("recorded choice: trimAfter ends playback at that media-local frame; startFrom/endAt are the old names", async () => {
  assert.deepEqual(await frames(<Html5Video src="clip" trimBefore={10} trimAfter={20} />, [0, 9, 10]), [10, 19, null]);
  assert.deepEqual(await frames(<Html5Video src="clip" startFrom={10} endAt={20} />, [0, 9, 10]), [10, 19, null]);
});

test("recorded choice: mixing old and new trim names, or trimAfter with durationInFrames, throws graphic_api_misuse", async () => {
  for (const tree of [
    <Html5Video src="clip" startFrom={5} trimBefore={5} />,
    <Html5Video src="clip" endAt={5} trimAfter={6} />,
    <Html5Video src="clip" trimAfter={30} durationInFrames={10} />,
    <Html5Video src="clip" trimBefore={30} trimAfter={30} />,
    <Html5Video src="clip" playbackRate={0} />,
  ]) {
    const m = mount(makeHost({ assets }), () => tree);
    await rejectsWithCode(m.app.renderFrame(0), "graphic_api_misuse");
    m.app.unmount();
  }
});

test("loop with durationInFrames repeats the trimBefore/durationInFrames range", async () => {
  assert.deepEqual(
    await frames(<Html5Video src="clip" loop trimBefore={30} durationInFrames={30} />, [0, 29, 30, 65]),
    [30, 59, 30, 35],
  );
});

test("recorded choice: loop without durationInFrames repeats the rest of the source after trimBefore", async () => {
  // 300 source frames at 30 fps = 300 composition frames; after trimBefore 100, a 200-frame loop.
  assert.deepEqual(await frames(<Html5Video src="clip" loop trimBefore={100} />, [0, 199, 200, 250]), [100, 299, 100, 150]);
  // The 24 fps film lasts 2 s = 60 composition frames.
  assert.deepEqual(await frames(<Html5Video src="film" loop />, [59, 60, 61]), [47, 0, 0]);
});

test("recorded choice: loop when nothing of the source is left after trimBefore throws graphic_api_misuse", async () => {
  const m = mount(makeHost({ assets }), () => <Html5Video src="film" loop trimBefore={60} />);
  await rejectsWithCode(m.app.renderFrame(0), "graphic_api_misuse");
  m.app.unmount();
});

test("recorded choice: OffthreadVideo has no loop; the native loop attribute is dropped", async () => {
  assert.deepEqual(await frames(<OffthreadVideo src="film" loop />, [70]), [47]);
});

test("recorded choice: media accept from like a Sequence", async () => {
  assert.deepEqual(await frames(<Html5Video src="clip" from={20} />, [19, 20, 25]), [null, 0, 5]);
});

test("a negative source time fails the frame with graphic_media_time", async () => {
  const m = mount(makeHost({ assets }), () => <Html5Video src="clip" trimBefore={-30} />);
  await rejectsWithCode(m.app.renderFrame(0), "graphic_media_time");
  m.app.unmount();
  const ok = await frames(<Html5Video src="clip" trimBefore={-30} />, [40]);
  assert.deepEqual(ok, [10], "frames whose source time is not negative still render");
});

test("Freeze pauses a video on the frozen frame", async () => {
  assert.deepEqual(
    await frames(
      <Freeze frame={15}>
        <Html5Video src="clip" />
      </Freeze>,
      [0, 100],
    ),
    [15, 15],
  );
});

test("only width, height, style, className, id, aria-* and data-* reach the <img>", async () => {
  const m = mount(makeHost({ assets }), () => (
    <Html5Video
      src="clip"
      width={320}
      style={{ opacity: 0.5 }}
      className="v"
      id="vid"
      aria-label="clip"
      data-test="yes"
      autoPlay
      controls
      poster="p.png"
      playsInline
      onClick={() => undefined}
      title="dropped"
    />
  ));
  await renderLoaded(m, 0);
  const [img] = images(m.container);
  assert.equal(img.getAttribute("width"), "320");
  assert.equal(img.getAttribute("height"), null, "sized by the user, so no automatic size");
  assert.equal(img.style.opacity, "0.5");
  assert.equal(img.className, "v");
  assert.equal(img.id, "vid");
  assert.equal(img.getAttribute("aria-label"), "clip");
  assert.equal(img.getAttribute("data-test"), "yes");
  for (const attr of ["autoplay", "controls", "poster", "playsinline", "title"]) {
    assert.equal(img.getAttribute(attr), null, attr);
  }
  m.app.unmount();
});

test("video holds a delay until the frame's image loads; the timeout names the video", async () => {
  const m = mount(makeHost({ assets, frameTimeoutMs: 60 }), () => <Html5Video src="clip" />);
  const t = track(m.app.renderFrame(3));
  await ticks(5);
  assert.equal(t.settled(), false);
  fireLoad(images(m.container)[0]);
  await t.promise;
  const error = await rejectsWithCode(m.app.renderFrame(4), "graphic_frame_timeout");
  assert.ok(error.message.includes('"clip"'));
  m.app.unmount();
});

test("video error: onError is called, then the frame fails with graphic_media_failed naming the id", async () => {
  let called = 0;
  const m = mount(makeHost({ assets }), () => <OffthreadVideo src="clip" onError={() => called++} />);
  const pending = m.app.renderFrame(0);
  fireError(images(m.container)[0]);
  const error = await rejectsWithCode(pending, "graphic_media_failed");
  assert.ok(error.message.includes('"clip"'));
  assert.equal(called, 1);
  m.app.unmount();
});

test("video src must be a video asset", async () => {
  for (const [src, code] of [
    ["logo", "graphic_asset_kind"],
    ["missing", "graphic_asset_unknown"],
    ["clips/a.mp4", "graphic_media_ref"],
  ] as const) {
    const m = mount(makeHost({ assets }), () => <Html5Video src={src} />);
    await rejectsWithCode(m.app.renderFrame(0), code);
    m.app.unmount();
  }
});

test("onVideoFrame: once per composition frame, with the <img>, after load and before the frame settles", async () => {
  const calls: { args: unknown[]; src: string | null }[] = [];
  const m = mount(makeHost({ assets }), () => (
    <Html5Video src="clip" onVideoFrame={(...args: unknown[]) => calls.push({ args, src: (args[0] as HTMLImageElement).getAttribute("src") })} />
  ));
  const t = track(m.app.renderFrame(2));
  await ticks(3);
  assert.equal(calls.length, 0, "not before the image has loaded");
  fireLoad(images(m.container)[0]);
  await t.promise;
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args[0] instanceof window.HTMLImageElement);
  assert.equal(calls[0].args.length, 1);
  assert.equal(calls[0].args[1], undefined);
  assert.equal(calls[0].args[2], undefined);
  assert.ok(calls[0].src?.endsWith("f=2"));
  // The same frame again: the image is loaded already, the callback still runs once.
  await m.app.renderFrame(2);
  assert.equal(calls.length, 2);
  await renderLoaded(m, 3);
  assert.equal(calls.length, 3);
  m.app.unmount();
});

test("onVideoFrame runs every composition frame even when the source frame does not change", async () => {
  let calls = 0;
  const m = mount(makeHost({ assets }), () => (
    <Freeze frame={4}>
      <OffthreadVideo src="clip" onVideoFrame={() => calls++} />
    </Freeze>
  ));
  await renderLoaded(m, 0);
  await m.app.renderFrame(1);
  await m.app.renderFrame(2);
  assert.equal(calls, 3);
  m.app.unmount();
});

test("an error thrown by onVideoFrame passes through", async () => {
  const mine = new Error("frame callback broke");
  const m = mount(makeHost({ assets }), () => (
    <Html5Video
      src="clip"
      onVideoFrame={() => {
        throw mine;
      }}
    />
  ));
  const pending = m.app.renderFrame(0);
  fireLoad(images(m.container)[0]);
  await assert.rejects(pending, (e) => e === mine);
  m.app.unmount();
});

test("recorded choice: the video's ref is its <img>", async () => {
  const ref = React.createRef<HTMLImageElement>();
  const m = mount(makeHost({ assets }), () => <Html5Video ref={ref} src="clip" />);
  await renderLoaded(m, 0);
  assert.equal(ref.current, images(m.container)[0]);
  m.app.unmount();
});

test("video frames count toward the media cap", async () => {
  const m = mount(makeHost({ assets }), () => (
    <>
      {Array.from({ length: 9 }, (_, i) => (
        <Html5Video key={i} src="clip" muted />
      ))}
    </>
  ));
  await rejectsWithCode(m.app.renderFrame(0), "graphic_media_per_frame");
  m.app.unmount();
});

test("video inside a Loop restarts with each iteration", async () => {
  assert.deepEqual(
    await frames(
      <Loop durationInFrames={10}>
        <Html5Video src="clip" />
      </Loop>,
      [3, 13, 29],
    ),
    [3, 3, 9],
  );
});

test("video components accept and ignore their ignored props; none of them reaches the <img>", async () => {
  const m = mount(makeHost({ assets }), () => (
    <>
      <OffthreadVideo
        src="clip"
        transparent
        toneMapped={false}
        imageFormat="png"
        crossOrigin="anonymous"
        pauseWhenBuffering
        acceptableTimeShiftInSeconds={2}
        onAutoPlayError={() => undefined}
        preservePitch={false}
        toneFrequency={1.5}
        audioStreamIndex={1}
        useWebAudioApi
        allowAmplificationDuringRender
        delayRenderTimeoutInMilliseconds={1}
        delayRenderRetries={4}
        name="clip"
        showInTimeline={false}
      />
      <Html5Video src="clip" crossOrigin="use-credentials" muted />
    </>
  ));
  await renderLoaded(m, 5);
  for (const img of images(m.container)) {
    assert.deepEqual(
      [...img.attributes].map((a) => a.name).sort(),
      ["height", "src", "width"],
    );
  }
  assert.equal(sourceFrame(m), 5);
  m.app.unmount();
});

test("recorded choice: a loop longer than the source shows the last frame for the rest of each iteration", async () => {
  // The film is 60 composition frames long; a 90-frame loop holds its last frame from 60 to 89.
  assert.deepEqual(await frames(<Html5Video src="film" loop durationInFrames={90} />, [59, 70, 89, 95]), [47, 47, 47, 4]);
});
