/**
 * SOTA Phase 1 deliverable: the local platform is safe to expose.
 *  - /rpc without the session token → 401; with it → ok.
 *  - /health without the token → liveness only (no ffmpeg banner / revision).
 *  - /file refuses arbitrary disk paths (403 even WITH a valid token) and
 *    serves only data-dir artifacts + imported asset files; HEAD /file gives
 *    an exposed ETag (size + mtime) that changes when a file is rewritten.
 *  - WebSocket upgrade without the token → connection refused.
 *  - /file, /frames and /peaks open only the path they checked (fs and
 *    child_process traced): a ".." after a linked folder, a link in the data
 *    dir that leads out of it, and an asset's proxy or preview path outside
 *    the data dir are refused (403) and nothing opens them; load drops such a
 *    proxy or preview path, and so does an .otio import; data-dir files, a
 *    file in a symlinked proxies/ and an asset's own file (a link included)
 *    are still served, through the resolved path. A missing data-dir file is
 *    404; a clip's .cube LUT that links to a non-.cube file is refused.
 *
 * Run: npx tsx packages/core/scripts/smoke-security.ts
 * (No media arguments needed — synthesizes its own clip with ffmpeg lavfi.)
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { EditorEngine } from "../src/engine.js";
import { EditorServer } from "../src/server.js";
import { runFfmpeg } from "../src/ffmpeg/executor.js";
import { projectToOtio } from "../src/interop/otio.js";

// ---- fs / child_process trace (section 6) ------------------------------------
// Every fs, fs/promises and child_process function records its string arguments
// (and argv arrays) while `tracing`; the core's gatedfs and execa see the
// wrappers through syncBuiltinESMExports.
const traced: string[] = [];
let tracing = false;
const require = createRequire(import.meta.url);
for (const mod of ["node:fs", "node:fs/promises", "node:child_process"]) {
  const m = require(mod) as Record<string, unknown>;
  const wrap = (orig: (...a: unknown[]) => unknown, key: string) => {
    const wrapped = function (this: unknown, ...args: unknown[]) {
      if (tracing) {
        for (const a of args) for (const v of Array.isArray(a) ? a : [a]) if (typeof v === "string") traced.push(`${mod} ${key} ${v}`);
      }
      return orig.apply(this, args);
    };
    return Object.assign(wrapped, orig);
  };
  for (const key of Object.keys(m)) {
    const orig = m[key];
    if (typeof orig !== "function" || /^[A-Z]/.test(key)) continue;
    m[key] = wrap(orig as (...a: unknown[]) => unknown, key);
    // gatedfs's realpathNative calls fs.realpathSync.native.
    const native = (orig as { native?: unknown }).native;
    if (typeof native === "function") (m[key] as { native: unknown }).native = wrap(native as (...a: unknown[]) => unknown, `${key}.native`);
  }
}
syncBuiltinESMExports();

/** The traced calls `fn` makes. */
async function traceOf<T>(fn: () => Promise<T>): Promise<{ value: T; calls: string[] }> {
  traced.length = 0;
  tracing = true;
  try {
    return { value: await fn(), calls: traced.slice() };
  } finally {
    tracing = false;
  }
}

