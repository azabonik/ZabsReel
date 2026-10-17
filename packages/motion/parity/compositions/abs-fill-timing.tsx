// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 150
// frames: 0, 1, 9, 10, 29, 30, 31, 40, 49, 50, 59, 60, 79, 80, 89, 109, 110, 119, 120, 149
// spec: 11 (Timing props), 10.1, 10.3, 10.4, 10.5, 2
// why: AbsoluteFill's inherited from, durationInFrames, trimBefore, playbackRate, freeze and hidden; without them it leaves time unchanged (NOTES 5.1)
import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

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
  return { top: `${row * 12.5}%`, height: "11%", backgroundColor: "#dddddd" };
}

export default function AbsFillTiming() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <AbsoluteFill style={band(0)}>
        <FrameBar scale={0.5} color="#e6194b" />
      </AbsoluteFill>
      <AbsoluteFill from={30} durationInFrames={90} style={band(1)}>
        <FrameBar scale={0.5} color="#3cb44b" />
      </AbsoluteFill>
      <AbsoluteFill from={30} trimBefore={15} style={band(2)}>
        <FrameBar scale={0.5} color="#4363d8" />
      </AbsoluteFill>
      <AbsoluteFill from={30} trimBefore={10} durationInFrames={60} playbackRate={2} style={band(3)}>
        <FrameBar scale={0.5} color="#f58231" />
      </AbsoluteFill>
      <AbsoluteFill from={10} durationInFrames={100} freeze={20} style={band(4)}>
        <FrameBar scale={0.5} color="#911eb4" />
      </AbsoluteFill>
      <AbsoluteFill hidden style={band(5)}>
        <FrameBar scale={0.5} color="#42d4f4" />
      </AbsoluteFill>
      <AbsoluteFill playbackRate={0.5} durationInFrames={40} style={band(6)}>
        <FrameBar scale={2} color="#f032e6" />
      </AbsoluteFill>
      <AbsoluteFill from={20} style={band(7)}>
        <AbsoluteFill from={10} trimBefore={5}>
          <FrameBar scale={0.5} color="#bfef45" />
        </AbsoluteFill>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
