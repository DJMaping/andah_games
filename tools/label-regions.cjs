/**
 * label-regions.cjs - Stage 2 of the Andah map pipeline.
 *
 * Takes the nameless regions from trace-map.cjs and works out which country
 * each one is, using three independent lines of evidence:
 *
 *   Anchors  js/andah-map-coords.js holds exactly 172 hand-placed points, one
 *            per country, in the pixel space of maps/map.png. That file is an
 *            exact 1:1 crop of maps/yap.png, so once the offset is found every
 *            anchor can be carried across to name the region it lands in.
 *   Cities   data/flight-cities.json holds 591 cities already on the yap.png
 *            grid, each tagged with its nation. Where a city and an anchor
 *            disagree, the region's area decides, and if that is inconclusive
 *            the region is flagged rather than guessed at.
 *   Area     Every country's true area is known, so comparing it against the
 *            traced area catches merged countries, misplaced anchors and
 *            islands not yet attached to their parent.
 *
 * It also repairs countries that the source map has accidentally fused. A gap
 * of even one pixel in a drawn border makes two nations flood-fill into a
 * single region. Those are split again by racing a breadth-first search out
 * from each country's anchor, forbidden from crossing the border pixels that
 * *were* drawn, so the repaired boundary follows the artwork everywhere except
 * across the gap itself.
 *
 * Nothing is invented. Regions that cannot be identified confidently stay
 * unassigned, render neutral, and are listed in MAP_TRACE_REPORT.md.
 *
 * Usage: node --max-old-space-size=6144 tools/label-regions.cjs
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const png = require('./png.cjs');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const R_KM = 6371.0;

/** Nearest labelled region must be within this for an orphan island to join it. */
const ISLAND_MAX_KM = 900;
/** A more distant island may still join if it plainly fills a country's shortfall. */
const ISLAND_FAR_KM = 3000;
/** ...meaning the shortfall accounts for at least this much of the island. */
const ISLAND_FAR_SHARE = 0.6;
/** Below this an unassigned region is a speck, not a lost island. */
const SPECK_PX = 8;
/** One area estimate must beat the other by this factor to settle a conflict. */
const CONFLICT_MARGIN = 0.5;

const SEA = 0, LAND = 1, BORDER = 2;
const log = (...a) => console.log(...a);
const rad = (d) => (d * Math.PI) / 180;

// ------------------------------------------------------------------ load work

const meta = JSON.parse(fs.readFileSync(path.join(BUILD, 'regions.json'), 'utf8'));
const W = meta.width, H = meta.height;
const labels = new Uint16Array(zlib.gunzipSync(fs.readFileSync(path.join(BUILD, 'labels.u16.gz'))).buffer);
const cls = new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(BUILD, 'classes.u8.gz'))).buffer);
const regions = new Map(meta.regions.map((r) => [r.id, r]));
let nextRegionId = Math.max(...regions.keys()) + 1;
log(`loaded ${regions.size} regions from a ${W}x${H} raster`);

const dLon = (2 * Math.PI) / W;
const rowArea = new Float64Array(H);
for (let y = 0; y < H; y++) {
  rowArea[y] = R_KM * R_KM * dLon * (Math.sin(rad(90 - (y / H) * 180)) - Math.sin(rad(90 - ((y + 1) / H) * 180)));
}
const lonOf = (x) => ((x + 0.5) / W) * 360 - 180;
const latOf = (y) => 90 - ((y + 0.5) / H) * 180;
function haversineKm(a, b) {
  const dLat = rad(b[1] - a[1]), dL = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dL / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

const anchorSrc = fs.readFileSync(path.join(ROOT, 'js', 'andah-map-coords.js'), 'utf8');
const anchors = JSON.parse(anchorSrc.slice(anchorSrc.indexOf('['), anchorSrc.lastIndexOf(']') + 1));
log(`loaded ${anchors.length} country anchors`);

const countriesJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'countries.json'), 'utf8'));
const areaByKey = new Map();
for (const c of countriesJson.countries) {
  const a = c.metrics && c.metrics['Area (Km)'];
  if (typeof a === 'number') areaByKey.set(c.name.toLowerCase(), a);
}
const canonicalArea = new Map();
const noArea = [];
for (const { name } of anchors) {
  const a = areaByKey.get(name.toLowerCase()); // also catches the lowercase 'lasri' row
  if (typeof a === 'number') canonicalArea.set(name, a);
  else noArea.push(name);
}
if (noArea.length) log(`  warning: no canonical area for ${noArea.join(', ')}`);

const cities = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'flight-cities.json'), 'utf8'));
if (cities.map.width !== W || cities.map.height !== H) {
  throw new Error(`flight-cities.json is on a ${cities.map.width}x${cities.map.height} grid, not ${W}x${H}`);
}
log(`loaded ${cities.cities.length} cities across ${new Set(cities.cities.map((c) => c.nation)).size} nations`);

// ------------------------------------------- fit maps/map.png onto yap.png

const mapImg = png.decode(path.join(ROOT, 'maps', 'map.png'));
const mw = mapImg.w, mh = mapImg.h;
const mapSea = png.paletteHistogram(mapImg)[0].idx;
const mapLand = new Uint8Array(mw * mh);
for (let k = 0; k < mw * mh; k++) mapLand[k] = mapImg.px[k] === mapSea ? 0 : 1;

function robustBBox(get, w, h, minRun = 3) {
  let minX = w, maxX = -1, minY = h, maxY = -1;
  const col = new Int32Array(w), row = new Int32Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (get(x, y)) { col[x]++; row[y]++; }
  for (let x = 0; x < w; x++) if (col[x] >= minRun) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
  for (let y = 0; y < h; y++) if (row[y] >= minRun) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  return { minX, maxX, minY, maxY };
}
const yapBox = robustBBox((x, y) => labels[y * W + x] !== 0, W, H);
const mapBox = robustBBox((x, y) => mapLand[y * mw + x], mw, mh);
log(`\nmap.png ${mw}x${mh}, sea palette index ${mapSea}`);

