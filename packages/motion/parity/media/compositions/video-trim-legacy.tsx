// size: 1920x1080
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 15, 30, 58, 59, 60, 61, 89
// audio: no
// spec: 19 (Html5Video, as Video), 18.3 (trimming: deprecated startFrom, endAt)
// why: the deprecated names startFrom 45 + endAt 105 - source 45+f on frames 0..59, nothing from frame 60
import React from "react";
import {AbsoluteFill, Video, asset} from "remotion";

export default function VideoTrimLegacy() {
  return (
    <AbsoluteFill style={{backgroundColor: "#2b1b36"}}>
      <Video src={asset("vid_a")} muted startFrom={45} endAt={105} style={{width: 1920, height: 1080}} />
    </AbsoluteFill>
  );
}
