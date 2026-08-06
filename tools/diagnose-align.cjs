/** One-off: work out how maps/map.png actually relates to maps/yap.png. */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const png = require('./png.cjs');
const ROOT = path.resolve(__dirname, '..'), BUILD = path.join(ROOT, 'build');

const meta = JSON.parse(fs.readFileSync(path.join(BUILD, 'regions.json'), 'utf8'));
const W = meta.width, H = meta.height;
const labels = new Uint16Array(zlib.gunzipSync(fs.readFileSync(path.join(BUILD, 'labels.u16.gz'))).buffer);

const mapImg = png.decode(path.join(ROOT, 'maps', 'map.png'));
const mw = mapImg.w, mh = mapImg.h;
const sea = png.paletteHistogram(mapImg)[0].idx;
const mapLand = new Uint8Array(mw * mh);
for (let k = 0; k < mw * mh; k++) mapLand[k] = mapImg.px[k] === sea ? 0 : 1;

console.log(`yap ${W}x${H}   map ${mw}x${mh}`);

/** IoU for yapX = mx + bx, yapY = my + by (strict 1:1 scale). */
function iou1to1(bx, by, step = 4) {
  let inter = 0, uni = 0;
  for (let my = 0; my < mh; my += step) {
    const y = my + by;
    if (y < 0 || y >= H) continue;
    for (let mx = 0; mx < mw; mx += step) {
      const x = mx + bx;
      if (x < 0 || x >= W) continue;
      const a = labels[y * W + x] !== 0 ? 1 : 0;
      const b = mapLand[my * mw + mx];
      if (a | b) { uni++; if (a & b) inter++; }
    }
  }
  return inter / uni;
}

console.log('\n1:1 scale, scanning x offset with y offset fixed at 409:');
let best = { v: -1 };
for (let bx = -200; bx <= W - mw + 200; bx += 4) {
  const v = iou1to1(bx, 409, 8);
  if (v > best.v) best = { v, bx };
}
console.log(`  coarse best bx=${best.bx} IoU ${best.v.toFixed(4)}`);
let fine = { v: -1 };
for (let bx = best.bx - 8; bx <= best.bx + 8; bx++)
  for (let by = 401; by <= 417; by++) {
    const v = iou1to1(bx, by, 4);
    if (v > fine.v) fine = { v, bx, by };
  }
console.log(`  fine   best bx=${fine.bx} by=${fine.by} IoU ${fine.v.toFixed(4)}`);

// Where does yap have land that a 1:1 placement of map.png cannot cover?
const bx = fine.bx, by = fine.by;
let outside = 0, inside = 0;
const colOutside = new Int32Array(W);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!labels[y * W + x]) continue;
    const mx = x - bx, my = y - by;
    if (mx < 0 || mx >= mw || my < 0 || my >= mh) { outside++; colOutside[x]++; } else inside++;
  }
}
console.log(`\nyap land inside map.png's frame: ${inside}, outside it: ${outside}`);
const cols = [];
for (let x = 0; x < W; x++) if (colOutside[x] > 20) cols.push(x);
if (cols.length) console.log(`  columns with land outside the frame: ${cols[0]}..${cols[cols.length - 1]} (${cols.length} columns)`);

// Side-by-side preview: yap land in blue, map.png land in red, overlap in white.
const PW = 1800, PH = Math.round(H * PW / W);
const rgb = new Uint8Array(PW * PH * 3);
for (let py = 0; py < PH; py++) {
  const y = Math.floor(py * H / PH);
  for (let px2 = 0; px2 < PW; px2++) {
    const x = Math.floor(px2 * W / PW);
    const a = labels[y * W + x] !== 0;
    const mx = x - bx, my = y - by;
    const b = mx >= 0 && mx < mw && my >= 0 && my < mh && mapLand[my * mw + mx] === 1;
    const o = (py * PW + px2) * 3;
    if (a && b) { rgb[o] = 240; rgb[o + 1] = 240; rgb[o + 2] = 240; }
    else if (a) { rgb[o] = 60; rgb[o + 1] = 120; rgb[o + 2] = 255; }
    else if (b) { rgb[o] = 255; rgb[o + 1] = 70; rgb[o + 2] = 70; }
    else { rgb[o] = 10; rgb[o + 1] = 16; rgb[o + 2] = 26; }
  }
}
png.writeRGB(path.join(BUILD, 'align-overlay.png'), PW, PH, rgb);
console.log('\nwrote build/align-overlay.png  (white = agree, blue = yap only, red = map.png only)');
