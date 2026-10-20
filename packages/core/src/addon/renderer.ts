import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdir, readFileSync, rename, rm, writeFile } from "../io/gatedfs.js";

/**
 * The graphics renderer setting (MOTION-PLAN D7, rulings Q5 and D-BOTH):
 * "zedmix", ZedMix's own renderer (the default), or "remotion", the
 * Remotion add-on. It lives in `<dataDir>/addons/renderer.json`, which only the
 * UI hosts write, after the user's click in the graphics add-on dialog
 * (graphics-addon.cjs). The add-on folder is private (hosttrust.ts), so no RPC
 * method or MCP tool can write it (I7); add_graphic reads it on every call.
 */
export const GRAPHICS_RENDERERS = ["zedmix", "remotion"] as const;
export type GraphicsRenderer = (typeof GRAPHICS_RENDERERS)[number];

/** The setting's file. */
export function graphicsRendererFile(dataDir: string): string {
  return join(dataDir, "addons", "renderer.json");
}

/** The setting; "zedmix" when the file is missing, unreadable or holds anything else. */
export function readGraphicsRenderer(dataDir: string): GraphicsRenderer {
  try {
    const value = (JSON.parse(readFileSync(graphicsRendererFile(dataDir), "utf8")) as { renderer?: unknown }).renderer;
    return value === "remotion" ? "remotion" : "zedmix";
  } catch {
    return "zedmix";
  }
}

/** Write the setting (the UI hosts only, after the user's click): a temp file, then a rename over renderer.json. */
export async function writeGraphicsRenderer(dataDir: string, renderer: GraphicsRenderer): Promise<void> {
  if (!(GRAPHICS_RENDERERS as readonly unknown[]).includes(renderer)) throw new TypeError(`The graphics renderer is "zedmix" or "remotion" (not ${JSON.stringify(renderer)}).`);
  const file = graphicsRendererFile(dataDir);
  await mkdir(join(dataDir, "addons"), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ renderer })}\n`, "utf8");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
