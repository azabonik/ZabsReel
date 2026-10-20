import { createHash } from "node:crypto";
import { dirname, join, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { mkdir, writeFile } from "../io/gatedfs.js";
import type { AddonPlatform } from "../motion/addonlock.js";
import { entryNameProblem, type NameSet } from "./names.js";
import { execBit, type ExtractedFile } from "./tree.js";

/**
 * The add-on's tar reader (ADDON-PLAN D3.3), for npm's .tgz packages: gunzip,
 * then ustar with pax `path`/`size` and GNU `L` long names. Only regular files
 * and folders are written; links, devices, FIFOs and unknown types are
 * refused. The first path component (npm's `package/`) is stripped, as npm
 * does; an entry with nothing after it is skipped. Files are created with
 * O_EXCL, mode 0o755 when the entry has an execute bit, else 0o644. Only bytes
 * whose sha512 matched the lock reach it.
 */

/** An archive entry the add-on's readers do not write. */
export class ArchiveRefusal extends Error {
  constructor(what: string) {
    super(what);
    this.name = "ArchiveRefusal";
  }
}

const gunzipAsync = promisify(gunzip);
const BLOCK = 512;

/** A NUL-terminated header field. */
const text = (h: Buffer, off: number, len: number) => {
  const f = h.subarray(off, off + len);
  const end = f.indexOf(0);
  return f.subarray(0, end < 0 ? len : end).toString("utf8");
};

/** An octal header field; base-256 sizes (above 8 GB) are refused. */
function octal(h: Buffer, off: number, len: number): number {
  if (h[off] & 0x80) throw new ArchiveRefusal("a base-256 number");
  const s = text(h, off, len).trim();
  if (!/^[0-7]*$/.test(s)) throw new ArchiveRefusal("a damaged header");
  return s === "" ? 0 : parseInt(s, 8);
}

/** The pax records of an extended header ("<len> key=value\n"). */
function pax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (let at = 0; at < data.length; ) {
    const sp = data.indexOf(0x20, at);
    const len = sp < 0 ? NaN : Number(data.subarray(at, sp).toString("ascii"));
    if (!Number.isInteger(len) || len <= sp - at || at + len > data.length) throw new ArchiveRefusal("a damaged pax header");
    const rec = data.subarray(sp + 1, at + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    at += len;
  }
  return out;
}

export interface TarOptions {
  platform: AddonPlatform;
  /** The names written so far, by path from the add-on's root. */
  names: NameSet;
  /** `dest` relative to that root (`node_modules/a`), for the name check. */
  prefix: string;
  signal?: AbortSignal;
}

/** Extract the gzipped tarball `gz` into `dest` (a new folder); the files written. */
export async function extractTarball(gz: Uint8Array, dest: string, opts: TarOptions): Promise<ExtractedFile[]> {
  const tar = (await gunzipAsync(gz, { maxOutputLength: 1 << 30 })) as Buffer;
  const files: ExtractedFile[] = [];
  let ext: Record<string, string> = {};
  let longName: string | undefined;
  await mkdir(dest, { recursive: true });
  for (let at = 0; at + BLOCK <= tar.length; ) {
    opts.signal?.throwIfAborted();
    const h = tar.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (octal(h, 148, 8) !== sum) throw new ArchiveRefusal("a damaged header");
    const type = h[156] === 0 ? "0" : String.fromCharCode(h[156]);
    const size = type === "0" && ext.size !== undefined ? Number(ext.size) : octal(h, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0) throw new ArchiveRefusal("a damaged header");
    const data = tar.subarray(at + BLOCK, at + BLOCK + size);
    if (data.length !== size) throw new ArchiveRefusal("a truncated entry");
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      ext = pax(data);
      continue;
    }
    if (type === "g") continue; // global pax records: nothing ZedMix uses
    if (type === "L") {
      longName = text(data, 0, data.length);
      continue;
    }
    if (type !== "0" && type !== "5") throw new ArchiveRefusal(`an entry of type ${JSON.stringify(type)} (only files and folders are installed)`);
    const prefix = text(h, 345, 155);
    const name = ext.path ?? longName ?? (prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100));
    ext = {};
    longName = undefined;
    const slash = name.indexOf("/");
    let rel = slash < 0 ? "" : name.slice(slash + 1);
    if (rel === "" || rel === "/") continue; // the package folder itself, or a name with nothing to strip
    const folder = type === "5" || rel.endsWith("/");
    if (folder && !rel.endsWith("/")) rel += "/";
    const problem = entryNameProblem(rel, opts.platform) ?? opts.names.add(`${opts.prefix}/${rel}`);
    if (problem) throw new ArchiveRefusal(`${JSON.stringify(name)}: ${problem}`);
    const target = join(dest, ...rel.split("/").filter(Boolean));
    const r = relative(dest, target);
    if (r === "" || r.startsWith("..") || isAbsolute(r)) throw new ArchiveRefusal(`${JSON.stringify(name)}: a path outside the package`);
    if (folder) {
      await mkdir(target, { recursive: true });
      continue;
    }
    const exec = (octal(h, 100, 8) & 0o111) !== 0;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { flag: "wx", mode: exec ? 0o755 : 0o644 });
    files.push({ path: rel, size, exec: execBit(exec ? 0o755 : 0o644), sha256: createHash("sha256").update(data).digest("hex") });
  }
  return files;
}
