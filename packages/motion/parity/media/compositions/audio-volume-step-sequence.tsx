// size: 1920x1080
// fps: 30
// durationInFrames: 120
// frames: 0, 29, 30, 31, 44, 45, 46, 59, 60, 61, 89, 90, 119
// audio: yes
// spec: 21 (Html5Audio, as Audio), 18.2 (open: which frame the volume callback counts from), 18.3 (trimBefore), 12.1
// why: step volume (1 below callback frame 30, then 0.2) inside Sequence from 30 with trimBefore 15 - the step lands at 60 (media start), 45 (trim included) or 30 (composition frame)
import React from "react";
import {AbsoluteFill, Audio, Sequence, asset, useCurrentFrame} from "remotion";

export default function AudioVolumeStepSequence() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{backgroundColor: "#111820"}}>
      <div style={{position: "absolute", left: 0, top: 500, width: frame * 10, height: 80, backgroundColor: "#4fc3f7"}} />
      <Sequence from={30}>
        <Audio src={asset("aud_b")} trimBefore={15} volume={(f: number) => (f < 30 ? 1 : 0.2)} />
      </Sequence>
    </AbsoluteFill>
  );
}
