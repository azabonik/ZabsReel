// Leftover-name gate: fails when an old product name or an upstream runtime
// value appears in the repository outside the allowlist (scripts/brand-allowlist.json).
//
// It only reads. The files come from `git ls-files` (tracked files, plus new
// files that are not ignored, so a local run also sees files nobody has added
// yet); each is read with fs, and a file with a NUL byte in its first 8000 bytes
// is binary and skipped. This script and the allowlist hold the patterns
// themselves and are not scanned.
//
// For each line, every allowlist entry for that file removes its matches first
// (an entry's alternatives are one regex, longest first; the file's entries run
// longest first too) and counts them. Then the gate patterns run on what is
// left, so a pattern beside an allowed phrase still fails. After the scan, an
// entry whose count differs from its recorded count fails: more means a new
// mention, fewer means a stale entry.
//
// Usage: node scripts/check-brand.mjs [--root <dir>] [--allowlist <file>] [--counts]
//        node scripts/check-brand.mjs --self-test
// --counts also prints every entry's count. Exits 0 when clean, 1 otherwise.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..");
const DEFAULT_ALLOWLIST = join(HERE, "brand-allowlist.json");
// Repo-relative paths that are never scanned: the gate's own definition.
const SELF = new Set(["scripts/check-brand.mjs", "scripts/brand-allowlist.json"]);

/** The gate patterns, by the id the allowlist uses. */
export const PATTERNS = {
  zabsreel: /zabsreel/gi,
  Relo: /\bRelo\b/g,
  "4789": /\b4789\b/g,
  ".aive/data": /\.aive[\\/]+data/g,
  "ai-video-editor": /ai-video-editor/g,
  "video-editor-pro": /video-editor-pro/g,
};

// Only these entries may allow the bare lowercase id `zabsreel`: the migrate code
// and its test (A11, A12), the counted LEGACY blocks (A13) and smoke-brand (A14).
const BARE_OK = new Set(["A11", "A12", "A13", "A14"]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Checks the allowlist and compiles each entry. Throws on a malformed entry.
 * An entry: { id, file, regex?: string[], literal?: string[], flags?: "i",
 * patterns: string[], count: number, reason: string }.
 */
export function compileEntries(raw) {
  if (!Array.isArray(raw)) throw new Error("allowlist: `entries` must be an array");
  return raw.map((e, i) => {
    const where = `allowlist entry ${i} (${e && e.id})`;
    if (!e || typeof e.id !== "string" || typeof e.file !== "string") throw new Error(`${where}: needs id and file`);
    if (typeof e.reason !== "string" || !e.reason.trim()) throw new Error(`${where}: needs a reason`);
    if (!Number.isInteger(e.count) || e.count < 1) throw new Error(`${where}: count must be a positive integer`);
    if (!Array.isArray(e.patterns) || e.patterns.length === 0) throw new Error(`${where}: needs patterns`);
    for (const p of e.patterns) if (!(p in PATTERNS)) throw new Error(`${where}: unknown pattern "${p}"`);
    if (e.flags !== undefined && e.flags !== "i") throw new Error(`${where}: flags may only be "i"`);
    const alts = [...(e.regex ?? []), ...(e.literal ?? []).map(escapeRe)];
    if (alts.length === 0) throw new Error(`${where}: needs regex or literal text`);
    for (const a of alts) {
      new RegExp(a); // throws on a bad regex
      const bare = a === "zabsreel" || (e.flags === "i" && a.toLowerCase() === "zabsreel");
      if (bare && !BARE_OK.has(e.id)) throw new Error(`${where}: only ${[...BARE_OK].join(", ")} may allow the bare id "${a}"`);
    }
    alts.sort((a, b) => b.length - a.length);
    return { ...e, longest: alts[0].length, re: new RegExp(alts.join("|"), "g" + (e.flags ?? "")) };
  });
}

export function loadAllowlist(path) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  return compileEntries(json.entries);
}

