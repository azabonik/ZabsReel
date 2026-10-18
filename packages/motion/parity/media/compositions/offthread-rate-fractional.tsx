// size: 1920x1080
// fps: 30
// durationInFrames: 150
// frames: 0, 1, 3, 4, 5, 7, 10, 30, 60, 100, 149
// audio: no
// spec: 20 (OffthreadVideo), 18.4 (playbackRate), 10.7 (rounding of fractional frames)
// why: playbackRate 0.7 - source position 0.7f, with fractions below, at and above .5 (f=3, 5, 7) and whole values (f=10, 30, 60, 100)
import React from "react";
import {AbsoluteFill, OffthreadVideo, asset} from "remotion";

export default function OffthreadRateFractional() {
  return (
    <AbsoluteFill style={{backgroundColor: "#1b3628"}}>
      <OffthreadVideo src={asset("vid_a")} muted playbackRate={0.7} style={{width: 1920, height: 1080}} />
    </AbsoluteFill>
  );
}