// map.png is an exact 1:1 crop of yap.png, so this is a pure translation. A
// general affine fit finds a poor local optimum instead, because yap's land
// bounding box is stretched by thin island chains that map.png crops away.
function iouAt(bx, by, step) {
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
const by0 = yapBox.minY - mapBox.minY;
let bx = 0, alignIou = -1;
for (let t = -200; t <= W - mw + 200; t += 4) {
  const v = iouAt(t, by0, 8);
  if (v > alignIou) { alignIou = v; bx = t; }
}
let by = by0;
for (let tx = bx - 8; tx <= bx + 8; tx++) {
  for (let ty = by0 - 8; ty <= by0 + 8; ty++) {
    const v = iouAt(tx, ty, 2);
    if (v > alignIou) { alignIou = v; bx = tx; by = ty; }
  }
}
log(`  1:1 translation bx=${bx} by=${by}, IoU ${alignIou.toFixed(4)}`);
if (alignIou < 0.98) {
  throw new Error(`alignment IoU ${alignIou.toFixed(4)} is too low to trust anchor transfer`);
}

// -------------------------------------------------------------- measurement

/** Region under a pixel, searching outward if it landed in water. */
function regionAt(x, y, maxR = 40) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= W || y < 0 || y >= H) return { id: 0, dist: Infinity, x, y };
  if (labels[y * W + x]) return { id: labels[y * W + x], dist: 0, x, y };
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      const span = r - Math.abs(dy);
      for (const dx of span === 0 ? [0] : [-span, span]) {
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        if (labels[yy * W + xx]) return { id: labels[yy * W + xx], dist: r, x: xx, y: yy };
      }
    }
  }
  return { id: 0, dist: Infinity, x, y };
}

/** Statistics for a set of pixel indices. */
function measure(id, pixels) {
  let area = 0, sLon = 0, sLat = 0;
  let minX = W, maxX = -1, minY = H, maxY = -1;
  for (const p of pixels) {
    const y = (p / W) | 0, x = p - y * W, a = rowArea[y];
    area += a; sLon += lonOf(x) * a; sLat += latOf(y) * a;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  // Interior point: midpoint of the longest horizontal run in the widest row.
  const runs = new Map();
  for (const p of pixels) {
    const y = (p / W) | 0;
    if (!runs.has(y)) runs.set(y, []);
    runs.get(y).push(p - y * W);
  }
  let interior = null, bestRun = 0;
  for (const [y, xs] of runs) {
    xs.sort((a, b) => a - b);
    let start = xs[0], prev = xs[0];
    for (let i = 1; i <= xs.length; i++) {
      if (i === xs.length || xs[i] !== prev + 1) {
        const len = prev - start + 1;
        if (len > bestRun) { bestRun = len; interior = { x: start + (len >> 1), y }; }
        if (i < xs.length) start = xs[i];
      }
      prev = xs[i];
    }
  }
  return {
    id, px: pixels.length, areaKm2: area, bbox: [minX, minY, maxX, maxY],
    centroid: [sLon / area, sLat / area], interior,
    wrapsSeam: minX === 0 && maxX === W - 1, neighbours: [],
  };
}

// ------------------------------------------- repair regions holding 2 anchors

function collectPixels(id) {
  const [x0, y0, x1, y1] = regions.get(id).bbox;
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const p = y * W + x;
    if (labels[p] === id) out.push(p);
  }
  return out;
}

const n8 = (p) => {
  const y = (p / W) | 0, x = p - y * W;
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= H) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx;
      if (xx < 0 || xx >= W) continue;
      out.push(yy * W + xx);
    }
  }
  return out;
};
const n4 = (p) => {
  const y = (p / W) | 0, x = p - y * W;
  const out = [];
  if (x > 0) out.push(p - 1);
  if (x < W - 1) out.push(p + 1);
  if (y > 0) out.push(p - W);
  if (y < H - 1) out.push(p + W);
  return out;
};

/** Hand unowned pixels to the nearest owned one, so nothing is left behind. */
function fillOutward(pixels, member, owner) {
  let frontier = pixels.filter((p) => owner.has(p));
  while (frontier.length) {
    const next = [];
    for (const p of frontier) {
      const o = owner.get(p);
      for (const q of n4(p)) {
        if (!member.has(q) || owner.has(q)) continue;
        owner.set(q, o);
        next.push(q);
      }
    }
    frontier = next;
  }
}

/**
 * Preferred repair: thicken the drawn border until it actually separates the
 * countries, then flood fill each side and hand the thickened strip back to
 * whichever side is nearer.
 *
 * The artwork already contains the right boundary almost everywhere; the fusion
 * is caused by a gap of a pixel or two. Closing that gap and re-filling
 * reproduces the artist's line exactly, which growing fronts outward from the
 * anchors cannot do: those follow the drawn border where it exists and then
 * strike off across open ground where it does not, leaving filaments of one
 * country threaded into its neighbour.
 *
 * Returns null when no barrier up to maxK separates the anchors.
 */
