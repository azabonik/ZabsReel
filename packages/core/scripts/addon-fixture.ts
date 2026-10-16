/**
 * The graphics add-on's fixtures (ADDON-PLAN D8.1, D8.5): tarballs and zips
 * written in memory, a fixture pin over them, and a loopback registry that
 * serves them through AIVE_ADDON_REGISTRY. smoke-addon.ts runs the installer
 * on them; smoke-electron.mts and smoke-web.ts install them from the add-on
 * dialog (the UI hosts read the pin from AIVE_ADDON_TEST_PIN).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import type { AddonPin } from "../src/addon/state.js";
import { ADDON_PLATFORM_LISTS, ADDON_PLATFORMS, type AddonPlatform } from "../src/motion/addonlock.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The registry URL npm's lock gives `name@version`. */
export const reg = (name: string, version: string) => `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`;

/** A tar entry: a file (type "0", the default) or anything else, with pax records or a GNU long name. */
export interface TarIn {
  name: string;
  type?: string;
  data?: string | Buffer;
  mode?: number;
  pax?: Record<string, string>;
  long?: boolean;
  linkname?: string;
}

function tarHeader(name: string, type: string, size: number, mode: number, linkname = ""): Buffer {
  const h = Buffer.alloc(512);
  const octal = (n: number, len: number) => `${n.toString(8).padStart(len - 1, "0")}\0`;
  h.write(name.slice(0, 100), 0, "utf8");
  h.write(octal(mode, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(0, 12), 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write(linkname, 157);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}
const padded = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

/** A gzipped tarball of `entries`. */
export function makeTar(entries: TarIn[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "");
    if (e.pax) {
      const recs = Object.entries(e.pax).map(([k, v]) => {
        const body = ` ${k}=${v}\n`;
        let len = body.length + 1;
        while (`${len}${body}`.length !== len) len++;
        return `${len}${body}`;
      });
      const pax = Buffer.from(recs.join(""));
      parts.push(tarHeader("PaxHeader", "x", pax.length, 0o644), padded(pax));
    }
    if (e.long) {
      const long = Buffer.from(`${e.name}\0`);
      parts.push(tarHeader("././@LongLink", "L", long.length, 0o644), padded(long));
    }
    parts.push(tarHeader(e.name, e.type ?? "0", e.type && e.type !== "0" ? 0 : data.length, e.mode ?? 0o644, e.linkname), padded(data));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

/** A zip entry: a folder when the name ends in "/"; `mode` the Unix mode (made on Unix unless `host`). */
export interface ZipIn {
  name: string;
  data?: string;
  method?: number;
  mode?: number;
  host?: number;
  flags?: number;
  extra?: Buffer;
  crc?: number;
}

/** A zip of `entries` (deflate unless `method` 0); `zip64`: a zip64 locator before the end record. */
export function makeZip(entries: ZipIn[], opts: { zip64?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "");
    const method = e.method ?? (e.name.endsWith("/") ? 0 : 8);
    const comp = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(e.name);
    const extra = e.extra ?? Buffer.alloc(0);
    const crc = e.crc ?? crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(((e.host ?? 3) << 8) | 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(e.flags ?? 0, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(extra.length, 30);
    c.writeUInt32LE(((e.mode ?? (e.name.endsWith("/") ? 0o40755 : 0o100644)) << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    locals.push(local, name, comp);
    central.push(c, name, extra);
    offset += 30 + name.length + comp.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  const locator = Buffer.alloc(opts.zip64 ? 20 : 0);
  if (opts.zip64) locator.writeUInt32LE(0x07064b50, 0);
  return Buffer.concat([...locals, dir, locator, end]);
}

export const sha512b64 = (b: Buffer) => createHash("sha512").update(b).digest("base64");
export const sha256hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** A fixture package: lock path, version, its files (without npm's `package/`), the platforms that install it (all by default). */
export interface FixturePkg {
  path: string;
  version: string;
  files: TarIn[];
  only?: AddonPlatform[];
}

const RENDERER = join(REPO, "node_modules", "@remotion", "renderer", "dist");
/** Marks that add-on code ran in this process (the fixture's remotion and renderer set it when loaded). */
export const RAN = "__zrAddonRan";
export const pkgJson = (name: string, version: string, extra: Record<string, unknown> = {}) => ({ name: "package.json", data: JSON.stringify({ name, version, ...extra }) });

/** The fixture closure: Remotion's three packages (the renderer with the real rewrite targets), a compositor per platform, a and its nested b. */
export function basePkgs(postinstallMarker: string): FixturePkg[] {
  const compositor = (p: AddonPlatform): FixturePkg => {
    const [dir, bin] = ADDON_PLATFORM_LISTS[p].compositor.split(/\/(?=[^/]+$)/);
    return { path: `node_modules/${dir}`, version: "4.0.481", only: [p], files: [pkgJson(dir, "4.0.481"), { name: bin, data: `compositor ${p}`, mode: 0o755 }] };
  };
  return [
    { path: "node_modules/remotion", version: "4.0.481", files: [
      pkgJson("remotion", "4.0.481", { main: "index.js", scripts: { postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(postinstallMarker)}, '')"` } }),
      { name: "index.js", data: `globalThis.${RAN} = "remotion";\n` },
    ] },
    { path: "node_modules/@remotion/renderer", version: "4.0.481", files: [
      pkgJson("@remotion/renderer", "4.0.481"),
      { name: "dist/esm/index.mjs", data: `globalThis.${RAN} = "renderer";\n${readFileSync(join(RENDERER, "esm", "index.mjs"), "utf8")}` },
      { name: "dist/assets/download-and-map-assets-to-file.js", data: readFileSync(join(RENDERER, "assets", "download-and-map-assets-to-file.js"), "utf8") },
    ] },
    { path: "node_modules/@remotion/bundler", version: "4.0.481", files: [pkgJson("@remotion/bundler", "4.0.481", { bin: { "remotion-bundle": "./bin/cli.js" } }), { name: "bin/cli.js", data: "#!/usr/bin/env node\n", mode: 0o644 }] },
    ...ADDON_PLATFORMS.map(compositor),
    { path: "node_modules/a", version: "1.0.0", files: [pkgJson("a", "1.0.0"), { name: "index.js", data: "module.exports = 1;\n" }, { name: "lib/deep/x.js", data: "x\n" }] },
    { path: "node_modules/a/node_modules/b", version: "1.0.0", files: [pkgJson("b", "1.0.0"), { name: "b.js", data: "b\n" }] },
  ];
}

export const CFT_EXE = (p: AddonPlatform) => `chrome-headless-shell-${p}/chrome-headless-shell${p === "win32-x64" ? ".exe" : ""}`;
/** The fixture browser zip for `p`: a folder, the executable (deflate, 0755), a stored file, a nested deflated one. */
export const fixtureZip = (p: AddonPlatform, extra: ZipIn[] = []) => makeZip([
  { name: `chrome-headless-shell-${p}/` },
  { name: CFT_EXE(p), data: `#!/bin/sh\necho headless ${p}\n`, mode: 0o100755 },
  { name: `chrome-headless-shell-${p}/resources.pak`, data: "stored bytes", method: 0 },
  { name: `chrome-headless-shell-${p}/locales/en-US.pak`, data: "x".repeat(5000) },
  ...extra,
]);

export interface Fixture {
  pin: AddonPin;
  /** URL path → the bytes the fixture registry serves. */
  blobs: Map<string, Buffer>;
}

/**
 * A pin over `pkgs` and a zip per platform, and what the registry serves for
 * it. `origins`: the pin's URLs on other hosts (the UI smokes use hosts under
 * .invalid, so only the override can reach them).
 */
export function buildPin(pkgs: FixturePkg[], zips: Partial<Record<AddonPlatform, Buffer>> = {}, tag = "", origins = { registry: "https://registry.npmjs.org", storage: "https://storage.googleapis.com" }): Fixture {
  const blobs = new Map<string, Buffer>();
  const closure = pkgs.map((p) => {
    const name = p.path.slice(p.path.lastIndexOf("node_modules/") + 13);
    const gz = makeTar(p.files.map((f) => ({ ...f, name: `package/${f.name}` })));
    const resolved = `${origins.registry}${new URL(reg(name, p.version)).pathname}`;
    blobs.set(new URL(resolved).pathname, gz);
    return { path: p.path, version: p.version, resolved, integrity: `sha512-${sha512b64(gz)}`, optional: false, bytes: gz.length };
  });
  const lists = Object.fromEntries(ADDON_PLATFORMS.map((plat) => {
    const paths = pkgs.filter((p) => !p.only || p.only.includes(plat)).map((p) => p.path).sort();
    return [plat, { count: paths.length, bytes: paths.reduce((n, x) => n + closure.find((e) => e.path === x)!.bytes, 0), compositor: ADDON_PLATFORM_LISTS[plat].compositor, paths }];
  })) as unknown as AddonPin["lists"];
  const shell = Object.fromEntries(ADDON_PLATFORMS.map((plat) => {
    const zip = zips[plat] ?? fixtureZip(plat);
    const url = `${origins.storage}/chrome-for-testing-public/fixture${tag}/${plat}/chrome-headless-shell-${plat}.zip`;
    blobs.set(new URL(url).pathname, zip);
    return [plat, { url, sha256: sha256hex(zip), size: zip.length, executable: CFT_EXE(plat), entries: 4 }];
  })) as unknown as AddonPin["shell"];
  return { pin: { lockSha256: sha256hex(JSON.stringify({ closure, lists, shell, tag })), closure, lists, shell }, blobs };
}

// ---- the fixture registry -------------------------------------------------------------

/** How a path answers: 500, close the socket mid-body, changed bytes, an endless body, hold the answer, or wait. */
export type Answer = "500" | "close" | "wrong" | "big" | "hold" | { delay: number };

export interface FixtureRegistry {
  /** http://127.0.0.1:<port>: the value of AIVE_ADDON_REGISTRY. */
  url: string;
  /** URL path → the bytes served. */
  served: Map<string, Buffer>;
  /** URL path → requests seen. */
  hits: Map<string, number>;
  answers: Map<string, Answer>;
  start(): Promise<void>;
  stop(): Promise<void>;
  publish(f: Fixture): void;
  /** The paths requested at least once, sorted. */
  hitPaths(): string[];
}

/** A loopback registry on `port` that serves published fixtures and counts requests. */
export function fixtureRegistry(port: number): FixtureRegistry {
  const served = new Map<string, Buffer>();
  const hits = new Map<string, number>();
  const answers = new Map<string, Answer>();
  const sockets = new Set<Socket>();
  let server: http.Server | undefined;
  return {
    url: `http://127.0.0.1:${port}`,
    served,
    hits,
    answers,
    start() {
      server = http.createServer((req, res) => {
        const path = new URL(req.url ?? "/", "http://x").pathname;
        hits.set(path, (hits.get(path) ?? 0) + 1);
        const blob = served.get(path);
        const a = answers.get(path);
        if (!blob) return void res.writeHead(404).end();
        if (a === "500") return void res.writeHead(500).end();
        if (a === "hold") return void res.writeHead(200, { "content-length": blob.length }).flushHeaders();
        if (a === "close") {
          res.writeHead(200, { "content-length": blob.length });
          res.write(blob.subarray(0, blob.length >> 1));
          setTimeout(() => res.socket?.destroy(), 20);
          return;
        }
        if (a === "big") {
          res.writeHead(200);
          const more = setInterval(() => res.write(blob), 5);
          res.on("close", () => clearInterval(more));
          return;
        }
        const body = a === "wrong" ? Buffer.from(blob.map((b, i) => (i === blob.length >> 1 ? b ^ 1 : b))) : blob;
        const send = () => res.writeHead(200, { "content-length": body.length }).end(body);
        if (typeof a === "object") setTimeout(send, a.delay);
        else send();
      });
      server.on("connection", (s) => {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
      });
      return new Promise((r) => server!.listen(port, "127.0.0.1", () => r()));
    },
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server?.close(r));
    },
    publish(f) {
      for (const [k, v] of f.blobs) served.set(k, v);
    },
    hitPaths: () => [...hits.entries()].filter(([, n]) => n > 0).map(([p]) => p).sort(),
  };
}
