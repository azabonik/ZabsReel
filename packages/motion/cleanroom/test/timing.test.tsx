import "./helpers/dom";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import {
  AbsoluteFill,
  Freeze,
  Loop,
  Sequence,
  Series,
  useCurrentFrame,
  useVideoConfig,
} from "../runtime/src/index";
import { fillDefaultsOverriddenBy } from "../runtime/src/AbsoluteFill";
import { makeHost, mount, rejectsWithCode } from "./helpers/host";
import type { Mounted } from "./helpers/host";

/** Renders "<name>:<frame>" so tests can read what each probe sees. */
function Probe({ name = "p" }: { name?: string }) {
  const frame = useCurrentFrame();
  return <i data-probe={name}>{frame}</i>;
}

function ConfigProbe({ name = "c" }: { name?: string }) {
  const { durationInFrames, width, height, fps } = useVideoConfig();
  return <b data-config={name} data-d={durationInFrames} data-w={width} data-h={height} data-fps={fps} />;
}

function read(m: Mounted, name = "p"): number | null {
  const el = m.container.querySelector(`[data-probe="${name}"]`);
  return el ? Number(el.textContent) : null;
}

function config(m: Mounted, name = "c") {
  const el = m.container.querySelector(`[data-config="${name}"]`) as HTMLElement | null;
  if (!el) return null;
  return {
    durationInFrames: Number(el.dataset.d),
    width: Number(el.dataset.w),
    height: Number(el.dataset.h),
    fps: Number(el.dataset.fps),
  };
}

async function framesSeen(tree: React.ReactElement, frames: number[], name = "p", duration = 300) {
  const m = mount(makeHost({ composition: { durationInFrames: duration } }), () => tree);
  const out: (number | null)[] = [];
  for (const f of frames) {
    await m.app.renderFrame(f);
    out.push(read(m, name));
  }
  m.app.unmount();
  return out;
}

// ---- useCurrentFrame and Sequence (SPEC 2, 10, 12) ----

test("useCurrentFrame: outside any shift it is the composition frame; inside from={10} it is relative (docs example)", async () => {
  const tree = (
    <>
      <Probe name="top" />
      <AbsoluteFill from={10}>
        <Probe name="inner" />
      </AbsoluteFill>
    </>
  );
  const m = mount(makeHost(), () => tree);
  await m.app.renderFrame(25);
  assert.equal(read(m, "top"), 25);
  assert.equal(read(m, "inner"), 15);
  m.app.unmount();
});

test("Sequence: children are not mounted before from; they see frame 0 at from (docs Intro example)", async () => {
  const seen = await framesSeen(
    <Sequence from={30}>
      <Probe />
    </Sequence>,
    [0, 29, 30, 31],
  );
  assert.deepEqual(seen, [null, null, 0, 1]);
});

test("Sequence: from={30} durationInFrames={90} is visible from frame 30 to 119", async () => {
  const seen = await framesSeen(
    <Sequence from={30} durationInFrames={90}>
      <Probe />
    </Sequence>,
    [29, 30, 119, 120],
  );
  assert.deepEqual(seen, [null, 0, 89, null]);
});

test("Sequence: from={30} trimBefore={15} mounts at 30 and the child receives 15", async () => {
  const seen = await framesSeen(
    <Sequence from={30} trimBefore={15}>
      <Probe />
    </Sequence>,
    [29, 30, 31],
  );
  assert.deepEqual(seen, [null, 15, 16]);
});

test("Sequence: from 30, trimBefore 10, durationInFrames 60, playbackRate 2 (docs table row)", async () => {
  const seen = await framesSeen(
    <Sequence from={30} trimBefore={10} durationInFrames={60} playbackRate={2}>
      <Probe />
    </Sequence>,
    [30, 40, 59, 60],
  );
  assert.deepEqual(seen, [10, 30, 68, null]);
});

test("Sequence loop: trimBefore 30, durationInFrames 30, playbackRate 2 repeats every 15 frames", async () => {
  const frames = [0, 1, 14, 15, 16, 89, 90];
  const seen = await framesSeen(
    <Sequence trimBefore={30} durationInFrames={30} playbackRate={2} loop>
      <Probe />
    </Sequence>,
    frames,
  );
  assert.deepEqual(seen, [30, 32, 58, 30, 32, 58, 30]);
});

