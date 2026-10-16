import type { AddonPlatform } from "../motion/addonlock.js";

/**
 * The names the add-on's archive readers (tar.ts, zip.ts) may create
 * (ADDON-PLAN D3.3, D3.4). Every entry path is relative and stays inside the
 * folder it is extracted to; on Windows it is also a name Windows can open,
 * and on Windows and macOS (case-insensitive file systems) no two names in
 * one folder fold to the same name.
 */

/** A Windows device name, with or without an extension, in any case (CON, aux.js, Com1.txt, LPT9). */
const DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
/** Characters a Windows file name can't hold (and the control characters). */
const WIN_CHARS = /[<>:"|?*\u0000-\u001f]/;

/**
 * Why `rel` (an entry's path, `/`-separated, a trailing `/` for a folder)
 * can't be written for `platform`, or null. Everywhere: empty, absolute, a
 * backslash, NUL, a `:` (drive letters and NTFS streams), an empty, "." or
 * ".." segment. For win32 also: a device name, a trailing dot or space, and
 * the characters < > : " | ? * and control characters.
 */
export function entryNameProblem(rel: string, platform: AddonPlatform): string | null {
  const path = rel.endsWith("/") ? rel.slice(0, -1) : rel;
  if (path === "") return "an empty path";
  if (path.startsWith("/")) return "an absolute path";
  if (path.includes("\\")) return "a backslash";
  if (path.includes("\0")) return "a NUL character";
  if (path.includes(":")) return "a ':' (a drive letter or a stream)";
  for (const s of path.split("/")) {
    if (s === "" || s === "." || s === "..") return `a ${JSON.stringify(s)} segment`;
    if (platform !== "win32-x64") continue;
    if (DEVICE.test(s)) return `the Windows device name ${JSON.stringify(s)}`;
    if (/[. ]$/.test(s)) return `the name ${JSON.stringify(s)}, which ends in a dot or a space`;
    if (WIN_CHARS.test(s)) return `the name ${JSON.stringify(s)}, which holds a character Windows refuses`;
  }
  return null;
}

/**
 * The names written so far under one root, folder by folder: on win32 and
 * darwin a second name that folds (NFC, lower case) to one already there is
 * refused, as the file systems there would merge the two.
 */
export class NameSet {
  private readonly folders = new Map<string, Map<string, string>>();
  constructor(private readonly platform: AddonPlatform) {}

  /** Why `rel` collides with a name already added, or null (then it is added). */
  add(rel: string): string | null {
    if (this.platform === "linux-x64") return null;
    const segments = (rel.endsWith("/") ? rel.slice(0, -1) : rel).split("/");
    for (let i = 0; i < segments.length; i++) {
      const parent = segments.slice(0, i).join("/");
      const key = segments[i].normalize("NFC").toLowerCase();
      let names = this.folders.get(parent);
      if (!names) this.folders.set(parent, (names = new Map()));
      const had = names.get(key);
      if (had !== undefined && had !== segments[i]) return `the names ${JSON.stringify(had)} and ${JSON.stringify(segments[i])}, which are the same name on ${this.platform}`;
      names.set(key, segments[i]);
    }
    return null;
  }
}
