#!/usr/bin/env node
/**
 * zabsreel — installer for the ZabsReel "zabsreel-editor" AI skill.
 *
 *   npx @azabonik/zabsreel                 interactive: pick client + scope
 *   npx @azabonik/zabsreel add --client claude --scope project
 *   npx @azabonik/zabsreel add --client codex  --scope global --force
 *   ("skill" and "install" are accepted aliases for "add")
 *   npx @azabonik/zabsreel migrate         remove what Relo's SynthCut left
 *                                          ("ai-video-editor" server, "video-editor-pro" skill),
 *                                          and rename this app's entries from its old name
 *   npx @azabonik/zabsreel migrate --restore <backup folder>
 *
 * The skill itself is one markdown file (skill/SKILL.md in this package).
 * What differs per AI client is WHERE it lives and what wrapper it needs;
 * this CLI owns that mapping so users never have to.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { PRODUCT_NAME, MCP_KEY, SKILL_NAME, LEGACY } from "./brand.mjs";
import {
  findLegacy,
  removeLegacy,
  directClaudeEdits,
  readEntryFile,
  checkoutMove,
  newBackupDir,
  readManifest,
  restoreBackup,
  LEGACY_SERVER,
  LEGACY_SKILL,
  MARK_START,
  MARK_END,
} from "./legacy.mjs";

const CLIENTS = {
  claude: "Claude Code (skill file)",
  cursor: "Cursor (project rule)",
  codex: "Codex CLI (AGENTS.md)",
  gemini: "Gemini CLI (GEMINI.md)",
  windsurf: "Windsurf (rules file)",
  agents: "Other / generic agent (AGENTS.md)",
};
const SCOPES = { project: "This project only", global: "Global (all projects, this machine)" };

// ---------------------------------------------------------------- skill text

const skillPath = join(dirname(fileURLToPath(import.meta.url)), "..", "skill", "SKILL.md");
const rawSkill = readFileSync(skillPath, "utf8");

/** Split the Claude-style frontmatter off the markdown body. */
function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return { description: "", body: text };
  const desc = /description:\s*([\s\S]*?)(?:\r?\n\w|$)/.exec(m[1]);
  return { description: (desc?.[1] ?? "").replace(/\s+/g, " ").trim(), body: text.slice(m[0].length) };
}

// ------------------------------------------------------------------ plumbing

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force" || a === "-f") args.force = true;
    else if (a === "--yes" || a === "-y") args.yes = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--client") args.client = argv[++i];
    else if (a === "--scope") args.scope = argv[++i];
    else if (a === "--dir") args.dir = argv[++i];
    else if (a === "--entry") args.entry = argv[++i];
    else if (a === "--from-checkout") args.fromCheckout = argv[++i];
    else if (a === "--to-checkout") args.toCheckout = argv[++i];
    else if (a === "--restore") args.restore = argv[++i];
    else args._.push(a);
  }
  return args;
}

async function pick(rl, title, options) {
  const keys = Object.keys(options);
  console.log(`\n${title}`);
  keys.forEach((k, i) => console.log(`  ${i + 1}. ${options[k]}`));
  for (;;) {
    const answer = (await rl.question("> ")).trim();
    const idx = Number(answer) - 1;
    if (keys[idx]) return keys[idx];
    if (options[answer]) return answer;
    console.log(`Enter 1-${keys.length}.`);
  }
}

