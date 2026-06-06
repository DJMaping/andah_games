// Flight Network — filter bar.
//
// Renders the route filters and reports a plain filter-state object via
// onChange. The page turns that state into a predicate (it has the airport
// index needed to resolve hub status). Kept in its own container so it survives
// the panel re-rendering on selection.
//
// Filter state: { hauls: { short, medium, long }, minDemand, trunkOnly }

export function createFilters(container, { config, onChange } = {}) {
    const state = {
        hauls: { short: true, medium: true, long: true },
        minDemand: 0,
        trunkOnly: false
    };

    container.innerHTML = `
        <div class="flight-filter-group" role="group" aria-label="Haul">
            ${['short', 'medium', 'long'].map(h => `
                <label class="flight-chip">
                    <input type="checkbox" data-haul="${h}" checked>
                    <span class="haul-dot" style="background:${config.haulColors[h]}"></span>${h}
                </label>`).join('')}
        </div>
        <label class="flight-chip">
            <input type="checkbox" data-trunk> Trunk (hub–hub) only
        </label>
        <label class="flight-slider">
            Min demand <input type="range" min="0" max="100" value="0" data-demand>
            <span data-demand-out>0</span>
        </label>`;

    const emit = () => onChange && onChange({ ...state, hauls: { ...state.hauls } });

    container.querySelectorAll('input[data-haul]').forEach(cb =>
        cb.addEventListener('change', () => { state.hauls[cb.dataset.haul] = cb.checked; emit(); }));
    container.querySelector('input[data-trunk]').addEventListener('change', e => {
        state.trunkOnly = e.target.checked; emit();
    });
    const demand = container.querySelector('input[data-demand]');
    const demandOut = container.querySelector('[data-demand-out]');
    demand.addEventListener('input', () => {
        state.minDemand = demand.value / 100;
        demandOut.textContent = demand.value;
        emit();
    });

    return { getState: () => ({ ...state, hauls: { ...state.hauls } }) };
}

// Build a route predicate from filter state + the airport index (for hub status).
export function makePredicate(state, airportById) {
    return route => {
        if (!state.hauls[route.haul]) return false;
        if (route.demand < state.minDemand) return false;
        if (state.trunkOnly) {
            const a = airportById.get(route.from);
            const b = airportById.get(route.to);
            if (!(a && b && a.isHub && b.isHub)) return false;
        }
        return true;
    };
}
