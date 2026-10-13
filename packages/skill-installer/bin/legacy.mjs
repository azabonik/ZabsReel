/**
 * Finds and removes what Relo's SynthCut left on a machine: its MCP server
 * entry "ai-video-editor" in AI client configs, and its "video-editor-pro"
 * skill files (written by @relo-video/synthcut, the installer this package
 * replaces).
 *
 * Safety rules:
 *   - An MCP entry is removed only when its name is exactly "ai-video-editor"
 *     AND its command or args run SynthCut's MCP entry point
 *     (…/packages/mcp/dist/index.js from a checkout, or
 *     …/node_modules/@aive/mcp/dist/index.js in the packaged app).
 *   - A skill file is removed only at the exact path the old installer used,
 *     and only when it is that skill (frontmatter name, marker or "SynthCut").
 *   - Every file is copied to a backup folder before it changes.
 *   - A file that cannot be parsed (for example JSON with comments) is only
 *     reported, never changed.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync, rmdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename, delimiter } from "node:path";
import { spawnSync } from "node:child_process";

export const LEGACY_SERVER = "ai-video-editor";
export const LEGACY_SKILL = "video-editor-pro";
const MARK_START = `<!-- synthcut:${LEGACY_SKILL}:start -->`;
const MARK_END = `<!-- synthcut:${LEGACY_SKILL}:end -->`;

// The MCP entry point of the old app: <checkout>/packages/mcp/dist/index.js, or
// <app>/resources/app[.asar]/node_modules/@aive/mcp/dist/index.js when packaged.
const LEGACY_ENTRY = /(?:^|\/)(?:packages|@aive)\/mcp\/dist\/index\.js$/i;

function pointsAtLegacyEntry(value) {
  if (typeof value !== "string") return false;
  const v = value.trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/");
  if (LEGACY_ENTRY.test(v)) return true;
  // A command written as one string ("node /path/to/index.js").
  return v.split(/\s+/).some((t) => LEGACY_ENTRY.test(t.replace(/^["']|["']$/g, "")));
}

/** True when an MCP server entry runs the old SynthCut MCP entry point. */
export function isLegacyServer(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  return [entry.command, ...args].some(pointsAtLegacyEntry);
}

function describeServer(entry) {
  const parts = [entry?.command, ...(Array.isArray(entry?.args) ? entry.args : [])].filter((p) => typeof p === "string");
  return parts.join(" ");
}

