// Asset references and media source resolution (BRIEF section 6.1).

import { describeValue, graphicError } from "./errors";
import type { AssetInfo } from "./hostTypes";

/** An opaque reference to an asset of the project library. Create it with `asset(id)`. */
export interface AssetRef {
  readonly id: string;
}

const genuineRefs = new WeakSet<object>();

const refPrototype = Object.freeze({
  toString(this: AssetRef): string {
    return `asset(${JSON.stringify(this.id)})`;
  },
});

const USE_ASSET_HINT = 'Use asset("<id>") with an id from the project library instead.';

function mediaRefError(value: unknown, where: string) {
  return graphicError(
    "graphic_media_ref",
    `${where} cannot use ${describeValue(value)}: graphics cannot load files, paths or URLs. ${USE_ASSET_HINT}`,
  );
}

export function asset(id: string): AssetRef {
  if (typeof id !== "string" || id === "") {
    throw graphicError(
      "graphic_media_ref",
      `asset() needs a non-empty asset id string, but got ${describeValue(id)}. ${USE_ASSET_HINT}`,
    );
  }
  const ref = Object.create(refPrototype, {
    id: { value: id, enumerable: true, writable: false, configurable: false },
  }) as AssetRef;
  Object.freeze(ref);
  genuineRefs.add(ref);
  return ref;
}

export function isAssetRef(value: unknown): value is AssetRef {
  return typeof value === "object" && value !== null && genuineRefs.has(value);
}

export function staticFile(path: string): never {
  throw mediaRefError(path, "staticFile()");
}

export type MediaUse = "image" | "video" | "audio";

export type ResolvedSource =
  | { kind: "asset"; id: string; info: AssetInfo }
  | { kind: "data"; url: string };

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function hasAsset(assets: Readonly<Record<string, AssetInfo>>, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(assets, id);
}

function unknownAssetError(value: unknown) {
  return graphicError(
    "graphic_asset_unknown",
    `There is no asset with the id ${describeValue(value)} in this project. ${USE_ASSET_HINT}`,
  );
}

const KIND_WORD: Record<AssetInfo["kind"], string> = {
  image: "an image",
  video: "a video",
  audio: "an audio file",
  font: "a font",
};

function checkKind(id: string, info: AssetInfo, wanted: AssetInfo["kind"], component: string) {
  if (info.kind !== wanted) {
    throw graphicError(
      "graphic_asset_kind",
      `The asset "${id}" is ${KIND_WORD[info.kind] ?? `of kind ${String(info.kind)}`}, but ${component} needs ${KIND_WORD[wanted]}. Pick an asset of the right kind from the project library.`,
    );
  }
}

/** Resolves a media `src` in the order BRIEF section 6.1 gives. Throws coded errors. */
export function resolveMediaSource(
  src: unknown,
  use: MediaUse,
  assets: Readonly<Record<string, AssetInfo>>,
  component: string,
): ResolvedSource {
  let id: string;
  if (isAssetRef(src)) {
    if (!hasAsset(assets, src.id)) throw unknownAssetError(src.id);
    id = src.id;
  } else if (typeof src === "string" && use === "image" && src.startsWith("data:")) {
    return { kind: "data", url: src };
  } else if (typeof src === "string" && hasAsset(assets, src)) {
    id = src;
  } else if (
    typeof src === "string" &&
    (URL_SCHEME.test(src) || src.includes("/") || src.includes("\\") || src.startsWith("."))
  ) {
    throw mediaRefError(src, component);
  } else {
    throw unknownAssetError(src);
  }
  const info = assets[id];
  checkKind(id, info, use, component);
  return { kind: "asset", id, info };
}

/** Resolves the first argument of loadFont(): an asset reference or a font id. */
export function resolveFontAsset(
  ref: unknown,
  assets: Readonly<Record<string, AssetInfo>>,
): { id: string; info: AssetInfo } {
  let id: string;
  if (isAssetRef(ref)) id = ref.id;
  else if (typeof ref === "string") id = ref;
  else throw unknownAssetError(ref);
  if (!hasAsset(assets, id)) throw unknownAssetError(id);
  const info = assets[id];
  checkKind(id, info, "font", "loadFont()");
  return { id, info };
}
