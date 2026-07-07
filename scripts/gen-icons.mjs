#!/usr/bin/env node
// Generates icons/icon{16,32,48,128}.png with zero dependencies: shapes are
// rasterized with supersampled coverage tests and encoded as PNG via
// node:zlib. Run: node scripts/gen-icons.mjs

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(outDir, { recursive: true });

/* ---------- scene, in unit coordinates ---------- */

const BLUE_TOP = [47, 141, 240];
const BLUE_BOTTOM = [21, 89, 198];
const LENS_BLUE = [26, 95, 208];
const LENS_LIGHT = [122, 180, 245];
const WHITE = [255, 255, 255];

function roundedRect(px, py, x, y, w, h, r) {
  const qx = Math.max(Math.abs(px - (x + w / 2)) - (w / 2 - r), 0);
  const qy = Math.max(Math.abs(py - (y + h / 2)) - (h / 2 - r), 0);
  return Math.hypot(qx, qy) <= r;
}

function circle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) <= r;
}

function triangle(px, py, ax, ay, bx, by, cx, cy) {
  const sign = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cx, cy);
  const d3 = sign(px, py, cx, cy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// Returns [r,g,b,a] for a point in the unit square.
function shade(x, y) {
  if (!roundedRect(x, y, 0.02, 0.02, 0.96, 0.96, 0.2)) return [0, 0, 0, 0];

  // background gradient
  const t = Math.min(1, Math.max(0, y));
  let col = [
    BLUE_TOP[0] + (BLUE_BOTTOM[0] - BLUE_TOP[0]) * t,
    BLUE_TOP[1] + (BLUE_BOTTOM[1] - BLUE_TOP[1]) * t,
    BLUE_TOP[2] + (BLUE_BOTTOM[2] - BLUE_TOP[2]) * t,
  ];

  const white =
    roundedRect(x, y, 0.18, 0.22, 0.64, 0.38, 0.06) ||       // camera body
    roundedRect(x, y, 0.38, 0.14, 0.24, 0.12, 0.04) ||        // viewfinder bump
    roundedRect(x, y, 0.465, 0.64, 0.07, 0.14, 0.02) ||       // arrow stem
    triangle(x, y, 0.32, 0.76, 0.68, 0.76, 0.5, 0.92);        // arrow head

  if (white) col = WHITE;

  // lens rings drawn over the body
  if (circle(x, y, 0.5, 0.41, 0.125)) col = LENS_BLUE;
  if (circle(x, y, 0.5, 0.41, 0.07)) col = LENS_LIGHT;
  if (circle(x, y, 0.465, 0.375, 0.02)) col = WHITE;          // lens glint

  return [col[0], col[1], col[2], 255];
}

/* ---------- rasterize with 4x4 supersampling ---------- */

function renderRgba(size) {
  const out = new Uint8Array(size * size * 4);
  const SS = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const [cr, cg, cb, ca] = shade(x, y);
          // premultiply while accumulating so edges blend correctly
          r += cr * (ca / 255);
          g += cg * (ca / 255);
          b += cb * (ca / 255);
          a += ca;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const i = (py * size + px) * 4;
      out[i] = alpha ? Math.round(r / n / (alpha / 255)) : 0;
      out[i + 1] = alpha ? Math.round(g / n / (alpha / 255)) : 0;
      out[i + 2] = alpha ? Math.round(b / n / (alpha / 255)) : 0;
      out[i + 3] = Math.round(alpha);
    }
  }
  return out;
}

/* ---------- PNG encoding ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  // compression, filter, interlace = 0

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, renderRgba(size));
  const file = join(outDir, `icon${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
