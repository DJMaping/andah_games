// Explore page router. Tabs: map / table / charts / time-series.
// Drill-down: #country=<slug> renders the per-country detail view.

import { loadCountries, loadMapCoords, loadWikiIndex } from './views/data.js';
import { renderTable } from './views/table.js';
import { renderMap } from './views/world-map.js';
import { renderChartControls, renderChart } from './views/charts.js';
import { renderTimeSeries } from './views/time-series.js';
import { renderCountryDetail } from './views/country-detail.js';

const STATE = {
    view: 'map',
    metric: null,
    filters: { search: '' },
    chart: { type: 'bar', x: null, y: null }
};

const els = {
    explore: () => document.getElementById('view-explore'),
    detail: () => document.getElementById('view-detail'),
    controls: () => document.getElementById('viz-controls'),
    panel: () => document.getElementById('viz-panel'),
    subtitle: () => document.getElementById('explore-subtitle'),
    tabs: () => document.querySelectorAll('.viz-tab')
};

let DATA = null;
let COORDS = [];
let WIKI = null;

async function init() {
    [DATA, COORDS, WIKI] = await Promise.all([loadCountries(), loadMapCoords(), loadWikiIndex()]);

    const firstNumeric = (DATA.metricDefs || []).find(d => !d.hidden);
    STATE.metric = firstNumeric?.key || null;
    STATE.chart.x = firstNumeric?.key || null;
    STATE.chart.y = (DATA.metricDefs || []).find(d => !d.hidden && d.key !== STATE.chart.x)?.key || STATE.chart.x;

    if (DATA._fallback) {
        els.subtitle().innerHTML = 'Showing the country-level dataset from <code>andah-stats.js</code>. Drop .xlsx files into <code>.xlsx files/</code> and run <code>npm run build</code> to enrich this page.';
    }

    els.tabs().forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));

    window.addEventListener('hashchange', applyHash);
    applyHash();
}

function applyHash() {
    const hash = (window.location.hash || '').replace(/^#/, '');
    const params = new URLSearchParams(hash);
    const country = params.get('country');
    if (country) {
        const match = DATA.countries.find(c => c.slug === country || c.name === country);
        if (match) {
            showDetail(match);
            return;
        }
    }
    showExplore();
}

function showExplore() {
    els.detail().hidden = true;
    els.explore().hidden = false;
    renderActiveView();
}

async function showDetail(country) {
    els.explore().hidden = true;
    els.detail().hidden = false;
    await renderCountryDetail({
        container: els.detail(),
        country,
        metricDefs: DATA.metricDefs,
        wikiIndex: WIKI,
        onBack: () => {
            window.location.hash = '';
        }
    });
}

function setView(view) {
    STATE.view = view;
    renderActiveView();
}

function renderActiveView() {
    els.tabs().forEach(b => b.classList.toggle('active', b.dataset.view === STATE.view));
    const panel = els.panel();
    const controls = els.controls();
    panel.innerHTML = '';
    controls.innerHTML = '';

    const filtered = applyFilters(DATA.countries);

    if (STATE.view === 'map') {
        renderMetricControl(controls, DATA.metricDefs, () => renderActiveView());
        renderMap({
            container: panel,
            countries: filtered,
            coords: COORDS,
            metric: STATE.metric,
            metricDefs: DATA.metricDefs,
            onSelect: c => { window.location.hash = `country=${encodeURIComponent(c.slug)}`; }
        });
    } else if (STATE.view === 'table') {
        renderTable({
            container: panel,
            countries: filtered,
            metricDefs: DATA.metricDefs,
            categoricalKeys: collectCategoricalKeys(filtered),
            onSelect: c => { window.location.hash = `country=${encodeURIComponent(c.slug)}`; },
            getFilters: () => STATE.filters,
            setFilters: f => Object.assign(STATE.filters, f)
        });
    } else if (STATE.view === 'charts') {
        renderChartControls({
            container: controls,
            metricDefs: DATA.metricDefs,
            state: STATE.chart,
            onChange: () => renderChart({
                container: panel,
                countries: filtered,
                metricDefs: DATA.metricDefs,
                state: STATE.chart,
                onSelect: c => { window.location.hash = `country=${encodeURIComponent(c.slug)}`; }
            })
        });
        renderChart({
            container: panel,
            countries: filtered,
            metricDefs: DATA.metricDefs,
            state: STATE.chart,
            onSelect: c => { window.location.hash = `country=${encodeURIComponent(c.slug)}`; }
        });
    } else if (STATE.view === 'time') {
        renderTimeSeries({ container: panel, countries: filtered, metricDefs: DATA.metricDefs });
    }
}

function renderMetricControl(container, metricDefs, onChange) {
    const visible = (metricDefs || []).filter(d => !d.hidden);
    container.innerHTML = `
        <label>Metric
            <select id="metric-select">
                ${visible.map(d => `<option value="${d.key}">${escapeHtml(d.label || d.key)}</option>`).join('')}
            </select>
        </label>
        <label>Search
            <input type="search" id="map-search" class="type-input" placeholder="Filter by name..." />
        </label>
    `;
    const $metric = container.querySelector('#metric-select');
    $metric.value = STATE.metric || visible[0]?.key;
    $metric.addEventListener('change', () => {
        STATE.metric = $metric.value;
        onChange();
    });
    const $search = container.querySelector('#map-search');
    $search.value = STATE.filters.search;
    $search.addEventListener('input', () => {
        STATE.filters.search = $search.value;
        onChange();
    });
}

function applyFilters(countries) {
    const q = (STATE.filters.search || '').trim().toLowerCase();
    if (!q) return countries;
    return countries.filter(c => c.name.toLowerCase().includes(q));
}

function collectCategoricalKeys(countries) {
    const set = new Set();
    for (const c of countries) {
        for (const k of Object.keys(c.categorical || {})) set.add(k);
    }
    return Array.from(set);
}

function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

init().catch(e => {
    console.error(e);
    document.getElementById('viz-panel').innerHTML = `<p class="result-text">Failed to load: ${escapeHtml(e.message)}</p>`;
});
