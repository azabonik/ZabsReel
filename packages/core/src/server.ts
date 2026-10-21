import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createReadStream, open, stat, mkdir, writeFile } from "./io/gatedfs.js";
import { extname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { join } from "node:path";
import { EditorEngine } from "./engine.js";
import { dispatch, RpcError, methods } from "./rpc.js";
import { checkBinaries, NOT_MEDIA_TEXT } from "./ffmpeg/executor.js";
import { parseFramesQuery, streamFrames } from "./ffmpeg/frames.js";
import { NoAudioError, parsePeaksQuery, peaksFor } from "./media/peaks.js";
import type { Project } from "./types.js";

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".cube": "text/plain; charset=utf-8",
};

/**
 * CORS headers are emitted ONLY for requests that presented the valid session
 * token (plus OPTIONS preflight). A hostile webpage cannot read the token (it
 * lives in server.json on disk), so it can never receive a CORS-readable
 * response — while the Electron renderer (file:// origin) and dev-vite pages,
 * which DO hold the token, keep working. This replaces the old blanket
 * `Access-Control-Allow-Origin: *`.
 */
function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Aive-Token");
}

function sendJson(res: ServerResponse, status: number, body: unknown, withCors = true): void {
  if (withCors) cors(res);
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

/** How many files' "is it an HLS playlist?" answers /file keeps (by path, size and mtime). */
const PLAYLIST_CACHE_MAX = 256;
const playlistCache = new Map<string, boolean>();

/**
 * True when the file starts with `#EXTM3U` (after a UTF-8 BOM and white space,
 * any case): an HLS playlist. A browser's own HLS player (Chromium plays one
 * whatever the Content-Type) would fetch every segment it names, a network
 * path included, so /file never serves one. Reads at most 64 bytes, once per
 * path, size and mtime. A read error is thrown to the caller and not cached:
 * /file then refuses the file, because a stream opened after a failed check
 * could still serve a playlist.
 */
async function isHlsPlaylist(path: string, size: number, mtimeMs: number): Promise<boolean> {
  const key = `${size}:${mtimeMs}:${path}`;
  const known = playlistCache.get(key);
  if (known !== undefined) return known;
  let head: Buffer;
  const fh = await open(path, "r");
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(64), 0, 64, 0);
    head = buffer.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  const text = head.toString("latin1").replace(/^\xEF\xBB\xBF/, "").replace(/^[ \t\r\n\f\v]+/, "");
  const answer = text.slice(0, 7).toUpperCase() === "#EXTM3U";
  if (playlistCache.size >= PLAYLIST_CACHE_MAX) playlistCache.delete(playlistCache.keys().next().value!);
  playlistCache.set(key, answer);
  return answer;
}

/** The rpc error codes the body carries: G1e's network refusals (403), the graphics add-on's states and ZedMix's graphics renderer unavailable (409, with its reason). */
const FORWARDED_CODES: ReadonlyMap<string, number> = new Map([
  ["media_server_not_approved", 403],
  ["media_offline", 403],
  ["graphics_addon_missing", 409],
  ["graphics_addon_update", 409],
  ["graphics_addon_broken", 409],
  ["graphics_addon_unsupported", 409],
  ["graphic_renderer_unavailable", 409],
]);

/** The fields an rpc error carries besides its message: its code and, for G1e, its server(s) (rpc.ts). */
function errorFields(err: unknown): Record<string, unknown> {
  if (!(err instanceof RpcError) || !FORWARDED_CODES.has(err.code)) return {};
  return { code: err.code, ...err.details };
}

/** The 403 body of /file, /frames or /peaks (`what`) for a path it may not open. */
function forbidden(engine: EditorEngine, path: string, what: string): { ok: false; error: string } {
  if (engine.awaitsApproval(path)) {
    return { ok: false, error: `Forbidden: this file is on a network computer that is waiting for approval in the app; ${what} does not open it until the user allows it.` };
  }
  return { ok: false, error: what === "/file"
    ? "Forbidden: /file only serves files under the editor data dir or files belonging to imported assets. Import the media first (import_video), then stream the asset's own path."
    : `Forbidden: ${what} only ${what === "/frames" ? "decodes" : "reads"} files /file would serve.` };
}

