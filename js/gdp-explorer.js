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

// Fixed per-continent colours (DJ's mapping). Anything not listed falls back to
// the PALETTE; Unknown/N-a stay grey.
const CONTINENT_COLORS = {
    Ayuma: '#e4463c',          // red
    Atirha: '#4269d0',         // blue
    Massir: '#3ca951',         // green
    Mahea: '#9c6b4e',          // brown
    Quia: '#ff8ab7',           // pink
    Acrola: '#efb118',         // yellow
    'New Ayre': '#97bbf5',     // light blue
    'Ayuma/Acrola': '#6cc5b0', // (left as-is — distinct teal)
    Unknown: '#9498a0',        // grey
    'N/a': '#9498a0',          // grey
};

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
    playTimer: null,      // setInterval handle for the racing-bar animation
    playSpeed: 350,       // ms per year
};

// ---------- formatting ----------
// Symbol-free: the lahn glyph is added by lahnMoney() (HTML) or lahnAxisPlugin
// (chart axes). Tooltips call fmtMoney directly and stay plain, as chosen.
function fmtMoney(v) {
    if (v == null || !isFinite(v)) return '–';
    const abs = Math.abs(v);
    if (abs >= 1e12) return (v / 1e12).toFixed(2) + 'T';
    if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    return Math.round(v).toLocaleString('en-US');
}
// HTML money with a leading lahn glyph (theme-aware via CSS). Use in innerHTML.
function lahnMoney(v) {
    if (v == null || !isFinite(v)) return fmtMoney(v);
    return `<span class="lahn-sym" role="img" aria-label="lahn"></span>${fmtMoney(v)}`;
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
        names.forEach((n, i) => state.continentColors.set(n, CONTINENT_COLORS[n] || PALETTE[i % PALETTE.length]));
    } catch (e) { /* file:// or missing build — charts fall back to single hue */ }
}
function continentOf(name) { return state.continents.get(name) || 'Unknown'; }
function colorOf(name) {
    return state.continentColors.get(continentOf(name)) || CONTINENT_COLORS.Unknown;
}

// ---------- flag images for horizontal bar-chart labels ----------
// Chart.js can't embed images in tick labels, so the two country bar charts
// (top-N metric + CAGR) draw a small flag just left of each country's y-axis
// name via flagLabelsPlugin. Flags live at flags/<Name>.png (same convention
// the games use). Images are cached module-wide so switching years is instant.
const FLAG_H = 13;    // flag height in px (~ the tick font size)
const FLAG_GAP = 5;   // gap between flag and the name
const FLAG_PAD = 36;  // left padding reserved on the chart for the flag column
const flagImages = new Map(); // name -> HTMLImageElement (may still be loading)

function flagImage(name, onReady) {
    let img = flagImages.get(name);
    if (img) return img;
    img = new Image();
    img.onload = () => { onReady && onReady(); };
    img.onerror = () => { img.broken = true; };
    img.src = `flags/${encodeURIComponent(name)}.png`;
    flagImages.set(name, img);
    return img;
}

const flagLabelsPlugin = {
    id: 'flagLabels',
    afterDraw(chart) {
        const yScale = chart.scales.y;
        if (!yScale || !chart.ctx) return;
        const labels = chart.data.labels || [];
        const ctx = chart.ctx;
        const tickFont = (chart.options.scales.y.ticks || {}).font || {};
        const size = tickFont.size || Chart.defaults.font.size || 12;
        const family = tickFont.family || Chart.defaults.font.family;
        const padRight = (chart.options.scales.y.ticks || {}).padding ?? 4;
        ctx.save();
        ctx.font = `${size}px ${family}`;
        for (const tick of yScale.ticks) {
            const name = labels[tick.value];
            // skip synthetic rows like "Others (12)" — only real countries have flags
            if (typeof name !== 'string' || !state.anchors.has(name)) continue;
            const img = flagImage(name, () => { try { chart.draw(); } catch (e) { /* chart gone */ } });
            if (!img.complete || img.broken || !img.naturalWidth) continue;
            const w = Math.min(Math.round(FLAG_H * img.naturalWidth / img.naturalHeight), 26);
            const textW = ctx.measureText(name).width;
            const labelLeft = chart.chartArea.left - padRight - textW;
            const fx = labelLeft - FLAG_GAP - w;
            const fy = yScale.getPixelForTick(yScale.ticks.indexOf(tick)) - FLAG_H / 2;
            try { ctx.drawImage(img, fx, fy, w, FLAG_H); } catch (e) { /* decode race */ }
        }
        ctx.restore();
    },
};

