/**
 * build-geojson.cjs - Stage 4 of the Andah map pipeline.
 *
 * Turns the labelled raster into real vector geometry: one MultiPolygon per
 * country, in longitude and latitude, ready for d3 to project onto a flat map
 * or a globe.
 *
 * The important part is topology. Tracing each country's outline separately and
 * simplifying it would move a shared border by a different amount on each side,
 * cracking every frontier open with hairline gaps of background showing
 * through. Instead the boundary is first pulled apart into *arcs*: chains of
 * edges that separate the same pair of countries all the way along. Each arc is
 * simplified once and used by both its neighbours, so a border stays a single
 * shared line no matter how hard it is simplified.
 *
 * Coordinates come from the corner lattice between pixels rather than pixel
 * centres, so a country's edge sits exactly where the raster says it does.
 *
 * Outputs:
 *   data/andah-countries.geojson   one Feature per country
 *   build/geojson-report.md        vector-versus-canonical area check
 *
 * Usage: node --max-old-space-size=6144 tools/build-geojson.cjs [tolerance]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const R_KM = 6371.0;
/** Visvalingam threshold in square pixels. Larger drops more detail. */
const TOLERANCE = Number(process.argv[2] || 0.25);
/** Rings smaller than this in pixels keep every point; islands vanish otherwise. */
const TINY_RING_PX = 400;
const YEAR = 1765;

const log = (...a) => console.log(...a);

// ------------------------------------------------------------------- inputs

const meta = JSON.parse(fs.readFileSync(path.join(BUILD, 'regions-final.json'), 'utf8'));
const labelled = JSON.parse(fs.readFileSync(path.join(BUILD, 'labelled.json'), 'utf8'));
const labels = new Uint16Array(zlib.gunzipSync(fs.readFileSync(path.join(BUILD, 'labels-final.u16.gz'))).buffer);
const W = meta.width, H = meta.height;
const LW = W + 1; // lattice is one wider and one taller than the pixel grid

const names = [null]; // index 0 means "nobody"
const indexOf = new Map();
for (const name of labelled.countries) { indexOf.set(name, names.length); names.push(name); }

const owner = new Uint16Array(W * H);
{
  const regionToCountry = new Uint16Array(Math.max(...meta.regions.map((r) => r.id)) + 1);
  for (const [id, a] of Object.entries(labelled.assignment)) regionToCountry[+id] = indexOf.get(a.name) || 0;
  for (let p = 0; p < W * H; p++) owner[p] = regionToCountry[labels[p]];
}
log(`${W}x${H} raster, ${names.length - 1} countries`);

const at = (x, y) => (x < 0 || x >= W || y < 0 || y >= H ? 0 : owner[y * W + x]);

// --------------------------------------------------------- boundary lattice

// Bit per direction out of a lattice point: 1 east, 2 south, 4 west, 8 north.
const E = 1, S = 2, WST = 4, N = 8;
const deg = new Uint8Array(LW * (H + 1));
let edgeCount = 0;
for (let j = 0; j <= H; j++) {
  const base = j * LW;
  for (let i = 0; i <= W; i++) {
    // Edge east, from (i,j) to (i+1,j), separates the pixel above from the one below.
    if (i < W && at(i, j - 1) !== at(i, j)) {
      deg[base + i] |= E;
      deg[base + i + 1] |= WST;
      edgeCount++;
    }
    // Edge south, from (i,j) to (i,j+1), separates the pixel left from the one right.
    if (j < H && at(i - 1, j) !== at(i, j)) {
      deg[base + i] |= S;
      deg[base + LW + i] |= N;
      edgeCount++;
    }
  }
}
log(`boundary lattice: ${edgeCount.toLocaleString()} edges`);

const POP = new Uint8Array(16);
for (let m = 0; m < 16; m++) POP[m] = (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);

