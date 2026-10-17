// createMotionApp (BRIEF section 4): one React root per app, frames committed synchronously, and
// renderFrame() resolving once the frame has settled.

import React from "react";
import * as ReactDOM from "react-dom";
import { flushSync } from "react-dom";
import { LoopContext, RuntimeContext, TimelineContext } from "./context";
import type { AppRuntime, AudioSourceEntry, Timeline, UseDelayRenderResult } from "./context";
import { graphicError, misuse } from "./errors";
import type { AudioCue, CompositionInput, FrameResult, MotionApp, MotionHost } from "./hostTypes";
import { sessionForApp } from "./session";
import type { Session } from "./session";

/** The part of a React 18 root this file uses. */
interface ReactRoot {
  render(children: React.ReactNode): void;
  unmount(): void;
}

const createRoot = (ReactDOM as unknown as { createRoot(container: Element): ReactRoot }).createRoot;

export const MAX_MEDIA_ELEMENTS = 8;
export const MAX_AUDIO_CUES = 8;
export const DEFAULT_FRAME_TIMEOUT_MS = 30000;

type GraphicComponent = React.ComponentType<Record<string, unknown>>;

interface ShellProps {
  app: MotionAppImpl;
  frame: number;
  seq: number;
  marker: number;
}

/**
 * The top of the tree. Re-rendering it with a new `marker` (in a transition) re-renders nothing
 * below it: the context values and the graphic's element are memoized. Its passive effect runs
 * after every effect of the same commit, which is what the settle loop waits for.
 */
function Shell({ app, frame, seq, marker }: ShellProps) {
  const { composition } = app;
  const timeline = React.useMemo<Timeline>(
    () => ({
      frame,
      unloopedFrame: frame,
      durationInFrames: composition.durationInFrames,
      width: composition.width,
      height: composition.height,
      frozen: false,
      renderSeq: seq,
    }),
    [composition, frame, seq],
  );
  const content = React.useMemo(() => React.createElement(app.Component, { ...composition.props }), [app, composition]);
  React.useEffect(() => {
    app.markerCommitted(marker);
  }, [app, marker]);
  return (
    <RuntimeContext.Provider value={app.runtime}>
      <TimelineContext.Provider value={timeline}>
        <LoopContext.Provider value={null}>
          <Boundary session={app.session}>{content}</Boundary>
        </LoopContext.Provider>
      </TimelineContext.Provider>
    </RuntimeContext.Provider>
  );
}

interface BoundaryProps {
  session: Session;
  children?: React.ReactNode;
}

/** Catches errors thrown while rendering the graphic or running its effects. */
class Boundary extends React.Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.session.fail(error);
  }

  override render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function checkComposition(c: CompositionInput): void {
  const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (!c || typeof c !== "object") throw misuse("createMotionApp(): host.composition is missing.");
  if (!positive(c.width) || !positive(c.height)) {
    throw misuse("createMotionApp(): composition width and height must be positive numbers.");
  }
  if (!positive(c.fps)) throw misuse("createMotionApp(): composition fps must be a positive number.");
  if (!Number.isInteger(c.durationInFrames) || c.durationInFrames < 1) {
    throw misuse("createMotionApp(): composition durationInFrames must be a whole number of at least 1.");
  }
}

function timeoutError(frame: number, ms: number, labels: string[]) {
  const waiting = labels.length > 0 ? labels.join(", ") : "nothing that holds a delay (React updates did not finish)";
  return graphicError(
    "graphic_frame_timeout",
    `Frame ${frame} did not finish rendering within ${ms} ms. Still open: ${waiting}. Make sure every delayRender() is matched by continueRender() and that media and fonts can load.`,
  );
}

const DOCUMENT_POSITION_FOLLOWING = 4;