function barrierComponents(pixels, member, seedPx, k) {
  const blocked = new Set();
  let frontier = [];
  for (const p of pixels) if (cls[p] === BORDER) { blocked.add(p); frontier.push(p); }
  for (let step = 1; step < k; step++) {
    const next = [];
    for (const p of frontier) for (const q of n8(p)) {
      if (member.has(q) && !blocked.has(q)) { blocked.add(q); next.push(q); }
    }
    frontier = next;
  }

  const comp = new Map();
  let nComp = 0;
  for (const p of pixels) {
    if (blocked.has(p) || comp.has(p)) continue;
    const c = nComp++;
    const stack = [p];
    comp.set(p, c);
    while (stack.length) {
      const q = stack.pop();
      for (const r of n4(q)) {
        if (member.has(r) && !blocked.has(r) && !comp.has(r)) { comp.set(r, c); stack.push(r); }
      }
    }
  }

  // Where each anchor ended up. A seed sitting on the line itself takes the
  // component of whichever neighbour survived.
  const homes = seedPx.map((p) => {
    if (comp.has(p)) return comp.get(p);
    for (const q of n8(p)) if (comp.has(q)) return comp.get(q);
    return undefined;
  });
  const counts = new Map();
  for (const h of homes) if (h !== undefined) counts.set(h, (counts.get(h) || 0) + 1);
  const alone = homes.filter((h) => h !== undefined && counts.get(h) === 1).length;
  return { comp, homes, counts, alone, k };
}

/**
 * Fallback when thickening the border never separates the countries, which
 * means the artwork simply has no boundary between them for a long stretch.
 *
 * Each front is grown in proportion to how far short of its known real area it
 * currently is, rather than raced evenly. Racing goes badly wrong when the
 * fused countries differ wildly in size: a microstate that leaks through the
 * gap carries on until it meets its giant neighbour's front halfway, taking a
 * huge slab with it.
 */
function growByArea(pixels, member, seeds, seedPx) {
  const owner = new Map();
  const n = seeds.length;
  const targets = seeds.map((s) => canonicalArea.get(s.name) || 0);
  const totalTarget = targets.reduce((a, b) => a + b, 0);
  const totalArea = pixels.reduce((s, p) => s + rowArea[(p / W) | 0], 0);
  // Fall back to an equal share for any country with no canonical area.
  for (let i = 0; i < n; i++) if (!targets[i]) targets[i] = totalTarget ? totalTarget / n : totalArea / n;

  const fronts = seeds.map(() => []);
  const heads = new Int32Array(n);
  const grown = new Float64Array(n);

  seedPx.forEach((seed, i) => {
    owner.set(seed, i);
    grown[i] += rowArea[(seed / W) | 0];
    fronts[i].push(seed);
  });

  const neighbours = (p) => {
    const y = (p / W) | 0, x = p - y * W;
    const out = [];
    if (x > 0) out.push(p - 1);
    if (x < W - 1) out.push(p + 1);
    if (y > 0) out.push(p - W);
    if (y < H - 1) out.push(p + W);
    return out;
  };

  /** Grow all fronts, always advancing whichever is furthest below its target. */
  const grow = (allow) => {
    for (;;) {
      let pick = -1, worst = Infinity;
      for (let i = 0; i < n; i++) {
        if (heads[i] >= fronts[i].length) continue;
        const ratio = grown[i] / targets[i];
        if (ratio < worst) { worst = ratio; pick = i; }
      }
      if (pick === -1) return;
      const p = fronts[pick][heads[pick]++];
      for (const q of neighbours(p)) {
        if (!member.has(q) || owner.has(q) || !allow(q)) continue;
        owner.set(q, pick);
        grown[pick] += rowArea[(q / W) | 0];
        fronts[pick].push(q);
      }
    }
  };

  grow((q) => cls[q] === LAND);   // confined by the drawn borders
  for (let i = 0; i < n; i++) { fronts[i] = [...owner.keys()].filter((p) => owner.get(p) === i); heads[i] = 0; }
  grow(() => true);               // then the border pixels themselves
  for (let i = 0; i < n; i++) { fronts[i] = [...owner.keys()].filter((p) => owner.get(p) === i); heads[i] = 0; }
  grow(() => true);               // and anything the artwork walled off entirely
  fillOutward(pixels, member, owner);
  return { owner };
}

/** Repair a fused region, following the artwork where it can. */
function splitFused(id, seeds) {
  const pixels = collectPixels(id);
  const member = new Set(pixels);
  const seedPx = seeds.map((s) => {
    const seed = s.y * W + s.x;
    if (member.has(seed) && cls[seed] === LAND) return seed;
    for (let r = 1; r <= 60; r++) {
      for (let dy = -r; dy <= r; dy++) {
        const span = r - Math.abs(dy);
        for (const dx of span === 0 ? [0] : [-span, span]) {
          const p = (s.y + dy) * W + (s.x + dx);
          if (member.has(p) && cls[p] === LAND) return p;
        }
      }
    }
    return seed;
  });

  // Take the barrier thickness that isolates the most countries. Any country
  // the artwork does separate gets its true drawn outline; only the ones the
  // artwork leaves genuinely open to each other fall back to sharing by area.
  let best = null;
  for (let k = 1; k <= 8; k++) {
    const r = barrierComponents(pixels, member, seedPx, k);
    if (r.homes.some((h) => h === undefined)) continue;
    if (!best || r.alone > best.alone) best = r;
    if (r.alone === seeds.length) break;
  }

  const owner = new Map();
  let method;
  if (best && best.alone > 0) {
    const solo = new Map();
    best.homes.forEach((h, i) => { if (best.counts.get(h) === 1) solo.set(h, i); });
    for (const [p, c] of best.comp) if (solo.has(c)) owner.set(p, solo.get(c));

    // Components still holding more than one anchor are shared out among just
    // those countries, inside that component alone.
    for (const [c, n] of best.counts) {
      if (n < 2) continue;
      const sub = pixels.filter((p) => best.comp.get(p) === c);
      const subMember = new Set(sub);
      const idx = best.homes.map((h, i) => (h === c ? i : -1)).filter((i) => i >= 0);
      const subSeedPx = idx.map((i) => {
        if (subMember.has(seedPx[i])) return seedPx[i];
        for (const q of n8(seedPx[i])) if (subMember.has(q)) return q;
        return sub[0];
      });
      const r = growByArea(sub, subMember, idx.map((i) => seeds[i]), subSeedPx);
      for (const [p, o] of r.owner) owner.set(p, idx[o]);
    }
    fillOutward(pixels, member, owner);
    method = best.alone === seeds.length
      ? `border closed at ${best.k} px`
      : `border closed at ${best.k} px, ${seeds.length - best.alone} shared out by area`;
  } else {
    const r = growByArea(pixels, member, seeds, seedPx);
    for (const [p, o] of r.owner) owner.set(p, o);
    method = 'area-balanced growth';
  }

  const groups = seeds.map(() => []);
  const stranded = [];
  for (const p of pixels) {
    const o = owner.get(p);
    if (o === undefined) stranded.push(p); else groups[o].push(p);
  }
  return { groups, stranded, method };
}

