/**
 * region-zoom.cjs - magnify one traced region so its border artwork can be
 * inspected pixel by pixel, source beside result.
 *
 * Usage: node tools/region-zoom.cjs <regionId> <magnification> <out.png>
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const png = require('./png.cjs');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const ID = Number(process.argv[2]);
const MAG = Number(process.argv[3] || 6);
const OUT = process.argv[4] || `region-${ID}.png`;

const pre = JSON.parse(fs.readFileSync(path.join(BUILD, 'regions.json'), 'utf8'));
const labelled = JSON.parse(fs.readFileSync(path.join(BUILD, 'labelled.json'), 'utf8'));
const before = new Uint16Array(zlib.gunzipSync(fs.readFileSync(path.join(BUILD, 'labels.u16.gz'))).buffer);
const after = new Uint16Array(zlib.gunzipSync(fs.readFileSync(path.join(BUILD, 'labels-final.u16.gz'))).buffer);
const cls = new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(BUILD, 'classes.u8.gz'))).buffer);
const W = pre.width, H = pre.height;
const r = pre.regions.find((x) => x.id === ID);
if (!r) throw new Error(`no region ${ID}`);

const PAD = 4;
const x0 = Math.max(0, r.bbox[0] - PAD), y0 = Math.max(0, r.bbox[1] - PAD);
const x1 = Math.min(W - 1, r.bbox[2] + PAD), y1 = Math.min(H - 1, r.bbox[3] + PAD);
const cw = x1 - x0 + 1, ch = y1 - y0 + 1;

const anchorSrc = fs.readFileSync(path.join(ROOT, 'js', 'andah-map-coords.js'), 'utf8');
const anchors = JSON.parse(anchorSrc.slice(anchorSrc.indexOf('['), anchorSrc.lastIndexOf(']') + 1));
const { bx, by } = labelled.alignment;

function hueOf(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }
function hsv(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const t = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
          : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(t[0] + m) * 255 | 0, (t[1] + m) * 255 | 0, (t[2] + m) * 255 | 0];
}
const colourOf = new Map();
for (const [id, a] of Object.entries(labelled.assignment)) colourOf.set(+id, hsv(hueOf(a.name), 0.6, 0.9));

const GAP = 8;
const OW = (cw * 2 + GAP) * MAG, OH = ch * MAG;
const rgb = new Uint8Array(OW * OH * 3);
const put = (px, py, c) => {
  for (let dy = 0; dy < MAG; dy++) for (let dx = 0; dx < MAG; dx++) {
    const o = ((py * MAG + dy) * OW + px * MAG + dx) * 3;
    rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
  }
};
for (let y = 0; y < ch; y++) {
  for (let x = 0; x < cw; x++) {
    const p = (y0 + y) * W + (x0 + x);
    const mine = before[p] === ID;
    // left: the artwork. Border pixels of this region in red so gaps show up.
    let a;
    if (cls[p] === 0) a = [255, 255, 255];
    else if (cls[p] === 2) a = mine ? [230, 30, 30] : [120, 120, 120];
    else a = mine ? [214, 224, 234] : [170, 170, 170];
    put(x, y, a);
    // right: what the split decided
    const id = after[p];
    put(cw + GAP + x, y, !id ? [255, 255, 255] : (colourOf.get(id) || [60, 60, 60]));
  }
}
// anchors that fall in this box
for (const an of anchors) {
  const ax = an.x + bx - x0, ay = an.y + by - y0;
  if (ax < 0 || ay < 0 || ax >= cw || ay >= ch) continue;
  for (let d = -3; d <= 3; d++) {
    for (const [px, py] of [[ax + d, ay], [ax, ay + d]]) {
      if (px < 0 || py < 0 || px >= cw || py >= ch) continue;
      put(px, py, [0, 0, 0]);
      put(cw + GAP + px, py, [0, 0, 0]);
    }
  }
  console.log(`   anchor ${an.name} at (${ax},${ay}) in this box`);
}
png.writeRGB(path.join(BUILD, OUT), OW, OH, rgb);
console.log(`${OUT}: region ${ID}, ${cw}x${ch} px at ${MAG}x -> ${OW}x${OH}`);
