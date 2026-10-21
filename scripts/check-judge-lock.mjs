// Judge lock gate (PLAN-P4b section 6): the judge (judge/: its tests, the
// adapter protocol, the driver, the measurements, the adapters, the fixtures
// script) decides whether a rewrite of the editor behaves as the tested one
// does, so the agents that rewrite the editor must not change it. Every file
// under judge/, and the two files that decide how CI runs it (this gate,
// scripts/check-judge-lock.mjs, and the judge's workflow,
// .github/workflows/judge.yml), must have its line in judge/JUDGE.lock with
// the same sha256; a judge file the lock does not list (added), a listed file
// that is gone (deleted) and a missing gate or workflow fail too, and so does
// a link. Nothing under judge/ is skipped: a __pycache__ file is a file the
// lock does not list. A change to any of them therefore changes JUDGE.lock in
// the same pull request, where review sees it.
//
// ci.yml runs this gate on the checkout, so deleting judge.yml (or this
// script) fails ci.yml. judge.yml copies judge/, this script and judge.yml out
// of the checkout before the install, checks the copy with the copied gate, and
// runs the judge from the copy (judge/README.md, "Threat model").
//
// On a pull request judge.yml also runs the BASE branch's copy of this gate,
// from $RUNNER_TEMP, with --root on the pull request's checkout, so a pull
// request cannot weaken the checking logic and pass its own weakened gate.
//
// Usage: node scripts/check-judge-lock.mjs [--root <checkout>]   (reads only)
//        node scripts/check-judge-lock.mjs --write [--root <checkout>]
//        node scripts/check-judge-lock.mjs --self-test
// <checkout> is the folder that holds judge/ (default: this script's ../);
// --repo is the same option.
// --write rewrites JUDGE.lock from the files as they are (sorted, so the same
// files give the same bytes). A lock update is reviewed by the gauntlet on its
// pull request, which includes a lock and leakage check (judge/README.md).
// Exits 0 when the files match the lock, 1 otherwise.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JUDGE = "judge";
const LOCK = `${JUDGE}/JUDGE.lock`;
/** Paths outside judge/ that the lock covers: the gate itself and the workflow that runs the judge. */
export const EXTRA = ["scripts/check-judge-lock.mjs", ".github/workflows/judge.yml"];
const HEADER = [
  "# sha256 of every file under judge/ except this one, of scripts/check-judge-lock.mjs and of",
  "# .github/workflows/judge.yml, sorted by path from the repository root (scripts/check-judge-lock.mjs).",
  "# The agents that rewrite the editor must not change the judge. The gauntlet reviews a change to this file on its PR.",
];

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Every file under `repo`/`rel`, as "/"-separated paths from `repo`, without the lock; a link is a problem. */
function walk(repo, rel, problems, out = []) {
  for (const entry of readdirSync(join(repo, rel), { withFileTypes: true })) {
    const p = `${rel}/${entry.name}`;
    if (entry.isSymbolicLink()) problems.push(`${p} is a link`);
    else if (entry.isDirectory()) walk(repo, p, problems, out);
    else if (p !== LOCK) out.push(p);
  }
  return out;
}

/** The covered files that exist: judge/** and the EXTRA paths (a missing or linked EXTRA path is a problem). */
function covered(repo, problems) {
  const out = walk(repo, JUDGE, problems);
  for (const p of EXTRA) {
    const full = join(repo, p);
    if (!lstatExists(full)) problems.push(`${p} is missing (JUDGE.lock covers it; deleting it needs a lock update and review)`);
    else if (lstatSync(full).isSymbolicLink()) problems.push(`${p} is a link`);
    else out.push(p);
  }
  return out.sort();
}

function lstatExists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

const isCoveredPath = (path) => EXTRA.includes(path) || (path.startsWith(`${JUDGE}/`) && path !== LOCK);

/** The lock's entries: path -> sha256. Malformed lines and paths the lock cannot cover are problems. */
function readLock(repo, problems) {
  const entries = new Map();
  const file = join(repo, LOCK);
  if (!existsSync(file)) {
    problems.push(`${LOCK} is missing in ${repo}`);
    return entries;
  }
  for (const [i, raw] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    const path = m?.[2];
    if (!m || !isCoveredPath(path) || path.split("/").some((s) => s === ".." || s === "." || s === "")) {
      problems.push(`${LOCK} line ${i + 1} is not "<sha256>  <judge/... or ${EXTRA.join(" or ")}>": ${JSON.stringify(raw.slice(0, 120))}`);
    } else if (entries.has(path)) {
      problems.push(`${LOCK} lists ${path} twice`);
    } else {
      entries.set(path, m[1]);
    }
  }
  return entries;
}

