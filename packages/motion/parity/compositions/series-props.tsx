// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 90
// frames: 0, 9, 10, 19, 20, 29, 30, 39, 40, 49, 50, 59, 60, 89
// spec: 13 (Series accepts Sequence props: from, playbackRate, layout; Series.Sequence freeze and layout), 13 (Unspecified: from on Series)
// why: from and playbackRate on the Series itself shift and scale all scenes (NOTES 5.2), layout absolute-fill wraps the series, a scene can freeze
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

// Positioned against the root fill, because neither the Series nor the scene renders a wrapper.
function NoneChild(props: { top: string; color: string }) {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: props.top,
        height: "11%",
        width: `${Math.max(0, frame) * 2}%`,
        backgroundColor: props.color,
      }}
    />
  );
}

function band(row: number): React.CSSProperties {
  return { top: `${row * 12.5}%`, height: "11%", backgroundColor: "#dddddd" };
}

export default function SeriesProps() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <Series from={20}>
        <Series.Sequence durationInFrames={20} style={band(0)}>
          <FrameBar scale={2} color="#e6194b" />
        </Series.Sequence>
        <Series.Sequence durationInFrames={20} style={band(1)}>
          <FrameBar scale={2} color="#3cb44b" />
        </Series.Sequence>
      </Series>
      <Series playbackRate={2}>
        <Series.Sequence durationInFrames={20} style={band(2)}>
          <FrameBar scale={2} color="#4363d8" />
        </Series.Sequence>
        <Series.Sequence durationInFrames={20} style={band(3)}>
          <FrameBar scale={2} color="#f58231" />
        </Series.Sequence>
      </Series>
      <Series layout="absolute-fill" style={band(4)}>
        <Series.Sequence durationInFrames={30} style={{ backgroundColor: "#911eb4" }}>
          <FrameBar scale={2} color="#000075" />
        </Series.Sequence>
        <Series.Sequence durationInFrames={30} style={{ backgroundColor: "#42d4f4" }}>
          <FrameBar scale={2} color="#000075" />
        </Series.Sequence>
      </Series>
      <Series>
        <Series.Sequence durationInFrames={30} freeze={7} style={band(5)}>
          <FrameBar scale={2} color="#f032e6" />
        </Series.Sequence>
        <Series.Sequence durationInFrames={30} style={band(5)}>
          <FrameBar scale={2} color="#bfef45" />
        </Series.Sequence>
      </Series>
      <Series>
        <Series.Sequence durationInFrames={40} layout="none">
          <NoneChild top="75%" color="#469990" />
        </Series.Sequence>
      </Series>
      <Series from={10} playbackRate={0.5}>
        <Series.Sequence durationInFrames={10} style={band(7)}>
          <FrameBar scale={4} color="#9a6324" />
        </Series.Sequence>
        <Series.Sequence durationInFrames={10} style={band(7)}>
          <FrameBar scale={4} color="#800000" />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
}