// ---------- lahn currency symbol (replaces "$") ----------
// The Andah currency is the lahn; its glyph lives at Lahn.png (black, for light
// mode) and Lahn-white.png (for dark mode). fmtMoney() itself is symbol-free —
// HTML money uses <span class="lahn-sym"> (see lahnMoney) and money chart AXES
// draw the glyph before each tick via lahnAxisPlugin. Tooltips stay plain.
const lahnLight = new Image(); lahnLight.src = 'Lahn.png';
const lahnDark = new Image(); lahnDark.src = 'Lahn-white.png';
function currentLahnImage() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? lahnDark : lahnLight;
}
// once a glyph finishes loading, repaint any live charts so their axes get it
[lahnLight, lahnDark].forEach((im) => {
    im.onload = () => { for (const k in state.charts) { try { state.charts[k].draw(); } catch (e) { /* gone */ } } };
});

// Draw the lahn glyph immediately left of each tick label on any scale tagged
// `lahn: true` (money axes). Works for the bottom value axis (bar/bubble) and
// left/right y axes (line/compare/area). Mirrors the flag-label technique.
const lahnAxisPlugin = {
    id: 'lahnAxis',
    afterDraw(chart) {
        const img = currentLahnImage();
        if (!img || !img.complete || !img.naturalWidth || !chart.ctx) return;
        const ctx = chart.ctx;
        for (const id in chart.scales) {
            const scale = chart.scales[id];
            if (!scale || !scale.options || !scale.options.lahn) continue;
            const f = (scale.options.ticks || {}).font || {};
            const size = f.size || Chart.defaults.font.size || 12;
            const family = f.family || Chart.defaults.font.family;
            const pad = (scale.options.ticks || {}).padding ?? 3;
            const h = Math.round(size * 0.98);
            const w = Math.max(1, Math.round(h * img.naturalWidth / img.naturalHeight));
            const gap = 3;
            const tickLen = (scale.options.grid && scale.options.grid.tickLength != null) ? scale.options.grid.tickLength : 8;
            const horizontal = scale.isHorizontal();
            const cb = (scale.options.ticks || {}).callback;
            ctx.save();
            ctx.font = `${size}px ${family}`;
            for (let i = 0; i < scale.ticks.length; i++) {
                const t = scale.ticks[i];
                let label = cb ? cb.call(scale, t.value, i, scale.ticks) : `${t.value}`;
                if (Array.isArray(label)) label = label.join(' ');
                label = String(label ?? '');
                if (!label || label === '–') continue;
                const textW = ctx.measureText(label).width;
                let gx, gy;
                if (horizontal) {
                    const cx = scale.getPixelForTick(i);
                    gx = cx - textW / 2 - gap - w;
                    gy = scale.top + tickLen + pad + size / 2 - h / 2; // below the axis line + tick marks
                } else {
                    const numLeft = scale.position === 'right' ? scale.left + pad : scale.right - pad - textW;
                    gx = numLeft - gap - w;
                    gy = scale.getPixelForTick(i) - h / 2;
                }
                try { ctx.drawImage(img, gx, gy, w, h); } catch (e) { /* decode race */ }
            }
            ctx.restore();
        }
    },
};

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