/** The problems with the covered files under `repo` (none when they match the lock). */
export function check(repo) {
  const problems = [];
  const judge = join(repo, JUDGE);
  if (!existsSync(judge) || !lstatSync(judge).isDirectory()) return [`${judge} is not a folder`];
  const lock = readLock(repo, problems);
  const found = covered(repo, problems);
  for (const path of found) {
    const want = lock.get(path);
    if (want === undefined) problems.push(`${path} is not in JUDGE.lock (a judge file added without a lock update)`);
    else if (sha256(join(repo, path)) !== want) problems.push(`${path} differs from JUDGE.lock (a judge file changed without a lock update)`);
  }
  for (const path of lock.keys()) if (!found.includes(path)) problems.push(`${path} is in JUDGE.lock but missing (deleted without a lock update)`);
  return problems;
}

/** The lock's text for the covered files under `repo` as they are. */
export function lockText(repo) {
  const problems = [];
  const files = covered(repo, problems);
  if (problems.length) throw new Error(problems.join("; "));
  return `${[...HEADER, ...files.map((p) => `${sha256(join(repo, p))}  ${p}`)].join("\n")}\n`;
}

// ---------------------------------------------------------------- self-test

/** u+w on everything under `p` (the CI copy is read-only; copies of it must be writable to change and delete). */
function writable(p) {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return;
  chmodSync(p, st.mode | 0o200);
  if (st.isDirectory()) for (const n of readdirSync(p)) writable(join(p, n));
}

/** Each case on a fresh copy of the covered files (judge/, the gate, the workflow) in a temp folder; the real files
 * are never touched. */
