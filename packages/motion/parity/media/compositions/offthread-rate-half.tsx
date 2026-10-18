// size: 1920x1080
// fps: 30
// durationInFrames: 150
// frames: 0, 1, 2, 3, 29, 30, 31, 59, 60, 61, 119, 149
// audio: no
// spec: 20 (OffthreadVideo), 18.4 (playbackRate), 10.7 (rounding of fractional frames)
// why: playbackRate 0.5 - source position 0.5f, so every odd frame lands exactly on .5 and shows the rounding rule
import React from "react";
import {AbsoluteFill, OffthreadVideo, asset} from "remotion";

export default function OffthreadRateHalf() {
  return (
    <AbsoluteFill style={{backgroundColor: "#1b3628"}}>
      <OffthreadVideo src={asset("vid_a")} muted playbackRate={0.5} style={{width: 1920, height: 1080}} />
    </AbsoluteFill>
  );
}
