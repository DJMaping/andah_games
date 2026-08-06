/**
 * trace-map.cjs - Stage 1 of the Andah map pipeline.
 *
 * Turns the blank political base map (maps/yap.png, 10000x4999 equirectangular)
 * into a per-region label raster plus region statistics. It does not name
 * anything; that is stage 2 (label-regions.cjs).
 *
 * What it does, in order:
 *   1. Decode the PNG and classify every pixel as sea, land or border.
 *   2. Flood fill the land into connected regions, wrapping across the
 *      antimeridian so a country straddling the seam stays one region.
 *   3. Hand out the border pixels. Borders are a 1px line belonging to nobody,
 *      so without this every country would be inset by a pixel and neighbours
 *      would be separated by a visible sliver. A multi-source breadth-first
 *      search assigns each border pixel to its nearest region, which makes
 *      neighbours share an exact edge.
 *   4. Erode the 1px spikes this creates where border lines run out into open
 *      sea (maritime boundary stubs on the source map).
 *   5. Measure each region: true area on an Earth-sized sphere with the
 *      cos(latitude) correction equirectangular needs, bounding box, centroid,
 *      a guaranteed-interior point, and which regions it touches.
 *
 * Outputs (all under build/, which is gitignored):
 *   build/labels.u16.gz     region id per pixel, 0 = sea
 *   build/regions.json      per-region statistics and adjacency
 *   build/trace-preview.png a look at what was traced
 *
 * Usage: node --max-old-space-size=4096 tools/trace-map.cjs
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const png = require('./png.cjs');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.argv.includes('--src')
  ? process.argv[process.argv.indexOf('--src') + 1]
  : path.join(ROOT, 'maps', 'yap.png');
const OUT = path.join(ROOT, 'build');

/** Mean Earth radius, km. Andah is Earth-sized; verified against canonical areas. */
const R_KM = 6371.0;
/** Regions smaller than this are reported separately as probable artefacts. */
const ARTEFACT_PX = 8;

const SEA = 0, LAND = 1, BORDER = 2;

function log(...a) { console.log(...a); }
function pct(n, d) { return `${(100 * n / d).toFixed(4)}%`; }

// ---------------------------------------------------------------- 1. classify

log(`reading ${path.relative(ROOT, SRC)}`);
const img = png.decode(SRC);
const W = img.w, H = img.h, N = W * H;
log(`  ${W}x${H}, colour type ${img.ct}`);
if (img.ct !== png.CT_PALETTE) throw new Error('expected a palette PNG');

// Classify by colour rather than palette index, so a re-export that reshuffles
// the palette does not silently change the meaning of the map.
const classOf = new Uint8Array(256);
const seen = png.paletteHistogram(img);
const tally = { sea: 0, land: 0, border: 0 };
const oddities = [];
for (const { idx, count, rgb } of seen) {
  const [r, g, b] = rgb;
  let cls;
  if (r === 255 && g === 255 && b === 255) cls = SEA;
  else if (Math.max(r, g, b) < 100) cls = BORDER;
  else cls = LAND;
  classOf[idx] = cls;
  tally[cls === SEA ? 'sea' : cls === LAND ? 'land' : 'border'] += count;
  // Anything that is not one of the three expected map colours is worth naming.
  const expected = (r === 255 && g === 255 && b === 255) || (r === 218 && g === 218 && b === 218) || (r === 66 && g === 66 && b === 66);
  if (!expected) oddities.push({ idx, rgb, count, cls });
}
log(`  sea ${tally.sea} (${pct(tally.sea, N)})  land ${tally.land} (${pct(tally.land, N)})  border ${tally.border} (${pct(tally.border, N)})`);
if (oddities.length) {
  log(`  ${oddities.length} off-palette colours, ${oddities.reduce((s, o) => s + o.count, 0)} pixels total:`);
  for (const o of oddities.slice(0, 12)) {
    log(`    rgb(${o.rgb.join(',')}) x${o.count} -> ${['sea', 'land', 'border'][o.cls]}`);
  }
}

const cls = new Uint8Array(N);
for (let k = 0; k < N; k++) cls[k] = classOf[img.px[k]];

// ------------------------------------------------- rescue unfilled countries

