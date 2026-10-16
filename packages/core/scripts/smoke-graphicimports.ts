/**
 * What agent-written graphic code can import and read while Remotion's
 * webpack bundles it (motion/netgate.ts I8 and I9, motion/render.ts): real
 * bundles through renderGraphic, stopped right after bundle() (no browser).
 *
 *  G1. refused   — Graphic.tsx importing a relative file, an absolute path to
 *                  a secret, a .json, a .png, a .css, another package, a
 *                  remotion subpath, require.context("/") or of the secrets'
 *                  folder, require(), an import() with an expression,
 *                  new URL(…, import.meta.url), a file:// URL, a data: URL
 *                  or a loader! prefix: the bundle
 *                  fails with the I9 message, the error holds none of the
 *                  secret's text, and nothing touches the secrets' folder
 *                  (webpack's input file system traced below the gates, and
 *                  Node's fs); require.context never lists the root folder.
 *  G2. G9 first  — a network import still gets the G9 message.
 *  G3. allowed   — react, react/jsx-runtime, react/jsx-dev-runtime and
 *                  remotion bundle (the graphic is in the bundle), and so
 *                  does the built-in title card (TITLE_CARD_TSX).
 *  G4. I8 alone  — with GraphicImportsPlugin taken out of the bundle (through
 *                  the GraphicRemotion seam renderGraphic takes; production
 *                  has no switch), an import of the secret (.txt, .json)
 *                  resolves but its content is never read, and the error
 *                  holds none of it.
 *  G5. public/   — a public/ folder in the core's working directory, or next
 *                  to a package.json above the scaffold, is not copied into
 *                  the bundle (renderGraphic passes its own empty publicDir).
 *  G6. no add-on — without AIVE_REMOTION_ADDON and without an installed
 *                  add-on, add_graphic refuses with graphics_addon_missing.
 *
 * Remotion loads from AIVE_REMOTION_ADDON (graphics-addon-env.mjs: the repo
 * root when unset).
 * No network: the only host is under .invalid, and G2 refuses it before any
 * file call. Real-render checks of allowed graphics are smoke-motion and
 * smoke-chromeguard M5 (they need Chrome).
 * Run: npx tsx packages/core/scripts/smoke-graphicimports.ts
 */
import { syncBuiltinESMExports, createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { graphicRemotion, renderGraphic, type GraphicRemotion } from "../src/motion/render.js";
import { GraphicImportsPlugin } from "../src/motion/netgate.js";
import { TITLE_CARD_TSX } from "../src/motion/templates.js";
import type { ResolvedGraphicsAddon } from "../src/addon/resolve.js";
import { EditorEngine } from "../src/engine.js";
import { dispatch, RpcError } from "../src/rpc.js";
import { useDevAddon, withoutDevAddon } from "./graphics-addon-env.mjs";

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};

const require = createRequire(import.meta.url);
const root = mkdtempSync(join(tmpdir(), "aive-graphicimports-"));
const SECRETS = join(root, "secrets");
/** In every secret file; no error, trace or bundle may hold it. */
const TOKEN = `zr-secret-${randomBytes(8).toString("hex")}`;
const secret = (name: string) => join(SECRETS, name);
/** What bundle() is stopped with once it has built the bundle. */
const BUNDLED = "smoke: bundled";
const I9 = /graphics can only import 'react' and 'remotion': /;
const G9 = /graphics can't open network paths or ZabsReel's private files: /;

// Node's fs, before Remotion (and graceful-fs, which keeps the functions it finds) loads:
// every open or read of a path in the secrets' folder.
const fsTouched: string[] = [];
{
  const fsMod = require("node:fs") as Record<string, unknown> & { promises: Record<string, unknown> };
  for (const [obj, key] of [
    [fsMod, "open"], [fsMod, "openSync"], [fsMod, "readFile"], [fsMod, "readFileSync"], [fsMod, "createReadStream"],
    [fsMod.promises, "open"], [fsMod.promises, "readFile"],
  ] as const) {
    const orig = obj[key] as (...a: unknown[]) => unknown;
    obj[key] = function (this: unknown, ...a: unknown[]) {
      if (String(a[0]).includes(SECRETS)) fsTouched.push(`${key}(${String(a[0])})`);
      return orig.apply(this, a);
    };
  }
  syncBuiltinESMExports();
}

