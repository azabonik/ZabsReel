/**
 * Smoke test: the brand source of truth and the data-dir resolver.
 *  1. Constants: packages/core/src/brand.ts, its CommonJS twin
 *     apps/desktop/electron/brand.cjs and the installer's
 *     packages/skill-installer/bin/brand.mjs export the same names with the
 *     same values (and the values the rename settled on).
 *  2. Resolver cases, through the ESM resolver (src/datadir.ts) and the CJS one
 *     (brand.cjs), with a temporary HOME: both return the same dir and reason.
 *     AIVE_DATA_DIR wins and is made absolute (an empty one counts as unset);
 *     no folder -> new, "default"; empty new + populated old -> old, "legacy";
 *     both populated -> new, "new (old folder also has data: <old>)";
 *     populated new alone -> new, "new"; server.json alone and projects.json
 *     alone each count; a directory named server.json or projects.json does not.
 *  3. The desktop launcher (core-launcher.cjs getDataDir) and the MCP server
 *     (core-client.ts getDataDir) agree: old folder populated and new absent,
 *     then new present but empty, then new populated.
 *  4. A core started from src/cli.ts with AIVE_DATA_DIR=<home>/.zabsreel/data
 *     logs that choice; with an empty <home>/.zedmix/data next to it, an MCP
 *     client started with that HOME and no AIVE_DATA_DIR attaches to that core
 *     (same pid and port as the old server.json) and spawns no second one.
 *  5. A core started with a fresh HOME and no AIVE_DATA_DIR resolves the new
 *     folder ("default") and publishes server.json there.
 *  6. With --packaged <resources/app dir>: electron/brand.cjs and
 *     node_modules/@aive/core/dist/brand.js from a packed tree equal the source
 *     constants, and both packed resolvers (brand.cjs, which the launcher uses,
 *     and @aive/core/dist/datadir.js, which the MCP server and core use) pass
 *     the resolver cases.
 *
 * Run: npx tsx packages/core/scripts/smoke-brand.ts [--packaged <resources/app dir>]
 * (Temp dirs only; every resolver call gets an explicit HOME; cores use ports 5031-5033.)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import * as brand from "../src/brand.js";
import { holdsState, resolveDataDir } from "../src/datadir.js";
import { CoreClient, getDataDir as mcpGetDataDir } from "../../mcp/src/core-client.ts";

type Resolved = { dir: string; reason: string };
type ResolveOpts = { env?: Record<string, string | undefined>; home?: string };
interface CjsBrand extends Record<string, unknown> {
  holdsState(dir: string): boolean;
  resolveDataDir(opts?: ResolveOpts): Resolved;
}

const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const CORE_CLI = join(ROOT, "packages", "core", "src", "cli.ts");
const TSX_LOADER = pathToFileURL(require.resolve("tsx")).href;
const cjsBrand = require(join(ROOT, "apps", "desktop", "electron", "brand.cjs")) as CjsBrand;
const launcher = require(join(ROOT, "apps", "desktop", "electron", "core-launcher.cjs")) as { getDataDir(opts?: ResolveOpts): string };

/** The constants the rename settled on (plan §1-§2); every copy must hold exactly these. */
const EXPECTED: Record<string, unknown> = {
  PRODUCT_NAME: "ZedMix",
  PRODUCT_ID: "zedmix",
  MCP_KEY: "zedmix",
  SKILL_NAME: "zedmix-editor",
  APP_ID: "io.github.azabonik.zedmix",
  APP_ID_DEV: "io.github.azabonik.zedmix.dev",
  DESKTOP_PACKAGE: "zedmix-desktop",
  GITHUB_REPO: "azabonik/ZedMix",
  DATA_DIR_PARTS: [".zedmix", "data"],
  BACKUP_DIR_PARTS: [".zedmix", "backups"],
  LEGACY: {
    productName: "ZabsReel",
    id: "zabsreel",
    mcpKey: "zabsreel",
    skillName: "zabsreel-editor",
    desktopPackage: "zabsreel-desktop",
    dataDirParts: [".zabsreel", "data"],
  },
};

let failures = 0;
function check(ok: boolean, msg: string, detail?: unknown) {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}${!ok && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The non-function exports of a module namespace or object, as a plain object. */
function constantsOf(mod: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(mod).filter(([, v]) => typeof v !== "function"));
}

/** One copy's constants: the same names as the source and the settled values. */
function checkConstants(label: string, mod: Record<string, unknown>) {
  const got = constantsOf(mod);
  const names = Object.keys(got).sort();
  check(isDeepStrictEqual(names, Object.keys(EXPECTED).sort()), `${label}: exports exactly the brand constants`, names);
  for (const [name, value] of Object.entries(EXPECTED)) {
    // JSON round trip: `as const` arrays and plain arrays compare by value.
    check(isDeepStrictEqual(JSON.parse(JSON.stringify(got[name] ?? null)), value), `${label}: ${name}`, got[name]);
  }
}

