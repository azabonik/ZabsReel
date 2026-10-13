/**
 * Smoke test: `synthcut migrate` (packages/skill-installer) removes what Relo's
 * SynthCut left on a machine, and nothing else.
 *
 * Builds fake HOME / APPDATA / project folders holding the old MCP server entry
 * "ai-video-editor" (source and packaged forms) in Claude Desktop, Claude Code,
 * Codex (TOML), Cursor and VS Code configs, the old "video-editor-pro" skill
 * files and marked sections, plus look-alikes that must stay: an
 * "ai-video-editor" that runs some other program, the new "synthcut" entries,
 * other servers and keys, a JSON file with comments, a skill folder with an
 * extra file. Then checks:
 *   - --dry-run and a run without --yes (no terminal) change nothing,
 *   - the answer "n" at the prompt changes nothing, "y" removes,
 *   - --yes removes exactly the legacy entries, keeps formatting (indentation,
 *     CRLF), and backs every changed file up (manifest.json),
 *   - a second run finds nothing,
 *   - `add` only prints a hint,
 *   - with a `claude` CLI on PATH, ~/.claude.json entries go through
 *     `claude mcp remove <name> -s user|local`.
 *
 * Self-contained, no network, no FFmpeg. Never touches the real home folder.
 * Run: npx tsx packages/core/scripts/smoke-legacy-migrate.ts
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(here, "..", "..", "skill-installer", "bin", "synthcut.mjs");

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

const SRC_ENTRY = { command: "node", args: ["C:\\Users\\me\\Desktop\\AI_native_editor\\packages\\mcp\\dist\\index.js"] };
const PKG_ENTRY = {
  command: "C:\\Users\\me\\AppData\\Local\\Programs\\SynthCut\\SynthCut.exe",
  args: ["C:\\Users\\me\\AppData\\Local\\Programs\\SynthCut\\resources\\app\\node_modules\\@aive\\mcp\\dist\\index.js"],
  env: { ELECTRON_RUN_AS_NODE: "1" },
};
const NEW_ENTRY = { command: "node", args: ["/home/me/SynthCut/packages/mcp/dist/index.js"] };
const OTHER_PROGRAM = { command: "npx", args: ["-y", "some-other-ai-video-editor"] };

const LEGACY_SKILL_MD = `---
name: video-editor-pro
description: Turn any AI into a professional video editor operating the SynthCut MCP editor (ai-video-editor server).
---

# Video Editor Pro — operate SynthCut like a professional
`;
const NEW_SKILL_MD = LEGACY_SKILL_MD.replace("name: video-editor-pro", "name: synthcut-editor");
const LEGACY_SECTION = `<!-- synthcut:video-editor-pro:start -->\n\n# Video Editor Pro — operate SynthCut like a professional\n\n<!-- synthcut:video-editor-pro:end -->\n`;
const NEW_SECTION = `<!-- synthcut:synthcut-editor:start -->\n\n# SynthCut Editor\n\n<!-- synthcut:synthcut-editor:end -->\n`;

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
  const root = mkdtempSync(join(tmpdir(), "aive-legacy-"));
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
    skillNew: join(home, ".claude", "skills", "synthcut-editor", "SKILL.md"),
    skillCustom: join(home, ".claude", "skills", "video-editor-pro-custom", "SKILL.md"),
    cursorRule: join(proj, ".cursor", "rules", "synthcut-video-editor-pro.mdc"),
    cursorRuleNew: join(proj, ".cursor", "rules", "synthcut-editor.mdc"),
    windsurfRule: join(proj, ".windsurf", "rules", "synthcut-video-editor-pro.md"),
    agentsProj: join(proj, "AGENTS.md"),
    geminiHome: join(home, ".gemini", "GEMINI.md"),
    codexAgents: join(home, ".codex", "AGENTS.md"),
  };
  // Source checkout entry + new entry + another server, 2-space indent.
  write(f.desktopLinux, JSON.stringify({ mcpServers: { "ai-video-editor": SRC_ENTRY, synthcut: NEW_ENTRY, other: { command: "x" } }, globalShortcut: "Ctrl+Space" }, null, 2) + "\n");
  // Packaged-app entry, 4-space indent, CRLF line ends, no other server.
  write(f.desktopWin, JSON.stringify({ mcpServers: { "ai-video-editor": PKG_ENTRY } }, null, 4).replace(/\n/g, "\r\n") + "\r\n");
  // Claude Code: user scope + local scope for one project, other state kept.
  write(f.claudeJson, JSON.stringify({
    numStartups: 7,
    mcpServers: { "ai-video-editor": { type: "stdio", ...SRC_ENTRY, env: {} } },
    projects: {
      [localProj]: { allowedTools: [], mcpServers: { "ai-video-editor": { type: "stdio", ...PKG_ENTRY } } },
      "/elsewhere": { mcpServers: { synthcut: NEW_ENTRY } },
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
  write(f.cursorRuleNew, `---\ndescription: SynthCut editor\nalwaysApply: false\n---\n\n# SynthCut Editor\n`);
  write(f.windsurfRule, `# Video Editor Pro — operate SynthCut like a professional\n`);
  write(f.agentsProj, `# My agent rules\n\nBe brief.\n\n${LEGACY_SECTION.trimEnd()}\n\n${NEW_SECTION}`);
  write(f.geminiHome, LEGACY_SECTION);
  write(f.codexAgents, `# Codex notes\n\nUse tabs.\n\n${LEGACY_SECTION}`);
  const empty = join(root, "empty-bin");
  mkdirSync(empty, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    PATH: empty, // no `claude` CLI: ~/.claude.json is edited directly
    LANG: "C.UTF-8",
  };
  return { root, home, appData, proj, localProj, env, files: f };
}

function run(w: World, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { env: opts.env ?? w.env, cwd: w.proj, encoding: "utf8", input: opts.input ?? "" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function snapshot(w: World): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(p, read(p));
    }
  };
  walk(w.root);
  return out;
}
const same = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

function main() {
  console.log("1. --dry-run lists the leftovers and changes nothing...");
  const w = makeWorld();
  const before = snapshot(w);
  const dry = run(w, ["migrate", "--dry-run"]);
  check(dry.code === 0, `exit 0 (got ${dry.code})`);
  check(/Found 13 entries/.test(dry.out), `found 13 legacy entries\n${dry.out.replace(/^/gm, "       ")}`);
  check(dry.out.includes("some-other-ai-video-editor") && /Left alone:/.test(dry.out), "the other program's ai-video-editor is listed as left alone");
  check(/not plain JSON/.test(dry.out), "the JSON-with-comments file is report-only");
  check(/no "synthcut" entry yet/.test(dry.out), "notes configs that have no synthcut entry yet");
  check(same(before, snapshot(w)), "no file changed");

  console.log("2. without --yes and without a terminal, nothing changes...");
  const noTty = run(w, ["migrate"]);
  check(noTty.code === 0 && /Re-run with --yes/.test(noTty.out), "prints the --yes hint");
  check(same(before, snapshot(w)), "no file changed");

  console.log("3. `add` prints a hint and leaves the leftovers alone...");
  const add = run(w, ["add", "--client", "claude", "--scope", "project", "--dir", w.proj]);
  check(add.code === 0 && /synthcut migrate/.test(add.out), "add mentions `synthcut migrate`");
  const afterAdd = snapshot(w);
  check(existsSync(join(w.proj, ".claude", "skills", "synthcut-editor", "SKILL.md")), "add installed the new skill");
  check([...before].every(([k, v]) => afterAdd.get(k) === v), "add changed none of the existing files");

  console.log("4. --yes removes exactly the legacy entries...");
  const yes = run(w, ["migrate", "--yes"]);
  check(yes.code === 0, `exit 0 (got ${yes.code})\n${yes.out.replace(/^/gm, "       ")}`);
  const f = w.files;
  const d1 = json(f.desktopLinux);
  check(!("ai-video-editor" in d1.mcpServers) && !!d1.mcpServers.synthcut && !!d1.mcpServers.other && d1.globalShortcut === "Ctrl+Space", "Claude Desktop (Linux): only ai-video-editor removed");
  check(read(f.desktopLinux) === JSON.stringify({ mcpServers: { synthcut: NEW_ENTRY, other: { command: "x" } }, globalShortcut: "Ctrl+Space" }, null, 2) + "\n", "Claude Desktop (Linux): 2-space layout kept");
  check(read(f.desktopWin) === `{\r\n    "mcpServers": {}\r\n}\r\n`, "Claude Desktop (Windows, packaged entry): removed, 4-space + CRLF kept");
  const cj = json(f.claudeJson);
  check(cj.numStartups === 7 && !("ai-video-editor" in cj.mcpServers), "Claude Code user scope removed, other state kept");
  check(!("ai-video-editor" in cj.projects[w.localProj].mcpServers) && Array.isArray(cj.projects[w.localProj].allowedTools), "Claude Code local scope removed");
  check(!!cj.projects["/elsewhere"].mcpServers.synthcut, "Claude Code: other project's synthcut entry kept");
  check(!read(f.claudeJson).endsWith("\n"), "~/.claude.json: no trailing newline added");
  check(!("ai-video-editor" in json(f.projMcp).mcpServers), "project .mcp.json (relative path) removed");
  check(read(f.cursor) === before.get(f.cursor), "Cursor: ai-video-editor running another program kept byte-identical");
  check(read(f.vscodeProj) === before.get(f.vscodeProj), "VS Code JSONC: untouched");
  check(read(f.codex) === CODEX_TOML_AFTER, `Codex TOML: both ai-video-editor tables removed, the rest kept\n${read(f.codex).replace(/^/gm, "       | ")}`);
  check(!existsSync(dirname(f.skillHome)), "home skill folder video-editor-pro removed");
  check(!existsSync(f.skillProj) && read(f.skillProjNotes) === "my own notes\n", "project skill: SKILL.md removed, the user's notes.txt and folder kept");
  check(read(f.skillNew) === NEW_SKILL_MD && read(f.skillCustom) === LEGACY_SKILL_MD, "synthcut-editor and video-editor-pro-custom skills kept");
  check(!existsSync(f.cursorRule) && existsSync(f.cursorRuleNew) && !existsSync(f.windsurfRule), "Cursor/Windsurf legacy rules removed, new rule kept");
  check(read(f.agentsProj) === `# My agent rules\n\nBe brief.\n\n${NEW_SECTION}`, `AGENTS.md: legacy section removed, user text + new section kept\n${read(f.agentsProj).replace(/^/gm, "       | ")}`);
  check(!existsSync(f.geminiHome), "GEMINI.md that held only the legacy section removed");
  check(read(f.codexAgents) === "# Codex notes\n\nUse tabs.\n", "~/.codex/AGENTS.md: section removed, user text kept");

  const backups = join(w.home, ".synthcut", "backups");
  const [stampDir] = existsSync(backups) ? readdirSync(backups) : [];
  const manifest: { original: string; backup: string }[] = stampDir ? json(join(backups, stampDir, "manifest.json")) : [];
  check(manifest.length === 12, `12 files backed up (got ${manifest.length})`);
  check(manifest.every((m) => before.get(m.original) === read(m.backup)), "every backup holds the original content");

  console.log("5. a second run finds nothing...");
  const again = run(w, ["migrate", "--yes"]);
  check(again.code === 0 && /No entries from Relo's SynthCut/.test(again.out), "nothing left to remove");

  console.log("6. the prompt: 'n' keeps everything, 'y' removes...");
  // util-linux `script`, by absolute path: the test env's PATH holds no programs.
  const scriptBin = spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" }).stdout?.trim() ?? "";
  if (!scriptBin) {
    console.log("  (skipped: util-linux `script` is not installed)");
  } else {
    const w2 = makeWorld();
    const b2 = snapshot(w2);
    const viaTty = (answer: string) => {
      const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} migrate`;
      // `script` gives the installer a terminal; the answer arrives on it.
      return spawnSync(scriptBin, ["-qec", cmd, "/dev/null"], { env: w2.env, cwd: w2.proj, encoding: "utf8", input: `${answer}\n`, timeout: 30000 });
    };
    const no = viaTty("n");
    check(/Remove them\? \[y\/N\]/.test(no.stdout) && /Nothing changed/.test(no.stdout), "asks, and 'n' answers Nothing changed");
    check(same(b2, snapshot(w2)), "'n': no file changed");
    const ok = viaTty("y");
    check(/removed/.test(ok.stdout) && !existsSync(w2.files.skillHome), "'y': removes");
    rmSync(w2.root, { recursive: true, force: true });
  }

  console.log("7. with a claude CLI on PATH, ~/.claude.json goes through `claude mcp remove`...");
  const w3 = makeWorld();
  const fakeBin = join(w3.root, "fake-bin");
  const log = join(w3.root, "claude-calls.log");
  mkdirSync(fakeBin, { recursive: true });
  // A stand-in for Claude Code's CLI: logs its arguments and cwd, then removes
  // the named server from the scope it was asked for.
  write(join(fakeBin, "fake-claude.mjs"), `
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
const [, , sub, verb, name, flag, scope] = process.argv;
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
const file = join(process.env.HOME, ".claude.json");
const data = JSON.parse(readFileSync(file, "utf8"));
const servers = scope === "user" ? data.mcpServers : data.projects[process.cwd()].mcpServers;
delete servers[name];
writeFileSync(file, JSON.stringify(data, null, 2));
`);
  write(join(fakeBin, "claude"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(fakeBin, "fake-claude.mjs"))} "$@"\n`);
  chmodSync(join(fakeBin, "claude"), 0o755);
  const r3 = run(w3, ["migrate", "--yes"], { env: { ...w3.env, PATH: fakeBin } });
  const calls = existsSync(log) ? read(log).trim().split("\n").map((l) => JSON.parse(l)) : [];
  check(r3.code === 0, `exit 0 (got ${r3.code})`);
  check(calls.some((c) => c.args.join(" ") === "mcp remove ai-video-editor -s user"), "called `claude mcp remove ai-video-editor -s user`");
  check(calls.some((c) => c.args.join(" ") === "mcp remove ai-video-editor -s local" && c.cwd === w3.localProj), "called `-s local` from the project folder");
  check(calls.length === 2, `only the two ~/.claude.json entries went through the CLI (got ${calls.length})`);
  const cj3 = json(w3.files.claudeJson);
  check(!("ai-video-editor" in cj3.mcpServers) && !("ai-video-editor" in cj3.projects[w3.localProj].mcpServers), "both entries are gone");
  check(/removed with `claude mcp remove`/.test(r3.out), "the report says the CLI removed them");

  rmSync(w.root, { recursive: true, force: true });
  rmSync(w3.root, { recursive: true, force: true });
  if (failures) {
    console.log(`\nLEGACY MIGRATE SMOKE TEST FAILED (${failures} check(s))`);
    process.exit(1);
  }
  console.log("\nLEGACY MIGRATE SMOKE TEST PASSED");
}

main();
