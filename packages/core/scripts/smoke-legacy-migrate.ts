/**
 * Smoke test: `zedmix migrate` (packages/skill-installer) changes what the
 * previous identity (brand.ts LEGACY) left on a machine, and nothing else.
 *
 * Builds fake HOME / APPDATA / project folders, and fake checkouts and packaged
 * apps of this app (old and current names), of a look-alike with the same
 * layout and of an unrelated monorepo. Then checks rules 1-6 in JSON configs,
 * ~/.claude.json user and local scopes and Codex TOML: the rename in place,
 * the fingerprint, an existing current-key entry for this app or for another
 * program; a JSON file with comments is only reported; old skill copies, rule
 * files and marked sections; packaged entries with and without --entry; the
 * Claude Code CLI order (add-json, confirm, then remove) with a fake `claude`;
 * the checkout-move rule; --dry-run, a run without --yes and without a
 * terminal, and the prompts; formatting (indent, CRLF, key order), mode and
 * symlinks kept; backup modes 0700/0600; --restore byte for byte and its
 * inside-the-folder check; `add` only prints a hint; idempotence.
 *
 * Self-contained, no network, no FFmpeg. Never touches the real home folder.
 * Uses python3's tomllib to check that rewritten TOML parses, when present.
 * Run: npx tsx packages/core/scripts/smoke-legacy-migrate.ts
 */
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  chmodSync,
  rmSync,
  statSync,
  lstatSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY } from "../src/brand.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(here, "..", "..", "skill-installer", "bin", "zedmix.mjs");
const SKILL_SRC = resolve(here, "..", "..", "skill-installer", "skill", "SKILL.md");

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};

const write = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
};
const read = (file: string) => readFileSync(file, "utf8");
const json = (file: string) => JSON.parse(read(file));
const indent = (s: string) => s.replace(/^/gm, "       | ");
const mode = (p: string) => statSync(p).mode & 0o777;

// The previous identity's names; the current ones are written out.
const OLD = LEGACY.mcpKey;
const OLD_SKILL = LEGACY.skillName;
const OLD_NAME = LEGACY.productName;

const OTHER_PROGRAM = { command: "npx", args: ["-y", "some-other-mcp-server"] };

const OLD_SKILL_MD = `---
name: ${OLD_SKILL}
description: Turn any AI into a professional video editor operating the ${OLD_NAME} MCP editor (${OLD} server).
---

# ${OLD_NAME} Editor — operate ${OLD_NAME} like a professional
`;
const OLD_SECTION = `<!-- ${LEGACY.id}:${OLD_SKILL}:start -->\n\n# ${OLD_NAME} Editor — operate ${OLD_NAME} like a professional\n\n<!-- ${LEGACY.id}:${OLD_SKILL}:end -->\n`;
const NEW_SKILL_MD = `---
name: zedmix-editor
description: Turn any AI into a professional video editor operating the ZedMix MCP editor (zedmix server).
---

# ZedMix Editor — operate ZedMix like a professional
`;
const NEW_SECTION = `<!-- zedmix:zedmix-editor:start -->\n\n# ZedMix Editor\n\n<!-- zedmix:zedmix-editor:end -->\n`;
// The section `add` writes today, with the real skill text.
const SKILL_BODY = (() => {
  const text = read(SKILL_SRC);
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return m ? text.slice(m[0].length) : text;
})();
const CURRENT_SECTION = `<!-- zedmix:zedmix-editor:start -->\n\n${SKILL_BODY.trim()}\n\n<!-- zedmix:zedmix-editor:end -->\n`;

// ------------------------------------------------------------------- helpers

/** The environment of a run: a temporary HOME and config folders, and a PATH with no programs unless given. */
function envFor(home: string, appData: string, path: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    APPDATA: appData,
    PATH: path,
    LANG: "C.UTF-8",
  };
}

function run(env: NodeJS.ProcessEnv, cwd: string, args: string[], opts: { input?: string; extraEnv?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { env: { ...env, ...opts.extraEnv }, cwd, encoding: "utf8", input: opts.input ?? "", timeout: 60000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function snapshot(root: string, skip: (p: string) => boolean = () => false): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (skip(p)) continue;
      if (e.isDirectory()) walk(p);
      else out.set(p, (lstatSync(p).isSymbolicLink() ? "link:" : "") + read(p));
    }
  };
  walk(root);
  return out;
}
const same = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
const diff = (a: Map<string, string>, b: Map<string, string>) =>
  [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).join(", ");

