import "./helpers/dom";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { asset, Img, Sequence, staticFile, useCurrentFrame } from "../runtime/src/index";
import { isAssetRef, resolveMediaSource } from "../runtime/src/assets";
import {
  audioAsset,
  fireError,
  fireLoad,
  fontAsset,
  imageAsset,
  images,
  makeHost,
  mount,
  rejectsWithCode,
  renderLoaded,
  throwsCode,
  ticks,
  track,
  videoAsset,
} from "./helpers/host";

const assets = {
  logo: imageAsset("h-logo", 640, 360),
  photo: imageAsset("h-photo", 100, 50),
  "folder/pic": imageAsset("h-folder", 10, 10),
  clip: videoAsset("h-clip"),
  song: audioAsset("h-song"),
  font: fontAsset("h-font"),
};

// ---- asset(), staticFile() and source resolution (BRIEF 6.1) ----

test("asset(id) returns a frozen reference; a reference and its id mean the same asset", () => {
  const ref = asset("logo");
  assert.ok(Object.isFrozen(ref));
  assert.ok(isAssetRef(ref));
  assert.equal(isAssetRef({ id: "logo" }), false, "a look-alike object is not a reference");
  const a = resolveMediaSource(ref, "image", assets, "<Img>");
  const b = resolveMediaSource("logo", "image", assets, "<Img>");
  assert.deepEqual(a, b);
});

test("asset() checks only that the id is a non-empty string (graphic_media_ref)", () => {
  for (const bad of ["", 5, null, undefined, {}]) {
    const error = throwsCode(() => asset(bad as string), "graphic_media_ref");
    assert.ok(error.message.includes('asset("<id>")'));
  }
  assert.ok(isAssetRef(asset("not-in-any-library")), "an unknown id is only caught when used");
});

test("staticFile() throws graphic_media_ref quoting the value and pointing to asset()", () => {
  const error = throwsCode(() => staticFile("images/logo.png"), "graphic_media_ref");
  assert.ok(error.message.includes('"images/logo.png"'));
  assert.ok(error.message.includes('asset("<id>")'));
});

test("source resolution follows BRIEF 6.1's order", () => {
  const r = (src: unknown, use: "image" | "video" | "audio" = "image") => () => resolveMediaSource(src, use, assets, "<Img>");
  // 1. a reference to an unknown id
  const unknownRef = throwsCode(r(asset("missing")), "graphic_asset_unknown");
  assert.ok(unknownRef.message.includes('"missing"'));
  // 2. data: on an image is used as-is
  assert.deepEqual(r("data:image/png;base64,AAAA")(), { kind: "data", url: "data:image/png;base64,AAAA" });
  // 3. a key of host.assets wins over the path check
  assert.equal((r("folder/pic")() as { id: string }).id, "folder/pic");
  // 4. URL schemes, slashes, backslashes and leading dots are refused
  for (const value of ["https://x.test/a.png", "blob:abc", "img/logo.png", "C:\\pics\\a.png", "./logo.png", ".logo"]) {
    const error = throwsCode(r(value), "graphic_media_ref");
    assert.ok(error.message.includes(JSON.stringify(value)), error.message);
    assert.ok(error.message.includes('asset("<id>")'));
  }
  // data: is only special for images
  throwsCode(r("data:video/mp4;base64,AAAA", "video"), "graphic_media_ref");
  // 5. anything else
  const unknown = throwsCode(r("nope"), "graphic_asset_unknown");
  assert.ok(unknown.message.includes('"nope"'));
  throwsCode(r(undefined), "graphic_asset_unknown");
  throwsCode(r(42), "graphic_asset_unknown");
  throwsCode(r("constructor"), "graphic_asset_unknown");
});

test("the asset's kind must fit the component (graphic_asset_kind names the id)", () => {
  const kind = (src: string, use: "image" | "video" | "audio") =>
    throwsCode(() => resolveMediaSource(src, use, assets, "<X>"), "graphic_asset_kind");
  assert.ok(kind("clip", "image").message.includes('"clip"'));
  assert.ok(kind("logo", "video").message.includes('"logo"'));
  assert.ok(kind("clip", "audio").message.includes('"clip"'), "a video is the wrong kind for audio");
  kind("font", "image");
  kind("song", "video");
});

