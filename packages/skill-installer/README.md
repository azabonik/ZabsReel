# @azabonik/synthcut — skill installer

Installs the SynthCut **synthcut-editor** skill into your AI client, so the AI
that drives the [SynthCut MCP editor](../../README.md) edits like a professional:
inspect → plan → edit → verify → export, plus caption/color/motion-design craft
rules and exact tool recipes.

```bash
npx @azabonik/synthcut add        # interactive: pick your AI client + project/global
```

Non-interactive:

```bash
npx @azabonik/synthcut add --client claude --scope project
npx @azabonik/synthcut add --client codex  --scope global
npx @azabonik/synthcut add --client cursor --scope project --force
```

(No subcommand does the same thing; `skill`/`install` are aliases for `add`.
Re-run the same command any time to get the latest skill — use
`npx @azabonik/synthcut@latest add` to bypass a stale npx cache.)

| `--client` | project install | global install |
|---|---|---|
| `claude` (Claude Code) | `.claude/skills/synthcut-editor/SKILL.md` | `~/.claude/skills/synthcut-editor/SKILL.md` |
| `cursor` | `.cursor/rules/synthcut-editor.mdc` | prints paste-in instructions (Cursor has no global rules dir) |
| `codex` | `AGENTS.md` (marked section) | `~/.codex/AGENTS.md` |
| `gemini` | `GEMINI.md` (marked section) | `~/.gemini/GEMINI.md` |
| `windsurf` | `.windsurf/rules/synthcut-editor.md` | prints paste-in instructions |
| `agents` (generic) | `AGENTS.md` (marked section) | `~/AGENTS.md` |

Shared files (`AGENTS.md`/`GEMINI.md`) get a marked `<!-- synthcut:… -->` section
that re-running the installer updates in place; standalone files need `--force`
to overwrite.

## Removing what Relo's SynthCut left behind

```bash
npx @azabonik/synthcut migrate              # list, then ask before removing
npx @azabonik/synthcut migrate --dry-run    # only list
npx @azabonik/synthcut migrate --yes        # remove without asking
```

`migrate` looks in your home folder and in the project folder (`--dir`, default:
the current folder) for:

- the MCP server entry `ai-video-editor` in Claude Desktop, Claude Code
  (`~/.claude.json`, `.mcp.json`), Cursor, Windsurf, Gemini CLI, Cline,
  VS Code (`servers`) and Codex (`~/.codex/config.toml`) configs. An entry is
  removed only when its name is exactly `ai-video-editor` and it runs SynthCut's
  MCP server (`…/packages/mcp/dist/index.js` or `…/@aive/mcp/dist/index.js`);
  an entry with that name that runs another program is left alone;
- the old skill `video-editor-pro`, at the paths `@relo-video/synthcut` used:
  `.claude/skills/video-editor-pro/SKILL.md`, `.cursor/rules/synthcut-video-editor-pro.mdc`,
  `.windsurf/rules/synthcut-video-editor-pro.md`, and the
  `<!-- synthcut:video-editor-pro:… -->` sections in `AGENTS.md` / `GEMINI.md`.

It copies every file it changes or deletes to `~/.synthcut/backups/legacy-<time>/`
(with a `manifest.json` of the original paths) first, changes nothing else in
those files, and only reports files it can't parse (for example JSON with
comments). Claude Code's `~/.claude.json` entries go through
`claude mcp remove` when the `claude` command is installed. `add` prints a
one-line hint when it finds such entries.

The canonical skill lives at [`skill/SKILL.md`](skill/SKILL.md). To use it while
developing in this repo, run
`node packages/skill-installer/bin/synthcut.mjs add --client claude --scope project --force`
from the repo root. The installed copy goes to `.claude/`, which is gitignored, so
re-run that command after you edit the skill.

Publishing this package to npm requires publish rights to the `@azabonik` scope.