/** The body of a /file, /frames or /peaks refusal: {@link forbidden}, or "File not found" for a 404. */
function refusal(engine: EditorEngine, path: string, what: string, status = 403): { ok: false; error: string } {
  return status === 404 ? { ok: false, error: "File not found" } : forbidden(engine, path, what);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The persistent local backend. Hosts the EditorEngine and exposes it over:
 *  - HTTP POST /rpc       — used by the MCP server (the AI).
 *  - WebSocket            — used by the desktop UI for live state + commands.
 *  - HTTP GET /frames     — decoded source frames (raw RGBA) for the live
 *    preview's temporal effects after a seek (ffmpeg/frames.ts).
 *  - HTTP GET /peaks      — an asset's waveform peaks (raw Float32, 4 bytes a
 *    bucket) for the timeline, computed by FFmpeg and cached (media/peaks.ts).
 *  - HTTP GET /file       — streams local media/preview files (Range-enabled);
 *    HEAD /file answers with the headers only (ETag = size + mtime, which the
 *    live preview uses to notice a .cube LUT rewritten in place)
 *                           so the UI can play previews.
 * One engine instance = one source of truth shared by AI and human.
 */
export class EditorServer {
  private readonly http = createServer((req, res) => this.handleHttp(req, res));
  private readonly wss = new WebSocketServer({ noServer: true });
  private clients = new Set<WebSocket>();
  private port = 0;
  /**
   * Per-run session token. Written to server.json (readable by local processes,
   * NOT by webpages) and required on every request: header `x-aive-token` for
   * HTTP, `?token=` for the WS upgrade and /file (media elements can't set
   * headers). Rotates on every core start.
   */
  private token = randomBytes(24).toString("base64url");

