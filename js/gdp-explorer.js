// gdp-explorer.js — loads Andah GDP data from repo JSON (no upload), renders
// cross-country and per-country charts, and lets DJ AUTHOR the per-capita history
// in the browser: $ checkpoints + auto-interpolate, draggable growth curve, and
// archetype presets. Edits export to data/gdp-growth.json (commit it).
//
// Data:
//   data/gdp-history.json  — fixed population substrate + 2015 anchors (read-only)
//   data/gdp-growth.json   — sparse authored { growth:{year:rate}, overrides:{year:$} }
//
// Math (mirrors the old spreadsheet, unchanged):
//   perCap(2015)  = override ?? anchor
//   perCap(Y-1)   = override ?? perCap(Y) / (1 + growth(Y))   [blank growth = 0%]
// A year is "determined" only if every step from 2015 down to it had a growth
// input, or an override pinned it; undetermined years are flat placeholders.

const HISTORY_URL = 'data/gdp-history.json';
const GROWTH_URL = 'data/gdp-growth.json';
const DRAFT_KEY = 'andah-gdp-draft';   // in-browser working copy of unsaved edits

const PALETTE = ['#4269d0', '#efb118', '#ff725c', '#6cc5b0', '#3ca951', '#ff8ab7', '#a463f2', '#97bbf5', '#9c6b4e', '#9498a0'];

const $ = (id) => document.getElementById(id);

