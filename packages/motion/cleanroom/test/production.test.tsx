// The same core behaviour against React's production builds, which is what the page loads.
import "./helpers/production";
import "./helpers/dom";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { Html5Audio, Img, Sequence, useCurrentFrame, useDelayRender } from "../runtime/src/index";
import { audioAsset, imageAsset, makeHost, mount, rejectsWithCode, renderLoaded, ticks, track } from "./helpers/host";

test("React's production build is loaded", () => {
  const reactDomPath = require.resolve("react-dom");
  const loaded = Object.keys(require.cache).filter((k) => k.includes(`react-dom${require("node:path").sep}cjs`));
  assert.ok(reactDomPath);
  assert.ok(loaded.some((k) => k.includes("production")), loaded.join(", "));
  assert.ok(!loaded.some((k) => k.includes("development")));
});

test("production: frames commit synchronously and settle after delays and effect updates", async () => {
  function Graphic() {
    const frame = useCurrentFrame();
    const { delayRender, continueRender } = useDelayRender();
    const [handle] = React.useState(() => delayRender("data"));
    const [data, setData] = React.useState("…");
    const [doubled, setDoubled] = React.useState(-1);
    React.useEffect(() => {
      Promise.resolve().then(() => {
        setData("ready");
        continueRender(handle);
      });
    }, [handle, continueRender]);
    React.useEffect(() => setDoubled(frame * 2), [frame]);
    return (
      <span>
        {frame}/{data}/{doubled}
      </span>
    );
  }
  const m = mount(makeHost(), Graphic);
  const t = track(m.app.renderFrame(3));
  assert.match(m.container.textContent ?? "", /^3\//);
  await t.promise;
  assert.equal(m.container.textContent, "3/ready/6");
  await m.app.renderFrame(8);
  assert.equal(m.container.textContent, "8/ready/16");
  m.app.unmount();
});

test("production: render errors reject the frame and stay final", async () => {
  const boom = new Error("prod boom");
  const m = mount(makeHost(), () => {
    if (useCurrentFrame() === 1) throw boom;
    return null;
  });
  await m.app.renderFrame(0);
  await assert.rejects(m.app.renderFrame(1), (e) => e === boom);
  await assert.rejects(m.app.renderFrame(0), (e) => e === boom);
  m.app.unmount();
});

test("production: images hold the frame until load; cues come in tree order; unmount cancels", async () => {
  const assets = { logo: imageAsset("h-logo"), song: audioAsset("h-song") };
  const m = mount(makeHost({ assets, frameTimeoutMs: 5000 }), () => (
    <>
      <Html5Audio src="song" volume={0.25} />
      <Sequence from={10}>
        <Img src="logo" />
        <Html5Audio src="song" volume={0.5} />
      </Sequence>
    </>
  ));
  const first = await renderLoaded(m, 12);
  assert.deepEqual(
    first.cues.map((c) => [c.handle, c.volume]),
    [
      ["h-song", 0.25],
      ["h-song", 0.5],
    ],
  );
  m.app.unmount();
  const n = mount(makeHost({ assets, frameTimeoutMs: 5000 }), () => <Img src="logo" />);
  const pending = track(n.app.renderFrame(0));
  await ticks(3);
  assert.equal(pending.settled(), false);
  n.app.unmount();
  await rejectsWithCode(pending.promise, "graphic_render_cancelled");
});
