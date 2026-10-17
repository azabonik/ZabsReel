import { createRequire } from "node:module";
import { Script } from "node:vm";
import { transform } from "sucrase";
import { PRODUCT_NAME } from "../brand.js";
import type { PageAsset } from "./motionmedia.js";

/**
 * The graphic as ZabsReel's own renderer runs it (MOTION-PLAN D5): the agent's
 * TSX compiled in memory by sucrase (typescript, jsx, imports) into module.js,
 * the render page's last script, which hands host.js the render's start data
 * and the compiled code as one function:
 *
 *   __zrMotionGraphic(start, function (require, exports, module) { ... });
 *
 * Before the renderer starts, the graphic's imports are read with sucrase's
 * own parser (so strings, comments, JSX text and regular expressions never
 * look like one) and refused with graphic_api_unsupported when they name
 * anything but react, react/jsx-runtime, react/jsx-dev-runtime, remotion and
 * @aive/motion (an import, an `export … from`, `import x = require(…)` or a
 * require("…") call), when they use import() or import.meta (a page script has
 * neither), or when they take a name from remotion or @aive/motion that the
 * runtime does not export (runtime/exports.json; a default import is the name
 * "default"). Type-only imports are erased by the compile and not checked.
 * The compiled module.js is then parsed (never run) so a syntax error is
 * graphic_compile_error here and not an empty graphic in the page.
 */

/** What a graphic may import (the page's require table, loader.js, also has react-dom for the runtime itself). */
export const GRAPHIC_SPECIFIERS: ReadonlySet<string> = new Set(["react", "react/jsx-runtime", "react/jsx-dev-runtime", "remotion", "@aive/motion"]);
/** The specifiers whose names are checked against the runtime's export list. */
const RUNTIME_SPECIFIERS: ReadonlySet<string> = new Set(["remotion", "@aive/motion"]);

/** The start data host.js builds the runtime's MotionHost from. */
export interface GraphicStart {
  composition: { id: "Graphic"; width: number; height: number; fps: number; durationInFrames: number; props: Record<string, unknown> };
  /** asset id -> { handle, kind, sizes }; no path, name or folder (motionmedia.ts). */
  assets: Record<string, PageAsset>;
  /** The runtime's own per-frame deadline. */
  frameTimeoutMs: number;
}

export type GraphicModule = { ok: true; module: string } | { ok: false; code: "graphic_api_unsupported" | "graphic_compile_error"; message: string };

/**
 * The runtime's message for a name it does not export (its errors.ts, word
 * for word, so the agent reads the same text whichever side refuses it).
 */
export function unsupportedNameMessage(name: string): string {
  return `${name} is not available in ZabsReel's built-in graphics renderer. Use the names listed in the graphics guide, or switch Settings → Graphics renderer to the Remotion add-on.`;
}

/** The refusal for a specifier outside {@link GRAPHIC_SPECIFIERS} (loader.js throws the same text in the page). */
function specifierMessage(spec: string): string {
  return `A graphic can import only react, react/jsx-runtime, remotion and @aive/motion, not ${JSON.stringify(spec)}. Write the code in the graphic itself and pass data in as props.`;
}

/** sucrase's parser, from its own files: sucrase is pinned to 3.35.0 exactly and has no exports map. */
interface Token {
  type: number;
  contextualKeyword: number;
  start: number;
  end: number;
  isType: boolean;
}
interface Parser {
  parse(input: string, jsx: boolean, typescript: boolean, flow: boolean): { tokens: Token[] };
  tt: Record<string, number>;
  kw: Record<string, number>;
}
let parser: Parser | null = null;
function sucraseParser(): Parser {
  if (!parser) {
    const load = createRequire(import.meta.url);
    parser = {
      parse: (load("sucrase/dist/parser") as Pick<Parser, "parse">).parse,
      tt: (load("sucrase/dist/parser/tokenizer/types") as { TokenType: Record<string, number> }).TokenType,
      kw: (load("sucrase/dist/parser/tokenizer/keywords") as { ContextualKeyword: Record<string, number> }).ContextualKeyword,
    };
  }
  return parser;
}

/**
 * The first problem with the imports of `source` (TSX), or null. A source
 * sucrase cannot parse throws (its SyntaxError).
 */
