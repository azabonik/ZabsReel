"""The editor's command-line installer moves what the previous release left in a user's AI-client configuration over
to the current one, and changes nothing else. Port of packages/core/scripts/smoke-legacy-migrate.ts (judge/PORTING.md
has the map of its sections).

The product line has had three names; each release's installer migrates the one before it (its --help says so):

    SynthCut  ->  ZabsReel (the v0.2.0 release)  ->  ZedMix

The release the test grades is the runner's input, `run.py --release` (t.release: zedmix, the default and what
judge.yml passes, or v0.2.0), never what the build installs: a build graded as ZedMix must install ZedMix's skill and
migrate the v0.2.0 release's configuration, and the v0.2.0 release SynthCut's. Each release's names are the judge's
own (GENERATIONS), so neither the adapter nor the build can pick what the installer is graded against; the first
checks fail when `add` installs another release's skill (a rewrite that still installs the v0.2.0 release's names fails them).

Each scene is a **world**: a folder with a home folder, an AppData folder, project folders and fake checkouts and
packaged apps of the product (old and current names), of a look-alike with the same layout but another package name,
and of an unrelated monorepo. The adapter makes it as the editor's user (cli_world: with run.py --as-user the
installer runs as that user and must be able to rewrite, rename and remove its files, as a user's own), and the test
first checks that the world holds exactly the files it gave. Then it runs the installer (cli: HOME and APPDATA in the
world, PATH only what the scene gives, stdin not a terminal unless the scene types on one) and observes only files:
their bytes (sha256 against the text the scene expects), kinds, links, modes, what appeared and what went, and the
exit code. What the installer prints is never checked for wording: the dry runs must only name the files they would
change and the ones they leave alone. Files are read through t.look (inside the test's folder, no link followed at the
path, and under --as-user as the editor's user for its private files). The adapter runs under strace with the file
calls traced (t.driver(trace=True)): after a migrate and a restore, the trace must show that every file the run changed
was written by a process started from a program in the build (installer_wrote), and by no other process.

Rules the scenes check, in the original's numbering: (1) only entries of the previous name are changed; (2) an entry
is the product only when the files next to its program show it (the checkout's package names, the packaged app's
package name); (3) it is renamed in place, every other field, key and its order, the indentation and line ends, the
file's mode and a link to the file kept; (4) an entry that runs an installed app of the previous name is changed only
with --entry, the current app's entry; (5) when the current name already runs the product, the old entry is removed;
(6) when the current name runs another program, nothing is written. Every file changed is backed up first (in the
current release's data folder, readable only by the user), --restore puts them back byte for byte and refuses a
backup that points outside its folder, and a second run finds nothing.

Every check is recorded on every path (a check whose input is missing fails with the reason), so CHECKS is exact.
"""
import base64
import hashlib
import json
import os
import re

import driver as drv
import observe

PORT_BOUND = True
TIMEOUT = 1200
CHECKS = 99

# The product's names, oldest first: the product name, the MCP server key, the skill, the identifier in package names
# and marked sections, the packaged desktop app's package name, and the data folder in the home folder.
GENERATIONS = [
    {"product": "SynthCut", "key": "synthcut", "skill": "synthcut-editor", "id": "synthcut",
     "desktop": "synthcut-desktop", "data": ".synthcut"},
    {"product": "ZabsReel", "key": "zabsreel", "skill": "zabsreel-editor", "id": "zabsreel",
     "desktop": "zabsreel-desktop", "data": ".zabsreel"},
    {"product": "ZedMix", "key": "zedmix", "skill": "zedmix-editor", "id": "zedmix",
     "desktop": "zedmix-desktop", "data": ".zedmix"},
]
RELEASE = {"v0.2.0": GENERATIONS[1], "zedmix": GENERATIONS[2]}   # run.py --release -> the names it is graded on
MCP_PACKAGE = "@aive/mcp"   # packages/mcp's package name in a checkout and node_modules/@aive/mcp in a packaged app
OTHER_PROGRAM = {"command": "npx", "args": ["-y", "some-other-mcp-server"]}


def js(o, indent=2):
    """JSON as JavaScript's JSON.stringify(o, null, indent) writes it."""
    return json.dumps(o, indent=indent, ensure_ascii=False)


def sha(b):
    return hashlib.sha256(b if isinstance(b, bytes) else b.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- worlds
class World:
    """A folder the installer works on, made by the adapter as the editor's user (cli_world), and what the test
    observes in it."""

    def __init__(self, t, d, name):
        self.t, self.d, self.name = t, d, name
        self.root = os.path.join(t.scratch, name)
        self.home = self.p("home")
        self.appdata = self.p("AppData/Roaming")
        self.proj = self.p("proj")
        self.files = {}
        self.dir("home")
        self.dir("AppData/Roaming")
        self.dir("proj")

    def p(self, rel):
        return os.path.join(self.root, *rel.split("/"))

    def rel(self, path):
        return os.path.relpath(path, self.root)

    def file(self, path, text, mode=None):
        e = {"text": text}
        if mode is not None:
            e["mode"] = mode
        self.files[self.rel(path) if os.path.isabs(path) else path] = e
        return path if os.path.isabs(path) else self.p(path)

    def link(self, path, target):
        self.files[self.rel(path)] = {"link": target}
        return path

    def dir(self, rel, mode=None):
        self.files[rel] = {"dir": True, **({"mode": mode} if mode is not None else {})}
        return self.p(rel)

    def checkout(self, rel, root_name, mcp_name=MCP_PACKAGE):
        """A checkout: <rel>/package.json and packages/mcp/{package.json, dist/index.js}. -> its entry file."""
        self.file(f"{rel}/package.json", js({"name": root_name, "private": True}) + "\n")
        self.file(f"{rel}/packages/mcp/package.json", js({"name": mcp_name}) + "\n")
        return self.file(f"{rel}/packages/mcp/dist/index.js", "// mcp\n")

    def packaged(self, rel, name, exe):
        """A packaged app: <rel>/<exe> and <rel>/resources/app/{package.json, node_modules/@aive/mcp/dist/index.js}.
        -> (its program, its entry file)"""
        self.file(f"{rel}/resources/app/package.json", js({"name": name, "version": "1.0.0"}) + "\n")
        entry = self.file(f"{rel}/resources/app/node_modules/@aive/mcp/dist/index.js", "// mcp\n")
        return self.file(f"{rel}/{exe}", "#!/bin/sh\n"), entry

    def make(self):
        """Has the adapter make the world; records whether it holds exactly the files given (a check)."""
        try:
            self.d.cli_world(self.root, self.files)
            made = None
        except drv.JudgeError as e:
            made = str(e)
        snap, _ = self.snapshot()
        bad = []
        for rel, e in self.files.items():
            got = snap.get(rel)
            if "text" in e:
                ok = got is not None and got[0] == "file" and got[1] == sha(e["text"]) and (
                    e.get("mode") is None or got[2] == e["mode"])
            elif "link" in e:
                ok = got == ("link", e["link"])
            else:
                ok = got is not None and got[0] == "dir" and (e.get("mode") is None or got[1] == e["mode"])
            if not ok:
                bad.append(f"{rel}: {got}")
        extra = [r for r, v in snap.items() if r not in self.files and v[0] != "dir"]
        self.t.check(f"{self.name}: the adapter made the world the test gave (cli_world), as the editor's user",
                     made is None and not bad and not extra,
                     made or f"{len(self.files)} entries; wrong {bad[:5]}; not given {extra[:5]}")

    def snapshot(self, skip=()):
        """({relative path: ("file", sha256, mode) | ("link", target) | (kind, mode)}, {relative path: bytes}) of every
        entry in the world but those under `skip` (absolute paths)."""
        walk = self.t.look(walk=[self.root])["walk"]
        paths = sorted(q for q in walk if not any(q == s or q.startswith(s + os.sep) for s in skip))
        got = self.t.look(stat=paths, read=paths)
        snap, data = {}, {}
        for q in paths:
            st, rel = got["stat"][q], self.rel(q)
            if st is None:
                snap[rel] = ("?",)
            elif st["type"] == "file":
                b = got["read"][q]
                snap[rel] = ("file", sha(b) if b is not None else None, st["mode"])
                if b is not None:
                    data[rel] = b
            elif st["type"] == "link":
                snap[rel] = ("link", st["link"])
            else:
                snap[rel] = (st["type"], st["mode"])
        return snap, data

    def text(self, path):
        """The file's text, or None (missing, unreadable, a link)."""
        b = self.t.look(read=[path])["read"][path]
        return None if b is None else b.decode("utf-8", "replace")

    def kind(self, path):
        st = self.t.look(stat=[path])["stat"][path]
        return None if st is None else st["type"]

    def mode(self, path):
        st = self.t.look(stat=[path])["stat"][path]
        return None if st is None else st["mode"]

    def cli(self, args, cwd=None, path=None, answers=None):
        """Runs the installer in the world. -> {"exit", "output"} (exit None when the adapter could not run it)."""
        try:
            return self.d.cli(args, cwd or self.proj, self.home, self.appdata, path, "\n".join(answers or []),
                              tty=answers is not None)
        except drv.JudgeError as e:
            return {"exit": None, "output": f"not run: {e}"}


def changed(a, b):
    """The relative paths whose entry differs between two snapshots."""
    return sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))


