// size: 1920x1080
// fps: 30
// durationInFrames: 180
// frames: 0, 14, 15, 45, 74, 75, 76, 90, 120, 165, 179
// audio: yes
// spec: 21 (Html5Audio loop, as Audio), 18.3 (trimming), 10.1 (loop length without durationInFrames)
// why: beep track looped with trimBefore 165 (5.5 s, 2.5 s left) - NOTES predicts beeps at 15, 45, 90, 120, 165; a restart at source 0 would beep at 75, 105, 135, 165
import React from "react";
import {AbsoluteFill, Audio, asset, useCurrentFrame} from "remotion";

export default function AudioLoop() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{backgroundColor: "#111820"}}>
      <div style={{position: "absolute", left: 0, top: 500, width: frame * 10, height: 80, backgroundColor: "#4fc3f7"}} />
      <Audio src={asset("aud_a")} loop trimBefore={165} />
    </AbsoluteFill>
  );
}
