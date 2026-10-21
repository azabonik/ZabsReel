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
        names, _ = self.tracks()
        if name not in names:
            raise bad(f"no track {name!r} (tracks: {sorted(names)})")
        return names[name]

    @staticmethod
    def need(args, *keys):
        for k in keys:
            if k not in args:
                raise bad(f"missing {k!r}")

    # ------------------------------------------------------------ lifecycle
    def op_hello(self, a):
        ops = sorted(n[3:] for n in dir(self) if n.startswith("op_") and n not in ("op_approve_host",))
        return {"protocol": PROTOCOL, "adapter": ADAPTER, "ops": ops}

    def op_start(self, a):
        self.need(a, "build", "scratch")
        if self.mcp is not None:
            raise bad("already started")
        build, scratch = os.path.realpath(a["build"]), os.path.realpath(a["scratch"])
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
        self.need(a, "path")
        j = self.call("import_video", {"path": a["path"]})
        aid = find_key(j.get("asset") or j, ["id", "assetId"])
        if not aid:
            raise OpError("adapter_error", f"import_video returned no asset id: {json.dumps(j)[:300]}")
        return {"asset": aid}

    def op_place_clip(self, a):
        self.need(a, "asset", "start_frame", "in_frame")
        args = {"assetId": a["asset"], "trackIndex": self.track_index(a.get("track", "v0")),
                "startFrame": int(a["start_frame"]), "sourceInFrame": int(a["in_frame"])}
        if a.get("out_frame") is not None:
            args["sourceOutFrame"] = int(a["out_frame"])
        j = self.call("add_clip", args)
        cid = find_key(j.get("clip") or j, ["id", "clipId"])
        if not cid:
            raise OpError("adapter_error", f"add_clip returned no clip id: {json.dumps(j)[:300]}")
        return {"clip": cid}

    def op_trim_clip(self, a):
        self.need(a, "clip")
        args = {"clipId": a["clip"]}
        if a.get("in_frame") is not None:
            args["sourceInFrame"] = int(a["in_frame"])
        if a.get("out_frame") is not None:
            args["sourceOutFrame"] = int(a["out_frame"])
        self.call("trim_clip", args)
        return {}

    def op_move_clip(self, a):
        self.need(a, "clip", "start_frame")
        args = {"clipId": a["clip"], "startFrame": int(a["start_frame"])}
        if a.get("track") is not None:
            args["trackIndex"] = self.track_index(a["track"])
        self.call("move_clip", args)
        return {}

    def op_split_clip(self, a):
        self.need(a, "clip", "at_frame")
        j = self.call("split_clip", {"clipId": a["clip"], "atFrame": int(a["at_frame"])})
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
        self.need(a, "clip")
        self.call("remove_clip", {"clipId": a["clip"]})
        return {}

    def op_set_speed(self, a):
        self.need(a, "clip", "speed")
        self.call("set_clip_speed", {"clipId": a["clip"], "speed": float(a["speed"])})
        return {}

    def op_apply_effect(self, a):
        self.need(a, "clip", "effect")
        args = {"clipId": a["clip"], "type": a["effect"]}
        if a.get("amount") is not None:
            args["amount"] = a["amount"]
        if a.get("params") is not None:
            args["params"] = a["params"]
        j = self.call("apply_effect", args)
        return {"effect": find_key(j, ["effectId"]) or find_key(j.get("effect"), ["id"])}

    def op_apply_colour(self, a):
        self.need(a, "clip")
        grade = {k: a[k] for k in ("brightness", "contrast", "saturation", "gamma") if a.get(k) is not None}
        colour = {k: a[k] for k in ("temperature", "tint", "hue") if a.get(k) is not None}
        if not grade and not colour:
            raise bad("no colour field given")
        if grade:
            self.call("color_grade", {"clipId": a["clip"], **grade})
        if colour:
            self.call("apply_color", {"clipId": a["clip"], **colour})
        return {}

    def op_set_project(self, a):
        args = {k: a[k] for k in ("width", "height", "fps") if a.get(k) is not None}
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
        self.need(a, "path")
        wait = a.get("wait", True)
        j = self.call("export_video", {"outputPath": a["path"], **({} if wait else {"background": True})})
        job = self.job_of(j)
        if wait:
            job["status"] = "done" if os.path.isfile(a["path"]) else "error"
            job["path"] = job["path"] or a["path"]
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
        self.need(a, "job")
        j = self.call("cancel_job", {"jobId": a["job"]})
        return {"canceled": bool(j.get("canceled"))}

    def op_render_frame(self, a):
        self.need(a, "time", "path")
        j = self.call("get_frame", {"atSeconds": float(a["time"])})
        img = next((c for c in j.get("_content", []) if c.get("type") == "image"), None)
        if img is None:
            raise OpError("adapter_error", "get_frame returned no image")
        with open(a["path"], "wb") as f:
            f.write(base64.b64decode(img["data"]))
        return {"path": a["path"]}

    # ------------------------------------------------------------ projects and interchange
    def op_save_project(self, a):
        self.need(a, "path")
        self.call("save_project", {"path": a["path"]})
        return {}

    def op_load_project(self, a):
        self.need(a, "path")
        j = self.call("load_project", {"path": a["path"]})
        return {"notice": j.get("notice")}

    def op_export_otio(self, a):
        self.need(a, "path")
        self.call("export_otio", {"path": a["path"]})
        return {}

    def op_import_otio(self, a):
        self.need(a, "path")
        j = self.call("import_otio", {"path": a["path"]})
        return {"missing": [m if isinstance(m, str) else find_key(m, ["path"]) for m in (j.get("missing") or [])]}

    # ------------------------------------------------------------ file surface and network computers
    def op_http_get(self, a):
        self.need(a, "route")
        route = a["route"]
        if not isinstance(route, str) or not route.startswith("/") or any(ch in route for ch in "?#"):
            raise bad(f"route must be a path such as /file, got {route!r}")
        if self.token is None:
            raise OpError("adapter_error", "the editor is not started")
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


def main():
    ad = Adapter()
    out = sys.stdout
    try:
        for raw in sys.stdin:
            raw = raw.strip()
            if not raw:
                continue
            rid = None
            try:
                req = json.loads(raw)
                rid = req.get("id")
                op, args = req.get("op"), req.get("args") or {}
                fn = getattr(ad, f"op_{op}", None) if isinstance(op, str) and re.fullmatch(r"[a-z_]+", op) else None
                if fn is None:
                    raise OpError("unsupported", f"unknown operation {op!r}")
                if not isinstance(args, dict):
                    raise bad("args must be an object")
                resp = {"id": rid, "ok": True, "result": fn(args)}
            except OpError as e:
                err = {"code": e.code, "message": e.message}
                if e.product_code:
                    err["product_code"] = e.product_code
                resp = {"id": rid, "ok": False, "error": err}
            except (ValueError, TypeError, KeyError) as e:
                resp = {"id": rid, "ok": False, "error": {"code": "bad_request", "message": repr(e)}}
            except Exception as e:  # noqa: BLE001
                log("internal error:", repr(e))
                resp = {"id": rid, "ok": False, "error": {"code": "adapter_error", "message": repr(e)}}
            out.write(json.dumps(resp) + "\n")
            out.flush()
    finally:
        try:
            ad.op_stop({})
        except Exception as e:  # noqa: BLE001
            log("stop on exit failed:", repr(e))


if __name__ == "__main__":
    main()
