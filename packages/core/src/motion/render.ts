import { existsSync, mkdir, writeFile, rm, rename, realpathNative } from "../io/gatedfs.js";
import { join } from "node:path";
import { createServer } from "node:net";
import type { bundle } from "@remotion/bundler";
import type { ensureBrowser, openBrowser, renderMedia, RenderInternals } from "@remotion/renderer";
import type { VideoConfig } from "remotion";
import { GraphicsAddonError, type ResolvedGraphicsAddon } from "../addon/resolve.js";
import { readGraphicsAddon } from "../addon/state.js";
import { PRODUCT_NAME } from "../brand.js";
import { colorTagArgs, FFMPEG_DEFAULT_CODING, h264RetagBsf, tagFramesStep } from "../ffmpeg/colorspace.js";
import { runFfmpeg } from "../ffmpeg/executor.js";
import { examplePath } from "../unc.js";
import { installChromeGuard, isGuardedBrowser } from "./chromeguard.js";
import { GateNetworkFsPlugin, GraphicImportsPlugin, type GraphicFiles } from "./netgate.js";
import { guardRemotionProxy, proxyGuardWorks, releaseWhenClosed } from "./proxyguard.js";
import { loadRemotion, REMOTION_VERSION, type RemotionGuard } from "./remotionload.js";

/**
 * Headless motion-graphics renderer (Remotion).
 *
 * The AI authors a React/Remotion component as TSX (the `code`); we scaffold a
 * minimal Remotion project around it, bundle it (Remotion's webpack), and render
 * it to a standalone video. For OVERLAY graphics we render ProRes 4444, which
 * carries an alpha channel, so the result can be composited over footage by
 * FFmpeg's `overlay` filter (see ffmpeg/graph.ts). For STANDALONE cards the
 * component fills its own background, so alpha is irrelevant.
 *
 * Remotion and the headless Chrome it drives ("Chrome Headless Shell") come
 * from the graphics add-on the user installs (addon/resolve.ts): its pinned
 * shell is passed as browserExecutable everywhere Remotion may start one,
 * with an onBrowserDownload that throws, so no Remotion code path downloads
 * a browser. The browser runs with ZabsReel's network limits
 * (chromeguard.ts), and the render downloads no media for the graphic
 * (refuseDownload). Remotion is loaded at render time, through
 * remotionload.ts, so importing this module loads none of it. A second layer
 * uses no Remotion internals: the render is muted (Remotion opens no audio
 * source), and proxyguard.ts refuses /proxy on Remotion's server. The AI's
 * component may import only react and remotion, and webpack's file system
 * reads no file outside the scaffold and node_modules (netgate.ts). Two reads
 * of bundle() do not go through that file system, both at fixed paths: Remotion's
 * esbuild-loader reads the compiler options in <remotionRoot>/tsconfig.json
 * through TypeScript, and webpack's cache lives in node_modules/.cache under
 * the nearest package.json at or above <remotionRoot> (else <remotionRoot>/.cache).
 * remotionRoot is the folder of the nearest package.json above the scaffold,
 * else the core's working directory. The AI's code cannot change either path:
 * they depend only on where the scaffold and the core are.
 *
 * NOTE on licensing: Remotion is source-available under the Remotion License
 * (not OSI open-source); companies of 4+ people need a paid license. ZabsReel
 * does not ship it: the user installs it as the graphics add-on, under its own
 * licence. See THIRD_PARTY notes.
 */

export interface RenderGraphicOptions {
  /** AI-authored TSX module that default-exports a React component. */
  code: string;
  /** Props passed to the component. */
  props?: Record<string, unknown>;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  /**
   * Absolute output path. For an alpha overlay this should end in .mov (ProRes
   * 4444 with alpha); for an opaque standalone graphic it should end in .mp4.
   */
  outPath: string;
  /**
   * Keep an alpha channel (ProRes 4444 .mov) so the graphic can be composited
   * over footage. Default true. Set false for a STANDALONE graphic that fills
   * its own background — it renders to an opaque H.264 .mp4 instead, which (a)
   * the Electron/Chromium preview player can actually decode (ProRes cannot be
   * played in a browser <video>, so a standalone ProRes clip shows as black in
   * the live preview) and (b) is smaller.
   */
  alpha?: boolean;
  /** Unique scratch directory to scaffold the Remotion project in. */
  workDir: string;
  /** Optional progress callback, 0..1. */
  onProgress?: (fraction: number) => void;
}

