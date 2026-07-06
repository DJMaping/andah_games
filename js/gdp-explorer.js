// gdp-explorer.js — reads Population Growth(2).xlsx (with GDP input columns G/H),
// recomputes the per-capita chain in JS (never trusts Excel's cached results),
// and renders cross-country bar/pie charts per year plus per-country time series.
//
// Math (mirrors scripts/add-gdp-columns.js):
//   perCap(2015)  = override ?? anchor          (anchor = andahStats gdpPerNominal)
//   perCap(Y-1)   = override ?? perCap(Y) / (1 + growth(Y))   [blank growth = 0%]
// A year is "determined" only if every step from 2015 down to it had a growth
// input, or an override pinned it; undetermined years are flat placeholders.

const SUMMARY_SHEETS = new Set(['GlobalContinent Population', 'Geoscheme Population']);
const CACHE_KEY = 'andah-gdp-cache';

const PALETTE = ['#4269d0', '#efb118', '#ff725c', '#6cc5b0', '#3ca951', '#ff8ab7', '#a463f2', '#97bbf5', '#9c6b4e', '#9498a0'];

const $ = (id) => document.getElementById(id);

const state = {
    countries: [],        // [{name, rows:[{earthYear, year, pop, g, h}] newest-first}]
    computed: new Map(),  // name -> rows enriched with perCap/gdp/determined/growths
    continents: new Map(),// name -> continent
    continentColors: new Map(),
    anchors: new Map(),
    source: null,
    year: 2015,
    charts: {},
};

// ---------- formatting ----------
function fmtMoney(v) {
    if (v == null || !isFinite(v)) return '–';
    const abs = Math.abs(v);
    if (abs >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
    if (abs >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    return '$' + Math.round(v).toLocaleString('en-US');
}
function fmtPct(v) {
    if (v == null || !isFinite(v)) return '–';
    return (v * 100).toFixed(2) + '%';
}
function fmtInt(v) {
    if (v == null || !isFinite(v)) return '–';
    return Math.round(v).toLocaleString('en-US');
}

// ---------- theme-aware chart colors ----------
function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    return {
        text: cs.getPropertyValue('--text').trim() || '#202122',
        muted: cs.getPropertyValue('--muted').trim() || '#54595d',
        grid: cs.getPropertyValue('--border-soft').trim() || '#c8ccd1',
    };
}

// ---------- anchors ----------
function loadAnchors() {
    // andah-stats.js is a classic script whose top-level `const` lives in the
    // global lexical environment, NOT on window — read the bare identifier.
    const stats = typeof andahStats !== 'undefined' ? andahStats : (window.andahStats || []);
    for (const s of stats) state.anchors.set(s.name, s.gdpPerNominal);
}

// ---------- continents (optional; degrades gracefully) ----------
async function loadContinents() {
    try {
        const res = await fetch('data/countries.json');
        if (!res.ok) return;
        const data = await res.json();
        const list = Array.isArray(data) ? data : data.countries || [];
        for (const c of list) {
            const cont = c.categorical && (c.categorical.Continent || c.categorical.continent);
            if (c.name && cont) state.continents.set(c.name, cont);
        }
        const names = [...new Set(state.continents.values())].sort();
        names.forEach((n, i) => state.continentColors.set(n, PALETTE[i % PALETTE.length]));
    } catch (e) { /* file:// or missing build — charts fall back to single hue */ }
}
function continentOf(name) { return state.continents.get(name) || 'Unknown'; }
function colorOf(name) {
    return state.continentColors.get(continentOf(name)) || PALETTE[0];
}

// ---------- workbook parsing ----------
function parseWorkbook(buf, sourceName) {
    const wb = XLSX.read(buf, { type: 'array' });
    const countries = [];
    for (const sheetName of wb.SheetNames) {
        if (SUMMARY_SHEETS.has(sheetName)) continue;
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null });
        const out = [];
        for (let i = 1; i < rows.length; i++) {
            const r = rows[i];
            if (!r || typeof r[2] !== 'number') break; // contiguous data rows only
            out.push({
                earthYear: r[0], year: r[1], pop: r[2],
                g: typeof r[6] === 'number' ? r[6] : null,   // GDP/cap growth input
                h: typeof r[7] === 'number' ? r[7] : null,   // override $
            });
        }
        if (out.length) countries.push({ name: sheetName, rows: out });
    }
    return { countries, source: sourceName };
}

