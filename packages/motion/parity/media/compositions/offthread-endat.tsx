// size: 1920x1080
// fps: 30
// durationInFrames: 120
// frames: 0, 1, 37, 73, 74, 75, 76, 100, 119
// audio: no
// spec: 20 (OffthreadVideo), 18.3 (trimming: deprecated endAt)
// why: deprecated endAt 75 alone, without a start trim - source f on frames 0..74, nothing from frame 75
import React from "react";
import {AbsoluteFill, OffthreadVideo, asset} from "remotion";

export default function OffthreadEndAt() {
  return (
    <AbsoluteFill style={{backgroundColor: "#2b1b36"}}>
      <OffthreadVideo src={asset("vid_a")} muted endAt={75} style={{width: 1920, height: 1080}} />
    </AbsoluteFill>
  );
}
