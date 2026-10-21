"""The judge's client for an editor adapter (judge/PROTOCOL.md): product-level operations, one method each.

Tests call these methods and never name an editor's own tools, routes or files. The adapter is a separate process
(any language) that speaks the JSON-lines protocol on stdin/stdout; this module starts it, sends one request at a time
and turns error responses into exceptions:

    ProductError   the editor answered with an error or a refusal (.product_code: its machine code, or None)
    Unsupported    the adapter does not implement the operation (a test that needs it fails)
    BadRequest     the arguments do not fit the operation
    AdapterError   the adapter failed, exited, or did not answer in time

Python 3 standard library only.
"""
import base64
import json
import os
import queue
import subprocess
import threading

PROTOCOL = 1               # T.driver() fails the test when the adapter's hello names another version
DEFAULT_TIMEOUT = 600      # seconds per request (PROTOCOL.md, "Timeouts")
EXPORT_TIMEOUT = 1800
POKE_TIMEOUT = 1800         # poke_agent_tools calls every agent tool


class JudgeError(Exception):
    """An error response from the adapter (or a failed exchange)."""

    code = "adapter_error"

    def __init__(self, message, product_code=None, op=None):
        super().__init__(message)
        self.message = message
        self.product_code = product_code
        self.op = op

    def __str__(self):
        pc = f" [{self.product_code}]" if self.product_code else ""
        return f"{self.op or '?'}: {self.code}{pc}: {self.message}"


class ProductError(JudgeError):
    code = "product_error"


class Unsupported(JudgeError):
    code = "unsupported"


class BadRequest(JudgeError):
    code = "bad_request"


class AdapterError(JudgeError):
    code = "adapter_error"


ERRORS = {c.code: c for c in (ProductError, Unsupported, BadRequest, AdapterError)}


def path_arg(path):
    """A path argument as the driver sends it: an absolute path unchanged (not normalized, so a test can send a '..'
    spelling), a relative one made absolute against the current folder. Tests that send a string that is not a
    local path on purpose (a URL, a network path, a relative path) pass it through the method's `raw` argument."""
    return path if os.path.isabs(path) else os.path.abspath(path)


