#!/usr/bin/env node
'use strict';

// Builds a human-readable CSV of the Flight Network cities for upload as a native
// Google Sheet. Numbers are scaled (GDP -> $bn, population -> millions) so the sheet
// is scannable rather than a wall of 12-digit figures. Redundant/internal columns
// (Economic Mass == GDP nominal; Map X/Y/ID tagger coords) are dropped.
//
// Continent join matches export-city-data.js (see there for the dedupe gotcha).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const NETWORK_PATH = path.join(ROOT, 'data', 'flight-network.json');
const COUNTRIES_PATH = path.join(ROOT, 'data', 'countries.json');
const OUT_PATH = path.join(ROOT, 'data', 'flight-cities-readable.csv');

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
    if (isRealContinent(cont)) map.set(key, cont.trim());
    else if (!map.has(key)) map.set(key, '');
  }
  return map;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function main() {
  const network = JSON.parse(fs.readFileSync(NETWORK_PATH, 'utf8'));
  const countries = JSON.parse(fs.readFileSync(COUNTRIES_PATH, 'utf8'));
  const airports = network.airports || [];
  const continentByNation = buildContinentLookup(countries);

  const header = [
    'City', 'Nation', 'Continent', 'Population (M)', 'GDP per Capita',
    'GDP (Nominal, $bn)', 'Pop. Band', 'Capital?', 'Hub?', 'Routes',
    'Latitude', 'Longitude',
  ];
  const rows = [header.map(csvCell).join(',')];

  for (const a of airports) {
    const m = a.metrics || {};
    const continent = continentByNation.get((a.country || '').toLowerCase().trim()) || '';
    rows.push([
      a.displayCity || a.city || '',
      a.country || '',
      continent,
      m.population != null ? (m.population / 1e6).toFixed(2) : '',
      m.gdpPerCapita != null ? Math.round(m.gdpPerCapita) : '',
      m.gdpNominal != null ? (m.gdpNominal / 1e9).toFixed(2) : '',
      a.band || '',
      a.isCapital ? 'Yes' : '',
      a.isHub ? 'Yes' : '',
      a.degree,
      a.lat != null ? a.lat.toFixed(2) : '',
      a.lon != null ? a.lon.toFixed(2) : '',
    ].map(csvCell).join(','));
  }

  fs.writeFileSync(OUT_PATH, rows.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`Data rows: ${airports.length} (+1 header)`);
}

main();