// ---------- the per-capita chain ----------
function computeCountry(country) {
    const anchor = state.anchors.get(country.name) ?? null;
    const rows = country.rows.map((r) => ({ ...r }));
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (i === 0) {
            r.perCap = r.h != null ? r.h : anchor;
            r.determined = r.h != null || anchor != null;
            r.pinned = r.h != null;
        } else {
            const prev = rows[i - 1]; // newer year
            if (r.h != null) {
                r.perCap = r.h; r.determined = true; r.pinned = true;
            } else {
                const g = prev.g != null ? prev.g : 0;
                r.perCap = prev.perCap != null ? prev.perCap / (1 + g) : null;
                r.determined = prev.determined && prev.g != null;
                r.pinned = false;
            }
        }
        r.gdp = r.perCap != null ? r.perCap * r.pop : null;
    }
    for (let i = 0; i < rows.length; i++) {
        const older = rows[i + 1];
        rows[i].perCapGrowth = older && older.perCap ? rows[i].perCap / older.perCap - 1 : null;
        rows[i].gdpGrowth = older && older.gdp ? rows[i].gdp / older.gdp - 1 : null;
        rows[i].growthDetermined = !!(older && older.determined && rows[i].determined);
    }
    return rows;
}
function computeAll() {
    state.computed.clear();
    for (const c of state.countries) state.computed.set(c.name, computeCountry(c));
}

// ---------- cache ----------
function saveCache() {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({
            savedAt: new Date().toISOString(),
            source: state.source,
            countries: state.countries,
        }));
    } catch (e) { /* quota — non-fatal, Excel is the durable copy */ }
}
function loadCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (!data.countries || !data.countries.length) return false;
        state.countries = data.countries;
        state.source = data.source;
        $('gdp-status').textContent = `Loaded ${data.countries.length} countries from browser cache (${data.source || 'xlsx'}, saved ${new Date(data.savedAt).toLocaleString()}).`;
        return true;
    } catch (e) { return false; }
}

// ---------- year range ----------
function yearRange() {
    let min = Infinity, max = -Infinity;
    for (const c of state.countries) {
        for (const r of c.rows) {
            if (typeof r.earthYear === 'number') {
                if (r.earthYear < min) min = r.earthYear;
                if (r.earthYear > max) max = r.earthYear;
            }
        }
    }
    return isFinite(min) ? { min, max } : { min: 1950, max: 2015 };
}

// ---------- view 1: all countries, one year ----------
function rowFor(name, earthYear) {
    const rows = state.computed.get(name);
    if (!rows) return null;
    return rows.find((r) => r.earthYear === earthYear) || null;
}

