// size: 1920x1080
// fps: 30
// durationInFrames: 120
// frames: 0, 14, 15, 45, 75, 89, 90, 104, 105, 119
// audio: yes
// spec: 21 (Html5Audio, as Audio), 18.3 (trimming: trimBefore, trimAfter)
// why: beep track with trimBefore 15 + trimAfter 105 - beeps at frames 15, 45, 75, silence from frame 90 (an untrimmed end would beep at 105)
import React from "react";
import {AbsoluteFill, Audio, asset, useCurrentFrame} from "remotion";

export default function AudioTrim() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{backgroundColor: "#111820"}}>
      <div style={{position: "absolute", left: 0, top: 500, width: frame * 10, height: 80, backgroundColor: "#4fc3f7"}} />
      <Audio src={asset("aud_a")} trimBefore={15} trimAfter={105} />
    </AbsoluteFill>
  );
}
