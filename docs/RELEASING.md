# Releasing & Auto-Update

How to ship a new version of ZedMix so that installed (Windows) users receive it
**automatically**. This is the operator's guide to the auto-update pipeline wired
via `electron-updater` + GitHub Releases.

---

## TL;DR — cut a release

Releases are triggered by **pushing a git tag** — *not* by pushing code to `main`.

```bash
# 1. Bump the version in ALL FIVE package.json files (see list below) to X.Y.Z
# 2. Commit the bump
git commit -am "Release v0.2.1"

# 3. Tag that commit and push the commit, then that one tag
git tag v0.2.1
git push origin main
git push origin v0.2.1     # never `git push --tags` (see "The release guard")
```

Pushing the `v*` tag starts the **Release** workflow, which builds the Windows
installer + the update feed and publishes a GitHub Release. Installed apps pick it
up on their next launch. The first ZedMix version is **0.2.0**; version numbers
restarted there at the rename.

---

## What counts as "a new version"

Three things must line up or users get nothing:

1. **The tag matches `v*`** — e.g. `v0.2.1`. That's the CI trigger.
2. **The `package.json` version equals the tag** (minus the `v`) and is **higher
   than what users have installed.** `electron-updater` compares the version in the
   published `latest.yml` against the running app's version. Same version → no
   update offered. So a tag alone is not enough — you must bump the version too.
3. **The GitHub Release is _published_, not a draft.** `electron-updater` cannot
   see draft releases. (Our workflow already sets `draft: false`.)

### The five version files to bump

Keep these in lockstep — the app's version is `apps/desktop/package.json`:

| File | Package |
|------|---------|
| `package.json` | repo root |
| `packages/core/package.json` | `@aive/core` |
| `packages/mcp/package.json` | `@aive/mcp` |
| `packages/skill-installer/package.json` | `@azabonik/zedmix` (the `npx @azabonik/zedmix` skill installer) |
| `apps/desktop/package.json` | `zedmix-desktop` ← **the one the updater compares** |