let anchorHits = anchors.map((a) => ({ name: a.name, ...regionAt(a.x + bx, a.y + by, 150) }));
const groupByRegion = (hits) => {
  const m = new Map();
  for (const h of hits) {
    if (!h.id) continue;
    if (!m.has(h.id)) m.set(h.id, []);
    m.get(h.id).push(h);
  }
  return m;
};
const fused = [...groupByRegion(anchorHits)]
  .map(([id, hits]) => ({ id, hits, names: [...new Set(hits.map((h) => h.name))] }))
  .filter((f) => f.names.length > 1);

const repairs = [];
for (const f of fused) {
  const seeds = f.names.map((n) => f.hits.find((h) => h.name === n));
  const { groups, stranded, method } = splitFused(f.id, seeds);
  const before = regions.get(f.id);
  regions.delete(f.id);
  const made = [];
  groups.forEach((pixels, i) => {
    if (!pixels.length) return;
    const id = i === 0 ? f.id : nextRegionId++;
    for (const p of pixels) labels[p] = id;
    const r = measure(id, pixels);
    regions.set(id, r);
    made.push({ id, name: seeds[i].name, px: r.px, areaKm2: r.areaKm2 });
  });
  for (const p of stranded) labels[p] = 0;
  repairs.push({ was: f.id, wasPx: before.px, names: f.names, made, stranded: stranded.length, method });
  log(`  split region ${f.id} (${before.px.toLocaleString()} px) by ${method} into ${made.map((m) => `${m.name} ${m.px.toLocaleString()}px`).join(', ')}${stranded.length ? ` (${stranded.length} px stranded)` : ''}`);
}
if (repairs.length) log(`repaired ${repairs.length} fused regions, now ${regions.size} regions`);

// ------------------------------------------- gather evidence on the repaired map

// A split country's anchor may sit on a border pixel that ended up owned by a
// neighbour, so bind those anchors to the piece grown for them rather than
// looking them up again by position.
const splitHome = new Map();
for (const r of repairs) for (const m of r.made) splitHome.set(m.name, m.id);

anchorHits = anchors.map((a) => {
  if (splitHome.has(a.name)) return { name: a.name, id: splitHome.get(a.name), dist: 0, x: a.x + bx, y: a.y + by };
  return { name: a.name, ...regionAt(a.x + bx, a.y + by, 150) };
});
const anchorsByRegion = groupByRegion(anchorHits);
const anchorsLost = anchorHits.filter((h) => !h.id);
log(`\nanchors: ${anchorHits.length - anchorsLost.length} landed on a region, ${anchorsLost.length} lost`);
if (anchorsLost.length) log(`  lost: ${anchorsLost.map((h) => h.name).join(', ')}`);
const stillFused = [...anchorsByRegion.values()].filter((h) => new Set(h.map((x) => x.name)).size > 1);
if (stillFused.length) log(`  WARNING: ${stillFused.length} regions still hold multiple anchors`);

// City nation strings do not always match the anchor spelling exactly (the data
// carries "Rijan Bu" where the anchors say "Rijan bu"), so normalise rather than
// inventing a country that does not exist.
const canonicalName = new Map(anchors.map((a) => [a.name.toLowerCase(), a.name]));
const cityVotes = new Map();
const cityLost = [];
const cityUnknownNation = new Set();
for (const c of cities.cities) {
  const nation = canonicalName.get(String(c.nation).toLowerCase());
  if (!nation) { cityUnknownNation.add(c.nation); continue; }
  const hit = regionAt(c.x, c.y, 25);
  if (!hit.id) { cityLost.push(c); continue; }
  if (!cityVotes.has(hit.id)) cityVotes.set(hit.id, new Map());
  const m = cityVotes.get(hit.id);
  m.set(nation, (m.get(nation) || 0) + 1);
}
log(`cities: ${cities.cities.length - cityLost.length - cityUnknownNation.size} landed on a region, ${cityLost.length} lost`);
if (cityUnknownNation.size) log(`  city nations not in the country list, ignored: ${[...cityUnknownNation].join(', ')}`);

// ---------------------------------------------------------------- reconcile

const assignment = new Map();
const conflicts = [];

/** Which of two names does this region's area support? */
function areaVerdict(regionArea, a, b) {
  const ca = canonicalArea.get(a), cb = canonicalArea.get(b);
  if (!ca || !cb) return null;
  const ea = Math.abs(regionArea - ca) / ca, eb = Math.abs(regionArea - cb) / cb;
  if (eb < ea * CONFLICT_MARGIN) return { winner: b, ea, eb };
  if (ea < eb * CONFLICT_MARGIN) return { winner: a, ea, eb };
  return null;
}

