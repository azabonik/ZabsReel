/**
 * Path safety for untrusted project data.
 *
 * A .aive / .otio file, a crash-recovery snapshot and an autosave are all
 * untrusted input: their ids end up in filesystem paths under the data dir
 * (bakes, proxies, thumbnails, frames, transcripts, captions …) and their
 * media paths are handed to FFmpeg / ffprobe. FFmpeg treats a `scheme:` input
 * as a PROTOCOL (http/https/ftp/rtmp/concat/data/subfile/async/crypto/…), so an
 * unvalidated media path lets a crafted project make the core fetch arbitrary
 * hosts (SSRF) or read files through a protocol; a crafted id with `..`/`/` in
 * it lets a bake escape the data dir (path traversal).
 *
 * This module is the single choke point for both:
 *  - {@link safeFileStem} sanitises any id used IN a filename.
 *  - {@link isLocalMediaPath} / {@link assertLocalMediaPath} classify a media
 *    path as a local file (accepted) vs a URL/protocol form (rejected).
 *  - {@link sanitizeProjectIds} rewrites non-token ids on load/import.
 *  - {@link assertProjectMediaLocal} refuses a project whose media is non-local.
 */
import { newId } from "./ids.js";
import type { Project, MediaAsset, Clip, Track } from "./types.js";

/** Max length of a sanitised filename stem (ids are ~15 chars; this is slack). */
const MAX_STEM = 64;
/** A plain, filename-safe token: exactly what {@link newId} and legitimate
 *  hand-written ids already are, so a legitimate id passes through unchanged. */
const PLAIN_TOKEN = /^[A-Za-z0-9_-]+$/;

/** True for an id that is already a plain, bounded, filename-safe token. */
export function isPlainToken(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && s.length <= MAX_STEM && PLAIN_TOKEN.test(s);
}

/**
 * An id made safe to embed in a filename. A legitimate id (newId output or a
 * plain token) is returned UNCHANGED — bake/proxy/thumbnail names and the
 * render-cache keys that string-match them are byte-identical, so no cache
 * version bumps. Anything else (a `../../x` traversal id from a crafted
 * project) collapses to `[A-Za-z0-9_-]`, bounded and never empty; the existing
 * timestamp / random suffixes on the call sites keep it collision-safe.
 */