class Driver:
    """One adapter process for one test. Driver(cmd, scratch).start(build) ... .stop() / .close()."""

    def __init__(self, cmd, scratch, stderr_path=None, env=None):
        """cmd: the adapter command (argv list). scratch: the test's empty scratch folder (absolute).

        The adapter runs with its current folder set to `scratch`, and JUDGE_TEST_SCRATCH=<scratch> in its
        environment: the runner's sweep ends any process left whose environment names the scratch folder, so a
        helper the adapter leaves running is found even when it carries none of the editor's sandbox variables. It
        inherits no file descriptor but stdin, stdout and stderr (close_fds), so it cannot reach the test's result
        pipe."""
        self.cmd = list(cmd)
        self.scratch = os.path.abspath(scratch)
        self.stderr_path = stderr_path or os.path.join(self.scratch, "adapter.stderr")
        self._err = open(self.stderr_path, "ab")
        env = dict(env if env is not None else os.environ)
        env["JUDGE_TEST_SCRATCH"] = os.path.realpath(self.scratch)
        self.p = subprocess.Popen(self.cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._err,
                                  env=env, cwd=self.scratch, close_fds=True)
        self._lines = queue.Queue()
        self._n = 0
        self.started = False
        self.ports = []
        self.product = None
        threading.Thread(target=self._read, daemon=True).start()

    # ------------------------------------------------------------ transport
    def _read(self):
        for raw in self.p.stdout:
            self._lines.put(raw)
        self._lines.put(None)

    def request(self, op, args=None, timeout=DEFAULT_TIMEOUT):
        """Sends one request and returns its result; raises a JudgeError subclass on an error response."""
        self._n += 1
        rid = self._n
        line = json.dumps({"id": rid, "op": op, "args": args or {}}) + "\n"
        try:
            self.p.stdin.write(line.encode("utf-8"))
            self.p.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            raise AdapterError(f"adapter is not running ({e})", op=op)
        while True:
            try:
                raw = self._lines.get(timeout=timeout)
            except queue.Empty:
                raise AdapterError(f"no answer in {timeout} s", op=op)
            if raw is None:
                raise AdapterError(f"adapter exited (code {self.p.poll()}); see {self.stderr_path}", op=op)
            try:
                msg = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise AdapterError(f"adapter wrote a line that is not JSON: {raw[:200]!r}", op=op)
            if not isinstance(msg, dict) or msg.get("id") != rid:
                raise AdapterError(f"answer for another request: {raw[:200]!r}", op=op)
            if msg.get("ok") is True:
                result = msg.get("result")
                # Any result may name TCP ports the editor started listening on during the operation (PROTOCOL.md,
                # "Ports"): the runner checks those are closed after stop too.
                if op != "start" and isinstance(result, dict) and isinstance(result.get("ports"), list):
                    self.ports += [p for p in result["ports"] if isinstance(p, int) and p not in self.ports]
                return result
            err = msg.get("error") or {}
            cls = ERRORS.get(err.get("code"), AdapterError)
            raise cls(str(err.get("message", "no message")), err.get("product_code"), op=op)

    def close(self, wait=30):
        """Closes stdin (the adapter then stops what it started and exits); kills the adapter after `wait` s."""
        try:
            self.p.stdin.close()
        except OSError:
            pass
        try:
            self.p.wait(wait)
        except subprocess.TimeoutExpired:
            self.p.kill()
            self.p.wait(10)
        self._err.close()

    # ------------------------------------------------------------ lifecycle
    def hello(self):
        """-> {"protocol": int, "adapter": str, "ops": [str]}: what the adapter implements."""
        return self.request("hello", {}, timeout=60)

    def start(self, build):
        """Starts the editor from `build` (a checkout or build folder) in this test's scratch folder.
        -> {"product": {"name", "version"}, "ports": [int]}"""
        r = self.request("start", {"build": os.path.abspath(build), "scratch": self.scratch}, timeout=300)
        self.started = True
        self.ports = list(r.get("ports") or [])
        self.product = r.get("product")
        return r

    def stop(self):
        """Stops the editor and every process the adapter started."""
        r = self.request("stop", {}, timeout=120)
        self.started = False
        return r

    # ------------------------------------------------------------ media and timeline
    def import_media(self, path, raw=False):
        """Imports a media file. -> asset id (str)"""
        return self.request("import_media", {"path": path if raw else path_arg(path)})["asset"]

    def place_clip(self, asset, track="v0", start_frame=0, in_frame=0, out_frame=None):
        """Places source frames [in_frame, out_frame) of `asset` at `start_frame` on `track` ("v0" = the base video
        track). out_frame None (not sent) = to the end of the source. -> clip id (str)"""
        args = {"asset": asset, "track": track, "start_frame": int(start_frame), "in_frame": int(in_frame)}
        if out_frame is not None:
            args["out_frame"] = int(out_frame)
        return self.request("place_clip", args)["clip"]

    def trim_clip(self, clip, in_frame=None, out_frame=None):
        """Sets the clip's source range; its start position on the timeline does not change."""
        args = {"clip": clip}
        if in_frame is not None:
            args["in_frame"] = int(in_frame)
        if out_frame is not None:
            args["out_frame"] = int(out_frame)
        return self.request("trim_clip", args)

    def move_clip(self, clip, start_frame, track=None):
        """Moves the clip to `start_frame` (and to `track` when given)."""
        args = {"clip": clip, "start_frame": int(start_frame)}
        if track is not None:
            args["track"] = track
        return self.request("move_clip", args)

    def split_clip(self, clip, at_frame):
        """Splits the clip `at_frame` frames after its start. -> [left id, right id]"""
        return self.request("split_clip", {"clip": clip, "at_frame": int(at_frame)})["clips"]

    def remove_clip(self, clip):
        """Removes the clip from the timeline."""
        return self.request("remove_clip", {"clip": clip})

    def set_speed(self, clip, speed):
        """Sets a constant playback speed (1 = normal)."""
        return self.request("set_speed", {"clip": clip, "speed": float(speed)})

    def apply_effect(self, clip, effect, amount=None, params=None):
        """Adds a visual effect (by product-level name, e.g. "blur", "grayscale"). -> effect id or None"""
        args = {"clip": clip, "effect": effect}
        if amount is not None:
            args["amount"] = amount
        if params is not None:
            args["params"] = params
        return self.request("apply_effect", args).get("effect")

    def apply_colour(self, clip, **grade):
        """Colour grade: brightness, contrast, saturation, gamma, temperature, tint, hue (PROTOCOL.md)."""
        return self.request("apply_colour", {"clip": clip, **grade})

    def set_project(self, width=None, height=None, fps=None):
        """Sets the output canvas (any of width, height, fps)."""
        args = {k: v for k, v in (("width", width), ("height", height), ("fps", fps)) if v is not None}
        return self.request("set_project", args)

    def undo(self):
        """Undoes the last edit."""
        return self.request("undo", {})

    def redo(self):
        """Redoes the last undone edit."""
        return self.request("redo", {})

    def get_state(self):
        """-> State: {"canvas": {width, height, fps}, "length_frames", "assets": [{id, path, offline}],
        "tracks": [{"track": "v0", "clips": [{id, asset, start_frame, in_frame, out_frame, length_frames, speed}]}]}"""
        return self.request("get_state", {})

    def clips(self, track="v0"):
        """The clips on `track`, from get_state."""
        for t in self.get_state().get("tracks", []):
            if t.get("track") == track:
                return t.get("clips", [])
        return []

    # ------------------------------------------------------------ output and jobs
    def export(self, path, wait=True, timeout=EXPORT_TIMEOUT, raw=False):
        """Exports the timeline to `path`. -> Job {"job", "status", "path", "error", "fraction"}"""
        return self.request("export", {"path": path if raw else path_arg(path), "wait": bool(wait)}, timeout=timeout)

    def jobs(self):
        """-> [Job]"""
        return self.request("jobs", {})["jobs"]

    def cancel(self, job):
        """Cancels a running job. -> bool (whether it was canceled)"""
        return bool(self.request("cancel", {"job": job}).get("canceled"))

    def render_frame(self, time, path):
        """Renders the composited frame at `time` seconds as a PNG at `path`. -> path"""
        return self.request("render_frame", {"time": float(time), "path": path_arg(path)})["path"]

    # ------------------------------------------------------------ projects and interchange
    def save_project(self, path, raw=False):
        """Saves the project as `path`."""
        return self.request("save_project", {"path": path if raw else path_arg(path)})

    def load_project(self, path, raw=False):
        """Opens the project at `path`. -> {"notice": str or None}"""
        return self.request("load_project", {"path": path if raw else path_arg(path)})

    def export_otio(self, path, raw=False):
        """Writes the timeline as an OpenTimelineIO file."""
        return self.request("export_otio", {"path": path if raw else path_arg(path)})

    def import_otio(self, path, raw=False):
        """Opens an OpenTimelineIO file as the project. -> {"missing": [path]}"""
        return self.request("import_otio", {"path": path if raw else path_arg(path)})

    # ------------------------------------------------------------ file surface and network computers
    def http_get(self, route, query=None):
        """GET on the editor's file surface (PROTOCOL.md, http_get). -> {"status", "content_type", "body_length",
        "body_sha256", "body" (bytes, at most the first 256 KiB), "truncated"}"""
        r = dict(self.request("http_get", {"route": route, "query": query or {}}))
        r["body"] = base64.b64decode(r.pop("body_b64", "") or "")
        return r

    def list_hosts(self):
        """-> {"approved": [host], "pending": [host], "outside": [host]}"""
        return self.request("list_hosts", {})

    def approve_host(self, host):
        """Allows media from network computer `host`, as the user does in the editor's window."""
        return self.request("approve_host", {"host": host})

    def revoke_host(self, host, only_if_outside=False):
        """Removes network computer `host` from the allowed ones, as the user does in the editor's window.
        only_if_outside: only when it is still an entry added outside the editor (the Remove of a Keep question).
        -> bool: whether an entry was removed"""
        args = {"host": host}
        if only_if_outside:
            args["only_if_outside"] = True
        return bool(self.request("revoke_host", args).get("removed"))

    def add_host_outside(self, host, forged=False):
        """Adds `host` to the editor's allowed computers by editing its files, not through its window (what another
        program or agent with file access could do). forged: the entry claims an approval it never had.
        -> {"files": [the editor's files that hold the allowed computers and their secret], "secrets": [str]}"""
        return self.request("add_host_outside", {"host": host, "forged": bool(forged)})

    def recheck_media(self):
        """The editor re-reads its allowed computers and re-checks offline media."""
        return self.request("recheck_media", {})

    # ------------------------------------------------------------ text, colour, proxies
    def add_text(self, clip, text, **style):
        """Adds a text overlay to the clip; style fields (PROTOCOL.md, add_text) are passed on unchanged. -> text id"""
        return self.request("add_text", {"clip": clip, "text": text, "style": style})["text"]

    def apply_lut(self, clip, path, raw=False):
        """Applies the colour look-up table (.cube) at `path` to the clip."""
        return self.request("apply_lut", {"clip": clip, "path": path if raw else path_arg(path)})

    def make_proxy(self, asset):
        """Makes the editor's lower-resolution working copy of the asset."""
        return self.request("make_proxy", {"asset": asset})

    def thumbnail(self, asset, time=0.0):
        """Makes a still image of the asset at `time` s. -> its path (where the editor put it), or None"""
        return self.request("thumbnail", {"asset": asset, "time": float(time)}).get("path")

    # ------------------------------------------------------------ what an AI agent sees
    def agent_tools(self):
        """-> {"tools": [{"name", "read_only"}], "instructions": str}: what the editor offers an AI agent."""
        return self.request("agent_tools", {})

    def poke_agent_tools(self):
        """Calls every agent tool once with empty arguments. -> {"called": int, "refused": int}"""
        return self.request("poke_agent_tools", {}, timeout=POKE_TIMEOUT)

    def transcript(self):
        """-> [str]: every text the editor answered through this adapter since start (results, errors, HTTP bodies)."""
        return self.request("transcript", {})["texts"]
