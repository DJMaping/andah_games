// Andah Flight Network — data layer.
//
// Turns the three source datasets (countries, map coordinates, capitals) into a
// single list of "airport" nodes that both the map and the globe views render,
// and provides the projection helpers that convert between map.png pixel space,
// geographic lat/lon, and points on a unit sphere (for the globe).
//
// The Andah world map (maps/map.png, 8966 x 3943) is treated as a standard
// equirectangular projection: the full image width spans 360° of longitude and
// the full height spans 180° of latitude. That lets one coordinate drive both
// the flat map (pixels directly) and the globe (lat/lon -> sphere).

import { loadCountries, loadMapCoords, loadCapitals } from './data.js';
import { FLIGHT_CONFIG } from './flight-config.js';
import { generateNetwork } from './flight-routes.js';

// Natural pixel dimensions of maps/map.png. Mirrors views/world-map.js; kept
// local so the data layer doesn't depend on a view module.
export const MAP_W = 8966;
export const MAP_H = 3943;

// Inverse equirectangular projection: map.png pixel (x, y) -> { lat, lon } in
// degrees. The top-left pixel is (lon -180, lat +90); the bottom-right pixel is
// (lon +180, lat -90).
export function pixelToLatLon(x, y) {
    const lon = (x / MAP_W) * 360 - 180;
    const lat = 90 - (y / MAP_H) * 180;
    return { lat, lon };
}

// Forward projection (round-trips pixelToLatLon): lat/lon degrees -> map pixel.
export function latLonToPixel(lat, lon) {
    const x = ((lon + 180) / 360) * MAP_W;
    const y = ((90 - lat) / 180) * MAP_H;
    return { x, y };
}

// lat/lon (degrees) -> a point on a sphere of the given radius. Y is up; the
// equator at lon 0 faces +Z. This matches the marker convention used with an
// equirectangular-textured Three.js SphereGeometry, so the globe view can place
// nodes directly on the textured map without re-deriving the math.
export function latLonToVec3(lat, lon, radius = 1) {
    const phi = (90 - lat) * Math.PI / 180;    // polar angle from +Y
    const theta = (lon + 180) * Math.PI / 180; // azimuth around +Y
    return {
        x: -radius * Math.sin(phi) * Math.cos(theta),
        y: radius * Math.cos(phi),
        z: radius * Math.sin(phi) * Math.sin(theta)
    };
}