def same(t, label, a, b):
    diff = changed(a, b)
    return t.check(label, not diff, f"changed: {diff[:8]}" if diff else "nothing changed")


PATH_CHARS = frozenset("~./\\-_@" + "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")


def named(out, path, home, cwd=None, folder=False):
    """Whether the installer's output names `path` itself: as is, with the home folder written as ~, or relative to the
    folder it ran in (`cwd`, its project folder unless said), as a whole path: the characters around it are not part of
    a path (so `.cursor/mcp.json` inside `~/.cursor/mcp.json` does not name the project's .cursor/mcp.json, and a
    folder inside a longer path is not that folder). A path may end a sentence (a full stop after it); a folder
    (`folder`) may also be written with a separator at its end."""
    cwd = cwd or os.path.join(os.path.dirname(home), "proj")
    forms = [path] + (["~" + path[len(home):]] if path.startswith(home + os.sep) else []) + (
        [os.path.relpath(path, cwd)] if path.startswith(cwd + os.sep) else [])
    ends = (".", os.sep) if folder else (".",)
    for f in forms:
        at = out.find(f)
        while at >= 0:
            end = at + len(f)
            before, after, then = out[at - 1:at], out[end:end + 1], out[end + 1:end + 2]
            if before not in PATH_CHARS and (after not in PATH_CHARS or after in ends and then not in PATH_CHARS):
                return True
            at = out.find(f, at + 1)
    return False


# ---------------------------------------------------------------- who wrote the files (the trace)
# The calls that change a file system entry at a path (an open only with one of WRITE_FLAGS). Their path arguments are
# quoted strings, a relative one after its folder's descriptor, which -yy decorates with the folder's path.
WRITE_CALL = re.compile(r"^(\d+) +(rename|renameat2?|open|openat2?|creat|unlink|unlinkat|rmdir|mkdir|mkdirat|chmod|"
                        r"fchmodat2?|truncate|link|linkat|symlink|symlinkat)\((.*)$")
WRITE_FLAGS = ("O_WRONLY", "O_RDWR", "O_CREAT", "O_TRUNC")
EXECVE = re.compile(r"^(\d+) +execve(?:at)?\((.*)$")
RESUMED = re.compile(r"^(\d+) +<\.\.\. (execve|execveat) resumed>(.*)$")
QUOTED = re.compile(r'"((?:[^"\\]|\\.)*)"')
PATH_ARG = re.compile(r'(?:(?:AT_FDCWD|\d+)<((?:[^<>\\]|\\.)*)>, )?"((?:[^"\\]|\\.)*)"')
JUDGE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def trace_mark(t):
    """Where the trace is now (its line count), or None without a trace."""
    return len(t.trace.lines()) if t.trace is not None else None


def build_processes(lines, inside, outside):
    """{pid: [(line index, started a build program)]}: each process's successful execve calls in `lines` (strace form,
    "<pid> <call>"). A program is the build's when its file or one of its arguments (the script an interpreter runs) is
    a path under one of `inside` and under none of `outside` (strace forms, each ending with /)."""
    def builds(text):
        return any(any(q.startswith(i) for i in inside) and not any(q.startswith(o) for o in outside)
                   for q in QUOTED.findall(text))
    out, pending = {}, {}
    for i, ln in enumerate(lines):
        m = EXECVE.match(ln)
        if m:
            pid, rest = m.group(1), m.group(2)
            if rest.endswith("<unfinished ...>"):
                pending[pid] = builds(rest)
            elif re.search(r"\) += 0$", rest):
                out.setdefault(pid, []).append((i, builds(rest)))
            continue
        m = RESUMED.match(ln)
        if m and m.group(1) in pending:
            ok = pending.pop(m.group(1))
            if re.search(r"\) += 0$", m.group(3)):
                out.setdefault(m.group(1), []).append((i, ok))
    return out


def write_paths(rest):
    """The paths (strace form) a write call's arguments name: a relative one joined to its folder's decoration."""
    rest = rest.split(" <unfinished ...>")[0]
    out = []
    for folder, q in PATH_ARG.findall(rest):
        out.append(q if q.startswith("/") or not folder else folder.rstrip("/") + "/" + q)
    return out


def installer_wrote(t, w, step, mark, pre, post):
    """Records whether the trace (from `mark` on) shows every file the step changed (the entries that differ between
    the snapshots `pre` and `post`, files and links) written by a process whose program is the build's (its execve
    names a path in the build, not in the judge's folder, the adapter's or the test's scratch folder), and no write of
    them, or of a folder above them, by any other process: the adapter, a process it forked without starting a
    program, or one running another program. A write is a call of WRITE_CALL naming the path or a folder above it.
    Without strace: not observed."""
    label = (f"{step} the trace shows every file the run changed written by a process started from a program in the "
             f"build, and none written by the adapter or any other process")
    if mark is None:
        t.not_observed(label, t.trace_why or "no file-system trace")
        return
    lines = t.trace.lines()
    form = (lambda p: observe.strace_form(p).rstrip("/") + "/")
    inside = {form(t.build), form(os.path.realpath(t.build))}
    outside = {form(p) for p in [JUDGE_DIR, t.scratch] + [os.path.dirname(x) for x in t.adapter
                                                          if os.path.isabs(x) and os.path.isfile(x)]}
    outside |= {form(os.path.realpath(p[:-1])) for p in list(outside)}
    progs = build_processes(lines, inside, outside)
    files = [k for k in changed(pre, post) if (pre.get(k) or post.get(k))[0] in ("file", "link")]
    forms = {k: {observe.strace_form(w.p(k)), observe.strace_form(os.path.realpath(w.p(k)))} for k in files}
    covered, foreign = set(), []
    for i in range(mark, len(lines)):
        m = WRITE_CALL.match(lines[i])
        if not m or m.group(2).startswith("open") and not any(fl in m.group(3) for fl in WRITE_FLAGS):
            continue
        args = write_paths(m.group(3))
        hit = [k for k in files if any(a == f or f.startswith(a + "/") for a in args for f in forms[k])]
        if not hit:
            continue
        execs = [b for at, b in progs.get(m.group(1), []) if at < i]
        if execs and execs[-1]:
            covered.update(hit)
        else:
            foreign.append(f"pid {m.group(1)} {m.group(2)} {hit[0]}")
    missing = [k for k in files if k not in covered]
    t.check(label, bool(files) and not missing and not foreign,
            f"{len(files)} files changed; not written by a build program in the trace: {missing[:4]}; written by "
            f"another process: {foreign[:3]}")


# ---------------------------------------------------------------- the test
def run(t):
    d = t.driver(trace=True)
    cur = RELEASE[t.release]
    prev = GENERATIONS[GENERATIONS.index(cur) - 1]
    cur_section = identity(t, d, cur)
    rename(t, d, cur, prev, cur_section)
    entry(t, d, cur, prev)
    rules(t, d, cur, prev)
    claude_cli(t, d, cur, prev)
    move(t, d, cur, prev)
    prompts(t, d, cur, prev)


