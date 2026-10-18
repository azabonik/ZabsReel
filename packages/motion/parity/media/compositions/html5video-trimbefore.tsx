// size: 1920x1080
// fps: 30
// durationInFrames: 150
// frames: 0, 1, 30, 59, 60, 90, 118, 119, 120, 121, 149
// audio: no
// spec: 19 (Html5Video), 18.3 (trimming: trimBefore example), 19 (final frame keeps showing)
// why: SPEC's trimBefore={60} example under the Html5Video name - source 60+f, last source frame 179 at frame 119, held from frame 120
import React from "react";
import {AbsoluteFill, Html5Video, asset} from "remotion";

export default function Html5VideoTrimBefore() {
  return (
    <AbsoluteFill style={{backgroundColor: "#36281b"}}>
      <Html5Video src={asset("vid_a")} muted trimBefore={60} style={{width: 1920, height: 1080}} />
    </AbsoluteFill>
  );
}
