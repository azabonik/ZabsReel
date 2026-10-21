// Judge lock gate (PLAN-P4b section 6): the judge (judge/: its tests, the
// adapter protocol, the driver, the measurements, the adapters, the fixtures
// script) decides whether a rewrite of the editor behaves as the tested one
// does, so the agents that rewrite the editor must not change it. Every file
// under judge/ must have its line in judge/JUDGE.lock with the same sha256; a
// file the lock does not list (added) and a listed file that is gone (deleted)
// fail too, and so does a link. Nothing under judge/ is skipped: a __pycache__
// file is a file the lock does not list. A change to the judge therefore
// changes JUDGE.lock in the same pull request, where review sees it.
//
// Usage: node scripts/check-judge-lock.mjs [--root <judge dir>]   (reads only)
//        node scripts/check-judge-lock.mjs --write [--root <judge dir>]
//        node scripts/check-judge-lock.mjs --self-test
// --write rewrites JUDGE.lock from the files as they are (sorted, so the same
// files give the same bytes). A lock update needs Anthony's review
// (judge/README.md). Exits 0 when the files match the lock, 1 otherwise.
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "judge");
const LOCK = "JUDGE.lock";
const HEADER = [
  "# sha256 of every file under judge/ except this one, sorted by path (scripts/check-judge-lock.mjs).",
  "# The agents that rewrite the editor must not change the judge. A change to this file needs Anthony's review.",
];

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Every file under `root`, as "/"-separated paths relative to it, without the lock; a link is a problem. */
function walk(root, rel, problems, out = []) {
  for (const entry of readdirSync(rel ? join(root, rel) : root, { withFileTypes: true })) {
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) problems.push(`${p} is a link`);
    else if (entry.isDirectory()) walk(root, p, problems, out);
    else if (p !== LOCK) out.push(p);
  }
  return out;
}

/** The lock's entries: path -> sha256. Malformed lines and paths that cannot be judge files are problems. */
function readLock(root, problems) {
  const entries = new Map();
  const file = join(root, LOCK);
  if (!existsSync(file)) {
    problems.push(`${LOCK} is missing in ${root}`);
    return entries;
  }
  for (const [i, raw] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    const path = m?.[2];
    if (!m || path === LOCK || path.startsWith("/") || path.split("/").some((s) => s === ".." || s === "." || s === "")) {
      problems.push(`${LOCK} line ${i + 1} is not "<sha256>  <path under judge/>": ${JSON.stringify(raw.slice(0, 120))}`);
    } else if (entries.has(path)) {
      problems.push(`${LOCK} lists ${path} twice`);
    } else {
      entries.set(path, m[1]);
    }
  }
  return entries;
}

/** The problems with the judge files under `root` (none when they match the lock). */
export function check(root) {
  const problems = [];
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return [`${root} is not a folder`];
  const lock = readLock(root, problems);
  const found = walk(root, "", problems).sort();
  for (const path of found) {
    const want = lock.get(path);
    if (want === undefined) problems.push(`${path} is not in ${LOCK} (a judge file added without a lock update)`);
    else if (sha256(join(root, path)) !== want) problems.push(`${path} differs from ${LOCK} (a judge file changed without a lock update)`);
  }
  for (const path of lock.keys()) if (!found.includes(path)) problems.push(`${path} is in ${LOCK} but missing (deleted without a lock update)`);
  return problems;
}

/** The lock's text for the files under `root` as they are. */
export function lockText(root) {
  const problems = [];
  const files = walk(root, "", problems).sort();
  if (problems.length) throw new Error(problems.join("; "));
  return `${[...HEADER, ...files.map((p) => `${sha256(join(root, p))}  ${p}`)].join("\n")}\n`;
}

// ---------------------------------------------------------------- self-test

