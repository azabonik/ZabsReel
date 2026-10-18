// size: 1920x1080
// fps: 30
// durationInFrames: 150
// frames: 0, 14, 15, 16, 17, 45, 75, 105, 134, 135, 136, 149
// audio: no
// spec: 19 (Html5Video, as Video), 12 (Sequence playbackRate, v4.0.528), 10.5 (rates multiply), 18.6
// why: Sequence from 15 with playbackRate 2 around a Video at playbackRate 0.75 - rates multiply to 1.5, source 1.5(f-15), source ends at frame 135
import React from "react";
import {AbsoluteFill, Sequence, Video, asset} from "remotion";

export default function VideoInSequenceRate() {
  return (
    <AbsoluteFill style={{backgroundColor: "#1b2836"}}>
      <Sequence from={15} playbackRate={2}>
        <Video src={asset("vid_a")} muted playbackRate={0.75} style={{width: 1920, height: 1080}} />
      </Sequence>
    </AbsoluteFill>
  );
}