function renderYearView() {
    const year = state.year;
    const metric = $('ctl-metric').value;
    const showAll = $('ctl-all').checked;
    const topN = Math.max(3, Math.min(172, Number($('ctl-topn').value) || 18));

    const entries = [];
    let hidden = 0;
    let fictionalYear = null;
    for (const c of state.countries) {
        const r = rowFor(c.name, year);
        if (!r) { hidden++; continue; }
        if (fictionalYear == null) fictionalYear = r.year;
        const ok = metric === 'growth' ? r.growthDetermined : r.determined;
        if (!ok || r.perCap == null) { hidden++; continue; }
        entries.push({ name: c.name, row: r });
    }
    $('ctl-year-label').textContent = `${year}${fictionalYear != null ? ` (${fictionalYear})` : ''}`;

    const valueOf = (e) => metric === 'gdp' ? e.row.gdp : metric === 'perCap' ? e.row.perCap : e.row.gdpGrowth;
    entries.sort((a, b) => (valueOf(b) ?? -Infinity) - (valueOf(a) ?? -Infinity));

    // world summary (GDP-based, over included countries)
    const worldGdp = entries.reduce((s, e) => s + (e.row.gdp || 0), 0);
    const worldPop = entries.reduce((s, e) => s + (e.row.pop || 0), 0);
    $('year-summary').textContent = entries.length
        ? `World (of ${entries.length} countries with data): total GDP ${fmtMoney(worldGdp)} · GDP per capita ${fmtMoney(worldPop ? worldGdp / worldPop : null)}`
        : 'No countries have GDP data for this year yet — type growth rates in Excel columns G–H and re-open the file.';
    $('year-hidden').textContent = hidden ? `(${hidden} countries hidden — GDP not yet determined for ${year}. Blank growth years compound as 0%; a year counts as determined only when every year back from 2015 has a growth rate or an override pin.)` : '';

    // ----- bar -----
    const shown = showAll ? entries : entries.slice(0, topN);
    const rest = showAll ? [] : entries.slice(topN);
    const labels = shown.map((e) => e.name);
    const values = shown.map((e) => valueOf(e));
    const colors = shown.map((e) => colorOf(e.name));
    if (rest.length && metric !== 'growth') {
        // aggregate Others meaningfully: sum for GDP, pop-weighted mean for per-capita
        if (metric === 'gdp') {
            labels.push(`Others (${rest.length})`);
            values.push(rest.reduce((s, e) => s + (e.row.gdp || 0), 0));
        } else {
            const rg = rest.reduce((s, e) => s + (e.row.gdp || 0), 0);
            const rp = rest.reduce((s, e) => s + (e.row.pop || 0), 0);
            labels.push(`Others avg (${rest.length})`);
            values.push(rp ? rg / rp : 0);
        }
        colors.push('#9498a0');
    }

    const metricLabel = metric === 'gdp' ? 'Total GDP' : metric === 'perCap' ? 'GDP per capita' : 'GDP growth (total)';
    $('bar-title').textContent = `${metricLabel} — ${year}`;
    const tc = themeColors();
    const fmtVal = metric === 'growth' ? fmtPct : fmtMoney;

    destroyChart('bar');
    const barCanvas = $('chart-bar');
    barCanvas.parentElement.style.height = Math.max(220, labels.length * 26 + 60) + 'px';
    state.charts.bar = new Chart(barCanvas, {
        type: 'bar',
        data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }] },
        options: {
            indexAxis: 'y',
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (ctx) => ' ' + fmtVal(ctx.parsed.x) } },
            },
            scales: {
                x: { ticks: { color: tc.muted, callback: (v) => fmtVal(v) }, grid: { color: tc.grid } },
                y: { ticks: { color: tc.text, autoSkip: false }, grid: { display: false } },
            },
        },
    });

    // continent legend under the bar
    const legend = $('bar-legend');
    legend.innerHTML = '';
    if (state.continentColors.size) {
        const used = new Set(shown.map((e) => continentOf(e.name)));
        for (const [cont, col] of state.continentColors) {
            if (!used.has(cont)) continue;
            const span = document.createElement('span');
            span.innerHTML = `<i style="background:${col}"></i>${cont}`;
            legend.appendChild(span);
        }
    }

    // ----- pie (always GDP shares — shares of % growth aren't meaningful) -----
    const pieMode = $('ctl-pie').value;
    $('pie-note').textContent = metric !== 'gdp' ? 'Pie always shows Total GDP shares.' : '';
    destroyChart('pie');
    let pieLabels = [], pieValues = [], pieColors = [];
    if (pieMode === 'continents' && state.continentColors.size) {
        const byCont = new Map();
        for (const e of entries) {
            const cont = continentOf(e.name);
            byCont.set(cont, (byCont.get(cont) || 0) + (e.row.gdp || 0));
        }
        const sorted = [...byCont.entries()].sort((a, b) => b[1] - a[1]);
        pieLabels = sorted.map(([k]) => k);
        pieValues = sorted.map(([, v]) => v);
        pieColors = sorted.map(([k]) => state.continentColors.get(k) || '#9498a0');
        $('pie-title').textContent = `GDP by continent — ${year}`;
    } else {
        const byGdp = [...entries].sort((a, b) => (b.row.gdp || 0) - (a.row.gdp || 0));
        const top = byGdp.slice(0, topN);
        const others = byGdp.slice(topN);
        pieLabels = top.map((e) => e.name);
        pieValues = top.map((e) => e.row.gdp || 0);
        pieColors = top.map((e, i) => state.continentColors.size ? colorOf(e.name) : PALETTE[i % PALETTE.length]);
        if (others.length) {
            pieLabels.push(`Others (${others.length})`);
            pieValues.push(others.reduce((s, e) => s + (e.row.gdp || 0), 0));
            pieColors.push('#9498a0');
        }
        $('pie-title').textContent = `Share of world GDP — ${year}`;
    }
    state.charts.pie = new Chart($('chart-pie'), {
        type: 'doughnut',
        data: { labels: pieLabels, datasets: [{ data: pieValues, backgroundColor: pieColors, borderColor: themeColors().grid, borderWidth: 1 }] },
        options: {
            responsive: true,
            plugins: {
                legend: { display: pieLabels.length <= 12, position: 'bottom', labels: { color: tc.text, boxWidth: 12, font: { size: 10 } } },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const total = pieValues.reduce((s, v) => s + v, 0);
                            const pct = total ? (ctx.parsed / total * 100).toFixed(1) : 0;
                            return ` ${ctx.label}: ${fmtMoney(ctx.parsed)} (${pct}%)`;
                        },
                    },
                },
            },
        },
    });
}

