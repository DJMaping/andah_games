#!/usr/bin/env node
// Generate the Andah flight network from the country data and write
// data/airports.json + data/routes.json. Deterministic: same inputs -> same
// output. The gravity model itself lives in views/flight-routes.js so the
// browser can reproduce the identical network as a fallback.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { toSlug } from './util/slug.js';
import { pixelToLatLon } from '../views/flight-data.js';
import { FLIGHT_CONFIG } from '../views/flight-config.js';
import { generateNetwork, networkSummary } from '../views/flight-routes.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');
const DATA_DIR = path.join(ROOT, 'data');

// The js/andah-*.js files are classic scripts that declare a top-level
// `const <varName> = [...]`. Eval each in an isolated function scope and return
// the binding (capitals uses unquoted keys, so JSON.parse won't do). These are
// trusted, local, version-controlled data files.
function loadClassicArray(file, varName) {
    const text = fs.readFileSync(file, 'utf8');
    // eslint-disable-next-line no-new-func
    return new Function(`${text}\n;return ${varName};`)();
}

function buildAirportsNode(stats, coords, capitals) {
    const coordByName = new Map(coords.map(c => [c.name, c]));
    const capitalByName = new Map(capitals.map(c => [c.name, c.capital]));

    const airports = [];
    for (const s of stats) {
        const coord = coordByName.get(s.name);
        const capital = capitalByName.get(s.name);
        if (!coord || !capital) continue;
        const { lat, lon } = pixelToLatLon(coord.x, coord.y);
        airports.push({
            id: toSlug(s.name),
            city: capital,
            country: s.name,
            countrySlug: toSlug(s.name),
            x: coord.x,
            y: coord.y,
            lat,
            lon,
            isCapital: true,   // country airports are the nation's capital by definition
            metrics: {
                population: s.population,
                areaKm: s.areaKm,
                gdpNominal: s.gdpNominal,
                gdpPpp: s.gdpPpp,
                gdpPerNominal: s.gdpPerNominal,
                gdpPerPpp: s.gdpPerPpp
            }
        });
    }
    airports.sort((a, b) => a.city.localeCompare(b.city));
    return airports;
}

export async function buildRoutes() {
    const stats = loadClassicArray(path.join(JS_DIR, 'andah-stats.js'), 'andahStats');
    const coords = loadClassicArray(path.join(JS_DIR, 'andah-map-coords.js'), 'andahMapCoords');
    const capitals = loadClassicArray(path.join(JS_DIR, 'andah-capitals.js'), 'andahCapitals');

    const sourceAirports = buildAirportsNode(stats, coords, capitals);
    const { airports, routes } = generateNetwork(sourceAirports, FLIGHT_CONFIG);
    const summary = networkSummary(airports, routes);

    fs.mkdirSync(DATA_DIR, { recursive: true });
    const generatedAt = new Date().toISOString();
    fs.writeFileSync(
        path.join(DATA_DIR, 'airports.json'),
        JSON.stringify({ generatedAt, config: FLIGHT_CONFIG, airports }, null, 2)
    );
    fs.writeFileSync(
        path.join(DATA_DIR, 'routes.json'),
        JSON.stringify({ generatedAt, routes }, null, 2)
    );

    const pct = n => ((100 * n) / Math.max(1, summary.routeCount)).toFixed(1);
    console.log('--- flight network ---');
    console.log(`Airports: ${summary.airportCount} (${summary.hubCount} hubs)`);
    console.log(`Routes:   ${summary.routeCount}`);
    console.log(`Haul:     short ${pct(summary.hauls.short)}% · medium ${pct(summary.hauls.medium)}% · long ${pct(summary.hauls.long)}%`);
    console.log(`Network length: ${summary.totalKm.toLocaleString()} km`);
    if (summary.busiest) console.log(`Busiest:  ${summary.busiest.city} (${summary.busiest.country}) — ${summary.busiest.degree} routes`);
    if (summary.longest) console.log(`Longest:  ${summary.longest.fromCity} ↔ ${summary.longest.toCity} — ${summary.longest.distanceKm.toLocaleString()} km`);
}

if (
    import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
    import.meta.url === url.pathToFileURL(process.argv[1]).href
) {
    buildRoutes().catch(e => {
        console.error(e);
        process.exit(1);
    });
}
