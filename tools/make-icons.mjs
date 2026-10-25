// Vygeneruje PNG ikonky (modré pozadie, biely autobus) bez externých knižníc.
import fs from 'node:fs';
import zlib from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}

const inRRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

// Farba v bode (u,v ∈ 0..1)
function color(u, v) {
  const BLUE = [14, 90, 167], WHITE = [255, 255, 255], DARK = [20, 33, 61], YEL = [255, 200, 40];
  let c = BLUE;
  if (inRRect(u, v, 0.2, 0.2, 0.8, 0.72, 0.07)) c = WHITE;                 // karoséria
  if (inRRect(u, v, 0.26, 0.28, 0.74, 0.48, 0.035)) c = DARK;              // okno
  if (inRRect(u, v, 0.26, 0.6, 0.34, 0.66, 0.02)) c = YEL;                 // svetlá
  if (inRRect(u, v, 0.66, 0.6, 0.74, 0.66, 0.02)) c = YEL;
  if (inCircle(u, v, 0.32, 0.74, 0.07)) c = DARK;                          // kolesá
  if (inCircle(u, v, 0.68, 0.74, 0.07)) c = DARK;
  return c;
}

function png(size) {
  const SS = 3;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = color((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
      }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(acc[i] / (SS * SS));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const s of [180, 192, 512]) fs.writeFileSync(new URL(`../app/icons/icon-${s}.png`, import.meta.url), png(s));
console.log('Ikonky hotové.');