/** Write a file a core would write, making its folder. */
function put(dir: string, name: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "{}\n");
}

/** A fresh, empty temp HOME. */
function freshHome(root: string, name: string): { home: string; fresh: string; old: string } {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  return { home, fresh: join(home, ".zedmix", "data"), old: join(home, ".zabsreel", "data") };
}

interface ResolverCase {
  name: string;
  setup(h: { home: string; fresh: string; old: string }): void;
  env?: (h: { home: string; fresh: string; old: string }) => Record<string, string | undefined>;
  expect(h: { home: string; fresh: string; old: string }): Resolved;
}

const CASES: ResolverCase[] = [
  {
    name: "AIVE_DATA_DIR set (relative): wins over populated folders, made absolute",
    setup: (h) => { put(h.fresh, "server.json"); put(h.old, "server.json"); },
    env: (h) => ({ AIVE_DATA_DIR: join(h.home, "custom", "..", "custom", "data") }),
    expect: (h) => ({ dir: join(h.home, "custom", "data"), reason: "AIVE_DATA_DIR" }),
  },
  {
    name: "AIVE_DATA_DIR relative to the working directory",
    setup: () => {},
    env: () => ({ AIVE_DATA_DIR: "rel-data" }),
    expect: () => ({ dir: resolve("rel-data"), reason: "AIVE_DATA_DIR" }),
  },
  {
    name: "empty AIVE_DATA_DIR counts as unset",
    setup: (h) => put(h.old, "projects.json"),
    env: () => ({ AIVE_DATA_DIR: "" }),
    expect: (h) => ({ dir: h.old, reason: "legacy" }),
  },
  {
    name: "neither folder exists: new, default",
    setup: () => {},
    expect: (h) => ({ dir: h.fresh, reason: "default" }),
  },
  {
    name: "empty new + populated old: old, legacy",
    setup: (h) => { mkdirSync(h.fresh, { recursive: true }); put(h.old, "server.json"); put(h.old, "projects.json"); },
    expect: (h) => ({ dir: h.old, reason: "legacy" }),
  },
  {
    name: "populated new + populated old: new, with the old folder named",
    setup: (h) => { put(h.fresh, "server.json"); put(h.old, "server.json"); },
    expect: (h) => ({ dir: h.fresh, reason: `new (old folder also has data: ${h.old})` }),
  },
  {
    name: "populated new + no old: new",
    setup: (h) => put(h.fresh, "projects.json"),
    expect: (h) => ({ dir: h.fresh, reason: "new" }),
  },
  {
    name: "only server.json counts (old)",
    setup: (h) => put(h.old, "server.json"),
    expect: (h) => ({ dir: h.old, reason: "legacy" }),
  },
  {
    name: "only projects.json counts (old)",
    setup: (h) => put(h.old, "projects.json"),
    expect: (h) => ({ dir: h.old, reason: "legacy" }),
  },
  {
    name: "only projects.json counts (new, old has server.json)",
    setup: (h) => { put(h.fresh, "projects.json"); put(h.old, "server.json"); },
    expect: (h) => ({ dir: h.fresh, reason: `new (old folder also has data: ${h.old})` }),
  },
  {
    name: "a directory named server.json does not count",
    setup: (h) => { mkdirSync(join(h.old, "server.json"), { recursive: true }); mkdirSync(join(h.fresh, "server.json"), { recursive: true }); },
    expect: (h) => ({ dir: h.fresh, reason: "default" }),
  },
  {
    name: "a directory named projects.json does not count",
    setup: (h) => { mkdirSync(join(h.old, "projects.json"), { recursive: true }); put(h.old, "notes.json"); },
    expect: (h) => ({ dir: h.fresh, reason: "default" }),
  },
  {
    name: "other files do not count",
    setup: (h) => { put(h.fresh, "settings.json"); mkdirSync(join(h.fresh, "baked"), { recursive: true }); put(h.old, "server.json"); },
    expect: (h) => ({ dir: h.old, reason: "legacy" }),
  },
];

