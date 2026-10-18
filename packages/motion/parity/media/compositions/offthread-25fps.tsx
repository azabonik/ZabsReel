// size: 1920x1080
// fps: 30
// durationInFrames: 150
// frames: 0, 1, 2, 3, 5, 6, 7, 30, 59, 119, 120, 149
// audio: no
// spec: 20 (OffthreadVideo), 10.7 (rounding), 20 (final frame keeps showing)
// why: a 25 fps source in a 30 fps composition - source position 5f/6 (f=3 lands on 2.5, f=1 on 0.83), the source ends at frame 120
import React from "react";
import {AbsoluteFill, OffthreadVideo, asset} from "remotion";

export default function Offthread25fps() {
  return (
    <AbsoluteFill style={{backgroundColor: "#1b2836"}}>
      <OffthreadVideo src={asset("vid_b")} style={{width: 1920, height: 1080}} />
    </AbsoluteFill>
  );
}