/**
 * Find a free TCP port for Remotion's internal bundle server. Remotion defaults
 * to port 3000, which collides with common dev servers (Next.js etc.) — when it
 * does, it can connect to the foreign server instead of its own bundle. Binding
 * an OS-assigned ephemeral port avoids that entirely.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * The composition renderGraphic renders, built here rather than read back from
 * the page (Remotion's composition lookup opens a browser of its own, whose
 * downloads nothing guards). rootSource registers the same numbers, so the
 * page and the render agree.
 */
export function graphicComposition(o: RenderGraphicOptions): VideoConfig {
  const props = o.props ?? {};
  return {
    id: "Graphic",
    width: Math.round(o.width),
    height: Math.round(o.height),
    fps: o.fps,
    durationInFrames: Math.max(1, Math.round(o.durationInFrames)),
    defaultProps: props,
    props,
    defaultCodec: null,
    defaultOutName: null,
    defaultVideoImageFormat: null,
    defaultPixelFormat: null,
    defaultProResProfile: null,
    defaultSampleRate: null,
  };
}

/** Generate the Remotion Root that registers the AI component as a composition. */
export function rootSource(o: RenderGraphicOptions): string {
  const c = graphicComposition(o);
  return `import React from "react";
import { Composition } from "remotion";
import Graphic from "./Graphic";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="${c.id}"
      component={Graphic as unknown as React.FC}
      durationInFrames={${c.durationInFrames}}
      fps={${c.fps}}
      width={${c.width}}
      height={${c.height}}
      defaultProps={${JSON.stringify(c.defaultProps)} as Record<string, unknown>}
    />
  );
};
`;
}

/**
 * Remotion's onDownload for every render: refuses every source. Remotion
 * downloads each <OffthreadVideo>, <Video> and <Audio> source (a data: URL
 * too) and hands the file to its own ffprobe and compositor, which ZabsReel's
 * FFmpeg limits (executor.ts) don't reach: a playlist delivered that way would
 * open the network paths it names. Refused here, nothing is written.
 */
export const refuseDownload = (src: string): never => {
  throw new Error(
    `Graphics can't load media through <OffthreadVideo>, <Video> or <Audio> (${examplePath(src)}). ` +
      "Draw the graphic with shapes, text and CSS, or put the media on the timeline as its own clip.",
  );
};

/** The Remotion calls renderGraphic makes (smoke-chromeguard passes stubs). */
export interface GraphicRemotion {
  bundle: typeof bundle;
  /** The node_modules folder @remotion/bundler is installed in. */
  bundlerModules: string;
  ensureBrowser: typeof ensureBrowser;
  openBrowser: typeof openBrowser;
  renderMedia: typeof renderMedia;
  RenderInternals: typeof RenderInternals;
  guard: () => RemotionGuard;
}

/** Remotion as remotionload.ts loads it from `root` (the graphics add-on's folder). */
export async function graphicRemotion(root: string): Promise<GraphicRemotion> {
  const { renderer, bundler, bundlerModules, guard } = await loadRemotion(root);
  const { ensureBrowser, openBrowser, renderMedia, RenderInternals } = renderer;
  return { bundle: bundler.bundle, bundlerModules, ensureBrowser, openBrowser, renderMedia, RenderInternals, guard };
}

/** Why graphics are off, for each guard reason. */
function guardRefusal(reason: Exclude<RemotionGuard, { ok: true }>["reason"]): string {
  const why = {
    node: `graphics need Node.js 22.15 or later, and ${PRODUCT_NAME} is running on Node.js ${process.versions.node}.`,
    "loaded-before": `Remotion was loaded before ${PRODUCT_NAME} could guard it. Restart ${PRODUCT_NAME}.`,
    version: `${PRODUCT_NAME} works with Remotion ${REMOTION_VERSION}, and this copy of Remotion is a version it doesn't know.`,
  }[reason];
  return `Graphics are turned off: ${why}`;
}

const ENTRY_SOURCE = `import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";
registerRoot(RemotionRoot);
`;

/** Remotion's onBrowserDownload while the add-on supplies the browser: never download one. */
export const refuseBrowserDownload = (): never => {
  throw new Error(`The graphics add-on's browser is missing. Reinstall the add-on in the ${PRODUCT_NAME} window (Help → Graphics add-on).`);
};

/**
 * Refuses, with {@link refuseBrowserDownload}'s message, when the add-on's
 * browser is gone. Remotion queues every ensureBrowser (openBrowser's own
 * included) behind the one before it, and once one fails every later call
 * gets that same failure: a missing browser handed to Remotion would turn
 * graphics off until the core restarts, a Reinstall included.
 */
const pinnedBrowserPresent = (addon: ResolvedGraphicsAddon): void => {
  if (addon.browserExecutable && !existsSync(addon.browserExecutable)) refuseBrowserDownload();
};

