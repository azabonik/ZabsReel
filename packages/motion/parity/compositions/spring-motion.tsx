// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 2, 5, 10, 15, 19, 20, 21, 25, 30, 39, 40, 45, 60, 89
// spec: 6 (spring: config, from/to, reverse, durationInFrames, delay, overshootClamping, Order of operations), 6 (Unspecified)
// why: boxes moved by spring curves incl. overdamped damping 200 and 26 (NOTES 5.13 critical cap), reverse, delay, stretched and negative-frame springs
import React from "react";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";

function Box(props: { row: number; value: number; color: string }) {
  return (
    <div
      style={{
        position: "absolute",
        left: `${5 + props.value * 70}%`,
        top: `${props.row * 7.5 + 0.5}%`,
        width: "5%",
        height: "6.5%",
        backgroundColor: props.color,
      }}
    />
  );
}

export default function SpringMotion() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ backgroundColor: "#f4f4f4" }}>
      <Box row={0} value={spring({ frame, fps })} color="#e6194b" />
      <Box row={1} value={spring({ frame, fps, config: { damping: 200 } })} color="#3cb44b" />
      <Box row={2} value={spring({ frame, fps, config: { damping: 50 } })} color="#4363d8" />
      <Box row={3} value={spring({ frame, fps, config: { damping: 26 } })} color="#f58231" />
      <Box row={4} value={spring({ frame, fps, config: { mass: 3 } })} color="#911eb4" />
      <Box row={5} value={spring({ frame, fps, config: { stiffness: 300 } })} color="#42d4f4" />
      <Box row={6} value={spring({ frame, fps, durationInFrames: 40 })} color="#f032e6" />
      <Box row={7} value={spring({ frame, fps, reverse: true })} color="#bfef45" />
      <Box row={8} value={spring({ frame, fps, delay: 20 })} color="#469990" />
      <Box row={9} value={spring({ frame, fps, config: { overshootClamping: true } })} color="#9a6324" />
      <Box row={10} value={spring({ frame, fps, from: 1, to: 0.2 })} color="#800000" />
      <Box row={11} value={spring({ frame: frame - 20, fps })} color="#000075" />
      <Box
        row={12}
        value={spring({ frame, fps, reverse: true, durationInFrames: 30, config: { damping: 200 } })}
        color="#808000"
      />
    </AbsoluteFill>
  );
}
