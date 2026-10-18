// size: 1920x1080
// fps: 30
// durationInFrames: 120
// frames: 0, 1, 30, 60, 74, 75, 76, 90, 119
// audio: yes
// spec: 21 (Html5Audio, as Audio), 18.2 (volume as a number)
// why: constant volume 0.4 on a 2.5 s tone - steady level to frame 74, silence once the source ends at frame 75
import React from "react";
import {AbsoluteFill, Audio, asset, useCurrentFrame} from "remotion";

export default function AudioVolumeConstant() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{backgroundColor: "#111820"}}>
      <div style={{position: "absolute", left: 0, top: 500, width: frame * 10, height: 80, backgroundColor: "#4fc3f7"}} />
      <Audio src={asset("aud_b")} volume={0.4} />
    </AbsoluteFill>
  );
}
