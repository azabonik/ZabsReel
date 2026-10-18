// size: 1920x1080
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 15, 29, 30, 45, 59, 60, 75, 89
// audio: no
// spec: 20 (OffthreadVideo: style and className reach the image)
// why: OffthreadVideo style and className - square boxes with default fit and objectFit contain, radius, background colour, class rules (outline, grayscale)
import React from "react";
import {AbsoluteFill, OffthreadVideo, asset} from "remotion";

const css = `
.zr-ring { outline: 10px solid #ffd400; outline-offset: -10px; }
.zr-gray { filter: grayscale(1); }
`;

export default function OffthreadStyle() {
  return (
    <AbsoluteFill style={{backgroundColor: "#14202c"}}>
      <style>{css}</style>
      <OffthreadVideo
        src={asset("vid_a")}
        muted
        className="zr-ring"
        style={{
          position: "absolute",
          left: 60,
          top: 140,
          width: 800,
          height: 800,
          borderRadius: 48,
          backgroundColor: "#ff2d6f",
        }}
      />
      <OffthreadVideo
        src={asset("vid_c")}
        className="zr-gray"
        style={{
          position: "absolute",
          left: 1000,
          top: 140,
          width: 800,
          height: 800,
          objectFit: "contain",
          backgroundColor: "#3355ff",
        }}
      />
    </AbsoluteFill>
  );
}