def identity(t, d, cur):
    """`add` installs the skill of the release under test (run.py --release: `cur`) in a fresh project. -> the marked
    section `add --client agents` writes into a new AGENTS.md (A3 expects it in place of the old one)."""
    w = World(t, d, "w-identity")
    w.make()
    r1 = w.cli(["add", "--client", "claude", "--scope", "project", "--dir", w.proj])
    r2 = w.cli(["add", "--client", "agents", "--scope", "project", "--dir", w.proj])
    snap, data = w.snapshot()
    skills = sorted({k.split(os.sep)[3] for k in snap if k.startswith(os.path.join("proj", ".claude", "skills", ""))
                     and len(k.split(os.sep)) > 4})
    md = data.get(os.path.join("proj", ".claude", "skills", cur["skill"], "SKILL.md"), b"")
    ok = skills == [cur["skill"]] and f"\nname: {cur['skill']}\n".encode() in b"\n" + md and r1["exit"] == 0
    t.check(f"add --client claude installs the skill of the release under test, {cur['product']} ({cur['skill']}; "
            f"run.py --release {t.release})", ok, f"exit {r1['exit']}; skill folders {skills}")
    section = data.get(os.path.join("proj", "AGENTS.md"), b"").decode("utf-8", "replace")
    marks = (f"<!-- {cur['id']}:{cur['skill']}:start -->", f"<!-- {cur['id']}:{cur['skill']}:end -->")
    t.check(f"add --client agents writes {cur['product']}'s skill into a new AGENTS.md as one marked section",
            r2["exit"] == 0 and section.startswith(marks[0]) and section.rstrip().endswith(marks[1]),
            f"exit {r2['exit']}; {section[:120]!r} ... {section[-80:]!r}")
    return section


def skill_md(g):
    return (f"---\nname: {g['skill']}\ndescription: Turn any AI into a professional video editor operating the "
            f"{g['product']} MCP editor ({g['key']} server).\n---\n\n# {g['product']} Editor — operate "
            f"{g['product']} like a professional\n")


def old_section(g):
    return (f"<!-- {g['id']}:{g['skill']}:start -->\n\n# {g['product']} Editor — operate {g['product']} like a "
            f"professional\n\n<!-- {g['id']}:{g['skill']}:end -->\n")


def short_section(g):
    return f"<!-- {g['id']}:{g['skill']}:start -->\n\n# {g['product']} Editor\n\n<!-- {g['id']}:{g['skill']}:end -->\n"


def programs(w, cur, prev):
    """The fake checkouts and packaged apps of a world: -> {name: entry file or (program, entry)}."""
    return {"oldCo": w.checkout(f"dev/{prev['product']}", prev["id"]),
            "curCo": w.checkout(f"dev/{cur['product']}", cur["id"]),
            "lookCo": w.checkout("dev/lookalike", "lookalike-editor"),
            "mono": w.checkout("dev/monorepo", "acme-monorepo", "@acme/mcp"),
            "oldApp": w.packaged(f"apps/{prev['product']}", prev["desktop"], prev["product"]),
            "lookApp": w.packaged("apps/Lookalike", "lookalike-editor-desktop", "Lookalike"),
            "curApp": w.packaged(f"apps/{cur['product']}", cur["desktop"], cur["product"]),
            "missing": w.p("gone/packages/mcp/dist/index.js")}


def co_root(entry):
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(entry))))