for (const [id, hits] of anchorsByRegion) {
  const names = [...new Set(hits.map((h) => h.name))];
  if (names.length > 1) continue; // could not be repaired; left unassigned and reported
  const name = names[0];
  const votes = cityVotes.get(id);
  const region = regions.get(id);
  if (!votes) { assignment.set(id, { name, confidence: 'high', why: 'anchor' }); continue; }
  const top = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top[0] === name) {
    assignment.set(id, { name, confidence: 'high', why: `anchor + ${votes.get(name)} cities` });
    continue;
  }
  const verdict = areaVerdict(region.areaKm2, name, top[0]);
  if (verdict) {
    assignment.set(id, {
      name: verdict.winner,
      confidence: 'resolved',
      why: `anchor says ${name}, cities say ${top[0]}; area favours ${verdict.winner} (${(100 * (verdict.winner === name ? verdict.ea : verdict.eb)).toFixed(1)}% vs ${(100 * (verdict.winner === name ? verdict.eb : verdict.ea)).toFixed(1)}%)`,
    });
  } else {
    conflicts.push({ id, anchor: name, cities: [...votes.entries()], areaKm2: region.areaKm2 });
  }
}

// ------------------------------------------ running areas, from the anchors

const areaSoFar = new Map();
for (const [id, a] of assignment) areaSoFar.set(a.name, (areaSoFar.get(a.name) || 0) + regions.get(id).areaKm2);
const shortfallOf = (name) => (canonicalArea.get(name) ?? 0) - (areaSoFar.get(name) || 0);
const improvement = (name, add) => {
  const canon = canonicalArea.get(name);
  if (!canon) return 0;
  const have = areaSoFar.get(name) || 0;
  return Math.abs(have - canon) - Math.abs(have + add - canon);
};
const claim = (id, name, confidence, why) => {
  assignment.set(id, { name, confidence, why });
  areaSoFar.set(name, (areaSoFar.get(name) || 0) + regions.get(id).areaKm2);
};

// Regions with no anchor but some city evidence. Every one of the 172 anchors
// landed, so a region without one is an island or unclaimed land rather than
// somebody's mainland. A lone city vote is therefore not enough on its own: the
// region must also improve that country's area, or a single stray or mistagged
// city would silently double a country's size.
const cityOnlyRejected = new Map();
for (const [id, votes] of cityVotes) {
  if (assignment.has(id) || anchorsByRegion.has(id)) continue;
  const entries = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length > 1) {
    conflicts.push({ id, anchor: null, cities: entries, areaKm2: regions.get(id).areaKm2 });
    continue;
  }
  const [name, n] = entries[0];
  const r = regions.get(id);
  if (improvement(name, r.areaKm2) > 0) {
    claim(id, name, 'medium', `${n} cit${n === 1 ? 'y' : 'ies'}, no anchor, improves its area match`);
  } else {
    cityOnlyRejected.set(id, `${n} ${name} cit${n === 1 ? 'y' : 'ies'} land here, but claiming it would push ${name} to ${(100 * ((areaSoFar.get(name) || 0) + r.areaKm2) / canonicalArea.get(name)).toFixed(0)}% of its real area`);
  }
}

// ------------------------------------------------- adopt orphan islands

const adoptions = [];
const orphans = [];
const hosts = [...assignment].map(([id, a]) => ({ id, name: a.name, bbox: regions.get(id).bbox }));

// How far an orphan sits from a host's landmass, rather than from its centroid.
// Centroid distance badly misjudges large countries: an island just off the
// coast of a 1.5 million km2 nation can be thousands of km from its middle.
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
function distToHostKm(centroid, bbox) {
  const [x0, y0, x1, y1] = bbox;
  const lon = clamp(centroid[0], lonOf(x0), lonOf(x1));
  const lat = clamp(centroid[1], latOf(y1), latOf(y0));
  return haversineKm(centroid, [lon, lat]);
}

for (const r of [...regions.values()].filter((r) => !assignment.has(r.id)).sort((a, b) => b.areaKm2 - a.areaKm2)) {
  if (anchorsByRegion.has(r.id)) { orphans.push({ ...r, reason: 'holds multiple anchors, needs manual splitting' }); continue; }
  if (r.px < SPECK_PX) { orphans.push({ ...r, reason: 'speck' }); continue; }
  let pick = null;
  for (const h of hosts) {
    if (improvement(h.name, r.areaKm2) <= 0) continue;
    const km = distToHostKm(r.centroid, h.bbox);
    // Nearby land is adopted on the area test alone. Land further out is only
    // adopted when it plainly fills a hole: the country must be short by most
    // of what this region would add, which is what tells an offshore territory
    // apart from an unrelated island that merely happens to help the sums.
    const tier = km <= ISLAND_MAX_KM ? 0
      : (km <= ISLAND_FAR_KM && shortfallOf(h.name) >= ISLAND_FAR_SHARE * r.areaKm2) ? 1 : -1;
    if (tier < 0) continue;
    if (!pick || tier < pick.tier || (tier === pick.tier && km < pick.km)) pick = { name: h.name, km, tier };
  }
  if (pick) {
    claim(r.id, pick.name, 'island', pick.tier === 0
      ? `island ${pick.km.toFixed(0)} km from ${pick.name}, improves its area match`
      : `${pick.km.toFixed(0)} km from ${pick.name} but fills ${(100 * r.areaKm2 / (r.areaKm2 + Math.abs(shortfallOf(pick.name)))).toFixed(0)}% of its missing area`);
    adoptions.push({ id: r.id, px: r.px, areaKm2: r.areaKm2, ...pick });
  } else {
    orphans.push({ ...r, reason: cityOnlyRejected.get(r.id) ?? 'no nearby country whose area it would improve' });
  }
}
log(`\nislands: ${adoptions.length} adopted, ${orphans.filter((o) => o.reason !== 'speck').length} left unassigned, ${orphans.filter((o) => o.reason === 'speck').length} specks ignored`);

// ------------------------------------------------------- hand corrections

