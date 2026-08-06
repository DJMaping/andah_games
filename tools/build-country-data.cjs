/**
 * build-country-data.cjs - Stage 5 of the Andah map pipeline.
 *
 * Assembles everything the map's info panel shows into one file.
 *
 * Numbers come from data/countries.json, which already carries the Janus
 * spreadsheet's computed values. Everything the spreadsheet has no column for
 * comes from the wiki itself, by reading the {{Infobox country}} at the top of
 * each article in the miraheze-local checkout: long-form name, government,
 * languages, currency, religion, establishment dates and so on.
 *
 * World ranks are computed here rather than trusted from either source, so they
 * always agree with the figures actually being displayed.
 *
 * Usage: node tools/build-country-data.cjs [path-to-miraheze-local]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WIKI = process.argv[2] || 'C:\\Users\\danny\\Documents\\miraheze-local';
const PAGES = path.join(WIKI, 'pages', 'Main');
const YEAR = 1765;

const log = (...a) => console.log(...a);

// ---------------------------------------------------------------- wikitext

/** Pull the {{Infobox country}} block out of an article, brace-balanced. */
function infoboxOf(text) {
  const start = text.search(/\{\{\s*Infobox country/i);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === '{' && text[i + 1] === '{') { depth++; i++; }
    else if (text[i] === '}' && text[i + 1] === '}') { depth--; i++; if (!depth) return text.slice(start, i + 1); }
  }
  return null;
}

/** Split an infobox into its named parameters, ignoring pipes nested inside. */
function paramsOf(block) {
  const body = block.slice(2, -2);
  const parts = [];
  let depth = 0, square = 0, cur = '';
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === '{{') { depth++; cur += two; i++; continue; }
    if (two === '}}') { depth--; cur += two; i++; continue; }
    if (two === '[[') { square++; cur += two; i++; continue; }
    if (two === ']]') { square--; cur += two; i++; continue; }
    if (body[i] === '|' && depth === 0 && square === 0) { parts.push(cur); cur = ''; continue; }
    cur += body[i];
  }
  parts.push(cur);
  const out = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    out[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim();
  }
  return out;
}

/** Wikitext to plain readable text. */
function clean(v) {
  if (!v) return '';
  return String(v)
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[\s\S]*?<\/ref>/gi, '')
    .replace(/\{\{\s*(cite|Cite)[\s\S]*?\}\}/g, '')
    .replace(/\{\{\s*tree list(\/end)?\s*\}\}/gi, '')
    .replace(/\{\{\s*(increase|decrease|steady|increaseNeutral|decreaseNeutral)\s*\}\}/gi, '')
    .replace(/\{\{\s*lahn\s*\}\}/gi, '')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/<br\s*\/?>/gi, ' · ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/''+/g, '')
    .replace(/^\*+\s*/gm, '')
    .replace(/\s*·\s*·\s*/g, ' · ')
    .replace(/\s+/g, ' ')
    .replace(/^[·\s]+|[·\s]+$/g, '')
    .trim();
}

// ------------------------------------------------------------------- inputs

const geo = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'andah-countries.geojson'), 'utf8'));
const countryNames = geo.features.map((f) => f.properties.name);
log(`${countryNames.length} countries from the GeoJSON`);

// countries.json holds more than one record per country: the real one, plus an
// ALL-CAPS or differently-cased duplicate carrying no figures at all. Keying on
// the lowercased name and letting later entries win silently replaced ten
// countries, Estijan and Areoix Lie among them, with empty records. Keep
// whichever entry actually has the most in it.
const cj = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'countries.json'), 'utf8'));
const source = new Map();
const weight = (c) => Object.keys(c.metrics || {}).length + Object.keys(c.categorical || {}).length;
let collisions = 0;
for (const c of cj.countries) {
  const key = c.name.toLowerCase();
  const held = source.get(key);
  if (!held) { source.set(key, c); continue; }
  collisions++;
  if (weight(c) > weight(held)) source.set(key, c);
}
if (collisions) log(`countries.json: ${collisions} duplicate names, kept the fullest record of each`);

const flags = new Set(fs.readdirSync(path.join(ROOT, 'flags')).map((f) => f.replace(/\.png$/i, '')));
const havePages = fs.existsSync(PAGES);
if (!havePages) log(`WARNING: ${PAGES} not found, wiki fields will be missing`);

// The panel's numeric fields, in the order they should read.
const METRICS = [
  { key: 'population', from: 'Population', label: 'Population', kind: 'int' },
  { key: 'areaKm2', from: 'Area (Km)', label: 'Area', kind: 'int', unit: 'km²' },
  { key: 'density', from: 'Density', label: 'Density', kind: 'dec1', unit: '/km²' },
  { key: 'gdpNominal', from: 'GDP (Nominal)', label: 'GDP (nominal)', kind: 'money' },
  { key: 'gdpPPP', from: 'GDP (PPP)', label: 'GDP (PPP)', kind: 'money' },
  { key: 'gdpNomPerCapita', from: 'Per (NOM)', label: 'GDP per capita (nominal)', kind: 'money0' },
  { key: 'gdpPPPPerCapita', from: 'Per (PPP)', label: 'GDP per capita (PPP)', kind: 'money0' },
  { key: 'ktdi', from: 'KTDI', label: 'Krali Development Index', kind: 'dec3' },
  { key: 'gdi', from: 'GDI', label: 'Democratic Integrity Index', kind: 'dec2' },
  { key: 'militaryNominal', from: 'Military NOM', label: 'Military spending', kind: 'money' },
];