// ---------- view 2: one country over time ----------
function renderCountryView() {
    const name = $('ctl-country').value;
    const rows = state.computed.get(name);
    if (!rows) return;
    const asc = [...rows].reverse(); // oldest -> newest for time axis
    const tc = themeColors();
    const filled = rows.filter((r) => r.determined).length;
    $('country-status').textContent = `${filled}/${rows.length} years determined · anchor ${fmtMoney(state.anchors.get(name))} per capita (2015)`;

    destroyChart('lineGdp');
    state.charts.lineGdp = new Chart($('chart-line-gdp'), {
        type: 'line',
        data: {
            labels: asc.map((r) => r.earthYear),
            datasets: [
                {
                    label: 'Total GDP', yAxisID: 'y', data: asc.map((r) => r.gdp),
                    borderColor: PALETTE[0], backgroundColor: PALETTE[0], pointRadius: 0, borderWidth: 2,
                    segment: { borderDash: (ctx) => asc[ctx.p1DataIndex] && !asc[ctx.p1DataIndex].determined ? [4, 4] : undefined },
                },
                {
                    label: 'GDP per capita', yAxisID: 'y1', data: asc.map((r) => r.perCap),
                    borderColor: PALETTE[2], backgroundColor: PALETTE[2], pointRadius: 0, borderWidth: 2,
                    segment: { borderDash: (ctx) => asc[ctx.p1DataIndex] && !asc[ctx.p1DataIndex].determined ? [4, 4] : undefined },
                },
            ],
        },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: tc.text } },
                tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmtMoney(ctx.parsed.y)}` } },
            },
            scales: {
                x: { ticks: { color: tc.muted }, grid: { display: false } },
                y: { position: 'left', ticks: { color: tc.muted, callback: (v) => fmtMoney(v) }, grid: { color: tc.grid } },
                y1: { position: 'right', ticks: { color: tc.muted, callback: (v) => fmtMoney(v) }, grid: { display: false } },
            },
        },
    });

    destroyChart('lineGrowth');
    state.charts.lineGrowth = new Chart($('chart-line-growth'), {
        type: 'line',
        data: {
            labels: asc.map((r) => r.earthYear),
            datasets: [
                { label: 'GDP growth (total)', data: asc.map((r) => r.growthDetermined ? r.gdpGrowth : null), borderColor: PALETTE[4], backgroundColor: PALETTE[4], pointRadius: 0, borderWidth: 2 },
                { label: 'GDP/cap growth', data: asc.map((r) => r.growthDetermined ? r.perCapGrowth : null), borderColor: PALETTE[6], backgroundColor: PALETTE[6], pointRadius: 0, borderWidth: 2 },
                { label: 'Pop growth', data: asc.map((r) => {
                    const older = rows.find((x) => x.earthYear === r.earthYear - 1);
                    return older && older.pop ? r.pop / older.pop - 1 : null;
                }), borderColor: tc.muted, backgroundColor: tc.muted, pointRadius: 0, borderWidth: 1, borderDash: [3, 3] },
            ],
        },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: tc.text } },
                tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmtPct(ctx.parsed.y)}` } },
            },
            scales: {
                x: { ticks: { color: tc.muted }, grid: { display: false } },
                y: { ticks: { color: tc.muted, callback: (v) => fmtPct(v) }, grid: { color: tc.grid } },
            },
        },
    });

    // table (newest first, like the spreadsheet)
    const table = $('country-table');
    const head = `<tr><th>Earth Year</th><th>Year</th><th>Population</th><th>GDP/cap growth (input)</th><th>GDP per Capita</th><th>Total GDP</th><th>GDP growth (total)</th></tr>`;
    const body = rows.map((r) => `
        <tr class="${r.determined ? '' : 'undetermined'}">
            <td>${r.earthYear}</td><td>${r.year ?? '–'}</td>
            <td>${fmtInt(r.pop)}</td>
            <td>${r.g != null ? fmtPct(r.g) : '–'}</td>
            <td class="${r.pinned ? 'pinned' : ''}" title="${r.pinned ? 'Pinned by override' : ''}">${fmtMoney(r.perCap)}</td>
            <td>${fmtMoney(r.gdp)}</td>
            <td>${r.growthDetermined ? fmtPct(r.gdpGrowth) : '–'}</td>
        </tr>`).join('');
    table.innerHTML = head + body;
}