function listFiles(root) {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(out.split("\0").filter(Boolean))].sort();
}

function readText(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return null; // deleted in the working tree, or not a regular file
  }
  if (buf.subarray(0, 8000).includes(0)) return null;
  return buf.toString("utf8");
}

/**
 * Scans `files` (repo-relative) under `root`. Returns
 * { hits: [{ file, line, pattern, text }], entries: [{ id, file, count, actual }], problems: string[] }.
 */
export function scan({ root, files, entries }) {
  const hits = [];
  const problems = [];
  const actual = new Map(entries.map((e) => [e, 0]));
  const byFile = new Map();
  for (const e of entries) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }
  for (const list of byFile.values()) list.sort((a, b) => b.longest - a.longest);

  for (const file of files) {
    if (SELF.has(file)) continue;
    const text = readText(join(root, file));
    if (text === null) continue;
    const mine = byFile.get(file) ?? [];
    const lines = text.split(/\r?\n/);
    lines.forEach((original, i) => {
      let line = original;
      for (const e of mine) {
        line = line.replace(e.re, (m) => {
          actual.set(e, actual.get(e) + 1);
          // The allowed text may hold only the patterns its entry lists.
          for (const [id, re] of Object.entries(PATTERNS)) {
            if (!e.patterns.includes(id) && new RegExp(re.source, re.flags).test(m)) {
              problems.push(`${file}:${i + 1}: ${e.id} allows "${m}", which contains "${id}" (not in its patterns)`);
            }
          }
          // A NUL keeps word boundaries on both sides of the removed text.
          return "\0";
        });
      }
      for (const [id, re] of Object.entries(PATTERNS)) {
        const n = line.match(new RegExp(re.source, re.flags))?.length ?? 0;
        if (n > 0) hits.push({ file, line: i + 1, pattern: id, count: n, text: original.trim().slice(0, 160) });
      }
    });
  }
  const counted = entries.map((e) => ({ id: e.id, file: e.file, count: e.count, actual: actual.get(e) }));
  return { hits, entries: counted, problems };
}

/** The failures in a scan result: unallowed hits, other problems and count mismatches. */
export function failuresOf({ hits, entries, problems }) {
  const bad = entries.filter((e) => e.actual !== e.count);
  return { hits, problems, bad, ok: hits.length === 0 && problems.length === 0 && bad.length === 0 };
}

/** Prints the result; returns true when it is clean. */
function report(result, { counts = false, log = console.log, err = console.error } = {}) {
  const { hits, problems, bad, ok } = failuresOf(result);
  for (const h of hits) err(`${h.file}:${h.line}: "${h.pattern}"${h.count > 1 ? ` x${h.count}` : ""}: ${h.text}`);
  for (const p of problems) err(p);
  for (const e of bad) {
    const why = e.actual > e.count ? "a new mention" : e.actual === 0 ? "no match: stale entry or missing file" : "fewer matches: stale entry";
    err(`${e.file}: allowlist ${e.id} recorded ${e.count}, found ${e.actual} (${why})`);
  }
  if (counts) for (const e of result.entries) log(`${e.id}\t${e.file}\trecorded ${e.count}\tfound ${e.actual}`);
  if (ok) log(`[check-brand] ok: no leftover names; ${result.entries.length} allowlist entries match their counts`);
  else err(`[check-brand] FAILED: ${hits.length} unallowed hit(s), ${bad.length} allowlist count mismatch(es), ${problems.length} other problem(s)`);
  return ok;
}

// ---------------------------------------------------------------- self-test

