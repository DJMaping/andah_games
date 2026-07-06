// build-gdp-history.js
// One-time migration: extracts the GDP Explorer's data OUT of
// ".xlsx files/Population Growth(2).xlsx" and into two repo JSONs, so the
// website no longer depends on the workbook (Excel is retired).
//
//   data/gdp-history.json  — fixed population substrate (read-only):
//       { countries: [ { name, anchor, rows: [[earthYear, year, pop], ...] } ] }
//     anchor = gdpPerNominal from js/andah-stats.js; rows newest-first.
//
//   data/gdp-growth.json   — sparse authored layer (DJ edits this in-browser
//     thereafter and commits it):
//       { countries: { <name>: { growth: {<year>:rate}, overrides: {<year>:$} } } }
//     Seeded from any GDP/cap growth (col G) / override $ (col H) already typed
//     in the workbook, so no prior work is lost.
//
// After running once, the JSONs are the source of truth; the .xlsx,
// scripts/add-gdp-columns.js and `npm run gdp:columns` are deprecated.
//
// Usage: node scripts/build-gdp-history.js  (or: npm run gdp:build)

import XLSX from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const XLSX_PATH = path.join(ROOT, '.xlsx files', 'Population Growth(2).xlsx');
const STATS_PATH = path.join(ROOT, 'js', 'andah-stats.js');
const HISTORY_OUT = path.join(ROOT, 'data', 'gdp-history.json');
const GROWTH_OUT = path.join(ROOT, 'data', 'gdp-growth.json');

// Summary sheets carry no single-country series — skip them (mirrors the
// SUMMARY_SHEETS set in js/gdp-explorer.js).
const SUMMARY_SHEETS = new Set(['GlobalContinent Population', 'Geoscheme Population']);

// Column layout in each country sheet (0-indexed):
//   0 earthYear · 1 fictional year · 2 population · 6 GDP/cap growth (G) · 7 override $ (H)
const C_EARTH = 0, C_YEAR = 1, C_POP = 2, C_GROWTH = 6, C_OVERRIDE = 7;

function loadAnchors() {
  const src = fs.readFileSync(STATS_PATH, 'utf8');
  const stats = new Function(`${src}; return andahStats;`)();
  return new Map(stats.map((s) => [s.name, s.gdpPerNominal]));
}

function main() {
  if (!fs.existsSync(XLSX_PATH)) {
    console.error('Workbook not found:', XLSX_PATH);
    process.exit(1);
  }
  const anchors = loadAnchors();
  const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { type: 'buffer' });

  const generatedAt = new Date().toISOString();
  const history = { generatedAt, source: 'Population Growth(2).xlsx', countries: [] };
  const growth = { generatedAt, countries: {} };

  const noAnchor = [];
  let growthCells = 0;

  for (const name of wb.SheetNames) {
    if (SUMMARY_SHEETS.has(name)) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });

    const outRows = [];
    const g = {}, ov = {};
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || typeof r[C_POP] !== 'number') break; // contiguous data rows only
      const earthYear = r[C_EARTH];
      outRows.push([earthYear, r[C_YEAR], r[C_POP]]);
      if (typeof r[C_GROWTH] === 'number') { g[earthYear] = r[C_GROWTH]; growthCells++; }
      if (typeof r[C_OVERRIDE] === 'number') { ov[earthYear] = r[C_OVERRIDE]; growthCells++; }
    }
    if (!outRows.length) continue;

    const anchor = anchors.get(name) ?? null;
    if (anchor == null) noAnchor.push(name);
    history.countries.push({ name, anchor, rows: outRows });

    if (Object.keys(g).length || Object.keys(ov).length) {
      growth.countries[name] = { growth: g, overrides: ov };
    }
  }

  fs.writeFileSync(HISTORY_OUT, JSON.stringify(history) + '\n');
  fs.writeFileSync(GROWTH_OUT, JSON.stringify(growth, null, 2) + '\n');

  console.log('--- build-gdp-history report ---');
  console.log('Countries written:', history.countries.length);
  console.log('Rows/country (first):', history.countries[0]?.rows.length ?? 0);
  console.log('Sheets with no andah-stats anchor:', noAnchor.length ? noAnchor.join(', ') : '(none)');
  console.log('Seeded growth/override cells:', growthCells,
    growthCells ? '' : '(none typed yet — author in the browser)');
  console.log('Wrote:', path.relative(ROOT, HISTORY_OUT), '+', path.relative(ROOT, GROWTH_OUT));
}

main();
