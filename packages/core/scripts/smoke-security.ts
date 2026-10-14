/**
 * SOTA Phase 1 deliverable: the local platform is safe to expose.
 *  - /rpc without the session token → 401; with it → ok.
 *  - /health without the token → liveness only (no ffmpeg banner / revision).
 *  - /file refuses arbitrary disk paths (403 even WITH a valid token) and
 *    serves only data-dir artifacts + imported asset files; HEAD /file gives
 *    an exposed ETag (size + mtime) that changes when a file is rewritten.
 *  - WebSocket upgrade without the token → connection refused.
 *
 * Run: npx tsx packages/core/scripts/smoke-security.ts
 * (No media arguments needed — synthesizes its own clip with ffmpeg lavfi.)
 */
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { EditorEngine } from "../src/engine.js";
import { EditorServer } from "../src/server.js";
import { runFfmpeg } from "../src/ffmpeg/executor.js";

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
  const upperCube = join(dataDir, "..", `aive-sec-upper-${Date.now()}.CUBE`);
  writeFileSync(upperCube, "LUT_3D_SIZE 2\n");
  check(lutErr(upperCube) === "(accepted)" && lutNow() === upperCube, "an existing .CUBE file is accepted as a LUT");
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

  await server.stop();
  console.log(failures === 0 ? "\nSECURITY SMOKE TEST PASSED" : `\nSECURITY SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("SECURITY SMOKE TEST FAILED:", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  process.exit(1);
});
