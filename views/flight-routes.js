// Flight Network — route-generation engine (the gravity model).
//
// PURE module: no DOM, no fs, no globals. Imported by both the browser (as the
// client-side fallback) and scripts/generate-routes.js (build time), so the same
// network is produced either way.
//
// Input: airport nodes shaped like views/flight-data.js buildAirports() output —
//   { id, city, country, x, y, lat, lon, metrics:{ population, gdpNominal, ... } }
// Output: { airports (with isHub + degree), routes }.

// --- Distance ------------------------------------------------------------
export function haversineKm(a, b, R) {
    const toRad = d => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const la1 = toRad(a.lat);
    const la2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pixelDistKm(a, b, kmPerPixel) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy) * kmPerPixel;
}

function distanceKm(a, b, cfg) {
    return cfg.distanceMode === 'pixel'
        ? pixelDistKm(a, b, cfg.kmPerPixel)
        : haversineKm(a, b, cfg.planetRadiusKm);
}

export function haulOf(distKm, cfg) {
    if (distKm < cfg.haulShortMax) return 'short';
    if (distKm < cfg.haulMediumMax) return 'medium';
    return 'long';
}

const pop = a => (a.metrics && a.metrics.population) || a.population || 0;
// Economic "mass" driving demand. City airports precompute `mass`
// (population × nation GDP-per-capita); country airports fall back to GDP, then
// population. One quantity keeps the gravity model source-agnostic.
const massOf = a => (Number.isFinite(a.mass) ? a.mass
    : ((a.metrics && a.metrics.gdpNominal) || a.gdp || pop(a) || 0));
