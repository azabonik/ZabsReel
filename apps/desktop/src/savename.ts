// Decide the final file name for a save dialog. Pure, so a smoke script can test it.
import type { FileFilter } from "./platform";

/**
 * - No extension typed: add the active filter's extension.
 * - An extension that one of the filters lists (any filter, not just the active
 *   one): keep it, and report that filter so the UI can switch to it.
 * - Any other extension ("my.clip"): treated as part of the name; the active
 *   filter's extension is added.
 */
export function resolveSaveName(typed: string, filters: FileFilter[], activeIdx: number): { name: string; filterIdx: number } {
  const name = typed.trim();
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  const typedExt = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (typedExt) {
    const hit = filters.findIndex((f) => f.extensions.some((e) => e !== "*" && e.toLowerCase() === typedExt));
    if (hit >= 0) return { name, filterIdx: hit };
  }
  const ext = filters[activeIdx]?.extensions.find((e) => e !== "*");
  return { name: ext ? `${name}.${ext}` : name, filterIdx: activeIdx };
}