/** webpack input file system calls that got past the gates (this plugin wraps the real ones first). */
class TracePlugin {
  constructor(readonly calls: string[]) {}
  apply(compiler: { inputFileSystem: Record<string, unknown> }) {
    const fs = compiler.inputFileSystem;
    for (const name of ["stat", "lstat", "readFile", "readdir", "readlink", "realpath", "readJson"]) {
      for (const key of [name, `${name}Sync`]) {
        const real = fs[key];
        if (typeof real !== "function") continue;
        fs[key] = (p: unknown, ...rest: unknown[]) => (this.calls.push(`${key} ${String(p)}`), (real as (...a: unknown[]) => unknown).call(fs, p, ...rest));
      }
    }
  }
}

interface Bundled {
  /** null when the bundle was built. */
  error: string | null;
  /** The input file system calls that reached the real file system. */
  calls: string[];
  /** The built bundle's folder (removed by the caller). */
  outDir?: string;
}

let remotion: GraphicRemotion;
let n = 0;
const DEV: ResolvedGraphicsAddon = { ok: true, root: useDevAddon() };

/**
 * renderGraphic of `code`, stopped after bundle(); `withImportsRule: false` takes
 * GraphicImportsPlugin out of the config renderGraphic builds (the I8 rule alone).
 */
async function bundleGraphic(code: string, o: { withImportsRule?: boolean; workDir?: string } = {}): Promise<Bundled> {
  const calls: string[] = [];
  let outDir: string | undefined;
  type Config = { plugins?: unknown[] };
  const bundle = (async (options: { webpackOverride: (c: Config) => Config | Promise<Config> }) => {
    const override = options.webpackOverride;
    outDir = await (remotion.bundle as unknown as (o: object) => Promise<string>)({
      ...options,
      onDirectoryCreated: (d: string) => (outDir = d),
      webpackOverride: async (c: Config) => {
        const conf = await override(c);
        const plugins = (conf.plugins ?? []).filter((p) => o.withImportsRule !== false || !(p instanceof GraphicImportsPlugin));
        return { ...conf, plugins: [new TracePlugin(calls), ...plugins] };
      },
    });
    throw new Error(BUNDLED);
  }) as unknown as GraphicRemotion["bundle"];
  const workDir = o.workDir ?? join(root, "work", `g${n++}`);
  let error: string | null = null;
  try {
    await renderGraphic({ code, width: 64, height: 64, fps: 30, durationInFrames: 1, alpha: false, outPath: join(workDir, "x.mp4"), workDir }, DEV, { ...remotion, bundle });
    error = "renderGraphic returned";
  } catch (err) {
    error = (err as Error).message === BUNDLED ? null : (err as Error).message;
  }
  return { error, calls, outDir };
}

const dropOut = (b: Bundled) => b.outDir && rmSync(b.outDir, { recursive: true, force: true });
/** Calls that touched the secrets' folder, or are exactly `also`. */
const touching = (calls: string[], also?: string) => calls.filter((c) => c.includes(SECRETS) || c === also);

