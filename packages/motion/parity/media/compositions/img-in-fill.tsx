// size: 1920x1080
// fps: 30
// durationInFrames: 120
// frames: 0, 1, 30, 44, 45, 46, 60, 89, 90, 119
// audio: no
// spec: 11 (AbsoluteFill), 12.3 (Sequence layout), 17 (Img), 20 (OffthreadVideo)
// why: media with no size props as direct children of a flex-column AbsoluteFill and of a Sequence's default wrapper (stretch vs natural size)
import React from "react";
import {AbsoluteFill, Img, OffthreadVideo, Sequence, asset} from "remotion";

export default function ImgInFill() {
  return (
    <AbsoluteFill style={{backgroundColor: "#1a1a24"}}>
      {/* left half: a 512x512 image straight inside an AbsoluteFill */}
      <AbsoluteFill style={{width: 960, backgroundColor: "#3b2a4a"}}>
        <Img src={asset("img_c")} />
      </AbsoluteFill>
      {/* right half: a 640x360 video straight inside a Sequence, from frame 45 */}
      <AbsoluteFill style={{left: 960, width: 960}}>
        <Sequence from={45} style={{backgroundColor: "#24384a"}}>
          <OffthreadVideo src={asset("vid_c")} />
        </Sequence>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
