// A fake host, render helpers, and FontFace / document.fonts stubs.

import assert from "node:assert/strict";
import type React from "react";
import { createMotionApp, createModuleObject } from "../../runtime/src/host";
import type { AssetInfo, CompositionInput, FrameResult, MotionApp, MotionHost } from "../../runtime/src/host";

export type TestHost = MotionHost & { logs: string[] };

export interface HostOptions {
  assets?: Record<string, AssetInfo>;
  composition?: Partial<CompositionInput>;
  frameTimeoutMs?: number;
}

export function makeHost(options: HostOptions = {}): TestHost {
  const logs: string[] = [];
  return {
    composition: {
      id: "Graphic",
      width: 1280,
      height: 720,
      fps: 30,
      durationInFrames: 300,
      props: {},
      ...options.composition,
    },
    assets: options.assets ?? {},
    mediaUrl(handle, box, sourceFrame) {
      const frame = sourceFrame === undefined ? "" : `&f=${sourceFrame}`;
      return `https://media.test/${handle}?w=${box.w}&h=${box.h}${frame}`;
    },
    fontUrl(handle) {
      return `https://fonts.test/${handle}.woff2`;
    },
    log(text) {
      logs.push(text);
    },
    frameTimeoutMs: options.frameTimeoutMs ?? 400,
    logs,
  };
}

export const imageAsset = (handle: string, width = 640, height = 360): AssetInfo => ({ handle, kind: "image", width, height });

export const videoAsset = (
  handle: string,
  extra: Partial<AssetInfo> = {},
): AssetInfo => ({
  handle,
  kind: "video",
  width: 1920,
  height: 1080,
  fps: 30,
  frameCount: 300,
  durationSeconds: 10,
  hasAudio: true,
  ...extra,
});

export const audioAsset = (handle: string, durationSeconds = 20): AssetInfo => ({ handle, kind: "audio", durationSeconds });

export const fontAsset = (handle: string): AssetInfo => ({ handle, kind: "font" });

export interface Mounted {
  app: MotionApp;
  container: HTMLDivElement;
  host: TestHost;
}

export function mount(host: TestHost, Component: React.ComponentType<Record<string, unknown>>): Mounted {
  const container = document.createElement("div");
  container.style.width = `${host.composition.width}px`;
  container.style.height = `${host.composition.height}px`;
  document.body.appendChild(container);
  const app = createMotionApp(host, Component, container);
  return { app, container, host };
}

/** The module object for a host, typed loosely for tests. */
export function moduleFor(host: MotionHost): Record<string, any> {
  return createModuleObject(host) as Record<string, any>;
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function ticks(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}

export interface Tracked<T> {
  promise: Promise<T>;
  settled(): boolean;
}

export function track<T>(promise: Promise<T>): Tracked<T> {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return { promise, settled: () => done };
}

export function images(container: Element): HTMLImageElement[] {
  return [...container.querySelectorAll("img")];
}

export function fireLoad(img: HTMLImageElement): void {
  img.dispatchEvent(new window.Event("load"));
}

export function fireError(img: HTMLImageElement): void {
  img.dispatchEvent(new window.Event("error"));
}

/** renderFrame(n), firing `load` on every <img> until the frame settles. */
export async function renderLoaded(m: Mounted, n: number): Promise<FrameResult> {
  const t = track(m.app.renderFrame(n));
  for (let i = 0; i < 200 && !t.settled(); i++) {
    for (const img of images(m.container)) fireLoad(img);
    await tick();
  }
  return t.promise;
}

/** Asserts that `promise` rejects with an error carrying `code`, and returns the error. */
export async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<Error & { code?: string }> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, `expected a rejection with ${code}, got ${String(caught)}`);
  assert.equal((caught as { code?: string }).code, code, (caught as Error).message);
  return caught as Error & { code?: string };
}

export function throwsCode(fn: () => unknown, code: string): Error & { code?: string } {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, `expected ${code} to be thrown`);
  assert.equal((caught as { code?: string }).code, code, (caught as Error).message);
  return caught as Error & { code?: string };
}

// ---- FontFace / document.fonts stubs (jsdom has neither). ----

export class FakeFontFace {
  static created: FakeFontFace[] = [];
  readonly family: string;
  readonly source: string;
  loadCalls = 0;
  private settle!: { resolve: () => void; reject: (e: unknown) => void };
  private readonly loaded: Promise<FakeFontFace>;

  constructor(family: string, source: string) {
    this.family = family;
    this.source = source;
    this.loaded = new Promise<FakeFontFace>((resolve, reject) => {
      this.settle = { resolve: () => resolve(this), reject };
    });
    FakeFontFace.created.push(this);
  }

  load(): Promise<FakeFontFace> {
    this.loadCalls++;
    return this.loaded;
  }

  finish(): void {
    this.settle.resolve();
  }

  fail(error: unknown = new Error("bad font file")): void {
    this.settle.reject(error);
  }
}

export interface FakeFontSet {
  faces: Set<FakeFontFace>;
  add(face: FakeFontFace): void;
  delete(face: FakeFontFace): boolean;
}

export function installFontStubs(): FakeFontSet {
  FakeFontFace.created = [];
  const set: FakeFontSet = {
    faces: new Set(),
    add(face) {
      this.faces.add(face);
    },
    delete(face) {
      return this.faces.delete(face);
    },
  };
  (globalThis as Record<string, unknown>).FontFace = FakeFontFace;
  Object.defineProperty(document, "fonts", { value: set, configurable: true });
  return set;
}
