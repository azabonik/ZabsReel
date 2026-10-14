/**
 * Network-host gate, end to end (plan 9.2): a real core process
 * (packages/core/dist/cli.js) driven over HTTP /rpc, with every fs and
 * child_process call of that process traced, never opens a network path the
 * user has not allowed, and no rpc call can allow a server or read the stamp
 * key.
 *
 * The core runs under a preload (trace.mjs, `node --import`) that wraps every
 * function of fs, fs/promises and child_process and appends a JSON line
 * {fn, args, stack} for each call whose path or argv arguments name a test host
 * (`zr-evil`) or the stamp key (`hosts.key`). It is independent of gatedfs, so
 * it also sees third-party code and anything that dodged the import lint.
 * AIVE_FFMPEG / AIVE_FFPROBE point to a stub that logs its argv and runs the
 * real binary. Every host is under the reserved .invalid top-level domain, so
 * even a leak reaches nobody.
 *
 * Enforced (AIVE_NETWORK_GATE=enforce, until the gate ships enforced):
 *  1. load_project of a crafted project naming the hosts in every spelling and
 *     every field: the assets wait for their servers, network caches are
 *     dropped, each server is pending once (origin project; the two entries
 *     written outside ZabsReel also "outside"), with the 7.4 notice.
 *  2. Every tool on that project refuses before any I/O (renders with
 *     media_offline and one message; rpc paths with media_server_not_approved
 *     and a pending request) or works without opening the media; /file,
 *     /frames and /peaks answer 403; an .otio's network media stays an
 *     offline placeholder; graphics can't import network files (G9).
 *  3. The trace and the stub log name no test host, and gatedfs never had to
 *     block anything (the gates above stopped it all first).
 *  4. The MCP route cannot approve (the store is unchanged after saves aimed at
 *     it, and after calling every method) and cannot read the key (no response
 *     holds 8 characters of it; only trusthosts.ts reads it).
 *     9.4: the MCP server (packages/mcp/dist/index.js) over stdio has no tool
 *     that approves, reports the offline media in load_project's notice, and
 *     tells the agent not to edit the store.
 *  5. The UI route works (approveHost, as main.cjs and server.cjs call it):
 *     after recheck_offline_media the server's media is online without a
 *     reload, its colour probe and proxy start, an .otio placeholder is probed;
 *     without a recheck the next check re-reads the store (lazy reload); Keep
 *     of an outside entry brings it online; look-alike spellings of an approved
 *     server still refuse the load and are never opened.
 *  6. Revoke: the media is offline again and nothing opens it any more.
 *  7. (win32 only) A second share spelling of a data folder on \\localhost is
 *     refused by the identity check or the name rule; skipped elsewhere.
 * Log mode (no AIVE_NETWORK_GATE): a project naming \\zr-nas.invalid\s\a.mp4
 * loads unchanged (not offline, nothing pending), a "would block" line is
 * logged, and the probe goes through (to the stub, which answers for it).
 *
 * Needs the build (npm run build: the core and the MCP server) and FFmpeg. Temp dirs only.
 * Run: AIVE_NETWORK_GATE=enforce npx tsx packages/core/scripts/smoke-unc-e2e.ts
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { approveHost, revokeHost } from "../src/trusthosts.js";
import { projectToOtio } from "../src/interop/otio.js";
import type { Project } from "../src/types.js";

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};
const enforced = process.env.AIVE_NETWORK_GATE === "enforce";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = join(repo, "packages/core/dist/cli.js");
const mcpCli = join(repo, "packages/mcp/dist/index.js");
const which = (bin: string) => execFileSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" }).split(/\r?\n/)[0].trim();

// ---- the trace preload and the FFmpeg stub ---------------------------------------
const TRACE_MJS = `
import { createRequire, syncBuiltinESMExports } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("node:fs");
const append = fs.appendFileSync;
const out = process.env.ZR_TRACE;
// Also the look-alike spellings of zr-evil-1.invalid that step 5 loads (fullwidth ｚｒ, a zero-width space).
const WATCH = /zr-evil|\uff5a\uff52-evil|zr\u200b-evil|hosts\\.key/i;
const hit = (v, d = 0) =>
  typeof v === "string" ? WATCH.test(v)
  : v instanceof Uint8Array ? WATCH.test(Buffer.from(v).toString("utf8"))
  : v instanceof URL ? WATCH.test(v.href)
  : Array.isArray(v) ? d < 3 && v.some((x) => hit(x, d + 1))
  : v && typeof v === "object" && d < 2 ? Object.values(v).some((x) => hit(x, d + 1))
  : false;
// Data arguments are content, not paths: only a write's path is checked.
const PATH_ONLY = new Set(["writeFile", "writeFileSync", "appendFile", "appendFileSync"]);
const SKIP = new Set(["write", "writeSync", "writev", "writevSync", "read", "readSync"]);
const show = (v) => (typeof v === "string" ? v : v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : v instanceof URL ? v.href : Array.isArray(v) ? v.map(show) : typeof v === "object" && v ? "[object]" : String(v));
const done = new Set();
for (const [name, mod] of [["fs", fs], ["fs/promises", fs.promises], ["child_process", require("node:child_process")]]) {
  if (done.has(mod)) continue;
  done.add(mod);
  for (const key of Object.keys(mod)) {
    const orig = mod[key];
    if (typeof orig !== "function" || /^[A-Z]/.test(key) || SKIP.has(key)) continue;
    const wrapped = function (...args) {
      const checked = PATH_ONLY.has(key) ? args.slice(0, 1) : args;
      if (checked.some((a) => hit(a))) {
        try { append(out, JSON.stringify({ fn: name + "." + key, args: checked.map(show), stack: new Error().stack }) + "\\n"); } catch {}
      }
      return orig.apply(this, args);
    };
    Object.assign(wrapped, orig);
    mod[key] = wrapped;
  }
}
syncBuiltinESMExports();
`;
const STUB_MJS = `
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [tool, ...args] = process.argv.slice(2);
appendFileSync(process.env.ZR_STUB_LOG, JSON.stringify({ tool, args }) + "\\n");
const canned = process.env.ZR_STUB_CANNED;
if (tool === "ffprobe" && canned && args.some((a) => a.includes(canned))) {
  process.stdout.write(JSON.stringify({
    streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 64, height: 64, r_frame_rate: "30/1", avg_frame_rate: "30/1", pix_fmt: "yuv420p" }],
    format: { duration: "1.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
  }));
  process.exit(0);
}
const r = spawnSync(tool === "ffprobe" ? process.env.ZR_REAL_FFPROBE : process.env.ZR_REAL_FFMPEG, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
`;

const root = mkdtempSync(join(tmpdir(), "zr-unc-e2e-"));
const traceFile = join(root, "trace.jsonl");
const stubLog = join(root, "stub.jsonl");
writeFileSync(join(root, "trace.mjs"), TRACE_MJS);
writeFileSync(join(root, "ffstub.mjs"), STUB_MJS);
const stubFor = (tool: "ffmpeg" | "ffprobe") => {
  if (process.platform === "win32") {
    const cmd = join(root, `${tool}.cmd`);
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "%~dp0ffstub.mjs" ${tool} %*\r\n`);
    return cmd;
  }
  const f = join(root, `${tool}.mjs`);
  writeFileSync(f, `#!/usr/bin/env node\nprocess.argv.splice(2, 0, ${JSON.stringify(tool)});\nawait import(${JSON.stringify(pathToFileURL(join(root, "ffstub.mjs")).href)});\n`);
  chmodSync(f, 0o755);
  return f;
};
const lines = (f: string): Record<string, unknown>[] =>
  existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- a core process and its rpc --------------------------------------------------
interface Core {
  child: ChildProcess;
  base: string;
  token: string;
  stderr: string[];
}
async function startCore(dataDir: string, env: Record<string, string> = {}): Promise<Core> {
  const child = spawn(process.execPath, ["--import", pathToFileURL(join(root, "trace.mjs")).href, cli], {
    cwd: root,
    env: {
      ...process.env,
      AIVE_DATA_DIR: dataDir,
      AIVE_PORT: process.env.ZR_E2E_PORT ?? "0",
      AIVE_FFMPEG: stubFor("ffmpeg"),
      AIVE_FFPROBE: stubFor("ffprobe"),
      ZR_REAL_FFMPEG: which("ffmpeg"),
      ZR_REAL_FFPROBE: which("ffprobe"),
      ZR_TRACE: traceFile,
      ZR_STUB_LOG: stubLog,
      AIVE_STORAGE_GC_DELAY_MS: "-1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr!.on("data", (d) => stderr.push(...String(d).split("\n").filter(Boolean)));
  const ready = await new Promise<{ port: number; token: string }>((res, rej) => {
    let buf = "";
    const timer = setTimeout(() => rej(new Error(`core did not start: ${stderr.join("\n")}`)), 30_000);
    child.stdout!.on("data", (d) => {
      buf += String(d);
      for (const line of buf.split("\n")) {
        try {
          const m = JSON.parse(line) as { event?: string; port: number; token: string };
          if (m.event === "ready") {
            clearTimeout(timer);
            res(m);
          }
        } catch {
          /* a log line */
        }
      }
    });
    child.on("exit", (code) => rej(new Error(`core exited (${code}): ${stderr.join("\n")}`)));
  });
  return { child, base: `http://127.0.0.1:${ready.port}`, token: ready.token, stderr };
}
type Reply = { status: number; ok: boolean; result?: any; error?: string; code?: string; host?: string; hosts?: string[]; outside?: boolean; unread?: boolean; text: string };
async function rpc(core: Core, method: string, params: unknown = {}): Promise<Reply> {
  const res = await fetch(`${core.base}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-aive-token": core.token },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  return { status: res.status, text, ...(JSON.parse(text) as Omit<Reply, "status" | "text">) };
}
async function get(core: Core, route: string, query: Record<string, string>): Promise<{ status: number; text: string }> {
  const q = new URLSearchParams({ ...query, token: core.token });
  try {
    const res = await fetch(`${core.base}${route}?${q}`, { signal: AbortSignal.timeout(60_000) });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { status: 0, text: String(err) }; // the connection broke mid-answer (a refused stream)
  }
}
const stop = async (core: Core) => {
  // A core that died during the steps fails the run (and is not waited for).
  check(core.child.exitCode === null && core.child.signalCode === null, `the core process stayed up (${core.child.exitCode ?? core.child.signalCode ?? "running"})`);
  if (core.child.exitCode !== null || core.child.signalCode !== null) return;
  core.child.kill();
  await new Promise((r) => core.child.once("exit", r));
};

// ---- fixtures -----------------------------------------------------------------------------
const H = (n: number) => `zr-evil-${n}.invalid`;
const asset = (id: string, path: string, extra: Record<string, unknown> = {}) => ({
  id, path, name: id, duration: 2, width: 64, height: 64, fps: 30, hasVideo: true, hasAudio: true, addedAt: 0, ...extra,
});
const clip = (id: string, assetId: string | undefined, startFrame: number, extra: Record<string, unknown> = {}) => ({
  id, ...(assetId ? { assetId } : {}), startFrame, sourceInFrame: 0, sourceOutFrame: 30, ...extra,
});
const projectFile = (name: string, body: Record<string, unknown>) => {
  const f = join(root, name);
  writeFileSync(f, JSON.stringify({ id: "proj_e2e", name: "e2e", width: 64, height: 64, fps: 30, revision: 0, schemaVersion: 4, createdAt: 0, updatedAt: 0, ...body }));
  return f;
};

async function logMode(): Promise<void> {
  console.log("log mode: a NAS path changes nothing (the gate only logs)...");
  const dataDir = join(root, "data-log");
  const core = await startCore(dataDir, { ZR_STUB_CANNED: "zr-nas.invalid" });
  try {
    const NAS = "\\\\zr-nas.invalid\\s\\a.mp4";
    const f = projectFile("nas.aive", { assets: [asset("asset_nas", NAS, { hasAudio: false })], tracks: [{ id: "track_v", kind: "video", index: 0, clips: [clip("clip_n", "asset_nas", 0)] }] });
    const r = await rpc(core, "load_project", { path: f });
    const a = r.result?.project?.assets?.[0];
    const servers = (await rpc(core, "list_media_servers")).result;
    check(r.ok && !!a && a.awaitingServer === undefined && !a.missing && servers.gate === "log" && servers.pending.length === 0 && r.result.notice === undefined,
      `load_project: the NAS asset is not offline, nothing is pending, no notice (${JSON.stringify(a)}; ${JSON.stringify(servers)})`);
    // The probe that log mode lets through reaches the stub, which answers for the NAS (no network).
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000 && !lines(stubLog).some((l) => l.tool === "ffprobe" && JSON.stringify(l.args).includes("zr-nas"))) await sleep(100);
    check(lines(stubLog).some((l) => l.tool === "ffprobe" && JSON.stringify(l.args).includes("zr-nas")), "the colour probe of the NAS file goes through (to the stubbed ffprobe)");
    check(core.stderr.some((l) => l.includes("would block \\\\zr-nas.invalid: a network computer not allowed")), `HostTrust logs "would block \\\\zr-nas.invalid" (${JSON.stringify(core.stderr.filter((l) => /block/.test(l)))})`);
    check(!core.stderr.some((l) => /\bblocked \\\\/.test(l)), "nothing is blocked");
  } finally {
    await stop(core);
  }
}

async function enforcedSteps(): Promise<void> {
  const dataDir = join(root, "data");
  const trustDir = join(dataDir, "trust");
  mkdirSync(trustDir, { recursive: true });
  // The two outside entries, written as a shell agent would: a key the test keeps, and a list with an unstamped
  // entry and one stamped with a different key.
  const keyText = randomBytes(32).toString("base64url");
  writeFileSync(join(trustDir, "hosts.key"), keyText);
  const added = "2026-10-14T10:00:00.000Z";
  const forged = createHmac("sha256", randomBytes(32)).update(`zabsreel-hosts-v2\n${H(4)}\nprompt\n${added}`).digest("base64url");
  writeFileSync(join(trustDir, "hosts.json"), JSON.stringify({ version: 2, servers: [{ host: H(3) }, { host: H(4), via: "prompt", added, stamp: forged }] }));
  const storeHash = () => createHash("sha256").update(readFileSync(join(trustDir, "hosts.json"))).digest("hex");
  const storeBefore = storeHash();
  /** True when `text` holds any 8 characters of the key. */
  const leaks = (text: string) => {
    for (let i = 0; i + 8 <= keyText.length; i++) if (text.includes(keyText.slice(i, i + 8))) return true;
    return false;
  };

  // A real local clip (so a positive control can play), synthesized here.
  const local = join(root, "local.mp4");
  execFileSync(which("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", local]);

  // The stub answers ffprobe for a test host with a canned 1 s 64x64 clip: only once its server is allowed (step 5)
  // may anything probe one (step 3 checks that nothing did before).
  const core = await startCore(dataDir, { ZR_STUB_CANNED: "zr-evil" });
  try {
    // ---- 1. load ----------------------------------------------------------------------
    // MUTATION: drop markOfflineMedia from load() → the assets are online, the
    // trace sees probeUnrecordedColors probe zr-evil-1, nothing is pending.
    // Keep a network proxyPath in G3 → the proxy row fails. Skip the stamp
    // check in readTrustedHosts → zr-evil-3 is approved and probed.
    console.log("1. load_project of a crafted project...");
    const crafted = projectFile("crafted.aive", {
      assets: [
        asset("asset_local", local),
        // 4K, so it gets a background proxy once its server is allowed (step 5).
        asset("asset_e1", `//${H(1)}/s/a1.mp4`, { width: 3840, height: 2160, proxyPath: `\\\\${H(1)}\\s\\p1.mp4`, previewPath: `\\/${H(1)}/s/pv1.webm` }),
        asset("asset_e2", `\\\\${H(2)}\\s\\a2.mp4`),
        asset("asset_cut", join(root, "matte.mkv"), { cutout: { colorPath: `/\\${H(1)}\\s\\color.mp4`, colorStart: 0 } }),
        asset("asset_music", `//${H(2)}/s/music.wav`, { hasVideo: false }),
        asset("asset_graphic", `//${H(2)}/s/g.mov`, { previewPath: `//${H(2)}/s/g.webm` }),
        asset("asset_sfx", `//${H(1)}/s/beep.wav`, { hasVideo: false }),
        asset("asset_e3", `\\\\${H(3)}\\s\\a3.mp4`),
        asset("asset_e4", `\\\\${H(4)}\\s\\a4.mp4`),
      ],
      tracks: [
        {
          id: "track_v", kind: "video", index: 0, clips: [
            clip("clip_local", "asset_local", 0),
            clip("clip_e1", "asset_e1", 25, { transition: { type: "fade", durationFrames: 5 } }),
            clip("clip_cut", "asset_cut", 60),
            clip("clip_e2", "asset_e2", 90, {
              effects: { lut: `\\\\${H(1)}\\s\\look.cube`, bleeps: [{ id: "bleep_b1", start: 0.1, end: 0.3, sfxAssetId: "asset_sfx" }] },
              overlays: [{ id: "text_t1", text: "hi", font: `//${H(2)}/s/f.ttf` }],
              captions: { cues: [{ startFrame: 0, endFrame: 10, text: "hi" }], style: { font: `\\/${H(1)}/s/c.ttf` } },
              graphics: [{ id: "graphic_g1", assetId: "asset_graphic" }],
            }),
            clip("clip_e3", "asset_e3", 120),
            clip("clip_e4", "asset_e4", 150),
          ],
        },
        { id: "track_adj", kind: "video", index: 1, clips: [clip("clip_adj", undefined, 0, { adjustment: true, effects: { lut: `/\\${H(2)}\\s\\adj.cube` } })] },
      ],
      music: { assetId: "asset_music", volume: 0.3 },
    });
    const loaded = await rpc(core, "load_project", { path: crafted });
    const assets = new Map<string, any>((loaded.result?.project?.assets ?? []).map((a: any) => [a.id, a]));
    const waits: [string, number][] = [["asset_e1", 1], ["asset_e2", 2], ["asset_cut", 1], ["asset_music", 2], ["asset_graphic", 2], ["asset_sfx", 1], ["asset_e3", 3], ["asset_e4", 4]];
    check(loaded.ok && waits.every(([id, n]) => assets.get(id)?.awaitingServer === H(n)) && assets.get("asset_local")?.awaitingServer === undefined,
      `every asset on a test host waits for its server; the local one does not (${loaded.error ?? JSON.stringify([...assets.values()].map((a) => [a.id, a.awaitingServer]))})`);
    check(assets.get("asset_e1")?.proxyPath === undefined && assets.get("asset_e1")?.previewPath === undefined && assets.get("asset_graphic")?.previewPath === undefined,
      "proxyPath / previewPath on a test host are dropped");
    const pending = new Map<string, any>((loaded.result?.mediaServers?.pending ?? []).map((p: any) => [p.host, p]));
    const origins = (n: number) => (pending.get(H(n))?.origins ?? []).slice().sort().join(",");
    check(pending.size === 4 && origins(1) === "project" && origins(2) === "project" && origins(3) === "outside,project" && origins(4) === "outside,project",
      `each server is pending once: origin project, and outside too for the two written outside (${JSON.stringify([...pending.values()].map((p) => [p.host, p.origins, p.files]))})`);
    const servers = (await rpc(core, "list_media_servers")).result;
    check(servers.gate === "enforce" && servers.approved.length === 0 && servers.outside.map((o: any) => o.host).sort().join() === `${H(3)},${H(4)}` && servers.unread.length === 0,
      `list_media_servers: nothing approved, ${H(3)} and ${H(4)} outside (${JSON.stringify(servers)})`);
    check(!/stamp|"key"/.test(JSON.stringify(servers)), "no stamp and no key in list_media_servers");
    const notice = String(loaded.result?.notice ?? "");
    check(new RegExp(`files? on \\\\\\\\${H(3)}\\. \\\\\\\\${H(3)} is in ZabsReel's allowed list, but it was added outside ZabsReel`).test(notice)
      && notice.includes(`\\\\${H(4)} is in ZabsReel's allowed list, but it was added outside`)
      && new RegExp(`on \\\\\\\\${H(1)}, which the user hasn't allowed\\. They are offline\\.`).test(notice),
      `the load_project notice: the outside wording for ${H(3)} and ${H(4)}, the plain one for ${H(1)} (${notice})`);

    // ---- 2. every tool -------------------------------------------------------------------
    // MUTATION: drop G4 from generateThumbnail → its row gets another error and
    // the trace / stub log see zr-evil. Drop assertTimelineOnline from
    // stageRender / renderPreview → render_preview's argv has zr-evil. Drop G1
    // from importVideo → the trace shows ffprobe of zr-evil-7. Drop G6 from
    // isServablePath → the /file stat is traced. Drop the OTIO callback check
    // → ffprobe of zr-evil-5. Drop the G9 plugin from renderGraphic →
    // webpack's stat of //zr-evil-6.invalid/s/x is traced.
    console.log("2. every tool on it refuses before any I/O, or works without the media...");
    const OFFLINE = /^Can't render yet: clips? .*use files on the network computers? .*\\\\zr-evil-\d\.invalid.*An AI assistant cannot allow/;
    check((await rpc(core, "get_state")).result?.mediaServers?.gate === "enforce", "get_state carries mediaServers");
    // MUTATION: drop `offline` from summarizeTimeline's clip rows → this row fails.
    const sum = await rpc(core, "timeline_summary");
    const rows = new Map<string, any>((sum.result?.tracks ?? []).flatMap((t: any) => t.clips).map((c: any) => [c.clipId, c]));
    const allow = (n: number) => `waiting for the user to allow \\\\${H(n)}`;
    const want: [string, string | undefined][] = [
      ["clip_local", undefined], ["clip_e1", allow(1)], ["clip_cut", allow(1)], ["clip_e2", allow(2)], ["clip_adj", `LUT: ${allow(2)}`],
      ["clip_e3", `waiting for the user to keep \\\\${H(3)} (added outside ZabsReel)`], ["clip_e4", `waiting for the user to keep \\\\${H(4)} (added outside ZabsReel)`],
    ];
    const om = sum.result?.offlineMedia;
    check(sum.ok && want.every(([id, text]) => rows.get(id)?.offline === text) && om?.count === 6 && [1, 2, 3, 4].every((n) => om.servers.includes(`\\\\${H(n)}`)) && om.music === allow(2),
      `timeline_summary works and marks each offline clip with why, plus offlineMedia (${JSON.stringify([...rows.values()].map((c) => [c.clipId, c.offline]))}; ${JSON.stringify(om)})`);
    for (const [m, p] of [["render_preview", {}], ["inspect_timeline", {}], ["get_frame", {}], ["inspect_color", {}], ["export_video", { outputPath: join(root, "out.mp4") }]] as const) {
      const r = await rpc(core, m, p);
      const all = [1, 2, 3, 4].every((n) => r.error?.includes(`\\\\${H(n)}`)) && ["clip_e1", "clip_e2", "clip_cut"].every((c) => r.error?.includes(c));
      check(r.status === 403 && r.code === "media_offline" && OFFLINE.test(r.error ?? "") && all && (r.hosts ?? []).length === 4,
        `${m}: refused with media_offline, listing the clips and each server (${r.status} ${r.code} ${r.error?.slice(0, 160)})`);
    }
    const ic = await rpc(core, "inspect_clip", { clipId: "clip_e1" });
    check(ic.ok && ic.result?.offline?.host === H(1) && Array.isArray(ic.result?.frames) && ic.result.frames.length === 0,
      `inspect_clip: the clip info, offline (${H(1)}), no frames (${ic.error ?? JSON.stringify(ic.result?.offline)})`);
    const g4: [string, Record<string, unknown>][] = [
      ["generate_thumbnail", { assetId: "asset_e1" }], ["generate_proxy", { assetId: "asset_e1" }], ["analyze_silence", { assetId: "asset_e1" }],
      ["analyze_scenes", { assetId: "asset_e1" }], ["index_transcript", { assetId: "asset_e1" }], ["generate_captions", { clipId: "clip_e1" }],
      ["detect_key_color", { clipId: "clip_e1" }], ["stabilize_clip", { clipId: "clip_e1" }], ["reverse_clip", { clipId: "clip_e1" }],
      ["freeze_frame", { clipId: "clip_e1", atSeconds: 1 }], ["sync_audio", { clipId: "clip_e1", referenceClipId: "clip_local" }],
      ["generate_thumbnail", { assetId: "asset_cut" }], ["analyze_scenes", { assetId: "asset_e3" }],
    ];
    for (const [m, p] of g4) {
      const r = await rpc(core, m, p);
      check(r.status === 403 && r.code === "media_offline" && /is offline: its file is on/.test(r.error ?? ""), `${m} ${JSON.stringify(p)}: media_offline (${r.status} ${r.error?.slice(0, 140)})`);
    }
    for (const [m, p] of [["remove_unused_media", { dryRun: true, includeImported: true }], ["storage_report", {}], ["clean_up_storage", {}]] as const) {
      const r = await rpc(core, m, p);
      check(r.ok, `${m} works (${r.error ?? "ok"})`);
    }
    // Save (local) and reload: the runtime flags are never saved, and the reload marks them again.
    const saved = join(root, "saved.aive");
    const sv = await rpc(core, "save_project", { path: saved });
    const savedText = existsSync(saved) ? readFileSync(saved, "utf8") : "";
    check(sv.ok && savedText.includes(H(1)) && !savedText.includes("awaitingServer") && !savedText.includes("pathCheckFailed"), `save_project (local): the file has no awaitingServer / pathCheckFailed (${sv.error ?? "ok"})`);
    const re = await rpc(core, "load_project", { path: saved });
    check(re.ok && re.result.project.assets.find((a: any) => a.id === "asset_e1")?.awaitingServer === H(1), "reloaded: the asset waits again");
    await rpc(core, "set_project_settings", { name: "renamed" });
    const undone = await rpc(core, "undo");
    const redone = await rpc(core, "redo");
    const st = (await rpc(core, "get_state")).result;
    check(undone.ok && redone.ok && st.assets.find((a: any) => a.id === "asset_e1")?.awaitingServer === H(1), "undo / redo: the asset still waits");
    // /file, /frames, /peaks: 403 before any stat.
    for (const p of [`//${H(1)}/s/a1.mp4`, `\\\\${H(1)}\\s\\look.cube`]) {
      for (const [route, q] of [["/file", {}], ["/frames", { from: "0", count: "1", w: "8", h: "8", fps: "30" }], ["/peaks", {}]] as const) {
        const r = await get(core, route, { path: p, ...q });
        check(r.status === 403 && /waiting for approval in the app/.test(r.text), `${route} ${p}: 403, waiting for approval (${r.status} ${r.text.slice(0, 100)})`);
      }
    }
    const fileOk = await get(core, "/file", { path: local });
    check(fileOk.status === 200, `control: /file serves the local clip (${fileOk.status})`);
    // rpc paths on a server nobody allowed: refused, pending with origin request.
    const R = (ext: string) => `//${H(7)}/s/x.${ext}`;
    const rpcRows: [string, Record<string, unknown>][] = [
      ["import_video", { path: R("mp4") }], ["load_project", { path: R("aive") }], ["import_otio", { path: R("otio") }],
      ["import_captions", { clipId: "clip_local", path: R("srt") }], ["apply_lut", { clipId: "clip_local", path: R("cube") }],
      ["add_text", { clipId: "clip_local", text: "t", font: R("ttf") }], ["save_project", { path: R("aive") }],
      ["export_video", { outputPath: R("mp4") }], ["export_otio", { path: R("otio") }], ["export_captions", { path: R("srt") }],
    ];
    for (const [m, p] of rpcRows) {
      const r = await rpc(core, m, p);
      check(r.status === 403 && r.code === "media_server_not_approved" && r.host === H(7) && /You cannot allow it yourself/.test(r.error ?? ""), `${m}: media_server_not_approved (${r.status} ${r.code} ${r.error?.slice(0, 120)})`);
    }
    const out3 = await rpc(core, "import_video", { path: `\\\\${H(3)}\\s\\x.mp4` });
    check(out3.code === "media_server_not_approved" && out3.outside === true && /added to ZabsReel's allowed list outside ZabsReel/.test(out3.error ?? "") && /editing ZabsReel's files does not allow it/.test(out3.error ?? ""),
      `an outside server: media_server_not_approved with outside: true and the outside wording (${out3.error?.slice(0, 160)})`);
    const rem = await rpc(core, "remember_projects", { paths: [`//${H(6)}/p/x.aive`] });
    check(rem.ok && rem.result.skipped.length === 1 && /network computer you haven't allowed/.test(rem.result.skipped[0].reason), `remember_projects skips it (${JSON.stringify(rem.result?.skipped)})`);
    const req = (await rpc(core, "list_media_servers")).result.pending as any[];
    check([H(6), H(7)].every((h) => req.find((p) => p.host === h)?.origins.includes("request")), `the asked-for servers are pending with origin request (${JSON.stringify(req.map((p) => [p.host, p.origins]))})`);
    // An .otio whose media is on a test host (a clip's target_url, and an unplaced asset that only the
    // ZabsReel metadata names): offline placeholders, never probed. Built by projectToOtio, as export_otio
    // writes it, with the clip's target_url then set to the raw network path (on POSIX, pathToFileURL makes
    // any path local).
    const otio = join(root, "crafted.otio");
    const target = `\\\\${H(5)}\\s\\t.mp4`;
    const timeline = projectToOtio({
      id: "proj_otio", name: "o", width: 64, height: 64, fps: 30, revision: 0, schemaVersion: 4, createdAt: 0, updatedAt: 0,
      assets: [asset("asset_t5", target), asset("asset_m5", `//${H(5)}/s/meta.mp4`)],
      tracks: [{ id: "track_v", kind: "video", index: 0, clips: [clip("clip_t5", "asset_t5", 0)] }],
    } as unknown as Project);
    timeline.tracks.children[0].children[0].media_references!.DEFAULT_MEDIA.target_url = target;
    writeFileSync(otio, JSON.stringify(timeline));
    const io = await rpc(core, "import_otio", { path: otio });
    const ioAssets = (io.result?.project?.assets ?? []) as any[];
    check(io.ok && ioAssets.length === 2 && ioAssets.every((a) => a.missing === true && a.awaitingServer === H(5)) && /\\\\zr-evil-5\.invalid, which the user hasn't allowed/.test(io.result.notice ?? ""),
      `import_otio: both media paths on ${H(5)} are offline placeholders, with the notice (${io.error ?? JSON.stringify(ioAssets.map((a) => [a.path, a.missing, a.awaitingServer]))})`);
    // Graphics never import a network file (G9), standalone so no clip is needed.
    const G9 = /graphics can only import local files and installed packages/;
    for (const code of [
      // Each import is used: the TypeScript loader drops an unused one before webpack resolves it.
      `import x from "//${H(6)}/s/x";\nexport default () => String(x);`,
      `const ctx = require.context("//${H(6)}/s", false, /x/);\nexport default () => String(ctx);`,
      `import x from "file://${H(6)}/s/x.png";\nexport default () => String(x);`,
    ]) {
      const r = await rpc(core, "add_graphic", { code, durationSeconds: 1 });
      check(!r.ok && G9.test(r.error ?? ""), `add_graphic importing a network file fails with the G9 message (${(r.error ?? r.text).split("\n")[0].slice(0, 200)})`);
    }

    // ---- 3. nothing reached a test host ----------------------------------------------------
    // MUTATION: any gate removed above → a trace or stub-log line names zr-evil.
    console.log("3. the trace and the stub log never saw a test host...");
    await sleep(500); // background work (colour probes, proxies) had its chance
    const traced = lines(traceFile).filter((l) => /zr-evil/i.test(JSON.stringify(l.args)));
    check(traced.length === 0, `no fs / child_process call named a test host (${traced.length}: ${JSON.stringify(traced.slice(0, 2).map((l) => [l.fn, l.args]))})`);
    const stubbed = lines(stubLog).filter((l) => /zr-evil/i.test(JSON.stringify(l.args)));
    check(stubbed.length === 0, `no ffmpeg / ffprobe argv named a test host (${JSON.stringify(stubbed.slice(0, 2))})`);
    check(lines(stubLog).length > 0, `control: the stub saw the core's own FFmpeg calls (${lines(stubLog).length})`);
    // gatedfs and G7 log a block as `blocked \\host: <call> "<path>" (a network computer …)`; the gates above log no call.
    const backstop = core.stderr.filter((l) => /blocked \\\\\S+: [\w ]+ ".*" \(a network computer/.test(l));
    check(backstop.length === 0, `gatedfs and the argv gate never had to block anything (${JSON.stringify(backstop.slice(0, 2))})`);

    // ---- 4. the MCP route can't approve, and can't read the key -----------------------------
    // MUTATION: remove G2 from save → the save rows change the store. Remove it
    // from load → the error quotes the start of the key. Drop the trust/ rule
    // from G6 → /file streams the key. Drop privatePath from rememberMany →
    // storage_report's reason holds the key. Drop the trust/ rule from the G9
    // wrapper → the add_graphic error quotes the key.
    console.log("4. no rpc call can allow a server or read the key...");
    const hostile = projectFile("hostile.aive", {
      version: 2, servers: [{ host: H(1), via: "prompt", added, stamp: forged }],
      assets: [asset("asset_l", local)], tracks: [{ id: "track_v", kind: "video", index: 0, clips: [clip("clip_l", "asset_l", 0)] }],
    });
    check((await rpc(core, "load_project", { path: hostile })).ok, "a project carrying top-level version / servers loads");
    const spellings = [join(trustDir, "hosts.json"), `${dataDir}/trust/../trust/hosts.json`, `${dataDir}/proxies/../trust/hosts.json`];
    if (process.platform === "win32" || process.platform === "darwin") spellings.push(join(dataDir, "TRUST", "HOSTS.JSON"));
    for (const p of spellings) {
      const r = await rpc(core, "save_project", { path: p });
      check(!r.ok && /private settings folder/.test(r.error ?? "") && storeHash() === storeBefore, `save_project into ${p} is refused; the store is unchanged (${r.error?.slice(0, 100)})`);
    }
    const responses: string[] = [];
    const keyPaths = [join(trustDir, "hosts.key"), join(trustDir, "hosts.json"), `${dataDir}/proxies/../trust/hosts.key`];
    for (const p of keyPaths) {
      for (const [m, params] of [
        ["load_project", { path: p }], ["import_otio", { path: p }], ["import_captions", { clipId: "clip_l", path: p }],
        ["import_video", { path: p }], ["apply_lut", { clipId: "clip_l", path: p }], ["add_text", { clipId: "clip_l", text: "t", font: p }],
      ] as const) {
        const r = await rpc(core, m, params);
        responses.push(r.text);
        check(!r.ok && /private settings folder/.test(r.error ?? ""), `${m} of ${p}: refused (${r.error?.slice(0, 100)})`);
      }
      for (const route of ["/file", "/frames", "/peaks"]) {
        const r = await get(core, route, { path: p, from: "0", count: "1", w: "8", h: "8", fps: "30" });
        responses.push(r.text);
        check(r.status === 403, `${route} of ${p}: 403 (${r.status})`);
      }
    }
    const remKey = await rpc(core, "remember_projects", { paths: keyPaths });
    responses.push(remKey.text);
    check(remKey.ok && remKey.result.skipped.length === keyPaths.length && remKey.result.skipped.every((s: any) => /private settings folder|not a \.aive/.test(s.reason)), `remember_projects skips each (${JSON.stringify(remKey.result?.skipped?.map((s: any) => s.reason))})`);
    for (const code of [`import k from ${JSON.stringify(join(trustDir, "hosts.key"))};\nexport default () => k;`, `import k from "../../trust/hosts.key";\nexport default () => k;`]) {
      const r = await rpc(core, "add_graphic", { code, durationSeconds: 1 });
      responses.push(r.text);
      check(!r.ok && G9.test(r.error ?? ""), `add_graphic importing the key fails with the G9 message (${r.error?.slice(0, 120)})`);
    }
    const fontKey = projectFile("fontkey.aive", {
      assets: [asset("asset_l", local)],
      tracks: [{ id: "track_v", kind: "video", index: 0, clips: [clip("clip_l", "asset_l", 0, { overlays: [{ id: "text_t", text: "t", font: join(trustDir, "hosts.key") }] })] }],
    });
    const fk = await rpc(core, "load_project", { path: fontKey });
    responses.push(fk.text);
    check(!fk.ok && /private settings folder/.test(fk.error ?? ""), `a project whose overlay font is the key does not load (${fk.error?.slice(0, 100)})`);
    for (const m of ["get_state", "storage_report", "list_jobs", "list_media_servers"]) responses.push((await rpc(core, m)).text);
    check(!responses.some(leaks), `no response, error or job error holds any 8 characters of the key (${responses.length} checked)`);
    const keyLines = lines(traceFile).filter((l) => /hosts\.key/.test(JSON.stringify(l.args)));
    const META = /\.(?:stat|lstat|statSync|lstatSync|readdir|readdirSync|access|accessSync|existsSync|realpath|realpathSync|watch)$/;
    const foreign = keyLines.filter((l) => !/trusthosts/.test(String(l.stack)) && !META.test(String(l.fn)));
    check(foreign.length === 0 && keyLines.some((l) => /trusthosts/.test(String(l.stack))),
      `only trusthosts.ts opens hosts.key (the others only stat it) (${keyLines.length} lines; ${JSON.stringify(foreign.slice(0, 2).map((l) => [l.fn, String(l.stack).split("\n")[2]]))})`);
    // Every method with {}: none approves anything or moves an outside entry.
    let called = 0;
    const names = Object.keys((await import("../src/rpc.js")).methods);
    for (const m of names) {
      await rpc(core, m, {}).catch(() => undefined);
      called++;
    }
    const after = (await rpc(core, "list_media_servers")).result;
    check(called === names.length && after.approved.length === 0 && after.outside.map((o: any) => o.host).sort().join() === `${H(3)},${H(4)}` && storeHash() === storeBefore,
      `calling all ${called} methods with {} approves nothing, ${H(3)} and ${H(4)} stay outside, the store is unchanged (${JSON.stringify(after.approved)})`);
    const late = lines(traceFile).filter((l) => /zr-evil/i.test(JSON.stringify(l.args)));
    check(late.length === 0, `still no fs / child_process call named a test host (${JSON.stringify(late.slice(0, 2).map((l) => [l.fn, l.args]))})`);

    // ---- 9.4 the MCP layer -------------------------------------------------------------------
    // MUTATION: name a tool approve_media_server (or add one with "allow" in
    // its name) → the tool-list row fails. Drop the "Offline media" paragraph
    // from guide.ts → the instructions row fails. Drop the outside wording from
    // rpc.ts offlineNotice → the notice row fails.
    console.log("9.4 the MCP server: no tool can allow a server; load_project reports the offline media...");
    const mcp = new Client({ name: "smoke-unc-e2e", version: "0.0.0" });
    await mcp.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [mcpCli],
        env: { ...(process.env as Record<string, string>), AIVE_CORE_URL: core.base, AIVE_CORE_TOKEN: core.token, AIVE_DATA_DIR: dataDir },
        stderr: "ignore",
      }),
    );
    try {
      const { tools } = await mcp.listTools();
      const tool = (n: string) => tools.find((t) => t.name === n);
      const named = tools.filter((t) => /approv|trust|allow|grant/i.test(t.name)).map((t) => t.name);
      check(tool("list_media_servers")?.annotations?.readOnlyHint === true && !!tool("recheck_offline_media") && named.length === 0,
        `tools/list (${tools.length} tools): list_media_servers (read-only) and recheck_offline_media, no tool named like approve / trust / allow / grant (${JSON.stringify(named)})`);
      const instructions = mcp.getInstructions() ?? "";
      check(/## Offline media\n/.test(instructions) && instructions.includes("You cannot allow a server; no tool can.")
        && instructions.includes("Never edit files in ZabsReel's data folder (such as trust/hosts.json) to allow a server"),
        "the server's instructions carry the Offline media paragraph, with the do-not-edit sentence");
      const text = (r: Awaited<ReturnType<typeof mcp.callTool>>) => (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
      const lp = await mcp.callTool({ name: "load_project", arguments: { path: crafted } });
      const lpNotice = lp.isError ? "" : String(JSON.parse(text(lp)).notice ?? "");
      check(lpNotice.includes(`on \\\\${H(1)}, which the user hasn't allowed. They are offline.`) && lpNotice.includes(`\\\\${H(3)} is in ZabsReel's allowed list, but it was added outside ZabsReel`),
        `load_project through MCP: the pending notice, and the outside notice for ${H(3)} (${lpNotice.slice(0, 200)})`);
      const ms = await mcp.callTool({ name: "list_media_servers", arguments: {} });
      const msText = text(ms);
      const fields = (v: unknown): string[] => (v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...fields(x)]) : []);
      const parsed = ms.isError ? {} : JSON.parse(msText);
      check(Array.isArray(parsed.outside) && parsed.outside.length === 2 && !fields(parsed).some((k) => /^(stamp|key)$/i.test(k)) && !leaks(msText),
        `list_media_servers through MCP: an outside array, no field named stamp or key, nothing of the key (${msText.replace(/\s+/g, " ").slice(0, 160)})`);
      const sv = await mcp.callTool({ name: "save_project", arguments: { path: join(trustDir, "hosts.json") } });
      check(sv.isError === true && /private settings folder/.test(text(sv)) && storeHash() === storeBefore, `save_project into trust/ through MCP is refused; the store is unchanged (${text(sv).slice(0, 100)})`);
    } finally {
      await mcp.close();
    }

    // ---- 5. the UI route works -------------------------------------------------------------
    // MUTATION: drop the resume loop from onTrustChanged → zr-evil-1's colour
    // probe and proxy never start, and the .otio placeholders keep `missing`.
    // Drop the lazy check from requireMedia → generate_thumbnail on zr-evil-2's
    // asset is refused with media_offline (fs.watch's 200 ms debounce has not
    // run yet). Skip the stamp check → zr-evil-4 comes online with the Keep.
    console.log("5. the UI route: approveHost (as the app calls it); the media comes online without a reload...");
    const zr = (n: number) => new RegExp(`zr-evil-${n}\\.invalid`, "i");
    const traces = (re: RegExp) => lines(traceFile).filter((l) => re.test(JSON.stringify(l.args))).length;
    const stubs = (tool: string, re: RegExp) => lines(stubLog).filter((l) => l.tool === tool && re.test(JSON.stringify(l.args))).length;
    const until = async (ok: () => boolean | Promise<boolean>, ms: number) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await ok()) return true;
        await sleep(50);
      }
      return ok();
    };
    const assetsNow = async () => new Map<string, any>(((await rpc(core, "get_state")).result.assets as any[]).map((a) => [a.id, a]));
    const others = (...ns: number[]) => [2, 3, 4, 5, 6, 7, 8, 9].filter((n) => !ns.includes(n));
    check((await rpc(core, "load_project", { path: crafted })).ok, "load_project of the crafted project again");
    await approveHost(dataDir, H(1), "prompt");
    const rc = await rpc(core, "recheck_offline_media");
    let now = await assetsNow();
    const on1 = ["asset_e1", "asset_cut", "asset_sfx"];
    check(rc.ok && rc.result.approved.some((x: any) => x.host === H(1)) && on1.every((id) => now.get(id)?.awaitingServer === undefined)
      && [["asset_e2", 2], ["asset_e3", 3], ["asset_e4", 4]].every(([id, n]) => now.get(id as string)?.awaitingServer === H(n as number)),
      `recheck_offline_media: the ${H(1)} assets are online at once, the others still wait (${JSON.stringify([...now.values()].map((x) => [x.id, x.awaitingServer]))})`);
    const resumed = await until(async () => (await assetsNow()).get("asset_e1")?.color !== undefined && stubs("ffmpeg", /a1\.mp4/) > 0, 5_000);
    check(resumed && stubs("ffprobe", /a1\.mp4/) > 0, `its colour probe ran and its 4K proxy started (ffprobe ${stubs("ffprobe", /a1\.mp4/)}, ffmpeg ${stubs("ffmpeg", /a1\.mp4/)})`);
    check(traces(zr(1)) > 0 && others().every((n) => traces(zr(n)) === 0),
      `the trace now has ${H(1)} lines (${traces(zr(1))}: the trace works) and none for the other hosts (${JSON.stringify(others().map((n) => [n, traces(zr(n))]))})`);
    // An .otio placeholder on a server allowed later is probed (the stub's canned 1 s 64x64) and loses `missing`.
    const io5 = await rpc(core, "import_otio", { path: otio });
    check(io5.ok && (io5.result.project.assets as any[]).every((x) => x.missing && x.awaitingServer === H(5)), `import_otio again: placeholders waiting for ${H(5)}`);
    await approveHost(dataDir, H(5), "prompt");
    await rpc(core, "recheck_offline_media");
    const filled = await until(async () => [...(await assetsNow()).values()].every((x) => !x.missing && !x.awaitingServer && x.duration === 1 && x.width === 64), 5_000);
    check(filled && traces(zr(5)) > 0, `the ${H(5)} placeholders are probed and filled in (${JSON.stringify([...(await assetsNow()).values()].map((x) => [x.id, x.missing, x.duration, x.width]))})`);
    // No recheck: the next check of the asset re-reads the changed store (lazy reload).
    check((await rpc(core, "load_project", { path: crafted })).ok, "load_project of the crafted project again");
    await approveHost(dataDir, H(2), "prompt");
    const th = await rpc(core, "generate_thumbnail", { assetId: "asset_e2" });
    check(th.code !== "media_offline" && (await until(() => traces(zr(2)) > 0, 2_000)),
      `without a recheck, generate_thumbnail on ${H(2)}'s asset goes through right after the approval (${th.status} ${th.code ?? ""} ${th.error?.slice(0, 100)})`);
    // Keep (what a UI host does for an entry added outside ZabsReel): the entry is stamped, so it is approved.
    await approveHost(dataDir, H(3), "prompt");
    await rpc(core, "recheck_offline_media");
    now = await assetsNow();
    const kept = (await rpc(core, "list_media_servers")).result;
    check(now.get("asset_e3")?.awaitingServer === undefined && now.get("asset_e4")?.awaitingServer === H(4) && kept.outside.map((o: any) => o.host).join() === H(4) && kept.approved.some((x: any) => x.host === H(3)),
      `Keep of ${H(3)}: its asset is online and only ${H(4)} is still outside (${JSON.stringify(kept.outside)})`);
    check((await until(() => traces(zr(3)) > 0, 5_000)) && traces(zr(4)) === 0, `the trace now has ${H(3)} lines (${traces(zr(3))}) and still none for ${H(4)}`);
    // Look-alikes of the approved zr-evil-1.invalid (fullwidth ｚｒ, a zero-width space) still refuse the load.
    const LOOK = /ｚｒ-evil|zr​-evil/i;
    for (const [i, p] of [`\\\\ｚｒ-evil-1.invalid\\s\\a.mp4`, `\\\\zr​-evil-1.invalid\\s\\a.mp4`].entries()) {
      const f = projectFile(`lookalike-${i}.aive`, { assets: [asset("asset_x", p)], tracks: [{ id: "track_v", kind: "video", index: 0, clips: [clip("clip_x", "asset_x", 0)] }] });
      const r = await rpc(core, "load_project", { path: f });
      check(!r.ok && /names the network computer .*, which ZabsReel can't use/.test(r.error ?? ""), `a look-alike of ${H(1)} does not load (${r.error?.slice(0, 120)})`);
    }
    check(!lines(traceFile).some((l) => LOOK.test(JSON.stringify(l.args))) && !lines(stubLog).some((l) => LOOK.test(JSON.stringify(l.args))), "no trace or stub-log line names a look-alike spelling");

    // ---- 6. revoke ----------------------------------------------------------------------------
    // MUTATION: keep a removed approval in HostTrust.reload → the assets stay
    // online and the calls below open zr-evil-1.
    console.log("6. revoke: the media is offline again and nothing opens it...");
    check((await rpc(core, "load_project", { path: crafted })).ok, "load_project of the crafted project again");
    // Step 5's background work (colour probes, proxies) settles first.
    const settled = async () => {
      const n = traces(/zr-evil/);
      await sleep(1_000);
      return (await rpc(core, "list_jobs", { activeOnly: true })).result.jobs.length === 0 && traces(/zr-evil/) === n;
    };
    check(await until(settled, 20_000), "step 5's background work finished");
    await revokeHost(dataDir, H(1));
    await rpc(core, "recheck_offline_media");
    now = await assetsNow();
    check(on1.every((id) => now.get(id)?.awaitingServer === H(1)) && now.get("asset_e2")?.awaitingServer === undefined,
      `the ${H(1)} assets wait again; ${H(2)}'s stay online (${JSON.stringify(on1.map((id) => [id, now.get(id)?.awaitingServer]))})`);
    const before = [traces(/zr-evil/), stubs("ffmpeg", /zr-evil/) + stubs("ffprobe", /zr-evil/)];
    for (const [m, p] of [["render_preview", {}], ["inspect_timeline", {}], ["get_frame", {}], ["inspect_color", {}], ...g4.filter(([, q]) => q.assetId === "asset_e1" || q.clipId === "clip_e1")] as [string, Record<string, unknown>][]) {
      const r = await rpc(core, m, p);
      check(r.code === "media_offline" && (r.error ?? "").includes(`\\\\${H(1)}`), `${m} ${JSON.stringify(p)}: media_offline again, naming ${H(1)} (${r.code} ${r.error?.slice(0, 100)})`);
    }
    const ic6 = await rpc(core, "inspect_clip", { clipId: "clip_e1" });
    const sum6 = await rpc(core, "timeline_summary");
    const row6 = (sum6.result?.tracks ?? []).flatMap((t: any) => t.clips).find((c: any) => c.clipId === "clip_e1");
    check(ic6.result?.offline?.host === H(1) && ic6.result.frames.length === 0 && row6?.offline === allow(1), `inspect_clip and timeline_summary show clip_e1 offline again (${row6?.offline})`);
    for (const [route, q] of [["/file", {}], ["/frames", { from: "0", count: "1", w: "8", h: "8", fps: "30" }], ["/peaks", {}]] as const) {
      const r = await get(core, route, { path: `//${H(1)}/s/a1.mp4`, ...q });
      check(r.status === 403, `${route} of the revoked server's file: 403 (${r.status})`);
    }
    await sleep(500);
    const after6 = [traces(/zr-evil/), stubs("ffmpeg", /zr-evil/) + stubs("ffprobe", /zr-evil/)];
    check(after6.join() === before.join(), `after the revoke nothing opened a test host (trace and stub-log lines ${before.join("/")} → ${after6.join("/")})`);
    check([4, 6, 7, 8, 9].every((n) => traces(zr(n)) === 0), "the servers never allowed (incl. the forged stamp's) were never touched");
  } finally {
    await stop(core);
  }

  // ---- 7. a second spelling of a data folder on a share (Windows only) ---------------------
  if (process.platform !== "win32") {
    console.log("7. skipped: a second share spelling of a data folder needs Windows shares (net share); it runs in release.yml");
    return;
  }
  console.log("7. a second share spelling of a data folder on \\\\localhost...");
  const parent = join(root, "share-p");
  const shared = join(parent, "zr");
  const media = join(root, "share-m");
  mkdirSync(shared, { recursive: true });
  mkdirSync(media, { recursive: true });
  const shares = [["zr-e2e-p", parent], ["zr-e2e-d", shared], ["zr-e2e-m", media]] as const;
  try {
    for (const [name, dir] of shares) execFileSync("net", ["share", `${name}=${dir}`, "/grant:everyone,full"]);
    const dataUnc = "\\\\localhost\\zr-e2e-p\\zr";
    await approveHost(dataUnc, "zr-evil-9.invalid", "prompt"); // so trust\hosts.key exists
    const key = readFileSync(join(shared, "trust", "hosts.key"), "utf8").trim();
    writeFileSync(join(media, "clip.mp4"), readFileSync(join(root, "local.mp4")));
    const core2 = await startCore(dataUnc);
    try {
      const drive = shared.slice(0, 1);
      const spellings = ["\\\\localhost\\zr-e2e-d\\trust\\hosts.key", `\\\\localhost\\${drive}$\\${shared.slice(3)}\\trust\\hosts.key`];
      const texts: string[] = [];
      for (const p of spellings) {
        for (const [m, params] of [["load_project", { path: p }], ["import_video", { path: p }], ["apply_lut", { clipId: "clip_none", path: p }]] as const) {
          const r = await rpc(core2, m, params);
          texts.push(r.text);
          check(!r.ok && /private settings folder/.test(r.error ?? ""), `${m} of ${p}: refused (${r.error?.slice(0, 100)})`);
        }
      }
      check(!texts.some((t) => { for (let i = 0; i + 8 <= key.length; i++) if (t.includes(key.slice(i, i + 8))) return true; return false; }), "no response holds any 8 characters of the key");
      check(core2.stderr.some((l) => /in the private trust folder \((the identity check|the name rule)\)/.test(l)), `the core's log says which rule refused each path (${JSON.stringify(core2.stderr.filter((l) => /trust folder/.test(l)).slice(0, 3))})`);
      const ok = projectFile("share.aive", { assets: [asset("asset_s", "\\\\localhost\\zr-e2e-m\\clip.mp4")], tracks: [{ id: "track_v", kind: "video", index: 0, clips: [clip("clip_s", "asset_s", 0)] }] });
      const r = await rpc(core2, "load_project", { path: ok });
      check(r.ok && r.result.project.assets[0].awaitingServer === undefined && r.result.project.assets[0].pathCheckFailed === undefined, `a clip on an unrelated share loads normally (${r.error ?? "ok"})`);
    } finally {
      await stop(core2);
    }
  } finally {
    for (const [name] of shares) {
      try {
        execFileSync("net", ["share", name, "/delete", "/y"]);
      } catch {
        /* not made */
      }
    }
  }
}

async function main() {
  process.exitCode = 1; // a run that stops early (an event loop that drains) never passes
  for (const f of [cli, mcpCli]) if (!existsSync(f)) throw new Error(`${f} is missing: run npm run build first`);
  console.log(`(network gate: ${enforced ? "enforced" : "log mode"}; AIVE_NETWORK_GATE=${process.env.AIVE_NETWORK_GATE ?? "(unset)"})`);
  if (enforced) await enforcedSteps();
  else {
    await logMode();
    console.log("(steps 1-4 and 7 need AIVE_NETWORK_GATE=enforce: in log mode the gate only logs)");
  }
  rmSync(root, { recursive: true, force: true });
  console.log(failures === 0 ? "\nALL UNC E2E CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
