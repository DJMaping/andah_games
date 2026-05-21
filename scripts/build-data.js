#!/usr/bin/env node
// Parse every .xlsx in `.xlsx files/`, run them through schema.js, and write
// data/countries.json + data/datasets.json.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import * as XLSX from 'xlsx';

import { buildCountries } from './util/schema.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const XLSX_DIR = path.join(ROOT, '.xlsx files');
const DATA_DIR = path.join(ROOT, 'data');
const OVERRIDES_PATH = path.join(ROOT, 'data-sources.json');

function loadOverrides() {
    if (!fs.existsSync(OVERRIDES_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
    } catch (e) {
        console.warn(`Could not read ${OVERRIDES_PATH}: ${e.message}`);
        return {};
    }
}

function loadWorkbook(file) {
    const wb = XLSX.readFile(file, { cellDates: false, cellNF: false });
    const sheetRows = {};
    for (const name of wb.SheetNames) {
        sheetRows[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], {
            defval: null,
            raw: true
        });
    }
    return { SheetNames: wb.SheetNames, sheetRows, sourceFile: path.basename(file) };
}

function discoverXlsxFiles() {
    if (!fs.existsSync(XLSX_DIR)) {
        console.warn(`No "${path.relative(ROOT, XLSX_DIR)}" directory found. Run will produce empty data.`);
        return [];
    }
    return fs.readdirSync(XLSX_DIR)
        .filter(f => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'))
        .map(f => path.join(XLSX_DIR, f));
}

function applyMetricOverrides(metricDefs, overrides) {
    const out = metricDefs.map(d => ({ ...d }));
    const map = overrides.metrics || {};
    for (const def of out) {
        const o = map[def.key];
        if (!o) continue;
        if (o.label) def.label = o.label;
        if (o.format) def.format = o.format;
        if (o.scale) def.scale = o.scale;
        if (o.unit) def.unit = o.unit;
        if (o.hidden) def.hidden = true;
    }
    return out;
}

export async function buildData() {
    const xlsxFiles = discoverXlsxFiles();
    console.log(`Found ${xlsxFiles.length} xlsx file(s).`);
    const workbooks = xlsxFiles.map(loadWorkbook);

    const { countries, metricDefs, warnings } = buildCountries(workbooks);
    const overrides = loadOverrides();
    const metricDefsFinal = applyMetricOverrides(metricDefs, overrides);

    for (const w of warnings) console.warn('  warn:', w);

    fs.mkdirSync(DATA_DIR, { recursive: true });

    const countriesOut = {
        generatedAt: new Date().toISOString(),
        countries,
        metricDefs: metricDefsFinal
    };
    fs.writeFileSync(
        path.join(DATA_DIR, 'countries.json'),
        JSON.stringify(countriesOut, null, 2)
    );

    const datasets = {
        generatedAt: new Date().toISOString(),
        files: workbooks.map(wb => ({
            file: wb.sourceFile,
            sheets: wb.SheetNames.map(n => ({
                name: n,
                rowCount: (wb.sheetRows[n] || []).length
            }))
        }))
    };
    fs.writeFileSync(
        path.join(DATA_DIR, 'datasets.json'),
        JSON.stringify(datasets, null, 2)
    );

    console.log(`Wrote ${countries.length} countries, ${metricDefsFinal.length} metric definitions.`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || import.meta.url === url.pathToFileURL(process.argv[1]).href) {
    buildData().catch(e => {
        console.error(e);
        process.exit(1);
    });
}
