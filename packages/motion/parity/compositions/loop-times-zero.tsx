// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 60
// frames: 0, 1, 39, 40, 59
// spec: 14 (times), 14 (Unspecified: total length)
// why: times={0} shows nothing (NOTES 5.3 allows whole numbers >= 0); kept apart so a throw here hides no other Loop rows
import React from "react";
import { AbsoluteFill, Loop, useCurrentFrame } from "remotion";

// White strip at the bottom: the content is mounted. Coloured bar: the frame it reads.
function FrameBar(props: { scale: number; color: string }) {
  const frame = useCurrentFrame();
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: "20%",
          backgroundColor: "#ffffff",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          height: "80%",
          width: `${Math.max(0, frame) * props.scale}%`,
          backgroundColor: props.color,
        }}
      />
    </>
  );
}

export default function LoopTimesZero() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <AbsoluteFill style={{ top: "5%", height: "40%", backgroundColor: "#dddddd" }}>
        <FrameBar scale={1.5} color="#e6194b" />
      </AbsoluteFill>
      <Loop durationInFrames={40} times={0} style={{ top: "55%", height: "40%", backgroundColor: "#dddddd" }}>
        <FrameBar scale={1.5} color="#3cb44b" />
      </Loop>
    </AbsoluteFill>
  );
}