// Mark junctions now, while every edge is still present. Walking an arc clears
// the edges it consumes, so a junction that has already lost one would stop
// looking like a junction and two separate arcs would be run together.
const NODE = 16;
let nodeCount = 0;
for (let p = 0; p < deg.length; p++) {
  const d = deg[p];
  if (d && POP[d] !== 2) { deg[p] |= NODE; nodeCount++; }
}
log(`  ${nodeCount.toLocaleString()} junctions`);

/** Which countries lie either side of a step, in the direction of travel. */
function sides(i, j, dir) {
  if (dir === E) return [at(i, j - 1), at(i, j)];
  if (dir === S) return [at(i, j), at(i - 1, j)];
  if (dir === WST) return [at(i - 1, j), at(i - 1, j - 1)];
  return [at(i - 1, j - 1), at(i, j - 1)]; // north
}
const STEP = { [E]: 1, [S]: LW, [WST]: -1, [N]: -LW };
const BACK = { [E]: WST, [S]: N, [WST]: E, [N]: S };

// --------------------------------------------------------------- walk arcs

// An arc runs from one junction to the next. Junctions are lattice points where
// the boundary does anything other than pass straight through: three or four
// ways meeting, or a dead end.
const arcs = [];
const pick = (m) => (m & E ? E : m & S ? S : m & WST ? WST : N);

function walk(start, dir) {
  const pts = [start];
  let p = start, d = dir;
  const [left, right] = sides(p % LW, (p / LW) | 0, d);
  const startDir = d;
  for (;;) {
    deg[p] &= ~d;                    // consume the edge from both ends
    p += STEP[d];
    deg[p] &= ~BACK[d];
    pts.push(p);
    if (deg[p] & NODE) break;        // a junction always ends an arc
    const m = deg[p] & 15;
    if (m === 0) break;              // closed back on itself
    d = pick(m);
  }
  arcs.push({ pts, left, right, startDir, endDir: d });
}

for (let p = 0; p < deg.length; p++) {
  if (!(deg[p] & NODE)) continue;
  while (deg[p] & 15) walk(p, pick(deg[p] & 15));
}
// Whatever is left forms rings with no junction at all, such as an island
// coastline dividing one country from the sea. Start those anywhere.
for (let p = 0; p < deg.length; p++) {
  while (deg[p] & 15) walk(p, pick(deg[p] & 15));
}
log(`arcs: ${arcs.length.toLocaleString()}, ${arcs.reduce((s, a) => s + a.pts.length, 0).toLocaleString()} points before simplifying`);

// ------------------------------------------------------------- simplify arcs

/** Visvalingam-Whyatt: drop the point that changes the shape least, repeatedly. */
function simplify(pts, tolerance) {
  const n = pts.length;
  if (n <= 3) return pts;
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let k = 0; k < n; k++) { x[k] = pts[k] % LW; y[k] = (pts[k] / LW) | 0; }
  const prev = new Int32Array(n), next = new Int32Array(n), alive = new Uint8Array(n).fill(1);
  for (let k = 0; k < n; k++) { prev[k] = k - 1; next[k] = k + 1; }

  const areaAt = (k) => {
    const a = prev[k], b = next[k];
    if (a < 0 || b >= n) return Infinity;
    return Math.abs((x[a] - x[k]) * (y[b] - y[k]) - (x[b] - x[k]) * (y[a] - y[k])) / 2;
  };
  // Lazy heap: stale entries are recognised by a mismatched area and skipped.
  const heap = [];
  const push = (k, v) => {
    heap.push({ k, v });
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p].v <= heap[c].v) break;
      [heap[p], heap[c]] = [heap[c], heap[p]]; c = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1, r = l + 1;
        let s = c;
        if (l < heap.length && heap[l].v < heap[s].v) s = l;
        if (r < heap.length && heap[r].v < heap[s].v) s = r;
        if (s === c) break;
        [heap[s], heap[c]] = [heap[c], heap[s]]; c = s;
      }
    }
    return top;
  };
  const cur = new Float64Array(n);
  for (let k = 1; k < n - 1; k++) { cur[k] = areaAt(k); push(k, cur[k]); }

  let live = n;
  while (heap.length && live > 3) {
    const { k, v } = pop();
    if (!alive[k] || v !== cur[k]) continue;   // stale
    if (v > tolerance) break;
    alive[k] = 0; live--;
    next[prev[k]] = next[k];
    prev[next[k]] = prev[k];
    for (const m of [prev[k], next[k]]) {
      if (m > 0 && m < n - 1 && alive[m]) { cur[m] = areaAt(m); push(m, cur[m]); }
    }
  }
  const out = [];
  for (let k = 0; k < n; k++) if (alive[k]) out.push(pts[k]);
  return out;
}