function writeFileSafe(path, content, force) {
  if (existsSync(path) && !force) {
    throw new Error(`${path} already exists. Re-run with --force to overwrite.`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

/** The marked section that holds the skill inside a shared file (AGENTS.md/GEMINI.md). */
const sectionFor = (body) => `${MARK_START}\n\n${body.trim()}\n\n${MARK_END}\n`;

/** Insert/replace the marked section inside a shared file. */
function upsertSection(path, body) {
  const section = sectionFor(body);
  let out;
  if (existsSync(path)) {
    const cur = readFileSync(path, "utf8");
    const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}\\n?`);
    out = re.test(cur) ? cur.replace(re, section) : `${cur.trimEnd()}\n\n${section}`;
  } else {
    out = section;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, out, "utf8");
  return path;
}

// ------------------------------------------------------------------- install

function install(client, scope, projectDir, force) {
  const home = homedir();
  const { description, body } = splitFrontmatter(rawSkill);

  switch (client) {
    case "claude": {
      const base = scope === "global" ? join(home, ".claude") : join(projectDir, ".claude");
      return writeFileSafe(join(base, "skills", SKILL_NAME, "SKILL.md"), rawSkill, force);
    }
    case "cursor": {
      if (scope === "global") {
        console.log(
          "\nCursor has no global rules directory. Open Cursor → Settings → Rules →" +
            " 'User Rules' and paste the contents of the skill there.\n" +
            `Skill source: ${skillPath}`,
        );
        return null;
      }
      const mdc = `---\ndescription: ${description}\nalwaysApply: false\n---\n\n${body}`;
      return writeFileSafe(join(projectDir, ".cursor", "rules", `${SKILL_NAME}.mdc`), mdc, force);
    }
    case "codex":
      return upsertSection(
        scope === "global" ? join(home, ".codex", "AGENTS.md") : join(projectDir, "AGENTS.md"),
        body,
      );
    case "gemini":
      return upsertSection(
        scope === "global" ? join(home, ".gemini", "GEMINI.md") : join(projectDir, "GEMINI.md"),
        body,
      );
    case "windsurf": {
      if (scope === "global") {
        console.log(
          "\nWindsurf global rules live in the app (Settings → Cascade → Memories & Rules)." +
            ` Paste the skill there.\nSkill source: ${skillPath}`,
        );
        return null;
      }
      return writeFileSafe(join(projectDir, ".windsurf", "rules", `${SKILL_NAME}.md`), body, force);
    }
    case "agents":
      return upsertSection(
        scope === "global" ? join(home, "AGENTS.md") : join(projectDir, "AGENTS.md"),
        body,
      );
    default:
      throw new Error(`Unknown client "${client}". Valid: ${Object.keys(CLIENTS).join(", ")}`);
  }
}

// ---------------------------------------------------------------------- main

const HELP = `zabsreel — install the ${PRODUCT_NAME} ${SKILL_NAME} AI skill

Usage:
  zabsreel [add] [--client <name>] [--scope <project|global>] [--dir <path>] [--force]
  zabsreel migrate [--dir <path>] [--entry <file>] [--from-checkout <old> --to-checkout <new>] [--yes | --dry-run]
  zabsreel migrate --restore <backup folder> [--yes | --dry-run]

Options:
  --client   ${Object.keys(CLIENTS).join(" | ")}
  --scope    project | global
  --dir      target project directory (default: current directory)
  --force    overwrite an existing skill/rule file
  -h, --help show this help

migrate looks in AI client configs and skill folders for what earlier versions
left behind, and changes it only after you confirm (or with --yes):
  - Relo's SynthCut: the MCP server "${LEGACY_SERVER}" (only when it runs an MCP
    server of that shape) and the skill "${LEGACY_SKILL}" are removed.
  - ${LEGACY.productName}, this app's old name: the MCP server "${LEGACY.mcpKey}" is renamed to
    "${MCP_KEY}" when the files next to its entry show it is this app; the skill
    "${LEGACY.skillName}" is removed and its AGENTS.md / GEMINI.md sections are
    replaced with "${SKILL_NAME}".
  --entry <file>   the JSON from ${PRODUCT_NAME} → Connect AI, saved to a file: replaces
                   a "${LEGACY.mcpKey}" entry that runs an installed ${LEGACY.productName} app
  --from-checkout <old> --to-checkout <new>
                   rewrite entries that point into a checkout folder that moved
Every file it changes is copied to ~/.zabsreel/backups/<time>/ first;
migrate --restore <that folder> puts them back. --dry-run only lists.

Run with no flags for interactive prompts.`;

const plural = (n, one, many) => (n === 1 ? one : many);

function printLegacy({ found, skipped }) {
  const groups = [
    [found.filter((f) => f.gen === "upstream"), "from Relo's SynthCut"],
    [found.filter((f) => f.gen === "fork"), `from ${LEGACY.productName}, ${PRODUCT_NAME}'s old name`],
  ];
  let n = 0;
  for (const [items, label] of groups) {
    if (!items.length) continue;
    console.log(`Found ${items.length} ${plural(items.length, "entry", "entries")} ${label}:`);
    for (const f of items) {
      console.log(`  ${++n}. ${f.client}: ${f.what}\n     ${f.file}`);
      if (f.hasNewKey === false) console.log(`     (this file has no "${MCP_KEY}" entry yet: copy one from Connect AI in the app)`);
    }
  }
  if (skipped.length) {
    console.log(`Left alone:`);
    for (const s of skipped) console.log(`  - ${s.client}: ${s.reason}\n    ${s.file}`);
  }
}

const CLOSE_CLAUDE =
  "Close Claude Code before going on: this edits ~/.claude.json directly, and a running\n" +
  "Claude Code writes its own copy of that file back, which would undo the change.";

// One reader for every question, so answers typed ahead are not lost.
let prompt = null;

/** Ask a yes/no question. Without a terminal the answer is no. */
async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  if (!prompt) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    prompt = { rl, lines: rl[Symbol.asyncIterator]() };
  }
  process.stdout.write(`${question} [y/N] `);
  const { value, done } = await prompt.lines.next();
  const answer = done ? "" : String(value).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function closePrompt() {
  prompt?.rl.close();
  prompt = null;
}

