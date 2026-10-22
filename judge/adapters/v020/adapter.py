#!/usr/bin/env python3
"""The judge's adapter for v0.2.0's interfaces (judge/PROTOCOL.md, version 1).

    python3 -I judge/adapters/v020/adapter.py        (the runner starts it; requests on stdin, answers on stdout)

It maps the judge's operations to v0.2.0's public MCP tools, spoken over stdio to the MCP server of the build named
in `start` (<build>/packages/mcp/dist/index.js, run with the `node` on PATH), and to the core's HTTP routes where an
operation needs them (http_get). Python 3 standard library only.

The editor runs in a sandbox under <scratch>/editor: HOME, USERPROFILE, XDG_CONFIG_HOME, AIVE_DATA_DIR and TMPDIR
point at fresh folders there, and AIVE_PORT is a free port (never 4791, the default, which the user's own editor may
use). It downloads nothing (PROTOCOL.md rule 4): AIVE_CLIP_DISABLE=1 keeps the visual index model from loading, and
AIVE_WHISPER_BIN / AIVE_WHISPER_MODEL name files that do not exist (<scratch>/editor/absent/..., never made), so a
transcription is refused instead of fetching whisper.cpp and its model (~170 MB), as in the FFmpeg matrix
(ffmpeg-matrix.yml). `start` refuses to go on if either of those files exists. The editor uses the FFmpeg on PATH, or
AIVE_FFMPEG / AIVE_FFPROBE when they are set in the adapter's environment. `start` checks that the core that answers
is the one it started (its server.json is in the sandbox's data folder, names the sandbox's port, and its process has
the sandbox's data folder in its environment) and refuses to go on otherwise. `stop` ends the editor's window server
(below) and the MCP server, then every process whose environment holds the sandbox's data folder or home, by exact
process id.

Network computers: v0.2.0 allows one only from its window. approve_host and revoke_host use the web shell's routes
(POST /api/media-servers/approve and /revoke with the shell key, as the window does). The first of them starts the
web shell (<build>/apps/desktop/web/server.cjs --port 0 --no-open) with the sandbox's environment and AIVE_PORT set to
the running core's port, so it attaches to that core; it refuses to go on when the shell reports another core or a
core of its own. The shell needs the renderer built (apps/desktop/dist/renderer: `npm run build` makes it). Its key
header was renamed with the product, so every request sends the key as x-zedmix-shell and as x-zabsreel-shell (the
v0.2.0 release's name). Only the shell's JSON "ready" line is read; its port comes back in the `ports` of the
operation's answer, or of the next ok answer (stop's included) when that operation was refused.
add_host_outside writes the editor's allowed-computers store (<data>/trust/hosts.json, and hosts.key when there is
none yet) the way a hand edit would: on purpose, as the attacker that PROTOCOL.md describes.

Motion graphics: add_graphic is the MCP tool add_graphic. The graphics renderer is the user's setting, made in the
window: set_graphics_renderer uses the web shell's route (POST /api/graphics-addon/renderer with the shell key, as the
window's Graphics add-on dialog does), "remotion" for the add-on and the product's own name (its MCP server's
serverInfo.name: the v0.2.0 release still has its old name there, this tree "zedmix") for the built-in renderer. The graphics add-on is never installed through the window
(that downloads it): start's graphics_addon names the judge's copy, which the editor gets as AIVE_REMOTION_ADDON (its
root) and AIVE_REMOTION_BROWSER (its headless shell), the variables a source checkout honours (docs/TESTING.md). Without
graphics_addon neither variable is set, so the editor has no add-on, as for a user who never installed it.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ADAPTER = "v020 (v0.2.0 MCP tools over stdio + core HTTP routes + the web shell's network-computer routes)"
PROTOCOL = 1
BODY_CAP = 262144
TRANSCRIPT_CAP = 1 << 20     # characters kept of one answer in the transcript
SHELL_HEADERS = ("x-zedmix-shell", "x-zabsreel-shell")  # this tree's name, the v0.2.0 release's name
POKE_TIMEOUT = 120           # seconds per tool in poke_agent_tools
# Ports that Chromium-based browsers and Electron refuse to connect to (README: the app stops on them), and the
# editor's own default ports.
AVOID_PORTS = {4790, 4791, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080}
MCP_TIMEOUT = 3600


def log(*a):
    print("[v020-adapter]", *a, file=sys.stderr, flush=True)


class OpError(Exception):
    def __init__(self, code, message, product_code=None):
        super().__init__(message)
        self.code, self.message, self.product_code = code, message, product_code


def bad(message):
    return OpError("bad_request", message)


# The judge's arguments are checked here, and only these checks answer bad_request. Any other ValueError, TypeError
# or KeyError (an editor reply that does not have the expected shape, for example) is an adapter_error.
def arg_str(a, k, required=True):
    v = a.get(k)
    if v is None:
        if required:
            raise bad(f"missing {k!r}")
        return None
    if not isinstance(v, str) or not v:
        raise bad(f"{k!r} must be a non-empty string, got {v!r}")
    return v


def arg_num(a, k, required=True):
    v = a.get(k)
    if v is None:
        if required:
            raise bad(f"missing {k!r}")
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise bad(f"{k!r} must be a number, got {v!r}")
    return v


def arg_int(a, k, required=True):
    v = arg_num(a, k, required)
    if v is not None and v != int(v):
        raise bad(f"{k!r} must be a whole number, got {v!r}")
    return None if v is None else int(v)


# ---------------------------------------------------------------- MCP over stdio (newline-delimited JSON-RPC)
class Mcp:
    def __init__(self, argv, env, cwd, stderr_path):
        self._stderr = open(stderr_path, "ab")
        self.p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._stderr, env=env,
                                  cwd=cwd, text=True, bufsize=1)
        self.n = 0
        self.pending = {}
        self.lock = threading.Lock()
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        for line in self.p.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                m = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "id" in m and "method" in m:  # a request from the server (roots/list, ...): not supported
                self._send({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32601, "message": "not supported"}})
            elif "id" in m:
                ev = self.pending.get(m["id"])
                if ev:
                    ev[1] = m
                    ev[0].set()
        for ev in list(self.pending.values()):  # the server exited: wake every waiter
            ev[0].set()

    def _send(self, obj):
        with self.lock:
            self.p.stdin.write(json.dumps(obj) + "\n")
            self.p.stdin.flush()

    def request(self, method, params, timeout=MCP_TIMEOUT):
        self.n += 1
        i = self.n
        ev = [threading.Event(), None]
        self.pending[i] = ev
        try:
            self._send({"jsonrpc": "2.0", "id": i, "method": method, "params": params})
        except (BrokenPipeError, OSError) as e:
            raise OpError("adapter_error", f"MCP server is not running ({e})")
        if not ev[0].wait(timeout):
            raise OpError("adapter_error", f"MCP {method} gave no answer in {timeout} s")
        self.pending.pop(i, None)
        m = ev[1]
        if m is None:
            raise OpError("adapter_error", f"MCP server exited (code {self.p.poll()}) during {method}")
        if "error" in m:
            e = m["error"] or {}
            code = "bad_request" if e.get("code") == -32602 else "adapter_error"
            raise OpError(code, f"MCP {method}: {e.get('message', e)}")
        return m["result"]

    def notify(self, method, params=None):
        self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def close(self, wait=10):
        try:
            self.p.stdin.close()
        except OSError:
            pass
        try:
            self.p.wait(wait)
        except subprocess.TimeoutExpired:
            pass
        self._stderr.close()


def text_of(result):
    return "\n".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")


def as_json(text):
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
    return None


def find_key(o, keys):
    """First string value for any of keys, depth-first."""
    if isinstance(o, dict):
        for k in keys:
            if k in o and isinstance(o[k], str):
                return o[k]
        for v in o.values():
            r = find_key(v, keys)
            if r:
                return r
    elif isinstance(o, list):
        for v in o:
            r = find_key(v, keys)
            if r:
                return r
    return None


# ---------------------------------------------------------------- sandbox and processes
def free_port():
    """A TCP port on 127.0.0.1 that nothing listens on, outside AVOID_PORTS."""
    for _ in range(50):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        if port in AVOID_PORTS:
            continue
        c = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        c.settimeout(0.5)
        try:
            busy = c.connect_ex(("127.0.0.1", port)) == 0
        finally:
            c.close()
        if not busy:
            return port
    raise OpError("adapter_error", "no free port found")


def environ_of(pid):
    try:
        with open(f"/proc/{pid}/environ", "rb") as f:
            return f.read().split(b"\0")
    except OSError:
        return None


def cmdline_of(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return f.read().replace(b"\0", b" ").decode("utf-8", "replace").strip()
    except OSError:
        return ""


def sandbox_pids(entries):
    """Process ids (not this process) whose environment holds one of the exact `entries` ("NAME=value")."""
    want = {e.encode() for e in entries}
    out = []
    if not os.path.isdir("/proc"):
        return out
    for name in os.listdir("/proc"):
        if not name.isdigit() or int(name) == os.getpid():
            continue
        env = environ_of(name)
        if env and want.intersection(env):
            out.append(int(name))
    return out


def end_processes(pids, grace=5.0):
    """SIGTERM each pid, then SIGKILL what is still there after `grace` s. Returns the pids signalled."""
    done = []
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
            done.append(pid)
        except (ProcessLookupError, PermissionError):
            pass
    deadline = time.time() + grace
    while done and time.time() < deadline:
        if not any(os.path.exists(f"/proc/{p}") and not _zombie(p) for p in done):
            break
        time.sleep(0.1)
    for pid in done:
        if os.path.exists(f"/proc/{pid}") and not _zombie(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
    return done


def _zombie(pid):
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            return f.read().rsplit(b")", 1)[1].split()[0] == b"Z"
    except (OSError, IndexError):
        return False


# ---------------------------------------------------------------- the adapter
class Adapter:
    def __init__(self):
        self.mcp = None
        self.root = None
        self.port = None
        self.token = None
        self.core_pid = None
        self.frames = 0
        self.env = None
        self.build = None
        self.scratch = None
        self.instructions = ""
        self.shell = None        # the web shell (Popen) once approve_host / revoke_host started it
        self.shell_port = None
        self.shell_key = None
        self.unreported_ports = []  # ports opened during an operation whose answer was not ok (handle() reports them)
        self.texts = []          # every text the editor answered since start (transcript)
        self.product_name = None  # serverInfo.name: the built-in graphics renderer's setting value

    def note(self, text):
        """Keeps one answer of the editor for the transcript operation."""
        if text:
            self.texts.append(text if len(text) <= TRANSCRIPT_CAP else text[:TRANSCRIPT_CAP])

    # ------------------------------------------------------------ helpers
    def call(self, name, args, timeout=MCP_TIMEOUT):
        """A tool call: the parsed JSON result (or {"text": ...}); a tool error becomes product_error."""
        if self.mcp is None:
            raise OpError("adapter_error", "the editor is not started")
        try:
            r = self.mcp.request("tools/call", {"name": name, "arguments": args}, timeout)
        except OpError as e:
            self.note(e.message)
            raise
        text = text_of(r)
        self.note(text)
        j = as_json(text)
        if r.get("isError"):
            code = None
            if isinstance(j, dict):
                e = j.get("error")
                code = j.get("code") or (e.get("code") if isinstance(e, dict) else None)
            raise OpError("product_error", text[:4000] or "error with no text", code if isinstance(code, str) else None)
        if j is None:
            j = {"text": text}
        j["_content"] = r.get("content", [])
        return j

    def tracks(self):
        """{"v0": trackIndex, ..., "a0": trackIndex, ...} from timeline_summary."""
        ts = self.call("timeline_summary", {})
        names = {}
        for kind, prefix in (("video", "v"), ("audio", "a")):
            idx = sorted(t["trackIndex"] for t in ts.get("tracks", []) if t.get("kind") == kind)
            names.update({f"{prefix}{n}": i for n, i in enumerate(idx)})
        return names, ts

    def track_index(self, name):
        if not isinstance(name, str):
            raise bad(f"track must be a name such as 'v0', got {name!r}")
        names, _ = self.tracks()
        if name not in names:
            raise bad(f"no track {name!r} (tracks: {sorted(names)})")
        return names[name]

    # ------------------------------------------------------------ lifecycle
    def op_hello(self, a):
        ops = sorted(n[3:] for n in dir(self) if n.startswith("op_"))
        return {"protocol": PROTOCOL, "adapter": ADAPTER, "ops": ops}

    def op_start(self, a):
        build, scratch = arg_str(a, "build"), arg_str(a, "scratch")
        if self.mcp is not None:
            raise bad("already started")
        addon = a.get("graphics_addon")
        if addon is not None:
            if not isinstance(addon, dict):
                raise bad(f"'graphics_addon' must be an object with 'root' and 'browser', got {addon!r}")
            addon = {"root": arg_str(addon, "root"), "browser": arg_str(addon, "browser")}
            if not os.path.isfile(os.path.join(addon["root"], "node_modules", "@remotion", "renderer", "package.json")):
                raise OpError("adapter_error", f"the graphics add-on root {addon['root']} has no "
                                               f"node_modules/@remotion/renderer")
            if not (os.path.isfile(addon["browser"]) and os.access(addon["browser"], os.X_OK)):
                raise OpError("adapter_error", f"the graphics add-on's browser {addon['browser']} is not a program")
        build, scratch = os.path.realpath(build), os.path.realpath(scratch)
        entry = os.path.join(build, "packages", "mcp", "dist", "index.js")
        if not os.path.isfile(entry):
            raise OpError("adapter_error", f"no MCP server build at {entry} (run npm run build)")
        if not os.path.isdir(scratch):
            raise bad(f"scratch {scratch} is not a folder")
        root = os.path.join(scratch, "editor")
        if os.path.exists(root):
            raise bad(f"{root} exists: the sandbox must be new")
        dirs = {k: os.path.join(root, k) for k in ("home", "xdg", "data", "tmp")}
        for d in dirs.values():
            os.makedirs(d)
        node = shutil.which("node")
        if not node:
            raise OpError("adapter_error", "no node on PATH")
        self.root = root
        self.port = free_port()
        absent = os.path.join(root, "absent")  # never made: the editor's model and helper settings name missing files
        env = {
            "HOME": dirs["home"], "USERPROFILE": dirs["home"], "XDG_CONFIG_HOME": dirs["xdg"],
            "AIVE_DATA_DIR": dirs["data"], "AIVE_PORT": str(self.port), "AIVE_CLIP_DISABLE": "1",
            "AIVE_WHISPER_BIN": os.path.join(absent, "whisper-cli"),
            "AIVE_WHISPER_MODEL": os.path.join(absent, "ggml-base.en.bin"),
            "TMPDIR": dirs["tmp"], "LANG": "C.UTF-8", "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        }
        if os.path.lexists(absent):
            raise OpError("adapter_error", f"{absent} exists: the model settings must name files that do not exist")
        for k in ("AIVE_FFMPEG", "AIVE_FFPROBE"):
            if os.environ.get(k):
                env[k] = os.environ[k]
        if addon is not None:  # the judge's read-only copy of the add-on (PROTOCOL.md, "Motion graphics")
            env["AIVE_REMOTION_ADDON"] = os.path.realpath(addon["root"])
            env["AIVE_REMOTION_BROWSER"] = os.path.realpath(addon["browser"])
        for k in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "AIVE_DATA_DIR", "TMPDIR"):  # the sandbox rule, checked
            if not os.path.realpath(env[k]).startswith(root + os.sep):
                raise OpError("adapter_error", f"{k} is outside the sandbox")
        log(f"starting {entry} on port {self.port}, sandbox {root}")
        self.env, self.build, self.scratch = env, build, scratch
        self.mcp = Mcp([node, entry], env, dirs["home"], os.path.join(scratch, "mcp-server.stderr"))
        try:
            init = self.mcp.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                                   "clientInfo": {"name": "judge", "version": "1"}}, 120)
            self.instructions = str(init.get("instructions") or "")
            self.mcp.notify("notifications/initialized")
            self.call("get_state", {}, 120)  # the MCP server starts its core on the first tool call
            self._check_core(dirs["data"])
        except BaseException:
            self.op_stop({})
            raise
        info = init.get("serverInfo") or {}
        self.product_name = str(info.get("name", "?"))
        return {"product": {"name": str(info.get("name", "?")), "version": str(info.get("version", "?"))},
                "ports": [self.port]}

    def _check_core(self, data):
        sj = os.path.join(data, "server.json")
        deadline = time.time() + 30
        while not os.path.isfile(sj) and time.time() < deadline:
            time.sleep(0.2)
        try:
            info = json.load(open(sj, encoding="utf-8"))
        except (OSError, ValueError) as e:
            raise OpError("adapter_error", f"the core wrote no readable server.json in the sandbox ({e})")
        if int(info.get("port", -1)) != self.port:
            raise OpError("adapter_error", f"server.json names port {info.get('port')}, not the sandbox's {self.port}")
        pid = int(info.get("pid", -1))
        if os.path.isdir("/proc"):
            env = environ_of(pid)
            if env is None or f"AIVE_DATA_DIR={data}".encode() not in env:
                raise OpError("adapter_error", f"process {pid} named in server.json is not the sandbox's core")
        self.token, self.core_pid = info.get("token"), pid
        if not self.token:
            raise OpError("adapter_error", "server.json has no token")

    def op_stop(self, a):
        stopped = []
        if self.shell is not None:
            if self.shell.poll() is None:
                stopped += end_processes([self.shell.pid])
                try:
                    self.shell.wait(10)
                except subprocess.TimeoutExpired:
                    pass
            self.shell = None
        if self.mcp is not None:
            self.mcp.close()
            if self.mcp.p.poll() is None:
                stopped += end_processes([self.mcp.p.pid])
                self.mcp.p.wait(10)
            self.mcp = None
        if self.root:
            entries = [f"AIVE_DATA_DIR={self.root}/data", f"HOME={self.root}/home"]
            for _ in range(3):  # children can start while their parents end
                pids = sandbox_pids(entries)
                if not pids:
                    break
                for pid in pids:
                    log(f"stopping {pid}: {cmdline_of(pid)[:200]}")
                stopped += end_processes(pids)
        return {"stopped": stopped}

    # ------------------------------------------------------------ media and timeline
    def op_import_media(self, a):
        j = self.call("import_video", {"path": arg_str(a, "path")})
        aid = find_key(j.get("asset") or j, ["id", "assetId"])
        if not aid:
            raise OpError("adapter_error", f"import_video returned no asset id: {json.dumps(j)[:300]}")
        return {"asset": aid}

    def op_place_clip(self, a):
        asset, start, src_in = arg_str(a, "asset"), arg_int(a, "start_frame"), arg_int(a, "in_frame")
        out = arg_int(a, "out_frame", required=False)
        args = {"assetId": asset, "trackIndex": self.track_index(a.get("track", "v0")),
                "startFrame": start, "sourceInFrame": src_in}
        if out is not None:
            args["sourceOutFrame"] = out
        j = self.call("add_clip", args)
        cid = find_key(j.get("clip") or j, ["id", "clipId"])
        if not cid:
            raise OpError("adapter_error", f"add_clip returned no clip id: {json.dumps(j)[:300]}")
        return {"clip": cid}

    def op_trim_clip(self, a):
        args = {"clipId": arg_str(a, "clip")}
        if a.get("in_frame") is not None:
            args["sourceInFrame"] = arg_int(a, "in_frame")
        if a.get("out_frame") is not None:
            args["sourceOutFrame"] = arg_int(a, "out_frame")
        self.call("trim_clip", args)
        return {}

    def op_move_clip(self, a):
        args = {"clipId": arg_str(a, "clip"), "startFrame": arg_int(a, "start_frame")}
        if a.get("track") is not None:
            args["trackIndex"] = self.track_index(a["track"])
        self.call("move_clip", args)
        return {}

    def op_split_clip(self, a):
        j = self.call("split_clip", {"clipId": arg_str(a, "clip"), "atFrame": arg_int(a, "at_frame")})
        ids = []
        for k in ("clipIds", "clips"):
            if isinstance(j.get(k), list):
                ids = [x if isinstance(x, str) else find_key(x, ["id", "clipId"]) for x in j[k]]
                break
        if len(ids) != 2:  # v0.2.0: {"left": id, "right": id, "atFrame": n}
            side = (lambda v: v if isinstance(v, str) else find_key(v, ["id", "clipId"]))
            left, right = side(j.get("left")), side(j.get("right"))
            ids = [left, right] if left and right else ids
        if len(ids) != 2 or not all(ids):
            raise OpError("adapter_error", f"split_clip returned no two clip ids: {json.dumps(j)[:300]}")
        return {"clips": ids}

    def op_remove_clip(self, a):
        self.call("remove_clip", {"clipId": arg_str(a, "clip")})
        return {}

    def op_set_speed(self, a):
        self.call("set_clip_speed", {"clipId": arg_str(a, "clip"), "speed": float(arg_num(a, "speed"))})
        return {}

    def op_apply_effect(self, a):
        args = {"clipId": arg_str(a, "clip"), "type": arg_str(a, "effect")}
        if a.get("amount") is not None:
            args["amount"] = a["amount"]
        if a.get("params") is not None:
            args["params"] = a["params"]
        j = self.call("apply_effect", args)
        return {"effect": find_key(j, ["effectId"]) or find_key(j.get("effect"), ["id"])}

    def op_apply_colour(self, a):
        clip = arg_str(a, "clip")
        grade = {k: arg_num(a, k) for k in ("brightness", "contrast", "saturation", "gamma") if a.get(k) is not None}
        colour = {k: arg_num(a, k) for k in ("temperature", "tint", "hue") if a.get(k) is not None}
        if not grade and not colour:
            raise bad("no colour field given")
        if grade:
            self.call("color_grade", {"clipId": clip, **grade})
        if colour:
            self.call("apply_color", {"clipId": clip, **colour})
        return {}

    def op_set_project(self, a):
        args = {k: (arg_num if k == "fps" else arg_int)(a, k) for k in ("width", "height", "fps") if a.get(k) is not None}
        if not args:
            raise bad("no project field given")
        self.call("set_project_settings", args)
        return {}

    def op_undo(self, a):
        self.call("undo", {})
        return {}

    def op_redo(self, a):
        self.call("redo", {})
        return {}

    def op_get_state(self, a):
        st = self.call("get_state", {})
        _, ts = self.tracks()
        canvas = ts.get("canvas") or {"width": st.get("width"), "height": st.get("height"), "fps": st.get("fps")}
        assets = []
        for x in st.get("assets", []):
            waiting = x.get("awaitingServer")
            assets.append({"id": x.get("id"), "path": x.get("path"),
                           "offline": bool(x.get("missing") or waiting or x.get("offline")),
                           "waiting_host": waiting if isinstance(waiting, str) and waiting else None})
        def speed_of(c):  # v0.2.0 keeps a constant speed in the clip's effects
            v = (c.get("effects") or {}).get("speed", c.get("speed", 1))
            return v if isinstance(v, (int, float)) and v > 0 else 1
        overlays = {}  # clip id -> its motion graphics' ids (get_state's clips; timeline_summary does not list them)
        for t in st.get("tracks", []):
            for c in t.get("clips", []) or []:
                overlays[c.get("id")] = [g.get("id") for g in c.get("graphics") or [] if isinstance(g, dict)]
        tracks = []
        for kind, prefix in (("video", "v"), ("audio", "a")):
            kt = sorted((t for t in ts.get("tracks", []) if t.get("kind") == kind), key=lambda t: t["trackIndex"])
            for n, t in enumerate(kt):
                clips = []
                for c in sorted(t.get("clips", []), key=lambda c: c.get("startFrame", 0)):
                    clips.append({"id": c.get("clipId"), "asset": c.get("assetId"), "start_frame": c.get("startFrame"),
                                  "in_frame": c.get("sourceInFrame"), "out_frame": c.get("sourceOutFrame"),
                                  "length_frames": c.get("durationFrames"),
                                  "speed": speed_of(c), "graphics": overlays.get(c.get("clipId"), [])})
                tracks.append({"track": f"{prefix}{n}", "clips": clips})
        out = {"canvas": {"width": canvas.get("width"), "height": canvas.get("height"), "fps": canvas.get("fps")},
               "length_frames": ts.get("totalFrames"), "assets": assets, "tracks": tracks}
        if isinstance(st.get("graphicsRenderer"), str):  # v0.2.0: "remotion" (the add-on) or the product's own name
            out["graphics"] = {"renderer": "addon" if st["graphicsRenderer"] == "remotion" else "builtin",
                               "ready": st.get("graphics") == "ready"}
        return out

    # ------------------------------------------------------------ output and jobs
    @staticmethod
    def job_of(j):
        status = j.get("status") or "done"
        return {"job": j.get("jobId") or j.get("id"), "status": status, "path": j.get("path") or j.get("outputPath"),
                "error": j.get("error"), "fraction": j.get("fraction")}

    def op_export(self, a):
        path = arg_str(a, "path")
        wait = a.get("wait", True)
        if not isinstance(wait, bool):
            raise bad(f"'wait' must be true or false, got {wait!r}")
        j = self.call("export_video", {"outputPath": path, **({} if wait else {"background": True})})
        job = self.job_of(j)
        if wait:
            # The editor's own word first: an error or a cancel it reports stays one, even when it left a (partial)
            # file at the path. Done only when it reports no error and the file is there.
            said = j.get("status")
            if said in ("error", "canceled", "cancelled"):
                job["status"] = "canceled" if said.startswith("cancel") else "error"
                job["error"] = job["error"] or f"the editor reported status {said!r}"
            elif j.get("error"):
                job["status"] = "error"
            elif not os.path.isfile(path):
                job["status"] = "error"
                job["error"] = "the editor reported no error, but there is no file at the path"
            else:
                job["status"] = "done"
            if job["error"] is not None and not isinstance(job["error"], str):
                job["error"] = json.dumps(job["error"])[:4000]
            job["path"] = job["path"] or path
        elif job["status"] == "done" and j.get("jobId"):
            job["status"] = "running"
        return job

    def op_jobs(self, a):
        j = self.call("list_jobs", {})
        out = []
        for x in j.get("jobs", []):
            res = x.get("result") if isinstance(x.get("result"), dict) else {}
            out.append({"job": x.get("id"), "kind": x.get("type"), "status": x.get("status"),
                        "fraction": x.get("fraction"), "path": res.get("path"), "error": x.get("error")})
        return {"jobs": out}

    def op_cancel(self, a):
        j = self.call("cancel_job", {"jobId": arg_str(a, "job")})
        return {"canceled": bool(j.get("canceled"))}

    def op_render_frame(self, a):
        at, path = float(arg_num(a, "time")), arg_str(a, "path")
        j = self.call("get_frame", {"atSeconds": at})
        img = next((c for c in j.get("_content", []) if c.get("type") == "image"), None)
        if img is None:
            raise OpError("adapter_error", "get_frame returned no image")
        with open(path, "wb") as f:
            f.write(base64.b64decode(img["data"]))
        return {"path": path}

    # ------------------------------------------------------------ projects and interchange
    def op_save_project(self, a):
        self.call("save_project", {"path": arg_str(a, "path")})
        return {}

    def op_save(self, a):
        """The plain Save: v0.2.0's save tool writes the project to its current file (refused when there is none)."""
        self.call("save", {})
        return {}

    def op_load_project(self, a):
        j = self.call("load_project", {"path": arg_str(a, "path")})
        return {"notice": j.get("notice")}

    def op_export_otio(self, a):
        self.call("export_otio", {"path": arg_str(a, "path")})
        return {}

    def op_import_otio(self, a):
        j = self.call("import_otio", {"path": arg_str(a, "path")})
        return {"missing": [m if isinstance(m, str) else find_key(m, ["path"]) for m in (j.get("missing") or [])]}

    # ------------------------------------------------------------ file surface and network computers
    def op_http_get(self, a):
        route = arg_str(a, "route")
        if not route.startswith("/") or any(ch in route for ch in "?#"):
            raise bad(f"route must be a path such as /file, got {route!r}")
        if self.token is None:
            raise OpError("adapter_error", "the editor is not started")
        if not isinstance(a.get("query") or {}, dict):
            raise bad(f"'query' must be an object, got {a.get('query')!r}")
        query = {str(k): str(v) for k, v in (a.get("query") or {}).items()}
        query["token"] = self.token
        url = f"http://127.0.0.1:{self.port}{route}?{urllib.parse.urlencode(query)}"
        req = urllib.request.Request(url, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                status, ctype, body = r.status, r.headers.get("Content-Type", ""), r.read()
        except urllib.error.HTTPError as e:
            status, ctype = e.code, e.headers.get("Content-Type", "") if e.headers else ""
            try:
                body = e.read()
            except OSError:
                body = b""
        except (urllib.error.URLError, OSError) as e:
            raise OpError("adapter_error", f"GET {route} failed: {e}")
        self.note(body[:TRANSCRIPT_CAP].decode("utf-8", "replace"))
        return {"status": status, "content_type": ctype, "body_length": len(body),
                "body_sha256": hashlib.sha256(body).hexdigest(),
                "body_b64": base64.b64encode(body[:BODY_CAP]).decode("ascii"), "truncated": len(body) > BODY_CAP}

    def op_list_hosts(self, a):
        j = self.call("list_media_servers", {})
        hosts = (lambda k: [x.get("host") if isinstance(x, dict) else x for x in (j.get(k) or [])])
        return {"approved": hosts("approved"), "pending": hosts("pending"), "outside": hosts("outside")}

    def op_recheck_media(self, a):
        self.call("recheck_offline_media", {})
        return {}

    # v0.2.0 allows a network computer only from its window (the desktop app, or the web shell with its shell key); no
    # MCP tool can. approve_host and revoke_host go through the web shell, started on first use (see the docstring).
    def _shell_start(self):
        """Starts the web shell attached to the running core. Its port goes on unreported_ports, which handle() puts in
        the next ok answer of any operation (stop's too), also when the operation that started it was refused."""
        if self.shell is not None and self.shell.poll() is None:
            return
        if self.mcp is None or self.env is None:
            raise OpError("adapter_error", "the editor is not started")
        server = os.path.join(self.build, "apps", "desktop", "web", "server.cjs")
        if not os.path.isfile(server):
            raise OpError("adapter_error", f"no web shell at {server}")
        env = dict(self.env)
        env["AIVE_PORT"] = str(self.port)  # attach to the sandbox's running core, never start another one
        for k in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "AIVE_DATA_DIR", "TMPDIR"):  # the sandbox rule, checked
            if not os.path.realpath(env[k]).startswith(self.root + os.sep):
                raise OpError("adapter_error", f"{k} is outside the sandbox")
        err = open(os.path.join(self.scratch, "web-shell.stderr"), "ab")
        log(f"starting the web shell {server} for core port {self.port}")
        self.shell = subprocess.Popen([shutil.which("node") or "node", server, "--port", "0", "--no-open"], env=env,
                                      cwd=env["HOME"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=err,
                                      text=True, bufsize=1)
        err.close()
        found = {}

        def read():
            for line in self.shell.stdout:  # the JSON "ready" line; the rest is drained so the pipe never fills
                if "ready" not in found:
                    try:
                        m = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(m, dict) and m.get("event") == "ready":
                        found["ready"] = m
        threading.Thread(target=read, daemon=True).start()
        deadline = time.time() + 60
        while "ready" not in found and self.shell.poll() is None and time.time() < deadline:
            time.sleep(0.1)
        ready = found.get("ready")
        try:
            if ready is None:
                raise OpError("adapter_error", f"the web shell did not report ready (exit {self.shell.poll()}); see "
                                               f"{os.path.join(self.scratch, 'web-shell.stderr')}")
            q = urllib.parse.parse_qs(urllib.parse.urlparse(str(ready.get("url", ""))).query)
            key = (q.get("shell") or [""])[0]
            if int(ready.get("corePort", -1)) != self.port or ready.get("coreOwned") is not False:
                raise OpError("adapter_error", f"the web shell is not attached to the sandbox's core "
                                               f"(corePort {ready.get('corePort')}, coreOwned {ready.get('coreOwned')})")
            if not key or not isinstance(ready.get("port"), int):
                raise OpError("adapter_error", "the web shell's ready line has no shell key or port")
        except BaseException:
            end_processes([self.shell.pid])
            self.shell = None
            raise
        self.shell_port, self.shell_key = ready["port"], key
        self.unreported_ports.append(self.shell_port)

    def _shell_post(self, route, body):
        """POST to the web shell with its key: (status, parsed JSON body or {})."""
        req = urllib.request.Request(f"http://127.0.0.1:{self.shell_port}{route}", data=json.dumps(body).encode(),
                                     method="POST", headers={"content-type": "application/json",
                                                             **{h: self.shell_key for h in SHELL_HEADERS}})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                status, raw = r.status, r.read()
        except urllib.error.HTTPError as e:
            status = e.code
            try:
                raw = e.read()
            except OSError:
                raw = b""
        except (urllib.error.URLError, OSError) as e:
            raise OpError("adapter_error", f"POST {route} failed: {e}")
        text = raw.decode("utf-8", "replace")
        self.note(text)
        j = as_json(text)
        return status, (j if isinstance(j, dict) else {})

    def _shell_answer(self, route, status, j):
        if status == 200 and j.get("ok") is not False:
            return
        msg = str(j.get("error") or f"status {status}")
        if 400 <= status < 500 and status not in (401, 403, 404, 405):
            raise OpError("product_error", msg)  # the window refused the host (e.g. not a network computer name)
        raise OpError("adapter_error", f"POST {route}: {status} {msg}")

    def op_approve_host(self, a):
        host = arg_str(a, "host")
        self._shell_start()
        status, j = self._shell_post("/api/media-servers/approve", {"host": host})
        self._shell_answer("/api/media-servers/approve", status, j)
        return {}

    def op_revoke_host(self, a):
        host = arg_str(a, "host")
        only = a.get("only_if_outside", False)
        if not isinstance(only, bool):
            raise bad(f"'only_if_outside' must be true or false, got {only!r}")
        self._shell_start()
        status, j = self._shell_post("/api/media-servers/revoke", {"host": host, **({"onlyIfOutside": True} if only else {})})
        self._shell_answer("/api/media-servers/revoke", status, j)
        if not isinstance(j.get("removed"), bool):
            raise OpError("adapter_error", f"revoke answered no 'removed': {json.dumps(j)[:300]}")
        return {"removed": j["removed"]}

    def op_add_host_outside(self, a):
        """The attacker's edit: an entry in the allowed-computers store that the window did not make. forged: the entry
        claims an approval, with a stamp made with a random key (not the editor's)."""
        host = arg_str(a, "host")
        forged = a.get("forged", False)
        if not isinstance(forged, bool):
            raise bad(f"'forged' must be true or false, got {forged!r}")
        if self.root is None:
            raise OpError("adapter_error", "the editor is not started")
        trust = os.path.join(self.root, "data", "trust")
        os.makedirs(trust, mode=0o700, exist_ok=True)
        store, keyf = os.path.join(trust, "hosts.json"), os.path.join(trust, "hosts.key")
        if not os.path.isfile(keyf):  # what a shell agent with file access can do before any approval
            with open(keyf, "w", encoding="utf-8") as f:
                f.write(base64.urlsafe_b64encode(os.urandom(32)).decode("ascii").rstrip("="))
            os.chmod(keyf, 0o600)
        try:
            cur = json.load(open(store, encoding="utf-8"))
        except (OSError, ValueError):
            cur = {}
        if not isinstance(cur, dict) or not isinstance(cur.get("servers"), list):
            cur = {"version": 2, "servers": []}
        entry = {"host": host}
        if forged:
            added = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
            stamp = hmac.new(os.urandom(32), f"zedmix-hosts-v2\n{host}\nprompt\n{added}".encode(), "sha256").digest()
            entry = {"host": host, "via": "prompt", "added": added,
                     "stamp": base64.urlsafe_b64encode(stamp).decode("ascii").rstrip("=")}
        cur["servers"] = [e for e in cur["servers"] if not (isinstance(e, dict) and e.get("host") == host)] + [entry]
        with open(store, "w", encoding="utf-8") as f:
            json.dump(cur, f, indent=2)
        with open(keyf, encoding="utf-8") as f:
            secret = f.read().strip()
        return {"files": [store, keyf], "secrets": [secret]}

    # ------------------------------------------------------------ motion graphics
    def op_set_graphics_renderer(self, a):
        """The user's renderer setting, through the web shell's route (the window's Graphics add-on dialog)."""
        renderer = arg_str(a, "renderer")
        if renderer not in ("builtin", "addon"):
            raise bad(f"'renderer' must be 'builtin' or 'addon', got {renderer!r}")
        if self.mcp is None or not self.product_name:
            raise OpError("adapter_error", "the editor is not started")
        value = "remotion" if renderer == "addon" else self.product_name
        self._shell_start()
        status, j = self._shell_post("/api/graphics-addon/renderer", {"renderer": value})
        self._shell_answer("/api/graphics-addon/renderer", status, j)
        return {}

    def op_add_graphic(self, a):
        code, template = a.get("code"), a.get("template")
        if (code is None) == (template is None):
            raise bad("give exactly one of 'code' and 'template'")
        args = {}
        if code is not None:
            if not isinstance(code, str) or not code:
                raise bad(f"'code' must be a non-empty string, got {code!r}")
            args["code"] = code  # unchanged: tests send hostile code on purpose
        else:
            args["template"] = arg_str(a, "template")
        props = a.get("props")
        if props is not None:
            if not isinstance(props, dict):
                raise bad(f"'props' must be an object, got {props!r}")
            args["props"] = props
        clip = arg_str(a, "clip", required=False)
        if clip is not None:
            args["clipId"] = clip
        dur = arg_num(a, "duration_s", required=False)
        if dur is not None:
            args["durationSeconds"] = dur
        j = self.call("add_graphic", args)
        gid, cid, aid = j.get("graphicId"), j.get("clipId"), j.get("assetId")
        if not isinstance(cid, str) or not cid:
            raise OpError("adapter_error", f"add_graphic returned no clip id: {json.dumps(j)[:300]}")
        return {"graphic": gid if isinstance(gid, str) and gid else None, "clip": cid,
                "asset": aid if isinstance(aid, str) and aid else None}

    # ------------------------------------------------------------ text, colour, proxies
    STYLE = {"position": "position", "x": "x", "y": "y", "font": "font", "font_size": "fontSize", "color": "color",
             "outline_color": "outlineColor", "outline_width": "outlineWidth", "shadow_color": "shadowColor",
             "shadow_x": "shadowX", "shadow_y": "shadowY", "box": "box", "box_color": "boxColor",
             "box_border": "boxBorderW"}

    def op_add_text(self, a):
        style = a.get("style") or {}
        if not isinstance(style, dict):
            raise bad(f"'style' must be an object, got {style!r}")
        args = {"clipId": arg_str(a, "clip"), "text": arg_str(a, "text")}
        for k, v in style.items():  # passed on unchanged: the editor accepts or refuses each value
            if k in self.STYLE:
                args[self.STYLE[k]] = v
        j = self.call("add_text", args)
        tid = find_key(j.get("overlay") or j, ["overlayId", "id"])
        if not tid:
            raise OpError("adapter_error", f"add_text returned no text id: {json.dumps(j)[:300]}")
        return {"text": tid}

    def op_apply_lut(self, a):
        self.call("apply_lut", {"clipId": arg_str(a, "clip"), "path": arg_str(a, "path")})
        return {}

    def op_make_proxy(self, a):
        self.call("generate_proxy", {"assetId": arg_str(a, "asset")})
        return {}

    def op_thumbnail(self, a):
        args = {"assetId": arg_str(a, "asset")}
        if a.get("time") is not None:
            args["atSeconds"] = float(arg_num(a, "time"))
        j = self.call("generate_thumbnail", args)
        path = find_key(j, ["path", "thumbnailPath", "imagePath"])
        if not path:  # v0.2.0 answers in prose: "generate_thumbnail → rendered frame (<path>):"
            m = re.search(r"(/[^\s()\"']+\.(?:jpe?g|png|webp))", str(j.get("text") or ""))
            path = m.group(1) if m else None
        return {"path": path}

    # ------------------------------------------------------------ what an agent has
    def _tools(self):
        if self.mcp is None:
            raise OpError("adapter_error", "the editor is not started")
        tools, cursor = [], None
        for _ in range(50):
            r = self.mcp.request("tools/list", {"cursor": cursor} if cursor else {}, 120)
            tools += [t for t in r.get("tools", []) if isinstance(t, dict) and isinstance(t.get("name"), str)]
            cursor = r.get("nextCursor")
            if not cursor:
                break
        return tools

    def op_agent_tools(self, a):
        tools = self._tools()
        return {"tools": [{"name": t["name"], "read_only": bool((t.get("annotations") or {}).get("readOnlyHint"))}
                          for t in tools], "instructions": self.instructions}

    def op_poke_agent_tools(self, a):
        """Every agent tool once, with empty arguments; answers and refusals are only counted."""
        called = refused = 0
        for t in self._tools():
            called += 1
            try:
                self.call(t["name"], {}, POKE_TIMEOUT)
            except OpError:
                refused += 1
        return {"called": called, "refused": refused}

    def op_transcript(self, a):
        return {"texts": list(self.texts)}


def handle(ad, raw):
    """One request line -> its response object. bad_request only for the judge's arguments (arg_* and the checks in
    the operations); any other exception is the adapter's or the editor's reply's fault: adapter_error."""
    rid = None
    try:
        req = json.loads(raw)
        if not isinstance(req, dict):
            raise bad("a request must be a JSON object")
        rid = req.get("id")
        op, args = req.get("op"), req.get("args") or {}
        fn = getattr(ad, f"op_{op}", None) if isinstance(op, str) and re.fullmatch(r"[a-z_]+", op) else None
        if fn is None:
            raise OpError("unsupported", f"unknown operation {op!r}")
        if not isinstance(args, dict):
            raise bad("args must be an object")
        result = fn(args)
        if ad.unreported_ports and isinstance(result, dict) and op != "start":
            # Ports opened by this operation or by an earlier one that was refused (PROTOCOL.md, "Ports"); start's
            # own ports are its whole list, which the judge reads separately.
            result = {**result, "ports": list(result.get("ports") or []) + ad.unreported_ports}
            ad.unreported_ports = []
        return {"id": rid, "ok": True, "result": result}
    except OpError as e:
        err = {"code": e.code, "message": e.message}
        if e.product_code:
            err["product_code"] = e.product_code
        return {"id": rid, "ok": False, "error": err}
    except json.JSONDecodeError as e:
        return {"id": rid, "ok": False, "error": {"code": "bad_request", "message": f"not JSON: {e}"}}
    except Exception as e:  # noqa: BLE001
        log("internal error:", repr(e))
        return {"id": rid, "ok": False, "error": {"code": "adapter_error", "message": repr(e)}}


def self_test():
    """The adapter's own checks, with the editor replaced by canned replies (no editor starts)."""
    import tempfile
    failures = []

    def expect(name, got, want):
        ok = got == want
        print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f": got {got!r}, want {want!r}"), flush=True)
        if not ok:
            failures.append(name)

    tmp = tempfile.mkdtemp(prefix="v020-adapter-selftest-")
    try:
        partial = os.path.join(tmp, "partial.mp4")
        with open(partial, "wb") as f:
            f.write(b"\0" * 1024)
        absent = os.path.join(tmp, "absent.mp4")

        def adapter(reply):
            ad = Adapter()
            ad.call = lambda name, args, timeout=MCP_TIMEOUT: reply(name, args)
            return ad

        def export(reply, path):
            return handle(adapter(reply), json.dumps({"id": 1, "op": "export", "args": {"path": path, "wait": True}}))

        r = export(lambda n, a: {"status": "error", "error": "encoder failed"}, partial)
        expect("export: the editor's error with a partial file left is status error",
               (r["result"]["status"], r["result"]["error"]), ("error", "encoder failed"))
        r = export(lambda n, a: {"status": "canceled"}, partial)
        expect("export: the editor's cancel with a partial file left is status canceled", r["result"]["status"],
               "canceled")
        r = export(lambda n, a: {"error": "disk full"}, partial)
        expect("export: an error with no status is status error", (r["result"]["status"], r["result"]["error"]),
               ("error", "disk full"))
        r = export(lambda n, a: {"text": "Exported"}, absent)
        expect("export: no file at the path is status error", r["result"]["status"], "error")
        r = export(lambda n, a: {"text": "Exported"}, partial)
        expect("export: no error and the file there is status done", (r["result"]["status"], r["result"]["error"]),
               ("done", None))

        def summary(tracks):
            return lambda n, a: {"tracks": tracks} if n == "timeline_summary" else {"clip": {"id": "c1"}}

        place = (lambda ad, args: handle(ad, json.dumps({"id": 2, "op": "place_clip", "args": args})))
        good = {"asset": "a1", "start_frame": 0, "in_frame": 0}
        ok_ad = adapter(summary([{"kind": "video", "trackIndex": 0}]))
        expect("place_clip: good arguments answer ok", place(ok_ad, good).get("result"), {"clip": "c1"})
        expect("place_clip: start_frame 'x' is bad_request",
               place(ok_ad, {**good, "start_frame": "x"})["error"]["code"], "bad_request")
        expect("place_clip: no asset is bad_request", place(ok_ad, {"start_frame": 0, "in_frame": 0})["error"]["code"],
               "bad_request")
        expect("place_clip: a track that does not exist is bad_request",
               place(ok_ad, {**good, "track": "v1"})["error"]["code"], "bad_request")
        broken = adapter(summary([{"kind": "video"}]))  # the editor's reply has no trackIndex
        expect("place_clip: a malformed editor reply is adapter_error, not bad_request",
               place(broken, good)["error"]["code"], "adapter_error")
        notnum = adapter(lambda n, a: {"pid": "x"})
        notnum.op_x = lambda a: int(notnum.call("x", {})["pid"])
        expect("an unexpected ValueError inside an operation is adapter_error",
               handle(notnum, json.dumps({"id": 3, "op": "x", "args": {}}))["error"]["code"], "adapter_error")
        expect("an unknown operation is unsupported",
               handle(Adapter(), json.dumps({"id": 4, "op": "nope", "args": {}}))["error"]["code"], "unsupported")

        # Network computers, text and the transcript (batch 1a operations), on canned replies.
        def op(ad, name, args):
            return handle(ad, json.dumps({"id": 5, "op": name, "args": args}))

        def state_reply(n, a):
            if n == "timeline_summary":
                return {"tracks": [], "canvas": {"width": 64, "height": 64, "fps": 30}, "totalFrames": 0}
            return {"assets": [{"id": "a1", "path": "//nas/s/a.mp4", "awaitingServer": "nas"},
                               {"id": "a2", "path": "/m/b.mp4"}]}
        assets = op(adapter(state_reply), "get_state", {})["result"]["assets"]
        expect("get_state: an asset waiting for its computer is offline with waiting_host",
               [(x["offline"], x["waiting_host"]) for x in assets], [(True, "nas"), (False, None)])
        seen = {}

        def text_reply(n, a):
            seen.update(a)
            return {"overlayId": "text_1"}
        r = op(adapter(text_reply), "add_text", {"clip": "c1", "text": "t", "style": {"font_size": "12,x", "box": True,
                                                                                      "nope": 1}})
        expect("add_text: style fields are renamed and passed on unchanged; unknown ones are dropped",
               (r.get("result"), seen.get("fontSize"), seen.get("box"), "nope" in seen),
               ({"text": "text_1"}, "12,x", True, False))
        tools_called = []
        r = op(adapter(lambda n, a: tools_called.append((n, a)) or {"text": "Saved"}), "save", {})
        expect("save: the plain Save is v0.2.0's save tool, with no arguments", (r.get("result"), tools_called),
               ({}, [("save", {})]))
        r = op(adapter(lambda n, a: {"text": "generate_thumbnail → rendered frame (/d/thumbnails/a1.jpg):"}),
               "thumbnail", {"asset": "a1", "time": 0.5})
        expect("thumbnail: the path in v0.2.0's prose answer", r.get("result"), {"path": "/d/thumbnails/a1.jpg"})

        def shell(status, body):
            ad = adapter(lambda n, a: {})
            ad._shell_start = lambda: None
            ad._shell_post = lambda route, b: (status, body)
            return ad
        expect("approve_host: 200 answers ok", op(shell(200, {"ok": True}), "approve_host", {"host": "nas"}).get("result"),
               {})
        expect("approve_host: a 400 refusal is product_error",
               op(shell(400, {"ok": False, "error": "Not a network computer name."}), "approve_host",
                  {"host": "nas@SSL"})["error"]["code"], "product_error")
        expect("approve_host: a 401 (the shell key not taken) is adapter_error",
               op(shell(401, {"ok": False}), "approve_host", {"host": "nas"})["error"]["code"], "adapter_error")
        expect("revoke_host: removed is passed on",
               op(shell(200, {"ok": True, "removed": False}), "revoke_host", {"host": "nas", "only_if_outside": True})
               .get("result"), {"removed": False})
        ad = shell(400, {"ok": False, "error": "Not a network computer name."})
        ad._shell_start = lambda: ad.unreported_ports.append(4321)  # the shell starts, then the host is refused
        first = op(ad, "approve_host", {"host": "nas@SSL"})
        later = op(ad, "stop", {})
        expect("a shell started by a refused approve_host: its port comes back in the next ok answer (stop's), once",
               (first["error"]["code"], later.get("result", {}).get("ports"), ad.unreported_ports),
               ("product_error", [4321], []))
        # Motion graphics (batch 1b operations), on canned replies.
        sent = []

        def graphic_reply(n, a):
            sent.append((n, a))
            if "clipId" in a:
                return {"graphicId": "gfx_1", "clipId": a["clipId"], "assetId": "asset_g", "standalone": False}
            return {"clipId": "clip_new", "assetId": "asset_s", "duration": 1}
        ad = adapter(graphic_reply)
        r1 = op(ad, "add_graphic", {"code": "export default () => null;", "clip": "c1", "props": {"t": 1}})
        r2 = op(ad, "add_graphic", {"template": "title", "duration_s": 1})
        expect("add_graphic: an overlay and a standalone graphic map to v0.2.0's add_graphic and back",
               (r1.get("result"), r2.get("result"), sent),
               ({"graphic": "gfx_1", "clip": "c1", "asset": "asset_g"},
                {"graphic": None, "clip": "clip_new", "asset": "asset_s"},
                [("add_graphic", {"code": "export default () => null;", "props": {"t": 1}, "clipId": "c1"}),
                 ("add_graphic", {"template": "title", "durationSeconds": 1})]))
        expect("add_graphic: neither or both of code and template is bad_request",
               [op(adapter(graphic_reply), "add_graphic", x)["error"]["code"]
                for x in ({}, {"code": "x", "template": "title"}, {"code": 3}, {"template": "title", "props": []})],
               ["bad_request"] * 4)
        posted = []

        def renderer_shell(status, body):
            ad = shell(status, body)
            ad.mcp, ad.product_name = object(), "product-x"
            ad._shell_post = lambda route, b: posted.append((route, b)) or (status, body)
            return ad
        op(renderer_shell(200, {"ok": True}), "set_graphics_renderer", {"renderer": "addon"})
        op(renderer_shell(200, {"ok": True}), "set_graphics_renderer", {"renderer": "builtin"})
        expect("set_graphics_renderer: addon is remotion, builtin the product's own name, through the window's route",
               posted, [("/api/graphics-addon/renderer", {"renderer": "remotion"}),
                        ("/api/graphics-addon/renderer", {"renderer": "product-x"})])
        expect("set_graphics_renderer: another value is bad_request; the window's 400 is product_error",
               (op(renderer_shell(200, {"ok": True}), "set_graphics_renderer", {"renderer": "chrome"})["error"]["code"],
                op(renderer_shell(400, {"ok": False, "error": "Not a graphics renderer."}), "set_graphics_renderer",
                   {"renderer": "addon"})["error"]["code"]), ("bad_request", "product_error"))

        def graphics_state(n, a):
            if n == "timeline_summary":
                return {"tracks": [{"kind": "video", "trackIndex": 0, "clips": [
                    {"clipId": "c1", "assetId": "a1", "startFrame": 0, "durationFrames": 30, "sourceInFrame": 0,
                     "sourceOutFrame": 30}]}], "canvas": {"width": 64, "height": 64, "fps": 30}, "totalFrames": 30}
            return {"assets": [], "graphicsRenderer": "remotion", "graphics": "not-installed",
                    "tracks": [{"clips": [{"id": "c1", "graphics": [{"id": "gfx_1"}]}]}]}
        st = op(adapter(graphics_state), "get_state", {})["result"]
        expect("get_state: the renderer setting, whether it is ready, and each clip's graphics",
               (st.get("graphics"), st["tracks"][0]["clips"][0]["graphics"]),
               ({"renderer": "addon", "ready": False}, ["gfx_1"]))
        expect("start: a graphics_addon that is not an object with root and browser is bad_request",
               [op(Adapter(), "start", {"build": tmp, "scratch": tmp, "graphics_addon": x})["error"]["code"]
                for x in ("dir", {"root": tmp}, {"root": tmp, "browser": 3})], ["bad_request"] * 3)

        class FakeMcp:
            def request(self, method, params, timeout=None):
                err = params["name"] == "bad"
                return {"isError": err, "content": [{"type": "text", "text": f"answer of {params['name']}"},
                                                    {"type": "image", "data": "AAAA"}]}
        ad = Adapter()
        ad.mcp = FakeMcp()
        ad.call("get_state", {})
        try:
            ad.call("bad", {})
        except OpError:
            pass
        ad.note("an HTTP body")
        expect("transcript: every text answer kept (results, errors, HTTP bodies), images left out",
               op(ad, "transcript", {}).get("result"),
               {"texts": ["answer of get_state", "answer of bad", "an HTTP body"]})
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"[v020 adapter] self-test FAILED: {len(failures)} case(s)" if failures else "[v020 adapter] self-test ok")
    return 1 if failures else 0


def main():
    if "--self-test" in sys.argv[1:]:
        return self_test()
    ad = Adapter()
    out = sys.stdout
    try:
        for raw in sys.stdin:
            raw = raw.strip()
            if not raw:
                continue
            out.write(json.dumps(handle(ad, raw)) + "\n")
            out.flush()
    finally:
        try:
            ad.op_stop({})
        except Exception as e:  # noqa: BLE001
            log("stop on exit failed:", repr(e))
    return 0


if __name__ == "__main__":
    sys.exit(main())