export function graphicImportRefusal(source: string, exportNames: ReadonlySet<string>): string | null {
  const { parse, tt, kw } = sucraseParser();
  const toks = parse(source, true, true, false).tokens;
  const raw = (t: Token | undefined) => (t ? source.slice(t.start, t.end) : "");
  const is = (t: Token | undefined, type: number, ck?: number) => !!t && t.type === type && (ck === undefined || t.contextualKeyword === ck);
  // A string token's text without its quotes (an escape stays as written, so it matches nothing allowed).
  const str = (t: Token) => raw(t).slice(1, -1);

  /** The problem with `spec` and the names taken from it (null: a namespace or side-effect import). */
  const check = (spec: string, names: string[]): string | null => {
    if (!GRAPHIC_SPECIFIERS.has(spec)) return specifierMessage(spec);
    if (!RUNTIME_SPECIFIERS.has(spec)) return null;
    const bad = names.find((n) => !exportNames.has(n));
    return bad === undefined ? null : unsupportedNameMessage(bad);
  };
  /** The imported names in braces from toks[open] (a `{`) to its `}`: the first token of each comma group, unless it is `type …`. */
  const braced = (open: number): { names: string[]; close: number } => {
    const names: string[] = [];
    let k = open + 1;
    let first = true;
    for (; k < toks.length && !is(toks[k], tt.braceR) && !is(toks[k], tt.eof); k++) {
      if (is(toks[k], tt.comma)) first = true;
      else if (first) {
        first = false;
        // A string name (`{ "a-b" as x }`) comes as a name token with its quotes.
        if (!toks[k].isType) names.push(/^["']/.test(raw(toks[k])) ? str(toks[k]) : raw(toks[k]));
      }
    }
    return { names, close: k };
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const next = toks[i + 1];
    if (is(t, tt.name) && raw(t) === "import" && is(next, tt.dot)) return `A graphic can't use import.meta: ${PRODUCT_NAME}'s renderer runs it as a page script.`;
    if (is(t, tt._import) && is(next, tt.parenL)) return "A graphic can't load code with import(). Import what it needs from react or remotion at the top of the file.";
    if (is(t, tt.name) && raw(t) === "require" && is(next, tt.parenL) && !is(toks[i - 1], tt.dot) && !is(toks[i - 1], tt.questionDot)) {
      if (is(toks[i + 2], tt.string) && is(toks[i + 3], tt.parenR)) {
        const problem = check(str(toks[i + 2]), []);
        if (problem) return problem;
      }
      continue;
    }
    if (is(t, tt._import)) {
      // `import type …` (but not a default import named "type": `import type from "x"`).
      let j = i + 1;
      const typeOnly = is(toks[j], tt.name, kw._type) && !is(toks[j + 1], tt.name, kw._from) && !is(toks[j + 1], tt.comma);
      if (typeOnly) j++;
      // The clause runs to the source string outside braces; `=` is `import x = require(…)` (its require is checked above).
      const names: string[] = [];
      let k = j;
      let equals = false;
      for (; k < toks.length; k++) {
        const c = toks[k];
        if (is(c, tt.string) || is(c, tt.semi) || is(c, tt.eof)) break;
        if (is(c, tt.eq)) {
          equals = true;
          break;
        }
        if (is(c, tt.braceL)) k = braced(k).close;
        else if (is(c, tt.star)) k += 2; // `* as N`: names are read at run time
        else if (is(c, tt.name) && !is(c, tt.name, kw._from)) names.push("default");
      }
      if (equals || typeOnly || !is(toks[k], tt.string)) continue;
      for (let b = j; b < k; b++) if (is(toks[b], tt.braceL)) names.push(...braced(b).names);
      const problem = check(str(toks[k]), names);
      if (problem) return problem;
      i = k;
      continue;
    }
    if (is(t, tt._export)) {
      // `export { … } from "x"`, `export * from "x"`, `export * as N from "x"`; `export type { … } from` is erased.
      let j = i + 1;
      if (is(toks[j], tt.name, kw._type) && (is(toks[j + 1], tt.braceL) || is(toks[j + 1], tt.star))) continue;
      let names: string[] = [];
      let end: number;
      if (is(toks[j], tt.braceL)) {
        const b = braced(j);
        names = b.names;
        end = b.close;
      } else if (is(toks[j], tt.star)) {
        end = is(toks[j + 1], tt.name, kw._from) ? j : j + 2;
      } else continue;
      j = end + 1;
      if (is(toks[j], tt.name, kw._from) && is(toks[j + 1], tt.string)) {
        const problem = check(str(toks[j + 1]), names);
        if (problem) return problem;
        i = j + 1;
      }
    }
  }
  return null;
}

/**
 * module.js for `source` (TSX that default-exports a React component) with
 * `start`, or the problem that refuses it. `exportNames` is the runtime's
 * export list (runtime/exports.json).
 */
export function graphicModule(source: string, start: GraphicStart, exportNames: ReadonlySet<string>): GraphicModule {
  let code: string;
  try {
    const refusal = graphicImportRefusal(source, exportNames);
    if (refusal) return { ok: false, code: "graphic_api_unsupported", message: refusal };
    // Automatic JSX: a graphic need not import React (loader.js has the jsx-runtime shim).
    code = transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic", production: true }).code;
  } catch (err) {
    return { ok: false, code: "graphic_compile_error", message: `The graphic's code does not compile: ${(err as Error).message}` };
  }
  const module = `// The graphic, compiled by ${PRODUCT_NAME}'s core (graphicmodule.ts) for host.js.\n__zrMotionGraphic(${JSON.stringify(start)}, function (require, exports, module) {\n${code}\n});\n`;
  try {
    // Parsed only, never run: top-level await or a stray `}` would otherwise only show in the page.
    new Script(module, { filename: "module.js" });
  } catch (err) {
    return { ok: false, code: "graphic_compile_error", message: `The graphic's code does not compile: ${(err as Error).message}` };
  }
  return { ok: true, module };
}
