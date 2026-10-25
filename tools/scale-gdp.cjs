/**
 * Bring data/countries.json and data/andah-map-data.json onto the 8x economy.
 *
 * The editorial rescale (commit 2864e2a) multiplied every country's GDP by 8 and
 * reached js/andah-stats.js and data/gdp-history.json, but not these two files.
 * That left the site disagreeing with itself: Richer or Poorer put Estijan at
 * 40.46 trillion PPP while the GDP Explorer and the atlas said 5.06 trillion.
 * The wiki agrees with the larger figures (GDP_PPP = 40.456 trillion,
 * per capita = 155,120, nominal = 22.44 trillion), so those are the target.
 *
 * The source workbook cannot be rebuilt from: the copy carrying the rescale has
 * been through a tool that dropped every formula's cached value, so Population,
 * GDP (Nominal), Per (PPP), Area (Mi) and all four military columns read as
 * null for every nation. Rebuilding from it would blank them site-wide.
 *
 * Military scales too. "Per GDP" is military spending over nominal GDP - for
 * Estijan 93,690,903,364 / 2,805,116,867,175 = 0.0334, which is exactly what
 * that column says - and it is unchanged in the rescaled workbook. Holding the
 * ratio while GDP goes up eightfold means the military figures went up with it.
 *
 * Ranks are untouched: multiplying every value by the same positive number
 * cannot reorder them.
 *
 * usage: node tools/scale-gdp.cjs [--check]
 */
const fs = require('fs');
const path = require('path');

const FACTOR = 8;
const ROOT = path.join(__dirname, '..');
const CHECK = process.argv.includes('--check');

// Monetary columns in the merged spreadsheet dump. Population, area, density,
// KTDI, GDI and the Per GDP ratio are deliberately absent.
const SHEET_KEYS = [
  'GDP (Nominal)', 'Per (NOM)', 'GDP (PPP)', 'Per (PPP)',
  'Military NOM', 'Military NOM USD ', 'Military PPP', 'Military PPP USD',
];
const MAP_KEYS = [
  'gdpNominal', 'gdpPPP', 'gdpNomPerCapita', 'gdpPPPPerCapita', 'militaryNominal',
];

// Rows in countries.json that are not countries but are still economic totals,
// plus four misspellings the workbook carries as duplicate country rows.
const ALSO = new Set(['totals', 'south ayuma', 'geaiya', 'laseltsh', 'praesy']);

const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const write = (p, v) => fs.writeFileSync(path.join(ROOT, p), JSON.stringify(v, null, 2) + '\n');

const mapData = read('data/andah-map-data.json');
const countryNames = new Set(Object.keys(mapData.countries).map((n) => n.toLowerCase()));

// Guard: refuse to run twice. Estijan is the anchor because the wiki states its
// figures outright.
const before = mapData.countries.Estijan.metrics.gdpPPP;
const TARGET = 40462185730429.76;
if (Math.abs(before - TARGET) < 1) {
  console.log('already scaled (Estijan PPP is ' + before + '); nothing to do');
  process.exit(0);
}
if (Math.abs(before * FACTOR - TARGET) > 1) {
  console.error('unexpected starting value for Estijan PPP: ' + before);
  console.error('expected ' + (TARGET / FACTOR) + ' so that x8 lands on the wiki figure');
  process.exit(1);
}

let touchedRows = 0, touchedCells = 0;

// ---- the merged spreadsheet dump ------------------------------------------
const cj = read('data/countries.json');
for (const row of cj.countries) {
  const name = String(row.name || '').toLowerCase();
  if (!countryNames.has(name) && !ALSO.has(name)) continue;
  if (!row.metrics) continue;
  let hit = false;
  for (const k of SHEET_KEYS) {
    const v = row.metrics[k];
    if (typeof v === 'number' && Number.isFinite(v)) { row.metrics[k] = v * FACTOR; touchedCells++; hit = true; }
  }
  if (hit) touchedRows++;
}

// ---- the atlas / panel dataset --------------------------------------------
let mapRows = 0;
for (const name of Object.keys(mapData.countries)) {
  const m = mapData.countries[name].metrics;
  if (!m) continue;
  let hit = false;
  for (const k of MAP_KEYS) {
    const v = m[k];
    if (typeof v === 'number' && Number.isFinite(v)) { m[k] = v * FACTOR; touchedCells++; hit = true; }
  }
  if (hit) mapRows++;
}

if (CHECK) {
  console.log('DRY RUN — nothing written');
} else {
  write('data/countries.json', cj);
  write('data/andah-map-data.json', mapData);
}

const e = mapData.countries.Estijan.metrics;
console.log('countries.json rows scaled: ' + touchedRows);
console.log('andah-map-data rows scaled: ' + mapRows);
console.log('cells changed: ' + touchedCells);
console.log('Estijan now: PPP ' + (e.gdpPPP / 1e12).toFixed(3) + 'T (wiki says 40.456T)'
  + ', nominal ' + (e.gdpNominal / 1e12).toFixed(2) + 'T (wiki says 22.44T)'
  + ', per head PPP ' + Math.round(e.gdpPPPPerCapita) + ' (wiki says 155,120)');
