// Release guard: the first step of .github/workflows/release.yml.
//
// When the ref being built is a tag, it must be `v<semver>` with a version of
// at least 0.2.0 (the first ZedMix release; the inherited v0.1.x and v1.0.5
// tags must never publish) and equal to apps/desktop/package.json "version".
// A branch ref (a manual run from the Actions tab) always passes.
//
// Usage: node scripts/release-guard.mjs [--ref <ref>] [--package <package.json>]
//        node scripts/release-guard.mjs --self-test
// --ref defaults to $GITHUB_REF; --package to ../apps/desktop/package.json.
// Exits 0 when the ref is allowed, 1 when it is refused.
// --self-test checks checkRelease and the CLI exit codes (CI runs it); exits 0 when all cases pass.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_VERSION = [0, 2, 0];
const TAG_PREFIX = "refs/tags/";
// Semver 2.0.0 (no leading zeros in the numbers), with an optional pre-release and build part.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Returns null when the ref is allowed, otherwise the reason it is refused. */
export function checkRelease(ref, packageVersion) {
  if (!ref.startsWith(TAG_PREFIX)) return null;
  const tag = ref.slice(TAG_PREFIX.length);
  if (!tag.startsWith("v")) return `tag "${tag}" is not of the form v<semver>`;
  const version = tag.slice(1);
  const m = SEMVER.exec(version);
  if (!m) return `tag "${tag}" is not of the form v<semver>`;
  const core = [Number(m[1]), Number(m[2]), Number(m[3])];
  let cmp = 0;
  for (let i = 0; i < 3 && cmp === 0; i++) cmp = Math.sign(core[i] - MIN_VERSION[i]);
  // A pre-release of the minimum version sorts below it.
  if (cmp === 0 && m[4]) cmp = -1;
  if (cmp < 0) return `tag "${tag}" is below ${MIN_VERSION.join(".")}; releases start at v${MIN_VERSION.join(".")}`;
  if (version !== packageVersion) {
    return `tag "${tag}" does not match apps/desktop/package.json version "${packageVersion}"`;
  }
  return null;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ---------------------------------------------------------------- self-test

function selfTest() {
  const BELOW = /is below 0\.2\.0/;
  const MISMATCH = /does not match apps\/desktop\/package\.json/;
  const FORM = /is not of the form v<semver>/;
  // [ref, package version, expected: null (allowed) or the reason pattern]
  const cases = [
    ["refs/tags/v0.1.4", "0.2.0", BELOW],
    ["refs/tags/v0.1.4", "0.1.4", BELOW],
    ["refs/tags/v0.2.0-rc.1", "0.2.0", BELOW],
    ["refs/tags/v0.2.0-rc.1", "0.2.0-rc.1", BELOW],
    ["refs/tags/v1.0.5", "0.2.0", MISMATCH],
    ["refs/tags/v0.2.0", "0.2.0", null],
    ["refs/tags/v0.2.1", "0.2.0", MISMATCH],
    ["refs/tags/v0.2.1", "0.2.1", null],
    ["refs/tags/v0.2.1-rc.1", "0.2.1-rc.1", null],
    ["refs/tags/0.2.0", "0.2.0", FORM],
    ["refs/tags/v01.2.0", "01.2.0", FORM],
    ["refs/heads/main", "0.2.0", null],
    ["refs/heads/v0.1.4", "0.2.0", null],
  ];
  let failures = 0;
  const report = (name, problem) => {
    console.log(`${problem ? "FAIL" : "ok  "} ${name}${problem ? `: ${problem}` : ""}`);
    if (problem) failures++;
  };
  for (const [ref, pkg, want] of cases) {
    const got = checkRelease(ref, pkg);
    let problem = null;
    if (want === null && got !== null) problem = `expected allowed, got "${got}"`;
    else if (want !== null && (got === null || !want.test(got))) problem = `expected ${want}, got ${JSON.stringify(got)}`;
    report(`checkRelease(${ref}, package ${pkg})`, problem);
  }
  // v1.0.5 is above the minimum, so with package 0.2.0 only the package check refuses it (plan 3.6: the guard
  // covers future tags; deleting the inherited tags is what stops them). The v0.1.4 and v0.2.0-rc.1 cases with a
  // matching package version pin that the minimum alone refuses them.
  report("checkRelease(refs/tags/v1.0.5, package 1.0.5) passes the minimum", checkRelease("refs/tags/v1.0.5", "1.0.5"));

  // The CLI: exit 0 when allowed, 1 when refused, 1 when the package cannot be read.
  const dir = mkdtempSync(join(tmpdir(), "release-guard-"));
  try {
    const pkg = join(dir, "package.json");
    writeFileSync(pkg, JSON.stringify({ version: "0.2.0" }));
    const self = fileURLToPath(import.meta.url);
    const exitOf = (args) => {
      try {
        execFileSync(process.execPath, [self, ...args], { stdio: "pipe", env: { ...process.env, GITHUB_REF: "" } });
        return 0;
      } catch (err) {
        return typeof err.status === "number" ? err.status : -1;
      }
    };
    const cli = [
      [["--ref", "refs/tags/v0.2.0", "--package", pkg], 0],
      [["--ref", "refs/tags/v0.1.4", "--package", pkg], 1],
      [["--ref", "refs/tags/v0.2.1", "--package", pkg], 1],
      [["--ref", "refs/heads/main", "--package", pkg], 0],
      [["--ref", "refs/tags/v0.2.0", "--package", join(dir, "missing.json")], 1],
    ];
    for (const [args, want] of cli) {
      const got = exitOf(args);
      report(`CLI ${args.slice(0, 2).join(" ")}${args[3].endsWith("missing.json") ? " (no package)" : ""} exits ${want}`, got === want ? null : `exited ${got}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures) {
    console.error(`[release-guard] self-test: ${failures} case(s) failed`);
    process.exit(1);
  }
  console.log("[release-guard] self-test: all cases pass");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes("--self-test")) {
  selfTest();
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ref = arg("--ref") ?? process.env.GITHUB_REF ?? "";
  const pkgPath = resolve(arg("--package") ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "apps", "desktop", "package.json"));
  let version;
  try {
    version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch (err) {
    console.error(`[release-guard] cannot read ${pkgPath}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  const problem = checkRelease(ref, String(version));
  if (problem) {
    console.error(`[release-guard] refused: ${problem}`);
    process.exit(1);
  }
  console.log(`[release-guard] ok: ${ref || "(no ref)"} (package version ${version})`);
}
