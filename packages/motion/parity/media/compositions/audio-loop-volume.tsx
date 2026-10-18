// size: 1920x1080
// fps: 30
// durationInFrames: 180
// frames: 0, 1, 37, 74, 75, 76, 112, 149, 150, 151, 179
// audio: yes
// spec: 21 (Html5Audio loop, as Audio), 18.2 (volume callback, loopVolumeCurveBehavior default "repeat")
// why: looped 2.5 s tone with a falling volume callback and the default curve behaviour - the ramp restarts at 1 on every iteration (frames 75, 150)
import React from "react";
import {AbsoluteFill, Audio, asset, interpolate, useCurrentFrame} from "remotion";

export default function AudioLoopVolume() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{backgroundColor: "#111820"}}>
      <div style={{position: "absolute", left: 0, top: 500, width: frame * 10, height: 80, backgroundColor: "#4fc3f7"}} />
      <Audio
        src={asset("aud_b")}
        loop
        volume={(f: number) => interpolate(f, [0, 150], [1, 0], {extrapolateRight: "clamp"})}
      />
    </AbsoluteFill>
  );
}