async function main() {
  mkdirSync(SECRETS, { recursive: true });
  // Not valid JavaScript: parsed as code, webpack would quote it.
  writeFileSync(secret("secret.txt"), `${TOKEN} is the secret\n`);
  writeFileSync(secret("secret.json"), JSON.stringify({ k: TOKEN }));
  writeFileSync(secret("secret.png"), Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(TOKEN)]));
  writeFileSync(secret("secret.css"), `.a { content: "${TOKEN}"; }\n`);
  remotion = await graphicRemotion(DEV.root);
  try {
    await g1();
    await g2();
    await g3();
    await g4();
    await g5();
    await g6();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nALL GRAPHIC IMPORT CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---- G1 ------------------------------------------------------------------------
// MUTATION: drop new GraphicImportsPlugin(files) from render.ts → every row bundles or quotes
// the secret. Drop its contextModuleFactory tap → the require.context and import() rows reach
// the file system.
async function g1() {
  console.log("G1. Graphic.tsx may import only react and remotion...");
  const abs = secret("secret.txt");
  const cases: [string, string, string?][] = [
    ["a relative file", `import s from "../../secrets/secret.txt";\nexport default () => String(s);`],
    ["an absolute path", `import s from ${JSON.stringify(abs)};\nexport default () => String(s);`],
    ["a .json", `import s from ${JSON.stringify(secret("secret.json"))};\nexport default () => JSON.stringify(s);`],
    ["a .png", `import s from ${JSON.stringify(secret("secret.png"))};\nexport default () => String(s);`],
    ["a .css", `import ${JSON.stringify(secret("secret.css"))};\nexport default () => null;`],
    ["another package", `import w from "webpack";\nexport default () => String(w);`],
    ["a remotion subpath", `import { NoReactInternals } from "remotion/no-react";\nexport default () => String(NoReactInternals);`],
    ["require.context('/')", `const ctx = (require as any).context("/", true, /secret\\.txt$/);\nexport default () => String(ctx.keys());`, "readdir /"],
    ["require.context of the secrets' folder", `const ctx = (require as any).context("../../secrets", false, /secret\\.txt$/);\nexport default () => String(ctx.keys().map(ctx));`],
    ["require()", `const s = require(${JSON.stringify(abs)});\nexport default () => String(s);`],
    ["an import() with an expression", `const n = Math.random() > 2 ? "x" : "secret";\nexport default () => (void import("../../secrets/" + n + ".txt"), null);`],
    ["new URL(…, import.meta.url)", `const u = new URL("../../secrets/secret.png", import.meta.url);\nexport default () => u.href;`],
    ["a file:// URL", `import s from ${JSON.stringify(pathToFileURL(abs).href)};\nexport default () => String(s);`],
    ["a data: URL", `import d from "data:text/javascript,export default 1";\nexport default () => String(d);`],
    ["a loader! prefix", `import s from ${JSON.stringify(`!!raw-loader!${abs}`)};\nexport default () => String(s);`],
  ];
  for (const [what, code, also] of cases) {
    fsTouched.length = 0;
    const b = await bundleGraphic(code);
    dropOut(b);
    const hits = touching(b.calls, also);
    check(b.error !== null && I9.test(b.error) && !b.error.includes(TOKEN) && hits.length === 0 && fsTouched.length === 0,
      `${what}: refused with the I9 message, nothing read (${(b.error ?? "bundled").split("\n")[0].slice(0, 140)}; ${JSON.stringify([...hits, ...fsTouched].slice(0, 3))})`);
  }
}

// ---- G2 ------------------------------------------------------------------------
// MUTATION: make GateNetworkFsPlugin's request check pass everything (netgate.ts) → the I9 message
// comes instead. (The order of the two plugins in render.ts doesn't matter: G9 taps the module
// factory hook, which webpack calls before the compilation hook I9 taps.)
async function g2() {
  console.log("G2. G9's network check still runs first...");
  const b = await bundleGraphic(`import x from "//zr-evil-gi.invalid/s/x";\nexport default () => String(x);`);
  dropOut(b);
  check(b.error !== null && G9.test(b.error) && !I9.test(b.error) && !b.calls.some((c) => c.includes("zr-evil")),
    `a network import gets the G9 message (${(b.error ?? "bundled").split("\n")[0].slice(0, 140)})`);
}

// ---- G3 ------------------------------------------------------------------------
// MUTATION: take "react/jsx-runtime" out of GRAPHIC_IMPORTS (netgate.ts) → the first row fails.
// Make the content rule refuse the scaffold (readable() false for it) → both rows fail.
async function g3() {
  console.log("G3. react, its JSX runtimes and remotion still bundle...");
  const marker = `zr-allowed-${randomBytes(4).toString("hex")}`;
  const code = `import React, { useMemo } from "react";
import { jsx } from "react/jsx-runtime";
import { jsxDEV } from "react/jsx-dev-runtime";
import { AbsoluteFill, useCurrentFrame } from "remotion";
export default function Allowed() {
  const frame = useCurrentFrame();
  const label = useMemo(() => "${marker}" + frame, [frame]);
  return <AbsoluteFill>{jsx("span", { children: label })}{String(typeof jsxDEV)}{React.version}</AbsoluteFill>;
}
`;
  const b = await bundleGraphic(code);
  const js = b.outDir && existsSync(b.outDir) ? readdirSync(b.outDir).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(b.outDir!, f), "utf8")).join("\n") : "";
  dropOut(b);
  check(b.error === null && js.includes(marker), `a graphic importing react, react/jsx-runtime, react/jsx-dev-runtime and remotion bundles, and is in the bundle (${b.error?.split("\n")[0].slice(0, 160) ?? "bundled"})`);
  const t = await bundleGraphic(TITLE_CARD_TSX);
  dropOut(t);
  check(t.error === null && t.calls.some((c) => c.startsWith("readFile ") && c.endsWith("Graphic.tsx")), `the built-in title card bundles; the trace sees Graphic.tsx read (${t.error?.split("\n")[0].slice(0, 160) ?? "bundled"})`);
}