> Only `apps/desktop/package.json` strictly drives the update check, but bump all
> five together so versions never diverge. The `@azabonik/zedmix` package additionally
> ships to npm — after tagging, run `npm publish --workspace @azabonik/zedmix`
> (that's what makes `npx @azabonik/zedmix add` work for users). It's a scoped
> package: publishing requires owning the npm `azabonik` scope (an npm org or the
> username), and `publishConfig.access: public` is already set in its package.json.

---

## What the CI does (on a `v*` tag)

Defined in [`../.github/workflows/release.yml`](../.github/workflows/release.yml):

1. Checks out **the exact commit the tag points to**, then runs the release
   guard (below).
2. `npm ci`, then the graphics add-on's lock check,
   `node scripts/gen-graphics-lock.mjs --check --require-sizes`, and the
   packaging gate's self-test, `node scripts/check-no-remotion.mjs --self-test`
   (see "The graphics add-on" below).
3. `npm run build` (core + mcp + renderer), then the graphics guards on
   Windows paths, with `AIVE_REMOTION_ADDON` set to the checkout:
   `check-remotion-guard.mjs` under Node and under Electron's Node,
   `smoke-chromeguard.ts` (its strace, network-namespace and real-render parts
   skip there) and `smoke-graphicimports.ts`.
4. The network-path gate on Windows (below): `smoke-unc.ts`,
   `smoke-unc-e2e.ts` and `check-io-imports.mjs`. A failure stops the job
   before anything is packaged.
5. The add-on installer on fixtures, `npx tsx packages/core/scripts/smoke-addon.ts`
   (a loopback registry, no network): the installer's renames, name rules and
   recovery on a Windows disk. The rows Windows can't run print
   `skip (win32)` (docs/TESTING.md).
6. The live add-on check: `npx tsx packages/core/scripts/smoke-addon-real.ts --live`
   installs the graphics add-on from `registry.npmjs.org` and Google and renders
   one graphic with it (below).
7. `npm run dist -- --publish never` — electron-builder packs the app, runs the
   packaging gate on it (the `afterPack` hook, below), and produces:
   - `ZedMix-<ver>.exe` — the installer
   - `ZedMix-<ver>.exe.blockmap` — the differential-download map
   - `latest.yml` — **the update feed the app reads**
   - `.zip` (portable) + `SHA256SUMS.txt`
8. Attaches **all** of those to a **published** GitHub Release.

> All three of `.exe`, `.exe.blockmap`, and `latest.yml` must be on the Release,
> or auto-update breaks. The workflow globs them explicitly.

### The release guard

The first step of the workflow runs `node scripts/release-guard.mjs`. When the
workflow runs on a tag, the tag must be `v<semver>`, the version must be at least
**0.2.0**, and it must equal `version` in `apps/desktop/package.json`; any other
tag stops the job before anything is built. A run on a branch passes. To check a
tag before you push it:

```bash
node scripts/release-guard.mjs --ref refs/tags/v0.2.1
```

The guard protects only tags cut from `main` after the rename. A tag push, and a
re-run on a tag, use the workflow file **in the tag's own commit**. The four tags
inherited from upstream (v0.1.2, v0.1.3, v0.1.4 and v1.0.5) point at commits
whose workflow has no guard, and a 1.0.5 release would rank above every 0.2.x
release in the updater. Delete those tags (locally and on GitHub) before you push
`main`, never run `git push --tags`, and never start the workflow on one of
them.

### The network-path gate

ZedMix opens media on a network computer only after the user allows that
computer (README, "Media on a network drive"). The Linux CI runs the same
smokes on every push to main and every pull request, but only a Windows host
signs in to a network computer on its own, so the release job runs them again
on `windows-latest` before it packages anything:

- `smoke-unc.ts` and `node scripts/check-io-imports.mjs`;
- `smoke-unc-e2e.ts`, a real core process with every file and process call
  traced. Its test servers are under the reserved `.invalid` domain, so a leak
  would reach nobody. Its step 7 runs only here: it makes shares of temp
  folders with `net share` on `\\localhost` (the runner is an administrator;
  the shares are removed at the end) and checks that the private trust folder
  can't be read through a second share spelling of the data folder.

A failure stops the release. Fix the cause; don't skip the step.

The Windows gate can only run on a Windows runner. Before the first `v*` tag
that includes it, and after a change to these smokes or to the gate steps,
run it once without a tag:

1. Push the branch, then start **Release** from the Actions tab
   (`workflow_dispatch`) on that branch. The release guard passes a branch
   ref, and the attach step runs only on a tag, so this run publishes
   nothing. It only keeps the build outputs as a CI artifact.
2. In the log of "Smoke — network paths end to end", find step 7. It must
   print `7. a second share spelling of a data folder on \\localhost...`
   followed by its checks, not the line
   `7. skipped: a second share spelling ... it runs in release.yml`. The
   skip line on `windows-latest` means that step 7 did not run.
3. Every gate step must be green. If one fails (for example `net share`, the
   Server service, or the `.cmd` FFmpeg stub that the e2e runs through
   `cmd.exe`), fix it before you push the tag.

### The graphics add-on

Remotion is not in the installer: users install it from **Help → Graphics
add-on** (README, "Motion graphics: the graphics add-on"). Three steps of the
release job keep it that way and check that it still works:

- **The lock check.** `node scripts/gen-graphics-lock.mjs --check --require-sizes`
  fails when `packages/core/src/motion/addonlock.ts` (the exact packages and
  headless-shell zips the add-on installs) is out of sync with
  `package-lock.json`, when a platform's download size is unknown, or when the
  add-on's fingerprint is not the accepted one. A changed fingerprint makes
  every user update the add-on after this release: accept it with
  `--accept-addon-change` only for a deliberate Remotion upgrade
  (CONTRIBUTING.md, "The add-on drift guard").
- **The packaging gate.** electron-builder's `afterPack` hook
  (`apps/desktop/build/afterpack.cjs`) runs `node scripts/check-no-remotion.mjs`
  on the packed app before the installer and zip are made. It fails the build
  when the app holds a Remotion package, a package only the add-on uses (by
  `name@version`, from `addonlock.ts`), a headless shell or the core's `src/`,
  or when the core's copy of Remotion's licence (the add-on dialog's text) is
  missing or changed. It runs on every build, `--dir` builds included; don't
  skip it.
- **The live add-on check (required).** `smoke-addon-real.ts --live` runs on
  every run of the Windows job, a tag push or a `workflow_dispatch` dry run,
  with no input to skip it. It installs the add-on from the real
  `registry.npmjs.org` and `storage.googleapis.com` into a data folder under
  `RUNNER_TEMP` (never in the checkout), then a core renders one graphic with
  it, with `AIVE_REMOTION_ADDON` unset. If either fails, the job fails before
  anything is packaged. It is the only test of a real add-on install on
  Windows.

**No `v*` tag until a `workflow_dispatch` dry run of the Windows job has
passed**, this step included (start **Release** from the Actions tab on the
branch, as for the network-path gate above; the run publishes nothing). When
CI is not available, the maintainer (Anthony) installs the add-on by hand from
a dry-run build on Windows instead: install that build, open **Help → Graphics
add-on…**, **Accept and install**, then have the AI add one graphic and check
that it renders.

### Release text

`generate_release_notes` writes the list of changes. Add the text below to the
top of the Release body (edit the Release on GitHub after the workflow
publishes it) for the first version that ships the network-computer approvals.
Leave it out of later releases.

> **Media on network computers now waits for your OK.** When a project uses
> files on a network computer (`\\nas\video\…`) that you have not allowed,
> those clips stay offline and ZedMix does not contact that computer until
> you click **Allow** once for it. On Windows, opening a file there can send
> your Windows sign-in to that computer, so allow only computers you know.
> Picking a file on a new network computer in ZedMix's own dialogs asks
> once for that computer. Remove a computer in **Project → Network
> computers…**. An AI client can't allow a computer;
> ZedMix's tools tell it which clips wait for which computer.
>
> **Some network paths are now refused.** A project or an import that names
> a Windows device path in any spelling (`\\?\…`, `//./…`, `\??\…`) or a
> server name ZedMix can't use (web-folder forms such as `\\nas@SSL\…` or
> `\\nas@8080\…`, names with non-ASCII letters, `…ipv6-literal.net` names,
> or addresses not written as `a.b.c.d`, such as `\\127.1\…`) is refused.
> Map that folder to a drive letter, or use the computer's plain name
> (`xn--…` for an international name), then change the path in the `.aive`
> file (a text file) and open the project again.

---

## How the update reaches users

```
tag push ──► CI builds ──► published GitHub Release (exe + blockmap + latest.yml)
                                        │
        installed app launches ─────────┘
                │
                ├─ reads latest.yml → newer version?
                │        no  → nothing happens
                │        yes → downloads changed chunks in the background
                │              (via .blockmap — not the full ~444 MB)
                │
                └─ "update-downloaded" → dialog "Restart now / Later"
                        Restart now → installs immediately, relaunches
                        Later       → installs on the next quit/launch
```

- Runs **only in the installed/packaged app** (guarded by `app.isPackaged`) — never
  during `npm start`.
- The stable `appId` (`io.github.azabonik.zedmix`) means updates upgrade in
  place — no uninstall. Never change it again.
- `build.publish` in `apps/desktop/package.json` points at **azabonik/ZedMix**,
  so installs read only this repository's `latest.yml`.
- Version 0.2.0 shipped as ZabsReel with the appId `io.github.azabonik.zabsreel`.
  ZedMix does not upgrade it: the first ZedMix release installs beside it, and
  its release notes tell users to run `zedmix migrate` (which moves the MCP
  entries) and then uninstall ZabsReel by hand.
- Unsigned is fine on Windows; SmartScreen only nags on the very first manual
  install, not on self-updates.
- **macOS/Linux:** no packaged build or auto-update yet. Those users run from source
  and update with `git pull && npm run build` (see the README).

---

## Testing an update end-to-end

1. Build + install an **older** version locally (e.g. v0.2.0):
   `npm run dist --workspace zedmix-desktop`, then run the installer.
2. Bump to a **higher** version (v0.2.1), tag, and push that tag → let CI publish the Release.
3. Launch the installed **older** app → within a moment it downloads in the
   background → the "Update ready" dialog appears.
4. To watch the process, add `electron-log` and check the log at
   `%APPDATA%\ZedMix\logs`.

---

## Rolling back

There's no "un-ship." To recover from a bad release: publish a **higher** version
with the fix (e.g. `v0.2.2`). Users move forward to it on next launch. (Deleting the
bad Release stops *new* downloads but doesn't downgrade anyone already updated.)

---

## Who can trigger a release — and branches

The trigger is the **tag**, not the branch, and only people with **push access to
azabonik/ZedMix** can publish to this fork's users. A tag pushed to another fork
publishes to that fork only; its installs do not see it, because they update from
azabonik/ZedMix.