// Written by tools/label-fixer.html and committed, so a human decision is made
// once and then survives every rebuild. These win over everything above.
const IGNORE = '__ignore__';
const OVERRIDES = path.join(ROOT, 'data', 'map-label-overrides.json');
const ignoredIds = new Set();
let overrideCount = 0;
const badOverrides = [];
if (fs.existsSync(OVERRIDES)) {
  const raw = JSON.parse(fs.readFileSync(OVERRIDES, 'utf8'));
  const table = raw.overrides || raw;
  const known = new Set(anchors.map((a) => a.name));
  let byPoint = 0;
  for (const [key, entry] of Object.entries(table)) {
    if (key.startsWith('_')) continue;
    const rich = entry && typeof entry === 'object';
    const value = rich ? entry.name : entry;
    const at = rich && Array.isArray(entry.at) ? entry.at : null;

    // Resolve by position before falling back to the id. Region ids are
    // renumbered whenever the source map gains or loses land, so an id alone
    // would quietly start pointing at a different country; a point inside the
    // country stays inside it.
    let id = null;
    if (at && at.length === 2 && at[0] >= 0 && at[0] < W && at[1] >= 0 && at[1] < H) {
      const found = labels[at[1] * W + at[0]];
      if (found && regions.has(found)) { id = found; byPoint++; }
    }
    if (id === null) {
      const n = Number(key);
      if (regions.has(n)) id = n;
    }
    if (id === null) { badOverrides.push(`${key} could not be located on the current map`); continue; }

    if (value === null) assignment.delete(id);
    else if (value === IGNORE) { assignment.delete(id); ignoredIds.add(id); }
    else if (known.has(value)) assignment.set(id, { name: value, confidence: 'manual', why: 'hand correction' });
    else { badOverrides.push(`${key} names an unknown country "${value}"`); continue; }
    overrideCount++;
  }
  if (byPoint) log(`  ${byPoint} of them located by position rather than by id`);
  log(`hand corrections: ${overrideCount} applied from data/map-label-overrides.json`);
  for (const b of badOverrides) log(`  ignored: ${b}`);
} else {
  log(`hand corrections: none (no data/map-label-overrides.json yet)`);
}

// If a hand correction gives two pieces of one split the same country, then that
// split was never a real border: the second anchor was stale and sitting inside
// its neighbour. Weld the pieces back together so no phantom boundary survives
// running through the middle of a single nation.
let welded = 0;
for (const rep of repairs) {
  const groups = new Map();
  for (const m of rep.made) {
    const a = assignment.get(m.id);
    if (!a) continue;
    if (!groups.has(a.name)) groups.set(a.name, []);
    groups.get(a.name).push(m.id);
  }
  for (const [name, ids] of groups) {
    if (ids.length < 2) continue;
    const keep = Math.min(...ids);
    const pixels = ids.flatMap((id) => collectPixels(id));
    for (const p of pixels) labels[p] = keep;
    for (const id of ids) if (id !== keep) { regions.delete(id); assignment.delete(id); }
    regions.set(keep, measure(keep, pixels));
    rep.welded = (rep.welded || []).concat([{ name, ids }]);
    welded++;
    log(`  welded ${ids.length} pieces of the old region ${rep.was} back together as ${name}`);
  }
}
if (welded) log(`${welded} invented boundaries removed, now ${regions.size} regions`);

// Any split the artwork did not actually support is a boundary this pipeline
// drew itself. Those need naming plainly, not burying.
const invented = [];
for (const rep of repairs) {
  if (!rep.method.includes('area')) continue;
  const still = rep.made.filter((m) => regions.has(m.id) && assignment.has(m.id));
  const names = [...new Set(still.map((m) => assignment.get(m.id).name))];
  if (names.length > 1) invented.push({ was: rep.was, names, method: rep.method });
}

// Rebuild the orphan list, since a correction may have created or cleared one.
const whyOrphan = new Map(orphans.map((o) => [o.id, o.reason]));
const finalOrphans = [...regions.values()]
  .filter((r) => !assignment.has(r.id) && !ignoredIds.has(r.id))
  .map((r) => ({ ...r, reason: whyOrphan.get(r.id) ?? (r.px < SPECK_PX ? 'speck' : 'not identified') }));
const realOrphans = finalOrphans.filter((o) => o.reason !== 'speck');

// ---------------------------------------------------------- the area test

const byCountry = new Map(anchors.map((a) => [a.name, { name: a.name, regions: [], areaKm2: 0 }]));
for (const [id, a] of assignment) {
  if (!byCountry.has(a.name)) byCountry.set(a.name, { name: a.name, regions: [], areaKm2: 0 });
  const e = byCountry.get(a.name);
  e.regions.push(id);
  e.areaKm2 += regions.get(id).areaKm2;
}
const areaRows = [...byCountry.values()].map((e) => {
  const canon = canonicalArea.get(e.name) ?? null;
  return {
    name: e.name, regions: e.regions.length, traced: e.areaKm2, canonical: canon,
    errPct: canon ? (100 * (e.areaKm2 - canon)) / canon : null,
  };
});
const scored = areaRows.filter((r) => r.errPct !== null && r.regions > 0)
  .sort((a, b) => Math.abs(b.errPct) - Math.abs(a.errPct));
const absErrs = scored.map((r) => Math.abs(r.errPct)).sort((a, b) => a - b);
const median = absErrs[absErrs.length >> 1];
const missing = areaRows.filter((r) => r.regions === 0);

// A microstate of 230 km2 is about 18 pixels, so handing it one border pixel
// either way moves it by several per cent. Percentage error alone therefore
// makes the smallest countries look far worse than they are; the absolute area
// in dispute is the honest measure of how much of the world is misplaced.
const disputedKm2 = scored.reduce((s, r) => s + Math.abs(r.traced - r.canonical), 0);
const bigOnes = scored.filter((r) => r.canonical >= 10000);
const bigErrs = bigOnes.map((r) => Math.abs(r.errPct)).sort((a, b) => a - b);

