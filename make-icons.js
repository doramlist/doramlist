/* Генератор иконок PWA.
   Внешних зависимостей нет: PNG собирается вручную (IHDR/IDAT/IEND + zlib),
   фигура растеризуется геометрически по той же форме, что и SVG-фавиконка
   в index.html — скруглённый квадрат #2f80ed и белая «D».

   node make-icons.js
*/
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* ─────────── PNG ─────────── */

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                 /* filter: none */
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;      /* bit depth   */
  ihdr[9] = 6;      /* RGBA        */
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ─────────── фигура в координатах 0..64 ─────────── */

const BLUE = [47, 128, 237];

function inRoundRect(x, y, s, r) {
  if (x < 0 || y < 0 || x > s || y > s) return false;
  const cx = x < r ? r : (x > s - r ? s - r : x);
  const cy = y < r ? r : (y > s - r ? s - r : y);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/* Внешний контур «D»: стойка + верхняя/нижняя перекладины + выпуклая правая часть */
function inGlyph(x, y) {
  if (x >= 18 && x < 28 && y >= 16 && y <= 48) return true;
  if (x >= 18 && x <= 34 && ((y >= 16 && y < 24) || (y > 40 && y <= 48))) return true;
  if (x > 34 && x <= 50) {
    const dx = (x - 34) / 16, dy = (y - 32) / 16;
    return dx * dx + dy * dy <= 1;
  }
  return false;
}

/* Внутренний вырез — тот же контур меньшего размера */
function inGlyphHole(x, y) {
  if (x >= 28 && x <= 34 && y >= 24 && y <= 40) return true;
  if (x > 34 && x <= 42) {
    const dx = (x - 34) / 8, dy = (y - 32) / 8;
    return dx * dx + dy * dy <= 1;
  }
  return false;
}

/**
 * @param {number} size   сторона в пикселях
 * @param {number} inset  0 — во весь холст; >0 — отступ под безопасную зону
 *                        maskable-иконки (Android режет края по кругу)
 * @param {boolean} rounded рисовать скруглённый фон (для maskable — нет)
 */
function render(size, inset, rounded) {
  const SS = 3;                              /* сглаживание: 3×3 на пиксель */
  const buf = Buffer.alloc(size * size * 4);

  /* масштаб фигуры: вписываем 64-ю систему в (size - 2*inset) */
  const box = size - inset * 2;
  const k = box / 64;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS - inset) / k;
          const y = (py + (sy + 0.5) / SS - inset) / k;

          if (rounded && !inRoundRect(x, y, 64, 14)) continue;
          if (inGlyph(x, y) && !inGlyphHole(x, y)) fg++;
          else bg++;
        }
      }
      const n = SS * SS;
      const alpha = (bg + fg) / n;
      if (alpha === 0) continue;

      /* смешиваем белый глиф поверх синего фона по покрытию буквы */
      const cov = fg / n;
      const i = (py * size + px) * 4;
      buf[i]     = Math.round(BLUE[0] * (1 - cov) + 255 * cov);
      buf[i + 1] = Math.round(BLUE[1] * (1 - cov) + 255 * cov);
      buf[i + 2] = Math.round(BLUE[2] * (1 - cov) + 255 * cov);
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, buf);
}

/* ─────────── запись ─────────── */

const outDir = path.join(__dirname, 'icons');
fs.mkdirSync(outDir, { recursive: true });

const files = [
  ['icon-192.png',          render(192, 0, true)],
  ['icon-512.png',          render(512, 0, true)],
  /* maskable: контент вписан в центральные 80%, фон — на весь холст */
  ['icon-maskable-512.png', render(512, Math.round(512 * 0.10), false)],
  ['apple-touch-icon.png',  render(180, 0, false)],
  ['favicon-32.png',        render(32,  0, true)]
];

for (const [name, buf] of files) {
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log(`  ${name.padEnd(24)} ${buf.length} байт`);
}
console.log('готово');