// A country drawn as an outline but never flood-filled with the land colour
// reads as sea inside a ring of border, and would silently disappear. Find
// water that cannot reach the open ocean and touches no land anywhere: an
// inland lake always abuts the land around it, so anything enclosed purely by
// border lines is a landmass whose fill was never applied.
{
  const wrapL = (k) => (k % W === 0 ? k + W - 1 : k - 1);
  const wrapR = (k) => (k % W === W - 1 ? k - W + 1 : k + 1);
  const openSea = new Uint8Array(N);
  const stack = new Int32Array(1 << 23);
  let sp = 0;
  for (let x = 0; x < W; x++) {
    for (const p of [x, (H - 1) * W + x]) {
      if (cls[p] === SEA && !openSea[p]) { openSea[p] = 1; stack[sp++] = p; }
    }
  }
  while (sp > 0) {
    const p = stack[--sp];
    const y = (p / W) | 0;
    const nb = [wrapL(p), wrapR(p)];
    if (y > 0) nb.push(p - W);
    if (y < H - 1) nb.push(p + W);
    for (const q of nb) if (cls[q] === SEA && !openSea[q]) { openSea[q] = 1; stack[sp++] = q; }
  }

  const seen = new Uint8Array(N);
  const rescued = [];
  const lakes = [];
  let rescuedPx = 0;
  const nbOf = (p) => {
    const y = (p / W) | 0;
    const out = [wrapL(p), wrapR(p)];
    if (y > 0) out.push(p - W);
    if (y < H - 1) out.push(p + W);
    return out;
  };

  for (let s = 0; s < N; s++) {
    if (cls[s] !== SEA || openSea[s] || seen[s]) continue;
    const body = [];
    sp = 0; stack[sp++] = s; seen[s] = 1;
    let land = 0, ring = [];
    while (sp > 0) {
      const p = stack[--sp];
      body.push(p);
      for (const q of nbOf(p)) {
        if (cls[q] === SEA && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
        else if (cls[q] === LAND) land++;
        else if (cls[q] === BORDER) ring.push(q);
      }
    }
    if (body.length < 4) continue;

    // Walk out through the enclosing line and see what is on the far side.
    // An unfilled country sits in open water; a lake sits inside a continent.
    let ocean = 0;
    const walked = new Set(ring);
    let front = ring;
    for (let step = 0; step < 6 && front.length; step++) {
      const next = [];
      for (const p of front) {
        for (const q of nbOf(p)) {
          if (cls[q] === LAND) land++;
          else if (cls[q] === SEA && openSea[q]) ocean++;
          else if (cls[q] === BORDER && !walked.has(q)) { walked.add(q); next.push(q); }
        }
      }
      front = next;
    }

    let minx = W, maxx = -1, miny = H, maxy = -1;
    for (const p of body) {
      const y = (p / W) | 0, x = p - y * W;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    const where = {
      px: body.length, bbox: [minx, miny, maxx, maxy], land, ocean,
      lon: ((minx + maxx) / 2 / W) * 360 - 180,
      lat: 90 - ((miny + maxy) / 2 / H) * 180,
    };
    if (ocean > land) {
      for (const p of body) cls[p] = LAND;
      rescuedPx += body.length;
      rescued.push(where);
    } else {
      lakes.push(where);
    }
  }

  tally.land += rescuedPx;
  tally.sea -= rescuedPx;
  log(`\nunfilled outlines rescued: ${rescued.length} shapes, ${rescuedPx} pixels now treated as land`);
  for (const r of rescued.sort((a, b) => b.px - a.px).slice(0, 10)) {
    log(`  ${String(r.px).padStart(6)} px near lon ${r.lon.toFixed(1)}, lat ${r.lat.toFixed(1)} (${r.ocean} ocean vs ${r.land} land around it)`);
  }
  const bigLakes = lakes.filter((l) => l.px >= 200).sort((a, b) => b.px - a.px);
  log(`enclosed water left as water: ${lakes.length} bodies, ${bigLakes.length} of them above 200 px`);
  for (const l of bigLakes.slice(0, 6)) {
    log(`  ${String(l.px).padStart(6)} px near lon ${l.lon.toFixed(1)}, lat ${l.lat.toFixed(1)} (${l.land} land vs ${l.ocean} ocean around it)`);
  }
}

// ------------------------------------------------------------- 1b. pixel area

// Row y spans latitude lat(y) down to lat(y+1). The area of one pixel in that
// row is R^2 * dLon * (sin(latTop) - sin(latBottom)). Ignoring this is the
// classic equirectangular mistake: it would make polar countries look enormous.
const dLon = (2 * Math.PI) / W;
const rowArea = new Float64Array(H);
const rad = (d) => (d * Math.PI) / 180;
for (let y = 0; y < H; y++) {
  const latTop = 90 - (y / H) * 180;
  const latBot = 90 - ((y + 1) / H) * 180;
  rowArea[y] = R_KM * R_KM * dLon * (Math.sin(rad(latTop)) - Math.sin(rad(latBot)));
}
const sphere = rowArea.reduce((s, a, y) => s + a * W, 0);
log(`  sphere area check: ${sphere.toFixed(0)} km2 vs 4piR^2 ${(4 * Math.PI * R_KM * R_KM).toFixed(0)} km2`);

// ------------------------------------------------------- 2. connected regions

// Wrap horizontally: a country straddling the antimeridian is one country.
const left = (k) => (k % W === 0 ? k + W - 1 : k - 1);
const right = (k) => (k % W === W - 1 ? k - W + 1 : k + 1);

const labels = new Uint16Array(N); // 0 = unassigned
let nRegions = 0;
const stack = new Int32Array(1 << 23);

for (let s = 0; s < N; s++) {
  if (cls[s] !== LAND || labels[s] !== 0) continue;
  if (++nRegions > 65534) throw new Error('more than 65534 regions, widen the label type');
  const id = nRegions;
  let sp = 0;
  stack[sp++] = s;
  labels[s] = id;
  while (sp > 0) {
    const p = stack[--sp];
    const y = (p / W) | 0;
    const nb = [left(p), right(p)];
    if (y > 0) nb.push(p - W);
    if (y < H - 1) nb.push(p + W);
    for (const q of nb) {
      if (cls[q] === LAND && labels[q] === 0) {
        labels[q] = id;
        if (sp >= stack.length) throw new Error('flood fill stack overflow');
        stack[sp++] = q;
      }
    }
  }
}
log(`\nflood fill: ${nRegions} land regions`);

// ------------------------------------------------- 3. hand out border pixels

// A drawn border between two countries has land on both sides of it. A maritime
// boundary stub drawn out into open water has sea on both sides. That is the
// whole distinction, and it must be respected: flooding along border lines
// instead turns every stub into a one-pixel spike of whichever country the line
// happens to touch at the coast.
const wasBorder = new Uint8Array(N);
function around(p) {
  const y = (p / W) | 0;
  const l = left(p), r = right(p);
  const out = [l, r];
  if (y > 0) out.push(p - W, l - W, r - W);
  if (y < H - 1) out.push(p + W, l + W, r + W);
  return out;
}

let claimed = 0;
for (let p = 0; p < N; p++) {
  if (cls[p] !== BORDER || labels[p] !== 0) continue;
  // Majority vote among adjacent land, so a border pixel goes to whichever
  // country it mostly abuts rather than to whichever the scan reached first.
  const votes = new Map();
  for (const q of around(p)) {
    if (cls[q] !== LAND || labels[q] === 0) continue;
    votes.set(labels[q], (votes.get(labels[q]) || 0) + 1);
  }
  if (!votes.size) continue;
  let best = 0, bestN = 0;
  for (const [id, n] of votes) if (n > bestN) { bestN = n; best = id; }
  labels[p] = best;
  wasBorder[p] = 1;
  claimed++;
}
const direct = claimed;

// Thicker border lines leave an unclaimed core. Fill it, but only where a pixel
// is genuinely embedded in claimed ground. A line running out to sea has just
// its two neighbours along its own length, so it is never walked down.
for (let pass = 0; pass < 3; pass++) {
  const add = [];
  for (let p = 0; p < N; p++) {
    if (cls[p] !== BORDER || labels[p] !== 0) continue;
    const votes = new Map();
    let n = 0;
    for (const q of around(p)) {
      if (labels[q] === 0) continue;
      n++;
      votes.set(labels[q], (votes.get(labels[q]) || 0) + 1);
    }
    if (n < 3) continue;
    let best = 0, bestN = 0;
    for (const [id, k] of votes) if (k > bestN) { bestN = k; best = id; }
    add.push(p, best);
  }
  if (!add.length) break;
  for (let i = 0; i < add.length; i += 2) { labels[add[i]] = add[i + 1]; wasBorder[add[i]] = 1; claimed++; }
}

let orphanBorder = 0;
for (let p = 0; p < N; p++) if (cls[p] === BORDER && labels[p] === 0) orphanBorder++;
log(`border handout: ${direct} touch land directly, ${claimed} claimed in total, ${orphanBorder} left as sea (maritime stubs and open-water lines)`);

// --------------------------------------- 4. erode 1px spikes into open water

// Border lines that run out into the sea as maritime stubs would otherwise
// become hairline spikes hanging off a coastline.
let eroded = 0;
for (let pass = 0; pass < 3; pass++) {
  let removed = 0;
  for (let p = 0; p < N; p++) {
    if (!wasBorder[p] || labels[p] === 0) continue;
    const y = (p / W) | 0;
    let open = 0;
    if (labels[left(p)] === 0) open++;
    if (labels[right(p)] === 0) open++;
    if (y === 0 || labels[p - W] === 0) open++;
    if (y === H - 1 || labels[p + W] === 0) open++;
    if (open >= 3) { labels[p] = 0; removed++; }
  }
  eroded += removed;
  if (!removed) break;
}
log(`spike erosion: ${eroded} pixels returned to sea`);

// --------------------------------------------------------- 5. measure regions

const px = new Float64Array(nRegions + 1);
const area = new Float64Array(nRegions + 1);
const sumLon = new Float64Array(nRegions + 1);
const sumLat = new Float64Array(nRegions + 1);
const minX = new Int32Array(nRegions + 1).fill(W);
const maxX = new Int32Array(nRegions + 1).fill(-1);
const minY = new Int32Array(nRegions + 1).fill(H);
const maxY = new Int32Array(nRegions + 1).fill(-1);
const atLeftEdge = new Uint8Array(nRegions + 1);
const atRightEdge = new Uint8Array(nRegions + 1);

const lonOf = (x) => ((x + 0.5) / W) * 360 - 180;
const latOf = (y) => 90 - ((y + 0.5) / H) * 180;

for (let y = 0; y < H; y++) {
  const a = rowArea[y], lat = latOf(y), base = y * W;
  for (let x = 0; x < W; x++) {
    const id = labels[base + x];
    if (!id) continue;
    px[id]++;
    area[id] += a;
    sumLon[id] += lonOf(x) * a;
    sumLat[id] += lat * a;
    if (x < minX[id]) minX[id] = x;
    if (x > maxX[id]) maxX[id] = x;
    if (y < minY[id]) minY[id] = y;
    if (y > maxY[id]) maxY[id] = y;
    if (x === 0) atLeftEdge[id] = 1;
    if (x === W - 1) atRightEdge[id] = 1;
  }
}

// A guaranteed-interior point: the midpoint of the longest horizontal run in
// the region's widest row. A centroid can easily fall outside a crescent.
const interior = new Array(nRegions + 1).fill(null);
{
  const bestRun = new Int32Array(nRegions + 1);
  for (let y = 0; y < H; y++) {
    const base = y * W;
    let x = 0;
    while (x < W) {
      const id = labels[base + x];
      if (!id) { x++; continue; }
      let end = x;
      while (end < W && labels[base + end] === id) end++;
      const len = end - x;
      if (len > bestRun[id]) {
        bestRun[id] = len;
        interior[id] = { x: x + (len >> 1), y };
      }
      x = end;
    }
  }
}

// Adjacency, with shared boundary length in pixels.
const shared = new Map();
const bump = (a, b) => {
  const key = a < b ? a * 70000 + b : b * 70000 + a;
  shared.set(key, (shared.get(key) || 0) + 1);
};
for (let y = 0; y < H; y++) {
  const base = y * W;
  for (let x = 0; x < W; x++) {
    const p = base + x;
    const id = labels[p];
    if (!id) continue;
    const r = labels[right(p)];
    if (r && r !== id) bump(id, r);
    if (y < H - 1) {
      const d = labels[p + W];
      if (d && d !== id) bump(id, d);
    }
  }
}
const neighbours = new Map();
for (const [key, len] of shared) {
  const a = Math.floor(key / 70000), b = key % 70000;
  if (!neighbours.has(a)) neighbours.set(a, []);
  if (!neighbours.has(b)) neighbours.set(b, []);
  neighbours.get(a).push({ id: b, px: len });
  neighbours.get(b).push({ id: a, px: len });
}

const regions = [];
for (let id = 1; id <= nRegions; id++) {
  if (px[id] === 0) continue; // fully eroded
  regions.push({
    id,
    px: px[id],
    areaKm2: area[id],
    bbox: [minX[id], minY[id], maxX[id], maxY[id]],
    centroid: [sumLon[id] / area[id], sumLat[id] / area[id]],
    interior: interior[id],
    wrapsSeam: !!(atLeftEdge[id] && atRightEdge[id]),
    neighbours: (neighbours.get(id) || []).sort((a, b) => b.px - a.px),
  });
}
regions.sort((a, b) => b.areaKm2 - a.areaKm2);

const totalLand = regions.reduce((s, r) => s + r.areaKm2, 0);
const CANONICAL_LAND_KM2 = 125651092; // sum of Area (Km) for the 172 nations
log(`\nregions kept: ${regions.length}`);
for (const t of [ARTEFACT_PX, 100, 1000, 10000, 100000]) {
  log(`  >= ${String(t).padStart(6)} px : ${regions.filter((r) => r.px >= t).length}`);
}
log(`  seam-wrapping regions: ${regions.filter((r) => r.wrapsSeam).length}`);
log(`\nland area traced : ${totalLand.toFixed(0)} km2 (${pct(totalLand, sphere)} of the sphere)`);
log(`canonical total  : ${CANONICAL_LAND_KM2} km2 (${pct(CANONICAL_LAND_KM2, sphere)} of the sphere)`);
const err = (totalLand - CANONICAL_LAND_KM2) / CANONICAL_LAND_KM2;
log(`difference       : ${(err * 100).toFixed(2)}%  ->  implied radius ${(R_KM * Math.sqrt(CANONICAL_LAND_KM2 / totalLand)).toFixed(0)} km`);

// ------------------------------------------------------------------ 6. output

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'labels.u16.gz'), zlib.gzipSync(Buffer.from(labels.buffer), { level: 6 }));
// Stage 2 needs to know which pixels were drawn as border lines, so it can
// split countries that a gap in those lines has fused together.
fs.writeFileSync(path.join(OUT, 'classes.u8.gz'), zlib.gzipSync(Buffer.from(cls.buffer), { level: 6 }));
fs.writeFileSync(path.join(OUT, 'regions.json'), JSON.stringify({
  source: path.relative(ROOT, SRC).replace(/\\/g, '/'),
  width: W,
  height: H,
  radiusKm: R_KM,
  sphereAreaKm2: sphere,
  tracedLandKm2: totalLand,
  canonicalLandKm2: CANONICAL_LAND_KM2,
  regionCount: regions.length,
  regions,
}, null, 1));

