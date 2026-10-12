// Render the app icons from build/icon.svg:
//   build/icon.ico  — Windows icon (exe, installer, shortcuts): PNG entries at
//                     16, 24, 32, 48, 64, 128 and 256 px
//   build/icon.png  — 512 px, electron-builder's icon for other targets
//   logo.png        — 264 px logo at the repo root, shown at 132 px in README.md
// Uses Node built-ins plus the rsvg-convert binary from librsvg
// (Debian/Ubuntu: `sudo apt install librsvg2-bin`, macOS: `brew install librsvg`).
//
// Run from the repo root:  npx tsx apps/desktop/scripts/make-icon.ts

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = join(here, "..", "build");
const repoRoot = join(here, "..", "..", "..");
const svgPath = join(buildDir, "icon.svg");

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIZE = 512;
const LOGO_SIZE = 264;

/** Render the SVG to a size x size PNG. */
function render(size: number): Buffer {
  const r = spawnSync("rsvg-convert", ["--width", String(size), "--height", String(size), "--format", "png", svgPath], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(`could not run rsvg-convert (${r.error.message}); install librsvg`);
  if (r.status !== 0) throw new Error(`rsvg-convert failed at ${size}px: ${r.stderr.toString().trim()}`);
  const png = r.stdout;
  // PNG signature, then the IHDR chunk: width at byte 16, height at byte 20.
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) {
    throw new Error(`rsvg-convert did not return a ${size}x${size} PNG`);
  }
  return png;
}

/** Pack PNG images into an .ico: ICONDIR, one 16-byte ICONDIRENTRY per image, then the PNG data. */
function packIco(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;
  images.forEach(({ size, png }, i) => {
    const e = i * 16;
    entries.writeUInt8(size >= 256 ? 0 : size, e); // width; 0 means 256
    entries.writeUInt8(size >= 256 ? 0 : size, e + 1); // height; 0 means 256
    entries.writeUInt8(0, e + 2); // palette size: none
    entries.writeUInt8(0, e + 3); // reserved
    entries.writeUInt16LE(1, e + 4); // colour planes
    entries.writeUInt16LE(32, e + 6); // bits per pixel
    entries.writeUInt32LE(png.length, e + 8); // size of the image data
    entries.writeUInt32LE(offset, e + 12); // where the image data starts
    offset += png.length;
  });
  return Buffer.concat([header, entries, ...images.map((img) => img.png)]);
}

function write(path: string, data: Buffer, what: string): void {
  writeFileSync(path, data);
  console.log(`  wrote ${relative(repoRoot, path)} (${what}, ${data.length} bytes)`);
}

const ico = packIco(ICO_SIZES.map((size) => ({ size, png: render(size) })));
write(join(buildDir, "icon.ico"), ico, `${ICO_SIZES.join("/")} px`);
write(join(buildDir, "icon.png"), render(PNG_SIZE), `${PNG_SIZE} px`);
write(join(repoRoot, "logo.png"), render(LOGO_SIZE), `${LOGO_SIZE} px`);
