// size: 1920x1080
// fps: 30
// durationInFrames: 120
// frames: 0, 1, 15, 30, 45, 59, 60, 90, 118, 119
// audio: no
// spec: 17 (Img)
// why: Img sizing in block containers - natural size, width or height alone (attribute and style), a stretched attribute box, and a style box whose width animates
import React from "react";
import {AbsoluteFill, Img, asset, useCurrentFrame} from "remotion";

const at = (left: number, top: number): React.CSSProperties => ({position: "absolute", left, top});

export default function ImgSizes() {
  const frame = useCurrentFrame();
  // Plain arithmetic, so the box is a whole number of pixels on every frame
  const width = 160 + 4 * frame;
  return (
    <AbsoluteFill style={{backgroundColor: "#22303f"}}>
      {/* natural size: 800x600 */}
      <div style={at(40, 40)}>
        <Img src={asset("img_a")} />
      </div>
      {/* width attribute only: 400x300 */}
      <div style={at(880, 40)}>
        <Img src={asset("img_a")} width={400} />
      </div>
      {/* style height only: about 267x200 */}
      <div style={at(1320, 40)}>
        <Img src={asset("img_a")} style={{height: 200}} />
      </div>
      {/* height attribute only: 220x220 */}
      <div style={at(1620, 40)}>
        <Img src={asset("img_c")} height={220} />
      </div>
      {/* style width only: 480x270 */}
      <div style={at(880, 380)}>
        <Img src={asset("img_b")} style={{width: 480}} />
      </div>
      {/* both attributes, wrong aspect ratio: stretched to 300x150 */}
      <div style={at(1420, 380)}>
        <Img src={asset("img_c")} width={300} height={150} />
      </div>
      {/* both style sizes, width animates 160..636 */}
      <div style={at(40, 700)}>
        <Img src={asset("img_b")} style={{width, height: 200}} />
      </div>
    </AbsoluteFill>
  );
}