# ---------------------------------------------------------------- A: the rename
def rename(t, d, cur, prev, cur_section):
    import sys
    OLD, NEW = prev["key"], cur["key"]
    w = World(t, d, "w-rename")
    p = programs(w, cur, prev)
    w.checkout("proj", prev["id"])  # the project folder is itself a checkout of the previous release
    local = co_root(p["oldCo"])
    H, A, P = w.home, w.appdata, w.proj
    f = {"desktopLinux": f"{H}/.config/Claude/claude_desktop_config.json",
         "desktopWin": f"{A}/Claude/claude_desktop_config.json",
         "desktopMac": f"{H}/Library/Application Support/Claude/claude_desktop_config.json",
         "claudeJson": f"{H}/.claude.json", "projMcp": f"{P}/.mcp.json", "cursor": f"{H}/.cursor/mcp.json",
         "cursorTarget": w.p("dotfiles/cursor-mcp.json"), "cursorProj": f"{P}/.cursor/mcp.json",
         "windsurf": f"{H}/.codeium/windsurf/mcp_config.json", "gemini": f"{H}/.gemini/settings.json",
         "cline": f"{H}/.cline/mcp.json", "vscodeUser": f"{H}/.config/Code/User/mcp.json",
         "vscodeProj": f"{P}/.vscode/mcp.json", "codex": f"{H}/.codex/config.toml",
         "skillHome": f"{H}/.claude/skills/{prev['skill']}/SKILL.md",
         "skillProj": f"{P}/.claude/skills/{prev['skill']}/SKILL.md",
         "skillCustom": f"{H}/.claude/skills/{prev['skill']}-custom/SKILL.md",
         "skillNew": f"{H}/.claude/skills/{cur['skill']}/SKILL.md",
         "cursorRule": f"{P}/.cursor/rules/{prev['skill']}.mdc", "windsurfRule": f"{P}/.windsurf/rules/{prev['skill']}.md",
         "cursorRuleNew": f"{P}/.cursor/rules/{cur['skill']}.mdc", "agentsProj": f"{P}/AGENTS.md",
         "geminiHome": f"{H}/.gemini/GEMINI.md", "codexAgents": f"{H}/.codex/AGENTS.md"}
    old_entry = {"command": "node", "args": [p["oldCo"]], "env": {"AIVE_DATA_DIR": "/data/x"}, "timeout": 5}
    # Rule 3: renamed in place, other keys and their order kept; mode 0640.
    w.file(f["desktopLinux"], js({"mcpServers": {"before": {"command": "a"}, OLD: old_entry, "after": {"command": "b"}},
                                  "theme": "dark"}) + "\n", 0o640)
    # Rule 2, the fingerprint fails: a missing path, the look-alike checkout and packaged app, an unrelated monorepo,
    # and a program with no MCP entry file at all.
    w.file(f["desktopWin"], js({"mcpServers": {OLD: {"command": "node", "args": [p["missing"]]}}}) + "\n")
    w.file(f["gemini"], js({"mcpServers": {OLD: {"command": "node", "args": [p["lookCo"]]}}}) + "\n")
    w.file(f["cline"], js({"mcpServers": {OLD: {"command": p["lookApp"][0], "args": [p["lookApp"][1]],
                                                "env": {"ELECTRON_RUN_AS_NODE": "1"}}}}) + "\n")
    w.file(f["vscodeUser"], js({"servers": {OLD: {"command": "node", "args": [p["mono"]]}}}) + "\n")
    w.file(f["desktopMac"], js({"mcpServers": {OLD: OTHER_PROGRAM}}) + "\n")
    # JSON with comments: only reported.
    w.file(f["vscodeProj"], '{\n  // my servers\n  "servers": { "%s": %s }\n}\n'
           % (OLD, json.dumps({"command": "node", "args": [p["oldCo"]]}, separators=(",", ":"))))
    # Rule 5 (both are the product), in a config that is a link.
    w.file(f["cursorTarget"], js({"mcpServers": {OLD: {"command": "node", "args": [p["oldCo"]]},
                                                 NEW: {"command": "node", "args": [p["curCo"]]}}}) + "\n")
    w.link(f["cursor"], f["cursorTarget"])
    # Rule 6: the current name already runs another program.
    w.file(f["windsurf"], js({"mcpServers": {OLD: {"command": "node", "args": [p["oldCo"]]}, NEW: OTHER_PROGRAM}}) + "\n")
    # A relative path in a project config, resolved against the project.
    w.file(f["projMcp"], js({"mcpServers": {OLD: {"command": "node", "args": ["packages/mcp/dist/index.js"]}}}) + "\n")
    # Rule 4 without --entry: an installed app of the previous release is left alone.
    w.file(f["cursorProj"], js({"mcpServers": {OLD: {"command": p["oldApp"][0], "args": [p["oldApp"][1]],
                                                     "env": {"ELECTRON_RUN_AS_NODE": "1"}}}}) + "\n")
    # Claude Code: the user scope (absolute path) and a local scope with a relative path into the product. Only entries
    # that change, so the dry run has no reason to name the file but that it would change it (A1; the look-alike's
    # local scope, left alone, is C8's).
    rel_entry = {"type": "stdio", "command": "node", "args": ["packages/mcp/dist/index.js"]}
    w.file(f["claudeJson"], js({"numStartups": 3,
                                "mcpServers": {OLD: {"type": "stdio", "command": "node", "args": [p["oldCo"]], "env": {}}},
                                "projects": {local: {"allowedTools": ["x"], "mcpServers": {"other": {"command": "o"},
                                                                                           OLD: rel_entry}}}}))
    # A1: a claude CLI for one dry run (none is on PATH for the others).
    claude_bin = w.dir("fake-claude")
    claude_log = w.p("claude-calls.log")
    w.file("fake-claude/claude", FAKE_CLAUDE.format(python=sys.executable, mode="ok", log=claude_log), 0o755)
    codex_before = "\n".join(['model = "o3"', "", f"[mcp_servers.{OLD}]", 'command = "node"',
                              f"args = [{json.dumps(p['oldCo'])}]", "", f"[mcp_servers.{OLD}.env]",
                              'AIVE_DATA_DIR = "/data/x"', 'FOO = "bar"', "", "# notes", "[mcp_servers.notes]",
                              'command = "notes-mcp"', ""])
    w.file(f["codex"], codex_before)
    w.file(f["skillHome"], skill_md(prev))
    w.file(f["skillProj"], skill_md(prev).replace(f"name: {prev['skill']}", "name: my-own-skill"))
    w.file(f["skillCustom"], skill_md(prev))
    w.file(f["skillNew"], skill_md(cur))
    w.file(f["cursorRule"], f"---\ndescription: Turn any AI into a professional video editor operating the "
                            f"{prev['product']} MCP editor ({OLD} server).\nalwaysApply: false\n---\n\n"
                            f"# {prev['product']} Editor\n")
    w.file(f["windsurfRule"], f"# {prev['product']} Editor — operate {prev['product']} like a professional\n")
    w.file(f["cursorRuleNew"], f"---\ndescription: {cur['product']} editor\nalwaysApply: false\n---\n\n"
                               f"# {cur['product']} Editor\n")
    w.file(f["agentsProj"], f"# Rules\n\nBe brief.\n\n{old_section(prev)}\n## After\n\nMore.\n")
    w.file(f["geminiHome"], f"# Mine\n\n{old_section(prev)}\n{short_section(cur)}")
    w.file(f["codexAgents"], "# Codex notes\n\nUse tabs.\n")
    data = w.dir(f"home/{cur['data']}", 0o755)  # the current data folder with a wide mode: narrowed to 0700
    # A7: a project whose rule file at the old skill's path is the user's own.
    own_rule = w.file(f"proj2/.windsurf/rules/{prev['skill']}.md", "# My own rules\n\nUse tabs.\n")
    w.make()

    before, before_data = w.snapshot(skip=[data])
    # A1. the dry run changes nothing and names what it would change and what it leaves alone.
    dry = w.cli(["migrate", "--dry-run"])
    t.check("A1 --dry-run exits 0", dry["exit"] == 0, f"exit {dry['exit']}")
    same(t, "A1 --dry-run changes no file", before, w.snapshot(skip=[data])[0])
    t.check("A1 --dry-run makes no backup folder", w.kind(os.path.join(data, "backups")) is None, "")
    # Each file is named itself (as a whole path: named); a skill is a folder, so its SKILL.md may be named by its folder.
    def says(k):
        return named(dry["output"], f[k], w.home) or k in ("skillHome", "skillProj") and named(
            dry["output"], os.path.dirname(f[k]), w.home, folder=True)
    # ~/.claude.json is left out here: this run may also name it in a warning (v0.2.0: "Close Claude Code ..."), so
    # it is checked on the run with a claude CLI on PATH below.
    will = ["desktopLinux", "projMcp", "codex", "skillHome", "cursorRule", "windsurfRule", "agentsProj", "geminiHome"]
    missed = [k for k in will if not says(k)]
    if not (named(dry["output"], f["cursor"], w.home) or named(dry["output"], f["cursorTarget"], w.home)):
        missed.append("cursor")
    t.check("A1 --dry-run names every file it would change", not missed, f"not named: {missed}")
    # With a claude CLI on PATH, ~/.claude.json is changed through it (D), and nothing in the file is left alone: the
    # dry run has no reason to name the file but that it would change it.
    dry_cli = w.cli(["migrate", "--dry-run"], path=[claude_bin])
    t.check("A1 --dry-run with a claude CLI on PATH names ~/.claude.json, which it would change, calls no claude and "
            "changes no file",
            dry_cli["exit"] == 0 and named(dry_cli["output"], f["claudeJson"], w.home)
            and w.kind(claude_log) is None and not changed(before, w.snapshot(skip=[data])[0]),
            f"exit {dry_cli['exit']}; named: {named(dry_cli['output'], f['claudeJson'], w.home)}; "
            f"claude called: {w.kind(claude_log) is not None}")
    alone = ["desktopWin", "gemini", "cline", "vscodeUser", "desktopMac", "vscodeProj", "windsurf", "cursorProj",
             "skillProj"]
    missed = [k for k in alone if not says(k)]
    t.check(f"A1 --dry-run names every config with an entry of {OLD} that it leaves alone", not missed,
            f"not named: {missed}")
    # A2. without --yes and without a terminal: nothing changes.
    w.cli(["migrate"])
    same(t, "A2 without --yes and without a terminal, no file changes", before, w.snapshot(skip=[data])[0])
    # A3. --yes
    pre_yes = w.snapshot()[0]
    mark = trace_mark(t)
    yes = w.cli(["migrate", "--yes"])
    t.check("A3 --yes exits 0", yes["exit"] == 0, f"exit {yes['exit']}: {yes['output'][-300:]}")
    after, after_data = w.snapshot()
    installer_wrote(t, w, "A3", mark, pre_yes, after)
    got = (lambda k: after_data.get(w.rel(f[k]), b"").decode("utf-8", "replace") if w.rel(f[k]) in after_data else None)
    want = js({"mcpServers": {"before": {"command": "a"}, NEW: old_entry, "after": {"command": "b"}},
               "theme": "dark"}) + "\n"
    t.check(f"A3 rule 3: {OLD} is renamed {NEW} in place, every field and the key order kept", got("desktopLinux") == want,
            (got("desktopLinux") or "missing")[:300])
    entry_ = after.get(w.rel(f["desktopLinux"]))
    t.check("A3 the rewritten file keeps its mode 0640 (whatever its content)",
            entry_ is not None and entry_[0] == "file" and entry_[-1] == 0o640,
            f"{entry_[0]}, mode {oct(entry_[-1])}" if entry_ and entry_[0] == "file" else entry_)
    keep = ["desktopWin", "desktopMac", "gemini", "cline", "vscodeUser", "vscodeProj", "windsurf", "cursorProj"]
    diff = [k for k in keep if after.get(w.rel(f[k])) != before.get(w.rel(f[k]))]
    t.check("A3 rules 2, 4 and 6 and a JSON file with comments: those configs are left byte for byte", not diff,
            f"changed: {diff}")
    t.check("A3 the config that is a link is still a link to the same file, which was rewritten",
            after.get(w.rel(f["cursor"])) == ("link", f["cursorTarget"])
            and after.get(w.rel(f["cursorTarget"])) != before.get(w.rel(f["cursorTarget"])), after.get(w.rel(f["cursor"])))
    t.check(f"A3 rule 5: the link's target lost {OLD} and kept {NEW}",
            got("cursorTarget") == js({"mcpServers": {NEW: {"command": "node", "args": [p["curCo"]]}}}) + "\n",
            (got("cursorTarget") or "missing")[:300])
    t.check("A3 a project's .mcp.json with a relative path into the product is renamed",
            got("projMcp") == js({"mcpServers": {NEW: {"command": "node", "args": ["packages/mcp/dist/index.js"]}}}) + "\n",
            (got("projMcp") or "missing")[:300])
    try:
        cj = json.loads(got("claudeJson") or "null")
    except ValueError:
        cj = None
    cj = cj if isinstance(cj, dict) else {}
    t.check("A3 ~/.claude.json: the user scope renamed, its other state kept",
            cj.get("numStartups") == 3 and cj.get("mcpServers") == {
                NEW: {"type": "stdio", "command": "node", "args": [p["oldCo"]], "env": {}}}, str(cj)[:300])
    projs = cj.get("projects") or {}
    t.check("A3 ~/.claude.json: the local scope with a relative path into the product renamed in place",
            json.dumps(projs.get(local)) == json.dumps({"allowedTools": ["x"], "mcpServers": {"other": {"command": "o"},
                                                                                              NEW: rel_entry}})
            and list(projs) == [local], str(projs)[:400])
    t.check("A3 ~/.claude.json: rewritten with no newline added at its end", got("claudeJson") is not None
            and after.get(w.rel(f["claudeJson"])) != before.get(w.rel(f["claudeJson"]))
            and not got("claudeJson").endswith("\n"), repr((got("claudeJson") or "")[-20:]))
    want_toml = codex_before.replace(f"[mcp_servers.{OLD}]", f"[mcp_servers.{NEW}]").replace(
        f"[mcp_servers.{OLD}.env]", f"[mcp_servers.{NEW}.env]")
    t.check("A3 Codex TOML: both tables renamed, nothing else changed", got("codex") == want_toml,
            (got("codex") or "missing")[:300])
    toml_parses(t, "A3 Codex TOML still parses, with the entry's values unchanged", got("codex"),
                lambda v: OLD not in v["mcp_servers"] and v["mcp_servers"][NEW] == {
                    "command": "node", "args": [p["oldCo"]], "env": {"AIVE_DATA_DIR": "/data/x", "FOO": "bar"}}
                and v["mcp_servers"]["notes"]["command"] == "notes-mcp")
    skill_dir = w.rel(os.path.dirname(f["skillHome"]))
    t.check(f"A3 the home {prev['skill']} skill folder is removed", not any(
        k == skill_dir or k.startswith(skill_dir + os.sep) for k in after), "")
    t.check("A3 the other skills are kept (another skill in an old-named folder, a -custom copy, the current one)",
            all(after.get(w.rel(f[k])) == before.get(w.rel(f[k])) for k in ("skillProj", "skillCustom", "skillNew")),
            "")
    t.check("A3 the Cursor and Windsurf rule files of the old skill are removed, the current rule kept",
            w.rel(f["cursorRule"]) not in after and w.rel(f["windsurfRule"]) not in after
            and after.get(w.rel(f["cursorRuleNew"])) == before.get(w.rel(f["cursorRuleNew"])), "")
    t.check("A3 AGENTS.md: the old section is replaced in place by the section `add` writes",
            got("agentsProj") == f"# Rules\n\nBe brief.\n\n{cur_section}\n## After\n\nMore.\n" and bool(cur_section),
            (got("agentsProj") or "missing")[:200])
    t.check("A3 GEMINI.md that already holds the current section: the old one removed",
            got("geminiHome") == f"# Mine\n\n{short_section(cur)}", (got("geminiHome") or "missing")[:200])
    t.check("A3 an AGENTS.md without a section is untouched",
            after.get(w.rel(f["codexAgents"])) == before.get(w.rel(f["codexAgents"])), "")
    temps = [k for k in after if k.endswith(".tmp")]
    t.check("A3 no temporary file is left behind", not temps, temps[:5])
    backups = os.path.join(data, "backups")
    stamps = sorted(k for k in after if os.path.dirname(k) == w.rel(backups))
    t.check(f"A3 one backup folder in ~/{cur['data']}/backups", len(stamps) == 1, stamps)
    stamp = w.p(stamps[0]) if stamps else os.path.join(backups, "none")
    modes = [after.get(w.rel(x)) for x in (data, backups, stamp)]
    t.check(f"A3 ~/{cur['data']} (narrowed), its backups folder and the backup folder are mode 0700",
            all(m is not None and m[0] == "dir" and m[1] == 0o700 for m in modes), modes)
    inside = {k: v for k, v in after.items() if k.startswith(w.rel(stamp) + os.sep)}
    held = {v[1] for v in inside.values() if v[0] == "file"}
    gone_or_changed = [k for k in before if before[k][0] == "file" and after.get(k) != before[k]]
    unsaved = [k for k in gone_or_changed if before[k][1] not in held]
    t.check("A3 every file it changed or removed was backed up first (its old bytes are in the backup folder)",
            bool(gone_or_changed) and not unsaved, f"{len(gone_or_changed)} changed; not backed up: {unsaved[:5]}")
    t.check(f"A3 nothing is written in the previous release's ~/{prev['data']}",
            not any(k.startswith(os.path.join("home", prev["data"])) for k in after), "")
    # A4. a second run finds nothing.
    again = w.cli(["migrate", "--yes"])
    t.check("A4 a second --yes exits 0", again["exit"] == 0, f"exit {again['exit']}")
    same(t, "A4 a second --yes changes no file and makes no backup folder", after, w.snapshot()[0])
    # A5. --restore
    rdry = w.cli(["migrate", "--restore", stamp, "--dry-run"])
    links = {v[1]: k for k, v in before.items() if v[0] == "link"}  # a link's target may be named by the link
    missed = [k for k in gone_or_changed if not named(rdry["output"], w.p(k), w.home)
              and not (w.p(k) in links and named(rdry["output"], w.p(links[w.p(k)]), w.home))]
    t.check("A5 --restore --dry-run exits 0 and names every file it would put back", rdry["exit"] == 0 and not missed,
            f"exit {rdry['exit']}; not named: {missed[:5]}")
    same(t, "A5 --restore --dry-run changes no file", after, w.snapshot()[0])
    w.cli(["migrate", "--restore", stamp])
    same(t, "A5 --restore without --yes and without a terminal changes no file", after, w.snapshot()[0])
    # A6, before A5's restore: every config still holds what the migrate wrote, and the backup the bytes from before it,
    # so restoring any good entry of a refused backup would change a file.
    crafted_restores(t, w, stamp, inside, f["desktopLinux"], before_data.get(w.rel(f["desktopLinux"])),
                     {k: before[k][1] for k in gone_or_changed})
    pre_restore = w.snapshot()[0]
    mark = trace_mark(t)
    rr = w.cli(["migrate", "--restore", stamp, "--yes"])
    t.check("A5 --restore --yes exits 0", rr["exit"] == 0, f"exit {rr['exit']}: {rr['output'][-300:]}")
    restored, _ = w.snapshot(skip=[data])
    kinds = (lambda s: {k: v[:2] for k, v in s.items() if v[0] in ("file", "link")})
    diff = changed(kinds(before), kinds(restored))
    t.check("A5 every file is back as before the migrate, byte for byte (links still links)", not diff,
            f"differ: {diff[:8]}")
    t.check("A5 the restored file keeps its mode 0640", (restored.get(w.rel(f["desktopLinux"])) or (0, 0, 0))[-1] == 0o640,
            restored.get(w.rel(f["desktopLinux"])))
    now = w.snapshot()[0]
    installer_wrote(t, w, "A5", mark, pre_restore, now)
    new_stamps = sorted(k for k in now if os.path.dirname(k) == w.rel(backups) and k not in stamps)
    held2 = {v[1] for k, v in now.items() if v[0] == "file" and any(k.startswith(s + os.sep) for s in new_stamps)}
    put_back = [k for k in gone_or_changed if k in after and after[k][0] == "file"]
    t.check("A5 before the restore, the files it put back were backed up (their migrated bytes, in a new backup folder)",
            len(new_stamps) == 1 and bool(put_back) and all(after[k][1] in held2 for k in put_back),
            f"new backup folders {new_stamps}; {len(put_back)} files put back")
    # A7. a rule file at the old skill's path that is the user's own is left alone.
    r7 = w.cli(["migrate", "--yes"], cwd=w.p("proj2"))
    t.check("A7 a rule file at the old skill's path that is not the skill is kept, unchanged",
            r7["exit"] == 0 and w.text(own_rule) == "# My own rules\n\nUse tabs.\n", f"exit {r7['exit']}")