class MotionAppImpl implements MotionApp {
  readonly session: Session;
  readonly composition: CompositionInput;
  readonly runtime: AppRuntime;
  readonly Component: GraphicComponent;
  private readonly host: MotionHost;
  private readonly rootElement: HTMLDivElement;
  private readonly root: ReactRoot;
  private frame = 0;
  private seq = 0;
  private markerSeq = 0;
  private markerDone = 0;
  private pending = false;
  private unmountError: Error | null = null;
  private mediaElements = 0;
  private readonly audioSources = new Set<AudioSourceEntry>();
  private sourceCounter = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: MotionHost, Component: GraphicComponent, container: HTMLElement) {
    checkComposition(host.composition);
    if (typeof Component !== "function" && (typeof Component !== "object" || Component === null)) {
      throw misuse("createMotionApp(): the graphic's default export must be a React component.");
    }
    this.host = host;
    this.composition = host.composition;
    this.Component = Component;
    this.session = sessionForApp(host);
    const session = this.session;
    const delayApi: UseDelayRenderResult = {
      delayRender: session.delayRender,
      continueRender: session.continueRender,
      cancelRender: session.cancelRender,
    };
    this.runtime = {
      session,
      host,
      composition: this.composition,
      delayApi,
      registerMediaElement: () => this.registerMediaElement(),
      registerAudioSource: (entry) => {
        this.audioSources.add(entry);
        return () => {
          this.audioSources.delete(entry);
        };
      },
      nextSourceKey: () => `source-${++this.sourceCounter}`,
      fail: (error) => session.fail(error),
    };
    const doc = container.ownerDocument;
    this.rootElement = doc.createElement("div");
    this.rootElement.style.position = "relative";
    this.rootElement.style.overflow = "hidden";
    this.rootElement.style.width = "100%";
    this.rootElement.style.height = "100%";
    container.appendChild(this.rootElement);
    this.root = createRoot(this.rootElement);
  }

  private registerMediaElement(): () => void {
    this.mediaElements++;
    if (this.mediaElements > MAX_MEDIA_ELEMENTS) {
      this.session.fail(
        graphicError(
          "graphic_media_per_frame",
          `This frame shows more than ${MAX_MEDIA_ELEMENTS} images and video frames at once. Show at most ${MAX_MEDIA_ELEMENTS} at a time, for example by giving them shorter, non-overlapping Sequences.`,
        ),
      );
    }
    let counted = true;
    return () => {
      if (counted) this.mediaElements--;
      counted = false;
    };
  }

  markerCommitted(marker: number): void {
    if (marker > this.markerDone) {
      this.markerDone = marker;
      this.session.notify();
    }
  }

  private shell(): React.ReactElement {
    return <Shell app={this} frame={this.frame} seq={this.seq} marker={this.markerSeq} />;
  }

  /** Re-renders the Shell in a transition; React commits it after all earlier updates. */
  private requestMarker(): number {
    this.markerSeq++;
    const element = this.shell();
    React.startTransition(() => this.root.render(element));
    return this.markerSeq;
  }

  private rejectNow(error: Error): Promise<FrameResult> {
    return Promise.reject(error);
  }

  renderFrame(n: number): Promise<FrameResult> {
    if (this.unmountError) return this.rejectNow(this.unmountError);
    const session = this.session;
    if (session.failure) return this.rejectNow(session.failure);
    if (this.pending) {
      session.fail(misuse("renderFrame() was called again before the previous frame settled."));
      return this.rejectNow(session.failure as unknown as Error);
    }
    if (!Number.isInteger(n) || n < 0 || n >= this.composition.durationInFrames) {
      session.fail(
        misuse(
          `renderFrame() needs a whole frame number from 0 to ${this.composition.durationInFrames - 1}, but got ${String(n)}.`,
        ),
      );
      return this.rejectNow(session.failure as unknown as Error);
    }
    this.pending = true;
    this.frame = n;
    const seq = ++this.seq;
    const timeoutMs = this.host.frameTimeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending && this.seq === seq) session.fail(timeoutError(n, timeoutMs, session.openLabels()));
    }, timeoutMs);
    try {
      flushSync(() => this.root.render(this.shell()));
    } catch (error) {
      session.fail(error);
    }
    return this.settle().finally(() => {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      this.pending = false;
    });
  }

  private throwIfDone(): void {
    if (this.unmountError) throw this.unmountError;
    if (this.session.failure) throw this.session.failure;
  }

  /**
   * Waits until no delay is open and a marker render has committed with no delay opened or
   * closed in the meantime. Every wait wakes on any session change, so failures, timeouts and
   * unmount end the loop at once.
   */
  private async settle(): Promise<FrameResult> {
    const session = this.session;
    for (;;) {
      this.throwIfDone();
      if (session.openCount > 0) {
        await session.changed();
        continue;
      }
      const version = session.version;
      const target = this.requestMarker();
      while (this.markerDone < target && session.version === version) {
        this.throwIfDone();
        await session.changed();
      }
      this.throwIfDone();
      if (session.version === version && session.openCount === 0) break;
    }
    const cues = this.collectCues();
    this.throwIfDone();
    return { cues };
  }

  private collectCues(): AudioCue[] {
    const sources = [...this.audioSources].filter((entry) => entry.cue !== null);
    sources.sort((a, b) => {
      if (!a.anchor || !b.anchor || a.anchor === b.anchor) return 0;
      return a.anchor.compareDocumentPosition(b.anchor) & DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    if (sources.length > MAX_AUDIO_CUES) {
      this.session.fail(
        graphicError(
          "graphic_audio_cues_cap",
          `This frame plays ${sources.length} audio sources at once, but at most ${MAX_AUDIO_CUES} may play together. Mute or remove some, or give them shorter Sequences.`,
        ),
      );
      return [];
    }
    return sources.map((entry) => ({ ...(entry.cue as AudioCue) }));
  }

  unmount(): void {
    if (this.unmountError) return;
    this.unmountError = graphicError(
      "graphic_render_cancelled",
      "The graphic was unmounted, so its frames can no longer be rendered.",
    );
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.session.closed = true;
    try {
      this.root.unmount();
    } catch {
      // Unmounting a root that failed to render can throw; the DOM is removed below anyway.
    }
    this.session.removeFonts();
    this.rootElement.remove();
    this.session.notify();
  }
}

export function createMotionApp(
  host: MotionHost,
  Component: React.ComponentType<Record<string, unknown>>,
  container: HTMLElement,
): MotionApp {
  return new MotionAppImpl(host, Component, container);
}
