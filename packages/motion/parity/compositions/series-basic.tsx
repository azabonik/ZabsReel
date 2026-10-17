// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 150
// frames: 0, 1, 2, 3, 39, 40, 41, 59, 60, 61, 129, 130, 149
// spec: 13 (Series, Start times), 13 (Unspecified: frame inside a scene)
// why: documented durations 40, 20, 70 give scenes 0-39, 40-59, 60-129 and each scene starts at local frame 0; one-frame scenes before an Infinity scene
import React from "react";
import { AbsoluteFill, Series, useCurrentFrame } from "remotion";

// White strip at the bottom: the content is mounted. Dark bar: the frame it reads.
function FrameBar(props: { scale: number }) {
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
          backgroundColor: "#000075",
        }}
      />
    </>
  );
}

function top(color: string): React.CSSProperties {
  return { top: "0%", height: "48%", backgroundColor: color };
}

function bottom(color: string): React.CSSProperties {
  return { top: "52%", height: "48%", backgroundColor: color };
}

export default function SeriesBasic() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <Series>
        <Series.Sequence durationInFrames={40} style={top("#e6194b")}>
          <FrameBar scale={1} />
        </Series.Sequence>
        <Series.Sequence durationInFrames={20} style={top("#3cb44b")}>
          <FrameBar scale={1} />
        </Series.Sequence>
        <Series.Sequence durationInFrames={70} style={top("#4363d8")}>
          <FrameBar scale={1} />
        </Series.Sequence>
      </Series>
      <Series>
        <Series.Sequence durationInFrames={1} style={bottom("#f58231")}>
          <FrameBar scale={1} />
        </Series.Sequence>
        <Series.Sequence durationInFrames={1} style={bottom("#911eb4")}>
          <FrameBar scale={1} />
        </Series.Sequence>
        <Series.Sequence durationInFrames={1} style={bottom("#42d4f4")}>
          <FrameBar scale={1} />
        </Series.Sequence>
        <Series.Sequence durationInFrames={Infinity} style={bottom("#f032e6")}>
          <FrameBar scale={0.6} />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
}
