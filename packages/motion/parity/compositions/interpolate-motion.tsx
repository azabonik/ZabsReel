// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 5, 9, 10, 11, 20, 25, 30, 39, 40, 41, 45, 59, 60, 61, 75, 89
// spec: 4 (extrapolation, easing, posterize, output), 4 (Unspecified: wrap rule, interior keyframes, extend with easing)
// why: boxes driven by each extrapolation mode, posterize 3 and 2.5, eased multi-segment extension, per-segment easing, perceptual scale and a spring driver (NOTES 5.11)
import React from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

function Box(props: { row: number; x: number; color: string; scale?: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left: `${props.x}%`,
        top: `${props.row * 8 + 0.5}%`,
        width: "5%",
        height: "7%",
        backgroundColor: props.color,
        transform: props.scale === undefined ? undefined : `scale(${props.scale})`,
      }}
    />
  );
}

export default function InterpolateMotion() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const wrap = { extrapolateLeft: "wrap", extrapolateRight: "wrap" } as const;
  return (
    <AbsoluteFill style={{ backgroundColor: "#f4f4f4" }}>
      <Box row={0} x={interpolate(frame, [10, 40], [20, 50])} color="#e6194b" />
      <Box row={1} x={interpolate(frame, [10, 40], [20, 80], clamp)} color="#3cb44b" />
      <Box row={2} x={interpolate(frame, [10, 40], [20, 80], wrap)} color="#4363d8" />
      <Box
        row={3}
        x={interpolate(frame, [10, 40], [20, 80], { extrapolateLeft: "identity", extrapolateRight: "clamp" })}
        color="#f58231"
      />
      <Box row={4} x={interpolate(frame, [0, 89], [0, 89], { posterize: 3 })} color="#911eb4" />
      <Box row={5} x={interpolate(frame, [0, 89], [0, 89], { posterize: 2.5 })} color="#42d4f4" />
      <Box row={6} x={interpolate(frame, [20, 40, 60], [20, 40, 50], { easing: Easing.quad })} color="#f032e6" />
      <Box
        row={7}
        x={interpolate(frame, [0, 45, 89], [0, 80, 20], { easing: [Easing.out(Easing.cubic), Easing.in(Easing.sin)] })}
        color="#bfef45"
      />
      <Box
        row={8}
        x={45}
        scale={interpolate(frame, [0, 89], [0.2, 2], { output: "perceptual-scale" })}
        color="#469990"
      />
      <Box row={9} x={interpolate(frame, [0, 89], [90, 0])} color="#9a6324" />
      <Box row={10} x={interpolate(spring({ frame, fps }), [0, 1], [0, 80])} color="#800000" />
      <Box
        row={11}
        x={interpolate(frame, [0, 30, 60], [0, 40, 80], { easing: (t: number) => t * 0.5 })}
        color="#000075"
      />
    </AbsoluteFill>
  );
}
