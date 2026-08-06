/**
 * build-fixer-data.cjs - Stage 3a of the Andah map pipeline.
 *
 * Packages everything tools/label-fixer.html needs into a single JavaScript
 * file that can be loaded with a plain <script> tag, so the page works by
 * double-clicking it with no local server.
 *
 * The region raster travels as a PNG encoded into a data URI rather than as a
 * separate file, because Chrome taints a canvas that has had a file:// image
 * drawn onto it and then refuses to let the page read the pixels back. A data
 * URI counts as same-origin, so it stays readable.
 *
 * Region ids are encoded one per pixel as red = id & 255, green = id >> 8.
 *
 * Usage: node --max-old-space-size=6144 tools/build-fixer-data.cjs
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const png = require('./png.cjs');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
/** Raster width for the fixer. Quarter area of the source, still clickable. */
const FW = 5000;

const meta = JSON.parse(fs.readFileSync(path.join(BUILD, 'regions-final.json'), 'utf8'));
const labelled = JSON.parse(fs.readFileSync(path.join(BUILD, 'labelled.json'), 'utf8'));
const labels = new Uint16Array(zlib.gunzipSync(fs.readFileSync(path.join(BUILD, 'labels-final.u16.gz'))).buffer);
const W = meta.width, H = meta.height;
const FH = Math.round((H * FW) / W);

const countriesJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'countries.json'), 'utf8'));
const areaByKey = new Map();
for (const c of countriesJson.countries) {
  const a = c.metrics && c.metrics['Area (Km)'];
  if (typeof a === 'number') areaByKey.set(c.name.toLowerCase(), a);
}
const canonical = {};
for (const name of labelled.countries) {
  const a = areaByKey.get(name.toLowerCase());
  if (typeof a === 'number') canonical[name] = a;
}

// Downsample the label raster. Nearest neighbour would drop a region that is
// smaller than the sampling grid, so take the most common id in each cell
// instead; a region can still vanish, but only when genuinely tiny, and those
// are reachable from the sidebar list rather than by clicking.
const sx = W / FW, sy = H / FH;
const rgb = new Uint8Array(FW * FH * 3);
const tally = new Map();
for (let fy = 0; fy < FH; fy++) {
  const y0 = Math.floor(fy * sy), y1 = Math.min(H, Math.ceil((fy + 1) * sy));
  for (let fx = 0; fx < FW; fx++) {
    const x0 = Math.floor(fx * sx), x1 = Math.min(W, Math.ceil((fx + 1) * sx));
    tally.clear();
    let bestId = 0, bestN = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const id = labels[y * W + x];
        if (!id) continue;
        const n = (tally.get(id) || 0) + 1;
        tally.set(id, n);
        if (n > bestN) { bestN = n; bestId = id; }
      }
    }
    const o = (fy * FW + fx) * 3;
    rgb[o] = bestId & 255;
    rgb[o + 1] = bestId >> 8;
  }
}
const tmp = path.join(BUILD, 'fixer-ids.png');
png.writeRGB(tmp, FW, FH, rgb);
const dataUri = `data:image/png;base64,${fs.readFileSync(tmp).toString('base64')}`;
fs.unlinkSync(tmp);

const present = new Set();
for (let fy = 0; fy < FH; fy++) for (let fx = 0; fx < FW; fx++) {
  const o = (fy * FW + fx) * 3;
  const id = rgb[o] | (rgb[o + 1] << 8);
  if (id) present.add(id);
}

// Carry any corrections already committed, so reopening the page shows the
// decisions rather than starting from the automatic labelling again.
const OVERRIDES = path.join(ROOT, 'data', 'map-label-overrides.json');
let saved = {};
if (fs.existsSync(OVERRIDES)) {
  const raw = JSON.parse(fs.readFileSync(OVERRIDES, 'utf8'));
  const table = raw.overrides || raw;
  for (const [k, v] of Object.entries(table)) if (!k.startsWith('_')) saved[k] = v;
}

const unassignedReason = new Map(labelled.unassigned.map((u) => [u.id, u.reason]));
const payload = {
  width: W, height: H, rasterWidth: FW, rasterHeight: FH,
  canonicalLandKm2: meta.canonicalLandKm2,
  countries: labelled.countries,
  canonical,
  regions: meta.regions.map((r) => ({
    id: r.id, px: r.px, km2: Math.round(r.areaKm2),
    c: [+r.centroid[0].toFixed(3), +r.centroid[1].toFixed(3)],
    i: r.interior ? [r.interior.x, r.interior.y] : null,
    b: r.bbox,
    drawn: present.has(r.id),
    a: labelled.assignment[r.id] ? labelled.assignment[r.id].name : null,
    conf: labelled.assignment[r.id] ? labelled.assignment[r.id].confidence : null,
    why: labelled.assignment[r.id] ? labelled.assignment[r.id].why : (unassignedReason.get(r.id) || 'not identified'),
  })),
  saved,
  ids: dataUri,
};

const out = path.join(BUILD, 'fixer-data.js');
fs.writeFileSync(out, `window.FIXER = ${JSON.stringify(payload)};\n`);
console.log(`raster ${FW}x${FH}, ${present.size} of ${meta.regions.length} regions visible at this scale`);
console.log(`wrote build/fixer-data.js (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
