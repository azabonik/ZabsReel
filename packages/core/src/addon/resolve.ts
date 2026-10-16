import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_NAME } from "../brand.js";
import { existsSync, readFileSync } from "../io/gatedfs.js";
import { platformLabel, readGraphicsAddon, type GraphicsAddonState } from "./state.js";

/**
 * Where graphics load Remotion from (ADDON-PLAN D5.1), and the refusals when
 * there is none. ZabsReel's own folder is never a Remotion root: a dev run
 * behaves like the packaged app unless it opts in.
 */

/** The variables only a source checkout honours: tests and dev runs. */
export type DevVariable = "AIVE_REMOTION_ADDON" | "AIVE_REMOTION_BROWSER" | "AIVE_ADDON_REGISTRY";

/** Test seams: the environment, and a file of the core whose package folder decides "source checkout". */
export interface DevOptions {
  env?: NodeJS.ProcessEnv;
  from?: string;
}

const HERE = fileURLToPath(import.meta.url);
const checkouts = new Map<string, boolean>();

/**
 * True when the core runs from a source checkout: its own package folder (the
 * nearest folder above `from` whose package.json is named @aive/core) holds
 * src/. A packaged core does not (its package ships dist/ only), however it
 * was started and whatever environment it inherited.
 */
export function isSourceCheckout(from = HERE): boolean {
  const known = checkouts.get(from);
  if (known !== undefined) return known;
  let answer = false;
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    let name: unknown;
    try {
      name = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown }).name;
    } catch {
      /* no package.json here */
    }
    if (name === "@aive/core") {
      answer = existsSync(join(dir, "src"));
      break;
    }
    if (dirname(dir) === dir) break;
  }
  checkouts.set(from, answer);
  return answer;
}

const ignored = new Set<string>();

/** A {@link DevVariable}'s value in a source checkout; elsewhere undefined, and one stderr line the first time it is ignored. */
export function devVariable(name: DevVariable, opts: DevOptions = {}): string | undefined {
  const value = (opts.env ?? process.env)[name];
  if (!value) return undefined;
  if (isSourceCheckout(opts.from)) return value;
  if (!ignored.has(name)) {
    ignored.add(name);
    console.error(`[aive-core] ${name} is ignored: ${PRODUCT_NAME} honours it only in a source checkout.`);
  }
  return undefined;
}

/** The add-on states that refuse a graphic. */
export type GraphicsAddonRefusal = Exclude<GraphicsAddonState, "ready">;

const CODES = {
  "not-installed": "graphics_addon_missing",
  "update-needed": "graphics_addon_update",
  broken: "graphics_addon_broken",
  unsupported: "graphics_addon_unsupported",
} as const satisfies Record<GraphicsAddonRefusal, string>;

export type GraphicsAddonCode = (typeof CODES)[GraphicsAddonRefusal];

const WHERE = `in the ${PRODUCT_NAME} window (Help → Graphics add-on)`;
/** What the agent reads for each refusal (D5.3): it says what to ask the user. */
function refusalMessage(state: GraphicsAddonRefusal): string {
  switch (state) {
    case "not-installed":
      return `Graphics need the Remotion add-on, which the user installs ${WHERE}. Ask the user to install it, then try again.`;
    case "update-needed":
      return `The Remotion add-on must be updated for this version of ${PRODUCT_NAME}. Ask the user to update it ${WHERE}, then try again.`;
    case "broken":
      return `The Remotion add-on is damaged (missing files). Ask the user to reinstall it ${WHERE}, then try again.`;
    case "unsupported":
      return `The graphics add-on isn't available for ${platformLabel()}, so graphics can't be made on this computer.`;
  }
}

/** add_graphic without a ready add-on (rpc.ts gives it {@link GraphicsAddonError.code}). */
export class GraphicsAddonError extends Error {
  readonly code: GraphicsAddonCode;
  constructor(readonly state: GraphicsAddonRefusal) {
    super(refusalMessage(state));
    this.name = "GraphicsAddonError";
    this.code = CODES[state];
  }
}

/** The Remotion graphics render with, or why there is none. */
export type GraphicsAddonResolution = ResolvedGraphicsAddon | { ok: false; state: GraphicsAddonRefusal };

export interface ResolvedGraphicsAddon {
  ok: true;
  /** The folder whose node_modules holds remotion, @remotion/* and react. */
  root: string;
  /** The pinned browser; undefined only for AIVE_REMOTION_ADDON without AIVE_REMOTION_BROWSER (Remotion's own cache). */
  browserExecutable?: string;
  /** The installed add-on's data folder and installedAt, to tell a render failure apart (render.ts). */
  installed?: { dataDir: string; installedAt: unknown };
}

/**
 * (1) In a source checkout, AIVE_REMOTION_ADDON (an absolute folder with
 * node_modules/@remotion/renderer), with AIVE_REMOTION_BROWSER as its browser
 * if set; (2) the installed add-on when it is ready, with its own browser;
 * (3) otherwise the add-on's state.
 */
export function resolveGraphicsAddon(dataDir: string, opts: DevOptions & { platform?: string } = {}): GraphicsAddonResolution {
  const dev = devVariable("AIVE_REMOTION_ADDON", opts);
  if (dev !== undefined) {
    if (!isAbsolute(dev) || !existsSync(join(dev, "node_modules", "@remotion", "renderer"))) {
      throw new Error(`AIVE_REMOTION_ADDON must be an absolute folder that holds node_modules/@remotion/renderer (it is ${JSON.stringify(dev)}).`);
    }
    return { ok: true, root: dev, browserExecutable: devVariable("AIVE_REMOTION_BROWSER", opts) };
  }
  const addon = readGraphicsAddon(dataDir, opts);
  if (addon.state !== "ready") return { ok: false, state: addon.state };
  return { ok: true, root: addon.dir, browserExecutable: addon.browserExecutable, installed: { dataDir, installedAt: addon.installedAt } };
}
