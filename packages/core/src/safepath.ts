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
 *  - {@link assertPathUsable} refuses, for any rpc path, a Windows device / NT
 *    path or a network path whose server name has no key (unc.ts).
 *  - {@link sanitizeProjectIds} rewrites non-token ids on load/import.
 *  - {@link assertProjectMediaLocal} refuses a project whose media is non-local.
 *  - {@link coerceProjectNumbers} / {@link coerceProjectValues} give every
 *    value that reaches an FFmpeg graph the type the model says it has.
 */
import { newId } from "./ids.js";
import { PRODUCT_NAME } from "./brand.js";
import { classifyPath, type RefusedPath } from "./unc.js";
import { isTransitionType, type Project, type MediaAsset, type Clip, type Track } from "./types.js";
import { isBlendMode } from "./effects/compositing.js";
import { parseKeyColor } from "./effects/registry.js";

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
 * A refused path (unc.ts) for an error message: what it is, why, and how to
 * fix it. `inProject` picks the fix: edit the project file, or pass another
 * path.
 */
function refusedMessage(p: string, field: string, c: RefusedPath, inProject: boolean): string {
  const fix = inProject
    ? "then change this path in the project file (it is a text file) and open the project again."
    : "and use that path instead.";
  const plainName = `Map that folder to a drive letter, or use the computer's plain name, ${fix}`;
  if (c.form === "host" && c.host === "") {
    return `${field} "${show(p)}" has no computer name after its leading slashes, which ${PRODUCT_NAME} can't use. ${plainName}`;
  }
  if (c.form === "host") {
    return `${field} "${show(p)}" names the network computer "${showHost(c.host)}", which ${PRODUCT_NAME} can't use. ${c.reason} ${plainName}`;
  }
  const what = c.form === "nt" ? "an NT path (\\??\\)" : "a Windows device path (\\\\?\\ / \\\\.\\)";
  const other = inProject ? "Use a drive-letter or \\\\server\\share path," : "Map that folder to a drive letter or a \\\\server\\share path,";
  return `${field} "${show(p)}" is ${what}, which ${PRODUCT_NAME} does not open. ${other} ${fix}`;
}

