import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative } from "node:path";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createInflateRaw } from "node:zlib";
import { createReadStream, createWriteStream, mkdir, open, writeFile } from "../io/gatedfs.js";
import type { AddonPlatform } from "../motion/addonlock.js";
import { entryNameProblem, type NameSet } from "./names.js";
import { ArchiveRefusal } from "./tar.js";
import { execBit, type ExtractedFile } from "./tree.js";

/**
 * The add-on's zip reader (ADDON-PLAN D3.4), for the pinned Chrome for
 * Testing headless shell: the central directory, stored and deflate entries,
 * execute bits from Unix external attributes. Refused: encryption, zip64, a
 * spanned archive, any other method, a symlink or other special file (the
 * four pinned zips hold none), a name outside the target and an entry whose
 * data overlaps the directory. Each file's size and CRC-32 are checked. Only
 * a zip whose sha256 matched the pin reaches it.
 */

/** One central-directory entry. */
export interface ZipEntry {
  name: string;
  folder: boolean;
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  localOffset: number;
  exec: boolean;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;

/** The entries of the zip at `file`, and where its central directory starts. */
export async function readZipDirectory(file: string): Promise<{ entries: ZipEntry[]; directoryOffset: number }> {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 22 + MAX16);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let at = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD && i + 22 + tail.readUInt16LE(i + 20) === tailLen) {
        at = i;
        break;
      }
    }
    if (at < 0) throw new ArchiveRefusal("no end of central directory");
    const count = tail.readUInt16LE(at + 10);
    const dirSize = tail.readUInt32LE(at + 12);
    const dirOffset = tail.readUInt32LE(at + 16);
    if (count === MAX16 || dirSize === MAX32 || dirOffset === MAX32 || (at >= 20 && tail.readUInt32LE(at - 20) === ZIP64_LOCATOR)) throw new ArchiveRefusal("a zip64 archive");
    if (tail.readUInt16LE(at + 4) !== 0 || tail.readUInt16LE(at + 6) !== 0 || tail.readUInt16LE(at + 8) !== count) throw new ArchiveRefusal("a spanned archive");
    if (dirOffset + dirSize > size - tailLen + at) throw new ArchiveRefusal("a central directory past its end");
    const dir = Buffer.alloc(dirSize);
    await fh.read(dir, 0, dirSize, dirOffset);
    const entries: ZipEntry[] = [];
    for (let p = 0, i = 0; i < count; i++) {
      if (p + 46 > dir.length || dir.readUInt32LE(p) !== CENTRAL) throw new ArchiveRefusal("a damaged central directory");
      const madeBy = dir.readUInt16LE(p + 4);
      const flags = dir.readUInt16LE(p + 8);
      const method = dir.readUInt16LE(p + 10);
      const crc = dir.readUInt32LE(p + 16);
      const compressedSize = dir.readUInt32LE(p + 20);
      const usize = dir.readUInt32LE(p + 24);
      const nameLen = dir.readUInt16LE(p + 28);
      const extraLen = dir.readUInt16LE(p + 30);
      const commentLen = dir.readUInt16LE(p + 32);
      const attrs = dir.readUInt32LE(p + 38);
      const localOffset = dir.readUInt32LE(p + 42);
      const raw = dir.subarray(p + 46, p + 46 + nameLen);
      const extra = dir.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (p > dir.length) throw new ArchiveRefusal("a damaged central directory");
      const name = flags & 0x800 ? raw.toString("utf8") : raw.every((b) => b < 0x80) ? raw.toString("ascii") : null;
      const shown = JSON.stringify(name ?? raw.toString("latin1"));
      if (name === null) throw new ArchiveRefusal(`${shown}: a name that is not UTF-8`);
      if (flags & 0x41) throw new ArchiveRefusal(`${shown}: an encrypted entry`);
      if (compressedSize === MAX32 || usize === MAX32 || localOffset === MAX32) throw new ArchiveRefusal(`${shown}: a zip64 entry`);
      for (let x = 0; x + 4 <= extra.length; x += 4 + extra.readUInt16LE(x + 2)) {
        if (extra.readUInt16LE(x) === 0x0001) throw new ArchiveRefusal(`${shown}: a zip64 entry`);
      }
      if (method !== 0 && method !== 8) throw new ArchiveRefusal(`${shown}: compression method ${method}`);
      const unix = madeBy >> 8 === 3 ? attrs >>> 16 : 0;
      const kind = unix & 0o170000;
      if (kind === 0o120000) throw new ArchiveRefusal(`${shown}: a symlink`);
      if (kind !== 0 && kind !== 0o100000 && kind !== 0o040000) throw new ArchiveRefusal(`${shown}: a special file`);
      entries.push({ name, folder: name.endsWith("/") || kind === 0o040000, method, compressedSize, size: usize, crc, localOffset, exec: (unix & 0o111) !== 0 });
    }
    return { entries, directoryOffset: dirOffset };
  } finally {
    await fh.close();
  }
}

