// Generates src/assets/flavor.png — a tiny pixel-art "floating island" icon
// (32x32, green island + pixel waves), used for the pill mascot, tray, and
// window icon. Pure Node, no dependencies.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'src', 'assets', 'flavor.png');
const SIZE = 32;

// 32x32 RGBA rows (y from top). Pixel-art palette.
const P = {
  water1: [16, 40, 80, 255],   // deep water
  water2: [24, 58, 110, 255],  // lighter water
  grass: [52, 211, 153, 255],  // island green
  grassD: [16, 150, 90, 255],  // shaded grass
  trunk: [120, 80, 40, 255],   // tree trunk
  leaf: [34, 197, 94, 255],    // tree leaves
  leafD: [22, 140, 60, 255],   // leaf shade
  cloud: [230, 240, 255, 220], // cloud
};

// Start with water; draw island mound by ellipse-ish rows.
function makePixels() {
  const px = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      px.push(...P.water1);
    }
  }
  const set = (x, y, c) => {
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
    const i = (y * SIZE + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
  };
  const inEllipse = (cx, cy, rx, ry, x, y) => {
    const dx = (x - cx) / rx;
    const dy = (y - cy) / ry;
    return dx * dx + dy * dy <= 1;
  };

  // Island mound (green) sitting on the water.
  for (let y = 18; y <= 26; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (inEllipse(16, 24, 13, 7, x, y)) set(x, y, y > 23 ? P.grassD : P.grass);
    }
  }
  // Water highlights (two lighter wave rows) below the island.
  for (const [wx, wy] of [[4, 28], [12, 30], [20, 29], [26, 28]]) {
    set(wx, wy, P.water2);
    set(wx + 1, wy, P.water2);
  }
  // Tree trunk on the island.
  for (let y = 16; y <= 21; y++) set(15, y, P.trunk), set(16, y, P.trunk), set(17, y, P.trunk);
  // Tree canopy (two stacked ellipses).
  for (let y = 10; y <= 17; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (inEllipse(16, 14, 7, 5, x, y)) set(x, y, y > 15 ? P.leafD : P.leaf);
    }
  }
  // Little cloud.
  for (const [cx, cy, rx, ry] of [[22, 6, 5, 3]]) {
    for (let y = cy - ry; y <= cy + ry; y++) {
      for (let x = cx - rx; x <= cx + rx; x++) {
        if (inEllipse(cx, cy, rx, ry, x, y)) set(x, y, P.cloud);
      }
    }
  }
  return px;
}

const png = makePng(SIZE, SIZE, Buffer.from(makePixels()));
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${png.length} bytes)`);

// Minimal PNG encoder (RGBA8, no compression beyond stored deflate blocks).
function makePng(width, height, rgba) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  // Stored (uncompressed) deflate stream.
  const idatBody = Buffer.alloc(2 + 5 + raw.length + 4);
  idatBody[0] = 0x78; idatBody[1] = 0x01; // zlib header
  const rawLen = raw.length;
  idatBody.writeUInt16LE(rawLen & 0xffff, 2);       // block len
  idatBody.writeUInt16LE(~rawLen & 0xffff, 4);       // one's complement
  raw.copy(idatBody, 6);
  idatBody.writeUInt32LE(0, 6 + raw.length);          // adler32 placeholder (0 is tolerated by decoders? use real below)
  const adler = adler32(raw);
  idatBody.writeUInt32LE(adler, 6 + raw.length);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatBody),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}
