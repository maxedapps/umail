import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 512;
const BURGUNDY = [122, 37, 48, 255];
const BURGUNDY_DARK = [88, 23, 32, 255];
const CREAM = [255, 250, 240, 255];

function crcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([length, crcInput, crc]);
}

function encodePng(pixels, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function circleCoverage(x, y, cx, cy, radius) {
  const distance = Math.hypot(x - cx, y - cy);
  return clamp01(radius + 0.65 - distance);
}

function roundedRectCoverage(x, y, left, top, right, bottom, radius) {
  const cx = clamp(x, left + radius, right - radius);
  const cy = clamp(y, top + radius, bottom - radius);
  if (x >= left + radius && x <= right - radius && y >= top + radius && y <= bottom - radius) {
    return 1;
  }
  if (x >= left + radius && x <= right - radius) {
    if (y >= top && y <= bottom) return 1;
    return clamp01(0.65 - Math.abs(y < top ? top - y : y - bottom));
  }
  if (y >= top + radius && y <= bottom - radius) {
    if (x >= left && x <= right) return 1;
    return clamp01(0.65 - Math.abs(x < left ? left - x : x - right));
  }
  return circleCoverage(x, y, cx, cy, radius);
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function triangleCoverage(x, y, ax, ay, bx, by, cx, cy) {
  const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  const w0 = ((bx - x) * (cy - y) - (cx - x) * (by - y)) / area;
  const w1 = ((cx - x) * (ay - y) - (ax - x) * (cy - y)) / area;
  const w2 = 1 - w0 - w1;
  const min = Math.min(w0, w1, w2);
  if (min >= 0) return 1;
  const edge = signedEdgeDistance(x, y, ax, ay, bx, by, cx, cy);
  return clamp01(0.65 - edge);
}

function signedEdgeDistance(x, y, ax, ay, bx, by, cx, cy) {
  return Math.min(
    pointSegmentDistance(x, y, ax, ay, bx, by),
    pointSegmentDistance(x, y, bx, by, cx, cy),
    pointSegmentDistance(x, y, cx, cy, ax, ay),
  );
}

function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / length, 0, 1);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function overlay(dst, src, coverage) {
  if (coverage <= 0) return dst;
  const t = coverage * (src[3] / 255);
  const outA = src[3] * t + dst[3] * (1 - t);
  if (outA === 0) return [0, 0, 0, 0];
  return [
    Math.round((src[0] * src[3] * t + dst[0] * dst[3] * (1 - t)) / outA),
    Math.round((src[1] * src[3] * t + dst[1] * dst[3] * (1 - t)) / outA),
    Math.round((src[2] * src[3] * t + dst[2] * dst[3] * (1 - t)) / outA),
    Math.round(outA),
  ];
}

function paintIcon() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const cx = (SIZE - 1) / 2;
  const cy = (SIZE - 1) / 2;
  const outer = SIZE * 0.46;
  const inner = SIZE * 0.42;
  const bodyLeft = SIZE * 0.27;
  const bodyRight = SIZE * 0.73;
  const bodyTop = SIZE * 0.4;
  const bodyBottom = SIZE * 0.7;
  const radius = SIZE * 0.045;
  const flapPeakX = cx;
  const flapPeakY = SIZE * 0.31;
  const flapLeftX = bodyLeft;
  const flapRightX = bodyRight;
  const flapBaseY = SIZE * 0.48;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let color = [0, 0, 0, 0];
      color = overlay(color, BURGUNDY_DARK, circleCoverage(px, py, cx, cy, outer));
      color = overlay(color, BURGUNDY, circleCoverage(px, py, cx, cy, inner));
      color = overlay(
        color,
        CREAM,
        roundedRectCoverage(px, py, bodyLeft, bodyTop, bodyRight, bodyBottom, radius),
      );
      color = overlay(
        color,
        CREAM,
        triangleCoverage(px, py, flapLeftX, flapBaseY, flapPeakX, flapPeakY, flapRightX, flapBaseY),
      );
      color = overlay(
        color,
        BURGUNDY,
        Math.min(
          triangleCoverage(
            px,
            py,
            flapLeftX + SIZE * 0.035,
            flapBaseY - SIZE * 0.012,
            flapPeakX,
            flapPeakY + SIZE * 0.055,
            flapRightX - SIZE * 0.035,
            flapBaseY - SIZE * 0.012,
          ),
          0.92,
        ),
      );
      const offset = (y * SIZE + x) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3];
    }
  }
  return pixels;
}

const png = encodePng(paintIcon(), SIZE);
const here = dirname(fileURLToPath(import.meta.url));
const brandDir = join(here, "..", "apps", "server", "src", "api", "brand");
writeFileSync(join(brandDir, "icon.png"), png);
writeFileSync(
  join(brandDir, "icon-bytes.ts"),
  `// Generated by scripts/generate-agentmail-icon.mjs. Do not edit by hand.

const PNG_BASE64 =
  "${png.toString("base64")}";

export const AGENTMAIL_ICON_PNG = Uint8Array.from(atob(PNG_BASE64), (char) =>
  char.charCodeAt(0),
);
`,
);

console.log(`wrote ${png.length} byte AgentMail icon`);
