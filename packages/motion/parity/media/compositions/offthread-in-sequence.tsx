// size: 1920x1080
// fps: 30
// durationInFrames: 150
// frames: 0, 29, 30, 31, 60, 89, 118, 119, 120, 149
// audio: no
// spec: 20 (OffthreadVideo), 12.1 (Sequence time shifting), 10.4 (active range)
// why: inside Sequence from 30, durationInFrames 90 - nothing before 30, source f-30 on frames 30..119, nothing from 120
import React from "react";
import {AbsoluteFill, OffthreadVideo, Sequence, asset} from "remotion";

export default function OffthreadInSequence() {
  return (
    <AbsoluteFill style={{backgroundColor: "#1b2836"}}>
      <Sequence from={30} durationInFrames={90}>
        <OffthreadVideo src={asset("vid_a")} muted style={{width: 1920, height: 1080}} />
      </Sequence>
    </AbsoluteFill>
  );
}
