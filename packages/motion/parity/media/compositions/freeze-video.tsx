// size: 1920x1080
// fps: 30
// durationInFrames: 120
// frames: 0, 1, 29, 30, 31, 45, 59, 60, 61, 90, 119
// audio: yes
// spec: 15 (Freeze: video paused, active callback), 18.6, 19 (Html5Video, as Video), 20 (OffthreadVideo)
// why: left, unmuted Video in Freeze frame 45 active from frame 60 (plays with sound, then frozen on 45); right, Sequence from 30 > Freeze 10 > 25 fps video
import React from "react";
import {AbsoluteFill, Freeze, OffthreadVideo, Sequence, Video, asset} from "remotion";

const half = (left: number): React.CSSProperties => ({
  position: "absolute",
  left,
  top: 270,
  width: 960,
  height: 540,
});

export default function FreezeVideo() {
  return (
    <AbsoluteFill style={{backgroundColor: "#202020"}}>
      <div style={half(0)}>
        <Freeze frame={45} active={(f: number) => f >= 60}>
          <Video src={asset("vid_a")} style={{width: 960, height: 540}} />
        </Freeze>
      </div>
      <div style={half(960)}>
        <Sequence from={30}>
          <Freeze frame={10}>
            <OffthreadVideo src={asset("vid_b")} style={{width: 960, height: 540}} />
          </Freeze>
        </Sequence>
      </div>
    </AbsoluteFill>
  );
}
