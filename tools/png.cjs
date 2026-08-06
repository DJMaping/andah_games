/**
 * Minimal PNG decode/encode for the Andah map pipeline.
 *
 * Handles exactly what the pipeline needs and nothing more: non-interlaced
 * 8-bit images (palette, greyscale, RGB, RGBA) in, 8-bit RGB out. Written by
 * hand so the pipeline pulls in no runtime dependencies, matching the rest of
 * the site.
 */
const fs = require('fs');
const zlib = require('zlib');

const CT_GREY = 0, CT_RGB = 2, CT_PALETTE = 3, CT_GREYA = 4, CT_RGBA = 6;
const CHANNELS = { [CT_GREY]: 1, [CT_RGB]: 3, [CT_PALETTE]: 1, [CT_GREYA]: 2, [CT_RGBA]: 4 };

/** Decode a PNG file into { w, h, ct, bpp, px, plte }. `px` is raw samples. */
function decode(path) {
  const buf = fs.readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`);

  let i = 8, ihdr = null, plte = null;
  const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') {
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), bd: data[8], ct: data[9], interlace: data[12] };
    } else if (type === 'PLTE') plte = Buffer.from(data);
    else if (type === 'IDAT') idat.push(data);
    i += 12 + len;
    if (type === 'IEND') break;
  }
  if (!ihdr) throw new Error(`${path}: no IHDR`);
  const { w, h, bd, ct, interlace } = ihdr;
  if (bd !== 8) throw new Error(`${path}: bit depth ${bd} unsupported (need 8)`);
  if (interlace) throw new Error(`${path}: interlaced PNGs unsupported`);

  const bpp = CHANNELS[ct];
  if (!bpp) throw new Error(`${path}: colour type ${ct} unsupported`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rowBytes = w * bpp;
  const stride = rowBytes + 1;
  if (raw.length < h * stride) throw new Error(`${path}: truncated image data`);

  const px = new Uint8Array(w * h * bpp);
  let prev = new Uint8Array(rowBytes);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * stride];
    const row = raw.subarray(y * stride + 1, y * stride + 1 + rowBytes);
    const out = px.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      const r = row[x];
      let v;
      switch (filter) {
        case 0: v = r; break;
        case 1: v = r + a; break;
        case 2: v = r + b; break;
        case 3: v = r + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`${path}: bad filter ${filter} on row ${y}`);
      }
      out[x] = v & 255;
    }
    prev = out;
  }
  return { w, h, ct, bpp, px, plte };
}

/** Palette index -> [r,g,b]. Only meaningful for colour type 3. */
function paletteColour(img, idx) {
  return [img.plte[idx * 3], img.plte[idx * 3 + 1], img.plte[idx * 3 + 2]];
}

/** Count occurrences of each palette index, descending by count. */
function paletteHistogram(img) {
  if (img.ct !== CT_PALETTE) throw new Error('paletteHistogram needs a palette image');
  const counts = new Float64Array(256);
  for (let k = 0; k < img.w * img.h; k++) counts[img.px[k]]++;
  const out = [];
  for (let idx = 0; idx < 256; idx++) {
    if (counts[idx]) out.push({ idx, count: counts[idx], rgb: paletteColour(img, idx) });
  }
  return out.sort((a, b) => b.count - a.count);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4, 0, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** Write an 8-bit RGB PNG. `rgb` is a w*h*3 byte array. */
function writeRGB(path, w, h, rgb) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    raw[o] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, o + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = CT_RGB;
  fs.writeFileSync(path, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

module.exports = { decode, writeRGB, paletteColour, paletteHistogram, CT_PALETTE };