function renderYearView(opts = {}) {
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
    // Chart titles lead with the Andah year and show the Earth year in brackets.
    const titleYear = fictionalYear != null ? `${fictionalYear} (${year})` : `${year}`;

    const valueOf = (e) => metric === 'gdp' ? e.row.gdp : metric === 'perCap' ? e.row.perCap : e.row.gdpGrowth;
    entries.sort((a, b) => (valueOf(b) ?? -Infinity) - (valueOf(a) ?? -Infinity));

    const worldGdp = entries.reduce((s, e) => s + (e.row.gdp || 0), 0);
    const worldPop = entries.reduce((s, e) => s + (e.row.pop || 0), 0);
    $('year-summary').innerHTML = entries.length
        ? `World (of ${entries.length} countries with data): total GDP ${lahnMoney(worldGdp)} · GDP per capita ${lahnMoney(worldPop ? worldGdp / worldPop : null)}`
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
    $('bar-title').textContent = `${metricLabel} — ${titleYear}`;
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
            layout: { padding: { left: FLAG_PAD } }, // room for the flag column
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (ctx) => ' ' + fmtVal(ctx.parsed.x) } },
            },
            scales: {
                x: { lahn: metric !== 'growth', ticks: { color: tc.muted, callback: (v) => fmtVal(v) }, grid: { color: tc.grid } },
                y: { ticks: { color: tc.text, autoSkip: false }, grid: { display: false } },
            },
        },
        plugins: [flagLabelsPlugin, lahnAxisPlugin],
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
        $('pie-title').textContent = `GDP by continent — ${titleYear}`;
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
        $('pie-title').textContent = `Share of world GDP — ${titleYear}`;
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

    // ----- new snapshot + trend charts -----
    renderBubble();
    renderTreemap();
    if (opts.snapshot) {
        // year-independent trends don't change while the slider moves — just
        // nudge the continent-area year marker (cheap redraw, no rebuild).
        if (state.charts.continentArea) state.charts.continentArea.update('none');
    } else {
        renderContinentArea();
        renderCagr();
    }
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
    $('country-status').innerHTML = `${filled}/${rows.length} years determined · anchor ${lahnMoney(state.anchors.get(name))} per capita (2015)`;

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
                y: { position: 'left', lahn: true, ticks: { color: tc.muted, callback: (v) => fmtMoney(v) }, grid: { color: tc.grid } },
                y1: { position: 'right', lahn: true, ticks: { color: tc.muted, callback: (v) => fmtMoney(v) }, grid: { display: false } },
            },
        },
        plugins: [lahnAxisPlugin],
    });

    renderGrowthChart(name, asc, tc, editing);
    renderCountryTable(name, rows, editing);
    if (editing) renderPinList(name);
    renderCompare();
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
            ? `<td class="gdp-edit-cell ${r.pinned ? 'pinned' : ''}"><span class="gdp-pin-btn" data-year="${r.earthYear}" title="Pin an exact per-capita amount (lahn) for this year">📌</span>${lahnMoney(r.perCap)}</td>`
            : `<td class="${r.pinned ? 'pinned' : ''}" title="${r.pinned ? 'Pinned by override' : ''}">${lahnMoney(r.perCap)}</td>`;
        return `
        <tr class="${r.determined ? '' : 'undetermined'}">
            <td>${r.earthYear}</td><td>${r.year ?? '–'}</td>
            <td>${fmtInt(r.pop)}</td>
            ${growthCell}
            ${pcCell}
            <td>${lahnMoney(r.gdp)}</td>
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
    const val = window.prompt(`Pin exact GDP per capita (in lahn) for ${name} in Earth Year ${year}:\n(blank to remove pin)`, current);
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
        window.alert('Add at least one per-capita lahn pin (📌) — the 2015 anchor is the other end. Then interpolate.');
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
        ? 'Pins: ' + years.map((y) => `<span class="gdp-pin-chip">${y} = ${lahnMoney(ov[y])} <b data-year="${y}">×</b></span>`).join(' ')
        : '<span class="gdp-note">No <span class="lahn-sym" role="img" aria-label="lahn"></span> pins yet — click 📌 in the table, or add one below.</span>';
    box.querySelectorAll('.gdp-pin-chip b').forEach((x) => {
        x.addEventListener('click', () => {
            delete editsFor(name).overrides[Number(x.dataset.year)];
            refreshCountry(name);
        });
    });
}

// ========================================================================
//  New visualizations (all additive, reuse state.computed)
// ========================================================================

// small helpers ---------------------------------------------------------
function withAlpha(hex, a) {
    const m = String(hex).replace('#', '');
    if (m.length < 6) return hex;
    const n = parseInt(m, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
// fictional (Andah) year label for an Earth year, e.g. "1765 (2015)"
function labelYear(earthYear) {
    for (const c of state.countries) {
        const r = rowFor(c.name, earthYear);
        if (r && r.year != null) return `${r.year} (${earthYear})`;
    }
    return `${earthYear}`;
}
// diverging growth colour: negative→red, ~0→grey, positive→green
function growthColor(v, max = 0.15) {
    if (v == null || !isFinite(v)) return '#6b7078';
    const t = Math.max(-1, Math.min(1, v / max));
    const neg = [192, 57, 43], mid = [122, 127, 135], pos = [46, 139, 87];
    const lerp = (a, b, f) => Math.round(a + (b - a) * f);
    const to = t < 0 ? neg : pos, f = Math.abs(t);
    return `rgb(${lerp(mid[0], to[0], f)},${lerp(mid[1], to[1], f)},${lerp(mid[2], to[2], f)})`;
}

// --- animated racing bars ----------------------------------------------
function stopPlay() {
    if (state.playTimer) { clearInterval(state.playTimer); state.playTimer = null; }
    const b = $('ctl-play');
    if (b) { b.textContent = '▶'; b.setAttribute('aria-pressed', 'false'); }
}
function startPlay() {
    const { min, max } = yearRange();
    if (state.year >= max) state.year = min;   // reached the end → replay from start
    $('ctl-year').value = state.year;
    renderYearView({ snapshot: true });
    state.playTimer = setInterval(() => {
        const { max } = yearRange();
        if (state.year >= max) { stopPlay(); return; }
        state.year++;
        $('ctl-year').value = state.year;
        renderYearView({ snapshot: true });
    }, state.playSpeed);
    const b = $('ctl-play');
    if (b) { b.textContent = '⏸'; b.setAttribute('aria-pressed', 'true'); }
}
function togglePlay() { state.playTimer ? stopPlay() : startPlay(); }

// --- development-landscape bubble ---------------------------------------
function renderBubble() {
    destroyChart('bubble');
    const canvas = $('chart-bubble');
    if (!canvas) return;
    const year = state.year, tc = themeColors();
    const pts = [];
    let maxGdp = 0;
    for (const c of state.countries) {
        const r = rowFor(c.name, year);
        if (!r || !r.determined || !(r.perCap > 0) || !(r.pop > 0)) continue;
        maxGdp = Math.max(maxGdp, r.gdp || 0);
        pts.push({ name: c.name, x: r.perCap, y: r.pop, gdp: r.gdp, color: colorOf(c.name) });
    }
    const t = $('bubble-title'); if (t) t.textContent = `Development landscape — ${labelYear(year)}`;
    const data = pts.map((p) => ({ x: p.x, y: p.y, r: 4 + 26 * Math.sqrt((p.gdp || 0) / (maxGdp || 1)), _p: p }));
    state.charts.bubble = new Chart(canvas, {
        type: 'bubble',
        data: { datasets: [{ data, backgroundColor: pts.map((p) => withAlpha(p.color, 0.6)), borderColor: pts.map((p) => p.color), borderWidth: 1 }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (ctx) => { const p = ctx.raw._p; return ` ${p.name}: per cap ${fmtMoney(p.x)} · pop ${fmtInt(p.y)} · GDP ${fmtMoney(p.gdp)}`; } } },
            },
            scales: {
                x: { type: 'logarithmic', lahn: true, title: { display: true, text: 'GDP per capita', color: tc.muted }, ticks: { color: tc.muted, callback: (v) => fmtMoney(v) }, grid: { color: tc.grid } },
                y: { type: 'logarithmic', title: { display: true, text: 'Population', color: tc.muted }, ticks: { color: tc.muted, callback: (v) => fmtInt(v) }, grid: { color: tc.grid } },
            },
        },
        plugins: [lahnAxisPlugin],
    });
}

// --- stock-market treemap heatmap (hand-rolled squarified, DOM boxes) ---
// items: [{value, ...}] (value>0). rect: {x,y,w,h}. Returns items + {x,y,w,h}.
function squarify(items, rect) {
    const out = [];
    const total = items.reduce((s, i) => s + i.value, 0);
    if (!items.length || total <= 0 || rect.w <= 0 || rect.h <= 0) return out;
    let { x, y, w, h } = rect;
    const scaled = items.map((i) => ({ item: i, area: (i.value / total) * (rect.w * rect.h) }));
    const worst = (rowArea, side, maxA, minA) =>
        Math.max((side * side * maxA) / (rowArea * rowArea), (rowArea * rowArea) / (side * side * minA));
    let i = 0;
    while (i < scaled.length) {
        const side = Math.min(w, h);
        const row = [scaled[i]];
        let rowArea = scaled[i].area;
        let j = i + 1;
        while (j < scaled.length) {
            let maxA = -Infinity, minA = Infinity;
            for (const c of row) { maxA = Math.max(maxA, c.area); minA = Math.min(minA, c.area); }
            const cur = worst(rowArea, side, maxA, minA);
            const nMax = Math.max(maxA, scaled[j].area), nMin = Math.min(minA, scaled[j].area);
            const next = worst(rowArea + scaled[j].area, side, nMax, nMin);
            if (next > cur) break;
            row.push(scaled[j]); rowArea += scaled[j].area; j++;
        }
        const thickness = rowArea / side;
        let offset = 0;
        for (const c of row) {
            const length = c.area / thickness;
            if (w >= h) out.push({ ...c.item, x, y: y + offset, w: thickness, h: length });
            else out.push({ ...c.item, x: x + offset, y, w: length, h: thickness });
            offset += length;
        }
        if (w >= h) { x += thickness; w -= thickness; } else { y += thickness; h -= thickness; }
        i = j;
    }
    return out;
}
function renderTreemap() {
    const el = $('treemap');
    if (!el) return;
    const year = state.year;
    const W = el.clientWidth, H = el.clientHeight;
    el.innerHTML = '';
    if (!W || !H) return;

    const items = [];
    for (const c of state.countries) {
        const r = rowFor(c.name, year);
        if (!r || !r.determined || !(r.gdp > 0)) continue;
        items.push({ name: c.name, value: r.gdp, growth: r.growthDetermined ? r.gdpGrowth : null, cont: continentOf(c.name), perCap: r.perCap, pop: r.pop });
    }
    if (!items.length) { el.innerHTML = '<p class="gdp-note" style="padding:1rem">No determined GDP for this year yet — author some growth curves in Edit mode.</p>'; return; }

    const byCont = new Map();
    for (const it of items) { if (!byCont.has(it.cont)) byCont.set(it.cont, []); byCont.get(it.cont).push(it); }
    const contItems = [...byCont.entries()]
        .map(([cont, list]) => ({ cont, list, value: list.reduce((s, i) => s + i.value, 0) }))
        .sort((a, b) => b.value - a.value);

    const gap = 3;
    for (const block of squarify(contItems, { x: 0, y: 0, w: W, h: H })) {
        const bx = block.x + gap / 2, by = block.y + gap / 2;
        const bw = Math.max(0, block.w - gap), bh = Math.max(0, block.h - gap);
        const cells = squarify(block.list.slice().sort((a, b) => b.value - a.value), { x: bx, y: by, w: bw, h: bh });
        for (const cell of cells) {
            const box = document.createElement('div');
            box.className = 'gdp-treemap-box';
            box.style.left = cell.x + 'px'; box.style.top = cell.y + 'px';
            box.style.width = Math.max(0, cell.w - 1) + 'px'; box.style.height = Math.max(0, cell.h - 1) + 'px';
            box.style.background = growthColor(cell.growth);
            const gStr = cell.growth != null ? fmtPct(cell.growth) : '–';
            box.title = `${cell.name} (${cell.cont})\nTotal GDP ${fmtMoney(cell.value)}\nGDP growth ${gStr}\nPer capita ${fmtMoney(cell.perCap)}`;
            if (cell.w > 36 && cell.h > 20) {
                box.innerHTML = `<span class="gdp-tm-name">${cell.name}</span>` + (cell.h > 34 ? `<span class="gdp-tm-val">${gStr}</span>` : '');
            }
            el.appendChild(box);
        }
        if (bw > 60 && bh > 28) {
            const lab = document.createElement('div');
            lab.className = 'gdp-treemap-cont';
            lab.style.left = bx + 'px'; lab.style.top = by + 'px';
            lab.textContent = block.cont;
            el.appendChild(lab);
        }
    }
}

// --- continental power over time (stacked area) ------------------------
// draws a dashed vertical marker at the currently-selected year
const yearMarkerPlugin = {
    id: 'yearMarker',
    afterDatasetsDraw(chart) {
        const idx = chart.data.labels.indexOf(state.year);
        if (idx < 0) return;
        const x = chart.scales.x.getPixelForValue(idx);
        if (x == null || isNaN(x)) return;
        const { ctx, chartArea } = chart;
        ctx.save();
        ctx.strokeStyle = themeColors().muted;
        ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
        ctx.restore();
    },
};
function renderContinentArea() {
    destroyChart('continentArea');
    const canvas = $('chart-continent-area');
    if (!canvas) return;
    const tc = themeColors();
    const { min, max } = yearRange();
    const years = [];
    for (let y = min; y <= max; y++) years.push(y);
    const byCont = new Map();
    const world = years.map(() => 0);
    for (const [name, rows] of state.computed) {
        const cont = continentOf(name);
        if (!byCont.has(cont)) byCont.set(cont, years.map(() => 0));
        const arr = byCont.get(cont);
        for (const r of rows) {
            if (!r.determined || !(r.gdp > 0)) continue;
            const i = r.earthYear - min;
            if (i < 0 || i >= years.length) continue;
            arr[i] += r.gdp; world[i] += r.gdp;
        }
    }
    const mode = $('ctl-area-mode') ? $('ctl-area-mode').value : 'share';
    const datasets = [...byCont.entries()]
        .filter(([, arr]) => arr.some((v) => v > 0))
        .sort((a, b) => b[1].reduce((s, v) => s + v, 0) - a[1].reduce((s, v) => s + v, 0))
        .map(([cont, arr]) => {
            const col = state.continentColors.get(cont) || '#9498a0';
            return {
                label: cont,
                data: arr.map((v, i) => mode === 'share' ? (world[i] ? v / world[i] * 100 : 0) : v),
                borderColor: col, backgroundColor: withAlpha(col, 0.55),
                fill: true, pointRadius: 0, borderWidth: 1, tension: 0.15,
            };
        });
    const yFmt = mode === 'share' ? (v) => v + '%' : (v) => fmtMoney(v);
    state.charts.continentArea = new Chart(canvas, {
        type: 'line',
        data: { labels: years, datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: tc.text, boxWidth: 12, font: { size: 10 } } },
                tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${mode === 'share' ? ctx.parsed.y.toFixed(1) + '%' : fmtMoney(ctx.parsed.y)}` } },
            },
            scales: {
                x: { ticks: { color: tc.muted, maxTicksLimit: 14 }, grid: { display: false } },
                y: Object.assign({ stacked: true, beginAtZero: true, min: 0, lahn: mode !== 'share', ticks: { color: tc.muted, callback: yFmt }, grid: { color: tc.grid } }, mode === 'share' ? { max: 100 } : {}),
            },
        },
        plugins: [yearMarkerPlugin, lahnAxisPlugin],
    });
}

