import type { JobInfo, MediaServers, Project } from "./types";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** An rpc refusal's fields besides its message (core G1e): media_server_not_approved or media_offline. */
export type RpcRefusal = Error & { code?: string; host?: string; hosts?: string[]; outside?: boolean; unread?: boolean };

/**
 * Client for the editor core. Holds a live WebSocket for state + job
 * broadcasts and issues RPC commands over the same socket. Auto-reconnects so
 * the UI survives a core restart. The same RPC methods the AI uses are
 * available here, so manual UI edits and AI edits share one engine.
 */
export class CoreApi {
  private ws: WebSocket | null = null;
  private readonly base: string;
  private readonly wsUrl: string;
  private reqId = 0;
  private readonly pending = new Map<number, Pending>();
  private stateCb?: (p: Project, filePath: string | null) => void;
  private jobCb?: (j: JobInfo) => void;
  private statusCb?: (connected: boolean) => void;
  private serversCb?: (s: MediaServers) => void;
  private closed = false;
  private attempts = 0;
  // The socket can open — and deliver the first state — before React's effects
  // subscribe (a production bundle on a fast local server usually wins that
  // race), so the latest status and state are kept and replayed to late
  // subscribers instead of being dropped.
  private connected = false;
  private lastState: { project: Project; filePath: string | null } | null = null;
  private lastServers: MediaServers | null = null;
  /** Absolute .aive path of the open project, or null if never saved. */
  filePath: string | null = null;

  constructor(
    readonly port: number,
    /** Session token from the core's server.json (required on every request). */
    readonly token: string = "",
  ) {
    this.base = `http://127.0.0.1:${port}`;
    // WebSocket() can't set headers, so the token rides the query string.
    this.wsUrl = `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
  }

  onState(cb: (p: Project, filePath: string | null) => void): void {
    this.stateCb = cb;
    if (this.lastState) cb(this.lastState.project, this.lastState.filePath);
  }
  /** The network computers (list_media_servers): with every state, and on their own when only they change. */
  onMediaServers(cb: (s: MediaServers) => void): void {
    this.serversCb = cb;
    if (this.lastServers) cb(this.lastServers);
  }
  /** Every job change (start, progress, done, error, canceled); undefined unsubscribes. */
  onJob(cb: ((j: JobInfo) => void) | undefined): void {
    this.jobCb = cb;
  }
  onStatus(cb: (connected: boolean) => void): void {
    this.statusCb = cb;
    if (this.connected) cb(true);
  }

  connect(): void {
    this.closed = false;
    // No session key: the server would answer every upgrade with 401, so there
    // is nothing to retry. The UI keeps showing "not connected".
    if (!this.token) {
      this.statusCb?.(false);
      return;
    }
    this.open();
  }

  /**
   * Browsers hide the 401 on a rejected WebSocket upgrade (the close is just
   * 1006), so tell "server rejects our key" from "server is briefly away" by
   * probing /health: an authenticated reply is CORS-readable, an
   * unauthenticated one is not, while a no-cors request still succeeds as long
   * as something is listening.
   */
  private async authRejected(): Promise<boolean> {
    try {
      const ok = await fetch(`${this.base}/health`, { headers: { "x-aive-token": this.token } });
      if (ok.ok) return false;
    } catch { /* unreadable (bad key) or unreachable — decide below */ }
    try {
      await fetch(`${this.base}/health`, { mode: "no-cors" });
      return true; // reachable, but our token did not authenticate
    } catch {
      return false; // nothing listening: transient, keep retrying
    }
  }

  private open(): void {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.attempts = 0;
      this.connected = true;
      this.statusCb?.(true);
    };

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      switch (msg.type) {
        case "state":
          this.filePath = (msg.filePath as string | null) ?? null;
          this.lastState = { project: msg.project as Project, filePath: this.filePath };
          this.stateCb?.(msg.project as Project, this.filePath);
          if (msg.mediaServers) this.servers(msg.mediaServers as MediaServers);
          break;
        case "media-servers":
          this.servers(msg.mediaServers as MediaServers);
          break;
        case "job":
          this.jobCb?.(msg.job as JobInfo);
          break;
        case "rpc_result": {
          const p = this.pending.get(msg.id as number);
          if (!p) break;
          this.pending.delete(msg.id as number);
          if (msg.ok) p.resolve(msg.result);
          else {
            const { code, host, hosts, outside, unread } = msg as Partial<RpcRefusal>;
            p.reject(Object.assign(new Error((msg.error as string) || "RPC failed"), { code, host, hosts, outside, unread }));
          }
          break;
        }
      }
    };

    ws.onclose = () => {
      this.connected = false;
      this.statusCb?.(false);
      if (this.closed) return;
      const retry = () => {
        // Back off 1s, 2s, 4s ... 15s while the core is away.
        const delay = Math.min(15000, 1000 * 2 ** Math.min(this.attempts++, 4));
        setTimeout(() => { if (!this.closed) this.open(); }, delay);
      };
      if (opened) { this.attempts = 0; retry(); return; }
      // Never opened: maybe the core rejected our key. Stop if so.
      void this.authRejected().then((rejected) => { if (!rejected) retry(); });
    };
    ws.onerror = () => ws.close();
  }

  private servers(s: MediaServers): void {
    this.lastServers = s;
    this.serversCb?.(s);
  }

  /** Send an RPC command to the engine and await its result. */
  rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected to the editor core"));
        return;
      }
      const id = ++this.reqId;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ type: "rpc", id, method, params }));
    });
  }

  /** Build a URL the <video>/<img> tags can use to stream a local file. */
  fileUrl(path: string): string {
    return `${this.base}/file?path=${encodeURIComponent(path)}&token=${encodeURIComponent(this.token)}`;
  }

  get httpBase(): string {
    return this.base;
  }
}
