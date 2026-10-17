// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 10, 15, 29, 30, 31, 35, 45, 46, 59, 60, 61, 75, 89
// spec: 8 (Easing.spring, allowTail, durationRestThreshold), 8 (Unspecified: mapping onto progress, tail combination)
// why: Easing.spring segments with and without allowTail across a keyframe, the documented damping 200 / 0.03 config on translate strings, and in interpolateColors (NOTES 5.11, 5.14)
import React from "react";
import { AbsoluteFill, Easing, interpolate, interpolateColors, useCurrentFrame } from "remotion";

const DOC_TAIL = Easing.spring({ allowTail: true, damping: 200, durationRestThreshold: 0.03 });
const BOUNCY_TAIL = Easing.spring({ allowTail: true });
const NO_TAIL = Easing.spring();
const CLAMPED = Easing.spring({ overshootClamping: true });
const HEAVY = Easing.spring({ mass: 2, stiffness: 50 });

function boxStyle(row: number, color: string): React.CSSProperties {
  return {
    position: "absolute",
    top: `${row * 14 + 1}%`,
    width: "6%",
    height: "12%",
    backgroundColor: color,
  };
}

export default function EasingSpringTail() {
  const frame = useCurrentFrame();
  const keys = [0, 30, 60];
  const xs = [5, 70, 30];
  const translate = String(interpolate(frame, keys, ["0px", "600px", "300px"], { easing: [DOC_TAIL, DOC_TAIL] }));
  return (
    <AbsoluteFill style={{ backgroundColor: "#f4f4f4" }}>
      <div style={{ ...boxStyle(0, "#e6194b"), left: `${interpolate(frame, keys, xs, { easing: [DOC_TAIL, DOC_TAIL] })}%` }} />
      <div
        style={{ ...boxStyle(1, "#3cb44b"), left: `${interpolate(frame, keys, xs, { easing: [BOUNCY_TAIL, BOUNCY_TAIL] })}%` }}
      />
      <div style={{ ...boxStyle(2, "#4363d8"), left: `${interpolate(frame, keys, xs, { easing: [NO_TAIL, NO_TAIL] })}%` }} />
      <div style={{ ...boxStyle(3, "#f58231"), left: `${interpolate(frame, keys, xs, { easing: [CLAMPED, CLAMPED] })}%` }} />
      <div style={{ ...boxStyle(4, "#911eb4"), left: "2%", translate }} />
      <div style={{ ...boxStyle(5, "#42d4f4"), left: `${interpolate(frame, [0, 45], [5, 80], { easing: HEAVY })}%` }} />
      <div
        style={{
          ...boxStyle(6, interpolateColors(frame, keys, ["red", "green", "blue"], { easing: [BOUNCY_TAIL, BOUNCY_TAIL] })),
          left: "2%",
          width: "90%",
        }}
      />
    </AbsoluteFill>
  );
}
