// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 5, 10, 15, 20, 30, 40, 45, 50, 55, 59, 60, 89
// spec: 8 (Easing: every member), 8 (Unspecified formulas), 4 (easing)
// why: one box per Easing curve moving across the frame over 60 frames, then held by a clamp (NOTES 5.14 formulas)
import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

const CURVES: { fn: (t: number) => number; color: string }[] = [
  { fn: Easing.linear, color: "#e6194b" },
  { fn: Easing.ease, color: "#3cb44b" },
  { fn: Easing.quad, color: "#ffe119" },
  { fn: Easing.cubic, color: "#4363d8" },
  { fn: Easing.poly(4), color: "#f58231" },
  { fn: Easing.sin, color: "#911eb4" },
  { fn: Easing.circle, color: "#42d4f4" },
  { fn: Easing.exp, color: "#f032e6" },
  { fn: Easing.elastic(1), color: "#bfef45" },
  { fn: Easing.back(2), color: "#fabed4" },
  { fn: Easing.bounce, color: "#469990" },
  { fn: Easing.bezier(0.68, -0.6, 0.32, 1.6), color: "#dcbeff" },
  { fn: Easing.step0, color: "#9a6324" },
  { fn: Easing.step1, color: "#000000" },
  { fn: Easing.in(Easing.quad), color: "#800000" },
  { fn: Easing.out(Easing.bounce), color: "#aaffc3" },
  { fn: Easing.inOut(Easing.cubic), color: "#808000" },
  { fn: Easing.spring(), color: "#ffd8b1" },
  { fn: Easing.out(Easing.elastic(2)), color: "#000075" },
  { fn: Easing.inOut(Easing.sin), color: "#a9a9a9" },
];

export default function EasingBoxes() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: "#ffffff" }}>
      {CURVES.map((curve, index) => (
        <div
          key={index}
          style={{
            position: "absolute",
            left: `${interpolate(frame, [0, 60], [2, 88], { easing: curve.fn, extrapolateRight: "clamp" })}%`,
            top: `${index * 5 + 0.3}%`,
            width: "4%",
            height: "4.4%",
            backgroundColor: curve.color,
          }}
        />
      ))}
    </AbsoluteFill>
  );
}