/** Calls that read content or start a process (stat, open, createReadStream, readFile, FFmpeg/ffprobe). */
const OPENS = / (stat|open|createReadStream|readFile|spawn|execFile|exec|fork|spawnSync|execFileSync) /;

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "aive-security-"));
  const engine = new EditorEngine(dataDir);
  const server = new EditorServer(engine, { port: 0, dataDir });
  const port = await server.start();
  const base = `http://127.0.0.1:${port}`;

  // The published discovery file must carry the token clients need.
  const info = JSON.parse(readFileSync(join(dataDir, "server.json"), "utf8")) as { port: number; token: string };
  const token = info.token;

  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  };

  console.log("1. token discovery...");
  check(typeof token === "string" && token.length >= 24, "server.json publishes a token");
  check(info.port === port, "server.json publishes the bound port");

  console.log("2. /rpc auth...");
  const rpcNoToken = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "timeline_summary", params: {} }),
  });
  check(rpcNoToken.status === 401, `/rpc without token → 401 (got ${rpcNoToken.status})`);
  const noTokenBody = (await rpcNoToken.json()) as { error?: string };
  check(/x-aive-token/.test(noTokenBody.error ?? ""), "401 error teaches how to authenticate");

  const rpcWithToken = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-aive-token": token },
    body: JSON.stringify({ method: "timeline_summary", params: {} }),
  });
  check(rpcWithToken.status === 200, `/rpc with token → 200 (got ${rpcWithToken.status})`);

  const rpcBadToken = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-aive-token": "wrong-token" },
    body: JSON.stringify({ method: "timeline_summary", params: {} }),
  });
  check(rpcBadToken.status === 401, `/rpc with WRONG token → 401 (got ${rpcBadToken.status})`);

  console.log("3. /health redaction...");
  const healthAnon = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
  check(healthAnon.ok === true, "/health stays reachable without a token (liveness)");
  check(!("ffmpeg" in healthAnon) && !("revision" in healthAnon), "unauthenticated /health hides internals");
  const healthAuthed = (await (
    await fetch(`${base}/health`, { headers: { "x-aive-token": token } })
  ).json()) as Record<string, unknown>;
  check("revision" in healthAuthed, "authenticated /health includes internals");

  console.log("4. /file allowlist (synthesizing a clip with ffmpeg)...");
  const clipPath = join(dataDir, "..", `aive-sec-clip-${Date.now()}.mp4`);
  await runFfmpeg([
    "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10:duration=1",
    "-pix_fmt", "yuv420p", "-y", clipPath,
  ]);

  // Not imported, outside dataDir → forbidden even with a valid token.
  const fileForbidden = await fetch(`${base}/file?path=${encodeURIComponent(clipPath)}&token=${token}`);
  check(fileForbidden.status === 403, `/file for a non-imported path → 403 (got ${fileForbidden.status})`);

  // A random system file: also forbidden.
  const sysPath = process.platform === "win32" ? "C:/Windows/win.ini" : "/etc/hosts";
  const fileSystem = await fetch(`${base}/file?path=${encodeURIComponent(sysPath)}&token=${token}`);
  check(fileSystem.status === 403, `/file for ${sysPath} → 403 (got ${fileSystem.status})`);

  // Traversal from inside the data dir must not escape it.
  const traversal = join(dataDir, "previews", "..", "..", "server-escape.txt");
  const fileTraversal = await fetch(`${base}/file?path=${encodeURIComponent(traversal)}&token=${token}`);
  check(fileTraversal.status === 403, `/file with ..-traversal outside dataDir → 403 (got ${fileTraversal.status})`);

  // After import the SAME file becomes servable (and still requires the token).
  await engine.importVideo(clipPath);
  const fileOk = await fetch(`${base}/file?path=${encodeURIComponent(clipPath)}&token=${token}`);
  check(fileOk.status === 200, `/file for an IMPORTED asset → 200 (got ${fileOk.status})`);
  const fileNoToken = await fetch(`${base}/file?path=${encodeURIComponent(clipPath)}`);
  check(fileNoToken.status === 401, `/file without token → 401 (got ${fileNoToken.status})`);

  // A .cube LUT a clip uses becomes servable (the live preview runs it on the
  // GPU); a .cube no clip uses, and a non-.cube path set as a LUT, do not.
  const cubePath = join(dataDir, "..", `aive-sec-lut-${Date.now()}.cube`);
  const otherCube = join(dataDir, "..", `aive-sec-other-${Date.now()}.cube`);
  writeFileSync(cubePath, "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n");
  writeFileSync(otherCube, "LUT_3D_SIZE 2\n");
  const cubeBefore = await fetch(`${base}/file?path=${encodeURIComponent(cubePath)}&token=${token}`);
  check(cubeBefore.status === 403, `/file for a .cube no clip uses → 403 (got ${cubeBefore.status})`);
  const lutClip = engine.appendClip(engine.getProject().assets[0].id);
  engine.setClipEffects(lutClip.id, { lut: cubePath });
  const cubeOk = await fetch(`${base}/file?path=${encodeURIComponent(cubePath)}&token=${token}`);
  check(cubeOk.status === 200 && (await cubeOk.text()).startsWith("LUT_3D_SIZE"), `/file for the clip's .cube LUT → 200 (got ${cubeOk.status})`);
  // HEAD answers with the headers only: an ETag (size + mtime) the live preview
  // compares to notice a LUT rewritten in place, exposed to the cross-origin renderer.
  const cubeUrl = `${base}/file?path=${encodeURIComponent(cubePath)}&token=${token}`;
  const head1 = await fetch(cubeUrl, { method: "HEAD" });
  const etag1 = head1.headers.get("etag");
  check(head1.status === 200 && !!etag1 && (await head1.text()) === "", `HEAD /file → 200 with an ETag and no body (got ${head1.status}, ${etag1})`);
  check((head1.headers.get("access-control-expose-headers") ?? "").includes("ETag") && head1.headers.get("cache-control") === "no-cache",
    "the ETag is exposed to other origins and the response must be revalidated (no-cache)");
  check(cubeOk.headers.get("etag") === etag1, "GET carries the same ETag");
  writeFileSync(cubePath, "LUT_3D_SIZE 2\n1 1 1\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n0 0 0\n"); // same size, new content
  utimesSync(cubePath, new Date(), new Date(Date.now() + 5000));
  const etag2 = (await fetch(cubeUrl, { method: "HEAD" })).headers.get("etag");
  check(!!etag2 && etag2 !== etag1, `rewriting the LUT in place changes its ETag (${etag1} → ${etag2})`);
  check((await fetch(`${base}/file?path=${encodeURIComponent(cubePath)}`, { method: "HEAD" })).status === 401, "HEAD /file without the token → 401");
  check((await fetch(`${base}/file?path=${encodeURIComponent(otherCube)}&token=${token}`, { method: "HEAD" })).status === 403, "HEAD /file for a path no clip uses → 403");
  const cubeOther = await fetch(`${base}/file?path=${encodeURIComponent(otherCube)}&token=${token}`);
  check(cubeOther.status === 403, `/file for another .cube → 403 (got ${cubeOther.status})`);
  // Only an existing .cube file can be set as a LUT: a non-.cube or missing
  // path is refused and the clip keeps its LUT; .CUBE is a .cube; clearing works.
  // MUTATION: drop the .cube test in setClipEffects → the non-.cube rows fail;
  // drop the statSync test → the missing-file rows fail.
  const lutErr = (lut: string): string => {
    try { engine.setClipEffects(lutClip.id, { lut }); return "(accepted)"; } catch (err) { return (err as Error).message; }
  };
  const lutNow = () => engine.getProject().tracks.flatMap((t) => t.clips).find((c) => c.id === lutClip.id)?.effects?.lut;
  const notCubeErr = lutErr(sysPath);
  check(/is not a \.cube file/.test(notCubeErr) && notCubeErr.includes(lutClip.id) && notCubeErr.includes(sysPath),
    `setting a non-.cube path as a LUT is refused, naming the clip and path (${notCubeErr.slice(0, 90)})`);
  check(lutNow() === cubePath, `the refused non-.cube LUT leaves the clip's .cube LUT (${lutNow()})`);
  const notCube = await fetch(`${base}/file?path=${encodeURIComponent(sysPath)}&token=${token}`);
  check(notCube.status === 403, `/file for a non-.cube path refused as a LUT → 403 (got ${notCube.status})`);
  const missingCube = join(dataDir, "..", `aive-sec-missing-${Date.now()}.cube`);
  const missingErr = lutErr(missingCube);
  check(/does not exist/.test(missingErr), `setting a .cube that does not exist is refused (${missingErr.slice(0, 90)})`);
  check(lutNow() === cubePath, "the refused missing LUT leaves the clip's .cube LUT");
  // A NUL byte is refused before anything resolves the path (G2, ENUL), with a
  // product sentence that names the clip, never Node's raw ERR_INVALID_ARG_VALUE.
  // MUTATION: drop the NUL check in HostTrust.checkPath → the refusal becomes
  // "couldn't check this path (ERR_INVALID_ARG_VALUE)" and this row fails.
  const nulErr = lutErr(join(dataDir, "..", "aive-sec-nul\u0000.cube"));
  check(/contains a NUL character/.test(nulErr) && nulErr.includes(lutClip.id) && !/ERR_INVALID_ARG_VALUE|must be a string/.test(nulErr),
    `a LUT path with a NUL byte gets a plain refusal naming the clip, not a raw fs error (${JSON.stringify(nulErr.slice(0, 90))})`);
  check(lutNow() === cubePath, "the refused NUL-byte LUT leaves the clip's .cube LUT");
  const upperCube = join(dataDir, "..", `aive-sec-upper-${Date.now()}.CUBE`);
  writeFileSync(upperCube, "LUT_3D_SIZE 2\n");
  check(lutErr(upperCube) === "(accepted)" && lutNow() === upperCube, "an existing .CUBE file is accepted as a LUT");
  // MUTATION: drop the toLowerCase in servablePath's LUT real-path test → 403.
  const upperOk = await fetch(`${base}/file?path=${encodeURIComponent(upperCube)}&token=${token}`);
  check(upperOk.status === 200, `/file for the clip's .CUBE LUT → 200 (got ${upperOk.status})`);
  engine.clearClipEffects(lutClip.id);
  check(lutNow() === undefined, "clear_clip_effects removes the LUT");
  const cleared = await fetch(`${base}/file?path=${encodeURIComponent(upperCube)}&token=${token}`);
  check(cleared.status === 403, `/file for a cleared LUT → 403 (got ${cleared.status})`);
  check(/is empty/.test(lutErr("")), "an empty LUT path is still refused (clear_clip_effects clears)");

  console.log("5. WebSocket upgrade auth...");
  const wsDenied = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const timer = setTimeout(() => { ws.terminate(); resolve(false); }, 3000);
    ws.on("open", () => { clearTimeout(timer); ws.close(); resolve(false); });
    ws.on("error", () => { clearTimeout(timer); resolve(true); });
  });
  check(wsDenied, "WS upgrade without token is refused");

  const wsAllowed = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
    const timer = setTimeout(() => { ws.terminate(); resolve(false); }, 3000);
    ws.on("open", () => { clearTimeout(timer); ws.close(); resolve(true); });
    ws.on("error", () => { clearTimeout(timer); resolve(false); });
  });
  check(wsAllowed, "WS upgrade with token connects");

  console.log("6. /file, /frames and /peaks open only the path they checked...");
  if (process.platform === "win32") {
    console.log("  (skipped: needs symbolic links)");
  } else {
    // Outside the data dir: a media file the routes must never serve, and a
    // folder whose link sits in the data dir. Inside it: a decoy with the
    // name a lexical resolve of the ".." query gives.
    const outside = mkdtempSync(join(tmpdir(), "aive-sec-outside-"));
    const secret = join(outside, "real", "secret.mp4");
    mkdirSync(join(outside, "real", "sub"), { recursive: true });
    await runFfmpeg([
      "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", secret,
    ]);
    copyFileSync(secret, join(dataDir, "secret.mp4"));
    mkdirSync(join(dataDir, "previews"), { recursive: true });
    symlinkSync(join(outside, "real", "sub"), join(dataDir, "zr-hop"), "dir");
    symlinkSync(join(outside, "real"), join(dataDir, "zr-outlink"), "dir");
    symlinkSync(secret, join(dataDir, "previews", "zr-leak.mp4"));
    const get = (route: string, p: string) => {
      const q = new URLSearchParams({ path: p, token, from: "0", count: "1", w: "8", h: "8", fps: "10" });
      return traceOf(async () => {
        const r = await fetch(`${base}${route}?${q}`);
        return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
      });
    };
    /** Each route refuses `p` (403), and no stat, open, read or process names `marks`. */
    const refused = async (p: string, marks: RegExp, what: string) => {
      for (const route of ["/file", "/frames", "/peaks"]) {
        const { value, calls } = await get(route, p);
        const opened = calls.filter((c) => OPENS.test(c) && marks.test(c));
        check(value.status === 403 && opened.length === 0,
          `${route} of ${what}: 403 and nothing opened (got ${value.status}, ${value.body.length} bytes; ${JSON.stringify(opened.slice(0, 2))})`);
      }
    };
    const marks = new RegExp(`zr-hop|zr-outlink|zr-leak|${outside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

    // a. A ".." after a linked folder: the kernel follows zr-hop first (to the
    // outside folder), a lexical resolve gives the decoy. Refused before either.
    // Defence in depth: the resolved path is the one opened, so without the rule
    // the decoy, not the outside file, would be served.
    // MUTATION: drop the hasDotDot test in servablePath → the decoy is served (200).
    await refused(join(dataDir, "zr-hop") + "/../secret.mp4", marks, `a ".." after a linked folder`);

    // b. A link in the data dir that leads out of it (a folder link, a file link).
    // MUTATION: accept any real path in servablePath (drop the isUnder(real, …)
    // test) → the outside file is served (200).
    await refused(join(dataDir, "zr-outlink", "secret.mp4"), marks, "a file through a folder link in the data dir that leads out");
    await refused(join(dataDir, "previews", "zr-leak.mp4"), marks, "a file link in the data dir that leads out");

    // c. An asset's proxy or preview path outside the data dir is not servable;
    // its media path is. MUTATION: match a.proxyPath / a.previewPath again in
    // servableAs → these rows get 200.
    const asset = engine.getProject().assets[0];
    const preview = join(outside, "real", "preview.mp4");
    copyFileSync(secret, preview);
    asset.proxyPath = secret;
    asset.previewPath = preview;
    await refused(secret, marks, "an asset's proxy path outside the data dir");
    await refused(preview, marks, "an asset's preview path outside the data dir");
    check(!engine.isServablePath(secret) && !engine.isServablePath(preview), "isServablePath is false for both");

    // d. Load drops a proxy or preview path outside the data dir (engine-made caches,
    // always written there) and keeps one inside it.
    // MUTATION: drop the dropForeignCaches call in load → the outside paths stay.
    const inside = join(dataDir, "previews", "zr-ok.webm");
    writeFileSync(inside, "webm");
    const saved = JSON.parse(JSON.stringify(engine.getProject()));
    saved.assets[0].proxyPath = secret;
    saved.assets[0].previewPath = preview;
    saved.assets.push({ ...saved.assets[0], id: "asset_inside", proxyPath: inside, previewPath: inside });
    mkdirSync(join(dataDir, "projects"), { recursive: true });
    const projectFile = join(dataDir, "projects", "zr-caches.aive");
    writeFileSync(projectFile, JSON.stringify(saved));
    await engine.load(projectFile);
    const [a0, a1] = engine.getProject().assets;
    check(a0.proxyPath === undefined && a0.previewPath === undefined,
      `load drops a proxy and a preview path outside the data dir (${a0.proxyPath}, ${a0.previewPath})`);
    check(a1?.proxyPath === inside && a1?.previewPath === inside, "load keeps a proxy and a preview path in the data dir");

    // e. Still served: a data-dir file and the asset's own file, through the path
    // that was checked (resolved), never the query as given.
    // MUTATION: stat / open the raw query in serveFile (or pass q / p.path to
    // streamFrames / peaksFor) → that row's traced path is the raw one.
    const okFile = join(dataDir, "previews", "zr-ok.png");
    writeFileSync(okFile, "png-bytes");
    const okRaw = `${dataDir}//previews/./zr-ok.png`;
    const okGet = await get("/file", okRaw);
    const okSeen = okGet.calls.filter((c) => OPENS.test(c) && c.includes("zr-ok.png"));
    check(okGet.value.status === 200 && okGet.value.body.toString() === "png-bytes", `/file of a data-dir file → 200 (got ${okGet.value.status})`);
    check(okSeen.length >= 2 && okSeen.every((c) => c.endsWith(` ${okFile}`)),
      `/file stats and opens exactly the resolved path (${JSON.stringify(okSeen)})`);
    const decoy = join(dataDir, "secret.mp4");
    for (const route of ["/frames", "/peaks"]) {
      const r = await get(route, `${dataDir}//./secret.mp4`);
      const seen = r.calls.filter((c) => OPENS.test(c) && c.includes("secret.mp4"));
      check(r.value.status === 200 && r.value.body.length > 0, `${route} of a data-dir media file → 200 (got ${r.value.status}, ${r.value.body.length} bytes)`);
      check(seen.some((c) => / (spawn|execFile) /.test(c)) && seen.every((c) => c.endsWith(` ${decoy}`)),
        `${route} hands FFmpeg exactly the resolved path (${JSON.stringify(seen.slice(0, 3))})`);
    }
    const own = await get("/file", clipPath);
    check(own.value.status === 200, `/file of the asset's own path after the load → 200 (got ${own.value.status})`);

    // e2. A data-dir file that is missing (a cache that cleanup removed) is 404
    // "File not found", not 403, on every route, so the client regenerates it;
    // so is a path under a file (ENOTDIR). servablePath's real-path lookup decides.
    // MUTATION: collapse the ENOENT/ENOTDIR ternary in servablePath to 403 → these rows fail.
    const missing = join(dataDir, "previews", "zr-missing.mp4");
    for (const [p, what] of [[missing, "a missing data-dir file"], [join(okFile, "x"), "a path under a data-dir file (ENOTDIR)"]]) {
      for (const route of ["/file", "/frames", "/peaks"]) {
        const r = await get(route, p);
        let error = "";
        try { error = (JSON.parse(r.value.body.toString()) as { error?: string }).error ?? ""; } catch { /* not JSON */ }
        check(r.value.status === 404 && error === "File not found", `${route} of ${what} → 404 "File not found" (got ${r.value.status}, ${JSON.stringify(error)})`);
      }
    }

    // f. An asset imported through a link: its own path is servable whatever its real path.
    // MUTATION: drop the "entry" early return in servablePath → 403.
    const viaLink = join(outside, "zr-media-link.mp4");
    symlinkSync(secret, viaLink);
    await engine.importVideo(viaLink);
    const linked = await get("/file", viaLink);
    check(linked.value.status === 200 && linked.value.body.equals(readFileSync(secret)), `/file of an asset imported through a link → 200 (got ${linked.value.status})`);
    // Its real path is not looked up for /file: only G2's check (trust.checkPath)
    // resolves it, once, so media on a share gets no extra I/O per request.
    // MUTATION: move the "entry" return after the realpathNative call → two.
    const realpaths = linked.calls.filter((c) => / realpath/.test(c) && c.endsWith(` ${viaLink}`));
    check(realpaths.length === 1, `/file of an asset's own path resolves it once, for G2 only (${JSON.stringify(realpaths)})`);

    // g. A data-dir folder the engine writes to may be a link to another disk (a
    // symlinked proxies/): what is under its real path is served. The links that
    // lead out stay refused, and so does a file link in that folder that leads
    // out of its real path. MUTATION: drop the DATA_AREAS test in servablePath
    // → the proxy rows get 403.
    const bigDisk = mkdtempSync(join(tmpdir(), "aive-sec-bigdisk-"));
    mkdirSync(join(bigDisk, "proxies"));
    copyFileSync(secret, join(bigDisk, "proxies", "zr-big.mp4"));
    symlinkSync(secret, join(bigDisk, "proxies", "zr-leak-big.mp4"));
    check(!existsSync(join(dataDir, "proxies")), "no proxies/ yet in the data dir");
    symlinkSync(join(bigDisk, "proxies"), join(dataDir, "proxies"), "dir");
    for (const route of ["/file", "/frames", "/peaks"]) {
      const r = await get(route, join(dataDir, "proxies", "zr-big.mp4"));
      check(r.value.status === 200 && r.value.body.length > 0, `${route} of a file in a symlinked proxies/ → 200 (got ${r.value.status}, ${r.value.body.length} bytes)`);
    }
    await refused(join(dataDir, "proxies", "zr-leak-big.mp4"), marks, "a file link in a symlinked proxies/ that leads out of it");
    await refused(join(dataDir, "zr-outlink", "secret.mp4"), marks, "a folder link out of the data dir, with a symlinked proxies/");
    await refused(join(dataDir, "previews", "zr-leak.mp4"), marks, "a file link out of the data dir, with a symlinked proxies/");
    await refused(join(dataDir, "zr-hop") + "/../secret.mp4", marks, `a ".." after a linked folder, with a symlinked proxies/`);
    // Only what is under such a folder: a file link that has a folder's name is refused.
    // MUTATION: drop the `rest.length > 0` test in servablePath → 200.
    check(!existsSync(join(dataDir, "sfx")), "no sfx/ yet in the data dir");
    symlinkSync(secret, join(dataDir, "sfx"));
    await refused(join(dataDir, "sfx"), /sfx|aive-sec-outside-/, "a file link named like a data-dir folder that leads out");

    // h. An .otio import drops a proxy or preview path outside the data dir and
    // keeps one inside it, as load does (the asset list travels in the metadata).
    // MUTATION: drop the dropForeignCaches call in importOtio → the outside paths stay.
    const forOtio = JSON.parse(JSON.stringify(saved));
    forOtio.assets[1].path = decoy;
    const otioFile = join(dataDir, "projects", "zr-caches.otio");
    writeFileSync(otioFile, JSON.stringify(projectToOtio(forOtio)));
    await engine.importOtio(otioFile);
    const outAsset = engine.getProject().assets.find((a) => a.path === clipPath);
    const inAsset = engine.getProject().assets.find((a) => a.path === decoy);
    check(outAsset !== undefined && outAsset.proxyPath === undefined && outAsset.previewPath === undefined,
      `import_otio drops a proxy and a preview path outside the data dir (${outAsset?.proxyPath}, ${outAsset?.previewPath})`);
    check(inAsset?.proxyPath === inside && inAsset?.previewPath === inside, "import_otio keeps a proxy and a preview path in the data dir");

    // i. A clip's LUT must really be a .cube: a .cube link to another file (an
    // untrusted project's LUT in an extracted pack) is refused and nothing reads
    // the target; a .cube link to another .cube is served (a real .cube: section 4).
    // MUTATION: return "entry" again for a clip's LUT in servableAs (no real-path
    // check) → the link-to-a-media-file rows get 200.
    const lutLink = join(outside, "zr-lut-link.cube");
    symlinkSync(secret, lutLink);
    const lutUser = engine.appendClip(engine.getProject().assets[0].id);
    engine.setClipEffects(lutUser.id, { lut: lutLink });
    await refused(lutLink, marks, "a clip's .cube LUT that links to a non-.cube file");
    // MUTATION: drop the "lut" return in servablePath (it falls to the data-dir
    // test) → this row and section 4's .cube and .CUBE rows get 403.
    const realCube = join(outside, "real", "zr-look.cube");
    writeFileSync(realCube, "LUT_3D_SIZE 2\n");
    const cubeLink = join(outside, "zr-cube-link.cube");
    symlinkSync(realCube, cubeLink);
    engine.setClipEffects(lutUser.id, { lut: cubeLink });
    const viaCube = await get("/file", cubeLink);
    check(viaCube.value.status === 200 && viaCube.value.body.toString() === "LUT_3D_SIZE 2\n",
      `/file of a clip's .cube LUT that links to another .cube → 200 (got ${viaCube.value.status})`);
  }

  await server.stop();
  console.log(failures === 0 ? "\nSECURITY SMOKE TEST PASSED" : `\nSECURITY SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("SECURITY SMOKE TEST FAILED:", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  process.exit(1);
});
