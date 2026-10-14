/**
 * Smoke test: `zabsreel migrate` (packages/skill-installer) changes what the two
 * earlier generations left on a machine, and nothing else.
 *
 * Part A, Relo's SynthCut. Builds fake HOME / APPDATA / project folders holding
 * the old MCP server entry "ai-video-editor" (source and packaged forms) in
 * Claude Desktop, Claude Code, Codex (TOML), Cursor and VS Code configs, the old
 * "video-editor-pro" skill files and marked sections, plus look-alikes that must
 * stay: an "ai-video-editor" that runs some other program, the current
 * "zabsreel" entries, other servers and keys, a JSON file with comments, a skill
 * folder with an extra file. Then checks:
 *   - --dry-run and a run without --yes (no terminal) change nothing,
 *   - the answer "n" at the prompt changes nothing, "y" removes; "n" at the
 *     close-Claude-Code question changes nothing,
 *   - --yes removes exactly the legacy entries, keeps formatting (indentation,
 *     CRLF), and backs every changed file up (manifest.json),
 *   - a second run finds nothing,
 *   - `add` only prints a hint,
 *   - with a `claude` CLI on PATH, ~/.claude.json entries go through
 *     `claude mcp remove <name> -s user|local`.
 *
 * Part B onwards, this fork's own old name: the "synthcut" entry and the
 * "synthcut-editor" skill. Builds fake checkouts and packaged apps of this app,
 * of Relo's SynthCut and of an unrelated monorepo, and checks rules 1-6 in JSON
 * configs, ~/.claude.json user and local scopes and Codex TOML; the
 * fingerprint; packaged entries with and without --entry; the Claude Code CLI
 * order (add-json, confirm, then remove) with a fake `claude`; the checkout-move
 * rule; atomic writes (mode and symlink kept); backup modes 0700/0600;
 * --restore byte for byte and its inside-the-folder check; idempotence.
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

const here = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(here, "..", "..", "skill-installer", "bin", "zabsreel.mjs");
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

const SRC_ENTRY = { command: "node", args: ["C:\\Users\\me\\Desktop\\AI_native_editor\\packages\\mcp\\dist\\index.js"] };
const PKG_ENTRY = {
  command: "C:\\Users\\me\\AppData\\Local\\Programs\\SynthCut\\SynthCut.exe",
  args: ["C:\\Users\\me\\AppData\\Local\\Programs\\SynthCut\\resources\\app\\node_modules\\@aive\\mcp\\dist\\index.js"],
  env: { ELECTRON_RUN_AS_NODE: "1" },
};
const NEW_ENTRY = { command: "node", args: ["/home/me/ZabsReel/packages/mcp/dist/index.js"] };
const OTHER_PROGRAM = { command: "npx", args: ["-y", "some-other-ai-video-editor"] };

const LEGACY_SKILL_MD = `---
name: video-editor-pro
description: Turn any AI into a professional video editor operating the SynthCut MCP editor (ai-video-editor server).
---

# Video Editor Pro — operate SynthCut like a professional
`;
const NEW_SKILL_MD = LEGACY_SKILL_MD.replace("name: video-editor-pro", "name: zabsreel-editor").replace(/SynthCut/g, "ZabsReel");
const LEGACY_SECTION = `<!-- synthcut:video-editor-pro:start -->\n\n# Video Editor Pro — operate SynthCut like a professional\n\n<!-- synthcut:video-editor-pro:end -->\n`;
const NEW_SECTION = `<!-- zabsreel:zabsreel-editor:start -->\n\n# ZabsReel Editor\n\n<!-- zabsreel:zabsreel-editor:end -->\n`;
const FORK_SKILL_MD = `---
name: synthcut-editor
description: Turn any AI into a professional video editor operating the SynthCut MCP editor (synthcut server).
---

# SynthCut Editor — operate SynthCut like a professional
`;
const FORK_SECTION = `<!-- synthcut:synthcut-editor:start -->\n\n# SynthCut Editor — operate SynthCut like a professional\n\n<!-- synthcut:synthcut-editor:end -->\n`;
// The section `add` writes today, with the real skill text.
const SKILL_BODY = (() => {
  const text = read(SKILL_SRC);
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return m ? text.slice(m[0].length) : text;
})();
const CURRENT_SECTION = `<!-- zabsreel:zabsreel-editor:start -->\n\n${SKILL_BODY.trim()}\n\n<!-- zabsreel:zabsreel-editor:end -->\n`;

const CODEX_TOML = [
  `model = "o3"`,
  ``,
  `[mcp_servers.ai-video-editor]`,
  `command = "C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Programs\\\\SynthCut\\\\SynthCut.exe"`,
  `args = ["C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Programs\\\\SynthCut\\\\resources\\\\app\\\\node_modules\\\\@aive\\\\mcp\\\\dist\\\\index.js"]`,
  ``,
  `[mcp_servers.ai-video-editor.env]`,
  `ELECTRON_RUN_AS_NODE = "1"`,
  ``,
  `# my notes server`,
  `[mcp_servers.notes]`,
  `command = "notes-mcp"`,
  ``,
].join("\n");
const CODEX_TOML_AFTER = [`model = "o3"`, ``, `# my notes server`, `[mcp_servers.notes]`, `command = "notes-mcp"`, ``].join("\n");

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

// ============================================================ Part A: Relo

interface World {
  root: string;
  home: string;
  appData: string;
  proj: string;
  localProj: string;
  env: NodeJS.ProcessEnv;
  files: Record<string, string>;
}

function makeWorld(): World {
  const root = mkdtempSync(join(tmpdir(), "zabsreel-legacy-"));
  const home = join(root, "home");
  const appData = join(root, "AppData", "Roaming");
  const proj = join(root, "proj");
  const localProj = join(root, "old-project");
  mkdirSync(localProj, { recursive: true });
  const f: Record<string, string> = {
    desktopLinux: join(home, ".config", "Claude", "claude_desktop_config.json"),
    desktopWin: join(appData, "Claude", "claude_desktop_config.json"),
    claudeJson: join(home, ".claude.json"),
    projMcp: join(proj, ".mcp.json"),
    cursor: join(home, ".cursor", "mcp.json"),
    vscodeProj: join(proj, ".vscode", "mcp.json"),
    codex: join(home, ".codex", "config.toml"),
    skillHome: join(home, ".claude", "skills", "video-editor-pro", "SKILL.md"),
    skillProj: join(proj, ".claude", "skills", "video-editor-pro", "SKILL.md"),
    skillProjNotes: join(proj, ".claude", "skills", "video-editor-pro", "notes.txt"),
    skillNew: join(home, ".claude", "skills", "zabsreel-editor", "SKILL.md"),
    skillCustom: join(home, ".claude", "skills", "video-editor-pro-custom", "SKILL.md"),
    cursorRule: join(proj, ".cursor", "rules", "synthcut-video-editor-pro.mdc"),
    cursorRuleNew: join(proj, ".cursor", "rules", "zabsreel-editor.mdc"),
    windsurfRule: join(proj, ".windsurf", "rules", "synthcut-video-editor-pro.md"),
    agentsProj: join(proj, "AGENTS.md"),
    geminiHome: join(home, ".gemini", "GEMINI.md"),
    codexAgents: join(home, ".codex", "AGENTS.md"),
  };
  // Source checkout entry + current entry + another server, 2-space indent.
  write(f.desktopLinux, JSON.stringify({ mcpServers: { "ai-video-editor": SRC_ENTRY, zabsreel: NEW_ENTRY, other: { command: "x" } }, globalShortcut: "Ctrl+Space" }, null, 2) + "\n");
  // Packaged-app entry, 4-space indent, CRLF line ends, no other server.
  write(f.desktopWin, JSON.stringify({ mcpServers: { "ai-video-editor": PKG_ENTRY } }, null, 4).replace(/\n/g, "\r\n") + "\r\n");
  // Claude Code: user scope + local scope for one project, other state kept.
  write(f.claudeJson, JSON.stringify({
    numStartups: 7,
    mcpServers: { "ai-video-editor": { type: "stdio", ...SRC_ENTRY, env: {} } },
    projects: {
      [localProj]: { allowedTools: [], mcpServers: { "ai-video-editor": { type: "stdio", ...PKG_ENTRY } } },
      "/elsewhere": { mcpServers: { zabsreel: NEW_ENTRY } },
    },
  }, null, 2));
  write(f.projMcp, JSON.stringify({ mcpServers: { "ai-video-editor": { command: "node", args: ["packages/mcp/dist/index.js"] } } }, null, 2) + "\n");
  // Same name, other program: must stay.
  write(f.cursor, JSON.stringify({ mcpServers: { "ai-video-editor": OTHER_PROGRAM } }, null, 2) + "\n");
  // JSON with comments: report only.
  write(f.vscodeProj, `{\n  // my servers\n  "servers": { "ai-video-editor": ${JSON.stringify(SRC_ENTRY)} }\n}\n`);
  write(f.codex, CODEX_TOML);
  write(f.skillHome, LEGACY_SKILL_MD);
  write(f.skillProj, LEGACY_SKILL_MD);
  write(f.skillProjNotes, "my own notes\n");
  write(f.skillNew, NEW_SKILL_MD);
  write(f.skillCustom, LEGACY_SKILL_MD);
  write(f.cursorRule, `---\ndescription: SynthCut editor\nalwaysApply: false\n---\n\n# Video Editor Pro — operate SynthCut like a professional\n`);
  write(f.cursorRuleNew, `---\ndescription: ZabsReel editor\nalwaysApply: false\n---\n\n# ZabsReel Editor\n`);
  write(f.windsurfRule, `# Video Editor Pro — operate SynthCut like a professional\n`);
  write(f.agentsProj, `# My agent rules\n\nBe brief.\n\n${LEGACY_SECTION.trimEnd()}\n\n${NEW_SECTION}`);
  write(f.geminiHome, LEGACY_SECTION);
  write(f.codexAgents, `# Codex notes\n\nUse tabs.\n\n${LEGACY_SECTION}`);
  const empty = join(root, "empty-bin");
  mkdirSync(empty, { recursive: true });
  // No `claude` CLI on PATH: ~/.claude.json is edited directly.
  return { root, home, appData, proj, localProj, env: envFor(home, appData, empty), files: f };
}

function partRelo() {
  console.log("A1. --dry-run lists the leftovers and changes nothing...");
  const w = makeWorld();
  const before = snapshot(w.root);
  const dry = run(w.env, w.proj, ["migrate", "--dry-run"]);
  check(dry.code === 0, `exit 0 (got ${dry.code})`);
  check(/Found 13 entries from Relo's SynthCut/.test(dry.out), `found 13 legacy entries\n${indent(dry.out)}`);
  check(!/ZabsReel's old name/.test(dry.out), "no entry of the fork's old name in this world");
  check(dry.out.includes("some-other-ai-video-editor") && /Left alone:/.test(dry.out), "the other program's ai-video-editor is listed as left alone");
  check(/not plain JSON/.test(dry.out), "the JSON-with-comments file is report-only");
  check(/no "zabsreel" entry yet/.test(dry.out), "notes configs that have no zabsreel entry yet");
  check(/Close Claude Code/.test(dry.out), "warns that ~/.claude.json would be edited directly");
  check(same(before, snapshot(w.root)), "no file changed");

  console.log("A2. without --yes and without a terminal, nothing changes...");
  const noTty = run(w.env, w.proj, ["migrate"]);
  check(noTty.code === 0 && /Re-run with --yes/.test(noTty.out), "prints the --yes hint");
  check(same(before, snapshot(w.root)), "no file changed");

  console.log("A3. `add` prints a hint and leaves the leftovers alone...");
  const add = run(w.env, w.proj, ["add", "--client", "claude", "--scope", "project", "--dir", w.proj]);
  check(add.code === 0 && /zabsreel migrate/.test(add.out), "add mentions `zabsreel migrate`");
  const afterAdd = snapshot(w.root);
  check(existsSync(join(w.proj, ".claude", "skills", "zabsreel-editor", "SKILL.md")), "add installed the current skill");
  check(/^name: zabsreel-editor$/m.test(read(join(w.proj, ".claude", "skills", "zabsreel-editor", "SKILL.md"))), "the installed skill is named zabsreel-editor");
  check([...before].every(([k, v]) => afterAdd.get(k) === v), "add changed none of the existing files");

  console.log("A4. --yes removes exactly the legacy entries...");
  const yes = run(w.env, w.proj, ["migrate", "--yes"]);
  check(yes.code === 0, `exit 0 (got ${yes.code})\n${indent(yes.out)}`);
  check(/Close Claude Code/.test(yes.out), "--yes prints the close-Claude-Code warning and goes on");
  const f = w.files;
  const d1 = json(f.desktopLinux);
  check(!("ai-video-editor" in d1.mcpServers) && !!d1.mcpServers.zabsreel && !!d1.mcpServers.other && d1.globalShortcut === "Ctrl+Space", "Claude Desktop (Linux): only ai-video-editor removed");
  check(read(f.desktopLinux) === JSON.stringify({ mcpServers: { zabsreel: NEW_ENTRY, other: { command: "x" } }, globalShortcut: "Ctrl+Space" }, null, 2) + "\n", "Claude Desktop (Linux): 2-space layout kept");
  check(read(f.desktopWin) === `{\r\n    "mcpServers": {}\r\n}\r\n`, "Claude Desktop (Windows, packaged entry): removed, 4-space + CRLF kept");
  const cj = json(f.claudeJson);
  check(cj.numStartups === 7 && !("ai-video-editor" in cj.mcpServers), "Claude Code user scope removed, other state kept");
  check(!("ai-video-editor" in cj.projects[w.localProj].mcpServers) && Array.isArray(cj.projects[w.localProj].allowedTools), "Claude Code local scope removed");
  check(!!cj.projects["/elsewhere"].mcpServers.zabsreel, "Claude Code: other project's zabsreel entry kept");
  check(!read(f.claudeJson).endsWith("\n"), "~/.claude.json: no trailing newline added");
  check(!("ai-video-editor" in json(f.projMcp).mcpServers), "project .mcp.json (relative path) removed");
  check(read(f.cursor) === before.get(f.cursor), "Cursor: ai-video-editor running another program kept byte-identical");
  check(read(f.vscodeProj) === before.get(f.vscodeProj), "VS Code JSONC: untouched");
  check(read(f.codex) === CODEX_TOML_AFTER, `Codex TOML: both ai-video-editor tables removed, the rest kept\n${indent(read(f.codex))}`);
  check(!existsSync(dirname(f.skillHome)), "home skill folder video-editor-pro removed");
  check(!existsSync(f.skillProj) && read(f.skillProjNotes) === "my own notes\n", "project skill: SKILL.md removed, the user's notes.txt and folder kept");
  check(read(f.skillNew) === NEW_SKILL_MD && read(f.skillCustom) === LEGACY_SKILL_MD, "zabsreel-editor and video-editor-pro-custom skills kept");
  check(!existsSync(f.cursorRule) && existsSync(f.cursorRuleNew) && !existsSync(f.windsurfRule), "Cursor/Windsurf legacy rules removed, current rule kept");
  check(read(f.agentsProj) === `# My agent rules\n\nBe brief.\n\n${NEW_SECTION}`, `AGENTS.md: legacy section removed, user text + current section kept\n${indent(read(f.agentsProj))}`);
  check(!existsSync(f.geminiHome), "GEMINI.md that held only the legacy section removed");
  check(read(f.codexAgents) === "# Codex notes\n\nUse tabs.\n", "~/.codex/AGENTS.md: section removed, user text kept");
  check(tempFiles(w.root).length === 0, "no temp files left behind");

  const backups = join(w.home, ".zabsreel", "backups");
  const [stampDir] = existsSync(backups) ? readdirSync(backups) : [];
  const manifest: { original: string; backup: string }[] = stampDir ? json(join(backups, stampDir, "manifest.json")) : [];
  check(manifest.length === 12, `12 files backed up under ~/.zabsreel/backups (got ${manifest.length})`);
  check(manifest.every((m) => before.get(m.original) === read(m.backup)), "every backup holds the original content");
  check(!existsSync(join(w.home, ".synthcut")), "nothing written under the old ~/.synthcut");

  console.log("A5. a second run finds nothing...");
  const again = run(w.env, w.proj, ["migrate", "--yes"]);
  check(again.code === 0 && /Nothing to migrate: no entries from Relo's SynthCut/.test(again.out), "nothing left to change");

  console.log("A6. the prompts: 'n' keeps everything, 'y' then 'n' at the close-Claude-Code question keeps everything, 'y' 'y' removes...");
  if (!SCRIPT_BIN) {
    console.log("  (skipped: util-linux `script` is not installed)");
  } else {
    const w2 = makeWorld();
    const b2 = snapshot(w2.root);
    const no = viaTty(w2.env, w2.proj, ["n"]);
    check(/Apply these changes\? \[y\/N\]/.test(no.stdout) && /Nothing changed/.test(no.stdout), "asks, and 'n' answers Nothing changed");
    check(same(b2, snapshot(w2.root)), "'n': no file changed");
    const notClosed = viaTty(w2.env, w2.proj, ["y", "n"]);
    check(/Is Claude Code closed\? Continue\? \[y\/N\]/.test(notClosed.stdout) && /Nothing changed/.test(notClosed.stdout), `asks to close Claude Code, and 'n' answers Nothing changed\n${indent(notClosed.stdout)}`);
    check(same(b2, snapshot(w2.root)), "'y' 'n': no file changed");
    const ok = viaTty(w2.env, w2.proj, ["y", "y"]);
    check(/removed/.test(ok.stdout) && !existsSync(w2.files.skillHome) && !("ai-video-editor" in json(w2.files.claudeJson).mcpServers), "'y' 'y': removes, ~/.claude.json included");
    rmSync(w2.root, { recursive: true, force: true });
  }

  console.log("A7. with a claude CLI on PATH, ~/.claude.json goes through `claude mcp remove`...");
  const w3 = makeWorld();
  const fake = fakeClaude(w3.root);
  const r3 = run({ ...w3.env, PATH: fake.bin }, w3.proj, ["migrate", "--yes"]);
  const calls = fake.calls();
  check(r3.code === 0, `exit 0 (got ${r3.code})`);
  check(calls.some((c) => c.args.join(" ") === "mcp remove ai-video-editor -s user"), "called `claude mcp remove ai-video-editor -s user`");
  check(calls.some((c) => c.args.join(" ") === "mcp remove ai-video-editor -s local" && c.cwd === w3.localProj), "called `-s local` from the project folder");
  check(calls.length === 2, `only the two ~/.claude.json entries went through the CLI (got ${calls.length})`);
  const cj3 = json(w3.files.claudeJson);
  check(!("ai-video-editor" in cj3.mcpServers) && !("ai-video-editor" in cj3.projects[w3.localProj].mcpServers), "both entries are gone");
  check(/removed with `claude mcp remove`/.test(r3.out), "the report says the CLI removed them");
  check(!/Close Claude Code/.test(r3.out), "no close-Claude-Code warning when the CLI does the edit");

  rmSync(w.root, { recursive: true, force: true });
  rmSync(w3.root, { recursive: true, force: true });
}

// ================================================= Part B: the fork's old name

interface Programs {
  forkCo: string; // a checkout of this app before the rename (root package "synthcut")
  zrCo: string; // a checkout after the rename (root package "zabsreel")
  reloCo: string; // Relo's checkout (root package "ai-native-video-editor")
  mono: string; // an unrelated monorepo with packages/mcp/dist/index.js
  forkApp: { exe: string; entry: string }; // packaged synthcut-desktop
  reloApp: { exe: string; entry: string }; // packaged synthcut-by-relo
  zrApp: { exe: string; entry: string }; // packaged zabsreel-desktop
  missing: string;
}

function programs(root: string): Programs {
  return {
    forkCo: checkout(join(root, "dev", "SynthCut"), "synthcut"),
    zrCo: checkout(join(root, "dev", "ZabsReel"), "zabsreel"),
    reloCo: checkout(join(root, "dev", "ai-native-video-editor"), "ai-native-video-editor"),
    mono: checkout(join(root, "dev", "monorepo"), "acme-monorepo", "@acme/mcp"),
    forkApp: packaged(join(root, "apps", "SynthCut"), "synthcut-desktop", "SynthCut"),
    reloApp: packaged(join(root, "apps", "Relo"), "synthcut-by-relo", "SynthCut"),
    zrApp: packaged(join(root, "apps", "ZabsReel"), "zabsreel-desktop", "ZabsReel"),
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
  return { root, home, appData, proj, env: envFor(home, appData, empty), p: programs(root) };
}

function partFork() {
  const b = makeBase("zabsreel-fork-");
  const { root, home, appData, proj, env, p } = b;
  // The project folder is itself a checkout of this app, so its .mcp.json's
  // relative path can be checked.
  checkout(proj, "synthcut");
  const local = coRoot(p.forkCo); // a local-scope project whose relative path is this app
  const localRelo = coRoot(p.reloCo); // and one whose relative path is Relo's checkout
  const f = {
    desktopLinux: join(home, ".config", "Claude", "claude_desktop_config.json"),
    desktopWin: join(appData, "Claude", "claude_desktop_config.json"),
    claudeJson: join(home, ".claude.json"),
    projMcp: join(proj, ".mcp.json"),
    cursor: join(home, ".cursor", "mcp.json"),
    cursorTarget: join(root, "dotfiles", "cursor-mcp.json"),
    cursorProj: join(proj, ".cursor", "mcp.json"),
    windsurf: join(home, ".codeium", "windsurf", "mcp_config.json"),
    gemini: join(home, ".gemini", "settings.json"),
    cline: join(home, ".cline", "mcp.json"),
    vscodeUser: join(home, ".config", "Code", "User", "mcp.json"),
    codex: join(home, ".codex", "config.toml"),
    skillHome: join(home, ".claude", "skills", "synthcut-editor", "SKILL.md"),
    skillProj: join(proj, ".claude", "skills", "synthcut-editor", "SKILL.md"),
    skillCustom: join(home, ".claude", "skills", "synthcut-editor-custom", "SKILL.md"),
    skillNew: join(home, ".claude", "skills", "zabsreel-editor", "SKILL.md"),
    cursorRule: join(proj, ".cursor", "rules", "synthcut-editor.mdc"),
    windsurfRule: join(proj, ".windsurf", "rules", "synthcut-editor.md"),
    cursorRuleNew: join(proj, ".cursor", "rules", "zabsreel-editor.mdc"),
    agentsProj: join(proj, "AGENTS.md"),
    geminiHome: join(home, ".gemini", "GEMINI.md"),
    codexAgents: join(home, ".codex", "AGENTS.md"),
  };
  const forkEntry = { command: "node", args: [p.forkCo], env: { AIVE_DATA_DIR: "/data/x" }, timeout: 5 };
  // Rule 3: renamed in place, other keys and their order kept. Mode 0640.
  const desktopBefore = { mcpServers: { before: { command: "a" }, synthcut: forkEntry, after: { command: "b" } }, theme: "dark" };
  write(f.desktopLinux, JSON.stringify(desktopBefore, null, 2) + "\n");
  chmodSync(f.desktopLinux, 0o640);
  // Fingerprint failures: a missing path, Relo's checkout, Relo's packaged app, an unrelated monorepo.
  write(f.desktopWin, JSON.stringify({ mcpServers: { synthcut: { command: "node", args: [p.missing] } } }, null, 2) + "\n");
  write(f.gemini, JSON.stringify({ mcpServers: { synthcut: { command: "node", args: [p.reloCo] } } }, null, 2) + "\n");
  write(f.cline, JSON.stringify({ mcpServers: { synthcut: { command: p.reloApp.exe, args: [p.reloApp.entry], env: { ELECTRON_RUN_AS_NODE: "1" } } } }, null, 2) + "\n");
  write(f.vscodeUser, JSON.stringify({ servers: { synthcut: { command: "node", args: [p.mono] } } }, null, 2) + "\n");
  // Rule 5 (both are this app), in a symlinked config.
  write(f.cursorTarget, JSON.stringify({ mcpServers: { synthcut: { command: "node", args: [p.forkCo] }, zabsreel: { command: "node", args: [p.zrCo] } } }, null, 2) + "\n");
  mkdirSync(dirname(f.cursor), { recursive: true });
  symlinkSync(f.cursorTarget, f.cursor);
  // Rule 6: zabsreel already runs another program.
  write(f.windsurf, JSON.stringify({ mcpServers: { synthcut: { command: "node", args: [p.forkCo] }, zabsreel: OTHER_PROGRAM } }, null, 2) + "\n");
  // A relative path in a project config, resolved against the project.
  write(f.projMcp, JSON.stringify({ mcpServers: { synthcut: { command: "node", args: ["packages/mcp/dist/index.js"] } } }, null, 2) + "\n");
  // Rule 4 without --entry: a packaged old app is left alone.
  write(f.cursorProj, JSON.stringify({ mcpServers: { synthcut: { command: p.forkApp.exe, args: [p.forkApp.entry], env: { ELECTRON_RUN_AS_NODE: "1" } } } }, null, 2) + "\n");
  // Claude Code: user scope (absolute), a local scope with a relative path into
  // this app, and one with a relative path into Relo's checkout.
  write(f.claudeJson, JSON.stringify({
    numStartups: 3,
    mcpServers: { synthcut: { type: "stdio", command: "node", args: [p.forkCo], env: {} } },
    projects: {
      [local]: { allowedTools: ["x"], mcpServers: { other: { command: "o" }, synthcut: { type: "stdio", command: "node", args: ["packages/mcp/dist/index.js"] } } },
      [localRelo]: { mcpServers: { synthcut: { type: "stdio", command: "node", args: ["packages/mcp/dist/index.js"] } } },
    },
  }, null, 2));
  // Codex: the main table and an env sub-table, plus another server.
  const codexBefore = [
    `model = "o3"`,
    ``,
    `[mcp_servers.synthcut]`,
    `command = "node"`,
    `args = [${JSON.stringify(p.forkCo)}]`,
    ``,
    `[mcp_servers.synthcut.env]`,
    `AIVE_DATA_DIR = "/data/x"`,
    `FOO = "bar"`,
    ``,
    `# notes`,
    `[mcp_servers.notes]`,
    `command = "notes-mcp"`,
    ``,
  ].join("\n");
  write(f.codex, codexBefore);
  write(f.skillHome, FORK_SKILL_MD);
  write(f.skillProj, FORK_SKILL_MD.replace("name: synthcut-editor", "name: my-own-skill"));
  write(f.skillCustom, FORK_SKILL_MD);
  write(f.skillNew, NEW_SKILL_MD);
  write(f.cursorRule, `---\ndescription: Turn any AI into a professional video editor operating the SynthCut MCP editor (synthcut server).\nalwaysApply: false\n---\n\n# SynthCut Editor\n`);
  write(f.windsurfRule, `# SynthCut Editor — operate SynthCut like a professional\n`);
  write(f.cursorRuleNew, `---\ndescription: ZabsReel editor\nalwaysApply: false\n---\n\n# ZabsReel Editor\n`);
  write(f.agentsProj, `# Rules\n\nBe brief.\n\n${FORK_SECTION}\n## After\n\nMore.\n`);
  write(f.geminiHome, `# Mine\n\n${FORK_SECTION}\n${NEW_SECTION}`);
  write(f.codexAgents, `# Codex notes\n\nUse tabs.\n`);
  // An existing ~/.zabsreel with a wide mode: migrate narrows it to 0700.
  mkdirSync(join(home, ".zabsreel"), { recursive: true });
  chmodSync(join(home, ".zabsreel"), 0o755);

  const notBackups = (q: string) => q.startsWith(join(home, ".zabsreel"));
  const before = snapshot(root, notBackups);
  const beforeBytes = new Map([...before.keys()].filter((k) => !before.get(k)!.startsWith("link:")).map((k) => [k, readFileSync(k)]));

  console.log("B1. --dry-run lists the fork's entries and the ones it leaves alone, and changes nothing...");
  const dry = run(env, proj, ["migrate", "--dry-run"]);
  check(dry.code === 0, `exit 0 (got ${dry.code})`);
  check(/Found 11 entries from SynthCut, ZabsReel's old name:/.test(dry.out), `found 11 entries of the old name\n${indent(dry.out)}`);
  check(!/from Relo's SynthCut:/.test(dry.out), "no Relo entries in this world");
  const leftAlone = (file: string, re: RegExp) => new RegExp(`${re.source}[^\\n]*\\n\\s+${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(dry.out);
  check(leftAlone(f.desktopWin, /cannot confirm it is ZabsReel \([^)]*does not exist/), "a missing path is left alone");
  check(leftAlone(f.gemini, /cannot confirm it is ZabsReel \([^)]*names "ai-native-video-editor"/), "Relo's checkout (ai-native-video-editor) is left alone");
  check(leftAlone(f.cline, /cannot confirm it is ZabsReel \([^)]*names "synthcut-by-relo"/), "Relo's packaged app (synthcut-by-relo) is left alone");
  check(leftAlone(f.vscodeUser, /cannot confirm it is ZabsReel \([^)]*names "@acme\/mcp"/), "an unrelated monorepo's packages/mcp/dist/index.js is left alone");
  check(leftAlone(f.claudeJson, /cannot confirm it is ZabsReel \([^)]*ai-native-video-editor/), "a local scope whose relative path is Relo's checkout is left alone");
  check(leftAlone(f.windsurf, /a different program already uses the name "zabsreel"/), "rule 6: zabsreel running another program is reported");
  check(leftAlone(f.cursorProj, /runs an installed SynthCut app[^\n]*Connect AI[^\n]*--entry/), "rule 4 without --entry: reported with the Connect AI hint");
  check(leftAlone(f.skillProj, /its name is not "synthcut-editor"/), "a synthcut-editor folder holding another skill is left alone");
  check(/Close Claude Code/.test(dry.out), "warns that ~/.claude.json would be edited directly");
  check(same(before, snapshot(root, notBackups)), "no file changed");
  check(!existsSync(join(home, ".zabsreel", "backups")), "no backup folder made");

  console.log("B2. --yes applies rules 1-6, keeps formatting, mode and symlinks...");
  const yes = run(env, proj, ["migrate", "--yes"]);
  check(yes.code === 0, `exit 0 (got ${yes.code})\n${indent(yes.out)}`);
  const desktopAfter = { mcpServers: { before: { command: "a" }, zabsreel: forkEntry, after: { command: "b" } }, theme: "dark" };
  check(read(f.desktopLinux) === JSON.stringify(desktopAfter, null, 2) + "\n", `rule 3: synthcut renamed to zabsreel in place, fields and key order kept\n${indent(read(f.desktopLinux))}`);
  check(mode(f.desktopLinux) === 0o640, `the rewritten file kept mode 0640 (got ${mode(f.desktopLinux).toString(8)})`);
  for (const k of ["desktopWin", "gemini", "cline", "vscodeUser", "windsurf", "cursorProj"] as const) {
    check(read(f[k]) === before.get(f[k]), `${k}: left byte-identical`);
  }
  check(lstatSync(f.cursor).isSymbolicLink() && realpathSync(f.cursor) === realpathSync(f.cursorTarget), "the symlinked Cursor config is still a link to the same file");
  check(read(f.cursorTarget) === JSON.stringify({ mcpServers: { zabsreel: { command: "node", args: [p.zrCo] } } }, null, 2) + "\n", "rule 5: the link's target lost synthcut and kept zabsreel");
  check(read(f.projMcp) === JSON.stringify({ mcpServers: { zabsreel: { command: "node", args: ["packages/mcp/dist/index.js"] } } }, null, 2) + "\n", "project .mcp.json: the relative entry renamed");
  const cj = json(f.claudeJson);
  check(cj.numStartups === 3 && JSON.stringify(cj.mcpServers) === JSON.stringify({ zabsreel: { type: "stdio", command: "node", args: [p.forkCo], env: {} } }), "~/.claude.json user scope renamed, other state kept");
  check(
    JSON.stringify(cj.projects[local]) === JSON.stringify({ allowedTools: ["x"], mcpServers: { other: { command: "o" }, zabsreel: { type: "stdio", command: "node", args: ["packages/mcp/dist/index.js"] } } }),
    "~/.claude.json local scope (relative path, checked against the project key) renamed in place",
  );
  check(!!cj.projects[localRelo].mcpServers.synthcut && !cj.projects[localRelo].mcpServers.zabsreel, "~/.claude.json local scope pointing at Relo's checkout kept");
  check(read(f.codex) === codexBefore.replace("[mcp_servers.synthcut]", "[mcp_servers.zabsreel]").replace("[mcp_servers.synthcut.env]", "[mcp_servers.zabsreel.env]"), `Codex TOML: both tables renamed, nothing else changed\n${indent(read(f.codex))}`);
  checkTomlParses(
    f.codex,
    (v) =>
      !v.mcp_servers.synthcut &&
      v.mcp_servers.zabsreel.command === "node" &&
      JSON.stringify(v.mcp_servers.zabsreel.args) === JSON.stringify([p.forkCo]) &&
      JSON.stringify(v.mcp_servers.zabsreel.env) === JSON.stringify({ AIVE_DATA_DIR: "/data/x", FOO: "bar" }) &&
      v.mcp_servers.notes.command === "notes-mcp",
    "Codex TOML still parses and the env values are unchanged",
  );
  check(!existsSync(dirname(f.skillHome)), "the home synthcut-editor skill folder removed");
  check(read(f.skillProj) === before.get(f.skillProj) && read(f.skillCustom) === FORK_SKILL_MD && read(f.skillNew) === NEW_SKILL_MD, "other skills kept");
  check(!existsSync(f.cursorRule) && !existsSync(f.windsurfRule) && existsSync(f.cursorRuleNew), "Cursor/Windsurf synthcut-editor rules removed, the current rule kept");
  check(read(f.agentsProj) === `# Rules\n\nBe brief.\n\n${CURRENT_SECTION}\n## After\n\nMore.\n`, `AGENTS.md: the old section replaced with the current skill in place\n${indent(read(f.agentsProj).slice(0, 400))}`);
  check(read(f.geminiHome) === `# Mine\n\n${NEW_SECTION}`, `GEMINI.md that already had the current section: the old one removed\n${indent(read(f.geminiHome))}`);
  check(read(f.codexAgents) === before.get(f.codexAgents), "an AGENTS.md without a section untouched");
  check(tempFiles(root).length === 0, `no temp files left behind (${tempFiles(root).join(", ")})`);
  check(/install the current skill \(zabsreel-editor\)/.test(yes.out), "suggests `add` after removing an old skill copy");

  const zr = join(home, ".zabsreel");
  const backups = join(zr, "backups");
  const stamps = existsSync(backups) ? readdirSync(backups) : [];
  const stampDir = join(backups, stamps[0] ?? "none");
  const manifestFile = join(stampDir, "manifest.json");
  const manifest: { original: string; backup: string }[] = existsSync(manifestFile) ? json(manifestFile) : [];
  check(stamps.length === 1, `one backup folder (got ${stamps.length})`);
  if (process.platform !== "win32") {
    check(mode(zr) === 0o700, `~/.zabsreel narrowed to 0700 (got ${mode(zr).toString(8)})`);
    check(mode(backups) === 0o700, `~/.zabsreel/backups is 0700 (got ${mode(backups).toString(8)})`);
    check(mode(stampDir) === 0o700, `the backup folder is 0700 (got ${existsSync(stampDir) ? mode(stampDir).toString(8) : "missing"})`);
    check(existsSync(manifestFile) && mode(manifestFile) === 0o600, `manifest.json is 0600 (got ${existsSync(manifestFile) ? mode(manifestFile).toString(8) : "missing"})`);
  }
  check(manifest.length === 10, `10 files backed up (got ${manifest.length})`);
  check(manifest.every((m) => Object.keys(m).sort().join() === "backup,original"), "the manifest holds only original and backup paths");
  check(manifest.every((m) => before.get(m.original)?.replace(/^link:/, "") === read(m.backup)), "every backup holds the original content");

  console.log("B3. a second run finds nothing and changes nothing...");
  const afterYes = snapshot(root);
  const again = run(env, proj, ["migrate", "--yes"]);
  check(again.code === 0 && /Nothing to migrate/.test(again.out), `nothing left to change\n${indent(again.out)}`);
  check(same(afterYes, snapshot(root)), `no file changed, no new backup folder (${diff(afterYes, snapshot(root))})`);

  console.log("B4. --restore puts every file back byte for byte...");
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

  console.log("B5. --restore refuses a manifest entry outside the backup folder...");
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

  rmSync(root, { recursive: true, force: true });
}

// ============================================== Part C: packaged and --entry

function partEntry() {
  const { root, home, proj, env, p } = makeBase("zabsreel-entry-");
  const desktop = join(home, ".config", "Claude", "claude_desktop_config.json");
  const codex = join(home, ".codex", "config.toml");
  const oldPkg = { command: p.forkApp.exe, args: [p.forkApp.entry], env: { ELECTRON_RUN_AS_NODE: "1", EXTRA: "x" }, timeout: 30 };
  write(desktop, JSON.stringify({ mcpServers: { a: { command: "a" }, synthcut: oldPkg, z: { command: "z" } } }, null, 2) + "\n");
  const codexBefore = [
    `[mcp_servers.synthcut]`,
    `command = ${JSON.stringify(p.forkApp.exe)}`,
    `args = [`,
    `  ${JSON.stringify(p.forkApp.entry)},`,
    `]`,
    `startup_timeout_sec = 20`,
    ``,
    `[mcp_servers.synthcut.env]`,
    `ELECTRON_RUN_AS_NODE = "1"`,
    `EXTRA = "x"`,
    ``,
  ].join("\n");
  write(codex, codexBefore);
  const entryFile = (command: string, args: string[]) => {
    const file = join(root, `entry-${Math.random().toString(36).slice(2)}.json`);
    write(file, JSON.stringify({ mcpServers: { zabsreel: { command, args, env: { ELECTRON_RUN_AS_NODE: "1" } } } }, null, 2));
    return file;
  };
  const before = snapshot(home);

  console.log("C1. a packaged synthcut entry without --entry is left alone and reported...");
  const r1 = run(env, proj, ["migrate", "--yes"]);
  check(r1.code === 0 && /Nothing to migrate/.test(r1.out) && /Connect AI/.test(r1.out) && /--entry/.test(r1.out), `left alone, with the Connect AI / --entry hint\n${indent(r1.out)}`);
  check(same(before, snapshot(home)), "no file changed");

  console.log("C2. an --entry whose command does not exist changes nothing...");
  const r2 = run(env, proj, ["migrate", "--yes", "--entry", entryFile(join(root, "apps", "ZabsReel", "missing.exe"), [p.zrApp.entry])]);
  check(r2.code !== 0 && /does not exist/.test(r2.out) && /Nothing changed/.test(r2.out), `refused\n${indent(r2.out)}`);
  check(same(before, snapshot(home)), "no file changed");

  console.log("C3. an --entry that names the old app (synthcut-desktop), not ZabsReel, changes nothing...");
  const r3 = run(env, proj, ["migrate", "--yes", "--entry", entryFile(p.forkApp.exe, [p.forkApp.entry])]);
  check(r3.code !== 0 && /installed ZabsReel app/.test(r3.out), `refused\n${indent(r3.out)}`);
  check(same(before, snapshot(home)), "no file changed");

  console.log("C4. a valid --entry: zabsreel gets the new command and args, synthcut's other env and fields are kept, synthcut is removed...");
  const r4 = run(env, proj, ["migrate", "--yes", "--entry", entryFile(p.zrApp.exe, [p.zrApp.entry])]);
  check(r4.code === 0, `exit 0 (got ${r4.code})\n${indent(r4.out)}`);
  const want = { a: { command: "a" }, zabsreel: { command: p.zrApp.exe, args: [p.zrApp.entry], env: { ELECTRON_RUN_AS_NODE: "1", EXTRA: "x" }, timeout: 30 }, z: { command: "z" } };
  check(read(desktop) === JSON.stringify({ mcpServers: want }, null, 2) + "\n", `Claude Desktop: replaced at the same position\n${indent(read(desktop))}`);
  const wantToml = [
    `[mcp_servers.zabsreel]`,
    `command = ${JSON.stringify(p.zrApp.exe)}`,
    `args = [${JSON.stringify(p.zrApp.entry)}]`,
    `startup_timeout_sec = 20`,
    ``,
    `[mcp_servers.zabsreel.env]`,
    `ELECTRON_RUN_AS_NODE = "1"`,
    `EXTRA = "x"`,
    ``,
  ].join("\n");
  check(read(codex) === wantToml, `Codex TOML: command and args replaced, the rest kept\n${indent(read(codex))}`);
  checkTomlParses(
    codex,
    (v) =>
      !v.mcp_servers.synthcut &&
      v.mcp_servers.zabsreel.command === p.zrApp.exe &&
      JSON.stringify(v.mcp_servers.zabsreel.args) === JSON.stringify([p.zrApp.entry]) &&
      v.mcp_servers.zabsreel.startup_timeout_sec === 20 &&
      JSON.stringify(v.mcp_servers.zabsreel.env) === JSON.stringify({ ELECTRON_RUN_AS_NODE: "1", EXTRA: "x" }),
    "Codex TOML parses with the new entry",
  );
  const r5 = run(env, proj, ["migrate", "--yes", "--entry", entryFile(p.zrApp.exe, [p.zrApp.entry])]);
  check(r5.code === 0 && /Nothing to migrate/.test(r5.out), "a second run finds nothing");
  rmSync(root, { recursive: true, force: true });
}

// ================================= Part D: rules in TOML and ~/.claude.json

function partRules() {
  console.log("D. rules 2, 5 and 6 in Codex TOML and ~/.claude.json, and TOML forms it does not edit...");
  const tomlCase = (label: string, body: (p: Programs) => string, expect: ((before: string, p: Programs) => string) | null, outRe: RegExp) => {
    const { root, home, proj, env, p } = makeBase("zabsreel-toml-");
    const file = join(home, ".codex", "config.toml");
    const text = body(p);
    write(file, text);
    const r = run(env, proj, ["migrate", "--yes"]);
    const want = expect ? expect(text, p) : text;
    check(read(file) === want && outRe.test(r.out), `${label}\n${indent(read(file))}\n${indent(r.out)}`);
    if (expect) checkTomlParses(file, (v) => !v.mcp_servers?.synthcut, `${label}: still parses`);
    rmSync(root, { recursive: true, force: true });
  };
  const table = (key: string, entry: string) => `[mcp_servers.${key}]\ncommand = "node"\nargs = [${JSON.stringify(entry)}]\n`;
  tomlCase(
    "TOML rule 5: synthcut removed when zabsreel is this app",
    (p) => `${table("synthcut", p.forkCo)}\n[mcp_servers.synthcut.env]\nA = "1"\n\n${table("zabsreel", p.zrCo)}`,
    (_, p) => table("zabsreel", p.zrCo),
    /✔ removed/,
  );
  tomlCase("TOML rule 6: nothing written when zabsreel is another program", (p) => `${table("synthcut", p.forkCo)}\n[mcp_servers.zabsreel]\ncommand = "npx"\nargs = ["other"]\n`, null, /a different program already uses the name "zabsreel"/);
  tomlCase("TOML rule 2: Relo's checkout left alone", (p) => table("synthcut", p.reloCo), null, /cannot confirm it is ZabsReel/);
  tomlCase("TOML: quoted header forms renamed", (p) => `[mcp_servers."synthcut"]\ncommand = "node"\nargs = [${JSON.stringify(p.forkCo)}]\n\n[mcp_servers.'synthcut'.env]\nA = "1"\n`, (t) => t.replace(`"synthcut"`, `"zabsreel"`).replace(`'synthcut'`, `'zabsreel'`), /✔ renamed/);
  tomlCase("TOML: an inline table is reported, not edited", (p) => `[mcp_servers]\nsynthcut = { command = "node", args = [${JSON.stringify(p.forkCo)}] }\n`, null, /edit it by hand/);
  tomlCase("TOML: dotted keys are reported, not edited", (p) => `mcp_servers.synthcut.command = "node"\nmcp_servers.synthcut.args = [${JSON.stringify(p.forkCo)}]\n`, null, /edit it by hand/);

  // A checkout whose root is named like this app but whose packages/mcp is another package.
  {
    const { root, home, proj, env } = makeBase("zabsreel-mcpname-");
    const entry = checkout(join(root, "dev", "lookalike"), "zabsreel", "@other/mcp");
    const file = join(home, ".cursor", "mcp.json");
    write(file, JSON.stringify({ mcpServers: { synthcut: { command: "node", args: [entry] } } }, null, 2) + "\n");
    const text = read(file);
    const r = run(env, proj, ["migrate", "--yes"]);
    check(read(file) === text && /names "@other\/mcp"/.test(r.out), `a checkout whose packages/mcp is not @aive/mcp is left alone\n${indent(r.out)}`);
    rmSync(root, { recursive: true, force: true });
  }

  // ~/.claude.json: user scope rule 5, local scope rule 6, direct edit.
  const { root, home, proj, env, p } = makeBase("zabsreel-claude-");
  const local = join(root, "projA");
  mkdirSync(local, { recursive: true });
  const file = join(home, ".claude.json");
  write(file, JSON.stringify({
    mcpServers: { synthcut: { command: "node", args: [p.forkCo] }, zabsreel: { command: "node", args: [p.zrCo] } },
    projects: { [local]: { mcpServers: { synthcut: { command: "node", args: [p.forkCo] }, zabsreel: OTHER_PROGRAM } } },
  }, null, 2));
  const r = run(env, proj, ["migrate", "--yes"]);
  const cj = json(file);
  check(r.code === 0 && !cj.mcpServers.synthcut && !!cj.mcpServers.zabsreel, "~/.claude.json user scope, rule 5: synthcut removed");
  check(JSON.stringify(cj.projects[local].mcpServers) === JSON.stringify({ synthcut: { command: "node", args: [p.forkCo] }, zabsreel: OTHER_PROGRAM }), "~/.claude.json local scope, rule 6: nothing written");
  rmSync(root, { recursive: true, force: true });
}

// ================================================ Part E: the Claude Code CLI

function partCli() {
  console.log("E. with a claude CLI: add-json, confirm, and only then remove...");
  const { root, home, proj, env, p } = makeBase("zabsreel-cli-");
  const local = join(root, "projA");
  mkdirSync(local, { recursive: true });
  const file = join(home, ".claude.json");
  const S = { type: "stdio", command: "node", args: [p.forkCo], env: { AIVE_DATA_DIR: "/d" } };
  const start = JSON.stringify({ numStartups: 1, mcpServers: { synthcut: S }, projects: { [local]: { mcpServers: { synthcut: S } } } }, null, 2);
  write(file, start);
  const fake = fakeClaude(root);
  const cliEnv = { ...env, PATH: fake.bin };
  const verbs = (from: number) => fake.calls().slice(from).map((c) => `${c.args[1]} ${c.args[2]} ${c.args[c.args.indexOf("-s") + 1]}`);

  const r1 = run(cliEnv, proj, ["migrate", "--yes"], { extraEnv: { FAKE_CLAUDE_ADD: "fail" } });
  check(r1.code !== 0 && read(file) === start, `add fails: exit non-zero and ~/.claude.json unchanged (synthcut still there)\n${indent(r1.out)}`);
  check(verbs(0).join() === "add-json zabsreel user,add-json zabsreel local", `add fails: no remove was called (${verbs(0).join()})`);
  check(!/Close Claude Code/.test(r1.out), "the CLI route does not ask to close Claude Code");

  let n = fake.calls().length;
  const r2 = run(cliEnv, proj, ["migrate", "--yes"], { extraEnv: { FAKE_CLAUDE_ADD: "lie" } });
  check(r2.code !== 0 && read(file) === start && verbs(n).every((v) => v.startsWith("add-json")), `add reports success but writes nothing: not confirmed, nothing removed (${verbs(n).join()})`);

  n = fake.calls().length;
  const r3 = run(cliEnv, proj, ["migrate", "--yes"], { extraEnv: { FAKE_CLAUDE_REMOVE: "fail" } });
  const cj3 = json(file);
  check(r3.code !== 0 && /both entries exist/.test(r3.out), `add works, remove fails: reported\n${indent(r3.out)}`);
  check(!!cj3.mcpServers.synthcut && !!cj3.mcpServers.zabsreel && !!cj3.projects[local].mcpServers.synthcut && !!cj3.projects[local].mcpServers.zabsreel, "add works, remove fails: both keys exist in both scopes");
  check(verbs(n).join() === "add-json zabsreel user,remove synthcut user,add-json zabsreel local,remove synthcut local", `add-json before remove in each scope (${verbs(n).join()})`);
  const added = fake.calls().slice(n).find((c) => c.args[1] === "add-json");
  check(!!added && JSON.stringify(JSON.parse(added.args[3])) === JSON.stringify(S), "add-json got synthcut's entry unchanged");
  check(fake.calls().slice(n).filter((c) => c.args[1] === "add-json" && c.args.includes("local")).every((c) => c.cwd === local), "-s local runs from the project folder");

  n = fake.calls().length;
  const r4 = run(cliEnv, proj, ["migrate", "--yes"]);
  const cj4 = json(file);
  check(r4.code === 0 && verbs(n).join() === "remove synthcut user,remove synthcut local", `the next run removes synthcut (rule 5) without adding (${verbs(n).join()})\n${indent(r4.out)}`);
  check(!cj4.mcpServers.synthcut && !cj4.projects[local].mcpServers.synthcut && cj4.mcpServers.zabsreel?.args?.[0] === p.forkCo && cj4.numStartups === 1, "synthcut gone, zabsreel kept, other state kept");
  const r5 = run(cliEnv, proj, ["migrate", "--yes"]);
  check(/Nothing to migrate/.test(r5.out), "then nothing is left");
  rmSync(root, { recursive: true, force: true });
}

// ================================================ Part F: the checkout move

function partMove() {
  console.log("F. checkout move: stale paths are reported, and rewritten only to a ZabsReel checkout...");
  const { root, home, proj, env, p } = makeBase("zabsreel-move-");
  const old = join(root, "old", "SynthCut");
  const oldEntry = join(old, "packages", "mcp", "dist", "index.js");
  const desktop = join(home, ".config", "Claude", "claude_desktop_config.json");
  const cursor = join(home, ".cursor", "mcp.json");
  const codex = join(home, ".codex", "config.toml");
  write(desktop, JSON.stringify({ mcpServers: { synthcut: { command: "node", args: [oldEntry] } } }, null, 2) + "\n");
  write(cursor, JSON.stringify({ mcpServers: { zabsreel: { command: "node", args: [oldEntry] } } }, null, 2) + "\n");
  const codexBefore = `[mcp_servers.zabsreel]\ncommand = "node"\nargs = [${JSON.stringify(oldEntry)}]\n`;
  write(codex, codexBefore);
  const before = snapshot(home);

  const dry = run(env, proj, ["migrate", "--dry-run"]);
  const staleCount = (dry.out.match(/stale path/g) ?? []).length;
  check(staleCount === 3 && /--from-checkout/.test(dry.out), `without the flags: all three stale paths reported (got ${staleCount})\n${indent(dry.out)}`);
  check(same(before, snapshot(home)), "nothing changed");

  const bad = run(env, proj, ["migrate", "--yes", "--from-checkout", old, "--to-checkout", coRoot(p.mono)]);
  check(/is not a ZabsReel checkout/.test(bad.out) && same(before, snapshot(home)), `--to-checkout that fails the fingerprint: nothing rewritten\n${indent(bad.out)}`);
  const relo = run(env, proj, ["migrate", "--yes", "--from-checkout", old, "--to-checkout", coRoot(p.reloCo)]);
  check(/is not a ZabsReel checkout/.test(relo.out) && same(before, snapshot(home)), "--to-checkout Relo's checkout: nothing rewritten");

  const ok = run(env, proj, ["migrate", "--yes", "--from-checkout", old, "--to-checkout", coRoot(p.zrCo)]);
  check(ok.code === 0, `exit 0 (got ${ok.code})\n${indent(ok.out)}`);
  check(read(desktop) === JSON.stringify({ mcpServers: { zabsreel: { command: "node", args: [p.zrCo] } } }, null, 2) + "\n", `synthcut into the old checkout: path rewritten and renamed\n${indent(read(desktop))}`);
  check(read(cursor) === JSON.stringify({ mcpServers: { zabsreel: { command: "node", args: [p.zrCo] } } }, null, 2) + "\n", "zabsreel into the old checkout: path rewritten");
  check(read(codex) === codexBefore.replace(JSON.stringify(oldEntry), JSON.stringify(p.zrCo)), `Codex TOML: path rewritten\n${indent(read(codex))}`);
  const again = run(env, proj, ["migrate", "--yes", "--from-checkout", old, "--to-checkout", coRoot(p.zrCo)]);
  check(/Nothing to migrate/.test(again.out), "a second run finds nothing");
  rmSync(root, { recursive: true, force: true });
}

function main() {
  partRelo();
  partFork();
  partEntry();
  partRules();
  partCli();
  partMove();
  if (failures) {
    console.log(`\nLEGACY MIGRATE SMOKE TEST FAILED (${failures} check(s))`);
    process.exit(1);
  }
  console.log("\nLEGACY MIGRATE SMOKE TEST PASSED");
}

main();
