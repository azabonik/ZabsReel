// size: 1920x1080
// fps: 30
// durationInFrames: 120
// frames: 0, 14, 15, 16, 30, 45, 60, 75, 90, 119
// audio: yes
// spec: 21 (Html5Audio, as Audio), 12.1 (Sequence), 18.2 (volume)
// why: the same beep asset twice, the second inside Sequence from 15 at volume 0.5 - full beeps at 0, 30, 60, 90 and half beeps at 15, 45, 75, 105
import React from "react";
import {AbsoluteFill, Audio, Sequence, asset, useCurrentFrame} from "remotion";

export default function AudioSameAssetTwice() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{backgroundColor: "#111820"}}>
      <div style={{position: "absolute", left: 0, top: 500, width: frame * 10, height: 80, backgroundColor: "#4fc3f7"}} />
      <Audio src={asset("aud_a")} />
      <Sequence from={15}>
        <Audio src={asset("aud_a")} volume={0.5} />
      </Sequence>
    </AbsoluteFill>
  );
}
