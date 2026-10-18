// size: 1920x1080
// fps: 30
// durationInFrames: 120
// frames: 0, 29, 30, 31, 59, 60, 88, 89, 90, 119
// audio: yes
// spec: 20 (OffthreadVideo), 18.2 (default volume), 12.1 (Sequence), 10.4 (active range)
// why: a video's own sound, unmuted - vid_a's tone inside Sequence from 30, durationInFrames 60: silence, tone from 1 s to 3 s, silence
import React from "react";
import {AbsoluteFill, OffthreadVideo, Sequence, asset} from "remotion";

export default function OffthreadSound() {
  return (
    <AbsoluteFill style={{backgroundColor: "#1b2836"}}>
      <Sequence from={30} durationInFrames={60}>
        <OffthreadVideo src={asset("vid_a")} style={{width: 1920, height: 1080}} />
      </Sequence>
    </AbsoluteFill>
  );
}