export function safeFileStem(id: unknown): string {
  if (isPlainToken(id)) return id;
  const cleaned = (typeof id === "string" ? id : "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_STEM);
  return cleaned.length ? cleaned : "id";
}

/** A Windows drive-letter path (`C:\…` / `c:/…`). */
const WIN_DRIVE = /^[A-Za-z]:[\\/]/;
/** A UNC share (`\\server\share`), but NOT a `\\?\` / `\\.\` device namespace. */
const WIN_UNC = /^\\\\[^\\?.]/;
/** A `\\?\` or `\\.\` Windows device namespace (refused). */
const WIN_DEVICE = /^\\\\[?.]\\/;
/** A URL/protocol scheme (`http:`, `file:`, `data:`, `concat:`, `C` alone is NOT — see guard). */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Short, log-safe rendering of an untrusted path for an error message. */
function show(p: string): string {
  const s = p.replace(/[\r\n\t]/g, " ");
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

/**
 * FFmpeg's one comma form of a protocol name: `subfile,,start,…,:<url>` opens
 * the subfile protocol (libavformat url_find_protocol) although `subfile,` is
 * not a `scheme:` prefix.
 */
const SUBFILE = /^subfile,.*:/is;

/**
 * True when `p` is a `scheme:` protocol/URL form (what FFmpeg would open as a
 * protocol), including the `subfile,…:` comma form. A Windows drive letter
 * (`C:\…`) is explicitly NOT a protocol, so it must be checked first —
 * otherwise `C:` reads as scheme `C`.
 */
export function looksLikeProtocol(p: string): boolean {
  if (typeof p !== "string") return false;
  if (WIN_DRIVE.test(p)) return false;
  return SCHEME.test(p) || SUBFILE.test(p);
}

/** The protocol name of a {@link looksLikeProtocol} path, for an error message. */
export function protocolName(p: string): string {
  return SUBFILE.test(p) ? "subfile" : p.slice(0, p.indexOf(":"));
}

/**
 * True when `p` is an ABSOLUTE LOCAL filesystem path: POSIX (`/…`), a Windows
 * drive letter (`C:\…`, accepted on every host so a project saved on Windows
 * still opens on WSL/Linux and vice-versa) or a UNC share (`\\server\share`,
 * a normal network drive on a desktop). A URL/protocol form, a Windows device
 * namespace (`\\?\`, `\\.\`) and a bare relative path are all rejected.
 *
 * Accepted risk: on a Windows host, a UNC or `//host/share` path in a loaded
 * .aive/.otio makes probe, thumbnail and render open an SMB connection to the
 * named host, which can send the user's NTLM credentials to it. This is
 * accepted deliberately so projects on a NAS keep working.
 */
export function isLocalMediaPath(p: unknown): p is string {
  if (typeof p !== "string" || p === "") return false;
  if (looksLikeProtocol(p)) return false;
  if (WIN_DEVICE.test(p)) return false;
  return p.startsWith("/") || WIN_DRIVE.test(p) || WIN_UNC.test(p);
}

/**
 * True for a form that must NEVER reach FFmpeg/ffprobe as an input: a
 * URL/protocol (`scheme:…`) or a Windows device namespace (`\\?\`, `\\.\`).
 * A scheme-free relative path is NOT protocol-like (it is a plain file, which
 * FFmpeg resolves against the cwd) — this is what separates the SSRF vector
 * from a legitimately relative media reference.
 */
export function isProtocolLike(p: unknown): boolean {
  return typeof p === "string" && (looksLikeProtocol(p) || WIN_DEVICE.test(p));
}

/**
 * Refuse only the SSRF/protocol forms for a path that came from a loaded
 * project (asset.path, effects.lut). UNC and `//host/share` paths pass: on a
 * Windows host they open an SMB connection (and can send NTLM credentials) to
 * the named host, an accepted risk for NAS workflows (see isLocalMediaPath). A relative or absolute LOCAL path passes
 * unchanged — relative media references are legitimate (a foreign OTIO's
 * relative target_url, an old project saved under a relative AIVE_DATA_DIR) and
 * are not a network vector, so refusing them would stop legitimate projects
 * loading. `field` names where the path came from.
 */
export function assertMediaNotProtocol(p: unknown, field: string): void {
  if (typeof p !== "string") return;
  if (looksLikeProtocol(p)) {
    const scheme = protocolName(p);
    throw new Error(
      `${field} "${show(p)}" is a "${scheme}:" URL/protocol path. SynthCut only opens local files (it never fetches over the network); relink the media to a file on this machine.`,
    );
  }
  if (WIN_DEVICE.test(p)) {
    throw new Error(`${field} "${show(p)}" is a Windows device path (\\\\?\\ / \\\\.\\), which SynthCut does not open.`);
  }
}

/**
 * Assert a media path is an absolute local file; throw a field-naming,
 * self-correcting error otherwise. Stricter than {@link assertMediaNotProtocol}
 * (relative is rejected too) — for USER-supplied rpc input (apply_lut,
 * import_video) where an absolute path is the documented contract.
 * `field` names where the path came from.
 */
export function assertLocalMediaPath(p: unknown, field: string): string {
  if (typeof p !== "string" || p === "") {
    throw new Error(`${field} is empty — expected an absolute local file path.`);
  }
  if (looksLikeProtocol(p)) {
    const scheme = protocolName(p);
    throw new Error(
      `${field} "${show(p)}" is a "${scheme}:" URL/protocol path. SynthCut only opens local files (it never fetches over the network); relink the media to a file on this machine.`,
    );
  }
  if (WIN_DEVICE.test(p)) {
    throw new Error(`${field} "${show(p)}" is a Windows device path (\\\\?\\ / \\\\.\\), which SynthCut does not open.`);
  }
  if (!(p.startsWith("/") || WIN_DRIVE.test(p) || WIN_UNC.test(p))) {
    throw new Error(`${field} "${show(p)}" is not an absolute local path.`);
  }
  return p;
}

/**
 * Rewrite every id in a loaded project that is NOT a plain filename-safe token
 * to a fresh {@link newId}, updating all references, so a crafted id can never
 * reach a filename. Legitimate projects (ids are newId output) are untouched.
 * Returns how many ids were rewritten (0 = nothing changed). Mutates `project`.
 *
 * Reference graph (only these ids are cross-referenced; everything else is an
 * identity used in place):
 *   asset.id  ← clip.assetId, graphic.assetId, bleep.sfxAssetId,
 *               music.assetId, asset.reversedFrom.assetId, asset.cutout.colorAssetId
 *   folder.id ← asset.folderId
 *   clip.linkGroupId is its own shared namespace (remapped consistently).
 */
export function sanitizeProjectIds(project: Project): number {
  let rewrites = 0;
  const fresh = (prefix: string): string => {
    rewrites++;
    return newId(prefix);
  };

  // --- assets (remap, then fix references) ---
  const assetRemap = new Map<string, string>();
  for (const a of project.assets ?? []) {
    if (!isPlainToken(a.id)) {
      const id = fresh("asset");
      assetRemap.set(a.id, id);
      a.id = id;
    }
  }
  // --- folders (remap, then fix asset.folderId) ---
  const folderRemap = new Map<string, string>();
  for (const f of project.folders ?? []) {
    if (!isPlainToken(f.id)) {
      const id = fresh("fld");
      folderRemap.set(f.id, id);
      f.id = id;
    }
  }
  for (const a of project.assets ?? []) {
    if (a.folderId !== undefined && folderRemap.has(a.folderId)) a.folderId = folderRemap.get(a.folderId)!;
    if (a.reversedFrom && assetRemap.has(a.reversedFrom.assetId)) a.reversedFrom.assetId = assetRemap.get(a.reversedFrom.assetId)!;
    if (a.cutout?.colorAssetId !== undefined && assetRemap.has(a.cutout.colorAssetId)) a.cutout.colorAssetId = assetRemap.get(a.cutout.colorAssetId)!;
  }
  if (project.music && assetRemap.has(project.music.assetId)) project.music.assetId = assetRemap.get(project.music.assetId)!;

  // --- link groups: a shared id across clips; remap consistently ---
  const linkRemap = new Map<string, string>();
  for (const t of project.tracks ?? []) {
    for (const c of t.clips ?? []) {
      if (c.linkGroupId !== undefined && !isPlainToken(c.linkGroupId) && !linkRemap.has(c.linkGroupId)) {
        linkRemap.set(c.linkGroupId, fresh("link"));
      }
    }
  }

  // --- clips and their in-place ids ---
  for (const t of project.tracks ?? []) {
    if (!isPlainToken(t.id)) t.id = fresh("track");
    for (const c of t.clips ?? []) {
      if (!isPlainToken(c.id)) c.id = fresh("clip");
      if (c.assetId !== undefined && assetRemap.has(c.assetId)) c.assetId = assetRemap.get(c.assetId)!;
      if (c.linkGroupId !== undefined && linkRemap.has(c.linkGroupId)) c.linkGroupId = linkRemap.get(c.linkGroupId)!;
      for (const ov of c.overlays ?? []) if (!isPlainToken(ov.id)) ov.id = fresh("text");
      for (const g of c.graphics ?? []) {
        if (!isPlainToken(g.id)) g.id = fresh("gfx");
        if (g.assetId !== undefined && assetRemap.has(g.assetId)) g.assetId = assetRemap.get(g.assetId)!;
      }
      for (const e of c.effects?.filters ?? []) if (!isPlainToken(e.id)) e.id = fresh("fx");
      for (const e of c.effects?.audioFilters ?? []) if (!isPlainToken(e.id)) e.id = fresh("afx");
      for (const b of c.effects?.bleeps ?? []) {
        if (!isPlainToken(b.id)) b.id = fresh("bleep");
        if (b.sfxAssetId !== undefined && assetRemap.has(b.sfxAssetId)) b.sfxAssetId = assetRemap.get(b.sfxAssetId)!;
      }
    }
  }
  if (!isPlainToken(project.id)) project.id = fresh("proj");
  return rewrites;
}

/**
 * Refuse a loaded/imported project whose media is not a local file. Asserts
 * every `asset.path`, every cutout's `colorPath` and every `effects.lut` (clip + adjustment) is an absolute
 * local path (throws a field-naming error otherwise), and DROPS any
 * `proxyPath` / `previewPath` that is non-local (those are engine-regenerated
 * caches — a stale/foreign protocol value is silently discarded, not fatal).
 * Mutates `project` (the dropped cache fields). Call after id sanitising.
 */
export function assertProjectMediaLocal(project: Project): void {
  for (const a of project.assets ?? []) {
    assertMediaNotProtocol(a.path, `asset "${a.id}" path`);
    // A matte-backed cutout reads its colour from the original footage (renders, bakes, proxies).
    if (a.cutout?.colorPath !== undefined) assertMediaNotProtocol(a.cutout.colorPath, `asset "${a.id}" cutout colour path`);
    if (a.proxyPath !== undefined && isProtocolLike(a.proxyPath)) delete a.proxyPath;
    if (a.previewPath !== undefined && isProtocolLike(a.previewPath)) delete a.previewPath;
  }
  for (const t of project.tracks ?? []) {
    for (const c of t.clips ?? []) {
      const lut = c.effects?.lut;
      if (lut !== undefined) assertMediaNotProtocol(lut, `clip "${c.id}" LUT path`);
    }
  }
}

/**
 * Make the numeric scalars of a loaded/imported project real numbers. A .aive
 * is plain JSON: a string `revision` would survive `+= 1` as a string and reach
 * a file name (previews/preview-<revision>-…mp4 → a path outside the data dir),
 * and string geometry or clip timing would be spliced into filtergraphs. A value
 * that is not a finite number falls back to a safe default. Returns how many
 * fields were coerced (0 for any project SynthCut wrote).
 */
export function coerceProjectNumbers(project: Project): number {
  let fixed = 0;
  const num = (v: unknown, fallback: number, min = -Infinity): number => {
    if (typeof v === "number" && Number.isFinite(v) && v >= min) return v;
    fixed++;
    return fallback;
  };
  const p = project as unknown as Record<string, unknown>;
  p.revision = Math.floor(num(p.revision, 0, 0));
  p.width = Math.round(num(p.width, 1920, 1));
  p.height = Math.round(num(p.height, 1080, 1));
  p.fps = num(p.fps, 30, 1);
  for (const t of project.tracks ?? []) {
    const tr = t as unknown as Record<string, unknown>;
    if (tr.index !== undefined) tr.index = Math.round(num(tr.index, 0, 0));
    for (const c of t.clips ?? []) {
      const cl = c as unknown as Record<string, unknown>;
      cl.startFrame = Math.round(num(cl.startFrame, 0, 0));
      cl.sourceInFrame = Math.round(num(cl.sourceInFrame, 0, 0));
      cl.sourceOutFrame = Math.round(num(cl.sourceOutFrame, (cl.sourceInFrame as number) + 1, 0));
      if (cl.audioOffsetFrames !== undefined) cl.audioOffsetFrames = Math.round(num(cl.audioOffsetFrames, 0));
    }
  }
  return fixed;
}

// Re-exported for tests that want the raw type without importing engine internals.
export type { Project, MediaAsset, Clip, Track };
