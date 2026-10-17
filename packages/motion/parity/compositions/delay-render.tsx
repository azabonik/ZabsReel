// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 60
// frames: 0, 1, 2, 30, 59
// spec: 22 (delayRender: handle per instance, useState initialiser, labels, multiple calls), 23 (continueRender)
// why: state set in a promise callback right before continueRender must be on the captured frame: one handle opened at mount, and two handles released at different depths
import React, { useEffect, useState } from "react";
import { AbsoluteFill, continueRender, delayRender } from "remotion";

// Red full-width bar until the loaded value arrives, then a green bar 70 % wide.
function LoadOnce() {
  const [handle] = useState(() => delayRender("load-once"));
  const [value, setValue] = useState<number | null>(null);
  useEffect(() => {
    Promise.resolve(70).then((loaded) => {
      setValue(loaded);
      continueRender(handle);
    });
  }, [handle]);
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: "4%",
        height: "40%",
        width: value === null ? "100%" : `${value}%`,
        backgroundColor: value === null ? "#e6194b" : "#3cb44b",
      }}
    />
  );
}

// Two handles; the second is released three microtasks later than the first.
function TwoHandles() {
  const [first] = useState(() => delayRender("two-handles-first"));
  const [second] = useState(() => delayRender("two-handles-second"));
  const [a, setA] = useState(0);
  const [b, setB] = useState(0);
  useEffect(() => {
    Promise.resolve().then(() => {
      setA(40);
      continueRender(first);
    });
    Promise.resolve()
      .then(() => null)
      .then(() => null)
      .then(() => {
        setB(80);
        continueRender(second);
      });
  }, [first, second]);
  return (
    <>
      <div style={{ position: "absolute", left: 0, top: "52%", height: "20%", width: `${a}%`, backgroundColor: "#f58231" }} />
      <div style={{ position: "absolute", left: 0, top: "76%", height: "20%", width: `${b}%`, backgroundColor: "#911eb4" }} />
    </>
  );
}

export default function DelayRenderScene() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <LoadOnce />
      <TwoHandles />
    </AbsoluteFill>
  );
}
