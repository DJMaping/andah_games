#!/usr/bin/env node
'use strict';

// Exports the per-city Flight Network dataset to a CSV.
//
// Source of truth is data/flight-network.json (the baked network, one record per
// city/airport). Continent is the only field not present there, so we join it from
// data/countries.json by nation name.
//
// Join gotcha: countries.json contains duplicate / case-variant records, some of
// which carry an undefined or "N/a" continent that would clobber the good value in a
// naive last-write-wins map. So we build the lookup case-insensitively and prefer the
// record whose continent is a real value.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const NETWORK_PATH = path.join(ROOT, 'data', 'flight-network.json');
const COUNTRIES_PATH = path.join(ROOT, 'data', 'countries.json');
const OUT_PATH = path.join(ROOT, 'data', 'flight-cities-export.csv');

const isRealContinent = (v) =>
  typeof v === 'string' && v.trim() !== '' && v.trim().toLowerCase() !== 'n/a';

function buildContinentLookup(countriesJson) {
  const countries = countriesJson.countries || countriesJson;
  const map = new Map();
  for (const c of countries) {
    const key = (c.name || '').toLowerCase().trim();
    if (!key) continue;
    const cat = c.categorical || {};
    const cont = cat.Continent || cat.continent;
    // Prefer a real continent value; otherwise only seed the key if unseen.
    if (isRealContinent(cont)) {
      map.set(key, cont.trim());
    } else if (!map.has(key)) {
      map.set(key, '');
    }
  }
  return map;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function main() {
  const network = JSON.parse(fs.readFileSync(NETWORK_PATH, 'utf8'));
  const countries = JSON.parse(fs.readFileSync(COUNTRIES_PATH, 'utf8'));
  const airports = network.airports || [];
  const continentByNation = buildContinentLookup(countries);

  const header = [
    'City', 'Nation', 'Continent', 'Population', 'GDP per Capita', 'GDP (Nominal)',
    'Economic Mass', 'Population Band', 'Is Capital', 'Is Hub',
    'Route Count (Degree)', 'Latitude', 'Longitude', 'Map X', 'Map Y', 'ID',
  ];

  const rows = [header.map(csvCell).join(',')];
  let missingContinent = 0;

  for (const a of airports) {
    const m = a.metrics || {};
    const continent = continentByNation.get((a.country || '').toLowerCase().trim()) || '';
    if (!continent) missingContinent++;
    const round = (v, dp = 0) =>
      typeof v === 'number' && isFinite(v) ? Number(v.toFixed(dp)) : v;
    const row = [
      a.displayCity || a.city || '',
      a.country || '',
      continent,
      m.population,
      round(m.gdpPerCapita, 2),
      round(m.gdpNominal, 0),
      round(a.mass, 0),
      a.band || '',
      a.isCapital ? 'TRUE' : 'FALSE',
      a.isHub ? 'TRUE' : 'FALSE',
      a.degree,
      round(a.lat, 4),
      round(a.lon, 4),
      a.x,
      a.y,
      a.id || '',
    ];
    rows.push(row.map(csvCell).join(','));
  }

  fs.writeFileSync(OUT_PATH, rows.join('\n') + '\n', 'utf8');

  console.log(`Wrote ${OUT_PATH}`);
  console.log(`Data rows: ${airports.length} (+1 header)`);
  console.log(`Cities missing a continent: ${missingContinent}`);
}

main();