test("Sequence loop without a finite durationInFrames throws graphic_api_misuse", async () => {
  const m = mount(makeHost(), () => (
    <Sequence loop>
      <Probe />
    </Sequence>
  ));
  await rejectsWithCode(m.app.renderFrame(0), "graphic_api_misuse");
  m.app.unmount();
});

test("nesting: shifts add up (outer 30 + inner 60 = frame 0 at 90) and rates multiply", async () => {
  const seen = await framesSeen(
    <Sequence from={30}>
      <Sequence from={60}>
        <Probe />
      </Sequence>
    </Sequence>,
    [89, 90, 95],
  );
  assert.deepEqual(seen, [null, 0, 5]);
  const rates = await framesSeen(
    <Sequence playbackRate={2}>
      <Sequence playbackRate={3}>
        <Probe />
      </Sequence>
    </Sequence>,
    [0, 1, 5],
  );
  assert.deepEqual(rates, [0, 6, 30]);
});

test("recorded choice: under playbackRate 0.5 useCurrentFrame returns fractional frames", async () => {
  const seen = await framesSeen(
    <Sequence playbackRate={0.5}>
      <Probe />
    </Sequence>,
    [0, 1, 3],
  );
  assert.deepEqual(seen, [0, 0.5, 1.5]);
});

test("recorded choice: floating-point noise in child frames is snapped to whole frames", async () => {
  const seen = await framesSeen(
    <Sequence playbackRate={0.1}>
      <Probe />
    </Sequence>,
    [30],
  );
  assert.deepEqual(seen, [3]);
});

test("Sequence playbackRate must be a positive finite number", async () => {
  for (const rate of [0, -1, Infinity, Number.NaN]) {
    const m = mount(makeHost(), () => (
      <Sequence playbackRate={rate}>
        <Probe />
      </Sequence>
    ));
    await rejectsWithCode(m.app.renderFrame(0), "graphic_api_misuse");
    m.app.unmount();
  }
});

test("recorded choice: durationInFrames 0 shows nothing; negative or NaN timing props throw graphic_api_misuse", async () => {
  assert.deepEqual(await framesSeen(<Sequence durationInFrames={0}><Probe /></Sequence>, [0, 1]), [null, null]);
  for (const props of [{ durationInFrames: -1 }, { from: Number.NaN }, { trimBefore: "3" as unknown as number }]) {
    const m = mount(makeHost(), () => (
      <Sequence {...props}>
        <Probe />
      </Sequence>
    ));
    await rejectsWithCode(m.app.renderFrame(0), "graphic_api_misuse");
    m.app.unmount();
  }
});

test("recorded choice: a negative from is allowed (the content started before frame 0)", async () => {
  assert.deepEqual(await framesSeen(<Sequence from={-10}><Probe /></Sequence>, [0, 5]), [10, 15]);
});

test("useVideoConfig in a Sequence: 40 visible frames at rate 2 with trimBefore 10 reports 90 (docs example)", async () => {
  const m = mount(makeHost(), () => (
    <Sequence from={20} trimBefore={10} durationInFrames={80} playbackRate={2}>
      <Probe />
      <ConfigProbe />
    </Sequence>
  ));
  await m.app.renderFrame(20);
  assert.equal(read(m), 10);
  assert.equal(config(m)?.durationInFrames, 90);
  await m.app.renderFrame(59);
  assert.equal(read(m), 88);
  await m.app.renderFrame(60);
  assert.equal(read(m), null, "children unmount before local frame 90");
  m.app.unmount();
});

test("recorded choice: useVideoConfig in an infinite Sequence reports the parent's end in child frames; fps is unchanged", async () => {
  const m = mount(makeHost({ composition: { durationInFrames: 300 } }), () => (
    <Sequence from={30} playbackRate={2}>
      <ConfigProbe />
    </Sequence>
  ));
  await m.app.renderFrame(30);
  assert.deepEqual(config(m), { durationInFrames: 540, width: 1280, height: 720, fps: 30 });
  m.app.unmount();
});

