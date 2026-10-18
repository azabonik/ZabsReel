// size: 1920x1080
// fps: 30
// durationInFrames: 120
// frames: 0, 19, 20, 21, 50, 80, 89, 90, 110, 119
// audio: yes
// spec: 21 (Html5Audio, as Audio), 12.1 (Sequence time shifting), 10.4 (active range)
// why: beep track inside Sequence from 20, durationInFrames 70 - beeps at frames 20, 50, 80, cut at frame 90 (no beep at 110)
import React from "react";
import {AbsoluteFill, Audio, Sequence, asset, useCurrentFrame} from "remotion";

export default function AudioInSequence() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{backgroundColor: "#111820"}}>
      <div style={{position: "absolute", left: 0, top: 500, width: frame * 10, height: 80, backgroundColor: "#4fc3f7"}} />
      <Sequence from={20} durationInFrames={70}>
        <Audio src={asset("aud_a")} />
      </Sequence>
    </AbsoluteFill>
  );
}
