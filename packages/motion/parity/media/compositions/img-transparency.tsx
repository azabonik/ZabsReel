// size: 1920x1080
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 15, 30, 44, 45, 60, 75, 88, 89
// audio: no
// spec: 17 (Img)
// why: a PNG with transparent areas over animated solid colours, a checkerboard and an opaque image, plus an animated opacity
import React from "react";
import {AbsoluteFill, Img, asset, useCurrentFrame} from "remotion";

const panel = (left: number, top: number): React.CSSProperties => ({
  position: "absolute",
  left,
  top,
  width: 960,
  height: 540,
});

export default function ImgTransparency() {
  const frame = useCurrentFrame();
  // Whole-number channels, computed without library helpers
  const bg = `rgb(${255 - frame * 2}, ${60 + frame}, ${frame * 2})`;
  const opacity = frame / 89;
  return (
    <AbsoluteFill style={{backgroundColor: "#101418"}}>
      <div style={{...panel(0, 0), backgroundColor: bg}}>
        <Img src={asset("img_c")} style={{position: "absolute", left: 224, top: 14}} />
      </div>
      <div
        style={{
          ...panel(960, 0),
          backgroundImage: "repeating-conic-gradient(#d0d0d0 0% 25%, #ffffff 0% 50%)",
          backgroundSize: "40px 40px",
        }}
      >
        <Img src={asset("img_c")} width={400} style={{position: "absolute", left: 280, top: 70}} />
      </div>
      <div style={{...panel(0, 540), backgroundColor: "#1565c0"}}>
        <Img src={asset("img_c")} style={{position: "absolute", left: 330, top: 120, height: 300, opacity}} />
      </div>
      <div style={{...panel(960, 540), backgroundColor: bg}}>
        <Img src={asset("img_a")} style={{position: "absolute", left: 80, top: 70, width: 533, height: 400}} />
        <Img
          src={asset("img_c")}
          style={{position: "absolute", left: 400 + frame * 2, top: 90, width: 360, height: 360}}
        />
      </div>
    </AbsoluteFill>
  );
}