test("Sequence width and height: inline container size and what useVideoConfig reports", async () => {
  const m = mount(makeHost(), () => (
    <Sequence width={400} height={300}>
      <ConfigProbe />
    </Sequence>
  ));
  await m.app.renderFrame(0);
  const c = config(m);
  assert.equal(c?.width, 400);
  assert.equal(c?.height, 300);
  const div = m.container.querySelector("[data-config]")?.parentElement as HTMLElement;
  assert.equal(div.style.width, "400px");
  assert.equal(div.style.height, "300px");
  m.app.unmount();
});

test("Sequence layout: absolute-fill wraps children in an AbsoluteFill; none renders no wrapper", async () => {
  const m = mount(makeHost(), () => (
    <>
      <Sequence className="a" style={{ opacity: 0.5 }}>
        <Probe name="fill" />
      </Sequence>
      <Sequence layout="none">
        <Probe name="bare" />
      </Sequence>
    </>
  ));
  await m.app.renderFrame(0);
  const fill = m.container.querySelector('[data-probe="fill"]')?.parentElement as HTMLElement;
  assert.equal(fill.tagName, "DIV");
  assert.equal(fill.className, "a");
  assert.equal(fill.style.position, "absolute");
  assert.equal(fill.style.opacity, "0.5");
  const bare = m.container.querySelector('[data-probe="bare"]')?.parentElement as HTMLElement;
  assert.equal(bare, m.container.firstElementChild, "no wrapper with layout none");
  m.app.unmount();
});

test("Sequence layout none rejects style, className, crop props and refs", async () => {
  const cases: React.ReactElement[] = [
    <Sequence layout="none" style={{ opacity: 1 }} />,
    <Sequence layout="none" className="x" />,
    <Sequence layout="none" cropLeft={0.1} />,
    <Sequence layout="none" ref={React.createRef<HTMLDivElement>()} />,
    <Sequence layout={"grid" as "none"} />,
  ];
  for (const element of cases) {
    const m = mount(makeHost(), () => element);
    await rejectsWithCode(m.app.renderFrame(0), "graphic_api_misuse");
    m.app.unmount();
  }
});

test("Sequence ref is the container div", async () => {
  const ref = React.createRef<HTMLDivElement>();
  const m = mount(makeHost(), () => <Sequence ref={ref} />);
  await m.app.renderFrame(0);
  assert.ok(ref.current instanceof window.HTMLDivElement);
  m.app.unmount();
});

test("Sequence hidden renders nothing inside it", async () => {
  assert.deepEqual(await framesSeen(<Sequence hidden><Probe /></Sequence>, [0, 10]), [null, null]);
  assert.deepEqual(await framesSeen(<Sequence hidden={false}><Probe /></Sequence>, [3]), [3]);
});

test("recorded choice: Sequence freeze holds the children at that child frame within the Sequence's own range", async () => {
  const seen = await framesSeen(
    <Sequence from={30} durationInFrames={60} freeze={10}>
      <Probe />
    </Sequence>,
    [29, 30, 50, 89, 90],
  );
  assert.deepEqual(seen, [null, 10, 10, 10, null]);
  assert.deepEqual(await framesSeen(<Sequence freeze={null}><Probe /></Sequence>, [7]), [7]);
});

test("Sequence crop props become a clip-path inset, with inline corner radii", async () => {
  const m = mount(makeHost(), () => (
    <>
      <Sequence className="one" cropLeft={0.25} cropTop={0.1} style={{ borderRadius: 12 }} />
      <Sequence className="two" cropLeft={0.8} cropRight={0.6} />
      <Sequence className="three" cropBottom={2} style={{ borderTopLeftRadius: "4px" }} />
      <Sequence className="none" cropLeft={0} />
    </>
  ));
  await m.app.renderFrame(0);
  const style = (cls: string) => (m.container.querySelector(`.${cls}`) as HTMLElement).style.clipPath;
  assert.equal(style("one"), "inset(10% 0% 0% 25% round 12px)");
  // recorded choice: overlapping opposite crops meet in the middle of their overlap
  assert.equal(style("two"), "inset(0% 40% 0% 60%)");
  // recorded choice: crops are clamped to 0..1; missing corners use 0
  assert.equal(style("three"), "inset(0% 0% 100% 0% round 4px 0px 0px 0px)");
  assert.equal(style("none"), "");
  m.app.unmount();
});

