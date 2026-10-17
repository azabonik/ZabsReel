// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 90
// frames: 0, 30, 39, 40, 45, 89
// spec: 3 (useVideoConfig), 3 (Unspecified: infinite Sequence, playbackRate, Loop, Series.Sequence, Freeze), 12.2
// why: width, height, fps and durationInFrames at top level and inside time-shifting parents, incl. the documented 90 and NOTES 5.1/5.3 choices
import React from "react";
import { AbsoluteFill, Freeze, Loop, Sequence, Series, useVideoConfig } from "remotion";

// Four strips, top to bottom: width / 30 %, height / 30 %, fps * 2 %, durationInFrames * 0.4 %.
// A non-finite value leaves its strip without a width (invisible).
function ConfigStrips() {
  const config = useVideoConfig();
  const strips = [
    { value: config.width / 30, color: "#e6194b" },
    { value: config.height / 30, color: "#3cb44b" },
    { value: config.fps * 2, color: "#4363d8" },
    { value: config.durationInFrames * 0.4, color: "#f58231" },
  ];
  return (
    <>
      <div style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, backgroundColor: "#ffffff" }} />
      {strips.map((strip, index) => (
        <div
          key={index}
          style={{
            position: "absolute",
            left: 0,
            top: `${index * 25}%`,
            height: "22%",
            width: `${strip.value}%`,
            backgroundColor: strip.color,
          }}
        />
      ))}
    </>
  );
}

function band(row: number): React.CSSProperties {
  return { top: `${row * 8.2}%`, height: "7.5%", backgroundColor: "#dddddd" };
}

function BandDiv(props: { row: number; children: React.ReactNode }) {
  return (
    <div style={{ position: "absolute", left: 0, right: 0, ...band(props.row) }}>{props.children}</div>
  );
}

export default function UseVideoConfig() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <BandDiv row={0}>
        <ConfigStrips />
      </BandDiv>
      <Sequence durationInFrames={40} style={band(1)}>
        <ConfigStrips />
      </Sequence>
      <Sequence trimBefore={10} durationInFrames={80} playbackRate={2} style={band(2)}>
        <ConfigStrips />
      </Sequence>
      <Sequence from={30} style={band(3)}>
        <ConfigStrips />
      </Sequence>
      <Sequence from={30} playbackRate={2} style={band(4)}>
        <ConfigStrips />
      </Sequence>
      <Sequence trimBefore={10} style={band(5)}>
        <ConfigStrips />
      </Sequence>
      <Loop durationInFrames={30} style={band(6)}>
        <ConfigStrips />
      </Loop>
      <Series>
        <Series.Sequence durationInFrames={45} style={band(7)}>
          <ConfigStrips />
        </Series.Sequence>
        <Series.Sequence durationInFrames={45} style={band(7)}>
          <ConfigStrips />
        </Series.Sequence>
      </Series>
      <BandDiv row={8}>
        <Freeze frame={10}>
          <ConfigStrips />
        </Freeze>
      </BandDiv>
      <Sequence from={10} style={band(9)}>
        <Sequence durationInFrames={30}>
          <ConfigStrips />
        </Sequence>
      </Sequence>
      <BandDiv row={10}>
        <Sequence width={800} height={60} style={{ backgroundColor: "#aaffc3" }}>
          <ConfigStrips />
        </Sequence>
      </BandDiv>
      <BandDiv row={11}>
        <Sequence width={600}>
          <ConfigStrips />
        </Sequence>
      </BandDiv>
    </AbsoluteFill>
  );
}