// Infobox fields worth surfacing, and what to call them.
const WIKI_FIELDS = [
  ['longName', 'conventional_long_name'], ['nativeName', 'native_name'],
  ['largestCity', 'largest_city'], ['officialLanguages', 'official_languages'],
  ['regionalLanguages', 'regional_languages'], ['ethnicGroups', 'ethnic_groups'],
  ['religion', 'religion'], ['government', 'government_type'], ['legislature', 'legislature'],
  ['upperHouse', 'upper_house'], ['lowerHouse', 'lower_house'],
  ['leaderTitle1', 'leader_title1'], ['leaderName1', 'leader_name1'],
  ['leaderTitle2', 'leader_title2'], ['leaderName2', 'leader_name2'],
  ['established', 'established'], ['currency', 'currency'], ['timeZone', 'time_zone'],
  ['drivesOn', 'drives_on'], ['cctld', 'cctld'], ['isoCode', 'iso3166code'],
  ['callingCode', 'calling_code'], ['anthem', 'national_anthem'], ['motto', 'national_motto'],
  ['dateFormat', 'date_format'], ['percentWater', 'percent_water'],
];

// ------------------------------------------------------------------ assemble

const countries = {};
let withWiki = 0, withoutFlag = [];
for (const name of countryNames) {
  const src = source.get(name.toLowerCase()) || { metrics: {}, categorical: {} };
  const m = src.metrics || {}, cat = src.categorical || {};
  const feature = geo.features.find((f) => f.properties.name === name);

  const metrics = {};
  for (const spec of METRICS) {
    const v = m[spec.from];
    if (typeof v === 'number' && Number.isFinite(v)) metrics[spec.key] = v;
  }
  metrics.vectorAreaKm2 = feature.properties.areaKm2;

  const entry = {
    name,
    slug: feature.id,
    wiki: `https://andah.miraheze.org/wiki/${encodeURIComponent(name.replace(/ /g, '_'))}`,
    flag: flags.has(name) ? `flags/${name}.png` : null,
    continent: cat.Continent || cat.continent || null,
    geoscheme: cat.Geoscheme || null,
    capital: cat.Capital || null,
    demonym: cat.Demonym || null,
    domain: cat.Domain || null,
    pronunciation: cat.Pronunciation || null,
    ipa: cat['IPA Use (https://ipa-reader.com/)'] || null,
    polygons: feature.properties.polygons,
    metrics,
    info: {},
  };
  if (!entry.flag) withoutFlag.push(name);

  if (havePages) {
    const file = path.join(PAGES, `${name.replace(/ /g, '_')}.wiki`);
    if (fs.existsSync(file)) {
      const box = infoboxOf(fs.readFileSync(file, 'utf8'));
      if (box) {
        const p = paramsOf(box);
        for (const [key, param] of WIKI_FIELDS) {
          const v = clean(p[param]);
          if (v) entry.info[key] = v;
        }
        // Establishment dates are a numbered series in the infobox.
        const events = [];
        for (let i = 1; i <= 6; i++) {
          const ev = clean(p[`established_event${i}`]), dt = clean(p[`established_date${i}`]);
          if (ev || dt) events.push({ event: ev, date: dt });
        }
        if (events.length) entry.info.establishedEvents = events;
        if (!entry.capital) entry.capital = clean(p.capital) || null;
        withWiki++;
      }
    }
  }
  countries[name] = entry;
}
log(`${withWiki} of ${countryNames.length} matched a wiki article`);
if (withoutFlag.length) log(`no flag file for: ${withoutFlag.join(', ')}`);

// ---------------------------------------------------------------- world rank

for (const spec of METRICS) {
  const ordered = countryNames
    .filter((n) => typeof countries[n].metrics[spec.key] === 'number')
    .sort((a, b) => countries[b].metrics[spec.key] - countries[a].metrics[spec.key]);
  ordered.forEach((n, i) => {
    countries[n].ranks = countries[n].ranks || {};
    countries[n].ranks[spec.key] = i + 1;
  });
}
const ranked = METRICS.map((s) => `${s.key} (${countryNames.filter((n) => countries[n].ranks && countries[n].ranks[s.key]).length})`);
log(`ranked: ${ranked.join(', ')}`);

// ------------------------------------------------------------------- output

const out = {
  year: YEAR,
  countryCount: countryNames.length,
  metrics: METRICS.map(({ key, label, kind, unit }) => ({ key, label, kind, unit: unit || null })),
  countries,
};
const outPath = path.join(ROOT, 'data', 'andah-map-data.json');
fs.writeFileSync(outPath, JSON.stringify(out));
log(`wrote data/andah-map-data.json (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);

const sample = countries[countryNames.find((n) => n === 'Lycroa') || countryNames[0]];
log(`\nsample - ${sample.name}: capital ${sample.capital}, ${sample.continent}, pop rank ${sample.ranks.population}`);
log(`  info fields: ${Object.keys(sample.info).join(', ')}`);