test("Sequence ignores the accepted-and-ignored props (premountFor, postmountFor, name, ...)", async () => {
  const seen = await framesSeen(
    <Sequence
      from={10}
      premountFor={30}
      postmountFor={30}
      styleWhilePremounted={{ opacity: 0 }}
      styleWhilePostmounted={{ opacity: 0 }}
      name="intro"
      showInTimeline={false}
      outlineRef={null}
    >
      <Probe />
    </Sequence>,
    [0, 9, 10],
  );
  assert.deepEqual(seen, [null, null, 0], "never premounted");
});

// ---- AbsoluteFill (SPEC 11) ----

test("AbsoluteFill renders a div with the documented default styles and passes div props through", async () => {
  const ref = React.createRef<HTMLDivElement>();
  const m = mount(makeHost(), () => (
    <AbsoluteFill ref={ref} id="fill" data-x="1" title="t" style={{ backgroundColor: "red", flexDirection: "row" }}>
      text
    </AbsoluteFill>
  ));
  await m.app.renderFrame(0);
  const div = m.container.querySelector("#fill") as HTMLElement;
  assert.equal(ref.current, div);
  assert.equal(div.getAttribute("data-x"), "1");
  assert.equal(div.title, "t");
  const s = div.style;
  assert.equal(s.position, "absolute");
  assert.equal(s.top, "0px");
  assert.equal(s.left, "0px");
  assert.equal(s.right, "0px");
  assert.equal(s.bottom, "0px");
  assert.equal(s.width, "100%");
  assert.equal(s.height, "100%");
  assert.equal(s.display, "flex");
  assert.equal(s.flexDirection, "row", "the style prop overrides the defaults");
  assert.equal(s.backgroundColor, "red");
  m.app.unmount();
});

test("AbsoluteFill drops a default style that a Tailwind class sets (flex flex-row gives a row layout)", async () => {
  const m = mount(makeHost(), () => <AbsoluteFill className="flex flex-row" id="tw" />);
  await m.app.renderFrame(0);
  const s = (m.container.querySelector("#tw") as HTMLElement).style;
  assert.equal(s.flexDirection, "");
  assert.equal(s.display, "");
  assert.equal(s.position, "absolute");
  m.app.unmount();
});

test("parity r1 abs-fill-layers, recorded choice: Tailwind detection covers display, direction, inset, sides and size classes", () => {
  const set = (c: string) => [...fillDefaultsOverriddenBy(c)].sort();
  assert.deepEqual(set("relative"), [], "position classes keep the default position");
  assert.deepEqual(set("absolute static fixed sticky"), []);
  assert.deepEqual(set("inset-0"), ["bottom", "left", "right", "top"]);
  assert.deepEqual(set("inset-x-2"), ["left", "right"]);
  assert.deepEqual(set("-top-2 w-1/2 h-10"), ["height", "top", "width"]);
  assert.deepEqual(set("size-8"), ["height", "width"]);
  assert.deepEqual(set("grid flex-col-reverse"), ["display", "flexDirection"]);
  assert.deepEqual(set("md:flex-row"), ["flexDirection"], "a variant prefix does not matter");
  assert.deepEqual(set("hover:hidden"), ["display"]);
  assert.deepEqual(set("flex-row! !grid"), [], "important markers are not recognised");
  assert.deepEqual(set("flex-1 flex-wrap"), []);
  assert.deepEqual(set(""), []);
});

test("parity r1 abs-fill-layers: className 'relative' keeps the fill absolutely positioned; 'md:flex-row' gives a row", async () => {
  const m = mount(makeHost(), () => (
    <>
      <AbsoluteFill className="relative" id="rel" />
      <AbsoluteFill className="md:flex-row" id="md" />
      <AbsoluteFill className="flex-row!" id="imp" />
    </>
  ));
  await m.app.renderFrame(0);
  const style = (id: string) => (m.container.querySelector(`#${id}`) as HTMLElement).style;
  assert.equal(style("rel").position, "absolute");
  assert.equal(style("md").flexDirection, "");
  assert.equal(style("imp").flexDirection, "column");
  m.app.unmount();
});

