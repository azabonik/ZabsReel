// size: 1920x1080
// fps: 30
// durationInFrames: 120
// frames: 0, 1, 20, 30, 40, 60, 80, 90, 100, 119
// audio: no
// spec: 17 (Img: native img props)
// why: object-fit default/contain/cover/none/scale-down and object-position in boxes whose width animates, background colour showing the empty areas
import React from "react";
import {AbsoluteFill, Img, asset, useCurrentFrame} from "remotion";

export default function ImgObjectFit() {
  const frame = useCurrentFrame();
  // Box width 360..717 px, height 240 px: wider than 4:3 for most frames
  const width = 360 + 3 * frame;
  const tile = (left: number, top: number, extra: React.CSSProperties): React.CSSProperties => ({
    position: "absolute",
    left,
    top,
    width,
    height: 240,
    backgroundColor: "#ff3366",
    ...extra,
  });
  return (
    <AbsoluteFill style={{backgroundColor: "#202020"}}>
      <Img src={asset("img_a")} style={tile(40, 20, {})} />
      <Img src={asset("img_a")} style={tile(980, 20, {objectFit: "contain"})} />
      <Img src={asset("img_a")} style={tile(40, 285, {objectFit: "cover"})} />
      <Img src={asset("img_a")} style={tile(980, 285, {objectFit: "none"})} />
      <Img src={asset("img_a")} style={tile(40, 550, {objectFit: "scale-down"})} />
      <Img src={asset("img_c")} style={tile(980, 550, {objectFit: "cover", objectPosition: "right bottom"})} />
      <Img src={asset("img_c")} style={tile(40, 815, {objectFit: "contain", objectPosition: "left top"})} />
    </AbsoluteFill>
  );
}