  constructor(
    readonly engine: EditorEngine,
    readonly options: { port?: number; dataDir: string } = { dataDir: process.cwd() },
  ) {
    this.http.on("upgrade", (req, socket, head) => {
      // WS upgrade auth: browsers can't set headers on WebSocket() so the token
      // rides the query string. Reject bad/missing tokens before the upgrade.
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
      if (!this.isAuthorized(req, url)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });

    // Broadcast engine changes + render progress + job updates to all UI clients.
    this.engine.on("change", (project) =>
      this.broadcast({
        type: "state",
        project,
        filePath: this.engine.getCurrentPath() ?? null,
        recovery: this.engine.recoveryInfo(),
        mediaServers: this.engine.mediaServers(),
      }),
    );
    // Only the network computers changed (an rpc request made one pending).
    this.engine.on("media-servers", (mediaServers) => this.broadcast({ type: "media-servers", mediaServers }));
    // add_graphic was refused for the graphics add-on: only its state (the UI offers the add-on dialog).
    this.engine.on("graphics-addon", ({ state }) => this.broadcast({ type: "graphics-addon", state }));
    this.engine.on("progress", (info) => this.broadcast({ type: "progress", ...info }));
    this.engine.on("job", (job) => this.broadcast({ type: "job", job }));
  }

  async start(): Promise<number> {
    // `port: 0` means "pick an ephemeral port"; omit it to use AIVE_PORT or 4791.
    const desired = this.options.port ?? (process.env.AIVE_PORT ? Number(process.env.AIVE_PORT) : 4791);
    await this.listen(desired);
    const addr = this.http.address();
    this.port = typeof addr === "object" && addr ? addr.port : desired;

    // Publish discovery info so the MCP bridge / UI can find this instance.
    await mkdir(this.options.dataDir, { recursive: true });
    await writeFile(
      join(this.options.dataDir, "server.json"),
      JSON.stringify({ port: this.port, pid: process.pid, startedAt: Date.now(), token: this.token }, null, 2),
      "utf8",
    );
    return this.port;
  }

  /**
   * Bind the desired port, retrying briefly on EADDRINUSE — the previous core
   * process (e.g. one we just replaced across a fast auto-update restart) can
   * hold the socket for a moment after exit even though it's already dead.
   * Without this, `listen()`'s "error" event has no handler and Node rethrows
   * it as an uncaught exception, crashing the process before it ever reports
   * ready (surfaced to the user as "Core exited before ready (code 1)").
   */
  private listen(port: number, attempt = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        this.http.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE" && attempt < 10) {
          setTimeout(() => this.listen(port, attempt + 1).then(resolve, reject), 300);
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        this.http.removeListener("error", onError);
        resolve();
      };
      this.http.once("error", onError);
      this.http.once("listening", onListening);
      this.http.listen(port, "127.0.0.1");
    });
  }

  getPort(): number {
    return this.port;
  }

  /** The session token local clients must present (also published in server.json). */
  getToken(): string {
    return this.token;
  }

  /** Constant-time-ish token check: header for HTTP, ?token= for WS//file. */
  private isAuthorized(req: IncomingMessage, url: URL): boolean {
    const presented = (req.headers["x-aive-token"] as string | undefined) ?? url.searchParams.get("token") ?? "";
    return presented.length > 0 && presented === this.token;
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) ws.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => {
      this.http.close(() => resolve());
      // close() drops only idle connections. One with a request still arriving or being answered would be
      // served on and kept alive, and would hold the callback (and so the core's exit) until its keep-alive timeout.
      this.http.closeAllConnections();
    });
  }

  // ---- WebSocket -------------------------------------------------------------
  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    ws.send(
      JSON.stringify({
        type: "state",
        project: this.engine.getProject(),
        filePath: this.engine.getCurrentPath() ?? null,
        recovery: this.engine.recoveryInfo(),
        mediaServers: this.engine.mediaServers(),
      }),
    );

    ws.on("message", async (data) => {
      let msg: { type?: string; id?: string; method?: string; params?: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
        return;
      }
      if (msg.type === "rpc" && msg.method) {
        try {
          const result = await dispatch(this.engine, msg.method, msg.params);
          ws.send(JSON.stringify({ type: "rpc_result", id: msg.id, ok: true, result }));
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: "rpc_result",
              id: msg.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              ...errorFields(err),
            }),
          );
        }
      }
    });

    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
  }

  private broadcast(message: { type: string } & Record<string, unknown>): void {
    const payload = JSON.stringify(message);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  // ---- HTTP ------------------------------------------------------------------
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const authed = this.isAuthorized(req, url);
    // CORS-readable responses only for token holders (see cors() above).
    const respond = (status: number, body: unknown) => sendJson(res, status, body, authed);

    if (req.method === "OPTIONS") {
      // Preflight carries no data; answer it so token-holding pages can follow
      // up with the real (authenticated) request.
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        // Tokenless liveness ping for local discovery — but internals (ffmpeg
        // banner, project revision) only for authenticated callers.
        if (!authed) {
          sendJson(res, 200, { ok: true, port: this.port }, false);
          return;
        }
        const bins = await checkBinaries().catch((e) => ({ error: String(e) }));
        respond(200, { ok: true, port: this.port, ffmpeg: bins, revision: this.engine.getProject().revision });
        return;
      }

      if (!authed) {
        respond(401, {
          ok: false,
          error:
            "Unauthorized: missing or invalid session token. Read `token` from <dataDir>/server.json and send it as the `x-aive-token` header (HTTP) or `?token=` query param (WebSocket / /file).",
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/state") {
        respond(200, {
          ok: true,
          result: this.engine.getProject() satisfies Project,
          recovery: this.engine.recoveryInfo(),
          mediaServers: this.engine.mediaServers(),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/methods") {
        const list = Object.entries(methods).map(([name, m]) => ({ name, description: m.description }));
        respond(200, { ok: true, methods: list });
        return;
      }

      if (req.method === "POST" && url.pathname === "/rpc") {
        const body = await readBody(req);
        let parsed: { method?: string; params?: unknown };
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          respond(400, { ok: false, error: "Invalid JSON body" });
          return;
        }
        if (!parsed.method) {
          respond(400, { ok: false, error: "Missing 'method'" });
          return;
        }
        try {
          const result = await dispatch(this.engine, parsed.method, parsed.params);
          respond(200, { ok: true, result });
        } catch (err) {
          // G1e: a server not allowed or offline media is a refusal (403), and no ready
          // graphics add-on a conflict with the add-on's state (409), not a server error.
          const fields = errorFields(err);
          const status = fields.code ? FORWARDED_CODES.get(fields.code as string)! : err instanceof RpcError && err.code !== "handler_error" ? 400 : 500;
          respond(status, { ok: false, error: err instanceof Error ? err.message : String(err), ...fields });
        }
        return;
      }

      if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/file") {
        await this.serveFile(url.searchParams.get("path"), req, res);
        return;
      }

      if (req.method === "GET" && url.pathname === "/frames") {
        // Decoded source frames for the live preview's trails / denoise (ffmpeg/frames.ts).
        const q = parseFramesQuery(url.searchParams);
        if (typeof q === "string") {
          respond(400, { ok: false, error: q });
          return;
        }
        const open = this.engine.servablePath(q.path);
        if ("status" in open) respond(open.status, refusal(this.engine, q.path, "/frames", open.status));
        else {
          cors(res);
          await streamFrames({ ...q, path: open.path }, res);
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/peaks") {
        await this.servePeaks(url.searchParams, res, respond);
        return;
      }

      respond(404, { ok: false, error: "Not found" });
    } catch (err) {
      respond(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Waveform peaks of a file /file would serve (media/peaks.ts). The path only
   * reaches FFmpeg as its -i input, after the same servablePath check (the
   * checked path is the one read), and no error body names it.
   */
  private async servePeaks(q: URLSearchParams, res: ServerResponse, respond: (status: number, body: unknown) => void): Promise<void> {
    const p = parsePeaksQuery(q);
    if (typeof p === "string") {
      respond(400, { ok: false, error: p });
      return;
    }
    const open = this.engine.servablePath(p.path);
    if ("status" in open) {
      respond(open.status, refusal(this.engine, p.path, "/peaks", open.status));
      return;
    }
    const path = open.path;
    let info;
    try {
      info = await stat(path);
    } catch {
      respond(404, { ok: false, error: "File not found" });
      return;
    }
    if (!info.isFile()) {
      respond(400, { ok: false, error: "Not a file" });
      return;
    }
    let body: Buffer;
    try {
      body = await peaksFor(path, p.buckets, this.options.dataDir);
    } catch (err) {
      if (err instanceof NoAudioError) respond(422, { ok: false, error: err.message });
      else respond(500, { ok: false, error: "Computing the peaks failed" });
      return;
    }
    cors(res);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length, "Cache-Control": "no-store" });
    res.end(body);
  }

  /**
   * Stream a local file with HTTP Range support (needed for video seeking).
   * Every stat and open uses the one path servablePath checked.
   */
  private async serveFile(raw: string | null, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!raw) {
      sendJson(res, 400, { ok: false, error: "Missing 'path'" });
      return;
    }
    const open = this.engine.servablePath(raw);
    if ("status" in open) {
      sendJson(res, open.status, refusal(this.engine, raw, "/file", open.status));
      return;
    }
    const path = open.path;
    let info;
    try {
      info = await stat(path);
    } catch {
      sendJson(res, 404, { ok: false, error: "File not found" });
      return;
    }
    if (!info.isFile()) {
      sendJson(res, 400, { ok: false, error: "Not a file" });
      return;
    }
    // Fail closed: when the head can't be read, nothing is streamed.
    let playlist: boolean;
    try {
      playlist = await isHlsPlaylist(path, info.size, info.mtimeMs);
    } catch {
      sendJson(res, 500, { ok: false, error: "Couldn't read the file" });
      return;
    }
    if (playlist) {
      sendJson(res, 415, { ok: false, error: NOT_MEDIA_TEXT });
      return;
    }

    cors(res);
    const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    const range = req.headers.range;
    const total = info.size;
    // A validator for the renderer (size + mtime): it re-reads a LUT whose ETag
    // changed. no-cache keeps any cache from serving the old bytes without asking;
    // the renderer is another origin, so the header must be exposed to be readable.
    res.setHeader("ETag", `W/"${total}-${Math.round(info.mtimeMs)}"`);
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Access-Control-Expose-Headers", "ETag, Content-Length, Content-Range");
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Length": total, "Content-Type": type, "Accept-Ranges": "bytes" });
      res.end();
      return;
    }

    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match && match[1] ? Number(match[1]) : 0;
      const end = match && match[2] ? Number(match[2]) : total - 1;
      if (start >= total || end >= total || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${total}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": type,
      });
      createReadStream(path, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Length": total, "Content-Type": type, "Accept-Ranges": "bytes" });
      createReadStream(path).pipe(res);
    }
  }
}
