// The host interface types live in host.ts (BRIEF section 4). Internal files import them from
// here, as types only, so they never load host.ts at runtime.

export type { AssetInfo, AudioCue, CompositionInput, FrameResult, MotionApp, MotionHost } from "./host";
