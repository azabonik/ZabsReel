// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 30
// frames: 0, 15, 29
// spec: 11 (AbsoluteFill: default styles, stacking, style and className, Tailwind class detection)
// why: which inline defaults each className drops when no Tailwind CSS is loaded (NOTES 5.1 detection list), style precedence and stacking order
import React from "react";
import { AbsoluteFill } from "remotion";

const CHILD_COLORS = ["#e6194b", "#3cb44b", "#4363d8"];

// Flex column: three equal horizontal bands. Flex row: three equal vertical bands.
// Block (display dropped): three 20 % bands at the top.
function Children() {
  return (
    <>
      {CHILD_COLORS.map((color) => (
        <div
          key={color}
          style={{ flex: 1, minWidth: "20%", minHeight: "20%", backgroundColor: color }}
        />
      ))}
    </>
  );
}

// The grey strip comes before the fill: an absolutely positioned fill covers it,
// a fill that lost its position (or its insets) is pushed below it.
function Cell(props: { index: number; children: React.ReactNode }) {
  const column = props.index % 3;
  const row = Math.floor(props.index / 3);
  return (
    <div
      style={{
        position: "absolute",
        left: `${1 + column * 33}%`,
        top: `${1 + row * 33}%`,
        width: "31%",
        height: "31%",
        backgroundColor: "#f0f0f0",
        overflow: "hidden",
      }}
    >
      <div style={{ height: "25%", backgroundColor: "#808080" }} />
      {props.children}
    </div>
  );
}

export default function AbsFillLayers() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#222222" }}>
      <Cell index={0}>
        <AbsoluteFill>
          <Children />
        </AbsoluteFill>
      </Cell>
      <Cell index={1}>
        <AbsoluteFill className="flex flex-row">
          <Children />
        </AbsoluteFill>
      </Cell>
      <Cell index={2}>
        <AbsoluteFill className="relative">
          <Children />
        </AbsoluteFill>
      </Cell>
      <Cell index={3}>
        <AbsoluteFill className="md:flex-row">
          <Children />
        </AbsoluteFill>
      </Cell>
      <Cell index={4}>
        <AbsoluteFill className="hidden">
          <Children />
        </AbsoluteFill>
      </Cell>
      <Cell index={5}>
        <AbsoluteFill style={{ flexDirection: "row" }}>
          <Children />
        </AbsoluteFill>
      </Cell>
      <Cell index={6}>
        <AbsoluteFill className="flex-row!">
          <Children />
        </AbsoluteFill>
      </Cell>
      <Cell index={7}>
        <AbsoluteFill className="inset-0">
          <Children />
        </AbsoluteFill>
      </Cell>
      <Cell index={8}>
        <AbsoluteFill className="absolute" style={{ opacity: 0.8 }}>
          <Children />
        </AbsoluteFill>
      </Cell>
      <AbsoluteFill style={{ top: "97%", backgroundColor: "#f58231" }} />
    </AbsoluteFill>
  );
}
