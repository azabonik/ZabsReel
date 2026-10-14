/**
 * G9: graphic bundling never opens a network path, approved or not.
 *
 * add_graphic bundles agent-written TSX with Remotion's webpack inside the
 * core process. webpack reads through its own `compiler.inputFileSystem`
 * (graceful-fs over Node's fs), not through io/gatedfs.ts, so this plugin
 * gates it in two places:
 *  (a) every module request, before webpack's scheme handling turns a
 *      `file://host/…` URL into a path ({@link graphicRequestRefusal});
 *  (b) the input file system itself, which the resolver (import, require,
 *      import(), require.context, new URL(…, import.meta.url)) and the loader
 *      runner read through ({@link gateInputFileSystem}), so a network path
 *      that arrives any other way (an alias, a loader's own resolve) is
 *      refused too. Its reads of file content (readFile, readJson) also refuse
 *      the private trust folder (G2's quick form, io/gatedfs.ts isTrustPath),
 *      so agent TSX can't import the stamp key and get it back in a parse
 *      error.
 * A graphic never needs a share, so nothing here is approvable and nothing is
 * added to the pending servers.
 */
import { classifyPath } from "../unc.js";
import { fsArgPath, isTrustPath } from "../io/gatedfs.js";

const NAME = "GateNetworkFsPlugin";

/** The refusal message for `what` (a request or a path). */
function refusal(what: string): string {
  const shown = JSON.stringify(what);
  return `graphics can only import local files and installed packages: ${shown.length > 160 ? `${shown.slice(0, 157)}…"` : shown}`;
}

/** True when one `!`-separated part of a request names only a local file or a package. */
function localPart(part: string): boolean {
  if (classifyPath(part).kind !== "local") return false;
  if (!/^file:/i.test(part)) return true;
  let url: URL;
  try {
    url = new URL(part);
  } catch {
    return false;
  }
  // `file://localhost/…` parses with an empty host; any other host is a server.
  if (url.hostname !== "") return false;
  try {
    // `file:///%5C%5Chost/x` decodes to `/\\host/x`.
    return classifyPath(decodeURIComponent(url.pathname)).kind === "local";
  } catch {
    return false;
  }
}

/**
 * The G9 message when a module request (with any `loader!` prefixes) names a
 * network, device or NT path, or a `file:` URL with a host; else null.
 */
export function graphicRequestRefusal(request: string): string | null {
  for (const raw of request.split("!")) {
    // Checked with and without its ?query / #fragment: `\??\…` must not shrink to `\`.
    const part = raw.replace(/[?#][^]*$/, "");
    if (!localPart(raw) || !localPart(part)) return refusal(request);
  }
  return null;
}

/** The input file system's reads that take a path first. */
const READS = ["stat", "lstat", "readFile", "readdir", "readlink", "realpath", "readJson"] as const;
/** The ones that return a file's content: they refuse the trust folder too. */
const CONTENT_READS: ReadonlySet<string> = new Set(["readFile", "readJson"]);

/**
 * Wrap the reads of a webpack input file system in place: a path that is not
 * local (unc.ts), or for a content read a path in the trust folder, never
 * reaches the real function; the callback gets the G9 error (the `…Sync`
 * forms, and a call without a callback, throw it).
 */
export function gateInputFileSystem(fs: object): void {
  const target = fs as Record<string, unknown>;
  for (const name of READS) {
    const notLocal = (p: unknown) => {
      const a = fsArgPath(p);
      if (!a) return null;
      return a.c.kind !== "local" || (CONTENT_READS.has(name) && isTrustPath(p)) ? refusal(a.text) : null;
    };
    const real = target[name];
    if (typeof real === "function") {
      target[name] = function (this: unknown, p: unknown, ...rest: unknown[]) {
        const why = notLocal(p);
        if (!why) return real.call(this, p, ...rest);
        const callback = rest[rest.length - 1];
        if (typeof callback === "function") process.nextTick(callback, new Error(why));
        else throw new Error(why); // no callback (a promise-style caller): fail loudly, never return undefined
      };
    }
    const realSync = target[`${name}Sync`];
    if (typeof realSync === "function") {
      target[`${name}Sync`] = function (this: unknown, p: unknown, ...rest: unknown[]) {
        const why = notLocal(p);
        if (why) throw new Error(why);
        return realSync.call(this, p, ...rest);
      };
    }
  }
}

interface Tappable<T> {
  tap(name: string, fn: (arg: T) => unknown): void;
}
type Factory = { hooks: { beforeResolve: Tappable<{ request?: unknown } | undefined> } };
/** The part of a webpack 5 Compiler this plugin uses. */
interface CompilerLike {
  inputFileSystem?: object | null;
  hooks: { normalModuleFactory: Tappable<Factory>; contextModuleFactory: Tappable<Factory> };
}

/** The webpack plugin renderGraphic passes to bundle() (scripts/check-io-imports.mjs checks it does). */
export class GateNetworkFsPlugin {
  apply(compiler: CompilerLike): void {
    if (compiler.inputFileSystem) gateInputFileSystem(compiler.inputFileSystem);
    const check = (data: { request?: unknown } | undefined) => {
      const why = typeof data?.request === "string" ? graphicRequestRefusal(data.request) : null;
      if (why) throw new Error(why);
      return undefined; // continue (beforeResolve is a bail hook / a waterfall that keeps `data`)
    };
    compiler.hooks.normalModuleFactory.tap(NAME, (f) => f.hooks.beforeResolve.tap(NAME, check));
    compiler.hooks.contextModuleFactory.tap(NAME, (f) => f.hooks.beforeResolve.tap(NAME, check));
  }
}