/** What a render whose add-on was replaced or removed meanwhile fails with. */
export const ADDON_CHANGED = "The graphics add-on was changed while this graphic rendered. Try again.";

/**
 * Render an AI-authored Remotion component to an alpha video file, with the
 * Remotion of `addon`. The scaffold is written under `workDir`, bundled,
 * rendered, and then cleaned up. Refuses (fails closed), before writing
 * anything, when the loaded Remotion does not carry ZabsReel's same-as
 * refusal (remotionload.ts) or the /proxy guard does not work on this Node
 * (proxyguard.ts), or when its browser did not start through the network
 * limits (chromeguard.ts). When it fails and the installed add-on now has
 * another installedAt (or is gone), it fails with {@link ADDON_CHANGED}; when
 * the same add-on is now broken, with a GraphicsAddonError.
 */
export async function renderGraphic(opts: RenderGraphicOptions, addon: ResolvedGraphicsAddon, remotion?: GraphicRemotion): Promise<void> {
  try {
    await renderIn(opts, addon, remotion);
  } catch (err) {
    if (!addon.installed) throw err;
    const now = readGraphicsAddon(addon.installed.dataDir);
    if (now.state === "not-installed" || JSON.stringify(now.installedAt) !== JSON.stringify(addon.installed.installedAt)) throw new Error(ADDON_CHANGED);
    if (now.state === "broken") throw new GraphicsAddonError("broken");
    throw err;
  }
}