test("recorded choice: AbsoluteFill without timing props does not shift time and works outside a graphic", async () => {
  assert.deepEqual(await framesSeen(<AbsoluteFill><Probe /></AbsoluteFill>, [12]), [12]);
  const { createRoot, flushSync } = require("react-dom") as {
    createRoot(el: Element): { render(n: unknown): void; unmount(): void };
    flushSync(fn: () => void): void;
  };
  const el = document.createElement("div");
  const root = createRoot(el);
  flushSync(() => root.render(<AbsoluteFill id="free" />));
  assert.ok(el.querySelector("#free"));
  root.unmount();
});

test("AbsoluteFill timing props: from, durationInFrames, trimBefore, playbackRate, freeze, hidden", async () => {
  assert.deepEqual(
    await framesSeen(<AbsoluteFill from={30} durationInFrames={90}><Probe /></AbsoluteFill>, [29, 30, 119, 120]),
    [null, 0, 89, null],
  );
  assert.deepEqual(
    await framesSeen(<AbsoluteFill trimBefore={5} playbackRate={2}><Probe /></AbsoluteFill>, [0, 3]),
    [5, 11],
  );
  assert.deepEqual(await framesSeen(<AbsoluteFill freeze={4}><Probe /></AbsoluteFill>, [0, 50]), [4, 4]);
  assert.deepEqual(await framesSeen(<AbsoluteFill hidden><Probe /></AbsoluteFill>, [0]), [null]);
});

// ---- Series (SPEC 13) ----

function threeScenes(extra: Partial<Record<"a" | "b" | "c", Record<string, unknown>>> = {}) {
  return (
    <Series>
      <Series.Sequence durationInFrames={40} {...extra.a}>
        <Probe name="a" />
      </Series.Sequence>
      <Series.Sequence durationInFrames={20} {...extra.b}>
        <Probe name="b" />
      </Series.Sequence>
      <Series.Sequence durationInFrames={70} {...extra.c}>
        <Probe name="c" />
      </Series.Sequence>
    </Series>
  );
}

async function seriesAt(tree: React.ReactElement, frames: number[]) {
  const m = mount(makeHost(), () => tree);
  const out: string[] = [];
  for (const f of frames) {
    await m.app.renderFrame(f);
    out.push(
      ["a", "b", "c"]
        .map((n) => (read(m, n) === null ? "" : `${n}${read(m, n)}`))
        .filter(Boolean)
        .join(","),
    );
  }
  m.app.unmount();
  return out;
}

test("Series: durations 40, 20, 70 play on frames 0-39, 40-59 and 60-129 (derived example)", async () => {
  const seen = await seriesAt(threeScenes(), [0, 39, 40, 59, 60, 129, 130]);
  assert.deepEqual(seen, ["a0", "a39", "b0", "b19", "c0", "c69", ""]);
});

test("Series offsets: positive delays a scene and the later ones; negative overlaps the previous scene", async () => {
  const delayed = await seriesAt(threeScenes({ b: { offset: 10 } }), [40, 49, 50, 69, 70]);
  assert.deepEqual(delayed, ["", "", "b0", "b19", "c0"]);
  const overlapped = await seriesAt(threeScenes({ b: { offset: -10 } }), [29, 30, 39, 50]);
  assert.deepEqual(overlapped, ["a29", "a30,b0", "a39,b9", "c0"]);
});

test("Series.Sequence playbackRate: the next scene begins durationInFrames / playbackRate frames later", async () => {
  const seen = await seriesAt(threeScenes({ a: { playbackRate: 2 } }), [0, 19, 20]);
  assert.deepEqual(seen, ["a0", "a38", "b0"]);
});

test("Series accepts Sequence props: from shifts the whole series; playbackRate speeds it all up", async () => {
  const shifted = await seriesAt(
    <Series from={100}>
      <Series.Sequence durationInFrames={10}>
        <Probe name="a" />
      </Series.Sequence>
      <Series.Sequence durationInFrames={10}>
        <Probe name="b" />
      </Series.Sequence>
    </Series>,
    [99, 100, 110],
  );
  assert.deepEqual(shifted, ["", "a0", "b0"]);
  const fast = await seriesAt(
    <Series playbackRate={2}>
      <Series.Sequence durationInFrames={10}>
        <Probe name="a" />
      </Series.Sequence>
      <Series.Sequence durationInFrames={10}>
        <Probe name="b" />
      </Series.Sequence>
    </Series>,
    [4, 5],
  );
  assert.deepEqual(fast, ["a8", "b0"]);
});

