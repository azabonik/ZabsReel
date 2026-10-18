// size: 1920x1080
// fps: 30
// durationInFrames: 180
// frames: 0, 1, 45, 88, 89, 90, 91, 135, 178, 179
// audio: no
// spec: 19 (Html5Video loop, as Video), 10.1 (loop on components with their own duration)
// why: loop with no trims on a 3 s, 60 fps source - source 2(f mod 90), wrapping to source 0 at frame 90
import React from "react";
import {AbsoluteFill, Video, asset} from "remotion";

export default function VideoLoop() {
  return (
    <AbsoluteFill style={{backgroundColor: "#361b2b"}}>
      <Video src={asset("vid_c")} loop style={{width: 1920, height: 1080}} />
    </AbsoluteFill>
  );
}
