/**
 * `migrate`: finds what earlier versions of this app left on a machine, and
 * changes it. Two generations:
 *
 *   Relo's SynthCut: its MCP server entry "ai-video-editor" in AI client
 *   configs and its "video-editor-pro" skill files (written by
 *   @relo-video/synthcut). These are removed.
 *
 *   This fork's own previous identity (brand.mjs LEGACY): the MCP server entry
 *   "synthcut" and the "synthcut-editor" skill. The entry is renamed to the
 *   current key in place (command, args, env and other fields kept), old skill
 *   copies are removed and old marked sections are replaced by the current one.
 *
 * Safety rules:
 *   - A Relo entry is removed only when its name is exactly "ai-video-editor"
 *     AND its command or args run an MCP entry point
 *     (…/packages/mcp/dist/index.js from a checkout, or
 *     …/node_modules/@aive/mcp/dist/index.js in the packaged app).
 *   - A fork entry is changed only when the files next to its MCP entry file
 *     confirm it is this app (fingerprintCandidates): a checkout whose root
 *     package.json is named "synthcut" or "zabsreel", or a packaged app whose
 *     resources/app/package.json is named "synthcut-desktop" or
 *     "zabsreel-desktop". Relo's builds (root "ai-native-video-editor",
 *     packaged "synthcut-by-relo") and other monorepos do not pass.
 *   - An existing entry under the current key is never overwritten unless it
 *     passes the same check.
 *   - Claude Code's ~/.claude.json goes through the `claude` CLI when it is on
 *     PATH: the new entry is added and confirmed before the old one is removed.
 *   - A skill file is removed only at the exact path its installer used, and
 *     only when it is that skill (frontmatter name, marker or product name).
 *   - Every file is copied to a backup folder (mode 0700, manifest 0600) before
 *     it changes, and is replaced atomically (temp file + rename, mode kept,
 *     a symlink's target replaced). `restoreBackup` puts a backup back.
 *   - A file that cannot be parsed (for example JSON with comments) is only
 *     reported, never changed.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  rmdirSync,
  readdirSync,
  statSync,
  realpathSync,
  openSync,
  fsyncSync,
  closeSync,
  chmodSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, basename, delimiter, isAbsolute, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PRODUCT_NAME, PRODUCT_ID, MCP_KEY, SKILL_NAME, DESKTOP_PACKAGE, BACKUP_DIR_PARTS, LEGACY } from "./brand.mjs";

export const LEGACY_SERVER = "ai-video-editor";
export const LEGACY_SKILL = "video-editor-pro";
const RELO_MARK_START = `<!-- synthcut:${LEGACY_SKILL}:start -->`;
const RELO_MARK_END = `<!-- synthcut:${LEGACY_SKILL}:end -->`;

/** The markers of the current skill's section in AGENTS.md / GEMINI.md. */
export const MARK_START = `<!-- ${PRODUCT_ID}:${SKILL_NAME}:start -->`;
export const MARK_END = `<!-- ${PRODUCT_ID}:${SKILL_NAME}:end -->`;
const FORK_MARK_START = `<!-- ${LEGACY.id}:${LEGACY.skillName}:start -->`;
const FORK_MARK_END = `<!-- ${LEGACY.id}:${LEGACY.skillName}:end -->`;

const OLD_KEY = LEGACY.mcpKey;
const NEW_KEY = MCP_KEY;

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

/** True when an MCP server entry runs an MCP entry point of the shape Relo's SynthCut used. */
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

const isFile = (file) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const has = (obj, key) => isObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
const getAt = (data, path) => path.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), data);

// ---------------------------------------------------------------- fingerprint

const CHECKOUT_FORM = /^(?:(.*)[\\/])?packages[\\/]mcp[\\/]dist[\\/]index\.js$/i;
const PACKAGED_FORM = /^(.*[\\/]resources[\\/]app(\.asar)?)[\\/]node_modules[\\/]@aive[\\/]mcp[\\/]dist[\\/]index\.js$/i;
const CHECKOUT_NAMES = [LEGACY.id, PRODUCT_ID];
const PACKAGED_NAMES = [LEGACY.desktopPackage, DESKTOP_PACKAGE];