test("Series layout defaults to none; absolute-fill wraps the series in a container; scenes default to absolute-fill", async () => {
  const m = mount(makeHost(), () => (
    <Series>
      <Series.Sequence durationInFrames={10} className="scene">
        <Probe name="a" />
      </Series.Sequence>
    </Series>
  ));
  await m.app.renderFrame(0);
  const scene = m.container.querySelector(".scene") as HTMLElement;
  assert.equal(scene.parentElement, m.container.firstElementChild, "no series wrapper");
  assert.equal(scene.style.position, "absolute");
  m.app.unmount();
  const n = mount(makeHost(), () => (
    <Series layout="absolute-fill" className="series">
      <Series.Sequence durationInFrames={10} layout="none">
        <Probe name="a" />
      </Series.Sequence>
    </Series>
  ));
  await n.app.renderFrame(0);
  const series = n.container.querySelector(".series") as HTMLElement;
  assert.equal(series.style.position, "absolute");
  assert.equal(series.querySelector('[data-probe="a"]')?.parentElement, series);
  n.app.unmount();
});

test("Series: Infinity is allowed on the last scene only; earlier scenes need a positive whole number", async () => {
  const ok = await seriesAt(threeScenes({ c: { durationInFrames: Infinity } }), [299]);
  assert.deepEqual(ok, ["c239"]);
  for (const bad of [
    threeScenes({ a: { durationInFrames: Infinity } }),
    threeScenes({ b: { durationInFrames: 0 } }),
    threeScenes({ b: { durationInFrames: 2.5 } }),
    threeScenes({ c: { durationInFrames: undefined } }),
  ]) {
    const m = mount(makeHost(), () => bad);
    await rejectsWithCode(m.app.renderFrame(0), "graphic_api_misuse");
    m.app.unmount();
  }
});

test("recorded choice: Series opens fragments, skips null/false, and rejects other children", async () => {
  const flattened = await seriesAt(
    <Series>
      <>
        <Series.Sequence durationInFrames={5}>
          <Probe name="a" />
        </Series.Sequence>
        {null}
        {false}
      </>
      <Series.Sequence durationInFrames={5}>
        <Probe name="b" />
      </Series.Sequence>
    </Series>,
    [4, 5],
  );
  assert.deepEqual(flattened, ["a4", "b0"]);
  for (const bad of [
    <Series>
      <div />
    </Series>,
    <Series>text</Series>,
  ]) {
    const m = mount(makeHost(), () => bad);
    await rejectsWithCode(m.app.renderFrame(0), "graphic_api_misuse");
    m.app.unmount();
  }
});

test("recorded choice: Series.Sequence outside Series, and from or loop on a scene, throw graphic_api_misuse", async () => {
  for (const bad of [
    <Series.Sequence durationInFrames={10} />,
    threeScenes({ a: { from: 5 } }),
    threeScenes({ a: { loop: true } }),
  ]) {
    const m = mount(makeHost(), () => bad);
    await rejectsWithCode(m.app.renderFrame(0), "graphic_api_misuse");
    m.app.unmount();
  }
});

test("Series.Sequence trimBefore skips frames at the start of the scene; freeze holds it", async () => {
  const seen = await seriesAt(threeScenes({ a: { trimBefore: 5 }, b: { freeze: 3 } }), [0, 40, 50]);
  assert.deepEqual(seen, ["a5", "b3", "b3"]);
});

// ---- Loop (SPEC 14) ----