function readText(file) {
  try {
    if (!statSync(file).isFile()) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ locations

/** Every place an AI client keeps MCP servers, for this home and project. */
function jsonConfigs({ home, projectDir, env }) {
  const userDirs = [...new Set([env.APPDATA, join(home, "Library", "Application Support"), env.XDG_CONFIG_HOME || join(home, ".config")].filter(Boolean))];
  const list = [
    ...userDirs.map((d) => ({ client: "Claude Desktop", file: join(d, "Claude", "claude_desktop_config.json"), key: "mcpServers" })),
    { client: "Claude Code", file: join(home, ".claude.json"), key: "mcpServers", claudeCode: true },
    { client: "Claude Code (project .mcp.json)", file: join(projectDir, ".mcp.json"), key: "mcpServers" },
    { client: "Cursor", file: join(home, ".cursor", "mcp.json"), key: "mcpServers" },
    { client: "Cursor (project)", file: join(projectDir, ".cursor", "mcp.json"), key: "mcpServers" },
    { client: "Windsurf", file: join(home, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" },
    { client: "Gemini CLI", file: join(home, ".gemini", "settings.json"), key: "mcpServers" },
    { client: "Gemini CLI (project)", file: join(projectDir, ".gemini", "settings.json"), key: "mcpServers" },
    { client: "Cline", file: join(home, ".cline", "mcp.json"), key: "mcpServers" },
    ...userDirs.map((d) => ({
      client: "Cline (VS Code)",
      file: join(d, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
      key: "mcpServers",
    })),
    ...userDirs.map((d) => ({ client: "VS Code", file: join(d, "Code", "User", "mcp.json"), key: "servers" })),
    { client: "VS Code (project)", file: join(projectDir, ".vscode", "mcp.json"), key: "servers" },
  ];
  const seen = new Set();
  return list.filter((c) => (seen.has(c.file) ? false : (seen.add(c.file), true)));
}

/** Files the old installer wrote the skill into (see @relo-video/synthcut 0.1.x). */
function skillTargets({ home, projectDir, env }) {
  const bases = [...new Set([home, projectDir])];
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  return {
    skillFiles: bases.map((b) => join(b, ".claude", "skills", LEGACY_SKILL, "SKILL.md")),
    ruleFiles: [
      { client: "Cursor rule", file: join(projectDir, ".cursor", "rules", `synthcut-${LEGACY_SKILL}.mdc`) },
      { client: "Windsurf rule", file: join(projectDir, ".windsurf", "rules", `synthcut-${LEGACY_SKILL}.md`) },
    ],
    sectionFiles: [...new Set([
      join(projectDir, "AGENTS.md"),
      join(projectDir, "GEMINI.md"),
      join(codexHome, "AGENTS.md"),
      join(home, ".gemini", "GEMINI.md"),
      join(home, "AGENTS.md"),
    ])],
  };
}

// --------------------------------------------------------------------- TOML

const TOML_HEADER = /^\s*\[\[?[^\]]*\]\]?\s*(?:#.*)?$/;
const LEGACY_TOML_HEADER = new RegExp(
  `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${LEGACY_SERVER}"|'${LEGACY_SERVER}'|${LEGACY_SERVER})\\s*(\\.[^\\]]*)?\\]\\s*(?:#.*)?$`,
);
const isBlank = (l) => l.trim() === "";
const isComment = (l) => /^\s*#/.test(l);

/** The string values in a TOML snippet, with basic-string escapes undone. */
function tomlStrings(text) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]);
  return out;
}

/**
 * Line ranges [start, end) of the [mcp_servers.ai-video-editor] table and its
 * sub-tables, when that table runs the old entry point. A range ends after the
 * table's last key line, so comments above the next table stay.
 */
function legacyTomlRanges(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = LEGACY_TOML_HEADER.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !TOML_HEADER.test(lines[j])) j++;
    let end = j;
    while (end > i + 1 && (isBlank(lines[end - 1]) || isComment(lines[end - 1]))) end--;
    blocks.push({ start: i, end, sub: !!m[1], text: lines.slice(i + 1, end).join("\n") });
  }
  const main = blocks.find((b) => !b.sub);
  if (!main || !tomlStrings(main.text).some(pointsAtLegacyEntry)) return { ranges: [], mentioned: blocks.length > 0 };
  return { ranges: blocks.map((b) => [b.start, b.end]), mentioned: true };
}

function removeTomlRanges(text, ranges) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const drop = new Set();
  for (const [start, end0] of ranges) {
    let end = end0;
    // Take the blank lines after the table too when a blank line already
    // separates what comes before, so no double gap is left behind.
    if (start === 0 || isBlank(lines[start - 1])) while (end < lines.length - 1 && isBlank(lines[end])) end++;
    for (let i = start; i < end; i++) drop.add(i);
  }
  return lines.filter((_, i) => !drop.has(i)).join(eol);
}

// ----------------------------------------------------------------------- scan

/**
 * Look for leftovers of the old app. Returns
 *   { found: [...removable], skipped: [...left alone, with a reason] }.
 */
