// size: 1920x1080
// fps: 30
// durationInFrames: 120
// frames: 0, 1, 29, 30, 59, 88, 89, 90, 91, 119
// audio: no
// spec: 20 (OffthreadVideo), 18.3 (trimming: trimBefore, trimAfter)
// why: trimBefore 30 + trimAfter 120 - source 30+f on frames 0..89, nothing from frame 90
import React from "react";
import {AbsoluteFill, OffthreadVideo, asset} from "remotion";

export default function OffthreadTrim() {
  return (
    <AbsoluteFill style={{backgroundColor: "#2b1b36"}}>
      <OffthreadVideo
        src={asset("vid_a")}
        muted
        trimBefore={30}
        trimAfter={120}
        style={{width: 1920, height: 1080}}
      />
    </AbsoluteFill>
  );
}