test("Loop: iterations restart the child's frame; useLoop reports durationInFrames and iteration", async () => {
  let info: unknown = "unset";
  function LoopInfo() {
    info = Loop.useLoop();
    return <Probe />;
  }
  const m = mount(makeHost(), () => (
    <Loop durationInFrames={50} times={3} name="MyLoop">
      <LoopInfo />
    </Loop>
  ));
  await m.app.renderFrame(75);
  // recorded choice: the child reads the local frame (25); the docs' comment says 75
  assert.equal(read(m), 25);
  assert.deepEqual(info, { durationInFrames: 50, iteration: 1 });
  await m.app.renderFrame(149);
  assert.equal(read(m), 49);
  assert.deepEqual(info, { durationInFrames: 50, iteration: 2 });
  await m.app.renderFrame(150);
  assert.equal(read(m), null, "recorded choice: unmounted after `times` iterations");
  m.app.unmount();
});

test("Loop.useLoop returns null outside any loop", async () => {
  let info: unknown = "unset";
  const m = mount(makeHost(), () => {
    info = Loop.useLoop();
    return null;
  });
  await m.app.renderFrame(0);
  assert.equal(info, null);
  m.app.unmount();
});

test("Loop: nested loops cascade (a 30-frame loop inside a 75-frame loop)", async () => {
  const seen = await framesSeen(
    <Loop durationInFrames={75}>
      <Loop durationInFrames={30}>
        <Probe />
      </Loop>
    </Loop>,
    [0, 29, 30, 74, 75, 105],
  );
  assert.deepEqual(seen, [0, 29, 0, 14, 0, 0]);
});

test("recorded choice: Loop playbackRate keeps the parent-timeline iteration length; useVideoConfig reports D * rate", async () => {
  const m = mount(makeHost(), () => (
    <Loop durationInFrames={20} playbackRate={2}>
      <Probe />
      <ConfigProbe />
    </Loop>
  ));
  await m.app.renderFrame(19);
  assert.equal(read(m), 38);
  assert.equal(config(m)?.durationInFrames, 40);
  await m.app.renderFrame(20);
  assert.equal(read(m), 0);
  m.app.unmount();
});

test("Loop layout: absolute-fill container by default (with style and className); none renders no wrapper", async () => {
  const m = mount(makeHost(), () => (
    <>
      <Loop durationInFrames={10} style={{ opacity: 0.3 }} className="looped">
        <Probe name="a" />
      </Loop>
      <Loop durationInFrames={10} layout="none">
        <Probe name="b" />
      </Loop>
    </>
  ));
  await m.app.renderFrame(0);
  const box = m.container.querySelector(".looped") as HTMLElement;
  assert.equal(box.style.position, "absolute");
  assert.equal(box.style.opacity, "0.3");
  assert.equal(m.container.querySelector('[data-probe="b"]')?.parentElement, m.container.firstElementChild);
  m.app.unmount();
});

test("Loop rejects a missing durationInFrames, invalid times, and style with layout none", async () => {
  for (const bad of [
    <Loop durationInFrames={undefined as unknown as number} />,
    <Loop durationInFrames={0} />,
    <Loop durationInFrames={10} times={-1} />,
    <Loop durationInFrames={10} times={1.5} />,
    <Loop durationInFrames={10} layout="none" style={{}} />,
  ]) {
    const m = mount(makeHost(), () => bad);
    await rejectsWithCode(m.app.renderFrame(0), "graphic_api_misuse");
    m.app.unmount();
  }
});

test("recorded choice: Loop times={0} renders nothing", async () => {
  assert.deepEqual(await framesSeen(<Loop durationInFrames={10} times={0}><Probe /></Loop>, [0]), [null]);
});

test("recorded choice: inside a looping Sequence, Loop.useLoop reports the Sequence's durationInFrames and iteration", async () => {
  let info: unknown;
  function Info() {
    info = Loop.useLoop();
    return null;
  }
  const m = mount(makeHost(), () => (
    <Sequence durationInFrames={30} playbackRate={2} loop>
      <Info />
    </Sequence>
  ));
  await m.app.renderFrame(40);
  assert.deepEqual(info, { durationInFrames: 30, iteration: 2 });
  m.app.unmount();
});

// ---- Freeze (SPEC 15) ----

test("Freeze: children always see the given frame, whatever Sequences surround it", async () => {
  const seen = await framesSeen(
    <Sequence from={10}>
      <Freeze frame={42}>
        <Probe />
      </Freeze>
    </Sequence>,
    [10, 50, 200],
  );
  assert.deepEqual(seen, [42, 42, 42]);
});

