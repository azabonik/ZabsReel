// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 2, 3, 5, 6, 7, 10, 20, 26, 27, 29, 30, 31, 39, 40, 45, 59, 60, 61, 89
// spec: 10.3 (frame mapping), 10.4 (active range), 10.5 (nesting), 12 (trimBefore, playbackRate), 2
// why: documented trimBefore/playbackRate examples, multiplied nested rates, fractional child frames (NOTES 5.1: not rounded) and fractional active ranges
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
  return { top: `${row * 11}%`, height: "10%", backgroundColor: "#dddddd" };
}

export default function SequenceTrimRate() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <Sequence from={30} trimBefore={10} durationInFrames={60} playbackRate={2} style={band(0)}>
        <FrameBar scale={0.45} color="#e6194b" />
      </Sequence>
      <Sequence from={30} trimBefore={15} style={band(1)}>
        <FrameBar scale={0.45} color="#3cb44b" />
      </Sequence>
      <Sequence playbackRate={0.5} durationInFrames={30} style={band(2)}>
        <FrameBar scale={2} color="#4363d8" />
      </Sequence>
      <Sequence from={20} playbackRate={1.5} durationInFrames={10} style={band(3)}>
        <FrameBar scale={5} color="#f58231" />
      </Sequence>
      <Sequence playbackRate={2} style={band(4)}>
        <Sequence from={10} playbackRate={0.5}>
          <FrameBar scale={0.9} color="#911eb4" />
        </Sequence>
      </Sequence>
      <Sequence from={10} playbackRate={2} style={band(5)}>
        <Sequence from={20} playbackRate={1.5}>
          <FrameBar scale={0.45} color="#42d4f4" />
        </Sequence>
      </Sequence>
      <Sequence trimBefore={20} durationInFrames={40} style={band(6)}>
        <FrameBar scale={0.9} color="#f032e6" />
      </Sequence>
      <Sequence playbackRate={3} durationInFrames={90} style={band(7)}>
        <FrameBar scale={0.9} color="#bfef45" />
      </Sequence>
      <Sequence playbackRate={0.25} style={band(8)}>
        <FrameBar scale={4} color="#fabed4" />
      </Sequence>
    </AbsoluteFill>
  );
}