function slugify(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Join countries + coords + capitals into airport nodes. An airport exists for
// every country that has BOTH a map coordinate (so it can be placed) and a named
// capital (the airport's city). Nodes are returned sorted by city name for a
// stable order across reloads.
//
// Airport node shape:
//   { id, city, country, countrySlug, x, y, lat, lon, metrics }
export function buildAirports({ countries = [], coords = [], capitals = [] } = {}) {
    const coordByName = new Map(coords.map(c => [c.name, c]));
    const capitalByName = new Map(capitals.map(c => [c.name, c.capital]));

    const airports = [];
    for (const country of countries) {
        const coord = coordByName.get(country.name);
        const capital = capitalByName.get(country.name);
        if (!coord || !capital) continue;

        const slug = country.slug || slugify(country.name);
        const { lat, lon } = pixelToLatLon(coord.x, coord.y);
        airports.push({
            id: slug,
            city: capital,
            country: country.name,
            countrySlug: slug,
            x: coord.x,
            y: coord.y,
            lat,
            lon,
            metrics: country.metrics || {}
        });
    }

    airports.sort((a, b) => a.city.localeCompare(b.city));
    return airports;
}

// id -> airport node, for O(1) lookups from the globe, map and side panel.
export function indexAirports(airports = []) {
    return new Map(airports.map(a => [a.id, a]));
}

async function fetchJson(path) {
    try {
        const res = await fetch(path, { cache: 'no-cache' });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

const LEGACY_MAP = { image: 'maps/map.png', width: MAP_W, height: MAP_H };

// Equirectangular projection for an arbitrary map size (the tagged city map is
// 10000×4999, not the legacy 8966×3943).
function pixelToLatLonWH(x, y, w, h) {
    return { lon: (x / w) * 360 - 180, lat: 90 - (y / h) * 180 };
}

// Load the whole network for the page, in priority order:
//   1. data/flight-cities.json   — tagged city airports (the new model)
//   2. data/airports.json + routes.json — the build output (country airports)
//   3. client-side generation from the country source data (always works)
//
// Returns { airports, routes, airportById, routesByAirport, source, map }.
export async function loadNetwork(config = FLIGHT_CONFIG) {
    const cityDoc = await fetchJson('data/flight-cities.json');
    if (cityDoc && Array.isArray(cityDoc.cities) && cityDoc.cities.length) {
        const airports = await buildCityAirports(cityDoc);
        const net = generateNetwork(airports, config);
        return finalizeNetwork(net.airports, net.routes, 'tagged', cityDoc.map || LEGACY_MAP);
    }

    const [airportsDoc, routesDoc] = await Promise.all([
        fetchJson('data/airports.json'),
        fetchJson('data/routes.json')
    ]);
    if (airportsDoc && airportsDoc.airports && airportsDoc.airports.length &&
        routesDoc && Array.isArray(routesDoc.routes)) {
        return finalizeNetwork(airportsDoc.airports, routesDoc.routes, 'prebuilt', LEGACY_MAP);
    }

    const [data, coords, capitals] = await Promise.all([
        loadCountries(),
        loadMapCoords(),
        loadCapitals()
    ]);
    const sourceAirports = buildAirports({
        countries: data.countries || [],
        coords,
        capitals
    });
    const net = generateNetwork(sourceAirports, config);
    return finalizeNetwork(net.airports, net.routes, 'client', LEGACY_MAP);
}

// Turn the tagger's data/flight-cities.json into airport nodes. Each city's
// economic mass = population × its nation's GDP-per-capita (joined from the
// country stats), so cities in richer nations pull more traffic.
async function buildCityAirports(cityDoc) {
    const data = await loadCountries();
    const gpcByNation = new Map();
    let gpcSum = 0, gpcN = 0;
    for (const c of data.countries || []) {
        const gpc = c.metrics && c.metrics.gdpPerNominal;
        if (Number.isFinite(gpc) && gpc > 0) {
            gpcByNation.set(c.name, gpc);
            gpcSum += gpc; gpcN++;
        }
    }
    const avgGpc = gpcN ? gpcSum / gpcN : 1;
    const map = cityDoc.map || LEGACY_MAP;

    const airports = [];
    for (const city of cityDoc.cities) {
        const population = Number.isFinite(city.population) ? city.population : 0;
        if (population <= 0 || !Number.isFinite(city.x) || !Number.isFinite(city.y)) continue;
        const gpc = gpcByNation.get(city.nation) || avgGpc;
        const mass = population * gpc;
        const { lat, lon } = pixelToLatLonWH(city.x, city.y, map.width, map.height);
        airports.push({
            id: city.id || slugCity(city.airport || city.city),
            city: city.airport && city.airport !== city.city ? city.airport : city.city,
            displayCity: city.city,
            country: city.nation,
            x: city.x,
            y: city.y,
            lat,
            lon,
            band: city.band || null,
            mass,
            metrics: { population, gdpPerCapita: gpc, gdpNominal: mass }
        });
    }
    return airports;
}

function slugCity(name) {
    return String(name).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
}

function finalizeNetwork(airports, routes, source, map) {
    const airportById = indexAirports(airports);
    const routesByAirport = new Map(airports.map(a => [a.id, []]));
    for (const r of routes) {
        if (routesByAirport.has(r.from)) routesByAirport.get(r.from).push(r);
        if (routesByAirport.has(r.to)) routesByAirport.get(r.to).push(r);
    }
    // Stable order within each airport's list: strongest demand first.
    for (const list of routesByAirport.values()) {
        list.sort((a, b) => b.demand - a.demand);
    }
    return { airports, routes, airportById, routesByAirport, source, map: map || LEGACY_MAP };
}