let kept = 0;
for (const a of arcs) {
  a.pts = a.pts.length > TINY_RING_PX / 8 ? simplify(a.pts, TOLERANCE) : a.pts;
  kept += a.pts.length;
}
log(`after simplifying at ${TOLERANCE} px^2: ${kept.toLocaleString()} points`);

// --------------------------------------------------------------- make rings

// For each country gather its arcs, oriented so that the country is on the left,
// then chain them end to end into closed rings.
const byCountry = new Map();
const addArc = (c, index, reversed) => {
  if (!c) return;
  if (!byCountry.has(c)) byCountry.set(c, []);
  byCountry.get(c).push({ index, reversed });
};
arcs.forEach((a, index) => { addArc(a.left, index, false); addArc(a.right, index, true); });
{
  const owners = new Set();
  for (const a of arcs) { owners.add(a.left); owners.add(a.right); }
  const oceanOnly = arcs.filter((a) => !a.left || !a.right).length;
  log(`  arcs touch ${owners.size - (owners.has(0) ? 1 : 0)} distinct countries; ${oceanOnly} have open sea on one side`);
  log(`  byCountry has ${byCountry.size} entries`);
  const big = arcs.slice().sort((x, y) => y.pts.length - x.pts.length).slice(0, 5);
  log(`  longest arcs: ${big.map((a) => `${a.pts.length}pts ${names[a.left] || 'sea'}|${names[a.right] || 'sea'}`).join(', ')}`);
}

const ptsOf = (ref) => {
  const p = arcs[ref.index].pts;
  return ref.reversed ? p.slice().reverse() : p;
};
const startPt = (ref) => { const a = arcs[ref.index]; return ref.reversed ? a.pts[a.pts.length - 1] : a.pts[0]; };
const endPt = (ref) => { const a = arcs[ref.index]; return ref.reversed ? a.pts[0] : a.pts[a.pts.length - 1]; };
const startDir = (ref) => { const a = arcs[ref.index]; return ref.reversed ? BACK[a.endDir] : a.startDir; };
const endDir = (ref) => { const a = arcs[ref.index]; return ref.reversed ? BACK[a.startDir] : a.endDir; };

/** Clockwise on screen, where x runs right and y runs down. */
const CW = { [E]: S, [S]: WST, [WST]: N, [N]: E };

/**
 * Chain arcs into closed rings by tracing faces of the boundary graph.
 *
 * Where several of a country's arcs meet at one junction, picking any of them
 * produces rings that cross themselves and swallow their neighbours. The right
 * one is found by turning: arrive at the junction, face back the way you came,
 * then sweep clockwise to the first arc leaving it. That keeps the country on
 * your left the whole way round and closes each ring exactly once.
 */
let unclosed = 0;
function ringsFor(refs) {
  const byStart = new Map();
  for (const ref of refs) {
    const s = startPt(ref);
    if (!byStart.has(s)) byStart.set(s, []);
    byStart.get(s).push(ref);
  }
  const rings = [];
  const used = new Set();
  for (const seed of refs) {
    if (used.has(seed)) continue;
    const ring = [];
    const home = startPt(seed);
    let cur = seed, closed = false;
    for (let guard = 0; guard < refs.length + 2; guard++) {
      used.add(cur);
      const p = ptsOf(cur);
      for (let k = 0; k < p.length - 1; k++) ring.push(p[k]);
      const here = endPt(cur);
      if (here === home) { closed = true; break; }
      const options = (byStart.get(here) || []).filter((r) => !used.has(r));
      if (!options.length) break;
      let d = BACK[endDir(cur)];
      let next = null;
      for (let t = 0; t < 4 && !next; t++) {
        d = CW[d];
        next = options.find((r) => startDir(r) === d) || null;
      }
      cur = next || options[0];
    }
    if (closed && ring.length >= 3) rings.push(ring);
    else if (!closed) unclosed++;
  }
  return rings;
}

