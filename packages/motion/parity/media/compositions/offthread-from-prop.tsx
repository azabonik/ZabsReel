// size: 1920x1080
// fps: 30
// durationInFrames: 120
// frames: 0, 1, 29, 30, 31, 59, 60, 90, 119
// audio: no
// spec: 20 (OffthreadVideo), 10.6 and 10.7 (open: whether media components accept from)
// why: from={30} placed directly on the video, no Sequence - is it a start offset (source f-30 from frame 30) or ignored (source f)?
import React from "react";
import {AbsoluteFill, OffthreadVideo, asset} from "remotion";

export default function OffthreadFromProp() {
  return (
    <AbsoluteFill style={{backgroundColor: "#1b2836"}}>
      <OffthreadVideo src={asset("vid_a")} muted from={30} style={{width: 1920, height: 1080}} />
    </AbsoluteFill>
  );
}
