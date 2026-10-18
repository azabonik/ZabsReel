// size: 1920x1080
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 15, 29, 30, 45, 59, 60, 75, 89
// audio: no
// spec: 19 (Html5Video: native props, any CSS), 18.1 (naming)
// why: Video style and className - a 16:9 source in a square box with a background colour (native video letterboxes, img stretches), radius, class rules, width-only sizing
import React from "react";
import {AbsoluteFill, Video, asset} from "remotion";

const css = `
.zr-ring { outline: 10px solid #ffd400; outline-offset: -10px; }
.zr-tilt { transform: rotate(-4deg); }
`;

export default function VideoStyle() {
  return (
    <AbsoluteFill style={{backgroundColor: "#14202c"}}>
      <style>{css}</style>
      <Video
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
      <Video
        src={asset("vid_b")}
        className="zr-tilt"
        style={{position: "absolute", left: 1000, top: 200, width: 800, opacity: 0.8}}
      />
    </AbsoluteFill>
  );
}
