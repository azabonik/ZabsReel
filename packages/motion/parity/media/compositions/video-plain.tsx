// size: 1920x1080
// fps: 30
// durationInFrames: 150
// frames: 0, 1, 2, 29, 30, 59, 60, 89, 119, 149
// audio: no
// spec: 19 (Html5Video, as Video), 18.1 (naming), 10.3 (frame mapping)
// why: the same baseline as offthread-plain through the Video name, to separate mapping rules from Html5 seek accuracy
import React from "react";
import {AbsoluteFill, Video, asset} from "remotion";

export default function VideoPlain() {
  return (
    <AbsoluteFill style={{backgroundColor: "#1b2836"}}>
      <Video src={asset("vid_a")} muted style={{width: 1920, height: 1080}} />
    </AbsoluteFill>
  );
}
