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
const keyOf = (x, y) => (x < y ? x + '|' + y : y + '|' + x);

// --- Network generation --------------------------------------------------
export function generateNetwork(airportsIn, cfg) {
    // Work on copies so the input isn't mutated; attach isHub/degree.
    const airports = airportsIn.map(a => ({ ...a, isHub: false, degree: 0 }));
    const eligible = airports.filter(a =>
        massOf(a) > 0 && Number.isFinite(a.lat) && Number.isFinite(a.lon));
    const aptById = new Map(eligible.map(a => [a.id, a]));

    // Hubs: top-N by economic mass (id tiebreak for determinism).
    const byMass = [...eligible].sort((x, y) => massOf(y) - massOf(x) || x.id.localeCompare(y.id));
    const hubSet = new Set(byMass.slice(0, cfg.hubCount).map(a => a.id));
    for (const a of airports) a.isHub = hubSet.has(a.id);

    const hubs = eligible.filter(a => a.isHub);

    // Candidate edges (all eligible pairs that pass the range gate).
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
            if (dist > cfg.maxRangeKm && !bothHub) continue;
            const denom = Math.pow(Math.max(dist, cfg.minDistanceKm || 1), cfg.beta);
            const demandRaw = Math.pow(massOf(A) * massOf(B), cfg.alpha) / denom;
            cands.push({ A, B, dist, demandRaw });
        }
    }
    const maxDemand = cands.reduce((m, c) => Math.max(m, c.demandRaw), 0) || 1;
    for (const c of cands) c.demand = c.demandRaw / maxDemand;

    // Guarantee each non-hub links to its nearest `spokeHubs` hubs so nothing is
    // stranded (computed independent of the range/threshold gates above).
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
    const capOf = a => (a.isHub ? cfg.hubMaxRoutes : cfg.maxRoutesPerCity);
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
                domestic: false,
                demand: +c.demand.toFixed(4)
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
