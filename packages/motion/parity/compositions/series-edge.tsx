// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 60
// frames: 0, 1, 2, 3, 4, 9, 10, 12, 13, 22, 23, 29, 30, 33, 34, 43, 44, 59
// spec: 13 (Unspecified: offset default, non-integer offset, negative offset before frame 0), 13 (Start times)
// why: a negative first offset starts before frame 0, a fractional offset and fractional scene lengths from rates 3 and 0.3 (NOTES 5.2); kept apart in case one side throws
import React from "react";
import { AbsoluteFill, Series, useCurrentFrame } from "remotion";

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

export default function SeriesEdge() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <Series>
        <Series.Sequence durationInFrames={20} offset={-10} style={band(0)}>
          <FrameBar scale={4} color="#e6194b" />
        </Series.Sequence>
        <Series.Sequence durationInFrames={20} style={band(1)}>
          <FrameBar scale={4} color="#3cb44b" />
        </Series.Sequence>
      </Series>
      <Series>
        <Series.Sequence durationInFrames={10} offset={2.5} style={band(2)}>
          <FrameBar scale={8} color="#4363d8" />
        </Series.Sequence>
        <Series.Sequence durationInFrames={10} style={band(3)}>
          <FrameBar scale={8} color="#f58231" />
        </Series.Sequence>
      </Series>
      <Series>
        <Series.Sequence durationInFrames={10} playbackRate={3} style={band(4)}>
          <FrameBar scale={8} color="#911eb4" />
        </Series.Sequence>
        <Series.Sequence durationInFrames={10} style={band(5)}>
          <FrameBar scale={8} color="#42d4f4" />
        </Series.Sequence>
      </Series>
      <Series>
        <Series.Sequence durationInFrames={10} playbackRate={0.3} style={band(6)}>
          <FrameBar scale={8} color="#f032e6" />
        </Series.Sequence>
        <Series.Sequence durationInFrames={10} style={band(7)}>
          <FrameBar scale={8} color="#bfef45" />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
}
