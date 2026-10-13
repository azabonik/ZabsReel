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

/**
 * The export preset for a chosen output path. The save pickers keep a typed
 * .webm / .mov / .mp4 (resolveSaveName), so when that container differs from the
 * preset's, use the first preset that writes it: an H.264 preset can't write
 * WebM. No preset means the core's default, MP4.
 */
export function presetForPath(presets: { id: string; ext: string }[], presetId: string | undefined, path: string): string | undefined {
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  const current = presets.find((p) => p.id === presetId);
  if (!ext || ext === (current ? current.ext : "mp4")) return presetId;
  return presets.find((p) => p.ext === ext)?.id ?? presetId;
}

/**
 * The line the export result adds when presetForPath used another preset than
 * the one picked, or null when it didn't. "Master" for a typed .mov is a
 * near-lossless file, many times larger, so the switch must not be silent.
 */
export function presetSwapNote(presets: { id: string; label: string }[], chosen: string | undefined, used: string | undefined, path: string): string | null {
  if (used === chosen) return null;
  const label = (id: string | undefined) => presets.find((p) => p.id === id)?.label ?? "default MP4";
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  return `Used the ${label(used)} preset instead of ${label(chosen)}, because the file name ends in ${base.slice(base.lastIndexOf("."))}.`;
}
