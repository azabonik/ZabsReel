// Generated from feedback/feedback-r2/values.json: every example row of every action case, with the
// reference library's expected value. Rows of fixed cases must match; kept rows carry the reason.
import type { ParityRow } from "./parity-r1.cases";

export const PARITY_R2: ParityRow[] = [
 {
  "id": "v2-spring-fps10-clamp-fromto",
  "expr": "spring({frame, fps: 10, from: 20, to: 220, config: {damping: 8, overshootClamping: true}})",
  "vars": {
   "frame": 4
  },
  "expected": 247.899849,
  "kept": "SPEC 6 documents overshootClamping without a date; the reference never clamped in any row (NOTES 9.3, 10.3)"
 },
 {
  "id": "v2-spring-fps10-clamp-fromto",
  "expr": "spring({frame, fps: 10, from: 20, to: 220, config: {damping: 8, overshootClamping: true}})",
  "vars": {
   "frame": 8
  },
  "expected": 231.768775,
  "kept": "SPEC 6 documents overshootClamping without a date; the reference never clamped in any row (NOTES 9.3, 10.3)"
 },
 {
  "id": "v2-spring-fps10-clamp-fromto",
  "expr": "spring({frame, fps: 10, from: 20, to: 220, config: {damping: 8, overshootClamping: true}})",
  "vars": {
   "frame": 28
  },
  "expected": 220.160479,
  "kept": "SPEC 6 documents overshootClamping without a date; the reference never clamped in any row (NOTES 9.3, 10.3)"
 },
 {
  "id": "v2-spring-fps10-fractional",
  "expr": "spring({frame, fps: 10})",
  "vars": {
   "frame": 0.25
  },
  "expected": 0.028654,
  "kept": null
 },
 {
  "id": "v2-spring-fps10-fractional",
  "expr": "spring({frame, fps: 10})",
  "vars": {
   "frame": 2.5
  },
  "expected": 0.492353,
  "kept": null
 },
 {
  "id": "v2-spring-fps10-fractional",
  "expr": "spring({frame, fps: 10})",
  "vars": {
   "frame": 12.5
  },
  "expected": 0.975482,
  "kept": null
 },
 {
  "id": "v2-spring-fps10-reverse-stretched",
  "expr": "spring({frame, fps: 10, reverse: true, durationInFrames: 10})",
  "vars": {
   "frame": 1
  },
  "expected": 0.98339,
  "kept": null
 },
 {
  "id": "v2-spring-fps10-reverse-stretched",
  "expr": "spring({frame, fps: 10, reverse: true, durationInFrames: 10})",
  "vars": {
   "frame": 5
  },
  "expected": 1.120108,
  "kept": null
 },
 {
  "id": "v2-spring-fps10-reverse-stretched",
  "expr": "spring({frame, fps: 10, reverse: true, durationInFrames: 10})",
  "vars": {
   "frame": 9
  },
  "expected": 0.161909,
  "kept": null
 },
 {
  "id": "v2-spring-fps10-stretched",
  "expr": "spring({frame, fps: 10, durationInFrames: 12})",
  "vars": {
   "frame": 1
  },
  "expected": 0.161909,
  "kept": null
 },
 {
  "id": "v2-spring-fps10-stretched",
  "expr": "spring({frame, fps: 10, durationInFrames: 12})",
  "vars": {
   "frame": 6
  },
  "expected": 1.120108,
  "kept": null
 },
 {
  "id": "v2-spring-fps10-stretched",
  "expr": "spring({frame, fps: 10, durationInFrames: 12})",
  "vars": {
   "frame": 11
  },
  "expected": 0.98339,
  "kept": null
 },
 {
  "id": "v2-spring-fps15-clamp-fromto",
  "expr": "spring({frame, fps: 15, from: 20, to: 220, config: {damping: 8, overshootClamping: true}})",
  "vars": {
   "frame": 4
  },
  "expected": 247.899849,
  "kept": "SPEC 6 documents overshootClamping without a date; the reference never clamped in any row (NOTES 9.3, 10.3)"
 },
 {
  "id": "v2-spring-fps15-clamp-fromto",
  "expr": "spring({frame, fps: 15, from: 20, to: 220, config: {damping: 8, overshootClamping: true}})",
  "vars": {
   "frame": 8
  },
  "expected": 231.768775,
  "kept": "SPEC 6 documents overshootClamping without a date; the reference never clamped in any row (NOTES 9.3, 10.3)"
 },
 {
  "id": "v2-spring-fps15-clamp-fromto",
  "expr": "spring({frame, fps: 15, from: 20, to: 220, config: {damping: 8, overshootClamping: true}})",
  "vars": {
   "frame": 28
  },
  "expected": 220.160479,
  "kept": "SPEC 6 documents overshootClamping without a date; the reference never clamped in any row (NOTES 9.3, 10.3)"
 },
 {
  "id": "v2-spring-fps15-stretched",
  "expr": "spring({frame, fps: 15, durationInFrames: 12})",
  "vars": {
   "frame": 1
  },
  "expected": 0.161909,
  "kept": null
 },
 {
  "id": "v2-spring-fps15-stretched",
  "expr": "spring({frame, fps: 15, durationInFrames: 12})",
  "vars": {
   "frame": 6
  },
  "expected": 1.120108,
  "kept": null
 },
 {
  "id": "v2-spring-fps15-stretched",
  "expr": "spring({frame, fps: 15, durationInFrames: 12})",
  "vars": {
   "frame": 11
  },
  "expected": 0.98339,
  "kept": null
 },
 {
  "id": "v2-spring-fps15-stretched-threshold",
  "expr": "spring({frame, fps: 15, durationInFrames: 20, durationRestThreshold: 0.02, config: {damping: 200}})",
  "vars": {
   "frame": 1
  },
  "expected": 0.044625,
  "kept": null
 },
 {
  "id": "v2-spring-fps15-stretched-threshold",
  "expr": "spring({frame, fps: 15, durationInFrames: 20, durationRestThreshold: 0.02, config: {damping: 200}})",
  "vars": {
   "frame": 5
  },
  "expected": 0.366075,
  "kept": null
 },
 {
  "id": "v2-spring-fps15-stretched-threshold",
  "expr": "spring({frame, fps: 15, durationInFrames: 20, durationRestThreshold: 0.02, config: {damping: 200}})",
  "vars": {
   "frame": 19
  },
  "expected": 0.978698,
  "kept": null
 },
 {
  "id": "v2-spring-fps16-clamp-fromto",
  "expr": "spring({frame, fps: 16, from: 20, to: 220, config: {damping: 8, overshootClamping: true}})",
  "vars": {
   "frame": 4
  },
  "expected": 244.411059,
  "kept": "SPEC 6 documents overshootClamping without a date; the reference never clamped in any row (NOTES 9.3, 10.3)"
 },
 {
  "id": "v2-spring-fps16-clamp-fromto",
  "expr": "spring({frame, fps: 16, from: 20, to: 220, config: {damping: 8, overshootClamping: true}})",
  "vars": {
   "frame": 8
  },
  "expected": 235.217442,
  "kept": "SPEC 6 documents overshootClamping without a date; the reference never clamped in any row (NOTES 9.3, 10.3)"
 },
 {
  "id": "v2-spring-fps16-clamp-fromto",
  "expr": "spring({frame, fps: 16, from: 20, to: 220, config: {damping: 8, overshootClamping: true}})",
  "vars": {
   "frame": 28
  },
  "expected": 220.198345,
  "kept": "SPEC 6 documents overshootClamping without a date; the reference never clamped in any row (NOTES 9.3, 10.3)"
 },
 {
  "id": "v2-spring-fps16-fractional-damping200",
  "expr": "spring({frame, fps: 16, config: {damping: 200}})",
  "vars": {
   "frame": 1.5
  },
  "expected": 0.13524,
  "kept": null
 },
 {
  "id": "v2-spring-fps16-fractional-damping200",
  "expr": "spring({frame, fps: 16, config: {damping: 200}})",
  "vars": {
   "frame": 4.5
  },
  "expected": 0.715767,
  "kept": null
 },
 {
  "id": "v2-spring-fps16-fractional-damping200",
  "expr": "spring({frame, fps: 16, config: {damping: 200}})",
  "vars": {
   "frame": 9.5
  },
  "expected": 0.976409,
  "kept": null
 },
 {
  "id": "v2-spring-fps16-stretched",
  "expr": "spring({frame, fps: 16, durationInFrames: 12})",
  "vars": {
   "frame": 1
  },
  "expected": 0.161909,
  "kept": null
 },
 {
  "id": "v2-spring-fps16-stretched",
  "expr": "spring({frame, fps: 16, durationInFrames: 12})",
  "vars": {
   "frame": 6
  },
  "expected": 1.127387,
  "kept": null
 },
 {
  "id": "v2-spring-fps16-stretched",
  "expr": "spring({frame, fps: 16, durationInFrames: 12})",
  "vars": {
   "frame": 11
  },
  "expected": 0.980858,
  "kept": null
 },
 {
  "id": "v2-spring-fps24-clamp-fromto",
  "expr": "spring({frame, fps: 24, from: 20, to: 220, config: {damping: 8, overshootClamping: true}})",
  "vars": {
   "frame": 6
  },
  "expected": 244.411059,
  "kept": "SPEC 6 documents overshootClamping without a date; the reference never clamped in any row (NOTES 9.3, 10.3)"
 },
 {
  "id": "v2-spring-fps24-clamp-fromto",
  "expr": "spring({frame, fps: 24, from: 20, to: 220, config: {damping: 8, overshootClamping: true}})",
  "vars": {
   "frame": 22
  },
  "expected": 220.755663,
  "kept": "SPEC 6 documents overshootClamping without a date; the reference never clamped in any row (NOTES 9.3, 10.3)"
 },
 {
  "id": "v2-spring-fps24-clamp-fromto",
  "expr": "spring({frame, fps: 24, from: 20, to: 220, config: {damping: 8, overshootClamping: true}})",
  "vars": {
   "frame": 40
  },
  "expected": 220.184486,
  "kept": "SPEC 6 documents overshootClamping without a date; the reference never clamped in any row (NOTES 9.3, 10.3)"
 },
 {
  "id": "v2-spring-fps24-stretched",
  "expr": "spring({frame, fps: 24, durationInFrames: 12})",
  "vars": {
   "frame": 1
  },
  "expected": 0.161909,
  "kept": null
 },
 {
  "id": "v2-spring-fps24-stretched",
  "expr": "spring({frame, fps: 24, durationInFrames: 12})",
  "vars": {
   "frame": 3
  },
  "expected": 0.964794,
  "kept": null
 },
 {
  "id": "v2-spring-fps24-stretched",
  "expr": "spring({frame, fps: 24, durationInFrames: 12})",
  "vars": {
   "frame": 5
  },
  "expected": 1.154406,
  "kept": null
 }
];
