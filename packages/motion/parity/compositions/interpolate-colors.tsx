// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 90
// frames: 0, 1, 15, 29, 30, 44, 45, 46, 60, 61, 75, 89
// spec: 5 (interpolateColors: syntaxes, easing, posterize), 5 (Unspecified: colour space, outside the range, alpha)
// why: panels filled by interpolateColors: hue vs sRGB mixing, oklch/lab/lch/hwb, transparency over black, posterize, easing arrays, held ends (NOTES 5.12)
import React from "react";
import { AbsoluteFill, Easing, interpolateColors, useCurrentFrame } from "remotion";

function Panel(props: { index: number; color: string; under: string }) {
  const column = props.index % 4;
  const row = Math.floor(props.index / 4);
  return (
    <div
      style={{
        position: "absolute",
        left: `${0.5 + column * 25}%`,
        top: `${0.5 + row * 33.3}%`,
        width: "24%",
        height: "32%",
        backgroundColor: props.under,
      }}
    >
      <div style={{ position: "absolute", left: "10%", top: "10%", right: "10%", bottom: "10%", backgroundColor: props.color }} />
    </div>
  );
}

export default function InterpolateColorsScene() {
  const frame = useCurrentFrame();
  const range = [0, 89];
  return (
    <AbsoluteFill style={{ backgroundColor: "#808080" }}>
      <Panel index={0} under="#ffffff" color={interpolateColors(frame, range, ["red", "yellow"])} />
      <Panel
        index={1}
        under="#ffffff"
        color={interpolateColors(frame, range, ["hsl(0, 100%, 50%)", "hsl(240, 100%, 50%)"])}
      />
      <Panel
        index={2}
        under="#ffffff"
        color={interpolateColors(frame, range, ["oklch(0.63 0.26 29)", "oklch(0.45 0.31 264)"])}
      />
      <Panel index={3} under="#000000" color={interpolateColors(frame, range, ["transparent", "white"])} />
      <Panel index={4} under="#ffffff" color={interpolateColors(frame, range, ["red", "blue"], { posterize: 3 })} />
      <Panel
        index={5}
        under="#ffffff"
        color={interpolateColors(frame, range, ["black", "white"], { easing: Easing.in(Easing.quad) })}
      />
      <Panel
        index={6}
        under="#ffffff"
        color={interpolateColors(frame, [0, 45, 89], ["red", "green", "blue"], {
          easing: [Easing.in(Easing.quad), Easing.out(Easing.quad)],
        })}
      />
      <Panel index={7} under="#ffffff" color={interpolateColors(frame, [30, 60], ["red", "blue"])} />
      <Panel index={8} under="#808080" color={interpolateColors(frame, range, ["#ff000000", "#0000ffff"])} />
      <Panel index={9} under="#ffffff" color={interpolateColors(frame, range, ["lab(30 60 40)", "lch(80 50 200)"])} />
      <Panel index={10} under="#ffffff" color={interpolateColors(frame, range, ["hwb(200 10% 20%)", "#ffe119"])} />
      <Panel
        index={11}
        under="#ffffff"
        color={interpolateColors(frame, range, ["rgba(255, 0, 0, 0.2)", "rgba(0, 0, 255, 0.9)"])}
      />
    </AbsoluteFill>
  );
}
