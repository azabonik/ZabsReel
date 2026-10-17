// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 19, 20, 29, 30, 89
// spec: 12 (Unspecified: negative from), 10.7, 10.3, 10.4
// why: negative from starts the child timeline before frame 0 (NOTES 5.1 allows it); kept apart so a throw here hides no other rows
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

export default function SequenceEdgeNegative() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <Sequence from={-10} durationInFrames={40} style={band(0)}>
        <FrameBar scale={0.9} color="#e6194b" />
      </Sequence>
      <Sequence from={-10} style={band(1)}>
        <FrameBar scale={0.9} color="#3cb44b" />
      </Sequence>
      <Sequence from={20} style={band(2)}>
        <Sequence from={-15}>
          <FrameBar scale={0.9} color="#4363d8" />
        </Sequence>
      </Sequence>
      <Sequence from={100} style={band(3)}>
        <FrameBar scale={0.9} color="#f58231" />
      </Sequence>
      <Sequence from={-30} durationInFrames={30} style={band(4)}>
        <FrameBar scale={0.9} color="#911eb4" />
      </Sequence>
      <Sequence from={-30} durationInFrames={31} style={band(5)}>
        <FrameBar scale={0.9} color="#42d4f4" />
      </Sequence>
    </AbsoluteFill>
  );
}
