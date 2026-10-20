# @azabonik/zedmix — skill installer

Installs the ZedMix **zedmix-editor** skill into your AI client, so the AI
that drives the [ZedMix MCP editor](../../README.md) edits like a professional:
inspect → plan → edit → verify → export, plus caption/color/motion-design craft
rules and exact tool recipes.

```bash
npx @azabonik/zedmix add        # interactive: pick your AI client + project/global
```

Non-interactive:

```bash
npx @azabonik/zedmix add --client claude --scope project
npx @azabonik/zedmix add --client codex  --scope global
npx @azabonik/zedmix add --client cursor --scope project --force
```

(No subcommand does the same thing; `skill`/`install` are aliases for `add`.
Re-run the same command any time to get the latest skill — use
`npx @azabonik/zedmix@latest add` to bypass a stale npx cache.)

| `--client` | project install | global install |
|---|---|---|
| `claude` (Claude Code) | `.claude/skills/zedmix-editor/SKILL.md` | `~/.claude/skills/zedmix-editor/SKILL.md` |
| `cursor` | `.cursor/rules/zedmix-editor.mdc` | prints paste-in instructions (Cursor has no global rules dir) |
| `codex` | `AGENTS.md` (marked section) | `~/.codex/AGENTS.md` |
| `gemini` | `GEMINI.md` (marked section) | `~/.gemini/GEMINI.md` |
| `windsurf` | `.windsurf/rules/zedmix-editor.md` | prints paste-in instructions |
| `agents` (generic) | `AGENTS.md` (marked section) | `~/AGENTS.md` |

Shared files (`AGENTS.md`/`GEMINI.md`) get a marked `<!-- zedmix:… -->` section
that re-running the installer updates in place; standalone files need `--force`
to overwrite.

## Moving from ZabsReel

Before the rename to ZedMix, this app was called ZabsReel. It used the MCP
server key `zabsreel` and the skill `zabsreel-editor`. `migrate` finds what it
left and changes it to the new names:

```bash
npx @azabonik/zedmix migrate              # list, then ask before changing anything
npx @azabonik/zedmix migrate --dry-run    # only list
npx @azabonik/zedmix migrate --yes        # change without asking
```

`migrate` looks in your home folder and in the project folder (`--dir`, default:
the current folder). It reads the MCP configs of Claude Desktop, Claude Code
(`~/.claude.json`, `.mcp.json`), Cursor, Windsurf, Gemini CLI, Cline, VS Code
(`servers`) and Codex (`~/.codex/config.toml`), and the skill files at the paths
this installer used. `add` prints a one-line hint when it finds old entries.

- An MCP entry named `zabsreel` is renamed to `zedmix` in place: same position,
  and its command, args, env and other fields are kept. This happens only when
  the files next to its MCP entry file show that it is this app: a checkout
  (`…/packages/mcp/dist/index.js`, with `packages/mcp/package.json` named
  `@aive/mcp` and the root `package.json` named `zabsreel` or `zedmix`), or an
  installed app (`…/resources/app/node_modules/@aive/mcp/dist/index.js`, with
  `resources/app/package.json` named `zabsreel-desktop` or `zedmix-desktop`).
  An entry that points at another program, at another monorepo or at a path
  that does not exist is reported and left alone. A relative path is checked
  against the project folder of the config that holds it.
- An entry that runs an app installed before the rename is not carried over:
  ZedMix installs beside that app instead of replacing it. Install ZedMix,
  open **Connect AI**, save the JSON it shows to a file, and run
  `npx @azabonik/zedmix migrate --entry <file>`. (Or add that entry to the
  client yourself and run `migrate` again to remove the old one.)
- When a `zedmix` entry already exists, the old entry is removed if
  `zedmix` runs this app. If `zedmix` runs another program, nothing is
  changed.
- Claude Code's `~/.claude.json`: with the `claude` command installed, the new
  entry is added with `claude mcp add-json zedmix … -s user|local`, read back
  to confirm, and only then is the old one removed with `claude mcp remove`.
  Without the command, `migrate` edits the file directly; it first asks you to
  close Claude Code, because a running Claude Code writes its own copy back.
- Codex (`~/.codex/config.toml`): the `[mcp_servers.…]` table and all its
  sub-tables (for example `.env`) are renamed together. An inline table or
  dotted keys are reported for you to edit by hand.
- The skill `zabsreel-editor`: copies at the paths this installer used
  (`.claude/skills/zabsreel-editor/SKILL.md`, `.cursor/rules/zabsreel-editor.mdc`,
  `.windsurf/rules/zabsreel-editor.md`) are removed when their content shows
  they are that skill (run `add` afterwards to install `zedmix-editor`). Its
  marked sections in `AGENTS.md` / `GEMINI.md` are replaced with the
  `zedmix-editor` section.

If you moved a checkout folder, entries that still name the old
`<old>/packages/mcp/dist/index.js` are reported as "stale path". Run

```bash
npx @azabonik/zedmix migrate --from-checkout <old folder> --to-checkout <new folder>
```

to rewrite them; this happens only when the new folder is a ZedMix checkout.

## Backups and restore

Before `migrate` changes or deletes a file, it copies the file to
`~/.zedmix/backups/migrate-<time>/`. The folders are created with mode 0700,
and `manifest.json` (mode 0600) lists only the original and backup paths. Each
file is replaced in one step (a temporary file renamed over it), so it keeps its
mode, and a symlinked config stays a link. Files that can't be parsed (for
example JSON with comments) are only reported.

```bash
npx @azabonik/zedmix migrate --restore ~/.zedmix/backups/migrate-<time>
```

puts every file back as it was. It first backs up the current files into a new
`restore-<time>` folder, so a restore can be undone too, and it refuses a
manifest whose backup paths are outside that folder.

## Developing

The canonical skill lives at [`skill/SKILL.md`](skill/SKILL.md). To use it while
developing in this repo, run
`node packages/skill-installer/bin/zedmix.mjs add --client claude --scope project --force`
from the repo root. The installed copy goes to `.claude/`, which is gitignored, so
re-run that command after you edit the skill.

Publishing this package to npm requires publish rights to the `@azabonik` scope.
