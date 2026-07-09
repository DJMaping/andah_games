// Flight Network — side panel.
//
// Stateless renderer: given the network + current selection it rebuilds the
// panel and wires events back through `handlers`. The page (js/flight-network.js)
// owns the state and calls renderPanel() again on every change.
//
// Two modes:
//   - no selection -> network stats dashboard + route planner
//   - a city selected -> info card + sortable route list

const ROUTE_COLS = [
    { key: 'city', label: 'Destination' },
    { key: 'country', label: 'Country' },
    { key: 'distanceKm', label: 'Distance' },
    { key: 'haul', label: 'Haul' },
    { key: 'demand', label: 'Demand' }
];

export function renderPanel(container, ctx) {
    const { network, summary, selectedId } = ctx;
    if (selectedId && network.airportById.has(selectedId)) {
        renderSelected(container, ctx);
    } else {
        renderDashboard(container, ctx);
    }
}

// --- Selected-city view --------------------------------------------------
function renderSelected(container, ctx) {
    const { network, selectedId, routeSort, config, handlers } = ctx;
    const a = network.airportById.get(selectedId);
    const m = a.metrics || {};
    const routes = (network.routesByAirport.get(selectedId) || []).slice();

    const other = r => (r.from === selectedId ? r.to : r.from);
    const otherCity = r => (r.from === selectedId ? r.toCity : r.fromCity);
    const otherCountry = r => {
        const o = network.airportById.get(other(r));
        return o ? o.country : '';
    };

    // Sort
    const { key, dir } = routeSort || { key: 'demand', dir: 'desc' };
    const sign = dir === 'asc' ? 1 : -1;
    routes.sort((x, y) => {
        let vx, vy;
        if (key === 'city') { vx = otherCity(x); vy = otherCity(y); return sign * String(vx).localeCompare(String(vy)); }
        if (key === 'country') { vx = otherCountry(x); vy = otherCountry(y); return sign * String(vx).localeCompare(String(vy)); }
        if (key === 'haul') { vx = haulRank(x.haul); vy = haulRank(y.haul); }
        else { vx = x[key]; vy = y[key]; }
        return sign * (vx - vy);
    });

    const longest = routes.reduce((m2, r) => (!m2 || r.distanceKm > m2.distanceKm ? r : m2), null);
    const busiestDest = routes.reduce((m2, r) => (!m2 || r.demand > m2.demand ? r : m2), null);

    container.innerHTML = `
        <button type="button" class="flight-back" data-action="clear">← Network overview</button>
        <div class="flight-card">
            <div class="flight-card-head">
                <img class="flight-flag" src="flags/${encodeURIComponent(a.country)}.png" alt="" decoding="async" onerror="this.style.display='none'">
                <div>
                    <h2 class="flight-city">${esc(a.city)} ${a.isHub ? '<span class="flight-tag">hub</span>' : ''}</h2>
                    <p class="flight-sub">${esc(a.country)}</p>
                </div>
            </div>
            <dl class="flight-stats">
                <div><dt>Population</dt><dd>${fmtInt(m.population)}</dd></div>
                <div><dt>GDP (nominal)</dt><dd>${fmtMoney(m.gdpNominal)}</dd></div>
                <div><dt>GDP (PPP)</dt><dd>${fmtMoney(m.gdpPpp)}</dd></div>
                <div><dt>Routes</dt><dd>${routes.length}</dd></div>
                ${busiestDest ? `<div><dt>Top route</dt><dd>${esc(otherCity(busiestDest))}</dd></div>` : ''}
                ${longest ? `<div><dt>Longest</dt><dd>${esc(otherCity(longest))} · ${fmtKm(longest.distanceKm)}</dd></div>` : ''}
            </dl>
        </div>

        <h3 class="flight-list-title">Routes from ${esc(a.city)}</h3>
        <table class="flight-routes">
            <thead><tr>${ROUTE_COLS.map(c =>
                `<th data-sort="${c.key}" class="${key === c.key ? 'sorted-' + dir : ''}">${c.label}</th>`).join('')}</tr></thead>
            <tbody>${routes.map(r => `
                <tr data-dest="${esc(other(r))}">
                    <td>${esc(otherCity(r))}</td>
                    <td class="muted">${esc(otherCountry(r))}</td>
                    <td>${fmtKm(r.distanceKm)}</td>
                    <td><span class="haul-dot" style="background:${config.haulColors[r.haul]}"></span>${r.haul}</td>
                    <td>${(r.demand * 100).toFixed(0)}</td>
                </tr>`).join('')}</tbody>
        </table>`;

    container.querySelector('[data-action="clear"]').addEventListener('click', () => handlers.onClearSelection());
    container.querySelectorAll('th[data-sort]').forEach(th =>
        th.addEventListener('click', () => handlers.onSortRoutes(th.dataset.sort)));
    container.querySelectorAll('tr[data-dest]').forEach(tr =>
        tr.addEventListener('click', () => handlers.onSelectAirport(tr.dataset.dest)));
}