// Preview: a distinct colour per region so the trace can be eyeballed at once.
const PW = 2000, PH = Math.round((H * PW) / W);
const rgb = new Uint8Array(PW * PH * 3);
const colour = (id) => {
  // Golden-angle hue spread keeps neighbouring ids visually distinct.
  const h = (id * 137.508) % 360, s = 0.55, v = id % 2 ? 0.95 : 0.75;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
};
const lut = new Uint8Array((nRegions + 1) * 3);
for (let id = 1; id <= nRegions; id++) {
  const [r, g, b] = colour(id);
  lut[id * 3] = r; lut[id * 3 + 1] = g; lut[id * 3 + 2] = b;
}
for (let y = 0; y < PH; y++) {
  const sy = Math.min(H - 1, Math.floor((y * H) / PH));
  for (let x = 0; x < PW; x++) {
    const sx = Math.min(W - 1, Math.floor((x * W) / PW));
    const id = labels[sy * W + sx];
    const o = (y * PW + x) * 3;
    if (id) { rgb[o] = lut[id * 3]; rgb[o + 1] = lut[id * 3 + 1]; rgb[o + 2] = lut[id * 3 + 2]; }
    else { rgb[o] = 12; rgb[o + 1] = 22; rgb[o + 2] = 34; }
  }
}
png.writeRGB(path.join(OUT, 'trace-preview.png'), PW, PH, rgb);

log(`\nwrote build/labels.u16.gz, build/regions.json, build/trace-preview.png`);