/** Each case on a fresh copy of the real judge tree in a temp folder; the real files are never touched. */
function selfTest() {
  let failures = 0;
  const base = mkdtempSync(join(tmpdir(), "zm-judge-lock-"));
  let n = 0;
  const run = (name, change, want) => {
    const root = join(base, String(++n));
    cpSync(DEFAULT_ROOT, root, { recursive: true });
    change(root);
    const problems = check(root);
    const ok = want === null ? problems.length === 0 : problems.some((p) => want.test(p));
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: ${JSON.stringify(problems)}`}`);
    if (!ok) failures++;
  };
  const flipByte = (file) => {
    const b = readFileSync(file);
    b[Math.floor(b.length / 2)] ^= 1;
    writeFileSync(file, b);
  };
  try {
    run("the files as locked pass", () => {}, null);
    run("one byte changed in the driver fails", (r) => flipByte(join(r, "driver.py")), /^driver\.py differs/);
    run("a changed test fails", (r) => writeFileSync(join(r, "tests", "test_import_export.py"), `${readFileSync(join(r, "tests", "test_import_export.py"), "utf8")}\n`), /^tests\/test_import_export\.py differs/);
    run("a changed adapter fails", (r) => flipByte(join(r, "adapters", "v020", "adapter.py")), /^adapters\/v020\/adapter\.py differs/);
    run("a test added fails", (r) => writeFileSync(join(r, "tests", "test_extra.py"), "def run(t):\n    t.check('x', True)\n"), /^tests\/test_extra\.py is not in JUDGE\.lock/);
    run("a test deleted fails", (r) => unlinkSync(join(r, "tests", "test_import_export.py")), /^tests\/test_import_export\.py is in JUDGE\.lock but missing/);
    run("a __pycache__ file fails", (r) => {
      mkdirSync(join(r, "tests", "__pycache__"), { recursive: true });
      writeFileSync(join(r, "tests", "__pycache__", "test_import_export.cpython-312.pyc"), "x");
    }, /^tests\/__pycache__\/test_import_export\.cpython-312\.pyc is not in JUDGE\.lock/);
    run("a link fails", (r) => symlinkSync(join(r, "driver.py"), join(r, "tests", "linked.py")), /^tests\/linked\.py is a link/);
    run("a missing lock fails", (r) => unlinkSync(join(r, LOCK)), /JUDGE\.lock is missing/);
    run("a malformed lock line fails", (r) => writeFileSync(join(r, LOCK), `${readFileSync(join(r, LOCK), "utf8")}not a lock line\n`), /line \d+ is not/);
    run("a lock line with '..' fails", (r) => writeFileSync(join(r, LOCK), `${readFileSync(join(r, LOCK), "utf8")}${"0".repeat(64)}  tests/../../package.json\n`), /line \d+ is not/);
    run("a file listed twice fails", (r) => {
      const text = readFileSync(join(r, LOCK), "utf8");
      writeFileSync(join(r, LOCK), `${text}${text.split("\n").find((l) => l.endsWith("  driver.py"))}\n`);
    }, /lists driver\.py twice/);
    run("a lock rewritten with --write's text for changed files passes (the update path)", (r) => {
      flipByte(join(r, "observe.py"));
      writeFileSync(join(r, LOCK), lockText(r));
    }, null);
    // The committed lock is what --write gives for the committed files (sorted, the same header).
    const same = readFileSync(join(DEFAULT_ROOT, LOCK), "utf8") === lockText(DEFAULT_ROOT);
    console.log(`${same ? "ok  " : "FAIL"} the committed lock is byte-identical to --write's text`);
    if (!same) failures++;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  console.log(failures ? `[check-judge-lock] self-test FAILED: ${failures} case(s)` : "[check-judge-lock] self-test ok");
  return failures === 0;
}

// ---------------------------------------------------------------- main

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  const i = process.argv.indexOf("--root");
  const root = resolve(i >= 0 ? process.argv[i + 1] : DEFAULT_ROOT);
  if (process.argv.includes("--write")) {
    writeFileSync(join(root, LOCK), lockText(root));
    console.log(`[check-judge-lock] wrote ${join(root, LOCK)}; a lock update needs Anthony's review`);
    process.exit(0);
  }
  const problems = check(root);
  for (const p of problems) console.error(p);
  if (problems.length) console.error(`[check-judge-lock] FAILED: ${problems.length} problem(s) in ${root}`);
  else console.log(`[check-judge-lock] ok: every file under ${root} matches ${LOCK}`);
  process.exit(problems.length ? 1 : 0);
}
