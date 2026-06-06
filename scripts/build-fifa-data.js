#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import XLSX from 'xlsx';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const XLSX_PATH = path.join(ROOT, '.xlsx files', 'worldbuilding_fifa_rankings_with_debuff.xlsx');
const OUT_PATH = path.join(ROOT, 'js', 'andah-fifa-data.js');

const wb = XLSX.readFile(XLSX_PATH, { cellDates: false, cellNF: false });
const rows = XLSX.utils.sheet_to_json(wb.Sheets['Adjusted Rankings'], { defval: null, raw: true });

const data = rows
    .filter(r => r['Country'] && r['Adjusted Points'] != null)
    .map(r => ({
        name: String(r['Country']).trim(),
        continent: String(r['Continent'] || '').trim(),
        adjustedPoints: Number(r['Adjusted Points']) || 0,
        rank: Number(r['New Rank']) || 999,
        population: Number(r['Population']) || 0,
        sportEarth: String(r['Sport (Earth)'] || '').trim(),
        debuff: Number(r['Debuff']) || 0
    }))
    .sort((a, b) => b.adjustedPoints - a.adjustedPoints);

const js = `const andahFifaData = ${JSON.stringify(data, null, 2)};\n`;
fs.writeFileSync(OUT_PATH, js, 'utf8');
console.log(`Wrote ${data.length} countries to ${path.relative(ROOT, OUT_PATH)}`);

const continents = {};
for (const c of data) {
    continents[c.continent] = (continents[c.continent] || 0) + 1;
}
console.log('Continents:', continents);
