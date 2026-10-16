import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { createServer, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { duplexPair } from "node:stream";

/**
 * A second guard on Remotion's /proxy route, independent of remotionload.ts
 * and of any Remotion internals.
 *
 * Remotion's own HTTP server (the one renderMedia starts on the port
 * renderGraphic gives it) answers /proxy?src=… for any page that asks, the
 * graphic's own TSX included, and hands the source to its compositor.
 * ZabsReel's graphics never use that route (refuseDownload refuses every
 * source), so while a render runs, every request on that port whose path is
 * /proxy is rewritten to {@link REFUSED} before Remotion's handler sees it.
 *
 * Why diagnostics_channel "http.server.request.start": Node publishes it for
 * every request a node:http server parses, before the server's "request"
 * handler runs. That includes a WebSocket Upgrade, which Node hands to the
 * "request" handler when the server has no "upgrade" listener (Remotion's
 * has none), and an Expect: 100-continue. It wraps nothing (a patched
 * http.Server.prototype.emit would sit on every server in the process), and
 * it is scoped to Remotion's port, so the core's own server and any other
 * server are never touched. Node's docs mark the channel Experimental, so
 * {@link proxyGuardWorks} checks once per process that it still rewrites a
 * request before the handler; renderGraphic refuses otherwise.
 *
 * Remotion closes its server after renderMedia settles, without awaiting it,
 * so renderGraphic holds the guard for the browser's whole life and gives it
 * up through {@link releaseWhenClosed}: only once the port refuses connections.
 */

const CHANNEL = "http.server.request.start";
/** A path Remotion's file handler can't decode: it answers 400 and looks up no file. */
const REFUSED = "/%zabsreel-refused-proxy";
/** The guarded ports, with how many renders hold each. */
const ports = new Map<number, number>();

/** Remotion's /proxy route: its own test (the raw URL starts with /proxy), or the path once parsed. */
function isProxy(url: string): boolean {
  if (url.startsWith("/proxy")) return true;
  try {
    return new URL(url, "http://localhost").pathname.startsWith("/proxy");
  } catch {
    return false;
  }
}

function onRequestStart(message: unknown): void {
  const { request, socket } = message as { request: IncomingMessage; socket: Socket };
  if (ports.has(socket.localPort ?? -1) && isProxy(request.url ?? "")) request.url = REFUSED;
}

/** Refuse /proxy on `port` until the returned function is called. */
export function guardRemotionProxy(port: number): () => void {
  if (ports.size === 0) subscribe(CHANNEL, onRequestStart);
  ports.set(port, (ports.get(port) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (ports.get(port) ?? 1) - 1;
    if (left > 0) ports.set(port, left);
    else ports.delete(port);
    if (ports.size === 0) unsubscribe(CHANNEL, onRequestStart);
  };
}

/** How long {@link releaseWhenClosed} waits for the port to close before it returns. */
const CLOSE_WAIT_MS = 3000;
/** How often {@link releaseWhenClosed}'s background check looks at the port. */
const POLL_MS = 250;
/** How long {@link releaseWhenClosed}'s background check keeps looking before it stops. */
const POLL_CAP_MS = 10 * 60_000;

/** The background check of {@link releaseWhenClosed}: its interval and how long it runs (tests shorten them). */
export interface ClosePolling {
  pollMs?: number;
  capMs?: number;
}
/** `ms` later; an unref'd wait does not keep the process alive. */
const sleep = (ms: number, unref = false) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (unref) t.unref();
  });

/**
 * True when a server on this machine accepts a connection on `port` (IPv4 or
 * IPv6 loopback). A listening socket completes a loopback connection in the
 * kernel at once, so an error or no answer within 500 ms means none listens
 * there (some setups, WSL's mirrored loopback for one, never answer a
 * connection to a closed port).
 */
async function listening(port: number): Promise<boolean> {
  const accepts = (host: string) =>
    new Promise<boolean>((resolve) => {
      const s = connect({ host, port });
      const done = (open: boolean) => (s.destroy(), resolve(open));
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
      s.setTimeout(500, () => done(false));
    });
  return (await Promise.all(["127.0.0.1", "::1"].map(accepts))).includes(true);
}

/**
 * Call `release` (the guard on `port`) once nothing accepts connections on
 * the port. Waits up to `waitMs`; if the port is still open then, returns and
 * keeps the guard until the port closes, checked in the background every
 * `polling.pollMs` (250 ms). The background check stops after
 * `polling.capMs` (10 minutes): a port still open then (another listener
 * took it after Remotion's server closed, or one on the other loopback
 * address) keeps the guard for the life of the process, so it fails closed
 * and leaves no poll running.
 */
export async function releaseWhenClosed(port: number, release: () => void, waitMs = CLOSE_WAIT_MS, polling: ClosePolling = {}): Promise<void> {
  const { pollMs = POLL_MS, capMs = POLL_CAP_MS } = polling;
  const deadline = Date.now() + waitMs;
  while (await listening(port)) {
    if (Date.now() >= deadline) {
      const stop = Date.now() + capMs;
      void (async () => {
        while (await listening(port)) {
          if (Date.now() >= stop) return; // the guard stays on
          await sleep(pollMs, true);
        }
        release();
      })();
      return;
    }
    await sleep(50);
  }
  release();
}

let works: Promise<boolean> | undefined;

/**
 * Once per process: a GET /proxy through the guard reaches a node:http
 * server's handler rewritten. It opens no port: the request comes over an
 * in-memory stream whose localPort is 0, which no real socket has.
 */
export function proxyGuardWorks(): Promise<boolean> {
  return (works ??= probe().catch(() => false));
}

async function probe(): Promise<boolean> {
  const [client, side] = duplexPair();
  Object.assign(side, { localPort: 0 });
  const server = createServer();
  const release = guardRemotionProxy(0);
  try {
    const seen = new Promise<string | undefined>((resolve) => {
      server.on("request", (req: IncomingMessage, res) => (resolve(req.url), res.end()));
      setTimeout(() => resolve(undefined), 2000).unref();
    });
    server.emit("connection", side);
    client.write("GET /proxy?src=probe HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    return (await seen) === REFUSED;
  } finally {
    release();
    client.destroy();
    side.destroy();
  }
}