function selfTest() {
  let failures = 0;
  const base = mkdtempSync(join(tmpdir(), "zm-judge-lock-"));
  let n = 0;
  const run = (name, change, want) => {
    const root = join(base, String(++n));
    cpSync(join(DEFAULT_REPO, JUDGE), join(root, JUDGE), { recursive: true });
    // The self-test's own list, not EXTRA, so a gate that drops a path from EXTRA fails the cases below.
    for (const p of ["scripts/check-judge-lock.mjs", ".github/workflows/judge.yml"]) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      cpSync(join(DEFAULT_REPO, p), join(root, p));
    }
    writable(root);
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
  const append = (file, text) => writeFileSync(file, `${readFileSync(file, "utf8")}${text}`);
  const J = (r, ...p) => join(r, JUDGE, ...p);
  try {
    run("the files as locked pass", () => {}, null);
    run("one byte changed in the driver fails", (r) => flipByte(J(r, "driver.py")), /^judge\/driver\.py differs/);
    run("a changed test fails", (r) => append(J(r, "tests", "test_import_export.py"), "\n"), /^judge\/tests\/test_import_export\.py differs/);
    run("a changed adapter fails", (r) => flipByte(J(r, "adapters", "v020", "adapter.py")), /^judge\/adapters\/v020\/adapter\.py differs/);
    run("a test added fails", (r) => writeFileSync(J(r, "tests", "test_extra.py"), "def run(t):\n    t.check('x', True)\n"), /^judge\/tests\/test_extra\.py is not in JUDGE\.lock/);
    run("a test deleted fails", (r) => unlinkSync(J(r, "tests", "test_import_export.py")), /^judge\/tests\/test_import_export\.py is in JUDGE\.lock but missing/);
    run("a __pycache__ file fails", (r) => {
      mkdirSync(J(r, "tests", "__pycache__"), { recursive: true });
      writeFileSync(J(r, "tests", "__pycache__", "test_import_export.cpython-312.pyc"), "x");
    }, /^judge\/tests\/__pycache__\/test_import_export\.cpython-312\.pyc is not in JUDGE\.lock/);
    run("a link fails", (r) => symlinkSync(J(r, "driver.py"), J(r, "tests", "linked.py")), /^judge\/tests\/linked\.py is a link/);
    run("the gate script edited fails", (r) => append(join(r, "scripts", "check-judge-lock.mjs"), "// x\n"), /^scripts\/check-judge-lock\.mjs differs/);
    run("the gate script deleted fails", (r) => unlinkSync(join(r, "scripts", "check-judge-lock.mjs")), /^scripts\/check-judge-lock\.mjs is missing/);
    run("the judge workflow edited fails", (r) => append(join(r, ".github", "workflows", "judge.yml"), "# x\n"), /^\.github\/workflows\/judge\.yml differs/);
    run("the judge workflow deleted fails", (r) => unlinkSync(join(r, ".github", "workflows", "judge.yml")), /^\.github\/workflows\/judge\.yml is missing/);
    run("the judge workflow replaced by a link fails", (r) => {
      unlinkSync(join(r, ".github", "workflows", "judge.yml"));
      symlinkSync(join(DEFAULT_REPO, ".github", "workflows", "judge.yml"), join(r, ".github", "workflows", "judge.yml"));
    }, /^\.github\/workflows\/judge\.yml is a link/);
    run("a missing lock fails", (r) => unlinkSync(join(r, LOCK)), /JUDGE\.lock is missing/);
    run("a malformed lock line fails", (r) => append(join(r, LOCK), "not a lock line\n"), /line \d+ is not/);
    run("a lock line with '..' fails", (r) => append(join(r, LOCK), `${"0".repeat(64)}  judge/tests/../../package.json\n`), /line \d+ is not/);
    run("a lock line for a path the lock does not cover fails", (r) => append(join(r, LOCK), `${"0".repeat(64)}  package.json\n`), /line \d+ is not/);
    run("a file listed twice fails", (r) => {
      const text = readFileSync(join(r, LOCK), "utf8");
      append(join(r, LOCK), `${text.split("\n").find((l) => l.endsWith("  judge/driver.py"))}\n`);
    }, /lists judge\/driver\.py twice/);
    run("a lock rewritten with --write's text for changed files passes (the update path)", (r) => {
      flipByte(J(r, "observe.py"));
      append(join(r, ".github", "workflows", "judge.yml"), "# reviewed\n");
      writeFileSync(join(r, LOCK), lockText(r));
    }, null);
    // From the command line, as judge.yml runs the base branch's gate: a lone copy of this script in another folder
    // (its own ../ holds no judge/) checks the tree that --root names, and only that tree.
    const lone = join(base, "lone");
    mkdirSync(lone);
    cpSync(fileURLToPath(import.meta.url), join(lone, "check-judge-lock.mjs"));
    const cli = (name, args, root, change, want) => {
      if (root) {
        cpSync(join(DEFAULT_REPO, JUDGE), join(root, JUDGE), { recursive: true });
        for (const p of ["scripts/check-judge-lock.mjs", ".github/workflows/judge.yml"]) {
          mkdirSync(dirname(join(root, p)), { recursive: true });
          cpSync(join(DEFAULT_REPO, p), join(root, p));
        }
        writable(root);
        change(root);
      }
      const r = spawnSync(process.execPath, [join(lone, "check-judge-lock.mjs"), ...args], { encoding: "utf8" });
      const ok = r.status === want.status && want.out.test(`${r.stdout}${r.stderr}`);
      console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: exit ${r.status}: ${r.stdout}${r.stderr}`}`);
      if (!ok) failures++;
    };
    const good = join(base, "root-good");
    const bad = join(base, "root-bad");
    cli("a lone copy with --root on a matching tree passes", ["--root", good], good, () => {}, { status: 0, out: /\[check-judge-lock\] ok: .* match JUDGE\.lock/ });
    cli("a lone copy with --root on a changed tree fails", ["--root", bad], bad, (r) => flipByte(J(r, "driver.py")), { status: 1, out: /^judge\/driver\.py differs/m });
    cli("a lone copy with --repo (the same option) on a changed tree fails", ["--repo", bad], null, null, { status: 1, out: /^judge\/driver\.py differs/m });
    cli("a lone copy without --root checks its own ../ (no judge/ there) and fails", [], null, null, { status: 1, out: /is not a folder/ });
    // The committed lock is what --write gives for the committed files (sorted, the same header).
    const same = readFileSync(join(DEFAULT_REPO, LOCK), "utf8") === lockText(DEFAULT_REPO);
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
  const i = Math.max(process.argv.indexOf("--root"), process.argv.indexOf("--repo"));
  if (i >= 0 && !process.argv[i + 1]) {
    console.error(`[check-judge-lock] ${process.argv[i]} needs a folder`);
    process.exit(2);
  }
  const repo = resolve(i >= 0 ? process.argv[i + 1] : DEFAULT_REPO);
  if (process.argv.includes("--write")) {
    writeFileSync(join(repo, LOCK), lockText(repo));
    console.log(`[check-judge-lock] wrote ${join(repo, LOCK)}; the gauntlet reviews the lock change on its pull request`);
    process.exit(0);
  }
  const problems = check(repo);
  for (const p of problems) console.error(p);
  if (problems.length) console.error(`[check-judge-lock] FAILED: ${problems.length} problem(s) in ${repo}`);
  else console.log(`[check-judge-lock] ok: judge/, ${EXTRA.join(" and ")} in ${repo} match JUDGE.lock`);
  process.exit(problems.length ? 1 : 0);
}