// ---- <Img> (BRIEF 6.2) ----

test("Img renders an <img> with the host's URL and the asset's size as width/height attributes", async () => {
  const m = mount(makeHost({ assets }), () => <Img src={asset("logo")} alt="Logo" className="pic" />);
  const result = await renderLoaded(m, 0);
  assert.deepEqual(result, { cues: [] });
  const [img] = images(m.container);
  assert.equal(img.getAttribute("src"), "https://media.test/h-logo?w=640&h=360");
  assert.equal(img.getAttribute("width"), "640");
  assert.equal(img.getAttribute("height"), "360");
  assert.equal(img.alt, "Logo");
  assert.equal(img.className, "pic");
  m.app.unmount();
});

test("Img: if the user sizes the image, the runtime sets no size attributes", async () => {
  const m = mount(makeHost({ assets }), () => (
    <>
      <Img src="logo" width={100} />
      <Img src="logo" style={{ height: "50%" }} />
      <Img src="logo" height={20} />
    </>
  ));
  await renderLoaded(m, 0);
  const [a, b, c] = images(m.container);
  assert.equal(a.getAttribute("width"), "100");
  assert.equal(a.getAttribute("height"), null);
  assert.equal(b.getAttribute("width"), null);
  assert.equal(b.getAttribute("height"), null);
  assert.equal(c.getAttribute("width"), null);
  assert.equal(c.getAttribute("height"), "20");
  m.app.unmount();
});

test("Img with a data: source uses it as-is and gets no size attributes", async () => {
  const data = "data:image/png;base64,iVBORw0KGgo=";
  const m = mount(makeHost({ assets }), () => <Img src={data} />);
  const t = track(m.app.renderFrame(0));
  await ticks(5);
  assert.equal(t.settled(), false, "a data: image still holds a delay until it loads");
  const [img] = images(m.container);
  assert.equal(img.getAttribute("src"), data);
  assert.equal(img.getAttribute("width"), null);
  fireLoad(img);
  await t.promise;
  m.app.unmount();
});

test("Img holds a delay until load; an already-loaded image with the same URL holds none", async () => {
  const m = mount(makeHost({ assets }), () => <Img src="logo" />);
  const first = track(m.app.renderFrame(0));
  await ticks(5);
  assert.equal(first.settled(), false);
  fireLoad(images(m.container)[0]);
  await first.promise;
  // Same URL on the next frame: settles without another load event.
  await m.app.renderFrame(1);
  m.app.unmount();
});

test("Img: a load event for a URL the image no longer shows is ignored", async () => {
  function Switch() {
    return <Img src={useCurrentFrame() === 0 ? "logo" : "photo"} />;
  }
  const m = mount(makeHost({ assets }), Switch);
  await renderLoaded(m, 0);
  const t = track(m.app.renderFrame(1));
  const [img] = images(m.container);
  assert.equal(img.getAttribute("src"), "https://media.test/h-photo?w=100&h=50");
  await ticks(5);
  assert.equal(t.settled(), false);
  fireLoad(img);
  await t.promise;
  m.app.unmount();
});

test("Img error: calls onError and onImageError (an Error naming the id), then fails with graphic_media_failed", async () => {
  const calls: string[] = [];
  let imageError: unknown;
  const m = mount(makeHost({ assets }), () => (
    <Img
      src="logo"
      onError={(e) => calls.push(`onError:${e.type}`)}
      onImageError={(e) => {
        calls.push("onImageError");
        imageError = e;
      }}
    />
  ));
  const pending = m.app.renderFrame(0);
  fireError(images(m.container)[0]);
  const error = await rejectsWithCode(pending, "graphic_media_failed");
  assert.ok(error.message.includes('"logo"'));
  assert.deepEqual(calls, ["onError:error", "onImageError"]);
  assert.ok(imageError instanceof Error);
  assert.ok((imageError as Error).message.includes('"logo"'));
  m.app.unmount();
});