// --------------------------------------------------------- lattice to sphere

const lonOf = (i) => (i / W) * 360 - 180;
const latOf = (j) => 90 - (j / H) * 180;
const toLngLat = (ring) => ring.map((p) => [
  +lonOf(p % LW).toFixed(4),
  +latOf((p / LW) | 0).toFixed(4),
]);

/** Plain shoelace in degrees, used only to decide which way a ring winds. */
function planarSigned(ring) {
  let s = 0;
  for (let k = 0, n = ring.length, m = n - 1; k < n; m = k++) {
    s += ring[m][0] * ring[k][1] - ring[k][0] * ring[m][1];
  }
  return s / 2;
}

/** Area on the sphere in km^2, magnitude only. */
const sphericalAbs = (coords) => Math.abs(sphericalArea(coords));

/** Signed area on the sphere in km^2. */
function sphericalArea(coords) {
  let total = 0;
  const rad = Math.PI / 180;
  for (let k = 0, n = coords.length; k < n; k++) {
    const [lon1, lat1] = coords[k];
    const [lon2, lat2] = coords[(k + 1) % n];
    total += (lon2 - lon1) * rad * (2 + Math.sin(lat1 * rad) + Math.sin(lat2 * rad));
  }
  return (total * R_KM * R_KM) / 2;
}