log(`\narea test over ${scored.length} countries:`);
log(`  median error ${median.toFixed(2)}%   within 5%: ${absErrs.filter((v) => v <= 5).length}   within 10%: ${absErrs.filter((v) => v <= 10).length}`);
log(`  countries over 10,000 km2 (${bigOnes.length}): median ${bigErrs[bigErrs.length >> 1].toFixed(2)}%, within 5%: ${bigErrs.filter((v) => v <= 5).length}`);
log(`  absolute area in dispute: ${Math.round(disputedKm2).toLocaleString()} km2, ${(100 * disputedKm2 / meta.canonicalLandKm2).toFixed(2)}% of all land`);
log(`  worst 12 by percentage:`);
for (const r of scored.slice(0, 12)) {
  log(`    ${r.name.padEnd(22)} traced ${Math.round(r.traced).toString().padStart(9)}  canonical ${Math.round(r.canonical).toString().padStart(9)}  ${r.errPct > 0 ? '+' : ''}${r.errPct.toFixed(1)}%  (${r.regions} region${r.regions === 1 ? '' : 's'})`);
}
const byAbs = [...scored].sort((a, b) => Math.abs(b.traced - b.canonical) - Math.abs(a.traced - a.canonical));
log(`  worst 8 by area actually misplaced:`);
for (const r of byAbs.slice(0, 8)) {
  log(`    ${r.name.padEnd(22)} ${(r.traced > r.canonical ? '+' : '-')}${Math.round(Math.abs(r.traced - r.canonical)).toLocaleString().padStart(9)} km2  (${r.errPct > 0 ? '+' : ''}${r.errPct.toFixed(1)}%, ${r.regions} region${r.regions === 1 ? '' : 's'})`);
}
if (missing.length) log(`  ${missing.length} countries with no region: ${missing.map((m) => m.name).join(', ')}`);

// -------------------------------------------- anchors that have gone stale

// An anchor sitting inside a neighbouring country is the root cause of most
// false fusions: this pipeline sees two anchors in one blob and concludes the
// blob is two nations, then invents a border to divide them. Worth reporting
// loudly, and worth offering a corrected position for, since andah-map-coords.js
// feeds the quizzes and taggers as well as this map.
const staleAnchors = [];
for (const a of anchors) {
  const hit = regionAt(a.x + bx, a.y + by, 150);
  const asg = hit.id ? assignment.get(hit.id) : null;
  const sitsIn = asg ? asg.name : null;
  if (sitsIn === a.name) continue;
  const home = [...assignment].filter(([, v]) => v.name === a.name).map(([id]) => regions.get(id))
    .sort((p, q) => q.areaKm2 - p.areaKm2)[0];
  staleAnchors.push({
    name: a.name, sitsIn, region: hit.id, searched: hit.dist,
    suggested: home && home.interior ? { x: home.interior.x - bx, y: home.interior.y - by } : null,
  });
}
if (staleAnchors.length) {
  log(`\nstale anchors: ${staleAnchors.length} no longer sit inside their own country`);
  for (const s of staleAnchors) {
    log(`  ${s.name.padEnd(22)} sits in ${String(s.sitsIn).padEnd(22)}${s.suggested ? ` -> suggest (${s.suggested.x}, ${s.suggested.y})` : ' -> no home region to suggest from'}`);
  }
  const fixed = anchors.map((a) => {
    const s = staleAnchors.find((v) => v.name === a.name && v.suggested);
    return s ? { name: a.name, x: s.suggested.x, y: s.suggested.y } : a;
  });
  fs.writeFileSync(path.join(BUILD, 'andah-map-coords.suggested.js'),
    `// Andah country map coordinates (pixel space of map.png).\n`
    + `// Image dimensions: ${mw} x ${mh}.\n`
    + `// Suggested by tools/label-regions.cjs: ${staleAnchors.filter((s) => s.suggested).length} anchor(s) moved to sit inside their own country.\n`
    + `const andahMapCoords = ${JSON.stringify(fixed, null, 2)};\n`);
  log(`  wrote build/andah-map-coords.suggested.js`);
}

// -------------------------------------------------------------------- output

fs.writeFileSync(path.join(BUILD, 'labels-final.u16.gz'), zlib.gzipSync(Buffer.from(labels.buffer), { level: 6 }));
fs.writeFileSync(path.join(BUILD, 'regions-final.json'), JSON.stringify({
  ...meta, regionCount: regions.size, regions: [...regions.values()],
}, null, 1));
fs.writeFileSync(path.join(BUILD, 'labelled.json'), JSON.stringify({
  alignment: { bx, by, iou: alignIou },
  countries: anchors.map((a) => a.name).sort(),
  assignment: Object.fromEntries(assignment),
  unassigned: finalOrphans.map((o) => ({ id: o.id, px: o.px, areaKm2: o.areaKm2, centroid: o.centroid, interior: o.interior, reason: o.reason })),
  ignored: [...ignoredIds],
  overridesApplied: overrideCount,
  repairs, conflicts, adoptions, areaRows,
  anchorsLost: anchorsLost.map((h) => h.name),
}, null, 1));

