// The graphics add-on for the graphics smokes and check-remotion-guard.mjs
// (ADDON-PLAN D8.3). A source checkout has Remotion in its node_modules (core
// devDependencies), so AIVE_REMOTION_ADDON defaults to the repo root when it is
// unset: CI, release.yml's guard steps and the matrix kit need no change. The
// core honours the variable only in a source checkout (addon/resolve.ts).
// withoutDevAddon runs a row as a user without the add-on sees it.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: its node_modules holds remotion, @remotion/* and react. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Set AIVE_REMOTION_ADDON to the repo root unless it is set; its value. */
export function useDevAddon() {
  if (!process.env.AIVE_REMOTION_ADDON) process.env.AIVE_REMOTION_ADDON = REPO_ROOT;
  return process.env.AIVE_REMOTION_ADDON;
}

/** `fn`'s result with AIVE_REMOTION_ADDON unset, then the variable as it was. */
export async function withoutDevAddon(fn) {
  const saved = process.env.AIVE_REMOTION_ADDON;
  delete process.env.AIVE_REMOTION_ADDON;
  try {
    return await fn();
  } finally {
    if (saved !== undefined) process.env.AIVE_REMOTION_ADDON = saved;
  }
}
