// build-barrace.js — build the data for the "bar chart race" video:
// Top-N Andah nations by Real GDP per Capita, Andah years 1700–1765 (Earth 1950–2015).
//
// Reuses the exact per-capita math from js/gdp-explorer.js (computeCountry): per-capita
// compounds BACKWARD from each nation's 2015 anchor —
//   perCap(2015) = override ?? anchor
//   perCap(Y-1)  = override ?? perCap(Y) / (1 + growth(Y))   [blank growth = 0%]
// so values match the on-site GDP Explorer exactly. Growth/overrides are keyed by EARTH year.
//
// Inputs : data/gdp-history.json  {countries:[{name, anchor, rows:[[earthYear, year, pop]]}]}  (newest-first)
//          data/gdp-growth.json   {countries:{<name>:{growth:{<earthYear>:rate}, overrides:{<earthYear>:$}}}}
//          data/countries.json    {countries:[{name, categorical:{Continent}}]}  (for bar colours)
//          flags/<Name>.png       one per nation
// Output : data/barrace-gdppc.json
//   { metric, unit, years:[1700..1765], nations:[{name, flag, color, values:{<year>:$perCap}}] }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

// ---- colour mapping (ported verbatim from js/gdp-explorer.js) ----
const PALETTE = ['#4269d0', '#efb118', '#ff725c', '#6cc5b0', '#3ca951', '#ff8ab7', '#a463f2', '#97bbf5', '#9c6b4e', '#9498a0'];
const CONTINENT_COLORS = {
    Ayuma: '#e4463c', Atirha: '#4269d0', Massir: '#3ca951', Mahea: '#9c6b4e',
    Quia: '#ff8ab7', Acrola: '#efb118', 'New Ayre': '#97bbf5',
    'Ayuma/Acrola': '#6cc5b0', Unknown: '#9498a0', 'N/a': '#9498a0',
};

function buildColorLookup(countries) {
    const continentOf = new Map();
    for (const c of countries) {
        const cont = c.categorical && (c.categorical.Continent || c.categorical.continent);
        if (c.name && cont) continentOf.set(c.name, cont);
    }
    const names = [...new Set(continentOf.values())].sort();
    const continentColor = new Map();
    names.forEach((n, i) => continentColor.set(n, CONTINENT_COLORS[n] || PALETTE[i % PALETTE.length]));
    return (name) => {
        const cont = continentOf.get(name) || 'Unknown';
        return { continent: cont, color: continentColor.get(cont) || CONTINENT_COLORS.Unknown };
    };
}

// ---- the per-capita chain (ported from computeCountry in js/gdp-explorer.js) ----
// rows are newest-first: rows[0] = 2015/1765 anchor year.
function computePerCap(rows, anchor) {
    const out = rows.map((r) => ({ ...r }));
    for (let i = 0; i < out.length; i++) {
        const r = out[i];
        if (i === 0) {
            r.perCap = r.h != null ? r.h : anchor;
            r.determined = r.h != null || anchor != null;
        } else {
            const prev = out[i - 1]; // newer year
            if (r.h != null) {
                r.perCap = r.h; r.determined = true;
            } else {
                const g = prev.g != null ? prev.g : 0;
                r.perCap = prev.perCap != null ? prev.perCap / (1 + g) : null;
                r.determined = prev.determined && prev.g != null;
            }
        }
    }
    return out;
}

// ---- main ----
const YEAR_MIN = 1700, YEAR_MAX = 1765; // Andah years

const history = readJSON('data/gdp-history.json').countries || [];
const growth = (readJSON('data/gdp-growth.json').countries) || {};
const countriesDoc = readJSON('data/countries.json');
const countryList = Array.isArray(countriesDoc) ? countriesDoc : (countriesDoc.countries || []);
const colorFor = buildColorLookup(countryList);

const years = [];
for (let y = YEAR_MIN; y <= YEAR_MAX; y++) years.push(y);

const nations = [];
let missingFlags = [];
let undeterminedNations = 0;

for (const h of history) {
    const g = growth[h.name] || {};
    const gGrowth = g.growth || {};
    const gOver = g.overrides || {};
    const rows = h.rows.map(([earthYear, year, pop]) => ({
        earthYear, year, pop,
        g: typeof gGrowth[earthYear] === 'number' ? gGrowth[earthYear] : null,
        h: typeof gOver[earthYear] === 'number' ? gOver[earthYear] : null,
    }));
    const computed = computePerCap(rows, h.anchor ?? null);

    const values = {};
    let anyUndetermined = false;
    for (const r of computed) {
        if (r.year < YEAR_MIN || r.year > YEAR_MAX) continue;
        if (r.perCap != null && isFinite(r.perCap) && r.perCap > 0) {
            values[r.year] = Math.round(r.perCap * 100) / 100;
            if (!r.determined) anyUndetermined = true;
        }
    }
    if (Object.keys(values).length === 0) continue; // no GDP at all (e.g. Hyelen early gap only)
    if (anyUndetermined) undeterminedNations++;

    const flagRel = `flags/${h.name}.png`;
    if (!fs.existsSync(path.join(ROOT, flagRel))) missingFlags.push(h.name);

    const { continent, color } = colorFor(h.name);
    nations.push({ name: h.name, flag: flagRel, continent, color, values });
}

nations.sort((a, b) => a.name.localeCompare(b.name));

const out = {
    metric: 'Real GDP per Capita',
    unit: '$',
    yearMin: YEAR_MIN,
    yearMax: YEAR_MAX,
    years,
    nations,
};
fs.writeFileSync(path.join(ROOT, 'data/barrace-gdppc.json'), JSON.stringify(out) + '\n');

// ---- report / sanity checks ----
const valAt = (name, year) => {
    const n = nations.find((x) => x.name === name);
    return n ? n.values[year] : undefined;
};
console.log(`Wrote data/barrace-gdppc.json`);
console.log(`  years: ${years.length} (${YEAR_MIN}–${YEAR_MAX})`);
console.log(`  nations with GDP data: ${nations.length}`);
console.log(`  nations with some undetermined (flat-placeholder) years: ${undeterminedNations}`);
console.log(`  missing flag PNGs: ${missingFlags.length}${missingFlags.length ? ' -> ' + missingFlags.join(', ') : ''}`);
console.log(`  cross-check vs workbook cached values:`);
console.log(`    Ashain 1700  = ${valAt('Ashain', 1700)}  (expect ≈ 2288.52)`);
console.log(`    Acetoa 1700  = ${valAt('Acetoa', 1700)}  (expect ≈ 457.69)`);
const top1765 = [...nations].sort((a, b) => (b.values[1765] ?? -1) - (a.values[1765] ?? -1)).slice(0, 5);
console.log(`  Top 5 by GDP/cap in 1765: ` + top1765.map((n) => `${n.name} ${n.values[1765]}`).join(' | '));