function selfTest() {
  const real = new Map(loadAllowlist(DEFAULT_ALLOWLIST).map((e) => [e.id, e]));
  const take = (id, file, count) => {
    const e = real.get(id);
    if (!e) throw new Error(`self-test: the allowlist has no entry ${id}`);
    return { ...e, file, count };
  };
  const dir = mkdtempSync(join(tmpdir(), "check-brand-"));
  let failures = 0;
  const run = (name, files, entries, expect) => {
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), body);
    }
    const r = scan({ root: dir, files: Object.keys(files), entries });
    const problem = expect(r);
    console.log(`${problem ? "FAIL" : "ok  "} ${name}${problem ? `: ${problem}` : ""}`);
    if (problem) failures++;
    rmSync(join(dir, "case"), { recursive: true, force: true });
  };
  const mismatches = (r) => failuresOf(r).bad;
  const clean = (r) => (failuresOf(r).ok ? null : `expected clean, got ${JSON.stringify(failuresOf(r))}`);

  try {
    const readme = "case/README.md";
    const brand = "case/packages/core/src/brand.ts";
    const releasing = "case/docs/RELEASING.md";

    run(
      "an allowed phrase passes",
      { [readme]: "Up to version 0.2.0 this app was called ZabsReel. It used the key `zabsreel`.\n" },
      [take("A6", readme, 2)],
      clean,
    );

    run(
      "4789 in a brand file fails, its allowed names do not",
      { [brand]: 'const OLD = "zabsreel"; // ZabsReel\nconst PORT = 4789;\n' },
      [take("A13", brand, 2)],
      (r) => {
        const h = r.hits.map((x) => `${x.line}:${x.pattern}`).join(",");
        return h === "2:4789" && !mismatches(r).length ? null : `hits ${h || "(none)"}`;
      },
    );

    run(
      "a bare zabsreel beside an allowed phrase on one README line fails",
      { [readme]: "Up to version 0.2.0 this app was called ZabsReel, see ~/.zabsreel/backups.\n" },
      [take("A6", readme, 1)],
      (r) => {
        const h = r.hits.map((x) => `${x.line}:${x.pattern}`).join(",");
        return h === "1:zabsreel" ? null : `hits ${h || "(none)"}`;
      },
    );

    run(
      "a pattern joined to an allowed phrase still fails",
      { [readme]: "this app was called ZabsReel4789 and xthis app was called ZabsReel\n" },
      [take("A6", readme, 2)],
      (r) => (r.hits.some((x) => x.pattern === "4789") ? null : "4789 was not reported"),
    );

    const legacyBlock = [
      "export const LEGACY = {",
      '  productName: "ZabsReel",',
      '  id: "zabsreel",',
      '  mcpKey: "zabsreel",',
      '  skillName: "zabsreel-editor",',
      '  desktopPackage: "zabsreel-desktop",',
      '  dataDirParts: [".zabsreel", "data"],',
      "};",
    ];
    run("the six LEGACY values of an A13 file pass", { [brand]: legacyBlock.join("\n") + "\n" }, [take("A13", brand, 6)], clean);
    run(
      "one extra match of an A13 entry fails",
      { [brand]: [...legacyBlock, "// the old ZabsReel name"].join("\n") + "\n" },
      [take("A13", brand, 6)],
      (r) => {
        const m = mismatches(r);
        return m.length === 1 && m[0].actual === 7 && m[0].count === 6 ? null : `mismatches ${JSON.stringify(m)}`;
      },
    );

    run(
      "an entry with no match fails",
      { [readme]: "Nothing old here.\n" },
      [take("A6", readme, 1)],
      (r) => {
        const m = mismatches(r);
        return m.length === 1 && m[0].actual === 0 ? null : `mismatches ${JSON.stringify(m)}`;
      },
    );

    run(
      "an entry for a missing file fails",
      { [readme]: "Nothing old here.\n" },
      [take("A6", "case/no-such-file.md", 1)],
      (r) => (mismatches(r).length === 1 ? null : "the missing file was not reported"),
    );

    run(
      "fewer matches than recorded fail",
      { [readme]: "this app was called ZabsReel\n" },
      [take("A6", readme, 2)],
      (r) => (mismatches(r).length === 1 && mismatches(r)[0].actual === 1 ? null : "the stale count was not reported"),
    );

    run(
      "every pattern fails in a file with no entry; ~/.aive cache paths pass",
      {
        "case/a.md": "ZABSREEL\nby Relo\nport 4789\n~/.aive/data\nC:\\Users\\x\\.aive\\data\nai-video-editor\nvideo-editor-pro\n~/.aive/models and ~/.aive/whisper\nrelocate 14789 Reload Relocate\n",
      },
      [],
      (r) => {
        const got = r.hits.map((x) => `${x.line}:${x.pattern}`).join(",");
        const want = "1:zabsreel,2:Relo,3:4789,4:.aive/data,5:.aive/data,6:ai-video-editor,7:video-editor-pro";
        return got === want ? null : `hits ${got || "(none)"}`;
      },
    );

    run(
      "a binary file is skipped",
      { "case/blob.bin": Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(" zabsreel 4789 Relo ")]) },
      [],
      clean,
    );

    run(
      "a case-sensitive entry does not allow other spellings (RELEASING: ZabsReel, not zabsreel)",
      { [releasing]: "Version 0.2.0 shipped as ZabsReel with\nthe zabsreel id\n" },
      [take("A4", releasing, 1)],
      (r) => {
        const h = r.hits.map((x) => `${x.line}:${x.pattern}`).join(",");
        return h === "2:zabsreel" && !mismatches(r).length ? null : `hits ${h || "(none)"}`;
      },
    );

    run(
      "allowed text that holds a pattern its entry does not list fails",
      { [readme]: "this app was called ZabsReel\n" },
      [{ ...take("A6", readme, 1), patterns: ["Relo"] }],
      (r) => (r.problems.length === 1 ? null : `problems ${JSON.stringify(r.problems)}`),
    );

    const credit = real.get("A1").literal?.[0];
    run(
      "a longer entry runs before a shorter one on the same line",
      { [readme]: `> ${credit}\n` },
      [take("A2", readme, 0), take("A1", readme, 1)],
      (r) => (r.hits.length || mismatches(r).length ? `got ${JSON.stringify({ hits: r.hits, entries: mismatches(r) })}` : null),
    );

    // The loader's own rules.
    const rejects = (name, raw) => {
      let threw = false;
      try {
        compileEntries(raw);
      } catch {
        threw = true;
      }
      console.log(`${threw ? "ok  " : "FAIL"} ${name}`);
      if (!threw) failures++;
    };
    const base = { id: "A6", file: "README.md", literal: ["this app was called ZabsReel"], patterns: ["zabsreel"], count: 1, reason: "x" };
    rejects("the bare id zabsreel outside A11-A14 is refused", [{ ...base, literal: [], regex: ["zabsreel"] }]);
    rejects("the bare id in any case outside A11-A14 is refused", [{ ...base, literal: [], regex: ["ZabsReel"], flags: "i" }]);
    rejects("an unknown pattern id is refused", [{ ...base, patterns: ["ZabsReel"] }]);
    rejects("a zero count is refused", [{ ...base, count: 0 }]);
    rejects("an entry without a reason is refused", [{ ...base, reason: "" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failures ? `[check-brand] self-test FAILED: ${failures} case(s)` : "[check-brand] self-test ok");
  return failures === 0;
}

// ---------------------------------------------------------------- main

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) {
    process.exit(selfTest() ? 0 : 1);
  }
  const root = resolve(arg("--root") ?? DEFAULT_ROOT);
  let entries;
  try {
    entries = loadAllowlist(resolve(arg("--allowlist") ?? DEFAULT_ALLOWLIST));
  } catch (err) {
    console.error(`[check-brand] cannot load the allowlist: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  const result = scan({ root, files: listFiles(root), entries });
  process.exit(report(result, { counts: process.argv.includes("--counts") }) ? 0 : 1);
}