// Nation wealth proxy = GDP-per-capita. Prefer the joined metric; otherwise
// recover it from mass / population (mass = pop × gdppc). Source-agnostic, never
// NaN: a city with no population/mass returns 1 (neutral).
const gdppcOf = a => {
    const g = a.metrics && a.metrics.gdpPerCapita;
    if (Number.isFinite(g) && g > 0) return g;
    const p = pop(a), m = massOf(a);
    return (p > 0 && m > 0) ? m / p : 1;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const keyOf = (x, y) => (x < y ? x + '|' + y : y + '|' + x);

// --- Network generation --------------------------------------------------
export function generateNetwork(airportsIn, cfg) {
    // Work on copies so the input isn't mutated; attach isHub/degree.
    const airports = airportsIn.map(a => ({ ...a, isHub: false, degree: 0 }));
    const eligible = airports.filter(a =>
        massOf(a) > 0 && Number.isFinite(a.lat) && Number.isFinite(a.lon));
    const aptById = new Map(eligible.map(a => [a.id, a]));

    // Global hubs: top-N by economic mass (id tiebreak for determinism).
    const byMass = [...eligible].sort((x, y) => massOf(y) - massOf(x) || x.id.localeCompare(y.id));
    const hubSet = new Set(byMass.slice(0, cfg.hubCount).map(a => a.id));
    for (const a of airports) a.isHub = hubSet.has(a.id);

    const hubs = eligible.filter(a => a.isHub);

    // --- Wealth / size scalars -------------------------------------------
    // Per-nation GDP-per-capita = mass-weighted mean of its airports' gdppc.
    // (mass-weighted so a nation's economic centre, not a tiny outpost, sets the
    // tone.) Iterate by sorted nation name for deterministic accumulation.
    const nationAgg = new Map();   // country -> { wSum, mSum }
    for (const a of eligible) {
        const c = a.country;
        if (!c) continue;
        const m = massOf(a);
        const agg = nationAgg.get(c) || { wSum: 0, mSum: 0 };
        agg.wSum += gdppcOf(a) * m;
        agg.mSum += m;
        nationAgg.set(c, agg);
    }
    const nationGdppc = new Map();
    let maxNationGdppc = 0;
    for (const c of [...nationAgg.keys()].sort()) {
        const { wSum, mSum } = nationAgg.get(c);
        const g = mSum > 0 ? wSum / mSum : 1;
        nationGdppc.set(c, g);
        if (g > maxNationGdppc) maxNationGdppc = g;
    }
    if (!(maxNationGdppc > 0)) maxNationGdppc = 1;
    const maxAirportPop = eligible.reduce((m, a) => Math.max(m, pop(a)), 0) || 1;

    // Nation wealth factor in [wealthFloor, 1]: poorest -> floor, richest -> 1.
    // The dominant lever on how many flights a country gets.
    const wealthFactor = country => {
        const g = nationGdppc.get(country);
        if (!Number.isFinite(g)) return 1;
        return clamp(Math.pow(g / maxNationGdppc, cfg.wealthExp), cfg.wealthFloor, 1);
    };
    // City size factor in [0, 1] from raw POPULATION (not economic mass): this is
    // the lever that lets a populous-but-poor nation's big cities earn routes even
    // though their wealth factor is low.
    const sizeFactor = a => clamp(pop(a) / maxAirportPop, 0, 1);

    // Guarantee each non-hub links to its nearest `spokeHubs` hubs so nothing is
    // stranded. Computed BEFORE candidates so these pairs can bypass the range
    // gate below — otherwise a spoke whose nearest hub is beyond maxRangeKm would
    // be dropped from candidates and never get its guaranteed route.
    const guaranteed = new Set();
    for (const s of eligible) {
        if (s.isHub || hubs.length === 0) continue;
        const nearHubs = hubs
            .map(h => ({ h, d: distanceKm(s, h, cfg) }))
            .filter(o => o.d > 0)
            .sort((p, q) => p.d - q.d || p.h.id.localeCompare(q.h.id))
            .slice(0, cfg.spokeHubs);
        for (const { h } of nearHubs) guaranteed.add(keyOf(s.id, h.id));
    }

    // Global trunk mesh: guarantee a long-haul route between every pair of hubs
    // within hubMeshMaxKm, so the major world cities interconnect (e.g. London
    // <-> Moscow/Rio/Dubai/NYC) instead of only flying to nearby foreign cities.
    // Guaranteed edges bypass the demand threshold and the degree-cap trim, so
    // these flagship routes survive even though distance decay makes them low-demand.
    for (let i = 0; i < hubs.length; i++) {
        for (let j = i + 1; j < hubs.length; j++) {
            const d = distanceKm(hubs[i], hubs[j], cfg);
            if (d > 0 && d <= cfg.hubMeshMaxKm) guaranteed.add(keyOf(hubs[i].id, hubs[j].id));
        }
    }

    // Candidate edges (all eligible pairs that pass the range gate or are guaranteed).
    const cands = [];
    for (let i = 0; i < eligible.length; i++) {
        for (let j = i + 1; j < eligible.length; j++) {
            const A = eligible[i];
            const B = eligible[j];
            // Two airports of the same city have no flight between them.
            if (A.displayCity && A.displayCity === B.displayCity) continue;
            const dist = distanceKm(A, B, cfg);
            if (!(dist > 0)) continue;
            const bothHub = A.isHub && B.isHub;
            const isGuaranteed = guaranteed.has(keyOf(A.id, B.id));
            if (dist > cfg.maxRangeKm && !bothHub && !isGuaranteed) continue;
            // Even hubs don't fly near-antipodal: bound trunk routes at the mesh range.
            if (bothHub && dist > cfg.hubMeshMaxKm) continue;
            // Hub<->hub trunk routes use a gentler distance decay so megacity pairs
            // stay high-volume at long haul; ordinary routes use the full decay.
            const beta = bothHub ? cfg.betaHub : cfg.beta;
            const denom = Math.pow(Math.max(dist, cfg.minDistanceKm || 1), beta);
            // base = raw gravity term; demandRaw layers domestic boost + wealth
            // dampening on top. We normalise by the spoke scale (below) so the
            // domestic boost lifts domestic edges above the international scale and
            // trunk routes top out thick.
            const base = Math.pow(massOf(A) * massOf(B), cfg.alpha) / denom;
            const domestic = !!(A.country && B.country && A.country === B.country);
            let demandRaw = base;
            if (domestic) demandRaw *= cfg.domesticDemandMult;
            demandRaw *= Math.min(wealthFactor(A.country), wealthFactor(B.country));
            cands.push({ A, B, dist, base, demandRaw, domestic, bothHub });
        }
    }
    // Normalise against the max base among NON-trunk pairs: the gentle-decay trunk
    // routes would otherwise inflate the scale and render everything else thin.
    // Trunk edges then exceed 1.0 (clamped to thickest when stored).
    let maxDemand = 0;
    for (const c of cands) if (!c.bothHub && c.base > maxDemand) maxDemand = c.base;
    if (!(maxDemand > 0)) maxDemand = cands.reduce((m, c) => Math.max(m, c.base), 0) || 1;
    for (const c of cands) c.demand = c.demandRaw / maxDemand;   // domestic/trunk edges may exceed 1.0; fine internally

    // Keep rule by edge class.
    const kept = [];
    for (const c of cands) {
        const k = keyOf(c.A.id, c.B.id);
        const aHub = c.A.isHub;
        const bHub = c.B.isHub;
        let keep;
        if (aHub && bHub) keep = c.demand >= cfg.demandThreshold;          // hub <-> hub
        else if (aHub || bHub) keep = c.demand >= cfg.demandThreshold;     // hub <-> spoke
        else keep = c.demand >= cfg.spokeSpokeThreshold;                   // spoke <-> spoke
        if (guaranteed.has(k)) keep = true;
        if (keep) kept.push(c);
    }

    // Degree cap: an edge survives if it is within the top-K demand of EITHER
    // endpoint (or guaranteed). Union across nodes avoids orphaning spokes.
    // The cap scales per airport — nation wealth (GDP/capita) is the primary
    // lever, city size a secondary one — so rich/big cities fan out widely while
    // poor/small ones get only a handful. Global hubs get a high floor.
    const capOf = a => {
        const w = wealthFactor(a.country);                        // GDP/capita
        const s = sizeFactor(a);                                  // population
        const wt = clamp(cfg.wealthWeight, 0, 1);                 // wealth vs population split
        const blend = wt * Math.pow(w, cfg.capWealthExp) + (1 - wt) * Math.pow(s, cfg.sizeExp);
        let cap = cfg.capMin + (cfg.capMax - cfg.capMin) * blend;
        if (a.isHub) cap = Math.max(cap, cfg.hubCapFloor);
        return Math.round(clamp(cap, cfg.capHardMin, cfg.capHardMax));
    };
    const incident = new Map(eligible.map(a => [a.id, []]));
    for (const c of kept) {
        incident.get(c.A.id).push(c);
        incident.get(c.B.id).push(c);
    }
    const allow = new Set();
    for (const [id, edges] of incident) {
        const cap = capOf(aptById.get(id));
        edges.sort((p, q) =>
            q.demand - p.demand ||
            keyOf(p.A.id, p.B.id).localeCompare(keyOf(q.A.id, q.B.id)));
        let count = 0;
        for (const e of edges) {
            const k = keyOf(e.A.id, e.B.id);
            if (guaranteed.has(k)) { allow.add(k); continue; }
            if (count < cap) { allow.add(k); count++; }
        }
    }

    // Final trim: the union-of-endpoints rule lets a very popular hub accumulate
    // far past its own cap (every spoke that ranks it keeps the edge). Bound any
    // node to capHardMax by dropping its lowest-demand NON-guaranteed edges,
    // processing the most overloaded nodes first (determinism via id tiebreak).
    const degreeOf = id => {
        let n = 0;
        for (const e of incident.get(id)) if (allow.has(keyOf(e.A.id, e.B.id))) n++;
        return n;
    };
    const overloaded = [...incident.keys()]
        .filter(id => degreeOf(id) > cfg.capHardMax)
        .sort((a, b) => degreeOf(b) - degreeOf(a) || a.localeCompare(b));
    for (const id of overloaded) {
        const edges = incident.get(id)
            .filter(e => allow.has(keyOf(e.A.id, e.B.id)) && !guaranteed.has(keyOf(e.A.id, e.B.id)))
            .sort((p, q) => p.demand - q.demand ||
                keyOf(p.A.id, p.B.id).localeCompare(keyOf(q.A.id, q.B.id)));
        let over = degreeOf(id) - cfg.capHardMax;
        for (const e of edges) {
            if (over <= 0) break;
            allow.delete(keyOf(e.A.id, e.B.id));
            over--;
        }
    }

    const routes = kept
        .filter(c => allow.has(keyOf(c.A.id, c.B.id)))
        .map(c => {
            const haul = haulOf(c.dist, cfg);
            return {
                from: c.A.id,
                to: c.B.id,
                fromCity: c.A.city,
                toCity: c.B.city,
                fromLat: c.A.lat, fromLon: c.A.lon,
                toLat: c.B.lat, toLon: c.B.lon,
                fromX: c.A.x, fromY: c.A.y,
                toX: c.B.x, toY: c.B.y,
                distanceKm: Math.round(c.dist),
                haul,
                domestic: c.domestic,
                demand: +Math.min(1, c.demand).toFixed(4)   // clamp for render (0..1); ranking used the raw value
            };
        })
        .sort((p, q) => q.demand - p.demand || keyOf(p.from, p.to).localeCompare(keyOf(q.from, q.to)));

    // Degrees from the final route set.
    const deg = new Map(eligible.map(a => [a.id, 0]));
    for (const r of routes) {
        deg.set(r.from, (deg.get(r.from) || 0) + 1);
        deg.set(r.to, (deg.get(r.to) || 0) + 1);
    }
    for (const a of airports) a.degree = deg.get(a.id) || 0;

    return { airports, routes };
}

// Shortest multi-leg path between two airports, minimising total distance
// (Dijkstra over the undirected route graph). Returns { legs:[route], totalKm }
// or null if unreachable. Array priority queue — fine for a few hundred nodes.
export function shortestPath(routes, fromId, toId) {
    if (fromId === toId) return { legs: [], totalKm: 0 };
    const adj = new Map();
    const link = (a, b, r) => {
        if (!adj.has(a)) adj.set(a, []);
        adj.get(a).push({ to: b, r });
    };
    for (const r of routes) { link(r.from, r.to, r); link(r.to, r.from, r); }

    const dist = new Map([[fromId, 0]]);
    const prev = new Map();
    const visited = new Set();
    const pq = [[0, fromId]];
    while (pq.length) {
        pq.sort((a, b) => a[0] - b[0]);
        const [d, u] = pq.shift();
        if (visited.has(u)) continue;
        visited.add(u);
        if (u === toId) break;
        for (const { to, r } of adj.get(u) || []) {
            const nd = d + r.distanceKm;
            if (nd < (dist.has(to) ? dist.get(to) : Infinity)) {
                dist.set(to, nd);
                prev.set(to, { from: u, r });
                pq.push([nd, to]);
            }
        }
    }
    if (!dist.has(toId)) return null;
    const legs = [];
    let cur = toId;
    while (cur !== fromId) {
        const p = prev.get(cur);
        if (!p) return null;
        legs.unshift(p.r);
        cur = p.from;
    }
    return { legs, totalKm: dist.get(toId) };
}

// Compact stats used by the build summary and the panel's default view.
export function networkSummary(airports, routes) {
    let busiest = null;
    for (const a of airports) if (!busiest || a.degree > busiest.degree) busiest = a;
    let longest = null;
    for (const r of routes) if (!longest || r.distanceKm > longest.distanceKm) longest = r;
    const hauls = { short: 0, medium: 0, long: 0 };
    let totalKm = 0;
    for (const r of routes) {
        hauls[r.haul] = (hauls[r.haul] || 0) + 1;
        totalKm += r.distanceKm;
    }
    return {
        airportCount: airports.length,
        routeCount: routes.length,
        hubCount: airports.filter(a => a.isHub).length,
        busiest,
        longest,
        hauls,
        totalKm
    };
}