function contains(ring, pt) {
  let inside = false;
  for (let k = 0, n = ring.length, m = n - 1; k < n; m = k++) {
    const [xi, yi] = ring[k], [xj, yj] = ring[m];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ------------------------------------------------------------------ features

const features = [];
const areaCheck = [];
const emptyCountries = [];
for (const [c, refs] of byCountry) {
  const name = names[c];
  const rings = ringsFor(refs).map(toLngLat).filter((r) => r.length >= 3);
  if (!rings.length) { emptyCountries.push(`${name} (${refs.length} arcs)`); continue; }

  // Outer ring or hole is decided by nesting, not by winding. Which way round a
  // ring comes out depends on the direction the boundary happened to be walked,
  // so testing its sign would silently invert whole countries; how many larger
  // rings of the same country enclose it cannot be got wrong that way.
  const sorted = rings
    .map((r) => ({ ring: r, area: sphericalAbs(r) }))
    .sort((a, b) => b.area - a.area);
  const depth = sorted.map((r, k) => sorted.slice(0, k).filter((o) => contains(o.ring, r.ring[0])).length);
  const polys = [];
  sorted.forEach((r, k) => { if (depth[k] % 2 === 0) polys.push({ outer: r.ring, area: r.area, holes: [] }); });
  if (!polys.length) { emptyCountries.push(`${name} (${rings.length} rings, none outer)`); continue; }
  sorted.forEach((r, k) => {
    if (depth[k] % 2 === 0) return;
    let host = null;
    for (const p of polys) if (contains(p.outer, r.ring[0]) && (!host || p.area < host.area)) host = p;
    if (host) host.holes.push(r.ring);
  });

  // GeoJSON wants exterior rings counterclockwise and holes clockwise.
  const close = (r) => (r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r : r.concat([r[0]]));
  const wind = (r, ccw) => (planarSigned(r) > 0) === ccw ? r : r.slice().reverse();
  const coordinates = polys.map((p) => [
    close(wind(p.outer, true)),
    ...p.holes.map((h) => close(wind(h, false))),
  ]);

  const areaKm2 = polys.reduce((s, p) => s + p.area - p.holes.reduce((t, h) => t + sphericalAbs(h), 0), 0);
  features.push({
    type: 'Feature',
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    properties: { name, areaKm2: Math.round(areaKm2), polygons: coordinates.length },
    geometry: { type: 'MultiPolygon', coordinates },
  });
  areaCheck.push({ name, vector: areaKm2, polygons: coordinates.length, holes: polys.reduce((s, p) => s + p.holes.length, 0) });
}
features.sort((a, b) => a.properties.name.localeCompare(b.properties.name));
if (unclosed) log(`WARNING: ${unclosed} rings never closed`);
if (emptyCountries.length) log(`WARNING: ${emptyCountries.length} countries produced no polygon: ${emptyCountries.slice(0, 10).join(', ')}`);

// -------------------------------------------------------------------- verify

const rasterArea = new Map();
for (const row of labelled.areaRows) rasterArea.set(row.name, { traced: row.traced, canonical: row.canonical });
let worstVsRaster = 0, worstName = '';
for (const r of areaCheck) {
  const t = rasterArea.get(r.name);
  if (!t || !t.traced) continue;
  const drift = Math.abs(r.vector - t.traced) / t.traced;
  if (drift > worstVsRaster) { worstVsRaster = drift; worstName = r.name; }
}
const vsCanon = areaCheck.map((r) => {
  const t = rasterArea.get(r.name);
  return t && t.canonical ? { name: r.name, pct: (100 * (r.vector - t.canonical)) / t.canonical } : null;
}).filter(Boolean).sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
const med = vsCanon.map((r) => Math.abs(r.pct)).sort((a, b) => a - b)[vsCanon.length >> 1];

const out = { type: 'FeatureCollection', year: YEAR, radiusKm: R_KM, features };
const outPath = path.join(ROOT, 'data', 'andah-countries.geojson');
fs.writeFileSync(outPath, JSON.stringify(out));
const bytes = fs.statSync(outPath).size;
const points = features.reduce((s, f) => s + f.geometry.coordinates.reduce((t, poly) => t + poly.reduce((u, r) => u + r.length, 0), 0), 0);

log(`\ncountries in output : ${features.length}`);
log(`polygons            : ${features.reduce((s, f) => s + f.geometry.coordinates.length, 0).toLocaleString()}`);
log(`points              : ${points.toLocaleString()}`);
log(`file size           : ${(bytes / 1048576).toFixed(2)} MB`);
log(`\nvector vs raster    : worst drift ${(100 * worstVsRaster).toFixed(2)}% (${worstName})`);
log(`vector vs canonical : median ${med.toFixed(2)}%`);
log(`  worst 8: ${vsCanon.slice(0, 8).map((r) => `${r.name} ${r.pct > 0 ? '+' : ''}${r.pct.toFixed(0)}%`).join(', ')}`);

const md = ['# Andah GeoJSON build', '',
  `Simplified at ${TOLERANCE} px², ${features.length} countries, ${points.toLocaleString()} points, ${(bytes / 1048576).toFixed(2)} MB.`, '',
  `Geometry is topological: borders are shared arcs simplified once, so neighbours cannot crack apart.`, '',
  `**Vector against raster**: worst drift ${(100 * worstVsRaster).toFixed(2)}% (${worstName}). This measures what simplification cost, and nothing else.`, '',
  `**Vector against canon**: median ${med.toFixed(2)}%.`, '',
  '| Country | Vector km² | Canonical km² | Error | Polygons |', '|---|--:|--:|--:|--:|'];
for (const r of vsCanon.slice(0, 25)) {
  const a = areaCheck.find((x) => x.name === r.name);
  const t = rasterArea.get(r.name);
  md.push(`| ${r.name} | ${Math.round(a.vector).toLocaleString()} | ${Math.round(t.canonical).toLocaleString()} | ${r.pct > 0 ? '+' : ''}${r.pct.toFixed(1)}% | ${a.polygons} |`);
}
fs.writeFileSync(path.join(BUILD, 'geojson-report.md'), md.join('\n'));
log(`\nwrote data/andah-countries.geojson and build/geojson-report.md`);
