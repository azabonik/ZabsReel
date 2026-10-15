import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { RenderInternals } from "@remotion/renderer";
import { readFileSync } from "../io/gatedfs.js";

/**
 * The network limits of the graphics browser (Remotion's Chrome Headless
 * Shell), which runs agent-written TSX.
 *
 * Every Chrome Remotion starts (openBrowser, renderMedia, the restart after a
 * crash) goes through `RenderInternals.HeadlessBrowser.create({ args, … })`,
 * which hands `args` to spawn unchanged; Remotion has no option that adds a
 * switch. {@link installChromeGuard} wraps that one static method, so each
 * launch gets {@link GRAPHICS_CHROME_SWITCHES}:
 * - the resolver rule: every host name fails as if it did not exist, except
 *   localhost and 127.0.0.1 (Remotion's own server), so a graphic's image,
 *   fetch, WebSocket or window.open never connects to another computer;
 * - the sign-in allowlist: Windows signs in to "intranet" servers on its own
 *   (NTLM) unless the list is set; a non-empty list that matches no real host
 *   turns that off. An empty value would turn it back on. The headless shell
 *   only knows the "allowlist" spelling (Electron the "whitelist" one).
 * renderGraphic opens its own browser and checks {@link isGuardedBrowser}, so
 * a Remotion upgrade that stops launching through `create` fails closed.
 */
export const GRAPHICS_CHROME_SWITCHES = [
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
  "--auth-server-allowlist=zr-no-ambient-auth.invalid",
] as const;
const DROP = ["--host-resolver-rules=", "--auth-server-allowlist=", "--auth-server-whitelist="];
const guarded = new WeakSet<object>();
const INSTALLED = Symbol.for("zabsreel.chromeGuard");

type Create = (opts: { args: string[] } & Record<string, unknown>) => Promise<object>;

/** The argv Chrome gets: Remotion's own, without our switches or --disable-web-security, then ours. */
export function guardedChromeArgs(args: readonly string[]): string[] {
  return [...args.filter((a) => a !== "--disable-web-security" && !DROP.some((p) => a.startsWith(p))), ...GRAPHICS_CHROME_SWITCHES];
}

/** Replace RenderInternals.HeadlessBrowser.create once; idempotent. */
export function installChromeGuard(): void {
  const browserClass = RenderInternals.HeadlessBrowser as unknown as { create: Create & { [INSTALLED]?: true } };
  if (browserClass.create[INSTALLED]) return;
  const original = browserClass.create;
  const create = async (opts: { args: string[] } & Record<string, unknown>) => {
    const browser = await original.call(browserClass, { ...opts, args: guardedChromeArgs(opts.args ?? []) });
    guarded.add(browser);
    return browser;
  };
  browserClass.create = Object.assign(create, { [INSTALLED]: true as const });
}

/** True when `b` was started through the guard. */
export function isGuardedBrowser(b: object): boolean {
  return guarded.has(b);
}

/** The text ZabsReel's patch (patches/@remotion+renderer+*.patch) puts in both of Remotion's builds. */
const PATCH_MARKER = "/* zabsreel: same-as refused */";
let patched: boolean | undefined;

/**
 * True when the installed @remotion/renderer carries ZabsReel's patch, in its
 * CommonJS and its ESM build: `downloadAsset` refuses a `same-as` source
 * instead of handing it, as a bare relative path and without asking
 * onDownload, to the compositor (Remotion's /proxy reaches it from the page).
 * Read once. `dir` (the package folder) is for tests.
 */
export function remotionPatched(dir?: string): boolean {
  if (dir === undefined && patched !== undefined) return patched;
  const root = dir ?? dirname(createRequire(import.meta.url).resolve("@remotion/renderer/package.json"));
  let ok: boolean;
  try {
    ok = ["dist/assets/download-and-map-assets-to-file.js", "dist/esm/index.mjs"].every((f) => readFileSync(join(root, f), "utf8").includes(PATCH_MARKER));
  } catch {
    ok = false;
  }
  if (dir === undefined) patched = ok;
  return ok;
}
