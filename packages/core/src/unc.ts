/**
 * Network-path recognition, shared by the core and the renderer.
 *
 * On Windows, opening `\\server\share\…` (even a `stat`) signs in to that
 * server and sends it an NTLM response, so a path from a project file or from
 * the agent must never name a server the user has not allowed. This module
 * only recognizes such paths and gives each server one key; it opens nothing.
 *
 * The rules are the same on every platform and work on the raw string:
 *  - `S` is `/` or `\`. Any string that starts with two of them names a
 *    server, so `\\nas\s`, `//nas/s`, `\/nas/s` and `/\nas\s` all do.
 *  - `S S ? S`, `S S . S` (device paths) and `S ? ? S` (NT paths) are refused.
 *  - A host is keyed by its ASCII lower-case name and nothing else. Any host
 *    that would need a conversion to compare (non-ASCII, `%`, `@`, `:`,
 *    `*.ipv6-literal.net`, an IPv4 address not written as a.b.c.d) is refused,
 *    so two strings share a key only when they certainly name one server.
 *
 * Pure code with no Node imports (the renderer imports it as @aive/core/unc).
 * It never calls `URL`, `punycode` or `normalize` on a host.
 */

/** Why a path is refused: a device / NT form, or a host that has no key. */
export type RefusedPath =
  | { kind: "refused"; form: "device"; reason: string }
  | { kind: "refused"; form: "nt"; reason: string }
  | { kind: "refused"; form: "host"; host: string; reason: string };

export type PathClass =
  | { kind: "local" }
  | { kind: "network"; host: string; display: string }
  | RefusedPath;

export type HostKey = { ok: true; key: string } | { ok: false; reason: string };

/** `S S ? S` / `S S . S`: a Win32 device path (`\\?\C:\…`, `//./UNC/…`). */
const DEVICE = /^[\\/]{2}[?.][\\/]/;
/** `S ? ? S`: an NT object path (`\??\UNC\srv\…`). */
const NT = /^[\\/]\?\?[\\/]/;
/** Two leading separators: the rest up to the next separator is a host. */
const NETWORK = /^[\\/]{2}([^\\/]*)/;

/** The characters a host may use at all (rule 1). */
const HOST_CHARS = /^[A-Za-z0-9._$-]+$/;
/** A dotted-quad IPv4 address in the usual form: decimal, no leading zeros. */
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/** A name: dot-separated labels with no empty label. */
const NAME = /^[a-z0-9_$-]+(\.[a-z0-9_$-]+)*$/;

/** The middle sentence of a refusal for a host with the wrong characters. */
export const PLAIN_NAMES_ONLY = "Only plain names (xn--… for an international name) and a.b.c.d addresses work.";

/**
 * The key of a server name as written in a path (the text between the two
 * leading separators and the next one), or why it has none. The first rule
 * that matches decides.
 */
export function normalizeHost(raw: string): HostKey {
  // 1. Character set, before any conversion: no Unicode folding, no %-decoding,
  //    no WebDAV `@SSL` / `@port`, no `:port`, no IPv6 brackets.
  if (!HOST_CHARS.test(raw)) return { ok: false, reason: PLAIN_NAMES_ONLY };
  // 2. IPv6 literal names: no IPv6 parsing.
  if (/\.ipv6-literal\.net$/i.test(raw)) {
    return { ok: false, reason: "IPv6 address names (….ipv6-literal.net) don't work; use the computer's name or its a.b.c.d address." };
  }
  // 3. IPv4: only the usual a.b.c.d form; any other numeric spelling is refused.
  if (IPV4.test(raw)) return { ok: true, key: raw };
  const labels = raw.split(".");
  if (/^\d+$/.test(labels[labels.length - 1]) || /^0x/i.test(raw)) {
    return { ok: false, reason: "Write the address in the usual a.b.c.d form." };
  }
  // 4. Names: ASCII lower case (the string is pure ASCII after rule 1).
  const key = raw.toLowerCase();
  if (!NAME.test(key) || key.length > 253 || labels.some((l) => l.length > 63)) {
    return {
      ok: false,
      reason: "A computer name can't start or end with a dot or have two dots in a row, and has at most 253 characters (63 between dots).",
    };
  }
  // 5. No other merging: `nas` and `nas.local` are two servers.
  return { ok: true, key };
}

/** Classify a path: a local path, a network path with its host key, or refused. */
export function classifyPath(p: string): PathClass {
  if (DEVICE.test(p)) {
    return { kind: "refused", form: "device", reason: "Windows device paths (\\\\?\\…, \\\\.\\…) are not opened." };
  }
  if (NT.test(p)) return { kind: "refused", form: "nt", reason: "Windows NT paths (\\??\\…) are not opened." };
  const m = NETWORK.exec(p);
  if (!m) return { kind: "local" };
  const raw = m[1];
  if (raw === "") return { kind: "refused", form: "host", host: raw, reason: "The path has no computer name after its leading slashes." };
  const h = normalizeHost(raw);
  if (!h.ok) return { kind: "refused", form: "host", host: raw, reason: h.reason };
  return { kind: "network", host: h.key, display: `\\\\${h.key}` };
}

/**
 * Which dialog a UI host shows when the user reviews server `key`, from the
 * approval store as read by `readTrustedHosts` (trusthosts.ts): "unread" when
 * the store could not be read and there is no good copy yet (no dialog, only
 * "couldn't read its list of approved computers; try again"), "keep" when the
 * server is in the list but ZabsReel did not add it ("added outside
 * ZabsReel": Keep / Remove), else "allow". The store decides, never the
 * renderer or the core's pending list.
 */
export function approvalDialogFor(
  list: { unread: readonly string[]; outside: readonly { host: string }[] },
  key: string,
): "unread" | "keep" | "allow" {
  if (list.unread.length > 0) return "unread";
  return list.outside.some((o) => o.host === key) ? "keep" : "allow";
}

/**
 * A dialog's default file name from text a project or the agent can set (a
 * project name): the text after the last `/` or `\`, with `:` and control
 * characters removed, "Untitled" when that leaves nothing. So a save dialog
 * never starts in a folder (or on a server) that came from project data.
 */
export function bareFileName(name: string): string {
  const last = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const bare = last.replace(/[:\u0000-\u001f\u007f-\u009f]/g, "");
  return bare === "" ? "Untitled" : bare;
}