async function renderIn(opts: RenderGraphicOptions, addon: ResolvedGraphicsAddon, remotion?: GraphicRemotion): Promise<void> {
  remotion ??= await graphicRemotion(addon.root);
  const guard = remotion.guard();
  if (!guard.ok) throw new Error(guardRefusal(guard.reason));
  if (!(await proxyGuardWorks())) {
    throw new Error(`Graphics are turned off: ${PRODUCT_NAME} couldn't guard Remotion's server on Node.js ${process.versions.node}.`);
  }
  await mkdir(opts.workDir, { recursive: true });
  await writeFile(join(opts.workDir, "Graphic.tsx"), opts.code, "utf8");
  await writeFile(join(opts.workDir, "Root.tsx"), rootSource(opts), "utf8");
  await writeFile(join(opts.workDir, "index.ts"), ENTRY_SOURCE, "utf8");
  // Remotion copies its public folder into the bundle (and serves it): an empty
  // one of ours, never a folder next to the core's working directory.
  const publicDir = join(opts.workDir, "public");
  await mkdir(publicDir, { recursive: true });

  // react and remotion resolve from the add-on's tree, the one Remotion loaded from.
  const modulesDir = join(addon.root, "node_modules");
  // The add-on's browser for every launch, the relaunch after a crash included; never a download.
  const pinned = addon.browserExecutable ? { browserExecutable: addon.browserExecutable, onBrowserDownload: refuseBrowserDownload } : {};
  // The scaffold's files as written and as webpack sees them (it resolves links).
  const realWorkDir = realpathNative(opts.workDir);
  const both = (name: string) => [join(opts.workDir, name), join(realWorkDir, name)];
  const files: GraphicFiles = {
    graphic: both("Graphic.tsx"),
    scaffold: [...both("Root.tsx"), ...both("index.ts")],
    modules: [modulesDir, remotion.bundlerModules],
  };

  try {
    const serveUrl = await remotion.bundle({
      // No rootDir: bundle() chdirs the whole core process to it while it
      // bundles, so the scaffold as rootDir would move the server's working
      // directory in the middle of other requests.
      entryPoint: join(opts.workDir, "index.ts"),
      publicDir,
      // The scaffold lives outside the add-on's node_modules tree, so point
      // webpack at it so `react`/`remotion` resolve.
      // GateNetworkFsPlugin (G9): webpack reads through its own file system,
      // so the agent's imports can't name a network path, and it reads no
      // file outside `files`. GraphicImportsPlugin (I9): Graphic.tsx may
      // import only react and remotion.
      webpackOverride: (config) => ({
        ...config,
        resolve: {
          ...config.resolve,
          modules: [modulesDir, ...((config.resolve && config.resolve.modules) || ["node_modules"])],
        },
        plugins: [...(config.plugins ?? []), new GateNetworkFsPlugin(files), new GraphicImportsPlugin(files)],
      }),
    });

    // The add-on's browser; without one (a source checkout's AIVE_REMOTION_ADDON
    // alone) Remotion's own cache, downloaded on first use.
    pinnedBrowserPresent(addon);
    await remotion.ensureBrowser(pinned);

    // Remotion's server takes exactly this port (or fails), so the /proxy guard
    // is on it alone. Remotion closes that server after renderMedia settles
    // without awaiting it, so the guard is held for the browser's whole life
    // and released only once the port refuses connections.
    const port = await freePort();
    const releaseProxyGuard = guardRemotionProxy(port);
    try {
      // Our own browser, started through the network limits, for the whole render.
      installChromeGuard(remotion.RenderInternals);
      pinnedBrowserPresent(addon);
      const browser = await remotion.openBrowser("chrome", { ...pinned, chromeMode: "headless-shell" });
      try {
        if (!isGuardedBrowser(browser)) {
          throw new Error(`Graphics are turned off: ${PRODUCT_NAME} couldn't start the graphics browser with its network limits.`);
        }
        await renderWith(remotion, opts, serveUrl, browser, port, pinned);
      } finally {
        await browser.close({ silent: true }).catch(() => {});
      }
    } finally {
      await releaseWhenClosed(port, releaseProxyGuard);
    }
  } finally {
    // Best-effort cleanup of the scaffold (the bundle lives in a temp dir
    // Remotion manages; the scaffold is ours).
    await rm(opts.workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The renderMedia call of {@link renderGraphic}, in `browser`, with Remotion's server on `port`; `pinned`: the add-on's browser for a relaunch. */
async function renderWith(
  remotion: GraphicRemotion,
  opts: RenderGraphicOptions,
  serveUrl: string,
  browser: Awaited<ReturnType<typeof openBrowser>>,
  port: number,
  pinned: { browserExecutable?: string; onBrowserDownload?: () => never },
): Promise<void> {
  const composition = graphicComposition(opts);
  const inputProps = composition.props;
  const alpha = opts.alpha !== false;
  await remotion.renderMedia({
    composition,
    serveUrl,
    port,
    puppeteerInstance: browser,
    // A browser that closes mid-render is replaced (F12) with this one, never a download.
    ...pinned,
    onDownload: refuseDownload,
    // A graphic has no sound (every media source is refused). Muted, Remotion
    // opens no audio source the page reports, a same-as path included; without
    // it Remotion writes a silent audio track.
    muted: true,
    // Alpha overlay: ProRes 4444 keeps an alpha channel so the graphic can be
    // composited over footage (transparent wherever the component doesn't
    // paint). This needs BOTH an alpha-carrying pixelFormat AND PNG frames —
    // the default JPEG frames have no alpha, so Remotion silently falls back to
    // an opaque 4:2:2 format and transparent regions bake to black. Standalone:
    // opaque H.264 the preview player can decode.
    ...(alpha
      ? ({ codec: "prores", proResProfile: "4444", pixelFormat: "yuva444p10le", imageFormat: "png" } as const)
      : ({ codec: "h264", pixelFormat: "yuv420p" } as const)),
    // Pinned: BT.601, untagged (tagGraphicColor / graphicPreviewProxy tag the result as that).
    colorSpace: "default",
    outputLocation: opts.outPath,
    inputProps,
    onProgress: opts.onProgress ? ({ progress }) => opts.onProgress!(progress) : undefined,
  });
}

/**
 * Tag a standalone graphic's H.264 as Remotion codes it — BT.601, limited
 * range, untagged — in complete tags (lossless remux, in place), so the export
 * and the preview's decoder both read it as coded: untagged HD would be read
 * as BT.709 (ffmpeg/colorspace.ts).
 */
export async function tagGraphicColor(mp4: string, signal?: AbortSignal): Promise<void> {
  const tagged = `${mp4}.tagged.mp4`;
  await runFfmpeg(["-hide_banner", "-y", "-i", mp4, "-map", "0", "-c", "copy", "-bsf:v", h264RetagBsf(FFMPEG_DEFAULT_CODING), "-movflags", "+faststart", tagged], { signal });
  await rename(tagged, mp4);
}

/**
 * The VP8/alpha .webm preview proxy of an overlay graphic's ProRes 4444 .mov
 * (which Chromium can't decode). The .mov is Remotion's BT.601 (the export
 * reads it so); complete tags make the preview's decoder read the proxy alike
 * (untagged HD: BT.709, up to 40 levels off).
 */
export async function graphicPreviewProxy(mov: string, webm: string): Promise<void> {
  await runFfmpeg([
    "-hide_banner", "-y", "-i", mov, "-vf", tagFramesStep(FFMPEG_DEFAULT_CODING),
    "-c:v", "libvpx", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0",
    "-b:v", "3M", "-deadline", "realtime", "-cpu-used", "5", "-an",
    ...colorTagArgs(FFMPEG_DEFAULT_CODING), webm,
  ]);
}
