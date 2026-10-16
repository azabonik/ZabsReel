import nodeModule, { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Bundler from "@remotion/bundler";
import type * as Renderer from "@remotion/renderer";

/**
 * The only place that loads Remotion's runtime, and ZabsReel's same-as
 * refusal in it.
 *
 * Remotion's `downloadAsset` returns a `same-as` source unchanged, as a bare
 * relative path and without asking onDownload, and hands it to its compositor
 * (Remotion's /proxy reaches it from the page). A load hook (node:module
 * registerHooks, once per process, before Remotion is first loaded) rewrites
 * that early return into a throw, in memory only, in the two builds of
 * @remotion/renderer: the ESM build ZabsReel loads and the CommonJS one.
 * Nothing on disk is written, so a Remotion installed by the user or without
 * install scripts gets the same refusal. {@link LoadedRemotion.guard} says
 * whether the copy actually loaded carries it; renderGraphic refuses otherwise.
 * A second layer in render.ts closes the same routes without Remotion's
 * internals: renders are muted, and proxyguard.ts refuses /proxy.
 */

/** The Remotion version whose text the hook knows. */
export const REMOTION_VERSION = "4.0.481";
const MARKER = "/* zabsreel: same-as refused */";

/** One rewrite: `head`, the early return, `tail`; the early return becomes the marker and `refusal`. */
function hunk(head: string[], indent: string, refusal: string, tail: string[]) {
  return {
    before: [...head, `${indent}return src;`, ...tail].join("\n"),
    after: [...head, `${indent}${MARKER}`, `${indent}${refusal}`, ...tail].join("\n"),
  };
}

/** The files of @remotion/renderer the hook rewrites (by the end of their path), with the text of each. */
const TARGETS = [
  {
    suffix: "/@remotion/renderer/dist/assets/download-and-map-assets-to-file.js",
    ...hunk(
      [
        "const downloadAsset = async ({ src, downloadMap, indent, logLevel, shouldAnalyzeAudioImmediately, binariesDirectory, cancelSignalForAudioAnalysis, audioStreamIndex, }) => {",
        "    var _a, _b, _c;",
        "    if ((0, compress_assets_1.isAssetCompressed)(src)) {",
      ],
      "        ",
      "throw new Error('ZabsReel refuses same-as sources');",
      [
        "    }",
        "    const { downloadDir } = downloadMap;",
        "    if ((_a = downloadMap.hasBeenDownloadedMap[src]) === null || _a === void 0 ? void 0 : _a[downloadDir]) {",
      ],
    ),
  },
  {
    suffix: "/@remotion/renderer/dist/esm/index.mjs",
    ...hunk(
      ["  audioStreamIndex", "}) => {", "  if (isAssetCompressed(src)) {"],
      "    ",
      'throw new Error("ZabsReel refuses same-as sources");',
      ["  }", "  const { downloadDir } = downloadMap;", "  if (downloadMap.hasBeenDownloadedMap[src]?.[downloadDir]) {"],
    ),
  },
];
const CJS_TARGET = TARGETS[0].suffix;

/** What the hook did to each target file it loaded: rewritten, already refused (an old patched install), or no match. */
type FileState = "rewritten" | "refused" | "no-match";
const files = new Map<string, FileState>();
/** Undefined until the first load; then whether the hook is registered. */
let hooked: boolean | undefined;
const req = createRequire(import.meta.url);
const slashes = (p: string) => p.split("\\").join("/");

const count = (text: string, part: string) => text.split(part).length - 1;

/** The hook's work on one loaded target file. */
function rewrite(source: string | null, target: (typeof TARGETS)[number]): { state: FileState; source?: string } {
  if (source !== null && count(source, target.before) === 1) return { state: "rewritten", source: source.replace(target.before, () => target.after) };
  if (source !== null && count(source, target.before) === 0 && count(source, target.after) === 1) return { state: "refused" };
  return { state: "no-match" };
}

/** Register the load hook once per process; false when this Node has no module.registerHooks. */
function guardLoads(): boolean {
  if (hooked !== undefined) return hooked;
  const register = (nodeModule as { registerHooks?: typeof nodeModule.registerHooks }).registerHooks;
  if (typeof register !== "function") return (hooked = false);
  register({
    load(url, context, nextLoad) {
      const bare = url.replace(/[?#].*$/, "");
      const target = bare.startsWith("file:") ? TARGETS.find((t) => bare.endsWith(t.suffix)) : undefined;
      if (!target) return nextLoad(url, context);
      const result = nextLoad(url, context);
      const raw = result.source;
      const source = typeof raw === "string" ? raw : raw == null ? null : new TextDecoder().decode(raw);
      const done = rewrite(source, target);
      files.set(slashes(fileURLToPath(bare)), done.state);
      return done.source === undefined ? result : { ...result, source: done.source };
    },
  });
  return (hooked = true);
}

/** Why graphics are off: Node without registerHooks, Remotion loaded before the hook, or a Remotion text the hook doesn't know. */
export type RemotionGuard = { ok: true } | { ok: false; reason: "node" | "loaded-before" | "version" };

/**
 * The guard for the ESM build at `esm`: ok only when the hook is registered,
 * that build was loaded through it, and every target file loaded in this
 * process was rewritten or already refused. A CommonJS target in require's
 * cache must also carry the marker in the code that runs: one loaded before
 * the hook, or compiled from disk past it (tsx's CommonJS loader does), has
 * none.
 */
function guardStatus(esm: string): RemotionGuard {
  if (!hooked) return { ok: false, reason: "node" };
  if ([...files.values()].includes("no-match")) return { ok: false, reason: "version" };
  const cjsUnguarded = Object.entries(req.cache).some(([p, m]) => {
    if (!slashes(p).endsWith(CJS_TARGET)) return false;
    const fn = (m?.exports as { downloadAsset?: unknown } | undefined)?.downloadAsset;
    return typeof fn !== "function" || !String(fn).includes(MARKER);
  });
  if (!files.has(slashes(esm)) || cjsUnguarded) return { ok: false, reason: "loaded-before" };
  return { ok: true };
}

export interface LoadedRemotion {
  renderer: typeof Renderer;
  bundler: typeof Bundler;
  /** The node_modules folder @remotion/bundler is installed in (its imports resolve from there). */
  bundlerModules: string;
  /** The guard now (a later load of a target file can change it). */
  guard: () => RemotionGuard;
}

/** ZabsReel's own folder: Remotion resolves from here unless a caller passes another root. */
const OWN_ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Register the hook (once), then load @remotion/renderer's ESM build and
 * @remotion/bundler as resolved from `root` (a folder; node_modules is looked
 * up from it).
 */
export async function loadRemotion(root: string = OWN_ROOT): Promise<LoadedRemotion> {
  guardLoads();
  const from = createRequire(join(root, "noop.js"));
  const esm = join(dirname(from.resolve("@remotion/renderer/package.json")), "dist", "esm", "index.mjs");
  const renderer = (await import(pathToFileURL(esm).href)) as typeof Renderer;
  const bundler = from("@remotion/bundler") as typeof Bundler;
  // …/node_modules/@remotion/bundler/package.json → …/node_modules
  const bundlerModules = dirname(dirname(dirname(from.resolve("@remotion/bundler/package.json"))));
  return { renderer, bundler, bundlerModules, guard: () => guardStatus(esm) };
}
