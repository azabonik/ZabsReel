// size: 1920x1080
// fps: 30
// durationInFrames: 150
// frames: 0, 29, 30, 31, 44, 45, 89, 90, 99, 100, 119, 120, 149
// audio: no
// spec: 17 (Img: inherited timing props), 10.4 (active range), 12 (Sequence)
// why: Img's own from/durationInFrames (visible 30..89), an Img inside a Sequence (45..119), and hidden switching on at frame 100
import React from "react";
import {AbsoluteFill, Img, Sequence, asset, useCurrentFrame} from "remotion";

export default function ImgTiming() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{backgroundColor: "#202a20"}}>
      <Img
        src={asset("img_a")}
        from={30}
        durationInFrames={60}
        style={{position: "absolute", left: 80, top: 100, width: 800, height: 600}}
      />
      <Sequence from={45} durationInFrames={75}>
        <Img src={asset("img_c")} style={{position: "absolute", left: 1100, top: 120, width: 512, height: 512}} />
      </Sequence>
      <Img
        src={asset("img_b")}
        hidden={frame >= 100}
        style={{position: "absolute", left: 1100, top: 700, width: 480, height: 270}}
      />
    </AbsoluteFill>
  );
}