/** Every file name under `dir` that looks like an atomic-write temp file. */
function tempFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tmp$/.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const HAVE_PY = spawnSync("python3", ["-I", "-c", "import tomllib"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } }).status === 0;
/** Parse TOML with python3's tomllib: the parsed value, or { error }. */
function parseToml(file: string): { value?: any; error?: string } {
  const r = spawnSync("python3", ["-I", "-c", "import tomllib,sys,json;print(json.dumps(tomllib.load(open(sys.argv[1],'rb'))))", file], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  return r.status === 0 ? { value: JSON.parse(r.stdout) } : { error: r.stderr };
}
function checkTomlParses(file: string, test: (v: any) => boolean, msg: string) {
  if (!HAVE_PY) {
    console.log(`  (skipped: python3 with tomllib is not installed) ${msg}`);
    return;
  }
  const p = parseToml(file);
  check(!p.error && test(p.value), `${msg}${p.error ? `\n${indent(p.error)}` : ""}`);
}

/** A checkout of some program: <dir>/package.json and packages/mcp/{package.json,dist/index.js}. Returns the entry file. */
function checkout(dir: string, rootName: string, mcpName = "@aive/mcp"): string {
  write(join(dir, "package.json"), JSON.stringify({ name: rootName, private: true }, null, 2) + "\n");
  write(join(dir, "packages", "mcp", "package.json"), JSON.stringify({ name: mcpName }, null, 2) + "\n");
  const entry = join(dir, "packages", "mcp", "dist", "index.js");
  write(entry, "// mcp\n");
  return entry;
}

/** A packaged app: <dir>/<exe> and <dir>/resources/app/{package.json,node_modules/@aive/mcp/dist/index.js}. */
function packaged(dir: string, name: string, exe: string) {
  write(join(dir, "resources", "app", "package.json"), JSON.stringify({ name, version: "1.0.0" }, null, 2) + "\n");
  const entry = join(dir, "resources", "app", "node_modules", "@aive", "mcp", "dist", "index.js");
  write(entry, "// mcp\n");
  write(join(dir, exe), "#!/bin/sh\n");
  return { exe: join(dir, exe), entry };
}

/**
 * A stand-in for Claude Code's CLI: logs its arguments and cwd, and does what
 * `claude mcp add-json` / `claude mcp remove` do to ~/.claude.json (add-json
 * adds `type: "stdio"`). FAKE_CLAUDE_ADD=fail|lie and FAKE_CLAUDE_REMOVE=fail
 * make it fail, or report success without writing.
 */
function fakeClaude(root: string): { bin: string; log: string; calls: () => { args: string[]; cwd: string }[] } {
  const bin = join(root, "fake-bin");
  const log = join(root, "claude-calls.log");
  write(
    join(bin, "fake-claude.mjs"),
    `
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
const [, verb, name] = args;
const scope = args[args.indexOf("-s") + 1];
const file = join(process.env.HOME, ".claude.json");
const data = JSON.parse(readFileSync(file, "utf8"));
const servers = () => {
  if (scope === "user") return (data.mcpServers ??= {});
  const p = (data.projects ??= {})[process.cwd()] ??= {};
  return (p.mcpServers ??= {});
};
if (verb === "add-json") {
  if (process.env.FAKE_CLAUDE_ADD === "fail") { console.error("add failed"); process.exit(1); }
  if (process.env.FAKE_CLAUDE_ADD === "lie") process.exit(0);
  const s = servers();
  if (name in s) { console.error("already exists"); process.exit(1); }
  s[name] = { type: "stdio", ...JSON.parse(args[3]) };
} else if (verb === "remove") {
  if (process.env.FAKE_CLAUDE_REMOVE === "fail") { console.error("remove failed"); process.exit(1); }
  delete servers()[name];
}
writeFileSync(file, JSON.stringify(data, null, 2));
`,
  );
  write(join(bin, "claude"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(bin, "fake-claude.mjs"))} "$@"\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const calls = () => (existsSync(log) ? read(log).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { bin, log, calls };
}

// util-linux `script`, by absolute path: the test env's PATH holds no programs.
const SCRIPT_BIN = spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } }).stdout?.trim() ?? "";
/** Run migrate on a terminal; `answers` are typed one per line. */
function viaTty(env: NodeJS.ProcessEnv, cwd: string, answers: string[]) {
  const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} migrate`;
  return spawnSync(SCRIPT_BIN, ["-qec", cmd, "/dev/null"], { env, cwd, encoding: "utf8", input: answers.map((a) => `${a}\n`).join(""), timeout: 30000 });
}

interface Programs {
  oldCo: string; // a checkout of this app before the rename (root package LEGACY.id)
  zrCo: string; // a checkout after the rename (root package "zedmix")
  lookCo: string; // a look-alike checkout: packages/mcp is @aive/mcp, the root package is another program
  mono: string; // an unrelated monorepo with packages/mcp/dist/index.js
  oldApp: { exe: string; entry: string }; // packaged LEGACY.desktopPackage
  lookApp: { exe: string; entry: string }; // a packaged look-alike
  zrApp: { exe: string; entry: string }; // packaged zedmix-desktop
  missing: string;
}

function programs(root: string): Programs {
  return {
    oldCo: checkout(join(root, "dev", OLD_NAME), LEGACY.id),
    zrCo: checkout(join(root, "dev", "ZedMix"), "zedmix"),
    lookCo: checkout(join(root, "dev", "lookalike"), "lookalike-editor"),
    mono: checkout(join(root, "dev", "monorepo"), "acme-monorepo", "@acme/mcp"),
    oldApp: packaged(join(root, "apps", OLD_NAME), LEGACY.desktopPackage, OLD_NAME),
    lookApp: packaged(join(root, "apps", "Lookalike"), "lookalike-editor-desktop", "Lookalike"),
    zrApp: packaged(join(root, "apps", "ZedMix"), "zedmix-desktop", "ZedMix"),
    missing: join(root, "gone", "packages", "mcp", "dist", "index.js"),
  };
}

const coRoot = (entry: string) => resolve(entry, "..", "..", "..", "..");

function makeBase(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  const appData = join(root, "AppData", "Roaming");
  const proj = join(root, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(proj, { recursive: true });
  const empty = join(root, "empty-bin");
  mkdirSync(empty, { recursive: true });
  // No `claude` CLI on PATH: ~/.claude.json is edited directly.
  return { root, home, appData, proj, env: envFor(home, appData, empty), p: programs(root) };
}

// ======================================================= Part A: the rename

function partRename() {
  const b = makeBase("zedmix-rename-");
  const { root, home, appData, proj, env, p } = b;
  // The project folder is itself a checkout of this app, so its .mcp.json's
  // relative path can be checked.
  checkout(proj, LEGACY.id);
  const local = coRoot(p.oldCo); // a local-scope project whose relative path is this app
  const localLook = coRoot(p.lookCo); // and one whose relative path is the look-alike checkout
  const f = {
    desktopLinux: join(home, ".config", "Claude", "claude_desktop_config.json"),
    desktopWin: join(appData, "Claude", "claude_desktop_config.json"),
    desktopMac: join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    claudeJson: join(home, ".claude.json"),
    projMcp: join(proj, ".mcp.json"),
    cursor: join(home, ".cursor", "mcp.json"),
    cursorTarget: join(root, "dotfiles", "cursor-mcp.json"),
    cursorProj: join(proj, ".cursor", "mcp.json"),
    windsurf: join(home, ".codeium", "windsurf", "mcp_config.json"),
    gemini: join(home, ".gemini", "settings.json"),
    cline: join(home, ".cline", "mcp.json"),
    vscodeUser: join(home, ".config", "Code", "User", "mcp.json"),
    vscodeProj: join(proj, ".vscode", "mcp.json"),
    codex: join(home, ".codex", "config.toml"),
    skillHome: join(home, ".claude", "skills", OLD_SKILL, "SKILL.md"),
    skillProj: join(proj, ".claude", "skills", OLD_SKILL, "SKILL.md"),
    skillCustom: join(home, ".claude", "skills", `${OLD_SKILL}-custom`, "SKILL.md"),
    skillNew: join(home, ".claude", "skills", "zedmix-editor", "SKILL.md"),
    cursorRule: join(proj, ".cursor", "rules", `${OLD_SKILL}.mdc`),
    windsurfRule: join(proj, ".windsurf", "rules", `${OLD_SKILL}.md`),
    cursorRuleNew: join(proj, ".cursor", "rules", "zedmix-editor.mdc"),
    agentsProj: join(proj, "AGENTS.md"),
    geminiHome: join(home, ".gemini", "GEMINI.md"),
    codexAgents: join(home, ".codex", "AGENTS.md"),
  };
  const oldEntry = { command: "node", args: [p.oldCo], env: { AIVE_DATA_DIR: "/data/x" }, timeout: 5 };
  // Rule 3: renamed in place, other keys and their order kept. Mode 0640.
  const desktopBefore = { mcpServers: { before: { command: "a" }, [OLD]: oldEntry, after: { command: "b" } }, theme: "dark" };
  write(f.desktopLinux, JSON.stringify(desktopBefore, null, 2) + "\n");
  chmodSync(f.desktopLinux, 0o640);
  // Fingerprint failures: a missing path, the look-alike checkout and packaged
  // app, an unrelated monorepo, and a program with no MCP entry file at all.
  write(f.desktopWin, JSON.stringify({ mcpServers: { [OLD]: { command: "node", args: [p.missing] } } }, null, 2) + "\n");
  write(f.gemini, JSON.stringify({ mcpServers: { [OLD]: { command: "node", args: [p.lookCo] } } }, null, 2) + "\n");
  write(f.cline, JSON.stringify({ mcpServers: { [OLD]: { command: p.lookApp.exe, args: [p.lookApp.entry], env: { ELECTRON_RUN_AS_NODE: "1" } } } }, null, 2) + "\n");
  write(f.vscodeUser, JSON.stringify({ servers: { [OLD]: { command: "node", args: [p.mono] } } }, null, 2) + "\n");
  write(f.desktopMac, JSON.stringify({ mcpServers: { [OLD]: OTHER_PROGRAM } }, null, 2) + "\n");
  // JSON with comments: report only.
  write(f.vscodeProj, `{\n  // my servers\n  "servers": { "${OLD}": ${JSON.stringify({ command: "node", args: [p.oldCo] })} }\n}\n`);
  // Rule 5 (both are this app), in a symlinked config.
  write(f.cursorTarget, JSON.stringify({ mcpServers: { [OLD]: { command: "node", args: [p.oldCo] }, zedmix: { command: "node", args: [p.zrCo] } } }, null, 2) + "\n");
  mkdirSync(dirname(f.cursor), { recursive: true });
  symlinkSync(f.cursorTarget, f.cursor);
  // Rule 6: zedmix already runs another program.
  write(f.windsurf, JSON.stringify({ mcpServers: { [OLD]: { command: "node", args: [p.oldCo] }, zedmix: OTHER_PROGRAM } }, null, 2) + "\n");
  // A relative path in a project config, resolved against the project.
  write(f.projMcp, JSON.stringify({ mcpServers: { [OLD]: { command: "node", args: ["packages/mcp/dist/index.js"] } } }, null, 2) + "\n");
  // Rule 4 without --entry: a packaged old app is left alone.
  write(f.cursorProj, JSON.stringify({ mcpServers: { [OLD]: { command: p.oldApp.exe, args: [p.oldApp.entry], env: { ELECTRON_RUN_AS_NODE: "1" } } } }, null, 2) + "\n");
  // Claude Code: user scope (absolute), a local scope with a relative path into
  // this app, and one with a relative path into the look-alike checkout.
  write(f.claudeJson, JSON.stringify({
    numStartups: 3,
    mcpServers: { [OLD]: { type: "stdio", command: "node", args: [p.oldCo], env: {} } },
    projects: {
      [local]: { allowedTools: ["x"], mcpServers: { other: { command: "o" }, [OLD]: { type: "stdio", command: "node", args: ["packages/mcp/dist/index.js"] } } },
      [localLook]: { mcpServers: { [OLD]: { type: "stdio", command: "node", args: ["packages/mcp/dist/index.js"] } } },
    },
  }, null, 2));
  // Codex: the main table and an env sub-table, plus another server.
  const codexBefore = [
    `model = "o3"`,
    ``,
    `[mcp_servers.${OLD}]`,
    `command = "node"`,
    `args = [${JSON.stringify(p.oldCo)}]`,
    ``,
    `[mcp_servers.${OLD}.env]`,
    `AIVE_DATA_DIR = "/data/x"`,
    `FOO = "bar"`,
    ``,
    `# notes`,
    `[mcp_servers.notes]`,
    `command = "notes-mcp"`,
    ``,
  ].join("\n");
  write(f.codex, codexBefore);
  write(f.skillHome, OLD_SKILL_MD);
  write(f.skillProj, OLD_SKILL_MD.replace(`name: ${OLD_SKILL}`, "name: my-own-skill"));
  write(f.skillCustom, OLD_SKILL_MD);
  write(f.skillNew, NEW_SKILL_MD);
  write(f.cursorRule, `---\ndescription: Turn any AI into a professional video editor operating the ${OLD_NAME} MCP editor (${OLD} server).\nalwaysApply: false\n---\n\n# ${OLD_NAME} Editor\n`);
  write(f.windsurfRule, `# ${OLD_NAME} Editor — operate ${OLD_NAME} like a professional\n`);
  write(f.cursorRuleNew, `---\ndescription: ZedMix editor\nalwaysApply: false\n---\n\n# ZedMix Editor\n`);
  write(f.agentsProj, `# Rules\n\nBe brief.\n\n${OLD_SECTION}\n## After\n\nMore.\n`);
  write(f.geminiHome, `# Mine\n\n${OLD_SECTION}\n${NEW_SECTION}`);
  write(f.codexAgents, `# Codex notes\n\nUse tabs.\n`);
  // An existing ~/.zedmix with a wide mode: migrate narrows it to 0700.
  mkdirSync(join(home, ".zedmix"), { recursive: true });
  chmodSync(join(home, ".zedmix"), 0o755);

  const notBackups = (q: string) => q.startsWith(join(home, ".zedmix"));
  const before = snapshot(root, notBackups);
  const beforeBytes = new Map([...before.keys()].filter((k) => !before.get(k)!.startsWith("link:")).map((k) => [k, readFileSync(k)]));

  console.log("A1. --dry-run lists the old entries and the ones it leaves alone, and changes nothing...");
  const dry = run(env, proj, ["migrate", "--dry-run"]);
  check(dry.code === 0, `exit 0 (got ${dry.code})`);
  check(new RegExp(`Found 11 entries from ${OLD_NAME}, ZedMix's old name:`).test(dry.out), `found 11 entries of the old name\n${indent(dry.out)}`);
  const leftAlone = (file: string, re: RegExp) => new RegExp(`${re.source}[^\\n]*\\n\\s+${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(dry.out);
  check(leftAlone(f.desktopWin, /cannot confirm it is ZedMix \([^)]*does not exist/), "a missing path is left alone");
  check(leftAlone(f.gemini, /cannot confirm it is ZedMix \([^)]*names "lookalike-editor"/), "a look-alike checkout (another root package name) is left alone");
  check(leftAlone(f.cline, /cannot confirm it is ZedMix \([^)]*names "lookalike-editor-desktop"/), "a look-alike packaged app (another resources/app name) is left alone");
  check(leftAlone(f.vscodeUser, /cannot confirm it is ZedMix \([^)]*names "@acme\/mcp"/), "an unrelated monorepo's packages/mcp/dist/index.js is left alone");
  check(leftAlone(f.desktopMac, /cannot confirm it is ZedMix \([^)]*does not run an MCP entry file/), "a program with no MCP entry file is left alone");
  check(leftAlone(f.claudeJson, /cannot confirm it is ZedMix \([^)]*lookalike-editor/), "a local scope whose relative path is the look-alike checkout is left alone");
  check(leftAlone(f.vscodeProj, new RegExp(`mentions "${OLD}" but is not plain JSON`)), "the JSON-with-comments file is report-only");
  check(leftAlone(f.windsurf, /a different program already uses the name "zedmix"/), "rule 6: zedmix running another program is reported");
  check(leftAlone(f.cursorProj, new RegExp(`runs an installed ${OLD_NAME} app[^\\n]*Connect AI[^\\n]*--entry`)), "rule 4 without --entry: reported with the Connect AI hint");
  check(leftAlone(f.skillProj, new RegExp(`its name is not "${OLD_SKILL}"`)), `a ${OLD_SKILL} folder holding another skill is left alone`);
  check(/Close Claude Code/.test(dry.out), "warns that ~/.claude.json would be edited directly");
  check(same(before, snapshot(root, notBackups)), "no file changed");
  check(!existsSync(join(home, ".zedmix", "backups")), "no backup folder made");

  console.log("A2. without --yes and without a terminal, nothing changes...");
  const noTty = run(env, proj, ["migrate"]);
  check(noTty.code === 0 && /Re-run with --yes/.test(noTty.out), "prints the --yes hint");
  check(same(before, snapshot(root, notBackups)), "no file changed");

  console.log("A3. --yes applies rules 1-6, keeps formatting, mode and symlinks...");
  const yes = run(env, proj, ["migrate", "--yes"]);
  check(yes.code === 0, `exit 0 (got ${yes.code})\n${indent(yes.out)}`);
  check(/Close Claude Code/.test(yes.out), "--yes prints the close-Claude-Code warning and goes on");
  const desktopAfter = { mcpServers: { before: { command: "a" }, zedmix: oldEntry, after: { command: "b" } }, theme: "dark" };
  check(read(f.desktopLinux) === JSON.stringify(desktopAfter, null, 2) + "\n", `rule 3: ${OLD} renamed to zedmix in place, fields and key order kept\n${indent(read(f.desktopLinux))}`);
  check(mode(f.desktopLinux) === 0o640, `the rewritten file kept mode 0640 (got ${mode(f.desktopLinux).toString(8)})`);
  for (const k of ["desktopWin", "desktopMac", "gemini", "cline", "vscodeUser", "vscodeProj", "windsurf", "cursorProj"] as const) {
    check(read(f[k]) === before.get(f[k]), `${k}: left byte-identical`);
  }
  check(lstatSync(f.cursor).isSymbolicLink() && realpathSync(f.cursor) === realpathSync(f.cursorTarget), "the symlinked Cursor config is still a link to the same file");
  check(read(f.cursorTarget) === JSON.stringify({ mcpServers: { zedmix: { command: "node", args: [p.zrCo] } } }, null, 2) + "\n", `rule 5: the link's target lost ${OLD} and kept zedmix`);
  check(read(f.projMcp) === JSON.stringify({ mcpServers: { zedmix: { command: "node", args: ["packages/mcp/dist/index.js"] } } }, null, 2) + "\n", "project .mcp.json: the relative entry renamed");
  const cj = json(f.claudeJson);
  check(cj.numStartups === 3 && JSON.stringify(cj.mcpServers) === JSON.stringify({ zedmix: { type: "stdio", command: "node", args: [p.oldCo], env: {} } }), "~/.claude.json user scope renamed, other state kept");
  check(
    JSON.stringify(cj.projects[local]) === JSON.stringify({ allowedTools: ["x"], mcpServers: { other: { command: "o" }, zedmix: { type: "stdio", command: "node", args: ["packages/mcp/dist/index.js"] } } }),
    "~/.claude.json local scope (relative path, checked against the project key) renamed in place",
  );
  check(!!cj.projects[localLook].mcpServers[OLD] && !cj.projects[localLook].mcpServers.zedmix, "~/.claude.json local scope pointing at the look-alike checkout kept");
  check(!read(f.claudeJson).endsWith("\n"), "~/.claude.json: no trailing newline added");
  check(
    read(f.codex) === codexBefore.replace(`[mcp_servers.${OLD}]`, "[mcp_servers.zedmix]").replace(`[mcp_servers.${OLD}.env]`, "[mcp_servers.zedmix.env]"),
    `Codex TOML: both tables renamed, nothing else changed\n${indent(read(f.codex))}`,
  );
  checkTomlParses(
    f.codex,
    (v) =>
      !v.mcp_servers[OLD] &&
      v.mcp_servers.zedmix.command === "node" &&
      JSON.stringify(v.mcp_servers.zedmix.args) === JSON.stringify([p.oldCo]) &&
      JSON.stringify(v.mcp_servers.zedmix.env) === JSON.stringify({ AIVE_DATA_DIR: "/data/x", FOO: "bar" }) &&
      v.mcp_servers.notes.command === "notes-mcp",
    "Codex TOML still parses and the env values are unchanged",
  );
  check(!existsSync(dirname(f.skillHome)), `the home ${OLD_SKILL} skill folder removed`);
  check(read(f.skillProj) === before.get(f.skillProj) && read(f.skillCustom) === OLD_SKILL_MD && read(f.skillNew) === NEW_SKILL_MD, "other skills kept");
  check(!existsSync(f.cursorRule) && !existsSync(f.windsurfRule) && existsSync(f.cursorRuleNew), `Cursor/Windsurf ${OLD_SKILL} rules removed, the current rule kept`);
  check(read(f.agentsProj) === `# Rules\n\nBe brief.\n\n${CURRENT_SECTION}\n## After\n\nMore.\n`, `AGENTS.md: the old section replaced with the current skill in place\n${indent(read(f.agentsProj).slice(0, 400))}`);
  check(read(f.geminiHome) === `# Mine\n\n${NEW_SECTION}`, `GEMINI.md that already had the current section: the old one removed\n${indent(read(f.geminiHome))}`);
  check(read(f.codexAgents) === before.get(f.codexAgents), "an AGENTS.md without a section untouched");
  check(tempFiles(root).length === 0, `no temp files left behind (${tempFiles(root).join(", ")})`);
  check(/install the current skill \(zedmix-editor\)/.test(yes.out), "suggests `add` after removing an old skill copy");

  const zr = join(home, ".zedmix");
  const backups = join(zr, "backups");
  const stamps = existsSync(backups) ? readdirSync(backups) : [];
  const stampDir = join(backups, stamps[0] ?? "none");
  const manifestFile = join(stampDir, "manifest.json");
  const manifest: { original: string; backup: string }[] = existsSync(manifestFile) ? json(manifestFile) : [];
  check(stamps.length === 1, `one backup folder (got ${stamps.length})`);
  if (process.platform !== "win32") {
    check(mode(zr) === 0o700, `~/.zedmix narrowed to 0700 (got ${mode(zr).toString(8)})`);
    check(mode(backups) === 0o700, `~/.zedmix/backups is 0700 (got ${mode(backups).toString(8)})`);
    check(mode(stampDir) === 0o700, `the backup folder is 0700 (got ${existsSync(stampDir) ? mode(stampDir).toString(8) : "missing"})`);
    check(existsSync(manifestFile) && mode(manifestFile) === 0o600, `manifest.json is 0600 (got ${existsSync(manifestFile) ? mode(manifestFile).toString(8) : "missing"})`);
  }
  check(manifest.length === 10, `10 files backed up (got ${manifest.length})`);
  check(manifest.every((m) => Object.keys(m).sort().join() === "backup,original"), "the manifest holds only original and backup paths");
  check(manifest.every((m) => before.get(m.original)?.replace(/^link:/, "") === read(m.backup)), "every backup holds the original content");
  check(!existsSync(join(home, LEGACY.dataDirParts[0])), `nothing written under the old ~/${LEGACY.dataDirParts[0]}`);

  console.log("A4. a second run finds nothing and changes nothing...");
  const afterYes = snapshot(root);
  const again = run(env, proj, ["migrate", "--yes"]);
  check(again.code === 0 && /Nothing to migrate/.test(again.out), `nothing left to change\n${indent(again.out)}`);
  check(same(afterYes, snapshot(root)), `no file changed, no new backup folder (${diff(afterYes, snapshot(root))})`);

  console.log("A5. --restore puts every file back byte for byte...");
  const restoreDry = run(env, proj, ["migrate", "--restore", stampDir, "--dry-run"]);
  check(restoreDry.code === 0 && manifest.every((m) => restoreDry.out.includes(m.original)), "--restore --dry-run lists every original");
  check(same(afterYes, snapshot(root)), "--restore --dry-run changes nothing");
  const restoreNoTty = run(env, proj, ["migrate", "--restore", stampDir]);
  check(/Re-run with --yes/.test(restoreNoTty.out) && same(afterYes, snapshot(root)), "--restore without --yes and without a terminal changes nothing");
  const restored = run(env, proj, ["migrate", "--restore", stampDir, "--yes"]);
  check(restored.code === 0, `exit 0 (got ${restored.code})\n${indent(restored.out)}`);
  check(same(before, snapshot(root, notBackups)), `every file is as before the migrate (${diff(before, snapshot(root, notBackups))})`);
  check([...beforeBytes].every(([k, v]) => readFileSync(k).equals(v)), "byte for byte");
  check(lstatSync(f.cursor).isSymbolicLink(), "the symlinked config is still a link after the restore");
  check(mode(f.desktopLinux) === 0o640, "the restored file kept mode 0640");
  const stamps2 = readdirSync(backups);
  const pre = stamps2.find((s) => s.startsWith("restore-"));
  check(!!pre && json(join(backups, pre, "manifest.json")).length === 7, `the files before the restore were backed up first (${stamps2.join(", ")})`);
  check(!!pre && /The files as they were before this restore/.test(restored.out), "the report names that folder");

  console.log("A6. --restore refuses a manifest entry outside the backup folder...");
  const outside = join(root, "outside.json");
  write(outside, `{"evil": true}\n`);
  const evilCases: [string, string][] = [
    ["an absolute path outside", outside],
    ["a ../ path", join("..", "..", "outside.json")],
    ["a symlink inside pointing outside", "link"],
  ];
  for (const [label, backupPath] of evilCases) {
    const dir = join(root, "evil", label.replace(/\W+/g, "-"));
    write(join(dir, "1-good.json"), `{"good": true}\n`);
    if (backupPath === "link") symlinkSync(outside, join(dir, "2-link.json"));
    const target = backupPath === "link" ? join(dir, "2-link.json") : backupPath;
    write(join(dir, "manifest.json"), JSON.stringify([{ original: f.desktopWin, backup: join(dir, "1-good.json") }, { original: f.gemini, backup: target }], null, 2));
    const snap = snapshot(root, notBackups);
    const r = run(env, proj, ["migrate", "--restore", dir, "--yes"]);
    check(r.code !== 0 && /not inside/.test(r.out) && /Nothing restored/.test(r.out), `${label}: refused\n${indent(r.out)}`);
    check(same(snap, snapshot(root, notBackups)), `${label}: nothing restored, not even the good entry`);
  }

  console.log(`A7. a rule file at the old ${OLD_SKILL} path that is not the ${OLD_NAME} skill is left alone...`);
  const proj2 = join(root, "proj2");
  const ownRule = join(proj2, ".windsurf", "rules", `${OLD_SKILL}.md`);
  const ownRuleText = `# My own rules\n\nUse tabs.\n`;
  write(ownRule, ownRuleText);
  const ruleDry = run(env, proj2, ["migrate", "--dry-run"]);
  const ruleLeftAlone = new RegExp(`does not look like the ${OLD_NAME} skill[^\\n]*\\n\\s+${ownRule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  check(ruleDry.code === 0 && ruleLeftAlone.test(ruleDry.out), `--dry-run reports it as left alone\n${indent(ruleDry.out)}`);
  const ruleYes = run(env, proj2, ["migrate", "--yes"]);
  check(ruleYes.code === 0, `exit 0 (got ${ruleYes.code})\n${indent(ruleYes.out)}`);
  check(existsSync(ownRule) && read(ownRule) === ownRuleText, "after --yes the rule file is unchanged");

  rmSync(root, { recursive: true, force: true });
}

// ============================================== Part B: packaged and --entry

function partEntry() {
  const { root, home, proj, env, p } = makeBase("zedmix-entry-");
  const desktop = join(home, ".config", "Claude", "claude_desktop_config.json");
  const codex = join(home, ".codex", "config.toml");
  const oldPkg = { command: p.oldApp.exe, args: [p.oldApp.entry], env: { ELECTRON_RUN_AS_NODE: "1", EXTRA: "x" }, timeout: 30 };
  write(desktop, JSON.stringify({ mcpServers: { a: { command: "a" }, [OLD]: oldPkg, z: { command: "z" } } }, null, 2) + "\n");
  const codexBefore = [
    `[mcp_servers.${OLD}]`,
    `command = ${JSON.stringify(p.oldApp.exe)}`,
    `args = [`,
    `  ${JSON.stringify(p.oldApp.entry)},`,
    `]`,
    `startup_timeout_sec = 20`,
    ``,
    `[mcp_servers.${OLD}.env]`,
    `ELECTRON_RUN_AS_NODE = "1"`,
    `EXTRA = "x"`,
    ``,
  ].join("\n");
  write(codex, codexBefore);
  const entryFile = (command: string, args: string[]) => {
    const file = join(root, `entry-${Math.random().toString(36).slice(2)}.json`);
    write(file, JSON.stringify({ mcpServers: { zedmix: { command, args, env: { ELECTRON_RUN_AS_NODE: "1" } } } }, null, 2));
    return file;
  };
  const before = snapshot(home);

  console.log(`B1. a packaged ${OLD} entry without --entry is left alone and reported...`);
  const r1 = run(env, proj, ["migrate", "--yes"]);
  check(r1.code === 0 && /Nothing to migrate/.test(r1.out) && /Connect AI/.test(r1.out) && /--entry/.test(r1.out), `left alone, with the Connect AI / --entry hint\n${indent(r1.out)}`);
  check(same(before, snapshot(home)), "no file changed");

  console.log("B2. an --entry whose command does not exist changes nothing...");
  const r2 = run(env, proj, ["migrate", "--yes", "--entry", entryFile(join(root, "apps", "ZedMix", "missing.exe"), [p.zrApp.entry])]);
  check(r2.code !== 0 && /does not exist/.test(r2.out) && /Nothing changed/.test(r2.out), `refused\n${indent(r2.out)}`);
  check(same(before, snapshot(home)), "no file changed");

  console.log(`B3. an --entry that names the old app (${LEGACY.desktopPackage}), not ZedMix, changes nothing...`);
  const r3 = run(env, proj, ["migrate", "--yes", "--entry", entryFile(p.oldApp.exe, [p.oldApp.entry])]);
  check(r3.code !== 0 && /installed ZedMix app/.test(r3.out), `refused\n${indent(r3.out)}`);
  check(same(before, snapshot(home)), "no file changed");

  console.log(`B4. a valid --entry: zedmix gets the new command and args, ${OLD}'s other env and fields are kept, ${OLD} is removed...`);
  const r4 = run(env, proj, ["migrate", "--yes", "--entry", entryFile(p.zrApp.exe, [p.zrApp.entry])]);
  check(r4.code === 0, `exit 0 (got ${r4.code})\n${indent(r4.out)}`);
  const want = { a: { command: "a" }, zedmix: { command: p.zrApp.exe, args: [p.zrApp.entry], env: { ELECTRON_RUN_AS_NODE: "1", EXTRA: "x" }, timeout: 30 }, z: { command: "z" } };
  check(read(desktop) === JSON.stringify({ mcpServers: want }, null, 2) + "\n", `Claude Desktop: replaced at the same position\n${indent(read(desktop))}`);
  const wantToml = [
    `[mcp_servers.zedmix]`,
    `command = ${JSON.stringify(p.zrApp.exe)}`,
    `args = [${JSON.stringify(p.zrApp.entry)}]`,
    `startup_timeout_sec = 20`,
    ``,
    `[mcp_servers.zedmix.env]`,
    `ELECTRON_RUN_AS_NODE = "1"`,
    `EXTRA = "x"`,
    ``,
  ].join("\n");
  check(read(codex) === wantToml, `Codex TOML: command and args replaced, the rest kept\n${indent(read(codex))}`);
  checkTomlParses(
    codex,
    (v) =>
      !v.mcp_servers[OLD] &&
      v.mcp_servers.zedmix.command === p.zrApp.exe &&
      JSON.stringify(v.mcp_servers.zedmix.args) === JSON.stringify([p.zrApp.entry]) &&
      v.mcp_servers.zedmix.startup_timeout_sec === 20 &&
      JSON.stringify(v.mcp_servers.zedmix.env) === JSON.stringify({ ELECTRON_RUN_AS_NODE: "1", EXTRA: "x" }),
    "Codex TOML parses with the new entry",
  );
  const r5 = run(env, proj, ["migrate", "--yes", "--entry", entryFile(p.zrApp.exe, [p.zrApp.entry])]);
  check(r5.code === 0 && /Nothing to migrate/.test(r5.out), "a second run finds nothing");
  rmSync(root, { recursive: true, force: true });
}

// ================================= Part C: rules in TOML and ~/.claude.json

function partRules() {
  console.log("C. rules 2, 5 and 6 in Codex TOML and ~/.claude.json, and TOML forms it does not edit...");
  const tomlCase = (label: string, body: (p: Programs) => string, expect: ((before: string, p: Programs) => string) | null, outRe: RegExp) => {
    const { root, home, proj, env, p } = makeBase("zedmix-toml-");
    const file = join(home, ".codex", "config.toml");
    const text = body(p);
    write(file, text);
    const r = run(env, proj, ["migrate", "--yes"]);
    const want = expect ? expect(text, p) : text;
    check(read(file) === want && outRe.test(r.out), `${label}\n${indent(read(file))}\n${indent(r.out)}`);
    if (expect) checkTomlParses(file, (v) => !v.mcp_servers?.[OLD], `${label}: still parses`);
    rmSync(root, { recursive: true, force: true });
  };
  const table = (key: string, entry: string) => `[mcp_servers.${key}]\ncommand = "node"\nargs = [${JSON.stringify(entry)}]\n`;
  tomlCase(
    `TOML rule 5: ${OLD} removed when zedmix is this app`,
    (p) => `${table(OLD, p.oldCo)}\n[mcp_servers.${OLD}.env]\nA = "1"\n\n${table("zedmix", p.zrCo)}`,
    (_, p) => table("zedmix", p.zrCo),
    /✔ removed/,
  );
  tomlCase("TOML rule 6: nothing written when zedmix is another program", (p) => `${table(OLD, p.oldCo)}\n[mcp_servers.zedmix]\ncommand = "npx"\nargs = ["other"]\n`, null, /a different program already uses the name "zedmix"/);
  tomlCase("TOML rule 2: a look-alike checkout left alone", (p) => table(OLD, p.lookCo), null, /cannot confirm it is ZedMix/);
  tomlCase(
    "TOML: quoted header forms renamed",
    (p) => `[mcp_servers."${OLD}"]\ncommand = "node"\nargs = [${JSON.stringify(p.oldCo)}]\n\n[mcp_servers.'${OLD}'.env]\nA = "1"\n`,
    (t) => t.replace(`"${OLD}"`, `"zedmix"`).replace(`'${OLD}'`, `'zedmix'`),
    /✔ renamed/,
  );
  tomlCase("TOML: an inline table is reported, not edited", (p) => `[mcp_servers]\n${OLD} = { command = "node", args = [${JSON.stringify(p.oldCo)}] }\n`, null, /edit it by hand/);
  tomlCase("TOML: dotted keys are reported, not edited", (p) => `mcp_servers.${OLD}.command = "node"\nmcp_servers.${OLD}.args = [${JSON.stringify(p.oldCo)}]\n`, null, /edit it by hand/);

  // A checkout whose root is named like this app but whose packages/mcp is another package.
  {
    const { root, home, proj, env } = makeBase("zedmix-mcpname-");
    const entry = checkout(join(root, "dev", "lookalike"), "zedmix", "@other/mcp");
    const file = join(home, ".cursor", "mcp.json");
    write(file, JSON.stringify({ mcpServers: { [OLD]: { command: "node", args: [entry] } } }, null, 2) + "\n");
    const text = read(file);
    const r = run(env, proj, ["migrate", "--yes"]);
    check(read(file) === text && /names "@other\/mcp"/.test(r.out), `a checkout whose packages/mcp is not @aive/mcp is left alone\n${indent(r.out)}`);
    rmSync(root, { recursive: true, force: true });
  }

  // ~/.claude.json: user scope rule 5, local scope rule 6, direct edit.
  const { root, home, proj, env, p } = makeBase("zedmix-claude-");
  const local = join(root, "projA");
  mkdirSync(local, { recursive: true });
  const file = join(home, ".claude.json");
  write(file, JSON.stringify({
    mcpServers: { [OLD]: { command: "node", args: [p.oldCo] }, zedmix: { command: "node", args: [p.zrCo] } },
    projects: { [local]: { mcpServers: { [OLD]: { command: "node", args: [p.oldCo] }, zedmix: OTHER_PROGRAM } } },
  }, null, 2));
  const r = run(env, proj, ["migrate", "--yes"]);
  const cj = json(file);
  check(r.code === 0 && !cj.mcpServers[OLD] && !!cj.mcpServers.zedmix, `~/.claude.json user scope, rule 5: ${OLD} removed`);
  check(JSON.stringify(cj.projects[local].mcpServers) === JSON.stringify({ [OLD]: { command: "node", args: [p.oldCo] }, zedmix: OTHER_PROGRAM }), "~/.claude.json local scope, rule 6: nothing written");
  rmSync(root, { recursive: true, force: true });
}

// ================================================ Part D: the Claude Code CLI

function partCli() {
  console.log("D. with a claude CLI: add-json, confirm, and only then remove...");
  const { root, home, proj, env, p } = makeBase("zedmix-cli-");
  const local = join(root, "projA");
  mkdirSync(local, { recursive: true });
  const file = join(home, ".claude.json");
  const S = { type: "stdio", command: "node", args: [p.oldCo], env: { AIVE_DATA_DIR: "/d" } };
  const start = JSON.stringify({ numStartups: 1, mcpServers: { [OLD]: S }, projects: { [local]: { mcpServers: { [OLD]: S } } } }, null, 2);
  write(file, start);
  const fake = fakeClaude(root);
  const cliEnv = { ...env, PATH: fake.bin };
  const verbs = (from: number) => fake.calls().slice(from).map((c) => `${c.args[1]} ${c.args[2]} ${c.args[c.args.indexOf("-s") + 1]}`);

  const r1 = run(cliEnv, proj, ["migrate", "--yes"], { extraEnv: { FAKE_CLAUDE_ADD: "fail" } });
  check(r1.code !== 0 && read(file) === start, `add fails: exit non-zero and ~/.claude.json unchanged (${OLD} still there)\n${indent(r1.out)}`);
  check(verbs(0).join() === "add-json zedmix user,add-json zedmix local", `add fails: no remove was called (${verbs(0).join()})`);
  check(!/Close Claude Code/.test(r1.out), "the CLI route does not ask to close Claude Code");

  let n = fake.calls().length;
  const r2 = run(cliEnv, proj, ["migrate", "--yes"], { extraEnv: { FAKE_CLAUDE_ADD: "lie" } });
  check(r2.code !== 0 && read(file) === start && verbs(n).every((v) => v.startsWith("add-json")), `add reports success but writes nothing: not confirmed, nothing removed (${verbs(n).join()})`);

  n = fake.calls().length;
  const r3 = run(cliEnv, proj, ["migrate", "--yes"], { extraEnv: { FAKE_CLAUDE_REMOVE: "fail" } });
  const cj3 = json(file);
  check(r3.code !== 0 && /both entries exist/.test(r3.out), `add works, remove fails: reported\n${indent(r3.out)}`);
  check(!!cj3.mcpServers[OLD] && !!cj3.mcpServers.zedmix && !!cj3.projects[local].mcpServers[OLD] && !!cj3.projects[local].mcpServers.zedmix, "add works, remove fails: both keys exist in both scopes");
  check(verbs(n).join() === `add-json zedmix user,remove ${OLD} user,add-json zedmix local,remove ${OLD} local`, `add-json before remove in each scope (${verbs(n).join()})`);
  const added = fake.calls().slice(n).find((c) => c.args[1] === "add-json");
  check(!!added && JSON.stringify(JSON.parse(added.args[3])) === JSON.stringify(S), `add-json got ${OLD}'s entry unchanged`);
  check(fake.calls().slice(n).filter((c) => c.args[1] === "add-json" && c.args.includes("local")).every((c) => c.cwd === local), "-s local runs from the project folder");

  n = fake.calls().length;
  const r4 = run(cliEnv, proj, ["migrate", "--yes"]);
  const cj4 = json(file);
  check(r4.code === 0 && verbs(n).join() === `remove ${OLD} user,remove ${OLD} local`, `the next run removes ${OLD} (rule 5) without adding (${verbs(n).join()})\n${indent(r4.out)}`);
  check(!cj4.mcpServers[OLD] && !cj4.projects[local].mcpServers[OLD] && cj4.mcpServers.zedmix?.args?.[0] === p.oldCo && cj4.numStartups === 1, `${OLD} gone, zedmix kept, other state kept`);
  const r5 = run(cliEnv, proj, ["migrate", "--yes"]);
  check(/Nothing to migrate/.test(r5.out), "then nothing is left");
  rmSync(root, { recursive: true, force: true });
}

// ================================================ Part E: the checkout move

function partMove() {
  console.log("E. checkout move: stale paths are reported, and rewritten only to a ZedMix checkout...");
  const { root, home, proj, env, p } = makeBase("zedmix-move-");
  const old = join(root, "old", OLD_NAME);
  const oldEntry = join(old, "packages", "mcp", "dist", "index.js");
  const desktop = join(home, ".config", "Claude", "claude_desktop_config.json");
  const cursor = join(home, ".cursor", "mcp.json");
  const codex = join(home, ".codex", "config.toml");
  write(desktop, JSON.stringify({ mcpServers: { [OLD]: { command: "node", args: [oldEntry] } } }, null, 2) + "\n");
  write(cursor, JSON.stringify({ mcpServers: { zedmix: { command: "node", args: [oldEntry] } } }, null, 2) + "\n");
  const codexBefore = `[mcp_servers.zedmix]\ncommand = "node"\nargs = [${JSON.stringify(oldEntry)}]\n`;
  write(codex, codexBefore);
  const before = snapshot(home);

  const dry = run(env, proj, ["migrate", "--dry-run"]);
  const staleCount = (dry.out.match(/stale path/g) ?? []).length;
  check(staleCount === 3 && /--from-checkout/.test(dry.out), `without the flags: all three stale paths reported (got ${staleCount})\n${indent(dry.out)}`);
  check(same(before, snapshot(home)), "nothing changed");

  const bad = run(env, proj, ["migrate", "--yes", "--from-checkout", old, "--to-checkout", coRoot(p.mono)]);
  check(/is not a ZedMix checkout/.test(bad.out) && same(before, snapshot(home)), `--to-checkout that fails the fingerprint: nothing rewritten\n${indent(bad.out)}`);
  const look = run(env, proj, ["migrate", "--yes", "--from-checkout", old, "--to-checkout", coRoot(p.lookCo)]);
  check(/is not a ZedMix checkout/.test(look.out) && same(before, snapshot(home)), "--to-checkout a look-alike checkout: nothing rewritten");

  const ok = run(env, proj, ["migrate", "--yes", "--from-checkout", old, "--to-checkout", coRoot(p.zrCo)]);
  check(ok.code === 0, `exit 0 (got ${ok.code})\n${indent(ok.out)}`);
  check(read(desktop) === JSON.stringify({ mcpServers: { zedmix: { command: "node", args: [p.zrCo] } } }, null, 2) + "\n", `${OLD} into the old checkout: path rewritten and renamed\n${indent(read(desktop))}`);
  check(read(cursor) === JSON.stringify({ mcpServers: { zedmix: { command: "node", args: [p.zrCo] } } }, null, 2) + "\n", "zedmix into the old checkout: path rewritten");
  check(read(codex) === codexBefore.replace(JSON.stringify(oldEntry), JSON.stringify(p.zrCo)), `Codex TOML: path rewritten\n${indent(read(codex))}`);
  const again = run(env, proj, ["migrate", "--yes", "--from-checkout", old, "--to-checkout", coRoot(p.zrCo)]);
  check(/Nothing to migrate/.test(again.out), "a second run finds nothing");
  rmSync(root, { recursive: true, force: true });
}

// ================================================ Part F: `add` and the prompts

function partPrompts() {
  const { root, home, appData, proj, env, p } = makeBase("zedmix-tty-");
  const desktopWin = join(appData, "Claude", "claude_desktop_config.json");
  const claudeJson = join(home, ".claude.json");
  const skill = join(proj, ".claude", "skills", OLD_SKILL, "SKILL.md");
  const notes = join(dirname(skill), "notes.txt");
  const entry = { command: "node", args: [p.oldCo] };
  const crlf4 = (data: unknown) => JSON.stringify(data, null, 4).replace(/\n/g, "\r\n") + "\r\n";
  // 4-space indent and CRLF line ends.
  write(desktopWin, crlf4({ mcpServers: { [OLD]: entry } }));
  write(claudeJson, JSON.stringify({ numStartups: 2, mcpServers: { [OLD]: entry } }, null, 2));
  // A skill folder that also holds the user's own file.
  write(skill, OLD_SKILL_MD);
  write(notes, "my own notes\n");

  console.log("F1. `add` prints a hint and leaves the old entries alone...");
  const before = snapshot(root);
  const add = run(env, proj, ["add", "--client", "claude", "--scope", "project", "--dir", proj]);
  const installed = join(proj, ".claude", "skills", "zedmix-editor", "SKILL.md");
  check(add.code === 0 && /zedmix migrate/.test(add.out), `add mentions \`zedmix migrate\`\n${indent(add.out)}`);
  check(existsSync(installed) && /^name: zedmix-editor$/m.test(read(installed)), "add installed the current skill, named zedmix-editor");
  const afterAdd = snapshot(root);
  check([...before].every(([k, v]) => afterAdd.get(k) === v), "add changed none of the existing files");

  console.log("F2. the prompts: 'n' keeps everything, 'y' then 'n' at the close-Claude-Code question keeps everything, 'y' 'y' changes...");
  let out: string;
  if (!SCRIPT_BIN) {
    console.log("  (skipped: util-linux `script` is not installed; using --yes)");
    out = run(env, proj, ["migrate", "--yes"]).out;
  } else {
    const no = viaTty(env, proj, ["n"]);
    check(/Apply these changes\? \[y\/N\]/.test(no.stdout) && /Nothing changed/.test(no.stdout), "asks, and 'n' answers Nothing changed");
    check(same(afterAdd, snapshot(root)), "'n': no file changed");
    const notClosed = viaTty(env, proj, ["y", "n"]);
    check(/Is Claude Code closed\? Continue\? \[y\/N\]/.test(notClosed.stdout) && /Nothing changed/.test(notClosed.stdout), `asks to close Claude Code, and 'n' answers Nothing changed\n${indent(notClosed.stdout)}`);
    check(same(afterAdd, snapshot(root)), "'y' 'n': no file changed");
    out = viaTty(env, proj, ["y", "y"]).stdout;
  }
  const cj = json(claudeJson);
  check(cj.numStartups === 2 && !cj.mcpServers[OLD] && !!cj.mcpServers.zedmix, `~/.claude.json renamed, other state kept\n${indent(out)}`);
  check(read(desktopWin) === crlf4({ mcpServers: { zedmix: entry } }), `Claude Desktop (APPDATA): renamed, 4-space indent and CRLF kept\n${indent(read(desktopWin))}`);
  check(!existsSync(skill) && read(notes) === "my own notes\n", "the old SKILL.md removed, the user's notes.txt and its folder kept");
  check(/kept [^\n]*: it holds other files/.test(out), "the report says the folder was kept");
  check(read(installed) === afterAdd.get(installed), "the current skill that `add` installed is kept");
  rmSync(root, { recursive: true, force: true });
}

function main() {
  partRename();
  partEntry();
  partRules();
  partCli();
  partMove();
  partPrompts();
  if (failures) {
    console.log(`\nLEGACY MIGRATE SMOKE TEST FAILED (${failures} check(s))`);
    process.exit(1);
  }
  console.log("\nLEGACY MIGRATE SMOKE TEST PASSED");
}

main();
