// size: 1920x1080
// fps: 30
// durationInFrames: 150
// frames: 0, 1, 30, 58, 59, 60, 61, 90, 119, 120, 121, 149
// audio: no
// spec: 19 (Html5Video loop, as Video), 18.3 (trimming), 10.1 (loop length without durationInFrames)
// why: loop with only trimBefore 120 - the loop length and restart point when no end is given (NOTES: rest of source, source 120+(f mod 60))
import React from "react";
import {AbsoluteFill, Video, asset} from "remotion";

export default function VideoLoopTrimBefore() {
  return (
    <AbsoluteFill style={{backgroundColor: "#361b2b"}}>
      <Video src={asset("vid_a")} muted loop trimBefore={120} style={{width: 1920, height: 1080}} />
    </AbsoluteFill>
  );
}