const md = [];
const f0 = (n) => Math.round(n).toLocaleString();
md.push('# Andah map trace report', '');
md.push(`Source \`${meta.source}\`, ${W}x${H} equirectangular.  `);
md.push(`Regions **${regions.size}**  ·  countries expected **${anchors.length}**  ·  identified **${new Set([...assignment.values()].map((a) => a.name)).size}**  ·  anchor alignment IoU **${alignIou.toFixed(4)}**`, '');
md.push('## Area check', '');
md.push(`Traced land **${f0(meta.tracedLandKm2)} km²** against a canonical **${meta.canonicalLandKm2.toLocaleString()} km²**, a difference of **${(100 * (meta.tracedLandKm2 - meta.canonicalLandKm2) / meta.canonicalLandKm2).toFixed(2)}%**. Median per-country error **${median.toFixed(2)}%**, with ${absErrs.filter((v) => v <= 5).length} of ${scored.length} within 5%.`, '');
md.push('| Country | Regions | Traced km² | Canonical km² | Error |', '|---|--:|--:|--:|--:|');
for (const r of scored.slice(0, 25)) md.push(`| ${r.name} | ${r.regions} | ${f0(r.traced)} | ${f0(r.canonical)} | ${r.errPct > 0 ? '+' : ''}${r.errPct.toFixed(1)}% |`);
md.push('');
if (repairs.length) {
  md.push('## Fused countries repaired', '', 'The source map has a gap in the border line at each of these, so the countries flood-filled into one region. Where the artwork provides a boundary it has been closed and followed; where it does not, the land is shared out by known area instead.', '');
  for (const r of repairs) md.push(`- region ${r.was} (${r.wasPx.toLocaleString()} px), ${r.method}, into ${r.made.map((m) => `**${m.name}** ${m.px.toLocaleString()} px`).join(', ')}${r.stranded ? ` — ${r.stranded} px stranded` : ''}${r.welded ? ` — later welded back as ${r.welded.map((w) => w.name).join(', ')}` : ''}`);
  md.push('', 'Worth closing these gaps in the source artwork so the repair is not needed next time.', '');
}
if (invented.length) {
  md.push('## Boundaries this pipeline had to invent', '',
    'There is no border drawn between these countries anywhere in the source map, so their shared boundary is a guess sized by their known areas, not your artwork. Draw the line in the source map and it will be followed exactly on the next run.', '');
  for (const i of invented) md.push(`- **${i.names.join('** / **')}** (old region ${i.was})`);
  md.push('');
}
if (conflicts.length) {
  md.push('## Unresolved conflicts', '', 'Anchor and city data disagree and the area test could not settle it.', '');
  for (const c of conflicts) md.push(`- region ${c.id} (${f0(c.areaKm2)} km²): anchor ${c.anchor ?? '(none)'}, cities ${c.cities.map(([n, k]) => `${n} ×${k}`).join(', ')}`);
  md.push('');
}
if (anchorsLost.length) md.push('## Anchors that landed in open water', '', ...anchorsLost.map((h) => `- ${h.name}`), '');
if (staleAnchors.length) {
  md.push('## Stale anchors', '',
    'These points in `js/andah-map-coords.js` no longer sit inside the country they name. That is what makes this pipeline mistake one country for two and invent a border between them, so fixing these is the single highest-value correction to the source data. A corrected file is written to `build/andah-map-coords.suggested.js`.', '');
  md.push('| Anchor | Actually sits in | Suggested position |', '|---|---|---|');
  for (const s of staleAnchors) {
    md.push(`| ${s.name} | ${s.sitsIn ?? 'open water'} | ${s.suggested ? `${s.suggested.x}, ${s.suggested.y}` : 'no home region found'} |`);
  }
  md.push('');
}
if (missing.length) md.push('## Countries with no region', '', ...missing.map((m) => `- ${m.name}`), '');
md.push('## Unassigned land', '', `${realOrphans.length} regions above ${SPECK_PX} px could not be attributed, plus ${finalOrphans.length - realOrphans.length} specks below that. These render neutral and are not clickable.${overrideCount ? ` ${overrideCount} hand correction${overrideCount === 1 ? '' : 's'} applied; ${ignoredIds.size} region${ignoredIds.size === 1 ? '' : 's'} marked as artefacts.` : ''}`, '');
md.push('| Region | px | km² | Centroid lon,lat | Why |', '|--:|--:|--:|---|---|');
for (const o of realOrphans.sort((a, b) => b.areaKm2 - a.areaKm2).slice(0, 40)) {
  md.push(`| ${o.id} | ${o.px.toLocaleString()} | ${f0(o.areaKm2)} | ${o.centroid[0].toFixed(1)}, ${o.centroid[1].toFixed(1)} | ${o.reason} |`);
}
md.push('');
if (adoptions.length) md.push('## Islands adopted', '', ...adoptions.sort((a, b) => b.areaKm2 - a.areaKm2).slice(0, 30).map((a) => `- region ${a.id} (${a.px.toLocaleString()} px) to **${a.name}**, ${a.km.toFixed(0)} km away`), '');
fs.writeFileSync(path.join(BUILD, 'MAP_TRACE_REPORT.md'), md.join('\n'));

// Preview: a colour per country, with anything unidentified in hot magenta so
// it cannot be mistaken for a real nation.
{
  const PW = 2400, PH = Math.round((H * PW) / W);
  const rgb = new Uint8Array(PW * PH * 3);
  const hueOf = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; };
  const hsv = (h, s, v) => {
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
      : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  };
  const maxId = Math.max(...regions.keys());
  const lut = new Uint8Array((maxId + 1) * 3);
  for (const r of regions.values()) {
    const a = assignment.get(r.id);
    const [cr, cg, cb] = a ? hsv(hueOf(a.name), 0.5, a.name.charCodeAt(0) % 2 ? 0.95 : 0.72) : [255, 0, 170];
    lut[r.id * 3] = cr; lut[r.id * 3 + 1] = cg; lut[r.id * 3 + 2] = cb;
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
  png.writeRGB(path.join(BUILD, 'labelled-preview.png'), PW, PH, rgb);
}

log(`\nwrote build/labels-final.u16.gz, build/regions-final.json, build/labelled.json, build/MAP_TRACE_REPORT.md, build/labelled-preview.png`);
log(`assigned ${assignment.size} of ${regions.size} regions to ${new Set([...assignment.values()].map((a) => a.name)).size} of ${anchors.length} countries`);