export function findLegacy({ home, projectDir, env = process.env }) {
  const found = [];
  const skipped = [];

  for (const cfg of jsonConfigs({ home, projectDir, env })) {
    const text = readText(cfg.file);
    if (text === null || !text.includes(LEGACY_SERVER)) continue;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      skipped.push({ client: cfg.client, file: cfg.file, reason: `mentions "${LEGACY_SERVER}" but is not plain JSON (comments?); edit it by hand` });
      continue;
    }
    const spots = [{ path: [cfg.key], scope: "user" }];
    if (cfg.claudeCode && data && typeof data.projects === "object" && data.projects) {
      for (const p of Object.keys(data.projects)) spots.push({ path: ["projects", p, cfg.key], scope: "local", project: p });
    }
    for (const spot of spots) {
      const servers = spot.path.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), data);
      if (!servers || typeof servers !== "object" || !(LEGACY_SERVER in servers)) continue;
      const entry = servers[LEGACY_SERVER];
      const where = spot.project ? `${cfg.client} (project ${spot.project})` : cfg.client;
      if (isLegacyServer(entry)) {
        found.push({
          kind: "json",
          client: where,
          file: cfg.file,
          path: [...spot.path, LEGACY_SERVER],
          claudeCode: !!cfg.claudeCode,
          scope: spot.scope,
          project: spot.project,
          hasSynthcut: "synthcut" in servers,
          what: `MCP server "${LEGACY_SERVER}": ${describeServer(entry)}`,
        });
      } else {
        skipped.push({ client: where, file: cfg.file, reason: `"${LEGACY_SERVER}" does not run SynthCut's MCP server (${describeServer(entry) || "no command"})` });
      }
    }
  }

  const codexToml = join(env.CODEX_HOME || join(home, ".codex"), "config.toml");
  const toml = readText(codexToml);
  if (toml !== null && toml.includes(LEGACY_SERVER)) {
    const { ranges, mentioned } = legacyTomlRanges(toml.split(/\r?\n/));
    if (ranges.length) {
      found.push({ kind: "toml", client: "Codex CLI", file: codexToml, what: `[mcp_servers.${LEGACY_SERVER}]`, hasSynthcut: /\[\s*mcp_servers\s*\.\s*"?synthcut"?\s*\]/.test(toml) });
    } else {
      skipped.push({
        client: "Codex CLI",
        file: codexToml,
        reason: mentioned
          ? `[mcp_servers.${LEGACY_SERVER}] does not run SynthCut's MCP server`
          : `mentions "${LEGACY_SERVER}" in a form this tool does not edit; edit it by hand`,
      });
    }
  }

  const { skillFiles, ruleFiles, sectionFiles } = skillTargets({ home, projectDir, env });
  for (const file of skillFiles) {
    const text = readText(file);
    if (text === null) continue;
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const name = fm && /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fm[1]);
    if (name && name[1] === LEGACY_SKILL) found.push({ kind: "file", client: "Claude Code skill", file, what: `skill "${LEGACY_SKILL}"`, removeDirIfEmpty: true });
    else skipped.push({ client: "Claude Code skill", file, reason: `its name is not "${LEGACY_SKILL}"` });
  }
  for (const { client, file } of ruleFiles) {
    const text = readText(file);
    if (text === null) continue;
    if (/synthcut/i.test(text)) found.push({ kind: "file", client, file, what: `rule for skill "${LEGACY_SKILL}"` });
    else skipped.push({ client, file, reason: "does not look like the SynthCut skill" });
  }
  for (const file of sectionFiles) {
    const text = readText(file);
    if (text === null) continue;
    const s = text.indexOf(MARK_START);
    if (s >= 0 && text.indexOf(MARK_END, s) > s) {
      found.push({ kind: "section", client: /GEMINI\.md$/.test(file) ? "Gemini CLI" : "Codex / agents", file, what: `section ${MARK_START}` });
    }
  }
  return { found, skipped };
}

// --------------------------------------------------------------------- remove

function writeJsonLike(file, original, data) {
  const indent = /^([ \t]+)"/m.exec(original)?.[1] ?? "  ";
  let out = JSON.stringify(data, null, indent);
  if (original.includes("\r\n")) out = out.replace(/\n/g, "\r\n");
  if (/\r?\n$/.test(original)) out += original.endsWith("\r\n") ? "\r\n" : "\n";
  writeFileSync(file, out, "utf8");
}

function deleteAt(data, path) {
  const parent = path.slice(0, -1).reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), data);
  const key = path[path.length - 1];
  if (!parent || typeof parent !== "object" || !(key in parent) || !isLegacyServer(parent[key])) return false;
  delete parent[key];
  return true;
}

function findOnPath(cmd, env) {
  const names = process.platform === "win32" ? [`${cmd}.exe`, `${cmd}.cmd`, `${cmd}.bat`] : [cmd];
  for (const dir of (env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      try {
        if (statSync(join(dir, name)).isFile()) return join(dir, name);
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

function stillThere(file, path) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const parent = path.slice(0, -1).reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), data);
    return !!parent && typeof parent === "object" && path[path.length - 1] in parent;
  } catch {
    return true;
  }
}

