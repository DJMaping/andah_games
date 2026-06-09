// Andah Flight Network — page bootstrap.
//
// Owns the shared state (selected city, filters, planner) and wires the data
// layer to the globe view, 2D map view, side panel and filter bar. Each view
// exposes the same instance API { setData, update, focus, resize, destroy } so
// they stay in sync: a selection or filter change re-renders both.

import { loadNetwork } from '../views/flight-data.js';
import { FLIGHT_CONFIG } from '../views/flight-config.js';
import { networkSummary, shortestPath } from '../views/flight-routes.js';
import { createGlobe } from '../views/flight-globe.js';
import { createMap } from '../views/flight-map.js';
import { renderPanel } from '../views/flight-panel.js';
import { createFilters, makePredicate } from '../views/flight-filters.js';

const els = {
    status: () => document.getElementById('flight-status'),
    panel: () => document.getElementById('flight-panel'),
    filters: () => document.getElementById('flight-filters'),
    search: () => document.getElementById('flight-search'),
    cities: () => document.getElementById('flight-cities'),
    globeBtn: () => document.getElementById('view-globe-btn'),
    mapBtn: () => document.getElementById('view-map-btn'),
    globeView: () => document.getElementById('view-globe'),
    mapView: () => document.getElementById('view-map'),
    legend: () => document.getElementById('flight-legend')
};

// Colour-coded airport legend (dots are coloured by non-stop destination count).
function renderLegend() {
    const el = els.legend();
    if (!el) return;
    const rows = (FLIGHT_CONFIG.degreeBands || []).map(b =>
        `<li><span class="flight-legend-dot" style="background:${b.color}"></span>${b.label}</li>`
    ).join('');
    el.innerHTML = `
        <div class="flight-legend-head">
            <span>Airport legend</span>
            <button type="button" class="flight-legend-close" aria-label="Hide legend">&times;</button>
        </div>
        <ul class="flight-legend-list">${rows}</ul>`;
    el.querySelector('.flight-legend-close').addEventListener('click', () => { el.hidden = true; });
    el.hidden = false;
}

const state = {
    network: null,
    summary: null,
    activeView: 'globe',
    selectedId: null,
    routeSort: { key: 'demand', dir: 'desc' },
    filterState: null,
    predicate: () => true,
    planner: { fromId: null, toId: null, result: undefined, picking: null },
    globe: null,
    map: null,
    globeOk: false
};

function activeInstance() {
    return state.activeView === 'globe' ? state.globe : state.map;
}

function setView(view) {
    if (view === 'globe' && !state.globeOk) view = 'map';
    state.activeView = view;
    els.globeView().hidden = view !== 'globe';
    els.mapView().hidden = view !== 'map';
    els.globeBtn().setAttribute('aria-pressed', String(view === 'globe'));
    els.mapBtn().setAttribute('aria-pressed', String(view === 'map'));
    // The just-shown view had zero size while hidden — re-measure it.
    const inst = activeInstance();
    if (inst) requestAnimationFrame(() => inst.resize());
}

function wireToggle() {
    els.globeBtn().addEventListener('click', () => setView('globe'));
    els.mapBtn().addEventListener('click', () => setView('map'));
}

// The filtered route list only changes when the filter predicate changes — NOT
// when a city is selected. Cache it and recompute lazily so selecting a city
// doesn't re-scan all 7,000+ routes.
let cachedVisible = null;
let routesDirty = true;
function visibleRoutes() {
    if (routesDirty || !cachedVisible) {
        cachedVisible = state.network.routes.filter(state.predicate);
        routesDirty = false;
    }
    return cachedVisible;
}

// Coalesce view refreshes into a single animation frame. A rapid burst of
// changes (e.g. dragging the "min demand" slider, which fires on every input
// tick) collapses to one globe/map update per frame instead of re-binding all
// 7,000+ arcs on each event.
let viewRaf = 0;
function refreshViews() {
    if (viewRaf) return;
    viewRaf = requestAnimationFrame(() => {
        viewRaf = 0;
        const vs = { visibleRoutes: visibleRoutes(), selectedId: state.selectedId };
        if (state.globe) state.globe.update(vs);
        if (state.map) state.map.update(vs);
    });
}

function renderPanelNow() {
    renderPanel(els.panel(), {
        network: state.network,
        summary: state.summary,
        selectedId: state.selectedId,
        routeSort: state.routeSort,
        planner: state.planner,
        config: FLIGHT_CONFIG,
        source: state.network.source,
        handlers: {
            onSelectAirport: selectAirport,
            onClearSelection: clearSelection,
            onSortRoutes: sortRoutes,
            onPlannerRun: runPlanner,
            onPlannerPick: startPlannerPick
        }
    });
}

