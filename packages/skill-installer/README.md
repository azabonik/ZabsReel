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

The canonical skill lives at [`skill/SKILL.md`](skill/SKILL.md). To use it while
developing in this repo, run
`node packages/skill-installer/bin/synthcut.mjs add --client claude --scope project --force`
from the repo root. The installed copy goes to `.claude/`, which is gitignored, so
re-run that command after you edit the skill.

Publishing this package to npm requires publish rights to the `@azabonik` scope.
