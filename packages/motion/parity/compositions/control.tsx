// size: 1920x1080, 1080x1920
// fps: 30
// durationInFrames: 30
// frames: 0, 15, 29
// spec: none (control scene, no API used)
// why: identical static content in both pipelines (shapes, gradient, radius, overlay, sans-serif text) to measure the baseline browser difference
import React from "react";

export default function Control() {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        overflow: "hidden",
        background: "linear-gradient(135deg, #1e3c72 0%, #2a5298 50%, #f7971e 100%)",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: "8%",
          top: "10%",
          width: "30%",
          height: "35%",
          backgroundColor: "#e6194b",
          borderRadius: 48,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "45%",
          top: "15%",
          width: "20%",
          height: "20%",
          backgroundColor: "#3cb44b",
          borderRadius: "50%",
        }}
      />
      <div
        style={{
          position: "absolute",
          right: "8%",
          bottom: "12%",
          width: "25%",
          height: "30%",
          backgroundColor: "#ffe119",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "20%",
          top: "40%",
          width: "50%",
          height: "30%",
          backgroundColor: "rgba(255, 255, 255, 0.5)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "8%",
          bottom: "8%",
          fontFamily: "sans-serif",
          fontSize: 72,
          fontWeight: 700,
          color: "#ffffff",
        }}
      >
        Parity control
      </div>
    </div>
  );
}
