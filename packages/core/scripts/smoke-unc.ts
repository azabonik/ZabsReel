/**
 * Network-path smoke (unc.ts): a project file or an rpc call can only name a
 * server by a key that certainly reaches that server, and a device / NT path
 * or a server name with no key never reaches the file system.
 *
 *  1. classifyPath         — every vector of the plan's table (2.3): network
 *                            forms with any separators, one key per server,
 *                            device / NT forms and keyless names refused.
 *  2. safepath integration — load refuses a device / NT path or a keyless
 *                            server name in asset.path / cutout / LUT with a
 *                            message that says how to fix it, drops one in a
 *                            cache path, and accepts a usable network path;
 *                            assertLocalMediaPath gives the rpc wording.
 *  2b. engine entry points — load_project, import_otio, import_captions,
 *                            save, export, font and LUT setters refuse such a
 *                            path, remember_projects skips it, and no fs or
 *                            child_process call ever sees it (traced).
 *  5. G8 gatedfs           — every gated fs call refuses a device path or a
 *                            keyless server name without calling the real
 *                            function (spied); a server that is not allowed
 *                            is refused when enforced (logged once and let
 *                            through in log mode); an allowed one calls through.
 *                            The data folder bootstrap refuses those forms
 *                            too, and resolveDataDir refuses such a folder
 *                            at startup.
 *                            R5 (Windows, tested through the platform/cwd
 *                            seam): a relative path is classified where it
 *                            resolves, so a cwd on a share is covered.
 *  6. G7 argv              — ffmpegArgsLocalOnly / ffprobeArgsLocalOnly /
 *                            runTool check every argument, the cwd and each
 *                            file line of a -f concat list the same way; on
 *                            Windows the process's own cwd when no spawn cwd
 *                            is given, and relative arguments in the spawn cwd.
 *  8. lint                 — scripts/check-io-imports.mjs --self-test, and the
 *                            core passes it.
 *  11. G9                  — graphicRequestRefusal refuses network, device and
 *                            hosted file: imports; the webpack input file
 *                            system wrapper never calls the real reads for a
 *                            network path, nor its content reads for a path
 *                            in the trust folder; the plugin taps both factories.
 *  3. the approval store   — trusthosts.ts: round trip, a corrupt or unknown
 *                            list, hand-edited and invalid entries, atomic
 *                            writes (a reader process never sees half a
 *                            file), the lock (a revoke is never lost, across
 *                            processes too; stale locks are broken through a
 *                            claim, never under a live writer).
 *  4. G2                   — rpc writes and reads into <dataDir>/trust (any
 *                            spelling, a link included) are refused and no
 *                            error quotes the key; remember_projects skips
 *                            them; a loaded project's media, LUT or font
 *                            there refuses the load, a cache path is dropped.
 *  12. stamps              — only validly stamped entries are approved;
 *                            hand-written, forged, copied or edited ones are
 *                            "outside"; the key's lifecycle; read errors never
 *                            rotate the key or drop an entry; the stale and
 *                            unread states; no laundering; Keep and Remove;
 *                            HostTrust publishes approved servers only, and
 *                            picks up changes (lazy reload, watch, 1 s retry).
 *  13. the trust folder    — isTrustPath's quick form (Windows streams,
 *                            trailing dots, 8.3 names, case); gatedfs content
 *                            calls and G7 refuse it in every mode, metadata
 *                            calls don't; /file never serves it; on the data
 *                            folder's own server, other share spellings are
 *                            caught by the identity check and the name rule;
 *                            a loaded field whose folder can't be checked
 *                            stays offline alone (pathCheckFailed) until a
 *                            re-check passes.
 *  7. rpc surface          — every string parameter that looks like a path is
 *                            in rpc.ts RPC_PATH_PARAMS, and (enforced) each one
 *                            refuses an unallowed server with code
 *                            media_server_not_approved; no method can allow
 *                            or trust a server.
 *  9. project name         — bareFileName; a name with a path separator is
 *                            refused, a loaded one is cut to its last part.
 *  10. storage             — a known project on a server not allowed is never
 *                            read: it pauses clean-up and never goes stale.
 *  14. log mode / enforce  — a project naming a NAS path: in log mode nothing
 *                            is offline and a "would block" line is logged;
 *                            enforced, the asset is offline and pending; the
 *                            autosave of a project on such a server goes to
 *                            the recovery folder; timeline_summary says why a
 *                            clip is offline (not found; the unread state).
 *
 * Rows 5 and 6 check both modes: the network-path gate is "log" until the
 * user can allow a server in the app, and AIVE_NETWORK_GATE=enforce (CI) turns
 * it on. Device paths and keyless names are refused in both, and so is the
 * trust folder (rows 4, 11, 13).
 *
 * Rows 7 (its dispatch part), 10 (the engine's part) and 14 (the autosave)
 * need the gate enforced: in log mode they would let a test host through.
 *
 * No FFmpeg, no network. The only hosts are under the reserved .invalid
 * top-level domain (the 2.3 vectors only reach the pure classifier; the
 * second-spelling rows of 13 use an injected stat). Rows 3 and 12 start
 * scripts/trust-child.ts as second processes.
 * Run: npx tsx packages/core/scripts/smoke-unc.ts
 */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { execFile, execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { approvalDialogFor, bareFileName, classifyPath, normalizeHost } from "../src/unc.js";
import { assertLocalMediaPath, assertProjectMediaLocal, isLocalMediaPath, isProtocolLike } from "../src/safepath.js";
import { EditorEngine } from "../src/engine.js";
import * as gfs from "../src/io/gatedfs.js";
import { resolveDataDir } from "../src/datadir.js";
import { assertArgvReachable, ffmpegArgsLocalOnly, ffprobeArgsLocalOnly, runTool, spawnFfmpegStream } from "../src/ffmpeg/executor.js";
import { GateNetworkFsPlugin, gateInputFileSystem, graphicRequestRefusal } from "../src/motion/netgate.js";
import { approveHost, readTrustedHosts, revokeHost, TrustStoreError, withTrustLock, type ReadErrorInjection } from "../src/trusthosts.js";
import { HostTrust } from "../src/hosttrust.js";
import { StorageJanitor, storageUsage } from "../src/storage.js";
import { dispatch, methods, RpcError, RPC_PATH_PARAMS } from "../src/rpc.js";
import { isOffline, type Project } from "../src/types.js";

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};
const errOf = async (fn: () => unknown): Promise<string> => {
  try {
    await fn();
    return "(accepted)";
  } catch (err) {
    return (err as Error).message;
  }
};

// ---- fs / child_process trace ---------------------------------------------
// Every function of fs, fs/promises and child_process records any argument
// (strings, Buffers, URLs, argv arrays) that names a test host; the engine's
// named imports see the wrappers through syncBuiltinESMExports.
const TEST_HOST = /zr-evil/i;
const touched: string[] = [];
const names = (v: unknown, depth = 0): string[] => {
  if (typeof v === "string") return TEST_HOST.test(v) ? [v] : [];
  if (Buffer.isBuffer(v)) return names(v.toString("utf8"), depth);
  if (v instanceof URL) return names(v.href, depth);
  if (Array.isArray(v) && depth < 2) return v.flatMap((x) => names(x, depth + 1));
  return [];
};
const require = createRequire(import.meta.url);
/** The test's own writes of fixture text that names a test host go around the trace. */
const writeFixture = (require("node:fs") as typeof import("node:fs")).writeFileSync;
for (const mod of ["node:fs", "node:fs/promises", "node:child_process"]) {
  const m = require(mod) as Record<string, unknown>;
  for (const key of Object.keys(m)) {
    const orig = m[key];
    if (typeof orig !== "function" || /^[A-Z]/.test(key)) continue;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      for (const n of args.flatMap((a) => names(a))) touched.push(`${mod} ${key}(${n})`);
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };
    Object.assign(wrapped, orig);
    m[key] = wrapped;
  }
}
syncBuiltinESMExports();

