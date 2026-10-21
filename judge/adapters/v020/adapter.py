#!/usr/bin/env python3
"""The judge's adapter for v0.2.0's interfaces (judge/PROTOCOL.md, version 1).

    python3 -I judge/adapters/v020/adapter.py        (the runner starts it; requests on stdin, answers on stdout)

It maps the judge's operations to v0.2.0's public MCP tools, spoken over stdio to the MCP server of the build named
in `start` (<build>/packages/mcp/dist/index.js, run with the `node` on PATH), and to the core's HTTP routes where an
operation needs them (http_get). Python 3 standard library only.

The editor runs in a sandbox under <scratch>/editor: HOME, USERPROFILE, XDG_CONFIG_HOME, AIVE_DATA_DIR and TMPDIR
point at fresh folders there, AIVE_PORT is a free port (never 4791, the default, which the user's own editor may
use), and AIVE_CLIP_DISABLE=1 keeps the visual index model from loading. The editor uses the FFmpeg on PATH, or
AIVE_FFMPEG / AIVE_FFPROBE when they are set in the adapter's environment. `start` checks that the core that answers
is the one it started (its server.json is in the sandbox's data folder, names the sandbox's port, and its process has
the sandbox's data folder in its environment) and refuses to go on otherwise. `stop` ends the MCP server, then every
process whose environment holds the sandbox's data folder or home, by exact process id.
"""
import base64
import hashlib
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

ADAPTER = "v020 (v0.2.0 MCP tools over stdio + core HTTP routes)"
PROTOCOL = 1
BODY_CAP = 262144
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

    # ------------------------------------------------------------ helpers
    def call(self, name, args, timeout=MCP_TIMEOUT):
        """A tool call: the parsed JSON result (or {"text": ...}); a tool error becomes product_error."""
        if self.mcp is None:
            raise OpError("adapter_error", "the editor is not started")
        r = self.mcp.request("tools/call", {"name": name, "arguments": args}, timeout)
        text = text_of(r)
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
        ops = sorted(n[3:] for n in dir(self) if n.startswith("op_") and n not in ("op_approve_host",))
        return {"protocol": PROTOCOL, "adapter": ADAPTER, "ops": ops}

    def op_start(self, a):
        build, scratch = arg_str(a, "build"), arg_str(a, "scratch")
        if self.mcp is not None:
            raise bad("already started")
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
        env = {
            "HOME": dirs["home"], "USERPROFILE": dirs["home"], "XDG_CONFIG_HOME": dirs["xdg"],
            "AIVE_DATA_DIR": dirs["data"], "AIVE_PORT": str(self.port), "AIVE_CLIP_DISABLE": "1",
            "TMPDIR": dirs["tmp"], "LANG": "C.UTF-8", "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        }
        for k in ("AIVE_FFMPEG", "AIVE_FFPROBE"):
            if os.environ.get(k):
                env[k] = os.environ[k]
        for k in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "AIVE_DATA_DIR", "TMPDIR"):  # the sandbox rule, checked
            if not os.path.realpath(env[k]).startswith(root + os.sep):
                raise OpError("adapter_error", f"{k} is outside the sandbox")
        log(f"starting {entry} on port {self.port}, sandbox {root}")
        self.mcp = Mcp([node, entry], env, dirs["home"], os.path.join(scratch, "mcp-server.stderr"))
        try:
            init = self.mcp.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                                   "clientInfo": {"name": "judge", "version": "1"}}, 120)
            self.mcp.notify("notifications/initialized")
            self.call("get_state", {}, 120)  # the MCP server starts its core on the first tool call
            self._check_core(dirs["data"])
        except BaseException:
            self.op_stop({})
            raise
        info = init.get("serverInfo") or {}
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
            assets.append({"id": x.get("id"), "path": x.get("path"),
                           "offline": bool(x.get("missing") or x.get("awaitingServer") or x.get("offline"))})
        def speed_of(c):  # v0.2.0 keeps a constant speed in the clip's effects
            v = (c.get("effects") or {}).get("speed", c.get("speed", 1))
            return v if isinstance(v, (int, float)) and v > 0 else 1
        tracks = []
        for kind, prefix in (("video", "v"), ("audio", "a")):
            kt = sorted((t for t in ts.get("tracks", []) if t.get("kind") == kind), key=lambda t: t["trackIndex"])
            for n, t in enumerate(kt):
                clips = []
                for c in sorted(t.get("clips", []), key=lambda c: c.get("startFrame", 0)):
                    clips.append({"id": c.get("clipId"), "asset": c.get("assetId"), "start_frame": c.get("startFrame"),
                                  "in_frame": c.get("sourceInFrame"), "out_frame": c.get("sourceOutFrame"),
                                  "length_frames": c.get("durationFrames"),
                                  "speed": speed_of(c)})
                tracks.append({"track": f"{prefix}{n}", "clips": clips})
        return {"canvas": {"width": canvas.get("width"), "height": canvas.get("height"), "fps": canvas.get("fps")},
                "length_frames": ts.get("totalFrames"), "assets": assets, "tracks": tracks}

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

    def op_approve_host(self, a):
        # v0.2.0 allows a network computer only from its window (the desktop app, or the web shell's own route with
        # the shell key); no MCP tool can. Deferred to the judge batch that needs it (it decides how this adapter
        # reaches the user's route).
        raise OpError("unsupported", "approve_host: not in the v0.2.0 adapter yet (needs the editor window's route)")


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
        return {"id": rid, "ok": True, "result": fn(args)}
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
