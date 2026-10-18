// size: 1920x1080
// fps: 30
// durationInFrames: 150
// frames: 0, 15, 30, 59, 60, 105, 119, 120, 121, 149
// audio: yes
// spec: 21 (Html5Audio, as Audio), 18.4 (playbackRate, pitch preserved when rendering)
// why: beep track at playbackRate 2 - beeps every 15 frames (0..105) at the original 1 kHz pitch, silence once the 8 s source ends at frame 120
import React from "react";
import {AbsoluteFill, Audio, asset, useCurrentFrame} from "remotion";

export default function AudioRate2() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{backgroundColor: "#111820"}}>
      <div style={{position: "absolute", left: 0, top: 500, width: frame * 10, height: 80, backgroundColor: "#4fc3f7"}} />
      <Audio src={asset("aud_a")} playbackRate={2} />
    </AbsoluteFill>
  );
}