async function main() {
  const enforced = gfs.NETWORK_GATE === "enforce" || process.env.AIVE_NETWORK_GATE === "enforce";
  console.log(`(network gate: ${enforced ? "enforced" : "log mode"}; AIVE_NETWORK_GATE=${process.env.AIVE_NETWORK_GATE ?? "(unset)"})`);
  /** console.error lines written while `fn` runs. */
  const logsOf = async (fn: () => unknown): Promise<string[]> => {
    const lines: string[] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      await fn();
    } finally {
      console.error = real;
    }
    return lines;
  };
  /** The error `fn` throws or rejects with, or null. */
  const thrown = async (fn: () => unknown): Promise<Error | null> => {
    try {
      await fn();
      return null;
    } catch (err) {
      return err as Error;
    }
  };
  const refusedForms = [`//./UNC/zr-evil-5.invalid/s/x`, `\\??\\UNC\\zr-evil-5.invalid\\s\\x`, `\\\\zr-evil-5.invalid@SSL\\s\\x`, new URL("file:///%5C%5Czr-evil-5.invalid/s/x")];

  // ---- 5a. gatedfs bootstrap, before any engine -----------------------------------
  // Row 5's first rows, run before anything else: every EditorEngine publishes
  // its approved servers (hosttrust.ts), so "before any setAllowedNetworkHosts"
  // holds only until the first engine is built.
  // MUTATION: see row 5 (let the bootstrap skip the refused check → the
  // refused rows here fail).
  console.log("5a. gatedfs bootstrap before any engine...");
  {
    const fsMod = require("node:fs") as Record<string, unknown>;
    const realStatSync = fsMod.statSync;
    const spied: string[] = [];
    fsMod.statSync = (...a: unknown[]) => {
      spied.push(`statSync(${a.map((x) => (x instanceof URL ? x.href : String(x))).join(", ")})`);
      return { isFile: () => true };
    };
    syncBuiltinESMExports();
    try {
      // datadir.ts's bootstrap allows a path on any server until the engine first sets the allowed servers.
      const early = await thrown(() => gfs.bootstrap.statSync("//zr-evil-5.invalid/s/x/server.json"));
      check(early === null && spied.length === 1, `bootstrap.statSync calls through before any setAllowedNetworkHosts (${early?.message}; ${JSON.stringify(spied)})`);
      // The bootstrap skips only the trust decision on a server: refused forms are refused before any setAllowedNetworkHosts too.
      for (const p of refusedForms) {
        spied.length = 0;
        const e = await thrown(() => gfs.bootstrap.statSync(p));
        check(e instanceof gfs.BlockedPathError && spied.length === 0, `bootstrap.statSync(${String(p)}) is refused before any setAllowedNetworkHosts, the real function is never called (${e?.message.slice(0, 90)}; ${JSON.stringify(spied)})`);
      }
    } finally {
      fsMod.statSync = realStatSync;
      syncBuiltinESMExports();
    }
  }

  // ---- 1. classifyPath: the plan's 2.3 vectors -----------------------------
  // MUTATION: make R3 require two backslashes (the old WIN_UNC) → the \/nas and
  // /\nas rows fail. Drop R2 (NT) → the \??\ rows fail. Accept non-strict IPv4
  // → the 127.1 row fails. Allow non-ASCII hosts (or convert them with URL) →
  // the Cyrillic, fullwidth, U+200B, U+00AD and U+3002 rows fail. Allow `%` →
  // the %6eas row fails.
  console.log("1. classifyPath...");
  const network: [string, string][] = [
    ["\\\\NAS\\Video\\a.mp4", "nas"],
    ["//nas/video/a.mp4", "nas"],
    ["\\/nas/video", "nas"],
    ["/\\nas\\video", "nas"],
    ["\\\\xn--ns-8kc\\s\\a.mp4", "xn--ns-8kc"],
    ["\\\\10.0.0.5\\s\\a.mp4", "10.0.0.5"],
    ["\\\\wsl$\\Ubuntu\\x", "wsl$"],
    ["\\\\wsl.localhost\\Ubuntu\\x", "wsl.localhost"],
  ];
  for (const [p, key] of network) {
    const c = classifyPath(p);
    check(c.kind === "network" && c.host === key && c.display === `\\\\${key}`, `network ${key}: ${JSON.stringify(p)} → ${JSON.stringify(c)}`);
  }
  // Each refusal's reason names the rule that failed (it is the middle sentence of the message).
  const CHARS = /^Only plain names/, IPV4 = /a\.b\.c\.d form/, IPV6 = /ipv6-literal/, NAME = /start or end with a dot/;
  const DEVICE = /device paths/, NT = /NT paths/, EMPTY = /no computer name/;
  const refused: [string, "device" | "nt" | "host", RegExp][] = [
    ["\\\\nas@SSL@443\\DavWWWRoot\\a.mp4", "host", CHARS],
    ["\\\\nas@8080\\x", "host", CHARS],
    ["\\\\nas@foo\\x", "host", CHARS],
    ["\\\\127.1\\s", "host", IPV4],
    ["\\\\0x7f.0.0.1\\s", "host", IPV4],
    ["\\\\2130706433\\s", "host", IPV4],
    ["\\\\fe80--1s4.ipv6-literal.net\\s", "host", IPV6],
    ["\\\\FE80-0-0-0-0-0-0-1.IPV6-LITERAL.NET\\s", "host", IPV6],
    ["\\\\[::1]\\s", "host", CHARS],
    ["\\\\nas.\\s", "host", NAME],
    ["\\\\.nas\\s", "host", NAME],
    ["\\\\na s\\s", "host", CHARS],
    ["\\\\nas:445\\s", "host", CHARS],
    ["\\\\n\u0430s\\s", "host", CHARS], // Cyrillic а
    ["\\\\\uFF4E\uFF41\uFF53\\s\\a.mp4", "host", CHARS], // fullwidth ｎａｓ
    ["\\\\na\u200Bs\\s\\a.mp4", "host", CHARS], // zero-width space
    ["\\\\NAS\u00AD\\s\\a.mp4", "host", CHARS], // soft hyphen
    ["\\\\nas\u3002corp\u3002example\\s", "host", CHARS], // ideographic full stop
    ["\\\\\u00F1%61s\\s", "host", CHARS],
    ["\\\\%6eas\\s", "host", CHARS],
    ["\\\\?\\C:\\x", "device", DEVICE],
    ["\\\\?\\UNC\\nas\\s", "device", DEVICE],
    ["//?/UNC/nas/s", "device", DEVICE],
    ["\\\\.\\pipe\\x", "device", DEVICE],
    ["//./UNC/nas", "device", DEVICE],
    ["\\??\\UNC\\nas\\s", "nt", NT],
    ["/??/UNC/nas/s", "nt", NT],
    ["\\\\\\nas\\s", "host", EMPTY], // empty host
  ];
  for (const [p, form, why] of refused) {
    const c = classifyPath(p);
    check(c.kind === "refused" && c.form === form && why.test(c.reason), `refused (${form}, ${why.source}): ${JSON.stringify(p)} → ${JSON.stringify(c)}`);
  }
  for (const p of ["C:\\v\\a.mp4", "/home/a.mp4", "media/a.mp4", "\\v\\a.mp4", "file://nas/s/x.png"]) {
    check(classifyPath(p).kind === "local", `local: ${JSON.stringify(p)}`);
  }
  // Name limits (rule 4): 63 per label, 253 in all; a hand-written "NAS" is "nas".
  check(JSON.stringify(normalizeHost("NAS")) === JSON.stringify({ ok: true, key: "nas" }), "normalizeHost lower-cases ASCII");
  check(normalizeHost(`${"a".repeat(63)}.x`).ok && !normalizeHost(`${"a".repeat(64)}.x`).ok, "a label has at most 63 characters");
  const name = (last: number) => `${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(last)}`;
  check(name(61).length === 253 && normalizeHost(name(61)).ok && !normalizeHost(name(62)).ok, "a name has at most 253 characters");
  check(!normalizeHost("nas..corp").ok, "an empty label is refused");

  // ---- 2. safepath integration ----------------------------------------------
  // MUTATION: restore the old WIN_DEVICE (backslash-only) refusal → the //?/,
  // //./ and \??\ rows fail. Let refused hosts through assertProjectMediaLocal
  // (assertMediaNotProtocol checks protocols only) → the @SSL rows fail.
  console.log("2. safepath integration...");
  const H = "zr-evil-1.invalid";
  const project = (assetPath: string, extra: Partial<Project["assets"][number]> = {}, lut?: string): Project =>
    ({
      assets: [{ id: "asset_a1", path: assetPath, name: "a", duration: 1, width: 64, height: 64, fps: 30, hasVideo: true, hasAudio: false, addedAt: 0, ...extra }],
      tracks: [{ id: "track_v", kind: "video", index: 0, clips: [{ id: "clip_c1", assetId: "asset_a1", startFrame: 0, sourceInFrame: 0, sourceOutFrame: 10, ...(lut ? { effects: { lut } } : {}) }] }],
    }) as unknown as Project;
  const loadErr = (p: Project) => errOf(() => assertProjectMediaLocal(p));
  for (const p of [`//?/UNC/${H}/s/a.mp4`, `//./UNC/${H}/s/a.mp4`, `\\??\\UNC\\${H}\\s\\a.mp4`]) {
    const e = await loadErr(project(p));
    check(/device path|NT path/.test(e) && /asset "asset_a1" path/.test(e), `load refuses asset.path ${JSON.stringify(p)} (${e.slice(0, 90)})`);
  }
  for (const p of [`\\\\${H}\\s\\a.mp4`, `//${H}/s/a.mp4`, `\\/${H}/s/a.mp4`]) {
    check((await loadErr(project(p))) === "(accepted)", `load still accepts asset.path ${JSON.stringify(p)}`);
    check(isLocalMediaPath(p), `isLocalMediaPath accepts ${JSON.stringify(p)} (absolute)`);
  }
  const dav = `\\\\${H}@SSL\\DavWWWRoot\\a.mp4`;
  const davErr = await loadErr(project(dav));
  check(/^asset "asset_a1" path ".*" names the network computer "zr-evil-1\.invalid@SSL"/.test(davErr) && /Map that folder to a drive letter/.test(davErr) && /open the project again/.test(davErr),
    `load refuses an @SSL asset.path with the fix-it message (${davErr})`);
  const lutErr = await loadErr(project("/x/a.mp4", {}, `\\\\${H}@SSL\\DavWWWRoot\\look.cube`));
  check(/^clip "clip_c1" LUT path/.test(lutErr) && /Map that folder to a drive letter/.test(lutErr), `load refuses an @SSL clip LUT (${lutErr.slice(0, 90)})`);
  const cutErr = await loadErr(project("/x/a.mp4", { cutout: { colorPath: dav, colorStart: 0 } }));
  check(/cutout colour path/.test(cutErr) && /Map that folder/.test(cutErr), `load refuses an @SSL cutout colour path (${cutErr.slice(0, 90)})`);
  const cached = project("/x/a.mp4", { proxyPath: dav, previewPath: `//?/UNC/${H}/s/p.mp4` });
  const cachedErr = await loadErr(cached);
  check(cachedErr === "(accepted)" && cached.assets[0].proxyPath === undefined && cached.assets[0].previewPath === undefined,
    `an @SSL proxyPath and a device previewPath are dropped and the load goes on (${cachedErr})`);
  check(isProtocolLike(dav) && isProtocolLike(`\\??\\x`) && !isProtocolLike(`\\\\${H}\\s\\a.mp4`), "isProtocolLike: refused forms never reach FFmpeg; a usable network path is not protocol-like");
  const rpcErr = await errOf(() => assertLocalMediaPath(dav, "import path"));
  check(/names the network computer/.test(rpcErr) && /Only plain names/.test(rpcErr) && /and use that path instead\.$/.test(rpcErr) && !/project file/.test(rpcErr),
    `assertLocalMediaPath refuses it with the rpc wording (${rpcErr})`);
  check(!rpcErr.includes("`"), `the refusal is plain text, with no Markdown backticks (${rpcErr})`);
  // An empty server name has its own sentence: no `names the network computer ""`.
  const emptyErr = await errOf(() => assertLocalMediaPath(`\\\\\\${H}\\s\\a.mp4`, "import path"));
  check(/^import path ".*" has no computer name after its leading slashes, which .* can't use\. Map that folder to a drive letter, or use the computer's plain name, and use that path instead\.$/.test(emptyErr) && !emptyErr.includes('""'),
    `an empty server name gets its own sentence, with no empty quotes (${emptyErr})`);
  const emptyLoad = await loadErr(project(`\\\\\\${H}\\s\\a.mp4`));
  check(/has no computer name after its leading slashes/.test(emptyLoad) && /open the project again\.$/.test(emptyLoad) && !emptyLoad.includes('""'), `load gives it the project-file fix (${emptyLoad})`);
  // A device path: the rpc fix says "use" once; the project-file fix is unchanged.
  const devErr = await errOf(() => assertLocalMediaPath(`//?/UNC/${H}/s/a.mp4`, "import path"));
  check(/is a Windows device path .* does not open\. Map that folder to a drive letter or a \\\\server\\share path, and use that path instead\.$/.test(devErr) && !/Use a drive-letter/.test(devErr),
    `a device path's rpc refusal says how to fix it without "Use … and use" (${devErr})`);
  const devLoad = await loadErr(project(`//?/UNC/${H}/s/a.mp4`));
  check(/does not open\. Use a drive-letter or \\\\server\\share path, then change this path in the project file/.test(devLoad), `a device path's load refusal keeps the project-file wording (${devLoad})`);
  const ipErr = await errOf(() => assertLocalMediaPath("\\\\127.1\\s\\a.mp4", "import path"));
  check(/Write the address in the usual a\.b\.c\.d form\./.test(ipErr), `the middle sentence names the rule that failed (${ipErr.slice(0, 120)})`);
  const zwErr = await errOf(() => assertLocalMediaPath("\\\\na\u200Bs.invalid\\s\\a.mp4", "import path"));
  check(zwErr.includes('"na\\u{200b}s.invalid"'), `a hidden character in a server name is shown (${zwErr.slice(0, 120)})`);
  check(assertLocalMediaPath(`/\\${H}\\s\\a.mp4`, "f") === `/\\${H}\\s\\a.mp4`, "assertLocalMediaPath returns a usable network path");

  // ---- 2b. engine entry points ------------------------------------------------
  // MUTATION: remove assertPathUsable from any engine method → its row fails
  // (load_project: the trace also sees a readFile of the path). Make
  // isProtocolLike check protocols only → the trace sees ffprobe spawned on the
  // .otio's target_url. Remove the classifyPath skip from rememberMany → the
  // trace sees its stat.
  console.log("2b. engine entry points refuse and never touch the path...");
  const root = mkdtempSync(join(tmpdir(), "aive-unc-"));
  // A relative write that slips through (a mutation) lands in the temp dir.
  const cwd = process.cwd();
  process.chdir(root);
  const engine = new EditorEngine(join(root, "data"));
  const controlFile = join(root, "zr-evil-control.aive");
  await errOf(() => engine.load(controlFile));
  check(touched.some((t) => t.includes(controlFile)), `the trace sees the engine's fs calls (${touched.length} recorded for a local control file)`);
  touched.length = 0;

  const bad = (n: number) => `\\\\zr-evil-${n}.invalid@SSL\\s\\x`;
  const rpcRows: [string, () => unknown][] = [
    ["load_project", () => engine.load(`${bad(2)}.aive`)],
    ["load_project (device)", () => engine.load(`//./UNC/zr-evil-2.invalid/s/x.aive`)],
    ["load_project (NT)", () => engine.load(`\\??\\UNC\\zr-evil-2.invalid\\s\\x.aive`)],
    ["import_otio", () => engine.importOtio(`${bad(3)}.otio`)],
    ["import_captions", () => engine.importCaptions("clip_none", `${bad(3)}.srt`)],
    ["save_project", () => engine.save(`${bad(4)}.aive`)],
    ["export_video", () => engine.startExportJob(`${bad(4)}.mp4`)],
    ["export_otio", () => engine.exportOtio(`${bad(4)}.otio`)],
    ["export_captions", () => engine.exportCaptions(`${bad(4)}.srt`)],
    ["import_video", () => engine.importVideo(`${bad(5)}.mp4`)],
    ["apply_lut", () => engine.setClipEffects("clip_none", { lut: `${bad(5)}.cube` })],
    ["add_text font", () => engine.addTextOverlay("clip_none", { text: "t", font: `${bad(5)}.ttf` })],
    ["set_text_style font", () => engine.setTextStyle("clip_none", undefined, { font: `${bad(5)}.ttf` })],
    ["generate_captions font", () => engine.generateCaptions("clip_none", { style: { font: `${bad(5)}.ttf` } })],
    ["set_caption_style font", () => engine.setCaptionStyle("clip_none", { font: `${bad(5)}.ttf` })],
  ];
  for (const [name, fn] of rpcRows) {
    const e = await errOf(fn);
    check((/names the network computer/.test(e) || /device path|NT path/.test(e)) && /use that path instead\.$/.test(e), `${name} refuses (${e.slice(0, 100)})`);
  }
  const remembered = await engine.storage.rememberMany([`${bad(6)}.aive`, `//?/UNC/zr-evil-6.invalid/s/x.aive`]);
  check(remembered.added.length === 0 && remembered.skipped.length === 2, `remember_projects skips both (${JSON.stringify(remembered.skipped)})`);

  // A project file (local) whose media names a keyless server: refused, never probed.
  const aive = join(root, "dav.aive");
  writeFixture(aive, JSON.stringify(project(bad(7))));
  const aiveErr = await errOf(() => engine.load(aive));
  check(/names the network computer/.test(aiveErr) && /open the project again\.$/.test(aiveErr), `load of a local .aive naming an @SSL asset is refused (${aiveErr.slice(0, 100)})`);
  // A foreign OTIO (no ZabsReel metadata): its target_url is never probed.
  const rt = (value: number) => ({ OTIO_SCHEMA: "RationalTime.1", rate: 30, value });
  const otio = {
    OTIO_SCHEMA: "Timeline.1",
    name: "t",
    tracks: { OTIO_SCHEMA: "Stack.1", children: [{ OTIO_SCHEMA: "Track.1", kind: "Video", children: [{
      OTIO_SCHEMA: "Clip.2",
      name: "c",
      source_range: { OTIO_SCHEMA: "TimeRange.1", start_time: rt(0), duration: rt(30) },
      active_media_reference_key: "DEFAULT_MEDIA",
      media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", target_url: `${bad(8)}.mp4` } },
    }] }] },
  };
  writeFixture(join(root, "dav.otio"), JSON.stringify(otio));
  const otioErr = await errOf(() => engine.importOtio(join(root, "dav.otio")));
  check(/names the network computer/.test(otioErr), `import_otio of a local .otio naming an @SSL target_url is refused (${otioErr.slice(0, 100)})`);

  check(touched.length === 0, `no fs or child_process call saw a test host (${JSON.stringify(touched.slice(0, 5))})`);
  process.chdir(cwd);


  // ---- 5. G8 gatedfs ----------------------------------------------------------
  // MUTATION: remove the check from copyFile's or rename's second argument
  // (paths [0, 1] → [0]) → the copyFile-to / rename-to rows fail (the spy sees
  // the call); [0, 1] → [1] → the rename-from rows fail. Make existsSync
  // call through → its rows fail. Let refused forms through (return null for
  // "refused" in blocked()) → the device / @SSL rows fail in both modes. Ignore
  // ENFORCED → the enforce rows fail under AIVE_NETWORK_GATE=enforce. Let the
  // bootstrap skip the refused check (bootstrapping before the refused test in
  // blocked()) → the early bootstrap rows fail. Drop assertUsable from
  // resolveDataDir → the data folder rows fail. Drop R5 from classifyFsText →
  // the R5 rows fail.
  console.log("5. G8 gatedfs: nothing reaches the real fs function unless allowed...");
  const spied: string[] = [];
  const fsMod = require("node:fs") as Record<string, unknown>;
  const fspMod = require("node:fs/promises") as Record<string, unknown>;
  const spies: [Record<string, unknown>, string, unknown][] = [
    [fspMod, "stat", async () => ({ spy: true })],
    [fspMod, "readFile", async () => "spy"],
    [fspMod, "copyFile", async () => undefined],
    [fspMod, "rename", async () => undefined],
    [fspMod, "readdir", async () => []],
    [fsMod, "createReadStream", () => ({ spy: true })],
    [fsMod, "existsSync", () => true],
    [fsMod, "statSync", () => ({ isFile: () => true })],
  ];
  const saved = spies.map(([m, k]) => [m, k, m[k]] as const);
  for (const [m, k, impl] of spies) {
    m[k] = (...a: unknown[]) => {
      spied.push(`${k}(${a.map((x) => (typeof x === "string" ? x : x instanceof URL ? x.href : Buffer.isBuffer(x) ? x.toString() : typeof x)).join(", ")})`);
      return (impl as (...a: unknown[]) => unknown)(...a);
    };
  }
  syncBuiltinESMExports();
  try {
    const NET = "//zr-evil-5.invalid/s/x";
    const LOCAL = join(root, "local-file");
    check(gfs.networkGateEnforced() === enforced, `networkGateEnforced() is ${enforced} (NETWORK_GATE "${gfs.NETWORK_GATE}"; only the variable's "enforce" changes it)`);
    // (The bootstrap rows "before any setAllowedNetworkHosts" run first in main(), before any engine exists.)
    // datadir.ts refuses such a folder at startup, where the cause is, and touches nothing.
    for (const [label, opts] of [
      ["AIVE_DATA_DIR \\\\?\\C:\\zr", { env: { AIVE_DATA_DIR: "\\\\?\\C:\\zr" }, home: root }],
      ["AIVE_DATA_DIR //./x", { env: { AIVE_DATA_DIR: "//./x" }, home: root }],
      ["AIVE_DATA_DIR \\??\\C:\\zr", { env: { AIVE_DATA_DIR: "\\??\\C:\\zr" }, home: root }],
      ["AIVE_DATA_DIR on a keyless server", { env: { AIVE_DATA_DIR: "\\\\zr-evil-5.invalid@SSL\\zr" }, home: root }],
      ["a home folder //./x", { env: {}, home: "//./x" }],
    ] as const) {
      spied.length = 0;
      const e = await thrown(() => resolveDataDir(opts));
      check(e !== null && /can't be the .* data folder: .* Set AIVE_DATA_DIR to a folder on a drive letter/.test(e.message) && spied.length === 0,
        `resolveDataDir refuses ${label} at startup, without touching it (${e?.message.slice(0, 140)}; ${JSON.stringify(spied)})`);
    }
    const okDir = join(root, "data-ok");
    const okData = await thrown(() => resolveDataDir({ env: { AIVE_DATA_DIR: okDir }, home: root }));
    check(okData === null && resolveDataDir({ env: { AIVE_DATA_DIR: okDir }, home: root }).dir === okDir, `resolveDataDir accepts a local AIVE_DATA_DIR (${okData?.message})`);
    const netData = await thrown(() => resolveDataDir({ env: { AIVE_DATA_DIR: "\\\\zr-evil-5.invalid\\zr" }, home: root }));
    check(netData === null, `resolveDataDir accepts an AIVE_DATA_DIR on a network computer (the plan trusts the data folder's server) (${netData?.message})`);
    gfs.setAllowedNetworkHosts([]);

    const calls: [string, (p: unknown) => unknown][] = [
      ["stat", (p) => gfs.stat(p as string)],
      ["readFile", (p) => gfs.readFile(p as string)],
      ["copyFile from", (p) => gfs.copyFile(p as string, LOCAL)],
      ["copyFile to", (p) => gfs.copyFile(LOCAL, p as string)],
      ["rename from", (p) => gfs.rename(p as string, LOCAL)],
      ["rename to", (p) => gfs.rename(LOCAL, p as string)],
      ["createReadStream", (p) => gfs.createReadStream(p as string)],
      ["readdir", (p) => gfs.readdir(p as string)],
      ["bootstrap.statSync", (p) => gfs.bootstrap.statSync(p as string)],
    ];
    // Refused forms: never approvable, so refused in both modes and after any approval.
    gfs.setAllowedNetworkHosts(["zr-evil-5.invalid"]);
    for (const p of refusedForms) {
      for (const [name, call] of calls) {
        spied.length = 0;
        const e = await thrown(() => call(p));
        check(e instanceof gfs.BlockedPathError && spied.length === 0, `${name}(${String(p)}) is refused, the real function is never called (${e?.message.slice(0, 90)}; ${JSON.stringify(spied)})`);
      }
      spied.length = 0;
      check(gfs.existsSync(p as string) === false && spied.length === 0, `existsSync(${String(p)}) is false without calling the real function`);
    }
    gfs.setAllowedNetworkHosts([]);

    // A server that is not allowed: refused when enforced; logged once and let through in log mode.
    for (const p of [NET, `\\\\zr-evil-5.invalid\\s\\x`, Buffer.from(NET), new URL(`file:${NET}`)]) {
      const shown = Buffer.isBuffer(p) ? `Buffer(${p})` : String(p);
      for (const [name, call] of calls) {
        spied.length = 0;
        const e = await thrown(() => call(p));
        if (enforced) {
          check(e instanceof gfs.BlockedPathError && e.host === "zr-evil-5.invalid" && /has not been allowed/.test(e.message) && spied.length === 0,
            `enforced: ${name}(${shown}) is refused with the typed error, the real function is never called (${e?.message.slice(0, 80)}; ${JSON.stringify(spied)})`);
        } else {
          check(e === null && spied.length === 1, `log mode: ${name}(${shown}) calls through (${e?.message}; ${JSON.stringify(spied)})`);
        }
      }
      spied.length = 0;
      const exists = gfs.existsSync(p as string);
      check(enforced ? exists === false && spied.length === 0 : exists === true && spied.length === 1, `${enforced ? "enforced" : "log mode"}: existsSync(${shown}) ${enforced ? "is false without calling the real function" : "calls through"}`);
    }
    const logged = await logsOf(async () => {
      await thrown(() => gfs.stat("//zr-evil-5b.invalid/s/x"));
      await thrown(() => gfs.readFile("//ZR-EVIL-5B.invalid/s/y"));
    });
    check(logged.length === 1 && logged[0].includes(enforced ? "blocked \\\\zr-evil-5b.invalid" : "would block \\\\zr-evil-5b.invalid"), `one log line per server (${JSON.stringify(logged)})`);

    // Allowed: every call goes through.
    gfs.setAllowedNetworkHosts(["zr-evil-5.invalid"]);
    for (const [name, call] of calls) {
      spied.length = 0;
      const e = await thrown(() => call(NET));
      check(e === null && spied.length === 1, `allowed: ${name}(${NET}) calls through (${e?.message}; ${JSON.stringify(spied)})`);
    }
    spied.length = 0;
    check(gfs.existsSync(NET) === true && spied.length === 1, "allowed: existsSync calls through");
    gfs.setAllowedNetworkHosts([]);
    spied.length = 0;
    check((await thrown(() => gfs.stat(LOCAL))) === null && spied.length === 1, "a local path always calls through");

    // R5 (Windows only): a relative path is also classified where it resolves, so a cwd on a share is covered.
    const SHARE = "\\\\zr-evil-5c.invalid\\s";
    const win = (cwd: string) => ({ platform: "win32" as const, cwd });
    for (const [p, cwd, kind, why] of [
      ["v.txt", SHARE, "network", "a relative name in a cwd on a share"],
      ["sub\\..\\v.txt", SHARE, "network", "a relative path with .. stays on the share"],
      ["\\v.txt", SHARE, "network", "a root-relative path takes the share's root"],
      ["v.txt", "C:\\work", "local", "a relative name in a local cwd"],
      ["C:\\v\\a.mp4", SHARE, "local", "a full drive-letter path never depends on the cwd"],
      ["v.txt", "\\\\?\\C:\\work", "refused", "a relative name in a device-path cwd"],
    ] as const) {
      const a = gfs.fsArgPath(p, win(cwd));
      check(a?.c.kind === kind && (kind !== "network" || (a.c.kind === "network" && a.c.host === "zr-evil-5c.invalid" && /^\\\\zr-evil-5c\.invalid\\s\\/.test(a.text))),
        `R5: ${why}: ${JSON.stringify(p)} in ${JSON.stringify(cwd)} is ${kind} (${JSON.stringify(a)})`);
    }
    check(gfs.fsArgPath("v.txt", { platform: "linux", cwd: SHARE })?.c.kind === "local", "R5 is Windows only: on Linux a relative name stays local");
    check(gfs.fsArgPath(Buffer.from("v.txt"), win(SHARE))?.c.kind === "network", "R5 covers a Buffer path too");
    spied.length = 0;
    const r5: { e: Error | null } = { e: null };
    const r5Log = await logsOf(async () => void (r5.e = await thrown(() => gfs.assertReachable("v.txt", "stat", win(SHARE)))));
    const r5e = r5.e;
    if (enforced) {
      check(r5e instanceof gfs.BlockedPathError && r5e.host === "zr-evil-5c.invalid" && r5Log.length === 1 && r5Log[0].includes("blocked \\\\zr-evil-5c.invalid"),
        `enforced: R5 refuses a relative name in a cwd on a share that is not allowed (${r5e?.message}; ${JSON.stringify(r5Log)})`);
    } else {
      check(r5e === null && r5Log.length === 1 && r5Log[0].includes("would block \\\\zr-evil-5c.invalid"), `log mode: R5 logs a relative name in a cwd on a share that is not allowed and lets it through (${r5e?.message}; ${JSON.stringify(r5Log)})`);
    }
    const localLog = await logsOf(() => gfs.assertReachable("v2.txt", "stat", win("C:\\work")));
    check(localLog.length === 0, `R5: a relative name in a local cwd is neither logged nor refused (${JSON.stringify(localLog)})`);
  } finally {
    for (const [m, k, orig] of saved) m[k] = orig;
    syncBuiltinESMExports();
    gfs.setAllowedNetworkHosts([]);
  }

  // ---- 6. G7 argv ---------------------------------------------------------------
  // MUTATION: check only the argument after -i in assertArgvReachable → the
  // output and cwd rows fail (the refused-output rows in both modes). Skip the
  // -f concat list → the list rows fail. Drop the check from ffprobeArgsLocalOnly
  // → its rows fail. Drop the Windows process-cwd check → the "no spawn cwd" R5
  // row fails (the error names an argument). Resolve the arguments in the
  // process's cwd instead of the spawn cwd → the "local spawn cwd" R5 row fails.
  console.log("6. G7 argv: every argument, the cwd and each concat list entry...");
  touched.length = 0;
  const g7 = (fn: () => unknown) => thrown(fn);
  const list = (name: string, body: string) => {
    writeFixture(join(root, name), body);
    return join(root, name);
  };
  const NET6 = "//zr-evil-6.invalid/s/a.mp4";
  const REFUSED6 = "\\\\zr-evil-6.invalid@SSL\\s\\a.mp4";
  const DEVICE6 = "//./UNC/zr-evil-6.invalid/s/a.mp4";
  const netRows: [string, () => unknown][] = [
    ["ffmpeg -i", () => ffmpegArgsLocalOnly(["-i", NET6, "-f", "null", "-"])],
    ["ffmpeg output", () => ffmpegArgsLocalOnly(["-i", "/tmp/a.mp4", "-c", "copy", NET6])],
    ["ffmpeg cwd", () => ffmpegArgsLocalOnly(["-i", "a.mp4", "-c", "copy", "b.mp4"], "//zr-evil-6.invalid/s")],
    ["ffmpeg -f concat list entry", () => ffmpegArgsLocalOnly(["-f", "concat", "-safe", "0", "-i", list("list-net.txt", `ffconcat version 1.0\nfile '/tmp/ok.mp4'\nfile '${NET6}'\n`), "-c", "copy", "/tmp/o.mp4"])],
    ["ffmpeg -f concat list by bare name in cwd", () => ffmpegArgsLocalOnly(["-f", "concat", "-safe", "0", "-i", "list-net.txt", "-c", "copy", "o.mp4"], root)],
    ["ffprobe input", () => ffprobeArgsLocalOnly(["-v", "error", "-of", "json", NET6])],
  ];
  for (const [name, fn] of netRows) {
    const e = await g7(fn);
    check(enforced ? e instanceof gfs.BlockedPathError && e.host === "zr-evil-6.invalid" : e === null,
      `${enforced ? "enforced" : "log mode"}: ${name} on a server that is not allowed is ${enforced ? "refused" : "let through"} (${e?.message.slice(0, 90)})`);
  }
  const refusedRows: [string, () => unknown][] = [
    ["ffmpeg -i (keyless name)", () => ffmpegArgsLocalOnly(["-i", REFUSED6, "-f", "null", "-"])],
    ["ffmpeg output (keyless name)", () => ffmpegArgsLocalOnly(["-i", "/tmp/a.mp4", "-c", "copy", REFUSED6])],
    ["ffmpeg output (device)", () => ffmpegArgsLocalOnly(["-i", "/tmp/a.mp4", "-c", "copy", DEVICE6])],
    ["ffmpeg cwd (device)", () => ffmpegArgsLocalOnly(["-i", "a.mp4", "b.mp4"], "//?/UNC/zr-evil-6.invalid/s")],
    ["ffmpeg -f concat entry (keyless, quoted)", () => ffmpegArgsLocalOnly(["-f", "concat", "-i", list("list-dav.txt", `file '${REFUSED6.replace(/\\/g, "/")}'\n`), "o.mp4"])],
    ["ffmpeg -f concat entry (device, escaped)", () => ffmpegArgsLocalOnly(["-f", "concat", "-i", list("list-dev.txt", "  file \\\\\\\\.\\\\UNC\\\\zr-evil-6.invalid\\\\s\\\\a.mp4\r\n"), "o.mp4"])],
    ["ffmpeg -f concat list that can't be read", () => ffmpegArgsLocalOnly(["-f", "concat", "-i", join(root, "no-such-list.txt"), "o.mp4"])],
    ["ffprobe input (device)", () => ffprobeArgsLocalOnly(["-v", "error", DEVICE6])],
    ["spawnFfmpegStream (keyless name)", () => spawnFfmpegStream(["-i", REFUSED6, "-f", "null", "-"], { reject: false })],
    ["runTool (whisper, keyless name)", () => runTool("zr-no-such-tool", ["-f", REFUSED6], { reject: false })],
  ];
  for (const [name, fn] of refusedRows) {
    const e = await g7(fn);
    check(e !== null && (e instanceof gfs.BlockedPathError || /concat list can't be read|its list can't be read/.test(e.message)), `${name} is refused in every mode (${e?.message.slice(0, 100)})`);
  }
  // R5 (Windows only): relative arguments resolve in the spawn cwd, or in the process's own cwd when none is given,
  // which is then checked as the spawn cwd (Windows opens it to start the child).
  const share6 = (h: string) => `\\\\zr-evil-${h}.invalid\\s`;
  for (const [label, cwd, ctx, at] of [
    ["no spawn cwd, the process's cwd on a share", undefined, { platform: "win32" as const, cwd: share6("6c") }, share6("6c")],
    ["a relative spawn cwd in a process cwd on a share", "work", { platform: "win32" as const, cwd: share6("6d") }, `${share6("6d")}\\work`],
  ] as const) {
    let e: Error | null = null;
    const lines = await logsOf(async () => void (e = await g7(() => assertArgvReachable(["-i", "v.txt", "-c", "copy", "o.mp4"], cwd, ctx))));
    const err = e as Error | null;
    check(enforced ? err instanceof gfs.BlockedPathError && err.path === at && err.host !== undefined : err === null && lines.length === 1 && lines[0].includes(`spawn cwd ${JSON.stringify(at)}`),
      `${enforced ? "enforced" : "log mode"}: R5 argv, ${label}: ${enforced ? "refused, naming the folder" : "logged once, naming the folder, and let through"} (${err?.message.slice(0, 90)}; ${JSON.stringify(lines)})`);
  }
  for (const [label, cwd, ctx] of [
    ["a local spawn cwd in a process cwd on a share: the arguments resolve in the spawn cwd", "C:\\work", { platform: "win32" as const, cwd: share6("6e") }],
    ["the process's cwd local", undefined, { platform: "win32" as const, cwd: "C:\\work" }],
    ["R5 is Windows only", undefined, { platform: "linux" as const, cwd: share6("6f") }],
  ] as const) {
    let e: Error | null = null;
    const lines = await logsOf(async () => void (e = await g7(() => assertArgvReachable(["-i", "v.txt", "-c", "copy", "o.mp4"], cwd, ctx))));
    const err = e as Error | null;
    check(err === null && lines.length === 0, `R5 argv, ${label}: a relative 'v.txt' passes, nothing logged (${err?.message}; ${JSON.stringify(lines)})`);
  }
  const fine = await g7(() => ffmpegArgsLocalOnly(["-f", "concat", "-safe", "0", "-i", list("list-ok.txt", "file '/tmp/a.mp4'\nfile 'b.mp4'\n# file '//zr-evil-6.invalid/s/c.mp4'\n"), "-c", "copy", "/tmp/o.mp4"]));
  check(fine === null, `a concat list of local files (and a commented-out line) passes (${fine?.message})`);
  check(touched.length === 0, `no fs or child_process call saw a test host (${JSON.stringify(touched.slice(0, 5))})`);

  // ---- 8. the import lint ---------------------------------------------------------
  // MUTATION: drop the dynamic-import form from check-io-imports.mjs → its
  // self-test fails. Import node:fs in any core file → the real scan fails.
  console.log("8. check-io-imports...");
  const lint = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "check-io-imports.mjs");
  for (const args of [["--self-test"], []]) {
    let out: string;
    try {
      out = execFileSync(process.execPath, [lint, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      out = `exit ${(err as { status?: number }).status}: ${String((err as { stdout?: string }).stdout ?? "")}${String((err as { stderr?: string }).stderr ?? "")}`;
    }
    check(/\[check-io-imports\] (self-test )?ok/.test(out) && !/FAIL/.test(out), `check-io-imports ${args.join(" ") || "(the core)"} passes (${out.trim().split("\n").slice(-2).join(" | ").slice(0, 200)})`);
  }

  // ---- 11. G9 graphic bundling ------------------------------------------------------
  // MUTATION: drop the file: rule from graphicRequestRefusal (localPart returns
  // true for any classifyPath-local part) → the file:// rows pass through. Make
  // gateInputFileSystem call the real read first → the spy rows fail. Drop the
  // no-callback throw → the "without a callback" rows fail. Leave the trust
  // folder out of the wrapper (CONTENT_READS empty) → the trust rows' spy sees
  // the read.
  console.log("11. G9: graphic imports and webpack's file system...");
  touched.length = 0;
  const G9 = /^graphics can only import local files and installed packages: /;
  for (const r of [
    "//zr-evil-6.invalid/s/x",
    "\\\\zr-evil-6.invalid\\s\\x",
    "file://zr-evil-6.invalid/s/x.png",
    "FILE://zr-evil-6.invalid/s/x.png",
    "file:\\\\zr-evil-6.invalid\\s\\x.png",
    "file:///%5C%5Czr-evil-6.invalid/s/x.png",
    "raw-loader!//zr-evil-6.invalid/x",
    "file://zr-evil-6.invalid/s/x.png?q",
    "\\??\\UNC\\zr-evil-6.invalid\\s\\x",
    "//?/UNC/zr-evil-6.invalid/s/x",
    "file:///%E0%A4%A",
  ]) {
    const why = graphicRequestRefusal(r);
    check(why !== null && G9.test(why), `refused: ${JSON.stringify(r)} (${why})`);
  }
  for (const r of ["./x", "react", "/tmp/x.png", "file:///tmp/x.png", "file://localhost/tmp/x.png", "!!raw-loader!./x.txt?raw", "C:\\v\\x.png"]) {
    check(graphicRequestRefusal(r) === null, `allowed: ${JSON.stringify(r)}`);
  }
  const fakeCalls: string[] = [];
  const fakeFs: Record<string, unknown> = {};
  for (const name of ["stat", "lstat", "readFile", "readdir", "readlink", "realpath", "readJson"]) {
    fakeFs[name] = (p: string, ...rest: unknown[]) => {
      fakeCalls.push(`${name}(${p})`);
      (rest[rest.length - 1] as (e: Error | null, v?: unknown) => void)(null, "real");
    };
    fakeFs[`${name}Sync`] = (p: string) => {
      fakeCalls.push(`${name}Sync(${p})`);
      return "real";
    };
  }
  gateInputFileSystem(fakeFs);
  const viaFs = (name: string, p: string) =>
    new Promise<{ err: Error | null; value: unknown }>((res) => (fakeFs[name] as (...a: unknown[]) => void)(p, {}, (err: Error | null, value: unknown) => res({ err, value })));
  for (const p of ["//zr-evil-6.invalid/s/x", "\\\\zr-evil-6.invalid\\s\\x", "\\\\?\\UNC\\zr-evil-6.invalid\\s\\x"]) {
    for (const name of ["stat", "lstat", "readFile", "readdir", "readlink", "realpath", "readJson"]) {
      fakeCalls.length = 0;
      const r = await viaFs(name, p);
      const syncErr = await thrown(() => (fakeFs[`${name}Sync`] as (p: string) => unknown)(p));
      check(r.err !== null && G9.test(r.err.message) && syncErr !== null && G9.test(syncErr.message) && fakeCalls.length === 0,
        `wrapped ${name} / ${name}Sync(${JSON.stringify(p)}) call back / throw the G9 error, the real read is never called (${JSON.stringify(fakeCalls)})`);
    }
  }
  // Without a callback (a promise-style caller), the wrapper throws the G9 error rather than return undefined.
  for (const name of ["stat", "readFile"]) {
    fakeCalls.length = 0;
    const noCb = await thrown(() => (fakeFs[name] as (p: string) => unknown)("//zr-evil-6.invalid/s/x"));
    check(noCb !== null && G9.test(noCb.message) && fakeCalls.length === 0, `wrapped ${name} without a callback throws the G9 error, the real read is never called (${noCb?.message.slice(0, 80)}; ${JSON.stringify(fakeCalls)})`);
  }
  fakeCalls.length = 0;
  const localRead = await viaFs("readFile", "/tmp/x.tsx");
  check(localRead.err === null && localRead.value === "real" && fakeCalls.length === 1, "a local read goes to the real file system");
  // The plugin: wraps the compiler's input file system and taps beforeResolve of both factories.
  const taps: ((d: { request?: unknown } | undefined) => unknown)[] = [];
  const factory = { hooks: { beforeResolve: { tap: (_n: string, fn: (d: { request?: unknown } | undefined) => unknown) => void taps.push(fn) } } };
  const compilerFs: Record<string, unknown> = { stat: (_p: string, cb: (e: Error | null) => void) => cb(null) };
  new GateNetworkFsPlugin().apply({
    inputFileSystem: compilerFs,
    hooks: { normalModuleFactory: { tap: (_n, fn) => void fn(factory) }, contextModuleFactory: { tap: (_n, fn) => void fn(factory) } },
  });
  const tapErr = await Promise.all(taps.map((t) => thrown(() => t({ request: "file://zr-evil-6.invalid/s/x.png" }))));
  check(taps.length === 2 && tapErr.every((e) => e !== null && G9.test(e.message)), `the plugin taps both factories' beforeResolve and refuses there (${tapErr.map((e) => e?.message.slice(0, 60)).join(" | ")})`);
  check(taps.every((t) => t({ request: "./Graphic" }) === undefined), "a local request continues (undefined keeps the waterfall's data)");
  const compilerStat = await new Promise<Error | null>((res) => (compilerFs.stat as (p: string, cb: (e: Error | null) => void) => void)("//zr-evil-6.invalid/s/x", res));
  check(compilerStat !== null && G9.test(compilerStat.message), "the plugin wraps the compiler's input file system");
  // The trust folder: content reads are refused in every mode, metadata reads still go through.
  const qRoot = join(root, "q");
  const qTrust = join(qRoot, "trust");
  gfs.setTrustDir(qTrust);
  for (const p of [join(qTrust, "hosts.key"), `${qRoot}/work/../trust/hosts.key`]) {
    for (const name of ["readFile", "readJson"]) {
      fakeCalls.length = 0;
      const r = await viaFs(name, p);
      const syncErr = await thrown(() => (fakeFs[`${name}Sync`] as (p: string) => unknown)(p));
      check(r.err !== null && G9.test(r.err.message) && syncErr !== null && G9.test(syncErr.message) && fakeCalls.length === 0,
        `trust folder: wrapped ${name} / ${name}Sync(${JSON.stringify(p)}) call back / throw the G9 error, the real read is never called (${JSON.stringify(fakeCalls)})`);
    }
  }
  for (const name of ["stat", "readdir"]) {
    fakeCalls.length = 0;
    const r = await viaFs(name, join(qTrust, "hosts.key"));
    check(r.err === null && fakeCalls.length === 1, `trust folder: wrapped ${name} still calls through (${r.err?.message}; ${JSON.stringify(fakeCalls)})`);
  }
  check(touched.length === 0, `no fs or child_process call saw a test host (${JSON.stringify(touched.slice(0, 5))})`);

  // ---- shared by rows 3, 4, 12 and 13 ------------------------------------------------
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const trustRoot = join(root, "trust-tests");
  mkdirSync(trustRoot, { recursive: true });
  let dataN = 0;
  /** A fresh data folder (this process has never read its store). */
  const freshData = () => join(trustRoot, `d${dataN++}`);
  const listFile = (d: string) => join(d, "trust", "hosts.json");
  const keyFile = (d: string) => join(d, "trust", "hosts.key");
  const lockFile = (d: string) => join(d, "trust", "hosts.lock");
  const readList = (d: string) => JSON.parse(readFileSync(listFile(d), "utf8")) as { version: number; servers: Record<string, unknown>[] };
  const writeList = (d: string, servers: unknown[], version = 2) => {
    mkdirSync(join(d, "trust"), { recursive: true });
    writeFixture(listFile(d), JSON.stringify({ version, servers }));
  };
  const sha = (p: string) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "(none)");
  const names = (xs: { host: string }[]) => xs.map((x) => x.host).sort().join(",");
  const trustFiles = (d: string, prefix: string) => (existsSync(join(d, "trust")) ? readdirSync(join(d, "trust")).filter((f) => f.startsWith(prefix)) : []);
  const aged = (p: string) => {
    const t = (Date.now() - 11_000) / 1000;
    utimesSync(p, t, t);
  };
  /** True when any 8-character run of `secret` appears in `text`. */
  const leaks = (text: string, secret: string) => {
    for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return true;
    return false;
  };
  const childScript = join(dirname(fileURLToPath(import.meta.url)), "trust-child.ts");
  /** Run scripts/trust-child.ts in a second process (with this process's tsx loader); its JSON result. */
  const child = (args: string[]) =>
    new Promise<Record<string, unknown>>((res) => {
      execFile(process.execPath, [...process.execArgv, childScript, ...args], { encoding: "utf8", timeout: 120_000 }, (err, stdout, stderr) => {
        try {
          res(JSON.parse(stdout.trim().split("\n").pop() ?? ""));
        } catch {
          res({ error: `${err?.message ?? ""} ${stderr}`.slice(0, 300) });
        }
      });
    });

  // ---- 3. the approval store --------------------------------------------------------
  // MUTATION: run updateHosts' section without withTrustLock → the afterRead row
  // loses "other" or keeps nas. In breakStaleLock, unlink the judged lock at
  // once instead of taking a claim → the two-waiter rows' counter reaches 2
  // (in-process and across processes). Write hosts.json in place
  // (writeFileSync instead of writeAtomic) → the reader process sees partial
  // JSON. Keep a corrupt list instead of moving it aside → the .bad-* row fails.
  // Delete leftover claims only after a write → the writes-nothing claim row fails.
  console.log("3. the approval store: round trip, bad files, atomic writes, the lock...");
  {
    const d = freshData();
    await approveHost(d, "nas", "prompt");
    const r = readTrustedHosts(d);
    check(names(r.approved) === "nas" && r.approved[0].via === "prompt" && !Number.isNaN(Date.parse(r.approved[0].added)) && r.outside.length === 0 && !r.stale && r.unread.length === 0,
      `round trip: approveHost then readTrustedHosts lists nas as approved (${JSON.stringify(r)})`);
    const removed = await revokeHost(d, "nas");
    check(removed.removed && readTrustedHosts(d).approved.length === 0 && readList(d).servers.length === 0, "revokeHost removes it");
  }
  {
    const d = freshData();
    await approveHost(d, "nas", "prompt");
    writeFixture(listFile(d), "{not json");
    let r = readTrustedHosts(d);
    const logs = await logsOf(() => void (r = readTrustedHosts(d)));
    check(r.approved.length === 0 && r.outside.length === 0, `a list that does not parse is empty (${JSON.stringify(r)})`);
    await approveHost(d, "other", "prompt");
    const bad = trustFiles(d, "hosts.json.bad-");
    check(bad.length === 1 && readFileSync(join(d, "trust", bad[0]), "utf8") === "{not json" && names(readTrustedHosts(d).approved) === "other",
      `the next write keeps it as hosts.json.bad-* and starts a new list (${JSON.stringify(bad)}; ${JSON.stringify(logs)})`);
  }
  {
    const d = freshData();
    await approveHost(d, "nas", "prompt");
    const list = readList(d);
    writeFixture(listFile(d), JSON.stringify({ ...list, version: 3 }));
    const r = readTrustedHosts(d);
    check(r.approved.length === 0 && r.outside.length === 0, `version 3 gives an empty list (${JSON.stringify(r)})`);
    list.servers[0].host = "NAS";
    (list.servers as unknown[]).push({ host: "na s" }, { host: 42 }, { via: "prompt" }, null, "nas2");
    writeFixture(listFile(d), JSON.stringify(list));
    const r2 = readTrustedHosts(d);
    check(names(r2.approved) === "nas" && r2.outside.length === 0, `a stamped entry whose host was hand-edited to "NAS" is approved as nas; invalid entries are dropped (${JSON.stringify(r2)})`);
  }
  {
    // A second process reads hosts.json in a loop while 200 writes replace it.
    const d = freshData();
    for (let i = 0; i < 40; i++) await approveHost(d, `bulk-${i}.example`, "prompt");
    const stop = join(trustRoot, `stop-${dataN}`);
    const reader = child(["reader", listFile(d), stop]);
    for (let t = 0; t < 600 && !existsSync(`${stop}.ready`); t++) await sleep(50);
    for (let i = 0; i < 100; i++) {
      await approveHost(d, "flip", "prompt");
      await revokeHost(d, "flip");
    }
    writeFixture(stop, "");
    const r = await reader;
    check(r.bad === 0 && Number(r.reads) > 0, `a reader process never sees a partial hosts.json while 200 writes run (${JSON.stringify(r)})`);
  }
  {
    // Approve vs revoke: the revoke has read the list (nas) when the approve starts; both finish.
    const d = freshData();
    await approveHost(d, "nas", "prompt");
    let started!: () => void;
    const approveStarted = new Promise<void>((r) => (started = r));
    const revoking = revokeHost(d, "nas", { afterRead: async () => {
      await approveStarted;
      await sleep(50);
    } });
    const approving = approveHost(d, "other", "prompt");
    started();
    const errs = await Promise.all([thrown(() => revoking), thrown(() => approving)]);
    const r = readTrustedHosts(d);
    check(errs.every((e) => e === null) && names(r.approved) === "other", `a revoke and an approve at once: the list ends with other and without nas (${JSON.stringify(r)}; ${errs.map((e) => e?.message)})`);
  }
  {
    const d = freshData();
    const [a, b] = await Promise.all([child(["soak", d, "soak-a", "100"]), child(["soak", d, "soak-b", "100"])]);
    const want = [...Array(100).keys()].filter((i) => i % 2 === 0).flatMap((i) => [`soak-a-${i}`, `soak-b-${i}`]).sort().join(",");
    const r = readTrustedHosts(d);
    check(a.ok === true && b.ok === true && names(r.approved) === want && r.outside.length === 0,
      `two processes, 100 rounds of approve/revoke each: every approval and every revoke counts (${JSON.stringify(a)} ${JSON.stringify(b)}; ${r.approved.length} approved)`);
  }
  {
    const d = freshData();
    mkdirSync(join(d, "trust"), { recursive: true });
    writeFixture(lockFile(d), "{}");
    aged(lockFile(d));
    const e = await thrown(() => approveHost(d, "nas", "prompt"));
    check(e === null && names(readTrustedHosts(d).approved) === "nas" && !existsSync(lockFile(d)), `a stale lock (11 s old) is broken (${e?.message})`);
    const before = sha(listFile(d));
    writeFixture(lockFile(d), "{}");
    const t0 = Date.now();
    const busy = await thrown(() => approveHost(d, "other", "prompt"));
    const waited = Date.now() - t0;
    check(busy instanceof TrustStoreError && /try again/i.test(busy.message) && waited >= 1_900 && waited < 3_000 && sha(listFile(d)) === before,
      `a fresh lock held for 3 s: the write fails after 2 s with nothing changed (${busy?.message}; ${waited} ms)`);
    unlinkSync(lockFile(d));
  }
  {
    // Two waiters judge the same stale lock: A breaks it and goes in; B is let go only once A is inside.
    const d = freshData();
    mkdirSync(join(d, "trust"), { recursive: true });
    writeFixture(lockFile(d), "{}");
    aged(lockFile(d));
    let judged = 0;
    let bothJudged!: () => void;
    const both = new Promise<void>((r) => (bothJudged = r));
    let aInside!: () => void;
    const aIn = new Promise<void>((r) => (aInside = r));
    let inside = 0;
    let most = 0;
    const section = (name: string) => async () => {
      most = Math.max(most, ++inside);
      if (name === "A") aInside();
      await sleep(100);
      inside--;
    };
    const onStale = (name: string) => async () => {
      if (++judged === 2) bothJudged();
      await both;
      if (name === "B") await aIn;
    };
    const errs = await Promise.all(["A", "B"].map((n) => thrown(() => withTrustLock(d, section(n), { onStale: onStale(n) }))));
    check(errs.every((e) => e === null) && most === 1 && judged === 2 && trustFiles(d, "hosts.lock.break-").length === 0 && !existsSync(lockFile(d)),
      `two waiters break the same stale lock: both succeed, never both inside, no claim left (most inside ${most}; ${errs.map((e) => e?.message)})`);
  }
  {
    const d = freshData();
    const barrier = join(trustRoot, `barrier-${dataN}`);
    mkdirSync(join(d, "trust"), { recursive: true });
    mkdirSync(barrier);
    writeFixture(lockFile(d), "{}");
    aged(lockFile(d));
    const [a, b] = await Promise.all([child(["stale", d, "A", barrier]), child(["stale", d, "B", barrier])]);
    check(a.overlap === false && b.overlap === false && trustFiles(d, "hosts.lock.break-").length === 0 && !existsSync(lockFile(d)),
      `the same with two processes held by barrier files (${JSON.stringify(a)} ${JSON.stringify(b)})`);
  }
  {
    // A claimer that crashed left claim .1 (11 s old) next to the stale lock.
    const d = freshData();
    mkdirSync(join(d, "trust"), { recursive: true });
    writeFixture(lockFile(d), "{}");
    aged(lockFile(d));
    const t = Math.floor(statSync(lockFile(d)).mtimeMs);
    const claim1 = join(d, "trust", `hosts.lock.break-${t}.1`);
    writeFixture(claim1, "");
    aged(claim1);
    const e = await thrown(() => approveHost(d, "nas", "prompt"));
    check(e === null && names(readTrustedHosts(d).approved) === "nas" && trustFiles(d, "hosts.lock.break-").length === 0,
      `a crashed claimer's claim .1: the next write takes claim .2, succeeds and leaves no claim (${e?.message}; ${JSON.stringify(trustFiles(d, "hosts.lock"))})`);
    // A pass through the lock that writes nothing (Remove of a host kept by now) also deletes leftover claims.
    writeFixture(join(d, "trust", "hosts.lock.break-1.1"), "");
    const before = sha(listFile(d));
    const r = await revokeHost(d, "nas", { onlyIfOutside: true });
    check(!r.removed && sha(listFile(d)) === before && trustFiles(d, "hosts.lock.break-").length === 0,
      `a pass that writes nothing (onlyIfOutside on an approved host) still deletes a leftover claim (${JSON.stringify(trustFiles(d, "hosts.lock"))})`);
  }

  // ---- 4. G2: rpc paths into <dataDir>/trust -----------------------------------------
  // MUTATION: remove the G2 call from save → the save rows fail (the file
  // changes, or gatedfs's own refusal answers). Remove it from load → the
  // backstop answers instead of G2 (and through the link, the error quotes the
  // start of the key). Drop the realpath part of HostTrust.checkPath → the
  // link rows fail. Remove checkLoadedProject from load → the font / asset
  // rows fail. Drop privatePath from rememberMany → its row fails. Check
  // fonts untrimmed in checkLoadedProject → the leading-space rows load.
  console.log("4. G2: rpc reads and writes into the trust folder...");
  {
    const dataDir = join(root, "data");
    await approveHost(dataDir, "nas", "prompt");
    const keyText = readFileSync(keyFile(dataDir), "utf8").trim();
    const listBefore = sha(listFile(dataDir));
    const keyBefore = sha(keyFile(dataDir));
    // A link to the data folder (made by the test: no core code makes links).
    const link = join(root, "data-link");
    symlinkSync(dataDir, link, process.platform === "win32" ? "junction" : "dir");
    const PRIVATE = /private settings folder, which tools can't open/;
    const writes = [join(dataDir, "trust", "hosts.json"), `${dataDir}/trust/../trust/hosts.json`, `${dataDir}/proxies/../trust/hosts.key`, join(link, "trust", "hosts.json")];
    if (process.platform === "win32" || process.platform === "darwin") writes.push(join(dataDir, "TRUST", "HOSTS.JSON"));
    for (const p of writes) {
      for (const [name, fn] of [
        ["save", () => engine.save(p)],
        ["export_otio", () => engine.exportOtio(p)],
        ["export_captions", () => engine.exportCaptions(p)],
        ["export_video", () => engine.startExportJob(p)],
      ] as const) {
        const e = await errOf(fn);
        check(PRIVATE.test(e) && sha(listFile(dataDir)) === listBefore && sha(keyFile(dataDir)) === keyBefore, `${name} into ${JSON.stringify(p)} is refused, the store is unchanged (${e.slice(0, 110)})`);
      }
    }
    const reads = [keyFile(dataDir), listFile(dataDir), `${dataDir}/proxies/../trust/hosts.key`, join(link, "trust", "hosts.key")];
    const errors: string[] = [];
    for (const p of reads) {
      for (const [name, fn] of [
        ["load_project", () => engine.load(p)],
        ["import_otio", () => engine.importOtio(p)],
        ["import_captions", () => engine.importCaptions("clip_none", p)],
        ["import_video", () => engine.importVideo(p)],
        ["apply_lut", () => engine.setClipEffects("clip_none", { lut: p })],
        ["add_text font", () => engine.addTextOverlay("clip_none", { text: "t", font: p })],
      ] as const) {
        const e = await errOf(fn);
        errors.push(e);
        check(PRIVATE.test(e) && !leaks(e, keyText), `${name} of ${JSON.stringify(p)} is refused with the private-folder message and no key text (${e.slice(0, 110)})`);
      }
    }
    const remembered = await engine.storage.rememberMany(reads);
    check(remembered.added.length === 0 && remembered.skipped.length === reads.length && remembered.skipped.every((s) => /private settings folder/.test(s.reason)),
      `remember_projects skips each one (${JSON.stringify(remembered.skipped.map((s) => s.reason))})`);
    check(!errors.some((e) => leaks(e, keyText)), "no error text holds any 8 characters of the key");

    // A loaded project's fields (the quick form and the name rule, no I/O).
    const projectWith = (asset: Record<string, unknown>, clip: Record<string, unknown> = {}) => {
      const f = join(root, `fields-${dataN++}.aive`);
      const base = project("/x/a.mp4") as unknown as { assets: Record<string, unknown>[]; tracks: { clips: Record<string, unknown>[] }[] };
      Object.assign(base.assets[0], asset);
      Object.assign(base.tracks[0].clips[0], clip);
      writeFixture(f, JSON.stringify(base));
      return f;
    };
    const fieldRows: [string, string, RegExp][] = [
      ["asset.path", projectWith({ path: keyFile(dataDir) }), /^asset "asset_a1" path/],
      ["cutout colour path", projectWith({ cutout: { colorPath: keyFile(dataDir), colorStart: 0 } }), /cutout colour path/],
      ["clip LUT", projectWith({}, { effects: { lut: join(dataDir, "trust", "x.cube") } }), /^clip "clip_c1" LUT path/],
      ["overlay font", projectWith({}, { overlays: [{ id: "text_t1", text: "t", font: keyFile(dataDir) }] }), /^clip "clip_c1" text "text_t1" font/],
      ["caption font", projectWith({}, { captions: { cues: [], style: { font: keyFile(dataDir) } } }), /^clip "clip_c1" caption font/],
      // resolveFont trims a font, so a leading space must not get it past the check.
      ["overlay font with a leading space", projectWith({}, { overlays: [{ id: "text_t1", text: "t", font: ` ${keyFile(dataDir)}` }] }), /^clip "clip_c1" text "text_t1" font/],
      ["caption font with a leading space", projectWith({}, { captions: { cues: [], style: { font: ` ${keyFile(dataDir)}` } } }), /^clip "clip_c1" caption font/],
      ["asset.path on a server, by name", projectWith({ path: "\\\\zr-evil-1.invalid\\zr\\trust\\hosts.key" }), /^asset "asset_a1" path/],
    ];
    for (const [label, f, field] of fieldRows) {
      const e = await errOf(() => engine.load(f));
      check(field.test(e) && PRIVATE.test(e) && /open the project again\.$/.test(e), `a project whose ${label} is in the trust folder does not load (${e.slice(0, 120)})`);
    }
    const cachedLoad = await thrown(() => engine.load(projectWith({ proxyPath: keyFile(dataDir), previewPath: `${dataDir}/trust/p.mp4` })));
    check(cachedLoad === null && engine.getProject().assets[0].proxyPath === undefined && engine.getProject().assets[0].previewPath === undefined,
      `one whose proxyPath / previewPath is there loads without them (${cachedLoad?.message})`);
    // An .otio whose media is the key: an offline placeholder, never probed.
    const otioKey = join(root, "key.otio");
    writeFixture(otioKey, JSON.stringify({ ...otio, tracks: { ...otio.tracks, children: [{ ...otio.tracks.children[0], children: [{ ...otio.tracks.children[0].children[0], media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", target_url: keyFile(dataDir) } } }] }] } }));
    const imported = await thrown(() => engine.importOtio(otioKey));
    check(imported === null && engine.getProject().assets.length === 1 && engine.getProject().assets[0].missing === true, `an .otio whose media is in the trust folder imports it as an offline placeholder (${imported?.message})`);
    // G6: /file, /frames and /peaks never serve the trust folder, though it is in the data folder.
    check(!engine.isServablePath(keyFile(dataDir)) && !engine.isServablePath(join(dataDir, "trust")) && engine.isServablePath(join(dataDir, "proxies", "p.mp4")),
      "isServablePath: false for the trust folder, true for the rest of the data folder");
    unlinkSync(link);
  }

  // ---- 12. stamps ---------------------------------------------------------------------
  // MUTATION: trust every entry (skip the stamp check in sortEntries) → the
  // hand-written rows and the HostTrust rows fail. Leave host out of the HMAC
  // input → the copied-stamp row fails. Stamp every entry on write (written()
  // keeps outside entries stamped with the current key) → the no-laundering
  // rows fail. Create the key outside the lock (or with a plain writeFileSync)
  // → the first-writers row sometimes ends with one host outside (50 rounds).
  // Log the read error's message → the log row fails. Treat every key read
  // error as missing → the EBUSY rows find a new key, a .bad-* file and nas
  // outside. Drop the kept key → the stale HostTrust row loses nas. Treat an
  // unreadable key with no copy as "no key" → the unread rows list nas and
  // zr-evil-3.invalid as outside and approvalDialogFor gives "keep". Drop the
  // 1 s retry timer → the unread rows are still unread after 2 s. Ignore
  // onlyIfOutside → the remove-after-keep row removes the host. Drop the lazy
  // reload or the watch → their HostTrust rows fail. Keep a missing or corrupt
  // key (or list) as the last good copy → the missing/corrupt-then-EBUSY rows
  // call nas outside (or give "allow") instead of unread.
  console.log("12. stamps: outside entries, the key, read errors, the unread state, HostTrust...");
  const stampWith = (k: Buffer, host: string, via: string, added: string) => createHmac("sha256", k).update(`zabsreel-hosts-v2\n${host}\n${via}\n${added}`).digest("base64url");
  {
    const d = freshData();
    await approveHost(d, "nas", "prompt");
    const list = readList(d);
    const nasEntry = list.servers[0] as { host: string; via: string; added: string; stamp: string };
    const keyText = readFileSync(keyFile(d), "utf8").trim();
    const posixModes = process.platform === "win32" || ((statSync(keyFile(d)).mode & 0o777) === 0o600 && (statSync(join(d, "trust")).mode & 0o777) === 0o700);
    check(list.version === 2 && /^[A-Za-z0-9_-]{43}$/.test(nasEntry.stamp) && /^[A-Za-z0-9_-]{43}$/.test(keyText) && posixModes && names(readTrustedHosts(d).approved) === "nas",
      `approveHost writes version 2, a 43-character stamp and a 43-character key (0600 in a 0700 folder on POSIX) (${JSON.stringify(list)})`);
    const key = Buffer.from(keyText, "base64url");
    const E3 = "zr-evil-3.invalid";
    const added = nasEntry.added;
    const handWritten: [string, Record<string, unknown>][] = [
      ["no stamp", { host: E3, via: "prompt", added }],
      ["43 random base64url characters", { host: E3, via: "prompt", added, stamp: randomBytes(32).toString("base64url") }],
      ["forged with a different key", { host: E3, via: "prompt", added, stamp: stampWith(randomBytes(32), E3, "prompt", added) }],
      ["nas's stamp copied onto another host", { host: E3, via: nasEntry.via, added, stamp: nasEntry.stamp }],
      ["nas with added changed", { host: "nas", via: nasEntry.via, added: "2020-01-01T00:00:00.000Z", stamp: nasEntry.stamp }],
      ["nas with via changed", { host: "nas", via: "picker", added, stamp: nasEntry.stamp }],
      ['via "agent" with a stamp computed for it', { host: E3, via: "agent", added, stamp: stampWith(key, E3, "agent", added) }],
    ];
    for (const [label, entry] of handWritten) {
      writeList(d, [entry]);
      const r = readTrustedHosts(d);
      check(r.approved.length === 0 && names(r.outside) === entry.host, `hand-written, ${label}: outside, not approved (${JSON.stringify(r)})`);
    }
    // Positive control: the test's HMAC is the store's (whoever reads the key can forge: tamper-evident, not tamper-proof).
    writeList(d, [{ host: E3, via: "prompt", added, stamp: stampWith(key, E3, "prompt", added) }]);
    check(names(readTrustedHosts(d).approved) === E3, "control: an entry stamped with the store's own key is approved");
    writeList(d, [{ host: "nas" }], 1);
    check(names(readTrustedHosts(d).outside) === "nas" && readTrustedHosts(d).approved.length === 0, "a version 1 file: every entry outside");
  }
  {
    // Key deleted: every entry outside; the next write makes a new key and leaves the old entries outside.
    const d = freshData();
    await approveHost(d, "nas", "prompt");
    const oldKey = readFileSync(keyFile(d), "utf8");
    unlinkSync(keyFile(d));
    const r = readTrustedHosts(d);
    check(r.approved.length === 0 && names(r.outside) === "nas", `hosts.key deleted: nas is outside (${JSON.stringify(r)})`);
    await approveHost(d, "other", "prompt");
    const r2 = readTrustedHosts(d);
    check(existsSync(keyFile(d)) && readFileSync(keyFile(d), "utf8") !== oldKey && names(r2.approved) === "other" && names(r2.outside) === "nas",
      `the next approveHost(other) makes a new key, stamps other, leaves nas outside (${JSON.stringify(r2)})`);
  }
  {
    // A corrupt key (10 bytes) and a corrupt list that holds the key and a stamp: no log line quotes them.
    const d = freshData();
    await approveHost(d, "nas", "prompt");
    const keyText = readFileSync(keyFile(d), "utf8").trim();
    const stamp = String(readList(d).servers[0].stamp);
    const goodList = readFileSync(listFile(d), "utf8");
    writeFixture(keyFile(d), keyText.slice(0, 10));
    let r = readTrustedHosts(d);
    const logs = await logsOf(() => void (r = readTrustedHosts(d)));
    check(r.approved.length === 0 && names(r.outside) === "nas", `a 10-byte hosts.key: every entry outside (${JSON.stringify(r)})`);
    await approveHost(d, "other", "prompt");
    const bad = trustFiles(d, "hosts.key.bad-");
    check(bad.length === 1 && readFileSync(join(d, "trust", bad[0]), "utf8") === keyText.slice(0, 10) && /^[A-Za-z0-9_-]{43}$/.test(readFileSync(keyFile(d), "utf8").trim()) && names(readTrustedHosts(d).approved) === "other",
      `the next write keeps it as hosts.key.bad-* and makes a new key (${JSON.stringify(bad)})`);
    // Fresh data folders, so each problem is logged (the reader logs a problem once per data folder).
    const logLines: string[] = [];
    for (const [label, key, list] of [
      ["corrupt key", keyText.slice(0, 10), goodList],
      ["corrupt list", `${keyText}\n`, `${keyText} ${stamp}`],
    ] as const) {
      const d2 = freshData();
      mkdirSync(join(d2, "trust"), { recursive: true });
      writeFixture(keyFile(d2), key);
      writeFixture(listFile(d2), list);
      const lines = await logsOf(() => readTrustedHosts(d2));
      logLines.push(...lines);
      check(lines.length === 1, `${label}: one log line (${JSON.stringify(lines)})`);
    }
    const all = [...logs, ...logLines].join("\n");
    check(!leaks(all, keyText) && !all.includes(stamp), `no log line holds any 8 characters of the key or a stamp (${JSON.stringify(logLines)})`);
  }
  {
    // Read errors: a write never rotates the key, renames a file or drops an entry because a file can't be read right now.
    for (const [file, code] of [["hosts.key", "EBUSY"], ["hosts.key", "EPERM"], ["hosts.key", "EACCES"], ["hosts.json", "EBUSY"]] as const) {
      const d = freshData();
      await approveHost(d, "nas", "prompt");
      const before = [sha(keyFile(d)), sha(listFile(d))].join();
      const e = await thrown(() => approveHost(d, "other", "prompt", { readError: { [file]: code } }));
      check(e instanceof TrustStoreError && /try again/i.test(e.message) && [sha(keyFile(d)), sha(listFile(d))].join() === before
        && trustFiles(d, "hosts.key.bad-").length === 0 && trustFiles(d, "hosts.json.bad-").length === 0 && !existsSync(lockFile(d)) && names(readTrustedHosts(d).approved) === "nas",
        `approveHost while ${file} fails with ${code}: rejected ("try again"), both files byte-for-byte unchanged, no .bad-*, no lock left (${e?.message})`);
    }
    const d = freshData();
    await approveHost(d, "nas", "prompt");
    const e = await thrown(() => revokeHost(d, "nas", { readError: { "hosts.key": "EBUSY" } }));
    check(e instanceof TrustStoreError && names(readTrustedHosts(d).approved) === "nas", `revokeHost while hosts.key fails with EBUSY is rejected and nas stays (${e?.message})`);
  }
  const allowed = () => [...gfs.allowedNetworkHosts()].sort().join(",");
  {
    // HostTrust with a kept copy: an unreadable key keeps the last good one (stale), then a network check re-reads it.
    const d = freshData();
    await approveHost(d, "nas", "prompt");
    const inject: ReadErrorInjection = {};
    const ht = new HostTrust(d, { readError: inject }).start();
    check(names(ht.list().approved) === "nas" && allowed() === "nas", "HostTrust lists nas as approved and publishes it");
    inject["hosts.key"] = "EBUSY";
    ht.reload();
    const l = ht.list();
    check(names(l.approved) === "nas" && l.stale && l.unread.length === 0 && allowed() === "nas", `a reload while hosts.key fails with EBUSY keeps nas approved and published (stale) (${JSON.stringify(l)})`);
    delete inject["hosts.key"];
    await sleep(1_050);
    ht.isApproved("zr-evil-9.invalid");
    check(!ht.list().stale, "once the read works again, the next network check re-reads it without an mtime change");
    ht.close();
  }
  {
    // Unread at start: no kept copy, so nothing in the list is approved or outside, and no Keep dialog.
    const E3 = "zr-evil-3.invalid";
    for (const file of ["hosts.key", "hosts.json"] as const) {
      const d = freshData();
      await approveHost(d, "nas", "prompt");
      writeList(d, [...readList(d).servers, { host: E3 }]);
      const inject: ReadErrorInjection = { [file]: "EBUSY" };
      const r = readTrustedHosts(d, { readError: inject });
      check(r.approved.length === 0 && r.outside.length === 0 && JSON.stringify(r.unread) === JSON.stringify([file]) && approvalDialogFor(r, "nas") === "unread" && approvalDialogFor(r, E3) === "unread",
        `unread at start (${file} EBUSY, no good copy): nothing approved or outside, unread ${JSON.stringify(r.unread)}, approvalDialogFor gives "unread" for both (${JSON.stringify(r)})`);
      const ht = new HostTrust(d, { readError: inject }).start();
      const l = ht.list();
      check(l.approved.length === 0 && l.outside.length === 0 && JSON.stringify(l.unread) === JSON.stringify([file]) && !gfs.allowedNetworkHosts().has("nas"),
        `HostTrust started under it: unread ${JSON.stringify(l.unread)}, nas not published (${JSON.stringify(l)})`);
      delete inject[file];
      const t0 = Date.now();
      while (Date.now() - t0 < 2_000 && ht.list().unread.length > 0) await sleep(50);
      const after = ht.list();
      check(after.unread.length === 0 && names(after.approved) === "nas" && names(after.outside) === E3 && gfs.allowedNetworkHosts().has("nas") && !gfs.allowedNetworkHosts().has(E3),
        `the read works again: within 2 s, with no check and no mtime change (the 1 s retry), nas is approved and only now is ${E3} outside (${Date.now() - t0} ms; ${JSON.stringify(after)})`);
      ht.close();
    }
    const d = freshData();
    const r = readTrustedHosts(d, { readError: { "hosts.key": "EBUSY" } });
    check(r.unread.length === 0 && r.approved.length === 0, `an unreadable key next to a missing hosts.json is not "unread": there is no entry to check (${JSON.stringify(r)})`);
    // A missing or corrupt read is no good copy (and drops an earlier one): a
    // file read that way, then written by another UI host (the antivirus
    // scanner then holds the new file), then unreadable, is unread, never
    // "every entry outside". Missing: a fresh data folder. Corrupt: after a good read.
    for (const file of ["hosts.key", "hosts.json"] as const) {
      for (const first of ["missing", "corrupt"] as const) {
        const d = freshData();
        if (first === "corrupt") {
          await approveHost(d, "other", "prompt");
          readTrustedHosts(d);
          writeFixture(join(d, "trust", file), "{ not a store file");
        }
        let r = readTrustedHosts(d);
        await approveHost(d, "nas", "prompt");
        const logs = await logsOf(() => void (r = readTrustedHosts(d, { readError: { [file]: "EBUSY" } })));
        check(r.approved.length === 0 && r.outside.length === 0 && JSON.stringify(r.unread) === JSON.stringify([file]) && approvalDialogFor(r, "nas") === "unread"
          && logs.some((l) => l.includes(`${file} could not be read (EBUSY); no good copy yet`)) && !logs.some((l) => l.includes("last good copy")),
          `${file} ${first} at a read, then written, then EBUSY: nothing approved or outside, unread ${JSON.stringify(r.unread)}, approvalDialogFor gives "${approvalDialogFor(r, "nas")}" (${JSON.stringify(r)}; ${JSON.stringify(logs)})`);
      }
    }
  }
  {
    // No laundering, Keep, Remove, and Remove after a Keep in another UI host.
    const E3 = "zr-evil-3.invalid";
    const withOutside = async () => {
      const d = freshData();
      await approveHost(d, "nas", "prompt");
      writeList(d, [...readList(d).servers, { host: E3, via: "prompt", added: "2026-10-14T10:00:00.000Z", stamp: randomBytes(32).toString("base64url") }]);
      return d;
    };
    const entryOf = (d: string, host: string) => readList(d).servers.filter((s) => s.host === host);
    const d = await withOutside();
    await approveHost(d, "other", "prompt");
    check(JSON.stringify(entryOf(d, E3)) === JSON.stringify([{ host: E3 }]) && names(readTrustedHosts(d).outside) === E3, `approveHost(other) writes the outside entry back as { host } only (${JSON.stringify(entryOf(d, E3))})`);
    await revokeHost(d, "nas");
    check(JSON.stringify(entryOf(d, E3)) === JSON.stringify([{ host: E3 }]) && names(readTrustedHosts(d).outside) === E3, "revokeHost(nas) does the same");
    await approveHost(d, E3, "prompt");
    check(entryOf(d, E3).length === 1 && names(readTrustedHosts(d).approved) === `other,${E3}`, "Keep: approveHost on the outside host approves it, with one entry");
    const d2 = await withOutside();
    await revokeHost(d2, E3);
    check(entryOf(d2, E3).length === 0, "Remove: revokeHost on an outside host leaves no entry");
    const d3 = await withOutside();
    await approveHost(d3, E3, "prompt");
    const kept = sha(listFile(d3));
    const late = await revokeHost(d3, E3, { onlyIfOutside: true });
    check(!late.removed && sha(listFile(d3)) === kept && names(readTrustedHosts(d3).approved) === `nas,${E3}`, `Remove after a Keep elsewhere: { removed: false }, the file is unchanged, the host stays approved (${JSON.stringify(late)})`);
    const d4 = await withOutside();
    const early = await revokeHost(d4, E3, { onlyIfOutside: true });
    check(early.removed && entryOf(d4, E3).length === 0, "onlyIfOutside on a host that is still outside removes it");
    const plain = await revokeHost(d3, E3);
    check(plain.removed && entryOf(d3, E3).length === 0, "a plain revokeHost removes an approved host");
  }
  {
    // First writers: two processes approve different hosts in a fresh data folder at the same moment, 50 times.
    const base = join(trustRoot, "first");
    mkdirSync(base);
    const [a, b] = await Promise.all([
      child(["first", base, "zr-first-a.invalid", "zr-first-b.invalid", "50"]),
      child(["first", base, "zr-first-b.invalid", "zr-first-a.invalid", "50"]),
    ]);
    const wrong: string[] = [];
    for (let i = 0; i < 50; i++) {
      const d = join(base, `fw-${i}`);
      const r = readTrustedHosts(d);
      if (names(r.approved) !== "zr-first-a.invalid,zr-first-b.invalid" || r.outside.length > 0 || trustFiles(d, "hosts.key").length !== 1) wrong.push(`${i}: ${JSON.stringify(r)}`);
    }
    check(a.ok === true && b.ok === true && wrong.length === 0, `first writers: one hosts.key and both hosts approved in all 50 rounds (${JSON.stringify(a)} ${JSON.stringify(b)}; ${wrong.slice(0, 2).join(" ")})`);
  }
  {
    // HostTrust publishes approved servers only; an outside one is listed and logged, never allowed.
    const E3 = "zr-evil-3.invalid";
    const d = freshData();
    await approveHost(d, "nas", "prompt");
    writeList(d, [...readList(d).servers, { host: E3 }]);
    let changes = 0;
    const ht = new HostTrust(d, { onChange: () => void changes++ }).start();
    const changesAtStart = changes;
    const l = ht.list();
    check(names(l.approved) === "nas" && names(l.outside) === E3 && allowed() === "nas" && !ht.isApproved(E3) && approvalDialogFor(l, E3) === "keep" && approvalDialogFor(l, "zr-evil-9.invalid") === "allow",
      `HostTrust: nas approved and published, ${E3} outside and never published; approvalDialogFor gives "keep" for it (${JSON.stringify(l)}; allowed ${allowed()})`);
    const box = { decision: true };
    const lines = await logsOf(() => void (box.decision = ht.isAllowed(E3)));
    const decision = box.decision;
    check(enforced ? decision === false && lines.length === 1 && lines[0].includes(`blocked \\\\${E3} (added outside ZabsReel)`) : decision === true && lines.length === 1 && lines[0].includes(`would block \\\\${E3} (added outside ZabsReel)`),
      `${enforced ? "enforced: refused" : "log mode: let through"} and logged as added outside (${JSON.stringify(lines)})`);
    // The lazy reload: a write the core was not told about counts on the next check of that server.
    await approveHost(d, "zr-evil-2.invalid", "prompt");
    check(ht.isApproved("zr-evil-2.invalid") && gfs.allowedNetworkHosts().has("zr-evil-2.invalid") && changes > changesAtStart, "an approval counts on the next check, with no re-check call (lazy reload on a miss)");
    // The watch: a write is picked up with no check at all.
    await approveHost(d, "zr-evil-4.invalid", "prompt");
    const t0 = Date.now();
    while (Date.now() - t0 < 2_000 && !gfs.allowedNetworkHosts().has("zr-evil-4.invalid")) await sleep(50);
    check(gfs.allowedNetworkHosts().has("zr-evil-4.invalid"), `fs.watch on the trust folder picks up a write with no check (${Date.now() - t0} ms)`);
    ht.close();
    gfs.setAllowedNetworkHosts([]);
  }

  // ---- 13. the private trust folder ------------------------------------------------------
  // MUTATION: drop the ":" rule from trustForm → the trust::$INDEX_ALLOCATION row fails. Drop the
  // "~" rule → the TRUST~1 row fails. Drop the identity check (checkPath
  // returns OK for the data folder's server) → the other.json save and the EIO
  // load are not refused by G2 (the two hosts.key rows still pass, through the
  // name rule). Drop the name rule → the 0n rows and the zr-evil-2 row fail
  // (the d$ and volume1 rows still pass, through the identity check). Gate stat
  // too (content: true on stat) → the storageUsage and stat rows fail. Make the
  // trust-folder refusal depend on enforce mode → the rows fail without the
  // variable. Drop the G6 line from isServablePath → row 4's isServablePath row fails.
  console.log("13. the private trust folder: quick form, gatedfs, G7, other spellings...");
  touched.length = 0;
  {
    const qRoot = join(root, "q");
    const qTrust = join(qRoot, "trust");
    gfs.setTrustDir(qTrust);
    for (const p of [join(qTrust, "hosts.key"), `${qTrust}/./hosts.json`, `${qRoot}/x/../trust/hosts.key`, qTrust]) check(gfs.isTrustPath(p), `isTrustPath(${JSON.stringify(p)})`);
    for (const p of [`${qRoot}/trustee/x`, `${qRoot}/trust2/x`, `${qRoot}/proxies/x`]) check(!gfs.isTrustPath(p), `not isTrustPath(${JSON.stringify(p)})`);
    // Windows (through the platform seam): case, a trailing dot, an NTFS stream, an 8.3 short name.
    const W = "C:\\Users\\a\\zr";
    const realpath = (p: string) => {
      const map: Record<string, string> = { "c:\\users\\a\\zr\\trust~1": `${W}\\trust`, "c:\\users\\a\\zr\\trust~2": `${W}\\trustee`, "c:\\users\\a\\zr": W };
      const real = map[p.toLowerCase()];
      if (real === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return real;
    };
    const win = { platform: "win32" as const, trustDir: `${W}\\trust`, realpath };
    for (const p of ["C:\\USERS\\A\\ZR\\TRUST\\HOSTS.KEY", `${W}\\trust.\\hosts.key`, `${W}\\trust\\hosts.key::$DATA`, `${W}\\trust::$INDEX_ALLOCATION\\hosts.key`, `${W}\\trust\\hosts.key.`, `${W}\\TRUST~1\\hosts.key`, `${W}/x/../trust /hosts.json`]) {
      check(gfs.isTrustPath(p, win), `win32: isTrustPath(${JSON.stringify(p)})`);
    }
    for (const p of [`${W}\\trustee\\x`, `${W}\\TRUST~2\\x`, `${W}\\proxies\\x`]) check(!gfs.isTrustPath(p, win), `win32: not isTrustPath(${JSON.stringify(p)})`);
    check(gfs.isTrustPath(`${qTrust.toUpperCase()}/HOSTS.KEY`, { platform: "darwin" }) && !gfs.isTrustPath(`${qTrust.toUpperCase()}/HOSTS.KEY`, { platform: "linux" }), "darwin folds case; linux does not");

    // gatedfs: content calls refuse it in every mode, without calling the real function; metadata calls go through.
    mkdirSync(qTrust, { recursive: true });
    writeFixture(join(qTrust, "hosts.key"), "k");
    writeFixture(join(qTrust, "hosts.json"), "{}");
    const usage = await storageUsage(qRoot);
    check(usage.areas.other.files === 2, `storageUsage still counts the two files under "other" (${JSON.stringify(usage.areas.other)})`);
    const spied: string[] = [];
    const fsMod = require("node:fs") as Record<string, unknown>;
    const fspMod = require("node:fs/promises") as Record<string, unknown>;
    const spyOn: [Record<string, unknown>, string, unknown][] = [
      [fspMod, "readFile", async () => "spy"], [fspMod, "open", async () => ({})], [fspMod, "copyFile", async () => undefined],
      [fspMod, "writeFile", async () => undefined], [fspMod, "rename", async () => undefined], [fspMod, "rm", async () => undefined],
      [fspMod, "mkdir", async () => undefined], [fspMod, "stat", async () => ({})], [fspMod, "lstat", async () => ({})], [fspMod, "readdir", async () => []],
      [fsMod, "readFileSync", () => "spy"], [fsMod, "createReadStream", () => ({})], [fsMod, "writeFileSync", () => undefined],
    ];
    const saved = spyOn.map(([m, k]) => [m, k, m[k]] as const);
    for (const [m, k, impl] of spyOn) {
      m[k] = (...a: unknown[]) => {
        spied.push(`${k}(${a.filter((x) => typeof x === "string").join(", ")})`);
        return (impl as (...a: unknown[]) => unknown)(...a);
      };
    }
    syncBuiltinESMExports();
    try {
      const K = join(qTrust, "hosts.key");
      const OUT = join(qRoot, "out.bin");
      for (const [name, fn] of [
        ["readFile", () => gfs.readFile(K)], ["readFileSync", () => gfs.readFileSync(K)], ["createReadStream", () => gfs.createReadStream(K)],
        ["open", () => gfs.open(K)], ["copyFile from", () => gfs.copyFile(K, OUT)], ["copyFile to", () => gfs.copyFile(OUT, K)],
        ["writeFile", () => gfs.writeFile(K, "x")], ["rename from", () => gfs.rename(K, OUT)], ["rename to", () => gfs.rename(OUT, K)],
        ["rm", () => gfs.rm(K)], ["mkdir", () => gfs.mkdir(join(qTrust, "sub"))],
      ] as const) {
        spied.length = 0;
        const e = await thrown(fn);
        check(e instanceof gfs.BlockedPathError && /trust folder/.test(e.message) && spied.length === 0, `gatedfs ${name} on the trust folder is refused in every mode, the real function is never called (${e?.message.slice(0, 90)}; ${JSON.stringify(spied)})`);
      }
      for (const [name, fn] of [["stat", () => gfs.stat(K)], ["lstat", () => gfs.lstat(K)], ["readdir", () => gfs.readdir(qTrust)]] as const) {
        spied.length = 0;
        const e = await thrown(fn);
        check(e === null && spied.length === 1, `gatedfs ${name} still calls through (${e?.message}; ${JSON.stringify(spied)})`);
      }
    } finally {
      for (const [m, k, orig] of saved) m[k] = orig;
      syncBuiltinESMExports();
    }
    // G7: an argv string in the trust folder, in any form, in every mode.
    const render = join(qRoot, "render");
    mkdirSync(render, { recursive: true });
    const listK = join(render, "list-trust.txt");
    writeFixture(listK, "file '../trust/hosts.key'\n");
    for (const [label, fn] of [
      ["-i", () => ffmpegArgsLocalOnly(["-i", join(qTrust, "hosts.key"), "-f", "null", "-"])],
      ["output", () => ffmpegArgsLocalOnly(["-i", "/tmp/a.mp4", "-c", "copy", join(qTrust, "x.mp4")])],
      ["relative in the spawn cwd", () => assertArgvReachable(["-i", "../trust/hosts.key", "-f", "null", "-"], render)],
      ["-f concat list entry", () => ffmpegArgsLocalOnly(["-f", "concat", "-safe", "0", "-i", listK, "-c", "copy", "/tmp/o.mp4"])],
      ["ffprobe", () => ffprobeArgsLocalOnly(["-v", "error", join(qTrust, "hosts.key")])],
    ] as const) {
      const e = await thrown(fn);
      check(e instanceof gfs.BlockedPathError && /trust folder/.test(e.message), `G7: ${label} in the trust folder is refused in every mode (${e?.message.slice(0, 90)})`);
    }
    check((await thrown(() => assertArgvReachable(["-i", join(qRoot, "proxies", "p.mp4"), "-f", "null", "-"], render))) === null, "G7: a path beside the trust folder passes");
  }
  {
    // Other spellings of a data folder on a share (HostTrust with an injected stat; nothing is opened).
    const ID: Record<string, bigint> = {
      "\\\\zr-data.invalid\\zr": 1n, "\\\\zr-data.invalid\\d$\\zr": 1n, "\\\\zr-data.invalid\\volume1\\zr": 1n,
      "\\\\zr-data.invalid\\zr\\trust": 2n, "\\\\zr-data.invalid\\d$\\zr\\trust": 2n,
      "\\\\zr-data.invalid\\video": 3n, "\\\\zr-data.invalid\\stock": 4n,
      "\\\\zr-data.invalid\\d$": 5n, "\\\\zr-data.invalid\\volume1": 6n,
    };
    const fake = { fail: {} as Record<string, string>, zeroIno: false, noTrust: false, calls: [] as string[] };
    const stat = (p: string) => {
      const k = p.replace(/[\\/]+$/, "").toLowerCase();
      fake.calls.push(k);
      const code = fake.fail[k] ?? (ID[k] === undefined || (fake.noTrust && ID[k] === 2n) ? "ENOENT" : undefined);
      if (code) throw Object.assign(new Error(code), { code });
      return { dev: 9n, ino: fake.zeroIno ? 0n : ID[k] };
    };
    const noRealpath = (p: string): string => {
      throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
    };
    const ht = new HostTrust("\\\\zr-data.invalid\\zr", { platform: "win32", stat, realpath: noRealpath });
    // On POSIX these paths are relative names: a write that slips through (a mutation) lands in the temp dir.
    const cwd = process.cwd();
    process.chdir(root);
    const PRIVATE = /private settings folder, which tools can't open/;
    const realTrust = engine.trust;
    (engine as unknown as { trust: HostTrust }).trust = ht;
    const spied: string[] = [];
    const fspMod = require("node:fs/promises") as Record<string, unknown>;
    const saved = ["readFile", "writeFile", "mkdir"].map((k) => [k, fspMod[k]] as const);
    for (const [k, orig] of saved) {
      fspMod[k] = (...a: unknown[]) => {
        if (a.some((x) => typeof x === "string" && /zr-data/i.test(x))) spied.push(`${k}(${String(a[0])})`);
        return (orig as (...a: unknown[]) => unknown)(...a);
      };
    }
    syncBuiltinESMExports();
    const g2 = (p: string) => errOf(() => ht.assertNotPrivate(p, "path"));
    try {
      const D$ = "\\\\zr-data.invalid\\d$\\zr\\trust\\hosts.key";
      const VOL = "\\\\zr-data.invalid\\volume1\\zr\\trust\\hosts.key";
      for (const p of [D$, VOL]) {
        for (const [name, fn] of [["load_project", () => engine.load(p)], ["import_video", () => engine.importVideo(p)], ["save", () => engine.save(p)]] as const) {
          const e = await errOf(fn);
          check(PRIVATE.test(e), `both rules: ${name} of ${JSON.stringify(p)} is refused (${e.slice(0, 100)})`);
        }
        const f = join(root, `spelling-${dataN++}.aive`);
        writeFixture(f, JSON.stringify(project(p)));
        const e = await errOf(() => engine.load(f));
        check(PRIVATE.test(e) && /^asset "asset_a1" path/.test(e), `both rules: a loaded asset.path ${JSON.stringify(p)} refuses the load (${e.slice(0, 100)})`);
      }
      // Identity check only (the names are not hosts.*).
      fake.noTrust = true;
      const otherJson = await errOf(() => engine.save("\\\\zr-data.invalid\\d$\\zr\\trust\\other.json"));
      check(PRIVATE.test(otherJson), `identity: a save to …\\d$\\zr\\trust\\other.json before trust/ exists is refused (data-folder identity, then the quick form) (${otherJson.slice(0, 100)})`);
      fake.noTrust = false;
      fake.fail["\\\\zr-data.invalid\\video"] = "EIO";
      const eio = await errOf(() => engine.load("\\\\zr-data.invalid\\video\\b.aive"));
      check(/couldn't check this path on \\\\zr-data\.invalid \(EIO\); try again\.$/.test(eio), `identity: an EIO on the folder makes load_project refuse ("couldn't check … try again") (${eio.slice(0, 120)})`);
      fake.fail = {};
      check((await g2("\\\\zr-data.invalid\\video\\b.aive")) === "(accepted)", "identity: once the folder answers, the same path passes");
      // Name rule only: the server gives no file ids.
      fake.zeroIno = true;
      for (const p of [D$, "\\\\zr-data.invalid\\d$\\zr\\trust\\HOSTS.KEY.", "\\\\zr-data.invalid\\d$\\zr\\trust\\hosts.key.bad-1", "\\\\zr-data.invalid\\d$\\zr\\trust\\hosts.lock.break-1.1"]) {
        check(PRIVATE.test(await g2(p)), `name rule (no file ids): ${JSON.stringify(p)} is refused`);
      }
      check((await g2("\\\\zr-data.invalid\\video\\a.mp4")) === "(accepted)", "name rule (no file ids): a media file passes");
      fake.zeroIno = false;
      fake.calls.length = 0;
      const e2 = await g2("\\\\zr-evil-2.invalid\\zr\\trust\\hosts.key");
      check(PRIVATE.test(e2) && fake.calls.length === 0, `name rule: another server's …\\trust\\hosts.key is refused, and that server is never stat'ed (${JSON.stringify(fake.calls)})`);
      for (const p of ["\\\\zr-data.invalid\\video\\a.mp4", "\\\\zr-data.invalid\\d$\\zr\\proxies\\p.mp4"]) check((await g2(p)) === "(accepted)", `passes: ${JSON.stringify(p)}`);
      // A loaded field whose folder can't be checked (EACCES): only that asset goes offline, the load goes on.
      // (No video in either asset, so nothing probes them after the load.)
      const twoAssets = join(root, "eacces.aive");
      const base = project("\\\\zr-data.invalid\\video\\c.mp4", { hasVideo: false, hasAudio: true }) as unknown as { assets: Record<string, unknown>[] };
      base.assets.push({ ...base.assets[0], id: "asset_a2", path: "\\\\zr-data.invalid\\stock\\d.mp4" });
      // A LUT in the same folder: the engine's uncheckedPaths (G5, G6 and resolveFont never open it).
      const LUT = "\\\\zr-data.invalid\\video\\l.cube";
      (base as unknown as { tracks: { clips: Record<string, unknown>[] }[] }).tracks[0].clips[0].effects = { lut: LUT };
      writeFixture(twoAssets, JSON.stringify(base));
      fake.fail["\\\\zr-data.invalid\\video"] = "EACCES";
      const loadErr = await thrown(() => engine.load(twoAssets));
      const [a1, a2] = engine.getProject().assets;
      check(loadErr === null && a1.pathCheckFailed === "EACCES" && isOffline(a1) && !isOffline(a2),
        `identity: an EACCES on one clip's folder: the load goes on, a1 is offline (pathCheckFailed ${a1.pathCheckFailed}), a2 is online (${loadErr?.message})`);
      const thumb = await thrown(() => dispatch(engine, "generate_thumbnail", { assetId: "asset_a1" }));
      check(thumb instanceof RpcError && thumb.code === "media_offline" && /couldn't check its folder on \\\\zr-data\.invalid \(EACCES\)/.test(thumb.message),
        `generate_thumbnail on a1 refuses with media_offline before any I/O (${thumb?.message.slice(0, 120)})`);
      check(!engine.isServablePath("\\\\zr-data.invalid\\video\\c.mp4") && !engine.isServablePath(LUT), "isServablePath is false for a1's file and for the unchecked LUT");
      const render = await thrown(() => dispatch(engine, "render_preview", {}));
      check(render instanceof RpcError && render.code === "media_offline" && /^Can't render yet: clip clip_c1 uses files on \\\\zr-data\.invalid whose folder ZabsReel couldn't check \(EACCES\)/.test(render.message),
        `render_preview refuses: the clip's file and LUT are in a folder that couldn't be checked (${render?.message.slice(0, 160)})`);
      fake.fail = {};
      engine.recheckOfflineMedia();
      check(!isOffline(engine.getProject().assets[0]) && engine.getProject().assets[0].pathCheckFailed === undefined, "once the folder answers, recheck_offline_media clears the flag and a1 is online");
      check(engine.isServablePath(LUT), "…and the LUT is no longer unchecked (the clip's .cube is servable)");
      check(spied.length === 0, `no readFile, writeFile or mkdir saw a refused or unchecked path (${JSON.stringify(spied)})`);
    } finally {
      for (const [k, orig] of saved) fspMod[k] = orig;
      syncBuiltinESMExports();
      (engine as unknown as { trust: HostTrust }).trust = realTrust;
      realTrust.reload(); // publish the engine's own servers again
      process.chdir(cwd);
    }
  }

  // ---- 7. rpc surface completeness ------------------------------------------------------
  // MUTATION: add a logoPath string parameter to a method (or drop a row from
  // RPC_PATH_PARAMS) → the completeness row fails. Add an allow_media_server
  // method → the name row fails. Remove G1 (requirePath) from an engine
  // method → its dispatch row fails when enforced (another error, or the trace).
  console.log("7. rpc surface: every path parameter is listed and gated...");
  {
    const PATHY = /path|font|lut|file|dir|url|output/i;
    const found: string[] = [];
    const walk = (t: unknown, at: string, method: string) => {
      const d = (t as { _def: { typeName: string; innerType?: unknown; schema?: unknown; type?: unknown; options?: unknown[]; valueType?: unknown } })._def;
      if (d.typeName === "ZodObject") for (const [k, v] of Object.entries((t as { shape: Record<string, unknown> }).shape)) walk(v, at ? `${at}.${k}` : k, method);
      else if (d.typeName === "ZodOptional" || d.typeName === "ZodNullable" || d.typeName === "ZodDefault") walk(d.innerType, at, method);
      else if (d.typeName === "ZodEffects") walk(d.schema, at, method);
      else if (d.typeName === "ZodArray") walk(d.type, `${at}[]`, method);
      else if (d.typeName === "ZodUnion" || d.typeName === "ZodDiscriminatedUnion") for (const o of d.options ?? []) walk(o, at, method);
      else if (d.typeName === "ZodRecord") walk(d.valueType, `${at}{}`, method);
      else if (d.typeName === "ZodString" && PATHY.test(at.split(".").pop() ?? "")) found.push(`${method} ${at}`);
    };
    for (const [name, def] of Object.entries(methods)) walk(def.schema, "", name);
    const listed = Object.entries(RPC_PATH_PARAMS).flatMap(([m, ps]) => ps.map((p) => `${m} ${p}`));
    const unlisted = found.filter((f) => !listed.includes(f));
    const stale = listed.filter((l) => !found.includes(l));
    check(unlisted.length === 0 && stale.length === 0, `every path-like string parameter is in RPC_PATH_PARAMS and every listed one exists (${Object.keys(methods).length} methods; unlisted ${JSON.stringify(unlisted)}; stale ${JSON.stringify(stale)})`);
    const approving = Object.keys(methods).filter((m) => /approv|trust|allow|grant/i.test(m) && m !== "list_media_servers" && m !== "recheck_offline_media");
    check(approving.length === 0 && "list_media_servers" in methods && "recheck_offline_media" in methods, `no method can allow or trust a server (${JSON.stringify(approving)})`);
    if (enforced) {
      // Each listed parameter, given a path on a server nobody allowed: refused by G1, the server is pending (origin request).
      const minimal = (schema: unknown): Record<string, unknown> => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries((schema as { shape: Record<string, { isOptional(): boolean; _def: { typeName: string } }> }).shape)) {
          if (v.isOptional()) continue;
          out[k] = v._def.typeName === "ZodNumber" ? 0 : v._def.typeName === "ZodArray" ? [] : k === "text" ? "t" : "clip_none";
        }
        return out;
      };
      let events = 0;
      engine.on("media-servers", () => void events++);
      for (const [m, ps] of Object.entries(RPC_PATH_PARAMS)) {
        for (const p of ps) {
          const evil = `//zr-evil-7.invalid/s/${m}.x`;
          const params = { ...minimal(methods[m as keyof typeof methods].schema), [p.replace("[]", "")]: p.endsWith("[]") ? [evil] : evil };
          if (m === "remember_projects") {
            const r = (await dispatch(engine, m, params)) as { skipped: { reason: string }[] };
            check(r.skipped.length === 1 && /network computer you haven't allowed/.test(r.skipped[0].reason), `remember_projects skips it (${JSON.stringify(r.skipped)})`);
            continue;
          }
          const e = await thrown(() => dispatch(engine, m, params));
          check(e instanceof RpcError && e.code === "media_server_not_approved" && e.details.host === "zr-evil-7.invalid" && /You cannot allow it yourself/.test(e.message),
            `${m}.${p} on an unallowed server: media_server_not_approved (${e instanceof RpcError ? e.code : ""} ${e?.message.slice(0, 90)})`);
        }
      }
      const pend = engine.mediaServers().pending.find((x) => x.host === "zr-evil-7.invalid");
      check(!!pend && pend.origins.includes("request") && pend.examples.length > 0 && events >= Object.keys(RPC_PATH_PARAMS).length,
        `the server is pending with origin request, and each request told the clients ("media-servers": ${events}) (${JSON.stringify(pend)})`);
    } else {
      console.log("  (dispatch rows need AIVE_NETWORK_GATE=enforce: in log mode G1 only logs)");
    }
  }

  // ---- 9. project name ------------------------------------------------------------------
  // MUTATION: drop the name rule from validateLoadedProject → the load row
  // keeps the path. Drop it from setProjectSettings → the refusal rows pass.
  console.log("9. a project name is never a path...");
  {
    const rows: [string, string][] = [["\\\\zr-evil.invalid\\s\\x", "x"], ["//h/s/x", "x"], ["x", "x"], ["C:x", "Cx"], ["\\\\h\\s\\", "Untitled"], ["a\u0007b", "ab"]];
    for (const [input, want] of rows) check(bareFileName(input) === want, `bareFileName(${JSON.stringify(input)}) = ${JSON.stringify(bareFileName(input))}`);
    for (const name of ["\\\\zr-evil.invalid\\s\\x", "a/b", "a\nb"]) {
      const e = await errOf(() => engine.setProjectSettings({ name }));
      check(/not a project name/.test(e), `setProjectSettings refuses the name ${JSON.stringify(name)} (${e.slice(0, 80)})`);
    }
    check((await errOf(() => engine.setProjectSettings({ name: "My Cut" }))) === "(accepted)" && engine.getProject().name === "My Cut", "a plain name passes");
    const f = join(root, "named.aive");
    writeFixture(f, JSON.stringify({ ...project("/x/a.mp4", { hasVideo: false, hasAudio: true }), name: "\\\\zr-evil.invalid\\s\\x" }));
    const e = await thrown(() => engine.load(f));
    check(e === null && engine.getProject().name === "x", `a loaded project named \\\\zr-evil.invalid\\s\\x loads with the name "x" (${e?.message}; ${engine.getProject().name})`);
    // An untitled project is named after the file it is saved to by the same rule (a POSIX file name may hold a "\").
    // MUTATION: name it after basename(path) again → the name keeps "a\b" on POSIX.
    engine.reset();
    const se = await thrown(() => engine.save(join(root, "a\\b.aive")));
    check(se === null && engine.getProject().name === "b", `a save to a\\b.aive names the untitled project "b" (${se?.message}; ${engine.getProject().name})`);
  }

  // ---- 10. storage: a known project on a server not allowed -------------------------------------
  // MUTATION: map it to "unreadable" (readProjectFile ignores `waiting`) → it
  // goes stale, the bake is trashed and the project is forgotten (and the
  // trace sees its read). Let updateUnavailable forget it (stale by age) →
  // the "stays known" row fails.
  console.log("10. storage: a known project on a server not allowed pauses clean-up, never goes stale...");
  {
    const DAY = 86_400_000;
    const evil = "//zr-evil-1.invalid/p/a.aive";
    const run = async (j: StorageJanitor, dd: string) => {
      const bake = join(dd, "baked", "only-evil.mp4");
      mkdirSync(dirname(bake), { recursive: true });
      writeFixture(bake, "x");
      const old = new Date(Date.now() - 2 * DAY);
      utimesSync(bake, old, old);
      writeFixture(join(dd, "projects.json"), JSON.stringify({ version: 1, since: Date.now() - 30 * DAY, projects: [evil], unavailable: { [evil]: Date.now() - 30 * DAY } }));
      const rep = await j.report();
      const u = rep.unavailableProjects.find((x) => x.path === evil);
      check(!!u && /not allowed yet/.test(u.reason) && u.pausesCleanUp && rep.wouldTrash.length === 0, `report: it is unavailable ("${u?.reason}"), pausesCleanUp, and nothing would be trashed past the retention period`);
      const r = await j.cleanUp({});
      const idx = JSON.parse(readFileSync(join(dd, "projects.json"), "utf8")) as { projects: string[] };
      check(r.moved.length === 0 && existsSync(bake) && idx.projects.includes(evil) && !r.forgotProjects.includes(evil), `clean-up moves nothing and it stays known (${JSON.stringify(r.moved)}; ${JSON.stringify(idx)})`);
      const f = await j.cleanUp({ forgetMissing: true });
      check(f.forgotProjects.includes(evil), `forgetMissing forgets it (${JSON.stringify(f.forgotProjects)})`);
    };
    // The janitor's own rule, in both modes: serverWaiting names the server, so the file is never read.
    const traced = touched.length;
    const dd = join(root, "storage-unc");
    const waiting = (p: string) => (/zr-evil/.test(p) ? "\\\\zr-evil-1.invalid" : undefined);
    await run(new StorageJanitor(dd, { liveProjects: () => [], runningJobs: () => [], log: () => {}, serverWaiting: waiting }), dd);
    if (enforced) {
      // The engine wires it to HostTrust: a server not approved.
      const de = join(root, "storage-unc-engine");
      const e2 = new EditorEngine(de);
      await run(e2.storage, de);
      e2.trust.close();
      engine.trust.start(); // publish the engine's own servers and trust folder again
    }
    // The janitor writes the name into projects.json (content, not a path); nothing else may see it.
    const seen = touched.splice(traced);
    check(seen.every((t) => t.startsWith("node:fs/promises writeFile({")), `the file itself is never stat'ed or read; the name only reaches projects.json's content (${JSON.stringify(seen.filter((t) => !t.startsWith("node:fs/promises writeFile({")).slice(0, 3))})`);
  }

  // ---- 14. log mode changes nothing; enforced, the offline state ---------------------------------
  // MUTATION: make HostTrust.isAllowed refuse in log mode → the log-mode row
  // finds the asset offline. Drop markOfflineMedia from load → the enforced
  // row finds it online and not pending. Drop the P13 redirect from
  // autoSaveIfDirty → the autosave row's save is refused (G1).
  console.log("14. a NAS path: log mode changes nothing; enforced it is offline...");
  {
    const NAS = "\\\\zr-nas.invalid\\s\\a.mp4";
    const f = join(root, "nas.aive");
    writeFixture(f, JSON.stringify(project(NAS, { hasVideo: false, hasAudio: true })));
    const fsp = require("node:fs/promises") as Record<string, unknown>;
    const realStat = fsp.stat;
    const seen: string[] = [];
    let a: Project["assets"][number] | undefined;
    const lines = await logsOf(async () => {
      await engine.load(f);
      a = engine.getProject().assets[0];
      // The network call itself, stubbed: what gatedfs lets through reaches this spy, never the network.
      fsp.stat = async (p: unknown) => void seen.push(String(p));
      syncBuiltinESMExports();
      try {
        await gfs.stat(NAS).catch(() => {});
      } finally {
        fsp.stat = realStat;
        syncBuiltinESMExports();
      }
    });
    const servers = engine.mediaServers();
    if (!enforced) {
      check(!!a && !isOffline(a) && a.awaitingServer === undefined && engine.isServablePath(NAS) && servers.gate === "log" && servers.pending.length === 0,
        `log mode: the NAS asset is not offline, servable, nothing pending (${JSON.stringify(a)}; ${JSON.stringify(servers)})`);
      check(lines.some((l) => l.includes("would block \\\\zr-nas.invalid")) && seen.length === 1,
        `log mode: a "would block" line is logged and the (stubbed) call goes through (${JSON.stringify(lines)}; ${JSON.stringify(seen)})`);
    } else {
      const p = servers.pending.find((x) => x.host === "zr-nas.invalid");
      check(!!a && a.awaitingServer === "zr-nas.invalid" && isOffline(a) && !engine.isServablePath(NAS) && servers.gate === "enforce" && !!p && p.origins.join() === "project" && p.files === 1,
        `enforced: the NAS asset waits for its server, is not servable, and is pending with origin project (${JSON.stringify(a)}; ${JSON.stringify(p)})`);
      check(lines.some((l) => l.includes("blocked \\\\zr-nas.invalid")) && seen.length === 0, `enforced: "blocked" is logged and the call never reaches the spy (${JSON.stringify(seen)})`);
      // P13: a project whose own file is on a server not allowed autosaves to the recovery folder.
      (engine as unknown as { currentPath: string }).currentPath = "//zr-evil-2.invalid/p/x.aive";
      engine.setProjectSettings({ name: "Dirty" });
      const saved = await thrown(async () => {
        const to = await engine.autoSaveIfDirty();
        check(!!to && to.startsWith(join(root, "data", "autosave", "Recovered-")) && existsSync(to), `the autosave of a project on an unallowed server goes to the recovery folder (${to})`);
      });
      check(saved === null, `…without refusing (${saved?.message})`);
      // Undo after a revoke: a snapshot taken while the server was allowed is marked again (G3 runs on undo / redo).
      // (A server that is not a traced name: approveHost writes it into hosts.json.)
      const OK2 = "zr-ok-2.invalid";
      await approveHost(engine.dataDir, OK2, "prompt");
      engine.recheckOfflineMedia();
      const f2 = join(root, "revoke.aive");
      writeFixture(f2, JSON.stringify(project(`//${OK2}/s/a.mp4`, { hasVideo: false, hasAudio: true })));
      await engine.load(f2);
      const online = engine.getProject().assets[0].awaitingServer === undefined;
      engine.setProjectSettings({ name: "Edited" });
      await revokeHost(engine.dataDir, OK2);
      engine.recheckOfflineMedia();
      const offlineNow = engine.getProject().assets[0].awaitingServer === OK2;
      engine.undo();
      const afterUndo = engine.getProject().assets[0].awaitingServer;
      engine.redo();
      check(online && offlineNow && afterUndo === OK2 && engine.getProject().assets[0].awaitingServer === OK2,
        `undo / redo after a revoke: the restored snapshot waits for its server too (online ${online}, revoked ${offlineNow}, after undo ${afterUndo})`);
      // The same with no re-read between the revoke and the undo: the undo's own check re-reads the store, which
      // asks for G3 again inside G3. The pass that asked must not finish with its older decisions (a3 online).
      // MUTATION: call markOfflineMedia directly from undo again → a3 stays online and OK3 is not pending.
      const OK3 = "zr-ok-3.invalid";
      await approveHost(engine.dataDir, OK3, "prompt");
      engine.recheckOfflineMedia();
      const three = project(`//${OK3}/s/1.mp4`, { id: "asset_a1", hasVideo: false, hasAudio: true });
      const [a1] = three.assets;
      three.assets.push({ ...a1, id: "asset_a2", path: "//zr-evil-1.invalid/s/2.mp4" }, { ...a1, id: "asset_a3", path: `//${OK3}/s/3.mp4` });
      const f3 = join(root, "revoke3.aive");
      writeFixture(f3, JSON.stringify(three));
      await engine.load(f3);
      engine.setProjectSettings({ name: "Edited" });
      await revokeHost(engine.dataDir, OK3);
      engine.undo(); // synchronous, before fs.watch's debounce
      const marks = engine.getProject().assets.map((x) => x.awaitingServer ?? "online").join();
      const p3 = engine.mediaServers().pending.find((x) => x.host === OK3);
      check(marks === `${OK3},zr-evil-1.invalid,${OK3}` && !!p3 && p3.origins.join() === "project" && p3.files === 2,
        `undo right after a revoke (no re-read between): both assets on the revoked server wait and it is pending with origin project (${marks}; ${JSON.stringify(p3)})`);
    }
    // resolveFont's backstop (behind G5): a font it may not open is never opened, and never silently swapped for the default font.
    const resolveFont = (engine as unknown as { resolveFont(w: string, s: string, c: Map<string, string>, d: string): Promise<string> }).resolveFont.bind(engine);
    const fontRows: [string, string][] = [["a refused form", "\\\\zr-evil-9.invalid@SSL\\s\\f.ttf"]];
    if (enforced) fontRows.push(["a server not allowed", "//zr-evil-9.invalid/s/f.ttf"]);
    for (const [label, font] of fontRows) {
      const e = await thrown(() => resolveFont(join(root, "render"), font, new Map(), "font.ttf"));
      check(!!e && /^Font ".*" (is a path ZabsReel never opens|is on \\\\zr-evil-9\.invalid, which hasn't been allowed)\.$/.test(e.message), `resolveFont refuses ${label} (${e?.message})`);
    }
    // timeline_summary (7.4), in either mode: a clip whose file was not found says so, and offlineMedia counts it.
    // MUTATION: drop the "file not found" case from engine.assetOffline → this row fails.
    const gone = join(root, "gone.aive");
    writeFixture(gone, JSON.stringify(project(join(root, "gone.mp4"), { missing: true })));
    await engine.load(gone);
    const gs = (await dispatch(engine, "timeline_summary", {})) as { tracks: { clips: { offline?: string }[] }[]; offlineMedia?: { count: number; servers: string[] } };
    check(gs.tracks[0].clips[0].offline === "file not found" && gs.offlineMedia?.count === 1 && gs.offlineMedia.servers.length === 0,
      `timeline_summary marks a clip whose file was not found (${gs.tracks[0].clips[0].offline}; ${JSON.stringify(gs.offlineMedia)})`);
  }
  if (enforced) {
    // The unread state (3.1), with the engine: nothing listed is trusted or outside; a load goes on with the asset
    // offline; an rpc path is refused with unread: true and no request; the first good read brings it online.
    // MUTATION: add the request entry while unread (requirePath) → the "no request" row fails. Drop the
    // onChange → onTrustChanged wiring → the asset stays offline after the read works.
    const d = freshData();
    // (The approved host is not a traced name: approveHost writes it into hosts.json.)
    await approveHost(d, "zr-ok-1.invalid", "prompt");
    writeList(d, [...readList(d).servers, { host: "zr-evil-3.invalid" }]);
    const inject: ReadErrorInjection = { "hosts.key": "EBUSY" };
    const realTrust = engine.trust;
    const ht = new HostTrust(d, { readError: inject, onChange: () => engine.onTrustChanged() });
    (engine as unknown as { trust: HostTrust }).trust = ht;
    ht.start();
    try {
      const f = join(root, "unread.aive");
      writeFixture(f, JSON.stringify(project("//zr-ok-1.invalid/s/a.mp4", { hasVideo: false, hasAudio: true })));
      await engine.load(f);
      const servers = engine.mediaServers();
      check(engine.getProject().assets[0].awaitingServer === "zr-ok-1.invalid" && JSON.stringify(servers.unread) === '["hosts.key"]' && servers.approved.length === 0 && servers.outside.length === 0 && !servers.pending.some((x) => x.origins.includes("outside")),
        `unread at start: the load goes on with the asset offline, nothing approved or outside, no outside origin (${JSON.stringify(servers)})`);
      // MUTATION: drop the unread case from engine.offlineText → the summary row says "waiting for the user to allow".
      const us = (await dispatch(engine, "timeline_summary", {})) as { tracks: { clips: { offline?: string }[] }[]; offlineMedia?: { servers: string[] } };
      check(us.tracks[0].clips[0].offline === "ZabsReel couldn't read its list of approved computers; retrying" && us.offlineMedia?.servers.join() === "\\\\zr-ok-1.invalid",
        `timeline_summary while unread: the clip's offline text is the unread one (${us.tracks[0].clips[0].offline}; ${JSON.stringify(us.offlineMedia)})`);
      const thumb = await thrown(() => dispatch(engine, "generate_thumbnail", { assetId: "asset_a1" }));
      check(thumb instanceof RpcError && thumb.code === "media_offline" && /couldn't read its list of approved computers/.test(thumb.message), `generate_thumbnail refuses with media_offline and the unread wording (${thumb?.message.slice(0, 140)})`);
      const imp = await thrown(() => dispatch(engine, "import_video", { path: "//zr-ok-1.invalid/s/b.mp4" }));
      check(imp instanceof RpcError && imp.code === "media_server_not_approved" && imp.details.unread === true && /couldn't read its list of approved computers; retrying/.test(imp.message)
        && !engine.mediaServers().pending.some((x) => x.origins.includes("request")), `import_video refuses with unread: true and adds no request (${imp?.message.slice(0, 120)})`);
      delete inject["hosts.key"];
      const t0 = Date.now();
      while (Date.now() - t0 < 2_000 && engine.getProject().assets[0].awaitingServer) await sleep(50);
      const after = engine.mediaServers();
      check(engine.getProject().assets[0].awaitingServer === undefined && after.unread.length === 0 && after.pending.some((x) => x.host === "zr-evil-3.invalid" && x.origins.includes("outside")),
        `the read works again: within 2 s the asset is online, and only now is zr-evil-3.invalid pending as outside (${Date.now() - t0} ms; ${JSON.stringify(after)})`);
    } finally {
      ht.close();
      (engine as unknown as { trust: HostTrust }).trust = realTrust;
      realTrust.start();
    }
  }
  check(touched.length === 0, `no fs or child_process call saw a test host (${JSON.stringify(touched.slice(0, 5))})`);

  rmSync(root, { recursive: true, force: true });

  console.log(failures === 0 ? "\nALL UNC CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
