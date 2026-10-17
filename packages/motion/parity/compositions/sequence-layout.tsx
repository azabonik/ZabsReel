// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 10, 11, 30, 45, 60, 89
// spec: 12 (layout, style, className, name, showInTimeline, hidden, cropLeft/Right/Top/Bottom), 12.3
// why: layout none has no wrapper, hidden removes a subtree, and crops with inline corner radii, animated and overlapping crops (NOTES 5.1)
import React from "react";
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from "remotion";

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

// Positioned against the nearest positioned ancestor, which is the root fill when there is no wrapper.
function NoneChild(props: { top: string; color: string }) {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: props.top,
        height: "9%",
        width: `${Math.max(0, frame)}%`,
        backgroundColor: props.color,
      }}
    />
  );
}

function band(row: number): React.CSSProperties {
  return { top: `${row * 10}%`, height: "9%", backgroundColor: "#dddddd" };
}

export default function SequenceLayout() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <Sequence from={10} layout="none">
        <NoneChild top="0%" color="#e6194b" />
      </Sequence>
      <Sequence hidden style={band(1)}>
        <FrameBar scale={1} color="#3cb44b" />
      </Sequence>
      <Sequence hidden={false} style={band(2)}>
        <FrameBar scale={1} color="#4363d8" />
      </Sequence>
      <Sequence name="Named" showInTimeline={false} style={band(3)}>
        <FrameBar scale={1} color="#f58231" />
      </Sequence>
      <Sequence className="custom-class" style={{ ...band(4), opacity: 0.5 }}>
        <FrameBar scale={1} color="#911eb4" />
      </Sequence>
      <Sequence cropLeft={0.25} style={{ ...band(5), borderRadius: 40, backgroundColor: "#42d4f4" }}>
        <FrameBar scale={1} color="#000075" />
      </Sequence>
      <Sequence
        cropRight={interpolate(frame, [0, 89], [0, 0.6])}
        style={{
          ...band(6),
          backgroundColor: "#f032e6",
          borderTopLeftRadius: 30,
          borderBottomRightRadius: 30,
        }}
      >
        <FrameBar scale={1} color="#000075" />
      </Sequence>
      <Sequence cropTop={0.3} cropBottom={0.3} style={{ ...band(7), backgroundColor: "#bfef45" }}>
        <FrameBar scale={1} color="#000075" />
      </Sequence>
      <Sequence cropLeft={0.6} cropRight={0.6} style={{ ...band(8), backgroundColor: "#469990" }}>
        <FrameBar scale={1} color="#000075" />
      </Sequence>
      <Sequence hidden style={band(9)}>
        <Sequence>
          <FrameBar scale={1} color="#9a6324" />
        </Sequence>
      </Sequence>
    </AbsoluteFill>
  );
}
