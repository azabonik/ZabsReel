// Per-app state shared by the module object, the hooks and the app: open delays, the first
// failure, and the fonts the app registered. A session is created by createModuleObject(host)
// or createMotionApp(host), whichever comes first, and belongs to exactly one app.

import { resolveFontAsset } from "./assets";
import { describeValue, graphicError, isError, misuse, toError } from "./errors";
import type { MotionHost } from "./hostTypes";

/** Options of delayRender(). Accepted and ignored by ZedMix (BRIEF section 6.7). */
export interface DelayRenderOptions {
  timeoutInMilliseconds?: number;
  retries?: number;
}

export interface LoadFontOptions {
  family?: string;
}

export interface LoadFontResult {
  fontFamily: string;
}

export const MAX_FONTS_PER_APP = 16;

interface FontRecord {
  id: string;
  family: string;
  face: FontFace | null;
}

// Handles are unique across every session in the page, so that a handle from one app is never
// mistaken for a handle of another.
let lastHandle = 0;

export class Session {
  readonly host: MotionHost;
  private readonly openDelays = new Map<number, string>();
  private readonly issued = new Set<number>();
  private waiters: Array<() => void> = [];
  /** Bumped whenever a delay opens or closes. */
  version = 0;
  failure: Error | null = null;
  /** Set once the app is unmounted. From then on failures and delays are ignored. */
  closed = false;
  readonly fonts = new Map<string, FontRecord>();

  constructor(host: MotionHost) {
    this.host = host;
  }

  get openCount(): number {
    return this.openDelays.size;
  }

  openLabels(): string[] {
    return [...this.openDelays.values()];
  }

  openDelay(label: string): number {
    const handle = ++lastHandle;
    this.issued.add(handle);
    if (this.closed) return handle;
    this.openDelays.set(handle, label);
    this.version++;
    this.notify();
    return handle;
  }

  closeDelay(handle: number): void {
    if (this.openDelays.delete(handle)) {
      this.version++;
      this.notify();
    }
  }

  releaseAll(): void {
    if (this.openDelays.size === 0) return;
    this.openDelays.clear();
    this.version++;
    this.notify();
  }

  /** Records the first failure. Later failures are dropped: the first rejection is final. */
  fail(error: unknown): void {
    if (this.closed || this.failure) return;
    this.failure = toError(error);
    this.notify();
  }

  /** Resolves at the next state change (delay opened or closed, failure, marker, unmount). */
  changed(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  notify(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const wake of waiting) wake();
  }

  // ---- The user-facing delay API, bound to this session. ----

  delayRender = (label?: string, options?: DelayRenderOptions): number => {
    void options; // timeoutInMilliseconds and retries are accepted and ignored
    if (label !== undefined && typeof label !== "string") {
      throw misuse(
        `delayRender() takes an optional label string as its first argument, but got ${describeValue(label)}. Pass a label such as delayRender("Loading data"), or nothing.`,
      );
    }
    return this.openDelay(label === undefined ? "delayRender() without a label" : `delayRender("${label}")`);
  };

  continueRender = (handle: number): void => {
    if (typeof handle !== "number" || !this.issued.has(handle)) {
      throw misuse(
        `continueRender() needs the handle that delayRender() returned in this graphic, but got ${describeValue(handle)}. Keep the value delayRender() returns and pass it back.`,
      );
    }
    this.closeDelay(handle);
  };

  cancelRender = (reason: unknown): never => {
    const error = cancelError(reason);
    this.releaseAll();
    this.fail(error);
    throw error;
  };

  // ---- Fonts (BRIEF section 6.5). ----

