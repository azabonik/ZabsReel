# @azabonik/zabsreel — skill installer

Installs the ZabsReel **zabsreel-editor** skill into your AI client, so the AI
that drives the [ZabsReel MCP editor](../../README.md) edits like a professional:
inspect → plan → edit → verify → export, plus caption/color/motion-design craft
rules and exact tool recipes.

```bash
npx @azabonik/zabsreel add        # interactive: pick your AI client + project/global
```

Non-interactive:

```bash
npx @azabonik/zabsreel add --client claude --scope project
npx @azabonik/zabsreel add --client codex  --scope global
npx @azabonik/zabsreel add --client cursor --scope project --force
```

(No subcommand does the same thing; `skill`/`install` are aliases for `add`.
Re-run the same command any time to get the latest skill — use
`npx @azabonik/zabsreel@latest add` to bypass a stale npx cache.)

| `--client` | project install | global install |
|---|---|---|
| `claude` (Claude Code) | `.claude/skills/zabsreel-editor/SKILL.md` | `~/.claude/skills/zabsreel-editor/SKILL.md` |
| `cursor` | `.cursor/rules/zabsreel-editor.mdc` | prints paste-in instructions (Cursor has no global rules dir) |
| `codex` | `AGENTS.md` (marked section) | `~/.codex/AGENTS.md` |
| `gemini` | `GEMINI.md` (marked section) | `~/.gemini/GEMINI.md` |
| `windsurf` | `.windsurf/rules/zabsreel-editor.md` | prints paste-in instructions |
| `agents` (generic) | `AGENTS.md` (marked section) | `~/AGENTS.md` |

Shared files (`AGENTS.md`/`GEMINI.md`) get a marked `<!-- zabsreel:… -->` section
that re-running the installer updates in place; standalone files need `--force`
to overwrite.

## Removing what Relo's SynthCut left behind

```bash
npx @azabonik/zabsreel migrate              # list, then ask before changing anything
npx @azabonik/zabsreel migrate --dry-run    # only list
npx @azabonik/zabsreel migrate --yes        # change without asking
```

`migrate` looks in your home folder and in the project folder (`--dir`, default:
the current folder) for:

- the MCP server entry `ai-video-editor` in Claude Desktop, Claude Code
  (`~/.claude.json`, `.mcp.json`), Cursor, Windsurf, Gemini CLI, Cline,
  VS Code (`servers`) and Codex (`~/.codex/config.toml`) configs. An entry is
  removed only when its name is exactly `ai-video-editor` and it runs Relo's SynthCut
  MCP server (`…/packages/mcp/dist/index.js` or `…/@aive/mcp/dist/index.js`);
  an entry with that name that runs another program is left alone;
- the old skill `video-editor-pro`, at the paths `@relo-video/synthcut` used:
  `.claude/skills/video-editor-pro/SKILL.md`, `.cursor/rules/synthcut-video-editor-pro.mdc`,
  `.windsurf/rules/synthcut-video-editor-pro.md`, and the
  `<!-- synthcut:video-editor-pro:… -->` sections in `AGENTS.md` / `GEMINI.md`.

Claude Code's `~/.claude.json` entries go through `claude mcp remove` when the
`claude` command is installed. `add` prints a one-line hint when it finds such
entries.

## Renaming this app's old entries

Before the rename to ZabsReel, this app used the MCP server key `synthcut` and
the skill `synthcut-editor`. `migrate` finds those too:

- An MCP entry named `synthcut` is renamed to `zabsreel` in place: same position,
  and its command, args, env and other fields are kept. This happens only when
  the files next to its MCP entry file show that it is this app: a checkout
  (`…/packages/mcp/dist/index.js`, with `packages/mcp/package.json` named
  `@aive/mcp` and the root `package.json` named `synthcut` or `zabsreel`), or an
  installed app (`…/resources/app/node_modules/@aive/mcp/dist/index.js`, with
  `resources/app/package.json` naming this app's desktop package). An entry that
  points at Relo's SynthCut, at another monorepo or at a path that does not
  exist is reported and left alone. A relative path is checked against the
  project folder of the config that holds it.
- An entry that runs an app installed before the rename is not carried over:
  ZabsReel installs beside that app instead of replacing it. Install ZabsReel,
  open **Connect AI**, save the JSON it shows to a file, and run
  `npx @azabonik/zabsreel migrate --entry <file>`. (Or add that entry to the
  client yourself and run `migrate` again to remove the old one.)
- When a `zabsreel` entry already exists, the old entry is removed if
  `zabsreel` runs this app. If `zabsreel` runs another program, nothing is
  changed.
- Claude Code's `~/.claude.json`: with the `claude` command installed, the new
  entry is added with `claude mcp add-json zabsreel … -s user|local`, read back
  to confirm, and only then is the old one removed with `claude mcp remove`.
  Without the command, `migrate` edits the file directly; it first asks you to
  close Claude Code, because a running Claude Code writes its own copy back.
- Codex (`~/.codex/config.toml`): the `[mcp_servers.…]` table and all its
  sub-tables (for example `.env`) are renamed together. An inline table or
  dotted keys are reported for you to edit by hand.
- The skill `synthcut-editor`: copies at the paths this installer used are
  removed (run `add` afterwards to install `zabsreel-editor`), and its marked
  sections in `AGENTS.md` / `GEMINI.md` are replaced with the `zabsreel-editor`
  section.

If you moved a checkout folder, entries that still name the old
`<old>/packages/mcp/dist/index.js` are reported as "stale path". Run

```bash
npx @azabonik/zabsreel migrate --from-checkout <old folder> --to-checkout <new folder>
```

to rewrite them; this happens only when the new folder is a ZabsReel checkout.

## Backups and restore

Before `migrate` changes or deletes a file, it copies the file to
`~/.zabsreel/backups/migrate-<time>/`. The folders are created with mode 0700,
and `manifest.json` (mode 0600) lists only the original and backup paths. Each
file is replaced in one step (a temporary file renamed over it), so it keeps its
mode, and a symlinked config stays a link. Files that can't be parsed (for
example JSON with comments) are only reported.

```bash
npx @azabonik/zabsreel migrate --restore ~/.zabsreel/backups/migrate-<time>
```

puts every file back as it was. It first backs up the current files into a new
`restore-<time>` folder, so a restore can be undone too, and it refuses a
manifest whose backup paths are outside that folder.

## Developing

The canonical skill lives at [`skill/SKILL.md`](skill/SKILL.md). To use it while
developing in this repo, run
`node packages/skill-installer/bin/zabsreel.mjs add --client claude --scope project --force`
from the repo root. The installed copy goes to `.claude/`, which is gitignored, so
re-run that command after you edit the skill.

Publishing this package to npm requires publish rights to the `@azabonik` scope.
