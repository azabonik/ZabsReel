// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 15, 29, 30, 31, 45, 59, 60, 61, 75, 89
// spec: 4 (Output kinds: CSS transform strings, discrete strings, booleans, numeric tuples; outputType)
// why: interpolate string results applied as CSS translate, scale, rotate and transform-origin, discrete colours, a boolean switch and a tuple position (NOTES 5.11 formats)
import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

function boxStyle(row: number, color: string): React.CSSProperties {
  return {
    position: "absolute",
    left: "2%",
    top: `${row * 9 + 0.5}%`,
    width: "6%",
    height: "7%",
    backgroundColor: color,
  };
}

export default function InterpolateStrings() {
  const frame = useCurrentFrame();
  const translate = String(interpolate(frame, [0, 89], ["0px 0px", "600px 20px"]));
  const scale = String(interpolate(frame, [0, 89], ["1", "2 0.5"]));
  const rotate = String(interpolate(frame, [0, 89], ["0deg", "180deg"]));
  const turn = String(interpolate(frame, [0, 89], ["0turn", "0.5turn"]));
  const origin = String(interpolate(frame, [0, 89], ["left top", "right bottom"]));
  const percent = String(interpolate(frame, [0, 89], ["0%", "300%"]));
  const discrete = String(
    interpolate(frame, [0, 30, 60], ["#e6194b", "#3cb44b", "#4363d8"], { easing: Easing.step1 }),
  );
  const visible = Boolean(
    interpolate(frame, [0, 30, 60], [true, false, true], { easing: [Easing.step1, Easing.step1] }),
  );
  const position = interpolate(frame, [0, 89], [[0, 0], [80, 3]]) as unknown as number[];
  const typedScale = String(interpolate(frame, [0, 89], ["0.5", "1.5"], { outputType: "scale" }));
  const eased = String(
    interpolate(frame, [20, 70], ["0px", "800px"], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.inOut(Easing.quad),
    }),
  );
  return (
    <AbsoluteFill style={{ backgroundColor: "#f4f4f4" }}>
      <div style={{ ...boxStyle(0, "#e6194b"), translate }} />
      <div style={{ ...boxStyle(1, "#3cb44b"), left: "10%", scale }} />
      <div style={{ ...boxStyle(2, "#4363d8"), left: "10%", rotate }} />
      <div style={{ ...boxStyle(3, "#f58231"), left: "10%", rotate: turn }} />
      <div style={{ ...boxStyle(4, "#911eb4"), left: "10%", transformOrigin: origin, rotate: "30deg" }} />
      <div style={{ ...boxStyle(5, "#42d4f4"), translate: percent }} />
      <div style={{ ...boxStyle(6, discrete), width: "90%" }} />
      <div style={{ ...boxStyle(7, "#f032e6"), width: "90%", display: visible ? "block" : "none" }} />
      <div style={{ ...boxStyle(8, "#bfef45"), left: `${position[0]}%`, top: `${8 * 9 + 0.5 + position[1]}%` }} />
      <div style={{ ...boxStyle(9, "#469990"), left: "10%", scale: typedScale }} />
      <div style={{ ...boxStyle(10, "#9a6324"), translate: eased }} />
    </AbsoluteFill>
  );
}
