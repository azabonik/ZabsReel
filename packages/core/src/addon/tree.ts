import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { copyFile, createReadStream, link, lstat, mkdir, readdir } from "../io/gatedfs.js";

/**
 * Extracted trees and their digests (ADDON-PLAN D3.9): the readers record
 * every file they write, and an update re-hashes an installed folder to see
 * whether it can be reused instead of downloaded again.
 */

/** One file of an extracted tree: its path below the tree's folder (`/`-separated), size, execute bit and sha256. */
export interface ExtractedFile {
  path: string;
  size: number;
  exec: boolean;
  sha256: string;
}

/** The execute bit as the digest counts it: Windows keeps none. */
export const execBit = (mode: number) => process.platform !== "win32" && (mode & 0o111) !== 0;

/** sha256 over the sorted paths, sizes, execute bits and file hashes. */
export function treeDigest(files: readonly ExtractedFile[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) h.update(`${f.path}\0${f.size}\0${f.exec ? 1 : 0}\0${f.sha256}\n`);
  return h.digest("hex");
}

/** sha256 of a file, streamed. */
async function fileSha256(file: string, signal?: AbortSignal): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h, { signal });
  return h.digest("hex");
}

/**
 * The files below `dir`, skipping each folder for which `skip(rel)` is true,
 * or null when the tree holds anything but files and folders (a link is never
 * followed) or `dir` is missing.
 */
export async function walkTree(dir: string, skip: (rel: string) => boolean = () => false, signal?: AbortSignal): Promise<ExtractedFile[] | null> {
  const out: ExtractedFile[] = [];
  const visit = async (rel: string): Promise<boolean> => {
    const abs = rel === "" ? dir : join(dir, ...rel.split("/"));
    const st = await lstat(abs);
    if (st.isDirectory()) {
      if (rel !== "" && skip(rel)) return true;
      for (const name of (await readdir(abs)).sort()) if (!(await visit(rel === "" ? name : `${rel}/${name}`))) return false;
      return true;
    }
    if (!st.isFile() || rel === "") return false;
    signal?.throwIfAborted();
    out.push({ path: rel, size: st.size, exec: execBit(st.mode), sha256: await fileSha256(abs, signal) });
    return true;
  };
  try {
    return (await visit("")) ? out : null;
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

/** fs.constants.COPYFILE_EXCL (only io/gatedfs.ts imports node:fs). */
const COPYFILE_EXCL = 1;

/** Put `files` of `src` at the same paths under `dst`: a hard link where the volume allows, else a copy. Never a move. */
export async function copyTree(src: string, dst: string, files: readonly ExtractedFile[], signal?: AbortSignal): Promise<void> {
  for (const f of files) {
    signal?.throwIfAborted();
    const from = join(src, ...f.path.split("/"));
    const to = join(dst, ...f.path.split("/"));
    await mkdir(dirname(to), { recursive: true });
    try {
      await link(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOSPC" || code === "ENAMETOOLONG" || code === "EEXIST") throw err;
      await copyFile(from, to, COPYFILE_EXCL);
    }
  }
}
