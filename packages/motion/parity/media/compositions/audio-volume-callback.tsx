// size: 1920x1080
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 15, 29, 30, 31, 45, 60, 74, 75, 89
// audio: yes
// spec: 21 (Html5Audio, as Audio), 18.2 (volume callback)
// why: volume callback ramping 0 to 1 over frames 0..30 and down to 0.25 at frame 60 on a constant tone (source ends at frame 75)
import React from "react";
import {AbsoluteFill, Audio, asset, interpolate, useCurrentFrame} from "remotion";

export default function AudioVolumeCallback() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{backgroundColor: "#111820"}}>
      <div style={{position: "absolute", left: 0, top: 500, width: frame * 10, height: 80, backgroundColor: "#4fc3f7"}} />
      <Audio
        src={asset("aud_b")}
        volume={(f: number) => interpolate(f, [0, 30, 60], [0, 1, 0.25], {extrapolateRight: "clamp"})}
      />
    </AbsoluteFill>
  );
}
