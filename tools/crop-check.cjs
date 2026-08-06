/**
 * crop-check.cjs - render a close-up of one place on the map, source artwork
 * beside the traced result, so a suspected mistake can actually be looked at.
 *
 * Usage: node tools/crop-check.cjs <lon> <lat> <spanDegrees> <out.png>
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const png = require('./png.cjs');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const [lon0, lat0, span, outName] = [
  parseFloat(process.argv[2]), parseFloat(process.argv[3]),
  parseFloat(process.argv[4]), process.argv[5] || 'crop.png',
];

const meta = JSON.parse(fs.readFileSync(path.join(BUILD, 'regions-final.json'), 'utf8'));
const labelled = JSON.parse(fs.readFileSync(path.join(BUILD, 'labelled.json'), 'utf8'));
const labels = new Uint16Array(zlib.gunzipSync(fs.readFileSync(path.join(BUILD, 'labels-final.u16.gz'))).buffer);
const cls = new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(BUILD, 'classes.u8.gz'))).buffer);
const W = meta.width, H = meta.height;

const xOf = (lon) => Math.round(((lon + 180) / 360) * W);
const yOf = (lat) => Math.round(((90 - lat) / 180) * H);
const x0 = xOf(lon0 - span / 2), x1 = xOf(lon0 + span / 2);
const y0 = yOf(lat0 + span / 4), y1 = yOf(lat0 - span / 4);
const cw = x1 - x0, ch = y1 - y0;

function hueOf(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }
function hsv(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const t = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
          : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(t[0] + m) * 255 | 0, (t[1] + m) * 255 | 0, (t[2] + m) * 255 | 0];
}
const colour = new Map();
for (const [id, a] of Object.entries(labelled.assignment)) {
  colour.set(+id, hsv(hueOf(a.name), 0.55, a.name.charCodeAt(0) % 2 ? 0.95 : 0.7));
}

const GAP = 12;
const OW = cw * 2 + GAP, OH = ch;
const rgb = new Uint8Array(OW * OH * 3);
for (let y = 0; y < ch; y++) {
  for (let x = 0; x < cw; x++) {
    const sx = x0 + x, sy = y0 + y;
    const inside = sx >= 0 && sx < W && sy >= 0 && sy < H;
    const p = inside ? sy * W + sx : -1;

    // left panel: the source artwork
    let a = [8, 12, 18];
    if (inside) a = cls[p] === 0 ? [255, 255, 255] : cls[p] === 1 ? [218, 218, 218] : [40, 40, 40];
    let o = (y * OW + x) * 3;
    rgb[o] = a[0]; rgb[o + 1] = a[1]; rgb[o + 2] = a[2];

    // right panel: what the trace made of it
    let b = [8, 12, 18];
    if (inside) {
      const id = labels[p];
      b = !id ? [255, 255, 255] : (colour.get(id) || [255, 0, 170]);
    }
    o = (y * OW + (cw + GAP) + x) * 3;
    rgb[o] = b[0]; rgb[o + 1] = b[1]; rgb[o + 2] = b[2];
  }
}
png.writeRGB(path.join(BUILD, outName), OW, OH, rgb);

// What is actually here?
const seen = new Map();
for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
  for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
    const id = labels[y * W + x];
    if (id) seen.set(id, (seen.get(id) || 0) + 1);
  }
}
console.log(`${outName}  lon ${lon0} lat ${lat0} span ${span}deg  -> ${cw}x${ch} px per panel`);
for (const [id, n] of [...seen].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  const a = labelled.assignment[id];
  console.log(`   region ${String(id).padStart(3)}  ${String(n).padStart(7)} px here  ${a ? a.name + ' (' + a.confidence + ')' : 'UNASSIGNED'}`);
}
