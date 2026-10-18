// size: 1920x1080
// fps: 30
// durationInFrames: 120
// frames: 0, 1, 2, 15, 30, 45, 59, 88, 89, 90, 91, 119
// audio: no
// spec: 20 (OffthreadVideo), 20 (final frame keeps showing)
// why: a 60 fps source in a 30 fps composition - source 2f, every frame exactly on a source frame boundary, the source ends at frame 90
import React from "react";
import {AbsoluteFill, OffthreadVideo, asset} from "remotion";

export default function Offthread60fps() {
  return (
    <AbsoluteFill style={{backgroundColor: "#1b2836"}}>
      <OffthreadVideo src={asset("vid_c")} style={{width: 1920, height: 1080}} />
    </AbsoluteFill>
  );
}