test("Freeze active={false} turns freezing off", async () => {
  assert.deepEqual(await framesSeen(<Freeze frame={5} active={false}><Probe /></Freeze>, [20]), [20]);
});

test("recorded choice: Freeze's active callback receives the parent's frame; true means frozen (docs example)", async () => {
  const calls: number[] = [];
  const seen = await framesSeen(
    <Sequence from={100}>
      <Freeze
        frame={30}
        active={(f) => {
          calls.push(f);
          return f < 30;
        }}
      >
        <Probe />
      </Freeze>
    </Sequence>,
    [100, 129, 130, 140],
  );
  assert.deepEqual(seen, [30, 30, 30, 40]);
  assert.ok(calls.includes(0) && calls.includes(29) && calls.includes(30) && calls.includes(40));
});

test("recorded choice: Sequences inside a Freeze mount by the frozen frame", async () => {
  const seen = await framesSeen(
    <Freeze frame={50}>
      <Sequence from={40}>
        <Probe name="in" />
      </Sequence>
      <Sequence from={60}>
        <Probe name="out" />
      </Sequence>
    </Freeze>,
    [0],
    "in",
  );
  assert.deepEqual(seen, [10]);
  const absent = await framesSeen(
    <Freeze frame={50}>
      <Sequence from={60}>
        <Probe name="out" />
      </Sequence>
    </Freeze>,
    [100],
    "out",
  );
  assert.deepEqual(absent, [null]);
});

test("recorded choice: Freeze needs a finite frame and a boolean or function for active", async () => {
  for (const bad of [
    <Freeze frame={undefined as unknown as number} />,
    <Freeze frame={Number.NaN} />,
    <Freeze frame={1} active={"yes" as unknown as boolean} />,
  ]) {
    const m = mount(makeHost(), () => bad);
    await rejectsWithCode(m.app.renderFrame(0), "graphic_api_misuse");
    m.app.unmount();
  }
});

test("recorded choice: useVideoConfig is unchanged inside Freeze", async () => {
  const m = mount(makeHost(), () => (
    <Freeze frame={3}>
      <ConfigProbe />
    </Freeze>
  ));
  await m.app.renderFrame(0);
  assert.equal(config(m)?.durationInFrames, 300);
  m.app.unmount();
});

test("values the parent computes follow the parent's timing (Sequence style is computed outside)", async () => {
  function Outer() {
    const frame = useCurrentFrame();
    return (
      <Sequence from={10} style={{ opacity: frame / 100 }} className="s">
        <Probe />
      </Sequence>
    );
  }
  const m = mount(makeHost(), Outer);
  await m.app.renderFrame(50);
  assert.equal((m.container.querySelector(".s") as HTMLElement).style.opacity, "0.5");
  assert.equal(read(m), 40);
  m.app.unmount();
});

test("recorded choice: Sequence width and height must be positive numbers; style.width/height win over them", async () => {
  for (const bad of [<Sequence width={0} />, <Sequence height={-5} />, <Sequence width={"100" as unknown as number} />]) {
    const m = mount(makeHost(), () => bad);
    await rejectsWithCode(m.app.renderFrame(0), "graphic_api_misuse");
    m.app.unmount();
  }
  const m = mount(makeHost(), () => (
    <Sequence width={400} className="sized" style={{ width: "50%" }}>
      <ConfigProbe />
    </Sequence>
  ));
  await m.app.renderFrame(0);
  assert.equal((m.container.querySelector(".sized") as HTMLElement).style.width, "50%");
  assert.equal(config(m)?.width, 400);
  m.app.unmount();
});

test("recorded choice: a negative first offset starts the first scene before frame 0", async () => {
  const seen = await seriesAt(threeScenes({ a: { offset: -10 } }), [0, 29, 30]);
  assert.deepEqual(seen, ["a10", "a39", "b0"]);
});

test("recorded choice: useCurrentFrame is negative only when a negative trimBefore or freeze asks for it", async () => {
  assert.deepEqual(await framesSeen(<Sequence trimBefore={-5}><Probe /></Sequence>, [0, 5]), [-5, 0]);
  assert.deepEqual(await framesSeen(<Freeze frame={-2}><Probe /></Freeze>, [10]), [-2]);
});
