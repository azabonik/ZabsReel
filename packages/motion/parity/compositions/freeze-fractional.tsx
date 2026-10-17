// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 30
// frames: 0, 1, 15, 29
// spec: 15 (frame), 15 (Unspecified: frame type), 2 (Unspecified: non-integer values)
// why: a fractional frozen frame, alone and seen through a Sequence inside the Freeze (NOTES 5.4: any finite number); kept apart in case one side throws
import React from "react";
import { AbsoluteFill, Freeze, Sequence, useCurrentFrame } from "remotion";

// White strip at the bottom: the content is mounted. Coloured bar: the frame it reads.
function FrameBar(props: { scale: number; color: string }) {
  const frame = useCurrentFrame();
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: "20%",
          backgroundColor: "#ffffff",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          height: "80%",
          width: `${Math.max(0, frame) * props.scale}%`,
          backgroundColor: props.color,
        }}
      />
    </>
  );
}

function BandDiv(props: { top: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: props.top,
        height: "40%",
        backgroundColor: "#dddddd",
      }}
    >
      {props.children}
    </div>
  );
}

export default function FreezeFractional() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <BandDiv top="5%">
        <Freeze frame={2.5}>
          <FrameBar scale={20} color="#e6194b" />
        </Freeze>
      </BandDiv>
      <BandDiv top="55%">
        <Freeze frame={2.5}>
          <Sequence from={2}>
            <FrameBar scale={20} color="#3cb44b" />
          </Sequence>
        </Freeze>
      </BandDiv>
    </AbsoluteFill>
  );
}