// ---- G4 ------------------------------------------------------------------------
// MUTATION: make readable() in netgate.ts true for every path → the secret is read and quoted.
async function g4() {
  console.log("G4. webpack's file system alone (the I9 rule taken out of the bundle)...");
  for (const name of ["secret.txt", "secret.json"]) {
    fsTouched.length = 0;
    const b = await bundleGraphic(`import s from ${JSON.stringify(secret(name))};\nexport default () => String(s);`, { withImportsRule: false });
    dropOut(b);
    const reads = touching(b.calls).filter((c) => /^read(File|Json)/.test(c));
    const resolved = touching(b.calls).some((c) => /^(stat|lstat|realpath)/.test(c));
    check(b.error !== null && !I9.test(b.error) && !b.error.includes(TOKEN) && reads.length === 0 && fsTouched.length === 0 && resolved,
      `${name}: resolved (the I9 rule is off), its content never read, the error holds none of it (${(b.error ?? "bundled").split("\n")[0].slice(0, 140)}; ${JSON.stringify([...reads, ...fsTouched].slice(0, 3))})`);
  }
}

// ---- G5 ------------------------------------------------------------------------
// MUTATION: drop publicDir from renderGraphic's bundle() call → both rows find the file in the bundle.
async function g5() {
  console.log("G5. a public/ folder next to the core is not copied into the bundle...");
  /** The bundle's public/ files, and whether index.html names the planted file. */
  const publicOf = (b: Bundled) => {
    const dir = b.outDir ? join(b.outDir, "public") : "";
    const files = dir && existsSync(dir) ? readdirSync(dir) : [];
    const html = b.outDir && existsSync(join(b.outDir, "index.html")) ? readFileSync(join(b.outDir, "index.html"), "utf8") : "";
    return { files, named: html.includes("zr-public") };
  };
  // The core's working directory: Remotion's root when no package.json is within 5 folders of the scaffold.
  const cwd = join(root, "cwd");
  mkdirSync(join(cwd, "public"), { recursive: true });
  writeFileSync(join(cwd, "public", "zr-public.txt"), TOKEN);
  const workDir = join(root, "w", "pub");
  let up = workDir;
  const noPackage = [0, 1, 2, 3, 4].every(() => {
    const none = !existsSync(join(up, "package.json"));
    up = dirname(up);
    return none;
  });
  const before = process.cwd();
  process.chdir(cwd);
  let b: Bundled;
  try {
    b = await bundleGraphic(TITLE_CARD_TSX, { workDir });
  } finally {
    process.chdir(before);
  }
  const p = publicOf(b);
  dropOut(b);
  check(noPackage && b.error === null && !p.files.includes("zr-public.txt") && !p.named,
    `public/ in the working directory: not in the bundle (no package.json above the scaffold: ${noPackage}; ${b.error?.split("\n")[0].slice(0, 120) ?? "bundled"}; public/ holds ${JSON.stringify(p.files)})`);
  // A package.json above the scaffold makes its folder Remotion's root.
  const proj = join(root, "proj");
  mkdirSync(join(proj, "public"), { recursive: true });
  writeFileSync(join(proj, "package.json"), "{}");
  writeFileSync(join(proj, "public", "zr-public.txt"), TOKEN);
  const q = await bundleGraphic(TITLE_CARD_TSX, { workDir: join(proj, "motion", "g") });
  const qp = publicOf(q);
  dropOut(q);
  check(q.error === null && !qp.files.includes("zr-public.txt") && !qp.named,
    `public/ next to a package.json above the scaffold: not in the bundle (${q.error?.split("\n")[0].slice(0, 120) ?? "bundled"}; public/ holds ${JSON.stringify(qp.files)})`);
}

// ---- G6 ------------------------------------------------------------------------
// MUTATION: give resolveGraphicsAddon a fallback to ZabsReel's own node_modules
// (addon/resolve.ts) → add_graphic gets past the refusal and this row fails.
async function g6() {
  console.log("G6. no add-on: add_graphic refuses with graphics_addon_missing...");
  const dataDir = mkdtempSync(join(root, "g6-data-"));
  const engine = new EditorEngine(dataDir);
  let code: string | undefined;
  await withoutDevAddon(async () => {
    try {
      await dispatch(engine, "add_graphic", { template: "title", durationSeconds: 1 });
      code = "added";
    } catch (err) {
      code = err instanceof RpcError ? err.code : (err as Error).message;
    }
  });
  check(code === "graphics_addon_missing" && !existsSync(join(dataDir, "motion")) && !existsSync(join(dataDir, "baked")),
    `without AIVE_REMOTION_ADDON and an installed add-on: graphics_addon_missing, nothing written (${code})`);
}

main().catch((err) => {
  console.error(err);
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
});
