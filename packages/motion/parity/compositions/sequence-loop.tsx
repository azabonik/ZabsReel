// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 120
// frames: 0, 1, 9, 10, 14, 15, 16, 29, 30, 44, 45, 49, 50, 59, 60, 89, 119
// spec: 12 (loop), 10.3 (looping formula), 10.4, 14 (Loop.useLoop inside a looping Sequence)
// why: looping Sequences incl. the documented trimBefore 30 / duration 30 / rate 2 cycle of 15 frames, capping by a parent, and useLoop's report (NOTES 5.3)
import React from "react";
import { AbsoluteFill, Loop, Sequence, useCurrentFrame } from "remotion";

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

// Upper bar: iteration + 1. Lower bar: reported durationInFrames + 1. Both zero when useLoop() is null.
function LoopInfo() {
  const info = Loop.useLoop();
  const iteration = info === null ? -1 : info.iteration;
  const duration = info === null ? -1 : info.durationInFrames;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          height: "45%",
          width: `${(iteration + 1) * 8}%`,
          backgroundColor: "#000075",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: "50%",
          height: "45%",
          width: `${(duration + 1) * 2}%`,
          backgroundColor: "#800000",
        }}
      />
    </>
  );
}

function band(row: number): React.CSSProperties {
  return { top: `${row * 14}%`, height: "12.5%", backgroundColor: "#dddddd" };
}

export default function SequenceLoop() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <Sequence loop trimBefore={30} durationInFrames={30} playbackRate={2} style={band(0)}>
        <FrameBar scale={1.2} color="#e6194b" />
      </Sequence>
      <Sequence loop from={10} durationInFrames={20} style={band(1)}>
        <FrameBar scale={1.2} color="#3cb44b" />
      </Sequence>
      <Sequence durationInFrames={50} style={band(2)}>
        <Sequence loop durationInFrames={15}>
          <FrameBar scale={1.2} color="#4363d8" />
        </Sequence>
      </Sequence>
      <Sequence loop from={10} durationInFrames={20} style={band(3)}>
        <LoopInfo />
      </Sequence>
      <Sequence loop durationInFrames={25} playbackRate={0.5} style={band(4)}>
        <FrameBar scale={2.4} color="#f58231" />
      </Sequence>
      <Sequence loop durationInFrames={40} style={band(5)}>
        <Sequence loop durationInFrames={15}>
          <FrameBar scale={1.2} color="#911eb4" />
        </Sequence>
      </Sequence>
      <Sequence loop trimBefore={30} durationInFrames={30} playbackRate={2} style={band(6)}>
        <LoopInfo />
      </Sequence>
    </AbsoluteFill>
  );
}
