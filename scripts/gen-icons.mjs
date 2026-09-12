// Generates the app icon and tray icons as PNGs without any image library.
// Run once: `node scripts/gen-icons.mjs` (outputs are committed).
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Draws a round blob with two ears and eyes; `mono` yields a black silhouette (macOS template). */
function drawBlob(size, mono) {
  const px = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size * 0.56;
  const r = size * 0.36;
  const earR = size * 0.13;
  const ears = [
    [cx - r * 0.62, cy - r * 0.85],
    [cx + r * 0.62, cy - r * 0.85],
  ];
  const eyes = [
    [cx - r * 0.35, cy - r * 0.1],
    [cx + r * 0.35, cy - r * 0.1],
  ];
  const eyeR = size * 0.05;
  const body = mono ? [0, 0, 0] : [255, 166, 130];
  const outline = mono ? [0, 0, 0] : [214, 120, 88];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      let inside = Math.hypot(dx, dy) <= r;
      let edge = !inside && Math.hypot(dx, dy) <= r + size * 0.02;
      for (const [ex, ey] of ears) {
        const d = Math.hypot(x + 0.5 - ex, y + 0.5 - ey);
        if (d <= earR) inside = true;
        else if (d <= earR + size * 0.02 && !inside) edge = true;
      }
      const i = (y * size + x) * 4;
      if (inside) {
        let color = body;
        let alpha = 255;
        if (!mono) {
          for (const [ex, ey] of eyes) if (Math.hypot(x + 0.5 - ex, y + 0.5 - ey) <= eyeR) color = [40, 30, 30];
        } else {
          for (const [ex, ey] of eyes) if (Math.hypot(x + 0.5 - ex, y + 0.5 - ey) <= eyeR) alpha = 0;
        }
        px[i] = color[0];
        px[i + 1] = color[1];
        px[i + 2] = color[2];
        px[i + 3] = alpha;
      } else if (edge) {
        px[i] = outline[0];
        px[i + 1] = outline[1];
        px[i + 2] = outline[2];
        px[i + 3] = 255;
      }
    }
  }
  return px;
}

mkdirSync(join(root, "assets", "tray"), { recursive: true });
writeFileSync(join(root, "assets", "icon.png"), encodePng(512, 512, drawBlob(512, false)));
writeFileSync(join(root, "assets", "tray", "trayTemplate.png"), encodePng(22, 22, drawBlob(22, true)));
writeFileSync(join(root, "assets", "tray", "trayTemplate@2x.png"), encodePng(44, 44, drawBlob(44, true)));
writeFileSync(join(root, "assets", "tray", "tray.png"), encodePng(32, 32, drawBlob(32, false)));
console.log("icons written to assets/");
