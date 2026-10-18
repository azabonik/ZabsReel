// size: 1920x1080
// fps: 30
// durationInFrames: 150
// frames: 0, 1, 2, 29, 30, 59, 60, 89, 119, 149
// audio: no
// spec: 20 (OffthreadVideo), 10.3 (frame mapping)
// why: baseline mapping with no trim or rate - composition frame f shows source frame f of a 30 fps source
import React from "react";
import {AbsoluteFill, OffthreadVideo, asset} from "remotion";

export default function OffthreadPlain() {
  return (
    <AbsoluteFill style={{backgroundColor: "#1b2836"}}>
      <OffthreadVideo src={asset("vid_a")} muted style={{width: 1920, height: 1080}} />
    </AbsoluteFill>
  );
}
