// Clean-room lock gate (MOTION-PLAN D3; decisions.md RUNTIME OWNERSHIP,
// HASH-LOCK): the clean-room runtime, its tests and its notes are changed only
// by a clean-room implementer session, so the files in the repository must be
// exactly the ones packages/motion/cleanroom/CLEANROOM.lock lists. Every file
// under runtime/ and test/, and NOTES.md, must have its lock line with the
// same sha256; a file the lock does not list (added) and a listed file that is
// gone (deleted) fail too. The other files beside them (tsconfig.json,
// package.json, the lock itself) are not clean-room output and are not checked.
//
// It only reads. Usage: node scripts/check-cleanroom-lock.mjs [--root <cleanroom dir>]
//                       node scripts/check-cleanroom-lock.mjs --self-test
// Exits 0 when the files match the lock, 1 otherwise.
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "packages", "motion", "cleanroom");
const LOCK = "CLEANROOM.lock";
/** What the lock covers: these folders, whole, and these files. */
const FOLDERS = ["runtime", "test"];
const FILES = ["NOTES.md"];

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Every file under `root`/`rel`, as "/"-separated paths relative to `root`; a link is a problem. */
function walk(root, rel, problems, out = []) {
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const p = `${rel}/${entry.name}`;
    if (entry.isSymbolicLink()) problems.push(`${p} is a link`);
    else if (entry.isDirectory()) walk(root, p, problems, out);
    else out.push(p);
  }
  return out;
}

/** The lock's entries: path -> sha256. Malformed lines and paths outside the covered set are problems. */
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
    if (!m || !(FILES.includes(path) || FOLDERS.some((f) => path.startsWith(`${f}/`))) || path.split("/").includes("..")) {
      problems.push(`${LOCK} line ${i + 1} is not "<sha256>  <runtime/…, test/… or NOTES.md>": ${JSON.stringify(raw.slice(0, 120))}`);
    } else if (entries.has(path)) {
      problems.push(`${LOCK} lists ${path} twice`);
    } else {
      entries.set(path, m[1]);
    }
  }
  return entries;
}

/** The problems with the clean-room files under `root` (none when they match the lock). */
export function check(root) {
  const problems = [];
  const lock = readLock(root, problems);
  const found = [];
  for (const f of FOLDERS) {
    if (existsSync(join(root, f)) && lstatSync(join(root, f)).isDirectory()) walk(root, f, problems, found);
    else problems.push(`${f}/ is missing in ${root}`);
  }
  for (const f of FILES) if (existsSync(join(root, f))) found.push(f);
  for (const path of found.sort()) {
    const want = lock.get(path);
    if (want === undefined) problems.push(`${path} is not in ${LOCK} (a file added outside a clean-room session)`);
    else if (sha256(join(root, path)) !== want) problems.push(`${path} differs from ${LOCK} (changed outside a clean-room session)`);
  }
  for (const path of lock.keys()) if (!found.includes(path)) problems.push(`${path} is in ${LOCK} but missing`);
  return problems;
}

// ---------------------------------------------------------------- self-test

/** Each case on a fresh copy of the real clean-room tree in a temp folder; the real files are never touched. */
function selfTest() {
  let failures = 0;
  const base = mkdtempSync(join(tmpdir(), "zr-cleanroom-lock-"));
  let n = 0;
  const run = (name, change, want) => {
    const root = join(base, String(++n));
    for (const p of [...FOLDERS, ...FILES, LOCK]) cpSync(join(DEFAULT_ROOT, p), join(root, p), { recursive: true });
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
    run("one byte changed in a runtime file fails", (r) => flipByte(join(r, "runtime", "src", "spring.ts")), /^runtime\/src\/spring\.ts differs/);
    run("a file added under runtime/src fails", (r) => writeFileSync(join(r, "runtime", "src", "extra.ts"), "export {};\n"), /^runtime\/src\/extra\.ts is not in CLEANROOM\.lock/);
    run("a runtime file deleted fails", (r) => unlinkSync(join(r, "runtime", "src", "easing.ts")), /^runtime\/src\/easing\.ts is in CLEANROOM\.lock but missing/);
    run("a changed test fails", (r) => flipByte(join(r, "test", "helpers", "host.ts")), /^test\/helpers\/host\.ts differs/);
    run("a changed NOTES.md fails", (r) => writeFileSync(join(r, "NOTES.md"), readFileSync(join(r, "NOTES.md"), "utf8") + "\n"), /^NOTES\.md differs/);
    run("runtime/exports.json changed fails", (r) => flipByte(join(r, "runtime", "exports.json")), /^runtime\/exports\.json differs/);
    run("a missing lock fails", (r) => unlinkSync(join(r, LOCK)), /CLEANROOM\.lock is missing/);
    run("a lock line for a file outside the covered set fails", (r) => writeFileSync(join(r, LOCK), `${readFileSync(join(r, LOCK), "utf8")}${"0".repeat(64)}  tsconfig.json\n`), /line \d+ is not/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  console.log(failures ? `[check-cleanroom-lock] self-test FAILED: ${failures} case(s)` : "[check-cleanroom-lock] self-test ok");
  return failures === 0;
}

// ---------------------------------------------------------------- main

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  const i = process.argv.indexOf("--root");
  const root = resolve(i >= 0 ? process.argv[i + 1] : DEFAULT_ROOT);
  const problems = check(root);
  for (const p of problems) console.error(p);
  if (problems.length) console.error(`[check-cleanroom-lock] FAILED: ${problems.length} problem(s) in ${root}`);
  else console.log(`[check-cleanroom-lock] ok: ${root}'s runtime/, test/ and NOTES.md match ${LOCK}`);
  process.exit(problems.length ? 1 : 0);
}