export interface ZipOptions {
  platform: AddonPlatform;
  names: NameSet;
  /** `dest` relative to the add-on's root (`browser`), for the name check. */
  prefix: string;
  signal?: AbortSignal;
}

/** Extract the zip at `file` into `dest`; the files written. */
export async function extractZip(file: string, dest: string, opts: ZipOptions): Promise<ExtractedFile[]> {
  const { entries, directoryOffset } = await readZipDirectory(file);
  const files: ExtractedFile[] = [];
  await mkdir(dest, { recursive: true });
  const fh = await open(file, "r");
  try {
    for (const e of entries) {
      opts.signal?.throwIfAborted();
      const rel = e.folder && !e.name.endsWith("/") ? `${e.name}/` : e.name;
      const problem = entryNameProblem(rel, opts.platform) ?? opts.names.add(`${opts.prefix}/${rel}`);
      if (problem) throw new ArchiveRefusal(`${JSON.stringify(e.name)}: ${problem}`);
      const target = join(dest, ...rel.split("/").filter(Boolean));
      const r = relative(dest, target);
      if (r === "" || r.startsWith("..") || isAbsolute(r)) throw new ArchiveRefusal(`${JSON.stringify(e.name)}: a path outside the target`);
      if (e.folder) {
        await mkdir(target, { recursive: true });
        continue;
      }
      const local = Buffer.alloc(30);
      await fh.read(local, 0, 30, e.localOffset);
      if (local.readUInt32LE(0) !== LOCAL || local.readUInt16LE(6) & 0x41) throw new ArchiveRefusal(`${JSON.stringify(e.name)}: a damaged local header`);
      const start = e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (start + e.compressedSize > directoryOffset) throw new ArchiveRefusal(`${JSON.stringify(e.name)}: data past the central directory`);
      await mkdir(dirname(target), { recursive: true });
      const mode = e.exec ? 0o755 : 0o644;
      const hash = createHash("sha256");
      let crc = 0;
      let size = 0;
      if (e.compressedSize === 0) await writeFile(target, "", { flag: "wx", mode });
      else {
        const meter = new Transform({
          transform(chunk: Buffer, _enc, done) {
            size += chunk.length;
            if (size > e.size) return done(new ArchiveRefusal(`${JSON.stringify(e.name)}: more data than its size`));
            hash.update(chunk);
            crc = crc32(chunk, crc);
            done(null, chunk);
          },
        });
        await pipeline(
          createReadStream(file, { start, end: start + e.compressedSize - 1 }),
          e.method === 8 ? createInflateRaw() : new PassThrough(),
          meter,
          createWriteStream(target, { flags: "wx", mode }),
          { signal: opts.signal },
        );
      }
      if (size !== e.size || (crc >>> 0) !== e.crc) throw new ArchiveRefusal(`${JSON.stringify(e.name)}: its size or CRC-32 does not match`);
      files.push({ path: rel, size, exec: execBit(mode), sha256: hash.digest("hex") });
    }
  } finally {
    await fh.close();
  }
  return files;
}