  loadFont = (ref: unknown, options?: LoadFontOptions): LoadFontResult => {
    try {
      if (this.closed) {
        throw graphicError(
          "graphic_render_cancelled",
          "loadFont() was called after the graphic was unmounted, so the font was not registered.",
        );
      }
      if (options !== undefined && (typeof options !== "object" || options === null)) {
        throw misuse(
          `loadFont() takes an optional options object as its second argument, but got ${describeValue(options)}. Pass { family: "My Font" } or leave it out.`,
        );
      }
      const family = options?.family;
      if (family !== undefined && (typeof family !== "string" || family.trim() === "")) {
        throw misuse(
          `loadFont()'s family option must be a non-empty string, but got ${describeValue(family)}. Leave it out to get a generated family name.`,
        );
      }
      const { id, info } = resolveFontAsset(ref, this.host.assets);
      const known = this.fonts.get(id);
      if (known) return { fontFamily: known.family };
      if (this.fonts.size >= MAX_FONTS_PER_APP) {
        throw graphicError(
          "graphic_font_cap",
          `loadFont() was asked for the font "${id}", but a graphic may load at most ${MAX_FONTS_PER_APP} different fonts. Use fewer fonts.`,
        );
      }
      const record: FontRecord = { id, family: family ?? `zr-font-${id}`, face: null };
      this.fonts.set(id, record);
      this.startFontLoad(record, info.handle);
      return { fontFamily: record.family };
    } catch (error) {
      this.fail(error);
      throw error;
    }
  };

  private startFontLoad(record: FontRecord, handle: string): void {
    const FontFaceClass = (globalThis as { FontFace?: typeof FontFace }).FontFace;
    const fontSet = typeof document === "undefined" ? undefined : document.fonts;
    if (typeof FontFaceClass !== "function" || !fontSet) {
      this.fail(fontFailedError(record.id, "this page cannot register fonts"));
      return;
    }
    let face: FontFace;
    try {
      face = new FontFaceClass(record.family, `url(${this.host.fontUrl(handle)})`);
      fontSet.add(face);
    } catch (error) {
      this.fail(fontFailedError(record.id, error));
      return;
    }
    record.face = face;
    const delay = this.openDelay(`loading font "${record.id}"`);
    face.load().then(
      () => this.closeDelay(delay),
      (error: unknown) => {
        this.fail(fontFailedError(record.id, error));
        this.closeDelay(delay);
      },
    );
  }

  /** Removes this app's faces from document.fonts (called on unmount). */
  removeFonts(): void {
    const fontSet = typeof document === "undefined" ? undefined : document.fonts;
    for (const record of this.fonts.values()) {
      if (record.face && fontSet) {
        try {
          fontSet.delete(record.face);
        } catch {
          // The face is gone already; nothing else to clean up.
        }
      }
    }
  }
}

function fontFailedError(id: string, cause: unknown) {
  const detail = isError(cause) ? cause.message : String(cause);
  return graphicError(
    "graphic_media_failed",
    `The font "${id}" could not be loaded (${detail}). Check that the asset is a valid font file, or pick another font.`,
    cause,
  );
}

/** The error cancelRender() throws (BRIEF section 6.7). */
export function cancelError(reason: unknown) {
  if (typeof reason === "string") return graphicError("graphic_render_cancelled", reason);
  if (isError(reason)) return graphicError("graphic_render_cancelled", reason.message, reason);
  const message =
    typeof reason === "object" && reason !== null && typeof (reason as { message?: unknown }).message === "string"
      ? (reason as { message: string }).message
      : String(reason);
  return graphicError("graphic_render_cancelled", message, reason);
}

// ---- Binding sessions to hosts. ----

const pendingSessions = new WeakMap<MotionHost, Session>();

/** The session that the next createMotionApp(host) will adopt. */
export function sessionForModule(host: MotionHost): Session {
  let session = pendingSessions.get(host);
  if (!session) {
    session = new Session(host);
    pendingSessions.set(host, session);
  }
  return session;
}

/** Hands the pending session (if any) to a new app; later module objects get a new session. */
export function sessionForApp(host: MotionHost): Session {
  const session = pendingSessions.get(host) ?? new Session(host);
  pendingSessions.delete(host);
  return session;
}
