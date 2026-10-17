// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 4, 5, 14, 15, 19, 20, 21, 30, 49, 50, 60, 89
// spec: 12 (freeze), 10.1, 12 (Unspecified: freeze with trimBefore, playbackRate, loop), 15
// why: Sequence freeze is a child-timeline frame while the active range follows the parent (NOTES 5.1), incl. null, 0 and nested Sequences under a frozen one
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
  return { top: `${row * 10}%`, height: "9%", backgroundColor: "#dddddd" };
}

export default function SequenceFreeze() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <Sequence freeze={10} style={band(0)}>
        <FrameBar scale={2} color="#e6194b" />
      </Sequence>
      <Sequence from={20} freeze={10} style={band(1)}>
        <FrameBar scale={2} color="#3cb44b" />
      </Sequence>
      <Sequence from={20} durationInFrames={30} freeze={40} style={band(2)}>
        <FrameBar scale={2} color="#4363d8" />
      </Sequence>
      <Sequence trimBefore={5} durationInFrames={20} freeze={10} style={band(3)}>
        <FrameBar scale={2} color="#f58231" />
      </Sequence>
      <Sequence playbackRate={2} durationInFrames={40} freeze={15} style={band(4)}>
        <FrameBar scale={2} color="#911eb4" />
      </Sequence>
      <Sequence loop durationInFrames={20} freeze={5} style={band(5)}>
        <FrameBar scale={2} color="#42d4f4" />
      </Sequence>
      <Sequence freeze={null} style={band(6)}>
        <FrameBar scale={1} color="#f032e6" />
      </Sequence>
      <Sequence freeze={0} style={band(7)}>
        <FrameBar scale={2} color="#bfef45" />
      </Sequence>
      <Sequence freeze={10} style={band(8)}>
        <Sequence from={5}>
          <FrameBar scale={2} color="#469990" />
        </Sequence>
      </Sequence>
      <Sequence freeze={10} style={band(9)}>
        <Sequence from={20}>
          <FrameBar scale={2} color="#9a6324" />
        </Sequence>
      </Sequence>
    </AbsoluteFill>
  );
}
