import { lstat } from "./io/gatedfs.js";
import { join, resolve, sep } from "node:path";

/**
 * Library housekeeping rules (which assets a project still uses, which ones
 * the engine baked). Used by the storage clean-up (storage.ts: library bakes
 * no state uses leave the library) and by remove_unused_media (engine.ts).
 *
 *  - USED: an asset whose id appears as a whole string anywhere in the project
 *    outside the library itself — a clip's assetId, a motion-graphic overlay,
 *    the music bed, a bleep's sound — or in a used asset (a reversed bake's
 *    reversedFrom names its original, which reverse_clip needs to flip back;
 *    a remove_background cutout's colorAssetId names the footage its colour
 *    is read from). Field-agnostic on purpose, like the storage reference
 *    scan, so a new asset reference needs no change here. A cutout made
 *    before colorAssetId existed names its colour by path only: the assets
 *    at its colorPath are used too.
 *  - ENGINE BAKE: an asset whose file the engine wrote into <dataDir>/baked/
 *    (cutout, stabilize, reframe, freeze, reverse, smooth slow motion, motion
 *    graphic). A file the user imported from that folder is marked
 *    `userImported` at import and is never treated as a bake.
 */

/** The asset fields these rules read (structurally core's MediaAsset). */
export interface LibraryAsset {
  id: string;
  name: string;
  path: string;
  previewPath?: string;
  proxyPath?: string;
  builtinSfx?: string;
  userImported?: boolean;
  cutout?: { colorPath?: string; colorAssetId?: string };
  /** Offline (core types.ts): its files are never stat'ed. */
  awaitingServer?: string;
  pathCheckFailed?: string;
}

/** The project fields these rules read (structurally core's Project). */
export interface LibraryProject {
  assets: LibraryAsset[];
}

const WIN = process.platform === "win32";

/** `p` resolved, and lowercased on Windows: the form two paths are compared in. */
export function normPath(p: string): string {
  const r = resolve(p);
  return WIN ? r.toLowerCase() : r;
}

/**
 * Every string value (and object key) in a JSON-like value, the way
 * JSON.stringify would see it. The one reference scan both the library rules
 * here and the storage clean-up (storage.ts) use.
 */
export function collectStrings(value: unknown, out: Set<string>, seen: Set<object> = new Set()): void {
  if (typeof value === "string") {
    out.add(value);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, seen);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    out.add(k);
    collectStrings(v, out, seen);
  }
}

/** True when the engine baked this asset into <dataDir>/baked/ (and the user didn't import it from there). */
export function isEngineBake(asset: LibraryAsset, dataDir: string): boolean {
  if (asset.userImported || typeof asset.path !== "string") return false;
  return normPath(asset.path).startsWith(normPath(join(dataDir, "baked")) + sep);
}

/** Ids of the library assets `project` uses (see the rules above). */
export function usedAssetIds(project: LibraryProject): Set<string> {
  const assets = Array.isArray(project.assets) ? project.assets : [];
  const byId = new Map(assets.map((a) => [a.id, a] as const));
  const rest = new Set<string>();
  collectStrings({ ...(project as object), assets: undefined }, rest);
  const used = new Set<string>();
  const queue: string[] = [];
  for (const id of byId.keys()) {
    if (rest.has(id)) {
      used.add(id);
      queue.push(id);
    }
  }
  // A used asset can name another one (reversedFrom, cutout.colorAssetId): that one is used too.
  while (queue.length) {
    const a = byId.get(queue.pop()!)!;
    const inner = new Set<string>();
    collectStrings({ ...a, id: undefined }, inner);
    const colorPath = typeof a.cutout?.colorPath === "string" ? normPath(a.cutout.colorPath) : undefined;
    for (const [id, b] of byId) {
      if (used.has(id)) continue;
      if (inner.has(id) || (colorPath !== undefined && typeof b.path === "string" && normPath(b.path) === colorPath)) {
        used.add(id);
        queue.push(id);
      }
    }
  }
  return used;
}

/** Engine bakes in `project`'s library that nothing in `project` uses (a deleted clip, a reversed clip flipped back). */
export function unusedLibraryBakes(project: LibraryProject, dataDir: string): LibraryAsset[] {
  const assets = Array.isArray(project.assets) ? project.assets : [];
  const bakes = assets.filter((a) => isEngineBake(a, dataDir));
  if (!bakes.length) return [];
  const used = usedAssetIds(project);
  return bakes.filter((a) => !used.has(a.id));
}

/**
 * The library bakes to drop automatically: unused in the open project AND in
 * every undo/redo state (an undo that brings their clip back carries the
 * asset in its own snapshot, so nothing is lost).
 */
export function prunableLibraryBakes(open: LibraryProject, history: readonly LibraryProject[], dataDir: string): LibraryAsset[] {
  const candidates = unusedLibraryBakes(open, dataDir);
  if (!candidates.length) return [];
  const ids = new Set(candidates.map((a) => a.id));
  for (const state of history) {
    if (!state || !Array.isArray(state.assets) || !state.assets.some((a) => ids.has(a.id))) continue;
    for (const id of usedAssetIds(state)) ids.delete(id);
    if (!ids.size) return [];
  }
  return candidates.filter((a) => ids.has(a.id));
}

/**
 * Assets nothing in `project` uses, split into what ZedMix generated (bakes
 * and built-in bleep sounds: made again on demand) and what the user imported.
 */
export function unusedAssets(project: LibraryProject, dataDir: string): { generated: LibraryAsset[]; imported: LibraryAsset[] } {
  const used = usedAssetIds(project);
  const generated: LibraryAsset[] = [];
  const imported: LibraryAsset[] = [];
  for (const a of Array.isArray(project.assets) ? project.assets : []) {
    if (used.has(a.id)) continue;
    if (isEngineBake(a, dataDir) || a.builtinSfx) generated.push(a);
    else imported.push(a);
  }
  return { generated, imported };
}

/** Bytes of an asset's files (its path plus preview/proxy files); 0 for what can't be read. */
export async function assetFileBytes(a: { path: string; previewPath?: string; proxyPath?: string }): Promise<number> {
  let n = 0;
  for (const p of new Set([a.path, a.previewPath, a.proxyPath].filter((x): x is string => !!x))) {
    try {
      const st = await lstat(p);
      if (st.isFile()) n += st.size;
    } catch {
      /* gone, or in the storage trash */
    }
  }
  return n;
}
