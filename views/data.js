// Data loader. Fetches the pre-built data/countries.json with a graceful
// fallback so the explore page still renders something when the build hasn't
// run yet (e.g. local dev before user provides .xlsx files).

export async function loadCountries() {
    try {
        const res = await fetch('data/countries.json', { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        console.warn('data/countries.json not available; falling back to andah-stats.js', e);
        return fallbackFromAndahStats();
    }
}

async function fallbackFromAndahStats() {
    // andah-stats.js is a classic script (sets window.andahStats). Load via a
    // dynamic <script> insertion so we don't need to convert it to an ES module.
    if (typeof window === 'undefined') return { countries: [], metricDefs: [] };
    if (!window.andahStats) await loadClassicScript('andah-stats.js');

    const stats = window.andahStats || [];
    const countries = stats.map(s => ({
        name: s.name,
        slug: s.name.toLowerCase().replace(/\s+/g, '-'),
        wikiTitle: s.name.replace(/\s+/g, '_'),
        metrics: {
            population: s.population,
            areaKm: s.areaKm,
            gdpNominal: s.gdpNominal,
            gdpPpp: s.gdpPpp,
            gdpPerNominal: s.gdpPerNominal,
            gdpPerPpp: s.gdpPerPpp
        },
        categorical: {},
        history: {}
    }));

    const metricDefs = [
        { key: 'population', label: 'Population', format: 'integer', scale: 'linear' },
        { key: 'areaKm', label: 'Area (km²)', format: 'integer', scale: 'linear' },
        { key: 'gdpNominal', label: 'GDP (nominal)', format: 'currency', scale: 'log' },
        { key: 'gdpPpp', label: 'GDP (PPP)', format: 'currency', scale: 'log' },
        { key: 'gdpPerNominal', label: 'GDP per capita', format: 'currency', scale: 'linear' },
        { key: 'gdpPerPpp', label: 'GDP per capita (PPP)', format: 'currency', scale: 'linear' }
    ];

    return { countries, metricDefs, _fallback: true };
}

function loadClassicScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(s);
    });
}

export async function loadMapCoords() {
    if (!window.andahMapCoords) {
        try {
            await loadClassicScript('andah-map-coords.js');
        } catch {
            return [];
        }
    }
    return window.andahMapCoords || [];
}

export async function loadWikiIndex() {
    try {
        const res = await fetch('data/wiki-index.json', { cache: 'no-cache' });
        if (!res.ok) return { pages: [] };
        return await res.json();
    } catch {
        return { pages: [] };
    }
}
