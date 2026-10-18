// size: 1920x1080
// fps: 30
// durationInFrames: 150
// frames: 0, 1, 30, 58, 59, 60, 61, 119, 120, 121, 149
// audio: no
// spec: 19 (Html5Video loop, as Video), 18.3 (trimming), 10.2 (order of operations)
// why: loop over trimBefore 30 .. trimAfter 90 - source 30+(f mod 60), wrapping back to source 30 at frames 60 and 120
import React from "react";
import {AbsoluteFill, Video, asset} from "remotion";

export default function VideoLoopRange() {
  return (
    <AbsoluteFill style={{backgroundColor: "#361b2b"}}>
      <Video src={asset("vid_a")} muted loop trimBefore={30} trimAfter={90} style={{width: 1920, height: 1080}} />
    </AbsoluteFill>
  );
}