/** A server name as written, with every character outside printable ASCII shown as `\u{…}` (zero-width, look-alikes). */
function showHost(h: string): string {
  return h.replace(/[^\x21-\x7e]/gu, (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`);
}

/** The {@link classifyPath} refusal of `p`, or undefined for a path it accepts. */
function refusal(p: string): RefusedPath | undefined {
  const c = classifyPath(p);
  return c.kind === "refused" ? c : undefined;
}

/** True for an absolute path: POSIX (`/…`), a Windows drive letter, or a network path (`\\server\share`, any separators). */
function isAbsoluteAnyOs(p: string): boolean {
  return p.startsWith("/") || WIN_DRIVE.test(p) || classifyPath(p).kind === "network";
}

/**
 * True when `p` is an ABSOLUTE LOCAL filesystem path: POSIX (`/…`), a Windows
 * drive letter (`C:\…`, accepted on every host so a project saved on Windows
 * still opens on WSL/Linux and vice-versa) or a network share (`\\server\share`,
 * `//server/share` or a mix of separators, a normal network drive on a
 * desktop). A URL/protocol form, a path unc.ts refuses (a Windows device or NT
 * path, a server name with no key) and a bare relative path are all rejected.
 *
 * Accepted risk, until the per-server approval lands: on a Windows host, a
 * network path in a loaded .aive/.otio makes probe, thumbnail and render open
 * an SMB connection to the named host, which can send the user's NTLM
 * credentials to it. unc.ts already recognizes the host.
 */
export function isLocalMediaPath(p: unknown): p is string {
  if (typeof p !== "string" || p === "") return false;
  if (looksLikeProtocol(p) || refusal(p)) return false;
  return isAbsoluteAnyOs(p);
}

/**
 * True for a form that must NEVER reach FFmpeg/ffprobe as an input: a
 * URL/protocol (`scheme:…`) or a path unc.ts refuses (a Windows device or NT
 * path, a server name with no key). A scheme-free relative path is NOT
 * protocol-like (it is a plain file, which FFmpeg resolves against the cwd) —
 * this is what separates the SSRF vector from a legitimately relative media
 * reference.
 */
export function isProtocolLike(p: unknown): boolean {
  return typeof p === "string" && (looksLikeProtocol(p) || !!refusal(p));
}

/**
 * Refuse the SSRF/protocol forms and the forms unc.ts refuses for a path that
 * came from a loaded project (asset.path, effects.lut). A network path with a
 * usable server name passes (see the accepted risk at isLocalMediaPath). A
 * relative or absolute LOCAL path passes unchanged — relative media
 * references are legitimate (a foreign OTIO's relative target_url, an old
 * project saved under a relative AIVE_DATA_DIR) and are not a network vector,
 * so refusing them would stop legitimate projects loading. `field` names
 * where the path came from.
 */
export function assertMediaNotProtocol(p: unknown, field: string): void {
  if (typeof p !== "string") return;
  if (looksLikeProtocol(p)) {
    const scheme = protocolName(p);
    throw new Error(
      `${field} "${show(p)}" is a "${scheme}:" URL/protocol path. ${PRODUCT_NAME} only opens local files (it never fetches over the network); relink the media to a file on this machine.`,
    );
  }
  const r = refusal(p);
  if (r) throw new Error(refusedMessage(p, field, r, true));
}

/**
 * Refuse an rpc path (load, save, export, import, font …) that unc.ts refuses:
 * a Windows device or NT path, or a network path whose server name has no
 * key. Anything else passes unchanged; each caller keeps its own checks.
 * `field` names the parameter.
 */
export function assertPathUsable(p: unknown, field: string): void {
  if (typeof p !== "string") return;
  const r = refusal(p);
  if (r) throw new Error(refusedMessage(p, field, r, false));
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
      `${field} "${show(p)}" is a "${scheme}:" URL/protocol path. ${PRODUCT_NAME} only opens local files (it never fetches over the network); relink the media to a file on this machine.`,
    );
  }
  assertPathUsable(p, field);
  if (!isAbsoluteAnyOs(p)) {
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
 * every `asset.path`, every cutout's `colorPath` and every `effects.lut` (clip
 * + adjustment) is neither a protocol nor a path unc.ts refuses (throws a
 * field-naming error that says how to fix the path otherwise), DROPS any
 * `proxyPath` / `previewPath` that is either (those are engine-regenerated
 * caches — a stale/foreign value is silently discarded, not fatal)
 * and DROPS an `effects.lut` that is not a .cube path (not checked on disk).
 * Mutates `project` (the dropped fields). Call after id sanitising.
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
      if (lut === undefined) continue;
      assertMediaNotProtocol(lut, `clip "${c.id}" LUT path`);
      // Only a .cube can be a LUT (the /file route serves it to the preview);
      // drop anything else, as with a foreign cache path. Existence is the render's.
      if (!/\.cube$/i.test(lut)) delete c.effects!.lut;
    }
  }
}

/**
 * Make the numeric scalars of a loaded/imported project real numbers. A .aive
 * is plain JSON: a string `revision` would survive `+= 1` as a string and reach
 * a file name (previews/preview-<revision>-…mp4 → a path outside the data dir),
 * and string geometry or clip timing would be spliced into filtergraphs. A value
 * that is not a finite number falls back to a safe default. Returns how many
 * fields were coerced (0 for any project ZabsReel wrote).
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

type Rec = Record<string, unknown>;

/**
 * Give every field of a loaded/imported project that reaches an FFmpeg graph
 * (export, preview, thumbnails, bakes) the type the model says it has, so no
 * project text is spliced into a filtergraph: asset geometry, fps, duration
 * and cutout start; probed colour descriptions and codecs; transitions (a
 * known xfade type); clip effects (speed,
 * volume, fades, opacity, colour, grade, crop, transform, blend mode, speed
 * ramp, visual and audio effects with their params and key colours, bleeps);
 * keyframes; text overlay and caption styles and timing; graphics; track
 * volume; music. A wrong-typed optional field is dropped (its default
 * applies), a wrong-typed required one falls back to a safe value and an
 * unknown transition type becomes "fade". Ranges are not clamped here: the
 * graph builders clamp (effects/registry.ts paramValue …), and a value a
 * valid project holds is never changed. Mutates `project`; returns how many
 * fields were changed (0 for any project ZabsReel wrote).
 */
