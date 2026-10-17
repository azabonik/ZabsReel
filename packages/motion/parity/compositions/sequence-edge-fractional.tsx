// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 4, 5, 6, 10, 11, 12, 30, 89
// spec: 12 (Unspecified: non-integer from or durationInFrames, durationInFrames 0), 10.7, 10.4
// why: fractional from, trimBefore and durationInFrames and a zero duration (NOTES 5.1: allowed, active while (f - from) * rate < duration); kept apart in case one side throws
import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";

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

function band(row: number): React.CSSProperties {
  return { top: `${row * 16}%`, height: "14%", backgroundColor: "#dddddd" };
}

export default function SequenceEdgeFractional() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <Sequence from={10.5} style={band(0)}>
        <FrameBar scale={1} color="#e6194b" />
      </Sequence>
      <Sequence durationInFrames={10.5} style={band(1)}>
        <FrameBar scale={4} color="#3cb44b" />
      </Sequence>
      <Sequence durationInFrames={0} style={band(2)}>
        <FrameBar scale={1} color="#4363d8" />
      </Sequence>
      <Sequence from={0.25} playbackRate={2} durationInFrames={9} style={band(3)}>
        <FrameBar scale={5} color="#f58231" />
      </Sequence>
      <Sequence trimBefore={2.5} style={band(4)}>
        <FrameBar scale={1} color="#911eb4" />
      </Sequence>
      <Sequence from={5} durationInFrames={0.5} style={band(5)}>
        <FrameBar scale={1} color="#42d4f4" />
      </Sequence>
    </AbsoluteFill>
  );
}
