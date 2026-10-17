// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 30
// frames: 0, 1, 2, 15, 29
// spec: 22 (delayRender), 23 (continueRender), 25 (useDelayRender); BRIEF 4 (renderFrame settles after updates and the delays they open)
// why: delays opened in effects after a commit: per frame (global and hook), a second delay opened by an update committed after the first is released, a plain effect setState; kept apart because capture timing may differ (NOTES 2)
import React, { useEffect, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, useCurrentFrame, useDelayRender } from "remotion";

// Coloured bar: the value. Yellow strip: shown while the value lags behind the frame.
function Row(props: { index: number; value: number; frame: number; color: string }) {
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: `${props.index * 20 + 1}%`,
          height: "14%",
          width: `${Math.max(0, props.value) * 3}%`,
          backgroundColor: props.color,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: `${props.index * 20 + 16}%`,
          height: "3%",
          width: props.value === props.frame ? "0%" : "100%",
          backgroundColor: "#ffe119",
        }}
      />
    </>
  );
}

// Row 0: one global delay per frame, released after two microtasks.
function PerFrame() {
  const frame = useCurrentFrame();
  const [shown, setShown] = useState(-1);
  useEffect(() => {
    const handle = delayRender(`per-frame-${frame}`);
    Promise.resolve(frame)
      .then((value) => value + 0)
      .then((value) => {
        setShown(value);
        continueRender(handle);
      });
  }, [frame]);
  return <Row index={0} value={shown} frame={frame} color="#4363d8" />;
}

// Row 1: the same with useDelayRender's functions.
function PerFrameHook() {
  const frame = useCurrentFrame();
  const { delayRender: delay, continueRender: release } = useDelayRender();
  const [shown, setShown] = useState(-1);
  useEffect(() => {
    const handle = delay(`hook-per-frame-${frame}`);
    Promise.resolve(frame)
      .then((value) => value + 0)
      .then((value) => {
        setShown(value);
        release(handle);
      });
    // Only the frame: the hook's functions need not be stable between renders.
  }, [frame]);
  return <Row index={1} value={shown} frame={frame} color="#911eb4" />;
}

// Rows 2-4: a, then b from a second delay opened in an effect of a's commit, then c from a plain effect setState.
function Chain() {
  const frame = useCurrentFrame();
  const [a, setA] = useState(-1);
  const [b, setB] = useState(-1);
  const [c, setC] = useState(-1);
  useEffect(() => {
    const handle = delayRender("chain-first");
    Promise.resolve().then(() => {
      setA(frame);
      continueRender(handle);
    });
  }, [frame]);
  useEffect(() => {
    if (a < 0) {
      return;
    }
    const handle = delayRender("chain-second");
    Promise.resolve().then(() => {
      setB(a);
      continueRender(handle);
    });
  }, [a]);
  useEffect(() => {
    setC(frame);
  }, [frame]);
  return (
    <>
      <Row index={2} value={a} frame={frame} color="#e6194b" />
      <Row index={3} value={b} frame={frame} color="#3cb44b" />
      <Row index={4} value={c} frame={frame} color="#42d4f4" />
    </>
  );
}

export default function DelayRenderChain() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <PerFrame />
      <PerFrameHook />
      <Chain />
    </AbsoluteFill>
  );
}