// --- long-run per-capita CAGR ranking ----------------------------------
function renderCagr() {
    destroyChart('cagr');
    const canvas = $('chart-cagr');
    if (!canvas) return;
    const tc = themeColors();
    const { min, max } = yearRange();
    const span = max - min || 1;
    const list = [];
    for (const c of state.countries) {
        const rows = state.computed.get(c.name);
        if (!rows) continue;
        const rMax = rows.find((r) => r.earthYear === max);
        const rMin = rows.find((r) => r.earthYear === min);
        if (!rMax || !rMin || !rMax.determined || !rMin.determined || !(rMin.perCap > 0) || !(rMax.perCap > 0)) continue;
        list.push({ name: c.name, cagr: Math.pow(rMax.perCap / rMin.perCap, 1 / span) - 1 });
    }
    list.sort((a, b) => b.cagr - a.cagr);
    const topN = Math.max(3, Math.min(list.length || 3, Number($('ctl-topn').value) || 18));
    const shown = list.slice(0, topN);
    const t = $('cagr-title');
    if (t) t.textContent = `Long-run growth champions — per-capita CAGR ${min}→${max} (top ${shown.length})`;
    canvas.parentElement.style.height = Math.max(220, shown.length * 24 + 50) + 'px';
    state.charts.cagr = new Chart(canvas, {
        type: 'bar',
        data: { labels: shown.map((e) => e.name), datasets: [{ data: shown.map((e) => e.cagr), backgroundColor: shown.map((e) => colorOf(e.name)), borderWidth: 0 }] },
        options: {
            indexAxis: 'y', responsive: true, maintainAspectRatio: false,
            layout: { padding: { left: FLAG_PAD } }, // room for the flag column
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ' ' + fmtPct(ctx.parsed.x) } } },
            scales: {
                x: { ticks: { color: tc.muted, callback: (v) => fmtPct(v) }, grid: { color: tc.grid } },
                y: { ticks: { color: tc.text, autoSkip: false }, grid: { display: false } },
            },
        },
        plugins: [flagLabelsPlugin],
    });
}