def toml_parses(t, label, text, test):
    try:
        import tomllib
    except ImportError:
        t.not_applicable(label, "this Python has no tomllib (Python 3.11 or newer has it)")
        return
    try:
        v = tomllib.loads(text or "")
        ok, detail = bool(test(v)), json.dumps(v)[:300]
    except (tomllib.TOMLDecodeError, KeyError, TypeError) as e:
        ok, detail = False, f"{type(e).__name__}: {e}"
    t.check(label, ok, detail)


def crafted_restores(t, w, stamp, inside, target, target_before, originals):
    """Copies of the installer's backup folder, made by the test in its own folder, in which one backup is replaced:
    by an absolute path outside the copy, by a ../ path out of it, and by a link to a file outside it. --restore of
    each must be refused and restore nothing (not even the good entries): no file in the world may change. It runs
    while the files the backup holds differ from what is there now (`originals`: {relative path: sha256 of its bytes
    before the migrate}, for every file the migrate changed or removed), so a restore of only the good entries changes
    a file; the check fails when no good entry holds bytes that differ from its file now (it could not see that). The
    copy needs the backup files' paths as the installer wrote them (observe.craft's rule): another format makes the
    first two not applicable."""
    files = {k: v for k, v in inside.items() if v[0] == "file"}
    got = w.t.look(read=[w.p(k) for k in files])["read"]
    # The backup of the config the scene picks: the file holding its old bytes.
    pick = next((k for k in files if target_before is not None and files[k][1] == sha(target_before)), None)
    good = {v[1] for k, v in files.items() if k != pick}
    outside = w.t.path("crafted", "outside.json")
    with open(outside, "w", encoding="utf-8") as fo:
        fo.write('{"evil": true}\n')
    labels = (("an absolute path outside", "abs"), ("a ../ path out of the folder", "dotdot"),
              ("a link inside that points outside", "link"))
    tgt = w.rel(target)
    for label, kind in labels:
        # Each case starts from what the world holds now, so its detail names what this case changed.
        before = w.snapshot()[0]
        visible = sorted(k for k, old in originals.items() if k != tgt and old in good and (before.get(k) or ("?", None))[
            1] != old)
        folder = w.t.path("crafted", kind, "x")
        folder = os.path.dirname(folder)
        counts = [0, 0]
        for k, b in ((k, got.get(w.p(k))) for k in files):
            name = os.path.relpath(w.p(k), stamp)
            dest = os.path.join(folder, name)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if b is None:
                continue
            text = b.decode("utf-8", "replace")
            counts[0] += text.count(stamp)
            text = text.replace(json.dumps(stamp)[1:-1], json.dumps(folder)[1:-1])
            if kind in ("abs", "dotdot") and pick:
                evil = outside if kind == "abs" else os.path.relpath(outside, folder)
                old = json.dumps(os.path.join(folder, os.path.relpath(w.p(pick), stamp)))[1:-1]
                counts[1] += text.count(old)
                text = text.replace(old, json.dumps(evil)[1:-1])
            if kind == "link" and k == pick:
                os.symlink(outside, dest)
                continue
            with open(dest, "w", encoding="utf-8", newline="") as fo:
                fo.write(text)
        crafted = observe.Crafted(folder, counts, pick is not None and (kind == "link" or counts[1] > 0),
                                  f"the installer's backup folder does not hold its backups' paths as written (or no "
                                  f"backup of the picked config was found; replacements {counts}), so this hostile "
                                  f"backup cannot be made by substitution")
        r = w.cli(["migrate", "--restore", folder, "--yes"])
        snap = w.snapshot()[0]
        diff = changed(before, snap)
        evil = w.text(target)
        t.check(f"A6 --restore of a backup with {label} is refused and restores nothing (not even the good entries)",
                r["exit"] not in (0, None) and not diff and evil is not None and "evil" not in evil and bool(visible),
                f"exit {r['exit']}; changed {diff[:5]}; {len(visible)} good entries hold other bytes than their file "
                f"now (want 1 or more: a restore of them would show), e.g. {visible[:3]}", needs=crafted)