export function coerceProjectValues(project: Project): number {
  let fixed = 0;
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const drop = (o: Rec, k: string) => {
    delete o[k];
    fixed++;
  };
  /** Drop each of `keys` that is present but not a finite number. */
  const nums = (o: Rec, ...keys: string[]) => {
    for (const k of keys) if (o[k] !== undefined && !finite(o[k])) drop(o, k);
  };
  /** Drop each of `keys` that is present but not a string. */
  const strs = (o: Rec, ...keys: string[]) => {
    for (const k of keys) if (o[k] !== undefined && typeof o[k] !== "string") drop(o, k);
  };
  /** A present non-finite (or below `min`) number becomes `fallback`. */
  const num = (o: Rec, k: string, fallback: number, min = -Infinity) => {
    if (o[k] !== undefined && !(finite(o[k]) && (o[k] as number) >= min)) {
      o[k] = fallback;
      fixed++;
    }
  };
  /** `o[k]` when it is a plain object; dropped (undefined) when it is something else. */
  const obj = (o: Rec, k: string): Rec | undefined => {
    const v = o[k];
    if (v === undefined) return undefined;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return v as Rec;
    drop(o, k);
    return undefined;
  };
  /** `o[k]`'s entries that `keep` accepts (an array of objects); a non-array is dropped. */
  const list = (o: Rec, k: string, keep: (e: Rec) => boolean = () => true): Rec[] => {
    const v = o[k];
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      drop(o, k);
      return [];
    }
    const kept = v.filter((e): e is Rec => e !== null && typeof e === "object" && !Array.isArray(e) && keep(e as Rec));
    if (kept.length !== v.length) {
      o[k] = kept;
      fixed += v.length - kept.length;
    }
    return kept;
  };
  /** Keyframe tracks: every keyframe has a finite frame and value. */
  const keyframes = (o: Rec, k: string) => {
    const tracks = obj(o, k);
    if (tracks) for (const p of Object.keys(tracks)) list(tracks, p, (kf) => finite(kf.frame) && finite(kf.value));
  };
  /** A text overlay / caption style (TextStyle). */
  const style = (s: Rec) => {
    nums(s, "x", "y", "fontSize", "outlineWidth", "shadowX", "shadowY", "boxBorderW");
    strs(s, "position", "font", "color", "outlineColor", "shadowColor", "boxColor");
  };
  /** An ffprobe name: a colour space, range, primaries or transfer ("bt709", "arib-std-b67" …) or a codec ("h264"). */
  const token = (v: unknown) => typeof v === "string" && /^[a-z0-9_-]{1,32}$/.test(v);
  /**
   * A probed colour description (ProbedColor): ffprobe names and a positive
   * integer coded height, or the whole description is dropped (load probes
   * the file again, probeUnrecordedColors). Its matrix and range name the
   * scale filter's in_color_matrix / in_range.
   */
  const colour = (o: Rec, k: string) => {
    const c = obj(o, k);
    if (!c) return;
    const named = ["space", "range", "primaries", "transfer"].every((f) => c[f] === undefined || token(c[f]));
    const height = c.codedHeight === undefined || (Number.isInteger(c.codedHeight) && (c.codedHeight as number) > 0);
    if (!named || !height) drop(o, k);
  };
  /** A visual or audio effect's params: only finite numbers. */
  const params = (e: Rec) => {
    const p = obj(e, "params");
    if (p) nums(p, ...Object.keys(p));
  };

  for (const a of project.assets ?? []) {
    const r = a as unknown as Rec;
    num(r, "duration", 0, 0);
    num(r, "width", 0, 0);
    num(r, "height", 0, 0);
    num(r, "fps", 0, 0);
    colour(r, "color");
    colour(r, "proxyColor");
    if (r.videoCodec !== undefined && !token(r.videoCodec)) drop(r, "videoCodec");
    const cut = obj(r, "cutout");
    if (cut) {
      num(cut, "colorStart", 0, 0);
      // The colour source's codec and description are recorded (and probed again) together.
      if (cut.colorCodec !== undefined && !token(cut.colorCodec)) {
        drop(cut, "colorCodec");
        if (cut.colorTags !== undefined) drop(cut, "colorTags");
      }
      colour(cut, "colorTags");
    }
    const rev = obj(r, "reversedFrom");
    if (rev) {
      num(rev, "sourceInFrame", 0, 0);
      num(rev, "sourceOutFrame", 0, 0);
    }
  }
  for (const t of project.tracks ?? []) {
    nums(t as unknown as Rec, "volume");
    for (const c of t.clips ?? []) {
      const cl = c as unknown as Rec;
      const tr = obj(cl, "transition");
      if (tr) {
        if (!isTransitionType(tr.type)) {
          tr.type = "fade";
          fixed++;
        }
        num(tr, "durationFrames", 1, 0);
      }
      keyframes(cl, "keyframes");
      for (const ov of list(cl, "overlays", (o) => typeof o.text === "string")) {
        style(ov);
        nums(ov, "startFrame", "endFrame");
        keyframes(ov, "keyframes");
      }
      const cap = obj(cl, "captions");
      if (cap) {
        list(cap, "cues", (q) => finite(q.startFrame) && finite(q.endFrame) && typeof q.text === "string");
        const st = obj(cap, "style");
        if (st) style(st);
      }
      for (const g of list(cl, "graphics")) nums(g, "opacity", "startFrame", "endFrame");

      const fx = obj(cl, "effects");
      if (!fx) continue;
      nums(fx, "speed", "volume", "fadeInFrames", "fadeOutFrames", "opacity");
      strs(fx, "lut");
      const ramp = obj(fx, "speedRamp");
      if (ramp) {
        nums(ramp, "phase");
        if (list(ramp, "points", (pt) => finite(pt.src) && finite(pt.speed)).length === 0) drop(fx, "speedRamp");
      }
      const color = obj(fx, "color");
      if (color) nums(color, "brightness", "contrast", "saturation", "gamma");
      const grade = obj(fx, "grade");
      if (grade) {
        nums(grade, "temperature", "tint", "hue");
        for (const w of ["lift", "gamma", "gain"]) {
          const wheel = obj(grade, w);
          if (wheel) nums(wheel, "r", "g", "b");
        }
        strs(grade, "curve", "curveR", "curveG", "curveB");
      }
      const crop = obj(fx, "crop");
      if (crop && !["x", "y", "width", "height"].every((k) => finite(crop[k]))) drop(fx, "crop");
      const tf = obj(fx, "transform");
      if (tf) nums(tf, "x", "y", "scale", "rotation");
      if (fx.blendMode !== undefined && !isBlendMode(fx.blendMode)) drop(fx, "blendMode");
      for (const e of list(fx, "filters", (e) => typeof e.type === "string")) {
        nums(e, "amount");
        params(e);
        // A key colour is stored resolved ("0xRRGGBB"); "auto" is resolved by the graph builder's fallback.
        if (e.color !== undefined && !(typeof e.color === "string" && (e.color === "auto" || parseKeyColor(e.color)))) drop(e, "color");
      }
      for (const e of list(fx, "audioFilters", (e) => typeof e.type === "string")) params(e);
      for (const b of list(fx, "bleeps", (b) => finite(b.start) && finite(b.end))) nums(b, "volume");
    }
  }
  const music = obj(project as unknown as Rec, "music");
  if (music) {
    num(music, "volume", 1, 0);
    nums(music, "fadeInFrames", "fadeOutFrames");
  }
  return fixed;
}

// Re-exported for tests that want the raw type without importing engine internals.
export type { Project, MediaAsset, Clip, Track };
