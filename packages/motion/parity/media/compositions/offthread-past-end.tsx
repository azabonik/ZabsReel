// size: 1920x1080
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 15, 28, 29, 30, 31, 45, 60, 89
// audio: no
// spec: 20 (OffthreadVideo: final frame keeps showing), 18.3 (trimming)
// why: trimBefore 150 leaves 30 source frames - source 150+f, last source frame 179 at frame 29, then held to the end
import React from "react";
import {AbsoluteFill, OffthreadVideo, asset} from "remotion";

export default function OffthreadPastEnd() {
  return (
    <AbsoluteFill style={{backgroundColor: "#36281b"}}>
      <OffthreadVideo src={asset("vid_a")} muted trimBefore={150} style={{width: 1920, height: 1080}} />
    </AbsoluteFill>
  );
}
