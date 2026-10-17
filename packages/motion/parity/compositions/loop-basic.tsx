// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 150
// frames: 0, 1, 29, 30, 31, 34, 35, 49, 50, 59, 60, 61, 74, 75, 76, 99, 100, 120, 149
// spec: 14 (Loop, Loop.useLoop), 14 (Unspecified: frame inside, total length, playbackRate span, start), 26.2
// why: iterations start at the parent's frame 0, times ends the loop (explicit Infinity too), a rate scales the child span, the documented 50 x 3 and nested 30-in-75 loops (NOTES 5.3)
import React from "react";
import { AbsoluteFill, Loop, Sequence, useCurrentFrame } from "remotion";

// Top strip: the frame read (x 1.2 %). Middle: iteration + 1 (x 8 %). Bottom: useLoop durationInFrames + 1 (x 1 %).
// A white base shows that the content is mounted; null from useLoop() leaves the two lower strips empty.
function LoopRow(props: { color: string }) {
  const frame = useCurrentFrame();
  const info = Loop.useLoop();
  const iteration = info === null ? -1 : info.iteration;
  const duration = info === null ? -1 : info.durationInFrames;
  return (
    <>
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: "#ffffff" }} />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          height: "33%",
          width: `${Math.max(0, frame) * 1.2}%`,
          backgroundColor: props.color,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: "33%",
          height: "33%",
          width: `${(iteration + 1) * 8}%`,
          backgroundColor: "#000075",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: "66%",
          height: "34%",
          width: `${(duration + 1) * 1}%`,
          backgroundColor: "#800000",
        }}
      />
    </>
  );
}

// Positioned against the root fill, because the loop renders no wrapper.
function NoneChild(props: { top: string; color: string }) {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: props.top,
        height: "10%",
        width: `${Math.max(0, frame) * 1.2}%`,
        backgroundColor: props.color,
      }}
    />
  );
}

function band(row: number): React.CSSProperties {
  return { top: `${row * 11}%`, height: "10%", backgroundColor: "#dddddd" };
}

export default function LoopBasic() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <Loop durationInFrames={30} style={band(0)}>
        <LoopRow color="#e6194b" />
      </Loop>
      <Loop durationInFrames={30} times={2} style={band(1)}>
        <LoopRow color="#3cb44b" />
      </Loop>
      <Loop durationInFrames={30} playbackRate={2} style={band(2)}>
        <LoopRow color="#4363d8" />
      </Loop>
      <Loop durationInFrames={50} times={3} style={band(3)}>
        <LoopRow color="#f58231" />
      </Loop>
      <Loop durationInFrames={75} style={band(4)}>
        <Loop durationInFrames={30}>
          <LoopRow color="#911eb4" />
        </Loop>
      </Loop>
      <Loop durationInFrames={20} layout="none">
        <NoneChild top="55%" color="#42d4f4" />
      </Loop>
      <Loop durationInFrames={40} times={Infinity} style={band(6)}>
        <LoopRow color="#f032e6" />
      </Loop>
      <Sequence from={10} style={band(7)}>
        <Loop durationInFrames={25}>
          <LoopRow color="#bfef45" />
        </Loop>
      </Sequence>
      <div style={{ position: "absolute", left: 0, right: 0, ...band(8) }}>
        <LoopRow color="#469990" />
      </div>
    </AbsoluteFill>
  );
}