/** Run every resolver case through the ESM resolver and the given CJS copies. */
function runResolverCases(root: string, cjs: Array<[string, CjsBrand]>) {
  CASES.forEach((c, i) => {
    const h = freshHome(root, `case-${i}`);
    c.setup(h);
    const env = c.env?.(h) ?? {};
    const want = c.expect(h);
    const esm = resolveDataDir({ env, home: h.home });
    check(isDeepStrictEqual(esm, want), `ESM: ${c.name}`, esm);
    for (const [label, mod] of cjs) {
      const got = mod.resolveDataDir({ env, home: h.home });
      check(isDeepStrictEqual(got, want), `${label}: ${c.name}`, got);
    }
  });
  // holdsState itself, both copies: a regular file only.
  const h = freshHome(root, "holds");
  mkdirSync(join(h.fresh, "server.json"), { recursive: true });
  put(h.old, "projects.json");
  for (const [label, hs] of [["ESM", holdsState], ...cjs.map(([l, m]) => [l, m.holdsState] as const)] as const) {
    check(hs(h.old) && !hs(h.fresh) && !hs(join(h.home, "missing")), `${label}: holdsState is true only for a folder with a regular server.json/projects.json`);
  }
}

/** Spawn a TypeScript entry point under the tsx loader, collecting its output. */
function spawnTs(file: string, args: string[], env: Record<string, string | undefined>) {
  const child = spawn(process.execPath, ["--import", TSX_LOADER, file, ...args], {
    cwd: ROOT,
    env: env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = { stdout: "", stderr: "" };
  child.stdout!.on("data", (d: Buffer) => (out.stdout += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (out.stderr += d.toString()));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  return { child, out, exited };
}

/** The environment for a child: the given HOME and none of the core/MCP overrides. */
function childEnv(home: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") };
  for (const k of ["AIVE_DATA_DIR", "AIVE_CORE_URL", "AIVE_CORE_TOKEN", "AIVE_PORT"]) delete env[k];
  return { ...env, ...extra };
}

/** Start a core from src/cli.ts and wait for its "ready" line. */
async function startCore(home: string, extra: Record<string, string>) {
  const run = spawnTs(CORE_CLI, [], childEnv(home, extra));
  for (let i = 0; i < 240; i++) {
    const line = run.out.stdout.split("\n").find((l) => l.includes('"event":"ready"'));
    if (line) return { ...run, ready: JSON.parse(line) as { port: number; dataDir: string } };
    if (run.child.exitCode !== null) break;
    await sleep(250);
  }
  throw new Error(`core did not report ready:\n${run.out.stderr}`);
}

/** Stop a process by its pid and wait for it to exit. */
async function stop(run: { child: ChildProcess; exited: Promise<number | null> }) {
  if (run.child.exitCode === null && run.child.pid) process.kill(run.child.pid, "SIGTERM");
  await Promise.race([run.exited, sleep(10000)]);
  if (run.child.exitCode === null && run.child.signalCode === null && run.child.pid) process.kill(run.child.pid, "SIGKILL");
}

/**
 * Child mode for part 4: the MCP server's connection logic, with this
 * process's HOME and env. Prints what it connected to on stdout.
 */
async function attachProbe(): Promise<void> {
  const client = new CoreClient();
  const url = await client.connect();
  console.log(JSON.stringify({ url, dataDir: mcpGetDataDir() }));
  client.dispose();
  process.exit(0);
}

async function main() {
  const packagedAt = process.argv.indexOf("--packaged");
  const packaged = packagedAt >= 0 ? process.argv[packagedAt + 1] : undefined;
  if (packagedAt >= 0 && !packaged) throw new Error("usage: smoke-brand.ts [--packaged <resources/app dir>]");
  const root = mkdtempSync(join(tmpdir(), "zedmix-brand-"));

  console.log("1. brand constants in all three copies...");
  checkConstants("brand.ts", brand as unknown as Record<string, unknown>);
  checkConstants("brand.cjs", cjsBrand);
  const installer = (await import(pathToFileURL(join(ROOT, "packages", "skill-installer", "bin", "brand.mjs")).href)) as Record<string, unknown>;
  checkConstants("installer brand.mjs", installer);

  console.log("2. resolver cases (ESM and CJS)...");
  runResolverCases(join(root, "resolver"), [["CJS", cjsBrand]]);

  console.log("3. launcher and MCP server agree...");
  {
    const h = freshHome(root, "agree");
    const opts = { env: {}, home: h.home };
    put(h.old, "server.json");
    const a1 = [launcher.getDataDir(opts), mcpGetDataDir(opts)];
    check(a1[0] === h.old && a1[1] === h.old, "old folder populated, new absent: both use the old folder", a1);
    mkdirSync(h.fresh, { recursive: true });
    const a2 = [launcher.getDataDir(opts), mcpGetDataDir(opts)];
    check(a2[0] === h.old && a2[1] === h.old, "new folder present but empty: both still use the old folder", a2);
    put(h.fresh, "projects.json");
    const a3 = [launcher.getDataDir(opts), mcpGetDataDir(opts)];
    check(a3[0] === h.fresh && a3[1] === h.fresh, "new folder populated: both use the new folder", a3);
  }

  console.log("4. a core on the old folder; a new MCP client attaches to it...");
  {
    const h = freshHome(root, "oldcore");
    mkdirSync(h.old, { recursive: true });
    const core = await startCore(h.home, { AIVE_DATA_DIR: h.old, AIVE_PORT: "5031" });
    try {
      check(core.out.stderr.includes(`[aive-core] data dir: ${h.old} (AIVE_DATA_DIR)\n`), "the core logs its data dir and why", core.out.stderr);
      const before = readFileSync(join(h.old, "server.json"), "utf8");
      const info = JSON.parse(before) as { pid: number; port: number };
      check(info.pid === core.child.pid && info.port === core.ready.port, "server.json in the old folder names this core", info);
      mkdirSync(h.fresh, { recursive: true });
      // AIVE_PORT only matters if the client wrongly spawns a core: keep it off the real 4791.
      const probe = spawnTs(fileURLToPath(import.meta.url), ["--attach-probe"], childEnv(h.home, { AIVE_PORT: "5033" }));
      const code = await Promise.race([probe.exited, sleep(30000).then(() => "timeout" as const)]);
      if (code === "timeout") await stop(probe);
      const line = probe.out.stdout.trim().split("\n").pop() ?? "";
      let got: { url?: string; dataDir?: string } = {};
      try {
        got = JSON.parse(line);
      } catch {
        /* reported below */
      }
      check(code === 0 && got.url === `http://127.0.0.1:${info.port}`, "the MCP client connected to the running core's port", { code, line, stderr: probe.out.stderr });
      check(got.dataDir === h.old, "the MCP client resolved the old folder", got);
      check(probe.out.stderr.includes(`[aive-mcp] data dir: ${h.old} (legacy)\n`), "the MCP client logs its data dir and why", probe.out.stderr);
      check(probe.out.stderr.includes(`connected to running core at http://127.0.0.1:${info.port} (pid ${info.pid})`) && !/spawning/.test(probe.out.stderr),
        "it attached (same pid and port) and spawned no core", probe.out.stderr);
      check(readFileSync(join(h.old, "server.json"), "utf8") === before && !existsSync(join(h.fresh, "server.json")),
        "the old server.json is unchanged and the new folder has none", readdirOrNone(h.fresh));
      check(core.child.exitCode === null, "the old core is still running");
    } finally {
      await stop(core);
    }
    check(core.child.exitCode !== null || core.child.signalCode !== null, "the old core was stopped by its pid");
  }

  console.log("5. a core with a fresh HOME and no AIVE_DATA_DIR...");
  {
    const h = freshHome(root, "freshcore");
    const core = await startCore(h.home, { AIVE_PORT: "5032" });
    try {
      check(core.out.stderr.includes(`[aive-core] data dir: ${h.fresh} (default)\n`), "the core logs the new folder (default)", core.out.stderr);
      check(core.ready.dataDir === h.fresh && existsSync(join(h.fresh, "server.json")) && !existsSync(h.old),
        "it publishes server.json in the new folder and makes no old folder", core.ready);
    } finally {
      await stop(core);
    }
  }

  if (packaged) {
    console.log(`6. packed tree ${packaged}...`);
    const app = resolve(packaged);
    const packedCjs = require(join(app, "electron", "brand.cjs")) as CjsBrand;
    const packedEsm = (await import(pathToFileURL(join(app, "node_modules", "@aive", "core", "dist", "brand.js")).href)) as Record<string, unknown>;
    checkConstants("packed electron/brand.cjs", packedCjs);
    checkConstants("packed @aive/core/dist/brand.js", packedEsm);
    check(isDeepStrictEqual(constantsOf(packedCjs), constantsOf(packedEsm)), "the two packed copies are equal");
    const packedResolver = (await import(pathToFileURL(join(app, "node_modules", "@aive", "core", "dist", "datadir.js")).href)) as CjsBrand;
    runResolverCases(join(root, "packed"), [["packed CJS", packedCjs], ["packed ESM dist/datadir.js", packedResolver]]);
  }

  rmSync(root, { recursive: true, force: true });
  if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nBRAND SMOKE TEST PASSED");
  process.exit(0);
}

function readdirOrNone(dir: string): string {
  try {
    return JSON.stringify(readdirSync(dir));
  } catch {
    return "(none)";
  }
}

(process.argv.includes("--attach-probe") ? attachProbe() : main()).catch((err) => {
  console.error(err);
  process.exit(1);
});
