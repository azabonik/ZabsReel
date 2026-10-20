/**
 * What agent-written graphic code can reach while Remotion's webpack bundles
 * it inside the core process. webpack reads through its own
 * `compiler.inputFileSystem` (graceful-fs over Node's fs), not through
 * io/gatedfs.ts, so the gates are here.
 *
 * I9: the agent's Graphic.tsx may import only `react` (and its JSX runtimes)
 * and `remotion` ({@link GraphicImportsPlugin}). Any other request from it,
 * by import, require(), import() or `new URL(…, import.meta.url)` (a
 * relative or absolute path, a `file:` or `data:` URL, another package or
 * subpath, a `loader!` prefix), and any require.context or import() of an
 * expression, is refused before it is resolved: without this, a local
 * file's content could come back in the graphic or quoted in a webpack parse
 * error, which add_graphic returns to the agent.
 *
 * G9: graphic bundling never opens a network path, approved or not
 * ({@link GateNetworkFsPlugin}). It gates
 *  (a) every module request, before webpack's scheme handling turns a
 *      `file://host/…` URL into a path ({@link graphicRequestRefusal}); this
 *      check runs before I9's;
 *  (b) the input file system itself, which the resolver (import, require,
 *      import(), require.context, new URL(…, import.meta.url)) and the loader
 *      runner read through ({@link gateInputFileSystem}), so a network path
 *      that arrives any other way (an alias, a loader's own resolve) is
 *      refused too. Its reads of file content (readFile, readJson) also refuse
 *      the private trust folder (G2's quick form, io/gatedfs.ts isTrustPath).
 * I8 (defence in depth, the same wrapper): content reads through webpack's
 * file system succeed only for the scaffold's own files and files under the
 * node_modules folders the bundle resolves from; any other fails as if the
 * file did not exist, so webpack reads nothing else even through a route the
 * I9 check does not see. Two fixed reads of bundle() do not go through
 * webpack's file system (Remotion's tsconfig.json lookup and webpack's cache;
 * render.ts names them); the agent's code cannot change their paths.
 * A graphic never needs a share, so nothing here is approvable and nothing is
 * added to the pending servers.
 */
import { isAbsolute, relative } from "node:path";
import { classifyPath } from "../unc.js";
import { fsArgPath, isTrustPath } from "../io/gatedfs.js";
import { PRODUCT_NAME } from "../brand.js";

const NAME = "GateNetworkFsPlugin";
const IMPORTS_NAME = "GraphicImportsPlugin";

/** The files a graphic's bundle may read, by the scaffold renderGraphic writes. */
export interface GraphicFiles {
  /** The agent's Graphic.tsx, as written and as its real path. */
  graphic: string[];
  /** ZedMix's own scaffold files (Root.tsx, index.ts), as written and as their real paths. */
  scaffold: string[];
  /** The node_modules folders the bundler and the graphic's imports resolve from (absolute). */
  modules: string[];
}

/** True when `p` is `dir` itself or inside it (an empty or relative `dir` holds nothing). */
function within(dir: string, p: string): boolean {
  if (!isAbsolute(dir)) return false;
  const r = relative(dir, p);
  return !r.startsWith("..") && !isAbsolute(r);
}
const sameFile = (a: string, b: string) => isAbsolute(a) && relative(a, b) === "";

/** `what` (a request or a path) quoted, at most 160 characters. */
function quoted(what: string): string {
  const shown = JSON.stringify(what);
  return shown.length > 160 ? `${shown.slice(0, 157)}…"` : shown;
}

/** The G9 refusal message for `what` (a request or a path): a network path, or (content reads) the trust folder. */
function refusal(what: string): string {
  return `graphics can't open network paths or ${PRODUCT_NAME}'s private files: ${quoted(what)}`;
}

/** What the agent's Graphic.tsx may import (I9), exactly. */
const GRAPHIC_IMPORTS: ReadonlySet<string> = new Set(["react", "react/jsx-runtime", "react/jsx-dev-runtime", "remotion"]);

/** The I9 refusal message for `request`. */
function importRefusal(request: string): string {
  return `graphics can only import 'react' and 'remotion': ${quoted(request)}`;
}

