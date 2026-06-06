// Flexible schema parser for Andah .xlsx files.
//
// Rules:
//   - Each .xlsx file is one or more sheets. Each "data sheet" has a `name`
//     column (case-insensitive) as the primary key.
//   - Numeric columns in data sheets -> country.metrics[<columnHeader>].
//   - String columns (other than `name`) -> country.categorical[<columnHeader>].
//   - Sheets whose names end in `_history` and contain a `year` column are
//     treated as long-format time-series. The metric is derived from the sheet
//     name (e.g. `population_history` -> history.population).
//   - Multiple files merge by `name`. Conflicts on the same metric warn but
//     last-write-wins (insertion order across files).
//
// Returns: { countries: Country[], metricDefs: MetricDef[] }

import { toSlug, toWikiTitle } from './slug.js';

const NAME_KEYS = new Set(['name', 'country', 'country_name']);

function findNameKey(headers) {
    const lower = headers.map(h => String(h ?? '').trim().toLowerCase());
    for (const key of NAME_KEYS) {
        const i = lower.indexOf(key);
        if (i !== -1) return headers[i];
    }
    return null;
}

function isNumeric(v) {
    if (v === null || v === undefined || v === '') return false;
    if (typeof v === 'number') return Number.isFinite(v);
    const n = Number(String(v).replace(/[, ]/g, ''));
    return Number.isFinite(n);
}

function toNumber(v) {
    if (typeof v === 'number') return v;
    return Number(String(v).replace(/[, ]/g, ''));
}

function classifyColumn(rows, header) {
    let numericCount = 0;
    let nonEmpty = 0;
    for (const row of rows) {
        const v = row[header];
        if (v === null || v === undefined || v === '') continue;
        nonEmpty++;
        if (isNumeric(v)) numericCount++;
    }
    if (nonEmpty === 0) return 'empty';
    return numericCount / nonEmpty >= 0.8 ? 'numeric' : 'string';
}

function ensureCountry(byName, displayName) {
    const key = displayName.trim();
    if (!byName.has(key)) {
        byName.set(key, {
            name: key,
            slug: toSlug(key),
            wikiTitle: toWikiTitle(key),
            metrics: {},
            categorical: {},
            history: {}
        });
    }
    return byName.get(key);
}

function parseDataSheet(byName, metricDefs, sheetName, rows, warnings) {
    if (rows.length === 0) return;
    const headers = Object.keys(rows[0]);
    const nameKey = findNameKey(headers);
    if (!nameKey) {
        warnings.push(`Sheet "${sheetName}" has no name column; skipping.`);
        return;
    }

    const classifications = {};
    for (const h of headers) {
        if (h === nameKey) continue;
        classifications[h] = classifyColumn(rows, h);
    }

    for (const row of rows) {
        const rawName = row[nameKey];
        if (!rawName) continue;
        const country = ensureCountry(byName, String(rawName));

        for (const [h, kind] of Object.entries(classifications)) {
            const v = row[h];
            if (v === null || v === undefined || v === '') continue;
            if (kind === 'numeric') {
                const num = toNumber(v);
                if (Number.isFinite(num)) {
                    if (country.metrics[h] !== undefined && country.metrics[h] !== num) {
                        warnings.push(`Metric "${h}" for ${country.name} overwritten (${country.metrics[h]} -> ${num}, sheet "${sheetName}")`);
                    }
                    country.metrics[h] = num;
                    if (!metricDefs.has(h)) {
                        metricDefs.set(h, {
                            key: h,
                            label: h,
                            format: inferFormat(h),
                            scale: 'linear'
                        });
                    }
                }
            } else if (kind === 'string') {
                country.categorical[h] = String(v).trim();
            }
        }
    }
}

function parseHistorySheet(byName, sheetName, rows, warnings) {
    if (rows.length === 0) return;
    const metricKey = sheetName.replace(/_history$/i, '');
    const headers = Object.keys(rows[0]);
    const nameKey = findNameKey(headers);
    const yearKey = headers.find(h => String(h).trim().toLowerCase() === 'year');
    if (!nameKey) {
        warnings.push(`History sheet "${sheetName}" has no name column; skipping.`);
        return;
    }

    if (yearKey) {
        // Long format: name | year | value (or name | year | <metricKey>)
        const valueKey = headers.find(h => h !== nameKey && h !== yearKey);
        if (!valueKey) {
            warnings.push(`History sheet "${sheetName}" has no value column; skipping.`);
            return;
        }
        for (const row of rows) {
            const rawName = row[nameKey];
            const year = Number(row[yearKey]);
            const value = toNumber(row[valueKey]);
            if (!rawName || !Number.isFinite(year) || !Number.isFinite(value)) continue;
            const country = ensureCountry(byName, String(rawName));
            (country.history[metricKey] ??= []).push({ year, value });
        }
    } else {
        // Wide format: name | <year-1> | <year-2> | ...
        const yearCols = headers
            .filter(h => h !== nameKey && /^\d{3,4}$/.test(String(h).trim()))
            .map(h => ({ header: h, year: Number(String(h).trim()) }));
        if (yearCols.length === 0) {
            warnings.push(`History sheet "${sheetName}" has no year columns; skipping.`);
            return;
        }
        for (const row of rows) {
            const rawName = row[nameKey];
            if (!rawName) continue;
            const country = ensureCountry(byName, String(rawName));
            const series = (country.history[metricKey] ??= []);
            for (const { header, year } of yearCols) {
                const v = row[header];
                if (v === null || v === undefined || v === '') continue;
                const value = toNumber(v);
                if (Number.isFinite(value)) series.push({ year, value });
            }
        }
    }

    // Sort each history series by year.
    for (const country of byName.values()) {
        if (country.history[metricKey]) {
            country.history[metricKey].sort((a, b) => a.year - b.year);
        }
    }
}

function inferFormat(header) {
    const h = header.toLowerCase();
    if (/(gdp|nominal|ppp|income|revenue|cost)/.test(h)) return 'currency';
    if (/(percent|pct|rate|share)/.test(h)) return 'percent';
    if (/(population|count|total|area)/.test(h)) return 'integer';
    return 'number';
}

export function buildCountries(workbooks) {
    const byName = new Map();
    const metricDefs = new Map();
    const warnings = [];

    for (const wb of workbooks) {
        for (const sheetName of wb.SheetNames) {
            const rows = wb.sheetRows[sheetName];
            if (!rows || rows.length === 0) continue;
            if (/_history$/i.test(sheetName)) {
                parseHistorySheet(byName, sheetName, rows, warnings);
            } else if (sheetName.startsWith('_')) {
                // Reserved for future meta sheets (skip silently).
                continue;
            } else {
                parseDataSheet(byName, metricDefs, sheetName, rows, warnings);
            }
        }
    }

    return {
        countries: Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name)),
        metricDefs: Array.from(metricDefs.values()),
        warnings
    };
}