// Map/globe clicks route through here: while the planner is arming a slot
// (and no city is selected) a click fills that slot instead of opening the
// city's info card.
function viewSelect(id) {
    if (id && state.planner.picking && !state.selectedId) {
        assignPlannerPick(id);
        return;
    }
    selectAirport(id);
}

function startPlannerPick(slot) {
    state.planner.picking = state.planner.picking === slot ? null : slot;
    renderPanelNow();
}

function assignPlannerPick(id) {
    const slot = state.planner.picking;
    if (slot === 'from') state.planner.fromId = id;
    else state.planner.toId = id;
    // Picking the origin first auto-advances to the destination.
    state.planner.picking = (slot === 'from' && !state.planner.toId) ? 'to' : null;
    if (state.planner.fromId && state.planner.toId && !state.planner.picking) {
        runPlanner(state.planner.fromId, state.planner.toId);
    } else {
        renderPanelNow();
    }
}

function selectAirport(id) {
    if (!id) { clearSelection(); return; }
    if (!state.network.airportById.has(id)) return;
    state.selectedId = id;
    renderPanelNow();
    refreshViews();
    if (state.activeView === 'globe' && state.globe) state.globe.focus(id);
}

function clearSelection() {
    state.selectedId = null;
    renderPanelNow();
    refreshViews();
}

function sortRoutes(key) {
    if (state.routeSort.key === key) {
        state.routeSort.dir = state.routeSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
        state.routeSort = { key, dir: (key === 'city' || key === 'country') ? 'asc' : 'desc' };
    }
    renderPanelNow();
}

function runPlanner(fromId, toId) {
    const result = shortestPath(state.network.routes, fromId, toId);
    state.planner = { fromId, toId, result, picking: null };
    renderPanelNow();
}

function applyFilters() {
    state.predicate = makePredicate(state.filterState, state.network.airportById);
    routesDirty = true;   // filter changed -> recompute the visible set next refresh
    refreshViews();
}

function wireSearch() {
    const input = els.search();
    const datalist = els.cities();
    if (datalist) {
        datalist.innerHTML = state.network.airports
            .map(a => `<option value="${a.city}">${a.country}</option>`)
            .join('');
    }
    const run = () => {
        const q = input.value.trim().toLowerCase();
        if (!q) return;
        const hit = state.network.airports.find(a => a.city.toLowerCase() === q)
            || state.network.airports.find(a => a.city.toLowerCase().startsWith(q))
            || state.network.airports.find(a => a.country.toLowerCase().startsWith(q));
        if (hit) selectAirport(hit.id);
    };
    input.addEventListener('change', run);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
}

async function init() {
    wireToggle();

    state.network = await loadNetwork(FLIGHT_CONFIG);
    state.summary = networkSummary(state.network.airports, state.network.routes);

    // 2D map first — it has no external dependency and always works.
    state.map = createMap(els.mapView(), { config: FLIGHT_CONFIG, onSelect: viewSelect });
    state.map.setData(state.network);

    // Globe needs globe.gl from a CDN; degrade to map-only if it can't load.
    try {
        state.globe = await createGlobe(els.globeView(), { config: FLIGHT_CONFIG, onSelect: viewSelect });
        state.globe.setData(state.network);
        state.globeOk = true;
    } catch (e) {
        console.warn('[flight-network] globe unavailable, using map only', e);
        state.globeOk = false;
        els.globeBtn().disabled = true;
        els.globeBtn().title = 'Globe view needs an internet connection (globe.gl).';
        els.globeView().innerHTML = '<p class="flight-status">3D globe needs globe.gl (internet). Showing the 2D map instead.</p>';
    }

    // Filters
    const filters = createFilters(els.filters(), {
        config: FLIGHT_CONFIG,
        onChange: fs => { state.filterState = fs; applyFilters(); }
    });
    state.filterState = filters.getState();
    applyFilters();

    renderPanelNow();
    wireSearch();

    renderLegend();
    setView(state.globeOk ? 'globe' : 'map');
    els.status().style.display = 'none';
    refreshViews();
}

init().catch(e => {
    console.error('[flight-network] init failed', e);
    const status = els.status();
    if (status) {
        status.style.display = 'flex';
        status.textContent = `Failed to load the flight network: ${e.message}`;
    }
});