const unquote = (v) => v.trim().replace(/^["']|["']$/g, "");

/** The strings of an entry that may name its MCP entry file: each arg, the command and each token of it. */
function entryCandidates(entry) {
  if (!isObject(entry)) return [];
  const out = [];
  for (const a of Array.isArray(entry.args) ? entry.args : []) if (typeof a === "string") out.push(a);
  if (typeof entry.command === "string") out.push(entry.command);
  return withTokens(out);
}

function withTokens(strings) {
  const out = [];
  for (const s of strings) {
    out.push(unquote(s));
    for (const t of s.trim().split(/\s+/)) out.push(unquote(t));
  }
  return [...new Set(out)].filter(Boolean);
}

function packageName(file) {
  const text = readText(file);
  if (text === null) return { name: null, reason: `cannot read ${file}` };
  try {
    const name = JSON.parse(text)?.name;
    return typeof name === "string" ? { name } : { name: null, reason: `${file} has no name` };
  } catch {
    return { name: null, reason: `cannot parse ${file}` };
  }
}

/** The MCP entry file of a checkout folder. */
export const checkoutEntry = (root) => join(root, "packages", "mcp", "dist", "index.js");

/** True when `root` is a checkout of this app (the checkout form of the fingerprint). */
export function checkoutFingerprint(root) {
  const entry = checkoutEntry(root);
  if (!isFile(entry)) return { ok: false, reason: `${entry} does not exist` };
  const mcp = packageName(join(root, "packages", "mcp", "package.json"));
  if (mcp.name !== "@aive/mcp") return { ok: false, reason: mcp.reason ?? `${join(root, "packages", "mcp", "package.json")} names "${mcp.name}"` };
  const top = packageName(join(root, "package.json"));
  if (!CHECKOUT_NAMES.includes(top.name)) return { ok: false, reason: top.reason ?? `${join(root, "package.json")} names "${top.name}", not ${PRODUCT_NAME}` };
  return { ok: true, name: top.name };
}

/**
 * Check one string that may name an MCP entry file. Returns null when it does
 * not have the shape of one, else { ok, form, path, name?, reason?, stale? }.
 * A relative path is resolved against `base` (the project folder of the config
 * that holds it); with no base it cannot be checked.
 */
function fingerprintPath(raw, base) {
  if (!PACKAGED_FORM.test(raw) && !CHECKOUT_FORM.test(raw)) return null;
  const form = PACKAGED_FORM.test(raw) ? "packaged" : "checkout";
  let file = raw;
  if (!isAbsolute(raw)) {
    if (!base) return { ok: false, form, path: raw, reason: `the relative path ${raw} cannot be checked from this config` };
    file = resolve(base, raw);
  }
  if (form === "packaged") {
    const m = PACKAGED_FORM.exec(file);
    if (!m) return { ok: false, form, path: file, reason: `cannot read ${file}` };
    if (m[2]) return { ok: false, form, path: file, reason: `${file} is inside app.asar, which this tool cannot read` };
    if (!isFile(file)) return { ok: false, form, path: file, reason: `${file} does not exist` };
    const pkg = packageName(join(m[1], "package.json"));
    if (PACKAGED_NAMES.includes(pkg.name)) return { ok: true, form, path: file, name: pkg.name };
    return { ok: false, form, path: file, name: pkg.name, reason: pkg.reason ?? `${join(m[1], "package.json")} names "${pkg.name}", not ${PRODUCT_NAME}` };
  }
  const m = CHECKOUT_FORM.exec(file);
  const root = m?.[1] ?? "";
  if (!isFile(file)) return { ok: false, form, path: file, reason: `${file} does not exist`, stale: isAbsolute(raw) };
  const fp = checkoutFingerprint(root);
  return fp.ok ? { ok: true, form, path: file, name: fp.name } : { ok: false, form, path: file, reason: fp.reason };
}

/** The fingerprint of an entry given as its candidate strings: the first that passes, else why none did. */
function fingerprintCandidates(candidates, base) {
  const checked = candidates.map((c) => fingerprintPath(c, base)).filter(Boolean);
  const pass = checked.find((r) => r.ok);
  if (pass) return pass;
  return {
    ok: false,
    reason:
      checked[0]?.reason ??
      `it does not run an MCP entry file (…/packages/mcp/dist/index.js or …/resources/app/node_modules/@aive/mcp/dist/index.js)`,
    stale: checked.filter((r) => r.stale).map((r) => r.path),
  };
}

/** True when an MCP server entry is this app (either name, checkout or packaged). */
export function fingerprintEntry(entry, base) {
  return fingerprintCandidates(entryCandidates(entry), base);
}

const STALE_HINT = "if the checkout folder moved, run migrate --from-checkout <old> --to-checkout <new>";

// --------------------------------------------------------------- checkout move

const samePath = (a, b) => {
  const n = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/**
 * The checkout-move rule: an arg (or command token) naming the absolute
 * <from>/packages/mcp/dist/index.js, when that file is gone and <to> is a
 * checkout of this app, is rewritten to <to>/packages/mcp/dist/index.js.
 * Returns the moved entry, or null when nothing applies.
 */
function moveEntry(entry, move) {
  if (!move?.toOk || !isObject(entry)) return null;
  const oldFile = checkoutEntry(move.from);
  const newFile = checkoutEntry(move.to);
  if (isFile(oldFile)) return null;
  let moved = false;
  const swap = (s) => {
    if (typeof s !== "string") return s;
    if (samePath(unquote(s), oldFile)) {
      moved = true;
      return newFile;
    }
    const tokens = s.split(/(\s+)/);
    const out = tokens.map((t) => (t.trim() && samePath(unquote(t), oldFile) ? ((moved = true), newFile) : t));
    return out.join("");
  };
  const next = { ...entry };
  if (Array.isArray(entry.args)) next.args = entry.args.map(swap);
  if (typeof entry.command === "string") next.command = swap(entry.command);
  return moved ? { entry: next, from: oldFile, to: newFile } : null;
}

// -------------------------------------------------------------- fork rules

/**
 * Rules 1-6 for one servers object. `s` and `z` are { exists, fp } for the
 * old and the new key. Returns { rule, reason? }.
 */
function forkRule(s, z, hasEntry) {
  if (!s.exists) return { rule: 1 };
  if (!s.fp.ok) return { rule: 2 };
  if (!z.exists) return s.fp.form === "checkout" ? { rule: 3 } : { rule: 4, withEntry: hasEntry };
  return z.fp.ok ? { rule: 5 } : { rule: 6 };
}

const leftAlone = (fp) =>
  `"${OLD_KEY}": cannot confirm it is ${PRODUCT_NAME} (${fp.reason}); left alone` + (fp.stale?.length ? ` (stale path; ${STALE_HINT})` : "");
const otherProgram = (fp) => `a different program already uses the name "${NEW_KEY}" (${fp.reason}); "${OLD_KEY}" left alone`;
const needEntry = (fp) =>
  `"${OLD_KEY}" runs an installed ${LEGACY.productName} app (${fp.path}), which ${PRODUCT_NAME} does not replace: ` +
  `open ${PRODUCT_NAME} → Connect AI, add the entry it shows (or re-run with --entry <file>), then run migrate again to remove the old one`;
const staleNew = (fp) => `"${NEW_KEY}" names a path that no longer exists: ${fp.stale.join(", ")} (stale path; ${STALE_HINT})`;

/** The entry to write under the new key from a packaged old entry and the --entry file (rule 4). */
function entryFromPackaged(oldEntry, newEntry) {
  const env = isObject(oldEntry.env) ? oldEntry.env : {};
  return {
    ...oldEntry,
    command: newEntry.command,
    args: [...newEntry.args],
    env: { ...env, ELECTRON_RUN_AS_NODE: newEntry.env?.ELECTRON_RUN_AS_NODE ?? "1" },
  };
}

/**
 * Decide what happens to one JSON servers object. Returns
 * { change?: { zAtS, nextZ, removeS, what, verb }, notes: [] }.
 */
function forkJson(servers, base, ctx) {
  const notes = [];
  const sIn = has(servers, OLD_KEY);
  const zIn = has(servers, NEW_KEY);
  if (!sIn && !zIn) return { notes };
  const sMove = sIn ? moveEntry(servers[OLD_KEY], ctx.move) : null;
  const zMove = zIn ? moveEntry(servers[NEW_KEY], ctx.move) : null;
  const sVal = sMove?.entry ?? servers[OLD_KEY];
  const zVal = zMove?.entry ?? servers[NEW_KEY];
  const s = { exists: sIn, fp: sIn ? fingerprintEntry(sVal, base) : null };
  const z = { exists: zIn, fp: zIn ? fingerprintEntry(zVal, base) : null };
  const moved = (m) => (m ? ` (path ${m.from} → ${m.to})` : "");
  // The new key's own path move applies whenever it then passes.
  const zMoveChange = zMove && z.fp.ok ? { nextZ: zVal, what: `"${NEW_KEY}": path ${zMove.from} → ${zMove.to}` } : null;
  const r = forkRule(s, z, !!ctx.entry);
  switch (r.rule) {
    case 1:
    case 2:
      if (r.rule === 2) notes.push(leftAlone(s.fp));
      if (zIn && !z.fp.ok && z.fp.stale?.length) notes.push(staleNew(z.fp));
      return zMoveChange ? { change: { zAtS: false, nextZ: zMoveChange.nextZ, removeS: false, what: zMoveChange.what, verb: "updated" }, notes } : { notes };
    case 3:
      return { change: { zAtS: true, nextZ: sVal, removeS: true, what: `rename "${OLD_KEY}" to "${NEW_KEY}": ${describeServer(sVal)}${moved(sMove)}`, verb: "renamed" }, notes };
    case 4:
      if (!r.withEntry) {
        notes.push(needEntry(s.fp));
        return { notes };
      }
      return {
        change: {
          zAtS: true,
          nextZ: entryFromPackaged(sVal, ctx.entry),
          removeS: true,
          what: `replace "${OLD_KEY}" (${LEGACY.productName} app at ${s.fp.path}) with "${NEW_KEY}": ${describeServer(ctx.entry)}`,
          verb: "replaced",
        },
        notes,
      };
    case 5:
      return {
        change: {
          zAtS: false,
          nextZ: zMoveChange?.nextZ,
          removeS: true,
          what: `remove "${OLD_KEY}": "${NEW_KEY}" already runs ${PRODUCT_NAME}${moved(zMove)}`,
          verb: "removed",
        },
        notes,
      };
    default:
      notes.push(otherProgram(z.fp));
      return { notes };
  }
}

/** Apply a fork JSON change to the parsed file. False when the entries changed since the scan. */
function applyForkJson(data, f) {
  const servers = getAt(data, f.serversPath);
  if (!isObject(servers)) return false;
  if (JSON.stringify(servers[OLD_KEY]) !== f.expectS || JSON.stringify(servers[NEW_KEY]) !== f.expectZ) return false;
  if (has(servers, OLD_KEY) !== (f.expectS !== undefined) || has(servers, NEW_KEY) !== (f.expectZ !== undefined)) return false;
  if (f.zAtS) {
    // Same position as the old key; every other key keeps its place.
    const entries = Object.entries(servers).map(([k, v]) => (k === OLD_KEY ? [NEW_KEY, f.nextZ] : [k, v]));
    for (const k of Object.keys(servers)) delete servers[k];
    for (const [k, v] of entries) servers[k] = v;
  } else {
    if (f.nextZ !== undefined) servers[NEW_KEY] = f.nextZ;
    if (f.removeS) delete servers[OLD_KEY];
  }
  return true;
}

// --------------------------------------------------------- --entry validation

/**
 * Read the file given with --entry: the JSON that the app's Connect AI panel
 * shows. It must hold mcpServers.<MCP_KEY>, its command must exist, and its
 * args must name a packaged install of the current app.
 */
export function readEntryFile(file, env = process.env) {
  const text = readText(file);
  if (text === null) return { ok: false, reason: `cannot read ${file}` };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${file} is not plain JSON` };
  }
  const entry = data?.mcpServers?.[NEW_KEY];
  if (!isObject(entry) || typeof entry.command !== "string" || !Array.isArray(entry.args)) {
    return { ok: false, reason: `${file} has no mcpServers.${NEW_KEY} entry with a command and args` };
  }
  const cmdOk = isAbsolute(entry.command) ? isFile(entry.command) : !!findOnPath(entry.command, env);
  if (!cmdOk) return { ok: false, reason: `its command ${entry.command} does not exist` };
  const fp = fingerprintCandidates(withTokens(entry.args.filter((a) => typeof a === "string")), null);
  if (!fp.ok || fp.form !== "packaged" || fp.name !== DESKTOP_PACKAGE) {
    return { ok: false, reason: `its args do not name an installed ${PRODUCT_NAME} app (${fp.ok ? `${fp.path} is "${fp.name}"` : fp.reason})` };
  }
  return { ok: true, entry };
}

/** Prepare the --from-checkout / --to-checkout pair. */
export function checkoutMove(from, to) {
  const fp = checkoutFingerprint(resolve(to));
  return { from: resolve(from), to: resolve(to), toOk: fp.ok, toReason: fp.reason };
}

// ------------------------------------------------------------------ locations

/** Every place an AI client keeps MCP servers, for this home and project. */
function jsonConfigs({ home, projectDir, env }) {
  const userDirs = [...new Set([env.APPDATA, join(home, "Library", "Application Support"), env.XDG_CONFIG_HOME || join(home, ".config")].filter(Boolean))];
  const list = [
    ...userDirs.map((d) => ({ client: "Claude Desktop", file: join(d, "Claude", "claude_desktop_config.json"), key: "mcpServers" })),
    { client: "Claude Code", file: join(home, ".claude.json"), key: "mcpServers", claudeCode: true },
    { client: "Claude Code (project .mcp.json)", file: join(projectDir, ".mcp.json"), key: "mcpServers", project: true },
    { client: "Cursor", file: join(home, ".cursor", "mcp.json"), key: "mcpServers" },
    { client: "Cursor (project)", file: join(projectDir, ".cursor", "mcp.json"), key: "mcpServers", project: true },
    { client: "Windsurf", file: join(home, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" },
    { client: "Gemini CLI", file: join(home, ".gemini", "settings.json"), key: "mcpServers" },
    { client: "Gemini CLI (project)", file: join(projectDir, ".gemini", "settings.json"), key: "mcpServers", project: true },
    { client: "Cline", file: join(home, ".cline", "mcp.json"), key: "mcpServers" },
    ...userDirs.map((d) => ({
      client: "Cline (VS Code)",
      file: join(d, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
      key: "mcpServers",
    })),
    ...userDirs.map((d) => ({ client: "VS Code", file: join(d, "Code", "User", "mcp.json"), key: "servers" })),
    { client: "VS Code (project)", file: join(projectDir, ".vscode", "mcp.json"), key: "servers", project: true },
  ];
  const seen = new Set();
  return list.filter((c) => (seen.has(c.file) ? false : (seen.add(c.file), true)));
}

/** Files the old installers wrote their skill into (@relo-video/synthcut 0.1.x, and this package before the rename). */
function skillTargets({ home, projectDir, env }) {
  const bases = [...new Set([home, projectDir])];
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  return {
    skillFiles: [
      ...bases.map((b) => ({ gen: "upstream", name: LEGACY_SKILL, file: join(b, ".claude", "skills", LEGACY_SKILL, "SKILL.md") })),
      ...bases.map((b) => ({ gen: "fork", name: LEGACY.skillName, file: join(b, ".claude", "skills", LEGACY.skillName, "SKILL.md") })),
    ],
    ruleFiles: [
      { gen: "upstream", name: LEGACY_SKILL, client: "Cursor rule", file: join(projectDir, ".cursor", "rules", `synthcut-${LEGACY_SKILL}.mdc`) },
      { gen: "upstream", name: LEGACY_SKILL, client: "Windsurf rule", file: join(projectDir, ".windsurf", "rules", `synthcut-${LEGACY_SKILL}.md`) },
      { gen: "fork", name: LEGACY.skillName, client: "Cursor rule", file: join(projectDir, ".cursor", "rules", `${LEGACY.skillName}.mdc`) },
      { gen: "fork", name: LEGACY.skillName, client: "Windsurf rule", file: join(projectDir, ".windsurf", "rules", `${LEGACY.skillName}.md`) },
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
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tomlHeader = (key) =>
  new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${reEscape(key)}"|'${reEscape(key)}'|${reEscape(key)})\\s*(\\.[^\\]]*)?\\]\\s*(?:#.*)?$`);
// Any other way to write the key: an inline table under [mcp_servers], or dotted keys.
const tomlOtherForm = (key) => new RegExp(`^\\s*(?:mcp_servers\\s*\\.\\s*)?(?:"${reEscape(key)}"|'${reEscape(key)}'|${reEscape(key)})\\s*(?:=|\\.)`, "m");
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

/** A TOML basic string. JSON's escapes are valid TOML escapes. */
const tomlString = (s) => JSON.stringify(s);

/**
 * The [mcp_servers.<key>] table and its sub-tables, as { start, end, sub }.
 * A table ends after its last key line, so comments above the next table stay.
 */
function tomlTables(lines, key) {
  const header = tomlHeader(key);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = header.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !TOML_HEADER.test(lines[j])) j++;
    let end = j;
    while (end > i + 1 && (isBlank(lines[end - 1]) || isComment(lines[end - 1]))) end--;
    blocks.push({ start: i, end, sub: m[1] ? m[1].slice(1).trim().replace(/^["']|["']$/g, "") : null, text: lines.slice(i + 1, end).join("\n") });
  }
  return blocks;
}

/**
 * Line ranges [start, end) of the [mcp_servers.ai-video-editor] table and its
 * sub-tables, when that table runs the old entry point.
 */
function legacyTomlRanges(lines) {
  const blocks = tomlTables(lines, LEGACY_SERVER);
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

/** The line after the end of the value that starts on line i (multi-line arrays and inline tables). */
function tomlValueEnd(lines, i, to) {
  let depth = 0;
  for (let k = i; k < to; k++) {
    const s = k === i ? lines[k].slice(lines[k].indexOf("=") + 1) : lines[k];
    let quote = null;
    for (let c = 0; c < s.length; c++) {
      const ch = s[c];
      if (quote) {
        if (quote === '"' && ch === "\\") c++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "#") break;
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
    }
    if (depth <= 0) return k + 1;
  }
  return to;
}

/** Lines [i, j) of `key = …` inside a table body, or null. */
function tomlKeySpan(lines, block, key) {
  const re = new RegExp(`^\\s*(?:"${reEscape(key)}"|'${reEscape(key)}'|${reEscape(key)})\\s*=`);
  for (let i = block.start + 1; i < block.end; i++) if (re.test(lines[i])) return [i, tomlValueEnd(lines, i, block.end)];
  return null;
}

/** The checkout-move rule on a TOML table: the old path's string literals rewritten in place. */
function tomlMoveLines(lines, block, move) {
  if (!block || !move?.toOk) return null;
  const oldFile = checkoutEntry(move.from);
  const newFile = checkoutEntry(move.to);
  if (isFile(oldFile)) return null;
  if (!tomlStrings(block.text).some((s) => samePath(s, oldFile))) return null;
  const pairs = [
    [`"${tomlString(oldFile).slice(1, -1)}"`, tomlString(newFile)],
    [`'${oldFile}'`, `'${newFile}'`],
  ];
  const out = [];
  let moved = false;
  for (let i = block.start + 1; i < block.end; i++) {
    let line = lines[i];
    for (const [from, to] of pairs) if (line.includes(from)) (line = line.split(from).join(to)), (moved = true);
    out.push(line);
  }
  return moved ? { body: out, from: oldFile, to: newFile } : null;
}

/**
 * The fork's rules on Codex's config.toml. Returns null when neither key is
 * there, else { rule, text (null when nothing changes), what, verb, notes }.
 */
function forkToml(text, ctx) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const sBlocks = tomlTables(lines, OLD_KEY);
  const zBlocks = tomlTables(lines, NEW_KEY);
  const sOther = !sBlocks.length && tomlOtherForm(OLD_KEY).test(text);
  const zOther = !zBlocks.length && tomlOtherForm(NEW_KEY).test(text);
  if (!sBlocks.length && !zBlocks.length && !sOther && !zOther) return null;
  const notes = [];
  if (sOther) notes.push(`mentions "${OLD_KEY}" in a form this tool does not edit; edit it by hand`);
  const sMain = sBlocks.find((b) => !b.sub);
  const zMain = zBlocks.find((b) => !b.sub);
  // Codex's config is a user file: a relative path cannot be checked.
  const fpOf = (block, moved) => {
    if (!block) return { ok: false, reason: "no plain [mcp_servers.<name>] table" };
    return fingerprintCandidates(withTokens(tomlStrings(moved ? moved.body.join("\n") : block.text)), null);
  };
  const sMove = tomlMoveLines(lines, sMain, ctx.move);
  const zMove = tomlMoveLines(lines, zMain, ctx.move);
  const s = { exists: sBlocks.length > 0, fp: sBlocks.length ? fpOf(sMain, sMove) : null };
  const z = { exists: zBlocks.length > 0 || zOther, fp: zOther ? { ok: false, reason: `"${NEW_KEY}" is written in a form this tool does not read` } : zBlocks.length ? fpOf(zMain, zMove) : null };

  const out = [...lines];
  const putBody = (block, mv) => mv && out.splice(block.start + 1, mv.body.length, ...mv.body);
  const renameHeaders = () => {
    const re = new RegExp(`(mcp_servers\\s*\\.\\s*)(["']?)${reEscape(OLD_KEY)}\\2`);
    for (const b of sBlocks) out[b.start] = out[b.start].replace(re, `$1$2${NEW_KEY}$2`);
  };
  const zMoveOk = zMove && z.fp.ok;
  const r = forkRule(s, z, !!ctx.entry);
  const done = (rule, what, verb) => ({ rule, text: out.join(eol), what, verb, notes });

  switch (r.rule) {
    case 1:
    case 2:
      if (r.rule === 2) notes.push(leftAlone(s.fp));
      if (z.exists && !z.fp.ok && z.fp.stale?.length) notes.push(staleNew(z.fp));
      if (!zMoveOk) return { rule: r.rule, text: null, notes };
      putBody(zMain, zMove);
      return done(r.rule, `[mcp_servers.${NEW_KEY}]: path ${zMove.from} → ${zMove.to}`, "updated");
    case 3:
      putBody(sMain, sMove);
      renameHeaders();
      return done(3, `rename [mcp_servers.${OLD_KEY}] (and its sub-tables) to [mcp_servers.${NEW_KEY}]${sMove ? ` (path ${sMove.from} → ${sMove.to})` : ""}`, "renamed");
    case 4: {
      if (!r.withEntry) {
        notes.push(needEntry(s.fp));
        return { rule: 4, text: null, notes };
      }
      const e = ctx.entry;
      const runAsNode = e.env?.ELECTRON_RUN_AS_NODE ?? "1";
      const envBlock = sBlocks.find((b) => b.sub === "env");
      const inlineEnv = tomlKeySpan(lines, sMain, "env");
      // Edits from the bottom up, so line numbers above stay valid.
      const edits = [];
      if (envBlock) {
        const span = tomlKeySpan(lines, envBlock, "ELECTRON_RUN_AS_NODE");
        const line = `ELECTRON_RUN_AS_NODE = ${tomlString(runAsNode)}`;
        edits.push(span ? { at: span[0], del: span[1] - span[0], add: [line] } : { at: envBlock.start + 1, del: 0, add: [line] });
      } else if (inlineEnv) {
        const envText = lines.slice(inlineEnv[0], inlineEnv[1]).join("\n");
        if (!new RegExp(`ELECTRON_RUN_AS_NODE\\s*=\\s*["']${reEscape(runAsNode)}["']`).test(envText)) {
          notes.push(`[mcp_servers.${OLD_KEY}] has an inline env table without ELECTRON_RUN_AS_NODE = "${runAsNode}"; edit it by hand`);
          return { rule: 4, text: null, notes };
        }
      } else {
        edits.push({ at: sMain.end, del: 0, add: ["", `[mcp_servers.${NEW_KEY}.env]`, `ELECTRON_RUN_AS_NODE = ${tomlString(runAsNode)}`] });
      }
      const cmdSpan = tomlKeySpan(lines, sMain, "command");
      const argsSpan = tomlKeySpan(lines, sMain, "args");
      const cmdLine = `command = ${tomlString(e.command)}`;
      const argsLine = `args = [${e.args.map(tomlString).join(", ")}]`;
      if (cmdSpan) edits.push({ at: cmdSpan[0], del: cmdSpan[1] - cmdSpan[0], add: [cmdLine] });
      if (argsSpan) edits.push({ at: argsSpan[0], del: argsSpan[1] - argsSpan[0], add: [argsLine] });
      const missing = [...(cmdSpan ? [] : [cmdLine]), ...(argsSpan ? [] : [argsLine])];
      if (missing.length) edits.push({ at: sMain.start + 1, del: 0, add: missing });
      // Headers first: renaming keeps the line count, the edits do not.
      renameHeaders();
      edits.sort((a, b) => b.at - a.at);
      for (const ed of edits) out.splice(ed.at, ed.del, ...ed.add);
      return done(4, `replace [mcp_servers.${OLD_KEY}] (${LEGACY.productName} app at ${s.fp.path}) with [mcp_servers.${NEW_KEY}]: ${describeServer(e)}`, "replaced");
    }
    case 5: {
      if (zMoveOk) putBody(zMain, zMove);
      const ranges = sBlocks.map((b) => [b.start, b.end]);
      return {
        rule: 5,
        text: removeTomlRanges(out.join(eol), ranges),
        what: `remove [mcp_servers.${OLD_KEY}]: [mcp_servers.${NEW_KEY}] already runs ${PRODUCT_NAME}`,
        verb: "removed",
        notes,
      };
    }
    default:
      notes.push(otherProgram(z.fp));
      return { rule: 6, text: null, notes };
  }
}

// ----------------------------------------------------------------------- scan

/**
 * Look for leftovers of both generations. Options: `entry` (a checked --entry,
 * see readEntryFile) and `move` (see checkoutMove). Returns
 *   { found: [...changes], skipped: [...left alone, with a reason] }.
 * Each finding has `gen` ("upstream" or "fork"), `what` and `verb`.
 */
export function findLegacy({ home, projectDir, env = process.env, entry = null, move = null }) {
  const found = [];
  const skipped = [];
  const ctx = { entry, move };

  for (const cfg of jsonConfigs({ home, projectDir, env })) {
    const text = readText(cfg.file);
    if (text === null) continue;
    const mentionsLegacy = text.includes(LEGACY_SERVER) || text.includes(`"${OLD_KEY}"`);
    if (!mentionsLegacy && !text.includes(`"${NEW_KEY}"`)) continue;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      if (mentionsLegacy) {
        const name = text.includes(LEGACY_SERVER) ? LEGACY_SERVER : OLD_KEY;
        skipped.push({ client: cfg.client, file: cfg.file, reason: `mentions "${name}" but is not plain JSON (comments?); edit it by hand` });
      }
      continue;
    }
    const spots = [{ path: [cfg.key], scope: "user", base: cfg.project ? projectDir : null }];
    if (cfg.claudeCode && data && typeof data.projects === "object" && data.projects) {
      for (const p of Object.keys(data.projects)) spots.push({ path: ["projects", p, cfg.key], scope: "local", project: p, base: p });
    }
    for (const spot of spots) {
      const servers = getAt(data, spot.path);
      if (!isObject(servers)) continue;
      const where = spot.project ? `${cfg.client} (project ${spot.project})` : cfg.client;
      const common = { kind: "json", client: where, file: cfg.file, claudeCode: !!cfg.claudeCode, scope: spot.scope, project: spot.project };

      if (has(servers, LEGACY_SERVER)) {
        const legacyEntry = servers[LEGACY_SERVER];
        if (isLegacyServer(legacyEntry)) {
          found.push({
            ...common,
            gen: "upstream",
            verb: "removed",
            path: [...spot.path, LEGACY_SERVER],
            hasNewKey: has(servers, NEW_KEY) || has(servers, OLD_KEY),
            what: `MCP server "${LEGACY_SERVER}": ${describeServer(legacyEntry)}`,
          });
        } else {
          skipped.push({ client: where, file: cfg.file, reason: `"${LEGACY_SERVER}" does not run Relo's SynthCut MCP server (${describeServer(legacyEntry) || "no command"})` });
        }
      }

      const fork = forkJson(servers, spot.base, ctx);
      for (const reason of fork.notes) skipped.push({ client: where, file: cfg.file, reason });
      if (fork.change) {
        found.push({
          ...common,
          gen: "fork",
          serversPath: spot.path,
          expectS: JSON.stringify(servers[OLD_KEY]),
          expectZ: JSON.stringify(servers[NEW_KEY]),
          ...fork.change,
        });
      }
    }
  }

  const codexToml = join(env.CODEX_HOME || join(home, ".codex"), "config.toml");
  const toml = readText(codexToml);
  if (toml !== null && toml.includes(LEGACY_SERVER)) {
    const lines = toml.split(/\r?\n/);
    const { ranges, mentioned } = legacyTomlRanges(lines);
    if (ranges.length) {
      const hasNewKey = tomlTables(lines, NEW_KEY).length > 0 || tomlTables(lines, OLD_KEY).length > 0;
      found.push({ kind: "toml", gen: "upstream", verb: "removed", client: "Codex CLI", file: codexToml, what: `[mcp_servers.${LEGACY_SERVER}]`, hasNewKey });
    } else {
      skipped.push({
        client: "Codex CLI",
        file: codexToml,
        reason: mentioned
          ? `[mcp_servers.${LEGACY_SERVER}] does not run Relo's SynthCut MCP server`
          : `mentions "${LEGACY_SERVER}" in a form this tool does not edit; edit it by hand`,
      });
    }
  }
  if (toml !== null) {
    const fork = forkToml(toml, ctx);
    if (fork) {
      for (const reason of fork.notes) skipped.push({ client: "Codex CLI", file: codexToml, reason });
      if (fork.text !== null) found.push({ kind: "toml", gen: "fork", client: "Codex CLI", file: codexToml, rule: fork.rule, what: fork.what, verb: fork.verb, ctx });
    }
  }

  const { skillFiles, ruleFiles, sectionFiles } = skillTargets({ home, projectDir, env });
  for (const { gen, name: skill, file } of skillFiles) {
    const text = readText(file);
    if (text === null) continue;
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const name = fm && /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fm[1]);
    if (name && name[1] === skill) found.push({ kind: "file", gen, verb: "removed", client: "Claude Code skill", file, what: `skill "${skill}"`, removeDirIfEmpty: true });
    else skipped.push({ client: "Claude Code skill", file, reason: `its name is not "${skill}"` });
  }
  for (const { gen, name: skill, client, file } of ruleFiles) {
    const text = readText(file);
    if (text === null) continue;
    if (/synthcut/i.test(text)) found.push({ kind: "file", gen, verb: "removed", client, file, what: `rule for skill "${skill}"` });
    else skipped.push({ client, file, reason: `does not look like the ${gen === "upstream" ? "Relo's SynthCut" : LEGACY.productName} skill` });
  }
  for (const file of sectionFiles) {
    const text = readText(file);
    if (text === null) continue;
    const client = /GEMINI\.md$/.test(file) ? "Gemini CLI" : "Codex / agents";
    const s = text.indexOf(RELO_MARK_START);
    if (s >= 0 && text.indexOf(RELO_MARK_END, s) > s) found.push({ kind: "section", gen: "upstream", verb: "removed", client, file, what: `section ${RELO_MARK_START}` });
    const f = text.indexOf(FORK_MARK_START);
    if (f >= 0 && text.indexOf(FORK_MARK_END, f) > f) {
      found.push({ kind: "section", gen: "fork", verb: "replaced", client, file, what: `section ${FORK_MARK_START} → ${MARK_START}` });
    }
  }
  return { found, skipped };
}

// ------------------------------------------------------- writes and backups

/**
 * Replace a file's content atomically: a temp file in the same folder, created
 * with the original's mode, flushed, then renamed over the original. A
 * symlink is resolved first and its target replaced, so the link stays. If
 * anything fails the original is untouched. `mode` is used for a new file.
 */
export function atomicWrite(file, data, { mode } = {}) {
  let target = file;
  try {
    target = realpathSync(file);
  } catch {
    /* a new file */
  }
  let keep = mode;
  try {
    keep = statSync(target).mode & 0o7777;
  } catch {
    /* a new file */
  }
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", keep ?? 0o666);
  try {
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // The umask may have narrowed the mode given to open.
    if (keep !== undefined) chmodSync(tmp, keep);
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
}

/** ~/.zabsreel/backups */
export const backupRoot = (home) => join(home, ...BACKUP_DIR_PARTS);

/** A new, not yet created, backup folder: ~/.zabsreel/backups/<kind>-<time>. */
export function newBackupDir(home, kind = "migrate") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let dir = join(backupRoot(home), `${kind}-${stamp}`);
  for (let n = 2; existsSync(dir); n++) dir = join(backupRoot(home), `${kind}-${stamp}-${n}`);
  return dir;
}

/** Create a folder with mode 0700, or set 0700 when it exists. */
function privateDir(dir) {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
  }
  chmodSync(dir, 0o700);
}

/**
 * Copies files into `dir` (~/.zabsreel/backups/<stamp>) before they change.
 * ~/.zabsreel, ~/.zabsreel/backups and the stamp folder get mode 0700;
 * manifest.json (original and backup paths only) gets 0600.
 */
function backupSet(dir) {
  const manifest = [];
  const saved = new Set();
  let ready = false;
  return {
    dir,
    manifest,
    save(file) {
      if (saved.has(file)) return;
      if (!ready) {
        mkdirSync(dirname(dirname(dirname(dir))), { recursive: true });
        privateDir(dirname(dirname(dir)));
        privateDir(dirname(dir));
        privateDir(dir);
        ready = true;
      }
      const dest = join(dir, `${manifest.length + 1}-${basename(file)}`);
      copyFileSync(file, dest);
      manifest.push({ original: file, backup: dest });
      const mf = join(dir, "manifest.json");
      writeFileSync(mf, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      chmodSync(mf, 0o600);
      saved.add(file);
    },
  };
}

// ----------------------------------------------------------- Claude Code CLI

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

// A .cmd/.bat shim runs through cmd.exe, which cannot be given a JSON argument
// safely, so `add-json` is only used with a real executable.
const needsShell = (bin) => /\.(cmd|bat)$/i.test(bin);

function stillThere(file, path) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const parent = getAt(data, path.slice(0, -1));
    return !!parent && typeof parent === "object" && path[path.length - 1] in parent;
  } catch {
    return true;
  }
}

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** Equal MCP entries, allowing what `claude mcp add-json` adds by itself (type "stdio", an empty env). */
function sameEntry(want, got) {
  const norm = (e) => {
    if (!isObject(e)) return e;
    const c = { ...e };
    if (c.type === "stdio") delete c.type;
    if (isObject(c.env) && !Object.keys(c.env).length) delete c.env;
    return stable(c);
  };
  return isObject(got) && norm(want) === norm(got);
}

function readServers(file, serversPath) {
  try {
    return getAt(JSON.parse(readFileSync(file, "utf8")), serversPath);
  } catch {
    return undefined;
  }
}

/** How a ~/.claude.json finding is applied: "cli" or "direct". */
function claudeRoute(f, file, claude) {
  if (!f.claudeCode || !claude) return "direct";
  const cwd = f.scope === "local" ? f.project : dirname(file);
  if (!cwd || !existsSync(cwd)) return "direct";
  if (f.gen === "fork") {
    // The CLI cannot change an existing key in place without removing it first.
    if (!f.zAtS && f.nextZ !== undefined) return "direct";
    if (f.zAtS && needsShell(claude)) return "direct";
  }
  return "cli";
}

/**
 * The findings that would be written straight into ~/.claude.json (no
 * `claude` CLI, or a change it cannot make). The user is asked to close
 * Claude Code before those, because a running Claude Code writes its own copy
 * back.
 */
export function directClaudeEdits(found, env = process.env) {
  const claude = findOnPath("claude", env);
  return found.filter((f) => f.kind === "json" && f.claudeCode && claudeRoute(f, f.file, claude) === "direct");
}

const runClaude = (claude, args, cwd, env) =>
  spawnSync(claude, args, { cwd, env, encoding: "utf8", shell: needsShell(claude), timeout: 30000 });

/**
 * A fork change through the CLI: `claude mcp add-json` first, confirmed by
 * re-reading the file; only then `claude mcp remove`, confirmed the same way.
 */
function forkViaCli(f, file, claude, env) {
  const cwd = f.scope === "local" ? f.project : dirname(file);
  const servers = readServers(file, f.serversPath);
  if (!isObject(servers) || JSON.stringify(servers[OLD_KEY]) !== f.expectS || JSON.stringify(servers[NEW_KEY]) !== f.expectZ) {
    return { ok: false, note: "the entries changed since the scan; left alone" };
  }
  if (f.zAtS) {
    const r = runClaude(claude, ["mcp", "add-json", NEW_KEY, JSON.stringify(f.nextZ), "-s", f.scope], cwd, env);
    const added = readServers(file, f.serversPath)?.[NEW_KEY];
    if (r.status !== 0 || !sameEntry(f.nextZ, added)) {
      return { ok: false, note: `\`claude mcp add-json ${NEW_KEY}\` failed or could not be confirmed; "${OLD_KEY}" not removed` };
    }
  }
  if (!f.removeS) return { ok: true, note: `added with \`claude mcp add-json\`` };
  const r = runClaude(claude, ["mcp", "remove", OLD_KEY, "-s", f.scope], cwd, env);
  const after = readServers(file, f.serversPath);
  if (r.status !== 0 || !isObject(after) || has(after, OLD_KEY) || !has(after, NEW_KEY)) {
    return {
      ok: false,
      note: `"${NEW_KEY}" is there, but \`claude mcp remove ${OLD_KEY}\` failed, so both entries exist; run migrate again to remove "${OLD_KEY}"`,
    };
  }
  return { ok: true, note: f.zAtS ? "with `claude mcp add-json`, then `claude mcp remove`" : "with `claude mcp remove`" };
}

// --------------------------------------------------------------------- apply

/** Remove the text between two markers, keeping one blank line between what was around it. */
function cutSection(text, start, end) {
  const s = text.indexOf(start);
  const e = s >= 0 ? text.indexOf(end, s) : -1;
  if (s < 0 || e < 0) return null;
  // The old installers added "\n\n" in front of the section they appended.
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const head = text.slice(0, s).replace(/(?:\r?\n)+$/, "");
  const tail = text.slice(e + end.length).replace(/^(?:\r?\n)+/, "");
  let out;
  if (tail.trim() === "") out = head === "" ? "" : head + eol;
  else out = head === "" ? tail : head + eol + eol + tail;
  return { text: out, atStart: s === 0 };
}

/** Replace the fork's old section with the current one (or drop it when the current one is already there). */
function swapSection(text, newSection) {
  const s = text.indexOf(FORK_MARK_START);
  const e = s >= 0 ? text.indexOf(FORK_MARK_END, s) : -1;
  if (s < 0 || e < 0) return null;
  if (text.includes(MARK_START) || !newSection) return cutSection(text, FORK_MARK_START, FORK_MARK_END)?.text ?? null;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let stop = e + FORK_MARK_END.length;
  if (text.startsWith("\r\n", stop)) stop += 2;
  else if (text.startsWith("\n", stop)) stop += 1;
  return text.slice(0, s) + newSection.replace(/\r?\n/g, eol) + text.slice(stop);
}

/**
 * Apply the findings. Every touched file is first copied into `backupDir`
 * (see backupSet). Options:
 *   newSection   the current skill's marked section, for AGENTS.md / GEMINI.md
 *   claudeDirect true when the user agreed to a direct edit of ~/.claude.json
 *                (see directClaudeEdits); otherwise those items are not done.
 * Returns [{ finding, ok, note }].
 */
export function removeLegacy(found, { backupDir, env = process.env, newSection = "", claudeDirect = false }) {
  const results = [];
  const backups = backupSet(backupDir);
  const backup = (file) => backups.save(file);

  const byFile = new Map();
  for (const f of found) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  const claude = findOnPath("claude", env);

  for (const [file, items] of byFile) {
    try {
      const text = readFileSync(file, "utf8");
      backup(file);
      const kind = items[0].kind;
      if (kind === "json") {
        const handled = new Set();
        for (const f of items) {
          if (claudeRoute(f, file, claude) !== "cli") continue;
          if (f.gen === "fork") {
            const r = forkViaCli(f, file, claude, env);
            results.push({ finding: f, ok: r.ok, note: r.note });
            handled.add(f);
            continue;
          }
          const cwd = f.scope === "local" ? f.project : dirname(file);
          const r = runClaude(claude, ["mcp", "remove", LEGACY_SERVER, "-s", f.scope], cwd, env);
          if (r.status === 0 && !stillThere(file, f.path)) {
            results.push({ finding: f, ok: true, note: "removed with `claude mcp remove`" });
            handled.add(f);
          }
        }
        const rest = items.filter((f) => !handled.has(f));
        if (rest.length && items[0].claudeCode && !claudeDirect) {
          for (const f of rest) results.push({ finding: f, ok: false, note: "not edited: ~/.claude.json would be edited directly; close Claude Code and run migrate again" });
        } else if (rest.length) {
          const current = readFileSync(file, "utf8");
          const data = JSON.parse(current);
          const done = rest.filter((f) => (f.gen === "fork" ? applyForkJson(data, f) : deleteAt(data, f.path)));
          if (done.length) writeJsonLike(file, current, data);
          for (const f of rest) {
            const ok = done.includes(f);
            results.push({ finding: f, ok, note: ok ? "" : "the entry changed since the scan; left alone" });
          }
        }
      } else if (kind === "toml") {
        let out = text;
        const oks = new Map();
        for (const f of items.filter((i) => i.gen === "upstream")) {
          const { ranges } = legacyTomlRanges(out.split(/\r?\n/));
          if (ranges.length) out = removeTomlRanges(out, ranges);
          oks.set(f, ranges.length > 0);
        }
        for (const f of items.filter((i) => i.gen === "fork")) {
          const r = forkToml(out, f.ctx);
          const ok = !!r && r.text !== null && r.rule === f.rule && r.what === f.what;
          if (ok) out = r.text;
          oks.set(f, ok);
        }
        if (out !== text) atomicWrite(file, out);
        for (const f of items) {
          const ok = oks.get(f) && out !== text;
          results.push({ finding: f, ok, note: ok ? "" : "the entry changed since the scan; left alone" });
        }
      } else if (kind === "section") {
        let out = text;
        let empty = false;
        const oks = new Map();
        for (const f of items) {
          if (f.gen === "upstream") {
            const r = cutSection(out, RELO_MARK_START, RELO_MARK_END);
            if (r) (out = r.text), (empty = r.atStart && r.text.trim() === "");
            oks.set(f, !!r);
          } else {
            const r = swapSection(out, newSection);
            if (r !== null) out = r;
            oks.set(f, r !== null);
          }
        }
        if (empty && out.trim() === "") rmSync(file); // created by the old installer for the section alone
        else if (out !== text) atomicWrite(file, out);
        for (const f of items) results.push({ finding: f, ok: oks.get(f), note: oks.get(f) ? "" : "the section changed since the scan; left alone" });
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

function writeJsonLike(file, original, data) {
  const indent = /^([ \t]+)"/m.exec(original)?.[1] ?? "  ";
  let out = JSON.stringify(data, null, indent);
  if (original.includes("\r\n")) out = out.replace(/\n/g, "\r\n");
  if (/\r?\n$/.test(original)) out += original.endsWith("\r\n") ? "\r\n" : "\n";
  atomicWrite(file, out);
}

function deleteAt(data, path) {
  const parent = getAt(data, path.slice(0, -1));
  const key = path[path.length - 1];
  if (!parent || typeof parent !== "object" || !(key in parent) || !isLegacyServer(parent[key])) return false;
  delete parent[key];
  return true;
}

// ------------------------------------------------------------------- restore

/**
 * Read a backup folder's manifest.json. Every backup file must be a file
 * inside the folder; any entry that is not makes the whole manifest refused.
 * Returns { entries: [{ original, backup, exists }], errors: [] }.
 */
export function readManifest(backupDir) {
  const errors = [];
  let realDir;
  try {
    realDir = realpathSync(backupDir);
  } catch {
    return { entries: [], errors: [`${backupDir} does not exist`] };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(realDir, "manifest.json"), "utf8"));
  } catch {
    return { entries: [], errors: [`cannot read ${join(backupDir, "manifest.json")}`] };
  }
  if (!Array.isArray(manifest)) return { entries: [], errors: ["manifest.json is not a list"] };
  const entries = [];
  for (const m of manifest) {
    if (!m || typeof m.original !== "string" || typeof m.backup !== "string" || !isAbsolute(m.original)) {
      errors.push(`a manifest entry is not { original, backup } with an absolute original: ${JSON.stringify(m)}`);
      continue;
    }
    let real;
    try {
      real = realpathSync(resolve(realDir, m.backup));
    } catch {
      errors.push(`backup ${m.backup} does not exist`);
      continue;
    }
    const rel = relative(realDir, real);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || basename(real) === "manifest.json") {
      errors.push(`backup ${m.backup} is not inside ${backupDir}; refused`);
      continue;
    }
    if (!isFile(real)) {
      errors.push(`backup ${m.backup} is not a file`);
      continue;
    }
    entries.push({ original: m.original, backup: real, exists: existsSync(m.original) });
  }
  return { entries, errors };
}

/**
 * Put every backup back over its original (atomic write, the original's mode
 * kept; a missing original is created with the backup's mode). The current
 * files are backed up first into a new folder, so a restore can be undone.
 * Returns { backupDir, results: [{ original, ok, note }] }.
 */
export function restoreBackup(entries, { home }) {
  const pre = backupSet(newBackupDir(home, "restore"));
  const results = [];
  for (const e of entries) if (isFile(e.original)) pre.save(e.original);
  for (const e of entries) {
    try {
      mkdirSync(dirname(e.original), { recursive: true });
      atomicWrite(e.original, readFileSync(e.backup), { mode: statSync(e.backup).mode & 0o7777 });
      results.push({ original: e.original, ok: true, note: "" });
    } catch (err) {
      results.push({ original: e.original, ok: false, note: err?.message ?? String(err) });
    }
  }
  return { backupDir: pre.manifest.length ? pre.dir : null, results };
}