test("Img error without handlers fails the frame with graphic_media_failed; there are no retries", async () => {
  const m = mount(makeHost({ assets }), () => <Img src="photo" maxRetries={5} />);
  const pending = m.app.renderFrame(0);
  const [img] = images(m.container);
  fireError(img);
  const error = await rejectsWithCode(pending, "graphic_media_failed");
  assert.ok(error.message.includes('"photo"'));
  assert.equal(images(m.container).length <= 1, true);
  m.app.unmount();
});

test("Img: an error thrown by onError passes through unchanged", async () => {
  const mine = new Error("handler broke");
  const m = mount(makeHost({ assets }), () => (
    <Img
      src="logo"
      onError={() => {
        throw mine;
      }}
    />
  ));
  const pending = m.app.renderFrame(0);
  fireError(images(m.container)[0]);
  await assert.rejects(pending, (e) => e === mine);
  m.app.unmount();
});

test("recorded choice: Img calls the user's onLoad after its own load handling; errors in it pass through", async () => {
  let loaded = 0;
  const m = mount(makeHost({ assets }), () => <Img src="logo" onLoad={() => loaded++} />);
  await renderLoaded(m, 0);
  assert.ok(loaded >= 1);
  m.app.unmount();
  const mine = new Error("onLoad broke");
  const n = mount(makeHost({ assets }), () => (
    <Img
      src="logo"
      onLoad={() => {
        throw mine;
      }}
    />
  ));
  const pending = n.app.renderFrame(0);
  fireLoad(images(n.container)[0]);
  await assert.rejects(pending, (e) => e === mine);
  n.app.unmount();
});

test("Img: a source error rejects the frame with its code", async () => {
  for (const [src, code] of [
    ["https://example.com/a.png", "graphic_media_ref"],
    ["missing", "graphic_asset_unknown"],
    ["clip", "graphic_asset_kind"],
  ] as const) {
    const m = mount(makeHost({ assets }), () => <Img src={src} />);
    await rejectsWithCode(m.app.renderFrame(0), code);
    m.app.unmount();
  }
});

test("Img timing props: from and durationInFrames mount it only inside its range; hidden hides it", async () => {
  const m = mount(makeHost({ assets }), () => (
    <>
      <Img src="logo" from={30} durationInFrames={90} className="timed" />
      <Img src="logo" hidden className="hidden" />
    </>
  ));
  await renderLoaded(m, 29);
  assert.equal(m.container.querySelector(".timed"), null);
  await renderLoaded(m, 30);
  assert.ok(m.container.querySelector(".timed"));
  await renderLoaded(m, 119);
  assert.ok(m.container.querySelector(".timed"));
  await renderLoaded(m, 120);
  assert.equal(m.container.querySelector(".timed"), null);
  assert.equal(m.container.querySelector(".hidden"), null);
  m.app.unmount();
});

test("Img drops srcSet, sizes, loading and crossOrigin; ref is the <img>", async () => {
  const ref = React.createRef<HTMLImageElement>();
  const m = mount(makeHost({ assets }), () => (
    <Img ref={ref} src="logo" srcSet="a.png 2x" sizes="10vw" loading="lazy" crossOrigin="anonymous" decoding="async" />
  ));
  await renderLoaded(m, 0);
  const [img] = images(m.container);
  assert.equal(ref.current, img);
  assert.equal(img.getAttribute("srcset"), null);
  assert.equal(img.getAttribute("sizes"), null);
  assert.equal(img.getAttribute("loading"), null);
  assert.equal(img.getAttribute("crossorigin"), null);
  assert.equal(img.getAttribute("decoding"), "async");
  m.app.unmount();
});

