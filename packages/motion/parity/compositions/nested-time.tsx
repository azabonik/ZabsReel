// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 120
// frames: 0, 1, 9, 10, 14, 15, 19, 20, 29, 30, 34, 35, 39, 40, 54, 55, 59, 60, 79, 80, 119
// spec: 2 (useCurrentFrame in shifted subtrees), 10.5 (nesting), 13, 14, 15, 12 (freeze)
// why: useCurrentFrame through chains of Sequence, Series, Loop and Freeze, with rates and trims at several levels, plus the absolute frame passed down as a prop
import React from "react";
import { AbsoluteFill, Freeze, Loop, Sequence, Series, useCurrentFrame } from "remotion";

// White strip at the bottom: the content is mounted. Coloured bar: the value.
function Bar(props: { value: number; scale: number; color: string }) {
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
          width: `${Math.max(0, props.value) * props.scale}%`,
          backgroundColor: props.color,
        }}
      />
    </>
  );
}

function FrameBar(props: { scale: number; color: string }) {
  const frame = useCurrentFrame();
  return <Bar value={frame} scale={props.scale} color={props.color} />;
}

function band(row: number): React.CSSProperties {
  return { top: `${row * 10}%`, height: "9%", backgroundColor: "#dddddd" };
}

function BandDiv(props: { row: number; children: React.ReactNode }) {
  return <div style={{ position: "absolute", left: 0, right: 0, ...band(props.row) }}>{props.children}</div>;
}

export default function NestedTime() {
  const absolute = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <Sequence from={30} style={band(0)}>
        <Sequence from={10}>
          <Bar value={absolute} scale={0.8} color="#e6194b" />
        </Sequence>
      </Sequence>
      <Sequence from={10} style={band(1)}>
        <Sequence from={20}>
          <Sequence from={5} trimBefore={3}>
            <FrameBar scale={0.8} color="#3cb44b" />
          </Sequence>
        </Sequence>
      </Sequence>
      <Sequence playbackRate={2} style={band(2)}>
        <Loop durationInFrames={10}>
          <FrameBar scale={8} color="#4363d8" />
        </Loop>
      </Sequence>
      <Loop durationInFrames={30} style={band(3)}>
        <Sequence from={10} playbackRate={0.5}>
          <FrameBar scale={8} color="#f58231" />
        </Sequence>
      </Loop>
      <Sequence from={15} style={band(4)}>
        <Series>
          <Series.Sequence durationInFrames={20}>
            <FrameBar scale={4} color="#911eb4" />
          </Series.Sequence>
          <Series.Sequence durationInFrames={20}>
            <FrameBar scale={4} color="#42d4f4" />
          </Series.Sequence>
        </Series>
      </Sequence>
      <BandDiv row={5}>
        <Freeze frame={40}>
          <Sequence from={30} playbackRate={2}>
            <FrameBar scale={2} color="#f032e6" />
          </Sequence>
        </Freeze>
      </BandDiv>
      <Sequence from={10} freeze={5} style={band(6)}>
        <Sequence from={2}>
          <FrameBar scale={8} color="#bfef45" />
        </Sequence>
      </Sequence>
      <BandDiv row={7}>
        <Series>
          <Series.Sequence durationInFrames={60}>
            <Loop durationInFrames={20}>
              <Sequence from={5}>
                <FrameBar scale={4} color="#469990" />
              </Sequence>
            </Loop>
          </Series.Sequence>
        </Series>
      </BandDiv>
      <Loop durationInFrames={40} style={band(8)}>
        <Series>
          <Series.Sequence durationInFrames={20}>
            <Freeze frame={7} active={(f: number) => f >= 10}>
              <FrameBar scale={4} color="#9a6324" />
            </Freeze>
          </Series.Sequence>
          <Series.Sequence durationInFrames={20}>
            <FrameBar scale={4} color="#800000" />
          </Series.Sequence>
        </Series>
      </Loop>
      <Sequence trimBefore={10} playbackRate={2} style={band(9)}>
        <Sequence from={30} trimBefore={5} playbackRate={0.5}>
          <FrameBar scale={0.8} color="#000075" />
        </Sequence>
      </Sequence>
    </AbsoluteFill>
  );
}
