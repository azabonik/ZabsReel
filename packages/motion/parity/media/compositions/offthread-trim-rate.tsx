// size: 1920x1080
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 15, 30, 45, 58, 59, 60, 61, 89
// audio: no
// spec: 20 (OffthreadVideo), 18.3 (trimming, open: source vs parent frames under a rate), 18.4 (playbackRate)
// why: trimBefore 40 + trimAfter 160 at playbackRate 2 - source-frame trims give 40+2f until frame 59; parent-frame trims would give 80+2f
import React from "react";
import {AbsoluteFill, OffthreadVideo, asset} from "remotion";

export default function OffthreadTrimRate() {
  return (
    <AbsoluteFill style={{backgroundColor: "#36361b"}}>
      <OffthreadVideo
        src={asset("vid_a")}
        muted
        trimBefore={40}
        trimAfter={160}
        playbackRate={2}
        style={{width: 1920, height: 1080}}
      />
    </AbsoluteFill>
  );
}
