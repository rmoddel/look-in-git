import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'artifacts', 'electron-icons');
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type), size = Buffer.alloc(4), check = Buffer.alloc(4); size.writeUInt32BE(data.length); check.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, check]); }
function iconPng(size) {
  const pixels = Buffer.alloc(size * size * 4), scale = size / 1024;
  const lineDistance = (x, y, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - ax - t * dx, y - ay - t * dy); };
  const point = (x, y, cx, cy) => Math.hypot(x - cx, y - cy), bg = [231, 117, 83, 255], white = [255, 255, 255, 255];
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    const x = (px + .5) / scale, y = (py + .5) / scale;
    const dx = Math.max(56 - x, 0, x - 968), dy = Math.max(56 - y, 0, y - 968);
    let color = dx * dx + dy * dy <= 190 * 190 ? bg : [0, 0, 0, 0];
    if (lineDistance(x, y, 330, 310, 330, 710) < 31 || lineDistance(x, y, 330, 512, 690, 310) < 31 || point(x, y, 330, 280) < 72 || point(x, y, 330, 744) < 72 || point(x, y, 690, 280) < 72) color = white;
    pixels.set(color, (py * size + px) * 4);
  }
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

await mkdir(output, { recursive: true });
const png = iconPng(256), icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(1, 4); icoHeader.writeUInt16LE(1, 10); icoHeader.writeUInt16LE(32, 12); icoHeader.writeUInt32LE(png.length, 14); icoHeader.writeUInt32LE(22, 18);
await writeFile(path.join(output, 'look-in-git.ico'), Buffer.concat([icoHeader, png]));
const pieces = [[128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']].map(([size, type]) => {
  const data = iconPng(size), header = Buffer.alloc(8); header.write(type, 0, 4, 'ascii'); header.writeUInt32BE(data.length + 8, 4); return Buffer.concat([header, data]);
});
const icnsHeader = Buffer.alloc(8); icnsHeader.write('icns', 0, 4, 'ascii'); icnsHeader.writeUInt32BE(8 + pieces.reduce((total, part) => total + part.length, 0), 4);
await writeFile(path.join(output, 'look-in-git.icns'), Buffer.concat([icnsHeader, ...pieces]));
console.log(`Generated native icons in ${output}`);
