#!/usr/bin/env node
// Pre-bake the tagged-city flight network (data/flight-cities.json) into
// data/flight-network.json so the browser can skip the ~175k-pair gravity
// computation on every page load. Deterministic: same inputs -> same output.
//
// The gravity model + projection live in views/*.js and are shared verbatim
// with the browser (via buildCityAirportsFrom / generateNetwork), so the baked
// network is byte-for-byte the same one the page would generate live. The
// loader (views/flight-data.js) validates the baked file's signature against
// the current cities and regenerates live if they no longer match.
//
//   npm run build:flight   (also runs as part of `npm run build`)

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { buildCityAirportsFrom, citiesSignature } from '../views/flight-data.js';
import { FLIGHT_CONFIG } from '../views/flight-config.js';
import { generateNetwork, networkSummary } from '../views/flight-routes.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');
const DATA_DIR = path.join(ROOT, 'data');

// The js/andah-*.js files are classic scripts that declare a top-level
// `const <varName> = [...]`. Eval each in an isolated scope and return the
// binding. Trusted, local, version-controlled data.
function loadClassicArray(file, varName) {
    const text = fs.readFileSync(file, 'utf8');
    // eslint-disable-next-line no-new-func
    return new Function(`${text}\n;return ${varName};`)();
}

// Mirror the browser's loadCountries(): prefer the built data/countries.json
// (from the .xlsx pipeline), fall back to js/andah-stats.js. Using the same
// source the page uses keeps the baked GDP-per-capita join identical.
function loadCountriesNode() {
    const file = path.join(DATA_DIR, 'countries.json');
    if (fs.existsSync(file)) {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (doc && Array.isArray(doc.countries) && doc.countries.length) return doc.countries;
    }
    const stats = loadClassicArray(path.join(JS_DIR, 'andah-stats.js'), 'andahStats');
    return stats.map(s => ({
        name: s.name,
        metrics: {
            population: s.population, areaKm: s.areaKm,
            gdpNominal: s.gdpNominal, gdpPpp: s.gdpPpp,
            gdpPerNominal: s.gdpPerNominal, gdpPerPpp: s.gdpPerPpp
        }
    }));
}

export async function bakeFlightNetwork() {
    const cityDoc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'flight-cities.json'), 'utf8'));
    const countries = loadCountriesNode();
    const capitals = loadClassicArray(path.join(JS_DIR, 'andah-capitals.js'), 'andahCapitals');

    const sourceAirports = buildCityAirportsFrom(cityDoc, countries, capitals);
    const { airports, routes } = generateNetwork(sourceAirports, FLIGHT_CONFIG);
    const summary = networkSummary(airports, routes);

    const out = {
        generatedAt: new Date().toISOString(),
        signature: citiesSignature(cityDoc.cities),
        map: cityDoc.map || null,
        airports,
        routes
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const outFile = path.join(DATA_DIR, 'flight-network.json');
    fs.writeFileSync(outFile, JSON.stringify(out));

    const mb = (fs.statSync(outFile).size / 1048576).toFixed(2);
    console.log('--- baked flight network ---');
    console.log(`Cities in:  ${cityDoc.cities.length}`);
    console.log(`Airports:   ${summary.airportCount} (${summary.hubCount} hubs)`);
    console.log(`Routes:     ${summary.routeCount}`);
    console.log(`Wrote:      data/flight-network.json (${mb} MB)`);
}

if (
    import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
    import.meta.url === url.pathToFileURL(process.argv[1]).href
) {
    bakeFlightNetwork().catch(e => {
        console.error(e);
        process.exit(1);
    });
}
