/** The repository root: its node_modules holds remotion, @remotion/* and react. */
export const REPO_ROOT: string;
/** Set AIVE_REMOTION_ADDON to the repo root unless it is set; its value. */
export function useDevAddon(): string;
/** `fn`'s result with AIVE_REMOTION_ADDON unset, then the variable as it was. */
export function withoutDevAddon<T>(fn: () => T | Promise<T>): Promise<T>;
