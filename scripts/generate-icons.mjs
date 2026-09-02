/**
 * Zero-dependency PWA icon generator.
 *
 * Rasterises the MarketPulse mark (navy tile + sky-blue pulse line + amber
 * dot) into the PNG sizes a real "Add to Home Screen" install needs:
 *
 *   public/icon-192.png        Android maskable/any
 *   public/icon-512.png        Android splash + store listing
 *   public/apple-touch-icon.png (180) iOS home screen
 *   public/favicon-32.png      desktop tab
 *
 * Pure Node (zlib only), so it runs anywhere `npm ci` runs and the output is
 * reproducible. Re-run with `node scripts/generate-icons.mjs` after editing
 * public/icon.svg's motif so the two stay in sync.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const NAVY = [15, 23, 42]; // #0f172a
const SKY = [56, 189, 248]; // #38bdf8
const AMBER = [250, 204, 21]; // #facc15

/** Signed distance from point p to segment ab, for anti-aliased strokes. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function mix(base, over, alpha) {
  return [
    Math.round(base[0] + (over[0] - base[0]) * alpha),
    Math.round(base[1] + (over[1] - base[1]) * alpha),
    Math.round(base[2] + (over[2] - base[2]) * alpha),
  ];
}

function render(size) {
  const s = size / 512;
  const radius = 112 * s;
  const stroke = 34 * s;
  // Pulse polyline in the 512 design space, scaled to `size`.
  const pts = [
    [64, 296],
    [148, 296],
    [188, 168],
    [240, 376],
    [284, 244],
    [314, 320],
    [448, 320],
  ].map(([x, y]) => [x * s, y * s]);
  const dot = { x: 404 * s, y: 320 * s, r: 24 * s };

  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Rounded-rect mask (navy tile) with 1px feather.
      const rx = Math.max(radius - x, x - (size - radius), 0);
      const ry = Math.max(radius - y, y - (size - radius), 0);
      const corner = Math.hypot(rx, ry);
      const inside = corner <= radius ? 1 : Math.max(0, 1 - (corner - radius));
      let rgb = NAVY;
      let a = inside;

      if (a > 0) {
        // Pulse stroke.
        let dMin = Infinity;
        for (let i = 0; i < pts.length - 1; i++) {
          const d = distToSegment(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
          if (d < dMin) dMin = d;
        }
        const strokeA = Math.max(0, Math.min(1, stroke / 2 - dMin + 0.5));
        if (strokeA > 0) rgb = mix(rgb, SKY, strokeA);

        // Amber dot.
        const dotA = Math.max(0, Math.min(1, dot.r - Math.hypot(x - dot.x, y - dot.y) + 0.5));
        if (dotA > 0) rgb = mix(rgb, AMBER, dotA);
      }

      const o = (y * size + x) * 4;
      buf[o] = rgb[0];
      buf[o + 1] = rgb[1];
      buf[o + 2] = rgb[2];
      buf[o + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

// --- minimal PNG encoder (RGBA, 8-bit, no interlace) -------------------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(rgba, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  // 10-12 default (deflate, adaptive filter, no interlace)

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const targets = [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
  ["favicon-32.png", 32],
];

for (const [name, size] of targets) {
  const png = encodePng(render(size), size);
  writeFileSync(join(OUT, name), png);
  console.log(`  ${name}  ${size}x${size}  ${(png.length / 1024).toFixed(1)} kB`);
}
console.log("icons written to public/");