// --- Network dashboard (no selection) -----------------------------------
function renderDashboard(container, ctx) {
    const { network, summary, planner, handlers, source } = ctx;
    const p = planner || {};
    const res = p.result;
    const cityName = id => {
        const a = id && network.airportById.get(id);
        return a ? a.city : '';
    };
    const cityOpts = network.airports
        .map(a => `<option value="${esc(a.city)}">${esc(a.country)}</option>`)
        .join('');

    container.innerHTML = `
        <div class="page-header">
            <h2 class="flight-city">Andah Flight Network</h2>
            <p class="flight-sub">Click a city on the globe or map to inspect its routes.</p>
        </div>

        <dl class="flight-stats">
            <div><dt>Airports</dt><dd>${summary.airportCount}</dd></div>
            <div><dt>Hubs</dt><dd>${summary.hubCount}</dd></div>
            <div><dt>Routes</dt><dd>${summary.routeCount}</dd></div>
            <div><dt>Network length</dt><dd>${fmtKm(summary.totalKm)}</dd></div>
            ${summary.busiest ? `<div><dt>Busiest</dt><dd>${esc(summary.busiest.city)} (${summary.busiest.degree})</dd></div>` : ''}
            ${summary.longest ? `<div><dt>Longest route</dt><dd>${fmtKm(summary.longest.distanceKm)}</dd></div>` : ''}
        </dl>

        <div class="flight-haulbar" title="Routes by haul">
            ${haulBar(summary)}
        </div>

        <h3 class="flight-list-title">Route planner</h3>
        <div class="flight-planner">
            <div class="flight-planner-row">
                <label>From <input type="text" data-planner="from" list="flight-planner-cities" placeholder="City" value="${esc(cityName(p.fromId))}"></label>
                <button type="button" class="flight-pick ${p.picking === 'from' ? 'picking' : ''}" data-pick="from" aria-pressed="${p.picking === 'from'}" title="Pick origin on the map">📍</button>
            </div>
            <div class="flight-planner-row">
                <label>To <input type="text" data-planner="to" list="flight-planner-cities" placeholder="City" value="${esc(cityName(p.toId))}"></label>
                <button type="button" class="flight-pick ${p.picking === 'to' ? 'picking' : ''}" data-pick="to" aria-pressed="${p.picking === 'to'}" title="Pick destination on the map">📍</button>
            </div>
            <button type="button" data-action="plan">Find route</button>
        </div>
        <datalist id="flight-planner-cities">${cityOpts}</datalist>
        ${p.picking ? `<p class="flight-pick-hint">Click a city on the map or globe to set the ${p.picking === 'from' ? 'origin' : 'destination'}.</p>` : ''}
        <div class="flight-planner-result">${plannerResultHtml(res, network)}</div>

        <p class="flight-source">Network ${source === 'prebuilt' ? 'loaded from build output' : 'generated in-browser'}.</p>`;

    const fromInput = container.querySelector('[data-planner="from"]');
    const toInput = container.querySelector('[data-planner="to"]');
    container.querySelector('[data-action="plan"]').addEventListener('click', () =>
        handlers.onPlannerRun(resolveCity(network, fromInput.value), resolveCity(network, toInput.value)));
    container.querySelectorAll('[data-pick]').forEach(btn =>
        btn.addEventListener('click', () => handlers.onPlannerPick(btn.dataset.pick)));
    container.querySelectorAll('.flight-leg[data-dest]').forEach(el =>
        el.addEventListener('click', () => handlers.onSelectAirport(el.dataset.dest)));
}

function plannerResultHtml(res, network) {
    if (res === undefined) return '';
    if (res === null) return '<p class="muted">No route found between those cities.</p>';
    if (!res.legs.length) return '<p class="muted">Origin and destination are the same.</p>';
    const legs = res.legs.map(r => {
        const a = network.airportById.get(r.from);
        const b = network.airportById.get(r.to);
        return `<li class="flight-leg" data-dest="${esc(r.to)}">${esc(a ? a.city : r.from)} → ${esc(b ? b.city : r.to)} <span class="muted">${fmtKm(r.distanceKm)}</span></li>`;
    }).join('');
    return `<ol class="flight-legs">${legs}</ol><p class="flight-total">${res.legs.length} leg(s) · ${fmtKm(res.totalKm)} total</p>`;
}

function haulBar(summary) {
    const total = Math.max(1, summary.routeCount);
    const seg = (haul, color) => {
        const n = summary.hauls[haul] || 0;
        const pct = (100 * n / total).toFixed(1);
        return `<span class="haul-seg" style="width:${pct}%;background:${color}" title="${haul}: ${n}"></span>`;
    };
    return seg('short', '#2e9e8f') + seg('medium', '#e0a33c') + seg('long', '#d65a45');
}

// Resolve typed text (a city name) back to an airport id. Returns null if the
// box is empty or nothing matches.
function resolveCity(network, text) {
    const q = String(text || '').trim().toLowerCase();
    if (!q) return null;
    const hit = network.airports.find(a => a.city.toLowerCase() === q)
        || network.airports.find(a => a.city.toLowerCase().startsWith(q));
    return hit ? hit.id : null;
}

// --- formatting ----------------------------------------------------------
function haulRank(h) { return h === 'short' ? 0 : h === 'medium' ? 1 : 2; }
function fmtInt(v) { return Number.isFinite(v) ? v.toLocaleString('en-US') : '—'; }
function fmtKm(v) { return Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') + ' km' : '—'; }
function fmtMoney(v) {
    if (!Number.isFinite(v)) return '—';
    if (v >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    return '$' + v.toLocaleString('en-US');
}
function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