/** The I9 message when Graphic.tsx's `request` is not one of {@link GRAPHIC_IMPORTS}; else null. */
export function graphicImportRefusal(request: string): string | null {
  return GRAPHIC_IMPORTS.has(request) ? null : importRefusal(request);
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

/** The error a read of `path` gets when the file does not exist. */
function notFound(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, open ${JSON.stringify(path)}`), { code: "ENOENT", syscall: "open", path });
}

/** True when a graphic's bundle may read the content of `p` (I8). */
function readable(files: GraphicFiles, p: string): boolean {
  return [...files.graphic, ...files.scaffold].some((f) => sameFile(f, p)) || files.modules.some((d) => within(d, p));
}

/**
 * Wrap the reads of a webpack input file system in place: a path that is not
 * local (unc.ts), or for a content read a path in the trust folder, never
 * reaches the real function; the callback gets the G9 error (the `…Sync`
 * forms, and a call without a callback, throw it). With `files`, a content
 * read of any other path than {@link readable} ones gets an ENOENT error the
 * same way.
 */
export function gateInputFileSystem(fs: object, files?: GraphicFiles): void {
  const target = fs as Record<string, unknown>;
  for (const name of READS) {
    const refused = (p: unknown): Error | null => {
      const a = fsArgPath(p);
      if (!a) return files && CONTENT_READS.has(name) ? notFound(String(p)) : null;
      if (a.c.kind !== "local" || (CONTENT_READS.has(name) && isTrustPath(p))) return new Error(refusal(a.text));
      return files && CONTENT_READS.has(name) && !readable(files, a.text) ? notFound(a.text) : null;
    };
    const real = target[name];
    if (typeof real === "function") {
      target[name] = function (this: unknown, p: unknown, ...rest: unknown[]) {
        const err = refused(p);
        if (!err) return real.call(this, p, ...rest);
        const callback = rest[rest.length - 1];
        if (typeof callback === "function") process.nextTick(callback, err);
        else throw err; // no callback (a promise-style caller): fail loudly, never return undefined
      };
    }
    const realSync = target[`${name}Sync`];
    if (typeof realSync === "function") {
      target[`${name}Sync`] = function (this: unknown, p: unknown, ...rest: unknown[]) {
        const err = refused(p);
        if (err) throw err;
        return realSync.call(this, p, ...rest);
      };
    }
  }
}

interface Tappable<T> {
  tap(name: string, fn: (arg: T) => unknown): void;
}
type Factory = { hooks: { beforeResolve: Tappable<{ request?: unknown } | undefined> } };
/** The part of a webpack 5 Compiler {@link GateNetworkFsPlugin} uses. */
interface CompilerLike {
  inputFileSystem?: object | null;
  hooks: { normalModuleFactory: Tappable<Factory>; contextModuleFactory: Tappable<Factory> };
}
/** What {@link GraphicImportsPlugin} reads from a request: its issuer, or (context modules) its dependency. */
interface ResolveData {
  request?: unknown;
  contextInfo?: { issuer?: string };
  dependencies?: object[];
}
interface CompilationLike {
  moduleGraph: { getParentModule(dependency: object): { nameForCondition?(): string | null } | null | undefined };
}
/** The part of a webpack 5 Compiler {@link GraphicImportsPlugin} uses (the factories come with each compilation). */
interface ImportsCompilerLike {
  hooks: {
    compilation: { tap(name: string, fn: (c: CompilationLike, params: { normalModuleFactory: Factory; contextModuleFactory: Factory }) => void): void };
  };
}

/**
 * The G9 webpack plugin renderGraphic passes to bundle(), with the scaffold's
 * {@link GraphicFiles} for I8 (scripts/check-io-imports.mjs checks it does).
 */
export class GateNetworkFsPlugin {
  constructor(private readonly files: GraphicFiles) {}

  apply(compiler: CompilerLike): void {
    if (compiler.inputFileSystem) gateInputFileSystem(compiler.inputFileSystem, this.files);
    const check = (data: { request?: unknown } | undefined) => {
      const why = typeof data?.request === "string" ? graphicRequestRefusal(data.request) : null;
      if (why) throw new Error(why);
      return undefined; // continue (beforeResolve is a bail hook / a waterfall that keeps `data`)
    };
    compiler.hooks.normalModuleFactory.tap(NAME, (f) => f.hooks.beforeResolve.tap(NAME, check));
    compiler.hooks.contextModuleFactory.tap(NAME, (f) => f.hooks.beforeResolve.tap(NAME, check));
  }
}

/**
 * The I9 webpack plugin renderGraphic passes to bundle(), after
 * {@link GateNetworkFsPlugin} (so G9's check runs first). A request is held
 * to {@link graphicImportRefusal} when its issuer is the agent's Graphic.tsx,
 * or any module that is neither ZedMix's own scaffold nor under the
 * node_modules folders (none other exists; an issuer path in another spelling
 * stays held). A context module (require.context, an import() or a
 * `new URL(…)` built from an expression) is refused from such an issuer
 * whatever its request; one with no known issuer is refused too.
 */
export class GraphicImportsPlugin {
  constructor(private readonly files: GraphicFiles) {}

  /** True when requests from `issuer` are the agent's. */
  private held(issuer: string | null | undefined): boolean {
    if (issuer === "") return false; // an entry point (Remotion's and the scaffold's index.ts)
    if (!issuer) return true;
    if (this.files.graphic.some((f) => sameFile(f, issuer))) return true;
    return !this.files.scaffold.some((f) => sameFile(f, issuer)) && !this.files.modules.some((d) => within(d, issuer));
  }

  apply(compiler: ImportsCompilerLike): void {
    compiler.hooks.compilation.tap(IMPORTS_NAME, (compilation, { normalModuleFactory, contextModuleFactory }) => {
      normalModuleFactory.hooks.beforeResolve.tap(IMPORTS_NAME, (data) => {
        const d = data as ResolveData | undefined;
        const request = typeof d?.request === "string" ? d.request : "";
        const why = this.held(d?.contextInfo?.issuer) ? graphicImportRefusal(request) : null;
        if (why) throw new Error(why);
        return undefined;
      });
      contextModuleFactory.hooks.beforeResolve.tap(IMPORTS_NAME, (data) => {
        const d = data as ResolveData | undefined;
        const dep = d?.dependencies?.[0];
        const parent = dep ? compilation.moduleGraph.getParentModule(dep) : undefined;
        if (this.held(parent?.nameForCondition?.() ?? null)) throw new Error(importRefusal(String(d?.request ?? "")));
        return undefined;
      });
    });
  }
}