const state = {
    history: [],          // [{name, anchor, rows:[[earthYear, year, pop]]}] newest-first
    baseGrowth: {},       // committed data/gdp-growth.json .countries (name -> {growth, overrides})
    edits: {},            // unsaved overlay, same shape as baseGrowth
    countries: [],        // [{name, rows:[{earthYear, year, pop, g, h}]}] built from history+growth
    computed: new Map(),  // name -> rows enriched with perCap/gdp/determined
    continents: new Map(),
    continentColors: new Map(),
    anchors: new Map(),
    year: 2015,
    mode: 'view',         // 'view' | 'edit'
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

// ---------- merged growth (base ∪ edits) ----------
function growthFor(name) {
    const base = state.baseGrowth[name] || {};
    const edit = state.edits[name] || {};
    return {
        growth: { ...(base.growth || {}), ...(edit.growth || {}) },
        overrides: { ...(base.overrides || {}), ...(edit.overrides || {}) },
    };
}
function editsFor(name) {
    if (!state.edits[name]) state.edits[name] = { growth: {}, overrides: {} };
    if (!state.edits[name].growth) state.edits[name].growth = {};
    if (!state.edits[name].overrides) state.edits[name].overrides = {};
    return state.edits[name];
}
function hasEdits() {
    return Object.values(state.edits).some((e) =>
        (e.growth && Object.keys(e.growth).length) || (e.overrides && Object.keys(e.overrides).length));
}

// ---------- build country rows from history + growth ----------
function buildCountries() {
    state.countries = state.history.map((h) => {
        const g = growthFor(h.name);
        return {
            name: h.name,
            rows: h.rows.map(([earthYear, year, pop]) => ({
                earthYear, year, pop,
                g: typeof g.growth[earthYear] === 'number' ? g.growth[earthYear] : null,
                h: typeof g.overrides[earthYear] === 'number' ? g.overrides[earthYear] : null,
            })),
        };
    });
}

// ---------- the per-capita chain (unchanged math) ----------
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

// Recompute just one country after an edit and refresh its view + dirty banner.
function refreshCountry(name) {
    const c = state.countries.find((x) => x.name === name);
    if (!c) return;
    const g = growthFor(name);
    for (const r of c.rows) {
        r.g = typeof g.growth[r.earthYear] === 'number' ? g.growth[r.earthYear] : null;
        r.h = typeof g.overrides[r.earthYear] === 'number' ? g.overrides[r.earthYear] : null;
    }
    state.computed.set(name, computeCountry(c));
    saveDraft();
    renderCountryView();
    updateDirty();
}

// ---------- draft persistence (localStorage) ----------
function saveDraft() {
    try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: new Date().toISOString(), edits: state.edits }));
    } catch (e) { /* quota — non-fatal, the committed JSON is durable */ }
}
function loadDraft() {
    try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (data && data.edits) state.edits = data.edits;
    } catch (e) { /* ignore corrupt draft */ }
}
function updateDirty() {
    const banner = $('gdp-dirty');
    if (!banner) return;
    banner.classList.toggle('gdp-hidden', !hasEdits());
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

// ========================================================================
//  View 1: all countries, one year
// ========================================================================
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

    const worldGdp = entries.reduce((s, e) => s + (e.row.gdp || 0), 0);
    const worldPop = entries.reduce((s, e) => s + (e.row.pop || 0), 0);
    $('year-summary').textContent = entries.length
        ? `World (of ${entries.length} countries with data): total GDP ${fmtMoney(worldGdp)} · GDP per capita ${fmtMoney(worldPop ? worldGdp / worldPop : null)}`
        : 'No countries have GDP data for this year yet — switch to Edit and author some growth curves.';
    $('year-hidden').textContent = hidden ? `(${hidden} countries hidden — GDP not yet determined for ${year}. Blank growth years compound as 0%; a year counts as determined only when every year back from 2015 has a growth rate or an override pin.)` : '';

    // ----- bar -----
    const shown = showAll ? entries : entries.slice(0, topN);
    const rest = showAll ? [] : entries.slice(topN);
    const labels = shown.map((e) => e.name);
    const values = shown.map((e) => valueOf(e));
    const colors = shown.map((e) => colorOf(e.name));
    if (rest.length && metric !== 'growth') {
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

    // ----- pie (always GDP shares) -----
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

// ========================================================================
//  View 2: one country over time (+ editing in Edit mode)
// ========================================================================
function selectedCountry() { return $('ctl-country').value; }

let lastPasteCountry = null;
function renderCountryView() {
    const name = selectedCountry();
    const rows = state.computed.get(name);
    if (!rows) return;
    if (name !== lastPasteCountry) { setPasteStatus(''); lastPasteCountry = name; }
    const asc = [...rows].reverse(); // oldest -> newest for time axis
    const tc = themeColors();
    const editing = state.mode === 'edit';
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

    renderGrowthChart(name, asc, tc, editing);
    renderCountryTable(name, rows, editing);
    if (editing) renderPinList(name);
}

// Growth line chart. In Edit mode the "GDP/cap growth" series becomes draggable
// (via chartjs-plugin-dragdata) with a point at every year, so DJ can reshape the
// curve by hand; dragging a point writes edits.growth[earthYear].
function renderGrowthChart(name, asc, tc, editing) {
    destroyChart('lineGrowth');

    // editable series: input g where present, else current perCap growth, else 0
    const editData = asc.map((r) => r.g != null ? r.g : (r.perCapGrowth != null ? r.perCapGrowth : 0));
    const rows = state.computed.get(name);

    const datasets = [
        {
            label: editing ? 'GDP/cap growth (drag me)' : 'GDP/cap growth',
            data: editing ? editData : asc.map((r) => r.growthDetermined ? r.perCapGrowth : null),
            borderColor: PALETTE[6], backgroundColor: PALETTE[6],
            pointRadius: editing ? 3 : 0, pointHoverRadius: editing ? 6 : 0,
            borderWidth: 2, dragData: editing,
        },
        {
            label: 'GDP growth (total)',
            data: asc.map((r) => r.growthDetermined ? r.gdpGrowth : null),
            borderColor: PALETTE[4], backgroundColor: PALETTE[4], pointRadius: 0, borderWidth: 2, dragData: false,
        },
        {
            label: 'Pop growth',
            data: asc.map((r) => {
                const older = rows.find((x) => x.earthYear === r.earthYear - 1);
                return older && older.pop ? r.pop / older.pop - 1 : null;
            }),
            borderColor: tc.muted, backgroundColor: tc.muted, pointRadius: 0, borderWidth: 1, borderDash: [3, 3], dragData: false,
        },
    ];

    const options = {
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
    };

    const cfgPlugins = [];
    if (editing && dragPlugin) {
        options.plugins.dragData = {
            round: 4,
            dragX: false,
            onDragEnd: (e, datasetIndex, index, value) => {
                if (datasetIndex !== 0) return;             // only the editable series
                const earthYear = asc[index].earthYear;
                if (earthYear === yearRange().min) return;  // oldest year has no "growth into" it
                editsFor(name).growth[earthYear] = Math.round(value * 10000) / 10000;
                refreshCountry(name);
            },
        };
        cfgPlugins.push(dragPlugin);
    }

    state.charts.lineGrowth = new Chart($('chart-line-growth'), {
        type: 'line', data: { labels: asc.map((r) => r.earthYear), datasets }, options, plugins: cfgPlugins,
    });
}

function renderCountryTable(name, rows, editing) {
    const table = $('country-table');
    const head = `<tr><th>Earth Year</th><th>Year</th><th>Population</th><th>GDP/cap growth${editing ? ' ✎' : ' (input)'}</th><th>GDP per Capita</th><th>Total GDP</th><th>GDP growth (total)</th></tr>`;
    const minYear = yearRange().min;
    const body = rows.map((r) => {
        const growthCell = editing && r.earthYear !== minYear
            ? `<td class="gdp-edit-cell"><input type="text" class="gdp-g-input" data-year="${r.earthYear}" value="${r.g != null ? (r.g * 100).toFixed(2) : ''}" placeholder="–" inputmode="decimal">%</td>`
            : `<td>${r.g != null ? fmtPct(r.g) : '–'}</td>`;
        const pcCell = editing
            ? `<td class="gdp-edit-cell ${r.pinned ? 'pinned' : ''}"><span class="gdp-pin-btn" data-year="${r.earthYear}" title="Pin an exact per-capita $ for this year">📌</span>${fmtMoney(r.perCap)}</td>`
            : `<td class="${r.pinned ? 'pinned' : ''}" title="${r.pinned ? 'Pinned by override' : ''}">${fmtMoney(r.perCap)}</td>`;
        return `
        <tr class="${r.determined ? '' : 'undetermined'}">
            <td>${r.earthYear}</td><td>${r.year ?? '–'}</td>
            <td>${fmtInt(r.pop)}</td>
            ${growthCell}
            ${pcCell}
            <td>${fmtMoney(r.gdp)}</td>
            <td>${r.growthDetermined ? fmtPct(r.gdpGrowth) : '–'}</td>
        </tr>`;
    }).join('');
    table.innerHTML = head + body;

    if (editing) {
        table.querySelectorAll('.gdp-g-input').forEach((inp) => {
            inp.addEventListener('change', () => {
                const year = Number(inp.dataset.year);
                const txt = inp.value.trim();
                if (txt === '') delete editsFor(name).growth[year];
                else {
                    const pct = parseFloat(txt);
                    if (!isFinite(pct)) return;
                    editsFor(name).growth[year] = pct / 100; // typed as percent (e.g. 3 -> 0.03)
                }
                refreshCountry(name);
            });
            // Paste a whole column at once (Excel-style): click the year to start
            // at, Ctrl+V, and values flow DOWN the table (newest -> oldest).
            inp.addEventListener('paste', (ev) => {
                const cb = ev.clipboardData || window.clipboardData;
                const text = cb ? cb.getData('text') : '';
                if (!text || !/[\n\t]/.test(text.trim())) return; // single value -> normal paste
                ev.preventDefault();
                pasteGrowthColumn(name, Number(inp.dataset.year), text);
            });
        });
        table.querySelectorAll('.gdp-pin-btn').forEach((btn) => {
            btn.addEventListener('click', () => promptPin(name, Number(btn.dataset.year)));
        });
    }
}

// ========================================================================
//  Authoring tools
// ========================================================================

// --- $ checkpoints + auto-interpolate ---
function promptPin(name, year) {
    const rows = state.computed.get(name);
    const r = rows.find((x) => x.earthYear === year);
    const current = r && r.perCap != null ? Math.round(r.perCap) : '';
    const val = window.prompt(`Pin exact GDP per capita ($) for ${name} in Earth Year ${year}:\n(blank to remove pin)`, current);
    if (val === null) return;
    const t = val.trim();
    if (t === '') delete editsFor(name).overrides[year];
    else {
        const num = parseFloat(t.replace(/[$,]/g, ''));
        if (!isFinite(num)) return;
        editsFor(name).overrides[year] = num;
    }
    refreshCountry(name);
}

// --- paste a column of growth rates at once ---
// text: newline-separated values copied from Excel (col G). startYear: the year
// of the cell pasted into; values fill DOWN the table from there (newest->oldest,
// matching both the table order and the workbook's row order).
// Interpretation: a trailing '%' always means percent; otherwise the whole
// column is read as decimals (0.03 = 3%) when every value is < 1, else as
// percents (3 = 3%). Blank cells clear that year's growth.
function pasteGrowthColumn(name, startYear, text) {
    const lines = text.replace(/\r/g, '').split('\n');
    if (lines.length && lines[lines.length - 1].trim() === '') lines.pop(); // Excel's trailing newline
    if (!lines.length) return;

    const cells = lines.map((line) => {
        const s = line.split('\t')[0].trim(); // first column only, if multiple copied
        if (s === '') return { blank: true };
        const isPct = /%/.test(s);
        const n = parseFloat(s.replace(/[%,\s$]/g, ''));
        return { blank: false, isPct, n: isFinite(n) ? n : null };
    });

    const bare = cells.filter((c) => !c.blank && c.n != null && !c.isPct).map((c) => Math.abs(c.n));
    const bareAsDecimal = bare.length > 0 && Math.max(...bare) < 1; // whole column < 1 -> decimals

    // growth-input years in table order (newest-first, excludes the oldest year)
    const minYear = yearRange().min;
    const years = state.computed.get(name).map((r) => r.earthYear).filter((y) => y !== minYear);
    const start = years.indexOf(startYear);
    if (start < 0) return;

    const e = editsFor(name);
    let set = 0, cleared = 0, skipped = 0, k = 0;
    for (; k < cells.length && start + k < years.length; k++) {
        const year = years[start + k];
        const c = cells[k];
        if (c.blank) { delete e.growth[year]; cleared++; continue; }
        if (c.n == null) { skipped++; continue; }
        const rate = c.isPct ? c.n / 100 : (bareAsDecimal ? c.n : c.n / 100);
        e.growth[year] = Math.round(rate * 1e6) / 1e6;
        set++;
    }
    const overflow = cells.length - k; // values that ran past the oldest year
    refreshCountry(name);

    const first = years[start], last = years[Math.min(start + k, years.length) - 1];
    const read = bareAsDecimal ? 'decimals (0.03 → 3%)' : 'percent (3 → 3%)';
    const bits = [`Pasted ${set} value${set === 1 ? '' : 's'} into ${first} → ${last}, read as ${read}`];
    if (cleared) bits.push(`${cleared} cleared`);
    if (skipped) bits.push(`${skipped} unreadable skipped`);
    if (overflow > 0) bits.push(`${overflow} ignored (ran past ${minYear + 1})`);
    setPasteStatus(bits.join(' · '));
}

function setPasteStatus(msg) {
    const el = $('paste-status');
    if (el) el.textContent = msg || '';
}

// Fill growth between consecutive $ pins (and the 2015 anchor) with constant CAGR.
function interpolatePins(name) {
    const anchor = state.anchors.get(name);
    const { min, max } = yearRange();
    const merged = growthFor(name);

    // pin set: overrides + the anchor at the max year (unless already overridden)
    const pins = new Map();
    for (const [y, v] of Object.entries(merged.overrides)) pins.set(Number(y), v);
    if (!pins.has(max) && anchor != null) pins.set(max, anchor);

    const years = [...pins.keys()].sort((a, b) => a - b); // ascending (old -> new)
    if (years.length < 2) {
        window.alert('Add at least one per-capita $ pin (📌) — the 2015 anchor is the other end. Then interpolate.');
        return;
    }

    const e = editsFor(name);
    for (let i = 0; i < years.length - 1; i++) {
        const yo = years[i], yn = years[i + 1];        // older, newer
        const po = pins.get(yo), pn = pins.get(yn);
        if (!(po > 0) || !(pn > 0)) continue;
        const g = Math.pow(pn / po, 1 / (yn - yo)) - 1; // constant per-year growth
        for (let y = yo + 1; y <= yn; y++) e.growth[y] = Math.round(g * 1e6) / 1e6;
    }
    refreshCountry(name);
}

// --- archetype presets --- (earthYear -> per-capita growth rate)
const ARCHETYPES = {
    developing: { label: 'Developing (fast catch-up, slowing)', fn: (t) => 0.03 + 0.04 * (1 - t) },
    developed: { label: 'Developed (steady ~2%)', fn: () => 0.02 },
    postwar: { label: 'Postwar boom then slowdown', fn: (t) => t < 0.46 ? 0.05 : 0.022 },
    boombust: { label: 'Boom–bust (oscillating ~3%)', fn: (t, y) => 0.03 + 0.035 * Math.sin((y - 1950) / 3.2) },
};
function applyArchetype(name, kind) {
    const arch = ARCHETYPES[kind];
    if (!arch) return;
    const { min, max } = yearRange();
    const span = max - min || 1;
    const e = editsFor(name);
    e.growth = {}; // archetype defines the whole curve; pins still override exact $
    for (let y = min + 1; y <= max; y++) {
        const t = (y - min) / span;
        e.growth[y] = Math.round(arch.fn(t, y) * 1e6) / 1e6;
    }
    refreshCountry(name);
}

// --- pin list UI ---
function renderPinList(name) {
    const box = $('edit-pins');
    if (!box) return;
    const ov = growthFor(name).overrides;
    const years = Object.keys(ov).map(Number).sort((a, b) => b - a);
    box.innerHTML = years.length
        ? 'Pins: ' + years.map((y) => `<span class="gdp-pin-chip">${y} = ${fmtMoney(ov[y])} <b data-year="${y}">×</b></span>`).join(' ')
        : '<span class="gdp-note">No $ pins yet — click 📌 in the table, or add one below.</span>';
    box.querySelectorAll('.gdp-pin-chip b').forEach((x) => {
        x.addEventListener('click', () => {
            delete editsFor(name).overrides[Number(x.dataset.year)];
            refreshCountry(name);
        });
    });
}

// ========================================================================
//  Chart plumbing / mode / events
// ========================================================================
function destroyChart(key) {
    if (state.charts[key]) { state.charts[key].destroy(); delete state.charts[key]; }
}
function rerenderAll() {
    if (!state.countries.length) return;
    renderYearView();
    if (!$('view-country').classList.contains('gdp-hidden')) renderCountryView();
}

function setMode(mode) {
    state.mode = mode;
    $('mode-view').setAttribute('aria-selected', String(mode === 'view'));
    $('mode-edit').setAttribute('aria-selected', String(mode === 'edit'));
    $('edit-panel').classList.toggle('gdp-hidden', mode !== 'edit');
    // editing lives in the country view — switch to it when entering Edit mode
    if (mode === 'edit') switchTab('country');
    else renderCountryView();
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

    const arch = $('ctl-archetype');
    if (arch && !arch.dataset.filled) {
        arch.innerHTML = '<option value="">Archetype…</option>' +
            Object.entries(ARCHETYPES).map(([k, a]) => `<option value="${k}">${a.label}</option>`).join('');
        arch.dataset.filled = '1';
    }
}

function bindEvents() {
    $('ctl-year').addEventListener('input', (e) => { state.year = Number(e.target.value); renderYearView(); });
    for (const id of ['ctl-metric', 'ctl-topn', 'ctl-all', 'ctl-pie']) {
        $(id).addEventListener('change', renderYearView);
    }
    $('ctl-country').addEventListener('change', renderCountryView);

    $('tab-year').addEventListener('click', () => switchTab('year'));
    $('tab-country').addEventListener('click', () => switchTab('country'));

    $('mode-view').addEventListener('click', () => setMode('view'));
    $('mode-edit').addEventListener('click', () => setMode('edit'));

    // authoring actions
    $('edit-interpolate').addEventListener('click', () => interpolatePins(selectedCountry()));
    $('edit-addpin').addEventListener('click', () => {
        const y = Number($('edit-pin-year').value);
        const { min, max } = yearRange();
        if (!(y >= min && y <= max)) { window.alert(`Enter an Earth Year between ${min} and ${max}.`); return; }
        promptPin(selectedCountry(), y);
    });
    $('ctl-archetype').addEventListener('change', (e) => {
        if (e.target.value) { applyArchetype(selectedCountry(), e.target.value); e.target.value = ''; }
    });
    $('edit-clearcountry').addEventListener('click', () => {
        const name = selectedCountry();
        delete state.edits[name];
        refreshCountry(name);
    });

    $('gdp-export').addEventListener('click', exportGrowthJson);
    $('gdp-clear').addEventListener('click', () => {
        if (!window.confirm('Discard ALL unsaved edits and revert to the committed gdp-growth.json?')) return;
        state.edits = {};
        localStorage.removeItem(DRAFT_KEY);
        computeAll(); rerenderAll(); updateDirty();
    });

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

// Export the sparse growth JSON (committed base merged with edits).
function exportGrowthJson() {
    const out = { generatedAt: new Date().toISOString(), countries: {} };
    const names = new Set([...Object.keys(state.baseGrowth), ...Object.keys(state.edits)]);
    for (const name of names) {
        const g = growthFor(name);
        const growth = {}, overrides = {};
        for (const [y, v] of Object.entries(g.growth)) if (typeof v === 'number') growth[y] = v;
        for (const [y, v] of Object.entries(g.overrides)) if (typeof v === 'number') overrides[y] = v;
        if (Object.keys(growth).length || Object.keys(overrides).length) out.countries[name] = { growth, overrides };
    }
    const blob = new Blob([JSON.stringify(out, null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'gdp-growth.json';
    a.click();
    URL.revokeObjectURL(a.href);
}

// ---------- boot ----------
let dragPlugin = null;
function resolveDragPlugin() {
    const p = window.ChartJSDragDataPlugin;
    dragPlugin = p ? (p.default || p) : null;
}

async function boot() {
    resolveDragPlugin();
    const [histRes] = await Promise.all([fetch(HISTORY_URL), loadContinents()]);
    if (!histRes.ok) {
        $('gdp-status').textContent = 'Could not load data/gdp-history.json — run `npm run gdp:build` first.';
        return;
    }
    const hist = await histRes.json();
    state.history = hist.countries || [];
    for (const c of state.history) state.anchors.set(c.name, c.anchor);

    try {
        const gRes = await fetch(GROWTH_URL);
        if (gRes.ok) { const g = await gRes.json(); state.baseGrowth = g.countries || {}; }
    } catch (e) { /* no committed growth yet — start blank */ }

    loadDraft();
    buildCountries();
    computeAll();
    initControls();
    bindEvents();
    updateDirty();
    $('gdp-status').textContent = `${state.history.length} countries loaded · ${Object.keys(state.baseGrowth).length} with committed growth data.`;
    $('gdp-main').classList.remove('gdp-hidden');
    rerenderAll();
}
boot();
