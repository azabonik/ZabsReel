// size: 1920x1080
// fps: 30
// durationInFrames: 120
// frames: 0, 1, 15, 30, 44, 45, 88, 89, 90, 91, 119
// audio: no
// spec: 19 (Html5Video, as Video), 18.4 (playbackRate), 19 (final frame keeps showing)
// why: playbackRate 2 - source 2f, the source runs out at frame 90 and its last frame should stay on screen
import React from "react";
import {AbsoluteFill, Video, asset} from "remotion";

export default function VideoRate2() {
  return (
    <AbsoluteFill style={{backgroundColor: "#1b3628"}}>
      <Video src={asset("vid_a")} muted playbackRate={2} style={{width: 1920, height: 1080}} />
    </AbsoluteFill>
  );
}
