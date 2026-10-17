// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 150
// frames: 0, 9, 10, 34, 35, 39, 40, 54, 55, 74, 75, 77, 78, 92, 93, 94, 132, 133, 149
// spec: 13 (Series.Sequence offset, trimBefore, playbackRate, Infinity on the last scene; Start times)
// why: positive and negative offsets shift later scenes, trimBefore keeps the start, a scene's rate sets its length; derived starts 10, 35, 55, 78, 93, 133 (NOTES 5.2)
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
  return { top: `${row * 16}%`, height: "14%", backgroundColor: "#dddddd" };
}

export default function SeriesOffsets() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <Series>
        <Series.Sequence durationInFrames={30} offset={10} style={band(0)}>
          <FrameBar scale={2.5} color="#e6194b" />
        </Series.Sequence>
        <Series.Sequence durationInFrames={20} offset={-5} style={band(1)}>
          <FrameBar scale={2.5} color="#3cb44b" />
        </Series.Sequence>
        <Series.Sequence durationInFrames={20} trimBefore={5} style={band(2)}>
          <FrameBar scale={2.5} color="#4363d8" />
        </Series.Sequence>
        <Series.Sequence durationInFrames={30} offset={3} playbackRate={2} style={band(3)}>
          <FrameBar scale={2.5} color="#f58231" />
        </Series.Sequence>
        <Series.Sequence durationInFrames={20} playbackRate={0.5} style={band(4)}>
          <FrameBar scale={2.5} color="#911eb4" />
        </Series.Sequence>
        <Series.Sequence durationInFrames={Infinity} style={band(5)}>
          <FrameBar scale={2.5} color="#42d4f4" />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
}
