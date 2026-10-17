// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 120
// frames: 0, 1, 29, 30, 31, 39, 40, 59, 60, 61, 69, 70, 89, 90, 91, 119
// spec: 12 (Sequence), 12.1, 10.3, 10.4, 10.5, 2
// why: from and durationInFrames shift and bound children, nested shifts add up (30 + 60 = 90), and values the parent computes keep the parent's timing
import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";

// White strip at the bottom: the content is mounted. Coloured bar: the value.
function Bar(props: { value: number; scale: number; color: string }) {
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
          width: `${Math.max(0, props.value) * props.scale}%`,
          backgroundColor: props.color,
        }}
      />
    </>
  );
}

function FrameBar(props: { scale: number; color: string }) {
  const frame = useCurrentFrame();
  return <Bar value={frame} scale={props.scale} color={props.color} />;
}

function band(row: number): React.CSSProperties {
  return { top: `${row * 12.5}%`, height: "11%", backgroundColor: "#dddddd" };
}

export default function SequenceBasic() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <AbsoluteFill style={band(0)}>
        <FrameBar scale={0.75} color="#e6194b" />
      </AbsoluteFill>
      <Sequence from={30} style={band(1)}>
        <FrameBar scale={0.75} color="#3cb44b" />
      </Sequence>
      <Sequence from={30} durationInFrames={30} style={band(2)}>
        <FrameBar scale={0.75} color="#4363d8" />
      </Sequence>
      <Sequence from={30} style={band(3)}>
        <Sequence from={60}>
          <FrameBar scale={0.75} color="#f58231" />
        </Sequence>
      </Sequence>
      <Sequence durationInFrames={30} style={band(4)}>
        <AbsoluteFill style={{ backgroundColor: "#911eb4" }} />
      </Sequence>
      <Sequence from={30} durationInFrames={30} style={band(4)}>
        <AbsoluteFill style={{ backgroundColor: "#42d4f4" }} />
      </Sequence>
      <Sequence from={60} style={band(4)}>
        <AbsoluteFill style={{ backgroundColor: "#f032e6" }} />
      </Sequence>
      <Sequence from={0} durationInFrames={Infinity} style={band(5)}>
        <FrameBar scale={0.75} color="#bfef45" />
      </Sequence>
      <Sequence from={40} style={band(6)}>
        <Bar value={frame} scale={0.75} color="#469990" />
      </Sequence>
      <Sequence from={20} durationInFrames={50} style={{ ...band(7), left: `${frame * 0.25}%` }}>
        <FrameBar scale={0.75} color="#9a6324" />
      </Sequence>
    </AbsoluteFill>
  );
}