async function migrate(args, projectDir) {
  const home = homedir();
  if (args.restore) return restore(args, home);
  if (!!args.fromCheckout !== !!args.toCheckout) {
    console.error("--from-checkout and --to-checkout go together.");
    process.exitCode = 1;
    return;
  }
  let entry = null;
  if (args.entry) {
    const e = readEntryFile(resolve(args.entry));
    if (!e.ok) {
      console.error(`--entry ${args.entry}: ${e.reason}. Nothing changed.`);
      process.exitCode = 1;
      return;
    }
    entry = e.entry;
  }
  let move = null;
  if (args.fromCheckout) {
    move = checkoutMove(args.fromCheckout, args.toCheckout);
    if (!move.toOk) console.log(`--to-checkout ${move.to} is not a ${PRODUCT_NAME} checkout (${move.toReason}); no path is rewritten.`);
  }

  const scan = findLegacy({ home, projectDir, entry, move });
  if (!scan.found.length) {
    console.log(
      `Nothing to migrate: no entries from Relo's SynthCut ("${LEGACY_SERVER}", "${LEGACY_SKILL}")` +
        ` or ${LEGACY.productName} ("${LEGACY.mcpKey}", "${LEGACY.skillName}") to change.`,
    );
    printLegacy(scan);
    return;
  }
  printLegacy(scan);
  const direct = directClaudeEdits(scan.found).length > 0;
  if (args.dryRun) {
    if (direct) console.log(`\n${CLOSE_CLAUDE}`);
    return;
  }
  if (!args.yes) {
    if (!process.stdin.isTTY) {
      console.log("\nNothing changed. Re-run with --yes to apply these changes.");
      return;
    }
    if (!(await confirm(`\nApply ${plural(scan.found.length, "this change", "these changes")}?`))) {
      console.log("Nothing changed.");
      return;
    }
  }
  if (direct) {
    console.log(`\n${CLOSE_CLAUDE}`);
    if (!args.yes && !(await confirm("Is Claude Code closed? Continue?"))) {
      console.log("Nothing changed.");
      return;
    }
  }
  const backupDir = newBackupDir(home, "migrate");
  const { body } = splitFrontmatter(rawSkill);
  const results = removeLegacy(scan.found, { backupDir, newSection: sectionFor(body), claudeDirect: direct });
  for (const r of results) {
    const verb = r.finding.verb ?? "changed";
    console.log(`${r.ok ? `✔ ${verb}` : "✖ not changed"}: ${r.finding.client}: ${r.finding.what}${r.note ? ` (${r.note})` : ""}\n  ${r.finding.file}`);
  }
  if (results.some((r) => r.ok && r.finding.kind === "file" && r.finding.gen === "fork")) {
    console.log(`\nTo install the current skill (${SKILL_NAME}), run: npx @azabonik/zabsreel add`);
  }
  if (existsSync(backupDir)) {
    console.log(`\nBackups of the changed files: ${backupDir}`);
    console.log(`To undo: npx @azabonik/zabsreel migrate --restore "${backupDir}"`);
  }
  console.log("Restart those AI clients to pick up the change.");
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

async function restore(args, home) {
  const dir = resolve(args.restore);
  const { entries, errors } = readManifest(dir);
  if (errors.length) {
    for (const e of errors) console.error(`✖ ${e}`);
    console.error("Nothing restored.");
    process.exitCode = 1;
    return;
  }
  if (!entries.length) {
    console.log(`${join(dir, "manifest.json")} lists no files. Nothing restored.`);
    return;
  }
  console.log(`Restore ${entries.length} ${plural(entries.length, "file", "files")} from ${dir}:`);
  for (const e of entries) console.log(`  ${e.original}${e.exists ? "" : " (will be created)"}`);
  if (args.dryRun) return;
  if (!args.yes) {
    if (!process.stdin.isTTY) {
      console.log("\nNothing changed. Re-run with --yes to restore them.");
      return;
    }
    if (!(await confirm(`\nRestore ${plural(entries.length, "it", "them")}?`))) {
      console.log("Nothing changed.");
      return;
    }
  }
  if (entries.some((e) => /^\.claude\.json$/.test(basename(e.original)))) {
    console.log(`\n${CLOSE_CLAUDE}`);
    if (!args.yes && !(await confirm("Is Claude Code closed? Continue?"))) {
      console.log("Nothing changed.");
      return;
    }
  }
  const { backupDir, results } = restoreBackup(entries, { home });
  for (const r of results) console.log(`${r.ok ? "✔ restored" : "✖ not restored"}: ${r.original}${r.note ? ` (${r.note})` : ""}`);
  if (backupDir) console.log(`\nThe files as they were before this restore: ${backupDir}`);
  console.log("Restart those AI clients to pick up the change.");
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  const cmd = args._[0] ?? "add";
  if (cmd === "migrate") return migrate(args, resolve(args.dir ?? process.cwd()));
  if (!["add", "skill", "install"].includes(cmd)) {
    console.error(`Unknown command "${cmd}".\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  let { client, scope } = args;
  if (!client || !scope) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`${PRODUCT_NAME} skill installer — makes your AI a professional video editor.`);
    client ??= await pick(rl, "Which AI client?", CLIENTS);
    scope ??= await pick(rl, "Install where?", SCOPES);
    rl.close();
  }
  if (!SCOPES[scope]) throw new Error(`Unknown scope "${scope}". Valid: project, global`);

  const projectDir = resolve(args.dir ?? process.cwd());
  const written = install(client, scope, projectDir, args.force ?? false);
  if (written) {
    console.log(`\n✔ Installed ${SKILL_NAME} for ${CLIENTS[client]} (${scope}):\n  ${written}`);
    console.log("Restart/reload your AI client to pick it up.");
  }
  const legacy = findLegacy({ home: homedir(), projectDir }).found;
  if (legacy.length) {
    console.log(
      `\nFound ${legacy.length} ${plural(legacy.length, "entry", "entries")} from an earlier version` +
        ` (Relo's SynthCut "${LEGACY_SERVER}" / "${LEGACY_SKILL}", or ${LEGACY.productName} "${LEGACY.mcpKey}" / "${LEGACY.skillName}").` +
        `\nTo review and change ${plural(legacy.length, "it", "them")}, run: npx @azabonik/zabsreel migrate${args.dir ? ` --dir "${projectDir}"` : ""}`,
    );
  }
}

main()
  .catch((err) => {
    console.error(`\n✖ ${err.message}`);
    process.exitCode = 1;
  })
  .finally(closePrompt);
