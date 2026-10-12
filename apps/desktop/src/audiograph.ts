// Live audio-effect preview through Web Audio. A preview decoder (<video> from
// the MediaPool) whose clip has previewable audio effects is routed:
//
//   element → MediaElementAudioSourceNode → effect chain (from the registry's
//   AudioNodeSpec plan) → GainNode (clip volume × fades × keyframes × bleep
//   mutes × track mute) → speakers
//
// Rules that keep the existing preview audio intact:
//  - Elements are routed only when needed (their clip has a live chain) and
//    only once the AudioContext may run: it is created/resumed on EVERY user
//    gesture (click/key, and Play), whether or not a clip has effects yet, so
//    playback that runs into an effect clip finds a running context. A routed
//    element sounds ONLY through the graph, so routing into a suspended
//    context would silence it. Everything else keeps the plain el.volume path.
//  - createMediaElementSource works once per element and the MediaPool reuses
//    elements across clips, so a route lives as long as its element; the chain
//    is rebuilt only when the clip's plan signature changes (never per frame).
//  - A routed element plays at el.volume 1, unmuted; ALL loudness (incl. bleep
//    mutes and inaudible = 0) moves to the GainNode — Chromium may ignore
//    el.volume on a routed element, or apply it on top.
//  - Gain changes ramp over a few ms (setTargetAtTime): no clicks while
//    scrubbing or at bleep edges.
//  - Pitch and robot run in an AudioWorklet (core's voiceworklet.ts), loaded
//    from a Blob URL when the context is created (no module file to fetch, so
//    it works from Electron's file:// page and the web shell alike). Until it
//    is ready a chain plays those nodes dry, then the route is rebuilt; if it
//    can't load, workletstatus.ts says so and the plans mark them render-only.
//  - The context runs at 48 kHz, the export's effect rate (AUDIO_FX_RATE), so
//    the robot's FFT windows and every filter match the render; the browser
//    resamples to the device.

import {
  AUDIO_FX_RATE, VOICE_WORKLET_PROCESSOR, VOICE_WORKLET_SOURCE, WORKLET_NODE_KINDS,
  type AudioNodeSpec, type AudioPreviewPlan, type VoiceWorkletOptions,
} from "@aive/core/audio-effects";
import { setVoiceWorkletState } from "./workletstatus";

interface Route {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  /** Every node of the current chain (disconnected on rebuild). */
  nodes: AudioNode[];
  /** Stop what drives the chain (oscillators, worklet processors) on rebuild. */
  stops: (() => void)[];
  sig: string;
  /** The plan's chain, kept to rebuild once the worklet is ready. */
  specs: readonly AudioNodeSpec[];
  lastGain: number;
}

/** Gain smoothing time constant (seconds). */
const GAIN_TAU = 0.005;

/** A built node: where the chain enters and leaves it, plus every node it made. */
interface Built {
  input: AudioNode;
  output: AudioNode;
  nodes: AudioNode[];
  /** Stop its sources (oscillators, worklet processors) when the chain is torn down. */
  stops?: (() => void)[];
}

/** Build options: `worklet` = the voice AudioWorklet is loaded into this context. */
export interface BuildOptions {
  worklet?: boolean;
}

/** Does a chain hold voice-worklet nodes? */
export function needsVoiceWorklet(specs: readonly AudioNodeSpec[]): boolean {
  return specs.some((s) => WORKLET_NODE_KINDS.includes(s.kind));
}

const workletLoads = new WeakMap<BaseAudioContext, Promise<boolean>>();

/**
 * Load the voice AudioWorklet into `ctx` (once per context): a Blob URL, else
 * a data: URL. Resolves false when AudioWorklet is missing (insecure origin)
 * or both fail; never rejects.
 */
