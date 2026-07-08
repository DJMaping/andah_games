// Shared loader + per-capita history compute for the GDP mini-games
// (Richer-or-Poorer Time Machine, Guess the Trajectory).
//
// Mirrors the math in js/gdp-explorer.js exactly: population history is fixed
// (data/gdp-history.json), and per-capita GDP compounds BACKWARD from each
// country's 2015 anchor using the sparse authored growth layer
// (data/gdp-growth.json):
//   perCap(2015) = override ?? anchor
//   perCap(Y-1)  = override ?? perCap(Y) / (1 + growth(Y))   [blank growth = 0%]
// A year is "determined" only if every step back from 2015 had a growth input
// or an override pinned it.
//
// Exposes window.loadGdpSeries() -> Promise<{ countries, byName, minYear, maxYear }>
// where each country is { name, anchor, rows } and rows are NEWEST-FIRST:
//   { earthYear, year, pop, perCap, gdp, determined }
(function () {
    let cache = null;

    async function loadGdpSeries() {
        if (cache) return cache;

        const [histRes, growthRes] = await Promise.all([
            fetch('data/gdp-history.json'),
            fetch('data/gdp-growth.json').catch(() => null),
        ]);
        if (!histRes || !histRes.ok) throw new Error('Could not load data/gdp-history.json');
        const hist = await histRes.json();

        let growth = {};
        try { if (growthRes && growthRes.ok) growth = (await growthRes.json()).countries || {}; } catch (e) { /* start blank */ }

        let minYear = Infinity, maxYear = -Infinity;
        const countries = (hist.countries || []).map((h) => {
            const g = growth[h.name] || {};
            const gg = g.growth || {}, ov = g.overrides || {};
            const rows = h.rows.map(([earthYear, year, pop]) => {
                if (earthYear < minYear) minYear = earthYear;
                if (earthYear > maxYear) maxYear = earthYear;
                return {
                    earthYear, year, pop,
                    g: typeof gg[earthYear] === 'number' ? gg[earthYear] : null,
                    h: typeof ov[earthYear] === 'number' ? ov[earthYear] : null,
                };
            });
            // compound per-capita backward from the anchor (rows are newest-first)
            for (let i = 0; i < rows.length; i++) {
                const r = rows[i];
                if (i === 0) {
                    r.perCap = r.h != null ? r.h : h.anchor;
                    r.determined = r.h != null || h.anchor != null;
                } else {
                    const prev = rows[i - 1];
                    if (r.h != null) { r.perCap = r.h; r.determined = true; }
                    else {
                        const gr = prev.g != null ? prev.g : 0;
                        r.perCap = prev.perCap != null ? prev.perCap / (1 + gr) : null;
                        r.determined = prev.determined && prev.g != null;
                    }
                }
                r.gdp = r.perCap != null ? r.perCap * r.pop : null;
            }
            return { name: h.name, anchor: h.anchor, rows };
        });

        cache = {
            countries,
            byName: new Map(countries.map((c) => [c.name, c])),
            minYear: isFinite(minYear) ? minYear : 1950,
            maxYear: isFinite(maxYear) ? maxYear : 2015,
        };
        return cache;
    }

    window.loadGdpSeries = loadGdpSeries;
})();
