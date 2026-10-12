// Web-shell smoke: starts web/server.cjs (which launches its own core in a temp
// data dir on an ephemeral port), then checks the renderer is served, the
// security guards hold (Host check, token on /api, no path traversal, no
// framing), the picker's directory listing is right, a path from that listing
// imports and streams through the core, and stopping the shell stops the core
// it started. Needs the project built (`npm run build`) and FFmpeg on PATH.
//
// Run:  npx tsx apps/desktop/scripts/smoke-web.ts

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };
function request(port: number, path: string, opts: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: opts.method ?? "GET",
        headers: { host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
const json = (r: Res) => JSON.parse(r.body || "{}");

async function main() {
  const root = mkdtempSync(join(tmpdir(), "aive-web-smoke-"));
  const dataDir = join(root, "data");
  const mediaDir = join(root, "media");
  mkdirSync(join(mediaDir, "sub"), { recursive: true });
  writeFileSync(join(mediaDir, ".hidden"), "x");
  const clip = join(mediaDir, "clip.mp4");
  const ff = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=1", "-pix_fmt", "yuv420p", clip]);
  if (ff.status !== 0) {
    console.error("ffmpeg could not generate the test clip — is FFmpeg on PATH?");
    process.exit(1);
  }

  // apps/desktop is CommonJS (no "type": "module"), so tsx runs this as CJS.
  const serverPath = join(__dirname, "..", "web", "server.cjs");
  const shell = spawn(process.execPath, [serverPath, "--port", "0", "--no-open"], {
    env: { ...process.env, AIVE_DATA_DIR: dataDir, AIVE_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  shell.stderr.on("data", (d) => { if (process.env.SMOKE_VERBOSE) process.stderr.write(d); });
  const shellExit = new Promise<number | null>((resolve) => shell.on("exit", (code) => resolve(code)));

  const ready = await new Promise<{ url: string; port: number; corePort: number; coreOwned: boolean }>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("web shell did not report ready within 30s")), 30000);
    shell.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      for (const line of buf.split("\n")) {
        try {
          const msg = JSON.parse(line);
          if (msg.event === "ready") { clearTimeout(timer); resolve(msg); }
        } catch { /* partial or non-JSON line */ }
      }
    });
    shell.on("exit", (code) => { clearTimeout(timer); reject(new Error(`web shell exited early (code ${code})`)); });
  });
  const { port, corePort } = ready;
  const token = new URL(ready.url).searchParams.get("token") ?? "";
  const auth = { "x-aive-token": token };
  console.log(`web shell on :${port}, core on :${corePort}`);

  try {
    console.log("1. renderer");
    const index = await request(port, "/");
    check("GET / serves index.html", index.status === 200 && /text\/html/.test(String(index.headers["content-type"])) && index.body.includes('id="root"'));
    check("index forbids framing", /frame-ancestors 'none'/.test(String(index.headers["content-security-policy"])));
    check("index sends no Referer (URL carries the token)", index.headers["referrer-policy"] === "no-referrer");
    check("launch URL carries core port + token", ready.coreOwned && new URL(ready.url).searchParams.get("port") === String(corePort) && token.length > 10);
    const asset = /assets\/[^"]+\.js/.exec(index.body)?.[0];
    const js = asset ? await request(port, `/${asset}`) : null;
    check("hashed JS asset served + cached immutably", !!js && js.status === 200 && /javascript/.test(String(js.headers["content-type"])) && /immutable/.test(String(js.headers["cache-control"])));
    check("favicon answered quietly", (await request(port, "/favicon.ico")).status === 204);

    console.log("2. guards");
    check("encoded ../ traversal refused", (await request(port, "/%2e%2e/%2e%2e/package.json")).status === 404);
    check("encoded slash traversal refused", (await request(port, "/..%2f..%2fpackage.json")).status === 404);
    check("foreign Host header refused (DNS rebinding)", (await request(port, "/", { host: `evil.example:${port}` })).status === 403);
    check("non-GET refused", (await request(port, "/", { method: "POST", body: "{}" })).status === 405);
    check("/api without token → 401", (await request(port, "/api/config")).status === 401);
    check("/api with wrong token → 401", (await request(port, "/api/config", { headers: { "x-aive-token": "nope" } })).status === 401);

    console.log("3. /api/config");
    const cfg = await request(port, "/api/config", { headers: auth });
    const c = json(cfg);
    check("config ok", cfg.status === 200 && c.ok === true && typeof c.home === "string");
    check("places include Home", Array.isArray(c.places) && c.places.some((p: { label: string }) => p.label === "Home"));
    check("MCP config resolved", c.mcp?.available === true && String(c.mcp?.json).includes("ai-video-editor"));

    console.log("4. /api/fs/list");
    const list = await request(port, `/api/fs/list?path=${encodeURIComponent(mediaDir)}`, { headers: auth });
    const l = json(list);
    const names = (l.entries ?? []).map((e: { name: string }) => e.name);
    check("lists the folder", list.status === 200 && l.path === mediaDir && l.parent === root);
    check("folders first", names[0] === "sub" && l.entries[0].dir === true, JSON.stringify(names));
    const clipEntry = l.entries?.find((e: { name: string }) => e.name === "clip.mp4");
    check("file has size + mtime", !!clipEntry && clipEntry.size > 0 && clipEntry.mtime > 0);
    check("dotfiles flagged hidden", l.entries?.find((e: { name: string }) => e.name === ".hidden")?.hidden === true);
    check("relative path refused", (await request(port, `/api/fs/list?path=media`, { headers: auth })).status === 400);
    const notDir = await request(port, `/api/fs/list?path=${encodeURIComponent(clip)}`, { headers: auth });
    check("file path → 400 Not a folder", notDir.status === 400 && /^Not a folder/.test(json(notDir).error));
    check("missing folder → 404", (await request(port, `/api/fs/list?path=${encodeURIComponent(join(root, "nope"))}`, { headers: auth })).status === 404);

    console.log("5. picked path → core");
    const health = await request(corePort, "/health", { headers: auth });
    check("core accepts the same token, CORS-readable", health.status === 200 && health.headers["access-control-allow-origin"] === "*");
    const picked = join(l.path, clipEntry?.name ?? "clip.mp4");
    const imp = await request(corePort, "/rpc", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ method: "import_video", params: { path: picked } }),
    });
    check("import_video accepts the picked path", imp.status === 200 && json(imp).ok === true, imp.body.slice(0, 200));
    const stream = await request(corePort, `/file?path=${encodeURIComponent(picked)}&token=${encodeURIComponent(token)}`, { headers: { range: "bytes=0-99" } });
    check("core streams it with Range (video seeking)", stream.status === 206);

    console.log("6. shutdown");
    shell.kill("SIGTERM");
    check("web shell exits cleanly", (await shellExit) === 0);
    let coreGone = false;
    for (let i = 0; i < 25 && !coreGone; i++) {
      coreGone = await request(corePort, "/health").then(() => false, () => true);
      if (!coreGone) await new Promise((r) => setTimeout(r, 200));
    }
    check("core it started is stopped too", coreGone);
  } finally {
    if (shell.exitCode === null) shell.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }

  if (failures) {
    console.error(`\nWEB SMOKE FAILED (${failures} check${failures === 1 ? "" : "s"})`);
    process.exit(1);
  }
  console.log("\nWEB SMOKE PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
