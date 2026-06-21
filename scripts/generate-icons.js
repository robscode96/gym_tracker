// Generates PWA icons (a dumbbell mark on a slate gradient) as PNGs with no
// external dependencies — draws into an RGBA buffer with 3x supersampling and
// encodes via Node's built-in zlib. Run with: npm run generate-icons
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

const lerp = (a, b, t) => a + (b - a) * t;
const lerpColor = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

const BG_TOP = [30, 41, 59];   // slate-800
const BG_BOTTOM = [15, 23, 42]; // slate-900
const AMBER_TOP = [251, 191, 36];
const AMBER_BOTTOM = [245, 158, 11];

function setPx(buf, N, x, y, r, g, b, a) {
  const i = (y * N + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
}

function insideRoundRect(px, py, x0, y0, w, h, r) {
  const x1 = x0 + w, y1 = y0 + h;
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function fillRoundRect(buf, N, x0, y0, w, h, r, colorFn) {
  const xs = Math.max(0, Math.floor(x0));
  const ys = Math.max(0, Math.floor(y0));
  const xe = Math.min(N, Math.ceil(x0 + w));
  const ye = Math.min(N, Math.ceil(y0 + h));
  for (let y = ys; y < ye; y++) {
    for (let x = xs; x < xe; x++) {
      if (insideRoundRect(x + 0.5, y + 0.5, x0, y0, w, h, r)) {
        const [cr, cg, cb, ca] = colorFn(x, y);
        setPx(buf, N, x, y, cr, cg, cb, ca);
      }
    }
  }
}

function drawDumbbell(buf, N, scale) {
  const total = scale * N;
  const cx = N / 2, cy = N / 2;
  const x0 = cx - total / 2;
  const top = cy - 0.31 * total;
  const dumbColor = (x, y) => {
    const t = Math.min(1, Math.max(0, (y - top) / (0.62 * total)));
    return [...lerpColor(AMBER_TOP, AMBER_BOTTOM, t).map(Math.round), 255];
  };

  const barH = 0.16 * total;
  fillRoundRect(buf, N, x0, cy - barH / 2, total, barH, barH / 2, dumbColor);

  const innerH = 0.62 * total, innerW = 0.135 * total;
  const outerH = 0.42 * total, outerW = 0.10 * total;
  // Left side
  fillRoundRect(buf, N, x0 - innerW * 0.2, cy - innerH / 2, innerW, innerH, innerW * 0.32, dumbColor);
  fillRoundRect(buf, N, x0 - innerW * 0.2 - outerW, cy - outerH / 2, outerW, outerH, outerW * 0.35, dumbColor);
  // Right side
  const rx = x0 + total - innerW * 0.8;
  fillRoundRect(buf, N, rx, cy - innerH / 2, innerW, innerH, innerW * 0.32, dumbColor);
  fillRoundRect(buf, N, rx + innerW, cy - outerH / 2, outerW, outerH, outerW * 0.35, dumbColor);
}

function renderIcon(size, { maskable = false } = {}) {
  const ss = 3;
  const N = size * ss;
  const buf = new Uint8Array(N * N * 4); // transparent by default
  const radius = maskable ? 0 : N * 0.22;
  fillRoundRect(buf, N, 0, 0, N, N, radius, (x, y) => [...lerpColor(BG_TOP, BG_BOTTOM, y / N).map(Math.round), 255]);
  drawDumbbell(buf, N, maskable ? 0.6 : 0.74);

  // Downsample ss x ss -> size
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const i = ((y * ss + dy) * N + (x * ss + dx)) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const n = ss * ss;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ---- Minimal PNG encoder ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  // 10,11,12 = 0 (compression, filter, interlace)
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // no filter
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function write(name, size, opts) {
  const png = encodePng(renderIcon(size, opts), size);
  fs.writeFileSync(path.join(OUT_DIR, name), png);
  console.log(`  ${name}  (${size}x${size}, ${(png.length / 1024).toFixed(1)} KB)`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
console.log('Generating icons:');
write('icon-192.png', 192);
write('icon-512.png', 512);
write('maskable-512.png', 512, { maskable: true });
write('apple-touch-icon.png', 180, { maskable: true });
write('favicon-32.png', 32);
console.log('Done.');