export function loadVoiceWorklet(ctx: BaseAudioContext): Promise<boolean> {
  let p = workletLoads.get(ctx);
  if (p) return p;
  p = (async () => {
    const worklet = (ctx as { audioWorklet?: AudioWorklet }).audioWorklet;
    if (!worklet || typeof worklet.addModule !== "function") return false;
    try {
      const url = URL.createObjectURL(new Blob([VOICE_WORKLET_SOURCE], { type: "text/javascript" }));
      try {
        await worklet.addModule(url);
        return true;
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      /* blob: refused (a strict CSP) — try a data: URL */
    }
    try {
      await worklet.addModule(`data:text/javascript;base64,${btoa(VOICE_WORKLET_SOURCE)}`);
      return true;
    } catch {
      return false;
    }
  })();
  workletLoads.set(ctx, p);
  return p;
}

/** tanh(k·x)/tanh(k) — the same soft clip as the export's (core effects/audio.ts softClip). */
function shaperCurve(drive: number, n = 2048): Float32Array<ArrayBuffer> {
  const k = Math.max(0.01, drive);
  const norm = Math.tanh(k);
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

/** Build one spec into real nodes. */
export function buildNode(ctx: BaseAudioContext, spec: AudioNodeSpec, opts: BuildOptions = {}): Built {
  switch (spec.kind) {
    case "pitch":
    case "robot": {
      if (!opts.worklet) {
        // Worklet not (yet) loaded: this effect plays dry.
        const g = ctx.createGain();
        return { input: g, output: g, nodes: [g] };
      }
      const processorOptions: VoiceWorkletOptions = spec.kind === "pitch" ? { kind: "pitch", ratio: spec.ratio } : { kind: "robot", win: spec.win };
      const w = new AudioWorkletNode(ctx, VOICE_WORKLET_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
        processorOptions,
      });
      return { input: w, output: w, nodes: [w], stops: [() => w.port.postMessage("stop")] };
    }
    case "biquad": {
      const f = ctx.createBiquadFilter();
      f.type = spec.type;
      f.frequency.value = spec.frequency;
      if (spec.Q !== undefined) f.Q.value = spec.Q;
      if (spec.gain !== undefined) f.gain.value = spec.gain;
      return { input: f, output: f, nodes: [f] };
    }
    case "compressor": {
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = spec.threshold;
      c.knee.value = spec.knee;
      c.ratio.value = spec.ratio;
      c.attack.value = spec.attack;
      c.release.value = spec.release;
      return { input: c, output: c, nodes: [c] };
    }
    case "gain": {
      const g = ctx.createGain();
      g.gain.value = spec.gain;
      return { input: g, output: g, nodes: [g] };
    }
    case "shaper": {
      const w = ctx.createWaveShaper();
      w.curve = shaperCurve(spec.drive);
      return { input: w, output: w, nodes: [w] };
    }
    case "taps": {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const dry = ctx.createGain();
      dry.gain.value = spec.dry;
      input.connect(dry).connect(output);
      const nodes: AudioNode[] = [input, output, dry];
      for (const t of spec.taps) {
        const d = ctx.createDelay(Math.max(0.01, t.delay + 0.01));
        d.delayTime.value = t.delay;
        const g = ctx.createGain();
        g.gain.value = t.gain;
        input.connect(d).connect(g).connect(output);
        nodes.push(d, g);
      }
      return { input, output, nodes };
    }
    case "vibrato": {
      // FFmpeg vibrato: a delay line swept sinusoidally between 0 and `depth`.
      const d = ctx.createDelay(Math.max(0.01, spec.depth * 2));
      d.delayTime.value = spec.depth / 2;
      const osc = ctx.createOscillator();
      osc.frequency.value = spec.rate;
      const amt = ctx.createGain();
      amt.gain.value = spec.depth / 2;
      osc.connect(amt).connect(d.delayTime);
      osc.start();
      return {
        input: d, output: d, nodes: [d, amt, osc],
        stops: [() => { try { osc.stop(); } catch { /* already stopped */ } }],
      };
    }
  }
}

/** Build a whole chain; null = no nodes (dry). */
export function buildChain(
  ctx: BaseAudioContext, specs: readonly AudioNodeSpec[], opts: BuildOptions = {},
): { input: AudioNode; output: AudioNode; nodes: AudioNode[]; stops: (() => void)[] } | null {
  if (!specs.length) return null;
  const nodes: AudioNode[] = [];
  const stops: (() => void)[] = [];
  let first: AudioNode | null = null;
  let last: AudioNode | null = null;
  for (const spec of specs) {
    const b = buildNode(ctx, spec, opts);
    nodes.push(...b.nodes);
    stops.push(...(b.stops ?? []));
    if (last) last.connect(b.input);
    else first = b.input;
    last = b.output;
  }
  return { input: first!, output: last!, nodes, stops };
}

export class AudioRouter {
  private ctx: AudioContext | null = null;
  /** A user gesture has happened (the context was created/resumed inside one). */
  private unlocked = false;
  private readonly routes = new WeakMap<HTMLMediaElement, Route>();
  /** Every route (the pool's elements live as long as the router), to rebuild when the worklet arrives. */
  private readonly allRoutes = new Set<Route>();
  /** The voice worklet is loaded into ctx. */
  private workletReady = false;
  /** Elements that refused routing (e.g. already captured elsewhere) — never retried. */
  private readonly refused = new WeakSet<HTMLMediaElement>();
  private readonly onGesture = () => this.unlock();

  constructor() {
    // Autoplay policy: the context may only start on a user gesture. Any
    // click/key in the app unlocks it (doPlay calls unlock() too).
    window.addEventListener("pointerdown", this.onGesture, true);
    window.addEventListener("keydown", this.onGesture, true);
  }

  /**
   * Create / resume the AudioContext. Call from a user gesture. Not gated on a
   * clip wanting a chain: the gesture that starts playback usually comes
   * before the playhead reaches an effect clip (or before the first effect is
   * added), and without a context made inside a gesture that clip would play
   * dry until the next click.
   */
  unlock(): void {
    try {
      if (!this.ctx) {
        try {
          this.ctx = new AudioContext({ latencyHint: "interactive", sampleRate: AUDIO_FX_RATE });
        } catch {
          this.ctx = new AudioContext({ latencyHint: "interactive" }); // a rate this engine refuses
        }
        this.startWorklet(this.ctx);
      }
      if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
      this.unlocked = true;
    } catch {
      this.ctx = null; // no audio device / Web Audio unavailable: keep the plain path
    }
  }

  /** Load the voice worklet into a new context; rebuild the chains that wait for it. */
  private startWorklet(ctx: AudioContext): void {
    setVoiceWorkletState("loading");
    void loadVoiceWorklet(ctx).then((ok) => {
      if (this.ctx !== ctx) return;
      setVoiceWorkletState(ok ? "ready" : "failed");
      this.workletReady = ok;
      if (!ok) return;
      for (const r of this.allRoutes) {
        if (!needsVoiceWorklet(r.specs)) continue;
        this.rebuild(r, r.specs);
        r.sig = this.effectiveSig(r.specs, JSON.stringify(r.specs));
      }
    });
  }

  /** A plan's signature plus whether its worklet nodes were built for real. */
  private effectiveSig(specs: readonly AudioNodeSpec[], sig: string): string {
    return sig && needsVoiceWorklet(specs) ? `${sig}|w${this.workletReady ? 1 : 0}` : sig;
  }

  /** The context, once it may run (never route into a context the autoplay policy holds suspended). */
  private liveContext(): AudioContext | null {
    if (!this.unlocked || !this.ctx || this.ctx.state === "closed") return null;
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** True when this element plays through Web Audio (then its loudness is setGain's job). */
  isRouted(el: HTMLMediaElement): boolean {
    return this.routes.has(el);
  }

  /**
   * Point `el`'s audio at `plan`'s chain (none = dry). Routes the element on
   * first need; afterwards it stays routed (rebinding to another clip just
   * swaps the chain). Returns true when the element is routed.
   */
  route(el: HTMLMediaElement, plan: AudioPreviewPlan | undefined): boolean {
    let r = this.routes.get(el);
    const specs = plan?.nodes.length ? plan.nodes : [];
    const sig = this.effectiveSig(specs, specs.length ? plan!.sig : "");
    if (!r) {
      if (!sig || this.refused.has(el)) return false;
      const ctx = this.liveContext();
      if (!ctx) return false;
      try {
        const source = ctx.createMediaElementSource(el);
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gain.connect(ctx.destination);
        source.connect(gain);
        r = { source, gain, nodes: [], stops: [], sig: "", specs: [], lastGain: 0 };
        this.routes.set(el, r);
        this.allRoutes.add(r);
      } catch {
        this.refused.add(el);
        return false;
      }
      el.muted = false;
      el.volume = 1;
    }
    if (r.sig !== sig) this.rebuild(r, specs);
    r.sig = sig;
    return true;
  }

  /** Set a routed element's loudness (0..1; 0 = silent), smoothed. */
  setGain(el: HTMLMediaElement, value: number): void {
    const r = this.routes.get(el);
    if (!r || !this.ctx) return;
    const v = Number.isFinite(value) ? Math.max(0, value) : 0;
    if (Math.abs(v - r.lastGain) < 1e-4) return;
    r.lastGain = v;
    r.gain.gain.setTargetAtTime(v, this.ctx.currentTime, GAIN_TAU);
  }

  /** Swap a route's chain: source → [chain] → gain. */
  private rebuild(r: Route, specs: readonly AudioNodeSpec[]): void {
    const ctx = this.ctx!;
    r.source.disconnect();
    for (const stop of r.stops) stop();
    for (const n of r.nodes) n.disconnect();
    r.specs = specs;
    const chain = buildChain(ctx, specs, { worklet: this.workletReady });
    if (chain) {
      r.source.connect(chain.input);
      chain.output.connect(r.gain);
      r.nodes = chain.nodes;
      r.stops = chain.stops;
    } else {
      r.source.connect(r.gain);
      r.nodes = [];
      r.stops = [];
    }
  }

  /** Tear down (the preview unmounted). */
  dispose(): void {
    window.removeEventListener("pointerdown", this.onGesture, true);
    window.removeEventListener("keydown", this.onGesture, true);
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
