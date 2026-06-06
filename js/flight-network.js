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
    mapView: () => document.getElementById('view-map')
};

const state = {
    network: null,
    summary: null,
    activeView: 'globe',
    selectedId: null,
    routeSort: { key: 'demand', dir: 'desc' },
    filterState: null,
    predicate: () => true,
    planner: { fromId: null, toId: null, result: undefined },
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

function visibleRoutes() {
    return state.network.routes.filter(state.predicate);
}

function refreshViews() {
    const vs = { visibleRoutes: visibleRoutes(), selectedId: state.selectedId };
    if (state.globe) state.globe.update(vs);
    if (state.map) state.map.update(vs);
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
            onPlannerRun: runPlanner
        }
    });
}

function selectAirport(id) {
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
    state.planner = { fromId, toId, result };
    renderPanelNow();
}

function applyFilters() {
    state.predicate = makePredicate(state.filterState, state.network.airportById);
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
    state.map = createMap(els.mapView(), { config: FLIGHT_CONFIG, onSelect: selectAirport });
    state.map.setData(state.network);

    // Globe needs globe.gl from a CDN; degrade to map-only if it can't load.
    try {
        state.globe = await createGlobe(els.globeView(), { config: FLIGHT_CONFIG, onSelect: selectAirport });
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