/**
 * Remove the findings. Every touched file is first copied into `backupDir`
 * (with a manifest.json mapping backups to the original paths). Claude Code's
 * ~/.claude.json goes through `claude mcp remove` when the claude CLI is on
 * PATH, and is edited directly otherwise.
 * Returns [{ finding, ok, note }].
 */
export function removeLegacy(found, { backupDir, env = process.env }) {
  const results = [];
  const manifest = [];
  const backedUp = new Set();
  const backup = (file) => {
    if (backedUp.has(file)) return;
    mkdirSync(backupDir, { recursive: true });
    const dest = join(backupDir, `${manifest.length + 1}-${basename(file)}`);
    copyFileSync(file, dest);
    manifest.push({ original: file, backup: dest });
    writeFileSync(join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    backedUp.add(file);
  };

  const byFile = new Map();
  for (const f of found) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  const claude = findOnPath("claude", env);

  for (const [file, items] of byFile) {
    try {
      const text = readFileSync(file, "utf8");
      backup(file);
      const kind = items[0].kind;
      if (kind === "json") {
        let viaCli = [];
        if (claude && items[0].claudeCode) {
          for (const f of items) {
            const cwd = f.scope === "local" ? f.project : dirname(file);
            if (!cwd || !existsSync(cwd)) continue;
            const r = spawnSync(claude, ["mcp", "remove", LEGACY_SERVER, "-s", f.scope], {
              cwd,
              env,
              encoding: "utf8",
              shell: process.platform === "win32",
              timeout: 30000,
            });
            if (r.status === 0 && !stillThere(file, f.path)) viaCli.push(f);
          }
        }
        const rest = items.filter((f) => !viaCli.includes(f));
        if (rest.length) {
          const current = readFileSync(file, "utf8");
          const data = JSON.parse(current);
          const removed = rest.filter((f) => deleteAt(data, f.path));
          if (removed.length) writeJsonLike(file, current, data);
          for (const f of rest) {
            const ok = removed.includes(f);
            results.push({ finding: f, ok, note: ok ? "" : "the entry changed since the scan; left alone" });
          }
        }
        for (const f of viaCli) results.push({ finding: f, ok: true, note: "removed with `claude mcp remove`" });
      } else if (kind === "toml") {
        const { ranges } = legacyTomlRanges(text.split(/\r?\n/));
        if (ranges.length) writeFileSync(file, removeTomlRanges(text, ranges), "utf8");
        for (const f of items) results.push({ finding: f, ok: ranges.length > 0, note: ranges.length ? "" : "the entry changed since the scan; left alone" });
      } else if (kind === "section") {
        const s = text.indexOf(MARK_START);
        const e = s >= 0 ? text.indexOf(MARK_END, s) : -1;
        if (s < 0 || e < 0) {
          for (const f of items) results.push({ finding: f, ok: false, note: "the section changed since the scan; left alone" });
          continue;
        }
        // Only the blank lines next to the section change: one blank line is
        // kept between the text before and after it (the old installer added
        // "\n\n" in front of the section it appended).
        const eol = text.includes("\r\n") ? "\r\n" : "\n";
        const head = text.slice(0, s).replace(/(?:\r?\n)+$/, "");
        const tail = text.slice(e + MARK_END.length).replace(/^(?:\r?\n)+/, "");
        let out;
        if (tail.trim() === "") out = head === "" ? "" : head + eol;
        else out = head === "" ? tail : head + eol + eol + tail;
        if (s === 0 && out.trim() === "") rmSync(file); // created by the old installer for the section alone
        else writeFileSync(file, out, "utf8");
        for (const f of items) results.push({ finding: f, ok: true, note: "" });
      } else if (kind === "file") {
        rmSync(file);
        let note = "";
        if (items[0].removeDirIfEmpty) {
          const dir = dirname(file);
          if (readdirSync(dir).length === 0) rmdirSync(dir);
          else note = `kept ${dir}: it holds other files`;
        }
        for (const f of items) results.push({ finding: f, ok: true, note });
      }
    } catch (err) {
      for (const f of items) results.push({ finding: f, ok: false, note: err?.message ?? String(err) });
    }
  }
  return results;
}