# ---------------------------------------------------------------- B: packaged apps and --entry
def entry(t, d, cur, prev):
    OLD, NEW = prev["key"], cur["key"]
    w = World(t, d, "w-entry")
    p = programs(w, cur, prev)
    desktop = f"{w.home}/.config/Claude/claude_desktop_config.json"
    codex = f"{w.home}/.codex/config.toml"
    exe, ent = p["oldApp"]
    old_pkg = {"command": exe, "args": [ent], "env": {"ELECTRON_RUN_AS_NODE": "1", "EXTRA": "x"}, "timeout": 30}
    w.file(desktop, js({"mcpServers": {"a": {"command": "a"}, OLD: old_pkg, "z": {"command": "z"}}}) + "\n")
    codex_before = "\n".join([f"[mcp_servers.{OLD}]", f"command = {json.dumps(exe)}", "args = [",
                              f"  {json.dumps(ent)},", "]", "startup_timeout_sec = 20", "",
                              f"[mcp_servers.{OLD}.env]", 'ELECTRON_RUN_AS_NODE = "1"', 'EXTRA = "x"', ""])
    w.file(codex, codex_before)

    def entry_file(name, command, args):
        return w.file(f"entries/{name}.json", js({"mcpServers": {NEW: {"command": command, "args": args,
                                                                         "env": {"ELECTRON_RUN_AS_NODE": "1"}}}}))
    e_missing = entry_file("missing", w.p(f"apps/{cur['product']}/missing.exe"), [p["curApp"][1]])
    e_old = entry_file("old", exe, [ent])
    e_ok = entry_file("ok", p["curApp"][0], [p["curApp"][1]])
    w.make()
    before = w.snapshot()[0]
    r1 = w.cli(["migrate", "--yes"])
    t.check(f"B1 an entry that runs an installed {prev['product']} app is left alone without --entry",
            r1["exit"] == 0 and not changed(before, w.snapshot()[0]), f"exit {r1['exit']}")
    r2 = w.cli(["migrate", "--yes", "--entry", e_missing])
    t.check("B2 an --entry whose program does not exist is refused and changes nothing",
            r2["exit"] not in (0, None) and not changed(before, w.snapshot()[0]), f"exit {r2['exit']}")
    r3 = w.cli(["migrate", "--yes", "--entry", e_old])
    t.check(f"B3 an --entry that names the {prev['product']} app, not the current one, is refused and changes nothing",
            r3["exit"] not in (0, None) and not changed(before, w.snapshot()[0]), f"exit {r3['exit']}")
    r4 = w.cli(["migrate", "--yes", "--entry", e_ok])
    want = {"a": {"command": "a"}, NEW: {"command": p["curApp"][0], "args": [p["curApp"][1]],
                                         "env": {"ELECTRON_RUN_AS_NODE": "1", "EXTRA": "x"}, "timeout": 30},
            "z": {"command": "z"}}
    text = w.text(desktop)
    t.check(f"B4 a valid --entry: {NEW} gets the new program and arguments at the same place, {OLD}'s other "
            f"environment and fields kept, {OLD} removed",
            r4["exit"] == 0 and text == js({"mcpServers": want}) + "\n", f"exit {r4['exit']}; {(text or '')[:300]}")
    want_toml = "\n".join([f"[mcp_servers.{NEW}]", f"command = {json.dumps(p['curApp'][0])}",
                           f"args = [{json.dumps(p['curApp'][1])}]", "startup_timeout_sec = 20", "",
                           f"[mcp_servers.{NEW}.env]", 'ELECTRON_RUN_AS_NODE = "1"', 'EXTRA = "x"', ""])
    got = w.text(codex)
    t.check("B4 Codex TOML: the program and arguments replaced, the rest kept", got == want_toml, (got or "")[:300])
    toml_parses(t, "B4 Codex TOML parses with the new entry", got,
                lambda v: OLD not in v["mcp_servers"] and v["mcp_servers"][NEW] == {
                    "command": p["curApp"][0], "args": [p["curApp"][1]], "startup_timeout_sec": 20,
                    "env": {"ELECTRON_RUN_AS_NODE": "1", "EXTRA": "x"}})
    after = w.snapshot()[0]
    r5 = w.cli(["migrate", "--yes", "--entry", e_ok])
    t.check("B5 a second run with --entry finds nothing to change",
            r5["exit"] == 0 and not changed(after, w.snapshot()[0]), f"exit {r5['exit']}")


