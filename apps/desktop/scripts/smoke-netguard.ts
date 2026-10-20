/**
 * The desktop window's network limits (electron/net-guard.cjs), as plain
 * logic: isAllowedRendererUrl lets the renderer request only its own bundled
 * files, the core on 127.0.0.1 at the core's port (http and ws), in a dev run
 * the Vite origin and its hot-reload socket, and data:, blob:, devtools:;
 * every other URL (another computer by name or address, a file: URL with a
 * host or outside the renderer folder, 127.0.0.1 on another port) is refused.
 * isAppPage is true only for the app's own page (will-navigate cancels the
 * rest), and rendererCsp is the policy index.html carries (and the web shell
 * sends with the core's exact port).
 *
 * No Electron, no network: hosts are under .invalid or never contacted.
 * Run: npx tsx apps/desktop/scripts/smoke-netguard.ts
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Ctx = { rendererDir: string; corePort: number; devOrigin: string | null; platform: string };
const guard = createRequire(import.meta.url)("../electron/net-guard.cjs") as {
  isAllowedRendererUrl: (url: string, ctx: Ctx) => boolean;
  isAppPage: (url: string, ctx: Ctx) => boolean;
  devOriginOf: (url: string | undefined) => string | null;
  shownOrigin: (url: string) => string;
  rendererCsp: (port?: number) => string;
};

let failed = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};

const HERE = dirname(fileURLToPath(import.meta.url));
const rendererDir = resolve(HERE, "..", "dist", "renderer");
const packaged: Ctx = { rendererDir, corePort: 4791, devOrigin: null, platform: process.platform === "win32" ? "win32" : "linux" };
const dev: Ctx = { ...packaged, devOrigin: guard.devOriginOf("http://localhost:5173/?port=4791") };
const win: Ctx = { rendererDir: "C:\\Program Files\\ZedMix\\resources\\app.asar\\dist\\renderer", corePort: 4791, devOrigin: null, platform: "win32" };
const own = (rel: string) => pathToFileURL(join(rendererDir, rel)).href;

console.log("1. what the packaged window may request...");
for (const url of [
  own("index.html"), own("assets/index-3f2a.js"), own("assets/font.woff2"),
  "http://127.0.0.1:4791/file?path=%2Fm%2Fa.mp4&token=t", "http://127.0.0.1:4791/peaks?path=x", "ws://127.0.0.1:4791/?token=t",
  "devtools://devtools/bundled/inspector.html", "data:image/png;base64,iVBORw0KGgo=", "blob:file:///6a1d-4c",
]) {
  check(guard.isAllowedRendererUrl(url, packaged), `allowed: ${url}`);
}
// MUTATION: allow every file: URL in isAllowedRendererUrl → the file://host and /etc/passwd rows fail.
for (const url of [
  "http://zr-evil.invalid/", "http://zr-evil.invalid/x.png", "http://10.0.0.1/", "https://github.com/", "ws://zr-evil.invalid/",
  "file://zr-evil.invalid/s/x.png", "file:////zr-evil.invalid/s/x.png", "file:///etc/passwd",
  "http://127.0.0.1:4792/file?path=x", "ws://127.0.0.1:4790/", "https://127.0.0.1:4791/", "http://localhost:4791/file?path=x",
  pathToFileURL(`${rendererDir}-evil/index.html`).href, pathToFileURL(rendererDir).href, own("../../electron/main.cjs"),
  "http://localhost:5173/", "not a url",
]) {
  check(!guard.isAllowedRendererUrl(url, packaged), `refused: ${url}`);
}

console.log("2. a dev run adds only the Vite origin and its hot-reload socket...");
check(dev.devOrigin === "http://localhost:5173", `devOriginOf → ${dev.devOrigin}`);
for (const url of ["http://localhost:5173/", "http://localhost:5173/src/main.tsx?t=1", "ws://localhost:5173/?token=hmr", "http://127.0.0.1:4791/file?path=x"]) {
  check(guard.isAllowedRendererUrl(url, dev), `dev, allowed: ${url}`);
}
for (const url of ["http://localhost:5174/", "ws://localhost:5174/", "http://zr-evil.invalid/", "http://127.0.0.1:5173/"]) {
  check(!guard.isAllowedRendererUrl(url, dev), `dev, refused: ${url}`);
}

console.log("3. Windows paths (win32 rules, case-insensitive)...");
for (const url of [
  "file:///C:/Program%20Files/ZedMix/resources/app.asar/dist/renderer/index.html",
  "file:///c:/program%20files/zedmix/RESOURCES/app.asar/dist/renderer/assets/x.js",
]) {
  check(guard.isAllowedRendererUrl(url, win), `win32, allowed: ${url}`);
}
for (const url of [
  "file://zr-evil.invalid/s/x.png", "file:////zr-evil.invalid/s/x.png", "file:///C:/Windows/win.ini",
  "file:///C:/Program%20Files/ZedMix/resources/app.asar/dist/renderer-evil/x.js", "file:///%5C%5Czr-evil.invalid/s/x.png",
]) {
  check(!guard.isAllowedRendererUrl(url, win), `win32, refused: ${url}`);
}

console.log("4. will-navigate: only the app's own page...");
check(guard.isAppPage(`${own("index.html")}?port=4791&token=t`, packaged) && !guard.isAppPage(own("assets/x.js"), packaged)
  && !guard.isAppPage("http://127.0.0.1:4791/methods", packaged) && !guard.isAppPage("https://github.com/", packaged),
  "packaged: index.html (with its query) only, not an asset, the core or another site");
check(guard.isAppPage("http://localhost:5173/?port=1", dev) && !guard.isAppPage("http://localhost:5174/", dev) && !guard.isAppPage(own("index.html"), dev),
  "dev: the Vite origin only");
check(guard.isAppPage("file:///C:/program%20files/ZedMix/resources/app.asar/dist/renderer/INDEX.html", win), "win32: case-insensitive");

console.log("5. the log line and the page's Content-Security-Policy...");
check(guard.shownOrigin("http://zr-evil.invalid/s/x.png?token=secret") === "http://zr-evil.invalid" && guard.shownOrigin("file://zr-evil.invalid/s/x") === "file://zr-evil.invalid",
  `a refused URL is logged by origin, never its path or query (${guard.shownOrigin("http://zr-evil.invalid/s/x.png?token=secret")})`);
const csp = guard.rendererCsp(4791);
check(csp === "media-src 'self' http://127.0.0.1:4791; img-src 'self' data: blob: http://127.0.0.1:4791; connect-src 'self' http://127.0.0.1:4791 ws://127.0.0.1:4791; font-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'none'",
  `rendererCsp(4791): ${csp}`);
const html = readFileSync(join(HERE, "..", "index.html"), "utf8");
const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];
check(meta === guard.rendererCsp() && !/frame-ancestors/.test(html), `index.html carries rendererCsp() (any port), without frame-ancestors (${meta})`);

console.log(failed === 0 ? "\nALL NETGUARD CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
