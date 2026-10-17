// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 14, 15, 19, 20, 29, 30, 31, 44, 45, 59, 60, 89
// spec: 15 (Freeze), 15 (Unspecified: active default, callback argument, Sequences inside), 26.1, 2
// why: Freeze ignores surrounding Sequences, active false/true/callback (the f < 30 docs case), callback gets the parent's frame, inner Sequences mount by the frozen frame, frame 0 (NOTES 5.4)
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

function BandDiv(props: { row: number; children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: `${props.row * 10}%`,
        height: "9%",
        backgroundColor: "#dddddd",
      }}
    >
      {props.children}
    </div>
  );
}

export default function FreezeBasic() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <BandDiv row={0}>
        <Freeze frame={30}>
          <FrameBar scale={1} color="#e6194b" />
        </Freeze>
      </BandDiv>
      <BandDiv row={1}>
        <Freeze frame={30} active={false}>
          <FrameBar scale={1} color="#3cb44b" />
        </Freeze>
      </BandDiv>
      <BandDiv row={2}>
        <Freeze frame={30} active={(f: number) => f < 30}>
          <FrameBar scale={1} color="#4363d8" />
        </Freeze>
      </BandDiv>
      <BandDiv row={3}>
        <Sequence from={20}>
          <Freeze frame={10}>
            <FrameBar scale={1} color="#f58231" />
          </Freeze>
        </Sequence>
      </BandDiv>
      <BandDiv row={4}>
        <Freeze frame={50}>
          <Sequence from={40}>
            <FrameBar scale={1} color="#911eb4" />
          </Sequence>
        </Freeze>
      </BandDiv>
      <BandDiv row={5}>
        <Freeze frame={50}>
          <Sequence from={60}>
            <FrameBar scale={1} color="#42d4f4" />
          </Sequence>
        </Freeze>
      </BandDiv>
      <BandDiv row={6}>
        <Sequence from={30}>
          <Freeze frame={5} active={(f: number) => f >= 15}>
            <FrameBar scale={1} color="#f032e6" />
          </Freeze>
        </Sequence>
      </BandDiv>
      <BandDiv row={7}>
        <Freeze frame={20}>
          <Sequence durationInFrames={10}>
            <FrameBar scale={1} color="#bfef45" />
          </Sequence>
        </Freeze>
      </BandDiv>
      <BandDiv row={8}>
        <Freeze frame={0}>
          <FrameBar scale={1} color="#469990" />
        </Freeze>
      </BandDiv>
      <BandDiv row={9}>
        <Freeze frame={15} active>
          <FrameBar scale={1} color="#9a6324" />
        </Freeze>
      </BandDiv>
    </AbsoluteFill>
  );
}
