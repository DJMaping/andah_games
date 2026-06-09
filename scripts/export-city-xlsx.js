#!/usr/bin/env node
'use strict';

// Builds a nicely-formatted .xlsx of the per-city Flight Network dataset:
// bold frozen header, thousands separators, auto-filter, banded rows, sized columns.
//
// Same data + continent join as export-city-data.js (see that file for the join
// gotcha). This one targets presentation rather than a raw CSV.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const NETWORK_PATH = path.join(ROOT, 'data', 'flight-network.json');
const COUNTRIES_PATH = path.join(ROOT, 'data', 'countries.json');
const OUT_PATH = path.join(ROOT, 'data', 'flight-cities-export.xlsx');

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

const round = (v, dp = 0) =>
  typeof v === 'number' && isFinite(v) ? Number(v.toFixed(dp)) : v;

async function main() {
  const network = JSON.parse(fs.readFileSync(NETWORK_PATH, 'utf8'));
  const countries = JSON.parse(fs.readFileSync(COUNTRIES_PATH, 'utf8'));
  const airports = network.airports || [];
  const continentByNation = buildContinentLookup(countries);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Andah Games';
  const ws = wb.addWorksheet('Cities', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }], // freeze City col + header row
  });

  // key, header, width, numFmt
  const columns = [
    { key: 'city',        header: 'City',               width: 20 },
    { key: 'nation',      header: 'Nation',              width: 18 },
    { key: 'continent',   header: 'Continent',           width: 14 },
    { key: 'population',  header: 'Population (M)',      width: 16, numFmt: '#,##0.00' },
    { key: 'gdpPerCapita',header: 'GDP per Capita ($)',  width: 18, numFmt: '#,##0' },
    { key: 'gdpNominal',  header: 'GDP (Nominal, $bn)',  width: 20, numFmt: '#,##0.00' },
    { key: 'band',        header: 'Pop. Band',           width: 11 },
    { key: 'isCapital',   header: 'Capital?',            width: 10 },
    { key: 'isHub',       header: 'Hub?',                width: 8  },
    { key: 'degree',      header: 'Routes',              width: 9,  numFmt: '#,##0' },
    { key: 'lat',         header: 'Latitude',            width: 11, numFmt: '0.00' },
    { key: 'lon',         header: 'Longitude',           width: 11, numFmt: '0.00' },
  ];
  ws.columns = columns.map(({ key, width }) => ({ key, width }));

  let missingContinent = 0;
  for (const a of airports) {
    const m = a.metrics || {};
    const continent = continentByNation.get((a.country || '').toLowerCase().trim()) || '';
    if (!continent) missingContinent++;
    ws.addRow({
      city:         a.displayCity || a.city || '',
      nation:       a.country || '',
      continent,
      population:   m.population != null ? round(m.population / 1e6, 2) : null,
      gdpPerCapita: m.gdpPerCapita != null ? round(m.gdpPerCapita, 0) : null,
      gdpNominal:   m.gdpNominal != null ? round(m.gdpNominal / 1e9, 2) : null,
      band:         a.band || '',
      isCapital:    a.isCapital ? 'Yes' : '',
      isHub:        a.isHub ? 'Yes' : '',
      degree:       a.degree,
      lat:          a.lat != null ? round(a.lat, 2) : null,
      lon:          a.lon != null ? round(a.lon, 2) : null,
    });
  }

  // Header styling: dark blue fill, white bold text, centered.
  const header = ws.getRow(1);
  header.height = 22;
  header.eachCell((cell, col) => {
    cell.value = columns[col - 1].header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF14385A' } } };
  });

  // Number formats + per-row styling.
  columns.forEach(({ key, numFmt }, i) => {
    if (numFmt) ws.getColumn(i + 1).numFmt = numFmt;
  });

  // Banded rows + center the short flag/band/continent columns.
  const centerCols = new Set(['continent', 'band', 'isCapital', 'isHub']);
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (r % 2 === 0) {
      row.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F6FB' } };
      });
    }
    columns.forEach(({ key }, i) => {
      if (centerCols.has(key)) {
        row.getCell(i + 1).alignment = { horizontal: 'center' };
      }
    });
  }

  // Auto-filter across the whole header so the user can sort/filter any column.
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  await wb.xlsx.writeFile(OUT_PATH);

  console.log(`Wrote ${OUT_PATH}`);
  console.log(`Rows: ${airports.length} cities (+1 header)`);
  console.log(`Cities missing a continent: ${missingContinent}`);
}

main();
