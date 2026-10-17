import "./helpers/dom";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import {
  Html5Audio,
  Html5Video,
  Img,
  interpolate,
  Loop,
  Sequence,
  Series,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "../runtime/src/index";
import { audioAsset, imageAsset, makeHost, mount, renderLoaded, videoAsset } from "./helpers/host";

const assets = { logo: imageAsset("h-logo"), clip: videoAsset("h-clip"), song: audioAsset("h-song") };

function Busy() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps });
  return (
    <>
      <div style={{ opacity: interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" }) }}>{s.toFixed(4)}</div>
      <Series>
        <Series.Sequence durationInFrames={20}>
          <Img src="logo" />
        </Series.Sequence>
        <Series.Sequence durationInFrames={40}>
          <Loop durationInFrames={15}>
            <Html5Video src="clip" />
          </Loop>
        </Series.Sequence>
      </Series>
      <Sequence from={5}>
        <Html5Audio src="song" volume={(f) => f / 100} />
      </Sequence>
    </>
  );
}

test("a frame's output depends only on the frame number: out-of-order and repeated frames match", async () => {
  const m = mount(makeHost({ assets }), Busy);
  const snapshot = async (n: number) => {
    const result = await renderLoaded(m, n);
    const cues = result.cues.map(({ handle, sourceTime, volume }) => ({ handle, sourceTime, volume }));
    return JSON.stringify({ html: m.container.innerHTML, cues });
  };
  const order = [0, 25, 7, 59, 25, 0, 40, 7];
  const seen = new Map<number, string>();
  for (const n of order) {
    const s = await snapshot(n);
    if (seen.has(n)) assert.equal(s, seen.get(n), `frame ${n} differs on a repeat`);
    seen.set(n, s);
  }
  const fresh = mount(makeHost({ assets }), Busy);
  for (const n of [7, 25, 59]) {
    const result = await renderLoaded(fresh, n);
    const cues = result.cues.map(({ handle, sourceTime, volume }) => ({ handle, sourceTime, volume }));
    assert.equal(JSON.stringify({ html: fresh.container.innerHTML, cues }), seen.get(n), `frame ${n} in a fresh app`);
  }
  m.app.unmount();
  fresh.app.unmount();
});

test("the runtime calls setTimeout only for the frameTimeoutMs deadline, once per renderFrame", async () => {
  const original = globalThis.setTimeout;
  const delays: unknown[] = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    delays.push(ms);
    return original(fn, ms, ...rest);
  }) as typeof setTimeout;
  try {
    const m = mount(makeHost({ assets, frameTimeoutMs: 1234 }), Busy);
    for (const n of [0, 10, 30]) await renderLoaded(m, n);
    m.app.unmount();
  } finally {
    globalThis.setTimeout = original;
  }
  assert.deepEqual(delays, [1234, 1234, 1234]);
});

test("frames settle while performance.now() and Date stand still (the host makes them follow the frame)", async () => {
  const realNow = performance.now.bind(performance);
  const RealDate = Date;
  const frozen = 1_000_000;
  performance.now = () => frozen;
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(frozen);
      else super(...(args as [number]));
    }
    static override now() {
      return frozen;
    }
  }
  globalThis.Date = FrozenDate as DateConstructor;
  try {
    const m = mount(makeHost({ assets }), Busy);
    for (const n of [0, 30, 15]) await renderLoaded(m, n);
    m.app.unmount();
  } finally {
    performance.now = realNow;
    globalThis.Date = RealDate;
  }
});

test("the runtime itself reads no clock and no Math.random except for random(null)", () => {
  const dir = join(__dirname, "..", "runtime", "src");
  for (const file of readdirSync(dir)) {
    const source = readFileSync(join(dir, file), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/performance\.now|Date\.now|new Date\(|requestAnimationFrame|setInterval/.test(source), file);
    if (file !== "random.ts") assert.ok(!/Math\.random/.test(source), file);
    if (file !== "app.tsx") assert.ok(!/setTimeout/.test(source), file);
  }
});

test("every code the runtime raises is one of BRIEF section 7's codes, and each is used", () => {
  const brief = [
    "graphic_api_unsupported", "graphic_api_misuse", "graphic_asset_unknown", "graphic_asset_kind",
    "graphic_media_ref", "graphic_media_failed", "graphic_media_time", "graphic_media_per_frame",
    "graphic_audio_cues_cap", "graphic_font_cap", "graphic_frame_timeout", "graphic_render_cancelled",
  ];
  const dir = join(__dirname, "..", "runtime", "src");
  const used = new Set<string>();
  for (const file of readdirSync(dir)) {
    const source = readFileSync(join(dir, file), "utf8");
    for (const m of source.matchAll(/"(graphic_[a-z_]+)"/g)) used.add(m[1]);
    if (/\bmisuse\(/.test(source)) used.add("graphic_api_misuse");
  }
  assert.deepEqual([...used].sort(), [...brief].sort());
});
