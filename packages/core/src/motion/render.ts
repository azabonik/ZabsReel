import { mkdir, writeFile, rm, rename } from "../io/gatedfs.js";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, openBrowser, renderMedia } from "@remotion/renderer";
import type { VideoConfig } from "remotion";
import { PRODUCT_NAME } from "../brand.js";
import { colorTagArgs, FFMPEG_DEFAULT_CODING, h264RetagBsf, tagFramesStep } from "../ffmpeg/colorspace.js";
import { runFfmpeg } from "../ffmpeg/executor.js";
import { examplePath } from "../unc.js";
import { installChromeGuard, isGuardedBrowser, remotionPatched } from "./chromeguard.js";
import { GateNetworkFsPlugin } from "./netgate.js";

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
 * Remotion drives a headless Chrome ("Chrome Headless Shell") which is
 * downloaded on first use and cached by Remotion (like our whisper/YuNet
 * binaries) — see ensureBrowser(). It runs with ZabsReel's network limits
 * (chromeguard.ts), and the render downloads no media for the graphic
 * (refuseDownload).
 *
 * NOTE on licensing: Remotion is source-available under the Remotion License
 * (not OSI open-source); companies of 4+ people need a paid license. It is the
 * only such dependency in the project and is isolated to this module. See
 * docs/PROJECT_STATUS.md / THIRD_PARTY notes.
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

const req = createRequire(import.meta.url);

/** node_modules dir that resolves `react`/`remotion` for the bundler. */
function nodeModulesDir(): string {
  // .../node_modules/react/package.json -> .../node_modules
  return dirname(dirname(req.resolve("react/package.json")));
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
  ensureBrowser: typeof ensureBrowser;
  openBrowser: typeof openBrowser;
  renderMedia: typeof renderMedia;
  remotionPatched: () => boolean;
}
const REMOTION: GraphicRemotion = { bundle, ensureBrowser, openBrowser, renderMedia, remotionPatched };

const ENTRY_SOURCE = `import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";
registerRoot(RemotionRoot);
`;

/**
 * Render an AI-authored Remotion component to an alpha video file. The scaffold
 * is written under `workDir`, bundled, rendered, and then cleaned up. Refuses
 * (fails closed) when the installed Remotion lacks ZabsReel's patch, or when
 * its browser did not start through the network limits (chromeguard.ts).
 */
export async function renderGraphic(opts: RenderGraphicOptions, remotion: GraphicRemotion = REMOTION): Promise<void> {
  if (!remotion.remotionPatched()) {
    throw new Error(`Graphics are turned off: this copy of Remotion is missing ${PRODUCT_NAME}'s safety patch. Run npm install again.`);
  }
  await mkdir(opts.workDir, { recursive: true });
  await writeFile(join(opts.workDir, "Graphic.tsx"), opts.code, "utf8");
  await writeFile(join(opts.workDir, "Root.tsx"), rootSource(opts), "utf8");
  await writeFile(join(opts.workDir, "index.ts"), ENTRY_SOURCE, "utf8");

  const modulesDir = nodeModulesDir();

  try {
    const serveUrl = await remotion.bundle({
      entryPoint: join(opts.workDir, "index.ts"),
      // The scaffold lives outside the repo's node_modules tree, so point
      // webpack at the installed node_modules so `react`/`remotion`/the AI's
      // imports resolve. GateNetworkFsPlugin (G9): webpack reads through its
      // own file system, so the agent's imports can't name a network path.
      webpackOverride: (config) => ({
        ...config,
        resolve: {
          ...config.resolve,
          modules: [modulesDir, ...((config.resolve && config.resolve.modules) || ["node_modules"])],
        },
        plugins: [...(config.plugins ?? []), new GateNetworkFsPlugin()],
      }),
    });

    // Downloads Chrome Headless Shell on first use (cached by Remotion).
    await remotion.ensureBrowser();

    // Our own browser, started through the network limits, for the whole render.
    installChromeGuard();
    const browser = await remotion.openBrowser("chrome", { chromeMode: "headless-shell" });
    try {
      if (!isGuardedBrowser(browser)) {
        throw new Error(`Graphics are turned off: ${PRODUCT_NAME} couldn't start the graphics browser with its network limits.`);
      }
      await renderWith(remotion, opts, serveUrl, browser);
    } finally {
      await browser.close({ silent: true }).catch(() => {});
    }
  } finally {
    // Best-effort cleanup of the scaffold (the bundle lives in a temp dir
    // Remotion manages; the scaffold is ours).
    await rm(opts.workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The renderMedia call of {@link renderGraphic}, in `browser`. */
async function renderWith(remotion: GraphicRemotion, opts: RenderGraphicOptions, serveUrl: string, browser: Awaited<ReturnType<typeof openBrowser>>): Promise<void> {
  const composition = graphicComposition(opts);
  const inputProps = composition.props;
  const port = await freePort();
  const alpha = opts.alpha !== false;
  await remotion.renderMedia({
    composition,
    serveUrl,
    port,
    puppeteerInstance: browser,
    onDownload: refuseDownload,
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