// --- multi-country comparison overlay (Tab B, view-only) ---------------
function renderCompare() {
    const card = $('compare-card');
    if (!card) return;
    destroyChart('compare');
    const sel = $('ctl-compare');
    const picks = sel ? [...sel.selectedOptions].map((o) => o.value) : [];
    const editing = state.mode === 'edit';
    if (editing || !picks.length) { card.classList.add('gdp-hidden'); return; }
    card.classList.remove('gdp-hidden');

    const primary = selectedCountry();
    const names = [primary, ...picks.filter((n) => n !== primary)].slice(0, 6);
    const metric = $('ctl-compare-metric') ? $('ctl-compare-metric').value : 'perCap';
    const tc = themeColors();
    const { min, max } = yearRange();
    const years = [];
    for (let y = min; y <= max; y++) years.push(y);
    // In per-capita mode, also overlay each country's TOTAL GDP on a second
    // axis (per capita = solid/right, total = dashed/left, same colour).
    const dual = metric === 'perCap';
    const seriesVal = (r, which) => {
        if (!r) return null;
        if (which === 'growth') return r.growthDetermined ? r.perCapGrowth : null;
        return r.determined ? (which === 'gdp' ? r.gdp : r.perCap) : null;
    };
    const datasets = [];
    names.forEach((name, i) => {
        const rows = state.computed.get(name);
        if (!rows) return;
        const byYear = new Map(rows.map((r) => [r.earthYear, r]));
        const col = PALETTE[i % PALETTE.length];
        if (dual) {
            datasets.push({ label: `${name} · per cap`, data: years.map((y) => seriesVal(byYear.get(y), 'perCap')), yAxisID: 'y1', borderColor: col, backgroundColor: col, pointRadius: 0, borderWidth: 2, spanGaps: true });
            datasets.push({ label: `${name} · total`, data: years.map((y) => seriesVal(byYear.get(y), 'gdp')), yAxisID: 'y', borderColor: col, backgroundColor: col, pointRadius: 0, borderWidth: 1.5, borderDash: [5, 4], spanGaps: true });
        } else {
            datasets.push({ label: name, data: years.map((y) => seriesVal(byYear.get(y), metric)), borderColor: col, backgroundColor: col, pointRadius: 0, borderWidth: 2, spanGaps: true });
        }
    });
    const fmt = metric === 'growth' ? fmtPct : fmtMoney;
    const metricLabel = metric === 'gdp' ? 'Total GDP' : metric === 'growth' ? 'GDP/cap growth' : 'GDP per capita & total';
    const t = $('compare-title'); if (t) t.textContent = `Compare — ${metricLabel}`;
    const scales = dual
        ? {
            x: { ticks: { color: tc.muted, maxTicksLimit: 14 }, grid: { display: false } },
            y: { position: 'left', beginAtZero: true, lahn: true, title: { display: true, text: 'Total GDP (dashed)', color: tc.muted }, ticks: { color: tc.muted, callback: (v) => fmtMoney(v) }, grid: { color: tc.grid } },
            y1: { position: 'right', beginAtZero: true, lahn: true, title: { display: true, text: 'GDP per capita (solid)', color: tc.muted }, ticks: { color: tc.muted, callback: (v) => fmtMoney(v) }, grid: { display: false } },
        }
        : {
            x: { ticks: { color: tc.muted, maxTicksLimit: 14 }, grid: { display: false } },
            y: { lahn: metric !== 'growth', ticks: { color: tc.muted, callback: (v) => fmt(v) }, grid: { color: tc.grid } },
        };
    state.charts.compare = new Chart($('chart-compare'), {
        type: 'line',
        data: { labels: years, datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: tc.text } },
                tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` } },
            },
            scales,
        },
        plugins: [lahnAxisPlugin],
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
    if (mode === 'edit') stopPlay();
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

    const cmp = $('ctl-compare');
    if (cmp) {
        const picked = new Set([...cmp.selectedOptions].map((o) => o.value));
        cmp.innerHTML = state.countries.map((c) => `<option${picked.has(c.name) ? ' selected' : ''}>${c.name}</option>`).join('');
    }

    const arch = $('ctl-archetype');
    if (arch && !arch.dataset.filled) {
        arch.innerHTML = '<option value="">Archetype…</option>' +
            Object.entries(ARCHETYPES).map(([k, a]) => `<option value="${k}">${a.label}</option>`).join('');
        arch.dataset.filled = '1';
    }
}

function bindEvents() {
    $('ctl-year').addEventListener('input', (e) => { stopPlay(); state.year = Number(e.target.value); renderYearView({ snapshot: true }); });
    for (const id of ['ctl-metric', 'ctl-topn', 'ctl-all', 'ctl-pie']) {
        $(id).addEventListener('change', () => renderYearView());
    }
    $('ctl-play').addEventListener('click', togglePlay);
    $('ctl-speed').addEventListener('change', (e) => {
        state.playSpeed = Number(e.target.value) || 350;
        if (state.playTimer) { stopPlay(); startPlay(); } // restart at the new cadence
    });
    $('ctl-area-mode').addEventListener('change', renderContinentArea);
    $('ctl-country').addEventListener('change', renderCountryView);
    $('ctl-compare').addEventListener('change', renderCompare);
    $('ctl-compare-metric').addEventListener('change', renderCompare);

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
    stopPlay();
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
    // The UMD build auto-registers globally, which would make EVERY line/bar
    // chart draggable (e.g. the read-only "Continental power over time" area).
    // We only want the growth curve draggable, so pull it out of the global
    // registry — the growth chart re-adds it locally via its own plugins array.
    if (dragPlugin && window.Chart && typeof window.Chart.unregister === 'function') {
        try { window.Chart.unregister(dragPlugin); } catch (e) { /* wasn't registered */ }
    }
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