// ---------- chart plumbing ----------
function destroyChart(key) {
    if (state.charts[key]) { state.charts[key].destroy(); delete state.charts[key]; }
}
function rerenderAll() {
    if (!state.countries.length) return;
    renderYearView();
    if (!$('view-country').classList.contains('gdp-hidden')) renderCountryView();
}

// ---------- data intake ----------
async function ingest(buf, sourceName) {
    const parsed = parseWorkbook(buf, sourceName);
    if (!parsed.countries.length) {
        $('gdp-status').textContent = 'No country sheets found in that file — is it the Population Growth workbook?';
        return;
    }
    state.countries = parsed.countries;
    state.source = sourceName;
    computeAll();
    saveCache();
    const withInputs = state.countries.filter((c) => c.rows.some((r) => r.g != null || r.h != null)).length;
    $('gdp-status').textContent = `Loaded ${state.countries.length} countries from ${sourceName} · ${withInputs} have GDP inputs so far.`;
    initControls();
    $('gdp-main').classList.remove('gdp-hidden');
    rerenderAll();
}

function initControls() {
    const { min, max } = yearRange();
    const slider = $('ctl-year');
    slider.min = min; slider.max = max;
    if (state.year > max || state.year < min) state.year = max;
    slider.value = state.year;

    const sel = $('ctl-country');
    const current = sel.value;
    sel.innerHTML = state.countries.map((c) => `<option${c.name === current ? ' selected' : ''}>${c.name}</option>`).join('');
}

// ---------- events ----------
function bindEvents() {
    $('gdp-open').addEventListener('click', () => $('gdp-file').click());
    $('gdp-file').addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (f) await ingest(await f.arrayBuffer(), f.name);
        e.target.value = '';
    });

    const drop = $('gdp-drop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', async (e) => {
        e.preventDefault(); drop.classList.remove('dragover');
        const f = e.dataTransfer.files[0];
        if (f) await ingest(await f.arrayBuffer(), f.name);
    });

    $('ctl-year').addEventListener('input', (e) => { state.year = Number(e.target.value); renderYearView(); });
    for (const id of ['ctl-metric', 'ctl-topn', 'ctl-all', 'ctl-pie']) {
        $(id).addEventListener('change', renderYearView);
    }
    $('ctl-country').addEventListener('change', renderCountryView);

    $('tab-year').addEventListener('click', () => switchTab('year'));
    $('tab-country').addEventListener('click', () => switchTab('country'));

    $('gdp-export').addEventListener('click', exportJson);
    $('gdp-clear').addEventListener('click', () => {
        localStorage.removeItem(CACHE_KEY);
        $('gdp-status').textContent = 'Cache cleared — open the Excel file to reload.';
    });

    // re-skin charts when the theme toggles
    new MutationObserver(rerenderAll).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

function switchTab(which) {
    const yearTab = which === 'year';
    $('tab-year').setAttribute('aria-selected', String(yearTab));
    $('tab-country').setAttribute('aria-selected', String(!yearTab));
    $('view-year').classList.toggle('gdp-hidden', !yearTab);
    $('view-country').classList.toggle('gdp-hidden', yearTab);
    if (yearTab) renderYearView(); else renderCountryView();
}

function exportJson() {
    const doc = {
        generatedAt: new Date().toISOString(),
        source: state.source,
        anchorNote: 'perCap compounds backward from 2015 gdpPerNominal in js/andah-stats.js; blank growth = 0%; undetermined years are flat placeholders.',
        countries: state.countries.map((c) => ({
            name: c.name,
            continent: continentOf(c.name),
            anchor: state.anchors.get(c.name) ?? null,
            series: (state.computed.get(c.name) || []).map((r) => ({
                earthYear: r.earthYear, year: r.year, population: r.pop,
                perCapGrowthInput: r.g, overrideInput: r.h,
                gdpPerCapita: r.perCap, gdp: r.gdp,
                gdpGrowth: r.growthDetermined ? r.gdpGrowth : null,
                perCapGrowth: r.growthDetermined ? r.perCapGrowth : null,
                determined: r.determined,
            })),
        })),
    };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'gdp-dataset.json';
    a.click();
    URL.revokeObjectURL(a.href);
}

// ---------- boot ----------
async function boot() {
    loadAnchors();
    await loadContinents();
    bindEvents();
    if (loadCache()) {
        computeAll();
        initControls();
        $('gdp-main').classList.remove('gdp-hidden');
        rerenderAll();
    }
}
boot();
