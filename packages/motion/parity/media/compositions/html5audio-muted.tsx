// size: 1920x1080
// fps: 30
// durationInFrames: 120
// frames: 0, 29, 30, 31, 59, 60, 61, 74, 75, 119
// audio: yes
// spec: 21 (Html5Audio: muted may vary per frame), 18.5 (muted)
// why: Html5Audio tone muted on frames 30..59 only (audible 0..29 and 60..74, source ends at 75), plus an always-muted Audio beep track that must stay silent
import React from "react";
import {AbsoluteFill, Audio, Html5Audio, asset, useCurrentFrame} from "remotion";

export default function Html5AudioMuted() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{backgroundColor: "#111820"}}>
      <div style={{position: "absolute", left: 0, top: 500, width: frame * 10, height: 80, backgroundColor: "#4fc3f7"}} />
      <Html5Audio src={asset("aud_b")} muted={frame >= 30 && frame <= 59} />
      <Audio src={asset("aud_a")} muted />
    </AbsoluteFill>
  );
}