# ---------------------------------------------------------------- C: rules in Codex TOML and ~/.claude.json
def rules(t, d, cur, prev):
    OLD, NEW = prev["key"], cur["key"]

    def table(key, ent):
        return f'[mcp_servers.{key}]\ncommand = "node"\nargs = [{json.dumps(ent)}]\n'
    cases = [
        ("C1 TOML rule 5: the old table and its sub-table are removed when the current name runs the product",
         lambda p: f"{table(OLD, p['oldCo'])}\n[mcp_servers.{OLD}.env]\nA = \"1\"\n\n{table(NEW, p['curCo'])}",
         lambda text, p: table(NEW, p["curCo"])),
        ("C2 TOML rule 6: nothing is written when the current name runs another program",
         lambda p: f'{table(OLD, p["oldCo"])}\n[mcp_servers.{NEW}]\ncommand = "npx"\nargs = ["other"]\n', None),
        ("C3 TOML rule 2: an entry into the look-alike checkout is left alone", lambda p: table(OLD, p["lookCo"]), None),
        ("C4 TOML: quoted table headers are renamed",
         lambda p: (f'[mcp_servers."{OLD}"]\ncommand = "node"\nargs = [{json.dumps(p["oldCo"])}]\n\n'
                    f"[mcp_servers.'{OLD}'.env]\nA = \"1\"\n"),
         lambda text, p: text.replace(f'"{OLD}"', f'"{NEW}"').replace(f"'{OLD}'", f"'{NEW}'")),
        ("C5 TOML: an inline table is not edited",
         lambda p: f'[mcp_servers]\n{OLD} = {{ command = "node", args = [{json.dumps(p["oldCo"])}] }}\n', None),
        ("C6 TOML: dotted keys are not edited",
         lambda p: f'mcp_servers.{OLD}.command = "node"\nmcp_servers.{OLD}.args = [{json.dumps(p["oldCo"])}]\n', None),
    ]
    for i, (label, body, expect) in enumerate(cases):
        w = World(t, d, f"w-toml{i + 1}")
        p = programs(w, cur, prev)
        f = f"{w.home}/.codex/config.toml"
        text = body(p)
        w.file(f, text)
        w.make()
        r = w.cli(["migrate", "--yes"])
        got = w.text(f)
        want = expect(text, p) if expect else text
        t.check(label, r["exit"] == 0 and got == want, f"exit {r['exit']}; {(got or 'missing')[:240]}")
    # A checkout named like the product whose packages/mcp is another package.
    w = World(t, d, "w-mcpname")
    ent = w.checkout("dev/lookalike", cur["id"], "@other/mcp")
    f = f"{w.home}/.cursor/mcp.json"
    text = js({"mcpServers": {OLD: {"command": "node", "args": [ent]}}}) + "\n"
    w.file(f, text)
    w.make()
    r = w.cli(["migrate", "--yes"])
    t.check(f"C7 a checkout whose packages/mcp is not {MCP_PACKAGE} is left alone", r["exit"] == 0 and w.text(f) == text,
            f"exit {r['exit']}")
    # ~/.claude.json: rule 5 in the user scope, rule 6 in a local scope, and rule 2 in a local scope with a relative path
    # into the look-alike, edited directly (no claude CLI on PATH).
    w = World(t, d, "w-claudejson")
    p = programs(w, cur, prev)
    local = w.dir("projA")
    local_look = co_root(p["lookCo"])
    rel_entry = {"type": "stdio", "command": "node", "args": ["packages/mcp/dist/index.js"]}
    f = f"{w.home}/.claude.json"
    w.file(f, js({"mcpServers": {OLD: {"command": "node", "args": [p["oldCo"]]},
                                 NEW: {"command": "node", "args": [p["curCo"]]}},
                  "projects": {local: {"mcpServers": {OLD: {"command": "node", "args": [p["oldCo"]]},
                                                      NEW: OTHER_PROGRAM}},
                               local_look: {"mcpServers": {OLD: rel_entry}}}}))
    w.make()
    r = w.cli(["migrate", "--yes"])
    try:
        cj = json.loads(w.text(f) or "null") or {}
    except ValueError:
        cj = {}
    t.check(f"C8 ~/.claude.json user scope, rule 5: {OLD} removed, {NEW} kept",
            r["exit"] == 0 and OLD not in (cj.get("mcpServers") or {}) and NEW in (cj.get("mcpServers") or {}),
            f"exit {r['exit']}; {str(cj.get('mcpServers'))[:200]}")
    t.check("C8 ~/.claude.json local scope, rule 6: nothing written",
            json.dumps(((cj.get("projects") or {}).get(local) or {}).get("mcpServers")) == json.dumps(
                {OLD: {"command": "node", "args": [p["oldCo"]]}, NEW: OTHER_PROGRAM}), str(cj.get("projects"))[:300])
    t.check("C8 ~/.claude.json local scope with a relative path into the look-alike checkout, rule 2: kept",
            ((cj.get("projects") or {}).get(local_look) or {}).get("mcpServers") == {OLD: rel_entry},
            str(cj.get("projects"))[:400])


# ---------------------------------------------------------------- D: the Claude Code CLI
FAKE_CLAUDE = r'''#!{python} -I
# A stand-in for Claude Code's CLI: logs its arguments and folder, and does what `claude mcp add-json` and
# `claude mcp remove` do to ~/.claude.json (add-json adds "type": "stdio"). MODE: ok, fail (add fails), lie (add
# reports success and writes nothing), rmfail (remove fails).
import json, os, sys
MODE, LOG = {mode!r}, {log!r}
args = sys.argv[1:]
with open(LOG, "a", encoding="utf-8") as f:
    f.write(json.dumps({{"args": args, "cwd": os.getcwd()}}) + "\n")
verb, name = args[1], args[2]
scope = args[args.index("-s") + 1]
path = os.path.join(os.environ["HOME"], ".claude.json")
data = json.load(open(path, encoding="utf-8"))
servers = data.setdefault("mcpServers", {{}}) if scope == "user" else \
    data.setdefault("projects", {{}}).setdefault(os.getcwd(), {{}}).setdefault("mcpServers", {{}})
if verb == "add-json":
    if MODE == "fail":
        print("add failed", file=sys.stderr)
        sys.exit(1)
    if MODE == "lie":
        sys.exit(0)
    if name in servers:
        print("already exists", file=sys.stderr)
        sys.exit(1)
    servers[name] = {{"type": "stdio", **json.loads(args[3])}}
elif verb == "remove":
    if MODE == "rmfail":
        print("remove failed", file=sys.stderr)
        sys.exit(1)
    servers.pop(name, None)
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
'''


def claude_cli(t, d, cur, prev):
    import sys
    OLD, NEW = prev["key"], cur["key"]
    w = World(t, d, "w-claudecli")
    p = programs(w, cur, prev)
    local = w.dir("projA")
    f = f"{w.home}/.claude.json"
    S = {"type": "stdio", "command": "node", "args": [p["oldCo"]], "env": {"AIVE_DATA_DIR": "/d"}}
    start = js({"numStartups": 1, "mcpServers": {OLD: S}, "projects": {local: {"mcpServers": {OLD: S}}}})
    w.file(f, start)
    log = w.p("claude-calls.log")
    bins = {}
    for mode in ("fail", "lie", "rmfail", "ok"):
        bins[mode] = w.dir(f"fake-{mode}")
        w.file(f"fake-{mode}/claude", FAKE_CLAUDE.format(python=sys.executable, mode=mode, log=log), 0o755)
    w.make()

    def calls():
        text = w.text(log) or ""
        out = []
        for ln in text.splitlines():
            try:
                c = json.loads(ln)
                a = c["args"]
                out.append((f"{a[1]} {a[2]} {a[a.index('-s') + 1]}", c))
            except (ValueError, KeyError, IndexError, TypeError):
                out.append((f"? {ln[:80]}", {}))
        return out
    r1 = w.cli(["migrate", "--yes"], path=[bins["fail"]])
    v1 = [v for v, _ in calls()]
    t.check(f"D1 with a claude CLI whose add fails: exit not 0, ~/.claude.json unchanged ({OLD} still there), and no "
            "remove was called",
            r1["exit"] not in (0, None) and w.text(f) == start and v1 == [f"add-json {NEW} user", f"add-json {NEW} local"],
            f"exit {r1['exit']}; calls {v1}")
    n = len(v1)
    r2 = w.cli(["migrate", "--yes"], path=[bins["lie"]])
    v2 = [v for v, _ in calls()][n:]
    t.check("D2 an add that reports success but writes nothing is not trusted: exit not 0, nothing removed",
            r2["exit"] not in (0, None) and w.text(f) == start and v2 and all(v.startswith("add-json") for v in v2),
            f"exit {r2['exit']}; calls {v2}")
    n = len(calls())
    r3 = w.cli(["migrate", "--yes"], path=[bins["rmfail"]])
    c3 = calls()[n:]
    v3 = [v for v, _ in c3]
    try:
        cj3 = json.loads(w.text(f) or "null") or {}
    except ValueError:
        cj3 = {}
    both = all(k in (cj3.get("mcpServers") or {}) for k in (OLD, NEW)) and all(
        k in (((cj3.get("projects") or {}).get(local) or {}).get("mcpServers") or {}) for k in (OLD, NEW))
    t.check("D3 add works and remove fails: exit not 0, both names in both scopes",
            r3["exit"] not in (0, None) and both, f"exit {r3['exit']}")
    t.check("D3 add-json comes before remove in each scope, and the local scope's calls run in its project folder",
            v3 == [f"add-json {NEW} user", f"remove {OLD} user", f"add-json {NEW} local", f"remove {OLD} local"]
            and all(c.get("cwd") == local for v, c in c3 if v.endswith(" local")), f"calls {v3}")
    added = next((c for v, c in c3 if v.startswith("add-json")), None)
    try:
        added_entry = json.loads(added["args"][3]) if added else None
    except (ValueError, IndexError):
        added_entry = None
    t.check(f"D3 add-json is given {OLD}'s entry unchanged", added_entry == S, str(added_entry)[:200])
    n = len(calls())
    r4 = w.cli(["migrate", "--yes"], path=[bins["ok"]])
    v4 = [v for v, _ in calls()][n:]
    try:
        cj4 = json.loads(w.text(f) or "null") or {}
    except ValueError:
        cj4 = {}
    t.check(f"D4 the next run removes {OLD} (rule 5) without adding; {NEW} keeps {OLD}'s entry, the other state is kept",
            r4["exit"] == 0 and v4 == [f"remove {OLD} user", f"remove {OLD} local"]
            and OLD not in (cj4.get("mcpServers") or {})
            and OLD not in (((cj4.get("projects") or {}).get(local) or {}).get("mcpServers") or {})
            and ((cj4.get("mcpServers") or {}).get(NEW) or {}).get("args") == [p["oldCo"]]
            and cj4.get("numStartups") == 1, f"exit {r4['exit']}; calls {v4}")
    after = w.snapshot()[0]
    r5 = w.cli(["migrate", "--yes"], path=[bins["ok"]])
    t.check("D5 then nothing is left: no change, no call", r5["exit"] == 0 and not changed(after, w.snapshot()[0]),
            f"exit {r5['exit']}")


