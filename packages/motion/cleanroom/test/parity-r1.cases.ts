// Generated from feedback/feedback-r1/values.json: every example row of every action case, with the
// reference library's expected value. Rows of cases fixed in round 1 must match; rows of kept cases
// carry the reason the difference stays (see NOTES.md, "Parity round 1").

export interface ParityRow {
  id: string;
  expr: string;
  vars: Record<string, number>;
  expected: unknown;
  /** Why the difference is kept, or null when the row must match. */
  kept: string | null;
}

export const PARITY_R1: ParityRow[] = [
 {
  "id": "ease-081",
  "expr": "interpolate(f, [0, 30, 60], [0, 100, 50], {easing: [Easing.spring({allowTail: true, damping: 200, durationRestThreshold: 0.03}), Easing.spring({allowTail: true, damping: 200, durationRestThreshold: 0.03})]}) ",
  "vars": {
   "f": 1
  },
  "expected": 2.758966,
  "kept": "allowTail and Easing.spring's durationRestThreshold are dated v4.0.483"
 },
 {
  "id": "ease-081",
  "expr": "interpolate(f, [0, 30, 60], [0, 100, 50], {easing: [Easing.spring({allowTail: true, damping: 200, durationRestThreshold: 0.03}), Easing.spring({allowTail: true, damping: 200, durationRestThreshold: 0.03})]}) ",
  "vars": {
   "f": 31
  },
  "expected": 98.620517,
  "kept": "allowTail and Easing.spring's durationRestThreshold are dated v4.0.483"
 },
 {
  "id": "ease-081",
  "expr": "interpolate(f, [0, 30, 60], [0, 100, 50], {easing: [Easing.spring({allowTail: true, damping: 200, durationRestThreshold: 0.03}), Easing.spring({allowTail: true, damping: 200, durationRestThreshold: 0.03})]}) ",
  "vars": {
   "f": 60
  },
  "expected": 50,
  "kept": "allowTail and Easing.spring's durationRestThreshold are dated v4.0.483"
 },
 {
  "id": "ease-082",
  "expr": "interpolate(45, [0, 30, 60], ['0px', '100px', '50px'], {easing: [Easing.spring({allowTail: true, damping: 200, durationRestThreshold: 0.03}), Easing.spring({allowTail: true, damping: 200, durationRestThreshold: 0.03})]})",
  "vars": {},
  "expected": "55.229031px",
  "kept": "allowTail and durationRestThreshold, v4.0.483"
 },
 {
  "id": "ease-083",
  "expr": "interpolate(f, [0, 30, 60], [0, 100, 50], {easing: [Easing.spring({allowTail: true}), Easing.spring({allowTail: true})]}) ",
  "vars": {
   "f": 1
  },
  "expected": 4.339935,
  "kept": "curve fixed; allowTail residual (v4.0.483)"
 },
 {
  "id": "ease-083",
  "expr": "interpolate(f, [0, 30, 60], [0, 100, 50], {easing: [Easing.spring({allowTail: true}), Easing.spring({allowTail: true})]}) ",
  "vars": {
   "f": 31
  },
  "expected": 97.830033,
  "kept": "curve fixed; allowTail residual (v4.0.483)"
 },
 {
  "id": "ease-083",
  "expr": "interpolate(f, [0, 30, 60], [0, 100, 50], {easing: [Easing.spring({allowTail: true}), Easing.spring({allowTail: true})]}) ",
  "vars": {
   "f": 60
  },
  "expected": 50,
  "kept": "curve fixed; allowTail residual (v4.0.483)"
 },
 {
  "id": "ease-084",
  "expr": "interpolate(f, [0, 30, 60], [0, 100, 50], {easing: [Easing.spring(), Easing.spring()]}) ",
  "vars": {
   "f": 1
  },
  "expected": 4.339935,
  "kept": null
 },
 {
  "id": "ease-084",
  "expr": "interpolate(f, [0, 30, 60], [0, 100, 50], {easing: [Easing.spring(), Easing.spring()]}) ",
  "vars": {
   "f": 31
  },
  "expected": 97.830033,
  "kept": null
 },
 {
  "id": "ease-084",
  "expr": "interpolate(f, [0, 30, 60], [0, 100, 50], {easing: [Easing.spring(), Easing.spring()]}) ",
  "vars": {
   "f": 59
  },
  "expected": 50.339131,
  "kept": null
 },
 {
  "id": "ease-085",
  "expr": "interpolate(f, [0, 30], [0, 1], {easing: Easing.spring()}) ",
  "vars": {
   "f": 1
  },
  "expected": 0.043399,
  "kept": null
 },
 {
  "id": "ease-085",
  "expr": "interpolate(f, [0, 30], [0, 1], {easing: Easing.spring()}) ",
  "vars": {
   "f": 15
  },
  "expected": 1.10414,
  "kept": null
 },
 {
  "id": "ease-085",
  "expr": "interpolate(f, [0, 30], [0, 1], {easing: Easing.spring()}) ",
  "vars": {
   "f": 29
  },
  "expected": 0.993217,
  "kept": null
 },
 {
  "id": "ease-086",
  "expr": "interpolate(f, [0, 30], [0, 1], {easing: Easing.spring({allowTail: true})}) ",
  "vars": {
   "f": 1
  },
  "expected": 0.043399,
  "kept": "curve fixed; allowTail residual (v4.0.483)"
 },
 {
  "id": "ease-086",
  "expr": "interpolate(f, [0, 30], [0, 1], {easing: Easing.spring({allowTail: true})}) ",
  "vars": {
   "f": 23
  },
  "expected": 0.973556,
  "kept": "curve fixed; allowTail residual (v4.0.483)"
 },
 {
  "id": "ease-086",
  "expr": "interpolate(f, [0, 30], [0, 1], {easing: Easing.spring({allowTail: true})}) ",
  "vars": {
   "f": 45
  },
  "expected": 1,
  "kept": "curve fixed; allowTail residual (v4.0.483)"
 },
 {
  "id": "interp-025",
  "expr": "interpolate(f, [0, 10, 30], [0, 100, 0], {extrapolateLeft: 'wrap', extrapolateRight: 'wrap'}) ",
  "vars": {
   "f": -20
  },
  "expected": 0,
  "kept": null
 },
 {
  "id": "interp-025",
  "expr": "interpolate(f, [0, 10, 30], [0, 100, 0], {extrapolateLeft: 'wrap', extrapolateRight: 'wrap'}) ",
  "vars": {
   "f": 36
  },
  "expected": 70,
  "kept": null
 },
 {
  "id": "interp-025",
  "expr": "interpolate(f, [0, 10, 30], [0, 100, 0], {extrapolateLeft: 'wrap', extrapolateRight: 'wrap'}) ",
  "vars": {
   "f": 60
  },
  "expected": 50,
  "kept": null
 },
 {
  "id": "interp-038",
  "expr": "interpolate(10, [0, 10, 20], [0, 100, 200], {easing: (t) => t * 0.5})",
  "vars": {},
  "expected": 50,
  "kept": null
 },
 {
  "id": "interp-039",
  "expr": "interpolate(10, [0, 10, 20], [0, 100, 200], {easing: (t) => 0.5})",
  "vars": {},
  "expected": 50,
  "kept": null
 },
 {
  "id": "interp-042",
  "expr": "interpolate(f, [0, 10, 20], [0, 100, 200], {easing: (t) => t * 0.5}) ",
  "vars": {
   "f": 10
  },
  "expected": 50,
  "kept": null
 },
 {
  "id": "interp-061",
  "expr": "interpolate(NaN, [0, 10], [0, 1])",
  "vars": {},
  "expected": "NaN",
  "kept": null
 },
 {
  "id": "interp-063",
  "expr": "interpolate(Infinity, [0, 10], [0, 1], {extrapolateRight: 'clamp'})",
  "vars": {},
  "expected": 1,
  "kept": null
 },
 {
  "id": "interp-065",
  "expr": "interpolate(-Infinity, [0, 10], [0, 1], {extrapolateLeft: 'clamp'})",
  "vars": {},
  "expected": 0,
  "kept": null
 },
 {
  "id": "interp-068",
  "expr": "interpolate(5, [0, 10], [0, 1], {extrapolateRight: 'bogus'})",
  "vars": {},
  "expected": 0.5,
  "kept": null
 },
 {
  "id": "interp-089",
  "expr": "interpolate(0.3, [0, 1], [0, 1], {posterize: 0.1})",
  "vars": {},
  "expected": 0.2,
  "kept": null
 },
 {
  "id": "interp-090",
  "expr": "interpolate(0.7, [0, 1], [0, 1], {posterize: 0.1})",
  "vars": {},
  "expected": 0.6,
  "kept": null
 },
 {
  "id": "interp-100",
  "expr": "interpolate(0.5, [0, 1], [0, 1], {output: 'perceptual-scale'})",
  "vars": {},
  "expected": 0.5,
  "kept": "output perceptual-scale, v4.0.490"
 },
 {
  "id": "interp-101",
  "expr": "interpolate(0.5, [0, 1], [1, 2], {output: 'perceptual-scale'})",
  "vars": {},
  "expected": 1.5,
  "kept": "perceptual-scale, v4.0.490"
 },
 {
  "id": "interp-102",
  "expr": "interpolate(0.5, [0, 1], [0, -1], {output: 'perceptual-scale'})",
  "vars": {},
  "expected": -0.5,
  "kept": "perceptual-scale, v4.0.490"
 },
 {
  "id": "interp-103",
  "expr": "interpolate(f, [0, 20], [0.5, 2], {output: 'perceptual-scale'}) ",
  "vars": {
   "f": -5
  },
  "expected": 0.125,
  "kept": "perceptual-scale, v4.0.490"
 },
 {
  "id": "interp-103",
  "expr": "interpolate(f, [0, 20], [0.5, 2], {output: 'perceptual-scale'}) ",
  "vars": {
   "f": 10
  },
  "expected": 1.25,
  "kept": "perceptual-scale, v4.0.490"
 },
 {
  "id": "interp-103",
  "expr": "interpolate(f, [0, 20], [0.5, 2], {output: 'perceptual-scale'}) ",
  "vars": {
   "f": 25
  },
  "expected": 2.375,
  "kept": "perceptual-scale, v4.0.490"
 },
 {
  "id": "interp-105",
  "expr": "interpolate(0.25, [0, 1], [-1, 1], {output: 'perceptual-scale'})",
  "vars": {},
  "expected": -0.5,
  "kept": "perceptual-scale, v4.0.490"
 },
 {
  "id": "interp-106",
  "expr": "interpolate(0.5, [0, 1], [[0, 1], [1, 2]], {output: 'perceptual-scale'})",
  "vars": {},
  "expected": [
   0.5,
   1.5
  ],
  "kept": null
 },
 {
  "id": "interp-107",
  "expr": "interpolate(0.5, [0, 1], ['1', '2'], {output: 'perceptual-scale'})",
  "vars": {},
  "expected": "1.5",
  "kept": null
 },
 {
  "id": "interp-108",
  "expr": "interpolate(0.5, [0, 1], ['0px', '100px'], {output: 'perceptual-scale'})",
  "vars": {},
  "expected": "50px",
  "kept": null
 },
 {
  "id": "interp-109",
  "expr": "interpolate(0.5, [0, 1], ['0px', '100px'], {output: 'perceptual-scale'})",
  "vars": {},
  "expected": "50px",
  "kept": null
 },
 {
  "id": "interp-110",
  "expr": "interpolate(0.5, [0, 1], [0, 1], {output: 'bogus'})",
  "vars": {},
  "expected": 0.5,
  "kept": null
 },
 {
  "id": "interp-111",
  "expr": "interpolate(0.5, [0, 1], [0, 1], {output: 'perceptual-scale', easing: Easing.quad})",
  "vars": {},
  "expected": 0.25,
  "kept": "perceptual-scale, v4.0.490"
 },
 {
  "id": "interp-113",
  "expr": "interpolate(f, [0, 10, 20], [1, 3, 0.5], {output: 'perceptual-scale'}) ",
  "vars": {
   "f": 1
  },
  "expected": 1.2,
  "kept": "perceptual-scale, v4.0.490"
 },
 {
  "id": "interp-113",
  "expr": "interpolate(f, [0, 10, 20], [1, 3, 0.5], {output: 'perceptual-scale'}) ",
  "vars": {
   "f": 11
  },
  "expected": 2.75,
  "kept": "perceptual-scale, v4.0.490"
 },
 {
  "id": "interp-113",
  "expr": "interpolate(f, [0, 10, 20], [1, 3, 0.5], {output: 'perceptual-scale'}) ",
  "vars": {
   "f": 19
  },
  "expected": 0.75,
  "kept": "perceptual-scale, v4.0.490"
 },
 {
  "id": "interp-141",
  "expr": "interpolate(0.5, [0, 1], ['0px', '100px'], {outputType: 'transform-origin'})",
  "vars": {},
  "expected": "50px",
  "kept": null
 },
 {
  "id": "interp-145",
  "expr": "interpolate(0.5, [0, 1], ['0px', '100px'], {outputType: 'rotate'})",
  "vars": {},
  "expected": "50px",
  "kept": null
 },
 {
  "id": "interp-148",
  "expr": "interpolate(1.5, [0, 1], ['0px', '100px'], {extrapolateRight: 'identity'})",
  "vars": {},
  "expected": "1.5px",
  "kept": null
 },
 {
  "id": "interp-149",
  "expr": "interpolate(1.5, [0, 1], ['0px', '100px'], {extrapolateRight: 'identity'})",
  "vars": {},
  "expected": "1.5px",
  "kept": null
 },
 {
  "id": "interp-158",
  "expr": "interpolate(0.5, [0, 1], ['0px', '100px'], {outputType: 'bogus'})",
  "vars": {},
  "expected": "50px",
  "kept": null
 },
 {
  "id": "interp-162",
  "expr": "interpolate(0.5, [0, 1], ['100', '900'], {outputType: 'font-weight'})",
  "vars": {},
  "expected": "500",
  "kept": null
 },
 {
  "id": "interp-181",
  "expr": "interpolate(5, [0, 10], ['0.50px', '100px'], {easing: Easing.step1})",
  "vars": {},
  "expected": "0.5px",
  "kept": null
 },
 {
  "id": "interp-182",
  "expr": "interpolate(10, [0, 10], ['0.50px', '100.0px'], {easing: Easing.step1})",
  "vars": {},
  "expected": "100px",
  "kept": null
 },
 {
  "id": "interp-200",
  "expr": "interpolate(1.5, [0, 1], [[0, 0], [10, 20]], {extrapolateRight: 'identity'})",
  "vars": {},
  "expected": [
   1.5,
   1.5
  ],
  "kept": null
 },
 {
  "id": "interp-201",
  "expr": "interpolate(1.5, [0, 1], [[0, 0], [10, 20]], {extrapolateRight: 'identity'})",
  "vars": {},
  "expected": [
   1.5,
   1.5
  ],
  "kept": null
 },
 {
  "id": "ease-002",
  "expr": "Easing.ease(i / 20) ",
  "vars": {
   "i": 21
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "ease-002",
  "expr": "Easing.ease(i / 20) ",
  "vars": {
   "i": 26
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "ease-002",
  "expr": "Easing.ease(i / 20) ",
  "vars": {
   "i": 30
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "ease-010",
  "expr": "Easing.exp(i / 20) ",
  "vars": {
   "i": -6
  },
  "expected": 0.000122,
  "kept": null
 },
 {
  "id": "ease-010",
  "expr": "Easing.exp(i / 20) ",
  "vars": {
   "i": -3
  },
  "expected": 0.000345,
  "kept": null
 },
 {
  "id": "ease-010",
  "expr": "Easing.exp(i / 20) ",
  "vars": {
   "i": 0
  },
  "expected": 0.000977,
  "kept": null
 },
 {
  "id": "ease-011",
  "expr": "Easing.elastic()(i / 20) ",
  "vars": {
   "i": -10
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "ease-011",
  "expr": "Easing.elastic()(i / 20) ",
  "vars": {
   "i": 10
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "ease-011",
  "expr": "Easing.elastic()(i / 20) ",
  "vars": {
   "i": 29
  },
  "expected": 0.957149,
  "kept": null
 },
 {
  "id": "ease-012",
  "expr": "Easing.elastic(1)(i / 20) ",
  "vars": {
   "i": -10
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "ease-012",
  "expr": "Easing.elastic(1)(i / 20) ",
  "vars": {
   "i": 10
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "ease-012",
  "expr": "Easing.elastic(1)(i / 20) ",
  "vars": {
   "i": 29
  },
  "expected": 0.957149,
  "kept": null
 },
 {
  "id": "ease-013",
  "expr": "Easing.elastic(0)(i / 20) ",
  "vars": {
   "i": -10
  },
  "expected": 0.646447,
  "kept": null
 },
 {
  "id": "ease-013",
  "expr": "Easing.elastic(0)(i / 20) ",
  "vars": {
   "i": 10
  },
  "expected": 0.646447,
  "kept": null
 },
 {
  "id": "ease-013",
  "expr": "Easing.elastic(0)(i / 20) ",
  "vars": {
   "i": 30
  },
  "expected": 1.353553,
  "kept": null
 },
 {
  "id": "ease-014",
  "expr": "Easing.elastic(3)(i / 20) ",
  "vars": {
   "i": -10
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "ease-014",
  "expr": "Easing.elastic(3)(i / 20) ",
  "vars": {
   "i": 10
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "ease-014",
  "expr": "Easing.elastic(3)(i / 20) ",
  "vars": {
   "i": 29
  },
  "expected": 1.12436,
  "kept": null
 },
 {
  "id": "ease-015",
  "expr": "Easing.back()(i / 20) ",
  "vars": {
   "i": -10
  },
  "expected": -0.763092,
  "kept": null
 },
 {
  "id": "ease-015",
  "expr": "Easing.back()(i / 20) ",
  "vars": {
   "i": 10
  },
  "expected": -0.087698,
  "kept": null
 },
 {
  "id": "ease-015",
  "expr": "Easing.back()(i / 20) ",
  "vars": {
   "i": 30
  },
  "expected": 5.289278,
  "kept": null
 },
 {
  "id": "ease-018",
  "expr": "Easing.bounce(i / 20) ",
  "vars": {
   "i": 1
  },
  "expected": 0.018906,
  "kept": null
 },
 {
  "id": "ease-018",
  "expr": "Easing.bounce(i / 20) ",
  "vars": {
   "i": 10
  },
  "expected": 0.765625,
  "kept": null
 },
 {
  "id": "ease-018",
  "expr": "Easing.bounce(i / 20) ",
  "vars": {
   "i": 19
  },
  "expected": 0.984531,
  "kept": null
 },
 {
  "id": "ease-019",
  "expr": "Easing.bezier(0.25, 0.1, 0.25, 1)(i / 20) ",
  "vars": {
   "i": -10
  },
  "expected": 0,
  "kept": null
 },
 {
  "id": "ease-019",
  "expr": "Easing.bezier(0.25, 0.1, 0.25, 1)(i / 20) ",
  "vars": {
   "i": -5
  },
  "expected": 0,
  "kept": null
 },
 {
  "id": "ease-019",
  "expr": "Easing.bezier(0.25, 0.1, 0.25, 1)(i / 20) ",
  "vars": {
   "i": -1
  },
  "expected": 0,
  "kept": null
 },
 {
  "id": "ease-021",
  "expr": "Easing.bezier(0, 0, 1, 1)(i / 20) ",
  "vars": {
   "i": -10
  },
  "expected": 0,
  "kept": null
 },
 {
  "id": "ease-021",
  "expr": "Easing.bezier(0, 0, 1, 1)(i / 20) ",
  "vars": {
   "i": 21
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "ease-021",
  "expr": "Easing.bezier(0, 0, 1, 1)(i / 20) ",
  "vars": {
   "i": 30
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "ease-022",
  "expr": "Easing.bezier(0.68, -0.6, 0.32, 1.6)(i / 20) ",
  "vars": {
   "i": -10
  },
  "expected": 0,
  "kept": null
 },
 {
  "id": "ease-022",
  "expr": "Easing.bezier(0.68, -0.6, 0.32, 1.6)(i / 20) ",
  "vars": {
   "i": 21
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "ease-022",
  "expr": "Easing.bezier(0.68, -0.6, 0.32, 1.6)(i / 20) ",
  "vars": {
   "i": 30
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "ease-037",
  "expr": "Easing.out(Easing.bounce)(i / 20) ",
  "vars": {
   "i": 1
  },
  "expected": 0.015469,
  "kept": null
 },
 {
  "id": "ease-037",
  "expr": "Easing.out(Easing.bounce)(i / 20) ",
  "vars": {
   "i": 10
  },
  "expected": 0.234375,
  "kept": null
 },
 {
  "id": "ease-037",
  "expr": "Easing.out(Easing.bounce)(i / 20) ",
  "vars": {
   "i": 19
  },
  "expected": 0.981094,
  "kept": null
 },
 {
  "id": "ease-038",
  "expr": "Easing.inOut(Easing.bounce)(i / 20) ",
  "vars": {
   "i": 1
  },
  "expected": 0.037813,
  "kept": null
 },
 {
  "id": "ease-038",
  "expr": "Easing.inOut(Easing.bounce)(i / 20) ",
  "vars": {
   "i": 11
  },
  "expected": 0.505938,
  "kept": null
 },
 {
  "id": "ease-038",
  "expr": "Easing.inOut(Easing.bounce)(i / 20) ",
  "vars": {
   "i": 19
  },
  "expected": 0.962188,
  "kept": null
 },
 {
  "id": "ease-039",
  "expr": "Easing.out(Easing.exp)(i / 20) ",
  "vars": {
   "i": 20
  },
  "expected": 0.999023,
  "kept": null
 },
 {
  "id": "ease-039",
  "expr": "Easing.out(Easing.exp)(i / 20) ",
  "vars": {
   "i": 23
  },
  "expected": 0.999655,
  "kept": null
 },
 {
  "id": "ease-039",
  "expr": "Easing.out(Easing.exp)(i / 20) ",
  "vars": {
   "i": 26
  },
  "expected": 0.999878,
  "kept": null
 },
 {
  "id": "ease-040",
  "expr": "Easing.inOut(Easing.exp)(i / 20) ",
  "vars": {
   "i": -2
  },
  "expected": 0.000122,
  "kept": null
 },
 {
  "id": "ease-040",
  "expr": "Easing.inOut(Easing.exp)(i / 20) ",
  "vars": {
   "i": 20
  },
  "expected": 0.999512,
  "kept": null
 },
 {
  "id": "ease-040",
  "expr": "Easing.inOut(Easing.exp)(i / 20) ",
  "vars": {
   "i": 22
  },
  "expected": 0.999878,
  "kept": null
 },
 {
  "id": "ease-043",
  "expr": "Easing.out(Easing.elastic(1))(i / 20) ",
  "vars": {
   "i": -9
  },
  "expected": 0.042851,
  "kept": null
 },
 {
  "id": "ease-043",
  "expr": "Easing.out(Easing.elastic(1))(i / 20) ",
  "vars": {
   "i": 11
  },
  "expected": 0.068781,
  "kept": null
 },
 {
  "id": "ease-043",
  "expr": "Easing.out(Easing.elastic(1))(i / 20) ",
  "vars": {
   "i": 30
  },
  "expected": 0,
  "kept": null
 },
 {
  "id": "ease-044",
  "expr": "Easing.inOut(Easing.elastic(2))(i / 20) ",
  "vars": {
   "i": -10
  },
  "expected": 0.5,
  "kept": null
 },
 {
  "id": "ease-044",
  "expr": "Easing.inOut(Easing.elastic(2))(i / 20) ",
  "vars": {
   "i": 11
  },
  "expected": 0.501549,
  "kept": null
 },
 {
  "id": "ease-044",
  "expr": "Easing.inOut(Easing.elastic(2))(i / 20) ",
  "vars": {
   "i": 30
  },
  "expected": 0.5,
  "kept": null
 },
 {
  "id": "ease-046",
  "expr": "Easing.inOut(Easing.back())(i / 20) ",
  "vars": {
   "i": -10
  },
  "expected": -2.20158,
  "kept": null
 },
 {
  "id": "ease-046",
  "expr": "Easing.inOut(Easing.back())(i / 20) ",
  "vars": {
   "i": 11
  },
  "expected": 0.704414,
  "kept": null
 },
 {
  "id": "ease-046",
  "expr": "Easing.inOut(Easing.back())(i / 20) ",
  "vars": {
   "i": 30
  },
  "expected": 3.20158,
  "kept": null
 },
 {
  "id": "ease-052",
  "expr": "Easing.inOut(Easing.bezier(0.25, 0.1, 0.25, 1))(i / 20) ",
  "vars": {
   "i": -10
  },
  "expected": 0,
  "kept": null
 },
 {
  "id": "ease-052",
  "expr": "Easing.inOut(Easing.bezier(0.25, 0.1, 0.25, 1))(i / 20) ",
  "vars": {
   "i": 21
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "ease-052",
  "expr": "Easing.inOut(Easing.bezier(0.25, 0.1, 0.25, 1))(i / 20) ",
  "vars": {
   "i": 30
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "ease-054",
  "expr": "Easing.in(Easing.bounce)(i / 20) ",
  "vars": {
   "i": 1
  },
  "expected": 0.018906,
  "kept": null
 },
 {
  "id": "ease-054",
  "expr": "Easing.in(Easing.bounce)(i / 20) ",
  "vars": {
   "i": 10
  },
  "expected": 0.765625,
  "kept": null
 },
 {
  "id": "ease-054",
  "expr": "Easing.in(Easing.bounce)(i / 20) ",
  "vars": {
   "i": 19
  },
  "expected": 0.984531,
  "kept": null
 },
 {
  "id": "ease-055",
  "expr": "Easing.elastic(-1)(0.5)",
  "vars": {},
  "expected": 1,
  "kept": null
 },
 {
  "id": "ease-063",
  "expr": "Easing.poly(0)(0)",
  "vars": {},
  "expected": 1,
  "kept": null
 },
 {
  "id": "ease-070",
  "expr": "Easing.spring()(i / 20) ",
  "vars": {
   "i": 1
  },
  "expected": 0.092121,
  "kept": null
 },
 {
  "id": "ease-070",
  "expr": "Easing.spring()(i / 20) ",
  "vars": {
   "i": 10
  },
  "expected": 1.10414,
  "kept": null
 },
 {
  "id": "ease-070",
  "expr": "Easing.spring()(i / 20) ",
  "vars": {
   "i": 19
  },
  "expected": 0.991179,
  "kept": null
 },
 {
  "id": "ease-071",
  "expr": "Easing.spring({damping: 200})(i / 20) ",
  "vars": {
   "i": 1
  },
  "expected": 0.05714,
  "kept": null
 },
 {
  "id": "ease-071",
  "expr": "Easing.spring({damping: 200})(i / 20) ",
  "vars": {
   "i": 10
  },
  "expected": 0.895419,
  "kept": null
 },
 {
  "id": "ease-071",
  "expr": "Easing.spring({damping: 200})(i / 20) ",
  "vars": {
   "i": 19
  },
  "expected": 0.99431,
  "kept": null
 },
 {
  "id": "ease-072",
  "expr": "Easing.spring({allowTail: true})(i / 20) ",
  "vars": {
   "i": 1
  },
  "expected": 0.092121,
  "kept": "curve fixed; allowTail residual (v4.0.483)"
 },
 {
  "id": "ease-072",
  "expr": "Easing.spring({allowTail: true})(i / 20) ",
  "vars": {
   "i": 15
  },
  "expected": 0.974359,
  "kept": "curve fixed; allowTail residual (v4.0.483)"
 },
 {
  "id": "ease-072",
  "expr": "Easing.spring({allowTail: true})(i / 20) ",
  "vars": {
   "i": 30
  },
  "expected": 1,
  "kept": "curve fixed; allowTail residual (v4.0.483)"
 },
 {
  "id": "ease-073",
  "expr": "Easing.spring({damping: 200, allowTail: true, durationRestThreshold: 0.03})(i / 20) ",
  "vars": {
   "i": 1
  },
  "expected": 0.05714,
  "kept": "allowTail and durationRestThreshold, v4.0.483"
 },
 {
  "id": "ease-073",
  "expr": "Easing.spring({damping: 200, allowTail: true, durationRestThreshold: 0.03})(i / 20) ",
  "vars": {
   "i": 16
  },
  "expected": 0.984525,
  "kept": "allowTail and durationRestThreshold, v4.0.483"
 },
 {
  "id": "ease-073",
  "expr": "Easing.spring({damping: 200, allowTail: true, durationRestThreshold: 0.03})(i / 20) ",
  "vars": {
   "i": 30
  },
  "expected": 1,
  "kept": "allowTail and durationRestThreshold, v4.0.483"
 },
 {
  "id": "ease-074",
  "expr": "Easing.spring({overshootClamping: true})(i / 20) ",
  "vars": {
   "i": 1
  },
  "expected": 0.092121,
  "kept": null
 },
 {
  "id": "ease-074",
  "expr": "Easing.spring({overshootClamping: true})(i / 20) ",
  "vars": {
   "i": 14
  },
  "expected": 0.981963,
  "kept": null
 },
 {
  "id": "ease-074",
  "expr": "Easing.spring({overshootClamping: true})(i / 20) ",
  "vars": {
   "i": 19
  },
  "expected": 0.991179,
  "kept": null
 },
 {
  "id": "ease-075",
  "expr": "Easing.spring({mass: 2, stiffness: 50})(i / 20) ",
  "vars": {
   "i": 1
  },
  "expected": 0.092121,
  "kept": null
 },
 {
  "id": "ease-075",
  "expr": "Easing.spring({mass: 2, stiffness: 50})(i / 20) ",
  "vars": {
   "i": 10
  },
  "expected": 1.10414,
  "kept": null
 },
 {
  "id": "ease-075",
  "expr": "Easing.spring({mass: 2, stiffness: 50})(i / 20) ",
  "vars": {
   "i": 19
  },
  "expected": 0.991179,
  "kept": null
 },
 {
  "id": "ease-076",
  "expr": "Easing.spring({durationRestThreshold: 0.001})(i / 20) ",
  "vars": {
   "i": 1
  },
  "expected": 0.092121,
  "kept": "Easing.spring durationRestThreshold, v4.0.483"
 },
 {
  "id": "ease-076",
  "expr": "Easing.spring({durationRestThreshold: 0.001})(i / 20) ",
  "vars": {
   "i": 10
  },
  "expected": 1.10414,
  "kept": "Easing.spring durationRestThreshold, v4.0.483"
 },
 {
  "id": "ease-076",
  "expr": "Easing.spring({durationRestThreshold: 0.001})(i / 20) ",
  "vars": {
   "i": 19
  },
  "expected": 0.991179,
  "kept": "Easing.spring durationRestThreshold, v4.0.483"
 },
 {
  "id": "ease-077",
  "expr": "Easing.spring({durationRestThreshold: 0.1})(i / 20) ",
  "vars": {
   "i": 1
  },
  "expected": 0.092121,
  "kept": "Easing.spring durationRestThreshold, v4.0.483"
 },
 {
  "id": "ease-077",
  "expr": "Easing.spring({durationRestThreshold: 0.1})(i / 20) ",
  "vars": {
   "i": 10
  },
  "expected": 1.10414,
  "kept": "Easing.spring durationRestThreshold, v4.0.483"
 },
 {
  "id": "ease-077",
  "expr": "Easing.spring({durationRestThreshold: 0.1})(i / 20) ",
  "vars": {
   "i": 19
  },
  "expected": 0.991179,
  "kept": "Easing.spring durationRestThreshold, v4.0.483"
 },
 {
  "id": "ease-078",
  "expr": "Easing.spring({})(0.5)",
  "vars": {},
  "expected": 1.10414,
  "kept": null
 },
 {
  "id": "ease-080",
  "expr": "Easing.spring({allowTail: true})(1)",
  "vars": {},
  "expected": 1,
  "kept": "allowTail, v4.0.483"
 },
 {
  "id": "measure-025",
  "expr": "measureSpring({fps: 1, config: {damping: 200}})",
  "vars": {},
  "expected": 12,
  "kept": null
 },
 {
  "id": "spring-011",
  "expr": "spring({frame: f, fps: 1}) ",
  "vars": {
   "f": 1
  },
  "expected": 0.161909,
  "kept": null
 },
 {
  "id": "spring-011",
  "expr": "spring({frame: f, fps: 1}) ",
  "vars": {
   "f": 6
  },
  "expected": 1.159616,
  "kept": null
 },
 {
  "id": "spring-011",
  "expr": "spring({frame: f, fps: 1}) ",
  "vars": {
   "f": 10
  },
  "expected": 0.985795,
  "kept": null
 },
 {
  "id": "spring-015",
  "expr": "spring({frame: f, fps: 30, from: 1, to: 0, config: {overshootClamping: true}}) ",
  "vars": {
   "f": 8
  },
  "expected": -0.06494,
  "kept": "SPEC documents overshootClamping (undated): beyond to is replaced by to"
 },
 {
  "id": "spring-015",
  "expr": "spring({frame: f, fps: 30, from: 1, to: 0, config: {overshootClamping: true}}) ",
  "vars": {
   "f": 31
  },
  "expected": -0.003561,
  "kept": "SPEC documents overshootClamping (undated): beyond to is replaced by to"
 },
 {
  "id": "spring-015",
  "expr": "spring({frame: f, fps: 30, from: 1, to: 0, config: {overshootClamping: true}}) ",
  "vars": {
   "f": 56
  },
  "expected": -0.000102,
  "kept": "SPEC documents overshootClamping (undated): beyond to is replaced by to"
 },
 {
  "id": "spring-018",
  "expr": "spring({frame: f, fps: 30, reverse: true, durationInFrames: 30}) ",
  "vars": {
   "f": 0
  },
  "expected": 0.996846,
  "kept": null
 },
 {
  "id": "spring-018",
  "expr": "spring({frame: f, fps: 30, reverse: true, durationInFrames: 30}) ",
  "vars": {
   "f": 15
  },
  "expected": 1.10414,
  "kept": null
 },
 {
  "id": "spring-018",
  "expr": "spring({frame: f, fps: 30, reverse: true, durationInFrames: 30}) ",
  "vars": {
   "f": 29
  },
  "expected": 0.043399,
  "kept": null
 },
 {
  "id": "spring-021",
  "expr": "spring({frame: f, fps: 30, delay: 10, durationInFrames: 20, reverse: true}) ",
  "vars": {
   "f": 0
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "spring-021",
  "expr": "spring({frame: f, fps: 30, delay: 10, durationInFrames: 20, reverse: true}) ",
  "vars": {
   "f": 15
  },
  "expected": 0.974359,
  "kept": null
 },
 {
  "id": "spring-021",
  "expr": "spring({frame: f, fps: 30, delay: 10, durationInFrames: 20, reverse: true}) ",
  "vars": {
   "f": 29
  },
  "expected": 0.092121,
  "kept": null
 },
 {
  "id": "spring-022",
  "expr": "spring({frame: f, fps: 30, durationInFrames: 30}) ",
  "vars": {
   "f": 1
  },
  "expected": 0.043399,
  "kept": null
 },
 {
  "id": "spring-022",
  "expr": "spring({frame: f, fps: 30, durationInFrames: 30}) ",
  "vars": {
   "f": 21
  },
  "expected": 0.981963,
  "kept": null
 },
 {
  "id": "spring-022",
  "expr": "spring({frame: f, fps: 30, durationInFrames: 30}) ",
  "vars": {
   "f": 40
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "spring-023",
  "expr": "spring({frame: f, fps: 30, durationInFrames: 30, durationRestThreshold: 0.001}) ",
  "vars": {
   "f": 1
  },
  "expected": 0.080445,
  "kept": null
 },
 {
  "id": "spring-023",
  "expr": "spring({frame: f, fps: 30, durationInFrames: 30, durationRestThreshold: 0.001}) ",
  "vars": {
   "f": 20
  },
  "expected": 0.988398,
  "kept": null
 },
 {
  "id": "spring-023",
  "expr": "spring({frame: f, fps: 30, durationInFrames: 30, durationRestThreshold: 0.001}) ",
  "vars": {
   "f": 39
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "spring-024",
  "expr": "spring({frame: 30, fps: 30, durationInFrames: 30, durationRestThreshold: 0.001})",
  "vars": {},
  "expected": 1.000448,
  "kept": null
 },
 {
  "id": "spring-025",
  "expr": "spring({frame: f, fps: 30, durationInFrames: 15, config: {damping: 200}}) ",
  "vars": {
   "f": 1
  },
  "expected": 0.093592,
  "kept": null
 },
 {
  "id": "spring-025",
  "expr": "spring({frame: f, fps: 30, durationInFrames: 15, config: {damping: 200}}) ",
  "vars": {
   "f": 11
  },
  "expected": 0.97605,
  "kept": null
 },
 {
  "id": "spring-025",
  "expr": "spring({frame: f, fps: 30, durationInFrames: 15, config: {damping: 200}}) ",
  "vars": {
   "f": 20
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "spring-026",
  "expr": "spring({frame: f, fps: 30, durationInFrames: 60, config: {damping: 5}}) ",
  "vars": {
   "f": 1
  },
  "expected": 0.055512,
  "kept": null
 },
 {
  "id": "spring-026",
  "expr": "spring({frame: f, fps: 30, durationInFrames: 60, config: {damping: 5}}) ",
  "vars": {
   "f": 35
  },
  "expected": 0.979115,
  "kept": null
 },
 {
  "id": "spring-026",
  "expr": "spring({frame: f, fps: 30, durationInFrames: 60, config: {damping: 5}}) ",
  "vars": {
   "f": 70
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "spring-032",
  "expr": "spring({frame: 1000, fps: 30}) === 1",
  "vars": {},
  "expected": false,
  "kept": null
 },
 {
  "id": "spring-041",
  "expr": "spring({frame: f, fps: 30, durationInFrames: 30, config: {overshootClamping: true}}) ",
  "vars": {
   "f": 1
  },
  "expected": 0.043399,
  "kept": null
 },
 {
  "id": "spring-041",
  "expr": "spring({frame: f, fps: 30, durationInFrames: 30, config: {overshootClamping: true}}) ",
  "vars": {
   "f": 22
  },
  "expected": 0.975967,
  "kept": null
 },
 {
  "id": "spring-041",
  "expr": "spring({frame: f, fps: 30, durationInFrames: 30, config: {overshootClamping: true}}) ",
  "vars": {
   "f": 31
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "spring-042",
  "expr": "spring({frame: f, fps: 60, durationInFrames: 30}) ",
  "vars": {
   "f": 1
  },
  "expected": 0.043399,
  "kept": null
 },
 {
  "id": "spring-042",
  "expr": "spring({frame: f, fps: 60, durationInFrames: 30}) ",
  "vars": {
   "f": 21
  },
  "expected": 0.981963,
  "kept": null
 },
 {
  "id": "spring-042",
  "expr": "spring({frame: f, fps: 60, durationInFrames: 30}) ",
  "vars": {
   "f": 40
  },
  "expected": 1,
  "kept": null
 },
 {
  "id": "spring-043",
  "expr": "spring({frame: 29.5, fps: 30, durationInFrames: 30})",
  "vars": {},
  "expected": 0.995114,
  "kept": null
 },
 {
  "id": "spring-053",
  "expr": "spring({frame: 10, fps: 30, config: {mass: 0}})",
  "vars": {},
  "expected": "NaN",
  "kept": null
 },
 {
  "id": "spring-054",
  "expr": "spring({frame: 10, fps: 30, config: {stiffness: 0}})",
  "vars": {},
  "expected": 0,
  "kept": null
 },
 {
  "id": "spring-058",
  "expr": "spring({frame: 10, fps: 30, durationInFrames: 30, durationRestThreshold: 1.5})",
  "vars": {},
  "expected": 0,
  "kept": null
 },
 {
  "id": "spring-061",
  "expr": "spring({frame: 10, fps: 30, delay: NaN})",
  "vars": {},
  "expected": 0,
  "kept": null
 },
 {
  "id": "spring-064",
  "expr": "spring({frame: 10, fps: 30, config: {mass: -1}})",
  "vars": {},
  "expected": "NaN",
  "kept": null
 },
 {
  "id": "color-054",
  "expr": "interpolateColors(NaN, [0, 20], ['red', 'blue'])",
  "vars": {},
  "expected": "rgba(NaN, 0, NaN, 1)",
  "kept": null
 },
 {
  "id": "ease-056",
  "expr": "`${Easing.elastic(-1)(0.5)}`",
  "vars": {},
  "expected": "1",
  "kept": null
 },
 {
  "id": "interp-062",
  "expr": "`${interpolate(NaN, [0, 10], [0, 1])}`",
  "vars": {},
  "expected": "NaN",
  "kept": null
 },
 {
  "id": "interp-064",
  "expr": "`${interpolate(Infinity, [0, 10], [0, 1], {extrapolateRight: 'clamp'})}`",
  "vars": {},
  "expected": "1",
  "kept": null
 },
 {
  "id": "random-035",
  "expr": "random(NaN)",
  "vars": {},
  "expected": 0,
  "kept": null
 },
 {
  "id": "random-036",
  "expr": "random(Infinity)",
  "vars": {},
  "expected": 0,
  "kept": null
 },
 {
  "id": "random-039",
  "expr": "random(-Infinity)",
  "vars": {},
  "expected": 0,
  "kept": null
 },
 {
  "id": "spring-059",
  "expr": "`${spring({frame: 10, fps: 30, durationInFrames: 30, durationRestThreshold: 1.5})}`",
  "vars": {},
  "expected": "0",
  "kept": null
 },
 {
  "id": "color-016",
  "expr": "interpolateColors(f, [0, 20], ['oklch(0.63 0.26 29)', 'oklch(0.45 0.31 264)']) ",
  "vars": {
   "f": 1
  },
  "expected": "rgba(242, 0, 14, 1)",
  "kept": null
 },
 {
  "id": "color-016",
  "expr": "interpolateColors(f, [0, 20], ['oklch(0.63 0.26 29)', 'oklch(0.45 0.31 264)']) ",
  "vars": {
   "f": 11
  },
  "expected": "rgba(115, 3, 140, 1)",
  "kept": null
 },
 {
  "id": "color-016",
  "expr": "interpolateColors(f, [0, 20], ['oklch(0.63 0.26 29)', 'oklch(0.45 0.31 264)']) ",
  "vars": {
   "f": 18
  },
  "expected": "rgba(26, 5, 228, 1)",
  "kept": null
 },
 {
  "id": "color-020",
  "expr": "interpolateColors(0, [0, 1], ['lab(50 40 -20)', 'white'])",
  "vars": {},
  "expected": "rgba(169, 92, 154, 1)",
  "kept": null
 },
 {
  "id": "color-021",
  "expr": "interpolateColors(0, [0, 1], ['lch(50 40 300)', 'white'])",
  "vars": {},
  "expected": "rgba(121, 110, 178, 1)",
  "kept": null
 },
 {
  "id": "color-024",
  "expr": "interpolateColors(f, [0, 10], ['lab(30 60 40)', 'lch(80 50 200)']) ",
  "vars": {
   "f": 0
  },
  "expected": "rgba(154, 0, 11, 1)",
  "kept": null
 },
 {
  "id": "color-024",
  "expr": "interpolateColors(f, [0, 10], ['lab(30 60 40)', 'lch(80 50 200)']) ",
  "vars": {
   "f": 5
  },
  "expected": "rgba(77, 111, 120, 1)",
  "kept": null
 },
 {
  "id": "color-024",
  "expr": "interpolateColors(f, [0, 10], ['lab(30 60 40)', 'lch(80 50 200)']) ",
  "vars": {
   "f": 9
  },
  "expected": "rgba(15, 200, 207, 1)",
  "kept": null
 },
 {
  "id": "color-051",
  "expr": "interpolateColors(20, [0, 20, 40], ['red', 'green', 'blue'], {easing: (t) => 0.5})",
  "vars": {},
  "expected": "rgba(128, 64, 0, 1)",
  "kept": null
 },
 {
  "id": "color-065",
  "expr": "interpolateColors(0, [0, 1], ['lch(50 40 300 / 25%)', 'white'])",
  "vars": {},
  "expected": "rgba(121, 110, 178, 0.251)",
  "kept": null
 },
 {
  "id": "ease-087",
  "expr": "interpolateColors(f, [0, 20, 40], ['red', 'green', 'blue'], {easing: [Easing.spring({allowTail: true}), Easing.linear]}) ",
  "vars": {
   "f": 2
  },
  "expected": "rgba(177, 39, 0, 1)",
  "kept": null
 },
 {
  "id": "ease-087",
  "expr": "interpolateColors(f, [0, 20, 40], ['red', 'green', 'blue'], {easing: [Easing.spring({allowTail: true}), Easing.linear]}) ",
  "vars": {
   "f": 7
  },
  "expected": "rgba(-39, 147, 0, 1)",
  "kept": null
 },
 {
  "id": "ease-087",
  "expr": "interpolateColors(f, [0, 20, 40], ['red', 'green', 'blue'], {easing: [Easing.spring({allowTail: true}), Easing.linear]}) ",
  "vars": {
   "f": 12
  },
  "expected": "rgba(-7, 131, 0, 1)",
  "kept": null
 }
];
