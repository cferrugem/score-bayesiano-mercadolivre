// Gera os PNGs do ícone a partir da mesma geometria do logo.svg.
// Sem dependências: rasteriza por supersampling e escreve o PNG com o zlib do Node.
//   node icons/build-icons.cjs
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// ---- geometria (espaço 128x128, igual ao viewBox do logo.svg) ---------------
const YELLOW = [0xff, 0xe6, 0x00]; // amarelo do Mercado Livre
const INK = [0x16, 0x18, 0x1d];
const BG = { x: 0, y: 0, w: 128, h: 128, r: 28 };
const BASE = { x: 13, y: 86, w: 102, h: 8, r: 4 };
// Curva assimétrica: cauda longa à esquerda, pico à direita — o score bayesiano
// puxa a nota crua para baixo, em direção ao prior.
const CURVE = [
  [[13, 90], [53, 90], [60, 39], [78, 39]],
  [[78, 39], [94, 39], [101, 90], [115, 90]],
];

function flatten(curves, steps = 160) {
  const pts = [];
  for (const [p0, p1, p2, p3] of curves) {
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
      pts.push([
        a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
        a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
      ]);
    }
  }
  return pts;
}

const CURVE_POLY = flatten(CURVE);

function inPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundRect(px, py, { x, y, w, h, r }) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

// ---- rasterização ----------------------------------------------------------
const SS = 6; // 6x6 amostras por pixel => 36 níveis de antialiasing

function raster(size) {
  const buf = Buffer.alloc(size * size * 4);
  const scale = 128 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let cover = 0, ink = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * scale;
          const y = (py + (sy + 0.5) / SS) * scale;
          if (!inRoundRect(x, y, BG)) continue;
          cover++;
          if (inRoundRect(x, y, BASE) || inPolygon(x, y, CURVE_POLY)) ink++;
        }
      }
      const o = (py * size + px) * 4;
      if (!cover) continue;
      // A tinta fica sempre dentro do fundo, então o alpha vem só da cobertura do fundo.
      const t = ink / cover;
      for (let k = 0; k < 3; k++) buf[o + k] = Math.round(YELLOW[k] * (1 - t) + INK[k] * t);
      buf[o + 3] = Math.round((cover / (SS * SS)) * 255);
    }
  }
  return buf;
}

// ---- PNG -------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filtro "none"
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const file = path.join(__dirname, `icon${size}.png`);
  fs.writeFileSync(file, png(size, raster(size)));
  console.log(`icon${size}.png  ${fs.statSync(file).size} bytes`);
}
