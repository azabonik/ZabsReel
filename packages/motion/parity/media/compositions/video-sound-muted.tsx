// size: 1920x1080
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 15, 30, 45, 59, 60, 75, 89
// audio: yes
// spec: 19 (Html5Video muted, as Video), 18.5 (muted)
// why: a video's own sound, muted - vid_a plays on screen and the output must be silent throughout
import React from "react";
import {AbsoluteFill, Video, asset} from "remotion";

export default function VideoSoundMuted() {
  return (
    <AbsoluteFill style={{backgroundColor: "#1b2836"}}>
      <Video src={asset("vid_a")} muted style={{width: 1920, height: 1080}} />
    </AbsoluteFill>
  );
}
