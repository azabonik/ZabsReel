// Reading and checking the Sequence-style timing props.

import { misuse } from "./errors";
import type { SequenceTiming } from "./timing";
import { duration, finiteNumber, positiveRate } from "./validate";

export interface RawTiming {
  from?: unknown;
  durationInFrames?: unknown;
  trimBefore?: unknown;
  playbackRate?: unknown;
  loop?: unknown;
  freeze?: unknown;
}

export function readSequenceTiming(props: RawTiming, where: string): SequenceTiming {
  const from = finiteNumber(props.from, 0, where, "from");
  const trimBefore = finiteNumber(props.trimBefore, 0, where, "trimBefore");
  const durationInFrames = duration(props.durationInFrames, where);
  const playbackRate = positiveRate(props.playbackRate, where);
  if (props.loop !== undefined && props.loop !== null && typeof props.loop !== "boolean") {
    throw misuse(`${where}: loop must be true or false.`);
  }
  const loop = props.loop === true;
  if (loop && !(Number.isFinite(durationInFrames) && durationInFrames > 0)) {
    throw misuse(
      `${where}: loop needs a finite, positive durationInFrames, which sets the length of one repetition.`,
    );
  }
  const freeze =
    props.freeze === undefined || props.freeze === null
      ? null
      : finiteNumber(props.freeze, 0, where, "freeze");
  return { from, trimBefore, durationInFrames, playbackRate, loop, freeze };
}
