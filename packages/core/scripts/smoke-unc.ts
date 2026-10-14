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
 *
 * Pure: no FFmpeg, no network. The only hosts are under the reserved .invalid
 * top-level domain (the 2.3 vectors only reach the pure classifier).
 * Run: npx tsx packages/core/scripts/smoke-unc.ts
 */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyPath, normalizeHost } from "../src/unc.js";
import { assertLocalMediaPath, assertProjectMediaLocal, isLocalMediaPath, isProtocolLike } from "../src/safepath.js";
import { EditorEngine } from "../src/engine.js";
import type { Project } from "../src/types.js";

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
  rmSync(root, { recursive: true, force: true });

  console.log(failures === 0 ? "\nALL UNC CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