# ---------------------------------------------------------------- E: a checkout that moved
def move(t, d, cur, prev):
    OLD, NEW = prev["key"], cur["key"]
    w = World(t, d, "w-move")
    p = programs(w, cur, prev)
    old = w.p(f"old/{prev['product']}")
    old_entry = os.path.join(old, "packages", "mcp", "dist", "index.js")
    desktop = f"{w.home}/.config/Claude/claude_desktop_config.json"
    cursor = f"{w.home}/.cursor/mcp.json"
    codex = f"{w.home}/.codex/config.toml"
    w.file(desktop, js({"mcpServers": {OLD: {"command": "node", "args": [old_entry]}}}) + "\n")
    w.file(cursor, js({"mcpServers": {NEW: {"command": "node", "args": [old_entry]}}}) + "\n")
    codex_before = f'[mcp_servers.{NEW}]\ncommand = "node"\nargs = [{json.dumps(old_entry)}]\n'
    w.file(codex, codex_before)
    w.make()
    before = w.snapshot()[0]
    dry = w.cli(["migrate", "--dry-run"])
    t.check("E1 without the flags, entries into a checkout that is gone are only reported: each config named, no change",
            dry["exit"] == 0 and all(named(dry["output"], x, w.home) for x in (desktop, cursor, codex))
            and not changed(before, w.snapshot()[0]), f"exit {dry['exit']}")
    for label, to in (("an unrelated monorepo", p["mono"]), ("the look-alike checkout", p["lookCo"])):
        r = w.cli(["migrate", "--yes", "--from-checkout", old, "--to-checkout", co_root(to)])
        t.check(f"E2 --to-checkout {label} (not the product) rewrites nothing", not changed(before, w.snapshot()[0]),
                f"exit {r['exit']}")
    ok = w.cli(["migrate", "--yes", "--from-checkout", old, "--to-checkout", co_root(p["curCo"])])
    want = js({"mcpServers": {NEW: {"command": "node", "args": [p["curCo"]]}}}) + "\n"
    t.check(f"E3 --to-checkout the product's checkout: {OLD} into the old checkout renamed and pointed at it, {NEW} "
            "pointed at it, the Codex TOML path rewritten",
            ok["exit"] == 0 and w.text(desktop) == want and w.text(cursor) == want
            and w.text(codex) == codex_before.replace(json.dumps(old_entry), json.dumps(p["curCo"])),
            f"exit {ok['exit']}; {(w.text(desktop) or '')[:200]}")
    after = w.snapshot()[0]
    again = w.cli(["migrate", "--yes", "--from-checkout", old, "--to-checkout", co_root(p["curCo"])])
    t.check("E4 a second run finds nothing", again["exit"] == 0 and not changed(after, w.snapshot()[0]),
            f"exit {again['exit']}")


# ---------------------------------------------------------------- F: `add`, and the questions on a terminal
def prompts(t, d, cur, prev):
    OLD, NEW = prev["key"], cur["key"]
    w = World(t, d, "w-prompts")
    p = programs(w, cur, prev)
    desktop_win = f"{w.appdata}/Claude/claude_desktop_config.json"
    claude_json = f"{w.home}/.claude.json"
    skill = f"{w.proj}/.claude/skills/{prev['skill']}/SKILL.md"
    notes = os.path.join(os.path.dirname(skill), "notes.txt")
    ent = {"command": "node", "args": [p["oldCo"]]}

    def crlf4(o):
        return js(o, 4).replace("\n", "\r\n") + "\r\n"
    w.file(desktop_win, crlf4({"mcpServers": {OLD: ent}}))
    w.file(claude_json, js({"numStartups": 2, "mcpServers": {OLD: ent}}))
    w.file(skill, skill_md(prev))
    w.file(notes, "my own notes\n")
    w.make()
    before = w.snapshot()[0]
    add = w.cli(["add", "--client", "claude", "--scope", "project", "--dir", w.proj])
    installed = f"{w.proj}/.claude/skills/{cur['skill']}/SKILL.md"
    t.check("F1 add mentions the migrate command when entries of the previous name are there",
            add["exit"] == 0 and "migrate" in add["output"], add["output"][-300:])
    t.check(f"F1 add installs the current skill ({cur['skill']})", f"\nname: {cur['skill']}\n" in "\n" + (
        w.text(installed) or ""), "")
    after_add = w.snapshot()[0]
    t.check("F1 add changes none of the files that were there", all(after_add.get(k) == v for k, v in before.items()),
            changed(before, {k: after_add.get(k) for k in before})[:5])
    no = w.cli(["migrate"], answers=["n"])
    t.check("F2 on a terminal, answering n to the question changes no file",
            no["exit"] is not None and not changed(after_add, w.snapshot()[0]), f"exit {no['exit']}")
    yn = w.cli(["migrate"], answers=["y", "n"])
    t.check("F2 answering y, then n to the question whether Claude Code is closed, changes no file",
            yn["exit"] is not None and not changed(after_add, w.snapshot()[0]), f"exit {yn['exit']}")
    yy = w.cli(["migrate"], answers=["y", "y"])
    try:
        cj = json.loads(w.text(claude_json) or "null") or {}
    except ValueError:
        cj = {}
    t.check("F2 answering y, y: ~/.claude.json renamed, its other state kept",
            yy["exit"] == 0 and cj.get("numStartups") == 2 and OLD not in (cj.get("mcpServers") or {})
            and NEW in (cj.get("mcpServers") or {}), f"exit {yy['exit']}; {str(cj)[:200]}")
    t.check("F2 Claude Desktop (APPDATA): renamed, the 4-space indent and CRLF line ends kept",
            w.text(desktop_win) == crlf4({"mcpServers": {NEW: ent}}), repr((w.text(desktop_win) or "")[:200]))
    t.check("F2 the old SKILL.md is removed, the user's notes.txt and its folder kept",
            w.kind(skill) is None and w.text(notes) == "my own notes\n", "")
    t.check("F2 the current skill that add installed is kept",
            w.snapshot()[0].get(w.rel(installed)) == after_add.get(w.rel(installed)), "")