test("Img accepts and ignores the ignored props (premount, pauseWhenLoading, delayRender options, effects)", async () => {
  const m = mount(makeHost({ assets }), () => (
    <Img
      src="logo"
      from={10}
      premountFor={10}
      postmountFor={10}
      styleWhilePremounted={{ opacity: 0 }}
      styleWhilePostmounted={{ opacity: 0 }}
      pauseWhenLoading
      delayRenderTimeoutInMilliseconds={1}
      delayRenderRetries={3}
      effects={[{}]}
      name="logo"
      showInTimeline={false}
    />
  ));
  await renderLoaded(m, 5);
  assert.equal(images(m.container).length, 0, "not premounted");
  await renderLoaded(m, 10);
  assert.equal(images(m.container).length, 1);
  assert.equal(m.container.querySelector("canvas"), null, "effects never switch to a canvas");
  m.app.unmount();
});

test("Img crop props become a clip-path on the <img>", async () => {
  const m = mount(makeHost({ assets }), () => <Img src="logo" cropRight={0.5} style={{ borderRadius: "8px" }} />);
  await renderLoaded(m, 0);
  assert.equal(images(m.container)[0].style.clipPath, "inset(0% 50% 0% 0% round 8px)");
  m.app.unmount();
});

test("a frame that waits on an image times out with a message naming the image", async () => {
  const m = mount(makeHost({ assets, frameTimeoutMs: 50 }), () => <Img src="photo" />);
  const error = await rejectsWithCode(m.app.renderFrame(0), "graphic_frame_timeout");
  assert.ok(error.message.includes('"photo"'));
  m.app.unmount();
});

// ---- Cap: at most 8 media <img> elements per committed frame (BRIEF 6.6) ----

function Many({ count, offset = 0 }: { count: number; offset?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <Img key={i + offset} src={i % 2 === 0 ? "logo" : "data:image/png;base64,AAAA"} />
      ))}
    </>
  );
}

test("cap: 8 media images in a frame are fine; a 9th fails with graphic_media_per_frame", async () => {
  const ok = mount(makeHost({ assets }), () => <Many count={8} />);
  await renderLoaded(ok, 0);
  ok.app.unmount();
  const tooMany = mount(makeHost({ assets }), () => <Many count={9} />);
  await rejectsWithCode(tooMany.app.renderFrame(0), "graphic_media_per_frame");
  tooMany.app.unmount();
});

test("cap: the count is per committed frame, not cumulative over frames", async () => {
  function Rotating() {
    const frame = useCurrentFrame();
    return (
      <>
        <Sequence durationInFrames={1}>
          <Many count={8} />
        </Sequence>
        <Sequence from={1}>
          <Many count={8} offset={100} />
        </Sequence>
        <span>{frame}</span>
      </>
    );
  }
  const m = mount(makeHost({ assets }), Rotating);
  await renderLoaded(m, 0);
  await renderLoaded(m, 1);
  await renderLoaded(m, 0);
  m.app.unmount();
});

test("recorded choice: trimBefore on Img is accepted and has no visible effect", async () => {
  const m = mount(makeHost({ assets }), () => <Img src="logo" trimBefore={10} />);
  await renderLoaded(m, 0);
  assert.equal(images(m.container).length, 1);
  m.app.unmount();
});

test("recorded choice: an <img> that already reports complete with a natural width holds no delay", async () => {
  const proto = window.HTMLImageElement.prototype;
  const complete = Object.getOwnPropertyDescriptor(proto, "complete");
  const naturalWidth = Object.getOwnPropertyDescriptor(proto, "naturalWidth");
  Object.defineProperty(proto, "complete", { configurable: true, get: () => true });
  Object.defineProperty(proto, "naturalWidth", { configurable: true, get: () => 640 });
  try {
    const m = mount(makeHost({ assets }), () => <Img src="logo" />);
    await m.app.renderFrame(0); // no load event is fired
    m.app.unmount();
  } finally {
    Object.defineProperty(proto, "complete", complete as PropertyDescriptor);
    Object.defineProperty(proto, "naturalWidth", naturalWidth as PropertyDescriptor);
  }
});
